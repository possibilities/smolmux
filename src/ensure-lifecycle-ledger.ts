import { createHash, randomBytes } from "node:crypto"
import { constants, fstatSync, type Stats } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, isAbsolute, normalize, resolve } from "node:path"
import * as z from "zod/v4"
import {
  ensureLifecycleMessageSchema,
  fxLaunchAdmissionFinalMessageSchema,
  isAgentWorkplaceConversationId,
  type EnsureLifecycleMessage,
  type FxLaunchAdmissionFinalMessage,
} from "./agentworkplace-contracts.ts"
import { identityFor } from "./agent-manifest.ts"
import {
  CONTRACT_MAX_FRAME_BYTES,
  decodeStrictJson,
  encodeCanonicalJson,
  type JsonValue,
} from "./contract-codec.ts"
import { acquireExclusiveLock, type HeldLock } from "./file-lock.ts"
import {
  managedLaunchAcknowledgementSchema,
  managedLaunchOutcomeSchema,
  managedLaunchRequestSchema,
  managedLaunchRetrySchema,
  parseManagedLaunchAcknowledgement,
  parseManagedLaunchOutcome,
  parseManagedLaunchRequest,
  parseManagedLaunchRetry,
  type ManagedLaunchAcknowledgement,
  type ManagedLaunchOutcome,
  type ManagedLaunchRequest,
  type ManagedLaunchRetry,
} from "./managed-launch-contract.ts"

const LEDGER_SCHEMA_ID = "fmx.ensure-lifecycle-ledger"
const LEDGER_SCHEMA_VERSION = 3
const MANAGED_LEDGER_SCHEMA_VERSION = 4
const LOCK_FILE = ".ensure-lifecycle.lock"
const RECORD_FILE = /^[0-9a-f]{64}\.json$/u
const TEMPORARY_FILE = /^[0-9a-f]{64}\.json\.[0-9]+\.[0-9a-f]{16}\.tmp$/u
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const SAFE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const STAGES = [
  "claimed",
  "worktree_created",
  "manifest_claimed",
  "companion_started",
  "fx_started",
] as const
const MANAGED_STAGES = [
  "claimed",
  "directory_validated",
  "manifest_claimed",
  "companion_started",
  "fx_started",
] as const

export type EnsureLifecycleStage = (typeof STAGES)[number]
export type ManagedLaunchLedgerStage = (typeof MANAGED_STAGES)[number]
type LiteralMessage<Shape, Type extends string> = Shape extends unknown
  ? Omit<Shape, "message_type"> & { message_type: Type }
  : never

export type EnsureRequest = LiteralMessage<
  Extract<EnsureLifecycleMessage, { planned_worktree: unknown }>,
  "ensure_request"
>
export type EnsureReceipt = LiteralMessage<
  Extract<EnsureLifecycleMessage, { effects: unknown }>,
  "ensure_receipt"
>
export type EnsureReceiptAcknowledgement = LiteralMessage<
  Extract<EnsureLifecycleMessage, { acknowledgement_id: unknown }>,
  "receipt_acknowledgement"
>
export type FxFinalReceipt = LiteralMessage<
  Extract<FxLaunchAdmissionFinalMessage, { outcome: unknown }>,
  "final_receipt"
>
export type FxAdmissionDecision = LiteralMessage<
  Extract<FxLaunchAdmissionFinalMessage, { decision: unknown }>,
  "admission_decision"
>
export type FxFinalReceiptAcknowledgement = LiteralMessage<
  Extract<FxLaunchAdmissionFinalMessage, { acknowledgement_id: unknown }>,
  "final_receipt_acknowledgement"
>

export type FxFinalReceiptAuthorityBinding = {
  admission_key: string
  state_root: string
}

export type FxFinalReceiptTransaction = {
  binding: FxFinalReceiptAuthorityBinding | null
  receipt: FxFinalReceipt | null
  acknowledgement: FxFinalReceiptAcknowledgement | null
  acknowledgement_applied: boolean
}

export interface FxFinalReceiptAuthority {
  acknowledge(
    binding: Readonly<FxFinalReceiptAuthorityBinding>,
    acknowledgement: Readonly<FxFinalReceiptAcknowledgement>,
  ): Promise<void>
}

export type EnsureLifecycleEffects = EnsureReceipt["effects"]

export type EnsureLifecycleRecord = {
  schema_id: typeof LEDGER_SCHEMA_ID
  schema_version: typeof LEDGER_SCHEMA_VERSION
  revision: number
  request: EnsureRequest
  stage: EnsureLifecycleStage
  effects: EnsureLifecycleEffects
  receipts: EnsureReceipt[]
  acknowledgements: EnsureReceiptAcknowledgement[]
  /** Fx's immutable positive-or-negative keyed decision, retained locally forever. */
  fx_admission_decision: FxAdmissionDecision | null
  fx_final: FxFinalReceiptTransaction
}

export type ManagedLaunchEffects = {
  workspace:
    | {
        status: "pending"
        kind: "existing_directory"
        directory: string
        repository: string
        checkout_root: string
        head_commit: string
      }
    | {
        status: "validated"
        kind: "existing_directory"
        directory: string
        repository: string
        checkout_root: string
        head_commit: string
      }
  manifest: EnsureLifecycleEffects["manifest"]
  companion: EnsureLifecycleEffects["companion"]
  fx: EnsureLifecycleEffects["fx"]
}

export type ManagedLaunchOutcomeTransaction = {
  receipt: ManagedLaunchOutcome | null
  acknowledgement: ManagedLaunchAcknowledgement | null
}

/**
 * Additive existing-directory launch transaction stored beside, but never
 * translated into, the frozen schema-v1 Worktree transaction.
 */
export type ManagedLaunchRecord = {
  schema_id: typeof LEDGER_SCHEMA_ID
  schema_version: typeof MANAGED_LEDGER_SCHEMA_VERSION
  revision: number
  request: ManagedLaunchRequest
  stage: ManagedLaunchLedgerStage
  effects: ManagedLaunchEffects
  /** Provider-reserved Conversation, persisted before the Companion can start. */
  prepared_conversation_id: string | null
  attempt: number
  outcome_history: Array<{
    receipt: ManagedLaunchOutcome
    acknowledgement: ManagedLaunchAcknowledgement
    retry: ManagedLaunchRetry
  }>
  outcome: ManagedLaunchOutcomeTransaction
  fx_admission_decision: FxAdmissionDecision | null
  fx_final: FxFinalReceiptTransaction
}

export type LifecycleLedgerRecord = EnsureLifecycleRecord | ManagedLaunchRecord

export type EnsureLifecycleTransition =
  | {
      kind: "worktree_created"
      directory: string
      head_commit: string
    }
  | {
      kind: "manifest_claimed"
      agent_id: string
    }
  | {
      kind: "companion_started"
      session_name: string
      pane_id: string
    }
  | {
      kind: "fx_started"
      conversation_id: string
    }

export type ManagedLaunchTransition =
  | {
      kind: "directory_validated"
      directory: string
      repository: string
      checkout_root: string
      head_commit: string
    }
  | Exclude<EnsureLifecycleTransition, { kind: "worktree_created" }>

export type EnsureLifecycleLedgerFaultPoint =
  | "before_write"
  | "after_file_sync"
  | "before_rename"
  | "after_rename"
  | "after_directory_sync"

export type EnsureLifecycleLedgerOptions = {
  fault?: (
    point: EnsureLifecycleLedgerFaultPoint,
    record: Readonly<EnsureLifecycleRecord>,
  ) => void | Promise<void>
  managedFault?: (
    point: EnsureLifecycleLedgerFaultPoint,
    record: Readonly<ManagedLaunchRecord>,
  ) => void | Promise<void>
  uid?: number
  lockAttempts?: number
  lockDelayMs?: number
}

export type EnsureLifecycleLedgerErrorCode =
  | "acknowledgement_conflict"
  | "conflicting_claim"
  | "corrupt_record"
  | "invalid_acknowledgement"
  | "invalid_request"
  | "invalid_root"
  | "invalid_transition"
  | "lock_unavailable"
  | "receipt_conflict"
  | "unsafe_storage"

export class EnsureLifecycleLedgerError extends Error {
  constructor(
    readonly code: EnsureLifecycleLedgerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "EnsureLifecycleLedgerError"
  }
}

const worktreeEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("planned"), directory: z.string() }),
  z.strictObject({
    status: z.literal("created"),
    directory: z.string(),
    head_commit: z.string().regex(GIT_OBJECT_ID),
  }),
])

const manifestEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("claimed"), agent_id: z.string() }),
])

const companionEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    session_name: z.string(),
    pane_id: z.string(),
  }),
  z.strictObject({
    status: z.literal("started"),
    session_name: z.string(),
    pane_id: z.string(),
  }),
])

const fxEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("started"), conversation_id: z.string() }),
])

const fxFinalReceiptAuthorityBindingSchema = z.strictObject({
  admission_key: z.string().regex(SAFE_TOKEN),
  state_root: z.string(),
})

const managedWorkspaceEffectSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    kind: z.literal("existing_directory"),
    directory: z.string(),
    repository: z.string(),
    checkout_root: z.string(),
    head_commit: z.string().regex(GIT_OBJECT_ID),
  }),
  z.strictObject({
    status: z.literal("validated"),
    kind: z.literal("existing_directory"),
    directory: z.string(),
    repository: z.string(),
    checkout_root: z.string(),
    head_commit: z.string().regex(GIT_OBJECT_ID),
  }),
])

