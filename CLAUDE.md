# CLAUDE.md — Claude Remote

Steer active Claude Code Remote Control sessions from Even Realities G2 glasses
(576×288 BLE HUD + touchpad + mic), with a companion phone panel. `README.md`
has the architecture, controls, and project layout; this file is the operating
notes and sharp edges.

Ship model: the client is distributed as a prebuilt `.ehpk`; the bridge runs on
any host logged in to Claude Code. Builds carry NO configuration at all — every
pack is a distribution pack — so the panel's Settings card (runtime settings in
localStorage) is the end-user config path, and no secret may ever be required
at build time.

## Rules

1. **The bridge adds no Anthropic code.** It reuses `claude-rc-api`'s
   `RemoteControlClient` (checked out at `../claude-rc-api`; the bridge needs
   ≥ 0.5.1 and exits with a `--refresh` hint on an older one) and layers on
   only the active+connected filter, a bearer/CORS guard, and the JSON shaping
   for the app. Session control, prompt answers (`respond_permission` /
   `answer_question`), side questions, streaming, and OAuth (including
   rotated-token reload) live in `claude-rc-api` — don't reimplement protocol
   or credential logic here.
2. **Only-active, always.** Surface and steer only sessions that are `active`
   **and** `connected`. The bridge filters server-side and every control action
   re-checks; a `409` (`BridgeError.isInactive`) means "gone" → toast + back to
   the list. Never act on an inactive session. The list call must ask for
   `statuses="active"`: an unfiltered page is the account's 20 newest sessions,
   ARCHIVED INCLUDED, so until bridge 0.5.0 a long-running session fell off the
   glasses once enough newer ones had been archived (found live 2026-11-10: 6
   of 7 listed).
3. **Lean on the firmware — don't fight it.** The HUD uses the SDK's *native*
   widgets (`glasses.ts`), modeled on the `nickustinov/demo-app-g2` reference
   app. Never `rebuildPageContainer` while a body is being scrolled — it resets
   the native scroll position. Steady-state changes are per-container
   `textContainerUpgrade`s (header / body / footer diffed independently); a full
   rebuild only when the layout kind or a native list's items change.
4. **The server assigns message origin.** From about Claude Code 2.1.220,
   claude-rc-api 0.2.1's platform header helped older workers run controller
   messages. On 2026-11-19 a 2.1.328 test worker received library sends
   without a `client_platform`. It called the sender “the peer session” and
   spent a model turn declining `/context`. Permission and question answers,
   side questions, mode, effort and interrupt worked on that worker.
   App 1.11.0 offers local context/usage shortcuts and a phone link to the
   session in Claude for human-authored messages and supported slash commands.
5. **Effort is a control, with a command fallback.** 2.1.301 workers apply
   the `apply_flag_settings` control (`effortLevel` low…`max`, null = auto)
   **session-scoped**, persisting nothing, and re-emit `system/init` with the
   new `effort` (verified live 2026-10-16). Workers through at least 2.1.212
   REFUSED it, so claude-rc-api's `set_effort(wait=…, command_fallback=True)`
   waits for the verdict and falls back to injecting `/effort <level>` — which
   **also saves that level as the machine's default for the model** (CLI
   semantics). The bridge's response `via` says which path ran, and the app's
   toast says so when it was the command. The current effort is real now:
   `workerState.effort` (events) → the session's `effort` (metadata) → the
   last level applied from this app (`effortBySid`, for workers too old to
   report it).
6. **The live settings come from events, not the session object.** The
   session object has NO permission mode (`permissionMode` is always null);
   `system/init` / `system/status` carry `model` / `effort` / `permissionMode`,
   surfaced by the bridge as `RcEvent.workerState` and merged by main.ts
   (`noteEvent` — a status event carries only the mode, so its nulls must never
   erase the model or effort). The header, the Mode / Effort marks, and the
   panel selects all read the merged state. Unknown stays blank: never guess
   `default` (the pre-1.8.0 header claimed `default` for every session).

## Commands

```bash
npm run dev          # app dev server → 0.0.0.0:5175
npm run bridge       # bridge → 0.0.0.0:8790 (config from .env.local)
npm run bridge:uv    # bridge through ../claude-rc-api's uv env (sibling checkout)
npm run pack         # env-free build + version check → claude-remote-<version>.ehpk
npx @evenrealities/evenhub-cli qr --url http://<host>:5175   # sideload QR
python3 scripts/mock-bridge.py   # fictional sessions → localhost:8791 (any token)
```

- **Bump `version` in both `package.json` and `app.json`** (kept identical) on
  every code/manifest change — `pack` stamps it into the artifact name, and
  `scripts/check-versions.mjs` fails the pack if the two drift.
- **`MODELS` in `config.ts` is the only model list** (the bridge passes ids
  straight through). Refresh it when a model ships: one row per tier, ids
  checked against live sessions. A session on a model the list lacks still gets
  its own marked row (HUD) / option (panel), so a stale list never shows
  nothing, or the wrong model, as current.
- **Every pack is a distribution pack.** `pack` packs the tracked `app.json`
  verbatim, and the build resolves NO `VITE_*` vars (`envPrefix` is swapped to a
  never-matching prefix for `vite build` — see vite.config.ts), so `.env.local`
  never enters an artifact: no keys, no tokens, no personal hosts. There is no
  personal-pack flavor; `VITE_*` vars affect `npm run dev` only. Connectivity
  therefore rides `app.json`'s `"*"` network-whitelist entry (whether phones
  honor the wildcard is unverified on hardware — there is no per-host whitelist
  folding anymore).
