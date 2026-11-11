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
 * Plants: vector-policy-dropped (the installer stores no search policy, so HNSW's default scan underfills a filtered
 * request), vector-indexed-distinct (a retained key keeps a DISTINCT), vector-ann-take-off-by-one (the bound takes one
 * candidate fewer).
 *
 * Features: each account, an underfilled request, the duplicate embedding, a search the HNSW index serves, each kind of
 * superseding, and a negated tag excluded. Whether PostgreSQL serves a search from the HNSW index is the planner's
 * choice, never grizzle's contract, so it is a feature a search must reach, not an assertion.
 */
import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { planIndexNames } from "#bench/harness/explain.ts"
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
import { paramTexts, programAsts, scalarsOnly } from "#test/support/compile.ts"
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

const run = (session: RawSession, c: Compiled, params: Readonly<Record<string, unknown>>) => {
	const spec = defined(c.specs[0], "statement 0")
	return Effect.map(session.values(spec.sql, paramTexts(spec, params, scalarsOnly)), textRows)
}

/** Whether PostgreSQL plans the executable statement with its parameters over the HNSW index. */
const servedByHnsw = (
	session: RawSession,
	fx: Fixture,
	c: Compiled,
	params: Readonly<Record<string, unknown>>
) =>
	Effect.gen(function* () {
		const spec = defined(c.specs[0], "statement 0")
		const rows = yield* session.values(
			`EXPLAIN (FORMAT JSON, COSTS FALSE) ${spec.sql}`,
			paramTexts(spec, params, scalarsOnly)
		)
		const [explained] = defined(rows[0], "the EXPLAIN row")
		return readsHnsw(fx, planIndexNames(explained))
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
 * The exact baseline of anyRevision: every distinct (document, distance) of an account's revisions, scored with
 * cosine_distance, which no index orders.
 */
const exactDistinct = (
	session: RawSession,
	fx: Fixture,
	account: string,
	vector: ReadonlyArray<number>
) =>
	Effect.map(
		session.values(
			`SELECT DISTINCT e."document"::text, vector_ext.cosine_distance(e."value", $1::text::vector_ext.vector)::text
			 FROM ${fx.table("DocumentEmbedding")} AS e
			 JOIN ${fx.table("Document")} AS d ON d."id" = e."document"
			 WHERE d."account" = $2::text::uuid`,
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

/** The bound each program of the fixture states (support.ts): candidates' and untagged's, then the others'. */
const candidatesTake = 20
const anyRevisionTake = 10

/** A probe a test numbers: any number names a query vector of the run's draw (support.ts probeOf). */
const probeNumber: Gen<number> = int(0, 2 ** 31 - 1)

/** A search of the candidates: an account probed with a drawn vector, or account A's shared embedding. */
type CandidateProbe =
	| { readonly kind: "drawn"; readonly account: Account; readonly n: number }
	| { readonly kind: "duplicate" }

const candidateProbeGen: Gen<CandidateProbe> = weighted<CandidateProbe>([
	[
		8,
		(source) => ({
			kind: "drawn",
			account: source.draw(element(accounts)),
			n: source.draw(probeNumber)
		})
	],
	[1, () => ({ kind: "duplicate" })]
])

/** What a search came to. */
type SearchFeature =
	| `account ${AccountLabel}`
	| "underfilled by a small account"
	| "the duplicate embedding"
	| "served by the HNSW index"
	| "a negated tag excluded"
	| "a repeated document probed with its own embedding"

/**
 * A transaction's changes to account B's nearest candidates: how many of the nearest lose their current embedding, and
 * how many after them get a new current revision, of the probe numbered `n`.
 */
interface Superseding {
	readonly n: number
	readonly removed: number
	readonly superseded: number
}

const supersededGen: Gen<Superseding> = (source) => {
	const kind = source.draw(element(["removed", "superseded", "both"] as const))
	return {
		n: source.draw(probeNumber),
		removed: kind === "superseded" ? 0 : source.draw(int(1, 12)),
		superseded: kind === "removed" ? 0 : source.draw(int(1, 8))
	}
}

type SupersededFeature =
	| "nearest embeddings removed"
	| "nearest revisions superseded"
	| "both, in one transaction"
	| "served by the HNSW index"

const supersededFeatures = (c: Superseding): ReadonlyArray<SupersededFeature> => [
	...(c.removed > 0 ? ["nearest embeddings removed" as const] : []),
	...(c.superseded > 0 ? ["nearest revisions superseded" as const] : []),
	...(c.removed > 0 && c.superseded > 0 ? ["both, in one transaction" as const] : [])
]

const searcher = (fx: Fixture) =>
	Effect.flatMap(Substrate, (s) =>
		s.session({ ...worldSession(fx.installed.world(fx.app)), label: "searcher" })
	)

/** Each search's budget beside its suite, draw, oracle and coverage. */
const spec = {
	literal: Formatter.format,
	kept: [],
	runs: 12,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 4,
	caseHang
} as const

layer(Substrate.layer)("approximateNearest on PostgreSQL 19", (it) => {
	it.effect(
		"candidates are eligible facts at their exact scores, fill the request up to the eligible facts, and keep facts of one embedding apart",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fx = yield* installFixture({ candidates })
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
					return yield* explore(
						{
							...spec,
							suite: "vector/ann/candidates",
							draw: drawn(candidateProbeGen),
							oracle: {
								kind: "second-implementation",
								name: "the exact baseline: the eligible relation scored with cosine_distance"
							},
							coverage: required<SearchFeature>(
								[
									...Arr.map(accounts, ([, label]): SearchFeature => `account ${label}`),
									"underfilled by a small account",
									"the duplicate embedding",
									"served by the HNSW index"
								],
								{ cases: spec.runs, sense: notesOnly }
							)
						},
						(probe, k) =>
							Effect.gen(function* () {
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
							})
					)
				})
			)
	)

	it.effect(
		"reads a retained key with no DISTINCT and keeps a fanout's DISTINCT, as each program's certificate states",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const programs = { candidates, anyRevision, unfiltered }
					const fx = yield* installFixture(programs)
					const names = nonEmpty(Rec.keys(programs), "the fixture's single searches")
					return yield* exhaust(
						{
							suite: "vector/ann/shapes",
							generator: element(names),
							literal: Formatter.format,
							limit: names.length,
							box: "every program of the fixture that is one approximate search over a stored source",
							oracle: {
								kind: "specification",
								name: "approximateNearest.indexed reads its key with no DISTINCT, approximateNearest.deduplicated keeps one"
							},
							coverage: requiredInSpace<"indexed" | "deduplicated">(["indexed", "deduplicated"]),
							caseHang
						},
						(name, k) =>
							Effect.sync(() => {
								const compiled = compile(programs[name], fx.installed, "query")
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
					)
				})
			)
	)

	it.effect(
		"a search over every revision delivers each (document, distance) once, a pair of its revisions, filling its bound",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fx = yield* installFixture({ anyRevision })
					const session = yield* searcher(fx)
					const fanout = compile(anyRevision, fx.installed, "query")
					const repeating = nonEmpty(
						Arr.filter(accounts, ([account]) => repeated(fx.facts, account).length > 0),
						"the accounts with a repeated document"
					)
					return yield* explore(
						{
							...spec,
							suite: "vector/ann/fanout",
							draw: drawn(
								(source) =>
									[
										source.draw(element(repeating)),
										source.draw(
											weighted<number | "its own embedding">([
												[1, () => "its own embedding" as const],
												[2, probeNumber]
											])
										)
									] as const
							),
							oracle: {
								kind: "second-implementation",
								name: "the exact baseline of every distinct (document, distance)"
							},
							coverage: required<SearchFeature>(
								[
									...Arr.map(repeating, ([, label]): SearchFeature => `account ${label}`),
									"a repeated document probed with its own embedding"
								],
								{ cases: spec.runs, sense: notesOnly }
							)
						},
						([[account, label], probe], k) =>
							Effect.gen(function* () {
								const twice = defined(
									repeated(fx.facts, account)[0],
									`${label}'s repeated document`
								)
								const vector =
									probe === "its own embedding"
										? defined(twice.embeddings[0], "its embedding").value
										: fx.probe(probe)
								const rows = yield* run(session, fanout, { account, vector: vectorParam(vector) })
								const exact = yield* exactDistinct(session, fx, account, vector)
								const pairs = new Set(Arr.map(exact, (r) => `${r[0]}|${r[1]}`))
								const delivered = Arr.map(rows, ([distance, document]) => `${document}|${distance}`)
								assert.equal(new Set(delivered).size, rows.length, `${label}: each pair once`)
								for (const pair of delivered) {
									assert.ok(pairs.has(pair), `${label} ${pair}: a pair of the document's revisions`)
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
							})
					)
				})
			)
	)

	it.effect("a negation in the source restricts the eligible universe before the bound", (ctx) =>
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
				return yield* explore(
					{
						...spec,
						suite: "vector/ann/negation",
						draw: drawn(
							(source) => [source.draw(element(accounts)), source.draw(probeNumber)] as const
						),
						oracle: {
							kind: "second-implementation",
							name: "the exact baseline with the gamma-tagged documents removed on the host"
						},
						coverage: required<SearchFeature>(
							["a negated tag excluded", "served by the HNSW index"],
							{ cases: spec.runs, sense: notesOnly }
						)
					},
					([[account, label], n], k) =>
						Effect.gen(function* () {
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
								assert.equal(gamma.has(document), false, `${label} ${document} is not tagged gamma`)
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
							...spec,
							suite: "vector/ann/superseded",
							draw: drawn(supersededGen),
							oracle: {
								kind: "second-implementation",
								name: "the exact baseline over the facts the transaction sees"
							},
							coverage: required<SupersededFeature>(
								[
									"nearest embeddings removed",
									"nearest revisions superseded",
									"both, in one transaction",
									"served by the HNSW index"
								],
								{ cases: spec.runs, sense: notesOnly }
							)
						},
						(drawnCase, k) =>
							Effect.ensuring(
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
										assert.equal(gone.has(document), false, `${document} has no current embedding`)
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
				assert.ok(has(shapeOf(programAsts(twice.program)[0]), "cte materialized"))
				const tagged = new Set(
					Arr.map(
						Arr.filter(fx.facts, (d) => d.tags.includes("gamma")),
						(d) => d.id
					)
				)
				return yield* explore(
					{
						...spec,
						suite: "vector/ann/shared",
						draw: drawn(
							(source) => [source.draw(element(accounts)), source.draw(probeNumber)] as const
						),
						oracle: {
							kind: "second-implementation",
							name: "the search's own candidates, filtered on the host as each rule reads them"
						},
						coverage: required<SearchFeature>(
							Arr.map(accounts, ([, label]): SearchFeature => `account ${label}`),
							{ cases: spec.runs, sense: notesOnly }
						)
					},
					([[account, label], n], k) =>
						Effect.gen(function* () {
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
						})
				)
			})
		)
	)
})
