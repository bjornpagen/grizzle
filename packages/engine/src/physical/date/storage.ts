import { identity } from "#compiler/core/identity.ts"
import { firstCalendarDate, lastCalendarDate } from "#compiler/ir/date.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"

/**
 * A date column's range CHECK, a column CHECK (physical/ddl/column-checks.ts ColumnCheckKind).
 *
 * `date` is PostgreSQL's date, a plain scalar, whose column is `pg_catalog.date NOT NULL`. PostgreSQL's date holds
 * the infinities, the days before the common era and the years past 9999, none of which a CalendarDate spells, so the
 * column carries the named CHECK of the days a CalendarDate spells:
 *
 *     CONSTRAINT "__event_day_range_<digest>"
 *       CHECK (("day" BETWEEN '0001-01-01'::date AND '9999-12-31'::date) IS TRUE)
 *
 * The codec's host boundary admits a CalendarDate alone, so it refuses only a direct writer. Its name is the naming
 * door's hashed dateCheck. A span over dates holds its endpoints in the same range by its shape CHECK
 * (physical/span/storage.ts).
 */
export const dateRange = Object.freeze({
	holds: (type: ScalarType): boolean => baseOf(type).carrier === "date",
	generationProves: false,
	named: identity.dateCheck,
	predicate: (_: unknown, column: Expr): Expr => ({
		kind: "between",
		expr: column,
		low: lit.text(firstCalendarDate, types.date),
		high: lit.text(lastCalendarDate, types.date),
		not: false
	}),
	reason: (relation: string, field: string): string =>
		`the days a CalendarDate spells of ${relation}.${field}: ${firstCalendarDate} to ${lastCalendarDate}`
})
