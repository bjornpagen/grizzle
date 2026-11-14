/**
 * The theorem of a finite indexed family, the oracle every family test is judged by, and the constraints PostgreSQL
 * holds it with.
 *
 * A family relation groups its rows by the key of an owner relation, and a natural field of the owner counts them: its
 * slots are every (owner, i) with 0 ≤ i < count. An ordered family keys its rows by (group, at) and mirrors them into
 * the slots; a counted family states the same bijection with its index bound inside the law, so no caller reads it.
 * Both satisfy one theorem:
 *
 *     for every owner, the family rows grouped under it are indexed by exactly 0 … count − 1.
 *
 * It has three parts: no slot holds two rows (the key); every row lies in a slot of an owner (within: an owner exists,
 * and the row's index is below its count); every slot holds a row (covers: no index below the count is missing).
 *
 * The lowering holds the theorem with four constraints on the family relation beside its own key. Each row keeps a copy
 * of its owner's count: a foreign key of (group, copy) into the owner's (key, count), which cascades a count update into
 * every copy, plus a check that the index lies below the copy. The owner's last slot, count − 1 where the count is
 * positive, references a family row. Each row whose index is positive and below its copy references the row one slot
 * down. Read together, the last slot and the closure below the copy fill every slot; restricting the closure to indices
 * below the copy is what keeps it from forbidding gaps above the count, which only the bound refuses.
 */
import { Array as Arr, Order, Result } from "effect"

/**
 * Whether a family's index is a field its callers read (ordered) or one bound inside its law alone (counted). The
 * theorem and its constraints are the same for both; what differs is when PostgreSQL checks the closure.
 */
export const SHAPES = ["ordered", "counted"] as const

export type Shape = (typeof SHAPES)[number]

/**
 * One owner's family as the application writes it, an array under its owner: its members in slot order, so a member's
 * slot is its position and the owner's count is the array's length. A list holds no gap, no shared slot and no count
 * that disagrees with it, so every family satisfies the theorem by its representation. An owner is its key and a
 * member its row's own key, such as a tree's child, each a small whole number a test maps to its relation's key values:
 * plain numbers, so a kept case is the literal it prints.
 */
export interface Family {
	readonly owner: number
	readonly members: ReadonlyArray<number>
}

/** Every owner's family, in ascending order of owner, each owner once and each member in one family once. */
export type Families = ReadonlyArray<Family>

/**
 * A row of the family relation as PostgreSQL stores it: its group (its owner's key), its index, its copy of its owner's
 * count, and its own key.
 */
export interface FamilyRow {
	readonly group: number
	readonly at: number
	readonly copy: number
	readonly member: number
}

/**
 * What PostgreSQL holds of a family relation and its owner relation: each owner's count by its key, which the owner's
 * primary key makes a function, and the family rows in no order. Unlike Families, a stored state can break the theorem:
 * it is what a statement leaves before its constraints are checked.
 */
export interface Stored {
	readonly owners: ReadonlyMap<number, number>
	readonly rows: ReadonlyArray<FamilyRow>
}

/** The rows of a family at consecutive slots from `from`, each copying `copy`. */
export const familyRowsFrom = (
	group: number,
	members: ReadonlyArray<number>,
	from: number,
	copy: number
): ReadonlyArray<FamilyRow> =>
	Arr.map(members, (member, i) => ({ group, at: from + i, copy, member }))

/** What PostgreSQL holds once the families are written: each member at its position, every copy its owner's count. */
export const storedOf = (families: Families): Stored => ({
	owners: new Map(Arr.map(families, (f) => [f.owner, f.members.length] as const)),
	rows: Arr.flatMap(families, (f) => familyRowsFrom(f.owner, f.members, 0, f.members.length))
})

/**
 * How a stored state breaks the theorem: a slot two rows share (the key), a row whose group has no owner, a row at or
 * beyond its owner's count (within), and a slot below the count no row holds (covers).
 */
export type Breach =
	| { readonly kind: "twice"; readonly group: number; readonly at: number }
	| { readonly kind: "orphan"; readonly member: number }
	| { readonly kind: "beyond"; readonly member: number }
	| { readonly kind: "gap"; readonly owner: number; readonly at: number }

/** The part of the theorem a breach breaks. */
export type Part = "key" | "within" | "covers"

export const partOf: Readonly<Record<Breach["kind"], Part>> = {
	twice: "key",
	orphan: "within",
	beyond: "within",
	gap: "covers"
}

/** A slot and how many rows hold it. */
interface Slot {
	readonly group: number
	readonly at: number
	readonly rows: number
}

const slotKey = (group: number, at: number): string => `${group}:${at}`

