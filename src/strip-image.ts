// The session view's top strip, drawn as images: the firmware font has one
// size, so a text strip spends 42 px on one line, where a 13 px canvas font
// fits two lines in 38. The host converts the greys to 4-bit (black is
// "off" on the display), so the text is drawn light on black. An image can be
// at most 288 px wide, so the strip is drawn whole and cut into two images.
// Three boxes run across it: the mark, the status and hints, and the
// settings.

export const STRIP_IMG_W = 288 // an image container's maximum width
export const STRIP_IMG_H = 38

// Light weight, anti-aliased, with the anti-aliasing boosted (TEXT_GAMMA):
// the nearest to the firmware font's one-pixel stems. Compared as the phone
// draws it (Roboto) at the glasses' 16 greys: cutting the anti-aliasing to
// whole pixels left holes in curves, and unboosted, 44% of the hint line's
// lit pixels sat at the faintest levels (1-5 of 15), which reads as scratchy;
// boosted, 25%.
const FONT = '300 13px -apple-system, "Helvetica Neue", Roboto, Arial, sans-serif'
const TEXT_GAMMA = 0.6
// Text tops, measured to centre two 13 px lines (descenders included) in a box.
const LINE_Y = [3, 19]
// The boxes: the scroll body's hairline (grey 8 of 15), a corner radius, the
// gap between boxes and the padding inside them.
const BOX = '#888888'
const RADIUS = 6
const BOX_GAP = 4
const BOX_PAD = 8
const LOGO_PAD = 7
const SHADE = [255, 220] // first line bright, second (the hints) a little dimmer

// The "CR" mark, left of the text: heavy strokes with flat ends, leaning
// forward.
const LOGO_H = 28
const LOGO_Y = 5
const STROKE = 6.5
const LEAN = 0.22 // horizontal shift per px of height
const LOGO_W = 50 + Math.ceil(LEAN * LOGO_H)
const LOGO_BOX_W = LOGO_PAD + LOGO_W + LOGO_PAD
const SETTINGS_W = 190

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function logoPath(ctx: Ctx): void {
  const r = (LOGO_H - STROKE) / 2 // C: an open ring
  const cy = LOGO_Y + LOGO_H / 2
  const cx = STROKE / 2 + r
  ctx.moveTo(cx + r * Math.cos(-0.75), cy + r * Math.sin(-0.75))
  ctx.arc(cx, cy, r, -0.75, 0.75, true)
  // R: stem, bowl, leg. The stem and leg run past the baseline, where
  // drawLogo clips them, so both feet end on it, cut level.
  const x = cx + r + STROKE + 5
  const top = LOGO_Y + STROKE / 2
  const base = LOGO_Y + LOGO_H
  const past = base + STROKE
  const mid = LOGO_Y + LOGO_H * 0.55
  const bowl = (mid - top) / 2
  ctx.moveTo(x, past)
  ctx.lineTo(x, top)
  ctx.lineTo(x + 8, top)
  ctx.arc(x + 8, top + bowl, bowl, -Math.PI / 2, Math.PI / 2)
  ctx.lineTo(x, mid)
  const legX = bowl + 1 // across, from the bowl's end to the foot
  const legY = base - STROKE / 2 - mid
  ctx.moveTo(x + 8, mid)
  ctx.lineTo(x + 8 + (legX * (past - mid)) / legY, past)
}

function drawLogo(ctx: Ctx, x0: number): void {
  ctx.save()
  // Lean forward about the baseline.
  ctx.setTransform(1, 0, -LEAN, 1, x0 + LEAN * (LOGO_Y + LOGO_H), 0)
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'miter'
  ctx.beginPath()
  ctx.rect(-STRIP_IMG_W, 0, 3 * STRIP_IMG_W, LOGO_Y + LOGO_H)
  ctx.clip()
  ctx.beginPath()
  logoPath(ctx)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = STROKE
  ctx.stroke()
  ctx.restore()
}

/** One box, its left edge at `x`, `w` wide. */
function box(ctx: Ctx, x: number, w: number): void {
  ctx.strokeStyle = BOX
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(x + 0.5, 0.5, w - 1, STRIP_IMG_H - 1, RADIUS)
  ctx.stroke()
}

/** A box's two lines. */
export type StripLines = readonly [string, string]

/** `text` cut to `max` px with an ellipsis. */
function fit(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo).trimEnd() + '…'
}

function canvasOf(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  return typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h })
}

function context(canvas: OffscreenCanvas | HTMLCanvasElement): Ctx {
  const ctx = canvas.getContext('2d') as Ctx | null
  if (!ctx) throw new Error('no 2d canvas')
  return ctx
}

