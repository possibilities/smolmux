import { afterAll, describe, expect, test } from "bun:test"
import { readFile, realpath, rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeCanonicalJson } from "../src/contract-codec.ts"
import {
  identityFor,
  AgentManifest,
  type ManifestEntry,
} from "../src/agent-manifest.ts"
import {
  fxLaunchAdmissionFinalMessageSchema,
  ensureLifecycleMessageSchema,
} from "../src/agentworkplace-contracts.ts"
import {
  deriveEnsureDigest,
  deriveFxAdmissionDecisionDigest,
  deriveFxFinalReceiptDigest,
  EnsureLifecycleLedger,
  type EnsureLifecycleRecord,
  type EnsureRequest,
  type FxAdmissionDecision,
  type FxFinalReceipt,
} from "../src/ensure-lifecycle-ledger.ts"
import {
  deriveCleanupDigest,
  deriveEndDigest,
  deriveLifecycleReceiptDigest,
  ExactRetirementLedger,
  type CleanupReceipt,
  type CleanupRequest,
  type EndReceipt,
  type EndRequest,
} from "../src/exact-retirement-ledger.ts"
import {
  InlineLaunchSourceLedger,
  encodeInlineSourceBytes,
  deriveFrozenLaunchDigest,
  deriveInlineLaunchSourceDigest,
  encodeInlineLaunchControls,
  type FrozenLaunchRequest,
  type InlineLaunchSourceRequest,
} from "../src/inline-launch-source.ts"
import {
  LifecycleRuntime,
  lifecycleRuntimeRoots,
  type LifecycleRuntimeMultiplexer,
  type LifecycleRuntimeOptions,
} from "../src/lifecycle-runtime.ts"
import type { AgentDefaults } from "../src/config.ts"
import { mintFxWorkControlBinding } from "../src/fx-work-control.ts"
import {
  deriveManagedLaunchEnsureDigest,
  deriveManagedLaunchSourceDigest,
  parseManagedLaunchRequest,
  type ManagedLaunchRequest,
} from "../src/managed-launch-contract.ts"
import type { ManagedAgentClaim, ManagedAgentInvocation } from "../src/multiplexer.ts"

