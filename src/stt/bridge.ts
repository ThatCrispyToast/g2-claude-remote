// Dictation transcribed by the bridge (its `local-stt` extra: Whisper on the
// bridge host), the alternative to Deepgram when no key is set.
//
// Mic audio is batched and posted every `POST_INTERVAL_MS`. Each reply carries
// the bridge's current reading of the uncommitted audio (`interim`) and any
// text it has committed (`final`). Posts go one at a time, so audio that
// arrives while one is out rides the next. A failed post keeps its audio for
// the next one; `MAX_FAILURES` in a row end the dictation.

import { currentBridge, currentSttLanguage } from '../config'
import type { CaptionerHandlers } from './deepgram'

const POST_INTERVAL_MS = 1000
const MAX_FAILURES = 4
/** Audio passes can queue behind the model loading (a second or two). */
const POST_TIMEOUT_MS = 20000

interface SttReply {
  final?: string[]
  interim?: string
  /** The bridge's model: `downloading` (first use) or `loading` keep the
   *  audio until it is `ready`. */
  model?: string
}

export class BridgeCaptioner {
  private id: Promise<string | null>
  private pending: Uint8Array<ArrayBuffer>[] = []
  private inFlight: Promise<void> | null = null
  private failures = 0
  private stopped = false
  /** The bridge is downloading its model: no audio goes, only polls. */
  private downloading = false
  private timer: number

  constructor(private readonly handlers: CaptionerHandlers) {
    this.handlers.onStatus?.('connecting')
    this.id = this.call<{ id: string; model?: string }>('/api/stt/start', JSON.stringify({ language: currentSttLanguage() }), 'application/json')
      .then((r) => {
        this.noteModel(r.model)
        return r.id
      })
      .catch((err: Error) => {
        this.fail(err.message)
        return null
      })
    this.timer = window.setInterval(() => void this.flush(), POST_INTERVAL_MS)
  }

  /** Queue one mic chunk (PCM s16le) for the next post. */
  feed(pcm: Uint8Array): void {
    if (!this.stopped) this.pending.push(pcm.slice())
  }

  /** Send the remaining audio and wait for the last of the text. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.timer)
    await this.inFlight
    const id = await this.id
    if (id) {
      try {
        this.deliver(await this.call<SttReply>(`/api/stt/${id}/finish`, this.take()))
      } catch (err) {
        console.error('[voice] bridge finish failed:', err)
      }
    }
    this.handlers.onInterim('')
    this.handlers.onStatus?.('stopped')
  }

  /** Drop the dictation without waiting for its text. */
  close(): void {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.timer)
    this.pending = []
    void this.id.then((id) => id && this.call(`/api/stt/${id}/cancel`, new Uint8Array()).catch(() => {}))
  }

  private async flush(): Promise<void> {
    // While the model downloads, dictation hasn't started: drop the audio,
    // and just ask once a tick whether the model is ready.
    if (this.downloading) this.pending = []
    if (this.inFlight || this.stopped || (this.pending.length === 0 && !this.downloading)) return
    const id = await this.id
    if (!id || this.stopped || this.inFlight) return
    const audio = this.take()
    this.inFlight = (async () => {
      try {
        this.deliver(await this.call<SttReply>(`/api/stt/${id}/audio`, audio))
        this.failures = 0
      } catch (err) {
        this.pending.unshift(audio) // goes out with the next post
        this.failures += 1
        if (this.failures >= MAX_FAILURES) this.fail((err as Error).message)
      } finally {
        this.inFlight = null
      }
    })()
  }

  private take(): Uint8Array<ArrayBuffer> {
    const size = this.pending.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(size)
    let at = 0
    for (const chunk of this.pending) {
      out.set(chunk, at)
      at += chunk.length
    }
    this.pending = []
    return out
  }

  private deliver(reply: SttReply): void {
    this.noteModel(reply.model)
    for (const text of reply.final ?? []) if (text) this.handlers.onFinal(text)
    this.handlers.onInterim(reply.interim ?? '')
  }

  /** Live once the model is up; until then, say whether it is downloading
   *  (no audio is sent meanwhile). An older bridge sends no `model` and is
   *  taken as ready. */
  private noteModel(model: string | undefined): void {
    this.downloading = model === 'downloading'
    if (this.stopped) return
    this.handlers.onStatus?.(model === 'downloading' ? 'downloading model' : model === 'loading' ? 'connecting' : 'live')
  }

  private async call<T>(path: string, body: BodyInit, type = 'application/octet-stream'): Promise<T> {
    const { url, token } = currentBridge()
    const headers: Record<string, string> = { 'Content-Type': type }
    if (token) headers.Authorization = `Bearer ${token}`
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), POST_TIMEOUT_MS)
    try {
      const res = await fetch(url.replace(/\/+$/, '') + path, { method: 'POST', headers, body, signal: abort.signal })
      const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
      if (!res.ok) throw new Error(data?.error || `bridge dictation failed (${res.status})`)
      return data as T
    } catch (err) {
      if (abort.signal.aborted) throw new Error('The bridge did not answer in time.')
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(message: string): void {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.timer)
    this.handlers.onStatus?.('stopped')
    this.handlers.onFatal?.(message)
  }
}
