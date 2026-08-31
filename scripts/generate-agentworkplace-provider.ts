#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import {
  decodeStrictJson,
  type JsonValue,
} from "../src/contract-codec.ts"
import {
  type ContractVerification,
  type VerifiedContractFixture,
  verifyAgentWorkplaceContracts,
} from "./check-agentworkplace-contracts.ts"

const REPOSITORY_ROOT = resolve(import.meta.dir, "..")
const MAX_MANIFEST_BYTES = 1024 * 1024
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const GATE_ARGV = ["./scripts/local-gate.sh"] as const
const INTERNAL_STATE_ARGUMENT = "--internal-state"
const INTERNAL_TOKEN_ENV = "FMX_PROVIDER_INTERNAL_TOKEN"
const ROOT_OUTPUT_ENTRIES = [
  "artifacts",
  "generation-receipt.json",
  "local-gate.log",
  "phase0-provider.json",
] as const

const usage = `Usage: scripts/generate-agentworkplace-provider.ts \\
  --output <existing-empty-directory> \\
  --agentworkplace-manifest <phase0-owned-manifest.json>

Runs fmx's canonical local gate, then writes a disposable canonical
AgentWorkplace provider-manifest v1 bundle from the exact committed fmx
contract bytes. The output directory must be outside this repository.
`

interface SkipDefinition {
  readonly description: string
  readonly reason: string
  readonly scenario_id: string
}

const PTY_SKIP_REASON =
  "the general suite skips this PTY scenario; the local gate reruns it with FMX_RUN_PTY_TESTS=1"
const COMPANION_SKIP_REASON =
  "this real-Companion scenario requires an explicit FMX_ZMX_PATH override and is environment-gated in the canonical general suite"

export const FMX_EXPECTED_SKIPS: readonly SkipDefinition[] = [
  {
    description:
      "multiple Clients share one Runtime and hand off sizing ownership",
    reason: PTY_SKIP_REASON,
    scenario_id: "tests.multiplexer-e2e.multiple-clients",
  },
  {
    description:
      "named fmx Runtimes are independent and same-name Clients join",
    reason: PTY_SKIP_REASON,
    scenario_id: "tests.multiplexer-e2e.named-sessions",
  },
  {
    description:
      "start creates a labelled session, attaches with a restore, and writes through",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.start",
  },
  {
    description:
      "a hinted socket revalidates its live daemon's ownership before attach",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.hinted-ownership",
  },
  {
    description:
      "attach replays the screen onto a reset, and the child survives every detach",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.restore-survives-detach",
  },
  {
    description:
      "an exit is exact, final output comes first, and the record is consumed",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.exact-exit",
  },
  {
    description: "attaching to an ended Agent says so, with its status",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.ended-agent",
  },
  {
    description: "a daemon that vanishes is a lost transport, never an exit",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.vanished-daemon",
  },
  {
    description:
      "the child's environment is the one given, with nothing of the Companion's",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-transport.child-environment",
  },
  {
    description:
      "live: create, list with labels, inspect, kill, settle, forget",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.zmx-command.lifecycle",
  },
  {
    description:
      "live: a command that cannot start reports ExecFailed and leaves an exit record, not a socket",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.zmx-command.exec-failure",
  },
  {
    description:
      "a Bun client attaches, drives, detaches from, and reattaches to a zmx-owned child",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.attach-drive-reattach",
  },
  {
    description:
      "a child killed by a signal reports that signal, not an exit code",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.signal-exit",
  },
  {
    description:
      "a negotiated client sees no live output before its attach",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.attach-boundary",
  },
  {
    description:
      "the last connected or interacting terminal owns size, with failover on disconnect",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.sizing-owner",
  },
  {
    description:
      "exit-on-last-client arms on Init and ignores non-terminal probes",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.exit-on-last-client",
  },
  {
    description:
      "a client the daemon cannot serve is told the daemon's range and closed",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.protocol-refusal",
  },
  {
    description:
      "create answers on readiness, with labels the session is born with; exit records agree with Exit",
    reason: COMPANION_SKIP_REASON,
    scenario_id: "tests.companion-direct.create-readiness-exit",
  },
]

interface ParsedArguments {
  readonly agentworkplaceManifest: string
  readonly output: string
}

interface GateResult {
  readonly actualSkipDescriptions: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly exitStatus: number
  readonly logBytes: Uint8Array
  readonly stderr: Uint8Array
  readonly stdout: Uint8Array
}

