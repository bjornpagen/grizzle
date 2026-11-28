/**
 * Full text search on PostgreSQL 19 (search.fixtures.ts): a search document is a generated field PostgreSQL parses from
 * its row's texts under its configuration (ir/search.ts), matched and ranked against a query PostgreSQL parses under the
 * document's own configuration, its matches served by the GIN index the workload's matches request.
 *
 * - A match and its ranks: over drawn catalogs and queries, a websearch query's matches of a subject's lessons up to a
 *   grade are exactly the lessons PostgreSQL's own parse of their stored title and summary matches under those filters,
 *   each with the ts_rank and ts_rank_cd PostgreSQL's own parse gives, to the bit; the `take` best are that set ordered
 *   by rank, best first, ties broken by lesson, as a LIMIT cuts it; a plain query's matches of notes under simple are
 *   PostgreSQL's own, each with its cover density; and each lesson's stored document is the text PostgreSQL's parse
 *   prints, weights and positions included.
 * - At scale: over thousands of lessons of which every few hundredth holds a marker word, a query of that marker reads
 *   Lesson through its GIN index, with no sequential scan of the table, and touches buffers in proportion to the lessons
 *   it matches, never to the table.
 *
 * Oracle: PostgreSQL itself, its to_tsvector, setweight, websearch_to_tsquery, plainto_tsquery, ts_rank and ts_rank_cd
 * applied in plain SQL to the stored texts, never to the stored document, read in the served Db's database after the
 * load; and PostgreSQL's executed plan as the served member's explainAnalyze reports it over Lesson analyzed as
 * production's runbook analyzes an installation after its first load (search.fixtures.ts analyzed), naming the GIN
 * index by the installation's names. The host computes no text search: it is PostgreSQL's alone (ir/search.ts).
 *
 * Features: a query some lessons match and one none does, a take that cuts its matches short, a plain query some note
 * matches, and a match at scale served by the GIN index.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	analyzed,
	byKey,
	Catalog,
	lessonReads,
	populationFacts,
	rankText,
	referenceDocuments,
	referenceMatching,
	referencePlainNotes,
	referenceRanked,
	type Scaled,
	type SearchCase,
	scaledFacts,
	scaledGen,
	searchCaseGen,
	searchInstall,
	searchTemplate
} from "#test/pg/search/search.fixtures.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** What a match's case reached. */
type MatchFeature =
	| "a query some lessons match"
	| "a query no lesson matches"
	| "a take cut short of its matches"
	| "a plain query some note matches"