- **Every URL the bundle references must ALSO be whitelisted by name.** Even
  Hub review scans the bundle and rejects a URL its whitelist doesn't list,
  `"*"` notwithstanding — even a plain link the app never fetches (1.11.0 was
  rejected 2026-11-20 for the panel's `https://claude.ai/code/…` session link).
  Before a pack, list them: `grep -aohE "(https?|wss?)://[^\"'\` ]+" -r dist`.
  The notice's GitHub URL (in a shell command) and the SVG namespace
  `http://www.w3.org/2000/svg` were in that same bundle and weren't flagged.
- **The simulator runs headlessly.** `@evenrealities/sim-linux-x64` is a
  GTK/WebKit binary: run under `xvfb-run` (on NixOS, put its libs on
  `NIX_LD_LIBRARY_PATH` via nix-ld) with `--automation-port 9898`, then drive it
  over HTTP: `GET /api/screenshot/glasses` (the exact 576×288 framebuffer),
  `POST /api/input {"action":"up|down|click|double_click"}`, `GET /api/console`.
  Relaunch after every edit — Vite HMR does NOT reload the entry module. The sim
  caps text containers at 999 bytes. Real hardware is still needed for the
  glasses' own mic and true native scroll.
- **Dictation runs end to end in the simulator.** It records the host's
  default audio input (or `--aid <device>`), so speech played into a virtual
  device reaches Deepgram (dictation was checked this way in `de` and `en`,
  2026-10-28). Three traps:
  - It opened a PulseAudio-backed ALSA device as **u8**, the first format that
    device lists, and garbled the samples into noise. Give it an S16-only
    device.
  - On Linux, `wss://` needs glib-networking's GIO TLS module on
    `GIO_EXTRA_MODULES`. Without it every Deepgram connect fails exactly like a
    bad key.
  - A mic the sim can't open is only logged on its stderr (`AudioControl
    error`): `audioControl(true)` resolves `false`, which the app doesn't
    check, so it shows `● Listening` over silence. (What a real Even App
    returns there is unverified, so the app doesn't act on it yet.)

  The sim keeps the SDK's `set/getLocalStorage` in memory only, while WebKit
  localStorage persists in its profile. That is the reverse of the Even App,
  so the eviction + hydration path can't be reproduced in it. Test that one
  with a stubbed host in a browser.
- **Point the simulator at the mock bridge, never a real one.** Run the dev
  server with `VITE_BRIDGE_URL=http://localhost:8791 VITE_BRIDGE_TOKEN=x` (process
  env beats `.env.local`). A tap on a real session list can fire into a live
  session, and `assets/store/` must never show real session names — the repo is
  public. The mock pins and unpins, and pings like the real bridge. The store
  shots are staged this way: `--question` blocks
  payment-service on an AskUserQuestion instead of a Bash permission, and a long
  `VITE_QUICK_SENDS` text stages the confirm screen.
- **No Even App (plain browser) = panel-only mode** — the SDK's bridge object
  still initializes, but with no Flutter handler its native calls come back
  empty (`postMessage: Flutter handler not available`), so the glasses/gesture/
  mic paths do nothing; the session list, stream, and steering still work via
  the panel.

## HUD gotchas

- **The firmware font has NO emoji and NO dingbats** (`✓ ✗ ⚠ ⚙ … › •` render as
  nothing). Every HUD glyph must come from the `HUD` set in `glasses.ts`
  (`● ○ ! ◆ ◇ ☉ » ▶ ■ ← ·`). Ground truth: `nickustinov/even-g2-notes`
  (`docs/display.md`). **`ui.ts` is exempt** — the panel is a real browser
  WebView; rich glyphs there are intended, and it formats events itself
  (independently of the HUD-only `events/format.ts`). Don't "fix" it.
- **Text beyond Latin-1 is untested.** Per the same notes (simulator-tested;
  "real hardware may differ") the font has printable ASCII + Latin-1 nearly
  complete, so German/Spanish/Italian/Portuguese/Dutch/Nordic dictation reads
  back intact on the confirm screen, and French nearly so: `œ`/`Œ` sit outside
  Latin-1, as does `€` in any language. Past that they document only symbol
  blocks and some CJK;
  other scripts (Polish `ł`, Cyrillic, Greek, …) are unverified, and any glyph
  the firmware lacks is skipped silently. The message still sends intact and
  the panel shows it fine — a HUD readback limit, not a dictation bug.
- **Native text scroll is boundary-only.** A text container with
  `isEventCapture:1` is scrolled smoothly by the firmware; the app only sees
  `SCROLL_TOP`/`SCROLL_BOTTOM` at the ends. The session view exploits this: an
  auto-following **live** tail + frozen multi-screen **history** windows
  (`EventLog.tailWindow/windowBefore/windowFrom`). Do not reintroduce software
  page-flipping.
