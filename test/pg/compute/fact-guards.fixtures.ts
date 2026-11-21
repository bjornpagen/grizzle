/** What the properties of fact-guards.test.ts read: its spaces, models and helpers. */

import {
	array,
	boolean,
	element,
	type Gen,
	int,
	oneOf,
	weighted,
	type Steered
} from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Data, Effect, Option } from "effect"
import { int4Max } from "#compiler/core/canonical.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { int2Max, int2Min, int4Min, int8Max, int8Min } from "#compiler/ir/carriers.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/scalar/values/fault.ts"
import type { ModelValue } from "#test/support/oracle/evaluate/catalog.ts"
import {
	baseParams,
	type LoweredTable,
	lowerWith,
	param,
	spelledExpr,
	testContract,
	type TestField,
	testPg,
	v
} from "#test/unit/compute/support.ts"

type GuardName = "nonzero" | "nonnegative" | "positive" | "isFinite"

type Position =
	| "a query's predicate"
	| "when's guard over a column"
	| "when's guard over a parameter"

/** What a contract's predicate keeps of its base: every value, or the ones a comparison with zero holds of. */
type Keeps = "every value" | "ne" | "gt" | "ge" | "lt" | "le"

/** A contract's base: a numeric of a drawn typmod, or an integer type. */
type Base =
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "integer"; readonly sql: "smallint" | "integer" | "bigint" }

/** A drawn value of a base: an exact one, units · 10^exponent, or NaN. */
type Value =
	| { readonly kind: "exact"; readonly units: bigint; readonly exponent: number }
	| { readonly kind: "nan" }

interface Case {
	readonly base: Base
	readonly keeps: Keeps
	readonly guard: GuardName
	readonly position: Position
	readonly values: ReadonlyArray<Value>
}

export type Feature =
	| Position
	| "a guard whose constant the domain keeps out"
	| "a NaN tested"
	| "refused where the types refuse"

/** The integer types' ranges. */
const integerRanges = {
	smallint: [BigInt(int2Min), BigInt(int2Max)],
	integer: [BigInt(int4Min), BigInt(int4Max)],
	bigint: [int8Min, int8Max]
} as const

/** A numeric typmod: mostly a small precision and a scale within it, sometimes either anywhere PostgreSQL allows. */
const numericBase: Gen<Base> = (source) => {
	const precision = source.draw(oneOf([int(1, 12), int(1, numericMaxPrecision)]))
	const scale = source.draw(
		oneOf([int(0, Math.min(precision, 12)), int(numericMinScale, numericMaxScale)])
	)
	return { kind: "numeric", precision, scale }
}

const baseGen: Gen<Base> = weighted([
	[3, numericBase],
	[
		1,
		(source) => ({
			kind: "integer",
			sql: source.draw(element(["smallint", "integer", "bigint"] as const))
		})
	]
])

/** A value of a base: zero, a small or a widest one of either sign, or, over numeric, NaN. */
const valueGen =
	(base: Base): Gen<Value> =>
	(source) => {
		if (base.kind === "integer") {
			const [lo, hi] = integerRanges[base.sql]
			return {
				kind: "exact",
				units: source.draw(oneOf([bigint(-3n, 3n), bigint(lo, hi)])),
				exponent: 0
			}
		}
		const widest = 10n ** BigInt(base.precision) - 1n
		return source.draw(
			weighted<Value>([
				[1, () => ({ kind: "nan" })],
				[
					4,
					(inner) => ({
						kind: "exact",
						units: inner.draw(oneOf([bigint(-3n, 3n), bigint(-widest, widest)])),
						exponent: -base.scale
					})
				]
			])
		)
	}

/** Whether a contract's predicate holds of a value, as PostgreSQL orders NaN, above every number. */
const kept = (keeps: Keeps, value: Value): boolean => {
	if (value.kind === "nan") {
		return keeps === "every value" || keeps === "ne" || keeps === "gt" || keeps === "ge"
	}
	const sign = value.units < 0n ? -1 : value.units > 0n ? 1 : 0
	switch (keeps) {
		case "every value":
			return true
		case "ne":
			return sign !== 0
		case "gt":
			return sign > 0
		case "ge":
			return sign >= 0
		case "lt":
			return sign < 0
		case "le":
			return sign <= 0
	}
}

const caseGen: Gen<Case> = (source) => {
	const base = source.draw(baseGen)
	const keeps = source.draw(element(["every value", "ne", "gt", "ge", "lt", "le"] as const))
	const values = Arr.filter(source.draw(array(valueGen(base), { min: 1, max: 8 })), (x) =>
		kept(keeps, x)
	)
	return {
		base,
		keeps,
		guard: source.draw(element(["nonzero", "nonnegative", "positive", "isFinite"] as const)),
		position: source.draw(
			element([
				"a query's predicate",
				"when's guard over a column",
				"when's guard over a parameter"
			] as const)
		),
		values
	}
}

/**
 * A case as the generator draws it, aimed at a refusal while no witness has reached one (Steered): half its cases, by a
 * draw of their own, isFinite over a contract of an integer, which the types refuse; a rotating case is drawn unaimed.
 */
export const aimedCaseGen: Steered<Case, Feature>["under"] = (steering) => (source) => {
	const c = source.draw(caseGen)
	return Option.exists(steering, (pending) => pending.has("refused where the types refuse")) &&
		source.draw(boolean)
		? {
				...c,
				base: {
					kind: "integer",
					sql: source.draw(element(["smallint", "integer", "bigint"] as const))
				},
				guard: "isFinite",
				values: []
			}
		: c
}

