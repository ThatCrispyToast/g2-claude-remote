// Central configuration for Claude Remote.
//
// Secrets and per-user overrides come from two layers (highest wins):
//   1. Runtime settings saved from the companion panel (localStorage) — so a
//      packed build never needs secrets baked in.
//   2. Vite env vars (prefix `VITE_`, in `.env.local`), baked in at build time.
// Everything else has a sensible default so the app runs with just a bridge
// URL + token. See `.env.example`.

import type { QuickSend, ModelChoice, PermissionMode } from './rc/types'

// ─── Runtime settings (saved from the panel, stored on the device) ───────────
/** localStorage key for user-entered connection settings. */
const SETTINGS_KEY = 'claude-remote.settings'

export interface RuntimeSettings {
  bridgeUrl?: string
  bridgeToken?: string
  deepgramApiKey?: string
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

/** Persist panel-entered settings (empty strings clear a field). The caller
 *  reloads the page so the module-level consts below re-evaluate. */
export function saveRuntimeSettings(s: RuntimeSettings): void {
  try {
    const clean: RuntimeSettings = {}
    if (s.bridgeUrl?.trim()) clean.bridgeUrl = s.bridgeUrl.trim()
    if (s.bridgeToken?.trim()) clean.bridgeToken = s.bridgeToken.trim()
    if (s.deepgramApiKey?.trim()) clean.deepgramApiKey = s.deepgramApiKey.trim()
    if (Object.keys(clean).length === 0) window.localStorage?.removeItem(SETTINGS_KEY)
    else window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(clean))
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

const runtime = loadRuntimeSettings()

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

const env = import.meta.env

// ─── The bridge (Claude Remote bridge → claude-rc-api → Anthropic) ───────────
/**
 * Base URL of the bridge (server/rc_bridge.py). No trailing slash. Use a name
 * the phone can reach from anywhere you wear the glasses — e.g. the host's
 * Tailscale MagicDNS name (`http://my-box.tailXXXX.ts.net:8790`) or a LAN IP.
 */
export const BRIDGE_URL = strEnv(runtime.bridgeUrl ?? env.VITE_BRIDGE_URL, 'http://localhost:8790').replace(/\/+$/, '')
/** Shared secret matching the bridge's RC_BRIDGE_TOKEN. Sent as a Bearer header
 *  (and as `?token=` on the SSE stream, which can't set headers). */
export const BRIDGE_TOKEN = strEnv(runtime.bridgeToken ?? env.VITE_BRIDGE_TOKEN, '')

// ─── Polling / streaming ─────────────────────────────────────────────────────
/** How often the active-session list is refreshed (ms). The list has no SSE. */
export const POLL_MS = numEnv(env.VITE_POLL_MS, 4000)
/** Events pulled for history when a session is first opened. */
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
 * estimated visual ROWS (LIVE_BODY_ROWS × HUD_CHARS_PER_ROW, wrapping counted)
 * with this as the additional byte ceiling.
 */
export const LIVE_BODY_BYTES = numEnv(env.VITE_LIVE_BODY_BYTES, 320)
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
/** Max sessions / menu rows shown on one list screen (SDK caps list items at 20). */
export const MAX_LIST_ROWS = numEnv(env.VITE_MAX_LIST_ROWS, 12)
/** Clip a tool command / permission input to this many chars on the HUD. */
export const INPUT_CLIP_CHARS = numEnv(env.VITE_INPUT_CLIP_CHARS, 140)

// ─── Steering vocabulary ─────────────────────────────────────────────────────
/** Models offered in the Compose → Model submenu (matches the claude-rc web SPA). */
export const MODELS: ModelChoice[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
]
/** Permission modes offered in the Compose → Mode submenu. */
export const MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions']

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
    { label: 'Continue', text: 'continue' },
    { label: 'Yes', text: 'yes' },
    { label: 'Run the tests', text: 'run the tests' },
    { label: 'Explain', text: 'explain what you just did' },
    { label: 'Proceed', text: 'proceed' },
  ]
}
export const QUICK_SENDS: QuickSend[] = parseQuickSends(env.VITE_QUICK_SENDS)

// ─── Voice dictation (optional; reuses the glasses mic + Deepgram) ───────────
// Text INPUT on a keyboard-less device: hold-free voice dictation. Streams the
// glasses PCM to Deepgram exactly like g2-live-captions; the final transcript
// becomes a /send body. Off automatically when no Deepgram key is set.
export const DEEPGRAM_API_KEY = strEnv(runtime.deepgramApiKey ?? env.VITE_DEEPGRAM_API_KEY, '')
export const DEEPGRAM_MODEL = strEnv(env.VITE_DEEPGRAM_MODEL, 'nova-3')
export const STT_LANGUAGE = strEnv(env.VITE_STT_LANGUAGE, 'en')
/** Master switch for voice dictation (also needs the Deepgram key). */
export const VOICE_ENABLED = boolEnv(env.VITE_VOICE_ENABLED, true) && DEEPGRAM_API_KEY.length > 0

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
