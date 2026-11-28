/**
 * What the property of split.test.ts reads: its fixture, each read of a split or a rest under its name, its box and the
 * model it judges by.
 */

import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { regexField } from "#compiler/text/field.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/**
 * The characters every text is drawn of: a letter, each separator a read splits at (a comma, a slash, a space, which
 * XML calls white space, a two-byte é and a four-byte character beyond the BMP, a pair of UTF-16 code units), and a
 * tab, which no read splits at.
 */
const characters = ["a", ",", "/", " ", "é", "😀", "\t"] as const

/** A text of those characters, within 64 bytes: what every drawn text is, and what a rest of one is cast into. */
const Drawn = str.bytes(64, regexField<string>("^[a,/ é😀\\t]*$", ["u"]))

/** Any text, of no bound: a separator split of it is typed as any text but its separator, of no bound either. */
const Loose = str.regex("^.*$", "su")

/** A piece at a comma of a drawn text: a text of its characters but the comma, within its 64 bytes. */
const NoComma = str.bytes(64, regexField<string>("^[a/ é😀\\t]*$", ["u"]))

/** A piece at the character beyond the BMP of a drawn text: its characters but that one, within its 64 bytes. */
const NoWide = str.bytes(64, regexField<string>("^[a,/ é\\t]*$", ["u"]))

/** Each text split, by its id: a drawn one, and the same text again as any text. */
const Written = relation("Written", { id: pg.integer, text: Drawn, loose: Loose }, ["id"])

/** Each text and the prefix its rest is read after, by its id. */
const Prefixed = relation("Prefixed", { id: pg.integer, text: Drawn, prefix: Drawn }, ["id"])

/** A relation holding each type a read casts into, so the installation installs its domain. */
const Held = relation("Held", { id: pg.integer, noComma: NoComma, noWide: NoWide, drawn: Drawn }, [
	"id"
])

export const Splits = schema("Splits", [Written, Prefixed, Held], [])

/** The separator each separator read splits at, by its name. */
export const separators = {
	comma: ",",
	slash: "/",
	space: " ",
	acute: "é",
	wide: "😀"
} as const

export type Separated = keyof typeof separators

/** The separator reads, in order. */
export const separated = [
	"comma",
	"slash",
	"space",
	"acute",
	"wide"
] as const satisfies ReadonlyArray<Separated>

/** A read of each written text's pieces at `separator`: its id, each piece's place and the piece. */
const piecesAt = (separator: string) =>
	query(Splits).rule((r) => {
		const { id, text, loose } = v(Written, "w")
		const split = r.split(text, separator)
		const { at, piece } = v(split, "p")
		return r.match(Written, { id, text, loose }).match(split, { at, piece }).find({ id, at, piece })
	})

/**
 * The reads a case holds to the model, each under its name in the workload, beside the load of its facts:
 *
 * - each separator's pieces of the drawn texts (piecesAt);
 * - the pieces at a comma, each cast into NoComma, and at the character beyond the BMP, cast into NoWide, which compile
 *   only where a piece is typed as its text's characters but its separator within its bytes;
 * - the pieces at a slash of the texts as any text;
 * - each text's rest after its prefix, cast into Drawn, which compiles only where a rest is typed as its text's
 *   characters within its bytes; the texts no rest is read of, a negation of it; a rest after the constant `a,` and
 *   after the parameter `prefix`; and a rest of a rest, after its prefix and then after a comma.
 */
