import {
  bold,
  BoxRenderable,
  fg,
  type KeyEvent,
  type RenderContext,
  StyledText,
  TextRenderable,
} from "@opentui/core"
import {
  AGENTWORKPLACE_CONTRACT_VERSION,
  RUNTIME_EXTENSION_SCHEMA_ID,
  runtimeExtensionMessageSchema,
  type RuntimeExtensionMessage,
} from "./agentworkplace-contracts.ts"
import { type FxnkTheme, fxnkRamp, type Ramp } from "./host-palette.ts"

type RecoveryCardPublishMessage = Extract<RuntimeExtensionMessage, { card: unknown }>
type FrozenRecoveryCard = RecoveryCardPublishMessage["card"]

/** The exact single-action card carried by the frozen Runtime-extension wire. */
export type RecoveryCardSpec = Readonly<
  Omit<FrozenRecoveryCard, "action"> & { action: Readonly<FrozenRecoveryCard["action"]> }
>

/** Opaque structural correlation. The Runtime integration adds its own request id. */
export type RecoveryCardActionCorrelation = Readonly<{
  slot_id: string
  card_revision: string
  action_id: string
}>

export type RecoveryCardOptions = {
  card: RecoveryCardSpec
  onAction: (correlation: RecoveryCardActionCorrelation) => void
  selected?: boolean
  theme?: FxnkTheme
  visible?: boolean
}

export class RecoveryCardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RecoveryCardError"
  }
}

/**
 * Validate through the canonical Phase 0 schema instead of growing a second
 * set of text, identity, revision, or single-action limits in the renderer.
 */
export function parseRecoveryCard(value: unknown): RecoveryCardSpec {
  const parsed = runtimeExtensionMessageSchema.safeParse({
    schema_id: RUNTIME_EXTENSION_SCHEMA_ID,
    schema_version: AGENTWORKPLACE_CONTRACT_VERSION,
    message_type: "unavailable_slot_publish",
    request_id: "recovery-card-validation",
    fmx_session: "default",
    card: value,
  })
  if (
    !parsed.success ||
    parsed.data.message_type !== "unavailable_slot_publish" ||
    !("card" in parsed.data)
  ) {
    const issue = parsed.success ? undefined : parsed.error.issues[0]
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : ""
    throw new RecoveryCardError(`${issue?.message ?? "invalid recovery card"}${at}`)
  }
  const card = parsed.data.card
  return {
    slot_id: card.slot_id,
    card_revision: card.card_revision,
    title: card.title,
    message: card.message,
    action: { action_id: card.action.action_id, label: card.action.label },
  }
}

/**
 * One bounded, role-neutral unavailable-slot surface. Selection and key
 * routing remain the owner's policy: this renderable never takes focus, and
 * activation never changes its selected state. A direct pointer press or an
 * owner-routed key invokes the same opaque callback.
 */
export class RecoveryCard extends BoxRenderable {
  readonly surface: BoxRenderable
  readonly titleText: TextRenderable
  readonly messageText: TextRenderable
  readonly actionButton: BoxRenderable
  readonly actionText: TextRenderable

  private card: RecoveryCardSpec
  private ramp: Ramp
  private selectedState: boolean
  private readonly onAction: RecoveryCardOptions["onAction"]

  constructor(ctx: RenderContext, options: RecoveryCardOptions) {
    const card = parseRecoveryCard(options.card)
    const ramp = fxnkRamp(options.theme ?? "dark")
    super(ctx, {
      id: recoveryCardId(card.slot_id),
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: ramp.background,
      visible: options.visible ?? true,
    })
    this.card = card
    this.ramp = ramp
    this.selectedState = options.selected ?? false
    this.onAction = options.onAction

    this.surface = new BoxRenderable(ctx, {
      id: recoveryCardChildId(card.slot_id, "surface"),
      width: "80%",
      maxWidth: 72,
      height: "75%",
      maxHeight: 16,
      flexDirection: "column",
      flexShrink: 1,
      paddingX: 1,
      paddingY: 1,
      rowGap: 1,
      border: true,
      borderStyle: "single",
      borderColor: ramp.divider,
      focusedBorderColor: ramp.divider,
      backgroundColor: ramp.background,
      shouldFill: true,
    })
    this.titleText = new TextRenderable(ctx, {
      id: recoveryCardChildId(card.slot_id, "title"),
      width: "100%",
      height: 1,
      flexShrink: 0,
      content: "",
      fg: ramp.foreground,
      bg: ramp.background,
      selectable: true,
      truncate: true,
    })
    this.messageText = new TextRenderable(ctx, {
      id: recoveryCardChildId(card.slot_id, "message"),
      width: "100%",
      height: 0,
      flexGrow: 1,
      flexShrink: 1,
      content: "",
      fg: ramp.secondary,
      bg: ramp.background,
      selectable: true,
      wrapMode: "word",
      truncate: true,
    })
    this.actionButton = new BoxRenderable(ctx, {
      id: recoveryCardChildId(card.slot_id, "action"),
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: ramp.surface,
      onMouseDown: (event) => {
        if (event.button !== 0 || !this.activate()) return
        event.preventDefault()
        event.stopPropagation()
      },
      onMouseUp: (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
      },
    })
    this.actionText = new TextRenderable(ctx, {
      id: recoveryCardChildId(card.slot_id, "action-label"),
      width: "100%",
      height: 1,
      content: "",
      fg: ramp.foreground,
      bg: ramp.surface,
      selectable: false,
      truncate: true,
    })

    this.actionButton.add(this.actionText)
    this.surface.add(this.titleText)
    this.surface.add(this.messageText)
    this.surface.add(this.actionButton)
    this.add(this.surface)
    this.paint()
  }

