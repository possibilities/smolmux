import { z } from "zod"

/**
 * The smolmux API, defined once. Every method below is validated by the Runtime,
 * typed for the client, printed by `smolmux api`, and described in `docs/api.md`,
 * all from this table.
 *
 * Wire: newline-delimited JSON over one duplex Unix socket. A client sends
 * `request` frames and receives `response` frames with the same id; after
 * `event.subscribe` it also receives `event` frames until it hangs up.
 */
export const PROTOCOL_VERSION = 2

export const APP_NAME = /^[a-z][a-z0-9_-]{0,31}$/u

const appName = z.string().regex(APP_NAME).describe("App name: [a-z][a-z0-9_-]{0,31}")
const theme = z.enum(["dark", "light"])
/** `null` as its own `anyOf` branch, described, so JSON Schema readers keep it. */
const NONE = z.null().describe("null when there is none")
const labelToken = z.string().regex(/^[A-Za-z0-9_.-]+$/u)

export const stageSchema = z.object({
  cols: z.int().min(1),
  rows: z.int().min(1),
})
export type Stage = z.infer<typeof stageSchema>

export const ptySchema = z.enum(["companion", "local"])
export const hiddenPolicySchema = z.enum(["keep", "stop", "pause"])
export const appStateSchema = z.enum(["stopped", "starting", "running", "pausing", "paused", "resuming", "stopping", "exited", "unreachable", "failed"])
export type PtyKind = z.infer<typeof ptySchema>
export type HiddenPolicy = z.infer<typeof hiddenPolicySchema>
export type AppState = z.infer<typeof appStateSchema>
export const sessionExitSchema = z.object({ code: z.int().nullable(), signal: z.int().nullable(), reason: z.string() }).strict()
export const exitCauseSchema = z.enum(["natural", "hidden", "remove", "restart", "shutdown"])
export type ExitCause = z.infer<typeof exitCauseSchema>
export const sessionViewSchema = z.object({
  id: z.string().uuid(),
  pid: z.int().nullable(),
  created_at: z.number(),
  state: z.enum(["live", "paused", "unreachable"]),
}).strict()
export type SessionView = z.infer<typeof sessionViewSchema>
export const appViewSchema = z.object({
  name: appName,
  pty: ptySchema,
  whenHidden: hiddenPolicySchema,
  cwd: z.string(),
  argv: z.array(z.string()).nullable().describe("Original argv; null after Companion Adoption. Environment values are never published."),
  created_at: z.number(),
  title: z.string(),
  cols: z.int().min(1),
  rows: z.int().min(1),
  visible: z.boolean().describe("Logical visibility, independent of fitting"),
  shown: z.boolean().describe("A fitted Pane has cells showing the App"),
  state: appStateSchema,
  session: sessionViewSchema.nullable(),
  lastExit: sessionExitSchema.extend({ sessionId: z.string().uuid(), cause: exitCauseSchema }).nullable(),
  error: z.string().nullable(),
  labels: z.record(labelToken, z.string()),
}).strict()
export type AppView = z.infer<typeof appViewSchema>

const sizedLeaf = {
  size: z.int().min(1).optional().describe("Fixed columns in a row, rows in a column; omitted takes the remainder"),
  min: z.int().min(1).optional().describe("The smallest length along this node's parent's axis; default 1"),
}

export type LayoutNode =
  | { row: LayoutNode[]; size?: number | undefined; min?: number | undefined }
  | { column: LayoutNode[]; size?: number | undefined; min?: number | undefined }
  | { app: string; size?: number | undefined; min?: number | undefined }
  | { text: string; size?: number | undefined; min?: number | undefined }

/**
 * How deep a Layout may nest. A frame may carry far more nesting than a
 * recursive validator can walk, and a stack overflow there is a `RangeError`
 * rather than a validation failure — the caller would get no reply at all.
 * Nothing legible needs more than this.
 */
export const MAX_LAYOUT_DEPTH = 32

export const layoutNodeSchema: z.ZodType<LayoutNode, LayoutNode> = z.lazy(() =>
  z.union([
    z.object({ row: z.array(layoutNodeSchema).min(1), ...sizedLeaf }).strict(),
    z.object({ column: z.array(layoutNodeSchema).min(1), ...sizedLeaf }).strict(),
    z.object({ app: appName, ...sizedLeaf }).strict(),
    z.object({ text: z.string().max(200), ...sizedLeaf }).strict(),
  ]),
)

