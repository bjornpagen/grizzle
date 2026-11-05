import { describe, it } from "@effect/vitest"
import { exhaust, explore, type Kept, sketched } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, pipe, String as Str } from "effect"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { identityValueOf, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { Selector } from "#compiler/ir/law.ts"
import {
	type AccessUse,
	allRows,
	defaultOpclass,
	type IndexOpclass,
	type IndexRequest,
	type IndexRows
} from "#compiler/ir/products.ts"
import type { PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { contained, f, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import { owner, requesting } from "#test/unit/physical/fixtures.ts"

/** Event: a plain table under its primary key, with a vector column an HNSW request keys. Booking: a span key, so a GiST
 * index whose leading room column btree_gist serves by equality. Deposit: the reverse lookup of its reference to Line on
 * line, which its primary key (account, line) cannot serve. Each has a boolean field a law's selection reads. No law
 * installs a partial index: a selected side's key is a UNIQUE over its generated column.
 *
 * The index request engine's own contract, judged from its plan alone. Over drawn requests
 * on a schema with a plain table, a span key's GiST index and a reverse lookup, in a drawn order, each law request
 * reading every row or only the rows of a drawn selection:
 *
 * - every request lands on exactly one planned index;
 * - a created index is never unique, and holds every row or exactly the rows one of its requests reads;
 * - the plan is the same whatever order the requests arrive in;
 * - a request the engine cannot create (an entry beyond its method's limit, more than INDEX_MAX_KEYS columns, an
 *   expression key) is refused as a key is;
 * - created indexes have distinct names, and a B-tree and a GiST request on one column list install as two;
 * - and the access index name (core/identity.ts identity.accessIndex) is injective: of every two selections from pools
 *   of near spellings, each literal of the kind its column's type fixes, the names are one exactly when they are.
 *
 * Whether the index a request lands on serves it, and whether a created index is needed, is PostgreSQL's to judge
 * in the database suites: nothing here states which index serves which request. */
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
				live: f.boolean,
				body: f.wildcard,
				embedding: { kind: "vector", dimensions: 3 }
			},
			["id"]
		),
		relation(
			"Booking",
			{ room: f.uuid, during: f.span(f.integer, undefined), id: f.uuid, held: f.boolean },
			["room", "during"]
		),
		relation("Line", { id: f.uuid }, ["id"]),
		relation("Deposit", { line: f.uuid, account: f.uuid, remainder: f.boolean }, [
			"account",
			"line"
		])
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
const bool = (value: boolean): TypedLiteral => ({ kind: "bool", value })
/** The selections a drawn law request may read, per relation. */
const selections: Readonly<Record<string, ReadonlyArray<Selector>>> = {
	Event: [
		{ column: "live", value: bool(true) },
		{ column: "live", value: bool(false) }
	],
	Booking: [{ column: "held", value: bool(true) }],
	Deposit: [
		{ column: "remainder", value: bool(true) },
		{ column: "remainder", value: bool(false) }
	]
}

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
	/** A law request's rows: every row at 0, else the relation's selection it picks. */
	readonly selection: number
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
		selection: source.draw(int(0, 2)),
		use: source.draw(element(accessUses)),
		vector: source.draw(int(0, 3)),
		cosine: source.draw(boolean)
	}
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
	const chosen = selections[rel]?.[s.selection - 1]
	return s.law
		? {
				relation: rel,
				keys: Arr.map(keys, (k) => ({ ...k, dir: "asc" as const })),
				method: "btree",
				role: "lawMaintenance",
				use: "reverse reference",
				rows: chosen === undefined ? allRows : { kind: "selected", selection: [chosen] },
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

/** A request the engine cannot create, planted beside the drawn ones, or two requests on one column list by two access
 * methods, which it installs as two indexes of two names. */
type Broken = "an unrepresentable entry" | "too many keys" | "an expression key"
type Planted = "none" | Broken | "a B-tree and a GiST index on one column list"

const access = (keys: ReadonlyArray<string>, method: "btree" | "gist"): IndexRequest => ({
	relation: "Event",
	keys: Arr.map(keys, (expr) => ({ expr, dir: "asc", opclass: defaultOpclass })),
	method,
	role: "access",
	use: "page seek"
})

const plantedRequests = (planted: Planted): ReadonlyArray<IndexRequest> => {
	switch (planted) {
		case "none":
			return []
		case "an unrepresentable entry":
			return [access(["body"], "btree")]
		case "too many keys":
			return [
				access(
					Array.from({ length: 33 }, () => "tenant"),
					"btree"
				)
			]
		case "an expression key":
			return [access(["e12"], "btree")]
		case "a B-tree and a GiST index on one column list":
			return [access(["unrelated"], "btree"), access(["unrelated"], "gist")]
	}
}

const expectedRefusal: Readonly<Record<Broken, CompileReasonTag>> = {
	"an unrepresentable entry": "UnrepresentableKey",
	"too many keys": "UnrepresentableKey",
	"an expression key": "UnsupportedOperation"
}

/** Two literals of the kinds a drawn selection holds, as one value. */
const sameLiteral = (a: TypedLiteral, b: TypedLiteral): boolean => {
	switch (a.kind) {
		case "bool":
			return b.kind === "bool" && a.value === b.value
		case "int":
			return b.kind === "int" && a.value === b.value
		case "text":
			return b.kind === "text" && a.value === b.value
		case "uuid":
			return b.kind === "uuid" && a.value === b.value
		case "enum":
			return b.kind === "enum" && a.handle === b.handle
		case "numeric":
		case "float":
		case "floatSpecial":
		case "money":
		case "span":
		case "vector":
			throw new Error(`no ${a.kind} literal is drawn`)
	}
}

const sameSelectors = (
	a: ReadonlyArray<{ readonly column: string; readonly value: TypedLiteral }>,
	b: ReadonlyArray<{ readonly column: string; readonly value: TypedLiteral }>
): boolean =>
	a.length === b.length &&
	Arr.every(a, (x, i) => {
		const y = b[i]
		return y !== undefined && x.column === y.column && sameLiteral(x.value, y.value)
	})

/** Two row sets as one: every row, or one selection. */
const sameRows = (a: IndexRows, b: IndexRows): boolean =>
	a.kind === "all"
		? b.kind === "all"
		: b.kind === "selected" && sameSelectors(a.selection, b.selection)

/** The rows a request reads: a law's states them, a program's access reads every row. */
const rowsOf = (request: IndexRequest): IndexRows =>
	request.role === "lawMaintenance" ? request.rows : allRows

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
	| "a selected probe on a created index of its selection"
	| "a selected probe on a created index of every row"
	| "a selected probe on an installed index of every row"
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
	planted: source.draw(
		element<Planted>([
			"none",
			"none",
			"none",
			"an unrepresentable entry",
			"too many keys",
			"an expression key",
			"a B-tree and a GiST index on one column list"
		])
	)
})

