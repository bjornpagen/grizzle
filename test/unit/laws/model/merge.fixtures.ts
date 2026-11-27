/** What the properties of merge.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, map } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { AxisKind } from "#compiler/ir/family.ts"
import type { NativeOf } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
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
import type { ModelValue } from "#test/support/oracle/evaluate/catalog.ts"
import {
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
export const mergeGen: Gen<Merge> = (source) => {
	const axis = source.draw(element(["owner", "predecessor", "last"] as const))
	const { owner, member } = fieldsOf[axis]
	return {
		axis,
		owner: source.draw(carriedGen(owner)),
		members: [source.draw(carriedGen(member)), source.draw(carriedGen(member))]
	}
}

export type Verdict = "the axis holds" | "both copies break" | "one copy breaks"

export type Feature = Verdict | `axis ${AxisKind}`

export const verdicts: Arr.NonEmptyReadonlyArray<Verdict> = [
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
		bases: []
	}
}

/** A carried field's value on a row of the box. */
const valueAt = (row: ReadonlyMap<string, bigint> | undefined, name: string): bigint =>
	defined(row?.get(name), `the carried ${name}`)

/** Copy j's meaning, from the state: every defined source tuple is among the target's. */
export const copyHolds = (m: Merge, j: 0 | 1): boolean => {
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
export const stateOf = (model: LawModel, m: Merge): State => {
	const next = drawnColumn(model, "Member", "next")
	const n = BigInt(m.members.length)
	return new Map<string, ReadonlyArray<Row>>([
		["Owner", [new Map<string, ModelValue>([["id", 1n], ["n", n], ...m.owner])]],
		[
			"Member",
			Arr.map(
				m.members,
				(values, k) =>
					new Map<string, ModelValue>([
						["id", BigInt(10 + k)],
						["owner", 1n],
						["at", BigInt(k)],
						[next, BigInt(k + 1 < m.members.length ? k + 1 : k)],
						...values
					])
			)
		]
	])
}

/** The axis's foreign key: the one each riding copy's lowering names. */
export const axisKey = (model: LawModel, axis: AxisKind): NativeOf<"ForeignKey"> => {
	const fks = [
		...onRelation(model, "ForeignKey", "Member"),
		...onRelation(model, "ForeignKey", "Owner")
	]
	const [fk, ...more] = Arr.filter(fks, (k) => {
		switch (axis) {
			case "owner":
				return k.relation.name === "Member" && k.target.name === "Owner" && k.onUpdate === "cascade"
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

/** Each axis's schema, compiled once for every state of the box. */
export const models: { readonly [A in AxisKind]: LawModel } = {
	owner: modelOf(schemaOf("owner")),
	predecessor: modelOf(schemaOf("predecessor")),
	last: modelOf(schemaOf("last"))
}
