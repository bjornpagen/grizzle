/** What the properties of text.test.ts read: its spaces, models and helpers. */

import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"

/**
 * One user-perceived character: none, a scalar of any plane but NUL and the surrogates, or a letter with a combining
 * mark after it, so a character of two scalars meets one of a single scalar.
 */
const grapheme: Gen<string> = weighted([
	[1, constant("")],
	[3, oneOf([codePoint(0x01, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff)])],
	[
		1,
		(source) =>
			`${source.draw(codePoint(0x61, 0x7a))}${source.draw(boolean) ? source.draw(codePoint(0x03_00, 0x03_6f)) : ""}`
	]
])

const scalar = oneOf([
	element(["a", "A", "z", "\u00e9", "e\u0301", "ß", "퟿", "", "￿", "\u{10000}", "\u{10ffff}"]),
	grapheme,
	codePoint(0x01, 0x7f),
	codePoint(0xe0_00, 0xff_ff),
	codePoint(0x1_00_00, 0x10_ff_ff)
])

export const text = map(array(scalar, { min: 0, max: 5 }), Arr.join(""))

export const source = "jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text)"
