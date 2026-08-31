import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
} from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const TREE_PATTERN = /^[0-9a-f]{40}$/u
const OBJECT_PATTERN = /^[0-9a-f]{40}$/u
const decoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()

interface GitTreeEntry {
  readonly mode: string
  readonly objectId: string
  readonly path: string
  readonly type: string
}

export interface RepositorySnapshot {
  readonly commonGitDirectory: string
  readonly headSha: string
  readonly headTree: string
  readonly repositoryRoot: string
  readonly trackedEntryCount: number
  readonly worktrees: readonly string[]
}

export function environmentWithoutGitOverrides(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const environment = { ...source }
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key]
  }
  // Provider evidence must not inherit repository selection, an alternate
  // index, replacement objects, or machine/user configuration from the
  // invoking shell. The supported provider platforms are macOS and Linux, so
  // /dev/null is the explicit empty global/system configuration source.
  environment.GIT_ATTR_NOSYSTEM = "1"
  environment.GIT_CONFIG_GLOBAL = "/dev/null"
  environment.GIT_CONFIG_NOSYSTEM = "1"
  environment.GIT_CONFIG_SYSTEM = "/dev/null"
  environment.GIT_NO_REPLACE_OBJECTS = "1"
  return environment
}

function gitBytes(repositoryRoot: string, args: readonly string[]): Uint8Array {
  const result = Bun.spawnSync({
    cmd: ["git", "--no-replace-objects", ...args],
    cwd: repositoryRoot,
    env: environmentWithoutGitOverrides(),
    stderr: "pipe",
    stdout: "pipe",
  })
  if (result.exitCode !== 0) {
    const detail = decoder.decode(result.stderr).trim()
    throw new Error(
      `git ${args.join(" ")} failed while verifying fmx HEAD${detail.length === 0 ? "" : `: ${detail}`}`,
    )
  }
  return result.stdout
}

function gitText(repositoryRoot: string, args: readonly string[]): string {
  return decoder.decode(gitBytes(repositoryRoot, args)).trim()
}

function nulRecords(bytes: Uint8Array, label: string): readonly string[] {
  const text = decoder.decode(bytes)
  if (text.length === 0) return []
  if (!text.endsWith("\0")) {
    throw new Error(`${label} was not NUL terminated`)
  }
  return text.slice(0, -1).split("\0")
}

function parseTreeEntries(
  repositoryRoot: string,
  revision: string,
): readonly GitTreeEntry[] {
  return nulRecords(
    gitBytes(repositoryRoot, [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      revision,
    ]),
    "Git tree inventory",
  ).map((record) => {
    const separator = record.indexOf("\t")
    const metadata = separator === -1 ? [] : record.slice(0, separator).split(" ")
    const path = separator === -1 ? "" : record.slice(separator + 1)
    const [mode, type, objectId] = metadata
    if (
      mode === undefined ||
      type === undefined ||
      objectId === undefined ||
      !OBJECT_PATTERN.test(objectId) ||
      path.length === 0
    ) {
      throw new Error("Git returned an invalid fmx tree entry")
    }
    return { mode, objectId, path, type }
  })
}

function parseIndexEntries(repositoryRoot: string): readonly GitTreeEntry[] {
  return nulRecords(
    gitBytes(repositoryRoot, ["ls-files", "--stage", "-z"]),
    "Git index inventory",
  ).map((record) => {
    const separator = record.indexOf("\t")
    const metadata = separator === -1 ? [] : record.slice(0, separator).split(" ")
    const path = separator === -1 ? "" : record.slice(separator + 1)
    const [mode, objectId, stage] = metadata
    if (
      mode === undefined ||
      objectId === undefined ||
      !OBJECT_PATTERN.test(objectId) ||
      stage !== "0" ||
      path.length === 0
    ) {
      throw new Error("fmx index contains an invalid or unmerged entry")
    }
    return {
      mode,
      objectId,
      path,
      type: mode === "160000" ? "commit" : "blob",
    }
  })
}

function entriesMatch(
  actual: readonly GitTreeEntry[],
  expected: readonly GitTreeEntry[],
): boolean {
  const render = (entries: readonly GitTreeEntry[]) =>
    entries.map(({ mode, objectId, path, type }) => ({
      mode,
      objectId,
      path,
      type,
    }))
  return JSON.stringify(render(actual)) === JSON.stringify(render(expected))
}

