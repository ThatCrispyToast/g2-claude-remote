# CLAUDE.md — Claude Remote

Steer active Claude Code Remote Control sessions from Even Realities G2 glasses
(576×288 BLE HUD + touchpad + mic), with a companion phone panel. `README.md`
has the architecture, controls, and project layout; this file is the operating
notes and sharp edges.

Ship model: the client is distributed as a prebuilt `.ehpk`; the bridge runs on
any host logged in to Claude Code. So no secret may ever be REQUIRED at build
time — the panel's Settings card (runtime settings in localStorage, layered
above the baked `VITE_*` values in `config.ts`) is the end-user config path.

## Rules

1. **The bridge adds no Anthropic code.** It reuses `claude-rc-api`'s
   `RemoteControlClient` (checked out at `../claude-rc-api`) and layers on only
   the active+connected filter, a bearer/CORS guard, and the `control_response`
   builders for the two blocking flavors. Session control, streaming, and OAuth
   (including rotated-token reload) live in `claude-rc-api` — don't reimplement
   or add credential logic here.
2. **Only-active, always.** Surface and steer only sessions that are `active`
   **and** `connected`. The bridge filters server-side and every control action
   re-checks; a `409` (`BridgeError.isInactive`) means "gone" → toast + back to
   the list. Never act on an inactive session.
3. **Lean on the firmware — don't fight it.** The HUD uses the SDK's *native*
   widgets (`glasses.ts`), modeled on the `nickustinov/demo-app-g2` reference
   app. Never `rebuildPageContainer` while a body is being scrolled — it resets
   the native scroll position. Steady-state changes are per-container
   `textContainerUpgrade`s (header / body / footer diffed independently); a full
   rebuild only when the layout kind or a native list's items change.
4. **Effort is a fallback control.** Remote-control workers (through at least
   2.1.212) REFUSE the `apply_flag_settings` control that carries `effortLevel`
   ("REPL bridge does not handle…" — confirmed live), so claude-rc-api's
   `set_effort(wait=…, command_fallback=True)` waits for the worker's verdict
   and falls back to injecting the `/effort <level>` slash command, which RC
   workers DO execute as a zero-cost local command (also confirmed live; slash
   commands sent as user messages run locally in general). Mind the semantics:
   the command path **persists that machine's default effort** for new sessions
   (CLI behavior), it is not session-scoped; the bridge's response `via` field
   says which path ran. No upstream field exposes the current effort — the
   glasses mark only the last level applied from this app (`effortBySid`).

## Commands

```bash
npm run dev          # app dev server → 0.0.0.0:5175
npm run bridge       # bridge → 0.0.0.0:8790 (config from .env.local)
npm run bridge:uv    # bridge through ../claude-rc-api's uv env (sibling checkout)
npm run pack         # build + prepack → claude-remote-<version>.ehpk
npx @evenrealities/evenhub-cli qr --url http://<host>:5175   # sideload QR
```

- **Bump `version` in both `package.json` and `app.json`** (kept identical) on
  every code/manifest change — `pack` stamps it into the artifact name.
- **`pack` packs `app.local.json`, not `app.json`.** Prepack folds `.env.local`'s
  bridge host (+ `VITE_NET_WHITELIST_EXTRA`) into the gitignored local manifest.
  A pack made WITH `.env.local` present bakes your token/keys in — personal
  builds only; distribute only packs made with `.env.local` set aside. (The
  tracked manifest whitelists `"*"`; whether phones honor the wildcard is
  unverified on hardware.)
- **The simulator runs headlessly.** `@evenrealities/sim-linux-x64` is a
  GTK/WebKit binary: run under `xvfb-run` (on NixOS, put its libs on
  `NIX_LD_LIBRARY_PATH` via nix-ld) with `--automation-port 9898`, then drive it
  over HTTP: `GET /api/screenshot/glasses` (the exact 576×288 framebuffer),
  `POST /api/input {"action":"up|down|click|double_click"}`, `GET /api/console`.
  Relaunch after every edit — Vite HMR does NOT reload the entry module. The sim
  caps text containers at 999 bytes. Real hardware is still needed for the mic
  and true native scroll.
