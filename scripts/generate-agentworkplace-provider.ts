#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, parse, resolve, sep } from "node:path"
import {
  decodeStrictJson,
  type JsonValue,
} from "../src/contract-codec.ts"
import {
  type ContractVerification,
  type VerifiedContractFixture,
  verifyAgentWorkplaceContracts,
} from "./check-agentworkplace-contracts.ts"
import {
  assertRepositorySnapshotStable,
  captureCleanRepositorySnapshot,
  environmentWithoutGitOverrides,
  isWithin,
  materializeRepositorySnapshot,
  type RepositorySnapshot,
} from "./provider-repository-snapshot.ts"

const REPOSITORY_ROOT = resolve(import.meta.dir, "..")
const MAX_MANIFEST_BYTES = 1024 * 1024
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const GATE_LOG_PATH = "local-gate.log"
const GENERATION_EVIDENCE_PATH = "generation-evidence.json"
const PROVIDER_MANIFEST_PATH = "phase0-provider.json"
const SOURCE_DIRECTORY_PREFIX = "fmx-phase0-provider-source-"
const STAGING_DIRECTORY_PREFIX = ".fmx-phase0-provider-stage-"

const usage = `Usage: scripts/generate-agentworkplace-provider.ts \\
  --output <existing-empty-directory> \\
  --agentworkplace-manifest <phase0-owned-manifest.json>

Runs fmx's canonical local gate, then writes a disposable canonical
AgentWorkplace provider-manifest v1 bundle from the exact committed fmx
contract bytes. The output directory must be outside every registered fmx
Worktree and its common Git directory. The bundle also retains a hashed gate
log and generation-evidence record without changing provider-manifest v1.
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
  readonly exitStatus: number
  readonly logBytes: Uint8Array
  readonly workingDirectory: string
}

interface OutputTarget {
  readonly device: bigint
  readonly inode: bigint
  readonly parentDevice: bigint
  readonly parentInode: bigint
  readonly parentPath: string
  readonly physicalPath: string
  readonly requestedPath: string
}

interface IntendedFile {
  readonly bytes: Uint8Array
  readonly path: string
}

interface PublishedEntry {
  readonly device: bigint
  readonly inode: bigint
  readonly kind: "directory" | "file"
  readonly path: string
}

interface FileEvidence {
  readonly bytes: number
  readonly digest: string
  readonly path: string
}

interface OwnedRuntimeDigest {
  readonly digest: string
  readonly manifestDigest: string
}

interface StagedBundle {
  readonly device: bigint
  readonly directory: string
  readonly evidence: FileEvidence
  readonly files: readonly IntendedFile[]
  readonly gateLog: FileEvidence
  readonly inode: bigint
  readonly manifest: FileEvidence
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

async function readRegularFileNoFollow(
  path: string,
  label: string,
  maximumBytes?: number,
): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`${label} must be a regular file`)
    if (maximumBytes !== undefined && before.size > BigInt(maximumBytes)) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte bound`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      throw new Error(`${label} changed while it was read`)
    }
    const pathFacts = await lstat(path, { bigint: true })
    if (
      pathFacts.isSymbolicLink() ||
      !pathFacts.isFile() ||
      pathFacts.dev !== before.dev ||
      pathFacts.ino !== before.ino
    ) {
      throw new Error(`${label} path changed while it was read`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function readAgentWorkplaceRuntimeDigest(
  path: string,
): Promise<OwnedRuntimeDigest> {
  const bytes = await readRegularFileNoFollow(
    path,
    "AgentWorkplace owned manifest",
    MAX_MANIFEST_BYTES,
  )
  const value = decodeStrictJson(bytes)
  if (canonicalProviderJson(value) !== new TextDecoder().decode(bytes)) {
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

function requireOutputOutsideFmx(
  physicalOutput: string,
  snapshot: RepositorySnapshot,
): void {
  if (isWithin(snapshot.commonGitDirectory, physicalOutput)) {
    throw new Error("output directory must be outside fmx's common Git directory")
  }
  for (const worktree of snapshot.worktrees) {
    if (isWithin(worktree, physicalOutput)) {
      throw new Error(`output directory must be outside every registered fmx Worktree: ${worktree}`)
    }
  }
}

async function validateOutputDirectory(
  path: string,
  snapshot: RepositorySnapshot,
): Promise<OutputTarget> {
  const facts = await lstat(path, { bigint: true })
  if (facts.isSymbolicLink() || !facts.isDirectory()) {
    throw new Error("output must be an existing real directory")
  }
  if ((await readdir(path)).length !== 0) {
    throw new Error("output directory must be empty")
  }
  const physicalOutput = await realpath(path)
  const physicalFacts = await lstat(physicalOutput, { bigint: true })
  if (
    physicalFacts.isSymbolicLink() ||
    !physicalFacts.isDirectory() ||
    physicalFacts.dev !== facts.dev ||
    physicalFacts.ino !== facts.ino
  ) {
    throw new Error("output directory identity changed during validation")
  }
  requireOutputOutsideFmx(physicalOutput, snapshot)
  const parentPath = await realpath(dirname(physicalOutput))
  const parentFacts = await lstat(parentPath, { bigint: true })
  if (parentFacts.isSymbolicLink() || !parentFacts.isDirectory()) {
    throw new Error("output parent must be a real directory")
  }
  return {
    device: facts.dev,
    inode: facts.ino,
    parentDevice: parentFacts.dev,
    parentInode: parentFacts.ino,
    parentPath,
    physicalPath: physicalOutput,
    requestedPath: path,
  }
}

async function revalidateOutputDirectory(
  target: OutputTarget,
  snapshot: RepositorySnapshot,
  requireEmpty = true,
): Promise<void> {
  const facts = await lstat(target.requestedPath, { bigint: true })
  if (
    facts.isSymbolicLink() ||
    !facts.isDirectory() ||
    facts.dev !== target.device ||
    facts.ino !== target.inode ||
    (await realpath(target.requestedPath)) !== target.physicalPath
  ) {
    throw new Error("output directory identity changed while the provider gate ran")
  }
  const parentFacts = await lstat(target.parentPath, { bigint: true })
  if (
    parentFacts.isSymbolicLink() ||
    !parentFacts.isDirectory() ||
    parentFacts.dev !== target.parentDevice ||
    parentFacts.ino !== target.parentInode
  ) {
    throw new Error("output parent identity changed while the provider gate ran")
  }
  if (requireEmpty && (await readdir(target.physicalPath)).length !== 0) {
    throw new Error("output directory stopped being empty while the provider gate ran")
  }
  requireOutputOutsideFmx(target.physicalPath, snapshot)
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

async function runLocalGate(
  repositoryRoot: string,
  logPath: string,
): Promise<GateResult> {
  const log = await open(
    logPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_APPEND,
    FILE_MODE,
  )
  let exitStatus: number | undefined
  let startError: Error | undefined
  try {
    try {
      const child = Bun.spawn({
        cmd: ["./scripts/local-gate.sh"],
        cwd: repositoryRoot,
        env: environmentWithoutGitOverrides(),
        stderr: log.fd,
        stdout: log.fd,
      })
      const status = await child.exited
      if (!Number.isInteger(status) || status < 0 || status > 255) {
        throw new Error(`local gate returned an invalid process status: ${status}`)
      }
      exitStatus = status
    } catch (error) {
      const message =
        `fmx provider generator: could not start local gate: ${error instanceof Error ? error.message : String(error)}\n`
      await log.write(message)
      startError = new Error(message.trim(), { cause: error })
    }
    await log.sync()
  } finally {
    await log.close()
  }
  await chmod(logPath, FILE_MODE)
  const logBytes = await readRegularFileNoFollow(logPath, "retained local-gate log")
  process.stdout.write(logBytes)
  if (startError !== undefined) throw startError
  if (exitStatus === undefined) {
    throw new Error("local gate ended without an exit status")
  }
  return {
    actualSkipDescriptions: parseSkippedDescriptions(
      new TextDecoder().decode(logBytes),
    ),
    exitStatus,
    logBytes,
    workingDirectory: repositoryRoot,
  }
}

function evidenceFor(file: IntendedFile): FileEvidence {
  return {
    bytes: file.bytes.byteLength,
    digest: sha256(file.bytes),
    path: file.path,
  }
}

async function writeExclusiveNoFollow(
  root: string,
  file: IntendedFile,
  onCreate?: (entry: PublishedEntry) => void,
): Promise<PublishedEntry> {
  const path = resolve(root, file.path)
  if (!isWithin(root, path) || path === root) {
    throw new Error(`provider output path escapes its private stage: ${file.path}`)
  }
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    FILE_MODE,
  )
  let device: bigint | undefined
  let inode: bigint | undefined
  try {
    const created = await handle.stat({ bigint: true })
    device = created.dev
    inode = created.ino
    onCreate?.({ device, inode, kind: "file", path: file.path })
    await handle.writeFile(file.bytes)
    await handle.chmod(FILE_MODE)
    await handle.sync()
    const facts = await handle.stat({ bigint: true })
    if (!facts.isFile()) {
      throw new Error(`exclusive provider output is not a file: ${file.path}`)
    }
    if (facts.dev !== device || facts.ino !== inode) {
      throw new Error(`exclusive provider file descriptor changed: ${file.path}`)
    }
  } finally {
    await handle.close()
  }
  const pathFacts = await lstat(path, { bigint: true })
  if (
    device === undefined ||
    inode === undefined ||
    pathFacts.isSymbolicLink() ||
    !pathFacts.isFile() ||
    pathFacts.dev !== device ||
    pathFacts.ino !== inode
  ) {
    throw new Error(`exclusive provider file changed identity: ${file.path}`)
  }
  return {
    device,
    inode,
    kind: "file",
    path: file.path,
  }
}

function expectedDirectories(files: readonly IntendedFile[]): readonly string[] {
  const expected = new Set<string>()
  for (const file of files) {
    let at = dirname(file.path)
    while (at !== ".") {
      expected.add(at)
      at = dirname(at)
    }
  }
  return [...expected].sort()
}

async function verifyBundleInventory(
  root: string,
  expectedFiles: readonly IntendedFile[],
  requirePrivateRoot = true,
): Promise<void> {
  const rootFacts = await lstat(root)
  if (
    rootFacts.isSymbolicLink() ||
    !rootFacts.isDirectory() ||
    (requirePrivateRoot && (rootFacts.mode & 0o777) !== DIRECTORY_MODE)
  ) {
    throw new Error("provider bundle root lost its private directory identity")
  }
  const actualFiles: string[] = []
  const actualDirectories: string[] = []
  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = resolve(root, relativeDirectory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath =
        relativeDirectory.length === 0
          ? entry.name
          : join(relativeDirectory, entry.name)
      const path = resolve(root, relativePath)
      const facts = await lstat(path)
      if (entry.isSymbolicLink() || facts.isSymbolicLink()) {
        throw new Error(`provider bundle contains a symlink: ${relativePath}`)
      }
      if (entry.isDirectory() && facts.isDirectory()) {
        if ((facts.mode & 0o777) !== DIRECTORY_MODE) {
          throw new Error(`provider bundle directory is not mode 0700: ${relativePath}`)
        }
        actualDirectories.push(relativePath)
        await visit(relativePath)
      } else if (entry.isFile() && facts.isFile()) {
        if ((facts.mode & 0o777) !== FILE_MODE || facts.nlink !== 1) {
          throw new Error(`provider bundle file is not private and exclusive: ${relativePath}`)
        }
        actualFiles.push(relativePath)
      } else {
        throw new Error(`provider bundle contains a nonregular entry: ${relativePath}`)
      }
    }
  }
  await visit("")
  const expectedPaths = expectedFiles.map(({ path }) => path).sort()
  if (JSON.stringify(actualFiles.sort()) !== JSON.stringify(expectedPaths)) {
    throw new Error("provider bundle final file inventory differs from the staged intent")
  }
  if (
    JSON.stringify(actualDirectories.sort()) !==
    JSON.stringify(expectedDirectories(expectedFiles))
  ) {
    throw new Error("provider bundle final directory inventory differs from the staged intent")
  }
  for (const expected of expectedFiles) {
    const actual = await readRegularFileNoFollow(
      resolve(root, expected.path),
      `provider bundle ${expected.path}`,
    )
    if (!Buffer.from(actual).equals(Buffer.from(expected.bytes))) {
      throw new Error(`provider bundle content changed after staging: ${expected.path}`)
    }
  }
}

async function stageFmxProviderBundle(input: {
  readonly accepted: boolean
  readonly bunLinkRestored: boolean
  readonly gate: GateResult
  readonly manifest: FmxProviderManifest
  readonly owned: OwnedRuntimeDigest
  readonly ownedManifestPath: string
  readonly repositorySnapshot: RepositorySnapshot
  readonly sourceRepository: string
  readonly target: OutputTarget
  readonly verification: ContractVerification
}): Promise<StagedBundle> {
  const directory = await mkdtemp(
    join(input.target.parentPath, STAGING_DIRECTORY_PREFIX),
  )
  let directoryDevice: bigint | undefined
  let directoryInode: bigint | undefined
  try {
    await chmod(directory, DIRECTORY_MODE)
    const initialDirectoryFacts = await lstat(directory, { bigint: true })
    directoryDevice = initialDirectoryFacts.dev
    directoryInode = initialDirectoryFacts.ino
    const artifactsDirectory = join(directory, "artifacts")
    await mkdir(artifactsDirectory, { mode: DIRECTORY_MODE })
    await chmod(artifactsDirectory, DIRECTORY_MODE)

    const payloadFiles: IntendedFile[] = []
    for (const mapping of CONTRACT_MAPPINGS) {
      const fixture = fixtureFor(input.verification, mapping.ownerSchemaId)
      const source = resolve(
        input.sourceRepository,
        "contracts/agentworkplace/v1",
        fixture.path,
      )
      if (basename(mapping.artifactPath) !== basename(source)) {
        throw new Error(
          `provider mapping renames committed bytes for ${mapping.providerId}`,
        )
      }
      const bytes = await readRegularFileNoFollow(
        source,
        `committed provider artifact ${mapping.ownerSchemaId}`,
      )
      if (sha256(bytes) !== `sha256:${fixture.sha256}`) {
        throw new Error(`committed provider artifact changed for ${mapping.providerId}`)
      }
      payloadFiles.push({ bytes, path: mapping.artifactPath })
    }

    const manifestFile: IntendedFile = {
      bytes: new TextEncoder().encode(
        canonicalProviderJson(input.manifest as unknown as JsonValue),
      ),
      path: PROVIDER_MANIFEST_PATH,
    }
    const gateLogFile: IntendedFile = {
      bytes: input.gate.logBytes,
      path: GATE_LOG_PATH,
    }
    payloadFiles.push(manifestFile, gateLogFile)
    for (const file of payloadFiles) await writeExclusiveNoFollow(directory, file)

    const generatorRelativePath = "scripts/generate-agentworkplace-provider.ts"
    const generatorBytes = await readRegularFileNoFollow(
      resolve(input.sourceRepository, generatorRelativePath),
      "materialized provider generator",
    )
    const payloadInventory = payloadFiles
      .map(evidenceFor)
      .sort((left, right) => left.path.localeCompare(right.path))
    const generationEvidence = {
      accepted: input.accepted,
      agentworkplace_input: {
        contract_digest: input.owned.digest,
        manifest_digest: input.owned.manifestDigest,
        path: input.ownedManifestPath,
      },
      command: {
        argv: ["./scripts/local-gate.sh"],
        bun_link_restored_to_invoking_worktree: input.bunLinkRestored,
        cwd: input.gate.workingDirectory,
        exit_status: input.gate.exitStatus,
        log: evidenceFor(gateLogFile),
      },
      generator: {
        path: generatorRelativePath,
        sha256: sha256(generatorBytes),
      },
      output: {
        directory: input.target.physicalPath,
        payload_inventory: payloadInventory,
        publication: "private-stage-exclusive-no-follow-copy",
      },
      owner_contract_manifest: {
        digest: `sha256:${input.verification.manifest_sha256}`,
        path: "contracts/agentworkplace/v1/manifest.json",
      },
      provider_manifest_contract: "AgentWorkplace provider-manifest v1 (unchanged)",
      repository: {
        common_git_directory: input.repositorySnapshot.commonGitDirectory,
        head_sha: input.repositorySnapshot.headSha,
        head_tree: input.repositorySnapshot.headTree,
        invoking_worktree: input.repositorySnapshot.repositoryRoot,
        source_materialization: {
          cwd: input.gate.workingDirectory,
          method: "private detached fetch of the exact commit",
        },
        tracked_entry_count: input.repositorySnapshot.trackedEntryCount,
      },
      schema_id: "fmx.phase0-provider-generation-evidence",
      schema_version: 1,
      skips: {
        actual_count: input.manifest.skips.actual.length,
        expected_count: input.manifest.skips.expected.length,
        match: skipSetsMatch(input.manifest),
      },
    }
    const evidenceFile: IntendedFile = {
      bytes: new TextEncoder().encode(
        canonicalProviderJson(generationEvidence as unknown as JsonValue),
      ),
      path: GENERATION_EVIDENCE_PATH,
    }
    await writeExclusiveNoFollow(directory, evidenceFile)
    const files = [...payloadFiles, evidenceFile]
    await verifyBundleInventory(directory, files)
    const directoryFacts = await lstat(directory, { bigint: true })
    return {
      device: directoryFacts.dev,
      directory,
      evidence: evidenceFor(evidenceFile),
      files,
      gateLog: evidenceFor(gateLogFile),
      inode: directoryFacts.ino,
      manifest: evidenceFor(manifestFile),
    }
  } catch (error) {
    if (directoryDevice !== undefined && directoryInode !== undefined) {
      await removePrivateDirectory(
        directory,
        directoryDevice,
        directoryInode,
        "provider stage",
      )
    }
    throw error
  }
}

async function removePrivateDirectory(
  path: string,
  device: bigint,
  inode: bigint,
  label: string,
): Promise<void> {
  const facts = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  if (facts === undefined) return
  if (
    facts.isSymbolicLink() ||
    !facts.isDirectory() ||
    facts.dev !== device ||
    facts.ino !== inode
  ) {
    throw new Error(`refusing to remove a replaced ${label} directory`)
  }
  await rm(path, { recursive: true })
}

async function publishStagedBundle(
  target: OutputTarget,
  snapshot: RepositorySnapshot,
  staged: StagedBundle,
): Promise<void> {
  await verifyBundleInventory(staged.directory, staged.files)
  await revalidateOutputDirectory(target, snapshot)
  const published: PublishedEntry[] = []
  const artifactsPath = join(target.physicalPath, "artifacts")
  const requireIdentity = async (entry: PublishedEntry): Promise<void> => {
    const facts = await lstat(resolve(target.physicalPath, entry.path), {
      bigint: true,
    })
    const expectedType = entry.kind === "directory" ? facts.isDirectory() : facts.isFile()
    if (
      facts.isSymbolicLink() ||
      !expectedType ||
      facts.dev !== entry.device ||
      facts.ino !== entry.inode
    ) {
      throw new Error(`published provider entry changed identity: ${entry.path}`)
    }
  }
  const requireAllPublishedIdentities = async (): Promise<void> => {
    for (const entry of published) await requireIdentity(entry)
  }
  const rollback = async (): Promise<void> => {
    for (const entry of [...published].reverse()) {
      await revalidateOutputDirectory(target, snapshot, false)
      if (entry.path.startsWith("artifacts/") && published[0] !== undefined) {
        await requireIdentity(published[0])
      }
      await requireIdentity(entry)
      const path = resolve(target.physicalPath, entry.path)
      if (entry.kind === "file") {
        await unlink(path)
      } else {
        if ((await readdir(path)).length !== 0) {
          throw new Error("refusing to remove a provider directory containing foreign entries")
        }
        await rmdir(path)
      }
    }
  }

  try {
    await mkdir(artifactsPath, { mode: DIRECTORY_MODE })
    const createdArtifacts = await lstat(artifactsPath, { bigint: true })
    published.push({
      device: createdArtifacts.dev,
      inode: createdArtifacts.ino,
      kind: "directory",
      path: "artifacts",
    })
    const artifacts = await open(
      artifactsPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      await artifacts.chmod(DIRECTORY_MODE)
      const facts = await artifacts.stat({ bigint: true })
      if (
        facts.dev !== createdArtifacts.dev ||
        facts.ino !== createdArtifacts.ino
      ) {
        throw new Error("published artifacts directory changed during creation")
      }
    } finally {
      await artifacts.close()
    }
    await requireIdentity(published[0] as PublishedEntry)
    await revalidateOutputDirectory(target, snapshot, false)

    const orderedFiles = [...staged.files].sort((left, right) => {
      const rank = (file: IntendedFile) =>
        file.path === PROVIDER_MANIFEST_PATH ? 2 : file.path.startsWith("artifacts/") ? 0 : 1
      return rank(left) - rank(right) || left.path.localeCompare(right.path)
    })
    for (const file of orderedFiles) {
      await revalidateOutputDirectory(target, snapshot, false)
      if (file.path.startsWith("artifacts/")) {
        await requireIdentity(published[0] as PublishedEntry)
      }
      const entry = await writeExclusiveNoFollow(
        target.physicalPath,
        file,
        (created) => published.push(created),
      )
      await requireIdentity(entry)
      await revalidateOutputDirectory(target, snapshot, false)
    }
    await requireAllPublishedIdentities()
    await verifyBundleInventory(target.physicalPath, staged.files, false)
    await requireAllPublishedIdentities()
    await revalidateOutputDirectory(target, snapshot, false)
  } catch (error) {
    try {
      await rollback()
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "provider publication failed and identity-safe rollback could not finish",
      )
    }
    throw error
  }
}

function bunGlobalBin(): string {
  const result = Bun.spawnSync({
    cmd: ["bun", "pm", "bin", "-g"],
    cwd: REPOSITORY_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `could not inspect Bun's global link directory: ${new TextDecoder().decode(result.stderr).trim()}`,
    )
  }
  return new TextDecoder().decode(result.stdout).trim()
}

async function resolveSymlinkChainEvenIfDangling(path: string): Promise<string> {
  const components = (absolutePath: string) => {
    const normalized = resolve(absolutePath)
    const root = parse(normalized).root
    return {
      parts: normalized
        .slice(root.length)
        .split(sep)
        .filter((part) => part.length > 0),
      root,
    }
  }
  let { parts: pending, root: at } = components(path)
  let followed = 0
  while (pending.length > 0) {
    const part = pending.shift() as string
    const candidate = join(at, part)
    const facts = await lstat(candidate).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") return undefined
      throw error
    })
    if (facts === undefined) return resolve(candidate, ...pending)
    if (!facts.isSymbolicLink()) {
      at = candidate
      continue
    }
    followed += 1
    if (followed > 64) {
      throw new Error(`Bun's fmx link contains a symlink loop: ${path}`)
    }
    const destination = resolve(dirname(candidate), await readlink(candidate))
    const expanded = components(destination)
    at = expanded.root
    pending = [...expanded.parts, ...pending]
  }
  return at
}

