/** What the properties of search-document.test.ts read: a model of tsvectorin's one form, and its spaces. */

import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	array,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, pipe, String as Str } from "effect"
import {
	searchLexemeMaxBytes,
	searchPositionMax,
	searchPositionsMax,
	textSearchStringMaxBytes
} from "#compiler/scalar/values/fault.ts"

/** A weight's label as a raw text may state it after a position, tsvectorin reading each case alike, or none (D). */
type Label = "A" | "B" | "C" | "D" | "a" | "b" | "c" | "d" | ""

/** A position as a raw text states it: its number and its label. */
interface RawPosition {
	readonly at: number
	readonly label: Label
}

/** A lexeme as a raw text states it: its text and its positions, in the order the text writes them. */
interface RawLexeme {
	readonly lexeme: string
	readonly positions: ReadonlyArray<RawPosition>
}

/** A raw document: its lexemes in the order its text writes them, repeats and disorder among them. */
export interface RawDocument {
	readonly lexemes: ReadonlyArray<RawLexeme>
}

/** A weight as tsvectorin stores it, 3 for A down to 0 for D. */
const weightOf = (label: Label): number => {
	switch (label) {
		case "A":
		case "a":
			return 3
		case "B":
		case "b":
			return 2
		case "C":
		case "c":
			return 1
		case "D":
		case "d":
		case "":
			return 0
	}
}

/** Code point order, the order of texts' UTF-8 bytes. */
const codePointOrder: Order.Order<string> = Order.make((a, b) => compareCodePoints(a, b))

/** A lexeme quoted as tsvectorout quotes it: between single quotes, a quote and a backslash doubled. */
const quoted = (lexeme: string): string =>
	`'${pipe(lexeme, Str.replaceAll("\\", "\\\\"), Str.replaceAll("'", "''"))}'`

/** The text a raw document spells, each lexeme quoted and each position written as the raw document states it. */
export const rawText = (d: RawDocument): string =>
	Arr.join(
		Arr.map(d.lexemes, (l) =>
			l.positions.length === 0
				? quoted(l.lexeme)
				: `${quoted(l.lexeme)}:${Arr.join(
						Arr.map(l.positions, (p) => `${p.at}${p.label}`),
						","
					)}`
		),
		" "
	)

/** One lexeme of a document as tsvectorin stores it: its text and its positions, each with its weight. */
interface StoredLexeme {
	readonly lexeme: string
	readonly positions: ReadonlyArray<{ readonly at: number; readonly weight: number }>
}

/**
 * A raw document as tsvectorin stores it, the model: its lexemes merged by text and sorted by their UTF-8 bytes (their
 * code points), each lexeme's positions cut to searchPositionMax (LIMITPOS), sorted, a repeated one keeping its greatest
 * weight, and kept up to searchPositionsMax or the greatest position (uniquePos).
 */
export const stored = (d: RawDocument): ReadonlyArray<StoredLexeme> => {
	const byLexeme = new Map<string, Array<RawPosition>>()
	for (const l of d.lexemes) {
		byLexeme.set(l.lexeme, [...(byLexeme.get(l.lexeme) ?? []), ...l.positions])
	}
	return Arr.map(Arr.sort([...byLexeme.keys()], codePointOrder), (lexeme): StoredLexeme => {
		const weights = new Map<number, number>()
		for (const p of byLexeme.get(lexeme) ?? []) {
			const at = Math.min(p.at, searchPositionMax)
			weights.set(at, Math.max(weights.get(at) ?? 0, weightOf(p.label)))
		}
		const positions = Arr.map(
			Arr.take(Arr.sort([...weights.keys()], Order.Number), searchPositionsMax),
			(at) => ({ at, weight: weights.get(at) ?? 0 })
		)
		return { lexeme, positions }
	})
}

/** The text tsvectorout prints for a stored document. */
export const printed = (lexemes: ReadonlyArray<StoredLexeme>): string =>
	Arr.join(
		Arr.map(lexemes, (l) =>
			l.positions.length === 0
				? quoted(l.lexeme)
				: `${quoted(l.lexeme)}:${Arr.join(
						Arr.map(l.positions, (p) => `${p.at}${labelOf(p.weight)}`),
						","
					)}`
		),
		" "
	)

/** The bytes tsvectorin holds of a stored document, uniqueentry's count: each lexeme's, and its positions'. */
const heldBytes = (lexemes: ReadonlyArray<StoredLexeme>): number =>
	Arr.reduce(lexemes, 0, (held, l) => {
		const after = held + utf8Length(l.lexeme)
		return l.positions.length === 0 ? after : after + (after % 2) + 2 + 2 * l.positions.length
	})

/** Whether tsvectorin refuses a stored document for its size: a lexeme past its bytes, or the whole past its bytes. */
export const oversized = (lexemes: ReadonlyArray<StoredLexeme>): boolean =>
	Arr.some(lexemes, (l) => utf8Length(l.lexeme) > searchLexemeMaxBytes) ||
	heldBytes(lexemes) > textSearchStringMaxBytes

