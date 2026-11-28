/** What the properties of sha256.test.ts read: their spaces, the hex each case spells and the schema of digest pairs. */

import {
	bytes,
	characterOf,
	element,
	type Gen,
	int,
	map,
	string,
	unicodeScalar
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { String as Str } from "effect"
import { sha256Octets } from "#compiler/core/digest.ts"
import { Sha256, sha256, int4 } from "#compiler/public/fields.ts"
import { check, relation, schema } from "#compiler/public/schema.ts"
import { hexDigitsPerByte, hexOf } from "#test/support/unit/values/support.ts"

/** The length of every digest's hex: two digits for each of its bytes. */
const hexLength = sha256Octets * hexDigitsPerByte

/** How a text a case reads is spelt: a digest's own hex, or a text that is none, by the one way it is not. */
export const hexForms = [
	"a digest's hex",
	"an uppercase digit",
	"another length",
	"a character no hex digit"
] as const
export type HexForm = (typeof hexForms)[number]

/** A text fromHex reads: its form, the text, and the digest whose hex it is, or which it is made from. */
export interface HexCase {
	readonly form: HexForm
	readonly digest: Sha256
	readonly text: string
}

/** A message's digest: any bytes, up to a digest's length, hashed. */
const digestGen: Gen<Sha256> = map(bytes({ min: 0, max: sha256Octets }), (message) =>
	Sha256.ofBytes(message)
)

/** The digits a digest's hex writes. */
const lowerDigits = [
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"a",
	"b",
	"c",
	"d",
	"e",
	"f"
] as const

/** The hex digits a digest's hex never writes: a letter's uppercase. */
const upperLetters = ["A", "B", "C", "D", "E", "F"] as const

/** A hex digit, either case. */
const anyHexDigit = regex("^[0-9a-fA-F]$", "u")

/**
 * A character no hex digit: any Unicode scalar, one past the BMP among them, which UTF-16 writes in two code units; a
 * hex digit drawn is taken as `g`, the first letter past them.
 */
const nonHexCharacter: Gen<string> = map(unicodeScalar, (c) => (anyHexDigit.test(c) ? "g" : c))

/** `text` with `by` in place of as many of its code units at `at`, so its length is its own. */
const spliced = (text: string, at: number, by: string): string =>
	`${Str.slice(0, at)(text)}${by}${Str.slice(at + by.length)(text)}`

export const hexCases: Gen<HexCase> = (s) => {
	const digest = s.draw(digestGen)
	const hex = hexOf(digest)
	const form = s.draw(element(hexForms))
	switch (form) {
		case "a digest's hex":
			return { form, digest, text: hex }
		case "an uppercase digit":
			return {
				form,
				digest,
				text: spliced(hex, s.draw(int(0, hexLength - 1)), s.draw(characterOf(upperLetters)))
			}
		case "another length": {
			const drawn = s.draw(int(0, 2 * hexLength - 1))
			const length = drawn < hexLength ? drawn : drawn + 1
			return {
				form,
				digest,
				text: s.draw(string(characterOf(lowerDigits), { min: length, max: length }))
			}
		}
		case "a character no hex digit": {
			const character = s.draw(nonHexCharacter)
			const at = Math.min(s.draw(int(0, hexLength - 1)), hexLength - character.length)
			return { form, digest, text: spliced(hex, at, character) }
		}
	}
}

/** Whether a digest pair is one digest held in two arrays, or two messages' digests. */
export const pairForms = ["one digest in two arrays", "two messages' digests"] as const
export type PairForm = (typeof pairForms)[number]

/** Two digests compared: one message's digest twice, each its own array, or two messages' digests. */
export interface DigestPair {
	readonly form: PairForm
	readonly first: Sha256
	readonly second: Sha256
}

export const digestPairs: Gen<DigestPair> = (s) => {
	const message = s.draw(bytes({ min: 0, max: sha256Octets }))
	const form = s.draw(element(pairForms))
	const first = Sha256.ofBytes(message)
	if (form === "one digest in two arrays") {
		return { form, first, second: Sha256.ofBytes(message) }
	}
	const at = s.draw(int(0, message.length))
	const other = new Uint8Array(Math.max(message.length, at + 1))
	other.set(message)
	other[at] = at === message.length ? s.draw(int(0, 0xff)) : ((message[at] ?? 0) + 1) & 0xff
	return { form, first, second: Sha256.ofBytes(other) }
}

/** A pair of digests in one row, and the check that they are one. */
export const Pair = relation("Pair", { id: int4, first: sha256, second: sha256 }, ["id"])

export const Pairs = schema("Pairs", [Pair], [check("Same", Pair, (r) => r.eq(r.first, r.second))])
