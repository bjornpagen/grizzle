import { Effect, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { DocumentUri } from "#model/brands.ts"
import type { Json } from "#model/pointer.ts"
import { normalizeParameter } from "#normalize/parameters.ts"
import type { ParameterOutcome } from "#normalize/parameters.ts"
import { defaultLimits, resolve } from "#resolve/index.ts"

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json")

const links = 4000

// A header parameter whose schema reaches its last schema through `links` allOf/$ref links:
// S0 -> allOf[0] -> $ref S1 -> ... -> S{links}, the last carrying `last`.
const normalize = (last: Json): ParameterOutcome => {
	const schemas: { [key: string]: Json } = {}
	for (let index = 0; index < links; index += 1) {
		schemas[`S${index}`] = { allOf: [{ $ref: `#/components/schemas/S${index + 1}` }] }
	}

	schemas[`S${links}`] = last
	const value: Json = {
		components: { schemas },
		info: { title: "t", version: "1" },
		openapi: "3.1.1",
		paths: {
			"/a": {
				get: {
					parameters: [
						{ in: "header", name: "X-Token", schema: { $ref: "#/components/schemas/S0" } }
					],
					responses: { "200": { description: "ok" } }
				}
			}
		}
	}
	const resolution = Effect.runSync(resolve({ document: entry, line: "3.1", value }))

	return Effect.runSync(
		normalizeParameter(
			resolution,
			{ openapi: "3.1.1", pointer: "/paths/~1a/get/parameters/0" },
			defaultLimits
		)
	)
}

const sensitive = (last: Json): boolean | undefined => {
	const outcome = normalize(last)
	if (outcome._tag !== "Implemented") {
		throw new Error(`expected Implemented, got ${outcome._tag}`)
	}

	return outcome.parameter.sensitive
}

describe("a parameter schema behind a deep allOf/$ref chain", () => {
	test(
		"reads an x-sensitive mark at the end of the chain without overflowing the stack",
		() => {
			expect(sensitive({ type: "string", "x-sensitive": true })).toBe(true)
		},
		{ timeout: 10_000 }
	)

	test(
		"leaves an unmarked chain unmarked without overflowing the stack",
		() => {
			expect(sensitive({ type: "string" })).toBeUndefined()
		},
		{ timeout: 10_000 }
	)
})
