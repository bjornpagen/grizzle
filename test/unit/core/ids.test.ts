import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { codePoint, element, type Gen, oneOf, string } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { FieldId, fieldIdSpellingParts } from "#compiler/core/ids.ts"
import { assert } from "#test/support/assert.ts"

/** A relation or field name: printable text, or one of the spellings the encoding escapes. */
const part: Gen<string> = oneOf([
	string(codePoint(0x20, 0x7e), { min: 0, max: 6 }),
	element([".", "%", "%2E", "%25", "a.b", "%%."])
])

describe("FieldId", () => {
	it.effect("is injective in (relation, field) and decodes back", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/core/ids-1",
					draw: drawn(
						(source) =>
							[source.draw(part), source.draw(part), source.draw(part), source.draw(part)] as const
					),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				([r1, f1, r2, f2]) =>
					Effect.sync(() => {
						const a = FieldId(r1, f1)
						const b = FieldId(r2, f2)
						assert.equal(a === b, r1 === r2 && f1 === f2)
						assert.deepEqual(fieldIdSpellingParts(a), { relation: r1, field: f1 })
					})
			)
		)
	)
})
