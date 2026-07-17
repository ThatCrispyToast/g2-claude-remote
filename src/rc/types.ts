// Shared types — the contract between the bridge (server/rc_bridge.py) and the
// app. These mirror the bridge's camelCase JSON EXACTLY; keep them in lockstep.

export type SessionStatus = 'active' | 'archived' | string
export type WorkerStatus = 'idle' | 'running' | 'requires_action' | string
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | string
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
export type Decision = 'allow' | 'deny'

/** A model offered in the Compose → Model submenu. */
export interface ModelChoice {
  id: string
  label: string
}

/** A one-tap canned message from the Compose menu. */
export interface QuickSend {
  label: string
  text: string
}

/**
 * A session as the bridge returns it — ALREADY guaranteed active+connected by
 * the server-side filter (GET /api/sessions never returns archived or dead ones).
 */
export interface ActiveSession {
  id: string
  title: string
  status: SessionStatus // always 'active' from the bridge
  workerStatus: WorkerStatus // idle | running | requires_action
  connectionStatus: ConnectionStatus // always 'connected' from the bridge
  statusBucket: string | null
  model: string | null
  permissionMode: PermissionMode | null
  lastEventAt: string | null
  unread: boolean
  userMessageCount: number
  pendingAction: unknown | null // external_metadata.pending_action (permission summary)
}

/** A tool_use content block. */
export interface ToolUse {
  name: string | null
  input: Record<string, unknown> | null
  id: string | null
}

/** One selectable option in a dialog question (the AskUserQuestion shape). */
export interface DialogOption {
  label: string
  description: string
}

/** One question inside a `request_user_dialog` / `side_question` blocking control. */
export interface DialogQuestion {
  header: string
  question: string
  multiSelect: boolean
  options: DialogOption[]
}

/**
 * The details out of a blocking control request. Covers BOTH flavors:
 *  - a tool-permission (`subtype: "can_use_tool"`) — answered allow/deny; the
 *    tool + its `input` describe what Claude wants to run.
 *  - a QUESTION (`subtype: "request_user_dialog"` | `"side_question"`) — answered
 *    by picking option(s); `dialogKind` + `questions` (or a plain `prompt`)
 *    describe what Claude is asking. `toolName`/`input` are usually null here.
 */
export interface PermissionRequest {
  subtype: string | null
  toolName: string | null
  toolUseId: string | null
  input: Record<string, unknown> | null
  suggestions: unknown | null
  dialogKind: string | null // request_user_dialog `dialog_kind`, else null
  questions: DialogQuestion[] // parsed question(s)+options (empty for tool perms)
  prompt: string | null // a plain confirm dialog's message, when there are no questions
  raw: Record<string, unknown>
}

/** One answered question, sent back to resolve a dialog. `options` = chosen labels. */
export interface DialogAnswer {
  header: string
  question: string
  options: string[]
}

/** Usage/cost, present on `result` events. */
export interface Usage {
  costUsd: number | null
  numTurns: number | null
  durationMs: number | null
  isError: boolean
}

/**
 * One event, flattened + enriched by the bridge (superset of the claude-rc web
 * event shape, in camelCase). `requestId`/`toolUseId`/`permissionRequest` are the
 * bridge's additions, needed to answer permission prompts.
 */
export interface RcEvent {
  type: 'user' | 'assistant' | 'system' | 'result' | 'control_request' | 'control_response' | 'stream_event' | string | null
  subtype: string | null
  role: 'user' | 'assistant' | null
  text: string
  toolUses: ToolUse[]
  sequenceNum: number | null
  id: string | null
  timestamp: string | null
  model: string | null
  isTurnEnd: boolean
  isTerminal: boolean
  isBlockingControl: boolean
  blockingSubtype: string | null
  requestId: string | null
  toolUseId: string | null
  permissionRequest: PermissionRequest | null
  usage: Usage | null
}

/** Login/token status from GET /api/whoami. */
export interface WhoAmI {
  logged_in: boolean
  expired?: boolean
  scopes?: string[]
  subscription?: string | null
  org_uuid_present?: boolean
  token_len?: number
  error?: string
}

/** A typed bridge error (`{error, status}`); status 409 = session not active. */
export class BridgeError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'BridgeError'
    this.status = status
  }
  get isInactive(): boolean {
    return this.status === 409
  }
}

/** The client's view of the bridge, implemented in rc/client.ts. */
export interface BridgeClient {
  whoami(): Promise<WhoAmI>
  listActive(): Promise<ActiveSession[]>
  getSession(sid: string): Promise<ActiveSession>
  getHistory(sid: string, limit?: number): Promise<RcEvent[]>
  /** Open the live SSE stream. Returns an unsubscribe fn. */
  streamEvents(
    sid: string,
    fromSeq: number,
    handlers: { onEvent: (e: RcEvent) => void; onError: (err: BridgeError) => void; onOpen?: () => void },
  ): () => void
  send(sid: string, text: string): Promise<void>
  answerPermission(
    sid: string,
    p: { requestId: string; toolUseId?: string | null; decision: Decision; message?: string; updatedInput?: unknown },
  ): Promise<void>
  /** Answer a blocking question. AskUserQuestion arrives as a `can_use_tool`
   *  permission, so `toolUseId` + the original `input` are passed through so the
   *  bridge can answer it on the permission path (allow + updatedInput.answers). */
  answerDialog(
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
  ): Promise<void>
  interrupt(sid: string): Promise<void>
  setModel(sid: string, model: string): Promise<void>
  setPermissionMode(sid: string, mode: PermissionMode): Promise<void>
  archive(sid: string): Promise<void>
}
