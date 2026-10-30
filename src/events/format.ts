// Turning an RcEvent into what the wearer actually reads on the HUD.
//
// The bridge streams a superset of the claude-rc web event shape; most of it is
// noise on a 576×288 display (partial stream deltas, tool_result echoes, control
// responses). `renderEventParts` distills each event to a few glanceable lines
// plus its tool-chain entries, or nothing at all to drop it from the log.
// `EventLog` (log.ts) owns the dedupe/windowing, the blank line BETWEEN events so
// turns don't blur together, and the chaining of consecutive tool runs; this file
// is pure, per-event formatting.
//
// Readability is the whole game on a tiny monochrome HUD: assistant text arrives
// as Markdown (headings, **bold**, `code`, bullet dashes, fences) which is pure
// visual noise at this size, so `cleanProse` strips the syntax and keeps the
// words. Every line gets a single, consistent leading glyph so the eye can scan
// the left edge — `»` you, plain text = assistant, `◆` a tool, `◇` a result,
// `☉` a system line, `!` a question/permission.

import type { RcEvent, ToolUse, WorkerState } from '../rc/types'
import { clip, HUD } from '../glasses'
import { TOOL_ARG_CHARS, HUD_CHARS_PER_ROW } from '../config'

/** A trimmed string field, or '' if absent/blank/not a string. */
function str(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

/**
 * Strip Markdown syntax that is pure noise on the HUD while keeping the prose.
 * Not a full parser — just the common markers: fenced code, headings, emphasis,
 * inline code, blockquotes, list bullets (→ the safe `·`), and link syntax.
 */
export function cleanProse(text: string): string {
  return (
    text
      // ANSI color/style codes leak through command output; the ESC char is an
      // unsupported glyph (silently skipped) so without this the HUD shows the
      // bare `[1m` / `[22m` remnants.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b?\[[0-9;]*m/g, '')
      // Fenced code blocks → keep the code, drop the ``` fences.
      .replace(/```[^\n]*\n?/g, '')
      .replace(/`([^`]+)`/g, '$1') // inline code
      // Headings: drop the leading #'s but keep the title text.
      .replace(/^#{1,6}[ \t]+/gm, '')
      // Bold / italic markers (leave lone *'s inside words alone-ish).
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      // Blockquote markers.
      .replace(/^[ \t]*>[ \t]?/gm, '')
      // List bullets → a supported middle dot.
      .replace(/^[ \t]*[-*+][ \t]+/gm, `${HUD.SEP} `)
      // Markdown links [label](url) → label.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Collapse runs of blank lines and trailing spaces.
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * Local slash-command echoes arrive as user messages wrapped in XML-ish tags
 * (`<command-name>`, `<command-args>`, `<local-command-stdout>`) — raw tag soup
 * otherwise. Keep the gist: the command line, or the stdout's inner text. The
 * `<local-command-caveat>` block is addressed to the MODEL ("DO NOT respond to
 * these messages…"), never the reader, so it's stripped first; an event that was
 * only the caveat cleans to '' and is dropped from the log. Shared by the HUD
 * (`renderEventParts`) and the panel (`ui.ts`) so both render command echoes
 * the same.
 */
export function cleanUserEcho(text: string): string {
  const stripped = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '').trim()
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(stripped)?.[1]
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(stripped)?.[1] ?? ''
    return `${cmd} ${args}`.trim()
  }
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(stripped)?.[1]
  if (stdout != null) return stdout.trim()
  return stripped
}

// ─── Tool chains ─────────────────────────────────────────────────────────────
// A turn is mostly tool_uses: measured across live sessions, ~6 tool calls per
// line of assistant prose, in runs of up to 27. One `◆ Name  <input>` line each
// buried the narration — a single long file path or shell command wrapped to 4
// of the 6 live rows, so the HUD showed two tool calls and nothing about what
// Claude was actually doing. Instead every tool is squeezed to a `Name arg`
// ENTRY, and a run of them is packed into one-row `◆ a, b, c` chain lines
// (EventLog owns the run detection; this file owns the squeezing + packing).

/** Words that WRAP the real command (`sudo systemctl restart`): drop the word
 *  and keep reading the SAME segment. */
const PREFIX_HEADS = new Set(['sudo', 'time', 'env', 'nohup', 'exec', 'command', 'stdbuf'])
/** Commands whose whole segment is plumbing (`cd ~/x && cargo test` is a cargo
 *  test, not a cd): skip the segment and look at the next one. */
const PLUMBING_HEADS = new Set(['cd', 'source', 'export', 'set', 'pushd', 'popd', '.'])
/** Programs whose SUBCOMMAND carries the meaning (`git status`, `npm run`). */
const SUBCOMMAND_HEADS = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'cargo', 'uv', 'uvx', 'pip', 'apt', 'nix',
  'docker', 'systemctl', 'journalctl', 'python', 'python3', 'node', 'go', 'make',
])

/** Last path segment of `p` (`/a/b/c.py` → `c.py`). */
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const cut = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return cut || trimmed
}

/** A bare program name — anything else (`x)`, `$(cat`, `2>&1`) is shrapnel from
 *  splitting a command we didn't fully parse, and must never reach the HUD. */
const PLAUSIBLE_PROGRAM = /^[\w.@+-]+$/
/** A leading `VAR=value` environment assignment, which prefixes the real command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * A shell command → the program that actually matters, e.g. `cargo test`.
 *
 * Splits on `&&` / `||` / `;` (NOT a single `|` — a pipeline's head is its
 * point) and takes the first segment that names a real program: wrappers and
 * leading `VAR=` assignments are peeled, plumbing segments are skipped, so
 * `TOK=$(cat secret) && curl …` reads `curl`, not `TOK=$(cat`. A multiplexer
 * keeps its subcommand. Returns '' when nothing parses cleanly — the entry is
 * then just the tool name, which is both honest and foldable into `xN`.
 */
function squeezeCommand(cmd: string): string {
  for (const segment of cmd.split(/&&|\|\||;/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean)
    // Peel `FOO=1 sudo …` down to the command being wrapped.
    while (words.length > 0 && (ASSIGNMENT.test(words[0]) || PREFIX_HEADS.has(basename(words[0])))) {
      words.shift()
    }
    const head = basename(words[0] ?? '')
    // A leading flag means we lost the thread (`sudo -u x cmd`) — better to say
    // nothing than to name the wrong thing.
    if (!head || head.startsWith('-') || !PLAUSIBLE_PROGRAM.test(head) || PLUMBING_HEADS.has(head)) continue
    const sub = words[1] ?? ''
    // A flag is not a subcommand: `git -C /repo status` must not read `git -C`.
    if (SUBCOMMAND_HEADS.has(head) && !sub.startsWith('-') && PLAUSIBLE_PROGRAM.test(sub)) {
      return `${head} ${basename(sub)}`
    }
    return head
  }
  return ''
}

/**
 * The one CRISP identifier for a tool call: a command's program, a path's
 * basename, a search pattern, a URL's host. Prose-y inputs (`description`,
 * `prompt`, `query`) are deliberately IGNORED — they blow the row width, and
 * being different on every call they stop a repeated tool from folding into
 * `xN`, which is where most of the space is won.
 */
function toolChainArg(input: Record<string, unknown> | null): string {
  if (!input) return ''
  const cmd = str(input.command)
  if (cmd) return squeezeCommand(cmd)
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path)
  if (path) return basename(path)
  const pattern = str(input.pattern)
  if (pattern) return pattern
  const url = str(input.url)
  if (url) return url.replace(/^\w+:\/\//, '').split('/')[0]
  return ''
}

/** One tool_use → a chain entry: `Read factory.py`, `Bash cargo test`, `TaskCreate`. */
export function toolChainEntry(t: ToolUse): string {
  const name = t.name ?? 'tool'
  const arg = clip(toolChainArg(t.input), TOOL_ARG_CHARS, HUD.ELL)
  return arg ? `${name} ${arg}` : name
}

/**
 * Pack chain entries into `◆ `-led lines, each within one estimated HUD row.
 * Consecutive identical entries fold into `entry xN` (ASCII `x` — `×` is not in
 * the firmware font), which is the single biggest win: a tool fired in a tight
 * loop is the common case, and `TaskCreate x5` costs one row instead of five.
 * Lines are never left-truncated — `EventLog.tailRows` fills from the newest
 * backward, so the live edge is shown and older chain rows just scroll off.
 */
export function packToolChain(entries: string[]): string[] {
  // Fold runs of the same entry into `entry xN`.
  const parts: string[] = []
  let runEntry = ''
  let runCount = 0
  const flushRun = (): void => {
    if (runCount > 0) parts.push(runCount > 1 ? `${runEntry} x${runCount}` : runEntry)
  }
  for (const entry of entries) {
    if (runCount > 0 && entry === runEntry) {
      runCount++
      continue
    }
    flushRun()
    runEntry = entry
    runCount = 1
  }
  flushRun()

  const lines: string[] = []
  const lead = `${HUD.TOOL} `
  let cur = ''
  for (const part of parts) {
    const joined = cur ? `${cur}, ${part}` : part
    if (cur && lead.length + joined.length > HUD_CHARS_PER_ROW) {
      lines.push(lead + cur)
      cur = part
    } else {
      cur = joined
    }
  }
  if (cur) lines.push(lead + cur)
  return lines
}

/** Cost/turns suffix for a `result` line, e.g. ` · 5 turns · $0.12`, or ''. */
function usageSuffix(e: RcEvent): string {
  const u = e.usage
  if (!u) return ''
  const bits: string[] = []
  if (u.numTurns != null) bits.push(`${u.numTurns} turns`)
  if (u.costUsd != null) bits.push(`$${u.costUsd}`)
  return bits.length ? ` ${HUD.SEP} ${bits.join(` ${HUD.SEP} `)}` : ''
}

/** The one-line question summary for the log (the full prompt lives on-screen). */
function questionSummary(e: RcEvent): string {
  const p = e.permissionRequest
  const q = p?.questions?.[0]
  const gist = q?.question || q?.header || p?.prompt || p?.toolName || 'a question'
  return `${HUD.ATTN} asks: ${clip(gist, 60, HUD.ELL)}`
}

/** What one RcEvent contributes to the log, split so EventLog can merge a RUN
 *  of tool_uses into one chain block while prose stays its own block. */
export interface EventParts {
  /** The event's non-tool lines (prose, result, system…), '' when it has none. */
  text: string
  /** Chain entries for this event's tool_uses, in order; empty when it has none. */
  tools: string[]
}

/** An event that contributes nothing to the log. Shared so the common case
 *  (stream deltas, tool_result echoes) allocates nothing new. */
const NOTHING: EventParts = { text: '', tools: [] }

/**
 * Split ONE RcEvent into its log contributions. `{text:'', tools:[]}` means the
 * event does not appear at all (partial streams, tool_result echoes, control
 * responses…) — and, importantly, that it does NOT interrupt a tool chain: a
 * tool_result lands between every pair of consecutive tool_uses, so treating it
 * as a break would make every chain exactly one tool long.
 */
export function renderEventParts(e: RcEvent): EventParts {
  switch (e.type) {
    case 'assistant':
      // Cleaned prose, then the tools it kicked off (the log keeps that order).
      return { text: cleanProse(e.text), tools: e.toolUses.map(toolChainEntry) }

    case 'user': {
      // The wearer's / echoed sends. A bare tool_result (no text) is HUD noise.
      const text = cleanProse(cleanUserEcho(e.text))
      return text ? { text: `${HUD.USER} ${text}`, tools: [] } : NOTHING
    }

    case 'result': {
      const ok = !(e.usage?.isError ?? false) && e.subtype !== 'error' && !e.subtype?.startsWith('error')
      const head = ok ? `${HUD.DONE} done` : `${HUD.DONE} ${e.subtype ?? 'error'}`
      return { text: `${head}${usageSuffix(e)}`, tools: [] }
    }

    case 'system': {
      // A worker re-posts init on every controller attach and every model / mode
      // / effort change, so it reads as "settings now", not "session started"
      // (that's all an older bridge, with no workerState, can say).
      if (e.subtype === 'init') {
        const line = e.workerState ? settingsLine(e.workerState) : `session started ${HUD.SEP} ${modelShort(e.model)}`
        return { text: `${HUD.SYS} ${line}`, tools: [] }
      }
      if (e.subtype === 'compact_boundary') return { text: `${HUD.SYS} context compacted`, tools: [] }
      return NOTHING
    }

    // EventLog has already dropped what came before; this is the line left behind.
    case 'conversation_reset':
      return { text: `${HUD.SYS} conversation cleared`, tools: [] }

    case 'control_request': {
      // A blocking control — main.ts routes it to the permission or question
      // screen, but it should still read in the log so scrollback shows why the
      // turn paused. Questions and tool-permissions get distinct one-liners.
      if (!e.isBlockingControl) return NOTHING
      if (isQuestionRequest(e)) return { text: questionSummary(e), tools: [] }
      return { text: `${HUD.ATTN} needs you: ${e.permissionRequest?.toolName ?? 'tool'}`, tools: [] }
    }

    // Partial streaming deltas, control responses, and anything else are noise.
    case 'stream_event':
    case 'control_response':
    default:
      return NOTHING
  }
}

/** A blocking control is a QUESTION (dialog) rather than a tool-permission when
 *  its subtype is a dialog, or it carries parsed question options, or it is the
 *  AskUserQuestion tool. Kept here so the HUD log, the panel log and main.ts's
 *  prompt routing all agree. */
export function isQuestionRequest(e: RcEvent): boolean {
  const p = e.permissionRequest
  const sub = p?.subtype ?? e.blockingSubtype ?? ''
  if (sub === 'request_user_dialog') return true
  if (p?.questions && p.questions.length > 0) return true
  const tool = p?.toolName ?? ''
  return tool === 'AskUserQuestion'
}

/** `claude-opus-5-5` → `opus-5-5` (a dated id loses its date); null → '?'. */
export function modelShort(m: string | null | undefined): string {
  if (!m) return '?'
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/** A permission mode, short enough for a HUD header: `bypassPermissions` → `bypass`. */
export function modeShort(mode: string | null | undefined): string {
  if (mode === 'bypassPermissions') return 'bypass'
  if (mode === 'acceptEdits') return 'edits'
  return mode ?? ''
}

/** `opus-5-5 · max effort · bypass` — whatever the worker reported. */
export function settingsLine(ws: WorkerState): string {
  const parts = [modelShort(ws.model)]
  if (ws.effort) parts.push(`${ws.effort} effort`)
  if (ws.permissionMode) parts.push(modeShort(ws.permissionMode))
  return parts.join(` ${HUD.SEP} `)
}
