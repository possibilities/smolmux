import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, rename, unlink } from "node:fs/promises"
import { userInfo } from "node:os"
import { isAbsolute, join, normalize } from "node:path"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  ENSURE_LIFECYCLE_SCHEMA_ID,
  ensureLifecycleMessageSchema,
  type EnsureLifecycleMessage,
} from "./agentworkplace-contracts.ts"
import {
  CONTRACT_MAX_FRAME_BYTES,
  decodeStrictJson,
  encodeCanonicalJson,
  type JsonValue,
} from "./contract-codec.ts"
import { acquireExclusiveLock } from "./file-lock.ts"
import { ensurePrivateDirectories } from "./private-directory.ts"

export const ENSURE_LEDGER_SCHEMA_ID = "fmx.ensure-lifecycle-ledger"
export const ENSURE_LEDGER_SCHEMA_VERSION = 1

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const SHA256 = /^[0-9a-f]{64}$/u
const SAFE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u
const RECORD_NAME = /^([0-9a-f]{64})\.json$/u
const TEMP_NAME = /^([0-9a-f]{64})\.([0-9]+)\.([0-9a-f]{16})\.tmp$/u

export type EnsureRequest = Extract<EnsureLifecycleMessage, { message_type: "ensure_request" }>
export type EnsureReceipt = Extract<EnsureLifecycleMessage, { message_type: "ensure_receipt" }>
export type EnsureReceiptAcknowledgement = Extract<
  EnsureLifecycleMessage,
  { message_type: "receipt_acknowledgement" }
>
export type EnsureEffects = EnsureReceipt["effects"]
export type EnsureTransactionState =
  | "claimed"
  | "worktree_created"
  | "manifest_claimed"
  | "companion_started"
  | "fx_started"

export type RetainedEnsureReceipt = {
  receipt: EnsureReceipt
  acknowledgement: EnsureReceiptAcknowledgement | null
}

export type EnsureTransactionSnapshot = {
  revision: number
  state: EnsureTransactionState
  claim: EnsureRequest
  effects: EnsureEffects
  receipts: RetainedEnsureReceipt[]
}

export type EnsureLedgerFaultPoint =
  | "before_write"
  | "after_write"
  | "before_file_sync"
  | "after_file_sync"
  | "before_rename"
  | "after_rename"
  | "before_directory_sync"
  | "after_directory_sync"

export type EnsureLedgerFaultContext = {
  point: EnsureLedgerFaultPoint
  ensureId: string
  revision: number
}

export type EnsureLifecycleLedgerOptions = {
  fault?: (context: EnsureLedgerFaultContext) => void | Promise<void>
}

export type EnsureLifecycleLedgerErrorCode =
  | "conflicting_acknowledgement"
  | "conflicting_claim"
  | "conflicting_receipt"
  | "conflicting_transition"
  | "corrupt_record"
  | "invalid_claim"
  | "invalid_receipt"
  | "invalid_transition"
  | "lock_unavailable"
  | "storage_unsafe"
  | "unknown_receipt"
  | "unknown_transaction"

export class EnsureLifecycleLedgerError extends Error {
  constructor(
    readonly code: EnsureLifecycleLedgerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "EnsureLifecycleLedgerError"
  }
}

type LedgerRecord = EnsureTransactionSnapshot & {
  schema_id: typeof ENSURE_LEDGER_SCHEMA_ID
  schema_version: typeof ENSURE_LEDGER_SCHEMA_VERSION
}

type FileIdentity = {
  dev: number
  ino: number
}

type StoredRecord = {
  record: LedgerRecord
  identity: FileIdentity
}

const STATE_ORDER: Record<EnsureTransactionState, number> = {
  claimed: 0,
  worktree_created: 1,
  manifest_claimed: 2,
  companion_started: 3,
  fx_started: 4,
}

const processQueues = new Map<string, Promise<unknown>>()

/**
 * Private durable authority for one exact frozen-v1 ensure transaction.
 *
 * The ledger deliberately knows no prompt, role, policy, or launch-control
 * transport. It stores only the opaque correlation/specification already
 * carried by `fmx.ensure-lifecycle` and the monotonic effects and receipts
 * that a later Runtime-extension adapter proves.
 */
export class EnsureLifecycleLedger {
  readonly recordsRoot: string
  readonly lockPath: string

  private constructor(
    readonly root: string,
    private readonly options: EnsureLifecycleLedgerOptions,
  ) {
    this.recordsRoot = join(root, "records")
    this.lockPath = join(root, "ledger.lock")
  }

