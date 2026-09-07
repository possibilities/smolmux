import { expect, test } from "bun:test"
import {
  looksLikeOwnedSession,
  ownedSessionName,
  RESERVED_LABELS,
  runtimeLabels,
  runtimeSessionName,
  sessionIdentity,
} from "../src/session-identity.ts"
import type { SessionEntry } from "../src/zmx-command.ts"

const ID = "00000000-0000-4000-8000-000000000001"
const INSTANCE = "0123456789ab"

const entry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  name: `smolmux-${INSTANCE}-tray`,
  state: "live",
  socketPath: "/tmp/socket",
  pid: 7,
  clients: 1,
  createdAt: 5,
  command: ["/bin/sh"],
  cwd: "/work",
  labels: { owner: "smolmux", instance: INSTANCE, app: "tray", session: ID },
  exit: null,
  detail: null,
  ...overrides,
})

test("a Session's Companion name and labels are derived from its Instance and name", () => {
  const identity = sessionIdentity(INSTANCE, "tray", { role: "list" }, ID)
  expect(identity).toEqual({
    name: "tray",
    id: ID,
    companionName: `smolmux-${INSTANCE}-tray`,
    labels: { role: "list", owner: "smolmux", instance: INSTANCE, app: "tray", session: ID },
  })
  expect(() => sessionIdentity(INSTANCE, "Tray")).toThrow("invalid App name")
})

test("smolmux's own labels cannot be taken by a caller", () => {
  const identity = sessionIdentity(INSTANCE, "tray", { owner: "someone-else", instance: "elsewhere" })
  expect(identity.labels.owner).toBe("smolmux")
  expect(identity.labels.instance).toBe(INSTANCE)
  expect(RESERVED_LABELS).toEqual(["owner", "instance", "app", "session", "kind"])
})

test("ownership needs every label and the name itself to agree", () => {
  expect(ownedSessionName(entry(), INSTANCE)).toBe("tray")
  expect(ownedSessionName(entry(), "another-one")).toBeNull()
  expect(ownedSessionName(entry({ labels: { owner: "zmx", instance: INSTANCE, app: "tray", session: ID } }), INSTANCE)).toBeNull()
  expect(ownedSessionName(entry({ name: "smolmux-elsewhere-tray" }), INSTANCE)).toBeNull()
  expect(ownedSessionName(entry({ labels: { owner: "smolmux", instance: INSTANCE, app: "Tray", session: ID } }), INSTANCE)).toBeNull()
})

test("the Runtime is never mistaken for a Session of its own Instance", () => {
  const runtime = entry({ name: runtimeSessionName(INSTANCE), labels: runtimeLabels(INSTANCE) })
  expect(ownedSessionName(runtime, INSTANCE)).toBeNull()
  expect(looksLikeOwnedSession(runtime.name, INSTANCE)).toBe(false)
})

test("a name alone says whether an unreadable session may be ours", () => {
  expect(looksLikeOwnedSession(`smolmux-${INSTANCE}-tray`, INSTANCE)).toBe(true)
  expect(looksLikeOwnedSession(`smolmux-${INSTANCE}-Tray`, INSTANCE)).toBe(false)
  expect(looksLikeOwnedSession("smolmux-elsewhere-tray", INSTANCE)).toBe(false)
  expect(looksLikeOwnedSession("someone-elses-session", INSTANCE)).toBe(false)
})
