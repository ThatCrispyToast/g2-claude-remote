#!/usr/bin/env python3
"""A mock Claude Remote bridge that serves three fictional sessions.

For driving the app (dev server, simulator, browser) with no Claude login and
nothing real to steer, and for staging the store screenshots in assets/store/
(the repo is public, so never shoot real sessions). It implements the read side
of the bridge API with the shapes in src/rc/types.ts; every POST is accepted and
ignored, and any token is accepted.

    python3 scripts/mock-bridge.py [--port 8791] [--question]
    VITE_BRIDGE_URL=http://localhost:8791 VITE_BRIDGE_TOKEN=x npm run dev

Sessions: api-refactor (running), docs-site (idle), and payment-service, blocked
on a Bash permission, or on an AskUserQuestion with --question.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, ClassVar
from urllib.parse import urlparse


def _ago(minutes: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - minutes * 60))


def _session(sid: str, title: str, worker: str, model: str, minutes_ago: int) -> dict[str, Any]:
    return {
        "id": sid,
        "title": title,
        "status": "active",
        "workerStatus": worker,
        "connectionStatus": "connected",
        "statusBucket": None,
        "model": model,
        "permissionMode": "default",
        "lastEventAt": _ago(minutes_ago),
        "unread": False,
        "userMessageCount": 2,
        "pendingAction": None,
    }


def _event(seq: int, kind: str, **f: Any) -> dict[str, Any]:
    control = f.get("control")
    return {
        "type": kind,
        "subtype": f.get("subtype"),
        "role": kind if kind in ("user", "assistant") else None,
        "text": f.get("text", ""),
        "toolUses": [
            {"name": name, "input": inp, "id": f"toolu_{seq}_{i}"} for i, (name, inp) in enumerate(f.get("tools", []))
        ],
        "sequenceNum": seq,
        "id": f"ev-{seq}",
        "timestamp": None,
        "model": f.get("model"),
        "isTurnEnd": kind == "result",
        "isTerminal": False,
        "isBlockingControl": control is not None,
        "blockingSubtype": "can_use_tool" if control else None,
        "requestId": f"req-{seq}" if control else None,
        "toolUseId": f"toolu_{seq}" if control else None,
        "permissionRequest": control,
        "usage": f.get("usage"),
    }


def _permission(tool: str, inp: dict[str, Any], questions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "subtype": "can_use_tool",
        "toolName": tool,
        "toolUseId": None,
        "input": inp,
        "suggestions": None,
        "dialogKind": None,
        "questions": questions or [],
        "prompt": None,
        "raw": {},
    }


def _usage(turns: int, seconds: float, cost: float) -> dict[str, Any]:
    return {"costUsd": cost, "numTurns": turns, "durationMs": int(seconds * 1000), "isError": False}


RATE_LIMIT_QUESTION = {
    "header": "Rate limit",
    "question": "How should I rate-limit checkout?",
    "multiSelect": False,
    "options": [
        {"label": "Token bucket", "description": "smooth bursts"},
        {"label": "Fixed window", "description": "simplest"},
        {"label": "Sliding window", "description": "needs Redis"},
    ],
}


def build_world(question: bool) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    sessions = [
        _session("session_mock_api", "api-refactor", "running", "claude-opus-5-5", 0),
        _session("session_mock_docs", "docs-site", "idle", "claude-sonnet-5-5", 42),
        _session("session_mock_pay", "payment-service", "requires_action", "claude-opus-5-5", 3),
    ]
    if question:
        blocker = _permission("AskUserQuestion", {"questions": [RATE_LIMIT_QUESTION]}, [RATE_LIMIT_QUESTION])
    else:
        blocker = _permission("Bash", {"command": "./scripts/deploy.sh staging", "description": "Deploy to staging"})
    events = {
        "session_mock_api": [
            _event(1, "system", subtype="init", model="claude-opus-5-5"),
            _event(2, "user", text="Refactor the checkout API to use the new session store"),
            _event(
                3,
                "assistant",
                text="Swapped the checkout routes onto the new session store and updated all three call sites.",
                tools=[("Edit", {"file_path": "src/api/checkout.ts"}), ("Bash", {"command": "npx tsc --noEmit"})],
            ),
            _event(4, "result", subtype="success", usage=_usage(4, 92.0, 0.31)),
            _event(5, "user", text="Fix the failing checkout tests"),
            _event(
                6,
                "assistant",
                text="Found it - the coupon total is added before tax, so the assertion is off by the tax "
                "amount. Patching the totals helper.",
                tools=[("Edit", {"file_path": "src/cart/totals.ts"}), ("Bash", {"command": "npm test"})],
            ),
        ],
        "session_mock_docs": [
            _event(1, "system", subtype="init", model="claude-sonnet-5-5"),
            _event(2, "user", text="Proofread the getting-started guide"),
            _event(
                3,
                "assistant",
                text="Fixed four typos and a broken link to the install page.",
                tools=[
                    ("Read", {"file_path": "docs/getting-started.md"}),
                    ("Edit", {"file_path": "docs/getting-started.md"}),
                ],
            ),
            _event(4, "result", subtype="success", usage=_usage(3, 41.5, 0.12)),
        ],
        "session_mock_pay": [
            _event(1, "system", subtype="init", model="claude-opus-5-5"),
            _event(2, "user", text="Ship the rate limiter to staging"),
            _event(3, "assistant", text="Tests pass. Deploying to staging next."),
            _event(4, "control_request", control=blocker),
        ],
    }
    return sessions, events


_R_SESSION = re.compile(r"^/api/sessions/(?P<sid>[^/]+)(?P<rest>/events|/stream)?$")


class _Handler(BaseHTTPRequestHandler):
    sessions: ClassVar[list[dict[str, Any]]] = []
    events: ClassVar[dict[str, list[dict[str, Any]]]] = {}

    def log_message(self, fmt: str, *args: Any) -> None:
        pass

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, obj: Any, status: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._json({"ok": True})

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/whoami":
            return self._json({"logged_in": True, "subscription": "max"})
        if path in ("/api/sessions", "/api/sessions/"):
            return self._json({"sessions": self.sessions})
        m = _R_SESSION.match(path)
        if not m:
            return self._json({"error": "not found", "status": 404}, status=404)
        session = next((s for s in self.sessions if s["id"] == m["sid"]), None)
        if not session:
            return self._json({"error": "session not active", "status": 409}, status=409)
        if m["rest"] == "/events":
            return self._json({"events": self.events.get(session["id"], [])})
        if m["rest"] == "/stream":
            return self._stream()
        return self._json({"session": session})

    def _stream(self) -> None:
        """An SSE stream with nothing new to say: held open with keep-alives."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(b"retry: 3000\n\n")
            while True:
                self.wfile.flush()
                time.sleep(15)
                self.wfile.write(b": keep-alive\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8791, help="port (default 8791)")
    ap.add_argument("--question", action="store_true", help="block payment-service on a question, not a permission")
    args = ap.parse_args()
    _Handler.sessions, _Handler.events = build_world(args.question)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), _Handler)
    server.daemon_threads = True
    print(f"mock bridge on http://localhost:{args.port} (any token)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
