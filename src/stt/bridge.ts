// Each operation has one sequence number and an immutable body. The bridge
// can return its previous acknowledgement when a reply is lost on the phone.
import { currentBridge, SAMPLE_RATE } from '../config'
import type { CaptionerHandlers } from './deepgram'

const POST_INTERVAL_MS = 1000
const POST_TIMEOUT_MS = 20000
const MAX_ATTEMPTS = 4
const MAX_BUFFER_BYTES = 60 * SAMPLE_RATE * 2

interface StartReply { id: string; protocol: number; model: string }
interface SttReply { seq: number; final: string[]; interim: string; model: string }

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export class BridgeCaptioner {
  private readonly bridge = currentBridge()
  private readonly ready: Promise<void>
  private readonly timer: number
  private id = ''
  private seq = 0
  private model = ''
  private chunks: Uint8Array<ArrayBuffer>[] = []
  private bytes = 0
  private inFlight: Promise<void> | null = null
  private activeRequest: AbortController | null = null
  private finishing = false
  private closed = false
  private error: Error | null = null

  constructor(private readonly handlers: CaptionerHandlers) {
    handlers.onStatus?.('connecting')
    this.timer = window.setInterval(() => this.flush(), POST_INTERVAL_MS)
    this.ready = this.start().catch((err: Error) => this.fail(err))
  }

  private async start(): Promise<void> {
    const r = await this.call<StartReply>('/api/stt/start', '{}')
    if (!r || !/^[0-9a-f]{16}$/.test(r.id)) throw new Error('Invalid dictation ID from bridge.')
    this.id = r.id
    if (this.closed) { this.cancelRemote(); return }
    if (r.protocol !== 1) throw new Error('Update the bridge for local dictation.')
    this.noteModel(r.model)
  }

  feed(pcm: Uint8Array): void {
    if (this.closed || this.finishing || this.error || this.model === 'downloading' || !pcm.length) return
    if (this.bytes + pcm.length > MAX_BUFFER_BYTES) {
      this.fail(new Error('The bridge could not keep up with the microphone.'))
      return
    }
    this.chunks.push(pcm.slice())
    this.bytes += pcm.length
  }

  private take(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.bytes)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []
    this.bytes = 0
    return out
  }

  private flush(): void {
    if (!this.id || this.closed || this.finishing || this.error || this.inFlight) return
    if (!this.bytes && this.model === 'ready') return
    this.inFlight = this.post('audio', this.take())
      .catch((err: Error) => this.fail(err))
      .finally(() => { this.inFlight = null })
  }

  async stop(): Promise<void> {
    this.finishing = true
    clearInterval(this.timer)
    try {
      await this.ready
      await this.inFlight
      if (this.error) throw this.error
      if (!this.closed) await this.post('finish', this.take())
    } finally {
      this.close()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.chunks = []
    this.bytes = 0
    this.activeRequest?.abort()
    this.cancelRemote()
  }

  private cancelRemote(): void {
    if (this.id) void this.call('/api/stt/' + this.id + '/cancel', new Uint8Array()).catch(() => {})
  }

  private async post(action: 'audio' | 'finish', bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const path = `/api/stt/${this.id}/${action}?seq=${this.seq}`
    for (let attempt = 1; !this.closed && !this.error; attempt++) {
      const controller = new AbortController()
      this.activeRequest = controller
      let reply: SttReply
      try {
        reply = await this.call<SttReply>(path, bytes, controller)
      } catch (err) {
        if (this.closed || this.error) return
        if (attempt === MAX_ATTEMPTS || (err instanceof RequestError && err.status < 500)) throw err
        if (!this.finishing) this.handlers.onStatus?.('reconnecting')
        await new Promise(resolve => setTimeout(resolve, POST_INTERVAL_MS))
        continue
      } finally {
        this.activeRequest = null
      }
      if (this.closed || this.error) return
      if (reply?.seq !== this.seq || !Array.isArray(reply.final) ||
          !reply.final.every(t => typeof t === 'string') || typeof reply.interim !== 'string') {
        throw new Error('Invalid dictation acknowledgement from bridge.')
      }
      this.noteModel(reply.model)
      this.seq++
      for (const text of reply.final) if (text) this.handlers.onFinal(text)
      this.handlers.onInterim(reply.interim)
      return
    }
  }

  private noteModel(model: string): void {
    if (!['ready', 'loading', 'downloading'].includes(model)) throw new Error('The dictation model is unavailable.')
    this.model = model
    if (model === 'downloading') { this.chunks = []; this.bytes = 0 }
    if (!this.finishing) this.handlers.onStatus?.(model === 'ready' ? 'live' : model === 'loading' ? 'connecting' : 'downloading model')
  }

  private async call<T>(path: string, body: string | Uint8Array<ArrayBuffer>, controller = new AbortController()): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' }
    if (this.bridge.token) headers.Authorization = `Bearer ${this.bridge.token}`
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
    try {
      const res = await fetch(this.bridge.url + path, { method: 'POST', headers, body, signal: controller.signal })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new RequestError(data?.error || `Bridge dictation failed (${res.status}).`, res.status)
      }
      return await res.json() as T
    } catch (err) {
      if (controller.signal.aborted) throw new Error('The bridge did not answer in time.')
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(error: Error): void {
    if (this.closed || this.error) return
    this.error = error
    this.close()
    this.handlers.onFatal?.(error.message)
  }
}
