import { Array as Arr } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import {
	type AuthoredStatementDesc as StatementDesc,
	contained,
	eq,
	f,
	field,
	literal,
	mutable,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"

const mutables = (on: boolean, relations: ReadonlyArray<string>): ReadonlyArray<StatementDesc> =>
	on ? Arr.map(relations, mutable) : []

const visitsCoverage = contained(
	onWhere("Visit", ["site", "during"], eq(field("billable"), literal(true))),
	on("Shift", ["site", "during"])
)

export const visits = (options: { readonly mutable: boolean }): SchemaDesc => ({
	name: "Visits",
	relations: [
		relation("Shift", { site: f.integer, during: f.span(f.bigint, undefined), nurse: f.integer }, [
			"site",
			"during"
		]),
		relation(
			"Visit",
			{ id: f.integer, site: f.integer, during: f.span(f.bigint, undefined), billable: f.boolean },
			["id"]
		)
	],
	statements: [visitsCoverage, ...mutables(options.mutable, ["Shift", "Visit"])],
	extends: undefined
})

/**
 * The span-law schema of the span law tests, as a Description.
 *
 * Visits: a selected source, `on(select(Visit, (v) => v.eq(v.billable, true)), "site", "during")`, into Shift's span
 * key `(site, during)`, WITHOUT OVERLAPS: a PERIOD foreign key from the billable visit's range law column, `CASE WHEN
 * billable THEN during END STORED`, which PostgreSQL checks against the union of the site's shifts (fin.md §7).
 *
 * The law is read through the naming door from the statement that declares it.
 */
export const visitsLaw: LawId = lawNamesOf(visits({ mutable: false })).lawOfDesc(visitsCoverage)
