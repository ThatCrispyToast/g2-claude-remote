// Claude Remote — monitor & control ACTIVE Claude Code Remote Control sessions from Even
// Realities G2 glasses.
//
// The app drives two surfaces from one bundle: the glasses (a single full-screen
// text container over BLE) and a companion browser panel. It talks to an on-box
// bridge (server/rc_bridge.py) that wraps claude-rc-api and only ever exposes
// active, connected sessions — never archived or dead ones.
//
// Boot tolerates the absence of the Even App bridge (a plain browser / the
// headless browser-test harness): it falls back to "panel-only" mode, where the
// session list, live stream, sending, and steering all still work through the
// panel — just without the glasses display, gestures, or mic.

import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk'

import { APP_TITLE, APP_TITLE_SHORT, BRIDGE_URL, HISTORY_WINDOW_BYTES, HUD_CHARS_PER_ROW, LIVE_BODY_BYTES, LIVE_BODY_ROWS, POLL_MS, SETTINGS_KEY, SLASH_COMMANDS, currentBridge, isBridgeConfigured } from './config'
import { GlassesDisplay, HUD, clip, liveTail, screen, type Layout } from './glasses'
import { HttpBridgeClient } from './rc/client'
import { BridgeError } from './rc/types'
import type { ActiveSession, Decision, DialogAnswer, DialogOption, DialogQuestion, EffortLevel, PermissionMode, RcEvent } from './rc/types'
import { EventLog } from './events/log'
import { isQuestionRequest } from './events/format'
import { commandItems, composeActions, effortItems, modelItems, modeItems, type ComposeAction, type SubmenuItem } from './input/compose'
import { VoiceDictation } from './input/voice'
import { Panel } from './ui'

type State = 'boot' | 'setup' | 'list' | 'session' | 'compose' | 'submenu' | 'voice' | 'confirm' | 'permission' | 'question' | 'error'

const CLICK = OsEventTypeList.CLICK_EVENT // 0
const SCROLL_UP = OsEventTypeList.SCROLL_TOP_EVENT // 1
const SCROLL_DOWN = OsEventTypeList.SCROLL_BOTTOM_EVENT // 2
const DOUBLE_CLICK = OsEventTypeList.DOUBLE_CLICK_EVENT // 3

// A recoverable (mid-stream) SSE error is auto-reopened this many times, spaced
// out, before we give up and just leave the last events on screen.
const STREAM_MAX_RETRIES = 5
const STREAM_RETRY_DELAY_MS = 2500

