import { assert, contains, defined } from "@bjornpagen/testing/assert"
/**
 * approximateNearest on PostgreSQL 19 over the approximate-retrieval fixture (support.ts): a population drawn anew in
 * every run, installed with the HNSW index its workload requests and the fixed search policy stored as its login's
 * defaults, searched with query vectors drawn by number.
 *
 * - Candidates: for every account and drawn probe, and for account A's two documents of one embedding probed with it,
 *   the candidates are at most the request, distinct, each an eligible fact (its document's current revision, an
 *   embedding not pending) with its exact native score; under the policy they fill the request up to the eligible
 *   facts, so a small account underfills exactly to its own; and the two documents of one embedding are both found, at
 *   one distance, in key order.
 * - Shapes: every program of the fixture that is one approximate search over a stored source, certified
 *   approximateNearest.indexed, reads its key with no DISTINCT, and one certified approximateNearest.deduplicated keeps
 *   its DISTINCT before the bound.
 * - Fanout: a search over every revision, its revision projected away, delivers each (document, distance) at most
 *   once, each a pair one of the document's revisions has, filling its bound up to the distinct pairs; a document whose
 *   superseded revision repeats its current one, probed with that embedding, is delivered once.
 * - Negation: a negated tag restricts the eligible universe before the bound: no candidate is tagged, every one carries
 *   its exact score, and the request fills up to the untagged eligible facts.
 * - Superseded: within one transaction that removes the nearest candidates' embeddings and gives the next a new current
 *   revision far from the probe, leaving both in the HNSW graph, no removed document and no superseded revision is a
 *   candidate, and the request fills up to what the transaction sees.
 * - Shared: a search two rules read is one MATERIALIZED CTE, and composes with ordinary matching: titles join the
 *   candidates exactly, and the shared program's rules filter them as the host filters them.
 *
 * Oracle: a second implementation, the exact baseline: the eligible relation scored with cosine_distance in a scan no
 * HNSW index orders, read under the transaction the search runs in; and the certificate's own statement of the SQL's
 * shape.
 *
 * Features: each account, an underfilled request, the duplicate embedding, a search the HNSW index serves, each kind of
 * superseding, and a negated tag excluded. Whether PostgreSQL serves a search from the HNSW index is the planner's
 * choice, never grizzle's contract, so it is a feature a search must reach, not an assertion.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Array as Arr, Option, Order } from "effect"
import {
	accounts,
	anyRevisionTake,
	asTriple,
	candidateProbeGen,
	candidatesAnn,
	candidatesTake,
	exactDistinct,
	exactScores,
	fanoutAnn,
	key,
	negationAnn,
	probeNumber,
	repeatingAccounts,
	run,
	searcher,
	type SearchFeature,
	servedByHnsw,
	shapeNames,
	shapePrograms,
	shapesAnn,
	sharedAnn,
	supersededAnn,
	type SupersededFeature,
	supersededFeatures,
	supersededGen
} from "#test/pg/vector/ann/ann.fixtures.ts"
import {
	annIn,
	accountA,
	accountB,
	anyRevision,
	candidates,
	compile,
	duplicatePair,
	repeated,
	shared,
	titles,
	untagged,
	vectorParam,
	vectorText
} from "#test/pg/vector/ann/support.ts"
import { programAsts } from "#test/support/compile.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Candidates are eligible facts at their exact scores, fill the request up to the eligible facts, and keep facts of one embedding apart, each case on the worker's seat of the populated fixture.
 *
 * Its pre-conversion budget: runs 12, coverage cases 12 (test/pg/vector/ann/ann.test.ts at 4ca3036a9).
 */
