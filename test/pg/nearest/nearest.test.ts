/**
 * Nearest reads on PostgreSQL 19 with pgvector 0.8.7 (nearest.fixtures.ts): a search whose query vector is a stored
 * row's, read by its key (check/approximate/trace.ts Anchor, lower/shapes/vector queryVectorSql), and a step's reads as
 * one record of one statement (query(S).reads, check/checker.ts #attach under a parent of no columns).
 *
 * - A keyed search answers what the two-step reference answers: the item's row read by its key, then the search by
 *   that row's vector as a parameter, or no candidates where no item holds the key; for an anchor that also gives the
 *   candidates' catalog, the search by the row's catalog. Every search here runs on one served Db with no writer beside
 *   it, so each call reads the same database, and PostgreSQL's HNSW search, given one graph and one query vector, the
 *   same candidates.
 * - Its plan, under the advice it carries, holds one scan of the HNSW index, ordered by the vector the
 *   statement reads once, before the scan, from the item's key: a scan that ran for a stored item, and one never
 *   executed for an absent one, whose emptiness the statement's one-time filter states.
 * - A record of reads answers one row, which holds each read's own answer: the search's candidates, the learner's seen
 *   lessons in their order, the item's row, each equal to its read's own answer, read alone; it is one statement, whose
 *   search, under the advice it carries, is one scan of the HNSW index.
 *
 * Oracle: the two-step reference over the same served Db, and each read's own answer; PostgreSQL's executed plan as the
 * served member's explainAnalyze reports it, naming the HNSW index by the installation's names.
 *
 * Features: a stored and an absent item, a search filled and underfilled, a catalog with no lesson, a search served by
 * one HNSW scan with a stored item and never executed with an absent one, a record whose reads all hold rows and one
 * with an empty read.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	candidateTexts,
	hnswScans,
	Nearest,
	type NearestCase,
	nearestCaseGen,
	nearestInstall,
	nearestTemplate,
	populationFacts,
	shownVector,
	take
} from "#test/pg/nearest/nearest.fixtures.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** What a keyed search's case reached. */
type KeyedFeature =
	| "a stored item"
	| "an absent item"
	| "filled"
	| "underfilled"
	| "a catalog with no lesson"
	| "one HNSW scan, ordered by the stored item's vector"
	| "an absent item's HNSW scan never executed"

/** A search whose query vector is a stored item's, by its key, answers what reading the item and then searching by its vector answers, and PostgreSQL serves it from the HNSW index in one scan, which an absent item never runs. */
export const aSearchWhoseQueryVectorIsAStoredItemsByItsKeyAnswersWhatReadingTheItemAndThenSearchingByItsVectorAnswersAndPostgreSQLServesItFromTheHNSWIndexInOneScanWhichAnAbsentItemNeverRuns =
	property.explore(nearestCaseGen, {
		needs: { fixture: Substrate.fresh(nearestTemplate) },
		situations: [
			"a stored item",
			"an absent item",
			"filled",
			"underfilled",
			"a catalog with no lesson",
			"one HNSW scan, ordered by the stored item's vector",
			"an absent item's HNSW scan never executed"
		] satisfies ReadonlyArray<Reached<KeyedFeature>>,
		budget: { runs: 12, steered: 24 },
		check:
			({ fixture }, k: Case<KeyedFeature>) =>
			(c: NearestCase) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(
								Nearest,
								populationFacts(c.population),
								nearestInstall,
								taken
							)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								for (const probe of c.probes) {
									const at = `${Formatter.format(c.population)} at ${Formatter.format(probe)}`
									const keyed = yield* db.workload.fromItem.once({
										params: { item: probe.item, catalog: probe.catalog },
										facts: {}
									})
									const joined = yield* db.workload.sameCatalog.once({
										params: { item: probe.item },
										facts: {}
									})
									const [row, ...more] = yield* db.workload.itemRow.once({
										params: { item: probe.item },
										facts: {}
									})
									assert.equal(more.length, 0, `${at}: an item's key reads one row at most`)
									if (row === undefined) {
										k.note("an absent item")
										assert.deepEqual(
											candidateTexts(keyed),
											[],
											`${at}: an absent item, no candidates`
										)
										assert.deepEqual(
											candidateTexts(joined),
											[],
											`${at}: an absent item, no candidates`
										)
									} else {
										k.note("a stored item")
										const byVector = (catalog: number) =>
											db.workload.byVector.once({
												params: { vector: row.embedding, catalog },
												facts: {}
											})
										const expected = yield* byVector(probe.catalog)
										const ownCatalog = yield* byVector(row.catalog)
										assert.deepEqual(
											candidateTexts(keyed),
											candidateTexts(expected),
											`${at}: the search from the item's key is the search by its vector ${shownVector(row.embedding)}`
										)
										assert.deepEqual(
											candidateTexts(joined),
											candidateTexts(ownCatalog),
											`${at}: the search in the item's own catalog is the search by its vector there`
										)
										k.note(expected.size < take ? "underfilled" : "filled")
										if (expected.size === 0) {
											k.note("a catalog with no lesson")
										}
									}
									const executed = yield* db.workload.fromItem.explainAnalyze({
										params: { item: probe.item, catalog: probe.catalog },
										facts: {}
									})
									const plan = hnswScans(o.installed, executed)
									assert.equal(plan.statements, 1, `${at}: one statement`)
									assert.equal(plan.scans.length, 1, `${at}: one HNSW scan, as its advice carries`)
									const [scan] = plan.scans
									if (scan !== undefined) {
										if (row === undefined) {
											assert.equal(
												scan.actual.loops,
												0,
												`${at}: an absent item's search never runs the HNSW scan`
											)
											k.note("an absent item's HNSW scan never executed")
										} else {
											assert.equal(
												scan.actual.loops,
												1,
												`${at}: a stored item's search runs one HNSW scan`
											)
											k.note("one HNSW scan, ordered by the stored item's vector")
										}
									}
								}
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the two-step reference: the item's row by its key, then the search by its vector, a parameter"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/vector/index.ts",
				original: "\t\t\treturn {\n\t\t\t\tvector,\n\t\t\t\tguard: [\n\t\t\t\t\texists(",
				replacement:
					"\t\t\treturn {\n\t\t\t\tvector,\n\t\t\t\tguard: [],\n\t\t\t\tdropped: [\n\t\t\t\t\texists(",
				why: "A keyed search states no one-time filter, so an absent item's search runs the HNSW scan with a NULL vector; the plan check fails."
			},
			{
				file: "packages/engine/src/lower/shapes/vector/index.ts",
				original:
					"\t\t\tconst vector = (): Expr => {\n\t\t\t\tconst read = anchorRows(cx, env, query.anchors)",
				replacement:
					"\t\t\tconst vector = (): Expr => lowerExpr(cx, query.expr, scope)\n\t\t\tconst unused = (): Expr => {\n\t\t\t\tconst read = anchorRows(cx, env, query.anchors)",
				why: "A keyed search orders by the item's vector as a column of the region, which no index orders by, so no search is ever served from the HNSW index; the plan situation is never reached."
			}
		]
	})

