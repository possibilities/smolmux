import { lstat, readdir } from "node:fs/promises"
import { userInfo } from "node:os"
import { join } from "node:path"
import { ApiClient } from "../../src/api-client.ts"
import { checkEventSocketOwnership } from "../../src/unix-socket.ts"
import type { InstanceStatus } from "../../src/protocol.ts"
import type { Discovery, InstanceSummary } from "./wire.ts"

export const socketDirectory = `/tmp/smolmux-${userInfo().uid}`
export const instancePattern = /^[a-f0-9]{12}$/u

export function identify(status: InstanceStatus, id: string, path: string): void {
  if (status.instance_id !== id || status.socket !== path)
    throw new Error("The socket does not identify the requested Instance.")
}

/** Read-only discovery across configuration directories. No Companion commands or residue cleanup. */
export async function discoverInstances(directory = socketDirectory): Promise<Discovery> {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.uid !== userInfo().uid || (info.mode & 0o777) !== 0o700) {
      return {
        instances: [],
        skipped: 0,
        warning: "The smolmux socket directory must belong to you and have mode 0700.",
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { instances: [], skipped: 0, warning: null }
    throw error
  }
  const entries = (await readdir(directory)).filter((name) => /^[a-f0-9]{12}\.api$/u.test(name))
  const instances: InstanceSummary[] = []
  let cursor = 0
  let skipped = 0
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      for (;;) {
        const file = entries[cursor++]
        if (!file) return
        let client: ApiClient | undefined
        try {
          const path = join(directory, file)
          await checkEventSocketOwnership(path)
          client = await ApiClient.connect(path, { timeoutMs: 1000 })
          const status = await client.request("instance.status")
          const id = file.slice(0, -4)
          identify(status, id, path)
          instances.push({
            id,
            name: status.name,
            host: status.host,
            apps: status.apps.length,
            running: status.apps.filter((app) => app.state === "running").length,
            hidden: status.apps.filter((app) => !app.visible).length,
          })
        } catch {
          skipped++
        } finally {
          client?.close()
        }
      }
    }),
  )
  return {
    instances: instances.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    skipped,
    warning: null,
  }
}
