import { randomUUID } from "node:crypto"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_CAPABILITIES,
  RUNTIME_EXTENSION_SCHEMA_ID,
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
  runtimeExtensionMessageSchema,
  type RuntimeExtensionMessage,
} from "./agentworkplace-contracts.ts"
import { CONTRACT_MAX_FRAME_BYTES, ContractFrameDecoder } from "./contract-codec.ts"
import type {
  RuntimeAssociationMessage,
  RuntimeExtensionStartup,
  RuntimeRegistrationMessage,
} from "./runtime-startup.ts"

export const RUNTIME_EXTENSION_STARTUP_TIMEOUT_MS = 5_000
export const RUNTIME_EXTENSION_REQUEST_TIMEOUT_MS = 5_000
export const RUNTIME_EXTENSION_SHUTDOWN_GRACE_MS = 250
export const RUNTIME_EXTENSION_TERMINATE_GRACE_MS = 250
export const RUNTIME_EXTENSION_STDERR_MAX_BYTES = 16 * 1024
export const RUNTIME_EXTENSION_MAX_PENDING_REQUESTS = 32
export const RUNTIME_EXTENSION_MAX_QUEUED_WRITES = 64

type RuntimeEnvelope<Type extends string> = {
  schema_id: typeof RUNTIME_EXTENSION_SCHEMA_ID
  schema_version: typeof AGENTWORKPLACE_CONTRACT_VERSION
  message_type: Type
}

type LiteralMessage<Shape, Type extends string> = Shape extends unknown
  ? Omit<Shape, "message_type"> & { message_type: Type }
  : never

type RuntimeInitialize = RuntimeEnvelope<"initialize"> & {
  request_id: string
  workplace_instance_id: string
  extension_id: string
  configuration_id: string
  placement_id: string
  fmx_session: string
  protocol_version: typeof AGENTWORKPLACE_CONTRACT_VERSION
}

type SnapshotInvalidated = RuntimeEnvelope<"snapshot_invalidated"> & {
  fmx_session: string
  revision: string
}

type SnapshotGet = LiteralMessage<Extract<RuntimeExtensionMessage, { after_revision: unknown }>, "snapshot_get">
type SnapshotResult = LiteralMessage<Extract<RuntimeExtensionMessage, { agents: unknown }>, "snapshot_result">
type Present = LiteralMessage<Extract<RuntimeExtensionMessage, { focus: unknown }>, "present">
type RecoveryCardPublish = LiteralMessage<Extract<RuntimeExtensionMessage, { card: unknown }>, "unavailable_slot_publish">
type RecoveryCardAction = LiteralMessage<Extract<RuntimeExtensionMessage, { action_id: unknown }>, "unavailable_slot_action">
type RecoveryCardClear = RuntimeEnvelope<"unavailable_slot_clear"> & {
  request_id: string
  fmx_session: string
  slot_id: string
  card_revision: string
}

export type RuntimeExtensionReady = LiteralMessage<
  Extract<RuntimeExtensionMessage, { capabilities: unknown }>,
  "ready"
>
export type RuntimeExtensionResponse = LiteralMessage<
  Extract<RuntimeExtensionMessage, { ok: unknown }>,
  "response"
>
export type RuntimeExtensionInboundRequest = SnapshotGet | Present | RecoveryCardPublish | RecoveryCardClear
export type RuntimeExtensionInboundOutcome = SnapshotResult | RuntimeExtensionResponse

export type RuntimeExtensionState = "starting" | "ready" | "degraded" | "closing" | "closed"

export type RuntimeExtensionErrorCode =
  | "child_exit"
  | "closed"
  | "handler_failed"
  | "invalid_startup"
  | "invalid_state"
  | "protocol_error"
  | "readiness_refused"
  | "request_limit"
  | "request_timeout"
  | "spawn_failed"
  | "startup_timeout"
  | "stdout_closed"
  | "write_failed"

