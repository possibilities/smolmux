import { watch, type FSWatcher } from "node:fs"
import { stat, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { OWNER_LABEL } from "./agent-reconcile.ts"
import { CompanionCreateError, type CompanionCommand, type SessionEntry } from "./zmx-command.ts"

export const RUNTIME_PROCESS_ENV_VAR = "FMX_RUNTIME_PROCESS"
export const RUNTIME_BOOTSTRAP_ENV_VAR = "FMX_RUNTIME_BOOTSTRAP_PATH"

const RUNTIME_SESSION_PREFIX = "fmxr"
const RUNTIME_SESSION_KIND = "runtime"
const BOOTSTRAP_TIMEOUT_MS = 10_000
/** A lost or unavailable filesystem notification still gets a bounded retry. */
const BOOTSTRAP_FALLBACK_POLL_MS = 250

export type RuntimeSessionIdentity = {
  name: string
  labels: Record<string, string>
  bootstrapPath: string
}

export type RuntimeSession = {
  socketPath: string
  bootstrapPath: string
}

export type RuntimeSessionRequest = {
  homeId: string
  cwd: string
  command: string[]
  env: Record<string, string>
  /** An explicit preference; false accepts either view on an existing Runtime. */
  agentPicker?: boolean
  /** An explicit picker behavior; false accepts either behavior on an existing picker Runtime. */
  hideSingleAgentPicker?: boolean
  /**
   * Cold-create-only startup authority. A live Runtime is joined before this
   * callback runs, so later disk edits cannot make its accepted snapshot
   * unjoinable.
   */
  prepareCreation?: () => Promise<RuntimeSessionPreparation>
}

export type RuntimeSessionPreparation = {
  /** Additional immutable environment accepted by the new Runtime. */
  env?: Record<string, string>
  /** Internal accepted-startup facts; never compared against later Clients. */
  labels?: Record<string, string>
}

/** One deterministic Companion session is the shared fmx Runtime for a Home. */
export function runtimeSessionIdentity(
  homeId: string,
  companionDirectory: string,
  options: { agentPicker?: boolean; hideSingleAgentPicker?: boolean } = {},
): RuntimeSessionIdentity {
  if (options.hideSingleAgentPicker && !options.agentPicker) {
    throw new Error("--hide-single-agent-picker requires --agent-picker")
  }
  const name = `${RUNTIME_SESSION_PREFIX}-${homeId}`
  return {
    name,
    labels: {
      owner: OWNER_LABEL,
      home: homeId,
      kind: RUNTIME_SESSION_KIND,
      ...(options.agentPicker ? { view: "agent-picker" } : {}),
      ...(options.hideSingleAgentPicker ? { picker: "hide-single" } : {}),
    },
    bootstrapPath: join(companionDirectory, `.${name}.bootstrap`),
  }
}

/**
 * Join the Home's live Runtime or create it. The Companion arbitrates a
 * simultaneous first launch: an AlreadyExists loser inspects and joins the
 * winner, while an unrelated session at the stable name is never touched.
 */
export async function ensureRuntimeSession(
  companion: CompanionCommand,
  request: RuntimeSessionRequest,
): Promise<RuntimeSession> {
  const identity = runtimeSessionIdentity(request.homeId, companion.directory, {
    agentPicker: request.agentPicker,
    hideSingleAgentPicker: request.hideSingleAgentPicker,
  })
  let session = await companion.settle(identity.name)
  if (session.state === "live") return attachedRuntime(identity, session)
  if (session.state === "exited") {
    assertOwnedRuntime(identity, session)
    await companion.forget(identity.name)
  } else if (session.state === "refused" || session.state === "unreachable") {
    throw new Error(`fmx Runtime is ${session.state}${session.detail ? ` (${session.detail})` : ""}`)
  }

  // A marker from an earlier Runtime must never let a new child start before
  // its first terminal has actually attached.
  await unlink(identity.bootstrapPath).catch(() => {})
  let preparation: RuntimeSessionPreparation = {}
  if (request.prepareCreation) {
    try {
      preparation = await request.prepareCreation()
    } catch (error) {
      // Another valid creator may have won while this Client resolved its
      // cold-start snapshot. Its live accepted Runtime wins over stale disk.
      try {
        session = await companion.settle(identity.name)
        if (session.state === "live") return attachedRuntime(identity, session)
      } catch {
        // Preserve the causal preparation failure below.
      }
      throw error
    }
  }
  const runtimeEnvironment = {
    ...request.env,
    ...preparation.env,
    [RUNTIME_PROCESS_ENV_VAR]: "1",
    [RUNTIME_BOOTSTRAP_ENV_VAR]: identity.bootstrapPath,
  }

  try {
    const created = await companion.create({
      name: identity.name,
      command: request.command,
      cwd: request.cwd,
      env: runtimeEnvironment,
      labels: { ...identity.labels, ...preparation.labels },
      exitOnLastClient: true,
    })
    return { socketPath: created.socketPath, bootstrapPath: identity.bootstrapPath }
  } catch (error) {
    // A racing creator owns the same deterministic Runtime. A timeout also
    // may have crossed exec even though its acknowledgement did not arrive.
    if (!(error instanceof CompanionCreateError) || (error.code !== "AlreadyExists" && !error.sessionMayExist)) {
      throw error
    }
    session = await companion.settle(identity.name)
    if (session.state !== "live") throw error
    return attachedRuntime(identity, session)
  }
}

function attachedRuntime(identity: RuntimeSessionIdentity, session: SessionEntry): RuntimeSession {
  assertOwnedRuntime(identity, session)
  assertCompatibleRuntimeView(identity, session)
  if (!session.socketPath) throw new Error(`fmx Runtime ${identity.name} has no terminal socket`)
  return { socketPath: session.socketPath, bootstrapPath: identity.bootstrapPath }
}

function assertOwnedRuntime(identity: RuntimeSessionIdentity, session: SessionEntry): void {
  const ownedLabels = { owner: OWNER_LABEL, home: identity.labels.home!, kind: RUNTIME_SESSION_KIND }
  if (session.name !== identity.name || !Object.entries(ownedLabels).every(([key, value]) => session.labels[key] === value)) {
    throw new Error(`Companion session ${identity.name} does not belong to this fmx Runtime`)
  }
}

function assertCompatibleRuntimeView(identity: RuntimeSessionIdentity, session: SessionEntry): void {
  if (identity.labels.view === "agent-picker" && session.labels.view !== "agent-picker") {
    const requestedFlags = identity.labels.picker === "hide-single"
      ? "--agent-picker --hide-single-agent-picker"
      : "--agent-picker"
    throw new Error(
      `the live fmx Runtime is using the Tray; detach every Client, then start it again with ${requestedFlags}`,
    )
  }
  if (identity.labels.picker === "hide-single" && session.labels.picker !== "hide-single") {
    throw new Error(
      "the live fmx Runtime keeps its Agent picker visible for one Agent; detach every Client, then start it again with --agent-picker --hide-single-agent-picker",
    )
  }
}

/**
 * The Runtime waits here before constructing OpenTUI. The first Client writes
 * the marker only after its terminal attach reaches Ready, so the OSC 11 theme
 * query and OpenTUI capability probes have a real host ready to answer. A failed first attach
 * cannot leave a headless Runtime behind forever.
 */
export async function waitForRuntimeBootstrap(
  path: string,
  timeoutMs = BOOTSTRAP_TIMEOUT_MS,
  fallbackPollMs = BOOTSTRAP_FALLBACK_POLL_MS,
): Promise<void> {
  if (await consumeBootstrapMarker(path)) return

  await new Promise<void>((resolve, reject) => {
    let watcher: FSWatcher | null = null
    let probing = false
    let probeAgain = false
    let finished = false

    const finish = (error: Error | null): void => {
      if (finished) return
      finished = true
      watcher?.close()
      clearInterval(fallback)
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
    const probe = async (): Promise<void> => {
      if (finished) return
      if (probing) {
        probeAgain = true
        return
      }
      probing = true
      do {
        probeAgain = false
        if (await consumeBootstrapMarker(path)) {
          finish(null)
          return
        }
      } while (probeAgain && !finished)
      probing = false
    }

    const fallback = setInterval(() => void probe(), Math.max(1, fallbackPollMs))
    const timeout = setTimeout(() => {
      // A marker arriving on the timeout boundary wins over the diagnostic.
      void consumeBootstrapMarker(path).then((ready) => {
        finish(ready ? null : new Error("the first terminal Client did not attach to the fmx Runtime"))
      })
    }, timeoutMs)

    try {
      const markerName = basename(path)
      watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
        if (filename === null || filename.toString() === markerName) void probe()
      })
      watcher.on("error", () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      // Some filesystems cannot be watched. The slow safety probe remains.
    }

    // Close the race between the first check and installing the watcher.
    void probe()
  })
}

async function consumeBootstrapMarker(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await unlink(path).catch(() => {})
    return true
  } catch {
    return false
  }
}

/** argv for this same fmx, whether it is a Bun source checkout or one binary. */
export type RuntimeCommandOptions = {
  executable?: string
  main?: string
  /** null leaves the default Runtime argv byte-for-byte unchanged. */
  name?: string | null
  /** false leaves the default Runtime argv byte-for-byte unchanged. */
  agentPicker?: boolean
  /** Valid only with agentPicker; false leaves picker Runtime argv unchanged. */
  hideSingleAgentPicker?: boolean
}

export function currentRuntimeCommand(options: RuntimeCommandOptions = {}): string[] {
  if (options.hideSingleAgentPicker && !options.agentPicker) {
    throw new Error("--hide-single-agent-picker requires --agent-picker")
  }
  const executable = options.executable ?? process.execPath
  const main = options.main ?? Bun.main
  const command = main.startsWith("/$bunfs/") ? [executable] : [executable, main]
  if (options.name) command.push("--name", options.name)
  if (options.agentPicker) command.push("--agent-picker")
  if (options.hideSingleAgentPicker) command.push("--hide-single-agent-picker")
  return command
}

export function isRuntimeProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RUNTIME_PROCESS_ENV_VAR] === "1"
}
