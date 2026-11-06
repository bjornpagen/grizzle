import type { Column } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type CalendarDate, firstCalendarDate, lastCalendarDate } from "#compiler/ir/date.ts"
import { contractParts } from "#compiler/scalar/contract.ts"
import { pgDate } from "#compiler/scalar/pg.ts"
import { defineField } from "#compiler/scalar/registry.ts"

/** The comparison date's predicate reads its VALUE by: a scalar of date, between two date literals. */
interface DateValue {
	readonly between: (low: CalendarDate, high: CalendarDate) => unknown
}

/**
 * date's admission: the contract `date` over PostgreSQL's date, whose values are the days from 0001-01-01 to
 * 9999-12-31, admitted by the one path every contract is.
 */
const parts = contractParts("date", pgDate, [
	(v: DateValue) => v.between(firstCalendarDate, lastCalendarDate)
])

/** PostgreSQL's date's column, which date's values are read by: date_out under DateStyle ISO. */
const column: Column<CalendarDate> = pgDate.column

/**
 * date: a calendar day of the proleptic Gregorian calendar, 0001-01-01 to 9999-12-31, written and read as its ISO
 * 8601 text, a CalendarDate (ir/date.ts), and ordered as the calendar is. It is the builtin contract `date` over
 * PostgreSQL's date, `CHECK (VALUE BETWEEN '0001-01-01' AND '9999-12-31')`, so a stored column holds no infinity, no
 * date before the common era and none past 9999, which its host text could not spell, whoever writes it; the contract
 * lowers to its PostgreSQL domain as every contract does. A date is what a text of xs:date's lexical form parses into
 * (scalar/lexical.ts), and a parse's value lies inside the contract by the form, so it enters the contract proved.
 */
export const dateDescriptor = defineField(
	{},
	pgDate.sql,
	parts.desc,
	{ name: parts.name, base: pgDate, predicate: parts.predicate, column },
	SourceLoc("date", []),
	parts.env
)
