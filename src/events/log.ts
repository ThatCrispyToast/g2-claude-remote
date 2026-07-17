// The rolling event log behind the session-view HUD.
//
// Events arrive out of the SSE stream (and from a one-shot history fetch on
// open, which can overlap the stream). We dedupe by sequenceNum, render each
// event to HUD text via renderEvent (dropping the ones it maps to ''), and keep
// the rendered lines. The session view scrolls these natively on the glasses, so
// instead of software pages we hand it whole-line WINDOWS (tailWindow /
// windowBefore / windowFrom) sized to a char budget, never splitting a line.

import { renderEvent } from './format'
import { byteLen, HUD } from '../glasses'
import type { RcEvent } from '../rc/types'

/** Cap on rendered lines kept — a long session can't grow the log unbounded. */
const MAX_LINES = 500

export class EventLog {
  private lines: string[] = []
  private seen = new Set<number>()
  private last: RcEvent | undefined

  /**
   * Ingest one event: dedupe by sequenceNum, render it, and append the
   * resulting line(s). Events that render to '' are dropped from the log but
   * still tracked as the latest raw event. A blank spacer line is inserted
   * BETWEEN successive events (never leading) so distinct turns are visually
   * separated on the HUD instead of blurring into one wall of text.
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
    const rendered = renderEvent(e)
    if (!rendered) return true
    if (this.lines.length > 0) this.lines.push('') // spacer between events
    for (const line of rendered.split('\n')) this.lines.push(line)
    if (this.lines.length > MAX_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LINES)
    }
    return true
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
  }
}

/** Clamp `i` into the valid `[0, len]` window-boundary range (NaN → 0). */
function clampIndex(i: number, len: number): number {
  if (!Number.isFinite(i)) return 0
  return Math.max(0, Math.min(Math.trunc(i), len))
}
