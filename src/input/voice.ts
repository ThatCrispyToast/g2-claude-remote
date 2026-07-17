// Voice dictation — the keyboard-free text-input path for the G2.
//
// On a keyboard-less device, speech is the only way to compose a free-form
// message. This is a thin orchestrator over the Deepgram LiveCaptioner: it opens
// the glasses mic (`bridge.audioControl(true)`), streams the mic's PCM frames to
// Deepgram, accumulates the committed (final) transcript, and surfaces the live
// interim so the wearer sees words land as they speak. `stop()` returns the
// finished transcript, which main.ts hands to the bridge as a message.
//
// main.ts owns the single `bridge.onEvenHubEvent` subscription and forwards each
// `audioEvent.audioPcm` frame here via `pushPcm` — this class never subscribes
// to bridge events itself.

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { MIC_SILENCE_TIMEOUT_MS, VOICE_ENABLED, DEEPGRAM_API_KEY } from '../config'
import { LiveCaptioner, type CaptionerStatus } from '../stt/deepgram'

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'error'

export interface VoiceHandlers {
  /** The best transcript so far (finals + latest interim), on every change. */
  onInterim: (text: string) => void
  /** Dictation lifecycle, for the HUD. */
  onStatus: (s: VoiceStatus) => void
}

/** Map the captioner's connection state onto the dictation-facing status. */
function toVoiceStatus(s: CaptionerStatus): VoiceStatus {
  switch (s) {
    case 'connecting':
      return 'connecting'
    case 'live':
      return 'listening'
    case 'reconnecting':
      return 'reconnecting'
    case 'stopped':
      return 'idle'
  }
}

export class VoiceDictation {
  private captioner: LiveCaptioner | null = null
  private handlers: VoiceHandlers | null = null
  /** Set synchronously across start()'s awaits to reject re-entrant starts. */
  private starting = false
  /** Committed segments joined with spaces — the durable part of the transcript. */
  private finals = ''
  /** The current volatile hypothesis (cleared each time a window commits). */
  private interim = ''
  /** performance.now() of the last PCM frame — drives the mic watchdog. */
  private lastPcmAt = 0
  private micWatchdog: number | null = null

  constructor(private readonly bridge: EvenAppBridge) {}

  /** True when Deepgram is configured — otherwise dictation is a no-op. */
  get available(): boolean {
    return VOICE_ENABLED
  }

  /**
   * Open the mic and start dictating. Interims stream through `handlers.onInterim`
   * and lifecycle through `handlers.onStatus`. If voice isn't available (no
   * Deepgram key) this reports `'error'` and does nothing else.
   */
  async start(handlers: VoiceHandlers): Promise<void> {
    this.handlers = handlers
    if (!this.available) {
      handlers.onStatus('error')
      return
    }
    // Re-entry guard: ignore a second start() while one is connecting or a
    // session is already live, so we never orphan a captioner or leak a watchdog.
    if (this.starting || this.captioner) return
    this.starting = true
    // Fresh session — discard any transcript from a previous run.
    this.finals = ''
    this.interim = ''
    handlers.onStatus('connecting')

    try {
      await this.bridge.audioControl(true)
    } catch (err) {
      console.error('[voice] failed to open mic:', err)
      this.starting = false
      handlers.onStatus('error')
      return
    }

    this.lastPcmAt = performance.now()
    this.captioner = new LiveCaptioner(DEEPGRAM_API_KEY, {
      onFinal: (text) => {
        this.finals = this.finals ? `${this.finals} ${text}` : text
        this.interim = ''
        this.emitInterim()
      },
      onInterim: (text) => {
        this.interim = text
        this.emitInterim()
      },
      onStatus: (s) => {
        this.handlers?.onStatus(toVoiceStatus(s))
      },
      onFatal: (message) => {
        console.error('[voice] deepgram fatal:', message)
        this.handlers?.onStatus('error')
      },
    })

    // Watchdog: the mic sometimes closes silently on the glasses. If no PCM has
    // arrived for a while, ask the bridge to reopen it (best effort).
    this.micWatchdog = window.setInterval(() => {
      if (performance.now() - this.lastPcmAt < MIC_SILENCE_TIMEOUT_MS) return
      this.lastPcmAt = performance.now() // avoid hammering audioControl every tick
      void this.bridge.audioControl(true).catch((err) => {
        console.error('[voice] mic reopen failed:', err)
      })
    }, 2000)
    this.starting = false
  }

  /**
   * Feed one mic frame (PCM s16le) from main.ts's onEvenHubEvent handler. No-op
   * when not dictating.
   */
  pushPcm(pcm: Uint8Array): void {
    if (!this.captioner) return
    this.lastPcmAt = performance.now()
    this.captioner.feed(pcm)
  }

  /**
   * Stop dictating: close the mic, flush Deepgram's remaining finals, and return
   * the finished transcript (trimmed). Safe to call when not started.
   */
  async stop(): Promise<string> {
    this.starting = false
    this.clearWatchdog()
    try {
      await this.bridge.audioControl(false)
    } catch (err) {
      console.error('[voice] failed to close mic:', err)
    }
    const captioner = this.captioner
    this.captioner = null
    if (captioner) await captioner.stop()
    const text = this.transcript.trim()
    this.handlers?.onStatus('idle')
    this.finals = ''
    this.interim = ''
    return text
  }

  /** Stop dictating and throw the transcript away (cancel path). */
  async cancel(): Promise<void> {
    this.starting = false
    this.clearWatchdog()
    try {
      await this.bridge.audioControl(false)
    } catch (err) {
      console.error('[voice] failed to close mic:', err)
    }
    const captioner = this.captioner
    this.captioner = null
    captioner?.close()
    this.finals = ''
    this.interim = ''
    this.handlers?.onStatus('idle')
  }

  /** The current best transcript: committed finals plus the latest interim. */
  get transcript(): string {
    if (!this.interim) return this.finals
    return this.finals ? `${this.finals} ${this.interim}` : this.interim
  }

  private emitInterim(): void {
    this.handlers?.onInterim(this.transcript)
  }

  private clearWatchdog(): void {
    if (this.micWatchdog !== null) {
      clearInterval(this.micWatchdog)
      this.micWatchdog = null
    }
  }
}
