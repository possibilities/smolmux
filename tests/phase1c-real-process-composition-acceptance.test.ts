import { createHash } from "node:crypto"
import { access, constants, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { expect, test } from "bun:test"
import fxPin from "../fx.json" with { type: "json" }
import { AgentManifest, identityFor, type ManifestEntry } from "../src/agent-manifest.ts"
import type { AgentExit, AgentTransport } from "../src/agent-transport.ts"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  ENSURE_LIFECYCLE_SCHEMA_ID,
  type EnsureLifecycleMessage,
} from "../src/agentworkplace-contracts.ts"
import { CompanionTransportFactory } from "../src/companion-transport.ts"
import {
  deriveCleanupDigest,
  deriveEndDigest,
  deriveLifecycleReceiptDigest,
  type CleanupPrepare,
  type CleanupReceipt,
  type CleanupRequest,
  type EndReceipt,
  type EndRequest,
} from "../src/exact-retirement-ledger.ts"
import {
  GitSafeWorktreeAuthority,
  spawnPreparedRemovalOperation,
} from "../src/git-safe-worktree-cleanup.ts"
import {
  deriveEnsureDigest,
  deriveFxFinalReceiptDigest,
  EnsureLifecycleLedger,
  type EnsureLifecycleRecord,
  type EnsureRequest,
} from "../src/ensure-lifecycle-ledger.ts"
import { FxLaunchProviderClient } from "../src/fx-launch-provider.ts"
import {
  FxWorkControlClient,
  removeFxWorkControlResidue,
} from "../src/fx-work-control.ts"
import {
  deriveFrozenLaunchDigest,
  deriveInlineLaunchSourceDigest,
  encodeInlineLaunchControls,
  encodeInlineSourceBytes,
  parseInlineLaunchSourceRequest,
  type FrozenLaunchRequest,
  type InlineLaunchSourceRequest,
} from "../src/inline-launch-source.ts"
import {
  LifecycleRuntime,
  type LifecycleRuntimeMultiplexer,
  type LifecycleRuntimeOptions,
} from "../src/lifecycle-runtime.ts"
import type { RuntimeExtensionLifecycleInbound } from "../src/runtime-extension.ts"
import type {
  ManagedAgentClaim,
  ManagedAgentInvocation,
  ManagedAgentStartResult,
} from "../src/multiplexer.ts"
import { ensurePrivateDirectories } from "../src/private-directory.ts"
import { CompanionCommand } from "../src/zmx-command.ts"
import { COMPANION_PIN, companionBuild, ensureCompanionDirectories } from "../src/zmx-environment.ts"

const ENABLED = process.env.FMX_RUN_PHASE1C_REAL_PROCESS === "1"
const SKIP_CONTRACT =
  "Phase 1C composition-level production seams use installed fmx-fx and Companion (run scripts/phase1c-real-process-composition-acceptance.sh after install)"
const AGENT_ID = "d".repeat(32)
const FMX_SESSION = "phase1c-real-session"
const HOME_ID = "phase1c-real-home"
const WAIT_MS = 30_000

type EnsureReceipt = Extract<EnsureLifecycleMessage, { effects: unknown }>
type ReceiptAcknowledgement = Extract<
  RuntimeExtensionLifecycleInbound,
  { message_type: "receipt_acknowledgement" }
>
type LifecycleReceipt = EnsureReceipt | EndReceipt | CleanupReceipt