const CONTRACTS = resolve(import.meta.dir, "../contracts/agentworkplace/v1")
const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe("production lifecycle Runtime composition", () => {
  test("opens stable per-Home roots and drives provider-neutral managed launch", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a")
    const harness = await runtimeHarness(fixture)
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.recover()

      expect(harness.errors.map(String)).toEqual([])
      expect(harness.provider.operations).toEqual([
        "prepare", "build", "inspect", "prepare", "build", "inspect",
      ])
      expect(harness.multiplexer.claims).toHaveLength(1)
      expect(harness.multiplexer.starts).toHaveLength(1)
      const invocation = harness.multiplexer.starts[0]!
      expect(invocation.command).toEqual([
        "/resolved/fmx-fx",
        "--state-dir",
        fixture.source.launch_request.state_root,
        "--context-limit",
        "skill_chunk_bytes=4096",
        "--tool",
        "read",
      ])
      expect(invocation.cwd).toBe(fixture.ensure.planned_worktree.directory)
      expect(invocation.env).toMatchObject({
        KEEP: "yes",
        FMX_SOCKET_PATH: harness.runtimeSocketPath,
        FX_WORK_CONTROL_INSTANCE_ID: fixture.ensure.agent_id,
        FX_ADE_INSTANCE_ID: fixture.ensure.agent_id,
        FX_INTERNAL_LAUNCH_CONVERSATION_ID: "conversation-runtime",
      })
      expect(invocation.env.FX_MODEL).toBe("fixture/model-default")
      expect(invocation.env.FX_EFFORT).toBe("medium")
      expect(harness.workControl.requests).toEqual([{
        method: "work.queue",
        params: { text: "initial λ work" },
        instanceId: fixture.ensure.agent_id,
      }])
      expect(harness.receipts.some((receipt) =>
        receipt.message_type === "ensure_receipt" && receipt.status === "complete"
      )).toBe(true)
      expect(await harness.runtime.correlationSource.snapshot()).toEqual([{
        agent_id: fixture.ensure.agent_id,
        correlation: {
          ensure_id: fixture.ensure.ensure_id,
          ensure_digest: fixture.ensure.ensure_digest,
          launch_id: fixture.ensure.launch_id,
          launch_digest: fixture.ensure.launch_digest,
        },
      }])
    } finally {
      await harness.runtime.close()
    }
  })

  test("composes full and partial Session defaults without changing frozen launch bytes", async () => {
    const full = await lifecycleFixture("ensure-a", "launch-a", "defaults-full", {
      model: null,
      effort: null,
    })
    const fullHarness = await runtimeHarness(full, {
      agentDefaults: { model: "session/model", effort: "high" },
    })
    try {
      await fullHarness.runtime.acceptInlineSource(full.source)
      await fullHarness.runtime.acceptLifecycle(full.ensure)
      await fullHarness.runtime.recover()
      expect(fullHarness.multiplexer.starts[0]!.env).toMatchObject({
        FX_MODEL: "session/model",
        FX_EFFORT: "high",
      })
      expect(full.source.launch_request.model).toBeUndefined()
      expect(full.source.launch_request.effort).toBeUndefined()
    } finally {
      await fullHarness.runtime.close()
    }

    const partial = await lifecycleFixture("ensure-a", "launch-a", "defaults-partial", {
      effort: null,
    })
    const partialHarness = await runtimeHarness(partial, {
      agentDefaults: { model: "session/model", effort: "high" },
    })
    try {
      await partialHarness.runtime.acceptInlineSource(partial.source)
      await partialHarness.runtime.acceptLifecycle(partial.ensure)
      await partialHarness.runtime.recover()
      expect(partialHarness.multiplexer.starts[0]!.env).toMatchObject({
        FX_MODEL: partial.source.launch_request.model,
        FX_EFFORT: "high",
      })
    } finally {
      await partialHarness.runtime.close()
    }
  })

  test("does not apply a nonmatching Session default and preserves vanilla Fx absence", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "defaults-nonmatching", {
      model: null,
      effort: null,
    })
    // The startup resolver supplies only exact-session defaults. A nonmatching
    // table entry therefore arrives here as no defaults at all.
    const harness = await runtimeHarness(fixture)
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.recover()
      expect(harness.multiplexer.starts[0]!.env.FX_MODEL).toBeUndefined()
      expect(harness.multiplexer.starts[0]!.env.FX_EFFORT).toBeUndefined()
    } finally {
      await harness.runtime.close()
    }
  })

  test("fails closed when Fx disagrees with an explicit frozen model or effort", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "provider-conflict")
    const harness = await runtimeHarness(fixture, {
      providerEnvironment: {
        FX_MODEL: "provider/different-model",
        FX_EFFORT: "medium",
      },
    })
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.recover()
      expect(harness.multiplexer.starts).toHaveLength(0)
      expect(harness.errors.map(String).join("\n")).toContain("explicit model")
    } finally {
      await harness.runtime.close()
    }
  })

  test("fails closed when Fx disagrees with an explicit frozen effort", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "provider-effort-conflict")
    const harness = await runtimeHarness(fixture, {
      providerEnvironment: {
        FX_MODEL: "fixture/model-default",
        FX_EFFORT: "low",
      },
    })
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.recover()
      expect(harness.multiplexer.starts).toHaveLength(0)
      expect(harness.errors.map(String).join("\n")).toContain("explicit effort")
    } finally {
      await harness.runtime.close()
    }
  })

  test("re-projects a durable manifest claim with the exact recovered Work-control path", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "manifest-replay")
    const harness = await runtimeHarness(fixture, { preloadManifestClaim: true })
    try {
      await harness.runtime.recover()
      const entry = harness.manifest.get(fixture.ensure.agent_id)
      expect(entry).not.toBeNull()
      expect(entry!.workControl).toMatchObject({
        socketPath: mintFxWorkControlBinding(
          harness.runtimeSocketPath,
          fixture.ensure.agent_id,
        ).socketPath,
        instanceId: fixture.ensure.agent_id,
      })
      if (entry === null) throw new Error("projection did not recreate the Manifest entry")
      const workControl = entry.workControl
      if (workControl === null) throw new Error("projection did not recreate Work-control")
      expect(workControl.token).toHaveLength(64)
      expect(harness.multiplexer.claims).toHaveLength(1)
    } finally {
      await harness.runtime.close()
    }
  })

  test("retains receipts when the publisher binds after startup, then replays them", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "publisher-replay")
    const harness = await runtimeHarness(fixture, { bindPublisher: false })
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.recover()
      expect(harness.receipts).toHaveLength(0)

      harness.runtime.bindReceiptPublisher((receipt) => {
        harness.receipts.push(structuredClone(receipt))
      })
      await harness.runtime.recover()
      expect(harness.receipts.some((receipt) => receipt.message_type === "ensure_receipt")).toBe(true)
    } finally {
      await harness.runtime.close()
    }
  })

  test("coalesces concurrent recovery calls behind one recovery operation", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "recover-coalesced")
    const gate = Promise.withResolvers<void>()
    const harness = await runtimeHarness(fixture, {
      preloadManifestClaim: true,
      projectionGate: gate.promise,
    })
    try {
      const first = harness.runtime.recover()
      await waitFor(() => harness.multiplexer.claims.length === 1)
      const second = harness.runtime.recover()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      expect(harness.multiplexer.claims).toHaveLength(1)
      gate.resolve()
      await Promise.all([first, second])
      expect(harness.multiplexer.starts).toHaveLength(1)
    } finally {
      gate.resolve()
      await harness.runtime.close()
    }
  })

  test("close waits for paused recovery projection before teardown completes", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "recover-close")
    const gate = Promise.withResolvers<void>()
    const harness = await runtimeHarness(fixture, {
      preloadManifestClaim: true,
      projectionGate: gate.promise,
    })
    let closed = false
    try {
      const recovery = harness.runtime.recover()
      await waitFor(() => harness.multiplexer.claims.length === 1)
      const closing = harness.runtime.close().then(() => { closed = true })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      expect(closed).toBe(false)
      gate.resolve()
      await Promise.all([recovery, closing])
      expect(closed).toBe(true)
      expect(harness.multiplexer.starts).toHaveLength(0)
    } finally {
      gate.resolve()
      await harness.runtime.close()
    }
  })

  test("serializes concurrent finalization and cleanup effects per ensure", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "retirement-serialize")
    const endGate = Promise.withResolvers<void>()
    const cleanupGate = Promise.withResolvers<void>()
    const harness = await runtimeHarness(fixture, {
      retirementGate: endGate.promise,
      cleanupGate: cleanupGate.promise,
    })
    const retirement = harness.retirement as BarrierRetirement
    const cleanup = harness.cleanup as BarrierCleanup
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.recover()
      const entry = harness.manifest.get(fixture.ensure.agent_id)!

      const scheduledEnd = harness.runtime.acceptLifecycle(fixture.end!)
      await waitFor(() => retirement.endCalls === 1)
      const directFinalization = harness.runtime.beforeDefinitiveAgentForget(entry, { code: 0, signal: 0 })
      endGate.resolve()
      await Promise.all([scheduledEnd, directFinalization])
      expect(retirement.endCalls).toBe(1)

      await harness.runtime.acceptLifecycle(fixture.cleanup!)
      await waitFor(() => cleanup.cleanupCalls === 1)
      const firstCleanupFinalization = harness.runtime.beforeDefinitiveAgentForget(entry, null)
      const secondCleanupFinalization = harness.runtime.beforeDefinitiveAgentForget(entry, null)
      cleanupGate.resolve()
      await Promise.all([firstCleanupFinalization, secondCleanupFinalization])
      expect(cleanup.cleanupCalls).toBe(1)
    } finally {
      endGate.resolve()
      cleanupGate.resolve()
      await harness.runtime.close()
    }
  })

  test("fails closed without provider finality, then retains and acknowledges exact Exit", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "final")
    const harness = await runtimeHarness(fixture)
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.recover()
      expect(harness.errors.map(String)).toEqual([])
      const entry = harness.manifest.get(fixture.ensure.agent_id)!

      await expect(harness.runtime.beforeRemove({
        entry,
        reason: "absent",
        session: null,
      })).rejects.toThrow("no definitive Fx final or negative decision")
      expect(harness.manifest.get(fixture.ensure.agent_id)).not.toBeNull()

      await harness.runtime.beforeDefinitiveAgentForget(entry, { code: 7, signal: 0 })
      expect(harness.provider.recordedFinal).toEqual({ kind: "exited", code: 7 })
      expect(harness.provider.acknowledged).toHaveLength(1)
      const durable = await EnsureLifecycleLedger.open(harness.runtime.roots.ensure)
      expect(await durable.get(fixture.ensure.ensure_id)).toMatchObject({
        fx_final: {
          receipt: { outcome: { kind: "exited", code: 7 } },
          acknowledgement_applied: true,
        },
      })
    } finally {
      await harness.runtime.close()
    }
  })

  test("includes managed Agents in the exact Runtime member correlation snapshot", async () => {
    const request = await managedRuntimeFixture("managed-correlation")
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "managed-correlation-carrier")
    const harness = await runtimeHarness(fixture, { preloadedManagedRequest: request })
    try {
      expect(await harness.runtime.correlationSource.snapshot()).toEqual([{
        agent_id: request.agent_id,
        correlation: {
          ensure_id: request.ensure_id,
          ensure_digest: request.ensure_digest,
          launch_id: request.launch_id,
          launch_digest: request.launch_digest,
        },
      }])
    } finally {
      await harness.runtime.close()
    }
  })

  test("retains and acknowledges exact Fx finality for a definitively ended managed Agent", async () => {
    const request = await managedRuntimeFixture("managed-final")
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "managed-final-carrier")
    const harness = await runtimeHarness(fixture, {
      preloadedManagedRequest: request,
      pendingAdmissionRetryDelayMsForTests: 0,
    })
    try {
      await harness.runtime.recover()
      await waitFor(async () => {
        const ledger = await EnsureLifecycleLedger.open(harness.runtime.roots.ensure)
        return (await ledger.getManaged(request.ensure_id))?.stage === "fx_started"
      })

      const entry = harness.manifest.get(request.agent_id)
      if (entry === null) throw new Error("managed Agent lost its durable Manifest claim")
      await harness.runtime.beforeDefinitiveAgentForget(entry, { code: 0, signal: 0 })

      expect(harness.provider.recordedFinal).toEqual({ kind: "exited", code: 0 })
      expect(harness.provider.acknowledged).toHaveLength(1)
      const durable = await EnsureLifecycleLedger.open(harness.runtime.roots.ensure)
      expect(await durable.getManaged(request.ensure_id)).toMatchObject({
        fx_final: {
          receipt: {
            launch_id: request.launch_id,
            launch_digest: request.launch_digest,
            admission_key: request.source.admission_key,
            conversation_id: request.fx_conversation.resume_conversation_id,
            outcome: { kind: "exited", code: 0 },
          },
          acknowledgement: {
            launch_id: request.launch_id,
            launch_digest: request.launch_digest,
            admission_key: request.source.admission_key,
            conversation_id: request.fx_conversation.resume_conversation_id,
          },
          acknowledgement_applied: true,
        },
      })
      expect(await durable.list()).toEqual([])
    } finally {
      await harness.runtime.close()
    }
  })

  test("derives never-started proof only from the provider's exact negative winner", async () => {
    const fixture = await lifecycleFixture("ensure-b", "launch-b", "cancel")
    const harness = await runtimeHarness(fixture, { cancellation: true })
    try {
      // Hold the ensure dormant until the cancellation request is durable.
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.acceptLifecycle(fixture.end!)
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.recover()

      expect(harness.errors.map(String)).toEqual([])
      expect(harness.multiplexer.starts).toHaveLength(0)
      expect(harness.provider.cancelled.length).toBeGreaterThanOrEqual(1)
      expect(new Set(harness.provider.cancelled).size).toBe(1)
      const end = harness.receipts.find((receipt) => receipt.message_type === "end_receipt")
      expect(end).toMatchObject({
        message_type: "end_receipt",
        proof: {
          kind: "never_started",
          admission_receipt_id: "runtime-cancelled-decision",
          cancellation_request_id: harness.provider.cancelled[0],
        },
      })
      if (end === undefined || end.message_type !== "end_receipt") {
        throw new Error("missing never-started end receipt")
      }
      const acknowledgement = {
        schema_id: "fmx.ensure-lifecycle",
        schema_version: 1 as const,
        message_type: "receipt_acknowledgement" as const,
        acknowledgement_id: "runtime-cancel-end-ack",
        receipt_kind: "end" as const,
        receipt_id: end.receipt_id,
        receipt_digest: end.receipt_digest,
        ensure_id: fixture.ensure.ensure_id,
      }
      await Promise.all([
        harness.runtime.acceptLifecycle(acknowledgement),
        harness.runtime.acceptLifecycle(acknowledgement),
      ])
      expect(harness.multiplexer.removals).toEqual([fixture.ensure.agent_id])
      expect(harness.manifest.get(fixture.ensure.agent_id)).toBeNull()
      expect(harness.multiplexer.revisionRefreshes).toEqual([fixture.ensure.agent_id])
    } finally {
      await harness.runtime.close()
    }
  })

  test("startup consumes an acknowledged never-started claim idempotently", async () => {
    const fixture = await lifecycleFixture("ensure-b", "launch-b", "cancel-restart")
    const harness = await runtimeHarness(fixture, { cancellation: true })
    try {
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await harness.runtime.acceptLifecycle(fixture.end!)
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.recover()

      const entry = harness.manifest.get(fixture.ensure.agent_id)
      const end = harness.receipts.find((receipt) => receipt.message_type === "end_receipt")
      if (entry === null || end === undefined || end.message_type !== "end_receipt") {
        throw new Error("missing durable cancelled claim")
      }
      const acknowledgement = {
        schema_id: "fmx.ensure-lifecycle",
        schema_version: 1 as const,
        message_type: "receipt_acknowledgement" as const,
        acknowledgement_id: "runtime-cancel-restart-ack",
        receipt_kind: "end" as const,
        receipt_id: end.receipt_id,
        receipt_digest: end.receipt_digest,
        ensure_id: fixture.ensure.ensure_id,
      }
      // Simulate a restart after the acknowledgement reached the private
      // retirement ledger but before the startup join consumed the claim.
      await harness.retirementLedger.acknowledge(acknowledgement)
      await harness.runtime.beforeRemove({ entry, reason: "absent", session: null })
      // The startup join owns this final Manifest removal; Runtime's hook
      // merely allows it after validating the exact durable proof.
      expect(harness.manifest.get(fixture.ensure.agent_id)).not.toBeNull()
      expect(harness.multiplexer.removals).toEqual([])
      await harness.manifest.remove(fixture.ensure.agent_id)

      // A replayed acknowledgement cannot resurrect or repeat the projection.
      await harness.runtime.acceptLifecycle(acknowledgement)
      expect(harness.multiplexer.removals).toEqual([])
    } finally {
      await harness.runtime.close()
    }
  })

  test("holds cancellation behind the start lease through the durable Companion boundary", async () => {
    const fixture = await lifecycleFixture("ensure-b", "launch-b", "lease")
    const harness = await runtimeHarness(fixture, { cancellation: true, delayedStart: true })
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await waitFor(() => harness.multiplexer.starts.length === 1)

      await harness.runtime.acceptLifecycle(fixture.end!)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      expect(harness.provider.cancelled).toHaveLength(0)

      harness.multiplexer.releaseStart()
      await harness.runtime.recover()
      expect(harness.provider.cancelled).toHaveLength(0)
      expect(harness.multiplexer.starts).toHaveLength(1)
      expect(harness.errors.map(String)).toEqual([])
    } finally {
      harness.multiplexer.releaseStart()
      await harness.runtime.close()
    }
  })

  test("close waits for an in-flight managed start to release its lease", async () => {
    const fixture = await lifecycleFixture("ensure-a", "launch-a", "close")
    const harness = await runtimeHarness(fixture, { delayedStart: true })
    let closed = false
    try {
      await harness.runtime.acceptInlineSource(fixture.source)
      await harness.runtime.acceptLifecycle(fixture.ensure)
      await waitFor(() => harness.multiplexer.starts.length === 1)

      const closing = harness.runtime.close().then(() => { closed = true })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      expect(closed).toBe(false)
      harness.multiplexer.releaseStart()
      await closing
      expect(closed).toBe(true)
    } finally {
      harness.multiplexer.releaseStart()
      await harness.runtime.close()
    }
  })

  // Fx admission polling is fallible in the ordinary course of a live
  // Runtime; LifecycleRuntime wires its LifecycleCoordinator construction to
  // a fixed 16-attempt/1000 ms bounded pending-admission budget (fifteen
  // delays, fifteen seconds bounded) rather than the coordinator's own
  // lower defaults. These are behavioral composition proofs of the real
  // production wiring end to end, not a check that the source text contains
  // "16" or "1000" — and, driven through the managed-launch path, they
  // double as the Runtime-composition proof that the held initial-work
  // delivery (this correction's other half) survives every bounded pending
  // attempt through exhaustion without a second Work-control submission.
  test(
    "wires production LifecycleCoordinator to 16 bounded managed pending-admission attempts, " +
      "issuing Work-control exactly once and leaving no durable outcome",
    async () => {
      const request = await managedRuntimeFixture("pending16")
      const harness = await runtimeHarness(await lifecycleFixture("ensure-a", "launch-a", "pending16-carrier"), {
        neverAdmit: true,
        preloadedManagedRequest: request,
        // Test-only seam (LifecycleRuntimeOptions.pendingAdmissionRetryDelayMsForTests):
        // proves the 16-attempt budget without waiting out fifteen real
        // production-length (1000 ms) delays. The attempts count itself
        // (16) is never overridable — only this delay is, and only here.
        pendingAdmissionRetryDelayMsForTests: 0,
      })
      try {
        await harness.runtime.recover()
        await waitFor(() => harness.errors.length === 1)

        const inspectCalls = harness.provider.operations.filter((op) => op === "inspect").length
        expect(inspectCalls).toBe(16)
        expect(harness.errors).toHaveLength(1)
        expect(harness.errors.map(String).join("\n")).toContain("bounded admission attempts")
        // The held-delivery correction: sixteen inspections, one submission.
        expect(harness.workControl.requests).toHaveLength(1)
        expect(harness.workControl.requests[0]).toMatchObject({ method: "work.queue" })

        const durable = await EnsureLifecycleLedger.open(harness.runtime.roots.ensure)
        const record = await durable.getManaged(request.ensure_id)
        expect(record?.stage).toBe("companion_started")
        expect(record?.fx_admission_decision).toBeNull()
        expect(record?.outcome.receipt).toBeNull()
        expect(record?.attempt).toBe(1)
      } finally {
        await harness.runtime.close()
      }
    },
  )

  test("does not fire production's first managed pending-admission redrive early", async () => {
    const request = await managedRuntimeFixture("pending-delay")
    // No pendingAdmissionRetryDelayMsForTests override here: this is the
    // literal 1000 ms production value wired in the constructor.
    const harness = await runtimeHarness(await lifecycleFixture("ensure-a", "launch-a", "pending-delay-carrier"), {
      neverAdmit: true,
      preloadedManagedRequest: request,
    })
    try {
      await harness.runtime.recover()
      await waitFor(() => harness.provider.operations.includes("inspect"))
      expect(harness.provider.operations.filter((op) => op === "inspect").length).toBe(1)
      expect(harness.workControl.requests).toHaveLength(1)

      await new Promise((resolve) => setTimeout(resolve, 900))
      // One-sided proof: the second bounded-pending redrive has not fired
      // after 900 ms, so production's delay is meaningfully close to its
      // wired 1000 ms — not the coordinator's own 100 ms default and not a
      // near-zero test-seam value. Work-control stays issued exactly once
      // either way, held for the redrive that has not fired yet.
      expect(harness.provider.operations.filter((op) => op === "inspect").length).toBe(1)
      expect(harness.workControl.requests).toHaveLength(1)
    } finally {
      await harness.runtime.close()
    }
  })
})

