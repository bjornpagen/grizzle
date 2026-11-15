/**
 * An HTTP call's body is read as the JSON it spells (http/request.ts bodyJson): its bytes are the UTF-8 they are
 * (core/utf8.ts), so a body that is JSON as written is its value, and any other is refused as an `input`, before any
 * SQL: a body after a byte order mark is no JSON text (RFC 8259 section 8.1: a sender must not add one), and grizzle's
 * clients send none, so it is refused, never read as the JSON after the mark; a body that is no UTF-8 is refused too.
 *
 * - Property: over every body of a box, a JSON value of each kind written bare, after a byte order mark, before one,
 *   inside spaces, after a byte order mark inside spaces, or after a byte no UTF-8 holds, the body is read exactly when
 *   JSON.parse admits its text as written, as the value it parses to, and is otherwise an `input` refusal. Oracle:
 *   JSON.parse over the body's text itself, which no decoding precedes, and bytes no UTF-8 holds refused.
 *
 * Features: a body read, a body refused, a byte order mark before the JSON, a body that is no UTF-8.
 *
 * @plant test/plants/unit/http/body-strips-byte-order-mark.patch The body is read through a TextDecoder of its own,
 * fatal but stripping a leading byte order mark, as it was, so {} after U+FEFF is read as {}.
 * @plant test/plants/unit/core/utf8-strips-byte-order-mark.patch The one decoder strips a leading byte order mark, so
 * a body of JSON after U+FEFF is read as that JSON.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Effect, Exit, Formatter, Option } from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"
import { bodyJson } from "#http/request.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

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

/**
 * How a value's text stands in the body: bare, after or before a byte order mark, inside spaces, both, or after a
 * byte no UTF-8 holds.
 */
type Wrapping =
	| "bare"
	| "mark before"
	| "mark after"
	| "spaces"
	| "mark before spaces"
	| "a byte no UTF-8 holds before"

const BYTE_ORDER_MARK = "\uFEFF"

/** A byte no UTF-8 sequence holds (Unicode 3.9, table 3-7). */
const notUtf8 = 0xff

const encoder = new TextEncoder()

/** The body's bytes: the value's text as `wrapping` places it, in UTF-8, or after a byte no UTF-8 holds. */
const bodyOf = (wrapping: Wrapping, text: string): Uint8Array => {
	switch (wrapping) {
		case "bare":
			return encoder.encode(text)
		case "mark before":
			return encoder.encode(`${BYTE_ORDER_MARK}${text}`)
		case "mark after":
			return encoder.encode(`${text}${BYTE_ORDER_MARK}`)
		case "spaces":
			return encoder.encode(` ${text} `)
		case "mark before spaces":
			return encoder.encode(`${BYTE_ORDER_MARK} ${text} `)
		case "a byte no UTF-8 holds before":
			return Uint8Array.from([notUtf8, ...encoder.encode(text)])
	}
}

/** The text of a wrapping that is UTF-8, as the body spells it; none for one that is no UTF-8. */
const textOf = (wrapping: Wrapping, text: string): Option.Option<string> => {
	switch (wrapping) {
		case "bare":
			return Option.some(text)
		case "mark before":
			return Option.some(`${BYTE_ORDER_MARK}${text}`)
		case "mark after":
			return Option.some(`${text}${BYTE_ORDER_MARK}`)
		case "spaces":
			return Option.some(` ${text} `)
		case "mark before spaces":
			return Option.some(`${BYTE_ORDER_MARK} ${text} `)
		case "a byte no UTF-8 holds before":
			return Option.none()
	}
}

/** The value JSON.parse makes of `text` as it is, through the one JSON door (core/trusted.ts), none where it refuses it. */
const parsedAsWritten = Option.liftThrowable((text: string): unknown => trustedJson<unknown>(text))

type BodyFeature =
	| "a body read"
	| "a body refused"
	| "a byte order mark before the JSON"
	| "a body that is no UTF-8"

describe("an HTTP call's body", () => {
	it.effect(
		"is read exactly when its bytes are UTF-8 spelling JSON as written, and is an input refusal otherwise",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every JSON value kind by every wrapping of its text",
						oracle: {
							kind: "specification",
							name: "JSON.parse over the body's text itself, which no decoding precedes; bytes no UTF-8 holds refused"
						},
						suite: "unit/http/body",
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
										"mark before spaces",
										"a byte no UTF-8 holds before"
									])
								)
							] as const,
						literal: Formatter.format,
						coverage: requiredInSpace<BodyFeature>([
							"a body read",
							"a body refused",
							"a byte order mark before the JSON",
							"a body that is no UTF-8"
						]),
						caseHang,
						concurrency: 1
					},
					([kind, wrapping], c) =>
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
									refused: Option.map(Exit.findErrorOption(read), (e): string => e.kind)
								},
								Option.match(expected, {
									onNone: () => ({ value: Option.none(), refused: Option.some("input") }),
									onSome: (parsed) => ({ value: Option.some(parsed), refused: Option.none() })
								}),
								`the body ${Formatter.format(wrapping)} of ${value}`
							)
						})
				)
			)
	)
})
