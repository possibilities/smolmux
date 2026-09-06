#!/usr/bin/env bun

import { CliRenderer } from "@opentui/core"
import { homedir } from "node:os"
import { ApiClient } from "./api-client.ts"
import { ApiServer, apiSocketPathFor, InstanceActiveError } from "./api-server.ts"
import { type CliOptions, parseArgs, usage, VERSION } from "./cli.ts"
import { setListenerErrorHandler } from "./companion-client.ts"
import { CompanionTransportFactory } from "./companion-transport.ts"
import { loadConfig } from "./config.ts"
import { discoverEventSocket } from "./event-discovery.ts"
import { doctor } from "./doctor.ts"
import {
  FxnkThemeMonitor,
  type FxnkThemeResolution,
  resolveFxnkTheme,
} from "./host-palette.ts"
import { instanceLogger, instanceLogPathFor } from "./instance-log.ts"
import { type Instance, resolveInstance } from "./instance.ts"
import { HOST_KEYBOARD_PROTOCOL } from "./pane-terminal.ts"
import { ensurePrivateDirectories } from "./private-directory.ts"
import { ApiFailure, contractDocument, type EventName, eventFrame, type Method } from "./protocol.ts"
import { Runtime } from "./runtime.ts"
import {
  currentRuntimeCommand,
  ensureRuntimeSession,
  findRuntimeSession,
  waitForRuntimeApi,
} from "./runtime-session.ts"
import { stringEnvironment } from "./session-transport.ts"
import { concealClientCursor, revealClientCursor, runTerminalClient } from "./terminal-client.ts"
import {
  beginSynchronizedFrame,
  beginSynchronizedResizeClear,
  endSynchronizedFrame,
} from "./unused-space.ts"
import { CompanionCommand } from "./zmx-command.ts"
import { PROTOCOL_VERSION } from "./zmx-protocol.ts"
import {
  COMPANION_PIN,
  companionBuild,
  companionDirectories,
  companionDirectory,
  companionMismatch,
  ensureCompanionDirectories,
  privateRootDirectory,
  resolveCompanion,
} from "./zmx-environment.ts"

async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(Bun.argv.slice(2))
  } catch (error) {
    process.stderr.write(`smolmux: ${errorMessage(error)}\n\n${usage()}`)
    process.exitCode = 2
    return
  }

  if (options.help) {
    process.stdout.write(usage())
    return
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  const instance = resolveInstance(options.name)

  switch (options.command) {
    case "event-socket":
      process.stdout.write(`${await discoverEventSocket(instance)}\n`)
      return
    case "api":
      process.stdout.write(`${JSON.stringify(contractDocument(), null, 2)}\n`)
      return
    case "doctor": {
      const report = await doctor(process.env, instance)
      process.stdout.write(`${report.lines.join("\n")}\n`)
      process.exitCode = report.ok ? 0 : 1
      return
    }
    case "runtime":
      await runRuntime(instance)
      return
    case "status":
      await printStatus(instance)
      return
    case "stop":
      await stopInstance(instance)
      return
    case "start":
      await startInstance(instance, true)
      return
    case "attach":
      await attachClient(instance, false)
      return
    case null:
      await attachClient(instance, true)
      return
  }
}

/* ----------------------------------------------------------------- runtime */

