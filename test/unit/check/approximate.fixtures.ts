/**
 * approximateNearest (check/approximate): which searches are eligible, and which results they make approximate.
 *
 * - **Eligibility:** a search is admitted exactly when its one rule, read once per execution, ranks by a query
 *   vector's cosine distance to a stored vector HNSW can index, its `by` naming a column and its `take` a positive
 *   integer; every other search is refused for one of the reasons its broken rules name (test/unit/check/approximate.ts),
 *   and an admitted one seals one search node.
 * - **Provenance:** a page over a result, and a derived definition of it, are misuses exactly when a search lies among
 *   what the result is computed from, whatever lies between.
 *
 * Oracles: the eligibility rule restated over the drawn search; a result is approximate exactly when it is computed
 * from a search.
 *
 * Features: each broken rule, each reading refused or admitted, a vector at HNSW's bound, and each composition.
 */

import { aimed, type Aimed } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { NodeOf, RelDag } from "#compiler/ir/rel.ts"
import {
	admittedGen,
	type Reading,
	type SearchCase,
	searchCaseGen,
	type SearchRule
} from "#test/unit/check/approximate.ts"

/** The sealed search nodes of a checked query. */
export const searches = (dag: RelDag): ReadonlyArray<NodeOf<"ApproximateNearest">> =>
	Arr.filter(
		topoOrder(dag),
		(n): n is NodeOf<"ApproximateNearest"> => n.kind === "ApproximateNearest"
	)

/** The readings of a search inside an attachment's child. */
type AttachedReading = Extract<
	Reading,
	"an attachment filtering by its parent" | "an attachment binding its parent"
>

/** What an eligibility case reached: the rules it broke, a reading refused or admitted, a vector at HNSW's bound. */
export type EligibilityFeature =
	| SearchRule
	| `refused, ${AttachedReading}`
	| `admitted, ${Extract<Reading, "the query" | "an import bound to a parameter">}`
	| "admitted at HNSW's bound"

export const rules: Arr.NonEmptyReadonlyArray<SearchRule> = [
	"by naming no column",
	"a bound that is no positive integer",
	"a source read per parent row",
	"a source read per outer row",
	"a score that is no query distance",
	"a union",
	"an aggregate",
	"an indexed vector past HNSW's bound",
	"by naming another column"
]

/** The searches, aimed at a search admitted under each reading that admits one, which a free draw seldom makes. */
export const searchCaseSpace: Aimed<SearchCase, EligibilityFeature> = aimed(searchCaseGen, [
	["admitted, the query", admittedGen("the query")],
	["admitted, an import bound to a parameter", admittedGen("an import bound to a parameter")]
])
