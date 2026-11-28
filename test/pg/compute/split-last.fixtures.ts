/**
 * What the property of split-last.test.ts reads: its fixture, each read of a split at the last separator under its
 * name, its box and the models it judges by.
 */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Text, Type } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { regexField } from "#compiler/text/field.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/**
 * The characters every text is drawn of: a letter, and each separator a read splits at, a comma, a slash, a dot, a
 * two-byte é and a four-byte character beyond the BMP, a pair of UTF-16 code units.
 */
const characters = ["a", ",", "/", ".", "é", "😀"] as const

/** A text of those characters, within 64 bytes: what every drawn text is, and what a text before is cast into. */
const Drawn = str.bytes(64, regexField<string>("^[a,/.é😀]*$", ["u"]))

/** The text after a comma of a drawn text: a text of its characters but the comma, within its 64 bytes. */
const NoComma = str.bytes(64, regexField<string>("^[a/.é😀]*$", ["u"]))

/** The text after the character beyond the BMP of a drawn text: its characters but that one, within its 64 bytes. */
const NoWide = str.bytes(64, regexField<string>("^[a,/.é]*$", ["u"]))

/** A path of segments of a letter, a dot, é and the character beyond the BMP, within 64 bytes. */
const Path = str.bytes(64, regexField<string>("^[a/.é😀]*$", ["u"]))

/**
 * An extension, as the rooted path's last segment after its last dot is typed: any text but a slash and a dot, within
 * the 64 bytes of the path and the 1 of the slash written ahead of it.
 */
const Extension = str.bytes(65, regexField<string>("^[^/.]*$", ["su"]))

/** The one slash written ahead of a path, so its last segment follows a slash. */
const Slash = str.regex("^/$")

/** The one comma written ahead of a text, so its last piece follows a comma. */
const Comma = str.regex("^,$")

/** Each text split, by its id. */
const Written = relation("Written", { id: int4, text: Drawn }, ["id"])

/** Each path whose extension is read, by its id. */
const Pathed = relation("Pathed", { id: int4, path: Path }, ["id"])

/** A relation holding each type a read casts into, so the installation installs its domain. */
const Held = relation(
	"Held",
	{ id: int4, noComma: NoComma, noWide: NoWide, drawn: Drawn, extension: Extension },
	["id"]
)

export const LastSplits = schema("LastSplits", [Written, Pathed, Held], [])

/** The separator each separator read splits at, by its name. */
export const separators = {
	comma: ",",
	slash: "/",
	dot: ".",
	acute: "é",
	wide: "😀"
} as const

export type Separated = keyof typeof separators

/** The separator reads, in order. */
export const separated = [
	"comma",
	"slash",
	"dot",
	"acute",
	"wide"
] as const satisfies ReadonlyArray<Separated>

/** A read of each written text split at its last `separator`: its id, the text before it and the text after it. */
const splitAt = (separator: string) =>
	query(LastSplits).rule((r) => {
		const { id, text } = v(Written, "w")
		const split = r.splitLast(text, separator)
		const { before, after } = v(split, "s")
		return r
			.match(Written, { id, text })
			.match(split, { before, after })
			.find({ id, before, after })
	})

/**
 * The reads a case holds to the models, each under its name in the workload, beside the load of its facts:
 *
 * - each separator's split of the drawn texts (splitAt);
 * - the split at a comma, the text before cast into Drawn and the text after into NoComma, and at the character beyond
 *   the BMP, the text after cast into NoWide, which compile only where the text after is typed as its text's
 *   characters but its separator, and both within its bytes;
 * - the texts no comma splits, a negation of it, and the split of the parameter `text` at a slash;
 * - each text's last piece at a comma, the text after the last comma of the text with a comma written ahead of it, a
 *   computed text; and the texts that hold a comma, a negation of that split whose text before is empty;
 * - each path's extension: the text after the last dot of the last segment, the text after the last slash of the path
 *   with a slash written ahead of it, where the texts before and after that dot are not empty, cast into Extension,
 *   which compiles only where each computed and split text keeps its byte bound.
 */
