# claude-remote-bridge

The server half of [Claude Remote](https://github.com/ThatCrispyToast/g2-claude-remote):
a small JSON+SSE bridge that the Even Realities G2 glasses app talks to. Run it
on any machine that is **logged in to Claude Code** (`claude` → `/login` with a
claude.ai account) and runs `claude remote-control` sessions.

## Run

```bash
uvx --from "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server" claude-remote-bridge
```

That's it. On startup it prints the URLs the phone can reach (localhost, LAN IP,
Tailscale IP) and a bearer token — a short word passphrase like
`coral-anvil-mango-scoop-visor`, generated on first run and persisted to
`~/.config/claude-remote/bridge-token` — which you copy into the Claude Remote
app panel's **Settings** card once. The passphrase form is deliberate: it's made
to be *read off the banner and typed by hand* without error, unlike a random
blob. (Setting your own `--token` / `RC_BRIDGE_TOKEN` overrides it, any format.)
No config files required.

If the phone can't connect, open the bridge's port (default `8790`) in the
host's firewall.

**Updating:** `uvx` caches the built environment, so a plain re-run keeps
whatever versions it first resolved — including the `claude-rc-api` git
dependency. To pick up fixes, run once with `--refresh`:

```bash
uvx --refresh --from "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server" claude-remote-bridge
```

A successful send confirms delivery. On 2026-11-19 a Claude Code 2.1.328
worker treated bridge sends as peer messages and spent a turn declining
`/context`. The change in claude-rc-api 0.2.1 helped older workers. Updating
the bridge cannot assign a human sender to a message. Open the session in
Claude on the web or phone for human-authored messages and slash commands.

Bridge 0.4.0 added Ask aside and Session info. Version 0.5.0 paginates the
active-session list so older running sessions remain visible. Version 0.6.0
reads back past repeated settings events to find the conversation.
The bridge requires claude-rc-api 0.5.1 or newer.

Bridge 0.7.0 pages older history with the exclusive `before` cursor from
`GET …/events`. A null cursor ends history at the first event or the latest
conversation reset. The app gets the current rate limit from session metadata.
With claude-rc-api 0.7.1+, permission prompts can also offer a session rule.
The bridge confirms the worker still offers that exact rule before sending it.
Persistent host permission settings stay under the terminal user's control.

The bridge can transcribe dictation itself (the `local-stt` extra:
`mlx-whisper` on Apple Silicon, `faster-whisper` elsewhere, which tries an
NVIDIA GPU and falls back to the CPU): `POST
/api/stt/start`, then raw PCM to `…/<id>/audio` and `…/<id>/finish`. Each reply
carries the interim text and any text committed at a pause. `GET /api/whoami`
reports `local_stt`, which the app's Bridge dictation option checks.

Also works with `pip install "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server"`
then `claude-remote-bridge`, or from a repo checkout via `python3 server/rc_bridge.py`.

## Options

```
--host HOST     bind address (default 0.0.0.0)
--port PORT     port (default 8790)
--token TOKEN   bearer token the app must present
--open          run WITHOUT authentication (dev only)
--verbose       log every request
--version       print the bridge version and exit
```

Environment variables `RC_BRIDGE_HOST` / `RC_BRIDGE_PORT` / `RC_BRIDGE_TOKEN` /
`RC_BRIDGE_VERBOSE` are honored, as is a `.env.local` in the working directory
or repo checkout (`VITE_BRIDGE_TOKEN` doubles as the token, so the app repo's
config file configures both sides). `RC_BRIDGE_TOKEN_WORDS` sets how many words
a *generated* passphrase has (default 5 ≈ 52 bits; floored at 3).
For local dictation (the `local-stt` extra), `RC_BRIDGE_STT_MODEL` picks the
Whisper model (default `mlx-community/whisper-small.en-mlx` with MLX,
`small.en` with faster-whisper), `RC_BRIDGE_STT_BACKEND` (`mlx` or
`faster-whisper`) overrides which one runs, and `RC_BRIDGE_STT_IDLE_S` sets how
long an unused model stays loaded (default 300).

## What it does

Wraps [`claude-rc-api`](https://github.com/ThatCrispyToast/claude-rc-api)'s
`RemoteControlClient` (0.5.1 or newer) and exposes exactly what the glasses UI
needs: an active-sessions-only list with each session's effort, context use,
one-line status summary and claude.ai pin; per-session SSE event streams
carrying the worker's live model / effort / permission mode and background
tasks, with a `ping` frame every ~15 s (the app redials a stream that stops
pinging, and the bridge drops one whose app has gone);
a session's recent history, read back far enough to hold some conversation
and gzipped for a client that takes it; send/interrupt/model/mode/effort/pin/
archive controls and `POST …/read` (clear the unread mark); routes that
**answer blocking permission prompts and questions**; and worker queries:
`POST …/aside`
(a side question, answered without interrupting the session or entering its
transcript), `GET …/info` (plan usage + uncommitted git changes) and
`POST …/stop_task`. It adds no Anthropic protocol code of its own, keeps no
state, and survives OAuth token rotation (the API client reloads rotated
credentials from disk).

Security model: bearer token (a ~52-bit word passphrase, auto-generated by
default), permissive CORS (safe — the token, not a cookie, is the guard), meant
for a private LAN or tailnet only. Anyone with the token can read and steer every
remote-control session of the logged-in account — do not expose it publicly.

## Publishing note

The `claude-rc-api` dependency is a direct git URL so the `uvx --from git+…`
one-liner works without any PyPI release. PyPI rejects direct URL dependencies:
to publish this package there, release `claude-rc-api` to PyPI first and switch
the dependency to a version specifier.

## Credits

`claude_remote_bridge/wordlist.py` embeds the EFF "Short Wordlist #1" (Joseph
Bonneau / the Electronic Frontier Foundation, 2016 — <https://www.eff.org/dice>),
used under [CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/), to
generate the human-typeable token passphrases.
