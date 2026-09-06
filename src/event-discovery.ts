import { checkEventSocketOwnership } from "./unix-socket.ts"
import { ApiClient } from "./api-client.ts"
import { apiSocketPathFor } from "./api-server.ts"
import type { Instance } from "./instance.ts"

export async function discoverEventSocket(instance: Instance): Promise<string> {
  const path = apiSocketPathFor(instance.id)
  await checkEventSocketOwnership(path)
  const client = await ApiClient.connect(path, { timeoutMs: 1000 })
  try {
    // A successful subscription proves this live endpoint speaks the event API.
    await client.request("event.subscribe", { events: ["discovery.none"] })
    const status = await client.request("instance.status")
    if (status.instance_id !== instance.id || status.name !== instance.name || status.socket !== path) {
      throw new Error("event socket does not identify the selected Instance")
    }
    await checkEventSocketOwnership(path)
    return path
  } finally { client.close() }
}
