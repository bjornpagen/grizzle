/** What the properties of aggregate.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Record } from "effect"
import { type CompareOp, type ComputeFn, computeFns } from "#compiler/ir/desc.ts"
import type { NumericBound } from "#compiler/ir/scalar.ts"
import { Logic, Type } from "#compiler/public/compute.ts"
import {
	domain,
	bool,
	float4,
	float8,
	int2,
	int4,
	int8,
	money,
	numeric
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { computeSpecs, type NativeFn, nativeOps } from "#compiler/scalar/compute/registry.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { Id } from "#test/support/ids.ts"

/** Whether a lowered program counts by FILTER: a count(*) with a FILTER clause in any statement. */
export const countsByFilter = (
	statements: ReadonlyArray<{ readonly ast: SqlStatement }>
): boolean => {
	let filtered = false
	for (const { ast } of statements) {
		transformStatement(ast, {
			...identityHooks,
			expr: (e) => {
				if (e.kind === "call" && e.star && e.filter !== undefined) {
					filtered = true
				}
				return e
			}
		})
	}
	return filtered
}

const Line = relation("Line", { id: Id, flag: bool, qty: int4 }, ["id"])

const Lines = schema("Lines", [Line], [])

/** The head term a shape makes of a conditional: its sum, or the conditional itself. A count takes no argument. */
type Shape = "sum" | "bare"

/**
 * A branch: an integer literal, the integer column qty, or a numeric(5,1) literal, whose value is all a sum reads, so
 * 1.0 is the integer 1 count(*) cast to numeric delivers. A conditional's two branches are of one type, so the leaves
 * pair within theirs.
 */
type Leaf = "integer 0" | "integer 1" | "integer 2" | "qty" | "numeric(5,1) 1.0" | "numeric(5,1) 0"

const integerOf = (leaf: Leaf): number => (leaf === "integer 2" ? 2 : leaf === "integer 1" ? 1 : 0)

const numericOf = (leaf: Leaf) =>
	Type.literal(numeric(5, 1), leaf === "numeric(5,1) 1.0" ? "1.0" : "0")

/** A query of the shape over integer branches, and one over numeric(5,1) branches. */
const integerQuery = (shape: Shape, then: Leaf, otherwise: Leaf): unknown =>
	query(Lines).rule((r) => {
		const { id, flag, qty } = v(Line, "line")
		const other = otherwise === "qty" ? qty : Type.literal(int4, integerOf(otherwise))
		const conditional =
			then === "qty"
				? Logic.cond(flag, qty, other)
				: Logic.cond(flag, Type.literal(int4, integerOf(then)), other)
		return r
			.match(Line, { id, flag, qty })
			.find({ n: shape === "sum" ? r.sum(conditional) : conditional })
	})

const numericQuery = (shape: Shape, then: Leaf, otherwise: Leaf): unknown =>
	query(Lines).rule((r) => {
		const { id, flag, qty } = v(Line, "line")
		const conditional = Logic.cond(flag, numericOf(then), numericOf(otherwise))
		return r
			.match(Line, { id, flag, qty })
			.find({ n: shape === "sum" ? r.sum(conditional) : conditional })
	})

export const aggregateQueryOf = (shape: Shape, then: Leaf, otherwise: Leaf): unknown =>
	then === "numeric(5,1) 1.0" || then === "numeric(5,1) 0"
		? numericQuery(shape, then, otherwise)
		: integerQuery(shape, then, otherwise)

export const shapes = element<Shape>(["sum", "bare"])

export const integerLeaves = element<Leaf>(["integer 0", "integer 1", "integer 2", "qty"])

export const numericLeaves = element<Leaf>(["numeric(5,1) 1.0", "numeric(5,1) 0"])

/**
 * The description vocabulary the registry must cover: each node a scalar function lowers to (registry.ts
 * computeSpecs), every comparison, the boolean connectives and a cast, each naming a registry node. (One OpId per node
 * is the registry's own load-time invariant.)
 */
export type VocabularyWord =
	| { readonly kind: "function"; readonly fn: ComputeFn; readonly node: NativeFn }
	| { readonly kind: "comparison"; readonly node: CompareOp | "between" | "in" }
	| { readonly kind: "connective"; readonly node: "and" | "or" | "not" }
	| { readonly kind: "cast"; readonly node: "cast" }

