/** What the properties of bound-rows.test.ts read: their two levels, and the writes of a case. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"

/** The lower level's visits, and what its members write of them, one relation each. */
const Visit = relation("Visit", { child: int4, stage: int4 }, ["child", "stage"])
const fields = { child: int4, stage: int4 } as const
const key = ["child", "stage"] as const
const outs = [
	relation("Out0", fields, key),
	relation("Out1", fields, key),
	relation("Out2", fields, key),
	relation("Out3", fields, key)
] as const

/** The app's own stages, a level above. */
const Stage = relation("Stage", { child: int4, key: int4 }, ["child", "key"])

const Lower = schema("BoundLower", [Visit, ...outs], [])
export const Upper = schema.extend([Lower], "BoundUpper", [Stage], [])

const sittingHeading = { child: Visit.fields.child, stage: Visit.fields.stage } as const

/** The lower level's open visits of the sittings its relation parameter names. */
const openVisit = query(Lower).rule((r) => {
	const sittings = r.relation("sittings", sittingHeading)
	const { child, stage } = v(sittings, "sitting")
	return r.match(sittings, { child, stage }).match(Visit, { child, stage }).find({ child, stage })
})

/** The child's own stages, the app's guard. */
const appSittings = query(Upper).rule((r) => {
	const { child, key: stage } = v(Stage, "own")
	return r
		.match(Stage, { child, key: stage })
		.where(r.eq(child, r.param("child", int4)))
		.find({ child, stage })
})

/** How many members read the guard, a case of the box. */
export type Readers = 1 | 2 | 4

export const readersGen: Gen<Readers> = element([1, 2, 4] as const)

/** How a case binds the guard: once for the whole ChangeSet, or in each member's own rule. */
export type Binding = "changeSet" | "import"

export const bindingGen: Gen<Binding> = element(["changeSet", "import"] as const)

/**
 * The case's write: `members` inserts over the lower level, each of the open visits into a relation of its own, the
 * visits' sittings bound to the app's guard by ChangeSet.bind, or by each member's import of openVisit in a rule over
 * the upper level.
 */
export const writeOf = (members: Readers, binding: Binding): unknown => {
	const taken = Arr.take(outs, members)
	if (binding === "changeSet") {
		return Arr.reduce(taken, ChangeSet.empty(Lower), (cs, out) =>
			cs.insert(
				out,
				query(Lower).rule((r) => {
					const open = openVisit.bind({ sittings: r.relation("sittings", sittingHeading) })
					const { child, stage } = v(open, "open")
					return r.match(open, { child, stage }).find({ child, stage })
				})
			)
		).bind({ sittings: appSittings })
	}
	return Arr.reduce(taken, ChangeSet.empty(Upper), (cs, out) =>
		cs.insert(
			out,
			query(Upper).rule((r) => {
				const open = openVisit.bind({
					sittings: appSittings.bind({ child: r.param("child", int4) })
				})
				const { child, stage } = v(open, "open")
				return r.match(open, { child, stage }).find({ child, stage })
			})
		)
	)
}
