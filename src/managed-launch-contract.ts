import { createHash } from "node:crypto"
import { isAbsolute, normalize, relative } from "node:path"
import * as z from "zod/v4"
import {
  fxLaunchAdmissionFinalMessageSchema,
  isAgentWorkplaceConversationId,
} from "./agentworkplace-contracts.ts"
import {
  CONTRACT_MAX_FRAME_BYTES,
  ContractCodecError,
  decodeStrictJson,
  encodeCanonicalJson,
  encodeContractFrame,
  type JsonValue,
} from "./contract-codec.ts"
import {
  INLINE_INITIAL_WORK_MAX_BYTES,
  INLINE_LAUNCH_CONTROLS_MAX_BYTES,
  INLINE_SOURCE_COMBINED_MAX_BYTES,
  deriveFrozenLaunchDigest,
  parseInlineLaunchControls,
  type FrozenLaunchRequest,
} from "./inline-launch-source.ts"

export const MANAGED_LAUNCH_SCHEMA_ID = "fmx.managed-launch"
export const MANAGED_LAUNCH_SCHEMA_VERSION = 1

const SAFE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u
const FMX_SESSION = /^(?:default|[a-z][a-z0-9_-]{0,31})$/u
const AGENT_ID = /^[0-9a-f]{32}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

export const MANAGED_LAUNCH_STAGES = [
  "existing_directory",
  "manifest_claim",
  "launch_provider",
  "companion_start",
  "fx_admission",
] as const

export const MANAGED_LAUNCH_CAUSES = [
  "existing_directory_unavailable",
  "git_identity_changed",
  "manifest_claim_failed",
  "launch_provider_unavailable",
  "exact_resume_refused",
  "companion_start_uncertain",
  "fx_admission_unavailable",
  "internal_failure",
] as const

export const MANAGED_LAUNCH_PROCESS_CERTAINTIES = [
  "not_started",
  "may_have_started",
  "started",
] as const

export type ManagedLaunchStage = (typeof MANAGED_LAUNCH_STAGES)[number]
export type ManagedLaunchCause = (typeof MANAGED_LAUNCH_CAUSES)[number]
export type ManagedLaunchProcessCertainty =
  (typeof MANAGED_LAUNCH_PROCESS_CERTAINTIES)[number]
export type ManagedLaunchClassification = "retryable" | "uncertain" | "permanent"

const safeTokenSchema = z.string().regex(SAFE_TOKEN)
const digestSchema = z.string().regex(SHA256)
const absolutePathSchema = z.string().min(1).max(4096).superRefine((value, context) => {
  if (
    !isAbsolute(value) ||
    value === "/" ||
    normalize(value) !== value ||
    CONTROL_CHARACTERS.test(value)
  ) {
    context.addIssue({
      code: "custom",
      message: "path must be one normalized absolute non-root path",
    })
  }
})

const inlineBytesSchema = (maximum: number) => z.strictObject({
  encoding: z.literal("base64"),
  data: z.string().max(Math.ceil(maximum / 3) * 4),
  byte_length: z.number().int().nonnegative().max(maximum),
  sha256: digestSchema,
})

const workspaceSchema = z.strictObject({
  kind: z.literal("existing_directory"),
  directory: absolutePathSchema,
  repository: absolutePathSchema,
  checkout_root: absolutePathSchema,
  head_commit: z.string().regex(GIT_OBJECT_ID),
}).superRefine((value, context) => {
  const beneathCheckout = relative(value.checkout_root, value.directory)
  if (isAbsolute(beneathCheckout) || beneathCheckout.startsWith("..")) {
    context.addIssue({
      code: "custom",
      path: ["directory"],
      message: "existing directory must stay within its exact checkout root",
    })
  }
})

