/** What the property of zero-work.test.ts reads: its field types, its shapes and the work it counts. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { flight } from "#compiler/lower/conservative/types.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { mutable, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { Expr, SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	programAsts,
	realityWrite,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"

/**
 * The work a float's zero costs a statement, by the form each kind of it takes (check/merge.ts, scalar/aggregate.ts,
 * ir/compare.ts): the canonical zero a merge delivers, `x + 0::float`; a sum of a float's zeros, `sum(CASE WHEN x = 0
 * ...)`, which a min, a max, a sum and a mean read their zero's sign off; and a zero's sign byte, `get_byte(float8send(x),
 * 0)`, which a write compares two facts by.
 */
export type Work = "canonical zero" | "zero sum" | "sign byte"

const works: Arr.NonEmptyReadonlyArray<Work> = ["canonical zero", "zero sum", "sign byte"]

/** Whether a literal is a float's zero. */
const floatZero = (e: Expr): boolean =>
	e.kind === "literal" && e.value.kind === "float" && e.value.value === 0

/** The kind of a float zero's work an expression is, if any: its own node, not its children's. */
const workOf = (e: Expr): Work | undefined => {
	if (e.kind === "binary" && e.op === "+" && floatZero(e.right)) {
		return "canonical zero"
	}
	if (e.kind === "call" && !e.star && e.fn.kind === "builtin") {
		if (e.fn.name === "sum" && e.args[0]?.kind === "case") {
			return "zero sum"
		}
		if (e.fn.name === "get_byte") {
			return "sign byte"
		}
	}
	return undefined
}

/** How many expressions of each kind of a float zero's work `statements` hold. */
export const workIn = (statements: ReadonlyArray<SqlStatement>): Readonly<Record<Work, number>> => {
	const counts: Record<Work, number> = { "canonical zero": 0, "zero sum": 0, "sign byte": 0 }
	for (const s of statements) {
		transformStatement(s, {
			...identityHooks,
			expr: (e) => {
				const work = workOf(e)
				if (work !== undefined) {
					counts[work] += 1
				}
				return e
			}
		})
	}
	return counts
}

/** No work of a float's zero. */
export const noWork: Readonly<Record<Work, number>> = {
	"canonical zero": 0,
	"zero sum": 0,
	"sign byte": 0
}

/**
 * The field types a statement's value is of: real and double precision, whose two zeros the work tells apart, and
 * every other type an aggregate, a merge or a write branches on, each with the aggregates it is defined on.
 */
const fieldTypes = [
	{ name: "real", field: pg.real, float: true, aggregates: ["min", "max", "sum", "mean"] },
	{
		name: "double precision",
		field: pg["double precision"],
		float: true,
		aggregates: ["min", "max", "sum", "mean"]
	},
	{ name: "smallint", field: pg.smallint, float: false, aggregates: ["min", "max", "sum", "mean"] },
	{ name: "integer", field: pg.integer, float: false, aggregates: ["min", "max", "sum", "mean"] },
	{ name: "bigint", field: pg.bigint, float: false, aggregates: ["min", "max", "sum", "mean"] },
	{
		name: "numeric(10, 2)",
		field: pg.numeric(10, 2),
		float: false,
		aggregates: ["min", "max", "sum", "mean"]
	},
	{ name: "money", field: pg.money, float: false, aggregates: ["min", "max", "sum"] },
	{
		name: "text",
		field: str.bytes(64, str.regex("^.*$", "su")),
		float: false,
		aggregates: ["min", "max"]
	}
] as const

export type FieldType = (typeof fieldTypes)[number]

type Aggregate = FieldType["aggregates"][number]

/**
 * What a statement does with the value: a merge, a projection that drops the key, a union of two keyed heads, a group
 * keyed by the value, a join variable bound by two relations' fields; a write of a fact that holds it, a put, an insert
 * and an exact deletion; or an aggregate of it the type has.
 */
const mergesAndWrites = [
	"a projection",
	"a union",
	"a group key",
	"a join variable",
	"a put",
	"an insert",
	"a deletion"
] as const
export type Shape = (typeof mergesAndWrites)[number] | Aggregate

/** The work a shape's statements do at a float, which the merge, the aggregate or the write it is asks. */
export const workAtFloat = (shape: Shape): Work => {
	switch (shape) {
		case "a projection":
		case "a union":
		case "a group key":
		case "a join variable":
			return "canonical zero"
		case "min":
		case "max":
		case "sum":
		case "mean":
			return "zero sum"
		case "a put":
		case "an insert":
		case "a deletion":
			return "sign byte"
	}
}