const programs = Object.freeze({
	load: ChangeSet.empty(Splits).insert(Written, []).insert(Prefixed, []),
	comma: piecesAt(separators.comma),
	slash: piecesAt(separators.slash),
	space: piecesAt(separators.space),
	acute: piecesAt(separators.acute),
	wide: piecesAt(separators.wide),
	commaCast: query(Splits).rule((r) => {
		const { id, text, loose } = v(Written, "w")
		const split = r.split(text, separators.comma)
		const { at, piece } = v(split, "p")
		return r
			.match(Written, { id, text, loose })
			.match(split, { at, piece })
			.find({ id, at, piece: Type.cast(piece, NoComma) })
	}),
	wideCast: query(Splits).rule((r) => {
		const { id, text, loose } = v(Written, "w")
		const split = r.split(text, separators.wide)
		const { at, piece } = v(split, "p")
		return r
			.match(Written, { id, text, loose })
			.match(split, { at, piece })
			.find({ id, at, piece: Type.cast(piece, NoWide) })
	}),
	looseSlash: query(Splits).rule((r) => {
		const { id, text, loose } = v(Written, "w")
		const split = r.split(loose, separators.slash)
		const { at, piece } = v(split, "p")
		return r.match(Written, { id, text, loose }).match(split, { at, piece }).find({ id, at, piece })
	}),
	rest: query(Splits).rule((r) => {
		const { id, text, prefix } = v(Prefixed, "p")
		const after = r.rest(text, prefix)
		const { rest } = v(after, "r")
		return r
			.match(Prefixed, { id, text, prefix })
			.match(after, { rest })
			.find({ id, rest: Type.cast(rest, Drawn) })
	}),
	unprefixed: query(Splits).rule((r) => {
		const { id, text, prefix } = v(Prefixed, "p")
		return r
			.match(Prefixed, { id, text, prefix })
			.where(r.not(r.rest(text, prefix), {}))
			.find({ id })
	}),
	restConstant: query(Splits).rule((r) => {
		const { id, text, prefix } = v(Prefixed, "p")
		const after = r.rest(text, "a,")
		const { rest } = v(after, "r")
		return r.match(Prefixed, { id, text, prefix }).match(after, { rest }).find({ id, rest })
	}),
	restParam: query(Splits).rule((r) => {
		const { id, text, prefix } = v(Prefixed, "p")
		const after = r.rest(text, r.param("prefix", Drawn))
		const { rest } = v(after, "r")
		return r.match(Prefixed, { id, text, prefix }).match(after, { rest }).find({ id, rest })
	}),
	restRest: query(Splits).rule((r) => {
		const { id, text, prefix } = v(Prefixed, "p")
		const first = r.rest(text, prefix)
		const { rest: once } = v(first, "once")
		const second = r.rest(once, ",")
		const { rest: twice } = v(second, "twice")
		return r
			.match(Prefixed, { id, text, prefix })
			.match(first, { rest: once })
			.match(second, { rest: twice })
			.find({ id, rest: twice })
	})
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const splitsInstall = Object.freeze({ label: "splits", programs })

/** Splits installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const splitsTemplate = fixtureTemplate(import.meta, Splits, splitsInstall)

/** A text of up to `max` of the characters, separators repeated, leading and trailing among them. */
const textOf =
	(max: number): Gen<string> =>
	(s) =>
		Arr.join(s.draw(array(element(characters), { min: 0, max })), "")

/** A text and the prefix its rest is read after: most often a prefix of it, else any text, the empty one among them. */
export interface PrefixPair {
	readonly text: string
	readonly prefix: string
}

const pairGen: Gen<PrefixPair> = (s) => {
	const text = s.draw(textOf(8))
	const points = Array.from(text)
	return {
		text,
		prefix: s.draw(
			weighted<string>([
				[3, (t) => Arr.join(points.slice(0, t.draw(int(0, points.length))), "")],
				[2, textOf(3)]
			])
		)
	}
}

/** A case: the texts it writes, one to six, the prefix pairs, one to six, and the parameter prefix. */
export interface SplitCase {
	readonly texts: Arr.NonEmptyReadonlyArray<string>
	readonly pairs: Arr.NonEmptyReadonlyArray<PrefixPair>
	readonly prefix: string
}

/** One to `max` draws of `gen`. */
const nonEmpty =
	<A>(gen: Gen<A>, max: number): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(s) => [s.draw(gen), ...s.draw(array(gen, { min: 0, max: max - 1 }))]

export const caseGen: Gen<SplitCase> = (s) => ({
	texts: s.draw(nonEmpty(textOf(10), 6)),
	pairs: s.draw(nonEmpty(pairGen, 6)),
	prefix: s.draw(textOf(2))
})

/** A case's facts: its texts by their ids from 1, each as any text too, and its pairs by theirs. */
export const factsOf = (c: SplitCase) => ({
	Written: Arr.map(c.texts, (text, i) => ({ id: i + 1, text, loose: text })),
	Prefixed: Arr.map(c.pairs, ({ text, prefix }, i) => ({ id: i + 1, text, prefix }))
})

/** A row of pieces, written as its identity, so a set of them compares in one order. */
export const piecesText = (
	rows: Iterable<{ readonly id: number; readonly at: bigint; readonly piece: string }>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => `${r.id} ${r.at} ${jsonText(r.piece)}`),
		Order.String
	)

/** A row of rests, written as its identity. */
export const restsText = (
	rows: Iterable<{ readonly id: number; readonly rest: string }>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => `${r.id} ${jsonText(r.rest)}`),
		Order.String
	)

