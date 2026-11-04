/**
 * The per-execution take forms against the conservative lowering: the optimized output equals the conservative output
 * in every form the runtime may execute.
 *
 * The generated population never draws a correlated take (gen/query.ts builds every take uncorrelated), so it never
 * reaches a per-execution choice and the runner's variant path (support.ts) would go unexercised. These cases are
 * hand-built, their facts generated, so every one of them does: a take of a relation's first k rows per parent, in a
 * total order, whose parent set is the input of the execution:
 *
 * - an attachment's delivered parent keys: accounts P(id, a) with each one's first k entries C(k, p, v) attached by p =
 *   id. The narrow child fuses into its parent and its take is fixed LATERAL; the wide one, which also delivers
 *   attachFuseMaxFields further columns of C, is pipelined over the parent-key recordset, and its take chooses by the
 *   parent count between LATERAL and the whole-relation form (DISTINCT ON for k = 1, row_number() otherwise);
 * - a relation parameter: a region binding each id of the parameter to the first k entries with that p, which chooses
 *   by the parameter's row count.
 *
 * Every case runs through the differential (support.ts): the default program, each per-execution variant statement, and
 * the VALUES transport of a small relation parameter, each compared with the conservative run as raw text multisets
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
	uniqueArray
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Formatter } from "effect"
import { attachFuseMaxFields } from "#compiler/core/policy.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type CompletedOrder,
	conservativeMeta,
	type Heading,
	type RelNode
} from "#compiler/ir/rel.ts"
import {
	differential,
	type OptimizedFeature,
	optimizedShrink
} from "#test/pg/oracle/optimized/suite.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { normalQuery } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, type GenSchema, schemaName } from "#test/support/oracle/gen/schema.ts"
import { indices } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { plainRegion, Q } from "#test/unit/lower/conservative/fixtures.ts"

const cases = 250

const relation = (
	name: string,
	columns: ReadonlyArray<string>,
	primaryKey: ReadonlyArray<string>
): GenRelation => ({
	name,
	columns: Arr.map(columns, (c) => ({ name: c, type: int4 })),
	primaryKey,
	keys: [],
	mutable: false
})

const P = relation("P", ["id", "a"], ["id"])
/**
 * The wide child's further columns: attachFuseMaxFields of them, so it delivers more fields than a fused attachment
 * carries however many of the narrow child's three count.
 */
const wideColumns = Arr.map(indices(attachFuseMaxFields), (i) => `w${i}`)
const C = relation("C", ["k", "p", "v", ...wideColumns], ["k"])
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

interface Sketch {
	/**
	 * An attachment whose child delivers C's first three columns, one whose child delivers every column of C, or a
	 * relation parameter.
	 */
	readonly form: "attach" | "wide attach" | "input"
	readonly k: number
	readonly dir: "asc" | "desc"
	readonly accounts: ReadonlyArray<ReadonlyArray<TypedLiteral>>
	readonly entries: ReadonlyArray<ReadonlyArray<TypedLiteral>>
	/** The relation parameter's ids, repeats included; the runner sends their normalized set. */
	readonly ids: ReadonlyArray<number>
}

const sketchGen: Gen<Sketch> = (source) => ({
	form: source.draw(element(["attach", "wide attach", "input"] as const)),
	k: source.draw(intGen(1, 3)),
	dir: source.draw(element(["asc", "desc"] as const)),
	accounts: source.draw(rowsGen([0, 5], [[0, 2]], 5)),
	entries: source.draw(
		rowsGen([0, 11], [[0, 6], [0, 2], ...Arr.map(wideColumns, () => [0, 2] as const)], 9)
	),
	ids: source.draw(array(intGen(0, 6), { min: 0, max: 5 }))
})

const resolve = (s: Sketch): QueryCase => {
	const q = new Q()
	/** First k by v, ties by the key k, so the order is total. */
	const order: CompletedOrder = {
		keys: [
			{ column: "v", dir: s.dir },
			{ column: "k", dir: "asc" }
		]
	}
	const bound = { kind: "literal" as const, k: BigInt(s.k) }
	/**
	 * The narrow child takes a region delivering (k, p, v), which the order and the correlation cover; the wide one takes
	 * C itself, every column of it, whose declared key k completes the order.
	 */
	const entries =
		s.form === "wide attach"
			? q.base(relationSpec(C), conservativeMeta)
			: q.region([
					{
						source: q.base(relationSpec(C), conservativeMeta),
						bind: { k: "k", p: "p", v: "v" },
						constants: {}
					}
				])
	const params: Record<
		string,
		{ kind: "relation"; heading: Heading; rows: ReadonlyArray<ReadonlyArray<TypedLiteral>> }
	> = {}
	/**
	 * The root: an attachment of each account's first entries to the accounts, or, in the input form, a region over the
	 * relation parameter of parent ids, each joined to its first entries.
	 */
	let root: RelNode
	if (s.form !== "input") {
		const accounts = q.project(
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
		)
		const first = q.take(
			entries,
			order,
			bound,
			[{ column: "p", expr: q.col(accounts, "id") }],
			conservativeMeta
		)
		root = q.attach(accounts, first, "first", [["id", "p"]], "array", undefined)
	} else {
		const heading: Heading = [{ name: "id", type: int4 }]
		params["ids"] = { kind: "relation", heading, rows: Arr.map(s.ids, (id) => [int(id)]) }
		const outer = q.b.reserve()
		const parent = q.b.expr({
			kind: "column",
			column: { node: outer, name: "pid" },
			args: [],
			type: int4,
			nonNull: "storage"
		})
		const first = q.take(entries, order, bound, [{ column: "p", expr: parent }], conservativeMeta)
		root = q.regionWith(
			[
				{ source: q.input("ids", heading), bind: { id: "pid" }, constants: {} },
				{ source: first, bind: { k: "k", p: "pid", v: "v" }, constants: {} }
			],
			{ ...plainRegion, id: { kind: "reserved", id: outer } }
		)
	}
	const dag = normalQuery(q.b.build(Arr.of(root)))
	return {
		schema,
		facts: canonicalFacts({ P: s.accounts, C: s.entries }),
		query: { dag, params },
		spelling: { mode: "drawn", edge: false }
	}
}

/**
 * The features every correlated take must reach: a per-execution variant and the VALUES transport ran, each take
 * shape, rows delivered, and the attachment both fused (the narrow child) and pipelined (the wide one).
 */
const situations = [
	"form:optimized variant",
	"form:optimized VALUES",
	"R20.lateral",
	"R20.distinctOn",
	"R20.rowNumber",
	"nonempty",
	"fused attachment",
	"pipelined attachment"
] as const satisfies ReadonlyArray<OptimizedFeature>

layer(Substrate.layer)("the per-execution take forms against the conservative lowering", (it) => {
	it.effect(
		`agrees on ${cases} correlated-take cases, in the program and every variant`,
		(ctx) =>
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
						caseHang: Duration.minutes(2),
						perturb: "all"
					}
				)
			),
		900_000
	)
})
