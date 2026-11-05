import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { NativeOf } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	type AuthoredStatementDesc,
	contained,
	f,
	fin,
	on,
	ordered,
	pred,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	breaks,
	drawnColumn,
	modelOf,
	onRelation,
	ridingLaws,
	type Row,
	type State
} from "#test/unit/laws/model/natives.ts"

/**
 * Merging is exact (w4-w7 §2.1, fin.md §15 rule 3): a family axis's one foreign key, carrying every containment that
 * rides it, holds in a state exactly when every one of those containments holds there. The oracle is metamorphic: the
 * merged lowering's verdict against each containment's own meaning as a partial projection, a source side's every
 * defined tuple among the target side's tuples, computed directly from the state. It is exact because the axis's key
 * terms are a key of its target side, so a source row meets at most one target row; the host model of the foreign key's
 * PostgreSQL semantics (natives.ts `breaks`, MATCH SIMPLE) is the judge.
 *
 * Bound: an owner's family of two members at slots 0 and 1, with two copies riding the predecessor axis (a₀ → b₀ and
 * a₁ → b₁ between neighbours) or the last axis (e₀ → l₀ and e₁ → l₁ from the owner to its last member), every carried
 * column over the three values 0, 1 and 2: 3⁸ and 3⁶ states, exhausted. Every state holds the family itself, so the
 * axis's key part holds and each verdict turns on the copies.
 */

type Axis = "predecessor" | "last"
const axes: readonly [Axis, Axis] = ["predecessor", "last"]

type Feature = "the axis holds" | "both copies break" | "one copy breaks" | `axis ${Axis}`
const features: readonly [Feature, ...Array<Feature>] = [
	"the axis holds",
	"both copies break",
	"one copy breaks",
	"axis predecessor",
	"axis last"
]

const schemaOf = (axis: Axis): SchemaDesc => {
	const copies: ReadonlyArray<AuthoredStatementDesc> =
		axis === "predecessor"
			? Arr.map([0, 1], (j) =>
					contained(
						on("Member", ["owner", pred("at"), `a${j}`]),
						on("Member", ["owner", "at", `b${j}`])
					)
				)
			: Arr.map([0, 1], (j) =>
					contained(on("Owner", ["id", pred("n"), `e${j}`]), on("Member", ["owner", "at", `l${j}`]))
				)
	return {
		name: "Merging",
		relations: [
			relation("Owner", { id: f.bigint, n: f.drawn, e0: f.bigint, e1: f.bigint }, ["id"]),
			relation(
				"Member",
				{
					id: f.bigint,
					owner: f.bigint,
					at: f.drawn,
					a0: f.bigint,
					a1: f.bigint,
					b0: f.bigint,
					b1: f.bigint,
					l0: f.bigint,
					l1: f.bigint
				},
				["id"]
			)
		],
		statements: [ordered(on("Member", ["owner", "at"]), fin("Owner", "n")), ...copies],
		extends: undefined
	}
}

const values = [0n, 1n, 2n] as const

/** Every assignment of `n` columns to the three values. */
const assignments = (n: number): ReadonlyArray<ReadonlyArray<bigint>> =>
	n === 0 ? [[]] : Arr.flatMap(assignments(n - 1), (t) => Arr.map(values, (v) => [...t, v]))

/** A member's carried columns, by name. */
interface Member {
	readonly at: bigint
	readonly a: readonly [bigint, bigint]
	readonly b: readonly [bigint, bigint]
	readonly l: readonly [bigint, bigint]
}

/** Copy j's meaning, from the state: every defined source tuple is among the target's. */
const copyHolds = (
	axis: Axis,
	j: 0 | 1,
	e: readonly [bigint, bigint],
	members: ReadonlyArray<Member>
): boolean =>
	axis === "predecessor"
		? Arr.every(
				members,
				(m) => m.at === 0n || Arr.some(members, (t) => t.at === m.at - 1n && t.b[j] === m.a[j])
			)
		: Arr.some(members, (t) => t.at === BigInt(members.length) - 1n && t.l[j] === e[j])

