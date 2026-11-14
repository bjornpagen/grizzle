/**
 * A fold's law means what the fold says (fin.md §4.3, w4-w7 §2.3): evaluated by the reference evaluator over every
 * state of a small box, its violation query is empty exactly on the states a naive fold calls lawful, with its
 * accumulators named (their copies, combine and identity pins) or hidden (the end alone). The boxes are exhausted and
 * named in each search. A fold ranges over its family's member rows, each distinct by its key, never over the
 * projection of its step value (rows-first §0): two members of one step value are two rows, which a sum counts twice.
 *
 * or's and twos' hidden folds state each handle's membership through set algebra, which the reference evaluator
 * declines by design (test/support/oracle/evaluate/catalog.ts: PostgreSQL alone evaluates it), so the hidden-fold box
 * judges the folds over naturals; the pg tier judges the set monoids' natives.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): fold-visible-no-first-pin (a named fold's violation omits its
 * first-slot identity pin) for the visible box; fold-hidden-no-off-arm (a hidden fold's violation omits the arm of an
 * end off its members' combine) for the hidden box.
 *
 * Features: each verdict and each broken law of each box.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { MonoidName } from "#compiler/ir/desc.ts"
import { assert, defined } from "#test/support/assert.ts"
import { f, on, onWhere, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
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

/** A member of the visible fold box: its step value, whether the step skips it, and its two accumulators. */
interface Stepped {
	readonly x: number
	readonly skip: number
	readonly before: number
	readonly after: number
}

interface VisibleFoldState {
	readonly members: ReadonlyArray<Stepped>
	readonly total: number
}

const visibleFoldState: Gen<VisibleFoldState> = (source) => ({
	members: array(
		(s): Stepped => ({
			x: int(0, 1)(s),
			skip: int(0, 1)(s),
			before: int(0, 2)(s),
			after: int(0, 2)(s)
		}),
		{ min: 0, max: 2 }
	)(source),
	total: int(0, 2)(source)
})

type FoldFault =
	| "lawful"
	| "a wrong fold accumulator at slot 0"
	| "a stale predecessor"
	| "a wrong step"
	| "a wrong end"

/**
 * A sum fold's meaning with its accumulators named (fin.md §4.3), a naive fold: the first before is 0, each before its
 * predecessor's after, each after its before plus x where the step selects it (skip = 0) and its before elsewhere, and
 * the owner's total its last after, or 0 for no member.
 */
const visibleFault = (s: VisibleFoldState): FoldFault => {
	const [first] = s.members
	if (first !== undefined && first.before !== 0) {
		return "a wrong fold accumulator at slot 0"
	}
	for (const [i, m] of s.members.entries()) {
		const prior = s.members[i - 1]
		if (prior !== undefined && m.before !== prior.after) {
			return "a stale predecessor"
		}
		if (m.after !== m.before + (m.skip === 0 ? m.x : 0)) {
			return "a wrong step"
		}
	}
	const last = s.members[s.members.length - 1]
	return s.total === (last === undefined ? 0 : last.after) ? "lawful" : "a wrong end"
}

