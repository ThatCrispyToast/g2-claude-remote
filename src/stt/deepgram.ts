// Live streaming speech-to-text via Deepgram, hardened for long sessions.
//
// The G2 mic emits PCM linear16 / 16 kHz / mono — exactly Deepgram's preferred
// streaming format, so chunks are forwarded as-is. Deepgram returns interim
// hypotheses (is_final:false) as you speak and commits segments (is_final:true).
//
// Dictation can span minutes of thinking-out-loud, so unlike a one-shot socket
// this class owns the connection lifecycle:
//   • auto-reconnect with exponential backoff on unexpected closes
//   • mic audio buffered (bounded) while the socket is down
//   • KeepAlive pings so silence never idles the stream out
//
// This is the single-speaker dictation build: no diarization / speaker labels.

import {
  DEEPGRAM_MODEL,
  KEEPALIVE_IDLE_MS,
  PENDING_AUDIO_MAX_BYTES,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  SAMPLE_RATE,
  STOP_FLUSH_TIMEOUT_MS,
  STT_LANGUAGE,
} from '../config'

export type CaptionerStatus = 'connecting' | 'live' | 'reconnecting' | 'stopped'

export interface CaptionerHandlers {
  /** A finalized caption segment — append it to the transcript. */
  onFinal: (text: string) => void
  /** The current volatile hypothesis (`''` clears it). Replaces, not appends. */
  onInterim: (text: string) => void
  /** Connection lifecycle, for status surfaces. */
  onStatus?: (status: CaptionerStatus) => void
  /** Unrecoverable failure (retries exhausted / bad key). Captioner is dead. */
  onFatal?: (message: string) => void
}

interface DgMessage {
  type?: string
  is_final?: boolean
  channel?: { alternatives?: Array<{ transcript?: string }> }
}

export class LiveCaptioner {
  private ws: WebSocket | null = null
  private stopped = false
  /** Consecutive failed connects; reset once a connection proves stable. */
  private attempts = 0
  private everConnected = false
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private lastSendAt = 0
  private keepAliveTimer: number
  private retryTimer: number | null = null
  private stableTimer: number | null = null

  constructor(
    private readonly apiKey: string,
    private readonly handlers: CaptionerHandlers,
  ) {
    this.handlers.onStatus?.('connecting')
    this.connect()
    // Deepgram idles a stream out after ~10 s without data; audio flows
    // continuously while the mic is open, but a KeepAlive covers any gap
    // (mic hiccup, buffering during reconnect).
    this.keepAliveTimer = window.setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      if (performance.now() - this.lastSendAt < KEEPALIVE_IDLE_MS) return
      try {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }))
        this.lastSendAt = performance.now()
      } catch {
        /* socket is closing; reconnect logic handles it */
      }
    }, 2000)
  }

  /** Forward one mic chunk (PCM s16le). Buffered while the socket is down. */
  feed(pcm: Uint8Array): void {
    if (this.stopped) return
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm)
      this.lastSendAt = performance.now()
      return
    }
    // Socket down (connecting or between retries): keep a bounded backlog so
    // a short blip loses no audio; beyond the cap, drop the oldest.
    this.pending.push(pcm.slice())
    this.pendingBytes += pcm.length
    while (this.pendingBytes > PENDING_AUDIO_MAX_BYTES && this.pending.length > 0) {
      this.pendingBytes -= this.pending[0].length
      this.pending.shift()
    }
  }

  /** Graceful stop: flush Deepgram's remaining finals, then close. */
  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this.handlers.onStatus?.('stopped')
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.handlers.onStatus?.('stopped')
        resolve()
      }
      // Finals still arrive between CloseStream and the close event — the
      // message handler stays attached so they reach onFinal.
      const timer = window.setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* already closed */
        }
        done()
      }, STOP_FLUSH_TIMEOUT_MS)
      ws.addEventListener('close', done, { once: true })
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {
        try {
          ws.close()
        } catch {
          /* already closed */
        }
      }
    })
  }

  /** Immediate teardown without waiting for a flush (exit paths). */
  close(): void {
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {
      /* already closed */
    }
  }

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return
    const qs = new URLSearchParams({
      model: DEEPGRAM_MODEL,
      encoding: 'linear16',
      sample_rate: String(SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
    })
    if (STT_LANGUAGE) qs.set('language', STT_LANGUAGE)

    // Browsers can't set an Authorization header on a WebSocket, so Deepgram
    // accepts the key as a `token` subprotocol.
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${qs}`, ['token', this.apiKey])
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.everConnected = true
      for (const chunk of this.pending) ws.send(chunk)
      this.pending = []
      this.pendingBytes = 0
      this.lastSendAt = performance.now()
      // Only call a connection good once it has survived a while — otherwise
      // an open-then-drop loop would reset the backoff and retry forever.
      this.stableTimer = window.setTimeout(() => {
        this.attempts = 0
      }, 15000)
      this.handlers.onStatus?.('live')
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let msg: DgMessage
      try {
        msg = JSON.parse(ev.data) as DgMessage
      } catch {
        return
      }
      if (msg.type !== 'Results') return
      const alt = msg.channel?.alternatives?.[0]
      if (!alt) return
      const text = (alt.transcript ?? '').trim()
      if (msg.is_final) {
        if (text) this.handlers.onFinal(text)
        this.handlers.onInterim('') // window committed (or was phantom) — clear the tail
      } else if (text) {
        this.handlers.onInterim(text)
      }
    }

    ws.onerror = () => {
      // The close event follows with the real disposition; nothing to do here.
    }

    ws.onclose = (ev) => {
      if (this.ws !== ws) return // superseded socket
      this.ws = null
      if (this.stableTimer !== null) {
        clearTimeout(this.stableTimer)
        this.stableTimer = null
      }
      if (this.stopped) return
      this.scheduleReconnect(ev.code)
    }
  }

  private scheduleReconnect(closeCode: number): void {
    // 1008 = policy violation — Deepgram rejecting the request (bad key/params).
    // Retrying can't help.
    if (closeCode === 1008) {
      this.fail('Deepgram rejected the connection — check your API key.')
      return
    }
    this.attempts += 1
    if (this.attempts > RECONNECT_MAX_ATTEMPTS) {
      this.fail(
        this.everConnected
          ? 'Live transcription connection lost and could not be restored.'
          : 'Could not reach Deepgram — check your API key and network.',
      )
      return
    }
    this.handlers.onInterim('') // hypothesis died with the socket
    this.handlers.onStatus?.('reconnecting')
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.attempts - 1),
      RECONNECT_MAX_DELAY_MS,
    )
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private fail(message: string): void {
    this.stopped = true
    this.clearTimers()
    this.handlers.onStatus?.('stopped')
    this.handlers.onFatal?.(message)
  }

  private clearTimers(): void {
    clearInterval(this.keepAliveTimer)
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
  }
}
