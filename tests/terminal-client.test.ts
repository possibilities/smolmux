import { expect, spyOn, test } from "bun:test"
import { resolveKeybindings } from "../src/keybindings.ts"
import { EventEmitter } from "node:events"
import { CompanionConnection } from "../src/companion-client.ts"
import type { Exit } from "../src/zmx-protocol.ts"
import { ClientInputFilter, ClientOutputRelay, runTerminalClient } from "../src/terminal-client.ts"

test("an empty Runtime Restore leaves the shell surface intact", () => {
  const writes: Uint8Array[] = []
  const relay = new ClientOutputRelay((bytes) => writes.push(bytes))

  relay.beginRestore()
  relay.output(new Uint8Array())
  relay.ready()
  relay.output(new TextEncoder().encode("LIVE"))

  expect(writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(["LIVE"])
})

test("a populated Restore resets and conceals in the same write as its first bytes", () => {
  const writes: Uint8Array[] = []
  const relay = new ClientOutputRelay((bytes) => writes.push(bytes))

  relay.beginRestore()
  relay.output(new TextEncoder().encode("RESTORED"))
  relay.output(new TextEncoder().encode(" LIVE"))
  relay.ready()

  expect(writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
    "\x1bc\x1b[?25lRESTORED",
    " LIVE",
  ])
})

test("prefix Detach is consumed locally and never arms the shared Runtime", () => {
  const forwarded: Uint8Array[] = []
  let detached = 0
  const filter = new ClientInputFilter(
    resolveKeybindings().keybindings,
    (bytes) => forwarded.push(bytes),
    () => detached += 1,
  )
  try {
    filter.push(Uint8Array.from([0x02, 0x64])) // ctrl-b d
    expect(detached).toBe(1)
    expect(forwarded).toEqual([])
  } finally {
    filter.destroy()
  }
})

test("a non-Detach prefix command reaches the Runtime as its original bytes", () => {
  const forwarded: Uint8Array[] = []
  const filter = new ClientInputFilter(
    resolveKeybindings().keybindings,
    (bytes) => forwarded.push(bytes),
    () => {
      throw new Error("unexpected detach")
    },
  )
  try {
    filter.push(Uint8Array.from([0x02, 0x63])) // ctrl-b c
    expect([...joinBytes(forwarded)]).toEqual([0x02, 0x63])
  } finally {
    filter.destroy()
  }
})

test("a configured direct Detach chord is Client-local too", () => {
  const forwarded: Uint8Array[] = []
  let detached = 0
  const filter = new ClientInputFilter(
    resolveKeybindings({ detach: "ctrl+g" }).keybindings,
    (bytes) => forwarded.push(bytes),
    () => detached += 1,
  )
  try {
    filter.push(Uint8Array.from([0x07]))
    expect(detached).toBe(1)
    expect(forwarded).toEqual([])
  } finally {
    filter.destroy()
  }
})

test("ordinary input and bracketed paste retain their terminal bytes", () => {
  const forwarded: Uint8Array[] = []
  const filter = new ClientInputFilter(
    resolveKeybindings().keybindings,
    (bytes) => forwarded.push(bytes),
    () => {
      throw new Error("unexpected detach")
    },
  )
  const input = new TextEncoder().encode("x\x1b[200~hello\nworld\x1b[201~")
  try {
    filter.push(input)
    expect(new TextDecoder().decode(joinBytes(forwarded))).toBe("x\x1b[200~hello\nworld\x1b[201~")
  } finally {
    filter.destroy()
  }
})

test("mouse motion and focus reports retain their terminal bytes", () => {
  const forwarded: Uint8Array[] = []
  const filter = new ClientInputFilter(
    resolveKeybindings().keybindings,
    (bytes) => forwarded.push(bytes),
    () => {
      throw new Error("unexpected detach")
    },
  )
  const input = new TextEncoder().encode("\x1b[<35;10;5M\x1b[I\x1b[O")
  try {
    filter.push(input)
    expect(new TextDecoder().decode(joinBytes(forwarded))).toBe("\x1b[<35;10;5M\x1b[I\x1b[O")
  } finally {
    filter.destroy()
  }
})

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}


