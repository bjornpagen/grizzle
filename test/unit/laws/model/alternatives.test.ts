/**
 * An alternatives statement lowers to plain containments' natives (fin.md §7, w4-w7 §2.5), with no residual law and no
 * head: the discriminator's roster domain types it. The oracle is fin.md §7 turned into a checker:
 *
 * - **forward**, per arm relation X serving the handles H: each X row's parent is a parent of a handle in H. One handle
 *   is a constant selection of the parent: a constant law column on X holding the handle, referencing the parent's
 *   (id, tag); several are a selected target: a law column on the parent holding its id where its tag is in H,
 *   referenced by X's id;
 * - **reverse**, per armed handle h: each parent of tag h has its arm row, a law column on the parent holding its id
 *   where its tag is h, referencing X's id: one generated column per armed handle;
 * - every one of these foreign keys is deferred, since forward and reverse form a cycle, and no other is installed.
 *
 * A law column is told by what it holds, read by the reference evaluator on a parent of every tag: the handles whose
 * parents it is defined for, or the one handle a constant holds.
 *
 * Box: every roster of 1 to 3 handles, each handle unarmed or armed by one of two arm relations, at least one armed,
 * constructed by its first armed handle: 2 + 8 + 26 = 36 assignments, exhausted.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): alternatives-forward-first-handle (an arm of several handles is
 * contained in its first handle's parents alone).
 *
 * Features: an arm of one handle, an arm of several handles, an unarmed handle, two arm relations.
 */

import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import type { LawRelation, NativeColumn } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	alternatives,
	closed,
	f,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
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
const assignmentGen: Gen<Assignment> = (source) => {
	const handles = source.draw(int(1, 3))
	const first = source.draw(int(0, handles - 1))
	const after = handles - first - 1
	return [
		...upTo(first, (): Arm => "none"),
		source.draw(element(["A", "B"] as const)),
		...source.draw(array(element(["none", "A", "B"] as const), { min: after, max: after }))
	]
}

type Feature =
	| "an arm of one handle"
	| "an arm of several handles"
	| "an unarmed handle"
	| "two arm relations"
const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"an arm of one handle",
	"an arm of several handles",
	"an unarmed handle",
	"two arm relations"
]

const handlesOf = (a: Assignment): ReadonlyArray<string> => Arr.take(handleNames, a.length)

/** Each arm relation's handles, in roster order. */
const armsOf = (
	a: Assignment
): ReadonlyArray<{ readonly arm: "A" | "B"; readonly handles: ReadonlyArray<string> }> =>
	Arr.flatMap(["A", "B"] as const, (arm) => {
		const handles = Arr.filter(handlesOf(a), (_, i) => a[i] === arm)
		return handles.length === 0 ? [] : [{ arm, handles }]
	})

const schemaOf = (a: Assignment): SchemaDesc => {
	const arms = armsOf(a)
	const roster = { name: "Tag", handles: handlesOf(a) }
	return {
		name: "Alternatives",
		relations: [
			closed("Tag", roster.handles),
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
			)
		],
		extends: undefined
	}
}

/** A column by what it holds: a field by its name; a law column by the handles of the parents it is defined for, or by
 * the one handle a constant holds. */
const holds = (model: LawModel, a: Assignment, relation: LawRelation, c: NativeColumn): string => {
	if (c.kind === "field") {
		return c.field.name
	}
	const native = defined(
		lawColumnsOf(model, relation.name).get(c.column),
		`the law column ${c.column}`
	)
	if (relation.name !== "Parent") {
		const value = generatedOn(native, new Map<string, CarrierValue>([["id", 7n]]))
		return typeof value === "string"
			? `‹= ${value}›`
			: assert.fail("a constant law column holds a handle")
	}
	const defined_ = Arr.filter(
		handlesOf(a),
		(h) =>
			generatedOn(
				native,
				new Map<string, CarrierValue>([
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
			...Arr.map(armsOf(a), (x) => {
				const [only, ...more] = x.handles
				return only !== undefined && more.length === 0
					? shapeText(x.arm, "Parent", ["id → id", `‹= ${only}› → tag`], true)
					: shapeText(x.arm, "Parent", [`id → ‹id | ${Arr.join(x.handles, ",")}›`], true)
			}),
			...Arr.flatMap(handlesOf(a), (h, i) => {
				const arm = a[i]
				return arm === undefined || arm === "none"
					? []
					: [shapeText("Parent", arm, [`‹id | ${h}› → id`], true)]
			})
		],
		Order.String
	)

const checkAssignment = (a: Assignment): void => {
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

describe("alternatives lowers to its containments' natives", () => {
	it.effect("every roster of 1 to 3 handles with every arm assignment", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/laws/model/alternatives",
					generator: assignmentGen,
					literal: Formatter.format,
					/** The space: 2, 8 and 26 armed assignments of rosters of 1, 2 and 3 handles. */
					limit: 36,
					coverage: requiredInSpace<Feature>(features),
					caseHang,
					box: "every roster of 1 to 3 handles, each unarmed or armed by one of two arm relations",
					oracle: {
						kind: "specification",
						name: "fin.md §7's forward and reverse containments as a checker"
					}
				},
				(a, c) =>
					Effect.sync(() => {
						const arms = armsOf(a)
						if (Arr.some(arms, (x) => x.handles.length === 1)) {
							c.note("an arm of one handle")
						}
						if (Arr.some(arms, (x) => x.handles.length > 1)) {
							c.note("an arm of several handles")
						}
						if (Arr.contains(a, "none")) {
							c.note("an unarmed handle")
						}
						if (arms.length > 1) {
							c.note("two arm relations")
						}
						checkAssignment(a)
					})
			)
		)
	)
})
