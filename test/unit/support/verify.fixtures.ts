/** What the properties of verify.test.ts read: its spaces, models and helpers. */

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

/** How a value's text stands in the token: bare, after or before a byte order mark, inside spaces, or both. */
export type Wrapping = "bare" | "mark before" | "mark after" | "spaces" | "mark before spaces"

const BYTE_ORDER_MARK = "\uFEFF"

export const wrapped = (wrapping: Wrapping, text: string): string => {
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
export const parsedAsWritten = Option.liftThrowable((text: string): unknown =>
	trustedJson<unknown>(text)
)

export type VerifyFeature =
	| "a text admitted"
	| "a text refused"
	| "a byte order mark before the JSON"
