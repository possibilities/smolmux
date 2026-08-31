import { createHash } from "node:crypto"
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, relative, sep } from "node:path"
import {
  canonicalProviderJson,
  FMX_EXPECTED_SKIPS,
} from "../scripts/generate-agentworkplace-provider.ts"
import type { JsonValue } from "../src/contract-codec.ts"

const REPOSITORY_ROOT = join(import.meta.dir, "..")
const RUNTIME_REGISTRATION_DIGEST =
  "sha256:92a3e113ef3a4fa032da8679eb2631c4f4f8b07ec689a7d260aee92af12733e6"
const temporaryRoots: string[] = []
const decoder = new TextDecoder()

setDefaultTimeout(30_000)

interface CliFixture {
  readonly agentWorkplaceManifest: string
  readonly repository: string
  readonly root: string
  readonly skipFile: string
}

interface CliSummary {
  readonly accepted: boolean
  readonly actual_skip_count: number
  readonly consumed_agentworkplace_manifest_digest: string
  readonly expected_skip_count: number
  readonly gate_exit_status: number
  readonly gate_log: string
  readonly gate_log_digest: string
  readonly generation_evidence: string
  readonly generation_evidence_digest: string
  readonly manifest: string
  readonly manifest_digest: string
  readonly output_inventory_count: number
  readonly repository_sha: string
  readonly repository_tree: string
}

interface ProviderManifestShape {
  readonly commands: readonly [{ readonly exit_status: number }]
  readonly contracts: readonly {
    readonly artifacts: readonly [{ readonly digest: string; readonly path: string }]
    readonly id: string
    readonly kind: string
  }[]
  readonly repository: { readonly sha: string }
  readonly skips: {
    readonly actual: readonly unknown[]
    readonly expected: readonly unknown[]
  }
}

interface GenerationEvidenceShape {
  readonly accepted: boolean
  readonly agentworkplace_input: { readonly manifest_digest: string }
  readonly command: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly exit_status: number
    readonly log: FileEvidence
  }
  readonly generator: { readonly path: string; readonly sha256: string }
  readonly output: { readonly payload_inventory: readonly FileEvidence[] }
  readonly provider_manifest_contract: string
  readonly repository: {
    readonly head_sha: string
    readonly head_tree: string
    readonly source_materialization: { readonly cwd: string; readonly method: string }
  }
  readonly schema_id: string
  readonly skips: {
    readonly actual_count: number
    readonly expected_count: number
    readonly match: boolean
  }
}

