/**
 * A hybrid search on PostgreSQL 19 with pgvector 0.8.7 (hybrid.fixtures.ts): a lesson catalog's nearest candidates by a
 * query vector and its full text candidates by a web search's text, each under one route's filters, a subject's
 * equality, a grade's range, an app's equality and an intervention's or both's, fused by reciprocal rank in one query of
 * grizzle's language, which one statement answers. A step reads both arms and the hybrid as one record, one statement,
 * so the hybrid is judged against its arms' answers in the very statement that fused them.
 *
 * - The nearest arm: every candidate is a lesson the route admits, at its exact cosine distance, each once; and the arm
 *   fills its bound up to the lessons the route admits, so the filters beside the search lose no candidate: under
 *   hnsw.iterative_scan = strict_order the scan goes on past the lessons the filters refuse until the bound is filled,
 *   the catalog far within hnsw.max_scan_tuples, and strict order's drops never left a route of these catalogs short
 *   (hybrid.fixtures.ts mostLessons, measured).
 * - The full text arm: each candidate once, a lesson the route admits, the best ranked first, ties by lesson; its
 *   matches and ranks are PostgreSQL's own parse's (search.test.ts).
 * - The hybrid: each lesson of either arm with its score, Σ 1 / (k + place) over the arms that hold it, best first, ties
 *   by lesson, the first `take`, its places the nearest arm's candidates by distance, ties by lesson (a search answers a
 *   set of candidates, which the record delivers by key), and the text arm's order; the record is one statement, and
 *   so is the hybrid served alone.
 *
 * Oracle: PostgreSQL's reading of the stored rows under the route's filters with pgvector's own cosine_distance, in no
 * index's order, for the nearest arm's eligible universe; the reference fusion of the record's two arms on the host, in
 * IEEE doubles; and the served members' executed plans for the statement counts and the HNSW index's use.
 *
 * Features: a route some lessons pass and one none does, an arm that fills its bound beside the filters, a nearest arm
 * the HNSW index serves, a fused lesson both arms hold, and a take that cuts the fusion short.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	analyzed,
	armTake,
	Catalog,
	eligible,
	type HybridCase,
	hybridCaseGen,
	hybridFacts,
	hybridInstall,
	hybridTemplate,
	referenceFusion,
	servedByHnsw,
	vectorOf
} from "#test/pg/search/hybrid.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** What a hybrid case reached. */
type HybridFeature =
	| "a route some lessons pass"
	| "a route no lesson passes"
	| "a nearest arm filled beside the range filter"
	| "a lesson both arms hold"
	| "a take that cuts the fusion short"
	| "a nearest arm served by the HNSW index"