/** Every comparison a description states, complete by its type. */
const comparisons: { readonly [W in CompareOp | "between" | "in"]: W } = {
	eq: "eq",
	ne: "ne",
	lt: "lt",
	le: "le",
	gt: "gt",
	ge: "ge",
	between: "between",
	in: "in"
}

/** Each scalar function beside each node it lowers to. */
const functionWords = nonEmpty(
	Arr.flatMap(computeFns, (fn) =>
		Arr.map(computeSpecs[fn].nodes, (node): VocabularyWord => ({ kind: "function", fn, node }))
	),
	"the nodes the scalar functions lower to"
)

export const words = oneOf<VocabularyWord>([
	element(functionWords),
	map(element(nonEmpty(Record.values(comparisons), "the comparisons")), (node): VocabularyWord => ({
		kind: "comparison",
		node
	})),
	map(element(["and", "or", "not"] as const), (node): VocabularyWord => ({
		kind: "connective",
		node
	})),
	element<VocabularyWord>([{ kind: "cast", node: "cast" }])
])

export const listed: ReadonlySet<NativeFn> = new Set(Arr.map(nativeOps, (op) => op.fn))

const kept_bigintKey = Symbol("Kept_bigint")
const kept_booleanKey = Symbol("Kept_boolean")
const kept_doubleKey = Symbol("Kept_double")
const kept_integerKey = Symbol("Kept_integer")
const kept_moneyKey = Symbol("Kept_money")
const kept_numericKey = Symbol("Kept_numeric")
const kept_realKey = Symbol("Kept_real")
const kept_smallintKey = Symbol("Kept_smallint")
const kept_textKey = Symbol("Kept_text")
/** A contract over each type min, max, LEAST and GREATEST are defined on. */
export const kept = [
	domain<typeof kept_smallintKey>()("Kept_smallint", int2),
	domain<typeof kept_integerKey>()("Kept_integer", int4),
	domain<typeof kept_bigintKey>()("Kept_bigint", int8),
	domain<typeof kept_numericKey>()("Kept_numeric", numeric(7, 2)),
	domain<typeof kept_realKey>()("Kept_real", float4),
	domain<typeof kept_doubleKey>()("Kept_double", float8),
	domain<typeof kept_moneyKey>()("Kept_money", money),
	domain<typeof kept_booleanKey>()("Kept_boolean", bool),
	domain<typeof kept_textKey>()("Kept_text", str.regex("^.*$", "su"))
] as const

type Kept = (typeof kept)[number]

/** What returns its input: an aggregate or a function of two operands. */
export type Returning = "min" | "max" | "least" | "greatest"

/** How the head reads the contract's term: its column, a parameter of it, or the column's plain value. */
export type Reading = "column" | "parameter" | "base"

export const returnings: Arr.NonEmptyReadonlyArray<Returning> = ["min", "max", "least", "greatest"]

export const readings: Arr.NonEmptyReadonlyArray<Reading> = ["column", "parameter", "base"]

/** The head over `x`, Held's variables, reading the contract's term as `reading` says. */
export const headOf = (
	r: RuleValue,
	x: Readonly<Record<string, unknown>>,
	k: Kept,
	returning: Returning,
	reading: Reading
): unknown => {
	const first =
		reading === "column"
			? x["a"]
			: reading === "parameter"
				? r.param("p", k)
				: computeCore.base(x["a"])
	const second = reading === "base" ? computeCore.base(x["b"]) : x["b"]
	switch (returning) {
		case "min":
			return r.min(first)
		case "max":
			return r.max(first)
		case "least":
			return computeCore.least(first, second)
		case "greatest":
			return computeCore.greatest(first, second)
	}
}

/** What the mean of an argument's greatest value is: that value, the value rounded up past it, or zero. */
export type MeanFeature =
	| "kept at its argument's scale"
	| "rounded up into a new integer digit"
	| "rounded to zero"
	| "an argument holding zero alone"

/**
 * An argument's bound: integer digits within two of 0 or of -1000, the digits of the unit a mean rounds to at numeric's
 * display scale, and a scale within two of 0 or of that display scale, 1000.
 */
export const argumentBoundGen: Gen<NumericBound> = (source) => ({
	digits: source.draw(oneOf([int(-1002, -998), int(-2, 2)])),
	scale: source.draw(oneOf([int(0, 2), int(998, 1002)]))
})

/** The integer digits of a nonzero finite value: the least d with |value| below 10^d. */
export const integerDigits = (coefficient: bigint, minScale: number): number =>
	coefficient.toString().length - minScale
