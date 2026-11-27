import { Array as Arr } from "effect"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import {
	generatedRules,
	type OptimizedFeature,
	rewriteFamilies
} from "#test/pg/oracle/optimized/suite.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { canonicallySpelled, int4 } from "#test/support/oracle/gen/domain.ts"
import { aggregateOpId, aggregateResult } from "#test/support/oracle/gen/ops.ts"
import { normalQuery } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, schemaName } from "#test/support/oracle/gen/schema.ts"
import { literalOfValue } from "#test/support/oracle/reference/values.ts"
import { type AggregateSpec, Q } from "#test/unit/lower/conservative/fixtures.ts"

/**
 * The features the optimizer's population must reach, beyond the rules: pipelined attachments and heading groups run
 * (no attachment over exact parents fuses; the one that fuses, over approximate parents, is variants.test.ts's),
 * relation parameters also travel by VALUES, computed terms are evaluated, a fold is attached by a key the attachment
 * pairs with two parent columns, and cases deliver rows.
 */
export const optimizerSituations = [
	...generatedRules,
	...rewriteFamilies,
	"pipelined attachment",
	"heading groups",
	"computed term",
	"nested attachment",
	"per-parent take over an attachment",
	"a fold key correlated with two parent columns",
	"nonempty"
] as const satisfies ReadonlyArray<OptimizedFeature>

/** A relation of integer columns keyed by k. */
const keyed = (name: string, columns: ReadonlyArray<string>): GenRelation => ({
	name,
	columns: Arr.map(columns, (c) => ({ name: c, type: int4 })),
	primaryKey: ["k"],
	keys: [],
	mutable: false
})

/** An integer row in its canonical spelling. */
const row = (values: ReadonlyArray<number>) =>
	Arr.map(values, (v) => canonicallySpelled(literalOfValue(BigInt(v), int4)))

/**
 * The optimizer population's counterexample at its steered phase's case 411 (seed 0x97ccc399), shrunk by hand: a
 * parent column paired with two child columns, on[b=b, b=c], over a child no declared-key prefix binds at b and c, so
 * the attachment's child is read whole and joined to its parent keys at every pair (cte-policy attachmentRead `whole`,
 * lower/shapes/attach pipelinedAttachment), where the co-group it replaced keyed each parent column by the first child
 * column paired with it, so a parent received every child row at its b whatever its c. The parent is R0's b, 1 and 2; the child is R1's (b, c): (1, 1), (1, 2) and (2, 1). Only (1, 1)
 * equals a parent at both pairs, the parent 1; the parent 2 has no child row.
 */
const parentPairedTwiceCase = (): QueryCase => {
	const r0 = keyed("R0", ["k", "b"])
	const r1 = keyed("R1", ["k", "b", "c"])
	const q = new Q()
	const base = (r: GenRelation) =>
		q.base({ name: r.name, heading: r.columns, primaryKey: r.primaryKey }, conservativeMeta)
	const parent = q.region([{ source: base(r0), bind: { b: "b" }, constants: {} }])
	const child = q.region([{ source: base(r1), bind: { b: "b", c: "c" }, constants: {} }])
	const root = q.attach(
		parent,
		child,
		"paired",
		[
			["b", "b"],
			["b", "c"]
		],
		"array",
		undefined
	)
	return {
		schema: { name: schemaName, relations: [r0, r1], closed: [], containments: [] },
		facts: {
			R0: [row([0, 1]), row([1, 2])],
			R1: [row([0, 1, 1]), row([1, 1, 2]), row([2, 2, 1])]
		},
		query: { dag: normalQuery(q.b.build(Arr.of(root))), params: {} },
		spelling: { mode: "drawn", edge: false }
	}
}

/** The fold a per-key case attaches: its count. */
const counted: AggregateSpec = {
	name: "n",
	fn: "count",
	op: aggregateOpId("count", undefined),
	args: [],
	type: aggregateResult("count", undefined)
}

/**
 * A fold's key paired with two parent columns, read per key: R1, keyed by (k, v), counted by k, attached to R0's (a, b)
 * on[a=k, b=k], whose pairs a declared-key prefix binds, R1's k, so the fold is read for each parent key with k
 * restricted below its aggregate to both (cte-policy attachmentRead `perKey`, lower/shapes/attach keyedRows). The
 * population's aimed fold (suite.ts foldKeyTwiceCase) folds by a column no declared key leads, so since DECIDE8 its
 * attachment is co-grouped, and none of its cases reached the per-key fold. The parents are (1, 1) and (1, 2), R1 holds
 * (1, 1), (1, 2) and (2, 1): the parent (1, 1) has the group of 1, counted 2, and (1, 2) none, since one key cannot
 * equal both.
 */
const foldKeyTwicePerKeyCase = (): QueryCase => {
	const r0 = keyed("R0", ["k", "a", "b"])
	const r1: GenRelation = { ...keyed("R1", ["k", "v"]), primaryKey: ["k", "v"] }
	const q = new Q()
	const base = (r: GenRelation) =>
		q.base({ name: r.name, heading: r.columns, primaryKey: r.primaryKey }, conservativeMeta)
	const parent = q.region([{ source: base(r0), bind: { a: "a", b: "b" }, constants: {} }])
	const fold = q.group(
		q.region([{ source: base(r1), bind: { k: "k", v: "v" }, constants: {} }]),
		["k", "v"],
		["k"],
		[counted],
		conservativeMeta
	)
	const root = q.attach(
		parent,
		fold,
		"folded",
		[
			["a", "k"],
			["b", "k"]
		],
		"array",
		undefined
	)
	return {
		schema: { name: schemaName, relations: [r0, r1], closed: [], containments: [] },
		facts: {
			R0: [row([0, 1, 1]), row([1, 1, 2])],
			R1: [row([1, 1]), row([1, 2]), row([2, 1])]
		},
		query: { dag: normalQuery(q.b.build(Arr.of(root))), params: {} },
		spelling: { mode: "drawn", edge: false }
	}
}

/**
 * The optimizer population's escaped counterexamples, each a red it caught, kept by value since no population draws a
 * hand-built query, recorded beside the population (gen.ts recorded): the parent column paired with two child columns
 * of a co-grouped attachment (parentPairedTwiceCase); and beside it the per-key fold whose key two parent columns pair
 * (foldKeyTwicePerKeyCase), which no drawn case reaches since the aimed one is co-grouped.
 */
export const optimizerCounterexamples: Arr.NonEmptyReadonlyArray<QueryCase> = [
	parentPairedTwiceCase(),
	foldKeyTwicePerKeyCase()
]
