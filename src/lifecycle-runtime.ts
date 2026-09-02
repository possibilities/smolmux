import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import type { AgentExit } from "./agent-transport.ts"
import {
  identityFor,
  type AgentManifest,
  type ManifestEntry,
} from "./agent-manifest.ts"
import type { AgentRemoval } from "./agent-reconcile.ts"
import { CompanionConnection } from "./companion-client.ts"
import type { AgentDefaults } from "./config.ts"
import { encodeCanonicalJson, type JsonValue } from "./contract-codec.ts"
import {
  EnsureLifecycleLedger,
  type EnsureLifecycleRecord,
  type FxAdmissionDecision,
  type FxFinalReceipt,
  type FxFinalReceiptAcknowledgement,
  type FxFinalReceiptAuthorityBinding,
  type LifecycleLedgerRecord,
  type ManagedLaunchRecord,
} from "./ensure-lifecycle-ledger.ts"
import { buildEnsureLifecycleReceipt } from "./ensure-lifecycle-receipt.ts"
import {
  ExactAgentRetirement,
  type NeverStartedProof,
  type RetirementCompanionAuthority,
} from "./exact-agent-retirement.ts"
import {
  ExactRetirementLedger,
  type CleanupReceipt,
  type CleanupRequest,
  type EndReceipt,
  type EndRequest,
  type RetirementReceiptAcknowledgement,
} from "./exact-retirement-ledger.ts"
import { ExactWorktreeCreator } from "./exact-worktree-creation.ts"
import {
  createFxEnvironment,
  type FxAdeBinding,
} from "./fx-environment.ts"
import {
  FxLaunchProviderClient,
  FxLaunchProviderError,
  type FxAdmissionCancelRequest,
  type FxLaunchProviderBuild,
  type FxLaunchProviderFinalAuthority,
  type FxLaunchProviderFinalOutcome,
  type FxLaunchProviderInvocation,
  type FxLaunchProviderResumeStatus,
} from "./fx-launch-provider.ts"
import {
  FxWorkControlClient,
  FxWorkControlError,
  mintFxWorkControlBinding,
  removeFxWorkControlResidue,
  type FxWorkControlBinding,
  type FxWorkControlRequester,
  type FxWorkControlResult,
} from "./fx-work-control.ts"
import {
  GitSafeWorktreeAuthority,
  GitSafeWorktreeCleanup,
} from "./git-safe-worktree-cleanup.ts"
import {
  InlineLaunchSourceLedger,
  parseInlineLaunchControls,
  type InlineLaunchSourceRequest,
} from "./inline-launch-source.ts"
import {
  LifecycleCoordinator,
  type AdmittedFxAdmissionDecision,
  type CancelledFxAdmissionDecision,
  type LifecycleAdmissionOutcome,
  type LifecycleCoordinatorPorts,
  type ManagedLaunchFailure,
} from "./lifecycle-coordinator.ts"
import { readGitContext } from "./git-context.ts"
import {
  deriveManagedLaunchTerminalReceiptDigest,
  deriveManagedLaunchTerminalReceiptId,
  managedLaunchSourceBytes,
  type ManagedLaunchAcknowledgement,
  type ManagedLaunchCause,
  type ManagedLaunchOutcome,
  type ManagedLaunchRequest,
  type ManagedLaunchRetry,
  type ManagedLaunchStage,
  type ManagedLaunchTerminalAcknowledgement,
  type ManagedLaunchTerminalReceipt,
} from "./managed-launch-contract.ts"
import type {
  ManagedAgentClaim,
  ManagedAgentInvocation,
  ManagedAgentStartResult,
} from "./multiplexer.ts"
import {
  EnsureLifecycleRuntimeMemberCorrelationSource,
  type RuntimeMemberCorrelationSource,
} from "./runtime-member-correlation.ts"
import type {
  RuntimeExtensionLifecycleInbound,
  RuntimeExtensionLifecycleReceipt,
} from "./runtime-extension.ts"
import type { CompanionCommand } from "./zmx-command.ts"
import { readHeadCommit } from "./worktree.ts"

type MaybePromise<T> = T | Promise<T>

export type LifecycleRuntimeMultiplexer = {
  projectManagedAgent(claim: ManagedAgentClaim): Promise<ManifestEntry>
  startManagedAgent(
    agentId: string,
    invocation: ManagedAgentInvocation,
  ): Promise<ManagedAgentStartResult>
  /** Remove an inert managed projection after exact never-started retirement. */
  removeManagedAgentProjection(agentId: string): Promise<void>
  /** Publish the projection revision after the durable claim is gone. */
  refreshManagedAgentProjection(agentId: string): void
}

export type LifecycleReceiptPublisher = (
  receipt:
    | RuntimeExtensionLifecycleReceipt
    | ManagedLaunchOutcome
    | ManagedLaunchTerminalReceipt,
) => MaybePromise<void>

export type LifecycleRuntimeRoots = {
  root: string
  ensure: string
  inlineSource: string
  retirement: string
  worktree: string
}

type LaunchProvider = Pick<
  FxLaunchProviderClient,
  "prepare" | "build" | "inspect" | "cancel" | "recordFinal" | "acknowledgeFinal"
> & Partial<Pick<FxLaunchProviderClient, "resumeStatus">>

type WorktreeCreator = Pick<ExactWorktreeCreator, "create">
type RetirementEngine = Pick<ExactAgentRetirement, "end" | "acknowledge">
type CleanupEngine = Pick<GitSafeWorktreeCleanup, "cleanup">

export type LifecycleRuntimeOptions = {
  home: string | Readonly<{ directory: string }>
  homeId: string
  fmxSession: string
  /** Immutable defaults from the accepted cold-Runtime startup snapshot. */
  agentDefaults?: Readonly<AgentDefaults>
  fxPath: string
  runtimeSocketPath: string
  adeBinding: FxAdeBinding | ((agentId: string) => FxAdeBinding | null) | null
  manifest: AgentManifest
  companion: Pick<CompanionCommand, "list">
  companionDirectory: string
  environment?: NodeJS.ProcessEnv
  now?: () => Date
  onError?: (error: unknown, correlation: string) => void

  /** Deterministic seams used by focused composition tests. */
  ensureLedger?: EnsureLifecycleLedger
  inlineSourceLedger?: InlineLaunchSourceLedger
  retirementLedger?: ExactRetirementLedger
  worktreeCreator?: WorktreeCreator
  retirement?: RetirementEngine
  cleanup?: CleanupEngine
  launchProvider?: LaunchProvider
  workControl?: FxWorkControlRequester
  companionAuthority?: RetirementCompanionAuthority
  /**
   * Test-only: overrides the fixed 1000 ms pendingAdmissionRetryDelayMs this
   * class wires into its LifecycleCoordinator construction below. Production
   * callers must never set this; it exists solely so a focused composition
   * test can observe the real 16-attempt bounded-pending budget without
   * waiting out fifteen full production-length delays.
   */
  pendingAdmissionRetryDelayMsForTests?: number
}

/** Stable, private per-Home locations. None of these records lives in `/tmp`. */
export function lifecycleRuntimeRoots(
  home: string | Readonly<{ directory: string }>,
): LifecycleRuntimeRoots {
  const directory = typeof home === "string" ? home : home.directory
  const root = join(directory, "lifecycle")
  return {
    root,
    ensure: join(root, "ensure"),
    inlineSource: join(root, "inline-source"),
    retirement: join(root, "retirement"),
    worktree: join(root, "worktree"),
  }
}

/**
 * Production composition for the frozen lifecycle links.
 *
 * The class owns only fmx's public/durable authorities. It never reads Fx's
 * private launch ledger: every admission and final observation crosses the
 * launch-provider client, and every initial instruction crosses schema-1
 * Work-control.
 */
