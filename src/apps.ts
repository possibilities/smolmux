import type { FxnkThemeResolution } from "./host-palette.ts"
import { ApiFailure, appCreateSchema, type AppCreate, type AppState, type AppView, type Capture, type ExitCause, type InputEvent } from "./protocol.ts"
import type { PaneOrigin } from "./session-input.ts"
import { RESERVED_LABELS } from "./session-identity.ts"
import type { SessionExit } from "./session-transport.ts"
import { Sessions, type ExecutionView, type SessionsOptions } from "./sessions.ts"

type Command = { argv: string[]; cwd: string; env?: Record<string, string> }
type Declaration = Omit<AppCreate, "argv" | "whenHidden"> & { argv: string[] | null; whenHidden: "keep" | "stop" | "pause" }
type App = {
  spec: Declaration
  createdAt: number
  visible: boolean
  state: AppState
  error: string | null
  lastExit: AppView["lastExit"]
  cause: ExitCause
  tail: Promise<void>
  removing: boolean
}
export type AppsOptions = Omit<SessionsOptions, "onExit" | "onChanged" | "onState" | "onRoster"> & {
  onExit: (name: string, sessionId: string, status: SessionExit, cause: ExitCause) => void
  onChanged: (name: string, sessionId: string, title: string) => void
  onState: (app: AppView) => void
  onRoster: () => void
}

/** App declarations own policy; Sessions own only one execution and its emulator. */
export class Apps {
  private readonly records = new Map<string, App>()
  private readonly executions: Sessions
  private visible = new Set<string>()
  private shown = new Set<string>()
  private sealed = false
  private destroyed = false
  private adopting = false

  constructor(private readonly options: AppsOptions) {
    this.executions = new Sessions({
      ...options,
      onExit: (name, exit, id) => this.exited(name, id, exit),
      onChanged: (name, title, id) => {
        if (this.destroyed || this.executions.view(name).id !== id) return
        options.onChanged(name, id, title)
        this.publish(name)
      },
      onState: (name, state) => {
        const app = this.records.get(name)
        if (!app || app.removing || ["starting", "stopping", "pausing", "resuming"].includes(app.state)) return
        app.state = state === "live" ? "running" : state
        this.publish(name)
      },
      onRoster: () => {
        if (this.adopting) this.importAdopted()
        if (!this.destroyed) options.onRoster()
      },
    })
  }

  get names(): string[] { return [...this.records.keys()] }
  terminalFor(name: string) { return this.executions.terminalFor(name) }
  setShown(names: Iterable<string>): void {
    this.shown = new Set(names)
    this.executions.setShown(this.shown)
  }
  list(): AppView[] { return this.names.map((name) => this.view(name)) }
  view(name: string): AppView {
    const app = this.require(name)
    const execution = this.execution(name)
    const spec = app.spec
    return {
      name, pty: spec.pty, whenHidden: spec.whenHidden, cwd: spec.cwd,
      argv: spec.argv ? [...spec.argv] : null, created_at: app.createdAt,
      cols: execution?.cols ?? spec.cols ?? 80, rows: execution?.rows ?? spec.rows ?? 24,
      title: execution?.title ?? "", visible: app.visible, shown: this.shown.has(name) && execution !== null,
      state: app.state, error: app.error,
      session: execution ? { id: execution.id, pid: execution.pid, created_at: execution.created_at, state: execution.state } : null,
      lastExit: app.lastExit ? { ...app.lastExit } : null,
      labels: { ...spec.labels, owner: "smolmux", instance: this.options.instanceId, app: name },
    }
  }

  async adopt(): Promise<{ adopted: number; unresolved: string[] }> {
    this.adopting = true
    try { return await this.executions.adopt() }
    finally { this.importAdopted(); this.adopting = false }
  }

  async create(input: AppCreate): Promise<AppView> {
    this.assertOpen()
    const checked = appCreateSchema.safeParse(input)
    if (!checked.success) throw new ApiFailure("invalid_params", checked.error.message)
    const spec = checked.data
    if (this.records.has(spec.name)) throw new ApiFailure("conflict", `an App named ${spec.name} already exists`)
    for (const key of Object.keys(spec.labels ?? {})) {
      if ((RESERVED_LABELS as readonly string[]).includes(key)) throw new ApiFailure("invalid_params", `label ${key} is smolmux's own`)
    }
    const app = this.make(spec)
    this.records.set(spec.name, app)
    this.options.onRoster()
    await this.queue(app, () => this.reconcile(app))
    this.assertOpen()
    return this.view(spec.name)
  }

