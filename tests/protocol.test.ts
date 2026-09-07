import { describe, expect, test } from "bun:test"
import {
  contractDocument,
  encodeFrame,
  ERROR_CODES,
  EVENTS,
  eventFrame,
  failureFrame,
  isMethod,
  layoutNodeSchema,
  METHOD_NAMES,
  METHODS,
  PROTOCOL_VERSION,
  requestSchema,
  APP_NAME,
  successFrame,
} from "../src/protocol.ts"

describe("the contract", () => {
  test("is exactly the methods the design names, and no more", () => {
    expect([...METHOD_NAMES].sort()).toEqual([
      "app.capture",
      "app.create",
      "app.input",
      "app.list",
      "app.remove",
      "app.restart",
      "client.copy",
      "event.subscribe",
      "instance.status",
      "instance.stop",
      "layout.apply",
      "layout.get",
      "state.get",
    ])
  })

  test("takes input as intent, never as bytes, and still manages nothing a Pane runs", () => {
    // app.input speaks keys, text, paste and mouse; encoding belongs to the
    // Session's emulator, so nothing here accepts bytes or escape sequences.
    for (const forbidden of ["session.send", "session.write", "session.keys", "pane.set_app", "session.rename"]) {
      expect(isMethod(forbidden)).toBe(false)
    }
  })

  test("names its events and error codes", () => {
    expect(Object.keys(EVENTS).sort()).toEqual([
      "app.state",
      "apps.changed",
      "instance.stopping",
      "layout.changed",
      "session.changed",
      "session.exited",
      "stage.changed",
      "state.invalidated",
      "theme.changed",
    ])
    expect(ERROR_CODES).toContain("companion_error")
    expect(ERROR_CODES).not.toContain("tmux_error")
  })

  test("describes every method and event for `smolmux api`", () => {
    const document = contractDocument() as {
      protocol: number
      methods: Record<string, { description: string; params: unknown; result: unknown }>
      events: Record<string, { description: string }>
    }
    expect(document.protocol).toBe(PROTOCOL_VERSION)
    for (const name of METHOD_NAMES) {
      expect(document.methods[name]!.description.length).toBeGreaterThan(10)
      expect(document.methods[name]!.params).toBeDefined()
      expect(document.methods[name]!.result).toBeDefined()
    }
    for (const name of Object.keys(EVENTS)) {
      expect(document.events[name]!.description.length).toBeGreaterThan(10)
    }
  })
})

describe("frames", () => {
  test("are one JSON object per line", () => {
    const line = encodeFrame(successFrame("1", { ok: true }))
    expect(line.endsWith("\n")).toBe(true)
    expect(JSON.parse(line)).toEqual({ v: 2, type: "response", id: "1", ok: true, result: { ok: true } })
    expect(JSON.parse(encodeFrame(failureFrame("2", "not_found", "no Session named x")))).toEqual({
      v: 2,
      type: "response",
      id: "2",
      ok: false,
      error: { code: "not_found", message: "no Session named x" },
    })
    expect(JSON.parse(encodeFrame(eventFrame("theme.changed", { theme: "dark", instanceId: "test", generation: 1, sequence: 1 })))).toEqual({
      v: 2,
      type: "event",
      event: "theme.changed",
      data: { theme: "dark", instanceId: "test", generation: 1, sequence: 1 },
    })
  })

  test("refuse a request that is not this protocol", () => {
    expect(requestSchema.safeParse({ v: 2, type: "request", id: "1", method: "layout.get" }).success).toBe(true)
    expect(requestSchema.safeParse({ v: 1, type: "request", id: "1", method: "layout.get" }).success).toBe(false)
    expect(requestSchema.safeParse({ v: 2, type: "response", id: "1", method: "layout.get" }).success).toBe(false)
    expect(requestSchema.safeParse({ v: 2, type: "request", id: "", method: "layout.get" }).success).toBe(false)
  })
})

describe("parameter shapes", () => {
  test("hold a Session name to its grammar", () => {
    for (const name of ["tray", "a", "review-2", "work_2"]) expect(APP_NAME.test(name)).toBe(true)
    for (const name of ["", "Tray", "2fast", "has.dot", "a".repeat(33)]) expect(APP_NAME.test(name)).toBe(false)
  })

  test("require an argv and a directory to create a Session", () => {
    const create = METHODS["app.create"].params
    expect(create.safeParse({ pty: "companion", name: "tray", argv: ["/bin/sh"], cwd: "/work" }).success).toBe(true)
    expect(create.safeParse({ pty: "companion", name: "tray", argv: [], cwd: "/work" }).success).toBe(false)
    expect(create.safeParse({ pty: "companion", name: "tray", argv: ["/bin/sh"] }).success).toBe(false)
    expect(create.safeParse({ pty: "companion", name: "tray", argv: ["/bin/sh"], cwd: "/work", extra: 1 }).success).toBe(false)
  })

  test("accept a Layout of rows, columns, Sessions, and text", () => {
    expect(
      layoutNodeSchema.safeParse({
        row: [
          { column: [{ text: "notes", size: 8 }, { app: "tray" }], size: 26, min: 24 },
          { app: "reviewer", min: 20 },
        ],
      }).success,
    ).toBe(true)
    expect(layoutNodeSchema.safeParse({ app: "tray", row: [] }).success).toBe(false)
    expect(layoutNodeSchema.safeParse({ app: "Tray" }).success).toBe(false)
    expect(layoutNodeSchema.safeParse({ row: [] }).success).toBe(false)
    expect(layoutNodeSchema.safeParse({ app: "tray", size: 0 }).success).toBe(false)
  })

  test("let a Layout be cleared and focus be named or dropped", () => {
    const apply = METHODS["layout.apply"].params
    expect(apply.safeParse({ visible: [], root: null }).success).toBe(true)
    expect(apply.safeParse({ visible: ["tray"], root: { app: "tray" }, focus: "tray" }).success).toBe(true)
    expect(apply.safeParse({ visible: ["tray"], root: { app: "tray" }, focus: null }).success).toBe(true)
    expect(apply.safeParse({}).success).toBe(false)
  })
})

test("initial native viewport allocation is bounded before Session creation", () => {
  const create = METHODS["app.create"].params;
  const base = {pty: "companion", name: "a", argv: ["sh"], cwd: "/"};
  expect(create.safeParse({...base, cols: 4096, rows: 64}).success).toBe(true);
  expect(create.safeParse({...base, cols: 4096, rows: 65}).success).toBe(false);
  expect(create.safeParse({...base, cols: 65535, rows: 65535}).success).toBe(false);
});
