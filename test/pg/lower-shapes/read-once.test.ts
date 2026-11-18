/**
 * A workload's read derives each derived relation once per statement (lower/optimize/cte-policy rule 5b, lower/shapes
 * attach and region), whatever PostgreSQL estimates. On PostgreSQL 19rc2, over a ledger shaped as edullm's QTI ledger
 * (read-once.fixtures.ts): every XML element of every package one row of one table, the typed LOM views over the
 * manifests (a package's head, its status, its classification terms, each term a join of eight elements), the current
 * packages and every item of each under each term, and edullm's `sets`, each term a current package states with how
 * many current packages state it and how many items its item set holds.
 *
 * - **once**: packages stored and analyzed, then as many again and more, analyzed again, the idea terms growing with
 *   them: the terms read (`sets`) answers the host's count of every term's packages and items, the heads read
 *   (`versions`'s classifications) every current package with its three terms, and every scan either plan runs more
 *   than once, of a stored relation or of a CTE it derived once, handles fewer rows a run than there are packages, so
 *   its work grows with what it reads, not with its square. Before rule 5b a derived relation joined to another stood
 *   as the inner side of a nested loop PostgreSQL re-derived for each outer row, and the attachment's fold restricted
 *   ItemSet to each term inside its grouping, deriving it once per term: edullm's `sets` took six minutes at 206
 *   packages. A derived set joined as a set would be scanned whole for each row of the region's other occurrences, or
 *   their join derived again for each of its rows, so the region reads the rest of itself once per row of the set,
 *   LATERAL by its values (lower/shapes/region keyedByOnce). An attachment's child no fold is read for each parent key
 *   inside, never joined beside its parents' keys, where PostgreSQL derived `versions`'s classifications of every
 *   package once per head (40 s at 183 heads). The one rescan left is the items attachment's, the terms' folds scanned
 *   for each term, which grows with the square of the terms, in memory, never of a stored row.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ReadOnceFeature,
	readOnceGen,
	readOnceTemplate,
	runReadOnce
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
			"every package current"
		] satisfies ReadonlyArray<ReadOnceFeature>,
		check:
			({ ledger }, c) =>
			(drawn) =>
				Effect.flatMap(ledger, ({ connection, value }) => runReadOnce(value, connection, drawn, c)),
		oracle: {
			kind: "universal",
			name: "the host's count of every term's current packages and items and of every current package's terms, and bound: every scan either read runs more than once, of a stored relation or of a CTE it derived, reads fewer rows a run than the packages stored, at two sizes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\tconst perRow = reads === "query" ? readPerRow(d.order) : new Set<RelNode>()',
				replacement: "\tconst perRow = new Set<RelNode>()",
				why: "No derived relation a workload's read reads per row is computed once, so Current stands inside the join of its terms, which PostgreSQL derives again for each, and the items attachment folds ItemSet once per term."
			},
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
			},
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original: "\t\treturn t === 0 ? 0 : once(p.placed.occurrence.source) ? 1 : t === 1 ? 2 : 3",
				replacement: "\t\treturn t === 0 ? 0 : t === 1 ? 2 : 3",
				why: "A region's chain starts at an occurrence with a fixed column, not at the set its statement derives once, so the set is joined further along the chain and scanned whole for each row of the occurrences before it."
			},
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original: "\t\tif (next === undefined || !once(start.occurrence.source)) {",
				replacement: "\t\tif (next === undefined || start === start) {",
				why: "A chain that starts at a set its statement derives once joins the rest of the region to it, so PostgreSQL may derive the rest's join again for each of the set's rows, or scan the set whole for each of the rest's."
			}
		]
	})
