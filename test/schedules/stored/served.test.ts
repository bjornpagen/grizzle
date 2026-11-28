/**
 * A served write of a stored derived relation's holder stands the rule judge's tables up first and keeps the stored
 * relation at its COMMIT (D11 2b, after 8ab32a3bb's stand-ups): a session stands up the judge's tables a write of a
 * table needs before its first such write (physical/ddl/rules.ts addStandUps), a served write in its session's
 * stand-up (write/program/stand-up.ts writeStandUps), for each relation the judge captures (laws/model/model.ts
 * LawModel `judged`), each a rule over a query reads and each a stored relation's upkeep reads, Doc among them.
 *
 * Over the box of borrows.fixtures.ts, Doc(shelf, doc, at) in the unit Shelf(shelf) and Counted, each document's places,
 * a stored derived relation over it kept at its document, narrower than the shelf: each case's seed gives the
 * documents 1 and 2 of the shelf none, one or two places (schedules/rig.ts replace, which empties Counted's table with
 * the rest), and two writers of the role `writer`, each a Db of its own over a DbLayer of its own, put one place each
 * in turn, A at 10 and B at 11 of a document of their own, B after A's call has committed.
 *
 * Properties, per case: each call is accepted, and Counted holds each document's places after both, seeded and put
 * alike. Oracle: Counted's definition stated over the seed and the two calls (borrows.fixtures.ts countedAfter). Kill:
 * a stored relation's holders left out of the relations the judge captures, so a served write of Doc stands nothing up
 * and its capture refuses it (55Z03).
 *
 * Features: one document or two, and each document's places before the calls.
 */

import { assert, deepEquals } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import {
	countedAfter,
	Doc,
	seededTuples,
	shelf,
	stored,
	storedCaseGen,
	storedRig,
	untilAnswered
} from "#test/schedules/stored/borrows.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { rigIn } from "#test/support/schedules/rig.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type ServedFeature =
	| "one document"
	| "two documents"
	| "a document over no place"
	| "a document over one place"
	| "a document over two places"

/** A served write of a stored relation's holder stands the judge up and keeps the stored relation at its COMMIT. */
export const aServedWriteOfAStoredRelationsHolderStandsTheJudgeUpAndKeepsTheStoredRelationAtItsCommit =
	property.explore(storedCaseGen, {
		needs: { rigged: Substrate.fresh(storedRig) },
		situations: [
			"one document",
			"two documents",
			"a document over no place",
			"a document over one place",
			"a document over two places"
		],
		check:
			({ rigged }, k: Case<ServedFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(rigged, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const rig = yield* rigIn(taken, stored)
								const names = namesOf(rig.installed)
								const countedTable = names.table(rig.worlds.Counted)
								const open = (context: Parameters<Parameters<typeof rig.servedWriter>[1]>[0]) =>
									openServed(rig.served.roles.writer, {}).pipe(Effect.provideContext(context))
								const a = yield* rig.servedWriter("a", open, (db) =>
									writeAnswerOf(
										db.workload.put.once({ params: {}, facts: { insert: { Doc: [] } } })
									)
								)
								const b = yield* rig.servedWriter("b", open, (db) =>
									writeAnswerOf(
										db.workload.put.once({ params: {}, facts: { insert: { Doc: [] } } })
									)
								)
								const seeded = seededTuples(c)
								yield* rig.replace(
									seeded.length === 0
										? []
										: [
												`INSERT INTO ${names.table(Doc)} (${names.column(Doc, "shelf")}, ${names.column(Doc, "doc")}, ${names.column(Doc, "at")}) VALUES ${Arr.join(seeded, ", ")}`
											]
								)
								const answeredA = yield* a.db.workload.put
									.once({ params: {}, facts: { insert: { Doc: [{ shelf, doc: c.a, at: 10 }] } } })
									.pipe(writeAnswerOf, untilAnswered)
								const answeredB = yield* b.db.workload.put
									.once({ params: {}, facts: { insert: { Doc: [{ shelf, doc: c.b, at: 11 }] } } })
									.pipe(writeAnswerOf, untilAnswered)
								const label = Formatter.format(c)
								for (const [who, answered] of [
									["A", answeredA],
									["B", answeredB]
								] as const) {
									assert.ok(
										Result.isSuccess(answered.ran) && answered.ran.success._tag === "accepted",
										`${label}: ${who} is accepted, ${Formatter.format(answered.ran)}`
									)
								}
								const countedRows = yield* s.admin.queryValues(
									`SELECT ${names.column(rig.worlds.Counted, "doc")}::text || ':' || ${names.column(rig.worlds.Counted, "places")}::text FROM ${countedTable} ORDER BY 1`,
									[]
								)
								const counted = Arr.map(countedRows, (row) => String(row[0]))
								assert.ok(
									deepEquals(counted, countedAfter(c)),
									`${label}: Counted holds [${Arr.join(counted, "; ")}] where its definition gives [${Arr.join(countedAfter(c), "; ")}]`
								)
								k.note(c.a === c.b ? "one document" : "two documents")
								for (const doc of [1, 2] as const) {
									k.note(
										c.seeded[doc] === 0
											? "a document over no place"
											: c.seeded[doc] === 1
												? "a document over one place"
												: "a document over two places"
									)
								}
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "Counted's definition over the seed and the two calls (borrows.fixtures.ts countedAfter)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/model.ts",
				original: "\t\t\t...upkeeps.flatMap((u) => u.sides.map((r) => r.relation))\n",
				replacement: "",
				why: "A stored relation's holders left out of the relations the judge captures: a served write of Doc stands nothing up, and its capture refuses it (55Z03, a write of a table the rule judge holds in a session that has not stood up its tables)."
			}
		]
	})
