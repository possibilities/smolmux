import { afterEach, describe, expect, test } from "bun:test"
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fxLaunchAdmissionFinalMessageSchema,
  type FxLaunchAdmissionFinalMessage,
} from "../src/agentworkplace-contracts.ts"
import { encodeCanonicalJson, type JsonValue } from "../src/contract-codec.ts"
import {
  deriveFxAdmissionDecisionDigest,
  deriveFxFinalReceiptDigest,
  EnsureLifecycleLedger,
  type FxAdmissionDecision,
  type FxFinalReceipt,
  type FxFinalReceiptAcknowledgement,
} from "../src/ensure-lifecycle-ledger.ts"
import {
  deriveFrozenLaunchDigest,
  encodeInlineSourceBytes,
  InlineLaunchSourceLedger,
  type FrozenLaunchRequest,
} from "../src/inline-launch-source.ts"
import {
  LifecycleCoordinator,
  type AdmittedFxAdmissionDecision,
  type CancelledFxAdmissionDecision,
  type LifecycleCoordinatorPorts,
} from "../src/lifecycle-coordinator.ts"
import {
  decodeManagedLaunchPayload,
  deriveManagedExactResumeDecisionDigest,
  deriveManagedExactResumeDecisionId,
  deriveManagedLaunchEnsureDigest,
  deriveManagedLaunchOutcomeDigest,
  deriveManagedLaunchSourceDigest,
  encodeManagedLaunchPayload,
  parseManagedLaunchOutcome,
  parseManagedLaunchRequest,
  type ManagedLaunchAcknowledgement,
  type ManagedLaunchOutcome,
  type ManagedLaunchRequest,
  type ManagedLaunchRetry,
} from "../src/managed-launch-contract.ts"
import type { FxWorkControlResult } from "../src/fx-work-control.ts"

const CONTRACT_ROOT = join(import.meta.dir, "../contracts/agentworkplace/v1")
const temporaryDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
  temporaryDirectories.clear()
})

describe("managed-launch v1 codec", () => {
  test("accepts only canonical, correlated existing-directory requests", async () => {
    const request = await managedRequest("codec")
    expect(parseManagedLaunchRequest(request)).toEqual(request)
    expect(decodeManagedLaunchPayload(encodeManagedLaunchPayload(request))).toEqual(request)

    const noncanonical = Buffer.from(JSON.stringify(request, null, 2), "utf8")
    expect(() => decodeManagedLaunchPayload(noncanonical)).toThrow("canonical JSON")

    expect(() => parseManagedLaunchRequest({ ...request, unexpected: true })).toThrow()
    expect(() => parseManagedLaunchRequest({
      ...request,
      workspace: { ...request.workspace, directory: "/var/tmp/repository/../escape" },
    })).toThrow()
    expect(() => parseManagedLaunchRequest({ ...request, launch_id: "different-launch" })).toThrow(
      "correlation",
    )
    expect(() => parseManagedLaunchRequest({ ...request, ensure_digest: "0".repeat(64) })).toThrow(
      "ensure digest",
    )
  })

  test("requires exact-resume proof, permanent classification, and certainty together", async () => {
    const request = await managedRequest("proof")
    const proof = exactResumeProof(request)
    const outcome = managedOutcome(request, {
      classification: "permanent",
      stage: "launch_provider",
      cause: "exact_resume_refused",
      process_certainty: "not_started",
      exact_resume_proof: proof,
    })
    expect(parseManagedLaunchOutcome(outcome)).toEqual(outcome)
    expect(() => parseManagedLaunchOutcome({
      ...outcome,
      classification: "retryable",
    })).toThrow("permanent exact-resume refusal")
    expect(() => parseManagedLaunchOutcome({
      ...outcome,
      process_certainty: "may_have_started",
    })).toThrow("must prove that no process started")
    const invalidProofOutcome: ManagedLaunchOutcome = {
      ...outcome,
      exact_resume_proof: { ...proof, decision_digest: "1".repeat(64) },
    }
    invalidProofOutcome.receipt_digest = deriveManagedLaunchOutcomeDigest(invalidProofOutcome)
    expect(() => parseManagedLaunchOutcome(invalidProofOutcome)).toThrow(
      "semantic decision has an invalid digest",
    )
  })
})

