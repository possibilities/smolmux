import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AdeSocket } from "../src/ade-events.ts"
import { AgentManifest, identityFor, type ManifestEntry } from "../src/agent-manifest.ts"
import type { AgentExit, AgentTransport, TerminalSize, TransportHandlers } from "../src/agent-transport.ts"
import type { Snapshot } from "../src/control-protocol.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer } from "../src/multiplexer.ts"
import { record as feedRecord, TestAdeSocket } from "./fixtures/ade-feed.ts"
import { createAgent } from "./fixtures/agent-start.ts"
import { agentOptions, type PtyTransport } from "./fixtures/pty-transport.ts"

/**
 * The multiplexer against the transport seam: what it does with the size and
 * a transport that goes away — through the PTY fixture, so
 * every path is a table here rather than a race against a daemon.
 */
const FAKE_FX = fileURLToPath(new URL("./fixtures/fake-fx.ts", import.meta.url))
const NEVER = new AbortController().signal

async function harness(
  name: string,
  lifecycle: {
    beforeDefinitiveAgentForget?: (
      entry: ManifestEntry,
      exit: AgentExit | null,
    ) => void | Promise<void>
  } = {},
) {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const adeSocket = new TestAdeSocket(`/tmp/fmx-transport-test-${name}-${process.pid}.ade.sock`)
  const options = agentOptions()
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    adeSocket,
    ...lifecycle,
  })
  const control = (method: Parameters<typeof multiplexer.control.handle>[0], params: Record<string, unknown> = {}) =>
    multiplexer.control.handle(method, params, NEVER)
  const snapshot = () => control("orient") as Promise<Snapshot>
  const paneOf = async (id: number) => (await snapshot()).agents.find((i) => i.id === id)!.pane_id
  const report = async (id: number, state: string) => {
    const paneId = await paneOf(id)
    if (state === "working") adeSocket.main(paneId, "TurnStarted", { state })
    else if (state === "blocked") adeSocket.main(paneId, "AttentionRequired", { state })
    else adeSocket.main(paneId, "PostTurnEnd", { state: "idle" })
    await setup.renderOnce()
  }
  const close = async () => {
    await multiplexer.shutdown()
  }
  const modal = setup.renderer.root.findDescendantById("fmx-modal") as BoxRenderable
  await multiplexer.start()
  return { setup, multiplexer, options, control, snapshot, report, close, modal }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(10)
  }
}

class PaletteProbeTransport implements AgentTransport {
  readonly writes: Uint8Array[] = []
  private handlers: TransportHandlers | null = null

  bind(handlers: TransportHandlers): void {
    this.handlers = handlers
  }

  write(bytes: Uint8Array): void {
    this.writes.push(bytes.slice())
  }

  resize(_size: TerminalSize): void {}

  detach(): void {}

  restoreAndQueryBackground(): void {
    if (!this.handlers) throw new Error("transport is not bound")
    this.handlers.restoreBegin()
    this.handlers.output(new TextEncoder().encode("\x1b]11;?\x1b\\"))
    this.handlers.ready()
  }

  clearWrites(): void {
    this.writes.length = 0
  }

  writtenText(): string {
    return this.writes.map((bytes) => new TextDecoder().decode(bytes)).join("")
  }
}

test("keeps the Runtime-extension surface behind restored startup publication", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const options = agentOptions()
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
  })
  try {
    expect(() => multiplexer.extension.subscribeInvalidation(() => {})).toThrow("startup is not complete")
    expect(() => multiplexer.extension.present("f".repeat(32), false)).toThrow("startup is not complete")
    try {
      await multiplexer.extension.snapshot()
      throw new Error("expected the pre-start snapshot to fail")
    } catch (error) {
      expect(error).toMatchObject({ code: "starting_up" })
    }

    await multiplexer.start()
    const revisions: string[] = []
    const unsubscribe = multiplexer.extension.subscribeInvalidation((revision) => revisions.push(revision))
    expect(revisions).toEqual(["1"])
    expect(await multiplexer.extension.snapshot()).toMatchObject({ revision: "1", agents: [] })
    unsubscribe()
  } finally {
    await multiplexer.shutdown()
  }
})