export class LifecycleRuntime {
  readonly correlationSource: RuntimeMemberCorrelationSource
  readonly roots: LifecycleRuntimeRoots

  private multiplexer: LifecycleRuntimeMultiplexer | null = null
  private receiptPublisher: LifecycleReceiptPublisher | null = null
  private closed = false
  private readonly workAbort = new AbortController()
  private readonly preparedConversations = new Map<string, string>()
  private readonly effectGates = new Map<string, Promise<void>>()
  private readonly retirementDirty = new Set<string>()
  private readonly retirementEffects = new Map<string, Promise<void>>()
  private recoveryOperation: Promise<void> | null = null
  private readonly coordinator: LifecycleCoordinator

  private constructor(
    private readonly options: LifecycleRuntimeOptions,
    roots: LifecycleRuntimeRoots,
    private readonly ensureLedger: EnsureLifecycleLedger,
    private readonly sources: InlineLaunchSourceLedger,
    private readonly retirementLedger: ExactRetirementLedger,
    private readonly worktreeCreator: WorktreeCreator,
    private readonly retirement: RetirementEngine,
    private readonly cleanup: CleanupEngine,
    private readonly provider: LaunchProvider,
    private readonly workControl: FxWorkControlRequester,
  ) {
    this.roots = roots
    this.correlationSource = new EnsureLifecycleRuntimeMemberCorrelationSource(ensureLedger)
    this.coordinator = new LifecycleCoordinator({
      ledger: ensureLedger,
      sources,
      ports: this.coordinatorPorts(),
      // Fx admission polling is fallible in the ordinary course of a live
      // Runtime: sixteen attempts spaced one second apart (fifteen delays,
      // fifteen seconds bounded) give Fx a realistic window to decide before
      // this correlation is left durably pending for the next recover().
      pendingAdmissionAttempts: 16,
      pendingAdmissionRetryDelayMs: options.pendingAdmissionRetryDelayMsForTests ?? 1000,
    })
  }

  static async open(options: LifecycleRuntimeOptions): Promise<LifecycleRuntime> {
    const roots = lifecycleRuntimeRoots(options.home)
    const [ensureLedger, sources, retirementLedger] = await Promise.all([
      options.ensureLedger ?? EnsureLifecycleLedger.open(roots.ensure),
      options.inlineSourceLedger ?? InlineLaunchSourceLedger.open(roots.inlineSource),
      options.retirementLedger ?? ExactRetirementLedger.open(roots.retirement),
    ])
    const provider = options.launchProvider ?? new FxLaunchProviderClient({
      executable: options.fxPath,
      parentEnvironment: options.environment,
    })
    const companionAuthority = options.companionAuthority ?? {
      list: () => options.companion.list(),
      connect: (socketPath: string) => CompanionConnection.connect(socketPath),
    }
    return new LifecycleRuntime(
      options,
      roots,
      ensureLedger,
      sources,
      retirementLedger,
      options.worktreeCreator ?? new ExactWorktreeCreator(roots.worktree, {
        environment: options.environment,
      }),
      options.retirement ?? new ExactAgentRetirement(
        retirementLedger,
        options.homeId,
        options.companionDirectory,
        companionAuthority,
        { now: options.now },
      ),
      options.cleanup ?? new GitSafeWorktreeCleanup(
        retirementLedger,
        new GitSafeWorktreeAuthority(options.environment),
        { now: options.now },
      ),
      provider,
      options.workControl ?? new FxWorkControlClient(),
    )
  }

  bindMultiplexer(app: LifecycleRuntimeMultiplexer): void {
    if (this.multiplexer !== null && this.multiplexer !== app) {
      throw new Error("lifecycle Runtime is already bound to a Multiplexer")
    }
    this.multiplexer = app
  }

  bindReceiptPublisher(publish: LifecycleReceiptPublisher): void {
    if (this.receiptPublisher !== null && this.receiptPublisher !== publish) {
      throw new Error("lifecycle Runtime is already bound to a receipt publisher")
    }
    this.receiptPublisher = publish
  }

  acceptLifecycle(
    message: RuntimeExtensionLifecycleInbound,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    this.assertOpen()
    this.assertSession(message)
    return this.coordinator.accept(message)
  }

  acceptInlineSource(
    source: InlineLaunchSourceRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    this.assertOpen()
    this.assertSession(source)
    return this.coordinator.acceptInlineSource(source)
  }

  acceptManagedLaunch(
    message:
      | ManagedLaunchRequest
      | ManagedLaunchAcknowledgement
      | ManagedLaunchRetry
      | ManagedLaunchTerminalAcknowledgement,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    this.assertOpen()
    this.assertSession(message)
    return this.coordinator.acceptManaged(message)
  }

  async recover(): Promise<void> {
    this.assertOpen()
    if (this.recoveryOperation !== null) return this.recoveryOperation
    const operation = this.recoverOnce()
    this.recoveryOperation = operation
    try {
      await operation
    } finally {
      if (this.recoveryOperation === operation) this.recoveryOperation = null
    }
  }

  private async recoverOnce(): Promise<void> {
    // Re-project claims before the coordinator starts Companion work. A
    // crash after the projection but before its next durable boundary must
    // leave the exact Agent/work-control identity restartable.
    const durable = await this.ensureLedger.list()
    const managed = await this.ensureLedger.listManaged()
    if (this.closed) return
    const app = this.requireMultiplexer()
    for (const record of durable) {
      if (this.closed) return
      if (record.stage !== "manifest_claimed") continue
      const existing = this.options.manifest.get(record.request.agent_id)
      const workControl = existing?.workControl ?? mintFxWorkControlBinding(
        this.options.runtimeSocketPath,
        record.request.agent_id,
      )
      await app.projectManagedAgent({
        agentId: record.request.agent_id,
        cwd: record.request.planned_worktree.directory,
        fxPath: this.options.fxPath,
        fxArgs: existing?.fxArgs ?? null,
        workControl,
        createdAt: existing?.createdAt,
        focus: false,
      })
      if (this.closed) return
      await this.removeNeverStartedProjection(
        await this.retirementLedger.get(record.request.ensure_id),
      )
      if (this.closed) return
    }
    for (const record of managed) {
      if (this.closed) return
      if (record.stage !== "manifest_claimed") continue
      const existing = this.options.manifest.get(record.request.agent_id)
      const workControl = existing?.workControl ?? mintFxWorkControlBinding(
        this.options.runtimeSocketPath,
        record.request.agent_id,
      )
      await app.projectManagedAgent({
        agentId: record.request.agent_id,
        cwd: record.request.workspace.directory,
        fxPath: this.options.fxPath,
        fxArgs: existing?.fxArgs ?? null,
        workControl,
        createdAt: existing?.createdAt,
        focus: false,
      })
    }
    if (this.closed) return
    await this.coordinator.recover()
    for (const record of await this.retirementLedger.list()) {
      this.scheduleRetirement(record.ensure.request.ensure_id)
    }
    await this.coordinator.settled()
    await this.retirementSettled()
    await this.replayEnsureReceipts()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.workAbort.abort()
    this.coordinator.close()
    const recovery = this.recoveryOperation
    if (recovery !== null) await Promise.allSettled([recovery])
    // Active Companion effects retain their cancellation leases until their
    // exact durable boundary (or failure). Teardown must not return while one
    // of those leases can still release into a dismantled Runtime.
    await this.coordinator.settled()
    await Promise.allSettled([...this.retirementEffects.values()])
  }

