import { CliRenderer } from "@opentui/core"
import { readdir } from "node:fs/promises"
import { ApiClient } from "./api-client.ts"
import { ApiServer, apiSocketPathFor } from "./api-server.ts"
import { setListenerErrorHandler } from "./companion-client.ts"
import { CompanionTransportFactory } from "./companion-transport.ts"
import { loadConfig } from "./config.ts"
import { FxnkThemeMonitor, resolveFxnkTheme } from "./host-palette.ts"
import { instanceLogger, instanceLogPathFor } from "./instance-log.ts"
import { type Instance, resolveInstance } from "./instance.ts"
import { LocalPtyOwner } from "./local-transport.ts"
import { HOST_KEYBOARD_PROTOCOL } from "./pane-terminal.ts"
import { ensurePrivateDirectories } from "./private-directory.ts"
import { ApiFailure, eventFrame } from "./protocol.ts"
import { Runtime } from "./runtime.ts"
import { concealClientCursor, revealClientCursor } from "./terminal-client.ts"
import { beginSynchronizedFrame, beginSynchronizedResizeClear, endSynchronizedFrame } from "./unused-space.ts"
import { CompanionCommand } from "./zmx-command.ts"
import { PROTOCOL_VERSION } from "./zmx-protocol.ts"
import { COMPANION_PIN, companionBuild, companionDirectories, companionDirectory, companionMismatch, ensureCompanionDirectories, privateRootDirectory, resolveCompanion } from "./zmx-environment.ts"

export type ForegroundOptions = {
  name?: string
  /** Configuration and child environment; it is never published by the API. */
  environment?: NodeJS.ProcessEnv
  localHelper?: string
}
export type ForegroundInstance = {
  client: ApiClient
  socketPath: string
  closed: Promise<void>
  stop(): Promise<void>
}

/** Embed one physical-terminal host. All control still uses the validated API. */
export async function startForeground(options: ForegroundOptions = {}): Promise<ForegroundInstance> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("foreground smolmux requires a terminal (TTY)")
  const startupSignals = new Map<NodeJS.Signals, () => void>()
  const release = () => { for (const [signal, handler] of startupSignals) process.off(signal, handler); startupSignals.clear() }
  for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const) {
    const handler = () => { process.stdout.write(endSynchronizedFrame()); revealClientCursor(); release(); process.kill(process.pid, signal) }
    startupSignals.set(signal, handler); process.once(signal, handler)
  }
  concealClientCursor()
  const environment = options.environment ?? process.env
  try {
    return await startHost(resolveInstance(options.name ?? "default", environment), true, environment, options.localHelper, release)
  } catch (error) {
    process.stdout.write(endSynchronizedFrame())
    revealClientCursor()
    throw error
  } finally { release() }
}
export async function runHeadless(instance: Instance): Promise<void> {
  const host = await startHost(instance, false, process.env)
  await host.closed
}