interface FileEvidence {
  readonly bytes: number
  readonly digest: string
  readonly path: string
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

function gitBytes(repository: string, args: readonly string[]): Uint8Array {
  const result = Bun.spawnSync({
    cmd: ["git", "--no-replace-objects", ...args],
    cwd: repository,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
    stderr: "pipe",
    stdout: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(decoder.decode(result.stderr))
  }
  return result.stdout
}

function git(repository: string, args: readonly string[]): string {
  return decoder.decode(gitBytes(repository, args)).trim()
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

async function createFixture(): Promise<CliFixture> {
  const root = await mkdtemp(join(tmpdir(), "fmx-provider-cli-test-"))
  temporaryRoots.push(root)
  const repository = join(root, "repository")
  await cp(REPOSITORY_ROOT, repository, {
    filter: (source) => {
      const path = relative(REPOSITORY_ROOT, source)
      if (path.length === 0) return true
      const first = path.split(sep)[0]
      return first !== ".git" && first !== "node_modules" && first !== "dist"
    },
    recursive: true,
  })
  const gate = join(repository, "scripts/local-gate.sh")
  await writeFile(
    gate,
    `#!/bin/sh
set -eu
printf 'fixture gate head %s\n' "$(git rev-parse --verify HEAD)"
printf 'fixture gate tree %s\n' "$(git rev-parse --verify 'HEAD^{tree}')"
if [ -n "\${FMX_PROVIDER_TEST_READY:-}" ]; then
  : > "$FMX_PROVIDER_TEST_READY"
  attempts=0
  while [ ! -e "$FMX_PROVIDER_TEST_RELEASE" ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 500 ]; then
      printf 'fixture gate timed out waiting for release\n' >&2
      exit 98
    fi
    sleep 0.01
  done
fi
while IFS= read -r description; do
  printf '(skip) %s\n' "$description"
done < "$FMX_PROVIDER_TEST_SKIP_FILE"
printf 'fixture gate complete\n'
exit "\${FMX_PROVIDER_TEST_GATE_STATUS:-0}"
`,
  )
  await chmod(gate, 0o755)
  git(repository, ["init", "--quiet", "--initial-branch=main"])
  git(repository, ["config", "user.email", "phase0@example.invalid"])
  git(repository, ["config", "user.name", "Phase 0 Provider Test"])
  await symlink(join(REPOSITORY_ROOT, "node_modules"), join(repository, "node_modules"))
  git(repository, ["add", "--all"])
  git(repository, ["commit", "--quiet", "-m", "provider CLI fixture"])
  expect(git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("")

  const agentWorkplaceManifest = join(root, "phase0-owned-manifest.json")
  await writeFile(
    agentWorkplaceManifest,
    canonicalProviderJson({
      contracts: [
        {
          digest: RUNTIME_REGISTRATION_DIGEST,
          id: "agentworkplace.runtime-extension-registration",
          version: "1",
        },
      ],
      schema_version: 1,
    }),
  )
  const skipFile = join(root, "skips.txt")
  await writeFile(
    skipFile,
    `${FMX_EXPECTED_SKIPS.map(({ description }) => description).join("\n")}\n`,
  )
  return { agentWorkplaceManifest, repository, root, skipFile }
}

function startGenerator(
  fixture: CliFixture,
  output: string,
  environment: Readonly<Record<string, string>> = {},
) {
  const env = { ...process.env }
  delete env.FMX_PROVIDER_TEST_GATE_STATUS
  delete env.FMX_PROVIDER_TEST_READY
  delete env.FMX_PROVIDER_TEST_RELEASE
  delete env.FMX_PROVIDER_TEST_SKIP_FILE
  Object.assign(env, environment, {
    FMX_PROVIDER_TEST_SKIP_FILE: fixture.skipFile,
  })
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "scripts/generate-agentworkplace-provider.ts",
      "--output",
      output,
      "--agentworkplace-manifest",
      fixture.agentWorkplaceManifest,
    ],
    cwd: fixture.repository,
    env,
    stderr: "pipe",
    stdout: "pipe",
  })
  return {
    child,
    stderr: new Response(child.stderr).text(),
    stdout: new Response(child.stdout).text(),
  }
}

async function runGenerator(
  fixture: CliFixture,
  output: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<{ readonly exitStatus: number; readonly stderr: string; readonly stdout: string }> {
  const running = startGenerator(fixture, output, environment)
  const [exitStatus, stderr, stdout] = await Promise.all([
    running.child.exited,
    running.stderr,
    running.stdout,
  ])
  return { exitStatus, stderr, stdout }
}

function summaryFrom(stdout: string): CliSummary {
  const line = stdout.trimEnd().split("\n").at(-1)
  if (line === undefined) throw new Error("provider CLI produced no summary")
  return JSON.parse(line) as CliSummary
}

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await lstat(path).then(() => true).catch(() => false)) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function inventory(root: string, at = ""): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(join(root, at), { withFileTypes: true })) {
    const path = at.length === 0 ? entry.name : join(at, entry.name)
    if (entry.isDirectory()) found.push(...(await inventory(root, path)))
    else found.push(path)
  }
  return found.sort()
}