  static async open(root: string, options: EnsureLifecycleLedgerOptions = {}): Promise<EnsureLifecycleLedger> {
    if (!isAbsolute(root) || normalize(root) !== root || root === "/") {
      throw new EnsureLifecycleLedgerError("storage_unsafe", "ensure ledger root must be a normalized absolute non-root path")
    }
    const ledger = new EnsureLifecycleLedger(root, options)
    await ledger.initialize()
    await ledger.serialized(async () => {
      await ledger.withLock(async () => {
        await ledger.scanRecords()
      })
    })
    return ledger
  }

  async get(ensureId: string): Promise<EnsureTransactionSnapshot | null> {
    assertEnsureId(ensureId)
    return this.access(async (records) => {
      const stored = records.get(ensureId)
      return stored ? snapshot(stored.record) : null
    })
  }

  async unacknowledgedReceipts(ensureId: string): Promise<EnsureReceipt[]> {
    const current = await this.get(ensureId)
    if (!current) throw new EnsureLifecycleLedgerError("unknown_transaction", `ensure ${ensureId} is not claimed`)
    return current.receipts
      .filter((entry) => entry.acknowledgement === null)
      .map((entry) => structuredClone(entry.receipt))
  }

  async claim(input: EnsureRequest): Promise<EnsureTransactionSnapshot> {
    const request = parseEnsureRequest(input, "invalid_claim")
    verifyEnsureDigest(request, "invalid_claim")
    return this.access(async (records) => {
      const existing = records.get(request.ensure_id)
      if (existing) {
        if (existing.record.claim.ensure_digest !== request.ensure_digest) {
          throw new EnsureLifecycleLedgerError(
            "conflicting_claim",
            `ensure ${request.ensure_id} already owns digest ${existing.record.claim.ensure_digest}`,
          )
        }
        if (!sameJson(ensureSpecification(existing.record.claim), ensureSpecification(request))) {
          throw new EnsureLifecycleLedgerError(
            "conflicting_claim",
            `ensure ${request.ensure_id} reused its digest with different immutable specification fields`,
          )
        }
        return snapshot(existing.record)
      }

      assertUnownedClaim(request, records)
      const effects: EnsureEffects = {
        worktree: { status: "planned", directory: request.planned_worktree.directory },
        manifest: { status: "pending" },
        companion: {
          status: "pending",
          session_name: `fmx-${request.agent_id}`,
          pane_id: `p_${request.agent_id}`,
        },
        fx: { status: "pending" },
      }
      const record: LedgerRecord = {
        schema_id: ENSURE_LEDGER_SCHEMA_ID,
        schema_version: ENSURE_LEDGER_SCHEMA_VERSION,
        revision: 1,
        state: "claimed",
        claim: structuredClone(request),
        effects,
        receipts: [],
      }
      validateRecord(record, recordNameHash(request.ensure_id))
      await this.persist(record, null)
      return snapshot(record)
    })
  }

  markWorktreeCreated(
    ensureId: string,
    effect: Extract<EnsureEffects["worktree"], { status: "created" }>,
  ): Promise<EnsureTransactionSnapshot> {
    return this.transition(ensureId, "worktree_created", (record) => {
      if (effect.directory !== record.claim.planned_worktree.directory) {
        throw new EnsureLifecycleLedgerError("conflicting_transition", "created Worktree changed its claimed directory")
      }
      record.effects.worktree = structuredClone(effect)
    }, (record) => sameJson(record.effects.worktree, effect))
  }

  markManifestClaimed(
    ensureId: string,
    effect: Extract<EnsureEffects["manifest"], { status: "claimed" }>,
  ): Promise<EnsureTransactionSnapshot> {
    return this.transition(ensureId, "manifest_claimed", (record) => {
      if (effect.agent_id !== record.claim.agent_id) {
        throw new EnsureLifecycleLedgerError("conflicting_transition", "Manifest claim changed the claimed Agent identity")
      }
      record.effects.manifest = structuredClone(effect)
    }, (record) => sameJson(record.effects.manifest, effect))
  }

  markCompanionStarted(
    ensureId: string,
    effect: Extract<EnsureEffects["companion"], { status: "started" }>,
  ): Promise<EnsureTransactionSnapshot> {
    return this.transition(ensureId, "companion_started", (record) => {
      const planned = record.effects.companion
      if (effect.session_name !== planned.session_name || effect.pane_id !== planned.pane_id) {
        throw new EnsureLifecycleLedgerError("conflicting_transition", "Companion start changed its claimed identity")
      }
      record.effects.companion = structuredClone(effect)
    }, (record) => sameJson(record.effects.companion, effect))
  }