/** A case: a field type and a shape the type is defined on. */
export interface WorkCase {
	readonly type: FieldType
	readonly shape: Shape
}

/** Every field type under every shape it is defined on: an aggregate only where the type has it. */
export const workCaseGen: Gen<WorkCase> = (source) => {
	const type = source.draw(element(fieldTypes))
	const shapes: Arr.NonEmptyReadonlyArray<Shape> = [...mergesAndWrites, ...type.aggregates]
	return { type, shape: source.draw(element(shapes)) }
}

/** The statements a case compiles to: a read's under both lowerings, a write's optimized artifact. */
export const statementsOf = (c: WorkCase): ReadonlyArray<SqlStatement> => {
	const R = relation("R", { k: pg.bigint, g: pg.bigint, x: c.type.field }, ["k"])
	const S = relation("S", { k: pg.bigint, x: c.type.field }, ["k"])
	const Values = schema("Values", [R, S], [mutable(R)])
	const at = `the ${c.shape} over ${c.type.name}`
	const read = (
		rules: Arr.NonEmptyReadonlyArray<(r: RuleValue) => unknown>
	): ReadonlyArray<SqlStatement> => {
		const [first, ...more] = rules
		const q = Arr.reduce(more, queryOver(Values).rule(first), (built, rule) => built.rule(rule))
		const { optimized, conservative } = succeeded(
			compileTemplate(q, undefined, testCompile),
			`${at} compiles`
		).programs
		return [...programAsts(optimized), ...Arr.map(flight(conservative.roots), (s) => s.ast)]
	}
	const write = (changes: unknown): ReadonlyArray<SqlStatement> => {
		const program = succeeded(
			compileWrite(
				checking(Values),
				defined(changeSetDesc(changes), `${at}'s Description`),
				realityWrite(succeeded(testArtifacts(Values, testCompile)))
			),
			`${at} compiles`
		)
		return Arr.map(program.artifact.statements, (s) => s.ast)
	}
	/** R's variables, matched whole, and the head `find` reads them into. */
	const overR =
		(head: (r: RuleValue, x: Readonly<Record<string, unknown>>) => unknown) =>
		(r: RuleValue): unknown => {
			const x = varsOver(R, "r")
			return r.match(R, { k: x["k"], g: x["g"], x: x["x"] }).find(head(r, x))
		}
	switch (c.shape) {
		case "a projection":
			return read([overR((_, x) => ({ x: x["x"] }))])
		case "a union":
			return read([
				overR((_, x) => ({ k: x["k"], x: x["x"] })),
				(r) => {
					const y = varsOver(S, "s")
					return r.match(S, { k: y["k"], x: y["x"] }).find({ k: y["k"], x: y["x"] })
				}
			])
		case "a group key":
			return read([overR((r, x) => ({ x: x["x"], n: r.count() }))])
		case "a join variable":
			return read([
				(r) => {
					const x = varsOver(R, "r")
					const y = varsOver(S, "s")
					return r
						.match(R, { k: x["k"], g: x["g"], x: x["x"] })
						.match(S, { k: y["k"], x: x["x"] })
						.find({ a: x["k"], b: y["k"], x: x["x"] })
				}
			])
		case "min":
			return read([overR((r, x) => ({ g: x["g"], value: r.min(x["x"]) }))])
		case "max":
			return read([overR((r, x) => ({ g: x["g"], value: r.max(x["x"]) }))])
		case "sum":
			return read([overR((r, x) => ({ g: x["g"], value: r.sum(x["x"]) }))])
		case "mean":
			return read([overR((r, x) => ({ g: x["g"], value: r.mean(x["x"]) }))])
		case "a put":
			return write(ChangeSet.empty(Values).put(R, []))
		case "an insert":
			return write(ChangeSet.empty(Values).insert(R, []))
		case "a deletion":
			return write(ChangeSet.empty(Values).delete(R, []))
	}
}

export type Feature = `${Work} at a float` | `none at ${FieldType["name"]}`

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	...Arr.map(works, (w): Feature => `${w} at a float`),
	...Arr.flatMap(fieldTypes, (t): ReadonlyArray<Feature> => (t.float ? [] : [`none at ${t.name}`]))
]
