/**
 * The per-execution take forms, and the one fused attachment, against the conservative lowering: the optimized output
 * equals the conservative output in every form the runtime may execute.
 *
 * The generated population never draws a correlated take (gen/query.ts builds every take uncorrelated), so it never
 * reaches a per-execution choice and the runner's variant path (support.ts) would go unexercised. These cases are
 * hand-built, their facts generated, so every one of them does: a take of a relation's first k rows per parent, in a
 * total order, whose parent set is the input of the execution:
 *
 * - an attachment's delivered parent keys: accounts P(id, a, e) with each one's first k entries C(k, p, v) attached by
 *   p = id, through a narrow child over a region of C, a wide one that also delivers C's further columns, and one that
 *   delivers only the entry's key. Each is pipelined over the parent-key recordset, its parents reading no approximate
 *   search, and its take chooses by the parent count between LATERAL and the whole-relation form (DISTINCT ON for
 *   k = 1, row_number() otherwise);
 * - the same attachments to the accounts nearest a probe vector by the cosine distance of their embedding e, one
 *   ApproximateNearest search over one rule's projection, which keeps the account's key id or only its group a (so the
 *   search deduplicates its candidates), the entries attached by p equal to that column. This is the one case an
 *   attachment fuses: its parent's rows read an approximate search, which a pipelined statement would run a second
 *   time (lower/shapes/index.ts rowsStatement), so the child is an array column of the parent statement, one field
 *   as text[] and several as jsonb[], which the runner unfuses and compares with the conservative lowering's pipelined
 *   statement. The oracle installation builds no HNSW index, so both lowerings' searches are the exact top k, ties at
 *   the cutoff settled by the heading's other column in both;
 * - a relation parameter: a region binding each id of the parameter to the first k entries with that p, which chooses
 *   by the parameter's row count.
 *
 * Every case runs through the differential (support.ts): the default program, each per-execution variant statement, and
 * the VALUES transport of a small relation parameter, each compared with the conservative run as raw text sets
 * with no repeated row.
 */
import { layer } from "@effect/vitest"
import { sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	constant,
	element,
	type Gen,
	int as intGen,
	map,
	oneOf,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Formatter } from "effect"
import { type Direction, directions } from "#compiler/core/order.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type CompletedOrder,
	conservativeMeta,
	type Heading,
	type RelNode
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { cosineDistance } from "#compiler/scalar/compute/registry.ts"
import {
	differential,
	type OptimizedFeature,
	optimizedShrink
} from "#test/pg/oracle/optimized/suite.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { float8, int4, scalarOfSpec, valueClasses } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { type GenParam, normalQuery } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, type GenSchema, schemaName } from "#test/support/oracle/gen/schema.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { plainRegion, Q } from "#test/unit/lower/conservative/fixtures.ts"

const cases = 250

const relation = (
	name: string,
	columns: ReadonlyArray<readonly [string, ScalarType]>,
	primaryKey: ReadonlyArray<string>
): GenRelation => ({
	name,
	columns: Arr.map(columns, ([column, type]) => ({ name: column, type })),
	primaryKey,
	keys: [],
	mutable: false
})

/** An account's embedding, and a probe's: a vector of the generated dimensions (gen/domain.ts). */
const embedding = scalarOfSpec({ carrier: "vector" })

const P = relation(
	"P",
	[
		["id", int4],
		["a", int4],
		["e", embedding]
	],
	["id"]
)
/**
 * The wide child's further columns, which only the wide child delivers.
 */
const wideColumns = ["w0", "w1", "w2", "w3"]
const C = relation(
	"C",
	Arr.map(["k", "p", "v", ...wideColumns], (column) => [column, int4] as const),
	["k"]
)
const schema: GenSchema = { name: schemaName, relations: [P, C], closed: [], containments: [] }

const relationSpec = (r: GenRelation) => ({
	name: r.name,
	heading: Arr.map(r.columns, (c): Heading[number] => ({ name: c.name, type: c.type })),
	primaryKey: r.primaryKey
})

const int = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/**
 * Rows with a distinct first column in `key` and the other columns in their small ranges, so values repeat and an
 * entry may name no account.
 */
const rowsGen = (
	key: readonly [number, number],
	others: ReadonlyArray<readonly [number, number]>,
	max: number
): Gen<ReadonlyArray<ReadonlyArray<TypedLiteral>>> =>
	map(
		uniqueArray(
			(source): readonly [number, ReadonlyArray<number>] => [
				source.draw(intGen(key[0], key[1])),
				Arr.map(others, ([min, hi]) => source.draw(intGen(min, hi)))
			],
			([k]) => k,
			{ min: 0, max },
			20
		),
		(rows) => Arr.map(rows, ([k, rest]) => [int(k), ...Arr.map(rest, int)])
	)