describe("managed-launch durable transaction", () => {
  test("survives a post-rename crash and retains an exact acknowledged outcome", async () => {
    const root = await temporaryDirectory()
    const request = await managedRequest("crash")
    let injected = false
    const crashing = await EnsureLifecycleLedger.open(join(root, "ensure"), {
      managedFault: (point) => {
        if (!injected && point === "after_rename") {
          injected = true
          throw new Error("crash after managed rename")
        }
      },
    })
    await expect(crashing.claimManaged(request)).rejects.toThrow("crash after managed rename")

    const reopened = await EnsureLifecycleLedger.open(join(root, "ensure"))
    expect((await reopened.getManaged(request.ensure_id))?.request).toEqual(request)
    const replayedClaim = await reopened.claimManaged(request)
    const persistedClaim = await reopened.getManaged(request.ensure_id)
    expect(persistedClaim).not.toBeNull()
    expect(encodeCanonicalJson(replayedClaim as unknown as JsonValue)).toEqual(
      encodeCanonicalJson(persistedClaim as unknown as JsonValue),
    )
    await expect(reopened.claimManaged({ ...request, request_id: "conflicting-request" }))
      .rejects.toMatchObject({ code: "conflicting_claim" })

    const outcome = managedOutcome(request)
    const retained = await reopened.retainManagedOutcome(request.ensure_id, outcome)
    expect(retained.outcome.receipt).toEqual(outcome)
    const again = await EnsureLifecycleLedger.open(join(root, "ensure"))
    expect((await again.getManaged(request.ensure_id))?.outcome.receipt).toEqual(outcome)
    const acknowledgement = managedAcknowledgement(outcome)
    const acknowledged = await again.acknowledgeManagedOutcome(acknowledgement)
    expect(acknowledged.outcome.acknowledgement).toEqual(acknowledgement)
    expect(await again.acknowledgeManagedOutcome(acknowledgement)).toEqual(acknowledged)
  })

  test("replays a durable managed Fx final acknowledgement after external failure", async () => {
    const root = await temporaryDirectory()
    const ledgerRoot = join(root, "ensure")
    const ledger = await EnsureLifecycleLedger.open(ledgerRoot)
    const request = await managedRequest("final-replay")
    const conversationId = request.fx_conversation.resume_conversation_id!
    await placeManagedAtCompanionStarted(ledger, request)
    await ledger.retainManagedFxAdmissionDecision(
      request.ensure_id,
      managedAdmittedDecisionFor(request, conversationId, "1"),
    )
    await ledger.advanceManaged(request.ensure_id, {
      kind: "fx_started",
      conversation_id: conversationId,
    })

    const receiptWithoutDigest = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "final_receipt",
      receipt_id: `managed-final-receipt-${request.ensure_id}`,
      receipt_digest: "",
      launch_id: request.launch_id,
      launch_digest: request.launch_digest,
      admission_key: request.source.admission_key,
      conversation_id: conversationId,
      outcome: { kind: "exited", code: 0 },
      observed_at: "2026-09-02T12:00:00.000Z",
      retained_until_acknowledged: true,
    } as FxFinalReceipt
    const receipt = {
      ...receiptWithoutDigest,
      receipt_digest: deriveFxFinalReceiptDigest(receiptWithoutDigest),
    }
    const acknowledgement = {
      schema_id: "fx.launch-admission-final",
      schema_version: 1,
      message_type: "final_receipt_acknowledgement",
      acknowledgement_id: `managed-final-ack-${request.ensure_id}`,
      admission_key: receipt.admission_key,
      launch_id: receipt.launch_id,
      launch_digest: receipt.launch_digest,
      conversation_id: receipt.conversation_id,
      receipt_id: receipt.receipt_id,
      receipt_digest: receipt.receipt_digest,
    } as FxFinalReceiptAcknowledgement

    const retained = await ledger.retainManagedFxFinalReceipt(request.ensure_id, receipt)
    expect(await ledger.retainManagedFxFinalReceipt(request.ensure_id, receipt)).toEqual(retained)
    const authorityCalls: FxFinalReceiptAcknowledgement[] = []
    await expect(ledger.acknowledgeManagedFxFinalReceipt(
      request.ensure_id,
      acknowledgement,
      {
        acknowledge: async (_binding, value) => {
          authorityCalls.push(structuredClone(value))
          throw new Error("Fx acknowledgement unavailable")
        },
      },
    )).rejects.toThrow("Fx acknowledgement unavailable")

    const reopened = await EnsureLifecycleLedger.open(ledgerRoot)
    expect(await reopened.getManaged(request.ensure_id)).toMatchObject({
      fx_final: {
        receipt,
        acknowledgement,
        acknowledgement_applied: false,
      },
    })
    const applied = await reopened.acknowledgeManagedFxFinalReceipt(
      request.ensure_id,
      acknowledgement,
      {
        acknowledge: async (_binding, value) => {
          authorityCalls.push(structuredClone(value))
        },
      },
    )
    expect(applied.fx_final.acknowledgement_applied).toBe(true)
    expect(await reopened.acknowledgeManagedFxFinalReceipt(
      request.ensure_id,
      acknowledgement,
      { acknowledge: async () => { throw new Error("must not replay an applied acknowledgement") } },
    )).toEqual(applied)
    expect(authorityCalls).toEqual([acknowledgement, acknowledgement])

    const cancelledRoot = await temporaryDirectory()
    const cancelledLedger = await EnsureLifecycleLedger.open(join(cancelledRoot, "ensure"))
    const cancelledRequest = await managedRequest("final-cancelled")
    await placeManagedAtCompanionStarted(cancelledLedger, cancelledRequest)
    await cancelledLedger.retainManagedFxAdmissionDecision(
      cancelledRequest.ensure_id,
      managedCancelledDecisionFor(cancelledRequest),
    )
    const impossible = {
      ...receipt,
      receipt_id: `managed-final-receipt-${cancelledRequest.ensure_id}`,
      launch_id: cancelledRequest.launch_id,
      launch_digest: cancelledRequest.launch_digest,
      admission_key: cancelledRequest.source.admission_key,
      conversation_id: cancelledRequest.fx_conversation.resume_conversation_id!,
    }
    impossible.receipt_digest = deriveFxFinalReceiptDigest(impossible)
    await expect(cancelledLedger.retainManagedFxFinalReceipt(
      cancelledRequest.ensure_id,
      impossible,
    )).rejects.toMatchObject({ code: "receipt_conflict" })
  })

  test("uses no Worktree or retirement effect and replays an outcome only until acknowledgement", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("replay")
    const published: ManagedLaunchOutcome[] = []
    const forbidden: string[] = []
    const ports = managedPorts(published, forbidden, { failValidation: true })
    const first = new LifecycleCoordinator({ ledger, sources, ports })
    await first.acceptManaged(request)
    await first.settled()
    expect(forbidden.filter((value) => value.startsWith("forbidden-"))).toEqual([])
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      ensure_id: request.ensure_id,
      classification: "retryable",
      stage: "existing_directory",
      cause: "git_identity_changed",
      process_certainty: "not_started",
    })

    const replay = new LifecycleCoordinator({ ledger, sources, ports })
    await replay.recover()
    await replay.settled()
    expect(published).toHaveLength(2)
    await replay.acceptManaged(managedAcknowledgement(published[0]!))
    await replay.recover()
    await replay.settled()
    expect(published).toHaveLength(2)
    expect(forbidden.filter((value) => value.startsWith("forbidden-"))).toEqual([])
  })

  test("advances the existing-directory provider and Companion path without cleanup", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("success")
    const observed: string[] = []
    const published: ManagedLaunchOutcome[] = []
    const ports = managedPorts(published, observed)
    const coordinator = new LifecycleCoordinator({ ledger, sources, ports })
    await coordinator.acceptManaged(request)
    await coordinator.settled()
    expect(observed).toEqual([
      "existing-directory",
      "manifest",
      "prepare",
      "companion",
      "work-control:managed hello",
      "inspect",
    ])
    expect((await ledger.getManaged(request.ensure_id))?.stage).toBe("fx_started")
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      status: "succeeded",
      classification: null,
      stage: "fx_admission",
      process_certainty: "started",
      success: {
        conversation_id: request.fx_conversation.resume_conversation_id,
        admission_receipt_id: `managed-admission-${request.ensure_id}`,
      },
    })
    expect((await ledger.getManaged(request.ensure_id))?.outcome.receipt).toEqual(published[0])
  })

  test("reopens at companion_started without rebuilding or starting another Companion", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("reopen-companion")
    const observed: string[] = []
    const published: ManagedLaunchOutcome[] = []
    await ledger.claimManaged(request)
    await ledger.advanceManaged(request.ensure_id, {
      kind: "directory_validated",
      directory: request.workspace.directory,
      repository: request.workspace.repository,
      checkout_root: request.workspace.checkout_root,
      head_commit: request.workspace.head_commit,
    })
    await ledger.advanceManaged(request.ensure_id, {
      kind: "manifest_claimed",
      agent_id: request.agent_id,
    })
    await ledger.bindManagedFxFinalReceiptAuthority(request.ensure_id, {
      admission_key: request.source.admission_key,
      state_root: request.source.launch_request.state_root,
    })
    await ledger.retainManagedPreparedConversation(
      request.ensure_id,
      request.fx_conversation.resume_conversation_id!,
    )
    await ledger.advanceManaged(request.ensure_id, {
      kind: "companion_started",
      session_name: `fmx-${request.agent_id}`,
      pane_id: `p_${request.agent_id}`,
    })

    const coordinator = new LifecycleCoordinator({
      ledger,
      sources,
      ports: managedPorts(published, observed),
    })
    await coordinator.recover()
    await coordinator.settled()
    expect(observed).toEqual(["work-control:managed hello", "inspect"])
    expect((await ledger.getManaged(request.ensure_id))?.stage).toBe("fx_started")
    expect(published[0]).toMatchObject({ status: "succeeded", attempt: 1 })
  })

  test("appends an acknowledged retryable attempt and redrives the exact launch to success", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("retrysuccess")
    const published: ManagedLaunchOutcome[] = []
    const first = new LifecycleCoordinator({
      ledger,
      sources,
      ports: managedPorts(published, [], { failValidation: true }),
    })
    await first.acceptManaged(request)
    await first.settled()
    const failed = published[0]!
    await first.acceptManaged(managedAcknowledgement(failed))

    const second = new LifecycleCoordinator({ ledger, sources, ports: managedPorts(published, []) })
    const retry = managedRetry(failed)
    await second.acceptManaged(retry)
    await second.settled()
    expect(published.map((outcome) => [outcome.attempt, outcome.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ])
    const record = await ledger.getManaged(request.ensure_id)
    expect(record?.attempt).toBe(2)
    expect(record?.outcome_history).toHaveLength(1)
    expect(record?.outcome_history[0]?.receipt).toEqual(failed)
    expect(record?.outcome.receipt).toEqual(published[1])
    expect(record?.outcome_history[0]?.retry).toEqual(retry)

    await second.acceptManaged(retry)
    await expect(second.acceptManaged({
      ...retry,
      request_id: "conflicting-retry-request",
    })).rejects.toMatchObject({ code: "conflicting_claim" })

    const reopened = await EnsureLifecycleLedger.open(join(root, "ensure"))
    expect((await reopened.getManaged(request.ensure_id))?.outcome_history[0]?.receipt).toEqual(failed)
  })

  test("reconciles an uncertain Companion attempt through the same identity before succeeding", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("uncertain")
    const published: ManagedLaunchOutcome[] = []
    const first = new LifecycleCoordinator({
      ledger,
      sources,
      ports: managedPorts(published, [], { failCompanion: true }),
    })
    await first.acceptManaged(request)
    await first.settled()
    expect(published[0]).toMatchObject({
      status: "failed",
      classification: "uncertain",
      stage: "companion_start",
      process_certainty: "may_have_started",
    })
    await first.acceptManaged(managedAcknowledgement(published[0]!))
    const second = new LifecycleCoordinator({ ledger, sources, ports: managedPorts(published, []) })
    await second.acceptManaged(managedRetry(published[0]!))
    await second.settled()
    expect(published[1]).toMatchObject({ attempt: 2, status: "succeeded" })
  })

  test("never regresses process certainty after an uncertain Companion retry", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("certainty")
    const published: ManagedLaunchOutcome[] = []
    const first = new LifecycleCoordinator({
      ledger,
      sources,
      ports: managedPorts(published, [], { failCompanion: true }),
    })
    await first.acceptManaged(request)
    await first.settled()
    await first.acceptManaged(managedAcknowledgement(published[0]!))

    const second = new LifecycleCoordinator({
      ledger,
      sources,
      ports: managedPorts(published, [], { failPrepare: true }),
    })
    await second.acceptManaged(managedRetry(published[0]!))
    await second.settled()
    expect(published[1]).toMatchObject({
      attempt: 2,
      status: "failed",
      classification: "retryable",
      stage: "launch_provider",
      cause: "launch_provider_unavailable",
      process_certainty: "may_have_started",
    })
  })

  test("refuses retry before acknowledgement and after semantic permanent refusal", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const request = await managedRequest("noretry")
    const failed = managedOutcome(request)
    await ledger.claimManaged(request)
    await ledger.retainManagedOutcome(request.ensure_id, failed)
    await expect(ledger.retryManaged(managedRetry(failed))).rejects.toMatchObject({
      code: "invalid_request",
    })

    const semantic = exactResumeProof(request)
    const permanent = managedOutcome(request, {
      classification: "permanent",
      stage: "launch_provider",
      cause: "exact_resume_refused",
      process_certainty: "not_started",
      exact_resume_proof: semantic,
    })
    const otherRoot = await temporaryDirectory()
    const other = await EnsureLifecycleLedger.open(join(otherRoot, "ensure"))
    await other.claimManaged(request)
    await other.retainManagedOutcome(request.ensure_id, permanent)
    await other.acknowledgeManagedOutcome(managedAcknowledgement(permanent))
    await expect(other.retryManaged(managedRetry(permanent))).rejects.toMatchObject({
      code: "invalid_request",
    })
  })
})

