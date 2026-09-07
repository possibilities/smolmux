import { CellFlags, Ghostty, type GhosttyTerminal } from "ghostty-web"
import type { Capture } from "../../src/protocol.ts"
import { adjustMetric, cssFont, rgb, type TerminalAppearance } from "./appearance.ts"
import { drawTerminalGlyph } from "./terminal-glyphs.ts"

export const loadTerminalEngine = () => Ghostty.load("/assets/ghostty-vt.wasm")
export function measureTerminalCells(appearance: TerminalAppearance) {
  const ctx = document.createElement("canvas").getContext("2d")!
  const fontSize = appearance.fontSize * 96 / 72 // Ghostty points → CSS pixels.
  ctx.font = `${fontSize}px ${cssFont(appearance.fontFamily)}`
  const metrics = ctx.measureText("Mg")
  const advance = ctx.measureText("M").width
  const width = Math.max(1, Math.ceil(adjustMetric(advance, appearance.cellWidth)))
  const ascent = metrics.fontBoundingBoxAscent || fontSize * 0.8
  const baseHeight = ascent + (metrics.fontBoundingBoxDescent || fontSize * 0.2)
  const height = Math.max(1, Math.ceil(adjustMetric(baseHeight, appearance.cellHeight)))
  const baseline = adjustMetric(ascent + (height - baseHeight) / 2, appearance.baseline)
  return { width, height, fontSize, baseline, advance }
}
export type TerminalCells = ReturnType<typeof measureTerminalCells>
// Captures are screen data. Only SGR is accepted; OSC, input modes, links, etc. cannot escape a row.
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
export function captureRows(capture: Capture, history: boolean): string[] {
  const screen = capture.ansi?.length === capture.rows ? capture.ansi.map(row =>
    row.split(/(\x1b\[[\d;:]*m)/u).map(part => /^\x1b\[[\d;:]*m$/u.test(part) ? part : plain(part)).join(""))
    : capture.lines.slice(capture.screen_start).map(plain)
  return history ? [...capture.lines.slice(0, capture.screen_start).map(plain), ...screen] : screen
}

/** A read-only Ghostty VT buffer, drawn in fixed cells and fitted without resizing the live Session. */
export class TerminalView {
  readonly canvas = document.createElement("canvas")
  private readonly spacer = document.createElement("div")
  private readonly transcript = document.createElement("pre")
  private readonly message = document.createElement("p")
  private readonly observer: ResizeObserver
  private readonly ctx: CanvasRenderingContext2D
  private terminal: GhosttyTerminal | null = null
  private capture: Capture | null = null
  private previousLines: string[] | null = null
  private history = false
  private fitMode: "contain" | "width" | "native" | "cells" = "contain"
  private naturalWidth = 0
  private naturalHeight = 0
  private cols = 0
  private rows = 0
  private disposed = false
  private drawFrame = 0

  constructor(private readonly host: HTMLElement, private readonly engine: Ghostty,
    private readonly appearance: TerminalAppearance,
    private readonly metrics = measureTerminalCells(appearance)) {
    host.classList.add("terminal-view")
    this.spacer.className = "terminal-spacer"
    this.canvas.className = "terminal-raster"
    this.canvas.setAttribute("aria-hidden", "true")
    this.transcript.className = "terminal-transcript"
    this.message.className = "terminal-message"
    this.spacer.append(this.canvas)
    host.replaceChildren(this.spacer, this.transcript, this.message)
    this.ctx = this.canvas.getContext("2d", { alpha: false })!
    this.observer = new ResizeObserver(() => this.fit())
    this.observer.observe(host)
    host.style.background = appearance.background
    host.style.color = appearance.foreground
    host.style.setProperty("--terminal-font", cssFont(appearance.fontFamily))
  }

  setMessage(text: string) {
    cancelAnimationFrame(this.drawFrame); this.drawFrame = 0
    this.capture = null
    this.spacer.hidden = true
    this.transcript.textContent = ""
    this.message.hidden = false
    this.message.textContent = text
    this.terminal?.free(); this.terminal = null
  }

  setFit(mode: "contain" | "width" | "native" | "cells") {
    this.fitMode = mode
    this.host.dataset.fit = mode
    this.fit()
  }

  update(capture: Capture, history = false) {
    if (this.capture === capture && this.previousLines === capture.lines && this.history === history) return
    this.capture = capture
    this.previousLines = capture.lines
    this.history = history
    this.message.hidden = true
    this.spacer.hidden = false
    this.transcript.textContent = (history ? capture.lines : capture.lines.slice(capture.screen_start)).join("\n")
    const lines = captureRows(capture, history)
    this.cols = capture.cols
    this.rows = capture.rows + (history ? capture.screen_start : 0)
    if (!this.terminal) this.terminal = this.engine.createTerminal(this.cols, this.rows, {
      scrollbackLimit: 0, fgColor: rgb(this.appearance.foreground), bgColor: rgb(this.appearance.background),
      cursorColor: rgb(this.appearance.cursorColor), palette: this.appearance.palette.map(rgb),
    })
    else if (this.terminal.cols !== this.cols || this.terminal.rows !== this.rows) this.terminal.resize(this.cols, this.rows)
    // Disable auto-wrap; a full last column must never wrap or scroll the captured screen.
    this.terminal.write("\x1b[0m\x1b[?7l\x1b[2J" + lines.slice(0, this.rows)
      .map((line, y) => `\x1b[${y + 1};1H\x1b[0m${line}`).join("") + "\x1b[0m\x1b[?25l")
    if (!this.drawFrame) this.drawFrame = requestAnimationFrame(() => { this.drawFrame = 0; this.draw() })
  }

  private draw() {
    if (!this.terminal || this.disposed) return
    const a = this.appearance, ctx = this.ctx
    const { fontSize, width: cw, height: ch, baseline } = this.metrics
    this.naturalWidth = this.cols * cw
    this.naturalHeight = this.rows * ch
    // Dense or very large Instances must not allocate an unbounded canvas per App.
    const ratio = Math.min(devicePixelRatio, 2, 8192 / Math.max(this.naturalWidth, this.naturalHeight),
      Math.sqrt(2_000_000 / (this.naturalWidth * this.naturalHeight)))
    const pixelsWide = Math.max(1, Math.ceil(this.naturalWidth * ratio))
    const pixelsHigh = Math.max(1, Math.ceil(this.naturalHeight * ratio))
    if (this.canvas.width !== pixelsWide) this.canvas.width = pixelsWide
    if (this.canvas.height !== pixelsHigh) this.canvas.height = pixelsHigh
    ctx.setTransform(this.canvas.width / this.naturalWidth, 0, 0, this.canvas.height / this.naturalHeight, 0, 0)
    ctx.fillStyle = a.background
    ctx.fillRect(0, 0, this.naturalWidth, this.naturalHeight)
    this.terminal.update()
    const cells = this.terminal.getViewport()
    const colors = (cell: typeof cells[number]) => {
      const foreground = `rgb(${cell.fg_r},${cell.fg_g},${cell.fg_b})`
      const background = `rgb(${cell.bg_r},${cell.bg_g},${cell.bg_b})`
      return cell.flags & CellFlags.INVERSE ? [background, foreground] : [foreground, background]
    }
    // Background pass first so adjacent cells cannot paint over combining glyphs.
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!
      ctx.fillStyle = colors(cell)[1]!
      ctx.fillRect((i % this.cols) * cw, Math.floor(i / this.cols) * ch, cw, ch)
    }
    ctx.textBaseline = "alphabetic"
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!
      if (cell.width === 0 || (cell.flags & CellFlags.INVISIBLE)) continue
      const col = i % this.cols, row = Math.floor(i / this.cols), x = col * cw, y = row * ch
      ctx.fillStyle = colors(cell)[0]!
      ctx.globalAlpha = cell.flags & CellFlags.FAINT ? 0.5 : 1
      const bold = !!(cell.flags & CellFlags.BOLD), italic = !!(cell.flags & CellFlags.ITALIC)
      const family = bold && italic ? a.fontFamilyBoldItalic : bold ? a.fontFamilyBold : italic ? a.fontFamilyItalic : a.fontFamily
      ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontSize}px ${cssFont(family)}`
      if (!drawTerminalGlyph(ctx, cell.codepoint, x, y, cw * cell.width, ch)) {
        const glyph = cell.grapheme_len ? this.terminal.getGraphemeString(row, col) : String.fromCodePoint(cell.codepoint || 32)
        ctx.fillText(glyph, x, y + baseline, cw * cell.width)
      }
      if (cell.flags & CellFlags.UNDERLINE) ctx.fillRect(x, y + Math.min(ch - 1, baseline + 2), cw * cell.width, 1)
      if (cell.flags & CellFlags.STRIKETHROUGH) ctx.fillRect(x, y + ch / 2, cw * cell.width, 1)
    }
    ctx.globalAlpha = 1
    const cursor = this.capture!.cursor
    if (!this.history && cursor.visible && cursor.x < this.cols && cursor.y < this.rows) {
      ctx.fillStyle = a.cursorColor
      const x = cursor.x * cw, y = cursor.y * ch
      if (a.cursorStyle === "bar") ctx.fillRect(x, y, Math.max(1, cw / 8), ch)
      else if (a.cursorStyle === "underline") ctx.fillRect(x, y + ch - 2, cw, 2)
      else {
        ctx.fillRect(x, y, cw, ch)
        const cell = cells[cursor.y * this.cols + cursor.x]
        if (cell && cell.width > 0) {
          ctx.fillStyle = a.cursorText
          ctx.font = `${fontSize}px ${cssFont(a.fontFamily)}`
          const glyph = cell.grapheme_len ? this.terminal.getGraphemeString(cursor.y, cursor.x) : String.fromCodePoint(cell.codepoint || 32)
          ctx.fillText(glyph, x, y + baseline, cw)
        }
      }
    }
    this.canvas.dataset.cols = String(this.cols)
    this.canvas.dataset.rows = String(this.rows)
    this.canvas.dataset.cellWidth = String(cw)
    this.canvas.dataset.cellHeight = String(ch)
    this.terminal.markClean()
    this.fit()
  }

  fit() {
    if (!this.naturalWidth || this.disposed) return
    const css = getComputedStyle(this.host)
    const width = this.host.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
    const height = this.host.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)
    if (width <= 0 || height <= 0) return
    const scale = this.fitMode === "native" || this.fitMode === "cells" ? 1 : Math.max(.001, Math.min(1, width / this.naturalWidth,
      this.fitMode === "contain" ? height / this.naturalHeight : Infinity))
    this.canvas.style.width = `${this.naturalWidth}px`
    this.canvas.style.height = `${this.naturalHeight}px`
    this.canvas.style.transform = `scale(${scale})`
    this.spacer.style.width = `${this.naturalWidth * scale}px`
    this.spacer.style.height = `${this.naturalHeight * scale}px`
    this.host.dataset.fit = this.fitMode
    this.canvas.dataset.scale = String(scale)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.drawFrame)
    this.observer.disconnect()
    this.terminal?.free(); this.terminal = null
    this.host.replaceChildren()
  }
}