  /** Called only after Stage.apply has drawn and committed successfully. */
  applyVisibility(names: readonly string[]): void {
    this.visible = new Set(names)
    const changed: App[] = []
    for (const app of this.records.values()) {
      const next = this.visible.has(app.spec.name)
      if (next === app.visible) continue
      app.visible = next
      changed.push(app)
    }
    for (const app of changed) {
      this.publish(app.spec.name)
      this.discard(this.queue(app, () => this.reconcile(app)), `visibility ${app.spec.name}`)
    }
  }

  async remove(name: string): Promise<void> {
    this.assertOpen()
    const app = this.require(name)
    if (app.removing) throw new ApiFailure("conflict", `App ${name} is already being removed`)
    app.removing = true
    try {
      await this.queue(app, async () => {
        await this.stop(app, "remove")
        this.records.delete(name)
        this.options.onRoster()
      })
    } catch (error) { app.removing = false; throw error }
  }

  async restart(name: string, command?: Command): Promise<AppView> {
    this.assertOpen()
    const app = this.require(name)
    if (app.removing) throw new ApiFailure("conflict", `App ${name} is being removed`)
    if (!command && app.spec.argv === null) throw new ApiFailure("invalid_params", "Adoption cannot recover argv or environment; supply command to restart")
    await this.queue(app, async () => {
      this.assertOpen()
      await this.stop(app, "restart")
      if (command) app.spec = { ...app.spec, ...structuredClone(command), env: command.env ? { ...command.env } : undefined }
      app.state = "stopped"
      app.error = null
      this.publish(name)
      await this.reconcile(app)
    })
    return this.view(name)
  }

  capture(name: string, scrollback = 0, sessionId?: string): Capture {
    this.require(name)
    this.guard(name, sessionId)
    return this.executions.capture(name, scrollback)
  }
  input(name: string, events: readonly InputEvent[], origin: PaneOrigin | null, sessionId?: string): void {
    const app = this.require(name)
    this.guard(name, sessionId)
    if (app.state !== "running") throw new ApiFailure("not_running", `App ${name} is ${app.state}; input was not delivered`)
    this.executions.input(name, events, origin)
  }
  setTheme(theme: FxnkThemeResolution): void { this.executions.setTheme(theme) }
  seal(): void { this.sealed = true; this.executions.seal() }
  unseal(): void { this.sealed = false; this.executions.unseal() }

  async killAll(localOnly = false): Promise<string[]> {
    this.seal()
    await Promise.all([...this.records.values()].map((app) => app.tail.catch(() => {})))
    const survived: string[] = []
    await Promise.all([...this.records.values()].filter((app) => !localOnly || app.spec.pty === "local").map(async (app) => {
      try { await this.stop(app, "shutdown") }
      catch (error) {
        survived.push(app.spec.name)
        this.options.report?.(`stopping ${app.spec.name}: ${message(error)}`)
      }
    }))
    return survived.sort()
  }
  async shutdown(): Promise<void> {
    if (this.destroyed) return
    try {
      const survived = await this.killAll(true)
      await this.options.local?.close()
      if (survived.length) throw new ApiFailure("process_error", `local Apps survived shutdown: ${survived.join(", ")}`)
    } finally {
      this.destroyed = true
      this.executions.shutdown()
      this.records.clear()
    }
  }