test.skipIf(!ENABLED)(SKIP_CONTRACT, async () => {
  const scratch = await requiredDirectory("FMX_PHASE1C_SCRATCH_ROOT")
  const root = await requiredRunRoot("FMX_PHASE1C_RUN_ROOT", scratch)
  const fxPath = await requiredExecutable("FMX_FX_PATH")
  const zmxPath = await requiredExecutable("FMX_ZMX_PATH")
  await verifyInstalledFx(fxPath)

  const repository = join(root, "r")
  const worktree = join(root, "w")
  const stateRoot = join(root, "s")
  const home = join(root, "h")
  const ambientHome = join(root, "u")
  const providerRuntime = join(root, "p")
  const companionDirectory = join(root, "z")
  const runtimeSocketPath = join(root, "b.bus")
  const errors: unknown[] = []
  let gateway: ReturnType<typeof boundedGateway> | null = null
  let first: RuntimeComposition | null = null
  let second: RuntimeComposition | null = null

  try {
    await Promise.all([
      mkdir(join(root, "worktrees"), { recursive: true, mode: 0o700 }),
      mkdir(join(stateRoot, ".fx"), { recursive: true, mode: 0o700 }),
      mkdir(ambientHome, { recursive: true, mode: 0o700 }),
      ensurePrivateDirectories([providerRuntime], "Phase 1C launch provider"),
      ensureCompanionDirectories([companionDirectory]),
    ])
    expect(await companionBuild(zmxPath, process.env, companionDirectory)).toBe(COMPANION_PIN.build)
    await writeFile(join(stateRoot, ".fx", "settings.json"), `${JSON.stringify({
      sandbox: "none",
      permission_mode: "auto",
      permission: {},
      session_naming: { gateway: null, codex: null, grok: null },
    })}\n`, { mode: 0o600 })

    const baseCommit = await initializeRepository(repository)
    gateway = boundedGateway()
    if (gateway.port === undefined) throw new Error("bounded gateway has no listening port")
    const environment = realFxEnvironment(ambientHome, gateway.port)
    const fixture = lifecycleMessages({ repository, worktree, stateRoot, baseCommit })

    // No receipt publisher is bound in the first Runtime. The real provider,
    // Companion transport, Fx Work-control endpoint, and Fx process still
    // cross every durable boundary, leaving the complete receipt for replay.
    first = await openComposition({
      home,
      fxPath,
      zmxPath,
      providerRuntime,
      companionDirectory,
      runtimeSocketPath,
      environment,
      errors,
    })
    await first.runtime.acceptLifecycle(fixture.ensure)
    await first.runtime.acceptInlineSource(fixture.source)
    await waitFor(async () => {
      const record = await first!.runtimeRecord(fixture.ensure.ensure_id)
      return record?.stage === "fx_started" && completeReceipt(record) !== null
    }, "one real Fx launch and complete ensure receipt", errors)

    const firstRecord = (await first.runtimeRecord(fixture.ensure.ensure_id))!
    const firstReceipt = completeReceipt(firstRecord)!
    const firstSession = await exactLiveSession(first.companion, AGENT_ID)
    const firstPid = firstSession.pid
    expect(firstPid).toBeInteger()
    await waitFor(() => gateway!.completionRequests === 1, "one model request for the initial Turn", errors)

    const providerAuthority = await first.provider.inspect(correlationFor(firstRecord))
    expect(providerAuthority.decision?.decision.kind).toBe("admitted")
    const turnId = providerAuthority.decision?.decision.kind === "admitted"
      ? providerAuthority.decision.decision.turn_id
      : null
    expect(turnId).toMatch(/^[1-9]\d*$/)
    const binding = first.manifest.get(AGENT_ID)?.workControl
    if (binding === null || binding === undefined) throw new Error("real Fx lost its Work-control binding")
    const workControlSocketPath = binding.socketPath
    const snapshot = await new FxWorkControlClient().request(
      binding,
      "work.snapshot",
      {},
      new AbortController().signal,
    )
    const observedTurns = [
      ...(snapshot.snapshot.active_turn_id === null ? [] : [snapshot.snapshot.active_turn_id]),
      ...snapshot.snapshot.queue.map(({ turn_id }) => turn_id),
    ]
    expect(observedTurns).toEqual([turnId!])

    // Detaching is a lost-output Runtime restart, not an Fx stop. A fresh
    // Runtime attaches to the same Companion pid and replays the same exact
    // durable receipt without re-launching Fx or re-admitting initial work.
    await first.runtime.close()
    await first.multiplexer.close()
    first = null

    const replayed: LifecycleReceipt[] = []
    second = await openComposition({
      home,
      fxPath,
      zmxPath,
      providerRuntime,
      companionDirectory,
      runtimeSocketPath,
      environment,
      errors,
      receipts: replayed,
      restore: true,
    })
    await second.runtime.recover()
    await waitFor(() => replayed.some(isCompleteEnsureReceipt), "lost ensure receipt replay", errors)
    const replay = replayed.find(isCompleteEnsureReceipt)!
    expect({ id: replay.receipt_id, digest: replay.receipt_digest }).toEqual({
      id: firstReceipt.receipt_id,
      digest: firstReceipt.receipt_digest,
    })
    const resumedSession = await exactLiveSession(second.companion, AGENT_ID)
    expect(resumedSession.pid).toBe(firstPid)
    expect(gateway.completionRequests).toBe(1)
    const resumedAuthority = await second.provider.inspect(correlationFor(firstRecord))
    expect(resumedAuthority.decision).toEqual(providerAuthority.decision)
    await second.runtime.acceptLifecycle(acknowledgementFor(replay, "ensure"))

    // Dirty refusal is the actual lifecycle cleanup result after the exact
    // real-Companion end. No test retirement or cleanup implementation is
    // substituted.
    const dirtyPath = join(worktree, "dirty-untracked.txt")
    await writeFile(dirtyPath, "must survive cleanup refusal\n", { mode: 0o600 })
    const conversationId = replay.effects.fx.status === "started"
      ? replay.effects.fx.conversation_id
      : null
    if (conversationId === null) throw new Error("complete ensure receipt has no Fx Conversation")
    const end = fixture.end(conversationId)
    await second.runtime.acceptLifecycle(end)
    await waitFor(() => replayed.some(isEndReceipt), "exact real-Companion end receipt", errors)
    const endReceipt = replayed.find(isEndReceipt)!
    await second.multiplexer.settled()
    expect(endReceipt.receipt_digest).toBe(deriveLifecycleReceiptDigest(endReceipt))
    expect(endReceipt.proof).toMatchObject({
      kind: "ended",
      companion_session: identityFor(AGENT_ID).zmxName,
      pane_id: identityFor(AGENT_ID).paneId,
      reason: "requested",
    })
    await second.runtime.acceptLifecycle(acknowledgementFor(endReceipt, "end"))

    const cleanup = fixture.cleanup(conversationId)
    await second.runtime.acceptLifecycle(cleanup)
    await waitFor(() => replayed.some(isCleanupReceipt), "dirty cleanup refusal", errors)
    const cleanupReceipt = replayed.find(isCleanupReceipt)!
    expect(cleanupReceipt.receipt_digest).toBe(deriveLifecycleReceiptDigest(cleanupReceipt))
    expect(cleanupReceipt.outcome).toEqual({
      kind: "refused_dirty",
      head_commit: baseCommit,
      tracked_changes: false,
      untracked_paths: ["dirty-untracked.txt"],
    })
    expect(await readFile(dirtyPath, "utf8")).toBe("must survive cleanup refusal\n")
    const cleanupReceiptCount = replayed.filter(isCleanupReceipt).length
    await second.runtime.acceptLifecycle(cleanup)
    await waitFor(
      () => replayed.filter(isCleanupReceipt).length === cleanupReceiptCount + 1,
      "exact retained cleanup receipt replay",
      errors,
    )
    expect(replayed.filter(isCleanupReceipt).at(-1)).toEqual(cleanupReceipt)
    expect(await readFile(dirtyPath, "utf8")).toBe("must survive cleanup refusal\n")
    await second.runtime.acceptLifecycle(acknowledgementFor(cleanupReceipt, "cleanup"))

    const finalized = (await second.runtimeRecord(fixture.ensure.ensure_id))!
    expect(finalized.fx_final.receipt).not.toBeNull()
    expect(finalized.fx_final.receipt?.receipt_digest).toBe(
      deriveFxFinalReceiptDigest(finalized.fx_final.receipt!),
    )
    expect(finalized.fx_final.acknowledgement_applied).toBe(true)
    const finalAuthority = await second.provider.inspect(correlationFor(finalized))
    expect(finalAuthority.finalReceipt).toEqual(finalized.fx_final.receipt)
    const finalAcknowledgement = finalized.fx_final.acknowledgement
    if (finalAcknowledgement === null) throw new Error("Fx final receipt has no durable acknowledgement")
    expect(finalAuthority.finalAcknowledgementId).toBe(finalAcknowledgement.acknowledgement_id)
    expect(second.manifest.get(AGENT_ID)).toBeNull()
    expect(await pathDisposition(workControlSocketPath)).toBe("absent")
    expect((await second.companion.list()).filter(({ state }) => state === "live")).toEqual([])

    // The lifecycle quite correctly retained its dirty refusal. Clean the
    // disposable Worktree only to exercise the independent production
    // compare-and-remove operation under an exact foreign replacement race.
    await unlink(dirtyPath)
    const authority = new GitSafeWorktreeAuthority(environment)
    const inspection = await authority.inspect(repository, worktree)
    if (inspection.kind !== "present") throw new Error("clean Worktree is not exactly inspectable")
    expect(inspection.trackedChanges).toBe(false)
    expect(inspection.untrackedPaths).toEqual([])
    const prepare: CleanupPrepare = {
      repository,
      worktree_directory: worktree,
      head_commit: inspection.headCommit,
      status_digest: inspection.statusDigest,
      physical_identity: structuredClone(inspection.physicalIdentity),
      prepared_at: new Date().toISOString(),
    }
    const foreignSentinel = join(worktree, "foreign-replacement.txt")
    let raceCount = 0
    const racedAuthority = new GitSafeWorktreeAuthority(
      environment,
      undefined,
      async (retained, preparedEnvironment) => {
        raceCount++
        await git(repository, ["worktree", "remove", "--force", "--", worktree])
        await mkdir(worktree, { recursive: true, mode: 0o700 })
        await writeFile(foreignSentinel, "foreign replacement survives\n", { mode: 0o600 })
        return spawnPreparedRemovalOperation(retained, preparedEnvironment)
      },
    )
    const raced = await racedAuthority.compareAndRemove(prepare)
    expect(raceCount).toBe(1)
    expect(raced).toMatchObject({ kind: "refused", inspection: { kind: "mismatch" } })
    const foreignReplacementDisposition = raced.kind === "refused" && raced.inspection.kind === "mismatch"
      ? "refused_mismatch"
      : "unexpected"
    expect(foreignReplacementDisposition).toBe("refused_mismatch")
    expect(await readFile(foreignSentinel, "utf8")).toBe("foreign replacement survives\n")
    expect(raceCount).toBe(1)
    expect(errors.map(String)).toEqual([])
  } finally {
    await first?.runtime.close().catch(() => {})
    await first?.multiplexer.close().catch(() => {})
    await second?.runtime.close().catch(() => {})
    await second?.multiplexer.close().catch(() => {})
    gateway?.close()
  }
}, 60_000)

