/** What the properties of alternatives.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import type { LawRelation, NativeColumn } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	alternatives,
	closed,
	f,
	mutable,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import type { ModelValue } from "#test/support/oracle/evaluate/catalog.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	assertWellFormed,
	generatedOn,
	lawColumnsOf,
	modelOf,
	nativesOf
} from "#test/unit/laws/model/natives.ts"

type Arm = "none" | "A" | "B"

type Assignment = ReadonlyArray<Arm>

const handleNames = ["h0", "h1", "h2"] as const

/**
 * The box: a roster of 1 to 3 handles, each unarmed or armed by A or B, at least one of them armed, built by its first
 * armed handle: the handles before it unarmed, it armed by A or B, and every one after it any of the three.
 */
export const assignmentGen: Gen<Assignment> = (source) => {
	const handles = source.draw(int(1, 3))
	const first = source.draw(int(0, handles - 1))
	const after = handles - first - 1
	return [
		...upTo(first, (): Arm => "none"),
		source.draw(element(["A", "B"] as const)),
		...source.draw(array(element(["none", "A", "B"] as const), { min: after, max: after }))
	]
}

export type Feature =
	| "an arm of one handle"
	| "an arm of several handles"
	| "an unarmed handle"
	| "two arm relations"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"an arm of one handle",
	"an arm of several handles",
	"an unarmed handle",
	"two arm relations"
]

const handlesOf = (a: Assignment): ReadonlyArray<string> => Arr.take(handleNames, a.length)

/** Each arm relation's handles, in roster order. */
export const armsOf = (
	a: Assignment
): ReadonlyArray<{ readonly arm: "A" | "B"; readonly handles: ReadonlyArray<string> }> =>
	Arr.flatMap(["A", "B"] as const, (arm) => {
		const handles = Arr.filter(handlesOf(a), (_, i) => a[i] === arm)
		return handles.length === 0 ? [] : [{ arm, handles }]
	})

/** The assignment's schema, its relations mutable, so its alternatives' containments are the natives this box reads, never
 * judged whole (laws/model/plan.ts ContainmentDischarge). */
const schemaOf = (a: Assignment): SchemaDesc => {
	const arms = armsOf(a)
	const roster = { name: "Tag", handles: handlesOf(a) }
	return {
		name: "Alternatives",
		relations: [
			closed.ordered("Tag", roster.handles),
			relation("Parent", { id: f.bigint, tag: f.closedId("Tag") }, ["id"]),
			...Arr.map(arms, (x) => relation(x.arm, { id: f.bigint }, ["id"]))
		],
		statements: [
			alternatives(
				{ name: "Parent", primaryKey: ["id"] },
				"tag",
				roster,
				Rec.fromEntries(
					Arr.flatMap(handlesOf(a), (h, i) => {
						const arm = a[i]
						return arm === undefined || arm === "none"
							? []
							: [[h, { name: arm, primaryKey: ["id"] }] as const]
					})
				)
			),
			mutable("Parent"),
			...Arr.map(arms, (x) => mutable(x.arm))
		],
		extends: undefined
	}
}

/** A column by what it holds: a field by its name; a law column, which only the parent holds, by the handles of the
 * parents it is defined for. */
const holds = (model: LawModel, a: Assignment, relation: LawRelation, c: NativeColumn): string => {
	if (c.kind === "field") {
		return c.field.name
	}
	assert.equal(relation.name, "Parent", `the law column ${c.column} is the parent's, no arm's`)
	const native = defined(
		lawColumnsOf(model, relation.name).get(c.column),
		`the law column ${c.column}`
	)
	const defined_ = Arr.filter(
		handlesOf(a),
		(h) =>
			generatedOn(
				native,
				new Map<string, ModelValue>([
					["id", 7n],
					["tag", h]
				])
			) !== undefined
	)
	return `‹id | ${Arr.join(defined_, ",")}›`
}

/** A foreign key by what it pairs, its relations and its deferral. */
const shapeText = (
	from: string,
	to: string,
	pairs: ReadonlyArray<string>,
	deferrable: boolean
): string =>
	`${from}(${Arr.join(Arr.sort(pairs, Order.String), "; ")}) → ${to}${deferrable ? " deferred" : ""}`

const expected = (a: Assignment): ReadonlyArray<string> =>
	Arr.sort(
		[
			...Arr.flatMap(armsOf(a), (x) => [
				shapeText(x.arm, "Parent", [`id → ‹id | ${Arr.join(x.handles, ",")}›`], true),
				shapeText(x.arm, "Parent", ["id → id"], true)
			]),
			...Arr.flatMap(handlesOf(a), (h, i) => {
				const arm = a[i]
				return arm === undefined || arm === "none"
					? []
					: [shapeText("Parent", arm, [`‹id | ${h}› → id`], true)]
			})
		],
		Order.String
	)

export const checkAssignment = (a: Assignment): void => {
	const model = modelOf(schemaOf(a))
	assertWellFormed(model)
	const actual = Arr.sort(
		Arr.flatMap(nativesOf(model), (o) =>
			o.kind === "ForeignKey"
				? [
						shapeText(
							o.relation.name,
							o.target.name,
							Arr.map(
								Arr.zip(o.columns, o.targetColumns),
								([x, y]) => `${holds(model, a, o.relation, x)} → ${holds(model, a, o.target, y)}`
							),
							o.deferrable
						)
					]
				: []
		),
		Order.String
	)
	assert.deepEqual(actual, [...expected(a)])
	const reverseColumns = Arr.filter([...lawColumnsOf(model, "Parent").values()], (c) => {
		const text = holds(model, a, defined(model.theory.relations["Parent"]), {
			kind: "law",
			column: c.column
		})
		return Arr.some(handlesOf(a), (h) => text === `‹id | ${h}›`)
	})
	assert.equal(
		reverseColumns.length,
		Arr.filter(a, (x) => x !== "none").length,
		"one generated column per armed handle on the parent"
	)
	assert.ok(
		Arr.every(nativesOf(model), (o) => o.kind !== "PeriodForeignKey" && o.kind !== "ClosedCheck"),
		"alternatives installs plain foreign keys"
	)
}
