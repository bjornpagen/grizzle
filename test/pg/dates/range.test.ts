/**
 * A date column holds the days a CalendarDate spells, whoever writes it, against PostgreSQL 19.
 *
 * `date` is PostgreSQL's date, a plain scalar, so its column is `pg_catalog.date NOT NULL` and its range, the days from
 * 0001-01-01 to 9999-12-31, is the column's CHECK (physical/date/storage.ts), named at the naming door. A direct writer
 * that has taken on the full role inserts a drawn date text, which PostgreSQL's date_in reads: a day of the calendar's
 * common era up to 9999, a year past 9999, a day before the common era, or an infinity. The oracle restates the range
 * over the drawn day: a day inside it is stored and reads back through grizzle as the CalendarDate its text spells;
 * every other is refused with 23514 under the column's range CHECK, and stores nothing. grizzle reads the column through
 * a member of the full world's served workload.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { toCalendarDate } from "#compiler/ir/date.ts"
import {
	dayGen,
	Event,
	Events,
	type Feature,
	inRange,
	range,
	textOf,
	eventsInstall,
	eventsTemplate
} from "#test/pg/dates/range.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { bareRecord, succeeded } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { claimsOfNoFact, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A date column holds the days a CalendarDate spells, against PostgreSQL 19 a direct writer's date is stored exactly when a CalendarDate spells it, and refused by the column's range CHECK otherwise. */
export const aDateColumnHoldsTheDaysACalendarDateSpellsAgainstPostgreSQL19ADirectWritersDateIsStoredExactlyWhenACalendarDateSpellsItAndRefusedByTheColumnsRangeCHECKOtherwise =
	property.explore(dayGen, {
		needs: { fixture: Substrate.fresh(eventsTemplate) },
		situations: [
			"stored and read back",
			"refused: before the common era",
			"refused: infinite",
			"refused past 9999"
		] satisfies ReadonlyArray<Reached<Feature>>,
		/** Its pre-conversion budget: runs 60, coverage cases 60 (range.test.ts at 4fbc3e95). */
		budget: { runs: 60, steered: 60 },
		check:
			({ fixture }, c: Case<Feature>) =>
			(d) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
							const o = yield* openedIn(Events, {}, eventsInstall, taken)
							const names = namesOf(o.installed)
							const insert = `INSERT INTO ${names.table(Event)} (${names.column(Event, "id")}, ${names.column(Event, "day")}) VALUES ($1::integer, $2::date)`
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const writer = yield* s.session({
									...worldSession(o.installed.world(o.app), claimsOfNoFact),
									label: "writer"
								})

								const text = textOf(d)
								const written = yield* Effect.result(writer.query(insert, ["1", text]))
								const stored = yield* rowsOf(db.workload.days.once({ params: {}, facts: {} }))
								if (inRange(d)) {
									assert.ok(Result.isSuccess(written), `${text} is stored`)
									assert.deepEqual(stored, [
										bareRecord({
											id: 1,
											day: succeeded(toCalendarDate(text), "a CalendarDate's text")
										})
									])
									c.note("stored and read back")
									return
								}
								if (Result.isSuccess(written)) {
									return assert.fail(`${text} is refused`)
								}
								const fields = defined(pgErrorFields(written.failure), "a server error")
								assert.equal(fields.code, sqlstates.checkViolation)
								assert.equal(fields.constraint, range)
								assert.deepEqual(stored, [])
								c.note(d.kind === "common era" ? "refused past 9999" : `refused: ${d.kind}`)
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the range 0001-01-01 to 9999-12-31 restated over the drawn day"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/date/storage.ts",
				original: "\tlow: lit.text(firstCalendarDate, types.date),",
				replacement: '\tlow: lit.text("0001-01-01 BC", types.date),',
				why: "The date column's range CHECK starting before the common era."
			}
		]
	})
