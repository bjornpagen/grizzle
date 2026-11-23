/** What lock-order.test.ts reads: its drawn members' borrows, and the lock order restated over them by brute force. */

import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { lockName, type MemberAt, type OrderEdge } from "#compiler/analysis/isolation/borrows.ts"
import type { Borrow, BorrowLock, KeySite } from "#compiler/core/certificate.ts"

/** The box's locks: three units and one relation's series lock. */
const LOCKS: Arr.NonEmptyReadonlyArray<BorrowLock> = [
	{ kind: "unit", unit: "A" },
	{ kind: "unit", unit: "B" },
	{ kind: "unit", unit: "C" },
	{ kind: "series", relation: "R" }
]

/** A site a drawn borrow keys: bound to the call's parameter, or held under one of the box's locks. */
const siteGen: Gen<KeySite> = (s) =>
	s.draw(boolean)
		? { kind: "bound", fields: [{ field: "k", source: { kind: "param", name: "k" } }] }
		: {
				kind: "held",
				relation: "L",
				key: [{ field: "k", source: { kind: "param", name: "k" } }],
				columns: ["k"],
				under: s.draw(element(LOCKS))
			}

const borrowGen: Gen<Borrow> = (s) => ({
	lock: s.draw(element(LOCKS)),
	mode: s.draw(element(["shared", "exclusive"] as const)),
	at: s.draw(element(["flight", "judge"] as const)),
	keys: Array.from({ length: s.draw(int(0, 2)) }, () => s.draw(siteGen))
})

/** A case: up to three members of one login and role, each with up to three borrows. */
export type Drawn = ReadonlyArray<{
	readonly at: MemberAt
	readonly borrows: ReadonlyArray<Borrow>
}>

export const drawnGen: Gen<Drawn> = (s) =>
	Array.from({ length: s.draw(int(1, 3)) }, (_, i) => ({
		at: { login: "l", role: "r", member: `m${i}` },
		borrows: Array.from({ length: s.draw(int(0, 3)) }, () => s.draw(borrowGen))
	}))

/** What a case reaches, as the oracle reads it off the drawn borrows. */
export type OrderFeature =
	| "an order with no edge"
	| "a flight lock before a judge lock"
	| "a held site's lock before the lock it keys"
	| "a tie broken by name"
	| "a lock only a held site names"
	| "a cycle of one"
	| "a cycle of several locks"

/** One edge as the oracle states it: the names of its two locks, and the member that first needs it. */
export interface StatedEdge {
	readonly from: string
	readonly to: string
	readonly by: string
}

/** The lock order restated over a case (the oracle): its locks, its edges, and the least order by name, if any. */
export interface Expected {
	readonly edges: ReadonlyArray<StatedEdge>
	readonly order: ReadonlyArray<string> | undefined
	readonly features: ReadonlySet<OrderFeature>
}

/** Every order of `names`. */
const permutations = (names: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
	names.length === 0
		? [[]]
		: Arr.flatMap(names, (name, i) =>
				Arr.map(permutations([...names.slice(0, i), ...names.slice(i + 1)]), (rest) => [
					name,
					...rest
				])
			)

/** Two orders by their names, place by place. */
const byNames = Order.mapInput(Order.String, (order: ReadonlyArray<string>) =>
	Arr.join(order, "\u0000")
)

/**
 * The lock order over the drawn borrows, apart from the code (analysis/isolation/borrows.ts lockOrder's doc): every lock
 * a member borrows or holds a site under; an edge from each lock a member borrows in flight to each it borrows at the
 * judge, and from each held site's lock to the lock its borrow takes, each stated by the first member that needs it;
 * and, among every order of the locks that puts each edge's first lock before its second (none for an edge from a lock
 * to itself), the least by name, place by place, found by trying them all.
 */
export const expectedOf = (d: Drawn): Expected => {
	const features = new Set<OrderFeature>()
	const names = new Set<string>()
	const edges = new Map<string, StatedEdge>()
	for (const { at, borrows } of d) {
		for (const b of borrows) {
			names.add(lockName(b.lock))
		}
		for (const first of borrows) {
			for (const then of borrows) {
				if (first.at !== "flight" || then.at !== "judge") {
					continue
				}
				features.add("a flight lock before a judge lock")
				const e = { from: lockName(first.lock), to: lockName(then.lock), by: at.member }
				edges.getOrInsert(`${e.from}|${e.to}`, e)
			}
		}
		for (const b of borrows) {
			for (const site of b.keys) {
				if (site.kind !== "held") {
					continue
				}
				features.add("a held site's lock before the lock it keys")
				const e = { from: lockName(site.under), to: lockName(b.lock), by: at.member }
				edges.getOrInsert(`${e.from}|${e.to}`, e)
				if (!Arr.some(d, (m) => Arr.some(m.borrows, (o) => lockName(o.lock) === e.from))) {
					features.add("a lock only a held site names")
				}
				names.add(e.from)
			}
		}
	}
	if (edges.size === 0) {
		features.add("an order with no edge")
	}
	const valid = Arr.filter(permutations([...names]), (order) =>
		Arr.every([...edges.values()], (e) => order.indexOf(e.from) < order.indexOf(e.to))
	)
	const order = Arr.isReadonlyArrayNonEmpty(valid) ? Arr.min(valid, byNames) : undefined
	if (order !== undefined && edges.size > 0 && valid.length > 1) {
		features.add("a tie broken by name")
	}
	if (order === undefined) {
		features.add(
			Arr.some([...edges.values()], (e) => e.from === e.to)
				? "a cycle of one"
				: "a cycle of several locks"
		)
	}
	return { edges: [...edges.values()], order, features }
}

/** An edge the code returns as the oracle states it. */
export const statedOf = (e: OrderEdge): StatedEdge => ({
	from: lockName(e.from),
	to: lockName(e.to),
	by: e.by.member
})
