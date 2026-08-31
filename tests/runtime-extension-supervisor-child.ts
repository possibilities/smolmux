#!/usr/bin/env bun

import { appendFile, open, stat } from "node:fs/promises"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_CAPABILITIES,
  RUNTIME_EXTENSION_SCHEMA_ID,
  decodeAgentWorkplacePayload,
  encodeAgentWorkplaceFrame,
  type RuntimeExtensionMessage,
} from "../src/agentworkplace-contracts.ts"
import { CONTRACT_MAX_FRAME_BYTES, ContractFrameDecoder } from "../src/contract-codec.ts"

type Mode =
  | "ready"
  | "reply"
  | "refuse_action"
  | "wrong_response_id"
  | "wrong_response_operation"
  | "orphan_response"
  | "request_before_ready"
  | "oversized_frame"
  | "partial_frame_exit"
  | "wrong_direction_after_ready"
  | "duplicate_ready"
  | "duplicate_request"
  | "too_many_requests"
  | "wrong_session_request"
  | "coalescing_probe"
  | "block_response_write"
  | "sequential_requests"
  | "ignore_close"
  | "exit_once_then_ready"
  | "exit_once_then_refuse"

type Initialize = {
  request_id: string
  workplace_instance_id: string
  extension_id: string
  configuration_id: string
  placement_id: string
  fmx_session: string
  protocol_version: 1
}

type WireMessage = RuntimeExtensionMessage & Record<string, unknown>

const mode = (process.env.FMX_SUPERVISOR_CHILD_MODE ?? "ready") as Mode
const markerPath = process.env.FMX_SUPERVISOR_CHILD_MARKER
const releasePath = process.env.FMX_SUPERVISOR_CHILD_RELEASE
const logPath = process.env.FMX_SUPERVISOR_CHILD_LOG
const decoder = new ContractFrameDecoder()
let initialized = false
let keepAlive = false
let coalescingPullSent = false
let sequentialResponses = 0
let fmxSession = ""
const sequentialTarget = Number(process.env.FMX_SUPERVISOR_CHILD_SEQUENTIAL_COUNT ?? "128")

for await (const chunk of Bun.stdin.stream()) {
  for (const payload of decoder.push(chunk)) {
    const message = decodeAgentWorkplacePayload(payload) as WireMessage
    await record(message)
    if (!initialized) {
      if (message.message_type !== "initialize") throw new Error("expected initialize")
      initialized = true
      fmxSession = String(message.fmx_session)
      await initialize(message as unknown as Initialize)
      continue
    }
    if (mode === "coalescing_probe" && message.message_type === "snapshot_invalidated" && !coalescingPullSent) {
      coalescingPullSent = true
      write(snapshotGet(String(message.fmx_session), "coalescing-race", "1"))
    }
    if (
      mode === "sequential_requests" &&
      message.message_type === "response" &&
      message.request_id === "sequential-request"
    ) {
      sequentialResponses++
      if (sequentialResponses < sequentialTarget) {
        await Bun.sleep(1)
        write(presentRequest(fmxSession, "sequential-request"))
      }
    }
    if (message.message_type === "unavailable_slot_action") respondToAction(message)
  }
}
decoder.finish()

if (mode === "ignore_close") {
  keepAlive = true
  process.on("SIGTERM", () => {})
}
if (keepAlive) await new Promise(() => {})

