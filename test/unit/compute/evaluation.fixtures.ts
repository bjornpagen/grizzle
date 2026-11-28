/** What the properties of evaluation.test.ts read: its spaces, models and helpers. */

import { type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, String as Str } from "effect"
import { ParamId } from "#compiler/core/ids.ts"
import { describeOp, type ScalarExpr } from "#compiler/ir/expr.ts"
import { firstOperand, nativeOps } from "#compiler/scalar/compute/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { succeeded } from "#test/support/assert.ts"
import { type CatalogResult, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { codecTypes } from "#test/support/unit/codec/support.ts"
import { sink } from "#test/support/unit/compute/support.ts"
import { decimalGen } from "#test/support/unit/values/support.ts"

/**
 * The libm error model of numeric power's estimates (test/support/oracle/evaluate/power.ts), restated as this test's
 * oracle from the documented bounds: PostgreSQL's libm on Linux is glibc, whose manual ("Known Maximum Errors in Math
 * Functions") documents log and log10 to at most 9 units in the last place, its testsuite's limit; V8's Math.log and
 * Math.log10 are fdlibm's (ieee754.cc), documented to err by less than 1. So PostgreSQL's reading lies within 10 of
 * V8's. log10 of a power of ten binary64 holds is exact (fdlibm's e_log10.c guarantee, glibc's log10, and PostgreSQL
 * 19.0 on cassowary's glibc 2.43, checked 2026-11-27).
 */
export const libmUlps = 10

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
export const atLibmEnd = <A>(n: number, run: () => A): A => {
	Math.log = (x: number) => ulpsAway(naturalLog(x), n)
	Math.log10 = (x: number) => (exactLog10.has(x) ? commonLog(x) : ulpsAway(commonLog(x), n))
	try {
		return run()
	} finally {
		Math.log = platformLog
		Math.log10 = platformLog10
	}
}

/**
 * The numeric power node (registry.ts), the one estimated node, partial where its domain is unproved: found among the
 * partial nodes alone, so a registry whose numeric power is total holds none.
 */
export const numericPower = Option.getOrThrowWith(
	Arr.findFirst(nativeOps, (op) =>
		op.partial && op.fn === "power" && firstOperand(op.operands) === "numeric"
			? Option.some(op)
			: Option.none()
	),
	() => new Error("no partial numeric power node: numeric power requires its domain")
)

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

export const caseGen: Gen<PowerCase> = weighted([
	[5, drawnCaseGen],
	[1, plantedDeclineGen]
])

const baseParam = ParamId("base")

const exponentParam = ParamId("exponent")

/** numeric power over parameters holding the operands, evaluated as the oracle evaluates a row's expression. */
export const evaluated = (c: PowerCase): CatalogResult => {
	const s = sink()
	const operand = (param: ParamId): ScalarExpr =>
		s.emit({
			kind: "param",
			param,
			role: "compare",
			args: [],
			type: codecTypes.numeric,
			nonNull: "codec"
		})
	const root = s.emit({
		kind: "op",
		op: numericPowerId,
		args: [operand(baseParam), operand(exponentParam)],
		type: codecTypes.numeric,
		nonNull: "strict",
		volatility: numericPower.volatility,
		proof: [
			{
				precondition: { kind: "powerDomain" },
				premises: [{ kind: "checked", operand: 0, by: "parameter" }]
			},
			{
				precondition: { kind: "powerRange" },
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

export const isDeclined = (r: CatalogResult): boolean =>
	r._tag === "Failure" && r.failure.kind === "declined"

/**
 * An outcome as it is compared: a value by its text, which carries a numeric's display scale, or a stop by its kind and
 * code.
 */
export const outcome = (r: CatalogResult): string => {
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

export type PowerFeature = "outcome claimed at both ends" | "declined"
