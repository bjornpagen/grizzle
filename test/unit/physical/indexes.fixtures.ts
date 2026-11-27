/** What the properties of indexes.test.ts read: its spaces, models and helpers. */

import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	shuffled,
	subset,
	weighted
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { regex } from "arkregex"
import { Array as Arr, Equivalence, Option, Order, String as Str } from "effect"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import { defaultOpclass, type NativeColumn } from "#compiler/ir/law.ts"
import type { AccessUse, IndexRequest } from "#compiler/ir/products.ts"
import { keyTermText, type PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { indexMaxKeys } from "#compiler/schema/representability.ts"
import {
	contained,
	f,
	key,
	on,
	relation,
	type SchemaDesc,
	unit
} from "#test/support/fixtures/ir/desc.ts"
import { lawNamesOf, wild } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"
import { requesting } from "#test/unit/physical/fixtures.ts"

/** Event: a plain table under its primary key, with a vector column an HNSW request keys, its boolean live before its
 * uuids and bigints in its heading, so only the GiST order puts a column of few values last
 * (physical/indexes/engine.ts withinBlock). Booking: a span key, so a GiST index whose leading room column btree_gist
 * serves by equality. Deposit: the reverse lookup of its reference to Line on line, which its primary key (account,
 * line) cannot serve. Ledger: a key of two columns, (account, entry), and two columns besides, which a superkey seek
 * orders by. */
const Indexed: SchemaDesc = {
	name: "Indexed",
	relations: [
		relation(
			"Event",
			{
				id: f.uuid,
				live: f.boolean,
				tenant: f.uuid,
				account: f.uuid,
				created: f.bigint,
				unrelated: f.bigint,
				body: f.wildcard,
				embedding: { kind: "vector", dimensions: 3 }
			},
			["id"]
		),
		relation("Booking", { room: f.uuid, during: f.span(f.integer, undefined), id: f.uuid }, [
			"room",
			"during"
		]),
		relation("Line", { id: f.uuid }, ["id"]),
		relation("Deposit", { line: f.uuid, account: f.uuid }, ["account", "line"]),
		relation("Ledger", { account: f.uuid, entry: f.bigint, amount: f.bigint, posted: f.bigint }, [
			"account",
			"entry"
		])
	],
	statements: [contained(on("Deposit", ["line"]), on("Line", ["id"]))],
	bases: []
}

/** The columns a drawn B-tree request keys, per relation, each under its type's default operator class: a B-tree
 * request names no other. */
const columns: Readonly<Record<string, Arr.NonEmptyReadonlyArray<string>>> = {
	Event: ["tenant", "account", "created", "unrelated", "id"],
	Booking: ["room", "id"],
	Deposit: ["line", "account"]
}

const relations = ["Event", "Booking", "Deposit"] as const

const accessUses = [
	"key lookup",
	"equality lookup",
	"join key",
	"write target",
	"range",
	"prefix search",
	"take seek",
	"page seek"
] as const satisfies ReadonlyArray<AccessUse>

interface RequestSketch {
	readonly relation: (typeof relations)[number]
	readonly keys: ReadonlyArray<{ readonly column: string; readonly desc: boolean }>
	readonly law: boolean
	readonly use: AccessUse
	/** An HNSW request on Event's vector column instead, at 0, under the default class or the cosine class. */
	readonly vector: number
	readonly cosine: boolean
}

const requestGen: Gen<RequestSketch> = (source) => {
	const relation = source.draw(element(relations))
	const columnGen = element(defined(columns[relation]))
	return {
		relation,
		keys: source.draw(
			array((source) => ({ column: source.draw(columnGen), desc: source.draw(boolean) }), {
				min: 1,
				max: 3
			})
		),
		law: source.draw(boolean),
		use: source.draw(element(accessUses)),
		vector: source.draw(int(0, 3)),
		cosine: source.draw(boolean)
	}
}

/**
 * A law request's key column: the field's handle as Indexed's theory resolves it, which a law names its columns by
 * (ir/law.ts NativeColumn).
 */
const theoryRelations = lawNamesOf(Indexed).model.theory.relations

const fieldColumn = (relation: string, field: string): NativeColumn => ({
	kind: "field",
	field: Option.getOrThrowWith(
		Arr.findFirst(defined(theoryRelations[relation], relation).fields, (f) => f.name === field),
		() => new Error(`${relation}.${field} is no field of Indexed's theory`)
	)
})

/**
 * How many of a request's keys, from the first, a path of its use binds by equality (AccessPath `fixed`): a lookup's,
 * a key lookup's, a join key's and a write target's every key, a range's and a prefix search's every key but its last,
 * and none of a seek's, which states no prefix here, nor of an approximate retrieval's, a span predicate's or a network containment's.
 */
const fixedOf = (use: AccessUse, keys: number): number => {
	switch (use) {
		case "key lookup":
		case "equality lookup":
		case "join key":
		case "write target":
			return keys
		case "range":
		case "prefix search":
			return keys - 1
		case "take seek":
		case "page seek":
		case "span predicate":
		case "approximate vector retrieval":
		case "text search":
		case "network containment":
			return 0
	}
}

/** The keys of a drawn request, which draws one at least. */
const nonEmptyKeys = <K>(keys: ReadonlyArray<K>): Arr.NonEmptyReadonlyArray<K> => {
	const [first, ...rest] = keys
	return first === undefined ? assert.fail("a drawn request has a key") : [first, ...rest]
}

/**
 * A law request's keys as blocks (ir/law.ts LawIndexRequest): one block of every key where `split` cuts none of them,
 * else the keys before the cut and those from it, as a unit-local law's read states its unit's key first
 * (physical/ddl/rules.ts requestsOf).
 */
const blocksOf = <K>(
	keys: Arr.NonEmptyReadonlyArray<K>,
	split: number
): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<K>> => {
	const [first] = keys
	const before = keys.slice(1, split)
	const [cut, ...after] = keys.slice(split)
	return split < 1 || cut === undefined
		? [keys]
		: [
				[first, ...before],
				[cut, ...after]
			]
}

const requestOf = (s: RequestSketch, i: number, split: number): IndexRequest => {
	if (s.vector === 0 && !s.law) {
		return {
			relation: "Event",
			keys: [
				{
					expr: "embedding",
					dir: "asc",
					opclass: s.cosine ? { kind: "vectorCosine", schema: "vector_ext" } : defaultOpclass
				}
			],
			method: "hnsw",
			fixed: 0,
			role: "access",
			use: "approximate vector retrieval"
		}
	}
	const rel = s.relation
	const seen = new Set<string>()
	const keys = Arr.flatMap(s.keys, (k) => {
		const column = k.column
		if (seen.has(column)) {
			return []
		}
		seen.add(column)
		return [
			{
				expr: column,
				dir: k.desc ? ("desc" as const) : ("asc" as const),
				opclass: defaultOpclass
			}
		]
	})
	return s.law
		? {
				relation: rel,
				blocks: blocksOf(
					nonEmptyKeys(
						Arr.map(keys, (k) => ({
							column: fieldColumn(rel, k.expr),
							dir: "asc" as const,
							opclass: k.opclass
						}))
					),
					split
				),
				reads: { kind: "rows" },
				method: "btree",
				role: "lawMaintenance",
				use: "reverse reference",
				justification: { kind: "law", law: wild.lawId(`l${i}`) }
			}
		: {
				relation: rel,
				keys,
				method: "btree",
				fixed: fixedOf(s.use, keys.length),
				role: "access",
				use: s.use
			}
}

/** Event's columns a B-tree or GiST request keys by equality, none of them text or a vector. */
const eventColumns: Arr.NonEmptyReadonlyArray<string> = [
	"tenant",
	"account",
	"created",
	"unrelated",
	"id"
]

/** Event's columns no installed index leads with (its primary key leads with id), so a request on them creates one. */
const unindexedColumns: Arr.NonEmptyReadonlyArray<string> = [
	"tenant",
	"account",
	"created",
	"unrelated"
]

/**
 * What each of Event's columns a GiST request keys holds, stated here from their types and never read from the engine:
 * live, a boolean, holds two values; the uuids and the bigints, many.
 */
export const valueClass: Readonly<Record<string, "few" | "many">> = {
	tenant: "many",
	account: "many",
	created: "many",
	unrelated: "many",
	live: "few"
}

/** Event's columns a GiST request over columns of few and many values keys. */
const gistColumns: Arr.NonEmptyReadonlyArray<string> = [...unindexedColumns, "live"]

/**
 * A request planted alone, in place of the drawn ones: one the engine cannot create (a B-tree key over a text column,
 * whose entry no limit bounds, after drawn columns; more keys than INDEX_MAX_KEYS; an expression key, a name no column
 * holds), each refused as a key is; or two requests on one drawn column list by two access methods, which it installs
 * as two indexes of two names.
 */
type Planted =
	| { readonly kind: "none" }
	| { readonly kind: "an unrepresentable entry"; readonly before: ReadonlyArray<string> }
	| { readonly kind: "too many keys"; readonly keys: ReadonlyArray<string> }
	| { readonly kind: "an expression key"; readonly expr: string }
	| {
			readonly kind: "a B-tree and a GiST index on one column list"
			readonly columns: ReadonlyArray<string>
	  }
	| {
			readonly kind: "a GiST index on columns of few and many values"
			readonly columns: ReadonlyArray<string>
	  }

type Broken = Extract<
	Planted["kind"],
	"an unrepresentable entry" | "too many keys" | "an expression key"
>

const plantedGen: Gen<Planted> = weighted<Planted>([
	[3, constant({ kind: "none" })],
	[
		1,
		map(shuffled(eventColumns, { min: 0, max: 2 }), (before) => ({
			kind: "an unrepresentable entry",
			before
		}))
	],
	[
		1,
		map(
			array(element(eventColumns), {
				min: indexMaxKeys + 1,
				max: indexMaxKeys + 4
			}),
			(keys) => ({ kind: "too many keys", keys })
		)
	],
	[1, map(matching(regex("^e[0-9]{1,3}$")), (expr) => ({ kind: "an expression key", expr }))],
	[
		1,
		map(shuffled(unindexedColumns, { min: 1, max: unindexedColumns.length }), (columns) => ({
			kind: "a B-tree and a GiST index on one column list",
			columns
		}))
	],
	[
		1,
		map(shuffled(gistColumns, { min: 2, max: gistColumns.length }), (columns) => ({
			kind: "a GiST index on columns of few and many values",
			columns
		}))
	]
])

const access = (keys: ReadonlyArray<string>, method: "btree" | "gist"): IndexRequest => ({
	relation: "Event",
	keys: Arr.map(keys, (expr) => ({ expr, dir: "asc", opclass: defaultOpclass })),
	method,
	fixed: 0,
	role: "access",
	use: "page seek"
})

export const plantedRequests = (planted: Planted): ReadonlyArray<IndexRequest> => {
	switch (planted.kind) {
		case "none":
			return []
		case "an unrepresentable entry":
			return [access([...planted.before, "body"], "btree")]
		case "too many keys":
			return [access(planted.keys, "btree")]
		case "an expression key":
			return [access([planted.expr], "btree")]
		case "a B-tree and a GiST index on one column list":
			return [access(planted.columns, "btree"), access(planted.columns, "gist")]
		case "a GiST index on columns of few and many values":
			return [access(planted.columns, "gist")]
	}
}

export const expectedRefusal: Readonly<Record<Broken, CompileReasonTag>> = {
	"an unrepresentable entry": "UnrepresentableKey",
	"too many keys": "UnrepresentableKey",
	"an expression key": "UnsupportedOperation"
}

/** Whether two lists of key columns hold one set of columns, whatever their order: an index holds a block of columns in
 * its relation's heading order, whichever order a request states them in (physical/indexes/engine.ts withinBlock). */
export const sameColumns = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	Arr.makeEquivalence(Equivalence.String)(Arr.sort(a, Order.String), Arr.sort(b, Order.String))

/** A planned index key's field, or its law column's identifier. */
export const keyField = (k: PlannedIndex["keys"][number]): string => keyTermText(k.column)

/**
 * The columns a request binds by equality, by their key texts: a law's probe's every column but a suffix key, which its
 * seek matches a prefix of, and a workload request's first `fixed`.
 */
export const boundColumns = (r: IndexRequest): ReadonlyArray<string> =>
	r.role === "lawMaintenance"
		? Arr.flatMap(r.blocks.flat(), (k) =>
				k.column.kind === "suffix"
					? []
					: [k.column.kind === "field" ? k.column.field.name : k.column.column]
			)
		: Arr.map(Arr.take(r.keys, r.fixed), (k) => String(k.expr))

export const install = (requests: ReadonlyArray<IndexRequest>) => {
	const owned = owning(Indexed)
	return compileInstallation(owned, {
		...installOptions(owned),
		extensions: [requesting(requests)]
	})
}

export type IndexFeature =
	| "served by an installed index"
	| "served by a created index"
	| "a created index serving several requests"
	| "a GiST key serving a B-tree probe"
	| "an ordered request"
	| "a range request"
	| `${Broken} refused`
	| "a B-tree and a GiST index on one column list installed"
	| "two indexes on one column list"
	| "a GiST index on a column of few values stated before columns of many values installed"
	| "a law request of two blocks"
	| "a law request's blocks in another order than an index of its columns"

interface EngineSketch {
	readonly requests: ReadonlyArray<RequestSketch>
	readonly arrival: ReadonlyArray<number>
	readonly planted: Planted
	/** Where each request's keys are cut into two blocks, a law request's (`blocksOf`), by its position. */
	readonly splits: ReadonlyArray<number>
}

const engineGen: Gen<EngineSketch> = (source) => ({
	requests: source.draw(array(requestGen, { min: 0, max: 6 })),
	arrival: source.draw(array(int(0, 2 ** 31 - 1), { min: 6, max: 6 })),
	planted: source.draw(plantedGen),
	splits: source.draw(array(int(0, 2), { min: 6, max: 6 }))
})

/** A sketch's requests, each law request's keys cut where its position's split cuts them. */
export const requestsOf = (sketch: EngineSketch): ReadonlyArray<IndexRequest> =>
	Arr.map(sketch.requests, (s, i) => requestOf(s, i, sketch.splits[i] ?? 0))

/**
 * An HNSW request on Event's vector column under the default class and another under the cosine class, among up to four
 * drawn requests: one column list no single index serves, so two indexes on it.
 */
const twoClassesGen: Gen<EngineSketch> = (source) => {
	const drawn = source.draw(engineGen)
	const hnsw = (cosine: boolean): RequestSketch => ({
		...source.draw(requestGen),
		vector: 0,
		law: false,
		cosine
	})
	return {
		...drawn,
		requests: [...Arr.take(drawn.requests, 4), hnsw(false), hnsw(true)],
		planted: { kind: "none" }
	}
}

/**
 * An equality lookup on Event's (tenant, account), whose index holds them in the heading's order, and a law's probe of
 * (account, tenant) whose blocks state account first, among up to four drawn requests: the probe's index leads with
 * account, so the lookup's index, which holds its columns as one block, serves it in no order its blocks take.
 */
const reversedBlocksGen: Gen<EngineSketch> = (source) => {
	const drawn = source.draw(engineGen)
	const kept = Arr.take(drawn.requests, 4)
	const on = (law: boolean, columns: readonly [string, string]): RequestSketch => ({
		relation: "Event",
		keys: Arr.map(columns, (column) => ({ column, desc: false })),
		law,
		use: "equality lookup",
		vector: 1,
		cosine: false
	})
	return {
		...drawn,
		requests: [...kept, on(false, ["tenant", "account"]), on(true, ["account", "tenant"])],
		planted: { kind: "none" },
		splits: [...Arr.take(drawn.splits, kept.length), 0, 1]
	}
}

/** The drawn engines, aimed at two indexes on one column list and at a law's blocks no index of its columns holds in order. */
export const engineSpace: Aimed<EngineSketch, IndexFeature> = aimed(engineGen, [
	["two indexes on one column list", twoClassesGen],
	["a law request's blocks in another order than an index of its columns", reversedBlocksGen]
])

/**
 * The columns of each of a law request's blocks, in order, by their key texts, a suffix key's column none of them;
 * an access request's leading `fixed` keys as one block.
 */
export const boundBlocks = (r: IndexRequest): ReadonlyArray<ReadonlyArray<string>> =>
	r.role === "lawMaintenance"
		? Arr.map(r.blocks, (block) =>
				Arr.flatMap(block, (k) =>
					k.column.kind === "suffix"
						? []
						: [k.column.kind === "field" ? k.column.field.name : k.column.column]
				)
			)
		: [Arr.map(Arr.take(r.keys, r.fixed), (k) => String(k.expr))]

/** Whether an index's keys lead with each block's columns in turn, each block's in any order among themselves. */
export const leadsWithBlocks = (
	keys: ReadonlyArray<string>,
	blocks: ReadonlyArray<ReadonlyArray<string>>
): boolean =>
	Arr.reduce(blocks, { at: 0, leads: true }, ({ at, leads }, block) => ({
		at: at + block.length,
		leads: leads && sameColumns(keys.slice(at, at + block.length), block)
	})).leads

/** The columns a shelf's second key field is drawn from (`shelfGen`). */
const shelfColumns = ["c", "d", "e", "f", "g", "h", "i", "j"] as const

/**
 * A shelf: Shelf, with two keys of two fields, b then a drawn column of `shelfColumns` each, stated in a drawn order,
 * and an equality lookup on b, which each key's index serves. Its primary key is id, or, where `primary`, the key of the
 * greater column, the other its one key besides.
 */
export interface Shelf {
	readonly seconds: readonly [string, string]
	readonly flipped: boolean
	readonly primary: boolean
}

export const shelfGen: Gen<Shelf> = (source) => {
	const [first, second] = source.draw(shuffled(shelfColumns, { min: 2, max: 2 }))
	return {
		seconds: [defined(first, "a drawn column"), defined(second, "a drawn column")],
		flipped: source.draw(boolean),
		primary: source.draw(boolean)
	}
}

/** The shelf's key of the lesser and of the greater drawn column. */
export const shelfColumnsOf = (
	shelf: Shelf
): { readonly lesser: string; readonly greater: string } => {
	const [first, second] = shelf.seconds
	return first < second ? { lesser: first, greater: second } : { lesser: second, greater: first }
}

/** The shelf's equality lookup on b. */
export const shelfLookup: IndexRequest = {
	relation: "Shelf",
	keys: [{ expr: "b", dir: "asc", opclass: defaultOpclass }],
	method: "btree",
	fixed: 1,
	role: "access",
	use: "equality lookup"
}

/** The shelf's installation, its keys stated in the order drawn, with its lookup requested. */
export const installShelf = (shelf: Shelf) => {
	const { greater } = shelfColumnsOf(shelf)
	const keys = Arr.map(
		Arr.filter(shelf.seconds, (second) => !shelf.primary || second !== greater),
		(second) => key(on("Shelf", ["b", second]))
	)
	const owned = owning({
		name: "Shelved",
		relations: [
			relation(
				"Shelf",
				{
					id: f.uuid,
					b: f.uuid,
					c: f.uuid,
					d: f.uuid,
					e: f.uuid,
					f: f.uuid,
					g: f.uuid,
					h: f.uuid,
					i: f.uuid,
					j: f.uuid
				},
				shelf.primary ? ["b", greater] : ["id"]
			)
		],
		statements: shelf.flipped ? Arr.reverse(keys) : keys,
		bases: []
	})
	return compileInstallation(owned, {
		...installOptions(owned),
		extensions: [requesting([shelfLookup])]
	})
}

/**
 * `r` stated with the columns it binds by equality in the reverse order, every other key where it stands: an access
 * request's leading `fixed` keys, a law's request's every block. The same request, which any index serving the one
 * serves alike (physical/indexes/engine.ts withinBlock).
 */
export const restated = (r: IndexRequest): IndexRequest => {
	if (r.role === "lawMaintenance") {
		return { ...r, blocks: Arr.map(r.blocks, (block) => nonEmptyKeys(Arr.reverse(block))) }
	}
	return { ...r, keys: [...Arr.reverse(r.keys.slice(0, r.fixed)), ...r.keys.slice(r.fixed)] }
}

/** The relations a superkey seek is drawn on: each one's primary key, and its columns a seek may bind or order by
 * besides. */
const superkeyRelations = {
	Event: { key: ["id"], others: ["tenant", "account", "created", "unrelated"] },
	Ledger: { key: ["account", "entry"], others: ["amount", "posted"] }
} as const satisfies Readonly<
	Record<
		string,
		{
			readonly key: Arr.NonEmptyReadonlyArray<string>
			readonly others: Arr.NonEmptyReadonlyArray<string>
		}
	>
>

/**
 * A superkey seek: a take or page seek on Event, keyed by id, or Ledger, keyed by (account, entry), whose equalities bind
 * every column of the key and drawn others, all in a drawn order, then ordering by one or two of the rest, each in a
 * drawn direction.
 */
export interface SuperkeySeek {
	readonly relation: keyof typeof superkeyRelations
	readonly fixed: ReadonlyArray<string>
	readonly ordered: ReadonlyArray<{ readonly column: string; readonly desc: boolean }>
	readonly use: "take seek" | "page seek"
}

export const superkeySeekGen: Gen<SuperkeySeek> = (source) => {
	const relation = source.draw(element(["Event", "Ledger"] as const))
	const { key, others } = superkeyRelations[relation]
	const extra = source.draw(shuffled(others, { min: 0, max: others.length - 1 }))
	const rest = Arr.filter(others, (c) => !extra.includes(c))
	const ordered = source.draw(shuffled(rest, { min: 1, max: Math.min(2, rest.length) }))
	const bound = [...key, ...extra]
	return {
		relation,
		fixed: source.draw(shuffled(bound, { min: bound.length, max: bound.length })),
		ordered: Arr.map(ordered, (column) => ({ column, desc: source.draw(boolean) })),
		use: source.draw(element(["take seek", "page seek"] as const))
	}
}

/** The superkey seek's request: its bound columns by equality, then the columns it orders by (AccessIndexRequest
 * `fixed`). */
export const superkeySeekRequest = (seek: SuperkeySeek): IndexRequest => ({
	relation: seek.relation,
	keys: [
		...Arr.map(seek.fixed, (column) => ({
			expr: column,
			dir: "asc" as const,
			opclass: defaultOpclass
		})),
		...Arr.map(seek.ordered, ({ column, desc }) => ({
			expr: column,
			dir: desc ? ("desc" as const) : ("asc" as const),
			opclass: defaultOpclass
		}))
	],
	method: "btree",
	fixed: seek.fixed.length,
	role: "access",
	use: seek.use
})

/** The columns of a superkey seek's relation's key (superkeyRelations). */
export const superkeyOf = (seek: SuperkeySeek): ReadonlyArray<string> =>
	superkeyRelations[seek.relation].key

/** The own fields of Part, a member of the unit Doc (doc), in its heading's order after doc; each a bigint, of many
 * values. */
const partFields = ["f0", "f1", "f2", "f3"] as const

/**
 * A drawn member for the skip-order property: Part, keyed (doc, primary), with a key of its own fields or none (one
 * nested in the primary key's is none); its equality lookups, each of its own fields, led by the unit's field or not;
 * and a take seek ordered by some of its fields with nothing bound, or none.
 */
export interface PartSketch {
	readonly primary: Arr.NonEmptyReadonlyArray<number>
	readonly key: ReadonlyArray<number>
	readonly lookups: Arr.NonEmptyReadonlyArray<{
		readonly unitLed: boolean
		readonly fields: Arr.NonEmptyReadonlyArray<number>
	}>
	readonly seek: ReadonlyArray<number>
}

/** Distinct positions of Part's own fields, `min` to `max` of them, ascending. */
const ownFields = (min: number, max: number): Gen<ReadonlyArray<number>> =>
	subset([0, 1, 2, 3], { min, max })

export const partGen: Gen<PartSketch> = (source) => ({
	primary: nonEmptyKeys(source.draw(ownFields(1, 2))),
	key: source.draw(ownFields(0, 2)),
	lookups: nonEmptyKeys(
		source.draw(
			array((s) => ({ unitLed: s.draw(boolean), fields: nonEmptyKeys(s.draw(ownFields(1, 3))) }), {
				min: 1,
				max: 4
			})
		)
	),
	seek: source.draw(shuffled([0, 1, 2, 3], { min: 0, max: 2 }))
})

/** A position's field of Part. */
export const partField = (at: number): string => defined(partFields[at], "a field of Part")

/** Part's keys, each by its fields: its primary key, then its own key where one nests in neither. */
const partKeys = (sketch: PartSketch): ReadonlyArray<ReadonlyArray<string>> => {
	const primary = ["doc", ...Arr.map(sketch.primary, partField)]
	const declared = Arr.map(sketch.key, partField)
	const nested =
		Arr.every(declared, (f) => primary.includes(f)) ||
		Arr.every(primary, (f) => declared.includes(f))
	const outside = Arr.filter(declared, (f) => !primary.includes(f))
	/** The key's columns as its index holds them (physical/ddl/tables.ts candidateOrder): its columns outside the
	 * primary key first where its declared first lies in it. */
	const own =
		declared[0] !== undefined &&
		primary.includes(declared[0]) &&
		Arr.isReadonlyArrayNonEmpty(outside)
			? [...outside, ...Arr.filter(declared, (f) => primary.includes(f))]
			: declared
	return declared.length === 0 || nested ? [primary] : [primary, own]
}

/** The equality lookups and the seek a sketch states, as the workload's requests on Part. */
const partRequests = (sketch: PartSketch): ReadonlyArray<IndexRequest> => [
	...Arr.map(sketch.lookups, (l): IndexRequest => {
		const fields = [...(l.unitLed ? ["doc"] : []), ...Arr.map(l.fields, partField)]
		return {
			relation: "Part",
			keys: Arr.map(fields, (expr) => ({ expr, dir: "asc" as const, opclass: defaultOpclass })),
			method: "btree",
			fixed: fields.length,
			role: "access",
			use: "equality lookup"
		}
	}),
	...(sketch.seek.length === 0
		? []
		: [
				{
					relation: "Part",
					keys: Arr.map(sketch.seek, (at) => ({
						expr: partField(at),
						dir: "asc" as const,
						opclass: defaultOpclass
					})),
					method: "btree",
					fixed: 0,
					role: "access",
					use: "take seek"
				} satisfies IndexRequest
			])
]

/** A sketch's Part, under the unit Doc, as its schema describes it. */
const partDesc = (sketch: PartSketch): SchemaDesc => {
	const [primary, ...more] = partKeys(sketch)
	return {
		name: "SkipOrder",
		relations: [
			relation(
				"Part",
				{ doc: f.bigint, f0: f.bigint, f1: f.bigint, f2: f.bigint, f3: f.bigint },
				defined(primary, "Part's primary key")
			)
		],
		statements: [unit("Doc", { doc: f.bigint }), ...Arr.map(more, (k) => key(on("Part", k)))],
		bases: []
	}
}

/** The installation of a sketch's Part, under the unit Doc, with its requests and `more`. */
const installPartWith = (sketch: PartSketch, more: ReadonlyArray<IndexRequest>) => {
	const owned = owning(partDesc(sketch))
	return compileInstallation(owned, {
		...installOptions(owned),
		extensions: [requesting([...partRequests(sketch), ...more])]
	})
}

/** The installation of a sketch's Part, under the unit Doc, with its requests. */
export const installPart = (sketch: PartSketch) => installPartWith(sketch, [])

/**
 * A Part beside the reads of its units that whole rules make (ir/law.ts LawLookup `unit`), each a lookup of doc and
 * some of Part's own fields by equality, whose every key a created B-tree's equalities bind is held to doc
 * (physical/indexes/engine.ts confined), but an index created for a binding that spans Part's units.
 */
export interface ReadPart {
	readonly part: PartSketch
	readonly reads: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<number>>
}

export const readPartGen: Gen<ReadPart> = (source) => ({
	part: source.draw(partGen),
	reads: nonEmptyKeys(
		source.draw(array((s) => nonEmptyKeys(s.draw(ownFields(1, 2))), { min: 1, max: 2 }))
	)
})

/** Part's fields as a law names them (ir/law.ts NativeColumn), by their handles in its theory. */
const partColumn = (sketch: PartSketch, field: string): NativeColumn => ({
	kind: "field",
	field: Option.getOrThrowWith(
		Arr.findFirst(
			defined(lawNamesOf(partDesc(sketch)).model.theory.relations["Part"], "Part's theory").fields,
			(x) => x.name === field
		),
		() => new Error(`Part.${field} is no field of Part's theory`)
	)
})

/** A whole rule's read of one unit of Part at doc and `fields`: its request, the unit's block first. */
const unitReadOf = (
	sketch: PartSketch,
	fields: Arr.NonEmptyReadonlyArray<number>,
	at: number
): IndexRequest => {
	const keyOf = (field: string) => ({
		column: partColumn(sketch, field),
		dir: "asc" as const,
		opclass: defaultOpclass
	})
	const own = Arr.map(fields, (i) => keyOf(partField(i)))
	return {
		relation: "Part",
		blocks: [[keyOf("doc")], own],
		reads: {
			kind: "unit",
			lookups: [[partColumn(sketch, "doc"), ...Arr.map(own, (k) => k.column)]]
		},
		method: "btree",
		role: "lawMaintenance",
		use: "whole rule",
		justification: { kind: "law", law: wild.lawId(`u${at}`) }
	}
}

/** The installation of a ReadPart: its Part's requests, and each whole rule's read of its units. */
export const installReadPart = (sketch: ReadPart) =>
	installPartWith(
		sketch.part,
		Arr.map(sketch.reads, (fields, at) => unitReadOf(sketch.part, fields, at))
	)

/** Whether a request binds a set of Part's columns that spans its units, holding none of `scopes` (partSpanning). */
export const spansPart = (scopes: ReadonlySet<string>, r: IndexRequest): boolean => {
	const bound = boundColumns(r)
	return bound.length > 0 && !Arr.some(bound, (c) => scopes.has(c))
}

export type ConfinedFeature =
	| "an index created for a spanning binding beside a unit read binding its keys"
	| "an index a unit read holds to its unit"

/** Part's heading's order of its columns. */
const partHeading: ReadonlyArray<string> = ["doc", ...partFields]

/**
 * What spans Part's units, as the property reads it off the sketch (physical/indexes/engine.ts Spanning): the columns
 * that scope its rows, the unit's field and each key's first field, and the bindings that hold none of them, each key's
 * probe and each request's equalities.
 */
export const partSpanning = (
	sketch: PartSketch
): {
	readonly scopes: ReadonlySet<string>
	readonly bindings: ReadonlyArray<ReadonlySet<string>>
} => {
	const keys = partKeys(sketch)
	const scopes = new Set(["doc", ...Arr.flatMap(keys, (k) => Arr.take(k, 1))])
	const bindings = [
		...keys,
		...Arr.map(partRequests(sketch), (r) =>
			r.role === "access" ? Arr.map(r.keys.slice(0, r.fixed), (k) => String(k.expr)) : []
		)
	]
	return {
		scopes,
		bindings: Arr.flatMap(bindings, (b) =>
			b.length === 0 || Arr.some(b, (c) => scopes.has(c)) ? [] : [new Set(b)]
		)
	}
}

/** Whether `order`, an order of a created B-tree's columns, still serves every request `served` landed on it: an
 * equality lookup's columns lead it in any order, a seek's order keys in their order. */
const servesAll = (order: ReadonlyArray<string>, served: ReadonlyArray<IndexRequest>): boolean =>
	Arr.every(served, (r) => {
		if (r.role !== "access") {
			return false
		}
		const fields = Arr.map(r.keys, (k) => String(k.expr))
		const lead = order.slice(0, fields.length)
		return r.fixed === fields.length
			? Arr.every(fields, (c) => lead.includes(c))
			: Arr.every(fields, (c, at) => lead[at] === c)
	})

/**
 * Each step a read of a binding that spans the units takes through an index of `order`: a column that no binding holds
 * and that is no scope, which PostgreSQL never steps, where the binding lies within the index, holds every column before
 * it, and holds a column after it, which the read reaches only by stepping it (selfuncs.c btcostestimate's skip
 * arrays).
 */
export const stepsOf = (
	spanning: ReturnType<typeof partSpanning>,
	order: ReadonlyArray<string>
): ReadonlyArray<string> =>
	Arr.flatMap(order, (c, at) =>
		Arr.flatMap(spanning.bindings, (b) =>
			!spanning.scopes.has(c) &&
			!b.has(c) &&
			Arr.every([...b], (x) => order.includes(x)) &&
			Arr.every(order.slice(0, at), (x) => b.has(x)) &&
			Arr.some(order.slice(at + 1), (x) => b.has(x))
				? [`(${Arr.join([...b], ", ")}) steps ${c}`]
				: []
		)
	)

/** Every order of `values`. */
const orders = (values: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
	values.length <= 1
		? [values]
		: Arr.flatMap(values, (v, at) =>
				Arr.map(orders(Arr.remove(values, at)), (rest) => [v, ...rest])
			)

/**
 * The order the skip-order property expects of a created B-tree of Part's columns `keys` serving `served`: of the orders
 * of its columns that serve every one of them and take no step (`stepsOf`), those led by a column no key of Part holds
 * (`keyed`, physical/indexes/engine.ts firstBlockOrder) where one is, and of them the first by the heading's order,
 * column by column; none where no order of them takes none.
 */
export const expectedOrder = (
	spanning: ReturnType<typeof partSpanning>,
	keyed: ReadonlySet<string>,
	keys: ReadonlyArray<string>,
	served: ReadonlyArray<IndexRequest>
): ReadonlyArray<string> | undefined => {
	const rank = (c: string): number => partHeading.indexOf(c)
	const [first] = Arr.sort(
		Arr.filter(orders(keys), (o) => servesAll(o, served) && stepsOf(spanning, o).length === 0),
		Order.combine(
			Order.mapInput(Order.Boolean, (o: ReadonlyArray<string>) => keyed.has(o[0] ?? "")),
			Order.mapInput(Order.Array(Order.Number), (o: ReadonlyArray<string>) => Arr.map(o, rank))
		)
	)
	return first
}

/** Every column a key of Part holds, its primary key's and its own key's (`partKeys`). */
export const partKeyed = (sketch: PartSketch): ReadonlySet<string> =>
	new Set(partKeys(sketch).flat())

/** The first by the heading's order, column by column, of the orders of `keys` that serve every request of `served`,
 * whatever steps they take: the order the engine gave a B-tree's blocks before it read the spanning bindings. */
export const headingOrder = (
	keys: ReadonlyArray<string>,
	served: ReadonlyArray<IndexRequest>
): ReadonlyArray<string> | undefined => {
	const rank = (c: string): number => partHeading.indexOf(c)
	const [first] = Arr.sort(
		Arr.filter(orders(keys), (o) => servesAll(o, served)),
		Order.mapInput(Order.Array(Order.Number), (o: ReadonlyArray<string>) => Arr.map(o, rank))
	)
	return first
}

export type SkipOrderFeature =
	| "a block reordered so no spanning binding steps a column"
	| "a scope leading beside a spanning binding within the index"
	| "a seek's order kept where a spanning binding steps a column"
	| "an index no order frees of a step"
	| "a relation refused for crossing keys"

/** A key a crossing refusal names among its bounds (physical/statistics/statistics.ts boundText), its columns. */
const crossedKey = regex("^  = key \\(([^)]*)\\) binds one row$", "gm")

/** The remedy a crossing refusal states (physical/statistics/statistics.ts declarationRefused). */
const crossingRemedy =
	"help: give one of the crossed keys a column the other sets do not hold, or ask the index of one set for the other's columns too"

/**
 * The refusal of a Part whose keys and created indexes cross, so no number of distinct values per column ranks its
 * statements (README "Declared statistics"): an UnsupportedOperation at Part's declared statistics, naming among the
 * bounds no exponents meet together at least one key, each a key of Part, and the remedy, a crossed key given a column
 * the other sets do not hold, or an index of one set asked for the other's columns too. A Part keyed (doc, f2) and by
 * (f1, f3), a lookup of (doc, f0, f3) and a seek ordered by (f1, f2) cross so: the key (doc, f2) binds one row, the set
 * (doc, f0, f3) of the key's probe beside f0 and f3 two rows or more, where (f1, f3) binds one and (f1, f2) of its
 * probe beside f2 two or more, and no order of a created index's block moves a set apart.
 */
export const judgeCrossing = (sketch: PartSketch, error: CompileError): void => {
	const reason = error.reason
	assertVariant(
		reason,
		"_tag",
		"UnsupportedOperation",
		"Part is refused only for keys and indexes that cross"
	)
	assert.equal(
		reason.at.label,
		"declared statistics of Part",
		"the refusal stands at Part's declared statistics"
	)
	const named = Arr.map(Arr.fromIterable(Str.matchAll(crossedKey)(reason.capability)), (m) =>
		Str.split(defined(m[1], "a crossed key's columns"), ", ")
	)
	const keys = partKeys(sketch)
	assert.ok(
		Arr.isReadonlyArrayNonEmpty(named) &&
			Arr.every(named, (k) => Arr.some(keys, (key) => sameColumns(key, k))),
		`the crossing names keys of Part (${Arr.join(
			Arr.map(keys, (k) => `(${Arr.join(k, ", ")})`),
			", "
		)}) among its bounds: ${reason.capability}`
	)
	assert.ok(
		Str.includes(crossingRemedy)(reason.capability),
		`the crossing states its remedy: ${reason.capability}`
	)
}

/** The columns of Rack, a relation in no unit: a to e, each a uuid, of many values, its keys' and its lookups'; and
 * flag, a boolean, of few values, its lookups' too. */
const rackColumns = ["a", "b", "c", "d", "e"] as const

/** Rack's column of few values. */
export const rackFew = "flag"

/**
 * A rack: Rack, a relation in no unit, under a primary key of one or two of its columns of many values and a key of one
 * besides or none, each drawn, and up to four equality lookups of two or three of its columns each, drawn, its column of
 * few values among them.
 */
export interface Rack {
	readonly primary: ReadonlyArray<string>
	readonly key: ReadonlyArray<string>
	readonly lookups: ReadonlyArray<ReadonlyArray<string>>
}

export const rackGen: Gen<Rack> = (source) => {
	const primary = source.draw(shuffled(rackColumns, { min: 1, max: 2 }))
	const rest = Arr.filter(rackColumns, (c) => !primary.includes(c))
	return {
		primary,
		key: source.draw(shuffled(rest, { min: 0, max: 1 })),
		lookups: source.draw(
			array((s) => s.draw(shuffled([...rackColumns, rackFew], { min: 2, max: 3 })), {
				min: 1,
				max: 4
			})
		)
	}
}

/** The rack's equality lookup of `columns`. */
const rackLookup = (columns: ReadonlyArray<string>): IndexRequest => ({
	relation: "Rack",
	keys: Arr.map(columns, (expr) => ({ expr, dir: "asc", opclass: defaultOpclass })),
	method: "btree",
	fixed: columns.length,
	role: "access",
	use: "equality lookup"
})

/** The rack's installation, its keys stated, with its lookups requested. */
export const installRack = (rack: Rack) => {
	const owned = owning({
		name: "Racked",
		relations: [
			relation(
				"Rack",
				{ a: f.uuid, b: f.uuid, c: f.uuid, d: f.uuid, e: f.uuid, flag: f.boolean },
				rack.primary
			)
		],
		statements: Arr.map(rack.key, (k) => key(on("Rack", [k]))),
		bases: []
	})
	return compileInstallation(owned, {
		...installOptions(owned),
		extensions: [requesting(Arr.map(rack.lookups, rackLookup))]
	})
}

export type RackFeature =
	| "a lead of many values beside a column of few"
	| "a lead no other index leads with"
	| "a lead no key holds"
	| "a lead a key holds, no other free"
	| "every column of the first block leading another index"

/**
 * A read of Flagged, keyed by id, with a boolean flag and gate and a bigint n, and a key over (flag, gate) where
 * `keyed`: an equality request of a workload's use binding `bound`, some of flag, gate and n.
 */
export interface FlaggedRead {
	readonly keyed: boolean
	readonly bound: Arr.NonEmptyReadonlyArray<"flag" | "gate" | "n">
	readonly use: Extract<AccessUse, "key lookup" | "equality lookup" | "join key" | "write target">
}

export const flaggedReadGen: Gen<FlaggedRead> = (source) => ({
	keyed: source.draw(boolean),
	bound: nonEmptyKeys(source.draw(subset(["flag", "gate", "n"] as const, { min: 1, max: 3 }))),
	use: source.draw(element(["key lookup", "equality lookup", "join key", "write target"] as const))
})

/** Flagged's installation with a FlaggedRead's request, and the request. */
export const installFlagged = (read: FlaggedRead) => {
	const owned = owning({
		name: "Flags",
		relations: [
			relation("Flagged", { id: f.uuid, flag: f.boolean, gate: f.boolean, n: f.bigint }, ["id"])
		],
		statements: read.keyed ? [key(on("Flagged", ["flag", "gate"]))] : [],
		bases: []
	})
	const request: IndexRequest = {
		relation: "Flagged",
		keys: Arr.map(read.bound, (expr) => ({ expr, dir: "asc" as const, opclass: defaultOpclass })),
		method: "btree",
		fixed: read.bound.length,
		role: "access",
		use: read.use
	}
	return {
		request,
		installation: compileInstallation(owned, {
			...installOptions(owned),
			extensions: [requesting([request])]
		})
	}
}

export type FewValuedFeature =
	| "a read of columns of few values alone"
	| "a read of a whole key of columns of few values"
	| "a read of columns of few values beside one of many"