describe("managed-launch bounded pending admission", () => {
  // Fx's provider inspection is fallible in the ordinary course of polling:
  // `admission.kind === "pending"` means "ask again shortly," not a failure.
  // These tests pin the corrected behavior: a bounded internal Fx-admission
  // pending observation redrives through the coordinator's existing
  // pendingAdmissionAttempts/pendingAdmissionRetryDelayMs budget exactly as
  // the ordinary (non-managed) ensure path does, never fabricating a durable
  // managed outcome merely because Fx has not yet decided.

  test("observes pending then admitted without a premature outcome, starting Companion exactly once", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("pending-converge")
    const observed: string[] = []
    const published: ManagedLaunchOutcome[] = []
    const ports = managedPorts(published, observed)
    const managed = ports.managed!

    let companionStarts = 0
    const baseStart = managed.companion.start
    managed.companion.start = async (input) => {
      companionStarts++
      return baseStart(input)
    }

    let admissionAttempts = 0
    const baseImport = managed.admission.import
    managed.admission.import = async (input) => {
      admissionAttempts++
      if (admissionAttempts === 1) {
        observed.push("inspect-pending")
        return { kind: "pending" }
      }
      return baseImport(input)
    }

    const coordinator = new LifecycleCoordinator({
      ledger,
      sources,
      ports,
      pendingAdmissionRetryDelayMs: 0,
    })

    await coordinator.acceptManaged(request)
    await waitFor(async () => (await ledger.getManaged(request.ensure_id))?.stage === "fx_started")
    await coordinator.settled()

    expect(admissionAttempts).toBe(2)
    expect(companionStarts).toBe(1)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      status: "succeeded",
      success: { conversation_id: request.fx_conversation.resume_conversation_id },
    })
    const record = await ledger.getManaged(request.ensure_id)
    expect(record?.stage).toBe("fx_started")
    expect(record?.effects.fx.status === "started" ? record.effects.fx.conversation_id : null)
      .toBe(request.fx_conversation.resume_conversation_id)
  })

  test("submits the initial Work-control request at most once across a pending redrive", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("pending-workcontrol")
    const published: ManagedLaunchOutcome[] = []
    const ports = managedPorts(published, [])
    const managed = ports.managed!

    const admitInitialCalls: string[] = []
    const baseAdmitInitial = managed.workControl.admitInitial
    managed.workControl.admitInitial = async (input) => {
      admitInitialCalls.push(input.text)
      return baseAdmitInitial(input)
    }

    let admissionAttempts = 0
    const baseImport = managed.admission.import
    managed.admission.import = async (input) => {
      admissionAttempts++
      if (admissionAttempts === 1) return { kind: "pending" }
      return baseImport(input)
    }

    const coordinator = new LifecycleCoordinator({
      ledger,
      sources,
      ports,
      pendingAdmissionRetryDelayMs: 0,
    })

    await coordinator.acceptManaged(request)
    await waitFor(async () => (await ledger.getManaged(request.ensure_id))?.stage === "fx_started")
    await coordinator.settled()

    // The coordinator holds the first non-null delivery per ensureId for as
    // long as it remains alive, reusing it verbatim on a still-pending
    // redrive instead of resubmitting the exact initial text a second time.
    // See the "pending redrive holds the first initial-work delivery"
    // describe block below for the full turn-id-based proof of this.
    expect(admitInitialCalls).toEqual(["managed hello"])
    expect(admissionAttempts).toBe(2)
  })

  test("bounds pending redrive at pendingAdmissionAttempts, reporting exactly one error and no durable outcome", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("pending-exhaust")
    await placeManagedAtCompanionStarted(ledger, request)

    const published: ManagedLaunchOutcome[] = []
    const errors: unknown[] = []
    let attempts = 0
    const ports = managedPorts(published, [])
    ports.managed!.admission.import = async () => {
      attempts++
      return { kind: "pending" }
    }

    const coordinator = new LifecycleCoordinator({
      ledger,
      sources,
      ports: { ...ports, onError: (error) => errors.push(error) },
      pendingAdmissionAttempts: 3,
      pendingAdmissionRetryDelayMs: 0,
    })

    await coordinator.recover()
    await waitFor(() => attempts === 3)
    await coordinator.settled()

    expect(attempts).toBe(3)
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain("bounded admission attempts")
    expect(published).toHaveLength(0)
    const record = await ledger.getManaged(request.ensure_id)
    expect(record?.stage).toBe("companion_started")
    expect(record?.fx_admission_decision).toBeNull()
    expect(record?.outcome.receipt).toBeNull()
    coordinator.close()
  })

  test("close cancels a deferred managed pending redrive and preserves the durable pending record", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("pending-close")
    await placeManagedAtCompanionStarted(ledger, request)

    let attempts = 0
    const ports = managedPorts([], [])
    ports.managed!.admission.import = async () => {
      attempts++
      return { kind: "pending" }
    }

    const coordinator = new LifecycleCoordinator({
      ledger,
      sources,
      ports,
      pendingAdmissionRetryDelayMs: 10_000,
    })

    await coordinator.recover()
    // settled() drains active work only; the deferred timer is deliberately
    // outside that promise, matching the ordinary ensure path's close()
    // contract.
    await coordinator.settled()
    coordinator.close()

    expect(attempts).toBe(1)
    const record = await ledger.getManaged(request.ensure_id)
    expect(record?.stage).toBe("companion_started")
    expect(record?.fx_admission_decision).toBeNull()
    expect(record?.outcome.receipt).toBeNull()
  })

  test("a new coordinator over the same ledger converges a durable pending record without another Companion start", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("pending-restart")
    await placeManagedAtCompanionStarted(ledger, request)

    const firstPorts = managedPorts([], [])
    firstPorts.managed!.admission.import = async () => ({ kind: "pending" })
    const first = new LifecycleCoordinator({
      ledger,
      sources,
      ports: firstPorts,
      pendingAdmissionRetryDelayMs: 10_000,
    })
    await first.recover()
    await first.settled()
    first.close()
    expect((await ledger.getManaged(request.ensure_id))?.stage).toBe("companion_started")
    expect((await ledger.getManaged(request.ensure_id))?.attempt).toBe(1)

    const published: ManagedLaunchOutcome[] = []
    const observed: string[] = []
    const secondPorts = managedPorts(published, observed)
    let companionStarts = 0
    const baseStart = secondPorts.managed!.companion.start
    secondPorts.managed!.companion.start = async (input) => {
      companionStarts++
      return baseStart(input)
    }
    const second = new LifecycleCoordinator({ ledger, sources, ports: secondPorts })
    await second.recover()
    await second.settled()

    expect(companionStarts).toBe(0)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ status: "succeeded", attempt: 1 })
    const record = await ledger.getManaged(request.ensure_id)
    expect(record?.stage).toBe("fx_started")
    expect(record?.attempt).toBe(1)
  })

  test("a genuine thrown Work-control/provider failure at fx_admission still produces the existing retryable fx_admission_unavailable outcome", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("genuine-failure")
    await placeManagedAtCompanionStarted(ledger, request)

    const published: ManagedLaunchOutcome[] = []
    const ports = managedPorts(published, [])
    ports.managed!.workControl.admitInitial = async () => {
      throw new Error("Fx Work-control is unavailable")
    }
    // This mirrors LifecycleRuntime's real classifyManagedFailure mapping for
    // a genuine FxWorkControlError/FxLaunchProviderError observed at the
    // fx_admission stage. Unlike a bounded "pending" observation (which now
    // never reaches classify at all), a real thrown failure is unaffected by
    // this correction and still becomes a durable retryable outcome.
    ports.managed!.classify = () => ({
      classification: "retryable",
      stage: "fx_admission",
      cause: "fx_admission_unavailable",
      processCertainty: "started",
      exactResumeProof: null,
    })

    const coordinator = new LifecycleCoordinator({ ledger, sources, ports })
    await coordinator.recover()
    await coordinator.settled()

    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      status: "failed",
      classification: "retryable",
      stage: "fx_admission",
      cause: "fx_admission_unavailable",
      process_certainty: "started",
    })
    const record = await ledger.getManaged(request.ensure_id)
    expect(record?.stage).toBe("companion_started")
    expect(record?.outcome.receipt).toEqual(published[0])
  })

  test("admission.kind final/cancelled_before_start remain the pre-existing internal_failure branch, unaffected by the pending fix", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("cancelled-branch")
    await placeManagedAtCompanionStarted(ledger, request)

    const published: ManagedLaunchOutcome[] = []
    const ports = managedPorts(published, [])
    ports.managed!.admission.import = async () => ({
      kind: "cancelled_before_start",
      decision: managedCancelledDecisionFor(request),
    })

    const coordinator = new LifecycleCoordinator({ ledger, sources, ports })
    await coordinator.recover()
    await coordinator.settled()

    // This gap (admission.kind "final"/"cancelled_before_start" falling into
    // the generic "uncertain"/"internal_failure" branch instead of a
    // dedicated classification) predates this correction and is out of
    // scope here; this test only proves the one-line pending fix left it
    // exactly as it was.
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      status: "failed",
      classification: "uncertain",
      stage: "fx_admission",
      cause: "internal_failure",
      process_certainty: "started",
    })
    const record = await ledger.getManaged(request.ensure_id)
    expect(record?.stage).toBe("companion_started")
    expect(record?.fx_admission_decision).toBeNull()
  })
})