/**
 * The embeddings an account holds and a probe searches by: the generated domain's vectors, among them two of one
 * direction, so distances tie.
 */
const embeddings = valueClasses(embedding, false)

const embeddingGen: Gen<TypedLiteral> = (source) =>
	elementAt(embeddings, source.draw(intGen(0, embeddings.length - 1)), "an embedding")

/** Accounts (id, a) with distinct ids, each with an embedding. */
const accountsGen: Gen<ReadonlyArray<ReadonlyArray<TypedLiteral>>> = (source) =>
	Arr.map(source.draw(rowsGen([0, 5], [[0, 2]], 5)), (row) => [...row, source.draw(embeddingGen)])

/** The parents an attachment's entries are attached to. */
type Parents =
	| { readonly kind: "accounts" }
	| {
			readonly kind: "nearest"
			readonly probe: TypedLiteral
			readonly take: number
			/** The account column the candidates keep and the entries correlate on: its key, or its group. */
			readonly by: "id" | "a"
	  }

/**
 * What an attachment's child delivers of each of a parent's first entries: C's first three columns, every column of
 * C, or only the entry's key.
 */
type Child = "narrow" | "wide" | "key"

interface Sketch {
	/**
	 * An attachment of each parent's first entries, or a relation parameter's ids, repeats included, of which the runner
	 * sends the normalized set.
	 */
	readonly form:
		| { readonly kind: "attach"; readonly parents: Parents; readonly child: Child }
		| { readonly kind: "input"; readonly ids: ReadonlyArray<number> }
	readonly k: number
	readonly dir: Direction
	readonly accounts: ReadonlyArray<ReadonlyArray<TypedLiteral>>
	readonly entries: ReadonlyArray<ReadonlyArray<TypedLiteral>>
}

const parentsGen: Gen<Parents> = oneOf<Parents>([
	constant<Parents>({ kind: "accounts" }),
	(source) => ({
		kind: "nearest",
		probe: source.draw(embeddingGen),
		take: source.draw(intGen(1, 4)),
		by: source.draw(element(["id", "a"] as const))
	})
])

const formGen: Gen<Sketch["form"]> = weighted<Sketch["form"]>([
	[
		2,
		(source) => ({
			kind: "attach",
			parents: source.draw(parentsGen),
			child: source.draw(element(["narrow", "wide", "key"] as const))
		})
	],
	[1, (source) => ({ kind: "input", ids: source.draw(array(intGen(0, 6), { min: 0, max: 5 })) })]
])

const sketchGen: Gen<Sketch> = (source) => ({
	form: source.draw(formGen),
	k: source.draw(intGen(1, 3)),
	dir: source.draw(element(directions)),
	accounts: source.draw(accountsGen),
	entries: source.draw(
		rowsGen([0, 11], [[0, 6], [0, 2], ...Arr.map(wideColumns, () => [0, 2] as const)], 9)
	)
})

/**
 * The accounts nearest the probe by the cosine distance of their embedding, each with the column `by` and its distance:
 * the source one rule's projection over P, as the checker builds a search (check/approximate/trace.ts).
 */
const nearest = (q: Q, parents: Extract<Parents, { readonly kind: "nearest" }>): RelNode => {
	const region = q.region([
		{
			source: q.base(relationSpec(P), conservativeMeta),
			bind: { id: "id", a: "a", e: "e" },
			constants: {}
		}
	])
	const distance = q.op(
		cosineDistance.id,
		[q.col(region, "e"), q.param("probe", embedding, "compare")],
		float8
	)
	const scored = q.project(
		region,
		[
			[parents.by, parents.by],
			["distance", [distance, float8]]
		],
		conservativeMeta
	)
	return q.node({
		kind: "ApproximateNearest",
		source: scored,
		score: "distance",
		take: BigInt(parents.take),
		params: scored.meta.paramDeps,
		sealed: true,
		heading: scored.heading,
		loc: undefined,
		meta: conservativeMeta
	})
}

/** An attachment's parents, the column of theirs its entries correlate on, and the parameters they read. */
const parentsOf = (
	q: Q,
	parents: Parents
): {
	readonly node: RelNode
	readonly by: "id" | "a"
	readonly params: Readonly<Record<string, GenParam>>
} => {
	switch (parents.kind) {
		case "accounts":
			return {
				node: q.project(
					q.region([
						{
							source: q.base(relationSpec(P), conservativeMeta),
							bind: { id: "id", a: "a" },
							constants: {}
						}
					]),
					[
						["id", "id"],
						["a", "a"]
					],
					conservativeMeta
				),
				by: "id",
				params: {}
			}
		case "nearest":
			return {
				node: nearest(q, parents),
				by: parents.by,
				params: { probe: { kind: "scalar", type: embedding, value: parents.probe } }
			}
	}
}

