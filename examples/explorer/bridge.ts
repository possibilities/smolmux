import type { ServerWebSocket } from "bun"
import { join } from "node:path"
import { z } from "zod"
import { ApiClient } from "../../src/api-client.ts"
import { APP_NAME, type StateSnapshot, type EventFrame } from "../../src/protocol.ts"
import { checkEventSocketOwnership } from "../../src/unix-socket.ts"
import { discoverInstances, identify, instancePattern, socketDirectory } from "./discovery.ts"
import { planNavigation } from "./navigation.ts"
import type { BrowserMessage, Discovery, ExplorerMessage } from "./wire.ts"
import { defaultAppearance, type TerminalAppearance } from "./appearance.ts"

const messageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("navigate"),
      id: z.string().min(1).max(64),
      instanceId: z.string().min(1).max(128),
      revision: z.int().min(0),
      name: z.string().regex(APP_NAME),
      action: z.enum(["focus", "reveal"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("history"),
      id: z.string().min(1).max(64),
      name: z.string().regex(APP_NAME),
      sessionId: z.string().uuid(),
    })
    .strict(),
])

export type Peer = {
  instance: string
  closed: boolean
  client?: ApiClient
  snapshot: StateSnapshot | null
  dirty: Map<string, string>
  capturing: boolean
  captureTimer?: ReturnType<typeof setTimeout>
  refreshTimer?: ReturnType<typeof setTimeout>
  requests: Set<string>
}