export class RuntimeExtensionError extends Error {
  constructor(
    readonly code: RuntimeExtensionErrorCode,
    message: string,
    readonly details: {
      stderr?: string
      stderrTruncated?: boolean
      exitCode?: number | null
      generation?: number
      cause?: unknown
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = "RuntimeExtensionError"
  }

  get stderr(): string {
    return this.details.stderr ?? ""
  }

  get stderrTruncated(): boolean {
    return this.details.stderrTruncated ?? false
  }

  get exitCode(): number | null {
    return this.details.exitCode ?? null
  }

  get generation(): number | null {
    return this.details.generation ?? null
  }
}

export type RuntimeExtensionRequestHandler = (
  request: RuntimeExtensionInboundRequest,
  signal: AbortSignal,
) => RuntimeExtensionInboundOutcome | Promise<RuntimeExtensionInboundOutcome>

export type RuntimeExtensionSupervisorOptions = {
  onRequest: RuntimeExtensionRequestHandler
  onDisconnect?: (error: RuntimeExtensionError) => void | Promise<void>
  cwd?: string
  env?: Record<string, string | undefined>
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  shutdownGraceMs?: number
  terminateGraceMs?: number
  stderrMaxBytes?: number
  maxPendingRequests?: number
  maxQueuedWrites?: number
  requestId?: () => string
}

type ResolvedStartup = {
  association: RuntimeAssociationMessage
  registration: RuntimeRegistrationMessage
  placementId: string
  fmxSession: string
}

type NormalizedOptions = {
  onRequest: RuntimeExtensionRequestHandler
  onDisconnect?: (error: RuntimeExtensionError) => void | Promise<void>
  cwd?: string
  env?: Record<string, string | undefined>
  startupTimeoutMs: number
  requestTimeoutMs: number
  shutdownGraceMs: number
  terminateGraceMs: number
  stderrMaxBytes: number
  maxPendingRequests: number
  maxQueuedWrites: number
  requestId: () => string
}

type Failure = {
  code: RuntimeExtensionErrorCode
  message: string
  cause?: unknown
}

type PendingRequest = {
  operation: "unavailable_slot_action"
  resolve: (response: RuntimeExtensionResponse) => void
  reject: (error: RuntimeExtensionError) => void
  timer: ReturnType<typeof setTimeout>
}

type InboundRequest = {
  abort: AbortController
}

type InvalidationLevel = {
  latestRevision: string | null
  acknowledgedRevision: bigint | null
  asserted: boolean
  write: Deferred<void> | null
}

function spawnExtensionChild(
  argv: readonly string[],
  options: Pick<NormalizedOptions, "cwd" | "env">,
) {
  return Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
}

type ExtensionChild = ReturnType<typeof spawnExtensionChild>

type Generation = {
  id: number
  child: ExtensionChild
  initializeRequestId: string
  decoder: ContractFrameDecoder
  stderr: BoundedStderr
  phase: "starting" | "ready" | "stopping"
  ready: Deferred<RuntimeExtensionReady>
  readiness: RuntimeExtensionReady | null
  activeRequestIds: Set<string>
  pending: Map<string, PendingRequest>
  inbound: Map<string, InboundRequest>
  invalidation: InvalidationLevel
  writeTail: Promise<void>
  queuedWrites: number
  failure: Failure | null
  finalization: Promise<RuntimeExtensionError> | null
  reap: Promise<void> | null
  stdoutTask: Promise<void>
  stderrTask: Promise<void>
  exitTask: Promise<void>
  exitCode: number | null
}

/**
 * Owns one Runtime-extension child and its private framed-stdio connection.
 * Initial startup returns only after exact readiness. A later failure leaves
 * the supervisor degraded; callers may make one policy-free explicit restart,
 * which always uses fresh pipes and repeats the complete handshake.
 */
export class RuntimeExtensionSupervisor {
  private readonly startup: ResolvedStartup
  private readonly options: NormalizedOptions
  private stateValue: RuntimeExtensionState = "starting"
  private active: Generation | null = null
  private generationCounter = 0
  private restartOperation: Promise<RuntimeExtensionReady> | null = null
  private closeOperation: Promise<void> | null = null
  private lastFailureValue: RuntimeExtensionError | null = null
  private readinessValue: RuntimeExtensionReady | null = null

  private constructor(startup: RuntimeExtensionStartup, options: RuntimeExtensionSupervisorOptions) {
    this.startup = validateStartup(startup)
    this.options = normalizeOptions(options)
  }

  static async start(
    startup: RuntimeExtensionStartup,
    options: RuntimeExtensionSupervisorOptions,
  ): Promise<RuntimeExtensionSupervisor> {
    let supervisor: RuntimeExtensionSupervisor
    try {
      supervisor = new RuntimeExtensionSupervisor(startup, options)
    } catch (error) {
      if (error instanceof RuntimeExtensionError) throw error
      throw new RuntimeExtensionError("invalid_startup", boundedErrorMessage(error), { cause: error })
    }
    try {
      await supervisor.launch("initial")
      return supervisor
    } catch (error) {
      supervisor.stateValue = "closed"
      throw error
    }
  }

  get state(): RuntimeExtensionState {
    return this.stateValue
  }

  get readiness(): RuntimeExtensionReady | null {
    return this.readinessValue
  }

  get lastFailure(): RuntimeExtensionError | null {
    return this.lastFailureValue
  }

  get generation(): number {
    return this.generationCounter
  }

  get processId(): number | null {
    return this.active?.child.pid ?? null
  }

  /** Assert one coalesced level until a successful snapshot reaches the latest revision. */
  invalidateSnapshot(revision: string): Promise<void> {
    const generation = this.requireReady()
    const candidate: SnapshotInvalidated = {
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "snapshot_invalidated",
      fmx_session: this.startup.fmxSession,
      revision,
    }
    assertRuntimeMessage(candidate, "snapshot invalidation")
    const latest = generation.invalidation.latestRevision
    if (latest !== null && BigInt(revision) <= BigInt(latest)) return Promise.resolve()
    generation.invalidation.latestRevision = revision
    if (
      generation.invalidation.acknowledgedRevision !== null &&
      generation.invalidation.acknowledgedRevision >= BigInt(revision)
    ) {
      return Promise.resolve()
    }
    return this.scheduleInvalidation(generation)
  }

