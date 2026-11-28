/**
 * A region reads a fold it joins once per row before it only where one row comes before it, and otherwise once per
 * distinct key of those rows (lower/shapes/share/sites.ts sitesAtRows, oneRowBefore; share/keys.ts KeyAnalysis): the
 * global maximum main ruled on 2026-11-28, each relation read once (test/pg/contracts statement-size, C1) and the fold
 * derived once per distinct key. Where every step of the region's chain before the fold is of rank `key`, one row, the
 * fold is read once at that row's values, LATERAL, and no key set scans that row's relation a second time to find its
 * one key; where the rows before it may repeat a key, it is derived at the DISTINCT key set of those rows, once a key,
 * never again for each row that repeats one.
 *
 * On PostgreSQL 19 (row-sites.fixtures.ts): Note, each document's notes, folded by document (perDoc); a read of the
 * fold at the document of the owner its parameter keys (byOwner), one at the documents of an item's pins, twelve
 * places over three documents (byPins), and the notes no flag holds, a live derivation of two sources, at the documents
 * of an item's three pins, each its own (unflaggedByPins), which the binding reads at each pin's document (sql/bind.ts
 * derivedEntry) where rule 5b derived it whole as the statement's CTE. Oracle: specification, counted off the reads'
 * executed plans (EXPLAIN ANALYZE, each scan's loops and rows): byOwner scans Owner once and runs Note's scans once;
 * byPins runs Note's scans at most once per distinct document its pins name; unflaggedByPins' scans of Note return the
 * pins' documents' notes alone; each read's rows are the derivation's at its documents.
 *
 * Features: a row in hand; rows that repeat a document; rows of distinct documents.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	notesPerDoc,
	type RowSitesCase,
	relationWork,
	rowSitesFacts,
	rowSitesGen,
	Sites,
	sitesInstall,
	sitesTemplate
} from "#test/pg/lower-shapes/row-sites.fixtures.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A region reads a fold once per row before it where that is one row, else once per distinct key of those rows. */
export const aRegionReadsAFoldOncePerRowOnlyWhereOneRowComesBeforeItElseOncePerDistinctKey =
	property.exhaust(finite(rowSitesGen), {
		needs: { fixture: Substrate.fresh(sitesTemplate) },
		situations: [
			"a row in hand",
			"rows that repeat a document",
			"rows of distinct documents"
		] satisfies ReadonlyArray<Reached<RowSitesCase["kind"]>>,
		check:
			({ fixture }, k: Case<RowSitesCase["kind"]>) =>
			(c: RowSitesCase) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(Sites, rowSitesFacts(c), sitesInstall, taken)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const at = Formatter.format(c)
								switch (c.kind) {
									case "a row in hand": {
										const input = { params: { id: 1 }, facts: {} }
										const rows = yield* db.workload.byOwner.once(input)
										const executed = yield* db.workload.byOwner.explainAnalyze(input)
										assert.equal(rows.size, 1, `${at}: the owner's document's count`)
										assert.deepEqual(
											relationWork(executed, "Owner").scans,
											1,
											`${at}: Owner scanned once, where its definition reads it once`
										)
										assert.ok(
											relationWork(executed, "Note").runs <= 1,
											`${at}: the fold derived once, at the owner's document, its scans of Note run ${relationWork(executed, "Note").runs} times`
										)
										break
									}
									case "rows that repeat a document": {
										const input = { params: { item: 1 }, facts: {} }
										const rows = yield* db.workload.byPins.once(input)
										const executed = yield* db.workload.byPins.explainAnalyze(input)
										assert.equal(rows.size, c.pins, `${at}: each pin's document's count`)
										const runs = relationWork(executed, "Note").runs
										assert.ok(
											runs <= c.documents,
											`${at}: the fold derived once per distinct document of the pins, ${c.documents}, its scans of Note run ${runs} times (${notesPerDoc} notes a document)`
										)
										break
									}
									case "rows of distinct documents": {
										const input = { params: { item: 3 }, facts: {} }
										const rows = yield* db.workload.unflaggedByPins.once(input)
										const executed = yield* db.workload.unflaggedByPins.explainAnalyze(input)
										assert.equal(
											rows.size,
											c.pins * notesPerDoc,
											`${at}: each pin's document's notes`
										)
										const read = relationWork(executed, "Note").rows
										assert.ok(
											read <= c.pins * notesPerDoc,
											`${at}: the unflagged notes read at the pins' documents alone, ${c.pins * notesPerDoc} notes, where Note's scans returned ${read}`
										)
										break
									}
								}
								k.note(c.kind)
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the reads' executed plans counted: Owner's scans, Note's scans' runs against the distinct documents read"
		},
		box: "a read of a fold by document at a row in hand (an owner by its id) and at the documents of an item's twelve pins over three documents",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\tif (node.kind === "SemiJoin" || node.kind === "AntiJoin") {\n',
				replacement:
					'\t\tif (node.kind === "MatchRegion") {\n\t\t\tfor (const o of node.occurrences) {\n\t\t\t\tif (o.constants.length === 0) {\n\t\t\t\t\tout.add(o.source)\n\t\t\t\t}\n\t\t\t}\n\t\t} else if (node.kind === "SemiJoin" || node.kind === "AntiJoin") {\n',
				why: "A region's occurrence no value restricts is read once per row of the region's others again, rule 5b's MATERIALIZED CTE: unflaggedByPins derives the unflagged notes of every document, which no lookup reads at the pins' documents, where the binding reads them at each."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\t\t\t\tif (atRows || (once && readers(site.occurrence.source) === 1)) {\n",
				replacement: "\t\t\t\tif (atRows) {\n",
				why: "A region evaluated once reads its row sites from a key set however few rows come before them: byOwner computes the fold at the key set of the owner's documents, Owner scanned for the key set and again for the read."
			}
		]
	})
