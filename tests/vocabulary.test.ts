import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import packageMetadata from "../package.json" with { type: "json" }
import { usage } from "../src/cli.ts"
import { InvalidInstanceNameError } from "../src/instance.ts"
import { METHOD_NAMES } from "../src/protocol.ts"

const ROOT = resolve(import.meta.dir, "..")

/**
 * Every document that describes smolmux as it is. Decision records are history
 * and keep the words they were written with; a superseded one says so at the
 * top instead of being rewritten.
 */
async function prose(): Promise<[string, string][]> {
  const docs = await readdir(join(ROOT, "docs"), { recursive: true })
  const files = [
    "README.md",
    "CONTEXT.md",
    ...docs.filter((path) => path.endsWith(".md") && !path.startsWith("adr/")).map((path) => join("docs", path)),
  ]
  return Promise.all(files.map(async (file) => [file, await readFile(join(ROOT, file), "utf8")] as [string, string]))
}

describe("canonical public vocabulary", () => {
  test("uses Instance, Session, Layout, and Pane on primary surfaces", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8")
    for (const term of ["Instance", "Session", "Layout", "Pane", "Companion"]) {
      expect(readme).toContain(term)
    }
    expect(packageMetadata.description).toContain("multiplexer")
    expect(usage()).toContain("select an independent Instance")
    expect(new InvalidInstanceNameError("BAD").message).toContain("invalid Instance name")
  })

  test("keeps the retired agent vocabulary out of human-facing prose", async () => {
    for (const [file, text] of await prose()) {
      for (const retired of [
        "\\bAgent\\b",
        "\\bTray\\b",
        "\\bAgent list\\b",
        "\\bsmolmux Session\\b",
        "\\bManifest\\b",
        "\\bHome\\b",
        "\\bHerdr\\b",
        "\\bsmolmux-mcp\\b",
      ]) {
        expect(text, `${file} still says ${retired}`).not.toMatch(new RegExp(retired, "u"))
      }
    }
  })

  test("keeps public diagnostics free of retired wording", async () => {
    for (const file of ["src/cli.ts", "src/doctor.ts", "src/instance.ts", "src/protocol.ts"]) {
      const text = await readFile(join(ROOT, file), "utf8")
      for (const retired of ["\\bTray\\b", "\\bAgent list\\b", "\\bHerdr\\b"]) {
        expect(text, `${file} still says ${retired}`).not.toMatch(new RegExp(`"[^"\\n]*${retired}[^"\\n]*"`, "u"))
      }
    }
  })

  test("every decision the rewrite overturned points at what replaced it", async () => {
    const superseded = [
      "0005-agent-tray-vocabulary.md",
      "0006-native-session-names-over-ade.md",
      "0007-companion-held-shared-runtime.md",
      "0008-ade-only-fx-lifecycle.md",
      "0009-pinned-private-fx-install.md",
      "0013-mcp-only-agent-automation.md",
      "0014-independent-named-smolmux.md",
    ]
    const records = await readdir(join(ROOT, "docs/adr"))
    const replacements = await Promise.all(
      records
        .filter((path) => /^001[5-9]/u.test(path))
        .map((path) => readFile(join(ROOT, "docs/adr", path), "utf8")),
    )
    for (const record of superseded) {
      // The successor names it, and it names the successor: a reader who
      // opens a retired record cold must be told it was overturned.
      expect(replacements.some((text) => text.includes(record)), `nothing supersedes ${record}`).toBe(true)
      const text = await readFile(join(ROOT, "docs/adr", record), "utf8")
      expect(text, `${record} does not say it was superseded`).toMatch(/[Ss]uperseded by|is superseded by/u)
    }
  })

  test("decision identifiers are unique and references name their files", async () => {
    const records = (await readdir(join(ROOT, "docs/adr"))).filter((path) => /^\d{4}-.*\.md$/u.test(path))
    const numbers = records.map((path) => path.slice(0, 4))
    expect(new Set(numbers).size, "each decision needs one unambiguous identifier").toBe(numbers.length)
    for (const path of records.filter((name) => /^001[5-9]/u.test(name))) {
      const text = await readFile(join(ROOT, "docs/adr", path), "utf8")
      // File links keep a reference tied to its decision through title or identifier corrections.
      expect(text, `${path} references a decision by bare number`).not.toMatch(/ADRs \d{4}/u)
    }
  })

  test("documents every method the contract defines", async () => {
    const api = await readFile(join(ROOT, "docs/api.md"), "utf8")
    for (const method of METHOD_NAMES) {
      expect(api, `docs/api.md omits ${method}`).toContain(`## \`${method}\``)
    }
  })
})
