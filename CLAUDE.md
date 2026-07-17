# CLAUDE.md — Claude Remote (dir: rc-g2)

Monitor and control **active** Claude Code Remote Control sessions from a pair of
Even Realities **G2** glasses (576×288 BLE HUD + touchpad + mic), with a companion
phone panel. **Read `README.md` first** — it has the full architecture, the
controls table, the permission-answering contract, and deploy steps. This file is
just the operating notes and the sharp edges.

Ship model: the client is distributed as a prebuilt `.ehpk`; the bridge runs on
any host that is logged in to Claude Code. So no secrets may ever be REQUIRED at
build time — the panel's Settings card (runtime settings in localStorage, layered
above the baked `VITE_*` values in `config.ts`) is the end-user config path.

## The rules that matter

1. **The bridge adds no Anthropic code.** `server/rc_bridge.py` reuses
   `claude-rc-api`'s `RemoteControlClient` and layers on only: the *active +
   connected* filter, a bearer/CORS guard, and `control_response` builders for the
   two blocking flavors — tool-permissions (`build_permission_answer`, allow/deny)
   and questions (`build_dialog_answer`, `status` + per-kind `result`). Session
   control and streaming live in `claude-rc-api` (checked out at `../claude-rc-api`).
   Don't reimplement them here.

2. **Only-active, always.** The app surfaces and steers *only* sessions that are
   `active` **and** `connected`. The bridge filters server-side and every control
   action re-checks; a `409` (`BridgeError.isInactive`) means "gone" → toast +
   back to the list. Never act on an inactive session.

3. **On the glasses, lean on the firmware — don't fight it.** The HUD is built
   from the SDK's *native* widgets (`glasses.ts`), modeled on the
   **`nickustinov/demo-app-g2`** reference app — its "Text: basic" screen is the
   gold-standard native smooth-scroll the session view imitates. The cardinal rule
   for smooth scrolling: **never `rebuildPageContainer` while a body is being
   scrolled** — it resets the native scroll position. Steady-state changes are
   per-container `textContainerUpgrade`s (header / body / footer diffed
   independently); a full rebuild happens only when the layout KIND changes or a
   native list's items do.

## Layout

```
server/                 the bridge — a pip/uv package: claude-remote-bridge
  claude_remote_bridge/bridge.py  the JSON+SSE server (active-only) over claude-rc-api
  rc_bridge.py          dev shim (python3 server/rc_bridge.py; sys.path bootstrap)
  pyproject.toml        console script + a DIRECT GIT URL dep on claude-rc-api
                        (uvx-from-repo needs it; PyPI would reject it — see README)
scripts/prepack.mjs     pack-time manifest generator → app.local.json (gitignored)
assets/                 24×24 monochrome app icons for the Even Hub listing (+10× preview)
src/
  main.ts               App state machine, EvenHub event routing, stream lifecycle,
                        the session live⇄history scroll model, layout() builders
  glasses.ts            576×288 renderer: 3 native layouts (text / list / scroll),
                        per-container in-place upgrades, and the HUD safe-glyph set
  config.ts             config: runtime settings (localStorage) → VITE_* → defaults
  ui.ts                 companion browser panel (full-Unicode WebView — see gotchas),
                        incl. the Settings card that edits the runtime settings
  rc/{types,client,stream}.ts   bridge contract, typed fetch wrappers, SSE wrapper
  events/{log,format}.ts        rolling de-duped log + windowing; one event → HUD line
  input/{compose,voice}.ts      Compose/Model/Mode menu model; mic→Deepgram dictation
  stt/deepgram.ts               streaming STT (borrowed from g2-live-captions)
app.json                Even Hub manifest (g2-microphone + network whitelist)
```

## Gotchas

- **The firmware font has NO emoji and NO dingbats.** It's ASCII + Latin-1 +
  arrows + box-drawing + blocks + *some* geometric shapes + a few symbols. So
  `✓ ✗ ⚠ ⚙ 🎤 🗄 ⎋ ⌫ … › •` all render as **nothing**. Every HUD glyph must come
  from the `HUD` set in `glasses.ts` (`● ○ ! ◆ ◇ ☉ » ▶ ■ ← ·`). Ground truth for
  the supported set: the `nickustinov/even-g2-notes` repo (`docs/display.md`).
