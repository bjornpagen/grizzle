/** What the properties of catalogue.test.ts read: its spaces, models and helpers. */

import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { bigint, double } from "@bjornpagen/testing/values"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError, PreconditionKind } from "#compiler/core/errors.ts"
import { integerRanges } from "#compiler/ir/carriers.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { numericTypmodOf, typeLabel } from "#compiler/ir/scalar.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Numeric, type FiniteDecimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { succeeded } from "#test/support/assert.ts"
import { constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { numericPaddings } from "#test/support/oracle/gen/domain.ts"
import type { EvalCase } from "#test/support/pg/compute/support.ts"
import { evaluatorTemplate } from "#test/support/pg/compute/support.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql,
	spelledExpr,
	type TestField,
	testPg,
	v
} from "#test/support/unit/compute/support.ts"
import { numericText } from "#test/support/unit/values/support.ts"
import { upTo } from "#test/support/up-to.ts"

type Gate = "int2" | "int4" | "int8" | "numeric" | "float8" | "float4" | "money"

const fields: { readonly [C in Gate]: TestField } = {
	int2: testPg.smallint,
	int4: testPg.integer,
	int8: testPg.bigint,
	numeric: testPg.numeric,
	float8: testPg.double,
	float4: testPg.real,
	money: testPg.money
}

/**
 * How a case spells an operand in SQL, which its value cannot tell: as it is; a finite numeric cast to numeric(1000, s)
 * and then its computeCore.numeric, the value at display scale s past its least scale, which only a reading of the display
 * scale sees; or a float zero as neg(0), -0 in PostgreSQL, which only a reading of the sign of zero sees.
 */
type Spelling =
	| { readonly kind: "plain" }
	| { readonly kind: "padded"; readonly scale: number }
	| { readonly kind: "negative zero" }

/** An operand of a case: its value, bound as a literal, how the case's expression spells it, and its class. */
interface Operand {
	readonly value: LiteralDesc
	readonly spelling: Spelling
	/** The boundary class the operand is of, or "drawn" for a generated operand. */
	readonly boundary: string
}

const plainOperand = (value: LiteralDesc, boundary: string): Operand => ({
	value,
	spelling: { kind: "plain" },
	boundary
})

/** One named value class of a carrier's boundary: a value whose neighbourhood an operation treats apart. */
interface Boundary {
	readonly name: string
	readonly value: LiteralDesc
}

const intBoundaries = (
	[lo, hi]: readonly [bigint, bigint],
	asNumber: boolean
): Arr.NonEmptyReadonlyArray<Boundary> =>
	Arr.map(
		[
			["min", lo],
			["min + 1", lo + 1n],
			["minus one", -1n],
			["zero", 0n],
			["one", 1n],
			["two", 2n],
			["max - 1", hi - 1n],
			["max", hi]
		] as const,
		([name, x]) => ({ name, value: asNumber ? Number(x) : x })
	)

/**
 * The boundary classes of each carrier: its range's ends and their neighbours, zero and the units, NaN, for the floats
 * the infinities too (no numeric field holds one), the largest and smallest magnitudes, a float's smallest of either
 * sign, whose products, quotients and narrowings round to a zero of their sign, and the halves an integer cast
 * rounds. Every (entry, class) pair is a situation the search must reach: an agreement on a value, or a refusal the
 * operand's value justifies.
 */
const boundaries: { readonly [C in Gate]: Arr.NonEmptyReadonlyArray<Boundary> } = {
	int2: intBoundaries(integerRanges.int2, true),
	int4: intBoundaries(integerRanges.int4, true),
	int8: intBoundaries(integerRanges.int8, false),
	numeric: Arr.map(
		[
			["zero", "0"],
			["one", "1"],
			["minus one", "-1"],
			["half", "2.5"],
			["tiny", "1e-20"],
			["largest", Str.repeat(980)("9")],
			["int4 half", "2147483647.5"],
			["int8 half", "9223372036854775807.5"],
			["NaN", "NaN"]
		] as const,
		([name, text]) => ({ name, value: Numeric.of(text) })
	),
	float8: [
		{ name: "zero", value: 0 },
		{ name: "one", value: 1 },
		{ name: "minus one", value: -1 },
		{ name: "half", value: 2.5 },
		{ name: "largest", value: Number.MAX_VALUE },
		{ name: "least", value: 5e-324 },
		{ name: "minus least", value: -5e-324 },
		{ name: "2^63", value: 2 ** 63 },
		{ name: "NaN", value: { float: "NaN" } },
		{ name: "Infinity", value: { float: "Infinity" } },
		{ name: "-Infinity", value: { float: "-Infinity" } }
	],
	float4: [
		{ name: "zero", value: 0 },
		{ name: "one", value: 1 },
		{ name: "minus one", value: -1 },
		{ name: "half", value: 2.5 },
		{ name: "largest", value: 3.4028234663852886e38 },
		{ name: "least", value: 1.401298464324817e-45 },
		{ name: "minus least", value: -1.401298464324817e-45 },
		{ name: "NaN", value: { float: "NaN" } },
		{ name: "Infinity", value: { float: "Infinity" } },
		{ name: "-Infinity", value: { float: "-Infinity" } }
	],
	money: Arr.map(
		[
			["zero", 0n],
			["one cent", 1n],
			["minus one cent", -1n],
			["max", 2n ** 63n - 1n],
			["min", -(2n ** 63n)]
		] as const,
		([name, minor]) => ({ name, value: Money.of(minor) })
	)
}

