/**
 * What test/pg/fin's lemma and family suites read beside the families model (test/support/families/theorem.ts,
 * mutate.ts) of a family relation and its owner: the SQLSTATE each of the model's constraints is refused with, the empty
 * state a case starts from, and the one order two stored states compare in.
 */
import { Array as Arr, Order } from "effect"
import type { Constraint, FamilyRow, Stored } from "#test/support/families/theorem.ts"

/** The SQLSTATE PostgreSQL raises a constraint's violation with: 23505 for a key, 23503 for a foreign key. */
export const sqlstateOf: Readonly<Record<Constraint, string>> = {
	identity: "23505",
	key: "23505",
	holding: "23503",
	last: "23503",
	closure: "23503"
}

/** No owner and no row. */
export const emptyStored: Stored = { owners: new Map(), rows: [] }

/** A stored state's owners and rows in one canonical order, owners by key and rows by member, for exact comparison. */
export const canonical = (
	stored: Stored
): {
	readonly owners: ReadonlyArray<readonly [number, number]>
	readonly rows: ReadonlyArray<FamilyRow>
} => ({
	owners: Arr.sort(
		Array.from(stored.owners),
		Order.mapInput(Order.Number, ([o]: readonly [number, number]) => o)
	),
	rows: Arr.sort(
		stored.rows,
		Order.mapInput(Order.Number, (r: FamilyRow) => r.member)
	)
})
