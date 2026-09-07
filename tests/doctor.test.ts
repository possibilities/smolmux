import { expect, test } from "bun:test"
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { apiSocketPathFor } from "../src/api-server.ts"
import { VERSION } from "../src/cli.ts"
import { doctor } from "../src/doctor.ts"
import { resolveInstance } from "../src/instance.ts"
import { COMPANION_PIN } from "../src/zmx-environment.ts"
import { PROTOCOL_VERSION } from "../src/zmx-protocol.ts"

/** A Companion that answers `version` with whatever build it is told to claim. */
async function fakeCompanion(directory: string, build: string): Promise<string> {
  const path = join(directory, "smolmux-zmx")
  await writeFile(
    path,
    `#!/bin/sh\n[ "$1" = version ] || exit 2\nprintf 'zmx\\t\\t%s\\nsocket_dir\\t%s\\n' '${build}' "$ZMX_DIR"\n`,
  )
  await chmod(path, 0o755)
  return path
}

/** A report row by label, without depending on the column width. */
const row = (report: { lines: string[] }, label: string): string => {
  const line = report.lines.find((candidate) => candidate.startsWith(`${label} `) || candidate === label)
  return line ? line.slice(label.length).trim() : ""
}

test("doctor reports the pinned pair and the Instance it would start", async () => {
  const root = await realpath(await mkdtemp("/tmp/smolmux-doctor-"))
  try {
    const companion = await fakeCompanion(root, COMPANION_PIN.build)
    const directory = join(root, "zmx")
    const env = { SMOLMUX_LOCAL_PTY_PATH: companion, PATH: root, SMOLMUX_ZMX_DIR: directory, XDG_CONFIG_HOME: join(root, "config") }

    const report = await doctor(env)
    expect(report.ok).toBe(true)
    expect(row(report, "smolmux")).toBe(VERSION)
    expect(row(report, "companion")).toBe(`${companion} (on PATH)`)
    expect(row(report, "directory")).toBe(`${directory} (private)`)
    expect(row(report, "build")).toBe(`${COMPANION_PIN.build} (the build pinned by this smolmux checkout)`)
    expect(row(report, "protocol")).toBe(`${PROTOCOL_VERSION}`)

    const instance = resolveInstance(null, env)
    expect(row(report, "instance")).toBe(`default · ${instance.id}`)
    expect(row(report, "api")).toBe(`${apiSocketPathFor(instance.id)}`)
    expect(row(report, "config")).toBe(`${instance.configPath}`)
    // The Companion build still defaults to the fork's directory, so reaching
    // a session by hand needs smolmux's named.
    expect(row(report, "by hand")).toBe(`ZMX_DIR=${directory} ${companion} list`)

    const named = resolveInstance("review", env)
    const namedReport = await doctor(env, named)
    expect(namedReport.ok).toBe(true)
    expect(row(namedReport, "instance")).toBe(`review · ${named.id}`)
    expect(row(namedReport, "api")).toBe(`${apiSocketPathFor(named.id)}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("doctor never mentions an agent runtime it no longer installs", async () => {
  const root = await realpath(await mkdtemp("/tmp/smolmux-doctor-fx-"))
  try {
    await fakeCompanion(root, COMPANION_PIN.build)
    const report = await doctor({
      PATH: root,
      SMOLMUX_ZMX_DIR: join(root, "zmx"),
      XDG_CONFIG_HOME: join(root, "config"),
    })
    expect(report.lines.some((line) => line.startsWith("fx "))).toBe(false)
    expect(report.lines.join("\n")).not.toContain("fxnk")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a Companion that is not the pinned build fails the report unless it is the override", async () => {
  const root = await realpath(await mkdtemp("/tmp/smolmux-doctor-pin-"))
  try {
    const companion = await fakeCompanion(root, "0.0.0+smolmux.deadbeefcafe")
    const shared = { SMOLMUX_LOCAL_PTY_PATH: companion, SMOLMUX_ZMX_DIR: join(root, "zmx"), XDG_CONFIG_HOME: join(root, "config") }

    const onPath = await doctor({ ...shared, PATH: root })
    expect(onPath.ok).toBe(false)
    expect(onPath.lines.join("\n")).toContain("Reinstall smolmux to restore the pair")

    const overridden = await doctor({ ...shared, PATH: root, SMOLMUX_ZMX_PATH: companion })
    expect(overridden.ok).toBe(true)
    expect(overridden.lines.join("\n")).toContain("running under the override")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a missing Companion is a failure that names what to do", async () => {
  const root = await realpath(await mkdtemp("/tmp/smolmux-doctor-missing-"))
  try {
    const report = await doctor({
      PATH: root,
      SMOLMUX_ZMX_DIR: join(root, "zmx"),
      XDG_CONFIG_HOME: join(root, "config"),
    })
    expect(report.ok).toBe(false)
    expect(report.lines.join("\n")).toContain("no smolmux-zmx on PATH")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