function gitBlobId(bytes: Uint8Array): string {
  const header = encoder.encode(`blob ${bytes.byteLength}\0`)
  return createHash("sha1").update(header).update(bytes).digest("hex")
}

export function isWithin(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate)
  return (
    fromParent === "" ||
    (fromParent !== ".." &&
      !fromParent.startsWith(`..${sep}`) &&
      !isAbsolute(fromParent))
  )
}

async function verifyTrackedBytes(
  repositoryRoot: string,
  entries: readonly GitTreeEntry[],
): Promise<void> {
  for (const entry of entries) {
    const path = resolve(repositoryRoot, entry.path)
    if (!isWithin(repositoryRoot, path)) {
      throw new Error(`tracked fmx path escapes the repository: ${entry.path}`)
    }
    const facts = await lstat(path, { bigint: true }).catch((error: unknown) => {
      throw new Error(`tracked fmx input is missing: ${entry.path}`, {
        cause: error,
      })
    })
    let actual: Uint8Array
    if (entry.mode === "120000") {
      if (!facts.isSymbolicLink()) {
        throw new Error(`tracked fmx symlink changed type: ${entry.path}`)
      }
      actual = await readlink(path, { encoding: "buffer" })
      const after = await lstat(path, { bigint: true })
      if (
        !after.isSymbolicLink() ||
        after.dev !== facts.dev ||
        after.ino !== facts.ino ||
        after.size !== facts.size
      ) {
        throw new Error(`tracked fmx symlink changed while read: ${entry.path}`)
      }
    } else if (entry.mode === "100644" || entry.mode === "100755") {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile()) {
          throw new Error(`tracked fmx file changed type: ${entry.path}`)
        }
        const executable = (before.mode & 0o100n) !== 0n
        if (executable !== (entry.mode === "100755")) {
          throw new Error(
            `tracked fmx executable mode differs from HEAD: ${entry.path}`,
          )
        }
        actual = await handle.readFile()
        const after = await handle.stat({ bigint: true })
        const pathFacts = await lstat(path, { bigint: true })
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          BigInt(actual.byteLength) !== before.size ||
          pathFacts.isSymbolicLink() ||
          !pathFacts.isFile() ||
          pathFacts.dev !== before.dev ||
          pathFacts.ino !== before.ino
        ) {
          throw new Error(`tracked fmx file changed while read: ${entry.path}`)
        }
      } finally {
        await handle.close()
      }
    } else {
      throw new Error(`unsupported tracked mode ${entry.mode} for ${entry.path}`)
    }
    if (gitBlobId(actual) !== entry.objectId) {
      throw new Error(`tracked fmx bytes differ from HEAD: ${entry.path}`)
    }
  }
}

function requireNormalIndexFlags(repositoryRoot: string): void {
  for (const mode of ["-v", "-f"] as const) {
    const records = nulRecords(
      gitBytes(repositoryRoot, ["ls-files", mode, "-z"]),
      "Git index flags",
    )
    for (const record of records) {
      const separator = record.indexOf(" ")
      const tag = separator === -1 ? "" : record.slice(0, separator)
      const path = separator === -1 ? record : record.slice(separator + 1)
      if (tag !== "H") {
        throw new Error(
          `tracked fmx input has a hidden or nonordinary index flag (${tag || "unknown"}): ${path}`,
        )
      }
    }
  }
}

function requirePorcelainClean(repositoryRoot: string): void {
  const status = gitBytes(repositoryRoot, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ])
  if (status.byteLength !== 0) {
    const rendered = decoder.decode(status).replaceAll("\0", "\n").trim()
    throw new Error(`fmx integration Worktree is not clean:\n${rendered}`)
  }
}

async function requireRepositoryRoot(repositoryRoot: string): Promise<string> {
  const physicalRoot = await realpath(repositoryRoot)
  const topLevel = gitText(physicalRoot, ["rev-parse", "--show-toplevel"])
  const physicalTopLevel = await realpath(topLevel)
  if (physicalTopLevel !== physicalRoot) {
    throw new Error(`fmx provider generation must use the Git top level: ${physicalTopLevel}`)
  }
  return physicalRoot
}

