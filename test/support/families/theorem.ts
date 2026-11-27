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
 * The lowering holds the theorem with three foreign keys on the family relation beside its own key, and no row holds
 * its owner's count. Each row keeps its successor: the slot after its own where its owner's count passes that slot,
 * and its own slot where it does not, at its group's last. Each row references its owner where the owner's count is
 * positive (the owner axis); each row whose index is positive references the row one slot down whose successor is its
 * index (the closure); and the owner's last slot, count − 1 where the count is positive, references the row there whose
 * successor is that slot itself (the last slot). Read together, the last slot and the closure fill every slot below the
 * count, and a row at the count names the last slot's row its predecessor, whose successor the last slot holds at
 * itself, so no row lies at or beyond the count: a writer that appends rewrites its owner, its new rows and the one row
 * they follow, never the others.
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
 * A row of the family relation as PostgreSQL stores it: its group (its owner's key), its index, its successor ‹s›, and
 * its own key.
 */
export interface FamilyRow {
	readonly group: number
	readonly at: number
	readonly next: number
	readonly member: number
}

/**
 * The successor a row at slot `at` of a family of `count` members holds, as the host draws it: the slot after its own
 * where the count passes that slot, else its own slot, the last's; a row at or past the count, or under no owner, its
 * own slot too.
 */
export const successorOf = (at: number, count: number): number => (at + 1 < count ? at + 1 : at)

/**
 * What PostgreSQL holds of a family relation and its owner relation: each owner's count by its key, which the owner's
 * primary key makes a function, and the family rows in no order. Unlike Families, a stored state can break the theorem:
 * it is what a statement leaves before its constraints are checked.
 */
export interface Stored {
	readonly owners: ReadonlyMap<number, number>
	readonly rows: ReadonlyArray<FamilyRow>
}

/** The rows of a family at consecutive slots from `from`, each with its successor in a family of `count`. */
export const familyRowsFrom = (
	group: number,
	members: ReadonlyArray<number>,
	from: number,
	count: number
): ReadonlyArray<FamilyRow> =>
	Arr.map(members, (member, i) => ({
		group,
		at: from + i,
		next: successorOf(from + i, count),
		member
	}))

/** What PostgreSQL holds once the families are written: each member at its position with its successor. */
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
 * rows are indexed by exactly 0 … count − 1, and otherwise every breach. Successors are the lowering's, so it never
 * reads them.
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
 * - `holding`: the owner axis, its holding reference, the foreign key of (group) into the owner's key where its count
 *   is positive, deferred: a family that carries no copy has no other reference into its owner;
 * - `last`: the last axis, the foreign key of the owner's last slot, (key, count − 1, count − 1) where the count is
 *   positive, into (group, at, successor);
 * - `closure`: the predecessor axis, the foreign key of (group, at − 1, at), where the index is positive, into (group,
 *   at, successor).
 */
const CONSTRAINTS = ["identity", "key", "holding", "last", "closure"] as const

export type Constraint = (typeof CONSTRAINTS)[number]

/** A stored state's breaking of one constraint, naming the row or owner that breaks it. */
export type FamilyViolation =
	| { readonly constraint: "identity"; readonly member: number }
	| { readonly constraint: "key"; readonly group: number; readonly at: number }
	| { readonly constraint: "holding"; readonly member: number }
	| { readonly constraint: "last"; readonly owner: number }
	| { readonly constraint: "closure"; readonly member: number }

/** Every constraint the stored state breaks, whenever PostgreSQL would check it; none when every one holds. */
export const familyViolations = (stored: Stored): ReadonlyArray<FamilyViolation> => {
	const held = occupancy(stored.rows)
	const found: Array<FamilyViolation> = []
	/** Whether a row of `group` at `at` holds the successor `next`. */
	const holds = (group: number, at: number, next: number): boolean =>
		Arr.some(stored.rows, (r) => r.group === group && r.at === at && r.next === next)
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
		const count = stored.owners.get(row.group)
		if (count === undefined || count === 0) {
			found.push({ constraint: "holding", member: row.member })
		}
		if (row.at > 0 && !holds(row.group, row.at - 1, row.at)) {
			found.push({ constraint: "closure", member: row.member })
		}
	}
	for (const [owner, count] of stored.owners) {
		if (count > 0 && !holds(owner, count - 1, count - 1)) {
			found.push({ constraint: "last", owner })
		}
	}
	return found
}
