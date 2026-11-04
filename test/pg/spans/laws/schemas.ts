import { Array as Arr } from "effect"
import type { RaisedLawId } from "#compiler/core/ids.ts"
import {
	contained,
	f,
	mutable,
	on,
	onSelected,
	relation,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"

const mutables = (on: boolean, relations: ReadonlyArray<string>): ReadonlyArray<StatementDesc> =>
	on ? Arr.map(relations, mutable) : []

const visitsCoverage = contained(
	onSelected("Visit", ["site", "during"], { billable: true }),
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
 * The span-law schemas of the span law tests, as Descriptions.
 *
 * - Visits: a selected source, `on(select(Visit, { billable: true }), "site", "during")` into Shift's span key
 *   `(site, during)`: the residual range_agg coverage law anchored on the target rows of the source's scalar group.
 *   Visit is keyed by id, so its DETAIL carries the visit's id.
 * - Rounds: the Visits law with a composite group whose source fields differ from the target's in name and in order.
 *
 * Each law is read through the naming door from the statement that declares it.
 */
export const visitsLaw: RaisedLawId = lawNamesOf(visits({ mutable: false })).lawOfDesc(
	visitsCoverage
)