async function runtimeHarness(
  fixture: Awaited<ReturnType<typeof lifecycleFixture>>,
  choices: {
    cancellation?: boolean
    delayedStart?: boolean
    agentDefaults?: AgentDefaults
    fmxSession?: string
    providerEnvironment?: Record<string, string>
    preloadManifestClaim?: boolean
    bindPublisher?: boolean
    projectionGate?: Promise<void>
    retirementGate?: Promise<void>
    cleanupGate?: Promise<void>
    neverAdmit?: boolean
    pendingAdmissionRetryDelayMsForTests?: number
    /** Seeds a managed-launch record directly at companion_started, plus its Manifest claim. */
    preloadedManagedRequest?: ManagedLaunchRequest
  } = {},
) {
  const home = await temporaryDirectory()
  const runtimeRoots = lifecycleRuntimeRoots(home)
  const retirementLedger = await ExactRetirementLedger.open(runtimeRoots.retirement)
  let preloadedEnsureLedger: EnsureLifecycleLedger | undefined
  let preloadedSourceLedger: InlineLaunchSourceLedger | undefined
  if (choices.preloadManifestClaim || choices.preloadedManagedRequest !== undefined) {
    preloadedEnsureLedger = await EnsureLifecycleLedger.open(runtimeRoots.ensure)
    preloadedSourceLedger = await InlineLaunchSourceLedger.open(runtimeRoots.inlineSource)
  }
  if (choices.preloadManifestClaim) {
    await preloadedSourceLedger!.claim(fixture.source)
    await preloadedEnsureLedger!.claim(fixture.ensure)
    await preloadedSourceLedger!.bindEnsureRequestForEnsure(fixture.ensure)
    await preloadedEnsureLedger!.advance(fixture.ensure.ensure_id, {
      kind: "worktree_created",
      directory: fixture.ensure.planned_worktree.directory,
      head_commit: fixture.ensure.planned_worktree.base_commit,
    })
    await preloadedEnsureLedger!.advance(fixture.ensure.ensure_id, {
      kind: "manifest_claimed",
      agent_id: fixture.ensure.agent_id,
    })
  }
  const manifest = AgentManifest.ephemeral("lifecycle-runtime-test")
  const runtimeSocketPath = `/tmp/fmx-lr-${process.pid}-${temporaryDirectories.length}.bus`
  if (choices.preloadedManagedRequest !== undefined) {
    const request = choices.preloadedManagedRequest
    await preloadedEnsureLedger!.claimManaged(request)
    await preloadedEnsureLedger!.advanceManaged(request.ensure_id, {
      kind: "directory_validated",
      directory: request.workspace.directory,
      repository: request.workspace.repository,
      checkout_root: request.workspace.checkout_root,
      head_commit: request.workspace.head_commit,
    })
    await preloadedEnsureLedger!.advanceManaged(request.ensure_id, {
      kind: "manifest_claimed",
      agent_id: request.agent_id,
    })
    await preloadedEnsureLedger!.bindManagedFxFinalReceiptAuthority(request.ensure_id, {
      admission_key: request.source.admission_key,
      state_root: request.source.launch_request.state_root,
    })
    await preloadedEnsureLedger!.retainManagedPreparedConversation(
      request.ensure_id,
      request.fx_conversation.resume_conversation_id!,
    )
    await preloadedEnsureLedger!.advanceManaged(request.ensure_id, {
      kind: "companion_started",
      session_name: `fmx-${request.agent_id}`,
      pane_id: `p_${request.agent_id}`,
    })
    // The Companion is already durably started for this managed Agent: seed
    // the Manifest claim + Work-control binding the way projectManagedAgent
    // would have, without going through the FakeMultiplexer.
    const workControlBinding = mintFxWorkControlBinding(runtimeSocketPath, request.agent_id)
    const { saved } = manifest.ensureClaim({
      identity: identityFor(request.agent_id),
      cwd: request.workspace.directory,
      fxPath: "/resolved/fmx-fx",
      fxArgs: null,
      workControl: workControlBinding,
      createdAt: 1,
    })
    await saved
    await manifest.markRunning(request.agent_id)
  }
  const multiplexer = new FakeMultiplexer(
    manifest,
    choices.delayedStart ?? false,
    choices.projectionGate,
  )
  const workControl = new FakeWorkControl()
  const provider = new FakeProvider(
    fixture,
    workControl,
    choices.cancellation ?? false,
    choices.providerEnvironment,
    choices.neverAdmit ?? false,
    choices.preloadedManagedRequest?.fx_conversation.resume_conversation_id ?? "conversation-runtime",
  )
  const retirement = choices.retirementGate === undefined
    ? undefined
    : new BarrierRetirement(retirementLedger, choices.retirementGate)
  const cleanup = choices.cleanupGate === undefined
    ? undefined
    : new BarrierCleanup(retirementLedger, choices.cleanupGate)
  const receipts: Array<Record<string, any>> = []
  const errors: unknown[] = []
  const options = {
    home,
    homeId: "lifecycle-runtime-test",
    fmxSession: choices.fmxSession ?? fixture.ensure.fmx_session,
    agentDefaults: choices.agentDefaults,
    fxPath: "/resolved/fmx-fx",
    runtimeSocketPath,
    adeBinding: { socketPath: join(home, "ade.sock"), instanceId: "ignored" },
    manifest,
    companion: { list: async () => [] },
    companionDirectory: join(home, "zmx"),
    environment: {
      KEEP: "yes",
      FX_MODEL: "ambient-model",
      FX_EFFORT: "ambient-effort",
    },
    now: () => new Date("2026-08-31T20:00:00.000Z"),
    onError: (error: unknown) => { errors.push(error) },
    ensureLedger: preloadedEnsureLedger,
    inlineSourceLedger: preloadedSourceLedger,
    retirementLedger,
    worktreeCreator: {
      create: async (request: EnsureRequest) => ({
        kind: "worktree_created" as const,
        directory: request.planned_worktree.directory,
        head_commit: request.planned_worktree.base_commit,
      }),
    },
    launchProvider: provider,
    retirement,
    cleanup,
    workControl,
    companionAuthority: {
      list: async () => [],
      connect: async () => { throw new Error("never-started retirement must not connect") },
    },
    pendingAdmissionRetryDelayMsForTests: choices.pendingAdmissionRetryDelayMsForTests,
  } satisfies LifecycleRuntimeOptions
  const runtime = await LifecycleRuntime.open(options)
  runtime.bindMultiplexer(multiplexer)
  if (choices.bindPublisher !== false) {
    runtime.bindReceiptPublisher((receipt) => { receipts.push(structuredClone(receipt)) })
  }
  expect(runtime.roots).toEqual(lifecycleRuntimeRoots(home))
  return {
    runtime,
    runtimeSocketPath,
    retirementLedger,
    manifest,
    multiplexer,
    workControl,
    provider,
    retirement,
    cleanup,
    receipts,
    errors,
  }
}

