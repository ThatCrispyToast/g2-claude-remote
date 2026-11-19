// Rendering to the G2 display (576×288), built on the firmware's native widgets.
//
// The whole point of this module is to LEAN ON the glasses firmware instead of
// fighting it. Three layouts, each a set of absolutely-positioned containers the
// firmware draws and (crucially) scrolls itself:
//
//   • 'text'   — one full-screen text container (boot). Simple.
//   • 'list'   — a fixed header strip + a native ListContainerProperty. The
//                firmware moves the selection highlight on scroll with no
//                per-tick re-render, and reports the row via listEvent. The
//                strip is one line unless the layout asks for more rows (a
//                prompt's question or command, which must be read to answer).
//   • 'scroll' — a fixed header strip + a firmware-SCROLLED text body + a fixed
//                footer strip. This is the session / voice / confirm screen, and
//                every message screen (setup, error): the strips keep the title
//                and the gesture hint on screen whatever the body's length.
//                When the body content overflows its height, the firmware
//                scrolls it smoothly on swipe (the "Text: basic" feel); the app
//                only ever hears SCROLL_TOP / SCROLL_BOTTOM *boundary* events.
//
// The one hard rule that keeps native scrolling smooth: NEVER rebuild the page
// while the wearer is scrolling a body. rebuildPageContainer resets the scroll
// position. So every steady-state change is an in-place `textContainerUpgrade`
// of a single container (header, body, or footer independently) — we diff each
// container against what's on screen and only push the ones that changed. A full
// rebuild happens exactly when the LAYOUT KIND changes (text↔list↔scroll) or a
// native list's items change (the SDK can't mutate list items in place).
//
// All writes flow through one serialized, coalescing pump so BLE frames never
// overlap and a burst of renders collapses to the latest state.

import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { LIVE_BODY_BYTES } from './config'

// ─── Firmware-supported glyph vocabulary ─────────────────────────────────────
// The G2 firmware ships a single LVGL font. It has ASCII, Latin-1 (U+00A1–00FF),
// arrows, box-drawing, block elements, a subset of geometric shapes, and a few
// symbols — but NO emoji and NO dingbats. So ✓ ✗ ⚠ ⚙ 🎤 🗄 ⎋ ⌫ … › all render as
// nothing. Everything the HUD draws comes from this vetted set instead.
export const HUD = {
  RUN: '●', //  running / live (filled circle, U+25CF)
  IDLE: '○', //  idle (open circle, U+25CB)
  ATTN: '!', //  needs-you (plain ASCII, always safe)
  TOOL: '◆', //  a tool_use line (filled diamond, U+25C6)
  DONE: '◇', //  a result line (open diamond, U+25C7)
  SYS: '☉', //  a system / lifecycle line (sun, U+2609)
  USER: '»', //  an echoed user message (guillemet, U+00BB — Latin-1)
  SEND: '▶', //  a quick-send / play (right triangle, U+25B6)
  STOP: '■', //  interrupt (filled square, U+25A0)
  GO: '▶', //  "enter submenu" affordance
  BACK: '←', //  back (left arrow, U+2190)
  CUR: '●', //  the currently-applied model / mode
  SEP: '·', //  field separator (middle dot, U+00B7 — Latin-1)
  ELL: '...', //  truncation marker (real … is unsupported)
} as const

const W = 576
const H = 288
// Every SDK page call is raced against this timeout: the pump is serialized, so
// ONE bridge promise that never settles (a BLE hiccup, the app backgrounded
// mid-call) would otherwise wedge `busy` forever and freeze the HUD for the rest
// of the session while the panel kept working. A timeout is treated as a failed
// apply: the state mirror is invalidated so the next render retries from scratch.
const BRIDGE_CALL_TIMEOUT_MS = 4000
// The header / footer strips are single-line text containers. The firmware draws
// a scrollbar on ANY text container whose content overflows its height, and one
// line of the (proportional) firmware font is ~26px tall — so a strip must be
// tall enough that a line clears its height AND its top+bottom padding, or the
// header and footer sprout a scrollbar. This height leaves comfortable margin.
const STRIP_H = 42
// Each further line of a taller list header (see `headerRows`), and the most a
// header may take: the list below it still needs room for a few rows.
const LINE_H = 27
const MAX_HEADER_ROWS = 3
// Firmware caps per native list, both validated on (re)build — an over-cap page
// is REJECTED WHOLE and the screen silently keeps its old contents. Rows beyond
// 20 are dropped; item text is clamped by UTF-8 BYTES (a 64-char row holding
// multi-byte HUD glyphs would blow a byte-measured firmware buffer even though
// its char count looks fine — same trap as the text-container caps below).
const MAX_LIST_ITEMS = 20
const MAX_ITEM_BYTES = 63
// The firmware validates a text container by its UTF-8 BYTE length, not its
// character count. The documented caps are ~1000 bytes for a (re)build and ~2000
// for an in-place upgrade — but our HUD glyphs (● ◆ » · → …) are 2–3 bytes each,
// so a 1000-CHAR body can be ~1500 bytes and get silently rejected (the build
// no-ops, freezing the display). Every text-container body is byte-clamped to
// this single conservative ceiling, so a render can never be dropped.
const BODY_BYTE_CAP = 980

