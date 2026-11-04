import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Order } from "effect"
import { planIndexNames, planNodeTypes } from "#bench/harness/explain.ts"
import { hnswPolicy, hnswSearchSettings } from "#compiler/check/approximate/policy.ts"
import { subtree } from "#compiler/check/approximate/trace.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { identity } from "#compiler/core/identity.ts"
import { NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import { relNode, rooted } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { RelDag } from "#compiler/ir/rel.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { compilePageOf, statedOrderOf } from "#compiler/lower/shapes/page/compile.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	AnnSearch,
	accountA,
	accountB,
	accountC,
	anyRevision,
	type Compiled,
	candidates,
	checked,
	compile,
	Document,
	DocumentCurrent,
	DocumentEmbedding,
	duplicatePair,
	type Fixture,
	installFixture,
	installLabelled,
	repeated,
	scoredDocuments,
	shared,
	sizes,
	textRows,
	titles,
	unfiltered,
	untagged,
	vectorParam,
	vectorText
} from "#test/pg/vector/ann/support.ts"
import { assert, assertVariant, contains, defined, failed, lacks } from "#test/support/assert.ts"
import {
	compileTemplate,
	lowerAligned,
	paramTexts,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import { namesOf, parsedSchemaName, wild } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

/**
 * Whether a plan reads the HNSW index the workload requests on DocumentEmbedding.value, named as its installation names it.
 */
const readsHnsw = (fx: Fixture, indexes: ReadonlyArray<string>): boolean => {
	const hnsw = namesOf(fx.installed).accessIndex(DocumentEmbedding, ["value"])
	return Arr.some(indexes, (i) => i === hnsw)
}

/** Whether a result is approximate: some root's rows are computed from an approximate search. */
const isApproximate = (dag: RelDag): boolean =>
	Arr.some(dag.roots, (root) =>
		Arr.some(Arr.fromIterable(subtree(root)), (n) => n.kind === "ApproximateNearest")
	)

const run = (session: RawSession, c: Compiled, params: Readonly<Record<string, unknown>>) => {
	const spec = defined(c.specs[0], "statement 0")
	return Effect.map(session.values(spec.sql, paramTexts(spec, params)), textRows)
}

/**
 * EXPLAIN (FORMAT JSON) of the executable statement with its parameters, as the plan node types in preorder and
 * every index the plan reads (bench/harness/explain.ts).
 */
const plan = (session: RawSession, c: Compiled, params: Readonly<Record<string, unknown>>) =>
	Effect.gen(function* () {
		const spec = defined(c.specs[0], "statement 0")
		const rows = yield* session.values(
			`EXPLAIN (FORMAT JSON, COSTS FALSE) ${spec.sql}`,
			paramTexts(spec, params)
		)
		const [explained] = defined(rows[0], "the EXPLAIN row")
		return { nodes: planNodeTypes(explained), indexes: planIndexNames(explained) }
	})

/**
 * The exact baseline: the complete eligible relation scored with cosine_distance, which no index orders, under the
 * statement's own key order. It also returns every eligible fact's exact score.
 */
const exactScores = (
	session: RawSession,
	fx: Fixture,
	account: string,
	vector: ReadonlyArray<number>
) =>
	Effect.map(
		session.values(
			`SELECT e."document"::text, e."revision"::text, vector_ext.cosine_distance(e."value", $1::text::vector_ext.vector)::text
			 FROM ${fx.table("DocumentEmbedding")} AS e
			 JOIN ${fx.table("DocumentCurrent")} AS c ON c."document" = e."document" AND c."revision" = e."revision"
			 JOIN ${fx.table("Document")} AS d ON d."id" = e."document"
			 WHERE d."account" = $2::text::uuid
			 ORDER BY vector_ext.cosine_distance(e."value", $1::text::vector_ext.vector), e."document", e."revision"`,
			[vectorText(vector), account]
		),
		textRows
	)

/**
 * The exact baseline of anyRevision: every distinct (document, distance) of an account's revisions, in the statement's
 * order (distance, then document), scored with cosine_distance, which no index orders.
 */
const exactDistinct = (
	session: RawSession,
	fx: Fixture,
	account: string,
	vector: ReadonlyArray<number>
) =>
	Effect.map(
		session.values(
			`SELECT q."document"::text, q."distance"::text FROM (
				SELECT DISTINCT e."document", vector_ext.cosine_distance(e."value", $1::text::vector_ext.vector) AS "distance"
				FROM ${fx.table("DocumentEmbedding")} AS e
				JOIN ${fx.table("Document")} AS d ON d."id" = e."document"
				WHERE d."account" = $2::text::uuid
			 ) AS q ORDER BY q."distance", q."document"`,
			[vectorText(vector), account]
		),
		textRows
	)

const key = (row: ReadonlyArray<string>): string => `${row[0]}/${row[1]}`

/** candidates delivers (distance, document, revision): heading order is canonical code-unit order. */
const asTriple = (row: ReadonlyArray<string>): readonly [string, string, string] => {
	const [distance, document, revision] = row
	if (distance === undefined || document === undefined || revision === undefined) {
		throw new Error("a row of three columns")
	}
	return [document, revision, distance]
}

/** An account of the fixture and the letter a report names it by. */
type Account = readonly [account: string, label: "A" | "B" | "C"]

const accountsABC: Arr.NonEmptyReadonlyArray<Account> = [
	[accountA, "A"],
	[accountB, "B"],
	[accountC, "C"]
]

/** An account searched, by its letter, or a probe number searched. */
type SearchFeature = `account ${Account[1]}` | `probe ${number}`

/** An account of `among` searched with each probe number of `probes`. */
const probed =
	(
		among: Arr.NonEmptyReadonlyArray<Account>,
		probes: Arr.NonEmptyReadonlyArray<number>
	): Gen<readonly [Account, number]> =>
	(source) =>
		[source.draw(element(among)), source.draw(element(probes))] as const

/** How long one search case may run. */
const caseHang = Duration.minutes(2)

const searcher = (fx: Fixture) =>
	Effect.flatMap(Substrate, (s) =>
		s.session({ ...worldSession(fx.installed.world(fx.opened.app)), label: "searcher" })
	)

layer(Substrate.layer)("approximateNearest on PostgreSQL 19", (it) => {
	it.effect(
		"candidates obey every filter, carry exact native scores, underfill when the eligible set is small, and are labelled approximate",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fx = yield* installFixture({ candidates })
					const session = yield* searcher(fx)
					for (const setting of hnswSearchSettings()) {
						const shown = yield* session.values(`SELECT pg_catalog.current_setting($1::text)`, [
							setting.parameter
						])
						assert.equal(shown[0]?.[0], setting.value, setting.parameter)
					}
					const c = compile(candidates, fx.installed, "query")
					assert.equal(isApproximate(c.program.query.dag), true)
					contains(
						Arr.map(c.program.certificates, (x) => x.rule),
						"approximateNearest.indexed"
					)
					const missing = new Set(
						Arr.map(
							Arr.filter(fx.facts, (d) => !Arr.some(d.embeddings, (e) => e.revision === d.current)),
							(d) => d.id
						)
					)
					const probes = [1, 2, 3] as const
					return yield* exhaust(
						{
							suite: "vector/ann/candidates",
							generator: probed(accountsABC, probes),
							literal: ([[, label], seed]: readonly [Account, number]) =>
								`account ${label}, probe ${seed}`,
							limit: accountsABC.length * probes.length,
							coverage: requiredInSpace<SearchFeature>(["account A", "account B", "account C"]),
							caseHang
						},
						([[account, label], seed], k) =>
							Effect.gen(function* () {
								const vector = fx.probe(seed)
								const rows = yield* run(session, c, { account, vector: vectorParam(vector) })
								const exact = yield* exactScores(session, fx, account, vector)
								const scores = new Map(Arr.map(exact, (r) => [key(r), r[2]]))
								assert.ok(rows.length <= 20, label)
								assert.equal(
									new Set(Arr.map(rows, (r) => Arr.join(r, "|"))).size,
									rows.length,
									label
								)
								for (const row of rows) {
									const [document, revision, distance] = asTriple(row)
									assert.equal(
										scores.has(`${document}/${revision}`),
										true,
										`${label} ${document}/${revision} eligible`
									)
									assert.equal(missing.has(document), false)
									assert.equal(
										distance,
										defined(scores.get(`${document}/${revision}`), `${label} score`),
										`${label} score`
									)
								}
								if (account === accountC) {
									assert.ok(exact.length <= sizes.C)
									assert.ok(rows.length < 20)
									assert.ok(rows.length <= exact.length)
								} else {
									assert.ok(exact.length > 20)
								}
								k.note(`account ${label}`)
							})
					)
				})
			),
		300_000
	)

	it.effect(
		"the fixed search policy fills a filtered request that the default HNSW search underfills, over a label-fixed population",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fx = yield* installLabelled({ candidates }, "pg/vector/ann/policy")
					const session = yield* searcher(fx)
					const c = compile(candidates, fx.installed, "query")
					const eligible = Arr.filter(
						fx.facts,
						(d) => d.account === accountB && Arr.some(d.embeddings, (e) => e.revision === d.current)
					).length
					assert.ok(eligible > 20)
					const probes = [21, 22, 23] as const
					return yield* exhaust(
						{
							suite: "vector/ann/policy",
							generator: element(probes),
							literal: (seed: number) => `probe ${seed}`,
							limit: probes.length,
							coverage: requiredInSpace<SearchFeature>(
								Arr.map(probes, (seed): SearchFeature => `probe ${seed}`)
							),
							caseHang
						},
						(seed, k) =>
							Effect.gen(function* () {
								const params = { account: accountB, vector: vectorParam(fx.probe(seed)) }
								/** The premise: the account filter is applied to rows the HNSW index scan produces. */
								const p = yield* plan(session, c, params)
								assert.equal(readsHnsw(fx, p.indexes), true, Formatter.format(p))
								/** Under the policy, strict iterative scans keep exploring until the request is filled. */
								const filled = yield* run(session, c, params)
								assert.equal(filled.length, 20, `seed ${seed} under the policy`)
								yield* session.values(`SET hnsw.iterative_scan = 'off'`, [])
								const underfilled = yield* run(session, c, params)
								yield* session.values(`RESET hnsw.iterative_scan`, [])
								assert.ok(underfilled.length < 20, `seed ${seed} under the default search`)
								const keys = new Set(Arr.map(filled, (r) => `${r[1]}/${r[2]}`))
								const scored = yield* exactScores(session, fx, accountB, fx.probe(seed))
								const exact = new Set(Arr.map(scored, key))
								for (const r of underfilled) {
									assert.equal(exact.has(`${r[1]}/${r[2]}`), true)
								}
								assert.equal(keys.size, 20)
								k.note(`probe ${seed}`)
							})
					)
				})
			),
		300_000
	)

	it.effect(
		"a retained key needs no DISTINCT and the plan is driven by the HNSW index; fanout keeps a Unique node",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fx = yield* installFixture({ candidates, anyRevision, unfiltered })
					const session = yield* searcher(fx)
					const vector = vectorParam(fx.probe(7))
					const hnsw = (indexes: ReadonlyArray<string>) => readsHnsw(fx, indexes)

					/** The unfiltered search over the stored relation's key: ORDER BY <=> LIMIT straight off the index. */
					const direct = compile(unfiltered, fx.installed, "query")
					assert.equal(has(shapeOf(flight(direct.program.roots)[0].ast), "distinct"), false)
					const directPlan = yield* plan(session, direct, { vector })
					lacks(directPlan.nodes, "Unique")
					lacks(directPlan.nodes, "HashAggregate")
					assert.equal(hnsw(directPlan.indexes), true, Formatter.format(directPlan))

					/**
					 * The example's candidates: (document, revision) retained through the current-revision match, no DISTINCT.
					 */
					const keyed = compile(candidates, fx.installed, "query")
					contains(
						Arr.map(keyed.program.certificates, (x) => x.rule),
						"approximateNearest.indexed"
					)
					assert.equal(has(shapeOf(flight(keyed.program.roots)[0].ast), "distinct"), false)
					const keyedPlan = yield* plan(session, keyed, { account: accountA, vector })
					lacks(keyedPlan.nodes, "Unique")
					assert.equal(hnsw(keyedPlan.indexes), true, Formatter.format(keyedPlan))

					/** Every revision, the revision projected away: multiplicity resolved before top-k. */
					const fanout = compile(anyRevision, fx.installed, "query")
					contains(
						Arr.map(fanout.program.certificates, (x) => x.rule),
						"approximateNearest.deduplicated"
					)
					assert.ok(has(shapeOf(flight(fanout.program.roots)[0].ast), "distinct"))
					const fanoutPlan = yield* plan(session, fanout, { account: accountA, vector })
					contains(fanoutPlan.nodes, "Unique")
					assert.equal(hnsw(fanoutPlan.indexes), true, Formatter.format(fanoutPlan))

					const repeating: Arr.NonEmptyReadonlyArray<Account> = [
						[accountA, "A"],
						[accountC, "C"]
					]
					return yield* exhaust(
						{
							suite: "vector/ann/fanout",
							generator: element(repeating),
							literal: ([, label]: Account) => `account ${label}`,
							limit: repeating.length,
							coverage: requiredInSpace<SearchFeature>(["account A", "account C"]),
							caseHang
						},
						([account, label], k) =>
							Effect.gen(function* () {
								const twice = defined(
									repeated(fx.facts, account)[0],
									`${label} has a repeated document`
								)
								const value = twice.embeddings[0]?.value
								if (value === undefined) {
									return assert.fail(`${label} has a repeated document`)
								}
								const rows = yield* run(session, fanout, { account, vector: vectorParam(value) })
								const exact = yield* exactDistinct(session, fx, account, value)
								assert.ok(exact.length >= 10, label)
								const scores = new Map(Arr.map(exact, (r) => [r[0], new Set<string>()]))
								for (const [document, distance] of exact) {
									if (distance !== undefined) {
										scores.get(document)?.add(distance)
									}
								}
								assert.equal(rows.length, 10, label)
								assert.equal(new Set(Arr.map(rows, (r) => Arr.join(r, "|"))).size, 10, label)
								assert.equal(Arr.filter(rows, (r) => r[1] === twice.id).length, 1, label)
								for (const [distance, document] of rows) {
									assert.equal(
										document !== undefined &&
											distance !== undefined &&
											scores.get(document)?.has(distance),
										true,
										`${label} ${document}`
									)
								}
								if (account === accountC) {
									assert.deepEqual(
										Arr.sort(
											Arr.map(rows, (r) => `${r[1]}|${r[0]}`),
											Order.String
										),
										Arr.sort(
											Arr.map(exact.slice(0, 10), (r) => `${r[0]}|${r[1]}`),
											Order.String
										)
									)
								}
								k.note(`account ${label}`)
							})
					)
				})
			),
		300_000
	)

	it.effect(
		"recall against the exact baseline holds its floor over a label-fixed population, ties and duplicates under different keys are distinct facts",
		(ctx) =>
			Effect.gen(function* () {
				const fx = yield* installLabelled({ candidates }, "pg/vector/ann/recall")
				const session = yield* searcher(fx)
				const c = compile(candidates, fx.installed, "query")
				const recalls: Array<string> = []
				let hits = 0
				let wanted = 0
				const recalled: ReadonlyArray<Account> = [
					[accountA, "A"],
					[accountB, "B"]
				]
				for (const [[account, label], seed] of Arr.cartesian(recalled, Arr.range(10, 19))) {
					const vector = fx.probe(seed)
					const rows = yield* run(session, c, { account, vector: vectorParam(vector) })
					const exact = (yield* exactScores(session, fx, account, vector)).slice(0, 20)
					const got = new Set(Arr.map(rows, (r) => `${r[1]}/${r[2]}`))
					const found = Arr.filter(exact, (r) => got.has(key(r))).length
					hits += found
					wanted += exact.length
					recalls.push(`${label}${seed}=${found}/${exact.length}`)
				}
				const recall = hits / wanted
				const record = `recall@20 of approximateNearest against the exact baseline, HNSW policy (m ${hnswPolicy.build.m}, ef_construction ${hnswPolicy.build.efConstruction}, ef_search ${hnswPolicy.search.efSearch}, ${hnswPolicy.search.iterativeScan}), ${sizes.A + sizes.B + sizes.C} documents of 8 dimensions: ${recall.toFixed(4)} (${Arr.join(recalls, " ")})`
				yield* Effect.promise(() => ctx.annotate(record))
				yield* Effect.log(record)
				assert.ok(recall > 0.8)

				/** Two documents of account A share one embedding: probing with it finds both, two facts. */
				const [d1, d2] = duplicatePair(fx.facts)
				const duplicated = Option.flatMapNullishOr(
					Arr.findFirst(fx.facts, (d) => d.id === d1),
					(d) => d.embeddings[0]?.value
				)
				if (Option.isNone(duplicated)) {
					return assert.fail("the duplicate pair has an embedding")
				}
				const rows = yield* run(session, c, {
					account: accountA,
					vector: vectorParam(duplicated.value)
				})
				const documents = Arr.map(rows, (r) => r[1])
				contains(documents, d1)
				contains(documents, d2)
				const [first, second] = rows
				assert.equal(first?.[0], second?.[0])
				assert.deepEqual([first?.[1], second?.[1]], Arr.sort([d1, d2], Order.String))
			}),
		300_000
	)

	it.effect(
		"a negation in the source restricts the eligible universe before the bound, on the HNSW plan",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fx = yield* installFixture({ candidates, untagged })
					const session = yield* searcher(fx)
					const c = compile(untagged, fx.installed, "query")
					const gamma = new Set(
						Arr.map(
							Arr.filter(fx.facts, (d) => d.tags.includes("gamma")),
							(d) => d.id
						)
					)
					const probes = [51, 52, 53] as const
					return yield* exhaust(
						{
							suite: "vector/ann/negation",
							generator: element(probes),
							literal: (seed: number) => `probe ${seed}`,
							limit: probes.length,
							coverage: requiredInSpace<SearchFeature>(
								Arr.map(probes, (seed): SearchFeature => `probe ${seed}`)
							),
							caseHang
						},
						(seed, k) =>
							Effect.gen(function* () {
								const vector = fx.probe(seed)
								const params = { account: accountB, vector: vectorParam(vector) }
								const p = yield* plan(session, c, params)
								assert.equal(readsHnsw(fx, p.indexes), true, Formatter.format(p))
								const rows = yield* run(session, c, params)
								const scored = yield* exactScores(session, fx, accountB, vector)
								const exact = new Map(
									Arr.map(
										Arr.filter(scored, (r) => r[0] === undefined || !gamma.has(r[0])),
										(r) => [key(r), r[2]]
									)
								)
								assert.ok(exact.size > 20)
								assert.equal(rows.length, 20, `seed ${seed}`)
								for (const row of rows) {
									const [document, revision, distance] = asTriple(row)
									assert.equal(gamma.has(document), false, `${document} is not tagged gamma`)
									assert.equal(
										exact.get(`${document}/${revision}`),
										distance,
										`${document}/${revision}`
									)
								}
								k.note(`probe ${seed}`)
							})
					)
				})
			),
		300_000
	)

	it.effect(
		"dead tuples and superseded revisions still in the HNSW graph never reach the candidates",
		() =>
			Effect.gen(function* () {
				const fx = yield* installFixture({ candidates })
				const s = yield* Substrate
				const session = yield* searcher(fx)
				const c = compile(candidates, fx.installed, "query")
				const vector = fx.probe(31)
				const params = { account: accountB, vector: vectorParam(vector) }
				const nearest = yield* run(session, c, params)
				const before = Arr.map(nearest, asTriple)
				assert.equal(before.length, 20)
				yield* Effect.forEach(["DocumentEmbedding", "DocumentCurrent"], (r) =>
					s.admin.query(`ALTER TABLE ${fx.table(r)} SET (autovacuum_enabled = false)`, [])
				)
				/**
				 * The ten nearest lose their current embedding: pending, so not eligible, and dead tuples in the graph.
				 */
				const removed = before.slice(0, 10)
				for (const [document, revision] of removed) {
					yield* s.admin.query(
						`DELETE FROM ${fx.table("DocumentEmbedding")} WHERE "document" = '${document}'::uuid AND "revision" = ${revision}::bigint`,
						[]
					)
				}
				/** The next ten get a new current revision far from the probe; the old one stays stored, superseded. */
				const far = vectorText(Arr.map(vector, (x) => (x === 0 ? 0 : -x)))
				const superseded = before.slice(10)
				for (const [document] of superseded) {
					yield* s.admin.query(
						`INSERT INTO ${fx.table("DocumentEmbedding")} ("document", "revision", "value") VALUES ('${document}'::uuid, 3::bigint, '${far}'::vector_ext.vector)`,
						[]
					)
					yield* s.admin.query(
						`DELETE FROM ${fx.table("DocumentCurrent")} WHERE "document" = '${document}'::uuid`,
						[]
					)
					yield* s.admin.query(
						`INSERT INTO ${fx.table("DocumentCurrent")} ("document", "revision") VALUES ('${document}'::uuid, 3::bigint)`,
						[]
					)
				}
				const p = yield* plan(session, c, params)
				assert.equal(readsHnsw(fx, p.indexes), true, Formatter.format(p))
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
					assert.equal(gone.has(document), false, `${document} has no current embedding`)
					if (moved.has(document)) {
						assert.equal(revision, "3", `${document} only at its new revision`)
					}
				}
				assert.equal(after.length, 20)
			}),
		300_000
	)

	it.effect("a shared search is computed once and composes with ordinary matching", () =>
		Effect.gen(function* () {
			const fx = yield* installFixture({ candidates, titles, shared })
			const session = yield* searcher(fx)
			const vector = vectorParam(fx.probe(3))
			const near = yield* run(session, compile(candidates, fx.installed, "query"), {
				account: accountB,
				vector
			})
			const t = compile(titles, fx.installed, "query")
			const titled = yield* run(session, t, { account: accountB, vector })
			assert.deepEqual(
				Arr.sort(
					Arr.map(titled, (r) => `${r[1]}:${r[0]}`),
					Order.String
				),
				Arr.sort(
					Arr.map(near, (r) => `${r[1]}:${r[0]}`),
					Order.String
				)
			)
			/** A search two rules read is one MATERIALIZED CTE, one evaluation per execution. */
			const twice = compile(shared, fx.installed, "query")
			assert.ok(has(shapeOf(flight(twice.program.roots)[0].ast), "cte materialized"))
			const both = yield* run(session, twice, { account: accountB, vector })
			const tagged = new Set(
				Arr.map(
					Arr.filter(fx.facts, (d) => d.tags.includes("gamma")),
					(d) => d.id
				)
			)
			const kept = Arr.filter(
				near,
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
		})
	)

	it.effect("an approximate source is refused as page, recursion, law and derived evidence", () =>
		Effect.gen(function* () {
			const fx = yield* installFixture({ candidates })

			/**
			 * A page: the page compiler refuses a page over candidates in both artifacts, while the exact scoring
			 * with the same order pages.
			 */
			const page = (q: unknown) => {
				const template = compileTemplate(q, undefined, {
					...testCompile,
					installation: identity.schema(parsedSchemaName(fx.installed.declared))
				})
				if (!template.ok) {
					throw new Error(template.error.message)
				}
				const input = queryInput(q)
				if (!input.ok) {
					throw new Error(input.error.message)
				}
				const stated = statedOrderOf(input.value.desc, SourceLoc("query", []))
				if (!stated.ok) {
					throw new Error(stated.error.message)
				}
				const artifacts = testArtifacts(AnnSearch, {
					...testCompile,
					installation: identity.schema(parsedSchemaName(fx.installed.declared))
				})
				if (!artifacts.ok) {
					throw new Error(artifacts.error.message)
				}
				return compilePageOf(template.value.programs, {
					stated: stated.value,
					names: fx.installed.names
				})
			}
			const paged = failed(page(titles.orderBy(["distance", "asc"])))
			assert.equal(paged.reason._tag, "UnsupportedOperation")
			assert.equal(page(scoredDocuments.orderBy(["distance", "asc"])).ok, true)

			/** Recursive feedback: a recursion seeded from candidates is refused by the checker. */
			const near = query(AnnSearch).recursive("Near", {
				row: { document: uuid },
				base: [
					(r) => {
						const source = candidates.bind({
							account: r.param("account", Document.fields.account),
							vector: r.param("vector", DocumentEmbedding.fields.value)
						})
						const { document } = v(source, "source")
						return r.match(source, { document }).find({ document })
					}
				],
				rec: [
					(r, self) => {
						const { document } = v(self, "self")
						const { revision } = v(DocumentCurrent, "documentCurrent")
						return r
							.match(self, { document })
							.match(DocumentCurrent, { document, revision })
							.find({ document })
					}
				]
			})
			const recursion = failed(checked(near))
			assertVariant(recursion.reason, "_tag", "RecursionRefused")
			assert.deepEqual(recursion.reason.cause, {
				kind: "approximateSource",
				recursion: "Near"
			})

			/**
			 * A law: no law constructor reads a query, so a violation query over candidates exists only as IR; the
			 * optimized lowering refuses a Forbid over them.
			 */
			const logical = checked(titles)
			if (!logical.ok) {
				throw new Error("titles checks")
			}
			const q = logical.value
			const root = q.dag.roots[0]
			const forbidNode = relNode(NodeId("nz"), {
				kind: "Forbid",
				lawId: wild.lawId("nearest_law"),
				violation: root,
				heading: root.heading,
				meta: root.meta,
				loc: undefined
			})
			const forbid: LogicalQuery = { ...q, dag: rooted([forbidNode]) }
			const options = {
				names: fx.installed.names,
				context: "snapshot",
				catalog: installedCatalog(fx.installed.installation),
				meter: new BudgetMeter(compileBudgets)
			} as const
			const law = failed(lowerAligned(forbid, "query", options))
			assert.equal(law.reason._tag, "UnsupportedOperation")

			/** A derived relation's definition. */
			const definition = failed(lowerAligned(q, "derivedDefinition", options))
			assert.equal(definition.reason._tag, "UnsupportedOperation")
		})
	)
})
