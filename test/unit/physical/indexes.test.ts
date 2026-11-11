/**
 * The index request engine's own contract (physical/indexes/engine.ts), judged from its plan alone. Over drawn requests
 * on a schema with a plain table, a span key's GiST index and a reverse lookup, in a drawn order:
 *
 * - every request lands on exactly one planned index, of its relation;
 * - a created index is never unique;
 * - the plan is the same whatever order the requests arrive in;
 * - a request the engine cannot create, planted alone with drawn columns (an entry beyond its method's limit, more than
 *   INDEX_MAX_KEYS columns, an expression key), is refused as a key is;
 * - created indexes have distinct names, and a B-tree and a GiST request on one drawn column list install as two.
 *
 * Whether the index a request lands on serves it, and whether a created index is needed, is PostgreSQL's to judge in the
 * database suites: nothing here states which index serves which request.
 *
 * Oracle: the engine's contract stated over the requests: one index each, the arrival order's metamorphic invariance,
 * and the refusal each planted request names.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): indexes-unique-created.patch (a created index is unique),
 * indexes-name-without-method.patch (an index is named as a B-tree whatever its method).
 *
 * Features: served by an installed or a created index, several requests on one created index, a GiST key serving a
 * B-tree probe, an ordered and a range request, each planted refusal, two methods on one column list, and two indexes on
 * one column list.
 */
import { describe, it } from "@effect/vitest"
import { explore, type Kept, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	shuffled,
	weighted
} from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Equivalence, Formatter, Option, Order } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import type { Direction } from "#compiler/core/order.ts"
import { defaultOpclass, type NativeColumn } from "#compiler/ir/law.ts"
import { type AccessUse, type IndexRequest } from "#compiler/ir/products.ts"
import type { PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { indexMaxKeys } from "#compiler/schema/representability.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { contained, f, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { lawNamesOf, wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import { owner, requesting } from "#test/unit/physical/fixtures.ts"

/** Event: a plain table under its primary key, with a vector column an HNSW request keys. Booking: a span key, so a GiST
 * index whose leading room column btree_gist serves by equality. Deposit: the reverse lookup of its reference to Line on
 * line, which its primary key (account, line) cannot serve. */
const Indexed: SchemaDesc = {
	name: "Indexed",
	relations: [
		relation(
			"Event",
			{
				id: f.uuid,
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
		relation("Deposit", { line: f.uuid, account: f.uuid }, ["account", "line"])
	],
	statements: [contained(on("Deposit", ["line"]), on("Line", ["id"]))],
	extends: undefined
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

/** The keys of a drawn request, which draws one at least. */
const nonEmptyKeys = <K>(keys: ReadonlyArray<K>): Arr.NonEmptyReadonlyArray<K> => {
	const [first, ...rest] = keys
	return first === undefined ? assert.fail("a drawn request has a key") : [first, ...rest]
}

const requestOf = (s: RequestSketch, i: number): IndexRequest => {
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
				keys: nonEmptyKeys(
					Arr.map(keys, (k) => ({
						column: fieldColumn(rel, k.expr),
						dir: "asc" as const,
						opclass: k.opclass
					}))
				),
				method: "btree",
				role: "lawMaintenance",
				use: "reverse reference",
				justification: { kind: "law", law: wild.lawId(`l${i}`) }
			}
		: {
				relation: rel,
				keys,
				method: "btree",
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
				min: indexMaxKeys.value + 1,
				max: indexMaxKeys.value + 4
			}),
			(keys) => ({ kind: "too many keys", keys })
		)
	],
	[1, map(matching(regex("^e[0-9]{1,3}$")), (expr) => ({ kind: "an expression key", expr }))],
	[
		1,
		map(shuffled(eventColumns, { min: 1, max: eventColumns.length }), (columns) => ({
			kind: "a B-tree and a GiST index on one column list",
			columns
		}))
	]
])

const access = (keys: ReadonlyArray<string>, method: "btree" | "gist"): IndexRequest => ({
	relation: "Event",
	keys: Arr.map(keys, (expr) => ({ expr, dir: "asc", opclass: defaultOpclass })),
	method,
	role: "access",
	use: "page seek"
})

const plantedRequests = (planted: Planted): ReadonlyArray<IndexRequest> => {
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
	}
}

const expectedRefusal: Readonly<Record<Broken, CompileReasonTag>> = {
	"an unrepresentable entry": "UnrepresentableKey",
	"too many keys": "UnrepresentableKey",
	"an expression key": "UnsupportedOperation"
}

/** Whether two lists of key columns are one, column for column. */
const sameColumns = Arr.makeEquivalence(Equivalence.String)

/** A planned index key's field, or its law column's identifier. */
const keyField = (k: PlannedIndex["keys"][number]): string =>
	k.column.kind === "field" ? k.column.field : k.column.column

const install = (requests: ReadonlyArray<IndexRequest>) => {
	const owned = owning(Indexed)
	return compileInstallation(owned, {
		...installOptions(owned, owner),
		extensions: [requesting(requests)]
	})
}

type IndexFeature =
	| "served by an installed index"
	| "served by a created index"
	| "a created index serving several requests"
	| "a GiST key serving a B-tree probe"
	| "an ordered request"
	| "a range request"
	| `${Broken} refused`
	| "a B-tree and a GiST index on one column list installed"
	| "two indexes on one column list"

interface EngineSketch {
	readonly requests: ReadonlyArray<RequestSketch>
	readonly arrival: ReadonlyArray<number>
	readonly planted: Planted
}

const engineGen: Gen<EngineSketch> = (source) => ({
	requests: source.draw(array(requestGen, { min: 0, max: 6 })),
	arrival: source.draw(array(int(0, 2 ** 31 - 1), { min: 6, max: 6 })),
	planted: source.draw(plantedGen)
})

