import {
  type CliRenderer,
  type MouseEvent,
  type EmbeddedTerminalOptions,
  EmbeddedTerminalRenderable,
  type KittyKeyboardOptions,
  OptimizedBuffer,
  type Selection,
} from "@opentui/core"
import { buildEmbeddedThemeSequence, type FxnkThemeResolution } from "./host-palette.ts"

type PaneTerminalOptions = Omit<EmbeddedTerminalOptions, "selectable">

/** A Pane's screen as text, with however much history was asked for above it. */
export type PaneCapture = {
  lines: string[]
  /** Index in `lines` where the visible screen begins. */
  screenStart: number
  columns: number
  rows: number
  cursor: { x: number; y: number; visible: boolean }
}

/**
 * The host terminal's keyboard mode: Kitty's disambiguate flag and no other
 * progressive enhancement, so modified keys reach the Runtime unambiguously.
 * Each Session's own mode is the embedded emulator's business: the native
 * encoder re-encodes every key for the flags that Session requested.
 */
export const HOST_KEYBOARD_PROTOCOL = {
  disambiguate: true,
  alternateKeys: false,
  events: false,
  allKeysAsEscapes: false,
  reportText: false,
} satisfies KittyKeyboardOptions

/**
 * One Session's screen: a libghostty emulator in a rectangle of the stage.
 *
 * Stage grants keyboard Focus according to the Layout leaf policy. Physical
 * left mouse-down requests Focus; targeted API mouse input never does.
 *
 * Selection composes with the Session's own mouse handling: without mouse
 * reporting, OpenTUI owns an ordinary drag; with it, the Session owns the
 * click and drag exclusively; the outer terminal can still reserve
 * Shift-drag as its native override.
 */
export class PaneTerminalRenderable extends EmbeddedTerminalRenderable {
  // A fresh emulator reports a visible cursor at the origin, and a Pane may
  // be focused before its Session has drawn anything. Control-only startup
  // output can leave that provisional cursor untouched, so conceal it until
  // the Session places it.
  private cursorPositionEstablished = false
  private selectionGesture: Selection | null = null
  private selectionActivated = false
  public onFocusRequest: (() => void) | null = null
  private focusPermitted = false
  private scratch: OptimizedBuffer | null = null

  constructor(renderer: CliRenderer, options: PaneTerminalOptions) {
    const onMouseDown = options.onMouseDown
    super(renderer, {
      ...options,
      selectable: options.visible !== false,
      onMouseDown(event) {
        if (event.defaultPrevented) renderer.clearSelection()
        onMouseDown?.call(this, event)
      },
    })
  }

  public override processMouseEvent(event: MouseEvent): void {
    if (event.type === "down" && event.button === 0 && !event.isDragging) this.onFocusRequest?.()
    super.processMouseEvent(event)
  }

  /** Explicitly targeted API input must not change human Focus. */
  public processTargetedMouseEvent(event: MouseEvent): void {
    super.processMouseEvent(event)
  }

  /** The one way keyboard Focus reaches a Pane: Stage grants it. */
  public takeFocus(): void {
    this.focusPermitted = true
    try {
      super.focus()
    } finally {
      this.focusPermitted = false
    }
  }

  public override focus(): void {
    if (!this.focusPermitted) return
    super.focus()
  }

  public setHostSelectionEnabled(enabled: boolean): void {
    this.selectable = enabled
  }