/**
 * How deep a request frame nests, measured on the raw line. `JSON.parse` is
 * itself recursive, so a frame deep enough to overflow it must be refused
 * before it is parsed, not after. Stops counting once past `limit`.
 */
export function frameNestingDepth(line: string, limit = MAX_LAYOUT_DEPTH): number {
  let depth = 0
  let deepest = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{" || character === "[") {
      depth += 1
      if (depth > deepest) {
        deepest = depth
        // A frame past the limit is refused whatever else it holds.
        if (deepest > limit) return deepest
      }
    } else if (character === "}" || character === "]") depth -= 1
  }
  return deepest
}

export const paneGeometrySchema = z.object({
  app: appName.or(NONE),
  text: z.string().or(NONE),
  x: z.int().min(0),
  y: z.int().min(0),
  cols: z.int().min(0),
  rows: z.int().min(0),
  focused: z.boolean(),
})
export type PaneGeometry = z.infer<typeof paneGeometrySchema>

export const layoutViewSchema = z.object({
  revision: z
    .int()
    .min(0)
    .describe("Increments whenever the tree changes, by an apply or a divider drag; pass it back to layout.apply to refuse a stale write"),
  visible: z.array(appName).describe("Complete logical visibility set committed with the tree"),
  root: layoutNodeSchema.or(NONE).describe("The applied tree with sizes as they stand after drags"),
  focus: appName.or(NONE).describe("The App the keyboard goes to"),
  stage: stageSchema,
  panes: z.array(paneGeometrySchema).describe("Every Pane as fitted, in tree order; a squeezed-out Pane has 0 cols or rows"),
})
export type LayoutView = z.infer<typeof layoutViewSchema>

/**
 * The most history one capture may carry. A capture crosses the socket whole,
 * and a connection's unwritten output is capped, so the bound is part of the
 * contract rather than the caller's discretion.
 */
export const MAX_CAPTURE_SCROLLBACK = 10_000

export const captureSchema = z.object({
  name: appName,
  sessionId: z.string().uuid(),
  lines: z
    .array(z.string())
    .describe("One string per row, trailing blanks trimmed; history first when scrollback was asked for"),
  screen_start: z
    .int()
    .min(0)
    .describe("Index in `lines` where the visible screen begins; 0 when no history was asked for or none exists"),
  cols: z.int().min(1),
  rows: z.int().min(1),
  cursor: z.object({ x: z.int().min(0), y: z.int().min(0), visible: z.boolean() }).describe("Relative to the visible screen"),
  title: z.string(),
  state: z
    .enum(["running", "paused", "unreachable"])
    .describe("unreachable: the screen this Session last had, read from its emulator, not one its transport confirmed"),
})
export type Capture = z.infer<typeof captureSchema>

/**
 * How much input one call may carry. Events are applied in order on one
 * connection, so a batch is also the unit of ordering: a caller that needs
 * two things to arrive in sequence puts them in one call.
 */
export const MAX_INPUT_EVENTS = 256
export const MAX_INPUT_TEXT = 4_096
export const MAX_INPUT_PASTE = 65_536

/**
 * Keys that are not a character. Anything else is the character itself, so
 * `a`, `A` and `£` are keys; the list is closed because a name the encoder
 * does not know would otherwise be delivered as nothing at all.
 */