  markFxStarted(
    ensureId: string,
    effect: Extract<EnsureEffects["fx"], { status: "started" }>,
  ): Promise<EnsureTransactionSnapshot> {
    return this.transition(
      ensureId,
      "fx_started",
      (record) => { record.effects.fx = structuredClone(effect) },
      (record) => sameJson(record.effects.fx, effect),
    )
  }

  async retainReceipt(input: EnsureReceipt): Promise<EnsureTransactionSnapshot> {
    const receipt = parseEnsureReceipt(input, "invalid_receipt")
    verifyReceiptDigest(receipt, "invalid_receipt")
    return this.access(async (records) => {
      const stored = records.get(receipt.ensure_id)
      if (!stored) {
        throw new EnsureLifecycleLedgerError("unknown_transaction", `ensure ${receipt.ensure_id} is not claimed`)
      }
      const record = structuredClone(stored.record)
      const existing = record.receipts.find((entry) => entry.receipt.receipt_id === receipt.receipt_id)
      if (existing) {
        if (!sameJson(existing.receipt, receipt)) {
          throw new EnsureLifecycleLedgerError("conflicting_receipt", `receipt ${receipt.receipt_id} was reused`)
        }
        return snapshot(record)
      }
      for (const candidate of records.values()) {
        if (candidate.record.receipts.some((entry) => entry.receipt.receipt_id === receipt.receipt_id)) {
          throw new EnsureLifecycleLedgerError("conflicting_receipt", `receipt ${receipt.receipt_id} belongs to another ensure`)
        }
      }
      assertReceiptCorrelation(record.claim, receipt)
      const receiptState = stateForEffects(receipt.effects, record.claim)
      const expectedStatus = receiptState === "fx_started" ? "complete" : "in_progress"
      if (receipt.status !== expectedStatus || receiptState !== record.state || !sameJson(receipt.effects, record.effects)) {
        throw new EnsureLifecycleLedgerError("invalid_receipt", "ensure receipt does not describe the exact current durable effects")
      }
      if (record.receipts.some((entry) => entry.receipt.receipt_digest === receipt.receipt_digest)) {
        throw new EnsureLifecycleLedgerError("conflicting_receipt", `receipt digest ${receipt.receipt_digest} was reused`)
      }
      if (receipt.status === "complete" && record.receipts.some((entry) => entry.receipt.status === "complete")) {
        throw new EnsureLifecycleLedgerError("conflicting_receipt", `ensure ${receipt.ensure_id} already has a final receipt`)
      }
      record.receipts.push({ receipt: structuredClone(receipt), acknowledgement: null })
      record.revision++
      validateRecord(record, recordNameHash(record.claim.ensure_id))
      await this.persist(record, stored.identity)
      return snapshot(record)
    })
  }

  async acknowledgeReceipt(input: EnsureReceiptAcknowledgement): Promise<EnsureTransactionSnapshot> {
    const acknowledgement = parseEnsureAcknowledgement(input, "invalid_receipt")
    return this.access(async (records) => {
      const stored = records.get(acknowledgement.ensure_id)
      if (!stored) {
        throw new EnsureLifecycleLedgerError("unknown_transaction", `ensure ${acknowledgement.ensure_id} is not claimed`)
      }
      const record = structuredClone(stored.record)
      const retained = record.receipts.find((entry) => entry.receipt.receipt_id === acknowledgement.receipt_id)
      if (!retained || retained.receipt.receipt_digest !== acknowledgement.receipt_digest) {
        throw new EnsureLifecycleLedgerError("unknown_receipt", `receipt ${acknowledgement.receipt_id} is not retained exactly`)
      }
      for (const candidate of records.values()) {
        for (const entry of candidate.record.receipts) {
          const prior = entry.acknowledgement
          if (prior?.acknowledgement_id === acknowledgement.acknowledgement_id && !sameJson(prior, acknowledgement)) {
            throw new EnsureLifecycleLedgerError(
              "conflicting_acknowledgement",
              `acknowledgement ${acknowledgement.acknowledgement_id} was reused`,
            )
          }
        }
      }
      if (retained.acknowledgement) {
        if (!sameJson(retained.acknowledgement, acknowledgement)) {
          throw new EnsureLifecycleLedgerError(
            "conflicting_acknowledgement",
            `receipt ${acknowledgement.receipt_id} already has a different acknowledgement`,
          )
        }
        return snapshot(record)
      }
      retained.acknowledgement = structuredClone(acknowledgement)
      record.revision++
      validateRecord(record, recordNameHash(record.claim.ensure_id))
      await this.persist(record, stored.identity)
      return snapshot(record)
    })
  }