- **The firmware renders text TOP-aligned and never auto-scrolls**, so an
  overflowing live tail hides exactly the newest lines. The tail
  (`EventLog.tailRows`) is budgeted by visual ROWS (`LIVE_BODY_ROWS`, each
  line's wrapping measured with the font widths: `bodyRows`) so it always fits —
  a byte budget alone can't guarantee that. A flat 40 chars per row left one or
  two rows empty, since most lines hold about 60. Every session opens on this tail (`● live` running /
  `○ latest` idle, `! waiting` on a prompt; the tag leads the header);
  scroll-up enters history. A line that doesn't fit whole
  gives its END to the rows left, cut at a word and keeping its lead glyph
  (`...a broken link to the install page.`, `» ...ending here`). Until 1.10.0
  only the newest line did, so a finished turn showed `◇ done` under four empty
  rows and none of the answer.
- **Consecutive tool_uses COLLAPSE into chain lines — never one line each.**
  Measured on live sessions: ~6 tool calls per line of assistant prose, in runs
  of up to 27, and one verbose `◆ Name  <input>` line each (a long path or shell
  command) wrapped to 4 of the 6 live rows, so the HUD showed two tool calls and
  none of the narration. Now `format.ts` squeezes each tool to a `Name arg`
  ENTRY (`toolChainEntry`) and packs a run into one-row `◆ a, b, c` lines
  (`packToolChain`), folding consecutive identical entries to `entry xN`. Two
  rules keep it working: only CRISP args earn the slot (a command's program, a
  path's basename, a pattern, a URL host — never `description`/`prompt`/`query`,
  which blow the width AND, differing every call, defeat the `xN` fold); and
  `EventLog` owns the run, because `renderEventParts` is per-event and can't see
  neighbours. **An event that renders to nothing must NOT break the chain** — a
  `tool_result` echo lands between every pair of tool_uses, so breaking on it
  makes every chain exactly one tool long. Only real content (prose, a result, a
  prompt) closes it. The chain re-packs its block IN PLACE on each new tool, and
  only ever rewrites tail lines so frozen history-window indices stay valid.
- **Workers persist a fresh `system/init` on EVERY controller attach AND every
  model / mode / effort change — it's a settings snapshot.** The panel renders
  it as one (`◆ opus-5-5 · max effort · bypass`, via `settingsLine`) and folds
  repeats; the HUD renders nothing for it, since the session view's header
  shows the live settings (and a `result` is a bare `◇ done`, its turns and
  cost left to the panel).
  Confirmed live (2026-08-21 and 2026-10-16, raw wire data): each claude.ai open
  of a session sends an `initialize` control_request (often twice), and the
  worker's reply mints one or two `system/init` events — same CLI `session_id`,
  distinct uuids, no `/clear` or compact involved — plus a burst at process
  start. So an idle session's newest events are often nothing BUT inits, which
  used to render as a wall of `☉ session started` lines filling the live tail
  (checking a session from the phone literally built the wall). An older bridge
  sends no `workerState`, so the line falls back to `session started`.
  Both surfaces fold a run of identically-rendered simple rows in place:
  `line xN` in `EventLog.append` (tail-line rewrite only, so frozen
  history-window indices stay valid), `row ×N` in the panel's `appendNode`;
  conversation bubbles / tool blocks never fold. The fold keys on the RENDERED
  line being identical — an init that differs (e.g. after a model switch) still
  gets its own row, which is signal. Don't narrow it to init-specific
  suppression.
- **Not every `user` event is a message.** The worker writes notes into the
  user slot: a finished background task's `<task-notification>` block (ids, an
  output path, a `<summary>`), and `[Request interrupted by user]`.
  `workerNotes` (`events/format.ts`) turns each into one system line on both
  surfaces
  (`☉ Background command "…" completed (exit code 0)`). Raw, the block filled
  the HUD with tag soup under a `»`, as if the wearer had said it. `workerNotes`
  returns one line per block (several can share an event) and drops what
  follows them, which is addressed to the model.
- **A list's header strip is one line unless the layout asks for more**
  (`headerRows`, up to 3; `glasses.ts` grows the strip and shrinks the list).
  Only the prompt screens ask: a strip overflowing its height gets a scrollbar
  and a half-cut second line, which is how a long permission command used to
  read. The height is part of the list's rebuild signature. `fitHeader`
  (main.ts) clips the text to what the rows hold, MEASURED: `glasses.ts` has
  the firmware font's advance widths (`textWidth`, `stripRows`; taken from
  the simulator, 24-glyph runs, within 2% on known lines). The font is
  proportional — `l` is 4 px, `m` 16 — so a strip holds 56 chars of one text
  and 64 of another, and a char budget either cut a header short above an
  empty row or let it spill. The backtick has NO glyph (`hudSafe` folds it to
  `'`). A permission's header leads with its most telling
  input (`headerInput`); a file path too long for a row keeps its END, from a
  directory boundary (`.../Dashboard/Widget.tsx`), since the file is what is
  being asked about.
- **Content caps are BYTES, not chars** (~1000 per rebuild, ~2000 per upgrade,
  999 in the simulator; native lists: 20 rows, ~63 bytes per item), and HUD
  glyphs are 2–3 bytes each — an oversize container is **silently dropped** (the
  screen just freezes). `glasses.ts` byte-clamps every body (`BODY_BYTE_CAP`)
  and list item (`MAX_ITEM_BYTES`); the log packs windows by bytes
  (`LIVE_BODY_BYTES` / `HISTORY_WINDOW_BYTES`). Never size anything by chars.
