"""Claude Remote bridge — a small JSON+SSE server the G2 glasses app talks to.

It is a purpose-built sibling of ``claude-rc``'s ``webui.py``: a dependency-free
``http.server`` that wraps :class:`claude_rc.client.RemoteControlClient` and
exposes exactly what the glasses UI needs. It differs from the stock webui in
eight deliberate ways, each required by this app:

1. **Active-only.** ``GET /api/sessions`` returns *only* sessions that are
   ``status == "active"`` **and** ``connection_status == "connected"`` — i.e.
   neither archived nor dead (a dead session is one whose ``claude
   remote-control`` worker has disconnected; sends to it would queue forever).
   It asks the API for active sessions outright: an unfiltered page is the
   account's 20 newest sessions, archived ones included, so a long-running
   session used to drop off the list once enough newer ones had come and gone.
   Every mutating / streaming route re-checks this and refuses with **409** if
   the session is no longer active. This is the app's non-negotiable rule and it
   is enforced here, server-side, as the single source of truth.
2. **Auth.** Every request must carry ``Authorization: Bearer $RC_BRIDGE_TOKEN``
   (or ``?token=`` for ``EventSource``, which cannot set headers). The bridge
   binds to ``0.0.0.0`` so the phone can reach it over Tailscale/LAN, so unlike
   the loopback-only webui it needs its own shared-secret guard.
3. **CORS.** The WebView bundle is a different origin, so responses carry
   permissive CORS headers (safe: the bearer token, not a cookie, is the guard).
4. **Richer, camelCase events and sessions.** ``RcEvent`` is a superset of the
   webui's flattened event that additionally carries ``requestId`` /
   ``toolUseId`` / ``permissionRequest`` (needed to answer a prompt), ``usage``,
   ``workerState`` (model / effort / permission mode from ``system/init`` and
   ``system/status`` — the session object has no permission mode), the
   running background ``tasks`` and ``settlesPrompt`` (this event ends the
   prompt its ``requestId`` names: a controller answered it, or the worker
   withdrew it). ``permissionRequest`` covers both blocking
   flavors: tool-permissions (``can_use_tool``) and QUESTIONS (with parsed
   ``questions``/options). NOTE the sharp edge, confirmed against a live
   prompt: the **AskUserQuestion** tool is delivered as a ``can_use_tool``
   permission whose ``input`` holds the ``questions`` — *not* as a
   ``request_user_dialog`` — so it is answered on the PERMISSION path (allow +
   ``updatedInput.answers``). ``ActiveSession`` adds what the session's
   ``external_metadata`` says for free: current effort, context use, the
   one-line post-turn summary, the worker's Claude Code version — and
   ``pinned``, claude.ai/code's pin (``POST …/pin`` sets it).
5. **Prompt answers.** ``POST …/permission`` (allow/deny) and ``POST …/dialog``
   (answer a question; a ``can_use_tool`` question goes back through the
   permission path) wrap claude-rc-api's answer builders.
6. **Worker queries.** ``POST …/aside`` asks a side question (claude.ai's
   "btw" — no interruption, nothing added to the transcript), ``GET …/info``
   fetches plan usage + uncommitted git changes, ``POST …/stop_task`` stops a
   background task, and ``POST …/effort`` applies effort session-scoped via the
   ``apply_flag_settings`` control — falling back, on workers older than
   2.1.30x that refuse it, to the ``/effort`` slash command (which persists the
   worker machine's default; the response's ``via`` says which path ran).
7. **Stream liveness.** The API's keepalives (about every 15 s) pass through
   ``GET …/stream`` as ``ping`` frames. The app redials a stream that stops
   pinging, and a ping the bridge can't deliver is how it learns the app has
   gone — a quiet session's stream otherwise held its thread and its upstream
   connection until the session's next event.
8. **History that holds the conversation.** ``GET …/events`` reads the newest
   events and then keeps reading back until they include some transcript. A
   worker posts a fresh ``system/init`` for every controller that attaches, so
   the newest 200 events of a session that sat idle while it was checked from
   claude.ai are settings and control traffic only (seen live: the first line
   of conversation 224 to 414 events back), and the app opened it empty.
   ``POST …/read`` clears the session's unread mark, as opening it in
   claude.ai does.

Run it — the goal is "one command and the glasses can connect":

    uvx --from "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server" claude-remote-bridge
    claude-remote-bridge                       # if pip/uv-installed
    python3 server/rc_bridge.py                # from a repo checkout (dev shim)

On startup it prints every URL the phone can use (localhost / LAN IP /
Tailscale IP) and the bearer token. With no token configured anywhere it
GENERATES one — a short word passphrase like ``coral-anvil-mango-scoop-visor``
(see ``wordlist``), made to be typed by hand, not a random blob — and persists
it to ``~/.config/claude-remote/bridge-token``, so the pairing flow is: run the
command, then copy one URL + the token into the app panel's Settings card.
``--open`` disables auth (dev only).

Config precedence (highest wins): CLI flags → ``RC_BRIDGE_*`` env vars →
``.env.local`` (in the CWD or the repo checkout; ``VITE_BRIDGE_TOKEN`` doubles
as the token) → the persisted token file → generate-and-persist.
"""

from __future__ import annotations

import argparse
import gzip
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

from . import __version__, stt
from .config import FILE_VALUES, REPO_ROOT, config_value
from .wordlist import WORDS

try:
    from claude_rc.client import APIError, RemoteControlClient
except ModuleNotFoundError:
    # Not installed — fall back to a checkout next to the repo (../claude-rc-api).
    _sibling = REPO_ROOT.parent / "claude-rc-api"
    if (_sibling / "claude_rc").is_dir():
        sys.path.insert(0, str(_sibling))
    try:
        from claude_rc.client import APIError, RemoteControlClient
    except ModuleNotFoundError as exc:  # pragma: no cover - operator error
        sys.stderr.write(
            f"cannot import claude_rc ({exc}).\n"
            "Install the API client one of these ways:\n"
            "  pip install git+https://github.com/ThatCrispyToast/claude-rc-api\n"
            "  # or clone it next to this repo (auto-detected) and install its\n"
            "  # one dependency:  pip install httpx\n"
        )
        raise SystemExit(2)
