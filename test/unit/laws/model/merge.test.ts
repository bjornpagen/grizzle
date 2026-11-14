/**
 * Merging is exact (w4-w7 §2.1, fin.md §15 rule 3): a family axis's one foreign key, carrying every containment that
 * rides it, holds in a state exactly when every one of those containments holds there. The oracle is metamorphic: the
 * merged lowering's verdict against each containment's own meaning as a partial projection, a source side's every
 * defined tuple among the target side's tuples, computed directly from the state. It is exact because the axis's key
 * terms are a key of its target side, so a source row meets at most one target row; the host model of the foreign key's
 * PostgreSQL semantics (natives.ts `breaks`, MATCH SIMPLE) is the judge.
 *
 * Bound: an owner's family of two members at slots 0 and 1, with two copies riding one axis: the owner axis (o₀ → f₀
 * and o₁ → f₁ from each member to its owner), the predecessor axis (a₀ → b₀ and a₁ → b₁ between neighbours) or the last
 * axis (e₀ → l₀ and e₁ → l₁ from the owner to its last member), every carried column over the three values 0, 1 and 2:
 * 3⁶, 3⁸ and 3⁶ states, exhausted. Every state holds the family itself, so the axis's key part holds and each verdict
 * turns on the copies.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): axis-carries-first-copy-only (an axis's foreign key carries only the
 * first copy riding it).
 *
 * Features: each axis, and each copy's verdict.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, map } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { AxisKind } from "#compiler/ir/family.ts"
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

/** The fields an axis's two copies carry on the owner and on each member, in the order the box draws their values: copy
 * j's source and target among them. */
const fieldsOf: {
	readonly [A in AxisKind]: {
		readonly owner: ReadonlyArray<string>
		readonly member: ReadonlyArray<string>
	}
} = {
	owner: { owner: ["f0", "f1"], member: ["o0", "o1"] },
	predecessor: { owner: [], member: ["a0", "a1", "b0", "b1"] },
	last: { owner: ["e0", "e1"], member: ["l0", "l1"] }
}

/** One state of the box: the axis its copies ride, the owner's carried values and each member's, in slot order. */
interface Merge {
	readonly axis: AxisKind
	readonly owner: ReadonlyMap<string, bigint>
	readonly members: ReadonlyArray<ReadonlyMap<string, bigint>>
}

/** Values of `fields`, each over 0 to 2. */
const carriedGen = (fields: ReadonlyArray<string>): Gen<ReadonlyMap<string, bigint>> =>
	map(
		array(map(int(0, 2), BigInt), { min: fields.length, max: fields.length }),
		(values) => new Map(Arr.zip(fields, values))
	)

/** The box: an axis, then every carried column of the owner and its two members over 0 to 2. */
const mergeGen: Gen<Merge> = (source) => {
	const axis = source.draw(element(["owner", "predecessor", "last"] as const))
	const { owner, member } = fieldsOf[axis]
	return {
		axis,
		owner: source.draw(carriedGen(owner)),
		members: [source.draw(carriedGen(member)), source.draw(carriedGen(member))]
	}
}

type Verdict = "the axis holds" | "both copies break" | "one copy breaks"
type Feature = Verdict | `axis ${AxisKind}`

const verdicts: Arr.NonEmptyReadonlyArray<Verdict> = [
	"the axis holds",
	"both copies break",
	"one copy breaks"
]

