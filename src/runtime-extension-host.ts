import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_SCHEMA_ID,
  runtimeExtensionMessageSchema,
} from "./agentworkplace-contracts.ts"
import {
  RuntimeExtensionSurfaceError,
  type RuntimeExtensionSurface,
} from "./multiplexer.ts"
import type { RecoveryCardSpec } from "./recovery-card.ts"
import {
  RuntimeExtensionError,
  RuntimeExtensionSupervisor,
  type RuntimeExtensionInboundOutcome,
  type RuntimeExtensionInboundRequest,
  type RuntimeExtensionLifecycleReceipt,
  type RuntimeExtensionRequestHandler,
  type RuntimeExtensionResponse,
  type RuntimeExtensionState,
  type RuntimeExtensionSupervisorOptions,
} from "./runtime-extension.ts"
import type { RuntimeExtensionStartup } from "./runtime-startup.ts"
import type {
  ManagedLaunchOutcome,
  ManagedLaunchTerminalReceipt,
} from "./managed-launch-contract.ts"

const ERROR_MESSAGE_MAX_BYTES = 1024
const SAFE_ERROR_CODE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu

type SupervisorOverrides = Omit<
  RuntimeExtensionSupervisorOptions,
  | "cwd"
  | "env"
  | "onDisconnect"
  | "onRequest"
  | "onLifecycleMessage"
  | "onInlineLaunchSourceRequest"
  | "onManagedLaunchMessage"
>

type RuntimeExtensionHostCallbacks = Pick<
  RuntimeExtensionSupervisorOptions,
  "onLifecycleMessage" | "onInlineLaunchSourceRequest" | "onManagedLaunchMessage"
>

function publishReceipt(
  host: RuntimeExtensionHost,
  receipt:
    | RuntimeExtensionLifecycleReceipt
    | ManagedLaunchOutcome
    | ManagedLaunchTerminalReceipt,
): Promise<void> {
  if (receipt.message_type === "terminal_receipt") {
    return host.publishManagedLaunchTerminalReceipt(receipt)
  }
  if (receipt.message_type === "launch_outcome") {
    return host.publishManagedLaunchOutcome(receipt)
  }
  return host.publishLifecycleReceipt(receipt)
}

export type RuntimeExtensionHostOptions = SupervisorOverrides & RuntimeExtensionHostCallbacks & {
  cwd?: string
  env?: Record<string, string | undefined>
  onDiagnostic?: (error: RuntimeExtensionError) => void
  /** The replacement generation is exactly ready; replay durable host work now. */
  onRestartReady?: () => void | Promise<void>
}

/**
 * Bind lifecycle publication before the child exists. Pre-ready publication
 * only queues immutable bytes in memory and returns immediately; the durable
 * lifecycle ledgers remain the authority if this process disappears first.
 */
export class RuntimeExtensionReceiptQueue {
  private host: RuntimeExtensionHost | null = null
  private pending: Array<
    RuntimeExtensionLifecycleReceipt | ManagedLaunchOutcome | ManagedLaunchTerminalReceipt
  > = []
  private tail: Promise<void> = Promise.resolve()
  private bindOperation: Promise<void> | null = null

  publish(
    receipt:
      | RuntimeExtensionLifecycleReceipt
      | ManagedLaunchOutcome
      | ManagedLaunchTerminalReceipt,
  ): Promise<void> {
    const exact = structuredClone(receipt)
    if (this.host === null) {
      this.pending.push(exact)
      return Promise.resolve()
    }
    return this.enqueue(this.host, exact)
  }

  bind(host: RuntimeExtensionHost): Promise<void> {
    if (this.host !== null && this.host !== host) {
      return Promise.reject(new Error("Runtime-extension receipt queue is already bound"))
    }
    if (this.bindOperation !== null) return this.bindOperation
    const pending = this.pending.splice(0)
    let flush = this.tail
    for (const receipt of pending) {
      flush = flush.then(() => publishReceipt(host, receipt))
    }
    this.host = host
    this.tail = flush.catch(() => {})
    this.bindOperation = flush
    return flush
  }

  private enqueue(
    host: RuntimeExtensionHost,
    receipt:
      | RuntimeExtensionLifecycleReceipt
      | ManagedLaunchOutcome
      | ManagedLaunchTerminalReceipt,
  ): Promise<void> {
    const operation = this.tail.then(() => publishReceipt(host, receipt))
    this.tail = operation.catch(() => {})
    return operation
  }
}