interface FileIdentity {
  readonly device: string
  readonly inode: string
}

interface WorktreeLocation {
  readonly physicalPath: string
  readonly reportedPath: string
}

interface RepositorySnapshot {
  readonly commonDirectory: string
  readonly commonDirectoryIdentity: FileIdentity
  readonly gateScriptDigest: string
  readonly generatorScriptDigest: string
  readonly headRef: string | null
  readonly headSha: string
  readonly headTree: string
  readonly indexDigest: string
  readonly objectFormat: "sha1" | "sha256"
  readonly root: string
  readonly rootIdentity: FileIdentity
  readonly trackedTreeDigest: string
  readonly worktrees: readonly WorktreeLocation[]
}

interface OutputDirectorySnapshot {
  readonly identity: FileIdentity
  readonly physicalPath: string
  readonly requestedPath: string
}

interface OwnedManifestSnapshot {
  readonly contractDigest: string
  readonly identity: FileIdentity
  readonly manifestDigest: string
  readonly physicalPath: string
  readonly requestedPath: string
}

interface BootstrapState {
  readonly agentworkplaceManifest: OwnedManifestSnapshot
  readonly bootstrapDependencyInstall: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly environment: Readonly<Record<string, string>>
    readonly exitStatus: 0
  }
  readonly invocation: {
    readonly argv: readonly string[]
    readonly cwd: string
  }
  readonly materializedRoot: string
  readonly output: OutputDirectorySnapshot
  readonly schemaVersion: 1
  readonly sourceRepository: RepositorySnapshot
  readonly stagingRoot: string
  readonly tokenDigest: string
}

interface ArtifactRecord {
  readonly digest: string
  readonly path: string
}

interface ContractRecord {
  readonly artifacts: readonly ArtifactRecord[]
  readonly digest: string
  readonly id: string
  readonly kind: "protocol" | "schema"
  readonly version: "1"
}

interface ProviderSkipRecord {
  readonly reason: string
  readonly scenario_id: string
}

export interface FmxProviderManifest {
  readonly adversarial_review_findings: readonly []
  readonly commands: readonly [
    {
      readonly argv: readonly ["./scripts/local-gate.sh"]
      readonly exit_status: number
      readonly id: "local-gate"
    },
  ]
  readonly consumes: readonly [
    {
      readonly digest: string
      readonly id: "agentworkplace.runtime-extension-registration"
      readonly version: "1"
    },
  ]
  readonly contracts: readonly ContractRecord[]
  readonly package: {
    readonly name: "fmx.phase0-provider"
    readonly version: "1"
  }
  readonly repository: {
    readonly name: "fmx"
    readonly sha: string
  }
  readonly schema_version: 1
  readonly skips: {
    readonly actual: readonly ProviderSkipRecord[]
    readonly expected: readonly ProviderSkipRecord[]
  }
}

interface ContractMapping {
  readonly artifactPath: string
  readonly kind: "protocol" | "schema"
  readonly ownerSchemaId: string
  readonly providerId: string
}

const CONTRACT_MAPPINGS: readonly ContractMapping[] = [
  {
    artifactPath: "artifacts/runtime-extension.jsonl",
    kind: "protocol",
    ownerSchemaId: "fmx.runtime-extension",
    providerId: "fmx.runtime-extension-protocol",
  },
  {
    artifactPath: "artifacts/agent-defaults.jsonl",
    kind: "schema",
    ownerSchemaId: "fmx.agent-defaults",
    providerId: "fmx.agent-defaults",
  },
  {
    artifactPath: "artifacts/ensure-lifecycle.jsonl",
    kind: "protocol",
    ownerSchemaId: "fmx.ensure-lifecycle",
    providerId: "fmx.ensure-lifecycle",
  },
  {
    artifactPath: "artifacts/fx-launch-admission-final.jsonl",
    kind: "protocol",
    ownerSchemaId: "fx.launch-admission-final",
    providerId: "fmx.fx-launch-admission",
  },
]

