import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { existsSync } from "node:fs"
import { unlink } from "node:fs/promises"
import {
  AgentManifest,
  type AgentIdentity,
  type CreateParams,
  type ManifestEntry,
} from "../src/agent-manifest.ts"
import {
  AgentEndedError,
  AgentStartConflictError,
  type AgentAttachOptions,
  type AgentExit,
  type AgentStart,
  type AgentTransport,
  type AgentTransportFactory,
  type TerminalSize,
  type TransportHandlers,
} from "../src/agent-transport.ts"
import { mintFxWorkControlBinding } from "../src/fx-work-control.ts"
import { resolveKeybindings } from "../src/keybindings.ts"
import { Multiplexer, type ManagedAgentClaim } from "../src/multiplexer.ts"

const AGENT_ID = "a".repeat(32)
const CWD = process.cwd()
const FX = "/managed/fx"

class ProbeTransport implements AgentTransport {
  handlers: TransportHandlers | null = null
  resizes: TerminalSize[] = []
  detached = false

  bind(handlers: TransportHandlers): void {
    this.handlers = handlers
  }

  write(_bytes: Uint8Array): void {}

  resize(size: TerminalSize): void {
    this.resizes.push({ ...size })
  }

  detach(): void {
    this.detached = true
  }

  exit(status: AgentExit): void {
    if (!this.handlers) throw new Error("transport is not bound")
    this.handlers.exit(status)
  }
}

class ManagedTransportFactory implements AgentTransportFactory {
  readonly starts: AgentStart[] = []
  readonly attaches: ManifestEntry[] = []
  readonly attachOptions: AgentAttachOptions[] = []
  readonly processes = new Set<string>()
  readonly transports: ProbeTransport[] = []
  startBehavior: ((request: AgentStart) => AgentTransport | Promise<AgentTransport>) | null = null
  attachBehavior: ((entry: ManifestEntry) => AgentTransport | Promise<AgentTransport>) | null = null

  async start(request: AgentStart): Promise<AgentTransport> {
    this.starts.push(copyStart(request))
    if (this.startBehavior) return this.startBehavior(request)
    if (this.processes.has(request.entry.agentId) && !request.recoverExisting) {
      throw new Error("duplicate process start")
    }
    this.processes.add(request.entry.agentId)
    const transport = new ProbeTransport()
    this.transports.push(transport)
    return transport
  }

  async attach(
    entry: ManifestEntry,
    _size: TerminalSize,
    options: AgentAttachOptions = {},
  ): Promise<AgentTransport> {
    this.attaches.push(structuredClone(entry))
    this.attachOptions.push({ ...options })
    if (this.attachBehavior) return this.attachBehavior(entry)
    if (!this.processes.has(entry.agentId)) throw new Error("process is absent")
    const transport = new ProbeTransport()
    this.transports.push(transport)
    return transport
  }
}

function copyStart(request: AgentStart): AgentStart {
  return {
    ...request,
    entry: structuredClone(request.entry),
    command: [...request.command],
    env: { ...request.env },
    size: { ...request.size },
  }
}

function claim(agentId = AGENT_ID): ManagedAgentClaim {
  return {
    agentId,
    cwd: CWD,
    fxPath: FX,
    fxArgs: ["--managed"],
    fxStateRoot: "/var/tmp/fmx-managed-state",
    createdAt: 1234,
    workControl: {
      socketPath: `/tmp/fmx-managed.${agentId}.fx`,
      instanceId: agentId,
      token: "ab".repeat(32),
    },
  }
}

async function harness(
  manifest = AgentManifest.ephemeral("managed-test"),
  options: {
    runtimeSocketPath?: string
    beforeDefinitiveAgentForget?: (
      entry: ManifestEntry,
      exit: AgentExit | null,
    ) => void | Promise<void>
  } = {},
) {
  const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false })
  const transport = new ManagedTransportFactory()
  const multiplexer = new Multiplexer(setup.renderer, {
    manifest,
    transport,
    fxPath: FX,
    cwd: CWD,
    keybindings: resolveKeybindings().keybindings,
    ...options,
  })
  await multiplexer.start()
  return { setup, manifest, transport, multiplexer }
}