describe("managed-launch pending redrive holds the first initial-work delivery", () => {
  // The bounded pending redrive above resubmits Work-control's initial text
  // on every internal attempt UNLESS the coordinator already holds a
  // non-null delivery from an earlier attempt on this same ensureId. Fx's
  // admission decision correlates to whichever turn it actually queued
  // first; a coordinator that calls admitInitial again on every pending
  // redrive would (a) duplicate real Work submitted to Fx and (b) produce a
  // delivered turn_id that no longer matches the turn Fx eventually admits,
  // since incrementing-turn_id providers key each admitInitial call to a
  // fresh turn. These tests pin: at most one admitInitial call per ensureId
  // while a coordinator instance is alive, using incrementing turn_ids to
  // make an accidental duplicate call immediately visible.

  test("reuses the first delivered turn across a pending redrive instead of resubmitting Work", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("pending-dedupe")
    await placeManagedAtCompanionStarted(ledger, request)

    const published: ManagedLaunchOutcome[] = []
    const ports = managedPorts(published, [])
    let admitInitialCalls = 0
    ports.managed!.workControl.admitInitial = async ({ conversationId }) => {
      admitInitialCalls++
      return {
        admission: {
          disposition: "queued",
          // A real Fx provider keys each accepted submission to its own
          // turn_id; incrementing this on every call is what makes a
          // duplicate admitInitial call observable as a turn mismatch below.
          turn_id: String(admitInitialCalls),
          snapshot: {} as FxWorkControlResult["snapshot"],
        },
        conversationId,
      }
    }
    let admissionAttempts = 0
    ports.managed!.admission.import = async ({ expectedConversationId }) => {
      admissionAttempts++
      if (admissionAttempts === 1) return { kind: "pending" }
      // Fx admits against the FIRST turn it actually queued, whichever
      // admitInitial call that was.
      return {
        kind: "admitted",
        decision: managedAdmittedDecisionFor(request, expectedConversationId, "1"),
        conversationId: expectedConversationId,
      }
    }

    const coordinator = new LifecycleCoordinator({
      ledger,
      sources,
      ports,
      pendingAdmissionRetryDelayMs: 0,
    })

    await coordinator.recover()
    await waitFor(async () => (await ledger.getManaged(request.ensure_id))?.stage === "fx_started")
    await coordinator.settled()
    coordinator.close()

    // Before this correction, the second (redriven) attempt called
    // admitInitial again, producing turn_id "2" while Fx's decision stayed
    // keyed to turn "1" — a hard mismatch that failed the launch instead of
    // reaching fx_started.
    expect(admitInitialCalls).toBe(1)
    expect(admissionAttempts).toBe(2)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ status: "succeeded" })
    expect((await ledger.getManaged(request.ensure_id))?.stage).toBe("fx_started")
  })

  test("close() drops the held delivery; a fresh coordinator instance resubmits Work once more", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("pending-close-cache")
    await placeManagedAtCompanionStarted(ledger, request)

    let admitInitialCalls = 0
    const firstPorts = managedPorts([], [])
    firstPorts.managed!.workControl.admitInitial = async ({ conversationId }) => {
      admitInitialCalls++
      return {
        admission: {
          disposition: "queued",
          turn_id: String(admitInitialCalls),
          snapshot: {} as FxWorkControlResult["snapshot"],
        },
        conversationId,
      }
    }
    firstPorts.managed!.admission.import = async () => ({ kind: "pending" })
    const first = new LifecycleCoordinator({
      ledger,
      sources,
      ports: firstPorts,
      pendingAdmissionRetryDelayMs: 10_000,
    })
    await first.recover()
    await first.settled()
    // Held only in coordinator #1's memory; nothing external observes it
    // directly, but exactly one admitInitial call happened for the one
    // pending attempt this coordinator drove before its delay was deferred.
    expect(admitInitialCalls).toBe(1)
    first.close()

    const published: ManagedLaunchOutcome[] = []
    const secondPorts = managedPorts(published, [])
    secondPorts.managed!.workControl.admitInitial = async ({ conversationId }) => {
      admitInitialCalls++
      return {
        admission: {
          disposition: "queued",
          turn_id: String(admitInitialCalls),
          snapshot: {} as FxWorkControlResult["snapshot"],
        },
        conversationId,
      }
    }
    secondPorts.managed!.admission.import = async ({ expectedConversationId }) => ({
      kind: "admitted",
      decision: managedAdmittedDecisionFor(request, expectedConversationId, "2"),
      conversationId: expectedConversationId,
    })
    const second = new LifecycleCoordinator({ ledger, sources, ports: secondPorts })
    await second.recover()
    await second.settled()

    // A fresh coordinator instance (the process-restart case) has no
    // in-memory record of coordinator #1's held delivery — by design, this
    // held cache is a same-runtime redrive optimization only, not a durable
    // dedupe seam (Fx's own admission path is idempotent by launch identity
    // across restarts; see the "resubmits the idempotent Work-control
    // request" test above).
    expect(admitInitialCalls).toBe(2)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ status: "succeeded" })
  })

  test("clears the held delivery on a terminal failure outcome, so a same-runtime retry resubmits Work fresh", async () => {
    const root = await temporaryDirectory()
    const ledger = await EnsureLifecycleLedger.open(join(root, "ensure"))
    const sources = await InlineLaunchSourceLedger.open(join(root, "source"))
    const request = await managedRequest("pending-terminal-clear")
    await placeManagedAtCompanionStarted(ledger, request)

    const published: ManagedLaunchOutcome[] = []
    const ports = managedPorts(published, [])
    let admitInitialCalls = 0
    ports.managed!.workControl.admitInitial = async ({ conversationId }) => {
      admitInitialCalls++
      return {
        admission: {
          disposition: "queued",
          turn_id: String(admitInitialCalls),
          snapshot: {} as FxWorkControlResult["snapshot"],
        },
        conversationId,
      }
    }
    // Attempt 1's very first admission observation is a real, non-pending
    // terminal outcome (cancelled_before_start): this both caches a
    // delivery AND must clear it again immediately, since the launch is now
    // durably done for this attempt.
    ports.managed!.admission.import = async () => ({
      kind: "cancelled_before_start",
      decision: managedCancelledDecisionFor(request),
    })

    const coordinator = new LifecycleCoordinator({ ledger, sources, ports })
    await coordinator.recover()
    await coordinator.settled()
    expect(admitInitialCalls).toBe(1)
    const failed = published[0]!
    expect(failed.status).toBe("failed")
    await coordinator.acceptManaged(managedAcknowledgement(failed))

    // retryManaged does not reset stage: this record's stage stayed at
    // "companion_started" through the failure, so attempt 2 resumes
    // directly at fx_admission on the SAME live coordinator — exactly the
    // scenario where a stale held delivery from attempt 1 would otherwise
    // leak into attempt 2 and never be resubmitted.
    ports.managed!.admission.import = async ({ expectedConversationId }) => ({
      kind: "admitted",
      decision: managedAdmittedDecisionFor(request, expectedConversationId, String(admitInitialCalls)),
      conversationId: expectedConversationId,
    })
    await coordinator.acceptManaged(managedRetry(failed))
    await coordinator.settled()

    expect(admitInitialCalls).toBe(2)
    expect(published.map((outcome) => [outcome.attempt, outcome.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ])
    const record = await ledger.getManaged(request.ensure_id)
    expect(record?.stage).toBe("fx_started")
    expect(record?.attempt).toBe(2)
  })
})