  /** Forward the one opaque human-only Recovery-card action and await its exact response. */
  async requestUnavailableSlotAction(input: {
    slotId: string
    cardRevision: string
    actionId: string
  }): Promise<RuntimeExtensionResponse> {
    const generation = this.requireReady()
    if (generation.pending.size >= this.options.maxPendingRequests) {
      throw this.localError(
        "request_limit",
        `Runtime extension already has ${generation.pending.size} pending request(s)`,
        generation,
      )
    }
    const requestId = this.reserveRequestId(generation)
    const message: RecoveryCardAction = {
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "unavailable_slot_action",
      request_id: requestId,
      fmx_session: this.startup.fmxSession,
      slot_id: input.slotId,
      card_revision: input.cardRevision,
      action_id: input.actionId,
    }
    try {
      assertRuntimeMessage(message, "outbound Recovery-card action")
    } catch (error) {
      generation.activeRequestIds.delete(requestId)
      throw error
    }

    const outcome = deferred<RuntimeExtensionResponse>()
    const timer = setTimeout(() => {
      this.recordFailure(generation, {
        code: "request_timeout",
        message: `Runtime-extension request ${requestId} timed out after ${this.options.requestTimeoutMs}ms`,
      })
    }, this.options.requestTimeoutMs)
    generation.pending.set(requestId, {
      operation: "unavailable_slot_action",
      resolve: outcome.resolve,
      reject: outcome.reject,
      timer,
    })
    try {
      await this.writeOrFail(generation, message)
      return await outcome.promise
    } catch (error) {
      if (generation.pending.delete(requestId)) clearTimeout(timer)
      generation.activeRequestIds.delete(requestId)
      throw error
    }
  }

  /** Restart only a degraded connection; no retry or backoff policy is inferred here. */
  restart(): Promise<RuntimeExtensionReady> {
    if (this.restartOperation !== null) return this.restartOperation
    if (this.stateValue !== "degraded") {
      return Promise.reject(this.localError(
        "invalid_state",
        `cannot restart a Runtime extension while it is ${this.stateValue}`,
      ))
    }
    this.restartOperation = (async () => {
      const previous = this.active
      if (previous?.finalization) await previous.finalization
      if (this.stateValue !== "degraded") {
        throw this.localError("closed", "Runtime extension closed before restart")
      }
      this.stateValue = "starting"
      try {
        return await this.launch("restart")
      } catch (error) {
        if (this.stateValue === "starting") {
          const failure = error instanceof RuntimeExtensionError
            ? error
            : new RuntimeExtensionError(
              "protocol_error",
              `Runtime-extension restart failed: ${boundedErrorMessage(error)}`,
              { cause: error, generation: this.generationCounter },
            )
          this.stateValue = "degraded"
          this.readinessValue = null
          this.lastFailureValue = failure
          this.notifyDisconnect(failure)
          throw failure
        }
        throw error
      } finally {
        this.restartOperation = null
      }
    })()
    return this.restartOperation
  }

  /** Close stdin, allow a bounded clean exit, then TERM/KILL and await process reap. */
  close(): Promise<void> {
    if (this.closeOperation !== null) return this.closeOperation
    this.closeOperation = (async () => {
      if (this.stateValue === "closed") return
      this.stateValue = "closing"
      const generation = this.active
      if (generation !== null) {
        if (generation.phase === "starting") {
          generation.ready.reject({ code: "closed", message: "Runtime extension closed during startup" } satisfies Failure)
        }
        const error = this.localError("closed", "Runtime extension closed", generation)
        await this.stopGeneration(generation)
        generation.invalidation.write?.reject(error)
        generation.invalidation.write = null
        for (const pending of generation.pending.values()) pending.reject(error)
        generation.pending.clear()
        generation.activeRequestIds.clear()
        if (this.active === generation) this.active = null
      }
      this.readinessValue = null
      this.stateValue = "closed"
    })()
    return this.closeOperation
  }

  private async launch(kind: "initial" | "restart"): Promise<RuntimeExtensionReady> {
    const generationId = ++this.generationCounter
    const requestId = this.options.requestId()
    const initialize: RuntimeInitialize = {
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "initialize",
      request_id: requestId,
      workplace_instance_id: this.startup.association.workplace_instance_id,
      extension_id: this.startup.registration.extension_id,
      configuration_id: this.startup.association.configuration_id,
      placement_id: this.startup.placementId,
      fmx_session: this.startup.fmxSession,
      protocol_version: AGENTWORKPLACE_CONTRACT_VERSION,
    }
    try {
      assertRuntimeMessage(initialize, "Runtime-extension initialization")
    } catch (error) {
      throw this.localError("invalid_startup", boundedErrorMessage(error), undefined, error)
    }

    let child: ExtensionChild
    try {
      child = spawnExtensionChild(this.startup.registration.argv, this.options)
    } catch (error) {
      throw new RuntimeExtensionError(
        "spawn_failed",
        `cannot launch Runtime extension ${JSON.stringify(this.startup.registration.argv[0])}: ${boundedErrorMessage(error)}`,
        { cause: error, generation: generationId },
      )
    }

    const generation = this.createGeneration(generationId, child, requestId)
    this.active = generation
    this.readinessValue = null
    this.observeGeneration(generation)

    try {
      await this.writeFrame(generation, initialize)
      const ready = await withTimeout(
        generation.ready.promise,
        this.options.startupTimeoutMs,
        () => ({
          code: "startup_timeout",
          message: `Runtime extension did not become ready within ${this.options.startupTimeoutMs}ms`,
        } satisfies Failure),
      )
      generation.readiness = ready
      if (this.active === generation && this.stateValue === "starting") {
        this.readinessValue = ready
        this.stateValue = "ready"
      }
      return ready
    } catch (error) {
      const failure = asFailure(error, "protocol_error", "Runtime-extension startup failed")
      this.rememberFailure(generation, failure)
      const final = await this.finalizeFailure(generation, failure)
      if (this.stateValue !== "closing" && this.stateValue !== "closed") {
        this.stateValue = kind === "initial" ? "closed" : "degraded"
      }
      if (kind === "restart" && this.stateValue === "degraded") this.notifyDisconnect(final)
      throw final
    }
  }