type RuntimeComposition = {
  runtime: LifecycleRuntime
  multiplexer: RealProcessMultiplexer
  manifest: AgentManifest
  companion: CompanionCommand
  provider: FxLaunchProviderClient
  runtimeRecord(ensureId: string): Promise<EnsureLifecycleRecord | null>
}

async function openComposition(input: {
  home: string
  fxPath: string
  zmxPath: string
  providerRuntime: string
  companionDirectory: string
  runtimeSocketPath: string
  environment: NodeJS.ProcessEnv
  errors: unknown[]
  receipts?: LifecycleReceipt[]
  restore?: boolean
}): Promise<RuntimeComposition> {
  const manifest = await AgentManifest.open(join(input.home, "manifest.json"), HOME_ID)
  const companion = new CompanionCommand(input.companionDirectory, input.environment, input.zmxPath)
  const provider = new FxLaunchProviderClient({
    executable: input.fxPath,
    runtimeDirectory: input.providerRuntime,
    timeoutMs: 15_000,
    parentEnvironment: input.environment,
  })
  const options = {
    home: input.home,
    homeId: HOME_ID,
    fmxSession: FMX_SESSION,
    fxPath: input.fxPath,
    runtimeSocketPath: input.runtimeSocketPath,
    adeBinding: null,
    manifest,
    companion,
    companionDirectory: input.companionDirectory,
    environment: input.environment,
    onError: (error: unknown) => input.errors.push(error),
    launchProvider: provider,
  } satisfies LifecycleRuntimeOptions
  const runtime = await LifecycleRuntime.open(options)
  const multiplexer = new RealProcessMultiplexer(
    manifest,
    new CompanionTransportFactory(companion, HOME_ID, { client: "fmx-phase1c-acceptance" }),
    input.runtimeSocketPath,
    runtime,
    input.errors,
  )
  runtime.bindMultiplexer(multiplexer)
  if (input.receipts) runtime.bindReceiptPublisher((receipt) => {
    input.receipts!.push(receipt as LifecycleReceipt)
  })
  if (input.restore) await multiplexer.restore()
  return {
    runtime,
    multiplexer,
    manifest,
    companion,
    provider,
    runtimeRecord: (ensureId) => runtimeRecord(runtime, ensureId),
  }
}