test("refuses a legacy Manifest member that cannot satisfy the v1 snapshot", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "fmx-extension-snapshot-"))
  const manifestPath = join(temporaryDirectory, "manifest.json")
  const identity = identityFor("f".repeat(32))
  await writeFile(manifestPath, `${JSON.stringify({
    version: 1,
    homeId: "legacy-snapshot",
    nextDisplayId: 2,
    agents: [{
      ...identity,
      displayId: 1,
      cwd: process.cwd(),
      fxPath: FAKE_FX,
      fxArgs: [],
      createdAt: -1,
      fxSessionId: null,
      agentStatus: null,
      workControl: null,
      phase: "running",
    }],
  }, null, 2)}\n`)
  const manifest = await AgentManifest.open(manifestPath, "legacy-snapshot")
  const survivor = manifest.entries[0]!
  const options = agentOptions()
  options.transport.attachBehavior = () => new PaletteProbeTransport()
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    manifest,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    survivors: [survivor],
  })
  try {
    await multiplexer.start()
    try {
      await multiplexer.extension.snapshot()
      throw new Error("expected the malformed legacy member to fail")
    } catch (error) {
      expect(error).toMatchObject({ code: "snapshot_unavailable" })
    }
  } finally {
    await multiplexer.shutdown()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

test("a transport adopted after the layout pass is told the terminal's real size", async () => {
  const h = await harness("size")
  try {
    // Hold the start until the renderer has laid the terminal out beside the tray.
    let release!: () => void
    h.options.transport.gate = new Promise((resolve) => {
      release = resolve
    })
    void createAgent(h.multiplexer)
    await waitFor(() => h.options.transport.started.length === 1)
    const transport = h.options.transport.started[0]!
    await h.setup.renderOnce()
    await h.setup.renderOnce()
    const terminal = h.setup.renderer.root.findDescendantById("fx-1") as { width: number; height: number }
    expect(terminal.width).toBeGreaterThan(0)
    expect(terminal.width).not.toBe(80)
    expect(transport.lastResize).toBeNull()
    release()
    await waitFor(() => transport.lastResize !== null)
    expect(transport.lastResize).toEqual({ cols: terminal.width, rows: terminal.height })
  } finally {
    await h.close()
  }
})

test("selects the saved survivor before restoring any terminal", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const options = agentOptions()
  const firstClaim = options.manifest.claim({
    cwd: process.cwd(),
    fxPath: FAKE_FX,
    fxArgs: [],
    createdAt: 1,
  }).result
  const secondClaim = options.manifest.claim({
    cwd: process.cwd(),
    fxPath: FAKE_FX,
    fxArgs: [],
    createdAt: 2,
  }).result
  const [first, second] = await Promise.all([
    options.manifest.markRunning(firstClaim.agentId),
    options.manifest.markRunning(secondClaim.agentId),
  ])
  const attached: string[] = []
  options.transport.attachBehavior = (entry) => {
    attached.push(entry.agentId)
    return { bind() {}, write() {}, resize() {}, detach() {} }
  }
  const selections: Array<string | null> = []
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    survivors: [first, second],
    initialActiveAgentId: second.agentId,
    onActiveAgentChange: (agentId) => selections.push(agentId),
  })

  try {
    await multiplexer.start()
    const snapshot = (await multiplexer.control.handle("orient", {}, NEVER)) as Snapshot
    expect(snapshot.active).toBe(2)
    expect(snapshot.agents.map((agent) => [agent.id, agent.active])).toEqual([
      [1, false],
      [2, true],
    ])
    expect(snapshot.tray.rows.filter((row) => row.kind === "agent").map((row) => [row.agent, row.active])).toEqual([
      [2, true],
      [1, false],
    ])
    expect((setup.renderer.root.findDescendantById("fx-1") as BoxRenderable).visible).toBe(false)
    expect((setup.renderer.root.findDescendantById("fx-2") as BoxRenderable).visible).toBe(true)
    expect(attached[0]).toBe(second.agentId)
    expect(selections).toEqual([second.agentId])
  } finally {
    await multiplexer.shutdown()
  }
})