  private createGeneration(id: number, child: ExtensionChild, initializeRequestId: string): Generation {
    return {
      id,
      child,
      initializeRequestId,
      decoder: new ContractFrameDecoder(),
      stderr: new BoundedStderr(this.options.stderrMaxBytes),
      phase: "starting",
      ready: deferred<RuntimeExtensionReady>(),
      readiness: null,
      activeRequestIds: new Set(),
      pending: new Map(),
      inbound: new Map(),
      invalidation: {
        latestRevision: null,
        acknowledgedRevision: null,
        asserted: false,
        write: null,
      },
      writeTail: Promise.resolve(),
      queuedWrites: 0,
      failure: null,
      finalization: null,
      reap: null,
      stdoutTask: Promise.resolve(),
      stderrTask: Promise.resolve(),
      exitTask: Promise.resolve(),
      exitCode: null,
    }
  }

  private observeGeneration(generation: Generation): void {
    generation.stderrTask = this.readStderr(generation)
    generation.stdoutTask = this.readStdout(generation).catch((error) => {
      this.recordFailure(generation, asFailure(error, "protocol_error", "Runtime-extension stdout failed"))
    })
    generation.exitTask = generation.child.exited.then((exitCode) => {
      generation.exitCode = exitCode
      if (generation.phase === "stopping") return
      this.recordFailure(generation, {
        code: "child_exit",
        message: generation.phase === "starting"
          ? `Runtime-extension child exited with status ${exitCode} before readiness`
          : `Runtime-extension child exited with status ${exitCode}`,
      })
    }).catch((error) => {
      this.recordFailure(generation, {
        code: "child_exit",
        message: `could not observe Runtime-extension child exit: ${boundedErrorMessage(error)}`,
        cause: error,
      })
    })
  }

