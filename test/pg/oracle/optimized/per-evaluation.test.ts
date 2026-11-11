/**
 * The optimized lowering against the conservative lowering on the optimizer's population with the per-evaluation shapes
 * (gen/case.ts perEvaluationGenConfig): correlated takes, correlated variables and lateral constants reading an earlier
 * source, shared right sides, beside the nested attachment chains every attach root may draw, each level under its own
 * per-parent take, among them a child that reads its parent with an attachment of its own, whose key set reads children
 * keyed within one parent only. Its facts hold within one evaluation of a correlated subtree only. Each case runs under a plan
 * perturbation drawn with it (test/support/oracle/perturb.ts), under the optimized artifact compiled for the `snapshot`
 * context against the installation's own evidence catalog, in every per-execution form, against the conservative
 * lowering (support.ts). Its escaped counterexamples are kept cases replayed before its streams (perEvaluationKept). No
 * generated term raises (every partial operation is guarded, gen/compute.ts), so an execution error of any form is a
 * defect.
 */
import { layer } from "@effect/vitest"
import type { Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Formatter, Record } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import {
	casesPerPopulation,
	differential,
	type OptimizedFeature,
	optimizedShrink,
	resolved
} from "#test/pg/oracle/optimized/suite.ts"
import {
	perEvaluationGenConfig,
	type QueryCase,
	queryCaseGen
} from "#test/support/oracle/gen/case.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { aggregateOpId, aggregateResult } from "#test/support/oracle/gen/ops.ts"
import { normalQuery } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, schemaName } from "#test/support/oracle/gen/schema.ts"
import { literalOfValue } from "#test/support/oracle/reference/values.ts"
import { namedPlacement } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	type AggregateSpec,
	type OccurrenceSpec,
	plainRegion,
	Q
} from "#test/unit/lower/conservative/fixtures.ts"
import { acrossParentsCase, withinOneParentCase } from "#test/unit/lower/dedup/cases.ts"

/**
 * What the per-evaluation population must reach: a take correlated per outer row, a region reading an outer column, an
 * attachment nested below another's child, a per-parent take over an attachment, a correlated child under a nested
 * attachment, and a parent key set read without DISTINCT, whose parent rows the differential holds to its claim.
 */
const perEvaluationRequired = [
	"correlated take",
	"correlated region",
	"nested attachment",
	"per-parent take over an attachment",
	"a correlated child under a nested attachment",
	"a key set read without DISTINCT",
	"nonempty"
] as const satisfies ReadonlyArray<OptimizedFeature>

/**
 * The per-evaluation population's escaped counterexamples, kept, each a hand-built query over relations keyed by k:
 *
 * - a region one of whose occurrences only tests that a fact exists while another occurrence's constant reads its
 *   source (a lateral constant, the soundness shapes of gen/query.ts). Demand analysis counted no column a region's own
 *   constants read of its sources as read laterally, so R02 moved the tested occurrence into a semi-join, out of the
 *   constant's scope, and the optimized lowering refused the reference it left ("a column n#4.a of a node in scope"). The region reads R0 and R1 (k, a): R0 holds a = 1 and a = 2, R1 the facts
 *   (1, 1) and (3, 2), and R1's occurrence binds a with its k fixed to R0's a, which keeps a = 1 and excludes a = 2.
 *   The tested occurrence of R0 binds a variable R1's binds too, or binds nothing;
 * - a semi-join of a group with itself on two of its grouping columns (a right side shared with another reader).
 *   Demand analysis counted a node's readers, not its references, so the group read on both sides was the semi-join's
 *   alone, and pushdown.semiGroup moved the semi-join below the group, which then read itself ("an acyclic DAG: the node reaches itself
 *   through its inputs"). R0 (k, a, b) groups into (a, b) = (1, 2), (2, 3)
 *   twice and (3, 5); the semi-join keeps the groups whose a is some group's b, all but (1, 2).
 *
 * Beside them, the page/generated-optimized counterexample at TEST_SEED=28094260 and its twin
 * (test/unit/lower/dedup/cases.ts): a take of one row per parent with an attachment nested below it, whose key set over
 * a holds a key within one parent only and repeats a = 0 across the two parents unless it deduplicates, and the same
 * attachment paired on the column that fixes the parent too, whose key set is proved across parents and read as it is.
 */
const keyed = (name: string, columns: ReadonlyArray<string>): GenRelation => ({
	name,
	columns: Arr.map(columns, (c) => ({ name: c, type: int4 })),
	primaryKey: ["k"],
	keys: [],
	mutable: false
})

