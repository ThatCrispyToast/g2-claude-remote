// Companion browser panel (the WebView shown in the Even app on the phone).
//
// The glasses are the primary control surface; this panel is the richer twin —
// the full active-session list, a session's full event log (assistant text,
// tool_use with its complete input, results with usage), plus every steering
// control the HUD offers AND the one it can't: a real free-text send box, since
// the phone has a keyboard. It is push-only — main.ts feeds it state via the
// flat setX() mirrors below; the panel never polls or talks to the bridge.
//
// Three screens (sessions, settings, session) and two bottom sheets over the
// session (the blocking prompt, and the session controls), laid out after the
// Even Realities Software Design Guidelines (the public Figma, APP pages):
// #EEEEEE page, white cards and grouped lists without dividers, near-black
// (#232323) text, #7B7B7B secondary, pale yellow (#FEF991) for an ongoing
// action or something waiting on you, green (#4BB956) for connection status,
// red text for destructive actions; a 24/20/17/15/13/11 type scale (400 titles,
// 300 body), 6px radius, centred navigation titles, segmented selectors on a
// #E4E4E4 track, pop-up sheets on a 50% black overlay. See injectStyles().
// No framework. (The glasses HUD in glasses.ts is a separate, firmware-native
// monochrome surface and is not governed by this doc.)

import type {
  ActiveSession,
  BackgroundTask,
  RcEvent,
  PermissionRequest,
  HistoryPage,
  DialogQuestion,
  WhoAmI,
  Decision,
  PermissionMode,
  SessionInfo,
  SlashCommand,
  WorkerState,
} from './rc/types'
import type { Notice } from './notices'
import { BLANK_AFTER_CHOICES, EFFORTS, MODELS, MODES, QUICK_SENDS, SLASH_COMMANDS, isSlashInput, APP_TITLE, BRIDGE_URL, BRIDGE_TOKEN, DEEPGRAM_API_KEY, STT_LANGUAGE, displaySettings, isSttLanguage, loadRuntimeSettings, saveRuntimeSettings, type DisplaySettings, type RuntimeSettings, type SttSource } from './config'
import { cleanUserEcho, isQuestionRequest, settingsLine, workerNotes, rateLimitLabel, systemActivity } from './events/format'

/** A side question on show: asking (answer + error null), answered, or failed. */
export interface AsideView {
  question: string
  answer: string | null
  error: string | null
}

/** The session card's on-demand part: plan usage + git changes. */
export interface InfoView {
  info: SessionInfo | null
  error: string | null
  loading: boolean
}

/** Everything the panel calls back into main.ts to do — main.ts owns the bridge. */
export interface PanelCallbacks {
  /** A session row was tapped → open its detail view. */
  onSelectSession: (sid: string) => void
  /** The Back button in the detail view → return to the list. */
  onBackToList: () => void
  /** The free-text send box (or a quick-action button) → send `text` verbatim. */
  onTakeGlassesDraft: () => string | null
  onSend: (text: string) => void
  /** Interrupt the running turn. */
  onInterrupt: () => void
  /** A model was picked in the session controls. */
  onSetModel: (model: string) => void
  /** A permission mode was picked in the session controls. */
  onSetMode: (mode: PermissionMode) => void
  /** An effort was picked ('auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'). */
  onSetEffort: (effort: string) => void
  /** Archive the open session (main.ts confirms/executes; the button self-confirms too). */
  onArchive: (sid: string) => void
  /** Pin / unpin the open session (claude.ai/code's pin). */
  onSetPinned: (pinned: boolean) => void
  /** Allow / Deny a blocking permission prompt. */
  onAnswerPermission: (decision: Decision, note?: string, rule?: string) => void
  /** Pick option `label` for question `qIndex` of a blocking dialog (a
   *  multi-select question toggles it). */
  onPickDialogOption: (qIndex: number, label: string) => void
  /** Done picking for multi-select question `qIndex`: its picks stand. */
  onConfirmDialogPicks: (qIndex: number) => void
  /** Dismiss / cancel a blocking question dialog. */
  onCancelDialog: () => void
  /** Start / stop voice dictation into the send box. */
  onStartVoice: () => void
  onStopVoice: () => void
  /** Ask the send box's text as a side question (answered without interrupting). */
  onAskAside: (question: string) => void
  /** The aside card's × — forget the shown exchange. */
  onDismissAside: () => void
  /** Fetch an older page of the open session's events. */
  onOlderEvents: (before: number) => Promise<HistoryPage | null>
  /** Fetch plan usage + git changes for the session controls. */
  onLoadInfo: () => void
  /** Stop a running background task. */
  onStopTask: (taskId: string) => void
  /** Connection settings were saved (or reset) → reconnect in place (no reload). */
  onApplySettings: () => void
  /** A glasses display setting changed in Settings (saved right away). */
  onSetDisplay: (patch: Partial<DisplaySettings>) => void
  /** Set up head tilt wake: the calibration runs on the glasses. */
  onCalibrateTilt: () => void
  /** A release notice's × was tapped → record it seen and re-render (notices.ts). */
  onDismissNotice: (id: string) => void
  /** Leave the whole app. */
  onExit: () => void
}

type StatusKind = 'running' | 'action' | 'idle'

/** How a worker-status string maps to a status kind + its label. */
function statusOf(worker: string): { cls: StatusKind; label: string } {
  switch (worker) {
    case 'running':
      return { cls: 'running', label: 'Running' }
    case 'requires_action':
      return { cls: 'action', label: 'Waiting on you' }
    default:
      return { cls: 'idle', label: 'Idle' }
  }
}

/** Short "3m" from an ISO timestamp (or '' when absent/unparseable). */
function relTime(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (sec < 45) return 'now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.round(hr / 24)}d`
}

/** The model's display label, falling back to the raw id (or ''). */
function modelLabel(id: string | null): string {
  if (!id) return ''
  return MODELS.find((m) => m.id === id)?.label ?? id
}

/** A permission mode's segment label and its longer status-line form. */
const MODE_LABELS: Record<string, { short: string; long: string }> = {
  default: { short: 'Ask', long: 'Ask first' },
  acceptEdits: { short: 'Edits', long: 'Accept edits' },
  plan: { short: 'Plan', long: 'Plan mode' },
  bypassPermissions: { short: 'Bypass', long: 'Bypass permissions' },
}

function modeLabel(mode: string | null, form: 'short' | 'long'): string {
  if (!mode) return ''
  return MODE_LABELS[mode]?.[form] ?? mode
}

/** Effort segment labels: `medium` is shortened to fit six segments. */
function effortLabel(label: string): string {
  return label === 'medium' ? 'med' : label
}

/** A plan-usage window's name: `5 hours`, `Week`, or the scoped model. */
function limitLabel(kind: string, model: string | null): string {
  return kind === 'session' ? '5 hours' : kind === 'weekly_all' ? 'Week' : kind === 'weekly_scoped' ? `Week · ${modelLabel(model) || 'model'}` : kind
}

/** `Done · 5 turns · 72.0s · $0.12` for a result row. */
function resultLine(e: RcEvent, ok: boolean): string {
  const u = e.usage
  const bits: string[] = [ok ? 'Done' : `Stopped: ${e.subtype ?? 'error'}`]
  if (u?.numTurns != null) bits.push(`${u.numTurns} turn${u.numTurns === 1 ? '' : 's'}`)
  if (u?.durationMs != null) bits.push(`${(u.durationMs / 1000).toFixed(1)}s`)
  if (u?.costUsd != null) bits.push(`$${u.costUsd}`)
  return bits.join(' · ')
}

/** Pretty-print a tool's input map for the full (un-clipped) panel view. */
function formatInput(input: Record<string, unknown> | null): string {
  if (!input || Object.keys(input).length === 0) return ''
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

/** The one input that says what a tool call does, on one line: a command, a
 *  path, a pattern, a URL. Its full input opens below the row. */
function toolArg(input: Record<string, unknown> | null): string {
  if (!input) return ''
  for (const k of ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'skill', 'description', 'prompt']) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim()
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim())
  return typeof first === 'string' ? first.replace(/\s+/g, ' ').trim() : ''
}

/** The bridge's host for the connection card (`my-mac:8790`), or the origin as given. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

function blankLabel(s: number, lookWake: boolean): string {
  return s === 0 ? (lookWake ? 'When looking away' : 'Never') : s < 60 ? `${s} s` : `${s / 60} min`
}

/** Starts the bridge with local dictation (its `local-stt` extra). */
const LOCAL_STT_COMMAND =
  'uvx --from "claude-remote-bridge[local-stt] @ git+https://github.com/ThatCrispyToast/g2-claude-remote#subdirectory=server" claude-remote-bridge'

// Line icons, drawn at their display size in TC-1st via currentColor.
const ICON = {
  back: '<svg width="10" height="18" viewBox="0 0 10 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 1 1 9l8 8"/></svg>',
  more: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
  settings: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  close: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m2 2 12 12M14 2 2 14"/></svg>',
  chev: '<svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m1 1 6 6-6 6"/></svg>',
  arrow: '<svg width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 6h15M11 1l5 5-5 5"/></svg>',
  mic: '<svg width="18" height="20" viewBox="0 0 18 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="5.5" y="1" width="7" height="11" rx="3.5"/><path d="M2 9a7 7 0 0 0 14 0M9 16v3"/></svg>',
  send: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 16V2M3 8l6-6 6 6"/></svg>',
  stop: '<span class="stop-square" aria-hidden="true"></span>',
  external: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4 1h7v7M11 1 1 11"/></svg>',
}

export class Panel {
  // ── DOM refs, filled in by mount(); null until then. ──────────────────────
  private connCard: HTMLDivElement | null = null
  private settingsState: HTMLSpanElement | null = null
  private listView: HTMLElement | null = null
  private listEl: HTMLDivElement | null = null
  private settingsView: HTMLElement | null = null
  private detailView: HTMLElement | null = null
  private detailTitle: HTMLDivElement | null = null
  private statusCard: HTMLDivElement | null = null
  private promptOverlay: HTMLDivElement | null = null
  private promptSheet: HTMLElement | null = null
  private controlsOverlay: HTMLDivElement | null = null
  private controlsSheet: HTMLElement | null = null
  private controlsBody: HTMLDivElement | null = null
  private controlsSub: HTMLDivElement | null = null
  private asideCard: HTMLDivElement | null = null
  private scrollEl: HTMLDivElement | null = null
  private logEl: HTMLDivElement | null = null
  private sendInput: HTMLTextAreaElement | null = null
  private takeDraft: HTMLButtonElement | null = null
  private sendBtn: HTMLButtonElement | null = null
  private dictateBtn: HTMLButtonElement | null = null
  private interimEl: HTMLDivElement | null = null
  private interruptBtn: HTMLButtonElement | null = null
  private toastEl: HTMLDivElement | null = null
  private cmdMenuEl: HTMLDivElement | null = null
  private noticesEl: HTMLDivElement | null = null
  private glassesEl: HTMLDivElement | null = null

  private mounted = false
  private dictating = false
  /** Set once main.ts has restored the saved settings (settingsLoaded). A tap on
   *  Settings before that is held, not served: filled from the still-empty
   *  storage, the screen would show (and Save would write) blanks. */
  private settingsReady = false
  private settingsHeld = false
  /** Open the Settings screen, filling it from storage (wireSettings). */
  private openSettings = (): void => {}
  private claudeLink: HTMLAnchorElement | null = null
  private olderButton: HTMLButtonElement | null = null
  private dialogDrafts = new Map<number, string>()
  private draftQuestions: DialogQuestion[] | null = null
  private historyBefore: number | null = null
  private historyRevision = 0
  private drafts = new Map<string, string>()
  /** The currently-open session id (for onArchive), or null in the list view. */
  private currentSid: string | null = null
  // The open session as last pushed, its live worker settings, background
  // tasks, and the on-demand info — the status card and the session controls
  // are rendered from these together.
  private session: ActiveSession | null = null
  private worker: WorkerState | null = null
  private tasks: BackgroundTask[] = []
  private infoView: InfoView | null = null
  /** What the prompt sheet holds: nothing, a permission, a question, or a
   *  dialog only Claude can answer. */
  private promptKind: 'none' | 'permission' | 'question' | 'external' = 'none'
  /** The prompt sheet was closed with ✕: nothing was answered, and the status
   *  card offers it again. A new prompt opens it again. */
  private promptHidden = false
  private promptKey = ''
  private archiveArmed = false
  private archiveTimer: number | null = null
  private toastTimer: number | null = null
  /** sequenceNums already rendered in the log — dedupes the history↔stream seam. */
  private seen = new Set<number>()
  /** The last appended log row, when it was a simple element-less text row: its
   *  fold key/base and how many consecutive events rendered identically. The
   *  panel twin of EventLog's fold — the worker persists a `system/init` on
   *  every controller attach, so without this an idle session's log tail is a
   *  wall of identical "session started" rows. Conversation bubbles and tool
   *  blocks (rows with child elements) never fold. */
  private lastFold: { key: string; base: string; count: number; el: HTMLDivElement } | null = null
  // The `/`-autocomplete popover over the send box: the commands matching what's
  // been typed after the leading slash, and the keyboard-highlighted row.
  private cmdMatches: SlashCommand[] = []
  private cmdIndex = 0