const programs = Object.freeze({
	load: ChangeSet.empty(LastSplits).insert(Written, []).insert(Pathed, []),
	comma: splitAt(separators.comma),
	slash: splitAt(separators.slash),
	dot: splitAt(separators.dot),
	acute: splitAt(separators.acute),
	wide: splitAt(separators.wide),
	commaCast: query(LastSplits).rule((r) => {
		const { id, text } = v(Written, "w")
		const split = r.splitLast(text, separators.comma)
		const { before, after } = v(split, "s")
		return r
			.match(Written, { id, text })
			.match(split, { before, after })
			.find({ id, before: Type.cast(before, Drawn), after: Type.cast(after, NoComma) })
	}),
	wideCast: query(LastSplits).rule((r) => {
		const { id, text } = v(Written, "w")
		const split = r.splitLast(text, separators.wide)
		const { before, after } = v(split, "s")
		return r
			.match(Written, { id, text })
			.match(split, { before, after })
			.find({ id, before, after: Type.cast(after, NoWide) })
	}),
	unsplit: query(LastSplits).rule((r) => {
		const { id, text } = v(Written, "w")
		return r
			.match(Written, { id, text })
			.where(r.not(r.splitLast(text, separators.comma), {}))
			.find({ id })
	}),
	param: query(LastSplits).rule((r) => {
		const split = r.splitLast(r.param("text", Drawn), separators.slash)
		const { before, after } = v(split, "s")
		return r.match(split, { before, after }).find({ before, after })
	}),
	lastPiece: query(LastSplits).rule((r) => {
		const { id, text } = v(Written, "w")
		const split = r.splitLast(Text.concat(Type.literal(Comma, ","), text), separators.comma)
		const { after } = v(split, "s")
		return r.match(Written, { id, text }).match(split, { after }).find({ id, after })
	}),
	commaHeld: query(LastSplits).rule((r) => {
		const { id, text } = v(Written, "w")
		return r
			.match(Written, { id, text })
			.where(
				r.not(r.splitLast(Text.concat(Type.literal(Comma, ","), text), separators.comma), {
					before: ""
				})
			)
			.find({ id })
	}),
	extension: query(LastSplits).rule((r) => {
		const { id, path } = v(Pathed, "p")
		const lastSlash = r.splitLast(Text.concat(Type.literal(Slash, "/"), path), "/")
		const { after: segment } = v(lastSlash, "segment")
		const lastDot = r.splitLast(segment, ".")
		const { before: stem, after: extension } = v(lastDot, "dot")
		return r
			.match(Pathed, { id, path })
			.match(lastSlash, { after: segment })
			.match(lastDot, { before: stem, after: extension })
			.where(r.ne(stem, ""), r.ne(extension, ""))
			.find({ id, extension: Type.cast(extension, Extension) })
	})
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const lastSplitsInstall = Object.freeze({ label: "last_splits", programs })

/** LastSplits installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const lastSplitsTemplate = fixtureTemplate(import.meta, LastSplits, lastSplitsInstall)

/** A text of up to `max` of the characters, separators repeated, leading and trailing among them. */
const textOf =
	(max: number): Gen<string> =>
	(s) =>
		Arr.join(s.draw(array(element(characters), { min: 0, max })), "")

/** The characters a path's segment is drawn of: a letter, a dot, é and the character beyond the BMP. */
const segmentCharacters = ["a", ".", "é", "😀"] as const

/** A segment of `min` to `max` of the segment characters, dots repeated, leading and trailing among them. */
const segmentOf =
	(min: number, max: number): Gen<string> =>
	(s) =>
		Arr.join(s.draw(array(element(segmentCharacters), { min, max })), "")

/**
 * A path of no trailing slash: up to three segments before its last, each of up to three characters, the empty one
 * among them, so a path may lead with a slash or hold two in a row; and its last segment, of one to four characters,
 * or of none where it is the path's only one, the empty path.
 */
const pathGen: Gen<string> = (s) => {
	const directories = s.draw(array(segmentOf(0, 3), { min: 0, max: 3 }))
	const last = s.draw(segmentOf(directories.length === 0 ? 0 : 1, 4))
	return Arr.join([...directories, last], "/")
}

/** A case: the texts it writes, one to six, the paths, one to six, and the parameter text. */
export interface LastSplitCase {
	readonly texts: Arr.NonEmptyReadonlyArray<string>
	readonly paths: Arr.NonEmptyReadonlyArray<string>
	readonly text: string
}

/** One to `max` draws of `gen`. */
const nonEmpty =
	<A>(gen: Gen<A>, max: number): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(s) => [s.draw(gen), ...s.draw(array(gen, { min: 0, max: max - 1 }))]

export const caseGen: Gen<LastSplitCase> = (s) => ({
	texts: s.draw(nonEmpty(textOf(10), 6)),
	paths: s.draw(nonEmpty(pathGen, 6)),
	text: s.draw(textOf(s.draw(int(0, 6))))
})

/** A case's facts: its texts and its paths, each by its id from 1. */
export const factsOf = (c: LastSplitCase) => ({
	Written: Arr.map(c.texts, (text, i) => ({ id: i + 1, text })),
	Pathed: Arr.map(c.paths, (path, i) => ({ id: i + 1, path }))
})

/** A text split at its last separator: the text before it and the text after it, none where the text holds none. */
export interface LastSplit {
	readonly before: string
	readonly after: string
}

/** The model of a split at the last separator: the text around JavaScript's lastIndexOf of it, none where it is -1. */
export const lastSplitOf = (text: string, separator: string): Option.Option<LastSplit> =>
	Option.map(Str.lastIndexOf(separator)(text), (at) => ({
		before: Str.slice(0, at)(text),
		after: Str.slice(at + separator.length)(text)
	}))

/** A row of splits, written as its identity, so a set of them compares in one order. */
export const splitsText = (
	rows: Iterable<{ readonly id: number; readonly before: string; readonly after: string }>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => `${r.id} ${jsonText(r.before)} ${jsonText(r.after)}`),
		Order.String
	)

/** The model's splits of the texts at `separator`, each keyed by its text's id. */
export const splitsModel = (texts: ReadonlyArray<string>, separator: string) =>
	splitsText(
		Arr.flatMap(texts, (text, i) =>
			Option.toArray(Option.map(lastSplitOf(text, separator), (split) => ({ id: i + 1, ...split })))
		)
	)

/** A row of one text by its id, written as its identity. */
export const textsText = (
	rows: Iterable<{ readonly id: number; readonly text: string }>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => `${r.id} ${jsonText(r.text)}`),
		Order.String
	)