  /** Startup reconciliation barrier. Nondefinitive managed removal fails closed. */
  async beforeRemove(removal: AgentRemoval): Promise<void | "preserve"> {
    const record = await this.ensureForAgent(removal.entry.agentId)
    if (record === null) return
    if (record.stage === "manifest_claimed") {
      if (!isManagedLifecycleRecord(record)) {
        const retired = await this.retirementLedger.get(record.request.ensure_id)
        if (await this.isProvenNeverStarted(retired, record)) {
          // Startup reconciliation owns final residue/Manifest removal. This
          // hook may run before the Multiplexer has projected the row.
          return
        }
      }
      if (!(removal.reason === "exited" && removal.session?.exit)) return "preserve"
    }
    if (removal.reason === "exited" && removal.session?.exit) {
      await this.finalize(record, finalEvidenceForSession(removal.session.exit, removal.session.detail))
    } else {
      await this.finalize(record, null)
    }
    if (!isManagedLifecycleRecord(record)) await this.awaitRetirement(record.request.ensure_id)
  }

  /** Live Multiplexer barrier. The supplied Exit is the definitive Companion observation. */
  async beforeDefinitiveAgentForget(
    entry: ManifestEntry,
    exit: AgentExit | null,
  ): Promise<void> {
    const record = await this.ensureForAgent(entry.agentId)
    if (record === null) return
    if (exit === null) {
      await this.finalize(record, null)
    } else {
      await this.finalize(record, {
        observedAt: this.now().toISOString(),
        outcome: exit.signal === 0
          ? { kind: "exited", code: exit.code }
          : { kind: "signalled", signal: exit.signal },
      })
    }
    if (!isManagedLifecycleRecord(record)) await this.awaitRetirement(record.request.ensure_id)
  }

  private coordinatorPorts(): LifecycleCoordinatorPorts {
    return {
      worktree: {
        create: async ({ request }) => {
          const transition = await this.worktreeCreator.create(request)
          return { directory: transition.directory, headCommit: transition.head_commit }
        },
      },
      manifest: {
        claim: async ({ request }) => {
          const app = this.requireMultiplexer()
          const existing = this.options.manifest.get(request.agent_id)
          const binding = existing?.workControl ?? mintFxWorkControlBinding(
            this.options.runtimeSocketPath,
            request.agent_id,
          )
          await app.projectManagedAgent({
            agentId: request.agent_id,
            cwd: request.planned_worktree.directory,
            fxPath: this.options.fxPath,
            // Provider arguments are built after the durable Manifest claim.
            fxArgs: null,
            workControl: binding,
          })
        },
        workControl: async (agentId) => this.requireWorkControl(agentId),
        protect: async (agentIds) => {
          for (const agentId of agentIds) {
            const entry = this.options.manifest.get(agentId)
            if (entry?.workControl === null) {
              throw new Error(`managed Agent ${agentId} lost its Work-control authority`)
            }
          }
        },
      },
      launch: {
        prepare: async ({ record, source, workControl }) => {
          const launchReceipt = await this.provider.prepare(source.launch_request)
          if (
            launchReceipt.request_id !== source.launch_request.request_id ||
            launchReceipt.launch_id !== source.launch_id ||
            launchReceipt.launch_digest !== source.launch_digest ||
            launchReceipt.admission_key !== source.admission_key ||
            launchReceipt.status !== "accepted"
          ) {
            throw new Error("Fx launch provider changed the exact launch receipt correlation")
          }
          const bytes = await this.sources.retrieve(sourceAuthority(source))
          const controls = parseInlineLaunchControls(bytes.launchControls)
          const build: FxLaunchProviderBuild = {
            stateRoot: source.launch_request.state_root,
            admissionKey: source.admission_key,
            launchDigest: source.launch_digest,
            launchId: source.launch_id,
            mode: "initial",
            remainingGlobalArgs: controls.remaining_global_args,
            remainingLaunchControlsDigest:
              source.launch_request.remaining_launch_controls_digest,
          }
          const invocation = await this.provider.build(build)
          if (invocation.mode !== build.mode) {
            throw new Error("Fx launch provider changed the exact recovery mode")
          }
          if (invocation.cwd !== record.request.planned_worktree.directory) {
            throw new Error("Fx launch provider changed the exact Worktree directory")
          }
          this.preparedConversations.set(record.request.ensure_id, invocation.conversationId)
          return {
            invocation: this.managedInvocation(record, source, workControl, invocation),
            conversationId: invocation.conversationId,
            finalReceiptAuthority: {
              admission_key: source.admission_key,
              state_root: source.launch_request.state_root,
            },
          }
        },
      },
      companion: {
        start: async ({ record, invocation }) => this.requireMultiplexer().startManagedAgent(
          record.request.agent_id,
          invocation as ManagedAgentInvocation,
        ),
      },
      workControl: {
        admitInitial: async ({ binding, text, source }) => {
          const conversationId = this.preparedConversations.get(source.ensure_id)
          if (conversationId === undefined) {
            throw new Error(`ensure ${source.ensure_id} has no prepared Fx Conversation`)
          }
          try {
            const admission = await this.workControl.request(
              binding,
              "work.queue",
              { text },
              this.workAbort.signal,
            )
            return { admission, conversationId }
          } catch (error) {
            if (
              error instanceof FxWorkControlError &&
              (error.code === "unavailable" || error.code === "timeout")
            ) return null
            throw error
          }
        },
      },
      admission: {
        import: async ({ record, delivered }) => this.importAdmission(record, delivered),
      },
      cancellation: {
        beginStart: (ensureId) => this.beginStart(ensureId),
      },
      retirement: {
        afterFinalReceipt: async (ensureId, receipt) => {
          await this.acknowledgeFinal(ensureId, receipt)
          this.scheduleRetirement(ensureId)
        },
        afterAdmissionCancellation: async (ensureId) => {
          this.scheduleRetirement(ensureId)
        },
        accept: (message) => this.acceptRetirement(message),
      },
      receipts: {
        ensure: async (record) => buildEnsureLifecycleReceipt(record),
        publish: (receipt) => this.publish(receipt),
      },
      managed: {
        existingDirectory: {
          validate: (request) => this.managedPort("existing_directory", () =>
            this.validateManagedDirectory(request)),
        },
        manifest: {
          claim: (request) => this.managedPort("manifest_claim", async () => {
            const existing = this.options.manifest.get(request.agent_id)
            const binding = existing?.workControl ?? mintFxWorkControlBinding(
              this.options.runtimeSocketPath,
              request.agent_id,
            )
            await this.requireMultiplexer().projectManagedAgent({
              agentId: request.agent_id,
              cwd: request.workspace.directory,
              fxPath: this.options.fxPath,
              fxArgs: null,
              workControl: binding,
            })
          }),
          workControl: async (agentId) => this.requireWorkControl(agentId),
          protect: async (agentIds) => {
            for (const agentId of agentIds) {
              const entry = this.options.manifest.get(agentId)
              if (entry?.workControl === null) {
                throw new Error(`managed Agent ${agentId} lost its Work-control authority`)
              }
            }
          },
        },
        launch: {
          prepare: ({ record, workControl }) => this.managedPort(
            "launch_provider",
            () => this.prepareManagedLaunch(record, workControl),
          ),
        },
        companion: {
          start: ({ record, invocation }) => this.managedPort(
            "companion_start",
            () => this.requireMultiplexer().startManagedAgent(
              record.request.agent_id,
              invocation as ManagedAgentInvocation,
            ),
          ),
        },
        workControl: {
          admitInitial: ({ binding, text, conversationId }) => this.managedPort(
            "fx_admission",
            async () => {
              try {
                const admission = await this.workControl.request(
                  binding,
                  "work.queue",
                  { text },
                  this.workAbort.signal,
                )
                return { admission, conversationId }
              } catch (error) {
                if (
                  error instanceof FxWorkControlError &&
                  (error.code === "unavailable" || error.code === "timeout")
                ) return null
                throw error
              }
            },
          ),
        },
        admission: {
          import: ({ record, delivered }) => this.managedPort(
            "fx_admission",
            () => this.importManagedAdmission(record, delivered),
          ),
        },
        classify: (error, record) => this.classifyManagedFailure(error, record),
        outcomes: {
          publish: (outcome) => this.publish(outcome),
        },
      },
      onError: (error, ensureId) => this.report(error, ensureId),
    }
  }

