// Central configuration for Claude Remote.
//
// Secrets and per-user overrides come from two layers (highest wins):
//   1. Runtime settings saved from the companion panel (localStorage) — the
//      only config path on an installed build.
//   2. Vite env vars (prefix `VITE_`, in `.env.local`) — DEV SERVER ONLY.
//      `vite build` resolves no env vars (see `envPrefix` in vite.config.ts),
//      so a pack never carries them; every pack is a distribution pack.
// Everything else has a sensible default so the app runs with just a bridge
// URL + token. See `.env.example`.

import type { QuickSend, SlashCommand, ModelChoice, EffortChoice, PermissionMode } from './rc/types'

// ─── Runtime settings (saved from the panel, stored on the device) ───────────
/** localStorage key for user-entered connection settings. Also the key under
 *  which main.ts mirrors the same JSON into the Even App-side store, which — unlike
 *  the WebView's browser localStorage — survives the app being closed and reopened. */
export const SETTINGS_KEY = 'claude-remote.settings'

export interface RuntimeSettings {
  bridgeUrl?: string
  bridgeToken?: string
  deepgramApiKey?: string
  /** Deepgram language code for dictation (`en`, `de`, `multi`, …). Unset = the
   *  build default (see `STT_LANGUAGE`). */
  sttLanguage?: string
  /** Ids of baked release notices already dismissed on this device (notices.ts).
   *  Rides the same blob so the main.ts SDK-store mirror persists it for free. */
  seenNotices?: string[]
  /** The glasses' display settings, chosen in Settings on the glasses. */
  display?: Partial<DisplaySettings>
}

/** A head position: the motion sensor's gravity reading, in g. */
export type HeadReading = [number, number, number]

/** When the glasses screen blanks and what wakes it. */
export interface DisplaySettings {
  /** Seconds without input before the screen blanks; 0 = never. */
  blankAfterS: number
  /** Blank while the head is in its normal position, and wake on tilting it
   *  to the waking one (up or down). Needs `lookCal`. */
  lookWake: boolean
  /** The head's normal position and the position that wakes the screen,
   *  recorded in Settings. */
  lookCal: { rest: HeadReading; read: HeadReading } | null
  /** While the screen is blank, show "!" when a turn finishes or a prompt
   *  waits. */
  notifyDone: boolean
}
export const BLANK_AFTER_CHOICES = [0, 15, 30, 60, 120, 300]
const DISPLAY_DEFAULTS: DisplaySettings = { blankAfterS: 0, lookWake: false, lookCal: null, notifyDone: true }

/** The display settings saved on this device, over the defaults. A
 *  calibration in an older shape is dropped. */
export function displaySettings(): DisplaySettings {
  const d = { ...DISPLAY_DEFAULTS, ...(loadRuntimeSettings().display ?? {}) }
  if (d.lookCal && !(Array.isArray(d.lookCal.rest) && Array.isArray(d.lookCal.read))) d.lookCal = null
  return d
}

/** Save display settings over the stored ones. The caller then mirrors the
 *  blob to the SDK store (main.ts persistSettings). */
export function saveDisplaySettings(patch: Partial<DisplaySettings>): void {
  saveRuntimeSettings({ ...loadRuntimeSettings(), display: { ...displaySettings(), ...patch } })
}

/** The settings saved from the panel, or {} when absent/unreadable. */
export function loadRuntimeSettings(): RuntimeSettings {
  try {
    const raw = window.localStorage?.getItem(SETTINGS_KEY)
    const obj = raw ? JSON.parse(raw) : null
    return obj && typeof obj === 'object' ? (obj as RuntimeSettings) : {}
  } catch {
    return {}
  }
}

/** Persist panel-entered settings (empty strings clear a field). The caller then
 *  reconnects in place (see `currentBridge`) — no page reload, which would drop
 *  the glasses bridge. The `BRIDGE_*` consts are the build's defaults and never
 *  see these; the `current*()` accessors re-read the live values. */