const privateRecordSchema = z.strictObject({
  schema_id: z.literal(LEDGER_SCHEMA_ID),
  schema_version: z.literal(LEDGER_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  request: ensureLifecycleMessageSchema,
  stage: z.enum(STAGES),
  effects: z.strictObject({
    worktree: worktreeEffectSchema,
    manifest: manifestEffectSchema,
    companion: companionEffectSchema,
    fx: fxEffectSchema,
  }),
  receipts: z.array(ensureLifecycleMessageSchema).max(4096),
  acknowledgements: z.array(ensureLifecycleMessageSchema).max(4096),
  fx_admission_decision: z.unknown().nullable(),
  fx_final: z.strictObject({
    binding: fxFinalReceiptAuthorityBindingSchema.nullable(),
    receipt: z.unknown().nullable(),
    acknowledgement: z.unknown().nullable(),
    acknowledgement_applied: z.boolean(),
  }),
})

const managedPrivateRecordSchema = z.strictObject({
  schema_id: z.literal(LEDGER_SCHEMA_ID),
  schema_version: z.literal(MANAGED_LEDGER_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  request: managedLaunchRequestSchema,
  stage: z.enum(MANAGED_STAGES),
  effects: z.strictObject({
    workspace: managedWorkspaceEffectSchema,
    manifest: manifestEffectSchema,
    companion: companionEffectSchema,
    fx: fxEffectSchema,
  }),
  prepared_conversation_id: z.string().nullable(),
  attempt: z.number().int().positive().max(4096),
  outcome_history: z.array(z.strictObject({
    receipt: managedLaunchOutcomeSchema,
    acknowledgement: managedLaunchAcknowledgementSchema,
    retry: managedLaunchRetrySchema,
  })).max(4095),
  outcome: z.strictObject({
    receipt: managedLaunchOutcomeSchema.nullable(),
    acknowledgement: managedLaunchAcknowledgementSchema.nullable(),
  }),
  fx_admission_decision: z.unknown().nullable(),
  fx_final: z.strictObject({
    binding: fxFinalReceiptAuthorityBindingSchema.nullable(),
    receipt: z.unknown().nullable(),
    acknowledgement: z.unknown().nullable(),
    acknowledgement_applied: z.boolean(),
  }),
})

type RecordIndex = {
  byEnsureId: Map<string, EnsureLifecycleRecord>
  managedByEnsureId: Map<string, ManagedLaunchRecord>
  identities: Map<string, Stats>
  records: EnsureLifecycleRecord[]
  managedRecords: ManagedLaunchRecord[]
}

type StorageGuard = {
  directory: FileHandle
  lock: HeldLock
  lockIdentity: Stats
  rootIdentity: Stats
}

/**
 * Private durable authority for one Runtime's recoverable ensure effects.
 *
 * This store deliberately does not extend the frozen public lifecycle wire.
 * It records already-versioned request/receipt envelopes, the private Fx
 * authority binding, and opaque effect/application facts. All mutations are
 * serialized, flocked across store instances, and made durable before their
 * promises resolve.
 */
export class EnsureLifecycleLedger {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly uid: number
  private readonly fault: NonNullable<EnsureLifecycleLedgerOptions["fault"]> | null
  private readonly managedFault:
    NonNullable<EnsureLifecycleLedgerOptions["managedFault"]> | null
  private readonly lockAttempts: number
  private readonly lockDelayMs: number

  private constructor(
    readonly root: string,
    options: EnsureLifecycleLedgerOptions,
  ) {
    this.uid = options.uid ?? userInfo().uid
    this.fault = options.fault ?? null
    this.managedFault = options.managedFault ?? null
    this.lockAttempts = options.lockAttempts ?? 1000
    this.lockDelayMs = options.lockDelayMs ?? 2
  }

  static async open(
    root: string,
    options: EnsureLifecycleLedgerOptions = {},
  ): Promise<EnsureLifecycleLedger> {
    assertRootPath(root)
    const ledger = new EnsureLifecycleLedger(root, options)
    await ledger.serial(() => ledger.withLock(async (guard) => {
      await ledger.readIndex(guard)
    }))
    return ledger
  }

  claim(requestInput: EnsureRequest): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const request = parseEnsureRequest(requestInput)
      const index = await this.readIndex(guard)
      if (index.managedByEnsureId.has(request.ensure_id)) {
        throw ledgerError(
          "conflicting_claim",
          `ensure id ${request.ensure_id} is already bound to a managed launch request`,
        )
      }
      const existing = index.byEnsureId.get(request.ensure_id)
      if (existing) {
        if (!sameEnsureClaim(existing.request, request)) {
          throw ledgerError(
            "conflicting_claim",
            `ensure id ${request.ensure_id} is already bound to a different immutable request`,
          )
        }
        return copyRecord(existing)
      }
      assertSecondaryClaimsAvailable(index.records, request)
      assertCrossClaimAvailable(index.managedRecords, request)
      const record: EnsureLifecycleRecord = {
        schema_id: LEDGER_SCHEMA_ID,
        schema_version: LEDGER_SCHEMA_VERSION,
        revision: 1,
        request,
        stage: "claimed",
        effects: effectsForClaim(request),
        receipts: [],
        acknowledgements: [],
        fx_admission_decision: null,
        fx_final: emptyFxFinalReceiptTransaction(),
      }
      await this.writeRecord(record, guard, null)
      return copyRecord(record)
    }))
  }

  claimManaged(requestInput: ManagedLaunchRequest): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const request = parseManagedLaunchRequest(requestInput)
      const index = await this.readIndex(guard)
      if (index.byEnsureId.has(request.ensure_id)) {
        throw ledgerError(
          "conflicting_claim",
          `ensure id ${request.ensure_id} is already bound to a frozen lifecycle request`,
        )
      }
      const existing = index.managedByEnsureId.get(request.ensure_id)
      if (existing !== undefined) {
        if (!sameCanonical(existing.request, request)) {
          throw ledgerError(
            "conflicting_claim",
            `ensure id ${request.ensure_id} is already bound to different managed launch bytes`,
          )
        }
        return copyManagedRecord(existing)
      }
      assertManagedSecondaryClaimsAvailable(index, request)
      const record: ManagedLaunchRecord = {
        schema_id: LEDGER_SCHEMA_ID,
        schema_version: MANAGED_LEDGER_SCHEMA_VERSION,
        revision: 1,
        request,
        stage: "claimed",
        effects: managedEffectsForClaim(request),
        prepared_conversation_id: null,
        attempt: 1,
        outcome_history: [],
        outcome: { receipt: null, acknowledgement: null },
        fx_admission_decision: null,
        fx_final: emptyFxFinalReceiptTransaction(),
      }
      await this.writeLedgerRecord(record, guard, null)
      return copyManagedRecord(record)
    }))
  }

  get(ensureId: string): Promise<EnsureLifecycleRecord | null> {
    return this.serial(() => this.withLock(async (guard) => {
      const record = (await this.readIndex(guard)).byEnsureId.get(ensureId)
      return record ? copyRecord(record) : null
    }))
  }

  list(): Promise<EnsureLifecycleRecord[]> {
    return this.serial(() => this.withLock(async (guard) =>
      (await this.readIndex(guard)).records.map(copyRecord)))
  }

  getManaged(ensureId: string): Promise<ManagedLaunchRecord | null> {
    return this.serial(() => this.withLock(async (guard) => {
      const record = (await this.readIndex(guard)).managedByEnsureId.get(ensureId)
      return record ? copyManagedRecord(record) : null
    }))
  }

  listManaged(): Promise<ManagedLaunchRecord[]> {
    return this.serial(() => this.withLock(async (guard) =>
      (await this.readIndex(guard)).managedRecords.map(copyManagedRecord)))
  }

  /** One lock-held snapshot across both frozen and managed lifecycle schemas. */
  listAll(): Promise<LifecycleLedgerRecord[]> {
    return this.serial(() => this.withLock(async (guard) => {
      const index = await this.readIndex(guard)
      return [
        ...index.records.map(copyRecord),
        ...index.managedRecords.map(copyManagedRecord),
      ]
    }))
  }

  advance(ensureId: string, transition: EnsureLifecycleTransition): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const index = await this.readIndex(guard)
      const record = requireRecord(index, ensureId)
      const advanced = advanceRecord(record, transition)
      if (advanced === record) return copyRecord(record)
      await this.writeRecord(advanced, guard, requireRecordIdentity(index, ensureId))
      return copyRecord(advanced)
    }))
  }

  advanceManaged(
    ensureId: string,
    transition: ManagedLaunchTransition,
  ): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const index = await this.readIndex(guard)
      const record = requireManagedRecord(index, ensureId)
      const advanced = advanceManagedRecord(record, transition)
      if (advanced === record) return copyManagedRecord(record)
      await this.writeLedgerRecord(
        advanced,
        guard,
        requireRecordIdentity(index, ensureId),
      )
      return copyManagedRecord(advanced)
    }))
  }

  retainManagedOutcome(
    ensureId: string,
    outcomeInput: ManagedLaunchOutcome,
  ): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const outcome = parseManagedLaunchOutcome(outcomeInput)
      const index = await this.readIndex(guard)
      const record = requireManagedRecord(index, ensureId)
      if (record.outcome.receipt !== null) {
        if (!sameCanonical(record.outcome.receipt, outcome)) {
          throw ledgerError(
            "receipt_conflict",
            `managed launch ${ensureId} already retains another outcome`,
          )
        }
        return copyManagedRecord(record)
      }
      assertManagedOutcomeCorrelation(record, outcome)
      assertAnyReceiptIdAvailable(index, outcome.receipt_id)
      const next = copyManagedRecord(record)
      next.revision++
      next.outcome.receipt = outcome
      validateManagedRecord(next, recordPathFor(this.root, ensureId))
      await this.writeLedgerRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyManagedRecord(next)
    }))
  }

  acknowledgeManagedOutcome(
    acknowledgementInput: ManagedLaunchAcknowledgement,
  ): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const acknowledgement = parseManagedLaunchAcknowledgement(acknowledgementInput)
      const index = await this.readIndex(guard)
      const record = requireManagedRecord(index, acknowledgement.ensure_id)
      if (record.outcome.acknowledgement !== null) {
        if (!sameCanonical(record.outcome.acknowledgement, acknowledgement)) {
          throw ledgerError(
            "acknowledgement_conflict",
            `managed launch ${record.request.ensure_id} already retains another acknowledgement`,
          )
        }
        return copyManagedRecord(record)
      }
      assertManagedAcknowledgementCorrelation(record, acknowledgement)
      assertAnyAcknowledgementIdAvailable(index, acknowledgement.acknowledgement_id)
      const next = copyManagedRecord(record)
      next.revision++
      next.outcome.acknowledgement = acknowledgement
      validateManagedRecord(next, recordPathFor(this.root, acknowledgement.ensure_id))
      await this.writeLedgerRecord(
        next,
        guard,
        requireRecordIdentity(index, acknowledgement.ensure_id),
      )
      return copyManagedRecord(next)
    }))
  }

  retryManaged(retryInput: ManagedLaunchRetry): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const retry = parseManagedLaunchRetry(retryInput)
      const index = await this.readIndex(guard)
      const record = requireManagedRecord(index, retry.ensure_id)
      if (retry.next_attempt <= record.attempt) {
        if (managedRetryMatches(record, retry)) return copyManagedRecord(record)
        throw ledgerError("conflicting_claim", "managed retry conflicts with the current attempt")
      }
      assertManagedRetryCorrelation(record, retry)
      const next = copyManagedRecord(record)
      next.revision++
      next.outcome_history.push({
        receipt: structuredClone(record.outcome.receipt!),
        acknowledgement: structuredClone(record.outcome.acknowledgement!),
        retry,
      })
      next.attempt = retry.next_attempt
      next.outcome = { receipt: null, acknowledgement: null }
      validateManagedRecord(next, recordPathFor(this.root, retry.ensure_id))
      await this.writeLedgerRecord(next, guard, requireRecordIdentity(index, retry.ensure_id))
      return copyManagedRecord(next)
    }))
  }

  /**
   * Retain Fx's exact caller-keyed admission winner before interpreting it.
   * A negative winner is the private terminal launch tombstone; recovery may
   * retry retirement but can never re-enter the spawn path.
   */
  retainFxAdmissionDecision(
    ensureId: string,
    decisionInput: FxAdmissionDecision,
  ): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const decision = parseFxAdmissionDecision(decisionInput)
      const index = await this.readIndex(guard)
      const record = requireRecord(index, ensureId)
      if (record.fx_admission_decision !== null) {
        if (!sameCanonical(record.fx_admission_decision, decision)) {
          throw ledgerError(
            "receipt_conflict",
            `ensure ${ensureId} already retains another Fx admission decision`,
          )
        }
        return copyRecord(record)
      }
      assertFxAdmissionDecisionCorrelation(record, decision, "receipt_conflict")
      assertReceiptIdAvailable(index.records, decision.receipt_id)
      const next = copyRecord(record)
      next.revision++
      next.fx_admission_decision = decision
      validateRecord(next, recordPathFor(this.root, ensureId))
      await this.writeRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyRecord(next)
    }))
  }

  retainManagedFxAdmissionDecision(
    ensureId: string,
    decisionInput: FxAdmissionDecision,
  ): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const decision = parseFxAdmissionDecision(decisionInput)
      const index = await this.readIndex(guard)
      const record = requireManagedRecord(index, ensureId)
      if (record.fx_admission_decision !== null) {
        if (!sameCanonical(record.fx_admission_decision, decision)) {
          throw ledgerError(
            "receipt_conflict",
            `managed launch ${ensureId} already retains another Fx admission decision`,
          )
        }
        return copyManagedRecord(record)
      }
      assertManagedFxAdmissionDecisionCorrelation(record, decision, "receipt_conflict")
      assertAnyReceiptIdAvailable(index, decision.receipt_id)
      const next = copyManagedRecord(record)
      next.revision++
      next.fx_admission_decision = decision
      validateManagedRecord(next, recordPathFor(this.root, ensureId))
      await this.writeLedgerRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyManagedRecord(next)
    }))
  }

  /**
   * Bind the exact Fx authority before the Companion can start the process.
   * The launch adapter supplies this private location/correlation; no
   * prompt or launch-control bytes enter this retention ledger.
   */
  bindFxFinalReceiptAuthority(
    ensureId: string,
    bindingInput: FxFinalReceiptAuthorityBinding,
  ): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const binding = parseFxFinalReceiptAuthorityBinding(bindingInput)
      const index = await this.readIndex(guard)
      const record = requireRecord(index, ensureId)
      if (record.fx_final.binding !== null) {
        if (!sameCanonical(record.fx_final.binding, binding)) {
          throw ledgerError(
            "receipt_conflict",
            `ensure ${ensureId} is already bound to another Fx final-receipt authority`,
          )
        }
        return copyRecord(record)
      }
      if (STAGES.indexOf(record.stage) >= STAGES.indexOf("companion_started")) {
        throw ledgerError(
          "invalid_transition",
          `ensure ${ensureId} cannot bind Fx final-receipt authority after ${record.stage}`,
        )
      }
      for (const candidate of index.records) {
        if (candidate.fx_final.binding?.admission_key === binding.admission_key) {
          throw ledgerError(
            "receipt_conflict",
            `Fx admission key ${binding.admission_key} belongs to another ensure`,
          )
        }
      }
      const next = copyRecord(record)
      next.revision++
      next.fx_final.binding = binding
      validateRecord(next, recordPathFor(this.root, ensureId))
      await this.writeRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyRecord(next)
    }))
  }

  bindManagedFxFinalReceiptAuthority(
    ensureId: string,
    bindingInput: FxFinalReceiptAuthorityBinding,
  ): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const binding = parseFxFinalReceiptAuthorityBinding(bindingInput)
      const index = await this.readIndex(guard)
      const record = requireManagedRecord(index, ensureId)
      if (record.fx_final.binding !== null) {
        if (!sameCanonical(record.fx_final.binding, binding)) {
          throw ledgerError(
            "receipt_conflict",
            `managed launch ${ensureId} is already bound to another Fx final authority`,
          )
        }
        return copyManagedRecord(record)
      }
      if (MANAGED_STAGES.indexOf(record.stage) >= MANAGED_STAGES.indexOf("companion_started")) {
        throw ledgerError(
          "invalid_transition",
          `managed launch ${ensureId} cannot bind Fx final authority after ${record.stage}`,
        )
      }
      for (const candidate of [...index.records, ...index.managedRecords]) {
        if (candidate.fx_final.binding?.admission_key === binding.admission_key) {
          throw ledgerError(
            "receipt_conflict",
            `Fx admission key ${binding.admission_key} belongs to another ensure`,
          )
        }
      }
      const next = copyManagedRecord(record)
      next.revision++
      next.fx_final.binding = binding
      validateManagedRecord(next, recordPathFor(this.root, ensureId))
      await this.writeLedgerRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyManagedRecord(next)
    }))
  }

  /** Persist Fx's exact reserved Conversation before any Companion effect. */
  retainManagedPreparedConversation(
    ensureId: string,
    conversationId: string,
  ): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      if (!isAgentWorkplaceConversationId(conversationId)) {
        throw ledgerError("invalid_transition", "managed prepared Conversation is invalid")
      }
      const index = await this.readIndex(guard)
      const record = requireManagedRecord(index, ensureId)
      if (record.prepared_conversation_id !== null) {
        if (record.prepared_conversation_id !== conversationId) {
          throw ledgerError("receipt_conflict", "managed launch already retains another prepared Conversation")
        }
        return copyManagedRecord(record)
      }
      if (record.stage !== "manifest_claimed") {
        throw ledgerError(
          "invalid_transition",
          `managed launch ${ensureId} cannot prepare a Conversation after ${record.stage}`,
        )
      }
      const expected = record.request.fx_conversation.resume_conversation_id
      if (expected !== null && expected !== conversationId) {
        throw ledgerError("receipt_conflict", "managed launch changed its exact resume Conversation")
      }
      const next = copyManagedRecord(record)
      next.revision++
      next.prepared_conversation_id = conversationId
      validateManagedRecord(next, recordPathFor(this.root, ensureId))
      await this.writeLedgerRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyManagedRecord(next)
    }))
  }

  /** Retain the exact Fx-owned terminal receipt after Fx has durably produced it. */
  retainFxFinalReceipt(
    ensureId: string,
    receiptInput: FxFinalReceipt,
  ): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const receipt = parseFxFinalReceipt(receiptInput)
      const index = await this.readIndex(guard)
      const record = requireRecord(index, ensureId)
      if (record.fx_final.receipt !== null) {
        if (!sameCanonical(record.fx_final.receipt, receipt)) {
          throw ledgerError(
            "receipt_conflict",
            `ensure ${ensureId} already retains a different Fx final receipt`,
          )
        }
        return copyRecord(record)
      }
      assertFxFinalReceiptCorrelation(record, receipt, "receipt_conflict")
      assertAnyReceiptIdAvailable(index, receipt.receipt_id)
      const next = copyRecord(record)
      next.revision++
      next.fx_final.receipt = receipt
      validateRecord(next, recordPathFor(this.root, ensureId))
      await this.writeRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyRecord(next)
    }))
  }

  /** Retain the same Fx-owned terminal receipt for a managed launch record. */
  retainManagedFxFinalReceipt(
    ensureId: string,
    receiptInput: FxFinalReceipt,
  ): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const receipt = parseFxFinalReceipt(receiptInput)
      const index = await this.readIndex(guard)
      const record = requireManagedRecord(index, ensureId)
      if (record.fx_final.receipt !== null) {
        if (!sameCanonical(record.fx_final.receipt, receipt)) {
          throw ledgerError(
            "receipt_conflict",
            `managed launch ${ensureId} already retains a different Fx final receipt`,
          )
        }
        return copyManagedRecord(record)
      }
      assertManagedFxFinalReceiptCorrelation(record, receipt, "receipt_conflict")
      assertAnyReceiptIdAvailable(index, receipt.receipt_id)
      const next = copyManagedRecord(record)
      next.revision++
      next.fx_final.receipt = receipt
      validateManagedRecord(next, recordPathFor(this.root, ensureId))
      await this.writeLedgerRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyManagedRecord(next)
    }))
  }

  /**
   * Persist the exact acknowledgement before asking Fx to apply it. A crash
   * after the external authority commits is recovered by replaying these same
   * bytes and id, which Fx defines as idempotent.
   */
  prepareFxFinalReceiptAcknowledgement(
    ensureId: string,
    acknowledgementInput: FxFinalReceiptAcknowledgement,
  ): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const acknowledgement = parseFxFinalReceiptAcknowledgement(acknowledgementInput)
      const index = await this.readIndex(guard)
      const record = requireRecord(index, ensureId)
      if (record.fx_final.acknowledgement !== null) {
        if (!sameCanonical(record.fx_final.acknowledgement, acknowledgement)) {
          throw ledgerError(
            "acknowledgement_conflict",
            `ensure ${ensureId} already retains another Fx final acknowledgement`,
          )
        }
        return copyRecord(record)
      }
      assertFxFinalAcknowledgementCorrelation(record, acknowledgement, "invalid_acknowledgement")
      assertAnyAcknowledgementIdAvailable(index, acknowledgement.acknowledgement_id)
      const next = copyRecord(record)
      next.revision++
      next.fx_final.acknowledgement = acknowledgement
      validateRecord(next, recordPathFor(this.root, ensureId))
      await this.writeRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyRecord(next)
    }))
  }

  prepareManagedFxFinalReceiptAcknowledgement(
    ensureId: string,
    acknowledgementInput: FxFinalReceiptAcknowledgement,
  ): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const acknowledgement = parseFxFinalReceiptAcknowledgement(acknowledgementInput)
      const index = await this.readIndex(guard)
      const record = requireManagedRecord(index, ensureId)
      if (record.fx_final.acknowledgement !== null) {
        if (!sameCanonical(record.fx_final.acknowledgement, acknowledgement)) {
          throw ledgerError(
            "acknowledgement_conflict",
            `managed launch ${ensureId} already retains another Fx final acknowledgement`,
          )
        }
        return copyManagedRecord(record)
      }
      assertManagedFxFinalAcknowledgementCorrelation(
        record,
        acknowledgement,
        "invalid_acknowledgement",
      )
      assertAnyAcknowledgementIdAvailable(index, acknowledgement.acknowledgement_id)
      const next = copyManagedRecord(record)
      next.revision++
      next.fx_final.acknowledgement = acknowledgement
      validateManagedRecord(next, recordPathFor(this.root, ensureId))
      await this.writeLedgerRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyManagedRecord(next)
    }))
  }

  /** Record that the exact durable Fx authority accepted the retained acknowledgement. */
  private markFxFinalReceiptAcknowledgementApplied(
    ensureId: string,
    acknowledgementId: string,
  ): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      if (!isSafeToken(acknowledgementId)) {
        throw ledgerError("invalid_acknowledgement", "Fx final acknowledgement id is invalid")
      }
      const index = await this.readIndex(guard)
      const record = requireRecord(index, ensureId)
      if (record.fx_final.acknowledgement?.acknowledgement_id !== acknowledgementId) {
        throw ledgerError(
          "invalid_acknowledgement",
          `ensure ${ensureId} has no matching durable Fx final acknowledgement intent`,
        )
      }
      if (record.fx_final.acknowledgement_applied) return copyRecord(record)
      const next = copyRecord(record)
      next.revision++
      next.fx_final.acknowledgement_applied = true
      validateRecord(next, recordPathFor(this.root, ensureId))
      await this.writeRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyRecord(next)
    }))
  }

  private markManagedFxFinalReceiptAcknowledgementApplied(
    ensureId: string,
    acknowledgementId: string,
  ): Promise<ManagedLaunchRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      if (!isSafeToken(acknowledgementId)) {
        throw ledgerError("invalid_acknowledgement", "Fx final acknowledgement id is invalid")
      }
      const index = await this.readIndex(guard)
      const record = requireManagedRecord(index, ensureId)
      if (record.fx_final.acknowledgement?.acknowledgement_id !== acknowledgementId) {
        throw ledgerError(
          "invalid_acknowledgement",
          `managed launch ${ensureId} has no matching durable Fx final acknowledgement intent`,
        )
      }
      if (record.fx_final.acknowledgement_applied) return copyManagedRecord(record)
      const next = copyManagedRecord(record)
      next.revision++
      next.fx_final.acknowledgement_applied = true
      validateManagedRecord(next, recordPathFor(this.root, ensureId))
      await this.writeLedgerRecord(next, guard, requireRecordIdentity(index, ensureId))
      return copyManagedRecord(next)
    }))
  }

  /** Execute the durable intent -> exact external ack -> local completion transaction. */
  async acknowledgeFxFinalReceipt(
    ensureId: string,
    acknowledgementInput: FxFinalReceiptAcknowledgement,
    authority: FxFinalReceiptAuthority,
  ): Promise<EnsureLifecycleRecord> {
    const prepared = await this.prepareFxFinalReceiptAcknowledgement(
      ensureId,
      acknowledgementInput,
    )
    if (prepared.fx_final.acknowledgement_applied) return prepared
    const binding = prepared.fx_final.binding
    const acknowledgement = prepared.fx_final.acknowledgement
    if (binding === null || acknowledgement === null) {
      throw ledgerError(
        "corrupt_record",
        `ensure ${ensureId} lost its Fx final acknowledgement authority`,
      )
    }
    await authority.acknowledge(structuredClone(binding), structuredClone(acknowledgement))
    return this.markFxFinalReceiptAcknowledgementApplied(
      ensureId,
      acknowledgement.acknowledgement_id,
    )
  }

  /** Execute the same durable acknowledgement transaction for a managed launch. */
  async acknowledgeManagedFxFinalReceipt(
    ensureId: string,
    acknowledgementInput: FxFinalReceiptAcknowledgement,
    authority: FxFinalReceiptAuthority,
  ): Promise<ManagedLaunchRecord> {
    const prepared = await this.prepareManagedFxFinalReceiptAcknowledgement(
      ensureId,
      acknowledgementInput,
    )
    if (prepared.fx_final.acknowledgement_applied) return prepared
    const binding = prepared.fx_final.binding
    const acknowledgement = prepared.fx_final.acknowledgement
    if (binding === null || acknowledgement === null) {
      throw ledgerError(
        "corrupt_record",
        `managed launch ${ensureId} lost its Fx final acknowledgement authority`,
      )
    }
    await authority.acknowledge(structuredClone(binding), structuredClone(acknowledgement))
    return this.markManagedFxFinalReceiptAcknowledgementApplied(
      ensureId,
      acknowledgement.acknowledgement_id,
    )
  }

  retainEnsureReceipt(receiptInput: EnsureReceipt): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const receipt = parseEnsureReceipt(receiptInput)
      const index = await this.readIndex(guard)
      const record = requireRecord(index, receipt.ensure_id)
      const existing = record.receipts.find(({ receipt_id }) => receipt_id === receipt.receipt_id)
      if (existing) {
        if (!sameCanonical(existing, receipt)) {
          throw ledgerError(
            "receipt_conflict",
            `receipt id ${receipt.receipt_id} is already bound to different bytes`,
          )
        }
        return copyRecord(record)
      }
      assertReceiptCorrelation(record, receipt)
      assertReceiptIdAvailable(index.records, receipt.receipt_id)
      const next = copyRecord(record)
      next.revision++
      next.receipts.push(receipt)
      validateRecord(next, recordPathFor(this.root, receipt.ensure_id))
      await this.writeRecord(next, guard, requireRecordIdentity(index, receipt.ensure_id))
      return copyRecord(next)
    }))
  }

  acknowledgeEnsureReceipt(
    acknowledgementInput: EnsureReceiptAcknowledgement,
  ): Promise<EnsureLifecycleRecord> {
    return this.serial(() => this.withLock(async (guard) => {
      const acknowledgement = parseEnsureAcknowledgement(acknowledgementInput)
      const index = await this.readIndex(guard)
      const record = requireRecord(index, acknowledgement.ensure_id)
      const receipt = record.receipts.find(
        ({ receipt_id }) => receipt_id === acknowledgement.receipt_id,
      )
      if (!receipt || receipt.receipt_digest !== acknowledgement.receipt_digest) {
        throw ledgerError(
          "invalid_acknowledgement",
          `acknowledgement ${acknowledgement.acknowledgement_id} does not name an exact retained receipt`,
        )
      }
      const existing = record.acknowledgements.find(
        ({ acknowledgement_id }) => acknowledgement_id === acknowledgement.acknowledgement_id,
      )
      if (existing) {
        if (!sameCanonical(existing, acknowledgement)) {
          throw ledgerError(
            "acknowledgement_conflict",
            `acknowledgement id ${acknowledgement.acknowledgement_id} is already bound to different bytes`,
          )
        }
        return copyRecord(record)
      }
      const existingForReceipt = record.acknowledgements.find(
        ({ receipt_id }) => receipt_id === acknowledgement.receipt_id,
      )
      if (existingForReceipt) {
        throw ledgerError(
          "acknowledgement_conflict",
          `receipt ${acknowledgement.receipt_id} is already acknowledged by ${existingForReceipt.acknowledgement_id}`,
        )
      }
      assertAcknowledgementIdAvailable(index.records, acknowledgement.acknowledgement_id)
      const next = copyRecord(record)
      next.revision++
      next.acknowledgements.push(acknowledgement)
      validateRecord(next, recordPathFor(this.root, acknowledgement.ensure_id))
      await this.writeRecord(
        next,
        guard,
        requireRecordIdentity(index, acknowledgement.ensure_id),
      )
      return copyRecord(next)
    }))
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async withLock<T>(operation: (guard: StorageGuard) => Promise<T>): Promise<T> {
    const expectedRoot = await ensurePrivateRoot(this.root, this.uid)
    const expectedLock = await ensureLockFile(this.root, this.uid)
    for (let attempt = 0; attempt < this.lockAttempts; attempt++) {
      const lock = acquireExclusiveLock(resolve(this.root, LOCK_FILE), {
        create: false,
        noFollow: true,
      })
      if (lock === undefined) {
        throw ledgerError("lock_unavailable", "native flock is unavailable for the ensure ledger")
      }
      if (lock !== null) {
        let directory: FileHandle | null = null
        try {
          const lockedIdentity = fstatSync(lock.descriptor)
          assertSafeStats(resolve(this.root, LOCK_FILE), lockedIdentity, this.uid)
          if (!sameFileIdentity(expectedLock, lockedIdentity)) {
            throw unsafeStorage("ensure ledger lock changed before it was acquired")
          }
          directory = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
          const directoryIdentity = await directory.stat()
          assertSafeRootStats(this.root, directoryIdentity, this.uid)
          if (!sameRootIdentity(expectedRoot, directoryIdentity)) {
            throw unsafeStorage("ensure ledger root changed before its lock was acquired")
          }
          const guard = {
            directory,
            lock,
            lockIdentity: lockedIdentity,
            rootIdentity: directoryIdentity,
          }
          await assertStorageGuard(this.root, guard, this.uid)
          const result = await operation(guard)
          await assertStorageGuard(this.root, guard, this.uid)
          return result
        } finally {
          lock.release()
          await directory?.close().catch(() => undefined)
        }
      }
      await delay(this.lockDelayMs)
    }
    throw ledgerError("lock_unavailable", "the ensure ledger lock remained held")
  }

  private async readIndex(guard: StorageGuard): Promise<RecordIndex> {
    await assertStorageGuard(this.root, guard, this.uid)
    const entries = await readdir(this.root, { withFileTypes: true })
    const records: EnsureLifecycleRecord[] = []
    const managedRecords: ManagedLaunchRecord[] = []
    const identities = new Map<string, Stats>()
    const temporaries: string[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(this.root, entry.name)
      if (entry.name === LOCK_FILE) {
        if (!entry.isFile()) throw unsafeStorage(`${path} is not a regular lock file`)
        await assertSafeFile(path, this.uid)
        continue
      }
      if (TEMPORARY_FILE.test(entry.name)) {
        if (!entry.isFile()) throw unsafeStorage(`${path} is not a regular temporary file`)
        await assertSafeFile(path, this.uid)
        temporaries.push(path)
        continue
      }
      if (!RECORD_FILE.test(entry.name) || !entry.isFile()) {
        throw ledgerError("corrupt_record", `foreign or unsafe entry in ensure ledger: ${path}`)
      }
      await assertStorageGuard(this.root, guard, this.uid)
      const { identity, record } = await readRecord(path, this.uid)
      if (entry.name !== recordFileName(record.request.ensure_id)) {
        throw ledgerError("corrupt_record", `ensure ledger filename does not match ${record.request.ensure_id}`)
      }
      if (record.schema_version === MANAGED_LEDGER_SCHEMA_VERSION) managedRecords.push(record)
      else records.push(record)
      identities.set(record.request.ensure_id, identity)
    }
    validateIndex(records)
    validateManagedIndex(records, managedRecords)
    for (const temporary of temporaries) {
      await assertStorageGuard(this.root, guard, this.uid)
      try {
        await unlink(temporary)
      } catch (error) {
        throw unsafeStorage(`cannot remove abandoned ensure ledger temporary ${temporary}`, error)
      }
    }
    // A prior process may have died after rename but before syncing the
    // directory. Re-sync even when no temporary remains so retry turns either
    // observable pre-rename or post-rename state into durable authority.
    await guard.directory.sync()
    await assertStorageGuard(this.root, guard, this.uid)
    return {
      byEnsureId: new Map(records.map((record) => [record.request.ensure_id, record])),
      managedByEnsureId: new Map(
        managedRecords.map((record) => [record.request.ensure_id, record]),
      ),
      identities,
      records,
      managedRecords,
    }
  }

  private async writeRecord(
    record: EnsureLifecycleRecord,
    guard: StorageGuard,
    expectedTarget: Stats | null,
  ): Promise<void> {
    return this.writeLedgerRecord(record, guard, expectedTarget)
  }

  private async writeLedgerRecord(
    record: LifecycleLedgerRecord,
    guard: StorageGuard,
    expectedTarget: Stats | null,
  ): Promise<void> {
    await assertStorageGuard(this.root, guard, this.uid)
    validateLedgerRecord(record, recordPathFor(this.root, record.request.ensure_id))
    const canonical = encodeCanonicalJson(record as unknown as JsonValue)
    const bytes = Buffer.concat([Buffer.from(canonical), Buffer.from("\n")])
    if (bytes.byteLength > CONTRACT_MAX_FRAME_BYTES) {
      throw ledgerError("corrupt_record", "ensure ledger record exceeds the 1 MiB bound")
    }
    const target = recordPathFor(this.root, record.request.ensure_id)
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    await this.inject("before_write", record)
    await assertStorageGuard(this.root, guard, this.uid)
    await assertTargetSnapshot(target, expectedTarget, this.uid)
    let handle: FileHandle | null = null
    let renamed = false
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      await handle.writeFile(bytes)
      await handle.chmod(0o600)
      const temporaryIdentity = await handle.stat()
      assertSafeStats(temporary, temporaryIdentity, this.uid)
      await handle.sync()
      await this.inject("after_file_sync", record)
      await assertStorageGuard(this.root, guard, this.uid)
      await this.inject("before_rename", record)
      await assertStorageGuard(this.root, guard, this.uid)
      await assertTargetSnapshot(target, expectedTarget, this.uid)
      const pathnameIdentity = await assertSafeFile(temporary, this.uid)
      if (!sameFileIdentity(temporaryIdentity, pathnameIdentity)) {
        throw unsafeStorage(`${temporary} changed before its durable rename`)
      }
      await handle.close()
      handle = null
      await rename(temporary, target)
      renamed = true
      const renamedIdentity = await assertSafeFile(target, this.uid)
      if (!sameFileIdentity(temporaryIdentity, renamedIdentity)) {
        throw unsafeStorage(`${target} changed during its durable rename`)
      }
      await this.inject("after_rename", record)
      await assertStorageGuard(this.root, guard, this.uid)
      await guard.directory.sync()
      await this.inject("after_directory_sync", record)
      await assertStorageGuard(this.root, guard, this.uid)
    } finally {
      await handle?.close().catch(() => undefined)
      if (!renamed) await unlink(temporary).catch(() => undefined)
    }
  }

  private async inject(
    point: EnsureLifecycleLedgerFaultPoint,
    record: LifecycleLedgerRecord,
  ): Promise<void> {
    if (record.schema_version === MANAGED_LEDGER_SCHEMA_VERSION) {
      await this.managedFault?.(point, copyManagedRecord(record))
    } else {
      await this.fault?.(point, copyRecord(record))
    }
  }
}