const schemaOf = (axis: AxisKind): SchemaDesc => {
	const copies: ReadonlyArray<AuthoredStatementDesc> = Arr.map([0, 1], (j) => {
		switch (axis) {
			case "owner":
				return contained(on("Member", ["owner", `o${j}`]), on("Owner", ["id", `f${j}`]))
			case "predecessor":
				return contained(
					on("Member", ["owner", pred("at"), `a${j}`]),
					on("Member", ["owner", "at", `b${j}`])
				)
			case "last":
				return contained(
					on("Owner", ["id", pred("n"), `e${j}`]),
					on("Member", ["owner", "at", `l${j}`])
				)
		}
	})
	return {
		name: "Merging",
		relations: [
			relation(
				"Owner",
				{ id: f.bigint, n: f.drawn, e0: f.bigint, e1: f.bigint, f0: f.bigint, f1: f.bigint },
				["id"]
			),
			relation(
				"Member",
				{
					id: f.bigint,
					owner: f.bigint,
					at: f.drawn,
					o0: f.bigint,
					o1: f.bigint,
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

/** A carried field's value on a row of the box. */
const valueAt = (row: ReadonlyMap<string, bigint> | undefined, name: string): bigint =>
	defined(row?.get(name), `the carried ${name}`)

/** Copy j's meaning, from the state: every defined source tuple is among the target's. */
const copyHolds = (m: Merge, j: 0 | 1): boolean => {
	const member = (k: number, name: string) => valueAt(m.members[k], name)
	switch (m.axis) {
		case "owner":
			return Arr.every(m.members, (_, k) => member(k, `o${j}`) === valueAt(m.owner, `f${j}`))
		case "predecessor":
			return Arr.every(
				m.members,
				(_, k) => k === 0 || member(k - 1, `b${j}`) === member(k, `a${j}`)
			)
		case "last":
			return member(m.members.length - 1, `l${j}`) === valueAt(m.owner, `e${j}`)
	}
}

/** The state of the box: the owner and its members in slot order, every family column at the family's own values and
 * the carried columns the axis's foreign key reads at the box's. */
const stateOf = (model: LawModel, m: Merge): State => {
	const copy = drawnColumn(model, "Member", "copy")
	const n = BigInt(m.members.length)
	return new Map<string, ReadonlyArray<Row>>([
		["Owner", [new Map<string, CarrierValue>([["id", 1n], ["n", n], ...m.owner])]],
		[
			"Member",
			Arr.map(
				m.members,
				(values, k) =>
					new Map<string, CarrierValue>([
						["id", BigInt(10 + k)],
						["owner", 1n],
						["at", BigInt(k)],
						[copy, n],
						...values
					])
			)
		]
	])
}

/** The axis's foreign key: the one each riding copy's lowering names. */
const axisKey = (model: LawModel, axis: AxisKind): NativeOf<"ForeignKey"> => {
	const fks = [
		...onRelation(model, "ForeignKey", "Member"),
		...onRelation(model, "ForeignKey", "Owner")
	]
	const [fk, ...more] = Arr.filter(fks, (k) => {
		switch (axis) {
			case "owner":
				return k.relation.name === "Member" && k.target.name === "Owner"
			case "predecessor":
				return k.relation.name === "Member" && k.target.name === "Member"
			case "last":
				return k.relation.name === "Owner"
		}
	})
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
	/** Each axis's schema, compiled once for every state of the box. */
	const models: { readonly [A in AxisKind]: LawModel } = {
		owner: modelOf(schemaOf("owner")),
		predecessor: modelOf(schemaOf("predecessor")),
		last: modelOf(schemaOf("last"))
	}

	it.effect(
		"every state of a two-member family with two copies on one axis over three values",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/model/merge",
						generator: mergeGen,
						literal: Formatter.format,
						coverage: requiredInSpace<Feature>(
							Arr.flatMap(["owner", "predecessor", "last"] as const, (axis) =>
								Arr.map(verdicts, (v) => [`axis ${axis}`, v] as const)
							)
						),
						caseHang,
						box: "a two-member family with two copies on the owner, predecessor or last axis, every carried column over 0 to 2",
						oracle: {
							kind: "universal",
							name: "metamorphic: the merged axis against each containment's own meaning"
						},
						concurrency: 1
					},
					(m, c) =>
						Effect.sync(() => {
							const model = models[m.axis]
							const each = [copyHolds(m, 0), copyHolds(m, 1)]
							const verdict: Verdict = Arr.every(each, (h) => h)
								? "the axis holds"
								: Arr.every(each, (h) => !h)
									? "both copies break"
									: "one copy breaks"
							c.pair(`axis ${m.axis}`, verdict)
							assert.equal(
								!breaks(model, axisKey(model, m.axis), stateOf(model, m)),
								Arr.every(each, (h) => h),
								`${m.axis}: the merged axis holds exactly when both copies do`
							)
						})
				)
			)
	)
})
