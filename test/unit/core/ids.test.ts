import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { codePoint, element, type Gen, oneOf, string } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, pipe, String as Str } from "effect"
import { FieldId } from "#compiler/core/ids.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * The relation and field a FieldId's spelling names: its components at each unescaped dot, so a correct encoding has
 * exactly two, each read back with "%2E" a dot and "%25" a percent sign.
 */
const spelledParts = (spelling: string): ReadonlyArray<string> =>
	Arr.map(Str.split(spelling, "."), (part) =>
		pipe(part, Str.replaceAll("%2E", "."), Str.replaceAll("%25", "%"))
	)

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
					oracle: { kind: "unstated" },
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
					caseHang
				},
				([r1, f1, r2, f2]) =>
					Effect.sync(() => {
						const a = FieldId(r1, f1)
						const b = FieldId(r2, f2)
						assert.equal(a === b, r1 === r2 && f1 === f2)
						assert.deepEqual(spelledParts(a), [r1, f1])
					})
			)
		)
	)
})