const managedSourceSchema = z.strictObject({
  source_id: safeTokenSchema,
  source_digest: digestSchema,
  admission_key: safeTokenSchema,
  launch_request: fxLaunchAdmissionFinalMessageSchema,
  initial_work: inlineBytesSchema(INLINE_INITIAL_WORK_MAX_BYTES),
  launch_controls: inlineBytesSchema(INLINE_LAUNCH_CONTROLS_MAX_BYTES),
})

export const managedLaunchRequestSchema = z.strictObject({
  schema_id: z.literal(MANAGED_LAUNCH_SCHEMA_ID),
  schema_version: z.literal(MANAGED_LAUNCH_SCHEMA_VERSION),
  message_type: z.literal("launch_request"),
  request_id: safeTokenSchema,
  workplace_instance_id: safeTokenSchema,
  fmx_session: z.string().regex(FMX_SESSION),
  ensure_id: safeTokenSchema,
  ensure_digest: digestSchema,
  launch_id: safeTokenSchema,
  launch_digest: digestSchema,
  agent_id: z.string().regex(AGENT_ID),
  workspace: workspaceSchema,
  fx_conversation: z.strictObject({
    name: z.string().min(1).max(256),
    resume_conversation_id: safeTokenSchema.nullable(),
  }),
  source: managedSourceSchema,
})

const exactResumeProofSchema = z.strictObject({
  kind: z.literal("exact_resume_refused"),
  authority: z.literal("fx.private-launch-provider/resume-status-v2"),
  semantic_decision: z.literal("exact_resume_unavailable"),
  status: z.literal("unavailable"),
  decision_id: safeTokenSchema,
  decision_digest: digestSchema,
  admission_key: safeTokenSchema,
  conversation_id: safeTokenSchema,
  launch_digest: digestSchema,
  launch_id: safeTokenSchema,
  state_root: absolutePathSchema,
})

const managedLaunchOutcomeEnvelope = {
  schema_id: z.literal(MANAGED_LAUNCH_SCHEMA_ID),
  schema_version: z.literal(MANAGED_LAUNCH_SCHEMA_VERSION),
  message_type: z.literal("launch_outcome"),
  request_id: safeTokenSchema,
  receipt_id: safeTokenSchema,
  receipt_digest: digestSchema,
  workplace_instance_id: safeTokenSchema,
  fmx_session: z.string().regex(FMX_SESSION),
  ensure_id: safeTokenSchema,
  ensure_digest: digestSchema,
  launch_id: safeTokenSchema,
  launch_digest: digestSchema,
  agent_id: z.string().regex(AGENT_ID),
  attempt: z.number().int().positive().max(4096),
  retained_until_acknowledged: z.literal(true),
}

const managedLaunchSucceededOutcomeSchema = z.strictObject({
  ...managedLaunchOutcomeEnvelope,
  status: z.literal("succeeded"),
  classification: z.null(),
  stage: z.literal("fx_admission"),
  cause: z.null(),
  process_certainty: z.literal("started"),
  exact_resume_proof: z.null(),
  success: z.strictObject({
    conversation_id: safeTokenSchema,
    admission_receipt_id: safeTokenSchema,
    admission_receipt_digest: digestSchema,
  }),
})

const managedLaunchFailedOutcomeSchema = z.strictObject({
  ...managedLaunchOutcomeEnvelope,
  status: z.literal("failed"),
  classification: z.enum(["retryable", "uncertain", "permanent"]),
  stage: z.enum(MANAGED_LAUNCH_STAGES),
  cause: z.enum(MANAGED_LAUNCH_CAUSES),
  process_certainty: z.enum(MANAGED_LAUNCH_PROCESS_CERTAINTIES),
  exact_resume_proof: exactResumeProofSchema.nullable(),
  success: z.null(),
}).superRefine((value, context) => {
  const exactRefusal = value.cause === "exact_resume_refused"
  if (
    exactRefusal !== (value.exact_resume_proof !== null) ||
    exactRefusal !== (value.classification === "permanent")
  ) {
    context.addIssue({
      code: "custom",
      message: "permanent exact-resume refusal and its proof must appear together",
    })
  }
  if (value.classification === "permanent" && value.process_certainty !== "not_started") {
    context.addIssue({
      code: "custom",
      path: ["process_certainty"],
      message: "permanent exact-resume refusal must prove that no process started",
    })
  }
  if (
    value.stage === "companion_start" &&
    value.process_certainty === "not_started" &&
    value.classification === "uncertain"
  ) {
    context.addIssue({
      code: "custom",
      path: ["process_certainty"],
      message: "an uncertain Companion start cannot claim that no process started",
    })
  }
  if (value.stage === "fx_admission" && value.process_certainty !== "started") {
    context.addIssue({
      code: "custom",
      path: ["process_certainty"],
      message: "Fx admission outcomes follow a durably started process",
    })
  }
})

