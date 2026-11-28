/** What the property of zero-work.test.ts reads: its field types, its shapes and the work it counts. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { ArgumentZeros } from "#compiler/lower/conservative/group/index.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic } from "#compiler/public/compute.ts"
import {
	domain,
	float4,
	float8,
	int2,
	int4,
	int8,
	money,
	numeric
} from "#compiler/public/fields.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
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
 * ... ELSE ±0::float END)`, which a min, a max, a sum and a mean read their zero's sign off, apart from an exact sum's
 * own CASE over each value's bits; and a zero's sign byte, `get_byte(float8send(x), 0)`, which a write compares two facts
 * by.
 */
export type Work = "canonical zero" | "zero sum" | "sign byte"

const works: Arr.NonEmptyReadonlyArray<Work> = ["canonical zero", "zero sum", "sign byte"]

/** Whether a literal is a float's zero, +0 or the special -0. */
const floatZero = (e: Expr): boolean =>
	e.kind === "literal" &&
	((e.value.kind === "float" && e.value.value === 0) ||
		(e.value.kind === "floatSpecial" && e.value.value === "-0"))

/** The kind of a float zero's work an expression is, if any: its own node, not its children's. */
const workOf = (e: Expr): Work | undefined => {
	if (e.kind === "binary" && e.op === "+" && floatZero(e.right)) {
		return "canonical zero"
	}
	if (e.kind === "call" && !e.star && e.fn.kind === "builtin") {
		const [summed] = e.args
		if (e.fn.name === "sum" && summed?.kind === "case" && floatZero(summed.else)) {
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
	{ name: "real", field: float4, float: true, aggregates: ["min", "max", "sum", "mean"] },
	{
		name: "double precision",
		field: float8,
		float: true,
		aggregates: ["min", "max", "sum", "mean"]
	},
	{ name: "smallint", field: int2, float: false, aggregates: ["min", "max", "sum", "mean"] },
	{ name: "integer", field: int4, float: false, aggregates: ["min", "max", "sum", "mean"] },
	{ name: "bigint", field: int8, float: false, aggregates: ["min", "max", "sum", "mean"] },
	{
		name: "numeric(10, 2)",
		field: numeric(10, 2),
		float: false,
		aggregates: ["min", "max", "sum", "mean"]
	},
	{ name: "money", field: money, float: false, aggregates: ["min", "max", "sum"] },
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
	const R = relation("R", { k: int8, g: int8, x: c.type.field }, ["k"])
	const S = relation("S", { k: int8, x: c.type.field }, ["k"])
	const Values = schema("Values", [R, S], [unit("Ks", { k: int8 }), mutable(R)])
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

/**
 * A float aggregate's argument by its form, and what it holds of the two zeros (lower/conservative/group
 * ArgumentZeros): a double or a real field, which may hold -0; a field of a contract over double precision above zero,
 * never zero, or at or above zero, which admits -0 since -0 >= 0; an integer cast to double precision, whose zero is
 * +0, and a real cast to it, which keeps a -0; a Logic.cond of an integer's cast and the literal 0, of it and the
 * literal -0, and of a double and 0.
 */
const argumentForms = [
	{ name: "a double", zeros: "signed" },
	{ name: "a real", zeros: "signed" },
	{ name: "a double above zero", zeros: "unsigned" },
	{ name: "a double never zero", zeros: "unsigned" },
	{ name: "a double at or above zero", zeros: "signed" },
	{ name: "an integer cast to double", zeros: "unsigned" },
	{ name: "a real cast to double", zeros: "signed" },
	{ name: "a cond of an integer's cast and 0", zeros: "unsigned" },
	{ name: "a cond of an integer's cast and -0", zeros: "signed" },
	{ name: "a cond of a double and 0", zeros: "signed" }
] as const satisfies ReadonlyArray<{ readonly name: string; readonly zeros: ArgumentZeros }>

export type ArgumentForm = (typeof argumentForms)[number]

const floatAggregates = ["min", "max", "sum", "mean"] as const

/** A case of a float aggregate: the aggregate and its argument's form. */
export interface ArgumentCase {
	readonly aggregate: (typeof floatAggregates)[number]
	readonly form: ArgumentForm
}

/** Every float aggregate over every argument form. */
export const argumentCaseGen: Gen<ArgumentCase> = (source) => ({
	aggregate: source.draw(element(floatAggregates)),
	form: source.draw(element(argumentForms))
})

const aboveZeroKey = Symbol("AboveZero")
const AboveZero = domain<typeof aboveZeroKey>()("AboveZero", float8, (v) => Logic.gt(v, 0))
const neverZeroKey = Symbol("NeverZero")
const NeverZero = domain<typeof neverZeroKey>()("NeverZero", float8, (v) => Logic.ne(v, 0))
const atOrAboveZeroKey = Symbol("AtOrAboveZero")
const AtOrAboveZero = domain<typeof atOrAboveZeroKey>()("AtOrAboveZero", float8, (v) =>
	Logic.ge(v, 0)
)

const F = relation(
	"F",
	{
		k: int8,
		g: int8,
		n: int4,
		d: float8,
		r: float4,
		above: AboveZero,
		never: NeverZero,
		atOrAbove: AtOrAboveZero
	},
	["k"]
)
const Floats = schema("Floats", [F], [unit("Ks", { k: int8 }), mutable(F)])

/** The statements an argument case compiles to: its grouped aggregate's read under both lowerings. */
export const argumentStatementsOf = (c: ArgumentCase): ReadonlyArray<SqlStatement> => {
	const q = queryOver(Floats).rule((r: RuleValue) => {
		const x = varsOver(F, "f")
		const fields = {
			k: x["k"],
			g: x["g"],
			n: x["n"],
			d: x["d"],
			r: x["r"],
			above: x["above"],
			never: x["never"],
			atOrAbove: x["atOrAbove"]
		}
		const double = float8
		const integer = (): unknown => computeCore.cast(x["n"], double)
		const positive = (): unknown => computeCore.gt(x["n"], computeCore.literal(int4, 0))
		const argument = ((): unknown => {
			switch (c.form.name) {
				case "a double":
					return x["d"]
				case "a real":
					return x["r"]
				case "a double above zero":
					return x["above"]
				case "a double never zero":
					return x["never"]
				case "a double at or above zero":
					return x["atOrAbove"]
				case "an integer cast to double":
					return integer()
				case "a real cast to double":
					return computeCore.cast(x["r"], double)
				case "a cond of an integer's cast and 0":
					return computeCore.cond(positive(), integer(), computeCore.literal(double, 0))
				case "a cond of an integer's cast and -0":
					return computeCore.cond(positive(), integer(), computeCore.literal(double, -0))
				case "a cond of a double and 0":
					return computeCore.cond(positive(), x["d"], computeCore.literal(double, 0))
			}
		})()
		const value = ((): unknown => {
			switch (c.aggregate) {
				case "min":
					return r.min(argument)
				case "max":
					return r.max(argument)
				case "sum":
					return r.sum(argument)
				case "mean":
					return r.mean(argument)
			}
		})()
		return r.match(F, fields).find({ g: x["g"], value })
	})
	const { optimized, conservative } = succeeded(
		compileTemplate(q, undefined, testCompile),
		`the ${c.aggregate} of ${c.form.name} compiles`
	).programs
	return [...programAsts(optimized), ...Arr.map(flight(conservative.roots), (s) => s.ast)]
}

export type ArgumentFeature =
	| `${ArgumentZeros} ${(typeof floatAggregates)[number]}`
	| `form ${ArgumentForm["name"]}`

export const argumentFeatures: Arr.NonEmptyReadonlyArray<ArgumentFeature> = [
	...Arr.map(argumentForms, (f): ArgumentFeature => `form ${f.name}`),
	...Arr.flatMap(floatAggregates, (a): ReadonlyArray<ArgumentFeature> => [
		`signed ${a}`,
		`unsigned ${a}`
	])
]
