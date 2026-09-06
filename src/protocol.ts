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
export const PROTOCOL_VERSION = 1

export const SESSION_NAME = /^[a-z][a-z0-9_-]{0,31}$/u

const sessionName = z.string().regex(SESSION_NAME).describe("Session name: [a-z][a-z0-9_-]{0,31}")
const theme = z.enum(["dark", "light"])
/** `null` as its own `anyOf` branch, described, so JSON Schema readers keep it. */
const NONE = z.null().describe("null when there is none")
const labelToken = z.string().regex(/^[A-Za-z0-9_.-]+$/u)

export const stageSchema = z.object({
  cols: z.int().min(1),
  rows: z.int().min(1),
})
export type Stage = z.infer<typeof stageSchema>

export const sessionViewSchema = z.object({
  name: sessionName,
  pid: z.int().or(NONE).describe("The child's pid; null while unknown"),
  cwd: z.string(),
  argv: z.array(z.string()).or(NONE).describe("The argv it was created with; null when adopted from a previous Runtime"),
  created_at: z.number().describe("ms since the epoch"),
  title: z.string().describe("The last OSC 0/2 title the Session set; empty until it sets one"),
  cols: z.int().min(1),
  rows: z.int().min(1),
  shown: z.boolean().describe("Whether a Pane of the current Layout shows it"),
  state: z.enum(["live", "unreachable"]).describe("unreachable: its transport dropped and could not be reopened yet"),
  labels: z.record(labelToken, z.string()),
})
export type SessionView = z.infer<typeof sessionViewSchema>

const sizedLeaf = {
  size: z.int().min(1).optional().describe("Fixed columns in a row, rows in a column; omitted takes the remainder"),
  min: z.int().min(1).optional().describe("The smallest length along this node's parent's axis; default 1"),
}

export type LayoutNode =
  | { row: LayoutNode[]; size?: number; min?: number }
  | { column: LayoutNode[]; size?: number; min?: number }
  | { session: string; size?: number; min?: number }
  | { text: string; size?: number; min?: number }

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
    z.object({ session: sessionName, ...sizedLeaf }).strict(),
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
  session: sessionName.or(NONE),
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
  root: layoutNodeSchema.or(NONE).describe("The applied tree with sizes as they stand after drags"),
  focus: sessionName.or(NONE).describe("The Session the keyboard goes to"),
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
  name: sessionName,
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
    .enum(["live", "unreachable"])
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
  sessions: z.array(sessionViewSchema),
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

