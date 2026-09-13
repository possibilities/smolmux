import { randomUUID } from "node:crypto"
import { type CliRenderer, CliRenderEvents, type Selection } from "@opentui/core"
import type { ApiRequestContext } from "./api-server.ts"
import { ExitConfirmation } from "./exit-confirmation.ts"
import { EventFeed } from "./event-feed.ts"
import { VERSION } from "./cli.ts"
import { fxnkRamp, type FxnkThemeResolution } from "./host-palette.ts"
import type { LayoutNode } from "./protocol.ts"
import {
  ApiFailure,
  type EventData,
  type EventName,
  type Method,
  type Params,
  type Result,
  type StopState,
} from "./protocol.ts"
import { Apps, type AppsOptions } from "./apps.ts"
import { METHODS } from "./protocol.ts"
import { Stage } from "./stage.ts"
import { StoppingView } from "./stopping-view.ts"

const DEFAULT_PREPARATION_TIMEOUT_MS = 5_000
const STOP_READ_METHODS = new Set<Method>([
  "state.get", "instance.status", "instance.stop", "instance.prepare.register",
  "instance.prepare.complete", "app.list", "app.capture", "layout.get",
])

export type RuntimeOptions = {
  instanceId: string
  /** The public Instance name; `default` for the unnamed one. */
  instanceName: string
  socketPath: string
  theme: FxnkThemeResolution
  host?: "headless" | "foreground"
  /** The terminal host brackets native restoration as one synchronized update. */
  beforeTerminalRestore?: () => void
  adopt?: boolean
  sessions: Omit<AppsOptions, "renderer" | "theme" | "onExit" | "onChanged" | "onState" | "onRoster">
  publish: (event: EventName, data: unknown) => void
  /** Diagnostics that belong on the Runtime's own terminal, not in a reply. */
  report?: (line: string) => void
}

/** What an Instance with no Sessions draws until a caller applies a Layout. */
export const EMPTY_LAYOUT: LayoutNode = { text: "no apps" }

/**
 * The Layout a Runtime draws before any caller has applied one: the first
 * Session, or the empty state when there are none. It is the Runtime's own
 * and follows the roster, so a human attaching to an Instance nobody has
 * arranged yet sees what is running rather than a screen that says nothing
 * is. The first `layout.apply` takes ownership and the Runtime never
 * composes one again.
 */
export function defaultLayout(names: readonly string[]): { root: LayoutNode; focus: string | null } {
  const first = names[0]
  return first ? { root: { app: first }, focus: first } : { root: EMPTY_LAYOUT, focus: null }
}

/**
 * One Instance: the Stage, the roster, and the API's handler. It owns no
 * socket and no process; `index.ts` binds the API to `handle` and holds the
 * Companion.
 */
