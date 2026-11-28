/**
 * An HTTP call's body is read as the JSON it spells (http/request.ts bodyJson): its bytes are the UTF-8 they are
 * (grizzle-text utf8.ts), so a body that is JSON as written is its value, and any other is refused as an `input`, before any
 * SQL: a body after a byte order mark is no JSON text (RFC 8259 section 8.1: a sender must not add one), and grizzle's
 * clients send none, so it is refused, never read as the JSON after the mark; a body that is no UTF-8 is refused too.
 *
 * - Property: over every body of a box, a JSON value of each kind written bare, after a byte order mark, before one,
 *   inside spaces, after a byte order mark inside spaces, or after a byte no UTF-8 holds, the body is read exactly when
 *   JSON.parse admits its text as written, as the value it parses to, and is otherwise an `input` refusal. Oracle:
 *   JSON.parse over the body's text itself, which no decoding precedes, and bytes no UTF-8 holds refused.
 *
 * Features: a body read, a body refused, a byte order mark before the JSON, a body that is no UTF-8.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Exit, Formatter, Option } from "effect"
import { bodyJson } from "#http/request.ts"
import {
	type BodyFeature,
	bodyOf,
	parsedAsWritten,
	textOf,
	type ValueKind,
	valueText,
	type Wrapping
} from "#test/unit/http/body.fixtures.ts"

/** An HTTP call's body is read exactly when its bytes are UTF-8 spelling JSON as written, and is an input refusal otherwise. */
export const anHTTPCallsBodyIsReadExactlyWhenItsBytesAreUTF8SpellingJSONAsWrittenAndIsAnInputRefusalOtherwise =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<ValueKind>(["null", "true", "number", "string", "array", "object"])),
					source.draw(
						element<Wrapping>([
							"bare",
							"mark before",
							"mark after",
							"spaces",
							"mark before spaces",
							"a byte no UTF-8 holds before"
						])
					)
				] as const
		),
		{
			needs: {},
			situations: [
				"a body read",
				"a body refused",
				"a byte order mark before the JSON",
				"a body that is no UTF-8"
			] satisfies ReadonlyArray<Reached<BodyFeature>>,
			check:
				(_, c: Case<BodyFeature>) =>
				([kind, wrapping]) =>
					Effect.gen(function* () {
						const value = valueText[kind]
						if (wrapping === "mark before" || wrapping === "mark before spaces") {
							c.note("a byte order mark before the JSON")
						}
						if (wrapping === "a byte no UTF-8 holds before") {
							c.note("a body that is no UTF-8")
						}
						const expected = Option.flatMap(textOf(wrapping, value), parsedAsWritten)
						const read = yield* Effect.exit(
							bodyJson(
								new Request("http://grizzle.test/server/app/member", {
									method: "POST",
									body: bodyOf(wrapping, value)
								})
							)
						)
						c.note(Option.isSome(expected) ? "a body read" : "a body refused")
						assert.deepEqual(
							{
								value: Exit.isSuccess(read) ? Option.some(read.value) : Option.none(),
								refused: Option.map(Exit.findErrorOption(read), (e): string => e._tag)
							},
							Option.match(expected, {
								onNone: () => ({ value: Option.none(), refused: Option.some("input") }),
								onSome: (parsed) => ({ value: Option.some(parsed), refused: Option.none() })
							}),
							`the body ${Formatter.format(wrapping)} of ${value}`
						)
					}),
			oracle: {
				kind: "specification",
				name: "JSON.parse over the body's text itself, which no decoding precedes; bytes no UTF-8 holds refused"
			},
			box: "every JSON value kind by every wrapping of its text",
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/http/request.ts",
					original: "\t\t\tconst text = utf8Text(new Uint8Array(bytes))",
					replacement: '\t\t\tconst text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)',
					why: "The body is read through a TextDecoder of its own, fatal but stripping a leading byte order mark, as it was, so {} after U+FEFF is read as {}."
				},
				{
					file: "packages/text/src/utf8.ts",
					original:
						'const strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })',
					replacement:
						'const strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true })',
					why: "The one decoder strips a leading byte order mark, so a body of JSON after U+FEFF is read as that JSON."
				}
			]
		}
	)