  constructor(private readonly cb: PanelCallbacks) {}

  /** Build the DOM into `root`. Idempotent — injects styles + wires events once. */
  mount(root: HTMLElement): void {
    if (this.mounted) return
    this.mounted = true

    const chipsHtml = [
      ...QUICK_SENDS.map((q, i) => `<button type="button" class="chip" data-quick="${i}">${escapeHtml(q.label)}</button>`),
      '<button type="button" id="asideBtn" class="chip" title="Answered from the conversation without interrupting it or adding to it">Ask aside</button>',
    ].join('')

    root.innerHTML = `
      <main class="app">
        <section id="listView" class="screen">
          <header class="nav">
            <span class="nav-side"></span>
            <h1 class="nav-title">${escapeHtml(APP_TITLE)}</h1>
            <button id="settingsBtn" type="button" class="icon-btn" aria-label="Settings">${ICON.settings}</button>
          </header>
          <div class="scroll">
            <div id="connCard" class="card conn"></div>
            <div id="notices" class="notices" hidden></div>
            <div id="sessionList" class="session-list"></div>
          </div>
        </section>

        <section id="settingsView" class="screen" hidden>
          <header class="nav">
            <button id="settingsBack" type="button" class="icon-btn" aria-label="Back to sessions">${ICON.back}</button>
            <h1 class="nav-title">Settings</h1>
            <span class="nav-side"></span>
          </header>
          <div class="scroll">
            <section class="group">
              <div class="group-head"><h2 class="group-title">Bridge</h2><span id="settingsState"></span></div>
              <div class="list-card">
                <label class="field-row"><span class="field-name">Address</span>
                  <input id="setBridgeUrl" class="row-input" type="url" autocapitalize="off" autocorrect="off"
                    spellcheck="false" placeholder="${escapeHtml(BRIDGE_URL)}" /></label>
                <label class="field-row"><span class="field-name">Token</span>
                  <input id="setBridgeToken" class="row-input" type="password" autocapitalize="off"
                    placeholder="${BRIDGE_TOKEN ? 'Built-in token' : 'None set'}" /></label>
              </div>
            </section>

            <section class="group">
              <h2 class="group-title">Dictation</h2>
              <div class="seg stt-source" role="radiogroup" aria-label="Dictation">
                <button type="button" role="radio" data-source="deepgram">Deepgram</button>
                <button type="button" role="radio" data-source="bridge">Bridge</button>
              </div>
              <div id="dictHint" class="hint" hidden></div>
              <div id="deepgramFields" class="list-card">
                <label class="field-row"><span class="field-name">API key</span>
                  <input id="setDeepgramKey" class="row-input" type="password" autocapitalize="off"
                    placeholder="${DEEPGRAM_API_KEY ? 'Built-in key' : 'None set'}" /></label>
                <label class="field-row"><span class="field-name">Language</span>
                  <input id="setSttLanguage" class="row-input" type="text" autocapitalize="off" autocorrect="off"
                    spellcheck="false" placeholder="${escapeHtml(STT_LANGUAGE)}" /></label>
              </div>
              <div id="deepgramHint" class="hint">A Deepgram language code: en, de, pt-BR, or multi for mixed speech.</div>
            </section>

            <div class="hint">Stored only on this device. A blank field uses the default shown in it.</div>
            <div class="stack">
              <button id="settingsSave" type="button" class="btn primary">Save and reconnect</button>
              <button id="settingsReset" type="button" class="btn">Reset to defaults</button>
            </div>

            <section class="group">
              <h2 class="group-title">Glasses</h2>
              <div id="glassesSettings" class="list-card"></div>
              <div class="hint">Saved right away. Head tilt is set up on the glasses: look ahead, then at the screen.</div>
            </section>

            <button id="exitBtn" type="button" class="btn ghost">Exit ${escapeHtml(APP_TITLE)}</button>
          </div>
        </section>

        <section id="detailView" class="screen" hidden>
          <header class="nav">
            <button id="backBtn" type="button" class="icon-btn" aria-label="Back to sessions">${ICON.back}</button>
            <div id="detailTitle" class="nav-title"></div>
            <button id="controlsBtn" type="button" class="icon-btn" aria-label="Session controls">${ICON.more}</button>
          </header>

          <div id="sessionScroll" class="scroll log-scroll">
            <div id="statusCard" class="card status"></div>
            <div id="asideCard" class="card aside-card" hidden></div>
            <button id="olderEvents" type="button" class="btn ghost older" hidden>Earlier events</button>
            <div id="log" class="log"></div>
          </div>

          <div class="composer">
            <div id="cmdMenu" class="cmd-menu" hidden></div>
            <div class="chips">${chipsHtml}</div>
            <div id="interim" class="interim" hidden></div>
            <div class="composer-row">
              <textarea id="sendInput" class="send-input" rows="1"
                placeholder="Message" aria-label="Message" enterkeyhint="send"></textarea>
              <button id="dictateBtn" type="button" class="square-btn" aria-label="Dictate">${ICON.mic}</button>
              <button id="sendBtn" type="button" class="square-btn primary" aria-label="Send" hidden>${ICON.send}</button>
              <button id="interruptBtn" type="button" class="square-btn" aria-label="Stop the running turn" hidden>${ICON.stop}</button>
            </div>
            <div class="composer-note">Sent as a peer message.
              <a id="claudeLink" target="_blank" rel="noopener noreferrer">Open in Claude</a> to send as you.
              <button id="copyBtn" type="button" class="link-btn">Copy draft</button>
              <button id="takeDraft" type="button" class="link-btn" hidden>Copy glasses draft</button></div>
          </div>

          <div id="controlsOverlay" class="overlay" hidden></div>
          <section id="controlsSheet" class="sheet" role="dialog" aria-modal="true" aria-label="Session controls" hidden>
            <div class="sheet-head">
              <span class="nav-side"></span>
              <div class="sheet-titles"><h2 id="controlsTitle" class="sheet-title"></h2><div id="controlsSub" class="sheet-sub"></div></div>
              <button id="controlsClose" type="button" class="icon-btn" aria-label="Close">${ICON.close}</button>
            </div>
            <div id="controlsBody" class="sheet-body"></div>
          </section>

          <div id="promptOverlay" class="overlay" hidden></div>
          <section id="promptSheet" class="sheet prompt" role="dialog" aria-modal="true" aria-label="Waiting on you" hidden></section>
        </section>

        <div id="toast" class="toast" role="status" hidden></div>
      </main>
    `

    // Cache refs.
    const $ = <T extends Element>(sel: string): T | null => root.querySelector<T>(sel)
    this.claudeLink = $('#claudeLink')
    this.connCard = $('#connCard')
    this.settingsState = $('#settingsState')
    this.listView = $('#listView')
    this.listEl = $('#sessionList')
    this.settingsView = $('#settingsView')
    this.detailView = $('#detailView')
    this.detailTitle = $('#detailTitle')
    this.statusCard = $('#statusCard')
    this.promptOverlay = $('#promptOverlay')
    this.promptSheet = $('#promptSheet')
    this.controlsOverlay = $('#controlsOverlay')
    this.controlsSheet = $('#controlsSheet')
    this.controlsBody = $('#controlsBody')
    this.controlsSub = $('#controlsSub')
    this.asideCard = $('#asideCard')
    this.scrollEl = $('#sessionScroll')
    this.olderButton = $('#olderEvents')
    this.olderButton?.addEventListener('click', () => void this.loadOlderEvents())
    this.logEl = $('#log')
    this.sendInput = $('#sendInput')
    this.sendBtn = $('#sendBtn')
    this.dictateBtn = $('#dictateBtn')
    this.interimEl = $('#interim')
    this.interruptBtn = $('#interruptBtn')
    this.toastEl = $('#toast')
    this.cmdMenuEl = $('#cmdMenu')
    this.noticesEl = $('#notices')
    this.glassesEl = $('#glassesSettings')

    // Wire events.
    $('#exitBtn')?.addEventListener('click', () => this.cb.onExit())
    $('#backBtn')?.addEventListener('click', () => this.cb.onBackToList())
    this.wireSettings(root)

    this.takeDraft = $('#takeDraft')
    this.takeDraft?.addEventListener('click', () => {
      const text = this.cb.onTakeGlassesDraft()
      if (!text || !this.sendInput) return
      this.appendDraft(text)
      void this.copyDraft(this.sendInput.value.length - text.length)
    })
    $('#copyBtn')?.addEventListener('click', () => void this.copyDraft())
    this.sendBtn?.addEventListener('click', () => this.doSend())
    // Typing after a leading `/` drives the command autocomplete.
    this.sendInput?.addEventListener('input', () => {
      this.updateCommandMenu()
      this.syncComposer()
    })
    this.sendInput?.addEventListener('keydown', (e) => {
      // While the command menu is open it owns the arrows / Enter / Escape, so a
      // pick doesn't fall through to sending the half-typed `/co` literally.
      if (this.cmdMenuOpen()) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          this.moveCmd(1)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          this.moveCmd(-1)
          return
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          this.chooseCmd(this.cmdIndex)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          this.hideCommandMenu()
          return
        }
      }
      // Enter sends; Shift+Enter inserts a newline (a phone keyboard nicety).
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.doSend()
      }
    })

    this.dictateBtn?.addEventListener('click', () => {
      if (this.dictating) this.cb.onStopVoice()
      else this.cb.onStartVoice()
    })

    this.interruptBtn?.addEventListener('click', () => this.cb.onInterrupt())
    $('#asideBtn')?.addEventListener('click', () => this.doAside())

    for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-quick]'))) {
      btn.addEventListener('click', () => {
        const q = QUICK_SENDS[Number(btn.dataset.quick)]
        if (q) this.cb.onSend(q.text)
      })
    }

    $('#controlsBtn')?.addEventListener('click', () => this.openControls())
    $('#controlsClose')?.addEventListener('click', () => this.closeControls())
    this.controlsOverlay?.addEventListener('click', () => this.closeControls())
    this.statusCard?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-review]')) this.showPrompt()
    })

    injectStyles()
    this.syncComposer()
  }

  /** Connection settings: saved to localStorage, then applied in place via
   *  `onApplySettings` — main.ts reconnects with the new values WITHOUT a page
   *  reload (a reload drops the Even glasses bridge and freezes the HUD). Settings
   *  never leave the device — the panel is where you input your bridge/Deepgram
   *  secrets. */
  private wireSettings(root: HTMLElement): void {
    const url = root.querySelector<HTMLInputElement>('#setBridgeUrl')
    const token = root.querySelector<HTMLInputElement>('#setBridgeToken')
    const dg = root.querySelector<HTMLInputElement>('#setDeepgramKey')
    const lang = root.querySelector<HTMLInputElement>('#setSttLanguage')
    // Fill from storage on every open, never at mount: mount() runs BEFORE main.ts
    // restores the saved settings from the App-side store (hydrateSettings), and
    // the Even App evicts the WebView's storage between launches — mount-time
    // values would be blank on a reopened app, and saving them would wipe the
    // restored connection. For the same reason a tap before that restore is
    // held until settingsLoaded().
    const fill = (s: RuntimeSettings): void => {
      if (url) url.value = s.bridgeUrl ?? ''
      if (token) token.value = s.bridgeToken ?? ''
      if (dg) dg.value = s.deepgramApiKey ?? ''
      if (lang) lang.value = s.sttLanguage ?? ''
      this.pickSource(s.sttSource === 'bridge' ? 'bridge' : 'deepgram')
    }
    root.querySelectorAll<HTMLButtonElement>('.stt-source [data-source]').forEach((b) =>
      b.addEventListener('click', () => this.pickSource(b.dataset.source === 'bridge' ? 'bridge' : 'deepgram')),
    )
    this.openSettings = () => {
      fill(loadRuntimeSettings())
      this.renderGlassesSettings()
      this.showScreen('settings')
    }
    root.querySelector<HTMLButtonElement>('#settingsBtn')?.addEventListener('click', () => {
      if (this.settingsReady) this.openSettings()
      else this.settingsHeld = true
    })
    root.querySelector<HTMLButtonElement>('#settingsBack')?.addEventListener('click', () => this.showScreen('list'))
    root.querySelector<HTMLButtonElement>('#settingsSave')?.addEventListener('click', () => {
      const language = lang?.value.trim() ?? ''
      if (language && !isSttLanguage(language)) {
        this.setToast('Language must be a code like de, pt-BR or multi.')
        lang?.focus()
        return
      }
      saveRuntimeSettings({
        bridgeUrl: url?.value ?? '',
        bridgeToken: token?.value ?? '',
        deepgramApiKey: dg?.value ?? '',
        sttLanguage: language,
        sttSource: this.cardSource,
      })
      this.showScreen('list')
      this.cb.onApplySettings()
    })
    root.querySelector<HTMLButtonElement>('#settingsReset')?.addEventListener('click', () => {
      saveRuntimeSettings({})
      fill({})
      this.cb.onApplySettings()
    })
  }

  /** Show one of the three screens. A session opening always wins over Settings. */
  private showScreen(which: 'list' | 'settings' | 'detail'): void {
    if (this.listView) this.listView.hidden = which !== 'list'
    if (this.settingsView) this.settingsView.hidden = which !== 'settings'
    if (this.detailView) this.detailView.hidden = which !== 'detail'
  }

  /** The glasses' display settings, read fresh: they are also changed on the
   *  glasses, and main.ts calls refreshDisplaySettings() when they are. */
  private renderGlassesSettings(): void {
    const el = this.glassesEl
    if (!el) return
    const d = displaySettings()
    const look = d.lookWake && d.lookCal !== null
    el.replaceChildren()

    // Blank after: a native select under a list row, so the phone's own picker opens.
    const blank = document.createElement('label')
    blank.className = 'field-row select-row'
    const select = document.createElement('select')
    select.setAttribute('aria-label', 'Blank screen after')
    for (const v of BLANK_AFTER_CHOICES) select.add(new Option(blankLabel(v, look), String(v), false, v === d.blankAfterS))
    select.addEventListener('change', () => this.cb.onSetDisplay({ blankAfterS: Number(select.value) }))
    blank.innerHTML = `<span class="field-name">Blank screen after</span><span class="row-value">${escapeHtml(blankLabel(d.blankAfterS, look))}${ICON.chev}</span>`
    blank.appendChild(select)

    const tilt = this.toggleRow('Wake on head tilt', look, (on) => {
      if (on) this.cb.onCalibrateTilt()
      else this.cb.onSetDisplay({ lookWake: false })
    })

    const cal = document.createElement('button')
    cal.type = 'button'
    cal.className = 'field-row'
    cal.innerHTML = `<span class="field-name">Set up head tilt</span><span class="row-value">${d.lookCal ? 'Done' : 'Not set up'}${ICON.chev}</span>`
    cal.addEventListener('click', () => this.cb.onCalibrateTilt())

    const notify = this.toggleRow('Session notifications', d.notifyDone, (on) => this.cb.onSetDisplay({ notifyDone: on }))
    const notifyHint = document.createElement('div')
    notifyHint.className = 'row-hint'
    notifyHint.textContent = 'While the screen is blank, show ! when a turn finishes or a prompt waits.'
    notify.querySelector('.field-name')?.appendChild(notifyHint)

    el.append(blank, tilt, cal, notify)
  }

  /** A list row with the Figma's square toggle (a styled checkbox). */
  private toggleRow(label: string, on: boolean, change: (on: boolean) => void): HTMLLabelElement {
    const row = document.createElement('label')
    row.className = 'field-row'
    const name = document.createElement('span')
    name.className = 'field-name'
    name.textContent = label
    const toggle = document.createElement('span')
    toggle.className = 'toggle'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.setAttribute('role', 'switch')
    box.checked = on
    box.addEventListener('change', () => change(box.checked))
    const knob = document.createElement('span')
    knob.className = 'knob'
    toggle.append(box, knob)
    row.append(name, toggle)
    return row
  }

  /** main.ts saved a display setting (from here or the glasses): redraw the group. */
  refreshDisplaySettings(): void {
    if (this.settingsView && !this.settingsView.hidden) this.renderGlassesSettings()
  }

  /** Two-tap Archive: the first tap arms it for 3 s. */
  private archiveClick(btn: HTMLButtonElement): void {
    if (!this.archiveArmed) {
      this.archiveArmed = true
      btn.textContent = 'Tap again to archive'
      btn.classList.add('armed')
      this.archiveTimer = window.setTimeout(() => {
        this.archiveArmed = false
        this.archiveTimer = null
        btn.textContent = 'Archive'
        btn.classList.remove('armed')
      }, 3000)
      return
    }
    if (this.archiveTimer !== null) clearTimeout(this.archiveTimer)
    this.archiveTimer = null
    this.archiveArmed = false
    if (this.currentSid) this.cb.onArchive(this.currentSid)
  }

  setGlassesDraft(available: boolean): void {
    if (this.takeDraft) this.takeDraft.hidden = !available
  }

  private async copyDraft(start = 0): Promise<void> {
    const box = this.sendInput
    if (!box?.value.trim()) return this.setToast('Enter a message to copy.')
    box.focus()
    box.setSelectionRange(start, box.value.length)
    try {
      // A panel served over LAN HTTP may only have the legacy copy action.
      if (navigator.clipboard) await navigator.clipboard.writeText(box.value.slice(start))
      else if (!document.execCommand('copy')) throw new Error('manual copy')
      this.setToast('Copied. Open in Claude to paste and send.')
    } catch {
      this.setToast('Draft selected. Use Copy, then Open in Claude.')
    }
  }

  /** Send when there is text; the mic gives way to Send while there is, and
   *  Stop shows only while a turn runs. The box grows with its text. */
  private syncComposer(): void {
    const box = this.sendInput
    const hasText = !!box?.value.trim()
    if (this.sendBtn) this.sendBtn.hidden = !hasText
    if (this.dictateBtn) this.dictateBtn.hidden = hasText && !this.dictating
    if (this.interruptBtn) this.interruptBtn.hidden = this.session?.workerStatus !== 'running'
    if (box) {
      box.style.height = 'auto'
      box.style.height = `${Math.min(box.scrollHeight, 132)}px`
    }
  }

  /** Read + clear the send box, firing onSend when non-empty. */
  private doSend(): void {
    const text = this.sendInput?.value.trim() ?? ''
    if (!text) return
    this.hideCommandMenu()
    if (isSlashInput(text) && !SLASH_COMMANDS.some((c) => text === `/${c.name}`)) {
      this.setToast('Open in Claude to run that command. Your draft is ready to copy.')
      this.sendInput?.select()
      return
    }
    this.cb.onSend(text)
    if (this.sendInput) {
      this.sendInput.value = ''
      this.sendInput.blur() // dismiss the mobile keyboard
    }
    this.syncComposer()
  }

  /** Ask the send box's text as a side question; the card shows the answer. */
  private doAside(): void {
    const text = this.sendInput?.value.trim() ?? ''
    if (!text) {
      this.setToast('Type a question first, then tap Ask aside.')
      this.sendInput?.focus()
      return
    }
    this.hideCommandMenu()
    this.cb.onAskAside(text)
    if (this.sendInput) {
      this.sendInput.value = ''
      this.sendInput.blur()
    }
    this.syncComposer()
  }

  // ── Slash-command autocomplete ─────────────────────────────────────────────
  // The suggestions open session information locally.

  private cmdMenuOpen(): boolean {
    return !!this.cmdMenuEl && !this.cmdMenuEl.hidden && this.cmdMatches.length > 0
  }

  /** Recompute matches from the send box and show/hide the menu. Active only
   *  while typing the command NAME: a leading `/` and no space yet (a space means
   *  they've moved on to the argument). */
  private updateCommandMenu(): void {
    const val = this.sendInput?.value ?? ''
    const m = /^\/([a-z0-9:_-]*)$/i.exec(val)
    if (!m || SLASH_COMMANDS.length === 0) {
      this.hideCommandMenu()
      return
    }
    const q = m[1].toLowerCase()
    const matches = SLASH_COMMANDS.filter(
      (c) => c.name.toLowerCase().startsWith(q) || (!!q && c.label.toLowerCase().includes(q)),
    )
    if (matches.length === 0) {
      this.hideCommandMenu()
      return
    }
    this.cmdMatches = matches
    if (this.cmdIndex >= matches.length) this.cmdIndex = 0
    this.renderCommandMenu()
    if (this.cmdMenuEl) this.cmdMenuEl.hidden = false
  }

  private renderCommandMenu(): void {
    const menu = this.cmdMenuEl
    if (!menu) return
    menu.textContent = ''
    this.cmdMatches.forEach((c, i) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `cmd-row${i === this.cmdIndex ? ' active' : ''}`
      const name = document.createElement('span')
      name.className = 'cmd-name'
      name.textContent = `/${c.name}`
      row.appendChild(name)
      const hint = c.label
      if (hint) {
        const h = document.createElement('span')
        h.className = 'cmd-hint'
        h.textContent = hint
        row.appendChild(h)
      }
      // The menu isn't blur-hidden, so it survives the textarea losing focus on
      // tap and a plain click lands on the row (portable across touch).
      row.addEventListener('click', () => this.chooseCmd(i))
      menu.appendChild(row)
    })
  }

  private moveCmd(delta: number): void {
    const n = this.cmdMatches.length
    if (n === 0) return
    this.cmdIndex = (this.cmdIndex + delta + n) % n
    this.renderCommandMenu()
  }

  /** Open the selected session-info shortcut. */
  private chooseCmd(i: number): void {
    const cmd = this.cmdMatches[i]
    if (!cmd || !this.sendInput) return
    this.hideCommandMenu()
    this.cb.onSend(`/${cmd.name}`)
    this.sendInput.value = ''
    this.sendInput.blur()
    this.syncComposer()
  }

  private hideCommandMenu(): void {
    this.cmdIndex = 0
    this.cmdMatches = []
    if (this.cmdMenuEl) {
      this.cmdMenuEl.hidden = true
      this.cmdMenuEl.textContent = ''
    }
  }

  // ── Connection ──────────────────────────────────────────────────────────
  setConnection(info: { bridge: 'ok' | 'down' | 'connecting'; whoami?: WhoAmI; origin: string; state: string }): void {
    // Only the connect check carries whoami; keep its answer for the redraws.
    if (info.bridge !== 'ok' && this.bridgeStt !== null) {
      this.bridgeStt = null
      this.renderDictHint()
    }
    if (info.whoami) {
      this.bridgeStt = info.whoami.local_stt === true
      this.loggedOut = !info.whoami.logged_in
      this.renderDictHint()
    }
    const ok = info.bridge === 'ok'
    const label = ok ? (this.loggedOut ? 'Logged out' : 'Connected') : info.bridge === 'connecting' ? 'Connecting' : 'Unreachable'
    const cls = ok && !this.loggedOut ? 'ok' : info.bridge === 'connecting' ? 'wait' : 'bad'
    const card = this.connCard
    if (card) {
      card.replaceChildren()
      const text = document.createElement('div')
      text.className = 'conn-text'
      const host = document.createElement('div')
      host.className = 'card-title'
      host.textContent = info.origin ? hostOf(info.origin) : 'No bridge set'
      const sub = document.createElement('div')
      sub.className = 'card-sub'
      sub.textContent =
        info.bridge === 'down'
          ? 'Check the address and token in Settings.'
          : ok && this.loggedOut
            ? 'Log in to Claude Code on the bridge host.'
            : 'Claude Remote bridge'
      text.append(host, sub)
      card.append(text, stateBadge(label, cls))
    }
    this.settingsState?.replaceChildren(stateBadge(label, cls))
  }

  /** Whether the connected bridge transcribes dictation, once known. */
  private bridgeStt: boolean | null = null
  private loggedOut = false
  /** The transcriber picked on the Settings screen (saved on Save). */
  private cardSource: SttSource = 'deepgram'

  /** Pick a transcriber on the Settings screen: mark it, and show the Deepgram
   *  fields only for Deepgram. */
  private pickSource(source: SttSource): void {
    this.cardSource = source
    document.querySelectorAll<HTMLButtonElement>('.stt-source [data-source]').forEach((b) => {
      const on = b.dataset.source === source
      b.classList.toggle('on', on)
      b.setAttribute('aria-checked', String(on))
    })
    for (const id of ['deepgramFields', 'deepgramHint']) {
      const el = document.getElementById(id)
      if (el) el.hidden = source === 'bridge'
    }
    this.renderDictHint()
  }

  /** Under the transcriber choice, for "Bridge": whether the bridge's
   *  host has local dictation, and how to turn it on if not. */
  private renderDictHint(): void {
    const el = document.getElementById('dictHint')
    if (!el) return
    el.replaceChildren()
    el.hidden = this.cardSource !== 'bridge'
    if (el.hidden) return
    if (this.bridgeStt) {
      el.textContent = 'Whisper on the bridge host. The default model transcribes English.'
    } else if (this.bridgeStt === false) {
      el.append('Restart the bridge with this command, then save to reconnect.')
      const cmd = document.createElement('code')
      cmd.className = 'cmd-block'
      cmd.textContent = LOCAL_STT_COMMAND
      el.append(cmd)
    } else {
      el.textContent = 'Connect to the bridge to check whether it has local dictation.'
    }
  }

  /** main.ts has restored the saved settings from the App-side store (or found
   *  none): Settings may open now, and does at once if it was tapped meanwhile. */
  settingsLoaded(): void {
    this.settingsReady = true
    if (this.settingsHeld) {
      this.settingsHeld = false
      this.openSettings()
    }
  }

  // ── Release notices ──────────────────────────────────────────────────────
  /** Render the not-yet-dismissed baked notices (notices.ts) as slim cards
   *  above the session list. Deliberately unobtrusive: no modal, no badge — a
   *  card that sits there until its × is tapped, then never returns (main.ts
   *  persists the dismissal). Empty list hides the area. */
  setNotices(list: Notice[]): void {
    const area = this.noticesEl
    if (!area) return
    area.replaceChildren()
    area.hidden = list.length === 0
    for (const n of list) {
      const card = document.createElement('div')
      card.className = `card notice${n.level === 'important' ? ' important' : ''}`
      const head = document.createElement('div')
      head.className = 'notice-head'
      const title = document.createElement('div')
      title.className = 'notice-title'
      title.textContent = n.title
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'icon-btn small'
      dismiss.innerHTML = ICON.close
      dismiss.setAttribute('aria-label', 'Dismiss notice')
      dismiss.addEventListener('click', () => this.cb.onDismissNotice(n.id))
      head.append(title, dismiss)
      card.appendChild(head)
      const body = document.createElement('div')
      body.className = 'notice-body'
      body.textContent = n.body
      card.appendChild(body)
      if (n.command) {
        // tap-to-select mono block: the wearer copies it onto the bridge host.
        const cmd = document.createElement('code')
        cmd.className = 'cmd-block'
        cmd.textContent = n.command
        card.appendChild(cmd)
      }
      area.appendChild(card)
    }
  }

  // ── Sessions list ────────────────────────────────────────────────────────
  /** Grouped by what each session needs from you: waiting on you first, then
   *  running, then idle. Within a group the order main.ts gives (pins first,
   *  then by title) stands, so a poll never reshuffles a group. */
  setSessions(sessions: ActiveSession[], selectedId: string | null): void {
    const list = this.listEl
    if (!list) return
    list.textContent = ''
    if (sessions.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'card empty'
      empty.textContent = 'No active sessions. A Claude Code session with remote control on shows up here.'
      list.appendChild(empty)
      return
    }
    const groups: [string, StatusKind][] = [
      ['Needs you', 'action'],
      ['Running', 'running'],
      ['Idle', 'idle'],
    ]
    for (const [title, kind] of groups) {
      const members = sessions.filter((s) => statusOf(s.workerStatus).cls === kind)
      if (members.length === 0) continue
      const section = document.createElement('section')
      section.className = 'group'
      const h = document.createElement('h2')
      h.className = 'group-title'
      h.textContent = title
      section.appendChild(h)
      if (kind === 'idle') {
        const card = document.createElement('div')
        card.className = 'list-card'
        for (const s of members) card.appendChild(this.idleRow(s, s.id === selectedId))
        section.appendChild(card)
      } else {
        const stack = document.createElement('div')
        stack.className = 'stack'
        for (const s of members) stack.appendChild(this.sessionCard(s, kind, s.id === selectedId))
        section.appendChild(stack)
      }
      list.appendChild(section)
    }
  }

  /** A running or blocked session: title, what it is doing (or waiting on),
   *  and its model, effort and context. */
  private sessionCard(s: ActiveSession, kind: StatusKind, selected: boolean): HTMLElement {
    const row = this.rowShell(s, `card session-card ${kind}${selected ? ' selected' : ''}`)
    const body = document.createElement('div')
    body.className = 'row-body'
    const top = document.createElement('div')
    top.className = 'row-top'
    top.append(this.titleWithMarks(s, 'card-title big'))
    const time = document.createElement('span')
    time.className = 'row-time'
    time.textContent = relTime(s.lastEventAt)
    top.appendChild(time)
    body.appendChild(top)
    const gist = s.needsAction || s.summary
    if (gist) {
      const line = document.createElement('div')
      line.className = 'row-gist'
      line.textContent = gist
      body.appendChild(line)
    }
    const meta = document.createElement('div')
    meta.className = 'row-meta'
    const bits = [s.pinned ? 'Pinned' : '', modelLabel(s.model), s.effort ?? ''].filter(Boolean)
    const label = document.createElement('span')
    label.textContent = bits.join(' · ')
    meta.appendChild(label)
    if (s.context?.percent != null) meta.append(meterEl(s.context.percent, 'small'), `${s.context.percent}%`)
    body.appendChild(meta)
    row.appendChild(body)
    row.insertAdjacentHTML('beforeend', `<span class="row-chev">${ICON.chev}</span>`)
    return row
  }

  /** An idle session: a row in the grouped Idle card. */
  private idleRow(s: ActiveSession, selected: boolean): HTMLElement {
    const row = this.rowShell(s, `idle-row${selected ? ' selected' : ''}`)
    const body = document.createElement('div')
    body.className = 'row-body'
    body.appendChild(this.titleWithMarks(s, 'card-title'))
    const sub = document.createElement('div')
    sub.className = 'card-sub ellipsis'
    sub.textContent = [s.pinned ? 'Pinned' : '', s.summary ?? '', relTime(s.lastEventAt)].filter(Boolean).join(' · ')
    if (sub.textContent) body.appendChild(sub)
    row.appendChild(body)
    row.insertAdjacentHTML('beforeend', `<span class="row-chev">${ICON.chev}</span>`)
    return row
  }

  private rowShell(s: ActiveSession, cls: string): HTMLElement {
    const row = document.createElement('div')
    row.className = cls
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    const open = () => this.cb.onSelectSession(s.id)
    row.addEventListener('click', open)
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    })
    return row
  }

  /** The title with the unread mark: the Figma's square notification dot. */
  private titleWithMarks(s: ActiveSession, cls: string): HTMLElement {
    const name = document.createElement('span')
    name.className = cls
    const text = document.createElement('span')
    text.className = 'ellipsis'
    text.textContent = s.title || 'Untitled session'
    name.appendChild(text)
    if (s.unread) {
      const u = document.createElement('span')
      u.className = 'unread'
      u.title = 'Unread'
      u.setAttribute('aria-label', 'Unread')
      name.appendChild(u)
    }
    return name
  }

  // ── Session screen ──────────────────────────────────────────────────────
  setActiveSession(session: ActiveSession | null): void {
    this.setHistoryBefore(null)
    const nextSid = session?.id ?? null
    if (this.sendInput && nextSid !== this.currentSid) {
      if (this.currentSid && this.sendInput.value) this.drafts.set(this.currentSid, this.sendInput.value)
      this.sendInput.value = nextSid ? this.drafts.get(nextSid) ?? '' : ''
      if (nextSid) this.drafts.delete(nextSid)
      this.closeControls()
    }
    this.currentSid = nextSid
    if (this.claudeLink) {
      if (session) this.claudeLink.href = `https://claude.ai/code/${encodeURIComponent(session.id)}`
      else this.claudeLink.removeAttribute('href')
    }
    this.hideCommandMenu() // never carry a stale popover across an open/close
    this.showScreen(session ? 'detail' : 'list')
    if (!session) {
      this.session = null
      this.closeControls()
      this.syncComposer()
      return
    }
    if (this.detailTitle) this.detailTitle.textContent = session.title || 'Untitled session'
    this.refreshSession(session)
  }

  /** The open session's fresh metadata (every list poll): status, settings,
   *  context, summary, and whether Stop applies. */
  refreshSession(session: ActiveSession): void {
    if (session.id !== this.currentSid) return
    this.session = session
    this.renderMeta()
  }

  /** The worker's live settings (from the event stream): model, effort, mode. */
  setWorkerState(worker: WorkerState | null): void {
    this.worker = worker
    this.renderMeta()
  }

  /** Model, effort and mode as the worker last reported them. Unknown stays
   *  blank: never a guess. */
  private live(): { model: string | null; effort: string | null; mode: string | null } {
    const s = this.session
    const w = this.worker
    return {
      model: w?.model ?? s?.model ?? null,
      effort: w?.effort ?? s?.effort ?? null,
      mode: w?.permissionMode ?? s?.permissionMode ?? null,
    }
  }

  private renderMeta(): void {
    const s = this.session
    if (!s) return
    const { model, effort, mode } = this.live()
    const card = this.statusCard
    if (card) {
      const st = statusOf(s.workerStatus)
      card.className = `card status ${st.cls}`
      card.replaceChildren()
      const text = document.createElement('div')
      text.className = 'conn-text'
      const line1 = document.createElement('div')
      line1.className = 'card-title'
      line1.textContent = [modelLabel(model), effort ?? ''].filter(Boolean).join(' · ') || 'Model not reported yet'
      const line2 = document.createElement('div')
      line2.className = 'card-sub'
      line2.textContent = [modeLabel(mode, 'long'), s.context?.percent != null ? `context ${s.context.percent}%` : ''].filter(Boolean).join(' · ')
      text.append(line1)
      if (line2.textContent) text.append(line2)
      const gist = s.needsAction || s.summary || ''
      if (gist) {
        const g = document.createElement('div')
        g.className = 'status-gist'
        g.textContent = gist
        text.append(g)
      }
      card.appendChild(text)
      // A prompt set aside with ✕ is one tap away: the badge reopens it.
      if (this.promptKind !== 'none' && this.promptHidden) {
        const review = document.createElement('button')
        review.type = 'button'
        review.className = 'btn small dark'
        review.dataset.review = '1'
        review.textContent = 'Review'
        card.appendChild(review)
      } else {
        card.appendChild(stateBadge(st.label, st.cls === 'running' ? 'ok' : st.cls === 'action' ? 'plain' : 'idle'))
      }
    }
    this.syncComposer()
    this.renderControls()
  }

  // ── Session controls (the ⋯ sheet) ───────────────────────────────────────
  private openControls(): void {
    if (!this.session || !this.controlsSheet) return
    this.controlsSheet.hidden = false
    if (this.controlsOverlay) this.controlsOverlay.hidden = false
    this.renderControls()
    // Usage and changes are fetched on open; each fetch leaves a hidden
    // control request in the session's log, so it is never polled.
    if (!this.infoView?.loading) this.cb.onLoadInfo()
  }

  private closeControls(): void {
    if (this.controlsSheet) this.controlsSheet.hidden = true
    if (this.controlsOverlay) this.controlsOverlay.hidden = true
    if (this.archiveTimer !== null) clearTimeout(this.archiveTimer)
    this.archiveTimer = null
    this.archiveArmed = false
  }

  private controlsOpen(): boolean {
    return !!this.controlsSheet && !this.controlsSheet.hidden
  }

  /** Segmented selector: the Figma's #E4E4E4 track with a white selected
   *  segment. `current` null selects nothing. */
  private segmented(
    label: string,
    options: { value: string; label: string; danger?: boolean }[],
    current: string | null,
    pick: (value: string) => void,
  ): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'group'
    const h = document.createElement('div')
    h.className = 'group-title'
    h.textContent = label
    const seg = document.createElement('div')
    seg.className = 'seg'
    seg.setAttribute('role', 'radiogroup')
    seg.setAttribute('aria-label', label)
    seg.style.gridTemplateColumns = `repeat(${options.length}, minmax(0, 1fr))`
    for (const o of options) {
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('role', 'radio')
      const on = o.value === current
      b.setAttribute('aria-checked', String(on))
      b.className = `${on ? 'on' : ''}${o.danger ? ' danger' : ''}`
      b.textContent = o.label
      b.addEventListener('click', () => {
        if (!on) pick(o.value)
      })
      seg.appendChild(b)
    }
    wrap.append(h, seg)
    return wrap
  }

  private renderControls(): void {
    const body = this.controlsBody
    const s = this.session
    if (!body || !s || !this.controlsOpen()) return
    const title = document.getElementById('controlsTitle')
    if (title) title.textContent = s.title || 'Untitled session'
    const { model, effort, mode } = this.live()
    if (this.controlsSub) {
      const version = this.worker?.ccVersion ?? s.ccVersion
      this.controlsSub.textContent = version ? `Claude Code ${version}` : ''
    }
    body.replaceChildren()

    // A model this build's list lacks (a newer release) is real: it gets its
    // own segment, so the selector never shows another model in its place.
    const models = MODELS.map((m) => ({ value: m.id, label: m.label }))
    if (model && !models.some((m) => m.value === model)) models.push({ value: model, label: model })
    body.appendChild(this.segmented('Model', models, model, (v) => this.cb.onSetModel(v)))
    body.appendChild(
      this.segmented(
        'Effort',
        EFFORTS.map((e) => ({ value: e.id ?? 'auto', label: effortLabel(e.label) })),
        effort,
        (v) => this.cb.onSetEffort(v),
      ),
    )
    body.appendChild(
      this.segmented(
        'Permissions',
        MODES.map((m) => ({ value: m, label: modeLabel(m, 'short'), danger: m === 'bypassPermissions' })),
        mode,
        (v) => this.cb.onSetMode(v as PermissionMode),
      ),
    )

    // Usage: context from the session object (free), plan windows on demand.
    const usage = document.createElement('div')
    usage.className = 'group'
    const uh = document.createElement('div')
    uh.className = 'group-head'
    const ut = document.createElement('div')
    ut.className = 'group-title'
    ut.textContent = 'Usage'
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'link-btn'
    refresh.textContent = this.infoView?.loading ? 'Asking…' : 'Refresh'
    refresh.disabled = !!this.infoView?.loading
    refresh.addEventListener('click', () => this.cb.onLoadInfo())
    uh.append(ut, refresh)
    const uc = document.createElement('div')
    uc.className = 'card usage'
    const v = this.infoView
    const ctx = v?.info?.context ?? s.context
    if (ctx?.percent != null) uc.appendChild(usageRow('Context', ctx.percent))
    for (const l of v?.info?.usage?.limits ?? []) if (l.percent != null) uc.appendChild(usageRow(limitLabel(l.kind, l.model), l.percent))
    if (ctx?.usedTokens != null && ctx.maxTokens != null) uc.appendChild(noteLine(`${ctx.usedTokens.toLocaleString()} of ${ctx.maxTokens.toLocaleString()} context tokens`))
    for (const c of v?.info?.context?.categories ?? []) uc.appendChild(noteLine(`${c.name} · ${c.tokens.toLocaleString()} tokens`))
    if (s.rateLimit) uc.appendChild(noteLine(rateLimitLabel(s)))
    if (v?.error) uc.appendChild(noteLine(v.error))
    if (!uc.childElementCount) uc.appendChild(noteLine(v?.loading ? 'Asking the worker…' : 'Context usage unavailable'))
    usage.append(uh, uc)
    body.appendChild(usage)

    // Changes, background tasks, the link out: one grouped list.
    const list = document.createElement('div')
    list.className = 'list-card'
    const d = v?.info?.diff
    const changes = d ? (d.files ? `${d.files} file${d.files > 1 ? 's' : ''} · +${d.added} −${d.removed}` : 'None uncommitted') : v?.info?.diffPending ? 'Still counting' : v?.loading ? '…' : '—'
    list.appendChild(infoRow('Changes', changes))
    for (const t of this.tasks) {
      const row = infoRow(t.description || t.id, '')
      const stop = document.createElement('button')
      stop.type = 'button'
      stop.className = 'btn small danger'
      stop.textContent = 'Stop'
      stop.addEventListener('click', () => this.cb.onStopTask(t.id))
      row.appendChild(stop)
      list.appendChild(row)
    }
    if (this.tasks.length === 0) list.appendChild(infoRow('Background tasks', 'None running'))
    const link = document.createElement('a')
    link.className = 'field-row'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.href = `https://claude.ai/code/${encodeURIComponent(s.id)}`
    link.innerHTML = `<span class="field-name">Open in Claude</span><span class="row-value">${ICON.external}</span>`
    list.appendChild(link)
    body.appendChild(list)

    // Pin (when the bridge reports pins) and Archive.
    const acts = document.createElement('div')
    acts.className = 'pair'
    if (s.pinned !== undefined) {
      const pin = document.createElement('button')
      pin.type = 'button'
      pin.className = 'btn'
      pin.title = 'Pinned sessions lead the list, here and on claude.ai'
      pin.textContent = s.pinned ? 'Unpin' : 'Pin'
      pin.addEventListener('click', () => this.cb.onSetPinned(!s.pinned))
      acts.appendChild(pin)
    }
    const archive = document.createElement('button')
    archive.type = 'button'
    archive.className = `btn danger${this.archiveArmed ? ' armed' : ''}`
    archive.textContent = this.archiveArmed ? 'Tap again to archive' : 'Archive'
    archive.addEventListener('click', () => this.archiveClick(archive))
    acts.appendChild(archive)
    body.appendChild(acts)
  }

  // ── Side question card ─────────────────────────────────────────────────────
  /** The latest side question and its answer (or "asking…"), above the log. */
  setAside(aside: AsideView | null): void {
    const card = this.asideCard
    if (!card) return
    card.replaceChildren()
    card.hidden = !aside
    if (!aside) return
    const head = document.createElement('div')
    head.className = 'notice-head'
    const label = document.createElement('span')
    label.className = 'aside-label'
    label.textContent = 'Asked aside · not in the transcript'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'icon-btn small'
    close.innerHTML = ICON.close
    close.setAttribute('aria-label', 'Dismiss')
    close.addEventListener('click', () => this.cb.onDismissAside())
    head.append(label, close)
    const q = document.createElement('div')
    q.className = 'aside-q'
    q.textContent = aside.question
    const a = document.createElement('div')
    a.className = `aside-a${aside.error ? ' err' : aside.answer == null ? ' pending' : ''}`
    a.textContent = aside.error ?? aside.answer ?? 'Asking…'
    card.append(head, q, a)
  }

  // ── Background tasks + on-demand info ───────────────────────────────────
  /** The running background set (live from the event stream). */
  setTasks(tasks: BackgroundTask[]): void {
    this.tasks = tasks
    this.renderControls()
  }

  /** The on-demand part — plan usage + git changes — or null to clear it. */
  setInfo(view: InfoView | null): void {
    this.infoView = view
    this.renderControls()
  }

  /** `/context` or `/usage` from the send box: show them in the controls sheet. */
  focusInfo(): void {
    if (!this.session || !this.controlsSheet) return
    this.controlsSheet.hidden = false
    if (this.controlsOverlay) this.controlsOverlay.hidden = false
    this.renderControls()
  }

  // ── Event log ─────────────────────────────────────────────────────────────
  private setHistoryBefore(before?: number | null): void {
    this.historyBefore = before ?? null
    this.historyRevision++
    if (this.olderButton) {
      this.olderButton.hidden = this.historyBefore == null
      this.olderButton.disabled = false
    }
  }

  private async loadOlderEvents(): Promise<void> {
    const before = this.historyBefore
    const button = this.olderButton
    const log = this.logEl
    if (before == null || !button || button.disabled || !log) return
    const revision = this.historyRevision
    button.disabled = true
    const page = await this.cb.onOlderEvents(before)
    if (revision !== this.historyRevision) return
    button.disabled = false
    if (!page) return
    const previous = log.firstElementChild
    const offset = previous?.getBoundingClientRect().top
    const fragment = document.createDocumentFragment()
    for (const e of page.events) {
      if (e.sequenceNum == null || e.sequenceNum >= before || this.seen.has(e.sequenceNum)) continue
      this.seen.add(e.sequenceNum)
      const node = this.eventNode(e)
      if (node) fragment.appendChild(node)
    }
    log.prepend(fragment)
    if (previous && offset != null && this.scrollEl) this.scrollEl.scrollTop += previous.getBoundingClientRect().top - offset
    this.setHistoryBefore(page.before != null && page.before < before ? page.before : null)
  }

  setEvents(events: RcEvent[], before?: number | null): void {
    if (!this.logEl) return
    this.logEl.textContent = ''
    this.seen = new Set()
    this.lastFold = null
    for (const e of events) {
      if (e.sequenceNum != null) this.seen.add(e.sequenceNum)
      this.appendNode(e)
    }
    this.setHistoryBefore(before)
    if (this.scrollEl) this.scrollEl.scrollTop = this.scrollEl.scrollHeight
  }

  appendEvent(e: RcEvent): void {
    if (!this.logEl) return
    // The stream resumes at the last history seq, so the seam overlaps — dedupe
    // exactly like the HUD's EventLog so the panel doesn't double-render.
    if (e.sequenceNum != null) {
      if (this.seen.has(e.sequenceNum)) return
      this.seen.add(e.sequenceNum)
    }
    const follow = this.nearBottom()
    this.appendNode(e)
    if (follow && this.scrollEl) this.scrollEl.scrollTop = this.scrollEl.scrollHeight
  }

  /** Render one event into the log, folding a run of identically-rendered
   *  simple rows into a single `… ×N` row (see `lastFold`), and joining a run
   *  of tool calls into one card. */
  private appendNode(e: RcEvent): void {
    const log = this.logEl
    if (!log) return
    // The panel twin of EventLog's reset: only what follows a /clear stays. `seen`
    // survives, so a replay can't bring the old events back.
    if (e.type === 'conversation_reset' && !e.parentToolUseId) {
      this.setHistoryBefore(null)
      log.textContent = ''
      this.lastFold = null
    }
    const node = this.eventNode(e)
    if (!node) return
    // Consecutive tool calls (from one agent: the main loop or a subagent)
    // share one card, as the HUD packs them into one chain line.
    const last = log.lastElementChild
    if (
      node.classList.contains('tools') &&
      last?.classList.contains('tools') &&
      node.classList.contains('subagent') === last.classList.contains('subagent')
    ) {
      last.append(...Array.from(node.children))
      this.lastFold = null
      return
    }
    const foldable = node.childElementCount === 0
    const key = foldable ? `${e.parentToolUseId ?? ''}\0${node.className}\0${node.textContent ?? ''}` : ''
    if (foldable && this.lastFold?.key === key) {
      this.lastFold.count++
      this.lastFold.el.textContent = `${this.lastFold.base} ×${this.lastFold.count}`
      return
    }
    log.appendChild(node)
    this.lastFold = foldable ? { key, base: node.textContent ?? '', count: 1, el: node } : null
  }

  private eventNode(e: RcEvent): HTMLDivElement | null {
    const node = renderEventNode(e)
    if (!node) return null
    if (e.parentToolUseId) node.classList.add('subagent')
    return node
  }

  /** Follow the newest event unless the reader scrolled up into history. */
  private nearBottom(): boolean {
    const el = this.scrollEl
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  // ── Voice dictation ──────────────────────────────────────────────────────
  /** Reflect dictation active/idle on the mic button. Driven by main.ts's
   *  voice lifecycle (not by interim-text presence, which lags the mic opening). */
  setDictating(active: boolean): void {
    this.dictating = active
    if (this.dictateBtn) {
      this.dictateBtn.classList.toggle('live', active)
      this.dictateBtn.setAttribute('aria-label', active ? 'Stop dictating' : 'Dictate')
    }
    if (!active && this.interimEl) {
      this.interimEl.textContent = ''
      this.interimEl.hidden = true
    }
    this.syncComposer()
  }

  setInterim(text: string): void {
    if (this.interimEl) {
      this.interimEl.textContent = text
      this.interimEl.hidden = text.length === 0
    }
  }

  /** Put `text` in the send box, after any draft already there, to edit or send
   *  — where a failed panel dictation hands back what it heard. */
  appendDraft(text: string): void {
    const box = this.sendInput
    if (!box) return
    const draft = box.value.trimEnd()
    box.value = draft ? `${draft} ${text}` : text
    this.syncComposer()
  }

  // ── Blocking prompt (a pop-up sheet over the session) ─────────────────────
  /** Open the sheet for `kind`. A new prompt (`key` changed) opens even if the
   *  last one was closed with ✕. */
  private presentPrompt(kind: 'permission' | 'question' | 'external', key: string): HTMLElement | null {
    const sheet = this.promptSheet
    if (!sheet) return null
    if (key !== this.promptKey) this.promptHidden = false
    this.promptKey = key
    this.promptKind = kind
    sheet.replaceChildren()
    this.closeControls()
    this.syncPromptVisibility()
    return sheet
  }

  private clearPrompt(): void {
    this.promptKind = 'none'
    this.promptKey = ''
    this.promptHidden = false
    this.promptSheet?.replaceChildren()
    this.syncPromptVisibility()
  }

  private hidePrompt(): void {
    this.promptHidden = true
    this.syncPromptVisibility()
  }

  private showPrompt(): void {
    this.promptHidden = false
    this.syncPromptVisibility()
  }

  private syncPromptVisibility(): void {
    const open = this.promptKind !== 'none' && !this.promptHidden
    if (this.promptSheet) this.promptSheet.hidden = !open
    if (this.promptOverlay) this.promptOverlay.hidden = !open
    this.renderMeta()
  }

  /** The sheet's centred title, description and a ✕ that sets it aside. */
  private promptHead(sheet: HTMLElement, title: string, desc: string): void {
    const head = document.createElement('div')
    head.className = 'sheet-head'
    const side = document.createElement('span')
    side.className = 'nav-side'
    const titles = document.createElement('div')
    titles.className = 'sheet-titles'
    const h = document.createElement('h2')
    h.className = 'sheet-title'
    h.textContent = title
    titles.appendChild(h)
    if (desc) {
      const d = document.createElement('div')
      d.className = 'sheet-desc'
      d.textContent = desc
      titles.appendChild(d)
    }
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'icon-btn'
    close.innerHTML = ICON.close
    close.setAttribute('aria-label', 'Set aside without answering')
    close.title = 'Set aside without answering'
    close.addEventListener('click', () => this.hidePrompt())
    head.append(side, titles, close)
    sheet.appendChild(head)
  }

  setPermission(p: PermissionRequest | null): void {
    if (!p) {
      if (this.promptKind === 'permission' || this.promptKind === 'external') this.clearPrompt()
      return
    }
    const sheet = this.presentPrompt('permission', p.toolUseId ?? `${p.toolName}\0${formatInput(p.input)}`)
    if (!sheet) return
    const tool = p.toolName ?? 'this tool'
    const desc = typeof p.input?.description === 'string' ? p.input.description : ''
    this.promptHead(sheet, `Allow ${tool}?`, desc)

    const body = document.createElement('div')
    body.className = 'sheet-body'
    const input = formatInput(p.input)
    if (input) {
      const pre = document.createElement('pre')
      pre.className = 'code-card'
      // A lone command or path reads best as itself; anything richer as JSON.
      const keys = Object.keys(p.input ?? {}).filter((k) => k !== 'description')
      const lone = keys.length === 1 ? p.input?.[keys[0]] : undefined
      pre.textContent = typeof lone === 'string' ? lone : input
      body.appendChild(pre)
    }

    const acts = document.createElement('div')
    acts.className = 'stack'
    acts.appendChild(arrowButton('Allow', 'primary', () => this.cb.onAnswerPermission('allow')))
    if (p.sessionRule) {
      const rule = p.sessionRule
      const btn = arrowButton('Allow for this session', '', () => this.cb.onAnswerPermission('allow', undefined, rule))
      const r = document.createElement('span')
      r.className = 'btn-note'
      r.textContent = rule
      btn.appendChild(r)
      acts.appendChild(btn)
    }
    const note = document.createElement('input')
    note.className = 'text-input'
    note.placeholder = 'Optional: what to do instead'
    note.setAttribute('aria-label', 'Reason for denying')
    const deny = arrowButton('Deny', 'danger', () => this.cb.onAnswerPermission('deny', note.value.trim()))
    note.addEventListener('input', () => {
      const label = deny.querySelector('.btn-label')
      if (label) label.textContent = note.value.trim() ? 'Deny with note' : 'Deny'
    })
    acts.appendChild(deny)
    const noteWrap = document.createElement('label')
    noteWrap.className = 'group'
    const noteLabel = document.createElement('span')
    noteLabel.className = 'group-title'
    noteLabel.textContent = 'Deny with a note'
    noteWrap.append(noteLabel, note)
    body.append(acts, noteWrap)
    sheet.appendChild(body)
  }

  showExternalDialog(): void {
    const sheet = this.presentPrompt('external', `external:${this.currentSid}`)
    if (!sheet) return
    this.promptHead(sheet, 'Answer in Claude', 'This dialog can only be answered in Claude.')
    const body = document.createElement('div')
    body.className = 'sheet-body'
    const link = document.createElement('a')
    link.className = 'btn primary arrow-btn'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    if (this.currentSid) link.href = `https://claude.ai/code/${encodeURIComponent(this.currentSid)}`
    link.innerHTML = `${ICON.arrow}<span class="btn-label">Open in Claude</span>`
    body.appendChild(link)
    sheet.appendChild(body)
  }

  // ── Question dialog (AskUserQuestion / request_user_dialog) ─────────────────
  /** Render a blocking QUESTION with its options as buttons (or hide when null).
   *  A picked option shows selected. Clicking one answers a single-select
   *  question; a multi-select toggles it and is answered by its Done button
   *  (`done[i]` = question i is settled). */
  setDialog(questions: DialogQuestion[] | null, picks: string[][], done: boolean[]): void {
    if (questions !== this.draftQuestions) {
      this.dialogDrafts.clear()
      this.draftQuestions = questions
    }
    if (!questions || questions.length === 0) {
      if (this.promptKind === 'question') this.clearPrompt()
      return
    }
    const key = `q:${questions.map((q) => q.question).join('\0')}`
    const scroll = this.promptSheet?.querySelector('.sheet-body')?.scrollTop ?? 0
    const sheet = this.presentPrompt('question', key)
    if (!sheet) return
    const first = questions[0]
    this.promptHead(sheet, questions.length > 1 ? `Claude asks ${questions.length} questions` : first.header || 'Claude asks', '')

    const body = document.createElement('div')
    body.className = 'sheet-body'
    questions.forEach((q, qi) => {
      const block = document.createElement('div')
      block.className = 'group'
      const qt = document.createElement('div')
      qt.className = 'q-text'
      qt.textContent = q.question || q.header || 'Question'
      block.appendChild(qt)
      if (q.multiSelect) {
        const hint = document.createElement('div')
        hint.className = 'group-title'
        hint.textContent = 'Pick any, then tap Done'
        block.appendChild(hint)
      }

      const opts = document.createElement('div')
      opts.className = 'stack'
      const options = q.options.length ? q.options : [{ label: 'Proceed', description: '' }]
      for (const o of options) {
        const chosen = (picks[qi] ?? []).includes(o.label)
        const b = document.createElement('button')
        b.type = 'button'
        b.className = `btn option${chosen ? ' chosen' : ''}`
        b.setAttribute('aria-pressed', String(chosen))
        const l = document.createElement('span')
        l.className = 'option-label'
        l.textContent = o.label
        b.appendChild(l)
        if (o.description) {
          const d = document.createElement('span')
          d.className = 'option-desc'
          d.textContent = o.description
          b.appendChild(d)
        }
        b.addEventListener('click', () => this.cb.onPickDialogOption(qi, o.label))
        opts.appendChild(b)
      }
      for (const label of picks[qi] ?? []) {
        if (options.some((o) => o.label === label)) continue
        const pick = document.createElement('button')
        pick.type = 'button'
        pick.className = 'btn option chosen'
        pick.textContent = label
        pick.onclick = () => this.cb.onPickDialogOption(qi, label)
        opts.appendChild(pick)
      }
      block.appendChild(opts)

      const otherRow = document.createElement('div')
      otherRow.className = 'input-row'
      const custom = document.createElement('input')
      custom.placeholder = 'Other answer'
      custom.setAttribute('aria-label', `Other answer for ${q.question}`)
      custom.className = 'text-input'
      const other = document.createElement('button')
      other.type = 'button'
      other.className = 'btn'
      other.textContent = q.multiSelect ? 'Add' : 'Use'
      custom.value = this.dialogDrafts.get(qi) ?? ''
      other.disabled = !custom.value.trim()
      custom.oninput = () => {
        this.dialogDrafts.set(qi, custom.value)
        other.disabled = !custom.value.trim()
      }
      other.onclick = () => {
        const value = custom.value.trim()
        if (!value) return
        this.dialogDrafts.delete(qi)
        this.cb.onPickDialogOption(qi, value)
      }
      otherRow.append(custom, other)
      block.appendChild(otherRow)

      if (q.multiSelect) {
        const n = picks[qi]?.length ?? 0
        const ok = arrowButton(done[qi] ? `Done · ${n} picked` : n > 0 ? `Done (${n})` : 'Done', n > 0 && !done[qi] ? 'primary' : '', () =>
          this.cb.onConfirmDialogPicks(qi),
        )
        ok.disabled = n === 0 || !!done[qi]
        block.appendChild(ok)
      }
      body.appendChild(block)
    })
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn ghost'
    cancel.textContent = 'Dismiss the question'
    cancel.addEventListener('click', () => this.cb.onCancelDialog())
    body.appendChild(cancel)
    sheet.appendChild(body)
    // A pick re-renders the sheet; keep the reader where they were.
    body.scrollTop = scroll
  }

  // ── Transient toast ──────────────────────────────────────────────────────
  /** Show `msg` for `ms` ('' hides it). A long message needs a longer `ms`. */
  setToast(msg: string, ms = 3000): void {
    const el = this.toastEl
    if (!el) return
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    if (!msg) {
      el.hidden = true
      el.textContent = ''
      return
    }
    el.textContent = msg
    el.hidden = false
    this.toastTimer = window.setTimeout(() => {
      el.hidden = true
      el.textContent = ''
      this.toastTimer = null
    }, ms)
  }
}