- **No Even bridge (plain browser) = panel-only mode** — glasses/gesture/mic
  paths skip; the session list, stream, and steering still work via the panel.

## HUD gotchas

- **The firmware font has NO emoji and NO dingbats** (`✓ ✗ ⚠ ⚙ … › •` render as
  nothing). Every HUD glyph must come from the `HUD` set in `glasses.ts`
  (`● ○ ! ◆ ◇ ☉ » ▶ ■ ← ·`). Ground truth: `nickustinov/even-g2-notes`
  (`docs/display.md`). **`ui.ts` is exempt** — the panel is a real browser
  WebView; rich glyphs there are intended, and it formats events itself
  (independently of the HUD-only `events/format.ts`). Don't "fix" it.
- **Native text scroll is boundary-only.** A text container with
  `isEventCapture:1` is scrolled smoothly by the firmware; the app only sees
  `SCROLL_TOP`/`SCROLL_BOTTOM` at the ends. The session view exploits this: an
  auto-following **live** tail + frozen multi-screen **history** windows
  (`EventLog.tailWindow/windowBefore/windowFrom`). Do not reintroduce software
  page-flipping.
- **The firmware renders text TOP-aligned and never auto-scrolls**, so an
  overflowing live tail hides exactly the newest lines. The tail
  (`EventLog.tailRows`) is budgeted by estimated visual ROWS (`LIVE_BODY_ROWS` ×
  `HUD_CHARS_PER_ROW`, wrapping counted) so it always fits — a byte budget alone
  can't guarantee that. Every session opens on this tail (`● live` running /
  `○ latest` idle); scroll-up enters history.
- **Content caps are BYTES, not chars** (~1000 per rebuild, ~2000 per upgrade,
  999 in the simulator), and HUD glyphs are 2–3 bytes each — an oversize body is
  **silently dropped** (the screen just freezes). `glasses.ts` byte-clamps every
  body (`BODY_BYTE_CAP`) and checks the rebuild/upgrade return value; the log
  packs windows by bytes (`LIVE_BODY_BYTES` / `HISTORY_WINDOW_BYTES`). Never
  size a body by char count.
- **Exactly one `isEventCapture:1` container per page** (the scroll/tap target).
- **Gesture events are messy:** they arrive as `listEvent` OR `textEvent` OR
  `sysEvent` — coalesce all three. `CLICK_EVENT` is `0`, which protobuf drops,
  so a tap arrives as `eventType === undefined`. IMU frames are ignored.

## Blocking prompts

- **Two kinds, two screens, both native lists.** A blocking `control_request`
  is either a **tool-permission** (the `permission` screen: `[Allow, Deny]`,
  Allow=row 0; answered via `/permission` — the full tool input lives on the
  panel, the HUD shows a clip) or a **question** (the `question` screen: the
  options + a trailing `← Dismiss` row; answered via `/dialog`). On BOTH,
  double-tap **sets the prompt aside** (sends nothing — see below).
- **`AskUserQuestion` arrives as a `can_use_tool` permission** (confirmed live),
  NOT a `request_user_dialog`: its `input` carries the `questions`, and `/dialog`
  answers it on the PERMISSION path — `build_question_answer` sends an `allow`
  whose `updatedInput` echoes `questions` (the tool crashes without it) plus
  `answers`, a map keyed by **question TEXT** → chosen label (list for
  multi-select; empty map = graceful dismiss). Discriminator:
  `isQuestionRequest` in `events/format.ts`. The `{status, result}` shape
  (`build_dialog_answer`) is an UNCONFIRMED fallback for true
  `request_user_dialog` / `side_question` kinds — verify against a live sample
  before trusting it.