class FakeMultiplexer implements LifecycleRuntimeMultiplexer {
  readonly claims: ManagedAgentClaim[] = []
  readonly starts: ManagedAgentInvocation[] = []
  readonly removals: string[] = []
  readonly revisionRefreshes: string[] = []

  private readonly startGate = Promise.withResolvers<void>()

  constructor(
    private readonly manifest: AgentManifest,
    private readonly delayedStart: boolean,
    private readonly projectionGate?: Promise<void>,
  ) {}

  async projectManagedAgent(claim: ManagedAgentClaim): Promise<ManifestEntry> {
    this.claims.push(structuredClone(claim))
    if (this.projectionGate) await this.projectionGate
    const { result, saved } = this.manifest.ensureClaim({
      identity: identityFor(claim.agentId),
      cwd: claim.cwd,
      fxPath: claim.fxPath,
      fxArgs: claim.fxArgs,
      workControl: claim.workControl,
      createdAt: claim.createdAt ?? 1,
    })
    await saved
    return result
  }

  async startManagedAgent(agentId: string, invocation: ManagedAgentInvocation) {
    this.starts.push(structuredClone(invocation))
    if (this.delayedStart) await this.startGate.promise
    const entry = await this.manifest.markRunning(agentId)
    return { sessionName: entry.zmxName, paneId: entry.paneId }
  }

