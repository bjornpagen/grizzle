/**
 * A family write's rows, as the columnar transport carries them.
 *
 * A family relation groups its members by the key of an owner relation, and a natural field of the owner counts
 * them. Each member holds a slot below the count, its index, and keeps a copy of the count, which the copy's foreign
 * key cascades from the owner. grizzle draws all four:
 *
 * - a member's group is its owner's key;
 * - its index is its position in the array it is written in;
 * - its copy, and its owner's count, are that array's length.
 *
 * None of them is the caller's, so no write can state a gap, a shared slot or a count that disagrees with its family.
 * Every row is the texts of its columns, in the layout its texts function states: the owner's key first, so one
 * statement's arrays read the group the same way whatever it writes.
 */
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"

/** An owner, by its key's texts, in the order the family's group fields pair with them. */
export type Owner = NonEmptyReadonlyArray<string>

/**
 * A member as the host encodes it: the texts of every field its caller writes or a fold accumulates, in the family
 * relation's column order, and of none the family draws. A rewrite fixes every member's slot, so a fold's fields are
 * computed from it before its plan is.
 */
export type Member = ReadonlyArray<string>

/** An owner's slots from `from` up to `to`, exclusive, whose members one statement deletes. */
export interface Vacated {
	readonly owner: Owner
	readonly from: number
	readonly to: number
}

/** An owner's count, as one statement sets it. */
export interface Recount {
	readonly owner: Owner
	readonly count: number
}

/** A member at its slot, with its owner's count copied, as one statement inserts it. */
export interface Placed {
	readonly owner: Owner
	readonly at: number
	readonly copy: number
	readonly member: Member
}

/** Members at consecutive slots from `from`, each at its position after `from`, each copying `copy`. */
export const placed = (
	owner: Owner,
	from: number,
	copy: number,
	members: ReadonlyArray<Member>
): ReadonlyArray<Placed> => members.map((member, i) => ({ owner, at: from + i, copy, member }))

/** A deleted run's texts: the owner's key, then the run's first slot and the slot after its last. */
export const vacatedTexts = (row: Vacated): ReadonlyArray<string> => [
	...row.owner,
	String(row.from),
	String(row.to)
]

/** A count's texts: the owner's key, then the count. */
export const recountTexts = (row: Recount): ReadonlyArray<string> => [
	...row.owner,
	String(row.count)
]

/** A placed member's texts: the owner's key as its group, its index, its copy of the count, then its own fields. */
export const placedTexts = (row: Placed): ReadonlyArray<string> => [
	...row.owner,
	String(row.at),
	String(row.copy),
	...row.member
]