test("transport failure during input, resize, or Detach always restores the terminal", async () => {
  for (const failure of ["input", "resize", "detach"]) {
    const stdin = Object.assign(new EventEmitter(), {
      isRaw: false, isTTY: false,
      setRawMode(raw: boolean) { this.isRaw = raw },
      resume() {}, pause() {},
    })
    const writes: string[] = []
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: false, columns: 80, rows: 24,
      write(bytes: string | Uint8Array) { writes.push(Buffer.from(bytes).toString()); return true },
    })
    let ready = () => {}
    const broken = () => { throw new Error("broken transport") }
    const connection = {
      isClosed: false,
      onRestoreBegin() {}, onOutput() {}, onFrame() {}, onExit() {}, onClose() {},
      onReady(listener: () => void) { ready = listener },
      attach() { ready() },
      write: failure === "input" ? broken : () => {},
      resize: failure === "resize" ? broken : () => {},
      detach: failure === "detach" ? broken : () => {},
    }
    const connect = spyOn(CompanionConnection, "connect").mockResolvedValue(connection as unknown as CompanionConnection)
    const installed = Promise.withResolvers<void>()
    try {
      const running = runTerminalClient({
        socketPath: "unused",
        keybindings: resolveKeybindings().keybindings,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        onSignalHandlersInstalled: () => installed.resolve(),
      })
      const outcome = running.catch((error: Error) => error)
      await installed.promise
      expect(stdin.isRaw).toBe(true)
      expect(() => {
        if (failure === "input") stdin.emit("data", Buffer.from("x"))
        else if (failure === "resize") stdout.emit("resize")
        else stdin.emit("end")
      }).not.toThrow()
      expect(await outcome).toBeInstanceOf(Error)
      expect(stdin.isRaw).toBe(false)
      expect(stdin.listenerCount("data")).toBe(0)
      expect(stdout.listenerCount("resize")).toBe(0)
      expect(writes.join("")).toContain("\x1b[?2026l")
      expect(writes.join("")).toContain("\x1b[?25h")
    } finally {
      connect.mockRestore()
    }
  }
})

test("unknown Runtime exit status reports a diagnostic and restores the terminal", async () => {
  const stdin = Object.assign(new EventEmitter(), {
    isRaw: false, isTTY: false, setRawMode(raw: boolean) { this.isRaw = raw }, resume() {}, pause() {},
  })
  const writes: string[] = []
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: false, columns: 80, rows: 24,
    write(bytes: string | Uint8Array) { writes.push(Buffer.from(bytes).toString()); return true },
  })
  let exit = (_status: Exit) => {}
  let ready = () => {}
  const connection = {
    isClosed: false, onRestoreBegin() {}, onOutput() {}, onFrame() {}, onClose() {},
    onExit(listener: (status: Exit) => void) { exit = listener }, onReady(listener: () => void) { ready = listener },
    attach() { ready() }, write() {}, resize() {}, detach() {},
  }
  const connect = spyOn(CompanionConnection, "connect").mockResolvedValue(connection as unknown as CompanionConnection)
  const installed = Promise.withResolvers<void>()
  try {
    const running = runTerminalClient({ socketPath: "unused", keybindings: resolveKeybindings().keybindings,
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      onSignalHandlersInstalled: () => installed.resolve(),
    })
    const outcome = running.catch((error: Error) => error)
    await installed.promise
    exit({ code: null, signal: null, reason: 0 })
    expect(await outcome).toMatchObject({ message: "the Runtime ended; its exit status is unknown after a Companion handoff" })
    expect(stdin.isRaw).toBe(false)
    expect(writes.join("")).toContain("\x1b[?25h")
  } finally { connect.mockRestore() }
})
