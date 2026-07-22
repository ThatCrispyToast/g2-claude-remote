# Claude Remote

**Steer Claude Code from your glasses.** Watch and control live
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) remote-control
sessions from [Even Realities G2](https://www.evenrealities.com) smart glasses —
the event stream on the HUD, the touchpad to approve and reply, the mic to
dictate. A companion phone panel mirrors everything with a richer control
surface.

<p align="center">
  <img src="assets/store/02-session-live.png" width="70%" alt="A live session streaming on the 576×288 HUD">
</p>

## Quick start

**1. Install the app** on your glasses — from the Even Hub, or by sideloading a
packed `claude-remote-<version>.ehpk`.

**2. Run the bridge** on the machine where you're logged in to Claude Code
(needs [uv](https://docs.astral.sh/uv/)):

```bash
uvx --from "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server" claude-remote-bridge
```

It prints the URLs your phone can reach it at and a bearer token — a word
passphrase like `coral-anvil-mango-scoop-visor`, generated on first run and
saved to `~/.config/claude-remote/bridge-token`.

**3. Connect** — enter one of those URLs and the token in the panel's Settings
card. Optionally add a [Deepgram](https://console.deepgram.com) API key there to
enable voice dictation (leave it blank and voice quietly disables itself).

If the phone can't connect, open the bridge's port (default `8790`) in the
host's firewall. Keep the bridge on a private network — LAN or Tailscale: the
token is the only guard, and it can read and steer every remote-control session
of the logged-in account. Flags and env vars: [`server/README.md`](server/README.md).

## Highlights

- **Live sessions on the HUD** — every session opens on its newest output and
  auto-follows while running; scroll up to page through history, back down to
  re-attach to the live tail.
- **Answer blocking prompts** — permission requests and questions show up as
  native screens (immediately if you're watching, `! needs you` in the footer if
  not). Tap to answer, double-tap to set aside for later. A prompt answered
  elsewhere retires itself.
- **Steer hands-free** — interrupt, switch model, permission mode, or reasoning
  effort, fire slash commands (`/context`, `/usage`, `/compact`, …), send canned
  replies, or dictate a message by voice
  ([Deepgram](https://deepgram.com) streaming).
- **Nothing fires on a stray tap** — every canned send and finished dictation
  lands on a confirmation screen showing the full message first.
- **Active sessions only** — archived and dead sessions never reach the glasses,
  and every control action re-checks before it acts.
- **No secrets in the build** — the packed app carries no keys or hosts; you
  configure the bridge URL, token, and Deepgram key at runtime in the panel's
  Settings card.

<p align="center">
  <img src="assets/store/01-sessions.png" width="49%" alt="Sessions list">
  <img src="assets/store/03-compose.png" width="49%" alt="Compose menu">
</p>

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

The app (`src/`, packed into an `.ehpk`) runs inside the Even phone app and
renders on the glasses through the firmware's native widgets. The bridge
([`server/`](server/README.md)) is a small JSON+SSE server on top of
[`claude-rc-api`](https://github.com/ThatCrispyToast/claude-rc-api) that runs on
any machine logged in to Claude Code — it borrows that login (surviving token
rotation) and adds the active-only filter, bearer-token auth, and the routes for
answering blocking prompts.

## Controls

| Screen | Scroll ↑ / ↓ | Tap | Double-tap |
|---|---|---|---|
| **Sessions list** | move selection | open session | exit app |
| **Session view** | native scroll — up into history, down to live | open Compose menu | back to list |
| **Compose menu** | move selection | fire action / enter submenu | back to session |
| **Commands submenu** | move selection | fire slash command | back to Compose |
| **Model / Mode / Effort submenu** | move selection | apply | back to Compose |
| **Voice dictation** | scroll transcript | done — review before sending | cancel |
| **Confirm send** | scroll the message | send | cancel |
| **Permission prompt** | move between Allow / Deny | pick | set aside |
| **Question** | move between options | pick (`Dismiss` cancels) | set aside |

The Compose menu leads with Dictate, then the quick-sends (`Proceed`,
`Run tests`, `Explain` — configurable), `Interrupt`, `Commands`, `Model`,
`Mode`, `Effort`, and `Archive`. Slash commands run as local commands at no
token cost; heavy ones (`/compact`, `/clear`) go through the confirm screen
first. A set-aside prompt reopens from the Compose menu's `! Answer question` /
`! Review permission` row, or by reopening the session — no blocking screen can
trap you.

## The companion panel

The same bundle's DOM is a full control surface in the phone's WebView: the
un-clipped event log with tool inputs and usage/cost, free-text sends with `/`
slash-command autocomplete, every steering control, and the Settings card. With
no glasses connected it still works as a plain-browser web app.

<p align="center">
  <img src="assets/store/08-panel.png" width="45%" alt="Companion phone panel">
</p>

## Configuration

Two layers on the app side; the higher wins:

1. **Runtime settings** — the panel's Settings card (bridge URL, token, Deepgram
   key), stored on the device across app restarts. This is how a packed `.ehpk`
   is configured.
2. **Dev-server defaults** — `VITE_*` vars in `.env.local`, read by
   `npm run dev` only ([`.env.example`](.env.example) lists them all). Packs
   never include them: `npm run pack` builds with env resolution disabled, so no
   key or host can leak into an artifact.

The bridge takes CLI flags and `RC_BRIDGE_*` env vars, and reads `.env.local`
too (`VITE_BRIDGE_TOKEN` doubles as its token), so one file configures both
sides in development.

## Development

Node 18+ for the app; Python 3.10+ with [uv](https://docs.astral.sh/uv/) for the
bridge.

```bash
git clone https://github.com/ThatCrispyToast/g2-claude-remote && cd g2-claude-remote
npm install
cp .env.example .env.local     # set VITE_BRIDGE_URL / VITE_BRIDGE_TOKEN

npm run bridge                 # bridge → 0.0.0.0:8790
npm run dev                    # app dev server → http://0.0.0.0:5175

# sideload onto the glasses (phone on the same Wi-Fi / Tailscale network)
npx @evenrealities/evenhub-cli qr --url http://<host>:5175 --external
```

Point `VITE_BRIDGE_URL` at an address the phone can reach — a Tailscale MagicDNS
name or a LAN IP. To hack on `claude-rc-api` at the same time, clone it next to
this repo and use `npm run bridge:uv`.

**Packaging:** `npm run pack` builds and packs
`claude-remote-<version>.ehpk`. Every pack is distributable (no env is
resolved), and it refuses to run if `package.json` and `app.json` disagree on
the version — bump both together.

**Bridge as a service:** the bridge holds no state, so any service manager
works — install it once and point a systemd unit (or equivalent) at
`claude-remote-bridge`:

```bash
uv tool install "git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server"
```

## License

[MIT](LICENSE). Unofficial — not affiliated with Anthropic or Even Realities.
The Remote Control API surface is reverse-engineered and can change without
notice.