- **A failed/hung write must invalidate the display mirror.** `glasses.ts`
  commits its per-container "what's on screen" state only when the SDK call
  returns `true`, races every call against a timeout (a BLE call that never
  settles would wedge the serialized pump and freeze the HUD for good), and on
  any failure forgets the page so the next render repaints from scratch. Don't
  "optimize" the mirror updates back to unconditional. The startup page is
  raced too: `init()` stops waiting after the timeout so boot carries on (the
  panel needs no HUD), renders queue behind it, and a page that lands late
  paints the newest one.
- **A list rebuild resets the firmware highlight to row 0 — resync or misfire.**
  The app's `listSelectIndex` mirrors the firmware's highlight, but taps on row
  0 arrive with `currentSelectItemIndex` protobuf-dropped, so a stale index
  fires the WRONG row (opens the wrong session, wrong menu action, Deny instead
  of Allow). `GlassesDisplay.onListRebuild` fires after every full list build and
  main.ts resets the index there; when a tap carries no index, the row is
  resolved from `currentSelectItemName` against `GlassesDisplay.listItems`. Keep
  both paths when touching list code — this bug class was reproduced live
  (tapping "Dictate" opened the Commands submenu).
- **The session list is sorted pins-first, then by title, client-side.** The
  bridge orders by recent activity, which churns every poll — each reorder is a
  rebuild that yanks the highlight to the top and re-routes the next tap. Don't
  surface the bridge's order on a native list. A pin (claude.ai/code's, the
  `ui:pinned` tag; `*` on a HUD row, `pinned` on a panel row) moves only when
  someone moves it, so it is as stable as a title. Compose → Pin / Unpin and
  the panel's button set it through `POST …/pin`; both show only when the
  bridge reports `pinned` (0.5.0+).
- **Message screens are `scroll` layouts, not one text block.** Setup, error,
  and the empty list pin their title and gesture hint in the header / footer
  strips. As a single full-screen container (until 1.9.0) the error screen's
  divider rules wrapped and pushed `tap retry` below the fold.
- **Most screens have an image strip on top** (`StripLayout` over a text
  body, `StripListLayout` over a native list; `src/strip-image.ts`): the "CR"
  mark and two boxes of two lines each, in a 13 px light canvas font, 38 px
  tall, where a firmware-font text strip holds one line in 42. The session
  view's body gets 8 rows instead of 6. `withStrip` (main.ts) converts the
  list, menus and every header-and-footer screen; prompts keep their taller
  text headers, and `promptTapOk` reads `layout()`, so they must stay `list`s.
  - An image is at most 288 px wide, so the strip is drawn whole (text may
    cross the seam) and cut into two halves; a half is sent only when its
    pixels changed.
  - Images are created empty in the rebuild and filled with
    `updateImageRawData` as raw greys, one byte per pixel (the host converts
    to 4-bit; black is off). PNG worked too, but its asynchronous encode
    stalled updates for up to 4 s on the phone (measured 2026-11-23); raw
    greys draw in 30-130 ms and send in about 0.2 s per half.
  - A newer layout waiting in the queue stops a strip before its next image
    send, so a transcript or status is never held up behind an image.
  - Two failed image updates in a row switch `imageStrips` off for the run and
    every screen falls back to its text header and footer.
- **Exactly one `isEventCapture:1` container per page** (the scroll/tap target).
- **Root-page exit MUST be `shutDownPageContainer(1)`** (the system exit-confirm
  dialog) — Even Hub review REJECTS a mode-0 immediate exit on the root page
  (rejection received 2026-07-22; see hub.evenrealities.com/docs/ship/app-submission,
  which also floors `min_sdk_version` at 0.0.12). Because the user can cancel
  that dialog, `exit()` must NOT tear anything down — cleanup belongs to
  `SYSTEM_EXIT_EVENT` / `beforeunload` only. The simulator doesn't render the
  dialog (it just blanks the glasses page); the confirm layer is only visible
  on hardware via a beta build.
- **Gesture events are messy:** they arrive as `listEvent` OR `textEvent` OR
  `sysEvent` — coalesce all three. `CLICK_EVENT` is `0`, which protobuf drops,
  so a tap arrives as `eventType === undefined`. IMU frames are ignored.

## Blocking prompts