/** The ids of rows, in order. */
export const idsText = (rows: Iterable<{ readonly id: number }>): ReadonlyArray<number> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => r.id),
		Order.Number
	)

/** The model of a negated rest: the ids of the pairs whose text does not start with their prefix. */
export const unprefixedModel = (pairs: ReadonlyArray<PrefixPair>): ReadonlyArray<number> =>
	Arr.flatMap(pairs, ({ text, prefix }, i) => (Str.startsWith(prefix)(text) ? [] : [i + 1]))

/** The model of a separator split: JavaScript's own split of each text, n occurrences n + 1 pieces, each at its place. */
export const piecesModel = (texts: ReadonlyArray<string>, separator: string) =>
	piecesText(
		Arr.flatMap(texts, (text, i) =>
			Arr.map(Str.split(text, separator), (piece, at) => ({ id: i + 1, at: BigInt(at), piece }))
		)
	)

/** The model of a rest: the text past its prefix where it starts with the prefix, none where it does not. */
export const restOf = (text: string, prefix: string): ReadonlyArray<string> =>
	Str.startsWith(prefix)(text) ? [Str.slice(prefix.length)(text)] : []

/** The model's rests of pairs, each pair's by `rests`, keyed by the pair's id. */
export const restsModel = (
	pairs: ReadonlyArray<PrefixPair>,
	rests: (pair: PrefixPair) => ReadonlyArray<string>
) =>
	restsText(Arr.flatMap(pairs, (pair, i) => Arr.map(rests(pair), (rest) => ({ id: i + 1, rest }))))

export type SplitFeature =
	| "the empty text, one empty piece"
	| "a separator at either end"
	| "two separators in a row"
	| "no separator in the text"
	| "a split at a character beyond the BMP"
	| "a rest after the empty prefix"
	| "a rest after the whole text"
	| "a text without the prefix"
	| "a prefix longer than the text"
	| "a rest of a rest"

/** The five separators, as texts. */
const separatorTexts = Arr.map(separated, (name) => separators[name])

/** The situations a case reaches. */
export const splitFeatures = (c: SplitCase): ReadonlyArray<SplitFeature> => {
	const textFeatures = Arr.flatMap(c.texts, (text): ReadonlyArray<SplitFeature> => [
		...(text === "" ? ["the empty text, one empty piece" as const] : []),
		...(Arr.some(
			separatorTexts,
			(sep) => text !== "" && (Str.startsWith(sep)(text) || Str.endsWith(sep)(text))
		)
			? ["a separator at either end" as const]
			: []),
		...(Arr.some(separatorTexts, (sep) => Str.includes(`${sep}${sep}`)(text))
			? ["two separators in a row" as const]
			: []),
		...(text !== "" && !Str.includes(",")(text) ? ["no separator in the text" as const] : []),
		...(Str.includes(separators.wide)(text)
			? ["a split at a character beyond the BMP" as const]
			: [])
	])
	const pairFeatures = Arr.flatMap(c.pairs, ({ text, prefix }): ReadonlyArray<SplitFeature> => [
		...(prefix === "" ? ["a rest after the empty prefix" as const] : []),
		...(prefix === text ? ["a rest after the whole text" as const] : []),
		...(!Str.startsWith(prefix)(text) ? ["a text without the prefix" as const] : []),
		...(prefix.length > text.length ? ["a prefix longer than the text" as const] : []),
		...(Arr.some(restOf(text, prefix), (rest) => Str.startsWith(",")(rest))
			? ["a rest of a rest" as const]
			: [])
	])
	return [...textFeatures, ...pairFeatures]
}