// ─── pure DOM builders (no instance state) ───────────────────────────────────

/** Escape a string for safe interpolation into innerHTML. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/** A status label with the Figma's square dot: `ok` green, `bad` red,
 *  `wait`/`idle` grey, `plain` no dot. */
function stateBadge(label: string, cls: 'ok' | 'bad' | 'wait' | 'idle' | 'plain'): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = `state ${cls}`
  el.textContent = label
  return el
}

/** A thin bar for a percentage (context, plan windows). */
function meterEl(percent: number, size: 'small' | 'full'): HTMLSpanElement {
  const track = document.createElement('span')
  track.className = `meter ${size}`
  const fill = document.createElement('span')
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`
  track.appendChild(fill)
  return track
}

function usageRow(label: string, percent: number): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'usage-row'
  const l = document.createElement('span')
  l.textContent = label
  const p = document.createElement('span')
  p.className = 'usage-pct'
  p.textContent = `${percent}%`
  row.append(l, meterEl(percent, 'full'), p)
  return row
}

function noteLine(text: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'usage-note'
  el.textContent = text
  return el
}

function infoRow(name: string, value: string): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'field-row'
  const n = document.createElement('span')
  n.className = 'field-name ellipsis'
  n.textContent = name
  row.appendChild(n)
  if (value) {
    const v = document.createElement('span')
    v.className = 'row-value'
    v.textContent = value
    row.appendChild(v)
  }
  return row
}

/** The Figma's "→ Button text" button. */
function arrowButton(label: string, cls: string, click: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `btn arrow-btn ${cls}`.trim()
  b.innerHTML = ICON.arrow
  const l = document.createElement('span')
  l.className = 'btn-label'
  l.textContent = label
  b.appendChild(l)
  b.addEventListener('click', click)
  return b
}

/**
 * One RcEvent → a log node (or null to drop it: partial stream deltas,
 * control responses, bare tool_result echoes). Unlike the HUD's renderEventParts,
 * this keeps each tool's FULL input, folded under a one-line row — the phone
 * has room.
 */
function renderEventNode(e: RcEvent): HTMLDivElement | null {
  switch (e.type) {
    case 'assistant': {
      const text = e.text.trim()
      const tools = e.toolUses.length ? toolGroup(e.toolUses) : null
      if (!text) return tools
      const row = document.createElement('div')
      row.className = 'ev ev-assistant'
      const body = document.createElement('div')
      body.className = 'ev-text'
      body.textContent = text
      row.appendChild(body)
      if (!tools) return row
      // Text and tools in one event: the text card, then the tool card.
      const wrap = document.createElement('div')
      wrap.className = 'ev ev-pair'
      wrap.append(row, tools)
      return wrap
    }

    case 'user': {
      // What the worker left in the user slot (a finished background task, an
      // interrupt marker) is a system row, as on the HUD — not a message.
      const notes = workerNotes(e.text)
      if (notes) {
        if (notes.length === 0) return null
        const row = document.createElement('div')
        row.className = 'ev ev-system'
        row.textContent = notes.join('\n')
        return row
      }
      // Clean local-command echoes the same way the HUD does: strip the
      // model-directed caveat block and unwrap `<command-name>` / stdout tags, so
      // a fired slash command reads as `/context`, not raw XML tag soup.
      const text = cleanUserEcho(e.text).trim()
      if (!text) return null // bare tool_result echo / caveat-only — noise
      // Your message → a right-aligned #F6F6F6 card (the Figma's sent bubble).
      const row = document.createElement('div')
      row.className = 'ev ev-user'
      const body = document.createElement('div')
      body.className = 'ev-text'
      body.textContent = text
      row.appendChild(body)
      return row
    }

    case 'result': {
      const u = e.usage
      const ok = !(u?.isError ?? false) && e.subtype !== 'error' && !e.subtype?.startsWith('error')
      const row = document.createElement('div')
      row.className = `ev ev-result ${ok ? 'ok' : 'err'}`
      row.textContent = resultLine(e, ok)
      return row
    }

    case 'system': {
      // Workers re-post init on every attach and every model / mode / effort
      // change: it reads as "settings now" (an older bridge can't say more).
      let label = ''
      if (e.subtype === 'init') label = e.workerState ? settingsLine(e.workerState) : `Session started (${e.model ?? 'unknown model'})`
      else if (e.subtype === 'compact_boundary') label = 'Context compacted'
      if (!label && systemActivity(e)) label = systemActivity(e)
      if (!label) return null
      const row = document.createElement('div')
      row.className = 'ev ev-system'
      row.textContent = label
      return row
    }

    case 'conversation_reset': {
      const row = document.createElement('div')
      row.className = 'ev ev-system'
      row.textContent = 'Conversation cleared'
      return row
    }

    case 'catch_up_truncated': {
      const row = document.createElement('div')
      row.className = 'ev ev-system'
      row.textContent = 'Some earlier events were skipped'
      return row
    }

    case 'control_request': {
      if (!e.isBlockingControl) return null
      const row = document.createElement('div')
      row.className = 'ev ev-perm'
      const p = e.permissionRequest
      if (isQuestionRequest(e)) {
        const gist = p?.questions?.[0]?.question || p?.questions?.[0]?.header || p?.prompt || 'a question'
        row.textContent = `Asked you: ${gist}`
      } else {
        row.textContent = `Asked to use ${p?.toolName ?? 'a tool'}`
      }
      return row
    }

    default:
      // stream_event, control_response, and anything else is noise.
      return null
  }
}

/** Tool calls as one-line rows in a card; a tap opens the full input. */
function toolGroup(tools: RcEvent['toolUses']): HTMLDivElement {
  const wrap = document.createElement('div')
  wrap.className = 'ev tools'
  for (const t of tools) {
    const input = formatInput(t.input)
    const row = document.createElement(input ? 'details' : 'div')
    row.className = 'tool'
    const head = document.createElement(input ? 'summary' : 'div')
    head.className = 'tool-head'
    const name = document.createElement('span')
    name.className = 'tool-name'
    name.textContent = t.name ?? 'Tool'
    const arg = document.createElement('span')
    arg.className = 'tool-arg'
    arg.textContent = toolArg(t.input)
    head.append(name, arg)
    row.appendChild(head)
    if (input) {
      const pre = document.createElement('pre')
      pre.className = 'tool-input'
      pre.textContent = input
      row.appendChild(pre)
    }
    wrap.appendChild(row)
  }
  return wrap
}

// ─── styles ──────────────────────────────────────────────────────────────────

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  // Even Realities Software Design Guidelines (public Figma, APP pages), light:
  //   BC-3rd #EEEEEE page · BC-1st #FFFFFF cards · BC-2nd #F6F6F6 sent message
  //   and supporting fills · BC-4th #E4E4E4 selector track and pressed fills ·
  //   BC-Highlight #232323 primary button · BC-Accent #FEF991 an ongoing
  //   action or something waiting on you · TC-1st #232323 · TC-2nd #7B7B7B ·
  //   TC-Green #4BB956 connection · TC-Red #FF453A as TEXT on a white button ·
  //   SC-1st 50% black overlay behind a pop-up · SC-2nd 8% #232323 input fill.
  //   Flat fills, no borders, no divider lines inside a grouped list; only
  //   floating surfaces (toast, popover) carry a shadow. Type on the
  //   24/20/17/15/13/11 scale, 400 titles and 300 body, -1% tracking. 6px
  //   radius (4-5px nested), 12px page margins, 6/12/24px spacing. FK Grotesk
  //   isn't shippable, so the system grotesque stack stands in. Disabled =
  //   opacity, per the Figma's button notes.
  const css = `
    :root {
      color-scheme: light;
      --bc-3rd:    #EEEEEE;
      --bc-2nd:    #F6F6F6;
      --bc-1st:    #FFFFFF;
      --bc-4th:    #E4E4E4;
      --bc-hi:     #232323;
      --bc-accent: #FEF991;
      --sc-1st:    rgba(0,0,0,0.5);
      --sc-2nd:    rgba(35,35,35,0.08);
      --tc-1st:    #232323;
      --tc-2nd:    #7B7B7B;
      --tc-hi:     #FFFFFF;
      --tc-red:    #FF453A;
      --tc-red-text: #D63A2F;           /* TC-Red darkened to read as text on white */
      --tc-green:  #4BB956;
      --tc-green-text: #2E7D36;         /* the same for green status text */
      --tc-accent-2nd: #5E5A1F;         /* secondary text on the accent fill */
      --r: 6px;
      --r-in: 4px;
      --m: 12px;
      --shadow: 0 8px 24px rgba(35,35,35,0.14);
      --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Segoe UI', Roboto, system-ui, sans-serif;
      --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    }
    html, body { margin: 0; height: 100%; background: var(--bc-3rd); color: var(--tc-1st);
      font: 300 15px/1.45 var(--font); letter-spacing: -0.01em;
      -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    #app { display: flex; height: 100%; }
    button, input, select, textarea { font: inherit; color: inherit; letter-spacing: inherit; }
    button { cursor: pointer; }
    [hidden] { display: none !important; }
    .app { position: relative; width: 100%; max-width: 620px; margin: 0 auto; height: 100%; overflow: hidden; }
    .screen { position: absolute; inset: 0; display: flex; flex-direction: column; }
    .scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
      gap: 24px; padding: 4px var(--m) 24px; -webkit-overflow-scrolling: touch; }
    .log-scroll { gap: 12px; }
    .scroll > *, .sheet-body > *, .log > * { flex-shrink: 0; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: #CFCFCF; border-radius: 3px; }
    ::-webkit-scrollbar-track { background: transparent; }
    button:focus-visible, a:focus-visible, select:focus-visible, [role="button"]:focus-visible, summary:focus-visible {
      outline: 2px solid var(--tc-1st); outline-offset: 2px; }
    input:focus-visible, textarea:focus-visible { outline: none; }
    .ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Navigation bar: centred title, 44px targets either side ─────────── */
    .nav { flex: 0 0 auto; display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px;
      align-items: center; padding: 6px 4px; }
    .nav-title { margin: 0; text-align: center; font-size: 17px; font-weight: 400; letter-spacing: -0.17px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nav-side { width: 44px; height: 44px; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px;
      padding: 0; border: 0; border-radius: var(--r); background: transparent; color: var(--tc-1st); }
    .icon-btn:active { background: var(--bc-4th); }
    .icon-btn.small { flex: 0 0 auto; width: 36px; height: 36px; margin: -8px -10px -8px 0; color: var(--tc-2nd); }

    /* ── Cards, groups, grouped lists ────────────────────────────────────── */
    .card { padding: 12px 16px; background: var(--bc-1st); border-radius: var(--r); }
    .card-title { display: flex; align-items: center; gap: 8px; min-width: 0;
      font-size: 15px; font-weight: 400; color: var(--tc-1st); }
    .card-title.big { font-size: 17px; letter-spacing: -0.17px; }
    .card-sub { font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .group { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .group-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 4px; }
    .group-title { margin: 0; padding: 0 4px; font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .group-head .group-title { padding: 0; }
    .stack { display: flex; flex-direction: column; gap: 6px; }
    .pair { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 6px; }
    .hint { padding: 0 4px; font-size: 13px; font-weight: 400; color: var(--tc-2nd); line-height: 1.45; }
    .list-card { display: flex; flex-direction: column; background: var(--bc-1st); border-radius: var(--r); overflow: hidden; }
    .field-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px;
      padding: 0 16px; box-sizing: border-box; width: 100%; border: 0; background: transparent; text-align: left;
      color: var(--tc-1st); text-decoration: none; position: relative; font-size: 15px; font-weight: 300; }
    button.field-row:active, a.field-row:active, .select-row:active { background: var(--bc-2nd); }
    .field-row .field-name { flex: 0 1 auto; min-width: 0; padding: 12px 0; }
    .row-hint { margin-top: 2px; font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .row-value { display: inline-flex; align-items: center; gap: 10px; flex: 0 0 auto; color: var(--tc-2nd); font-size: 15px; }
    .row-input { flex: 1; min-width: 0; border: 0; background: none; outline: none; text-align: right;
      font-size: 15px; font-weight: 300; color: var(--tc-2nd); padding: 12px 0; }
    .row-input:focus { color: var(--tc-1st); }
    .row-input::placeholder { color: #ABABAB; }
    .select-row select { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
    .text-input { width: 100%; min-width: 0; box-sizing: border-box; height: 48px; padding: 0 16px; border: 0;
      border-radius: var(--r); background: var(--sc-2nd); font-size: 15px; font-weight: 300; outline: none; }
    .text-input::placeholder, .send-input::placeholder { color: var(--tc-2nd); }
    .input-row { display: flex; gap: 6px; }
    .input-row .btn { flex: 0 0 auto; }

    /* ── Status labels: the Figma's square dot ───────────────────────────── */
    .state { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
      font-size: 13px; font-weight: 400; color: var(--tc-1st); white-space: nowrap; }
    .state:empty { display: none; }
    .state::before { content: ''; width: 6px; height: 6px; background: currentColor; }
    .state.ok { color: var(--tc-green-text); }
    .state.ok::before { background: var(--tc-green); }
    .state.bad { color: var(--tc-red-text); }
    .state.wait, .state.idle { color: var(--tc-2nd); }
    .state.plain::before { display: none; }

    /* ── Sessions screen ─────────────────────────────────────────────────── */
    .conn { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .conn-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .session-list { display: flex; flex-direction: column; gap: 24px; }
    .empty { color: var(--tc-2nd); font-size: 15px; line-height: 1.45; }
    .session-card { display: flex; align-items: center; gap: 12px; padding: 16px; cursor: pointer; }
    .session-card:active, .session-card.selected { background: var(--bc-2nd); }
    .session-card.action { background: var(--bc-accent); }
    .session-card.action:active { background: #F4EE87; }
    .row-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .row-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .row-time { flex: 0 0 auto; font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .row-gist { font-size: 15px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .row-meta { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; font-weight: 400;
      color: var(--tc-2nd); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .row-meta > span:first-child { overflow: hidden; text-overflow: ellipsis; }
    .session-card.action .row-time, .session-card.action .row-meta { color: var(--tc-accent-2nd); }
    .row-chev { flex: 0 0 auto; display: inline-flex; color: var(--tc-2nd); }
    .session-card.action .row-chev { color: var(--tc-1st); }
    .idle-row { display: flex; align-items: center; gap: 12px; padding: 14px 16px; cursor: pointer; }
    .idle-row:active, .idle-row.selected { background: var(--bc-2nd); }
    .unread { flex: 0 0 auto; width: 8px; height: 8px; background: var(--bc-accent); box-shadow: inset 0 0 0 1px rgba(35,35,35,0.25); }
    .session-card.action .unread { background: var(--tc-1st); box-shadow: none; }
    .meter { flex: 0 0 auto; height: 4px; border-radius: 2px; background: var(--bc-4th); overflow: hidden; }
    .meter > span { display: block; height: 100%; background: var(--tc-1st); }
    .meter.small { width: 72px; }
    .meter.full { flex: 1; min-width: 0; }

    /* ── Release notices ─────────────────────────────────────────────────── */
    .notices { display: flex; flex-direction: column; gap: 6px; }
    .notice { display: flex; flex-direction: column; gap: 6px; }
    .notice.important { background: var(--bc-accent); }
    .notice-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .notice-title { font-size: 15px; font-weight: 400; }
    .notice-body { font-size: 13px; font-weight: 400; color: var(--tc-2nd); line-height: 1.45; }
    .notice.important .notice-body { color: var(--tc-1st); }
    .cmd-block { display: block; margin-top: 6px; font: 400 12px/1.5 var(--mono); letter-spacing: 0;
      color: var(--tc-1st); background: var(--sc-2nd); border-radius: var(--r-in); padding: 8px 10px;
      word-break: break-all; user-select: all; -webkit-user-select: all; }

    /* ── Segmented selector: #E4E4E4 track, white selected segment ───────── */
    .seg { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0; padding: 2px;
      border-radius: var(--r); background: var(--bc-4th); }
    .seg button { min-width: 0; height: 40px; padding: 0 4px; border: 0; border-radius: 5px; background: transparent;
      font-size: 13px; font-weight: 400; color: var(--tc-2nd); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .seg button.on { background: var(--bc-1st); color: var(--tc-1st); }
    .seg button.danger { color: var(--tc-red-text); }
    .stt-source button { font-size: 15px; }

    /* ── Toggle: dark track, square-ish white knob ───────────────────────── */
    .toggle { position: relative; flex: 0 0 auto; width: 44px; height: 26px; border-radius: var(--r); background: #C9C9C9; transition: background .15s; }
    .toggle input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .toggle .knob { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: var(--r-in);
      background: var(--bc-1st); pointer-events: none; transition: left .15s; }
    .toggle:has(input:checked) { background: var(--bc-hi); }
    .toggle:has(input:checked) .knob { left: 21px; }
    .toggle:has(input:focus-visible) { outline: 2px solid var(--tc-1st); outline-offset: 2px; }

    /* ── Session screen ──────────────────────────────────────────────────── */
    .status { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .status.action { background: var(--bc-accent); }
    .status.action .card-sub, .status.action .status-gist { color: var(--tc-accent-2nd); }
    .status-gist { margin-top: 4px; font-size: 13px; font-weight: 400; color: var(--tc-2nd);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .aside-card { display: flex; flex-direction: column; gap: 6px; }
    .aside-label { font-size: 11px; font-weight: 400; color: var(--tc-2nd); }
    .aside-q { font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .aside-a { white-space: pre-wrap; }
    .aside-a.pending { color: var(--tc-2nd); }
    .aside-a.err { color: var(--tc-red-text); }
    .older { align-self: center; }

    .log { display: flex; flex-direction: column; gap: 12px; }
    .ev { word-break: break-word; min-width: 0; }
    .ev-text { white-space: pre-wrap; }
    .ev-pair { display: flex; flex-direction: column; gap: 12px; }
    .ev-assistant { padding: 12px 16px; background: var(--bc-1st); border-radius: var(--r); }
    .ev-user { align-self: flex-end; max-width: 82%; padding: 12px 16px; background: var(--bc-2nd); border-radius: var(--r); }
    .ev-system, .ev-result, .ev-perm { padding: 0 4px; font-size: 13px; font-weight: 400; color: var(--tc-2nd);
      white-space: pre-line; font-variant-numeric: tabular-nums; }
    .ev-result.err { color: var(--tc-red-text); }
    .ev-perm { color: var(--tc-1st); }
    .subagent { margin-left: 16px; }
    .subagent.ev-assistant::before, .subagent.tools::before { content: 'Subagent'; display: block;
      font-size: 11px; font-weight: 400; color: var(--tc-2nd); }
    .subagent.tools::before { padding: 8px 14px 0; }
    .tools { display: flex; flex-direction: column; background: var(--bc-1st); border-radius: var(--r); overflow: hidden; }
    .tool-head { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 14px; list-style: none; cursor: pointer; }
    .tool-head::-webkit-details-marker { display: none; }
    div.tool-head { cursor: default; }
    details[open] > .tool-head, .tool-head:active { background: var(--bc-2nd); }
    .tool-name { flex: 0 0 auto; min-width: 40px; font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .tool-arg { flex: 1; min-width: 0; font: 400 12px/1.4 var(--mono); letter-spacing: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tool-input, .code-card { margin: 0; max-height: 240px; overflow: auto; padding: 12px 14px;
      font: 400 12px/1.5 var(--mono); letter-spacing: 0; color: var(--tc-1st); white-space: pre-wrap; word-break: break-word; }
    .tool-input { background: var(--bc-2nd); }
    .code-card { flex: 0 0 auto; background: var(--bc-1st); border-radius: var(--r); max-height: 30vh; font-size: 13px; }

    /* ── Composer (a white sheet pinned under the log) ───────────────────── */
    .composer { position: relative; flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px;
      padding: 10px var(--m) calc(12px + env(safe-area-inset-bottom, 0px)); background: var(--bc-1st);
      border-radius: var(--r) var(--r) 0 0; }
    .chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: 0 calc(-1 * var(--m)); padding: 0 var(--m); }
    .chips::-webkit-scrollbar { display: none; }
    .chip { flex: 0 0 auto; height: 32px; padding: 0 12px; border: 0; border-radius: var(--r);
      background: var(--bc-2nd); font-size: 13px; font-weight: 400; white-space: nowrap; }
    .chip:active { background: var(--bc-4th); }
    .composer-row { display: flex; align-items: flex-end; gap: 6px; }
    .send-input { flex: 1; min-width: 0; min-height: 48px; max-height: 132px; box-sizing: border-box; resize: none;
      padding: 13px 16px; border: 0; border-radius: var(--r); background: var(--sc-2nd);
      font-size: 15px; font-weight: 300; line-height: 1.45; outline: none; -webkit-appearance: none; }
    .square-btn { flex: 0 0 48px; height: 48px; display: inline-flex; align-items: center; justify-content: center;
      padding: 0; border: 0; border-radius: var(--r); background: var(--bc-2nd); color: var(--tc-1st); }
    .square-btn:active { background: var(--bc-4th); }
    .square-btn.primary, .square-btn.live { background: var(--bc-hi); color: var(--tc-hi); }
    .stop-square { width: 12px; height: 12px; border-radius: 2px; background: var(--tc-red); }
    .interim { padding: 0 4px; font-size: 13px; color: var(--tc-2nd); font-style: italic; }
    .composer-note { font-size: 11px; font-weight: 400; color: var(--tc-2nd); line-height: 1.5; }
    .composer-note a { color: var(--tc-1st); }
    .link-btn { padding: 0; border: 0; background: none; font-size: inherit; font-weight: 400; color: var(--tc-1st);
      text-decoration: underline; }
    .group-head .link-btn { font-size: 13px; color: var(--tc-2nd); text-decoration: none; }
    .cmd-menu { position: absolute; left: var(--m); right: var(--m); bottom: 100%; margin-bottom: 6px; z-index: 5;
      max-height: 232px; overflow-y: auto; display: flex; flex-direction: column;
      background: var(--bc-1st); border-radius: var(--r); box-shadow: var(--shadow); }
    .cmd-row { display: flex; align-items: baseline; gap: 12px; width: 100%; box-sizing: border-box;
      text-align: left; padding: 12px 16px; background: transparent; border: 0; }
    .cmd-row.active, .cmd-row:active { background: var(--bc-2nd); }
    .cmd-name { flex: 0 0 auto; font: 400 13px/1.2 var(--mono); }
    .cmd-hint { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 400; color: var(--tc-2nd);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }

    /* ── Pop-up sheets over the session (SC-1st overlay, #EEEEEE sheet) ──── */
    .overlay { position: absolute; inset: 0; z-index: 20; background: var(--sc-1st); }
    .sheet { position: absolute; left: 0; right: 0; bottom: 0; z-index: 21; max-height: 88%; display: flex;
      flex-direction: column; background: var(--bc-3rd); border-radius: var(--r) var(--r) 0 0; }
    .sheet-head { flex: 0 0 auto; display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; align-items: start;
      padding: 12px 4px 4px; }
    .sheet-titles { text-align: center; padding-top: 8px; min-width: 0; }
    .sheet-title { margin: 0; font-size: 17px; font-weight: 400; letter-spacing: -0.17px; overflow-wrap: anywhere; }
    .sheet-sub { font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .sheet-desc { margin-top: 2px; font-size: 15px; color: var(--tc-2nd); }
    .sheet-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 20px;
      padding: 12px var(--m) calc(16px + env(safe-area-inset-bottom, 0px)); }
    .prompt .sheet-body { gap: 12px; }
    .usage { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; }
    .usage-row { display: grid; grid-template-columns: 92px minmax(0, 1fr) 40px; align-items: center; gap: 10px;
      font-size: 13px; font-weight: 400; font-variant-numeric: tabular-nums; }
    .usage-pct { text-align: right; }
    .usage-note { font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .q-text { padding: 0 4px; font-size: 15px; font-weight: 400; line-height: 1.4; }
    .btn.option { flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px; min-height: 48px;
      padding: 12px 16px; text-align: left; line-height: 1.35; white-space: normal; }
    .option-desc { font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .btn.option.chosen { background: var(--bc-hi); color: var(--tc-hi); }
    .btn.option.chosen .option-desc { color: #BDBDBD; }

    /* ── Buttons: white, dark, red text on white; pressed = darker fill ──── */
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 12px; min-height: 48px;
      padding: 0 16px; box-sizing: border-box; border: 0; border-radius: var(--r); background: var(--bc-1st);
      color: var(--tc-1st); font-size: 15px; font-weight: 400; text-decoration: none; text-align: center;
      transition: background .15s, opacity .15s; }
    .btn:active { background: var(--bc-4th); }
    .btn:disabled { opacity: .4; cursor: default; }
    .btn.primary, .btn.dark { background: var(--bc-hi); color: var(--tc-hi); }
    .btn.primary:active, .btn.dark:active { background: #3A3A3A; }
    .btn.danger { color: var(--tc-red-text); }
    .btn.danger.armed { background: var(--tc-red); color: var(--tc-hi); }
    .btn.ghost { background: transparent; color: var(--tc-2nd); }
    .btn.ghost:active { background: var(--bc-4th); }
    .btn.small { flex: 0 0 auto; min-height: 32px; padding: 0 12px; font-size: 13px; }
    .arrow-btn { width: 100%; flex-wrap: wrap; row-gap: 0; padding-top: 8px; padding-bottom: 8px; }
    .btn-note { flex-basis: 100%; font: 400 12px/1.4 var(--mono); letter-spacing: 0; color: var(--tc-2nd);
      overflow-wrap: anywhere; }

    /* ── Toast: white, shadow, 3 s (the Figma's confirmation toast) ──────── */
    .toast { position: fixed; left: 50%; top: calc(56px + env(safe-area-inset-top, 0px)); transform: translateX(-50%);
      z-index: 40; width: max-content; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 12px 16px;
      font-size: 15px; font-weight: 400; line-height: 1.4; text-align: center; background: var(--bc-1st);
      border-radius: var(--r); box-shadow: var(--shadow); }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
