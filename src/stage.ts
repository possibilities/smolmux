import { BoxRenderable, type CliRenderer, type MouseEvent, type OptimizedBuffer, type RGBA, TextRenderable } from "@opentui/core"
import { fxnkRamp, type FxnkThemeResolution } from "./host-palette.ts"
import {
  dividerGlyphs,
  dragDivider,
  type FittedDivider,
  type FittedLayout,
  fitLayout,
  layoutApps,
  paneGeometries,
  type Rect,
} from "./layout.ts"
import { ApiFailure, type LayoutNode, type LayoutView } from "./protocol.ts"
import type { PaneTerminalRenderable } from "./pane-terminal.ts"

/** Where the Stage gets a Session's emulator; the roster owns their lifetime. */
export type PaneSource = {
  terminalFor(name: string): PaneTerminalRenderable | null
  setShown(names: Iterable<string>): void
}

export type StageOptions = {
  renderer: CliRenderer
  panes: PaneSource
  theme: FxnkThemeResolution
  onChanged: (cause: "apply" | "drag" | "resize") => void
}

type TextPane = { box: BoxRenderable; label: TextRenderable; text: string }
type DividerPane = { box: BoxRenderable; axis: FittedDivider["axis"] }

/**
 * The drawn Layout. Applying one mutates only what moved: a Pane that keeps
 * its rectangle is not resized, so its emulator neither reflows nor tells its
 * PTY anything, and a Session that stays on screen across an apply never
 * blinks. Geometry is smolmux's own — every Pane is absolutely positioned at the
 * rectangle `layout.ts` computed — so one apply is one layout pass.
 */
export class Stage {
  private readonly root: BoxRenderable
  private readonly textPanes = new Map<string, TextPane>()
  private readonly dividers = new Map<string, DividerPane>()
  private readonly renderer: CliRenderer
  private readonly panes: PaneSource
  private readonly onChanged: StageOptions["onChanged"]
  private theme: FxnkThemeResolution
  private tree: LayoutNode | null = null
  /** Bumped by every change to the tree, so a caller can refuse a stale write. */
  private treeRevision = 0
  private visible: string[] = []
  private fitted: FittedLayout = { leaves: [], dividers: [] }
  /** Divider cells as joined glyphs, keyed `<x>,<y>`; rebuilt with the fit. */
  private glyphs = new Map<string, string>()
  private dividerFg: RGBA
  private dividerBg: RGBA
  private focusName: string | null = null
  /** Sessions with a Pane right now, in tree order. */
  private shown: string[] = []
  private drag: { id: string; root: LayoutNode; revision: number; x: number; y: number } | null = null

  constructor(options: StageOptions) {
    this.renderer = options.renderer
    this.panes = options.panes
    this.onChanged = options.onChanged
    this.theme = options.theme
    const ramp = fxnkRamp(options.theme.theme)
    this.dividerFg = ramp.divider
    this.dividerBg = ramp.background
    this.root = new BoxRenderable(this.renderer, {
      id: "smolmux-stage",
      width: "100%",
      height: "100%",
    })
    this.renderer.root.add(this.root)
  }

  get view(): LayoutView {
    return {
      revision: this.treeRevision,
      visible: [...this.visible],
      root: this.tree,
      focus: this.focusName,
      stage: this.size,
      panes: paneGeometries(this.fitted, this.focusName),
    }
  }

  get size(): { cols: number; rows: number } {
    return { cols: Math.max(1, this.renderer.width), rows: Math.max(1, this.renderer.height) }
  }

  /** Session names a Pane shows, in tree order. */
  get shownSessions(): string[] {
    return [...this.shown]
  }

  /**
   * Replace the Layout. `revision` is the one the caller built its tree from:
   * a human's divider drag moves the Layout on, and an apply carrying an older
   * revision is refused rather than silently undoing that gesture.
   */
  apply(
    root: LayoutNode | null,
    focus: string | null | undefined,
    options: { revision?: number; cause?: "apply" | "drag"; visible?: string[]; committed?: () => void } = {},
  ): LayoutView {
    if (options.revision !== undefined && options.revision !== this.treeRevision) {
      throw new ApiFailure(
        "conflict",
        `the Layout has moved on: revision ${this.treeRevision}, not ${options.revision}`,
      )
    }
    const nextVisible = options.visible ?? this.visible
    const named = layoutApps(root)
    if (new Set(named).size !== named.length) throw new ApiFailure("invalid_params", "an App may appear in only one Pane")
    if (options.visible && (new Set(nextVisible).size !== nextVisible.length || named.some((name) => !nextVisible.includes(name)))) throw new ApiFailure("invalid_params", "visible must be unique and include every App in the tree")
    const previousTree = this.tree
    const previousFocus = this.focusName
    this.tree = root
    if (focus !== undefined) this.focusName = focus
    try {
      this.draw()
    } catch (error) {
      // A tree that cannot be drawn is not one to keep: every later refit
      // would throw again for the life of the Runtime.
      this.tree = previousTree
      this.focusName = previousFocus
      this.draw()
      throw error
    }
    this.visible = [...nextVisible]
    this.treeRevision += 1
    options.committed?.()
    this.onChanged(options.cause ?? "apply")
    return this.view
  }

