import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Equivalence, Formatter } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * One declaration of a relation parameter across a ChangeSet's members (write/frontend/compile.ts merge): two members
 * that read the parameter `rows` read one relation of one heading, so the ChangeSet compiles exactly when they declare
 * it under the same fields of the same types, in any order, and is refused MalformedDescription otherwise, a heading
 * within the other's among them, whichever member comes first.
 *
 * The box: R and S, each (b, c, d) keyed by (b, c), inserted in one stratum from `rows`, each member declaring it under
 * one of four headings: b, c and d; b and c; c, b and d, the first in another order; b, c and d with d a bigint.
 */
type Declared = "b, c, d" | "b, c" | "c, b, d" | "b, c, d as a bigint"

const headingOf = {
	"b, c, d": { b: pg.integer, c: pg.integer, d: pg.integer },
	"b, c": { b: pg.integer, c: pg.integer },
	"c, b, d": { c: pg.integer, b: pg.integer, d: pg.integer },
	"b, c, d as a bigint": { b: pg.integer, c: pg.integer, d: pg.bigint }
} as const

/** The fields a heading declares, each with its type, in name order: the model's reading of a declaration. */
const fieldsOf: Readonly<Record<Declared, ReadonlyArray<string>>> = {
	"b, c, d": ["b int4", "c int4", "d int4"],
	"b, c": ["b int4", "c int4"],
	"c, b, d": ["b int4", "c int4", "d int4"],
	"b, c, d as a bigint": ["b int4", "c int4", "d int8"]
}

/** Whether two declarations state the same fields of the same types. */
const sameFields = Arr.makeEquivalence(Equivalence.strictEqual<string>())

const R = relation("R", { b: pg.integer, c: pg.integer, d: pg.integer }, ["b", "c"])
const S = relation("S", { b: pg.integer, c: pg.integer, d: pg.integer }, ["b", "c"])
const Pair = schema("Pair", { R, S }, [])

/** The facts of `rows`, declared under `declared`, each at its b and c, its d 1. */
const fromRows = (declared: Declared, target: typeof R | typeof S) =>
	query(Pair).rule((r: RuleValue) => {
		const { b, c } = v(target, "row")
		return r.match(r.relation("rows", headingOf[declared]), { b, c }).find({ b, c, d: 1 })
	})

const declaredList = ["b, c, d", "b, c", "c, b, d", "b, c, d as a bigint"] as const

const caseGen: Gen<readonly [Declared, Declared]> = (source) =>
	[source.draw(element(declaredList)), source.draw(element(declaredList))] as const

type ParamFeature = "one heading" | "a heading within the other" | "a field of another type"

describe("a relation parameter two members read", () => {
	it.effect(
		"is one declaration: the ChangeSet compiles exactly when both declare its fields and their types alike",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/changeset/params",
						generator: caseGen,
						literal: Formatter.format,
						limit: declaredList.length ** 2,
						box: "R and S inserted from `rows`, each member declaring it under b, c and d; b and c; c, b and d; or b, c and d with d a bigint",
						oracle: {
							kind: "specification",
							name: "one declaration of a parameter: its fields and their types, apart from their order"
						},
						coverage: requiredInSpace<ParamFeature>([
							"one heading",
							"a heading within the other",
							"a field of another type"
						]),
						caseHang
					},
					([first, second], c) =>
						Effect.sync(() => {
							const write = ChangeSet.empty(Pair)
								.insert(R, fromRows(first, R))
								.insert(S, fromRows(second, S))
							const compiled = compileWrite(
								checking(Pair),
								descOf(write),
								realityWrite(succeeded(testArtifacts(Pair, testCompile)))
							)
							if (sameFields(fieldsOf[first], fieldsOf[second])) {
								succeeded(compiled, `${first} beside ${second}`)
								c.note("one heading")
								return
							}
							refused(compiled, "MalformedDescription", `${first} beside ${second}`)
							c.note(
								fieldsOf[first].length === fieldsOf[second].length
									? "a field of another type"
									: "a heading within the other"
							)
						})
				)
			)
	)
})
