// Companion browser panel (the WebView shown in the Even app on the phone).
//
// The glasses are the primary control surface; this panel is the richer twin —
// the full active-session list, a session's full event log (assistant text,
// tool_use with its complete input, results with usage), plus every steering
// control the HUD offers AND the one it can't: a real free-text send box, since
// the phone has a keyboard. It is push-only — main.ts feeds it state via the
// flat setX() mirrors below; the panel never polls or talks to the bridge.
// Styled to the Even Realities *Companion App* design system (their published
// UIUX guidelines): a light system — #EEEEEE page, white cards, near-black
// (#232323) text, #7B7B7B secondary, a pale-yellow (#FEF991) accent for
// attention/ongoing actions, green (#4BB956) for connection status, red
// (#FF453A) for warnings; grotesque type on a 24/20/17/15/13/11 scale (Regular
// 400 titles, Light 300 body), 6px card radius, 12px margins. See injectStyles().
// No framework. (The glasses HUD in glasses.ts is a separate, firmware-native
// monochrome surface and is not governed by this doc.)

import type { ActiveSession, RcEvent, PermissionRequest, DialogQuestion, WhoAmI, Decision, PermissionMode, SlashCommand } from './rc/types'
import { EFFORTS, MODELS, MODES, QUICK_SENDS, SLASH_COMMANDS, APP_TITLE, BRIDGE_URL, BRIDGE_TOKEN, DEEPGRAM_API_KEY, loadRuntimeSettings, saveRuntimeSettings } from './config'
import { cleanUserEcho } from './events/format'

/** Everything the panel calls back into main.ts to do — main.ts owns the bridge. */
export interface PanelCallbacks {
  /** A session row was tapped → open its detail view. */
  onSelectSession: (sid: string) => void
  /** The Back button in the detail view → return to the list. */
  onBackToList: () => void
  /** The free-text send box (or a quick-action button) → send `text` verbatim. */
  onSend: (text: string) => void
  /** Interrupt the running turn. */
  onInterrupt: () => void
  /** Model <select> changed. */
  onSetModel: (model: string) => void
  /** Mode <select> changed. */
  onSetMode: (mode: PermissionMode) => void
  /** Effort <select> changed ('auto' | 'low' | 'medium' | 'high' | 'xhigh'). */
  onSetEffort: (effort: string) => void
  /** Archive the open session (main.ts confirms/executes; the button self-confirms too). */
  onArchive: (sid: string) => void
  /** Allow / Deny a blocking permission prompt. */
  onAnswerPermission: (decision: Decision) => void
  /** Pick option `label` for question `qIndex` of a blocking dialog. */
  onPickDialogOption: (qIndex: number, label: string) => void
  /** Dismiss / cancel a blocking question dialog. */
  onCancelDialog: () => void
  /** Start / stop voice dictation into the send box. */
  onStartVoice: () => void
  onStopVoice: () => void
  /** Connection settings were saved (or reset) → reconnect in place (no reload). */
  onApplySettings: () => void
  /** Leave the whole app. */
  onExit: () => void
}

/** How a worker-status string maps to a dot glyph + class. */
function statusDot(worker: string): { glyph: string; cls: string; label: string } {
  switch (worker) {
    case 'running':
      return { glyph: '●', cls: 'running', label: 'running' }
    case 'requires_action':
      return { glyph: '!', cls: 'action', label: 'needs you' }
    default:
      return { glyph: '○', cls: 'idle', label: 'idle' }
  }
}

