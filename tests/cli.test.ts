import { describe, expect, test } from "bun:test"
import packageMetadata from "../package.json" with { type: "json" }
import { COMMANDS, parseArgs, usage, VERSION } from "../src/cli.ts"

describe("parseArgs", () => {
  test("keeps the executable to start, stop, attach, and reporting", () => {
    expect(parseArgs([])).toEqual({ foreground: false, localOnly: false, help: false, version: false, command: null, name: "default" })
    expect(parseArgs(["start"]).command).toBe("start")
    expect(parseArgs(["attach"]).command).toBe("attach")
    expect(parseArgs(["stop"]).command).toBe("stop")
    expect(parseArgs(["status"]).command).toBe("status")
    expect(parseArgs(["api"]).command).toBe("api")
    expect(parseArgs(["doctor"]).command).toBe("doctor")
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["--version"]).version).toBe(true)
    expect(VERSION).toBe(packageMetadata.version)
    expect(packageMetadata.bin).toEqual({ smolmux: "./src/index.ts" })
  })

  test("selects one independent Instance", () => {
    expect(parseArgs(["--name", "foo"])).toMatchObject({ name: "foo", command: null })
    expect(parseArgs(["--name=work_2", "status"])).toMatchObject({ command: "status", name: "work_2" })
    expect(parseArgs(["start", "--name", "foo-bar"]).name).toBe("foo-bar")
    expect(parseArgs(["--name", "default"]).name).toBe("default")
    expect(usage()).toContain("--name NAME")
    expect(usage()).toContain("select an independent Instance")
  })

  test("rejects missing, repeated, and unsafe names as usage errors", () => {
    expect(() => parseArgs(["--name"])).toThrow("--name requires a value")
    expect(() => parseArgs(["--name="])).toThrow("--name requires a value")
    expect(() => parseArgs(["--name", "foo", "--name", "bar"])).toThrow("only once")
    for (const invalid of ["A", "2fast", "has.dot", "has/slash", `a${"b".repeat(32)}`]) {
      expect(() => parseArgs(["--name", invalid])).toThrow("invalid Instance name")
    }
  })

  test("has no verb for anything the API owns", () => {
    for (const verb of ["session", "layout", "focus", "kill", "new", "capture", "send-keys"]) {
      expect(() => parseArgs([verb])).toThrow(`unknown command: ${verb}`)
    }
    expect(() => parseArgs(["--socket", "/tmp/smolmux.api"])).toThrow("unknown option: --socket")
    expect(() => parseArgs(["status", "now"])).toThrow("unexpected argument: now")
    expect(() => parseArgs(["--agent-picker"])).toThrow("unknown option: --agent-picker")
  })

  test("keeps the hidden runtime verb out of the usage text", () => {
    expect(COMMANDS).toContain("runtime")
    expect(parseArgs(["runtime"]).command).toBe("runtime")
    expect(usage()).not.toContain("runtime ")
  })

  test("names the one chord smolmux claims", () => {
    expect(usage()).toContain("ctrl-b d")
    expect(usage()).toContain("detach this terminal")
  })
})