  /** Re-fit the current tree; the roster changed or the stage did. */
  refit(cause: "apply" | "resize" = "apply"): LayoutView {
    this.draw()
    this.onChanged(cause)
    return this.view
  }

  setTheme(resolution: FxnkThemeResolution): void {
    this.theme = resolution
    const ramp = fxnkRamp(resolution.theme)
    for (const pane of this.textPanes.values()) {
      pane.label.fg = ramp.dim
    }
    // The glyphs are painted from these on the next frame, so there is nothing
    // per-divider to restyle.
    this.dividerFg = ramp.divider
    this.dividerBg = ramp.background
  }

  destroy(): void {
    for (const pane of this.textPanes.values()) pane.box.destroy()
    for (const divider of this.dividers.values()) divider.box.destroy()
    this.textPanes.clear()
    this.dividers.clear()
    this.root.destroy()
  }

  private draw(): void {
    const stage = this.size
    this.fitted = fitLayout(this.tree, stage)
    const ramp = fxnkRamp(this.theme.theme)

    const shown: string[] = []
    const liveText = new Set<string>()
    const placed = new Set<string>()
    for (const leaf of this.fitted.leaves) {
      if (leaf.rect.cols <= 0 || leaf.rect.rows <= 0) continue
      if ("app" in leaf.node) {
        const terminal = this.panes.terminalFor(leaf.node.app)
        // A Pane naming a Session that does not exist draws nothing; the
        // Layout stays as the caller wrote it, so creating that Session later
        // fills the Pane without another apply. A Session named twice has one
        // emulator, so only its first Pane draws it.
        if (!terminal || placed.has(leaf.node.app)) continue
        placed.add(leaf.node.app)
        if (terminal.parent !== this.root) this.root.add(terminal)
        placeAt(terminal, leaf.rect)
        terminal.visible = true
        shown.push(leaf.node.app)
        continue
      }
      if ("text" in leaf.node) {
        liveText.add(leaf.path)
        this.drawText(leaf.path, leaf.node.text, leaf.rect, ramp.dim)
      }
    }

    // Anything not in this Layout leaves the screen but keeps running: what
    // the last draw showed, plus anything this tree names but could not fit.
    const shownSet = new Set(shown)
    for (const name of new Set([...this.shown, ...layoutApps(this.tree)])) {
      if (shownSet.has(name)) continue
      const terminal = this.panes.terminalFor(name)
      if (terminal) { terminal.visible = false; if (terminal.focused) terminal.blur() }
    }
    for (const [path, pane] of this.textPanes) {
      if (liveText.has(path)) continue
      pane.box.destroy()
      this.textPanes.delete(path)
    }

    this.drawDividers(ramp.divider)
    this.shown = shown
    this.panes.setShown(shown)
    this.applyFocus()
  }

  private drawText(path: string, text: string, rect: Rect, color: ReturnType<typeof fxnkRamp>["dim"]): void {
    let pane = this.textPanes.get(path)
    if (!pane) {
      const box = new BoxRenderable(this.renderer, {
        id: `smolmux-text-${path || "root"}`,
        position: "absolute",
        alignItems: "center",
        justifyContent: "center",
      })
      const label = new TextRenderable(this.renderer, {
        id: `smolmux-text-label-${path || "root"}`,
        content: text,
        fg: color,
        selectable: false,
      })
      box.add(label)
      this.root.add(box)
      pane = { box, label, text }
      this.textPanes.set(path, pane)
    }
    if (pane.text !== text) {
      pane.text = text
      pane.label.content = text
    }
    pane.label.fg = color
    placeAt(pane.box, rect)
    pane.box.visible = true
  }

  private drawDividers(color: ReturnType<typeof fxnkRamp>["divider"]): void {
    this.dividerFg = color
    // Resolved together, because a cell's glyph depends on the lines that stop
    // beside it and not only on the divider that owns it.
    this.glyphs = dividerGlyphs(this.fitted.dividers)
    const live = new Set<string>()
    for (const divider of this.fitted.dividers) {
      live.add(divider.id)
      let pane = this.dividers.get(divider.id)
      if (!pane || pane.axis !== divider.axis) {
        pane?.box.destroy()
        const id = divider.id
        // The box is the hit target and nothing else: a one-sided border can
        // only ever draw a straight run, so the glyphs are painted per cell.
        const box = new BoxRenderable(this.renderer, {
          id: `smolmux-divider-${id}`,
          position: "absolute",
          onMouseDown: (event) => this.beginDrag(id, event),
          onMouseDrag: (event) => this.continueDrag(divider, event),
          onMouseUp: () => this.endDrag(),
          onMouseDragEnd: () => this.endDrag(),
          renderAfter: (buffer) => this.paintDivider(id, buffer),
        })
        this.root.add(box)
        pane = { box, axis: divider.axis }
        this.dividers.set(divider.id, pane)
      }
      placeAt(pane.box, divider.rect)
      pane.box.visible = true
    }
    for (const [id, pane] of this.dividers) {
      if (live.has(id)) continue
      pane.box.destroy()
      this.dividers.delete(id)
    }
  }