/** A lexeme's character: plain letters, a space, a quote, a backslash, a colon, a comma and characters past ASCII. */
const character = characterOf(["a", "b", "z", " ", "'", "\\", ":", ",", "é", "ß", "語", "😀"])

/**
 * A position: a small one under any label, or one about the greatest, which tsvectorin cuts to it, unlabelled. Two
 * positions tsvectorin cuts to the greatest meet where uniquePos stops, after its unstable sort (pg_qsort), so which
 * label it keeps of two there is no rule a model states; unlabelled, they agree.
 */
const position: Gen<RawPosition> = weighted<RawPosition>([
	[
		6,
		(s) => ({
			at: s.draw(int(1, 40)),
			label: s.draw(
				weighted<Label>([
					[2, constant("")],
					[1, constant("A")],
					[1, constant("B")],
					[1, constant("C")],
					[1, constant("D")],
					[1, constant("a")],
					[1, constant("d")]
				])
			)
		})
	],
	[1, (s) => ({ at: s.draw(int(searchPositionMax - 3, searchPositionMax + 3)), label: "" })]
])

const lexeme: Gen<RawLexeme> = (s) => ({
	lexeme: s.draw(string(character, { min: 1, max: 4 })),
	positions: s.draw(array(position, { min: 0, max: 4 }))
})

/** A raw document of a few short lexemes, repeats, disorder and repeated positions among them. */
export const raw: Gen<RawDocument> = (s) => ({ lexemes: s.draw(array(lexeme, { min: 0, max: 6 })) })

/** A document already in its one form: a raw document as tsvectorin stores it, each lexeme's positions labelled as printed. */
const canonical: Gen<RawDocument> = (s) => {
	const lexemes = stored(s.draw(raw))
	return {
		lexemes: Arr.map(lexemes, (l) => ({
			lexeme: l.lexeme,
			positions: Arr.map(l.positions, (p) => ({ at: p.at, label: labelOf(p.weight) }))
		}))
	}
}

/** The label tsvectorout prints for a weight. */
const labelOf = (weight: number): Label =>
	weight === 3 ? "A" : weight === 2 ? "B" : weight === 1 ? "C" : ""

/** One lexeme of `bytes` UTF-8 bytes of "x" with the most positions, 1 to searchPositionsMax. */
const widest = (bytes: number): RawLexeme => ({
	lexeme: Str.repeat(bytes)("x"),
	positions: Array.from({ length: searchPositionsMax }, (_, i): RawPosition => ({
		at: i + 1,
		label: ""
	}))
})

/** A document of one lexeme of the most positions, searchPositionsMax, and one of one past them. */
const mostPositions: Gen<RawDocument> = (s) => ({
	lexemes: [
		s.draw(
			element([
				widest(1),
				{
					lexeme: "x",
					positions: [...widest(1).positions, { at: searchPositionsMax + 1, label: "" }]
				}
			])
		)
	]
})

/** A document of one lexeme of the most bytes, searchLexemeMaxBytes, or one past them. */
const longestLexeme: Gen<RawDocument> = (s) => ({
	lexemes: [{ lexeme: Str.repeat(searchLexemeMaxBytes + s.draw(int(0, 1)))("y"), positions: [] }]
})

/**
 * A document at the bytes tsvectorin holds, textSearchStringMaxBytes, or one past them: lexemes of searchLexemeMaxBytes
 * each, the numbers that tell them apart leading, and a last one that fills the rest.
 */
const fullest: Gen<RawDocument> = (s) => {
	const whole = Math.floor(textSearchStringMaxBytes / searchLexemeMaxBytes)
	const lexemes = Array.from({ length: whole }, (_, i): RawLexeme => ({
		lexeme: `${Str.padStart(6, "0")(String(i))}${Str.repeat(searchLexemeMaxBytes - 6)("w")}`,
		positions: []
	}))
	const rest = textSearchStringMaxBytes - whole * searchLexemeMaxBytes + s.draw(int(0, 1))
	return { lexemes: [...lexemes, { lexeme: Str.repeat(rest)("z"), positions: [] }] }
}

/**
 * A document in its one form but its first lexeme written twice, side by side: the one way it departs from its one
 * form is the repeat, which tsvectorin merges away.
 */
const repeatedLexeme: Gen<RawDocument> = (s) => {
	const [first, ...rest] = s.draw(canonical).lexemes
	const twice = first ?? { lexeme: "a", positions: [] }
	return { lexemes: [twice, twice, ...rest] }
}

/**
 * A document in its one form but one position of its first lexeme of positions written twice, side by side: the one
 * way it departs from its one form is the repeat, which tsvectorin merges away.
 */