/** The keys of a request on a relation's columns, by their positions in `columns`, each ascending or descending. */
const keysOf = (
	relation: (typeof relations)[number],
	keys: ReadonlyArray<readonly [number, "asc" | "desc"]>
): RequestSketch["keys"] =>
	Arr.map(keys, ([i, dir]) => ({
		column: defined(defined(columns[relation])[i], `column ${i} of ${relation}`),
		desc: dir === "desc"
	}))

/** A law's request on a relation's columns, by their positions in `columns`, reading every row (selection 0) or the
 * rows of the selection at that position of `selections`. */
const lawRequest = (
	relation: (typeof relations)[number],
	positions: ReadonlyArray<number>,
	selection: number
): RequestSketch => ({
	relation,
	keys: keysOf(
		relation,
		Arr.map(positions, (i) => [i, "asc"])
	),
	law: true,
	selection,
	use: "key lookup",
	vector: 1,
	cosine: false
})

const eventLawRequest = (positions: ReadonlyArray<number>, selection: number): RequestSketch =>
	lawRequest("Event", positions, selection)

/** A program's B-tree request on Event's columns, of one access use. */
const eventAccessRequest = (
	keys: ReadonlyArray<readonly [number, "asc" | "desc"]>,
	use: (typeof accessUses)[number]
): RequestSketch => ({
	relation: "Event",
	keys: keysOf("Event", keys),
	law: false,
	selection: 0,
	use,
	vector: 1,
	cosine: false
})