export function saveRuntimeSettings(s: RuntimeSettings): void {
  try {
    const clean: RuntimeSettings = {}
    if (s.bridgeUrl?.trim()) clean.bridgeUrl = s.bridgeUrl.trim()
    if (s.bridgeToken?.trim()) clean.bridgeToken = s.bridgeToken.trim()
    if (s.deepgramApiKey?.trim()) clean.deepgramApiKey = s.deepgramApiKey.trim()
    if (s.sttLanguage?.trim()) clean.sttLanguage = s.sttLanguage.trim()
    // Seen-notice ids are NOT connection settings: the Settings card's Save and
    // Reset pass only their own fields, and neither may resurrect notices the
    // wearer already dismissed — so when the caller doesn't provide the list
    // (only notices.ts does), carry the stored one forward.
    const seen = s.seenNotices ?? loadRuntimeSettings().seenNotices
    const ids = (Array.isArray(seen) ? seen : []).filter((v) => typeof v === 'string' && v).slice(0, 50)
    if (ids.length > 0) clean.seenNotices = ids
    // Display settings come from the glasses, not the Settings card: carried
    // forward like the notice ids when the caller doesn't pass them.
    const display = s.display ?? loadRuntimeSettings().display
    if (display && typeof display === 'object') clean.display = display
    if (Object.keys(clean).length === 0) window.localStorage?.removeItem(SETTINGS_KEY)
    else window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(clean))
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

/** Read a `VITE_`-prefixed string env var, or fall back to `def`. */
function strEnv(value: unknown, def: string): string {
  return typeof value === 'string' && value.length > 0 ? value : def
}

/** Read a numeric env var, falling back to `def` if unset/blank/non-finite. */
function numEnv(value: unknown, def: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : def
}

/** Read a boolean env var. Anything but the literal string `"false"` is true. */
function boolEnv(value: unknown, def: boolean): boolean {
  if (value === undefined || value === null || value === '') return def
  return String(value).toLowerCase() !== 'false'
}

// In a build every `VITE_*` read below is undefined by construction (see
// vite.config.ts), so packs land on the defaults + runtime settings.
const env = import.meta.env

// ─── The bridge (Claude Remote bridge → claude-rc-api → Anthropic) ───────────
/** Resolve the effective bridge URL / token from a settings snapshot (runtime
 *  setting wins over the dev-only `VITE_` value; then a sensible default). Shared
 *  by the build-default consts (an empty snapshot) and the live `currentBridge()`. */
function resolveBridgeUrl(s: RuntimeSettings): string {
  return strEnv(s.bridgeUrl ?? env.VITE_BRIDGE_URL, 'http://localhost:8790').replace(/\/+$/, '')
}
function resolveBridgeToken(s: RuntimeSettings): string {
  return strEnv(s.bridgeToken ?? env.VITE_BRIDGE_TOKEN, '')
}
/**
 * The build's bridge URL, used when none is saved in the Settings card (the
 * dev-only `VITE_` value, else localhost). No trailing slash. A wearer saves a
 * name the phone can reach from anywhere — e.g. the host's Tailscale MagicDNS
 * name (`http://my-box.tailXXXX.ts.net:8790`) or a LAN IP. Like the token and
 * key below, this is the Settings field's placeholder, so it must NOT fold in
 * the saved value — a blank field falls back to exactly this.
 */
export const BRIDGE_URL = resolveBridgeUrl({})
/** The build's shared secret for the bridge's RC_BRIDGE_TOKEN (none in a pack).
 *  Sent as a Bearer header (and as `?token=` on the SSE stream, which can't set
 *  headers). */
export const BRIDGE_TOKEN = resolveBridgeToken({})

/** The bridge URL + token RIGHT NOW, re-reading saved settings so a Settings-card
 *  change applies WITHOUT a full page reload (a reload drops the Even glasses
 *  bridge). The consts above are the build defaults; this is the live view. */
export function currentBridge(): { url: string; token: string } {
  const s = loadRuntimeSettings()
  return { url: resolveBridgeUrl(s), token: resolveBridgeToken(s) }
}

/** Whether a bridge has been configured at all — a saved setting OR a dev-only
 *  `VITE_` value. When false and the first connection fails, the app shows the
 *  first-run setup screen (point the wearer at the panel's Settings card) rather
 *  than a raw connection error. Live, so it re-evaluates after a settings save. */
export function isBridgeConfigured(): boolean {
  const s = loadRuntimeSettings()
  return Boolean(s.bridgeUrl || s.bridgeToken || env.VITE_BRIDGE_URL || env.VITE_BRIDGE_TOKEN)
}

// ─── Polling / streaming ─────────────────────────────────────────────────────
/** How often the active-session list is refreshed (ms). The list has no SSE. */
export const POLL_MS = numEnv(env.VITE_POLL_MS, 4000)
/** A session stream that has pinged (bridge 0.5.0+ passes the API's ~15 s
 *  keepalive through) and then stays silent this long is dead, whatever the
 *  socket says. The Claude Code CLI's own limit. */
export const STREAM_SILENCE_MS = numEnv(env.VITE_STREAM_SILENCE_MS, 45_000)
/** Newest events asked for when a session is opened. A floor, not a cap: a
 *  0.6.0 bridge reads further back until the window holds some conversation. */
export const HISTORY_LIMIT = numEnv(env.VITE_HISTORY_LIMIT, 200)

// ─── Glasses display ─────────────────────────────────────────────────────────
// The session view is a fixed header + a firmware-scrolled text body (see
// glasses.ts). The body isn't paged in software — the glasses scroll it natively
// — so these size the two body windows. They are BYTE budgets: the firmware caps
// a text container by UTF-8 byte length (~1000), and the HUD glyphs are multi-byte,
// so sizing by chars would overflow the cap and the whole render would be dropped.
/**
 * The live body: the tail of the transcript kept on screen while auto-following.
 * It must ALWAYS fit the body height with no overflow — the firmware renders
 * text top-aligned and never scrolls to the bottom by itself, so an overflowing
 * live tail hides exactly the newest lines. The tail is therefore budgeted by
 * visual ROWS (LIVE_BODY_ROWS, each line's wrapping measured with the firmware
 * font's widths: `bodyRows`) with this as the additional byte ceiling. It also
 * sizes the dictation screen's tail (`liveTail`).
 */
export const LIVE_BODY_BYTES = numEnv(env.VITE_LIVE_BODY_BYTES, 320)
/** The live body's byte ceiling under the image strip: its 8 rows hold about
 *  500 characters, so full rows reach the row limit first. */
export const LIVE_BODY_BYTES_STRIP = 640
/** How many rendered text rows the live body can show without overflowing its
 *  220px band. Conservative — a row too few beats hiding the newest line. */
export const LIVE_BODY_ROWS = numEnv(env.VITE_LIVE_ROWS, 6)
/** Conservative average characters per wrapped row of the proportional HUD font
 *  across the 576px-wide body (used to estimate how lines wrap). */
export const HUD_CHARS_PER_ROW = numEnv(env.VITE_HUD_CHARS_PER_ROW, 40)
/**
 * The history window: how much transcript is frozen into the natively-scrolled
 * body when the wearer scrolls back — a few screens the firmware scrolls smoothly.
 * Kept under glasses.ts's per-container byte ceiling (BODY_BYTE_CAP ≈ 980).
 */
export const HISTORY_WINDOW_BYTES = numEnv(env.VITE_HISTORY_BYTES, 900)
/**
 * Chars allowed for the ARGUMENT half of a tool-chain entry (`Read factory.py`)
 * — see `packToolChain` in events/format.ts. Several entries share a HUD row, so
 * this is deliberately tight: it fits a file basename or a `cargo test`, not a
 * whole command line (the panel shows the full input).
 */
export const TOOL_ARG_CHARS = numEnv(env.VITE_TOOL_ARG_CHARS, 18)

// ─── Steering vocabulary ─────────────────────────────────────────────────────
/** Models offered in the Compose → Model submenu (matches the claude-rc web SPA). */
export const MODELS: ModelChoice[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2' },
]
/** Permission modes offered in the Compose → Mode submenu. */
export const MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions']
/** Effort levels offered in the Compose → Effort submenu. "auto" clears to the
 *  model default. Workers on Claude Code 2.1.30x apply a level for this session
 *  only; older ones fall back to the `/effort` command, which also saves it as
 *  that machine's default for the model. */
export const EFFORTS: EffortChoice[] = [
  { id: null, label: 'auto' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
]

/**
 * Canned messages fired from the Compose menu with a single tap — the primary,
 * zero-latency input path for a keyboard-less device. Override with a JSON array
 * of {label,text} in VITE_QUICK_SENDS.
 */
function parseQuickSends(raw: unknown): QuickSend[] {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        return arr
          .filter((q) => q && typeof q.label === 'string' && typeof q.text === 'string')
          .map((q) => ({ label: q.label, text: q.text }))
      }
    } catch {
      /* fall through to defaults */
    }
  }
  return [
    { label: 'Proceed', text: 'proceed' },
    { label: 'Run tests', text: 'run the tests' },
    { label: 'Explain', text: 'explain what you just did' },
  ]
}
export const QUICK_SENDS: QuickSend[] = parseQuickSends(env.VITE_QUICK_SENDS)

