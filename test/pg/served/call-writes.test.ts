/**
 * Writes from a query that calls a declared function, in one stratum, guarded by a derived relation, call the function
 * once and write exactly the guarded rows.
 *
 * - **Property:** a case draws sessions with their shifts and lines, closes some by an Attempt, and answers one, which
 *   may be none of them. The served ChangeSet `answer` inserts, in one stratum, the session's Attempt and its Values,
 *   both from `graded`, the rows of grade's call at the session's lines and shift read only where Open, the derived
 *   relation of sessions no Attempt holds, holds the session. Its explain plans one Function Scan of grade in each
 *   statement, the call both members read; and after it applies, Attempt and Value hold exactly what PostgreSQL's own
 *   call gives an open session, beside the closed sessions' Attempts, and nothing new for a closed session or none.
 * - **Oracle:** PostgreSQL: the owner's direct call of grade at the session's array of lines and its shift, and the
 *   catalog's plan of each statement.
 * - **Features:** an open session graded, of no line, of several lines' values, a closed session left unwritten, and
 *   no such session.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { memberExplains, memberCalls } from "#adapter/db/handles.ts"
import {
	drawnFeatures,
	expectedOf,
	factsOf,
	type GradingFeature,
	gradingTemplate,
	programsOf,
	steeredGrading,
	worldOf,
	writtenOf
} from "#test/pg/served/call-writes.fixtures.ts"
import { functionScans, writeOnce } from "#test/support/calls.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const features = [
	"an open session graded",
	"a closed session left unwritten",
	"no such session",
	"an open session of no line",
	"values of several lines"
] as const satisfies ReadonlyArray<Reached<GradingFeature>>

/** One stratum's writes from one call of a declared function, guarded by a derived relation, call it once and write the
 * guarded rows alone. */
export const writesFromACallGuardedByADerivedRelationCallItOnceAndWriteTheGuardedRows =
	property.explore(steered(steeredGrading), {
		needs: Substrate.oneOf({ grading: gradingTemplate }, Substrate.fresh),
		situations: features,
		budget: { runs: 16, steered: features.length },
		check: (templates, notes: Case<GradingFeature>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					for (const feature of drawnFeatures(c)) {
						notes.note(feature)
					}
					const taken = yield* templates.grading
					yield* Effect.provideService(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const installed = taken.value.installed
							yield* loadMigrated(installed, factsOf(c))
							const expected = yield* expectedOf(substrate.admin, installed.schema, c)
							const world = worldOf(installed.declared)
							yield* withServedDb(
								installed,
								world.server.roles.app,
								{},
								({ ctx: db, loadWithTables }) =>
									Effect.gen(function* () {
										const loaded = yield* loadWithTables(programsOf(installed.declared))
										const answer = member(loaded.members, "answer")
										const input = { params: { session: c.answered }, facts: {} }
										const explains = memberExplains(db, loaded.tables, answer)
										if (explains.kind !== "change") {
											return assert.fail("a ChangeSet explains as a change")
										}
										const plans = yield* explains.explain(input)
										const scans = Arr.map(plans, (p) => functionScans(p.plan))
										assert.deepEqual(
											Arr.filter(scans, (n) => n > 0),
											[1],
											`one statement calls grade, once, for both members: ${Formatter.format(scans)}`
										)
										const applied = yield* Effect.result(writeOnce(memberCalls(db, answer))(input))
										if (Result.isFailure(applied)) {
											return assert.fail(`answer applies: ${Formatter.format(applied.failure)}`)
										}
										const written = yield* writtenOf(substrate.admin, installed.schema)
										assert.deepEqual(
											written,
											expected,
											"answer writes exactly the guarded rows of PostgreSQL's own call"
										)
									})
							)
						}),
						Substrate,
						taken.substrate
					)
				})
			),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's own call of grade at the answered session's lines and shift, and its plan of each statement"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t"ApproximateNearest",\n\t"Call"\n]',
				replacement: '\t"ApproximateNearest"\n]',
				why: "A declared function's call is no expensive node, so the stratum shares no copy of graded and each member's statement calls grade itself."
			}
		]
	})
