// Voice dictation — the keyboard-free text-input path for the G2.
//
// On a keyboard-less device, speech is the only way to compose a free-form
// message. This is a thin orchestrator over a captioner (Deepgram's LiveCaptioner
// or the bridge's BridgeCaptioner): it opens the glasses mic
// (`bridge.audioControl(true)`), streams the mic's PCM frames to it, accumulates
// the committed (final) transcript, and surfaces the live interim so the wearer
// sees words land as they speak. `stop()` returns the
// finished transcript, which main.ts hands to the bridge as a message.
//
// main.ts owns the single `bridge.onEvenHubEvent` subscription and forwards each
// `audioEvent.audioPcm` frame here via `pushPcm` — this class never subscribes
// to bridge events itself.

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { MIC_SILENCE_TIMEOUT_MS, voiceEnabled, currentDeepgramKey, currentSttSource } from '../config'
import { LiveCaptioner, type CaptionerHandlers, type CaptionerStatus } from '../stt/deepgram'
import { BridgeCaptioner } from '../stt/bridge'

export type VoiceStatus = 'idle' | 'connecting' | 'downloading model' | 'listening' | 'reconnecting' | 'error'

export interface VoiceHandlers {
  /** The best transcript so far (finals + latest interim), on every change. */
  onInterim: (text: string) => void
  /** Dictation lifecycle, for the HUD. An `'error'` may say what went wrong. */
  onStatus: (s: VoiceStatus, detail?: string) => void
}

/** Map the captioner's connection state onto the dictation-facing status. */
function toVoiceStatus(s: CaptionerStatus): VoiceStatus {
  switch (s) {
    case 'connecting':
      return 'connecting'
    case 'downloading model':
      return 'downloading model'
    case 'live':
      return 'listening'
    case 'reconnecting':
      return 'reconnecting'
    case 'stopped':
      return 'idle'
  }
}


interface DictationRun {
  handlers: VoiceHandlers
  captioner?: LiveCaptioner | BridgeCaptioner
  finals: string
  interim: string
  finishing: boolean
  lastPcmAt: number
  watchdog?: number
}

const MIC_TIMEOUT_MS = 4000

export class VoiceDictation {
  private run: DictationRun | null = null
  private micQueue: Promise<void> = Promise.resolve()
  private micWanted = false

  constructor(private readonly bridge: EvenAppBridge) {}

  get available(): boolean {
    return voiceEnabled()
  }

  async start(handlers: VoiceHandlers): Promise<void> {
    if (this.run) return
    if (!this.available) {
      handlers.onStatus('error', 'Dictation is unavailable.')
      return
    }
    const run: DictationRun = { handlers, finals: '', interim: '', finishing: false, lastPcmAt: performance.now() }
    this.run = run
    handlers.onStatus('connecting')
    try {
      await this.micControl(true)
      if (this.run !== run || run.finishing) return

      const emit = () => handlers.onInterim(this.transcript)
      const callbacks: CaptionerHandlers = {
        onFinal: text => {
          if (this.run !== run) return
          run.finals = run.finals ? run.finals + ' ' + text : text
          run.interim = ''
          emit()
        },
        onInterim: text => {
          if (this.run !== run) return
          run.interim = text
          emit()
        },
        onStatus: s => {
          if (this.run === run) handlers.onStatus(toVoiceStatus(s))
        },
        onFatal: reason => {
          if (this.run === run) handlers.onStatus('error', reason)
        },
      }
      run.captioner = currentSttSource() === 'bridge'
        ? new BridgeCaptioner(callbacks)
        : new LiveCaptioner(currentDeepgramKey(), callbacks)
      run.lastPcmAt = performance.now()
      run.watchdog = window.setInterval(() => {
        if (performance.now() - run.lastPcmAt < MIC_SILENCE_TIMEOUT_MS) return
        run.lastPcmAt = performance.now()
        void this.micControl(true).catch(err => console.warn('[voice] mic reopen failed:', err))
      }, 2000)
    } catch (err) {
      if (this.run === run && !run.finishing) handlers.onStatus('error', (err as Error).message)
    }
  }

  pushPcm(pcm: Uint8Array): void {
    if (!this.run?.captioner) return
    this.run.lastPcmAt = performance.now()
    this.run.captioner.feed(pcm)
  }

  get transcript(): string {
    const run = this.run
    return run ? [run.finals, run.interim].filter(Boolean).join(' ') : ''
  }

  /** Finals may still arrive while stopping. Only this run may consume them. */
  async stop(): Promise<string> {
    const run = this.run
    if (!run || run.finishing) return ''
    run.finishing = true
    clearInterval(run.watchdog)
    try {
      await this.closeMic()
      if (this.run !== run) return ''
      await run.captioner?.stop()
      return this.run === run ? this.transcript.trim() : ''
    } finally {
      if (this.run === run) {
        this.run = null
        run.handlers.onStatus('idle')
      }
    }
  }

  /** Retire callbacks synchronously, including a final request still in flight. */
  async cancel(): Promise<void> {
    const run = this.run
    if (!run) return
    this.run = null
    clearInterval(run.watchdog)
    run.captioner?.close()
    run.handlers.onStatus('idle')
    if (!run.finishing) await this.closeMic()
  }

  private closeMic(): Promise<void> {
    return this.micControl(false).catch(err => console.warn('[voice] mic close failed:', err))
  }

  /** Serialize close/open across runs. A missing BLE reply must release the queue. */
  private micControl(open: boolean): Promise<void> {
    this.micWanted = open
    const call = this.micQueue.then(async () => {
      let expired = false
      const native = this.bridge.audioControl(open).then(() => {
        // A timed-out command may still reach the glasses after a newer one.
        if (expired && this.micWanted !== open) {
          void this.micControl(this.micWanted).catch(err => console.warn('[voice] mic recovery failed:', err))
        }
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          native,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              expired = true
              reject(new Error('The glasses mic did not answer in time.'))
            }, MIC_TIMEOUT_MS)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    })
    this.micQueue = call.catch(() => {})
    return call
  }
}