- **`ui.ts` is exempt** — the panel is a normal browser WebView, so rich glyphs
  are fine and *intended* there. It also formats events itself, independently of
  `events/format.ts` (which is HUD-only). Don't "fix" the panel's glyphs.
- **Native text scroll is boundary-only.** A text container with
  `isEventCapture:1` whose content overflows is scrolled smoothly by the firmware;
  the app only receives `SCROLL_TOP`/`SCROLL_BOTTOM` at the ends, never mid-swipe.
  The session view exploits this: a small auto-following **live** tail, and a
  frozen multi-screen **history** window (`EventLog.tailWindow/windowBefore/
  windowFrom`). Do not reintroduce software page-flipping.
- **The firmware renders text TOP-aligned and never auto-scrolls to the bottom.**
  So a live tail that overflows its container height hides exactly the newest
  lines — "live" silently freezes. The tail (`EventLog.tailRows`) is therefore
  budgeted by estimated visual ROWS (`LIVE_BODY_ROWS` × `HUD_CHARS_PER_ROW`,
  wrapping counted, spacer lines skipped, an oversize newest line tail-clipped) so
  it ALWAYS fits; a byte budget alone can't guarantee that (blank lines are 1 byte
  but a full row; long lines wrap). Every session opens on this tail (`● live`
  running / `○ latest` idle); scroll-up enters the history windows.
- **Content caps are BYTES, not chars.** The firmware validates a text container by
  its UTF-8 **byte** length (~1000 for a (re)build, ~2000 for an upgrade; the
  simulator enforces a stricter **999**), and HUD glyphs are 2–3 bytes each — so a
  1000-*char* body can be ~1500 bytes and get **silently dropped** (the rebuild
  no-ops and the screen just freezes). `glasses.ts` byte-clamps every body
  (`BODY_BYTE_CAP`) and checks the rebuild/upgrade return value; the log packs its
  windows by byte length (`LIVE_BODY_BYTES` / `HISTORY_WINDOW_BYTES`). Never size a
  body by char count.
- **Two kinds of blocking control, two screens — BOTH native lists now.** A
  `control_request` that blocks the turn is either a **tool-permission** (the
  `permission` screen — a native `[Allow, Deny]` list you scroll + tap to pick,
  Allow=row 0 so a quick tap still allows; answered via `/permission`) or a
  **question** (the `question` screen, a native option list you scroll + tap to
  pick; the trailing `← Dismiss` row cancels outright via `/dialog`). On BOTH,
  **dbl-tap SETS THE PROMPT ASIDE** (see the set-aside note below; it sends
  nothing). The permission screen was a `scroll` layout (tap=ALLOW/dbl=DENY) until
  v0.8.0 — it became a list so it, too, has a no-commit escape; the full unclipped
  tool input now lives only on the panel (the HUD header shows tool + an 88-char
  clip). **Sharp edge, CONFIRMED live
  (2026-07-16):** `AskUserQuestion` — the question you actually hit — is delivered
  as a **`can_use_tool`** whose `input` holds the `questions`, *not* a
  `request_user_dialog`. So `/dialog` answers it on the PERMISSION path:
  `build_question_answer` sends an `allow` with `updatedInput.answers` — a map
  **keyed by question TEXT** → chosen label (list for multi-select); an empty map
  is the graceful "did not answer" dismiss, and `updatedInput` must echo
  `questions` or the tool crashes ("Cannot destructure property 'questions'").
  `isQuestionRequest` (in `events/format.ts`) is the discriminator (subtype
  `can_use_tool` with parsed `questions`, or `toolName === "AskUserQuestion"`); the
  bridge parses the payload into `permissionRequest.questions`. The old
  `{status, result}` shape (`build_dialog_answer`) is UNCONFIRMED, kept only as a
  fallback for the rarer true `request_user_dialog` / `side_question` kinds —
  confirm that one against a live sample before trusting it.
