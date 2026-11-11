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
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): dates-range-before-era.patch (the date column's range CHECK starting
 * before the common era).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter, pipe, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { toCalendarDate } from "#compiler/ir/date.ts"
import { date, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, bareRecord, defined, succeeded } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

const Event = relation("Event", { id: pg.integer, day: date }, ["id"])
const Events = schema("Events", { Event }, [])

/** Every event's day, as grizzle reads it: the full world's workload member `days`. */
const days = query(Events).rule((r) => {
	const { id, day } = v(Event, "event")
	return r.match(Event, { id, day }).find({ id, day })
})

/** A date text as a direct writer sends it, and whether it is a day a CalendarDate spells. */
type Day =
	| {
			readonly kind: "common era"
			readonly year: number
			readonly month: number
			readonly day: number
	  }
	| { readonly kind: "before the common era"; readonly year: number }
	| { readonly kind: "infinite"; readonly sign: "" | "-" }

const pad = (n: number, width: number): string => pipe(String(n), Str.padStart(width, "0"))

/** A day's text, as date_in reads it. */
const textOf = (d: Day): string => {
	switch (d.kind) {
		case "common era":
			return `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`
		case "before the common era":
			return `${pad(d.year, 4)}-01-01 BC`
		case "infinite":
			return `${d.sign}infinity`
	}
}

/** Whether a day is one the range holds, 0001-01-01 to 9999-12-31: the oracle. */
const inRange = (d: Day): boolean => d.kind === "common era" && d.year >= 1 && d.year <= 9999

/** A day near the range's ends or anywhere in it, a day past it, before the era, or infinite. */
const dayGen: Gen<Day> = oneOf<Day>([
	(source) => ({
		kind: "common era",
		year: source.draw(oneOf([int(1, 3), int(9997, 9999), int(1, 9999), int(10000, 10002)])),
		month: source.draw(int(1, 12)),
		day: source.draw(int(1, 28))
	}),
	(source) => ({ kind: "before the common era", year: source.draw(int(1, 3)) }),
	(source) => ({ kind: "infinite", sign: source.draw(element(["", "-"] as const)) })
])

type Feature = "stored and read back" | `refused: ${Day["kind"]}` | "refused past 9999"

layer(Substrate.layer)(
	"a date column holds the days a CalendarDate spells, against PostgreSQL 19",
	(it) => {
		it.effect(
			"a direct writer's date is stored exactly when a CalendarDate spells it, and refused by the column's range CHECK otherwise",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(
							Events,
							{},
							{ label: "dates", extensions: [], programs: { days } }
						)
						const names = namesOf(o.installed)
						const group = installationGroup(names)
						const range = identifierOf(identity.dateCheck("Event", "day"))
						const insert = `INSERT INTO ${names.table(Event)} (${names.column(Event, "id")}, ${names.column(Event, "day")}) VALUES ($1::integer, $2::date)`
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							const writer = yield* s.session({
								...worldSession(o.installed.world(o.app)),
								label: "writer"
							})
							return yield* explore(
								{
									suite: "dates/range",
									draw: drawn(dayGen),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "the range 0001-01-01 to 9999-12-31 restated over the drawn day"
									},
									kept: [],
									runs: 60,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 16,
									coverage: required<Feature>(
										[
											"stored and read back",
											"refused: before the common era",
											"refused: infinite",
											"refused past 9999"
										],
										{ cases: 60, sense: notesOnly }
									),
									caseHang
								},
								(d, c) =>
									Effect.gen(function* () {
										yield* replaceRows(s.admin, group, [])
										const text = textOf(d)
										const written = yield* Effect.result(writer.query(insert, ["1", text]))
										const stored = yield* Effect.flatMap(
											db.workload.days.execute({}),
											(r) => r.collect
										)
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
									})
							)
						}).pipe(Effect.scoped, withLayer(o.served.layer))
					}).pipe(Effect.scoped)
				)
		)
	}
)