// Container IDs are stable per layout; the CAPTURE container is always id 1.
const BODY_ID = 1
const HDR_ID = 2
const FTR_ID = 3

export type Layout =
  | { kind: 'text'; content: string }
  | ListLayout
  | { kind: 'scroll'; header: string; body: string; footer: string }

/** A native list under a header strip. `headerRows` makes the strip taller
 *  (default one line). `key` names what the list IS: a different key rebuilds
 *  the page even when the rows read the same, so one prompt's Allow / Deny is
 *  never silently reused as the next one's. */
export interface ListLayout {
  kind: 'list'
  header: string
  items: string[]
  headerRows?: number
  key?: string
}

export class GlassesDisplay {
  private started = false
  private busy = false
  private pending: Layout | null = null

  // What is currently on screen, per container, so we can diff and upgrade only
  // what changed. `kind` gates whether a change is an upgrade or a full rebuild.
  private kind: Layout['kind'] | null = null
  private curText = '' // 'text' body
  private curHeader = '' // 'list' / 'scroll' header
  private curBody = '' // 'scroll' body
  private curFooter = '' // 'scroll' footer
  private curItemsSig = '' // 'list' items signature
  private curItems: string[] = [] // 'list' items as applied (clamped), for tap resolution

  /** Fired after every full (re)build of a native list — the firmware resets its
   *  selection highlight to row 0 then, so the owner must resync any tracked
   *  index or a later row-0 tap (whose index protobuf drops) fires a stale row. */
  onListRebuild: (() => void) | null = null

  constructor(private readonly bridge: EvenAppBridge) {}

  /** The item labels of the native list currently on the glasses, exactly as
   *  applied (clamped) — what listEvent.currentSelectItemName echoes back. */
  get listItems(): readonly string[] {
    return this.curItems
  }

  /** Whether the native list on the glasses RIGHT NOW is `layout`'s: same rows,
   *  same header height, same key. False while its build is still on its way
   *  over BLE, and after one that failed — so a caller can tell a tap on this
   *  list from a tap on whatever is still under the wearer's finger. */
  showsList(layout: ListLayout): boolean {
    return this.kind === 'list' && this.curItemsSig === listPlan(layout).sig
  }