/** Human "3m ago" from an ISO timestamp (or '' when absent/unparseable). */
function relTime(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (sec < 45) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

/** The model's display label, falling back to the raw id (or '—'). */
function modelLabel(id: string | null): string {
  if (!id) return '—'
  return MODELS.find((m) => m.id === id)?.label ?? id
}

/** Cost/turns suffix for a result row, e.g. ` · 5 turns · $0.12`, or ''. */
function usageSuffix(e: RcEvent): string {
  const u = e.usage
  if (!u) return ''
  const bits: string[] = []
  if (u.numTurns != null) bits.push(`${u.numTurns} turns`)
  if (u.durationMs != null) bits.push(`${(u.durationMs / 1000).toFixed(1)}s`)
  if (u.costUsd != null) bits.push(`$${u.costUsd}`)
  return bits.length ? ` · ${bits.join(' · ')}` : ''
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

export class Panel {
  // ── DOM refs, filled in by mount(); null until then. ──────────────────────
  private connChip: HTMLDivElement | null = null
  private originEl: HTMLDivElement | null = null
  private listView: HTMLElement | null = null
  private listEl: HTMLDivElement | null = null
  private detailView: HTMLElement | null = null
  private detailTitle: HTMLDivElement | null = null
  private detailMeta: HTMLDivElement | null = null
  private permBanner: HTMLDivElement | null = null
  private logEl: HTMLDivElement | null = null
  private sendInput: HTMLTextAreaElement | null = null
  private sendBtn: HTMLButtonElement | null = null
  private dictateBtn: HTMLButtonElement | null = null
  private interimEl: HTMLDivElement | null = null
  private interruptBtn: HTMLButtonElement | null = null
  private modelSel: HTMLSelectElement | null = null
  private modeSel: HTMLSelectElement | null = null
  private effortSel: HTMLSelectElement | null = null
  private archiveBtn: HTMLButtonElement | null = null
  private toastEl: HTMLDivElement | null = null
  private cmdMenuEl: HTMLDivElement | null = null

  private mounted = false
  private dictating = false
  /** The currently-open session id (for onArchive), or null in the list view. */
  private currentSid: string | null = null
  private toastTimer: number | null = null
  /** sequenceNums already rendered in the log — dedupes the history↔stream seam. */
  private seen = new Set<number>()
  // The `/`-autocomplete popover over the send box: the commands matching what's
  // been typed after the leading slash, and the keyboard-highlighted row.
  private cmdMatches: SlashCommand[] = []
  private cmdIndex = 0

  constructor(private readonly cb: PanelCallbacks) {}

  /** Build the DOM into `root`. Idempotent — injects styles + wires events once. */
  mount(root: HTMLElement): void {
    if (this.mounted) return
    this.mounted = true

    const quickHtml = QUICK_SENDS.map(
      (q, i) => `<button class="btn quick" data-quick="${i}">${escapeHtml(q.label)}</button>`,
    ).join('')
    const modelOpts = MODELS.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('')
    const modeOpts = MODES.map((m) => `<option value="${m}">${m}</option>`).join('')
    const effortOpts = EFFORTS.map((e) => `<option value="${e.id ?? 'auto'}">${e.label}</option>`).join('')

    // Settings prefill: the inputs hold the on-device overrides; the
    // placeholders show what the build falls back to without them.
    const rt = loadRuntimeSettings()
    const settingsHtml = `
        <section id="settingsCard" class="settings" hidden>
          <div class="view-title">Connection settings</div>
          <div class="settings-conn">
            <span class="field-label">Connected to</span>
            <span id="origin" class="origin">—</span>
          </div>
          <label class="field">
            <span class="field-label">Bridge URL</span>
            <input id="setBridgeUrl" class="set-input" type="url" autocapitalize="off" autocorrect="off"
              spellcheck="false" placeholder="${escapeHtml(BRIDGE_URL)}" value="${escapeHtml(rt.bridgeUrl ?? '')}" />
          </label>
          <label class="field">
            <span class="field-label">Bridge token</span>
            <input id="setBridgeToken" class="set-input" type="password" autocapitalize="off"
              placeholder="${BRIDGE_TOKEN ? '(using built-in token)' : '(none set)'}" value="${escapeHtml(rt.bridgeToken ?? '')}" />
          </label>
          <label class="field">
            <span class="field-label">Deepgram API key (optional, for voice)</span>
            <input id="setDeepgramKey" class="set-input" type="password" autocapitalize="off"
              placeholder="${DEEPGRAM_API_KEY ? '(using built-in key)' : '(voice disabled)'}" value="${escapeHtml(rt.deepgramApiKey ?? '')}" />
          </label>
          <div class="settings-hint">Stored only on this device. Overrides the values baked into the build; leave a field blank to use the built-in one.</div>
          <div class="perm-acts">
            <button id="settingsSave" class="btn primary">Save &amp; connect</button>
            <button id="settingsReset" class="btn">Reset</button>
          </div>
        </section>`

    root.innerHTML = `
      <main class="panel">
        <header class="topbar">
          <h1 class="wordmark">${escapeHtml(APP_TITLE)}</h1>
          <div class="head-side">
            <div id="connChip" class="chip-conn down">down</div>
            <button id="settingsBtn" class="btn ghost settings-btn" title="Connection settings" aria-label="Connection settings">Settings</button>
          </div>
        </header>
${settingsHtml}
        <section id="listView" class="view">
          <div class="view-head">
            <span class="view-title">Active sessions</span>
            <button id="exitBtn" class="btn ghost">Exit</button>
          </div>
          <div id="sessionList" class="session-list"></div>
        </section>

        <section id="detailView" class="view" hidden>
          <div class="detail-head">
            <button id="backBtn" class="btn ghost">‹ Back</button>
            <div class="detail-headings">
              <div id="detailTitle" class="detail-title"></div>
              <div id="detailMeta" class="detail-meta"></div>
            </div>
          </div>

          <div id="permBanner" class="perm" hidden></div>

          <div id="log" class="log"></div>

          <div class="composer">
            <div id="cmdMenu" class="cmd-menu" hidden></div>
            <textarea id="sendInput" class="send-input" rows="2"
              placeholder="Message the session… (/ for commands)" enterkeyhint="send"></textarea>
            <div id="interim" class="interim"></div>
            <div class="composer-row">
              <button id="sendBtn" class="btn primary">Send</button>
              <button id="dictateBtn" class="btn">Dictate</button>
              <button id="interruptBtn" class="btn danger">Interrupt</button>
            </div>
            <div class="quick-row">${quickHtml}</div>
          </div>

          <div class="steer">
            <label class="field">
              <span class="field-label">Model</span>
              <select id="modelSel" class="select">${modelOpts}</select>
            </label>
            <label class="field">
              <span class="field-label">Mode</span>
              <select id="modeSel" class="select">${modeOpts}</select>
            </label>
            <label class="field">
              <span class="field-label">Effort</span>
              <select id="effortSel" class="select">${effortOpts}</select>
            </label>
            <button id="archiveBtn" class="btn danger archive">Archive</button>
          </div>
        </section>

        <div id="toast" class="toast" hidden></div>
      </main>
    `

    // Cache refs.
    this.connChip = root.querySelector<HTMLDivElement>('#connChip')
    this.originEl = root.querySelector<HTMLDivElement>('#origin')
    this.listView = root.querySelector<HTMLElement>('#listView')
    this.listEl = root.querySelector<HTMLDivElement>('#sessionList')
    this.detailView = root.querySelector<HTMLElement>('#detailView')
    this.detailTitle = root.querySelector<HTMLDivElement>('#detailTitle')
    this.detailMeta = root.querySelector<HTMLDivElement>('#detailMeta')
    this.permBanner = root.querySelector<HTMLDivElement>('#permBanner')
    this.logEl = root.querySelector<HTMLDivElement>('#log')
    this.sendInput = root.querySelector<HTMLTextAreaElement>('#sendInput')
    this.sendBtn = root.querySelector<HTMLButtonElement>('#sendBtn')
    this.dictateBtn = root.querySelector<HTMLButtonElement>('#dictateBtn')
    this.interimEl = root.querySelector<HTMLDivElement>('#interim')
    this.interruptBtn = root.querySelector<HTMLButtonElement>('#interruptBtn')
    this.modelSel = root.querySelector<HTMLSelectElement>('#modelSel')
    this.modeSel = root.querySelector<HTMLSelectElement>('#modeSel')
    this.effortSel = root.querySelector<HTMLSelectElement>('#effortSel')
    this.archiveBtn = root.querySelector<HTMLButtonElement>('#archiveBtn')
    this.toastEl = root.querySelector<HTMLDivElement>('#toast')
    this.cmdMenuEl = root.querySelector<HTMLDivElement>('#cmdMenu')

    // Wire events.
    root.querySelector<HTMLButtonElement>('#exitBtn')?.addEventListener('click', () => this.cb.onExit())
    root.querySelector<HTMLButtonElement>('#backBtn')?.addEventListener('click', () => this.cb.onBackToList())
    this.wireSettings(root)

    this.sendBtn?.addEventListener('click', () => this.doSend())
    // Typing after a leading `/` drives the command autocomplete.
    this.sendInput?.addEventListener('input', () => this.updateCommandMenu())
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

    this.modelSel?.addEventListener('change', () => {
      if (this.modelSel) this.cb.onSetModel(this.modelSel.value)
    })
    this.modeSel?.addEventListener('change', () => {
      if (this.modeSel) this.cb.onSetMode(this.modeSel.value as PermissionMode)
    })
    this.effortSel?.addEventListener('change', () => {
      if (this.effortSel) this.cb.onSetEffort(this.effortSel.value)
    })

    for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>('.quick'))) {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.quick)
        const q = QUICK_SENDS[i]
        if (q) this.cb.onSend(q.text)
      })
    }

    this.wireArchive()

    injectStyles()
  }

  /** Connection settings: saved to localStorage, then applied in place via
   *  `onApplySettings` — main.ts reconnects with the new values WITHOUT a page
   *  reload (a reload drops the Even glasses bridge and freezes the HUD). Settings
   *  never leave the device — the panel is where you input your bridge/Deepgram
   *  secrets. */
  private wireSettings(root: HTMLElement): void {
    const card = root.querySelector<HTMLElement>('#settingsCard')
    const url = root.querySelector<HTMLInputElement>('#setBridgeUrl')
    const token = root.querySelector<HTMLInputElement>('#setBridgeToken')
    const dg = root.querySelector<HTMLInputElement>('#setDeepgramKey')
    root.querySelector<HTMLButtonElement>('#settingsBtn')?.addEventListener('click', () => {
      if (card) card.hidden = !card.hidden
    })
    root.querySelector<HTMLButtonElement>('#settingsSave')?.addEventListener('click', () => {
      saveRuntimeSettings({
        bridgeUrl: url?.value ?? '',
        bridgeToken: token?.value ?? '',
        deepgramApiKey: dg?.value ?? '',
      })
      if (card) card.hidden = true
      this.cb.onApplySettings()
    })
    root.querySelector<HTMLButtonElement>('#settingsReset')?.addEventListener('click', () => {
      saveRuntimeSettings({})
      if (url) url.value = ''
      if (token) token.value = ''
      if (dg) dg.value = ''
      this.cb.onApplySettings()
    })
  }

  /** Two-click Archive confirm (mirrors the template's delete-confirm arming). */
  private wireArchive(): void {
    const btn = this.archiveBtn
    if (!btn) return
    let armed = false
    let timer: number | null = null
    btn.addEventListener('click', () => {
      if (!armed) {
        armed = true
        btn.textContent = 'Archive?'
        btn.classList.add('armed')
        timer = window.setTimeout(() => {
          armed = false
          btn.textContent = 'Archive'
          btn.classList.remove('armed')
        }, 3000)
        return
      }
      if (timer !== null) clearTimeout(timer)
      armed = false
      btn.textContent = 'Archive'
      btn.classList.remove('armed')
      if (this.currentSid) this.cb.onArchive(this.currentSid)
    })
  }

  /** Read + clear the send box, firing onSend when non-empty. */
  private doSend(): void {
    const text = this.sendInput?.value.trim() ?? ''
    if (!text) return
    this.hideCommandMenu()
    this.cb.onSend(text)
    if (this.sendInput) {
      this.sendInput.value = ''
      this.sendInput.blur() // dismiss the mobile keyboard
    }
  }

  // ── Slash-command autocomplete ─────────────────────────────────────────────
  // Typing `/` in the send box pops a filtered command menu above it, mirroring
  // Claude Code's own `/` menu. A command is sent as a plain `/name` message
  // (main.ts → the bridge's /send route); the worker runs it locally. Commands
  // that take an argument or are heavy/destructive (`confirm`) fill the box and
  // wait for an explicit Send instead of firing on pick — the panel never routes
  // through the glasses' confirm screen, so "don't fire on one tap" is honored by
  // filling-and-waiting here.

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
      const hint = c.hint ?? c.label
      if (hint) {
        const h = document.createElement('span')
        h.className = 'cmd-hint'
        h.textContent = hint
        row.appendChild(h)
      }
      // The menu isn't blur-hidden, so it survives the textarea losing focus on
      // tap and a plain click lands on the row (portable across touch). chooseCmd
      // re-focuses the box itself on the fill path.
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

  /** Pick command `i`: fire it (plain), or fill the box and wait for Send (takes an
   *  argument, or is `confirm`-gated). */
  private chooseCmd(i: number): void {
    const cmd = this.cmdMatches[i]
    if (!cmd || !this.sendInput) return
    this.hideCommandMenu()
    if (cmd.takesArg || cmd.confirm) {
      this.sendInput.value = cmd.takesArg ? `/${cmd.name} ` : `/${cmd.name}`
      this.sendInput.focus()
      // Keep the caret at the end so a typed argument appends cleanly.
      const end = this.sendInput.value.length
      this.sendInput.setSelectionRange(end, end)
      return
    }
    this.cb.onSend(`/${cmd.name}`)
    this.sendInput.value = ''
    this.sendInput.blur()
  }

  private hideCommandMenu(): void {
    this.cmdIndex = 0
    this.cmdMatches = []
    if (this.cmdMenuEl) {
      this.cmdMenuEl.hidden = true
      this.cmdMenuEl.textContent = ''
    }
  }

  // ── Header / connection ─────────────────────────────────────────────────
  setConnection(info: { bridge: 'ok' | 'down' | 'connecting'; whoami?: WhoAmI; origin: string; state: string }): void {
    if (this.connChip) {
      this.connChip.className = `chip-conn ${info.bridge}`
      const login = info.whoami && !info.whoami.logged_in ? ' · logged out' : ''
      this.connChip.textContent = info.bridge === 'ok' ? `ok${login}` : info.bridge
      this.connChip.title = `${info.origin} · ${info.state}`
    }
    if (this.originEl) this.originEl.textContent = info.origin
  }

  // ── Sessions list ────────────────────────────────────────────────────────
  setSessions(sessions: ActiveSession[], selectedId: string | null): void {
    const list = this.listEl
    if (!list) return
    list.textContent = ''
    if (sessions.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'list-empty'
      empty.textContent = 'No active sessions.'
      list.appendChild(empty)
      return
    }
    for (const s of sessions) list.appendChild(this.sessionRow(s, s.id === selectedId))
  }

  private sessionRow(s: ActiveSession, selected: boolean): HTMLDivElement {
    const row = document.createElement('div')
    // `needs` washes the row in the accent (BC-Accent) — the doc's "ongoing
    // action / requires a warning" treatment — when the session is blocked on you.
    const needs = s.workerStatus === 'requires_action' ? ' needs' : ''
    row.className = `session-row${selected ? ' selected' : ''}${needs}`
    row.setAttribute('role', 'button')
    row.tabIndex = 0

    const dot = statusDot(s.workerStatus)
    const dotEl = document.createElement('span')
    dotEl.className = `wdot ${dot.cls}`
    dotEl.textContent = dot.glyph
    dotEl.title = dot.label

    const body = document.createElement('div')
    body.className = 'session-body'

    const name = document.createElement('div')
    name.className = 'session-name'
    name.textContent = s.title || 'Untitled session'
    if (s.unread) {
      const u = document.createElement('span')
      u.className = 'unread'
      u.title = 'Unread'
      name.appendChild(u)
    }

    const sub = document.createElement('div')
    sub.className = 'session-sub'
    const bits = [modelLabel(s.model), s.permissionMode ?? 'default']
    const when = relTime(s.lastEventAt)
    if (when) bits.push(when)
    sub.textContent = bits.join(' · ')

    body.appendChild(name)
    body.appendChild(sub)
    row.appendChild(dotEl)
    row.appendChild(body)

    // Chevron drill-in affordance (the doc's Guide-System "drill-in" glyph). The
    // panel is a full-Unicode WebView, so rich glyphs are fine here.
    const chev = document.createElement('span')
    chev.className = 'row-chev'
    chev.setAttribute('aria-hidden', 'true')
    chev.textContent = '›'
    row.appendChild(chev)

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

  // ── Detail view (reveal / header / control-enable) ────────────────────────
  setActiveSession(session: ActiveSession | null): void {
    this.currentSid = session?.id ?? null
    this.hideCommandMenu() // never carry a stale popover across an open/close
    const showDetail = session !== null
    if (this.listView) this.listView.hidden = showDetail
    if (this.detailView) this.detailView.hidden = !showDetail
    if (!session) return

    if (this.detailTitle) this.detailTitle.textContent = session.title || 'Untitled session'
    if (this.detailMeta) {
      const dot = statusDot(session.workerStatus)
      this.detailMeta.textContent = ''
      const d = document.createElement('span')
      d.className = `wdot ${dot.cls}`
      d.textContent = `${dot.glyph} ${dot.label}`
      this.detailMeta.appendChild(d)
      const rest = document.createElement('span')
      rest.textContent = ` · ${modelLabel(session.model)} · ${session.permissionMode ?? 'default'}`
      this.detailMeta.appendChild(rest)
    }

    // Reflect the session's current model/mode in the selects.
    if (this.modelSel && session.model) this.modelSel.value = session.model
    if (this.modeSel && session.permissionMode) this.modeSel.value = session.permissionMode

    // Interrupt only makes sense while the worker is running.
    if (this.interruptBtn) this.interruptBtn.disabled = session.workerStatus !== 'running'
  }

  // ── Event log ─────────────────────────────────────────────────────────────
  setEvents(events: RcEvent[]): void {
    if (!this.logEl) return
    this.logEl.textContent = ''
    this.seen = new Set()
    for (const e of events) {
      if (e.sequenceNum != null) this.seen.add(e.sequenceNum)
      const node = renderEventNode(e)
      if (node) this.logEl.appendChild(node)
    }
    this.autoScroll()
  }

  appendEvent(e: RcEvent): void {
    if (!this.logEl) return
    // The stream resumes at the last history seq, so the seam overlaps — dedupe
    // exactly like the HUD's EventLog so the panel doesn't double-render.
    if (e.sequenceNum != null) {
      if (this.seen.has(e.sequenceNum)) return
      this.seen.add(e.sequenceNum)
    }
    const node = renderEventNode(e)
    if (!node) return
    this.logEl.appendChild(node)
    this.autoScroll()
  }

  /** Follow the newest event unless the reader scrolled up into history. */
  private autoScroll(): void {
    const el = this.logEl
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }

  // ── Voice dictation ──────────────────────────────────────────────────────
  /** Reflect dictation active/idle on the Dictate button. Driven by main.ts's
   *  voice lifecycle (not by interim-text presence, which lags the mic opening). */
  setDictating(active: boolean): void {
    this.dictating = active
    if (this.dictateBtn) {
      this.dictateBtn.classList.toggle('active', active)
      this.dictateBtn.textContent = active ? 'Stop' : 'Dictate'
    }
    if (!active && this.interimEl) {
      this.interimEl.textContent = ''
      this.interimEl.hidden = true
    }
  }

  setInterim(text: string): void {
    if (this.interimEl) {
      this.interimEl.textContent = text
      this.interimEl.hidden = text.length === 0
    }
  }

  // ── Permission banner ────────────────────────────────────────────────────
  setPermission(p: PermissionRequest | null): void {
    const banner = this.permBanner
    if (!banner) return
    if (!p) {
      banner.hidden = true
      banner.textContent = ''
      return
    }
    banner.hidden = false
    banner.textContent = ''

    const head = document.createElement('div')
    head.className = 'perm-head'
    head.textContent = `NEEDS YOU · ${p.toolName ?? 'tool'}`
    banner.appendChild(head)

    const input = formatInput(p.input)
    if (input) {
      const pre = document.createElement('pre')
      pre.className = 'perm-input'
      pre.textContent = input
      banner.appendChild(pre)
    }

    const acts = document.createElement('div')
    acts.className = 'perm-acts'
    const allow = document.createElement('button')
    allow.className = 'btn primary'
    allow.textContent = 'Allow'
    allow.addEventListener('click', () => this.cb.onAnswerPermission('allow'))
    const deny = document.createElement('button')
    deny.className = 'btn danger'
    deny.textContent = 'Deny'
    deny.addEventListener('click', () => this.cb.onAnswerPermission('deny'))
    acts.appendChild(allow)
    acts.appendChild(deny)
    banner.appendChild(acts)
  }

  // ── Question dialog (request_user_dialog / side_question) ──────────────────
  /** Render a blocking QUESTION with its options as buttons (or hide when null).
   *  Shares the permission banner — only one blocking prompt is ever pending. A
   *  picked option shows selected; clicking one answers that question. */
  setDialog(questions: DialogQuestion[] | null, picks: string[][]): void {
    const banner = this.permBanner
    if (!banner) return
    if (!questions || questions.length === 0) {
      banner.hidden = true
      banner.textContent = ''
      return
    }
    banner.hidden = false
    banner.textContent = ''

    const head = document.createElement('div')
    head.className = 'perm-head'
    head.textContent = `NEEDS YOU · QUESTION${questions.length > 1 ? ` (${questions.length})` : ''}`
    banner.appendChild(head)

    questions.forEach((q, qi) => {
      const block = document.createElement('div')
      block.className = 'q-block'

      const qt = document.createElement('div')
      qt.className = 'q-text'
      qt.textContent = q.question || q.header || 'Question'
      block.appendChild(qt)

      const opts = document.createElement('div')
      opts.className = 'q-opts'
      const options = q.options.length ? q.options : [{ label: 'Proceed', description: '' }]
      for (const o of options) {
        const chosen = (picks[qi] ?? []).includes(o.label)
        const b = document.createElement('button')
        b.className = `btn q-opt${chosen ? ' chosen' : ''}`
        b.textContent = o.description ? `${o.label} — ${o.description}` : o.label
        b.addEventListener('click', () => this.cb.onPickDialogOption(qi, o.label))
        opts.appendChild(b)
      }
      block.appendChild(opts)
      banner.appendChild(block)
    })

    const acts = document.createElement('div')
    acts.className = 'perm-acts'
    const cancel = document.createElement('button')
    cancel.className = 'btn'
    cancel.textContent = 'Dismiss'
    cancel.addEventListener('click', () => this.cb.onCancelDialog())
    acts.appendChild(cancel)
    banner.appendChild(acts)
  }

  // ── Transient toast ──────────────────────────────────────────────────────
  setToast(msg: string): void {
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
    }, 2600)
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