# 0.5.1 is the floor: the session list's status filter, pins, how a prompt ends
# (`settles_prompt`) and the stream keepalives are all that new.
try:
    from claude_rc import PINNED_TAG
    from claude_rc import __version__ as _rc_api_version
    from claude_rc.client import ControlRejected, ControlTimeout
    from claude_rc.events import RC, Event, _to_int

    _rc_version = tuple(map(int, re.findall(r"\d+", _rc_api_version)[:3]))
    _rc_api_too_old = _rc_version < (0, 5, 1)
except ImportError:  # pragma: no cover - operator error
    _rc_api_too_old = True
if _rc_api_too_old:  # pragma: no cover - operator error
    sys.stderr.write(
        "claude-rc-api is too old for this bridge (it needs 0.5.1+).\n"
        "Re-run with --refresh to update it:\n"
        '  uvx --refresh --from "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server" claude-remote-bridge\n'
    )
    raise SystemExit(2)
from claude_rc.credentials import CredentialsError, load_credentials, load_org_uuid


# --- config ----------------------------------------------------------------
# Set by main() before serve(); module-level so the request handlers see them.
HOST = "0.0.0.0"
PORT = 8790
TOKEN = ""
VERBOSE = False

VALID_MODES = {"default", "plan", "acceptEdits", "bypassPermissions"}
# Effort levels a worker accepts remotely ("auto" maps to None: an explicit null
# effortLevel clears back to the model default).
VALID_EFFORTS = {"low", "medium", "high", "xhigh", "max"}
# A side question is one model call over the session's context; Opus on a long
# session can take a while. The worker's own deadline is 11 minutes.
ASIDE_TIMEOUT_S = 150.0
# The session list is read in pages of this many (the API's most), and no
# further than this many pages: a thousand active sessions is not a real list.
LIST_PAGE = 200
LIST_MAX_PAGES = 5
# A session's history is read newest-first a page at a time, until it holds
# this many events a reader would see (see `_is_transcript`) or this many pages
# have been read. Each page is one upstream call, about a third of a second.
HISTORY_PAGE = 200
HISTORY_MAX_PAGES = 6
HISTORY_MIN_TRANSCRIPT = 40
# A JSON body this long is sent gzipped to a client that takes it: a deep
# history is mostly repeated keys, and the phone may be on a mobile network.
GZIP_MIN_BYTES = 2048

# --- route patterns (first hit wins) ---------------------------------------
_SID = r"(?P<sid>[^/]+)"
_R_SESSION = re.compile(rf"^/api/sessions/{_SID}$")
_R_EVENTS = re.compile(rf"^/api/sessions/{_SID}/events$")
_R_STREAM = re.compile(rf"^/api/sessions/{_SID}/stream$")
_R_INFO = re.compile(rf"^/api/sessions/{_SID}/info$")
_R_SEND = re.compile(rf"^/api/sessions/{_SID}/send$")
_R_ASIDE = re.compile(rf"^/api/sessions/{_SID}/aside$")
_R_STOP_TASK = re.compile(rf"^/api/sessions/{_SID}/stop_task$")
_R_PERMISSION = re.compile(rf"^/api/sessions/{_SID}/permission$")
_R_DIALOG = re.compile(rf"^/api/sessions/{_SID}/dialog$")
_R_INTERRUPT = re.compile(rf"^/api/sessions/{_SID}/interrupt$")
_R_MODEL = re.compile(rf"^/api/sessions/{_SID}/model$")
_R_PERMMODE = re.compile(rf"^/api/sessions/{_SID}/permission_mode$")
_R_EFFORT = re.compile(rf"^/api/sessions/{_SID}/effort$")
_R_ARCHIVE = re.compile(rf"^/api/sessions/{_SID}/archive$")
_R_READ = re.compile(rf"^/api/sessions/{_SID}/read$")
_R_PIN = re.compile(rf"^/api/sessions/{_SID}/pin$")
_R_STT = re.compile(r"^/api/stt/(?P<did>[0-9a-f]{16})/(?P<action>audio|finish|cancel)$")


class SessionInactive(Exception):
    """Raised when a session is archived or dead — never controllable."""


# --- active predicate (SINGLE SOURCE OF TRUTH) -----------------------------
def is_active(s: dict) -> bool:
    """A session is controllable iff it is active AND its worker is connected.

    - ``status == "archived"``            → excluded (archived).
    - ``status == "active"`` but
      ``connection_status != "connected"`` → excluded (dead: worker gone).
    """
    return s.get("status") == "active" and s.get("connection_status") == "connected"


# --- shaping upstream objects into the app's contract ----------------------
def _context(ext: dict) -> Optional[dict]:
    """Context use, once the worker has measured it: a session still in its
    first turn reports 0 used tokens, which is "not yet", not "empty"."""
    usage = ext.get("context_usage") or {}
    used, most = usage.get("used_tokens"), usage.get("max_tokens")
    if not isinstance(used, int) or not isinstance(most, int) or used <= 0 or most <= 0:
        return None
    return {"usedTokens": used, "maxTokens": most, "percent": round(100 * used / most)}


def _rate_limit(ext: dict) -> Optional[dict]:
    info = ext.get("rate_limit_info")
    if not isinstance(info, dict) or info.get("status") not in ("allowed", "allowed_warning", "rejected"):
        return None
    return {"status": info["status"], "resetsAt": _to_int(info.get("resetsAt"))}


def _takes_gzip(value: str) -> bool:
    choices = {}
    for item in value.lower().split(","):
        name, _, params = item.strip().partition(";")
        try:
            quality = float(params.strip().removeprefix("q=")) if params else 1.0
        except ValueError:
            quality = 0.0
        choices[name.strip()] = 0 < quality <= 1
    return choices.get("gzip", choices.get("*", False))


