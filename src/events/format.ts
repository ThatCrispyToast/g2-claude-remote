// Turning an RcEvent into what the wearer actually reads on the HUD.
//
// The bridge streams a superset of the claude-rc web event shape; most of it is
// noise on a 576×288 display (partial stream deltas, tool_result echoes, control
// responses). `renderEvent` distills each event to a few glanceable lines, or ''
// to drop it from the log entirely. `EventLog` (log.ts) owns the dedupe/windowing
// (and inserts a blank line BETWEEN events so turns don't blur together); this
// file is pure, per-event formatting.
//
// Readability is the whole game on a tiny monochrome HUD: assistant text arrives
// as Markdown (headings, **bold**, `code`, bullet dashes, fences) which is pure
// visual noise at this size, so `cleanProse` strips the syntax and keeps the
// words. Every line gets a single, consistent leading glyph so the eye can scan
// the left edge — `»` you, plain text = assistant, `◆` a tool, `◇` a result,
// `☉` a system line, `!` a question/permission.

import type { RcEvent, ToolUse } from '../rc/types'
import { clip, HUD } from '../glasses'
import { INPUT_CLIP_CHARS } from '../config'

// Input keys, most-specific first, whose value best summarizes a tool call.
const MEANINGFUL_INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'description', 'url', 'query', 'prompt']

/** Pull the one value that best captures what a tool_use is doing. */
function firstMeaningfulInput(input: Record<string, unknown> | null): string {
  if (!input) return ''
  for (const key of MEANINGFUL_INPUT_KEYS) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  // Fall back to the first string-valued field of any name.
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
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
 * (`renderEvent`) and the panel (`ui.ts`) so both render command echoes the same.
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

/** One `◆ Name  summary` line per tool_use (over-long summaries are clipped). */
function renderToolLine(t: ToolUse): string {
  const name = t.name ?? 'tool'
  const summary = firstMeaningfulInput(t.input)
  return summary ? `${HUD.TOOL} ${name}  ${clip(summary, INPUT_CLIP_CHARS, HUD.ELL)}` : `${HUD.TOOL} ${name}`
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

/**
 * Turn ONE RcEvent into a compact HUD string (possibly multi-line), or '' for
 * events that should not appear in the log (partial streams, tool_result echoes,
 * control responses…). EventLog separates successive events with a blank line.
 */
export function renderEvent(e: RcEvent): string {
  switch (e.type) {
    case 'assistant': {
      // Cleaned assistant prose first, then a line per tool it kicked off.
      const lines: string[] = []
      const text = cleanProse(e.text)
      if (text) lines.push(text)
      for (const t of e.toolUses) lines.push(renderToolLine(t))
      return lines.join('\n')
    }

    case 'user': {
      // The wearer's / echoed sends. A bare tool_result (no text) is HUD noise.
      const text = cleanProse(cleanUserEcho(e.text))
      return text ? `${HUD.USER} ${text}` : ''
    }

    case 'result': {
      const ok = !(e.usage?.isError ?? false) && e.subtype !== 'error' && !e.subtype?.startsWith('error')
      const head = ok ? `${HUD.DONE} done` : `${HUD.DONE} ${e.subtype ?? 'error'}`
      return `${head}${usageSuffix(e)}`
    }

    case 'system': {
      if (e.subtype === 'init') return `${HUD.SYS} session started ${HUD.SEP} ${modelTail(e.model)}`
      if (e.subtype === 'compact_boundary') return `${HUD.SYS} context compacted`
      return ''
    }

    case 'control_request': {
      // A blocking control — main.ts routes it to the permission or question
      // screen, but it should still read in the log so scrollback shows why the
      // turn paused. Questions and tool-permissions get distinct one-liners.
      if (!e.isBlockingControl) return ''
      if (isQuestionRequest(e)) return questionSummary(e)
      return `${HUD.ATTN} needs you: ${e.permissionRequest?.toolName ?? 'tool'}`
    }

    // Partial streaming deltas, control responses, and anything else are noise.
    case 'stream_event':
    case 'control_response':
    default:
      return ''
  }
}

/** A blocking control is a QUESTION (dialog) rather than a tool-permission when
 *  its subtype is a dialog/side-question, or it carries parsed question options,
 *  or it is the AskUserQuestion tool. Kept here so the log + main.ts agree. */
export function isQuestionRequest(e: RcEvent): boolean {
  const p = e.permissionRequest
  const sub = p?.subtype ?? e.blockingSubtype ?? ''
  if (sub === 'request_user_dialog' || sub === 'side_question') return true
  if (p?.questions && p.questions.length > 0) return true
  const tool = p?.toolName ?? ''
  return tool === 'AskUserQuestion'
}

/** `claude-opus-4-8` → `opus-4-8`; '' → 'unknown'. */
function modelTail(m: string | null): string {
  if (!m) return 'unknown'
  return m.replace(/^claude-/, '')
}

/** The single most relevant tool name for a session-view header hint, or ''. */
export function toolSummary(e: RcEvent): string {
  if (e.type === 'control_request' && e.permissionRequest?.toolName) return e.permissionRequest.toolName
  const first = e.toolUses.find((t) => t.name)
  return first?.name ?? ''
}