  private async readStdout(generation: Generation): Promise<void> {
    const reader = generation.child.stdout.getReader()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) {
          generation.decoder.finish()
          if (generation.phase !== "stopping") {
            throw { code: "stdout_closed", message: "Runtime-extension stdout closed" } satisfies Failure
          }
          return
        }
        const payloads = generation.decoder.push(next.value)
        for (const payload of payloads) {
          if (generation.phase === "stopping" || generation.failure !== null) return
          let message: unknown
          try {
            message = decodeAgentWorkplacePayload(payload)
          } catch (error) {
            throw {
              code: "protocol_error",
              message: `invalid Runtime-extension frame: ${boundedErrorMessage(error)}`,
              cause: error,
            } satisfies Failure
          }
          const parsed = runtimeExtensionMessageSchema.safeParse(message)
          if (!parsed.success) {
            throw { code: "protocol_error", message: "child sent a non-Runtime-extension message" } satisfies Failure
          }
          this.handleMessage(generation, parsed.data as RuntimeExtensionMessage)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async readStderr(generation: Generation): Promise<void> {
    const reader = generation.child.stderr.getReader()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) return
        generation.stderr.append(next.value)
      }
    } catch (error) {
      generation.stderr.note(`stderr capture failed: ${boundedErrorMessage(error)}`)
    } finally {
      reader.releaseLock()
    }
  }

  private handleMessage(generation: Generation, message: RuntimeExtensionMessage): void {
    if (generation.phase === "starting") {
      if (message.message_type === "ready") {
        this.acceptReadiness(generation, message as RuntimeExtensionReady)
        return
      }
      const response = message as RuntimeExtensionResponse
      if (
        message.message_type === "response" &&
        response.ok === false &&
        response.operation === "initialize" &&
        response.request_id === generation.initializeRequestId
      ) {
        throw {
          code: "readiness_refused",
          message: `Runtime extension refused readiness (${response.error.code}): ${response.error.message}`,
        } satisfies Failure
      }
      throw {
        code: "protocol_error",
        message: `child sent ${message.message_type} before exact readiness`,
      } satisfies Failure
    }

    if (generation.phase !== "ready") return
    switch (message.message_type) {
      case "response":
        this.acceptResponse(generation, message as RuntimeExtensionResponse)
        return
      case "snapshot_get":
      case "present":
      case "unavailable_slot_publish":
      case "unavailable_slot_clear":
        this.acceptInboundRequest(generation, message as RuntimeExtensionInboundRequest)
        return
      default:
        throw {
          code: "protocol_error",
          message: `child sent ${message.message_type} in the extension-to-Runtime direction`,
        } satisfies Failure
    }
  }

  private acceptReadiness(generation: Generation, ready: RuntimeExtensionReady): void {
    const initializeRequestId = generation.initializeRequestId
    const expected: Array<[string, unknown, unknown]> = [
      ["request_id", ready.request_id, initializeRequestId],
      ["workplace_instance_id", ready.workplace_instance_id, this.startup.association.workplace_instance_id],
      ["extension_id", ready.extension_id, this.startup.registration.extension_id],
      ["configuration_id", ready.configuration_id, this.startup.association.configuration_id],
      ["placement_id", ready.placement_id, this.startup.placementId],
      ["fmx_session", ready.fmx_session, this.startup.fmxSession],
      ["protocol_version", ready.protocol_version, AGENTWORKPLACE_CONTRACT_VERSION],
    ]
    const mismatch = expected.find(([, actual, wanted]) => actual !== wanted)
    if (mismatch !== undefined) {
      throw {
        code: "protocol_error",
        message: `Runtime-extension readiness ${mismatch[0]} does not match initialization`,
      } satisfies Failure
    }
    const advertised = new Set(ready.capabilities)
    const missing = this.startup.registration.required_capabilities.find((capability) => !advertised.has(capability))
    if (missing !== undefined) {
      throw {
        code: "protocol_error",
        message: `Runtime-extension readiness omits required capability ${missing}`,
      } satisfies Failure
    }
    generation.phase = "ready"
    generation.readiness = ready
    generation.ready.resolve(ready)
  }

  private acceptResponse(generation: Generation, response: RuntimeExtensionResponse): void {
    const pending = generation.pending.get(response.request_id)
    if (pending === undefined) {
      throw {
        code: "protocol_error",
        message: `child sent an orphan response for request ${response.request_id}`,
      } satisfies Failure
    }
    if (response.operation !== pending.operation) {
      throw {
        code: "protocol_error",
        message: `response ${response.request_id} names ${response.operation}; expected ${pending.operation}`,
      } satisfies Failure
    }
    generation.pending.delete(response.request_id)
    generation.activeRequestIds.delete(response.request_id)
    clearTimeout(pending.timer)
    pending.resolve(response)
  }

  private acceptInboundRequest(generation: Generation, request: RuntimeExtensionInboundRequest): void {
    if (request.fmx_session !== this.startup.fmxSession) {
      throw {
        code: "protocol_error",
        message: `child request names fmx Session ${request.fmx_session}; expected ${this.startup.fmxSession}`,
      } satisfies Failure
    }
    if (generation.activeRequestIds.has(request.request_id)) {
      throw {
        code: "protocol_error",
        message: `child reused Runtime-extension request id ${request.request_id}`,
      } satisfies Failure
    }
    if (generation.inbound.size >= this.options.maxPendingRequests) {
      throw {
        code: "request_limit",
        message: `child exceeded ${this.options.maxPendingRequests} concurrent Runtime-extension request(s)`,
      } satisfies Failure
    }
    generation.activeRequestIds.add(request.request_id)
    const abort = new AbortController()
    generation.inbound.set(request.request_id, { abort })
    void this.dispatchInboundRequest(generation, request, abort)
  }

  private async dispatchInboundRequest(
    generation: Generation,
    request: RuntimeExtensionInboundRequest,
    abort: AbortController,
  ): Promise<void> {
    try {
      const outcome = await withTimeout(
        (async () => {
          const result = await Promise.resolve(this.options.onRequest(request, abort.signal))
          if (this.active !== generation || generation.phase !== "ready" || generation.failure !== null) return null
          validateInboundOutcome(request, result, this.startup.fmxSession)
          await this.writeFrame(generation, result)
          return result
        })(),
        this.options.requestTimeoutMs,
        () => ({
          code: "request_timeout",
          message: `Runtime request ${request.message_type} ${request.request_id} timed out after ${this.options.requestTimeoutMs}ms`,
        } satisfies Failure),
      )
      if (outcome !== null && request.message_type === "snapshot_get" && outcome.message_type === "snapshot_result") {
        this.acknowledgeSnapshot(generation, outcome.revision)
      }
    } catch (error) {
      if (this.active !== generation || generation.phase === "stopping") return
      const failure = asFailure(
        error,
        "handler_failed",
        `Runtime handler failed for ${request.message_type} ${request.request_id}`,
      )
      this.recordFailure(generation, failure)
    } finally {
      generation.inbound.delete(request.request_id)
      generation.activeRequestIds.delete(request.request_id)
    }
  }

  private reserveRequestId(generation: Generation): string {
    const requestId = this.options.requestId()
    if (generation.activeRequestIds.has(requestId)) {
      throw this.localError(
        "protocol_error",
        `Runtime request-id source reused ${requestId}`,
        generation,
      )
    }
    generation.activeRequestIds.add(requestId)
    return requestId
  }

  private scheduleInvalidation(generation: Generation): Promise<void> {
    if (generation.invalidation.asserted) return Promise.resolve()
    if (generation.invalidation.write !== null) return generation.invalidation.write.promise
    const pending = deferred<void>()
    generation.invalidation.write = pending
    queueMicrotask(() => void this.flushInvalidation(generation, pending))
    return pending.promise
  }

  private async flushInvalidation(generation: Generation, pending: Deferred<void>): Promise<void> {
    let sent = false
    try {
      await this.writeGeneratedFrame(generation, () => {
        const revision = generation.invalidation.latestRevision
        if (revision === null) return null
        if (
          generation.invalidation.acknowledgedRevision !== null &&
          generation.invalidation.acknowledgedRevision >= BigInt(revision)
        ) {
          return null
        }
        sent = true
        return {
          schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
          schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
          message_type: "snapshot_invalidated",
          fmx_session: this.startup.fmxSession,
          revision,
        } satisfies SnapshotInvalidated
      })
      if (sent) generation.invalidation.asserted = true
      pending.resolve()
    } catch (error) {
      const failure = asFailure(error, "write_failed", "could not write snapshot invalidation")
      const finalization = this.recordFailure(generation, failure)
      pending.reject(finalization === null
        ? this.localError(failure.code, failure.message, generation, failure.cause)
        : await finalization)
    } finally {
      if (generation.invalidation.write === pending) generation.invalidation.write = null
    }
  }

  private acknowledgeSnapshot(generation: Generation, revision: string): void {
    const acknowledged = BigInt(revision)
    if (
      generation.invalidation.latestRevision === null ||
      acknowledged > BigInt(generation.invalidation.latestRevision)
    ) {
      generation.invalidation.latestRevision = revision
    }
    if (
      generation.invalidation.acknowledgedRevision === null ||
      acknowledged > generation.invalidation.acknowledgedRevision
    ) {
      generation.invalidation.acknowledgedRevision = acknowledged
    }

    const latest = BigInt(generation.invalidation.latestRevision)
    if (generation.invalidation.acknowledgedRevision >= latest) {
      generation.invalidation.asserted = false
      return
    }

    generation.invalidation.asserted = false
    void this.scheduleInvalidation(generation).catch(() => {})
  }

  private async writeOrFail(generation: Generation, message: unknown): Promise<void> {
    try {
      await this.writeFrame(generation, message)
    } catch (error) {
      const failure = asFailure(error, "write_failed", "could not write to Runtime extension")
      const finalization = this.recordFailure(generation, failure)
      if (finalization !== null) throw await finalization
      throw this.localError(failure.code, failure.message, generation, failure.cause)
    }
  }

  private writeFrame(generation: Generation, message: unknown): Promise<void> {
    return this.writeGeneratedFrame(generation, () => message)
  }

  private writeGeneratedFrame(generation: Generation, message: () => unknown | null): Promise<void> {
    if (this.active !== generation || generation.phase === "stopping") {
      return Promise.reject({ code: "closed", message: "Runtime-extension connection is not writable" } satisfies Failure)
    }
    if (generation.queuedWrites >= this.options.maxQueuedWrites) {
      return Promise.reject({
        code: "request_limit",
        message: `Runtime extension exceeded ${this.options.maxQueuedWrites} queued write(s)`,
      } satisfies Failure)
    }
    generation.queuedWrites++
    const write = generation.writeTail.then(async () => {
      if (this.active !== generation || generation.phase === "stopping") {
        throw { code: "closed", message: "Runtime-extension connection closed before write" } satisfies Failure
      }
      const next = message()
      if (next === null) return
      let frame: Uint8Array
      try {
        assertRuntimeMessage(next, "outbound Runtime-extension message")
        frame = encodeAgentWorkplaceFrame(next as RuntimeExtensionMessage)
      } catch (error) {
        throw {
          code: "protocol_error",
          message: `cannot encode Runtime-extension message: ${boundedErrorMessage(error)}`,
          cause: error,
        } satisfies Failure
      }
      await generation.child.stdin.write(frame)
      await generation.child.stdin.flush()
    }).finally(() => {
      generation.queuedWrites--
    })
    generation.writeTail = write.catch(() => {})
    return write
  }

  private recordFailure(generation: Generation, failure: Failure): Promise<RuntimeExtensionError> | null {
    if (generation.phase === "stopping" || generation.failure !== null) return generation.finalization
    this.rememberFailure(generation, failure)
    if (generation.phase === "starting") {
      generation.ready.reject(failure)
      return null
    }
    if (this.active === generation && this.stateValue !== "closing" && this.stateValue !== "closed") {
      this.stateValue = "degraded"
      this.readinessValue = null
    }
    const finalization = this.finalizeFailure(generation, failure)
    void finalization.then((error) => this.notifyDisconnect(error))
    return finalization
  }

  private rememberFailure(generation: Generation, failure: Failure): void {
    generation.failure ??= failure
    for (const inbound of generation.inbound.values()) inbound.abort.abort()
    for (const pending of generation.pending.values()) clearTimeout(pending.timer)
  }

  private finalizeFailure(generation: Generation, failure: Failure): Promise<RuntimeExtensionError> {
    if (generation.finalization !== null) return generation.finalization
    generation.finalization = (async () => {
      await this.stopGeneration(generation)
      const final = this.localError(failure.code, failure.message, generation, failure.cause)
      this.lastFailureValue = final
      generation.invalidation.write?.reject(final)
      generation.invalidation.write = null
      for (const pending of generation.pending.values()) pending.reject(final)
      generation.pending.clear()
      generation.activeRequestIds.clear()
      if (this.active === generation) this.active = null
      return final
    })()
    return generation.finalization
  }

  private async stopGeneration(generation: Generation): Promise<void> {
    if (generation.reap !== null) return generation.reap
    generation.phase = "stopping"
    for (const inbound of generation.inbound.values()) inbound.abort.abort()
    for (const pending of generation.pending.values()) clearTimeout(pending.timer)

    generation.reap = (async () => {
      try {
        const result = generation.child.stdin.end()
        void Promise.resolve(result).catch(() => {})
      } catch {
        // A peer which already closed stdin still needs to be reaped below.
      }
      let exited = await settlesWithin(generation.child.exited, this.options.shutdownGraceMs)
      if (!exited) {
        try {
          generation.child.kill("SIGTERM")
        } catch {
          // It may have exited between the deadline and signal.
        }
        exited = await settlesWithin(generation.child.exited, this.options.terminateGraceMs)
      }
      if (!exited) {
        try {
          generation.child.kill("SIGKILL")
        } catch {
          // It may have exited between the deadline and signal.
        }
      }
      try {
        generation.exitCode = await generation.child.exited
      } catch {
        // The caller still gets the causal protocol/startup failure.
      }
      await Promise.allSettled([generation.stdoutTask, generation.stderrTask, generation.exitTask])
    })()
    return generation.reap
  }

  private requireReady(): Generation {
    const generation = this.active
    if (this.stateValue !== "ready" || generation === null || generation.phase !== "ready") {
      throw this.localError("invalid_state", `Runtime extension is ${this.stateValue}`, generation ?? undefined)
    }
    return generation
  }

  private localError(
    code: RuntimeExtensionErrorCode,
    message: string,
    generation?: Generation,
    cause?: unknown,
  ): RuntimeExtensionError {
    const stderr = generation?.stderr.text() ?? ""
    const diagnostic = stderr.length > 0
      ? `${message}; Runtime-extension stderr: ${JSON.stringify(stderr)}`
      : message
    return new RuntimeExtensionError(code, diagnostic, {
      stderr,
      stderrTruncated: generation?.stderr.truncated ?? false,
      exitCode: generation?.exitCode ?? null,
      generation: generation?.id,
      cause,
    })
  }

  private notifyDisconnect(error: RuntimeExtensionError): void {
    if (this.options.onDisconnect === undefined) return
    try {
      void Promise.resolve(this.options.onDisconnect(error)).catch(() => {})
    } catch {
      // A diagnostic observer cannot change supervision state or cleanup.
    }
  }
}

