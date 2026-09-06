import packageMetadata from "../package.json" with { type: "json" }
import { normalizeInstanceName } from "./instance.ts"

export const VERSION = packageMetadata.version

export const COMMANDS = ["start", "attach", "stop", "status", "api", "doctor", "event-socket", "runtime"] as const
export type Command = (typeof COMMANDS)[number]

export type CliOptions = {
  help: boolean
  version: boolean
  /** Absent means start-if-needed and attach. */
  command: Command | null
  /** `default` for plain `smolmux`. */
  name: string
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { help: false, version: false, command: null, name: "default" }
  const positional: string[] = []
  let nameSpecified = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--name" || arg.startsWith("--name=")) {
      if (nameSpecified) throw new UsageError("--name may be specified only once")
      const value = arg === "--name" ? args[++index] : arg.slice("--name=".length)
      if (value === undefined || value === "") throw new UsageError("--name requires a value")
      try {
        options.name = normalizeInstanceName(value)
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error))
      }
      nameSpecified = true
      continue
    }
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true
        break
      case "-v":
      case "--version":
        options.version = true
        break
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`)
        positional.push(arg)
        break
    }
  }

  if (positional.length === 0) return options
  const [command, ...rest] = positional
  if (!(COMMANDS as readonly string[]).includes(command!)) {
    throw new UsageError(`unknown command: ${command}\nCommands: ${COMMANDS.filter((name) => name !== "runtime").join(", ")}.`)
  }
  if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`)
  options.command = command as Command
  return options
}

export function usage(): string {
  return `Usage: smolmux [--name NAME] [command]

A terminal multiplexer driven over a socket. Start it, stop it, and attach a
terminal to it from the command line; everything else — Sessions, the Layout,
focus — is the API that \`smolmux status\` reports the path of.

Commands:
  (none)         start the Instance if it is not running, then attach
  start          start the Instance without attaching, and print its API socket
  attach         attach this terminal to a running Instance
  stop           end every Session and the Instance
  status         print the Instance as JSON
  event-socket   print the selected live Instance's event-capable API socket
  api            print the API contract as JSON
  doctor         verify the Companion and its private directory

Options:
      --name NAME  select an independent Instance (default: default)
  -h, --help       show this help
  -v, --version    print the version

Keys:
  ctrl-b d       detach this terminal, leaving every Session running

Configuration:
  ~/.config/smolmux/config.toml (or SMOLMUX_CONFIG_PATH)
`
}
