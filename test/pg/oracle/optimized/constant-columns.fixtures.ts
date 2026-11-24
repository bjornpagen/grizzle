/** What constant-columns.test.ts reads: its unions, the case each builds and the rows both lowerings deliver. */

import { type Aimed, aimed, constant, element } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { floatLiteral } from "#compiler/ir/carriers.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { bool, canonicallySpelled, float8, int4 } from "#test/support/oracle/gen/domain.ts"
import type { StoredRow } from "#test/support/oracle/gen/facts.ts"
import { normalQuery } from "#test/support/oracle/gen/query.ts"
import { Q, type RelationSpec } from "#test/unit/lower/conservative/fixtures.ts"

/** Which arms of the union project the parameter p as its column k: both, only the first, or only the second. */
const armsHolding = ["both", "first", "second"] as const

export type ArmsHolding = (typeof armsHolding)[number]

/** A case of the box: an arrangement of a union's arms, or `zero`, a double precision column equated with q. */
export type ConstantColumnsCase = ArmsHolding | "zero"

export const constantColumnsCases = [...armsHolding, "zero"] as const

/** The pass's two rules, which a case rests on where both arms hold the key at p. */
export const passRules = ["propagate.restrict", "propagate.substitute"] as const

export type ConstantColumnsFeature = ConstantColumnsCase | (typeof passRules)[number]

/**
 * The box: each case, each situation aimed at the case that reaches it, the pass's rules at the arrangement both of
 * whose arms hold p.
 */
export const casesSpace: Aimed<ConstantColumnsCase, ConstantColumnsFeature> = aimed(
	(source) => source.draw(element(constantColumnsCases)),
	[
		...Arr.map(constantColumnsCases, (c) => [c, constant(c)] as const),
		...Arr.map(passRules, (rule) => [rule, constant<ConstantColumnsCase>("both")] as const)
	]
)

/** A session S(a) and its marks M(a, b), each keyed by a. */
const S: RelationSpec = { name: "S", heading: [{ name: "a", type: int4 }], primaryKey: ["a"] }
const M: RelationSpec = {
	name: "M",
	heading: [
		{ name: "a", type: int4 },
		{ name: "b", type: int4 }
	],
	primaryKey: ["a", "b"]
}

const int = (value: number): TypedLiteral => ({ kind: "int", value: BigInt(value) })

/** A stored row of integers, each in its canonical spelling. */
const row = (...values: ReadonlyArray<number>): StoredRow =>
	Arr.map(values, (v) => canonicallySpelled(int(v)))

/** The stored facts: sessions 1, 2 and 3, and marks (1, 0), (1, 1), (2, 0) and (3, 1); p is 2. */
const facts: Readonly<Record<"S" | "M", ReadonlyArray<StoredRow>>> = {
	S: [row(1), row(2), row(3)],
	M: [row(1, 0), row(1, 1), row(2, 0), row(3, 1)]
}

/**
 * The case of `holding`: the marks of each key k of a union of two arms, each projecting k: an arm that holds k at p, S
 * read at a = p and p projected, and an arm that holds no value, every session's a, or a second arm that holds k at p,
 * M read at a = p and p projected. A region binds k to M's a, and a projection over it delivers k and b. Where both
 * arms hold k at p, the constant-column pass reads M at a = p and delivers p as k; where one arm holds every session's
 * key, the union holds k at no value, and every mark of every session is delivered.
 */
const unionCase = (holding: ArmsHolding): QueryCase => {
	const q = new Q()
	const atP = (relation: RelationSpec) =>
		q.project(
			q.region([
				{
					source: q.base(relation, conservativeMeta),
					bind: {},
					constants: { a: q.param("p", int4, "compare") }
				}
			]),
			[["k", [q.param("p", int4, "emit"), int4]]],
			conservativeMeta
		)
	const everySession = q.project(
		q.region([{ source: q.base(S, conservativeMeta), bind: { a: "k" }, constants: {} }]),
		[["k", "k"]],
		conservativeMeta
	)
	const [first, second]: readonly [RelNode, RelNode] =
		holding === "both"
			? [atP(S), atP(M)]
			: holding === "first"
				? [atP(S), everySession]
				: [everySession, atP(S)]
	const keys = q.union([first, second], [])
	const marks = q.region([
		{ source: keys, bind: { k: "k" }, constants: {} },
		{ source: q.base(M, conservativeMeta), bind: { a: "k", b: "b" }, constants: {} }
	])
	const root = q.project(
		marks,
		[
			["k", "k"],
			["b", "b"],
			["same", [q.op("int4eq", [q.col(marks, "k"), q.col(marks, "b")], bool), bool]]
		],
		conservativeMeta
	)
	return {
		schema: {
			name: "ConstantColumns",
			relations: [
				{ name: "S", columns: S.heading, primaryKey: ["a"], keys: [], mutable: false },
				{ name: "M", columns: M.heading, primaryKey: ["a", "b"], keys: [], mutable: false }
			],
			closed: [],
			containments: []
		},
		facts,
		query: {
			dag: normalQuery(q.build(root).dag),
			params: { p: { kind: "scalar", type: int4, value: int(2) } }
		},
		spelling: { mode: "drawn", edge: false }
	}
}

/**
 * The case `zero`: V(k, x), keyed by k, x a double precision, holding (1, -0), read where x = q at q's 0, and a
 * projection delivering k, x and whether x equals itself. x's every row equals q, which a float's equality holds of -0
 * and 0, and holds its own value, which the projection delivers: the stored -0, never q's 0.
 */
const zeroCase = (): QueryCase => {
	const type = float8
	const eq = "float8eq"
	const q = new Q()
	const V: RelationSpec = {
		name: "V",
		heading: [
			{ name: "k", type: int4 },
			{ name: "x", type }
		],
		primaryKey: ["k"]
	}
	const stored = q.region([
		{ source: q.base(V, conservativeMeta), bind: { k: "k", x: "x" }, constants: {} }
	])
	const read = q.filter(stored, q.op(eq, [q.col(stored, "x"), q.param("q", type, "compare")], bool))
	return {
		schema: {
			name: "ConstantColumns",
			relations: [{ name: "V", columns: V.heading, primaryKey: ["k"], keys: [], mutable: false }],
			closed: [],
			containments: []
		},
		facts: { V: [[canonicallySpelled(int(1)), canonicallySpelled(floatLiteral(-0))]] },
		query: {
			dag: normalQuery(
				q.build(
					q.project(
						read,
						[
							["k", "k"],
							["x", "x"],
							["same", [q.op(eq, [q.col(read, "x"), q.col(read, "x")], bool), bool]]
						],
						conservativeMeta
					)
				).dag
			),
			params: { q: { kind: "scalar", type, value: floatLiteral(0) } }
		},
		spelling: { mode: "drawn", edge: false }
	}
}

/** The case of `c`: a union's arrangement (unionCase), or `zero` (zeroCase). */
export const constantColumnsCase = (c: ConstantColumnsCase): QueryCase =>
	c === "zero" ? zeroCase() : unionCase(c)

/**
 * The rows both lowerings deliver of a case, each its first two columns: M's mark at 2 where both arms hold k at 2,
 * every mark where one holds no value, and V's stored row, its -0, where x is equated with q.
 */
export const deliveredRows = (c: ConstantColumnsCase): ReadonlyArray<ReadonlyArray<string>> =>
	c === "zero"
		? [["1", "-0"]]
		: c === "both"
			? [["2", "0"]]
			: [
					["1", "0"],
					["1", "1"],
					["2", "0"],
					["3", "1"]
				]