async function startHost(instance: Instance, foreground: boolean, environment: NodeJS.ProcessEnv, localHelper?: string, releaseStartup?: () => void): Promise<ForegroundInstance> {
  await ensurePrivateDirectories([privateRootDirectory()], "smolmux")
  const report = instanceLogger(instanceLogPathFor(instance.id))
  setListenerErrorHandler((error) => report(`Companion listener: ${message(error)}`))
  const loaded = await loadConfig(instance.configPath)
  for (const diagnostic of loaded.diagnostics) report(diagnostic)
  let pair: { companion: CompanionCommand; transport: CompanionTransportFactory } | null = null
  let resolving: Promise<{ companion: CompanionCommand; transport: CompanionTransportFactory }> | null = null
  const getCompanion = () => {
    resolving ??= (async () => {
      const resolved = await resolveCompanion(environment)
      await ensureCompanionDirectories(companionDirectories(environment))
      const build = await companionBuild(resolved.path, environment)
      if (build !== COMPANION_PIN.build) {
        const text = companionMismatch(resolved, build, PROTOCOL_VERSION)
        if (resolved.origin !== "override") throw new Error(text)
        report(text)
      }
      const companion = new CompanionCommand(companionDirectory(environment), environment, resolved.path)
      pair = { companion, transport: new CompanionTransportFactory(companion, instance.id) }
      return pair
    })().catch((error) => { resolving = null; throw error })
    return resolving!
  }
  if (!foreground) await getCompanion()
  let adopt = !foreground
  if (foreground) {
    try { adopt = (await readdir(companionDirectory(environment))).some((name) => name.startsWith(`smolmux-${instance.id}-`)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  const socketPath = apiSocketPathFor(instance.id)
  const ready = Promise.withResolvers<void>()
  ready.promise.catch(() => {})
  let runtime: Runtime | null = null
  let renderer: CliRenderer | null = null
  let monitor: FxnkThemeMonitor | null = null
  let client: ApiClient | null = null
  let resize: (() => void) | null = null
  let terminalEnd: (() => void) | null = null
  const signals = new Map<NodeJS.Signals, () => void>()
  const local = new LocalPtyOwner({ helper: localHelper ?? environment.SMOLMUX_LOCAL_PTY_PATH, report })
  const server = new ApiServer(socketPath, async (method, params) => {
    await ready.promise
    if (!runtime) throw new ApiFailure("internal_error", "Runtime is unavailable")
    return runtime.handle(method, params)
  })
  let bound = false
  const cleanup = async () => {
    for (const [signal, handler] of signals) process.off(signal, handler)
    if (resize) process.stdout.off("resize", resize)
    if (terminalEnd) process.stdin.off("end", terminalEnd)
    monitor?.dispose()
    client?.close()
    await local.close().catch((error) => report(`local cleanup: ${message(error)}`))
    ;(pair as { transport: CompanionTransportFactory } | null)?.transport.close()
    if (bound) server.stop()
    process.stdout.write(endSynchronizedFrame())
    if (foreground) revealClientCursor()
  }
  try {
    await server.start()
    bound = true
    renderer = new CliRenderer(process.stdin, process.stdout, process.stdout.columns || 80, process.stdout.rows || 24,
      { exitOnCtrlC: false, exitSignals: [], useKittyKeyboard: HOST_KEYBOARD_PROTOCOL })
    const drawn = renderer
    const port = {
      write: (sequence: string) => process.stdout.write(sequence),
      subscribeOsc: (handler: (sequence: string) => void) => drawn.subscribeOsc(handler),
      prependInputHandler: (handler: (sequence: string) => boolean) => drawn.prependInputHandler(handler),
      removeInputHandler: (handler: (sequence: string) => boolean) => drawn.removeInputHandler(handler),
    }
    let theme = await resolveFxnkTheme(port, environment, 0)
    runtime = new Runtime(drawn, {
      instanceId: instance.id, instanceName: instance.name, socketPath, host: foreground ? "foreground" : "headless", adopt, theme,
      sessions: { instanceId: instance.id, resolveCompanion: getCompanion, local, environment, report },
      publish: (event, data) => server.broadcast(eventFrame(event, data as never)), report,
    })
    const app = runtime
    const end = (code: number) => { void app.shutdown(code).catch((error) => report(`Runtime shutdown: ${message(error)}`)) }
    for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGQUIT", 131], ["SIGTERM", 143]] as const) {
      const handler = () => end(code); signals.set(signal, handler); process.once(signal, handler)
    }
    releaseStartup?.()
    if (foreground) { terminalEnd = () => end(0); process.stdin.once("end", terminalEnd) }
    monitor = new FxnkThemeMonitor(port, theme, (next) => {
      theme = next
      if (app.stopped) return
      process.stdout.write(beginSynchronizedResizeClear(next.theme)); app.setTheme(next); app.repaint()
    })
    monitor.start()
    process.stdout.write(beginSynchronizedFrame())
    await drawn.setupTerminal()
    if (app.stopped) throw new Error("Runtime stopped during terminal setup")
    if (foreground) {
      theme = await resolveFxnkTheme(port, environment, 150)
      if (app.stopped) throw new Error("Runtime stopped during theme sampling")
      app.setTheme(theme)
    }
    resize = () => {
      if (app.stopped) return
      drawn.resize(Math.max(1, process.stdout.columns || drawn.width), Math.max(1, process.stdout.rows || drawn.height))
      process.stdout.write(beginSynchronizedResizeClear(theme.theme)); app.repaint()
    }
    process.stdout.on("resize", resize)
    drawn.start()
    await app.start()
    if (app.stopped) throw new Error("Runtime stopped during Adoption")
    ready.resolve()
    client = await ApiClient.connect(socketPath)
    const closed = app.waitUntilDone().finally(cleanup)
    closed.catch((error) => report(`Runtime cleanup: ${message(error)}`))
    const control = client
    return { client: control, socketPath, closed, stop: async () => { await control.request("instance.stop"); await closed } }
  } catch (error) {
    ready.reject(error)
    if (runtime) await runtime.shutdown(1).catch((caught) => report(`failed startup cleanup: ${message(caught)}`))
    else renderer?.destroy()
    await cleanup()
    throw error
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
