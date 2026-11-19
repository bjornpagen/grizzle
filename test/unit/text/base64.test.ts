/**
 * base64 (packages/text/src/base64.ts base64Bytes), RFC 4648 §4: the bytes a text spells in base64's one spelling.
 *
 * - Property: over drawn bytes' own base64 and texts one edit from it (its padding dropped or doubled, a digit of another
 *   alphabet, whitespace, a group cut short, a nonzero padding bit), base64Bytes spells bytes exactly where Node's
 *   Buffer reads the text and writes it back as itself, and then the same bytes. Oracle: a second implementation,
 *   Buffer's base64 decoder, which reads leniently, held to its own encoder's one spelling.
 *
 * Features: the bytes' own text, and each kind of edit.
 */

import { base64Bytes } from "@bjornpagen/grizzle-text/base64"
import { type Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { assert } from "#test/support/assert.ts"

type Edit =
	| "the bytes' own text"
	| "padding dropped"
	| "padding doubled"
	| "a digit of another alphabet"
	| "whitespace"
	| "a group cut short"
	| "a nonzero padding bit"

const edits: Arr.NonEmptyReadonlyArray<Edit> = [
	"the bytes' own text",
	"padding dropped",
	"padding doubled",
	"a digit of another alphabet",
	"whitespace",
	"a group cut short",
	"a nonzero padding bit"
]

/** The standard alphabet, in its digits' order. */
const alphabet = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

/** The standard alphabet's digit after `digit`, the next value of its six bits. */
const nextDigit = (digit: string): string =>
	Option.getOrThrow(
		Arr.get(
			alphabet,
			(Arr.findFirstIndex(alphabet, (d) => d === digit).pipe(Option.getOrThrow) + 1) %
				alphabet.length
		)
	)

/** `text`'s characters with `at` replaced by `by`, or inserted before it, or the last removed. */
const spliced = (
	chars: ReadonlyArray<string>,
	at: number,
	remove: number,
	by: ReadonlyArray<string>
): string => Arr.join([...Arr.take(chars, at), ...by, ...Arr.drop(chars, at + remove)], "")

/** `text` with `edit` applied, where it applies: the text unchanged where it does not. */
const edited = (text: string, edit: Edit, at: number): string => {
	const chars = Array.from(text)
	const padded = Arr.findFirstIndex(chars, (ch) => ch === "=")
	switch (edit) {
		case "the bytes' own text":
			return text
		case "padding dropped":
			return Arr.join(
				Arr.filter(chars, (ch) => ch !== "="),
				""
			)
		case "padding doubled":
			return `${text}==`
		case "a digit of another alphabet":
			return chars.length === 0 ? "-" : spliced(chars, at % chars.length, 1, ["_"])
		case "whitespace":
			return spliced(chars, at % (chars.length + 1), 0, ["\n"])
		case "a group cut short":
			return spliced(chars, Math.max(0, chars.length - 1), 1, [])
		case "a nonzero padding bit":
			return Option.match(padded, {
				onNone: () => text,
				onSome: (p) =>
					p === 0
						? text
						: spliced(chars, p - 1, 1, [nextDigit(Option.getOrThrow(Arr.get(chars, p - 1)))])
			})
	}
}

const caseGen: Gen<{ readonly text: string; readonly edit: Edit }> = (source) => {
	const bytes = Uint8Array.from(source.draw(array(int(0, 255), { min: 0, max: 40 })))
	const edit = source.draw(element(edits))
	return { text: edited(bytes.toBase64(), edit, source.draw(int(0, 60))), edit }
}

/** The second reading: Buffer's lenient decode, kept where its own encoder writes the text back as itself. */
const bufferRead = (text: string): Uint8Array<ArrayBuffer> | undefined => {
	const bytes = Buffer.from(text, "base64")
	return bytes.toString("base64") === text ? Uint8Array.from(bytes) : undefined
}

/** base64Bytes spells bytes exactly where base64's one spelling of them is the text, and the same bytes. */
export const base64BytesSpellsBytesExactlyWhereBase64sOneSpellingOfThemIsTheTextAndTheSameBytes =
	property.explore(caseGen, {
		needs: {},
		situations: edits satisfies ReadonlyArray<Reached<Edit>>,
		check:
			(_, c: Case<Edit>) =>
			({ text, edit }) =>
				Effect.sync(() => {
					c.note(edit)
					assert.deepEqual(base64Bytes(text), bufferRead(text), Formatter.format(text))
				}),
		oracle: {
			kind: "second-implementation",
			name: "Node's Buffer base64 decoder, held to its own encoder's one spelling"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/base64.ts",
				original: "\treturn bytes.toBase64() === text ? bytes : undefined",
				replacement: "\treturn bytes",
				why: "A text whose padding bits are not zero spells the bytes another text spells, so two texts read as one value."
			},
			{
				file: "packages/text/src/base64.ts",
				original: "\tunit === 0x2b ||",
				replacement: "\tunit === 0x2b ||\n\tunit === 0x5f ||",
				why: "A base64url digit passes the shape and Uint8Array.fromBase64 throws on it, where the reader answers no bytes."
			}
		]
	})