/** The keys of a request on a relation's columns, by their positions in `columns`, each ascending or descending. */
const keysOf = (
	relation: (typeof relations)[number],
	keys: ReadonlyArray<readonly [number, Direction]>
): RequestSketch["keys"] =>
	Arr.map(keys, ([i, dir]) => ({
		column: defined(defined(columns[relation])[i], `column ${i} of ${relation}`),
		desc: dir === "desc"
	}))

/** A program's B-tree request on Event's columns, of one access use. */
const eventAccessRequest = (
	keys: ReadonlyArray<readonly [number, Direction]>,
	use: (typeof accessUses)[number]
): RequestSketch => ({
	relation: "Event",
	keys: keysOf("Event", keys),
	law: false,
	use,
	vector: 1,
	cosine: false
})

/** Planted, a few times a run in the drawn requests or fewer: two take seeks on (tenant, created), one with created
 * descending, which no one index reads both ways. */
const engineKept: ReadonlyArray<Kept<EngineSketch, IndexFeature>> = [
	{
		note: "two seeks on (tenant, created) in directions no one index reads both ways",
		sketch: {
			requests: [
				eventAccessRequest(
					[
						[0, "asc"],
						[2, "asc"]
					],
					"take seek"
				),
				eventAccessRequest(
					[
						[0, "asc"],
						[2, "desc"]
					],
					"take seek"
				)
			],
			arrival: [0, 1, 2, 3, 4, 5],
			planted: { kind: "none" }
		},
		draws: "",
		reaches: ["two indexes on one column list"]
	}
]

describe("the index request engine", () => {
	it.effect(
		"lands every request on exactly one index, plans alike in any arrival order, and refuses what it cannot create",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "one index per request, invariance under arrival order, and each planted request's refusal"
						},
						suite: "unit/physical/index-engine",
						draw: sketched(engineGen, (x) => x),
						literal: Formatter.format,
						coverage: required<IndexFeature>(
							[
								"served by an installed index",
								"served by a created index",
								"a created index serving several requests",
								"a GiST key serving a B-tree probe",
								"an ordered request",
								"a range request",
								"an unrepresentable entry refused",
								"too many keys refused",
								"an expression key refused",
								"a B-tree and a GiST index on one column list installed",
								"two indexes on one column list"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: engineKept,
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ requests: sketches, arrival, planted }, c) =>
						Effect.sync(() => {
							const requests = Arr.map(sketches, requestOf)
							if (planted.kind === "a B-tree and a GiST index on one column list") {
								const created = Arr.filter(
									succeeded(install(plantedRequests(planted))).indexes,
									(x) =>
										x.index.kind === "created" &&
										sameColumns(Arr.map(x.keys, keyField), planted.columns)
								)
								assert.deepEqual(
									Arr.sort(
										Arr.map(created, (x) => x.method),
										Order.String
									),
									["btree", "gist"]
								)
								assert.equal(new Set(Arr.map(created, (x) => x.index.name)).size, 2, "two names")
								c.note(`${planted.kind} installed`)
								return
							}
							if (planted.kind !== "none") {
								c.note(`${planted.kind} refused`)
								refused(install(plantedRequests(planted)), expectedRefusal[planted.kind])
								return
							}
							/** Created indexes are distinct objects of distinct names (identity.accessIndex). */
							const installation: Installation = succeeded(install(requests))
							const created = Arr.filter(installation.indexes, (x) => x.index.kind === "created")
							assert.equal(
								new Set(Arr.map(created, (x) => x.index.name)).size,
								created.length,
								"distinct names"
							)
							const columnsOf = (x: PlannedIndex) => Arr.join(Arr.map(x.keys, keyField), " ")
							if (
								Arr.some(created, (a) =>
									Arr.some(
										created,
										(b) => a !== b && a.relation === b.relation && columnsOf(a) === columnsOf(b)
									)
								)
							) {
								c.note("two indexes on one column list")
							}
							for (const r of requests) {
								const serving = Arr.filter(installation.indexes, (x) => x.requests.includes(r))
								assert.equal(
									serving.length,
									1,
									`one index holds ${r.relation}(${Arr.join(
										Arr.map(r.keys, (k) => ("expr" in k ? String(k.expr) : k.column.kind)),
										","
									)})`
								)
								const index = defined(serving[0])
								assert.equal(
									index.relation,
									r.relation,
									`${index.index.name} is of the request's relation`
								)
								c.note(
									index.index.kind === "created"
										? "served by a created index"
										: "served by an installed index"
								)
								if (index.method === "gist" && r.method === "btree") {
									c.note("a GiST key serving a B-tree probe")
								}
								if (r.role === "access" && (r.use === "take seek" || r.use === "page seek")) {
									c.note("an ordered request")
								}
								if (r.role === "access" && (r.use === "range" || r.use === "prefix search")) {
									c.note("a range request")
								}
							}
							for (const index of created) {
								assert.equal(index.unique, false, `${index.index.name} is not unique`)
								if (index.requests.length > 1) {
									c.note("a created index serving several requests")
								}
							}
							const shuffled = Arr.map(
								Arr.sort(
									Arr.map(requests, (r, i) => ({ r, key: defined(arrival[i]) })),
									Order.mapInput(Order.Number, (x: { readonly key: number }) => x.key)
								),
								({ r }) => r
							)
							const again = succeeded(install(shuffled))
							assert.deepEqual(again.statements, installation.statements)
							assert.deepEqual(
								Arr.map(again.indexes, (x) => [x.object, x.keys, x.requests.length]),
								Arr.map(installation.indexes, (x) => [x.object, x.keys, x.requests.length])
							)
						})
				)
			)
	)
})