function validateStartup(startup: RuntimeExtensionStartup): ResolvedStartup {
  const association = runtimeExtensionMessageSchema.safeParse(startup.association)
  if (!association.success || association.data.message_type !== "association") {
    throw new RuntimeExtensionError("invalid_startup", "Runtime extension has an invalid association")
  }
  const associationMessage = association.data as RuntimeAssociationMessage
  const registration = runtimeExtensionMessageSchema.safeParse(startup.registration)
  if (!registration.success || registration.data.message_type !== "registration") {
    throw new RuntimeExtensionError("invalid_startup", "Runtime extension has an invalid registration")
  }
  const registrationMessage = registration.data as RuntimeRegistrationMessage
  if (associationMessage.members.length !== 2) {
    throw new RuntimeExtensionError("invalid_startup", "Runtime-extension association must contain exactly two members")
  }
  if (associationMessage.extension_id !== registrationMessage.extension_id) {
    throw new RuntimeExtensionError("invalid_startup", "Runtime-extension association and registration ids differ")
  }
  if (
    registrationMessage.protocol.minimum > AGENTWORKPLACE_CONTRACT_VERSION ||
    registrationMessage.protocol.maximum < AGENTWORKPLACE_CONTRACT_VERSION
  ) {
    throw new RuntimeExtensionError(
      "invalid_startup",
      `Runtime-extension protocol range does not include ${AGENTWORKPLACE_CONTRACT_VERSION}`,
    )
  }
  const missing = RUNTIME_EXTENSION_CAPABILITIES.find((capability) =>
    !registrationMessage.required_capabilities.includes(capability)
  )
  if (missing !== undefined) {
    throw new RuntimeExtensionError("invalid_startup", `Runtime-extension registration omits ${missing}`)
  }
  const members = associationMessage.members.filter((member) => member.placement_id === startup.placementId)
  if (members.length !== 1) {
    throw new RuntimeExtensionError("invalid_startup", "Runtime-extension placement is not one exact association member")
  }
  return {
    association: associationMessage,
    registration: registrationMessage,
    placementId: startup.placementId,
    fmxSession: members[0]!.fmx_session,
  }
}