  /** Create the initial page (a text screen). Call once before anything else —
   *  the host takes no other page call until it exists. Raced against the same
   *  timeout as every other call, so a startup page stuck on BLE can't stall
   *  boot, yet one that lands late still counts: renders queue meanwhile (the
   *  latest wins) and paint the moment it does. Resolves whether it's up yet. */
  async init(initial = ''): Promise<boolean> {
    if (this.started) return true
    const content = clampBytes(initial, BODY_BYTE_CAP, 'head')
    const created = this.bridge
      .createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [textBox(BODY_ID, 'display', content, full())] }),
      )
      .then((r) => {
        if (r !== StartUpPageCreateResult.success) {
          console.warn(`[glasses] createStartUpPageContainer failed (result ${r}) — nothing will render`)
          return false
        }
        this.started = true
        this.kind = 'text'
        this.curText = content
        void this.pump() // whatever was rendered while the page was pending
        return true
      })
      .catch((err) => {
        console.error('[glasses] createStartUpPageContainer failed:', err)
        return false
      })
    const ok = await this.timed(created)
    if (ok === null) console.warn('[glasses] createStartUpPageContainer timed out — renders queue until it lands')
    return ok === true
  }

  /** Queue a screen. Coalesced (only the latest wins) and serialized (no BLE overlap). */
  render(layout: Layout): void {
    this.pending = layout
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (!this.started || this.busy || !this.pending) return
    this.busy = true
    const layout = this.pending
    this.pending = null
    try {
      await this.apply(layout)
    } catch (err) {
      console.error('[glasses] render failed:', err)
    } finally {
      this.busy = false
      if (this.pending) void this.pump()
    }
  }

  private async apply(layout: Layout): Promise<void> {
    switch (layout.kind) {
      case 'text':
        return this.applyText(layout.content)
      case 'list':
        return this.applyList(layout)
      case 'scroll':
        return this.applyScroll(layout.header, layout.body, layout.footer)
    }
  }

  // ── text ───────────────────────────────────────────────────────────────
  private async applyText(raw: string): Promise<void> {
    const content = clampBytes(raw, BODY_BYTE_CAP, 'head')
    if (this.kind !== 'text') {
      if (!(await this.rebuild({ containerTotalNum: 1, textObject: [textBox(BODY_ID, 'display', content, full())] }))) return
      this.kind = 'text'
      this.curText = content
      return
    }
    if (content === this.curText) return
    if (await this.upgrade(BODY_ID, 'display', content)) this.curText = content
  }

  // ── list (fixed header + native list) ──────────────────────────────────
  private async applyList(layout: ListLayout): Promise<void> {
    const { items, rows, sig: itemsSig } = listPlan(layout)
    const stripH = STRIP_H + (rows - 1) * LINE_H
    const hdr = layout.header.slice(0, 200)

    if (this.kind !== 'list' || itemsSig !== this.curItemsSig) {
      // Items can't be mutated in place — (re)build the whole page.
      const ok = await this.rebuild({
        containerTotalNum: 2,
        // A thin header strip, then the framed native list — the same frame as the
        // scroll body, so the list is clearly set off from the header above it.
        textObject: [textBox(HDR_ID, 'hdr', hdr, strip(0, stripH), { capture: 0 })],
        listObject: [
          new ListContainerProperty({
            xPosition: 0,
            yPosition: stripH + 4,
            width: W,
            height: H - stripH - 4,
            containerID: BODY_ID,
            containerName: 'list',
            isEventCapture: 1,
            borderWidth: FRAME.width,
            borderColor: FRAME.color,
            borderRadius: FRAME.radius,
            paddingLength: 6,
            itemContainer: new ListItemContainerProperty({
              itemCount: items.length,
              itemWidth: 0, // auto-fill
              isItemSelectBorderEn: 1,
              itemName: items,
            }),
          }),
        ],
      })
      if (!ok) return
      this.kind = 'list'
      this.curHeader = hdr
      this.curItemsSig = itemsSig
      this.curItems = items
      this.curBody = ''
      this.curFooter = ''
      this.onListRebuild?.() // firmware highlight is back at row 0 now
      return
    }
    // Same items, header text changed → upgrade only the header strip (keeps the
    // firmware's current row highlight; a rebuild would reset it to the top).
    if (hdr !== this.curHeader) {
      if (await this.upgrade(HDR_ID, 'hdr', hdr)) this.curHeader = hdr
    }
  }

  // ── scroll (fixed header + firmware-scrolled body + fixed footer) ───────
  private async applyScroll(header: string, body: string, footer: string): Promise<void> {
    const hdr = header.slice(0, 200)
    const ftr = footer.slice(0, 200)

    if (this.kind !== 'scroll') {
      // First build of a scroll page uses the rebuild cap (1000) for the body.
      // Three bands: a thin header strip, the FRAMED (bordered) scroll body that
      // owns the whole middle, and a thin footer strip. The body's frame is what
      // sets it apart from the header/footer so the regions never run together.
      const b = clampBytes(body, BODY_BYTE_CAP, 'tail')
      const ok = await this.rebuild({
        containerTotalNum: 3,
        textObject: [
          textBox(HDR_ID, 'hdr', hdr, strip(0, STRIP_H), { capture: 0 }),
          textBox(BODY_ID, 'body', b, { x: 0, y: STRIP_H + 2, w: W, h: H - 2 * STRIP_H - 4, pad: 8 }, { capture: 1, frame: true }),
          textBox(FTR_ID, 'ftr', ftr, strip(H - STRIP_H, STRIP_H), { capture: 0 }),
        ],
      })
      if (!ok) return
      this.kind = 'scroll'
      this.curHeader = hdr
      this.curBody = b
      this.curFooter = ftr
      return
    }
    // Steady state: upgrade each container independently, only if it changed.
    // Upgrading the header/footer never disturbs the body's native scroll; the
    // body is only upgraded when its text actually changes (i.e. while live —
    // history keeps a frozen body, so this diff skips it and scroll stays put).
    if (hdr !== this.curHeader) {
      if (await this.upgrade(HDR_ID, 'hdr', hdr)) this.curHeader = hdr
    }
    const b = clampBytes(body, BODY_BYTE_CAP, 'tail')
    if (b !== this.curBody) {
      if (await this.upgrade(BODY_ID, 'body', b)) this.curBody = b
    }
    if (ftr !== this.curFooter) {
      if (await this.upgrade(FTR_ID, 'ftr', ftr)) this.curFooter = ftr
    }
  }

  // ── low-level bridge calls ─────────────────────────────────────────────
  // Both return whether the write was APPLIED; the callers commit their state
  // mirror only then. On a rejection or a timed-out bridge promise the mirror is
  // instead invalidated, so the next render diffs against nothing and repaints
  // the page from scratch — without this, one dropped write desyncs the mirror
  // from the glass and every later diff "already matches", freezing the HUD.
  private async rebuild(config: ConstructorParameters<typeof RebuildPageContainer>[0]): Promise<boolean> {
    const ok = await this.timed(this.bridge.rebuildPageContainer(new RebuildPageContainer(config)))
    // A `false` here means the firmware validated the page away (usually an
    // oversize container) and the screen silently kept its old contents.
    if (ok !== true) {
      console.warn('[glasses] rebuildPageContainer rejected/timed out — layout not applied')
      this.invalidate()
    }
    return ok === true
  }

  private async upgrade(containerID: number, containerName: string, content: string): Promise<boolean> {
    const ok = await this.timed(this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content })))
    if (ok !== true) {
      console.warn(`[glasses] textContainerUpgrade(${containerName}) rejected/timed out — content not applied`)
      this.invalidate()
    }
    return ok === true
  }

  /** Race a bridge write against BRIDGE_CALL_TIMEOUT_MS (null = timed out). */
  private timed(p: Promise<boolean>): Promise<boolean | null> {
    return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), BRIDGE_CALL_TIMEOUT_MS))])
  }

  /** Forget what's on screen so the next render rebuilds the page from scratch. */
  private invalidate(): void {
    this.kind = null
    this.curText = ''
    this.curHeader = ''
    this.curBody = ''
    this.curFooter = ''
    this.curItemsSig = ''
    this.curItems = []
  }

  /** Tear down the glasses page (exit the app). 0 = exit immediately;
   *  1 = system exit-confirm dialog — Even Hub requires 1 on the root page. */
  async shutdown(exitMode = 0): Promise<void> {
    try {
      await this.bridge.shutDownPageContainer(exitMode)
    } catch {
      /* best effort */
    }
  }
}

