/** What the properties of coverage.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import type { NativeColumn, NativeOf } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	type AuthoredStatementDesc,
	contained,
	f,
	field,
	key,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { assertReferencesServed } from "#test/support/laws/referencing.ts"
import { owning } from "#test/support/policy.ts"
import {
	assertColumnsBeforeConstraints,
	assertWellFormed,
	columnText,
	compiledModel,
	modelOf,
	nativesOf
} from "#test/support/unit/laws/model/natives.ts"

interface Shape {
	readonly source: "every" | "selected"
	readonly target: "every" | "selected"
	readonly keyed: boolean
	/** An unselected target with a field the reference does not read, which can be replaced at its key. */
	readonly payload: boolean
}

const sides = ["every", "selected"] as const

/**
 * The box: a source selected or not, into a target selected or not, keyed or not. An unselected keyed target has a
 * payload field or none, and an unselected unkeyed one always has one, since a target of its span key alone is keyed by
 * it; a selected target holds the field its selection reads, which is its payload.
 */
export const shapeGen: Gen<Shape> = (source) => {
	const from = source.draw(element(sides))
	const target = source.draw(element(sides))
	const keyed = source.draw(boolean)
	const payload = target === "selected" ? false : keyed ? source.draw(boolean) : true
	return { source: from, target, keyed, payload }
}

export type Feature =
	| "a selected source"
	| "a selected target"
	| "an unkeyed target"
	| "a replaceable target"
	| "an irreplaceable target"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"a selected source",
	"a selected target",
	"an unkeyed target",
	"a replaceable target",
	"an irreplaceable target"
]

const trueOf = (name: string) => ({
	kind: "compare" as const,
	op: "eq" as const,
	left: field(name),
	right: { kind: "literal" as const, value: true }
})

const span = f.span(f.integer, undefined)

const schemaOf = (s: Shape): SchemaDesc => {
	const targetSide =
		s.target === "selected" ? onWhere("B", ["g", "t"], trueOf("live")) : on("B", ["g", "t"])
	const sourceSide =
		s.source === "selected" ? onWhere("A", ["f", "s"], trueOf("on")) : on("A", ["f", "s"])
	const keyStatements: ReadonlyArray<AuthoredStatementDesc> =
		s.keyed && s.target === "selected" ? [key(onWhere("B", ["g", "t"], trueOf("live")))] : []
	const bFields =
		s.target === "selected" || s.payload
			? { id: f.bigint, g: f.bigint, t: span, live: f.boolean }
			: { g: f.bigint, t: span }
	const bKey =
		s.keyed && s.target === "every"
			? ["g", "t"]
			: s.target === "every" && !s.payload
				? ["g", "t"]
				: ["id"]
	return {
		name: "Coverage",
		relations: [
			relation("A", { id: f.bigint, f: f.bigint, s: span, on: f.boolean }, ["id"]),
			relation("B", bFields, bKey)
		],
		statements: [...keyStatements, contained(sourceSide, targetSide)],
		bases: []
	}
}

/** A column by what it is: a field by its name, a law column by the field whose values it holds. */
const text = (
	model: LawModel,
	relation: NativeOf<"PeriodForeignKey">["relation"],
	c: NativeColumn
): string => columnText(model, relation, c)

export const checkShape = (s: Shape): void => {
	const result = compiledModel(schemaOf(s))
	if (!s.keyed) {
		const reason = refused(result, "UnsupportedLawFamily").reason
		assert.equal(
			reason._tag === "UnsupportedLawFamily" ? reason.capability : undefined,
			"a coverage target needs a `WITHOUT OVERLAPS` key over its range; coalesce the ranges, or key them",
			"fin.md §7's refusal of a target whose spans may overlap within a key"
		)
		return
	}
	const model = modelOf(schemaOf(s))
	assertWellFormed(model)
	const owned = owning(schemaOf(s))
	const statements = succeeded(compileInstallation(owned, installOptions(owned))).statements
	assertColumnsBeforeConstraints(statements)
	assertReferencesServed(statements)
	const natives = nativesOf(model)
	const periods = Arr.filter(
		natives,
		(o): o is NativeOf<"PeriodForeignKey"> => o.kind === "PeriodForeignKey"
	)
	const [period, ...more] = periods
	assert.ok(period !== undefined && more.length === 0, "one PERIOD foreign key")
	const sourceScalar = s.source === "selected" ? "‹generated f›" : "f"
	const sourceSpan = "s"
	const targetScalar = s.target === "selected" ? "‹generated g›" : "g"
	const targetSpan = "t"
	assert.deepEqual(
		{
			columns: Arr.map(period.columns, (c) => text(model, period.relation, c)),
			span: text(model, period.relation, period.span),
			targetColumns: Arr.map(period.targetColumns, (c) => text(model, period.target, c)),
			targetSpan: text(model, period.target, period.targetSpan),
			deferrable: period.deferrable
		},
		{
			columns: [sourceScalar],
			span: sourceSpan,
			targetColumns: [targetScalar],
			targetSpan,
			deferrable: true
		}
	)
	const keys = Arr.filter(
		natives,
		(o): o is NativeOf<"WithoutOverlaps"> => o.kind === "WithoutOverlaps" && o.relation.name === "B"
	)
	assert.ok(
		Arr.some(
			keys,
			(k) =>
				text(model, k.relation, k.span) === targetSpan &&
				Arr.join(
					Arr.sort(
						Arr.map(k.key.scalars, (c) => text(model, k.relation, c)),
						Order.String
					),
					","
				) === targetScalar
		),
		"the target is keyed WITHOUT OVERLAPS over exactly the referenced columns"
	)
	assert.ok(
		Arr.some(
			natives,
			(o) =>
				o.kind === "ReverseIndex" &&
				o.relation.name === "A" &&
				Arr.join(
					Arr.sort(
						Arr.map(o.columns, (c) => text(model, o.relation, c)),
						Order.String
					),
					","
				) === Arr.join(Arr.sort([sourceScalar, sourceSpan], Order.String), ",")
		),
		"the referencing columns are indexed"
	)
	assert.ok(!Arr.some(natives, (o) => o.kind === "ForeignKey"), "a coverage is no plain reference")
}
