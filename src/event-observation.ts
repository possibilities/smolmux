import { type EventFrame, isTransientEvent, type StateSnapshot } from "./protocol.ts"

/** A connection's replaceable current projection. Transient delivery is separate. */
export class EventObservation {
  current: StateSnapshot | null = null

  replace(snapshot: StateSnapshot): void {
    this.current = snapshot
  }

  unavailable(): void {
    this.current = null
  }

  apply(frame: EventFrame): boolean {
    const snapshot = this.current
    if (!snapshot) return false
    const data = frame.data
    if (data.instanceId !== snapshot.instanceId || data.generation !== snapshot.generation) {
      this.unavailable()
      return true
    }
    if (isTransientEvent(frame.event) || data.sequence <= snapshot.sequence) return false
    snapshot.sequence = data.sequence
    if (frame.event === "state.invalidated") {
      snapshot.availability = "unavailable"
      snapshot.reason = frame.data.reason
      snapshot.state = null
      return true
    }
    const state = snapshot.state
    if (!state) return false
    switch (frame.event) {
      case "sessions.changed":
        state.sessions = frame.data.sessions
        snapshot.availability = frame.data.availability
        snapshot.reason = frame.data.reason
        break
      case "session.state": {
        const session = state.sessions.find((row) => row.name === frame.data.name)
        if (session) session.state = frame.data.state
        break
      }
      case "layout.changed":
        state.layout = frame.data.layout
        state.stage = frame.data.layout.stage
        state.sessions = frame.data.sessions
        break
      case "stage.changed":
        state.stage = { cols: frame.data.cols, rows: frame.data.rows }
        break
      case "theme.changed":
        state.theme = frame.data.theme
        break
      case "instance.stopping":
        snapshot.availability = "unavailable"
        snapshot.reason = "Instance is stopping"
        break
    }
    return true
  }
}