export class Runtime {
  readonly apps: Apps
  private readonly exitConfirmation: ExitConfirmation
  readonly stage: Stage
  private readonly feed: EventFeed
  private availability: "ready" | "incomplete" | "unavailable" = "unavailable"
  private unavailableReason: string | null = "Adoption is pending"
  private theme: FxnkThemeResolution
  private shuttingDown = false
  private readonly donePromise: Promise<void>
  private resolveDone!: () => void
  private readonly selectionHandler = (selection: Selection) => this.onSelection(selection)
  private readonly resizeHandler = () => this.onResize()
  private lastStage: { cols: number; rows: number }
  /** False until a caller applies a Layout; until then the Runtime composes one. */
  private layoutOwned = false
  private applyingLayout = false
  private stopState: StopState | null = null
  private stopAttempt: Promise<StopState> | null = null
  private prepareOwner: { connectionId: number; timeoutMs: number } | null = null
  private prepareWait: {
    connectionId: number
    operationId: string
    timer: ReturnType<typeof setTimeout>
    resolve: (error: string | null) => void
  } | null = null
  private stoppingView: StoppingView | null = null

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: RuntimeOptions,
  ) {
    this.donePromise = new Promise((resolve) => {
      this.resolveDone = resolve
    })
    this.feed = new EventFeed(() => ({ state: this.status(), availability: this.availability, reason: this.unavailableReason }), options.publish)
    this.theme = options.theme
    this.apps = new Apps({
      ...options.sessions,
      renderer,
      theme: options.theme,
      onExit: (name, sessionId, exit, cause) => this.publish("session.exited", { name, sessionId, ...exit, cause }),
      onChanged: (name, sessionId, title) => {
        this.publish("session.changed", { name, sessionId, title })
        this.publishRoster()
      },
      onState: (app) => this.publish("app.state", { app }),
      onRoster: () => { this.refit(); this.publishRoster() },
    })
    this.stage = new Stage({
      renderer,
      panes: this.apps,
      theme: options.theme,
      onChanged: (cause) => this.publish("layout.changed", { layout: this.stage.view, apps: this.apps.list(), cause }),
    })
    this.exitConfirmation = new ExitConfirmation(renderer, options.theme,
      () => this.handle("instance.stop", {}), line => options.report?.(line))
    this.lastStage = this.stage.size
    this.renderer.on(CliRenderEvents.SELECTION, this.selectionHandler)
    this.renderer.on(CliRenderEvents.RESIZE, this.resizeHandler)
  }

  /**
   * Adopt what the Companion still holds, then draw the first Layout. A
   * signal can arrive during adoption, so every resumption re-checks: drawing
   * into a Stage and renderer that `shutdown` already destroyed is a
   * use-after-free in the layout tree, not a wasted frame.
   */
  async start(): Promise<void> {
    if (this.shuttingDown) return
    try {
      const outcome = this.options.adopt === false ? { adopted: 0, unresolved: [] } : await this.apps.adopt()
      if (this.shuttingDown) return
      this.availability = outcome.unresolved.length ? "incomplete" : "ready"
      this.unavailableReason = outcome.unresolved.length ? "Some Companion Sessions could not be identified during adoption" : null
      if (outcome.unresolved.length > 0) {
        this.options.report?.(
          `${outcome.unresolved.length} Companion session(s) unreachable; left for the next start`,
        )
      }
    } catch (error) {
      // A failed read must never be taken for an empty Companion: the
      // Sessions stay where they are for the next start.
      this.availability = "unavailable"
      this.unavailableReason = "Companion adoption failed"
      this.options.report?.(`could not adopt Sessions: ${message(error)}`)
    }
    if (this.shuttingDown) return
    this.applyDefaultLayout()
    this.publishRoster()
  }

  waitUntilDone(): Promise<void> {
    return this.donePromise
  }

  /** True from the first moment of teardown; nothing may write to the screen after. */
  get stopped(): boolean {
    return this.shuttingDown
  }

  /**
   * Draw the next frame in full. OpenTUI renders by diffing against what it
   * believes is on screen, and smolmux's own clear goes out behind its back, so
   * without this the next frame can decide nothing changed and leave the
   * cleared stage standing. The flag is the one OpenTUI's own clear sets;
   * there is no public spelling for it.
   */
  repaint(): void {
    if (this.shuttingDown) return
    const renderer = this.renderer as unknown as { forceFullRepaintRequested?: boolean }
    renderer.forceFullRepaintRequested = true
    this.renderer.requestRender()
  }

  setTheme(resolution: FxnkThemeResolution): void {
    if (this.shuttingDown) return
    this.theme = resolution
    this.renderer.setBackgroundColor(fxnkRamp(resolution.theme).background)
    this.stage.setTheme(resolution)
    this.exitConfirmation.setTheme(resolution)
    if (this.stopState) this.stoppingView?.update(this.stopState, resolution)
    this.apps.setTheme(resolution)
    this.renderer.requestRender()
    this.publish("theme.changed", { theme: resolution.theme })
  }

  async shutdown(exitCode = 0): Promise<void> {
    const stopping = this.stopAttempt
    if (stopping && this.stopState?.phase !== "failed" && this.stopState?.phase !== "complete") {
      try { await stopping }
      catch { /* A signal still performs its ordinary host cleanup after a failed explicit stop. */ }
    }
    return this.finishShutdown(exitCode)
  }

  private async finishShutdown(exitCode: number): Promise<void> {
    if (this.shuttingDown) return this.donePromise
    this.shuttingDown = true
    this.exitConfirmation.dispose()
    try {
      this.renderer.off(CliRenderEvents.SELECTION, this.selectionHandler)
      this.renderer.off(CliRenderEvents.RESIZE, this.resizeHandler)
      this.renderer.clearSelection()
      // Host shutdown ends local processes and lets go of Companion processes.
      // An explicit successful stop already ended both kinds above.
      try { await this.apps.shutdown() }
      finally {
        this.stoppingView?.destroy()
        this.stoppingView = null
        this.stage.destroy()
      }
    } finally {
      try { this.options.beforeTerminalRestore?.() }
      finally {
        this.renderer.destroy()
        process.exitCode = exitCode
        this.resolveDone()
      }
    }
  }

  /** The API's one way in. Params are already validated against the contract. */
  async handle(method: Method, params: unknown, context?: ApiRequestContext): Promise<unknown> {
    if (this.shuttingDown && method !== "instance.status" && method !== "state.get") {
      throw new ApiFailure("conflict", "smolmux is shutting down")
    }
    if (this.stopState && this.stopState.phase !== "complete" && !STOP_READ_METHODS.has(method)) {
      throw new ApiFailure("conflict", "the Instance is sealed for stopping")
    }
    const checked = METHODS[method].params.safeParse(params ?? {})
    if (!checked.success) throw new ApiFailure("invalid_params", checked.error.message)
    params = checked.data
    switch (method) {
      case "state.get":
        return this.feed.snapshot()
      case "instance.status":
        return this.status()
      case "instance.configure": {
        const { confirmExit } = params as Params<"instance.configure">
        this.exitConfirmation.configure(confirmExit)
        return {}
      }
      case "instance.stop": {
        return this.requestStop()
      }
      case "instance.prepare.register": {
        if (!context) throw new ApiFailure("invalid_request", "stop preparation requires an API connection")
        const timeoutMs = (params as Params<"instance.prepare.register">).timeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS
        if (this.stopAttempt) throw new ApiFailure("conflict", "stop preparation is already in progress")
        if (this.prepareOwner && this.prepareOwner.connectionId !== context.connectionId) {
          throw new ApiFailure("conflict", "another API connection owns stop preparation")
        }
        this.prepareOwner = { connectionId: context.connectionId, timeoutMs }
        return { registered: true, timeoutMs }
      }
      case "instance.prepare.complete": {
        if (!context || this.prepareOwner?.connectionId !== context.connectionId) {
          throw new ApiFailure("conflict", "this API connection does not own stop preparation")
        }
        const request = params as Params<"instance.prepare.complete">
        const waiting = this.prepareWait
        if (!waiting || waiting.operationId !== request.operationId || waiting.connectionId !== context.connectionId) {
          throw new ApiFailure("conflict", "that stop attempt is not awaiting preparation")
        }
        clearTimeout(waiting.timer)
        this.prepareWait = null
        waiting.resolve(request.error ?? null)
        return {}
      }
      case "event.subscribe":
        throw new ApiFailure("invalid_request", "Subscriptions belong to an API connection")
      case "app.create":
        return this.apps.create(params as Params<"app.create">)
      case "app.remove": {
        await this.apps.remove((params as Params<"app.remove">).name)
        return {}
      }
      case "app.restart": {
        const request = params as Params<"app.restart">
        return this.apps.restart(request.name, request.command)
      }
      case "app.list":
        return { apps: this.apps.list() }
      case "app.capture": {
        const request = params as Params<"app.capture">
        return this.apps.capture(request.name, request.scrollback ?? 0, request.sessionId)
      }
      case "app.input": {
        const request = params as Params<"app.input">
        this.apps.input(request.name, request.events, this.stage.paneOrigin(request.name), request.sessionId)
        return {}
      }
      case "layout.apply": {
        const request = params as Params<"layout.apply">
        this.applyingLayout = true
        try {
          return this.stage.apply(request.root, request.focus, {
            revision: request.revision,
            visible: request.visible,
            committed: () => { this.layoutOwned = true; this.apps.applyVisibility(request.visible) },
          })
        } finally { this.applyingLayout = false }
      }

      case "layout.get":
        return this.stage.view
      case "client.copy": {
        // The same path a mouse selection copy takes: the renderer writes OSC 52
        // into the Runtime's output and every attached Client relays it.
        const request = params as Params<"client.copy">
        return { written: this.renderer.copyToClipboardOSC52(request.text) }
      }
    }
  }

  private status(): Result<"instance.status"> {
    return {
      version: VERSION,
      pid: process.pid,
      name: this.options.instanceName,
      instance_id: this.options.instanceId,
      socket: this.options.socketPath,
      host: this.options.host ?? "headless",
      capabilities: { local: !!this.options.sessions.local, companion: !!(this.options.sessions.companion || this.options.sessions.resolveCompanion) },
      stage: this.stage.size,
      theme: this.theme.theme,
      apps: this.apps.list(),
      layout: this.stage.view,
      stop: this.stopState ? structuredClone(this.stopState) : null,
    }
  }

  /** A preparation registration owns no lifetime beyond its API connection. */
  connectionClosed(connectionId: number): void {
    if (this.prepareOwner?.connectionId !== connectionId) return
    this.prepareOwner = null
    const waiting = this.prepareWait
    if (!waiting || waiting.connectionId !== connectionId) return
    clearTimeout(waiting.timer)
    this.prepareWait = null
    waiting.resolve("Stop preparation connection closed")
  }

  /** Seal synchronously, then let every caller join this one observable attempt. */
  private requestStop(): Promise<StopState> {
    if (this.stopAttempt) return this.stopAttempt
    if (this.stopState?.phase === "complete") return Promise.resolve(structuredClone(this.stopState))

    this.apps.seal()
    const state: StopState = {
      operationId: randomUUID(),
      phase: "preparing",
      remaining: this.liveAppNames(),
      error: null,
      preparationError: null,
    }
    this.availability = "unavailable"
    this.unavailableReason = "Instance is stopping"
    this.stopState = state
    this.stoppingView ??= new StoppingView(this.renderer, this.theme)
    this.publishStop()

    let attempt!: Promise<StopState>
    attempt = this.runStop(state).finally(() => {
      if (this.stopState?.phase === "failed" && this.stopAttempt === attempt) this.stopAttempt = null
    })
    this.stopAttempt = attempt
    return attempt
  }

  private async runStop(state: StopState): Promise<StopState> {
    state.preparationError = await this.awaitPreparation(state.operationId)
    state.phase = "terminating"
    state.remaining = this.liveAppNames()
    this.publishStop()

    let survived: string[]
    try {
      survived = await this.apps.killAll()
    } catch (error) {
      state.phase = "failed"
      state.remaining = this.liveAppNames()
      state.error = `terminal cleanup failed: ${message(error)}`
      this.availability = "incomplete"
      this.unavailableReason = "Stop did not finish terminal cleanup"
      this.publishRoster()
      this.publishStop()
      throw error instanceof ApiFailure ? error : new ApiFailure("internal_error", state.error)
    }
    if (survived.length > 0) {
      state.phase = "failed"
      state.remaining = survived
      state.error = `could not end ${survived.length} Session(s): ${survived.join(", ")}`
      this.availability = "incomplete"
      this.unavailableReason = "Stop did not end every Session"
      this.publishRoster()
      this.publishStop()
      throw new ApiFailure("companion_error", `${state.error}. The Instance remains sealed; retry instance.stop to finish.`)
    }

    state.phase = "complete"
    state.remaining = []
    state.error = null
    this.publishStop()
    // The response is enqueued before this timer tears down the API socket.
    setTimeout(() => {
      void this.finishShutdown(0).catch((error) => this.options.report?.(`stop failed: ${message(error)}`))
    }, 0)
    return structuredClone(state)
  }

  private awaitPreparation(operationId: string): Promise<string | null> {
    const owner = this.prepareOwner
    if (!owner) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.prepareWait?.operationId !== operationId) return
        this.prepareWait = null
        resolve(`Stop preparation timed out after ${owner.timeoutMs} ms`)
      }, owner.timeoutMs)
      this.prepareWait = { connectionId: owner.connectionId, operationId, timer, resolve }
    })
  }

  private liveAppNames(): string[] {
    return this.apps.list()
      .filter((app) => app.session !== null || app.state === "starting" || app.state === "resuming")
      .map((app) => app.name)
      .sort()
  }

  private publishStop(): void {
    if (!this.stopState) return
    const stop = structuredClone(this.stopState)
    this.stoppingView?.update(stop, this.theme)
    this.publish("instance.stop.changed", { stop })
  }

  /**
   * The roster changed: re-fit so a new Session's Pane fills without another
   * apply. While the Layout is still the Runtime's own, it follows the roster
   * instead, so the empty state never claims nothing is running.
   */
  private refit(): void {
    if (this.shuttingDown || this.stopState) return
    if (this.applyingLayout || this.shuttingDown) return
    if (this.layoutOwned) this.stage.refit()
    else this.applyDefaultLayout()
  }

  private applyDefaultLayout(): void {
    const { root, focus } = defaultLayout(this.apps.list().map((session) => session.name))
    const current = this.stage.view
    // Nothing to publish when the composed Layout is the one already drawn.
    if (JSON.stringify(current.root) === JSON.stringify(root) && current.focus === focus) {
      this.stage.refit()
      return
    }
    const visible = root && "app" in root ? [root.app] : []
    this.applyingLayout = true
    try { this.stage.apply(root, focus, { visible, committed: () => this.apps.applyVisibility(visible) }) }
    finally { this.applyingLayout = false }
  }

  /**
   * A Runtime resize applies the new physical size to OpenTUI synchronously
   * before this runs, so the fit here is against the size that is about to be
   * drawn. Every Pane hears its own size exactly once per resize.
   */
  private onResize(): void {
    if (this.shuttingDown || this.stopState) return
    const size = this.stage.size
    this.stage.refit("resize")
    if (size.cols !== this.lastStage.cols || size.rows !== this.lastStage.rows) {
      this.lastStage = size
      this.publish("stage.changed", size)
    }
  }

  private onSelection(selection: Selection): void {
    if (this.stopState) {
      this.renderer.clearSelection()
      return
    }
    // A Pane keeps a gesture provisional until it has covered two cells.
    // Treat gestures that never cross that threshold as nothing at all.
    if (selection.isStart) {
      this.renderer.clearSelection()
      return
    }
    const text = selection.getSelectedText()
    if (!text) {
      this.renderer.clearSelection()
      return
    }
    if (this.renderer.copyToClipboardOSC52(text)) this.renderer.clearSelection()
  }

  private publishRoster(): void {
    this.publish("apps.changed", { apps: this.apps.list(), availability: this.availability, reason: this.unavailableReason })
  }

  private publish<E extends EventName>(event: E, data: EventData<E>): void {
    if (this.shuttingDown) return
    this.feed.publish(event, data)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