def session_to_json(s: dict) -> dict:
    """Trim a raw upstream session into the ``ActiveSession`` shape (camelCase)."""
    cfg = s.get("config") or {}
    ext = s.get("external_metadata") or {}
    summary = ext.get("post_turn_summary") or {}
    return {
        "id": s.get("id"),
        "title": s.get("title") or "(untitled)",
        "status": s.get("status"),
        "workerStatus": s.get("worker_status"),
        "connectionStatus": s.get("connection_status"),
        "statusBucket": s.get("status_bucket"),
        "model": cfg.get("model") or s.get("model"),
        "permissionMode": cfg.get("permission_mode") or cfg.get("permissionMode"),
        "lastEventAt": s.get("last_event_at"),
        "unread": bool(s.get("unread")),
        "pinned": PINNED_TAG in (s.get("tags") or []),
        "userMessageCount": _to_int(s.get("user_message_count")) or 0,
        "pendingAction": ext.get("pending_action") or None,
        "effort": ext.get("effort_level") or None,
        "context": _context(ext),
        "rateLimit": _rate_limit(ext),
        "summary": summary.get("status_detail") or None,
        "needsAction": summary.get("needs_action") or None,
        "ccVersion": ext.get("container_cc_version") or None,
    }


def _is_transcript(ev: Event) -> bool:
    """Whether a reader would call ``ev`` part of the conversation: something
    said, a tool run, a turn's end. Settings snapshots, control traffic,
    tool-result echoes and thinking-only frames are not."""
    if ev.type == "result":
        return True
    if ev.type == "assistant":
        return bool(ev.text().strip() or ev.tool_uses())
    return ev.type == "user" and bool(re.sub(r"<local-command-caveat>.*?</local-command-caveat>", "", ev.text(), flags=re.S).strip())


def _assistant_model(ev: Event) -> Optional[str]:
    msg = ev.payload.get("message")
    if isinstance(msg, dict) and msg.get("model"):
        return msg.get("model")
    if ev.type == "system":
        return ev.payload.get("model")
    return None


def _dialog_info(req: dict) -> dict:
    """Extract ``dialog_kind`` + normalized questions/options from a QUESTION
    control request (``request_user_dialog`` / ``side_question``).

    The dialog-specific payload is opaque per ``dialog_kind`` and nests under
    different keys depending on the kind, so we probe the common locations and
    normalize whatever we find to the AskUserQuestion shape the UI renders:
    ``questions: [{header, question, multiSelect, options: [{label, description}]}]``.
    A plain confirm dialog with no structured questions surfaces its ``prompt``.
    """
    dialog_kind = req.get("dialog_kind") or req.get("dialogKind")
    # The payload can live directly on the request or nested under one of these.
    payload: Optional[dict] = req
    for key in ("dialog_payload", "payload", "input", "tool_input", "data"):
        v = req.get(key)
        if isinstance(v, dict):
            payload = v
            break

    raw_questions = None
    for src in (payload, req):
        if isinstance(src, dict) and isinstance(src.get("questions"), list):
            raw_questions = src["questions"]
            break

    questions = []
    for q in raw_questions or []:
        if not isinstance(q, dict):
            continue
        options = []
        for o in q.get("options") or []:
            if isinstance(o, dict):
                options.append(
                    {"label": o.get("label") or o.get("value") or "", "description": o.get("description") or ""}
                )
            elif isinstance(o, str):
                options.append({"label": o, "description": ""})
        questions.append(
            {
                "header": q.get("header") or "",
                "question": q.get("question") or q.get("text") or q.get("prompt") or "",
                "multiSelect": bool(q.get("multiSelect") or q.get("multi_select")),
                "options": options,
            }
        )

    prompt = ""
    if not questions:
        for key in ("message", "prompt", "text", "title", "question"):
            v = (payload or {}).get(key) if isinstance(payload, dict) else None
            if isinstance(v, str) and v.strip():
                prompt = v
                break

    return {"dialogKind": dialog_kind, "questions": questions, "prompt": prompt}


def _session_rule(updates: Any, tool_name: str) -> Optional[str]:
    """Offer a single worker-supplied, session-only rule whose scope fits on glass."""
    if not isinstance(updates, list) or len(updates) != 1 or not isinstance(updates[0], dict):
        return None
    update = updates[0]
    if (update.get("type"), update.get("destination"), update.get("behavior")) != ("addRules", "session", "allow"):
        return None
    rules = update.get("rules")
    if not isinstance(rules, list) or len(rules) != 1 or not isinstance(rules[0], dict):
        return None
    rule = rules[0]
    content = rule.get("ruleContent")
    if not tool_name or rule.get("toolName") != tool_name or not isinstance(content, str) or not content.strip():
        return None
    return f"{tool_name}({content})"


def _permission_request(ev: Event) -> Optional[dict]:
    """The details out of a blocking control request — either a tool-permission
    (``can_use_tool``) or a question (``request_user_dialog`` / ``side_question``).

    The inbound control request nests everything under ``payload.request``. We keep
    the whole ``request`` blob (so the UI can show whatever's there) plus pull the
    common fields to well-known names, and — for questions — the parsed
    ``dialogKind`` / ``questions`` / ``prompt``. Field locations were confirmed
    against a live prompt; we stay tolerant of alternates.
    """
    if not ev.is_blocking_control:
        return None
    req = ev.payload.get("request") or {}
    tool_use_id = (
        req.get("tool_use_id")
        or req.get("toolUseId")
        or (req.get("tool") or {}).get("id")
    )
    dialog = _dialog_info(req)
    return {
        "subtype": req.get("subtype"),
        "toolName": req.get("tool_name") or req.get("name") or (req.get("tool") or {}).get("name"),
        "toolUseId": tool_use_id,
        "input": req.get("input") or req.get("tool_input") or (req.get("tool") or {}).get("input"),
        "sessionRule": _session_rule(req.get("permission_suggestions"), req.get("tool_name")) if _rc_version >= (0, 7, 1) else None,
        "suggestions": req.get("permission_suggestions") or req.get("suggestions"),
        "dialogKind": dialog["dialogKind"],
        "questions": dialog["questions"],
        "prompt": dialog["prompt"],
        "raw": req,
    }


def _usage(ev: Event) -> Optional[dict]:
    if ev.type != "result":
        return None
    return {
        "costUsd": ev.payload.get("total_cost_usd"),
        "numTurns": ev.payload.get("num_turns"),
        "durationMs": ev.payload.get("duration_ms"),
        "isError": bool(ev.payload.get("is_error")),
    }


