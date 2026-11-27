/**
 * The records agreement (test/types/schema/records.ts): over drawn queries of Shelves, each with its books attached as
 * an array and each book with a drawn subset of its blurb, spine, paper, digital and chapters, each chapter with its
 * remark (test/support/agreement/records.ts), at depths one to three and every delivery, and a name stated for the
 * books' or the chapters' path or none, RecordPaths types exactly the paths recordPaths lists at run time, and the
 * types of records(...) name, key and field each relation exactly as the
 * engine builds it, a stated name the relation's at its path, an attachment's relation qualified by its parent's name,
 * stated or derived, where its name repeats in the tree and an array's place moved past a column or attachment named
 * `at`; a stray path among the names is refused by name;
 * a level over Shelves lists their relations and laws as schema.extend takes them; their read (recordsQuery) delivers
 * the query's own records under either reading, HeadOf and ImmediateHeadOf; each relation's facts, but its key and its
 * arrays' counts, are the query's records at its level, but their attachments and head literals: a contract's brand, a
 * closed id's handles and each column's host type kept; and insertAll over the level takes their insert (recordsFacts).
 * A batch's cases are one program, checked armed. Oracle: the engine's records of each drawn query.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { Array as Arr, Option } from "effect"
import type { RecordsShape, StatedShape } from "#test/support/agreement/records.ts"
import { statedPath, statedShapeGen } from "#test/support/agreement/records.ts"
import { agreement } from "#test/types/batch/agreement.ts"
import { recordsProgram } from "#test/types/schema/records.ts"

/** What a shape reaches: each delivery below the books, a third level, a repeated name, a moved place. */
type RecordsFeature =
	| "an option"
	| "one child"
	| "a nested array"
	| "a third level"
	| "a repeated name"
	| "a moved place"
	| "a stated name"
	| "a stated name above a repeated name"

/** An attachment of a shape, as its notes read it: its name and delivery. */
interface Drawn {
	readonly name: string
	readonly delivery: string
}

/** The attachments of a shape, at every depth. */
const drawnOf = (shape: RecordsShape): ReadonlyArray<Drawn> => {
	const b = shape.books
	const below: ReadonlyArray<Option.Option<Drawn>> = [
		b.blurb,
		b.spine,
		Option.flatMap(b.spine, (s) => s.ink),
		b.paper,
		b.digital,
		Option.map(b.chapters, (c) => ({ name: c.name, delivery: "array" })),
		Option.flatMap(b.chapters, (c) => c.remark)
	]
	return [{ name: b.name, delivery: "array" }, ...Arr.getSomes(below)]
}

/** The features a shape reaches. */
const notes = (stated: StatedShape): ReadonlyArray<RecordsFeature> => {
	const { shape } = stated
	const b = shape.books
	const drawn = drawnOf(shape)
	const names = Arr.map(drawn, (d) => d.name)
	const delivered = (delivery: string): boolean => Arr.some(drawn, (d) => d.delivery === delivery)
	const repeated =
		Arr.some(names, (n, i) => Arr.some(Arr.take(names, i), (m) => m === n)) ||
		Arr.some(names, (n) => n === "row")
	const third =
		Option.exists(b.chapters, (c) => Option.isSome(c.remark)) ||
		Option.exists(b.spine, (s) => Option.isSome(s.ink))
	const moved = b.at || Arr.some(names, (n) => n === "at") || Option.isSome(b.chapters)
	const feature = (holds: boolean, f: RecordsFeature): ReadonlyArray<RecordsFeature> =>
		holds ? [f] : []
	return [
		...feature(delivered("option"), "an option"),
		...feature(delivered("one"), "one child"),
		...feature(Option.isSome(b.chapters), "a nested array"),
		...feature(third, "a third level"),
		...feature(repeated, "a repeated name"),
		...feature(moved, "a moved place"),
		...feature(Option.isSome(statedPath(stated)), "a stated name"),
		...feature(
			Option.isSome(statedPath(stated)) &&
				repeated &&
				Option.exists(stated.stated, (books) => books),
			"a stated name above a repeated name"
		)
	]
}