/**
 * Canned side questions for the Compose → Ask aside submenu. A side question is
 * answered from the session's conversation without interrupting it or entering
 * the transcript (one model call — claude.ai's "btw"), so it's the keyboard-free
 * way to check in on a busy session. Short: each is a native list row (~60
 * bytes). Override with a JSON array of strings in VITE_ASIDE_QUESTIONS.
 */
function parseAsideQuestions(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim())
    } catch {
      /* fall through to defaults */
    }
  }
  return ['What are you doing right now?', "What's left before you're done?", 'Anything blocking you?']
}
export const ASIDE_QUESTIONS: string[] = parseAsideQuestions(env.VITE_ASIDE_QUESTIONS)

/** Local shortcuts to session information. Neither posts a user message. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'context', label: 'Context usage' },
  { name: 'usage', label: 'Plan usage' },
]

export function isSlashInput(text: string): boolean {
  return /^\/[\w:-]+(?:\s|$)/u.test(text.trim())
}

// ─── Voice dictation (optional; reuses the glasses mic + Deepgram) ───────────
// Text INPUT on a keyboard-less device: hold-free voice dictation. Streams the
// glasses PCM to Deepgram exactly like g2-live-captions; the final transcript
// becomes a /send body. Off automatically when no Deepgram key is set.
function resolveDeepgramKey(s: RuntimeSettings): string {
  return strEnv(s.deepgramApiKey ?? env.VITE_DEEPGRAM_API_KEY, '')
}
/** The build's Deepgram key (none in a pack) — a placeholder, like `BRIDGE_URL`. */
export const DEEPGRAM_API_KEY = resolveDeepgramKey({})
/** The Deepgram key RIGHT NOW (re-reads saved settings — see `currentBridge`). */
export function currentDeepgramKey(): string {
  return resolveDeepgramKey(loadRuntimeSettings())
}
export const DEEPGRAM_MODEL = strEnv(env.VITE_DEEPGRAM_MODEL, 'nova-3')
/** The build's dictation language: the Deepgram `?language=` code used when none
 *  is saved in the Settings card (`en`, unless the dev-only `VITE_` var says
 *  otherwise). It is that field's placeholder, so it must NOT fold in the saved
 *  value — a blank field falls back to exactly this. */
