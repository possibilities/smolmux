import { BoxRenderable, type CliRenderer, type KeyEvent, TextRenderable } from "@opentui/core"
import { fxnkRamp, type FxnkThemeResolution } from "./host-palette.ts"

export const EXIT_CONFIRMATION_MS = 3000

/** Physical keyboard policy, independent of Layout and targeted app.input. */
export class ExitConfirmation {
  private readonly overlay: BoxRenderable
  private readonly label: TextRenderable
  private enabled = false
  private stopping = false
  private disposed = false
  private deadline = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly renderer: CliRenderer, theme: FxnkThemeResolution,
    private readonly stop: () => Promise<unknown>, private readonly report: (message: string) => void) {
    const ramp = fxnkRamp(theme.theme)
    this.overlay = new BoxRenderable(renderer, {
      id: "smolmux-exit-confirmation", position: "absolute", left: 0, bottom: 0,
      width: "100%", height: 1, zIndex: 1000, visible: false,
      alignItems: "center", justifyContent: "center", backgroundColor: ramp.surface,
      overflow: "hidden",
    })
    this.label = new TextRenderable(renderer, {
      id: "smolmux-exit-hint", content: "press ctrl+c again to exit", fg: ramp.secondary,
      selectable: false, wrapMode: "none", height: 1,
    })
    this.overlay.add(this.label)
    renderer.root.add(this.overlay)
    renderer.keyInput.prependListener("keypress", this.onKey)
    renderer.keyInput.prependListener("keyrelease", this.onKey)
  }

  configure(enabled: boolean): void {
    this.enabled = enabled
    this.disarm()
  }

  setTheme(theme: FxnkThemeResolution): void {
    const ramp = fxnkRamp(theme.theme)
    this.overlay.backgroundColor = ramp.surface
    this.label.fg = ramp.secondary
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.renderer.keyInput.off("keypress", this.onKey)
    this.renderer.keyInput.off("keyrelease", this.onKey)
    this.overlay.destroyRecursively()
  }

  private disarm(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.deadline = 0
    this.overlay.visible = false
    this.renderer.requestRender()
  }

  private readonly onKey = (key: KeyEvent): void => {
    if (!this.enabled || this.disposed || !key.ctrl || key.name !== "c" || key.meta || key.option || key.shift || key.super || key.hyper) return
    key.preventDefault()
    key.stopPropagation()
    // A held Kitty key must never confirm; legacy terminals cannot distinguish repeats.
    if (key.eventType !== "press" || key.repeated || this.stopping) return
    const now = performance.now()
    if (this.deadline > now) {
      this.disarm()
      this.stopping = true
      void this.stop().catch(error => {
        this.report(`confirmed exit failed: ${error instanceof Error ? error.message : String(error)}`)
        if (!this.disposed) {
          this.stopping = false
          this.label.content = "exit failed; press ctrl+c to retry"
          this.overlay.visible = true
          this.renderer.requestRender()
        }
      })
      return
    }
    this.disarm()
    this.deadline = now + EXIT_CONFIRMATION_MS
    this.label.content = "press ctrl+c again to exit"
    this.overlay.visible = true
    this.renderer.requestRender()
    this.timer = setTimeout(() => this.disarm(), EXIT_CONFIRMATION_MS)
  }
}