- **Blocking prompts QUEUE; they never hijack.** Stale/replayed `control_request`s
  were the old "random old questions" bug — three guards now exist: (1) the bridge
  fetches history `desc` (the NEWEST `limit` events) so the stream resume cursor is
  never ancient; (2) `EventLog.append` freshness (seq dedupe) gates ALL UI
  side-effects in `onSessionEvent`; (3) prompts live in a FIFO (`prompts[]` +
  `answeredIds`) and auto-retire on a matching `control_response` in the stream
  (our own answers echo back too — CONFIRMED live 2026-07-16, seq order:
  `control_request` → assistant tool_use → `control_response` → tool_result user →
  `result`), on the turn's `result`, or via the poll safety-net when the session
  leaves `requires_action`. **An assistant event after a `control_request` does
  NOT mean it was answered** (the tool_use block follows the request while still
  blocked). Presentation: shown immediately only when passively watching the live
  tail; in Compose/submenu/voice/history-scrollback it defers (panel toast +
  footer `! needs you`) and presents on return to the session view. A blocked
  session opens straight onto its prompt (`findPendingControl` over history,
  cross-checked with `workerStatus === 'requires_action'`).
- **"Answer later" = a STICKY defer (`promptSnoozed`).** A dbl-tap on EITHER the
  `question` or the `permission` screen calls `snoozePrompt()`: it marks the armed
  prompt `promptDeferred + promptSnoozed` and drops to the live tail WITHOUT
  answering (nothing hits `/dialog` or `/permission`). The snooze flag is the ONE difference from a normal
  defer: the auto-present guards in `go('session')` and `enterLive()` both carry
  `&& !promptSnoozed`, so returning to live no longer yanks the wearer back into
  it (an ordinary deferral still does). It reopens only deliberately — the
  Compose menu's leading `! Answer question` / `! Review permission` row (present
  whenever `permEvent` is set), or reopening the session (which re-detects the
  pending control from history). It clears on `presentPrompt`/`armPrompt`/
  `clearPromptState`, and the prompt still retires normally (answered elsewhere,
  turn `result`, or the poll safety-net) while set aside. Because the Compose
  list now VARIES with pending state, it is snapshotted into `composeItems` on
  entry so a mid-menu stream event can't desync the firmware row → action map.
- **Exactly one `isEventCapture:1` container per page** (the scroll/tap target).
- **Gesture events are messy:** they arrive as `listEvent` **or** `textEvent`
  **or** `sysEvent` — coalesce all three. `CLICK_EVENT` is `0`, which protobuf
  drops, so a tap arrives as `eventType === undefined`. IMU frames are ignored.
- **Deepgram key lives in `.env.local`** (gitignored; on the author's box it's
  shared with `g2-live-captions`, same `VITE_DEEPGRAM_API_KEY` var); voice
  auto-disables when blank.
- **Secrets layer, runtime wins.** `config.ts` reads panel-saved runtime settings
  (`claude-remote.settings` in localStorage) above the `VITE_*` values Vite baked
  in from `.env.local`, and the panel's Settings card saves + `location.reload()`s
  to apply. So a build with an empty `.env.local` is fully configurable after
  install — and when debugging "why is it using THAT bridge/token", check
  localStorage before the env. Never make a `VITE_` secret required at build time.
- **OAuth rotation is handled in `claude-rc-api`, not here.** The long-running
  bridge used to die with `invalid_grant` when another process rotated the
  (single-use) refresh token; `RemoteControlClient` now reloads
  `~/.claude/.credentials.json` from disk before/after a failed refresh (see its
  `_reload_credentials`, with tests). Don't add credential logic to the bridge.
- **The bridge reads `.env.local` too** (`RC_BRIDGE_*` keys, and
  `VITE_BRIDGE_TOKEN` doubles as the token; CWD first, then the repo checkout) —
  CLI flags and process env win. With no token configured anywhere it
  GENERATES one and persists it to `~/.config/claude-remote/bridge-token`
  (`--open` is the only unauthenticated mode). One file configures both sides;
  `npm run bridge` needs no inline env. The end-user path is
  `uvx --from "git+…g2-claude-remote#subdirectory=server" claude-remote-bridge` —
  the startup banner prints the LAN + Tailscale URLs and the token to pair the
  panel's Settings card with.

