import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { CalendarDate } from "#compiler/ir/date.ts"
import { bareEnv, defineField } from "#compiler/scalar/registry.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"

/** PostgreSQL's date's column, which date's values are read by: date_out under DateStyle ISO. */
const column: Column<CalendarDate> = convertColumn(convertByCarrier.date({ carrier: "date" }))

/**
 * date: a calendar day of the proleptic Gregorian calendar, 0001-01-01 to 9999-12-31, written and read as its ISO
 * 8601 text, a CalendarDate (ir/date.ts), and ordered as the calendar is. It is PostgreSQL's date, a plain scalar as
 * integer is, of no contract, so Compute.base of a date is the date itself. PostgreSQL's date also holds the
 * infinities, the days before the common era and the years past 9999, which no CalendarDate spells, so every stored
 * date column carries the range CHECK of the days a CalendarDate spells (physical/date/storage.ts), whoever writes
 * it, and a span over dates holds its endpoints in the same range by its shape CHECK (physical/span/storage.ts). A date
 * is what a text of xs:date's lexical form parses into (scalar/lexical.ts), and a parse's value lies inside the range
 * by the form.
 */
export const dateDescriptor = defineField(
	{},
	"date",
	{ kind: "pg", type: "date" },
	{ column },
	SourceLoc("date", []),
	bareEnv
)
