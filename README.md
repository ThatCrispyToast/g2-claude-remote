# Claude Remote

Monitor and steer [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
remote-control sessions from a pair of **Even Realities G2** smart glasses.

Scroll through your live sessions on the HUD, tap into one to watch its event
stream, and steer it hands-free: approve permission prompts, answer questions,
send canned replies, dictate a message by voice, interrupt, or switch model and
permission mode. A companion phone panel mirrors everything with a richer
control surface.

Only sessions that are **active and connected** are ever shown or steered —
archived and dead sessions are filtered out server-side, and every control
action re-checks.

## How it works

```
G2 glasses (576×288 HUD · touchpad · mic)
        │ BLE
        ▼
Even phone app — runs this app (glasses UI + companion panel)
        │ HTTP + SSE · bearer token · LAN / Tailscale
        ▼
claude-remote-bridge (server/) — wraps claude-rc-api
        │ your Claude Code OAuth login (~/.claude)
        ▼
Anthropic Remote Control API
```

- **The bridge** ([`server/`](server/README.md), installable as
  `claude-remote-bridge`) runs on any machine logged in to Claude Code. It's a
  small, dependency-free JSON+SSE server over
  [`claude-rc-api`](https://github.com/ThatCrispyToast/claude-rc-api) that adds
  the active-only filter, bearer-token auth, and routes for answering blocking
  permission prompts and questions (which the stock tooling cannot do). It uses
  the host's own OAuth login and survives token rotation.
- **The app** (`src/`, packed into an `.ehpk`) runs inside the Even phone app
  and renders on the glasses. Bridge URL, token, and Deepgram key are entered
  at runtime in the panel's Settings card, so distributed builds contain no
  secrets.

Voice dictation streams mic audio from the phone to
[Deepgram](https://deepgram.com) and sends the final transcript as a message.

## Quick start

1. **Install the app** on your glasses — from the Even Hub, or sideload a
   packed `claude-remote-<version>.ehpk`.
2. **Run the bridge** on the machine where you're logged in to Claude Code
   (needs [uv](https://docs.astral.sh/uv/)):

   ```bash
   uvx --from "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server" claude-remote-bridge
   ```

   It prints the URLs your phone can reach it at and a bearer token — a word
   passphrase like `coral-anvil-mango-scoop-visor-troll`, generated on first
   run and persisted to `~/.config/claude-remote/bridge-token`. Enter one URL
   and the token in the panel's **Settings** card.
3. **Optional:** add a [Deepgram](https://console.deepgram.com) API key in the
   same Settings card to enable voice dictation. Without one, voice disables
   itself and everything else still works.

Keep the bridge on a private network (LAN or Tailscale): the token is the only
guard, and it can read and steer every remote-control session of the logged-in
account. See [`server/README.md`](server/README.md) for flags and env vars.

## Controls

| Screen | Scroll ↑ / ↓ | Tap | Double-tap |
|---|---|---|---|
| **Sessions list** | move selection | open session | exit app |
| **Session view** | native scroll — up into history, back down to live | open Compose menu | back to list |
| **Compose menu** | move selection | fire action / enter submenu | back to session |
| **Model / Mode submenu** | move selection | apply | back to Compose |
| **Voice dictation** | scroll transcript | send | cancel |
| **Permission prompt** | move between Allow / Deny | pick | set aside |
| **Question** | move between options | pick (`Dismiss` cancels) | set aside |

Every session opens on its newest output and auto-follows while running
(`● live`); scrolling up freezes a history window you swipe through, and
scrolling back down re-attaches to the tail. The **Compose** menu leads with
**Dictate**, followed by configurable quick-sends (`Continue`, `Yes`, …),
`Interrupt`, `Model`, `Mode`, and `Archive`.

When a session blocks on you, the matching **Permission** or **Question**
screen appears — immediately if you're watching the live tail, otherwise once
you return (the footer shows `! needs you` meanwhile). No blocking screen is a
trap: double-tap **sets the prompt aside** without answering anything, and an
**Answer question** / **Review permission** row appears in the Compose menu to
reopen it on your own terms. Prompts answered elsewhere (the panel, the
terminal, another controller) retire themselves.

The **companion panel** in the phone WebView mirrors all of this and adds
free-text sends, the full un-clipped event log with tool inputs and usage/cost,
and the Settings card.

## Configuration

Two layers on the app side, highest wins:

1. **Runtime settings** — the panel's Settings card (bridge URL, token,
   Deepgram key), stored in the device's localStorage. This is how a prebuilt
   `.ehpk` is configured.
2. **Build-time defaults** — `VITE_*` vars in `.env.local`, baked in by Vite.
   See [`.env.example`](.env.example) for the full list (poll interval, HUD
   window sizes, quick-sends, voice knobs).

The bridge takes CLI flags and `RC_BRIDGE_*` env vars, and also reads
`.env.local` (`VITE_BRIDGE_TOKEN` doubles as its token) — one file configures
both sides.

## Development

Node 18+ for the app, Python 3.10+ with uv for the bridge.

```bash
git clone https://github.com/ThatCrispyToast/g2-claude-remote && cd g2-claude-remote
npm install
cp .env.example .env.local     # fill in VITE_BRIDGE_URL / VITE_BRIDGE_TOKEN

npm run bridge                 # bridge → 0.0.0.0:8790
npm run dev                    # app dev server → http://0.0.0.0:5175

# sideload onto the glasses (phone on the same Wi-Fi / Tailscale network)
npx @evenrealities/evenhub-cli qr --url http://<host>:5175 --external
```

Point `VITE_BRIDGE_URL` at an address the **phone** can reach — a Tailscale
MagicDNS name or a LAN IP. Developing on `claude-rc-api` at the same time?
Clone it next to this repo; `npm run bridge:uv` runs the bridge through that
checkout's uv environment.

### Packaging

```bash
npm run pack                   # → claude-remote-<version>.ehpk
```

Builds the bundle, then generates a local manifest (`app.local.json`,
gitignored) with the version stamped from `package.json` and your bridge host
added to the network whitelist. `.env.local` values are baked in as defaults —
pack with an empty `.env.local` for a distributable build and configure
everything after install. (The tracked manifest whitelists `"*"`; if your Even
app build enforces exact origins, packing with your bridge URL in `.env.local`
whitelists the concrete origin too.)

### Running the bridge as a service

The bridge is stateless — any service manager works:

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

## Project layout

```
server/                the bridge — a pip/uv package (claude-remote-bridge)
scripts/prepack.mjs    generates app.local.json (whitelist + version) at pack time
assets/                app icons for the Even Hub listing
src/
  main.ts              app state machine, event routing, stream lifecycle
  glasses.ts           576×288 renderer: native text / list / scroll layouts
  ui.ts                the companion browser panel (incl. the Settings card)
  config.ts            config: runtime settings → VITE_* env → defaults
  rc/                  bridge contract, typed fetch wrappers, SSE stream
  events/              rolling event log + HUD line formatting
  input/               Compose menu model, voice dictation orchestration
  stt/deepgram.ts      streaming speech-to-text
app.json               Even Hub manifest (microphone + network whitelist)
```

## License

[MIT](LICENSE). Unofficial — not affiliated with Anthropic or Even Realities.
The Remote Control API surface is reverse-engineered and may change without
notice.