function parseArguments(argv: readonly string[]): ParsedArguments {
  let output: string | undefined
  let agentworkplaceManifest: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--help" || argument === "-h") {
      if (argv.length !== 1) throw new Error("--help accepts no other arguments")
      process.stdout.write(usage)
      process.exit(0)
    }
    if (argument !== "--output" && argument !== "--agentworkplace-manifest") {
      throw new Error(`unknown argument: ${argument ?? ""}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`)
    }
    if (argument === "--output") {
      if (output !== undefined) throw new Error("--output may be provided only once")
      output = value
    } else {
      if (agentworkplaceManifest !== undefined) {
        throw new Error("--agentworkplace-manifest may be provided only once")
      }
      agentworkplaceManifest = value
    }
    index += 1
  }
  if (output === undefined) throw new Error("--output is required")
  if (agentworkplaceManifest === undefined) {
    throw new Error("--agentworkplace-manifest is required")
  }
  return {
    agentworkplaceManifest: resolve(agentworkplaceManifest),
    output: resolve(output),
  }
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key] as JsonValue)]),
  )
}

/** AgentWorkplace's provider/evidence canonical JSON form. */
export function canonicalProviderJson(value: JsonValue): string {
  const render = (candidate: JsonValue, depth: number): string => {
    if (!Array.isArray(candidate) && !isRecord(candidate)) {
      return JSON.stringify(candidate)
    }
    if (Array.isArray(candidate)) {
      if (candidate.length === 0) return "[]"
      const primitivesOnly = candidate.every(
        (item) => !Array.isArray(item) && !isRecord(item),
      )
      if (primitivesOnly) {
        const inline = `[${candidate
          .map((item) => render(item, depth + 1))
          .join(", ")}]`
        if (depth * 2 + inline.length <= 80) return inline
      }
      const indentation = "  ".repeat(depth + 1)
      return `[\n${candidate
        .map((item) => `${indentation}${render(item, depth + 1)}`)
        .join(",\n")}\n${"  ".repeat(depth)}]`
    }
    const entries = Object.entries(candidate)
    if (entries.length === 0) return "{}"
    const indentation = "  ".repeat(depth + 1)
    return `{\n${entries
      .map(
        ([key, child]) =>
          `${indentation}${JSON.stringify(key)}: ${render(child, depth + 1)}`,
      )
      .join(",\n")}\n${"  ".repeat(depth)}}`
  }
  return `${render(sortJsonValue(value), 0)}\n`
}

