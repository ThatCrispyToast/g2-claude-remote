// The rolling event log behind the session-view HUD.
//
// Events arrive out of the SSE stream (and from a one-shot history fetch on
// open, which can overlap the stream). We dedupe by sequenceNum, render each
// event via renderEventParts (dropping the ones that map to nothing), fold runs
// of tool_uses into compact chain lines, and keep the rendered lines. The
// session view scrolls these natively on the glasses, so
// instead of software pages we hand it whole-line WINDOWS (tailWindow /
// windowBefore / windowFrom) sized to a char budget, never splitting a line.

import { renderEventParts, packToolChain } from './format'
import { byteLen, HUD } from '../glasses'
import type { RcEvent } from '../rc/types'

/** Cap on rendered lines kept — a long session can't grow the log unbounded. */
const MAX_LINES = 500

export class EventLog {
  private lines: string[] = []
  private seen = new Set<number>()
  private last: RcEvent | undefined
  // The OPEN tool chain: where its block starts in `lines`, and every entry it
  // holds. A RUN of tool_uses is one block that grows and re-packs in place, so
  // a 27-tool run costs a few rows instead of 27. -1 = no chain open.
  private chainStart = -1
  private chainEntries: string[] = []
  // The last appended block, when it was a LONE single-line text block: its base
  // line and how many consecutive events rendered exactly that line. Repeat spam
  // is real — the worker persists a fresh `system/init` on EVERY controller
  // attach (each claude.ai open of a session mints one or two, confirmed live),
  // so an idle session's newest events would render as a wall of identical
  // "session started" lines. A repeat folds in place to `line xN` instead — the
  // tool chains' idiom. '' = the last block isn't foldable (multi-line, carried
  // tools, or no block yet).
  private foldLine = ''
  private foldCount = 0

  /**
   * Ingest one event: dedupe by sequenceNum, render it, and append the
   * resulting line(s). Events that render to nothing are dropped from the log
   * but still tracked as the latest raw event. A blank spacer line is inserted
   * BETWEEN successive blocks (never leading) so distinct turns are visually
   * separated on the HUD instead of blurring into one wall of text. A run of
   * events that each render to one identical line folds into `line xN`.
   *
   * Consecutive tool_uses join one chain block rather than taking a line each.
   * A dropped event does NOT break that run — a tool_result echo lands between
   * every pair of tool_uses, so breaking on it would make every chain one tool
   * long. Only real content (prose, a result, a system line) closes the chain.
   *
   * Returns whether the event was FRESH (false = a sequenceNum we already
   * ingested, e.g. an SSE reconnect replaying its catch-up window). Callers use
   * this to make sure a replayed event never re-triggers UI (prompt screens…).
   */
  append(e: RcEvent): boolean {
    if (e.sequenceNum != null) {
      if (this.seen.has(e.sequenceNum)) return false
      this.seen.add(e.sequenceNum)
    }
    this.last = e
    const { text, tools } = renderEventParts(e)
    if (!text && tools.length === 0) return true // drops without breaking the chain
    if (text) {
      this.chainStart = -1
      this.chainEntries = []
      // An event that renders to the SAME single line as the previous block
      // folds in place to `line xN` (see foldLine above) instead of stacking a
      // wall of identical lines. Only the tail line is rewritten, so frozen
      // history-window indices stay valid — and a line that differs at all
      // (say an init after a model switch) still gets its own block.
      if (tools.length === 0 && text === this.foldLine) {
        this.foldCount++
        this.lines[this.lines.length - 1] = `${text} x${this.foldCount}`
        return true
      }
      if (this.lines.length > 0) this.lines.push('') // spacer between blocks
      for (const line of text.split('\n')) this.lines.push(line)
      this.foldLine = tools.length === 0 && !text.includes('\n') ? text : ''
      this.foldCount = 1
    }
    // `attached`: these tools belong to the event whose prose we just wrote, so
    // they stay welded to it instead of opening a spacer-separated block.
    if (tools.length > 0) {
      this.foldLine = '' // a chain block ends the foldable run
      this.extendChain(tools, Boolean(text))
    }
    this.trim()
    return true
  }

  /**
   * Add `entries` to the open tool chain (opening one first if needed) and
   * re-pack that block in place. Only ever rewrites the TAIL lines, so the
   * indices a frozen history window holds into older lines stay valid.
   */
  private extendChain(entries: string[], attached: boolean): void {
    if (this.chainStart < 0) {
      if (!attached && this.lines.length > 0) this.lines.push('')
      this.chainStart = this.lines.length
      this.chainEntries = []
    }
    this.chainEntries.push(...entries)
    this.lines.length = this.chainStart // drop the previous packing
    for (const line of packToolChain(this.chainEntries)) this.lines.push(line)
  }