- **Prompts QUEUE; they never hijack.** Three guards against stale/replayed
  requests: the bridge fetches history `desc` (newest events) so the stream
  resume cursor is never ancient; `EventLog.append` seq-dedupe gates all UI
  side-effects; prompts live in a FIFO (`prompts[]` + `answeredIds`) and retire
  on a matching `control_response` in the stream (our own answers echo back),
  on the turn's `result`, or via the poll safety-net when the session leaves
  `requires_action`. **An assistant event after a `control_request` does NOT
  mean it was answered.** A prompt presents immediately only while passively
  watching the live tail; otherwise it defers (footer `! needs you`) and shows
  on return to the session view. A blocked session opens straight onto its
  prompt (`findPendingControl` + `workerStatus === 'requires_action'`).
- **Set-aside = a STICKY defer (`promptSnoozed`).** Double-tap calls
  `snoozePrompt()`: marks the prompt `promptDeferred + promptSnoozed` and drops
  to the live tail without answering. The snooze flag is the one difference
  from a normal defer — the auto-present guards in `go('session')` and
  `enterLive()` skip snoozed prompts, so returning to live won't reopen it. It
  reopens only deliberately: the Compose menu's leading `! Answer question` /
  `! Review permission` row, or reopening the session. It clears on
  `presentPrompt`/`armPrompt`/`clearPromptState`, and the prompt still retires
  normally while set aside. Because the Compose list varies with pending state,
  it is snapshotted into `composeItems` on entry so a mid-menu stream event
  can't desync the firmware row → action map.

## Send confirmation

- **A message never fires on one tap.** Both a canned quick-send (Compose) and a
  finished dictation route through the `confirm` screen (`confirmSend` →
  `pendingSend` → `commitPendingSend`/`cancelPendingSend`), so a stray touchpad
  tap can't send the wrong thing. It's the same native `scroll` layout as the
  voice screen — full message in the natively-scrolled body, `tap = send`,
  `dbl = cancel` — so a long dictation can be read back before it goes.
- **Glasses-only guard.** The panel's quick-send / Dictate controls are explicit
  buttons (not misclick-prone), so they still send directly via `commitVoice` /
  `onSend`; don't add a panel confirm. The voice screen's tap now **reviews**
  (`reviewDictation`, footer `tap = done`), it no longer sends — `commitVoice`
  survives only for the panel's Stop button.
