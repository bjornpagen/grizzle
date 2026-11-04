import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Result } from "effect"
import { ExprId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { canonicalZero } from "#compiler/ir/carriers.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { builtExpr, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import { castInjective } from "#compiler/ir/injective.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { compareValues } from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { binaryCoercion, castOf } from "#compiler/scalar/compute/registry.ts"
import { bareEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"

/**
 * Injective representation through a cast: which native casts keep a key, judged by evaluating them.
 *
 * castInjective (ir/injective.ts) decides, without values, whether a native cast maps values that are
 * distinct under native equality to distinct values. The oracle evaluates the cast: every value of a dictionary of the
 * values the casts branch on (integer range edges, the integers binary32 and binary64 round onto their neighbours,
 * halves and ties, scales that round onto each other, the signed zeros, NaN and the infinities) is cast into each
 * source type by the test kernel's evaluator of the Compute catalogue (oracle/evaluate/catalog.ts), then into each target
 * type.
 *
 * - Soundness: a cast castInjective admits merges no two values of its source that native equality tells apart.
 *   A value the cast refuses (an overflow) is no merge: the cast fails rather than conflates.
 * - Precision, over the casts castInjective decides by rule (within a carrier, from an integer into an integer, a float
 *   or a numeric, and from a float into a float or an integer): a cast it refuses merges two values of the dictionary.
 *   The casts out of a numeric into another carrier and from a float into a numeric are outside the admitted set by
 *   design (some are exact at a typmod: numeric(5,0) into integer, any float into numeric), so they are judged for
 *   soundness only.
 */

/** A type by the descriptor registry's reading of its field descriptor. */
const typeOf = (desc: FieldDesc): ScalarType => {
	const typed = scalarTypeOf(desc, bareEnv, SourceLoc("an injectivity case", []))
	if (!typed.ok) {
		throw new Error(`the registry refuses ${JSON.stringify(desc)}: ${typed.error.message}`)
	}
	return typed.value
}

interface Typed {
	readonly name: string
	readonly type: ScalarType
}

const typed = (name: string, desc: FieldDesc): Typed => ({ name, type: typeOf(desc) })

/** The integer, floating and exact numeric types, at typmods that keep, round and widen each other's scales. */
const types: Arr.NonEmptyReadonlyArray<Typed> = [
	typed("smallint", { kind: "pg", type: "smallint" }),
	typed("integer", { kind: "pg", type: "integer" }),
	typed("bigint", { kind: "pg", type: "bigint" }),
	typed("real", { kind: "pg", type: "real" }),
	typed("double precision", { kind: "pg", type: "double precision" }),
	typed("numeric", { kind: "numeric" }),
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
const numeric = typeOf({ kind: "numeric" })

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
				: { kind: "float", value: canonicalZero(value) }

/** The dictionary, each value a literal of the widest type of its family. */
const dictionary: ReadonlyArray<{ readonly literal: TypedLiteral; readonly type: ScalarType }> = [
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
		(text) => ({ literal: decimal(text), type: numeric })
	)
]

/**
 * A cast of `arg` into `type` as the registry names it: the coercion within a carrier, a cast defined on every value,
 * or a narrowing beside a proof, which the evaluator never reads; the evaluator states where a narrowing is undefined.
 */
const castNode = (arg: ScalarExpr, type: ScalarType, id: ExprId): ScalarExpr => {
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
					proof: {
						precondition: { kind: "fits" },
						premises: [{ kind: "checked", operand: 0, by: "literal" }]
					}
				},
				id
			)
		: builtExpr({ ...common, cast: native.id }, id)
}

