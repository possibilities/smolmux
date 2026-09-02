#!/usr/bin/env bun

import { CliRenderer } from "@opentui/core"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { AdeSocket, HomeActiveError } from "./ade-events.ts"
import { parseArgs, usage, VERSION } from "./cli.ts"
import { loadConfig } from "./config.ts"
import { RuntimeBridge } from "./runtime-bridge.ts"
import {
  RuntimeExtensionHost,
  RuntimeExtensionReceiptQueue,
} from "./runtime-extension-host.ts"
import { LifecycleRuntime } from "./lifecycle-runtime.ts"
import { doctor } from "./doctor.ts"
import { resolveFx } from "./executable.ts"
import { AgentManifest } from "./agent-manifest.ts"
import {
  reconcileAgents,
  type AgentRemoval,
  type ReconciledAgent,
  type ReconcileOutcome,
} from "./agent-reconcile.ts"
import { stringEnvironment } from "./agent-transport.ts"
import { FX_KEYBOARD_PROTOCOL } from "./fx-terminal.ts"
import { DEFAULT_FMX_NAME, resolveFmxHome, type FmxHome } from "./home.ts"
import {
  type FxnkThemeResolution,
  FxnkThemeMonitor,
  resolveFxnkTheme,
} from "./host-palette.ts"
import { Multiplexer } from "./multiplexer.ts"
import { expandTilde } from "./projects.ts"
import { loadState, saveState, type PersistedState } from "./state.ts"
import { CompanionTransportFactory } from "./companion-transport.ts"
import { CompanionCommand } from "./zmx-command.ts"
import {
  currentRuntimeCommand,
  ensureRuntimeSession,
  isRuntimeProcess,
  RUNTIME_BOOTSTRAP_ENV_VAR,
  waitForRuntimeBootstrap,
} from "./runtime-session.ts"
import {
  decodeRuntimeStartupSnapshot,
  resolveRuntimeStartupSnapshot,
  RUNTIME_STARTUP_SNAPSHOT_ENV_VAR,
  runtimeStartupEnvironment,
} from "./runtime-startup.ts"
import { concealClientCursor, revealClientCursor, runTerminalClient } from "./terminal-client.ts"
import {
  beginSynchronizedFrame,
  beginSynchronizedResizeClear,
  endSynchronizedFrame,
} from "./unused-space.ts"
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
import { ensurePrivateDirectories } from "./private-directory.ts"

