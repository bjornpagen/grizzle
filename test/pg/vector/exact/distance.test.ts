/**
 * Exact cosine distance on PostgreSQL 19 and the pinned pgvector.
 *
 * - Exact: over a population drawn once from the label's floor stream and installed with an HNSW index present once per
 *   member (distance.fixtures.ts searchTemplate), for every account and a probe that is a
 *   stored embedding, a drawn vector or one at a norm bound, the scored statements of both artifacts deliver exactly
 *   the eligible facts at their native distances, each once, the ordered ones in distance-then-key order, ties by the
 *   key; with sequential scans disabled, no exact statement plans the HNSW index (while an ORDER BY ... LIMIT over the
 *   view does, the premise); and approximateNearest's conservative form is the exact top five.
 * - Cosine domain: across the admitted cosine domain, at few dimensions, the HNSW limit and the storage limit, every
 *   pair's distance is finite and in [0, 2], exactly 0, 2 and 1 for identical, opposite and orthogonal pairs, whose
 *   float32 sums pgvector accumulates alike; and vector_norm agrees with the host's norm within its derived bound
 *   (test/pg/vector/support.ts normTolerance).
 * - Norm CHECK: the column's CHECK admits exactly the native cosine domain, and the host's norm and codec agree with it
 *   away from the bounds.
 * - Norm: the host's norm agrees with vector_norm on generated binary32 vectors within its derived bound.
 *
 * Oracle: PostgreSQL itself: the eligible facts' native cosine_distance from a scan no index orders, the eligibility
 * applied on the host; the specification of cosine distance's range and its exact values; vector_norm and the CHECK.
 *
 * Features: each probe kind, a tie ordered by the key, each width and pair kind, each side of each norm bound.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { planIndexNames } from "#bench/harness/explain.ts"
import { type CodecFault } from "#compiler/core/errors.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { Vector } from "#compiler/public/fields.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/scalar/values/fault.ts"
import {
	at,
	binary32Vectors,
	byDistanceThenKey,
	checkCases,
	type CheckFeature,
	directionOf,
	expectNormAgrees,
	hnsw,
	id,
	nearestStatement,
	oracle,
	pairCases,
	type PairFeature,
	pairOf,
	probeCases,
	type ProbeFeature,
	probeFeatureOf,
	probeOf,
	rawText,
	runRaw,
	searchSpecs,
	searchTemplate,
	searchWorlds,
	sortedTexts,
	textOf,
	vectorType,
	widthFeatureOf,
	widthRelations,
	widthsTemplate,
	widthsWorld
} from "#test/pg/vector/exact/distance.fixtures.ts"
import { normTolerance } from "#test/pg/vector/support.ts"
import { assert, contains, defined, lacks } from "#test/support/assert.ts"
import { namesOf, roleNamesOf } from "#test/support/kernel/naming.ts"
import { expectConstraint } from "#test/support/substrate/expect.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { codecOf } from "#test/unit/codec/support.ts"

/**
 * The scored statements of both artifacts deliver exactly the eligible facts at their native distances, the ordered ones
 * in distance-then-key order, no exact statement plans the HNSW index, and approximateNearest's conservative form is the
 * exact top five, each case on the worker's seat of the loaded search fixture.
 *
 * Its pre-conversion budget: runs 12, coverage cases 16 (test/pg/vector/exact/distance.test.ts at cc41e3231).
 */
