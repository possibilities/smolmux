import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, normalize } from "node:path"
import type { AgentAttention, AgentState } from "./agent-registry.ts"
import type { FxWorkControlBinding } from "./fx-work-control.ts"
import { resolveFmxHome } from "./home.ts"

export const MANIFEST_VERSION = 1

/**
 * The Manifest: fmx's own record of the Agents its Companion holds, so a
 * restart can find them. It is a claim, not the truth — the Companion's
 * sessions are the truth, and `agent-reconcile.ts` joins the two.
 *
 * No prompt text or general environment is kept. Each new Agent does retain
 * the bearer authority fmx needs to reach that exact Fx work endpoint, so the
 * file is always written mode 0600.
 */

/** The three names one Agent is known by; all three carry the same token. */
export type AgentIdentity = {
  /** 128 random bits as 32 hex characters; the one id that never changes. */
  agentId: string
  /** Stable `p_<agentId>` alias retained for control targets and Companion labels. */
  paneId: string
  /** The Companion session name, `fmx-<agentId>`. */
  zmxName: string
}

export type ManifestPhase = "creating" | "running"

/** The last lifecycle snapshot fx reported over ADE. */
export type AgentStatusCheckpoint = {
  state: AgentState
  attention: AgentAttention | null
  /** Whether the human had this exact state in front of them. */
  seen: boolean
}

export type ManifestEntry = AgentIdentity & {
  /** The number fmx's UI knows the Agent by; persisted, never reused. */
  displayId: number
  cwd: string
  fxPath: string
  /** `null` when unknown: an adopted Agent's argv comes from a display string the Companion truncates. */
  fxArgs: string[] | null
  /** Exact Fx profile root for a lifecycle-managed launch; legacy and ordinary Agents use HOME. */
  fxStateRoot: string | null
  createdAt: number
  fxSessionId: string | null
  /** Null until fx has reported a state, including for older Manifests. */
  agentStatus: AgentStatusCheckpoint | null
  /** Null for an Agent started before semantic work control existed. */
  workControl: FxWorkControlBinding | null
  /**
   * `creating` from the moment the entry is written until the Companion
   * acknowledges the start. An entry still `creating` after a restart is a
   * crash inside that window, and only the Companion can say what became of
   * it.
   */
  phase: ManifestPhase
}

export type Manifest = {
  version: typeof MANIFEST_VERSION
  homeId: string
  nextDisplayId: number
  agents: ManifestEntry[]
}

export function manifestPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
  name: string | null = null,
): string {
  return resolveFmxHome(name, env, homeDirectory).manifestPath
}

export function mintIdentity(token: string = randomBytes(16).toString("hex")): AgentIdentity {
  return identityFor(token)
}

export function identityFor(agentId: string): AgentIdentity {
  return { agentId, paneId: `p_${agentId}`, zmxName: `fmx-${agentId}` }
}

const AGENT_ID = /^[0-9a-f]{32}$/

export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID.test(value)
}

export function emptyManifest(homeId: string): Manifest {
  return { version: MANIFEST_VERSION, homeId, nextDisplayId: 1, agents: [] }
}

/**
 * Read a manifest, keeping only what validates. A missing or unreadable file
 * is an empty manifest; a file for another Home is too — its entries name
 * sessions this Home does not own, and the reconciliation would ignore them
 * anyway. Individual bad entries are dropped, not the whole file.
 */
export function parseManifest(content: string, homeId: string): Manifest {
  let document: unknown
  try {
    document = JSON.parse(content)
  } catch {
    return emptyManifest(homeId)
  }
  if (!isRecord(document)) return emptyManifest(homeId)
  if (document.version !== MANIFEST_VERSION || document.homeId !== homeId) return emptyManifest(homeId)

  const agents: ManifestEntry[] = []
  const seenIds = new Set<string>()
  const seenDisplayIds = new Set<number>()
  let highestDisplayId = 0
  if (Array.isArray(document.agents)) {
    for (const raw of document.agents) {
      const entry = readEntry(raw)
      if (!entry) continue
      if (seenIds.has(entry.agentId) || seenDisplayIds.has(entry.displayId)) continue
      seenIds.add(entry.agentId)
      seenDisplayIds.add(entry.displayId)
      highestDisplayId = Math.max(highestDisplayId, entry.displayId)
      agents.push(entry)
    }
  }
  const declared = document.nextDisplayId
  const nextDisplayId = Math.max(
    highestDisplayId + 1,
    typeof declared === "number" && Number.isInteger(declared) && declared > 0 ? declared : 1,
  )
  return { version: MANIFEST_VERSION, homeId, nextDisplayId, agents }
}