async function initialize(message: Initialize): Promise<void> {
  if (mode === "request_before_ready") {
    write(snapshotGet(message.fmx_session, "before-ready", null))
    return
  }
  if (mode === "oversized_frame") {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, CONTRACT_MAX_FRAME_BYTES + 1, false)
    process.stdout.write(header)
    return
  }
  if (mode === "partial_frame_exit") {
    process.stdout.write(Uint8Array.of(0, 0, 0, 4, 0x7b))
    process.exit(31)
  }

  const firstGeneration = markerPath === undefined ? false : await claimMarker(markerPath)
  if (mode === "exit_once_then_refuse" && !firstGeneration) {
    write({
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "response",
      request_id: message.request_id,
      operation: "initialize",
      ok: false,
      error: { code: "restart_refused", message: "The restarted fixture refused readiness." },
    })
    return
  }

  const ready = {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "ready",
    request_id: message.request_id,
    workplace_instance_id: message.workplace_instance_id,
    extension_id: message.extension_id,
    configuration_id: message.configuration_id,
    placement_id: message.placement_id,
    fmx_session: message.fmx_session,
    protocol_version: message.protocol_version,
    capabilities: [...RUNTIME_EXTENSION_CAPABILITIES],
  } as const
  write(ready)

  if (mode === "coalescing_probe") {
    if (releasePath === undefined) throw new Error("coalescing probe requires a release path")
    write(snapshotGet(message.fmx_session, "coalescing-initial", null))
    await waitForPath(releasePath)
  }

  switch (mode) {
    case "orphan_response":
      write(accepted("orphan-response", "present"))
      break
    case "wrong_direction_after_ready":
      write({
        schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
        schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
        message_type: "snapshot_invalidated",
        fmx_session: message.fmx_session,
        revision: "1",
      })
      break
    case "duplicate_ready":
      write(ready)
      break
    case "duplicate_request":
      writeMany([
        snapshotGet(message.fmx_session, "duplicate-request", null),
        snapshotGet(message.fmx_session, "duplicate-request", null),
      ])
      break
    case "too_many_requests":
      write(snapshotGet(message.fmx_session, "bounded-request-a", null))
      write(snapshotGet(message.fmx_session, "bounded-request-b", null))
      break
    case "wrong_session_request":
      write(snapshotGet("foreign-session", "wrong-session", null))
      break
    case "block_response_write":
      writeMany(Array.from({ length: 32 }, (_, index) =>
        snapshotGet(message.fmx_session, `blocked-response-${index}`, null)
      ))
      await new Promise(() => {})
      break
    case "sequential_requests":
      write(presentRequest(message.fmx_session, "sequential-request"))
      break
    case "exit_once_then_ready":
    case "exit_once_then_refuse":
      if (firstGeneration) {
        await Bun.sleep(10)
        process.exit(23)
      }
      break
    default:
      break
  }
}

function respondToAction(message: WireMessage): void {
  if (mode === "refuse_action") {
    write({
      schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
      schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
      message_type: "response",
      request_id: String(message.request_id),
      operation: "unavailable_slot_action",
      ok: false,
      error: { code: "stale_card", message: "The Recovery card is stale." },
    })
    return
  }
  if (mode === "wrong_response_id") {
    write(accepted("wrong-response-id", "unavailable_slot_action"))
    return
  }
  if (mode === "wrong_response_operation") {
    write(accepted(String(message.request_id), "present"))
    return
  }
  if (mode === "reply" || mode === "exit_once_then_ready") {
    write(accepted(String(message.request_id), "unavailable_slot_action"))
  }
}

function snapshotGet(fmxSession: string, requestId: string, afterRevision: string | null) {
  return {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "snapshot_get",
    request_id: requestId,
    fmx_session: fmxSession,
    after_revision: afterRevision,
  } as const
}

function presentRequest(fmxSession: string, requestId: string) {
  return {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "present",
    request_id: requestId,
    fmx_session: fmxSession,
    agent_id: "11111111111111111111111111111111",
    focus: false,
  } as const
}

function accepted(
  requestId: string,
  operation: "present" | "unavailable_slot_action",
) {
  return {
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "response",
    request_id: requestId,
    operation,
    ok: true,
    status: "accepted",
  } as const
}

function write(message: object): void {
  process.stdout.write(Buffer.from(encodeAgentWorkplaceFrame(message as RuntimeExtensionMessage)))
}

function writeMany(messages: object[]): void {
  process.stdout.write(Buffer.concat(messages.map((message) =>
    Buffer.from(encodeAgentWorkplaceFrame(message as RuntimeExtensionMessage))
  )))
}

async function record(message: WireMessage): Promise<void> {
  if (logPath === undefined) return
  await appendFile(logPath, `${JSON.stringify(message)}\n`, { encoding: "utf8", mode: 0o600 })
}

async function claimMarker(path: string): Promise<boolean> {
  try {
    const marker = await open(path, "wx", 0o600)
    await marker.close()
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
}

async function waitForPath(path: string): Promise<void> {
  for (;;) {
    try {
      if ((await stat(path)).isFile()) return
    } catch {
      // The test creates the one-use release marker after its revision burst.
    }
    await Bun.sleep(5)
  }
}