  private async validateManagedDirectory(request: ManagedLaunchRequest): Promise<{
    directory: string
    repository: string
    checkoutRoot: string
    headCommit: string
  }> {
    let directory: string
    try {
      directory = await realpath(request.workspace.directory)
    } catch (error) {
      throw new ManagedExistingDirectoryError("existing_directory_unavailable", error)
    }
    if (directory !== request.workspace.directory) {
      throw new ManagedExistingDirectoryError("git_identity_changed")
    }
    let context: Awaited<ReturnType<typeof readGitContext>>
    let headCommit: string
    try {
      context = await readGitContext(directory)
      headCommit = await readHeadCommit(directory)
    } catch (error) {
      throw new ManagedExistingDirectoryError("git_identity_changed", error)
    }
    if (
      context === null ||
      context.mainRoot !== request.workspace.repository ||
      context.root !== request.workspace.checkout_root ||
      headCommit !== request.workspace.head_commit
    ) {
      throw new ManagedExistingDirectoryError("git_identity_changed")
    }
    return {
      directory,
      repository: context.mainRoot,
      checkoutRoot: context.root,
      headCommit,
    }
  }

  private async prepareManagedLaunch(
    record: ManagedLaunchRecord,
    workControl: FxWorkControlBinding,
  ): Promise<{
    invocation: ManagedAgentInvocation
    conversationId: string
    finalReceiptAuthority: FxFinalReceiptAuthorityBinding
  }> {
    const request = record.request
    const source = request.source
    const launchReceipt = await this.provider.prepare(source.launch_request)
    if (
      launchReceipt.request_id !== source.launch_request.request_id ||
      launchReceipt.launch_id !== request.launch_id ||
      launchReceipt.launch_digest !== request.launch_digest ||
      launchReceipt.admission_key !== source.admission_key ||
      launchReceipt.status !== "accepted"
    ) {
      throw new Error("Fx launch provider changed the exact managed launch correlation")
    }
    if (
      source.launch_request.resume.mode === "exact" &&
      !managedProcessMayHaveStarted(record)
    ) {
      const resumeStatus = await this.provider.resumeStatus?.({
        stateRoot: source.launch_request.state_root,
        admissionKey: source.admission_key,
        launchDigest: request.launch_digest,
        launchId: request.launch_id,
      }) ?? (() => {
        throw new FxLaunchProviderError(
          "resume_status_unavailable",
          "Fx launch provider has no versioned resume-status authority",
        )
      })()
      if (resumeStatus.conversationId !== source.launch_request.resume.conversation_id) {
        throw new Error("Fx launch provider changed the exact managed resume Conversation")
      }
      if (
        resumeStatus.status === "unavailable" &&
        resumeStatus.semanticDecision === "exact_resume_unavailable"
      ) {
        throw new ManagedExactResumeUnavailable({
          ...resumeStatus,
          status: "unavailable",
          semanticDecision: "exact_resume_unavailable",
        })
      }
    }
    const bytes = managedLaunchSourceBytes(request)
    const controls = parseInlineLaunchControls(bytes.launchControls)
    const build: FxLaunchProviderBuild = {
      stateRoot: source.launch_request.state_root,
      admissionKey: source.admission_key,
      launchDigest: request.launch_digest,
      launchId: request.launch_id,
      mode: "initial",
      remainingGlobalArgs: controls.remaining_global_args,
      remainingLaunchControlsDigest:
        source.launch_request.remaining_launch_controls_digest,
    }
    const provider = await this.provider.build(build)
    if (provider.mode !== "initial") {
      throw new Error("Fx launch provider changed the exact managed recovery mode")
    }
    if (provider.cwd !== request.workspace.directory) {
      throw new Error("Fx launch provider changed the exact managed existing directory")
    }
    if (provider.conversationId !== request.fx_conversation.resume_conversation_id &&
      request.fx_conversation.resume_conversation_id !== null) {
      throw new Error("Fx launch provider changed the exact managed resume Conversation")
    }
    this.preparedConversations.set(request.ensure_id, provider.conversationId)
    return {
      invocation: this.managedLaunchInvocation(record, workControl, provider),
      conversationId: provider.conversationId,
      finalReceiptAuthority: {
        admission_key: source.admission_key,
        state_root: source.launch_request.state_root,
      },
    }
  }

  private managedLaunchInvocation(
    record: ManagedLaunchRecord,
    workControl: FxWorkControlBinding,
    provider: FxLaunchProviderInvocation,
  ): ManagedAgentInvocation {
    const request = record.request
    const entry = this.options.manifest.get(request.agent_id)
    if (entry === null) throw new Error(`managed Agent is not claimed: ${request.agent_id}`)
    const parent = { ...(this.options.environment ?? process.env) }
    delete parent.FX_MODEL
    delete parent.FX_EFFORT
    const model = request.source.launch_request.model ?? this.options.agentDefaults?.model
    const effort = request.source.launch_request.effort ?? this.options.agentDefaults?.effort
    if (
      request.source.launch_request.model !== undefined &&
      provider.env.FX_MODEL !== undefined &&
      provider.env.FX_MODEL !== request.source.launch_request.model
    ) {
      throw new Error("Fx launch provider changed the explicit managed model")
    }
    if (
      request.source.launch_request.effort !== undefined &&
      provider.env.FX_EFFORT !== undefined &&
      provider.env.FX_EFFORT !== request.source.launch_request.effort
    ) {
      throw new Error("Fx launch provider changed the explicit managed effort")
    }
    const base = createFxEnvironment(
      parent,
      entry.displayId,
      provider.cwd,
      this.options.runtimeSocketPath,
      model === undefined && effort === undefined ? null : { model, effort },
      this.adeBinding(request.agent_id),
      workControl,
    )
    const env = { ...base, ...provider.env }
    if (model !== undefined) env.FX_MODEL = model
    if (effort !== undefined) env.FX_EFFORT = effort
    return {
      command: [this.options.fxPath, ...provider.command],
      cwd: provider.cwd,
      env: stringEnvironment(env),
    }
  }

  private async importManagedAdmission(
    record: ManagedLaunchRecord,
    delivered: Readonly<{ admission: FxWorkControlResult; conversationId: string }> | null,
  ): Promise<LifecycleAdmissionOutcome> {
    const authority = await this.provider.inspect(managedCorrelationFor(record))
    if (authority.finalReceipt !== null) {
      return { kind: "final", receipt: exactFinalReceipt(authority.finalReceipt) }
    }
    const decision = authority.decision === null
      ? null
      : exactAdmissionDecision(authority.decision)
    if (decision === null) return { kind: "pending" }
    if (decision.decision.kind === "cancelled_before_start") {
      return { kind: "cancelled_before_start", decision: decision as CancelledFxAdmissionDecision }
    }
    return {
      kind: "admitted",
      decision: decision as AdmittedFxAdmissionDecision,
      conversationId: delivered?.conversationId ?? this.preparedManagedConversation(record),
    }
  }