test("restores the selected Agent first, then at most four others concurrently", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const options = agentOptions()
  const claims = Array.from({ length: 7 }, (_, index) =>
    options.manifest.claim({
      cwd: process.cwd(),
      fxPath: FAKE_FX,
      fxArgs: [],
      createdAt: index + 1,
    }).result,
  )
  const survivors = await Promise.all(claims.map((claim) => options.manifest.markRunning(claim.agentId)))
  const selected = survivors[3]!
  const started: string[] = []
  const pending = new Map<string, () => void>()
  options.transport.attachBehavior = (entry) =>
    new Promise((resolve) => {
      started.push(entry.agentId)
      pending.set(entry.agentId, () => {
        pending.delete(entry.agentId)
        resolve({ bind() {}, write() {}, resize() {}, detach() {} })
      })
    })
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    survivors,
    initialActiveAgentId: selected.agentId,
  })

  try {
    const startup = multiplexer.start()
    await waitFor(() => started.length === 1)
    expect(started).toEqual([selected.agentId])

    pending.get(selected.agentId)!()
    await waitFor(() => started.length === 5)
    expect(pending.size).toBe(4)

    pending.get(started[1]!)!()
    await waitFor(() => started.length === 6)
    pending.get(started[2]!)!()
    await waitFor(() => started.length === 7)
    for (const release of [...pending.values()]) release()
    await startup
  } finally {
    await multiplexer.shutdown()
  }
})

test("publishes restored Session-list metadata only after attaching transports", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const options = agentOptions()
  const claim = options.manifest.claim({
    cwd: process.cwd(),
    fxPath: FAKE_FX,
    fxArgs: [],
    createdAt: 1,
  }).result
  const survivor = await options.manifest.markRunning(claim.agentId)
  const attached: string[] = []
  options.transport.attachBehavior = (entry) => {
    attached.push(entry.agentId)
    return { bind() {}, write() {}, resize() {}, detach() {} }
  }
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    survivors: [survivor],
  })

  try {
    const list = setup.renderer.root.findDescendantById("fmx-session-list") as BoxRenderable
    expect(list.visible).toBe(false)

    await multiplexer.start()
    expect(attached).toEqual([survivor.agentId])
    expect(list.visible).toBe(true)
    const snapshot = (await multiplexer.control.handle("orient", {}, NEVER)) as Snapshot
    expect(snapshot.tray.rows.some((row) => row.kind === "branch")).toBe(true)
  } finally {
    await multiplexer.shutdown()
  }
})