/**
 * The entries a child takes its first k of, in a total order: the narrow child a region delivering (k, p, v) and the
 * wide one C itself, every column of it, both first by v, ties by the key k; the key child a region delivering (k, p),
 * first by k.
 */
const entriesOf = (
	q: Q,
	child: Child,
	dir: Direction
): { readonly node: RelNode; readonly order: CompletedOrder } => {
	const byValue: CompletedOrder = {
		keys: [
			{ column: "v", dir },
			{ column: "k", dir: "asc" }
		]
	}
	switch (child) {
		case "narrow":
			return {
				node: q.region([
					{
						source: q.base(relationSpec(C), conservativeMeta),
						bind: { k: "k", p: "p", v: "v" },
						constants: {}
					}
				]),
				order: byValue
			}
		case "wide":
			return { node: q.base(relationSpec(C), conservativeMeta), order: byValue }
		case "key":
			return {
				node: q.region([
					{
						source: q.base(relationSpec(C), conservativeMeta),
						bind: { k: "k", p: "p" },
						constants: {}
					}
				]),
				order: { keys: [{ column: "k", dir }] }
			}
	}
}

/**
 * The case's root and the parameters it reads: an attachment of each parent's first entries, or, in the input form, a
 * region over the relation parameter of parent ids, each joined to its first entries.
 */
const queryOf = (
	q: Q,
	s: Sketch
): { readonly root: RelNode; readonly params: Readonly<Record<string, GenParam>> } => {
	const bound = { kind: "literal" as const, k: BigInt(s.k) }
	switch (s.form.kind) {
		case "attach": {
			const entries = entriesOf(q, s.form.child, s.dir)
			const parents = parentsOf(q, s.form.parents)
			const first = q.take(
				entries.node,
				entries.order,
				bound,
				[{ column: "p", expr: q.col(parents.node, parents.by) }],
				conservativeMeta
			)
			return {
				root: q.attach(parents.node, first, "first", [[parents.by, "p"]], "array", undefined),
				params: parents.params
			}
		}
		case "input": {
			const entries = entriesOf(q, "narrow", s.dir)
			const heading: Heading = [{ name: "id", type: int4 }]
			const outer = q.b.reserve()
			const parent = q.b.expr({
				kind: "column",
				column: { node: outer, name: "pid" },
				args: [],
				type: int4,
				nonNull: "storage"
			})
			const first = q.take(
				entries.node,
				entries.order,
				bound,
				[{ column: "p", expr: parent }],
				conservativeMeta
			)
			return {
				root: q.regionWith(
					[
						{ source: q.input("ids", heading), bind: { id: "pid" }, constants: {} },
						{ source: first, bind: { k: "k", p: "pid", v: "v" }, constants: {} }
					],
					{ ...plainRegion, id: { kind: "reserved", id: outer } }
				),
				params: {
					ids: { kind: "relation", heading, rows: Arr.map(s.form.ids, (id) => [int(id)]) }
				}
			}
		}
	}
}

const resolve = (s: Sketch): QueryCase => {
	const q = new Q()
	const { root, params } = queryOf(q, s)
	const dag = normalQuery(q.b.build(Arr.of(root)))
	return {
		schema,
		facts: canonicalFacts({ P: s.accounts, C: s.entries }),
		query: { dag, params },
		spelling: { mode: "drawn", edge: false }
	}
}

/**
 * The features every case population must reach: a per-execution variant ran, each take shape, rows delivered, an
 * attachment pipelined over exact parents, and one fused over the nearest accounts, its search both indexed over
 * candidates the key keeps distinct and deduplicated over candidates that lose it.
 */
const situations = [
	"form:optimized variant",
	"R20.lateral",
	"R20.distinctOn",
	"R20.rowNumber",
	"nonempty",
	"pipelined attachment",
	"fused attachment",
	"approximateNearest.indexed",
	"approximateNearest.deduplicated"
] as const satisfies ReadonlyArray<OptimizedFeature>

layer(Substrate.layer)(
	"the per-execution take forms and the fused attachment against the conservative lowering",
	(it) => {
		it.effect(`agrees on ${cases} correlated-take cases, in the program and every variant`, (ctx) =>
			searched(
				ctx,
				differential(
					sketched(sketchGen, (s) => constant(resolve(s))),
					"variants",
					{
						suite: "optimized/variants",
						literal: Formatter.format,
						coverage: required<OptimizedFeature>(situations, { cases: cases, sense: notesOnly }),
						kept: [],
						runs: cases,
						shrink: optimizedShrink,
						perturb: "all"
					}
				)
			)
		)
	}
)
