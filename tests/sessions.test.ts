import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import { CHANGE_DEBOUNCE_MS, childEnvironment, Sessions } from "../src/sessions.ts"
import type { SessionExit } from "../src/session-transport.ts"
import { sessionIdentity } from "../src/session-identity.ts"
import { FakeCompanion } from "./fixtures/fake-companion.ts"
import { PtyTransportFactory } from "./fixtures/pty-transport.ts"

const FAKE_APP = fileURLToPath(new URL("./fixtures/fake-app.ts", import.meta.url))
const INSTANCE = "0123456789ab"

async function harness() {
  const setup = await createTestRenderer({ width: 100, height: 30 })
  const companion = new FakeCompanion()
  const transport = new PtyTransportFactory()
  const exits: { name: string; exit: SessionExit }[] = []
  const changes: { name: string; title: string }[] = []
  const states: { name: string; state: "live" | "paused" | "unreachable" }[] = []
  let rosters = 0
  const sessions = new Sessions({
    renderer: setup.renderer,
    instanceId: INSTANCE,
    companion: companion.asCompanion(),
    transport,
    theme: { theme: "dark", background: null, source: "default", explicit: false },
    environment: { PATH: process.env.PATH ?? "", HOME: "/home/test", SMOLMUX_SECRET: "x", ZMX_DIR: "/tmp/z", TMUX: "outer" },
    onExit: (name, exit) => exits.push({ name, exit }),
    onChanged: (name, title) => changes.push({ name, title }),
    onState: (name, state) => states.push({ name, state }),
    onRoster: () => {
      rosters += 1
    },
  })
  return {
    setup,
    companion,
    transport,
    sessions,
    exits,
    changes,
    states,
    get rosters() {
      return rosters
    },
    close: () => {
      sessions.shutdown()
      setup.renderer.destroy()
    },
  }
}

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await Bun.sleep(10)
  }
  return check()
}

test("a child's environment is smolmux's own with its private variables removed", () => {
  const env = childEnvironment(
    { PATH: "/bin", HOME: "/home/test", SMOLMUX_RUNTIME_PROCESS: "1", ZMX_DIR: "/tmp/z", TMUX: "outer", HERDR_PANE_ID: "7" },
    { EDITOR: "vi" },
  )
  expect(env).toEqual({ PATH: "/bin", HOME: "/home/test", EDITOR: "vi" })
})

