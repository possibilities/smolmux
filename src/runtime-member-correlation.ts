import * as z from "zod/v4"
import type {
  EnsureLifecycleLedger,
  LifecycleLedgerRecord,
} from "./ensure-lifecycle-ledger.ts"

const SAFE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u
const AGENT_ID = /^[0-9a-f]{32}$/u
const SHA256 = /^[0-9a-f]{64}$/u

export type RuntimeMemberCorrelation = {
  ensure_id: string
  ensure_digest: string
  launch_id: string
  launch_digest: string
}

export type RuntimeMemberCorrelationEntry = {
  agent_id: string
  correlation: RuntimeMemberCorrelation
}

/** One immutable correlation view used for one complete Runtime snapshot. */
export interface RuntimeMemberCorrelationSource {
  snapshot(): Promise<readonly RuntimeMemberCorrelationEntry[]>
}

type EnsureLifecycleLedgerReader = Pick<EnsureLifecycleLedger, "listAll">

/**
 * Role-neutral adapter from the durable ensure authority to Runtime members.
 * `listAll` holds one ledger lock across ordinary and managed records; no
 * per-Agent read can mix revisions from different ledger instants.
 */
export class EnsureLifecycleRuntimeMemberCorrelationSource
  implements RuntimeMemberCorrelationSource
{
  constructor(private readonly ledger: EnsureLifecycleLedgerReader) {}

  async snapshot(): Promise<readonly RuntimeMemberCorrelationEntry[]> {
    const records = await this.ledger.listAll()
    return records.flatMap(correlationEntryFor)
  }
}

export class RuntimeMemberCorrelationSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuntimeMemberCorrelationSourceError"
  }
}

const correlationEntrySchema = z.strictObject({
  agent_id: z.string().regex(AGENT_ID),
  correlation: z.strictObject({
    ensure_id: z.string().regex(SAFE_TOKEN),
    ensure_digest: z.string().regex(SHA256),
    launch_id: z.string().regex(SAFE_TOKEN),
    launch_digest: z.string().regex(SHA256),
  }),
})

const correlationSnapshotSchema = z.array(correlationEntrySchema).max(4096)

/** Validate the whole injected view before resolving any individual Agent. */
export function indexRuntimeMemberCorrelations(
  input: unknown,
): ReadonlyMap<string, RuntimeMemberCorrelation> {
  const parsed = correlationSnapshotSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    throw new RuntimeMemberCorrelationSourceError(
      `invalid Runtime member correlation source${at}`,
    )
  }

  const byAgent = new Map<string, RuntimeMemberCorrelation>()
  const ensureIds = new Set<string>()
  const launchIds = new Set<string>()
  for (const entry of parsed.data) {
    assertUnique(byAgent, entry.agent_id, "Agent id")
    assertUnique(ensureIds, entry.correlation.ensure_id, "ensure id")
    assertUnique(launchIds, entry.correlation.launch_id, "launch id")
    byAgent.set(entry.agent_id, structuredClone(entry.correlation))
  }
  return byAgent
}

function correlationEntryFor(
  record: LifecycleLedgerRecord,
): RuntimeMemberCorrelationEntry[] {
  if (record.effects.manifest.status !== "claimed") return []
  if (record.effects.manifest.agent_id !== record.request.agent_id) {
    throw new RuntimeMemberCorrelationSourceError(
      `ensure ${record.request.ensure_id} changed its claimed Agent identity`,
    )
  }
  return [{
    agent_id: record.request.agent_id,
    correlation: {
      ensure_id: record.request.ensure_id,
      ensure_digest: record.request.ensure_digest,
      launch_id: record.request.launch_id,
      launch_digest: record.request.launch_digest,
    },
  }]
}

function assertUnique(
  values: ReadonlyMap<string, unknown> | Set<string>,
  value: string,
  label: string,
): void {
  if (values.has(value)) {
    throw new RuntimeMemberCorrelationSourceError(
      `Runtime member correlation source repeats ${label} ${value}`,
    )
  }
  if (values instanceof Set) values.add(value)
}