async function repositoryTopology(repositoryRoot: string): Promise<{
  readonly commonGitDirectory: string
  readonly worktrees: readonly string[]
}> {
  const commonGit = gitText(repositoryRoot, ["rev-parse", "--git-common-dir"])
  const commonGitDirectory = await realpath(resolve(repositoryRoot, commonGit))
  const records = nulRecords(
    gitBytes(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]),
    "Git Worktree inventory",
  )
  const worktrees: string[] = []
  for (const record of records) {
    if (!record.startsWith("worktree ")) continue
    const path = resolve(record.slice("worktree ".length))
    worktrees.push(await realpath(path).catch(() => path))
  }
  if (worktrees.length === 0) {
    throw new Error("Git reported no registered fmx Worktrees")
  }
  return {
    commonGitDirectory,
    worktrees: [...new Set(worktrees)].sort(),
  }
}

export async function captureCleanRepositorySnapshot(
  repositoryRoot: string,
): Promise<RepositorySnapshot> {
  const physicalRoot = await requireRepositoryRoot(repositoryRoot)
  const headSha = gitText(physicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"])
  const headTree = gitText(physicalRoot, ["rev-parse", "--verify", "HEAD^{tree}"])
  if (!COMMIT_PATTERN.test(headSha) || !TREE_PATTERN.test(headTree)) {
    throw new Error("fmx HEAD is not a full SHA-1 commit and tree identity")
  }

  requireNormalIndexFlags(physicalRoot)
  requirePorcelainClean(physicalRoot)
  const treeEntries = parseTreeEntries(physicalRoot, headSha)
  const indexEntries = parseIndexEntries(physicalRoot)
  if (!entriesMatch(indexEntries, treeEntries)) {
    throw new Error("fmx index does not exactly match HEAD")
  }
  await verifyTrackedBytes(physicalRoot, treeEntries)

  const finalHeadSha = gitText(physicalRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ])
  const finalHeadTree = gitText(physicalRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{tree}",
  ])
  requireNormalIndexFlags(physicalRoot)
  requirePorcelainClean(physicalRoot)
  if (finalHeadSha !== headSha || finalHeadTree !== headTree) {
    throw new Error("fmx HEAD changed while its tracked inputs were verified")
  }
  const topology = await repositoryTopology(physicalRoot)
  return {
    ...topology,
    headSha,
    headTree,
    repositoryRoot: physicalRoot,
    trackedEntryCount: treeEntries.length,
  }
}

export async function assertRepositorySnapshotStable(
  repositoryRoot: string,
  expected: RepositorySnapshot,
): Promise<void> {
  const actual = await captureCleanRepositorySnapshot(repositoryRoot)
  if (
    actual.headSha !== expected.headSha ||
    actual.headTree !== expected.headTree ||
    actual.trackedEntryCount !== expected.trackedEntryCount ||
    actual.commonGitDirectory !== expected.commonGitDirectory ||
    JSON.stringify(actual.worktrees) !== JSON.stringify(expected.worktrees)
  ) {
    throw new Error("fmx committed inputs or registered Worktrees changed during provider generation")
  }
}

function runGit(repositoryRoot: string, args: readonly string[]): void {
  gitBytes(repositoryRoot, args)
}

export async function materializeRepositorySnapshot(
  snapshot: RepositorySnapshot,
  destination: string,
): Promise<RepositorySnapshot> {
  await mkdir(destination, { mode: 0o700 })
  runGit(destination, ["init", "--quiet"])
  runGit(destination, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--depth=1",
    snapshot.commonGitDirectory,
    snapshot.headSha,
  ])
  runGit(destination, ["checkout", "--quiet", "--detach", "FETCH_HEAD"])
  const materialized = await captureCleanRepositorySnapshot(destination)
  if (
    materialized.headSha !== snapshot.headSha ||
    materialized.headTree !== snapshot.headTree ||
    materialized.trackedEntryCount !== snapshot.trackedEntryCount
  ) {
    throw new Error("private fmx materialization does not match the owning HEAD")
  }
  return materialized
}
