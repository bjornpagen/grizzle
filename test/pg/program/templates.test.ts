/**
 * A compiled template's deferred-key hazard on PostgreSQL 19.
 *
 * The worked example's Work schema is installed by the fresh-install compiler under a fresh schema name. TaskNote
 * matched to Task on its deferred foreign key may drop the Task match in a snapshot template only (R03). Inside a write
 * transaction whose drawn writes make the deferred key temporarily false (an orphan note inserted, a note's task
 * removed) beside notes removed and added, the transaction-context template and a snapshot template's conservative
 * artifact, which rests on no evidence, deliver exactly the notes whose task the transaction holds. Each artifact's statements run as the
 * runtime runs them: the executable texts, placeholders filled by the statement's own encoders, every result column cast
 * to text by the statement itself.
 *
 * The oracle is a model of the transaction's notes: exactly those whose task the transaction holds.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import {
	compiled,
	expectedNotes,
	insertInto,
	installed,
	noteOf,
	notes,
	type Raw,
	runSpecs,
	templateCaseGen,
	type TemplateFeature,
	templateFeatures,
	uuids
} from "#test/pg/program/templates.fixtures.ts"
import { assert, defined } from "#test/support/assert.ts"
import { Task, TaskNote } from "#test/support/fixtures/api/work.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Compiled templates on PostgreSQL 19 inside a write transaction the transaction template and a snapshot template's conservative artifact deliver exactly the notes whose task the transaction holds.
 *
 * Its pre-conversion budget: runs 16, coverage cases 24 (test/pg/program/templates.test.ts at d8eed1786).
 */
export const compiledTemplatesOnPostgreSQL19InsideAWriteTransactionTheTransactionTemplateAndASnapshotTemplatesConservativeArtifactDeliverExactlyTheNotesWhoseTaskTheTransactionHolds =
	property.explore(templateCaseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"an orphan note inserted",
			"a note orphaned by its task's removal",
			"a note removed",
			"a note added to a task"
		] satisfies ReadonlyArray<Reached<TemplateFeature>>,
		check:
			({ substrate }, k: Case<TemplateFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const { schema, names } = yield* installed
						const snapshot = compiled(notes, schema, "snapshot")
						const tx = compiled(notes, schema, "transaction")
						const session = yield* s.session({ ...ownerSession(), label: "writer" })
						const task = (column: string) => quoteIdent(names.column(Task.name, column))
						const note = (column: string) => quoteIdent(names.column(TaskNote.name, column))
						return yield* Effect.ensuring(
							Effect.gen(function* () {
								yield* session.begin
								if (Arr.isReadonlyArrayNonEmpty(c.removedNotes)) {
									yield* session.query(
										`DELETE FROM ${printObjectName(names.relation(TaskNote.name))} WHERE ${note("task")} = ANY (${uuids(c.removedNotes)})`,
										[]
									)
								}
								if (Arr.isReadonlyArrayNonEmpty(c.removedTasks)) {
									yield* session.query(
										`DELETE FROM ${printObjectName(names.relation(Task.name))} WHERE ${task("id")} = ANY (${uuids(c.removedTasks)})`,
										[]
									)
								}
								if (Arr.isReadonlyArrayNonEmpty(c.added)) {
									yield* session.query(
										insertInto(
											names,
											TaskNote.name,
											["task", "note"],
											Arr.join(
												Arr.map(c.added, (added) => `('${added}', ${noteOf(added)})`),
												", "
											)
										),
										[]
									)
								}
								const expected = expectedNotes(c)
								/** The rows of an artifact's first statement, the one that delivers the notes. */
								const delivered = (raws: ReadonlyArray<Raw>): ReadonlyArray<string> =>
									Arr.sort(
										Arr.flatten(defined(raws[0], "the delivering statement's rows")),
										Order.String
									)
								const optimizedRuns = yield* runSpecs(tx.optimized, {}, session)
								assert.deepEqual(delivered(optimizedRuns), expected, "the transaction template")
								const conservativeRuns = yield* runSpecs(snapshot.conservative, {}, session)
								assert.deepEqual(
									delivered(conservativeRuns),
									expected,
									"the snapshot template's conservative artifact in a transaction"
								)
								k.noteAll(templateFeatures(c))
							}),
							Effect.orDie(session.rollback)
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the notes whose task the transaction's own state holds, matched on the host"
		},
		budget: { runs: 16, steered: 24 },
		kept: [],
		kills: []
	})
