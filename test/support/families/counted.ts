/**
 * A counted family's writes as grizzle plans them (fin.md §4.2, §4.5, w4-w7 §2.1), over a folded family's stored state
 * (fold.ts): the statements of each change, in the order every change sends them, and the families each leaves.
 *
 * A counted family hides its index ‹i›, a drawn law column, so its members' order is grizzle's: removing a member is
 * swap-with-last, the last member moved into the freed slot and the count lowered, which leaves the freed slot's
 * successor without a predecessor until the move, so the predecessor axis is deferred. A fold over a counted family
 * hides its accumulators too, and every one is commutative, so the end is the same whatever order the members are in;
 * but each hidden before is its predecessor's after, so a move rewrites the accumulators of every slot from the freed
 * one on, each an `update` of its row, and the member left last takes its own slot as its successor (theorem.ts
 * successorOf), an `update` of its own where the member removed is the last.
 *
 * Every change sends deletes, then updates (the moves and the refolds), then the owner's one count update with its new
 * end, then inserts, each insert's rows in the order a test draws.
 *
 * Which of them a direct writer may send depends on how the relations stand. Over a mutable owner and member
 * (`mutable(Owner)`, `mutable(Member)`) it is swap-with-last as above, every update in place. Over the immutable
 * default an owner's count and end are fields its immutability guard holds fixed (physical/ddl/immutable.ts), so the
 * count update is refused (42501). The change is the whole family rewritten (rewrittenWhole): every member deleted, the
 * owner deleted and inserted again with the new count and end, and the kept members inserted at their slots, as grizzle
 * writes an immutable family whole with its owner (write/family/removals.ts).
 */
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, Order } from "effect"
import {
	type FoldFamily,
	type FoldMonoid,
	type FoldRow,
	type FoldStatement,
	type FoldStored,
	folded,
	foldStoredOf,
	type Step
} from "#test/support/families/fold.ts"
import { successorOf } from "#test/support/families/theorem.ts"

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
 * slot from `at` on (one update each, the moved member's included, each with its successor in the lowered count); lower
 * the count, with the new end. The move is omitted when the member removed is the last, and the member before it, now
 * the last, is updated to its own slot as its successor.
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
	const from = Math.min(at, n - 2)
	const updates = Arr.flatMap(kept, (member, slot): ReadonlyArray<FoldStatement> => {
		if (slot < from) {
			return []
		}
		const { before, after } = Arr.getUnsafe(slots, slot)
		return [
			{
				kind: "update",
				member: member.member,
				at: slot,
				next: successorOf(slot, n - 1),
				before,
				after
			}
		]
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
 * Appending members to `owner`: the member before them, where one stands, updated to the first appended slot as its
 * successor; then raise the count with the new end, then insert the new rows after the last, each with its accumulators
 * and its successor, in `order` (a permutation of the new rows, so a row may arrive before its predecessor).
 */
export const appended = (
	m: FoldMonoid,
	stored: FoldStored,
	owner: number,
	added: Arr.NonEmptyReadonlyArray<{ readonly member: number } & Step>,
	order: ReadonlyArray<number>
): CountedChange => {
	const had = membersOf(stored, owner)
	const members = [...had, ...added]
	const { slots, end } = folded(m, members)
	const n = members.length
	const seam = Arr.match(had, {
		onEmpty: (): ReadonlyArray<FoldStatement> => [],
		onNonEmpty: (stays): ReadonlyArray<FoldStatement> => {
			const last = stays.length - 1
			const { before, after } = Arr.getUnsafe(slots, last)
			return [
				{
					kind: "update",
					member: Arr.lastNonEmpty(stays).member,
					at: last,
					next: successorOf(last, n),
					before,
					after
				}
			]
		}
	})
	const rows = Arr.map(added, (s, k) => {
		const at = n - added.length + k
		return {
			group: owner,
			at,
			next: successorOf(at, n),
			member: s.member,
			x: s.x,
			selected: s.selected,
			...Arr.getUnsafe(slots, at)
		}
	})
	const sent = Arr.map(order, (i) => Arr.getUnsafe(rows, i))
	return {
		statements: [
			...seam,
			{ kind: "count", owner: { owner, count: n, end } },
			...(Arr.isReadonlyArrayNonEmpty(sent) ? [{ kind: "insert", rows: sent } as const] : [])
		],
		after: replaced(familiesOf(stored), owner, members)
	}
}

/**
 * Swap-with-last of the member at slot `at` of `owner` over an immutable owner and member (see the header): the family
 * swapWithLast leaves, written whole. Every member of the owner deleted; the owner deleted and inserted again with the
 * kept count and its end; the kept members, if any, inserted at their final slots with their accumulators.
 */
export const rewrittenWhole = (
	m: FoldMonoid,
	stored: FoldStored,
	owner: number,
	at: number
): CountedChange => {
	const swapped = swapWithLast(m, stored, owner, at)
	const reference = foldStoredOf(m, swapped.after)
	const members = nonEmpty(
		Arr.map(membersOf(stored, owner), (r) => r.member),
		"the owner's members, one of them removed"
	)
	const kept = Arr.filter(reference.rows, (r) => r.group === owner)
	const rewritten = defined(
		Arr.findFirst(reference.owners, (o) => o.owner === owner).pipe(Option.getOrUndefined),
		"the owner, kept with its family"
	)
	return {
		statements: [
			{ kind: "delete", members },
			{ kind: "drop", owner },
			{ kind: "create", owner: rewritten },
			...(Arr.isReadonlyArrayNonEmpty(kept) ? [{ kind: "insert" as const, rows: kept }] : [])
		],
		after: swapped.after
	}
}
