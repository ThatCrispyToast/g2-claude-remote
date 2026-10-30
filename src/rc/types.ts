// Shared types — the contract between the bridge (server/claude_remote_bridge/
// bridge.py) and the app. These mirror the bridge's camelCase JSON EXACTLY; keep
// them in lockstep.

export type SessionStatus = 'active' | 'archived' | string
export type WorkerStatus = 'idle' | 'running' | 'requires_action' | string
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | string
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
/** Effort levels settable remotely; null = auto (the model default). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Decision = 'allow' | 'deny'

/** A model offered in the Compose → Model submenu. */
export interface ModelChoice {
  id: string
  label: string
}

/** An effort level offered in the Compose → Effort submenu (null id = auto). */
export interface EffortChoice {
  id: EffortLevel | null
  label: string
}

/** A one-tap canned message from the Compose menu. */
export interface QuickSend {
  label: string
  text: string
}

/**
 * A slash command the wearer can fire from the Compose → Commands submenu (glasses)
 * or the panel's `/` autocomplete. Sent to the worker as a plain `/name` message —
 * remote-control workers execute slash commands locally at zero cost (the same
 * mechanism the effort control's fallback relies on), so no dedicated bridge route
 * is needed.
 */
export interface SlashCommand {
  /** The command name WITHOUT the leading slash, e.g. `compact`. */
  name: string
  /** Display label, e.g. `Compact context`. */
  label: string
  /** One-line description for the panel autocomplete row. */
  hint?: string
  /** Takes a free-text argument: the panel fills `/name ` and waits for typed
   *  input instead of sending on pick. Ignored on the glasses (fired bare). */
  takesArg?: boolean
  /** Heavy or destructive → don't fire on a single interaction. Glasses route it
   *  through the confirm screen; the panel fills the box and waits for Send. */
  confirm?: boolean
}

/** How full a session's context window is (from the session's metadata). */
export interface ContextUsage {
  usedTokens: number
  maxTokens: number
  percent: number
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
  /** Always null in practice: the session object has no permission mode — the
   *  live one comes from the event stream (`RcEvent.workerState`). */
  permissionMode: PermissionMode | null
  lastEventAt: string | null
  unread: boolean
  userMessageCount: number
  pendingAction: unknown | null // external_metadata.pending_action (permission summary)
  /** The worker's current effort level (absent on older workers). */
  effort: EffortLevel | string | null
  context: ContextUsage | null
  /** The server's one-line post-turn summary of where the session stands. */
  summary: string | null
  /** What it is waiting on you for, when it is. */
  needsAction: string | null
  /** The worker's Claude Code version. */
  ccVersion: string | null
}

/** The worker's live settings, from a `system/init` or `system/status` event
 *  (workers re-emit init on every model / mode / effort change). */
export interface WorkerState {
  model: string | null
  effort: EffortLevel | string | null
  permissionMode: PermissionMode | string | null
  ccVersion: string | null
}

/** A running background task (a backgrounded shell command, a Monitor…). */
export interface BackgroundTask {
  id: string
  type: string | null
  description: string
}

/** One side-question exchange — the history sent along with a follow-up. */
export interface AsideTurn {
  question: string
  response: string
}

/** What GET …/info asks the worker for; each part is null when it didn't answer. */
export interface SessionInfo {
  usage: {
    /** The plan's usage windows: `session` (5-hour), `weekly_all`, and
     *  `weekly_scoped` (one model's own weekly cap — `model` names it). */
    limits: { kind: string; percent: number | null; resetsAt: string | null; model: string | null }[]
    costUsd: number | null
  } | null
  /** Uncommitted git changes; null outside a git repo. */
  diff: { files: number; added: number; removed: number } | null
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

/** One question inside a blocking question (AskUserQuestion / `request_user_dialog`). */
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
 *  - a QUESTION — AskUserQuestion (a `can_use_tool` whose input holds the
 *    questions) or a `request_user_dialog` — answered by picking option(s);
 *    `dialogKind` + `questions` (or a plain `prompt`) describe what is asked.
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
  type: 'user' | 'assistant' | 'system' | 'result' | 'control_request' | 'control_response' | 'conversation_reset' | 'stream_event' | string | null
  subtype: string | null
  role: 'user' | 'assistant' | null
  /** 'client' = a controller wrote it (this app, claude.ai…); 'worker' = Claude Code. */
  source: 'client' | 'worker' | string | null
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
  /** On `system/init` / `system/status`: the worker's settings as of this event. */
  workerState: WorkerState | null
  /** On `system/background_tasks_changed`: the whole running background set. */
  tasks: BackgroundTask[] | null
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
  /** Set the reasoning effort; null clears back to auto (the model default).
   *  Resolves to how it was applied: 'control' (session-scoped) or 'command'
   *  (the /effort fallback, which also saves it as the host's default). */
  setEffort(sid: string, effort: EffortLevel | null): Promise<string>
  archive(sid: string): Promise<void>
  /** Ask a side question ("btw"): answered from the conversation without
   *  interrupting it or adding to it. Null = nothing to answer from yet. */
  ask(sid: string, question: string, history: AsideTurn[]): Promise<string | null>
  /** Plan usage + uncommitted git changes, asked of the worker. */
  info(sid: string): Promise<SessionInfo>
  stopTask(sid: string, taskId: string): Promise<void>
}
