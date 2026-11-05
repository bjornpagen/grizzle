import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { ParamId } from "#compiler/core/ids.ts"
import { describeOp, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import {
	firstOperand,
	type NativeFn,
	nativeOps,
	operandCarriers
} from "#compiler/scalar/compute/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type CatalogResult,
	evaluate,
	evaluationOf
} from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { types } from "#test/unit/codec/support.ts"
import { sink } from "#test/unit/compute/support.ts"
import { decimalGen } from "#test/unit/values/support.ts"

/**
 * IEEE 754 §5.4: +, −, ×, ÷, sqrt and conversions are correctly rounded; sign, abs, comparisons and min/max are exact.
 */
const ieeeExact: ReadonlySet<NativeFn> = new Set<NativeFn>([
	"add",
	"sub",
	"mul",
	"div",
	"sqrt",
	"neg",
	"abs",
	"sign",
	"eq",
	"ne",
	"lt",
	"le",
	"gt",
	"ge",
	"between",
	"in",
	"least",
	"greatest",
	"cast"
])

const isFloat = (c: Carrier): boolean => c === "float4" || c === "float8"

/**
 * The libm error model of numeric power's estimates (test/support/oracle/evaluate/power.ts), restated as this test's
 * oracle from the documented bounds: PostgreSQL's libm on Linux is glibc, whose manual ("Known Maximum Errors in Math
 * Functions") documents log and log10 to at most 9 units in the last place, its testsuite's limit; V8's Math.log and
 * Math.log10 are fdlibm's (ieee754.cc), documented to err by less than 1. So PostgreSQL's reading lies within 10 of
 * V8's. log10 of a power of ten binary64 holds is exact (fdlibm's e_log10.c guarantee, glibc's log10, and PostgreSQL
 * 19rc1 on macOS).
 */
const libmUlps = 10
const exactLog10: ReadonlySet<number> = new Set(Arr.makeBy(23, (k) => Number(10n ** BigInt(k))))

const ordinals = new DataView(new ArrayBuffer(8))

/** The double `n` representable values from x, toward +Infinity for a positive n. */
const ulpsAway = (x: number, n: number): number => {
	if (!Number.isFinite(x)) {
		return x
	}
	ordinals.setFloat64(0, x)
	const bits = ordinals.getBigUint64(0)
	const ordinal = (bits >> 63n === 0n ? bits : -(bits & 0x7fffffffffffffffn)) + BigInt(n)
	ordinals.setBigUint64(0, ordinal >= 0n ? ordinal : -ordinal | 0x8000000000000000n)
	return ordinals.getFloat64(0)
}

const platformLog = Math.log
const platformLog10 = Math.log10
const naturalLog = platformLog.bind(Math)
const commonLog = platformLog10.bind(Math)

/** `run` with the platform libm `n` units in the last place from V8's: an end of the error model for n = ±libmUlps. */
const atLibmEnd = <A>(n: number, run: () => A): A => {
	Math.log = (x: number) => ulpsAway(naturalLog(x), n)
	Math.log10 = (x: number) => (exactLog10.has(x) ? commonLog(x) : ulpsAway(commonLog(x), n))
	try {
		return run()
	} finally {
		Math.log = platformLog
		Math.log10 = platformLog10
	}
}

/** The numeric power node (registry.ts), the one estimated node, partial where its domain is unproved. */
const numericPower = Option.getOrThrowWith(
	Arr.findFirst(nativeOps, (op) => op.fn === "power" && firstOperand(op.operands) === "numeric"),
	() => new Error("no numeric power node")
)
if (!numericPower.partial) {
	throw new Error("numeric power requires its domain")
}
const numericPowerId = numericPower.id

/** A power's operands, and whether the case is a planted decline. */
interface PowerCase {
	readonly base: Decimal
	readonly exponent: Decimal
	readonly planted: boolean
}

const drawnCaseGen: Gen<PowerCase> = (source) => ({
	base: source.draw(decimalGen),
	exponent: source.draw(decimalGen),
	planted: false
})

/**
 * A base whose leading digits' log10 lies within 9e-17 of 16, past a power of ten, at an integer exponent: a libm
 * within the model may read power_var_int's estimate on either side of an integer, and the result's display scale
 * turns on it, so the oracle declines.
 */
const plantedDeclineGen: Gen<PowerCase> = (source) => {
	const k = source.draw(int(1, 9))
	const e = source.draw(int(2, 9))
	return {
		base: succeeded(Decimal.fromString(`0.${Str.repeat(4 * k)("0")}9999999999999998`)),
		exponent: succeeded(Decimal.fromBigInt(BigInt(e))),
		planted: true
	}
}