  /** Enforce MAX_LINES, keeping the open chain's index pointing at its block. */
  private trim(): void {
    if (this.lines.length <= MAX_LINES) return
    const dropped = this.lines.length - MAX_LINES
    this.lines.splice(0, dropped)
    if (this.chainStart < 0) return
    // Trimming shifts every index down. A chain whose own block was partly
    // trimmed can no longer be re-packed safely, so close it and start fresh.
    if (this.chainStart < dropped) {
      this.chainStart = -1
      this.chainEntries = []
    } else {
      this.chainStart -= dropped
    }
  }

  /** All rendered lines joined oldest→newest. */
  get text(): string {
    return this.lines.join('\n')
  }

  /** Number of rendered log lines currently retained. */
  get count(): number {
    return this.lines.length
  }

  /** Number of rendered lines — the indexing space for the history windows. */
  get lineCount(): number {
    return this.lines.length
  }

  // The session view scrolls the transcript natively (the firmware owns the
  // per-swipe scroll), so instead of software pages we hand the display whole-
  // line WINDOWS sized to a BYTE budget (the firmware caps text containers by
  // UTF-8 byte length, not char count). Each window is a few screens tall; the
  // firmware scrolls smoothly within it, and the app only swaps windows at the
  // boundaries. Windows never split a line mid-way.

  /** The newest lines that fit in `maxBytes`, plus the index of the first included line. */
  tailWindow(maxBytes: number): { text: string; startLine: number } {
    return this.windowBefore(this.lines.length, maxBytes)
  }

  /**
   * The LIVE tail: the newest lines packed into an estimated visual-ROW budget
   * (as well as the byte cap). The firmware renders a text container top-aligned
   * and never auto-scrolls to the bottom, so a live body that overflows its
   * container height hides exactly the newest lines — the ones live mode exists
   * to show. Bytes alone can't guarantee a fit (lines wrap, spacers cost a full
   * row for one byte), so each line is costed at its wrapped-row estimate,
   * spacer blank lines are skipped (vertical space is unaffordable here), and a
   * single over-budget newest line is tail-clipped rather than dropped.
   */
  tailRows(maxRows: number, charsPerRow: number, maxBytes: number): string {
    const out: string[] = []
    let rows = 0
    let bytes = 0
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i]
      if (!line) continue // inter-event spacer
      const cost = Math.max(1, Math.ceil(line.length / charsPerRow))
      const size = byteLen(line) + (out.length > 0 ? 1 : 0)
      if (out.length > 0 && (rows + cost > maxRows || bytes + size > maxBytes)) break
      if (out.length === 0 && (cost > maxRows || size > maxBytes)) {
        // The newest line alone overflows: keep its END (that's the live edge).
        const keep = Math.max(charsPerRow, maxRows * charsPerRow - HUD.ELL.length)
        out.push(`${HUD.ELL}${line.slice(Math.max(0, line.length - keep))}`)
        break
      }
      out.push(line)
      rows += cost
      bytes += size
    }
    return out.reverse().join('\n')
  }

  /** Whole-line window ending just before `endExclusive`, packing upward within `maxBytes`. */
  windowBefore(endExclusive: number, maxBytes: number): { text: string; startLine: number } {
    const end = clampIndex(endExclusive, this.lines.length)
    let start = end
    let used = 0
    while (start > 0) {
      const add = byteLen(this.lines[start - 1]) + (used > 0 ? 1 : 0)
      if (used > 0 && used + add > maxBytes) break // always keep ≥1 line, even if oversized
      used += add
      start--
    }
    if (start === end && end > 0) start = end - 1
    return { text: this.lines.slice(start, end).join('\n'), startLine: start }
  }

  /** Whole-line window starting at `start`, packing downward within `maxBytes`. Returns the exclusive end. */
  windowFrom(start: number, maxBytes: number): { text: string; endLine: number } {
    const s = clampIndex(start, this.lines.length)
    let end = s
    let used = 0
    while (end < this.lines.length) {
      const add = byteLen(this.lines[end]) + (used > 0 ? 1 : 0)
      if (used > 0 && used + add > maxBytes) break
      used += add
      end++
    }
    if (end === s && s < this.lines.length) end = s + 1
    return { text: this.lines.slice(s, end).join('\n'), endLine: end }
  }

  /** The most recently appended raw event (regardless of whether it rendered). */
  latest(): RcEvent | undefined {
    return this.last
  }

  clear(): void {
    this.lines = []
    this.seen = new Set<number>()
    this.last = undefined
    this.chainStart = -1
    this.chainEntries = []
    this.foldLine = ''
    this.foldCount = 0
  }
}

/** Clamp `i` into the valid `[0, len]` window-boundary range (NaN → 0). */
function clampIndex(i: number, len: number): number {
  if (!Number.isFinite(i)) return 0
  return Math.max(0, Math.min(Math.trunc(i), len))
}