  /**
   * The screen as text, whether or not this Pane is on the Layout, optionally
   * with lines that have scrolled off the top.
   *
   * OpenTUI's own `screen()` reads the frame buffer the render pass fills,
   * which a hidden Pane never gets, so the emulator is composed into a buffer
   * of this Pane's own instead. The size is the caller's because it is the
   * emulator's: a Pane that has never been drawn has no layout to ask.
   *
   * History is read from the emulator here rather than fetched from the
   * Companion: the lines are already in this process, so a read costs one
   * compose per page and no round trip, and it works for a Session whose
   * transport is currently lost. The viewport is scrolled to reach them and
   * put back in the same synchronous turn, so no frame can be drawn at the
   * wrong position.
   */
  public captureScreen(cols: number, rows: number, scrollback = 0): PaneCapture {
    const internals = this as unknown as {
      handle: unknown
      lib: {
        embeddedTerminalCompose: (handle: unknown, target: unknown, x: number, y: number) => void
        embeddedTerminalInvalidate: (handle: unknown) => void
        embeddedTerminalScroll: (handle: unknown, delta: number) => void
        embeddedTerminalCursor: (handle: unknown) => { x: number; y: number; visible: boolean; hasValue: boolean }
      }
    }
    const cursor = { x: 0, y: 0, visible: false }
    if (!internals.handle) return { lines: [], screenStart: 0, columns: cols, rows, cursor }
    const width = Math.max(1, cols)
    const height = Math.max(1, rows)
    if (!this.scratch || this.scratch.width !== width || this.scratch.height !== height) {
      this.scratch?.destroy()
      this.scratch = OptimizedBuffer.create(width, height, this._ctx.widthMethod, { id: `${this.id}-capture` })
    }

    const page = (): string[] => {
      // A compose carries only what changed since the last one, so a capture
      // after a frame would read blanks. Mark the whole screen dirty first,
      // and again afterwards so this read does not swallow the next frame's
      // damage.
      internals.lib.embeddedTerminalInvalidate(internals.handle)
      internals.lib.embeddedTerminalCompose(internals.handle, this.scratch!.ptr, 0, 0)
      internals.lib.embeddedTerminalInvalidate(internals.handle)
      return new TextDecoder()
        .decode(this.scratch!.getRealCharBytes(true))
        .split("\n")
        .slice(0, height)
        .map((line) => line.trimEnd())
    }

    let lines: string[]
    let visible: string[]
    if (scrollback <= 0) {
      lines = page()
      visible = lines
    } else {
      const pages = Math.ceil(scrollback / height)
      const collected: string[][] = []
      // Walk up from the bottom. Scrolling past the top clamps, so the pages
      // repeat there and the overlap merge drops what repeats.
      for (let step = 0; step < pages; step += 1) {
        internals.lib.embeddedTerminalScroll(internals.handle, -height)
        collected.unshift(page())
      }
      // Down by exactly what went up. The walk up may have clamped at the
      // top, so this can overshoot, and the bottom clamps too, which is the
      // point: the viewport ends where it started either way.
      internals.lib.embeddedTerminalScroll(internals.handle, pages * height)
      visible = page()
      collected.push(visible)
      lines = collected.reduce(mergeOverlapping, [])
      // Keep only what was asked for, plus the screen itself.
      const keep = scrollback + height
      if (lines.length > keep) lines = lines.slice(lines.length - keep)
    }

    this.requestRender()
    // The screen is the tail, and both it and the whole are trimmed the same
    // way, so where it begins is what is left of it after trimming.
    visible = [...visible]
    while (visible.at(-1) === "") visible.pop()
    while (lines.at(-1) === "") lines.pop()
    const reported = internals.lib.embeddedTerminalCursor(internals.handle)
    return {
      lines,
      screenStart: Math.max(0, lines.length - visible.length),
      columns: width,
      rows: height,
      cursor: { x: reported.x, y: reported.y, visible: reported.visible && reported.hasValue },
    }
  }

  protected override destroySelf(): void {
    this.scratch?.destroy()
    this.scratch = null
    super.destroySelf()
  }

  public override onSelectionChanged(selection: Selection | null): boolean {
    if (!selection?.isActive) {
      this.selectionGesture = null
      this.selectionActivated = false
      return super.onSelectionChanged(null)
    }

    if (selection !== this.selectionGesture) {
      this.selectionGesture = selection
      this.selectionActivated = false
    }

    if (!this.selectionActivated) {
      const { anchor, focus } = selection
      this.selectionActivated = anchor.x !== focus.x || anchor.y !== focus.y
      if (!this.selectionActivated) {
        // OpenTUI sets isStart false on any drag event, even when the pointer is
        // still in its original cell. Keep the gesture provisional so mouse-up
        // clears it without copying. Once two cells have been covered, the latch
        // stays open and the user may contract the selection back to one cell.
        selection.isStart = true
        return super.onSelectionChanged(null)
      }
    }

    return super.onSelectionChanged(selection)
  }

  /** The one dynamic color the Session needs to answer its own OSC 11 query. */
  public applyHostTheme(resolution: FxnkThemeResolution): void {
    this.write(buildEmbeddedThemeSequence(resolution))
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)
    if (!this.focused || this.cursorPositionEstablished) return
    // Read the cursor from the emulator: OpenTUI's `screen()` decodes the
    // whole frame buffer to text to answer the same question, every frame.
    const internals = this as unknown as {
      handle: unknown
      lib: { embeddedTerminalCursor: (handle: unknown) => { x: number; y: number; visible: boolean; hasValue: boolean } }
    }
    const cursor = internals.handle ? internals.lib.embeddedTerminalCursor(internals.handle) : null
    // A Session that homes its cursor and stops — an editor on an empty
    // buffer — never leaves the origin, so one drawn frame is the latch: by
    // then the emulator has whatever the Session put there.
    if (cursor?.hasValue) {
      this.cursorPositionEstablished = true
      if (cursor.visible) return
    }
    this._ctx.setCursorPosition(0, 0, false)
  }
}

/**
 * Join two consecutive pages of a scrolled-back terminal. Pages are read a
 * screen at a time, and the walk up clamps at the top, so the same lines can
 * appear twice; the longest suffix of what is held that matches the head of
 * the next page is the seam.
 */
function mergeOverlapping(held: string[], page: string[]): string[] {
  if (held.length === 0) return [...page]
  const most = Math.min(held.length, page.length)
  for (let overlap = most; overlap > 0; overlap -= 1) {
    let matches = true
    for (let index = 0; index < overlap; index += 1) {
      if (held[held.length - overlap + index] !== page[index]) {
        matches = false
        break
      }
    }
    if (matches) return [...held, ...page.slice(overlap)]
  }
  return [...held, ...page]
}