describe("AgentWorkplace provider generator CLI", () => {
  test("binds a real successful gate to the exact committed source and retained output", async () => {
    const fixture = await createFixture()
    const unreplacedHead = git(fixture.repository, ["rev-parse", "HEAD"])
    const replacementWorktree = join(fixture.root, "replacement-worktree")
    git(fixture.repository, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      replacementWorktree,
    ])
    await writeFile(join(replacementWorktree, "README.md"), "replacement tree\n")
    git(replacementWorktree, ["add", "README.md"])
    git(replacementWorktree, ["commit", "--quiet", "-m", "replacement commit"])
    git(fixture.repository, [
      "replace",
      unreplacedHead,
      git(replacementWorktree, ["rev-parse", "HEAD"]),
    ])
    const output = join(fixture.root, "provider-output")
    await mkdir(output)
    const outputIdentity = await lstat(output)
    const result = await runGenerator(fixture, output, {
      GIT_DIR: join(fixture.root, "poisoned-git-dir"),
      GIT_WORK_TREE: join(fixture.root, "poisoned-work-tree"),
    })
    expect(result.exitStatus).toBe(0)
    expect(result.stderr).toBe("")
    const summary = summaryFrom(result.stdout)
    const head = git(fixture.repository, ["rev-parse", "HEAD"])
    const tree = git(fixture.repository, ["rev-parse", "HEAD^{tree}"])
    expect(summary).toMatchObject({
      accepted: true,
      actual_skip_count: 18,
      expected_skip_count: 18,
      gate_exit_status: 0,
      output_inventory_count: 7,
      repository_sha: head,
      repository_tree: tree,
    })
    expect(head).toBe(unreplacedHead)
    expect(await inventory(output)).toEqual([
      "artifacts/agent-defaults.jsonl",
      "artifacts/ensure-lifecycle.jsonl",
      "artifacts/fx-launch-admission-final.jsonl",
      "artifacts/runtime-extension.jsonl",
      "generation-evidence.json",
      "local-gate.log",
      "phase0-provider.json",
    ])
    const finalOutputIdentity = await lstat(output)
    expect(finalOutputIdentity.dev).toBe(outputIdentity.dev)
    expect(finalOutputIdentity.ino).toBe(outputIdentity.ino)
    expect(finalOutputIdentity.mode & 0o777).toBe(outputIdentity.mode & 0o777)
    expect((await stat(join(output, "artifacts"))).mode & 0o777).toBe(0o700)
    for (const path of await inventory(output)) {
      expect((await stat(join(output, path))).mode & 0o777).toBe(0o600)
    }

    const manifestBytes = await readFile(summary.manifest)
    expect(sha256(manifestBytes)).toBe(summary.manifest_digest)
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as ProviderManifestShape
    expect(manifest.repository.sha).toBe(head)
    expect(manifest.commands[0].exit_status).toBe(0)
    expect(manifest.skips.actual).toHaveLength(18)
    expect(manifest.skips.actual).toEqual(manifest.skips.expected)
    expect(manifest.contracts.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "fmx.runtime-extension-protocol", kind: "protocol" },
      { id: "fmx.agent-defaults", kind: "schema" },
      { id: "fmx.ensure-lifecycle", kind: "protocol" },
      { id: "fmx.fx-launch-admission", kind: "protocol" },
    ])
    for (const contract of manifest.contracts) {
      const artifact = contract.artifacts[0]
      const source = join(
        fixture.repository,
        "contracts/agentworkplace/v1",
        artifact.path.slice("artifacts/".length),
      )
      expect(await readFile(join(output, artifact.path))).toEqual(await readFile(source))
      expect(sha256(await readFile(join(output, artifact.path)))).toBe(artifact.digest)
    }

    const gateLog = await readFile(summary.gate_log)
    expect(sha256(gateLog)).toBe(summary.gate_log_digest)
    expect(gateLog.toString("utf8")).toContain(`fixture gate head ${head}`)
    expect(gateLog.toString("utf8")).toContain(`fixture gate tree ${tree}`)
    const evidenceBytes = await readFile(summary.generation_evidence)
    expect(sha256(evidenceBytes)).toBe(summary.generation_evidence_digest)
    const evidence = JSON.parse(
      evidenceBytes.toString("utf8"),
    ) as GenerationEvidenceShape
    expect(canonicalProviderJson(evidence as unknown as JsonValue)).toBe(
      evidenceBytes.toString("utf8"),
    )
    expect(evidence).toMatchObject({
      accepted: true,
      command: { argv: ["./scripts/local-gate.sh"], exit_status: 0 },
      provider_manifest_contract: "AgentWorkplace provider-manifest v1 (unchanged)",
      repository: { head_sha: head, head_tree: tree },
      schema_id: "fmx.phase0-provider-generation-evidence",
      skips: { actual_count: 18, expected_count: 18, match: true },
    })
    expect(evidence.command.cwd).toBe(evidence.repository.source_materialization.cwd)
    expect(basename(evidence.command.cwd)).toBe("fmx")
    expect(evidence.repository.source_materialization.method).toContain("exact commit")
    expect(await lstat(evidence.command.cwd).then(() => true).catch(() => false)).toBe(false)
    expect(evidence.command.log.digest).toBe(summary.gate_log_digest)
    expect(evidence.agentworkplace_input.manifest_digest).toBe(
      summary.consumed_agentworkplace_manifest_digest,
    )
    const generatorBytes = gitBytes(fixture.repository, [
      "show",
      `${head}:${evidence.generator.path}`,
    ])
    expect(evidence.generator.sha256).toBe(sha256(generatorBytes))
    for (const record of evidence.output.payload_inventory) {
      const bytes = await readFile(join(output, record.path))
      expect(bytes.byteLength).toBe(record.bytes)
      expect(sha256(bytes)).toBe(record.digest)
    }
  })

  test("retains an attributable failed gate instead of reporting success", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    await mkdir(output)
    const result = await runGenerator(fixture, output, {
      FMX_PROVIDER_TEST_GATE_STATUS: "9",
    })
    expect(result.exitStatus).toBe(1)
    expect(result.stderr).toBe("")
    const summary = summaryFrom(result.stdout)
    expect(summary.accepted).toBe(false)
    expect(summary.gate_exit_status).toBe(9)
    const manifest = JSON.parse(
      await readFile(summary.manifest, "utf8"),
    ) as ProviderManifestShape
    expect(manifest.commands[0].exit_status).toBe(9)
    expect(manifest.skips.actual).toEqual(manifest.skips.expected)
    const evidence = JSON.parse(
      await readFile(summary.generation_evidence, "utf8"),
    ) as GenerationEvidenceShape
    expect(evidence.accepted).toBe(false)
    expect(evidence.command.exit_status).toBe(9)
    expect(sha256(await readFile(summary.gate_log))).toBe(summary.gate_log_digest)
  })

  test("refuses output populated while the long gate runs and publishes nothing", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    const ready = join(fixture.root, "gate-ready")
    const release = join(fixture.root, "gate-release")
    await mkdir(output)
    const running = startGenerator(fixture, output, {
      FMX_PROVIDER_TEST_READY: ready,
      FMX_PROVIDER_TEST_RELEASE: release,
    })
    await waitFor(ready)
    await writeFile(join(output, "intruder"), "not provider output\n")
    await writeFile(release, "continue\n")
    const [exitStatus, stderr] = await Promise.all([
      running.child.exited,
      running.stderr,
      running.stdout,
    ]).then(([status, error]) => [status, error] as const)
    expect(exitStatus).toBe(1)
    expect(stderr).toContain("stopped being empty")
    expect(await inventory(output)).toEqual(["intruder"])
    expect(
      (await readdir(fixture.root)).filter((name) =>
        name.startsWith(".fmx-phase0-provider-stage-"),
      ),
    ).toEqual([])
  })

  test("refuses an output identity replaced by a symlink during the gate", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    const replacement = join(fixture.root, "replacement")
    const ready = join(fixture.root, "gate-ready")
    const release = join(fixture.root, "gate-release")
    await mkdir(output)
    await mkdir(replacement)
    const running = startGenerator(fixture, output, {
      FMX_PROVIDER_TEST_READY: ready,
      FMX_PROVIDER_TEST_RELEASE: release,
    })
    await waitFor(ready)
    await rm(output, { recursive: true })
    await symlink(replacement, output, "dir")
    await writeFile(release, "continue\n")
    const [exitStatus, stderr] = await Promise.all([
      running.child.exited,
      running.stderr,
      running.stdout,
    ]).then(([status, error]) => [status, error] as const)
    expect(exitStatus).toBe(1)
    expect(stderr).toContain("identity changed")
    expect(await readdir(replacement)).toEqual([])
  })

  test("refuses a committed source race while the exact gate runs", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    const ready = join(fixture.root, "gate-ready")
    const release = join(fixture.root, "gate-release")
    await mkdir(output)
    const running = startGenerator(fixture, output, {
      FMX_PROVIDER_TEST_READY: ready,
      FMX_PROVIDER_TEST_RELEASE: release,
    })
    await waitFor(ready)
    await writeFile(join(fixture.repository, "README.md"), "new committed source\n")
    git(fixture.repository, ["add", "README.md"])
    git(fixture.repository, ["commit", "--quiet", "-m", "race source"])
    await writeFile(release, "continue\n")
    const [exitStatus, stderr] = await Promise.all([
      running.child.exited,
      running.stderr,
      running.stdout,
    ]).then(([status, error]) => [status, error] as const)
    expect(exitStatus).toBe(1)
    expect(stderr).toContain("changed during provider generation")
    expect(await readdir(output)).toEqual([])
  })

  for (const flag of [
    "--assume-unchanged",
    "--skip-worktree",
    "--fsmonitor-valid",
  ] as const) {
    test(`refuses the hidden Git index flag ${flag}`, async () => {
      const fixture = await createFixture()
      const output = join(fixture.root, "provider-output")
      await mkdir(output)
      if (flag === "--fsmonitor-valid") {
        git(fixture.repository, ["config", "core.fsmonitor", "true"])
        git(fixture.repository, ["update-index", "--fsmonitor"])
      }
      git(fixture.repository, ["update-index", flag, "README.md"])
      const environment: Record<string, string> = {}
      if (flag === "--assume-unchanged") {
        await writeFile(join(fixture.repository, "README.md"), "hidden bytes\n")
        expect(git(fixture.repository, ["status", "--porcelain=v1"])).toBe("")
      } else if (flag === "--skip-worktree") {
        const alternateIndex = join(fixture.root, "clean-alternate-index")
        const cleanEnvironment = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        )
        const populated = Bun.spawnSync({
          cmd: ["git", "--no-replace-objects", "read-tree", "HEAD"],
          cwd: fixture.repository,
          env: { ...cleanEnvironment, GIT_INDEX_FILE: alternateIndex },
          stderr: "pipe",
          stdout: "pipe",
        })
        expect(populated.exitCode).toBe(0)
        environment.GIT_INDEX_FILE = alternateIndex
      } else {
        expect(
          decoder
            .decode(gitBytes(fixture.repository, ["ls-files", "-f", "-z"]))
            .split("\0"),
        ).toContain("h README.md")
      }
      const result = await runGenerator(fixture, output, environment)
      expect(result.exitStatus).toBe(1)
      expect(result.stderr).toContain("hidden or nonordinary index flag")
      expect(await readdir(output)).toEqual([])
    })
  }

  test("ignores ambient global and system Git configuration", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    const poisonedHome = join(fixture.root, "poisoned-home")
    const poisonedXdg = join(fixture.root, "poisoned-xdg")
    const globalExcludes = join(fixture.root, "global-excludes")
    const globalConfig = join(poisonedHome, ".gitconfig")
    const xdgGlobalConfig = join(poisonedXdg, "git/config")
    await mkdir(output)
    await mkdir(poisonedHome)
    await mkdir(join(poisonedXdg, "git"), { recursive: true })
    await writeFile(globalExcludes, "ambient-hidden\n")
    const poisonedConfig = `[core]\n\texcludesFile = ${globalExcludes}\n`
    await writeFile(globalConfig, poisonedConfig)
    await writeFile(xdgGlobalConfig, poisonedConfig)
    await writeFile(
      join(fixture.repository, "ambient-hidden"),
      "must remain visible to provider inspection\n",
    )

    const ambientEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    )
    const poisonedStatus = Bun.spawnSync({
      cmd: [
        "git",
        "--no-replace-objects",
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ],
      cwd: fixture.repository,
      env: {
        ...ambientEnvironment,
        HOME: poisonedHome,
        XDG_CONFIG_HOME: poisonedXdg,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(poisonedStatus.exitCode).toBe(0)
    expect(poisonedStatus.stdout.byteLength).toBe(0)

    const result = await runGenerator(fixture, output, {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_SYSTEM: globalConfig,
      HOME: poisonedHome,
      XDG_CONFIG_HOME: poisonedXdg,
    })
    expect(result.exitStatus).toBe(1)
    expect(result.stderr).toContain("integration Worktree is not clean")
    expect(result.stderr).toContain("ambient-hidden")
    expect(await readdir(output)).toEqual([])
  })

  test("overrides Git's default XDG excludes file", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    const poisonedHome = join(fixture.root, "poisoned-home")
    const poisonedXdg = join(fixture.root, "poisoned-xdg")
    await mkdir(output)
    await mkdir(poisonedHome)
    await mkdir(join(poisonedXdg, "git"), { recursive: true })
    await writeFile(join(poisonedXdg, "git/ignore"), "ambient-hidden\n")
    await writeFile(
      join(fixture.repository, "ambient-hidden"),
      "the default XDG ignore must not hide this input\n",
    )

    const ambientEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    )
    const poisonedStatus = Bun.spawnSync({
      cmd: ["git", "status", "--porcelain=v2", "--untracked-files=all"],
      cwd: fixture.repository,
      env: {
        ...ambientEnvironment,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        HOME: poisonedHome,
        XDG_CONFIG_HOME: poisonedXdg,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(poisonedStatus.exitCode).toBe(0)
    expect(poisonedStatus.stdout.byteLength).toBe(0)

    const result = await runGenerator(fixture, output, {
      HOME: poisonedHome,
      XDG_CONFIG_HOME: poisonedXdg,
    })
    expect(result.exitStatus).toBe(1)
    expect(result.stderr).toContain("integration Worktree is not clean")
    expect(result.stderr).toContain("ambient-hidden")
    expect(await readdir(output)).toEqual([])
  })

  test("overrides Git's default XDG attributes file", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    const poisonedXdg = join(fixture.root, "poisoned-xdg")
    const poisonedCheckout = join(fixture.root, "poisoned-checkout")
    await mkdir(output)
    await mkdir(join(poisonedXdg, "git"), { recursive: true })
    await writeFile(join(poisonedXdg, "git/attributes"), "* text eol=crlf\n")

    const ambientEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    )
    const poisonedClone = Bun.spawnSync({
      cmd: [
        "git",
        "clone",
        "--quiet",
        "--no-local",
        fixture.repository,
        poisonedCheckout,
      ],
      env: {
        ...ambientEnvironment,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        XDG_CONFIG_HOME: poisonedXdg,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(poisonedClone.exitCode).toBe(0)
    expect(await readFile(join(poisonedCheckout, "README.md"), "utf8")).toContain(
      "\r\n",
    )

    const result = await runGenerator(fixture, output, {
      XDG_CONFIG_HOME: poisonedXdg,
    })
    expect(result.exitStatus).toBe(0)
    expect(summaryFrom(result.stdout).accepted).toBe(true)
  })

  test("uses Git owner-execute semantics despite core.fileMode=false", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    const gate = join(fixture.repository, "scripts/local-gate.sh")
    await mkdir(output)
    git(fixture.repository, ["config", "core.fileMode", "false"])
    await chmod(gate, 0o455)
    expect(git(fixture.repository, ["status", "--porcelain=v1"])).toBe("")

    const result = await runGenerator(fixture, output)
    expect(result.exitStatus).toBe(1)
    expect(result.stderr).toContain(
      "tracked fmx executable mode differs from HEAD: scripts/local-gate.sh",
    )
    expect(await readdir(output)).toEqual([])
  })

  test("rejects the common Git directory and every registered Worktree", async () => {
    const fixture = await createFixture()
    const commonGitOutput = join(fixture.repository, ".git", "provider-output")
    await mkdir(commonGitOutput)
    const commonResult = await runGenerator(fixture, commonGitOutput)
    expect(commonResult.exitStatus).toBe(1)
    expect(commonResult.stderr).toContain("common Git directory")

    const otherWorktree = join(fixture.root, "other-worktree")
    git(fixture.repository, ["worktree", "add", "--quiet", "--detach", otherWorktree])
    const worktreeOutput = join(otherWorktree, "provider-output")
    await mkdir(worktreeOutput)
    const worktreeResult = await runGenerator(fixture, worktreeOutput)
    expect(worktreeResult.exitStatus).toBe(1)
    expect(worktreeResult.stderr).toContain("every registered fmx Worktree")
  })

  test("refuses a registered-Worktree topology race while the gate runs", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    const ready = join(fixture.root, "gate-ready")
    const release = join(fixture.root, "gate-release")
    await mkdir(output)
    const running = startGenerator(fixture, output, {
      FMX_PROVIDER_TEST_READY: ready,
      FMX_PROVIDER_TEST_RELEASE: release,
    })
    await waitFor(ready)
    git(fixture.repository, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      join(fixture.root, "racing-worktree"),
    ])
    await writeFile(release, "continue\n")
    const [exitStatus, stderr] = await Promise.all([
      running.child.exited,
      running.stderr,
      running.stdout,
    ]).then(([status, error]) => [status, error] as const)
    expect(exitStatus).toBe(1)
    expect(stderr).toContain("registered Worktrees changed")
    expect(await readdir(output)).toEqual([])
  })

  test("does not fabricate a gate status when the command cannot start", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    await mkdir(output)
    await chmod(join(fixture.repository, "scripts/local-gate.sh"), 0o644)
    git(fixture.repository, ["add", "scripts/local-gate.sh"])
    git(fixture.repository, ["commit", "--quiet", "-m", "make gate nonexecutable"])
    const result = await runGenerator(fixture, output)
    expect(result.exitStatus).toBe(1)
    expect(result.stderr).toContain("could not start local gate")
    expect(result.stdout).not.toContain('"gate_exit_status"')
    expect(await readdir(output)).toEqual([])
  })

  test("restores a private Bun link whose gate entrypoints became dangling", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    const isolatedHome = join(fixture.root, "home")
    const isolatedBunInstall = join(isolatedHome, ".bun")
    const isolatedPath = `${isolatedBunInstall}/bin:${process.env.PATH ?? ""}`
    await mkdir(output)
    await mkdir(join(isolatedBunInstall, "bin"), { recursive: true })
    await mkdir(join(isolatedBunInstall, "install/global"), { recursive: true })
    await writeFile(
      join(isolatedBunInstall, "install/global/package.json"),
      "{}\n",
    )
    await symlink(
      "../install/global/node_modules/fmx/src/index.ts",
      join(isolatedBunInstall, "bin/fmx"),
    )
    await symlink(
      "../install/global/node_modules/fmx/src/mcp.ts",
      join(isolatedBunInstall, "bin/fmx-mcp"),
    )
    await writeFile(
      join(fixture.repository, "scripts/local-gate.sh"),
      `#!/bin/sh
set -eu
bun link >/dev/null
ln -sfn "$PWD" "$BUN_INSTALL/install/global/node_modules/fmx"
rm src/index.ts src/mcp.ts
printf 'gate deliberately removed linked entrypoints\n'
exit 9
`,
    )
    git(fixture.repository, ["add", "scripts/local-gate.sh"])
    git(fixture.repository, [
      "commit",
      "--quiet",
      "-m",
      "dangling Bun link gate fixture",
    ])

    const result = await runGenerator(fixture, output, {
      BUN_INSTALL: isolatedBunInstall,
      HOME: isolatedHome,
      PATH: isolatedPath,
    })
    expect(result.exitStatus).toBe(1)
    expect(result.stderr).toContain("integration Worktree is not clean")
    expect(result.stderr).toContain("src/index.ts")
    expect(result.stderr).toContain("src/mcp.ts")
    expect(await readdir(output)).toEqual([])
    const binResult = Bun.spawnSync({
      cmd: ["bun", "pm", "bin", "-g"],
      cwd: fixture.repository,
      env: {
        ...process.env,
        BUN_INSTALL: isolatedBunInstall,
        HOME: isolatedHome,
        PATH: isolatedPath,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(binResult.exitCode).toBe(0)
    const globalBin = decoder.decode(binResult.stdout).trim()
    const physicalRepository = await realpath(fixture.repository)
    expect(await realpath(join(globalBin, "fmx"))).toBe(
      join(physicalRepository, "src/index.ts"),
    )
    expect(await realpath(join(globalBin, "fmx-mcp"))).toBe(
      join(physicalRepository, "src/mcp.ts"),
    )
  })

  test("preserves the primary failure and still removes private source after restoration fails", async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, "provider-output")
    const isolatedHome = join(fixture.root, "home")
    const isolatedBunInstall = join(isolatedHome, ".bun")
    const fakeBin = join(fixture.root, "fake-bin")
    const privateTmp = join(fixture.root, "tmp")
    await mkdir(output)
    await mkdir(fakeBin)
    await mkdir(privateTmp)
    await mkdir(join(isolatedBunInstall, "bin"), { recursive: true })
    await mkdir(join(isolatedBunInstall, "install/global/node_modules"), {
      recursive: true,
    })
    await writeFile(
      join(isolatedBunInstall, "install/global/package.json"),
      "{}\n",
    )
    await symlink(
      "../install/global/node_modules/fmx/src/index.ts",
      join(isolatedBunInstall, "bin/fmx"),
    )
    await symlink(
      "../install/global/node_modules/fmx/src/mcp.ts",
      join(isolatedBunInstall, "bin/fmx-mcp"),
    )
    const fakeBun = join(fakeBin, "bun")
    await writeFile(
      fakeBun,
      `#!/bin/sh
if [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then
  exec "$FMX_PROVIDER_TEST_REAL_BUN" "$@"
fi
if [ "$1" = "link" ]; then
  printf 'forced Bun link restoration failure\n' >&2
  exit 93
fi
exec "$FMX_PROVIDER_TEST_REAL_BUN" "$@"
`,
    )
    await chmod(fakeBun, 0o755)
    await writeFile(
      join(fixture.repository, "scripts/local-gate.sh"),
      `#!/bin/sh
set -eu
ln -sfn "$PWD" "$BUN_INSTALL/install/global/node_modules/fmx"
rm src/index.ts
printf 'gate deliberately dirtied its private source\n'
exit 9
`,
    )
    git(fixture.repository, ["add", "scripts/local-gate.sh"])
    git(fixture.repository, [
      "commit",
      "--quiet",
      "-m",
      "restoration failure cleanup fixture",
    ])

    const result = await runGenerator(fixture, output, {
      BUN_INSTALL: isolatedBunInstall,
      FMX_PROVIDER_TEST_REAL_BUN: process.execPath,
      HOME: isolatedHome,
      PATH: `${fakeBin}:${isolatedBunInstall}/bin:${process.env.PATH ?? ""}`,
      TMPDIR: privateTmp,
    })
    expect(result.exitStatus).toBe(1)
    expect(result.stderr).toContain(
      "provider generation failed: fmx integration Worktree is not clean",
    )
    expect(result.stderr).toContain("src/index.ts")
    expect(result.stderr).toContain("cleanup also failed")
    expect(result.stderr).toContain("forced Bun link restoration failure")
    expect(await readdir(output)).toEqual([])
    expect(
      (await readdir(privateTmp)).filter((name) =>
        name.startsWith("fmx-phase0-provider-source-"),
      ),
    ).toEqual([])
  })
})