/** The types of records(...) agree with the engine's records of each drawn query, its level, read and insert. */
export const recordsAgree = agreement(statedShapeGen, {
	situations: [
		"an option",
		"one child",
		"a nested array",
		"a third level",
		"a repeated name",
		"a moved place",
		"a stated name",
		"a stated name above a repeated name"
	] satisfies ReadonlyArray<Reached<RecordsFeature>>,
	notes,
	checking: "armed",
	program: recordsProgram,
	oracle: { kind: "second-implementation", name: "the engine's records of each drawn query" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/records.ts",
			original: "| AttachmentPaths<ChildrenOf<At[N]>, ",
			replacement: "| AttachmentPaths<ChildrenOf<never>, ",
			why: "The paths stop at the books (types/schema/records.ts AttachmentPaths): RecordPaths types no path under them where recordPaths lists the chapters' and the rest, and a name stated for the chapters' path is refused as no path."
		},
		{
			file: "packages/engine/src/types/schema/records.ts",
			original:
				'\t? Nm["names"][Path] & string\n\t: AttachedName<Nm["stem"], Nm["paths"], Parent, N>',
			replacement:
				'\t? AttachedName<Nm["stem"], Nm["paths"], Parent, N>\n\t: AttachedName<Nm["stem"], Nm["paths"], Parent, N>',
			why: "A stated name is read nowhere (types/schema/records.ts NameAt), so the relation at its path, and each repeated name under it, are typed by their derived names where the engine names them as stated; the names disagree."
		},
		{
			file: "packages/engine/src/types/schema/records.ts",
			original:
				"\t\t: Refusal<\"records' names name only the query's attachments, each by its path\">",
			replacement: "\t\t: Names[P]",
			why: "A name stated for a path no attachment has is taken (types/schema/records.ts StatedNames), so the stray line compiles."
		},
		{
			file: "packages/engine/src/types/schema/records.ts",
			original:
				"\tC extends Carrier<infer A, infer S, infer D, infer F, infer L> ? Field<A, S, D, F, L> : never",
			replacement:
				"\tC extends Carrier<infer A, infer S, infer D, infer F, infer L> ? Field<unknown, S, D, F, L> : never",
			why: "A stored field forgets its column's host type (types/schema/records.ts StoredField), so every relation's facts hold unknown where the query's records hold the column's value; the stored columns disagree."
		},
		{
			file: "packages/engine/src/types/schema/records.ts",
			original:
				"\treadonly [K in keyof Hc as IsHeadLiteral<Hc[K]> extends true ? never : K]: StoredField<Hc[K]>",
			replacement: "\treadonly [K in keyof Hc]: StoredField<Hc[K]>",
			why: "A head literal is typed as a stored field (types/schema/records.ts StoredFieldsOf), so a books relation heading its literal types a field the engine stores nowhere; its fields disagree."
		},
		{
			file: "packages/engine/src/types/schema/records.ts",
			original:
				"\tPhantomOf<C> extends { readonly origin: LiteralOrigin } ? IsOneValue<ValueOfTerm<C>> : false",
			replacement:
				"\tPhantomOf<C> extends { readonly origin: LiteralOrigin } ? IsOneValue<C extends Carrier<infer A> ? A : ValueOfTerm<C>> : false",
			why: "A head literal's values are read off its carrier whole (types/schema/records.ts IsHeadLiteral), as at 02a9bfab4: `Carrier<infer A>` reads A from the column, the domain and the language at once, so a books relation's `source: \"shelf\"` delivers string, no one value, and is typed as a stored field the engine stores nowhere; its fields disagree."
		},
		{
			file: "packages/engine/src/types/schema/records.ts",
			original: "\t? C extends Taken\n\t\t? Fresh<B, Taken, readonly [...Count, unknown]>\n\t\t: C",
			replacement: "\t? C",
			why: "A carried key field or a place is named as its base whatever the child's columns and attachments take (types/schema/records.ts Fresh), so a books relation heading `at` types its place `at`, where the engine moves it to `at2`; its key and fields disagree."
		},
		{
			file: "packages/engine/src/types/schema/records.ts",
			original: "\ttrue extends Repeats<Paths, Capitalize<N>>",
			replacement: "\tfalse extends Repeats<Paths, Capitalize<N>>",
			why: "An attachment's relation is qualified by its parent's name where its name is the tree's alone (types/schema/records.ts AttachedName), so the names disagree with the engine's."
		},
		{
			file: "packages/engine/src/types/schema/records.ts",
			original:
				'\t? { [N in keyof At & string]: DeliveryOf<At[N]> extends "array" ? N : never }[keyof At & string]',
			replacement: "\t? { [N in keyof At & string]: never }[keyof At & string]",
			why: "An array attachment's count is no field of its parent (types/schema/records.ts ArrayNames), so the parent's fields disagree with the engine's and the ordered family's fin names no field."
		},
		{
			file: "packages/engine/src/types/schema/records.ts",
			original:
				'\t? Carried extends ReadonlyArray<AnyKeyField>\n\t\t? readonly [...Carried, KeyField<Fresh<"at", Taken | NamesIn<Carried>>, DrawnField>]\n\t\t: never',
			replacement: "\t? Carried",
			why: "An array child's key is its carried key alone, its place left out (types/schema/records.ts KeyOfChild), so every array relation's key and fields disagree with the engine's, and its children carry no place."
		}
	]
})
