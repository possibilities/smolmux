import { mkdir } from "node:fs/promises"
import { companionEnvironment } from "./zmx-environment.ts"

/**
 * The Companion's supervisor surface: `create`, `list`, `inspect`, `forget`,
 * `kill`, driven over their `--json` forms. The terminal socket is
 * `companion-client.ts`; this is everything smolmux does to a session from
 * outside it.
 */

export type SessionState = "live" | "refused" | "unreachable" | "exited" | "absent"

export type ExitRecord = {
  code: number | null
  signal: number | null
  reason: string
  endedAt: number
}

export type SessionEntry = {
  name: string
  state: SessionState
  socketPath: string | null
  /** The child's pid, not the daemon's. */
  pid: number | null
  clients: number | null
  createdAt: number | null
  /** The command as argv, recovered from the Companion's shell-quoted form. */
  command: string[] | null
  /** A plain path, decoded from the OSC 7 form the Companion reports. It is the daemon's own cwd, so a realpath. */
  cwd: string | null
  labels: Record<string, string>
  exit: ExitRecord | null
  /** Why a session is not `live`: `ConnectionRefused`, `MalformedExitRecord`, … */
  detail: string | null
}

export type CreateRequest = {
  name: string
  command: string[]
  cwd: string
  env: Record<string, string>
  labels?: Record<string, string>
  timeoutMs?: number
  scrollbackLines?: number
  /** End this session once its final attached terminal disconnects. */
  exitOnLastClient?: boolean
}

export type Created = {
  name: string
  socketPath: string
  pid: number
  createdAt: number
}

/** The Companion's stable error names for `create`. */
export type CreateErrorName =
  | "InvalidName"
  | "InvalidLabel"
  | "CommandRequired"
  | "NameTooLong"
  | "AlreadyExists"
  | "SessionUnreachable"
  | "ExecFailed"
  | "DaemonFailed"
  | "Timeout"
  | "Internal"

export class CompanionCreateError extends Error {
  constructor(
    readonly code: CreateErrorName,
    message: string,
    readonly detail: string | null,
  ) {
    super(message)
  }

  /**
   * `Timeout` is the one refusal that leaves a session behind: the daemon is
   * still starting, and what it becomes must be looked up, not assumed.
   */
  get sessionMayExist(): boolean {
    return this.code === "Timeout"
  }
}

/** The Companion process itself failed: not found, crashed, or spoke no JSON. */
export class CompanionError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message)
  }
}

export type SpawnResult = { exitCode: number | null; stdout: string; stderr: string }
export type Spawner = (args: string[], options: { cwd?: string; env: Record<string, string> }) => Promise<SpawnResult>

/**
 * How long any one Companion command may take. Without it a wedged `list` —
 * a hung connect to a half-dead socket, an unresponsive filesystem under
 * `ZMX_DIR` — leaves a Runtime that has bound its socket, told `smolmux start` it
 * was ready, and will never answer a request.
 */
export const COMPANION_COMMAND_TIMEOUT_MS = 15_000

export const spawnCompanion =
  (binary: string, timeoutMs = COMPANION_COMMAND_TIMEOUT_MS): Spawner =>
  async (args, options) => {
    const proc = Bun.spawn([binary, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    // The pipes are not awaited past the deadline: a child the Companion
    // leaves behind could hold them open after the Companion itself is gone.
    let timer: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    const answered = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr]) => ({ stdout, stderr }))
    const outcome = await Promise.race([answered, deadline])
    if (timer !== null) clearTimeout(timer)
    if (outcome === null) {
      proc.kill("SIGKILL")
      // Cancel the pipes as well as killing the child: an open read handle
      // keeps the event loop alive, so a Runtime that timed out here would
      // never exit.
      void proc.stdout?.cancel().catch(() => {})
      void proc.stderr?.cancel().catch(() => {})
      void answered.catch(() => {})
      throw new CompanionError(`Companion \`${args[0]}\` did not answer within ${timeoutMs} ms`, null, "")
    }
    return { exitCode: proc.exitCode, stdout: outcome.stdout, stderr: outcome.stderr }
  }

export class CompanionCommand {
  private readonly run: Spawner

  /** The environment for commands that start nothing: smolmux's own, made safe. */
  private readonly environment: Record<string, string>