/** Race a bridge RPC against a timeout so a slow or unimplemented native method
 *  can never stall boot or a settings save; resolves to `fallback` on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])
}

class App {
  // Rebuilt in place when the wearer saves new connection settings on the panel,
  // so a Settings change reconnects WITHOUT a page reload (a reload would drop
  // the Even glasses bridge and freeze the HUD). `origin` tracks the URL it points
  // at, for the panel's connection chip + error copy.
  private rc = new HttpBridgeClient()
  private origin = BRIDGE_URL
  // The last known bridge connection status, so every render() reflects reality
  // (a plain render must not claim 'ok' while we're on the setup/error screen).
  private connBridge: 'ok' | 'down' | 'connecting' = 'connecting'
  private bridge: EvenAppBridge | null = null
  private glasses: GlassesDisplay | null = null
  private voice: VoiceDictation | null = null
  private panel!: Panel

  private state: State = 'boot'
  private errorMsg = ''

  // session list
  private sessions: ActiveSession[] = []
  /** The row the firmware reports highlighted on the current native-list page
   *  (session list / Compose / submenu). Updated from listEvent, used on tap. */
  private listSelectIndex = 0

  // open session
  private sid: string | null = null
  private session: ActiveSession | null = null
  private readonly log = new EventLog()
  private lastSeq = 0
  private streamClose: (() => void) | null = null
  private streamRetries = 0

  // Session view: the body is scrolled natively by the firmware, not paged in
  // software. Two sub-modes:
  //   'live'    — body is the recent tail; auto-follows new events (always shows
  //               newest). Scrolling up drops into history.
  //   'history' — body is a FROZEN window of the transcript the firmware scrolls
  //               smoothly; new events don't disturb it. Scrolling to the bottom
  //               boundary returns to live; to the top boundary loads an older
  //               window. [histTop, histEnd) is the window's line range.
  private histMode: 'live' | 'history' = 'live'
  private histBody = ''
  private histTop = 0
  private histEnd = 0
  private lastScrollAt = 0 // performance.now() of the last handled scroll (debounce)

  // compose / submenu
  private submenuKind: 'model' | 'mode' | 'effort' | 'command' = 'model'
  private submenu: SubmenuItem[] = []
  // Effort applied from this app, per session — the session object doesn't
  // expose effort, so this is the only "current" the submenu can mark.
  // Absent = never set here (a level set from the CLI is invisible to us).
  private readonly effortBySid = new Map<string, EffortLevel | null>()
  // The Compose menu, snapshotted on entry. The list can vary (the leading
  // "Answer question" row appears only when a prompt is pending), and that
  // pending state can change from a stream event WHILE the wearer is in the
  // menu — so render and dispatch must read one frozen list, or the firmware's
  // row highlight would map to the wrong action.
  private composeItems: ComposeAction[] = []

  // voice
  private interim = ''

  // A canned or dictated message the wearer is about to send, held on the
  // confirmation screen so a single stray tap in the Compose menu or the voice
  // screen can't fire it. Tap Send commits; double-tap backs out to `back`
  // without sending (the Compose menu for a canned send, the session view for a
  // dictation — its mic is already closed by then). See confirmSend().
  private pendingSend: { text: string; back: 'compose' | 'session' } | null = null

  // Blocking prompts (tool-permissions and questions). `prompts` is the FIFO of
  // UNRESOLVED blocking controls; `prompts[0]` is the ARMED one — published to
  // the panel immediately, but shown on the glasses only when the wearer is
  // passively watching live (otherwise deferred until they return: never yank
  // them out of a menu, dictation, or history scrollback). `answeredIds` holds
  // every request resolved this open, so a replayed / stale control_request can
  // never resurface a prompt.
  private permEvent: RcEvent | null = null // the armed prompt (prompts[0])
  private prompts: RcEvent[] = []
  private promptDeferred = false // armed but not yet shown on the glasses
  // The wearer double-tapped "answer later" on the armed prompt: it stays
  // deferred (the CLI is still blocked, the footer nags), but the defer is now
  // STICKY — unlike an ordinary deferral, returning to the live view no longer
  // auto-presents it. It reopens only on a deliberate action: the Compose
  // "Answer question" item, or reopening the session.
  private promptSnoozed = false
  private readonly answeredIds = new Set<string>()
  private promptArmedAt = 0 // performance.now() when prompts[0] was armed
  private archiveArmed = false

  // question flavor: the wearer picks option(s) per question, answered
  // sequentially; `qPicks[i]` holds the chosen labels.
  private dialogQuestions: DialogQuestion[] = []
  private qIndex = 0
  private qPicks: string[][] = []

  private pollTimer: ReturnType<typeof setInterval> | null = null

  // ── boot ───────────────────────────────────────────────────────────────
  async boot(root: HTMLElement): Promise<void> {
    this.panel = new Panel({
      onSelectSession: (sid) => void this.openSession(sid),
      onBackToList: () => this.backToList(),
      onSend: (text) => void this.send(text),
      onInterrupt: () => void this.interrupt(),
      onSetModel: (m) => void this.applyModel(m),
      onSetMode: (m) => void this.applyMode(m),
      onSetEffort: (e) => void this.applyEffort(e),
      onArchive: () => void this.archive(),
      onAnswerPermission: (d) => void this.answerPermission(d),
      onPickDialogOption: (qIndex, label) => this.recordPick(qIndex, label),
      onCancelDialog: () => void this.submitQuestion('cancelled'),
      onStartVoice: () => void this.startVoice(),
      onStopVoice: () => void this.commitVoice(),
      onApplySettings: () => void this.applySettings(),
      onExit: () => void this.exit(),
    })
    this.panel.mount(root)
    this.connBridge = 'connecting'
    this.panel.setConnection({ bridge: 'connecting', origin: this.origin, state: this.state })

    // The Even App bridge may be absent (plain browser / browser-test). Race it
    // with a short timeout and degrade to panel-only mode if it never appears.
    this.bridge = await Promise.race([
      waitForEvenAppBridge().catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 1500)),
    ])

    if (this.bridge) {
      this.glasses = new GlassesDisplay(this.bridge)
      this.voice = new VoiceDictation(this.bridge)
      await this.glasses.init(`${APP_TITLE}\n\nconnecting`)
      this.bridge.onEvenHubEvent((e) => this.onHubEvent(e))
      this.bridge.onLaunchSource?.(() => {})
      window.addEventListener('beforeunload', () => this.cleanup())
    }

    // Restore panel-saved bridge/token from the durable App-side store BEFORE the
    // first connect, so a reopened app reconnects on its own (see hydrateSettings).
    await this.hydrateSettings()
    await this.checkAuthAndLoad()
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS)
  }

  private async checkAuthAndLoad(): Promise<void> {
    try {
      const who = await this.rc.whoami()
      this.connBridge = 'ok'
      this.panel.setConnection({ bridge: 'ok', whoami: who, origin: this.origin, state: this.state })
      if (!who.logged_in) {
        return this.fail(`Not logged in to Claude on the box.\n${who.error ?? ''}`)
      }
      await this.refreshSessions()
      this.listSelectIndex = 0
      this.go('list')
    } catch (e) {
      this.connBridge = 'down'
      this.panel.setConnection({ bridge: 'down', origin: this.origin, state: this.state })
      // First run with nothing configured yet → a welcoming setup screen, not a
      // raw error. Once a bridge IS configured, an unreachable one is a real error.
      if (!isBridgeConfigured()) return this.go('setup')
      this.fail(`Bridge unreachable at ${this.origin}.\n${(e as Error).message}`)
    }
  }

  /** Re-apply connection settings saved from the panel Settings card WITHOUT a
   *  page reload. A `location.reload()` tears down the WebView, which drops the
   *  Even glasses bridge — the fresh boot's `createStartUpPageContainer` then
   *  no-ops against the page still on the HUD, so renders are silently dropped and
   *  the glasses freeze until the app is relaunched. Reconnecting in place keeps
   *  the live bridge and re-renders both surfaces. */
  private async applySettings(): Promise<void> {
    this.backToList() // tears down any open stream / session / prompt state
    await this.persistSettings() // mirror the just-saved settings to durable storage
    const { url, token } = currentBridge()
    this.origin = url
    this.rc = new HttpBridgeClient(url, token)
    this.state = 'boot'
    this.connBridge = 'connecting'
    this.panel.setConnection({ bridge: 'connecting', origin: this.origin, state: this.state })
    this.render()
    await this.checkAuthAndLoad()
  }

  // ── settings persistence ───────────────────────────────────────────────
  // The panel writes bridge/token/Deepgram settings to the WebView's browser
  // `window.localStorage` (config.ts). Inside the Even App that WebView storage
  // is evicted between app launches, so those settings wouldn't survive a reopen
  // and the wearer would re-enter them every time. The Even SDK's
  // get/setLocalStorage persist on the NATIVE App side instead, so we treat that
  // as the durable backing store and `window.localStorage` as an in-session cache:
  // seed the cache from the App store at boot, mirror the cache back on save. In a
  // plain browser (no Even bridge) there's nothing to do — browser localStorage
  // already persists — so both are no-ops.

  /** Boot: restore saved settings from the durable App-side store into the browser
   *  cache, then rebuild the RC client so the first connect uses the restored
   *  bridge/token. Only trusts a value that parses as our settings object. */
  private async hydrateSettings(): Promise<void> {
    if (!this.bridge) return
    let stored: string
    try {
      stored = await withTimeout(this.bridge.getLocalStorage(SETTINGS_KEY), 1500, '')
    } catch {
      return // App-side store unavailable (older App build) — keep the cache as-is
    }
    if (!stored) return // empty string = nothing stored (also how a Reset clears it)
    try {
      const obj = JSON.parse(stored)
      if (!obj || typeof obj !== 'object') return
    } catch {
      return
    }
    window.localStorage?.setItem(SETTINGS_KEY, stored)
    const { url, token } = currentBridge()
    this.origin = url
    this.rc = new HttpBridgeClient(url, token)
  }

  /** Save: copy the just-saved settings (already in the browser cache, or absent
   *  after a Reset) into the durable App-side store so they survive a reopen. */
  private async persistSettings(): Promise<void> {
    if (!this.bridge) return
    try {
      const raw = window.localStorage?.getItem(SETTINGS_KEY) ?? ''
      await withTimeout(this.bridge.setLocalStorage(SETTINGS_KEY, raw), 1500, false)
    } catch {
      /* App-side store unavailable — the browser cache still holds it this session */
    }
  }

  // ── active-session list ────────────────────────────────────────────────
  private async refreshSessions(): Promise<void> {
    const list = await this.rc.listActive()
    this.sessions = list
    // The firmware owns the list highlight now, so no cursor to clamp here.
    // Keep the open session's metadata fresh, and detect if it went inactive.
    if (this.sid) {
      const still = list.find((s) => s.id === this.sid)
      if (still) this.session = still
    }
    this.panel.setSessions(this.sessions, this.sid)
  }

  private async poll(): Promise<void> {
    // Only the list and an open session need the periodic active-list refresh.
    if (this.state === 'error') return
    try {
      await this.refreshSessions()
      // If the session we're viewing/steering dropped out of the active set,
      // it was archived or died — leave it (we never control inactive sessions).
      if (this.sid && !this.sessions.some((s) => s.id === this.sid) && this.state !== 'list') {
        this.panel.setToast('Session ended — it is no longer active.')
        this.backToList()
      }
      // Safety net for resolutions that never echo a control_response (answered
      // at the terminal, cancelled by an interrupt…): if the session is no
      // longer blocked but prompts linger, they are stale. The grace period
      // covers list-fetch staleness right after a prompt arrives.
      if (
        this.prompts.length > 0 &&
        this.sid &&
        this.session &&
        this.session.workerStatus !== 'requires_action' &&
        performance.now() - this.promptArmedAt > 12_000
      ) {
        this.dropAllPrompts('Prompt resolved elsewhere.')
      }
      if (this.state === 'list') this.render()
    } catch {
      /* transient; next tick retries */
    }
  }

  // ── open / close a session ─────────────────────────────────────────────
  private async openSession(sid: string): Promise<void> {
    this.closeStream()
    this.sid = sid
    this.log.clear()
    this.lastSeq = 0
    this.streamRetries = 0
    this.resetSessionView()
    this.resetPrompts()
    this.session = this.sessions.find((s) => s.id === sid) ?? null
    try {
      this.session = await this.rc.getSession(sid) // 409s if not active
      const history = await this.rc.getHistory(sid) // the NEWEST events, oldest→newest
      for (const ev of history) {
        this.log.append(ev)
        if (ev.sequenceNum != null) this.lastSeq = Math.max(this.lastSeq, ev.sequenceNum)
      }
      this.panel.setActiveSession(this.session)
      this.panel.setEvents(history)
      this.initSessionView() // live only if running; else freeze the latest history
      // A session that is blocked on the user RIGHT NOW opens straight onto its
      // prompt: the tail-most control_request with no resolution after it
      // (answered ones are followed by their control_response / the turn's
      // result), cross-checked against the session's own blocked status.
      const pending = findPendingControl(history)
      if (pending && this.session?.workerStatus === 'requires_action') this.queuePrompt(pending)
      this.openStream()
      this.go('session')
    } catch (e) {
      if (e instanceof BridgeError && e.isInactive) {
        this.panel.setToast('That session is no longer active.')
        await this.refreshSessions()
        this.backToList()
      } else {
        // Non-inactive failure (network/500): drop the half-open session identity
        // so the list doesn't keep showing this session as "open".
        this.closeStream()
        this.sid = null
        this.session = null
        this.log.clear()
        this.panel.setActiveSession(null)
        this.fail(`Could not open session.\n${(e as Error).message}`)
      }
    }
  }

  private openStream(): void {
    if (!this.sid) return
    const sid = this.sid
    this.streamClose = this.rc.streamEvents(sid, this.lastSeq, {
      onEvent: (ev) => this.onSessionEvent(ev),
      onError: (err) => this.onStreamError(err),
      onOpen: () => {
        this.streamRetries = 0
      },
    })
  }

  private closeStream(): void {
    this.streamClose?.()
    this.streamClose = null
  }

  private onSessionEvent(ev: RcEvent): void {
    if (ev.sequenceNum != null) this.lastSeq = Math.max(this.lastSeq, ev.sequenceNum)
    // A replayed event (an SSE reconnect's catch-up window) must never
    // re-trigger UI — the log's sequenceNum dedupe is the gate for everything
    // below, most importantly the blocking-prompt routing.
    if (!this.log.append(ev)) return
    this.panel.appendEvent(ev)
    // Prompt-resolution signals: an answer echoed back through the log (ours or
    // another controller's) retires that prompt; a turn-ending result retires
    // them all (the CLI is no longer waiting on anything).
    if (ev.type === 'control_response' && ev.requestId) this.resolvePromptRemotely(ev.requestId)
    if (ev.type === 'result') this.dropAllPrompts('Turn ended.')
    // A fresh blocking control — a QUESTION (pick an option) or a
    // tool-permission (allow/deny) — joins the prompt queue; queuePrompt decides
    // whether it can show now or must wait for the wearer.
    if (ev.isBlockingControl && ev.permissionRequest && ev.requestId) this.queuePrompt(ev)
    // Re-render the session on every event: in 'live' the body follows to the
    // newest tail; in 'history' the body is frozen, so render() only refreshes
    // the (separate) header/footer containers and the native scroll stays put.
    if (this.state === 'session') this.render()
  }

  private onStreamError(err: BridgeError): void {
    if (err.isInactive) {
      this.panel.setToast('Session ended (no longer active).')
      void this.refreshSessions().then(() => this.backToList())
      return
    }
    // Recoverable: the bridge closed the stream after an error frame, so it won't
    // reconnect itself. Reopen from lastSeq a bounded number of times.
    if (this.streamRetries >= STREAM_MAX_RETRIES) {
      this.panel.setToast(`Stream lost: ${err.message}`)
      return
    }
    this.streamRetries += 1
    this.panel.setToast(`Reconnecting stream… (${this.streamRetries})`)
    setTimeout(() => {
      // Only if we're still viewing the same, still-active session.
      if (this.sid && this.state !== 'list' && this.sessions.some((s) => s.id === this.sid)) {
        this.closeStream()
        this.openStream()
      }
    }, STREAM_RETRY_DELAY_MS)
  }

  private backToList(): void {
    this.teardownVoice() // an involuntary exit must never leave the mic hot
    this.pendingSend = null // drop any unconfirmed send
    this.closeStream()
    this.sid = null
    this.session = null
    this.log.clear()
    this.resetPrompts() // drop the prompt queue (clears permEvent + panel banners)
    this.panel.setActiveSession(null)
    this.listSelectIndex = 0
    this.go('list')
  }

  /** Fire-and-forget dictation teardown for involuntary exits. Safe when idle. */
  private teardownVoice(): void {
    void this.voice?.cancel()
    this.interim = ''
    this.panel.setInterim('')
    this.panel.setDictating(false)
  }

  // ── actions (shared by gestures and panel) ─────────────────────────────
  private async send(text: string): Promise<void> {
    const t = text.trim()
    if (!t || !this.sid) return
    try {
      await this.rc.send(this.sid, t)
      this.panel.setToast(`Sent: ${clip(t, 40)}`)
    } catch (e) {
      this.onActionError(e)
    }
  }

  private async interrupt(): Promise<void> {
    if (!this.sid) return
    try {
      await this.rc.interrupt(this.sid)
      this.panel.setToast('Interrupted.')
    } catch (e) {
      this.onActionError(e)
    }
  }

  private async applyModel(model: string): Promise<void> {
    if (!this.sid) return
    try {
      await this.rc.setModel(this.sid, model)
      this.panel.setToast(`Model → ${model}`)
    } catch (e) {
      this.onActionError(e)
    }
  }

  private async applyMode(mode: PermissionMode): Promise<void> {
    if (!this.sid) return
    try {
      await this.rc.setPermissionMode(this.sid, mode)
      this.panel.setToast(`Mode → ${mode}`)
    } catch (e) {
      this.onActionError(e)
    }
  }

  /** Set reasoning effort; the sentinel 'auto' clears back to the model default. */
  private async applyEffort(effort: string): Promise<void> {
    if (!this.sid) return
    const level = effort === 'auto' ? null : (effort as EffortLevel)
    try {
      await this.rc.setEffort(this.sid, level)
      this.effortBySid.set(this.sid, level)
      this.panel.setToast(`Effort → ${effort}`)
    } catch (e) {
      this.onActionError(e)
    }
  }

  private async archive(): Promise<void> {
    if (!this.sid) return
    try {
      await this.rc.archive(this.sid)
      this.panel.setToast('Session archived.')
      await this.refreshSessions()
      this.backToList()
    } catch (e) {
      this.onActionError(e)
    }
  }

  private async answerPermission(decision: Decision): Promise<void> {
    if (!this.sid || !this.permEvent?.requestId) return
    const ev = this.permEvent
    this.answeredIds.add(ev.requestId!) // a replay must never resurrect it
    try {
      await this.rc.answerPermission(this.sid, {
        requestId: ev.requestId!,
        toolUseId: ev.toolUseId,
        decision,
        updatedInput: decision === 'allow' ? ev.permissionRequest?.input ?? undefined : undefined,
      })
      this.panel.setToast(decision === 'allow' ? 'Allowed.' : 'Denied.')
    } catch (e) {
      this.onActionError(e)
    } finally {
      this.retirePrompt()
      if (this.state === 'permission') this.go('session') // presents any next prompt
    }
  }

  // ── the blocking-prompt queue ────────────────────────────────────────────
  // A running session can block the turn on the wearer with a tool-permission
  // (allow/deny) or a QUESTION (AskUserQuestion, a plan dialog… → pick an
  // option). Prompts queue FIFO; the head is ARMED (fully interactive on the
  // panel at once) and shown on the glasses immediately only when the wearer is
  // passively watching live — never yanking them out of a menu, a dictation, or
  // a history scrollback. A deferred prompt presents itself the moment they
  // come back to the session view.

  /** Add a fresh blocking control to the queue (dedupes replays + answered). */
  private queuePrompt(ev: RcEvent): void {
    const id = ev.requestId
    if (!id || this.answeredIds.has(id)) return
    if (this.prompts.some((p) => p.requestId === id)) return
    this.prompts.push(ev)
    if (this.prompts.length === 1) this.armPrompt()
  }

  /** Arm prompts[0]: publish it to the panel and show it on the glasses now
   *  (passively watching live) or defer it (mid-menu / dictating / reading back). */
  private armPrompt(): void {
    const ev = this.prompts[0]
    if (!ev) return
    this.permEvent = ev
    this.promptArmedAt = performance.now()
    this.promptSnoozed = false // a freshly armed prompt is never pre-snoozed
    if (isQuestionRequest(ev)) {
      const p = ev.permissionRequest
      let questions = p?.questions ?? []
      if (questions.length === 0) {
        // A plain confirm dialog (a prompt, no structured options) — synthesize
        // a single question so the same option-picker handles it.
        questions = [
          {
            header: p?.dialogKind ?? 'Question',
            question: p?.prompt || p?.toolName || 'Proceed?',
            multiSelect: false,
            options: [],
          },
        ]
      }
      this.dialogQuestions = questions
      this.qIndex = 0
      this.qPicks = []
      this.panel.setDialog(this.dialogQuestions, this.qPicks)
    } else {
      this.dialogQuestions = []
      this.qIndex = 0
      this.qPicks = []
      this.panel.setPermission(ev.permissionRequest)
    }
    if (this.state === 'session' && this.histMode === 'live') {
      this.presentPrompt()
    } else {
      this.promptDeferred = true
      this.panel.setToast(`Needs you: ${promptGist(ev)}`)
      if (this.state === 'session') this.render() // history scrollback: footer hint
    }
  }

  /** Put the armed prompt on the glasses (its permission or question screen). */
  private presentPrompt(): void {
    const ev = this.permEvent
    if (!ev) return
    this.promptDeferred = false
    this.promptSnoozed = false // reopening it clears the "answer later" hold
    this.listSelectIndex = 0
    this.state = isQuestionRequest(ev) ? 'question' : 'permission'
    this.render()
  }

  /** "Answer later": set the armed question aside WITHOUT answering it. Unlike an
   *  ordinary deferral, a snooze is STICKY — the prompt stays queued (the CLI is
   *  still blocked) and nags from the footer, but returning to the live view no
   *  longer yanks the wearer back into it. They reopen it deliberately from the
   *  Compose menu (or by reopening the session). Sends nothing to the CLI. */
  private snoozePrompt(): void {
    if (!this.permEvent) {
      this.go('session')
      return
    }
    this.promptDeferred = true
    this.promptSnoozed = true
    const kind = isQuestionRequest(this.permEvent) ? 'Question' : 'Permission'
    this.panel.setToast(`${kind} set aside — reopen it from the menu.`)
    this.goLiveSession() // the snooze guard in go() keeps it from auto-presenting
  }

  /** Retire the armed prompt after WE answered/dismissed it; arm any next one
   *  (which defers — the caller's go('session') presents it). */
  private retirePrompt(): void {
    const id = this.permEvent?.requestId
    if (id) {
      this.answeredIds.add(id)
      this.prompts = this.prompts.filter((p) => p.requestId !== id)
    }
    this.clearPromptState()
    if (this.prompts.length) this.armPrompt()
  }

  /** A control_response for `requestId` appeared in the stream — if that prompt
   *  is still queued here, someone else answered it (another controller, the
   *  terminal): retire it without sending anything. */
  private resolvePromptRemotely(requestId: string): void {
    if (this.answeredIds.has(requestId)) return // our own answer echoing back
    if (!this.prompts.some((p) => p.requestId === requestId)) return
    this.answeredIds.add(requestId)
    const wasArmed = this.permEvent?.requestId === requestId
    this.prompts = this.prompts.filter((p) => p.requestId !== requestId)
    if (!wasArmed) return
    this.clearPromptState()
    this.panel.setToast('Prompt was answered elsewhere.')
    if (this.prompts.length) this.armPrompt()
    if (this.state === 'permission' || this.state === 'question') this.go('session')
  }

  /** Retire every queued prompt (the turn ended / the block vanished). */
  private dropAllPrompts(msg: string): void {
    if (this.prompts.length === 0) return
    for (const p of this.prompts) if (p.requestId) this.answeredIds.add(p.requestId)
    this.prompts = []
    this.clearPromptState()
    if (this.state === 'permission' || this.state === 'question') {
      this.panel.setToast(msg)
      this.go('session')
    }
  }

  /** Clear the armed prompt's screen/panel state (queue bookkeeping is separate). */
  private clearPromptState(): void {
    this.permEvent = null
    this.dialogQuestions = []
    this.qIndex = 0
    this.qPicks = []
    this.promptDeferred = false
    this.promptSnoozed = false
    this.panel.setPermission(null)
    this.panel.setDialog(null, [])
  }

  /** Forget everything prompt-related (session open / leave). */
  private resetPrompts(): void {
    this.prompts = []
    this.answeredIds.clear()
    this.clearPromptState()
  }

  /** The pickable options for a question — its own, or a synthesized `Proceed`. */
  private optionsFor(q: DialogQuestion | undefined): DialogOption[] {
    if (q && q.options.length) return q.options
    return [{ label: 'Proceed', description: '' }]
  }

  /** Tap in the question screen: pick the highlighted option, or dismiss. */
  private pickHighlighted(): void {
    const opts = this.optionsFor(this.dialogQuestions[this.qIndex])
    // The list is [...options, "← Dismiss"]; the trailing row cancels.
    if (this.listSelectIndex >= opts.length) {
      void this.submitQuestion('cancelled')
      return
    }
    const opt = opts[this.listSelectIndex]
    if (opt) this.recordPick(this.qIndex, opt.label)
  }

  /** Record a chosen option for a question (from a gesture or the panel), then
   *  advance to the next unanswered question or submit when all are answered. */
  private recordPick(qIndex: number, label: string): void {
    if (qIndex < 0 || qIndex >= this.dialogQuestions.length) return
    this.qPicks[qIndex] = [label] // single-select on the glasses (v1)
    this.panel.setDialog(this.dialogQuestions, this.qPicks)
    if (this.allAnswered()) {
      void this.submitQuestion('completed')
      return
    }
    const next = this.dialogQuestions.findIndex((_, i) => (this.qPicks[i]?.length ?? 0) === 0)
    if (next >= 0) this.qIndex = next
    this.listSelectIndex = 0
    if (this.state === 'question') this.render()
  }

  private allAnswered(): boolean {
    return this.dialogQuestions.length > 0 && this.dialogQuestions.every((_, i) => (this.qPicks[i]?.length ?? 0) > 0)
  }

  /** Send the answer (or a cancel) back through the bridge's /dialog route. */
  private async submitQuestion(status: 'completed' | 'cancelled'): Promise<void> {
    const ev = this.permEvent
    if (!this.sid || !ev?.requestId) {
      this.clearPromptState()
      if (this.state === 'question') this.go('session')
      return
    }
    this.answeredIds.add(ev.requestId) // a replay must never resurrect it
    const subtype = ev.permissionRequest?.subtype ?? ev.blockingSubtype ?? 'request_user_dialog'
    const answers: DialogAnswer[] = this.dialogQuestions.map((q, i) => ({
      header: q.header,
      question: q.question,
      options: this.qPicks[i] ?? [],
    }))
    try {
      await this.rc.answerDialog(this.sid, {
        requestId: ev.requestId,
        subtype,
        dialogKind: ev.permissionRequest?.dialogKind ?? null,
        // AskUserQuestion is a `can_use_tool`; the bridge answers it via the
        // permission path and needs the tool_use_id + the original input (its
        // `questions`) to build the allow's updatedInput.
        toolUseId: ev.toolUseId,
        input: ev.permissionRequest?.input ?? null,
        status,
        answers: status === 'completed' ? answers : undefined,
      })
      this.panel.setToast(
        status === 'completed' ? `Answered: ${clip(answers[0]?.options[0] ?? '', 30)}` : 'Question dismissed.',
      )
    } catch (e) {
      this.onActionError(e)
    } finally {
      const completed = status === 'completed'
      this.retirePrompt()
      if (this.state === 'question') {
        // Either path presents the next queued prompt, if there is one.
        if (completed) this.goLiveSession() // answered → watch it continue
        else this.go('session')
      }
    }
  }

  private onActionError(e: unknown): void {
    if (e instanceof BridgeError && e.isInactive) {
      this.panel.setToast('Session is no longer active.')
      void this.refreshSessions().then(() => this.backToList())
    } else {
      this.panel.setToast(`Error: ${(e as Error).message}`)
    }
  }

  // ── voice dictation ────────────────────────────────────────────────────
  private async startVoice(): Promise<void> {
    if (!this.voice?.available) {
      this.panel.setToast('Voice dictation needs a Deepgram key.')
      return
    }
    this.interim = ''
    this.panel.setDictating(true)
    this.go('voice')
    await this.voice.start({
      onInterim: (t) => {
        this.interim = t
        this.panel.setInterim(t)
        if (this.state === 'voice') this.render()
      },
      onStatus: (s) => {
        if (s === 'error') {
          this.panel.setToast('Voice error.')
          this.panel.setDictating(false)
        }
      },
    })
  }

  /** Stop the mic, clear the dictation UI, and return the trimmed transcript. */
  private async finishDictation(): Promise<string> {
    if (!this.voice) return ''
    const text = await this.voice.stop()
    this.interim = ''
    this.panel.setInterim('')
    this.panel.setDictating(false)
    return text
  }

  /** Panel Stop button: finish dictating and send straight away — an explicit
   *  press on a real button, not a stray glasses tap, so no confirm step. */
  private async commitVoice(): Promise<void> {
    const text = await this.finishDictation()
    if (text) await this.send(text)
    if (this.state === 'voice') {
      if (text) this.goLiveSession() // sent → watch it run
      else this.go('session')
    }
  }

  /** Glasses tap: finish dictating and REVIEW the transcript before it sends — a
   *  stray tap while dictating shouldn't fire a half-finished message. An empty
   *  transcript just drops back to the session. */
  private async reviewDictation(): Promise<void> {
    const text = await this.finishDictation()
    if (this.state !== 'voice') return // involuntarily left the voice screen meanwhile
    if (text) this.confirmSend(text, 'session')
    else this.go('session')
  }

  private async cancelVoice(): Promise<void> {
    await this.voice?.cancel()
    this.interim = ''
    this.panel.setInterim('')
    this.panel.setDictating(false)
    if (this.state === 'voice') this.go('session')
  }

  // ── send confirmation (misclick guard) ─────────────────────────────────────
  // The Compose menu is scroll-to-select-then-tap, so a stray tap lands on the
  // wrong row and fires a canned send; a tap while dictating fires a possibly
  // half-finished transcript. Both now route through one confirmation screen —
  // the full message on a natively-scrolled body, tap to send, double-tap to back
  // out (the same idiom as the voice screen). It's a glasses-only guard: the
  // panel's quick-send / dictate controls are explicit buttons, not misclick-prone.

  /** Hold a would-be message on the confirmation screen. `back` is where a cancel
   *  returns: the Compose menu for a canned send, the session view for a dictation. */
  private confirmSend(text: string, back: 'compose' | 'session'): void {
    this.pendingSend = { text, back }
    this.go('confirm')
  }

  /** Tapped Send on the confirmation screen → dispatch the held message. */
  private commitPendingSend(): void {
    const p = this.pendingSend
    this.pendingSend = null
    if (!p) {
      this.go('session')
      return
    }
    void this.send(p.text)
    this.goLiveSession() // sent → watch it run
  }

  /** Double-tapped the confirmation screen → return without sending anything. */
  private cancelPendingSend(): void {
    const back = this.pendingSend?.back ?? 'session'
    this.pendingSend = null
    this.listSelectIndex = 0 // Compose rebuilds highlighted at row 0 — keep them in sync
    this.go(back)
  }

  // ── EvenHub event routing (glasses only) ───────────────────────────────
  private onHubEvent(e: EvenHubEvent): void {
    if (e.audioEvent?.audioPcm) {
      this.voice?.pushPcm(e.audioEvent.audioPcm)
      return
    }
    // Taps / scroll / lifecycle arrive via `textEvent` OR `sysEvent` (and, on
    // native-list pages, `listEvent`). A tap in particular often comes through
    // `sysEvent`, so we must coalesce all three — gating on `textEvent` alone
    // silently drops taps and double-taps. (This mirrors the shipping
    // g2-live-captions handler, which is proven on real hardware.)
    const envelope = e.listEvent ?? e.textEvent ?? e.sysEvent
    if (!envelope) return
    if (e.sysEvent?.imuData) return // an IMU frame, not a gesture (IMU is never enabled)
    // On native-list pages the firmware moves the highlight itself and reports
    // the selected row here (on both scroll and tap) — track it for onTap.
    if (e.listEvent && typeof e.listEvent.currentSelectItemIndex === 'number') {
      this.listSelectIndex = e.listEvent.currentSelectItemIndex
    }
    // CLICK_EVENT is 0 and protobuf omits zero-value fields, so a tap arrives with
    // eventType === undefined → coalesce to CLICK.
    const code = envelope.eventType ?? CLICK
    switch (code) {
      case DOUBLE_CLICK:
        this.onDoubleTap()
        return
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        this.cleanup()
        return
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        void this.voice?.cancel() // backgrounded — never leave the mic hot
        return
      case CLICK:
        this.onTap()
        return
      case SCROLL_UP:
        this.onScroll(-1)
        return
      case SCROLL_DOWN:
        this.onScroll(+1)
        return
      default:
        return
    }
  }

  // ── gestures → state machine ───────────────────────────────────────────
  private onTap(): void {
    switch (this.state) {
      case 'list': {
        const s = this.sessions[this.listSelectIndex]
        if (s) void this.openSession(s.id)
        break
      }
      case 'session':
        this.listSelectIndex = 0
        this.archiveArmed = false
        this.go('compose')
        break
      case 'compose':
        this.fireCompose()
        break
      case 'submenu':
        this.fireSubmenu()
        break
      case 'voice':
        void this.reviewDictation() // finish dictating → review before sending
        break
      case 'confirm':
        this.commitPendingSend() // tap = send the held message
        break
      case 'permission':
        void this.answerPermission(this.listSelectIndex >= 1 ? 'deny' : 'allow') // tap the highlighted Allow/Deny row
        break
      case 'question':
        this.pickHighlighted() // tap the highlighted option (or the Dismiss row)
        break
      case 'setup':
      case 'error':
        void this.checkAuthAndLoad() // retry the connection
        break
    }
  }

  private onDoubleTap(): void {
    switch (this.state) {
      case 'list':
        void this.exit()
        break
      case 'session':
        this.backToList()
        break
      case 'compose':
        this.go('session')
        break
      case 'submenu':
        this.go('compose')
        break
      case 'voice':
        void this.cancelVoice()
        break
      case 'confirm':
        this.cancelPendingSend() // dbl-tap = back out without sending
        break
      case 'permission':
        this.snoozePrompt() // dbl-tap sets the permission aside to answer later
        break
      case 'question':
        this.snoozePrompt() // dbl-tap sets the question aside to answer later
        break
      case 'setup':
      case 'error':
        void this.exit()
        break
    }
  }

  private onScroll(dir: -1 | 1): void {
    // Only the session view reacts to scroll. Everything else is either a native
    // list (the firmware moves the highlight itself and reports it via listEvent)
    // or a screen that ignores scroll (voice / permission / error / boot).
    if (this.state === 'session') this.onSessionScroll(dir)
  }

  // ── session live ⇄ history (native firmware scroll) ────────────────────
  // The firmware only tells us when the body hits its top / bottom *boundary*
  // (SCROLL_TOP / SCROLL_BOTTOM); the smooth scrolling in between is invisible
  // to us. So we drive mode transitions off those boundary events.
  private onSessionScroll(dir: -1 | 1): void {
    const now = performance.now()
    if (now - this.lastScrollAt < 250) return // collapse rapid swipe frames
    this.lastScrollAt = now
    if (this.histMode === 'live') {
      if (dir < 0) this.enterHistory() // scrolled up off the live tail → history
      return // scroll-down while live: already at the newest, nothing to do
    }
    if (dir < 0) this.historyOlder() // at the top of the window → older window
    else this.historyNewer() // at the bottom of the window → newer window / live
  }

  /** Scrolled up off the live tail → freeze a history window (wearer-driven). */
  private enterHistory(): void {
    if (this.log.lineCount === 0) return
    this.freezeTail()
    this.render()
  }

  /** Point the frozen window at the newest lines (no render). Shared by the
   *  wearer's scroll-up and the idle-session default in initSessionView. */
  private freezeTail(): void {
    if (this.log.lineCount === 0) {
      this.histMode = 'live'
      this.histBody = ''
      return
    }
    const w = this.log.tailWindow(HISTORY_WINDOW_BYTES)
    this.histTop = w.startLine
    this.histEnd = this.log.lineCount
    this.histBody = w.text
    this.histMode = 'history'
  }

  /** Load the window immediately above the current one (older). */
  private historyOlder(): void {
    if (this.histTop <= 0) return // already at the oldest retained line
    const w = this.log.windowBefore(this.histTop, HISTORY_WINDOW_BYTES)
    this.histEnd = this.histTop
    this.histTop = w.startLine
    this.histBody = w.text
    this.render()
  }

  /** Load the window below the current one (newer); past the newest → back to live. */
  private historyNewer(): void {
    if (this.histEnd >= this.log.lineCount) {
      this.enterLive()
      return
    }
    const w = this.log.windowFrom(this.histEnd, HISTORY_WINDOW_BYTES)
    this.histTop = this.histEnd
    this.histEnd = w.endLine
    this.histBody = w.text
    this.render()
  }

  private enterLive(): void {
    this.histMode = 'live'
    this.histBody = ''
    // Scrolled back to now with a prompt waiting → that IS the current state
    // (unless it was snoozed: the wearer set it aside, so don't yank it back up).
    if (this.promptDeferred && this.permEvent && !this.promptSnoozed) {
      this.presentPrompt()
      return
    }
    this.render()
  }

  /** Every session opens on the tail: the row-budgeted newest lines always fit
   *  the body, so the latest output is immediately visible — auto-following if
   *  the session is running, simply sitting there if it's idle. Scrolling up
   *  drops into the frozen history windows either way. */
  private initSessionView(): void {
    this.histMode = 'live'
    this.histBody = ''
  }

  /** Jump to the tail because we just gave the session work (a send / dictate /
   *  answer) — that's what to watch now, even if the wearer had scrolled back. */
  private goLiveSession(): void {
    this.histMode = 'live'
    this.histBody = ''
    this.go('session')
  }

  private isRunning(s: ActiveSession | null): boolean {
    return s?.workerStatus === 'running'
  }

  private resetSessionView(): void {
    this.histMode = 'live'
    this.histBody = ''
    this.histTop = 0
    this.histEnd = 0
  }

  // ── compose dispatch ───────────────────────────────────────────────────
  private composeMenu(): ComposeAction[] {
    return composeActions({
      voiceAvailable: !!this.voice?.available,
      // A set-aside (or otherwise deferred) blocking prompt leads the menu so the
      // wearer can reopen it. permEvent is set iff one is armed but not showing.
      pendingPrompt: this.permEvent ? this.pendingPromptLabel(this.permEvent) : null,
    })
  }

  /** The Compose label for a set-aside blocking prompt (question or permission). */
  private pendingPromptLabel(ev: RcEvent): string {
    return isQuestionRequest(ev) ? `${HUD.ATTN} Answer question` : `${HUD.ATTN} Review permission`
  }

  private fireCompose(): void {
    const action = this.composeItems[this.listSelectIndex]
    if (!action) return
    switch (action.kind) {
      case 'prompt':
        this.presentPrompt() // reopen the set-aside question / permission screen
        break
      case 'send':
        this.confirmSend(action.text, 'compose') // confirm before firing a canned send
        break
      case 'voice':
        void this.startVoice()
        break
      case 'interrupt':
        void this.interrupt()
        this.go('session')
        break
      case 'submenu':
        this.openSubmenu(action.menu)
        break
      case 'archive':
        // Two-tap confirm. Don't re-render (relabeling would rebuild the native
        // list and reset the firmware highlight off the Archive row); the toast
        // carries the prompt and the highlight stays put for the second tap.
        if (!this.archiveArmed) {
          this.archiveArmed = true
          this.panel.setToast('Tap Archive again to confirm.')
        } else {
          void this.archive()
        }
        break
      case 'back':
        this.go('session')
        break
    }
  }

  private openSubmenu(kind: 'model' | 'mode' | 'effort' | 'command'): void {
    this.submenuKind = kind
    this.submenu =
      kind === 'model'
        ? modelItems(this.session?.model ?? null)
        : kind === 'mode'
          ? modeItems(this.session?.permissionMode ?? null)
          : kind === 'effort'
            ? effortItems(this.sid ? this.effortBySid.get(this.sid) : undefined)
            : commandItems()
    this.listSelectIndex = 0 // native list starts highlighted at the top row
    this.go('submenu')
  }

  private fireSubmenu(): void {
    const item = this.submenu[this.listSelectIndex]
    if (!item || item.value === '') {
      this.go('compose')
      return
    }
    if (this.submenuKind === 'command') {
      this.fireSlashCommand(item.value) // owns its own navigation (confirm vs fire+watch)
      return
    }
    if (this.submenuKind === 'model') void this.applyModel(item.value)
    else if (this.submenuKind === 'mode') void this.applyMode(item.value as PermissionMode)
    else void this.applyEffort(item.value)
    this.go('session')
  }

  /** Fire a slash command from the Commands submenu. Sent as a plain `/name`
   *  message — the worker runs it locally at zero cost. A `confirm` command
   *  (heavy/destructive, e.g. /compact, /clear) lands on the confirm screen first
   *  so a stray tap can't fire it; the rest send immediately and jump to the live
   *  tail so the wearer watches the command's output land. */
  private fireSlashCommand(name: string): void {
    const cmd = SLASH_COMMANDS.find((c) => c.name === name)
    if (!cmd) {
      this.go('session')
      return
    }
    const text = `/${cmd.name}`
    if (cmd.confirm) {
      this.confirmSend(text, 'compose') // cancel returns to the Compose menu, one level up
      return
    }
    void this.send(text)
    this.goLiveSession()
  }

  // ── state transition + rendering ───────────────────────────────────────
  private go(state: State): void {
    // Coming (back) to the session view while a prompt waits presents the
    // prompt instead — it's the thing the session is blocked on, and the wearer
    // is no longer mid-menu / mid-dictation. A SNOOZED prompt is the exception:
    // the wearer set it aside on purpose, so it stays out of the way until they
    // reopen it (Compose → Answer question).
    if (state === 'session' && this.promptDeferred && this.permEvent && !this.promptSnoozed) {
      this.presentPrompt()
      return
    }
    // Freeze the Compose list on entry so its render and its tap-dispatch always
    // agree on row → action, even if the pending-prompt state shifts underneath.
    if (state === 'compose') this.composeItems = this.composeMenu()
    this.state = state
    this.render()
  }

  private fail(msg: string): void {
    this.errorMsg = msg
    this.go('error')
  }

  private async exit(): Promise<void> {
    this.cleanup()
    await this.glasses?.shutdown(0)
  }

  private render(): void {
    this.panel.setConnection({ bridge: this.connBridge, origin: this.origin, state: this.state })
    if (!this.glasses) return // panel-only mode
    this.glasses.render(this.layout())
  }

  /** The current screen as a native layout the GlassesDisplay draws + diffs. */
  private layout(): Layout {
    switch (this.state) {
      case 'list':
        if (this.sessions.length === 0) {
          return {
            kind: 'text',
            content: screen({ header: `${APP_TITLE} ${HUD.SEP} sessions`, body: 'No active sessions.', footer: 'dbl-tap to exit' }),
          }
        }
        return {
          kind: 'list',
          header: `${APP_TITLE_SHORT} ${HUD.SEP} ${this.sessions.length} active ${HUD.SEP} tap open ${HUD.SEP} dbl exit`,
          items: this.listRows(),
        }
      case 'compose':
        return { kind: 'list', header: `Compose ${HUD.SEP} tap ${HUD.SEP} dbl = back`, items: this.composeLabels() }
      case 'submenu':
        return {
          kind: 'list',
          header: `${SUBMENU_TITLE[this.submenuKind]} ${HUD.SEP} tap ${HUD.SEP} dbl = back`,
          items: this.submenu.map((i) => i.label),
        }
      case 'session':
        return this.sessionLayout()
      case 'permission':
        return this.permissionLayout()
      case 'question':
        return this.questionLayout()
      case 'voice':
        return {
          kind: 'scroll',
          header: `${HUD.RUN} Listening`,
          body: this.interim ? liveTail(this.interim) : '(speak now)',
          footer: `tap = done ${HUD.SEP} dbl = cancel`,
        }
      case 'confirm':
        return this.confirmLayout()
      case 'setup':
        // A pinned header + footer (scroll layout) so the retry hint always shows
        // and the body never overflows into a scrollbar the way a full-screen text
        // container would. This is the friendly first-run landing (no bridge set).
        return {
          kind: 'scroll',
          header: `${APP_TITLE} ${HUD.SEP} setup`,
          body: 'Not connected yet.\n\nIn the app, open the panel and tap Settings, then enter the bridge URL and token.\n\nRun the bridge on your computer to get your credentials.',
          footer: `tap = retry ${HUD.SEP} dbl-tap = exit`,
        }
      case 'error':
        return {
          kind: 'text',
          content: screen({ header: `${APP_TITLE} ${HUD.SEP} error`, body: this.errorMsg, footer: `tap retry ${HUD.SEP} dbl-tap exit` }),
        }
      case 'boot':
      default:
        return { kind: 'text', content: `${APP_TITLE}\n\nconnecting` }
    }
  }

  private listRows(): string[] {
    return this.sessions.map((s) => `${dot(s.workerStatus)} ${clip(s.title, 32, HUD.ELL)} ${HUD.SEP} ${short(s.workerStatus)}`)
  }

  /** Session view: fixed header + firmware-scrolled body + fixed footer. */
  private sessionLayout(): Layout {
    const s = this.session
    const header = `${dot(s?.workerStatus)} ${clip(s?.title ?? 'session', 22, HUD.ELL)} ${HUD.SEP} ${modelShort(s?.model ?? null)} ${HUD.SEP} ${s?.permissionMode ?? 'default'}`
    // A deferred prompt (e.g. the wearer is reading back history) nags gently
    // from the footer instead of hijacking the screen.
    const attn = this.promptDeferred ? `${HUD.ATTN} needs you ${HUD.SEP} ` : ''
    if (this.histMode === 'history') {
      return {
        kind: 'scroll',
        header,
        body: this.histBody || '(no events)',
        footer: `${attn}history ${HUD.SEP} down = live ${HUD.SEP} dbl = list`,
      }
    }
    // The tail view is "live" while the session is running (auto-following) and
    // just "latest" when idle — same view, honest label.
    const tailTag = this.isRunning(s) ? `${HUD.RUN} live` : `${HUD.IDLE} latest`
    return {
      kind: 'scroll',
      header,
      // The live tail is ROW-budgeted so it always fits the body with no
      // overflow — the firmware draws text top-aligned and never auto-scrolls,
      // so an overflowing tail would hide exactly the newest lines.
      body: this.log.count ? this.log.tailRows(LIVE_BODY_ROWS, HUD_CHARS_PER_ROW, LIVE_BODY_BYTES) : '(no events yet)',
      footer: `${attn}${tailTag} ${HUD.SEP} up = history ${HUD.SEP} tap = menu`,
    }
  }

  /** Permission prompt as a native Allow/Deny list — so, like every other screen,
   *  it has a no-commit escape: scroll to Allow or Deny and tap to decide, or
   *  double-tap to set it aside and answer later. The tool + a clip of its input
   *  ride in the header (the companion panel shows the full, unclipped input). */
  private permissionLayout(): Layout {
    const p = this.permEvent?.permissionRequest
    const tool = p?.toolName ?? 'tool'
    const raw = p?.input ? firstInput(p.input) : ''
    const detail = raw ? ` ${HUD.SEP} ${clip(raw, 88, HUD.ELL)}` : ''
    return {
      kind: 'list',
      header: `${HUD.ATTN} ${clip(tool, 22, HUD.ELL)}${detail}`,
      items: ['Allow', 'Deny'],
    }
  }

  /** Question dialog: the question in the header + its options as a native list.
   *  Scroll to an option and tap to pick; the trailing `← Dismiss` row (or a
   *  double-tap) cancels. Multi-question dialogs are answered one at a time. */
  private questionLayout(): Layout {
    const q = this.dialogQuestions[this.qIndex]
    const n = this.dialogQuestions.length
    const prefix = n > 1 ? `(${this.qIndex + 1}/${n}) ` : ''
    const head = (q?.question || q?.header || 'Question').trim()
    const options = this.optionsFor(q)
    return {
      kind: 'list',
      header: `${HUD.ATTN} ${prefix}${clip(head, 84, HUD.ELL)}`,
      items: [...options.map(optionLabel), `${HUD.BACK} Dismiss`],
    }
  }

  /** Confirm a canned or dictated message before it sends. The full message rides
   *  in the natively-scrolled body (so a long dictation can be read back and
   *  scrolled), and the tap = send / double-tap = cancel idiom matches the voice
   *  screen the wearer may have just come from. */
  private confirmLayout(): Layout {
    return {
      kind: 'scroll',
      header: `${HUD.SEND} Send this message?`,
      body: this.pendingSend?.text || '(empty)',
      footer: `tap = send ${HUD.SEP} dbl = cancel`,
    }
  }

  private composeLabels(): string[] {
    // Labels from the frozen snapshot taken on entry (see `composeItems`). The
    // two-tap archive confirm is surfaced via a toast, not a relabel, so the
    // native list isn't rebuilt (which would reset the firmware's row highlight).
    return this.composeItems.map((a) => a.label)
  }

  // ── teardown ───────────────────────────────────────────────────────────
  private cleanup(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.closeStream()
    void this.voice?.cancel()
  }
}

