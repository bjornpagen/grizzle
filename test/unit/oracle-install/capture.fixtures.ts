/** What the properties of capture.test.ts read: its spaces, models and helpers. */

import {
	constant,
	element,
	type Gen,
	string,
	unicodeScalar,
	weighted
} from "@bjornpagen/testing/gen"
import { Option, pipe, String as Str } from "effect"

/**
 * What PostgreSQL's quote_literal writes for a non-NULL text (src/backend/utils/adt/quote.c): quotes and backslashes
 * doubled, and an E prefix when the text has a backslash.
 */
export const quoteLiteral = (text: string): string => {
	const body = pipe(Str.replaceAll("'", "''")(text), Str.replaceAll("\\", "\\\\"))
	return Str.includes("\\")(text) ? `E'${body}'` : `'${body}'`
}

/** One character of a text: the two quote_literal doubles, an ASCII letter, or any Unicode scalar value. */
const characterGen: Gen<string> = weighted([
	[2, constant("'")],
	[2, constant("\\")],
	[3, element(["a", "b", "E", "N"])],
	[3, unicodeScalar]
])

export const textGen: Gen<string> = string(characterGen, { min: 0, max: 10 })

/** A fault planted in a literal quote_literal wrote, each one quote_literal never writes. */
type Fault =
	| "the bare word NULL"
	| "the opening quote dropped"
	| "the closing quote dropped"
	| "a doubled quote halved"
	| "a doubled backslash halved"

/** Where a doubled character sits in a literal's body: the index of its first half, past the body's opening quote. */
const doubledAt = (quoted: string, ch: string): Option.Option<number> => {
	const start = Str.startsWith("E'")(quoted) ? 2 : 1
	for (let i = start; i < quoted.length - 2; i += 1) {
		const here = quoted[i]
		if (here === ch && quoted[i + 1] === ch) {
			return Option.some(i)
		}
		if (here === "'" || here === "\\") {
			i += 1
		}
	}
	return Option.none()
}

/** The literal without its character at `at`. */
const without = (quoted: string, at: number): string =>
	`${Str.slice(0, at)(quoted)}${Str.slice(at + 1)(quoted)}`

/** The literal with `fault` planted, or none where the literal holds nothing the fault edits. */
export const planted = (quoted: string, fault: Fault): Option.Option<string> => {
	switch (fault) {
		case "the bare word NULL":
			return Option.some("NULL")
		case "the opening quote dropped":
			return Option.some(without(quoted, Str.startsWith("E'")(quoted) ? 1 : 0))
		case "the closing quote dropped":
			return Option.some(without(quoted, quoted.length - 1))
		case "a doubled quote halved":
			return Option.map(doubledAt(quoted, "'"), (at) => without(quoted, at))
		case "a doubled backslash halved":
			return Option.map(doubledAt(quoted, "\\"), (at) => without(quoted, at))
	}
}

export type Feature =
	| "a quote"
	| "a backslash"
	| "a quote and a backslash"
	| "the empty text"
	| `refused: ${Fault}`

export const faults: ReadonlyArray<Fault> = [
	"the bare word NULL",
	"the opening quote dropped",
	"the closing quote dropped",
	"a doubled quote halved",
	"a doubled backslash halved"
]