export const managedLaunchOutcomeSchema = z.discriminatedUnion("status", [
  managedLaunchSucceededOutcomeSchema,
  managedLaunchFailedOutcomeSchema,
])

export const managedLaunchAcknowledgementSchema = z.strictObject({
  schema_id: z.literal(MANAGED_LAUNCH_SCHEMA_ID),
  schema_version: z.literal(MANAGED_LAUNCH_SCHEMA_VERSION),
  message_type: z.literal("outcome_acknowledgement"),
  acknowledgement_id: safeTokenSchema,
  workplace_instance_id: safeTokenSchema,
  fmx_session: z.string().regex(FMX_SESSION),
  receipt_id: safeTokenSchema,
  receipt_digest: digestSchema,
  attempt: z.number().int().positive().max(4096),
  ensure_id: safeTokenSchema,
  ensure_digest: digestSchema,
  launch_id: safeTokenSchema,
  launch_digest: digestSchema,
  agent_id: z.string().regex(AGENT_ID),
})

const managedTerminalEnvelope = {
  schema_id: z.literal(MANAGED_LAUNCH_SCHEMA_ID),
  schema_version: z.literal(MANAGED_LAUNCH_SCHEMA_VERSION),
  workplace_instance_id: safeTokenSchema,
  fmx_session: z.string().regex(FMX_SESSION),
  ensure_id: safeTokenSchema,
  ensure_digest: digestSchema,
  launch_id: safeTokenSchema,
  launch_digest: digestSchema,
  agent_id: z.string().regex(AGENT_ID),
  attempt: z.number().int().positive().max(4096),
}

export const managedLaunchTerminalReceiptSchema = z.strictObject({
  ...managedTerminalEnvelope,
  message_type: z.literal("terminal_receipt"),
  receipt_id: safeTokenSchema,
  receipt_digest: digestSchema,
  fx_final_receipt: fxLaunchAdmissionFinalMessageSchema,
  retained_until_acknowledged: z.literal(true),
}).superRefine((value, context) => {
  if (value.fx_final_receipt.message_type !== "final_receipt") {
    context.addIssue({
      code: "custom",
      path: ["fx_final_receipt"],
      message: "managed terminal receipt must carry one exact Fx final receipt",
    })
    return
  }
  if (
    value.fx_final_receipt.launch_id !== value.launch_id ||
    value.fx_final_receipt.launch_digest !== value.launch_digest
  ) {
    context.addIssue({
      code: "custom",
      path: ["fx_final_receipt"],
      message: "managed terminal receipt changed the exact Fx launch correlation",
    })
  }
})

export const managedLaunchTerminalAcknowledgementSchema = z.strictObject({
  ...managedTerminalEnvelope,
  message_type: z.literal("terminal_acknowledgement"),
  acknowledgement_id: safeTokenSchema,
  receipt_id: safeTokenSchema,
  receipt_digest: digestSchema,
})