def _worker_state(ev: Event) -> Optional[dict]:
    state = ev.worker_state
    if not state:
        return None
    return {
        "model": state.get("model"),
        "effort": state.get("effort"),
        "permissionMode": state.get("permission_mode"),
        "ccVersion": state.get("claude_code_version"),
    }


def _tasks(ev: Event) -> Optional[list]:
    """The running background set a ``system/background_tasks_changed`` carries."""
    if ev.type != "system" or ev.subtype != "background_tasks_changed":
        return None
    return [
        {"id": t.get("task_id"), "type": t.get("task_type"), "description": t.get("description") or ""}
        for t in ev.payload.get("tasks") or []
        if isinstance(t, dict) and t.get("task_id")
    ]


def event_to_json(ev: Event) -> dict:
    """Flatten an :class:`Event` into ``RcEvent`` (camelCase, superset of webui)."""
    # requestId ties a control_response (or a control_cancel_request) to the
    # request it answers (or withdraws); settlesPrompt says that request was a
    # worker's prompt and is now over — the app retires it on that.
    perm = _permission_request(ev)
    return {
        "type": ev.type,
        "subtype": ev.subtype,
        "role": ev.role,
        "source": ev.source,
        "text": ev.text(),
        "toolUses": [
            {"name": t.get("name"), "input": t.get("input"), "id": t.get("id")}
            for t in ev.tool_uses()
        ],
        "sequenceNum": ev.sequence_num,
        "id": ev.id,
        "timestamp": ev.processed_at,
        "model": _assistant_model(ev),
        "isTurnEnd": ev.is_turn_end,
        "isTerminal": ev.is_terminal,
        "isBlockingControl": ev.is_blocking_control,
        "blockingSubtype": ev.control_subtype if ev.is_blocking_control else None,
        "requestId": ev.request_id,
        "settlesPrompt": ev.settles_prompt,
        "toolUseId": perm.get("toolUseId") if perm else None,
        "permissionRequest": perm,
        "usage": _usage(ev),
        "workerState": _worker_state(ev),
        "tasks": _tasks(ev),
        "parentToolUseId": ev.payload.get("parent_tool_use_id"),
        "systemStatus": ev.payload.get("status") if ev.type == "system" else None,
        "taskSummary": (ev.payload.get("summary") or ev.payload.get("status")) if ev.subtype == "task_notification" else None,
    }


def _answers_map(answers: Any) -> dict[str, str]:
    """Fold the app's ``[{header, question, options: [chosen labels]}]`` into the
    AskUserQuestion answer map: ``{<question text>: <label, label…>}``.

    The tool keys answers by the *question* string, so that's the key, and
    every answer is a string: a multi-select's labels are comma-separated (the
    tool's own schema: "question text -> answer string; multi-select answers
    are comma-separated"). Unanswered questions are simply omitted (→ the tool
    reports them as "(no option selected)").
    """
    out: dict[str, str] = {}
    for a in answers or []:
        if not isinstance(a, dict):
            continue
        q = a.get("question") or a.get("header")
        picks = [str(p) for p in (a.get("options") or []) if p]
        if not q or not picks:
            continue
        out[q] = ", ".join(picks)
    return out


def _question_input(original_input: Any, answers: Any) -> dict:
    """The AskUserQuestion input to echo back. It MUST keep ``questions`` (the
    tool crashes without them), so rebuild a minimal list if the app's copy of
    the input somehow lost it."""
    base = dict(original_input) if isinstance(original_input, dict) else {}
    if not isinstance(base.get("questions"), list):
        base["questions"] = [
            {"question": a.get("question") or a.get("header") or "", "header": a.get("header") or "",
             "options": [], "multiSelect": False}
            for a in (answers or [])
            if isinstance(a, dict)
        ]
    return base


class _Bridge(ThreadingHTTPServer):
    daemon_threads = True  # long-lived SSE streams die with the process

    def __init__(self, addr, handler, client: RemoteControlClient):
        super().__init__(addr, handler)
        self.rc = client


