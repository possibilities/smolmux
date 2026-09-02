import { readFileSync } from "node:fs"
import { isAbsolute, join, normalize } from "node:path"
import { fxSessionDirectory, isSessionId } from "./fx-sessions.ts"

export const NATIVE_SESSION_NAME_MAX_BYTES = 240

export type SessionNamesOptions = {
  env?: NodeJS.ProcessEnv
  home?: string
}

/** Native fx names, keyed by fx session rather than by the Agent showing it. */
export class SessionNames {
  private readonly env: NodeJS.ProcessEnv
  private readonly names = new Map<string, string>()

  constructor(options: SessionNamesOptions = {}) {
    this.env = { ...(options.env ?? process.env) }
    if (options.home) this.env.HOME = options.home
  }

  nameFor(sessionId: string): string | null {
    return this.names.get(sessionId) ?? null
  }

  apply(sessionId: string, rawName: string): boolean {
    if (!isSessionId(sessionId)) return false
    const name = nativeSessionName(rawName)
    if (!name || this.names.get(sessionId) === name) return false
    this.names.set(sessionId, name)
    return true
  }

  /** Re-read fx's durable authority after startup, identity change, or a feed gap. */
  recover(sessionId: string, stateRoot: string | null = null): boolean {
    if (!isSessionId(sessionId)) return false
    const name = readNativeSessionName(sessionId, this.env, stateRoot)
    if (name === null) return this.names.delete(sessionId)
    return this.apply(sessionId, name)
  }

  forget(sessionId: string): void {
    this.names.delete(sessionId)
  }
}

export function readNativeSessionName(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  stateRoot: string | null = null,
): string | null {
  const directory = stateRoot === null
    ? fxSessionDirectory(sessionId, env)
    : stateRootSessionDirectory(sessionId, stateRoot)
  if (!directory) return null
  let value: unknown
  try {
    value = JSON.parse(readFileSync(`${directory}/display.json`, "utf8"))
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.title !== "string") return null
  return nativeSessionName(value.title)
}

function stateRootSessionDirectory(sessionId: string, stateRoot: string): string | null {
  if (
    !isSessionId(sessionId) ||
    !isAbsolute(stateRoot) ||
    stateRoot === "/" ||
    normalize(stateRoot) !== stateRoot ||
    Buffer.byteLength(stateRoot, "utf8") > 4096 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(stateRoot)
  ) return null
  return join(stateRoot, ".fx", "sessions", sessionId)
}

export function nativeSessionName(raw: string): string | null {
  if (raw.trim().length === 0 || Buffer.byteLength(raw, "utf8") > NATIVE_SESSION_NAME_MAX_BYTES) return null
  for (const character of raw) {
    const codepoint = character.codePointAt(0)!
    // C0, DEL, and C1: a terminal that honours the 8-bit introducers reads
    // U+0080-U+009F as control sequences, so they are as undrawable as an ESC.
    if (codepoint <= 0x1f || (codepoint >= 0x7f && codepoint <= 0x9f)) return null
  }
  return raw
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