- **Cancel returns to `pendingSend.back`:** the Compose menu for a canned send
  (so re-pick is one tap; `listSelectIndex` is reset to match the rebuilt list),
  the live session for a dictation (its mic is already closed). `backToList`
  clears `pendingSend`; a deferred prompt still can't hijack the confirm screen
  (it's not `session`+`live`, so `armPrompt` defers).

## Slash commands

- **They ride `/send` — no bridge route.** A slash command is just a `/name`
  message; RC workers execute it locally at zero cost (the same mechanism the
  effort control's fallback uses — see rule 4). The Compose → Commands submenu
  (`commandItems`, `fireSlashCommand`) and the panel's `/` autocomplete both go
  through the existing `send`/`onSend` path. Adding a command is a `SLASH_COMMANDS`
  config entry (`VITE_SLASH_COMMANDS` to override), never new bridge code.
- **Curate to fire-and-observe commands only, and VALIDATE live.** Not every
  command works over remote-control, and the failure modes are silent-ish:
  - **Refused by the worker** — some print `"/<name> isn't available over Remote
    Control."` as an assistant line and do nothing. Confirmed live (2026-07-17,
    Haiku RC worker): `/status` and `/release-notes` both refuse this way. Keep
    them out.
  - **Not a real local command** — an unrecognized `/name` is NOT echoed as a
    local command; it falls through to the model as a literal user message and
    triggers a full (tool-using) turn. Confirmed: `/todos` did exactly this
    (assistant → ToolSearch → TaskList). This is the worst case — it spends a
    model turn — so never ship an unverified name.
  - **Aliases** — `/cost` redirects to `/usage` (the echo shows
    `<command-name>/usage`), so ship the canonical name.
  - **Verified good** (local, `$0`, glanceable output): `/context`, `/usage`,
    `/mcp`, `/compact`. `/clear` runs (no error, no model turn) but emits NO
    `<local-command-stdout>`, so it gives no HUD feedback that it worked.
  - Interactive ones (`/login`, `/config`, `/vim`, `/ide`, `/terminal-setup`)
    have no remote meaning. Mind machine-global semantics too: like `/effort`,
    some commands persist a machine default rather than being session-scoped.
  - Test harness: send `/name` via `POST /api/sessions/<sid>/send`, then read
    `/events` — a good command shows the `<command-name>` + `<local-command-stdout>`
    echo with zero `result.usage.costUsd` and no assistant turn.
- **`confirm:true` = don't fire on one interaction** (heavy/destructive, e.g.
  `/compact`, `/clear`). On the glasses it routes through the send-confirm screen;
  on the panel it fills the box and waits for an explicit Send. `takesArg:true`
  makes the panel fill `/name ` and wait for a typed argument (glasses fire bare
  — v1 has no on-glasses argument entry; dictated args are a planned fast-follow).
- **Command echoes are cleaned on BOTH surfaces by `cleanUserEcho`** (exported
  from `events/format.ts`, used by the HUD's `renderEvent` AND the panel's
  `renderEventNode`). It unwraps `<command-name>` / `<command-args>` /
  `<local-command-stdout>` to readable text and DROPS the `<local-command-caveat>`
  block (that block is addressed to the model — "DO NOT respond to these
  messages…" — so it's noise for the reader; a caveat-only event cleans to '' and
  is dropped). Confirmed live in the simulator: without this the panel showed raw
  `<command-name>/context</command-name>` + the caveat paragraph as message
  bubbles. Note a local command still yields two user events that both read as the
  command (the send + the `<command-name>` echo); the HUD's row-budgeted tail
  usually hides the older one, the panel shows both — acceptable, not deduped.

## Config & secrets

- **Layering, runtime wins:** panel-saved settings (`claude-remote.settings` in
  localStorage) → `VITE_*` baked from `.env.local` → defaults. When debugging
  "why THAT bridge/token", check localStorage before the env. Never make a
  `VITE_` secret required at build time.
- **Panel settings persist via the SDK, not browser storage.** The Settings card
  saves to the WebView's `window.localStorage`, but the Even app EVICTS that
  between launches — so `main.ts` mirrors the same `claude-remote.settings` JSON
  into the SDK's App-side store (`bridge.set/getLocalStorage`, which persists
  natively). `hydrateSettings()` seeds the browser cache from it at boot, BEFORE
  the first connect, so a reopened app reconnects itself; `persistSettings()`
  writes it back on every save. Both are `withTimeout`-guarded (a slow/absent
  native method can't stall boot) and no-op with no Even bridge (a plain browser
  persists localStorage on its own). Without this the wearer re-enters the bridge
  URL + token on every reopen.
- **The bridge reads `.env.local` too** (`RC_BRIDGE_*` keys; `VITE_BRIDGE_TOKEN`
  doubles as the token; CLI flags and process env win). With no token configured
  it GENERATES a word passphrase (`RC_BRIDGE_TOKEN_WORDS` words from
  `wordlist.py`, default 5 ≈ 52 bits) and persists it to
  `~/.config/claude-remote/bridge-token`; `--open` is the only unauthenticated
  mode. A user-set token is used verbatim.
- **Deepgram key** lives in `.env.local` or the Settings card; voice
  auto-disables when blank.
- `server/pyproject.toml` depends on `claude-rc-api` by DIRECT GIT URL — needed
  for the `uvx --from git+…` install path; PyPI would reject it (see
  `server/README.md`).

## Repo

- **PUBLIC** — origin is `github.com/ThatCrispyToast/g2-claude-remote`.
  Everything committed is world-readable: never commit tokens, tailnet
  hostnames/IPs, or personal paths (`.env.local` / `app.local.json` / `*.ehpk` /
  `*.log` are gitignored for exactly that reason). Distribution packs must be
  made with `.env.local` set aside.
- The local-only `backup/pre-publish-history` branch holds the pre-squash
  history and must NEVER be pushed; the old private `rc-g2` GitHub repo stays
  private. No auto-push — commit + push manually when asked.