function normalizeOptions(options: RuntimeExtensionSupervisorOptions): NormalizedOptions {
  const normalized: NormalizedOptions = {
    onRequest: options.onRequest,
    onDisconnect: options.onDisconnect,
    cwd: options.cwd,
    env: options.env,
    startupTimeoutMs: options.startupTimeoutMs ?? RUNTIME_EXTENSION_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? RUNTIME_EXTENSION_REQUEST_TIMEOUT_MS,
    shutdownGraceMs: options.shutdownGraceMs ?? RUNTIME_EXTENSION_SHUTDOWN_GRACE_MS,
    terminateGraceMs: options.terminateGraceMs ?? RUNTIME_EXTENSION_TERMINATE_GRACE_MS,
    stderrMaxBytes: options.stderrMaxBytes ?? RUNTIME_EXTENSION_STDERR_MAX_BYTES,
    maxPendingRequests: options.maxPendingRequests ?? RUNTIME_EXTENSION_MAX_PENDING_REQUESTS,
    maxQueuedWrites: options.maxQueuedWrites ?? RUNTIME_EXTENSION_MAX_QUEUED_WRITES,
    requestId: options.requestId ?? randomUUID,
  }
  for (const [name, value, maximum] of [
    ["startupTimeoutMs", normalized.startupTimeoutMs, 60_000],
    ["requestTimeoutMs", normalized.requestTimeoutMs, 60_000],
    ["shutdownGraceMs", normalized.shutdownGraceMs, 60_000],
    ["terminateGraceMs", normalized.terminateGraceMs, 60_000],
    ["stderrMaxBytes", normalized.stderrMaxBytes, CONTRACT_MAX_FRAME_BYTES],
    ["maxPendingRequests", normalized.maxPendingRequests, 1_024],
    ["maxQueuedWrites", normalized.maxQueuedWrites, 4_096],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new RuntimeExtensionError("invalid_startup", `${name} must be an integer from 1 through ${maximum}`)
    }
  }
  if (typeof normalized.onRequest !== "function") {
    throw new RuntimeExtensionError("invalid_startup", "Runtime extension requires an inbound request handler")
  }
  return normalized
}