- **Only the WORKER's prompts block.** `isBlockingControl` comes from
  claude-rc-api: a `can_use_tool` / `request_user_dialog` control_request whose
  envelope `source` isn't `client`. Controllers' own requests (a side question
  from this app or claude.ai's "btw", a `get_context_usage`…) echo through the
  stream as control_requests too; before claude-rc-api 0.3.0 a `side_question`
  was misread as a blocking question and would have popped a bogus question
  screen.
- **Two kinds, two screens, both native lists.** A blocking `control_request`
  is either a **tool-permission** (the `permission` screen: `[Allow, Deny,
  Details]`, Allow=row 0; answered via `/permission`) or a **question** (the
  `question` screen: the options, `Submit` for a pick-any, `Details`, and a
  trailing `← Dismiss` row; answered via `/dialog`). On BOTH, double-tap **sets
  the prompt aside** (sends nothing — see below).
- **`Details` is how a prompt is read before it is answered.** The header
  holds two rows of a permission's input (three of a question); the `detail`
  screen is a natively-scrolled body with all of it — the whole command, a
  plan, a question with every option's description — clamped at `DETAIL_BYTES`
  with a pointer to the phone past that. It decides nothing: tap or double-tap
  goes back to the list. Its text is fixed on entry, and it counts as "on the
  prompt" (`onPromptScreen()`), so a prompt settled elsewhere still leaves it.
- **A prompt's list takes no tap until it is ON THE GLASS, and has been for
  `PROMPT_TAP_GUARD_MS`** (`promptTapOk()`). The app switches screens when the
  event arrives; the glass repaints a BLE round trip later. A tap already on
  its way (meant as "menu" on the live view, the second of two on a list row,
  a second Allow as the next prompt slides in, a second tap leaving Details)
  landed on row 0 of a prompt nobody had read, which is Allow. The test is the
  display's own mirror, not a timer started at the state change:
  `GlassesDisplay.showsList(layout)` is true only once the build of exactly
  this list has come back from the SDK, and `onListRebuild` stamps when. Every
  change to a prompt's list is a rebuild (it presents, the next question
  follows, a pick-any toggles), so one test covers them — which is why a
  prompt's layout carries a `key` (its `requestId`, plus the question index):
  two prompts both read `Allow / Deny / Details`, and without the key the
  second was a header upgrade on the first one's page. A list whose write was
  dropped takes no tap until `poll()`'s render repaints it.
- **`poll()` re-renders every tick, on every screen.** A no-op while the glass
  matches (the display diffs each container), and the repaint after a dropped
  write. Before 1.10.0 only the session list did; any other screen whose write
  failed stayed wrong until something else changed it.
- **A pick-any question toggles; Submit settles it.** `multiSelect` options
  carry `●` / `○`, each tap rebuilds the list (highlight back to row 0, so
  Submit sits BELOW the options: a stray tap re-toggles, never submits), and
  `qDone[i]` — not "has a pick" — says a question is settled. The Submit row
  appears with the first pick, so no row does nothing. Until 1.10.0
  every question took one pick and moved on. The answer goes as ONE
  comma-separated string in the question's own order: the tool's schema is a
  string per question ("multi-select answers are comma-separated"; verified
  live on 2.1.328, `"…"="Apple, Cherry"`). main.ts joins it, so an older
  bridge, which would have sent a list, gets it right too. The panel has the
  same toggle and a `Done` button.
- **`AskUserQuestion` arrives as a `can_use_tool` permission** (confirmed live),
  NOT a `request_user_dialog`: its `input` carries the `questions`, and `/dialog`
  answers it on the PERMISSION path — claude-rc-api's `answer_question` sends
  an `allow` whose `updatedInput` echoes `questions` (the tool crashes without
  it; the bridge's `_question_input` rebuilds them if lost) plus `answers`, a
  map keyed by **question TEXT** → chosen label (list for multi-select; empty
  map = graceful dismiss). Discriminator: `isQuestionRequest` in
  `events/format.ts`. For a true `request_user_dialog`, direct the wearer to the session in Claude.
  The result schema depends on the dialog kind.
- **Prompts QUEUE; they never hijack.** Three guards against stale/replayed
  requests: the bridge fetches history `desc` (newest events) so the stream
  resume cursor is never ancient; `EventLog.append` seq-dedupe gates all UI
  side-effects; prompts live in a FIFO (`prompts[]` + `answeredIds`) and retire
  on an event that settles them (`settlesPrompt()` in `events/format.ts`: a
  controller's `control_response`, ours included, or the worker's
  `control_cancel_request` when it was answered at the terminal — the bridge
  flags both as `settlesPrompt` since 0.5.0), on the turn's `result`, or via
  the poll safety-net when the session leaves `requires_action`. **An assistant
  event after a `control_request` does NOT mean it was answered.** A prompt
  presents immediately only while passively watching the live tail; otherwise it defers (footer `! needs you`) and shows
  on return to the session view — except a return the wearer didn't make.
  Being backgrounded mid-dictation lands via `leaveVoiceQuietly()` (render,
  not `go`), and a voice error doesn't leave the voice screen at all (see
  Dictation language): a tap meant as "done" there would otherwise answer the
  prompt (reproduced: it allowed a Bash `rm -rf`). A blocked session opens
  straight onto its prompt (`findPendingControls`: every unresolved one, oldest
  first, + `workerStatus === 'requires_action'`).
- **An answer retires its OWN prompt, and only once it got through.**
  `answeredIds` doubles as the in-flight mark, so a second tap while the POST
  is out sends nothing; `retirePrompt(id)` leaves alone whatever else got armed
  meanwhile. (Before 1.9.0 it retired "the armed prompt": with two queued, a
  second tap dropped the next one unanswered and the session sat blocked.) A
  failed answer un-marks the id and leaves the prompt on screen — on the
  glasses, leaving that screen is the only sign an answer landed.
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

## History and the unread mark

- **The newest 200 events are often not the conversation.** Every controller
  attach mints `system/init`s (see HUD gotchas), with `system/status` and the
  control traffic around them. Measured on six live sessions 2026-11-19: four
  had NO transcript in their newest 200 events, the first line of conversation
  sitting 224 to 414 events back, and the app opened them on a lone
  `☉ opus-5-5 · max effort · bypass x98`. The bridge (0.6.0) now reads back a
  page at a time until the window holds `HISTORY_MIN_TRANSCRIPT` events a
  reader would see, stopping at a `conversation_reset` or `HISTORY_MAX_PAGES`.
  It still returns every event in the window, in order: the app's folding,
  cursor and pending-prompt scan need them all. Responses are gzipped for a
  client that takes it (a 340 KB history travels as about 45 KB).
