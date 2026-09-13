import { BoxRenderable, type CliRenderer, type KeyEvent, type MouseEvent, OptimizedBuffer, TextRenderable } from "@opentui/core"
import { fxnkRamp, type FxnkThemeResolution } from "./host-palette.ts"
import type { StopState } from "./protocol.ts"

/**
 * An inert copy of the last committed frame with one truthful status row.
 * Session renderables may disappear while their processes terminate; keeping
 * their pixels here avoids replacing useful context with empty Pane boxes.
 */
export class StoppingView {
  private readonly snapshot: OptimizedBuffer | null
  private readonly frozen: BoxRenderable
  private readonly status: BoxRenderable
  private readonly label: TextRenderable

  constructor(private readonly renderer: CliRenderer, theme: FxnkThemeResolution) {
    const current = (renderer as unknown as { currentRenderBuffer?: OptimizedBuffer }).currentRenderBuffer
    if (current) {
      this.snapshot = OptimizedBuffer.create(current.width, current.height, current.widthMethod, { id: "smolmux-stop-snapshot" })
      this.snapshot.drawFrameBuffer(0, 0, current)
    } else {
      this.snapshot = null
    }
    const ramp = fxnkRamp(theme.theme)
    this.frozen = new BoxRenderable(renderer, {
      id: "smolmux-stop-frozen", position: "absolute", left: 0, top: 0,
      width: "100%", height: "100%", zIndex: 900, backgroundColor: ramp.background,
      onMouseDown: stopMouse,
      onMouseUp: stopMouse,
      onMouseDrag: stopMouse,
      onMouseDragEnd: stopMouse,
      renderAfter: (target) => {
        // The frozen pixels do not own the hardware cursor. A focused Session
        // underneath can reveal it while handling its termination signal.
        renderer.setCursorPosition(0, 0, false)
        if (!this.snapshot) return
        target.drawFrameBuffer(
          0, 0, this.snapshot, 0, 0,
          Math.min(target.width, this.snapshot.width), Math.min(target.height, this.snapshot.height),
        )
      },
    })
    this.status = new BoxRenderable(renderer, {
      id: "smolmux-stop-status", position: "absolute", left: 0, bottom: 0,
      width: "100%", height: 1, zIndex: 999, backgroundColor: ramp.surface,
      alignItems: "center", justifyContent: "center", overflow: "hidden",
    })
    this.label = new TextRenderable(renderer, {
      id: "smolmux-stop-status-label", content: "stopping…", fg: ramp.secondary,
      selectable: false, wrapMode: "none", height: 1,
    })
    this.status.add(this.label)
    renderer.root.add(this.frozen)
    renderer.root.add(this.status)
    renderer.keyInput.prependListener("keypress", this.onKey)
    renderer.keyInput.prependListener("keyrelease", this.onKey)
    renderer.requestRender()
  }

  update(state: StopState, theme: FxnkThemeResolution): void {
    const ramp = fxnkRamp(theme.theme)
    this.frozen.backgroundColor = ramp.background
    this.status.backgroundColor = ramp.surface
    this.label.fg = state.phase === "failed" ? ramp.error : ramp.secondary
    this.label.content = stopLabel(state)
    this.renderer.requestRender()
  }

  destroy(): void {
    this.renderer.keyInput.off("keypress", this.onKey)
    this.renderer.keyInput.off("keyrelease", this.onKey)
    this.status.destroyRecursively()
    this.frozen.destroyRecursively()
    this.snapshot?.destroy()
  }

  private readonly onKey = (key: KeyEvent): void => {
    // Let the existing confirmation owner consume exact Ctrl+C so a failed
    // operation retains its two-press retry. Everything else sees inert UI.
    if (key.ctrl && key.name === "c" && !key.meta && !key.option && !key.shift && !key.super && !key.hyper) return
    key.preventDefault()
    key.stopPropagation()
  }
}

function stopMouse(event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

function stopLabel(state: StopState): string {
  switch (state.phase) {
    case "preparing":
      return "stopping… preparing"
    case "terminating":
      return state.remaining.length > 0
        ? `stopping… ${state.remaining.length} App${state.remaining.length === 1 ? "" : "s"} remaining`
        : "stopping…"
    case "failed":
      return state.remaining.length > 0
        ? `stop incomplete: ${state.remaining.join(", ")}; retry to finish`
        : "stop incomplete; retry to finish"
    case "complete":
      return state.preparationError ? "Sessions ended; preparation reported an error" : "stopped"
  }
}
