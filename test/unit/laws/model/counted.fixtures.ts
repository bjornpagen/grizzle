/** What the property of counted.test.ts reads: its box, the counted family's schema, its states and statements. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int, map, oneOf, shuffled } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { appended, swapWithLast } from "#test/support/families/counted.ts"
import {
	type FoldFamily,
	type FoldMonoid,
	type FoldStatement,
	type FoldStored,
	foldStoredOf
} from "#test/support/families/fold.ts"
import {
	counted,
	f,
	fin,
	fold,
	on,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import type { ModelValue } from "#test/support/oracle/evaluate/catalog.ts"
import { upTo } from "#test/support/up-to.ts"
import { drawnColumn, modelOf, type Row, type State } from "#test/unit/laws/model/natives.ts"

/**
 * A counted family's natives admit exactly grizzle's plans and refuse every lawless state (fin.md §4.2, §4.5, w4-w7
 * §2.1): its index ‹i› is a drawn law column in no heading, ‹p› is pred of it, and its predecessor axis is deferred, so
 * swap-with-last, which leaves the freed slot's successor without a predecessor until the last member moves in, passes
 * every immediate native at each statement's end.
 *
 * The oracle is NP's model of a counted family's writes (test/support/families/counted.ts `swapWithLast`, `appended`),
 * the planner's statements in the order every change sends them, and the family law itself for the lawless states: a
 * state is lawful exactly when each owner's members are indexed 0 … n − 1 with n its count, each member's successor is
 * the slot after it below n and its own slot at n − 1, and the hidden count fold's accumulators and end are the
 * reference fold's. The judge is a host model of
 * the natives' PostgreSQL semantics (natives.ts `brokenBy`): every immediate native holds at each statement's end, and
 * every native at COMMIT.
 *
 * Bound: one owner of 0 to 4 members beside another of one; every swap-with-last at every slot, and every append of 1
 * or 2 members in every arrival order; and every lawful family of 0 to 4 members under each named lawless variant (a
 * duplicate slot, a gap, a count off by one, a stale successor, a member at slot −1, a junk accumulator at slot 0, a
 * junk end).
 *
 * Features: swap with last, append, an arrival out of order, and each named lawless variant.
 */

const count: FoldMonoid = { name: "count", least: 0n }

const schema: SchemaDesc = {
	name: "Counted",
	relations: [
		relation("Owner", { id: f.bigint, n: f.drawn, size: f.accumulated(f.natural, 0n) }, ["id"]),
		relation("Member", { id: f.bigint, owner: f.bigint }, ["id"])
	],
	statements: [
		counted(on("Member", ["owner"]), fin("Owner", "n")),
		fold(fin("Owner", "n"), "count", on("Member", ["owner"]), on("Owner", ["id", "size"]))
	],
	bases: []
}

/** The drawn columns of the member, by what each draws. */
interface Drawn {
	readonly index: string
	readonly next: string
	readonly before: string
	readonly after: string
}

const drawnOf = (model: LawModel): Drawn => ({
	index: drawnColumn(model, "Member", "index"),
	next: drawnColumn(model, "Member", "next"),
	before: drawnColumn(model, "Member", "before 0.0"),
	after: drawnColumn(model, "Member", "after 0.0")
})

/** A stored state of NP's model as the natives read it: each field and drawn column of every row. */
export const stateOf = (drawn: Drawn, stored: FoldStored): State =>
	new Map<string, ReadonlyArray<Row>>([
		[
			"Owner",
			Arr.map(
				stored.owners,
				(o) =>
					new Map<string, ModelValue>([
						["id", BigInt(o.owner)],
						["n", BigInt(o.count)],
						["size", o.end[0]]
					])
			)
		],
		[
			"Member",
			Arr.map(
				stored.rows,
				(r) =>
					new Map<string, ModelValue>([
						["id", BigInt(r.member)],
						["owner", BigInt(r.group)],
						[drawn.index, BigInt(r.at)],
						[drawn.next, BigInt(r.next)],
						[drawn.before, r.before[0]],
						[drawn.after, r.after[0]]
					])
			)
		]
	])

/** One owner's family of `size` members, numbered from 10, beside owner 2's one member, 20. */
const familiesOf = (size: number): ReadonlyArray<FoldFamily> => [
	{ owner: 1, members: upTo(size, (k) => ({ member: 10 + k, x: 0n, selected: true })) },
	{ owner: 2, members: [{ member: 20, x: 0n, selected: true }] }
]

type Change =
	| { readonly kind: "swap with last"; readonly size: number; readonly at: number }
	| { readonly kind: "append"; readonly size: number; readonly order: ReadonlyArray<number> }

/** The most members the owner's family holds before a change. */
const MOST = 4

/**
 * A change of the owner's family: a swap-with-last at any slot of a family of 1 to 4 members, or an append of 1 or 2
 * members in any arrival order to a family of 0 to 4.
 */