- **Opening a session reads it.** `markRead()` (`POST …/read`) clears the
  unread mark on open and again on each `result` that arrives while it is
  open, as claude.ai does — but only while someone can be looking: the app in
  front on the glasses (`foreground`, from FOREGROUND_EXIT / _ENTER), or, with
  no glasses, the page visible. Best-effort and silent: an older bridge 404s
  it.

## Streams and connection loss

- **Liveness is a chain, and each link redials on silence.** The API sends a
  keepalive about every 15 s; claude-rc-api redials an upstream stream silent
  for 45 s; the bridge passes each keepalive on as an `event: ping` frame (with
  data — EventSource hides comments and drops data-less frames); and
  `rc/stream.ts` gives up on a stream that has pinged and then goes quiet for
  `STREAM_SILENCE_MS`. An older bridge never pings, so its streams are never
  judged by silence. The ping is also how the bridge frees a stream the app
  abandoned: without it each one held a thread and an upstream connection
  until the session's next event (measured: 3 abandoned streams, 3 threads,
  still there 45 s later).
- **Three ways a stream dies without the browser reconnecting it**, all routed
  to `onStreamError`: the bridge's `event: error` frame, a refused open (a
  non-200 leaves the EventSource CLOSED — silently, before 1.9.0), and silence.
  It reopens from `lastSeq` up to `STREAM_MAX_RETRIES` times; after that the
  stream is `streamLost` and each poll the bridge answers tries once more, so
  a long outage heals itself. Meanwhile the session header reads `! offline`
  instead of `● live` (also as soon as a poll fails), and the list header says
  the same.
- **`openStream()` closes any stream first, and `openSession` checks
  `openSeq` after its awaits.** A second tap (or another row, or Back) while a
  session was still loading used to leave two opens running: the first poured
  its history into the second's log, where the seq-dedupe then swallowed the
  right session's events, and its stream was never closed.
- **The connection screens retry themselves.** With the bridge down
  (`connBridge === 'down'`), the poll re-runs `checkAuthAndLoad` from `setup` /
  `error`; any other error waits for a tap. One poll at a time (`polling`), and
  every bridge request has a timeout (`rc/client.ts`) — fetch has none, and a
  bridge that dropped off the network hung them for minutes.

## Side questions ("Ask aside")

- **What it is:** the `side_question` control — claude.ai's "btw". The worker
  answers from its conversation in one model call, without interrupting the
  turn or adding anything to the transcript; a `null` answer means there is no
  conversation yet. Verified live on 2.1.301 (~2–3 s on Haiku); the bridge
  waits up to 150 s (`ASIDE_TIMEOUT_S`), and on timeout claude-rc-api withdraws
  the question with a `control_cancel_request`.
- **No confirm step.** It can't change the session, so canned asides
  (`ASIDE_QUESTIONS`, `VITE_ASIDE_QUESTIONS`) fire on tap and a dictated one
  (voice purpose `aside`) is asked as soon as dictation ends. The send-confirm
  screen stays for real sends.
- **Follow-ups carry history.** The last `ASIDE_HISTORY` exchanges per session
  ride along as `history`, so "and then?" reads in context. `asideSeq` drops a
  late answer to a question that was replaced or whose session was left; a late
  answer still lands on the panel card, never yanking the glasses.

## Session info

- **Mostly free.** The session object's `external_metadata` (polled every
  `POLL_MS` with the list) carries `effort_level`, `context_usage`, the server's
  `post_turn_summary` (`status_detail`, `needs_action`) and the worker's Claude
  Code version; background tasks come live from
  `system/background_tasks_changed`. None of that costs a request.
- **Plan usage + git changes are on demand** (`GET …/info` → `get_usage` +
  `get_workspace_diff`): fetched when the screen opens and on tap = refresh,
  one fetch at a time, never polled — each fetch leaves control
  request/response pairs in the session's event log (hidden on both surfaces,
  but other controllers can see them).
- The header stays one line: title, model, effort, a non-default mode, and
  `ctx N%` once context passes `CTX_WARN_PCT`; the title gets what the tail
  leaves of `HEADER_CHARS` (56 fits the strip in the simulator).

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
  survives only for the panel's Stop button. A second "done" while the first
  is still finishing (mic close + Deepgram flush) is ignored, per dictation
  run (`finishingRun`; a finish a newer run overtook backs off too): a
  double-clicked Stop used to send the transcript split across two messages.
- **A failed action is said on the glasses.** `onActionError` puts
  `! not sent: <reason>` (or `failed: …`) in the session footer for
  `HUD_NOTE_MS`, as well as the panel's toast. The toast was all there was, so
  a wearer who never looked at the phone took a send that never left for one
  that had. The note has the strip to itself (it is one line), and goes with
  its session, or when a send gets through.