  private async managedPort<T>(
    stage: ManagedLaunchStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ManagedRuntimePortError) throw error
      throw new ManagedRuntimePortError(stage, error)
    }
  }

  private classifyManagedFailure(
    thrown: unknown,
    record: ManagedLaunchRecord,
  ): ManagedLaunchFailure {
    const stage = thrown instanceof ManagedRuntimePortError
      ? thrown.stage
      : managedStageForRecord(record)
    const error = thrown instanceof ManagedRuntimePortError ? thrown.original : thrown
    if (stage === "existing_directory") {
      return {
        classification: "retryable",
        stage,
        cause: error instanceof ManagedExistingDirectoryError
          ? error.managedCause
          : "existing_directory_unavailable",
        processCertainty: "not_started",
        exactResumeProof: null,
      }
    }
    if (stage === "manifest_claim") {
      return {
        classification: "retryable",
        stage,
        cause: "manifest_claim_failed",
        processCertainty: "not_started",
        exactResumeProof: null,
      }
    }
    if (stage === "launch_provider") {
      // Provider v1 diagnostic names never become policy. Only the strict v2
      // semantic decision, while fmx still proves no process effect, can make
      // an exact-resume refusal permanent.
      if (error instanceof ManagedExactResumeUnavailable && !managedProcessMayHaveStarted(record)) {
        return {
          classification: "permanent",
          stage,
          cause: "exact_resume_refused",
          processCertainty: "not_started",
          exactResumeProof: {
            kind: "exact_resume_refused",
            authority: error.status.authority,
            semantic_decision: error.status.semanticDecision,
            status: error.status.status,
            decision_id: error.status.decisionId,
            decision_digest: error.status.decisionDigest,
            admission_key: error.status.admissionKey,
            conversation_id: error.status.conversationId,
            launch_digest: error.status.launchDigest,
            launch_id: error.status.launchId,
            state_root: error.status.stateRoot,
          },
        }
      }
      return {
        classification: "retryable",
        stage,
        cause: "launch_provider_unavailable",
        processCertainty: "not_started",
        exactResumeProof: null,
      }
    }
    if (stage === "companion_start") {
      return {
        classification: "uncertain",
        stage,
        cause: "companion_start_uncertain",
        processCertainty: "may_have_started",
        exactResumeProof: null,
      }
    }
    return {
      classification: error instanceof FxWorkControlError || error instanceof FxLaunchProviderError
        ? "retryable"
        : "uncertain",
      stage: "fx_admission",
      cause: error instanceof FxWorkControlError || error instanceof FxLaunchProviderError
        ? "fx_admission_unavailable"
        : "internal_failure",
      processCertainty: "started",
      exactResumeProof: null,
    }
  }

  private managedInvocation(
    record: EnsureLifecycleRecord,
    source: InlineLaunchSourceRequest,
    workControl: FxWorkControlBinding,
    provider: FxLaunchProviderInvocation,
  ): ManagedAgentInvocation {
    const entry = this.options.manifest.get(record.request.agent_id)
    if (entry === null) throw new Error(`managed Agent is not claimed: ${record.request.agent_id}`)
    const parent = { ...(this.options.environment ?? process.env) }
    // Ambient process overrides are not part of this managed launch. When
    // neither the frozen request nor the accepted Session defaults select a
    // field, leave it absent so Fx's own profile/default remains authoritative.
    delete parent.FX_MODEL
    delete parent.FX_EFFORT
    const model = source.launch_request.model ?? this.options.agentDefaults?.model
    const effort = source.launch_request.effort ?? this.options.agentDefaults?.effort
    if (
      source.launch_request.model !== undefined &&
      provider.env.FX_MODEL !== undefined &&
      provider.env.FX_MODEL !== source.launch_request.model
    ) {
      throw new Error("Fx launch provider changed the explicit model")
    }
    if (
      source.launch_request.effort !== undefined &&
      provider.env.FX_EFFORT !== undefined &&
      provider.env.FX_EFFORT !== source.launch_request.effort
    ) {
      throw new Error("Fx launch provider changed the explicit effort")
    }
    const base = createFxEnvironment(
      parent,
      entry.displayId,
      provider.cwd,
      this.options.runtimeSocketPath,
      model === undefined && effort === undefined ? null : { model, effort },
      this.adeBinding(record.request.agent_id),
      workControl,
    )
    const env = { ...base, ...provider.env }
    // Session defaults outrank any provider/profile value. Frozen explicit
    // values are checked above and likewise remain the final selected value.
    if (model !== undefined) env.FX_MODEL = model
    if (effort !== undefined) env.FX_EFFORT = effort
    return {
      command: [this.options.fxPath, ...provider.command],
      cwd: provider.cwd,
      env: stringEnvironment(env),
    }
  }

  private async importAdmission(
    record: EnsureLifecycleRecord,
    delivered: Readonly<{ admission: FxWorkControlResult; conversationId: string }> | null,
  ): Promise<LifecycleAdmissionOutcome> {
    const authority = await this.provider.inspect(correlationFor(record))
    if (authority.finalReceipt !== null) {
      return { kind: "final", receipt: exactFinalReceipt(authority.finalReceipt) }
    }
    const decision = authority.decision === null
      ? null
      : exactAdmissionDecision(authority.decision)
    if (decision === null) return { kind: "pending" }
    if (decision.decision.kind === "cancelled_before_start") {
      return { kind: "cancelled_before_start", decision: decision as CancelledFxAdmissionDecision }
    }
    return {
      kind: "admitted",
      decision: decision as AdmittedFxAdmissionDecision,
      conversationId: delivered?.conversationId ?? this.preparedConversation(record.request.ensure_id),
    }
  }

  private async beginStart(ensureId: string): Promise<
    | { kind: "start"; lease: { release(): void } }
    | { kind: "cancelled_before_start"; decision: CancelledFxAdmissionDecision }
  > {
    const lease = await this.acquireEffectGate(ensureId)
    try {
      const record = await this.requireEnsure(ensureId)
      const retired = await this.retirementLedger.get(ensureId)
      if (retired?.end?.request.reason === "cancelled_before_start") {
        const authority = await this.cancelBeforeStart(record, retired.end.request)
        if (authority.decision?.decision.kind === "cancelled_before_start") {
          const decision = exactAdmissionDecision(authority.decision)
          await this.ensureLedger.retainFxAdmissionDecision(ensureId, decision)
          lease.release()
          return {
            kind: "cancelled_before_start",
            decision: decision as CancelledFxAdmissionDecision,
          }
        }
        if (authority.finalReceipt !== null) {
          await this.coordinator.retainFinalReceipt(
            ensureId,
            exactFinalReceipt(authority.finalReceipt),
          )
          throw new Error(`ensure ${ensureId} finalized before its Companion start`)
        }
      }
      const inspected = await this.provider.inspect(correlationFor(record))
      if (inspected.decision?.decision.kind === "cancelled_before_start") {
        const decision = exactAdmissionDecision(inspected.decision)
        await this.ensureLedger.retainFxAdmissionDecision(ensureId, decision)
        lease.release()
        return {
          kind: "cancelled_before_start",
          decision: decision as CancelledFxAdmissionDecision,
        }
      }
      if (inspected.finalReceipt !== null) {
        await this.coordinator.retainFinalReceipt(
          ensureId,
          exactFinalReceipt(inspected.finalReceipt),
        )
        throw new Error(`ensure ${ensureId} finalized before its Companion start`)
      }
      return { kind: "start", lease }
    } catch (error) {
      lease.release()
      throw error
    }
  }

  private async acceptRetirement(
    message: Exclude<RuntimeExtensionLifecycleInbound, { message_type: "ensure_request" }>,
  ): Promise<void> {
    if (message.message_type === "receipt_acknowledgement") {
      const record = await this.retirement.acknowledge(message as RetirementReceiptAcknowledgement)
      if (message.receipt_kind === "end") {
        await this.removeNeverStartedProjection(record)
      }
      return
    }
    const ensure = await this.requireEnsure(message.ensure_id)
    await this.retirementLedger.bindEnsure(ensure)
    if (message.message_type === "end_request") {
      await this.retirementLedger.beginEnd(message as EndRequest)
    } else {
      await this.retirementLedger.beginCleanup(message as CleanupRequest)
    }
    this.scheduleRetirement(message.ensure_id)
  }

  /**
   * Forget a cancelled-before-start claim only after both exact authorities
   * have committed: Fx's negative admission winner and the acknowledged
   * never-started end receipt. Any uncertainty leaves the durable claim for
   * the next recovery pass.
   */
  private async removeNeverStartedProjection(
    retirementRecord: Awaited<ReturnType<ExactRetirementLedger["get"]>>,
  ): Promise<void> {
    if (retirementRecord === null || !(await this.isProvenNeverStarted(retirementRecord))) return
    const ensure = await this.ensureLedger.get(retirementRecord.ensure.request.ensure_id)
    if (ensure === null || ensure.stage !== "manifest_claimed") return

    await this.withEffectGate(ensure.request.ensure_id, async () => {
      const current = await this.ensureLedger.get(ensure.request.ensure_id)
      if (current === null || current.stage !== "manifest_claimed") return
      const entry = this.options.manifest.get(current.request.agent_id)
      if (entry === null) return
      const app = this.requireMultiplexer()
      await app.removeManagedAgentProjection(entry.agentId)
      await removeFxWorkControlResidue(entry.workControl, this.options.runtimeSocketPath)
      await this.options.manifest.remove(entry.agentId)
      app.refreshManagedAgentProjection(entry.agentId)
    })
  }

  private async isProvenNeverStarted(
    retirementRecord: Awaited<ReturnType<ExactRetirementLedger["get"]>>,
    expectedEnsure?: EnsureLifecycleRecord,
  ): Promise<boolean> {
    if (retirementRecord === null || retirementRecord.end === null) return false
    const receipt = retirementRecord.end.receipt
    const acknowledgement = retirementRecord.end.acknowledgement
    if (
      receipt === null || acknowledgement === null ||
      retirementRecord.end.request.reason !== "cancelled_before_start" ||
      receipt.proof.kind !== "never_started" ||
      acknowledgement.receipt_kind !== "end" ||
      acknowledgement.receipt_id !== receipt.receipt_id ||
      acknowledgement.receipt_digest !== receipt.receipt_digest
    ) return false

    const ensure = expectedEnsure ?? await this.ensureLedger.get(retirementRecord.ensure.request.ensure_id)
    if (ensure === null || ensure.stage !== "manifest_claimed") return false
    const decision = ensure.fx_admission_decision
    if (
      decision?.decision.kind !== "cancelled_before_start" ||
      decision.receipt_id !== receipt.proof.admission_receipt_id ||
      decision.receipt_digest !== receipt.proof.admission_receipt_digest
    ) return false
    const expectedCancellation = cancellationRequest(ensure, retirementRecord.end.request)
    if (
      decision.decision.cancellation_request_id !== expectedCancellation.request_id ||
      receipt.proof.cancellation_request_id !== expectedCancellation.request_id
    ) return false
    return true
  }

  private scheduleRetirement(ensureId: string): void {
    if (this.closed) return
    this.retirementDirty.add(ensureId)
    if (this.retirementEffects.has(ensureId)) return
    const operation = (async () => {
      while (!this.closed && this.retirementDirty.delete(ensureId)) {
        await this.drainRetirement(ensureId)
      }
    })()
    this.retirementEffects.set(ensureId, operation)
    // Scheduled recovery remains best-effort, while direct barriers await the
    // same operation and receive its failure.
    void operation.catch((error) => this.report(error, ensureId)).finally(() => {
      if (this.retirementEffects.get(ensureId) === operation) {
        this.retirementEffects.delete(ensureId)
      }
      if (this.retirementDirty.has(ensureId)) this.scheduleRetirement(ensureId)
    }).catch(() => {})
  }

  private async awaitRetirement(ensureId: string): Promise<void> {
    this.scheduleRetirement(ensureId)
    const operation = this.retirementEffects.get(ensureId)
    if (operation !== undefined) await operation
  }

  private async drainRetirement(ensureId: string): Promise<void> {
    const record = await this.retirementLedger.get(ensureId)
    if (record === null) return
    const ensure = await this.requireEnsure(ensureId)
    const retirementEnsure: EnsureLifecycleRecord = {
      ...ensure,
      request: structuredClone(record.ensure.request),
      stage: record.ensure.stage,
      effects: structuredClone(record.ensure.effects),
    }
    if (record.end !== null) {
      let endReceipt = record.end.receipt
      if (endReceipt === null) {
        if (record.end.request.reason === "cancelled_before_start") {
          // The end request may deliberately arrive before its inline source
          // admits the ensure. It is already durable; provider cancellation
          // waits until launch preparation has bound the exact authority.
          if (ensure.fx_final.binding === null) return
          // A start lease is held through Companion start and the durable
          // companion_started transition. Once that boundary exists, a late
          // cancellation request can no longer be reclassified as proof that
          // no process was started; preserving it pending is the fail-closed
          // result for this impossible/late frozen request.
          if (ensure.stage === "companion_started" || ensure.stage === "fx_started") return
          const cancelled = await this.withEffectGate(ensureId, async () => {
            const afterLease = await this.requireEnsure(ensureId)
            if (
              afterLease.stage === "companion_started" ||
              afterLease.stage === "fx_started"
            ) return false
            await this.cancelBeforeStart(afterLease, record.end!.request)
            return true
          })
          if (!cancelled) return
        }
        endReceipt = await this.retirement.end(
          retirementEnsure,
          record.end.request,
          { prove: (request) => this.neverStartedProof(ensure, request) },
        )
      }
      if (endReceipt !== null && record.end.acknowledgement === null) {
        await this.publish(endReceipt)
      }
    }
    const current = await this.retirementLedger.get(ensureId)
    if (current?.cleanup !== null && current?.cleanup !== undefined) {
      let cleanupReceipt = current.cleanup.receipt
      if (cleanupReceipt === null) {
        cleanupReceipt = await this.cleanup.cleanup(retirementEnsure, current.cleanup.request)
      }
      if (current.cleanup.acknowledgement === null) await this.publish(cleanupReceipt)
    }
  }

  private async cancelBeforeStart(
    record: EnsureLifecycleRecord,
    request: EndRequest,
  ): Promise<FxLaunchProviderFinalAuthority> {
    const binding = requireFinalBinding(record)
    return this.provider.cancel(binding.state_root, cancellationRequest(record, request))
  }

  private async neverStartedProof(
    record: EnsureLifecycleRecord,
    request: EndRequest,
  ): Promise<NeverStartedProof | null> {
    const current = await this.requireEnsure(record.request.ensure_id)
    const decision = current.fx_admission_decision
    if (decision?.decision.kind !== "cancelled_before_start") return null
    const expected = cancellationRequest(current, request)
    if (decision.decision.cancellation_request_id !== expected.request_id) return null
    const identity = identityFor(current.request.agent_id)
    return {
      kind: "never_started",
      authority: "companion_reconciliation",
      companion_session: identity.zmxName,
      pane_id: identity.paneId,
      admission_receipt_id: decision.receipt_id,
      admission_receipt_digest: decision.receipt_digest,
      cancellation_request_id: decision.decision.cancellation_request_id,
      observed_at: this.now().toISOString(),
    }
  }

  private async finalize(
    record: LifecycleLedgerRecord,
    evidence: { observedAt: string; outcome: FxLaunchProviderFinalOutcome } | null,
  ): Promise<void> {
    const current = isManagedLifecycleRecord(record)
      ? await this.requireManagedEnsure(record.request.ensure_id)
      : await this.requireEnsure(record.request.ensure_id)
    if (current.fx_final.acknowledgement_applied) {
      if (isManagedLifecycleRecord(current)) {
        await this.publishManagedTerminal(current)
      }
      return
    }
    const correlation = isManagedLifecycleRecord(current)
      ? managedCorrelationFor(current)
      : correlationFor(current)
    let authority: FxLaunchProviderFinalAuthority
    if (evidence !== null) {
      authority = await this.provider.recordFinal(
        correlation,
        evidence.observedAt,
        evidence.outcome,
      )
    } else {
      authority = await this.provider.inspect(correlation)
    }
    if (authority.finalReceipt !== null) {
      const receipt = exactFinalReceipt(authority.finalReceipt)
      if (isManagedLifecycleRecord(current)) {
        await this.coordinator.retainManagedFinalReceipt(current.request.ensure_id, receipt)
        await this.acknowledgeManagedFinal(current.request.ensure_id, receipt)
      } else {
        await this.coordinator.retainFinalReceipt(current.request.ensure_id, receipt)
      }
      const retained = isManagedLifecycleRecord(current)
        ? await this.requireManagedEnsure(current.request.ensure_id)
        : await this.requireEnsure(current.request.ensure_id)
      if (!retained.fx_final.acknowledgement_applied) {
        throw new Error(`Fx final receipt for ensure ${current.request.ensure_id} is not acknowledged`)
      }
      if (isManagedLifecycleRecord(retained)) {
        await this.publishManagedTerminal(retained)
      }
      return
    }
    if (authority.decision?.decision.kind === "cancelled_before_start") {
      const decision = exactAdmissionDecision(authority.decision)
      if (isManagedLifecycleRecord(current)) {
        await this.ensureLedger.retainManagedFxAdmissionDecision(current.request.ensure_id, decision)
      } else {
        await this.ensureLedger.retainFxAdmissionDecision(current.request.ensure_id, decision)
      }
      return
    }
    throw new Error(
      `managed Agent ${current.request.agent_id} has no definitive Fx final or negative decision`,
    )
  }

  private async acknowledgeFinal(ensureId: string, receipt: FxFinalReceipt): Promise<void> {
    const acknowledgement = finalAcknowledgement(receipt)
    await this.coordinator.acknowledgeFinalReceipt(ensureId, acknowledgement, {
      acknowledge: async (binding, value) => {
        const result = await this.provider.acknowledgeFinal(binding.state_root, value)
        if (result.finalAcknowledgementId !== value.acknowledgement_id) {
          throw new Error("Fx launch provider did not apply the exact final acknowledgement")
        }
      },
    })
  }

  private async acknowledgeManagedFinal(ensureId: string, receipt: FxFinalReceipt): Promise<void> {
    const acknowledgement = finalAcknowledgement(receipt)
    await this.coordinator.acknowledgeManagedFinalReceipt(ensureId, acknowledgement, {
      acknowledge: async (binding, value) => {
        const result = await this.provider.acknowledgeFinal(binding.state_root, value)
        if (result.finalAcknowledgementId !== value.acknowledgement_id) {
          throw new Error("Fx launch provider did not apply the exact final acknowledgement")
        }
      },
    })
  }

  private async publishManagedTerminal(record: ManagedLaunchRecord): Promise<void> {
    const finalReceipt = record.fx_final.receipt
    if (finalReceipt === null || !record.fx_final.acknowledgement_applied) {
      throw new Error(
        `managed launch ${record.request.ensure_id} has no acknowledged Fx final receipt`,
      )
    }
    const retained = await this.coordinator.retainManagedTerminalReceipt(
      record.request.ensure_id,
      managedTerminalReceipt(record, finalReceipt),
    )
    if (
      retained.terminal.receipt !== null &&
      retained.terminal.acknowledgement === null
    ) {
      await this.publish(retained.terminal.receipt)
    }
  }

  private async publish(
    receipt:
      | RuntimeExtensionLifecycleReceipt
      | EndReceipt
      | CleanupReceipt
      | ManagedLaunchOutcome
      | ManagedLaunchTerminalReceipt,
  ): Promise<void> {
    if (this.closed) return
    const publish = this.receiptPublisher
    // Durable ledgers retain unacknowledged receipts. Startup may finish a
    // background effect before the host binds its publisher; leave that
    // receipt pending for the next recovery/replay pass.
    if (publish === null) return
    await publish(
      receipt as
        | RuntimeExtensionLifecycleReceipt
        | ManagedLaunchOutcome
        | ManagedLaunchTerminalReceipt,
    )
  }

  private async replayEnsureReceipts(): Promise<void> {
    const publish = this.receiptPublisher
    if (publish === null || this.closed) return
    for (const record of await this.ensureLedger.list()) {
      const current = buildEnsureLifecycleReceipt(record)
      if (current !== null) await this.ensureLedger.retainEnsureReceipt(current)
      const refreshed = await this.ensureLedger.get(record.request.ensure_id)
      if (refreshed === null) continue
      for (const receipt of refreshed.receipts) {
        if (refreshed.acknowledgements.some((acknowledgement) =>
          acknowledgement.receipt_id === receipt.receipt_id &&
          acknowledgement.receipt_digest === receipt.receipt_digest
        )) continue
        await publish(receipt as RuntimeExtensionLifecycleReceipt)
      }
    }
    for (const record of await this.ensureLedger.listManaged()) {
      if (
        record.fx_final.receipt !== null &&
        record.fx_final.acknowledgement_applied &&
        record.terminal.acknowledgement === null
      ) {
        await this.publishManagedTerminal(record)
      }
    }
  }

  private async retirementSettled(): Promise<void> {
    while (this.retirementEffects.size > 0) {
      await Promise.allSettled([...this.retirementEffects.values()])
    }
  }

  private async ensureForAgent(agentId: string): Promise<LifecycleLedgerRecord | null> {
    const matches = (await this.ensureLedger.listAll()).filter(
      (record) => record.request.agent_id === agentId,
    )
    if (matches.length > 1) throw new Error(`Agent ${agentId} has multiple lifecycle ensures`)
    return matches[0] ?? null
  }

  private async requireEnsure(ensureId: string): Promise<EnsureLifecycleRecord> {
    const record = await this.ensureLedger.get(ensureId)
    if (record === null) throw new Error(`unknown lifecycle ensure: ${ensureId}`)
    return record
  }

  private async requireManagedEnsure(ensureId: string): Promise<ManagedLaunchRecord> {
    const record = await this.ensureLedger.getManaged(ensureId)
    if (record === null) throw new Error(`unknown managed lifecycle ensure: ${ensureId}`)
    return record
  }

  private requireWorkControl(agentId: string): FxWorkControlBinding {
    const binding = this.options.manifest.get(agentId)?.workControl
    if (binding === undefined || binding === null) {
      throw new Error(`managed Agent ${agentId} has no durable Work-control authority`)
    }
    return binding
  }

  private requireMultiplexer(): LifecycleRuntimeMultiplexer {
    if (this.multiplexer === null) throw new Error("lifecycle Runtime has no bound Multiplexer")
    return this.multiplexer
  }

  private preparedConversation(ensureId: string): string {
    const value = this.preparedConversations.get(ensureId)
    if (value === undefined) throw new Error(`ensure ${ensureId} has no prepared Fx Conversation`)
    return value
  }

  private preparedManagedConversation(record: ManagedLaunchRecord): string {
    return record.prepared_conversation_id ?? this.preparedConversation(record.request.ensure_id)
  }

  private adeBinding(agentId: string): FxAdeBinding | null {
    const binding = this.options.adeBinding
    if (typeof binding === "function") return binding(agentId)
    if (binding === null) return null
    return { socketPath: binding.socketPath, instanceId: agentId }
  }

  private withEffectGate<T>(ensureId: string, operation: () => Promise<T>): Promise<T> {
    return this.acquireEffectGate(ensureId).then(async (lease) => {
      try {
        return await operation()
      } finally {
        lease.release()
      }
    })
  }

  private async acquireEffectGate(ensureId: string): Promise<{ release(): void }> {
    const previous = this.effectGates.get(ensureId) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => held)
    this.effectGates.set(ensureId, tail)
    await previous
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        release()
        if (this.effectGates.get(ensureId) === tail) this.effectGates.delete(ensureId)
      },
    }
  }

  private assertSession(message: unknown): void {
    if (
      typeof message === "object" &&
      message !== null &&
      "fmx_session" in message &&
      typeof message.fmx_session === "string" &&
      message.fmx_session !== this.options.fmxSession
    ) {
      throw new Error(`lifecycle message belongs to another fmx Session: ${message.fmx_session}`)
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("lifecycle Runtime is closed")
  }

  private report(error: unknown, correlation: string): void {
    try {
      this.options.onError?.(error, correlation)
    } catch {
      // Diagnostics never change durable lifecycle state.
    }
  }

  private now(): Date {
    const value = this.options.now?.() ?? new Date()
    if (Number.isNaN(value.valueOf())) throw new Error("lifecycle clock returned an invalid date")
    return value
  }
}