class RealProcessMultiplexer implements LifecycleRuntimeMultiplexer {
  private readonly transports = new Map<string, AgentTransport>()
  private readonly finalizations = new Set<Promise<void>>()

  constructor(
    private readonly manifest: AgentManifest,
    private readonly transportFactory: CompanionTransportFactory,
    private readonly runtimeSocketPath: string,
    private readonly runtime: LifecycleRuntime,
    private readonly errors: unknown[],
  ) {}

  async projectManagedAgent(claim: ManagedAgentClaim): Promise<ManifestEntry> {
    const existing = this.manifest.get(claim.agentId)
    const { result, saved } = this.manifest.ensureClaim({
      identity: identityFor(claim.agentId),
      cwd: claim.cwd,
      fxPath: claim.fxPath,
      fxArgs: claim.fxArgs,
      fxStateRoot: claim.fxStateRoot,
      workControl: claim.workControl,
      createdAt: existing?.createdAt ?? claim.createdAt ?? Date.now(),
    })
    await saved
    return result
  }

  async startManagedAgent(
    agentId: string,
    invocation: ManagedAgentInvocation,
  ): Promise<ManagedAgentStartResult> {
    const entry = this.manifest.get(agentId)
    if (entry === null) throw new Error(`real-process Agent is not claimed: ${agentId}`)
    if (!this.transports.has(agentId)) {
      const transport = entry.phase === "running"
        ? await this.transportFactory.attach(entry, { cols: 100, rows: 30 }, { foreignAsConflict: true })
        : await this.transportFactory.start({
            entry,
            command: [...invocation.command],
            cwd: invocation.cwd,
            env: { ...invocation.env },
            size: { cols: 100, rows: 30 },
            recoverExisting: true,
          })
      await this.manifest.markRunning(agentId)
      this.bind(entry, transport)
    }
    return { sessionName: entry.zmxName, paneId: entry.paneId }
  }

