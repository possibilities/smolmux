import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { fileURLToPath } from "node:url"
import type { EventName, InstanceStatus, LayoutView, SessionView } from "../src/protocol.ts"
import { eventSocketFrameSchema } from "../src/event-schema.ts"
import { EMPTY_LAYOUT, Runtime } from "../src/runtime.ts"
import { sessionIdentity } from "../src/session-identity.ts"
import { FakeCompanion } from "./fixtures/fake-companion.ts"
import { PtyTransportFactory } from "./fixtures/pty-transport.ts"

const FAKE_APP = fileURLToPath(new URL("./fixtures/fake-app.ts", import.meta.url))
const INSTANCE = "0123456789ab"

async function harness(prepare?: (companion: FakeCompanion, transport: PtyTransportFactory) => void) {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const companion = new FakeCompanion()
  const transport = new PtyTransportFactory()
  prepare?.(companion, transport)
  const events: { event: EventName; data: unknown }[] = []
  const runtime = new Runtime(setup.renderer, {
    instanceId: INSTANCE,
    instanceName: "default",
    socketPath: `/tmp/smolmux-test/${INSTANCE}.api`,
    theme: { theme: "dark", background: null, source: "default", explicit: false },
    sessions: {
      instanceId: INSTANCE,
      companion: companion.asCompanion(),
      transport,
      environment: { PATH: process.env.PATH ?? "", HOME: "/home/test" },
    },
    publish: (event, data) => {
      expect(eventSocketFrameSchema.safeParse({ v: 1, type: "event", event, data }).success).toBe(true)
      events.push({ event, data })
    },
  })
  await runtime.start()
  return {
    setup,
    runtime,
    companion,
    transport,
    events,
    call: <T>(method: EventName extends never ? never : Parameters<Runtime["handle"]>[0], params: unknown = {}) =>
      runtime.handle(method, params) as Promise<T>,
    close: async () => {
      await runtime.shutdown()
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

test("a fresh Instance draws its empty state and reports itself", async () => {
  const app = await harness()
  try {
    const status = await app.call<InstanceStatus>("instance.status")
    expect(status).toMatchObject({ name: "default", instance_id: INSTANCE, theme: "dark", sessions: [] })
    expect(status.stage).toEqual({ cols: 100, rows: 30 })
    expect(status.layout.root).toEqual(EMPTY_LAYOUT)
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("no sessions")
  } finally {
    await app.close()
  }
})

test("an Instance that adopted Sessions shows the first one instead of the empty state", async () => {
  const app = await harness((companion, transport) => {
    const identity = sessionIdentity(INSTANCE, "tray")
    companion.add({ name: identity.companionName, labels: identity.labels, cwd: "/work", createdAt: 10 })
    // A PTY cannot be re-attached; the Session is adopted and stays unreachable.
    transport.attachBehavior = "unreachable"
  })
  try {
    const layout = await app.call<LayoutView>("layout.get")
    expect(layout.root).toEqual({ session: "tray" })
    expect(layout.focus).toBe("tray")
  } finally {
    await app.close()
  }
})

test("the Runtime's own Layout follows the roster until a caller applies one", async () => {
  const app = await harness()
  try {
    expect((await app.call<LayoutView>("layout.get")).root).toEqual(EMPTY_LAYOUT)

    // A Session created with nobody arranging the screen is shown, rather
    // than leaving an empty state that claims nothing is running.
    await app.call("session.create", { name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    let layout = await app.call<LayoutView>("layout.get")
    expect(layout.root).toEqual({ session: "tray" })
    expect(layout.focus).toBe("tray")

    // The first apply takes ownership; the Runtime composes no more.
    await app.call("layout.apply", { root: { text: "held" }, focus: null })
    await app.call("session.create", { name: "second", argv: [FAKE_APP], cwd: process.cwd() })
    layout = await app.call<LayoutView>("layout.get")
    expect(layout.root).toEqual({ text: "held" })

    // Even back to none: an owned Layout stays the caller's.
    app.transport.forName("tray")!.write(new TextEncoder().encode("quit\r"))
    app.transport.forName("second")!.write(new TextEncoder().encode("quit\r"))
    await waitFor(async () => (await app.call<{ sessions: SessionView[] }>("session.list")).sessions.length === 0)
    expect((await app.call<LayoutView>("layout.get")).root).toEqual({ text: "held" })
  } finally {
    await app.close()
  }
})

test("an unowned Layout returns to the empty state when the last Session ends", async () => {
  const app = await harness()
  try {
    await app.call("session.create", { name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    expect((await app.call<LayoutView>("layout.get")).root).toEqual({ session: "tray" })
    app.transport.forName("tray")!.write(new TextEncoder().encode("quit\r"))
    await waitFor(async () => (await app.call<{ sessions: SessionView[] }>("session.list")).sessions.length === 0)
    const layout = await app.call<LayoutView>("layout.get")
    expect(layout.root).toEqual(EMPTY_LAYOUT)
    expect(layout.focus).toBeNull()
  } finally {
    await app.close()
  }
})

test("creates a Session, puts it on the Layout, and reports it as shown", async () => {
  const app = await harness()
  try {
    // Nobody has applied a Layout yet, so the Runtime's own one shows it.
    const created = await app.call<SessionView>("session.create", {
      name: "tray",
      argv: [FAKE_APP],
      cwd: process.cwd(),
    })
    // The result tells the truth about the screen it just landed on.
    expect(created).toMatchObject({ name: "tray", shown: true, state: "live" })

    const layout = await app.call<LayoutView>("layout.apply", {
      root: { row: [{ session: "tray", size: 26 }, { text: "no agent" }] },
      focus: "tray",
    })
    expect(layout.panes.map((pane) => [pane.session ?? pane.text, pane.cols])).toEqual([
      ["tray", 26],
      ["no agent", 73],
    ])
    const listed = await app.call<{ sessions: SessionView[] }>("session.list")
    expect(listed.sessions[0]).toMatchObject({ name: "tray", shown: true })
  } finally {
    await app.close()
  }
})

test("a Session that appears after its Pane fills it without another apply", async () => {
  const app = await harness()
  try {
    await app.call("layout.apply", { root: { row: [{ session: "tray", size: 26 }, { session: "later" }] }, focus: "tray" })
    await app.call("session.create", { name: "later", argv: [FAKE_APP], cwd: process.cwd() })
    const layout = await app.call<LayoutView>("layout.get")
    expect(layout.panes.map((pane) => pane.session)).toEqual(["tray", "later"])
    const listed = await app.call<{ sessions: SessionView[] }>("session.list")
    expect(listed.sessions.find((session) => session.name === "later")!.shown).toBe(true)
  } finally {
    await app.close()
  }
})

test("captures a Session that no Pane shows", async () => {
  const app = await harness()
  try {
    await app.call("session.create", {
      name: "hidden",
      argv: [FAKE_APP],
      cwd: process.cwd(),
      env: { SMOLMUX_TEST_BANNER: "working" },
      cols: 40,
      rows: 6,
    })
    // A Layout of the caller's that leaves it off screen; it keeps running.
    await app.call("layout.apply", { root: { text: "nothing here" }, focus: null })
    await waitFor(async () => {
      const capture = await app.call<{ lines: string[] }>("session.capture", { name: "hidden" })
      return capture.lines.join("").includes("working")
    })
    const capture = await app.call<{ lines: string[]; cols: number; rows: number }>("session.capture", { name: "hidden" })
    expect(capture.cols).toBe(40)
    expect(capture.lines[0]).toContain("working")
    const listed = await app.call<{ sessions: SessionView[] }>("session.list")
    expect(listed.sessions[0]!.shown).toBe(false)
  } finally {
    await app.close()
  }
})

test("a shown Session captures correctly after it has been drawn", async () => {
  const app = await harness()
  try {
    await app.call("session.create", {
      name: "tray",
      argv: [FAKE_APP],
      cwd: process.cwd(),
      env: { SMOLMUX_TEST_BANNER: "drawn and read" },
    })
    await app.call("layout.apply", { root: { session: "tray" }, focus: "tray" })
    await waitFor(async () => {
      const capture = await app.call<{ lines: string[] }>("session.capture", { name: "tray" })
      return capture.lines.join("").includes("drawn and read")
    })
    // A frame consumes the emulator's damage, so a capture that did not ask
    // for the whole screen would read blanks from here on.
    await app.setup.renderOnce()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const capture = await app.call<{ lines: string[] }>("session.capture", { name: "tray" })
      expect(capture.lines.join("")).toContain("drawn and read")
      await app.setup.renderOnce()
    }
    // And the frame still draws it.
    expect(app.setup.captureCharFrame()).toContain("drawn and read")
  } finally {
    await app.close()
  }
})

test("publishes the events a caller drives the surface from", async () => {
  const app = await harness()
  try {
    await app.call("session.create", { name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    await app.call("layout.apply", { root: { session: "tray" }, focus: "tray" })
    await waitFor(() => app.events.some((entry) => entry.event === "session.changed"))

    const layoutChanges = app.events.filter((entry) => entry.event === "layout.changed")
    expect(layoutChanges.length).toBeGreaterThanOrEqual(1)
    expect((layoutChanges.at(-1)!.data as { cause: string }).cause).toBe("apply")
    expect(app.events.find((entry) => entry.event === "session.changed")!.data).toMatchObject({ name: "tray" })

    app.transport.forName("tray")!.write(new TextEncoder().encode("quit\r"))
    await waitFor(() => app.events.some((entry) => entry.event === "session.exited"))
    expect(app.events.find((entry) => entry.event === "session.exited")!.data).toMatchObject({
      name: "tray",
      code: 7,
      reason: "natural",
    })
  } finally {
    await app.close()
  }
})

test("a stage resize refits and announces the new size once", async () => {
  const app = await harness()
  try {
    await app.call("session.create", { name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    await app.call("layout.apply", { root: { session: "tray" }, focus: "tray" })
    app.events.length = 0
    app.setup.resize(60, 20)
    await Bun.sleep(50)
    const stageChanges = app.events.filter((entry) => entry.event === "stage.changed")
    expect(stageChanges).toHaveLength(1)
    expect(stageChanges[0]!.data).toMatchObject({ cols: 60, rows: 20 })
    expect((await app.call<LayoutView>("layout.get")).stage).toEqual({ cols: 60, rows: 20 })
  } finally {
    await app.close()
  }
})

test("kill goes to the Companion and the exit removes the Session", async () => {
  const app = await harness()
  try {
    await app.call("session.create", { name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    await app.call("session.kill", { name: "tray" })
    expect(app.companion.killed).toEqual([`smolmux-${INSTANCE}-tray`])
    await expect(app.call("session.capture", { name: "missing" })).rejects.toThrow("no Session named missing")
  } finally {
    await app.close()
  }
})

test("stop ends every Session, then answers, then ends the Runtime", async () => {
  const app = await harness()
  try {
    await app.call("session.create", { name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    expect(await app.call<Record<string, never>>("instance.stop")).toEqual({})
    expect(app.events.some((entry) => entry.event === "instance.stopping")).toBe(true)
    await app.runtime.waitUntilDone()
    expect(app.companion.killed).toEqual([`smolmux-${INSTANCE}-tray`])
  } finally {
    await app.close()
  }
})

test("a signal during adoption stops before drawing into a destroyed Stage", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30 })
  const companion = new FakeCompanion()
  const identity = sessionIdentity(INSTANCE, "tray")
  companion.add({ name: identity.companionName, labels: identity.labels, cwd: "/work", createdAt: 10 })
  const transport = new PtyTransportFactory()
  // Hold adoption inside its attach, the way a real `list` or `settle` holds it.
  const held = Promise.withResolvers<never>()
  transport.attachBehavior = () => held.promise
  const runtime = new Runtime(setup.renderer, {
    instanceId: INSTANCE,
    instanceName: "default",
    socketPath: "/tmp/smolmux-test/api",
    theme: { theme: "dark", background: null, source: "default", explicit: false },
    sessions: { instanceId: INSTANCE, companion: companion.asCompanion(), transport, environment: {} },
    publish: () => {},
  })

  const starting = runtime.start()
  await Bun.sleep(20)
  // The signal path: everything is destroyed under the still-running start.
  await runtime.shutdown(143)
  held.reject(new Error("the Companion is not answering"))
  // start() must return without touching the Stage or the renderer.
  await starting
  expect(runtime.stopped).toBe(true)
})

test("a stop seals creation so nothing starts after the kills went out", async () => {
  const app = await harness()
  try {
    // A create the caller queued behind another one, the way a pipelined
    // connection does.
    const first = app.call("session.create", { name: "first", argv: [FAKE_APP], cwd: process.cwd() })
    const second = app.call("session.create", { name: "second", argv: [FAKE_APP], cwd: process.cwd() })
    await app.call("instance.stop")
    await first.catch(() => {})
    await expect(second).rejects.toMatchObject({ code: "conflict" })
    await app.runtime.waitUntilDone()

    // Whatever was created was killed; nothing started after the stop.
    const started = app.transport.started.map((entry) => entry.request.identity.name)
    for (const name of started) expect(app.companion.killed).toContain(`smolmux-${INSTANCE}-${name}`)
  } finally {
    await app.close()
  }
})

test("an adopted Session that answers on a second try is not left unreachable", async () => {
  const attempts: string[] = []
  const app = await harness((companion, transport) => {
    const identity = sessionIdentity(INSTANCE, "tray")
    companion.add({ name: identity.companionName, labels: identity.labels, cwd: "/work", createdAt: 10 })
    transport.attachBehavior = (asked) => {
      attempts.push(asked.name)
      // A daemon mid-reap refuses once, then answers.
      if (attempts.length === 1) throw new Error("the Companion is not answering")
      return new PtyTransportFactory().start({
        identity: asked,
        command: [FAKE_APP],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        size: { cols: 80, rows: 24 },
      })
    }
  })
  try {
    await waitFor(() => app.runtime.sessions.list()[0]?.state === "live")
    expect(attempts.length).toBeGreaterThan(1)
  } finally {
    await app.close()
  }
})

test("adoption hands the endpoint it already read to the first attach", async () => {
  const app = await harness((companion, transport) => {
    const identity = sessionIdentity(INSTANCE, "tray")
    companion.add({ name: identity.companionName, labels: identity.labels, cwd: "/work", createdAt: 10 })
    transport.attachBehavior = "unreachable"
  })
  try {
    // The listing already knew where it was; nothing looks it up again.
    expect(app.transport.endpoints[0]).toBe(`/tmp/smolmux-${INSTANCE}-tray.sock`)
  } finally {
    await app.close()
  }
})

test("a repaint after an external clear forces a full frame", async () => {
  const app = await harness()
  try {
    const renderer = app.setup.renderer as unknown as { forceFullRepaintRequested: boolean }
    await app.setup.renderOnce()
    expect(renderer.forceFullRepaintRequested).toBe(false)
    // smolmux's own clear goes straight to the terminal, so the next frame has to
    // be told to draw everything rather than diffing against a screen that is
    // no longer there.
    app.runtime.repaint()
    expect(renderer.forceFullRepaintRequested).toBe(true)
  } finally {
    await app.close()
  }
})

test("a theme change retints in one pass and says so", async () => {
  const app = await harness()
  try {
    app.runtime.setTheme({ theme: "light", background: "#ffffff", source: "osc11", explicit: false })
    expect(app.events.filter((entry) => entry.event === "theme.changed")).toMatchObject([
      { event: "theme.changed", data: { theme: "light" } },
    ])
    expect((await app.call<InstanceStatus>("instance.status")).theme).toBe("light")
  } finally {
    await app.close()
  }
})

test("stop that cannot end a Session says so and stays up", async () => {
  const app = await harness()
  try {
    await app.call("session.create", { name: "tray", argv: [FAKE_APP], cwd: process.cwd() })
    await app.call("session.create", { name: "dock", argv: [FAKE_APP], cwd: process.cwd() })
    app.companion.killRefuses.add(`smolmux-${INSTANCE}-tray`)

    // Reporting success would leave a live process nothing is managing and a
    // caller who believes it is gone.
    await expect(app.call("instance.stop")).rejects.toMatchObject({ code: "companion_error" })
    expect(app.events.some((entry) => entry.event === "instance.stopping")).toBe(false)

    // Still there to retry against, and still saying what is left.
    expect(app.runtime.stopped).toBe(false)
    expect(await app.call("session.list")).toBeDefined()

    // The seal came off, so the Instance is usable rather than a zombie.
    await app.call("session.create", { name: "third", argv: [FAKE_APP], cwd: process.cwd() })

    // Retrying against the same Instance finishes once the Companion lets go.
    app.companion.killRefuses.clear()
    expect(await app.call<Record<string, never>>("instance.stop")).toEqual({})
    await app.runtime.waitUntilDone()
  } finally {
    await app.close()
  }
})

test("client.copy writes one OSC 52 through the renderer and keeps nothing", async () => {
  const app = await harness()
  try {
    expect(await app.call<{ written: boolean }>("client.copy", { text: "copied" })).toEqual({ written: true })
    // Nothing is stored: the status is the same Runtime as before.
    const status = await app.call<InstanceStatus>("instance.status")
    expect(status).toMatchObject({ name: "default", sessions: [] })
  } finally {
    await app.close()
  }
})

test("event snapshots distinguish failed adoption, unknown inventory, and known unreachable Sessions", async () => {
  for (const scenario of ["failed", "unknown", "unreachable"] as const) {
    const app = await harness((companion, transport) => {
      if (scenario === "failed") {
        companion.list = async () => { throw new Error("source unavailable") }
      } else {
        const identity = sessionIdentity(INSTANCE, "survivor")
        companion.add({ name: identity.companionName, labels: identity.labels, state: scenario === "unknown" ? "unreachable" : "live" })
        transport.attachBehavior = "unreachable"
      }
    })
    try {
      const snapshot = await app.call<import("../src/protocol.ts").StateSnapshot>("state.get")
      expect(snapshot.availability).toBe(scenario === "failed" ? "unavailable" : scenario === "unknown" ? "incomplete" : "ready")
      expect(snapshot.state?.sessions.length).toBe(scenario === "unreachable" ? 1 : 0)
      if (scenario === "unreachable") expect(snapshot.state?.sessions[0]?.state).toBe("unreachable")
      else expect(snapshot.reason).toBeTruthy()
    } finally { await app.close() }
  }
})