/** What a record's case reached. */
type RecordFeature =
	| "every read holding rows"
	| "an empty read"
	| "a nearest read in the record served by one HNSW scan"

/** A record of reads answers one row holding each read's own answer, the search's candidates, the ordered read's rows in its order and the item's row, in one statement, its search served by one HNSW scan. */
export const aRecordOfReadsAnswersOneRowHoldingEachReadsOwnAnswerTheSearchsCandidatesTheOrderedReadsRowsInItsOrderAndTheItemsRowInOneStatementItsSearchServedByOneHNSWScan =
	property.explore(nearestCaseGen, {
		needs: { fixture: Substrate.fresh(nearestTemplate) },
		situations: [
			"every read holding rows",
			"an empty read",
			"a nearest read in the record served by one HNSW scan"
		] satisfies ReadonlyArray<Reached<RecordFeature>>,
		budget: { runs: 12, steered: 24 },
		check:
			({ fixture }, k: Case<RecordFeature>) =>
			(c: NearestCase) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(
								Nearest,
								populationFacts(c.population),
								nearestInstall,
								taken
							)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								for (const probe of c.probes) {
									const at = `${Formatter.format(c.population)} at ${Formatter.format(probe)}`
									const input = {
										params: {
											"nearest.item": probe.item,
											"nearest.catalog": probe.catalog,
											"seen.learner": probe.learner,
											"item.item": probe.item
										},
										facts: {}
									}
									const [record, ...more] = yield* db.workload.reads.once(input)
									assert.equal(more.length, 0, `${at}: a record is one row`)
									if (record === undefined) {
										return assert.fail(`${at}: a record is one row, not none`)
									}
									const nearest = yield* db.workload.fromItem.once({
										params: { item: probe.item, catalog: probe.catalog },
										facts: {}
									})
									const seen = yield* db.workload.seen.once({
										params: { learner: probe.learner },
										facts: {}
									})
									const item = yield* db.workload.itemRow.once({
										params: { item: probe.item },
										facts: {}
									})
									assert.deepEqual(
										candidateTexts(record.nearest),
										candidateTexts(nearest),
										`${at}: the record's search is the search's own answer`
									)
									assert.deepEqual(
										Arr.map(record.seen, (r) => r.lesson),
										Arr.map([...seen], (r) => r.lesson),
										`${at}: the record's seen lessons are the read's own, in its order`
									)
									assert.deepEqual(
										Arr.map(record.item, (r) => `${r.catalog}|${shownVector(r.embedding)}`),
										Arr.map([...item], (r) => `${r.catalog}|${shownVector(r.embedding)}`),
										`${at}: the record's item is the item's own row`
									)
									k.note(
										record.nearest.length > 0 && record.seen.length > 0 && record.item.length > 0
											? "every read holding rows"
											: "an empty read"
									)
									const executed = yield* db.workload.reads.explainAnalyze(input)
									const plan = hnswScans(o.installed, executed)
									assert.equal(plan.statements, 1, `${at}: a record is one statement`)
									assert.equal(plan.scans.length, 1, `${at}: one HNSW scan, as its advice carries`)
									if (plan.scans.length === 1 && item.size > 0) {
										k.note("a nearest read in the record served by one HNSW scan")
									}
								}
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "each read's own answer, read alone on the same served Db"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\tconst crossProduct = use.columns.size === 0 && isNonEmpty(heading)",
				replacement: "\t\tconst crossProduct = use.columns.size === 0",
				why: "An attachment under a parent of no columns that reads none of it is refused as a cross product, so no record of reads compiles; the fixture's login cannot be served."
			},
			{
				file: "packages/engine/src/query/build/query.ts",
				original: `\t\tnew Map([...queryParamNames(desc)].map((p) => [p, \`\${name}.\${p}\`] as const))`,
				replacement: "\t\tnew Map([...queryParamNames(desc)].map((p) => [p, p] as const))",
				why: "A record's reads keep their own parameter names, so the record's item read and its search share the parameter item, and a call naming each read's parameters under its name is refused."
			}
		]
	})