test("projects a predetermined managed identity, then durably starts and adopts its exact invocation", async () => {
  const h = await harness()
  try {
    const projected = await h.multiplexer.projectManagedAgent(claim())
    expect(projected).toMatchObject({
      agentId: AGENT_ID,
      paneId: `p_${AGENT_ID}`,
      zmxName: `fmx-${AGENT_ID}`,
      displayId: 1,
      phase: "creating",
      workControl: claim().workControl,
    })
    expect(h.transport.starts).toHaveLength(0)
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeDefined()

    const result = await h.multiplexer.startManagedAgent(AGENT_ID, {
      command: [FX, "--managed"],
      cwd: CWD,
      env: { EXACT: "invocation" },
    })

    expect(result).toEqual({ sessionName: `fmx-${AGENT_ID}`, paneId: `p_${AGENT_ID}` })
    expect(h.manifest.get(AGENT_ID)?.phase).toBe("running")
    expect(h.transport.starts).toHaveLength(1)
    expect(h.transport.starts[0]).toMatchObject({
      entry: { agentId: AGENT_ID, phase: "creating" },
      command: [FX, "--managed"],
      cwd: CWD,
      env: { EXACT: "invocation" },
      recoverExisting: true,
    })
    expect(h.transport.transports[0]?.handlers).not.toBeNull()
    expect(h.transport.transports[0]?.resizes).toHaveLength(1)
  } finally {
    await h.multiplexer.shutdown()
  }
})

test("a concurrent managed start waits for the exact claim write before creating Fx", async () => {
  const manifest = AgentManifest.ephemeral("managed-claim-race")
  const originalEnsureClaim = manifest.ensureClaim.bind(manifest)
  const claimWrite = Promise.withResolvers<void>()
  manifest.ensureClaim = (params: CreateParams & { identity: AgentIdentity }) => {
    const pending = originalEnsureClaim(params)
    return { result: pending.result, saved: pending.saved.then(() => claimWrite.promise) }
  }
  const h = await harness(manifest)
  try {
    const projection = h.multiplexer.projectManagedAgent(claim())
    expect(h.manifest.get(AGENT_ID)?.phase).toBe("creating")
    const start = h.multiplexer.startManagedAgent(AGENT_ID, {
      command: [FX, "--managed"],
      cwd: CWD,
      env: {},
    })
    await Bun.sleep(10)
    expect(h.transport.starts).toHaveLength(0)

    claimWrite.resolve()
    await projection
    await start
    expect(h.transport.starts).toHaveLength(1)
  } finally {
    claimWrite.resolve()
    await h.multiplexer.shutdown()
  }
})

test("a projection paused on its save cannot return after definitive finalization starts", async () => {
  const manifest = AgentManifest.ephemeral("managed-projection-finalization-race")
  const finalizerEntered = Promise.withResolvers<void>()
  const releaseFinalizer = Promise.withResolvers<void>()
  const h = await harness(manifest, {
    beforeDefinitiveAgentForget: async () => {
      finalizerEntered.resolve()
      await releaseFinalizer.promise
    },
  })
  const invocation = { command: [FX, "--managed"], cwd: CWD, env: {} }
  try {
    await h.multiplexer.projectManagedAgent(claim())
    await h.multiplexer.startManagedAgent(AGENT_ID, invocation)

    const originalEnsureClaim = manifest.ensureClaim.bind(manifest)
    const replaySave = Promise.withResolvers<void>()
    manifest.ensureClaim = (params: CreateParams & { identity: AgentIdentity }) => {
      const pending = originalEnsureClaim(params)
      return { result: pending.result, saved: pending.saved.then(() => replaySave.promise) }
    }
    const replay = h.multiplexer.projectManagedAgent(claim())
    const replayFailure = replay.catch((error: unknown) => error)
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeDefined()

    h.transport.transports[0]!.exit({ code: 0, signal: 0 })
    await Promise.race([
      finalizerEntered.promise,
      Bun.sleep(1_000).then(() => {
        throw new Error("finalizer did not start")
      }),
    ])
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeUndefined()
    expect(h.manifest.get(AGENT_ID)?.phase).toBe("running")

    replaySave.resolve()
    expect(await replayFailure).toMatchObject({
      message: expect.stringContaining("being definitively finalized"),
    })
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeUndefined()
    expect(h.transport.starts).toHaveLength(1)

    releaseFinalizer.resolve()
    await Bun.sleep(10)
    expect(h.manifest.get(AGENT_ID)).toBeNull()
  } finally {
    releaseFinalizer.resolve()
    await h.multiplexer.shutdown()
  }
})