test("restores every durable managed session name from its Manifest Fx state root", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "fmx-managed-session-name-"))
  const runtimeHome = join(temporaryDirectory, "home")
  const stateRoot = join(temporaryDirectory, "state")
  const manifestPath = join(temporaryDirectory, "agents.json")
  const homeId = "managed-session-name"
  const startupSession = "1787362101500-1787362101500156000-2897385323da2700"
  const changedSession = "1787362101501-1787362101501156000-2897385323da2701"
  const snapshotSession = "1787362101502-1787362101502156000-2897385323da2702"
  const writeName = async (sessionId: string, title: string) => {
    const directory = join(stateRoot, ".fx", "sessions", sessionId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "display.json"), `${JSON.stringify({ title })}\n`)
  }

  await mkdir(runtimeHome, { recursive: true })
  await writeName(startupSession, "Restored after Runtime restart")
  const initialManifest = await AgentManifest.open(manifestPath, homeId)
  const pending = initialManifest.claim({
    cwd: process.cwd(),
    fxPath: FAKE_FX,
    fxArgs: null,
    fxStateRoot: stateRoot,
    createdAt: 1,
  })
  await pending.saved
  await initialManifest.setFxSessionId(pending.result.agentId, startupSession)
  await initialManifest.markRunning(pending.result.agentId)

  // Reopen the durable Manifest to model final-Client Runtime reconstruction.
  const manifest = await AgentManifest.open(manifestPath, homeId)
  const survivor = manifest.entries[0]!
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const options = agentOptions()
  options.transport.attachBehavior = () => ({ bind() {}, write() {}, resize() {}, detach() {} })
  const adeSocket = new TestAdeSocket(`/tmp/fmx-managed-session-name-${process.pid}.ade.sock`)
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    home: runtimeHome,
    manifest,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    adeSocket,
    survivors: [survivor],
  })

  try {
    await multiplexer.start()
    const orient = () => multiplexer.control.handle("orient", {}, NEVER) as Promise<Snapshot>
    expect((await orient()).agents[0]?.name).toBe("Restored after Runtime restart")

    // A main-session identity change reads the same retained state root.
    await writeName(changedSession, "Recovered after identity change")
    adeSocket.emit(feedRecord("SessionChanged", {
      sequence: 1,
      instanceId: survivor.agentId,
      sessionId: changedSession,
      state: "idle",
    }))
    expect((await orient()).agents[0]?.name).toBe("Recovered after identity change")

    // A sequence gap re-reads the active session from that root too.
    await writeName(changedSession, "Recovered after ADE gap")
    adeSocket.emit(feedRecord("FutureObservation", {
      sequence: 3,
      instanceId: survivor.agentId,
      sessionId: changedSession,
      state: "idle",
    }))
    expect((await orient()).agents[0]?.name).toBe("Recovered after ADE gap")

    // A Runtime-member snapshot can fill a sidecar that landed after the
    // identity event, without consulting the deliberately empty Runtime HOME.
    adeSocket.emit(feedRecord("SessionChanged", {
      sequence: 4,
      instanceId: survivor.agentId,
      sessionId: snapshotSession,
      state: "idle",
    }))
    expect((await orient()).agents[0]?.name).toBeNull()
    await writeName(snapshotSession, "Recovered for Runtime snapshot")
    expect(await multiplexer.extension.snapshot()).toMatchObject({
      agents: [{
        fx_conversation: {
          conversation_id: snapshotSession,
          name: "Recovered for Runtime snapshot",
        },
      }],
    })
  } finally {
    await multiplexer.shutdown()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

test("folds ADE records accepted during startup after survivor identities exist", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const options = agentOptions()
  const claim = options.manifest.claim({
    cwd: process.cwd(),
    fxPath: FAKE_FX,
    fxArgs: [],
    createdAt: 1,
  }).result
  const survivor = await options.manifest.markRunning(claim.agentId)
  options.transport.attachBehavior = () => ({ bind() {}, write() {}, resize() {}, detach() {} })
  const adeSocket = new AdeSocket({ path: `/tmp/fmx-startup-ade-${process.pid}.ade.sock` })
  await adeSocket.start()
  const sessionId = "1787362101430-1787362101430156000-2897385323da2691"
  const connection = await Bun.connect({ unix: adeSocket.path, socket: { data: () => {} } })
  connection.write(`${JSON.stringify({
    schema_version: 1,
    sequence: 7,
    event: "FutureObservation",
    instance_id: survivor.agentId,
    context: {
      agent_role: "main",
      workspace_root: process.cwd(),
      session_id: sessionId,
      parent_session_id: null,
      agent_state: "blocked",
      attention_kind: "question",
    },
    payload: {},
  })}\n`)
  connection.end()
  await Bun.sleep(20)

  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    survivors: [survivor],
    adeSocket,
  })
  try {
    await multiplexer.start()
    const snapshot = (await multiplexer.control.handle("orient", {}, NEVER)) as Snapshot
    expect(snapshot.agents[0]).toMatchObject({
      session_id: sessionId,
      state: "blocked",
      attention: "question",
    })
  } finally {
    await multiplexer.shutdown()
    adeSocket.close()
  }
})

