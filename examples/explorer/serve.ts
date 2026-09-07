import { parseArgs } from "node:util"
import { buildExplorer } from "./build.ts"
import { startBridge } from "./bridge.ts"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { port: { type: "string", default: "7331" } },
  strict: true,
})
const port = Number(values.port)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535")
const assets = await buildExplorer()
const bridge = startBridge({ assets, html: await Bun.file(new URL("index.html", import.meta.url)).text(), port })
console.log(
  `\nsmolmux observatory\n\n${bridge.url}\n\nOpen this local URL to explore running Instances. Ctrl+C closes the explorer.\n`,
)
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  void bridge
    .stop()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
