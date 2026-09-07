import type { CompanionCommand, CreateRequest, SessionEntry } from "../../src/zmx-command.ts"

/**
 * The Companion's supervisor surface as a table: what `list`, `inspect`,
 * `kill`, and `forget` answer, without a daemon on the machine. The terminal
 * side stays the transport fixture's.
 */
export class FakeCompanion {
  readonly sessions = new Map<string, SessionEntry>()
  readonly killed: string[] = []
  readonly forgotten: string[] = []
  readonly created: CreateRequest[] = []

  constructor(readonly directory = "/tmp/fake-companion") {}

  add(entry: Partial<SessionEntry> & { name: string }): SessionEntry {
    const full: SessionEntry = {
      state: "live",
      socketPath: `/tmp/${entry.name}.sock`,
      pid: 100 + this.sessions.size,
      clients: 0,
      createdAt: 1000 + this.sessions.size,
      command: ["/bin/sh"],
      cwd: "/work",
      labels: {},
      exit: null,
      detail: null,
      ...entry,
    }
    this.sessions.set(full.name, full)
    return full
  }

  asCompanion(): CompanionCommand {
    return this as unknown as CompanionCommand
  }

  async list(): Promise<SessionEntry[]> {
    return [...this.sessions.values()]
  }

  async inspect(name: string): Promise<SessionEntry> {
    return (
      this.sessions.get(name) ?? {
        name,
        state: "absent",
        socketPath: null,
        pid: null,
        clients: null,
        createdAt: null,
        command: null,
        cwd: null,
        labels: {},
        exit: null,
        detail: null,
      }
    )
  }

  async settle(name: string): Promise<SessionEntry> {
    return this.inspect(name)
  }

  async create(request: CreateRequest): Promise<{ name: string; socketPath: string; pid: number; createdAt: number }> {
    this.created.push(request)
    const entry = this.add({
      name: request.name,
      labels: request.labels ?? {},
      cwd: request.cwd,
      command: request.command,
    })
    return { name: entry.name, socketPath: entry.socketPath!, pid: entry.pid!, createdAt: entry.createdAt! }
  }

  /** Names whose kill refuses, so a test can hold a Session against a stop. */
  killRefuses = new Set<string>()

  async kill(name: string): Promise<void> {
    if (this.killRefuses.has(name)) throw new Error(`kill ${name} refused`)
    this.killed.push(name)
    this.sessions.delete(name)
  }

  async forget(name: string): Promise<void> {
    this.forgotten.push(name)
    this.sessions.delete(name)
  }
}
