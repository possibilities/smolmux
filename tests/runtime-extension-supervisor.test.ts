import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_CAPABILITIES,
  RUNTIME_EXTENSION_SCHEMA_ID,
  ensureLifecycleMessageSchema,
  type EnsureLifecycleMessage,
} from "../src/agentworkplace-contracts.ts"
import {
  RuntimeExtensionError,
  RuntimeExtensionSupervisor,
  type RuntimeExtensionInboundOutcome,
  type RuntimeExtensionInboundRequest,
  type RuntimeExtensionLifecycleInbound,
  type RuntimeExtensionLifecycleReceipt,
  type RuntimeExtensionLifecycleRequest,
  type RuntimeExtensionSupervisorOptions,
} from "../src/runtime-extension.ts"
import type { RuntimeExtensionStartup } from "../src/runtime-startup.ts"
import { encodeCanonicalJson } from "../src/contract-codec.ts"
import {
  INLINE_LAUNCH_SOURCE_SCHEMA_ID,
  INLINE_LAUNCH_SOURCE_SCHEMA_VERSION,
  deriveFrozenLaunchDigest,
  deriveInlineLaunchSourceDigest,
  encodeInlineSourceBytes,
  type FrozenLaunchRequest,
  type InlineLaunchSourceRequest,
} from "../src/inline-launch-source.ts"
import {
  deriveManagedLaunchTerminalReceiptDigest,
  deriveManagedLaunchTerminalReceiptId,
  deriveManagedLaunchEnsureDigest,
  deriveManagedLaunchOutcomeDigest,
  deriveManagedLaunchSourceDigest,
  type ManagedLaunchTerminalReceipt,
  type ManagedLaunchOutcome,
  type ManagedLaunchRequest,
  type ManagedLaunchRetry,
} from "../src/managed-launch-contract.ts"
import {
  deriveFxFinalReceiptDigest,
  type FxFinalReceipt,
} from "../src/ensure-lifecycle-ledger.ts"

const FIXTURE = fileURLToPath(new URL("./fixtures/runtime-extension.ts", import.meta.url))
const PEER = fileURLToPath(new URL("./runtime-extension-supervisor-child.ts", import.meta.url))
const LIFECYCLE_FIXTURE = fileURLToPath(new URL(
  "../contracts/agentworkplace/v1/ensure-lifecycle.jsonl",
  import.meta.url,
))
const supervisors = new Set<RuntimeExtensionSupervisor>()
const temporaryDirectories = new Set<string>()

