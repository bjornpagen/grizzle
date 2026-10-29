import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noFeatures } from "@grizzle/testing/features"
import { codePoint, element, type Gen, oneOf, string, uniqueArray } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import {
	type ConcurrentChangeTag,
	encodeRefusalDetail,
	readChangeDetail,
	readLawDetail
} from "#compiler/write/refusal.ts"
import { assert } from "#test/support/assert.ts"
import { encodeDetail } from "#test/support/detail.ts"

/** The write refusal channel, without a database.
 *
 * - A refusal's DETAIL round-trips whatever its relation, field names and key texts hold: quotes, backslashes, commas,
 *   brackets, control characters, supplementary-plane characters, another encoding's tag.
 * - The reader trusts its text, grizzle's own: a law function's DetailCodec text is another encoding's, never a
 *   refusal. */
const reasons: Arr.NonEmptyReadonlyArray<ConcurrentChangeTag> = [
	"PutTargetConflict",
	"SpanKeyChange"
]

/**
 * Text PostgreSQL stores: printable ASCII, or any other character but NUL and the lone surrogates, so a
 * supplementary-plane character is a pair.
 */
const storable: Gen<string> = string(
	oneOf([codePoint(0x20, 0x7e), codePoint(0x01, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff)]),
	{ min: 0, max: 12 }
)
const nasty = element([
	'"',
	"\\",
	",",
	"]",
	"[",
	"\n\t\u0001",
	"k[",
	"a[",
	"w[",
	"\u{1F600}",
	"'",
	"$$",
	""
])
/** A key: distinct field names, each with its text. */
const keyGen: Gen<ReadonlyArray<{ readonly field: string; readonly text: string }>> = (source) =>
	Arr.map(
		source.draw(uniqueArray(storable, (field) => field, { min: 1, max: 4 }, 10)),
		(field) => ({
			field,
			text: source.draw(oneOf([storable, nasty]))
		})
	)

describe("the write refusal channel", () => {
	describe("its DETAIL", () => {
		it.effect(
			"round-trips a law's refusal and a concurrent change, whatever the names and key texts hold",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "unit/write/refusal-1",
							draw: drawn(
								(source) =>
									[
										source.draw(storable),
										source.draw(keyGen),
										source.draw(element(reasons))
									] as const
							),
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
						([relation, key, reason]) =>
							Effect.sync(() => {
								assert.deepEqual(
									readLawDetail(encodeRefusalDetail({ kind: "law", relation }, key)),
									{
										kind: "law",
										relation,
										key
									}
								)
								assert.deepEqual(
									readChangeDetail(encodeRefusalDetail({ kind: "change", reason, relation }, key)),
									{
										reason,
										relation
									}
								)
							})
					)
				)
		)

		it("reads PostgreSQL's own spelling of the JSON strings", () => {
			assert.deepEqual(readLawDetail('k["Task",["id","note"],["a\\u0001b","\\"q\\""]]'), {
				kind: "law",
				relation: "Task",
				key: [
					{ field: "id", text: "a\u0001b" },
					{ field: "note", text: '"q"' }
				]
			})
		})

		it("reads a law function's DetailCodec DETAIL as another encoding's", () => {
			assert.deepEqual(readLawDetail(encodeDetail({ relation: "Task", keys: ["id"] }, ["x"])), {
				kind: "lawFunction"
			})
		})
	})
})