- **Cancel returns to `pendingSend.back`:** the Compose menu for a canned send
  (so re-pick is one tap; `listSelectIndex` is reset to match the rebuilt list),
  the live session for a dictation (its mic is already closed). `backToList`
  clears `pendingSend`; a deferred prompt still can't hijack the confirm screen
  (it's not `session`+`live`, so `armPrompt` defers).

## Slash commands

- The HUD commands list and panel autocomplete expose two local shortcuts.
  Context usage asks the worker for the token breakdown. Plan usage asks for
  the session and weekly limits. Each uses its own info query. Other slash input stays in the panel for copying into Claude. Typed
  chat, quick sends and dictation still use the bridge's ordinary send path.
- **Command echoes are cleaned on BOTH surfaces by `cleanUserEcho`** (exported
  from `events/format.ts`, used by the HUD's `renderEventParts` AND the panel's
  `renderEventNode`). It unwraps `<command-name>` / `<command-args>` /
  `<local-command-stdout>` to readable text and DROPS the `<local-command-caveat>`
  block (that block is addressed to the model — "DO NOT respond to these
  messages…" — so it's noise for the reader; a caveat-only event cleans to '' and
  is dropped). Confirmed live in the simulator: without this the panel showed raw
  `<command-name>/context</command-name>` + the caveat paragraph as message
  bubbles. Note a local command still yields two user events that both read as the
  command (the send + the `<command-name>` echo); the HUD's row-budgeted tail
  usually hides the older one, the panel shows both — acceptable, not deduped.

## Clearing a conversation

- **`conversation_reset` is the ONLY signal — key on the type, never on `/clear`
  text.** A worker emits it for `/clear` (and its `/reset` / `/new` aliases),
  leaving plan mode with clear-context, and fresh-session and onboarding flows,
  from any controller or the terminal. The session id and its event log carry
  on, so the old events stay in `GET …/events` forever: hiding them is the
  client's job. The CLI's own schema says to reset on every such frame whatever
  its `trigger` says. Verified live on 2.1.314 (2026-10-30). The frame needs no
  bridge support, since `event_to_json` passes `type` through.
- **Both surfaces reset where they ingest** (`EventLog.append`, `Panel.appendNode`)
  so a history fetch spanning a clear and a live one behave alike: everything
  older goes and a lone `conversation cleared` row stays. Their `seen` sets
  survive it, so an SSE replay can't resurrect anything. `findPendingControls`
  treats a reset like a `result`. main.ts's `onConversationReset` drops the rest:
  queued prompts, a frozen history window, the aside card, and (`noteEvent`) the
  aside follow-up history.
- **The session's `summary` outlives a clear.** The worker wipes
  `post_turn_summary` only when the next turn starts, so the list gist and session
  card keep describing the cleared conversation until then. Left alone on purpose:
  there is nothing to tell a stale summary from a fresh one, and a session cleared
  while the app sits on the list sends the app no event at all.

## Release notices

- **Baked and once — both are deliberate.** `src/notices.ts` holds the app's
  only "important notice" channel (first use: the 1.7.x card telling wearers to
  `uvx --refresh` their bridge for the ≥2.1.220 send fix, rule 4). A bridge
  update carries every earlier fix, so a new "update your bridge" notice
  REPLACES the older ones rather than stacking a second card with the same
  command (1.11.0 ships one, for bridge 0.7.0). Ship a
  notice by appending to the baked `NOTICES` list + a version bump — there is
  NO fetch and NO bridge route, so never add a server side to this. On the
  panel it's a slim dismissible card above the session list (accent wash for
  `important`, tap-to-select mono block for a `command`). Dismissal writes the
  id into the settings blob's `seenNotices` and main.ts mirrors it to the SDK
  store — that mirror is what makes "shown once" survive the WebView's
  localStorage eviction, so `dismissNotice` must keep calling
  `persistSettings`. Two invariants regression-tested via browser-test: a
  seeded `seenNotices` hides the card at boot, and a Settings-card Save/Reset
  carries `seenNotices` forward (`saveRuntimeSettings` reads the stored list
  when the caller passes none — the card only knows its four fields; losing
  that merge would resurrect every dismissed notice on the next settings save).
  Prune-on-dismiss keeps the blob bounded: ids not in the current baked list
  are dropped, so retiring old notices from the source is always safe.
- **On the glasses the notice is a ONE-TIME interstitial, never a live
  surface.** `maybePresentNotices` fires only on checkAuthAndLoad's SUCCESS
  path (boot → list), at most once per launch (`noticesPresented`) — never
  over `setup`/`error` (it would bury the connection hint behind a screen
  whose fix needs the phone anyway; the panel card covers that case) and never
  mid-session. The screen is the confirm/voice `scroll` idiom: native-scrolled
  body (title + body + command joined, byte-clamped by glasses.ts), tap = got
  it (→ shared `dismissNotice`, so the panel card clears too), double-tap =
  later (queue dropped for this launch, nothing marked seen — returns next
  launch). Panel and glasses share one seen-state; `dismissNotice` also drops
  the id from `noticeQueue` and advances/leaves the notice screen, so a panel
  × while the glasses show the same notice can't leave a stale screen up.
  Notice text is authored for the panel — the HUD render folds it through
  `hudSafe` (glasses.ts), because the firmware font drops em dashes/curly
  quotes silently. Verified in the headless simulator: interstitial after
  connect, command reachable by native scroll, dbl-tap returns unretired on
  relaunch, tap retires on both surfaces.

## Config & secrets

