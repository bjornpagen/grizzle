/**
 * What the per-evaluation population must reach: a take correlated per outer row, a region reading an outer column, an
 * attachment nested below another's child, a per-parent take over an attachment, a correlated child under a nested
 * attachment, a parent key set read without DISTINCT, whose parent rows the differential holds to its claim, and a fold
 * attached by a key the attachment pairs with two parent columns, which each evaluation of the fold restricts to both.
 */
import { aimed, type Gen, recorded } from "@bjornpagen/testing/gen"
import { Array as Arr, Record } from "effect"
import { type TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import {
	foldKeyTwiceCase,
	type OptimizedFeature,
	optimizedAims
} from "#test/pg/oracle/optimized/suite.ts"
import {
	perEvaluationGenConfig,
	type QueryCase,
	queryCaseGen
} from "#test/support/oracle/gen/case.ts"
import { canonicallySpelled, int4, type SpelledValue } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { aggregateOpId, aggregateResult } from "#test/support/oracle/gen/ops.ts"
import { normalQuery } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, schemaName } from "#test/support/oracle/gen/schema.ts"
import { literalOfValue } from "#test/support/oracle/reference/values.ts"
import {
	type AggregateSpec,
	type OccurrenceSpec,
	plainRegion,
	Q
} from "#test/unit/lower/conservative/fixtures.ts"
import { acrossParentsCase, withinOneParentCase } from "#test/unit/lower/dedup/cases.ts"
export const perEvaluationRequired = [
	"correlated take",
	"correlated region",
	"nested attachment",
	"per-parent take over an attachment",
	"a correlated child under a nested attachment",
	"a key set read without DISTINCT",
	"a fold key correlated with two parent columns",
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
 *
 * And this population's counterexample at TEST_SEED=1951254937 (its rotating stream's case 107), shrunk by hand: a
 * fold attached on two pairs that name one key of it, on[b=b, d=b] there. The optimized lowering restricted the fold by
 * the last pair alone, so a parent whose b and d differ received the group at its d. Shrunk, it is suite.ts
 * foldKeyTwiceCase over integers: R0 holds (0, 1, 2) and (1, 2, 2), and the parent (0, 1, 2) has no group.
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

/**
 * A region whose occurrence's source another occurrence's region reads laterally, under a semi-join: R0's one region
 * matching R0 and, at its a, a region over R0 correlated to the first R0's a; read by a region beside a third region
 * correlated to the first's a, which the semi-join's root tests each R0 row against. The first region, read once per
 * row of the region that reads it and so held as a CTE (cte-policy rules 3b and 5b), reads no outer value: its holder
 * is its reader's own region, where the outermost region on its chain of dominators that sees every value it reads,
 * vacuously the root's, held its CTE in the root semi-join's SELECT, a WITH its reader's statement read out of scope
 * ("r9 is not a CTE in scope", the per-evaluation population's rotating stream at seed 0x6e1e5955, case 469). R0 holds
 * a = 1 and a = 2.
 */
const lateralReaderCase = (): QueryCase => {
	const r0 = keyed("R0", ["k", "a"])
	return keptCase(
		[
			[
				r0,
				[
					[1, 1],
					[2, 2]
				]
			]
		],
		(q, base) => {
			const first = base(r0)
			const inner = q.regionWith([{ source: base(r0), bind: { a: "a" }, constants: {} }], {
				...plainRegion,
				correlated: [{ name: "at", type: int4, expr: q.col(first, "a") }]
			})
			const read = q.region([
				{ source: first, bind: { a: "a" }, constants: {} },
				{ source: inner, bind: { at: "at" }, constants: {} }
			])
			const beside = q.regionWith([{ source: base(r0), bind: { a: "b" }, constants: {} }], {
				...plainRegion,
				correlated: [{ name: "at", type: int4, expr: q.col(read, "a") }]
			})
			const tested = q.region([
				{ source: read, bind: { a: "a" }, constants: {} },
				{ source: beside, bind: { b: "b" }, constants: {} }
			])
			const all = q.region([{ source: base(r0), bind: { a: "a" }, constants: {} }])
			return q.semi(all, tested, [["a", "a"]])
		}
	)
}

/** An integer stored in its canonical spelling. */
const storedInt = (value: number): SpelledValue =>
	canonicallySpelled(literalOfValue(BigInt(value), int4))

/**
 * The per-evaluation population's escaped counterexamples, each a red it caught, kept by value since no population
 * draws a hand-built query (toolchain-test keep reaches none), recorded beside the population (gen.ts recorded): the two
 * lateral constants' regions, the semi-join of a group with itself, page/generated-optimized's counterexample at
 * TEST_SEED=28094260, the fold attached on two pairs that name one key of it (TEST_SEED=1951254937, case 107), and a
 * region another reads laterally under a semi-join (lateralReaderCase).
 */
const escapedCounterexamples: Arr.NonEmptyReadonlyArray<QueryCase> = [
	lateralConstantCase((s0) => ({ source: s0, bind: { a: "a" }, constants: {} })),
	lateralConstantCase((s0) => ({ source: s0, bind: {}, constants: {} })),
	selfSemiJoinCase(),
	withinOneParentCase(),
	foldKeyTwiceCase(
		int4,
		["a", "b"],
		[
			[storedInt(1), storedInt(2)],
			[storedInt(2), storedInt(2)]
		]
	),
	lateralReaderCase()
]

/**
 * The twin of the TEST_SEED=28094260 counterexample, paired on the column that fixes the parent, whose nested key set is
 * proved across parents and read as it is (test/unit/lower/dedup/cases.ts acrossParentsCase): kept by value since
 * 52b373df8 beside its counterexample, it never failed but under the plant that failed all three, so it is the aim of the
 * situation it reaches, a key set read without DISTINCT, built where a case's turn aims at it.
 */
const acrossParentsAim: Gen<QueryCase> = () => acrossParentsCase()

/**
 * The per-evaluation population beside its escaped counterexamples (escapedCounterexamples), aimed at the situations the
 * drawn populations seldom reach (suite.ts optimizedAims) and at a key set read without DISTINCT (acrossParentsAim).
 */
export const perEvaluationCases = aimed(
	recorded(queryCaseGen(perEvaluationGenConfig), escapedCounterexamples),
	[...optimizedAims, ["a key set read without DISTINCT", acrossParentsAim]]
)