function managedAdmittedDecisionFor(
  request: ManagedLaunchRequest,
  conversationId: string,
  turnId: string,
): AdmittedFxAdmissionDecision {
  void conversationId
  const decision = {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "admission_decision",
    receipt_id: `managed-admission-${request.ensure_id}-turn-${turnId}`,
    receipt_digest: "",
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    admission_key: request.source.admission_key,
    decision: { kind: "admitted", turn_id: turnId, disposition: "queued" },
  } as FxAdmissionDecision
  return {
    ...decision,
    receipt_digest: deriveFxAdmissionDecisionDigest(decision),
  } as AdmittedFxAdmissionDecision
}

async function placeManagedAtCompanionStarted(
  ledger: EnsureLifecycleLedger,
  request: ManagedLaunchRequest,
): Promise<void> {
  await ledger.claimManaged(request)
  await ledger.advanceManaged(request.ensure_id, {
    kind: "directory_validated",
    directory: request.workspace.directory,
    repository: request.workspace.repository,
    checkout_root: request.workspace.checkout_root,
    head_commit: request.workspace.head_commit,
  })
  await ledger.advanceManaged(request.ensure_id, {
    kind: "manifest_claimed",
    agent_id: request.agent_id,
  })
  await ledger.bindManagedFxFinalReceiptAuthority(request.ensure_id, {
    admission_key: request.source.admission_key,
    state_root: request.source.launch_request.state_root,
  })
  await ledger.retainManagedPreparedConversation(
    request.ensure_id,
    request.fx_conversation.resume_conversation_id!,
  )
  await ledger.advanceManaged(request.ensure_id, {
    kind: "companion_started",
    session_name: `fmx-${request.agent_id}`,
    pane_id: `p_${request.agent_id}`,
  })
}

