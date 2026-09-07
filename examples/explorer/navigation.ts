import { fitLayout, paneGeometries } from "../../src/layout.ts"
import { ApiFailure, type LayoutNode, type Params, type StateSnapshot } from "../../src/protocol.ts"
import type { Navigation } from "./wire.ts"

export function appLeaf(root: LayoutNode | null, name: string): Extract<LayoutNode, { app: string }> | null {
  if (!root) return null
  if ("app" in root) return root.app === name ? root : null
  if ("text" in root) return null
  for (const child of "row" in root ? root.row : root.column) {
    const found = appLeaf(child, name)
    if (found) return found
  }
  return null
}

/** Never hide an App as a side effect of navigation; preserve all hidden policies. */
export function planNavigation(snapshot: StateSnapshot, request: Navigation): Params<"layout.apply"> {
  const state = snapshot.state
  if (!state || snapshot.availability !== "ready")
    throw new ApiFailure("conflict", "The Instance is not ready. Wait for it to reconnect.")
  if (snapshot.instanceId !== request.instanceId)
    throw new ApiFailure("conflict", "The Runtime restarted. Review the current Instance and try again.")
  const layout = state.layout
  if (layout.revision !== request.revision)
    throw new ApiFailure("conflict", "The Layout changed. Review its new position and try again.")
  if (!state.apps.some((app) => app.name === request.name))
    throw new ApiFailure("not_found", "This App is no longer declared.")
  const leaf = appLeaf(layout.root, request.name)
  if (leaf?.focusMode === "never") throw new ApiFailure("invalid_params", "This Pane does not permit Focus.")
  if (request.action === "focus") {
    if (!leaf || !layout.panes.some((pane) => pane.app === request.name && pane.cols > 0 && pane.rows > 0)) {
      throw new ApiFailure(
        "invalid_params",
        "This App has no fitted Pane. Enlarge the terminal or reveal the App first.",
      )
    }
    return { root: layout.root, visible: [...layout.visible], focus: request.name, revision: layout.revision }
  }
  if (leaf)
    throw new ApiFailure(
      "conflict",
      "This App is already in the Layout. Enlarge the terminal if it has been squeezed out.",
    )
  // Root size/min did not participate in fitting. Do not activate them when wrapping it.
  const root = layout.root ? { ...layout.root } : null
  if (root) {
    delete root.size
    delete root.min
  }
  const next: LayoutNode = root ? { row: [root, { app: request.name, min: 20 }] } : { app: request.name }
  const fitted = paneGeometries(fitLayout(next, layout.stage), request.name)
  const target = fitted.find((pane) => pane.app === request.name)
  if (
    !target ||
    target.cols < 20 ||
    target.rows < 4 ||
    layout.panes.some(
      (pane) =>
        pane.app &&
        pane.cols > 0 &&
        pane.rows > 0 &&
        !fitted.some((nextPane) => nextPane.app === pane.app && nextPane.cols > 0 && nextPane.rows > 0),
    )
  )
    throw new ApiFailure(
      "invalid_params",
      "The Stage is too small to reveal this App beside the current Layout. Enlarge the terminal first.",
    )
  return {
    root: next,
    visible: [...new Set([...layout.visible, request.name])],
    focus: request.name,
    revision: layout.revision,
  }
}