test("exact projection and start replay reuse one row and one process", async () => {
  const h = await harness()
  try {
    const first = await h.multiplexer.projectManagedAgent(claim())
    const replay = await h.multiplexer.projectManagedAgent(claim())
    expect(replay).toEqual(first)
    expect(h.manifest.entries).toHaveLength(1)
    expect(h.setup.renderer.root.findDescendantById("fx-2")).toBeUndefined()

    const invocation = { command: [FX, "--managed"], cwd: CWD, env: { A: "1" } }
    const [started, joined] = await Promise.all([
      h.multiplexer.startManagedAgent(AGENT_ID, invocation),
      h.multiplexer.startManagedAgent(AGENT_ID, { ...invocation, env: { A: "1" } }),
    ])
    expect(joined).toEqual(started)
    expect(await h.multiplexer.startManagedAgent(AGENT_ID, invocation)).toEqual(started)
    expect(h.transport.starts).toHaveLength(1)
    expect(h.transport.attaches).toHaveLength(0)
    expect(h.transport.processes.size).toBe(1)
  } finally {
    await h.multiplexer.shutdown()
  }
})

test("Manifest write failures keep one recoverable projection and never duplicate Fx", async () => {
  const manifest = AgentManifest.ephemeral("managed-write-failure")
  const originalEnsureClaim = manifest.ensureClaim.bind(manifest)
  let failClaimWrite = true
  manifest.ensureClaim = (params: CreateParams & { identity: AgentIdentity }) => {
    const pending = originalEnsureClaim(params)
    if (!failClaimWrite) return pending
    failClaimWrite = false
    return {
      result: pending.result,
      saved: pending.saved.then(() => Promise.reject(new Error("claim write failed"))),
    }
  }
  const h = await harness(manifest)
  try {
    await expect(h.multiplexer.projectManagedAgent(claim())).rejects.toThrow("claim write failed")
    expect(h.manifest.entries).toHaveLength(1)
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeDefined()
    await expect(h.multiplexer.startManagedAgent(AGENT_ID, {
      command: [FX, "--managed"],
      cwd: CWD,
      env: {},
    })).rejects.toThrow("claim write failed")
    expect(h.transport.starts).toHaveLength(0)
    await h.multiplexer.projectManagedAgent(claim())
    expect(h.manifest.entries).toHaveLength(1)

    const originalMarkRunning = manifest.markRunning.bind(manifest)
    let failRunningWrite = true
    manifest.markRunning = async (agentId: string) => {
      const running = await originalMarkRunning(agentId)
      if (failRunningWrite) {
        failRunningWrite = false
        throw new Error("running write failed")
      }
      return running
    }
    const invocation = { command: [FX, "--managed"], cwd: CWD, env: {} }
    await expect(h.multiplexer.startManagedAgent(AGENT_ID, invocation)).rejects.toThrow("running write failed")
    expect(h.transport.transports[0]?.handlers).toBeNull()
    expect(h.transport.transports[0]?.detached).toBe(true)

    await h.multiplexer.startManagedAgent(AGENT_ID, invocation)
    expect(h.transport.starts).toHaveLength(1)
    expect(h.transport.attaches).toHaveLength(1)
    expect(h.transport.processes.size).toBe(1)
    expect(h.manifest.get(AGENT_ID)?.phase).toBe("running")
    expect(h.transport.transports[1]?.handlers).not.toBeNull()
  } finally {
    await h.multiplexer.shutdown()
  }
})

test("a foreign managed collision removes only the Manifest claim and leaves its endpoint untouched", async () => {
  const runtimeSocketPath = `/tmp/fmx-managed-foreign-${process.pid}.bus`
  const binding = mintFxWorkControlBinding(runtimeSocketPath, AGENT_ID, "ef".repeat(32))
  await unlink(binding.socketPath).catch(() => {})
  const endpoint = Bun.listen({
    unix: binding.socketPath,
    socket: { data() {} },
  })
  let finalized = 0
  const h = await harness(AgentManifest.ephemeral("managed-foreign"), {
    runtimeSocketPath,
    beforeDefinitiveAgentForget: () => {
      finalized += 1
    },
  })
  try {
    await h.multiplexer.projectManagedAgent({ ...claim(), workControl: binding })
    await h.manifest.markRunning(AGENT_ID)
    h.transport.attachBehavior = (entry) => {
      throw new AgentStartConflictError(entry, new Error("foreign labels"))
    }

    await expect(h.multiplexer.startManagedAgent(AGENT_ID, {
      command: [FX, "--managed"],
      cwd: CWD,
      env: {},
    })).rejects.toBeInstanceOf(AgentStartConflictError)
    expect(h.manifest.get(AGENT_ID)).toBeNull()
    expect(h.transport.attachOptions).toEqual([{ foreignAsConflict: true }])
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeUndefined()
    expect(existsSync(binding.socketPath)).toBe(true)
    expect(finalized).toBe(0)
  } finally {
    await h.multiplexer.shutdown()
    endpoint.stop(true)
    await unlink(binding.socketPath).catch(() => {})
  }
})