async function runRuntime(instance: Instance): Promise<void> {
  const loadedConfig = await loadConfig(instance.configPath)
  for (const diagnostic of loadedConfig.diagnostics) process.stderr.write(`smolmux: ${diagnostic}\n`)

  const socketPath = apiSocketPathFor(instance.id)
  const report = instanceLogger(instanceLogPathFor(instance.id))
  // The Companion's listener failures would otherwise reach console.error,
  // which for a headless Runtime is the screen.
  setListenerErrorHandler((error) => report(`companion listener failed: ${errorMessage(error)}`))
  const companionPath = await resolveCompanion()

  let renderer: CliRenderer | null = null
  let themeMonitor: FxnkThemeMonitor | null = null
  let runtime: Runtime | null = null
  let apiServer: ApiServer | null = null
  let transport: CompanionTransportFactory | null = null
  let resizeHandler: (() => void) | null = null
  let theme: FxnkThemeResolution | null = null
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  const ready = Promise.withResolvers<void>()
  // A request that arrives while Sessions are still being adopted waits for
  // them rather than being told they do not exist.
  ready.promise.catch(() => {})

  try {
    // smolmux's own files live in a directory only this user can reach, created
    // and checked before anything is bound into it: a socket in a
    // world-writable place can be taken by whoever gets there first once the
    // Runtime that held it exits and unlinks it.
    await ensurePrivateDirectories([privateRootDirectory()], "smolmux")
    await ensureCompanionDirectories(companionDirectories())
    const build = await companionBuild(companionPath.path)
    if (build !== COMPANION_PIN.build) {
      const message = companionMismatch(companionPath, build, PROTOCOL_VERSION)
      if (companionPath.origin !== "override") throw new Error(message)
      process.stderr.write(`smolmux: ${message}\n`)
    }
    const companion = new CompanionCommand(companionDirectory(), process.env, companionPath.path)

    const createdRenderer = new CliRenderer(
      process.stdin,
      process.stdout,
      process.stdout.columns || 80,
      process.stdout.rows || 24,
      { exitOnCtrlC: false, exitSignals: [], useKittyKeyboard: HOST_KEYBOARD_PROTOCOL },
    )
    renderer = createdRenderer
    const themePort = {
      write: (sequence: string) => process.stdout.write(sequence),
      subscribeOsc: (handler: (sequence: string) => void) => createdRenderer.subscribeOsc(handler),
      prependInputHandler: (handler: (sequence: string) => boolean) => createdRenderer.prependInputHandler(handler),
      removeInputHandler: (handler: (sequence: string) => boolean) => createdRenderer.removeInputHandler(handler),
    }
    // The Runtime starts with no terminal to answer an OSC 11 query, so it
    // takes the environment's word and the first Client corrects it.
    theme = await resolveFxnkTheme(themePort, process.env, 0)

    // The API socket is the Instance singleton: claimed before anything is
    // adopted, so two Runtimes can never hold the same Sessions.
    apiServer = new ApiServer(socketPath, async (method: Method, params: unknown) => {
      await ready.promise
      if (!runtime) throw new ApiFailure("internal_error", "the Runtime is not ready")
      return runtime.handle(method, params)
    })
    await apiServer.start()
    const server = apiServer

    transport = new CompanionTransportFactory(companion, instance.id)
    runtime = new Runtime(createdRenderer, {
      instanceId: instance.id,
      instanceName: instance.name,
      socketPath,
      theme,
      sessions: { instanceId: instance.id, companion, transport, environment: process.env, report },
      publish: (event: EventName, data: unknown) => server.broadcast(eventFrame(event, data as never)),
      report,
    })
    const app = runtime

    themeMonitor = new FxnkThemeMonitor(themePort, theme, (next) => {
      theme = next
      // Nothing may open a synchronized update once teardown has begun: no
      // frame would follow to publish it, leaving every Client's terminal in
      // synchronized-output mode with a concealed cursor.
      if (app.stopped) return
      // Publish the physical clear and the atomically retinted frame together.
      process.stdout.write(beginSynchronizedResizeClear(next.theme))
      app.setTheme(next)
      app.repaint()
    })
    themeMonitor.start()

    for (const [signal, exitCode] of [
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGQUIT", 131],
      ["SIGTERM", 143],
    ] as const) {
      const handler = () => {
        void app.shutdown(exitCode).catch((error) => report(`shutdown failed: ${errorMessage(error)}`))
      }
      signalHandlers.set(signal, handler)
      process.once(signal, handler)
    }

    // Do not expose OpenTUI's alternate-screen setup as a blank intermediate
    // surface. Its first ordinary frame ends synchronized output after the
    // complete application has been drawn.
    process.stdout.write(beginSynchronizedFrame())
    await createdRenderer.setupTerminal()
    // One Runtime frame is broadcast to every Client. Apply the new owner size
    // synchronously before clearing every physical terminal; input can follow
    // the resize before OpenTUI's debounced SIGWINCH handler runs, and that
    // interaction must not paint one last frame at the previous owner's size.
    resizeHandler = () => {
      if (app.stopped) return
      createdRenderer.resize(
        Math.max(1, process.stdout.columns || createdRenderer.width),
        Math.max(1, process.stdout.rows || createdRenderer.height),
      )
      process.stdout.write(beginSynchronizedResizeClear(theme?.theme ?? "dark"))
      // OpenTUI renders by diffing against what it believes is on screen, and
      // this clear went out behind its back. Without a forced repaint a
      // same-size resize leaves the cleared stage standing.
      app.repaint()
    }
    process.stdout.on("resize", resizeHandler)
    createdRenderer.start()

    await app.start()
    ready.resolve()
    await app.waitUntilDone()
  } catch (error) {
    process.stdout.write(endSynchronizedFrame())
    ready.reject(error instanceof Error ? error : new Error(String(error)))
    if (runtime) await runtime.shutdown(1)
    else renderer?.destroy()
    throw error
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    transport?.close()
    apiServer?.stop()
    themeMonitor?.dispose()
    if (resizeHandler) process.stdout.off("resize", resizeHandler)
  }
}

