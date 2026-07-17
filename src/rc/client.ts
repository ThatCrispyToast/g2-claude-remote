// Typed client for the Claude Remote bridge (server/rc_bridge.py).
//
// Thin fetch wrappers over the bridge's JSON+SSE surface. Every request carries
// the shared bearer token. A non-2xx response becomes a `BridgeError` whose
// `.status === 409` means "session not active" (archived or dead) — the caller
// drops the session and returns to the list.

import { BRIDGE_TOKEN, BRIDGE_URL, HISTORY_LIMIT } from '../config'
import { openEventStream, type StreamHandlers } from './stream'
import {
  BridgeError,
  type ActiveSession,
  type BridgeClient,
  type Decision,
  type DialogAnswer,
  type PermissionMode,
  type RcEvent,
  type WhoAmI,
} from './types'

export class HttpBridgeClient implements BridgeClient {
  constructor(
    private readonly base: string = BRIDGE_URL,
    private readonly token: string = BRIDGE_TOKEN,
  ) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.token) h.Authorization = `Bearer ${this.token}`
    if (json) h['Content-Type'] = 'application/json'
    return h
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await fetch(this.base + path, init)
    } catch (e) {
      // Network-level failure (bridge down / unreachable / CORS).
      throw new BridgeError(`bridge unreachable: ${(e as Error).message}`, 0)
    }
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const err = (data as { error?: unknown })?.error
      const msg = typeof err === 'string' ? err : err ? JSON.stringify(err) : res.statusText || 'request failed'
      throw new BridgeError(msg, res.status)
    }
    return data as T
  }

  private post(path: string, body?: unknown): Promise<{ ok: boolean }> {
    return this.req(path, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body ?? {}),
    })
  }

  private sid(sid: string): string {
    return encodeURIComponent(sid)
  }

  // -- reads -------------------------------------------------------------
  whoami(): Promise<WhoAmI> {
    return this.req<WhoAmI>('/api/whoami', { headers: this.headers() })
  }

  async listActive(): Promise<ActiveSession[]> {
    const { sessions } = await this.req<{ sessions: ActiveSession[] }>('/api/sessions', {
      headers: this.headers(),
    })
    return sessions ?? []
  }

  async getSession(sid: string): Promise<ActiveSession> {
    const { session } = await this.req<{ session: ActiveSession }>(`/api/sessions/${this.sid(sid)}`, {
      headers: this.headers(),
    })
    return session
  }

  async getHistory(sid: string, limit: number = HISTORY_LIMIT): Promise<RcEvent[]> {
    const { events } = await this.req<{ events: RcEvent[] }>(
      `/api/sessions/${this.sid(sid)}/events?limit=${limit}`,
      { headers: this.headers() },
    )
    return events ?? []
  }

  streamEvents(sid: string, fromSeq: number, handlers: StreamHandlers): () => void {
    return openEventStream(`${this.base}/api/sessions/${this.sid(sid)}/stream`, this.token, fromSeq, handlers)
  }

  // -- writes (all 409 if the session went inactive) ---------------------
  async send(sid: string, text: string): Promise<void> {
    await this.post(`/api/sessions/${this.sid(sid)}/send`, { text })
  }

  async answerPermission(
    sid: string,
    p: { requestId: string; toolUseId?: string | null; decision: Decision; message?: string; updatedInput?: unknown },
  ): Promise<void> {
    await this.post(`/api/sessions/${this.sid(sid)}/permission`, {
      request_id: p.requestId,
      tool_use_id: p.toolUseId ?? null,
      decision: p.decision,
      message: p.message,
      updated_input: p.updatedInput,
    })
  }

  async answerDialog(
    sid: string,
    d: {
      requestId: string
      subtype: string
      dialogKind?: string | null
      toolUseId?: string | null
      input?: Record<string, unknown> | null
      status: 'completed' | 'cancelled'
      answers?: DialogAnswer[]
    },
  ): Promise<void> {
    await this.post(`/api/sessions/${this.sid(sid)}/dialog`, {
      request_id: d.requestId,
      subtype: d.subtype,
      dialog_kind: d.dialogKind ?? null,
      tool_use_id: d.toolUseId ?? null,
      input: d.input ?? null,
      status: d.status,
      answers: d.answers,
    })
  }

  async interrupt(sid: string): Promise<void> {
    await this.post(`/api/sessions/${this.sid(sid)}/interrupt`, {})
  }

  async setModel(sid: string, model: string): Promise<void> {
    await this.post(`/api/sessions/${this.sid(sid)}/model`, { model })
  }

  async setPermissionMode(sid: string, mode: PermissionMode): Promise<void> {
    await this.post(`/api/sessions/${this.sid(sid)}/permission_mode`, { mode })
  }

  async archive(sid: string): Promise<void> {
    await this.post(`/api/sessions/${this.sid(sid)}/archive`, {})
  }
}