type BridgeOptions = { assets: Map<string, Blob>; html: string; port?: number; directory?: string; token?: string; appearance?: TerminalAppearance }
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Local capability URL + exact Origin/Host checks. Only the operations above cross this bridge. */
export function startBridge(options: BridgeOptions) {
  const token = options.token ?? crypto.randomUUID() + crypto.randomUUID()
  const directory = options.directory ?? socketDirectory
  let discovery: Promise<Discovery> | undefined
  let discoveryTime = 0
  const peers = new Set<ServerWebSocket<Peer>>()
  const report = (error: unknown) => console.error(`Explorer: ${messageOf(error)}`)
  const send = (ws: ServerWebSocket<Peer>, message: ExplorerMessage) => {
    if (!ws.data.closed) ws.send(JSON.stringify(message))
  }
  const scheduleCaptures = (ws: ServerWebSocket<Peer>) => {
    const peer = ws.data
    if (peer.closed || peer.capturing || peer.captureTimer || !peer.dirty.size) return
    peer.captureTimer = setTimeout(() => {
      peer.captureTimer = undefined
      void captureBatch(ws).catch(report)
    }, 120)
  }
  async function captureBatch(ws: ServerWebSocket<Peer>) {
    const peer = ws.data
    if (peer.closed || !peer.client) return
    peer.capturing = true
    try {
      const batch = [...peer.dirty.entries()].slice(0, 4)
      batch.forEach(([name]) => peer.dirty.delete(name))
      await Promise.all(
        batch.map(async ([name, sessionId]) => {
          try {
            const capture = await peer.client!.request("app.capture", { name, sessionId })
            if (peer.snapshot?.state?.apps.some((app) => app.name === name && app.session?.id === sessionId))
              send(ws, { type: "capture", capture })
          } catch (error) {
            // Replacement/exit between event and capture is normal; the projection retires it.
            if (
              !peer.closed &&
              !["not_found", "not_running", "conflict"].includes((error as { code?: string }).code ?? "")
            ) {
              send(ws, { type: "error", message: `Capture for ${name}: ${messageOf(error)}` })
            }
          }
        }),
      )
    } finally {
      peer.capturing = false
      scheduleCaptures(ws)
    }
  }
  function updateState(ws: ServerWebSocket<Peer>, snapshot: StateSnapshot | null) {
    const peer = ws.data
    if (peer.closed) return
    // ApiClient's observation mutates its projection; keep immutable identity/size keys separately.
    const previous = peer.snapshot
    peer.snapshot = snapshot ? structuredClone(snapshot) : null
    const apps = snapshot?.state?.apps ?? []
    for (const [name, id] of peer.dirty)
      if (!apps.some((app) => app.name === name && app.session?.id === id)) peer.dirty.delete(name)
    for (const app of apps) {
      const old = previous?.state?.apps.find((candidate) => candidate.name === app.name)
      if (
        app.session &&
        (old?.session?.id !== app.session.id ||
          old.cols !== app.cols ||
          old.rows !== app.rows ||
          old.state !== app.state)
      ) {
        peer.dirty.set(app.name, app.session.id)
      }
    }
    send(ws, { type: "state", snapshot })
    scheduleCaptures(ws)
    clearTimeout(peer.refreshTimer)
    // Invalidated projections cannot be repaired by applying deltas to null.
    // Resubscribe + resnapshot, keeping the watermark boundary in ApiClient.
    if (snapshot && (!snapshot.state || snapshot.availability !== "ready")) {
      peer.refreshTimer = setTimeout(() => {
        if (!peer.closed)
          void peer.client
            ?.observe((next) => updateState(ws, next))
            .catch((error) => {
              report(error)
              ws.close(1012, "Observation unavailable")
            })
      }, 1500)
    }
  }
  function onEvent(ws: ServerWebSocket<Peer>, event: EventFrame) {
    if (event.event !== "session.changed" || ws.data.closed) return
    const { name, sessionId } = event.data
    if (!ws.data.snapshot?.state?.apps.some((app) => app.name === name && app.session?.id === sessionId)) return
    ws.data.dirty.set(name, sessionId)
    send(ws, { type: "activity", name, sessionId, at: Date.now() })
    scheduleCaptures(ws)
  }
  async function open(ws: ServerWebSocket<Peer>) {
    const peer = ws.data
    const path = join(directory, `${peer.instance}.api`)
    let client: ApiClient | undefined
    try {
      await checkEventSocketOwnership(path)
      if (peer.closed) return
      client = await ApiClient.connect(path, {
        timeoutMs: 5000,
        onEvent: (event) => onEvent(ws, event),
        onClose: () => {
          send(ws, { type: "state", snapshot: null })
          ws.close(1012, "Instance disconnected")
        },
      })
      if (peer.closed) {
        client.close()
        return
      }
      peer.client = client
      const status = await client.request("instance.status")
      identify(status, peer.instance, path)
      if (peer.closed) return
      await client.observe((snapshot) => updateState(ws, snapshot))
    } catch (error) {
      send(ws, { type: "error", message: messageOf(error) })
      client?.close()
      ws.close(1012, "Instance unavailable")
    }
  }
  async function receive(ws: ServerWebSocket<Peer>, raw: string | Buffer) {
    const peer = ws.data
    let message: BrowserMessage
    try {
      message = messageSchema.parse(JSON.parse(String(raw)))
    } catch {
      send(ws, { type: "error", message: "Unknown explorer request." })
      return
    }
    if (!peer.client || peer.closed || peer.requests.size >= 4 || peer.requests.has(message.id)) {
      send(ws, { type: "error", id: message.id, message: "The connection is busy or unavailable. Try again shortly." })
      return
    }
    peer.requests.add(message.id)
    try {
      if (message.type === "history") {
        const capture = await peer.client.request("app.capture", {
          name: message.name,
          sessionId: message.sessionId,
          scrollback: 200,
        })
        send(ws, { type: "history", id: message.id, capture })
      } else {
        const snapshot = await peer.client.request("state.get")
        const params = planNavigation(snapshot, message)
        const layout = await peer.client.request("layout.apply", params)
        send(ws, { type: "navigated", id: message.id, layout })
      }
    } catch (error) {
      send(ws, { type: "error", id: message.id, message: messageOf(error) })
    } finally {
      peer.requests.delete(message.id)
    }
  }
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  }
  const server = Bun.serve<Peer>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    maxRequestBodySize: 4096,
    fetch(request, server) {
      const url = new URL(request.url)
      const authority = `127.0.0.1:${server.port}`
      const origin = `http://${authority}`
      const respond = (body: BodyInit | null, status = 200, extra = {}) =>
        new Response(body, { status, headers: { ...headers, ...extra } })
      if (
        request.headers.get("host") !== authority ||
        (request.headers.has("origin") && request.headers.get("origin") !== origin)
      )
        return respond("Local access only", 403)
      if (request.method !== "GET") return respond("Method not allowed", 405)
      if (url.pathname === "/") return respond(options.html, 200, { "Content-Type": "text/html; charset=utf-8" })
      const asset = options.assets.get(url.pathname)
      if (asset) return respond(asset, 200, { "Content-Type": asset.type })
      if (url.pathname === "/favicon.svg")
        return respond(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#e9f0f3"/><path d="m12 34 20-12 20 12-20 12zM12 25l20-12 20 12M12 43l20 12 20-12" fill="none" stroke="#3d64da" stroke-width="4"/></svg>',
          200,
          { "Content-Type": "image/svg+xml" },
        )
      if (url.pathname === "/appearance") {
        if (request.headers.get("authorization") !== `Bearer ${token}`) return respond("Unauthorized", 401)
        return respond(JSON.stringify(options.appearance ?? defaultAppearance), 200, { "Content-Type": "application/json" })
      }
      if (url.pathname === "/instances") {
        if (request.headers.get("authorization") !== `Bearer ${token}`)
          return respond("Open the full URL printed by bun run explorer.", 401)
        if (!discovery || Date.now() - discoveryTime > 2000) {
          discoveryTime = Date.now()
          discovery = discoverInstances(directory)
        }
        return discovery
          .then((value) => respond(JSON.stringify(value), 200, { "Content-Type": "application/json" }))
          .catch((error) =>
            respond(JSON.stringify({ instances: [], skipped: 0, warning: messageOf(error) }), 503, {
              "Content-Type": "application/json",
            }),
          )
      }
      if (url.pathname === "/live") {
        const instance = url.searchParams.get("instance") ?? ""
        if (
          request.headers.get("origin") !== origin ||
          url.searchParams.get("token") !== token ||
          !instancePattern.test(instance)
        )
          return respond("Unauthorized explorer connection", 403)
        if (peers.size >= 12) return respond("Too many explorer connections", 429)
        if (
          server.upgrade(request, {
            data: { instance, closed: false, snapshot: null, dirty: new Map(), capturing: false, requests: new Set() },
          })
        )
          return
        return respond("WebSocket upgrade required", 426)
      }
      return respond("Not found", 404)
    },
    websocket: {
      maxPayloadLength: 4096,
      backpressureLimit: 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        peers.add(ws)
        void open(ws).catch(report)
      },
      message(ws, message) {
        void receive(ws, message).catch(report)
      },
      close(ws) {
        peers.delete(ws)
        ws.data.closed = true
        clearTimeout(ws.data.captureTimer)
        clearTimeout(ws.data.refreshTimer)
        ws.data.dirty.clear()
        ws.data.client?.close()
      },
    },
  })
  return {
    server,
    url: `http://127.0.0.1:${server.port}/#${token}`,
    token,
    async stop() {
      for (const peer of peers) {
        peer.close()
        peer.data.client?.close()
      }
      await server.stop(true)
    },
  }
}
