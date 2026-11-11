/**
 * The violation queries of a family's and an accumulated copy's laws mean what the laws say (fin.md §4, §5.2, w4-w7
 * §2.3): evaluated by the reference evaluator over every state of a small box, each is empty exactly on the states a
 * second implementation, written from the law's statement, calls lawful. The boxes are exhausted and named in each
 * search; every invalid kind the doctrine names that a box can hold is one of its cases.
 *
 * - Ordered: two owners of count 0 to 2 and up to three members, each of owner a, b or none at slot 0 to 2. Plant:
 *   family-violation-no-last-arm (an ordered family's violation omits its last-member lemma).
 * - Counted: two owners of count 0 to 2 and up to three members, each of owner a, b or none. Plant:
 *   counted-violation-no-off-arm (a counted family's violation omits its count's mismatch).
 * - Copy: one owner's family of 0 to 3 members, each state and was 0 or 1, an accumulated copy riding its axis. Plant:
 *   copy-violation-no-pins (a riding copy's violation omits its pin at the axis's base).
 *
 * Plants are patches in ~/.cache/grizzle-release/BR03/plants. Features: each box's verdicts and broken laws.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { assert, defined } from "#test/support/assert.ts"
import { contained, f, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	accumulatedOf,
	drawnNatural,
	type HostFacts,
	lawOfShape,
	natural,
	schemaOf,
	theoryOf,
	uuidOf,
	violates
} from "#test/unit/analysis/theory/support.ts"

const byNumber = Order.Number

/** Whether `xs`, sorted, is exactly 0 … n − 1, each once. */
const isSlots = (xs: ReadonlyArray<number>, n: number): boolean => {
	const sorted = Arr.sort(xs, byNumber)
	return sorted.length === n && Arr.every(sorted, (x, i) => x === i)
}

/** An owner of the family boxes: O's two rows, a and b, and their counts. */
const owners = (counts: ReadonlyArray<number>): HostFacts["O"] =>
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

const orderedState: Gen<OrderedState> = (source) => ({
	counts: [int(0, 2)(source), int(0, 2)(source)],
	members: array((s): Slot => ({ owner: int(0, 2)(s), at: int(0, 2)(s) }), { min: 0, max: 3 })(
		source
	)
})

/** What breaks a family's state, or that nothing does: the doctrine's named invalid cases. */
type FamilyFault =
	| "lawful"
	| "an orphan"
	| "a duplicate slot"
	| "a gap in at"
	| "a count off by one"

/**
 * The ordered family's meaning, written from fin.md §4.1's theorem: every member has an owner, and each owner's
 * members are indexed by exactly 0 … n − 1. Its first fault, when it has one.
 */