test("creates a Session, labels it, and reports it in creation order", async () => {
  const harnessed = await harness()
  try {
    const view = await harnessed.sessions.create({ name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    expect(view).toMatchObject({ name: "tray", cwd: process.cwd(), argv: [FAKE_APP], shown: false, state: "live" })
    expect(harnessed.transport.started).toHaveLength(1)
    expect(harnessed.transport.started[0]!.request.identity.companionName).toBe(`smolmux-${INSTANCE}-tray`)
    expect(harnessed.transport.started[0]!.request.identity.labels).toEqual({
      owner: "smolmux",
      instance: INSTANCE,
      app: "tray",
      session: view.id,
    })
    // The private variables never reach the child.
    expect(harnessed.transport.started[0]!.request.env.SMOLMUX_SECRET).toBeUndefined()
    expect(harnessed.transport.started[0]!.request.env.ZMX_DIR).toBeUndefined()
    expect(harnessed.transport.started[0]!.request.env.TMUX).toBeUndefined()

    await harnessed.sessions.create({ name: "notes", argv: [FAKE_APP], cwd: process.cwd() })
    expect(harnessed.sessions.list().map((session) => session.name)).toEqual(["tray", "notes"])
  } finally {
    harnessed.close()
  }
})

test("refuses a duplicate name and a label that is smolmux's own", async () => {
  const harnessed = await harness()
  try {
    await harnessed.sessions.create({ name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    await expect(harnessed.sessions.create({ name: "tray", argv: [FAKE_APP], cwd: process.cwd() })).rejects.toThrow(
      "already exists",
    )
    await expect(
      harnessed.sessions.create({ name: "other", argv: [FAKE_APP], cwd: process.cwd(), labels: { owner: "me" } }),
    ).rejects.toThrow("label owner is smolmux's own")
  } finally {
    harnessed.close()
  }
})

test("a Session that never started is dropped without an exit", async () => {
  const harnessed = await harness()
  try {
    await expect(
      harnessed.sessions.create({ name: "tray", argv: ["/definitely/missing/app"], cwd: process.cwd() }),
    ).rejects.toThrow()
    expect(harnessed.sessions.list()).toEqual([])
    expect(harnessed.exits).toEqual([])
  } finally {
    harnessed.close()
  }
})

test("captures a Session's screen, cursor, and title whether or not it is shown", async () => {
  const harnessed = await harness()
  try {
    await harnessed.sessions.create({
      name: "tray",
      argv: [FAKE_APP],
      cwd: process.cwd(),
      env: { SMOLMUX_TEST_TITLE: "the tray", SMOLMUX_TEST_BANNER: "listening" },
      cols: 40,
      rows: 8,
    })
    await waitFor(() => harnessed.sessions.capture("tray").lines.join("").includes("listening"))
    const capture = harnessed.sessions.capture("tray")
    expect(capture.name).toBe("tray")
    expect(capture.cols).toBe(40)
    expect(capture.rows).toBe(8)
    expect(capture.lines[0]).toContain("listening")
    expect(capture.title).toBe("the tray")
    expect(harnessed.sessions.view("tray").title).toBe("the tray")
  } finally {
    harnessed.close()
  }
})

test("captures history above the screen, and says where the screen begins", async () => {
  const harnessed = await harness()
  try {
    // More lines than the screen holds, so most of them scroll off.
    await harnessed.sessions.create({
      name: "long",
      argv: ["/bin/sh", "-c", "i=1; while [ $i -le 40 ]; do printf 'line %s\\r\\n' $i; i=$((i+1)); done; cat"],
      cwd: process.cwd(),
      cols: 30,
      rows: 6,
    })
    await waitFor(() => harnessed.sessions.capture("long").lines.join("").includes("line 40"))

    const visible = harnessed.sessions.capture("long")
    expect(visible.screen_start).toBe(0)
    expect(visible.lines.length).toBeLessThanOrEqual(6)
    expect(visible.lines.join("|")).not.toContain("line 1|")

    const withHistory = harnessed.sessions.capture("long", 20)
    expect(withHistory.lines.length).toBeGreaterThan(visible.lines.length)
    expect(withHistory.lines.join("|")).toContain("line 20")
    // The screen is still the tail, and screen_start points at it.
    expect(withHistory.lines.slice(withHistory.screen_start)).toEqual(visible.lines)
    // History reads in order with nothing repeated at the seams.
    const numbered = withHistory.lines.filter((line) => line.startsWith("line "))
    expect(numbered).toEqual([...new Set(numbered)])
    expect(numbered.map((line) => Number(line.slice(5)))).toEqual(
      numbered.map((line) => Number(line.slice(5))).slice().sort((left, right) => left - right),
    )
  } finally {
    harnessed.close()
  }
})

test("asking for more history than exists returns what there is", async () => {
  const harnessed = await harness()
  try {
    await harnessed.sessions.create({
      name: "short",
      argv: ["/bin/sh", "-c", "printf 'only\\r\\n'; cat"],
      cwd: process.cwd(),
      cols: 20,
      rows: 5,
    })
    await waitFor(() => harnessed.sessions.capture("short").lines.join("").includes("only"))
    const deep = harnessed.sessions.capture("short", 500)
    // The walk up clamps at the top; nothing is repeated by it.
    expect(deep.lines.filter((line) => line === "only")).toHaveLength(1)
    expect(deep.screen_start).toBe(0)
  } finally {
    harnessed.close()
  }
})

test("reading history leaves the screen where it was", async () => {
  const harnessed = await harness()
  try {
    await harnessed.sessions.create({
      name: "steady",
      argv: ["/bin/sh", "-c", "i=1; while [ $i -le 30 ]; do printf 'row %s\\r\\n' $i; i=$((i+1)); done; cat"],
      cwd: process.cwd(),
      cols: 20,
      rows: 5,
    })
    await waitFor(() => harnessed.sessions.capture("steady").lines.join("").includes("row 30"))
    const before = harnessed.sessions.capture("steady").lines
    harnessed.sessions.capture("steady", 20)
    // The viewport is put back in the same turn, so the visible screen is
    // exactly what it was and stays that way for later reads.
    expect(harnessed.sessions.capture("steady").lines).toEqual(before)
    expect(harnessed.sessions.capture("steady").lines).toEqual(before)
  } finally {
    harnessed.close()
  }
})

test("announces a change once per debounce window, not once per byte", async () => {
  const harnessed = await harness()
  try {
    await harnessed.sessions.create({ name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    await waitFor(() => harnessed.changes.length >= 1)
    const first = harnessed.changes.length
    const transport = harnessed.transport.forName("tray")!
    for (let index = 0; index < 20; index += 1) transport.write(new TextEncoder().encode("x"))
    await Bun.sleep(CHANGE_DEBOUNCE_MS * 3)
    expect(harnessed.changes.length).toBeLessThanOrEqual(first + 2)
    expect(harnessed.changes.every((change) => change.name === "tray")).toBe(true)
  } finally {
    harnessed.close()
  }
})

test("an ended Session is removed with its status and reported once", async () => {
  const harnessed = await harness()
  try {
    await harnessed.sessions.create({ name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    await waitFor(() => harnessed.sessions.capture("tray").lines.join("").includes("ready"))
    harnessed.transport.forName("tray")!.write(new TextEncoder().encode("quit\r"))
    await waitFor(() => harnessed.exits.length === 1)
    expect(harnessed.exits[0]).toMatchObject({ name: "tray", exit: { code: 7, reason: "natural" } })
    expect(harnessed.sessions.list()).toEqual([])
    expect(() => harnessed.sessions.capture("tray")).toThrow("no Session named tray")
  } finally {
    harnessed.close()
  }
})

test("a lost transport that cannot be reached leaves the Session unreachable, not gone", async () => {
  const harnessed = await harness()
  try {
    await harnessed.sessions.create({ name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    harnessed.transport.attachBehavior = "unreachable"
    harnessed.transport.forName("tray")!.lose()
    await waitFor(() => harnessed.sessions.view("tray").state === "unreachable")
    expect(harnessed.exits).toEqual([])
    expect(harnessed.transport.attaches.get("tray")).toBe(3)
  } finally {
    harnessed.close()
  }
})

test("a lost transport whose process ended removes the Session exactly as an exit would", async () => {
  const harnessed = await harness()
  try {
    await harnessed.sessions.create({ name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    harnessed.transport.attachBehavior = "ended"
    harnessed.transport.forName("tray")!.lose()
    await waitFor(() => harnessed.exits.length === 1)
    expect(harnessed.exits[0]!.exit.reason).toBe("gone")
    expect(harnessed.sessions.list()).toEqual([])
  } finally {
    harnessed.close()
  }
})

test("adoption takes the Companion's labels as the record and forgets ended residue", async () => {
  const harnessed = await harness()
  try {
    const identity = sessionIdentity(INSTANCE, "tray", { role: "list" })
    harnessed.companion.add({
      name: identity.companionName,
      labels: identity.labels,
      cwd: "/work",
      createdAt: 10,
      pid: 42,
    })
    harnessed.companion.add({ name: `smolmux-${INSTANCE}-gone`, state: "exited", labels: {} })
    harnessed.companion.add({ name: "someone-elses-session", labels: { owner: "zmx" } })
    harnessed.transport.attachBehavior = "unreachable"

    const outcome = await harnessed.sessions.adopt()
    expect(outcome.adopted).toBe(1)
    expect(harnessed.companion.forgotten).toEqual([`smolmux-${INSTANCE}-gone`])
    const view = harnessed.sessions.view("tray")
    expect(view).toMatchObject({ cwd: "/work", pid: 42, created_at: 10, state: "unreachable" })
    // An adopted Session's argv is not recoverable from the Companion's
    // shell-quoted display string.
    expect(view.argv).toBeNull()
    expect(view.labels.role).toBe("list")
  } finally {
    harnessed.close()
  }
})

test("adoption leaves a session it cannot read for the next start", async () => {
  const harnessed = await harness()
  try {
    harnessed.companion.add({ name: `smolmux-${INSTANCE}-tray`, state: "refused", labels: {} })
    harnessed.companion.add({ name: "stranger", state: "refused", labels: {} })
    const outcome = await harnessed.sessions.adopt()
    expect(outcome.adopted).toBe(0)
    expect(outcome.unresolved).toEqual([`smolmux-${INSTANCE}-tray`])
    expect(harnessed.companion.forgotten).toEqual([])
  } finally {
    harnessed.close()
  }
})

test("kill asks the Companion and lets the exit remove the Session", async () => {
  const harnessed = await harness()
  try {
    await harnessed.sessions.create({ name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    await harnessed.sessions.kill("tray")
    expect(harnessed.companion.killed).toEqual([`smolmux-${INSTANCE}-tray`])
    // Kill waits for confirmed absence even when the transport sent no Exit.
    expect(harnessed.sessions.list()).toEqual([])
    await expect(harnessed.sessions.kill("missing")).rejects.toThrow("no Session named missing")
  } finally {
    harnessed.close()
  }
})

test("input to an unreachable Session is refused rather than dropped", async () => {
  const harnessed = await harness()
  try {
    await harnessed.sessions.create({ name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    // Delivered while the transport is there.
    harnessed.sessions.input("tray", [{ text: "before" }], null)

    harnessed.transport.attachBehavior = "unreachable"
    harnessed.transport.forName("tray")!.lose()
    await waitFor(() => harnessed.sessions.view("tray").state === "unreachable")

    // Nothing carries the bytes now, and the emulator's own callback would
    // drop them silently, so success would be a lie.
    expect(() => harnessed.sessions.input("tray", [{ text: "after" }], null)).toThrowError(/unreachable/u)
    try {
      harnessed.sessions.input("tray", [{ key: "enter" }], null)
      throw new Error("expected a refusal")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("conflict")
    }

    // The screen it last had is still readable; only delivery is refused. It
    // says which it is, so a caller is never left guessing.
    expect(harnessed.sessions.capture("tray")).toMatchObject({ name: "tray", state: "unreachable" })
    // And the transition was reported rather than left to be polled for.
    expect(harnessed.states).toEqual([{ name: "tray", state: "unreachable" }])
  } finally {
    harnessed.close()
  }
})

test("a process started during shutdown stays tracked when termination fails", async () => {
  const h = await harness()
  const held = Promise.withResolvers<void>()
  h.transport.gate = held.promise
  const name = `smolmux-${INSTANCE}-late`
  h.companion.add({ name })
  h.companion.killRefuses.add(name)
  try {
    const creating = h.sessions.create({ name: "late", argv: [FAKE_APP], cwd: process.cwd() })
    const result = creating.catch(error => error)
    await waitFor(() => h.transport.started.length === 1)
    h.sessions.seal()
    held.resolve()
    expect(await result).toBeInstanceOf(Error)
    expect(h.sessions.list()).toMatchObject([{ name: "late", state: "unreachable" }])
    expect(await h.sessions.killAll()).toEqual(["late"])
    h.companion.killRefuses.clear()
    expect(await h.sessions.killAll()).toEqual([])
  } finally { held.resolve(); h.close() }
})

test("an Exit does not bypass a failed kill or the Companion release barrier", async () => {
  const h = await harness()
  const name = `smolmux-${INSTANCE}-quick`
  h.companion.add({ name })
  const originalKill = h.companion.kill.bind(h.companion)
  try {
    await h.sessions.create({ name: "quick", argv: [FAKE_APP], cwd: process.cwd() })
    h.companion.kill = async () => {
      process.kill(h.sessions.view("quick").pid!, "SIGTERM")
      await waitFor(() => h.sessions.list().length === 0)
      throw new Error("late kill refused")
    }
    await expect(h.sessions.kill("quick")).rejects.toThrow("late kill refused")
    expect(h.sessions.list()).toEqual([])
    const replacing = h.sessions.create({ name: "quick", argv: [FAKE_APP], cwd: process.cwd() })
    await Bun.sleep(80)
    expect(h.transport.started).toHaveLength(1)
    h.companion.sessions.delete(name)
    expect((await replacing).name).toBe("quick")
    expect(h.transport.started).toHaveLength(2)
  } finally { h.companion.kill = originalKill; h.close() }
})
