/** What the properties of injective.test.ts read: its spaces, models and helpers. */

import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { Array as Arr, Formatter } from "effect"
import { ExprId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { floatLiteral } from "#compiler/ir/carriers.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { builtExpr, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import { baseOf, type ScalarType, subsumes } from "#compiler/ir/scalar.ts"
import { binaryCoercion, castOf } from "#compiler/scalar/compute/registry.ts"
import { anyNumeric } from "#compiler/scalar/compute/types.ts"
import { bareEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	compareCarried,
	constantEnv,
	evaluate,
	type ModelValue
} from "#test/support/oracle/evaluate/catalog.ts"

/** A type by the descriptor registry's reading of its field descriptor. */
const typeOf = (desc: FieldDesc): ScalarType => {
	const typed = scalarTypeOf(desc, bareEnv, SourceLoc("an injectivity case", []))
	if (!typed.ok) {
		throw new Error(`the registry refuses ${Formatter.format(desc)}: ${typed.error.message}`)
	}
	return typed.value
}

interface Typed {
	readonly name: string
	readonly type: ScalarType
}

const typed = (name: string, desc: FieldDesc): Typed => ({ name, type: typeOf(desc) })

/** The integer, floating and exact numeric types, at typmods that keep, round and widen each other's scales. */
export const types: Arr.NonEmptyReadonlyArray<Typed> = [
	typed("smallint", { kind: "pg", type: "smallint" }),
	typed("integer", { kind: "pg", type: "integer" }),
	typed("bigint", { kind: "pg", type: "bigint" }),
	typed("real", { kind: "pg", type: "real" }),
	typed("double precision", { kind: "pg", type: "double precision" }),
	{ name: "numeric", type: anyNumeric },
	typed("numeric(5,0)", { kind: "numeric", precision: 5, scale: 0 }),
	typed("numeric(10,0)", { kind: "numeric", precision: 10, scale: 0 }),
	typed("numeric(12,0)", { kind: "numeric", precision: 12, scale: 0 }),
	typed("numeric(10,1)", { kind: "numeric", precision: 10, scale: 1 }),
	typed("numeric(10,2)", { kind: "numeric", precision: 10, scale: 2 }),
	typed("numeric(12,2)", { kind: "numeric", precision: 12, scale: 2 }),
	typed("numeric(12,4)", { kind: "numeric", precision: 12, scale: 4 }),
	typed("numeric(10,-2)", { kind: "numeric", precision: 10, scale: -2 })
]

const bigint = typeOf({ kind: "pg", type: "bigint" })

const double = typeOf({ kind: "pg", type: "double precision" })

const decimal = (text: string): TypedLiteral => {
	const d = Decimal.fromString(text)
	if (!d.ok) {
		throw new Error(`the dictionary's decimal ${text} does not parse`)
	}
	return { kind: "numeric", value: d.value }
}

const float = (value: number): TypedLiteral =>
	Number.isNaN(value)
		? { kind: "floatSpecial", value: "NaN" }
		: value === Number.POSITIVE_INFINITY
			? { kind: "floatSpecial", value: "Infinity" }
			: value === Number.NEGATIVE_INFINITY
				? { kind: "floatSpecial", value: "-Infinity" }
				: floatLiteral(value)

/** The dictionary, each value a literal of the widest type of its family. */
export const dictionary: ReadonlyArray<{
	readonly literal: TypedLiteral
	readonly type: ScalarType
}> = [
	...Arr.map(
		[
			-(2n ** 63n),
			-(2n ** 53n) - 1n,
			-(2n ** 31n),
			-32768n,
			-1n,
			0n,
			1n,
			2n,
			100n,
			120n,
			149n,
			150n,
			2n ** 24n,
			2n ** 24n + 1n,
			32767n,
			2n ** 31n - 1n,
			2n ** 53n,
			2n ** 53n + 1n,
			2n ** 63n - 1n
		],
		(value) => ({ literal: { kind: "int", value } satisfies TypedLiteral, type: bigint })
	),
	...Arr.map(
		[
			0,
			-0,
			0.1,
			0.5,
			1,
			1 + 2 ** -30,
			1.4,
			1.5,
			2.5,
			-2.5,
			16_777_217,
			2 ** 53,
			1e-40,
			1e-45,
			3.4028234663852886e38,
			1e300,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY
		],
		(value) => ({ literal: float(value), type: double })
	),
	...Arr.map(
		[
			"0",
			"1",
			"1.2",
			"1.24",
			"1.245",
			"1.25",
			"1.3",
			"1.4",
			"1.5",
			"2.5",
			"-0.5",
			"0.1",
			"0.10000000000000000001",
			"100",
			"120",
			"149",
			"150",
			"12345.678",
			"9007199254740993",
			"NaN",
			"Infinity",
			"-Infinity"
		],
		(text) => ({ literal: decimal(text), type: anyNumeric })
	)
]

/**
 * A cast of `arg` into `type` as the registry names it: none where `type` subsumes the argument's, the value standing as
 * it is (ir/scalar.ts subsumes; ir/expr.ts builtExpr refuses the up-cast); the coercion within a carrier, a cast defined
 * on every value, or a narrowing beside a proof, which the evaluator never reads; the evaluator states where a narrowing
 * is undefined.
 */
const castNode = (arg: ScalarExpr, type: ScalarType, id: ExprId): ScalarExpr => {
	if (subsumes(type, arg.type)) {
		return arg
	}
	const from = baseOf(arg.type).carrier
	const to = baseOf(type).carrier
	const native = from === to ? undefined : castOf(from, to)
	const common = {
		kind: "cast",
		args: [arg],
		nonNull: "strict",
		type,
		volatility: "immutable"
	} as const
	if (native === undefined) {
		return builtExpr({ ...common, cast: binaryCoercion }, id)
	}
	return native.partial
		? builtExpr(
				{
					...common,
					cast: native.id,
					proof: mapNonEmpty(native.totality.preconditions, (precondition) => ({
						precondition,
						premises: [{ kind: "checked", operand: 0, by: "literal" }]
					}))
				},
				id
			)
		: builtExpr({ ...common, cast: native.id }, id)
}

/** The value a literal casts to in `source`, then in `target`, by the oracle's evaluator: each a value or a refusal. */
export const castChain = (
	literal: TypedLiteral,
	wide: ScalarType,
	source: ScalarType,
	target: ScalarType
) => {
	const value = builtExpr(
		{ kind: "literal", value: literal, args: [], nonNull: "literal", type: wide },
		ExprId("e0")
	)
	const sourced = castNode(value, source, ExprId("e1"))
	const targeted = castNode(sourced, target, ExprId("e2"))
	return { source: evaluate(sourced, constantEnv), target: evaluate(targeted, constantEnv) }
}

/**
 * Whether a native cast exists between the types: within one carrier always (a typmod coercion), otherwise the
 * registry's cast table.
 */
export const castable = (from: ScalarType, to: ScalarType): boolean => {
	const a = baseOf(from).carrier
	const b = baseOf(to).carrier
	return a === b || castOf(a, b) !== undefined
}

/**
 * Whether castInjective decides the pair by rule, so a refusal must have a witness: a cast within one carrier, out of
 * an integer, or from a float into a float or an integer.
 */
export const decided = (from: ScalarType, to: ScalarType): boolean =>
	baseOf(from).carrier === baseOf(to).carrier ||
	family(from) === "integer" ||
	(family(from) === "float" && family(to) !== "numeric")

/** A carrier's family, for the features. */
type Family = "integer" | "float" | "numeric"

export const family = (t: ScalarType): Family => {
	switch (baseOf(t).carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			return "integer"
		case "float4":
		case "float8":
			return "float"
		case "variant":
		case "bool":
		case "code":
		case "bits":
		case "money":
		case "exactMoney":
		case "numeric":
		case "range4":
		case "range8":
		case "rangeDate":
		case "bytes":
		case "sha256":
		case "text":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "vector":
		case "tsvector":
			return "numeric"
	}
}

export const equalValues = (a: ModelValue, b: ModelValue, t: ScalarType): boolean =>
	compareCarried(a, b, t) === 0

export type InjectiveFeature =
	| `${Family}->${Family} admitted`
	| `${Family}->${Family} refused, a merge witnessed`
	| "a value the cast refuses"