  private transition(
    ensureId: string,
    target: Exclude<EnsureTransactionState, "claimed">,
    apply: (record: LedgerRecord) => void,
    alreadyApplied: (record: LedgerRecord) => boolean,
  ): Promise<EnsureTransactionSnapshot> {
    assertEnsureId(ensureId)
    return this.access(async (records) => {
      const stored = records.get(ensureId)
      if (!stored) throw new EnsureLifecycleLedgerError("unknown_transaction", `ensure ${ensureId} is not claimed`)
      const record = structuredClone(stored.record)
      const currentOrder = STATE_ORDER[record.state]
      const targetOrder = STATE_ORDER[target]
      if (currentOrder >= targetOrder) {
        if (!alreadyApplied(record)) {
          throw new EnsureLifecycleLedgerError("conflicting_transition", `ensure ${ensureId} already passed ${target}`)
        }
        return snapshot(record)
      }
      if (currentOrder !== targetOrder - 1) {
        throw new EnsureLifecycleLedgerError(
          "invalid_transition",
          `ensure ${ensureId} cannot advance from ${record.state} to ${target}`,
        )
      }
      apply(record)
      record.state = target
      record.revision++
      validateRecord(record, recordNameHash(record.claim.ensure_id))
      await this.persist(record, stored.identity)
      return snapshot(record)
    })
  }