test("reapplies the resolved OSC 11 background after RestoreBegin", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false })
  const options = agentOptions()
  const claim = options.manifest.claim({
    cwd: process.cwd(),
    fxPath: FAKE_FX,
    fxArgs: [],
    createdAt: 1,
  }).result
  const survivor = await options.manifest.markRunning(claim.agentId)
  const transport = new PaletteProbeTransport()
  options.transport.attachBehavior = () => transport
  const multiplexer = new Multiplexer(setup.renderer, {
    ...options,
    fxPath: FAKE_FX,
    cwd: process.cwd(),
    keybindings: resolveKeybindings().keybindings,
    survivors: [survivor],
  })
  try {
    await multiplexer.start()
    multiplexer.setTheme({ theme: "light", background: "#f0f0f0", source: "osc11", explicit: false })

    transport.clearWrites()
    transport.restoreAndQueryBackground()
    expect(transport.writtenText()).toContain("\x1b]11;rgb:f0f0/f0f0/f0f0\x1b\\")
  } finally {
    await multiplexer.shutdown()
  }
})

test("a lost transport whose Agent has ended is removed like an exit", async () => {
  const h = await harness("ended")
  try {
    void createAgent(h.multiplexer)
    await waitFor(() => h.options.transport.started.length === 1 && h.options.manifest.entries[0]?.phase === "running")
    const entry = h.options.manifest.entries[0]!
    h.options.transport.attachBehavior = "ended"
    ;(h.options.transport.started[0] as PtyTransport).lose()
    await waitFor(() => (h.setup.renderer.root.findDescendantById("fx-1") as unknown) === undefined)
    expect(h.options.manifest.get(entry.agentId)).toBeNull()
    expect(h.options.transport.attaches.get(entry.agentId)).toBe(1)
    expect(h.modal.visible).toBe(false)
  } finally {
    await h.close()
  }
})

test("a background Agent exit invalidates membership before asynchronous Manifest removal", async () => {
  const h = await harness("background-ended")
  let releaseRemoval = () => {}
  let unsubscribe = () => {}
  try {
    await createAgent(h.multiplexer)
    await createAgent(h.multiplexer, process.cwd(), false)
    await waitFor(() =>
      h.options.transport.started.length === 2 &&
      h.options.manifest.entries.every((entry) => entry.phase === "running")
    )
    const [first, second] = h.options.manifest.entries
    const before = await h.multiplexer.extension.snapshot()
    const revisions: string[] = []
    unsubscribe = h.multiplexer.extension.subscribeInvalidation((revision) => revisions.push(revision))

    const originalRemove = h.options.manifest.remove.bind(h.options.manifest)
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve
    })
    h.options.manifest.remove = async (agentId: string) => {
      await removalGate
      await originalRemove(agentId)
    }

    ;(h.options.transport.started[1] as PtyTransport).write(Uint8Array.of(3, 3))
    await waitFor(() => h.setup.renderer.root.findDescendantById("fx-2") === undefined)
    const whileRemovalBlocked = await h.multiplexer.extension.snapshot()
    expect(whileRemovalBlocked.agents.map((agent) => agent.agent_id)).toEqual([first!.agentId])
    expect(BigInt(whileRemovalBlocked.revision)).toBeGreaterThan(BigInt(before.revision))
    expect(revisions.at(-1)).toBe(whileRemovalBlocked.revision)
    expect(h.options.manifest.get(second!.agentId)).not.toBeNull()

    releaseRemoval()
    releaseRemoval = () => {}
    await waitFor(() => h.options.manifest.get(second!.agentId) === null)
  } finally {
    releaseRemoval()
    unsubscribe()
    await h.close()
  }
})

test("a definitive exit waits for durable managed finalization before forgetting its identities", async () => {
  const observed: { entry: ManifestEntry; exit: AgentExit | null }[] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await harness("managed-exit", {
    beforeDefinitiveAgentForget: async (entry, exit) => {
      observed.push({ entry, exit })
      await gate
    },
  })
  try {
    await createAgent(h.multiplexer)
    await waitFor(() => h.options.transport.started.length === 1 && h.options.manifest.entries[0]?.phase === "running")
    const entry = h.options.manifest.entries[0]!

    ;(h.options.transport.started[0] as PtyTransport).write(Uint8Array.of(3, 3))
    await waitFor(() => observed.length === 1 && h.setup.renderer.root.findDescendantById("fx-1") === undefined)
    expect(observed).toHaveLength(1)
    expect(observed[0]?.entry).toEqual(entry)
    expect(observed[0]?.exit).toEqual({ code: expect.any(Number), signal: expect.any(Number) })
    expect(h.options.manifest.get(entry.agentId)).not.toBeNull()

    release()
    await waitFor(() => h.options.manifest.get(entry.agentId) === null)
  } finally {
    release()
    await h.close()
  }
})

