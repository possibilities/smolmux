import { randomUUID } from "node:crypto"
import { type EventContext, type EventData, type EventName, MAX_PROJECTION_BYTES, type StateSnapshot } from "./protocol.ts"

/** Mutation callbacks and snapshots run synchronously on the Runtime's turn. */
export class EventFeed {
  private readonly instanceId = randomUUID()
  private sequence = 0

  constructor(
    private readonly read: () => Omit<StateSnapshot, keyof EventContext>,
    private readonly emit: (event: EventName, data: unknown) => void,
  ) {}

  private context(): EventContext {
    return { instanceId: this.instanceId, generation: 1, sequence: this.sequence }
  }

  snapshot(): StateSnapshot {
    // Detach all mutable Layout/Session references before returning to an await.
    const projection = JSON.stringify({ ...this.context(), ...this.read() })
    if (Buffer.byteLength(projection) > MAX_PROJECTION_BYTES) {
      return { ...this.context(), availability: "unavailable", reason: "Current projection exceeds 2 MiB", state: null }
    }
    return JSON.parse(projection) as StateSnapshot
  }

  publish<E extends EventName>(event: E, data: EventData<E>): void {
    this.sequence += 1
    const encoded = JSON.stringify({ ...data, ...this.context() })
    if (Buffer.byteLength(encoded) > MAX_PROJECTION_BYTES) {
      this.emit("state.invalidated", { ...this.context(), reason: `${event} exceeds 2 MiB` })
      return
    }
    this.emit(event, JSON.parse(encoded))
  }
}