/** Whether a carrier is a float's, whose zero has a sign. */
const signedZero = (c: Gate): boolean => c === "float8" || c === "float4"

/** A boundary class as an operand: as it is, and a float's zero as -0 too. */
const boundaryOperands = (c: Gate): ReadonlyArray<Operand> => [
	...Arr.map(boundaries[c], (b) => plainOperand(b.value, b.name)),
	...(signedZero(c)
		? [{ value: 0, spelling: { kind: "negative zero" } as const, boundary: "-0" }]
		: [])
]

/** The names of a carrier's boundary classes, a float's -0 among them. */
const classNames = (c: Gate): Arr.NonEmptyReadonlyArray<string> =>
	Arr.appendAll(
		Arr.map(boundaries[c], (b) => b.name),
		signedZero(c) ? ["-0"] : []
	)

/** The display scale numeric(1000, s) holds at most, NUMERIC_MAX_SCALE. */
const maxPaddedScale = 1000

/**
 * A numeric operand as its numeric(1000, 20) slot holds it, `given` rounded to the slot's scale, so a drawn value
 * below half a unit of the slot's last place is the zero a refusal sees; padded by `digits` fraction digits past that
 * value's least scale; NaN as it is.
 */
const numericOperand = (given: Numeric, digits: number, boundary: string): Operand => {
	const value = succeeded(normalizeNumeric(given, numericTypmodOf(fields.numeric.scalar)))
	const p = value.parts
	if (digits === 0 || p.kind !== "finite") {
		return plainOperand(value, boundary)
	}
	const scale = p.minScale + digits
	if (scale > maxPaddedScale) {
		throw new Error(
			`a numeric operand of least scale ${p.minScale} padded past numeric's largest scale`
		)
	}
	return { value, spelling: { kind: "padded", scale }, boundary }
}

/** A drawn float operand: a value, or zero spelled -0. */
type FloatDraw = number | "-0"

const floatOperand = (x: FloatDraw): Operand => {
	if (x === "-0") {
		return { value: 0, spelling: { kind: "negative zero" }, boundary: "-0" }
	}
	if (Number.isNaN(x)) {
		return plainOperand({ float: "NaN" }, "drawn")
	}
	if (x === Number.POSITIVE_INFINITY) {
		return plainOperand({ float: "Infinity" }, "drawn")
	}
	if (x === Number.NEGATIVE_INFINITY) {
		return plainOperand({ float: "-Infinity" }, "drawn")
	}
	return plainOperand(x === 0 ? 0 : x, "drawn")
}

/** A float operand as a real holds it: rounded to binary32, or none where a real cannot hold the value. */
const realOperand = (o: Operand): ReadonlyArray<Operand> => {
	const x = o.value
	if (typeof x !== "number") {
		return [o]
	}
	const r = Math.fround(x)
	return Number.isFinite(r) && (r !== 0 || x === 0) ? [{ ...o, value: r }] : []
}

/**
 * The generated operands of a case, of its entry's carrier alone: a batch of up to 80 values (120 numerics, each with
 * its drawn padding), and for numeric the padding of each of its boundary classes.
 */
type Operands =
	| { readonly carrier: "int2" | "int4" | "int8" | "money"; readonly drawn: ReadonlyArray<bigint> }
	| {
			readonly carrier: "numeric"
			readonly drawn: ReadonlyArray<readonly [string, number]>
			readonly boundaryPaddings: ReadonlyArray<number>
	  }
	| { readonly carrier: "float8" | "float4"; readonly drawn: ReadonlyArray<FloatDraw> }

type NumericOperands = Extract<Operands, { readonly carrier: "numeric" }>