function managedCancelledDecisionFor(request: ManagedLaunchRequest): CancelledFxAdmissionDecision {
  const decision = {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "admission_decision",
    receipt_id: `managed-cancelled-${request.ensure_id}`,
    receipt_digest: "",
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    admission_key: request.source.admission_key,
    decision: { kind: "cancelled_before_start", cancellation_request_id: "cancel-request" },
  } as CancelledFxAdmissionDecision
  return { ...decision, receipt_digest: deriveFxAdmissionDecisionDigest(decision) }
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("timed out waiting for deterministic managed lifecycle condition")
}

function managedPorts(
  published: ManagedLaunchOutcome[],
  observed: string[],
  options: { failValidation?: boolean; failPrepare?: boolean; failCompanion?: boolean } = {},
): LifecycleCoordinatorPorts {
  return {
    worktree: { create: async () => {
      observed.push("forbidden-worktree")
      throw new Error("managed launch must not create a Worktree")
    } },
    manifest: {
      claim: async () => { throw new Error("frozen manifest path is forbidden") },
      workControl: async () => { throw new Error("frozen Work-control path is forbidden") },
    },
    launch: { prepare: async () => { throw new Error("frozen launch path is forbidden") } },
    companion: { start: async () => { throw new Error("frozen Companion path is forbidden") } },
    workControl: { admitInitial: async () => { throw new Error("frozen admission path is forbidden") } },
    admission: { import: async () => ({ kind: "pending" }) },
    cancellation: { beginStart: async () => ({
      kind: "start",
      lease: { release() {} },
    }) },
    retirement: {
      afterFinalReceipt: async () => { observed.push("forbidden-retirement") },
      afterAdmissionCancellation: async () => { observed.push("forbidden-retirement") },
      accept: async () => { observed.push("forbidden-retirement") },
    },
    managed: {
      existingDirectory: { validate: async (request) => {
        observed.push("existing-directory")
        if (options.failValidation) throw new Error("git changed")
        return {
          directory: request.workspace.directory,
          repository: request.workspace.repository,
          checkoutRoot: request.workspace.checkout_root,
          headCommit: request.workspace.head_commit,
        }
      } },
      manifest: {
        claim: async () => { observed.push("manifest") },
        workControl: async () => ({
          socketPath: "/tmp/fmx-managed-test.sock",
          instanceId: "managed-instance",
          token: "a".repeat(64),
        }),
      },
      launch: { prepare: async ({ record }) => {
        observed.push("prepare")
        if (options.failPrepare) throw new Error("launch provider is unavailable")
        return {
          invocation: {},
          conversationId: record.request.fx_conversation.resume_conversation_id!,
          finalReceiptAuthority: {
            admission_key: record.request.source.admission_key,
            state_root: record.request.source.launch_request.state_root,
          },
        }
      } },
      companion: { start: async ({ record }) => {
        observed.push("companion")
        if (options.failCompanion) throw new Error("Companion result is uncertain")
        return {
          sessionName: `fmx-${record.request.agent_id}`,
          paneId: `p_${record.request.agent_id}`,
        }
      } },
      workControl: { admitInitial: async ({ text }) => {
        observed.push(`work-control:${text}`)
        return {
          admission: {
            disposition: "queued",
            turn_id: "1",
            snapshot: {} as FxWorkControlResult["snapshot"],
          },
          conversationId: "1788123456789-1788123456789000000-a1b2c3d4",
        }
      } },
      admission: { import: async ({ record, expectedConversationId }) => {
        observed.push("inspect")
        return {
          kind: "admitted",
          decision: admissionDecision(record.request, expectedConversationId),
          conversationId: expectedConversationId,
        }
      } },
      classify: (_error, record) => ({
        classification: options.failCompanion ? "uncertain" : "retryable",
        stage: options.failCompanion
          ? "companion_start"
          : record.stage === "claimed" ? "existing_directory" : "launch_provider",
        cause: options.failCompanion
          ? "companion_start_uncertain"
          : record.stage === "claimed"
          ? "git_identity_changed"
          : options.failPrepare ? "launch_provider_unavailable" : "internal_failure",
        processCertainty: options.failCompanion ? "may_have_started" : "not_started",
        exactResumeProof: null,
      }),
      outcomes: { publish: async (outcome) => { published.push(outcome) } },
    },
  }
}