export const NAMED_KEYS = [
  "enter",
  "escape",
  "tab",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "space",
  ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`),
] as const

const inputModifiers = {
  ctrl: z.boolean().optional(),
  alt: z.boolean().optional(),
  shift: z.boolean().optional(),
  super: z.boolean().optional(),
}

const keyInputSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(16)
      .describe(`One named key (${NAMED_KEYS.slice(0, 15).join(", ")}, f1-f24) or a single character`),
    action: z.enum(["press", "repeat", "release"]).optional().describe("default press"),
    ...inputModifiers,
  })
  .strict()

const textInputSchema = z
  .object({ text: z.string().min(1).max(MAX_INPUT_TEXT).describe("Delivered as one key press per character, the way typing looks to a program") })
  .strict()

const pasteInputSchema = z
  .object({
    paste: z
      .string()
      .min(1)
      .max(MAX_INPUT_PASTE)
      .describe("Delivered whole, bracketed when the Session turned bracketed paste on, so a program can tell it from typing"),
  })
  .strict()

const mouseInputSchema = z
  .object({
    mouse: z
      .object({
        action: z.enum(["down", "up", "move", "drag", "scroll"]),
        button: z.enum(["left", "middle", "right"]).optional().describe("default left; ignored by move and scroll"),
        x: z.int().min(0).describe("Cell from the Session's own left edge, not the stage's"),
        y: z.int().min(0).describe("Cell from the Session's own top edge"),
        scroll: z
          .object({ direction: z.enum(["up", "down", "left", "right"]), delta: z.int().min(1).max(100) })
          .strict()
          .optional()
          .describe("Required by scroll, and meaningless to every other action"),
        ...inputModifiers,
      })
      .strict(),
  })
  .strict()

export const inputEventSchema = z.union([keyInputSchema, textInputSchema, pasteInputSchema, mouseInputSchema])
export type InputEvent = z.infer<typeof inputEventSchema>

export const instanceStatusSchema = z.object({
  version: z.string(),
  pid: z.int(),
  name: z.string().describe("The Instance name; `default` for the unnamed one"),
  instance_id: z.string(),
  socket: z.string().describe("This API socket's path"),
  stage: stageSchema,
  theme,
  apps: z.array(appViewSchema),
  host: z.enum(["headless", "foreground"]),
  capabilities: z.object({ local: z.boolean(), companion: z.boolean() }).strict(),
  layout: layoutViewSchema,
})
export type InstanceStatus = z.infer<typeof instanceStatusSchema>

export const eventContextSchema = z.object({
  instanceId: z.string().min(1).describe("Random Runtime lifetime ID; distinct from the stable instance_id"),
  generation: z.literal(1).describe("No Runtime replacement within one lifetime"),
  sequence: z.int().min(0).describe("Publication watermark; not a replay cursor or timestamp"),
}).strict()
export type EventContext = z.infer<typeof eventContextSchema>
export const MAX_PROJECTION_BYTES = 2 * 1024 * 1024
export const availabilitySchema = z.enum(["ready", "incomplete", "unavailable"])
export const stateSnapshotSchema = eventContextSchema.extend({
  availability: availabilitySchema,
  reason: z.string().nullable(),
  state: instanceStatusSchema.nullable().describe("Complete current projection, or null when it exceeds 2 MiB; no terminal content"),
}).strict()
export type StateSnapshot = z.infer<typeof stateSnapshotSchema>

export const eventFiltersSchema = z.array(z.string().min(1).max(128).regex(/^(?:\*|[a-z][a-z0-9._:/-]*\*?)$/u)).min(1).max(32)
export const eventSubscriptionSchema = z.object({ events: eventFiltersSchema.default(["*"]) }).strict()
export function matchesEvent(filters: readonly string[], event: string): boolean {
  return filters.some((filter) => filter.endsWith("*") ? event.startsWith(filter.slice(0, -1)) : event === filter)
}

const empty = z.object({}).strict()

export const commandSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).refine((value) => value.startsWith("/"), "cwd must be absolute"),
  env: z.record(z.string(), z.string()).optional(),
}).strict()
export const appCreateSchema = commandSchema.extend({
  name: appName,
  pty: ptySchema,
  whenHidden: hiddenPolicySchema.default("keep"),
  cols: z.int().min(1).max(4096).optional(),
  rows: z.int().min(1).max(4096).optional(),
  labels: z.record(labelToken, labelToken).optional(),
}).strict().refine((p) => p.pty === "local" || p.whenHidden === "keep", "Companion Apps require whenHidden: keep")
  .refine((p) => (p.cols ?? 80) * (p.rows ?? 24) <= 262144, "initial size must not exceed 262144 cells")
export type AppCreate = z.input<typeof appCreateSchema>
const appTarget = z.object({ name: appName, sessionId: z.string().uuid().optional().describe("Refuse if the App now has another Session") })
export const METHODS = {
  "state.get": {
    description: "Atomic complete projection and publication watermark. Subscribe first; transient Session notifications are independent of snapshot watermarks.",
    params: empty, result: stateSnapshotSchema,
  },
  "instance.status": {
    description: "Runtime, host mode, capabilities, Apps and Layout.", params: empty, result: instanceStatusSchema,
  },
  "instance.stop": {
    description: "Seal declarations, end every local and Companion process, then reply and stop. A failed termination leaves the Instance available to retry.",
    params: empty, result: empty,
  },
  "event.subscribe": {
    description: "Replace connection-local literal filters; acknowledgment is the replacement boundary. Default *, exact names, or trailing-* prefixes.",
    params: eventSubscriptionSchema, result: z.object({ subscribed: z.literal(true), events: eventFiltersSchema }).strict(),
  },
  "app.create": {
    description: "Declare a named command. Companion/keep and local/keep start immediately; local stop/pause wait until logically visible. A failed launch remains declared as failed, with an error.",
    params: appCreateSchema, result: appViewSchema,
  },
  "app.remove": {
    description: "Terminate the current Session, if any, and remove the declaration. Removing an unknown App is not_found.",
    params: z.object({ name: appName }).strict(), result: empty,
  },
  "app.restart": {
    description: "End the current Session and request a fresh execution, respecting hidden policy. Supply command for an adopted App whose original argv/environment are unavailable. Natural exits never restart automatically.",
    params: z.object({ name: appName, command: commandSchema.optional() }).strict(), result: appViewSchema,
  },
  "app.list": {
    description: "All App declarations, including stopped, paused, exited and failed Apps.",
    params: empty, result: z.object({ apps: z.array(appViewSchema) }).strict(),
  },
  "app.capture": {
    description: "Capture the current Session and optional emulator scrollback, even off-Layout or paused/unreachable. not_running when no terminal exists. A supplied sessionId guards against replacement.",
    params: appTarget.extend({ scrollback: z.int().min(0).max(MAX_CAPTURE_SCROLLBACK).optional() }).strict(), result: captureSchema,
  },
  "app.input": {
    description: "Deliver an ordered semantic input batch to a running App without moving Focus. Paused, stopped, transitioning and unreachable Apps refuse input; mouse needs a fitted Pane. Never replay input after restart.",
    params: appTarget.extend({ events: z.array(inputEventSchema).min(1).max(MAX_INPUT_EVENTS) }).strict(),
    result: empty,
  },
  "layout.apply": {
    description: "Commit the tree, logical visible set and optional Focus under a Revision guard. Every App in the tree must be visible; extra visible Apps may be omitted by a caller's fitting. Only a successful commit schedules process policy transitions, which complete asynchronously through App state/events.",
    params: z.object({ root: layoutNodeSchema.nullable(), visible: z.array(appName), focus: appName.nullable().optional(), revision: z.int().min(0).optional() }).strict(),
    result: layoutViewSchema,
  },
  "layout.get": { description: "Current tree, logical visibility, Focus, Revision, Stage and fitted Panes.", params: empty, result: layoutViewSchema },
  "client.copy": {
    description: "Write text to every attached Client's clipboard through OSC 52, or to the foreground terminal. Write-only; nothing is retained or read back.",
    params: z.object({ text: z.string().min(1).max(MAX_INPUT_PASTE) }).strict(),
    result: z.object({ written: z.boolean() }).strict(),
  },
} as const

export type Method = keyof typeof METHODS
export const METHOD_NAMES = Object.keys(METHODS) as Method[]
export type Params<M extends Method> = z.input<(typeof METHODS)[M]["params"]>
export type Result<M extends Method> = z.infer<(typeof METHODS)[M]["result"]>

export const EVENTS = {
  "apps.changed": {
    description: "Current state: replace the App roster, including stopped/exited declarations. Roster removal is not proof of successful process completion.",
    data: z.object({ apps: z.array(appViewSchema), availability: availabilitySchema, reason: z.string().nullable() }),
  },
  "state.invalidated": {
    description: "Current state: projection exceeded the publication bound. Invalidate observation and request state.get.",
    data: z.object({ reason: z.string() }),
  },
  "session.exited": {
    description: "Transient: one execution ended. App identity and Session id distinguish it from a replacement; cause identifies intentional lifecycle actions. Nullable status is honest when unavailable.",
    data: sessionExitSchema.extend({ name: appName, sessionId: z.string().uuid(), cause: exitCauseSchema }),
  },
  "app.state": {
    description: "Current state: replace this App's complete view after a process or visibility transition.",
    data: z.object({ app: appViewSchema }),
  },
  "session.changed": {
    description: "Transient: output or a title reached this Session's emulator; debounced. Capture the App with this sessionId to avoid reading a replacement.",
    data: z.object({ name: appName, sessionId: z.string().uuid(), title: z.string() }),
  },
  "layout.changed": {
    description: "Current state: Layout after an apply, divider drag, or Stage resize, with logical visibility and App views.",
    data: z.object({ layout: layoutViewSchema, apps: z.array(appViewSchema), cause: z.enum(["apply", "drag", "resize"]) }),
  },
  "stage.changed": { description: "Current state: physical Stage size changed.", data: stageSchema },
  "theme.changed": { description: "Current state: resolved fxnk theme changed.", data: z.object({ theme }) },
  "instance.stopping": { description: "Current state: instance.stop was accepted; the socket closes after the reply.", data: empty },
} as const

export type EventName = keyof typeof EVENTS
export type EventData<E extends EventName> = z.infer<(typeof EVENTS)[E]["data"]>

export const ERROR_CODES = [
  "invalid_request",
  "unknown_method",
  "invalid_params",
  "not_found",
  "conflict",
  "companion_error",
  "process_error",
  "not_running",
  "unsupported",
  "internal_error",
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export class ApiFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ApiFailure"
  }
}

export const requestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("request"),
  id: z.string().min(1).max(128),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).nullish(),
}).strict()
export type RequestFrame = z.infer<typeof requestSchema>

export const responseFrameSchema = z.union([
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal("response"), id: z.string().min(1).max(128), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal("response"), id: z.string().nullable(), ok: z.literal(false), error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }).strict() }).strict(),
])
export type ResponseFrame = z.infer<typeof responseFrameSchema>

export type EventFrame = {
  [E in EventName]: { v: typeof PROTOCOL_VERSION; type: "event"; event: E; data: EventData<E> & EventContext }
}[EventName]
export const eventFrameSchema = z.union(Object.entries(EVENTS).map(([name, definition]) =>
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal("event"), event: z.literal(name),
    data: definition.data.extend(eventContextSchema.shape).strict(),
  }).strict().describe(definition.description).meta({ id: name }),
)).meta({ id: "events" })
export function isTransientEvent(event: EventName): boolean {
  return event === "session.changed" || event === "session.exited"
}

export type Frame = RequestFrame | ResponseFrame | EventFrame

export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`
}