export function recordPathFor(root: string, ensureId: string): string {
  return resolve(root, recordFileName(ensureId))
}

export function deriveEnsureDigest(request: EnsureRequest): string {
  const specification = ensureSpecification(request)
  return createHash("sha256").update(encodeCanonicalJson(specification)).digest("hex")
}

function parseEnsureRequest(input: EnsureRequest): EnsureRequest {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    !("planned_worktree" in parsed.data) ||
    parsed.data.message_type !== "ensure_request"
  ) {
    throw ledgerError("invalid_request", "ensure claim is not a strict frozen ensure_request")
  }
  const request: EnsureRequest = {
    ...structuredClone(parsed.data),
    message_type: "ensure_request",
  }
  const derived = deriveEnsureDigest(request)
  if (derived !== request.ensure_digest) {
    throw ledgerError(
      "invalid_request",
      `ensure digest ${request.ensure_digest} does not match immutable request ${derived}`,
    )
  }
  return request
}

function parseEnsureReceipt(input: EnsureReceipt): EnsureReceipt {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    !("effects" in parsed.data) ||
    parsed.data.message_type !== "ensure_receipt"
  ) {
    throw ledgerError("receipt_conflict", "retained receipt is not a strict ensure_receipt")
  }
  const receipt: EnsureReceipt = {
    ...structuredClone(parsed.data),
    message_type: "ensure_receipt",
  }
  if (deriveReceiptDigest(receipt) !== receipt.receipt_digest) {
    throw ledgerError("receipt_conflict", `receipt ${receipt.receipt_id} has an invalid digest`)
  }
  return receipt
}

