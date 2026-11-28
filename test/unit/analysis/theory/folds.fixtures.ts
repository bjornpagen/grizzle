/** What the properties of folds.test.ts read: its spaces, models and helpers. */

import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { MonoidName } from "#compiler/ir/desc.ts"
import { f, on, onWhere, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	accumulatedOf,
	drawnNatural,
	naturalDesc,
	schemaOf,
	type TestTheory,
	theoryOf
} from "#test/support/unit/analysis/theory/support.ts"

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

export const visibleFoldState: Gen<VisibleFoldState> = (source) => ({
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

export type FoldFault =
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
export const visibleFault = (s: VisibleFoldState): FoldFault => {
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
		relation("O", { id: f.uuid, n: drawnNatural, total: accumulatedOf(naturalDesc, 0n) }, ["id"]),
		relation(
			"F",
			{
				fid: f.uuid,
				o: f.uuid,
				at: drawnNatural,
				x: naturalDesc,
				skip: naturalDesc,
				before: accumulatedOf(naturalDesc, 0n),
				after: accumulatedOf(naturalDesc, 0n)
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

export const visible = theoryOf(visibleFoldSchema)

/** The monoids whose hidden folds the reference evaluator judges: those over naturals. */
export type Counting = Extract<MonoidName, "count" | "sum" | "max">

/** A hidden fold's state: its monoid, each member's step value and the owner's end. */
interface HiddenFoldState {
	readonly monoid: Counting
	readonly xs: ReadonlyArray<number>
	readonly end: number
}

/** A member's step value, a natural 0 to 2, and the end: 0 to 4 for count and sum, 0 to 2 for max. */
export const hiddenFoldState: Gen<HiddenFoldState> = (source) => {
	const monoid = (["count", "sum", "max"] as const)[source.pick(0, 2)] ?? "count"
	const xs = array(int(0, 2), { min: 0, max: 2 })(source)
	return { monoid, xs, end: int(0, monoid === "max" ? 2 : 4)(source) }
}

/** A hidden fold's meaning, a naive fold of the members' step values: their count, sum or greatest value, 0 for none. */
export const hiddenLawful = (s: HiddenFoldState): boolean => {
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
			relation("O", { id: f.uuid, n: drawnNatural, end: accumulatedOf(naturalDesc, 0n) }, ["id"]),
			relation(
				"F",
				monoid === "count"
					? { fid: f.uuid, o: f.uuid }
					: { fid: f.uuid, o: f.uuid, x: naturalDesc },
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

/** Each hidden fold's theory, by its monoid, built once. */
export const hidden: ReadonlyMap<Counting, TestTheory> = new Map(
	Arr.map(["count", "sum", "max"] as const, (m) => [m, theoryOf(hiddenSchema(m))] as const)
)