export const managedLaunchRetrySchema = z.strictObject({
  schema_id: z.literal(MANAGED_LAUNCH_SCHEMA_ID),
  schema_version: z.literal(MANAGED_LAUNCH_SCHEMA_VERSION),
  message_type: z.literal("retry_request"),
  request_id: safeTokenSchema,
  workplace_instance_id: safeTokenSchema,
  fmx_session: z.string().regex(FMX_SESSION),
  ensure_id: safeTokenSchema,
  ensure_digest: digestSchema,
  launch_id: safeTokenSchema,
  launch_digest: digestSchema,
  agent_id: z.string().regex(AGENT_ID),
  prior_attempt: z.number().int().positive().max(4095),
  prior_receipt_id: safeTokenSchema,
  prior_receipt_digest: digestSchema,
  next_attempt: z.number().int().min(2).max(4096),
}).superRefine((value, context) => {
  if (value.next_attempt !== value.prior_attempt + 1) {
    context.addIssue({
      code: "custom",
      path: ["next_attempt"],
      message: "managed retry must advance exactly one attempt",
    })
  }
})

export const managedLaunchMessageSchema = z.union([
  managedLaunchRequestSchema,
  managedLaunchOutcomeSchema,
  managedLaunchAcknowledgementSchema,
  managedLaunchTerminalReceiptSchema,
  managedLaunchTerminalAcknowledgementSchema,
  managedLaunchRetrySchema,
])

export type ManagedLaunchRequest = z.infer<typeof managedLaunchRequestSchema> & {
  source: z.infer<typeof managedSourceSchema> & { launch_request: FrozenLaunchRequest }
}
export type ManagedLaunchOutcome = z.infer<typeof managedLaunchOutcomeSchema>
export type ManagedLaunchAcknowledgement = z.infer<
  typeof managedLaunchAcknowledgementSchema
>
export type ManagedLaunchRetry = z.infer<typeof managedLaunchRetrySchema>
export type ManagedLaunchTerminalReceipt = Omit<
  z.infer<typeof managedLaunchTerminalReceiptSchema>,
  "fx_final_receipt"
> & {
  fx_final_receipt: Omit<
    Extract<z.infer<typeof fxLaunchAdmissionFinalMessageSchema>, { outcome: unknown }>,
    "message_type"
  > & { message_type: "final_receipt" }
}
export type ManagedLaunchTerminalAcknowledgement = z.infer<
  typeof managedLaunchTerminalAcknowledgementSchema
>
export type ManagedLaunchMessage = z.infer<typeof managedLaunchMessageSchema>

export function parseManagedLaunchRequest(input: unknown): ManagedLaunchRequest {
  const parsed = managedLaunchRequestSchema.safeParse(input)
  if (
    !parsed.success ||
    parsed.data.source.launch_request.message_type !== "launch_request" ||
    !("initial_work_digest" in parsed.data.source.launch_request)
  ) {
    throw codecError(parsed, "managed launch is not one strict launch_request")
  }
  const request = structuredClone(parsed.data) as ManagedLaunchRequest
  validateManagedLaunchRequest(request)
  return request
}

export function parseManagedLaunchOutcome(input: unknown): ManagedLaunchOutcome {
  const parsed = managedLaunchOutcomeSchema.safeParse(input)
  if (!parsed.success) throw codecError(parsed, "managed launch outcome is invalid")
  const outcome = structuredClone(parsed.data)
  if (
    outcome.exact_resume_proof !== null &&
    (deriveManagedExactResumeDecisionId(outcome.exact_resume_proof) !==
      outcome.exact_resume_proof.decision_id ||
      deriveManagedExactResumeDecisionDigest(outcome.exact_resume_proof) !==
        outcome.exact_resume_proof.decision_digest)
  ) {
    throw new ContractCodecError(
      "invalid_message",
      "managed exact-resume semantic decision has an invalid digest",
    )
  }
  if (deriveManagedLaunchOutcomeDigest(outcome) !== outcome.receipt_digest) {
    throw new ContractCodecError(
      "invalid_message",
      `managed launch outcome ${outcome.receipt_id} has an invalid digest`,
    )
  }
  return outcome
}