  async restore(): Promise<void> {
    for (const entry of this.manifest.entries) {
      if (entry.phase !== "running") continue
      const transport = await this.transportFactory.attach(
        entry,
        { cols: 100, rows: 30 },
        { foreignAsConflict: true },
      )
      this.bind(entry, transport)
    }
  }

  async removeManagedAgentProjection(agentId: string): Promise<void> {
    if (this.transports.has(agentId)) throw new Error(`real-process Agent ${agentId} is not inert`)
  }

  refreshManagedAgentProjection(_agentId: string): void {}

  async settled(): Promise<void> {
    await Promise.all([...this.finalizations])
    if (this.errors.length > 0) throw this.errors[0]
  }

  async close(): Promise<void> {
    for (const transport of this.transports.values()) transport.detach()
    this.transports.clear()
    this.transportFactory.close()
    await Promise.allSettled([...this.finalizations])
  }

  private bind(entry: ManifestEntry, transport: AgentTransport): void {
    this.transports.set(entry.agentId, transport)
    transport.bind({
      output: () => {},
      restoreBegin: () => {},
      ready: () => {},
      lost: (error) => this.errors.push(error),
      exit: (status) => {
        this.transports.delete(entry.agentId)
        const operation = this.finalize(entry, status)
        this.finalizations.add(operation)
        void operation.catch((error) => this.errors.push(error)).finally(() => {
          this.finalizations.delete(operation)
        })
      },
    })
  }

  private async finalize(entry: ManifestEntry, exit: AgentExit): Promise<void> {
    await this.runtime.beforeDefinitiveAgentForget(entry, exit)
    await removeFxWorkControlResidue(entry.workControl, this.runtimeSocketPath)
    await this.manifest.remove(entry.agentId)
  }
}