test("a proven ended managed Agent follows definitive finalization and removes safe residue", async () => {
  const runtimeSocketPath = `/tmp/fmx-managed-ended-${process.pid}.bus`
  const binding = mintFxWorkControlBinding(runtimeSocketPath, AGENT_ID, "12".repeat(32))
  await unlink(binding.socketPath).catch(() => {})
  const endpoint = Bun.listen({
    unix: binding.socketPath,
    socket: { data() {} },
  })
  const finalized: Array<{ entry: ManifestEntry; exit: AgentExit | null }> = []
  const h = await harness(AgentManifest.ephemeral("managed-ended"), {
    runtimeSocketPath,
    beforeDefinitiveAgentForget: (entry, exit) => {
      finalized.push({ entry, exit })
    },
  })
  try {
    const projected = await h.multiplexer.projectManagedAgent({ ...claim(), workControl: binding })
    await h.manifest.markRunning(AGENT_ID)
    h.transport.attachBehavior = (entry) => {
      throw new AgentEndedError(entry, { code: 7, signal: 0 })
    }

    await expect(h.multiplexer.startManagedAgent(AGENT_ID, {
      command: [FX, "--managed"],
      cwd: CWD,
      env: {},
    })).rejects.toBeInstanceOf(AgentEndedError)
    expect(finalized).toEqual([{
      entry: { ...projected, phase: "running" },
      exit: { code: 7, signal: 0 },
    }])
    expect(h.manifest.get(AGENT_ID)).toBeNull()
    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeUndefined()
    expect(existsSync(binding.socketPath)).toBe(false)
  } finally {
    await h.multiplexer.shutdown()
    endpoint.stop(true)
    await unlink(binding.socketPath).catch(() => {})
  }
})

test("definitive finalization gates same-id projection and start, then remains fail-closed", async () => {
  const runtimeSocketPath = `/tmp/fmx-managed-finalizing-${process.pid}.bus`
  const binding = mintFxWorkControlBinding(runtimeSocketPath, AGENT_ID, "34".repeat(32))
  await unlink(binding.socketPath).catch(() => {})
  const endpoint = Bun.listen({
    unix: binding.socketPath,
    socket: { data() {} },
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const h = await harness(AgentManifest.ephemeral("managed-finalizing"), {
    runtimeSocketPath,
    beforeDefinitiveAgentForget: async () => {
      entered.resolve()
      await release.promise
      throw new Error("durable terminal receipt unavailable")
    },
  })
  try {
    await h.multiplexer.projectManagedAgent({ ...claim(), workControl: binding })
    await h.manifest.markRunning(AGENT_ID)
    h.transport.attachBehavior = (entry) => {
      throw new AgentEndedError(entry, { code: 8, signal: 0 })
    }
    const ending = h.multiplexer.startManagedAgent(AGENT_ID, {
      command: [FX, "--managed"],
      cwd: CWD,
      env: {},
    }).catch((error: unknown) => error)
    await entered.promise

    expect(h.setup.renderer.root.findDescendantById("fx-1")).toBeUndefined()
    expect(h.manifest.get(AGENT_ID)?.phase).toBe("running")
    await expect(h.multiplexer.projectManagedAgent({ ...claim(), workControl: binding })).rejects.toThrow(
      "being definitively finalized",
    )
    await expect(h.multiplexer.startManagedAgent(AGENT_ID, {
      command: [FX, "--managed"],
      cwd: CWD,
      env: {},
    })).rejects.toThrow("being definitively finalized")
    expect(h.manifest.entries).toHaveLength(1)
    expect(h.transport.attaches).toHaveLength(1)
    expect(h.transport.starts).toHaveLength(0)

    release.resolve()
    expect(await ending).toBeInstanceOf(AgentEndedError)
    expect(h.manifest.get(AGENT_ID)?.phase).toBe("running")
    expect(existsSync(binding.socketPath)).toBe(true)
    await expect(h.multiplexer.projectManagedAgent({ ...claim(), workControl: binding })).rejects.toThrow(
      "being definitively finalized",
    )
    await expect(h.multiplexer.startManagedAgent(AGENT_ID, {
      command: [FX, "--managed"],
      cwd: CWD,
      env: {},
    })).rejects.toThrow("being definitively finalized")
    expect(h.manifest.entries).toHaveLength(1)
    expect(h.transport.attaches).toHaveLength(1)
  } finally {
    release.resolve()
    await h.multiplexer.shutdown()
    endpoint.stop(true)
    await unlink(binding.socketPath).catch(() => {})
  }
})