/**
 * A match and its ranks are what PostgreSQL's own parse of the stored texts answers, its take that set best first, and every stored document the text PostgreSQL's parse prints.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/search/search.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/search/search.test.ts` at its budget before,
 *   `{ runs: 24, steered: 48 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the
 *   red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path
 *   in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its 3 kills went red on case 0 of its floor stream, case 5 of its floor stream and case 0 of its floor
 *   stream, in the order it declares them
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 6 cases: 21; no headroom:
 *   a kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const aMatchAndItsRanksAreWhatPostgreSQLsOwnParseOfTheStoredTextsAnswersItsTakeThatSetBestFirstAndEveryStoredDocumentTheTextPostgreSQLsParsePrints =
	property.explore(searchCaseGen, {
		needs: { fixture: Substrate.fresh(searchTemplate) },
		situations: [
			"a query some lessons match",
			"a query no lesson matches",
			"a take cut short of its matches",
			"a plain query some note matches"
		] satisfies ReadonlyArray<Reached<MatchFeature>>,
		budget: { runs: 21, steered: 48 },
		check:
			({ fixture }, k: Case<MatchFeature>) =>
			(c: SearchCase) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(
								Catalog,
								populationFacts(c.population),
								searchInstall,
								taken
							)
							const { session } = yield* Substrate
							const reference = yield* session({ ...ownerSession(), label: "search reference" })
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const documents = yield* db.workload.documents.once({ params: {}, facts: {} })
								const parsed = yield* referenceDocuments(reference, o.installed)
								assert.deepEqual(
									byKey(Arr.map([...documents], (d) => [`${d.lesson}`, d.search])),
									parsed,
									"each stored document is the text PostgreSQL's parse of its title and summary prints"
								)
								for (const probe of c.probes) {
									const at = `${Formatter.format(c.population)} at ${Formatter.format(probe)}`
									const params = { q: probe.websearch, subject: probe.subject, grade: probe.grade }
									const matches = yield* db.workload.matching.once({ params, facts: {} })
									const expected = yield* referenceMatching(reference, o.installed, probe)
									assert.deepEqual(
										byKey(
											Arr.map([...matches], (m) => [
												`${m.lesson}`,
												rankText(m.rank),
												rankText(m.cover)
											])
										),
										expected,
										`${at}: the matches and their ranks are PostgreSQL's own`
									)
									k.note(
										expected.length > 0 ? "a query some lessons match" : "a query no lesson matches"
									)
									const best = yield* db.workload.ranked.once({
										params: { ...params, take: probe.take },
										facts: {}
									})
									const expectedBest = yield* referenceRanked(reference, o.installed, probe)
									const got: ReadonlyArray<ReadonlyArray<string>> = Arr.map(
										[...best],
										(m): ReadonlyArray<string> => [`${m.lesson}`, rankText(m.rank)]
									)
									assert.deepEqual(
										got,
										expectedBest,
										`${at}: the take is the matches best first, ties by lesson`
									)
									if (best.size < expected.length) {
										k.note("a take cut short of its matches")
									}
									const notes = yield* db.workload.plainNotes.once({
										params: { q: probe.plain },
										facts: {}
									})
									const expectedNotes = yield* referencePlainNotes(reference, o.installed, probe)
									assert.deepEqual(
										byKey(Arr.map([...notes], (m) => [`${m.note}`, rankText(m.cover)])),
										expectedNotes,
										`${at}: a plain query's matches of notes are PostgreSQL's own under simple`
									)
									if (expectedNotes.length > 0) {
										k.note("a plain query some note matches")
									}
								}
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "postgresql",
			name: "to_tsvector, setweight, websearch_to_tsquery, plainto_tsquery, ts_rank and ts_rank_cd over the stored texts in plain SQL"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/search/index.ts",
				original: '\twebsearch: "websearch_to_tsquery",',
				replacement: '\twebsearch: "plainto_tsquery",',
				why: "A websearch query is read as a plain one, so a negated term, an `or` or a quoted phrase matches other lessons than PostgreSQL's own websearch parse; the matches differ."
			},
			{
				file: "packages/engine/src/lower/conservative/search/index.ts",
				original: '\t\t\treturn call("ts_rank", [document, query])',
				replacement: '\t\t\treturn call("ts_rank_cd", [document, query])',
				why: "A rank is the cover density's, so a lesson's rank differs from PostgreSQL's ts_rank of its texts; the ranks differ."
			},
			{
				file: "packages/engine/src/lower/conservative/search/index.ts",
				original: "\t\t\t\tlit.text(weight.value.value, types.char)",
				replacement: '\t\t\t\tlit.text("D", types.char)',
				why: "Every part is weighted D, so the stored document prints other weights than PostgreSQL's parse of the title and summary, and a title's match ranks as low as a summary's; the documents differ."
			}
		]
	})

/**
 * At scale, a match of a marker word few lessons hold reads Lesson through the GIN index, with no sequential scan, and touches buffers in proportion to its matches.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/search/search.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/search/search.test.ts` at its budget before,
 *   `{ runs: 4, steered: 4 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const atScaleAMatchOfAMarkerWordFewLessonsHoldReadsLessonThroughTheGINIndexWithNoSequentialScanAndTouchesBuffersInProportionToItsMatches =
	property.explore(scaledGen, {
		needs: { fixture: Substrate.fresh(searchTemplate) },
		situations: ["a match at scale served by the GIN index"] satisfies ReadonlyArray<
			Reached<"a match at scale served by the GIN index">
		>,
		budget: { runs: 1, steered: 4 },
		check:
			({ fixture }, k: Case<"a match at scale served by the GIN index">) =>
			(c: Scaled) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(Catalog, scaledFacts(c), searchInstall, taken)
							yield* analyzed(o.installed)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const input = {
									params: { q: c.marker, subject: 0, grade: 12 },
									facts: {}
								}
								const matches = yield* db.workload.matching.once(input)
								const executed = yield* db.workload.matching.explainAnalyze(input)
								const reads = lessonReads(o.installed, executed)
								const at = `${Formatter.format(c)}: ${matches.size} matches`
								assert.equal(reads.statements, 1, `${at}: one statement`)
								assert.equal(reads.sequential.length, 0, `${at}: no sequential scan of Lesson`)
								assert.ok(reads.gin.length > 0, `${at}: Lesson read through its GIN index`)
								assert.ok(
									reads.buffers <= marginBuffers + matches.size * buffersPerMatch,
									`${at}: ${reads.buffers} buffers, within ${marginBuffers} and ${buffersPerMatch} a match`
								)
								k.note("a match at scale served by the GIN index")
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "postgresql",
			name: "the served member's executed plan, its nodes named by the installation"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original: '\t\tconst search = matched("search")\n',
				replacement: "\t\tconst search = undefined\n",
				why: "The binding reads no search document's match: the read of Lesson is a scan its plan states, it asks no GIN index, none is installed, and PostgreSQL reads Lesson sequentially; the plan check fails."
			},
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original: "\tFilter: realized(facts, searchFenced(conservativeLowerers.Filter)),",
				replacement: "\tFilter: realized(facts, conservativeLowerers.Filter),",
				why: "The text search unfenced: its match a filter beside the subject's and the grade's, so the declared statistics of those choose the read, and Lesson is read through another index than its GIN."
			}
		]
	})

/** The buffers a GIN search's descent and its query's posting lists take, whatever it matches. */
const marginBuffers = 16

/** The buffers a match takes past the margin: its heap page, and its posting list's share. */
const buffersPerMatch = 2