/** A base's test field. */
const baseField = (base: Base): TestField => {
	if (base.kind === "numeric") {
		return testPg.numericOf(base.precision, base.scale)
	}
	switch (base.sql) {
		case "smallint":
			return testPg.smallint
		case "integer":
			return testPg.integer
		case "bigint":
			return testPg.bigint
	}
}

/** A base's SQL type. */
export const baseSql = (base: Base): string =>
	base.kind === "numeric" ? `numeric(${base.precision}, ${base.scale})` : base.sql

/** Zero as a literal of a base: a JavaScript integer for smallint and integer, a bigint otherwise. */
const zeroOf = (base: Base): LiteralDesc =>
	base.kind === "integer" && base.sql !== "bigint" ? 0 : 0n

/** The contract a case draws, over its base, its predicate the case's comparison with zero. */
export const contractOver = (base: Base, keeps: Keeps): TestField => {
	const zero = zeroOf(base)
	const field = baseField(base)
	switch (keeps) {
		case "every value":
			return testContract("Guarded", field, undefined)
		case "ne":
			return testContract("Guarded", field, (x) => computeCore.ne(x, zero))
		case "gt":
			return testContract("Guarded", field, (x) => computeCore.gt(x, zero))
		case "ge":
			return testContract("Guarded", field, (x) => computeCore.ge(x, zero))
		case "lt":
			return testContract("Guarded", field, (x) => computeCore.lt(x, zero))
		case "le":
			return testContract("Guarded", field, (x) => computeCore.le(x, zero))
	}
}

/** The guard of a case over its subject. */
const guardOver = (guard: GuardName, x: ScalarTerm): { readonly expr: OpenExpr } => {
	switch (guard) {
		case "nonzero":
			return computeCore.nonzero(x)
		case "nonnegative":
			return computeCore.nonnegative(x)
		case "positive":
			return computeCore.positive(x)
		case "isFinite":
			return computeCore.isFinite(x)
	}
}

/**
 * computeCore.when over a case's guard, its branch the operation that needs what the guard proves of the subject's
 * value: a quotient by it for nonzero and positive, a square root for nonnegative, its least scale for isFinite.
 */
const whenOver = (guard: GuardName, base: Base, x: ScalarTerm): { readonly expr: OpenExpr } => {
	switch (guard) {
		case "nonzero":
		case "positive":
			return computeCore.when(guardOver(guard, x), (y: ScalarTerm) => computeCore.div(y, y), 0n)
		case "nonnegative":
			return computeCore.when(
				guardOver(guard, x),
				(y: ScalarTerm) =>
					computeCore.sqrt(base.kind === "numeric" ? computeCore.base(y) : computeCore.numeric(y)),
				0n
			)
		case "isFinite":
			return computeCore.when(guardOver(guard, x), (y: ScalarTerm) => computeCore.minScale(y), 0)
	}
}

/** What a builder threw where it refused its operands. */
export class BuilderThrew extends Data.TaggedError("BuilderThrew")<{ readonly cause: unknown }> {}

/**
 * A case's guard compiled as a query compiles it, over a column or a parameter of its contract: a builder's refusal,
 * thrown where the call is written, or the lowering's.
 */
export const compiled = (
	c: Case,
	field: TestField
): Effect.Effect<LoweredTable, BuilderThrew | CompileError> => {
	const subject = c.position === "when's guard over a parameter" ? param("p", field) : v("x", field)
	return Effect.flatMap(
		Effect.try({
			try: () =>
				spelledExpr(
					(c.position === "a query's predicate"
						? guardOver(c.guard, subject)
						: whenOver(c.guard, c.base, subject)
					).expr
				),
			catch: (cause) => new BuilderThrew({ cause })
		}),
		(expr) => {
			const lowered = lowerWith(
				"query",
				expr,
				{ x: { kind: "column", type: field.scalar } },
				c.position === "a query's predicate",
				baseParams
			)
			return lowered.ok ? Effect.succeed(lowered.value) : Effect.fail(lowered.error)
		}
	)
}

/**
 * Where the types admit a guard: isFinite over a numeric that may be NaN (InexactSql), so over no numeric of scale 0,
 * finite by its type (types/compute/compute.ts FiniteByType); the others over every number (NumericSql).
 */
export const typesAdmit = (c: Case): boolean =>
	c.guard !== "isFinite" || (c.base.kind === "numeric" && c.base.scale !== 0)

/**
 * Whether the guard's constant is no value of the case's domain: isFinite's, NaN, the one value a typmod holds that is
 * not finite (scalar/compute/typing.ts finiteTests), where the predicate keeps NaN out; another guard's zero where it
 * keeps zero out.
 */
export const constantKeptOut = (c: Case): boolean =>
	!kept(
		c.keeps,
		c.guard === "isFinite" ? { kind: "nan" } : { kind: "exact", units: 0n, exponent: 0 }
	)

/** A value's text, as PostgreSQL's numeric and integer input functions read it. */
export const valueText = (value: Value): string =>
	value.kind === "nan"
		? "NaN"
		: value.exponent === 0
			? String(value.units)
			: `${value.units}e${value.exponent}`

/** A value as the host evaluator carries a base's value: a Decimal over numeric, a bigint over the integers. */
export const carried = (base: Base, value: Value): ModelValue =>
	base.kind === "numeric" ? Decimal.of(valueText(value)) : value.kind === "exact" ? value.units : 0n
