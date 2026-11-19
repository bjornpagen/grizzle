/**
 * The direct-writer model as an exploration: generated runs, each a generated write schema installed once with a
 * psql child in its world (logged in as its login, the role `writer` taken on), whose cases run direct transactions the
 * model predicts (model.ts).
 *
 * The population must reach every statement kind, each native error at the time PostgreSQL raises it (a unique
 * violation, an immediate foreign key, a privilege refusal, an identity column's refusal, a refined text's domain's
 * and a closed id's roster domain's, each by its CHECK, a precision's and a missing field's at the statement; a
 * deferred foreign key at COMMIT and at SET CONSTRAINTS), and commits; and every level below SERIALIZABLE a writer may
 * begin at, each refused by grizzle's guard (25000 naming the table, nothing committed).
 *
 * Six of those errors need a column kind or a foreign key a third of the generated schemas hold, and a case that meets
 * them first: a code outside the roster's live codes (23514), a numeric past its precision (22003), a refined text past
 * its bound (23514), an immediate foreign key at its statement and a deferred one at COMMIT and at SET CONSTRAINTS
 * (23503). Each run plants them: its schema holds one more group of its own (plantedGroup, a parent with a closed id, a
 * numeric(3, 0) and a refined text column, a pure set, and a child of each, the one into the parent deferred, the one
 * into the pure set immediate), and among its drawn cases, at drawn positions, one planted case of each, its stored
 * facts, row, level and sequences drawn: the wild value inserted alone, or the breaking statement alone. So every
 * required feature is reached in every run that holds the planted cases, and the drawn cases still reach them
 * organically.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	casesOf,
	directRunGen,
	plantedGroup,
	runs,
	situations
} from "#test/pg/direct-writers/direct-writers.fixtures.ts"
import { type DirectFeature, runDirectCase } from "#test/pg/direct-writers/model.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { messageOf } from "#test/support/message.ts"
import { CaseFailed } from "#test/support/oracle/write/harness.ts"
import { installTarget } from "#test/support/oracle/write/run.ts"
import { printSchema, resolveSchema, type WSchema } from "#test/support/oracle/write/schema.ts"
import { Substrate, worldPsql } from "#test/support/substrate/substrate.ts"

/**
 * The direct-writer model ${runs} generated direct transactions meet the native errors the model predicts.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/pg/direct-writers/direct-writers.test.ts at d8eed1786).
 */
export const theDirectWriterModelRunsGeneratedDirectTransactionsMeetTheNativeErrorsTheModelPredicts =
	property.explore(directRunGen, {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<DirectFeature>>,
		check:
			({ substrate }, cx: Case<DirectFeature>) =>
			(run) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const s = yield* Substrate
							const drawnSchema = cx.draw(resolveSchema(run.schema))
							const schema: WSchema = {
								groups: [...drawnSchema.groups, plantedGroup(drawnSchema.groups.length)]
							}
							const cases = casesOf(run)
							const target = yield* Effect.mapError(
								installTarget(schema, "analyzed", ordinarySession, []),
								(e) =>
									new CaseFailed({
										report: `${printSchema(schema)}\ndid not install: ${messageOf(e)}`
									})
							)
							const writer = yield* Effect.orDie(
								s.psql({
									...worldPsql(target.installed.world(target.built.worldOf(target.value).writer)),
									label: "direct writer"
								})
							)
							for (const [i, c] of cases.entries()) {
								yield* runDirectCase(target, writer, c, cx.note).pipe(
									Effect.mapError(
										(e) =>
											new CaseFailed({
												report: `${printSchema(schema)}\ncase ${i + 1} of ${cases.length}:\n${e.report}`
											})
									)
								)
							}
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the direct-writer model (model.ts): each statement's native error at the time PostgreSQL raises it, or the state the transaction commits"
		},
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})
