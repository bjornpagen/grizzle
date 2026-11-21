/**
 * A workload's read derives each derived relation once per statement (lower/optimize/cte-policy rule 5b, lower/shapes
 * attach and region), whatever PostgreSQL estimates. On PostgreSQL 19, over a ledger shaped as edullm's QTI ledger
 * (read-once.fixtures.ts): every XML element of every package one row of one table, the typed LOM views over the
 * manifests (a package's head, its status, its classification terms, each term a join of eight elements), the current
 * packages and every item of each under each term, and edullm's `sets`, each term a current package states with how
 * many current packages state it and how many items its item set holds.
 *
 * - **once**: packages stored, then as many again and more, the idea terms growing with them, under each statistics
 *   state an analyzed installation is in (read-once.fixtures.ts StatsState: analyzed after each load, after the first
 *   only, empty and then after each load, or after each load over a case rolled back): the terms read (`sets`) answers
 *   the host's count of every term's packages and items, the heads read (`versions`'s classifications) every current
 *   package with its three terms, and every scan either plan runs more than once, of a stored relation or of a CTE it
 *   derived once, handles fewer rows a run than there are packages, so its work grows with what it reads, not with its
 *   square. A parallel scan's leader and workers are one run of it. A never-analyzed installation is outside the
 *   envelope (R1, the runbook analyzes after the first package): there every estimate is one row and PostgreSQL may
 *   read the classifications' eight elements by unparameterized inner scans, 2.5 s at 150 packages, 12.7 s at 450,
 *   where any analyzed state reads them in 37 ms. Before rule 5b a derived relation joined to another stood
 *   as the inner side of a nested loop PostgreSQL re-derived for each outer row, and the attachment's fold restricted
 *   ItemSet to each term inside its grouping, deriving it once per term: edullm's `sets` took six minutes at 206
 *   packages. A derived set joined as a set would be scanned whole for each row of the region's other occurrences, or
 *   their join derived again for each of its rows, so the region reads the rest of itself once per row of the set,
 *   LATERAL by its values (lower/shapes/region keyedByOnce). An attachment's child no fold is read for each parent key
 *   inside, never joined beside its parents' keys, where PostgreSQL derived `versions`'s classifications of every
 *   package once per head (40 s at 183 heads). The one rescan left is the items attachment's, the terms' folds scanned
 *   for each term, which grows with the square of the terms, in memory, never of a stored row. This property kills
 *   neither rule 5b's per-row reads nor the region's chain from a set derived once: without the first these reads'
 *   SQL changes but PostgreSQL plans it within the bound under every analyzed state, and without the second it does not
 *   change, no region of theirs being past the collapse limit (each state's plans measured on a cluster of our own).
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ReadOnceFeature,
	readOnceGen,
	readOnceTemplate,
	runReadOnce,
	statsStates
} from "#test/pg/lower-shapes/read-once.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A workload's read of derived relations reads each scan's rows once per row it joins them to, never every package's
 * again for each, however many packages are stored and however many terms they state.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aWorkloadReadDerivesEachDerivedRelationOncePerStatementSoNoScanReadsEveryPackageForEachRowItJoins =
	property.explore(readOnceGen, {
		needs: { ledger: Substrate.rolledBack(readOnceTemplate) },
		situations: [
			"a package taken away",
			"every package current",
			...statsStates
		] satisfies ReadonlyArray<ReadOnceFeature>,
		check:
			({ ledger }, c) =>
			(drawn) =>
				Effect.flatMap(ledger, ({ connection, bare, value }) =>
					runReadOnce(value, connection, bare, drawn, c)
				),
		oracle: {
			kind: "universal",
			name: "the host's count of every term's current packages and items and of every current package's terms, and bound: every scan either read runs more than once, of a stored relation or of a CTE it derived, reads fewer rows a run than the packages stored, at two sizes, under each analyzed statistics state, a parallel scan's processes one run"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original:
					'\treturn keys.length > 0 && probedByKey(probed, keys) ? { kind: "perKey" } : { kind: "once", rows }',
				replacement: '\treturn { kind: "perKey" }',
				why: "Every attachment's child is read for each parent key, the items attachment's fold restricted to each term inside its grouping though no stored relation's range binds the term, so ItemSet is derived once per term."
			},
			{
				file: "packages/engine/src/lower/shapes/attach/index.ts",
				original: '\tconst inside = attachmentRead(attach).kind === "perKey"',
				replacement:
					'\tconst inside = attachmentRead(attach).kind === "perKey" && foldedByCorrelation(child, attach) !== undefined',
				why: "An attachment's child that is no fold is joined to its parents' keys beside it, so PostgreSQL may plan the heads read's classifications derived for every package once per head, the head's package a filter above them."
			}
		]
	})
