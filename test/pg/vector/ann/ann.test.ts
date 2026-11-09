import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { groupingSteps, planIndexNames, planNodeTypes } from "#bench/harness/explain.ts"
import { subtree } from "#compiler/check/approximate/trace.ts"
import type { RelDag } from "#compiler/ir/rel.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import {
	accountA,
	accountB,
	accountC,
	anyRevision,
	type Compiled,
	candidates,
	compile,
	DocumentEmbedding,
	duplicatePair,
	type Fixture,
	installFixture,
	installLabelled,
	repeated,
	shared,
	sizes,
	textRows,
	titles,
	unfiltered,
	untagged,
	vectorParam,
	vectorText
} from "#test/pg/vector/ann/support.ts"
import { assert, contains, defined, nonEmpty } from "#test/support/assert.ts"
import { paramTexts, scalarsOnly } from "#test/support/compile.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { caseHang } from "#test/support/limits.ts"
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
	return Effect.map(session.values(spec.sql, paramTexts(spec, params, scalarsOnly)), textRows)
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
			paramTexts(spec, params, scalarsOnly)
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

/** An account of the fixture, by the letter its size is listed under. */
type AccountLabel = keyof typeof sizes

/** Each of the fixture's accounts by its letter. */
const accountOf: { readonly [L in AccountLabel]: string } = {
	A: accountA,
	B: accountB,
	C: accountC
}

/** An account of the fixture and the letter a report names it by. */
type Account = readonly [account: string, label: AccountLabel]

/** The fixture's accounts, every one its sizes list. */
const accounts: Arr.NonEmptyReadonlyArray<Account> = Arr.map(
	nonEmpty(Rec.keys(sizes), "the fixture's accounts"),
	(label): Account => [accountOf[label], label]
)

/** How many candidates a search requests. */
const requested = 20

/** The accounts with more documents than a request: those whose probes the recall floor is measured over. */
const recalled = nonEmpty(
	Arr.filter(accounts, ([, label]) => sizes[label] > requested),
	"the accounts larger than a request"
)

/** An account searched, by its letter, or what a search came to. */
type SearchFeature =
	| `account ${AccountLabel}`
	| "underfilled by a small account"
	| "filled under the policy, underfilled by the default search"
	| "a negated tag excluded"

/** An account of `among` searched with a probe `probes` draws. */
const probed =
	(
		among: Arr.NonEmptyReadonlyArray<Account>,
		probes: Gen<number>
	): Gen<readonly [Account, number]> =>
	(source) =>
		[source.draw(element(among)), source.draw(probes)] as const

/** A case of the recall box: a probe of an account by its number, or account A's duplicate embedding. */
type RecallProbe =
	| { readonly kind: "duplicate" }
	| {
			readonly kind: "probe"
			readonly account: Account
			readonly seed: number
	  }

/** Each of `probes` probes, numbered from 10, of each recalled account, and the duplicate. */
const recallProbeGen =
	(probes: number): Gen<RecallProbe> =>
	(source) =>
		source.draw(boolean)
			? { kind: "duplicate" }
			: {
					kind: "probe",
					account: source.draw(element(recalled)),
					seed: 10 + source.draw(int(0, probes - 1))
				}

type RecallFeature = `account ${AccountLabel}` | "duplicate"

/**
 * A transaction's changes to account B's nearest candidates: how many of the nearest lose their current embedding, and
 * how many after them get a new current revision, of the probe numbered `seed`.
 */
interface Superseding {
	readonly seed: number
	readonly removed: number
	readonly superseded: number
}

const supersededGen: Gen<Superseding> = (source) => {
	const kind = source.draw(element(["removed", "superseded", "both"] as const))
	return {
		seed: source.draw(int(30, 59)),
		removed: kind === "superseded" ? 0 : source.draw(int(1, 12)),
		superseded: kind === "removed" ? 0 : source.draw(int(1, 8))
	}
}

type SupersededFeature =
	| "nearest embeddings removed"
	| "nearest revisions superseded"
	| "both, in one transaction"

const supersededFeatures = (c: Superseding): ReadonlyArray<SupersededFeature> => [
	...(c.removed > 0 ? ["nearest embeddings removed" as const] : []),
	...(c.superseded > 0 ? ["nearest revisions superseded" as const] : []),
	...(c.removed > 0 && c.superseded > 0 ? ["both, in one transaction" as const] : [])
]