/** The ids of rows, in order. */
export const idsText = (rows: Iterable<{ readonly id: number }>): ReadonlyArray<number> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => r.id),
		Order.Number
	)

/** The ids of the texts that hold `separator`, or that hold none where `held` is false. */
export const holdingModel = (
	texts: ReadonlyArray<string>,
	separator: string,
	held: boolean
): ReadonlyArray<number> =>
	Arr.flatMap(texts, (text, i) => (Str.includes(separator)(text) === held ? [i + 1] : []))

/** The model of a last piece: the last of JavaScript's split of each text at a comma, its whole text where it has none. */
export const lastPiecesModel = (texts: ReadonlyArray<string>) =>
	textsText(
		Arr.map(texts, (text, i) => ({
			id: i + 1,
			text: Arr.lastNonEmpty(Str.split(text, separators.comma))
		}))
	)

/**
 * How a path's extension is read, with its dot: Node's path.posix.extname, as effect's POSIX Path service (Path.layer)
 * reads it.
 */
export type Extname = (path: string) => string

/** The model of a path's extension: its extname without its dot, none where that is empty. */
const extensionOf = (extname: Extname, path: string): Option.Option<string> =>
	Option.filter(Option.some(Str.slice(1)(extname(path))), Str.isNonEmpty)

/** The model's extensions of the paths, each keyed by its path's id. */
export const extensionsModel = (extname: Extname, paths: ReadonlyArray<string>) =>
	textsText(
		Arr.flatMap(paths, (path, i) =>
			Option.toArray(Option.map(extensionOf(extname, path), (text) => ({ id: i + 1, text })))
		)
	)

export type LastSplitFeature =
	| "the empty text"
	| "a separator at either end"
	| "two separators in a row"
	| "no separator in the text"
	| "a split at a character beyond the BMP"
	| "a path of one segment"
	| "a last segment that leads with a dot"
	| "a last segment that ends with a dot"
	| "a dot in a directory and none in the last segment"
	| "an extension after two dots"

/** The five separators, as texts. */
const separatorTexts = Arr.map(separated, (name) => separators[name])

/** The situations a case reaches. */
export const lastSplitFeatures = (
	extname: Extname,
	c: LastSplitCase
): ReadonlyArray<LastSplitFeature> => {
	const textFeatures = Arr.flatMap(c.texts, (text): ReadonlyArray<LastSplitFeature> => [
		...(text === "" ? ["the empty text" as const] : []),
		...(Arr.some(
			separatorTexts,
			(sep) => text !== "" && (Str.startsWith(sep)(text) || Str.endsWith(sep)(text))
		)
			? ["a separator at either end" as const]
			: []),
		...(Arr.some(separatorTexts, (sep) => Str.includes(`${sep}${sep}`)(text))
			? ["two separators in a row" as const]
			: []),
		...(text !== "" && !Str.includes(separators.comma)(text)
			? ["no separator in the text" as const]
			: []),
		...(Str.includes(separators.wide)(text)
			? ["a split at a character beyond the BMP" as const]
			: [])
	])
	const pathFeatures = Arr.flatMap(c.paths, (path): ReadonlyArray<LastSplitFeature> => {
		const segment = Arr.lastNonEmpty(Str.split(path, "/"))
		return [
			...(!Str.includes("/")(path) ? ["a path of one segment" as const] : []),
			...(Str.startsWith(".")(segment) ? ["a last segment that leads with a dot" as const] : []),
			...(Str.endsWith(".")(segment) ? ["a last segment that ends with a dot" as const] : []),
			...(!Str.includes(".")(segment) && Str.includes(".")(path)
				? ["a dot in a directory and none in the last segment" as const]
				: []),
			...(Option.isSome(extensionOf(extname, path)) && Str.includes("..")(segment)
				? ["an extension after two dots" as const]
				: [])
		]
	})
	return [...textFeatures, ...pathFeatures]
}