const visibleFoldSchema: SchemaDesc = schemaOf(
	[
		relation("O", { id: f.uuid, n: drawnNatural, total: accumulatedOf(natural, 0n) }, ["id"]),
		relation(
			"F",
			{
				fid: f.uuid,
				o: f.uuid,
				at: drawnNatural,
				x: natural,
				skip: natural,
				before: accumulatedOf(natural, 0n),
				after: accumulatedOf(natural, 0n)
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
		{
			kind: "fold",
			family: { owner: "O", count: "n" },
			monoid: "sum",
			step: onWhere("F", ["o", "x", "before", "after"], {
				kind: "compare",
				op: "eq",
				left: { kind: "field", field: "skip" },
				right: { kind: "literal", value: 0n }
			}),
			end: on("O", ["id", "total"])
		}
	]
)

describe("a fold's law", () => {
	const visible = theoryOf(visibleFoldSchema)
	it.effect(
		"with named accumulators, is violated exactly when they are not the naive fold's",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/violations/fold-visible",
						generator: visibleFoldState,
						literal: Formatter.format,
						box: "one owner's family of 0 to 2 members, each x and skip 0 or 1, accumulators and total 0 to 2",
						oracle: { kind: "second-implementation", name: "a naive left fold over the slots" },
						coverage: requiredInSpace<FoldFault>([
							"lawful",
							"a wrong fold accumulator at slot 0",
							"a stale predecessor",
							"a wrong step",
							"a wrong end"
						]),
						caseHang,
						concurrency: 1
					},
					(s, k) =>
						Effect.sync(() => {
							const fault = visibleFault(s)
							k.note(fault)
							const facts: HostFacts = {
								O: [{ id: uuidOf(1), n: BigInt(s.members.length), total: BigInt(s.total) }],
								F: Arr.map(s.members, (m, i) => ({
									fid: uuidOf(100 + i),
									o: uuidOf(1),
									at: BigInt(i),
									x: BigInt(m.x),
									skip: BigInt(m.skip),
									before: BigInt(m.before),
									after: BigInt(m.after)
								}))
							}
							assert.equal(
								violates(visible, lawOfShape(visible, "fold"), facts),
								fault !== "lawful",
								`${Formatter.format(s)} is ${fault}`
							)
						})
				)
			)
	)

	/** The monoids whose hidden folds the reference evaluator judges: those over naturals. */
	type Counting = Extract<MonoidName, "count" | "sum" | "max">

	/** A hidden fold's state: its monoid, each member's step value and the owner's end. */
	interface HiddenFoldState {
		readonly monoid: Counting
		readonly xs: ReadonlyArray<number>
		readonly end: number
	}

	/** A member's step value, a natural 0 to 2, and the end: 0 to 4 for count and sum, 0 to 2 for max. */
	const hiddenFoldState: Gen<HiddenFoldState> = (source) => {
		const monoid = (["count", "sum", "max"] as const)[source.pick(0, 2)] ?? "count"
		const xs = array(int(0, 2), { min: 0, max: 2 })(source)
		return { monoid, xs, end: int(0, monoid === "max" ? 2 : 4)(source) }
	}

	/** A hidden fold's meaning, a naive fold of the members' step values: their count, sum or greatest value, 0 for none. */
	const hiddenLawful = (s: HiddenFoldState): boolean => {
		switch (s.monoid) {
			case "count":
				return s.end === s.xs.length
			case "sum":
				return s.end === Arr.reduce(s.xs, 0, (a, x) => a + x)
			case "max":
				return s.end === Arr.reduce(s.xs, 0, (a, x) => Math.max(a, x))
		}
	}

	/** The counted family of F under O, and a fold of `monoid` over it whose accumulators are hidden. */
	const hiddenSchema = (monoid: Counting): SchemaDesc =>
		schemaOf(
			[
				relation("O", { id: f.uuid, n: drawnNatural, end: accumulatedOf(natural, 0n) }, ["id"]),
				relation(
					"F",
					monoid === "count" ? { fid: f.uuid, o: f.uuid } : { fid: f.uuid, o: f.uuid, x: natural },
					["fid"]
				)
			],
			[
				{
					kind: "family",
					order: "counted",
					member: on("F", ["o"]),
					slots: { owner: "O", count: "n" }
				},
				{
					kind: "fold",
					family: { owner: "O", count: "n" },
					monoid,
					step: on("F", monoid === "count" ? ["o"] : ["o", "x"]),
					end: on("O", ["id", "end"])
				}
			]
		)
	const hidden = new Map(
		Arr.map(["count", "sum", "max"] as const, (m) => [m, theoryOf(hiddenSchema(m))] as const)
	)

	it.effect(
		"with hidden accumulators, is violated exactly when the end is not the naive fold's",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/violations/fold-hidden",
						generator: hiddenFoldState,
						literal: Formatter.format,
						box: "count, sum and max over a counted family of 0 to 2 members, each value 0 to 2, every end in range",
						oracle: { kind: "second-implementation", name: "a naive fold of the members' values" },
						coverage: requiredInSpace<
							`${Counting} ${"lawful" | "unlawful"}` | "two members of one step value, summed twice"
						>([
							"count lawful",
							"count unlawful",
							"sum lawful",
							"sum unlawful",
							"max lawful",
							"max unlawful",
							"two members of one step value, summed twice"
						]),
						caseHang,
						concurrency: 1
					},
					(s, k) =>
						Effect.sync(() => {
							const lawful = hiddenLawful(s)
							k.note(`${s.monoid} ${lawful ? "lawful" : "unlawful"}`)
							const [x, y] = s.xs
							if (s.monoid === "sum" && lawful && x !== undefined && x > 0 && x === y) {
								k.note("two members of one step value, summed twice")
							}
							const t = defined(hidden.get(s.monoid))
							const facts: HostFacts = {
								O: [{ id: uuidOf(1), n: BigInt(s.xs.length), end: BigInt(s.end) }],
								F: Arr.map(s.xs, (x, i) => ({
									fid: uuidOf(100 + i),
									o: uuidOf(1),
									...(s.monoid === "count" ? {} : { x: BigInt(x) })
								}))
							}
							assert.equal(
								violates(t, lawOfShape(t, "fold"), facts),
								!lawful,
								`${Formatter.format(s)} is ${lawful ? "the fold" : "no fold"}`
							)
						})
				)
			)
	)
})
