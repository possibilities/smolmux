import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { CompanionTransportFactory } from "../src/companion-transport.ts"
import {
  SessionEndedError,
  SessionUnreachableError,
  type SessionExit,
  type SessionTransport,
  type TransportHandlers,
} from "../src/session-transport.ts"
import { sessionIdentity, type SessionIdentity } from "../src/session-identity.ts"
import { CompanionCommand, CompanionCreateError, type SessionEntry } from "../src/zmx-command.ts"

/**
 * The Companion behind the Session transport seam, against the real binary:
 * what the Runtime sees when it starts, attaches to, loses, and outlives a
 * Session. Needs SMOLMUX_ZMX_PATH; sessions live in a private directory under
 * /tmp and every one this file starts is ended by it.
 */
const ZMX = process.env.SMOLMUX_ZMX_PATH
const ENABLED = Boolean(ZMX && existsSync(ZMX))
// The decoder also gates against the previous pin before the feature lands.
// Enable the handoff proofs when running against the candidate/new pin.
const MIGRATION_ENABLED = ENABLED && process.env.SMOLMUX_RUN_MIGRATION_TESTS === "1"
const INSTANCE = "0123456789ab"

const decoder = new TextDecoder()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(50)
  }
  return check()
}

const CHILD_SCRIPT = [
  "echo READY",
  'while IFS= read -r l; do case "$l" in',
  "  quit) exit 7;;",
  '  *) echo "got:$l";;',
  "esac; done",
].join("\n")

let dir = ""
let companion: CompanionCommand
let factory: CompanionTransportFactory

/** A consumer of one transport: everything it was told, in order. */
type Watcher = {
  text: string
  restores: number
  readies: number
  exited: SessionExit | null
  lost: Error | null
}

const watch = (transport: SessionTransport): Watcher => {
  const watcher: Watcher = { text: "", restores: 0, readies: 0, exited: null, lost: null }
  const handlers: TransportHandlers = {
    output: (bytes) => {
      watcher.text += decoder.decode(bytes)
    },
    restoreBegin: () => {
      watcher.restores += 1
      // A restore replaces the screen, as the Session's own reset does.
      watcher.text = ""
    },
    ready: () => {
      watcher.readies += 1
    },
    exit: (status) => {
      watcher.exited = status
    },
    lost: (error) => {
      watcher.lost = error
    },
  }
  transport.bind(handlers)
  return watcher
}

const liveSession = (identity: SessionIdentity, socketPath: string): SessionEntry => ({
  name: identity.companionName,
  state: "live",
  socketPath,
  pid: 1,
  clients: 0,
  createdAt: 1,
  command: ["/bin/sh"],
  cwd: "/work",
  labels: identity.labels,
  exit: null,
  detail: null,
})

const start = (identity: SessionIdentity): Promise<SessionTransport> =>
  factory.start({
    identity,
    command: ["/bin/sh", "-c", CHILD_SCRIPT],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm" },
    size: { cols: 80, rows: 24 },
  })

