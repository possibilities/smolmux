import { randomUUID } from "node:crypto"
import { APP_NAME, sessionViewSchema } from "./protocol.ts"
import type { SessionEntry } from "./zmx-command.ts"

/**
 * How a Session is known to the Companion: a deterministic session name and
 * the labels that prove ownership. Labels are applied by the Companion
 * before any client can see the session, so they are the record — a Runtime
 * that starts finds its Sessions by them and needs no file of its own.
 */

export const OWNER_LABEL = "smolmux"
const SESSION_PREFIX = "smolmux"
const RUNTIME_PREFIX = "smolmuxr"
export const RUNTIME_KIND = "runtime"

/** Labels a caller may not set: smolmux's own. */
export const RESERVED_LABELS = ["owner", "instance", "app", "session", "kind"] as const

export type SessionIdentity = {
  /** The caller's name, unique per Instance. */
  name: string
  id: string
  /** The Companion session name. */
  companionName: string
  labels: Record<string, string>
}

export function sessionIdentity(instanceId: string, name: string, extra: Record<string, string> = {}, id: string = randomUUID()): SessionIdentity {
  if (!APP_NAME.test(name)) throw new Error(`invalid App name: ${JSON.stringify(name)}`)
  return {
    name,
    id,
    companionName: `${SESSION_PREFIX}-${instanceId}-${name}`,
    labels: { ...extra, owner: OWNER_LABEL, instance: instanceId, app: name, session: id },
  }
}

export function runtimeSessionName(instanceId: string): string {
  return `${RUNTIME_PREFIX}-${instanceId}`
}

export function runtimeLabels(instanceId: string): Record<string, string> {
  return { owner: OWNER_LABEL, instance: instanceId, kind: RUNTIME_KIND }
}

/** The Session name a live Companion session carries for this Instance, or null when it is not ours. */
export function ownedSessionName(entry: SessionEntry, instanceId: string): string | null {
  const { owner, instance, app, session, kind } = entry.labels
  if (owner !== OWNER_LABEL || instance !== instanceId || kind === RUNTIME_KIND) return null
  if (typeof app !== "string" || !APP_NAME.test(app) || !sessionViewSchema.shape.id.safeParse(session).success) return null
  if (entry.name !== `${SESSION_PREFIX}-${instanceId}-${app}`) return null
  return app
}

/** A Companion name that is shaped like one of this Instance's Sessions, whether or not its labels can be read. */
export function looksLikeOwnedSession(companionName: string, instanceId: string): boolean {
  const prefix = `${SESSION_PREFIX}-${instanceId}-`
  return companionName.startsWith(prefix) && APP_NAME.test(companionName.slice(prefix.length))
}