- **Layering, runtime wins:** panel-saved settings (`claude-remote.settings` in
  localStorage) → `VITE_*` from `.env.local` (DEV SERVER ONLY — builds resolve
  no env, so on a packed build this layer is empty) → defaults. When debugging
  "why THAT bridge/token", check localStorage before the env. Never make a
  `VITE_` value required at build time — packs must work with none set. The
  `BRIDGE_URL` / `BRIDGE_TOKEN` / `DEEPGRAM_API_KEY` / `STT_LANGUAGE` consts are
  the bottom two layers only — never the saved value — because they are the
  Settings card's placeholders, and its hint promises a blank field falls back
  to the default shown in it. Anything that connects reads the live
  `current*()` accessors. (Until 1.8.2 the first three folded in the
  load-time saved settings, so a plain browser showed saved values there.)
- **Panel settings persist via the SDK, not browser storage.** The Settings card
  saves to the WebView's `window.localStorage`, but the Even app EVICTS that
  between launches — so `main.ts` mirrors the same `claude-remote.settings` JSON
  into the SDK's App-side store (`bridge.set/getLocalStorage`, which persists
  natively). `hydrateSettings()` seeds the browser cache from it at boot, right
  after the Even bridge appears — before the first connect, so a reopened app
  reconnects itself, and before `glasses.init()` and its BLE call (bounded
  since 1.8.2 — see the display-mirror gotcha). `persistSettings()` writes it
  back on every save.
  Both storage calls are `withTimeout`-guarded; in a plain browser they just
  come back empty (see panel-only mode), where localStorage persists on its own
  anyway. Without this the wearer re-enters the bridge URL + token on every
  reopen.
- **The Settings card fills its inputs on every OPEN, never at mount — and
  can't open before hydration.** `Panel.mount()` runs before
  `hydrateSettings()`, so on a reopened app the storage it sees is the evicted,
  empty one: a card prefilled at mount showed a connected app as blank, and a
  Save (say, to change only the dictation language) wrote those blanks over the
  restored bridge URL, token and key — and dropped `seenNotices`, resurrecting
  dismissed notices. `wireSettings`' `fill()` re-reads `loadRuntimeSettings()`
  each time the card opens, and a tap before `Panel.settingsLoaded()` (called
  in a `finally` after hydration, so the gate can't stick) is held and served
  then. Keep both.
- **The bridge reads `.env.local` too** (`RC_BRIDGE_*` keys; `VITE_BRIDGE_TOKEN`
  doubles as the token; CLI flags and process env win). With no token configured
  it GENERATES a word passphrase (`RC_BRIDGE_TOKEN_WORDS` words from
  `wordlist.py`, default 5 ≈ 52 bits) and persists it to
  `~/.config/claude-remote/bridge-token`; `--open` is the only unauthenticated
  mode. A user-set token is used verbatim.
- **Deepgram key** lives in `.env.local` or the Settings card; voice
  auto-disables when blank.
- **Dictation language** is the Settings card's `sttLanguage` (any Deepgram
  code; `multi` = mixed-language speech), else `STT_LANGUAGE` — the build
  default `en`, which is also the field's placeholder (see Layering).
  `currentSttLanguage()` is read on every (re)connect. Save
  checks only the code's SHAPE (`isSttLanguage`, so `german` is caught); a
  well-formed code Deepgram lacks is refused at the WebSocket upgrade (HTTP
  400; a bad key fails the same way), which a browser reports as a bare close
  1006, indistinguishable from a network drop — so it spends the reconnect
  budget (~40 s) before the captioner gives up — the voice screen's header
  follows the stream meanwhile (`○ Connecting...` → `○ Reconnecting...`;
  `● Listening` only while it's up). Its message then reaches the
  panel toast, and `failVoice` acts on no words and moves the glasses
  nowhere by itself. A glasses dictation stays on the voice screen, marked
  `! Dictation stopped` with the reason, until a tap: a send's words wait there
  for review (tap → confirm), and a half-dictated aside is dropped (never
  auto-asked). A panel dictation's words go back into the send box. Staying
  put is the point: the wearer's next tap may be a "done" meant for the live
  screen, and on the confirm screen it would SEND (reproduced in a stubbed
  host, as was the prompt case below). It used to be a bare `Voice error.`
  over a "Listening" screen. The code is
  stored as typed, trimmed but not case-folded: Deepgram's own list is
  mixed-case (`zh-Hant`, `es-419`). It matched `pt-BR`/`pt-br`/`PT-BR`, `en-gb`
  and `zh-tw` alike (2026-10-27); that's all that was checked.
- `server/pyproject.toml` depends on `claude-rc-api` by DIRECT GIT URL — needed
  for the `uvx --from git+…` install path; PyPI would reject it (see
  `server/README.md`).

## Repo

- **PUBLIC** — origin is `github.com/ThatCrispyToast/g2-claude-remote`.
  Everything committed is world-readable: never commit tokens, tailnet
  hostnames/IPs, or personal paths (`.env.local` / `*.ehpk` / `*.log` are
  gitignored for exactly that reason).
- The pre-squash history lives ONLY in the old private `ThatCrispyToast/rc-g2`
  repo (5 commits, last pushed 2026-07-17); it stays private and must NEVER be
  pushed here. The local `backup/pre-publish-history` branch that used to hold
  a copy did not survive the 2026-07-29 host migration — this checkout has
  `main` and nothing else. No auto-push — commit + push manually when asked.
