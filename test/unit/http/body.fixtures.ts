/** What the properties of body.test.ts read: its spaces, models and helpers. */

import { Option } from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"

/** A JSON value of each kind JSON spells, as its text. */
export type ValueKind = "null" | "true" | "number" | "string" | "array" | "object"

export const valueText: { readonly [K in ValueKind]: string } = {
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
export type Wrapping =
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
export const bodyOf = (wrapping: Wrapping, text: string): Uint8Array => {
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
export const textOf = (wrapping: Wrapping, text: string): Option.Option<string> => {
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
export const parsedAsWritten = Option.liftThrowable((text: string): unknown =>
	trustedJson<unknown>(text)
)

export type BodyFeature =
	| "a body read"
	| "a body refused"
	| "a byte order mark before the JSON"
	| "a body that is no UTF-8"