  async removeManagedAgentProjection(agentId: string): Promise<void> {
    this.removals.push(agentId)
    await this.manifest.remove(agentId)
  }

  refreshManagedAgentProjection(agentId: string): void {
    if (this.manifest.get(agentId) !== null) {
      throw new Error("projection revision refreshed before Manifest removal")
    }
    this.revisionRefreshes.push(agentId)
  }

  releaseStart(): void {
    this.startGate.resolve()
  }
}

class FakeWorkControl {
  readonly requests: Array<{ method: string; params: unknown; instanceId: string }> = []
  admitted = false

  async request(binding: { instanceId: string }, method: string, params: Record<string, unknown>) {
    this.requests.push({ method, params: structuredClone(params), instanceId: binding.instanceId })
    this.admitted = true
    return {
      turn_id: "41",
      disposition: "queued" as const,
      snapshot: { active_turn_id: "41", queue_paused: false, queue: [] },
    }
  }
}

class FakeProvider {
  readonly operations: string[] = []
  readonly cancelled: string[] = []
  readonly acknowledged: string[] = []
  recordedFinal: unknown = null
  private final: FxFinalReceipt | null = null
  private lastCorrelation: {
    admissionKey: string
    launchDigest: string
    launchId: string
  } | null = null

  constructor(
    private readonly fixture: Awaited<ReturnType<typeof lifecycleFixture>>,
    private readonly workControl: FakeWorkControl,
    private readonly cancellation: boolean,
    private readonly providerEnvironment: Record<string, string> = {},
    /** Fx never decides: every inspect() stays pending regardless of admission. */
    private readonly neverAdmit: boolean = false,
    private readonly finalConversationId: string = "conversation-runtime",
  ) {}

