/** What the properties of range.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { pipe, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { date, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

export const Event = relation("Event", { id: pg.integer, day: date }, ["id"])

export const Events = schema("Events", [Event], [])

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
export const textOf = (d: Day): string => {
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
export const inRange = (d: Day): boolean => d.kind === "common era" && d.year >= 1 && d.year <= 9999

/** A day near the range's ends or anywhere in it, a day past it, before the era, or infinite. */
export const dayGen: Gen<Day> = oneOf<Day>([
	(source) => ({
		kind: "common era",
		year: source.draw(oneOf([int(1, 3), int(9997, 9999), int(1, 9999), int(10000, 10002)])),
		month: source.draw(int(1, 12)),
		day: source.draw(int(1, 28))
	}),
	(source) => ({ kind: "before the common era", year: source.draw(int(1, 3)) }),
	(source) => ({ kind: "infinite", sign: source.draw(element(["", "-"] as const)) })
])

export type Feature = "stored and read back" | `refused: ${Day["kind"]}` | "refused past 9999"

export const range = identifierOf(identity.dateCheck("Event", "day"))

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const eventsInstall = Object.freeze({ label: "dates", programs: { days } })

/** Events installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const eventsTemplate = fixtureTemplate(import.meta, Events, eventsInstall)