function sha256(input: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function deriveContractDigest(
  contract: Omit<ContractRecord, "digest">,
): string {
  return sha256(
    canonicalProviderJson({
      artifacts: contract.artifacts as unknown as JsonValue,
      id: contract.id,
      kind: contract.kind,
      version: contract.version,
    }),
  )
}

function fixtureFor(
  verification: ContractVerification,
  schemaId: string,
): VerifiedContractFixture {
  const matches = verification.fixtures.filter(
    (fixture) => fixture.schema_id === schemaId,
  )
  if (matches.length !== 1) {
    throw new Error(`expected exactly one committed fixture for ${schemaId}`)
  }
  return matches[0] as VerifiedContractFixture
}

function skipRecordsFromDescriptions(
  descriptions: readonly string[],
): readonly ProviderSkipRecord[] {
  const observed = new Set(descriptions)
  const records: ProviderSkipRecord[] = FMX_EXPECTED_SKIPS.filter(({ description }) =>
    observed.has(description)
  ).map(({ reason, scenario_id }) => ({ reason, scenario_id }))
  const known = new Set(FMX_EXPECTED_SKIPS.map(({ description }) => description))
  for (const [index, description] of [...observed]
    .filter((candidate) => !known.has(candidate))
    .sort()
    .entries()) {
    records.push({
      reason: `unexpected environment-gated test: ${description}`,
      scenario_id: `tests.unexpected-skip-${index + 1}`,
    })
  }
  return records
}

function expectedSkipRecords(): readonly ProviderSkipRecord[] {
  return FMX_EXPECTED_SKIPS.map(({ reason, scenario_id }) => ({
    reason,
    scenario_id,
  }))
}

export function skipSetsMatch(manifest: FmxProviderManifest): boolean {
  const normalized = (records: readonly ProviderSkipRecord[]) =>
    records
      .map(({ reason, scenario_id }) => `${scenario_id}\0${reason}`)
      .sort()
  return (
    JSON.stringify(normalized(manifest.skips.expected)) ===
    JSON.stringify(normalized(manifest.skips.actual))
  )
}

export function buildFmxProviderManifest(input: {
  readonly actualSkipDescriptions: readonly string[]
  readonly consumedRuntimeRegistrationDigest: string
  readonly gateExitStatus: number
  readonly repositorySha: string
  readonly verification: ContractVerification
}): FmxProviderManifest {
  if (!COMMIT_PATTERN.test(input.repositorySha)) {
    throw new Error("repository SHA must be one full lowercase Git commit")
  }
  if (!SHA256_PATTERN.test(input.consumedRuntimeRegistrationDigest)) {
    throw new Error("Runtime-registration consumption must be one SHA-256 digest")
  }
  if (
    !Number.isInteger(input.gateExitStatus) ||
    input.gateExitStatus < 0 ||
    input.gateExitStatus > 255
  ) {
    throw new Error("gate exit status must be an integer from 0 through 255")
  }
  const contracts = CONTRACT_MAPPINGS.map((mapping) => {
    const fixture = fixtureFor(input.verification, mapping.ownerSchemaId)
    const seed: Omit<ContractRecord, "digest"> = {
      artifacts: [
        {
          digest: `sha256:${fixture.sha256}`,
          path: mapping.artifactPath,
        },
      ],
      id: mapping.providerId,
      kind: mapping.kind,
      version: "1",
    }
    return { ...seed, digest: deriveContractDigest(seed) }
  })
  return {
    adversarial_review_findings: [],
    commands: [
      {
        argv: ["./scripts/local-gate.sh"],
        exit_status: input.gateExitStatus,
        id: "local-gate",
      },
    ],
    consumes: [
      {
        digest: input.consumedRuntimeRegistrationDigest,
        id: "agentworkplace.runtime-extension-registration",
        version: "1",
      },
    ],
    contracts,
    package: { name: "fmx.phase0-provider", version: "1" },
    repository: { name: "fmx", sha: input.repositorySha },
    schema_version: 1,
    skips: {
      actual: skipRecordsFromDescriptions(input.actualSkipDescriptions),
      expected: expectedSkipRecords(),
    },
  }
}

async function readAgentWorkplaceRuntimeDigest(path: string): Promise<{
  readonly digest: string
  readonly manifestDigest: string
}> {
  const facts = await lstat(path)
  if (facts.isSymbolicLink() || !facts.isFile()) {
    throw new Error("AgentWorkplace owned manifest must be a regular nonsymlink file")
  }
  if (facts.size > MAX_MANIFEST_BYTES) {
    throw new Error("AgentWorkplace owned manifest exceeds the 1 MiB bound")
  }
  const bytes = await readFile(path)
  const value = decodeStrictJson(bytes)
  if (canonicalProviderJson(value) !== bytes.toString("utf8")) {
    throw new Error("AgentWorkplace owned manifest is not canonical provider JSON")
  }
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.contracts)) {
    throw new Error("AgentWorkplace owned manifest is not a v1 contract set")
  }
  const matches = value.contracts.filter(
    (candidate) =>
      isRecord(candidate) &&
      candidate.id === "agentworkplace.runtime-extension-registration",
  )
  if (matches.length !== 1) {
    throw new Error(
      "AgentWorkplace owned manifest must contain exactly one Runtime-registration contract",
    )
  }
  const contract = matches[0]
  if (
    !isRecord(contract) ||
    contract.version !== "1" ||
    typeof contract.digest !== "string" ||
    !SHA256_PATTERN.test(contract.digest)
  ) {
    throw new Error("AgentWorkplace Runtime-registration contract is not digest-fixed v1")
  }
  return { digest: contract.digest, manifestDigest: sha256(bytes) }
}

function isWithin(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate)
  return (
    fromParent === "" ||
    (fromParent !== ".." &&
      !fromParent.startsWith(`..${sep}`) &&
      !fromParent.startsWith("/"))
  )
}

async function validateOutputDirectory(path: string): Promise<string> {
  const facts = await lstat(path)
  if (facts.isSymbolicLink() || !facts.isDirectory()) {
    throw new Error("output must be an existing real directory")
  }
  if ((await readdir(path)).length !== 0) {
    throw new Error("output directory must be empty")
  }
  const physicalOutput = await realpath(path)
  const physicalRepository = await realpath(REPOSITORY_ROOT)
  if (isWithin(physicalRepository, physicalOutput)) {
    throw new Error("output directory must be outside the fmx repository")
  }
  return physicalOutput
}

function git(args: readonly string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: REPOSITORY_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    )
  }
  return new TextDecoder().decode(result.stdout).trim()
}

