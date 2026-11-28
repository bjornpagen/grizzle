/** What the properties of keys.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf
} from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import { conservativeMeta, type RelNode, type ValidDag } from "#compiler/ir/rel.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { Ir, SchemaModel } from "#test/support/fixtures/ir/build.ts"
import { decodedSchema, f, key, on, relation } from "#test/support/fixtures/ir/desc.ts"
import { workModel } from "#test/support/fixtures/ir/work.ts"

/**
 * The minimal keys a dependency table proves (logical/closure.ts minimalKeys): from the whole heading alone, closed
 * under the exchange of a dependency's determined columns for its determinants, every minimal key of the table is found,
 * with no bound.
 *
 * Each case draws a table of dependencies over at most six columns. The oracle enumerates every column set, computes
 * its closure under the dependencies by brute force, and keeps the sets that determine the heading and have no proper
 * subset that does: the table's minimal keys, ordered as minimalKeys orders them (by size, then heading position).
 * minimalKeys over the whole heading returns exactly those keys. A greedy minimization alone finds one key per
 * candidate, and misses every key no candidate minimizes to: a table where b determines a and a determines the rest has
 * the keys {a} and {b}, and minimizing the heading from its end gives only {a}; the exchange finds the other.
 */

/** A drawn table: its column count, and each dependency as the masks of its determinants and its determined columns. */
export interface Table {
	readonly width: number
	readonly dependencies: ReadonlyArray<{ readonly from: number; readonly to: number }>
}

/** At most six columns, so the oracle's 64 column sets are few; at most six dependencies, enough for several keys. */
export const tableGen: Gen<Table> = (source) => {
	const width = source.draw(int(1, 6))
	return {
		width,
		dependencies: source.draw(
			array(
				(dependency) => ({
					from: dependency.draw(int(0, 2 ** width - 1)),
					to: dependency.draw(int(1, 2 ** width - 1))
				}),
				{ min: 0, max: 6 }
			)
		)
	}
}

export type KeysFeature =
	| "one minimal key"
	| "several minimal keys"
	| "a minimal key of several columns"

/**
 * Keys over classes of equal columns (logical/props.ts finish): k pairs of equal columns are one key, not 2^k.
 *
 * Each case draws a heading of classes of one to three columns, k of them of several, in a drawn column order, as the
 * rows of a relation parameter, which only its whole heading keys; a filter states each class's columns equal,
 * chained in declaration order; and a projection may keep a subset of the columns, one at least of each class. Every
 * choice of a column per class is a minimal key, so the product of the class sizes, 2^k for k pairs. The analysis
 * proves exactly one key at the filter and at the projection: the first column of each class in heading order, its
 * members every other column of its classes, each proof one the key kernel accepts. So the number of keys is one,
 * polynomial in the heading, where listing every minimal key would be exponential in it.
 */

/**
 * A drawn heading: each class's size, a position key per column ordering the heading, and the columns a projection
 * keeps.
 */
interface Classed {
	readonly sizes: ReadonlyArray<number>
	readonly positions: ReadonlyArray<number>
	/** Per column, whether the projection keeps it beyond the one column of each class it always keeps. */
	readonly kept: ReadonlyArray<boolean>
	readonly projected: boolean
}

export const classedGen: Gen<Classed> = (source) => {
	const sizes = source.draw(array(int(1, 3), { min: 1, max: 12 }))
	const width = Arr.reduce(sizes, 0, (n, size) => n + size)
	return {
		sizes,
		positions: source.draw(array(int(0, 2 ** 31 - 1), { min: width, max: width })),
		kept: source.draw(array(boolean, { min: width, max: width })),
		projected: source.draw(boolean)
	}
}

export type ClassFeature =
	| "eight or more classes of several columns"
	| "a class of three columns"
	| "a column of no other's class"
	| "a projection dropping a class's first column"

export const int4 = plainType("int4")

/**
 * A union's keys over the columns every arm makes equal (logical/props.ts unionProps): two columns equal in every row of
 * every arm are equal in every row of the union, so a key of the union is closed under them. With either column in the
 * key it is a key, as db.get reads one; and two columns some arm keeps apart stand for nothing.
 *
 * Each case draws two or three arms over the columns c0..c<w-1> and a column `tag` each arm fixes to its own literal,
 * which tells the arms apart. An arm reads a relation parameter of its own over those columns; its filter states drawn
 * pairs of them equal, and its projection outputs each column as a copy of its own input column or of an earlier one,
 * so two outputs copying one column are equal. The oracle partitions each arm's outputs by those copies and equalities
 * and intersects the arms' partitions. Every key the analysis proves of the union lists, for each of its columns,
 * exactly the other columns equal to it in every arm as its members; with any of them in its column's place it is a
 * key of the union, by its class (keyIn, which db.get reads) and by the union's own proof; and the key kernel accepts
 * every such proof. The kept case is the worlds model's: two rules each copying one variable into two head fields.
 */