/**
 * One RcEvent → a rich log node (or null to drop it: partial stream deltas,
 * control responses, bare tool_result echoes). Unlike the HUD's renderEvent,
 * this shows the FULL tool input and full usage line — the phone has room.
 */
function renderEventNode(e: RcEvent): HTMLDivElement | null {
  switch (e.type) {
    case 'assistant': {
      const row = document.createElement('div')
      row.className = 'ev ev-assistant'
      const text = e.text.trim()
      if (text) {
        const body = document.createElement('div')
        body.className = 'ev-text'
        body.textContent = text
        row.appendChild(body)
      }
      for (const t of e.toolUses) row.appendChild(toolBlock(t))
      // Nothing to show (empty assistant frame) → drop it.
      return row.childNodes.length ? row : null
    }

    case 'user': {
      // Clean local-command echoes the same way the HUD does: strip the
      // model-directed caveat block and unwrap `<command-name>` / stdout tags, so
      // a fired slash command reads as `/context`, not raw XML tag soup.
      const text = cleanUserEcho(e.text).trim()
      if (!text) return null // bare tool_result echo / caveat-only — noise
      // Your message → a right-aligned dark bubble (the doc's BC-Highlight
      // treatment); the assistant's replies stay as plain flowing text.
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
      row.textContent = `${ok ? '✓ done' : `✗ ${e.subtype ?? 'error'}`}${usageSuffix(e)}`
      return row
    }

    case 'system': {
      let label = ''
      if (e.subtype === 'init') label = `◆ session started (${e.model ?? 'unknown'})`
      else if (e.subtype === 'compact_boundary') label = '◆ context compacted'
      if (!label) return null
      const row = document.createElement('div')
      row.className = 'ev ev-system'
      row.textContent = label
      return row
    }

    case 'control_request': {
      if (!e.isBlockingControl) return null
      const row = document.createElement('div')
      row.className = 'ev ev-perm'
      const p = e.permissionRequest
      const sub = p?.subtype ?? e.blockingSubtype ?? ''
      const isQuestion = sub === 'request_user_dialog' || sub === 'side_question' || (p?.questions?.length ?? 0) > 0 || p?.toolName === 'AskUserQuestion'
      if (isQuestion) {
        const gist = p?.questions?.[0]?.question || p?.questions?.[0]?.header || p?.prompt || 'a question'
        row.textContent = `⚠ asks: ${gist}`
      } else {
        row.textContent = `⚠ needs you: ${p?.toolName ?? 'tool'}`
      }
      return row
    }

    default:
      // stream_event, control_response, and anything else is noise.
      return null
  }
}