afterEach(async () => {
  for (const supervisor of supervisors) await supervisor.close()
  supervisors.clear()
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe("Runtime-extension readiness and strict directions", () => {
  test("completes exact readiness and serves every extension-to-Runtime request direction", async () => {
    const directory = await temporaryDirectory()
    const log = join(directory, "fixture.log")
    const handled: string[] = []
    const allHandled = deferred<void>()
    const script = [
      {
        schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
        schema_version: 1,
        message_type: "snapshot_get",
        request_id: "snapshot-request",
        fmx_session: "session-beta",
        after_revision: null,
      },
      {
        schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
        schema_version: 1,
        message_type: "present",
        request_id: "present-request",
        fmx_session: "session-beta",
        agent_id: "11111111111111111111111111111111",
        focus: false,
      },
      {
        schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
        schema_version: 1,
        message_type: "unavailable_slot_publish",
        request_id: "publish-request",
        fmx_session: "session-beta",
        card: {
          slot_id: "slot-a",
          card_revision: "1",
          title: "Member unavailable",
          message: "The exact member is unavailable.",
          action: { action_id: "retry-member", label: "Retry member" },
        },
      },
      {
        schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
        schema_version: 1,
        message_type: "unavailable_slot_clear",
        request_id: "clear-request",
        fmx_session: "session-beta",
        slot_id: "slot-a",
        card_revision: "1",
      },
    ]
    const supervisor = await startSupervisor(FIXTURE, "ready", {
      env: {
        FMX_FIXTURE_EXTENSION_LOG: log,
        FMX_FIXTURE_EXTENSION_SCRIPT: JSON.stringify(script),
      },
      onRequest: (request) => {
        handled.push(request.message_type)
        if (handled.length === script.length) allHandled.resolve()
        return successfulOutcome(request)
      },
    })

    expect(supervisor.state).toBe("ready")
    expect(supervisor.readiness).toMatchObject({
      fmx_session: "session-beta",
      workplace_instance_id: "fixture-workplace",
      capabilities: [...RUNTIME_EXTENSION_CAPABILITIES, "fixture_observability"],
    })
    await withTestTimeout(allHandled.promise, 1_000, "fixture requests were not handled")
    await supervisor.invalidateSnapshot("9")
    const received = await waitForMessages(log, (messages) => messages.length >= 6)
    expect(handled.sort()).toEqual([
      "present",
      "snapshot_get",
      "unavailable_slot_clear",
      "unavailable_slot_publish",
    ])
    expect(received.filter((message) => message.message_type === "snapshot_result")).toHaveLength(1)
    expect(received.filter((message) => message.message_type === "response")).toHaveLength(3)
    expect(received.filter((message) => message.message_type === "snapshot_invalidated")).toEqual([
      expect.objectContaining({ fmx_session: "session-beta", revision: "9" }),
    ])
  })

  const startupFailures = [
    ["refuses an explicit readiness refusal", "refuse", "readiness_refused"],
    ["bounds a silent readiness timeout", "timeout", "startup_timeout"],
    ["rejects readiness identity drift", "identity_mismatch", "protocol_error"],
    ["rejects a missing required capability", "missing_capability", "protocol_error"],
    ["rejects malformed framed output", "malformed", "protocol_error"],
  ] as const
  for (const [name, mode, code] of startupFailures) {
    test(name, async () => {
      const error = await expectRuntimeError(RuntimeExtensionSupervisor.start(startupFor(FIXTURE), options(mode, {
        startupTimeoutMs: mode === "timeout" ? 30 : 1_000,
      })))
      expect(error.code).toBe(code)
      expect(error.generation).toBe(1)
    })
  }

  test("reports and reaps a child which exits before readiness", async () => {
    const error = await expectRuntimeError(RuntimeExtensionSupervisor.start(
      startupFor(FIXTURE),
      options("exit_before_ready"),
    ))
    expect(["child_exit", "stdout_closed"]).toContain(error.code)
    expect(error.exitCode).toBe(17)
    expect(error.message).toContain(error.code === "child_exit" ? "before readiness" : "stdout closed")
  })

  const framedRefusals = [
    ["rejects a request before readiness", "request_before_ready", "protocol_error"],
    ["rejects an oversized announced frame", "oversized_frame", "protocol_error"],
    ["rejects a partial frame at child exit", "partial_frame_exit", "protocol_error"],
  ] as const
  for (const [name, mode, code] of framedRefusals) {
    test(name, async () => {
      const error = await expectRuntimeError(RuntimeExtensionSupervisor.start(startupFor(PEER), options(mode)))
      expect(error.code).toBe(code)
      if (mode === "partial_frame_exit") expect(error.exitCode).toBe(31)
    })
  }

  const postReadyRefusals = [
    ["rejects the Runtime-to-extension notification in the reverse direction", "wrong_direction_after_ready"],
    ["rejects readiness a second time", "duplicate_ready"],
    ["rejects an orphan response", "orphan_response"],
    ["rejects a request for another fmx Session", "wrong_session_request"],
    ["rejects a reused child request id", "duplicate_request"],
  ] as const
  for (const [name, mode] of postReadyRefusals) {
    test(name, async () => {
      const disconnected = deferred<RuntimeExtensionError>()
      const supervisor = await startSupervisor(PEER, mode, { onDisconnect: disconnected.resolve })
      const error = await withTestTimeout(disconnected.promise, 1_000, "post-readiness failure did not degrade")
      expect(error.code).toBe("protocol_error")
      expect(supervisor.state).toBe("degraded")
      expect(supervisor.processId).toBeNull()
    })
  }

  test("validates startup facts before spawning a child", async () => {
    const invalid = startupFor(PEER)
    invalid.association.members.pop()
    const error = await expectRuntimeError(RuntimeExtensionSupervisor.start(invalid, options("ready")))
    expect(error.code).toBe("invalid_startup")
    expect(error.generation).toBeNull()
  })

  test("reports an unlaunchable absolute executable without leaving a process", async () => {
    const invalid = startupFor(PEER)
    invalid.registration.argv = ["/definitely/not/a/runtime-extension"]
    const error = await expectRuntimeError(RuntimeExtensionSupervisor.start(invalid, options("ready")))
    expect(error.code).toBe("spawn_failed")
    expect(error.message).toContain("cannot launch Runtime extension")
  })

  test("keeps only bounded, terminal-safe causal stderr", async () => {
    const diagnostic = `discard-${"x".repeat(80)}\u001b[31mTAIL`
    const error = await expectRuntimeError(RuntimeExtensionSupervisor.start(startupFor(FIXTURE), options(
      "exit_before_ready",
      { stderrMaxBytes: 24, env: { FMX_FIXTURE_EXTENSION_STDERR: diagnostic } },
    )))
    expect(error.stderrTruncated).toBe(true)
    expect(Buffer.byteLength(error.stderr)).toBeLessThanOrEqual(24)
    expect(error.stderr).toEndWith("[31mTAIL")
    expect(error.stderr).not.toContain("\u001b")
    expect(error.message).toContain("Runtime-extension stderr")
  })
})

describe("Runtime-extension ensure-lifecycle transport", () => {
  test("carries frozen requests and one-way acknowledgements inward while publishing receipts asynchronously", async () => {
    const directory = await temporaryDirectory()
    const log = join(directory, "lifecycle.log")
    const fixture = (await frozenLifecycleMessages())
      .filter((message) => "ensure_id" in message && message.ensure_id === "ensure-a")
    const requests = fixture.filter((message): message is RuntimeExtensionLifecycleRequest =>
      message.message_type === "ensure_request" ||
      message.message_type === "end_request" ||
      message.message_type === "cleanup_request")
    const receipts = fixture.filter((message): message is RuntimeExtensionLifecycleReceipt =>
      (message.message_type === "ensure_receipt" && "status" in message && message.status === "complete") ||
      message.message_type === "end_receipt" ||
      message.message_type === "cleanup_receipt")
    expect(requests.map((message) => message.message_type)).toEqual([
      "ensure_request",
      "end_request",
      "cleanup_request",
    ])
    expect(receipts.map((message) => message.message_type)).toEqual([
      "ensure_receipt",
      "end_receipt",
      "cleanup_receipt",
    ])

    const observed: RuntimeExtensionLifecycleInbound[] = []
    const requestsHandled = deferred<void>()
    const allHandled = deferred<void>()
    const supervisor = await startSupervisor(PEER, "ready", {
      env: {
        FMX_SUPERVISOR_CHILD_LOG: log,
        FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify(requests),
        FMX_SUPERVISOR_CHILD_ACK_LIFECYCLE: "1",
      },
      onLifecycleMessage: (message) => {
        observed.push(message)
        if (observed.length === requests.length) requestsHandled.resolve()
        if (observed.length === requests.length + receipts.length) allHandled.resolve()
      },
    })

    await withTestTimeout(requestsHandled.promise, 1_000, "lifecycle requests were not admitted")
    await Promise.all(receipts.map((receipt) => supervisor.publishLifecycleReceipt(receipt)))
    await withTestTimeout(allHandled.promise, 1_000, "lifecycle acknowledgements were not admitted")

    expect(observed.slice(0, requests.length).map((message) => message.message_type)).toEqual([
      "ensure_request",
      "end_request",
      "cleanup_request",
    ])
    expect(observed.slice(requests.length).map((message) => message.message_type)).toEqual([
      "receipt_acknowledgement",
      "receipt_acknowledgement",
      "receipt_acknowledgement",
    ])
    const received = await waitForMessages(
      log,
      (messages) => messages.filter((message) => String(message.message_type).endsWith("_receipt")).length === 3,
    )
    expect(received.filter((message) => String(message.message_type).endsWith("_receipt"))).toEqual(receipts)
    expect(received.filter((message) => message.message_type === "response")).toEqual([])
    expect(supervisor.state).toBe("ready")
  })

  test("rejects lifecycle receipts in the child-to-host direction", async () => {
    const receipt = (await frozenLifecycleMessages()).find((message) => message.message_type === "end_receipt")!
    const disconnected = deferred<RuntimeExtensionError>()
    const supervisor = await startSupervisor(PEER, "ready", {
      env: { FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([receipt]) },
      onLifecycleMessage: () => {},
      onDisconnect: disconnected.resolve,
    })
    const error = await withTestTimeout(disconnected.promise, 1_000, "reverse lifecycle receipt was not rejected")
    expect(error.code).toBe("protocol_error")
    expect(error.message).toContain("extension-to-Runtime direction")
    expect(supervisor.state).toBe("degraded")
  })

  test("rejects another valid AgentWorkplace family instead of admitting the broad union", async () => {
    const disconnected = deferred<RuntimeExtensionError>()
    const supervisor = await startSupervisor(PEER, "ready", {
      env: {
        FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([{
          schema_id: "fmx.agent-defaults",
          schema_version: 1,
          message_type: "defaults_table",
          entries: [],
        }]),
      },
      onLifecycleMessage: () => {},
      onDisconnect: disconnected.resolve,
    })
    const error = await withTestTimeout(disconnected.promise, 1_000, "broad-union message was not rejected")
    expect(error.code).toBe("protocol_error")
    expect(error.message).toContain("outside the Runtime-extension, lifecycle, and managed-launch link families")
    expect(supervisor.state).toBe("degraded")
  })

  test("requires the narrow lifecycle handler and exact link identity", async () => {
    const request = (await frozenLifecycleMessages()).find((message) => message.message_type === "ensure_request")!
    for (const [label, scripted, onLifecycleMessage, diagnostic] of [
      ["missing handler", request, undefined, "without an installed lifecycle handler"],
      [
        "foreign Workplace",
        { ...request, workplace_instance_id: "foreign-workplace" },
        () => {},
        "names Workplace foreign-workplace",
      ],
      [
        "foreign Session",
        { ...request, fmx_session: "session-alpha" },
        () => {},
        "names fmx Session session-alpha",
      ],
    ] as const) {
      const disconnected = deferred<RuntimeExtensionError>()
      const supervisor = await startSupervisor(PEER, "ready", {
        env: { FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([scripted]) },
        onLifecycleMessage,
        onDisconnect: disconnected.resolve,
      })
      const error = await withTestTimeout(disconnected.promise, 1_000, `${label} was not rejected`)
      expect(error.code, label).toBe("protocol_error")
      expect(error.message, label).toContain(diagnostic)
      expect(supervisor.state, label).toBe("degraded")
      await supervisor.close()
      supervisors.delete(supervisor)
    }
  })

  test("bounds and cancels a stuck lifecycle handler without writing a synthetic response", async () => {
    const request = (await frozenLifecycleMessages()).find((message) => message.message_type === "ensure_request")!
    const disconnected = deferred<RuntimeExtensionError>()
    const handlerStarted = deferred<AbortSignal>()
    const supervisor = await startSupervisor(PEER, "ready", {
      env: { FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([request]) },
      requestTimeoutMs: 30,
      onLifecycleMessage: (_message, signal) => {
        handlerStarted.resolve(signal)
        return new Promise<void>(() => {})
      },
      onDisconnect: disconnected.resolve,
    })
    const signal = await withTestTimeout(handlerStarted.promise, 1_000, "lifecycle handler did not start")
    const error = await withTestTimeout(disconnected.promise, 1_000, "lifecycle handler did not time out")
    expect(error.code).toBe("request_timeout")
    expect(signal.aborted).toBe(true)
    expect(supervisor.state).toBe("degraded")
  })

  test("shares the bounded serialized writer with asynchronous lifecycle receipts", async () => {
    const receipts = (await frozenLifecycleMessages()).filter(
      (message): message is RuntimeExtensionLifecycleReceipt =>
        message.message_type === "ensure_receipt" || message.message_type === "end_receipt",
    ).slice(0, 2)
    const disconnected = deferred<RuntimeExtensionError>()
    const supervisor = await startSupervisor(PEER, "ready", {
      maxQueuedWrites: 1,
      onDisconnect: disconnected.resolve,
    })
    const outcomes = await Promise.allSettled(
      receipts.map((receipt) => supervisor.publishLifecycleReceipt(receipt)),
    )
    expect(outcomes.some((outcome) =>
      outcome.status === "rejected" && outcome.reason instanceof RuntimeExtensionError &&
      outcome.reason.code === "request_limit"
    )).toBe(true)
    expect((await withTestTimeout(disconnected.promise, 1_000, "receipt saturation did not degrade")).code)
      .toBe("request_limit")
    expect(supervisor.state).toBe("degraded")
  })

  test("refuses host-to-child lifecycle requests, acknowledgements, and foreign receipts locally", async () => {
    const messages = await frozenLifecycleMessages()
    const request = messages.find((message) => message.message_type === "ensure_request")!
    const acknowledgement = messages.find((message) => message.message_type === "receipt_acknowledgement")!
    const receipt = messages.find((message) => message.message_type === "ensure_receipt")!
    const supervisor = await startSupervisor(PEER, "ready")

    for (const [label, message] of [
      ["request", request],
      ["acknowledgement", acknowledgement],
      ["foreign receipt", { ...receipt, fmx_session: "session-alpha" }],
    ] as const) {
      const error = await expectRuntimeError(supervisor.publishLifecycleReceipt(
        message as RuntimeExtensionLifecycleReceipt,
      ))
      expect(error.code, label).toBe("protocol_error")
    }
    expect(supervisor.state).toBe("ready")
  })
})

describe("Runtime-extension managed-launch transport", () => {
  test("admits requests inward, publishes retained outcomes outward, and receives exact acknowledgements", async () => {
    const directory = await temporaryDirectory()
    const log = join(directory, "managed-launch.log")
    const request = managedLaunchRequest()
    const outcome = managedLaunchFailure(request)
    const retry = managedLaunchRetry(outcome)
    const observed: string[] = []
    const admitted = deferred<void>()
    const complete = deferred<void>()
    const supervisor = await startSupervisor(PEER, "ready", {
      env: {
        FMX_SUPERVISOR_CHILD_LOG: log,
        FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([request, retry]),
        FMX_SUPERVISOR_CHILD_ACK_MANAGED: "1",
      },
      onManagedLaunchMessage: (message) => {
        observed.push(message.message_type)
        if (observed.length === 2) admitted.resolve()
        if (observed.length === 3) complete.resolve()
      },
    })
    await withTestTimeout(admitted.promise, 1_000, "managed request was not admitted")
    await supervisor.publishManagedLaunchOutcome(outcome)
    await withTestTimeout(complete.promise, 1_000, "managed acknowledgement was not admitted")
    expect(observed).toEqual([
      "launch_request",
      "retry_request",
      "outcome_acknowledgement",
    ])
    const received = await waitForMessages(
      log,
      (messages) => messages.some((message) => message.message_type === "launch_outcome"),
    )
    expect(received.find((message) => message.message_type === "launch_outcome")).toEqual(outcome)
    expect(supervisor.state).toBe("ready")
  })

  test("publishes an exact managed terminal receipt to the extension without degrading the link", async () => {
    const directory = await temporaryDirectory()
    const log = join(directory, "managed-terminal.log")
    const receipt = managedTerminalReceipt(managedLaunchRequest())
    const supervisor = await startSupervisor(PEER, "ready", {
      env: { FMX_SUPERVISOR_CHILD_LOG: log },
    })

    await supervisor.publishManagedLaunchTerminalReceipt(receipt)

    const received = await waitForMessages(
      log,
      (messages) => messages.some((message) => message.message_type === "terminal_receipt"),
    )
    expect(received.find((message) => message.message_type === "terminal_receipt")).toEqual(receipt)
    expect(supervisor.state).toBe("ready")
  })

  test("coalesces an exact managed-launch replay while its first admission is in flight", async () => {
    const request = managedLaunchRequest()
    const release = deferred<void>()
    const started = deferred<void>()
    const diagnostics: RuntimeExtensionError[] = []
    let calls = 0
    const supervisor = await startSupervisor(PEER, "ready", {
      env: {
        FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([
          request,
          structuredClone(request),
        ]),
      },
      onManagedLaunchMessage: async () => {
        calls++
        started.resolve()
        await release.promise
      },
      onDisconnect: (error) => {
        diagnostics.push(error)
      },
    })

    await withTestTimeout(started.promise, 1_000, "managed request was not admitted")
    await Bun.sleep(25)
    expect(supervisor.state).toBe("ready")
    expect(calls).toBe(1)
    expect(diagnostics).toEqual([])
    release.resolve()
  })

  test("rejects changed managed-launch content that reuses an in-flight request id", async () => {
    const request = managedLaunchRequest()
    const retry = {
      ...managedLaunchRetry(managedLaunchFailure(request)),
      request_id: request.request_id,
    }
    const disconnected = deferred<RuntimeExtensionError>()
    await startSupervisor(PEER, "ready", {
      env: {
        FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([request, retry]),
      },
      onManagedLaunchMessage: (_message, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        ),
      onDisconnect: disconnected.resolve,
    })

    const error = await withTestTimeout(
      disconnected.promise,
      1_000,
      "changed managed replay was not rejected",
    )
    expect(error.code).toBe("protocol_error")
    expect(error.message).toContain(`reused Runtime-extension request id ${request.request_id}`)
  })

  test("rejects managed outcomes in the child-to-host direction", async () => {
    const outcome = managedLaunchFailure(managedLaunchRequest())
    const disconnected = deferred<RuntimeExtensionError>()
    await startSupervisor(PEER, "ready", {
      env: { FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([outcome]) },
      onManagedLaunchMessage: () => {},
      onDisconnect: disconnected.resolve,
    })
    const error = await withTestTimeout(
      disconnected.promise,
      1_000,
      "reverse managed outcome was not rejected",
    )
    expect(error.code).toBe("protocol_error")
    expect(error.message).toContain("extension-to-Runtime direction")
  })

  test("rejects managed terminal receipts in the child-to-host direction", async () => {
    const receipt = managedTerminalReceipt(managedLaunchRequest())
    const disconnected = deferred<RuntimeExtensionError>()
    await startSupervisor(PEER, "ready", {
      env: { FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([receipt]) },
      onManagedLaunchMessage: () => {},
      onDisconnect: disconnected.resolve,
    })
    const error = await withTestTimeout(
      disconnected.promise,
      1_000,
      "reverse managed terminal receipt was not rejected",
    )
    expect(error.code).toBe("protocol_error")
    expect(error.message).toContain("extension-to-Runtime direction")
  })
})

describe("Runtime-extension private inline-source transport", () => {
  test("admits the one fully verified private request child-to-host without a synthetic response", async () => {
    const directory = await temporaryDirectory()
    const log = join(directory, "inline-source.log")
    const request = inlineSourceRequest()
    const handled = deferred<InlineLaunchSourceRequest>()
    const supervisor = await startSupervisor(PEER, "ready", {
      env: {
        FMX_SUPERVISOR_CHILD_LOG: log,
        FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([request]),
      },
      onInlineLaunchSourceRequest: (source) => handled.resolve(source),
    })
    expect(await withTestTimeout(handled.promise, 1_000, "inline source was not admitted")).toEqual(request)
    const received = await waitForMessages(log, (messages) =>
      messages.some((message) => message.message_type === "initialize"),
    )
    expect(received.filter((message) => message.message_type === "response")).toEqual([])
    expect(supervisor.state).toBe("ready")
  })

  test("requires the narrow handler and exact Workplace/Session link identity", async () => {
    const request = inlineSourceRequest()
    for (const [label, scripted, handler, diagnostic] of [
      ["missing handler", request, undefined, "without an installed inline-source handler"],
      [
        "foreign Workplace",
        inlineSourceRequest({ workplace_instance_id: "foreign-workplace" }),
        () => {},
        "names Workplace foreign-workplace",
      ],
      [
        "foreign Session",
        inlineSourceRequest({ fmx_session: "session-alpha" }),
        () => {},
        "names fmx Session session-alpha",
      ],
    ] as const) {
      const disconnected = deferred<RuntimeExtensionError>()
      const supervisor = await startSupervisor(PEER, "ready", {
        env: { FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([scripted]) },
        onInlineLaunchSourceRequest: handler,
        onDisconnect: disconnected.resolve,
      })
      const error = await withTestTimeout(disconnected.promise, 1_000, `${label} was not rejected`)
      expect(error.code, label).toBe("protocol_error")
      expect(error.message, label).toContain(diagnostic)
      expect(error.message, label).not.toContain(scripted.initial_work.data)
      await supervisor.close()
      supervisors.delete(supervisor)
    }
  })

  test("bounds and aborts a stuck private source handler", async () => {
    const request = inlineSourceRequest()
    const started = deferred<AbortSignal>()
    const disconnected = deferred<RuntimeExtensionError>()
    const supervisor = await startSupervisor(PEER, "ready", {
      env: { FMX_SUPERVISOR_CHILD_SCRIPT: JSON.stringify([request]) },
      requestTimeoutMs: 30,
      onInlineLaunchSourceRequest: (_source, signal) => {
        started.resolve(signal)
        return new Promise<void>(() => {})
      },
      onDisconnect: disconnected.resolve,
    })
    const signal = await withTestTimeout(started.promise, 1_000, "inline source handler did not start")
    const error = await withTestTimeout(disconnected.promise, 1_000, "inline source handler did not time out")
    expect(error.code).toBe("request_timeout")
    expect(signal.aborted).toBe(true)
    expect(supervisor.state).toBe("degraded")
  })
})

describe("Runtime-extension correlated requests and bounds", () => {
  test("serializes concurrent writes and correlates every exact response", async () => {
    const directory = await temporaryDirectory()
    const log = join(directory, "peer.log")
    const supervisor = await startSupervisor(PEER, "reply", {
      env: { FMX_SUPERVISOR_CHILD_LOG: log },
      maxPendingRequests: 32,
    })
    const requests = Array.from({ length: 16 }, (_, index) => supervisor.requestUnavailableSlotAction({
      slotId: `slot-${index}`,
      cardRevision: String(index + 1),
      actionId: `action-${index}`,
    }))
    const responses = await Promise.all(requests)
    expect(responses).toHaveLength(16)
    expect(responses.every((response) => response.ok)).toBe(true)
    const received = await waitForMessages(
      log,
      (messages) => messages.filter((message) => message.message_type === "unavailable_slot_action").length === 16,
    )
    const actions = received.filter((message) => message.message_type === "unavailable_slot_action")
    expect(new Set(actions.map((message) => message.request_id)).size).toBe(16)
    expect(actions.map((message) => message.slot_id)).toEqual(Array.from({ length: 16 }, (_, index) => `slot-${index}`))
  })

  test("returns an authoritative action refusal without degrading the link", async () => {
    const supervisor = await startSupervisor(PEER, "refuse_action")
    const response = await supervisor.requestUnavailableSlotAction({
      slotId: "slot-a",
      cardRevision: "2",
      actionId: "retry-a",
    })
    expect(response).toMatchObject({
      ok: false,
      operation: "unavailable_slot_action",
      error: { code: "stale_card" },
    })
    expect(supervisor.state).toBe("ready")
  })

  for (const [name, mode] of [
    ["rejects a mismatched response id", "wrong_response_id"],
    ["rejects a mismatched response operation", "wrong_response_operation"],
  ] as const) {
    test(name, async () => {
      const disconnected = deferred<RuntimeExtensionError>()
      const supervisor = await startSupervisor(PEER, mode, { onDisconnect: disconnected.resolve })
      const request = supervisor.requestUnavailableSlotAction({
        slotId: "slot-a",
        cardRevision: "3",
        actionId: "retry-a",
      })
      const error = await expectRuntimeError(request)
      expect(error.code).toBe("protocol_error")
      expect(await withTestTimeout(disconnected.promise, 1_000, "response mismatch did not degrade")).toBe(error)
      expect(supervisor.state).toBe("degraded")
    })
  }

  test("bounds an unanswered outbound request and reaps the degraded child", async () => {
    const disconnected = deferred<RuntimeExtensionError>()
    const supervisor = await startSupervisor(PEER, "ready", {
      requestTimeoutMs: 30,
      onDisconnect: disconnected.resolve,
    })
    const pid = supervisor.processId!
    const error = await expectRuntimeError(supervisor.requestUnavailableSlotAction({
      slotId: "slot-a",
      cardRevision: "4",
      actionId: "retry-a",
    }))
    expect(error.code).toBe("request_timeout")
    expect(await withTestTimeout(disconnected.promise, 1_000, "request timeout did not degrade")).toBe(error)
    expect(supervisor.state).toBe("degraded")
    expectProcessReaped(pid)
  })

  test("refuses excess pending requests without admitting an unbounded map", async () => {
    const supervisor = await startSupervisor(FIXTURE, "ready", {
      maxPendingRequests: 1,
      requestTimeoutMs: 1_000,
    })
    const first = supervisor.requestUnavailableSlotAction({
      slotId: "slot-a",
      cardRevision: "5",
      actionId: "retry-a",
    })
    const second = supervisor.requestUnavailableSlotAction({
      slotId: "slot-b",
      cardRevision: "5",
      actionId: "retry-b",
    })
    expect((await expectRuntimeError(second)).code).toBe("request_limit")
    expect(supervisor.state).toBe("ready")
    await supervisor.close()
    expect((await expectRuntimeError(first)).code).toBe("closed")
  })

  test("turns a saturated serialized write queue into one bounded degradation", async () => {
    const disconnected = deferred<RuntimeExtensionError>()
    const supervisor = await startSupervisor(PEER, "reply", {
      maxQueuedWrites: 1,
      onDisconnect: disconnected.resolve,
    })
    const first = supervisor.requestUnavailableSlotAction({
      slotId: "slot-a",
      cardRevision: "6",
      actionId: "retry-a",
    })
    const second = supervisor.requestUnavailableSlotAction({
      slotId: "slot-b",
      cardRevision: "6",
      actionId: "retry-b",
    })
    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes.some((outcome) =>
      outcome.status === "rejected" && outcome.reason instanceof RuntimeExtensionError &&
      outcome.reason.code === "request_limit"
    )).toBe(true)
    expect((await withTestTimeout(disconnected.promise, 1_000, "write saturation did not degrade")).code)
      .toBe("request_limit")
    expect(supervisor.state).toBe("degraded")
  })

  test("degrades when a Runtime request handler rejects", async () => {
    const disconnected = deferred<RuntimeExtensionError>()
    const script = JSON.stringify([snapshotGet("handler-reject")])
    const supervisor = await startSupervisor(FIXTURE, "ready", {
      env: { FMX_FIXTURE_EXTENSION_SCRIPT: script },
      onRequest: () => {
        throw new Error("snapshot construction failed")
      },
      onDisconnect: disconnected.resolve,
    })
    const error = await withTestTimeout(disconnected.promise, 1_000, "handler rejection did not degrade")
    expect(error.code).toBe("handler_failed")
    expect(error.message).toContain("snapshot construction failed")
    expect(supervisor.state).toBe("degraded")
  })

  test("bounds a stuck Runtime handler and aborts its work", async () => {
    const disconnected = deferred<RuntimeExtensionError>()
    const handlerStarted = deferred<AbortSignal>()
    const script = JSON.stringify([snapshotGet("handler-timeout")])
    const supervisor = await startSupervisor(FIXTURE, "ready", {
      env: { FMX_FIXTURE_EXTENSION_SCRIPT: script },
      requestTimeoutMs: 30,
      onRequest: (_request, signal) => {
        handlerStarted.resolve(signal)
        return new Promise<RuntimeExtensionInboundOutcome>(() => {})
      },
      onDisconnect: disconnected.resolve,
    })
    const signal = await withTestTimeout(handlerStarted.promise, 1_000, "handler did not start")
    const error = await withTestTimeout(disconnected.promise, 1_000, "handler timeout did not degrade")
    expect(error.code).toBe("request_timeout")
    expect(signal.aborted).toBe(true)
    expect(supervisor.state).toBe("degraded")
  })

  test("bounds response backpressure inside the inbound request deadline and reaps the child", async () => {
    const disconnected = deferred<RuntimeExtensionError>()
    const handlerStarted = deferred<void>()
    const signals: AbortSignal[] = []
    const supervisor = await startSupervisor(PEER, "block_response_write", {
      requestTimeoutMs: 100,
      onRequest: (request, signal) => {
        if (request.message_type !== "snapshot_get") throw new Error("expected a snapshot pull")
        signals.push(signal)
        handlerStarted.resolve()
        return snapshotResult(request, "1", "x".repeat(1_020 * 1024))
      },
      onDisconnect: disconnected.resolve,
    })
    const pid = supervisor.processId!
    await withTestTimeout(handlerStarted.promise, 1_000, "backpressured handler did not start")
    const error = await withTestTimeout(disconnected.promise, 2_000, "response backpressure did not time out")
    expect(error.code).toBe("request_timeout")
    expect(error.message).toContain("blocked-response")
    expect(signals.some((signal) => signal.aborted)).toBe(true)
    expect(supervisor.state).toBe("degraded")
    expectProcessReaped(pid)
  }, 3_000)

  test("retains request ids only while sequential correlation is live", async () => {
    const directory = await temporaryDirectory()
    const log = join(directory, "sequential.log")
    const handledAll = deferred<void>()
    const target = 128
    let handled = 0
    const supervisor = await startSupervisor(PEER, "sequential_requests", {
      env: {
        FMX_SUPERVISOR_CHILD_LOG: log,
        FMX_SUPERVISOR_CHILD_SEQUENTIAL_COUNT: String(target),
      },
      maxPendingRequests: 1,
      maxQueuedWrites: 1,
      requestTimeoutMs: 1_000,
      onRequest: (request) => {
        expect(request.message_type).toBe("present")
        handled++
        if (handled === target) handledAll.resolve()
        return successfulOutcome(request)
      },
    })
    await withTestTimeout(handledAll.promise, 2_000, "sequential requests did not complete")
    const received = await waitForMessages(
      log,
      (messages) => messages.filter((message) => message.message_type === "response").length === target,
      2_000,
    )
    const responses = received.filter((message) => message.message_type === "response")
    expect(responses).toHaveLength(target)
    expect(new Set(responses.map((response) => response.request_id))).toEqual(new Set(["sequential-request"]))
    expect(supervisor.state).toBe("ready")
  }, 3_000)

  test("bounds concurrent child requests and aborts the admitted handler", async () => {
    const disconnected = deferred<RuntimeExtensionError>()
    const handlerStarted = deferred<AbortSignal>()
    const supervisor = await startSupervisor(PEER, "too_many_requests", {
      maxPendingRequests: 1,
      onRequest: (_request, signal) => {
        handlerStarted.resolve(signal)
        return new Promise<RuntimeExtensionInboundOutcome>(() => {})
      },
      onDisconnect: disconnected.resolve,
    })
    const signal = await withTestTimeout(handlerStarted.promise, 1_000, "bounded handler did not start")
    const error = await withTestTimeout(disconnected.promise, 1_000, "child request bound did not degrade")
    expect(error.code).toBe("request_limit")
    expect(signal.aborted).toBe(true)
    expect(supervisor.state).toBe("degraded")
  })
})

describe("Runtime-extension level invalidation, restart, and reap", () => {
  test("returns the authoritative current snapshot when after_revision is already equal", async () => {
    const directory = await temporaryDirectory()
    const log = join(directory, "equal-revision.log")
    const requestStarted = deferred<void>()
    const releaseSnapshot = deferred<void>()
    const supervisor = await startSupervisor(FIXTURE, "ready", {
      env: {
        FMX_FIXTURE_EXTENSION_LOG: log,
        FMX_FIXTURE_EXTENSION_SCRIPT: JSON.stringify([snapshotGet("equal-revision", "7")]),
      },
      onRequest: async (request) => {
        if (request.message_type !== "snapshot_get") throw new Error("expected a snapshot pull")
        requestStarted.resolve()
        await releaseSnapshot.promise
        return snapshotResult(request, "7")
      },
    })
    await withTestTimeout(requestStarted.promise, 1_000, "equal-revision snapshot did not start")
    await supervisor.invalidateSnapshot("7")
    releaseSnapshot.resolve()
    const received = await waitForMessages(
      log,
      (messages) => messages.some((message) => message.message_type === "snapshot_result"),
    )
    expect(received.filter((message) => message.message_type === "snapshot_result").map((message) => message.revision))
      .toEqual(["7"])
    expect(received.filter((message) => message.message_type === "snapshot_invalidated").map((message) => message.revision))
      .toEqual(["7"])
    expect(supervisor.state).toBe("ready")
  })

  test("coalesces one pending level and reasserts once after a stale racing snapshot", async () => {
    const directory = await temporaryDirectory()
    const log = join(directory, "coalescing.log")
    const release = join(directory, "release")
    const initialStarted = deferred<void>()
    const raceStarted = deferred<void>()
    const releaseRace = deferred<void>()
    const supervisor = await startSupervisor(PEER, "coalescing_probe", {
      env: {
        FMX_SUPERVISOR_CHILD_LOG: log,
        FMX_SUPERVISOR_CHILD_RELEASE: release,
      },
      onRequest: async (request) => {
        if (request.message_type !== "snapshot_get") throw new Error("expected a snapshot pull")
        if (request.request_id === "coalescing-initial") {
          initialStarted.resolve()
          return snapshotResult(request, "1", "x".repeat(256 * 1024))
        }
        expect(request.request_id).toBe("coalescing-race")
        raceStarted.resolve()
        await releaseRace.promise
        return snapshotResult(request, "5")
      },
      requestTimeoutMs: 1_000,
    })

    await withTestTimeout(initialStarted.promise, 1_000, "initial snapshot did not start")
    const firstBurst = ["2", "3", "4", "5"].map((revision) => supervisor.invalidateSnapshot(revision))
    await writeFile(release, "release\n", { mode: 0o600 })
    await Promise.all(firstBurst)
    await withTestTimeout(raceStarted.promise, 1_000, "coalesced invalidation did not trigger a pull")

    await Promise.all(["6", "7", "8"].map((revision) => supervisor.invalidateSnapshot(revision)))
    releaseRace.resolve()
    const received = await waitForMessages(
      log,
      (messages) => messages.filter((message) => message.message_type === "snapshot_invalidated").length >= 2,
      2_000,
    )
    expect(received.filter((message) => message.message_type === "snapshot_invalidated").map((message) => message.revision))
      .toEqual(["5", "8"])
    expect(received.filter((message) => message.message_type === "snapshot_result").map((message) => message.revision))
      .toEqual(["1", "5"])
    expect(supervisor.state).toBe("ready")
  }, 5_000)

  test("degrades after later child exit and restarts through fresh pipes and readiness", async () => {
    const directory = await temporaryDirectory()
    const marker = join(directory, "generation.marker")
    const firstDisconnect = deferred<RuntimeExtensionError>()
    const supervisor = await startSupervisor(PEER, "exit_once_then_ready", {
      env: { FMX_SUPERVISOR_CHILD_MARKER: marker },
      onDisconnect: firstDisconnect.resolve,
    })
    const firstPid = supervisor.processId!
    const failure = await withTestTimeout(firstDisconnect.promise, 1_000, "later exit did not degrade")
    expect(failure.exitCode).toBe(23)
    expect(supervisor.state).toBe("degraded")
    expectProcessReaped(firstPid)

    const ready = await supervisor.restart()
    expect(ready.fmx_session).toBe("session-beta")
    expect(supervisor.state).toBe("ready")
    expect(supervisor.generation).toBe(2)
    expect(supervisor.processId).not.toBe(firstPid)
    expect(await supervisor.requestUnavailableSlotAction({
      slotId: "slot-a",
      cardRevision: "9",
      actionId: "retry-a",
    })).toMatchObject({ ok: true, operation: "unavailable_slot_action" })
  })

  test("keeps a failed explicit restart degraded and reports its fresh readiness refusal", async () => {
    const directory = await temporaryDirectory()
    const marker = join(directory, "generation.marker")
    const disconnects = eventQueue<RuntimeExtensionError>()
    const supervisor = await startSupervisor(PEER, "exit_once_then_refuse", {
      env: { FMX_SUPERVISOR_CHILD_MARKER: marker },
      onDisconnect: disconnects.push,
    })
    expect((await withTestTimeout(disconnects.next(), 1_000, "first generation did not exit")).exitCode).toBe(23)
    const error = await expectRuntimeError(supervisor.restart())
    expect(error.code).toBe("readiness_refused")
    expect(error.message).toContain("restart_refused")
    expect((await withTestTimeout(disconnects.next(), 1_000, "restart refusal was not reported"))).toBe(error)
    expect(supervisor.state).toBe("degraded")
    expect(supervisor.generation).toBe(2)
    expect(supervisor.processId).toBeNull()
  })

  test("keeps a restart spawn failure degraded and reports the unlaunchable fresh generation", async () => {
    const directory = await temporaryDirectory()
    const marker = join(directory, "generation.marker")
    const executable = join(directory, "runtime-extension-wrapper")
    await writeFile(executable, '#!/bin/sh\nexec "$FMX_TEST_BUN" "$FMX_TEST_PEER"\n', { mode: 0o700 })
    const startup = startupFor(PEER)
    startup.registration.argv = [executable]
    const disconnects = eventQueue<RuntimeExtensionError>()
    const supervisor = await RuntimeExtensionSupervisor.start(startup, options("exit_once_then_ready", {
      env: {
        FMX_SUPERVISOR_CHILD_MARKER: marker,
        FMX_TEST_BUN: process.execPath,
        FMX_TEST_PEER: PEER,
      },
      onDisconnect: disconnects.push,
    }))
    supervisors.add(supervisor)

    expect((await withTestTimeout(disconnects.next(), 1_000, "first generation did not exit")).exitCode).toBe(23)
    await rm(executable)
    const error = await expectRuntimeError(supervisor.restart())
    expect(error.code).toBe("spawn_failed")
    expect(error.generation).toBe(2)
    expect((await withTestTimeout(disconnects.next(), 1_000, "restart spawn failure was not reported"))).toBe(error)
    expect(supervisor.state).toBe("degraded")
    expect(supervisor.processId).toBeNull()
  })

  test("closes idempotently and reaps a cooperative child", async () => {
    const supervisor = await startSupervisor(FIXTURE, "ready")
    const pid = supervisor.processId!
    const first = supervisor.close()
    const second = supervisor.close()
    expect(second).toBe(first)
    await first
    expect(supervisor.state).toBe("closed")
    expect(supervisor.processId).toBeNull()
    expectProcessReaped(pid)
  })

  test("escalates bounded shutdown and reaps a child which ignores EOF and TERM", async () => {
    const supervisor = await startSupervisor(PEER, "ignore_close", {
      shutdownGraceMs: 20,
      terminateGraceMs: 20,
    })
    const pid = supervisor.processId!
    await withTestTimeout(supervisor.close(), 1_000, "stubborn child was not reaped")
    expect(supervisor.state).toBe("closed")
    expectProcessReaped(pid)
  })
})

function startupFor(script: string): RuntimeExtensionStartup {
  return {
    association: {
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "association",
      workplace_instance_id: "fixture-workplace",
      extension_id: "fixture-extension",
      configuration_id: "fixture-configuration",
      members: [
        { placement_id: "placement-alpha", fmx_session: "session-alpha" },
        { placement_id: "placement-beta", fmx_session: "session-beta" },
      ],
    },
    registration: {
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "registration",
      extension_id: "fixture-extension",
      argv: [process.execPath, script],
      protocol: { minimum: 1, maximum: 1 },
      required_capabilities: [...RUNTIME_EXTENSION_CAPABILITIES],
    },
    placementId: "placement-beta",
  }
}

function options(
  mode: string,
  overrides: Partial<RuntimeExtensionSupervisorOptions> = {},
): RuntimeExtensionSupervisorOptions {
  let requestSequence = 0
  const { env, ...rest } = overrides
  return {
    onRequest: successfulOutcome,
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 40,
    terminateGraceMs: 40,
    requestId: () => `host-request-${++requestSequence}`,
    ...rest,
    env: {
      ...process.env,
      FMX_FIXTURE_EXTENSION_MODE: mode,
      FMX_SUPERVISOR_CHILD_MODE: mode,
      ...env,
    },
  }
}

async function startSupervisor(
  script: string,
  mode: string,
  overrides: Partial<RuntimeExtensionSupervisorOptions> = {},
): Promise<RuntimeExtensionSupervisor> {
  const supervisor = await RuntimeExtensionSupervisor.start(startupFor(script), options(mode, overrides))
  supervisors.add(supervisor)
  return supervisor
}

function successfulOutcome(request: RuntimeExtensionInboundRequest): RuntimeExtensionInboundOutcome {
  if (request.message_type === "snapshot_get") return snapshotResult(request, nextRevision(request.after_revision))
  return {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "response",
    request_id: request.request_id,
    operation: request.message_type,
    ok: true,
    status: "accepted",
  } as RuntimeExtensionInboundOutcome
}

function snapshotResult(
  request: Extract<RuntimeExtensionInboundRequest, { message_type: "snapshot_get" }>,
  revision: string,
  padding?: string,
): RuntimeExtensionInboundOutcome {
  const agentId = "11111111111111111111111111111111"
  return {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "snapshot_result",
    request_id: request.request_id,
    fmx_session: request.fmx_session,
    revision,
    selected_agent_id: padding === undefined ? null : agentId,
    agents: padding === undefined
      ? []
      : [{
          agent_id: agentId,
          pane_id: `p_${agentId}`,
          display_id: 1,
          created_at_ms: 1,
          lifecycle: "running",
          state: "idle",
          attention: null,
          directory: "/tmp/fmx-runtime-extension-coalescing",
          worktree: false,
          fx_conversation: null,
          correlation: null,
          extensions: { padding },
        }],
  } as RuntimeExtensionInboundOutcome
}

function snapshotGet(requestId: string, afterRevision: string | null = null) {
  return {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "snapshot_get",
    request_id: requestId,
    fmx_session: "session-beta",
    after_revision: afterRevision,
  }
}

function nextRevision(after: string | null): string {
  return after === null ? "0" : String(BigInt(after) + 1n)
}

function inlineSourceRequest(
  overrides: Partial<InlineLaunchSourceRequest> = {},
): InlineLaunchSourceRequest {
  const initialWork = encodeInlineSourceBytes(Buffer.from("private transport initial work\n", "utf8"))
  const launchControls = encodeInlineSourceBytes(encodeCanonicalJson({ remaining_global_args: [] }))
  const launch = {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "launch_request",
    request_id: "transport-fx-launch-request",
    launch_id: "transport-launch",
    launch_digest: "0".repeat(64),
    admission_key: "transport-admission",
    conversation_name: "Transport fixture",
    resume: { mode: "fresh" },
    state_root: "/var/tmp/fmx-transport-state",
    directory: "/var/tmp/fmx-transport-worktree",
    initial_work_digest: initialWork.sha256,
    remaining_launch_controls_digest: launchControls.sha256,
  } satisfies FrozenLaunchRequest
  launch.launch_digest = deriveFrozenLaunchDigest(launch)
  const request = {
    schema_id: INLINE_LAUNCH_SOURCE_SCHEMA_ID,
    schema_version: INLINE_LAUNCH_SOURCE_SCHEMA_VERSION,
    message_type: "source_request",
    request_id: "transport-source-request",
    workplace_instance_id: "fixture-workplace",
    fmx_session: "session-beta",
    ensure_id: "transport-ensure",
    ensure_digest: "e".repeat(64),
    worktree_id: "transport-worktree",
    agent_id: "1234567890abcdef1234567890abcdef",
    launch_id: launch.launch_id,
    launch_digest: launch.launch_digest,
    admission_key: launch.admission_key,
    source_id: "transport-source",
    source_digest: "0".repeat(64),
    launch_request: launch,
    initial_work: initialWork,
    launch_controls: launchControls,
    ...overrides,
  } satisfies InlineLaunchSourceRequest
  request.source_digest = deriveInlineLaunchSourceDigest(request)
  return request
}

function managedLaunchRequest(): ManagedLaunchRequest {
  const inline = inlineSourceRequest()
  const launch = structuredClone(inline.launch_request)
  launch.directory = "/var/tmp/fmx-managed-transport"
  launch.launch_digest = deriveFrozenLaunchDigest(launch)
  const request = {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "launch_request",
    request_id: "transport-managed-request",
    workplace_instance_id: "fixture-workplace",
    fmx_session: "session-beta",
    ensure_id: "transport-managed-ensure",
    ensure_digest: "0".repeat(64),
    launch_id: launch.launch_id,
    launch_digest: launch.launch_digest,
    agent_id: inline.agent_id,
    workspace: {
      kind: "existing_directory",
      directory: launch.directory,
      repository: "/var/tmp/fmx-managed-repository",
      checkout_root: launch.directory,
      head_commit: "b".repeat(40),
    },
    fx_conversation: {
      name: launch.conversation_name,
      resume_conversation_id: null,
    },
    source: {
      source_id: "transport-managed-source",
      source_digest: "0".repeat(64),
      admission_key: launch.admission_key,
      launch_request: launch,
      initial_work: inline.initial_work,
      launch_controls: inline.launch_controls,
    },
  } as ManagedLaunchRequest
  request.source.source_digest = deriveManagedLaunchSourceDigest(request)
  request.ensure_digest = deriveManagedLaunchEnsureDigest(request)
  return request
}

function managedLaunchFailure(request: ManagedLaunchRequest): ManagedLaunchOutcome {
  const outcome: ManagedLaunchOutcome = {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "launch_outcome",
    request_id: request.request_id,
    receipt_id: "transport-managed-outcome",
    receipt_digest: "0".repeat(64),
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    ensure_digest: request.ensure_digest,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    agent_id: request.agent_id,
    attempt: 1,
    status: "failed",
    classification: "retryable",
    stage: "existing_directory",
    cause: "git_identity_changed",
    process_certainty: "not_started",
    exact_resume_proof: null,
    success: null,
    retained_until_acknowledged: true,
  }
  outcome.receipt_digest = deriveManagedLaunchOutcomeDigest(outcome)
  return outcome
}

function managedTerminalReceipt(request: ManagedLaunchRequest): ManagedLaunchTerminalReceipt {
  const finalWithoutDigest = {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "final_receipt",
    receipt_id: `fx-final-${request.ensure_id}`,
    receipt_digest: "0".repeat(64),
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    admission_key: request.source.admission_key,
    conversation_id: "transport-managed-conversation",
    outcome: { kind: "exited", code: 0 },
    observed_at: "2026-09-02T12:00:00.000Z",
    retained_until_acknowledged: true,
  } as FxFinalReceipt
  const finalReceipt = {
    ...finalWithoutDigest,
    receipt_digest: deriveFxFinalReceiptDigest(finalWithoutDigest),
  }
  const receipt = {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "terminal_receipt",
    receipt_id: "pending-terminal-receipt",
    receipt_digest: "0".repeat(64),
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    ensure_digest: request.ensure_digest,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    agent_id: request.agent_id,
    attempt: 1,
    fx_final_receipt: finalReceipt,
    retained_until_acknowledged: true,
  } as ManagedLaunchTerminalReceipt
  receipt.receipt_id = deriveManagedLaunchTerminalReceiptId(receipt)
  receipt.receipt_digest = deriveManagedLaunchTerminalReceiptDigest(receipt)
  return receipt
}

function managedLaunchRetry(outcome: ManagedLaunchOutcome): ManagedLaunchRetry {
  return {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "retry_request",
    request_id: "transport-managed-retry",
    workplace_instance_id: outcome.workplace_instance_id,
    fmx_session: outcome.fmx_session,
    ensure_id: outcome.ensure_id,
    ensure_digest: outcome.ensure_digest,
    launch_id: outcome.launch_id,
    launch_digest: outcome.launch_digest,
    agent_id: outcome.agent_id,
    prior_attempt: outcome.attempt,
    prior_receipt_id: outcome.receipt_id,
    prior_receipt_digest: outcome.receipt_digest,
    next_attempt: outcome.attempt + 1,
  }
}

async function frozenLifecycleMessages(): Promise<EnsureLifecycleMessage[]> {
  return (await readFile(LIFECYCLE_FIXTURE, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => ensureLifecycleMessageSchema.parse(JSON.parse(line)) as EnsureLifecycleMessage)
}

async function expectRuntimeError(promise: Promise<unknown>): Promise<RuntimeExtensionError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeExtensionError)
    return error as RuntimeExtensionError
  }
  throw new Error("expected a RuntimeExtensionError")
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fmx-runtime-extension-supervisor-"))
  temporaryDirectories.add(directory)
  return directory
}

async function waitForMessages(
  path: string,
  accepted: (messages: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 1_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const text = await readFile(path, "utf8")
      const messages = text.trimEnd().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      if (accepted(messages)) return messages
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for Runtime-extension messages in ${path}`)
    await Bun.sleep(5)
  }
}

async function withTestTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function expectProcessReaped(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow()
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

function eventQueue<T>() {
  const values: T[] = []
  const waiters: Array<Deferred<T>> = []
  return {
    push(value: T): void {
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(value)
      else values.push(value)
    },
    next(): Promise<T> {
      const value = values.shift()
      if (value !== undefined) return Promise.resolve(value)
      const waiter = deferred<T>()
      waiters.push(waiter)
      return waiter.promise
    },
  }
}
