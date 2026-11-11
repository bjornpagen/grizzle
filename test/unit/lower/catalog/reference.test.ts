/**
 * The compile-target catalog's rewrites deliver what their compositions deliver, by the reference evaluator, which shares
 * no code with either lowering or with PostgreSQL.
 *
 * Each entry is a composition as an author writes it over the Lab fixture, checked by the real checker, and rewritten by
 * the catalog (R26 to R31, R41, R42): its ordinals, neighbours and as-of probes into windows, its running sums, extrema,
 * means and conditional counts into framed and filtered windows, its shares into partition aggregates, and its
 * percentiles and mode into ordered-set aggregates. Over drawn lab facts (factsGen: small domains, so ties on a group's
 * day and score, groups of one row and empty relations come up), the reference evaluates the composition and the
 * rewritten DAG, and the two deliver one keyed set of rows, statement by statement (rewrite/support.ts agrees). The
 * PostgreSQL agreement of the two lowerings is test/pg/catalog/agreement.test.ts; this is the judge independent of both.
 *
 * Every entry must be judged on some case, never only declined: a composition whose rewrite meets a form the reference
 * cannot state (an aggregate over an empty frame, an ordered-set aggregate over no row, which are NULLs) is unjudged on
 * that case, and an entry unjudged on every case fails the suite.
 *
 * Oracle: the reference evaluator, a second implementation. Features: each entry judged.
 *
 * Plant, failing the search: the mode's ordered-set aggregate taken over the value descending (catalog-mode-order).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { rewriteCatalog } from "#compiler/lower/shapes/catalog/rewrite.ts"
import * as Q from "#test/pg/catalog/queries.ts"
import { factsGen, labOptions, oracleCase } from "#test/pg/catalog/support.ts"
import { succeeded } from "#test/support/assert.ts"
import type { QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { agrees } from "#test/unit/lower/rewrite/support.ts"

/** The entries, one per target form the catalog lowers to. */
const entries: Arr.NonEmptyReadonlyArray<readonly [label: string, desc: QueryDesc]> = [
	["ordinal asc", Q.ordinal(["asc", "asc"])],
	["ordinal day desc, id asc", Q.ordinal(["desc", "asc"])],
	["running aggregates", Q.running(Q.plainSelfMatch)],
	["successor bound", Q.boundNeighbor("next", [])],
	["as-of le bound", Q.boundAsOf("le", [], "day")],
	["grouped share", Q.groupedShare("Sitting", false)],
	["keyed share", Q.keyedShare(false)],
	["discrete percentile", Q.discretePercentile([0.5], Q.ordinalStage)],
	["continuous percentile", Q.continuousPercentile(0.5, "score")],
	["mode of days", Q.modeOfDays("asc", Q.plainMode)]
]

type JudgedFeature = `judged: ${string}`

const judged: Arr.NonEmptyReadonlyArray<JudgedFeature> = Arr.map(
	entries,
	([label]): JudgedFeature => `judged: ${label}`
)

describe("the catalog's rewrites against their compositions, by the reference", () => {
	it.effect("deliver one keyed set of rows over drawn lab facts", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/lower/catalog/reference",
					draw: drawn(factsGen),
					literal: Formatter.format,
					coverage: required<JudgedFeature>(judged, { cases: 60, sense: notesOnly }),
					kept: [],
					runs: 60,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					oracle: { kind: "second-implementation", name: "the reference evaluator" }
				},
				(facts, c) =>
					Effect.sync(() => {
						for (const [label, desc] of entries) {
							const original = oracleCase(label, desc, facts)
							const rewritten = succeeded(rewriteCatalog(original.query.dag, labOptions), label)
							if (agrees(original, { dag: rewritten.dag, params: [] }) === "agree") {
								c.note(`judged: ${label}`)
							}
						}
					})
			)
		)
	)
})
