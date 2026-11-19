/**
 * A served program that calls declared functions returns the rows PostgreSQL computes calling them itself.
 *
 * - **Property:** a case draws Item's lines for three items, Seed's seeds, at most one an item, each with a shift, and
 *   explode's body in PL/pgSQL or SQL. The served program `run` matches each seed, then the rows of explode, a call of a
 *   rows argument (the seed's item's lines, a query bound to the seed's item) and a value argument (the seed's shift),
 *   which reads the variables of the match before it, and finds each row with scale(pos, 3), a call term, and the
 *   seed's mood as moodOf returns it, a closed id passed as its code and read back under its roster's domain. Where
 *   PostgreSQL's own rows hold no NULL, the served answer is exactly those rows; where one holds NULL, a line of empty
 *   text, the call is refused.
 * - **Oracle:** PostgreSQL: the owner's direct call of explode at each seed's array of its lines and of scale at each
 *   row, as plain SQL over the installation's tables, each row's mood the one the case drew for its seed.
 * - **Features:** each language, no seed, a seed of no line (an empty rows argument), two lines giving one row, a row
 *   holding NULL refused, and rows answered.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { onceCalls } from "#adapter/db/handles.ts"
import {
	type CallsFeature,
	callsTemplates,
	caseGen,
	drawnFeatures,
	factsOf,
	oracleRows,
	programsOf,
	rowText,
	sortedTexts,
	withMood,
	worldOf
} from "#test/pg/served/calls.fixtures.ts"
import { readOnce } from "#test/support/calls.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const features = [
	"a PL/pgSQL body",
	"an SQL body",
	"no seed",
	"a seed of no line, an empty rows argument",
	"two lines giving one row",
	"a row holding NULL, refused",
	"rows answered"
] as const satisfies ReadonlyArray<Reached<CallsFeature>>

/** A served program's calls of declared functions answer PostgreSQL's own rows of those calls, a NULL row refused. */
export const aServedProgramsCallsAnswerPostgresqlsOwnRowsOfThem = property.explore(caseGen, {
	needs: Substrate.oneOf(callsTemplates, Substrate.seat),
	situations: features,
	budget: { runs: 16, steered: features.length },
	check: (templates, notes: Case<CallsFeature>) => (c) =>
		Effect.scoped(
			Effect.gen(function* () {
				for (const feature of drawnFeatures(c)) {
					notes.note(feature)
				}
				const taken = yield* templates[c.language]
				yield* Effect.provideService(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const installed = taken.value.installed
						yield* loadMigrated(installed, factsOf(c))
						const expected = yield* oracleRows(substrate.admin, installed.schema)
						const world = worldOf(c.language, installed.declared)
						yield* withServedDb(installed, world.server.roles.app, {}, ({ ctx: db, load }) =>
							Effect.gen(function* () {
								const loaded = yield* load(programsOf(c.language))
								const answered = yield* Effect.result(
									readOnce(onceCalls(db, member(loaded, "run")))({ params: {}, facts: {} })
								)
								const refuses = Arr.some(expected, (row) => row["out"] === null)
								if (refuses) {
									notes.note("a row holding NULL, refused")
									assert.ok(
										Result.isFailure(answered),
										`a call whose rows hold NULL is refused: ${Formatter.format(answered)}`
									)
									return
								}
								if (Result.isFailure(answered)) {
									return assert.fail(`the program answers: ${Formatter.format(answered.failure)}`)
								}
								if (expected.length > 0) {
									notes.note("rows answered")
								}
								assert.deepEqual(
									sortedTexts(Arr.map(answered.success, rowText)),
									sortedTexts(Arr.map(expected, (row) => rowText(withMood(c, row)))),
									"the served program answers PostgreSQL's own rows of its calls"
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
		name: "PostgreSQL's own calls of explode at each seed's array of its lines and of scale at each row"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/conservative/call/index.ts",
			original: "		[or([whole, refused])]\n",
			replacement: "		[]\n",
			why: "A row of the function's holding NULL is delivered, not refused, so a call of a line of empty text answers."
		}
	]
})