/** The whole strip, drawn once and cut at the seam into the two images' raw
 *  greys, one byte per pixel. Raw rather than PNG: the asynchronous PNG
 *  encode stalled image updates for up to 4 s on the phone, where reading the
 *  pixels back takes milliseconds. Drawn as: the mark's box, the `status` box (both lines left-aligned) and the
 *  fixed-width `settings` box at the right. Text in the status box may cross
 *  the seam. */
export async function stripHalves(status: StripLines, settings: StripLines, fitSettings = false, brightness = 1): Promise<[Uint8Array, Uint8Array]> {
  const full = canvasOf(2 * STRIP_IMG_W, STRIP_IMG_H)
  const ctx = context(full)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, 2 * STRIP_IMG_W, STRIP_IMG_H)
  ctx.font = FONT
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  // A fixed width keeps a changing value from moving the boxes; short hints
  // can take a box fitted to them instead.
  // No settings text at all (fitted) means no settings box.
  const settingsText = Math.ceil(Math.max(...settings.map((l) => ctx.measureText(l).width)))
  const settingsW = !fitSettings ? SETTINGS_W : settingsText ? Math.min(SETTINGS_W, settingsText + 2 * BOX_PAD) : 0
  const settingsX = 2 * STRIP_IMG_W - settingsW
  const statusEnd = settingsW ? settingsX - BOX_GAP : 2 * STRIP_IMG_W
  const statusX = LOGO_BOX_W + BOX_GAP
  box(ctx, 0, LOGO_BOX_W)
  drawLogo(ctx, LOGO_PAD - 1.5) // the lean puts its ink right of LOGO_W's centre
  box(ctx, statusX, statusEnd - statusX)
  if (settingsW) box(ctx, settingsX, settingsW)
  // The text goes on its own layer, drawn white, so its anti-aliasing can be
  // boosted before it is tinted to each line's shade.
  const layer = canvasOf(2 * STRIP_IMG_W, STRIP_IMG_H)
  const t = context(layer)
  t.font = FONT
  t.textBaseline = 'top'
  t.fillStyle = '#ffffff'
  for (const i of [0, 1]) {
    t.fillText(fit(t, status[i], statusEnd - statusX - 2 * BOX_PAD), statusX + BOX_PAD, LINE_Y[i])
    t.fillText(fit(t, settings[i], settingsW - 2 * BOX_PAD), settingsX + BOX_PAD, LINE_Y[i])
  }
  const text = t.getImageData(0, 0, 2 * STRIP_IMG_W, STRIP_IMG_H)
  const px = text.data
  for (let i = 0; i < px.length; i += 4) {
    const shade = SHADE[Math.floor(i / 4 / (2 * STRIP_IMG_W)) < LINE_Y[1] ? 0 : 1]
    px[i] = px[i + 1] = px[i + 2] = shade
    px[i + 3] = Math.round(Math.pow(px[i + 3] / 255, TEXT_GAMMA) * 255)
  }
  t.putImageData(text, 0, 0)
  ctx.drawImage(layer, 0, 0)
  return [grey(ctx, 0, brightness), grey(ctx, 1, brightness)]
}

export const NOTICE_H = 30
// Larger than the strip's text: a notice is read at a glance.
const NOTICE_FONT = '400 17px -apple-system, "Helvetica Neue", Roboto, Arial, sans-serif'

/** A notice: `text` in a box fitted to it, at the left of a strip-wide,
 *  NOTICE_H-tall image, the rest black (off). Raw greys, as stripHalves. */
export function noticeGreys(text: string): Uint8Array {
  const canvas = canvasOf(STRIP_IMG_W, NOTICE_H)
  const ctx = context(canvas)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, STRIP_IMG_W, NOTICE_H)
  ctx.font = NOTICE_FONT
  ctx.textBaseline = 'top'
  const shown = fit(ctx, text, STRIP_IMG_W - 2 * BOX_PAD)
  const w = Math.ceil(ctx.measureText(shown).width) + 2 * BOX_PAD
  ctx.strokeStyle = BOX
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(0.5, 0.5, w - 1, NOTICE_H - 1, RADIUS)
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.fillText(shown, BOX_PAD, 6)
  const rgba = ctx.getImageData(0, 0, STRIP_IMG_W, NOTICE_H).data
  const out = new Uint8Array(STRIP_IMG_W * NOTICE_H)
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]
  return out
}

/** One half's pixels as greys, one byte each. Everything is drawn in greys,
 *  so the red channel is the grey. */
function grey(ctx: Ctx, half: number, brightness: number): Uint8Array {
  const rgba = ctx.getImageData(half * STRIP_IMG_W, 0, STRIP_IMG_W, STRIP_IMG_H).data
  const out = new Uint8Array(STRIP_IMG_W * STRIP_IMG_H)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(rgba[i * 4] * brightness)
  return out
}