/** A drawn arm: per column the input column its output copies, as an index wrapped below the column's own. */
interface UnionArm {
	readonly copies: ReadonlyArray<number>
	readonly equalities: ReadonlyArray<readonly [number, number]>
	/** Whether the arm groups its filtered rows by every column before it projects them. */
	readonly grouped: boolean
}

interface UnionCase {
	readonly width: number
	readonly arms: ReadonlyArray<UnionArm>
}

export const unionCaseGen: Gen<UnionCase> = (source) => {
	const width = source.draw(int(2, 4))
	const column = int(0, width - 1)
	return {
		width,
		arms: source.draw(
			array(
				(arm): UnionArm => ({
					copies: arm.draw(array(column, { min: width, max: width })),
					equalities: arm.draw(
						array((pair) => [pair.draw(column), pair.draw(column)] as const, { min: 0, max: 3 })
					),
					grouped: arm.draw(boolean)
				}),
				{ min: 2, max: 3 }
			)
		)
	}
}

export type UnionFeature =
	| "an equality every arm holds"
	| "an equality some arm lacks"
	| "an equality every arm holds by copying one column"
	| "an equality every arm holds by its filter"
	| "an equality every arm holds through its group"
	| "three arms"

/** The partition of a heading's columns by equal pairs: each column's class, as its first column's index. */
export const partition = (width: number, pairs: ReadonlyArray<readonly [number, number]>) => {
	const root = Arr.map(indices(width), (j) => j)
	const find = (j: number): number => {
		let at = j
		for (
			let up = defined(root[at], "a column's root");
			up !== at;
			up = defined(root[at], "a root")
		) {
			at = up
		}
		return at
	}
	for (const [x, y] of pairs) {
		root[find(y)] = find(x)
	}
	return find
}

/**
 * The key kernel's side of a union's equal columns (test/support/keys/kernel.ts): an `arms` witness proves two union
 * columns equal only when each arm's derivation steps by equalities alone, since two arms may each determine b from a
 * by a different function of it.
 *
 * Each case draws two or three arms, each reading a relation parameter of its own over x and y, with the outputs tag
 * (the arm's literal), a (x), c (y) and b, which the arm makes from a by a drawn mapping: a copy of x, a copy of y under
 * a filter stating x = y, or x plus a drawn amount. A forged step stating a = b, with each arm's derivation that a
 * determines b, is appended to the derivation of the union's key the analysis proved, which the kernel accepts, so the
 * step is all that changes. Each arm's derivation is a valid step under every mapping; the kernel accepts the forged
 * step exactly when no arm shifts. A step citing a column the union lacks, and a witness whose arm derivations start
 * from a column the arms lack, are refused under every mapping.
 */

type Mapping =
	| { readonly kind: "copy" }
	| { readonly kind: "filtered" }
	| { readonly kind: "shift"; readonly by: number }

const mappingGen: Gen<Mapping> = oneOf<Mapping>([
	constant({ kind: "copy" }),
	constant({ kind: "filtered" }),
	map(int(1, 3), (by): Mapping => ({ kind: "shift", by }))
])

/** The first arm's mapping and the others'. */
type Mappings = readonly [Mapping, ReadonlyArray<Mapping>]

export const mappingsGen: Gen<Mappings> = (source) => [
	source.draw(mappingGen),
	source.draw(array(mappingGen, { min: 1, max: 2 }))
]

export type ForgeFeature =
	| "every arm makes b equal to a"
	| "an arm shifts"
	| "arms shifting by different amounts"
	| "an equality through a filter"
	| "three arms"

/** A column no node of the cases has. */
export const ghost = "ghost"

/**
 * A relation parameter's facts kept unmerged: optionally a region binding every column of them, then each of `filters`,
 * a filter where true and a semi-join reading the rows as its left where false.
 */
export interface Keeping {
	readonly region: boolean
	readonly filters: ReadonlyArray<boolean>
}

export const keepingGen: Gen<Keeping> = (source) => ({
	region: source.draw(boolean),
	filters: source.draw(array(boolean, { min: 1, max: 3 }))
})

/**
 * A relation parameter of a double precision column x and an int4 column n, its facts kept unmerged by `keeping`: two of
 * its facts may differ in x's zero's sign alone, (0, 1) and ('-0', 1), natively equal.
 */
export const keptParameterFacts = (keeping: Keeping): ValidDag => {
	const q = new Ir(workModel())
	const facts = q.input("facts", [
		["x", plainType("float8")],
		["n", int4]
	])
	const read = keeping.region
		? q.region([{ source: facts, bind: { x: "x", n: "n" }, constants: {} }], conservativeMeta)
		: facts
	const kept = Arr.reduce(keeping.filters, read, (rows: RelNode, filter) =>
		filter
			? q.filter(rows, q.eq(q.col(rows, "n"), q.lit(1, int4)))
			: q.semi(rows, q.input("probes", [["n", int4]]), [["n", "n"]])
	)
	return q.build(kept).dag
}