/** A list layout as it goes on the glass: its rows clamped to the firmware's
 *  caps, its header's height in rows, and the signature a rebuild is keyed on.
 *  The height is geometry and the key is identity, so both are in it. (Rows
 *  hold no newline — whitespace is collapsed — so it is a safe separator.) */
function listPlan(layout: ListLayout): { items: string[]; rows: number; sig: string } {
  const items = (layout.items.length ? layout.items : ['(none)'])
    .slice(0, MAX_LIST_ITEMS)
    .map((i) => clampBytes(i.replace(/\s+/g, ' '), MAX_ITEM_BYTES, 'head'))
  const rows = Math.max(1, Math.min(Math.trunc(layout.headerRows ?? 1) || 1, MAX_HEADER_ROWS))
  return { items, rows, sig: [rows, layout.key ?? '', ...items].join('\n') }
}

// ─── container geometry helpers ──────────────────────────────────────────────
type Box = { x: number; y: number; w: number; h: number; pad?: number }

const full = (): Box => ({ x: 0, y: 0, w: W, h: H, pad: 10 })
const strip = (y: number, h: number): Box => ({ x: 0, y, w: W, h, pad: 6 })

// The one frame style shared by every scroll body and native list — a subtle
// rounded border. It's what visually SEPARATES the scrollable region from the
// header above and the footer below, so the three bands never blur together.
// (borderColor is a 0–15 gray; 0 is invisible, 15 white — 8 reads as a hairline.)
export const FRAME = { width: 1, color: 8, radius: 8 } as const

function textBox(
  id: number,
  name: string,
  content: string,
  box: Box,
  opts: { capture?: 0 | 1; frame?: boolean } = {},
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: box.x,
    yPosition: box.y,
    width: box.w,
    height: box.h,
    containerID: id,
    containerName: name,
    content,
    isEventCapture: opts.capture ?? 1,
    paddingLength: box.pad ?? 6,
    borderWidth: opts.frame ? FRAME.width : 0,
    borderColor: opts.frame ? FRAME.color : 0,
    borderRadius: opts.frame ? FRAME.radius : 0,
  })
}

// ─── pure text helpers (unit-testable, no SDK) ───────────────────────────────

