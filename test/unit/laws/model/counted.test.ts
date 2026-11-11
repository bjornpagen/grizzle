/**
 * A counted family's natives admit exactly grizzle's plans and refuse every lawless state (fin.md §4.2, §4.5, w4-w7
 * §2.1): its index ‹i› is a drawn law column in no heading, ‹p› is pred of it, and its predecessor axis is deferred, so
 * swap-with-last, which leaves the freed slot's successor without a predecessor until the last member moves in, passes
 * every immediate native at each statement's end.
 *
 * The oracle is NP's model of a counted family's writes (test/support/families/counted.ts `swapWithLast`, `appended`),
 * the planner's statements in the order every change sends them, and the family law itself for the lawless states: a
 * state is lawful exactly when each owner's members are indexed 0 … n − 1 with n its count, each member's copy of the
 * count is n, and the hidden count fold's accumulators and end are the reference fold's. The judge is a host model of
 * the natives' PostgreSQL semantics (natives.ts `brokenBy`): every immediate native holds at each statement's end, and
 * every native at COMMIT.
 *
 * Bound: one owner of 0 to 4 members beside another of one; every swap-with-last at every slot, and every append of 1
 * or 2 members in every arrival order; and every lawful family of 0 to 4 members under each named lawless variant (a
 * duplicate slot, a gap, a count off by one, a stale copy, a member at slot −1, a junk accumulator at slot 0, a junk
 * end).
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): counted-predecessor-immediate (an immediate predecessor axis, which
 * swap-with-last breaks mid-plan) and counted-bound-no-floor (the counted bound without `‹i› >= 0`, so a member at slot
 * −1 is accepted).
 *
 * Features: swap with last, append, an arrival out of order, and each named lawless variant.
 */

import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { appended, swapWithLast } from "#test/support/families/counted.ts"
import {
	type FoldFamily,
	type FoldMonoid,
	type FoldStatement,
	type FoldStored,
	foldApplied,
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
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	brokenBy,
	drawnColumn,
	immediate,
	modelOf,
	type Row,
	type State
} from "#test/unit/laws/model/natives.ts"

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
	extends: undefined
}

/** The drawn columns of the member, by what each draws. */
interface Drawn {
	readonly index: string
	readonly copy: string
	readonly before: string
	readonly after: string
}

const drawnOf = (model: LawModel): Drawn => ({
	index: drawnColumn(model, "Member", "index"),
	copy: drawnColumn(model, "Member", "copy"),
	before: drawnColumn(model, "Member", "before 0.0"),
	after: drawnColumn(model, "Member", "after 0.0")
})