/** Reading: a double precision x of each id, beside an int4 n, keyed by its id. */
const ReadingDesc: SchemaDesc = decodedSchema({
	name: "Readings",
	relations: [relation("Reading", { id: f.uuid, x: f.pg("float8"), n: f.integer }, ["id"])],
	statements: [],
	bases: []
})

const readingModel = (): SchemaModel => new SchemaModel(ownedFixture(ReadingDesc), {})

/** How a region reads Reading's id: bound to a variable the projection delivers, bound to one it drops, or a literal. */
const readingIds = ["delivered", "dropped", "fixed"] as const
export type ReadingId = (typeof readingIds)[number]

/** A projection of a region over Reading: its id as `id` says, x always, and n or not. */
export interface FactCase {
	readonly id: ReadingId
	readonly n: boolean
}

export const factCaseGen: Gen<FactCase> = (source) => ({
	id: source.draw(element(readingIds)),
	n: source.draw(boolean)
})

/**
 * The projection a case reads: a region over Reading binding x, and its id to a variable or fixing it by a literal,
 * beside, where a literal fixes it, every other reading's id, so the region holds many rows of the one fact's x; projected
 * to x (a copy of a float, which no merge reads through its canonical zero), its id where it delivers it, and n where
 * the case draws it.
 */
export const readingProjection = (c: FactCase): ValidDag => {
	const q = new Ir(readingModel())
	const reading = q.base("Reading")
	const region = q.region(
		[
			{
				source: reading,
				bind: { x: "x", n: "n", ...(c.id === "fixed" ? {} : { id: "id" }) },
				constants:
					c.id === "fixed"
						? { id: q.litFor(reading, "id", "5eeda101-7c3e-4a1b-9d2f-0e5c7a9b3d1f") }
						: {}
			},
			...(c.id === "fixed"
				? [{ source: q.base("Reading"), bind: { id: "other" }, constants: {} }]
				: [])
		],
		conservativeMeta
	)
	const out: ReadonlyArray<readonly [string, string]> = [
		["x", "x"],
		...(c.id === "delivered" ? [["id", "id"] as const] : []),
		...(c.n ? [["n", "n"] as const] : [])
	]
	return q.build(q.project(region, out, conservativeMeta)).dag
}

/**
 * Doubly: Reading's x and n again, keyed by its id and by its n, so the one key proof of a node over it holds one of
 * the two as its own key and the other as its alternative (ir/keys.ts KeyProof).
 */
const DoublyDesc: SchemaDesc = decodedSchema({
	name: "Doubly",
	relations: [relation("Doubly", { id: f.uuid, x: f.pg("float8"), n: f.integer }, ["id"])],
	statements: [key(on("Doubly", ["n"]))],
	bases: []
})

const doublyModel = (): SchemaModel => new SchemaModel(ownedFixture(DoublyDesc), {})

/** The keys of Doubly, either of which a case binds or copies. */
const doublyKeys = ["id", "n"] as const
export type DoublyKey = (typeof doublyKeys)[number]

/**
 * Where a case reads one of Doubly's keys: a region binding it and x, the other key unbound (`region`, readsOneFact),
 * or a projection, to it and the sum of x, of a group by both keys of a region binding all three (`projection`,
 * projectsOneRow), the sum a float no fact holds.
 */
const doublyReaders = ["region", "projection"] as const
export type DoublyReader = (typeof doublyReaders)[number]

/** One cell of the box: the key read, and the node that reads it. */
export interface DoublyCase {
	readonly key: DoublyKey
	readonly reader: DoublyReader
}

export const doublyCaseGen: Gen<DoublyCase> = (source) => ({
	key: source.draw(element(doublyKeys)),
	reader: source.draw(element(doublyReaders))
})

/** The DAG a case reads (DoublyReader), its root the node whose claims the case judges. */
export const doublyDag = (c: DoublyCase): ValidDag => {
	const q = new Ir(doublyModel())
	const doubly = q.base("Doubly")
	switch (c.reader) {
		case "region":
			return q.build(
				q.region(
					[{ source: doubly, bind: { [c.key]: c.key, x: "x" }, constants: {} }],
					conservativeMeta
				)
			).dag
		case "projection": {
			const region = q.region(
				[{ source: doubly, bind: { id: "id", n: "n", x: "x" }, constants: {} }],
				conservativeMeta
			)
			const grouped = q.group(
				region,
				["id", "n", "x"],
				["id", "n"],
				[{ name: "s", agg: "sum", arg: q.col(region, "x") }],
				conservativeMeta
			)
			return q.build(
				q.project(
					grouped,
					[
						[c.key, c.key],
						["s", "s"]
					],
					conservativeMeta
				)
			).dag
		}
	}
}