## Build / run / verify

```bash
npm run dev                                   # dev server → 0.0.0.0:5175
npm run bridge                                 # bridge → 0.0.0.0:8790 (token from .env.local; needs claude_rc importable)
npm run bridge:uv                              # same, through ../claude-rc-api's uv env (use this on the box)
browser-test http://localhost:5175             # headless: panel + app logic (no glasses/mic; this box's helper)
npm run pack                                    # build + prepack → claude-remote-<version>.ehpk
npx @evenrealities/evenhub-cli qr --url http://<box>.ts.net:5175   # sideload QR (prints in terminal)
```

- **Bump the version on every change.** Bump `version` in **both** `package.json`
  and `app.json` (keep them identical) for any code/manifest change — `npm run pack`
  stamps it into the artifact name (`claude-remote-<version>.ehpk`) and syncs the
  packed manifest's version from `package.json` via `scripts/prepack.mjs`, so every
  `.ehpk` is traceable. Current: **1.0.0**.
- **`pack` packs `app.local.json`, not `app.json`.** The tracked manifest stays
  generic (whitelist carries `"*"` + localhost + Deepgram); prepack folds your
  `.env.local`'s bridge host (+ `VITE_NET_WHITELIST_EXTRA`) into the gitignored
  `app.local.json`. Whether the phone honors the `"*"` wildcard is UNVERIFIED on
  hardware — until confirmed, a repack with the real bridge URL in `.env.local`
  is the safe path. Note the `package_id` changed to
  `com.thatcrispytoast.clauderemote` in 0.9.0 (was `…rcg2`) — the glasses treat
  it as a NEW app; uninstall the old one after sideloading.
- **The simulator DOES run headlessly here** (the old "needs a GUI we lack" note was
  wrong). `@evenrealities/sim-linux-x64` is a GTK/WebKit binary: put its libs on
  `NIX_LD_LIBRARY_PATH` from nix (this box has `programs.nix-ld` enabled) and run it
  under `xvfb-run`. Launch with `--automation-port 9898` and drive it over HTTP —
  `GET /api/screenshot/glasses` returns the exact **576×288** framebuffer,
  `POST /api/input {"action":"up|down|click|double_click"}` sends touchpad gestures,
  `GET /api/console` reads the webview logs. That's pixel-exact on-glass verification
  with no hardware. Gotchas: the sim caps text containers at **999 bytes**; Vite HMR
  does **not** reload the entry module, so **relaunch the sim after each edit**; and
  every session opens on its newest tail (`● live` running / `○ latest` idle).
  `browser-test` still covers the panel; QR-sideload real hardware for the mic +
  true native scroll.
- **Bridge-absent = panel-only mode.** In a plain browser / `browser-test` the
  Even bridge never appears, so the glasses/gesture/mic paths are skipped and the
  session list + stream + steering all still work through the panel.
- **Git: this repo is PUBLIC** — origin is
  `github.com/ThatCrispyToast/g2-claude-remote` (published 2026-07-16 as a single
  squashed root commit; `claude-rc-api` was published the same way). Everything
  committed here is world-readable: never commit tokens, tailnet hostnames/IPs,
  or personal paths (`.env.local` / `app.local.json` / `*.ehpk` / `*.log` are
  gitignored for exactly that reason). The local-only
  `backup/pre-publish-history` branch holds the pre-squash history and must
  NEVER be pushed; the old private `rc-g2` GitHub repo still exists and must
  stay private. No auto-push — commit + push manually (as `server`) when asked.
- **Releases:** `claude-remote-1.0.0.ehpk` (packed CLEAN, with `.env.local` set
  aside) is the published artifact — delivered for the Even
  Hub submission, along with `assets/icon.png` / `icon-white.png` (24×24
  monochrome, spark-over-glasses). A pack made WITH `.env.local` present bakes
  your token/keys in — personal builds only, never distribute one.