export const STT_LANGUAGE = strEnv(env.VITE_STT_LANGUAGE, 'en')
/** The dictation language RIGHT NOW (re-reads saved settings — see `currentBridge`),
 *  so a language saved in the Settings card applies to the next dictation without
 *  a reload. */
export function currentSttLanguage(): string {
  return strEnv(loadRuntimeSettings().sttLanguage, STT_LANGUAGE)
}
/** Is `code` shaped like a Deepgram language code: `multi` (mixed-language
 *  speech) or a BCP-47-style tag such as `en`, `pt-BR`, `zh-Hant`, `es-419`?
 *  A shape check only, to catch typos like `german` at save time. Deepgram is
 *  the judge of what it supports: a well-formed code it lacks still fails at
 *  connect, after the captioner's reconnect budget, like a bad key. */
export function isSttLanguage(code: string): boolean {
  return /^(multi|[a-z]{2,3}(-[a-z0-9]{2,8})*)$/i.test(code)
}
/** Master switch for voice dictation (also needs the Deepgram key). */
const VOICE_MASTER = boolEnv(env.VITE_VOICE_ENABLED, true)
/** Live voice availability: the master switch plus a Deepgram key entered in the
 *  Settings card (so adding a key enables voice without a reload). Always ask
 *  this — there is no load-time snapshot, because a key saved in the Settings
 *  card must enable voice without a reload. */
export function voiceEnabled(): boolean {
  return VOICE_MASTER && currentDeepgramKey().length > 0
}

/** G2 mic format is fixed: PCM signed-16 little-endian, mono, 16 kHz. */
export const SAMPLE_RATE = 16000
/** Consecutive failed (re)connects to Deepgram before giving up. */
export const RECONNECT_MAX_ATTEMPTS = 8
export const RECONNECT_BASE_DELAY_MS = 500
export const RECONNECT_MAX_DELAY_MS = 8000
/** Send a Deepgram KeepAlive if no audio has gone out for this long. */
export const KEEPALIVE_IDLE_MS = 5000
/** Mic audio buffered while the socket is down (10 s of 16 kHz s16 mono). */
export const PENDING_AUDIO_MAX_BYTES = SAMPLE_RATE * 2 * 10
/** How long stop() waits for Deepgram to flush final results. */
export const STOP_FLUSH_TIMEOUT_MS = 3000
/** No mic data for this long while dictating → try to reopen the mic. */
export const MIC_SILENCE_TIMEOUT_MS = numEnv(env.VITE_MIC_SILENCE_TIMEOUT_MS, 8000)

// ─── Identity ────────────────────────────────────────────────────────────────
export const APP_TITLE = 'Claude Remote'
/** Short form for tight HUD headers (a full HUD row fits only ~40 chars). */
export const APP_TITLE_SHORT = 'Claude'