const changeGen: Gen<Change> = oneOf<Change>([
	(s) => {
		const size = s.draw(int(1, MOST))
		return { kind: "swap with last", size, at: s.draw(int(0, size - 1)) }
	},
	(s) => {
		const size = s.draw(int(0, MOST))
		const added = s.draw(int(1, 2))
		return {
			kind: "append",
			size,
			order: s.draw(
				shuffled(
					upTo(added, (k) => k),
					{ min: added, max: added }
				)
			)
		}
	}
])

/** The lawless variants of the family as a whole, which a family of no members carries too. */
const FAMILY_VARIANTS = [
	"a duplicate slot",
	"a gap",
	"a count off by one",
	"a member at slot −1",
	"a junk end"
] as const

/** The lawless variants that change a member the family holds, so only a family of a member or more carries one. */
const MEMBER_VARIANTS = ["a stale successor", "a junk accumulator at slot 0"] as const

type Variant = (typeof FAMILY_VARIANTS)[number] | (typeof MEMBER_VARIANTS)[number]

type CountedCase =
	| { readonly kind: "plan"; readonly change: Change }
	| { readonly kind: "lawless"; readonly size: number; readonly variant: Variant }

/**
 * The box: every change, and every lawless variant over every family it can be carried by: a family-wide one over 0 to
 * 4 members, a member's over 1 to 4.
 */
export const caseGen: Gen<CountedCase> = oneOf<CountedCase>([
	map(changeGen, (change): CountedCase => ({ kind: "plan", change })),
	(s) => ({
		kind: "lawless",
		size: s.draw(int(0, MOST)),
		variant: s.draw(element(FAMILY_VARIANTS))
	}),
	(s) => ({
		kind: "lawless",
		size: s.draw(int(1, MOST)),
		variant: s.draw(element(MEMBER_VARIANTS))
	})
])

export type Feature = "swap with last" | "append" | "an arrival out of order" | `variant ${Variant}`

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"swap with last",
	"append",
	"an arrival out of order",
	...Arr.map([...FAMILY_VARIANTS, ...MEMBER_VARIANTS], (v): Feature => `variant ${v}`)
]

/** A change's statements, NP's planner's, from the lawful state of its owner's family. */
export const statementsOf = (
	change: Change
): { readonly from: FoldStored; readonly statements: ReadonlyArray<FoldStatement> } => {
	const from = foldStoredOf(count, familiesOf(change.size))
	switch (change.kind) {
		case "swap with last":
			return { from, statements: swapWithLast(count, from, 1, change.at).statements }
		case "append": {
			const added = nonEmpty(
				upTo(change.order.length, (k) => ({ member: 30 + k, x: 0n, selected: true }))
			)
			return { from, statements: appended(count, from, 1, added, change.order).statements }
		}
	}
}

/** The lawful state of `size` members with one named variant applied: a state the family law refuses. */
export const lawlessOf = (size: number, variant: Variant): FoldStored => {
	const lawful = foldStoredOf(count, familiesOf(size))
	const ownRows = Arr.filter(lawful.rows, (r) => r.group === 1)
	const rest = Arr.filter(lawful.rows, (r) => r.group !== 1)
	const extra = {
		group: 1,
		at: size,
		next: size,
		member: 99,
		x: 0n,
		selected: true,
		before: [0n] as const,
		after: [1n] as const
	}
	switch (variant) {
		case "a duplicate slot":
			return {
				owners: lawful.owners,
				rows: [...lawful.rows, { ...extra, at: Math.max(size - 1, 0) }]
			}
		case "a gap":
			return { owners: lawful.owners, rows: [...lawful.rows, extra] }
		case "a count off by one":
			return {
				owners: Arr.map(lawful.owners, (o) => (o.owner === 1 ? { ...o, count: o.count + 1 } : o)),
				rows: lawful.rows
			}
		case "a stale successor":
			return {
				owners: lawful.owners,
				rows: [...rest, ...Arr.map(ownRows, (r) => ({ ...r, next: r.next + 1 }))]
			}
		case "a member at slot −1":
			return { owners: lawful.owners, rows: [...lawful.rows, { ...extra, at: -1 }] }
		case "a junk accumulator at slot 0":
			return {
				owners: lawful.owners,
				rows: [
					...rest,
					...Arr.map(ownRows, (r) =>
						r.at === 0 ? { ...r, before: [5n] as const, after: [6n] as const } : r
					)
				]
			}
		case "a junk end":
			return {
				owners: Arr.map(lawful.owners, (o) =>
					o.owner === 1 ? { ...o, end: [o.end[0] + 5n] as const } : o
				),
				rows: lawful.rows
			}
	}
}

/** What the search built once before its cases (model, drawn), now once per worker: every case on it reads them. */
export const drawnNeed = {
	key: "test/unit/laws/model/counted.fixtures.ts drawnNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const model = modelOf(schema)
		const drawn = drawnOf(model)
		return Effect.succeed({ model, drawn })
	})
} as const satisfies Need<unknown>