/** The value a literal casts to in `source`, then in `target`, by the oracle's evaluator: each a value or a refusal. */
const castChain = (
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
const castable = (from: ScalarType, to: ScalarType): boolean => {
	const a = baseOf(from).carrier
	const b = baseOf(to).carrier
	return a === b || castOf(a, b) !== undefined
}

/**
 * Whether castInjective decides the pair by rule, so a refusal must have a witness: a cast within one carrier, out of
 * an integer, or from a float into a float or an integer.
 */
const decided = (from: ScalarType, to: ScalarType): boolean =>
	baseOf(from).carrier === baseOf(to).carrier ||
	family(from) === "integer" ||
	(family(from) === "float" && family(to) !== "numeric")

/** A carrier's family, for the features. */
type Family = "integer" | "float" | "numeric"

const family = (t: ScalarType): Family => {
	switch (baseOf(t).carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			return "integer"
		case "float4":
		case "float8":
			return "float"
		case "bool":
		case "enum":
		case "money":
		case "exactMoney":
		case "numeric":
		case "range4":
		case "range8":
		case "text":
		case "uuid":
		case "vector":
			return "numeric"
	}
}

const equalValues = (a: CarrierValue, b: CarrierValue, t: ScalarType): boolean =>
	compareValues(a, b, t) === 0

type InjectiveFeature =
	| `${Family}->${Family} admitted`
	| `${Family}->${Family} refused, a merge witnessed`
	| "a value the cast refuses"

describe("castInjective", () => {
	it.effect(
		"admits only casts that merge no two values of their source, and every refusal it decides has a merge",
		(ctx) => {
			const situations = requiredInSpace<InjectiveFeature>([
				"integer->integer admitted",
				"integer->float admitted",
				"integer->float refused, a merge witnessed",
				"float->float admitted",
				"float->float refused, a merge witnessed",
				"float->integer refused, a merge witnessed",
				"integer->numeric admitted",
				"integer->numeric refused, a merge witnessed",
				"numeric->numeric admitted",
				"numeric->numeric refused, a merge witnessed",
				"a value the cast refuses"
			])
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/physical/cast-injective",
						generator: (source) =>
							[source.draw(element(types)), source.draw(element(types))] as const,
						literal: Formatter.format,
						/** Every ordered pair of the types, each once. */
						limit: types.length * types.length,
						coverage: situations,
						caseHang: Duration.minutes(2)
					},
					([from, to], c) =>
						Effect.sync(() => {
							if (!castable(from.type, to.type)) {
								return
							}
							/** The source's values, distinct under its native equality, each with its image or the cast's refusal. */
							const values: Array<{
								readonly value: CarrierValue
								readonly image: CarrierValue | undefined
							}> = []
							for (const d of dictionary) {
								if (!castable(d.type, from.type)) {
									continue
								}
								const cast = castChain(d.literal, d.type, from.type, to.type)
								if (Result.isFailure(cast.source)) {
									continue
								}
								const value = cast.source.success
								if (Arr.some(values, (v) => equalValues(v.value, value, from.type))) {
									continue
								}
								if (Result.isFailure(cast.target) && cast.target.failure.kind === "unsupported") {
									throw new Error(
										`the evaluator cannot cast ${from.name} to ${to.name}: ${cast.target.failure.what}`
									)
								}
								if (Result.isFailure(cast.target)) {
									c.note("a value the cast refuses")
								}
								values.push({
									value,
									image: Result.isSuccess(cast.target) ? cast.target.success : undefined
								})
							}
							const merge = Arr.flatMap(values, (a, i) =>
								Arr.flatMap(values.slice(i + 1), (b) =>
									a.image !== undefined &&
									b.image !== undefined &&
									equalValues(a.image, b.image, to.type)
										? [[a.value, b.value] as const]
										: []
								)
							)
							const admitted = castInjective(from.type, to.type)
							const pairName = `${family(from.type)}->${family(to.type)}` as const
							if (admitted) {
								c.note(`${pairName} admitted`)
								const [witness] = merge
								if (witness !== undefined) {
									throw new Error(
										`castInjective admits ${from.name} -> ${to.name}, which merges ${Formatter.format(witness[0])} and ${Formatter.format(witness[1])}`
									)
								}
							} else if (decided(from.type, to.type)) {
								if (merge.length === 0) {
									throw new Error(
										`castInjective refuses ${from.name} -> ${to.name}, and no two values of the dictionary merge`
									)
								}
								c.note(`${pairName} refused, a merge witnessed`)
							}
						})
				)
			)
		}
	)
})
