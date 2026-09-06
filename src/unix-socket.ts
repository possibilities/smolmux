import { lstat } from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, isAbsolute } from "node:path"
import { unlinkSync } from "node:fs"

/** Whether something accepts connections at `path`. Absent or refused is `false`. */
export async function listenerAnswers(path: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const timeout = setTimeout(() => resolve(false), 500)
  try {
    const connection = await Bun.connect({
      unix: path,
      socket: {
        data: () => {},
        open: (socket) => {
          clearTimeout(timeout)
          resolve(true)
          socket.end()
        },
        error: () => resolve(false),
        connectError: () => resolve(false),
        close: () => resolve(false),
      },
    })
    connection.end()
  } catch {
    resolve(false)
  }
  clearTimeout(timeout)
  return promise
}

export function removeSocketFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Missing is normal; a stale file from a crashed Runtime is why callers
    // probe before replacing the path.
  }
}

export function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EADDRINUSE"
}

/** Read-only verification; discovery never creates a directory or removes a path. */
export async function checkEventSocketOwnership(path: string, uid = userInfo().uid, allowMissing = false): Promise<void> {
  if (!isAbsolute(path)) throw new Error("event socket path must be absolute")
  const directory = await lstat(dirname(path))
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700) {
    throw new Error("event socket directory must be owned by this user with mode 0700")
  }
  let socket
  try { socket = await lstat(path) } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) {
    throw new Error("event socket must be owned by this user with mode 0600")
  }
}