export function parseManagedLaunchAcknowledgement(
  input: unknown,
): ManagedLaunchAcknowledgement {
  const parsed = managedLaunchAcknowledgementSchema.safeParse(input)
  if (!parsed.success) throw codecError(parsed, "managed launch acknowledgement is invalid")
  return structuredClone(parsed.data)
}

export function parseManagedLaunchTerminalReceipt(
  input: unknown,
): ManagedLaunchTerminalReceipt {
  const parsed = managedLaunchTerminalReceiptSchema.safeParse(input)
  if (
    !parsed.success ||
    parsed.data.fx_final_receipt.message_type !== "final_receipt"
  ) {
    throw codecError(parsed, "managed terminal receipt is invalid")
  }
  const receipt = structuredClone(parsed.data) as ManagedLaunchTerminalReceipt
  if (deriveManagedLaunchTerminalReceiptId(receipt) !== receipt.receipt_id) {
    throw new ContractCodecError(
      "invalid_message",
      `managed terminal receipt ${receipt.receipt_id} has an invalid identity`,
    )
  }
  if (deriveManagedLaunchTerminalReceiptDigest(receipt) !== receipt.receipt_digest) {
    throw new ContractCodecError(
      "invalid_message",
      `managed terminal receipt ${receipt.receipt_id} has an invalid digest`,
    )
  }
  return receipt
}

export function parseManagedLaunchTerminalAcknowledgement(
  input: unknown,
): ManagedLaunchTerminalAcknowledgement {
  const parsed = managedLaunchTerminalAcknowledgementSchema.safeParse(input)
  if (!parsed.success) {
    throw codecError(parsed, "managed terminal acknowledgement is invalid")
  }
  return structuredClone(parsed.data)
}

export function parseManagedLaunchRetry(input: unknown): ManagedLaunchRetry {
  const parsed = managedLaunchRetrySchema.safeParse(input)
  if (!parsed.success) throw codecError(parsed, "managed launch retry is invalid")
  return structuredClone(parsed.data)
}

export function decodeManagedLaunchPayload(payload: Uint8Array): ManagedLaunchMessage {
  const value = decodeStrictJson(payload)
  if (!Buffer.from(encodeCanonicalJson(value)).equals(Buffer.from(payload))) {
    throw new ContractCodecError(
      "invalid_message",
      "managed launch payload is not canonical JSON",
    )
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractCodecError("invalid_message", "managed launch envelope must be an object")
  }
  if (value.schema_id !== MANAGED_LAUNCH_SCHEMA_ID) {
    throw new ContractCodecError("unsupported_schema", "unsupported managed launch schema")
  }
  if (value.schema_version !== MANAGED_LAUNCH_SCHEMA_VERSION) {
    throw new ContractCodecError(
      "unsupported_schema_version",
      `unsupported managed launch schema version: ${String(value.schema_version)}`,
    )
  }
  switch (value.message_type) {
    case "launch_request":
      return parseManagedLaunchRequest(value)
    case "launch_outcome":
      return parseManagedLaunchOutcome(value)
    case "outcome_acknowledgement":
      return parseManagedLaunchAcknowledgement(value)
    case "terminal_receipt":
      return parseManagedLaunchTerminalReceipt(value)
    case "terminal_acknowledgement":
      return parseManagedLaunchTerminalAcknowledgement(value)
    case "retry_request":
      return parseManagedLaunchRetry(value)
    default:
      throw new ContractCodecError("invalid_message", "unknown managed launch message type")
  }
}

export function encodeManagedLaunchPayload(message: ManagedLaunchMessage): Uint8Array {
  if (message.message_type === "launch_request") parseManagedLaunchRequest(message)
  else if (message.message_type === "launch_outcome") parseManagedLaunchOutcome(message)
  else if (message.message_type === "outcome_acknowledgement") {
    parseManagedLaunchAcknowledgement(message)
  } else if (message.message_type === "terminal_receipt") {
    parseManagedLaunchTerminalReceipt(message)
  } else if (message.message_type === "terminal_acknowledgement") {
    parseManagedLaunchTerminalAcknowledgement(message)
  } else parseManagedLaunchRetry(message)
  return encodeCanonicalJson(message as unknown as JsonValue)
}