class _Handler(BaseHTTPRequestHandler):
    server_version = "claude-remote-bridge"
    protocol_version = "HTTP/1.1"

    @property
    def rc(self) -> RemoteControlClient:
        return self.server.rc  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        if VERBOSE:
            super().log_message(fmt, *args)

    # -- request helpers ---------------------------------------------------
    def _query(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def _qint(self, q: dict, key: str, default: int) -> int:
        try:
            return int(q.get(key, [default])[0])
        except (ValueError, TypeError):
            return default

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw or b"{}")
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}

    def _authed(self) -> bool:
        if not TOKEN:
            return True  # dev mode: no token configured
        # Constant-time comparisons, so response timing can't leak how much of a
        # guessed token matched.
        expected = TOKEN.encode()
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].encode(), expected):
            return True
        return hmac.compare_digest(self._query().get("token", [""])[0].encode(), expected)

    # -- response helpers --------------------------------------------------
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, obj: Any, status: int = 200) -> None:
        body = json.dumps(obj).encode()
        packed = len(body) >= GZIP_MIN_BYTES and _takes_gzip(self.headers.get("Accept-Encoding", ""))
        if packed:
            body = gzip.compress(body, compresslevel=5)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Vary", "Accept-Encoding")
        if packed:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _unauth(self) -> None:
        self._json({"error": "unauthorized", "status": 401}, status=401)

    def _error(self, exc: Exception) -> None:
        if isinstance(exc, SessionInactive):
            self._json({"error": "session not active", "status": 409}, status=409)
        elif isinstance(exc, APIError):
            status = exc.status if 400 <= exc.status < 600 else 502
            self._json({"error": exc.body[:1000], "status": status}, status=status)
        elif isinstance(exc, CredentialsError):
            self._json({"error": str(exc), "status": 401}, status=401)
        elif isinstance(exc, ControlRejected):
            self._json({"error": str(exc), "status": 502}, status=502)  # the worker refused it
        elif isinstance(exc, ControlTimeout):
            self._json({"error": str(exc), "status": 504}, status=504)  # the worker never answered
        else:
            self._json({"error": repr(exc), "status": 500}, status=500)

    # -- the active gate ---------------------------------------------------
    def _require_active(self, sid: str) -> dict:
        """Fetch the session and refuse (409) if it is not active+connected."""
        s = self.rc.get_session(sid)
        if not is_active(s):
            raise SessionInactive(sid)
        return s

    # -- local dictation ---------------------------------------------------
    def _stt(self, path: str) -> None:
        """`/api/stt/start` takes JSON; `…/audio`, `…/finish` and `…/cancel`
        take raw PCM (s16le, 16 kHz, mono)."""
        # Close on any early rejection: unread bytes cannot start the next
        # request on this HTTP/1.1 connection.
        def reject(status: int, message: str) -> None:
            self.close_connection = True
            self._json({"error": message, "status": status}, status=status)

        if not self._authed():
            return reject(401, "unauthorized")
        if not stt.available():
            return reject(501, stt.NOT_INSTALLED)
        match = _R_STT.fullmatch(path)
        if path != "/api/stt/start" and not match:
            return reject(404, "not found")

        lengths = self.headers.get_all("Content-Length", ["0"])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,12}", lengths[0]):
            return reject(400, "invalid Content-Length")
        length = int(lengths[0])
        if length > stt.MAX_POST_BYTES:
            return reject(413, "audio post too large")
        action = match["action"] if match else "start"
        if action in ("audio", "finish"):
            values = self._query().get("seq", [])
            if len(values) != 1 or not re.fullmatch(r"[0-9]{1,12}", values[0]):
                return reject(400, "a numbered audio request is required")
            if length % 2:
                return reject(400, "audio must contain whole s16le samples")

        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                return reject(400, "incomplete request body")
            if action == "start":
                try:
                    data = json.loads(raw or b"{}")
                except (ValueError, UnicodeError):
                    return reject(400, "invalid dictation settings")
                language = data.get("language") if isinstance(data, dict) else None
                did = stt.start(language if isinstance(language, str) else None)
                return self._json({"id": did, "model": stt.model_state(), "protocol": 1})
            if action == "cancel":
                stt.cancel(match["did"])
                return self._json({"ok": True})
            return self._json(stt.process(match["did"], action, int(values[0]), raw))
        except stt.UnknownDictation:
            self._json({"error": "dictation not found (the bridge may have restarted)", "status": 404}, status=404)
        except stt.DictationConflict as exc:
            self._json({"error": str(exc), "status": 409}, status=409)
        except stt.DictationsBusy as exc:
            self._json({"error": str(exc), "status": 429}, status=429)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            self._error(exc)

    # -- OPTIONS (CORS preflight) ------------------------------------------
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- GET ---------------------------------------------------------------
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if not self._authed():
            return self._unauth()
        try:
            if path == "/api/whoami":
                return self._json(self._whoami())
            if path in ("/api/sessions", "/api/sessions/"):
                return self._json({"sessions": [session_to_json(s) for s in self._active_sessions()]})
            m = _R_STREAM.match(path)
            if m:
                return self._stream(m["sid"])
            m = _R_EVENTS.match(path)
            if m:
                self._require_active(m["sid"])
                query = self._query()
                before = query.get("before", [None])[0]
                if before is not None and not before.isdecimal():
                    return self._json({"error": "invalid history cursor"}, status=400)
                evs, older = self._history(m["sid"], self._qint(query, "limit", HISTORY_PAGE), before)
                return self._json({"events": [event_to_json(e) for e in evs], "before": older})
            m = _R_INFO.match(path)
            if m:
                self._require_active(m["sid"])
                return self._json(self._info(m["sid"], self._query().get("section", ["all"])[0]))
            m = _R_SESSION.match(path)
            if m:
                return self._json({"session": session_to_json(self._require_active(m["sid"]))})
            self._json({"error": "not found", "status": 404}, status=404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            self._error(exc)

    # -- POST --------------------------------------------------------------
    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path.startswith("/api/stt/"):
            return self._stt(path)
        body = self._body()  # always drain the body (keep-alive correctness)
        if not self._authed():
            return self._unauth()
        try:
            m = _R_SEND.match(path)
            if m:
                self._require_active(m["sid"])
                text = (body.get("text") or "").strip()
                if not text:
                    return self._json({"error": "empty message", "status": 400}, status=400)
                if re.match(r"^/[A-Za-z0-9_:-]+(?:\s|$)", text):
                    return self._json({"error": "Run slash commands in Claude. Session info shows context and usage.", "status": 422}, status=422)
                self.rc.send_message(m["sid"], text)
                return self._json({"ok": True})
            m = _R_ASIDE.match(path)
            if m:
                self._require_active(m["sid"])
                question = (body.get("question") or "").strip()
                if not question:
                    return self._json({"error": "empty question", "status": 400}, status=400)
                history = [
                    {"question": str(h.get("question") or ""), "response": str(h.get("response") or "")}
                    for h in body.get("history") or []
                    if isinstance(h, dict) and h.get("question") and h.get("response")
                ]
                answer = self.rc.side_question(m["sid"], question, history=history, timeout=ASIDE_TIMEOUT_S)
                return self._json({"answer": answer})
            m = _R_STOP_TASK.match(path)
            if m:
                self._require_active(m["sid"])
                task_id = (body.get("task_id") or "").strip()
                if not task_id:
                    return self._json({"error": "missing task_id", "status": 400}, status=400)
                self.rc.stop_task(m["sid"], task_id)
                return self._json({"ok": True})
            m = _R_PERMISSION.match(path)
            if m:
                self._require_active(m["sid"])
                request_id = body.get("request_id")
                decision = body.get("decision")
                if not request_id:
                    return self._json({"error": "missing request_id", "status": 400}, status=400)
                if decision not in ("allow", "deny"):
                    return self._json({"error": "decision must be allow|deny", "status": 400}, status=400)
                extra = {}
                if body.get("session_rule"):
                    if _rc_version < (0, 7, 1):
                        return self._json({"error": "Refresh claude-rc-api for session rules"}, status=422)
                    # Resolve the worker's own offer again. The phone names the rule
                    # it displayed and cannot supply an arbitrary settings update.
                    info = self.rc.initialize(m["sid"])
                    pending = info.get("pending_permission_requests") or []
                    original = next((entry for entry in pending
                                     if isinstance(entry, dict) and entry.get("request_id") == request_id), {})
                    req = original.get("request") or original
                    updates = req.get("permission_suggestions")
                    if decision != "allow" or _session_rule(updates, req.get("tool_name")) != body["session_rule"]:
                        return self._json({"error": "Session rule is no longer offered", "status": 422}, status=422)
                    self._require_active(m["sid"])
                    extra["updated_permissions"] = updates
                self.rc.respond_permission(
                    m["sid"],
                    request_id,
                    allow=decision == "allow",
                    tool_input=body.get("updated_input"),
                    tool_use_id=body.get("tool_use_id"),
                    message=body.get("message"),
                    **extra,
                )
                return self._json({"ok": True})
            m = _R_DIALOG.match(path)
            if m:
                self._require_active(m["sid"])
                request_id = body.get("request_id")
                status = body.get("status")
                if not request_id:
                    return self._json({"error": "missing request_id", "status": 400}, status=400)
                if status not in ("completed", "cancelled"):
                    return self._json({"error": "status must be completed|cancelled", "status": 400}, status=400)
                # AskUserQuestion is delivered as a `can_use_tool` permission, so it
                # is answered on the PERMISSION path (allow + updatedInput.answers;
                # an empty map is the graceful dismiss). Other dialogs need their own schema.
                answers = body.get("answers")
                if body.get("subtype") == "can_use_tool":
                    self.rc.answer_question(
                        m["sid"],
                        request_id,
                        _answers_map(answers) if status == "completed" else {},
                        tool_input=_question_input(body.get("input"), answers),
                        tool_use_id=body.get("tool_use_id"),
                    )
                else:
                    return self._json({"error": "Answer this dialog in Claude.", "status": 422}, status=422)
                return self._json({"ok": True})
            m = _R_INTERRUPT.match(path)
            if m:
                self._require_active(m["sid"])
                self.rc.interrupt(m["sid"])
                return self._json({"ok": True})
            m = _R_MODEL.match(path)
            if m:
                self._require_active(m["sid"])
                model = (body.get("model") or "").strip()
                if not model:
                    return self._json({"error": "missing model", "status": 400}, status=400)
                self.rc.set_model(m["sid"], model)
                return self._json({"ok": True})
            m = _R_PERMMODE.match(path)
            if m:
                self._require_active(m["sid"])
                mode = (body.get("mode") or "").strip()
                if mode not in VALID_MODES:
                    return self._json(
                        {"error": f"mode must be one of {sorted(VALID_MODES)}", "status": 400},
                        status=400,
                    )
                self.rc.set_permission_mode(m["sid"], mode)
                return self._json({"ok": True})
            m = _R_EFFORT.match(path)
            if m:
                self._require_active(m["sid"])
                effort = (body.get("effort") or "").strip() or None
                if effort == "auto":
                    effort = None
                if effort is not None and effort not in VALID_EFFORTS:
                    return self._json(
                        {"error": f"effort must be auto or one of {sorted(VALID_EFFORTS)}", "status": 400},
                        status=400,
                    )
                # 2.1.30x workers apply the apply_flag_settings control
                # session-scoped; older ones refuse it, so set_effort waits for
                # the verdict and falls back to the /effort slash command there.
                out = self.rc.set_effort(m["sid"], effort, wait=6.0, command_fallback=True)
                return self._json({"ok": True, "via": out.get("via", "control")})
            m = _R_ARCHIVE.match(path)
            if m:
                # Archiving is the one control that *ends* an active session, so it
                # only requires that the session currently be active.
                self._require_active(m["sid"])
                self.rc.archive_session(m["sid"])
                return self._json({"ok": True})
            m = _R_READ.match(path)
            if m:
                self._require_active(m["sid"])
                self.rc.mark_read(m["sid"])
                return self._json({"ok": True})
            m = _R_PIN.match(path)
            if m:
                self._require_active(m["sid"])
                pin = self.rc.unpin_session if body.get("pinned") is False else self.rc.pin_session
                return self._json({"ok": True, "pinned": session_to_json(pin(m["sid"]))["pinned"]})
            self._json({"error": "not found", "status": 404}, status=404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            self._error(exc)

    # -- handlers ----------------------------------------------------------
    def _active_sessions(self) -> list[dict]:
        """Every active, connected session, newest first. The status filter is
        what makes it every one: an unfiltered page is the account's 20 newest
        sessions, archived ones included."""
        out: list[dict] = []
        cursor = None
        for _ in range(LIST_MAX_PAGES):
            page = self.rc.list_sessions(statuses="active", limit=LIST_PAGE, cursor=cursor)
            out += [s for s in page.get("data") or [] if is_active(s)]
            cursor = page.get("next_cursor")
            if not cursor:
                break
        return out

    def _history(self, sid: str, limit: int, before: Optional[str] = None) -> tuple[list[Event], Optional[int]]:
        """The session's newest events, oldest first: ``limit`` of them, and
        then as many more as it takes to hold some conversation.

        NEWEST, so desc: an asc read is the session's OLDEST slice, which would
        leave the app's resume cursor so far behind that the stream replayed
        the whole backlog, every long-answered prompt included. And further
        back than ``limit`` because the newest events are often not
        conversation at all (see point 8 at the top). The read stops at a
        ``conversation_reset``: nothing before a /clear is shown anyway.
        """
        size = max(1, min(limit, HISTORY_PAGE))  # the first read; the rest are whole pages
        out: list[Event] = []
        shown = 0
        cursor = before
        older = None
        for _ in range(HISTORY_MAX_PAGES):
            page = self.rc.list_events(sid, limit=size, sort_order="desc", cursor=cursor)
            if cursor is not None:
                page = [e for e in page if e.sequence_num is not None and e.sequence_num < int(cursor)]
            reset = next((i for i, ev in enumerate(page) if ev.type == RC.CONVERSATION_RESET and not ev.payload.get("parent_tool_use_id")), None)
            if reset is not None:
                out.extend(page[:reset + 1])
                older = None
                break
            out.extend(page)
            seqs = [e.sequence_num for e in page if e.sequence_num is not None]
            older = min(seqs) if len(page) == size and seqs else None
            shown += sum(map(_is_transcript, page))
            if older is None or (len(out) >= limit and shown >= HISTORY_MIN_TRANSCRIPT):
                break
            cursor = str(older)
            size = HISTORY_PAGE
        out.reverse()
        return out, older

    def _whoami(self) -> dict:
        try:
            creds = load_credentials()
        except CredentialsError as exc:
            return {"logged_in": False, "error": str(exc), "local_stt": stt.available()}
        org = load_org_uuid()
        return {
            "logged_in": True,
            "local_stt": stt.available(),
            "expired": creds.is_expired(),
            "scopes": creds.scopes,
            "subscription": creds.subscription_type,
            "org_uuid_present": bool(org),
            "token_len": len(creds.access_token),
        }

    def _info(self, sid: str, section: str = "all") -> dict:
        """Plan usage + uncommitted git changes, asked of the worker (each a
        control round trip that leaves a request/response pair in the event
        log). Best-effort per part: a refusal or timeout nulls that part
        (``diffPending``: the worker was still computing the diff — ask again)."""
        out: dict[str, Any] = {"usage": None, "diff": None, "diffPending": False}
        if section == "context":
            usage = self.rc.get_context_usage(sid, timeout=10.0)
            out["context"] = {
                "usedTokens": usage.get("totalTokens"), "maxTokens": usage.get("maxTokens"),
                "percent": usage.get("percentage"),
                "categories": [{"name": c["name"], "tokens": c["tokens"]} for c in usage.get("categories") or []
                               if isinstance(c, dict) and isinstance(c.get("name"), str) and isinstance(c.get("tokens"), int)],
            }
            return out
        try:
            usage = self.rc.get_usage(sid, timeout=10.0)
            limits = (usage.get("rate_limits") or {}).get("limits") or []
            session = usage.get("session") or {}
            out["usage"] = {
                "limits": [
                    {
                        "kind": lim.get("kind"),
                        "percent": lim.get("percent"),
                        "resetsAt": lim.get("resets_at"),
                        # weekly_scoped is one model's own cap: name it
                        "model": ((lim.get("scope") or {}).get("model") or {}).get("display_name"),
                    }
                    for lim in limits
                    if isinstance(lim, dict)
                ],
                "costUsd": session.get("total_cost_usd"),
            }
        except (ControlRejected, ControlTimeout):
            pass
        if section == "usage":
            return out
        try:
            diff = self.rc.get_workspace_diff(sid, timeout=12.0)
            if diff is not None:
                stats = diff.get("stats") or {}
                out["diff"] = {
                    "files": stats.get("filesCount", 0),
                    "added": stats.get("linesAdded", 0),
                    "removed": stats.get("linesRemoved", 0),
                }
        except ControlRejected as exc:
            out["diffPending"] = exc.error_code == "workspace_diff_pending"
        except ControlTimeout:
            pass
        return out

    def _stream(self, sid: str) -> None:
        # Gate at open: refuse a stream on a non-active session with an error frame.
        try:
            s = self.rc.get_session(sid)
        except Exception as exc:  # noqa: BLE001
            return self._error(exc)
        if not is_active(s):
            self.close_connection = True
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self._cors()
            self.end_headers()
            self.wfile.write(b"retry: 3000\n: connected\n\n")
            self._sse_error("session not active", 409)
            return

        from_seq = self._qint(self._query(), "from_seq", 0)
        last_event_id = self.headers.get("Last-Event-ID")
        if last_event_id and last_event_id.isdigit():
            from_seq = max(from_seq, int(last_event_id))

        # An event-stream body is delimited only by connection close, so the
        # socket must close when the stream ends. Do NOT send `Connection:
        # keep-alive` — BaseHTTPRequestHandler.send_header special-cases it and
        # resets close_connection back to False, leaving the socket to stall.
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self._cors()
        self.end_headers()
        self.wfile.write(b"retry: 3000\n: connected\n\n")
        self.wfile.flush()

        events = self.rc.stream_events(sid, from_sequence_num=from_seq, keepalives=True)
        try:
            for ev in events:
                if ev.type == RC.KEEPALIVE:
                    # The API's heartbeat, passed on as a frame the app can hear
                    # (EventSource hides comments, and drops a frame with no
                    # data). Failing to write it is how a quiet session's
                    # stream learns the app has gone.
                    out = "event: ping\ndata: 1\n\n"
                else:
                    out = f"data: {json.dumps(event_to_json(ev))}\n\n"
                    if ev.sequence_num is not None:
                        out = f"id: {ev.sequence_num}\n{out}"
                self.wfile.write(out.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        except APIError as exc:
            self._sse_error(exc.body[:500], exc.status)
        except Exception as exc:  # noqa: BLE001
            self._sse_error(repr(exc), 500)
        finally:
            events.close()  # hang up on the API now, not when the generator is collected

    def _sse_error(self, message: str, status: int) -> None:
        try:
            payload = json.dumps({"error": message, "status": status})
            self.wfile.write(f"event: error\ndata: {payload}\n\n".encode())
            self.wfile.flush()
        except OSError:
            pass


# --- startup: token + reachable URLs ----------------------------------------
def _token_store() -> Path:
    """Where a generated token persists across runs (written 0600)."""
    base = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config"))
    return base / "claude-remote" / "bridge-token"


# A generated token is a passphrase — this many words from wordlist.WORDS,
# hyphen-joined — not a random base64 blob, because the end user reads it off
# the startup banner and types it into the panel's Settings card by hand. Five
# words over the 1295-word EFF short list is ~52 bits: comfortably past
# brute-forcing a LAN/tailnet bridge (which does no rate-limiting) yet short
# and unambiguous to type. Override the count with RC_BRIDGE_TOKEN_WORDS;
# it is floored at 3 (~31 bits) so the knob can't foot-gun the token to nothing.
_DEFAULT_TOKEN_WORDS = 5
_MIN_TOKEN_WORDS = 3


def _token_word_count() -> int:
    try:
        n = int(config_value("RC_BRIDGE_TOKEN_WORDS", str(_DEFAULT_TOKEN_WORDS)))
    except ValueError:
        n = _DEFAULT_TOKEN_WORDS
    return max(_MIN_TOKEN_WORDS, n)


def _generate_passphrase(words: int) -> str:
    """A human-typeable bearer token: `words` words drawn uniformly from the EFF
    short list with `secrets.choice`, joined by hyphens (e.g. `coral-anvil-mango`).
    Hyphens are URL-safe, so it rides unencoded on both the `Bearer` header and
    the SSE `?token=` query."""
    return "-".join(secrets.choice(WORDS) for _ in range(words))


def _resolve_token(cli_token: Optional[str], open_mode: bool) -> tuple[str, str]:
    """The bearer token plus a human note about where it came from.

    Precedence: --token → $RC_BRIDGE_TOKEN → .env.local (RC_BRIDGE_TOKEN /
    VITE_BRIDGE_TOKEN) → the persisted store → freshly generated + persisted.
    Generating by default (rather than running open) is deliberate: the bridge
    binds beyond loopback and can steer every session of the logged-in account.
    """
    if open_mode:
        return "", "auth DISABLED (--open)"
    if cli_token:
        return cli_token, "from --token"
    if os.environ.get("RC_BRIDGE_TOKEN"):
        return os.environ["RC_BRIDGE_TOKEN"], "from $RC_BRIDGE_TOKEN"
    file_token = FILE_VALUES.get("RC_BRIDGE_TOKEN") or FILE_VALUES.get("VITE_BRIDGE_TOKEN")
    if file_token:
        return file_token, "from .env.local"
    store = _token_store()
    try:
        saved = store.read_text().strip()
        if saved:
            return saved, f"saved in {store}"
    except OSError:
        pass
    words = _token_word_count()
    token = _generate_passphrase(words)
    strength = f"GENERATED {words}-word passphrase, ~{round(words * math.log2(len(WORDS)))}-bit"
    try:
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_text(token + "\n")
        os.chmod(store, 0o600)
        return token, f"{strength} — saved to {store}"
    except OSError:
        return token, f"{strength} — could not persist, so it will CHANGE next run"


def _source_ip(probe: str) -> Optional[str]:
    """The local address the kernel would route to `probe` from (UDP connect
    picks the source interface without sending any packet)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((probe, 53))
            return s.getsockname()[0]
    except OSError:
        return None


# Tailscale hands out addresses from the CGNAT range.
_TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")


def _reachable_urls(port: int) -> list[tuple[str, str]]:
    """(label, url) pairs the phone can try: localhost, the LAN IP, and — when
    Tailscale is up — the Tailscale IP (probing Tailscale's own resolver
    address selects the tailnet interface)."""
    urls: list[tuple[str, str]] = [("local", f"http://127.0.0.1:{port}")]
    seen = {"127.0.0.1"}
    for label, probe in (("LAN", "8.8.8.8"), ("tailscale", "100.100.100.100")):
        ip = _source_ip(probe)
        if not ip or ip in seen:
            continue
        seen.add(ip)
        if ipaddress.ip_address(ip) in _TAILSCALE_NET:
            label = "tailscale"
        urls.append((label, f"http://{ip}:{port}"))
    return urls


def _login_line() -> str:
    try:
        creds = load_credentials()
    except CredentialsError as exc:
        return f"⚠ NOT logged in to Claude Code — {exc}"
    return f"Claude Code login: ok ({creds.subscription_type or 'unknown plan'})"


def serve(token_note: str) -> None:
    try:
        rc = RemoteControlClient()
    except CredentialsError as exc:
        sys.stderr.write(
            f"Not logged in to Claude Code: {exc}\n"
            "On this machine run `claude` and `/login` with a claude.ai account\n"
            "(not an API key), then start the bridge again.\n"
        )
        raise SystemExit(1)
    httpd = _Bridge((HOST, PORT), _Handler, rc)

    print(f"Claude Remote bridge v{__version__}  —  listening on {HOST}:{PORT}   (Ctrl-C to stop)")
    print(f"  {_login_line()}")
    print()
    print("  In the Claude Remote app, open the panel's Settings card and enter:")
    rows = _reachable_urls(PORT) if HOST in ("0.0.0.0", "::", "") else [("bound", f"http://{HOST}:{PORT}")]
    for label, url in rows:
        print(f"    Bridge URL ({label + ')':<11} {url}")
    if TOKEN:
        print(f"    Bridge token:           {TOKEN}")
        print(f"                            ({token_note})")
    else:
        print(
            "  ⚠ UNAUTHENTICATED (--open): anyone who can reach this port can read\n"
            "    and steer your Claude sessions. Dev only."
        )
    print()
    print(f"  You might need to open port {PORT} in this host's firewall.")
    if stt.available():
        print(f"  Local dictation: {stt.MODEL} via {stt.BACKEND} (choose Bridge under Dictation in the app)")
    print()
    # The pairing banner must reach the terminal even when stdout is a pipe or
    # a log file (uvx | tee, systemd) — block buffering would sit on it forever.
    sys.stdout.flush()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down…")
    finally:
        httpd.shutdown()
        httpd.server_close()
        rc.close()


def main(argv: Optional[list[str]] = None) -> None:
    global HOST, PORT, TOKEN, VERBOSE
    ap = argparse.ArgumentParser(
        prog="claude-remote-bridge",
        description=(
            "Bridge between the Claude Remote glasses app and this machine's "
            "Claude Code Remote Control sessions. Run it where you are logged "
            "in to Claude Code; it prints the URL + token to pair the app."
        ),
    )
    ap.add_argument("--host", default=None, help="bind address (default 0.0.0.0)")
    ap.add_argument("--port", type=int, default=None, help="port (default 8790)")
    ap.add_argument("--token", default=None, help="bearer token the app must present (default: env / .env.local / persisted / a generated word passphrase)")
    ap.add_argument("--open", action="store_true", help="run WITHOUT authentication (dev only)")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args = ap.parse_args(argv)

    HOST = args.host or config_value("RC_BRIDGE_HOST", "0.0.0.0")
    try:
        PORT = args.port or int(config_value("RC_BRIDGE_PORT", "8790"))
    except ValueError:
        PORT = 8790
    TOKEN, token_note = _resolve_token(args.token, args.open)
    VERBOSE = args.verbose or config_value("RC_BRIDGE_VERBOSE") not in ("", "0", "false", "no")
    serve(token_note)


if __name__ == "__main__":
    main()