function requireCleanRepository(): string {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"])
  if (status.length !== 0) {
    throw new Error(`fmx integration Worktree is not clean:\n${status}`)
  }
  const sha = git(["rev-parse", "HEAD"])
  if (!COMMIT_PATTERN.test(sha)) throw new Error("fmx HEAD is not a full Git commit")
  return sha
}

function parseSkippedDescriptions(output: string): readonly string[] {
  const descriptions = new Set<string>()
  for (const match of output.matchAll(/^\(skip\) (.+)$/gmu)) {
    const description = match[1]?.trim()
    if (description !== undefined && description.length > 0) {
      descriptions.add(description)
    }
  }
  return [...descriptions]
}

async function runLocalGate(): Promise<GateResult> {
  try {
    const child = Bun.spawn({
      cmd: ["./scripts/local-gate.sh"],
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stderr: "pipe",
      stdout: "pipe",
    })
    const [stdout, stderr, exitStatus] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    return {
      actualSkipDescriptions: parseSkippedDescriptions(`${stdout}\n${stderr}`),
      exitStatus,
    }
  } catch (error) {
    process.stderr.write(
      `fmx provider generator: could not start local gate: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return { actualSkipDescriptions: [], exitStatus: 127 }
  }
}

export async function materializeFmxProviderBundle(
  output: string,
  manifest: FmxProviderManifest,
  verification: ContractVerification,
): Promise<{ readonly digest: string; readonly path: string }> {
  await mkdir(join(output, "artifacts"), { recursive: false })
  for (const mapping of CONTRACT_MAPPINGS) {
    const fixture = fixtureFor(verification, mapping.ownerSchemaId)
    const source = resolve(
      REPOSITORY_ROOT,
      "contracts/agentworkplace/v1",
      fixture.path,
    )
    const destination = join(output, mapping.artifactPath)
    if (basename(destination) !== basename(source)) {
      throw new Error(`provider mapping renames committed bytes for ${mapping.providerId}`)
    }
    await copyFile(source, destination)
    const [sourceBytes, destinationBytes] = await Promise.all([
      readFile(source),
      readFile(destination),
    ])
    if (!sourceBytes.equals(destinationBytes)) {
      throw new Error(`provider artifact copy changed bytes for ${mapping.providerId}`)
    }
    if (sha256(destinationBytes) !== `sha256:${fixture.sha256}`) {
      throw new Error(`provider artifact copy digest changed for ${mapping.providerId}`)
    }
  }
  const bytes = canonicalProviderJson(manifest as unknown as JsonValue)
  const path = join(output, "phase0-provider.json")
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
  return { digest: sha256(bytes), path }
}

async function main(): Promise<number> {
  const parsed = parseArguments(Bun.argv.slice(2))
  const output = await validateOutputDirectory(parsed.output)
  const initialSha = requireCleanRepository()
  const owned = await readAgentWorkplaceRuntimeDigest(
    parsed.agentworkplaceManifest,
  )
  const verification = await verifyAgentWorkplaceContracts()
  const gate = await runLocalGate()
  const finalSha = requireCleanRepository()
  if (finalSha !== initialSha) {
    throw new Error("fmx HEAD changed while its provider gate was running")
  }
  const manifest = buildFmxProviderManifest({
    actualSkipDescriptions: gate.actualSkipDescriptions,
    consumedRuntimeRegistrationDigest: owned.digest,
    gateExitStatus: gate.exitStatus,
    repositorySha: finalSha,
    verification,
  })
  const generated = await materializeFmxProviderBundle(
    output,
    manifest,
    verification,
  )
  const accepted = gate.exitStatus === 0 && skipSetsMatch(manifest)
  process.stdout.write(
    `${JSON.stringify({
      accepted,
      actual_skip_count: manifest.skips.actual.length,
      expected_skip_count: manifest.skips.expected.length,
      gate_exit_status: gate.exitStatus,
      manifest: generated.path,
      manifest_digest: generated.digest,
      owner_manifest_digest: `sha256:${verification.manifest_sha256}`,
      repository_sha: finalSha,
      consumed_agentworkplace_manifest_digest: owned.manifestDigest,
    })}\n`,
  )
  return accepted ? 0 : 1
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(
      `fmx provider generator: ${error instanceof Error ? error.message : String(error)}\n${usage}`,
    )
    process.exitCode = 1
  }
}