  private async initialize(): Promise<void> {
    try {
      await ensurePrivateDirectories([this.root, this.recordsRoot], "ensure lifecycle ledger")
      const handle = await open(
        this.lockPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        FILE_MODE,
      )
      try {
        await handle.chmod(FILE_MODE)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await assertPrivateRegularFile(this.lockPath, "ledger lock")
      await syncDirectory(this.root)
    } catch (error) {
      if (error instanceof EnsureLifecycleLedgerError) throw error
      throw new EnsureLifecycleLedgerError("storage_unsafe", `cannot initialize ensure ledger: ${errorMessage(error)}`)
    }
  }

  private access<T>(run: (records: Map<string, StoredRecord>) => Promise<T>): Promise<T> {
    return this.serialized(() => this.withLock(async () => run(await this.scanRecords())))
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const previous = processQueues.get(this.root) ?? Promise.resolve()
    const current = previous.then(run, run)
    processQueues.set(this.root, current.then(() => undefined, () => undefined))
    return current
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    await this.assertSurfaces()
    let held: ReturnType<typeof acquireExclusiveLock> = null
    for (let attempt = 0; attempt < 2_000; attempt++) {
      held = acquireExclusiveLock(this.lockPath)
      if (held) break
      if (held === undefined) {
        throw new EnsureLifecycleLedgerError("lock_unavailable", "native flock is unavailable for the ensure ledger")
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    if (!held) throw new EnsureLifecycleLedgerError("lock_unavailable", "timed out acquiring the ensure ledger lock")
    try {
      await this.assertSurfaces()
      return await run()
    } finally {
      held.release()
    }
  }

  private async assertSurfaces(): Promise<void> {
    try {
      await ensurePrivateDirectories([this.root, this.recordsRoot], "ensure lifecycle ledger")
      await assertPrivateRegularFile(this.lockPath, "ledger lock")
    } catch (error) {
      if (error instanceof EnsureLifecycleLedgerError) throw error
      throw new EnsureLifecycleLedgerError("storage_unsafe", `unsafe ensure ledger storage: ${errorMessage(error)}`)
    }
  }

  private async scanRecords(): Promise<Map<string, StoredRecord>> {
    const entries = await readdir(this.recordsRoot, { withFileTypes: true })
    let removedTemp = false
    for (const entry of entries) {
      const match = TEMP_NAME.exec(entry.name)
      if (!match) continue
      if (!entry.isFile()) {
        throw new EnsureLifecycleLedgerError("storage_unsafe", `ensure ledger temp ${entry.name} is not a regular file`)
      }
      const temporary = await readLedgerFile(join(this.recordsRoot, entry.name), match[1]!)
      if (recordNameHash(temporary.record.claim.ensure_id) !== match[1]) {
        throw new EnsureLifecycleLedgerError("corrupt_record", `ensure ledger temp ${entry.name} has the wrong key`)
      }
      await unlink(join(this.recordsRoot, entry.name))
      removedTemp = true
    }
    if (removedTemp) await syncDirectory(this.recordsRoot)

    const records = new Map<string, StoredRecord>()
    for (const entry of await readdir(this.recordsRoot, { withFileTypes: true })) {
      const match = RECORD_NAME.exec(entry.name)
      if (!match) {
        if (TEMP_NAME.test(entry.name)) continue
        throw new EnsureLifecycleLedgerError("storage_unsafe", `unexpected ensure ledger entry ${entry.name}`)
      }
      if (!entry.isFile()) {
        throw new EnsureLifecycleLedgerError("storage_unsafe", `ensure ledger record ${entry.name} is not a regular file`)
      }
      const stored = await readLedgerFile(join(this.recordsRoot, entry.name), match[1]!)
      if (records.has(stored.record.claim.ensure_id)) {
        throw new EnsureLifecycleLedgerError("corrupt_record", `duplicate ensure ${stored.record.claim.ensure_id}`)
      }
      records.set(stored.record.claim.ensure_id, stored)
    }
    validateOwnedIdentities(records)
    return records
  }

  private async persist(record: LedgerRecord, expected: FileIdentity | null): Promise<void> {
    const target = join(this.recordsRoot, `${recordNameHash(record.claim.ensure_id)}.json`)
    const temporary = `${target.slice(0, -5)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    const bytes = Buffer.concat([Buffer.from(encodeCanonicalJson(record as unknown as JsonValue)), Buffer.from("\n")])
    await this.inject("before_write", record)
    await assertTargetIdentity(target, expected)
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    )
    try {
      await handle.chmod(FILE_MODE)
      await handle.writeFile(bytes)
      await this.inject("after_write", record)
      await this.inject("before_file_sync", record)
      await handle.sync()
      await this.inject("after_file_sync", record)
    } finally {
      await handle.close()
    }
    await this.inject("before_rename", record)
    await assertTargetIdentity(target, expected)
    await rename(temporary, target)
    await this.inject("after_rename", record)
    await this.inject("before_directory_sync", record)
    await syncDirectory(this.recordsRoot)
    await this.inject("after_directory_sync", record)
  }

  private async inject(point: EnsureLedgerFaultPoint, record: LedgerRecord): Promise<void> {
    await this.options.fault?.({ point, ensureId: record.claim.ensure_id, revision: record.revision })
  }
}

function snapshot(record: LedgerRecord): EnsureTransactionSnapshot {
  return structuredClone({
    revision: record.revision,
    state: record.state,
    claim: record.claim,
    effects: record.effects,
    receipts: record.receipts,
  })
}

function parseEnsureRequest(value: unknown, code: "invalid_claim" | "corrupt_record"): EnsureRequest {
  const parsed = ensureLifecycleMessageSchema.safeParse(value)
  if (!parsed.success || parsed.data.message_type !== "ensure_request") {
    throw new EnsureLifecycleLedgerError(code, `invalid ensure request: ${parsed.error?.issues[0]?.message ?? "wrong message type"}`)
  }
  return structuredClone(parsed.data)
}

function parseEnsureReceipt(value: unknown, code: "invalid_receipt" | "corrupt_record"): EnsureReceipt {
  const parsed = ensureLifecycleMessageSchema.safeParse(value)
  if (!parsed.success || parsed.data.message_type !== "ensure_receipt") {
    throw new EnsureLifecycleLedgerError(code, `invalid ensure receipt: ${parsed.error?.issues[0]?.message ?? "wrong message type"}`)
  }
  return structuredClone(parsed.data)
}

function parseEnsureAcknowledgement(
  value: unknown,
  code: "invalid_receipt" | "corrupt_record",
): EnsureReceiptAcknowledgement {
  const parsed = ensureLifecycleMessageSchema.safeParse(value)
  if (
    !parsed.success ||
    parsed.data.message_type !== "receipt_acknowledgement" ||
    parsed.data.receipt_kind !== "ensure"
  ) {
    throw new EnsureLifecycleLedgerError(code, `invalid ensure acknowledgement: ${parsed.error?.issues[0]?.message ?? "wrong receipt kind"}`)
  }
  return structuredClone(parsed.data)
}

function ensureSpecification(request: EnsureRequest): JsonValue {
  return {
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    worktree_id: request.worktree_id,
    agent_id: request.agent_id,
    planned_worktree: structuredClone(request.planned_worktree),
    fx_conversation: structuredClone(request.fx_conversation),
  }
}

function verifyEnsureDigest(request: EnsureRequest, code: "invalid_claim" | "corrupt_record"): void {
  const actual = sha256(encodeCanonicalJson(ensureSpecification(request)))
  if (request.ensure_digest !== actual) {
    throw new EnsureLifecycleLedgerError(code, `ensure ${request.ensure_id} digest does not match its canonical specification`)
  }
}

function verifyReceiptDigest(receipt: EnsureReceipt, code: "invalid_receipt" | "corrupt_record"): void {
  const content = structuredClone(receipt) as EnsureReceipt & { receipt_digest?: string }
  delete content.receipt_digest
  const actual = sha256(encodeCanonicalJson(content as unknown as JsonValue))
  if (receipt.receipt_digest !== actual) {
    throw new EnsureLifecycleLedgerError(code, `receipt ${receipt.receipt_id} digest does not match its canonical content`)
  }
}

function assertReceiptCorrelation(claim: EnsureRequest, receipt: EnsureReceipt): void {
  for (const field of [
    "request_id",
    "workplace_instance_id",
    "fmx_session",
    "ensure_id",
    "ensure_digest",
    "launch_id",
    "launch_digest",
    "worktree_id",
    "agent_id",
  ] as const) {
    if (receipt[field] !== claim[field]) {
      throw new EnsureLifecycleLedgerError("invalid_receipt", `receipt changed ${field}`)
    }
  }
}

function assertUnownedClaim(request: EnsureRequest, records: Map<string, StoredRecord>): void {
  for (const { record } of records.values()) {
    const conflicts: Array<[string, string, string]> = [
      ["launch id", record.claim.launch_id, request.launch_id],
      ["Worktree id", record.claim.worktree_id, request.worktree_id],
      ["Agent id", record.claim.agent_id, request.agent_id],
      ["Worktree directory", record.claim.planned_worktree.directory, request.planned_worktree.directory],
    ]
    const conflict = conflicts.find(([, owned, candidate]) => owned === candidate)
    if (conflict) {
      throw new EnsureLifecycleLedgerError(
        "conflicting_claim",
        `${conflict[0]} ${conflict[1]} already belongs to ensure ${record.claim.ensure_id}`,
      )
    }
  }
}

function validateOwnedIdentities(records: Map<string, StoredRecord>): void {
  const owners = new Map<string, string>()
  for (const { record } of records.values()) {
    for (const [kind, value] of [
      ["launch", record.claim.launch_id],
      ["worktree", record.claim.worktree_id],
      ["agent", record.claim.agent_id],
      ["directory", record.claim.planned_worktree.directory],
    ] as const) {
      const key = `${kind}:${value}`
      const owner = owners.get(key)
      if (owner) throw new EnsureLifecycleLedgerError("corrupt_record", `${kind} ${value} is owned by ${owner} and ${record.claim.ensure_id}`)
      owners.set(key, record.claim.ensure_id)
    }
  }
}

function stateForEffects(effects: EnsureEffects, claim: EnsureRequest): EnsureTransactionState {
  const validation = ensureLifecycleMessageSchema.safeParse({
    schema_id: ENSURE_LIFECYCLE_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "ensure_receipt",
    request_id: claim.request_id,
    receipt_id: "ledger-validation",
    receipt_digest: "0".repeat(64),
    workplace_instance_id: claim.workplace_instance_id,
    fmx_session: claim.fmx_session,
    ensure_id: claim.ensure_id,
    ensure_digest: claim.ensure_digest,
    launch_id: claim.launch_id,
    launch_digest: claim.launch_digest,
    worktree_id: claim.worktree_id,
    agent_id: claim.agent_id,
    status: "in_progress",
    effects,
  })
  if (!validation.success || validation.data.message_type !== "ensure_receipt") {
    throw new EnsureLifecycleLedgerError("corrupt_record", `invalid durable effects: ${validation.error?.issues[0]?.message ?? "wrong shape"}`)
  }
  const value = validation.data.effects
  const expectedSession = `fmx-${claim.agent_id}`
  const expectedPane = `p_${claim.agent_id}`
  if (value.worktree.directory !== claim.planned_worktree.directory) {
    throw new EnsureLifecycleLedgerError("corrupt_record", "durable Worktree effect changed its claimed directory")
  }
  if (value.companion.session_name !== expectedSession || value.companion.pane_id !== expectedPane) {
    throw new EnsureLifecycleLedgerError("corrupt_record", "durable Companion effect changed its claimed identity")
  }
  if (value.worktree.status === "planned") {
    if (value.manifest.status !== "pending" || value.companion.status !== "pending" || value.fx.status !== "pending") {
      throw new EnsureLifecycleLedgerError("corrupt_record", "durable effects skipped Worktree creation")
    }
    return "claimed"
  }
  if (value.manifest.status === "pending") {
    if (value.companion.status !== "pending" || value.fx.status !== "pending") {
      throw new EnsureLifecycleLedgerError("corrupt_record", "durable effects skipped Manifest claim")
    }
    return "worktree_created"
  }
  if (value.manifest.agent_id !== claim.agent_id) {
    throw new EnsureLifecycleLedgerError("corrupt_record", "durable Manifest effect changed its claimed Agent")
  }
  if (value.companion.status === "pending") {
    if (value.fx.status !== "pending") throw new EnsureLifecycleLedgerError("corrupt_record", "durable effects skipped Companion start")
    return "manifest_claimed"
  }
  if (value.fx.status === "pending") return "companion_started"
  return "fx_started"
}

function validateRecord(record: LedgerRecord, expectedHash: string): void {
  if (record.schema_id !== ENSURE_LEDGER_SCHEMA_ID || record.schema_version !== ENSURE_LEDGER_SCHEMA_VERSION) {
    throw new EnsureLifecycleLedgerError("corrupt_record", "unsupported ensure ledger record schema")
  }
  const claim = parseEnsureRequest(record.claim, "corrupt_record")
  verifyEnsureDigest(claim, "corrupt_record")
  if (recordNameHash(claim.ensure_id) !== expectedHash) {
    throw new EnsureLifecycleLedgerError("corrupt_record", `ensure ${claim.ensure_id} is stored under the wrong filename`)
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new EnsureLifecycleLedgerError("corrupt_record", "ensure ledger revision is invalid")
  }
  if (!(record.state in STATE_ORDER)) throw new EnsureLifecycleLedgerError("corrupt_record", "ensure ledger state is invalid")
  const effectState = stateForEffects(record.effects, claim)
  if (effectState !== record.state) throw new EnsureLifecycleLedgerError("corrupt_record", "ensure ledger state and effects disagree")
  if (!Array.isArray(record.receipts)) throw new EnsureLifecycleLedgerError("corrupt_record", "ensure ledger receipts are invalid")
  const receiptIds = new Set<string>()
  const acknowledgementIds = new Set<string>()
  let previousState = -1
  let acknowledgementCount = 0
  let finalCount = 0
  for (const retained of record.receipts) {
    if (!isRecord(retained) || !hasExactFields(retained, ["acknowledgement", "receipt"])) {
      throw new EnsureLifecycleLedgerError("corrupt_record", "retained ensure receipt entry is invalid")
    }
    const receipt = parseEnsureReceipt(retained.receipt, "corrupt_record")
    verifyReceiptDigest(receipt, "corrupt_record")
    assertReceiptCorrelationForRecord(claim, receipt)
    if (receiptIds.has(receipt.receipt_id)) throw new EnsureLifecycleLedgerError("corrupt_record", `duplicate receipt ${receipt.receipt_id}`)
    receiptIds.add(receipt.receipt_id)
    const receiptState = stateForEffects(receipt.effects, claim)
    const order = STATE_ORDER[receiptState]
    if (order < previousState || order > STATE_ORDER[record.state]) {
      throw new EnsureLifecycleLedgerError("corrupt_record", "retained ensure receipts regress or outrun durable effects")
    }
    previousState = order
    const expectedStatus = receiptState === "fx_started" ? "complete" : "in_progress"
    if (receipt.status !== expectedStatus) throw new EnsureLifecycleLedgerError("corrupt_record", "retained receipt status disagrees with effects")
    if (receipt.status === "complete" && ++finalCount > 1) throw new EnsureLifecycleLedgerError("corrupt_record", "multiple final ensure receipts")
    if (retained.acknowledgement !== null) {
      const acknowledgement = parseEnsureAcknowledgement(retained.acknowledgement, "corrupt_record")
      if (
        acknowledgement.ensure_id !== claim.ensure_id ||
        acknowledgement.receipt_id !== receipt.receipt_id ||
        acknowledgement.receipt_digest !== receipt.receipt_digest
      ) {
        throw new EnsureLifecycleLedgerError("corrupt_record", "retained acknowledgement does not cite its exact receipt")
      }
      if (acknowledgementIds.has(acknowledgement.acknowledgement_id)) {
        throw new EnsureLifecycleLedgerError("corrupt_record", `duplicate acknowledgement ${acknowledgement.acknowledgement_id}`)
      }
      acknowledgementIds.add(acknowledgement.acknowledgement_id)
      acknowledgementCount++
    }
  }
  const expectedRevision = 1 + STATE_ORDER[record.state] + record.receipts.length + acknowledgementCount
  if (record.revision !== expectedRevision) {
    throw new EnsureLifecycleLedgerError("corrupt_record", `ensure ledger revision ${record.revision} should be ${expectedRevision}`)
  }
}

function assertReceiptCorrelationForRecord(claim: EnsureRequest, receipt: EnsureReceipt): void {
  try {
    assertReceiptCorrelation(claim, receipt)
  } catch (error) {
    throw new EnsureLifecycleLedgerError("corrupt_record", errorMessage(error))
  }
}

async function readLedgerFile(path: string, expectedHash: string): Promise<StoredRecord> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    assertFileInfo(info, path)
    if (info.size < 2 || info.size > CONTRACT_MAX_FRAME_BYTES + 1) {
      throw new EnsureLifecycleLedgerError("corrupt_record", `ensure ledger record ${path} has invalid size ${info.size}`)
    }
    const bytes = await handle.readFile()
    if (bytes.at(-1) !== 0x0a) throw new EnsureLifecycleLedgerError("corrupt_record", `ensure ledger record ${path} lacks one final LF`)
    const payload = bytes.subarray(0, -1)
    const value = decodeStrictJson(payload)
    if (!Buffer.from(encodeCanonicalJson(value)).equals(payload)) {
      throw new EnsureLifecycleLedgerError("corrupt_record", `ensure ledger record ${path} is not canonical JSON`)
    }
    if (!isRecord(value) || !hasExactFields(value, [
      "claim",
      "effects",
      "receipts",
      "revision",
      "schema_id",
      "schema_version",
      "state",
    ])) {
      throw new EnsureLifecycleLedgerError("corrupt_record", `ensure ledger record ${path} has unknown or missing fields`)
    }
    const record = value as unknown as LedgerRecord
    validateRecord(record, expectedHash)
    return { record: structuredClone(record), identity: { dev: info.dev, ino: info.ino } }
  } catch (error) {
    if (error instanceof EnsureLifecycleLedgerError) throw error
    throw new EnsureLifecycleLedgerError("corrupt_record", `cannot read ensure ledger record ${path}: ${errorMessage(error)}`)
  } finally {
    await handle?.close()
  }
}

async function assertPrivateRegularFile(path: string, label: string): Promise<void> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    assertFileInfo(info, `${label} ${path}`)
  } catch (error) {
    if (error instanceof EnsureLifecycleLedgerError) throw error
    throw new EnsureLifecycleLedgerError("storage_unsafe", `${label} is unsafe: ${errorMessage(error)}`)
  } finally {
    await handle?.close()
  }
}

function assertFileInfo(info: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, label: string): void {
  if (!info.isFile()) throw new EnsureLifecycleLedgerError("storage_unsafe", `${label} is not a regular file`)
  if (info.uid !== userInfo().uid) throw new EnsureLifecycleLedgerError("storage_unsafe", `${label} has a foreign owner`)
  if ((info.mode & 0o777) !== FILE_MODE) throw new EnsureLifecycleLedgerError("storage_unsafe", `${label} must have mode 0600`)
  if (info.nlink !== 1) throw new EnsureLifecycleLedgerError("storage_unsafe", `${label} must have exactly one link`)
}

async function assertTargetIdentity(path: string, expected: FileIdentity | null): Promise<void> {
  try {
    const info = await lstat(path)
    if (!expected) throw new EnsureLifecycleLedgerError("storage_unsafe", `ensure ledger target ${path} appeared concurrently`)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.dev !== expected.dev || info.ino !== expected.ino) {
      throw new EnsureLifecycleLedgerError("storage_unsafe", `ensure ledger target ${path} changed before replacement`)
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      if (expected) throw new EnsureLifecycleLedgerError("storage_unsafe", `ensure ledger target ${path} disappeared`)
      return
    }
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function assertEnsureId(value: string): void {
  if (!SAFE_TOKEN.test(value)) throw new EnsureLifecycleLedgerError("unknown_transaction", "ensure id is invalid")
}

function recordNameHash(ensureId: string): string {
  return sha256(Buffer.from(ensureId, "utf8"))
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function sameJson(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalJson(left as JsonValue)).equals(Buffer.from(encodeCanonicalJson(right as JsonValue)))
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...fields].sort().join("\0")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

