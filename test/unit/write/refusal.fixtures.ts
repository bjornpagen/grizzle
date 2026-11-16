/** What the properties of refusal.test.ts read: its spaces, models and helpers. */

import {
	boolean,
	codePoint,
	element,
	type Gen,
	int,
	oneOf,
	string,
	uniqueKeys
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { type ConcurrentChangeTag } from "#compiler/runtime/write/refusal.ts"
import { defined } from "#test/support/assert.ts"
import { upTo } from "#test/support/up-to.ts"

/** The concurrent changes a write's refusal channel reads back. */
export const reasons: Arr.NonEmptyReadonlyArray<ConcurrentChangeTag> = [
	"PutTargetConflict",
	"SpanKeyChange"
]

/**
 * Text PostgreSQL stores: printable ASCII, or any other character but NUL and the lone surrogates, so a
 * supplementary-plane character is a pair.
 */
export const storable: Gen<string> = string(
	oneOf([codePoint(0x20, 0x7e), codePoint(0x01, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff)]),
	{ min: 0, max: 12 }
)

/** The DETAIL grammar's delimiters, escapes and quotes, and other tags, drawn as key texts beside the storable ones. */
const nasty = element([
	'"',
	"\\",
	"/",
	",",
	"]",
	"[",
	"\n\t\u0001\b\f\r",
	"k[",
	"a[",
	"w[",
	"\u{1F600}",
	"'",
	"$$",
	""
])

/** A storable character other than `excluded`, a printable ASCII one: storable's ranges with it cut out. */
const storableOtherThan = (excluded: string): Gen<string> => {
	const point = defined(
		Option.getOrUndefined(Str.codePointAt(0)(excluded)),
		"an excluded character"
	)
	return oneOf([
		codePoint(0x20, point - 1),
		codePoint(point + 1, 0x7e),
		codePoint(0x01, point - 1),
		codePoint(point + 1, 0xd7_ff),
		codePoint(0xe0_00, 0x10_ffff)
	])
}

/** The opening a law's DETAIL starts with: its tag and its bracket. */
const lawOpening = "k["

/**
 * A text after `tag` that leaves the whole no law's DETAIL: any text under a tag that does not begin the law's opening;
 * under one that does, a proper prefix of the opening's rest, or that prefix turned away from the rest at a drawn
 * character, then any text.
 */
export const foreignAfter = (tag: string): Gen<string> => {
	const any = oneOf([storable, nasty])
	if (!Str.startsWith(tag)(lawOpening)) {
		return any
	}
	const rest = Str.slice(tag.length)(lawOpening)
	return (source) => {
		const at = source.draw(int(0, rest.length - 1))
		const shared = Str.slice(0, at)(rest)
		const next = defined(rest[at], "the opening's next character")
		return source.draw(boolean)
			? shared
			: `${shared}${source.draw(storableOtherThan(next))}${source.draw(any)}`
	}
}

/** A key: distinct field names, each with its text. */
export const keyGen: Gen<ReadonlyArray<{ readonly field: string; readonly text: string }>> = (
	source
) =>
	Arr.map(source.draw(uniqueKeys(storable, { min: 1, max: 4 })), (field) => ({
		field,
		text: source.draw(oneOf([storable, nasty]))
	}))

/** How one character of a JSON string is spelled. */
type Spelling = "itself" | "short" | "lower hex" | "upper hex"

/** The two-character escape of a character that has one. */
const shortEscapes: ReadonlyMap<string, string> = new Map([
	['"', '\\"'],
	["\\", "\\\\"],
	["/", "\\/"],
	["\b", "\\b"],
	["\f", "\\f"],
	["\n", "\\n"],
	["\r", "\\r"],
	["\t", "\\t"]
])

/** `\uXXXX` for each UTF-16 unit of a character. */
const hexEscape = (ch: string, upper: boolean): string =>
	Arr.join(
		upTo(ch.length, (i) => {
			const unit = defined(Option.getOrUndefined(Str.charCodeAt(i)(ch)), "a UTF-16 unit")
			const hex = Str.padStart(4, "0")(unit.toString(16))
			return `\\u${upper ? Str.toUpperCase(hex) : hex}`
		}),
		""
	)

/** Whether JSON lets a character stand for itself inside a string. */
const plain = (ch: string): boolean =>
	ch !== '"' &&
	ch !== "\\" &&
	defined(Option.getOrUndefined(Str.codePointAt(0)(ch)), "a character's code point") >= 0x20

/** A JSON string literal of `text`, each character spelled as drawn among the spellings JSON allows it. */
export const spelledGen =
	(text: string, seen: (spelling: Spelling) => void): Gen<string> =>
	(source) =>
		`"${Arr.join(
			Arr.map(Arr.fromIterable(text), (ch) => {
				const escapes: ReadonlyArray<Spelling> = [
					...(plain(ch) ? (["itself"] as const) : []),
					...(shortEscapes.has(ch) ? (["short"] as const) : [])
				]
				const allowed: Arr.NonEmptyReadonlyArray<Spelling> = ["lower hex", "upper hex", ...escapes]
				const spelling = source.draw(element(allowed))
				seen(spelling)
				switch (spelling) {
					case "itself":
						return ch
					case "short":
						return defined(shortEscapes.get(ch), "a short escape")
					case "lower hex":
						return hexEscape(ch, false)
					case "upper hex":
						return hexEscape(ch, true)
				}
			}),
			""
		)}"`

/** What a case reaches: each spelling of a character, an escaped supplementary-plane character. */
export type DetailFeature = `spelled ${Spelling}` | "an escaped surrogate pair"

/** What a foreign DETAIL starts with: another tag of grizzle's, the law's tag without its bracket, or none. */
export const foreignTags = ["a[", "o[", "w[", "c[", "K[", "k", ""] as const

/** A foreign DETAIL's kind: under one of the tags, or a concurrent change's own. */
export type ForeignFeature = `under ${(typeof foreignTags)[number]}` | "a concurrent change"
