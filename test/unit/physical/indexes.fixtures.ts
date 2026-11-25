/** What the properties of indexes.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
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
	weighted
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { regex } from "arkregex"
import { Array as Arr, Equivalence, Option, Order } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { defaultOpclass, type NativeColumn } from "#compiler/ir/law.ts"
import type { AccessUse, IndexRequest } from "#compiler/ir/products.ts"
import { keyTermText, type PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { indexMaxKeys } from "#compiler/schema/representability.ts"
import { contained, f, key, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
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