  async prepare() {
    this.operations.push("prepare")
    return {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "launch_receipt",
      request_id: this.fixture.source.launch_request.request_id,
      receipt_id: "runtime-launch-receipt",
      launch_id: this.fixture.ensure.launch_id,
      launch_digest: this.fixture.ensure.launch_digest,
      admission_key: this.fixture.source.admission_key,
      status: "accepted",
    } as const
  }

  async build() {
    this.operations.push("build")
    return {
      command: [
        "--state-dir",
        this.fixture.source.launch_request.state_root,
        "--context-limit",
        "skill_chunk_bytes=4096",
        "--tool",
        "read",
      ],
      cwd: this.fixture.ensure.planned_worktree.directory,
      env: {
        FX_INTERNAL_LAUNCH_STATE_ROOT: this.fixture.source.launch_request.state_root,
        FX_INTERNAL_LAUNCH_ADMISSION_KEY: this.fixture.source.admission_key,
        FX_INTERNAL_LAUNCH_DIGEST: this.fixture.ensure.launch_digest,
        FX_INTERNAL_LAUNCH_ID: this.fixture.ensure.launch_id,
        FX_INTERNAL_LAUNCH_CONVERSATION_ID: "conversation-runtime",
        ...this.providerEnvironment,
      },
      conversationId: "conversation-runtime",
      mode: "initial" as const,
    }
  }

  async inspect(correlation?: {
    admissionKey: string
    launchDigest: string
    launchId: string
  }) {
    this.operations.push("inspect")
    if (correlation !== undefined) this.lastCorrelation = structuredClone(correlation)
    return this.authority(
      this.final,
      !this.neverAdmit && this.workControl.admitted ? this.admittedDecision(correlation) : null,
    )
  }

  async cancel(_stateRoot: string, request: { request_id: string }) {
    this.operations.push("cancel")
    this.cancelled.push(request.request_id)
    return this.authority(null, this.cancelledDecision(request.request_id))
  }

  async recordFinal(
    correlation: { admissionKey: string; launchDigest: string; launchId: string },
    observedAt: string,
    outcome: any,
  ) {
    this.operations.push("record_final")
    this.lastCorrelation = structuredClone(correlation)
    this.recordedFinal = structuredClone(outcome)
    const partial = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "final_receipt",
      receipt_id: "runtime-final-receipt",
      receipt_digest: "",
      launch_id: correlation.launchId,
      launch_digest: correlation.launchDigest,
      admission_key: correlation.admissionKey,
      conversation_id: this.finalConversationId,
      outcome,
      observed_at: observedAt,
      retained_until_acknowledged: true,
    } as FxFinalReceipt
    this.final = { ...partial, receipt_digest: deriveFxFinalReceiptDigest(partial) }
    return this.authority(this.final, this.admittedDecision(correlation))
  }

  async acknowledgeFinal(_stateRoot: string, acknowledgement: { acknowledgement_id: string }) {
    this.operations.push("acknowledge_final")
    this.acknowledged.push(acknowledgement.acknowledgement_id)
    return {
      ...this.authority(this.final, this.admittedDecision(this.lastCorrelation ?? undefined)),
      finalAcknowledgementId: acknowledgement.acknowledgement_id,
    }
  }

  private authority(finalReceipt: FxFinalReceipt | null, decision: FxAdmissionDecision | null) {
    return {
      launchReceipt: {} as any,
      decision: decision as any,
      finalReceipt: finalReceipt as any,
      finalAcknowledgementId: null,
    }
  }

  private admittedDecision(correlation?: {
    admissionKey: string
    launchDigest: string
    launchId: string
  }): FxAdmissionDecision {
    const partial = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "admission_decision",
      receipt_id: "runtime-admitted-decision",
      receipt_digest: "",
      launch_id: correlation?.launchId ?? this.fixture.ensure.launch_id,
      launch_digest: correlation?.launchDigest ?? this.fixture.ensure.launch_digest,
      admission_key: correlation?.admissionKey ?? this.fixture.source.admission_key,
      decision: { kind: "admitted", turn_id: "41", disposition: "queued" },
    } as FxAdmissionDecision
    return { ...partial, receipt_digest: deriveFxAdmissionDecisionDigest(partial) }
  }

  private cancelledDecision(requestId: string): FxAdmissionDecision {
    if (!this.cancellation) throw new Error("unexpected provider cancellation")
    const partial = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "admission_decision",
      receipt_id: "runtime-cancelled-decision",
      receipt_digest: "",
      launch_id: this.fixture.ensure.launch_id,
      launch_digest: this.fixture.ensure.launch_digest,
      admission_key: this.fixture.source.admission_key,
      decision: { kind: "cancelled_before_start", cancellation_request_id: requestId },
    } as FxAdmissionDecision
    return { ...partial, receipt_digest: deriveFxAdmissionDecisionDigest(partial) }
  }
}