function parseEnsureAcknowledgement(
  input: EnsureReceiptAcknowledgement,
): EnsureReceiptAcknowledgement {
  const parsed = ensureLifecycleMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    !("acknowledgement_id" in parsed.data) ||
    parsed.data.message_type !== "receipt_acknowledgement" ||
    parsed.data.receipt_kind !== "ensure"
  ) {
    throw ledgerError(
      "invalid_acknowledgement",
      "ensure acknowledgement is not a strict ensure receipt acknowledgement",
    )
  }
  return {
    ...structuredClone(parsed.data),
    message_type: "receipt_acknowledgement",
  }
}

function emptyFxFinalReceiptTransaction(): FxFinalReceiptTransaction {
  return {
    binding: null,
    receipt: null,
    acknowledgement: null,
    acknowledgement_applied: false,
  }
}

function parseFxFinalReceiptAuthorityBinding(
  input: unknown,
): FxFinalReceiptAuthorityBinding {
  const parsed = fxFinalReceiptAuthorityBindingSchema.safeParse(input)
  if (
    !parsed.success ||
    !isAbsolute(parsed.data.state_root) ||
    parsed.data.state_root === "/" ||
    normalize(parsed.data.state_root) !== parsed.data.state_root ||
    CONTROL_CHARACTERS.test(parsed.data.state_root) ||
    Buffer.byteLength(parsed.data.state_root) > 4096
  ) {
    throw ledgerError(
      "invalid_request",
      "Fx final-receipt authority requires one safe admission key and " +
        "normalized non-root state root",
    )
  }
  return structuredClone(parsed.data)
}

function parseFxFinalReceipt(input: FxFinalReceipt): FxFinalReceipt {
  const parsed = fxLaunchAdmissionFinalMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    parsed.data.message_type !== "final_receipt" ||
    !("outcome" in parsed.data)
  ) {
    throw ledgerError("receipt_conflict", "retained Fx receipt is not a strict final_receipt")
  }
  const receipt = {
    ...structuredClone(parsed.data),
    message_type: "final_receipt" as const,
  } as FxFinalReceipt
  const derived = deriveFxFinalReceiptDigest(receipt)
  if (derived !== receipt.receipt_digest) {
    throw ledgerError(
      "receipt_conflict",
      `Fx final receipt ${receipt.receipt_id} has digest ${receipt.receipt_digest}; ` +
        `expected ${derived}`,
    )
  }
  return receipt
}

function parseFxAdmissionDecision(input: FxAdmissionDecision): FxAdmissionDecision {
  const parsed = fxLaunchAdmissionFinalMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    parsed.data.message_type !== "admission_decision" ||
    !("decision" in parsed.data)
  ) {
    throw ledgerError(
      "receipt_conflict",
      "retained Fx admission winner is not a strict admission_decision",
    )
  }
  const decision = {
    ...structuredClone(parsed.data),
    message_type: "admission_decision" as const,
  } as FxAdmissionDecision
  const derived = deriveFxAdmissionDecisionDigest(decision)
  if (derived !== decision.receipt_digest) {
    throw ledgerError(
      "receipt_conflict",
      `Fx admission decision ${decision.receipt_id} has digest ${decision.receipt_digest}; ` +
        `expected ${derived}`,
    )
  }
  return decision
}

function parseFxFinalReceiptAcknowledgement(
  input: FxFinalReceiptAcknowledgement,
): FxFinalReceiptAcknowledgement {
  const parsed = fxLaunchAdmissionFinalMessageSchema.safeParse(input)
  if (
    !parsed.success ||
    parsed.data.message_type !== "final_receipt_acknowledgement" ||
    !("acknowledgement_id" in parsed.data)
  ) {
    throw ledgerError(
      "invalid_acknowledgement",
      "Fx final acknowledgement is not a strict final_receipt_acknowledgement",
    )
  }
  return {
    ...structuredClone(parsed.data),
    message_type: "final_receipt_acknowledgement" as const,
  } as FxFinalReceiptAcknowledgement
}

export function deriveFxFinalReceiptDigest(receipt: FxFinalReceipt): string {
  const { receipt_digest: _receiptDigest, ...specification } = receipt
  return createHash("sha256")
    .update(encodeCanonicalJson(specification as unknown as JsonValue))
    .digest("hex")
}

export function deriveFxAdmissionDecisionDigest(decision: FxAdmissionDecision): string {
  const { receipt_digest: _receiptDigest, ...specification } = decision
  return createHash("sha256")
    .update(encodeCanonicalJson(specification as unknown as JsonValue))
    .digest("hex")
}

function assertFxAdmissionDecisionCorrelation(
  record: EnsureLifecycleRecord,
  decision: FxAdmissionDecision,
  code: EnsureLifecycleLedgerErrorCode,
): void {
  const binding = record.fx_final.binding
  if (binding === null) {
    throw ledgerError(code, `ensure ${record.request.ensure_id} has no Fx admission authority`)
  }
  if (
    decision.launch_id !== record.request.launch_id ||
    decision.launch_digest !== record.request.launch_digest ||
    decision.admission_key !== binding.admission_key
  ) {
    throw ledgerError(code, "Fx admission decision changed the exact launch correlation")
  }
  if (decision.decision.kind === "admitted") {
    if (record.stage !== "companion_started" && record.stage !== "fx_started") {
      throw ledgerError(
        code,
        `positive Fx admission cannot be retained at ensure stage ${record.stage}`,
      )
    }
    return
  }
  if (record.stage !== "manifest_claimed" && record.stage !== "companion_started") {
    throw ledgerError(
      code,
      `negative Fx admission cannot be retained at ensure stage ${record.stage}`,
    )
  }
}

function assertManagedFxAdmissionDecisionCorrelation(
  record: ManagedLaunchRecord,
  decision: FxAdmissionDecision,
  code: EnsureLifecycleLedgerErrorCode,
): void {
  const binding = record.fx_final.binding
  if (binding === null) {
    throw ledgerError(code, `managed launch ${record.request.ensure_id} has no Fx authority`)
  }
  if (
    decision.launch_id !== record.request.launch_id ||
    decision.launch_digest !== record.request.launch_digest ||
    decision.admission_key !== binding.admission_key
  ) {
    throw ledgerError(code, "Fx admission changed managed launch correlation")
  }
  if (decision.decision.kind === "admitted") {
    if (record.stage !== "companion_started" && record.stage !== "fx_started") {
      throw ledgerError(code, `managed Fx admission cannot be retained at ${record.stage}`)
    }
    return
  }
  if (record.stage !== "manifest_claimed" && record.stage !== "companion_started") {
    throw ledgerError(code, `managed Fx cancellation cannot be retained at ${record.stage}`)
  }
}

function assertManagedFxFinalReceiptCorrelation(
  record: ManagedLaunchRecord,
  receipt: FxFinalReceipt,
  code: EnsureLifecycleLedgerErrorCode,
): void {
  if (record.fx_admission_decision?.decision.kind === "cancelled_before_start") {
    throw ledgerError(code, "managed launch cannot retain Fx finality after cancellation won")
  }
  const binding = record.fx_final.binding
  if (
    MANAGED_STAGES.indexOf(record.stage) < MANAGED_STAGES.indexOf("companion_started") ||
    record.effects.companion.status !== "started" ||
    binding === null
  ) {
    throw ledgerError(code, `managed launch ${record.request.ensure_id} has no started Companion`)
  }
  if (
    receipt.launch_id !== record.request.launch_id ||
    receipt.launch_digest !== record.request.launch_digest ||
    receipt.admission_key !== binding.admission_key
  ) {
    throw ledgerError(code, "Fx final receipt changed managed launch correlation")
  }
  if (
    record.effects.fx.status === "started" &&
    receipt.conversation_id !== record.effects.fx.conversation_id
  ) {
    throw ledgerError(code, "Fx final receipt changed the managed Conversation")
  }
}