const repeatedPosition: Gen<RawDocument> = (s) => {
	const d = s.draw(canonical)
	const at = Arr.findFirstIndex(d.lexemes, (l) => l.positions.length > 0)
	if (Option.isNone(at)) {
		return {
			lexemes: [
				{
					lexeme: "a",
					positions: [
						{ at: 1, label: "" },
						{ at: 1, label: "" }
					]
				}
			]
		}
	}
	return {
		lexemes: Arr.map(d.lexemes, (l, i) => {
			const [first, ...rest] = l.positions
			return i === at.value && first !== undefined
				? { ...l, positions: [first, first, ...rest] }
				: l
		})
	}
}

/** A drawn case: a raw document, or one already in its one form. */
const cases: Gen<RawDocument> = weighted([
	[1, raw],
	[1, canonical]
])

export type DocumentFeature =
	| "the empty document"
	| "a document in its one form admitted"
	| "a document out of its one form refused"
	| "a repeated lexeme refused"
	| "a repeated position refused"
	| "a position past the greatest refused"
	| "a lexeme of a quote and a backslash"
	| "a lexeme of the most positions admitted"
	| "a lexeme past the most positions refused"
	| "a lexeme past its bytes refused"
	| "a document at its bytes admitted"
	| "a document past its bytes refused"

/** The space, aimed: the documents at and past each of tsvectorin's limits, which a random document never reaches. */
export const documentSpace = aimed(cases, [
	["a repeated lexeme refused", repeatedLexeme],
	["a repeated position refused", repeatedPosition],
	["a lexeme of the most positions admitted", mostPositions],
	["a lexeme past the most positions refused", mostPositions],
	["a lexeme past its bytes refused", longestLexeme],
	["a document at its bytes admitted", fullest],
	["a document past its bytes refused", fullest]
])

/** What a raw document reached, its text `text` and its stored form's `one`. */
export const documentFeatures = (
	d: RawDocument,
	text: string,
	one: string
): ReadonlyArray<DocumentFeature> => {
	const s = stored(d)
	const out: Array<DocumentFeature> = []
	const lexemes = new Set(Arr.map(d.lexemes, (l) => l.lexeme))
	if (text === "") {
		out.push("the empty document")
	}
	if (oversized(s)) {
		out.push(
			Arr.some(s, (l) => utf8Length(l.lexeme) > searchLexemeMaxBytes)
				? "a lexeme past its bytes refused"
				: "a document past its bytes refused"
		)
	} else if (text === one) {
		out.push("a document in its one form admitted")
		if (heldBytes(s) === textSearchStringMaxBytes) {
			out.push("a document at its bytes admitted")
		}
	} else {
		out.push("a document out of its one form refused")
	}
	if (lexemes.size < d.lexemes.length) {
		out.push("a repeated lexeme refused")
	}
	if (
		Arr.some(d.lexemes, (l) => new Set(Arr.map(l.positions, (p) => p.at)).size < l.positions.length)
	) {
		out.push("a repeated position refused")
	}
	if (Arr.some(d.lexemes, (l) => Arr.some(l.positions, (p) => p.at > searchPositionMax))) {
		out.push("a position past the greatest refused")
	}
	if (Arr.some([...lexemes], (l) => Str.includes("'")(l) && Str.includes("\\")(l))) {
		out.push("a lexeme of a quote and a backslash")
	}
	if (Arr.some(d.lexemes, (l) => l.positions.length === searchPositionsMax) && text === one) {
		out.push("a lexeme of the most positions admitted")
	}
	if (Arr.some(d.lexemes, (l) => l.positions.length > searchPositionsMax)) {
		out.push("a lexeme past the most positions refused")
	}
	return out
}

/** A corruption of a document's text in its one form that no text tsvectorout prints survives. */
export type CorruptionFeature =
	| "an unquoted lexeme"
	| "an empty lexeme"
	| "a lone backslash"
	| "an unterminated quote"
	| "a lowercase weight"
	| "a weight D written"
	| "a position of a leading zero"
	| "a position of zero"
	| "two spaces between lexemes"
	| "a trailing space"
	| "an empty position list"

/** A corruption: its name and the text it makes. */
interface Corruption {
	readonly name: CorruptionFeature
	readonly text: string
}

export const corruptionSpace: Gen<Corruption> = (source) =>
	source.draw(
		element([
			{ name: "an unquoted lexeme", text: "a 'b'" },
			{ name: "an empty lexeme", text: "'' 'a'" },
			{ name: "a lone backslash", text: "'a\\b'" },
			{ name: "an unterminated quote", text: "'a" },
			{ name: "a lowercase weight", text: "'a':1a" },
			{ name: "a weight D written", text: "'a':1D" },
			{ name: "a position of a leading zero", text: "'a':01" },
			{ name: "a position of zero", text: "'a':0" },
			{ name: "two spaces between lexemes", text: "'a'  'b'" },
			{ name: "a trailing space", text: "'a' " },
			{ name: "an empty position list", text: "'a':" }
		])
	)