export function encodeManagedLaunchFrame(message: ManagedLaunchMessage): Uint8Array {
  return encodeContractFrame(encodeManagedLaunchPayload(message))
}

export function deriveManagedLaunchEnsureDigest(request: ManagedLaunchRequest): string {
  return sha256(encodeCanonicalJson(managedEnsureSpecification(request)))
}

export function deriveManagedLaunchSourceDigest(request: ManagedLaunchRequest): string {
  const source = request.source
  return sha256(encodeCanonicalJson({
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    agent_id: request.agent_id,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    admission_key: source.admission_key,
    source_id: source.source_id,
    launch_request: structuredClone(source.launch_request),
    initial_work: structuredClone(source.initial_work),
    launch_controls: structuredClone(source.launch_controls),
  }))
}

export function deriveManagedLaunchOutcomeDigest(outcome: ManagedLaunchOutcome): string {
  const { receipt_digest: _receiptDigest, ...specification } = outcome
  return sha256(encodeCanonicalJson(specification as unknown as JsonValue))
}

export function deriveManagedLaunchTerminalReceiptId(
  receipt: ManagedLaunchTerminalReceipt,
): string {
  const {
    receipt_id: _receiptId,
    receipt_digest: _receiptDigest,
    ...specification
  } = receipt
  return `terminal-${sha256(encodeCanonicalJson(specification as unknown as JsonValue))}`
}

export function deriveManagedLaunchTerminalReceiptDigest(
  receipt: ManagedLaunchTerminalReceipt,
): string {
  const { receipt_digest: _receiptDigest, ...specification } = receipt
  return sha256(encodeCanonicalJson(specification as unknown as JsonValue))
}

export function deriveManagedExactResumeDecisionDigest(
  proof: NonNullable<ManagedLaunchOutcome["exact_resume_proof"]>,
): string {
  return sha256(encodeCanonicalJson({
    ...managedExactResumeDecisionSpecification(proof),
    decision_id: proof.decision_id,
  }))
}

export function deriveManagedExactResumeDecisionId(
  proof: NonNullable<ManagedLaunchOutcome["exact_resume_proof"]>,
): string {
  return `resume-status-${sha256(encodeCanonicalJson(
    managedExactResumeDecisionSpecification(proof),
  ))}`
}

function managedExactResumeDecisionSpecification(
  proof: NonNullable<ManagedLaunchOutcome["exact_resume_proof"]>,
): Record<string, JsonValue> {
  return {
    admission_key: proof.admission_key,
    authority: proof.authority,
    conversation_id: proof.conversation_id,
    launch_digest: proof.launch_digest,
    launch_id: proof.launch_id,
    semantic_decision: proof.semantic_decision,
    state_root: proof.state_root,
    status: proof.status,
  }
}

export function managedLaunchSourceBytes(request: ManagedLaunchRequest): {
  initialWork: Uint8Array
  launchControls: Uint8Array
} {
  return {
    initialWork: decodeInlineBytes(
      request.source.initial_work,
      INLINE_INITIAL_WORK_MAX_BYTES,
      "initial work",
    ),
    launchControls: decodeInlineBytes(
      request.source.launch_controls,
      INLINE_LAUNCH_CONTROLS_MAX_BYTES,
      "launch controls",
    ),
  }
}

