/**
 * The parent key sets' kept cases, shared by the key-set suite (test/unit/lower/dedup/key-sets.test.ts), the page
 * runtime suite (test/pg/page/generated.ts) and the optimized differential's per-evaluation population
 * (test/pg/oracle/optimized/per-evaluation.test.ts), so each reads the same IR and facts.
 */
import { Array as Arr } from "effect"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { normalQuery } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, schemaName } from "#test/support/oracle/gen/schema.ts"
import { literalOfValue } from "#test/support/oracle/reference/values.ts"
import { Q } from "#test/unit/lower/conservative/fixtures.ts"

/** A relation of int4 columns keyed by its first, as the oracle generator declares one. */
const keyedOnFirst = (name: string, columns: ReadonlyArray<string>): GenRelation => ({
	name,
	columns: Arr.map(columns, (c) => ({ name: c, type: int4 })),
	primaryKey: Arr.take(columns, 1),
	keys: [],
	mutable: false
})

/**
 * The page/generated-optimized counterexample at TEST_SEED=28094260 (its rotating stream's case 872), over R0(a, b)
 * holding (0, 0) and R1(a) holding 0 and 1, each keyed by a. Over R1, att1 attaches R0 with R0 nested below it, and
 * att2 attaches, for each R1 row p, nested1: the one row of R0 × R1 (a, b, a_2) whose a_2 is p's a, a take of one row
 * per parent, with nested0, R0, attached below it by the pairs `nested0`. Within one parent nested1 delivers one row,
 * so its rows are keyed by a there; across both parents they are (0, 0, 0) and (0, 0, 1), which share a = 0. Paired on
 * a alone, nested0's parent key set over a repeats 0 unless it deduplicates, and a part that reads it as it is delivers
 * each child of 0 twice. Paired on a_2 too, its parent key holds a_2, the column that fixes nested1's parent, and the
 * set is one across parents.
 */
const perParentNested = (nested0: ReadonlyArray<readonly [string, string]>): QueryCase => {
	const r0 = keyedOnFirst("R0", ["a", "b"])
	const r1 = keyedOnFirst("R1", ["a"])
	const q = new Q()
	const every = (r: GenRelation, bind: Readonly<Record<string, string>>): RelNode =>
		q.region([
			{
				source: q.base(
					{ name: r.name, heading: r.columns, primaryKey: r.primaryKey },
					conservativeMeta
				),
				bind,
				constants: {}
			}
		])
	const att1 = q.attach(
		every(r1, { a: "a" }),
		q.attach(
			every(r0, { a: "a", b: "b" }),
			every(r0, { a: "a", b: "b" }),
			"nested0",
			[["a", "a"]],
			"array",
			undefined
		),
		"att1",
		[["a", "a"]],
		"array",
		undefined
	)
	const parent = every(r1, { a: "a" })
	const pairs = q.region([
		{
			source: q.base(
				{ name: r0.name, heading: r0.columns, primaryKey: r0.primaryKey },
				conservativeMeta
			),
			bind: { a: "a", b: "b" },
			constants: {}
		},
		{
			source: q.base(
				{ name: r1.name, heading: r1.columns, primaryKey: r1.primaryKey },
				conservativeMeta
			),
			bind: { a: "a_2" },
			constants: {}
		}
	])
	const perParent = q.take(
		q.attach(pairs, every(r0, { a: "a", b: "b" }), "nested0", nested0, "array", undefined),
		{
			keys: [
				{ column: "a", dir: "asc" },
				{ column: "b", dir: "asc" }
			]
		},
		{ kind: "literal", k: 1n },
		[{ column: "a_2", expr: q.col(parent, "a") }],
		conservativeMeta
	)
	const att2 = q.attach(
		att1,
		q.attach(parent, perParent, "nested1", [["a", "a_2"]], "array", undefined),
		"att2",
		[["a", "a"]],
		"array",
		undefined
	)
	const fact = (row: ReadonlyArray<number>) =>
		Arr.map(row, (value) => literalOfValue(BigInt(value), int4))
	return {
		schema: { name: schemaName, relations: [r0, r1], closed: [], containments: [] },
		facts: canonicalFacts({ R0: [fact([0, 0])], R1: [fact([0]), fact([1])] }),
		query: { dag: normalQuery(q.b.build(Arr.of(att2))), params: {} },
		spelling: { mode: "drawn", edge: false }
	}
}

/** perParentNested with nested0 paired on a alone: its key set over a repeats 0 across parents. */
export const withinOneParentCase = (): QueryCase => perParentNested([["a", "a"]])

/** perParentNested with nested0 paired on a and a_2: its key set holds the column that fixes its parent. */
export const acrossParentsCase = (): QueryCase =>
	perParentNested([
		["a", "a"],
		["a_2", "b"]
	])