function assertRuntimeMessage(message: unknown, label: string): void {
  const parsed = runtimeExtensionMessageSchema.safeParse(message)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new RuntimeExtensionError(
      "protocol_error",
      `${label} is invalid${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message ?? "unknown error"}`,
    )
  }
}

function validateInboundOutcome(
  request: RuntimeExtensionInboundRequest,
  outcome: RuntimeExtensionInboundOutcome,
  fmxSession: string,
): void {
  assertRuntimeMessage(outcome, `outcome for ${request.message_type}`)
  if (outcome.request_id !== request.request_id) {
    throw {
      code: "handler_failed",
      message: `Runtime handler response id ${outcome.request_id} does not match ${request.request_id}`,
    } satisfies Failure
  }
  if (request.message_type === "snapshot_get") {
    if (outcome.message_type === "snapshot_result") {
      if (outcome.fmx_session !== fmxSession) {
        throw { code: "handler_failed", message: "snapshot result names the wrong fmx Session" } satisfies Failure
      }
      return
    }
    if (outcome.message_type === "response" && outcome.ok === false && outcome.operation === "snapshot_get") return
    throw { code: "handler_failed", message: "snapshot_get handler returned the wrong outcome" } satisfies Failure
  }
  if (outcome.message_type !== "response") {
    throw { code: "handler_failed", message: `${request.message_type} handler must return a response` } satisfies Failure
  }
  if (outcome.operation !== request.message_type) {
    throw {
      code: "handler_failed",
      message: `${request.message_type} handler returned operation ${outcome.operation}`,
    } satisfies Failure
  }
}

function asFailure(error: unknown, code: RuntimeExtensionErrorCode, prefix: string): Failure {
  if (isFailure(error)) return error
  if (error instanceof RuntimeExtensionError) {
    return { code: error.code, message: error.message, cause: error }
  }
  return { code, message: `${prefix}: ${boundedErrorMessage(error)}`, cause: error }
}

function isFailure(value: unknown): value is Failure {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<Failure>
  return isRuntimeExtensionErrorCode(candidate.code) && typeof candidate.message === "string"
}

function isRuntimeExtensionErrorCode(value: unknown): value is RuntimeExtensionErrorCode {
  return value === "child_exit" ||
    value === "closed" ||
    value === "handler_failed" ||
    value === "invalid_startup" ||
    value === "invalid_state" ||
    value === "protocol_error" ||
    value === "readiness_refused" ||
    value === "request_limit" ||
    value === "request_timeout" ||
    value === "spawn_failed" ||
    value === "startup_timeout" ||
    value === "stdout_closed" ||
    value === "write_failed"
}

function boundedErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return sanitizeText(value, 1_024) || "unknown error"
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  // Some failures race the launch await by one microtask; keep them handled.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, failure: () => Failure): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(failure()), milliseconds)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

class BoundedStderr {
  private bytes = new Uint8Array(0)
  private dropped = false

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.maximumBytes) {
      const replaced = this.bytes.byteLength > 0
      this.bytes = chunk.slice(chunk.byteLength - this.maximumBytes)
      this.dropped = this.dropped || replaced || chunk.byteLength > this.maximumBytes
      return
    }
    const overflow = this.bytes.byteLength + chunk.byteLength - this.maximumBytes
    const kept = overflow > 0 ? this.bytes.subarray(overflow) : this.bytes
    const combined = new Uint8Array(kept.byteLength + chunk.byteLength)
    combined.set(kept)
    combined.set(chunk, kept.byteLength)
    this.bytes = combined
    if (overflow > 0) this.dropped = true
  }

  note(message: string): void {
    this.append(new TextEncoder().encode(`\n${message}`))
  }

  text(): string {
    return sanitizeText(new TextDecoder().decode(this.bytes), this.maximumBytes)
  }

  get truncated(): boolean {
    return this.dropped
  }
}

function sanitizeText(value: string, maximumBytes: number): string {
  let sanitized = ""
  for (const character of value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")) {
    const codePoint = character.codePointAt(0)!
    if (character === "\n" || character === "\t" || (codePoint >= 0x20 && codePoint !== 0x7f && codePoint < 0x80)) {
      sanitized += character
      continue
    }
    if (codePoint >= 0xa0) sanitized += character
  }
  sanitized = sanitized.trim()
  const encoded = new TextEncoder().encode(sanitized)
  if (encoded.byteLength <= maximumBytes) return sanitized
  let offset = encoded.byteLength - maximumBytes
  while (offset < encoded.byteLength && (encoded[offset]! & 0xc0) === 0x80) offset++
  return new TextDecoder().decode(encoded.subarray(offset)).trim()
}
