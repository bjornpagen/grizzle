/**
 * The compile-target catalog's rewrites deliver what their compositions deliver, by the reference evaluator, which shares
 * no code with either lowering or with PostgreSQL.
 *
 * Each entry is a composition as an author writes it over the Lab fixture, checked by the real checker, and rewritten by
 * the catalog (R26 to R31, R41, R42): its ordinals, neighbours and as-of probes into windows, its running sums, extrema,
 * means and conditional counts into framed and filtered windows, its shares into partition aggregates, and its
 * percentiles and mode into ordered-set aggregates. Over drawn lab facts (factsGen: small domains, both zeros among the
 * scores, so ties on a group's day and score, groups of one row and empty relations come up), the reference evaluates
 * the composition and the rewritten DAG, and the two deliver one keyed set of rows, statement by statement
 * (rewrite/support.ts agrees). The PostgreSQL agreement of the two lowerings is test/pg/catalog/agreement.test.ts; this
 * is the judge independent of both.
 *
 * Every entry must be judged on some case, never only declined: a composition whose rewrite meets a form the reference
 * cannot state (an aggregate over an empty frame, an ordered-set aggregate over no row, which are NULLs) is unjudged on
 * that case, and an entry unjudged on every case fails the suite.
 *
 * Oracle: the reference evaluator, a second implementation. Features: each entry judged.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { rewriteCatalog } from "#compiler/lower/shapes/catalog/rewrite.ts"
import { succeeded } from "#test/support/assert.ts"
import { factsGen, labOptions, oracleCase } from "#test/support/pg/catalog/support.ts"
import { agrees } from "#test/support/unit/lower/rewrite/support.ts"
import { entries, judged, type JudgedFeature } from "#test/unit/lower/catalog/reference.fixtures.ts"

/**
 * The catalog's rewrites against their compositions, by the reference deliver one keyed set of rows over drawn lab
 * facts.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/lower/catalog/reference.test.ts:56 at 8cad5bce, its runs and its coverage's cases).
 */
export const theCatalogsRewritesAgainstTheirCompositionsByTheReferenceDeliverOneKeyedSetOfRowsOverDrawnLabFacts =
	property.explore(factsGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: judged satisfies ReadonlyArray<Reached<JudgedFeature>>,
		check: (_, c: Case<JudgedFeature>) => (facts) =>
			Effect.sync(() => {
				for (const [label, desc] of entries) {
					const original = oracleCase(label, desc, facts)
					const rewritten = succeeded(rewriteCatalog(original.query.dag, labOptions()), label)
					if (agrees(original, { dag: rewritten.dag, params: [] }) === "agree") {
						c.note(`judged: ${label}`)
					}
				}
			}),
		oracle: { kind: "second-implementation", name: "the reference evaluator" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/catalog/mode.ts",
				original: '\t\torder: { keys: [{ column: value, dir: "asc" }] },',
				replacement: '\t\torder: { keys: [{ column: value, dir: "desc" }] },',
				why: "R31's rewrite (mode.ts) takes the mode's ordered-set aggregate over the value descending; the search fails."
			}
		]
	})