export function successFrame(id: string, result: unknown): ResponseFrame {
  return { v: PROTOCOL_VERSION, type: "response", id, ok: true, result }
}

export function failureFrame(id: string | null, code: ErrorCode, message: string): ResponseFrame {
  return { v: PROTOCOL_VERSION, type: "response", id, ok: false, error: { code, message } }
}

export function eventFrame<E extends EventName>(event: E, data: EventData<E> & EventContext): EventFrame {
  return { v: PROTOCOL_VERSION, type: "event", event, data } as EventFrame
}

export function isMethod(name: string): name is Method {
  return Object.hasOwn(METHODS, name)
}

/** The whole contract as one JSON document: what `smolmux api` prints. */
export function contractDocument(): Record<string, unknown> {
  const methods: Record<string, unknown> = {}
  for (const name of METHOD_NAMES) {
    const method = METHODS[name]
    methods[name] = {
      description: method.description,
      params: z.toJSONSchema(method.params, { io: "input" }),
      result: z.toJSONSchema(method.result),
    }
  }
  const events: Record<string, unknown> = {}
  for (const [name, event] of Object.entries(EVENTS)) {
    events[name] = { description: event.description, data: z.toJSONSchema(event.data.extend(eventContextSchema.shape).strict()) }
  }
  return {
    protocol: PROTOCOL_VERSION,
    frames: {
      request: { v: PROTOCOL_VERSION, type: "request", id: "string", method: "string", params: "object" },
      response: { v: PROTOCOL_VERSION, type: "response", id: "string|null", ok: "boolean", result: "any", error: { code: "string", message: "string" } },
      event: { v: PROTOCOL_VERSION, type: "event", event: "string", data: "object" },
    },
    methods,
    events,
    errors: ERROR_CODES,
  }
}
