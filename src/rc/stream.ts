// SSE stream wrapper around the bridge's GET …/stream endpoint.
//
// `EventSource` can't set an Authorization header, so the token rides as a
// `?token=` query param (the bridge accepts either). The bridge frames each
// event as `id: <seq>\ndata: <RcEvent JSON>` and signals mid-stream failure with
// a named `event: error` frame (which carries `.data`) — distinct from a
// transport blip (a native 'error' Event with no `.data`, which the browser
// auto-reconnects from via `retry:` + `Last-Event-ID`).

import { RECONNECT_MAX_ATTEMPTS } from '../config'
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
  let es: EventSource | null = null
  let closed = false
  // Consecutive transport-level errors (no .data). EventSource auto-reconnects
  // on these; we count them so a bridge that's truly gone doesn't churn forever.
  let transportErrors = 0

  const close = (): void => {
    if (closed) return
    closed = true
    es?.close()
    es = null
  }

  const qs = new URLSearchParams({ from_seq: String(fromSeq) })
  if (token) qs.set('token', token)
  es = new EventSource(`${streamUrl}?${qs.toString()}`)

  es.onopen = () => {
    transportErrors = 0
    handlers.onOpen?.()
  }

  es.onmessage = (ev: MessageEvent) => {
    if (!ev.data) return
    try {
      handlers.onEvent(JSON.parse(ev.data) as RcEvent)
    } catch {
      /* ignore an unparseable frame rather than tear down the stream */
    }
  }

  // A named `event: error` frame (has .data) is an app error the bridge sent
  // right before closing — surface it and stop (don't let EventSource loop on a
  // dead/inactive session). A bare transport error (no .data) is a blip the
  // browser will auto-reconnect; leave it alone.
  es.addEventListener('error', (ev: Event) => {
    const data = (ev as MessageEvent).data
    if (!data) {
      // Transport blip — the browser auto-reconnects (retry: + Last-Event-ID).
      // But if it never re-opens, stop churning and surface it to the caller.
      transportErrors += 1
      if (transportErrors > RECONNECT_MAX_ATTEMPTS) {
        close()
        handlers.onError(new BridgeError('stream unreachable', 0))
      }
      return
    }
    let err: BridgeError
    try {
      const o = JSON.parse(data)
      err = new BridgeError(String(o.error ?? 'stream error'), Number(o.status) || 500)
    } catch {
      err = new BridgeError('stream error', 500)
    }
    close()
    handlers.onError(err)
  })

  return close
}