function readEntry(raw: unknown): ManifestEntry | null {
  if (!isRecord(raw)) return null
  const { agentId, displayId, cwd, fxPath, fxArgs, fxStateRoot, createdAt, fxSessionId, phase } = raw
  if (!isAgentId(agentId)) return null
  const identity = identityFor(agentId)
  if (raw.paneId !== identity.paneId || raw.zmxName !== identity.zmxName) return null
  if (typeof displayId !== "number" || !Number.isInteger(displayId) || displayId <= 0) return null
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null
  if (typeof fxPath !== "string" || fxPath.length === 0) return null
  if (fxArgs !== null && (!Array.isArray(fxArgs) || !fxArgs.every((arg) => typeof arg === "string"))) return null
  if (fxStateRoot !== undefined && fxStateRoot !== null && !isValidFxStateRoot(fxStateRoot)) return null
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null
  if (fxSessionId !== null && fxSessionId !== undefined && typeof fxSessionId !== "string") return null
  if (phase !== "creating" && phase !== "running") return null
  return {
    ...identity,
    displayId,
    cwd,
    fxPath,
    fxArgs: fxArgs === null ? null : [...(fxArgs as string[])],
    fxStateRoot: typeof fxStateRoot === "string" ? fxStateRoot : null,
    createdAt,
    fxSessionId: typeof fxSessionId === "string" && fxSessionId.length > 0 ? fxSessionId : null,
    agentStatus: readAgentStatus(raw.agentStatus),
    workControl: readWorkControl(raw.workControl, agentId),
    phase,
  }
}

function readWorkControl(raw: unknown, agentId: string): FxWorkControlBinding | null {
  if (!isRecord(raw)) return null
  if (typeof raw.socketPath !== "string" || !raw.socketPath.startsWith("/") || raw.socketPath.includes("\0")) {
    return null
  }
  if (raw.instanceId !== agentId || typeof raw.token !== "string" || !/^[0-9a-f]{64}$/u.test(raw.token)) {
    return null
  }
  return { socketPath: raw.socketPath, instanceId: raw.instanceId, token: raw.token }
}

function readAgentStatus(raw: unknown): AgentStatusCheckpoint | null {
  if (!isRecord(raw)) return null
  const state = raw.state
  if (state !== "idle" && state !== "working" && state !== "blocked" && state !== "unknown") return null
  const attention = raw.attention
  if (
    attention !== null &&
    attention !== "permission" &&
    attention !== "question" &&
    attention !== "route_recovery" &&
    attention !== "recovery"
  ) return null
  if (typeof raw.seen !== "boolean") return null
  // The sole persistence migration: manifests written by the retired Herdr
  // projection used `recovery`; live and newly saved state use Fx's ADE word.
  return { state, attention: attention === "recovery" ? "route_recovery" : attention, seen: raw.seen }
}

export async function loadManifest(path: string, homeId: string): Promise<Manifest> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch {
    return emptyManifest(homeId)
  }
  return parseManifest(content, homeId)
}

/** Temp file beside the target, then rename: a reader sees the old file or the new one, never a torn one. */
export async function saveManifest(manifest: Manifest, path: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporaryPath, path)
}

export type CreateParams = {
  cwd: string
  fxPath: string
  /** `null` when unknown: an adopted Agent's argv comes from a display string the Companion truncates. */
  fxArgs: string[] | null
  /** Exact Fx profile root for a lifecycle-managed launch; omit or null for HOME. */
  fxStateRoot?: string | null
  createdAt: number
  identity?: AgentIdentity
  workControl?: FxWorkControlBinding | null
}

/**
 * The Manifest as a live object: every mutation lands in memory at once and
 * is written through before its promise resolves, with the writes
 * serialized so two in flight cannot land out of order. Callers hold the
 * entries they were handed as snapshots.
 */