/** Planted, each a few times a run in the drawn requests or fewer:
 * - a law request of every row on (tenant, account), a selected one on (tenant, created) and a selected one on
 *   (tenant), so a selected probe meets a created index of every row and one of its selection;
 * - a program's lookup on tenant creates an index of every row, which then serves a selected law probe on tenant;
 * - two take seeks on (tenant, created), one with created descending, which no one index reads both ways. */
const engineKept: ReadonlyArray<Kept<EngineSketch, IndexFeature>> = [
	{
		note: "a selected probe that a created index of every row and one of its selection both serve",
		sketch: {
			requests: [eventLawRequest([0, 1], 0), eventLawRequest([0, 2], 1), eventLawRequest([0], 1)],
			arrival: [2, 1, 0, 3, 4, 5],
			planted: "none"
		},
		draws: "",
		reaches: ["a selected probe on a created index of its selection"]
	},
	{
		note: "a selected probe on tenant beside a program's lookup on tenant",
		sketch: {
			requests: [eventAccessRequest([[0, "asc"]], "equality lookup"), eventLawRequest([0], 1)],
			arrival: [1, 0, 2, 3, 4, 5],
			planted: "none"
		},
		draws: "",
		reaches: ["a selected probe on a created index of every row"]
	},
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
			planted: "none"
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
						suite: "unit/physical/index-engine",
						draw: sketched(engineGen, (x) => x),
						literal: Formatter.format,
						coverage: required<IndexFeature>(
							[
								"served by an installed index",
								"served by a created index",
								"a created index serving several requests",
								"a GiST key serving a B-tree probe",
								"a selected probe on a created index of its selection",
								"a selected probe on a created index of every row",
								"a selected probe on an installed index of every row",
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
							if (planted === "a B-tree and a GiST index on one column list") {
								const created = Arr.filter(
									succeeded(install(plantedRequests(planted))).indexes,
									(x) =>
										x.index.kind === "created" && Arr.every(x.keys, (k) => k.field === "unrelated")
								)
								assert.deepEqual(
									Arr.sort(
										Arr.map(created, (x) => x.method),
										Order.String
									),
									["btree", "gist"]
								)
								assert.equal(new Set(Arr.map(created, (x) => x.index.name)).size, 2, "two names")
								c.note(`${planted} installed`)
								return
							}
							if (planted !== "none") {
								c.note(`${planted} refused`)
								refused(install(plantedRequests(planted)), expectedRefusal[planted])
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
							const columnsOf = (x: PlannedIndex) =>
								Arr.join(
									Arr.map(x.keys, (k) => k.field),
									" "
								)
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
										Arr.map(r.keys, (k) => k.expr),
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
								if (rowsOf(r).kind === "selected") {
									const own = index.index.kind === "created"
									if (index.rows.kind === "selected") {
										assert.ok(own, `${index.index.name}: no law installs a partial index`)
										c.note("a selected probe on a created index of its selection")
									} else {
										c.note(
											own
												? "a selected probe on a created index of every row"
												: "a selected probe on an installed index of every row"
										)
									}
								}
							}
							for (const index of created) {
								assert.equal(index.unique, false, `${index.index.name} is not unique`)
								assert.ok(
									index.rows.kind === "all" ||
										Arr.some(index.requests, (r) => sameRows(index.rows, rowsOf(r))),
									`${index.index.name} holds the rows one of its requests reads`
								)
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

/** A selector's literals by the kind its column's type fixes: each pool holds near spellings, a text and its upper case,
 * a plain word beside one whose hex spelling it imitates, a negative integer beside the word its spelling reads as. */
const uuidLiteral = (n: number): TypedLiteral => ({
	kind: "uuid",
	value: `00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`
})

const pools: ReadonlyArray<readonly [string, ReadonlyArray<TypedLiteral>]> = [
	["flag", [bool(true), bool(false)]],
	["n", Arr.map([-5n, 0n, 5n, 50n], (value): TypedLiteral => ({ kind: "int", value }))],
	[
		"t",
		Arr.map(
			[
				"a",
				"A",
				"a_b",
				"a__b",
				"_a",
				"a_",
				"",
				"x41",
				"0x41",
				"minus_5",
				"true",
				"approved",
				"a b"
			],
			(value): TypedLiteral => ({ kind: "text", value })
		)
	],
	[
		"e",
		Arr.map(["approved", "Approved", "approved_x", "0x61", "a"], (handle): TypedLiteral => ({
			kind: "enum",
			handle
		}))
	],
	["u", [uuidLiteral(1), uuidLiteral(2)]]
]

const selectorsOf = Arr.flatMap(pools, ([column, values]) =>
	Arr.map(values, (value) => ({ column, value }))
)

/** One access index identity: its method, its keys and its predicate's selectors. */
interface NameIdentity {
	readonly method: "btree" | "gist" | "hnsw"
	readonly keys: ReadonlyArray<{
		readonly column: string
		readonly dir: "asc" | "desc"
		readonly opclass: IndexOpclass
	}>
	readonly predicate: ReadonlyArray<{ readonly column: string; readonly value: TypedLiteral }>
}

const fullName = (x: NameIdentity): string =>
	identity.accessIndex(
		"Event",
		x.method,
		Arr.map(x.keys, (k) => ({ field: k.column, dir: k.dir, opclass: k.opclass.kind })),
		Arr.map(x.predicate, (s) => ({ field: s.column, value: identityValueOf(s.value) }))
	).identifier

type NameFeature =
	| "one identity twice"
	| "two identities one selector's literal apart"
	| "a predicate beside none"

describe("the access index name", () => {
	it.effect("is injective: two identities share a name exactly when they are one", (ctx) =>
		Effect.gen(function* () {
			const keys: NameIdentity["keys"] = [
				{ column: "account", dir: "asc", opclass: defaultOpclass }
			]
			yield* searched(
				ctx,
				exhaust(
					{
						suite: "unit/physical/index-name-injective",
						generator: (source) =>
							[
								source.draw(element(Arr.append(selectorsOf, undefined))),
								source.draw(element(Arr.append(selectorsOf, undefined)))
							] as const,
						literal: Formatter.format,
						limit: (selectorsOf.length + 1) ** 2,
						coverage: requiredInSpace<NameFeature>([
							"one identity twice",
							"two identities one selector's literal apart",
							"a predicate beside none"
						]),
						caseHang
					},
					([a, b], c) =>
						Effect.sync(() => {
							const x: NameIdentity = {
								method: "btree",
								keys,
								predicate: a === undefined ? [] : [a]
							}
							const y: NameIdentity = {
								method: "btree",
								keys,
								predicate: b === undefined ? [] : [b]
							}
							const one = sameSelectors(x.predicate, y.predicate)
							assert.equal(fullName(x) === fullName(y), one, `${fullName(x)} beside ${fullName(y)}`)
							if (one) {
								c.note("one identity twice")
							} else if (a === undefined || b === undefined) {
								c.note("a predicate beside none")
							} else if (a.column === b.column) {
								c.note("two identities one selector's literal apart")
							}
						})
				)
			)
		})
	)
})
