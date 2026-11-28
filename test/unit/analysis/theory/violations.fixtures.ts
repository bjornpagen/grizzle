/** What the properties of violations.test.ts read: its spaces, models and helpers. */

import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { contained, f, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	accumulatedOf,
	drawnNatural,
	type HostFacts,
	lawOfShape,
	naturalDesc,
	schemaOf,
	theoryOf,
	uuidOf
} from "#test/support/unit/analysis/theory/support.ts"

const byNumber = Order.Number

/** Whether `xs`, sorted, is exactly 0 … n − 1, each once. */
const isSlots = (xs: ReadonlyArray<number>, n: number): boolean => {
	const sorted = Arr.sort(xs, byNumber)
	return sorted.length === n && Arr.every(sorted, (x, i) => x === i)
}

/** An owner of the family boxes: O's two rows, a and b, and their counts. */
export const owners = (counts: ReadonlyArray<number>): HostFacts["O"] =>
	Arr.map(counts, (n, i) => ({ id: uuidOf(i + 1), n: BigInt(n) }))

/** One member of the ordered family box: its owner, 0 and 1 for a and b and 2 for no owner, and its slot. */
interface Slot {
	readonly owner: number
	readonly at: number
}

/** A state of the ordered family box: each owner's count and every member, each a slot. */
interface OrderedState {
	readonly counts: ReadonlyArray<number>
	readonly members: ReadonlyArray<Slot>
}

export const orderedState: Gen<OrderedState> = (source) => ({
	counts: [int(0, 2)(source), int(0, 2)(source)],
	members: array((s): Slot => ({ owner: int(0, 2)(s), at: int(0, 2)(s) }), { min: 0, max: 3 })(
		source
	)
})

/** What breaks a family's state, or that nothing does: the doctrine's named invalid cases. */
export type FamilyFault =
	| "lawful"
	| "an orphan"
	| "a duplicate slot"
	| "a gap in at"
	| "a count off by one"

/**
 * The ordered family's meaning, written from fin.md §4.1's theorem: every member has an owner, and each owner's
 * members are indexed by exactly 0 … n − 1. Its first fault, when it has one.
 */
export const orderedFault = (s: OrderedState): FamilyFault => {
	if (Arr.some(s.members, (m) => m.owner > 1)) {
		return "an orphan"
	}
	for (const [o, n] of s.counts.entries()) {
		const ats = Arr.map(
			Arr.filter(s.members, (m) => m.owner === o),
			(m) => m.at
		)
		if (isSlots(ats, n)) {
			continue
		}
		const distinct = new Set(ats).size === ats.length
		if (!distinct) {
			return "a duplicate slot"
		}
		return ats.length === n ? "a gap in at" : "a count off by one"
	}
	return "lawful"
}

const orderedSchema: SchemaDesc = schemaOf(
	[
		relation("O", { id: f.uuid, n: drawnNatural }, ["id"]),
		relation("F", { fid: f.uuid, o: f.uuid, at: drawnNatural }, ["fid"])
	],
	[
		{
			kind: "family",
			order: "ordered",
			member: on("F", ["o", "at"]),
			slots: { owner: "O", count: "n" }
		}
	]
)

/** A state of the counted family box: each owner's count and each member's owner. */
interface CountedState {
	readonly counts: ReadonlyArray<number>
	readonly members: ReadonlyArray<number>
}

export const countedState: Gen<CountedState> = (source) => ({
	counts: [int(0, 2)(source), int(0, 2)(source)],
	members: array(int(0, 2), { min: 0, max: 3 })(source)
})

/** A counted family's meaning (fin.md §4.2): every member has an owner, and each owner's count is its members'. */
export const countedFault = (s: CountedState): FamilyFault =>
	Arr.some(s.members, (o) => o > 1)
		? "an orphan"
		: Arr.every(s.counts, (n, o) => Arr.filter(s.members, (m) => m === o).length === n)
			? "lawful"
			: "a count off by one"

const countedSchema: SchemaDesc = schemaOf(
	[
		relation("O", { id: f.uuid, n: drawnNatural }, ["id"]),
		relation("F", { fid: f.uuid, o: f.uuid }, ["fid"])
	],
	[{ kind: "family", order: "counted", member: on("F", ["o"]), slots: { owner: "O", count: "n" } }]
)

export const ordered = theoryOf(orderedSchema)

export const counted = theoryOf(countedSchema)

/** A member of the copy box: the state it copies forward and the copy it holds of its predecessor's. */
export interface Copied {
	readonly state: number
	readonly was: number
}

export const t = theoryOf(
	schemaOf(
		[
			relation("O", { id: f.uuid, n: drawnNatural }, ["id"]),
			relation(
				"F",
				{
					fid: f.uuid,
					o: f.uuid,
					at: drawnNatural,
					state: naturalDesc,
					was: accumulatedOf(naturalDesc, 0n)
				},
				["fid"]
			)
		],
		[
			{
				kind: "family",
				order: "ordered",
				member: on("F", ["o", "at"]),
				slots: { owner: "O", count: "n" }
			},
			contained(on("F", ["o", { kind: "pred", field: "at" }, "was"]), on("F", ["o", "at", "state"]))
		]
	)
)

export const copy = lawOfShape(t, "contained")