const searcher = (fx: Fixture) =>
	Effect.flatMap(Substrate, (s) =>
		s.session({ ...worldSession(fx.installed.world(fx.app)), label: "searcher" })
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
					for (const setting of searchPolicySettings) {
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
					return yield* exhaust(
						{
							suite: "vector/ann/candidates",
							generator: probed(accounts, int(1, 3)),
							literal: ([[, label], seed]: readonly [Account, number]) =>
								`account ${label}, probe ${seed}`,
							limit: accounts.length * 3,
							box: "every account of the fixture, with each of its first three probes",
							oracle: {
								kind: "second-implementation",
								name: "the exact baseline: the eligible relation scored with cosine_distance"
							},
							coverage: requiredInSpace<SearchFeature>([
								...Arr.map(accounts, ([, label]): SearchFeature => `account ${label}`),
								"underfilled by a small account"
							]),
							caseHang
						},
						([[account, label], seed], k) =>
							Effect.gen(function* () {
								const vector = fx.probe(seed)
								const rows = yield* run(session, c, { account, vector: vectorParam(vector) })
								const exact = yield* exactScores(session, fx, account, vector)
								const scores = new Map(Arr.map(exact, (r) => [key(r), r[2]]))
								assert.ok(rows.length <= requested, label)
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
								assert.ok(rows.length <= exact.length, label)
								if (exact.length < requested) {
									k.note("underfilled by a small account")
								}
								k.note(`account ${label}`)
							})
					)
				})
			)
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
					return yield* exhaust(
						{
							suite: "vector/ann/policy",
							generator: int(21, 23),
							literal: (seed: number) => `probe ${seed}`,
							limit: 3,
							box: "the probes numbered 21 to 23 of the label-fixed population",
							oracle: {
								kind: "second-implementation",
								name: "the exact baseline, and the same search under the default HNSW scan"
							},
							coverage: requiredInSpace<SearchFeature>([
								"filled under the policy, underfilled by the default search"
							]),
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
								k.note("filled under the policy, underfilled by the default search")
							})
					)
				})
			)
	)

	it.effect(
		"a retained key needs no DISTINCT and the plan is driven by the HNSW index; fanout keeps its deduplication",
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
					assert.deepEqual(groupingSteps(directPlan.nodes), [], Formatter.format(directPlan))
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
					assert.deepEqual(groupingSteps(keyedPlan.nodes), [], Formatter.format(keyedPlan))
					assert.equal(hnsw(keyedPlan.indexes), true, Formatter.format(keyedPlan))

					/** Every revision, the revision projected away: multiplicity resolved before top-k. */
					const fanout = compile(anyRevision, fx.installed, "query")
					contains(
						Arr.map(fanout.program.certificates, (x) => x.rule),
						"approximateNearest.deduplicated"
					)
					assert.ok(has(shapeOf(flight(fanout.program.roots)[0].ast), "distinct"))
					const fanoutPlan = yield* plan(session, fanout, { account: accountA, vector })
					assert.notDeepEqual(groupingSteps(fanoutPlan.nodes), [], Formatter.format(fanoutPlan))
					assert.equal(hnsw(fanoutPlan.indexes), true, Formatter.format(fanoutPlan))

					const repeating = nonEmpty(
						Arr.filter(accounts, ([account]) => repeated(fx.facts, account).length > 0),
						"the accounts with a repeated document"
					)
					return yield* exhaust(
						{
							suite: "vector/ann/fanout",
							generator: element(repeating),
							literal: ([, label]: Account) => `account ${label}`,
							limit: repeating.length,
							box: "every account of the fixture with a document whose superseded revision repeats its current one",
							oracle: {
								kind: "second-implementation",
								name: "the exact baseline of every distinct (document, distance)"
							},
							coverage: requiredInSpace<SearchFeature>(
								Arr.map(repeating, ([, label]): SearchFeature => `account ${label}`)
							),
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
								if (sizes[label] < requested) {
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
			)
	)

	it.effect(
		"recall against the exact baseline holds its floor over a label-fixed population, ties and duplicates under different keys are distinct facts",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fx = yield* installLabelled({ candidates }, "pg/vector/ann/recall")
					const session = yield* searcher(fx)
					const c = compile(candidates, fx.installed, "query")
					const recalls: Array<string> = []
					let hits = 0
					let wanted = 0
					const probes = 10
					const exhausted = yield* exhaust(
						{
							suite: "vector/ann/recall",
							generator: recallProbeGen(probes),
							literal: Formatter.format,
							limit: 1 + recalled.length * probes,
							box: "the probes numbered 10 to 19 of every account larger than a request, and account A's duplicate embedding",
							oracle: {
								kind: "second-implementation",
								name: "the exact baseline: the eligible relation scored with cosine_distance"
							},
							coverage: requiredInSpace<RecallFeature>([
								...Arr.map(recalled, ([, label]): RecallFeature => `account ${label}`),
								"duplicate"
							]),
							caseHang
						},
						(probe, k) =>
							Effect.gen(function* () {
								if (probe.kind === "duplicate") {
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
									k.note("duplicate")
									return
								}
								const [account, label] = probe.account
								const vector = fx.probe(probe.seed)
								const rows = yield* run(session, c, { account, vector: vectorParam(vector) })
								const scored = yield* exactScores(session, fx, account, vector)
								const scores = new Map(Arr.map(scored, (r) => [key(r), r[2]]))
								for (const row of rows) {
									const [document, revision, distance] = asTriple(row)
									assert.equal(
										scores.get(`${document}/${revision}`),
										distance,
										`${label}${probe.seed} ${document}/${revision}`
									)
								}
								const exact = scored.slice(0, 20)
								const got = new Set(Arr.map(rows, (r) => `${r[1]}/${r[2]}`))
								const found = Arr.filter(exact, (r) => got.has(key(r))).length
								hits += found
								wanted += exact.length
								recalls.push(`${label}${probe.seed}=${found}/${exact.length}`)
								k.note(`account ${label}`)
							})
					)
					/**
					 * Whether the whole box ran: the floor holds over it, and a replay runs one case of it, whose one
					 * probe's recall is no statement about the floor.
					 */
					const wholeBox = exhausted.cases === exhausted.limit
					if (wholeBox) {
						const recall = hits / wanted
						const pinned = Arr.join(
							Arr.map(searchPolicySettings, (setting) => `${setting.parameter} ${setting.value}`),
							", "
						)
						const record = `recall@20 of approximateNearest against the exact baseline, HNSW at pgvector's build parameters and the cluster's search settings, ${pinned}, ${sizes.A + sizes.B + sizes.C} documents of 8 dimensions: ${recall.toFixed(4)} (${Arr.join(recalls, " ")})`
						yield* Effect.promise(() => ctx.annotate(record))
						yield* Effect.log(record)
						assert.ok(recall > 0.8, record)
					}
					return exhausted
				})
			)
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
					return yield* exhaust(
						{
							suite: "vector/ann/negation",
							generator: int(51, 53),
							literal: (seed: number) => `probe ${seed}`,
							limit: 3,
							box: "the probes numbered 51 to 53",
							oracle: {
								kind: "second-implementation",
								name: "the exact baseline with the gamma-tagged documents removed on the host"
							},
							coverage: requiredInSpace<SearchFeature>(["a negated tag excluded"]),
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
								k.note("a negated tag excluded")
							})
					)
				})
			)
	)

	it.effect(
		"dead tuples and superseded revisions still in the HNSW graph never reach the candidates",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fx = yield* installFixture({ candidates })
					const session = yield* searcher(fx)
					const c = compile(candidates, fx.installed, "query")
					return yield* explore(
						{
							suite: "vector/ann/superseded",
							draw: drawn(supersededGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the exact baseline over the facts the transaction sees"
							},
							coverage: required<SupersededFeature>(
								[
									"nearest embeddings removed",
									"nearest revisions superseded",
									"both, in one transaction"
								],
								{ cases: 12, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(drawnCase, k) =>
							Effect.ensuring(
								Effect.gen(function* () {
									const vector = fx.probe(drawnCase.seed)
									const params = { account: accountB, vector: vectorParam(vector) }
									yield* session.begin
									const nearest = yield* run(session, c, params)
									const before = Arr.map(nearest, asTriple)
									assert.equal(before.length, 20)
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
									assert.equal(after.length, Math.min(20, exact.size))
									k.noteAll(supersededFeatures(drawnCase))
								}),
								Effect.orDie(session.rollback)
							)
					)
				})
			)
	)

	it.effect("a shared search is computed once and composes with ordinary matching", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const fx = yield* installFixture({ candidates, titles, shared })
				const session = yield* searcher(fx)
				const near = compile(candidates, fx.installed, "query")
				const t = compile(titles, fx.installed, "query")
				/** A search two rules read is one MATERIALIZED CTE, one evaluation per execution. */
				const twice = compile(shared, fx.installed, "query")
				assert.ok(has(shapeOf(flight(twice.program.roots)[0].ast), "cte materialized"))
				const tagged = new Set(
					Arr.map(
						Arr.filter(fx.facts, (d) => d.tags.includes("gamma")),
						(d) => d.id
					)
				)
				return yield* explore(
					{
						suite: "vector/ann/shared",
						draw: drawn(
							(source) => [source.draw(element(accounts)), source.draw(int(60, 99))] as const
						),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the search's own candidates, filtered on the host as each rule reads them"
						},
						coverage: required<SearchFeature>(
							Arr.map(accounts, ([, label]): SearchFeature => `account ${label}`),
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 8,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					([[account, label], seed], k) =>
						Effect.gen(function* () {
							const vector = vectorParam(fx.probe(seed))
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
						})
				)
			})
		)
	)
})