const migrate = async (name: string) => {
  const proc = Bun.spawn([ZMX!, "migrate", name], {
    env: { ...process.env, ZMX_DIR: dir }, stdout: "pipe", stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect({ code, error: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, error: "" })
}

beforeAll(async () => {
  if (!ENABLED) return
  dir = await mkdtemp("/tmp/smolmuxz-tr-")
  companion = new CompanionCommand(dir, { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, ZMX!)
  factory = new CompanionTransportFactory(companion, INSTANCE, { scrollbackLines: 200 })
})

afterAll(async () => {
  if (!ENABLED) return
  for (const session of await companion.list()) {
    if (session.state === "live") await companion.kill(session.name).catch(() => {})
  }
  // A kill is accepted before it is done: the name reads `refused` until the
  // daemon has reaped, recorded, and unlinked.
  await waitFor(
    async () => (await companion.list()).every((session) => session.state === "exited" || session.state === "absent"),
    8000,
  )
  for (const session of await companion.list()) {
    if (session.state === "exited") await companion.forget(session.name).catch(() => {})
  }
  expect(await companion.list()).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

test.skipIf(!MIGRATION_ENABLED)("repeated handoffs preserve process and IO, then propagate unknown exit through Transport", async () => {
  const identity = sessionIdentity(INSTANCE, "handoff-live")
  let transport = await start(identity)
  let seen = watch(transport)
  try {
    expect(await waitFor(() => seen.text.includes("READY"))).toBe(true)
    const pid = (await companion.inspect(identity.companionName)).pid
    for (let handoff = 0; handoff < 2; handoff++) {
      await migrate(identity.companionName)
      expect(await waitFor(() => seen.lost !== null)).toBe(true)
      expect(seen.exited).toBeNull()
      transport.detach()
      expect((await companion.inspect(identity.companionName)).pid).toBe(pid)
      transport = await factory.attach(identity, { cols: 80, rows: 24 })
      seen = watch(transport)
      expect(await waitFor(() => seen.readies === 1 && seen.text.includes("READY"))).toBe(true)
      transport.write(new TextEncoder().encode(`after-${handoff}\n`))
      expect(await waitFor(() => seen.text.includes(`got:after-${handoff}`))).toBe(true)
    }
    transport.write(new TextEncoder().encode("quit\n"))
    expect(await waitFor(() => seen.exited !== null)).toBe(true)
    expect(seen.exited).toEqual({ code: null, signal: null, reason: "natural" })
  } finally { transport.detach() }
}, 30_000)

test.skipIf(!MIGRATION_ENABLED)("a migrated exit record retains null status through recovery", async () => {
  const identity = sessionIdentity(INSTANCE, "handoff-record")
  const trigger = `${dir}/logs/exit-now`
  await companion.create({
    name: identity.companionName,
    command: ["/bin/sh", "-c", 'while [ ! -f "$1" ]; do sleep 0.05; done; exit 7', "sh", trigger],
    cwd: dir, env: { PATH: process.env.PATH ?? "" }, labels: identity.labels,
  })
  await migrate(identity.companionName)
  await Bun.write(trigger, "exit")
  expect(await waitFor(async () => (await companion.inspect(identity.companionName)).state === "exited")).toBe(true)
  const entry = await companion.inspect(identity.companionName)
  expect(entry.exit).toMatchObject({ code: null, signal: null, reason: "natural" })
  await expect(factory.attach(identity, { cols: 80, rows: 24 })).rejects.toMatchObject({ exit: { code: null, signal: null, reason: "natural" } })
}, 15_000)

test.skipIf(!ENABLED)("start creates a labelled session, attaches with a restore, and writes through", async () => {
  const identity = sessionIdentity(INSTANCE, "one", { role: "list" })
  const transport = await start(identity)
  const watcher = watch(transport)
  await waitFor(() => watcher.readies === 1 && watcher.text.includes("READY"))
  expect(watcher.restores).toBe(1)
  const session = await companion.inspect(identity.companionName)
  expect(session.state).toBe("live")
  expect(session.labels).toEqual({ role: "list", owner: "smolmux", instance: INSTANCE, app: "one", session: identity.id })
  expect(session.clients).toBe(1)

  transport.write(new TextEncoder().encode("hello\n"))
  await waitFor(() => watcher.text.includes("got:hello"))
  transport.detach()
  await waitFor(async () => (await companion.inspect(identity.companionName)).clients === 0)
  // A detach lets go; it never ends the process.
  expect((await companion.inspect(identity.companionName)).state).toBe("live")
})

test.skipIf(!ENABLED)("attach replays the whole terminal onto a reconnecting consumer", async () => {
  const identity = sessionIdentity(INSTANCE, "two")
  const first = await start(identity)
  const opening = watch(first)
  await waitFor(() => opening.readies === 1)
  first.write(new TextEncoder().encode("remembered\n"))
  await waitFor(() => opening.text.includes("got:remembered"))
  first.detach()

  const second = await factory.attach(identity, { cols: 80, rows: 24 })
  const reconnected = watch(second)
  await waitFor(() => reconnected.readies === 1 && reconnected.text.includes("got:remembered"))
  expect(reconnected.restores).toBe(1)
  second.detach()
})

test.skipIf(!ENABLED)("an ended Session reports its status and consumes its exit record", async () => {
  const identity = sessionIdentity(INSTANCE, "three")
  const transport = await start(identity)
  const watcher = watch(transport)
  await waitFor(() => watcher.readies === 1)
  transport.write(new TextEncoder().encode("quit\n"))
  await waitFor(() => watcher.exited !== null)
  expect(watcher.exited).toMatchObject({ code: 7, signal: 0, reason: "natural" })
  await waitFor(async () => (await companion.inspect(identity.companionName)).state === "absent")
})

test.skipIf(!ENABLED)("attaching to a Session that ended is an ended error, not an unreachable one", async () => {
  const identity = sessionIdentity(INSTANCE, "four")
  const transport = await start(identity)
  const watcher = watch(transport)
  await waitFor(() => watcher.readies === 1)
  transport.write(new TextEncoder().encode("quit\n"))
  await waitFor(() => watcher.exited !== null)
  await expect(factory.attach(identity, { cols: 80, rows: 24 })).rejects.toBeInstanceOf(SessionEndedError)
})

test.skipIf(!ENABLED)("a reconciled live endpoint attaches without another Companion inspection", async () => {
  const identity = sessionIdentity(INSTANCE, "five")
  const created = await companion.create({
    name: identity.companionName,
    command: ["/bin/sh", "-c", CHILD_SCRIPT],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm" },
    labels: identity.labels,
    scrollbackLines: 200,
  })
  const inspections: string[] = []
  const watched = new CompanionTransportFactory(
    new Proxy(companion, {
      get(target, property, receiver) {
        if (property === "inspect" || property === "settle") {
          return (name: string) => {
            inspections.push(name)
            return Reflect.get(target, property, receiver).call(target, name)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    }) as CompanionCommand,
    INSTANCE,
  )
  const transport = await watched.attach(identity, { cols: 80, rows: 24 }, { socketPath: created.socketPath })
  expect(inspections).toEqual([])
  transport.detach()
})

test.skipIf(!ENABLED)("a session under our name that is not ours is left alone", async () => {
  const identity = sessionIdentity(INSTANCE, "six")
  await companion.create({
    name: identity.companionName,
    command: ["/bin/sh", "-c", CHILD_SCRIPT],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm" },
    labels: { owner: "smolmux", instance: "stranger", session: "six" },
    scrollbackLines: 200,
  })
  await expect(factory.attach(identity, { cols: 80, rows: 24 })).rejects.toBeInstanceOf(SessionEndedError)
  // Refused, never ended: the foreign process keeps running.
  expect((await companion.inspect(identity.companionName)).state).toBe("live")
})

test.skipIf(!ENABLED)("a reattach keeps the visible screen exactly, and loses at most one screenful of history", async () => {
  // What a Restore replays is what a Session's history can ever hold, and
  // `app.capture`'s scrollback reads that same emulator. The Companion's
  // restore serializer clears the visible screen between the scrollback pass
  // and the viewport, which costs the screenful just above the viewport;
  // measured at the pinned build as exactly `rows` lines. Asserting a bound
  // rather than the number means a Companion that fixes it still passes.
  const { createTestRenderer } = await import("@opentui/core/testing")
  const { PaneTerminalRenderable } = await import("../src/pane-terminal.ts")
  const identity = sessionIdentity(INSTANCE, "nine")
  const rows = 8
  const cols = 40
  const setup = await createTestRenderer({ width: 60, height: 12 })
  const pane = (id: string) => {
    const terminal = new PaneTerminalRenderable(setup.renderer, {
      id,
      cols,
      rows,
      position: "absolute",
      left: 0,
      top: 0,
      width: cols,
      height: rows,
      visible: true,
      maxScrollback: 10_000_000,
    })
    setup.renderer.root.add(terminal)
    return terminal
  }
  const feed = (terminal: InstanceType<typeof PaneTerminalRenderable>, transport: SessionTransport) =>
    transport.bind({
      output: (bytes) => terminal.write(bytes),
      restoreBegin: () => terminal.write(new Uint8Array([0x1b, 0x63])),
      ready: () => {},
      exit: () => {},
      lost: () => {},
    })
  const numbered = (terminal: InstanceType<typeof PaneTerminalRenderable>) =>
    terminal.captureScreen(cols, rows, 400).lines.filter((line) => /^L\d+$/u.test(line))

  const live = pane("live")
  const first = await factory.start({
    identity,
    command: ["/bin/sh", "-c", "i=1; while [ $i -le 120 ]; do printf 'L%s\\r\\n' $i; i=$((i+1)); done; cat"],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm" },
    size: { cols, rows },
  })
  feed(live, first)
  await waitFor(() => numbered(live).includes("L120"))
  const before = numbered(live)
  const visibleBefore = live.captureScreen(cols, rows).lines
  first.detach()
  // The daemon releases a client after the detach reaches it, so reattaching
  // before that races its teardown.
  await waitFor(async () => (await companion.inspect(identity.companionName)).clients === 0)

  const rejoined = pane("rejoined")
  const second = await factory.attach(identity, { cols, rows })
  feed(rejoined, second)
  await waitFor(() => numbered(rejoined).includes("L120"))
  const after = numbered(rejoined)
  const lost = before.filter((line) => !after.includes(line))

  // The viewport itself always survives; a consumer reading the screen is safe.
  expect(rejoined.captureScreen(cols, rows).lines).toEqual(visibleBefore)
  expect(lost.length).toBeLessThanOrEqual(rows)
  // Whatever is kept is still in order, with nothing duplicated at the seam.
  expect(after).toEqual([...new Set(after)])
  second.detach()
  setup.renderer.destroy()
}, 30_000)

test("a create that may have started anyway is unreachable, not a failure", async () => {
  const identity = sessionIdentity(INSTANCE, "seven")
  const timedOut = new CompanionTransportFactory(
    {
      directory: "/tmp/none",
      create: async () => {
        throw new CompanionCreateError("Timeout", "create timed out", null)
      },
      settle: async () => liveSession(identity, "/tmp/nothing-listens-here.sock"),
      inspect: async () => liveSession(identity, "/tmp/nothing-listens-here.sock"),
    } as unknown as CompanionCommand,
    INSTANCE,
  )
  await expect(
    timedOut.start({
      identity,
      command: ["/bin/sh"],
      cwd: "/tmp",
      env: {},
      size: { cols: 80, rows: 24 },
    }),
  ).rejects.toBeInstanceOf(SessionUnreachableError)
})

test("a create that proves nothing started is a plain failure", async () => {
  const identity = sessionIdentity(INSTANCE, "eight")
  const failed = new CompanionTransportFactory(
    {
      directory: "/tmp/none",
      create: async () => {
        throw new CompanionCreateError("Timeout", "create timed out", null)
      },
      settle: async () => ({ ...liveSession(identity, ""), state: "exited" as const, socketPath: null }),
    } as unknown as CompanionCommand,
    INSTANCE,
  )
  await expect(
    failed.start({ identity, command: ["/bin/sh"], cwd: "/tmp", env: {}, size: { cols: 80, rows: 24 } }),
  ).rejects.toBeInstanceOf(CompanionCreateError)
})
