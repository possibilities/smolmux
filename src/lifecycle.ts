import type { InstanceStatus } from "./protocol.ts"
import { resolveInstance } from "./instance.ts"
import { runtimeLabels, runtimeSessionName } from "./session-identity.ts"
import { CompanionCommand, spawnCompanion, type SessionEntry } from "./zmx-command.ts"
import { companionDirectory, resolveCompanion } from "./zmx-environment.ts"

const DEFAULT_RUNTIME_EXIT_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50

export type WaitForRuntimeExitOptions = {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/**
 * Wait for the Runtime described by a status captured before `instance.stop`.
 *
 * The stop response confirms App termination, but the Runtime cannot reap its
 * own host before writing that response. External owners use this second
 * barrier to confirm that exact host has ended without signalling anything.
 */
export async function waitForRuntimeExit(
  status: InstanceStatus,
  options: WaitForRuntimeExitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_EXIT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("runtime exit timeout must be a positive integer")
  }
  if (!Number.isSafeInteger(status.pid) || status.pid <= 0) {
    throw new Error(`invalid Runtime pid: ${status.pid}`)
  }

  const env = options.env ?? process.env
  const selected = resolveInstance(status.name, env)
  if (selected.id !== status.instance_id) {
    throw new Error(
      `Runtime identity mismatch: status ${status.instance_id} is not ${selected.id} selected by the current smolmux environment`,
    )
  }

  const deadline = Date.now() + timeoutMs
  if (status.host === "foreground") {
    if (status.pid === process.pid) throw new Error("a foreground Runtime cannot wait for its own process to exit")
    while (processExists(status.pid)) {
      if (Date.now() >= deadline) throw new Error(`foreground Runtime pid ${status.pid} did not exit within ${timeoutMs} ms`)
      await delay(deadline)
    }
    return
  }

  const resolved = await resolveCompanion(env)
  const companion = new CompanionCommand(
    companionDirectory(env),
    env,
    (args, commandOptions) => spawnCompanion(resolved.path, Math.max(1, deadline - Date.now()))(args, commandOptions),
  )
  const name = runtimeSessionName(status.instance_id)
  const labels = runtimeLabels(status.instance_id)
  for (;;) {
    const entry = await companion.inspect(name)
    if (entry.state === "absent") return
    if (entry.state === "live" || entry.state === "exited") {
      assertSameRuntime(entry, name, labels, status.pid)
      if (entry.state === "exited") return
    }
    if (Date.now() >= deadline) {
      throw new Error(`headless Runtime ${name} (pid ${status.pid}) did not exit within ${timeoutMs} ms`)
    }
    await delay(deadline)
  }
}

function assertSameRuntime(
  entry: SessionEntry,
  name: string,
  labels: Record<string, string>,
  pid: number,
): void {
  const owned =
    entry.name === name &&
    entry.labels.owner === labels.owner &&
    entry.labels.instance === labels.instance &&
    entry.labels.kind === labels.kind
  if (!owned) throw new Error(`Companion session ${name} does not belong to the stopped smolmux Runtime`)
  if (entry.pid !== pid) {
    throw new Error(`Companion session ${name} now belongs to pid ${entry.pid ?? "unknown"}, not stopped Runtime pid ${pid}`)
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function delay(deadline: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))))
}