  /**
   * The top-left cell of the Pane showing this Session, or null when none
   * does. Mouse coordinates are relative to it, so a caller addresses a
   * Session's own screen and can never reach past it into a neighbour.
   *
   * A Session named by more than one Pane is drawn by its first, so that is
   * the one a click lands on.
   */
  paneOrigin(app: string): { x: number; y: number } | null {
    for (const leaf of this.fitted.leaves) {
      if (!("app" in leaf.node) || leaf.node.app !== app) continue
      if (leaf.rect.cols > 0 && leaf.rect.rows > 0) return { x: leaf.rect.x, y: leaf.rect.y }
    }
    return null
  }

  /** Paint one divider's own cells from the resolved grid. */
  private paintDivider(id: string, buffer: OptimizedBuffer): void {
    const divider = this.fitted.dividers.find((candidate) => candidate.id === id)
    if (!divider) return
    const { x, y, cols, rows } = divider.rect
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const glyph = this.glyphs.get(`${x + col},${y + row}`)
        if (glyph !== undefined) buffer.setCell(x + col, y + row, glyph, this.dividerFg, this.dividerBg)
      }
    }
  }

  /**
   * Keyboard focus is the API's alone: a click forwards its mouse report and
   * moves nothing. A focused Session that leaves the screen takes the
   * keyboard with it, and keys go nowhere until the next apply.
   */
  private applyFocus(): void {
    const focused = this.focusName !== null && this.shown.includes(this.focusName) ? this.focusName : null
    // Focus is a Layout intention, even before an App starts or while squeezed.
    if (this.focusName !== null && !layoutApps(this.tree).includes(this.focusName)) this.focusName = null
    for (const name of this.shown) {
      const terminal = this.panes.terminalFor(name)
      if (!terminal) continue
      if (name === focused) terminal.takeFocus()
      else if (terminal.focused) terminal.blur()
    }
  }

  private beginDrag(id: string, event: MouseEvent): void {
    if (!this.tree) return
    event.preventDefault()
    event.stopPropagation()
    this.drag = { id, root: this.tree, revision: this.treeRevision, x: event.x, y: event.y }
    // Capture immediately: OpenTUI latches drag capture on the first drag
    // event, and a fast flick can put that event past a one-cell divider.
    const capturer = this.renderer as unknown as { setCapturedRenderable?: (renderable: BoxRenderable) => void }
    const pane = this.dividers.get(id)
    if (pane) capturer.setCapturedRenderable?.(pane.box)
  }

  private continueDrag(divider: FittedDivider, event: MouseEvent): void {
    let drag = this.drag
    if (!drag || drag.id !== divider.id) return
    event.preventDefault()
    event.stopPropagation()
    if (drag.revision !== this.treeRevision) {
      // An apply landed mid-gesture. Re-baseline on what it wrote rather than
      // dragging from a tree that is gone: the guard that keeps a caller from
      // clobbering a human's drag has to hold in this direction too.
      if (this.tree === null) {
        this.drag = null
        return
      }
      drag = { id: drag.id, root: this.tree, revision: this.treeRevision, x: event.x, y: event.y }
      this.drag = drag
      return
    }
    // Cumulative from the tree the drag started on, so a slow drag does not
    // accumulate rounding the way per-event deltas would.
    const delta = divider.axis === "row" ? event.x - drag.x : event.y - drag.y
    const next = dragDivider(drag.root, divider.id, delta, this.size)
    if (!next) return
    this.tree = next
    this.treeRevision += 1
    // The gesture's own write is not an apply landing mid-gesture. Without
    // this the next event sees its own increment as someone else's and
    // re-baselines instead of dragging, so the divider tracks the pointer at
    // half speed and never catches up.
    // `root` and the anchor stay where the gesture began, so the delta above
    // remains cumulative.
    drag.revision = this.treeRevision
    this.draw()
    this.onChanged("drag")
  }

  private endDrag(): void {
    this.drag = null
  }
}

function placeAt(renderable: { position: unknown; left: unknown; top: unknown; width: unknown; height: unknown }, rect: Rect): void {
  const target = renderable as { position: string; left: number; top: number; width: number; height: number }
  target.position = "absolute"
  target.left = rect.x
  target.top = rect.y
  target.width = rect.cols
  target.height = rect.rows
}