/* ------------------------------------------------------------------ client */

async function startInstance(instance: Instance, announce: boolean): Promise<string> {
  const companionPath = await resolveCompanion()
  await ensureCompanionDirectories(companionDirectories())
  const build = await companionBuild(companionPath.path)
  if (build !== COMPANION_PIN.build) {
    const message = companionMismatch(companionPath, build, PROTOCOL_VERSION)
    if (companionPath.origin !== "override") throw new Error(message)
    process.stderr.write(`smolmux: ${message}\n`)
  }
  const companion = new CompanionCommand(companionDirectory(), process.env, companionPath.path)
  const runtime = await ensureRuntimeSession(companion, {
    instanceId: instance.id,
    cwd: homedir(),
    command: currentRuntimeCommand({ name: instance.name }),
    env: stringEnvironment(process.env),
  })
  const socketPath = apiSocketPathFor(instance.id)
  if (!(await waitForRuntimeApi(socketPath))) {
    throw new Error(`the smolmux Runtime did not answer ${socketPath}`)
  }
  if (announce) process.stdout.write(`${socketPath}\n`)
  return runtime.socketPath
}

async function attachClient(instance: Instance, startIfNeeded: boolean): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("smolmux attach requires an interactive terminal (TTY)")
  }
  if (typeof Bun.Terminal !== "function") throw new Error("smolmux requires Bun 1.4 or newer")

  const loadedConfig = await loadConfig(instance.configPath)
  for (const diagnostic of loadedConfig.diagnostics) process.stderr.write(`smolmux: ${diagnostic}\n`)

  const releaseStartupSignals = installClientStartupSignalGuard()
  // Own the physical cursor before any asynchronous Client preflight. A cold
  // Runtime leaves the shell surface intact until its first frame, so this is
  // the only visible startup state.
  concealClientCursor()
  try {
    let terminalSocket: string
    if (startIfNeeded) {
      terminalSocket = await startInstance(instance, false)
    } else {
      const companionPath = await resolveCompanion()
      await ensureCompanionDirectories(companionDirectories())
      const companion = new CompanionCommand(companionDirectory(), process.env, companionPath.path)
      const session = await findRuntimeSession(companion, instance.id)
      if (!session?.socketPath) {
        throw new Error(`no smolmux Runtime is running for ${instance.name}; run \`smolmux start\` first`)
      }
      terminalSocket = session.socketPath
    }
    process.exitCode = await runTerminalClient({
      socketPath: terminalSocket,
      keybindings: loadedConfig.keybindings,
      onSignalHandlersInstalled: releaseStartupSignals,
    })
  } finally {
    // runTerminalClient performs the complete terminal cleanup. This guard
    // covers failures before a Companion connection exists.
    releaseStartupSignals()
    revealClientCursor()
  }
}

async function printStatus(instance: Instance): Promise<void> {
  const client = await connect(instance)
  try {
    process.stdout.write(`${JSON.stringify(await client.request("instance.status"), null, 2)}\n`)
  } finally {
    client.close()
  }
}

async function stopInstance(instance: Instance): Promise<void> {
  const client = await connect(instance)
  try {
    await client.request("instance.stop")
  } finally {
    client.close()
  }
}

async function connect(instance: Instance): Promise<ApiClient> {
  const socketPath = apiSocketPathFor(instance.id)
  try {
    return await ApiClient.connect(socketPath)
  } catch {
    throw new Error(`no smolmux Runtime is running for ${instance.name} (${socketPath})`)
  }
}

/**
 * The Client conceals before Companion preflight, earlier than its
 * connection-level signal handlers can exist. Keep that gap safe, then remove
 * these temporary handlers only after runTerminalClient owns every signal.
 */
function installClientStartupSignalGuard(): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>()
  let active = true
  const release = (): void => {
    if (!active) return
    active = false
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
  for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const) {
    const handler = () => {
      revealClientCursor()
      release()
      // Preserve the shell-visible meaning of a signal received before the
      // Client can translate it into its ordinary numeric exit outcome.
      process.kill(process.pid, signal)
    }
    handlers.set(signal, handler)
    process.once(signal, handler)
  }
  return release
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

await main().catch((error) => {
  process.stderr.write(`smolmux: ${errorMessage(error)}\n`)
  // A signal's exit code is the honest one: a supervisor must be able to tell
  // a signalled shutdown from a startup failure, even when teardown then threw.
  if (process.exitCode === undefined || process.exitCode === 0) {
    process.exitCode = error instanceof InstanceActiveError ? 2 : 1
  }
})
