/**
 * The containments the reverse-index suites draw, and the rule their reverse index is planned by, restated: the law
 * model's plan (test/unit/laws/model/reverse-index.test.ts) and PostgreSQL's plan of the reverse probe
 * (test/pg/laws/reverse-probe.test.ts).
 *
 * A case is a source relation's referencing columns, each a fixed-width type, a short or a long bounded text, a text
 * too wide for an entry alone, or a text of no bound, at every position; a target with the columns they meet, each text
 * of a short pattern, since a pattern is no part of a text's type, keyed by them all or by the first alone, so that the
 * containment references a superkey of it through a UNIQUE grizzle plans; whether a declared key covers the bounded
 * columns; and whether the source side is a selection, whose columns are law columns that may be NULL. The rule is
 * restated over index_form_tuple's layout of each run (heaptuple.c fill_val) against nbtree.h's BTMaxItemSize.
 */
import { array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { uuid } from "#compiler/public/fields.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { relation } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import {
	containedBuilder,
	keyBuilder,
	onBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import type { RowTerm, rowHelpers } from "#compiler/schema/terms.ts"
import { regexField } from "#compiler/text/field.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { defined } from "#test/support/assert.ts"

/** nbtree.h's BTMaxItemSize at the default block, restated. */
const postgresBtreeMaxItem = 2704

/** A referencing column's type: a fixed-width one, a text of a bounded pattern of so many code points, or free text. */
export type ColumnType =
	| { readonly kind: "uuid" | "bigint" | "integer" | "smallint" | "boolean" }
	| { readonly kind: "text"; readonly codePoints: number }
	| { readonly kind: "free" }

/** The bounded texts drawn: short, long enough that two outgrow an entry, and too wide for an entry alone. */
const textLengths = [10, 400, 765] as const

/** A datum's longest bytes, its type's alignment, and whether its type is fixed-width. */
interface Datum {
	readonly bytes: number
	readonly align: number
	readonly fixed: boolean
}

/** pg_type's typlen and typalign; a bounded text's 4-byte varlena header and four bytes a code point, int-aligned. */
const datumOf = (t: ColumnType): Datum | undefined => {
	switch (t.kind) {
		case "uuid":
			return { bytes: 16, align: 1, fixed: true }
		case "bigint":
			return { bytes: 8, align: 8, fixed: true }
		case "integer":
			return { bytes: 4, align: 4, fixed: true }
		case "smallint":
			return { bytes: 2, align: 2, fixed: true }
		case "boolean":
			return { bytes: 1, align: 1, fixed: true }
		case "text":
			return { bytes: 4 + 4 * t.codePoints, align: 4, fixed: false }
		case "free":
			return undefined
	}
}

/** Where the datums laid out so far end, and whether every offset so far is exact. */
interface Laid {
	readonly end: number
	readonly exact: boolean
}

/**
 * The most bytes a B-tree tuple over `datums` reaches, as index_form_tuple lays it out: its data after the 8-byte header,
 * and the null bitmap, MAXALIGNed to 16, where a column may be NULL; each fixed-width datum that is never NULL at its
 * alignment while every one before it is such, and from the first varlena or NULL-able column on each datum after its
 * worst padding, align - 1; the whole MAXALIGNed.
 */
const entryBytes = (datums: ReadonlyArray<Datum>, nullable: boolean): number => {
	const start: Laid = { end: nullable ? 16 : 8, exact: true }
	const { end } = Arr.reduce(datums, start, ({ end: at, exact }, d): Laid => ({
		end: exact ? Math.ceil(at / d.align) * d.align + d.bytes : at + d.align - 1 + d.bytes,
		exact: exact && d.fixed && !nullable
	}))
	return Math.ceil(end / 8) * 8
}

/** The reverse index the rule plans over the referencing columns, by their positions. */
export type Expected =
	| { readonly method: "btree"; readonly positions: Arr.NonEmptyReadonlyArray<number> }
	| { readonly method: "hash"; readonly position: number }

/**
 * The rule restated: the longest leading run of the bounded columns, in order, whose entry fits, its columns NULL-able
 * when the source is a selection; else a hash index on the first column whose type a hash index takes, every drawn
 * type here.
 */
export const expectedOf = (c: ReverseCase): Expected => {
	const bounded = Arr.flatMap(c.types, (t, i) => {
		const datum = datumOf(t)
		return datum === undefined ? [] : [{ i, datum }]
	})
	for (let n = bounded.length; n > 0; n--) {
		const run = Arr.take(bounded, n)
		const [first, ...rest] = run
		if (
			first !== undefined &&
			entryBytes(
				Arr.map(run, (b) => b.datum),
				c.selected
			) <= postgresBtreeMaxItem
		) {
			return { method: "btree", positions: [first.i, ...Arr.map(rest, (b) => b.i)] }
		}
	}
	return { method: "hash", position: 0 }
}

/**
 * A drawn containment: its referencing columns' types, whether a declared key covers the bounded ones, whether its
 * source is a selection, and whether its target is keyed by its first column alone.
 */
export interface ReverseCase {
	readonly types: Arr.NonEmptyReadonlyArray<ColumnType>
	readonly covered: boolean
	readonly selected: boolean
	readonly superkey: boolean
}

const columnTypeGen: Gen<ColumnType> = weighted<ColumnType>([
	[
		3,
		element<ColumnType>([
			{ kind: "uuid" },
			{ kind: "bigint" },
			{ kind: "integer" },
			{ kind: "smallint" },
			{ kind: "boolean" }
		])
	],
	[2, (source) => ({ kind: "text", codePoints: source.draw(element(textLengths)) })],
	[2, element<ColumnType>([{ kind: "free" }])]
])

export const reverseCaseGen: Gen<ReverseCase> = (source) => {
	const [first, ...rest] = source.draw(array(columnTypeGen, { min: 1, max: 4 }))
	return {
		types: [defined(first, "a referencing column"), ...rest],
		covered: source.draw(boolean),
		selected: source.draw(boolean),
		superkey: source.draw(boolean)
	}
}

/** A case's referencing columns' names, by position. */
export const columnNames = (c: ReverseCase): Arr.NonEmptyReadonlyArray<string> =>
	Arr.map(c.types, (_, i) => `c${i}`)

/** The positions of a case's columns of a type with no bound. */
export const freePositions = (c: ReverseCase): ReadonlyArray<number> =>
	Arr.filter(indices(c.types.length), (i) => c.types[i]?.kind === "free")

/** The positions of a case's bounded columns. */
const boundedPositions = (c: ReverseCase): ReadonlyArray<number> =>
	Arr.filter(indices(c.types.length), (i) => c.types[i]?.kind !== "free")

/**
 * Whether a case declares a key over its source's bounded columns: when drawn so, and the key's own entry fits, which
 * the planned run's covering every bounded column proves.
 */
const declaresKey = (c: ReverseCase): boolean => {
	const expected = expectedOf(c)
	const bounded = boundedPositions(c)
	return (
		c.covered &&
		bounded.length > 0 &&
		expected.method === "btree" &&
		expected.positions.length === bounded.length
	)
}

/** The situations a case reaches, the suites' features. */
export type ReverseFeature =
	| "free text first"
	| "free text between"
	| "free text last"
	| "only free text"
	| "a run cut short by width"
	| "a B-tree"
	| "a hash index"
	| "covered by a declared key"
	| "a selected source"
	| "into a superkey"

export const reverseFeatures: Arr.NonEmptyReadonlyArray<ReverseFeature> = [
	"free text first",
	"free text between",
	"free text last",
	"only free text",
	"a run cut short by width",
	"a B-tree",
	"a hash index",
	"covered by a declared key",
	"a selected source",
	"into a superkey"
]

/** Whether a case's target is keyed by fewer columns than the containment references. */
const intoSuperkey = (c: ReverseCase): boolean => c.superkey && c.types.length > 1

/** Where a case's free texts stand: first, last, between bounded columns, or every column. */
const freeFeature = (c: ReverseCase): ReadonlyArray<ReverseFeature> => {
	const frees = freePositions(c)
	if (frees.length === c.types.length) {
		return ["only free text"]
	}
	if (Arr.contains(frees, 0)) {
		return ["free text first"]
	}
	if (Arr.contains(frees, c.types.length - 1)) {
		return ["free text last"]
	}
	return frees.length > 0 ? ["free text between"] : []
}

/** The index a case's rule plans, as features: a B-tree, cut short of its bounded columns or not, or a hash index. */
const methodFeature = (c: ReverseCase): ReadonlyArray<ReverseFeature> => {
	const expected = expectedOf(c)
	if (expected.method === "hash") {
		return ["a hash index"]
	}
	return expected.positions.length < boundedPositions(c).length
		? ["a B-tree", "a run cut short by width"]
		: ["a B-tree"]
}

/** The situations a case reaches (ReverseFeature). */
export const featuresOf = (c: ReverseCase): ReadonlyArray<ReverseFeature> => {
	const covered: ReadonlyArray<ReverseFeature> = declaresKey(c) ? ["covered by a declared key"] : []
	const selected: ReadonlyArray<ReverseFeature> = c.selected ? ["a selected source"] : []
	const superkey: ReadonlyArray<ReverseFeature> = intoSuperkey(c) ? ["into a superkey"] : []
	return [...freeFeature(c), ...methodFeature(c), ...covered, ...selected, ...superkey]
}

const short = regexField("^.{0,10}$", ["su"])
const free = regexField("^.*$", ["su"])
/** A text of at most `codePoints` code points, its pattern a run of counted repetitions of at most 255. */
const textOf = (codePoints: number): FieldBase =>
	regexField(
		`^${Arr.join(
			Arr.map(
				indices(Math.ceil(codePoints / 255)),
				(i) => `.{0,${Math.min(255, codePoints - 255 * i)}}`
			),
			""
		)}$`,
		["su"]
	)

/** The source's descriptor of a type, and the target's, which meets it: a text of a short pattern for any text. */
const descriptorOf = (t: ColumnType, side: "source" | "target"): FieldBase => {
	switch (t.kind) {
		case "uuid":
			return uuid
		case "bigint":
			return pgDescriptors.bigint
		case "integer":
			return pgDescriptors.integer
		case "smallint":
			return pgDescriptors.smallint
		case "boolean":
			return pgDescriptors.boolean
		case "text":
			return side === "target" ? short : textOf(t.codePoints)
		case "free":
			return side === "target" ? short : free
	}
}

/** The relation names of the case at a position: its source's and its target's. */
export const relationsAt = (at: number): { readonly source: string; readonly target: string } => ({
	source: `A${at}`,
	target: `B${at}`
})

/**
 * One schema of the cases, each at its position: a source keyed by `id`, with a boolean `live` its selection reads and
 * its referencing columns; a target of the columns they meet, keyed by them all or by the first; the containment of
 * the one, or of its live rows, in the other; and the declared key over the source's bounded columns where the case
 * declares one.
 */
export const reverseSchema = (cases: ReadonlyArray<ReverseCase>) => {
	const parts = Arr.map(cases, (c, at) => {
		const names = columnNames(c)
		const typeAt = (i: number): ColumnType => defined(c.types[i], "a column type")
		const { source, target } = relationsAt(at)
		const A = relation(
			source,
			{
				id: uuid,
				live: pgDescriptors.boolean,
				...Rec.fromEntries(Arr.map(names, (n, i) => [n, descriptorOf(typeAt(i), "source")]))
			},
			["id"],
			[]
		)
		const B = relation(
			target,
			Rec.fromEntries(Arr.map(names, (n, i) => [n, descriptorOf(typeAt(i), "target")])),
			c.superkey ? Arr.take(names, 1) : names,
			[]
		)
		const side = c.selected
			? onBuilder(
					selectBuilder(A, (r: { readonly live: RowTerm } & typeof rowHelpers) =>
						r.eq(r.live, true)
					),
					names
				)
			: onBuilder(A, names)
		const bounded = Arr.map(boundedPositions(c), (i) => defined(names[i], "a column name"))
		const statements: ReadonlyArray<Statement> = [
			containedBuilder(side, onBuilder(B, names)),
			...(declaresKey(c) ? [keyBuilder(onBuilder(A, bounded))] : [])
		]
		const relations: ReadonlyArray<readonly [string, AnyRelation]> = [
			[source, A],
			[target, B]
		]
		return { relations, statements }
	})
	const statements: ReadonlyArray<Statement> = Arr.flatMap(parts, (p) => p.statements)
	return schema(
		"Reverse",
		Rec.values(Rec.fromEntries(Arr.flatMap(parts, (p) => p.relations))),
		statements,
		[]
	)
}