function assertManagedFxFinalAcknowledgementCorrelation(
  record: ManagedLaunchRecord,
  acknowledgement: FxFinalReceiptAcknowledgement,
  code: EnsureLifecycleLedgerErrorCode,
): void {
  const receipt = record.fx_final.receipt
  if (receipt === null) {
    throw ledgerError(code, `managed launch ${record.request.ensure_id} has no Fx final receipt`)
  }
  if (
    acknowledgement.admission_key !== receipt.admission_key ||
    acknowledgement.launch_id !== receipt.launch_id ||
    acknowledgement.launch_digest !== receipt.launch_digest ||
    acknowledgement.conversation_id !== receipt.conversation_id ||
    acknowledgement.receipt_id !== receipt.receipt_id ||
    acknowledgement.receipt_digest !== receipt.receipt_digest
  ) {
    throw ledgerError(code, "Fx final acknowledgement changed managed receipt correlation")
  }
}

function assertManagedOutcomeCorrelation(
  record: ManagedLaunchRecord,
  outcome: ManagedLaunchOutcome,
): void {
  const request = record.request
  for (const field of [
    "request_id",
    "workplace_instance_id",
    "fmx_session",
    "ensure_id",
    "ensure_digest",
    "launch_id",
    "launch_digest",
    "agent_id",
  ] as const) {
    if (outcome[field] !== request[field]) {
      throw ledgerError("receipt_conflict", `managed outcome changed ${field}`)
    }
  }
  if (outcome.attempt !== record.attempt) {
    throw ledgerError("receipt_conflict", "managed outcome changed the exact attempt")
  }
  if (outcome.exact_resume_proof !== null) {
    const launch = request.source.launch_request
    if (
      launch.resume.mode !== "exact" ||
      outcome.exact_resume_proof.conversation_id !== launch.resume.conversation_id ||
      outcome.exact_resume_proof.state_root !== launch.state_root ||
      outcome.exact_resume_proof.admission_key !== request.source.admission_key ||
      outcome.exact_resume_proof.launch_id !== request.launch_id ||
      outcome.exact_resume_proof.launch_digest !== request.launch_digest
    ) {
      throw ledgerError(
        "receipt_conflict",
        "managed permanent refusal does not prove the exact requested resume",
      )
    }
  }
  if (outcome.status === "succeeded") {
    const decision = record.fx_admission_decision
    const conversationId = record.effects.fx.status === "started"
      ? record.effects.fx.conversation_id
      : null
    if (
      record.stage !== "fx_started" ||
      decision?.decision.kind !== "admitted" ||
      conversationId === null ||
      outcome.success.conversation_id !== conversationId ||
      outcome.success.admission_receipt_id !== decision.receipt_id ||
      outcome.success.admission_receipt_digest !== decision.receipt_digest
    ) {
      throw ledgerError(
        "receipt_conflict",
        "managed success does not name the exact retained admission and Conversation",
      )
    }
  }
}

function assertManagedAcknowledgementCorrelation(
  record: ManagedLaunchRecord,
  acknowledgement: ManagedLaunchAcknowledgement,
): void {
  const receipt = record.outcome.receipt
  if (receipt === null) {
    throw ledgerError(
      "invalid_acknowledgement",
      `managed launch ${record.request.ensure_id} has no retained outcome`,
    )
  }
  if (
    acknowledgement.workplace_instance_id !== receipt.workplace_instance_id ||
    acknowledgement.fmx_session !== receipt.fmx_session ||
    acknowledgement.receipt_id !== receipt.receipt_id ||
    acknowledgement.receipt_digest !== receipt.receipt_digest ||
    acknowledgement.attempt !== receipt.attempt ||
    acknowledgement.ensure_id !== receipt.ensure_id ||
    acknowledgement.ensure_digest !== receipt.ensure_digest ||
    acknowledgement.launch_id !== receipt.launch_id ||
    acknowledgement.launch_digest !== receipt.launch_digest ||
    acknowledgement.agent_id !== receipt.agent_id
  ) {
    throw ledgerError(
      "invalid_acknowledgement",
      "managed acknowledgement does not name the exact retained outcome",
    )
  }
}

function assertManagedRetryCorrelation(
  record: ManagedLaunchRecord,
  retry: ManagedLaunchRetry,
): void {
  const request = record.request
  const outcome = record.outcome.receipt
  const acknowledgement = record.outcome.acknowledgement
  if (
    outcome === null || acknowledgement === null ||
    outcome.status !== "failed" || outcome.classification === "permanent"
  ) {
    throw ledgerError(
      "invalid_request",
      "managed retry requires one acknowledged retryable or uncertain outcome",
    )
  }
  if (
    retry.workplace_instance_id !== request.workplace_instance_id ||
    retry.fmx_session !== request.fmx_session ||
    retry.ensure_digest !== request.ensure_digest ||
    retry.launch_id !== request.launch_id ||
    retry.launch_digest !== request.launch_digest ||
    retry.agent_id !== request.agent_id ||
    retry.prior_attempt !== record.attempt ||
    retry.next_attempt !== record.attempt + 1 ||
    retry.prior_receipt_id !== outcome.receipt_id ||
    retry.prior_receipt_digest !== outcome.receipt_digest
  ) {
    throw ledgerError("invalid_request", "managed retry changed immutable launch correlation")
  }
}

function managedRetryMatches(record: ManagedLaunchRecord, retry: ManagedLaunchRetry): boolean {
  const previous = record.outcome_history[retry.prior_attempt - 1]
  return previous !== undefined && sameCanonical(previous.retry, retry)
}

function assertFxFinalReceiptCorrelation(
  record: EnsureLifecycleRecord,
  receipt: FxFinalReceipt,
  code: EnsureLifecycleLedgerErrorCode,
): void {
  const binding = record.fx_final.binding
  if (record.fx_admission_decision?.decision.kind === "cancelled_before_start") {
    throw ledgerError(code, "Fx cancellation winner cannot produce a final receipt")
  }
  if (
    STAGES.indexOf(record.stage) < STAGES.indexOf("companion_started") ||
    record.effects.companion.status !== "started"
  ) {
    throw ledgerError(code, `ensure ${record.request.ensure_id} has no durably started Companion`)
  }
  if (binding === null) {
    throw ledgerError(code, `ensure ${record.request.ensure_id} has no Fx final-receipt authority`)
  }
  if (
    receipt.launch_id !== record.request.launch_id ||
    receipt.launch_digest !== record.request.launch_digest ||
    receipt.admission_key !== binding.admission_key
  ) {
    throw ledgerError(code, "Fx final receipt changed the exact launch correlation")
  }
  if (
    record.effects.fx.status === "started" &&
    receipt.conversation_id !== record.effects.fx.conversation_id
  ) {
    throw ledgerError(code, "Fx final receipt changed the durably started Conversation")
  }
}

function assertFxFinalAcknowledgementCorrelation(
  record: EnsureLifecycleRecord,
  acknowledgement: FxFinalReceiptAcknowledgement,
  code: EnsureLifecycleLedgerErrorCode,
): void {
  const receipt = record.fx_final.receipt
  if (receipt === null) {
    throw ledgerError(code, `ensure ${record.request.ensure_id} has no retained Fx final receipt`)
  }
  if (
    acknowledgement.admission_key !== receipt.admission_key ||
    acknowledgement.launch_id !== receipt.launch_id ||
    acknowledgement.launch_digest !== receipt.launch_digest ||
    acknowledgement.conversation_id !== receipt.conversation_id ||
    acknowledgement.receipt_id !== receipt.receipt_id ||
    acknowledgement.receipt_digest !== receipt.receipt_digest
  ) {
    throw ledgerError(code, "Fx final acknowledgement does not name the exact retained receipt")
  }
}

function assertReceiptIdAvailable(
  records: readonly EnsureLifecycleRecord[],
  receiptId: string,
): void {
  for (const record of records) {
    if (
      record.receipts.some(({ receipt_id }) => receipt_id === receiptId) ||
      record.fx_admission_decision?.receipt_id === receiptId ||
      record.fx_final.receipt?.receipt_id === receiptId
    ) {
      throw ledgerError("receipt_conflict", `receipt id ${receiptId} belongs to another receipt`)
    }
  }
}

function assertAcknowledgementIdAvailable(
  records: readonly EnsureLifecycleRecord[],
  acknowledgementId: string,
): void {
  for (const record of records) {
    if (
      record.acknowledgements.some(
        ({ acknowledgement_id }) => acknowledgement_id === acknowledgementId,
      ) ||
      record.fx_final.acknowledgement?.acknowledgement_id === acknowledgementId
    ) {
      throw ledgerError(
        "acknowledgement_conflict",
        `acknowledgement id ${acknowledgementId} belongs to another acknowledgement`,
      )
    }
  }
}

function isSafeToken(value: unknown): value is string {
  return typeof value === "string" && SAFE_TOKEN.test(value)
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

function deriveReceiptDigest(receipt: EnsureReceipt): string {
  const { receipt_digest: _receiptDigest, ...specification } = receipt
  return createHash("sha256")
    .update(encodeCanonicalJson(specification as unknown as JsonValue))
    .digest("hex")
}

function effectsForClaim(request: EnsureRequest): EnsureLifecycleEffects {
  const identity = identityFor(request.agent_id)
  return {
    worktree: { status: "planned", directory: request.planned_worktree.directory },
    manifest: { status: "pending" },
    companion: {
      status: "pending",
      session_name: identity.zmxName,
      pane_id: identity.paneId,
    },
    fx: { status: "pending" },
  }
}

function managedEffectsForClaim(request: ManagedLaunchRequest): ManagedLaunchEffects {
  const identity = identityFor(request.agent_id)
  return {
    workspace: {
      status: "pending",
      ...structuredClone(request.workspace),
    },
    manifest: { status: "pending" },
    companion: {
      status: "pending",
      session_name: identity.zmxName,
      pane_id: identity.paneId,
    },
    fx: { status: "pending" },
  }
}

function advanceRecord(
  record: EnsureLifecycleRecord,
  transition: EnsureLifecycleTransition,
): EnsureLifecycleRecord {
  const expectedIndex = STAGES.indexOf(record.stage) + 1
  const target = transition.kind
  const targetIndex = STAGES.indexOf(target)
  if (targetIndex < 1) throw ledgerError("invalid_transition", `unknown transition ${target}`)

  if (targetIndex <= STAGES.indexOf(record.stage)) {
    if (transitionMatches(record, transition)) return record
    throw ledgerError(
      "invalid_transition",
      `${transition.kind} conflicts with the durable ${record.stage} state`,
    )
  }
  if (targetIndex !== expectedIndex) {
    throw ledgerError(
      "invalid_transition",
      `cannot advance ensure ${record.request.ensure_id} from ${record.stage} to ${target}`,
    )
  }
  if (target === "companion_started" && record.fx_final.binding === null) {
    throw ledgerError(
      "invalid_transition",
      `ensure ${record.request.ensure_id} must durably bind its Fx final-receipt ` +
        "authority before Companion start",
    )
  }

  const next = copyRecord(record)
  next.revision++
  next.stage = target
  switch (transition.kind) {
    case "worktree_created":
      if (
        transition.directory !== record.request.planned_worktree.directory ||
        !GIT_OBJECT_ID.test(transition.head_commit)
      ) {
        throw ledgerError("invalid_transition", "created Worktree does not match the exact plan")
      }
      next.effects.worktree = {
        status: "created",
        directory: transition.directory,
        head_commit: transition.head_commit,
      }
      break
    case "manifest_claimed":
      if (transition.agent_id !== record.request.agent_id) {
        throw ledgerError("invalid_transition", "Manifest claim changed the planned Agent identity")
      }
      next.effects.manifest = { status: "claimed", agent_id: transition.agent_id }
      break
    case "companion_started":
      const identity = identityFor(record.request.agent_id)
      if (
        transition.session_name !== identity.zmxName ||
        transition.pane_id !== identity.paneId
      ) {
        throw ledgerError("invalid_transition", "Companion identity changed the planned Agent identity")
      }
      next.effects.companion = {
        status: "started",
        session_name: transition.session_name,
        pane_id: transition.pane_id,
      }
      break
    case "fx_started":
      if (record.fx_admission_decision?.decision.kind !== "admitted") {
        throw ledgerError(
          "invalid_transition",
          `ensure ${record.request.ensure_id} cannot start Fx without a durable admitted decision`,
        )
      }
      if (!isAgentWorkplaceConversationId(transition.conversation_id)) {
        throw ledgerError("invalid_transition", "Fx start did not return a valid Conversation identity")
      }
      if (
        record.fx_final.receipt !== null &&
        transition.conversation_id !== record.fx_final.receipt.conversation_id
      ) {
        throw ledgerError(
          "invalid_transition",
          "Fx start changed the Conversation in the retained final receipt",
        )
      }
      next.effects.fx = { status: "started", conversation_id: transition.conversation_id }
      break
  }
  validateRecord(next, `ensure ${record.request.ensure_id}`)
  return next
}

function advanceManagedRecord(
  record: ManagedLaunchRecord,
  transition: ManagedLaunchTransition,
): ManagedLaunchRecord {
  const expectedIndex = MANAGED_STAGES.indexOf(record.stage) + 1
  const target = transition.kind
  const targetIndex = MANAGED_STAGES.indexOf(target)
  if (targetIndex < 1) throw ledgerError("invalid_transition", `unknown transition ${target}`)
  if (record.outcome.receipt !== null) {
    throw ledgerError(
      "invalid_transition",
      `managed launch ${record.request.ensure_id} already has a retained outcome`,
    )
  }
  if (targetIndex <= MANAGED_STAGES.indexOf(record.stage)) {
    if (managedTransitionMatches(record, transition)) return record
    throw ledgerError(
      "invalid_transition",
      `${transition.kind} conflicts with the durable ${record.stage} state`,
    )
  }
  if (targetIndex !== expectedIndex) {
    throw ledgerError(
      "invalid_transition",
      `cannot advance managed launch ${record.request.ensure_id} from ${record.stage} to ${target}`,
    )
  }
  if (target === "companion_started" && record.fx_final.binding === null) {
    throw ledgerError(
      "invalid_transition",
      `managed launch ${record.request.ensure_id} must bind Fx final authority before Companion start`,
    )
  }

  const next = copyManagedRecord(record)
  next.revision++
  next.stage = target
  switch (transition.kind) {
    case "directory_validated":
      if (!sameCanonical({
        kind: "existing_directory",
        directory: transition.directory,
        repository: transition.repository,
        checkout_root: transition.checkout_root,
        head_commit: transition.head_commit,
      }, record.request.workspace)) {
        throw ledgerError(
          "invalid_transition",
          "validated existing directory changed the immutable Git identity",
        )
      }
      next.effects.workspace = {
        status: "validated",
        ...structuredClone(record.request.workspace),
      }
      break
    case "manifest_claimed":
      if (transition.agent_id !== record.request.agent_id) {
        throw ledgerError("invalid_transition", "Manifest claim changed the managed Agent identity")
      }
      next.effects.manifest = { status: "claimed", agent_id: transition.agent_id }
      break
    case "companion_started": {
      const identity = identityFor(record.request.agent_id)
      if (
        transition.session_name !== identity.zmxName ||
        transition.pane_id !== identity.paneId
      ) {
        throw ledgerError("invalid_transition", "Companion changed the managed Agent identity")
      }
      next.effects.companion = {
        status: "started",
        session_name: transition.session_name,
        pane_id: transition.pane_id,
      }
      break
    }
    case "fx_started":
      if (record.fx_admission_decision?.decision.kind !== "admitted") {
        throw ledgerError(
          "invalid_transition",
          `managed launch ${record.request.ensure_id} cannot start Fx without admitted authority`,
        )
      }
      if (!isAgentWorkplaceConversationId(transition.conversation_id)) {
        throw ledgerError("invalid_transition", "managed Fx start returned an invalid Conversation")
      }
      next.effects.fx = { status: "started", conversation_id: transition.conversation_id }
      break
  }
  validateManagedRecord(next, `managed launch ${record.request.ensure_id}`)
  return next
}

function managedTransitionMatches(
  record: ManagedLaunchRecord,
  transition: ManagedLaunchTransition,
): boolean {
  switch (transition.kind) {
    case "directory_validated":
      return record.effects.workspace.status === "validated" && sameCanonical(
        record.effects.workspace,
        { status: "validated", ...record.request.workspace },
      )
    case "manifest_claimed":
      return record.effects.manifest.status === "claimed" &&
        record.effects.manifest.agent_id === transition.agent_id
    case "companion_started":
      return record.effects.companion.status === "started" &&
        record.effects.companion.session_name === transition.session_name &&
        record.effects.companion.pane_id === transition.pane_id
    case "fx_started":
      return record.effects.fx.status === "started" &&
        record.effects.fx.conversation_id === transition.conversation_id
  }
}

function transitionMatches(
  record: EnsureLifecycleRecord,
  transition: EnsureLifecycleTransition,
): boolean {
  switch (transition.kind) {
    case "worktree_created":
      return record.effects.worktree.status === "created" &&
        record.effects.worktree.directory === transition.directory &&
        record.effects.worktree.head_commit === transition.head_commit
    case "manifest_claimed":
      return record.effects.manifest.status === "claimed" &&
        record.effects.manifest.agent_id === transition.agent_id
    case "companion_started":
      return record.effects.companion.status === "started" &&
        record.effects.companion.session_name === transition.session_name &&
        record.effects.companion.pane_id === transition.pane_id
    case "fx_started":
      return record.effects.fx.status === "started" &&
        record.effects.fx.conversation_id === transition.conversation_id
  }
}

function assertReceiptCorrelation(record: EnsureLifecycleRecord, receipt: EnsureReceipt): void {
  const request = record.request
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
    if (receipt[field] !== request[field]) {
      throw ledgerError("receipt_conflict", `receipt ${receipt.receipt_id} changed ${field}`)
    }
  }
  if (!sameCanonical(receipt.effects, record.effects)) {
    throw ledgerError(
      "receipt_conflict",
      `receipt ${receipt.receipt_id} does not describe the current durable effects`,
    )
  }
  const expectedStatus = record.stage === "fx_started" ? "complete" : "in_progress"
  if (receipt.status !== expectedStatus) {
    throw ledgerError(
      "receipt_conflict",
      `receipt ${receipt.receipt_id} status does not match ${record.stage}`,
    )
  }
}