export const METHODS = {
  "state.get": {
    description: "Atomic complete current projection and publication watermark, independent of filters; explicit incomplete/unavailable adoption or size limits. Subscribe first. Transient notifications are not superseded by this watermark.",
    params: empty,
    result: stateSnapshotSchema,
  },
  "instance.status": {
    description: "The Runtime as it stands: version, stage size, theme, every Session, and the Layout.",
    params: empty,
    result: instanceStatusSchema,
  },
  "instance.stop": {
    description:
      "Kill every Session, then respond and end the Runtime; every Client detaches. Refused with companion_error, and the Instance left running, when any Session could not be ended — so success means every process is gone.",
    params: empty,
    result: empty,
  },
  "event.subscribe": {
    description: "Replace this connection's event filters; acknowledgment is the replacement boundary. Default *, exact names or literal trailing-* prefixes.",
    params: eventSubscriptionSchema,
    result: z.object({ subscribed: z.literal(true), events: eventFiltersSchema }).strict(),
  },
  "session.create": {
    description:
      "Start a command in a Companion-held PTY under a caller-chosen name. It runs whether or not a Pane shows it; put it in the Layout with layout.apply. Initial size is limited to 262144 cells and 4096 per dimension.",
    params: z
      .object({
        name: sessionName,
        argv: z.array(z.string().min(1)).min(1).describe("The executable first"),
        cwd: z.string().min(1).describe("An absolute directory"),
        env: z.record(z.string(), z.string()).optional().describe("Applied over smolmux's own environment with its private variables removed"),
        cols: z.int().min(1).max(4096).optional().describe("The PTY size until a Pane sizes it; default 80"),
        rows: z.int().min(1).max(4096).optional().describe("default 24"),
        labels: z.record(labelToken, labelToken).optional().describe("Caller labels kept on the Companion session; owner, instance, and session are smolmux's"),
      })
      .strict()
      .refine((params) => (params.cols ?? 80) * (params.rows ?? 24) <= 262_144, "initial size must not exceed 262144 cells"),
    result: sessionViewSchema,
  },
  "session.kill": {
    description: "Ask the Companion to end a Session's process. Its removal arrives as session.exited.",
    params: z.object({ name: sessionName }).strict(),
    result: empty,
  },
  "session.list": {
    description: "Every Session in creation order.",
    params: empty,
    result: z.object({ sessions: z.array(sessionViewSchema) }),
  },
  "session.capture": {
    description:
      "A Session's screen as text, with its cursor and title, shown or not. `scrollback` asks for that many lines that have scrolled off the top, read from the Session's own emulator.",
    params: z
      .object({
        name: sessionName,
        scrollback: z
          .int()
          .min(0)
          .max(MAX_CAPTURE_SCROLLBACK)
          .optional()
          .describe(`Lines of history above the screen; at most ${MAX_CAPTURE_SCROLLBACK}, default none`),
      })
      .strict(),
    result: captureSchema,
  },
  "session.input": {
    description:
      "Deliver keyboard, text, paste and mouse input to a Session as a human at its keyboard would. Events apply in order and are encoded for the terminal modes that Session has turned on, so a caller never writes an escape sequence. Input never moves focus, and a Session takes input whether or not a Pane shows it — except mouse, which needs the coordinates only a Pane gives it.",
    params: z
      .object({
        name: sessionName,
        events: z.array(inputEventSchema).min(1).max(MAX_INPUT_EVENTS),
      })
      .strict(),
    result: empty,
  },
  "layout.apply": {
    description:
      "Replace the Layout with a tree of rows and columns whose leaves show Sessions or a line of text, and name the Session the keyboard goes to. Sessions in no Pane keep running at their last size.",
    params: z
      .object({
        root: layoutNodeSchema.or(NONE),
        focus: sessionName.or(NONE).optional().describe("Omitted keeps the focus if that Session is still shown"),
        revision: z
          .int()
          .min(0)
          .optional()
          .describe(
            "The revision this tree was built from. The apply is refused as a conflict when the Layout has moved since, so a human's divider drag is never silently clobbered by a stale read-modify-write.",
          ),
      })
      .strict(),
    result: layoutViewSchema,
  },
  "layout.get": {
    description: "The Layout as fitted to the stage right now.",
    params: empty,
    result: layoutViewSchema,
  },
  "client.copy": {
    description:
      "Put text on the clipboard of the terminal every attached Client runs in, the way a mouse selection copy does: the Runtime writes one OSC 52 sequence into its output and each Client relays it to its terminal, so a copy lands where a human attached over SSH is sitting. Write-only; terminals refuse OSC 52 reads. Nothing is kept: a Client that attaches later receives nothing. `written` is false when the host terminal was detected as not supporting OSC 52.",
    params: z
      .object({ text: z.string().min(1).max(MAX_INPUT_PASTE).describe("What the clipboard should hold; as much as a paste") })
      .strict(),
    result: z.object({ written: z.boolean().describe("Whether the sequence was written; false when OSC 52 is known unsupported") }).strict(),
  },
} as const

export type Method = keyof typeof METHODS
export const METHOD_NAMES = Object.keys(METHODS) as Method[]
export type Params<M extends Method> = z.input<(typeof METHODS)[M]["params"]>
export type Result<M extends Method> = z.infer<(typeof METHODS)[M]["result"]>

export const EVENTS = {
  "sessions.changed": {
    description: "Current state: replace the Session roster, including sizes, titles, visibility and reachability. Removal does not imply successful completion.",
    data: z.object({ sessions: z.array(sessionViewSchema), availability: availabilitySchema, reason: z.string().nullable() }),
  },
  "state.invalidated": {
    description: "Current state: the event exceeded the 2 MiB projection limit; invalidate observation and request state.get. No partial projection is complete.",
    data: z.object({ reason: z.string() }),
  },
  "session.exited": {
    description: "Transient: a Session's process ended, or adoption found it gone. code and signal are null when the Companion could not read them.",
    data: z.object({
      name: sessionName,
      code: z.int().or(NONE),
      signal: z.int().or(NONE),
      reason: z.string(),
    }),
  },
  "session.state": {
    description:
      "Current state: a Session's transport was lost or came back. Input to an unreachable Session is refused; its screen stays readable as the one it last had.",
    data: z.object({ name: sessionName, state: z.enum(["live", "unreachable"]) }),
  },
  "session.changed": {
    description: "Transient: output or a title change reached a Session's screen; debounced. Capture it to read it.",
    data: z.object({ name: sessionName, title: z.string() }),
  },
  "layout.changed": {
    description: "Current state: the fitted Layout changed: an apply, a divider drag, or a stage resize.",
    data: z.object({ layout: layoutViewSchema, sessions: z.array(sessionViewSchema), cause: z.enum(["apply", "drag", "resize"]) }),
  },
  "stage.changed": {
    description: "Current state: the stage took a new size from its sizing owner.",
    data: stageSchema,
  },
  "theme.changed": {
    description: "Current state: the resolved fxnk theme changed.",
    data: z.object({ theme }),
  },
  "instance.stopping": {
    description: "Current state: instance.stop was accepted; the socket closes after this.",
    data: empty,
  },
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