// ── small pure helpers ─────────────────────────────────────────────────────
/** Header title per submenu kind (exhaustive, so a new kind can't silently
 *  inherit the wrong label the way a fall-through ternary did). */
const SUBMENU_TITLE: Record<'model' | 'mode' | 'effort' | 'command', string> = {
  model: 'Model',
  mode: 'Permission mode',
  effort: 'Effort',
  command: 'Commands',
}

function short(w: string | null | undefined): string {
  if (w === 'requires_action') return 'needs you'
  return w ?? 'idle'
}
function dot(w: string | null | undefined): string {
  if (w === 'running') return HUD.RUN
  if (w === 'requires_action') return HUD.ATTN
  return HUD.IDLE
}
function modelShort(m: string | null): string {
  if (!m) return '?'
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}
/** A question option row: the label, plus a short description when there's room. */
function optionLabel(o: DialogOption): string {
  const desc = o.description ? ` ${HUD.SEP} ${clip(o.description, 28, HUD.ELL)}` : ''
  return `${o.label}${desc}`
}
/** A one-line summary of a blocking prompt, for the deferred-prompt toast. */
function promptGist(ev: RcEvent): string {
  const p = ev.permissionRequest
  const q = p?.questions?.[0]
  return clip(q?.question || q?.header || p?.prompt || p?.toolName || 'a prompt', 48, HUD.ELL)
}
/**
 * The tail-most blocking control in `events` that nothing after it resolves.
 * An answered control_request is followed by its control_response (any
 * controller's), and a finished turn by its result — so whatever survives the
 * scan is what the session is blocked on right now (callers still cross-check
 * the session's own blocked status).
 */
function findPendingControl(events: RcEvent[]): RcEvent | null {
  let pending: RcEvent | null = null
  for (const ev of events) {
    if (ev.isBlockingControl && ev.permissionRequest && ev.requestId) pending = ev
    else if (ev.type === 'control_response' && ev.requestId && pending?.requestId === ev.requestId) pending = null
    else if (ev.type === 'result') pending = null
  }
  return pending
}
function firstInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt', 'query']) {
    const v = input[key]
    if (typeof v === 'string' && v) return v
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v) return v
  }
  return JSON.stringify(input)
}

const root = document.getElementById('app')
if (root) void new App().boot(root)