class BarrierRetirement {
  endCalls = 0

  constructor(
    private readonly ledger: ExactRetirementLedger,
    private readonly gate: Promise<void>,
  ) {}

  async end(_ensure: EnsureLifecycleRecord, request: EndRequest) {
    this.endCalls++
    await this.gate
    await this.ledger.markKillIntent(request.ensure_id, "2026-08-31T20:00:00.000Z")
    const receipt = {
      schema_id: "fmx.ensure-lifecycle",
      schema_version: 1,
      message_type: "end_receipt" as const,
      request_id: request.request_id,
      receipt_id: `barrier-end-${request.ensure_id}`,
      workplace_instance_id: request.workplace_instance_id,
      fmx_session: request.fmx_session,
      ensure_id: request.ensure_id,
      ensure_digest: request.ensure_digest,
      launch_id: request.launch_id,
      launch_digest: request.launch_digest,
      worktree_id: request.worktree_id,
      agent_id: request.agent_id,
      conversation_id: request.conversation_id,
      end_id: request.end_id,
      end_digest: request.end_digest,
      proof: {
        kind: "ended" as const,
        companion_session: `fmx-${request.agent_id}`,
        pane_id: `p_${request.agent_id}`,
        exit_code: 0,
        signal: 0,
        reason: "requested" as const,
        observed_at: "2026-08-31T20:00:00.000Z",
      },
      receipt_digest: "",
    } satisfies EndReceipt
    receipt.receipt_digest = deriveLifecycleReceiptDigest(receipt)
    await this.ledger.retainEndReceipt(receipt)
    return receipt
  }

  acknowledge(acknowledgement: any) {
    return this.ledger.acknowledge(acknowledgement)
  }
}

class BarrierCleanup {
  cleanupCalls = 0

  constructor(
    private readonly ledger: ExactRetirementLedger,
    private readonly gate: Promise<void>,
  ) {}

  async cleanup(_ensure: unknown, request: CleanupRequest) {
    this.cleanupCalls++
    await this.gate
    const receipt = {
      schema_id: "fmx.ensure-lifecycle",
      schema_version: 1,
      message_type: "cleanup_receipt" as const,
      request_id: request.request_id,
      receipt_id: `barrier-cleanup-${request.ensure_id}`,
      workplace_instance_id: request.workplace_instance_id,
      fmx_session: request.fmx_session,
      ensure_id: request.ensure_id,
      ensure_digest: request.ensure_digest,
      launch_id: request.launch_id,
      launch_digest: request.launch_digest,
      worktree_id: request.worktree_id,
      agent_id: request.agent_id,
      conversation_id: request.conversation_id,
      end_id: request.end_id,
      end_digest: request.end_digest,
      cleanup_id: request.cleanup_id,
      cleanup_digest: request.cleanup_digest,
      worktree_directory: request.worktree_directory,
      outcome: { kind: "not_applicable" as const },
      observed_at: "2026-08-31T20:00:00.000Z",
      receipt_digest: "",
    } satisfies CleanupReceipt
    receipt.receipt_digest = deriveLifecycleReceiptDigest(receipt)
    await this.ledger.retainCleanupReceipt(receipt)
    return receipt
  }
}