function admissionDecision(
  request: ManagedLaunchRequest,
  conversationId: string,
): AdmittedFxAdmissionDecision {
  void conversationId
  const decision = {
    schema_id: "fx.launch-admission-final",
    schema_version: 1,
    message_type: "admission_decision",
    receipt_id: `managed-admission-${request.ensure_id}`,
    receipt_digest: "",
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
    admission_key: request.source.admission_key,
    decision: { kind: "admitted", turn_id: "1", disposition: "queued" },
  } as FxAdmissionDecision
  return {
    ...decision,
    receipt_digest: deriveFxAdmissionDecisionDigest(decision),
  } as AdmittedFxAdmissionDecision
}

async function managedRequest(suffix: string): Promise<ManagedLaunchRequest> {
  const values = (await readFile(join(CONTRACT_ROOT, "fx-launch-admission-final.jsonl"), "utf8"))
    .trimEnd().split("\n")
    .map((line) => fxLaunchAdmissionFinalMessageSchema.parse(JSON.parse(line)) as FxLaunchAdmissionFinalMessage)
  const base = values.find((message): message is FrozenLaunchRequest =>
    message.message_type === "launch_request" && message.launch_id === "launch-a")!
  const serial = suffix.replace(/[^a-z0-9]/gu, "").slice(0, 12) || "x"
  const directory = `/var/tmp/fmx-managed-${serial}`
  const conversationId = "1788123456789-1788123456789000000-a1b2c3d4"
  const initialWork = encodeInlineSourceBytes(Buffer.from("managed hello", "utf8"))
  const launchControls = encodeInlineSourceBytes(
    encodeCanonicalJson({ remaining_global_args: [] }),
  )
  const launch = structuredClone(base)
  launch.request_id = `launch-request-${serial}`
  launch.launch_id = `launch-${serial}`
  launch.admission_key = `admission-${serial}`
  launch.directory = directory
  launch.conversation_name = `managed-${serial}`
  launch.resume = { mode: "exact", conversation_id: conversationId }
  launch.initial_work_digest = initialWork.sha256
  launch.remaining_launch_controls_digest = launchControls.sha256
  launch.launch_digest = deriveFrozenLaunchDigest(launch)
  const request = {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "launch_request",
    request_id: `managed-request-${serial}`,
    workplace_instance_id: "workplace-managed-test",
    fmx_session: "default",
    ensure_id: `managed-ensure-${serial}`,
    ensure_digest: "0".repeat(64),
    launch_id: launch.launch_id,
    launch_digest: launch.launch_digest,
    agent_id: serial.padEnd(32, "a").slice(0, 32).replace(/[^0-9a-f]/gu, "a"),
    workspace: {
      kind: "existing_directory",
      directory,
      repository: "/var/tmp/fmx-managed-repository",
      checkout_root: directory,
      head_commit: "b".repeat(40),
    },
    fx_conversation: {
      name: launch.conversation_name,
      resume_conversation_id: conversationId,
    },
    source: {
      source_id: `managed-source-${serial}`,
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

function managedOutcome(
  request: ManagedLaunchRequest,
  values: Pick<
    Extract<ManagedLaunchOutcome, { status: "failed" }>,
    "classification" | "stage" | "cause" | "process_certainty" | "exact_resume_proof"
  > = {
    classification: "retryable",
    stage: "existing_directory",
    cause: "git_identity_changed",
    process_certainty: "not_started",
    exact_resume_proof: null,
  },
): Extract<ManagedLaunchOutcome, { status: "failed" }> {
  const outcome: Extract<ManagedLaunchOutcome, { status: "failed" }> = {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "launch_outcome",
    request_id: request.request_id,
    receipt_id: `managed-outcome-${request.ensure_id}`,
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
    ...values,
    success: null,
    retained_until_acknowledged: true,
  }
  outcome.receipt_digest = deriveManagedLaunchOutcomeDigest(outcome)
  return outcome
}

function exactResumeProof(request: ManagedLaunchRequest) {
  const proof = {
    kind: "exact_resume_refused" as const,
    authority: "fx.private-launch-provider/resume-status-v2" as const,
    semantic_decision: "exact_resume_unavailable" as const,
    status: "unavailable" as const,
    decision_id: "",
    decision_digest: "0".repeat(64),
    admission_key: request.source.admission_key,
    conversation_id: request.fx_conversation.resume_conversation_id!,
    launch_digest: request.launch_digest,
    launch_id: request.launch_id,
    state_root: request.source.launch_request.state_root,
  }
  proof.decision_id = deriveManagedExactResumeDecisionId(proof)
  proof.decision_digest = deriveManagedExactResumeDecisionDigest(proof)
  return proof
}

function managedAcknowledgement(outcome: ManagedLaunchOutcome): ManagedLaunchAcknowledgement {
  return {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "outcome_acknowledgement",
    acknowledgement_id: `managed-ack-${outcome.ensure_id}`,
    workplace_instance_id: outcome.workplace_instance_id,
    fmx_session: outcome.fmx_session,
    receipt_id: outcome.receipt_id,
    receipt_digest: outcome.receipt_digest,
    attempt: outcome.attempt,
    ensure_id: outcome.ensure_id,
    ensure_digest: outcome.ensure_digest,
    launch_id: outcome.launch_id,
    launch_digest: outcome.launch_digest,
    agent_id: outcome.agent_id,
  }
}

function managedRetry(outcome: ManagedLaunchOutcome): ManagedLaunchRetry {
  return {
    schema_id: "fmx.managed-launch",
    schema_version: 1,
    message_type: "retry_request",
    request_id: `managed-retry-${outcome.ensure_id}-${outcome.attempt + 1}`,
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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "fmx-managed-launch-test-"))
  temporaryDirectories.add(directory)
  return directory
}