/** Collapse whitespace and clip to `max`, adding a trailing ellipsis if clipped. */
export function clip(text: string, max: number, ell = '…'): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - ell.length))}${ell}` : clean
}

const ENCODER = new TextEncoder()
/** UTF-8 byte length of a string (what the firmware measures its caps against). */
export function byteLen(s: string): number {
  return ENCODER.encode(s).length
}
/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes without splitting a multibyte
 * char. `keep:'tail'` retains the END (newest transcript output); `keep:'head'`
 * retains the START (a header-first text screen). A no-op when already within.
 */
export function clampBytes(s: string, maxBytes: number, keep: 'head' | 'tail' = 'head'): string {
  if (byteLen(s) <= maxBytes) return s
  const points = Array.from(s)
  if (keep === 'tail') points.reverse()
  let used = 0
  let count = 0
  for (const point of points) {
    used += byteLen(point)
    if (used > maxBytes) break
    count++
  }
  const kept = points.slice(0, count)
  return (keep === 'tail' ? kept.reverse() : kept).join('')
}

/**
 * The last screenful of streaming text, for the rolling live view. A leading `…`
 * marks that earlier text scrolled off the top. Used for the voice interim and
 * as a char-level fallback tail.
 */
export function liveTail(text: string, tailChars = LIVE_BODY_BYTES): string {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trimStart()
  if (clean.length <= tailChars) return clean
  return `${HUD.ELL}${clean.slice(clean.length - tailChars)}`
}

/** Fold typography the firmware font can't draw into plain ASCII. The font has
 *  no emoji or dingbats and silently drops unknown glyphs, so text authored for
 *  the panel (release notices) must be folded — em/en dashes, curly quotes,
 *  ellipsis — before it goes on glass. So must a backtick: the font has no
 *  glyph for it either (measured), and a command shown without its backticks
 *  reads as a different command. HUD-set glyphs pass through untouched. */
export function hudSafe(s: string): string {
  return s
    .replace(/[—–]/g, '-')
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
}

// ─── Firmware font metrics ───────────────────────────────────────────────────
// The font is proportional: `l` is 4 px wide and `m` 16, so a char count says
// little about where a line wraps (a strip holds 56 chars of one text and 64 of
// another). These are its advance widths in px, measured in the simulator on
// 2026-11-19 from runs of 24 of each printable ASCII glyph; lines of known text
// came out within 2% of what they predict. Real hardware may differ a little.
const ADVANCES: [number, string][] = [
  [4, "l:!'|"],
  [5, 'ijI.,;/\\ '],
  [6, 't"()'],
  [7, 'fr1[]'],
  [8, 'J{}*'],
  [9, 'kzL_'],
  [10, 'ceosEFT-=+<>^'],
  [11, 'abdghnpquvxyCS2'],
  [12, 'BDGHKNOPQRUZ03456789?$'],
  [13, 'AVXY'],
  [14, '#%'],
  [15, 'w&'],
  [16, 'mMW~'],
  [17, '@'],
]
const ADVANCE = new Map<string, number>(ADVANCES.flatMap(([px, chars]) => [...chars].map((c): [string, number] => [c, px])))
/** For what wasn't measured: accented letters and the HUD's own glyphs. */
const DEFAULT_ADVANCE = 12
/** What one row of a header / footer strip holds: its 564 px inside the
 *  padding, less a margin for the measuring. */
const STRIP_TEXT_PX = 552

/** The width of `s` in the firmware font, in px. */
export function textWidth(s: string): number {
  let px = 0
  for (const c of s) px += ADVANCE.get(c) ?? DEFAULT_ADVANCE
  return px
}

/** The rows `text` takes in a header strip. Wrapped at spaces only, where the
 *  firmware may also break after punctuation, so this never counts too few; a
 *  word wider than a row is broken across rows. */
export function stripRows(text: string): number {
  let rows = 1
  let used = 0
  for (const word of text.split(' ')) {
    const px = textWidth(word)
    const need = used ? px + textWidth(' ') : px
    if (used + need <= STRIP_TEXT_PX) {
      used += need
      continue
    }
    if (used) rows++ // the word starts a new row…
    rows += Math.floor(Math.max(0, px - 1) / STRIP_TEXT_PX) // …and may fill more than one
    used = px ? ((px - 1) % STRIP_TEXT_PX) + 1 : 0
  }
  return rows
}

/** Whether `text` fits on one row of a header strip. */
export function fitsStripRow(text: string): boolean {
  return textWidth(text) <= STRIP_TEXT_PX
}
