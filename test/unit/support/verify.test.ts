/**
 * The test layers' verify (test/support/worlds.ts testVerify), the one every test's DbLayer reads a token through: a
 * token whose text holds JSON as written verifies as that JSON, and any other text is a TokenError, whatever a decoder
 * would forgive in front of the parse. The worlds model reads a token that is no JSON as refused at token:verify, so a
 * verify more lenient than JSON.parse lets a world open a Db the model refuses (pg/world-model/errors, TEST_SEED=
 * 2079795525, rotating case 10: a token of {} after a byte order mark, U+FEFF, opened).
 *
 * - Property: over every token text of a box, a JSON value of each kind written bare, after a byte order mark, before
 *   one, inside spaces, or after a byte order mark inside spaces, verify succeeds exactly when JSON.parse admits the
 *   text as it is, with the value it parses to, and fails with TokenError otherwise. Oracle: JSON.parse over the text
 *   itself, which no decoding precedes.
 *
 * Features: a text admitted, a text refused, and a byte order mark before the JSON.
 *
 * @plant test/plants/unit/support/verify-strips-byte-order-mark.patch The verify's decoder strips a leading byte order
 * mark, as TextDecoder does by default, so {} after U+FEFF verifies as {}.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Effect, Exit, Formatter, Option } from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { testVerify, tokenText } from "#test/support/worlds.ts"

/** A JSON value of each kind JSON spells, as its text. */
type ValueKind = "null" | "true" | "number" | "string" | "array" | "object"

const valueText: { readonly [K in ValueKind]: string } = {
	null: "null",
	true: "true",
	number: "1",
	string: '"x"',
	array: "[1]",
	object: '{"a":1}'
}

/** How a value's text stands in the token: bare, after or before a byte order mark, inside spaces, or both. */
type Wrapping = "bare" | "mark before" | "mark after" | "spaces" | "mark before spaces"

const BYTE_ORDER_MARK = "\uFEFF"

const wrapped = (wrapping: Wrapping, text: string): string => {
	switch (wrapping) {
		case "bare":
			return text
		case "mark before":
			return `${BYTE_ORDER_MARK}${text}`
		case "mark after":
			return `${text}${BYTE_ORDER_MARK}`
		case "spaces":
			return ` ${text} `
		case "mark before spaces":
			return `${BYTE_ORDER_MARK} ${text} `
	}
}

/** The value JSON.parse makes of `text` as it is, through the one JSON door (core/trusted.ts), none where it refuses it. */
const parsedAsWritten = Option.liftThrowable((text: string): unknown => trustedJson<unknown>(text))

type VerifyFeature = "a text admitted" | "a text refused" | "a byte order mark before the JSON"

describe("the test layers' verify", () => {
	it.effect(
		"verifies exactly the token texts that hold JSON as written, and refuses every other with TokenError",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every JSON value kind by every wrapping of its text",
						oracle: {
							kind: "specification",
							name: "JSON.parse over the token's text itself, which no decoding precedes"
						},
						suite: "unit/support/verify",
						generator: (source) =>
							[
								source.draw(
									element<ValueKind>(["null", "true", "number", "string", "array", "object"])
								),
								source.draw(
									element<Wrapping>([
										"bare",
										"mark before",
										"mark after",
										"spaces",
										"mark before spaces"
									])
								)
							] as const,
						literal: Formatter.format,
						coverage: requiredInSpace<VerifyFeature>([
							"a text admitted",
							"a text refused",
							"a byte order mark before the JSON"
						]),
						caseHang,
						concurrency: 1
					},
					([kind, wrapping], c) =>
						Effect.gen(function* () {
							const text = wrapped(wrapping, valueText[kind])
							if (wrapping === "mark before" || wrapping === "mark before spaces") {
								c.note("a byte order mark before the JSON")
							}
							const expected = parsedAsWritten(text)
							const verified = yield* Effect.exit(testVerify(tokenText(text)))
							c.note(Option.isSome(expected) ? "a text admitted" : "a text refused")
							assert.deepEqual(
								Option.match(expected, {
									onNone: () => ({ verified: false, value: Option.none() }),
									onSome: (value) => ({ verified: true, value: Option.some(value) })
								}),
								{
									verified: Exit.isSuccess(verified),
									value: Exit.isSuccess(verified) ? Option.some(verified.value) : Option.none()
								},
								`the token of ${Formatter.format(text)}`
							)
						})
				)
			)
	)
})
