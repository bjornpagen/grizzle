/** What held-region.test.ts reads: its box, a case's DAG, and the shared restriction run over it. */

import { assert } from "@bjornpagen/testing/assert"
import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { storedColumn } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { sharedPushdownPass } from "#compiler/lower/optimize/pushdown/shared.ts"
import { succeeded } from "#test/support/assert.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { Edge, plainRegion, Q, T } from "#test/unit/lower/conservative/fixtures.ts"
import {
	ledgerCatalog,
	lowersConservatively,
	passContext,
	queryOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/** How many lateral regions of the outer region read the readers of the shared scan: one, two or three. */
export type Laterals = 1 | 2 | 3

const lateralCases: Gen<Laterals> = element([1, 2, 3] as const)

export const lateralsGen = finite(lateralCases)

/**
 * A case's DAG: the outer region W over Edge, binding `w`, and `laterals` regions each correlated to W's `w` by a
 * variable no occurrence of its own binds, each reading the two readers of one scan of Edge, each reader a region
 * correlated to W's `w` at the scan's `src`, so every reader keeps the scan at W's `w`, a value per evaluation of W
 * (lower/optimize/pushdown/shared.ts keptRows). Every lateral region's subtree holds both readers; one alone dominates
 * them, every path from the root to them passing through it, only where it is the one lateral region, as an import two
 * steps read at one key shares its readers between them.
 */
const caseOf = (laterals: Laterals): LogicalQuery => {
	const q = new Q()
	const outer = q.b.reserve()
	const w = () => q.b.expr(storedColumn(outer, "w", T.int4))
	const scan = q.base(Edge, conservativeMeta)
	const reader = (v: string) =>
		q.regionWith([{ source: scan, bind: { src: v, dst: `${v}d` }, constants: {} }], {
			...plainRegion,
			correlated: [{ name: v, type: T.int4, expr: w() }]
		})
	const first = reader("r")
	const second = reader("s")
	const lateral = (j: number) =>
		q.regionWith(
			[
				{ source: first, bind: { r: `r${j}`, rd: `rd${j}` }, constants: {} },
				{ source: second, bind: { s: `s${j}`, sd: `sd${j}` }, constants: {} }
			],
			{ ...plainRegion, correlated: [{ name: `k${j}`, type: T.int4, expr: w() }] }
		)
	const region = q.regionWith(
		[
			{ source: q.base(Edge, conservativeMeta), bind: { src: "w", dst: "wd" }, constants: {} },
			...Arr.map(
				Array.from({ length: laterals }, (_, j) => j),
				(j) => ({
					source: lateral(j),
					bind: { [`rd${j}`]: `x${j}` },
					constants: {}
				})
			)
		],
		{ ...plainRegion, id: { kind: "reserved", id: outer } }
	)
	return queryOf(q.build(region).dag, [])
}

/**
 * The shared restriction run over case `laterals`: the DAG it leaves, valid (the tests' strict re-reader, every column
 * a node reads a node in its scope) and lowered, and how many restrictions it placed.
 */
export const restricted = (laterals: Laterals): number => {
	const ran = succeeded(
		runPasses(
			caseOf(laterals),
			[sharedPushdownPass],
			passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
		),
		`the shared restriction over ${laterals} lateral regions`
	)
	validateDag(ran.query.dag)
	lowersConservatively(ran.query, emptyCodebook)
	const placed = Arr.filter(ran.certificates, (c) => c.rule === "pushdown.shared").length
	assert.ok(placed <= 1, "one shared scan, restricted once at most")
	return placed
}