async function main(): Promise<void> {
  let options
  try {
    options = parseArgs(Bun.argv.slice(2))
  } catch (error) {
    process.stderr.write(`fmx: ${errorMessage(error)}\n\n${usage()}`)
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
  const home = resolveFmxHome(options.name)
  if (options.doctor) {
    const report = await doctor(process.env, home)
    process.stdout.write(`${report.lines.join("\n")}\n`)
    process.exitCode = report.ok ? 0 : 1
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("fmx requires an interactive terminal (TTY)")
  }
  if (typeof Bun.Terminal !== "function") {
    throw new Error("fmx requires Bun 1.4 or newer")
  }

  if (!isRuntimeProcess()) {
    const releaseStartupSignals = installClientStartupSignalGuard()
    // Own the physical cursor before any asynchronous Client preflight. A
    // cold Runtime leaves the shell surface intact until its first frame, so
    // this is the only visible startup state.
    concealClientCursor()
    try {
      await startTerminalClient(
        home,
        options.agentPicker,
        options.hideSingleAgentPicker,
        releaseStartupSignals,
      )
    } finally {
      // runTerminalClient performs the complete terminal cleanup. This guard
      // covers failures before a Companion connection exists.
      releaseStartupSignals()
      revealClientCursor()
    }
    return
  }
  const bootstrapPath = process.env[RUNTIME_BOOTSTRAP_ENV_VAR]
  if (!bootstrapPath) throw new Error("fmx Runtime has no Client bootstrap path")
  await waitForRuntimeBootstrap(bootstrapPath)

  const loadedConfig = await loadConfig(home.configPath)
  for (const diagnostic of loadedConfig.diagnostics) process.stderr.write(`fmx: ${diagnostic}\n`)
  if (loadedConfig.projectRoots.length === 0) {
    throw new Error(`no project roots configured; add project_roots = ["~/code"] to ${home.configPath}`)
  }
  const workspace = await realpath(expandTilde(loadedConfig.projectRoots[0]!, homedir()))
  const fmxSession = home.name ?? DEFAULT_FMX_NAME
  const encodedStartup = process.env[RUNTIME_STARTUP_SNAPSHOT_ENV_VAR]
  const acceptedStartup = encodedStartup
    ? decodeRuntimeStartupSnapshot(encodedStartup, fmxSession)
    : await resolveRuntimeStartupSnapshot(loadedConfig, home)
  const fxPath = await resolveFx()
  const companionPath = await resolveCompanion()
  const persistedState = await loadState(home.statePath)
  let stateSave: Promise<void> = Promise.resolve()
  const persistState = () => {
    const snapshot: PersistedState = { ...persistedState }
    stateSave = stateSave.then(() => saveState(snapshot, home.statePath)).catch(() => {})
  }

  let renderer: CliRenderer | null = null
  let themeMonitor: FxnkThemeMonitor | null = null
  let app: Multiplexer | null = null
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  const adeSocket = new AdeSocket({ homeId: home.id })
  let runtimeBridge: RuntimeBridge | null = null
  let runtimeExtensionHost: RuntimeExtensionHost | null = null
  let lifecycleRuntime: LifecycleRuntime | null = null
  let transport: CompanionTransportFactory | null = null
  let manifest: AgentManifest | null = null
  let runtimeResizeHandler: (() => void) | null = null
  let runtimeTheme: FxnkThemeResolution | null = null
  let runtimeClosing = false

  try {
    // fmx's own files live in a directory only this user can reach, created
    // and checked before anything is bound into it: a socket in a
    // world-writable place can be taken by whoever gets there first once the
    // Runtime that held it exits and unlinks it.
    await ensurePrivateDirectories([privateRootDirectory()], "fmx")
    // The ADE feed is the Home's singleton; only its holder may touch the
    // Manifest, so the join runs after the bind and before anything is drawn.
    await adeSocket.start()

    // Start fx's one OSC 11 query as soon as this Runtime owns the Home, while
    // the Companion join still runs. No palette or foreground query is made.
    // Constructing the renderer starts its input parser but does not expose the
    // alternate screen, so replies can arrive while nothing has been painted.
    const createdRenderer = new CliRenderer(
      process.stdin,
      process.stdout,
      process.stdout.columns || 80,
      process.stdout.rows || 24,
      {
        exitOnCtrlC: false,
        exitSignals: [],
        useKittyKeyboard: FX_KEYBOARD_PROTOCOL,
      },
    )
    renderer = createdRenderer
    const themePort = {
      write: (sequence: string) => process.stdout.write(sequence),
      subscribeOsc: (handler: (sequence: string) => void) => createdRenderer.subscribeOsc(handler),
      prependInputHandler: (handler: (sequence: string) => boolean) =>
        createdRenderer.prependInputHandler(handler),
      removeInputHandler: (handler: (sequence: string) => boolean) =>
        createdRenderer.removeInputHandler(handler),
    }
    const themeDetection = resolveFxnkTheme(themePort)

    await ensureCompanionDirectories(companionDirectories())
    // The pair is checked once the directory is ours: `version` creates the
    // directory if it must, and a stock-built fork would create one fmx
    // refuses. An installed Companion that is not the pinned build never
    // runs; one named by the override runs with a word about it.
    const build = await companionBuild(companionPath.path)
    if (build !== COMPANION_PIN.build) {
      const message = companionMismatch(companionPath, build, PROTOCOL_VERSION)
      if (companionPath.origin !== "override") throw new Error(message)
      process.stderr.write(`fmx: ${message}\n`)
    }
    const companion = new CompanionCommand(companionDirectory(), process.env, companionPath.path)
    manifest = await AgentManifest.open(home.manifestPath, home.id)
    const runtimeSocketPath = RuntimeBridge.pathFor(adeSocket.path)
    if (acceptedStartup.runtimeExtension !== null) {
      lifecycleRuntime = await LifecycleRuntime.open({
        home,
        homeId: home.id,
        fmxSession: acceptedStartup.fmxSession,
        agentDefaults: acceptedStartup.agentDefaults,
        fxPath,
        runtimeSocketPath,
        adeBinding: (agentId) => ({ socketPath: adeSocket.path, instanceId: agentId }),
        manifest,
        companion,
        companionDirectory: companionDirectory(),
        environment: process.env,
        onError: (error, correlation) => {
          process.stderr.write(`fmx: lifecycle ${correlation}: ${errorMessage(error)}\n`)
        },
      })
    }
    const restored = await reconcileAtStartup(
      manifest,
      companion,
      runtimeSocketPath,
      lifecycleRuntime === null
        ? undefined
        : (removal) => lifecycleRuntime!.beforeRemove(removal),
    )
    transport = new CompanionTransportFactory(companion, home.id, {
      attachHints: new Map(restored.map(({ entry, session }) => [entry.agentId, session])),
    })
    const survivors = restored.map(({ entry }) => entry)
    runtimeTheme = await themeDetection
    themeMonitor = new FxnkThemeMonitor(themePort, runtimeTheme, (next) => {
      runtimeTheme = next
      if (!app) return
      // Publish the physical clear and the atomically retinted frame together.
      process.stdout.write(beginSynchronizedResizeClear(next.theme))
      app.setTheme(next)
    })
    themeMonitor.start()
    // Do not expose OpenTUI's alternate-screen setup as a blank intermediate
    // surface. Its first ordinary frame ends synchronized output after the
    // complete application has been drawn.
    process.stdout.write(beginSynchronizedFrame())
    await renderer.setupTerminal()
    // One Runtime frame is broadcast to every Client. Apply the new owner size
    // synchronously before clearing every physical terminal; input can follow
    // the resize before OpenTUI's debounced SIGWINCH handler runs, and that
    // interaction must not paint one last frame at the previous owner's size.
    // OpenTUI then repaints only the sizing owner's shared frame. Larger
    // Clients retain the field at the right and bottom.
    runtimeResizeHandler = () => {
      createdRenderer.resize(
        Math.max(1, process.stdout.columns || createdRenderer.width),
        Math.max(1, process.stdout.rows || createdRenderer.height),
      )
      // Keep the clear and the resized frame in one synchronized terminal
      // update. OpenTUI's frame closes the mode after restoring its cursor.
      process.stdout.write(beginSynchronizedResizeClear(runtimeTheme?.theme ?? "dark"))
    }
    process.stdout.on("resize", runtimeResizeHandler)

    app = new Multiplexer(renderer, {
      fxPath,
      cwd: workspace,
      keybindings: loadedConfig.keybindings,
      fmxName: home.name ?? undefined,
      manifest,
      transport,
      survivors,
      adeSocket,
      worktreeRoot: loadedConfig.worktreeRoot,
      projectRoots: loadedConfig.projectRoots,
      agentDefaults: acceptedStartup.agentDefaults,
      runtimeSocketPath,
      initialTrayWidth: persistedState.trayWidth,
      initialTrayHidden: persistedState.trayHidden,
      initialActiveAgentId: persistedState.activeAgentId,
      initialTheme: runtimeTheme,
      agentPicker: options.agentPicker,
      hideSingleAgentPicker: options.hideSingleAgentPicker,
      onTrayWidthChange: (width) => {
        persistedState.trayWidth = width
        // State persistence is an enhancement; a failed write must never
        // disturb the running session.
        persistState()
      },
      onTrayHiddenChange: (hidden) => {
        if (hidden) persistedState.trayHidden = true
        else delete persistedState.trayHidden
        persistState()
      },
      onActiveAgentChange: (agentId) => {
        if (agentId === null) {
          if (persistedState.activeAgentId === undefined) return
          delete persistedState.activeAgentId
        } else {
          if (persistedState.activeAgentId === agentId) return
          persistedState.activeAgentId = agentId
        }
        persistState()
      },
      onRecoveryCardAction: (correlation) => {
        void runtimeExtensionHost?.forwardRecoveryAction(correlation)
      },
      runtimeMemberCorrelationSource: lifecycleRuntime?.correlationSource,
      beforeDefinitiveAgentForget: lifecycleRuntime === null
        ? undefined
        : (entry, exit) => lifecycleRuntime!.beforeDefinitiveAgentForget(entry, exit),
    })
    lifecycleRuntime?.bindMultiplexer(app)

    for (const [signal, exitCode] of [
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGQUIT", 131],
      ["SIGTERM", 143],
    ] as const) {
      const handler = () => void app?.shutdown(exitCode)
      signalHandlers.set(signal, handler)
      process.once(signal, handler)
    }

    // The complete theme was fixed above, before the renderer can expose an
    // empty or partially restored application. Multiplexer holds the restored
    // Session list until every durable source and discovered identity is read.
    await app.start()
    if (acceptedStartup.runtimeExtension !== null) {
      // Readiness and a first lifecycle request may share one stdout chunk.
      // Queue retained receipts without blocking that chunk, then flush their
      // exact order once the host is ready. A crash only loses this memory;
      // the durable unacknowledged receipts remain available to recovery.
      const receiptQueue = new RuntimeExtensionReceiptQueue()
      lifecycleRuntime!.bindReceiptPublisher((receipt) => receiptQueue.publish(receipt))
      let recoveryTail: Promise<void> = Promise.resolve()
      const recoverLifecycle = () => {
        const operation = recoveryTail.then(() => lifecycleRuntime!.recover())
        recoveryTail = operation.catch(() => {})
        return operation
      }
      runtimeExtensionHost = await RuntimeExtensionHost.start(
        acceptedStartup.runtimeExtension,
        app.extension,
        {
          cwd: workspace,
          env: stringEnvironment(process.env),
          onLifecycleMessage: (message, signal) =>
            lifecycleRuntime!.acceptLifecycle(message, signal),
          onInlineLaunchSourceRequest: (request, signal) =>
            lifecycleRuntime!.acceptInlineSource(request, signal),
          onManagedLaunchMessage: (message, signal) =>
            lifecycleRuntime!.acceptManagedLaunch(message, signal),
          onDiagnostic: (error) => {
            process.stderr.write(
              `fmx: Runtime extension generation ${error.generation ?? "unknown"} degraded ` +
                `(${error.code}): ${error.message}\n`,
            )
          },
          onRestartReady: async () => {
            if (runtimeClosing) return
            try {
              await recoverLifecycle()
            } catch (error) {
              process.stderr.write(`fmx: could not replay lifecycle after Runtime-extension restart: ${errorMessage(error)}\n`)
            }
          },
        },
      )
      try {
        await receiptQueue.bind(runtimeExtensionHost)
      } catch (error) {
        process.stderr.write(
          `fmx: could not flush pre-ready lifecycle receipts; retained for replay: ${errorMessage(error)}\n`,
        )
      }
      await recoverLifecycle()
    }
    renderer.start()

    // The implementation-private MCP bridge lives beside the ADE feed under
    // its Home singleton. Do not accept control requests until
    // restored Agents, their metadata, and the selected terminal are ready.
    runtimeBridge = new RuntimeBridge(app.control, runtimeSocketPath)
    runtimeBridge.start()

    await app.waitUntilDone()
  } catch (error) {
    // Harmless before synchronization begins, and essential if setup or the
    // application constructor failed after the alternate-screen transition
    // was held but before OpenTUI could publish its first frame.
    process.stdout.write(endSynchronizedFrame())
    if (app) await app.shutdown(1)
    else renderer?.destroy()
    throw error
  } finally {
    runtimeClosing = true
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    runtimeBridge?.close()
    await lifecycleRuntime?.close()
    await runtimeExtensionHost?.close()
    // Nothing the Companion is still being asked about is waited for; what
    // is not consumed is the next start's. The Manifest's last write is.
    transport?.close()
    await manifest?.settled()
    await stateSave
    adeSocket.close()
    themeMonitor?.dispose()
    if (runtimeResizeHandler) process.stdout.off("resize", runtimeResizeHandler)
  }
}

async function startTerminalClient(
  home: FmxHome,
  agentPicker: boolean,
  hideSingleAgentPicker: boolean,
  onSignalHandlersInstalled: () => void,
): Promise<void> {
  const loadedConfig = await loadConfig(home.configPath)
  for (const diagnostic of loadedConfig.diagnostics) process.stderr.write(`fmx: ${diagnostic}\n`)
  if (loadedConfig.projectRoots.length === 0) {
    throw new Error(`no project roots configured; add project_roots = ["~/code"] to ${home.configPath}`)
  }
  const workspace = await realpath(expandTilde(loadedConfig.projectRoots[0]!, homedir()))
  const companionPath = await resolveCompanion()
  await ensureCompanionDirectories(companionDirectories())
  const build = await companionBuild(companionPath.path)
  if (build !== COMPANION_PIN.build) {
    const message = companionMismatch(companionPath, build, PROTOCOL_VERSION)
    if (companionPath.origin !== "override") throw new Error(message)
    process.stderr.write(`fmx: ${message}\n`)
  }
  const companion = new CompanionCommand(companionDirectory(), process.env, companionPath.path)
  const runtime = await ensureRuntimeSession(companion, {
    homeId: home.id,
    cwd: workspace,
    command: currentRuntimeCommand({ name: home.name, agentPicker, hideSingleAgentPicker }),
    env: stringEnvironment(process.env),
    agentPicker,
    hideSingleAgentPicker,
    prepareCreation: async () => {
      const startup = await resolveRuntimeStartupSnapshot(loadedConfig, home)
      return {
        env: runtimeStartupEnvironment(startup),
        exitOnLastClient: startup.runtimeExtension === null,
        labels: startup.runtimeExtension === null
          ? undefined
          : {
              extension: startup.runtimeExtension.registration.extension_id,
              workplace: startup.runtimeExtension.association.workplace_instance_id,
            },
      }
    },
  })
  process.exitCode = await runTerminalClient({
    socketPath: runtime.socketPath,
    bootstrapPath: runtime.bootstrapPath,
    keybindings: loadedConfig.keybindings,
    onSignalHandlersInstalled,
  })
}

/**
 * The Client conceals before config and Companion preflight, earlier than its
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

/**
 * Join the Manifest against the Companion's sessions before anything is
 * drawn: adopt what a crash left unrecorded, drop what has ended, and hand
 * back what survived for the multiplexer to attach. A join that fails is
 * reported and changes nothing — a failed read must never be taken for an
 * empty Companion — and fmx starts with nothing attached, the Agents
 * left where they are for the next start.
 */
async function reconcileAtStartup(
  manifest: AgentManifest,
  companion: CompanionCommand,
  runtimeSocketPath: string,
  beforeRemove?: (
    removal: AgentRemoval,
  ) => void | "preserve" | Promise<void | "preserve">,
): Promise<ReconciledAgent[]> {
  let outcome: ReconcileOutcome
  try {
    outcome = await reconcileAgents(manifest, companion, {
      runtimeSocketPath,
      beforeRemove,
      continueAfterRemoveFailure: beforeRemove === undefined
        ? undefined
        : (removal, error) => {
          process.stderr.write(
            `fmx: could not reconcile managed Agent ${removal.entry.zmxName}; ` +
            `preserved for lifecycle recovery: ${errorMessage(error)}\n`,
          )
        },
    })
  } catch (error) {
    process.stderr.write(`fmx: could not reconcile agents: ${errorMessage(error)}\n`)
    return []
  }
  if (outcome.cleared.length > 0) {
    process.stderr.write(`fmx: cleared ${outcome.cleared.length} stale Companion socket(s)\n`)
  }
  if (outcome.unresolved.length > 0) {
    process.stderr.write(`fmx: ${outcome.unresolved.length} Companion session(s) unreachable; left for the next start\n`)
  }
  return [...outcome.attached, ...outcome.adopted]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

await main().catch((error) => {
  process.stderr.write(`fmx: ${errorMessage(error)}\n`)
  process.exitCode = error instanceof HomeActiveError ? 2 : 1
})
