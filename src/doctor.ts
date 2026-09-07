import { resolveLocalHelper } from "./local-transport.ts"
import { apiSocketPathFor } from "./api-server.ts"
import { VERSION } from "./cli.ts"
import { type Instance, resolveInstance } from "./instance.ts"
import { PROTOCOL_VERSION } from "./zmx-protocol.ts"
import {
  COMPANION_PATH_ENV_VAR,
  COMPANION_PIN,
  companionBuild,
  companionDirectories,
  companionDirectory,
  companionMismatch,
  ensureCompanionDirectories,
  installedDirectory,
  resolveCompanion,
  type ResolvedCompanion,
} from "./zmx-environment.ts"

/**
 * `smolmux doctor`: what a start would find, reported instead of acted on. The
 * Companion is resolved the way a start resolves it and its build compared to
 * the pin; the directory is made private the way a start makes it. Nothing is
 * bound and nothing is adopted — a running smolmux is undisturbed.
 */
export type DoctorReport = {
  lines: string[]
  /**
   * False when the Companion is missing, unreadable, or not the pinned build,
   * or its directory is not smolmux's own. An overridden Companion build is still
   * reported rather than judged because a start deliberately runs it with a
   * word about it.
   */
  ok: boolean
}

export async function doctor(
  env: NodeJS.ProcessEnv = process.env,
  instance: Instance = resolveInstance(null, env),
  localOnly = false,
): Promise<DoctorReport> {
  const rows: [string, string][] = [["smolmux", VERSION]]
  let ok = true
  const fail = (label: string, text: string) => {
    ok = false
    rows.push([label, text])
  }

  try { rows.push(["local PTY", await resolveLocalHelper(env)]) }
  catch (error) { fail("local PTY", errorMessage(error)) }
  if (localOnly) {
    rows.push(["mode", "local-only foreground"], ["api", apiSocketPathFor(instance.id)])
    return { ok, lines: rows.map(([label, value]) => `${label}: ${value}`) }
  }
  let companion: ResolvedCompanion | null = null
  try {
    companion = await resolveCompanion(env)
    rows.push(["companion", `${companion.path} (${describeOrigin(companion)})`])
  } catch (error) {
    fail("companion", errorMessage(error))
  }

  const directories = companionDirectories(env)
  let directoryUsable = false
  try {
    await ensureCompanionDirectories(directories)
    directoryUsable = true
    rows.push(["directory", `${companionDirectory(env)} (private)`])
  } catch (error) {
    fail("directory", errorMessage(error))
  }

  if (companion !== null && directoryUsable) {
    try {
      const build = await companionBuild(companion.path, env)
      if (build === COMPANION_PIN.build) {
        rows.push(["build", `${build} (the build pinned by this smolmux checkout)`])
      } else if (companion.origin === "override") {
        rows.push(["build", companionMismatch(companion, build, PROTOCOL_VERSION)])
      } else {
        fail("build", companionMismatch(companion, build, PROTOCOL_VERSION))
      }
    } catch (error) {
      fail("build", errorMessage(error))
    }
  } else if (companion !== null) {
    rows.push(["build", `not checked: the directory is unusable (expected ${COMPANION_PIN.build})`])
  } else {
    rows.push(["build", `expected ${COMPANION_PIN.build} (${COMPANION_PIN.repository} ${COMPANION_PIN.commit.slice(0, 12)})`])
  }
  rows.push(["protocol", String(PROTOCOL_VERSION)])
  rows.push(["instance", `${instance.name} · ${instance.id}`])
  rows.push(["api", apiSocketPathFor(instance.id)])
  rows.push(["config", instance.configPath])
  // smolmux's directory is its own, while the Companion build still defaults
  // to the fork's. A human reaching for a session by hand needs the directory
  // named, so name it rather than leave it to be found out.
  if (companion !== null) {
    rows.push(["by hand", `ZMX_DIR=${companionDirectory(env)} ${companion.path} list`])
  }

  const width = Math.max(...rows.map(([label]) => label.length))
  return { lines: rows.map(([label, text]) => `${label.padEnd(width)}  ${text}`), ok }
}

function describeOrigin(companion: ResolvedCompanion): string {
  switch (companion.origin) {
    case "override":
      return COMPANION_PATH_ENV_VAR
    case "sibling":
      return `beside ${installedDirectory() ?? "smolmux"}/smolmux`
    case "path":
      return "on PATH"
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
