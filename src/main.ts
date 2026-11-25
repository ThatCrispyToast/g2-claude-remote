// Claude Remote — monitor & control ACTIVE Claude Code Remote Control sessions from Even
// Realities G2 glasses.
//
// The app drives two surfaces from one bundle: the glasses (the firmware's native
// text/list widgets over BLE — see glasses.ts) and a companion browser panel. It
// talks to the bridge (`claude-remote-bridge`, server/) that wraps claude-rc-api
// and only ever exposes active, connected sessions — never archived or dead ones.
//
// Boot tolerates the absence of the Even App bridge (a plain browser / the
// headless browser-test harness): it falls back to "panel-only" mode, where the
// session list, live stream, sending, and steering all still work through the
// panel — just without the glasses display, gestures, or mic.

import { ImuReportPace, OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk'

import { APP_TITLE, APP_TITLE_SHORT, HISTORY_WINDOW_BYTES, LIVE_BODY_BYTES, LIVE_BODY_BYTES_STRIP, LIVE_BODY_ROWS, POLL_MS, SETTINGS_KEY, isSlashInput, currentBridge, isBridgeConfigured, BLANK_AFTER_CHOICES, displaySettings, saveDisplaySettings, type DisplaySettings, type HeadReading } from './config'
import { markNoticeSeen, unseenNotices, type Notice } from './notices'
import { GlassesDisplay, HUD, MAX_LIST_ITEMS, bodyRows, clampBytes, clip, fitsStripRow, hudSafe, listItemText, liveTail, stripRows, type Layout, type ListLayout } from './glasses'
import { HttpBridgeClient } from './rc/client'
import { BridgeError } from './rc/types'
import type {
  ActiveSession,
  AsideTurn,
  BackgroundTask,
  ContextUsage,
  Decision,
  DialogAnswer,
  DialogOption,
  DialogQuestion,
  EffortLevel,
  HistoryPage,
  InfoSection,
  PermissionMode,
  RcEvent,
  SessionInfo,
  WorkerState,
} from './rc/types'
import { EventLog } from './events/log'
import { cleanProse, isQuestionRequest, modelShort, modeShort, settlesPrompt, rateLimitLabel } from './events/format'
import {
  ASIDE_DICTATE,
  asideItems,
  commandItems,
  composeActions,
  effortItems,
  modelItems,
  modeItems,
  type ComposeAction,
  type SubmenuItem,
  type SubmenuKind,
} from './input/compose'
import { VoiceDictation, type VoiceStatus } from './input/voice'
import { currentSttSource, setBridgeDictation } from './config'
import { Panel, type AsideView } from './ui'

type State =
  | 'boot'
  | 'setup'
  | 'list'
  | 'session'
  | 'compose'
  | 'submenu'
  | 'voice'
  | 'confirm'
  | 'permission'
  | 'question'
  | 'reply'
  | 'replyDetail'
  | 'detail'
  | 'aside'
  | 'info'
  | 'notice'
  | 'error'
  | 'settings'
  | 'settingPick'
  | 'calibrate'

const CLICK = OsEventTypeList.CLICK_EVENT // 0
const SCROLL_UP = OsEventTypeList.SCROLL_TOP_EVENT // 1
const SCROLL_DOWN = OsEventTypeList.SCROLL_BOTTOM_EVENT // 2
const DOUBLE_CLICK = OsEventTypeList.DOUBLE_CLICK_EVENT // 3

// A recoverable (mid-stream) SSE error is auto-reopened this many times, spaced
// out, before we give up and just leave the last events on screen.
const STREAM_MAX_RETRIES = 5
const STREAM_RETRY_DELAY_MS = 2500

// The session header is ONE line of a proportional font; past ~56 chars it
// overflows its strip. The title gets whatever the status tail leaves.
const HEADER_CHARS = 56
// Context use joins the header only once it is worth a glance.
const CTX_WARN_PCT = 50
// Side-question exchanges kept per session and sent with a follow-up.
const ASIDE_HISTORY = 4
// A prompt's list takes no tap until it has been on the glass this long. The
// app switches screens the moment an event arrives, but the glass repaints a
// BLE round trip later and the wearer needs a beat to see it: a tap already on
// its way (meant as "menu" on the live view, the second of two on a list row,
// a second Allow as the next prompt slides in) would land on row 0 of a prompt
// nobody had read yet, which is Allow. See promptTapOk().
const PROMPT_TAP_GUARD_MS = 900
// The rows a permission's / a question's header strip may take.
const PERMISSION_HEADER_ROWS = 2
const QUESTION_HEADER_ROWS = 3
// The prompt-details body, under the display's per-container byte cap with
// room for the "rest is on the phone" line.
const DETAIL_BYTES = 900
// How long a failed action stays in the session footer.
const HUD_NOTE_MS = 7000

/** Race a bridge RPC against a timeout so a slow or unimplemented native method
 *  can never stall boot or a settings save; resolves to `fallback` on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

type VoicePurpose = 'send' | 'aside' | 'other' | 'deny'
type PromptReply = { id: string; index: number; kind: 'other' | 'deny' | 'rule'; text: string }

export class App {
  // Rebuilt in place when the wearer saves new connection settings on the panel,
  // so a Settings change reconnects WITHOUT a page reload (a reload would drop
  // the Even glasses bridge and freeze the HUD). `origin` tracks the URL it points
  // at, for the panel's connection chip + error copy.
  private rc!: HttpBridgeClient // set by useCurrentBridge(), first thing in boot()
  private origin = ''
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
  private sessionListPage = 0
  /** Read a result received in the dark only once the transcript is on screen. */
  private deferredRead: string | null = null
  /** The row the firmware reports highlighted on the current native-list page
   *  (session list / Compose / submenu). Updated from listEvent, used on tap. */
  private listSelectIndex = 0

  // open session
  private sid: string | null = null
  private session: ActiveSession | null = null
  private readonly log = new EventLog()
  private lastSeq = 0
  // Counts every open and every leave, so an open still waiting on the bridge
  // can tell it was overtaken (a second tap, another row, Back) and stand down.
  private openSeq = 0
  private streamClose: (() => void) | null = null
  private streamRetries = 0
  private streamRetryTimer: ReturnType<typeof setTimeout> | null = null
  // The open session's stream is down (the footer says so), and whether its
  // retries ran out — then each poll the bridge answers tries it once more.
  // Both outlive a reopen attempt; dropStream() forgets them with the session.
  private streamDown = false
  private streamLost = false

  // Session view: the body is scrolled natively by the firmware, not paged in
  // software. Two sub-modes:
  //   'live'    — body is the recent tail; auto-follows new events (always shows
  //               newest). Scrolling up drops into history.
  //   'history' — body is a FROZEN window of the transcript the firmware scrolls
  //               smoothly; new events don't disturb it. Scrolling to the bottom
  //               boundary returns to live; to the top boundary loads an older
  //               window. [histTop, histEnd) is the window's line range.
  private histMode: 'live' | 'history' = 'live'
  private recentHistory: HistoryPage = { events: [] }
  // Each visited page is frozen while live events continue in the tail.
  private historyPages: { log: EventLog; before?: number | null }[] = []
  private pageIndex = 0
  private loadingPage: EventLog | null = null
  private histBody = ''
  private histTop = 0
  private histEnd = 0
  private lastScrollAt = 0 // performance.now() of the last handled scroll (debounce)

  // The open session's live settings, merged from its system/init + status
  // events (the session object has no permission mode at all), and its running
  // background tasks, from the newest system/background_tasks_changed.
  private worker: WorkerState | null = null
  private tasks: BackgroundTask[] = []

  // compose / submenu
  private submenuKind: SubmenuKind = 'model'
  private submenu: SubmenuItem[] = []
  // Effort applied from this app, per session: the last-resort "current" for
  // a worker too old to report its effort (2.1.29x and earlier).
  private readonly effortBySid = new Map<string, EffortLevel | null>()
  // The Compose menu, snapshotted on entry. The list can vary (the leading
  // "Answer question" row appears only when a prompt is pending), and that
  // pending state can change from a stream event WHILE the wearer is in the
  // menu — so render and dispatch must read one frozen list, or the firmware's
  // row highlight would map to the wrong action.
  private composeItems: ComposeAction[] = []

  // voice — `voicePurpose` is what the transcript becomes when dictation ends;
  // `voiceFrom` is the surface that started it, where a failed one hands back
  // its words (keepFailedDictation); `voiceStatus` is the Deepgram stream's state, for the
  // voice screen's header
  private interim = ''
  private promptReply: PromptReply | null = null
  private voicePurpose: VoicePurpose = 'send'
  /** A reviewed message that a long press reopened for more dictation: the
   *  new words are added after it. */
  private voicePrefix = ''
  private voiceFrom: 'panel' | 'glasses' = 'glasses'
  private voiceStatus: VoiceStatus = 'connecting'
  // A glasses dictation that died (keepFailedDictation): the voice screen stays up,
  // marked stopped, holding the reason and any words left to review.
  private voiceStop: { reason: string; text: string } | null = null
  // Dictation runs, counted by startVoice(), and the run a finish (stop +
  // flush) is under way for: a second "done" on that run backs off, and a
  // finish that a newer run overtook leaves the newer one's UI alone.
  private voiceRun = 0
  private finishingRun: number | null = null

  // Side questions ("Ask aside"): the exchange on screen (glasses aside screen +
  // panel card) and, per session, the recent exchanges sent along with a
  // follow-up. `asideSeq` drops a late answer to a question since replaced.
  private aside: AsideView | null = null
  private readonly asideHistory = new Map<string, AsideTurn[]>()
  private asideSeq = 0

  // Session info's on-demand part (plan usage, git changes) — fetched on entry,
  // never polled: each fetch leaves control events in the session's log.
  private info: SessionInfo | null = null
  private infoError: string | null = null
  private infoSection: InfoSection = 'all'
  private infoLoading = false
  private infoSeq = 0

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
  private listBuiltAt = 0 // performance.now() when the list now on the glass was built
  // Whether the app is in front on the glasses (FOREGROUND_EXIT / _ENTER): a
  // turn that ends while it isn't has not been read.
  private foreground = true
  private archiveArmed = false
  // The armed prompt read in full (the 'detail' screen): its text, fixed on
  // entry so the natively-scrolled body never changes under the reader.
  private detailBody = ''

  // question flavor: the wearer picks option(s) per question, answered
  // sequentially; `qPicks[i]` holds the chosen labels and `qDone[i]` whether
  // that question is settled (a pick settles a single-select; a multi-select
  // toggles its picks until Submit).
  private dialogQuestions: DialogQuestion[] = []
  private qIndex = 0
  private qPicks: string[][] = []
  private qDone: boolean[] = []

  // A failed action, said on the glasses too (the session footer, briefly).
  // The panel's toast was all there was, so a wearer who never looked at the
  // phone took a send that never left for one that had.
  private hudNote = ''
  // ── display settings, blanking and head tilt wake ──
  private settingKind: SettingKind = 'blank'
  private settingItems: SubmenuItem[] = []
  /** Calibration: 0 = waiting for the working position, 1 = for reading. */
  private calStep = 0
  private calRest: HeadReading | null = null
  private calNote = ''
  /** The latest motion-sensor reading, once reports are on. */
  private imu: HeadReading | null = null
  /** A notice lit on the otherwise blank screen, and when it came. */
  private notice: { key: string; text: string; at: number } | null = null
  private imuOn: boolean | null = false
  private imuBusy = false
  private imuRetryFor = false
  /** After a refused imuControl, no retry before this (performance.now()). */
  private imuRetryAt = 0
  private lastInputAt = performance.now()
  private blanked = false
  /** A wake gesture has requested the visible page, but BLE has yet to paint it. */
  private waking = false
  private headUp = false
  private displayTimer: ReturnType<typeof setInterval> | null = null
  /** The fade-out before blanking: 0 = none, else the step in FADE_DIM. */
  private fadeStep = 0
  private fadeTimer: ReturnType<typeof setTimeout> | null = null
  /** The context use each session's strip shows (see stripSettings). */
  private ctxShown = new Map<string, ContextUsage | null>()
  private hudNoteTimer: ReturnType<typeof setTimeout> | null = null

  // Release notices on the glasses (notices.ts): the unseen notices queued for
  // the one-time interstitial, and whether it already presented this launch —
  // checkAuthAndLoad also runs on setup/error retries and settings changes, and
  // a reconnect must not replay the screen the wearer already tapped "later" on.
  private noticeQueue: Notice[] = []
  private noticesPresented = false

  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false

  // ── boot ───────────────────────────────────────────────────────────────
  async boot(root: HTMLElement): Promise<void> {
    this.useCurrentBridge()
    this.panel = new Panel({
      onSelectSession: (sid) => void this.openSession(sid),
      onBackToList: () => this.backToList(),
      onTakeGlassesDraft: () => {
        if (this.state !== 'confirm' || !this.pendingSend) return null
        const text = this.pendingSend.text
        this.cancelPendingSend()
        return text
      },
      onSend: (text) => {
        if (text === '/context' || text === '/usage') {
          this.panel.focusInfo()
          void this.loadInfo(text === '/usage' ? 'usage' : 'context')
        } else void this.send(text)
      },
      onInterrupt: () => void this.interrupt(),
      onSetModel: (m) => void this.applyModel(m),
      onSetMode: (m) => void this.applyMode(m),
      onSetEffort: (e) => void this.applyEffort(e),
      onArchive: () => void this.archive(),
      onSetPinned: (pinned) => void this.setPinned(pinned),
      onAnswerPermission: (d, note, rule) => void this.answerPermission(d, note, rule),
      onPickDialogOption: (qIndex, label) => this.recordPick(qIndex, label),
      onConfirmDialogPicks: (qIndex) => this.confirmPicks(qIndex),
      onCancelDialog: () => void this.submitQuestion('cancelled'),
      onStartVoice: () => void this.startVoice('send', 'panel'),
      onStopVoice: () => void this.commitVoice(),
      onAskAside: (q) => void this.askAside(q, 'panel'),
      onDismissAside: () => this.dismissAside(),
      onOlderEvents: async (before) => {
        const sid = this.sid
        const run = this.openSeq
        if (!sid) return null
        try {
          const page = await this.rc.getHistoryPage(sid, before)
          return run === this.openSeq ? page : null
        } catch (e) {
          if (run === this.openSeq) this.onActionError(e)
          return null
        }
      },
      onLoadInfo: () => void this.loadInfo(),
      onStopTask: (id) => void this.stopTask(id),
      onApplySettings: () => void this.applySettings(),
      onSetDisplay: (patch) => {
        saveDisplaySettings(patch)
        void this.persistSettings()
        this.syncImu()
        this.render()
        this.panel.refreshDisplaySettings()
      },
      onCalibrateTilt: () => {
        if (!this.glasses || this.glasses.unavailable) {
          this.panel.setToast('Connect the glasses to set up head tilt.')
          this.panel.refreshDisplaySettings()
          return
        }
        this.panel.setToast('Continue on the glasses: hold your head in its normal position, then tap.', 5000)
        this.startCalibration()
      },
      onDismissNotice: (id) => this.dismissNotice(id),
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

    // Restore panel-saved settings from the durable App-side store FIRST: before
    // the first connect, so a reopened app reconnects on its own, and before
    // glasses.init() — the Settings screen stays shut until this lands
    // (Panel.settingsLoaded), so it may wait on nothing but this one bounded read.
    try {
      await this.hydrateSettings()
    } finally {
      this.panel.settingsLoaded()
    }

    if (this.bridge) {
      this.glasses = new GlassesDisplay(this.bridge)
      // Every full list (re)build resets the firmware's selection highlight to
      // row 0 — resync the tracked index or the next row-0 tap (protobuf drops
      // index 0, so it arrives indexless) would fire whatever stale row this
      // still pointed at: the wrong session, the wrong menu entry, or Deny
      // instead of Allow.
      this.glasses.onListRebuild = () => {
        this.listSelectIndex = 0
        this.listBuiltAt = performance.now()
      }
      this.glasses.onImageFallback = () => this.render()
      this.glasses.onPainted = () => this.onDisplayPainted()
      this.voice = new VoiceDictation(this.bridge)
      // Bounded: a startup page stuck on BLE no longer holds up the connect
      // below, and the HUD paints the latest screen whenever it does land.
      await this.glasses.init(`${APP_TITLE}\n\nconnecting`)
      this.bridge.onEvenHubEvent((e) => this.onHubEvent(e))
      this.bridge.onLaunchSource?.(() => {})
      this.displayTimer = setInterval(() => this.displayTick(), DISPLAY_TICK_MS)
      this.syncImu()
      window.addEventListener('beforeunload', () => this.cleanup())
    }

    // Baked release notices — AFTER hydration, whose restored blob carries the
    // seen-ids: rendering earlier would flash already-dismissed notices.
    this.panel.setNotices(unseenNotices())
    await this.checkAuthAndLoad()
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS)
  }

  private async checkAuthAndLoad(): Promise<void> {
    const rc = this.rc
    try {
      const who = await rc.whoami()
      if (this.rc !== rc) return
      this.connBridge = 'ok'
      setBridgeDictation(who.local_stt === true)
      this.panel.setConnection({ bridge: 'ok', whoami: who, origin: this.origin, state: this.state })
      if (!who.logged_in) {
        return this.fail(`Not logged in to Claude on the box.\n${who.error ?? ''}`)
      }
      await this.refreshSessions()
      if (this.rc !== rc) return
      this.sessionListPage = 0
      this.listSelectIndex = 0
      this.go('list')
      this.maybePresentNotices()
    } catch (e) {
      if (this.rc !== rc) return
      this.connBridge = 'down'
      this.panel.setConnection({ bridge: 'down', origin: this.origin, state: this.state })
      // First run with nothing configured yet → a welcoming setup screen, not a
      // raw error. Once a bridge IS configured, an unreachable one is a real error.
      if (!isBridgeConfigured()) return this.go('setup')
      this.fail(`Bridge unreachable at ${this.origin}.\n${(e as Error).message}`)
    }
  }

  /** Re-apply connection settings saved from the panel Settings screen WITHOUT a
   *  page reload. A `location.reload()` tears down the WebView, which drops the
   *  Even glasses bridge — the fresh boot's `createStartUpPageContainer` then
   *  no-ops against the page still on the HUD, so renders are silently dropped and
   *  the glasses freeze until the app is relaunched. Reconnecting in place keeps
   *  the live bridge and re-renders both surfaces. */
  private async applySettings(): Promise<void> {
    this.backToList() // tears down any open stream / session / prompt state
    await this.persistSettings() // mirror the just-saved settings to durable storage
    this.useCurrentBridge()
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
    this.useCurrentBridge()
    // The Settings screen can open as soon as this returns, well before the first
    // connect: show the restored origin, not the load-time default.
    this.panel.setConnection({ bridge: this.connBridge, origin: this.origin, state: this.state })
  }

  /** Point the client — and the origin the panel shows — at the bridge in the
   *  saved settings, re-read live: at boot, after hydration, and on every Save. */
  private useCurrentBridge(): void {
    setBridgeDictation(false)
    const { url, token } = currentBridge()
    this.origin = url
    this.rc = new HttpBridgeClient(url, token)
  }

  /** A release notice was acknowledged (panel × or glasses tap): record it
   *  seen, re-render the (possibly now empty) panel area, and mirror the
   *  settings blob to the durable App-side store — WebView localStorage alone
   *  is evicted between launches, which would turn "shown once" into "shown
   *  every launch". Both surfaces share this path, so a panel dismiss also
   *  advances (or closes) the glasses notice screen and vice versa. */
  private dismissNotice(id: string): void {
    markNoticeSeen(id)
    this.panel.setNotices(unseenNotices())
    void this.persistSettings()
    if (this.noticeQueue.some((n) => n.id === id)) {
      this.noticeQueue = this.noticeQueue.filter((n) => n.id !== id)
      if (this.state === 'notice') {
        if (this.noticeQueue.length > 0) this.render() // next queued notice
        else this.go('list')
      }
    }
  }

  // ── release notices on the glasses ─────────────────────────────────────
  // A ONE-TIME interstitial, not a live surface: after the first successful
  // connect of a launch, any not-yet-dismissed baked notice gets one scroll
  // screen between boot and the session list. Tap = got it (never again on
  // this device); double-tap = later (returns next launch; the panel card
  // keeps showing it meanwhile). Presented only on the success path — over
  // 'setup'/'error' it would bury the connection hint behind a screen whose
  // fix needs the phone anyway, and the panel banner still covers that case.

  /** Queue unseen notices and present the interstitial, at most once per launch. */
  private maybePresentNotices(): void {
    if (!this.glasses || this.noticesPresented) return
    this.noticeQueue = unseenNotices()
    if (this.noticeQueue.length === 0) return
    this.noticesPresented = true
    this.go('notice')
  }

  /** Tap on the notice screen: acknowledge the shown notice. `dismissNotice`
   *  advances to the next queued one or lands on the session list. */
  private ackNotice(): void {
    const n = this.noticeQueue[0]
    if (n) this.dismissNotice(n.id)
    else this.go('list')
  }

  /** Double-tap on the notice screen: set the whole queue aside for this
   *  launch WITHOUT marking anything seen — it comes back next launch. */
  private snoozeNotices(): void {
    this.noticeQueue = []
    this.go('list')
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
    const rc = this.rc
    const list = await rc.listActive()
    if (this.rc !== rc) return
    // The bridge orders by recent activity, which CHURNS between polls — on the
    // glasses every reorder is a list rebuild that yanks the highlight to the
    // top mid-scroll, and a tap can land on a different session than the one
    // the wearer picked. Sort by title (id tiebreak) so rows hold still; the
    // status dot already says which sessions are busy. Pins lead, as they do
    // in claude.ai's sidebar: a pin moves only when the wearer moves it.
    list.sort(
      (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
    )
    const previous = new Map(this.sessions.map((s) => [s.id, s.workerStatus]))
    for (const s of list) {
      const was = previous.get(s.id)
      if (was && was !== 'requires_action' && s.workerStatus === 'requires_action') this.notify(s.id, s.title, 'needs you')
      else if ((was === 'running' || was === 'requires_action') && s.workerStatus === 'idle') this.notify(s.id, s.title, 'finished')
    }
    this.sessions = list
    this.sessionListPage = Math.min(this.sessionListPage, this.sessionPageCount() - 1)
    // The firmware owns the list highlight now, so no cursor to clamp here.
    // Keep the open session's metadata fresh, and detect if it went inactive.
    if (this.sid) {
      const still = list.find((s) => s.id === this.sid)
      if (still) {
        this.session = still
        this.panel.refreshSession(still)
      }
    }
    this.panel.setSessions(this.sessions, this.sid)
  }

  /** One poll at a time: a fetch to a bridge that has dropped off the network
   *  can hang far longer than POLL_MS, and the ticks would pile up behind it. */
  private async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await this.pollOnce()
    } finally {
      this.polling = false
    }
    // Every tick, on every screen: a no-op while the glass matches (the display
    // diffs), and the repaint when a write was dropped. Without it a screen
    // whose write failed stayed wrong until something else changed it — and a
    // prompt whose list never landed took no taps (promptTapOk).
    this.render()
  }

  private async pollOnce(): Promise<void> {
    // The connection screens: a bridge that couldn't be reached may be back (it
    // was started after the app, the phone found its network again), so try
    // again without waiting for a tap. Any other error stays up until one.
    if (this.state === 'error' || this.state === 'setup') {
      if (this.connBridge === 'down') await this.checkAuthAndLoad()
      return
    }
    if (this.state === 'boot') return // the first connect is still under way
    const rc = this.rc
    try {
      await this.refreshSessions()
      if (this.rc !== rc) return
      if (this.connBridge === 'down') {
        const who = await rc.whoami()
        if (this.rc !== rc) return
        setBridgeDictation(who.local_stt === true)
        this.panel.setConnection({ bridge: 'ok', whoami: who, origin: this.origin, state: this.state })
      }
      this.setConn('ok')
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
      // A stream given up on comes back with the bridge: it just answered,
      // and still lists the session. (Not while an attempt is still dialling.)
      if (this.streamLost && !this.streamClose && this.sid) this.openStream()
    } catch {
      if (this.rc !== rc) return
      // Transient; the next tick retries. What's on screen is stale meanwhile,
      // and says so.
      this.setConn('down')
    }
  }

  /** Note whether the bridge answered the last poll. Shown as it changes: the
   *  panel's chip, the session list's header, the session view's footer. */
  private setConn(bridge: 'ok' | 'down'): void {
    if (this.connBridge === bridge) return
    this.connBridge = bridge
    this.render()
  }

  // ── open / close a session ─────────────────────────────────────────────
  private async openSession(sid: string): Promise<void> {
    if (this.sid) this.backToList()
    const run = ++this.openSeq
    this.pendingSend = null
    this.dropStream()
    this.deferredRead = null
    this.log.clear()
    this.lastSeq = 0
    this.resetSessionView()
    this.resetPrompts()
    this.resetSessionExtras()
    try {
      // Together: the session (409s if not active) and its history — the NEWEST
      // events, oldest→newest, reaching back to some conversation.
      const [session, history] = await Promise.all([this.rc.getSession(sid), this.rc.getHistoryPage(sid)])
      // Overtaken while the bridge answered — a second tap, another row, Back.
      // The newer open (or the list) owns the log, the stream and the screen;
      // carrying on would pour this session's events into them.
      if (run !== this.openSeq) return
      this.sid = sid
      this.session = session
      this.recentHistory = { ...history, events: history.events.slice() }
      for (const ev of history.events) {
        this.log.append(ev)
        this.noteEvent(ev)
        if (ev.sequenceNum != null) this.lastSeq = Math.max(this.lastSeq, ev.sequenceNum)
      }
      this.panel.setActiveSession(this.session)
      this.panel.setWorkerState(this.worker)
      this.panel.setTasks(this.tasks)
      this.panel.setEvents(history.events, history.before)
      // A session that is blocked on the user RIGHT NOW opens straight onto its
      // prompt: every control_request with no resolution after it (answered
      // ones are followed by their control_response / the turn's result),
      // oldest first, cross-checked against the session's own blocked status.
      if (this.session?.workerStatus === 'requires_action') {
        for (const pending of findPendingControls(history.events)) this.queuePrompt(pending)
      }
      this.openStream()
      this.markRead()
      this.go('session')
    } catch (e) {
      if (run !== this.openSeq) return
      if (e instanceof BridgeError && e.isInactive) {
        this.panel.setToast('That session is no longer active.')
        await this.leaveInactive()
      } else {
        // Non-inactive failure (network/500): drop the half-open session identity
        // so the list doesn't keep showing this session as "open". A bridge that
        // couldn't be reached is retried by the poll (see pollOnce).
        if (e instanceof BridgeError && e.status === 0) this.setConn('down')
        this.dropStream()
        this.sid = null
        this.session = null
        this.log.clear()
        this.panel.setActiveSession(null)
        this.fail(`Could not open session.\n${(e as Error).message}`)
      }
    }
  }

  /** Clear the open session's unread mark: it is being read, here, as it would
   *  be in claude.ai — so only while someone can be looking (the app in front
   *  on the glasses; without glasses, the page visible). Best-effort and
   *  silent: an older bridge has no such route, and nothing waits on it. */
  private markRead(): void {
    const sid = this.sid
    if (!sid) return
    const watched = this.glasses && !this.glasses.unavailable
      ? this.foreground && !this.blanked && !this.waking &&
        (this.deferredRead !== sid || (this.state === 'session' && this.histMode === 'live'))
      : document.visibilityState !== 'hidden'
    if (!watched) {
      this.deferredRead = sid
      return
    }
    this.deferredRead = null
    void this.rc.markRead(sid).catch(() => {})
  }

  private onDisplayPainted(): void {
    if (this.blanked || !this.foreground) return
    this.waking = false
    if (this.deferredRead && this.deferredRead === this.sid && this.state === 'session' && this.histMode === 'live') this.markRead()
  }

  /** (Re)open the open session's stream from the last event seen. Any stream
   *  still up is closed first, so two can never feed one log. */
  private openStream(): void {
    this.closeStream()
    if (!this.sid) return
    const sid = this.sid
    this.streamClose = this.rc.streamEvents(sid, this.lastSeq, {
      onEvent: (ev) => this.onSessionEvent(ev),
      onError: (err) => this.onStreamError(err),
      onOpen: () => {
        this.streamRetries = 0
        this.streamLost = false
        this.setStreamDown(false)
      },
    })
  }

  /** Close the stream and call off any pending reopen. */
  private closeStream(): void {
    this.streamClose?.()
    this.streamClose = null
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer)
    this.streamRetryTimer = null
  }

  /** Close the stream for good (the session is being opened afresh, or left). */
  private dropStream(): void {
    this.closeStream()
    this.streamRetries = 0
    this.streamDown = false
    this.streamLost = false
  }

  /** The open session answered 409: it was archived or its worker is gone.
   *  Back to the list — refreshed, if the bridge will, so it's no longer there. */
  private async leaveInactive(): Promise<void> {
    try {
      await this.refreshSessions()
    } catch {
      /* the poll refreshes it soon enough */
    }
    this.backToList()
  }

  private setStreamDown(down: boolean): void {
    if (this.streamDown === down) return
    this.streamDown = down
    if (this.state === 'session') this.render() // the footer's live / offline tag
  }

  private onSessionEvent(ev: RcEvent): void {
    if (ev.sequenceNum != null) this.lastSeq = Math.max(this.lastSeq, ev.sequenceNum)
    // A replayed event (an SSE reconnect's catch-up window) must never
    // re-trigger UI — the log's sequenceNum dedupe is the gate for everything
    // below, most importantly the blocking-prompt routing.
    if (!this.log.append(ev)) return
    if (ev.type === 'conversation_reset' && !ev.parentToolUseId) this.recentHistory = { events: [], before: null }
    this.recentHistory.events.push(ev)
    if (this.recentHistory.events.length > 1200) {
      this.recentHistory.events.shift()
      if (this.recentHistory.before !== undefined) this.recentHistory.before = this.recentHistory.events[0]?.sequenceNum
    }
    this.noteEvent(ev)
    if (ev.type === 'result' && !ev.parentToolUseId && this.session) this.notify(this.session.id, this.session.title, 'finished')
    this.panel.appendEvent(ev)
    // Prompt-resolution signals: an answer echoed back through the log (ours or
    // another controller's) retires that prompt, and so does the worker
    // withdrawing it (answered at the terminal); a turn-ending result retires
    // them all (the CLI is no longer waiting on anything).
    if (settlesPrompt(ev) && ev.requestId) this.resolvePromptRemotely(ev.requestId)
    if (ev.type === 'result' && !ev.parentToolUseId) {
      this.dropAllPrompts('Turn ended.')
      this.markRead() // the turn ended in front of the wearer
    }
    if (ev.type === 'conversation_reset' && !ev.parentToolUseId) this.onConversationReset()
    // A fresh blocking control — a QUESTION (pick an option) or a
    // tool-permission (allow/deny) — joins the prompt queue; queuePrompt decides
    // whether it can show now or must wait for the wearer.
    if (ev.isBlockingControl && ev.permissionRequest && ev.requestId) this.queuePrompt(ev)
    // Re-render the session on every event: in 'live' the body follows to the
    // newest tail; in 'history' the body is frozen, so render() only refreshes
    // the (separate) header/footer containers and the native scroll stays put.
    if (this.state === 'session') this.render()
  }

  /** The session's conversation was discarded (/clear and friends, from any
   *  controller). The log and the panel have dropped their transcripts; this
   *  drops the rest of what belonged to it: its prompts, a history window frozen
   *  on old lines, and the aside on show or still in flight. */
  private onConversationReset(): void {
    this.dropAllPrompts('Conversation cleared.')
    this.resetSessionView()
    this.dismissAside()
  }

  /** Track the open session's live settings and background tasks. A status
   *  event carries only the permission mode, so merge — never let its nulls
   *  erase the model or effort an init reported. */
  private noteEvent(ev: RcEvent): void {
    if (ev.parentToolUseId) return
    if (ev.workerState) {
      const prev = this.worker ?? { model: null, effort: null, permissionMode: null, ccVersion: null }
      const next = { ...prev }
      for (const [k, v] of Object.entries(ev.workerState) as [keyof WorkerState, string | null][]) {
        if (v != null) next[k] = v
      }
      this.worker = next
      this.panel.setWorkerState(next)
    }
    if (ev.tasks) {
      this.tasks = ev.tasks
      this.panel.setTasks(ev.tasks)
    }
    // Follow-up asides mustn't carry the discarded conversation along. Here, not
    // in onConversationReset, so a clear that happened while away counts too.
    if (ev.type === 'conversation_reset' && this.sid) this.asideHistory.delete(this.sid)
  }

  /** Forget the open session's settings, tasks, aside and info (open / leave).
   *  Bumping the sequence numbers drops any answer still in flight. */
  private resetSessionExtras(): void {
    this.worker = null
    this.ctxShown.clear()
    this.tasks = []
    this.aside = null
    this.asideSeq++
    this.info = null
    this.infoError = null
    this.infoLoading = false
    this.infoSeq++
    this.clearHudNote()
    this.panel.setWorkerState(null)
    this.panel.setTasks([])
    this.panel.setAside(null)
    this.panel.setInfo(null)
  }

  /** The session's current effort: what the worker reported, else the session
   *  metadata, else the level this app last applied (`undefined` = unknown). */
  private currentEffort(): string | null | undefined {
    const sid = this.sid
    return this.worker?.effort ?? this.session?.effort ?? (sid ? this.effortBySid.get(sid) : undefined)
  }

  private currentMode(): string | null {
    return this.worker?.permissionMode ?? this.session?.permissionMode ?? null
  }

  private onStreamError(err: BridgeError): void {
    if (err.isInactive) {
      this.panel.setToast('Session ended (no longer active).')
      void this.leaveInactive()
      return
    }
    // Recoverable: the stream closed itself (the bridge's error frame, a refused
    // open, silence), so nothing reconnects it. Reopen from lastSeq a bounded
    // number of times; past that it is lost until the bridge answers a poll
    // again, which tries it once more each time (see pollOnce).
    this.streamClose = null
    this.setStreamDown(true)
    if (this.streamRetries >= STREAM_MAX_RETRIES) {
      if (!this.streamLost) this.panel.setToast(`Stream lost: ${err.message}`)
      this.streamLost = true
      return
    }
    this.streamRetries += 1
    this.panel.setToast(`Reconnecting stream… (${this.streamRetries})`)
    // closeStream() clears this timer, so it only ever fires for the session
    // (and the open) it was set for.
    this.streamRetryTimer = setTimeout(() => {
      this.streamRetryTimer = null
      this.openStream()
    }, STREAM_RETRY_DELAY_MS)
  }

  private backToList(): void {
    this.teardownVoice() // an involuntary exit must never leave the mic hot
    this.pendingSend = null // drop any unconfirmed send
    this.recentHistory = { events: [] }
    this.historyPages = []
    this.openSeq++ // an open still in flight must not bring its session back
    this.dropStream()
    this.sid = null
    this.deferredRead = null
    this.session = null
    this.log.clear()
    this.resetPrompts() // drop the prompt queue (clears permEvent + panel banners)
    this.resetSessionExtras()
    this.panel.setActiveSession(null)
    this.listSelectIndex = 0
    this.go('list')
  }

  /** Fire-and-forget dictation teardown for involuntary exits. Safe when idle. */
  private teardownVoice(): void {
    this.voiceRun++
    this.voiceStop = null
    this.voicePrefix = ''
    this.finishingRun = null
    void this.voice?.cancel()
    this.interim = ''
    this.panel.setInterim('')
    this.panel.setDictating(false)
  }

  // ── actions (shared by gestures and panel) ─────────────────────────────
  private async send(text: string): Promise<void> {
    const t = text.trim()
    if (!t || !this.sid) return
    if (isSlashInput(t)) {
      this.noteOnHud('Run slash commands in Claude on your phone')
      this.panel.setToast('Open in Claude to run that command.')
      return
    }
    try {
      await this.rc.send(this.sid, t)
      this.panel.setToast(`Sent: ${clip(t, 40)}`)
      if (this.hudNote) {
        this.clearHudNote() // a resend that went through un-says "not sent"
        if (this.state === 'session') this.render()
      }
    } catch (e) {
      this.onActionError(e, 'not sent')
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
    const sid = this.sid
    if (!sid) return
    const level = effort === 'auto' ? null : (effort as EffortLevel)
    try {
      const via = await this.rc.setEffort(sid, level)
      if (sid !== this.sid) return
      if (via === 'control') {
        this.effortBySid.set(sid, level)
        this.panel.setToast(`Effort → ${effort}`)
      } else if (via === 'command') {
        this.panel.setToast(`Sent /effort ${effort}. If the worker runs it, it also saves the host default.`)
      } else this.panel.setToast('Effort requested. Waiting for the worker to report it.')
    } catch (e) {
      if (sid === this.sid) this.onActionError(e)
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

  /** Pin or unpin the open session — claude.ai/code's pin, so it moves there
   *  too. Pins lead the session list; the refresh re-sorts it. */
  private async setPinned(pinned: boolean): Promise<void> {
    if (!this.sid) return
    try {
      const now = await this.rc.setPinned(this.sid, pinned)
      this.panel.setToast(now ? 'Pinned.' : 'Unpinned.')
      await this.refreshSessions()
    } catch (e) {
      this.onActionError(e)
    }
  }

  // ── side questions ("Ask aside") ────────────────────────────────────────
  // Answered from the session's conversation without interrupting it or
  // entering its transcript — one model call, no confirm step needed.

  /** Ask `question` on the side. From the glasses it opens the aside screen;
   *  from the panel only the panel's card shows it. Recent exchanges ride along
   *  so a follow-up reads in context. */
  private async askAside(question: string, from: 'glasses' | 'panel'): Promise<void> {
    const sid = this.sid
    const q = question.trim()
    if (!sid || !q) return
    const seq = ++this.asideSeq
    this.aside = { question: q, answer: null, error: null }
    this.panel.setAside(this.aside)
    if (from === 'glasses') this.go('aside')
    else if (this.state === 'aside') this.render() // the glasses were showing the last one
    const history = this.asideHistory.get(sid) ?? []
    try {
      const answer = await this.rc.ask(sid, q, history)
      if (seq !== this.asideSeq) return // replaced, or the session was left
      this.aside = { question: q, answer: answer ?? 'No answer: the session has no conversation yet.', error: null }
      if (answer) this.asideHistory.set(sid, [...history, { question: q, response: answer }].slice(-ASIDE_HISTORY))
    } catch (e) {
      if (seq !== this.asideSeq) return
      if (e instanceof BridgeError && e.isInactive) return this.onActionError(e)
      this.aside = { question: q, answer: null, error: workerError(e, 'side questions') }
    }
    this.panel.setAside(this.aside)
    if (this.state === 'aside') this.render()
  }

  /** The panel card's ×: forget the shown exchange (its history stays). */
  private dismissAside(): void {
    this.aside = null
    this.asideSeq++
    this.panel.setAside(null)
    if (this.state === 'aside') this.go('session')
  }

  // ── session info ─────────────────────────────────────────────────────────
  private openInfo(): void {
    this.go('info')
    void this.loadInfo()
  }

  /** Ask the worker for plan usage + git changes (the rest of the info screen
   *  is already known). One fetch at a time: each leaves control events in the
   *  session's log, so a burst of taps mustn't multiply them. */
  private async loadInfo(section: InfoSection = 'all'): Promise<void> {
    const sid = this.sid
    if (!sid || (this.infoLoading && this.infoSection === section)) return
    if (this.infoSection !== section) this.info = null
    this.infoSection = section
    const seq = ++this.infoSeq
    this.infoLoading = true
    this.panel.setInfo({ info: this.info, error: null, loading: true })
    if (this.state === 'info') this.render()
    try {
      const info = await this.rc.info(sid, section)
      if (seq !== this.infoSeq) return
      this.info = info
      this.infoError = null
    } catch (e) {
      if (seq !== this.infoSeq) return
      if (e instanceof BridgeError && e.isInactive) return this.onActionError(e)
      this.infoError = workerError(e, section === 'all' ? 'plan usage + changes' : section)
    } finally {
      if (seq === this.infoSeq) this.infoLoading = false
    }
    this.panel.setInfo({ info: this.info, error: this.infoError, loading: false })
    if (this.state === 'info') this.render()
  }

  private async stopTask(taskId: string): Promise<void> {
    if (!this.sid) return
    try {
      await this.rc.stopTask(this.sid, taskId)
      this.panel.setToast('Task stopped.')
    } catch (e) {
      this.onActionError(e)
    }
  }

  private async answerPermission(decision: Decision, message?: string, sessionRule?: string): Promise<void> {
    const ev = this.permEvent
    const id = ev?.requestId
    const run = this.openSeq
    // answeredIds is also the "already on its way" mark: a second tap while the
    // first answer is in flight must not send it twice.
    if (!this.sid || !ev || !id || this.answeredIds.has(id)) return
    this.answeredIds.add(id) // …and a replay must never resurrect it
    try {
      await this.rc.answerPermission(this.sid, {
        requestId: id,
        toolUseId: ev.toolUseId,
        decision, message, sessionRule,
        updatedInput: decision === 'allow' ? ev.permissionRequest?.input ?? undefined : undefined,
      })
      if (run !== this.openSeq) return
      this.panel.setToast(decision === 'allow' ? 'Allowed.' : 'Denied.')
    } catch (e) {
      if (run === this.openSeq) this.onAnswerError(e, id)
      return
    }
    if (this.retirePrompt(id) && this.onPromptScreen()) this.go('session') // presents any next prompt
  }

  /** An answer didn't get through. The session is still blocked on the prompt,
   *  so it stays armed and on screen for another try — leaving was the only
   *  sign of success the glasses give. (A session gone inactive leaves anyway.) */
  private onAnswerError(e: unknown, requestId: string): void {
    this.onActionError(e)
    if (!(e instanceof BridgeError && e.isInactive)) this.answeredIds.delete(requestId)
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
    if (ev.permissionRequest?.subtype === 'request_user_dialog') {
      this.dialogQuestions = []
      this.panel.showExternalDialog()
    } else if (isQuestionRequest(ev)) {
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
      this.resetPicks()
      this.panel.setDialog(this.dialogQuestions, this.qPicks, this.qDone)
    } else {
      this.dialogQuestions = []
      this.resetPicks()
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
    if (this.session) this.notify(this.session.id, this.session.title, 'needs you')
    this.promptDeferred = false
    this.promptSnoozed = false // reopening it clears the "answer later" hold
    this.listSelectIndex = 0
    this.state = isQuestionRequest(ev) ? 'question' : 'permission'
    this.render()
  }

  /** Whether a tap on a prompt's list is one to act on: the list on the glass
   *  must be THIS prompt's as it stands now (not a screen still under the
   *  wearer's finger while the build crosses BLE, not the previous question,
   *  not the rows from before a toggle), and it must have been there for
   *  PROMPT_TAP_GUARD_MS. Every way a prompt's list changes is a rebuild — it
   *  presents itself or is opened, the next question follows, a pick-any
   *  option toggles, Details is left — so one test covers them all. A list
   *  that never lands (a dropped write) takes no tap until the poll's render
   *  repaints it. */
  private promptTapOk(): boolean {
    const layout = this.layout()
    if (layout.kind !== 'list' || !this.glasses?.showsList(layout)) return false
    return performance.now() - this.listBuiltAt >= PROMPT_TAP_GUARD_MS
  }

  /** The glasses are on the armed prompt: its list, or its details. */
  private onPromptScreen(): boolean {
    return this.state === 'permission' || this.state === 'question' || this.state === 'detail' || this.state === 'reply' || this.state === 'replyDetail' || (this.state === 'voice' && (this.voicePurpose === 'other' || this.voicePurpose === 'deny'))
  }

  /** Read the armed prompt in full: a permission's whole input (the header
   *  holds two rows of it), or a question with every option's description.
   *  Decides nothing — a tap or a double-tap goes back to the Allow / Deny or
   *  option list. The text is fixed here, so the body the firmware scrolls
   *  never changes under the reader. */
  private openPromptDetail(): void {
    const ev = this.permEvent
    if (!ev) return
    const text = hudSafe(
      isQuestionRequest(ev)
        ? questionDetail(this.dialogQuestions, this.qIndex)
        : inputDetail(ev.permissionRequest?.input ?? null),
    )
    const head = clampBytes(text, DETAIL_BYTES, 'head')
    this.detailBody = head.length < text.length ? `${head}\n${HUD.ELL} (the rest is on the phone panel)` : head
    this.go('detail')
  }

  /** Leave the details for the prompt's list — or the session, if the prompt
   *  was settled meanwhile. */
  private closePromptDetail(): void {
    this.promptReply = null
    if (this.permEvent) this.presentPrompt()
    else this.go('session')
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

  /** Retire prompt `id` after WE answered/dismissed it. Returns whether it was
   *  still the armed one — then its screen state is cleared and any next prompt
   *  armed (which defers; the caller's go('session') presents it). If something
   *  else retired it while the answer was in flight (the turn ended), whatever
   *  is armed now is another prompt and is left alone. */
  private retirePrompt(id: string): boolean {
    this.answeredIds.add(id)
    this.prompts = this.prompts.filter((p) => p.requestId !== id)
    if (this.permEvent?.requestId !== id) return false
    this.clearPromptState()
    if (this.prompts.length) this.armPrompt()
    return true
  }

  /** The stream says prompt `requestId` is over — if it is still queued here,
   *  someone else answered it (another controller) or the worker withdrew it
   *  (answered at the terminal): retire it without sending anything. */
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
    if (this.onPromptScreen()) this.go('session')
  }

  /** Retire every queued prompt (the turn ended / the block vanished). */
  private dropAllPrompts(msg: string): void {
    if (this.prompts.length === 0) return
    for (const p of this.prompts) if (p.requestId) this.answeredIds.add(p.requestId)
    this.prompts = []
    this.clearPromptState()
    if (this.onPromptScreen()) {
      this.panel.setToast(msg)
      this.go('session')
    }
  }

  /** Clear the armed prompt's screen/panel state (queue bookkeeping is separate). */
  private clearPromptState(): void {
    this.promptReply = null
    if (this.state === 'voice' && (this.voicePurpose === 'other' || this.voicePurpose === 'deny')) this.teardownVoice()
    this.permEvent = null
    this.dialogQuestions = []
    this.resetPicks()
    this.detailBody = ''
    this.promptDeferred = false
    this.promptSnoozed = false
    this.panel.setPermission(null)
    this.panel.setDialog(null, [], [])
  }

  /** Start the armed question's answers over. */
  private resetPicks(): void {
    this.qIndex = 0
    this.qPicks = []
    this.qDone = []
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

  /** The question screen's rows, top to bottom: the options (a multi-select's
   *  marked picked / not), Submit for a multi-select, Details, Dismiss. */
  private questionRows(): QuestionRow[] {
    if (this.permEvent?.permissionRequest?.subtype === 'request_user_dialog') {
      return [{ kind: 'later', text: 'Set aside' }]
    }
    const q = this.dialogQuestions[this.qIndex]
    const picks = this.qPicks[this.qIndex] ?? []
    const rows: QuestionRow[] = this.optionsFor(q).map((o) => ({
      kind: 'option',
      label: o.label,
      text: q?.multiSelect ? `${picks.includes(o.label) ? HUD.RUN : HUD.IDLE} ${optionLabel(o)}` : optionLabel(o),
    }))
    if (this.voice?.available) rows.push({ kind: 'other', text: 'Dictate other answer' })
    // Submit shows once there is something to submit (the list is rebuilt on
    // every toggle anyway), so there is no row that would do nothing.
    if (q?.multiSelect && picks.length) rows.push({ kind: 'submit', text: `${HUD.SEND} Submit (${picks.length})` })
    rows.push({ kind: 'details', text: `Details ${HUD.GO}` })
    rows.push({ kind: 'dismiss', text: `${HUD.BACK} Dismiss` })
    return rows
  }

  /** Tap in the question screen: act on the highlighted row. */
  private pickHighlighted(): void {
    const row = this.questionRows()[this.listSelectIndex]
    if (!row) return
    if (row.kind === 'later') this.snoozePrompt()
    else if (row.kind === 'other') this.startPromptReply('other')
    else if (row.kind === 'option') this.recordPick(this.qIndex, row.label)
    else if (row.kind === 'submit') this.confirmPicks(this.qIndex)
    else if (row.kind === 'details') this.openPromptDetail()
    else void this.submitQuestion('cancelled')
  }

  /** An option was chosen (a gesture or the panel). A single-select question
   *  is settled by it; a multi-select toggles it, and is settled by Submit
   *  (confirmPicks). Until 1.10.0 every question took one pick and moved on,
   *  so a "pick any" question could only ever be answered with one option. */
  private recordPick(qIndex: number, label: string): void {
    const q = this.dialogQuestions[qIndex]
    if (!q) return
    if (q.multiSelect) {
      const picks = this.qPicks[qIndex] ?? []
      this.qPicks[qIndex] = picks.includes(label) ? picks.filter((l) => l !== label) : [...picks, label]
      this.qDone[qIndex] = false
      this.panel.setDialog(this.dialogQuestions, this.qPicks, this.qDone)
      if (this.state === 'question') this.render() // the rebuilt list highlights row 0 again
      return
    }
    this.qPicks[qIndex] = [label]
    this.qDone[qIndex] = true
    this.advanceQuestion()
  }

  /** Submit on a multi-select question: its picks stand. */
  private confirmPicks(qIndex: number): void {
    if (!this.dialogQuestions[qIndex]?.multiSelect) return
    if (!this.qPicks[qIndex]?.length) {
      this.panel.setToast('Pick at least one option, or dismiss the question.')
      return
    }
    this.qDone[qIndex] = true
    this.advanceQuestion()
  }

  /** A question was settled: send the answers once all are, else show the next. */
  private advanceQuestion(): void {
    this.panel.setDialog(this.dialogQuestions, this.qPicks, this.qDone)
    const next = this.dialogQuestions.findIndex((_, i) => !this.qDone[i])
    if (next < 0) {
      void this.submitQuestion('completed')
      return
    }
    this.qIndex = next
    this.listSelectIndex = 0
    if (this.state === 'question') this.render()
  }

  /** Send the answer (or a cancel) back through the bridge's /dialog route. */
  private async submitQuestion(status: 'completed' | 'cancelled'): Promise<void> {
    const ev = this.permEvent
    const id = ev?.requestId
    const run = this.openSeq
    if (!this.sid || !ev || !id) {
      this.clearPromptState()
      if (this.onPromptScreen()) this.go('session')
      return
    }
    if (this.answeredIds.has(id)) return // already on its way (see answerPermission)
    this.answeredIds.add(id) // …and a replay must never resurrect it
    const subtype = ev.permissionRequest?.subtype ?? ev.blockingSubtype ?? 'request_user_dialog'
    // A multi-select's picks go in the question's own order — and, to
    // AskUserQuestion (a `can_use_tool`), as ONE comma-separated string: the
    // tool takes a string per question ("multi-select answers are
    // comma-separated"). Joined here, so a bridge older than 0.6.0 (which would
    // have sent a list) gets it right too. A true dialog keeps the labels apart.
    const answers: DialogAnswer[] = this.dialogQuestions.map((q, i) => {
      const picks = this.qPicks[i] ?? []
      const ordered = q.options.map((o) => o.label).filter((l) => picks.includes(l))
      ordered.push(...picks.filter((label) => !ordered.includes(label)))
      const options = !q.multiSelect || !ordered.length ? picks : subtype === 'can_use_tool' ? [ordered.join(', ')] : ordered
      return { header: q.header, question: q.question, options }
    })
    try {
      await this.rc.answerDialog(this.sid, {
        requestId: id,
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
      if (run !== this.openSeq) return
      this.panel.setToast(
        status === 'completed' ? `Answered: ${clip(answers[0]?.options[0] ?? '', 30)}` : 'Question dismissed.',
      )
    } catch (e) {
      if (run !== this.openSeq) return
      this.onAnswerError(e, id)
      // Still unanswered: start its picks over, so the next one re-submits.
      if (this.permEvent?.requestId === id) {
        this.resetPicks()
        this.panel.setDialog(this.dialogQuestions, this.qPicks, this.qDone)
        if (this.state === 'question') this.render()
      }
      return
    }
    if (this.retirePrompt(id) && this.onPromptScreen()) {
      // Either path presents the next queued prompt, if there is one.
      if (status === 'completed') this.goLiveSession() // answered → watch it continue
      else this.go('session')
    }
  }

  /** An action failed. A session gone inactive is left; anything else is said
   *  on both surfaces — `what` leads the glasses' note (`not sent: …`). */
  private onActionError(e: unknown, what = 'failed'): void {
    if (e instanceof BridgeError && e.isInactive) {
      this.panel.setToast('Session is no longer active.')
      void this.leaveInactive()
    } else {
      this.panel.setToast(`Error: ${(e as Error).message}`)
      this.noteOnHud(`${what}: ${(e as Error).message}`)
    }
  }

  /** Show `msg` in the session footer for a few seconds (see `hudNote`). */
  private noteOnHud(msg: string): void {
    this.clearHudNote()
    this.hudNote = clip(hudSafe(msg), 48, HUD.ELL)
    this.hudNoteTimer = setTimeout(() => {
      this.clearHudNote()
      if (this.state === 'session') this.render()
    }, HUD_NOTE_MS)
    if (this.state === 'session') this.render()
  }

  /** Drop the footer note: it timed out, was overtaken, or its session was left. */
  private clearHudNote(): void {
    if (this.hudNoteTimer) clearTimeout(this.hudNoteTimer)
    this.hudNoteTimer = null
    this.hudNote = ''
  }

  // ── voice dictation ────────────────────────────────────────────────────
  private startPromptReply(kind: PromptReply['kind']): void {
    const p = this.permEvent
    if (!p?.requestId) return
    this.promptReply = { id: p.requestId, index: this.qIndex, kind, text: '' }
    if (kind === 'rule') {
      this.promptReply.text = p.permissionRequest?.sessionRule ?? ''
      this.go('reply')
    } else void this.startVoice(kind, 'glasses')
  }

  private reviewPromptText(text: string): void {
    const reply = this.promptReply
    if (!reply || reply.id !== this.permEvent?.requestId || reply.index !== this.qIndex) {
      this.closePromptDetail()
      return
    }
    reply.text = text
    if (text) this.go('reply')
    else this.closePromptDetail()
  }

  private commitReply(): void {
    const reply = this.promptReply
    if (!reply || reply.id !== this.permEvent?.requestId || reply.index !== this.qIndex) return
    if (reply.kind === 'rule') void this.answerPermission('allow', undefined, reply.text)
    else if (reply.kind === 'deny') void this.answerPermission('deny', reply.text)
    else {
      this.promptReply = null
      this.presentPrompt()
      this.recordPick(reply.index, reply.text)
    }
  }

  private async startVoice(purpose: VoicePurpose, from: 'panel' | 'glasses', prefix = ''): Promise<void> {
    if (!this.sid || (this.state === 'voice' && !this.voiceStop)) return
    if (!this.voice || this.glasses?.unavailable) {
      this.panel.setToast('Open Claude Remote in the Even app with connected glasses to dictate.')
      return
    }
    if (!this.voice.available) {
      this.panel.setToast(currentSttSource() === 'bridge' ? 'Local dictation is not running on the bridge.' : 'Voice dictation needs a Deepgram key.')
      return
    }
    if (purpose === 'send' || purpose === 'aside') this.promptReply = null
    this.voicePurpose = purpose
    this.voiceFrom = from
    this.voicePrefix = prefix
    this.voiceStatus = 'connecting'
    // Words a stopped dictation still held (only the panel can start one over
    // the stopped screen): keep them, in the send box.
    if (this.voiceStop?.text) this.panel.appendDraft(this.voiceStop.text)
    this.voiceStop = null
    const run = ++this.voiceRun
    this.interim = ''
    this.panel.setDictating(true)
    this.go('voice')
    await this.voice.start({
      onInterim: (t) => {
        if (run !== this.voiceRun) return
        this.interim = t
        this.panel.setInterim(t)
        if (this.state === 'voice') this.render()
      },
      onStatus: (s, detail) => {
        if (run !== this.voiceRun) return
        if (s === 'error') void this.finishDictation(detail || 'Voice error.')
        // 'idle' only passes through on the way out (a stop, or just before an
        // error), so it never reaches the header.
        else if (s !== 'idle' && s !== this.voiceStatus) {
          if (s === 'downloading model') {
            this.panel.setToast('First use: the bridge is downloading the dictation model. Dictation starts once it is ready, which can take a few minutes.', 8000)
          }
          this.voiceStatus = s
          if (this.state === 'voice') this.render()
        }
      },
    })
  }

  /** Stop the mic, clear the dictation UI, and return the trimmed transcript —
   *  or null when the caller must back off: another finish of this run is
   *  under way (a double "done" — two quick taps, a double-clicked Stop — then
   *  neither splits the transcript nor sends it twice), or a newer dictation
   *  began while this one finished, so the UI is no longer this one's. */
  private async finishDictation(failure?: string): Promise<string | null> {
    if (!this.voice) return ''
    const run = this.voiceRun
    if (this.finishingRun === run) return null
    this.finishingRun = run
    if (this.state === 'voice') this.render() // "Finishing..." at once
    try {
      let text: string
      try {
        text = await this.voice.stop()
      } catch (err) {
        text = this.interim
        failure = (err as Error).message || 'Could not finish dictation.'
      }
      if (run !== this.voiceRun) return null
      this.interim = ''
      this.panel.setInterim('')
      this.panel.setDictating(false)
      if (failure) {
        this.keepFailedDictation(text, failure)
        return null
      }
      return text
    } finally {
      if (this.finishingRun === run) this.finishingRun = null
    }
  }

  /** Panel Stop button: finish dictating and send straight away — an explicit
   *  press on a real button, not a stray glasses tap, so no confirm step. (A
   *  side question dictated on the glasses is still asked, not sent.) */
  private async commitVoice(): Promise<void> {
    if (this.state !== 'voice' || this.voiceStop) return
    const text = await this.finishDictation()
    if (text === null) return // a finish already under way owns the result
    if (this.voicePurpose === 'other' || this.voicePurpose === 'deny') {
      if (this.state === 'voice') this.reviewPromptText(text)
      return
    }
    if (this.voicePurpose === 'aside') {
      if (text) await this.askAside(text, 'glasses')
      else if (this.state === 'voice') this.go('session')
      return
    }
    const full = this.withPrefix(text)
    if (full) {
      // Consume this microphone run before a second gesture can finish it.
      const sent = this.send(full)
      this.goLiveSession()
      await sent
    } else this.go('session')
  }

  /** Glasses tap: finish dictating and REVIEW the transcript before it sends — a
   *  stray tap while dictating shouldn't fire a half-finished message. An empty
   *  transcript just drops back to the session. */
  private async reviewDictation(): Promise<void> {
    if (this.state !== 'voice' || this.voiceStop) return
    const text = await this.finishDictation()
    if (text === null) return // a finish already under way owns the result
    if (this.state !== 'voice') return // involuntarily left the voice screen meanwhile
    if (this.voicePurpose === 'other' || this.voicePurpose === 'deny') this.reviewPromptText(text)
    else if (this.voicePurpose === 'aside') {
      if (text) void this.askAside(text, 'glasses') // read-only: no confirm
      else this.go('session')
    } else if (this.withPrefix(text)) this.confirmSend(this.withPrefix(text), 'session')
    else this.go('session')
  }

  /** The dictation died (the captioner gave up, or the mic wouldn't open):
   *  say why, and stop showing "Listening" over a dead stream — without acting
   *  on the words, and without moving the glasses by itself. The wearer's next
   *  tap may be a "done" meant for the live voice screen, and on any other
   *  screen it would act: send from the confirm screen, answer a prompt that
   *  go() presents. So a glasses dictation stays on the voice screen, marked
   *  stopped, until a tap: a send's words wait there for review, and a
   *  half-dictated aside is dropped (asking it would spend a model call on a
   *  question the wearer never finished). A panel dictation's words go back
   *  into the send box, and the glasses leave quietly. */
  private keepFailedDictation(text: string, reason: string): void {
    this.panel.setToast(`Voice error: ${reason}`, 6000)
    if (this.state !== 'voice') return
    if (this.voiceFrom === 'panel') {
      if (text) this.panel.appendDraft(text)
      this.leaveVoiceQuietly()
      return
    }
    this.voiceStop = { reason, text: this.voicePurpose === 'send' ? this.withPrefix(text) : '' }
    this.render()
  }

  /** A tap on the stopped voice screen: review the words it held on the
   *  confirm screen, or go back to the session when there are none. */
  private reviewStoppedDictation(): void {
    const text = this.voiceStop?.text ?? ''
    this.voiceStop = null
    if (this.promptReply) this.closePromptDetail()
    else if (text) this.confirmSend(text, 'session')
    else this.go('session')
  }

  /** Double-tap: drop the dictation. `backgrounded` = the app lost the
   *  foreground mid-dictation, an involuntary exit (see leaveVoiceQuietly). */
  private cancelVoice(backgrounded = false): void {
    this.voiceRun++
    this.voiceStop = null
    void this.voice?.cancel()
    this.interim = ''
    this.panel.setInterim('')
    this.panel.setDictating(false)
    if (this.state !== 'voice') return
    if (backgrounded) {
      if (this.promptReply) this.promptDeferred = true
      if (this.voicePrefix) this.panel.appendDraft(this.voicePrefix) // the reviewed words aren't lost
      this.leaveVoiceQuietly()
    } else if (this.promptReply) this.closePromptDetail()
    // Cancelling more dictation returns to the message as it was.
    else if (this.voicePrefix) this.confirmSend(this.voicePrefix, 'session')
    else this.go('session')
  }

  /** Leave the voice screen for the session WITHOUT go(), after an exit the
   *  wearer didn't make (being backgrounded, a failed panel dictation): they
   *  may still tap meaning "done" on the voice screen, and go() would present
   *  a deferred prompt right under that tap — answering it. It keeps waiting
   *  behind the footer's "! needs you" instead. */
  private leaveVoiceQuietly(): void {
    this.state = 'session'
    this.render()
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

  /** A second Done may be in flight while the review is still crossing BLE. */
  private draftTapOk(): boolean {
    return !!this.pendingSend && !!this.glasses?.showsDraft(this.pendingSend, PROMPT_TAP_GUARD_MS)
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
    if (e.sysEvent?.imuData) {
      this.onImu(e.sysEvent.imuData)
      return
    }
    // On native-list pages the firmware moves the highlight itself and reports
    // the selected row here (on both scroll and tap) — track it for onTap. When
    // the index is absent (protobuf drops index 0; some firmware omits it more
    // broadly) fall back to resolving the row by its reported item TEXT against
    // the labels actually on the glass, so a tap still fires the highlighted row
    // instead of whatever this last pointed at.
    let staleListRow = false
    if (e.listEvent) {
      const { currentSelectItemIndex: index, currentSelectItemName: name } = e.listEvent
      const items = this.glasses?.listItems ?? []
      if (typeof index === 'number') {
        staleListRow = !Number.isInteger(index) || index < 0 || index >= items.length || (!!name && items[index] !== name)
        if (!staleListRow) this.listSelectIndex = index
      } else if (name) {
        const i = items.indexOf(name)
        staleListRow = i < 0 || i !== items.lastIndexOf(name)
        if (!staleListRow) this.listSelectIndex = i
      }
    }
    // CLICK_EVENT is 0 and protobuf omits zero-value fields, so a tap arrives with
    // eventType === undefined → coalesce to CLICK.
    const code = envelope.eventType ?? CLICK
    if (GESTURES.has(code)) {
      if (!this.foreground || this.waking) return
      // A gesture is input: it resets the idle clock. On a blank screen it
      // only wakes it, so a blind tap can't act on a row nobody can see.
      const wasBlank = this.blanked || this.fadeStep > 0
      this.wake()
      if (wasBlank || staleListRow) return
    }
    switch (code) {
      case DOUBLE_CLICK:
        this.onDoubleTap()
        return
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        this.cleanup()
        return
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        // Backgrounded — never leave the mic hot, nor the voice screen up
        // claiming to listen over a closed one.
        // A stopped dictation has nothing live: it stays up, words and all.
        this.foreground = false
        // A return to this review must acknowledge it on the glass again.
        if (this.pendingSend) this.pendingSend = { ...this.pendingSend }
        this.stopFade()
        void this.syncImu()
        if (this.state === 'voice' && !this.voiceStop) void this.cancelVoice(true)
        else void this.voice?.cancel()
        return
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        // Back in front: a write made while hidden may have been dropped, which
        // leaves the mirror invalidated — render() repaints only if so. And an
        // open session is being read again.
        this.foreground = true
        void this.syncImu()
        this.wake() // a screen that blanked before leaving lights on return
        this.markRead()
        this.render()
        return
      case CLICK:
        this.onTap()
        return
      case OsEventTypeList.LONG_PRESS_EVENT:
        // A long press on a session starts dictating, as Compose → Dictate
        // does; a tap finishes it as usual. Elsewhere it does nothing.
        if (this.state === 'session' && this.voice?.available) void this.startVoice('send', 'glasses')
        // On the review of a dictated message: dictate more onto it.
        else if (this.state === 'confirm' && this.canDictateMore() && this.draftTapOk()) void this.startVoice('send', 'glasses', this.pendingSend?.text)
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
    // Session polling, page navigation and a wake can all change the row map
    // while a tap is crossing BLE. Only dispatch against an acknowledged list.
    const layout = this.layout()
    if (layout.kind === 'list' && !this.glasses?.showsList(layout)) return
    switch (this.state) {
      case 'list': {
        const row = this.sessionRows()[this.listSelectIndex]
        if (!row) break
        if (row.sid) void this.openSession(row.sid)
        else if (row.page !== undefined) {
          this.sessionListPage = row.page
          this.render()
        } else this.openSettings()
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
      case 'settings':
        this.fireSettings()
        break
      case 'settingPick':
        this.fireSettingPick()
        break
      case 'calibrate':
        this.recordCalibration()
        break
      case 'submenu':
        this.fireSubmenu()
        break
      case 'voice':
        if (this.voiceStop) this.reviewStoppedDictation()
        else void this.reviewDictation() // finish dictating → review before sending
        break
      case 'replyDetail':
        this.go('reply')
        break
      case 'confirm':
        if (this.draftTapOk()) this.commitPendingSend()
        break
      case 'reply':
        if (this.promptTapOk()) {
          if (this.listSelectIndex === 0) this.closePromptDetail()
          else if (this.listSelectIndex === 1) this.commitReply()
          else this.go('replyDetail')
        }
        break
      case 'permission':
        if (!this.promptTapOk()) break
        // The first three rows retain their positions on every permission.
        if (this.listSelectIndex === 0) void this.answerPermission('allow')
        else if (this.listSelectIndex === 1) void this.answerPermission('deny')
        else if (this.listSelectIndex === 2) this.openPromptDetail()
        else if (this.permissionLayout().items[this.listSelectIndex] === 'Deny with a note') this.startPromptReply('deny')
        else if (this.permissionLayout().items[this.listSelectIndex] === 'Allow for session') this.startPromptReply('rule')
        break
      case 'question':
        if (!this.promptTapOk()) break
        this.pickHighlighted() // an option, Submit, Details or Dismiss
        break
      case 'detail':
        this.closePromptDetail()
        break
      case 'aside':
        // Answered → ask a follow-up (the submenu; history rides along).
        if (this.aside?.answer != null || this.aside?.error) this.openSubmenu('aside')
        break
      case 'info':
        void this.loadInfo(this.infoSection) // tap = refresh
        break
      case 'notice':
        this.ackNotice() // got it — never shows again on this device
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
      case 'settings':
        this.listSelectIndex = 0
        this.go('list')
        break
      case 'settingPick':
      case 'calibrate':
        this.openSettings()
        break
      case 'submenu':
        this.go('compose')
        break
      case 'voice':
        void this.cancelVoice()
        break
      case 'replyDetail':
        this.go('reply')
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
      case 'reply':
      case 'detail':
        this.closePromptDetail() // back to its Allow / Deny or option list
        break
      case 'aside':
      case 'info':
        this.go('session') // an aside still being answered lands on the panel card
        break
      case 'notice':
        this.snoozeNotices() // dbl-tap = later — unseen, returns next launch
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

  /** Scrolled up off the live tail → freeze the newest lines into a history window. */
  private enterHistory(): void {
    const page = this.freezePage(this.recentHistory)
    if (!page.log.lineCount && page.before == null) return
    this.historyPages = [page]
    this.pageIndex = 0
    this.histMode = 'history'
    this.showOlderWindow(page.log, page.log.lineCount)
  }

  private freezePage(page: HistoryPage) {
    const log = new EventLog(Infinity)
    for (const event of page.events) log.append(event)
    return { log, before: page.before }
  }

  private showOlderWindow(log: EventLog, end: number): void {
    const w = log.windowBefore(end, HISTORY_WINDOW_BYTES)
    this.histEnd = end
    this.histTop = w.startLine
    this.histBody = w.text
    this.render()
  }

  private async historyOlder(): Promise<void> {
    const page = this.historyPages[this.pageIndex]
    if (!page) return
    if (this.histTop > 0) return this.showOlderWindow(page.log, this.histTop)
    let older = this.historyPages[this.pageIndex + 1]
    if (!older) {
      if (!this.sid || page.before == null || this.loadingPage === page.log) return
      this.loadingPage = page.log
      this.render()
      try {
        const result = await this.rc.getHistoryPage(this.sid, page.before)
        if (this.state !== 'session' || this.histMode !== 'history' || this.historyPages[this.pageIndex] !== page || this.histTop > 0) return
        const events = result.events.filter(e => e.sequenceNum != null && e.sequenceNum < page.before!)
        if (!events.length) {
          page.before = null
          return
        }
        older = this.freezePage({ events, before: result.before != null && result.before < page.before ? result.before : null })
        this.historyPages.push(older)
      } catch (e) {
        if (this.historyPages[this.pageIndex] === page) this.onActionError(e, 'history unavailable')
        return
      } finally {
        if (this.loadingPage === page.log) this.loadingPage = null
        this.render()
      }
    }
    this.pageIndex++
    this.showOlderWindow(older.log, older.log.lineCount)
  }

  private historyNewer(): void {
    let page = this.historyPages[this.pageIndex]
    if (!page) return this.enterLive()
    if (this.histEnd >= page.log.lineCount) {
      if (!this.pageIndex) return this.enterLive()
      page = this.historyPages[--this.pageIndex]
      this.histEnd = 0
    }
    const w = page.log.windowFrom(this.histEnd, HISTORY_WINDOW_BYTES)
    this.histTop = this.histEnd
    this.histEnd = w.endLine
    this.histBody = w.text
    this.render()
  }

  private enterLive(): void {
    this.historyPages = []
    this.loadingPage = null
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

  /** Jump to the tail because we just gave the session work (a send / dictate /
   *  answer) — that's what to watch now, even if the wearer had scrolled back. */
  private goLiveSession(): void {
    this.resetSessionView()
    this.go('session')
  }

  private isRunning(s: ActiveSession | null): boolean {
    return s?.workerStatus === 'running'
  }

  /** Every session opens on the tail: the row-budgeted newest lines always fit
   *  the body, so the latest output is immediately visible — auto-following if
   *  the session is running, simply sitting there if it's idle. Scrolling up
   *  drops into the frozen history windows either way. */
  private resetSessionView(): void {
    this.historyPages = []
    this.loadingPage = null
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
      pinned: this.session?.pinned,
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
        void this.startVoice('send', 'glasses')
        break
      case 'interrupt':
        void this.interrupt()
        this.go('session')
        break
      case 'info':
        this.openInfo()
        break
      case 'submenu':
        this.openSubmenu(action.menu)
        break
      case 'pin':
        void this.setPinned(action.pin)
        this.go('session')
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

  private openSubmenu(kind: SubmenuKind): void {
    this.submenuKind = kind
    this.submenu =
      kind === 'model'
        ? modelItems(this.worker?.model ?? this.session?.model ?? null)
        : kind === 'mode'
          ? modeItems(this.currentMode())
          : kind === 'effort'
            ? effortItems(this.currentEffort())
            : kind === 'aside'
              ? asideItems(!!this.voice?.available)
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
      this.go('info')
      void this.loadInfo(item.value === 'usage' ? 'usage' : 'context')
      return
    }
    if (this.submenuKind === 'aside') {
      if (item.value === ASIDE_DICTATE) void this.startVoice('aside', 'glasses')
      else void this.askAside(item.value, 'glasses')
      return
    }
    if (this.submenuKind === 'model') void this.applyModel(item.value)
    else if (this.submenuKind === 'mode') void this.applyMode(item.value as PermissionMode)
    else void this.applyEffort(item.value)
    this.go('session')
  }

  // ── settings: the glasses display ──────────────────────────────────────
  private settingsRows(): string[] {
    const d = displaySettings()
    return [
      `Blank after ${HUD.SEP} ${blankLabel(d.blankAfterS, d.lookWake && d.lookCal !== null)}`,
      `Wake on head tilt ${HUD.SEP} ${d.lookWake && d.lookCal ? tiltLabel(pitchDeg(d.lookCal.read) - pitchDeg(d.lookCal.rest)) : 'off'}`,
      ...(d.blankAfterS || (d.lookWake && d.lookCal) ? [`Session notifications ${HUD.SEP} ${d.notifyDone ? 'on' : 'off'}`] : []),
      `${HUD.BACK} Back`,
    ]
  }

  private openSettings(): void {
    this.listSelectIndex = 0
    this.go('settings')
    this.syncImu()
  }

  private fireSettings(): void {
    switch (this.listSelectIndex) {
      case 0:
        return this.openSettingPick('blank')
      case 1:
        return this.openSettingPick('lookWake')
      case 2:
        if (this.settingsRows().length === 4) return this.openSettingPick('notify')
        this.go('list')
        return
      default:
        this.listSelectIndex = 0
        this.go('list')
    }
  }

  private openSettingPick(kind: SettingKind): void {
    const d = displaySettings()
    const pick = (label: string, value: string, current: boolean): SubmenuItem => ({
      label: `${current ? `${HUD.CUR} ` : '  '}${label}`,
      value,
      current,
    })
    const look = d.lookWake && d.lookCal !== null
    this.settingKind = kind
    this.settingItems =
      kind === 'blank'
        ? BLANK_AFTER_CHOICES.map((v) => pick(blankLabel(v, look), String(v), v === d.blankAfterS))
        : kind === 'lookWake'
          ? [pick(look ? 'Set up again' : 'On (set up)', 'on', look), pick('Off', 'off', !look)]
          : [pick('On', 'on', d.notifyDone), pick('Off', 'off', !d.notifyDone)]
    this.settingItems.push({ label: `${HUD.BACK} Back`, value: '', current: false })
    this.listSelectIndex = 0
    this.go('settingPick')
  }

  private fireSettingPick(): void {
    const item = this.settingItems[this.listSelectIndex]
    if (item && item.value !== '') {
      // Head tilt wake is turned on by setting it up, which saves it on.
      if (this.settingKind === 'lookWake' && item.value === 'on') return this.startCalibration()
      const patch: Partial<DisplaySettings> =
        this.settingKind === 'blank'
          ? { blankAfterS: Number(item.value) }
          : this.settingKind === 'lookWake'
            ? { lookWake: false }
            : { notifyDone: item.value === 'on' }
      saveDisplaySettings(patch)
      void this.persistSettings()
      this.panel.refreshDisplaySettings()
    }
    this.openSettings()
  }

  // ── head tilt wake setup: the normal position, then the waking one ─────
  private startCalibration(): void {
    this.calStep = 0
    this.calRest = null
    this.calNote = ''
    this.imu = null
    this.go('calibrate')
    this.syncImu()
  }

  private calibrateLayout(): Layout {
    const step =
      this.calStep === 0
        ? 'Hold your head in its normal position, then tap.'
        : 'Tilt your head to where the screen should turn on, then tap.'
    const v = this.imu
    const now = !v
      ? 'Waiting for the motion sensor...'
      : this.calRest
        ? `Now: ${tiltLabel(pitchDeg(v))} ${HUD.SEP} ${tiltLabel(pitchDeg(v) - pitchDeg(this.calRest))} from normal`
        : `Now: ${tiltLabel(pitchDeg(v))}`
    return {
      kind: 'scroll',
      header: `Set up head tilt wake ${HUD.SEP} ${this.calStep + 1} of 2`,
      body: [step, now, this.calNote].filter(Boolean).join('\n\n'),
      footer: `tap = record ${HUD.SEP} dbl = cancel`,
    }
  }

  private recordCalibration(): void {
    const v = this.imu
    if (!v) {
      this.calNote = 'No motion readings yet. Wait a moment and tap again.'
      return this.render()
    }
    if (this.calStep === 0) {
      this.calRest = v
      this.calStep = 1
      this.calNote = ''
      return this.render()
    }
    const rest = this.calRest!
    if (angleDeg(rest, v) < MIN_CAL_DEG) {
      this.calNote = 'That is too close to the normal position. Tilt further and tap again.'
      return this.render()
    }
    saveDisplaySettings({ lookCal: { rest, read: v }, lookWake: true })
    void this.persistSettings()
    this.panel.refreshDisplaySettings()
    this.headUp = true // the head is in the waking position right now
    this.openSettings()
  }

  // ── blanking, head tilt wake and the done mark ─────────────────────────
  /** Motion reports run while head tilt wake can use them, or setup needs
   *  them. */
  private async syncImu(): Promise<void> {
    const d = displaySettings()
    const want = this.foreground && ((d.lookWake && d.lookCal !== null) || this.state === 'calibrate')
    if (!this.bridge || this.glasses?.unavailable || this.imuBusy || want === this.imuOn) return
    if (want === this.imuRetryFor && performance.now() < this.imuRetryAt) return
    this.imuBusy = true
    this.imu = null
    this.headUp = false
    let timedOut = false
    try {
      const request = this.bridge.imuControl(want, IMU_PACE).then((ok) => {
        if (timedOut && ok) {
          // It landed late (possibly after leaving the app). Reconcile to the
          // current foreground/setting even if an earlier command timed out.
          this.imuOn = want
          void this.syncImu()
        }
        return ok
      })
      const ok = await withTimeout<boolean | null>(request, 4000, null)
      timedOut = ok === null
      if (timedOut) this.imuOn = null
      if (!ok) throw new Error(timedOut ? 'Motion sensor timed out' : 'Motion sensor refused the request')
      this.imuOn = want
      this.imuRetryAt = 0
    } catch (err) {
      console.warn('[display] imuControl failed:', err)
      this.imuRetryFor = want
      this.imuRetryAt = performance.now() + IMU_RETRY_MS
      if (this.state === 'calibrate' && this.foreground) {
        this.calNote = 'Motion sensor unavailable. Retrying...'
        this.render()
      }
    } finally {
      this.imuBusy = false
      void this.syncImu() // the desired state may have changed during the call
    }
  }

  private calRenderAt = 0
  private onImu(data: { x?: number; y?: number; z?: number }): void {
    const v: HeadReading = [data.x ?? 0, data.y ?? 0, data.z ?? 0]
    if (!this.foreground || !v.every(Number.isFinite) || !Math.hypot(...v)) return
    const first = this.imu === null
    this.imu = v
    if (this.state === 'calibrate') {
      if (first) this.calNote = ''
      // The live angle on the setup screen, a few times a second.
      if (first || performance.now() - this.calRenderAt >= CAL_RENDER_MS) {
        this.calRenderAt = performance.now()
        this.render()
      }
      return
    }
    const d = displaySettings()
    if (!d.lookWake || !d.lookCal) return
    const at = lookPosition(v, d.lookCal)
    // Two thresholds, so a head held between them doesn't flicker.
    const up = this.headUp ? at > LOOK_DOWN_AT : at >= LOOK_UP_AT
    if (up === this.headUp) return
    this.headUp = up
    if (up) this.wake()
    else this.lastInputAt = performance.now() // the idle clock starts on looking away
  }

  /** Input, or the wearer looking: restart the idle clock, and light a
   *  blank screen. */
  private wake(): void {
    this.lastInputAt = performance.now()
    if (!this.blanked && this.fadeStep === 0) return
    this.stopFade()
    this.waking = true
    this.blanked = false
    this.notice = null
    this.render()
  }

  /** A session finished its turn or waits on a prompt. On a blank screen,
   *  with Session notifications on: a small "! name" in the corner, which hides
   *  again after the idle delay (30 s at most); a tap or tilt shows the
   *  screen as it was. On a lit screen it counts as activity only for the
   *  open session, so another session finishing doesn't relight a fade. */
  private notify(sid: string, title: string, what: 'finished' | 'needs you'): void {
    if (!this.foreground) return
    if (!this.blanked) {
      if (sid === this.sid) this.wake() // stops a fade under way too
      return
    }
    const key = `${sid}:${what}`
    if (!displaySettings().notifyDone || this.notice?.key === key) return
    // Just "!" and the session's name: which one wants a look.
    this.notice = { key, text: `${HUD.ATTN} ${title}`, at: performance.now() }
    this.render()
  }

  /** Blank the screen once it has been idle long enough, unless the head is
   *  up or the screen is one the wearer is busy on. Without an idle delay,
   *  head tilt wake blanks shortly after the head goes back. Only ever
   *  blanks: waking is wake()'s, on input or looking up. */
  private displayTick(): void {
    const d = displaySettings()
    void this.syncImu()
    if (!this.foreground || this.glasses?.unavailable || this.waking) return
    const lookWake = d.lookWake && d.lookCal !== null && this.imuOn === true && this.imu !== null
    const idleMs = d.blankAfterS > 0 ? d.blankAfterS * 1000 : lookWake ? LOOK_GRACE_MS : Infinity
    if (this.blanked) {
      // A notice hides after the same delay the screen blanks after.
      if (this.notice && performance.now() - this.notice.at >= Math.min(idleMs, NOTICE_MAX_MS)) {
        this.notice = null
        this.render()
      }
      return
    }
    // Nothing blanks until blanking or head tilt wake is turned on. The wear
    // sensor isn't used: the SDK reports isWearing false whenever a status
    // update leaves the field out, so a false can't be trusted.
    if (idleMs === Infinity) return
    const idle = performance.now() - this.lastInputAt >= idleMs
    if (KEEP_LIT.has(this.state) || (lookWake && this.headUp) || !idle) return
    if (this.fadeStep === 0) this.fadeOut()
  }

  /** Dim the screen a step at a time, then blank it. Waking at any point
   *  stops it at once. */
  private fadeOut(): void {
    this.fadeStep += 1
    if (this.fadeStep >= FADE_DIM.length) {
      this.stopFade()
      this.blanked = true
    } else this.fadeTimer = setTimeout(() => this.fadeOut(), FADE_STEP_MS)
    this.render()
  }

  private stopFade(): void {
    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    this.fadeTimer = null
    this.fadeStep = 0
  }

  // ── state transition + rendering ───────────────────────────────────────
  private go(state: State): void {
    if (this.state === 'confirm' && state !== 'confirm') this.pendingSend = null
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

  /** Root-page exit: request the SYSTEM exit dialog (mode 1). Even Hub review
   *  rejects an immediate mode-0 exit on the root page. The user can cancel
   *  the dialog, so nothing is torn down here — cleanup runs only when the
   *  confirmed exit arrives as SYSTEM_EXIT_EVENT (or on beforeunload). In
   *  panel-only mode there is no system dialog; the Exit button just stops
   *  the app (the browser tab owns the page lifecycle). */
  private async exit(): Promise<void> {
    if (!this.glasses) {
      this.cleanup()
      return
    }
    await this.glasses.shutdown(1)
  }

  private render(): void {
    this.panel.setGlassesDraft(this.state === 'confirm' && this.pendingSend !== null)
    this.panel.setConnection({ bridge: this.connBridge, origin: this.origin, state: this.state })
    if (!this.glasses) return // panel-only mode
    const blank: Layout = this.notice ? { kind: 'notice', text: this.notice.text } : { kind: 'text', content: '' }
    if (this.fadeStep && KEEP_LIT.has(this.state)) this.stopFade()
    if (this.blanked) this.glasses.render(blank)
    else this.glasses.render(this.withStrip(this.layout()), FADE_DIM[this.fadeStep],
      this.state === 'confirm' && this.foreground ? this.pendingSend ?? undefined : undefined)
  }

  /** The dictation screen's footer: the stream's state and what a tap does
   *  now. */
  private voiceFooter(): string {
    if (this.finishingRun !== null) return `${HUD.IDLE} Finishing${HUD.ELL}`
    if (this.voiceStatus === 'listening') return `${HUD.RUN} Listening ${HUD.SEP} tap = done ${HUD.SEP} dbl = cancel`
    // Whatever the stream reports: connecting, reconnecting, or a bridge still
    // downloading its dictation model.
    const word = this.voiceStatus.charAt(0).toUpperCase() + this.voiceStatus.slice(1)
    return `${HUD.IDLE} ${word}${HUD.ELL} ${HUD.SEP} tap = done ${HUD.SEP} dbl = cancel`
  }

  /** The screen with the image strip on top, where the glasses take images:
   *  the session list and menus get their own strip lines, and any other
   *  header-and-footer screen takes its header as the title and its footer's
   *  gestures as the right-hand box. Prompts keep their taller text headers
   *  (and promptTapOk reads layout(), so they must stay `list`s). */
  private withStrip(l: Layout): Layout {
    if (!this.glasses?.imageStrips) return l
    const hints = (parts: string[]): [string, string] => [parts[0] ?? '', parts.slice(1).join(` ${HUD.SEP} `)]
    const title = this.session?.title ?? ''
    if (l.kind === 'list') {
      const strip = (status: [string, string], gestures: string[]): Layout => ({
        kind: 'stripList',
        status,
        settings: hints(gestures),
        fitSettings: true,
        items: l.items,
        key: l.key,
      })
      if (this.state === 'list') {
        const count = this.sessions.length ? `${this.sessions.length} active` : 'none active'
        return strip(['Sessions', this.connBridge === 'down' ? `${HUD.ATTN} offline` : count], ['tap open', 'dbl exit'])
      }
      if (this.state === 'settings') return strip(['Settings', 'Glasses display'], ['tap change', 'dbl back'])
      if (this.state === 'settingPick') return strip(['Settings', SETTING_TITLE[this.settingKind]], ['tap pick', 'dbl back'])
      if (this.state === 'compose') return strip([title, 'Compose'], ['tap pick', 'dbl back'])
      if (this.state === 'submenu') return strip([title, SUBMENU_TITLE[this.submenuKind]], ['tap pick', 'dbl back'])
      return l
    }
    if (l.kind === 'scroll' && this.state === 'voice' && !this.voiceStop) {
      // Dictation: the strip holds still (no image sends while talking), and
      // the state the next tap depends on is a text footer, which updates in
      // tens of milliseconds.
      return {
        kind: 'strip',
        status: [this.voicePurpose === 'aside' ? 'Ask aside' : 'Dictation', title],
        settings: ['', ''],
        fitSettings: true,
        body: l.body,
        footer: this.voiceFooter(),
      }
    }
    if (l.kind === 'scroll' && (this.state === 'confirm' || this.state === 'voice')) {
      // The rest of the dictation flow (review before sending, a stopped
      // dictation) keeps its actions in the same footer box.
      return { kind: 'strip', status: [l.header, title], settings: ['', ''], fitSettings: true, body: l.body, footer: l.footer }
    }
    if (l.kind === 'scroll') {
      const gestures = l.footer.split(` ${HUD.SEP} `).map((p) => p.replace('dbl-tap', 'dbl').replace(/\s*=\s*/, ' '))
      return { kind: 'strip', status: [l.header, title], settings: hints(gestures), fitSettings: true, body: l.body }
    }
    return l
  }

  /** The current screen as a native layout the GlassesDisplay draws + diffs. */
  private layout(): Layout {
    switch (this.state) {
      case 'list': {
        const rows = this.sessionRows()
        return {
          kind: 'list',
          // The header is its own container, so going offline (the bridge
          // stopped answering the poll; the rows are stale) costs no rebuild.
          header: `${APP_TITLE_SHORT} ${HUD.SEP} ${this.connBridge === 'down' ? `${HUD.ATTN} offline` : `${this.sessions.length} active`} ${HUD.SEP} tap open ${HUD.SEP} dbl exit`,
          items: rows.map((r) => r.label),
          key: JSON.stringify(rows.map((r) => r.sid ?? r.label)),
        }
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
      case 'settings':
        return { kind: 'list', header: `Settings ${HUD.SEP} tap change ${HUD.SEP} dbl back`, items: this.settingsRows() }
      case 'settingPick':
        return { kind: 'list', header: `${SETTING_TITLE[this.settingKind]} ${HUD.SEP} tap pick ${HUD.SEP} dbl back`, items: this.settingItems.map((i) => i.label), key: `setting:${this.settingKind}` }
      case 'calibrate':
        return this.calibrateLayout()
      case 'permission':
        return this.permissionLayout()
      case 'question':
        return this.questionLayout()
      case 'replyDetail': {
        const text = hudSafe(this.promptReply?.text ?? '')
        const head = clampBytes(text, DETAIL_BYTES, 'head')
        const body = head === text ? text : `${head}
${HUD.ELL} (reply continues)`
        return { kind: 'scroll', header: 'Review reply', body, footer: 'tap = back' }
      }
      case 'reply': {
        const r = this.promptReply
        const action = r?.kind === 'rule' ? 'Allow for session' : r?.kind === 'deny' ? 'Deny with note' : 'Use answer'
        const text = hudSafe(r?.text ?? '')
        const head = fitHeader(text, 3)
        const items = ['Back', action]
        if (head.text !== text) items.push('Read reply')
        return { kind: 'list', header: head.text, headerRows: head.rows, items, key: `reply:${r?.id}:${r?.index}:${r?.text}` }
      }
      case 'detail':
        return this.detailLayout()
      case 'voice': {
        if (this.voiceStop) {
          const { reason, text } = this.voiceStop
          return {
            kind: 'scroll',
            header: this.voicePurpose === 'aside' ? `${HUD.ATTN} Ask aside ${HUD.SEP} stopped` : `${HUD.ATTN} Dictation stopped`,
            body: text ? `${hudSafe(reason)}\n\n${HUD.USER} ${text}` : hudSafe(reason),
            footer: text ? `tap = review ${HUD.SEP} dbl = discard` : 'tap = back',
          }
        }
        // The stream's real state, not a fixed "Listening": a bad key, language
        // or network spends ~40 s reconnecting before the captioner gives up.
        // The mic stays open meanwhile and the last 10 s of audio wait for the
        // socket, so speech through a short drop isn't lost — but nothing said
        // is transcribed if it never comes back, or if the wearer taps done first.
        const up = this.voiceStatus === 'listening'
        const word = up ? 'listening' : `${this.voiceStatus}${HUD.ELL}`
        return {
          kind: 'scroll',
          header:
            this.voicePurpose === 'aside'
              ? `${up ? HUD.RUN : HUD.IDLE} Ask aside ${HUD.SEP} ${word}`
              : `${up ? HUD.RUN : HUD.IDLE} ${word[0].toUpperCase()}${word.slice(1)}`,
          body: this.withPrefix(this.interim) ? liveTail(this.withPrefix(this.interim)) : '(speak now)',
          footer: `tap = done ${HUD.SEP} dbl = cancel`,
        }
      }
      case 'aside':
        return this.asideLayout()
      case 'info':
        return this.infoLayout()
      case 'confirm':
        return this.confirmLayout()
      case 'notice':
        return this.noticeLayout()
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
        // Pinned header + footer, like setup: as one full-screen text block the
        // message pushed the retry hint below the fold.
        return {
          kind: 'scroll',
          header: `${APP_TITLE} ${HUD.SEP} error`,
          body: hudSafe(this.errorMsg),
          footer: `tap = retry ${HUD.SEP} dbl-tap = exit`,
        }
      case 'boot':
      default:
        return { kind: 'text', content: `${APP_TITLE}\n\nconnecting` }
    }
  }

  private sessionPageCount(): number {
    return this.sessions.length < MAX_LIST_ITEMS ? 1 : Math.ceil(this.sessions.length / SESSIONS_PER_PAGE)
  }

  /** Native lists fit 20 rows. Keep Settings last on every page, with room
   *  for both navigation rows on an interior page. */
  private sessionRows(): { label: string; sid?: string; page?: number }[] {
    const pages = this.sessionPageCount()
    const start = this.sessionListPage * SESSIONS_PER_PAGE
    const seen = new Set<string>()
    const all = this.sessions.map((s, i) => {
      const label = listItemText(`${dot(s.workerStatus)} ${s.pinned ? '* ' : ''}${clip(s.title, 32, HUD.ELL)} ${HUD.SEP} ${short(s.workerStatus)}`)
      // The host can omit an index and supply just the (byte-clamped) name.
      // Give duplicate names a distinct prefix that survives right clipping.
      const shown = seen.has(label) ? `${i + 1}. ${label}` : label
      seen.add(label)
      return { label: shown, sid: s.id }
    })
    const rows: { label: string; sid?: string; page?: number }[] =
      pages === 1 ? all : all.slice(start, start + SESSIONS_PER_PAGE)
    if (this.sessionListPage > 0) rows.push({ label: `${HUD.BACK} Previous page`, page: this.sessionListPage - 1 })
    if (this.sessionListPage + 1 < pages) rows.push({ label: `Next page ${HUD.GO}`, page: this.sessionListPage + 1 })
    rows.push({ label: SETTINGS_ROW })
    return rows
  }

  /** The session's live settings: model, effort, a non-default mode, and
   *  context use once it passes CTX_WARN_PCT. */
  private sessionSettings(): string {
    const s = this.session
    const mode = this.currentMode()
    const ctx = s?.context && s.context.percent >= CTX_WARN_PCT ? `ctx ${s.context.percent}%` : ''
    return [modelShort(this.worker?.model ?? s?.model), this.currentEffort() ?? '', mode === 'default' ? '' : modeShort(mode), ctx]
      .filter(Boolean)
      .join(` ${HUD.SEP} `)
  }

  /** The strip's settings box: model, effort and a non-default mode, then
   *  context use. The context shown is refreshed when a turn ends (or the
   *  session is first shown), not while one runs, so the image isn't re-sent
   *  for every turn's token count. */
  private stripSettings(): [string, string] {
    const s = this.session
    const mode = this.currentMode()
    const line = [modelShort(this.worker?.model ?? s?.model), this.currentEffort() ?? '', mode === 'default' ? '' : modeShort(mode)]
      .filter(Boolean)
      .join(` ${HUD.SEP} `)
    if (s && (!this.isRunning(s) || !this.ctxShown.has(s.id))) this.ctxShown.set(s.id, s.context)
    const c = s ? this.ctxShown.get(s.id) : null
    return [line, c ? `ctx ${c.percent}% ${HUD.SEP} ${tokens(c.usedTokens)}/${tokens(c.maxTokens)}` : '']
  }

  /** The session header strip: a status (`tag`, else the worker's dot), title,
   *  then the settings. The title gets whatever room the rest leaves on the
   *  one-line strip. */
  private sessionHeader(tag?: string): string {
    const s = this.session
    const lead = tag ?? dot(s?.workerStatus)
    const tail = this.sessionSettings()
    const room = Math.max(10, HEADER_CHARS - tail.length - lead.length - 4)
    return `${lead} ${clip(s?.title ?? 'session', room, HUD.ELL)} ${HUD.SEP} ${tail}`
  }

  /** The footer's lead-in while a deferred prompt waits: a gentle nag from the
   *  footer instead of hijacking the screen the wearer is on. */
  private attnPrefix(): string {
    return this.promptDeferred ? `${HUD.ATTN} needs you ${HUD.SEP} ` : ''
  }

  /** Session view: a two-line image strip over the firmware-scrolled body, or,
   *  where the glasses can't take images, a header and footer text strip. */
  private sessionLayout(): Layout {
    const s = this.session
    const attn = this.attnPrefix()
    const tag = this.sessionTag()
    if (this.glasses?.imageStrips) {
      const title = s?.title ?? 'session'
      const dictate = this.voice?.available ? `long dictate ${HUD.SEP} ` : ''
      const settings = this.stripSettings()
      if (this.histMode === 'history') {
        return {
          kind: 'strip',
          status: [`history ${HUD.SEP} ${title}`, this.loadingPage ? `loading earlier events${HUD.ELL}` : `${attn}down live ${HUD.SEP} dbl list`],
          settings,
          body: this.histBody || '(no events)',
        }
      }
      return {
        kind: 'strip',
        status: [
          `${tag} ${HUD.SEP} ${title}`,
          this.hudNote ? `${HUD.ATTN} ${this.hudNote}` : `${attn}up history ${HUD.SEP} tap menu ${HUD.SEP} ${dictate}dbl list`,
        ],
        settings,
        body: this.liveBody(),
      }
    }
    if (this.histMode === 'history') {
      return {
        kind: 'scroll',
        header: this.sessionHeader(),
        body: this.histBody || '(no events)',
        footer: this.loadingPage ? `loading earlier events${HUD.ELL}` : `${attn}history ${HUD.SEP} down = live ${HUD.SEP} dbl = list`,
      }
    }
    const header = this.sessionHeader(tag)
    // A failed action takes the whole footer for a moment: the strip is one
    // line, and a waiting prompt's "needs you" is back when the note goes.
    if (this.hudNote) return { kind: 'scroll', header, body: this.liveBody(), footer: `${HUD.ATTN} ${this.hudNote}` }
    return {
      kind: 'scroll',
      header,
      // The live tail is ROW-budgeted so it always fits the body with no
      // overflow — the firmware draws text top-aligned and never auto-scrolls,
      // so an overflowing tail would hide exactly the newest lines.
      body: this.liveBody(),
      // A waiting prompt's "! needs you" leaves no room for the dictate hint.
      footer: `${attn}up = history ${HUD.SEP} tap = menu${!attn && this.voice?.available ? ` ${HUD.SEP} long = dictate` : ''}`,
    }
  }

  /** The live view's status: "live" while the session is running
   *  (auto-following), "latest" when idle, "waiting" on a prompt. With the
   *  stream down, or the bridge not answering the poll (which shows sooner: the
   *  browser spends a while redialling a stream before it reports one lost), it
   *  is none of those: what's on screen is as of when it dropped. */
  private sessionTag(): string {
    const s = this.session
    if (this.streamDown || this.connBridge === 'down') return `${HUD.ATTN} offline`
    if (this.isRunning(s)) return `${HUD.RUN} live`
    if (s?.workerStatus === 'requires_action') return `${HUD.ATTN} waiting`
    return `${HUD.IDLE} latest`
  }

  private liveBody(): string {
    if (!this.log.lineCount) return '(no events yet)'
    // The image strip leaves the body 48 px taller: two more rows.
    return this.glasses?.imageStrips
      ? this.log.tailRows(LIVE_BODY_ROWS + 2, bodyRows, LIVE_BODY_BYTES_STRIP)
      : this.log.tailRows(LIVE_BODY_ROWS, bodyRows, LIVE_BODY_BYTES)
  }

  /** Permission prompt as a native list — so, like every other screen, it has
   *  a no-commit escape: scroll to Allow or Deny and tap to decide, or
   *  double-tap to set it aside and answer later. The tool and the start of
   *  its input ride in the header, sized to hold them (as one line it cut a
   *  long command off mid-word, with a scrollbar); Details shows all of it. */
  private permissionLayout(): ListLayout {
    const p = this.permEvent?.permissionRequest
    const tool = p?.toolName ?? 'tool'
    const name = `${HUD.ATTN} ${clip(tool, 22, HUD.ELL)}`
    const lead = `${name} ${HUD.SEP} `
    const raw = p?.input ? headerInput(p.input, lead) : ''
    const head = fitHeader(raw ? `${lead}${raw}` : name, PERMISSION_HEADER_ROWS)
    return {
      kind: 'list',
      header: head.text,
      headerRows: head.rows,
      items: ['Allow', 'Deny', `Details ${HUD.GO}`,
        ...(this.voice?.available ? ['Deny with a note'] : []),
        ...(p?.sessionRule && hudSafe(p.sessionRule) === p.sessionRule && /^[ -~]+$/.test(p.sessionRule) && fitsStripRow(p.sessionRule) ? ['Allow for session'] : [])],
      // Each prompt is its own list, though every one reads Allow / Deny /
      // Details: the next one is a rebuild (highlight back on Allow, the tap
      // guard running again), never the last one's page with a new header.
      key: this.permEvent?.requestId ?? '',
    }
  }

  /** Question dialog: the question in the header + its options as a native list.
   *  Scroll to an option and tap to pick; a multi-select toggles its options
   *  and has a Submit row. Details shows every option in full; the trailing
   *  `← Dismiss` row cancels and a double-tap sets the question aside.
   *  Multi-question dialogs are answered one at a time. */
  private questionLayout(): ListLayout {
    const q = this.dialogQuestions[this.qIndex]
    const n = this.dialogQuestions.length
    const prefix = `${n > 1 ? `(${this.qIndex + 1}/${n}) ` : ''}${q?.multiSelect ? 'pick any: ' : ''}`
    if (this.permEvent?.permissionRequest?.subtype === 'request_user_dialog') {
      return { kind: 'list', header: 'Answer this dialog in Claude', items: ['Set aside'], key: this.permEvent.requestId ?? '' }
    }
    const head = fitHeader(`${HUD.ATTN} ${prefix}${(q?.question || q?.header || 'Question').trim()}`, QUESTION_HEADER_ROWS)
    return {
      kind: 'list',
      header: head.text,
      headerRows: head.rows,
      items: this.questionRows().map((r) => r.text),
      key: `${this.permEvent?.requestId ?? ''}:${this.qIndex}`, // see permissionLayout
    }
  }

  /** The armed prompt in full, on a natively-scrolled body (openPromptDetail). */
  private detailLayout(): Layout {
    const ev = this.permEvent
    const what = !ev ? 'Prompt' : isQuestionRequest(ev) ? 'Question' : clip(ev.permissionRequest?.toolName ?? 'tool', 30, HUD.ELL)
    return {
      kind: 'scroll',
      header: `${HUD.ATTN} ${what} ${HUD.SEP} details`,
      body: this.detailBody || '(nothing more)',
      footer: 'tap = back',
    }
  }

  /** A side question and its answer, on a natively-scrolled body. Tap (once
   *  answered) asks a follow-up; double-tap returns to the session. */
  private asideLayout(): Layout {
    const a = this.aside
    const reply = !a ? '' : a.error ? `${HUD.ATTN} ${a.error}` : a.answer != null ? cleanProse(a.answer) : 'asking...'
    const done = !!a && (a.answer != null || !!a.error)
    return {
      kind: 'scroll',
      header: `? Aside ${HUD.SEP} not in the transcript`,
      body: hudSafe(a ? `${HUD.USER} ${a.question}\n\n${reply}` : '(nothing asked)'),
      footer: `${this.attnPrefix()}${done ? `tap = ask more ${HUD.SEP} ` : ''}dbl = back`,
    }
  }

  /** Where the session stands, on one natively-scrolled screen: status and
   *  settings, context use, the server's summary (or what it needs from you),
   *  running background tasks, then the on-demand plan usage + git changes. */
  private infoLayout(): Layout {
    const s = this.session
    const lines: string[] = []
    const mode = this.currentMode()
    const effort = this.currentEffort()
    lines.push(
      [short(s?.workerStatus), modelShort(this.worker?.model ?? s?.model), effort ? `${effort} effort` : '', modeShort(mode)]
        .filter(Boolean)
        .join(` ${HUD.SEP} `),
    )
    const ctx = this.info?.context ?? s?.context
    if (ctx?.percent != null && ctx.usedTokens != null && ctx.maxTokens != null) {
      lines.push(`context ${ctx.percent}% ${HUD.SEP} ${tokens(ctx.usedTokens)} of ${tokens(ctx.maxTokens)}`)
    } else lines.push('context usage unavailable')
    for (const c of this.info?.context?.categories ?? []) lines.push(`${c.name} ${tokens(c.tokens)}`)
    if (s?.rateLimit) lines.push(rateLimitLabel(s))
    if (s?.needsAction) lines.push('', `${HUD.ATTN} ${s.needsAction}`)
    else if (s?.summary) lines.push('', s.summary)
    if (this.tasks.length) {
      lines.push('', `${this.tasks.length} background task${this.tasks.length > 1 ? 's' : ''}:`)
      for (const t of this.tasks) lines.push(`${HUD.TOOL} ${clip(t.description || t.id, 60, HUD.ELL)}`)
    }
    lines.push('', ...infoLines(this.info, this.infoLoading, this.infoError))
    if (s?.ccVersion) lines.push(`Claude Code ${s.ccVersion}`)
    return {
      kind: 'scroll',
      header: `${HUD.SYS} ${clip(s?.title ?? 'session', 34, HUD.ELL)}`,
      body: hudSafe(lines.join('\n')),
      footer: `${this.attnPrefix()}tap = refresh ${HUD.SEP} dbl = back`,
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
      footer: `${HUD.SEND} tap = send ${HUD.SEP} ${this.canDictateMore() ? `long = dictate ${HUD.SEP} ` : ''}dbl = cancel`,
    }
  }

  /** A dictated message under review (not a canned one) can take more
   *  dictation. */
  private canDictateMore(): boolean {
    return this.pendingSend?.back === 'session' && !!this.voice?.available
  }

  /** `text` after the words a long press reopened, if any. */
  private withPrefix(text: string): string {
    return [this.voicePrefix, text].filter(Boolean).join(' ')
  }

  /** The one-time release-notice interstitial: title + body (+ command) on a
   *  natively-scrolled body. Text is authored for the panel, so `hudSafe` folds
   *  the typography (em dashes, curly quotes) the HUD font can't draw; the
   *  command is included verbatim — ugly wrapped, but the screen is then
   *  self-contained (glasses.ts byte-clamps the body under the firmware cap). */
  private noticeLayout(): Layout {
    const n = this.noticeQueue[0]
    if (!n) return { kind: 'scroll', header: `${HUD.ATTN} Notice`, body: '(none)', footer: 'tap = back' }
    const body = [n.title, n.body, n.command].filter(Boolean).join('\n\n')
    return {
      kind: 'scroll',
      header: `${HUD.ATTN} Notice ${HUD.SEP} from this update`,
      body: hudSafe(body),
      footer: `tap = got it ${HUD.SEP} dbl = later`,
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
    this.voiceRun++
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.closeStream()
    void this.voice?.cancel()
    if (this.hudNoteTimer) clearTimeout(this.hudNoteTimer)
    this.hudNoteTimer = null
    if (this.displayTimer) clearInterval(this.displayTimer)
    this.displayTimer = null
    this.stopFade()
    this.foreground = false
    void this.syncImu()
  }
}

// ── display settings ───────────────────────────────────────────────────────
type SettingKind = 'blank' | 'lookWake' | 'notify'
const SETTING_TITLE: Record<SettingKind, string> = { blank: 'Blank after', lookWake: 'Wake on head tilt', notify: 'Session notifications' }
const SESSIONS_PER_PAGE = MAX_LIST_ITEMS - 3
const SETTINGS_ROW = `${HUD.SYS} Settings`
/** Gestures: input that resets the idle clock and wakes a blank screen. */
const GESTURES = new Set<number>([CLICK, DOUBLE_CLICK, SCROLL_UP, SCROLL_DOWN, OsEventTypeList.LONG_PRESS_EVENT])
/** Screens the wearer is busy on, which never blank by idling. */
const KEEP_LIT = new Set<State>(['voice', 'confirm', 'permission', 'question', 'detail', 'reply', 'replyDetail', 'calibrate'])
const DISPLAY_TICK_MS = 1000
/** The fade-out's brightness at each step (index 0 = not fading), and the
 *  time between steps. */
const FADE_DIM = [1, 0.66, 0.4, 0.2]
const FADE_STEP_MS = 1000
/** A notice never stays lit longer than this, whatever the idle delay. */
const NOTICE_MAX_MS = 30_000
/** With head tilt wake and no idle delay: how long after tilting back. */
const LOOK_GRACE_MS = 5000
/** Where the head is between the normal (0) and waking (1) positions when
 *  the screen wakes, and when it counts as back again. */
const LOOK_UP_AT = 0.6
const LOOK_DOWN_AT = 0.35
/** The waking position must be at least this far from the normal one. */
const MIN_CAL_DEG = 8
const IMU_PACE = ImuReportPace.P200
const IMU_RETRY_MS = 30_000
const CAL_RENDER_MS = 300

/** How far the head is tilted up (positive) or down, in degrees, from a
 *  reading. On the G2 the sensor's first axis follows the nod: about -0.6 g
 *  looking 38 degrees down, near 0 looking straight ahead (measured
 *  2026-11-23). Only for display: waking uses lookPosition, which needs no
 *  axis. */
function pitchDeg(v: number[]): number {
  const n = Math.hypot(v[0], v[1], v[2])
  return n ? (Math.asin(Math.max(-1, Math.min(1, v[0] / n))) * 180) / Math.PI : 0
}

function tiltLabel(deg: number): string {
  const r = Math.round(deg)
  return r === 0 ? 'level' : `${Math.abs(r)}° ${r > 0 ? 'up' : 'down'}`
}

/** With head tilt wake on, "off" still blanks shortly after looking away. */
function blankLabel(s: number, lookWake: boolean): string {
  return s === 0 ? (lookWake ? 'when looking away' : 'off') : s < 60 ? `${s} s` : `${s / 60} min`
}

/** The angle between two sensor readings, in degrees. */
function angleDeg(a: number[], b: number[]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const n = Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2])
  return n ? (Math.acos(Math.max(-1, Math.min(1, dot / n))) * 180) / Math.PI : 0
}

/** Where `v` sits between the calibrated normal position (0) and waking
 *  position (1), measured along the line between them; past the waking
 *  position is above 1, further from it than normal is below 0. The readings
 *  are directions of gravity, so no axis needs to be known. */
function lookPosition(v: number[], cal: { rest: number[]; read: number[] }): number {
  const d = [0, 1, 2].map((i) => cal.read[i] - cal.rest[i])
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
  if (!len2) return 0
  return ((v[0] - cal.rest[0]) * d[0] + (v[1] - cal.rest[1]) * d[1] + (v[2] - cal.rest[2]) * d[2]) / len2
}

// ── small pure helpers ─────────────────────────────────────────────────────
/** Header title per submenu kind (exhaustive, so a new kind can't silently
 *  inherit the wrong label the way a fall-through ternary did). */
const SUBMENU_TITLE: Record<SubmenuKind, string> = {
  model: 'Model',
  mode: 'Permission mode',
  effort: 'Effort',
  command: 'Commands',
  aside: 'Ask aside',
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
/** `440439` → `440k`, `1000000` → `1M`. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}
/** The info screen's on-demand lines: plan usage windows + git changes. */
function infoLines(info: SessionInfo | null, loading: boolean, error: string | null): string[] {
  if (!info) return [loading ? 'asking the worker...' : error ? `${HUD.ATTN} ${error}` : '']
  const lines: string[] = []
  const limits = info.usage?.limits ?? []
  if (limits.length) {
    lines.push(`plan ${limits.map((l) => `${limitLabel(l.kind, l.model)} ${l.percent ?? '?'}%`).join(` ${HUD.SEP} `)}`)
    const five = limits.find((l) => l.kind === 'session')
    const reset = five?.resetsAt ? untilLabel(five.resetsAt) : ''
    if (reset) lines.push(`5h window resets in ${reset}`)
  }
  if (info.diff) {
    const d = info.diff
    lines.push(d.files ? `changes ${d.files} file${d.files > 1 ? 's' : ''} +${d.added} -${d.removed}` : 'no uncommitted changes')
  } else if (info.diffPending) {
    lines.push('changes: still counting, tap to ask again')
  }
  if (loading) lines.push('(refreshing...)')
  return lines
}
function limitLabel(kind: string, model: string | null): string {
  if (kind === 'session') return '5h'
  if (kind === 'weekly_all') return 'week'
  if (kind === 'weekly_scoped') return model ?? 'scoped'
  return kind
}
/** `1h 12m` until an ISO time ('' if past or unparseable). */
function untilLabel(iso: string): string {
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const min = Math.round(ms / 60_000)
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`
}
/** A worker query's failure, worded for the wearer: an older bridge 404s the
 *  new routes, a busy worker times out (504), a refusal comes back as 502. */
function workerError(e: unknown, what: string): string {
  if (e instanceof BridgeError) {
    if (e.status === 404) return `${what} need a newer bridge (uvx --refresh).`
    if (e.status === 504) return 'No answer in time.'
  }
  return (e as Error).message || 'Failed.'
}
/** One row of the question screen: what it shows, and what a tap on it does. */
type QuestionRow =
  | { kind: 'option'; text: string; label: string }
  | { kind: 'submit' | 'details' | 'dismiss' | 'other' | 'later'; text: string }

/** `text` clipped to what `maxRows` rows of a prompt's header strip hold, and
 *  the rows that takes. Measured, not counted (`stripRows`): the font is
 *  proportional and rows are lost to wrapping, so a char budget either cut a
 *  header short above an empty row or let it spill into a scrollbar. */
function fitHeader(text: string, maxRows: number): { text: string; rows: number } {
  let fitted = clip(text, 80 * maxRows, HUD.ELL)
  while (stripRows(fitted) > maxRows && fitted.length > 8) fitted = clip(fitted, fitted.length - 3, HUD.ELL)
  return { text: fitted, rows: Math.min(maxRows, stripRows(fitted)) }
}
/** A tool's whole input for the details screen: the field the prompt's header
 *  starts with first, then the rest, each under its name. */
function inputDetail(input: Record<string, unknown> | null): string {
  const fields = Object.entries(input ?? {}).filter(([, v]) => v != null && v !== '')
  if (fields.length === 0) return '(no input)'
  const lead = INPUT_KEYS.find((k) => fields.some(([name]) => name === k))
  fields.sort(([a], [b]) => Number(b === lead) - Number(a === lead))
  return fields.map(([name, v]) => `${name}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n\n')
}
/** A question for the details screen: its text and each option's full description. */
function questionDetail(questions: DialogQuestion[], index: number): string {
  const q = questions[index]
  if (!q) return '(no question)'
  const lines = [q.question || q.header || 'Question']
  if (q.multiSelect) lines.push('(pick any, then Submit)')
  lines.push('')
  for (const o of q.options) lines.push(`${HUD.SEP} ${o.label}${o.description ? `: ${o.description}` : ''}`)
  return lines.join('\n')
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
 * The blocking controls in `events` that nothing after them resolves, oldest
 * first. An answered control_request is followed by its control_response (any
 * controller's), a withdrawn one by the worker's cancel, and a finished turn
 * by its result — so whatever survives the scan is what the session is blocked
 * on right now (callers still cross-check the session's own blocked status).
 * All of them, as the live stream queues them: a turn can wait on several at
 * once, and until 1.10.0 only the newest was found — answer it, and the scan
 * on the next open found nothing, with the session still blocked on the rest.
 */
function findPendingControls(events: RcEvent[]): RcEvent[] {
  const pending = new Map<string, RcEvent>()
  for (const ev of events) {
    if (ev.isBlockingControl && ev.permissionRequest && ev.requestId) pending.set(ev.requestId, ev)
    else if (settlesPrompt(ev) && ev.requestId) pending.delete(ev.requestId)
    else if (!ev.parentToolUseId && (ev.type === 'result' || ev.type === 'conversation_reset')) pending.clear()
  }
  return [...pending.values()]
}
/** The input fields that say what a tool call is, most telling first. */
const INPUT_KEYS = ['command', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'plan', 'description', 'prompt', 'query']
const PATH_KEYS = ['file_path', 'path', 'notebook_path']
/**
 * What a permission's header says after `lead` (the tool's name): the most
 * telling input field. A path too long to finish the row keeps its END, from
 * a directory boundary: the file is what is being asked about, not the folders
 * above it.
 */
function headerInput(input: Record<string, unknown>, lead: string): string {
  for (const key of INPUT_KEYS) {
    const v = input[key]
    if (typeof v !== 'string' || !v) continue
    if (!PATH_KEYS.includes(key) || fitsStripRow(`${lead}${v}`)) return v
    let end = v
    while (end.length > 8 && !fitsStripRow(`${lead}${HUD.ELL}${end}`)) end = end.slice(4)
    const cut = end.indexOf('/')
    return `${HUD.ELL}${cut > 0 ? end.slice(cut) : end}`
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v) return v
  }
  return JSON.stringify(input)
}

const root = document.getElementById('app')
if (root) void new App().boot(root)