  private make(spec: Declaration): App {
    return { spec: structuredClone(spec), createdAt: Date.now(), visible: this.visible.has(spec.name), state: "stopped", error: null, lastExit: null, cause: "natural", tail: Promise.resolve(), removing: false }
  }
  private importAdopted(): void {
    if (this.destroyed || this.sealed) return
    for (const execution of this.executions.list()) {
      let app = this.records.get(execution.name)
      if (!app) {
        app = this.make({ name: execution.name, pty: "companion", whenHidden: "keep", argv: null, cwd: execution.cwd, labels: Object.fromEntries(Object.entries(execution.labels).filter(([key]) => !(RESERVED_LABELS as readonly string[]).includes(key))) })
        app.createdAt = execution.created_at
        this.records.set(execution.name, app)
      }
      app.state = execution.state === "live" ? "running" : execution.state
    }
  }
  private async reconcile(app: App): Promise<void> {
    for (;;) {
      if (this.sealed || app.removing || this.records.get(app.spec.name) !== app) return
      const execution = this.execution(app.spec.name)
      const wantsRunning = app.visible || app.spec.whenHidden === "keep"
      if (!execution) {
        if (!wantsRunning || app.state !== "stopped") return
        if (!app.spec.argv) { this.fail(app, new Error("original command is unavailable")); return }
        this.transition(app, "starting")
        app.cause = "natural"
        try {
          await this.executions.create({ ...app.spec, argv: app.spec.argv })
          const started = this.execution(app.spec.name)
          // A short command may have exited while create was awaiting its owner.
          if (started) this.transition(app, started.state === "live" ? "running" : started.state)
        } catch (error) { this.fail(app, error); return }
        continue
      }
      if (!wantsRunning && app.spec.whenHidden === "stop") {
        try { await this.stop(app, "hidden") }
        catch (error) { this.fail(app, error); return }
        continue
      }
      const paused = !wantsRunning && app.spec.whenHidden === "pause"
      if ((execution.state === "paused") !== paused && app.spec.pty === "local") {
        this.transition(app, paused ? "pausing" : "resuming")
        try {
          await this.executions.pause(app.spec.name, paused)
          const current = this.execution(app.spec.name)
          if (current?.id === execution.id) this.transition(app, paused ? "paused" : "running")
        } catch (error) { this.fail(app, error); return }
        continue
      }
      return
    }
  }
  private async stop(app: App, cause: ExitCause): Promise<void> {
    const execution = this.execution(app.spec.name)
    if (!execution) { await this.executions.settle(app.spec.name); return }
    app.spec.cols = execution.cols
    app.spec.rows = execution.rows
    app.cause = cause
    this.transition(app, "stopping")
    try { await this.executions.kill(app.spec.name) }
    catch (error) { this.fail(app, error); throw error }
  }
  private exited(name: string, sessionId: string, status: SessionExit): void {
    const app = this.records.get(name)
    if (!app || this.destroyed) return
    const cause = app.cause
    app.lastExit = { ...status, sessionId, cause }
    app.state = cause === "natural" ? "exited" : "stopped"
    app.cause = "natural"
    this.options.onExit(name, sessionId, status, cause)
    this.publish(name)
  }
  private transition(app: App, state: AppState): void {
    app.state = state
    app.error = null
    this.publish(app.spec.name)
  }
  private fail(app: App, error: unknown): void {
    app.state = "failed"
    app.error = message(error)
    this.publish(app.spec.name)
    this.options.report?.(`App ${app.spec.name}: ${app.error}`)
  }
  private publish(name: string): void {
    if (this.destroyed || !this.records.has(name)) return
    this.options.onState(this.view(name))
    this.options.onRoster()
  }
  private queue(app: App, work: () => Promise<void>): Promise<void> {
    const result = app.tail.then(work)
    app.tail = result.catch(() => {})
    return result
  }
  private execution(name: string): ExecutionView | null {
    try { return this.executions.view(name) }
    catch (error) { if (error instanceof ApiFailure && error.code === "not_found") return null; throw error }
  }
  private guard(name: string, sessionId?: string): void {
    const current = this.execution(name)
    if (!current) throw new ApiFailure("not_running", `App ${name} has no current Session`)
    if (sessionId !== undefined && current.id !== sessionId) throw new ApiFailure("conflict", `App ${name} has a different Session`)
  }
  private require(name: string): App {
    const app = this.records.get(name)
    if (!app) throw new ApiFailure("not_found", `no App named ${name}`)
    return app
  }
  private assertOpen(): void { if (this.sealed) throw new ApiFailure("conflict", "smolmux is shutting down") }
  private discard(work: Promise<unknown>, context: string): void {
    void work.catch((error) => this.options.report?.(`${context}: ${message(error)}`))
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