async function ensureBunExecutableSymlink(
  path: string,
  target: string,
): Promise<void> {
  const facts = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  if (facts === undefined) {
    await symlink(target, path)
    const created = await lstat(path)
    if (!created.isSymbolicLink()) {
      throw new Error(`Bun's restored executable is not a symlink: ${path}`)
    }
    return
  }
  if (!facts.isSymbolicLink()) {
    throw new Error(`refusing to replace Bun's nonsymlink executable: ${path}`)
  }
}

async function restoreBunLinkIfMaterialized(
  sourceRepository: string,
): Promise<boolean> {
  const physicalSourceRepository = await realpath(sourceRepository)
  const bin = bunGlobalBin()
  const linkedExecutables = [join(bin, "fmx"), join(bin, "fmx-mcp")]
  const globalPackage = resolve(
    bin,
    "..",
    "install/global/node_modules/fmx",
  )
  const linkDestinations = await Promise.all(
    [...linkedExecutables, globalPackage].map(resolveSymlinkChainEvenIfDangling),
  )
  const pointsAtMaterialization = linkDestinations.some((destination) =>
    isWithin(physicalSourceRepository, destination)
  )
  if (!pointsAtMaterialization) return false
  const result = Bun.spawnSync({
    cmd: ["bun", "link"],
    cwd: REPOSITORY_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `could not restore Bun's fmx link after the private gate: ${new TextDecoder().decode(result.stderr).trim()}`,
    )
  }
  await ensureBunExecutableSymlink(
    linkedExecutables[0] as string,
    "../install/global/node_modules/fmx/src/index.ts",
  )
  await ensureBunExecutableSymlink(
    linkedExecutables[1] as string,
    "../install/global/node_modules/fmx/src/mcp.ts",
  )
  const invokingRepository = await realpath(REPOSITORY_ROOT)
  for (const executable of linkedExecutables) {
    const destination = await resolveSymlinkChainEvenIfDangling(executable)
    if (!isWithin(invokingRepository, destination)) {
      throw new Error(
        `Bun's restored ${basename(executable)} link does not point into the invoking Worktree`,
      )
    }
  }
  return true
}