/** A stored state of NP's model as the natives read it: each field and drawn column of every row. */
const stateOf = (drawn: Drawn, stored: FoldStored): State =>
	new Map<string, ReadonlyArray<Row>>([
		[
			"Owner",
			Arr.map(
				stored.owners,
				(o) =>
					new Map<string, CarrierValue>([
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
					new Map<string, CarrierValue>([
						["id", BigInt(r.member)],
						["owner", BigInt(r.group)],
						[drawn.index, BigInt(r.at)],
						[drawn.copy, BigInt(r.copy)],
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

/** Every permutation of 0 … k − 1. */
const permutations = (k: number): ReadonlyArray<ReadonlyArray<number>> =>
	k === 0
		? [[]]
		: Arr.flatMap(permutations(k - 1), (p) =>
				upTo(k, (at) => [...p.slice(0, at), k - 1, ...p.slice(at)])
			)

const changes: Arr.NonEmptyReadonlyArray<Change> = nonEmpty([
	...Arr.flatMap(
		Arr.makeBy(4, (k) => k + 1),
		(size) => upTo(size, (at): Change => ({ kind: "swap with last", size, at }))
	),
	...Arr.flatMap(
		Arr.makeBy(5, (k) => k),
		(size) =>
			Arr.flatMap([1, 2], (added) =>
				Arr.map(permutations(added), (order): Change => ({ kind: "append", size, order }))
			)
	)
])

type Variant =
	| "a duplicate slot"
	| "a gap"
	| "a count off by one"
	| "a stale copy"
	| "a member at slot −1"
	| "a junk accumulator at slot 0"
	| "a junk end"
const variants: Arr.NonEmptyReadonlyArray<Variant> = [
	"a duplicate slot",
	"a gap",
	"a count off by one",
	"a stale copy",
	"a member at slot −1",
	"a junk accumulator at slot 0",
	"a junk end"
]

/** The variants that change a member the family holds, so an empty family carries none of them. */
const ofMembers: ReadonlyArray<Variant> = ["a stale copy", "a junk accumulator at slot 0"]

type Case =
	| { readonly kind: "plan"; readonly change: Change }
	| { readonly kind: "lawless"; readonly size: number; readonly variant: Variant }

const cases: Arr.NonEmptyReadonlyArray<Case> = nonEmpty([
	...Arr.map(changes, (change): Case => ({ kind: "plan", change })),
	...Arr.flatMap(
		Arr.makeBy(5, (k) => k),
		(size) =>
			Arr.map(
				Arr.filter(variants, (variant) => size > 0 || !Arr.contains(ofMembers, variant)),
				(variant): Case => ({ kind: "lawless", size, variant })
			)
	)
])

type Feature = "swap with last" | "append" | "an arrival out of order" | `variant ${Variant}`
const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"swap with last",
	"append",
	"an arrival out of order",
	...Arr.map(variants, (v): Feature => `variant ${v}`)
]

/** A change's statements, NP's planner's, from the lawful state of its owner's family. */
const statementsOf = (
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
const lawlessOf = (size: number, variant: Variant): FoldStored => {
	const lawful = foldStoredOf(count, familiesOf(size))
	const ownRows = Arr.filter(lawful.rows, (r) => r.group === 1)
	const rest = Arr.filter(lawful.rows, (r) => r.group !== 1)
	const extra = {
		group: 1,
		at: size,
		copy: size,
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
		case "a stale copy":
			return {
				owners: lawful.owners,
				rows: [...rest, ...Arr.map(ownRows, (r) => ({ ...r, copy: r.copy + 1 }))]
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

describe("a counted family's natives admit grizzle's plans and refuse every lawless state", () => {
	it.effect(
		"swap-with-last and appends pass every immediate native at each statement's end",
		(ctx) => {
			const model = modelOf(schema)
			const drawn = drawnOf(model)
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/model/counted",
						generator: element(cases),
						literal: Formatter.format,
						/** The space: 10 swaps, 15 appends, and 5 family sizes × 7 variants, but the 2 an empty family cannot carry. */
						limit: cases.length,
						coverage: requiredInSpace<Feature>(features),
						caseHang,
						box: "one owner of 0 to 4 members beside one of one: every swap-with-last, every append of 1 or 2 in every order, every named lawless variant its family can carry",
						oracle: {
							kind: "second-implementation",
							name: "NP's counted planner and the family law, judged by a host model of the natives"
						}
					},
					(k, c) =>
						Effect.sync(() => {
							if (k.kind === "lawless") {
								c.note(`variant ${k.variant}`)
								const state = stateOf(drawn, lawlessOf(k.size, k.variant))
								assert.ok(
									brokenBy(model, state).length > 0,
									`the natives refuse ${k.variant} over ${k.size} members`
								)
								return
							}
							c.note(k.change.kind)
							if (k.change.kind === "append" && Arr.some(k.change.order, (o, i) => o !== i)) {
								c.note("an arrival out of order")
							}
							const { from, statements } = statementsOf(k.change)
							assert.deepEqual(
								brokenBy(model, stateOf(drawn, from)),
								[],
								"the lawful family breaks no native"
							)
							let at = from
							let deferredBroken = false
							for (const statement of statements) {
								at = foldApplied(at, statement)
								const broken = brokenBy(model, stateOf(drawn, at))
								assert.deepEqual(
									Arr.map(Arr.filter(broken, immediate), (o) => o.kind),
									[],
									`no immediate native breaks after ${statement.kind}`
								)
								deferredBroken ||= Arr.some(broken, (o) => !immediate(o))
							}
							assert.deepEqual(
								brokenBy(model, stateOf(drawn, at)),
								[],
								"every native holds at COMMIT"
							)
							if (k.change.kind === "swap with last" && k.change.at < k.change.size - 1) {
								assert.ok(
									deferredBroken,
									"swap-with-last of a slot before the last breaks a deferred axis until the last member moves in"
								)
							}
						})
				)
			)
		}
	)
})
