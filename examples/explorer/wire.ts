import type { Capture, InstanceStatus, LayoutView, StateSnapshot } from "../../src/protocol.ts"

/** This example's browser transport, not an extension to the smolmux API. */
export type InstanceSummary = {
  id: string
  name: string
  host: InstanceStatus["host"]
  apps: number
  running: number
  hidden: number
}
export type Discovery = { instances: InstanceSummary[]; skipped: number; warning: string | null }
export type Navigation = {
  type: "navigate"
  id: string
  instanceId: string
  revision: number
  name: string
  action: "focus" | "reveal"
}
export type BrowserMessage = Navigation | { type: "history"; id: string; name: string; sessionId: string }
export type ExplorerMessage =
  | { type: "state"; snapshot: StateSnapshot | null }
  | { type: "capture"; capture: Capture }
  | { type: "activity"; name: string; sessionId: string; at: number }
  | { type: "history"; id: string; capture: Capture }
  | { type: "navigated"; id: string; layout: LayoutView }
  | { type: "error"; id?: string; message: string }
