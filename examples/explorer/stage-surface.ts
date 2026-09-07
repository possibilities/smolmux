import { dividerGlyphs, fitLayout } from "../../src/layout.ts"
import type { InstanceStatus } from "../../src/protocol.ts"
import { cssFont, type TerminalAppearance } from "./appearance.ts"
import { drawTerminalGlyph } from "./terminal-glyphs.ts"
import type { TerminalCells } from "./terminal-view.ts"

/** The cells around Apps: terminal background, joined Dividers and centered Text Panes. */
export function stageSurface(state: InstanceStatus, appearance: TerminalAppearance, cells: TerminalCells, element: HTMLElement) {
  element.replaceChildren()
  element.className = "stage-surface"
  element.setAttribute("aria-label", `Stage ${state.stage.cols} columns by ${state.stage.rows} rows`)
  const width = state.stage.cols * cells.width, height = state.stage.rows * cells.height
  element.style.width = `${width}px`
  element.style.height = `${height}px`
  element.style.background = appearance.background
  const canvas = document.createElement("canvas")
  canvas.className = "stage-dividers"
  canvas.setAttribute("aria-hidden", "true")
  // Match the terminal raster budget; physical cell coordinates stay unrounded.
  const ratio = Math.min(devicePixelRatio, 2, 8192 / Math.max(width, height), Math.sqrt(2_000_000 / (width * height)))
  canvas.width = Math.max(1, Math.ceil(width * ratio))
  canvas.height = Math.max(1, Math.ceil(height * ratio))
  const ctx = canvas.getContext("2d")!
  ctx.scale(canvas.width / width, canvas.height / height)
  // These are the Runtime's indexed Ramp roles, independent of the explorer UI theme.
  ctx.fillStyle = appearance.palette[state.theme === "dark" ? 240 : 250]!
  const fitted = fitLayout(state.layout.root, state.stage)
  for (const [key, glyph] of dividerGlyphs(fitted.dividers)) {
    const [x, y] = key.split(",").map(Number) as [number, number]
    drawTerminalGlyph(ctx, glyph.codePointAt(0)!, x * cells.width, y * cells.height, cells.width, cells.height)
  }
  element.append(canvas)
  for (const pane of state.layout.panes) {
    if (pane.app || pane.cols <= 0 || pane.rows <= 0) continue
    const text = document.createElement("div")
    text.className = "stage-text-pane"
    text.style.left = `${pane.x * cells.width}px`
    text.style.top = `${pane.y * cells.height}px`
    text.style.width = `${pane.cols * cells.width}px`
    text.style.height = `${pane.rows * cells.height}px`
    text.style.color = appearance.palette[state.theme === "dark" ? 245 : 247]!
    text.style.font = `${cells.fontSize}px ${cssFont(appearance.fontFamily)}`
    text.style.lineHeight = `${cells.height}px`
    text.style.letterSpacing = `${cells.width - cells.advance}px`
    const label = document.createElement("span")
    label.textContent = pane.text
    text.append(label)
    element.append(text)
  }
  return element
}
