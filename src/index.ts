#!/usr/bin/env bun
import { runHeadless, startForeground } from "./host.ts"

import { instanceLogger, instanceLogPathFor } from "./instance-log.ts"

let headlessInstance: string | null = null

import { homedir } from "node:os"
import { ApiClient } from "./api-client.ts"
import { apiSocketPathFor, InstanceActiveError } from "./api-server.ts"
import { type CliOptions, parseArgs, usage, VERSION } from "./cli.ts"
import { loadConfig } from "./config.ts"
import { discoverEventSocket } from "./event-discovery.ts"
import { doctor } from "./doctor.ts"
import { type Instance, resolveInstance } from "./instance.ts"
import { contractDocument } from "./protocol.ts"
import {
  currentRuntimeCommand,
  ensureRuntimeSession,
  findRuntimeSession,
  waitForRuntimeApi,
} from "./runtime-session.ts"
import { stringEnvironment } from "./session-transport.ts"
import { concealClientCursor, revealClientCursor, runTerminalClient } from "./terminal-client.ts"
import { CompanionCommand } from "./zmx-command.ts"
import { PROTOCOL_VERSION } from "./zmx-protocol.ts"
import {
  COMPANION_PIN,
  companionBuild,
  companionDirectories,
  companionDirectory,
  companionMismatch,
  ensureCompanionDirectories,
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
      const report = await doctor(process.env, instance, options.localOnly)
      process.stdout.write(`${report.lines.join("\n")}\n`)
      process.exitCode = report.ok ? 0 : 1
      return
    }
    case "runtime":
      headlessInstance = instance.id
      await runHeadless(instance)
      return
    case "status":
      await printStatus(instance)
      return
    case "stop":
      await stopInstance(instance)
      return
    case "start":
      if (options.foreground) { const host = await startForeground({ name: options.name }); await host.closed }
      else await startInstance(instance, true)
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

/* ------------------------------------------------------------------ client */

async function startInstance(instance: Instance, announce: boolean): Promise<string> {
  if ((await existingHost(instance)) === "foreground") {
    if (!announce) throw new Error("this Instance owns its foreground terminal; a second terminal cannot attach")
    process.stdout.write(`${apiSocketPathFor(instance.id)}\n`)
    return ""
  }
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
      if ((await existingHost(instance)) === "foreground") throw new Error("this Instance owns its foreground terminal; a second terminal cannot attach")
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

async function existingHost(instance: Instance): Promise<"foreground" | "headless" | null> {
  let client: ApiClient
  try { client = await ApiClient.connect(apiSocketPathFor(instance.id)) }
  catch { return null }
  try { return (await client.request("instance.status")).host }
  finally { client.close() }
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
  if (headlessInstance) instanceLogger(instanceLogPathFor(headlessInstance))(`Runtime failed: ${errorMessage(error)}`)
  else process.stderr.write(`smolmux: ${errorMessage(error)}\n`)
  // A signal's exit code is the honest one: a supervisor must be able to tell
  // a signalled shutdown from a startup failure, even when teardown then threw.
  if (process.exitCode === undefined || process.exitCode === 0) {
    process.exitCode = error instanceof InstanceActiveError ? 2 : 1
  }
})