async function lifecycleFixture(
  ensureId: "ensure-a" | "ensure-b",
  launchId: "launch-a" | "launch-b",
  suffix = "launch",
  launchOverrides: { model?: string | null; effort?: string | null } = {},
) {
  const ensures = await messages("ensure-lifecycle.jsonl", ensureLifecycleMessageSchema)
  const launches = await messages("fx-launch-admission-final.jsonl", fxLaunchAdmissionFinalMessageSchema)
  const ensure = structuredClone(ensures.find((message): message is EnsureRequest =>
    message.message_type === "ensure_request" && message.ensure_id === ensureId
  )!)
  const launch = structuredClone(launches.find((message): message is FrozenLaunchRequest =>
    message.message_type === "launch_request" && message.launch_id === launchId
  )!)
  ensure.request_id = `${ensure.request_id}-${suffix}`
  ensure.ensure_id = `${ensure.ensure_id}-${suffix}`
  ensure.launch_id = `${ensure.launch_id}-${suffix}`
  ensure.worktree_id = `${ensure.worktree_id}-${suffix}`
  ensure.agent_id = ensureId === "ensure-a" ? "a".repeat(32) : "b".repeat(32)
  ensure.planned_worktree = {
    ...ensure.planned_worktree,
    directory: `/var/tmp/fmx-lifecycle-runtime-${ensureId}-${suffix}`,
    branch: `runtime-${ensureId}-${suffix}`,
  }
  const controls = encodeInlineLaunchControls(["--context-limit", "skill_chunk_bytes=4096", "--tool", "read"])
  const initial = Buffer.from("initial λ work", "utf8")
  launch.request_id = `${launch.request_id}-${suffix}`
  launch.launch_id = ensure.launch_id
  launch.admission_key = `runtime-admission-${ensureId}-${suffix}`
  launch.directory = ensure.planned_worktree.directory
  launch.state_root = `/var/tmp/fmx-lifecycle-provider-${ensureId}-${suffix}`
  if (launchOverrides.model === null) delete launch.model
  else if (launchOverrides.model !== undefined) launch.model = launchOverrides.model
  if (launchOverrides.effort === null) delete launch.effort
  else if (launchOverrides.effort !== undefined) launch.effort = launchOverrides.effort
  launch.initial_work_digest = encodeInlineSourceBytes(initial).sha256
  launch.remaining_launch_controls_digest = encodeInlineSourceBytes(controls).sha256
  launch.launch_digest = deriveFrozenLaunchDigest(launch)
  ensure.launch_digest = launch.launch_digest
  ensure.ensure_digest = deriveEnsureDigest(ensure)
  const sourceWithoutDigest = {
    schema_id: "fmx.inline-launch-source",
    schema_version: 2,
    message_type: "source_request",
    request_id: `runtime-source-request-${ensureId}-${suffix}`,
    workplace_instance_id: ensure.workplace_instance_id,
    fmx_session: ensure.fmx_session,
    ensure_id: ensure.ensure_id,
    ensure_digest: ensure.ensure_digest,
    worktree_id: ensure.worktree_id,
    agent_id: ensure.agent_id,
    launch_id: ensure.launch_id,
    launch_digest: ensure.launch_digest,
    admission_key: launch.admission_key,
    source_id: `runtime-source-${ensureId}-${suffix}`,
    launch_request: launch,
    initial_work: encodeInlineSourceBytes(initial),
    launch_controls: encodeInlineSourceBytes(controls),
  } satisfies Omit<InlineLaunchSourceRequest, "source_digest">
  const source = {
    ...sourceWithoutDigest,
    source_digest: deriveInlineLaunchSourceDigest(sourceWithoutDigest as InlineLaunchSourceRequest),
  }
  let end: EndRequest | null = null
  let cleanup: CleanupRequest | null = null
  if (ensureId === "ensure-a" || ensureId === "ensure-b") {
    const endId = ensureId === "ensure-a" ? "end-a" : "end-b"
    end = structuredClone(ensures.find((message): message is EndRequest =>
      message.message_type === "end_request" && (message as EndRequest).end_id === endId
    )!)
    end.request_id = `${end.request_id}-${suffix}`
    end.ensure_id = ensure.ensure_id
    end.ensure_digest = ensure.ensure_digest
    end.launch_id = ensure.launch_id
    end.launch_digest = ensure.launch_digest
    end.worktree_id = ensure.worktree_id
    end.agent_id = ensure.agent_id
    if (ensureId === "ensure-a") end.conversation_id = "conversation-runtime"
    end.end_id = `${end.end_id}-${suffix}`
    end.end_digest = deriveEndDigest(end)
    const cleanupId = ensureId === "ensure-a" ? "cleanup-a" : "cleanup-b"
    cleanup = structuredClone(ensures.find((message): message is CleanupRequest =>
      message.message_type === "cleanup_request" && (message as CleanupRequest).cleanup_id === cleanupId
    )!)
    cleanup.request_id = `${cleanup.request_id}-${suffix}`
    cleanup.ensure_id = ensure.ensure_id
    cleanup.ensure_digest = ensure.ensure_digest
    cleanup.launch_id = ensure.launch_id
    cleanup.launch_digest = ensure.launch_digest
    cleanup.worktree_id = ensure.worktree_id
    cleanup.agent_id = ensure.agent_id
    if (ensureId === "ensure-a") cleanup.conversation_id = "conversation-runtime"
    cleanup.end_id = end.end_id
    cleanup.end_digest = end.end_digest
    cleanup.cleanup_id = `${cleanup.cleanup_id}-${suffix}`
    cleanup.worktree_directory = ensure.planned_worktree.directory
    cleanup.cleanup_digest = deriveCleanupDigest(cleanup)
  }
  return { ensure, source, end, cleanup }
}

async function managedRuntimeFixture(suffix: string): Promise<ManagedLaunchRequest> {
  const launches = await messages("fx-launch-admission-final.jsonl", fxLaunchAdmissionFinalMessageSchema)
  const base = launches.find((message): message is FrozenLaunchRequest =>
    message.message_type === "launch_request" && message.launch_id === "launch-a"
  )!
  const serial = suffix.replace(/[^a-z0-9]/gu, "").slice(0, 12) || "x"
  const directory = `/var/tmp/fmx-lifecycle-runtime-managed-${serial}`
  const conversationId = "1788123456789-1788123456789000000-a1b2c3d4"
  const initialWork = encodeInlineSourceBytes(Buffer.from("managed runtime hello", "utf8"))
  const launchControls = encodeInlineSourceBytes(
    encodeCanonicalJson({ remaining_global_args: [] }),
  )
  const launch = structuredClone(base)
  launch.request_id = `runtime-managed-launch-request-${serial}`
  launch.launch_id = `runtime-managed-launch-${serial}`
  launch.admission_key = `runtime-managed-admission-${serial}`
  launch.directory = directory
  launch.conversation_name = `runtime-managed-${serial}`
  launch.resume = { mode: "exact", conversation_id: conversationId }
  launch.initial_work_digest = initialWork.sha256
  launch.remaining_launch_controls_digest = launchControls.sha256
  launch.launch_digest = deriveFrozenLaunchDigest(launch)
  const request = {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "launch_request",
    request_id: `runtime-managed-request-${serial}`,
    workplace_instance_id: "workplace-lifecycle-runtime-test",
    fmx_session: "default",
    ensure_id: `runtime-managed-ensure-${serial}`,
    ensure_digest: "0".repeat(64),
    launch_id: launch.launch_id,
    launch_digest: launch.launch_digest,
    agent_id: serial.padEnd(32, "a").slice(0, 32).replace(/[^0-9a-f]/gu, "a"),
    workspace: {
      kind: "existing_directory",
      directory,
      repository: "/var/tmp/fmx-lifecycle-runtime-managed-repository",
      checkout_root: directory,
      head_commit: "b".repeat(40),
    },
    fx_conversation: {
      name: launch.conversation_name,
      resume_conversation_id: conversationId,
    },
    source: {
      source_id: `runtime-managed-source-${serial}`,
      source_digest: "0".repeat(64),
      admission_key: launch.admission_key,
      launch_request: launch,
      initial_work: initialWork,
      launch_controls: launchControls,
    },
  } as ManagedLaunchRequest
  request.source.source_digest = deriveManagedLaunchSourceDigest(request)
  request.ensure_digest = deriveManagedLaunchEnsureDigest(request)
  return parseManagedLaunchRequest(request)
}

async function messages<T>(file: string, schema: { parse(value: unknown): T }): Promise<T[]> {
  return (await readFile(join(CONTRACTS, file), "utf8")).trimEnd().split("\n")
    .map((line) => schema.parse(JSON.parse(line)))
}

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fmx-lifecycle-runtime-")))
  temporaryDirectories.push(directory)
  return directory
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (await condition()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
  }
  throw new Error("timed out waiting for lifecycle Runtime condition")
}