/** Every slot some row holds, by slotKey, with how many rows hold it. */
const occupancy = (rows: ReadonlyArray<FamilyRow>): ReadonlyMap<string, Slot> => {
	const held = new Map<string, Slot>()
	for (const row of rows) {
		const key = slotKey(row.group, row.at)
		held.set(key, { group: row.group, at: row.at, rows: (held.get(key)?.rows ?? 0) + 1 })
	}
	return held
}

/** Every way the stored state breaks the theorem, none when it holds. */
export const breachesOf = (stored: Stored): ReadonlyArray<Breach> => {
	const held = occupancy(stored.rows)
	const breaches: Array<Breach> = []
	for (const slot of held.values()) {
		if (slot.rows > 1) {
			breaches.push({ kind: "twice", group: slot.group, at: slot.at })
		}
	}
	for (const row of stored.rows) {
		const count = stored.owners.get(row.group)
		if (count === undefined) {
			breaches.push({ kind: "orphan", member: row.member })
		} else if (row.at >= count) {
			breaches.push({ kind: "beyond", member: row.member })
		}
	}
	for (const [owner, count] of stored.owners) {
		for (let at = 0; at < count; at++) {
			if (!held.has(slotKey(owner, at))) {
				breaches.push({ kind: "gap", owner, at })
			}
		}
	}
	return breaches
}

/**
 * The theorem as a parser: the families a stored state holds, each owner's members in slot order, when every owner's
 * rows are indexed by exactly 0 … count − 1, and otherwise every breach. Copies are the lowering's, so it never reads
 * them.
 */
export const theorem = (
	stored: Stored
): Result.Result<Families, Arr.NonEmptyReadonlyArray<Breach>> => {
	const breaches = breachesOf(stored)
	if (Arr.isReadonlyArrayNonEmpty(breaches)) {
		return Result.fail(breaches)
	}
	return Result.succeed(
		Arr.map(Arr.sort(stored.owners.keys(), Order.Number), (owner) => ({
			owner,
			members: Arr.map(
				Arr.sort(
					Arr.filter(stored.rows, (r) => r.group === owner),
					Order.mapInput(Order.Number, (r: FamilyRow) => r.at)
				),
				(r) => r.member
			)
		}))
	)
}

/**
 * The constraints the lowering installs, beside the owner's primary key:
 *
 * - `identity`: the family relation's own primary key, on the member;
 * - `key`: the unique (group, at);
 * - `bound`: the check that the index lies below the row's copy of its owner's count;
 * - `copy`: the foreign key of (group, copy) into the owner's (key, count), cascading a count update into every copy;
 * - `last`: the foreign key of the owner's last slot, (key, count − 1) where the count is positive, into (group, at);
 * - `closure`: the foreign key of (group, at − 1), where the index is positive and below the copy, into (group, at).
 */
export const CONSTRAINTS = ["identity", "key", "bound", "copy", "last", "closure"] as const

export type Constraint = (typeof CONSTRAINTS)[number]

/** A stored state's breaking of one constraint, naming the row or owner that breaks it. */
export type FamilyViolation =
	| { readonly constraint: "identity"; readonly member: number }
	| { readonly constraint: "key"; readonly group: number; readonly at: number }
	| { readonly constraint: "bound"; readonly member: number }
	| { readonly constraint: "copy"; readonly member: number }
	| { readonly constraint: "last"; readonly owner: number }
	| { readonly constraint: "closure"; readonly member: number }

/** Every constraint the stored state breaks, whenever PostgreSQL would check it; none when every one holds. */
export const familyViolations = (stored: Stored): ReadonlyArray<FamilyViolation> => {
	const held = occupancy(stored.rows)
	const found: Array<FamilyViolation> = []
	const members = new Map<number, number>()
	for (const row of stored.rows) {
		members.set(row.member, (members.get(row.member) ?? 0) + 1)
	}
	for (const [member, rows] of members) {
		if (rows > 1) {
			found.push({ constraint: "identity", member })
		}
	}
	for (const slot of held.values()) {
		if (slot.rows > 1) {
			found.push({ constraint: "key", group: slot.group, at: slot.at })
		}
	}
	for (const row of stored.rows) {
		if (row.at >= row.copy) {
			found.push({ constraint: "bound", member: row.member })
		}
		if (stored.owners.get(row.group) !== row.copy) {
			found.push({ constraint: "copy", member: row.member })
		}
		if (row.at > 0 && row.at < row.copy && !held.has(slotKey(row.group, row.at - 1))) {
			found.push({ constraint: "closure", member: row.member })
		}
	}
	for (const [owner, count] of stored.owners) {
		if (count > 0 && !held.has(slotKey(owner, count - 1))) {
			found.push({ constraint: "last", owner })
		}
	}
	return found
}
