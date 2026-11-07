import { compareText } from "#compiler/core/canonical.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import { firstCalendarDate, lastCalendarDate } from "#compiler/ir/date.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import type { Expr, InlineConstraint } from "#compiler/sql/ast.ts"
import { lit, tableCol, types } from "#compiler/sql/build.ts"

/** A date column's range CHECK: its relation and field, its identity, and the constraint its table declares. */
interface DateRange {
	readonly relation: string
	readonly field: string
	readonly named: Identity<"dateCheck">
	readonly constraint: InlineConstraint
}

/** The range predicate over the unqualified column `column`, as a row CHECK spells it. */
const rangePredicate = (column: Expr): Expr => ({
	kind: "between",
	expr: column,
	low: lit.text(firstCalendarDate, types.date),
	high: lit.text(lastCalendarDate, types.date),
	not: false
})

const dateColumns = (heading: ReadonlyArray<HeadingColumn>): ReadonlyArray<HeadingColumn> =>
	heading.filter((c) => baseOf(c.type).carrier === "date")

/**
 * The range CHECK of every date column of every stored relation, in relation then field order, for its table's CREATE
 * TABLE to declare (`addDateRanges` adds their objects once the tables stand).
 *
 * `date` is PostgreSQL's date, a plain scalar, whose column is `pg_catalog.date NOT NULL`. PostgreSQL's date holds
 * the infinities, the days before the common era and the years past 9999, none of which a CalendarDate spells, so the
 * column carries the named CHECK of the days a CalendarDate spells:
 *
 *     CONSTRAINT "__event_day_range_<digest>"
 *       CHECK (("day" BETWEEN '0001-01-01'::date AND '9999-12-31'::date) IS TRUE)
 *
 * It is declared inline by the table's CREATE TABLE beside the row's other CHECKs, and PostgreSQL enforces it on every
 * write, grizzle's or a direct SQL writer's. It is the range of the field's type, not a law of the schema: it has no
 * law id and no witness, and grizzle's own writes meet the codec's host boundary first, which admits a CalendarDate
 * alone, so it refuses only a direct writer. Its name is the naming door's hashed dateCheck, which no declared check of
 * the relation can claim. A span over dates holds its endpoints in the same range by its shape CHECK
 * (physical/span/storage.ts).
 */
export const dateRanges = (b: InstallBuilder): ReadonlyArray<DateRange> =>
	Object.entries(b.model.theory.relations)
		.toSorted(([x], [y]) => compareText(x, y))
		.flatMap(([name, r]) =>
			r.kind === "relation"
				? dateColumns(r.fields).map((c): DateRange => {
						const named = identity.dateCheck(name, c.name)
						return {
							relation: name,
							field: c.name,
							named,
							constraint: {
								kind: "check",
								name: b.name(named),
								predicate: rangePredicate(tableCol(b.names.column(name, c.name)))
							}
						}
					})
				: []
		)

/** Each range CHECK's object, which its table declares inline, so it carries no statement: after its table. */
export const addDateRanges = (b: InstallBuilder, ranges: ReadonlyArray<DateRange>): void => {
	for (const r of ranges) {
		b.add(
			{
				kind: "check",
				ident: {
					kind: "constraint",
					schema: b.settings.installation,
					relation: b.names.relationNamed(r.relation),
					name: r.named
				},
				ddl: [],
				reasons: [
					enforcement(
						`the days a CalendarDate spells of ${r.relation}.${r.field}: ${firstCalendarDate} to ${lastCalendarDate}`
					)
				],
				phase: "structure"
			},
			[b.table(r.relation)]
		)
	}
}