function correlationFor(record: EnsureLifecycleRecord) {
  const binding = requireFinalBinding(record)
  return {
    stateRoot: binding.state_root,
    admissionKey: binding.admission_key,
    launchDigest: record.request.launch_digest,
    launchId: record.request.launch_id,
  }
}

function isManagedLifecycleRecord(
  record: LifecycleLedgerRecord,
): record is ManagedLaunchRecord {
  return "workspace" in record.request
}

function managedCorrelationFor(record: ManagedLaunchRecord) {
  const binding = record.fx_final.binding
  if (binding === null) {
    throw new Error(`managed launch ${record.request.ensure_id} has no Fx final authority`)
  }
  return {
    stateRoot: binding.state_root,
    admissionKey: binding.admission_key,
    launchDigest: record.request.launch_digest,
    launchId: record.request.launch_id,
  }
}

function managedStageForRecord(record: ManagedLaunchRecord): ManagedLaunchStage {
  switch (record.stage) {
    case "claimed":
      return "existing_directory"
    case "directory_validated":
      return "manifest_claim"
    case "manifest_claimed":
      return "launch_provider"
    case "companion_started":
    case "fx_started":
      return "fx_admission"
  }
}

function managedProcessMayHaveStarted(record: ManagedLaunchRecord): boolean {
  return record.stage === "companion_started" || record.stage === "fx_started" ||
    record.outcome_history.some(({ receipt }) =>
      receipt.process_certainty === "may_have_started" ||
      receipt.process_certainty === "started"
    )
}