test("a failed managed exit finalization keeps the Manifest claim for startup recovery", async () => {
  const h = await harness("managed-exit-failure", {
    beforeDefinitiveAgentForget: async () => {
      throw new Error("durable final receipt unavailable")
    },
  })
  try {
    await createAgent(h.multiplexer)
    await waitFor(() => h.options.transport.started.length === 1 && h.options.manifest.entries[0]?.phase === "running")
    const entry = h.options.manifest.entries[0]!

    ;(h.options.transport.started[0] as PtyTransport).write(Uint8Array.of(3, 3))
    await waitFor(() => h.setup.renderer.root.findDescendantById("fx-1") === undefined)
    await waitFor(() => h.modal.visible)
    await h.setup.renderOnce()
    expect(h.options.manifest.get(entry.agentId)).not.toBeNull()
    expect(h.setup.captureCharFrame()).toContain("could not finalize agent 1")
  } finally {
    await h.close()
  }
})

test("a lost transport that cannot be reached again leaves the screen but keeps its claim", async () => {
  const h = await harness("unreachable")
  try {
    void createAgent(h.multiplexer)
    await waitFor(() => h.options.transport.started.length === 1 && h.options.manifest.entries[0]?.phase === "running")
    const entry = h.options.manifest.entries[0]!
    h.options.transport.attachBehavior = "unreachable"
    ;(h.options.transport.started[0] as PtyTransport).lose()
    await waitFor(() => (h.setup.renderer.root.findDescendantById("fx-1") as unknown) === undefined, 5_000)
    await h.setup.renderOnce()
    expect(h.options.transport.attaches.get(entry.agentId)).toBe(3)
    expect(h.options.manifest.get(entry.agentId)?.phase).toBe("running")
    expect(h.modal.visible).toBe(true)
    expect(h.setup.captureCharFrame()).toContain("lost agent 1")
    expect(await h.multiplexer.extension.snapshot()).toMatchObject({
      selected_agent_id: null,
      agents: [{
        agent_id: entry.agentId,
        pane_id: entry.paneId,
        display_id: entry.displayId,
        lifecycle: "unreachable",
        directory: entry.cwd,
        correlation: null,
      }],
    })
    expect(() => h.multiplexer.extension.present(entry.agentId, false)).toThrow("no switchable Agent")
  } finally {
    await h.close()
  }
})

test("a lost transport that can be reached again is adopted and the Agent stays", async () => {
  const h = await harness("recovered")
  try {
    void createAgent(h.multiplexer)
    await waitFor(() => h.options.transport.started.length === 1 && h.options.manifest.entries[0]?.phase === "running")
    const entry = h.options.manifest.entries[0]!
    const first = h.options.transport.started[0] as PtyTransport
    // A second fx behind the seam stands in for the same one re-attached.
    let second: PtyTransport | null = null
    h.options.transport.attachBehavior = () => {
      second = new (first.constructor as new (request: unknown) => PtyTransport)({
        entry,
        command: [FAKE_FX],
        cwd: process.cwd(),
        env: { ...process.env, FMX_AGENT_ID: "1" } as Record<string, string>,
        size: { cols: 80, rows: 24 },
      })
      return second
    }
    first.lose()
    await waitFor(() => second !== null && second.lastResize !== null)
    await Bun.sleep(50)
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeDefined()
    expect(h.options.manifest.get(entry.agentId)?.phase).toBe("running")
    expect(h.modal.visible).toBe(false)
    expect((await h.snapshot()).agents.map((i) => i.id)).toEqual([1])
  } finally {
    await h.close()
  }
})
