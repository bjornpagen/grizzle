/** What the properties of alternatives.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import {
	alternatives,
	type AuthoredStatementDesc,
	closed,
	contained,
	f,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { openedDescs } from "#test/support/open.ts"
import { upTo } from "#test/support/up-to.ts"
import { assertWellFormed, modelOf, nativesOf } from "#test/unit/laws/model/natives.ts"

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

/** The assignment's relations: Parent, tagged by the roster, and each arm relation, each keyed by its id. */
const storedOf = (a: Assignment) => [
	relation("Parent", { id: f.bigint, tag: f.closedId("Tag") }, ["id"]),
	...Arr.map(armsOf(a), (x) => relation(x.arm, { id: f.bigint }, ["id"]))
]

/** The assignment's schema over its relations, open, and `statements`, its laws over them. */
const schemaOver = (
	a: Assignment,
	statements: ReadonlyArray<AuthoredStatementDesc>
): SchemaDesc => {
	const stored = storedOf(a)
	return {
		name: "Alternatives",
		relations: [closed.ordered("Tag", handlesOf(a)), ...stored],
		statements: [...statements, ...openedDescs(stored)],
		bases: []
	}
}

/** The assignment's alternatives statement: each armed handle's arm relation, by its id. */
const stated = (a: Assignment): AuthoredStatementDesc =>
	alternatives(
		{ name: "Parent", primaryKey: ["id"] },
		"tag",
		{ name: "Tag", handles: handlesOf(a) },
		Rec.fromEntries(
			Arr.flatMap(handlesOf(a), (h, i) => {
				const arm = a[i]
				return arm === undefined || arm === "none"
					? []
					: [[h, { name: arm, primaryKey: ["id"] }] as const]
			})
		)
	)

/** The parents tagged by one of `handles`: `tag = h` for one, `tag IN (…)` for several. */
const taggedBy = (handles: Arr.NonEmptyReadonlyArray<string>): ExprDesc => {
	const tag: ExprDesc = { kind: "field", field: "tag" }
	const [only, ...rest] = handles
	return rest.length === 0
		? { kind: "compare", op: "eq", left: tag, right: { kind: "literal", value: only } }
		: { kind: "in", arg: tag, values: handles }
}

/**
 * The assignment's containments stated apart, fin.md §7's: per arm relation X, X's ids among the parents tagged by the
 * handles it is the arm of (forward); per armed handle h, the parents tagged h among its arm's ids (reverse).
 */
const apart = (a: Assignment): ReadonlyArray<AuthoredStatementDesc> => [
	...Arr.flatMap(armsOf(a), (x) =>
		Arr.isReadonlyArrayNonEmpty(x.handles)
			? [contained(on(x.arm, ["id"]), onWhere("Parent", ["id"], taggedBy(x.handles)))]
			: []
	),
	...Arr.flatMap(handlesOf(a), (h, i) => {
		const arm = a[i]
		return arm === undefined || arm === "none"
			? []
			: [contained(onWhere("Parent", ["id"], taggedBy([h])), on(arm, ["id"]))]
	})
]

/** The ids of a law model's containments, sorted. */
const containmentIds = (model: LawModel): ReadonlyArray<LawId> =>
	Arr.sort(
		Arr.flatMap(model.theory.laws, (law) => (law.detail.kind === "containment" ? [law.id] : [])),
		Order.String
	)

/**
 * One assignment: its alternatives statement states exactly the laws of its containments stated apart, each law one
 * identity (ir/dag.ts), and each is judged whole over the unit of the id every relation is keyed by, open there (laws/
 * model/plan.ts containmentDischarge): the law model installs no foreign key and no law column for any of them.
 */
export const checkAssignment = (a: Assignment): void => {
	const model = modelOf(schemaOver(a, [stated(a)]))
	assertWellFormed(model)
	const ids = containmentIds(model)
	assert.deepEqual(
		ids,
		containmentIds(modelOf(schemaOver(a, apart(a)))),
		"the alternatives statement states the laws of its containments stated apart"
	)
	for (const id of ids) {
		assert.ok(
			Arr.some(model.rules, (r) => r.law.id === id && r.rule.kind === "whole"),
			`the containment ${id} is judged whole`
		)
	}
	assert.deepEqual(
		Arr.flatMap(nativesOf(model), (o) =>
			o.kind === "ForeignKey" || o.kind === "LawColumn" ? [o.kind] : []
		),
		[],
		"alternatives installs no foreign key and no law column"
	)
}