export const candidatesAreEligibleFactsAtTheirExactScoresFillTheRequestUpToTheEligibleFactsAndKeepFactsOfOneEmbeddingApart =
	property.explore(candidateProbeGen, {
		needs: { ann: Substrate.seat(candidatesAnn) },
		situations: [
			...Arr.map(accounts, ([, label]): SearchFeature => `account ${label}`),
			"underfilled by a small account",
			"the duplicate embedding",
			"served by the HNSW index"
		] satisfies ReadonlyArray<Reached<SearchFeature>>,
		check:
			({ ann }, k: Case<SearchFeature>) =>
			(probe) =>
				Effect.scoped(
					Effect.flatMap(ann, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const fx = annIn(seat, { candidates })
								const session = yield* searcher(fx)
								const c = compile(candidates, fx.installed, "query")
								const [d1, d2] = duplicatePair(fx.facts)
								const sharedEmbedding = defined(
									Option.getOrUndefined(
										Option.flatMapNullishOr(
											Arr.findFirst(fx.facts, (d) => d.id === d1),
											(d) => d.embeddings[0]?.value
										)
									),
									"the duplicate pair's embedding"
								)
								const [account, label] =
									probe.kind === "duplicate" ? ([accountA, "A"] as const) : probe.account
								const vector = probe.kind === "duplicate" ? sharedEmbedding : fx.probe(probe.n)
								const params = { account, vector: vectorParam(vector) }
								const rows = yield* run(session, c, params)
								const exact = yield* exactScores(session, fx, account, vector)
								const scores = new Map(Arr.map(exact, (r) => [key(r), r[2]]))
								assert.equal(
									new Set(Arr.map(rows, (r) => Arr.join(r, "|"))).size,
									rows.length,
									`${label}: distinct candidates`
								)
								for (const row of rows) {
									const [document, revision, distance] = asTriple(row)
									assert.equal(
										scores.get(`${document}/${revision}`),
										distance,
										`${label} ${document}/${revision}: eligible, at its exact score`
									)
								}
								assert.equal(
									rows.length,
									Math.min(candidatesTake, exact.length),
									`${label}: the request filled up to the eligible facts`
								)
								if (exact.length < candidatesTake) {
									k.note("underfilled by a small account")
								}
								if (probe.kind === "duplicate") {
									const documents = Arr.map(rows, (r) => r[1])
									contains(documents, d1)
									contains(documents, d2)
									const [first, second] = rows
									assert.equal(first?.[0], second?.[0])
									assert.deepEqual([first?.[1], second?.[1]], Arr.sort([d1, d2], Order.String))
									k.note("the duplicate embedding")
								}
								if (yield* servedByHnsw(session, fx, c, params)) {
									k.note("served by the HNSW index")
								}
								k.note(`account ${label}`)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the exact baseline: the eligible relation scored with cosine_distance"
		},
		show: Formatter.format,
		budget: { runs: 12, steered: 12 },
		kept: [],
		kills: []
	})

/**
 * Reads a retained key with no DISTINCT and keeps a fanout's DISTINCT, as each program's certificate states, each case on the worker's seat of the populated fixture.
 *
 * Its pre-conversion budget: the box (test/pg/vector/ann/ann.test.ts at 4ca3036a9).
 */
export const readsARetainedKeyWithNoDistinctAndKeepsAFanoutsDistinctAsEachProgramsCertificateStates =
	property.exhaust(
		finite((source) => source.draw(element(shapeNames))),
		{
			needs: { ann: Substrate.seat(shapesAnn) },
			situations: ["indexed", "deduplicated"] satisfies ReadonlyArray<
				Reached<"indexed" | "deduplicated">
			>,
			check:
				({ ann }, k: Case<"indexed" | "deduplicated">) =>
				(name) =>
					Effect.scoped(
						Effect.flatMap(ann, (seat) =>
							Effect.provideService(
								Effect.gen(function* () {
									const fx = annIn(seat, shapePrograms)

									return yield* Effect.sync(() => {
										const compiled = compile(shapePrograms[name], fx.installed, "query")
										const rules = Arr.map(compiled.program.certificates, (x) => x.rule)
										const distinct = Arr.some(programAsts(compiled.program), (ast) =>
											has(shapeOf(ast), "distinct")
										)
										if (rules.includes("approximateNearest.deduplicated")) {
											assert.ok(distinct, `${name} keeps its DISTINCT before the bound`)
											k.note("deduplicated")
										} else if (rules.includes("approximateNearest.indexed")) {
											assert.equal(distinct, false, `${name} reads its key with no DISTINCT`)
											k.note("indexed")
										}
									})
								}),
								Substrate,
								seat.substrate
							)
						)
					),
			oracle: {
				kind: "specification",
				name: "approximateNearest.indexed reads its key with no DISTINCT, approximateNearest.deduplicated keeps one"
			},
			show: Formatter.format,
			box: "every program of the fixture that is one approximate search over a stored source",
			kept: [],
			kills: []
		}
	)

/**
 * A search over every revision delivers each (document, distance) once, a pair of its revisions, filling its bound, each case on the worker's seat of the populated fixture.
 *
 * Its pre-conversion budget: runs 12, coverage cases 12 (test/pg/vector/ann/ann.test.ts at 4ca3036a9).
 */
export const aSearchOverEveryRevisionDeliversEachDocumentDistanceOnceAPairOfItsRevisionsFillingItsBound =
	property.explore(
		(source) =>
			[
				source.draw(element(repeatingAccounts)),
				source.draw(
					weighted<number | "its own embedding">([
						[1, () => "its own embedding" as const],
						[2, probeNumber]
					])
				)
			] as const,
		{
			needs: { ann: Substrate.seat(fanoutAnn) },
			situations: [
				...Arr.map(repeatingAccounts, ([, label]): SearchFeature => `account ${label}`),
				"a repeated document probed with its own embedding"
			] satisfies ReadonlyArray<Reached<SearchFeature>>,
			check:
				({ ann }, k: Case<SearchFeature>) =>
				([[account, label], probe]) =>
					Effect.scoped(
						Effect.flatMap(ann, (seat) =>
							Effect.provideService(
								Effect.gen(function* () {
									const fx = annIn(seat, { anyRevision })
									const session = yield* searcher(fx)
									const fanout = compile(anyRevision, fx.installed, "query")

									const twice = defined(
										repeated(fx.facts, account)[0],
										`${label}'s repeated document`
									)
									const vector =
										probe === "its own embedding"
											? defined(twice.embeddings[0], "its embedding").value
											: fx.probe(probe)
									const rows = yield* run(session, fanout, {
										account,
										vector: vectorParam(vector)
									})
									const exact = yield* exactDistinct(session, fx, account, vector)
									const pairs = new Set(Arr.map(exact, (r) => `${r[0]}|${r[1]}`))
									const delivered = Arr.map(
										rows,
										([distance, document]) => `${document}|${distance}`
									)
									assert.equal(new Set(delivered).size, rows.length, `${label}: each pair once`)
									for (const pair of delivered) {
										assert.ok(
											pairs.has(pair),
											`${label} ${pair}: a pair of the document's revisions`
										)
									}
									assert.equal(
										rows.length,
										Math.min(anyRevisionTake, pairs.size),
										`${label}: the bound filled up to the distinct pairs`
									)
									if (probe === "its own embedding") {
										assert.equal(
											Arr.filter(rows, (r) => r[1] === twice.id).length,
											1,
											`${label}: the repeated document once`
										)
										k.note("a repeated document probed with its own embedding")
									}
									k.note(`account ${label}`)
								}),
								Substrate,
								seat.substrate
							)
						)
					),
			oracle: {
				kind: "second-implementation",
				name: "the exact baseline of every distinct (document, distance)"
			},
			show: Formatter.format,
			budget: { runs: 12, steered: 12 },
			kept: [],
			kills: []
		}
	)

/**
 * A negation in the source restricts the eligible universe before the bound, each case on the worker's seat of the populated fixture.
 *
 * Its pre-conversion budget: runs 12, coverage cases 12 (test/pg/vector/ann/ann.test.ts at 4ca3036a9).
 */
export const aNegationInTheSourceRestrictsTheEligibleUniverseBeforeTheBound = property.explore(
	(source) => [source.draw(element(accounts)), source.draw(probeNumber)] as const,
	{
		needs: { ann: Substrate.seat(negationAnn) },
		situations: ["a negated tag excluded", "served by the HNSW index"] satisfies ReadonlyArray<
			Reached<SearchFeature>
		>,
		check:
			({ ann }, k: Case<SearchFeature>) =>
			([[account, label], n]) =>
				Effect.scoped(
					Effect.flatMap(ann, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const fx = annIn(seat, { candidates, untagged })
								const session = yield* searcher(fx)
								const c = compile(untagged, fx.installed, "query")
								const gamma = new Set(
									Arr.map(
										Arr.filter(fx.facts, (d) => d.tags.includes("gamma")),
										(d) => d.id
									)
								)
								const vector = fx.probe(n)
								const params = { account, vector: vectorParam(vector) }
								const rows = yield* run(session, c, params)
								const scored = yield* exactScores(session, fx, account, vector)
								const exact = new Map(
									Arr.map(
										Arr.filter(scored, (r) => r[0] === undefined || !gamma.has(r[0])),
										(r) => [key(r), r[2]]
									)
								)
								for (const row of rows) {
									const [document, revision, distance] = asTriple(row)
									assert.equal(
										gamma.has(document),
										false,
										`${label} ${document} is not tagged gamma`
									)
									assert.equal(
										exact.get(`${document}/${revision}`),
										distance,
										`${label} ${document}/${revision}`
									)
								}
								assert.equal(
									rows.length,
									Math.min(candidatesTake, exact.size),
									`${label}: the request filled up to the untagged eligible facts`
								)
								if (exact.size < scored.length) {
									k.note("a negated tag excluded")
								}
								if (yield* servedByHnsw(session, fx, c, params)) {
									k.note("served by the HNSW index")
								}
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the exact baseline with the gamma-tagged documents removed on the host"
		},
		show: Formatter.format,
		budget: { runs: 12, steered: 12 },
		kept: [],
		kills: []
	}
)

/**
 * Dead tuples and superseded revisions still in the HNSW graph never reach the candidates, each case on the worker's seat of the populated fixture.
 *
 * Its pre-conversion budget: runs 12, coverage cases 12 (test/pg/vector/ann/ann.test.ts at 4ca3036a9).
 */
export const deadTuplesAndSupersededRevisionsStillInTheHnswGraphNeverReachTheCandidates =
	property.explore(supersededGen, {
		needs: { ann: Substrate.seat(supersededAnn) },
		situations: [
			"nearest embeddings removed",
			"nearest revisions superseded",
			"both, in one transaction",
			"served by the HNSW index"
		] satisfies ReadonlyArray<Reached<SupersededFeature>>,
		check:
			({ ann }, k: Case<SupersededFeature>) =>
			(drawnCase) =>
				Effect.scoped(
					Effect.flatMap(ann, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const fx = annIn(seat, { candidates })
								const session = yield* searcher(fx)
								const c = compile(candidates, fx.installed, "query")
								return yield* Effect.ensuring(
									Effect.gen(function* () {
										const vector = fx.probe(drawnCase.n)
										const params = { account: accountB, vector: vectorParam(vector) }
										yield* session.begin
										const nearest = yield* run(session, c, params)
										const before = Arr.map(nearest, asTriple)
										/**
										 * In one transaction the searcher's own role writes: the nearest lose their current
										 * embedding, pending and so not eligible, their tuples left in the graph, invisible to
										 * the transaction; the next get a new current revision far from the probe, the old one
										 * stored and superseded.
										 */
										const removed = before.slice(0, drawnCase.removed)
										for (const [document, revision] of removed) {
											yield* session.query(
												`DELETE FROM ${fx.table("DocumentEmbedding")} WHERE "document" = '${document}'::uuid AND "revision" = ${revision}::bigint`,
												[]
											)
										}
										const far = vectorText(Arr.map(vector, (x) => (x === 0 ? 0 : -x)))
										const superseded = before.slice(
											drawnCase.removed,
											drawnCase.removed + drawnCase.superseded
										)
										for (const [document] of superseded) {
											yield* session.query(
												`INSERT INTO ${fx.table("DocumentEmbedding")} ("document", "revision", "value") VALUES ('${document}'::uuid, 3::bigint, '${far}'::vector_ext.vector)`,
												[]
											)
											yield* session.query(
												`DELETE FROM ${fx.table("DocumentCurrent")} WHERE "document" = '${document}'::uuid`,
												[]
											)
											yield* session.query(
												`INSERT INTO ${fx.table("DocumentCurrent")} ("document", "revision") VALUES ('${document}'::uuid, 3::bigint)`,
												[]
											)
										}
										const searchedAgain = yield* run(session, c, params)
										const after = Arr.map(searchedAgain, asTriple)
										const scored = yield* exactScores(session, fx, accountB, vector)
										const exact = new Map(Arr.map(scored, (r) => [key(r), r[2]]))
										const gone = new Set(Arr.map(removed, ([document]) => document))
										const moved = new Set(Arr.map(superseded, ([document]) => document))
										for (const [document, revision, distance] of after) {
											assert.equal(
												exact.get(`${document}/${revision}`),
												distance,
												`${document}/${revision} eligible`
											)
											assert.equal(
												gone.has(document),
												false,
												`${document} has no current embedding`
											)
											if (moved.has(document)) {
												assert.equal(revision, "3", `${document} only at its new revision`)
											}
										}
										assert.equal(after.length, Math.min(candidatesTake, exact.size))
										k.noteAll(supersededFeatures(drawnCase))
										if (yield* servedByHnsw(session, fx, c, params)) {
											k.note("served by the HNSW index")
										}
									}),
									Effect.orDie(session.rollback)
								)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the exact baseline over the facts the transaction sees"
		},
		show: Formatter.format,
		budget: { runs: 12, steered: 12 },
		kept: [],
		kills: []
	})

/**
 * A shared search is computed once and composes with ordinary matching, each case on the worker's seat of the populated fixture.
 *
 * Its pre-conversion budget: runs 12, coverage cases 12 (test/pg/vector/ann/ann.test.ts at 4ca3036a9).
 */
export const aSharedSearchIsComputedOnceAndComposesWithOrdinaryMatching = property.explore(
	(source) => [source.draw(element(accounts)), source.draw(probeNumber)] as const,
	{
		needs: { ann: Substrate.seat(sharedAnn) },
		situations: Arr.map(
			accounts,
			([, label]): SearchFeature => `account ${label}`
		) satisfies ReadonlyArray<Reached<SearchFeature>>,
		check:
			({ ann }, k: Case<SearchFeature>) =>
			([[account, label], n]) =>
				Effect.scoped(
					Effect.flatMap(ann, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const fx = annIn(seat, { candidates, titles, shared })
								const session = yield* searcher(fx)
								const near = compile(candidates, fx.installed, "query")
								const t = compile(titles, fx.installed, "query")
								/** A search two rules read is one MATERIALIZED CTE, one evaluation per execution. */
								const twice = compile(shared, fx.installed, "query")
								assert.ok(has(shapeOf(programAsts(twice.program)[0]), "cte materialized"))
								const tagged = new Set(
									Arr.map(
										Arr.filter(fx.facts, (d) => d.tags.includes("gamma")),
										(d) => d.id
									)
								)
								const vector = vectorParam(fx.probe(n))
								const candidatesOf = yield* run(session, near, { account, vector })
								const titled = yield* run(session, t, { account, vector })
								assert.deepEqual(
									Arr.sort(
										Arr.map(titled, (r) => `${r[1]}:${r[0]}`),
										Order.String
									),
									Arr.sort(
										Arr.map(candidatesOf, (r) => `${r[1]}:${r[0]}`),
										Order.String
									)
								)
								const both = yield* run(session, twice, { account, vector })
								const kept = Arr.filter(
									candidatesOf,
									(r) => Number(r[0]) < 1 || (r[1] !== undefined && tagged.has(r[1]))
								)
								const expected = Arr.flatMap(kept, (r) => (r[1] === undefined ? [] : [r[1]]))
								assert.deepEqual(
									Arr.sort(
										Arr.flatMap(both, (r) => (r[0] === undefined ? [] : [r[0]])),
										Order.String
									),
									Arr.sort(expected, Order.String)
								)
								k.note(`account ${label}`)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the search's own candidates, filtered on the host as each rule reads them"
		},
		show: Formatter.format,
		budget: { runs: 12, steered: 12 },
		kept: [],
		kills: []
	}
)
