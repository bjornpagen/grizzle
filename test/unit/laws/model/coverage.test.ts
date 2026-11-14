/**
 * A coverage law, a containment pairing a span field of each side, lowers natively (fin.md §7, w4-w7 §2.5): each
 * selected side's terms are law columns; the target is keyed WITHOUT OVERLAPS over exactly its terms, by its declared
 * span key or by a key over its projected side; and the law is `FOREIGN KEY (f…, PERIOD s) REFERENCES B (g…, PERIOD t)`
 * with the index over its referencing columns, and always deferred: it references the target's span as a period, so
 * one ChangeSet may replace the facts covering a source's span by others that still cover it, a span cut or split,
 * which the target's WITHOUT OVERLAPS key admits only once the facts they overlap are deleted, after the reference is
 * checked if it were immediate. A target whose spans may overlap within a key, one keyed
 * WITHOUT OVERLAPS over no such terms, is refused with fin.md §7's sentence.
 *
 * Every installation holds a span key's law columns before the key names them, so a key over a selected side is its own
 * ALTER TABLE ... ADD CONSTRAINT after them (42703 otherwise).
 *
 * The oracle is fin.md §7 turned into a checker, over the natives' structure: PostgreSQL's PERIOD references are no
 * part of the host model of the natives, so their semantics are NP's (test/pg/laws/coverage.test.ts), judged by
 * PostgreSQL.
 *
 * Bound: every coverage of a source selected or not into five targets: unselected and keyed by its span key, with a
 * payload field or none; unselected and unkeyed; selected and keyed by a key over its side; selected and unkeyed. Ten
 * shapes, exhausted.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): coverage-unkeyed-target-admitted (a coverage into a target keyed
 * WITHOUT OVERLAPS over none of its terms lowers instead of being refused).
 *
 * Features: a selected source, a selected target, an unkeyed target, a replaceable target, an irreplaceable target.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import type { NativeColumn, NativeOf } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
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
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import {
	assertColumnsBeforeConstraints,
	assertWellFormed,
	columnText,
	compiledModel,
	modelOf,
	nativesOf
} from "#test/unit/laws/model/natives.ts"
import { owner } from "#test/unit/physical/fixtures.ts"

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
const shapeGen: Gen<Shape> = (source) => {
	const from = source.draw(element(sides))
	const target = source.draw(element(sides))
	const keyed = source.draw(boolean)
	const payload = target === "selected" ? false : keyed ? source.draw(boolean) : true
	return { source: from, target, keyed, payload }
}

type Feature =
	| "a selected source"
	| "a selected target"
	| "an unkeyed target"
	| "a replaceable target"
	| "an irreplaceable target"
const features: Arr.NonEmptyReadonlyArray<Feature> = [
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
		extends: undefined
	}
}

/** A column by what it is: a field by its name, a law column by the field whose values it holds. */
const text = (
	model: LawModel,
	relation: NativeOf<"PeriodForeignKey">["relation"],
	c: NativeColumn
): string => columnText(model, relation, c)

const checkShape = (s: Shape): void => {
	const result = compiledModel(schemaOf(s))
	if (!s.keyed) {
		const reason = refused(result, "UnsupportedLawFamily").reason
		assert.equal(
			reason._tag === "UnsupportedLawFamily" ? reason.capability : undefined,
			"a coverage target needs a `WITHOUT OVERLAPS` key over its span; coalesce the spans, or key them",
			"fin.md §7's refusal of a target whose spans may overlap within a key"
		)
		return
	}
	const model = modelOf(schemaOf(s))
	assertWellFormed(model)
	const owned = owning(schemaOf(s))
	assertColumnsBeforeConstraints(
		succeeded(compileInstallation(owned, installOptions(owned, owner))).statements
	)
	const natives = nativesOf(model)
	const periods = Arr.filter(
		natives,
		(o): o is NativeOf<"PeriodForeignKey"> => o.kind === "PeriodForeignKey"
	)
	const [period, ...more] = periods
	assert.ok(period !== undefined && more.length === 0, "one PERIOD foreign key")
	const sourceScalar = s.source === "selected" ? "‹generated f›" : "f"
	const sourceSpan = s.source === "selected" ? "‹generated s›" : "s"
	const targetScalar = s.target === "selected" ? "‹generated g›" : "g"
	const targetSpan = s.target === "selected" ? "‹generated t›" : "t"
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

describe("a coverage law lowers to a PERIOD reference into a WITHOUT OVERLAPS key", () => {
	it.effect(
		"every coverage of a selected or unselected source into a selected or unselected, keyed or unkeyed target",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/model/coverage",
						generator: shapeGen,
						literal: Formatter.format,
						coverage: requiredInSpace<Feature>(features),
						caseHang,
						box: "a source selected or not into a target selected or not, keyed or not, with a payload field or none",
						oracle: {
							kind: "specification",
							name: "fin.md §7's coverage lowering and its refusal as a checker"
						},
						concurrency: 1
					},
					(s, c) =>
						Effect.sync(() => {
							if (s.source === "selected") {
								c.note("a selected source")
							}
							if (s.target === "selected") {
								c.note("a selected target")
							}
							if (!s.keyed) {
								c.note("an unkeyed target")
							} else {
								c.note(
									s.target === "selected" || s.payload
										? "a replaceable target"
										: "an irreplaceable target"
								)
							}
							checkShape(s)
						})
				)
			)
	)
})