function validateManagedLaunchRequest(request: ManagedLaunchRequest): void {
  const launch = request.source.launch_request
  if (
    launch.launch_id !== request.launch_id ||
    launch.launch_digest !== request.launch_digest ||
    launch.admission_key !== request.source.admission_key
  ) {
    throw new ContractCodecError(
      "invalid_message",
      "managed launch changed the exact launch correlation",
    )
  }
  if (deriveFrozenLaunchDigest(launch) !== launch.launch_digest) {
    throw new ContractCodecError("invalid_message", "managed launch has an invalid launch digest")
  }
  if (
    launch.directory !== request.workspace.directory ||
    launch.conversation_name !== request.fx_conversation.name
  ) {
    throw new ContractCodecError(
      "invalid_message",
      "managed launch provider fields do not match the exact existing-directory request",
    )
  }
  const expectedResume = launch.resume.mode === "exact" ? launch.resume.conversation_id : null
  if (request.fx_conversation.resume_conversation_id !== expectedResume) {
    throw new ContractCodecError(
      "invalid_message",
      "managed launch changed the exact Fx Conversation resume target",
    )
  }
  const { initialWork, launchControls } = managedLaunchSourceBytes(request)
  if (
    request.source.initial_work.sha256 !== launch.initial_work_digest ||
    request.source.launch_controls.sha256 !== launch.remaining_launch_controls_digest
  ) {
    throw new ContractCodecError(
      "invalid_message",
      "managed launch source digests do not match the frozen launch request",
    )
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(initialWork)
  } catch {
    throw new ContractCodecError("invalid_message", "managed initial work is not valid UTF-8")
  }
  if (initialWork.includes(0)) {
    throw new ContractCodecError("invalid_message", "managed initial work contains a NUL byte")
  }
  parseInlineLaunchControls(launchControls)
  if (initialWork.byteLength + launchControls.byteLength > INLINE_SOURCE_COMBINED_MAX_BYTES) {
    throw new ContractCodecError("invalid_message", "managed launch source exceeds 640 KiB")
  }
  if (deriveManagedLaunchSourceDigest(request) !== request.source.source_digest) {
    throw new ContractCodecError("invalid_message", "managed launch has an invalid source digest")
  }
  if (deriveManagedLaunchEnsureDigest(request) !== request.ensure_digest) {
    throw new ContractCodecError("invalid_message", "managed launch has an invalid ensure digest")
  }
  if (
    launch.resume.mode === "exact" &&
    !isAgentWorkplaceConversationId(launch.resume.conversation_id)
  ) {
    throw new ContractCodecError("invalid_message", "managed exact resume identity is invalid")
  }
  if (encodeCanonicalJson(request as unknown as JsonValue).byteLength > CONTRACT_MAX_FRAME_BYTES) {
    throw new ContractCodecError("invalid_message", "managed launch request exceeds 1 MiB")
  }
}

function managedEnsureSpecification(request: ManagedLaunchRequest): JsonValue {
  return {
    workplace_instance_id: request.workplace_instance_id,
    fmx_session: request.fmx_session,
    ensure_id: request.ensure_id,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    agent_id: request.agent_id,
    workspace: structuredClone(request.workspace),
    fx_conversation: structuredClone(request.fx_conversation),
    source: structuredClone(request.source),
  }
}

function decodeInlineBytes(
  value: { encoding: "base64"; data: string; byte_length: number; sha256: string },
  maximum: number,
  label: string,
): Uint8Array {
  if (!CANONICAL_BASE64.test(value.data)) {
    throw new ContractCodecError("invalid_message", `${label} is not canonical base64`)
  }
  const bytes = Buffer.from(value.data, "base64")
  if (
    bytes.byteLength !== value.byte_length ||
    bytes.byteLength > maximum ||
    bytes.toString("base64") !== value.data ||
    sha256(bytes) !== value.sha256
  ) {
    throw new ContractCodecError("invalid_message", `${label} bytes do not match their authority`)
  }
  return bytes
}

function codecError(
  parsed: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } },
  fallback: string,
): ContractCodecError {
  const issue = parsed.success ? undefined : parsed.error?.issues[0]
  const at = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
  return new ContractCodecError("invalid_message", `${issue?.message ?? fallback}${at}`)
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