function lifecycleMessages(input: {
  repository: string
  worktree: string
  stateRoot: string
  baseCommit: string
}) {
  const initialWork = encodeInlineSourceBytes(Buffer.from("PHASE1C_REAL_PROCESS_INITIAL\n", "utf8"))
  const controls = encodeInlineSourceBytes(encodeInlineLaunchControls([
    "--no-native-tools",
    "--no-default-skills",
    "--no-project-instructions",
  ]))
  const launch = {
    schema_id: "fx.launch-admission-final",
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "launch_request",
    request_id: "phase1c-real-launch-request",
    launch_id: "phase1c-real-launch",
    launch_digest: "0".repeat(64),
    admission_key: "phase1c-real-admission",
    conversation_name: "Phase 1C real-process acceptance",
    resume: { mode: "fresh" },
    state_root: input.stateRoot,
    directory: input.worktree,
    model: "openai/gpt-5",
    effort: "low",
    initial_work_digest: initialWork.sha256,
    remaining_launch_controls_digest: controls.sha256,
  } satisfies FrozenLaunchRequest
  launch.launch_digest = deriveFrozenLaunchDigest(launch)
  const ensure = {
    schema_id: ENSURE_LIFECYCLE_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "ensure_request",
    request_id: "phase1c-real-ensure-request",
    workplace_instance_id: "phase1c-real-workplace",
    fmx_session: FMX_SESSION,
    ensure_id: "phase1c-real-ensure",
    ensure_digest: "0".repeat(64),
    launch_id: launch.launch_id,
    launch_digest: launch.launch_digest,
    worktree_id: "phase1c-real-worktree",
    agent_id: AGENT_ID,
    planned_worktree: {
      repository: input.repository,
      base_commit: input.baseCommit,
      branch: "phase1c-real-process",
      directory: input.worktree,
    },
    fx_conversation: { name: launch.conversation_name, resume_conversation_id: null },
  } satisfies EnsureRequest
  ensure.ensure_digest = deriveEnsureDigest(ensure)
  const source = {
    schema_id: "fmx.inline-launch-source",
    schema_version: 2,
    message_type: "source_request",
    request_id: "phase1c-real-source-request",
    workplace_instance_id: ensure.workplace_instance_id,
    fmx_session: ensure.fmx_session,
    ensure_id: ensure.ensure_id,
    ensure_digest: ensure.ensure_digest,
    worktree_id: ensure.worktree_id,
    agent_id: ensure.agent_id,
    launch_id: ensure.launch_id,
    launch_digest: ensure.launch_digest,
    admission_key: launch.admission_key,
    source_id: "phase1c-real-source",
    source_digest: "0".repeat(64),
    launch_request: launch,
    initial_work: initialWork,
    launch_controls: controls,
  } satisfies InlineLaunchSourceRequest
  source.source_digest = deriveInlineLaunchSourceDigest(source)
  parseInlineLaunchSourceRequest(source)

  const correlation = {
    schema_id: ENSURE_LIFECYCLE_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    workplace_instance_id: ensure.workplace_instance_id,
    fmx_session: ensure.fmx_session,
    ensure_id: ensure.ensure_id,
    ensure_digest: ensure.ensure_digest,
    launch_id: ensure.launch_id,
    launch_digest: ensure.launch_digest,
    worktree_id: ensure.worktree_id,
    agent_id: ensure.agent_id,
  } as const
  const end = (conversation_id: string): EndRequest => {
    const request = {
      ...correlation,
      message_type: "end_request" as const,
      request_id: "phase1c-real-end-request",
      end_id: "phase1c-real-end",
      end_digest: "0".repeat(64),
      conversation_id,
      reason: "retire" as const,
    } satisfies EndRequest
    request.end_digest = deriveEndDigest(request)
    return request
  }
  return {
    ensure,
    source,
    end,
    cleanup: (conversationId: string): CleanupRequest => {
      const endRequest = end(conversationId)
      const request = {
        ...correlation,
        message_type: "cleanup_request" as const,
        request_id: "phase1c-real-cleanup-request",
        cleanup_id: "phase1c-real-cleanup",
        cleanup_digest: "0".repeat(64),
        end_id: endRequest.end_id,
        end_digest: endRequest.end_digest,
        conversation_id: conversationId,
        worktree_directory: input.worktree,
      } satisfies CleanupRequest
      request.cleanup_digest = deriveCleanupDigest(request)
      return request
    },
  }
}