const batchOf = <A>(values: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	array(values, { min: 1, max })

const integerGen = (c: "int2" | "int4" | "int8"): Gen<bigint> => {
	const [lo, hi] = integerRanges[c]
	return oneOf([bigint(-1000n, 1000n), bigint(lo, hi)])
}

/** A float operand: any double, a quarter-integer, or zero spelled -0. */
const floatGen: Gen<FloatDraw> = weighted<FloatDraw>([
	[8, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[8, map(int(-100, 100), (x) => x / 4)],
	[1, constant<FloatDraw>("-0")]
])

/** The fraction digits a numeric operand is padded by past its least scale: none, or one of the paddings. */
const paddingGen: Gen<number> = element<number>([0, ...numericPaddings])

/** Numeric operands: a batch of drawn values, each with its padding, and the padding of each boundary class. */
const numericOperandsGen: Gen<NumericOperands> = (source) => ({
	carrier: "numeric",
	drawn: source.draw(batchOf((s) => [s.draw(numericText), s.draw(paddingGen)] as const, 120)),
	boundaryPaddings: source.draw(
		array(paddingGen, { min: boundaries.numeric.length, max: boundaries.numeric.length })
	)
})

/** The operands of a case of carrier `c`. */
const operandsGen = (c: Gate): Gen<Operands> => {
	switch (c) {
		case "int2":
		case "int4":
		case "int8":
			return map(batchOf(integerGen(c), 80), (drawn) => ({ carrier: c, drawn }))
		case "money":
			return map(batchOf(bigint(-(10n ** 12n), 10n ** 12n), 80), (drawn) => ({
				carrier: c,
				drawn
			}))
		case "numeric":
			return numericOperandsGen
		case "float8":
		case "float4":
			return map(batchOf(floatGen, 80), (drawn) => ({ carrier: c, drawn }))
	}
}

/** The drawn start of a case's pseudo-random walk over its operand values (pick). */
const walkGen: Gen<number> = int(0, 2 ** 31 - 1)

/** A digit, half the time a 9, which puts a scaled operand near the top of its digits. */
const nineBiased: Gen<string> = weighted([
	[1, constant("9")],
	[1, element(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"])]
])

/** A numeric's text whose least scale is one to six: integer digits, then fraction digits ending in a nonzero one. */
const fractionalText: Gen<string> = (source) => {
	const sign = source.draw(element(["", "-"]))
	const whole = source.draw(string(nineBiased, { min: 0, max: 6 }))
	const fraction = source.draw(string(nineBiased, { min: 0, max: 5 }))
	const last = source.draw(element(["1", "2", "3", "4", "5", "6", "7", "8", "9"]))
	return `${sign}0${whole}.${fraction}${last}`
}

/** A finite numeric's text one unit in its last place nearer zero. */
const unitNearerZero = (text: string): string => {
	const x = Numeric.of(text)
	if (!x.isFinite()) {
		throw new Error(`a fractional operand is finite, not ${text}`)
	}
	return succeeded(
		Numeric.fromParts(x.parts.negative, x.parts.coefficient - 1n, x.parts.minScale)
	).toString()
}

/**
 * Two fractional operands of lcm: drawn apart, or a unit in the last place apart, whose operands scaled to integers are
 * consecutive and so coprime: their lcm is their product, at the top of lcm's integer-digit bound.
 */
const fractionalPairGen: Gen<readonly [string, string]> = oneOf([
	(source) => [source.draw(fractionalText), source.draw(fractionalText)] as const,
	map(fractionalText, (x) => [x, unitNearerZero(x)] as const)
])

/** The element at `i`, which the caller's index arithmetic keeps in range. */
const at = <A>(xs: ReadonlyArray<A>, i: number): A => {
	const x = xs[i]
	if (x === undefined) {
		throw new Error(`no element at ${i} of ${xs.length}`)
	}
	return x
}

/** The boundary classes of the operands' carrier, a numeric one each padded as drawn. */
const boundaryValues = (operands: Operands): ReadonlyArray<Operand> =>
	operands.carrier === "numeric"
		? Arr.map(boundaries.numeric, (b, i) => {
				const value = b.value instanceof Numeric ? b.value : Numeric.zero
				return numericOperand(value, at(operands.boundaryPaddings, i), b.name)
			})
		: boundaryOperands(operands.carrier)

/** The operands of a case: its carrier's boundary classes, then its generated operands. */
const operandValues = (operands: Operands): ReadonlyArray<Operand> => {
	const drawnOperands = (): ReadonlyArray<Operand> => {
		switch (operands.carrier) {
			case "int2":
			case "int4":
				return Arr.map(operands.drawn, (x) => plainOperand(Number(x), "drawn"))
			case "int8":
				return Arr.map(operands.drawn, (x) => plainOperand(x, "drawn"))
			case "money":
				return Arr.map(operands.drawn, (m) => plainOperand(Money.of(m), "drawn"))
			case "numeric":
				return Arr.map(operands.drawn, ([t, d]) => numericOperand(Numeric.of(t), d, "drawn"))
			case "float8":
				return Arr.map(operands.drawn, floatOperand)
			case "float4":
				return Arr.flatMap(Arr.map(operands.drawn, floatOperand), realOperand)
		}
	}
	return [...boundaryValues(operands), ...drawnOperands()]
}

/** The term a case reads operand `name` through: the variable itself, padded, or negated. */
const spelledTerm = (name: string, f: TestField, operand: Operand): ScalarTerm => {
	const term = v(name, f)
	switch (operand.spelling.kind) {
		case "plain":
			return term
		case "padded":
			return computeCore.numeric(
				computeCore.cast(term, testPg.numericOf(maxPaddedScale, operand.spelling.scale))
			)
		case "negative zero":
			return computeCore.neg(term)
	}
}

/** The spelling a case's read operands show: the first spelled one's, or plain. */
const spellingOf = (read: ReadonlyArray<Operand>): Spelling["kind"] => {
	for (const o of read) {
		if (o.spelling.kind !== "plain") {
			return o.spelling.kind
		}
	}
	return "plain"
}

const literalOf = (f: TestField, operand: Operand): LeafBinding => ({
	kind: "literal",
	field: f,
	value: operand.value
})

/** n tuples of a pseudo-random walk over xs from the drawn start. */
const pick = <A>(
	xs: ReadonlyArray<A>,
	n: number,
	walk: number
): ReadonlyArray<ReadonlyArray<A>> => {
	const out: Array<Array<A>> = []
	let state = walk >>> 0
	const next = () => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0
		return state % xs.length
	}
	for (let i = 0; i < n; i++) {
		out.push([at(xs, next()), at(xs, next()), at(xs, next())])
	}
	return out
}

interface Op {
	readonly arity: 1 | 2 | 3
	readonly build: (terms: ReadonlyArray<ScalarTerm>, carrier: Gate) => { readonly expr: OpenExpr }
	readonly predicate: boolean
}

/**
 * The literal lists `in` meets, per carrier: NaN, the infinities, zeros and display scales, which PostgreSQL's IN
 * compares by its total order (NaN IN (NaN) and 1.00 IN (1.0) are true, -0 IN (0) too).
 */
const inLists: { readonly [C in Gate]: ReadonlyArray<unknown> } = {
	int2: [0, 1, -1, 7, 32767, -32768],
	int4: [0, 1, -1, 7, 2147483647, -2147483648],
	int8: [0n, 1n, -1n, 7n, 9223372036854775807n, -9223372036854775808n],
	numeric: [Numeric.nan, Numeric.infinity, Numeric.negativeInfinity, "0", "1.0", "-2.5", 3n],
	float8: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1, 2.5, 1e308],
	float4: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1, 2.5],
	money: [Money.of(0n), Money.of(100n), Money.of(-1n), Money.of(9223372036854775807n)]
}

/**
 * The catalogue's operations, by name. Every operand is a literal, so each partial operation's precondition is decided
 * at compilation from the literals' own values and bounds: proved, and the case runs, or refused (PartialOperation),
 * and the refusal is judged against the operands' values. The chained entries put an exact integer or exact money in
 * an operand: a sum, a product or a quotient of an exact value, and its comparison and narrowing.
 */
const ops = {
	add: { arity: 2, build: ([a, b]) => computeCore.add(a, b), predicate: false },
	sub: { arity: 2, build: ([a, b]) => computeCore.sub(a, b), predicate: false },
	mul: { arity: 2, build: ([a, b]) => computeCore.mul(a, b), predicate: false },
	div: { arity: 2, build: ([a, b]) => computeCore.div(a, b), predicate: false },
	mod: { arity: 2, build: ([a, b]) => computeCore.mod(a, b), predicate: false },
	neg: { arity: 1, build: ([a]) => computeCore.neg(a), predicate: false },
	quot: { arity: 2, build: ([a, b]) => computeCore.quot(a, b), predicate: false },
	rem: { arity: 2, build: ([a, b]) => computeCore.rem(a, b), predicate: false },
	abs: { arity: 1, build: ([a]) => computeCore.abs(a), predicate: false },
	sign: { arity: 1, build: ([a]) => computeCore.sign(a), predicate: false },
	round: { arity: 1, build: ([a]) => computeCore.round(a), predicate: false },
	round2: { arity: 1, build: ([a]) => computeCore.round(a, 2), predicate: false },
	"round-1": { arity: 1, build: ([a]) => computeCore.round(a, -1), predicate: false },
	trunc: { arity: 1, build: ([a]) => computeCore.trunc(a), predicate: false },
	trunc3: { arity: 1, build: ([a]) => computeCore.trunc(a, 3), predicate: false },
	"trunc-2": { arity: 1, build: ([a]) => computeCore.trunc(a, -2), predicate: false },
	ceil: { arity: 1, build: ([a]) => computeCore.ceil(a), predicate: false },
	floor: { arity: 1, build: ([a]) => computeCore.floor(a), predicate: false },
	gcd: { arity: 2, build: ([a, b]) => computeCore.gcd(a, b), predicate: false },
	lcm: { arity: 2, build: ([a, b]) => computeCore.lcm(a, b), predicate: false },
	power: { arity: 2, build: ([a, b]) => computeCore.power(a, b), predicate: false },
	sqrt: { arity: 1, build: ([a]) => computeCore.sqrt(a), predicate: false },
	least: { arity: 3, build: ([a, b, c]) => computeCore.least(a, b, c), predicate: false },
	greatest: { arity: 3, build: ([a, b, c]) => computeCore.greatest(a, b, c), predicate: false },
	minScale: { arity: 1, build: ([a]) => computeCore.minScale(a), predicate: false },
	eq: { arity: 2, build: ([a, b]) => computeCore.eq(a, b), predicate: true },
	ne: { arity: 2, build: ([a, b]) => computeCore.ne(a, b), predicate: true },
	lt: { arity: 2, build: ([a, b]) => computeCore.lt(a, b), predicate: true },
	le: { arity: 2, build: ([a, b]) => computeCore.le(a, b), predicate: true },
	gt: { arity: 2, build: ([a, b]) => computeCore.gt(a, b), predicate: true },
	ge: { arity: 2, build: ([a, b]) => computeCore.ge(a, b), predicate: true },
	between: { arity: 3, build: ([a, b, c]) => computeCore.between(a, b, c), predicate: true },
	in: { arity: 1, build: ([a], c) => computeCore.in(a, inLists[c]), predicate: true },
	cond: {
		arity: 3,
		build: ([a, b, c]) => computeCore.cond(computeCore.lt(a, b), b, c),
		predicate: false
	},
	"and-or": {
		arity: 3,
		build: ([a, b, c]) =>
			computeCore.or([
				computeCore.and([computeCore.le(a, b), computeCore.not(computeCore.eq(b, c))]),
				computeCore.gt(c, a)
			]),
		predicate: true
	},
	"exact add": {
		arity: 3,
		build: ([a, b, c]) => computeCore.add(computeCore.add(a, b), c),
		predicate: false
	},
	"exact mul": {
		arity: 3,
		build: ([a, b, c]) => computeCore.mul(computeCore.mul(a, b), c),
		predicate: false
	},
	"exact div": {
		arity: 3,
		build: ([a, b, c]) => computeCore.div(computeCore.mul(a, b), c),
		predicate: false
	},
	"exact compare": {
		arity: 3,
		build: ([a, b, c]) => computeCore.lt(computeCore.sub(a, b), c),
		predicate: true
	},
	"guarded div": {
		arity: 2,
		build: ([a, b]) =>
			computeCore.when(
				computeCore.nonzero(b),
				(d: ScalarTerm) => computeCore.div(a, d),
				computeCore.sub(a, a)
			),
		predicate: false
	}
} as const satisfies { readonly [name: string]: Op }

type OpName = keyof typeof ops

/** The types a cast may target, by name. */
const castTargets = {
	smallint: testPg.smallint,
	integer: testPg.integer,
	bigint: testPg.bigint,
	numeric: testPg.numeric,
	"numeric(5,2)": testPg.numericOf(5, 2),
	"numeric(3,-2)": testPg.numericOf(3, -2),
	real: testPg.real,
	"double precision": testPg.double,
	money: testPg.money
} as const satisfies { readonly [name: string]: TestField }

type CastTarget = keyof typeof castTargets

/**
 * A case: one catalogue entry, with its operands. An operation at its operands' carrier, read at every boundary class
 * in every position, at every pair of classes and along a walk; a cast from its operands' carrier, of each operand;
 * numeric's width_bucket, along a walk and at every class in each operand position; and lcm over pairs of fractional
 * numerics.
 */
type CatalogueCase =
	| {
			readonly kind: "operation"
			readonly op: OpName
			readonly operands: Operands
			readonly walk: number
	  }
	| { readonly kind: "cast"; readonly target: CastTarget; readonly operands: Operands }
	| { readonly kind: "width bucket"; readonly operands: NumericOperands; readonly walk: number }
	| { readonly kind: "fractional lcm"; readonly pairs: ReadonlyArray<readonly [string, string]> }

const operationLabel = (op: OpName, c: Gate): string => `${op}/${c}`

const castLabel = (c: Gate, target: CastTarget): string =>
	`cast:${typeLabel(fields[c].scalar)}->${target}`

/** The label of a case's every expression: its operation, at its carrier. */
export const labelOf = (k: CatalogueCase): string => {
	switch (k.kind) {
		case "operation":
			return operationLabel(k.op, k.operands.carrier)
		case "cast":
			return castLabel(k.operands.carrier, k.target)
		case "width bucket":
			return "widthBucket/numeric"
		case "fractional lcm":
			return "lcm/numeric"
	}
}

/** Whether `build` returns rather than throwing a CompileError; anything else thrown fails the test. */
const admitted = (build: () => unknown): boolean => catchCompileError(build).ok

/** What one case of an entry is: a case PostgreSQL runs, or a refusal at compilation with its precondition. */
type Built =
	| { readonly kind: "case"; readonly evalCase: EvalCase }
	| { readonly kind: "refused"; readonly label: string; readonly precondition: PreconditionKind }

/** The precondition a compilation refusal names, or a defect: a case refuses only for a partial operation. */
const refusalOf = (label: string, error: CompileError): PreconditionKind => {
	if (error.reason._tag !== "PartialOperation") {
		throw new Error(`${label}: ${error.message}`)
	}
	return error.reason.precondition
}

/** The case `label` names, numbered `ord` among the cases of its build. */
const makeCase = (
	ord: number,
	label: string,
	expr: OpenExpr,
	bindings: Readonly<Record<string, LeafBinding>>,
	predicate: boolean
): Built => {
	const lowered = lowerWith("query", spelledExpr(expr), bindings, predicate, baseParams)
	if (!lowered.ok) {
		return { kind: "refused", label, precondition: refusalOf(label, lowered.error) }
	}
	const { root } = lowered.value
	const sql = renderSql(root.expr, plainRender)
	const money = root.actual.carrier === "money"
	return {
		kind: "case",
		evalCase: {
			ord,
			label,
			sql,
			valueSql: money ? `(${sql})::numeric` : sql,
			type: root.actual,
			host: evaluate(root.expr, constantEnv)
		}
	}
}

const gateCarriers: ReadonlyArray<Gate> = [
	"int2",
	"int4",
	"int8",
	"numeric",
	"float8",
	"float4",
	"money"
]

const operandNames = ["a", "b", "c"] as const

/** The entries the host declines for every value by design (a float's pow, evaluation "database"): no verdict. */
const declinedEntries: ReadonlySet<string> = new Set(["power/float8", "power/float4"])

/** An entry agreeing with PostgreSQL on a value. */
type ValueSituation = `${string} value`

/** An entry met at one of its carrier's boundary classes: `<entry> @ <class>`. */
type BoundarySituation = `${string} @ ${string}`

/** What a spelled operand reached: an entry that read a padded numeric or a float -0 and agreed on a value. */
type SpelledSituation = `padded ${string}` | `negative zero ${string}`

/** An entry the host declined by design, whose value PostgreSQL alone computed. */
type DeclinedSituation = `${string} declined by the host`

/**
 * What a case reached: its entry agreeing on a value, or declined by the host by design; its entry at each boundary
 * class of its carrier, agreeing on a value or refused as the operands' values justify; its entry over a padded numeric
 * or a float -0, agreeing on a value; and lcm over fractional numerics agreeing on a value with more integer digits
 * than its operands have together.
 */
export type CatalogueFeature =
	| ValueSituation
	| BoundarySituation
	| SpelledSituation
	| DeclinedSituation
	| "lcm/numeric past its operands' integer digits"

/** The spelled situations of an entry over operands of carrier `c`: a numeric read padded, a float read at -0. */
const spelledOf = (label: string, c: Gate): ReadonlyArray<SpelledSituation> => {
	switch (c) {
		case "numeric":
			return [`padded ${label}`]
		case "float8":
		case "float4":
			return [`negative zero ${label}`]
		case "int2":
		case "int4":
		case "int8":
		case "money":
			return []
	}
}

/**
 * The situations a case of the entry `label` over operands of carrier `c` must reach: declined by the host, for an
 * entry it declines by design; otherwise agreeing on a value, at each class of the carrier, and through each spelling.
 */
const situationsOf = (label: string, c: Gate): Arr.NonEmptyReadonlyArray<CatalogueFeature> =>
	declinedEntries.has(label)
		? [`${label} declined by the host`]
		: [
				`${label} value`,
				...Arr.map(classNames(c), (b): BoundarySituation => `${label} @ ${b}`),
				...spelledOf(label, c)
			]

/** A catalogue entry: the case a turn aimed at it draws, and every situation a case of it reaches. */
interface Entry {
	readonly gen: Gen<CatalogueCase>
	readonly situations: Arr.NonEmptyReadonlyArray<CatalogueFeature>
}

/** The admitted operations and casts of carrier `c`, each an entry. */
const carrierEntries = (c: Gate): ReadonlyArray<Entry> => {
	const terms = [v("a", fields[c]), v("b", fields[c]), v("c", fields[c])]
	return [
		...Arr.map(
			Arr.filter(Rec.keys(ops), (op) => admitted(() => ops[op].build(terms, c))),
			(op): Entry => ({
				gen: (source) => ({
					kind: "operation",
					op,
					operands: source.draw(operandsGen(c)),
					walk: source.draw(walkGen)
				}),
				situations: situationsOf(operationLabel(op, c), c)
			})
		),
		...Arr.map(
			Arr.filter(Rec.keys(castTargets), (target) =>
				admitted(() => computeCore.cast(terms[0], castTargets[target]))
			),
			(target): Entry => ({
				gen: (source) => ({ kind: "cast", target, operands: source.draw(operandsGen(c)) }),
				situations: situationsOf(castLabel(c, target), c)
			})
		)
	]
}

/**
 * The catalogue: each gate carrier's admitted operations and casts, numeric's width_bucket, and lcm over fractional
 * numerics, whose pairs no carrier's operands draw.
 */
export const catalogue: Arr.NonEmptyReadonlyArray<Entry> = Arr.appendAll(
	Arr.flatMap(gateCarriers, carrierEntries),
	[
		{
			gen: (source) => ({
				kind: "width bucket",
				operands: source.draw(numericOperandsGen),
				walk: source.draw(walkGen)
			}),
			situations: situationsOf("widthBucket/numeric", "numeric")
		},
		{
			gen: (source) => ({
				kind: "fractional lcm",
				pairs: source.draw(array(fractionalPairGen, { min: 8, max: 40 }))
			}),
			situations: ["lcm/numeric past its operands' integer digits"]
		}
	]
)

/**
 * Every entry's first situation, then the rest of each entry's. A window's cases aim at consecutive pending
 * situations, so in this order they aim at distinct entries, and one case of an entry reaches all its situations.
 */
export const situations: Arr.NonEmptyReadonlyArray<CatalogueFeature> = Arr.appendAll(
	Arr.map(catalogue, (e) => Arr.headNonEmpty(e.situations)),
	Arr.flatMap(catalogue, (e) => Arr.tailNonEmpty(e.situations))
)

/**
 * One case for each entry: the rotating stream's fresh sample, and the steered phase's budget past the floor's cases,
 * one aimed case reaching every situation of its entry.
 */
export const casePerEntry = catalogue.length

/** A case, the spelling of the operands its expression reads, and their boundary classes. */
interface ReadCase {
	readonly built: Built
	readonly spelling: Spelling["kind"]
	readonly read: ReadonlyArray<Operand>
}

/** One expression of a case before it is lowered: its bindings and the operands it reads. */
interface Formed {
	readonly expr: OpenExpr
	readonly bindings: Readonly<Record<string, LeafBinding>>
	readonly predicate: boolean
	readonly read: ReadonlyArray<Operand>
}

/**
 * The expressions of a case: for an operation, each boundary class of its carrier at each operand position, every pair
 * of classes for a binary one, and a walk over the classes and generated operands; for a cast, each operand; for
 * width_bucket, a walk and each class at each operand position; for fractional lcm, each pair. Each operand is read
 * through its spelling's term.
 */
const formsOf = (k: CatalogueCase): ReadonlyArray<Formed> => {
	switch (k.kind) {
		case "operation": {
			const op: Op = ops[k.op]
			const c = k.operands.carrier
			const f = fields[c]
			const values = operandValues(k.operands)
			const classes = boundaryValues(k.operands)
			const walk = pick(values, 200, k.walk)
			const atPositions = Arr.flatMap(
				upTo(op.arity, (i) => i),
				(p) =>
					Arr.map(classes, (x, i) =>
						Arr.map([0, 1, 2], (q) => (q === p ? x : at(at(walk, i % walk.length), q)))
					)
			)
			const pairs =
				op.arity === 1 ? [] : Arr.flatMap(classes, (x) => Arr.map(classes, (y) => [x, y, y]))
			return Arr.map([...atPositions, ...pairs, ...walk], (tuple) => ({
				expr: op.build(
					Arr.map(operandNames, (name, i) => spelledTerm(name, f, at(tuple, i))),
					c
				).expr,
				bindings: {
					a: literalOf(f, at(tuple, 0)),
					b: literalOf(f, at(tuple, 1)),
					c: literalOf(f, at(tuple, 2))
				},
				predicate: op.predicate,
				read: tuple.slice(0, op.arity)
			}))
		}
		case "cast": {
			const f = fields[k.operands.carrier]
			return Arr.map(operandValues(k.operands), (x) => ({
				expr: computeCore.cast(spelledTerm("a", f, x), castTargets[k.target]).expr,
				bindings: { a: literalOf(f, x) },
				predicate: false,
				read: [x]
			}))
		}
		case "width bucket": {
			const numeric = testPg.numeric
			const counts = [-1, 0, 1, 3, 10, 2147483647]
			const bucket = (a: Operand, b: Operand, c: Operand, n: number): Formed => ({
				expr: computeCore.widthBucket(
					spelledTerm("a", numeric, a),
					spelledTerm("b", numeric, b),
					spelledTerm("c", numeric, c),
					v("n", testPg.integer)
				).expr,
				bindings: {
					a: literalOf(numeric, a),
					b: literalOf(numeric, b),
					c: literalOf(numeric, c),
					n: { kind: "literal", field: testPg.integer, value: n }
				},
				predicate: false,
				read: [a, b, c]
			})
			const walked = Arr.map(pick(operandValues(k.operands), 1200, k.walk), (t, i) =>
				bucket(at(t, 0), at(t, 1), at(t, 2), at(counts, i % counts.length))
			)
			const atClasses = Arr.flatMap(boundaryValues(k.operands), (x, i) => {
				const lo = plainOperand(Numeric.of(BigInt(-(i % 17))), "drawn")
				const hi = plainOperand(Numeric.of(`${(i % 13) + 1}.${i % 7}`), "drawn")
				const n = (i % 9) + 1
				return [bucket(x, lo, hi, n), bucket(lo, x, hi, n), bucket(lo, hi, x, n)]
			})
			return [...walked, ...atClasses]
		}
		case "fractional lcm": {
			const numeric = testPg.numeric
			return Arr.map(k.pairs, ([x, y]) => {
				const a = plainOperand(Numeric.of(x), "drawn")
				const b = plainOperand(Numeric.of(y), "drawn")
				return {
					expr: computeCore.lcm(v("a", numeric), v("b", numeric)).expr,
					bindings: { a: literalOf(numeric, a), b: literalOf(numeric, b) },
					predicate: false,
					read: [a, b]
				}
			})
		}
	}
}

/** The cases of a case's expressions, each lowered, rendered and evaluated on the host, numbered in order. */
export const buildCases = (k: CatalogueCase): ReadonlyArray<ReadCase> => {
	const label = labelOf(k)
	return Arr.map(formsOf(k), (form, ord) => ({
		built: makeCase(ord, label, form.expr, form.bindings, form.predicate),
		spelling: spellingOf(form.read),
		read: form.read
	}))
}

/** Whether an operand's value is zero, below zero, or not finite: what a refused precondition must rest on. */
const isZero = (x: LiteralDesc): boolean =>
	x === 0 ||
	x === 0n ||
	(x instanceof Numeric && x.isFinite() && x.parts.coefficient === 0n) ||
	(x instanceof Money && x.minorUnits === 0n)

const isNegative = (x: LiteralDesc): boolean =>
	(typeof x === "number" && x < 0) ||
	(typeof x === "bigint" && x < 0n) ||
	(x instanceof Numeric && x.isFinite() && x.parts.negative && x.parts.coefficient !== 0n) ||
	(x instanceof Numeric && x.parts.kind === "-infinity") ||
	(typeof x === "object" && "float" in x && x.float === "-Infinity")

const isSpecial = (x: LiteralDesc): boolean =>
	(x instanceof Numeric && !x.isFinite()) || (typeof x === "object" && "float" in x)

/**
 * Whether a refusal is the operands' values': a nonzero precondition over a zero operand, a nonnegative one over a
 * negative operand, a finite one over NaN or an infinity. The others rest on magnitudes compilation bounds (a
 * narrowing's range, a power's, a bucket's, a digit bound, a scale), whose refusals are the residues it decides from
 * intervals.
 */
export const justified = (
	precondition: PreconditionKind,
	read: ReadonlyArray<Operand>
): boolean => {
	switch (precondition) {
		case "nonzero":
			return Arr.some(read, (o) => isZero(o.value))
		case "nonnegative":
			return Arr.some(read, (o) => isNegative(o.value))
		case "finite":
			return Arr.some(read, (o) => isSpecial(o.value))
		case "integral":
		case "fits":
		case "domain":
		case "language":
		case "powerDomain":
		case "powerRange":
		case "bucketDomain":
		case "lexical":
		case "bounded":
		case "clock":
			return true
	}
}

/**
 * The situations a case reached, from its expressions and the answers to those PostgreSQL ran: its entry agreeing on a
 * value, and at the class and through the spelling of each operand an agreeing or justly refused expression read.
 */
export const reached = (
	cases: ReadonlyArray<ReadCase>,
	agreed: ReadonlyMap<ReadCase, boolean>
): ReadonlyArray<CatalogueFeature> =>
	Arr.flatMap(cases, (k): ReadonlyArray<CatalogueFeature> => {
		const label = k.built.kind === "case" ? k.built.evalCase.label : k.built.label
		const ok =
			k.built.kind === "case" ? agreed.get(k) === true : justified(k.built.precondition, k.read)
		if (!ok) {
			return []
		}
		const atBoundary = Arr.map(k.read, (o): BoundarySituation => `${label} @ ${o.boundary}`)
		const valueReach: ReadonlyArray<CatalogueFeature> =
			k.built.kind !== "case"
				? []
				: k.spelling === "padded"
					? [`${label} value`, `padded ${label}`]
					: k.spelling === "negative zero"
						? [`${label} value`, `negative zero ${label}`]
						: [`${label} value`]
		return [...atBoundary, ...valueReach]
	})

/** The integer digits of a finite numeric: the least d with |x| < 10^d. */
const integerDigits = (x: FiniteDecimal): number => {
	const whole = x.parts.coefficient / 10n ** BigInt(x.parts.minScale)
	return whole === 0n ? 0 : Str.length(whole.toString())
}

/** The finite numerics among a case's operands. */
const finiteDecimals = (read: ReadonlyArray<Operand>): ReadonlyArray<FiniteDecimal> =>
	Arr.flatMap(read, (o) => (o.value instanceof Numeric && o.value.isFinite() ? [o.value] : []))

/**
 * Whether a case is lcm over two finite numerics read plain, agreeing on a value with more integer digits than its
 * operands have together: the share of lcm's integer-digit bound its operands' fraction digits make.
 */
export const lcmPastOperandDigits = (k: ReadCase, agreed: boolean): boolean => {
	if (!agreed || k.built.kind !== "case" || k.spelling !== "plain") {
		return false
	}
	const { label, host } = k.built.evalCase
	const read = finiteDecimals(k.read)
	return (
		label === "lcm/numeric" &&
		read.length === 2 &&
		host._tag === "Success" &&
		host.success instanceof Numeric &&
		host.success.isFinite() &&
		integerDigits(host.success) > Arr.reduce(read, 0, (n, x) => n + integerDigits(x))
	)
}

/** The evaluator's schema each case's transaction evaluates over (compute/support.ts evaluatorTemplate). */
export const catalogueEvaluator = evaluatorTemplate(import.meta, "catalogue evaluator")
