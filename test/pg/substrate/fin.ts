/**
 * The model of fin.md §5.2's lemmas, never grizzle's lowering: what PostgreSQL does with each transaction of statements
 * on a family relation lowered for a direction, which test/pg/fin's lemma and family suites read (lemmas.fixtures.ts,
 * family.ts).
 *
 * An owner relation `owner (id, n)` counts the slots of its family relation `fam (member, g, at)`, grouped by `g`. The
 * lowering adds three columns grizzle draws and the constraints of the direction stated (§5.2's table):
 *
 * - F[g, at] ⊆ fin(O, n), `within`: the copy ‹n› of the owner's count, `FOREIGN KEY (g, ‹n›) REFERENCES owner (id, n)
 *   ON UPDATE CASCADE`, and `CHECK (at < ‹n›)`;
 * - fin(O, n) ⊆ F[g, at], `covers`: the owner's last slot, `FOREIGN KEY (id, pred(n)) REFERENCES fam (g, at)`, and the
 *   downward closure `FOREIGN KEY (g, ‹p›) REFERENCES fam (g, at)`, where ‹p› is `CASE WHEN at > 0 AND at < ‹n› THEN at −
 *   1 END`; both reference fam's `UNIQUE (g, at)`, since a containment's target holds a key of its relation (§3.4), and
 *   ‹p› reads the copy, so the copy's foreign key comes too;
 * - `mirrors`: all of them.
 *
 * The model is the families theorem's (test/support/families/theorem.ts) with the moment each constraint is checked a
 * parameter of the lowering.
 */
import { Array as Arr, Order } from "effect"
import {
	applied,
	type Moment,
	type MutationStatement,
	type Timing
} from "#test/support/families/mutate.ts"
import {
	type Constraint,
	type FamilyRow,
	type Stored,
	type FamilyViolation,
	familyViolations
} from "#test/support/families/theorem.ts"

/** Which half of the bijection a lowering states, or both. */
export type Direction = "within" | "covers" | "mirrors"

/**
 * A lowering of a direction: when PostgreSQL checks each of its three foreign keys, and whether the closure's ‹p› is
 * restricted to indices below the copy, as §5.2 states it, or unrestricted, the variant §5.2 says would also forbid
 * gaps above n.
 */
export interface Lowering {
	readonly direction: Direction
	readonly copy: Timing
	readonly last: Timing
	readonly closure: Timing
	readonly restriction: "restricted" | "unrestricted"
}

/** The constraints a direction installs beside the owner's own keys. */
const constraintsOf: Readonly<Record<Direction, ReadonlyArray<Constraint>>> = {
	within: ["identity", "copy", "bound"],
	covers: ["identity", "key", "copy", "last", "closure"],
	mirrors: ["identity", "key", "bound", "copy", "last", "closure"]
}

/** When PostgreSQL checks a constraint of a lowering: a key and a check at every statement, a foreign key as declared. */
const timingOf = (lowering: Lowering, constraint: Constraint): Timing => {
	switch (constraint) {
		case "identity":
		case "key":
		case "bound":
			return "statement"
		case "copy":
			return lowering.copy
		case "last":
			return lowering.last
		case "closure":
			return lowering.closure
	}
}

/** The SQLSTATE PostgreSQL raises a constraint's violation with: 23505 for a key, 23514 for a check, 23503 for an FK. */
export const sqlstateOf: Readonly<Record<Constraint, string>> = {
	identity: "23505",
	key: "23505",
	bound: "23514",
	copy: "23503",
	last: "23503",
	closure: "23503"
}

/**
 * One statement of a transaction: the families' statements (mutate.ts MutationStatement) and the two single-field changes of a
 * row they never send, which a single mutation of a state may still make:
 *
 * - `regroup` moves one member's row to another group, keeping its index and copy;
 * - `recopy` changes one member's copy of its owner's count.
 */
export type Mutation =
	| MutationStatement
	| { readonly kind: "regroup"; readonly member: number; readonly group: number }
	| { readonly kind: "recopy"; readonly member: number; readonly copy: number }

/** The state a mutation leaves, before any constraint is checked: what its SQL does to the rows it matches. */
const appliedTo = (stored: Stored, mutation: Mutation): Stored => {
	switch (mutation.kind) {
		case "regroup":
			return {
				owners: stored.owners,
				rows: Arr.map(stored.rows, (r) =>
					r.member === mutation.member ? { ...r, group: mutation.group } : r
				)
			}
		case "recopy":
			return {
				owners: stored.owners,
				rows: Arr.map(stored.rows, (r) =>
					r.member === mutation.member ? { ...r, copy: mutation.copy } : r
				)
			}
		case "create":
		case "drop":
		case "count":
		case "insert":
		case "delete":
		case "move":
			return applied(stored, mutation)
	}
}

/** The slots some row holds, as `group:at`. */
const heldSlots = (rows: ReadonlyArray<FamilyRow>): ReadonlySet<string> =>
	new Set(Arr.map(rows, (r) => `${r.group}:${r.at}`))

/**
 * Every constraint of the lowering the stored state breaks, whenever PostgreSQL checks it: the families theorem's
 * violations of the constraints the direction installs, the closure's read by the lowering's restriction.
 */
const violated = (lowering: Lowering, stored: Stored): ReadonlyArray<FamilyViolation> => {
	const present = new Set(constraintsOf[lowering.direction])
	const found = Arr.filter(
		familyViolations(stored),
		(v) =>
			present.has(v.constraint) &&
			(v.constraint !== "closure" || lowering.restriction === "restricted")
	)
	if (lowering.restriction === "restricted" || !present.has("closure")) {
		return found
	}
	const held = heldSlots(stored.rows)
	return [
		...found,
		...Arr.flatMap(stored.rows, (row): ReadonlyArray<FamilyViolation> =>
			row.at > 0 && !held.has(`${row.group}:${row.at - 1}`)
				? [{ constraint: "closure", member: row.member }]
				: []
		)
	]
}

/** What the model says PostgreSQL does with a transaction: it commits to a stored state, or is refused at a moment. */
export type Predicted =
	| { readonly kind: "committed"; readonly after: Stored }
	| {
			readonly kind: "refused"
			readonly moment: Moment
			readonly violations: Arr.NonEmptyReadonlyArray<FamilyViolation>
	  }

/**
 * The model of one transaction of `mutations` over the committed state `before`: after each statement every
 * constraint checked at a statement must hold, which is PostgreSQL's check of the rows the statement touched since the
 * state before broke none of them; at commit every constraint must hold.
 */
export const predicted = (
	lowering: Lowering,
	before: Stored,
	mutations: ReadonlyArray<Mutation>
): Predicted => {
	let state = before
	for (const [index, mutation] of mutations.entries()) {
		state = appliedTo(state, mutation)
		const broken = Arr.filter(
			violated(lowering, state),
			(v) => timingOf(lowering, v.constraint) === "statement"
		)
		if (Arr.isReadonlyArrayNonEmpty(broken)) {
			return { kind: "refused", moment: { kind: "statement", index }, violations: broken }
		}
	}
	const deferred = violated(lowering, state)
	return Arr.isReadonlyArrayNonEmpty(deferred)
		? { kind: "refused", moment: { kind: "commit" }, violations: deferred }
		: { kind: "committed", after: state }
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
