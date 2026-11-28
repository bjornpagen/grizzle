import {
	array,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	recorded,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id } from "#test/support/ids.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

const Body = str.regex("^.*$", "su")
const Note = relation("Note", { id: Id, body: Body }, ["id"])
const Response = relation("Response", { id: Id, value: Body }, ["id"])
export const Texts = schema(
	"TextArrays",
	[Note, Response],
	[mutable(Note), mutable(Response), unit("Record", { id: Id })]
)

/**
 * The full world's workload: Note's insert, put and delete, each from its call's facts; Response's insert from the
 * relation parameter `responses`; and the reads of every Note, of the relation parameter `rows`, and of every Response.
 */
const programs = Object.freeze({
	insertNote: ChangeSet.empty(Texts).insert(Note, []),
	putNote: ChangeSet.empty(Texts).put(Note, []),
	deleteNote: ChangeSet.empty(Texts).delete(Note, []),
	answer: ChangeSet.empty(Texts).insert(
		Response,
		query(Texts).rule((r) => {
			const given = r.relation("responses", { id: Response.fields.id, value: Body })
			const row = v(given, "given")
			return r.match(given, row).find(row)
		})
	),
	notes: query(Texts).rule((r) => {
		const { id, body } = v(Note, "note")
		return r.match(Note, { id, body }).find({ id, body })
	}),
	echoed: query(Texts).rule((r) => {
		const rows = r.relation("rows", { body: Body })
		const row = v(rows, "row")
		return r.match(rows, row).find(row)
	}),
	recorded: query(Texts).rule((r) => {
		const { id, value } = v(Response, "response")
		return r.match(Response, { id, value }).find({ id, value })
	})
})

/** One scalar of a text: a character a literal array quotes or escapes, or a scalar of any plane but NUL. */
const scalar: Gen<string> = weighted([
	[
		3,
		element([
			'"',
			"\\",
			"{",
			"}",
			",",
			" ",
			"\t",
			"\n",
			"'",
			"a",
			"é",
			"Ѐ",
			"ש",
			"ك",
			"漢",
			"\u{1F600}",
			"\u{10FFFF}"
		])
	],
	[1, oneOf([codePoint(0x01, 0xd7_ff), codePoint(0xe0_00, 0x10_ff_ff)])]
])

/** A scalar whose presence let the encodeInto of nodejs/node#65994 underfill: U+0400 to U+07FF. */
const twoByteRange: Gen<string> = codePoint(0x04_00, 0x07_ff)

/**
 * A text: the empty text, the text NULL in a case, a short run of scalars, a run of 53 to 1200 scalars, a run of one
 * scalar ending in a scalar of U+0400 to U+07FF and a tail of up to three scalars, a run of ASCII with one scalar of
 * U+0400 to U+07FF anywhere in it, or a long run of one scalar. The underfill's lengths are not contiguous, so every
 * length of the band is drawn.
 */
const text: Gen<string> = weighted([
	[1, constant("")],
	[1, element(["NULL", "null", "Null"])],
	[4, map(array(scalar, { min: 1, max: 8 }), Arr.join(""))],
	[2, map(array(scalar, { min: 53, max: 1200 }), Arr.join(""))],
	[
		2,
		(s) => {
			const run = Str.repeat(s.draw(int(0, 1200)))(s.draw(scalar))
			const tail = Arr.join(s.draw(array(scalar, { min: 0, max: 3 })), "")
			return `${run}${s.draw(twoByteRange)}${tail}`
		}
	],
	[
		1,
		(s) => {
			const length = s.draw(int(53, 1200))
			const at = s.draw(int(0, length - 1))
			return `${Str.repeat(at)("a")}${s.draw(twoByteRange)}${Str.repeat(length - 1 - at)("a")}`
		}
	],
	[1, map(scalar, (s) => Str.repeat(2 ** 12)(s))]
])

/** A child's Cyrillic answer of 281 units ending in U+0400. */
const cyrillicAnswer = `${Str.repeat(14)("Ученик выбрал ответ ")}Ѐ`

/** A child's Hebrew answer of 271 units ending in a Hebrew letter. */
const hebrewAnswer = `${Str.repeat(15)("התלמיד בחר בתשובה ")}ש`

/** The texts of the lengths where nodejs/node#65994 underfilled on Node v26.13.0, beside the two answers. */
const underfilled: ReadonlyArray<readonly [string, string]> = [
	["U+0400 x 258 then 'a'", `${Str.repeat(258)("Ѐ")}a`],
	["U+0400 x 263 then 'a'", `${Str.repeat(263)("Ѐ")}a`],
	["U+0400 x 317 then 'a'", `${Str.repeat(317)("Ѐ")}a`],
	["U+0400 x 950 then 'a'", `${Str.repeat(950)("Ѐ")}a`],
	["'a' x 52 then U+0400", `${Str.repeat(52)("a")}Ѐ`],
	["'a' x 309 then U+0400", `${Str.repeat(309)("a")}Ѐ`]
]

export type TextFeature =
	| "a quote or a backslash"
	| "a brace or a comma"
	| "the text NULL"
	| "an astral scalar"
	| "the empty text"
	| "a long text"
	| "a text of 53 units or more holding U+0400 to U+07FF"

export const features: Arr.NonEmptyReadonlyArray<TextFeature> = [
	"a quote or a backslash",
	"a brace or a comma",
	"the text NULL",
	"an astral scalar",
	"the empty text",
	"a long text",
	"a text of 53 units or more holding U+0400 to U+07FF"
]

/** Whether a text holds a scalar of U+0400 to U+07FF. */
export const holdsTwoByteRange = (t: string): boolean =>
	Arr.some(Arr.fromIterable(t), (point) =>
		Option.exists(Str.codePointAt(0)(point), (code) => code >= 0x04_00 && code <= 0x07_ff)
	)

/** A text's code points reversed, so a put changes every text but a palindrome's. */
export const reversed = (t: string): string => Arr.join(Arr.reverse(Array.from(t)), "")

/** Texts in code unit order, so two reads compare as multisets. */
export const sorted = (texts: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(texts, Order.String)

/** The installation of Texts with the full world's workload (programs), once per member, as its search installed it. */
export const textsInstall = { label: "textarrays", programs } as const

export const textsTemplate = fixtureTemplate(import.meta, Texts, textsInstall)

/**
 * The texts nodejs/node#65994 underfilled, kept by value (a real bug the property caught: grizzle's binary text[]
 * element held 0x00 bytes where encodeInto wrote short), each a case of its own, recorded beside the drawn lists since
 * no draw spells a child's answer: the Cyrillic answer ending in U+0400, the Hebrew one, and the six texts at lengths
 * where it underfilled on Node v26.13.0.
 */
const underfilledCases: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>> = [
	[cyrillicAnswer],
	[hebrewAnswer],
	...Arr.map(underfilled, ([, t]) => [t])
]

/** One to six drawn texts, beside the underfilled ones (gen.ts recorded). */
export const textCases = recorded(array(text, { min: 1, max: 6 }), underfilledCases)