export class AgentManifest {
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    /** `null` for a Manifest that is never written: a test's, or a demo's. */
    readonly path: string | null,
    private manifest: Manifest,
  ) {}

  static async open(path: string, homeId: string): Promise<AgentManifest> {
    return new AgentManifest(path, await loadManifest(path, homeId))
  }

  /** A Manifest held in memory alone. Nothing survives the process, which is the point. */
  static ephemeral(homeId: string): AgentManifest {
    return new AgentManifest(null, emptyManifest(homeId))
  }

  get homeId(): string {
    return this.manifest.homeId
  }

  get entries(): readonly ManifestEntry[] {
    return this.manifest.agents.map(copy)
  }

  get(agentId: string): ManifestEntry | null {
    const entry = this.manifest.agents.find((candidate) => candidate.agentId === agentId)
    return entry ? copy(entry) : null
  }

  /** Step 1 of creation: the claim is on disk before the Companion is asked. */
  beginCreate(params: CreateParams): Promise<ManifestEntry> {
    return this.mutate((manifest) => this.claimIn(manifest, params))
  }

  /**
   * Step 1 as two halves: the entry now, for an Agent that should be on
   * screen the moment it is asked for, and the write to wait for before
   * the Companion is asked — the claim must be on disk first.
   */
  claim(params: CreateParams): { result: ManifestEntry; saved: Promise<void> } {
    return this.apply((manifest) => this.claimIn(manifest, params))
  }

  /**
   * Claim one predetermined Agent identity, or durably replay the exact same
   * claim. Managed lifecycle recovery can re-enter after the in-memory change
   * but before its write completed; replay therefore queues a fresh snapshot
   * even when the entry already exists.
   */
  ensureClaim(params: CreateParams & { identity: AgentIdentity }): {
    result: ManifestEntry
    saved: Promise<void>
  } {
    return this.apply((manifest) => {
      const existing = manifest.agents.find((entry) => entry.agentId === params.identity.agentId)
      if (!existing) return this.claimIn(manifest, params)
      if (!sameClaim(existing, params)) {
        throw new Error(`conflicting manifest claim for agent: ${params.identity.agentId}`)
      }
      return copy(existing)
    })
  }

  private claimIn(manifest: Manifest, params: CreateParams): ManifestEntry {
    if (params.fxStateRoot !== undefined && params.fxStateRoot !== null && !isValidFxStateRoot(params.fxStateRoot)) {
      throw new Error("invalid Fx state root for manifest claim")
    }
    const identity = params.identity ?? mintIdentity()
    if (manifest.agents.some((entry) => entry.agentId === identity.agentId)) {
      throw new Error(`agent already in manifest: ${identity.agentId}`)
    }
    const entry: ManifestEntry = {
      ...identity,
      displayId: manifest.nextDisplayId++,
      cwd: params.cwd,
      fxPath: params.fxPath,
      fxArgs: params.fxArgs && [...params.fxArgs],
      fxStateRoot: params.fxStateRoot ?? null,
      createdAt: params.createdAt,
      fxSessionId: null,
      agentStatus: null,
      workControl: params.workControl ? { ...params.workControl } : null,
      phase: "creating",
    }
    manifest.agents.push(entry)
    return copy(entry)
  }

  /** Step 3: the Companion acknowledged the start. */
  markRunning(agentId: string): Promise<ManifestEntry> {
    return this.mutate((manifest) => {
      const entry = find(manifest, agentId)
      entry.phase = "running"
      return copy(entry)
    })
  }

  /** A session seen in the Companion that the Manifest did not know. */
  adopt(params: CreateParams & { identity: AgentIdentity; fxSessionId?: string | null }): Promise<ManifestEntry> {
    return this.mutate((manifest) => {
      const existing = manifest.agents.find((entry) => entry.agentId === params.identity.agentId)
      if (existing) return copy(existing)
      const entry: ManifestEntry = {
        ...params.identity,
        displayId: manifest.nextDisplayId++,
        cwd: params.cwd,
        fxPath: params.fxPath,
        fxArgs: params.fxArgs && [...params.fxArgs],
        fxStateRoot: params.fxStateRoot ?? null,
        createdAt: params.createdAt,
        fxSessionId: params.fxSessionId ?? null,
        agentStatus: null,
        workControl: params.workControl ? { ...params.workControl } : null,
        phase: "running",
      }
      manifest.agents.push(entry)
      return copy(entry)
    })
  }

  setFxSessionId(agentId: string, fxSessionId: string | null): Promise<void> {
    // Checked before the write is queued: every ADE record is a chance
    // to record the id, and all but the first would otherwise be a rewrite.
    const current = this.manifest.agents.find((candidate) => candidate.agentId === agentId)
    if (!current || current.fxSessionId === fxSessionId) return Promise.resolve()
    return this.mutate((manifest) => {
      const entry = manifest.agents.find((candidate) => candidate.agentId === agentId)
      if (!entry || entry.fxSessionId === fxSessionId) return
      entry.fxSessionId = fxSessionId
    })
  }

  /** Checkpoint the last ADE truth so a detach does not turn it unknown. */
  setAgentStatus(agentId: string, status: AgentStatusCheckpoint): Promise<void> {
    const current = this.manifest.agents.find((candidate) => candidate.agentId === agentId)
    if (!current || sameAgentStatus(current.agentStatus, status)) return Promise.resolve()
    return this.mutate((manifest) => {
      const entry = manifest.agents.find((candidate) => candidate.agentId === agentId)
      if (!entry || sameAgentStatus(entry.agentStatus, status)) return
      entry.agentStatus = { ...status }
    })
  }

  /** Steps 4 and 5: a definite failure, an exit, or an absence. Removing what is not there is fine. */
  remove(agentId: string): Promise<void> {
    return this.mutate((manifest) => {
      manifest.agents = manifest.agents.filter((entry) => entry.agentId !== agentId)
    })
  }

  /** Resolves once every write queued so far has landed or failed. */
  settled(): Promise<void> {
    return this.queue.then(() => {})
  }

  private mutate<T>(change: (manifest: Manifest) => T): Promise<T> {
    try {
      const { result, saved } = this.apply(change)
      return saved.then(() => result)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** The change now, in memory; the write of that snapshot behind every write before it. */
  private apply<T>(change: (manifest: Manifest) => T): { result: T; saved: Promise<void> } {
    const next: Manifest = {
      ...this.manifest,
      agents: this.manifest.agents.map(copy),
    }
    // A change that throws changes nothing: `next` is dropped unsaved.
    const result = change(next)
    this.manifest = next
    const saved = this.queue.then(async () => {
      if (this.path !== null) await saveManifest(next, this.path)
    })
    // A failed write must not wedge every later one behind a rejected promise.
    this.queue = saved.catch(() => {})
    return { result, saved }
  }
}

function copy(entry: ManifestEntry): ManifestEntry {
  return {
    ...entry,
    fxArgs: entry.fxArgs && [...entry.fxArgs],
    agentStatus: entry.agentStatus && { ...entry.agentStatus },
    workControl: entry.workControl && { ...entry.workControl },
  }
}

function sameAgentStatus(
  left: AgentStatusCheckpoint | null,
  right: AgentStatusCheckpoint,
): boolean {
  return left?.state === right.state && left.attention === right.attention && left.seen === right.seen
}

function sameClaim(
  entry: ManifestEntry,
  params: CreateParams & { identity: AgentIdentity },
): boolean {
  return entry.agentId === params.identity.agentId &&
    entry.paneId === params.identity.paneId &&
    entry.zmxName === params.identity.zmxName &&
    entry.cwd === params.cwd &&
    entry.fxPath === params.fxPath &&
    sameNullableStrings(entry.fxArgs, params.fxArgs) &&
    entry.fxStateRoot === (params.fxStateRoot ?? null) &&
    sameWorkControl(entry.workControl, params.workControl ?? null)
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

function isValidFxStateRoot(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 4096 &&
    isAbsolute(value) &&
    value !== "/" &&
    normalize(value) === value &&
    !CONTROL_CHARACTERS.test(value)
}

function sameNullableStrings(left: readonly string[] | null, right: readonly string[] | null): boolean {
  return left === null || right === null
    ? left === right
    : left.length === right.length && left.every((value, index) => value === right[index])
}

function sameWorkControl(
  left: FxWorkControlBinding | null,
  right: FxWorkControlBinding | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.socketPath === right.socketPath &&
      left.instanceId === right.instanceId &&
      left.token === right.token
}

function find(manifest: Manifest, agentId: string): ManifestEntry {
  const entry = manifest.agents.find((candidate) => candidate.agentId === agentId)
  if (!entry) throw new Error(`agent not in manifest: ${agentId}`)
  return entry
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