function validateLedgerRecord(record: LifecycleLedgerRecord, path: string): void {
  if (record.schema_version === MANAGED_LEDGER_SCHEMA_VERSION) validateManagedRecord(record, path)
  else validateRecord(record, path)
}

function validateManagedRecord(record: ManagedLaunchRecord, path: string): void {
  if (!managedPrivateRecordSchema.safeParse(record).success) {
    throw ledgerError("corrupt_record", `${path} is not a bounded managed launch record`)
  }
  try {
    parseManagedLaunchRequest(record.request)
  } catch (error) {
    const wrapped = ledgerError("corrupt_record", `${path} retains an invalid managed launch request`)
    wrapped.cause = error
    throw wrapped
  }
  const stageIndex = MANAGED_STAGES.indexOf(record.stage)
  if (stageIndex < 0 || !sameCanonical(managedEffectsAtStage(record, record.stage), record.effects)) {
    throw ledgerError("corrupt_record", `${path} effects do not match stage ${record.stage}`)
  }
  if (
    stageIndex >= MANAGED_STAGES.indexOf("companion_started") &&
    record.prepared_conversation_id === null
  ) {
    throw ledgerError("corrupt_record", `${path} started a Companion without a retained Conversation`)
  }
  validateManagedOutcomeTransaction(record, path)
  validateManagedFxState(record, path)
  const historicalWrites = record.outcome_history.length * 2
  const expectedRevision = 1 + stageIndex + historicalWrites + (record.attempt - 1) +
    (record.prepared_conversation_id === null ? 0 : 1) +
    (record.outcome.receipt === null ? 0 : 1) +
    (record.outcome.acknowledgement === null ? 0 : 1) +
    (record.fx_admission_decision === null ? 0 : 1) +
    (record.fx_final.binding === null ? 0 : 1) +
    (record.fx_final.receipt === null ? 0 : 1) +
    (record.fx_final.acknowledgement === null ? 0 : 1) +
    (record.fx_final.acknowledgement_applied ? 1 : 0)
  if (record.revision !== expectedRevision) {
    throw ledgerError(
      "corrupt_record",
      `${path} has revision ${record.revision}; expected ${expectedRevision}`,
    )
  }
}

function managedEffectsAtStage(
  record: ManagedLaunchRecord,
  stage: ManagedLaunchLedgerStage,
): ManagedLaunchEffects {
  const index = MANAGED_STAGES.indexOf(stage)
  const claimed = managedEffectsForClaim(record.request)
  return {
    workspace: index >= 1 && record.effects.workspace.status === "validated"
      ? structuredClone(record.effects.workspace)
      : claimed.workspace,
    manifest: index >= 2 && record.effects.manifest.status === "claimed"
      ? structuredClone(record.effects.manifest)
      : claimed.manifest,
    companion: index >= 3 && record.effects.companion.status === "started"
      ? structuredClone(record.effects.companion)
      : claimed.companion,
    fx: index >= 4 && record.effects.fx.status === "started"
      ? structuredClone(record.effects.fx)
      : claimed.fx,
  }
}

function validateManagedOutcomeTransaction(record: ManagedLaunchRecord, path: string): void {
  if (record.outcome_history.length !== record.attempt - 1) {
    throw ledgerError("corrupt_record", `${path} managed attempt history is not contiguous`)
  }
  for (let index = 0; index < record.outcome_history.length; index++) {
    const transaction = record.outcome_history[index]!
    if (
      transaction.receipt.status !== "failed" ||
      transaction.receipt.classification === "permanent" ||
      transaction.receipt.attempt !== index + 1
    ) {
      throw ledgerError("corrupt_record", `${path} retains a non-retryable historical attempt`)
    }
    try {
      const retry = parseManagedLaunchRetry(transaction.retry)
      if (retry.next_attempt !== index + 2) {
        throw new Error("managed retry attempt is not contiguous")
      }
      assertManagedRetryCorrelation(
        { ...record, attempt: index + 1, outcome: transaction },
        retry,
      )
    } catch (error) {
      const wrapped = ledgerError("corrupt_record", `${path} retains an invalid managed retry`)
      wrapped.cause = error
      throw wrapped
    }
    validateManagedOneOutcome(
      { ...record, attempt: index + 1, outcome: transaction },
      transaction,
      `${path} attempt ${index + 1}`,
    )
  }
  validateManagedOneOutcome(record, record.outcome, path)
}

function validateManagedOneOutcome(
  record: ManagedLaunchRecord,
  transaction: ManagedLaunchOutcomeTransaction,
  path: string,
): void {
  const { receipt, acknowledgement } = transaction
  if (receipt !== null) {
    try {
      const parsed = parseManagedLaunchOutcome(receipt)
      assertManagedOutcomeCorrelation(record, parsed)
    } catch (error) {
      const wrapped = ledgerError("corrupt_record", `${path} retains an invalid managed outcome`)
      wrapped.cause = error
      throw wrapped
    }
  }
  if (acknowledgement !== null) {
    try {
      const parsed = parseManagedLaunchAcknowledgement(acknowledgement)
      assertManagedAcknowledgementCorrelation(record, parsed)
    } catch (error) {
      const wrapped = ledgerError(
        "corrupt_record",
        `${path} retains an invalid managed outcome acknowledgement`,
      )
      wrapped.cause = error
      throw wrapped
    }
  }
  if (receipt === null && acknowledgement !== null) {
    throw ledgerError("corrupt_record", `${path} acknowledges an absent managed outcome`)
  }
}

function validateManagedFxState(record: ManagedLaunchRecord, path: string): void {
  const transaction = record.fx_final
  try {
    if (transaction.binding !== null) parseFxFinalReceiptAuthorityBinding(transaction.binding)
    if (
      MANAGED_STAGES.indexOf(record.stage) >= MANAGED_STAGES.indexOf("companion_started") &&
      transaction.binding === null
    ) {
      throw ledgerError("corrupt_record", `${path} started Companion without Fx authority`)
    }
    if (record.fx_admission_decision !== null) {
      const decision = parseFxAdmissionDecision(record.fx_admission_decision)
      assertManagedFxAdmissionDecisionCorrelation(record, decision, "corrupt_record")
    } else if (record.stage === "fx_started") {
      throw ledgerError("corrupt_record", `${path} started Fx without its admission decision`)
    }
    if (transaction.receipt !== null) {
      const receipt = parseFxFinalReceipt(transaction.receipt)
      assertManagedFxFinalReceiptCorrelation(record, receipt, "corrupt_record")
    }
    if (transaction.acknowledgement !== null) {
      const acknowledgement = parseFxFinalReceiptAcknowledgement(transaction.acknowledgement)
      assertManagedFxFinalAcknowledgementCorrelation(
        record,
        acknowledgement,
        "corrupt_record",
      )
    }
    if (
      transaction.binding === null &&
      (transaction.receipt !== null || transaction.acknowledgement !== null ||
        transaction.acknowledgement_applied)
    ) {
      throw ledgerError("corrupt_record", `${path} retains Fx final state without authority`)
    }
    if (transaction.receipt === null && transaction.acknowledgement !== null) {
      throw ledgerError("corrupt_record", `${path} acknowledges an absent Fx final receipt`)
    }
    if (transaction.acknowledgement === null && transaction.acknowledgement_applied) {
      throw ledgerError("corrupt_record", `${path} applies an absent Fx final acknowledgement`)
    }
  } catch (error) {
    if (error instanceof EnsureLifecycleLedgerError && error.code === "corrupt_record") throw error
    const wrapped = ledgerError("corrupt_record", `${path} contains invalid managed Fx state`)
    wrapped.cause = error
    throw wrapped
  }
}

