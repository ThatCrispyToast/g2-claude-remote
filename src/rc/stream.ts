// SSE stream wrapper around the bridge's GET …/stream endpoint.
//
// `EventSource` can't set an Authorization header, so the token rides as a
// `?token=` query param (the bridge accepts either). The bridge frames each
// event as `id: <seq>\ndata: <RcEvent JSON>` and signals mid-stream failure with
// a named `event: error` frame (which carries `.data`) — distinct from a
// transport blip (a native 'error' Event with no `.data`, which the browser
// auto-reconnects from via `retry:` + `Last-Event-ID`).
//
// Three ways a stream dies without the browser reconnecting it, each handed to
// `onError` so the caller can reopen from its cursor:
//   • the bridge's error frame (it closes the stream after sending one);
//   • a refused open — a non-200 answer (the bridge restarting, a 401, a 502
//     from the API) leaves the EventSource CLOSED for good;
//   • silence — a phone that slept or changed networks can leave the socket
//     half-open, delivering nothing and reporting nothing. The bridge (0.5.0+)
//     passes the API's keepalive through as a `ping` frame about every 15 s, so
//     once one has been heard, STREAM_SILENCE_MS without any frame means dead.
//     An older bridge never pings, and its streams are never judged this way.

import { RECONNECT_MAX_ATTEMPTS, STREAM_SILENCE_MS } from '../config'
import { BridgeError, type RcEvent } from './types'

export interface StreamHandlers {
  onEvent: (e: RcEvent) => void
  onError: (err: BridgeError) => void
  onOpen?: () => void
}

/** Open a live event stream. Returns a close/unsubscribe function. */
export function openEventStream(
  streamUrl: string,
  token: string,
  fromSeq: number,
  handlers: StreamHandlers,
): () => void {
  let closed = false
  // Consecutive transport-level errors (no .data). EventSource auto-reconnects
  // on these; we count them so a bridge that's truly gone doesn't churn forever.
  let transportErrors = 0
  // When the last frame (event or ping) arrived; 0 until the bridge has pinged.
  let heardAt = 0

  const qs = new URLSearchParams({ from_seq: String(fromSeq) })
  if (token) qs.set('token', token)
  const es = new EventSource(`${streamUrl}?${qs.toString()}`)

  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(watchdog)
    es.close()
  }
  const fail = (err: BridgeError): void => {
    if (closed) return
    close()
    handlers.onError(err)
  }

  const watchdog = setInterval(() => {
    if (heardAt && performance.now() - heardAt > STREAM_SILENCE_MS) fail(new BridgeError('stream went silent', 0))
  }, 5000)

  es.onopen = () => {
    transportErrors = 0
    handlers.onOpen?.()
  }

  es.addEventListener('ping', () => {
    heardAt = performance.now()
  })

  es.onmessage = (ev: MessageEvent) => {
    if (heardAt) heardAt = performance.now()
    if (!ev.data) return
    try {
      handlers.onEvent(JSON.parse(ev.data) as RcEvent)
    } catch {
      /* ignore an unparseable frame rather than tear down the stream */
    }
  }

  es.addEventListener('error', (ev: Event) => {
    const data = (ev as MessageEvent).data
    if (data) {
      // The bridge's own error frame, sent right before it closes the stream.
      let err: BridgeError
      try {
        const o = JSON.parse(data)
        err = new BridgeError(String(o.error ?? 'stream error'), Number(o.status) || 500)
      } catch {
        err = new BridgeError('stream error', 500)
      }
      fail(err)
      return
    }
    // A refused open: the browser has given up on this EventSource.
    if (es.readyState === EventSource.CLOSED) {
      fail(new BridgeError('stream refused', 0))
      return
    }
    // A transport blip — the browser auto-reconnects (retry: + Last-Event-ID).
    // The silence clock restarts with it, so a slow reconnect isn't cut short;
    // if it never re-opens, stop churning and surface it to the caller.
    if (heardAt) heardAt = performance.now()
    transportErrors += 1
    if (transportErrors > RECONNECT_MAX_ATTEMPTS) fail(new BridgeError('stream unreachable', 0))
  })

  return close
}