function requireFinalBinding(record: EnsureLifecycleRecord) {
  const binding = record.fx_final.binding
  if (binding === null) throw new Error(`ensure ${record.request.ensure_id} has no Fx final authority`)
  return binding
}

function sourceAuthority(source: InlineLaunchSourceRequest) {
  return {
    workplace_instance_id: source.workplace_instance_id,
    fmx_session: source.fmx_session,
    ensure_id: source.ensure_id,
    ensure_digest: source.ensure_digest,
    worktree_id: source.worktree_id,
    agent_id: source.agent_id,
    launch_id: source.launch_id,
    launch_digest: source.launch_digest,
    admission_key: source.admission_key,
    source_id: source.source_id,
    source_digest: source.source_digest,
  }
}

function cancellationRequest(
  record: EnsureLifecycleRecord,
  request: EndRequest,
): FxAdmissionCancelRequest {
  return {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "admission_cancel_request",
    request_id: deterministicId("fmx-cancel", request),
    launch_id: record.request.launch_id,
    launch_digest: record.request.launch_digest,
    admission_key: requireFinalBinding(record).admission_key,
  } as FxAdmissionCancelRequest
}

function exactAdmissionDecision(
  decision: NonNullable<FxLaunchProviderFinalAuthority["decision"]>,
): FxAdmissionDecision {
  return {
    ...structuredClone(decision),
    message_type: "admission_decision",
  } as FxAdmissionDecision
}