/**
 * Own the associated Runtime's one child link. One post-readiness loss gets a
 * single fresh-pipe restart; a failed restart leaves only this host degraded.
 */
export class RuntimeExtensionHost {
  private supervisor: RuntimeExtensionSupervisor | null = null
  private unsubscribe: (() => void) | null = null
  private latestRevision: string | null = null
  private pendingDisconnect: RuntimeExtensionError | null = null
  private restartAttempted = false
  private closing = false
  private disconnectTail: Promise<void> = Promise.resolve()
  private closeOperation: Promise<void> | null = null

  private constructor(
    private readonly startup: RuntimeExtensionStartup,
    private readonly surface: RuntimeExtensionSurface,
    private readonly options: RuntimeExtensionHostOptions,
  ) {}

  static async start(
    startup: RuntimeExtensionStartup,
    surface: RuntimeExtensionSurface,
    options: RuntimeExtensionHostOptions = {},
  ): Promise<RuntimeExtensionHost> {
    const host = new RuntimeExtensionHost(startup, surface, options)
    await host.launch()
    return host
  }

  get state(): RuntimeExtensionState {
    return this.supervisor?.state ?? (this.closing ? "closed" : "starting")
  }

  get generation(): number {
    return this.supervisor?.generation ?? 0
  }

  get processId(): number | null {
    return this.supervisor?.processId ?? null
  }

  async forwardRecoveryAction(input: {
    slot_id: string
    card_revision: string
    action_id: string
  }): Promise<RuntimeExtensionResponse | null> {
    const supervisor = this.supervisor
    if (this.closing || supervisor?.state !== "ready") return null
    try {
      return await supervisor.requestUnavailableSlotAction({
        slotId: input.slot_id,
        cardRevision: input.card_revision,
        actionId: input.action_id,
      })
    } catch {
      // A transport failure is diagnosed by onDisconnect. A stale human
      // action remains inert rather than acquiring fmx-owned recovery policy.
      return null
    }
  }

  /** Publish one durable lifecycle receipt without coupling it to handler completion. */
  async publishLifecycleReceipt(receipt: RuntimeExtensionLifecycleReceipt): Promise<void> {
    const supervisor = this.supervisor
    if (supervisor === null) {
      throw new RuntimeExtensionError("invalid_state", "Runtime-extension host has not started")
    }
    await supervisor.publishLifecycleReceipt(receipt)
  }

  async publishManagedLaunchOutcome(outcome: ManagedLaunchOutcome): Promise<void> {
    const supervisor = this.supervisor
    if (supervisor === null) {
      throw new RuntimeExtensionError("invalid_state", "Runtime-extension host has not started")
    }
    await supervisor.publishManagedLaunchOutcome(outcome)
  }

  async publishManagedLaunchTerminalReceipt(
    receipt: ManagedLaunchTerminalReceipt,
  ): Promise<void> {
    const supervisor = this.supervisor
    if (supervisor === null) {
      throw new RuntimeExtensionError("invalid_state", "Runtime-extension host has not started")
    }
    await supervisor.publishManagedLaunchTerminalReceipt(receipt)
  }

  close(): Promise<void> {
    if (this.closeOperation !== null) return this.closeOperation
    this.closeOperation = (async () => {
      this.closing = true
      this.unsubscribe?.()
      this.unsubscribe = null
      await this.supervisor?.close()
      await this.disconnectTail
    })()
    return this.closeOperation
  }

  private async launch(): Promise<void> {
    const {
      cwd,
      env,
      onDiagnostic: _onDiagnostic,
      onRestartReady: _onRestartReady,
      onLifecycleMessage,
      onInlineLaunchSourceRequest,
      onManagedLaunchMessage,
      ...supervisorOptions
    } = this.options
    const supervisor = await RuntimeExtensionSupervisor.start(this.startup, {
      ...supervisorOptions,
      cwd,
      env,
      onLifecycleMessage,
      onInlineLaunchSourceRequest,
      onManagedLaunchMessage,
      onRequest: runtimeExtensionRequestHandler(this.surface, this.startup.association.members.find(
        (member) => member.placement_id === this.startup.placementId,
      )!.fmx_session),
      onDisconnect: (error) => this.queueDisconnect(error),
    })
    this.supervisor = supervisor
    try {
      this.unsubscribe = this.surface.subscribeInvalidation((revision) => {
        this.latestRevision = revision
        if (supervisor.state !== "ready") return
        try {
          void supervisor.invalidateSnapshot(revision).catch(() => {})
        } catch {
          // The generation may have disconnected between the state read and
          // the level assertion. onDisconnect owns restart/degradation.
        }
      })
    } catch (error) {
      await supervisor.close()
      throw error
    }

    const pending = this.pendingDisconnect
    this.pendingDisconnect = null
    if (pending) await this.queueDisconnect(pending)
  }