export const equalsTheCompleteExactOracleWithAnHnswIndexPresentNeverPlansTheAnnPathAndTiesByTheKey =
	property.explore(probeCases, {
		needs: { search: Substrate.seat(searchTemplate) },
		situations: [
			"a stored embedding",
			"a drawn probe",
			"a probe at a norm bound",
			"a tie ordered by the key"
		] satisfies ReadonlyArray<Reached<ProbeFeature>>,
		check:
			({ search }, k: Case<ProbeFeature>) =>
			({ account, probe: sketch }) =>
				Effect.scoped(
					Effect.flatMap(search, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const installed = seat.value
								const searcher = yield* s.session({
									...worldSession(installed.world(searchWorlds.searcher)),
									label: "searcher"
								})
								const specs = searchSpecs(installed)
								k.note(probeFeatureOf[sketch.kind])
								const probe = probeOf(sketch)
								const params = { account, vector: probe }
								const { eligible, all } = yield* oracle(installed.schema, account, probe)
								assert.ok(eligible.length > 10)
								const expected = Arr.sort(eligible, byDistanceThenKey)
								for (const [d] of expected) {
									const value = Number(d)
									assert.equal(Number.isFinite(value) && value >= 0 && value <= 2, true)
								}
								if (Arr.some(expected, (r, i) => i > 0 && expected[i - 1]?.[0] === r[0])) {
									k.note("a tie ordered by the key")
								}
								for (const spec of specs.scored) {
									/** Heading order is distance, document, revision (the checker's canonical column order). */
									const rows = yield* runRaw(searcher, spec, params, "")
									assert.deepEqual(sortedTexts(rows), sortedTexts(expected))
									assert.equal(new Set(Arr.map(rows, (r) => Arr.join(r, "|"))).size, rows.length)
								}
								for (const spec of specs.ordered) {
									const rows = yield* runRaw(searcher, spec, params, "")
									assert.deepEqual(
										rows,
										Arr.map(expected, (r) => [...r])
									)
								}
								yield* searcher.values("SET enable_seqscan = off", [])
								for (const spec of Arr.appendAll(specs.scored, specs.ordered)) {
									const [plan] = yield* runRaw(searcher, spec, params, "EXPLAIN (FORMAT JSON) ")
									lacks(planIndexNames(defined(plan, "the EXPLAIN row")[0]), hnsw)
								}
								const [annPlan] = yield* searcher.values(
									`EXPLAIN (FORMAT JSON) SELECT "document" FROM ${roleNamesOf(installed, searchWorlds.searcher).view("DocumentEmbedding")} ORDER BY "value" OPERATOR("vector_ext".<=>) $1::text::"vector_ext"."vector"(4) LIMIT 5`,
									[textOf(probe)]
								)
								contains(planIndexNames(defined(annPlan, "the EXPLAIN row")[0]), hnsw)
								yield* searcher.values("RESET enable_seqscan", [])
								/** approximateNearest's conservative form: the exact top five of every stored embedding. */
								const nearest = yield* s.admin.queryValues(
									`SELECT t."distance"::text, t."document"::text, t."revision"::text FROM (${nearestStatement(installed).sql.text}) AS t`,
									[textOf(probe)]
								)
								const top = Arr.sort(all, byDistanceThenKey).slice(0, 5)
								assert.deepEqual(
									sortedTexts(Arr.map(nearest, (r) => Arr.map(r, String))),
									sortedTexts(top)
								)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "every stored embedding's native cosine_distance from a scan no index orders, the eligibility applied on the host"
		},
		show: Formatter.format,
		budget: { runs: 12, steered: 16 },
		kept: [],
		kills: []
	})

/**
 * Every pair's distance is finite and in [0, 2], exactly 0, 2 and 1 for identical, opposite and orthogonal pairs, and
 * vector_norm agrees with the host's norm, across the admitted cosine domain at few dimensions, the HNSW limit and the
 * storage limit, each case on the worker's clone of the base template, which no case writes.
 *
 * Its pre-conversion budget: runs 12, coverage cases 24 (test/pg/vector/exact/distance.test.ts at cc41e3231).
 */
export const isFiniteAndWithin02AcrossTheAdmittedCosineDomainAtFewDimensionsTheHnswLimitAndTheStorageLimit =
	property.explore(pairCases, {
		needs: { substrate: Substrate.installing },
		situations: [
			"few dimensions",
			"the HNSW limit",
			"the storage limit",
			"free",
			"identical",
			"opposite",
			"orthogonal axes"
		] satisfies ReadonlyArray<Reached<PairFeature>>,
		check:
			({ substrate }, k: Case<PairFeature>) =>
			({ dims, pairs }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						k.note(widthFeatureOf(dims))
						const built = Arr.map(pairs, (pair) => {
							k.note(pair.kind)
							return pairOf(dims, pair)
						})
						const payload = jsonText(
							Arr.map(built, (p, ord) => ({ ord, a: textOf(p.a), b: textOf(p.b) }))
						)
						const rows = yield* s.admin.queryValues(
							`SELECT "vector_ext"."cosine_distance"(r.a::"vector_ext"."vector", r.b::"vector_ext"."vector")::text, "vector_ext"."vector_norm"(r.a::"vector_ext"."vector")::text, "vector_ext"."vector_norm"(r.b::"vector_ext"."vector")::text FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, a text, b text) ORDER BY r.ord`,
							[payload]
						)
						assert.equal(rows.length, built.length, `${dims} dimensions`)
						for (const [i, row] of rows.entries()) {
							const d = Number(row[0])
							const p = at(built, i)
							assert.equal(
								Number.isFinite(d) && d >= 0 && d <= 2,
								true,
								`pair ${dims}:${i} gives ${String(row[0])}`
							)
							if (p.distance !== undefined) {
								assert.equal(d, p.distance, `pair ${dims}:${i}`)
							}
							expectNormAgrees(p.a, Number(row[1]), `pair ${dims}:${i} a`)
							expectNormAgrees(p.b, Number(row[2]), `pair ${dims}:${i} b`)
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "cosine distance lies in [0, 2], is 0, 2 and 1 for identical, opposite and orthogonal pairs, and vector_norm agrees with the host's"
		},
		show: Formatter.format,
		budget: { runs: 12, steered: 24 },
		kept: [],
		kills: []
	})

/**
 * The column's CHECK admits exactly the native cosine domain, and away from the bounds the host's norm and codec decide
 * alike, at few dimensions, the HNSW limit and the storage limit, each case on the worker's seat of the widths, its
 * tables emptied after it.
 *
 * Its pre-conversion budget: runs 24, coverage cases 36 (test/pg/vector/exact/distance.test.ts at cc41e3231).
 */
export const theCheckAdmitsExactlyTheNativeCosineDomainAndTheHostAgreesAwayFromTheBounds =
	property.explore(checkCases, {
		needs: { widths: Substrate.seat(widthsTemplate) },
		situations: [
			"admitted away from the bounds",
			"refused away from the bounds",
			"few dimensions",
			"the HNSW limit",
			"the storage limit"
		] satisfies ReadonlyArray<Reached<CheckFeature>>,
		check:
			({ widths }, k: Case<CheckFeature>) =>
			(checkCase) =>
				Effect.scoped(
					Effect.flatMap(widths, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const names = namesOf(seat.value)
								const writer = yield* s.session({
									...worldSession(seat.value.world(widthsWorld.app)),
									label: "writer"
								})
								const relation = at(widthRelations, checkCase.relation)
								const dims = relation.fields.value.dimensions
								k.note(widthFeatureOf(dims))
								const constraint = names.normCheck(relation, "value")
								const bound = checkCase.greatest ? cosineNormMax : cosineNormMin
								const direction = directionOf(dims, checkCase.direction)
								const length = Math.sqrt(Arr.reduce(direction, 0, (a, x) => a + x * x))
								const factor = (bound * (1 + checkCase.nudge)) / length
								const v = Vector.make(
									Float32Array.from(direction, (x) => x * factor),
									dims
								)
								const insert = writer.values(
									`INSERT INTO ${names.table(relation)} ("id", "value") VALUES ($1::text::uuid, $2::text::"vector_ext"."vector"(${dims}))`,
									[id(0xe, 1), rawText(v)]
								)
								const [row] = yield* s.admin.queryValues(
									`SELECT "vector_ext"."vector_norm"($1::text::"vector_ext"."vector"(${dims}))::text`,
									[rawText(v)]
								)
								const native = Number(row?.[0])
								const label = `${relation.name} near ${bound} by ${checkCase.nudge}`
								expectNormAgrees(v, native, label)
								/** The CHECK is vector_norm between the bounds: it admits exactly the native domain. */
								const inside = native >= cosineNormMin && native <= cosineNormMax
								if (inside) {
									yield* insert
								} else {
									const refused = yield* expectConstraint(insert, constraint, "23514")
									assert.equal(refused.code, "23514")
								}
								/**
								 * Away from the bounds by more than the summation rounding, the host decides alike, and the
								 * codec refuses what the CHECK refuses before any SQL.
								 */
								const host = Vector.norm(v)
								const margin = Math.min(
									Math.abs(host - cosineNormMin),
									Math.abs(host - cosineNormMax)
								)
								if (margin <= 4 * normTolerance(dims, host)) {
									k.note("decided near a bound")
									return
								}
								k.note(inside ? "admitted away from the bounds" : "refused away from the bounds")
								assert.equal(Vector.inCosineDomain(v), inside, label)
								const encoded = codecOf(vectorType(dims), emptyCodebook).encode(v)
								const expected: "admitted" | CodecFault = inside ? "admitted" : "vectorNorm"
								assert.equal(encoded.ok ? "admitted" : encoded.error, expected, label)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "the column's CHECK, vector_norm between the bounds, against the host's norm and codec"
		},
		show: Formatter.format,
		budget: { runs: 24, steered: 36 },
		kept: [],
		kills: []
	})

/**
 * The host's norm agrees with vector_norm within its derived bound on generated binary32 vectors, each case on the
 * worker's clone of the base template, which no case writes.
 *
 * Its pre-conversion budget: runs 4, no coverage (test/pg/vector/exact/distance.test.ts at cc41e3231).
 */
export const theHostNormAgreesWithVectorNormOnGeneratedBinary32Vectors = property.explore(
	binary32Vectors,
	{
		needs: { substrate: Substrate.installing },
		situations: [],
		check:
			({ substrate }) =>
			(vectors) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const payload = jsonText(Arr.map(vectors, (v, ord) => ({ ord, a: rawText(v) })))
						const rows = yield* s.admin.queryValues(
							`SELECT "vector_ext"."vector_norm"(r.a::"vector_ext"."vector")::text FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, a text) ORDER BY r.ord`,
							[payload]
						)
						assert.equal(rows.length, vectors.length)
						for (const [k, row] of rows.entries()) {
							expectNormAgrees(at(vectors, k), Number(row[0]), `vector ${k}`)
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "postgresql",
			name: "vector_norm, within the host norm's derived bound"
		},
		show: Formatter.format,
		budget: { runs: 4, steered: 0 },
		kept: [],
		kills: []
	}
)