const factsOf = (
	rows: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<ReadonlyArray<TypedLiteral>> =>
	Arr.map(rows, (row) => Arr.map(row, (value) => literalOfValue(BigInt(value), int4)))

/** The case of the query `build` makes over the stored relations, each with its facts; `base` reads a relation. */
const keptCase = (
	stored: ReadonlyArray<readonly [GenRelation, ReadonlyArray<ReadonlyArray<number>>]>,
	build: (q: Q, base: (r: GenRelation) => RelNode) => RelNode
): QueryCase => {
	const q = new Q()
	const root = build(q, (r) =>
		q.base({ name: r.name, heading: r.columns, primaryKey: r.primaryKey }, conservativeMeta)
	)
	const dag = normalQuery(q.b.build(Arr.of(root)))
	return {
		schema: {
			name: schemaName,
			relations: Arr.map(stored, ([r]) => r),
			closed: [],
			containments: []
		},
		facts: canonicalFacts(
			Record.fromEntries(Arr.map(stored, ([r, rows]) => [r.name, factsOf(rows)]))
		),
		query: { dag, params: {} },
		spelling: { mode: "drawn", edge: false }
	}
}

/** The region of R0's occurrence `tested` (built over R0's node) and R1's occurrence fixing k to R0's a. */
const lateralConstantCase = (tested: (r0: RelNode) => OccurrenceSpec): QueryCase => {
	const r0 = keyed("R0", ["k", "a"])
	const r1 = keyed("R1", ["k", "a"])
	return keptCase(
		[
			[
				r0,
				[
					[1, 1],
					[2, 2]
				]
			],
			[
				r1,
				[
					[1, 1],
					[3, 2]
				]
			]
		],
		(q, base) => {
			const s0 = base(r0)
			return q.regionWith(
				[tested(s0), { source: base(r1), bind: { a: "a" }, constants: { k: q.col(s0, "a") } }],
				plainRegion
			)
		}
	)
}

/** R0 grouped by (a, b), each group counted, semi-joined with itself on a = b. */
const selfSemiJoinCase = (): QueryCase => {
	const r0 = keyed("R0", ["k", "a", "b"])
	const count: AggregateSpec = {
		name: "n",
		fn: "count",
		op: aggregateOpId("count", undefined),
		args: [],
		type: aggregateResult("count", undefined)
	}
	return keptCase(
		[
			[
				r0,
				[
					[1, 1, 2],
					[2, 2, 3],
					[3, 2, 3],
					[4, 3, 5]
				]
			]
		],
		(q, base) => {
			const groups = q.group(base(r0), ["k", "a", "b"], ["a", "b"], [count], conservativeMeta)
			return q.semi(groups, groups, [["a", "b"]])
		}
	)
}

const perEvaluationKept: ReadonlyArray<Kept<QueryCase, OptimizedFeature>> = [
	{
		note: "an occurrence binding a variable another binds too, whose source the other's constant reads",
		reaches: ["nonempty"],
		draws: "",
		sketch: lateralConstantCase((s0) => ({ source: s0, bind: { a: "a" }, constants: {} }))
	},
	{
		note: "an occurrence binding nothing, whose source another occurrence's constant reads",
		reaches: ["nonempty"],
		draws: "",
		sketch: lateralConstantCase((s0) => ({ source: s0, bind: {}, constants: {} }))
	},
	{
		note: "a semi-join of a group with itself on two of its grouping columns",
		reaches: ["nonempty"],
		draws: "",
		sketch: selfSemiJoinCase()
	},
	{
		note: "page/generated-optimized, TEST_SEED=28094260: a nested key set over children keyed within one parent only",
		reaches: ["a correlated child under a nested attachment", "nonempty"],
		draws: "",
		sketch: withinOneParentCase()
	},
	{
		note: "the TEST_SEED=28094260 case paired on the column that fixes the parent: a nested key set read as it is",
		reaches: ["a correlated child under a nested attachment", "a key set read without DISTINCT"],
		draws: "",
		sketch: acrossParentsCase()
	}
]

layer(Substrate.layer)(
	"the optimized lowering against the conservative lowering, the per-evaluation shapes",
	(it) => {
		it.effect(
			"agrees on the optimizer's population with per-evaluation shapes, raw text sets, with no repeated row",
			(ctx) =>
				searched(
					ctx,
					differential(resolved(queryCaseGen(perEvaluationGenConfig)), namedPlacement("opte"), {
						suite: "optimized/per-evaluation",
						literal: Formatter.format,
						coverage: required<OptimizedFeature>(perEvaluationRequired, {
							cases: casesPerPopulation,
							sense: notesOnly
						}),
						kept: perEvaluationKept,
						runs: casesPerPopulation,
						shrink: optimizedShrink,
						perturb: "all"
					})
				)
		)
	}
)
