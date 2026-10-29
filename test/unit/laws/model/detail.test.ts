/**
 * DetailCodec: the versioned key-tuple text of a residual law's DETAIL.
 *
 * - Composite keys round-trip, whatever their text holds: quotes, backslashes, commas, brackets, control characters,
 *   supplementary-plane characters.
 * - Decoding trusts its text: the runtime reads a residual law's DETAIL only from that law's own function, so
 *   decodeDetail checks nothing, and the strict reading (test/support/detail.ts strictDetail) is the tests'.
 * - The law function's expression is audited with every installed law function (test/unit/sql/audit.test.ts's
 *   audit-live), and PostgreSQL's own spelling of it is read back in test/pg/laws/detail.test.ts.
 *
 * Quotes, backslashes, commas, brackets, control and supplementary-plane characters are planted beside drawn text.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noFeatures } from "@grizzle/testing/features"
import { codePoint, element, oneOf, string } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import type { NamedDetailCodec } from "#compiler/ir/law.ts"
import { decodeDetail } from "#compiler/laws/model/detail.ts"
import { assert } from "#test/support/assert.ts"
import { encodeDetail } from "#test/support/detail.ts"

const timesheet: NamedDetailCodec = { relation: "Timesheet", keys: ["employee", "week"] }

const decoded = (codec: NamedDetailCodec, text: string) => decodeDetail(codec, text)

/** Any character but NUL and the lone surrogates: printable ASCII, or the rest of the planes. */
const storable = oneOf([
	string(oneOf([codePoint(0x20, 0x7e), codePoint(0xa0, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff)]), {
		min: 0,
		max: 12
	}),
	element(['"', "\\", ",", "]", "[", "\n\t", "w[", "\u{1F600}", "'", "|"])
])

describe("DetailCodec", () => {
	it.effect("round-trips composite keys holding any storable text", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/laws/model/detail",
					draw: drawn((source) => [source.draw(storable), source.draw(storable)] as const),
					literal: Formatter.format,
					features: noFeatures,
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				([a, b]) =>
					Effect.sync(() => {
						assert.deepEqual(decoded(timesheet, encodeDetail(timesheet, [a, b])), {
							kind: "keys",
							keys: [
								{ field: "employee", text: a },
								{ field: "week", text: b }
							]
						})
					})
			)
		)
	)
})
