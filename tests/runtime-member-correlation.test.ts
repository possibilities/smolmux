import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  ensureLifecycleMessageSchema,
  type EnsureLifecycleMessage,
} from "../src/agentworkplace-contracts.ts"
import {
  EnsureLifecycleLedger,
  type EnsureRequest,
} from "../src/ensure-lifecycle-ledger.ts"
import {
  EnsureLifecycleRuntimeMemberCorrelationSource,
  type RuntimeMemberCorrelation,
} from "../src/runtime-member-correlation.ts"

const FIXTURE = resolve(import.meta.dir, "../contracts/agentworkplace/v1/ensure-lifecycle.jsonl")
const scratchRoots: string[] = []

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

async function fixtureRequests(): Promise<[EnsureRequest, EnsureRequest]> {
  const requests = (await readFile(FIXTURE, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => ensureLifecycleMessageSchema.parse(JSON.parse(line)) as EnsureLifecycleMessage)
    .filter((message): message is EnsureRequest =>
      message.message_type === "ensure_request" && "planned_worktree" in message
    )
    .map((request) => structuredClone(request))
  const first = requests.find(({ ensure_id }) => ensure_id === "ensure-a")
  const second = requests.find(({ ensure_id }) => ensure_id === "ensure-b")
  if (!first || !second) throw new Error("frozen ensure fixtures are incomplete")
  return [first, second]
}

async function ledgerRoot(): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "fmx-member-correlation-"))
  scratchRoots.push(scratch)
  return join(scratch, "ledger")
}

async function advanceToManifest(
  ledger: EnsureLifecycleLedger,
  request: EnsureRequest,
): Promise<void> {
  await ledger.advance(request.ensure_id, {
    kind: "worktree_created",
    directory: request.planned_worktree.directory,
    head_commit: request.planned_worktree.base_commit,
  })
  await ledger.advance(request.ensure_id, {
    kind: "manifest_claimed",
    agent_id: request.agent_id,
  })
}

function expectedCorrelation(request: EnsureRequest): RuntimeMemberCorrelation {
  return {
    ensure_id: request.ensure_id,
    ensure_digest: request.ensure_digest,
    launch_id: request.launch_id,
    launch_digest: request.launch_digest,
  }
}

test("takes one ledger list and excludes claims that have not reached the Manifest", async () => {
  const [request] = await fixtureRequests()
  const ledger = await EnsureLifecycleLedger.open(await ledgerRoot())
  await ledger.claim(request)
  let listCalls = 0
  const source = new EnsureLifecycleRuntimeMemberCorrelationSource({
    listAll: async () => {
      listCalls++
      return ledger.listAll()
    },
  })

  expect(await source.snapshot()).toEqual([])
  expect(listCalls).toBe(1)
  await ledger.advance(request.ensure_id, {
    kind: "worktree_created",
    directory: request.planned_worktree.directory,
    head_commit: request.planned_worktree.base_commit,
  })
  expect(await source.snapshot()).toEqual([])
  expect(listCalls).toBe(2)
  await ledger.advance(request.ensure_id, {
    kind: "manifest_claimed",
    agent_id: request.agent_id,
  })
  expect(await source.snapshot()).toEqual([{
    agent_id: request.agent_id,
    correlation: expectedCorrelation(request),
  }])
  expect(listCalls).toBe(3)
})

test("rebuilds exact Agent correlations after restart independent of claim and transition order", async () => {
  const [first, second] = await fixtureRequests()
  const root = await ledgerRoot()
  let ledger = await EnsureLifecycleLedger.open(root)
  await ledger.claim(second)
  await ledger.claim(first)
  await advanceToManifest(ledger, first)

  ledger = await EnsureLifecycleLedger.open(root)
  await advanceToManifest(ledger, second)
  const entries = await new EnsureLifecycleRuntimeMemberCorrelationSource(ledger).snapshot()
  const byAgent = new Map(entries.map((entry) => [entry.agent_id, entry.correlation]))

  expect(byAgent).toEqual(new Map([
    [first.agent_id, expectedCorrelation(first)],
    [second.agent_id, expectedCorrelation(second)],
  ]))
})