function boundedGateway() {
  const state: { controller: ReadableStreamDefaultController<Uint8Array> | null } = { controller: null }
  let completionRequests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/coding-agent/v1/models") {
        return Response.json({ data: [{ id: "openai/gpt-5", type: "language", tags: [] }] })
      }
      if (request.method !== "POST" || path !== "/v3/ai/language-model") {
        return new Response("not found", { status: 404 })
      }
      await request.text()
      completionRequests++
      const encoder = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          state.controller = controller
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: "text-delta", id: "phase1c-held", delta: "working" })}\n\n`,
          ))
        },
        cancel() { state.controller = null },
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    port: server.port,
    get completionRequests() { return completionRequests },
    close() {
      try { state.controller?.close() } catch {}
      server.stop(true)
    },
  }
}

function realFxEnvironment(home: string, gatewayPort: number): NodeJS.ProcessEnv {
  return {
    ...scrubGitEnvironment(process.env),
    HOME: home,
    AI_GATEWAY_API_KEY: "phase1c-local-gateway-key",
    VERCEL_OIDC_TOKEN: undefined,
    FX_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
    FX_GATEWAY_CHAT_URL: `http://127.0.0.1:${gatewayPort}/v3/ai/language-model`,
    FX_AUTO_UPGRADE: "0",
    FX_DISABLE_KEYCHAIN: "1",
    FX_E2E_DISABLE_DOTENV: "1",
    NO_COLOR: "1",
    TERM: "xterm-256color",
  }
}

function acknowledgementFor(
  receipt: LifecycleReceipt,
  kind: "ensure" | "end" | "cleanup",
): ReceiptAcknowledgement {
  return {
    schema_id: ENSURE_LIFECYCLE_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "receipt_acknowledgement" as const,
    acknowledgement_id: `phase1c-real-ack-${createHash("sha256")
      .update(`${kind}\0${receipt.receipt_id}\0${receipt.receipt_digest}`)
      .digest("hex")}`,
    receipt_kind: kind,
    receipt_id: receipt.receipt_id,
    receipt_digest: receipt.receipt_digest,
    ensure_id: receipt.ensure_id,
  }
}

function completeReceipt(record: EnsureLifecycleRecord): EnsureReceipt | null {
  return record.receipts.find(isCompleteEnsureReceipt) ?? null
}

function isCompleteEnsureReceipt(receipt: LifecycleReceipt): receipt is EnsureReceipt {
  return receipt.message_type === "ensure_receipt" && receipt.status === "complete"
}

function isEndReceipt(receipt: LifecycleReceipt): receipt is EndReceipt {
  return receipt.message_type === "end_receipt"
}

function isCleanupReceipt(receipt: LifecycleReceipt): receipt is CleanupReceipt {
  return receipt.message_type === "cleanup_receipt"
}

function correlationFor(record: EnsureLifecycleRecord) {
  const binding = record.fx_final.binding
  if (binding === null) throw new Error("real lifecycle record has no final authority")
  return {
    stateRoot: binding.state_root,
    admissionKey: binding.admission_key,
    launchDigest: record.request.launch_digest,
    launchId: record.request.launch_id,
  }
}

async function runtimeRecord(runtime: LifecycleRuntime, ensureId: string): Promise<EnsureLifecycleRecord | null> {
  return (await EnsureLifecycleLedger.open(runtime.roots.ensure)).get(ensureId)
}

async function exactLiveSession(companion: CompanionCommand, agentId: string) {
  const expected = identityFor(agentId).zmxName
  const matches = (await companion.list()).filter((entry) =>
    entry.name === expected && statusIsLive(entry))
  if (matches.length !== 1) throw new Error(`expected one live Companion Fx process, found ${matches.length}`)
  return matches[0]!
}

function statusIsLive(entry: { state: string }): boolean { return entry.state === "live" }

