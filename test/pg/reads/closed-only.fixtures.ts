/** What the properties of closed-only.test.ts read: its spaces, models and helpers. */

import { array, type Gen, int, map, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { str } from "#compiler/public/text.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"

/**
 * A schema of closed relations only installs, opens and reads on PostgreSQL 19.
 *
 * Rosters and closed relations state no law of their own, so such a schema has no law at all and an empty law DAG. No
 * generated population reaches it (every generated schema holds a stored relation), so it is planted: each case draws
 * two rosters, a drawn subset of a handle pool in a drawn order, and a closed relation over one of them, keyed by its
 * closed id, with a number and a text drawn per handle. It installs through its first migration as any schema does, its
 * law theory is empty, it stores no table (a roster is a domain and its names constant, a closed relation's rows reach
 * the database only as constants), Db.open admits it, and a workload member reads every roster's handles. A closed
 * relation's rows are read only through its closed reads, which stand in predicates and generation expressions, never
 * in a query's head, so no query delivers them.
 *
 * - Property: the schema installs with no law and no table, and each roster's read delivers its handles, as a set.
 * - Oracle: the specification turned into a checker, the schema restated.
 * - Features: a roster of one handle, and one of every handle.
 */
export const Label = str.regex("^.*$", "su")

export const handlePool = ["Free", "Pro", "Team", "Gold", "Basic"] as const

export const labelPool = ["", "a", "é", "\u{1F600}", "two words"] as const

/** A nonempty subset of the handle pool, in a drawn order. */
const rosterGen: Gen<Arr.NonEmptyReadonlyArray<string>> = map(
	shuffled(handlePool, { min: 1, max: handlePool.length }),
	(handles) => nonEmptyList(handles, "a roster")
)

interface PlansCase {
	readonly tiers: Arr.NonEmptyReadonlyArray<string>
	/** Each tier's seats and label, by position. */
	readonly payload: ReadonlyArray<readonly [number, number]>
	readonly regions: Arr.NonEmptyReadonlyArray<string>
}

export const plansCaseGen: Gen<PlansCase> = (source) => ({
	tiers: source.draw(rosterGen),
	payload: source.draw(
		array(
			(drawing) => [drawing.draw(int(-3, 60)), drawing.draw(int(0, labelPool.length - 1))] as const,
			{ min: handlePool.length, max: handlePool.length }
		)
	),
	regions: source.draw(rosterGen)
})

export type ClosedFeature = "one handle" | "every handle"