/** A `⚙ Name` header + the tool's full input as a <pre> block. */
function toolBlock(t: RcEvent['toolUses'][number]): HTMLDivElement {
  const wrap = document.createElement('div')
  wrap.className = 'ev-tool'
  const head = document.createElement('div')
  head.className = 'ev-tool-head'
  head.textContent = `⚙ ${t.name ?? 'tool'}`
  wrap.appendChild(head)
  const input = formatInput(t.input)
  if (input) {
    const pre = document.createElement('pre')
    pre.className = 'ev-tool-input'
    pre.textContent = input
    wrap.appendChild(pre)
  }
  return wrap
}

// ─── styles ──────────────────────────────────────────────────────────────────

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  // Even Realities Companion-App LIGHT system, per their UIUX guidelines:
  //   BC-3rd #EEEEEE page · BC-1st #FFFFFF cards · BC-2nd #F6F6F6 supporting ·
  //   BC-4th #E4E4E4 pressed fills · TC-1st #232323 text · TC-2nd #7B7B7B
  //   secondary · BC-Accent #FEF991 (the "ongoing action / warning" fill) ·
  //   TC-Green #4BB956 connection · TC-Red #FF453A warnings — as a TEXT color:
  //   the doc's red button is red text on a standard fill, never a red border ·
  //   SC-2nd 8% #232323 input fill · SC-1st 50% black overlay.
  //   Hierarchy is FILL CONTRAST, never hairline borders — every component in
  //   the doc (buttons, cards, list rows, headers, dropdowns, modals, toasts)
  //   is a flat fill; only floating surfaces (toast, popover) carry a shadow.
  //   Type is strictly the 24/20/17/15/13/11 scale, weights 400 (Regular,
  //   titles + 13px-and-down) and 300 (Light, 15px+ body), ~-0.01em tracking;
  //   the mono code blocks sit at 12px, outside the doc's system (it has none).
  //   Spacing rides the doc's quantum — 6px same-element, 12px same-subject,
  //   24px cross-subject — with 16px card padding and 12px page margins.
  //   Radius 6px (4px nested). The proprietary FK Grotesk isn't shippable, so
  //   the system grotesque stack stands in. Disabled = opacity, per the doc.
  const css = `
    :root {
      color-scheme: light;
      /* Background colors (BC) */
      --bc-3rd:    #EEEEEE;               /* page — main background */
      --bc-2nd:    #F6F6F6;               /* supporting surface on white */
      --bc-1st:    #FFFFFF;               /* cards, rows, standard buttons */
      --bc-4th:    #E4E4E4;               /* deeper layer — pressed fills */
      --bc-hi:     #232323;               /* BC-Highlight — primary button fill */
      --bc-accent: #FEF991;               /* ongoing action / warning fill */
      --sc-1st:    rgba(35,35,35,0.5);    /* modal overlay */
      --sc-2nd:    rgba(35,35,35,0.08);   /* text-input fill (8% #232323) */
      /* Text colors (TC) */
      --tc-1st:    #232323;               /* primary body + titles */
      --tc-2nd:    #7B7B7B;               /* secondary */
      --tc-hi:     #FFFFFF;               /* text on dark fills (TC-Highlight) */
      --tc-red:    #FF453A;               /* warnings / deny / errors */
      --tc-green:  #4BB956;               /* connection status / success */
      --r: 6px;      /* default card radius */
      --r-in: 4px;   /* offset (inset) radius */
      --m: 12px;     /* default screen margin */
      --shadow: 0 8px 24px rgba(35,35,35,0.14);   /* floating: toast, popover */
      --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Segoe UI', Roboto, system-ui, sans-serif;
      --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    }
    html, body { margin: 0; height: 100%; background: var(--bc-3rd); color: var(--tc-1st);
      font: 300 15px/1.5 var(--font); letter-spacing: -0.01em;
      -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    #app { display: flex; height: 100%; }
    .panel { display: flex; flex-direction: column; gap: 24px; width: 100%; overflow-y: auto;
      max-width: 620px; margin: 0 auto; padding: 12px var(--m) 24px; box-sizing: border-box; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-thumb { background: #CFCFCF; border-radius: 999px; }
    ::-webkit-scrollbar-track { background: transparent; }
    /* One keyboard-focus treatment for everything interactive; taps show none. */
    .btn:focus-visible, .select:focus-visible, .set-input:focus-visible,
    .send-input:focus-visible, .session-row:focus-visible, .cmd-row:focus-visible {
      outline: 2px solid var(--tc-1st); outline-offset: 2px; }

    /* ── Top bar ─────────────────────────────────────────────────────────── */
    /* A slim, single-line app bar: wordmark left, connection + settings right.
       The wordmark never wraps; the bridge origin lives in the Settings card
       (not the bar), so a long hostname can never squeeze the title onto two
       lines the way it used to. */
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; }
    .wordmark { font-size: 17px; font-weight: 400; margin: 0; color: var(--tc-1st);
      white-space: nowrap; flex: 0 0 auto; }
    .head-side { display: flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; }
    .settings-btn { flex: 0 0 auto; }
    .chip-conn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 400;
      padding: 5px 12px; border-radius: 999px; white-space: nowrap; text-transform: lowercase; flex: 0 0 auto;
      background: var(--bc-1st); }
    .chip-conn::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .chip-conn.ok { color: var(--tc-green); background: rgba(75,185,86,0.12); }
    .chip-conn.down { color: var(--tc-red); background: rgba(255,69,58,0.10); }
    .chip-conn.connecting { color: var(--tc-2nd); background: var(--bc-2nd); }

    /* ── Connection settings card ────────────────────────────────────────── */
    .settings { display: flex; flex-direction: column; gap: 12px; padding: 16px;
      background: var(--bc-1st); border-radius: var(--r); }
    .settings[hidden] { display: none; }
    /* Standard buttons inside the white card ride BC-2nd (the doc's supporting
       color on top of BC-1st) so they don't vanish white-on-white. */
    .settings .btn:not(.primary) { background: var(--bc-2nd); }
    .settings .btn:not(.primary):active { background: var(--bc-4th); }
    .set-input { width: 100%; box-sizing: border-box; padding: 12px;
      font: 400 15px/1.3 var(--font); letter-spacing: -0.01em; color: var(--tc-1st);
      background: var(--sc-2nd); border: 0; border-radius: var(--r);
      outline: none; -webkit-appearance: none; }
    .set-input::placeholder { color: var(--tc-2nd); }
    .settings-hint { font-size: 13px; font-weight: 400; color: var(--tc-2nd); line-height: 1.45; }
    /* The bridge origin, relocated here from the top bar. */
    .settings-conn { display: flex; flex-direction: column; gap: 3px; }
    .origin { font-size: 13px; color: var(--tc-2nd); font-variant-numeric: tabular-nums; word-break: break-all; }

    /* ── View scaffolding ────────────────────────────────────────────────── */
    .view { display: flex; flex-direction: column; gap: 12px; }
    .view[hidden] { display: none; }
    .view-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .view-title { font-size: 13px; font-weight: 400; color: var(--tc-2nd); letter-spacing: -0.01em; }

    /* ── Session list ────────────────────────────────────────────────────── */
    .session-list { display: flex; flex-direction: column; gap: 6px; }
    .list-empty { color: var(--tc-2nd); font-size: 15px; padding: 12px 2px; }
    .session-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px;
      background: var(--bc-1st); border-radius: var(--r); cursor: pointer;
      transition: background 0.15s; }
    .session-row:active { background: var(--bc-2nd); }
    .session-row.selected { background: var(--bc-2nd); }
    /* Blocked-on-you → the accent (BC-Accent) wash: the doc's warning treatment. */
    .session-row.needs { background: var(--bc-accent); }
    .session-row.needs:active { background: #F7EF7E; }
    .wdot { flex: 0 0 auto; font-size: 13px; line-height: 1; }
    .wdot.running { color: var(--tc-green); }
    .wdot.idle { color: var(--tc-2nd); }
    .wdot.action { color: var(--tc-1st); }
    .session-body { flex: 1; min-width: 0; }
    .session-name { font-size: 15px; font-weight: 400; color: var(--tc-1st);
      display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .unread { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--tc-1st); }
    .session-sub { font-size: 13px; font-weight: 400; color: var(--tc-2nd); font-variant-numeric: tabular-nums;
      margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row-chev { flex: 0 0 auto; color: var(--tc-2nd); font-size: 17px; line-height: 1; margin-left: 2px; }

    /* ── Detail header ───────────────────────────────────────────────────── */
    .detail-head { display: flex; align-items: flex-start; gap: 12px; }
    .detail-headings { min-width: 0; flex: 1; }
    .detail-title { font-size: 17px; font-weight: 400; color: var(--tc-1st);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .detail-meta { font-size: 13px; font-weight: 400; color: var(--tc-2nd); margin-top: 2px; font-variant-numeric: tabular-nums; }
    .detail-meta .wdot { font-size: 12px; margin-right: 0; }

    /* ── Permission / question banner (BC-Accent = the doc's warning fill) ─── */
    .perm { display: flex; flex-direction: column; gap: 12px; padding: 16px;
      background: var(--bc-accent); border-radius: var(--r); }
    .perm[hidden] { display: none; }
    .perm-head { font-size: 13px; font-weight: 400; color: var(--tc-1st); }
    .perm-input { margin: 0; max-height: 180px; overflow: auto; padding: 12px; font: 400 12px/1.5 var(--mono);
      color: var(--tc-1st); background: var(--bc-1st); border-radius: var(--r-in);
      white-space: pre-wrap; word-break: break-word; }
    .perm-acts { display: flex; gap: 6px; }
    .perm-acts .btn { flex: 1; }
    /* Question dialog (options as buttons) */
    .q-block { display: flex; flex-direction: column; gap: 6px; }
    .q-text { font-size: 15px; font-weight: 400; color: var(--tc-1st); line-height: 1.4; }
    .q-opts { display: flex; flex-direction: column; gap: 6px; }
    .q-opt { width: 100%; min-width: 0; text-align: left; white-space: normal; background: var(--bc-1st); }
    .q-opt.chosen { color: var(--tc-hi); background: var(--bc-hi); }

    /* ── Event log ───────────────────────────────────────────────────────── */
    .log { flex: 1; min-height: 200px; max-height: 46vh; overflow-y: auto; display: flex;
      flex-direction: column; gap: 12px; padding: 16px; background: var(--bc-1st);
      border-radius: var(--r); }
    .ev { font-size: 15px; line-height: 1.5; word-break: break-word; }
    .ev-text { white-space: pre-wrap; }
    .ev-assistant .ev-text { color: var(--tc-1st); font-weight: 300; }
    /* Your message → a right-aligned dark bubble (BC-Highlight). */
    .ev-user { display: flex; justify-content: flex-end; }
    .ev-user .ev-text { color: var(--tc-hi); font-weight: 400; background: var(--bc-hi);
      padding: 8px 12px; border-radius: var(--r); max-width: 85%; }
    .ev-system { color: var(--tc-2nd); font-size: 13px; font-weight: 400; }
    .ev-result { font-size: 13px; font-weight: 400; font-variant-numeric: tabular-nums; }
    .ev-result.ok { color: var(--tc-green); }
    .ev-result.err { color: var(--tc-red); }
    .ev-perm { color: var(--tc-1st); font-size: 13px; font-weight: 400; }
    .ev-tool { margin-top: 6px; }
    .ev-tool-head { font-size: 13px; font-weight: 400; color: var(--tc-2nd); }
    .ev-tool-input { margin: 4px 0 0; max-height: 220px; overflow: auto; padding: 12px;
      font: 400 12px/1.5 var(--mono); color: var(--tc-1st); background: var(--bc-2nd);
      border-radius: var(--r-in); white-space: pre-wrap; word-break: break-word; }

    /* ── Composer ────────────────────────────────────────────────────────── */
    .composer { position: relative; display: flex; flex-direction: column; gap: 6px; }
    .send-input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 48px; padding: 12px;
      font: 300 15px/1.45 var(--font); letter-spacing: -0.01em; color: var(--tc-1st); background: var(--sc-2nd);
      border: 0; border-radius: var(--r); outline: none; -webkit-appearance: none; }
    .send-input::placeholder { color: var(--tc-2nd); }
    .interim { font-size: 13px; color: var(--tc-2nd); font-style: italic; padding: 0 2px; }
    .interim[hidden] { display: none; }
    .composer-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    /* Canned sends: even, intentional widths (3-up then 2-up at phone width),
       not a ragged auto-wrap. Each row's chips share the width equally. */
    .quick-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .quick-row .quick { flex: 1 1 30%; min-width: 96px; }

    /* ── Slash-command autocomplete (floats above the composer) ───────────── */
    /* A floating popover: shadow only, and the rows are a segmented list —
       0px apart with a fill highlight, no divider hairlines (per the doc). */
    .cmd-menu { position: absolute; left: 0; right: 0; bottom: 100%; margin-bottom: 6px; z-index: 5;
      max-height: 232px; overflow-y: auto; display: flex; flex-direction: column;
      background: var(--bc-1st); border-radius: var(--r); box-shadow: var(--shadow); }
    .cmd-menu[hidden] { display: none; }
    .cmd-row { display: flex; align-items: baseline; gap: 12px; width: 100%; box-sizing: border-box;
      text-align: left; padding: 12px 16px; background: transparent; border: 0; cursor: pointer; }
    .cmd-row.active, .cmd-row:active { background: var(--bc-2nd); }
    .cmd-name { flex: 0 0 auto; font: 400 13px/1.2 var(--mono); color: var(--tc-1st); }
    .cmd-hint { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 400; color: var(--tc-2nd);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }

    /* ── Steering ────────────────────────────────────────────────────────── */
    .steer { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; align-items: end; }
    .steer .archive { grid-column: 1 / -1; }
    .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .field-label { font-size: 11px; font-weight: 400; color: var(--tc-2nd); }
    /* Dropdowns are BC-2nd bars with a chevron, like the doc's headers. */
    .select { width: 100%; box-sizing: border-box; padding: 12px 34px 12px 12px; font: 400 15px/1 var(--font);
      color: var(--tc-1st); background-color: var(--bc-2nd); border: 0; border-radius: var(--r);
      -webkit-appearance: none; appearance: none; cursor: pointer; outline: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' fill='none' stroke='%237B7B7B' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 12px center; }

    /* ── Buttons ─────────────────────────────────────────────────────────── */
    /* All flat fills: standard = BC-1st white, primary = BC-Highlight dark,
       danger = red TEXT on the standard fill, pressed = the next-darker grey. */
    .btn { min-width: 84px; padding: 12px; font: 400 15px/1 var(--font); letter-spacing: -0.01em;
      color: var(--tc-1st); background: var(--bc-1st); border: 0; border-radius: var(--r);
      cursor: pointer; transition: background 0.15s, opacity 0.15s; }
    .btn:active { background: var(--bc-4th); }
    .btn:disabled { opacity: 0.4; cursor: default; }   /* doc: disabled = opacity, not overlay */
    .btn.primary { color: var(--tc-hi); background: var(--bc-hi); }
    .btn.primary:active { background: #3A3A3A; }
    .btn.danger { color: var(--tc-red); background: var(--bc-1st); }
    .btn.danger:active { background: var(--bc-4th); }
    .btn.danger.armed { color: var(--tc-hi); background: var(--tc-red); }
    .btn.ghost { background: transparent; color: var(--tc-2nd); min-width: 0; padding: 10px 12px; }
    .btn.ghost:active { background: var(--bc-4th); }
    .btn.active { color: var(--tc-hi); background: var(--bc-hi); }

    /* ── Toast (BC-1st + soft shadow; the doc's small informative toast, ~3s) ─ */
    .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 10;
      max-width: 88vw; padding: 12px 16px; font-size: 15px; font-weight: 400; line-height: 1.4;
      text-align: center; color: var(--tc-1st); background: var(--bc-1st);
      border-radius: var(--r); box-shadow: var(--shadow); }
    .toast[hidden] { display: none; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