async function main(): Promise<number> {
  const parsed = parseArguments(Bun.argv.slice(2))
  const repositorySnapshot = await captureCleanRepositorySnapshot(REPOSITORY_ROOT)
  const output = await validateOutputDirectory(parsed.output, repositorySnapshot)
  const owned = await readAgentWorkplaceRuntimeDigest(parsed.agentworkplaceManifest)
  const sourceRoot = await mkdtemp(join(tmpdir(), SOURCE_DIRECTORY_PREFIX))
  await chmod(sourceRoot, DIRECTORY_MODE)
  const sourceRootFacts = await lstat(sourceRoot, { bigint: true })
  const sourceRepository = join(sourceRoot, "fmx")
  let staged: StagedBundle | undefined
  let result:
    | {
        readonly accepted: boolean
        readonly bunLinkRestored: boolean
        readonly gate: GateResult
        readonly manifest: FmxProviderManifest
        readonly owned: OwnedRuntimeDigest
        readonly staged: StagedBundle
        readonly verification: ContractVerification
      }
    | undefined
  try {
    const materializedSnapshot = await materializeRepositorySnapshot(
      repositorySnapshot,
      sourceRepository,
    )
    const gate = await runLocalGate(sourceRepository, join(sourceRoot, "gate.log"))
    await assertRepositorySnapshotStable(sourceRepository, materializedSnapshot)
    await assertRepositorySnapshotStable(REPOSITORY_ROOT, repositorySnapshot)
    const finalOwned = await readAgentWorkplaceRuntimeDigest(
      parsed.agentworkplaceManifest,
    )
    if (
      finalOwned.digest !== owned.digest ||
      finalOwned.manifestDigest !== owned.manifestDigest
    ) {
      throw new Error("AgentWorkplace owned manifest changed while the provider gate ran")
    }
    const verification = await verifyAgentWorkplaceContracts(
      resolve(sourceRepository, "contracts/agentworkplace/v1"),
    )
    const manifest = buildFmxProviderManifest({
      actualSkipDescriptions: gate.actualSkipDescriptions,
      consumedRuntimeRegistrationDigest: owned.digest,
      gateExitStatus: gate.exitStatus,
      repositorySha: repositorySnapshot.headSha,
      verification,
    })
    const accepted = gate.exitStatus === 0 && skipSetsMatch(manifest)
    const bunLinkRestored = await restoreBunLinkIfMaterialized(sourceRepository)
    await assertRepositorySnapshotStable(REPOSITORY_ROOT, repositorySnapshot)
    staged = await stageFmxProviderBundle({
      accepted,
      bunLinkRestored,
      gate,
      manifest,
      owned,
      ownedManifestPath: parsed.agentworkplaceManifest,
      repositorySnapshot,
      sourceRepository,
      target: output,
      verification,
    })
    await assertRepositorySnapshotStable(sourceRepository, materializedSnapshot)
    await assertRepositorySnapshotStable(REPOSITORY_ROOT, repositorySnapshot)
    await publishStagedBundle(output, repositorySnapshot, staged)
    result = {
      accepted,
      bunLinkRestored,
      gate,
      manifest,
      owned,
      staged,
      verification,
    }
  } finally {
    await restoreBunLinkIfMaterialized(sourceRepository)
    if (staged !== undefined) {
      await removePrivateDirectory(
        staged.directory,
        staged.device,
        staged.inode,
        "provider stage",
      )
    }
    await removePrivateDirectory(
      sourceRoot,
      sourceRootFacts.dev,
      sourceRootFacts.ino,
      "provider source",
    )
  }
  if (result === undefined) throw new Error("provider generation ended without a result")
  process.stdout.write(
    `${JSON.stringify({
      accepted: result.accepted,
      actual_skip_count: result.manifest.skips.actual.length,
      bun_link_restored_to_invoking_worktree: result.bunLinkRestored,
      consumed_agentworkplace_manifest_digest: result.owned.manifestDigest,
      expected_skip_count: FMX_EXPECTED_SKIPS.length,
      gate_exit_status: result.gate.exitStatus,
      gate_log: join(output.physicalPath, result.staged.gateLog.path),
      gate_log_digest: result.staged.gateLog.digest,
      generation_evidence: join(
        output.physicalPath,
        result.staged.evidence.path,
      ),
      generation_evidence_digest: result.staged.evidence.digest,
      manifest: join(output.physicalPath, result.staged.manifest.path),
      manifest_digest: result.staged.manifest.digest,
      owner_manifest_digest: `sha256:${result.verification.manifest_sha256}`,
      output_inventory_count: result.staged.files.length,
      repository_sha: repositorySnapshot.headSha,
      repository_tree: repositorySnapshot.headTree,
    })}\n`,
  )
  return result.accepted ? 0 : 1
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