const stateOf = (
	model: LawModel,
	e: readonly [bigint, bigint],
	members: ReadonlyArray<Member>
): State => {
	const copy = drawnColumn(model, "Member", "copy")
	return new Map<string, ReadonlyArray<Row>>([
		[
			"Owner",
			[
				new Map<string, CarrierValue>([
					["id", 1n],
					["n", BigInt(members.length)],
					["e0", e[0]],
					["e1", e[1]]
				])
			]
		],
		[
			"Member",
			Arr.map(
				members,
				(m, k) =>
					new Map<string, CarrierValue>([
						["id", BigInt(10 + k)],
						["owner", 1n],
						["at", m.at],
						[copy, BigInt(members.length)],
						["a0", m.a[0]],
						["a1", m.a[1]],
						["b0", m.b[0]],
						["b1", m.b[1]],
						["l0", m.l[0]],
						["l1", m.l[1]]
					])
			)
		]
	])
}

/** The axis's foreign key: the one each riding copy's lowering names. */
const axisKey = (model: LawModel, axis: Axis): NativeOf<"ForeignKey"> => {
	const fks = [
		...onRelation(model, "ForeignKey", "Member"),
		...onRelation(model, "ForeignKey", "Owner")
	]
	const [fk, ...more] = Arr.filter(fks, (k) =>
		axis === "last"
			? k.relation.name === "Owner"
			: k.relation.name === "Member" && k.target.name === "Member"
	)
	assert.ok(fk !== undefined && more.length === 0, `one ${axis} axis foreign key`)
	const riding = ridingLaws(model, axis)
	assert.equal(riding.length, 2, `both copies ride the ${axis} axis`)
	assert.ok(
		Arr.every(riding, (r) => Arr.contains(fk.lawIds, r)),
		"the axis states both copies' laws"
	)
	return fk
}

describe("a merged family axis holds exactly when every containment merged into it holds", () => {
	it.effect(
		"every state of a two-member family with two copies on one axis over three values",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/model/merge",
						generator: element(axes),
						literal: Formatter.format,
						/** The space: the two axes a user's copy can ride by its own terms; each enumerates its states. */
						limit: 2,
						coverage: requiredInSpace<Feature>(features),
						caseHang,
						box: "a two-member family with two copies on the predecessor or last axis, every carried column over 0 to 2",
						oracle: {
							kind: "universal",
							name: "metamorphic: the merged axis against each containment's own meaning"
						}
					},
					(axis, c) =>
						Effect.sync(() => {
							c.note(`axis ${axis}`)
							const model = modelOf(schemaOf(axis))
							const fk = axisKey(model, axis)
							const columns = axis === "predecessor" ? 8 : 6
							for (const v of assignments(columns)) {
								const at = (k: number): bigint => defined(v[k])
								const e: readonly [bigint, bigint] = axis === "last" ? [at(0), at(1)] : [0n, 0n]
								const offset = axis === "last" ? 2 : 0
								const members: ReadonlyArray<Member> = Arr.map([0, 1], (k) =>
									axis === "predecessor"
										? {
												at: BigInt(k),
												a: [at(4 * k), at(4 * k + 1)],
												b: [at(4 * k + 2), at(4 * k + 3)],
												l: [0n, 0n]
											}
										: {
												at: BigInt(k),
												a: [0n, 0n],
												b: [0n, 0n],
												l: [at(offset + 2 * k), at(offset + 2 * k + 1)]
											}
								)
								const each = [copyHolds(axis, 0, e, members), copyHolds(axis, 1, e, members)]
								const merged = !breaks(model, fk, stateOf(model, e, members))
								c.note(
									Arr.every(each, (h) => h)
										? "the axis holds"
										: Arr.every(each, (h) => !h)
											? "both copies break"
											: "one copy breaks"
								)
								assert.equal(
									merged,
									Arr.every(each, (h) => h),
									`${axis}: ${Arr.join(Arr.map(v, String), " ")}`
								)
							}
						})
				)
			)
	)
})