const orderedFault = (s: OrderedState): FamilyFault => {
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

const countedState: Gen<CountedState> = (source) => ({
	counts: [int(0, 2)(source), int(0, 2)(source)],
	members: array(int(0, 2), { min: 0, max: 3 })(source)
})

/** A counted family's meaning (fin.md §4.2): every member has an owner, and each owner's count is its members'. */
const countedFault = (s: CountedState): FamilyFault =>
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

describe("a family's law", () => {
	const ordered = theoryOf(orderedSchema)
	const counted = theoryOf(countedSchema)
	it.effect(
		"is violated exactly when an ordered family's slots are not 0 … n − 1 or a member has no owner",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/violations/ordered",
						generator: orderedState,
						literal: Formatter.format,
						box: "two owners of count 0 to 2 and up to three members, each of owner a, b or none at slot 0 to 2",
						oracle: {
							kind: "second-implementation",
							name: "fin.md §4.1's theorem, checked directly"
						},
						coverage: requiredInSpace<FamilyFault>([
							"lawful",
							"an orphan",
							"a duplicate slot",
							"a gap in at",
							"a count off by one"
						]),
						caseHang
					},
					(s, k) =>
						Effect.sync(() => {
							const fault = orderedFault(s)
							k.note(fault)
							const facts: HostFacts = {
								O: owners(s.counts),
								F: Arr.map(s.members, (m, i) => ({
									fid: uuidOf(100 + i),
									o: uuidOf(m.owner + 1),
									at: BigInt(m.at)
								}))
							}
							assert.equal(
								violates(ordered, lawOfShape(ordered, "family"), facts),
								fault !== "lawful",
								`${Formatter.format(s)} is ${fault}`
							)
						})
				)
			)
	)

	it.effect(
		"is violated exactly when a counted family's counts are not its owners' member counts",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/violations/counted",
						generator: countedState,
						literal: Formatter.format,
						box: "two owners of count 0 to 2 and up to three members, each of owner a, b or none",
						oracle: {
							kind: "second-implementation",
							name: "fin.md §4.2's bijection, counted directly"
						},
						coverage: requiredInSpace<
							Extract<FamilyFault, "lawful" | "an orphan" | "a count off by one">
						>(["lawful", "an orphan", "a count off by one"]),
						caseHang
					},
					(s, k) =>
						Effect.sync(() => {
							const fault = countedFault(s)
							if (fault === "lawful" || fault === "an orphan" || fault === "a count off by one") {
								k.note(fault)
							}
							const facts: HostFacts = {
								O: owners(s.counts),
								F: Arr.map(s.members, (o, i) => ({ fid: uuidOf(100 + i), o: uuidOf(o + 1) }))
							}
							assert.equal(
								violates(counted, lawOfShape(counted, "family"), facts),
								fault !== "lawful",
								`${Formatter.format(s)} is ${fault}`
							)
						})
				)
			)
	)
})

/** A member of the copy box: the state it copies forward and the copy it holds of its predecessor's. */
interface Copied {
	readonly state: number
	readonly was: number
}

describe("an accumulated copy's law", () => {
	const t = theoryOf(
		schemaOf(
			[
				relation("O", { id: f.uuid, n: drawnNatural }, ["id"]),
				relation(
					"F",
					{
						fid: f.uuid,
						o: f.uuid,
						at: drawnNatural,
						state: natural,
						was: accumulatedOf(natural, 0n)
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
				contained(
					on("F", ["o", { kind: "pred", field: "at" }, "was"]),
					on("F", ["o", "at", "state"])
				)
			]
		)
	)
	const copy = lawOfShape(t, "contained")
	it.effect(
		"is violated exactly when a copy is not its predecessor's state, or not its start at slot 0",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/violations/copy",
						generator: array((s): Copied => ({ state: int(0, 1)(s), was: int(0, 1)(s) }), {
							min: 0,
							max: 3
						}),
						literal: Formatter.format,
						box: "one owner's family of 0 to 3 members, each state and was 0 or 1",
						oracle: {
							kind: "second-implementation",
							name: "the copy read directly: was is the predecessor's state, 0 at slot 0"
						},
						coverage: requiredInSpace<"lawful" | "off its start at slot 0" | "a stale predecessor">(
							["lawful", "off its start at slot 0", "a stale predecessor"]
						),
						caseHang
					},
					(members, k) =>
						Effect.sync(() => {
							const [first] = members
							const fault =
								first !== undefined && first.was !== 0
									? "off its start at slot 0"
									: Arr.some(members, (m, i) => i > 0 && m.was !== defined(members[i - 1]).state)
										? "a stale predecessor"
										: "lawful"
							k.note(fault)
							const facts: HostFacts = {
								O: [{ id: uuidOf(1), n: BigInt(members.length) }],
								F: Arr.map(members, (m, i) => ({
									fid: uuidOf(100 + i),
									o: uuidOf(1),
									at: BigInt(i),
									state: BigInt(m.state),
									was: BigInt(m.was)
								}))
							}
							assert.equal(
								violates(t, copy, facts),
								fault !== "lawful",
								`${Formatter.format(members)} is ${fault}`
							)
						})
				)
			)
	)
})
