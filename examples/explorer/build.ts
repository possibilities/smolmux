import { basename, join } from "node:path"

export async function buildExplorer(): Promise<Map<string, Blob>> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "main.ts")],
    target: "browser",
    minify: true,
    naming: { entry: "explorer.[ext]", asset: "[name]-[hash].[ext]" },
    loader: { ".woff2": "file", ".woff": "file" },
  })
  if (!result.success) throw new AggregateError(result.logs, "Explorer build failed")
  return new Map(result.outputs.map((output) => [`/assets/${basename(output.path)}`, output]))
}

if (import.meta.main) {
  const assets = await buildExplorer()
  console.log(
    `Explorer built: ${assets.size} local assets, ${Math.round([...assets.values()].reduce((sum, asset) => sum + asset.size, 0) / 1024)} KiB`,
  )
}
