# Claude Remote

Monitor and control **active** [Claude Code Remote
Control](https://docs.anthropic.com/en/docs/claude-code) sessions from a pair of
**Even Realities G2** glasses. Scroll the touchpad through your live Claude
sessions, tap into one to watch its event stream roll across the HUD, and steer
it hands-free — approve a permission prompt, answer a question, fire a canned
reply, dictate a message by voice, interrupt, switch model or permission mode —
all without a keyboard. A companion phone panel mirrors everything with a richer
control surface.

It is the glasses front-end to
[`claude-rc-api`](https://github.com/ThatCrispyToast/claude-rc-api) (the
unofficial Python client for the Claude Code Remote Control API), talking to it
through a small bridge that runs on any machine logged in to Claude Code.

> **Only active sessions, ever.** The app surfaces and steers *only* sessions
> that are `active` **and** whose remote-control worker is `connected`. Archived
> sessions and dead ones (worker gone) are filtered out server-side in the bridge
> and every control action re-checks — you can never act on one.

## Architecture

```
┌───────────────────────────┐        ┌──────────────────────────────────────┐
│ G2 glasses (576×288, BLE) │        │ your Claude Code host                  │
│ touchpad + mic            │        │                                        │
└─────────────┬─────────────┘        │  server/rc_bridge.py   0.0.0.0:8790    │
   even_hub_sdk bridge                │   • active-only filter + 409 gate      │
┌─────────────┴─────────────┐  HTTP  │   • bearer auth + CORS                 │
│ Even phone app (WebView)  │  + SSE │   • answers permission prompts         │
│  ┌─────────────────────┐  │───────▶│   • wraps claude-rc-api                │
│  │ Claude Remote       │  │◀───────│         RemoteControlClient            │
│  │  glasses + panel    │  │  SSE   └──────────────┬───────────────────────┘
│  └─────────────────────┘  │                       ▼  OAuth (~/.claude)
└─────────────┬─────────────┘              Anthropic /v1/code/sessions
      mic PCM ─┘ ─▶ Deepgram wss (voice dictation → a message)
```

Two pieces:

- **The bridge** (`server/`, installable as `claude-remote-bridge`) runs on the
  machine where you're logged in to Claude Code. It is a dependency-free
  `http.server` that reuses
  `claude-rc-api`'s `RemoteControlClient`, so it adds no new Anthropic code —
  just the active-only filter, a shared-secret guard (it binds beyond loopback
  so the phone can reach it over Tailscale/LAN), CORS for the WebView, and
  `control_response` builders for answering permission prompts and questions
  (which the stock `claude-rc web` cannot do). It authenticates with the host's
  own Claude Code OAuth login (`~/.claude/.credentials.json`) and **survives
  token rotation** — when Claude Code (or anything else) refreshes the OAuth
  tokens on disk, the long-running bridge picks the new ones up automatically.
- **The app** (this repo's TypeScript, packed into a `.ehpk`) runs inside the
  Even phone app and renders on the glasses. It is shipped as a prebuilt
  artifact: bridge URL, token, and Deepgram key can all be entered at runtime in
  the companion panel's **Settings** card (stored only on the device), so no
  secrets are ever baked into a distributed build.

## Use it (three steps)

1. **Install the app** on your glasses — from the Even Hub, or sideload a
   packed `claude-remote-<version>.ehpk`.
2. **Run the bridge** on the machine where you're logged in to Claude Code
   (`claude` → `/login` with a claude.ai account, and at least one
   `claude remote-control` session running). With
   [uv](https://docs.astral.sh/uv/) installed, it's one command:

   ```bash
   uvx --from "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server" claude-remote-bridge
   ```

   It prints every URL your phone can reach it at (localhost / LAN IP /
   Tailscale IP) and a bearer token — a short word passphrase like
   `coral-anvil-mango-scoop-visor-troll` (built to be typed by hand),
   auto-generated on first run and persisted to
   `~/.config/claude-remote/bridge-token`. Copy one URL + the token into the
   app panel's **Settings** card. Done — the glasses show your live sessions.
3. **Optionally add a [Deepgram](https://console.deepgram.com) API key** in the
   same Settings card to enable voice dictation. Without one, voice quietly
   disables itself and everything else still works.

The pieces connect by local or Tailscale IP on your own network — no tunnel or
public exposure is needed (or advisable). See [`server/README.md`](server/README.md)
for bridge flags (`--port`, `--token`, `--open`, …) and env vars.

## Develop / build from source

Needs Node 18+ (the app) and Python 3.10+ with uv (the bridge).

```bash
git clone https://github.com/ThatCrispyToast/g2-claude-remote && cd g2-claude-remote
npm install
cp .env.example .env.local             # optional: bake defaults into your builds

npm run bridge                         # the bridge, from the checkout → 0.0.0.0:8790
npm run dev                            # the app's dev server → http://0.0.0.0:5175

# load it on the glasses (phone on the same Wi-Fi / Tailscale network)
npx @evenrealities/evenhub-cli qr --url http://<host>:5175 --external
```

`VITE_BRIDGE_TOKEN` in `.env.local` doubles as the bridge's shared secret — the
bridge reads the same file, so setting it once configures both sides (an
`RC_BRIDGE_TOKEN` env var overrides it; with neither set the bridge generates a
token and prints it). Point `VITE_BRIDGE_URL` at a name the **phone** can
reach — the host's Tailscale IP/MagicDNS name or a LAN IP. Developing on
`claude-rc-api` at the same time? Clone it next to this repo — the bridge
auto-detects the sibling checkout (`npm run bridge:uv` runs it through that
checkout's uv environment).

### Package for distribution

```bash
npm run pack                           # build → app.local.json → claude-remote-<version>.ehpk
```

`pack` builds the bundle, then generates `app.local.json` from `app.json` +
`.env.local`: your bridge host is added to the manifest's network whitelist
(plus anything in `VITE_NET_WHITELIST_EXTRA`) and the version is stamped from
`package.json`. Values in `.env.local` are baked into the bundle as defaults,
but every secret can be overridden at runtime from the panel's Settings card —
so you can also pack with an empty `.env.local` and configure after install.

> The tracked manifest whitelists `"*"`. If your Even app build enforces exact
> origins instead of honoring the wildcard, repack with your bridge URL in
> `.env.local` so the concrete origin is whitelisted too.

## Controls

Four gestures drive everything. Nothing is free-form: each screen presents a
small ordered set of targets a cursor walks.

| Screen | Scroll ↑ / ↓ | Tap | Double-tap |
|---|---|---|---|
| **Sessions list** | move selection | open session | exit app |
| **Session view** | smooth native scroll — up drops into history, scroll back down returns to live | open Compose menu | back to list |
| **Compose menu** | move selection | fire action / enter submenu | back to session |
| **Model / Mode submenu** | move selection | apply | back to Compose |
| **Voice dictation** | scroll the transcript | send transcript | cancel (mic off) |
| **Permission prompt** | move between Allow / Deny | **pick** the highlighted action | **set aside** — answer later |
| **Question** (dialog) | move between the options | **pick** it (or the `Dismiss` row to cancel) | **set aside** — answer later |

The session view is a fixed header + a **firmware-scrolled** transcript body (in a
subtle frame that sets it off from the header and footer) + a fixed footer. The
glasses scroll the body natively (the smooth "Text: basic" feel), so there's no
software paging. **Every session opens on its tail** — the newest lines, budgeted
by estimated visual rows so they always fit the body with nothing hidden below
the fold (the firmware draws text top-aligned and never auto-scrolls, so an
overflowing "live" body would hide exactly the newest output). While the session
runs the tail auto-follows (`● live`); idle it just sits on the latest output
(`○ latest`). Scrolling up freezes a multi-screen history window you swipe
through; scrolling back down to the bottom re-attaches to the tail.

**Compose** leads with **Dictate** (voice) — the primary open-ended input on a
keyboard-less device — then your canned quick-sends (`Continue`, `Yes`, `Run the
tests`, …, configurable), `Interrupt`, `Model ▸`, `Mode ▸`, and `Archive`. When a
session blocks on you, the right screen appears: a **Permission** screen that
lists Allow / Deny (with the tool + command in the header — scroll to one and tap
to decide), or — for a question like `AskUserQuestion` or a plan dialog — a
**Question** screen that lists the options so you scroll to one and tap to pick it
(the `Dismiss` row cancels it outright). Prompts are **polite**: one shows
immediately only while you're passively watching the live tail (or when you open a
session that is already blocked); if you're mid-menu, mid-dictation, or reading
back history it waits (footer shows `! needs you`) and presents itself when you
come back. And **no blocking screen is a trap**: if it's just bad timing,
**double-tap to set the prompt aside** — nothing is sent, it stays pending (the
footer keeps nagging `! needs you`), and the Compose menu grows an **Answer
question** / **Review permission** row so you reopen it on your own terms. Unlike
an ordinary deferral, a set-aside prompt won't pop itself back up when you return
to the live tail. Prompts you answer elsewhere (the panel, another controller, the
terminal) retire themselves, and stale or replayed ones never resurface.

The **companion panel** (the same bundle, shown in the phone WebView) mirrors all
of this and adds a free-text send box, a full un-clipped event log with tool
inputs and usage/cost, one-click steering, and the **Settings** card for entering
your bridge URL, token, and Deepgram key on the device.

## Configuration

Two layers, highest wins:

1. **Runtime settings** — the panel's Settings card (bridge URL, bridge token,
   Deepgram key). Stored in the WebView's localStorage, never leaves the device.
   This is how a prebuilt `.ehpk` gets configured.
2. **Build-time env** — `VITE_*` vars in `.env.local` (see `.env.example`),
   baked in as defaults by Vite. Required for self-builds: `VITE_BRIDGE_URL`,
   `VITE_BRIDGE_TOKEN`. Optional: `VITE_POLL_MS` (list refresh),
   `VITE_LIVE_BODY_BYTES` / `VITE_HISTORY_BYTES` (session live-tail and
   history-window sizes, in bytes), `VITE_QUICK_SENDS` (JSON list of canned
   messages), and the Deepgram voice knobs (`VITE_DEEPGRAM_API_KEY`, …).

Bridge-side: CLI flags, or `RC_BRIDGE_HOST` / `RC_BRIDGE_PORT` /
`RC_BRIDGE_TOKEN` / `RC_BRIDGE_TOKEN_WORDS` / `RC_BRIDGE_VERBOSE` — each read from
the environment first, then from `.env.local` (where `VITE_BRIDGE_TOKEN` also
counts as the token), so one file configures everything. With no token configured
anywhere the bridge generates a word-passphrase token (`RC_BRIDGE_TOKEN_WORDS`
words, default 6 ≈ 62 bits), persists it to
`~/.config/claude-remote/bridge-token`, and prints it at startup.

## Answering permission prompts and questions

A running session can block the turn on you in **two** ways, and the bridge closes
both loops (neither `claude-rc web` nor `RemoteControlClient` can):

- **Tool-permission** (`control_request` `subtype: "can_use_tool"`) — the
  `POST …/permission` route builds a `control_response` whose outer
  `subtype:"success"` wraps an inner `behavior:"allow"|"deny"` keyed to the
  prompt's `request_id`, sent via `RemoteControlClient.send_raw`.
- **Question** — e.g. the `AskUserQuestion` tool. **Confirmed on live hardware:
  this arrives as a `can_use_tool` permission** (not a `request_user_dialog`)
  whose `input` carries `{questions:[{question, header, multiSelect, options}]}`.
  The bridge parses those into `permissionRequest.questions`, and the
  `POST …/dialog` route answers it **on the permission path** — an `allow` whose
  `updatedInput` merges the picks into `answers`, a map **keyed by the question
  text** (`{"<question>": "<label>"}`, a list for multi-select). An empty map is
  the graceful *dismiss* ("The user did not answer the questions"); `updatedInput`
  always echoes `questions` (the tool crashes without it). On the glasses you
  scroll the options and tap to pick; on the panel they're buttons.

The permission/allow shapes are confirmed against live prompts. The old
`{status, result}` dialog-result shape (`build_dialog_answer`) is retained only as
an **unconfirmed** fallback for the rarer true `request_user_dialog` /
`side_question` kinds (elicitation, MCP-approval, plan dialogs) — confirm that one
against a live sample before trusting it.

## Running the bridge permanently

Any service manager works — the bridge is stateless. Install it once as a uv
tool, then point a unit at the binary (adjust the user):

```bash
uv tool install "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server"
```

```ini
[Unit]
Description=Claude Remote bridge
After=network-online.target

[Service]
User=you
ExecStart=%h/.local/bin/claude-remote-bridge
Restart=on-failure

[Install]
WantedBy=default.target
```

Keep it on a private network (Tailscale/LAN) — the bearer token is the only
guard, and the bridge can read and steer every remote-control session of the
logged-in account. No public tunnel is needed or advisable.

## Project layout

```
server/                 the bridge — a pip/uv package (claude-remote-bridge)
  claude_remote_bridge/bridge.py  the JSON+SSE server (active-only) over claude-rc-api
  rc_bridge.py          dev shim: python3 server/rc_bridge.py, no install needed
  pyproject.toml        packaging (console script: claude-remote-bridge)
scripts/prepack.mjs     generates app.local.json (whitelist + version) at pack time
src/
  main.ts               entry: state machine, EvenHub event routing, stream lifecycle
  config.ts             config: runtime settings (panel) → VITE_* env → defaults
  glasses.ts            serialized 576×288 renderer: native text / list / scroll
                        layouts, per-container in-place upgrades, safe-glyph set
  ui.ts                 the companion browser panel (incl. the Settings card)
  rc/
    types.ts            the bridge ↔ app contract (ActiveSession, RcEvent, …)
    client.ts           typed fetch wrappers over the bridge
    stream.ts           SSE (EventSource) wrapper with resume + error framing
  events/
    log.ts              rolling, de-duped, paged event log
    format.ts           one RcEvent → a compact HUD line
  input/
    compose.ts          the Compose / Model / Mode menu model
    voice.ts            mic → Deepgram → final transcript orchestration
  stt/deepgram.ts       streaming STT
app.json                Even Hub manifest (g2-microphone + network whitelist)
```

## License

[MIT](LICENSE). Unofficial — not affiliated with Anthropic or Even Realities.
The Remote Control API surface is reverse-engineered and may change without
notice.
