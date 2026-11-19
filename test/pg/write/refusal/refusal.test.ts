/**
 * The write refusal channel on PostgreSQL 19: the installed refusal function raises exactly its arguments, the
 * SQLSTATE, the constraint name and the DETAIL PostgreSQL evaluates, which arrive intact as the error fields the
 * adapter classifies, for both refusal SQLSTATEs, and the DETAIL parses back to the key texts, uuid, bigint and any
 * storable text alike, for a law's refusal and a concurrent change.
 *
 * - Property: a refusal raised over drawn key texts reads back as those texts, its SQLSTATE and its constraint.
 * - Oracle: universal, read ∘ raise = id.
 * - Features: a law's refusal and a concurrent change.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { bigint, uuid } from "@bjornpagen/testing/values"
import { Effect } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { readChangeDetail, readLawDetail } from "#compiler/runtime/write/refusal.ts"
import { printExpr } from "#compiler/sql/print.ts"
import {
	type ArmRefusal,
	raised as raisedBy,
	refusalFunctionName
} from "#compiler/write/refusal.ts"
import {
	change,
	constraint,
	detailOf,
	type KeyTexts,
	law,
	note,
	type Raised,
	raisedFeatures,
	refusalTemplate
} from "#test/pg/write/refusal/refusal.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { outputText } from "#test/support/wire.ts"

/**
 * The write refusal channel on PostgreSQL 19 the installed function raises its SQLSTATE and constraint, and a DETAIL PostgreSQL evaluates that parses back to the key texts.
 *
 * Its pre-conversion budget: runs 300, coverage cases 40 (test/pg/write/refusal/refusal.test.ts at d8eed1786).
 */
export const theWriteRefusalChannelOnPostgreSQL19TheInstalledFunctionRaisesItsSQLSTATEAndConstraintAndADETAILPostgreSQLEvaluatesThatParsesBackToTheKeyTexts =
	property.explore(
		(source) =>
			[
				{
					employee: source.draw(uuid(7)),
					week: source.draw(bigint(int8Min, int8Max)).toString(),
					note: source.draw(note)
				},
				source.draw(element(raisedFeatures))
			] as const,
		{
			needs: { refusals: Substrate.seat(refusalTemplate) },
			situations: raisedFeatures satisfies ReadonlyArray<Reached<Raised>>,
			check:
				({ refusals }, c: Case<Raised>) =>
				([texts, kind]) =>
					Effect.flatMap(refusals, ({ substrate: seat, value: schema }) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const sql = (refusal: ArmRefusal) =>
									`SELECT "${schema}"."${refusalFunctionName}"($4::text, $5::text, ${printExpr(raisedBy(refusal).detail)})`
								assert.deepEqual(auditTextViolations(sql(law)), [])
								assert.deepEqual(auditTextViolations(sql(change)), [])
								/** One key's refusal raised through the installed function: the error PostgreSQL reports carries its SQLSTATE,
								 * its constraint and its DETAIL, which parses back to the key's texts. */
								const raised = ({ employee, week, note }: KeyTexts, kind: Raised) =>
									Effect.gen(function* () {
										const state =
											kind === "a law's refusal"
												? sqlstates.integrityConstraintViolation
												: sqlstates.grizzleConcurrentChange
										const error = yield* expectSqlstate(
											s.admin.query(sql(kind === "a law's refusal" ? law : change), [
												employee,
												week,
												note,
												state,
												constraint
											]),
											state
										)
										assert.equal(error.constraint, constraint)
										const detail = detailOf(error.detail)
										if (kind === "a law's refusal") {
											assert.deepEqual(readLawDetail(detail), {
												kind: "law",
												relation: "Timesheet",
												key: [
													{ field: "employee", text: outputText(employee) },
													{ field: "week", text: outputText(week) },
													{ field: "note", text: outputText(note) }
												]
											})
										} else {
											assert.deepEqual(readChangeDetail(detail), {
												reason: "PutTargetConflict",
												relation: "Timesheet"
											})
										}
									})

								c.note(kind)
								yield* raised(texts, kind)
							}),
							Substrate,
							seat
						)
					),
			oracle: { kind: "universal", name: "read ∘ raise = id" },
			budget: { runs: 300, steered: 40 },
			kept: [],
			kills: []
		}
	)
