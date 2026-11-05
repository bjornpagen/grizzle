/**
 * A counted family's writes as grizzle plans them (fin.md §4.2, §4.5, w4-w7 §2.1), over a folded family's stored state
 * (fold.ts): the statements of each change, in the order every change sends them, and the families each leaves.
 *
 * A counted family hides its index ‹i›, a drawn law column, so its members' order is grizzle's: removing a member is
 * swap-with-last, the last member moved into the freed slot and the count lowered, which leaves the freed slot's
 * successor without a predecessor until the move, so the predecessor axis is deferred. A fold over a counted family
 * hides its accumulators too, and every one is commutative, so the end is the same whatever order the members are in;
 * but each hidden before is its predecessor's after, so a move rewrites the accumulators of every slot from the freed
 * one on, each an `update` of its row.
 *
 * Every change sends deletes, then updates (the moves and the refolds), then the owner's one count update with its new
 * end, then inserts, each insert's rows in the order a test draws.
 */
import { Array as Arr, Order } from "effect"
import {
	type FoldFamily,
	type FoldMonoid,
	type FoldRow,
	type FoldStatement,
	type FoldStored,
	folded,
	type Step
} from "#test/support/families/fold.ts"

/** The members of one owner of a stored state, in slot order. */
const membersOf = (
	stored: FoldStored,
	owner: number
): ReadonlyArray<{ readonly member: number } & Step> =>
	Arr.map(
		Arr.sort(
			Arr.filter(stored.rows, (r) => r.group === owner),
			Order.mapInput(Order.Number, (r: FoldRow) => r.at)
		),
		(r) => ({ member: r.member, x: r.x, selected: r.selected })
	)

/** The families a stored state holds, every owner's members in slot order: what a committed state reads back as. */
const familiesOf = (stored: FoldStored): ReadonlyArray<FoldFamily> =>
	Arr.map(stored.owners, (o) => ({ owner: o.owner, members: membersOf(stored, o.owner) }))

/** A counted change: the statements it sends, and the families it leaves. */
export interface CountedChange {
	readonly statements: ReadonlyArray<FoldStatement>
	readonly after: ReadonlyArray<FoldFamily>
}

/** The families with one owner's members replaced. */
const replaced = (
	families: ReadonlyArray<FoldFamily>,
	owner: number,
	members: FoldFamily["members"]
): ReadonlyArray<FoldFamily> =>
	Arr.map(families, (f) => (f.owner === owner ? { owner, members } : f))

/**
 * Swap-with-last of the member at slot `at` of `owner`: delete it; move the last member into its slot and refold every
 * slot from `at` on (one update each, the moved member's included); lower the count, with the new end. The move is
 * omitted when the member removed is the last.
 */
export const swapWithLast = (
	m: FoldMonoid,
	stored: FoldStored,
	owner: number,
	at: number
): CountedChange => {
	const members = membersOf(stored, owner)
	const n = members.length
	const removed = Arr.getUnsafe(members, at)
	const kept =
		at < n - 1
			? [...members.slice(0, at), Arr.getUnsafe(members, n - 1), ...members.slice(at + 1, n - 1)]
			: members.slice(0, n - 1)
	const { slots, end } = folded(m, kept)
	const updates = Arr.flatMap(kept, (member, slot): ReadonlyArray<FoldStatement> => {
		if (slot < at) {
			return []
		}
		const { before, after } = Arr.getUnsafe(slots, slot)
		return [{ kind: "update", member: member.member, at: slot, before, after }]
	})
	return {
		statements: [
			{ kind: "delete", members: [removed.member] },
			...updates,
			{ kind: "count", owner: { owner, count: n - 1, end } }
		],
		after: replaced(familiesOf(stored), owner, kept)
	}
}

/**
 * Appending members to `owner`: raise the count with the new end, then insert the new rows after the last, each with its
 * accumulators, in `order` (a permutation of the new rows, so a row may arrive before its predecessor).
 */
export const appended = (
	m: FoldMonoid,
	stored: FoldStored,
	owner: number,
	added: Arr.NonEmptyReadonlyArray<{ readonly member: number } & Step>,
	order: ReadonlyArray<number>
): CountedChange => {
	const members = [...membersOf(stored, owner), ...added]
	const { slots, end } = folded(m, members)
	const n = members.length
	const rows = Arr.map(added, (s, k) => {
		const at = n - added.length + k
		return {
			group: owner,
			at,
			copy: n,
			member: s.member,
			x: s.x,
			selected: s.selected,
			...Arr.getUnsafe(slots, at)
		}
	})
	const sent = Arr.map(order, (i) => Arr.getUnsafe(rows, i))
	return {
		statements: [
			{ kind: "count", owner: { owner, count: n, end } },
			...(Arr.isReadonlyArrayNonEmpty(sent) ? [{ kind: "insert", rows: sent } as const] : [])
		],
		after: replaced(familiesOf(stored), owner, members)
	}
}

/**
 * The families a member's put that changes its step value leaves (rows-first §2, "a member update that changes a step
 * value refills from its slot"): every member keeps its slot, the member's value is the new one, and the reference fold
 * of the result is what the refill from its slot writes.
 */
export const stepPut = (
	stored: FoldStored,
	owner: number,
	member: number,
	x: bigint
): ReadonlyArray<FoldFamily> =>
	replaced(
		familiesOf(stored),
		owner,
		Arr.map(membersOf(stored, owner), (m) => (m.member === member ? { ...m, x } : m))
	)