  constructor(
    readonly directory: string,
    parentEnvironment: NodeJS.ProcessEnv,
    runner: Spawner | string,
  ) {
    this.environment = companionEnvironment(parentEnvironment, directory)
    this.run = typeof runner === "string" ? spawnCompanion(runner) : runner
  }

  /**
   * Start a session and return once its command is running. The request's
   * environment is the child's, exactly as the caller built it for fx, with
   * only the Companion's own variables replaced so the child can never be
   * created into an inherited zmx.
   */
  async create(request: CreateRequest): Promise<Created> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const args = ["create", "--json"]
    if (request.labels && Object.keys(request.labels).length > 0) {
      args.push("--labels", formatLabels(request.labels))
    }
    if (request.timeoutMs !== undefined) args.push("--timeout-ms", String(request.timeoutMs))
    if (request.exitOnLastClient) args.push("--exit-on-last-client")
    if (request.scrollbackLines !== undefined) {
      args.push("--scrollback-lines", String(request.scrollbackLines))
    }
    args.push(request.name, "--", ...request.command)
    const result = await this.run(args, { cwd: request.cwd, env: companionEnvironment(request.env, this.directory) })
    const document = parseJson(result, "create")
    if (!isRecord(document)) throw malformed("create", result)
    if (document.ok === true) {
      const created = readCreated(document)
      if (!created) throw malformed("create", result)
      return created
    }
    const name = readCreateErrorName(document.error)
    throw new CompanionCreateError(
      name,
      typeof document.message === "string" ? document.message : `create failed: ${name}`,
      typeof document.detail === "string" ? document.detail : null,
    )
  }

  /**
   * Every session in the directory, as found, deleting nothing. An empty or
   * missing directory is `[]`; anything that is not a JSON array is a
   * failure, never "no sessions" — a reconciliation that believed it would
   * drop every Session.
   */
  async list(where: Record<string, string> = {}): Promise<SessionEntry[]> {
    const args = ["list", "--json"]
    for (const [key, value] of Object.entries(where)) args.push("--where", `${key}=${value}`)
    const result = await this.run(args, { env: this.environment })
    const document = parseJson(result, "list")
    if (!Array.isArray(document)) throw malformed("list", result)
    return document.map(readEntry).filter((entry): entry is SessionEntry => entry !== null)
  }

  async inspect(name: string): Promise<SessionEntry> {
    const result = await this.run(["inspect", "--json", name], { env: this.environment })
    const entry = readEntry(parseJson(result, "inspect"))
    if (!entry) throw malformed("inspect", result)
    return entry
  }

  /** Consume a session's exit record. Asking about it afterwards is `absent`. */
  async forget(name: string): Promise<void> {
    const result = await this.run(["forget", name], { env: this.environment })
    if (result.exitCode !== 0) {
      throw new CompanionError(`forget ${name} failed: ${result.stderr.trim()}`, result.exitCode, result.stderr)
    }
  }

  /**
   * Ask the daemon to end its child. Returns when the daemon has accepted the
   * request, which is before the session is gone: the name reads `refused`
   * until the daemon has reaped, recorded, and unlinked.
   */
  async kill(name: string): Promise<void> {
    const result = await this.run(["kill", name], { env: this.environment })
    if (result.exitCode !== 0) {
      throw new CompanionError(`kill ${name} failed: ${result.stderr.trim()}`, result.exitCode, result.stderr)
    }
  }

  /** Poll `inspect` until the session settles out of `refused`/`unreachable`, or `stop` says to. */
  async settle(name: string, timeoutMs = 3000, intervalMs = 50, stop: () => boolean = () => false): Promise<SessionEntry> {
    const deadline = Date.now() + timeoutMs
    let entry = await this.inspect(name)
    while ((entry.state === "refused" || entry.state === "unreachable") && Date.now() < deadline && !stop()) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      entry = await this.inspect(name)
    }
    return entry
  }
}

/** `--labels` takes one argument of space-separated `k=v` pairs. */
export function formatLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => {
      if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`invalid label key: ${key}`)
      if (/[\s=]/.test(value)) throw new Error(`invalid label value for ${key}: ${JSON.stringify(value)}`)
      return `${key}=${value}`
    })
    .join(" ")
}

/**
 * The Companion reports a session's directory the way the shell does over
 * OSC 7: `file://<host><path>`, percent-encoded. Only a path on this host is
 * a path smolmux can use.
 */