function validateRecord(record: EnsureLifecycleRecord, path: string): void {
  if (!privateRecordSchema.safeParse(record).success) {
    throw ledgerError("corrupt_record", `${path} is not a bounded private ensure ledger record`)
  }
  const request = parseEnsureRequest(record.request)
  if (request.ensure_id !== record.request.ensure_id) {
    throw ledgerError("corrupt_record", `${path} changed its ensure identity during parsing`)
  }
  validateStageEffects(record, path)
  validateFxAdmissionDecision(record, path)
  validateFxFinalReceiptTransaction(record, path)
  const expectedRevision = 1 + STAGES.indexOf(record.stage) +
    record.receipts.length + record.acknowledgements.length +
    (record.fx_admission_decision === null ? 0 : 1) +
    (record.fx_final.binding === null ? 0 : 1) +
    (record.fx_final.receipt === null ? 0 : 1) +
    (record.fx_final.acknowledgement === null ? 0 : 1) +
    (record.fx_final.acknowledgement_applied ? 1 : 0)
  if (record.revision !== expectedRevision) {
    throw ledgerError(
      "corrupt_record",
      `${path} has revision ${record.revision}; expected ${expectedRevision}`,
    )
  }
  const receiptIds = new Set<string>()
  let previousReceiptStage = -1
  for (const receiptInput of record.receipts) {
    const receipt = parseEnsureReceipt(receiptInput)
    if (receiptIds.has(receipt.receipt_id)) {
      throw ledgerError("corrupt_record", `${path} repeats receipt ${receipt.receipt_id}`)
    }
    receiptIds.add(receipt.receipt_id)
    const receiptStage = STAGES.indexOf(assertHistoricalReceipt(record, receipt, path))
    if (receiptStage < previousReceiptStage) {
      throw ledgerError("corrupt_record", `${path} has regressive receipt history`)
    }
    previousReceiptStage = receiptStage
  }
  if (record.fx_final.receipt !== null) {
    if (receiptIds.has(record.fx_final.receipt.receipt_id)) {
      throw ledgerError(
        "corrupt_record",
        `${path} repeats receipt ${record.fx_final.receipt.receipt_id}`,
      )
    }
    receiptIds.add(record.fx_final.receipt.receipt_id)
  }
  if (record.fx_admission_decision !== null) {
    if (receiptIds.has(record.fx_admission_decision.receipt_id)) {
      throw ledgerError(
        "corrupt_record",
        `${path} repeats receipt ${record.fx_admission_decision.receipt_id}`,
      )
    }
    receiptIds.add(record.fx_admission_decision.receipt_id)
  }
  const acknowledgementIds = new Set<string>()
  const acknowledgedReceiptIds = new Set<string>()
  for (const acknowledgementInput of record.acknowledgements) {
    const acknowledgement = parseEnsureAcknowledgement(acknowledgementInput)
    if (acknowledgementIds.has(acknowledgement.acknowledgement_id)) {
      throw ledgerError(
        "corrupt_record",
        `${path} repeats acknowledgement ${acknowledgement.acknowledgement_id}`,
      )
    }
    acknowledgementIds.add(acknowledgement.acknowledgement_id)
    if (acknowledgedReceiptIds.has(acknowledgement.receipt_id)) {
      throw ledgerError(
        "corrupt_record",
        `${path} acknowledges receipt ${acknowledgement.receipt_id} more than once`,
      )
    }
    acknowledgedReceiptIds.add(acknowledgement.receipt_id)
    const receipt = record.receipts.find(
      ({ receipt_id }) => receipt_id === acknowledgement.receipt_id,
    )
    if (
      acknowledgement.ensure_id !== record.request.ensure_id ||
      !receipt ||
      receipt.receipt_digest !== acknowledgement.receipt_digest
    ) {
      throw ledgerError("corrupt_record", `${path} contains an orphaned acknowledgement`)
    }
  }
  if (record.fx_final.acknowledgement !== null) {
    if (acknowledgementIds.has(record.fx_final.acknowledgement.acknowledgement_id)) {
      throw ledgerError(
        "corrupt_record",
        `${path} repeats acknowledgement ${record.fx_final.acknowledgement.acknowledgement_id}`,
      )
    }
    acknowledgementIds.add(record.fx_final.acknowledgement.acknowledgement_id)
  }
}

function validateFxAdmissionDecision(record: EnsureLifecycleRecord, path: string): void {
  if (record.fx_admission_decision === null) {
    if (record.stage === "fx_started") {
      throw ledgerError("corrupt_record", `${path} started Fx without its admission decision`)
    }
    return
  }
  try {
    const decision = parseFxAdmissionDecision(record.fx_admission_decision)
    assertFxAdmissionDecisionCorrelation(record, decision, "corrupt_record")
    if (decision.decision.kind === "cancelled_before_start" && record.stage === "fx_started") {
      throw ledgerError("corrupt_record", `${path} starts Fx after a negative admission decision`)
    }
  } catch (error) {
    if (error instanceof EnsureLifecycleLedgerError && error.code === "corrupt_record") throw error
    const wrapped = ledgerError("corrupt_record", `${path} contains invalid Fx admission state`)
    wrapped.cause = error
    throw wrapped
  }
}

function validateFxFinalReceiptTransaction(
  record: EnsureLifecycleRecord,
  path: string,
): void {
  try {
    const transaction = record.fx_final
    if (transaction.binding !== null) parseFxFinalReceiptAuthorityBinding(transaction.binding)
    if (
      STAGES.indexOf(record.stage) >= STAGES.indexOf("companion_started") &&
      transaction.binding === null
    ) {
      throw ledgerError(
        "corrupt_record",
        `${path} started its Companion without Fx final authority`,
      )
    }
    if (transaction.receipt !== null) {
      if (record.fx_admission_decision?.decision.kind === "cancelled_before_start") {
        throw ledgerError(
          "corrupt_record",
          `${path} retains an Fx final receipt after cancellation won admission`,
        )
      }
      const receipt = parseFxFinalReceipt(transaction.receipt)
      assertFxFinalReceiptCorrelation(record, receipt, "corrupt_record")
    }
    if (transaction.acknowledgement !== null) {
      const acknowledgement = parseFxFinalReceiptAcknowledgement(transaction.acknowledgement)
      assertFxFinalAcknowledgementCorrelation(record, acknowledgement, "corrupt_record")
    }
    if (
      transaction.binding === null &&
      (transaction.receipt !== null || transaction.acknowledgement !== null ||
        transaction.acknowledgement_applied)
    ) {
      throw ledgerError("corrupt_record", `${path} retains Fx final state without its authority`)
    }
    if (transaction.receipt === null && transaction.acknowledgement !== null) {
      throw ledgerError(
        "corrupt_record",
        `${path} retains an Fx final acknowledgement without its receipt`,
      )
    }
    if (transaction.acknowledgement === null && transaction.acknowledgement_applied) {
      throw ledgerError(
        "corrupt_record",
        `${path} marks an absent Fx final acknowledgement applied`,
      )
    }
  } catch (error) {
    if (error instanceof EnsureLifecycleLedgerError && error.code === "corrupt_record") throw error
    const wrapped = ledgerError("corrupt_record", `${path} contains invalid Fx final state`)
    wrapped.cause = error
    throw wrapped
  }
}

function validateStageEffects(record: EnsureLifecycleRecord, path: string): void {
  const stageIndex = STAGES.indexOf(record.stage)
  const expected = effectsAtStage(record, record.stage)
  if (!sameCanonical(expected, record.effects)) {
    throw ledgerError("corrupt_record", `${path} effects do not match stage ${record.stage}`)
  }
  if (stageIndex < 0) throw ledgerError("corrupt_record", `${path} has an unknown stage`)
}

function assertHistoricalReceipt(
  record: EnsureLifecycleRecord,
  receipt: EnsureReceipt,
  path: string,
): EnsureLifecycleStage {
  const request = record.request
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
    if (receipt[field] !== request[field]) {
      throw ledgerError("corrupt_record", `${path} receipt changed ${field}`)
    }
  }
  const receiptStage = stageForEffects(record, receipt.effects)
  if (receiptStage === null || STAGES.indexOf(receiptStage) > STAGES.indexOf(record.stage)) {
    throw ledgerError("corrupt_record", `${path} receipt contains impossible effects`)
  }
  const expectedStatus = receiptStage === "fx_started" ? "complete" : "in_progress"
  if (receipt.status !== expectedStatus) {
    throw ledgerError("corrupt_record", `${path} receipt status conflicts with its effects`)
  }
  return receiptStage
}

function stageForEffects(
  record: EnsureLifecycleRecord,
  effects: EnsureLifecycleEffects,
): EnsureLifecycleStage | null {
  for (const stage of STAGES) {
    if (sameCanonical(effectsAtStage(record, stage), effects)) return stage
  }
  return null
}

function effectsAtStage(
  record: EnsureLifecycleRecord,
  stage: EnsureLifecycleStage,
): EnsureLifecycleEffects {
  const index = STAGES.indexOf(stage)
  const claimed = effectsForClaim(record.request)
  const worktree = record.effects.worktree.status === "created"
    ? structuredClone(record.effects.worktree)
    : null
  const manifest = record.effects.manifest.status === "claimed"
    ? structuredClone(record.effects.manifest)
    : null
  const companion = record.effects.companion.status === "started"
    ? structuredClone(record.effects.companion)
    : null
  const fx = record.effects.fx.status === "started" ? structuredClone(record.effects.fx) : null
  return {
    worktree: index >= 1 && worktree ? worktree : claimed.worktree,
    manifest: index >= 2 && manifest ? manifest : claimed.manifest,
    companion: index >= 3 && companion ? companion : claimed.companion,
    fx: index >= 4 && fx ? fx : claimed.fx,
  }
}

function validateIndex(records: EnsureLifecycleRecord[]): void {
  const ensureIds = new Set<string>()
  const launchIds = new Set<string>()
  const worktreeIds = new Set<string>()
  const agentIds = new Set<string>()
  const directories = new Set<string>()
  const receiptIds = new Set<string>()
  const acknowledgementIds = new Set<string>()
  const admissionKeys = new Set<string>()
  for (const record of records) {
    const request = record.request
    assertUnique(ensureIds, request.ensure_id, "ensure id")
    assertUnique(launchIds, request.launch_id, "launch id")
    assertUnique(worktreeIds, request.worktree_id, "Worktree id")
    assertUnique(agentIds, request.agent_id, "Agent id")
    assertUnique(directories, request.planned_worktree.directory, "Worktree directory")
    for (const receipt of record.receipts) assertUnique(receiptIds, receipt.receipt_id, "receipt id")
    if (record.fx_admission_decision !== null) {
      assertUnique(receiptIds, record.fx_admission_decision.receipt_id, "receipt id")
    }
    if (record.fx_final.binding !== null) {
      assertUnique(admissionKeys, record.fx_final.binding.admission_key, "Fx admission key")
    }
    if (record.fx_final.receipt !== null) {
      assertUnique(receiptIds, record.fx_final.receipt.receipt_id, "receipt id")
    }
    for (const acknowledgement of record.acknowledgements) {
      assertUnique(
        acknowledgementIds,
        acknowledgement.acknowledgement_id,
        "acknowledgement id",
      )
    }
    if (record.fx_final.acknowledgement !== null) {
      assertUnique(
        acknowledgementIds,
        record.fx_final.acknowledgement.acknowledgement_id,
        "acknowledgement id",
      )
    }
  }
}

function validateManagedIndex(
  legacy: EnsureLifecycleRecord[],
  managed: ManagedLaunchRecord[],
): void {
  const ensureIds = new Set(legacy.map((record) => record.request.ensure_id))
  const launchIds = new Set(legacy.map((record) => record.request.launch_id))
  const agentIds = new Set(legacy.map((record) => record.request.agent_id))
  const receiptIds = new Set(legacy.flatMap((record) => [
    ...record.receipts.map((receipt) => receipt.receipt_id),
    ...(record.fx_admission_decision === null ? [] : [record.fx_admission_decision.receipt_id]),
    ...(record.fx_final.receipt === null ? [] : [record.fx_final.receipt.receipt_id]),
  ]))
  const acknowledgementIds = new Set(legacy.flatMap((record) => [
    ...record.acknowledgements.map((value) => value.acknowledgement_id),
    ...(record.fx_final.acknowledgement === null
      ? []
      : [record.fx_final.acknowledgement.acknowledgement_id]),
  ]))
  const admissionKeys = new Set(legacy.flatMap((record) =>
    record.fx_final.binding === null ? [] : [record.fx_final.binding.admission_key]))
  for (const record of managed) {
    validateManagedRecord(record, `managed launch ${record.request.ensure_id}`)
    assertUnique(ensureIds, record.request.ensure_id, "ensure id")
    assertUnique(launchIds, record.request.launch_id, "launch id")
    assertUnique(agentIds, record.request.agent_id, "Agent id")
    for (const transaction of record.outcome_history) {
      assertUnique(receiptIds, transaction.receipt.receipt_id, "receipt id")
      assertUnique(
        acknowledgementIds,
        transaction.acknowledgement!.acknowledgement_id,
        "acknowledgement id",
      )
    }
    if (record.outcome.receipt !== null) {
      assertUnique(receiptIds, record.outcome.receipt.receipt_id, "receipt id")
    }
    if (record.fx_admission_decision !== null) {
      assertUnique(receiptIds, record.fx_admission_decision.receipt_id, "receipt id")
    }
    if (record.fx_final.receipt !== null) {
      assertUnique(receiptIds, record.fx_final.receipt.receipt_id, "receipt id")
    }
    if (record.outcome.acknowledgement !== null) {
      assertUnique(
        acknowledgementIds,
        record.outcome.acknowledgement.acknowledgement_id,
        "acknowledgement id",
      )
    }
    if (record.fx_final.acknowledgement !== null) {
      assertUnique(
        acknowledgementIds,
        record.fx_final.acknowledgement.acknowledgement_id,
        "acknowledgement id",
      )
    }
    if (record.fx_final.binding !== null) {
      assertUnique(admissionKeys, record.fx_final.binding.admission_key, "Fx admission key")
    }
  }
}

function assertSecondaryClaimsAvailable(
  records: EnsureLifecycleRecord[],
  request: EnsureRequest,
): void {
  for (const record of records) {
    const existing = record.request
    for (const [label, left, right] of [
      ["launch id", existing.launch_id, request.launch_id],
      ["Worktree id", existing.worktree_id, request.worktree_id],
      ["Agent id", existing.agent_id, request.agent_id],
      ["Worktree directory", existing.planned_worktree.directory, request.planned_worktree.directory],
    ] as const) {
      if (left === right) {
        throw ledgerError(
          "conflicting_claim",
          `${label} ${right} is already bound to ensure ${existing.ensure_id}`,
        )
      }
    }
  }
}

function assertCrossClaimAvailable(
  records: ManagedLaunchRecord[],
  request: EnsureRequest,
): void {
  for (const record of records) {
    if (
      record.request.launch_id === request.launch_id ||
      record.request.agent_id === request.agent_id
    ) {
      throw ledgerError(
        "conflicting_claim",
        `frozen ensure ${request.ensure_id} collides with managed launch ${record.request.ensure_id}`,
      )
    }
  }
}

function assertManagedSecondaryClaimsAvailable(
  index: RecordIndex,
  request: ManagedLaunchRequest,
): void {
  for (const record of [...index.records, ...index.managedRecords]) {
    if (
      record.request.launch_id === request.launch_id ||
      record.request.agent_id === request.agent_id
    ) {
      throw ledgerError(
        "conflicting_claim",
        `managed launch ${request.ensure_id} collides with ensure ${record.request.ensure_id}`,
      )
    }
  }
}

function assertAnyReceiptIdAvailable(index: RecordIndex, receiptId: string): void {
  assertReceiptIdAvailable(index.records, receiptId)
  for (const record of index.managedRecords) {
    if (
      record.outcome_history.some((value) => value.receipt.receipt_id === receiptId) ||
      record.outcome.receipt?.receipt_id === receiptId ||
      record.fx_admission_decision?.receipt_id === receiptId ||
      record.fx_final.receipt?.receipt_id === receiptId
    ) {
      throw ledgerError("receipt_conflict", `receipt id ${receiptId} belongs to another receipt`)
    }
  }
}