/**
 * A hybrid search fuses its arms by reciprocal rank in one statement, each arm the route's own candidates, the nearest filling its bound beside the route's filters.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/search/hybrid.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/search/hybrid.test.ts` at its budget before,
 *   `{ runs: 16, steered: 48 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the
 *   red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path
 *   in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on case 1 of its floor stream
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 2 cases: 5; no headroom: a
 *   kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const aHybridSearchFusesItsArmsByReciprocalRankInOneStatementEachArmTheRoutesOwnCandidatesTheNearestFillingItsBoundBesideTheRoutesFilters =
	property.explore(hybridCaseGen, {
		needs: { fixture: Substrate.fresh(hybridTemplate) },
		situations: [
			"a route some lessons pass",
			"a route no lesson passes",
			"a nearest arm filled beside the range filter",
			"a lesson both arms hold",
			"a take that cuts the fusion short",
			"a nearest arm served by the HNSW index"
		] satisfies ReadonlyArray<Reached<HybridFeature>>,
		budget: { runs: 5, steered: 48 },
		check:
			({ fixture }, k: Case<HybridFeature>) =>
			(c: HybridCase) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(Catalog, hybridFacts(c), hybridInstall, taken)
							yield* analyzed(o.installed)
							const { session } = yield* Substrate
							const reference = yield* session({ ...ownerSession(), label: "hybrid reference" })
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								for (const probe of c.probes) {
									const at = `${c.lessons} lessons of ${c.subjects} subjects and ${c.apps} apps at ${Formatter.format(probe)}`
									const vector = vectorOf(probe.vector)
									const input = {
										params: {
											"nearest.subject": probe.subject,
											"nearest.grade": probe.grade,
											"nearest.app": probe.app,
											"nearest.intervention": probe.intervention,
											"nearest.vector": vector,
											"text.subject": probe.subject,
											"text.grade": probe.grade,
											"text.app": probe.app,
											"text.intervention": probe.intervention,
											"text.q": probe.q,
											"hybrid.subject": probe.subject,
											"hybrid.grade": probe.grade,
											"hybrid.app": probe.app,
											"hybrid.intervention": probe.intervention,
											"hybrid.vector": vector,
											"hybrid.q": probe.q,
											"hybrid.take": probe.take
										},
										facts: {}
									}
									const [record, ...more] = yield* db.workload.step.once(input)
									assert.equal(more.length, 0, `${at}: a record is one row`)
									if (record === undefined) {
										return assert.fail(`${at}: a record is one row, not none`)
									}
									const universe = yield* eligible(reference, o.installed, probe)
									const distances = new Map(Arr.map(universe, (row) => [row[0], row[1]] as const))
									/** The arm's candidates in the order its places count, nearest first, ties by lesson: a search answers a set, which the record delivers by key. */
									const nearRows = Arr.sort(
										record.nearest,
										(a: (typeof record.nearest)[number], b: (typeof record.nearest)[number]) =>
											a.distance !== b.distance
												? a.distance < b.distance
													? -1
													: 1
												: a.lesson < b.lesson
													? -1
													: a.lesson > b.lesson
														? 1
														: 0
									)
									assert.equal(
										new Set(Arr.map(nearRows, (r) => r.lesson)).size,
										nearRows.length,
										`${at}: each candidate once`
									)
									for (const row of nearRows) {
										assert.equal(
											distances.get(`${row.lesson}`),
											`${row.distance}`,
											`${at}: lesson ${row.lesson} the route admits, at its exact distance`
										)
									}
									assert.equal(
										nearRows.length,
										Math.min(armTake, universe.length),
										`${at}: the nearest arm fills its bound up to the lessons the route admits, losing none to the filters`
									)
									k.note(
										universe.length > 0 ? "a route some lessons pass" : "a route no lesson passes"
									)
									if (universe.length > armTake) {
										k.note("a nearest arm filled beside the range filter")
									}
									const textRows = record.text
									assert.equal(
										new Set(Arr.map(textRows, (r) => r.lesson)).size,
										textRows.length,
										`${at}: each text candidate once`
									)
									for (const row of textRows) {
										assert.ok(
											distances.has(`${row.lesson}`),
											`${at}: text candidate ${row.lesson} a lesson the route admits`
										)
									}
									assert.deepEqual(
										textRows,
										Arr.sort(
											textRows,
											(a: (typeof textRows)[number], b: (typeof textRows)[number]) =>
												a.rank !== b.rank
													? a.rank > b.rank
														? -1
														: 1
													: a.lesson < b.lesson
														? -1
														: a.lesson > b.lesson
															? 1
															: 0
										),
										`${at}: the best ranked first, ties by lesson`
									)
									const expected = referenceFusion([nearRows, textRows], probe.take)
									const got: ReadonlyArray<{ readonly lesson: number; readonly score: number }> =
										Arr.map(record.hybrid, (r) => ({ lesson: r.lesson, score: r.score }))
									assert.deepEqual(
										got,
										expected,
										`${at}: the hybrid is its arms' reciprocal rank fusion`
									)
									const both = new Set(Arr.map(textRows, (r) => r.lesson))
									if (Arr.some(nearRows, (r) => both.has(r.lesson))) {
										k.note("a lesson both arms hold")
									}
									if (
										record.hybrid.length <
										new Set([...Arr.map(nearRows, (r) => r.lesson), ...both]).size
									) {
										k.note("a take that cuts the fusion short")
									}
									const executed = yield* db.workload.step.explainAnalyze(input)
									assert.equal(executed.length, 1, `${at}: the record is one statement`)
									if (servedByHnsw(o.installed, executed)) {
										k.note("a nearest arm served by the HNSW index")
									}
									const alone = yield* db.workload.hybrid.explainAnalyze({
										params: {
											subject: probe.subject,
											grade: probe.grade,
											app: probe.app,
											intervention: probe.intervention,
											vector,
											q: probe.q,
											take: probe.take
										},
										facts: {}
									})
									assert.equal(alone.length, 1, `${at}: the hybrid is one statement`)
								}
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the route's lessons by PostgreSQL's reading of the stored rows and pgvector's cosine_distance, and the host's fusion of the record's arms"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/approximate/policy.ts",
				original: '\titerativeScan: "strict_order"',
				replacement: '\titerativeScan: "off"',
				why: "The login's searches scan no further than hnsw.ef_search's candidates, which the route's filters then cut, so a nearest arm the HNSW index serves underfills its bound though the route admits more lessons (hybrid.fixtures.ts mostLessons: off underfilled 113 of 40,000 routes, measured)."
			},
			{
				file: "packages/engine/src/lower/shapes/vector/index.ts",
				original: "orderBy: [asc(distance)], limit: streamBound() },",
				replacement: "orderBy: [], limit: undefined },",
				why: "The approximate read unfenced: its stream a plain scan PostgreSQL pulls up, so the route's filters, priced by the declared statistics, choose the read, and no nearest arm of a large case is served by the HNSW index."
			}
		]
	})
