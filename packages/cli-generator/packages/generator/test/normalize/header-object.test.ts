import { Effect, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { DocumentUri } from "#model/brands.ts"
import type { Json } from "#model/pointer.ts"
import { headerMarks } from "#normalize/header-object.ts"
import type { HeaderMarks } from "#normalize/header-object.ts"
import { resolve } from "#resolve/index.ts"

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json")

const marksOf = (headers: Json, name: string): HeaderMarks =>
	Effect.runSync(
		resolve({
			document: entry,
			line: "3.1",
			value: {
				components: { headers },
				info: { title: "t", version: "1" },
				openapi: "3.1.1",
				paths: {}
			}
		}).pipe(
			Effect.flatMap((resolution) =>
				headerMarks(resolution, { document: entry, pointer: `/components/headers/${name}` })
			)
		)
	)

describe("headerMarks", () => {
	test("a non-boolean mark reads as false and keeps its sibling", () => {
		const headers = {
			bare: {},
			numeric: { required: 1, schema: { type: "string" } },
			referenced: { $ref: "#/components/headers/stringy" },
			stringy: { deprecated: "yes", required: true, schema: { type: "string" } }
		}

		expect(marksOf(headers, "stringy")).toEqual({ deprecated: false, required: true })
		expect(marksOf(headers, "numeric")).toEqual({ deprecated: false, required: false })
		expect(marksOf(headers, "bare")).toEqual({ deprecated: false, required: false })
		expect(marksOf(headers, "referenced")).toEqual({ deprecated: false, required: true })
	})
})