function assertAnyAcknowledgementIdAvailable(
  index: RecordIndex,
  acknowledgementId: string,
): void {
  assertAcknowledgementIdAvailable(index.records, acknowledgementId)
  for (const record of index.managedRecords) {
    if (
      record.outcome_history.some(
        (value) => value.acknowledgement?.acknowledgement_id === acknowledgementId,
      ) ||
      record.outcome.acknowledgement?.acknowledgement_id === acknowledgementId ||
      record.fx_final.acknowledgement?.acknowledgement_id === acknowledgementId
    ) {
      throw ledgerError(
        "acknowledgement_conflict",
        `acknowledgement id ${acknowledgementId} belongs to another acknowledgement`,
      )
    }
  }
}

function assertUnique(values: Set<string>, value: string, label: string): void {
  if (values.has(value)) throw ledgerError("corrupt_record", `ensure ledger repeats ${label} ${value}`)
  values.add(value)
}

function requireRecord(index: RecordIndex, ensureId: string): EnsureLifecycleRecord {
  const record = index.byEnsureId.get(ensureId)
  if (!record) throw ledgerError("conflicting_claim", `unknown ensure id ${ensureId}`)
  return record
}

function requireManagedRecord(index: RecordIndex, ensureId: string): ManagedLaunchRecord {
  const record = index.managedByEnsureId.get(ensureId)
  if (!record) throw ledgerError("conflicting_claim", `unknown managed ensure id ${ensureId}`)
  return record
}

function requireRecordIdentity(index: RecordIndex, ensureId: string): Stats {
  const identity = index.identities.get(ensureId)
  if (!identity) throw ledgerError("corrupt_record", `ensure ${ensureId} has no file identity`)
  return identity
}

async function readRecord(
  path: string,
  uid: number,
): Promise<{ identity: Stats; record: LifecycleLedgerRecord }> {
  const { bytes, initial } = await readSafeFile(path, uid)
  try {
    if (bytes.byteLength < 2 || bytes[bytes.byteLength - 1] !== 0x0a) {
      throw ledgerError("corrupt_record", `${path} is not one canonical JSON line`)
    }
    const payload = bytes.subarray(0, bytes.byteLength - 1)
    const value = decodeStrictJson(payload)
    const canonical = encodeCanonicalJson(value)
    if (!Buffer.from(canonical).equals(payload)) {
      throw ledgerError("corrupt_record", `${path} is not canonical JSON`)
    }
    const managed = managedPrivateRecordSchema.safeParse(value)
    if (managed.success) {
      const record = decodeManagedRecord(managed.data, path)
      if (initial.size !== bytes.byteLength) {
        throw ledgerError("corrupt_record", `${path} changed while being read`)
      }
      return { identity: initial, record }
    }
    const parsed = privateRecordSchema.safeParse(value)
    if (!parsed.success) {
      throw ledgerError("corrupt_record", `${path} is not a valid private ensure ledger record`)
    }
    if (
      !("planned_worktree" in parsed.data.request) ||
      parsed.data.request.message_type !== "ensure_request"
    ) {
      throw ledgerError("corrupt_record", `${path} does not retain an ensure request`)
    }
    const receipts: EnsureReceipt[] = []
    for (const message of parsed.data.receipts) {
      if (!("effects" in message) || message.message_type !== "ensure_receipt") {
        throw ledgerError("corrupt_record", `${path} retains a non-ensure receipt`)
      }
      receipts.push({ ...message, message_type: "ensure_receipt" })
    }
    const acknowledgements: EnsureReceiptAcknowledgement[] = []
    for (const message of parsed.data.acknowledgements) {
      if (
        !("acknowledgement_id" in message) ||
        message.message_type !== "receipt_acknowledgement" ||
        message.receipt_kind !== "ensure"
      ) {
        throw ledgerError("corrupt_record", `${path} retains a non-ensure acknowledgement`)
      }
      acknowledgements.push({ ...message, message_type: "receipt_acknowledgement" })
    }
    const binding = parsed.data.fx_final.binding === null
      ? null
      : parseFxFinalReceiptAuthorityBinding(parsed.data.fx_final.binding)
    const admissionDecision = parsed.data.fx_admission_decision === null
      ? null
      : parseFxAdmissionDecision(parsed.data.fx_admission_decision as FxAdmissionDecision)
    const finalReceipt = parsed.data.fx_final.receipt === null
      ? null
      : parseFxFinalReceipt(parsed.data.fx_final.receipt as FxFinalReceipt)
    const finalAcknowledgement = parsed.data.fx_final.acknowledgement === null
      ? null
      : parseFxFinalReceiptAcknowledgement(
        parsed.data.fx_final.acknowledgement as FxFinalReceiptAcknowledgement,
      )
    const record: EnsureLifecycleRecord = {
      schema_id: LEDGER_SCHEMA_ID,
      schema_version: LEDGER_SCHEMA_VERSION,
      revision: parsed.data.revision,
      request: { ...parsed.data.request, message_type: "ensure_request" },
      stage: parsed.data.stage,
      effects: parsed.data.effects,
      receipts,
      acknowledgements,
      fx_admission_decision: admissionDecision,
      fx_final: {
        binding,
        receipt: finalReceipt,
        acknowledgement: finalAcknowledgement,
        acknowledgement_applied: parsed.data.fx_final.acknowledgement_applied,
      },
    }
    validateRecord(record, path)
    if (initial.size !== bytes.byteLength) {
      throw ledgerError("corrupt_record", `${path} changed while being read`)
    }
    return { identity: initial, record }
  } catch (error) {
    if (error instanceof EnsureLifecycleLedgerError && error.code === "corrupt_record") throw error
    const wrapped = ledgerError("corrupt_record", `${path} could not be decoded as a private ensure record`)
    wrapped.cause = error
    throw wrapped
  }
}

function decodeManagedRecord(
  input: z.infer<typeof managedPrivateRecordSchema>,
  path: string,
): ManagedLaunchRecord {
  const request = parseManagedLaunchRequest(input.request)
  const binding = input.fx_final.binding === null
    ? null
    : parseFxFinalReceiptAuthorityBinding(input.fx_final.binding)
  const admissionDecision = input.fx_admission_decision === null
    ? null
    : parseFxAdmissionDecision(input.fx_admission_decision as FxAdmissionDecision)
  const finalReceipt = input.fx_final.receipt === null
    ? null
    : parseFxFinalReceipt(input.fx_final.receipt as FxFinalReceipt)
  const finalAcknowledgement = input.fx_final.acknowledgement === null
    ? null
    : parseFxFinalReceiptAcknowledgement(
      input.fx_final.acknowledgement as FxFinalReceiptAcknowledgement,
    )
  const record: ManagedLaunchRecord = {
    schema_id: LEDGER_SCHEMA_ID,
    schema_version: MANAGED_LEDGER_SCHEMA_VERSION,
    revision: input.revision,
    request,
    stage: input.stage,
    effects: structuredClone(input.effects),
    prepared_conversation_id: input.prepared_conversation_id,
    attempt: input.attempt,
    outcome_history: input.outcome_history.map((transaction) => ({
      receipt: parseManagedLaunchOutcome(transaction.receipt),
      acknowledgement: parseManagedLaunchAcknowledgement(transaction.acknowledgement),
      retry: parseManagedLaunchRetry(transaction.retry),
    })),
    outcome: {
      receipt: input.outcome.receipt === null
        ? null
        : parseManagedLaunchOutcome(input.outcome.receipt),
      acknowledgement: input.outcome.acknowledgement === null
        ? null
        : parseManagedLaunchAcknowledgement(input.outcome.acknowledgement),
    },
    fx_admission_decision: admissionDecision,
    fx_final: {
      binding,
      receipt: finalReceipt,
      acknowledgement: finalAcknowledgement,
      acknowledgement_applied: input.fx_final.acknowledgement_applied,
    },
  }
  validateManagedRecord(record, path)
  return record
}

async function readSafeFile(path: string, uid: number): Promise<{ bytes: Buffer; initial: Stats }> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw unsafeStorage(`${path} could not be opened without following links`, error)
  }
  try {
    const initial = await handle.stat()
    assertSafeStats(path, initial, uid)
    if (initial.size < 1 || initial.size > CONTRACT_MAX_FRAME_BYTES) {
      throw ledgerError("corrupt_record", `${path} has unsafe size ${initial.size}`)
    }
    const bytes = Buffer.alloc(initial.size + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const final = await handle.stat()
    if (
      offset !== initial.size ||
      !sameFileIdentity(initial, final) ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      throw ledgerError("corrupt_record", `${path} changed while being read`)
    }
    return { bytes: bytes.subarray(0, offset), initial }
  } finally {
    await handle.close()
  }
}

async function ensurePrivateRoot(root: string, uid: number): Promise<Stats> {
  let existed = true
  try {
    await lstat(root)
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw unsafeStorage(`cannot inspect ledger root ${root}`, error)
    existed = false
    await mkdir(root, { recursive: true, mode: 0o700 })
  }
  const info = await lstat(root)
  assertSafeRootStats(root, info, uid)
  if (await realpath(root) !== root) {
    throw unsafeStorage(`ensure ledger root ${root} crosses a symbolic link`)
  }
  if (!existed) await syncDirectory(dirname(root))
  return info
}

async function ensureLockFile(root: string, uid: number): Promise<Stats> {
  const path = resolve(root, LOCK_FILE)
  let handle: FileHandle | null = null
  let created = false
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    created = true
    await handle.chmod(0o600)
    await handle.sync()
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw unsafeStorage(`cannot create ensure ledger lock ${path}`, error)
  } finally {
    await handle?.close()
  }
  const identity = await assertSafeFile(path, uid)
  if (created) await syncDirectory(root)
  return identity
}

async function assertStorageGuard(
  root: string,
  guard: StorageGuard,
  uid: number,
): Promise<void> {
  const directoryIdentity = await guard.directory.stat()
  assertSafeRootStats(root, directoryIdentity, uid)
  if (!sameRootIdentity(guard.rootIdentity, directoryIdentity)) {
    throw unsafeStorage(`ensure ledger root descriptor changed: ${root}`)
  }
  const rootPathIdentity = await lstat(root)
  assertSafeRootStats(root, rootPathIdentity, uid)
  if (
    !sameRootIdentity(guard.rootIdentity, rootPathIdentity) ||
    await realpath(root) !== root
  ) {
    throw unsafeStorage(`ensure ledger root path changed while locked: ${root}`)
  }

  const lockPath = resolve(root, LOCK_FILE)
  const lockedIdentity = fstatSync(guard.lock.descriptor)
  assertSafeStats(lockPath, lockedIdentity, uid)
  if (!sameFileIdentity(guard.lockIdentity, lockedIdentity)) {
    throw unsafeStorage(`ensure ledger lock descriptor changed: ${lockPath}`)
  }
  const lockPathIdentity = await assertSafeFile(lockPath, uid)
  if (!sameFileIdentity(guard.lockIdentity, lockPathIdentity)) {
    throw unsafeStorage(`ensure ledger lock path changed while held: ${lockPath}`)
  }
}

async function assertTargetSnapshot(
  path: string,
  expected: Stats | null,
  uid: number,
): Promise<void> {
  if (expected === null) {
    try {
      await lstat(path)
    } catch (error) {
      if (isErrno(error, "ENOENT")) return
      throw unsafeStorage(`cannot inspect new ensure ledger target ${path}`, error)
    }
    throw unsafeStorage(`new ensure ledger target already exists: ${path}`)
  }
  const current = await assertSafeFile(path, uid)
  if (!sameFileSnapshot(expected, current)) {
    throw unsafeStorage(`ensure ledger target changed during its transaction: ${path}`)
  }
}

async function assertSafeFile(path: string, uid: number): Promise<Stats> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw unsafeStorage(`${path} could not be opened without following links`, error)
  }
  try {
    const info = await handle.stat()
    assertSafeStats(path, info, uid)
    return info
  } finally {
    await handle.close()
  }
}

function assertSafeStats(path: string, info: Stats, uid: number): void {
  if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) {
    throw unsafeStorage(`${path} must be one uid-${uid} regular file with mode 0600`)
  }
}

function assertSafeRootStats(path: string, info: Stats, uid: number): void {
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw unsafeStorage(`${path} must be one uid-${uid} real directory with mode 0700`)
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function assertRootPath(root: string): void {
  if (!isAbsolute(root) || root === "/" || resolve(root) !== root || root.includes("\0")) {
    throw ledgerError("invalid_root", `ensure ledger root must be one normalized absolute directory: ${root}`)
  }
}

function recordFileName(ensureId: string): string {
  return `${createHash("sha256").update(ensureId).digest("hex")}.json`
}

function sameEnsureClaim(left: EnsureRequest, right: EnsureRequest): boolean {
  return left.ensure_id === right.ensure_id &&
    left.ensure_digest === right.ensure_digest &&
    sameCanonical(ensureSpecification(left), ensureSpecification(right))
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalJson(left as JsonValue))
    .equals(Buffer.from(encodeCanonicalJson(right as JsonValue)))
}

function copyRecord(record: EnsureLifecycleRecord): EnsureLifecycleRecord {
  return structuredClone(record)
}

function copyManagedRecord(record: ManagedLaunchRecord): ManagedLaunchRecord {
  return structuredClone(record)
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.nlink === right.nlink
}

function sameRootIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function ledgerError(
  code: EnsureLifecycleLedgerErrorCode,
  message: string,
): EnsureLifecycleLedgerError {
  return new EnsureLifecycleLedgerError(code, message)
}

function unsafeStorage(message: string, cause?: unknown): EnsureLifecycleLedgerError {
  const error = ledgerError("unsafe_storage", message)
  if (cause !== undefined) error.cause = cause
  return error
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}
