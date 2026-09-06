import { z } from "zod"
import { eventFrameSchema, METHOD_NAMES, METHODS, requestSchema, responseFrameSchema } from "./protocol.ts"

const requests = z.union(METHOD_NAMES.map((method) => requestSchema.extend({
  method: z.literal(method),
  params: METHODS[method].params.safeParse({}).success ? METHODS[method].params.nullish() : METHODS[method].params,
}))).meta({ id: "requests" })
const responses = z.union([
  ...METHOD_NAMES.map((method) => responseFrameSchema.options[0].extend({ result: METHODS[method].result })),
  responseFrameSchema.options[1],
]).meta({ id: "responses" })

export const eventSocketFrameSchema = z.union([requests, responses, eventFrameSchema])

export function eventSchemaDocument(): Record<string, unknown> {
  return z.toJSONSchema(eventSocketFrameSchema, { target: "draft-2020-12", io: "input" })
}

if (import.meta.main) {
  await Bun.write(new URL("../events.schema.json", import.meta.url), `${JSON.stringify(eventSchemaDocument(), null, 2)}\n`)
}