  private queueDisconnect(error: RuntimeExtensionError): Promise<void> {
    this.disconnectTail = this.disconnectTail.then(() => this.handleDisconnect(error)).catch(() => {})
    return this.disconnectTail
  }

  private async handleDisconnect(error: RuntimeExtensionError): Promise<void> {
    if (this.closing) return
    this.options.onDiagnostic?.(error)
    const supervisor = this.supervisor
    if (supervisor === null) {
      this.pendingDisconnect = error
      return
    }
    if (this.restartAttempted || supervisor.state !== "degraded") return
    this.restartAttempted = true
    try {
      await supervisor.restart()
      const revision = this.latestRevision
      if (!this.closing && revision !== null) await supervisor.invalidateSnapshot(revision)
      if (!this.closing) await this.options.onRestartReady?.()
    } catch {
      // A failed restarted generation supplies its own exact disconnect
      // diagnostic. There is deliberately no crash-loop policy in fmx.
    }
  }
}

/**
 * Adapt the framed child link to the deliberately small Multiplexer surface.
 * Expected capability errors are correlated protocol failures; they never
 * tear down an otherwise healthy Runtime-extension connection.
 */
export function runtimeExtensionRequestHandler(
  surface: RuntimeExtensionSurface,
  fmxSession: string,
): RuntimeExtensionRequestHandler {
  return async (request, signal) => {
    if (request.fmx_session !== fmxSession) {
      return failure(
        request,
        "identity_mismatch",
        `request names fmx Session ${request.fmx_session}; expected ${fmxSession}`,
      )
    }
    if (signal.aborted) return failure(request, "cancelled", "Runtime-extension request was cancelled")

    try {
      switch (request.message_type) {
        case "snapshot_get": {
          const snapshot = await surface.snapshot()
          if (signal.aborted) {
            return failure(request, "cancelled", "Runtime-extension snapshot request was cancelled")
          }
          return validated({
            schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
            schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
            message_type: "snapshot_result",
            request_id: request.request_id,
            fmx_session: fmxSession,
            ...snapshot,
          })
        }
        case "present":
          surface.present(request.agent_id, request.focus)
          return accepted(request)
        case "unavailable_slot_publish":
          surface.publishRecoveryCard(request.card as RecoveryCardSpec)
          return accepted(request)
        case "unavailable_slot_clear":
          surface.clearRecoveryCard(request.slot_id, request.card_revision)
          return accepted(request)
      }
    } catch (error) {
      const code = error instanceof RuntimeExtensionSurfaceError ? error.code : "internal_error"
      return failure(request, code, errorMessage(error))
    }
  }
}

function accepted(
  request: Exclude<RuntimeExtensionInboundRequest, { message_type: "snapshot_get" }>,
): RuntimeExtensionInboundOutcome {
  return validated({
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "response",
    request_id: request.request_id,
    operation: request.message_type,
    ok: true,
    status: "accepted",
  })
}

function failure(
  request: RuntimeExtensionInboundRequest,
  requestedCode: string,
  message: string,
): RuntimeExtensionInboundOutcome {
  const code = SAFE_ERROR_CODE.test(requestedCode) ? requestedCode : "internal_error"
  return validated({
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "response",
    request_id: request.request_id,
    operation: request.message_type,
    ok: false,
    error: {
      code,
      message: boundedErrorMessage(message),
    },
  })
}

function validated(message: RuntimeExtensionInboundOutcome): RuntimeExtensionInboundOutcome {
  const result = runtimeExtensionMessageSchema.safeParse(message)
  if (!result.success) {
    throw new Error(`invalid Runtime-extension host outcome: ${result.error.issues[0]?.message ?? "unknown error"}`)
  }
  return message
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedErrorMessage(value: string): string {
  const normalized = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim() || "operation failed"
  let bytes = 0
  let bounded = ""
  for (const character of normalized) {
    const size = Buffer.byteLength(character)
    if (bytes + size > ERROR_MESSAGE_MAX_BYTES) break
    bounded += character
    bytes += size
  }
  return bounded || "operation failed"
}