export function decodeOsc7Cwd(value: string, hostname: string | null = null): string | null {
  if (value.startsWith("/")) return value
  const match = /^file:\/\/([^/]*)(\/.*)$/.exec(value)
  if (!match) return null
  const [, host, encoded] = match
  if (hostname !== null && host !== "" && host !== "localhost" && host !== hostname) return null
  try {
    return decodeURIComponent(encoded!)
  } catch {
    return null
  }
}

/**
 * The inverse of the Companion's `shellQuote`: an argument that needs it
 * arrives in single quotes with `'\''` for a literal quote, the rest bare.
 * The Companion caps the whole string at 256 bytes and ends a longer one with
 * `...`, so what comes back is for display: a reader must not trust it as
 * the argv.
 */
export function splitShellWords(text: string): string[] {
  const words: string[] = []
  let current = ""
  let inWord = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === "'") {
      inWord = true
      i += 1
      while (i < text.length && text[i] !== "'") current += text[i++]
      i += 1
    } else if (ch === "\\" && i + 1 < text.length) {
      inWord = true
      current += text[i + 1]
      i += 2
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current)
      current = ""
      inWord = false
      i += 1
    } else {
      inWord = true
      current += ch
      i += 1
    }
  }
  if (inWord) words.push(current)
  return words
}

const CREATE_ERROR_NAMES: readonly string[] = [
  "InvalidName",
  "InvalidLabel",
  "CommandRequired",
  "NameTooLong",
  "AlreadyExists",
  "SessionUnreachable",
  "ExecFailed",
  "DaemonFailed",
  "Timeout",
  "Internal",
]

function readCreateErrorName(value: unknown): CreateErrorName {
  return typeof value === "string" && CREATE_ERROR_NAMES.includes(value) ? (value as CreateErrorName) : "Internal"
}

function readCreated(document: Record<string, unknown>): Created | null {
  const { name, socketPath, pid, createdAt } = document
  if (typeof name !== "string" || typeof socketPath !== "string") return null
  if (typeof pid !== "number" || typeof createdAt !== "number") return null
  return { name, socketPath, pid, createdAt }
}

const SESSION_STATES: readonly string[] = ["live", "refused", "unreachable", "exited", "absent"]

export function readEntry(value: unknown): SessionEntry | null {
  if (!isRecord(value)) return null
  const { name, state } = value
  if (typeof name !== "string" || typeof state !== "string" || !SESSION_STATES.includes(state)) return null
  const labels: Record<string, string> = {}
  if (isRecord(value.labels)) {
    for (const [key, label] of Object.entries(value.labels)) {
      if (typeof label === "string") labels[key] = label
    }
  }
  let exit: ExitRecord | null = null
  if (isRecord(value.exit) && (typeof value.exit.code === "number" || value.exit.code === null)) {
    exit = {
      code: value.exit.code,
      signal: value.exit.code === null || value.exit.signal === null ? null : typeof value.exit.signal === "number" ? value.exit.signal : 0,
      reason: typeof value.exit.reason === "string" ? value.exit.reason : "unknown",
      endedAt: typeof value.exit.endedAt === "number" ? value.exit.endedAt : 0,
    }
  }
  return {
    name,
    state: state as SessionState,
    socketPath: typeof value.socketPath === "string" ? value.socketPath : null,
    pid: typeof value.pid === "number" ? value.pid : null,
    clients: typeof value.clients === "number" ? value.clients : null,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : null,
    command: typeof value.cmd === "string" ? splitShellWords(value.cmd) : null,
    cwd: typeof value.cwd === "string" ? decodeOsc7Cwd(value.cwd) : null,
    labels,
    exit,
    detail: typeof value.detail === "string" ? value.detail : null,
  }
}

function parseJson(result: SpawnResult, verb: string): unknown {
  const text = result.stdout.trim()
  if (!text) throw malformed(verb, result)
  try {
    return JSON.parse(text)
  } catch {
    throw malformed(verb, result)
  }
}

function malformed(verb: string, result: SpawnResult): CompanionError {
  const stderr = result.stderr.trim()
  return new CompanionError(
    `Companion ${verb} returned no usable JSON (exit ${result.exitCode ?? "?"})${stderr ? `: ${stderr}` : ""}`,
    result.exitCode,
    result.stderr,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