function exactFinalReceipt(
  receipt: NonNullable<FxLaunchProviderFinalAuthority["finalReceipt"]>,
): FxFinalReceipt {
  return {
    ...structuredClone(receipt),
    message_type: "final_receipt",
  } as FxFinalReceipt
}

function managedTerminalReceipt(
  record: ManagedLaunchRecord,
  fxFinalReceipt: FxFinalReceipt,
): ManagedLaunchTerminalReceipt {
  const receipt = {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "terminal_receipt",
    receipt_id: "pending-terminal-receipt",
    receipt_digest: "0".repeat(64),
    workplace_instance_id: record.request.workplace_instance_id,
    fmx_session: record.request.fmx_session,
    ensure_id: record.request.ensure_id,
    ensure_digest: record.request.ensure_digest,
    launch_id: record.request.launch_id,
    launch_digest: record.request.launch_digest,
    agent_id: record.request.agent_id,
    attempt: record.attempt,
    fx_final_receipt: structuredClone(fxFinalReceipt),
    retained_until_acknowledged: true,
  } as ManagedLaunchTerminalReceipt
  receipt.receipt_id = deriveManagedLaunchTerminalReceiptId(receipt)
  receipt.receipt_digest = deriveManagedLaunchTerminalReceiptDigest(receipt)
  return receipt
}

function finalAcknowledgement(receipt: FxFinalReceipt): FxFinalReceiptAcknowledgement {
  return {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "final_receipt_acknowledgement",
    acknowledgement_id: deterministicId("fmx-final-ack", receipt),
    receipt_id: receipt.receipt_id,
    receipt_digest: receipt.receipt_digest,
    launch_id: receipt.launch_id,
    launch_digest: receipt.launch_digest,
    admission_key: receipt.admission_key,
    conversation_id: receipt.conversation_id,
  }
}

function finalEvidenceForSession(
  exit: NonNullable<Awaited<ReturnType<CompanionCommand["list"]>>[number]["exit"]>,
  detail: string | null,
): { observedAt: string; outcome: FxLaunchProviderFinalOutcome } {
  const observedAt = new Date(exit.endedAt * 1_000)
  if (!Number.isSafeInteger(exit.endedAt) || exit.endedAt <= 0 || Number.isNaN(observedAt.valueOf())) {
    throw new Error("Companion finalization supplied an invalid exit observation time")
  }
  if (exit.reason === "exec_failure") {
    return {
      observedAt: observedAt.toISOString(),
      outcome: { kind: "exec_failed", message: boundedExecFailure(detail) },
    }
  }
  if (exit.signal !== 0) {
    return { observedAt: observedAt.toISOString(), outcome: { kind: "signalled", signal: exit.signal } }
  }
  return { observedAt: observedAt.toISOString(), outcome: { kind: "exited", code: exit.code } }
}

function boundedExecFailure(detail: string | null): string {
  const normalized = (detail ?? "Fx executable failed to start")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .trim() || "Fx executable failed to start"
  let result = ""
  for (const character of normalized) {
    if (Buffer.byteLength(result + character) > 1024) break
    result += character
  }
  return result
}

function deterministicId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256")
    .update(encodeCanonicalJson(value as JsonValue))
    .digest("hex")}`
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

class ManagedRuntimePortError extends Error {
  constructor(
    readonly stage: ManagedLaunchStage,
    readonly original: unknown,
  ) {
    super(`managed launch failed during ${stage}`)
    this.name = "ManagedRuntimePortError"
  }
}

class ManagedExistingDirectoryError extends Error {
  constructor(
    readonly managedCause: Extract<
      ManagedLaunchCause,
      "existing_directory_unavailable" | "git_identity_changed"
    >,
    options?: unknown,
  ) {
    super(`managed existing-directory validation failed: ${managedCause}`)
    this.name = "ManagedExistingDirectoryError"
    if (options !== undefined) this.cause = options
  }
}

class ManagedExactResumeUnavailable extends Error {
  constructor(readonly status: FxLaunchProviderResumeStatus & {
    status: "unavailable"
    semanticDecision: "exact_resume_unavailable"
  }) {
    super("Fx semantic authority reports the exact resume Conversation unavailable")
    this.name = "ManagedExactResumeUnavailable"
  }
}
