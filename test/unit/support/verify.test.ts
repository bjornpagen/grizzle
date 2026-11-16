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
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Exit, Formatter, Option } from "effect"
import { assert } from "#test/support/assert.ts"
import { testVerify, tokenText } from "#test/support/worlds.ts"
import {
	parsedAsWritten,
	type ValueKind,
	valueText,
	type VerifyFeature,
	wrapped,
	type Wrapping
} from "#test/unit/support/verify.fixtures.ts"

/** The test layers' verify verifies exactly the token texts that hold JSON as written, and refuses every other with TokenError. */
export const theTestLayersVerifyVerifiesExactlyTheTokenTextsThatHoldJSONAsWrittenAndRefusesEveryOtherWithTokenError =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<ValueKind>(["null", "true", "number", "string", "array", "object"])),
					source.draw(
						element<Wrapping>(["bare", "mark before", "mark after", "spaces", "mark before spaces"])
					)
				] as const
		),
		{
			needs: {},
			situations: [
				"a text admitted",
				"a text refused",
				"a byte order mark before the JSON"
			] satisfies ReadonlyArray<Reached<VerifyFeature>>,
			check:
				(_, c: Case<VerifyFeature>) =>
				([kind, wrapping]) =>
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
					}),
			oracle: {
				kind: "specification",
				name: "JSON.parse over the token's text itself, which no decoding precedes"
			},
			box: "every JSON value kind by every wrapping of its text",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/utf8.ts",
					original:
						'const strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })',
					replacement:
						'const strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true })',
					why: "The one decoder the verify reads a token's bytes through (core/utf8.ts) strips a leading byte order mark, as a TextDecoder does by default, so {} after U+FEFF verifies as {}."
				}
			]
		}
	)