async function initializeRepository(repository: string): Promise<string> {
  await mkdir(repository, { recursive: true, mode: 0o700 })
  await git(repository, ["init", "--initial-branch=main"])
  await git(repository, ["config", "user.name", "Phase 1C Acceptance"])
  await git(repository, ["config", "user.email", "phase1c-real@example.test"])
  await writeFile(join(repository, "README.md"), "real Phase 1C\n", { mode: 0o600 })
  await git(repository, ["add", "README.md"])
  await git(repository, ["commit", "-m", "initial"])
  return (await git(repository, ["rev-parse", "HEAD"])).trim()
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: scrubGitEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)
  return stdout
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  errors: unknown[],
): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    if (errors.length > 0) throw errors[0]
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(25)
  }
}

async function verifyInstalledFx(path: string): Promise<void> {
  const child = Bun.spawn([path, "--fxnk-version"], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const expected = `fxnk ${fxPin.fxnk} (fx `
  if (code !== 0 || stderr !== "" || !stdout.startsWith(expected) || !stdout.endsWith(")\n")) {
    throw new Error(`FMX_FX_PATH is not the installed pinned fmx-fx: ${JSON.stringify({ code, stdout, stderr })}`)
  }
  const provider = Bun.spawn([path, "--internal-launch-provider"], { stdout: "pipe", stderr: "pipe" })
  const [providerCode, providerStdout, providerStderr] = await Promise.all([
    provider.exited,
    new Response(provider.stdout).text(),
    new Response(provider.stderr).text(),
  ])
  if (
    providerCode === 0 || providerStdout !== "" ||
    !providerStderr.includes("IncompleteLaunchProviderConfiguration")
  ) {
    throw new Error("FMX_FX_PATH lacks the pinned private launch provider; run scripts/install.sh --install")
  }
}

async function requiredDirectory(name: string): Promise<string> {
  const value = process.env[name]
  if (value === undefined || !isAbsolute(value)) {
    throw new Error(`${name} must name an absolute existing writable Scratch directory`)
  }
  const path = await realpath(value)
  const facts = await lstat(path)
  if (!facts.isDirectory()) throw new Error(`${name} must name a directory`)
  await access(path, constants.W_OK)
  return path
}

async function requiredRunRoot(name: string, scratch: string): Promise<string> {
  const root = await requiredDirectory(name)
  if (root === scratch || !root.startsWith(`${scratch}/`)) {
    throw new Error(`${name} must be a dedicated directory beneath FMX_PHASE1C_SCRATCH_ROOT`)
  }
  if ((await lstat(root)).mode & 0o077) {
    throw new Error(`${name} must be private (mode 0700)`)
  }
  return root
}

async function requiredExecutable(name: string): Promise<string> {
  const value = process.env[name]
  if (value === undefined || !isAbsolute(value)) {
    throw new Error(`${name} must name the absolute installed executable`)
  }
  const path = await realpath(value)
  const facts = await lstat(path)
  if (!facts.isFile()) throw new Error(`${name} is not a regular file: ${path}`)
  await access(path, constants.X_OK)
  return path
}

async function pathDisposition(path: string): Promise<"absent" | "present"> {
  try {
    await lstat(path)
    return "present"
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "absent"
    }
    throw error
  }
}

function scrubGitEnvironment(parent: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && !key.startsWith("GIT_")) environment[key] = value
  }
  environment.GIT_ATTR_NOSYSTEM = "1"
  environment.GIT_CONFIG_COUNT = "2"
  environment.GIT_CONFIG_GLOBAL = "/dev/null"
  environment.GIT_CONFIG_KEY_0 = "core.attributesFile"
  environment.GIT_CONFIG_KEY_1 = "core.excludesFile"
  environment.GIT_CONFIG_NOSYSTEM = "1"
  environment.GIT_CONFIG_SYSTEM = "/dev/null"
  environment.GIT_CONFIG_VALUE_0 = "/dev/null"
  environment.GIT_CONFIG_VALUE_1 = "/dev/null"
  environment.GIT_NO_REPLACE_OBJECTS = "1"
  environment.GIT_TERMINAL_PROMPT = "0"
  environment.GIT_PAGER = "cat"
  environment.LC_ALL = "C"
  return environment
}