  get selected(): boolean {
    return this.selectedState
  }

  /** Update a published card in place so text selection never points at stale renderables. */
  setCard(value: RecoveryCardSpec): void {
    const card = parseRecoveryCard(value)
    this.card = card
    this.id = recoveryCardId(card.slot_id)
    this.surface.id = recoveryCardChildId(card.slot_id, "surface")
    this.titleText.id = recoveryCardChildId(card.slot_id, "title")
    this.messageText.id = recoveryCardChildId(card.slot_id, "message")
    this.actionButton.id = recoveryCardChildId(card.slot_id, "action")
    this.actionText.id = recoveryCardChildId(card.slot_id, "action-label")
    this.paintText()
    this.requestRender()
  }

  setSelected(selected: boolean): void {
    if (selected === this.selectedState) return
    this.selectedState = selected
    this.paintColors()
    this.requestRender()
  }

  applyTheme(theme: FxnkTheme): void {
    this.ramp = fxnkRamp(theme)
    this.paint()
    this.requestRender()
  }

  /** Handle only plain activation keys; the integration decides when to route them here. */
  handleKeyPress(key: KeyEvent): boolean {
    if (!isActivationKey(key)) return false
    return this.activate()
  }

  activate(): boolean {
    if (this.isDestroyed || !this.visible) return false
    this.onAction({
      slot_id: this.card.slot_id,
      card_revision: this.card.card_revision,
      action_id: this.card.action.action_id,
    })
    return true
  }

  private paint(): void {
    this.paintColors()
    this.paintText()
  }

  private paintColors(): void {
    const surfaceBackground = this.selectedState ? this.ramp.surface : this.ramp.background
    const border = this.selectedState ? this.ramp.accent : this.ramp.divider
    this.backgroundColor = this.ramp.background
    this.surface.backgroundColor = surfaceBackground
    this.surface.borderColor = border
    // The card never takes focus, so a toolkit focus accident must not invent
    // the focus hue. Selection remains the Ramp-only fill and border step.
    this.surface.focusedBorderColor = border
    this.titleText.fg = this.ramp.foreground
    this.titleText.bg = surfaceBackground
    this.messageText.fg = this.ramp.secondary
    this.messageText.bg = surfaceBackground
    this.actionButton.backgroundColor = this.ramp.surface
    this.actionText.fg = this.ramp.foreground
    this.actionText.bg = this.ramp.surface
  }

  private paintText(): void {
    this.titleText.content = new StyledText([bold(fg(this.ramp.foreground)(this.card.title))])
    this.messageText.content = new StyledText([fg(this.ramp.secondary)(this.card.message)])
    this.actionText.content = new StyledText([
      fg(this.ramp.accent)("❯ "),
      bold(fg(this.ramp.foreground)(this.card.action.label)),
    ])
  }
}

function isActivationKey(key: KeyEvent): boolean {
  if (key.ctrl || key.meta || key.option || key.super || key.hyper) return false
  const name = key.name.toLowerCase()
  return name === "enter" || name === "return" || name === "space"
}

function recoveryCardId(slotId: string): string {
  return `fmx-recovery-card-${slotId}`
}

function recoveryCardChildId(slotId: string, child: string): string {
  return `${recoveryCardId(slotId)}-${child}`
}