const caseGen: Gen<PowerCase> = weighted([
	[5, drawnCaseGen],
	[1, plantedDeclineGen]
])

const baseParam = ParamId("base")
const exponentParam = ParamId("exponent")

/** numeric power over parameters holding the operands, evaluated as the oracle evaluates a row's expression. */
const evaluated = (c: PowerCase): CatalogResult => {
	const s = sink()
	const operand = (param: ParamId): ScalarExpr =>
		s.emit({
			kind: "param",
			param,
			role: "compare",
			args: [],
			type: types.numeric,
			nonNull: "codec"
		})
	const root = s.emit({
		kind: "op",
		op: numericPowerId,
		args: [operand(baseParam), operand(exponentParam)],
		type: types.numeric,
		nonNull: "strict",
		volatility: numericPower.volatility,
		proof: [
			{
				precondition: { kind: "powerDomain" },
				premises: [{ kind: "checked", operand: 0, by: "parameter" }]
			}
		]
	})
	return evaluate(root, {
		kind: "row",
		column: () => undefined,
		param: (id) => (id === baseParam ? c.base : id === exponentParam ? c.exponent : undefined),
		regexMember: patternMember
	})
}

const isDeclined = (r: CatalogResult): boolean =>
	r._tag === "Failure" && r.failure.kind === "declined"

/**
 * An outcome as it is compared: a value by its text, which carries a numeric's display scale, or a stop by its kind and
 * code.
 */
const outcome = (r: CatalogResult): string => {
	if (r._tag === "Success") {
		return r.success instanceof Decimal
			? `value ${r.success.toString()}`
			: `value ${Formatter.format(r.success)}`
	}
	const stop = r.failure
	switch (stop.kind) {
		case "undefined":
			return `undefined ${stop.what}`
		case "unsupported":
			return `unsupported ${stop.what}`
		case "declined":
			return `declined ${describeOp(stop.op)}`
	}
}

type PowerFeature = "outcome claimed at both ends" | "declined"

describe("the oracle's classes of evaluation", () => {
	it.effect(
		"claims numeric power's outcome only where both ends of the libm error model give it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/evaluation-power",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<PowerFeature>(["outcome claimed at both ends", "declined"], {
							cases: 300,
							sense: notesOnly
						}),
						kept: [],
						/**
						 * A drawn power's outcome is claimed at both ends in most of its cases; a planted decline is one case in six,
						 * about 50 of 300.
						 */
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(power, c) =>
						Effect.sync(() => {
							const result = evaluated(power)
							const at = describeOp(numericPower.id)
							if (power.planted) {
								assert.equal(outcome(result), `declined ${at}`)
							}
							assert.ok(
								result._tag === "Success" || result.failure.kind !== "unsupported",
								`${at}: ${outcome(result)}`
							)
							if (isDeclined(result)) {
								c.note("declined")
								return
							}
							/**
							 * A claimed outcome is every libm's within the model: at each end, the same, or declined where that end's
							 * own estimate leaves the model.
							 */
							const ends = Arr.map([-libmUlps, libmUlps], (n) =>
								atLibmEnd(n, () => evaluated(power))
							)
							for (const end of ends) {
								if (!isDeclined(end)) {
									assert.equal(outcome(end), outcome(result), `${at} at a libm end`)
								}
							}
							if (!Arr.some(ends, isDeclined)) {
								c.note("outcome claimed at both ends")
							}
						})
				)
			)
	)

	it.effect("evaluates exactly only the float operations IEEE 754 rounds correctly", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/compute/ieee-exact",
					generator: element(nonEmpty(nativeOps, "the registry's nodes")),
					literal: Formatter.format,
					/** The space is the registry's nodes, each once. */
					limit: nativeOps.length,
					coverage: requiredInSpace<"an exact float node">(["an exact float node"]),
					caseHang
				},
				(op, c) =>
					Effect.sync(() => {
						if (
							evaluationOf(op) !== "exact" ||
							!Arr.some([...operandCarriers(op.operands), op.result], isFloat)
						) {
							return
						}
						c.note("an exact float node")
						assert.ok(
							ieeeExact.has(op.fn),
							`${describeOp(op.id)} is evaluated exactly, but IEEE 754 rounds no ${op.fn}`
						)
					})
			)
		)
	)
})
