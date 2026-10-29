import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Order, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { type Carrier, typeLabel } from "#compiler/ir/scalar.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	allowedFailures,
	caseChunk,
	compareAnswers,
	type EvalCase,
	installEvaluator,
	runCases
} from "#test/pg/compute/support.ts"
import { assert } from "#test/support/assert.ts"
import { constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	testPg,
	plainRender,
	renderSql,
	spelled,
	type TestField,
	v
} from "#test/unit/compute/support.ts"
import { decimalText } from "#test/unit/values/support.ts"

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

const intEdges = (lo: bigint, hi: bigint): ReadonlyArray<bigint> => [
	lo,
	lo + 1n,
	-7n,
	-3n,
	-2n,
	-1n,
	0n,
	1n,
	2n,
	3n,
	5n,
	7n,
	10n,
	hi - 1n,
	hi,
	hi / 2n,
	lo / 2n
]

const numericEdges = [
	"0",
	"0.00",
	"1",
	"1.0",
	"1.00",
	"-1",
	"0.5",
	"-0.5",
	"1.5",
	"2.5",
	"-2.5",
	"3",
	"7",
	"0.001",
	"123.456",
	"-98765.4321",
	"1e20",
	"1e-20",
	"99999999999999999999.99",
	"2147483647.5",
	"-2147483648.5",
	"9223372036854775807",
	"9223372036854775808",
	"NaN",
	"Infinity",
	"-Infinity"
]

const floatEdges = [
	0,
	1,
	-1,
	0.5,
	-0.5,
	1.5,
	2.5,
	-2.5,
	3.5,
	2,
	3,
	7,
	0.1,
	1e308,
	-1e308,
	Number.MAX_VALUE,
	Number.MIN_VALUE,
	2.2250738585072014e-308,
	1e-300,
	1e300,
	123456789012344.5,
	2 ** 53,
	2 ** 63,
	-(2 ** 63),
	2147483647.5,
	-2147483648.5,
	32767.5,
	-32768.5,
	3.4028235677973366e38,
	1e39,
	1e-46,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY
]

const moneyEdges = [
	0n,
	1n,
	-1n,
	100n,
	12345n,
	-99999n,
	9223372036854775807n,
	-9223372036854775808n,
	4611686018427387904n
]

const limits: Readonly<Record<"int2" | "int4" | "int8", readonly [bigint, bigint]>> = {
	int2: [-32768n, 32767n],
	int4: [-2147483648n, 2147483647n],
	int8: [-(2n ** 63n), 2n ** 63n - 1n]
}

/**
 * The generated operands of one case, per type: a batch of up to 80 values (120 numerics), the sample each type drew
 * before the search, and the drawn start of the pseudo-random walk over a type's operand values (pick).
 */
interface Operands {
	readonly int2: ReadonlyArray<bigint>
	readonly int4: ReadonlyArray<bigint>
	readonly int8: ReadonlyArray<bigint>
	readonly numeric: ReadonlyArray<string>
	readonly float8: ReadonlyArray<number>
	readonly float4: ReadonlyArray<number>
	readonly money: ReadonlyArray<bigint>
	readonly walk: number
}

const batchOf = <A>(values: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	array(values, { min: 1, max })

const integerGen = (c: "int2" | "int4" | "int8"): Gen<bigint> => {
	const [lo, hi] = limits[c]
	return oneOf([bigint(-1000n, 1000n), bigint(lo, hi)])
}

const floatGen: Gen<number> = oneOf([
	double(-Number.MAX_VALUE, Number.MAX_VALUE),
	map(int(-100, 100), (x) => x / 4)
])

const operandsGen: Gen<Operands> = (source) => ({
	int2: source.draw(batchOf(integerGen("int2"), 80)),
	int4: source.draw(batchOf(integerGen("int4"), 80)),
	int8: source.draw(batchOf(integerGen("int8"), 80)),
	numeric: source.draw(batchOf(decimalText, 120)),
	float8: source.draw(batchOf(floatGen, 80)),
	float4: source.draw(batchOf(floatGen, 80)),
	money: source.draw(batchOf(bigint(-(10n ** 12n), 10n ** 12n), 80)),
	walk: source.draw(int(0, 2 ** 31 - 1))
})

/** Operand values of each type as LiteralDescs: edges first, then the case's generated operands. */
const operandValues = (c: Gate, operands: Operands): ReadonlyArray<LiteralDesc> => {
	switch (c) {
		case "int2":
		case "int4":
		case "int8": {
			const [lo, hi] = limits[c]
			const all = [...intEdges(lo, hi), ...operands[c]]
			return c === "int8" ? all : Arr.map(all, (x) => Number(x))
		}
		case "numeric":
			return Arr.map([...numericEdges, ...operands.numeric], (t) => Decimal.of(t))
		case "float8":
		case "float4": {
			const all = [...floatEdges, ...operands[c]]
			const finite = Arr.map(all, (x): LiteralDesc => {
				if (Number.isNaN(x)) {
					return { float: "NaN" }
				}
				if (x === Number.POSITIVE_INFINITY) {
					return { float: "Infinity" }
				}
				if (x === Number.NEGATIVE_INFINITY) {
					return { float: "-Infinity" }
				}
				return x === 0 ? 0 : x
			})
			return c === "float4"
				? Arr.map(
						Arr.filter(
							finite,
							(x) =>
								typeof x !== "number" ||
								(Number.isFinite(Math.fround(x)) && (Math.fround(x) !== 0 || x === 0))
						),
						(x) => (typeof x === "number" ? Math.fround(x) : x)
					)
				: finite
		}
		case "money":
			return Arr.map([...moneyEdges, ...operands.money], (m) => Money.of(m))
	}
}

/** The corner operands each binary operation meets pairwise. */
const cornerValues = (c: Gate): ReadonlyArray<LiteralDesc> => {
	switch (c) {
		case "int2":
		case "int4":
		case "int8": {
			const [lo, hi] = limits[c]
			const xs = [lo, lo + 1n, -2n, -1n, 0n, 1n, 2n, 3n, hi]
			return c === "int8" ? xs : Arr.map(xs, (x) => Number(x))
		}
		case "numeric":
			return Arr.map(
				["0", "1.00", "-1", "2.5", "-2.5", "0.001", "1e20", "NaN", "Infinity", "-Infinity"],
				(t) => Decimal.of(t)
			)
		case "float8":
			return [
				0,
				1,
				-1,
				2.5,
				1e308,
				-1e308,
				5e-324,
				{ float: "NaN" },
				{ float: "Infinity" },
				{ float: "-Infinity" }
			]
		case "float4":
			return [
				0,
				1,
				-1,
				2.5,
				3.4028234663852886e38,
				1.401298464324817e-45,
				{ float: "NaN" },
				{ float: "Infinity" }
			]
		case "money":
			return Arr.map([0n, 1n, -1n, 9223372036854775807n, -9223372036854775808n], (m) => Money.of(m))
	}
}

/** The element at `i`, which the caller's index arithmetic keeps in range. */
const at = <A>(xs: ReadonlyArray<A>, i: number): A => {
	const x = xs[i]
	if (x === undefined) {
		throw new Error(`no element at ${i} of ${xs.length}`)
	}
	return x
}

const pick = <A>(
	xs: ReadonlyArray<A>,
	n: number,
	walk: number
): ReadonlyArray<ReadonlyArray<A>> => {
	/** n tuples of a pseudo-random walk over xs from the drawn start. */
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
	readonly name: string
	readonly arity: 1 | 2 | 3
	readonly build: (
		terms: ReadonlyArray<ScalarTerm>,
		carrier: Gate
	) => {
		readonly expr: OpenExpr
	}
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
	numeric: [Decimal.nan, Decimal.infinity, Decimal.negativeInfinity, "0", "1.0", "-2.5", 3n],
	float8: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1, 2.5, 1e308],
	float4: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1, 2.5],
	money: [Money.of(0n), Money.of(100n), Money.of(-1n), Money.of(9223372036854775807n)]
}

const ops: ReadonlyArray<Op> = [
	{ name: "add", arity: 2, build: ([a, b]) => Compute.add(a, b), predicate: false },
	{ name: "sub", arity: 2, build: ([a, b]) => Compute.sub(a, b), predicate: false },
	{ name: "mul", arity: 2, build: ([a, b]) => Compute.mul(a, b), predicate: false },
	{ name: "div", arity: 2, build: ([a, b]) => Compute.div(a, b), predicate: false },
	{ name: "mod", arity: 2, build: ([a, b]) => Compute.mod(a, b), predicate: false },
	{ name: "neg", arity: 1, build: ([a]) => Compute.neg(a), predicate: false },
	{ name: "quot", arity: 2, build: ([a, b]) => Compute.quot(a, b), predicate: false },
	{ name: "rem", arity: 2, build: ([a, b]) => Compute.rem(a, b), predicate: false },
	{ name: "abs", arity: 1, build: ([a]) => Compute.abs(a), predicate: false },
	{ name: "sign", arity: 1, build: ([a]) => Compute.sign(a), predicate: false },
	{ name: "round", arity: 1, build: ([a]) => Compute.round(a), predicate: false },
	{ name: "round2", arity: 1, build: ([a]) => Compute.round(a, 2), predicate: false },
	{ name: "round-1", arity: 1, build: ([a]) => Compute.round(a, -1), predicate: false },
	{ name: "trunc", arity: 1, build: ([a]) => Compute.trunc(a), predicate: false },
	{ name: "trunc3", arity: 1, build: ([a]) => Compute.trunc(a, 3), predicate: false },
	{ name: "trunc-2", arity: 1, build: ([a]) => Compute.trunc(a, -2), predicate: false },
	{ name: "ceil", arity: 1, build: ([a]) => Compute.ceil(a), predicate: false },
	{ name: "floor", arity: 1, build: ([a]) => Compute.floor(a), predicate: false },
	{ name: "gcd", arity: 2, build: ([a, b]) => Compute.gcd(a, b), predicate: false },
	{ name: "lcm", arity: 2, build: ([a, b]) => Compute.lcm(a, b), predicate: false },
	{ name: "power", arity: 2, build: ([a, b]) => Compute.power(a, b), predicate: false },
	{ name: "sqrt", arity: 1, build: ([a]) => Compute.sqrt(a), predicate: false },
	{ name: "least", arity: 3, build: ([a, b, c]) => Compute.least(a, b, c), predicate: false },
	{ name: "greatest", arity: 3, build: ([a, b, c]) => Compute.greatest(a, b, c), predicate: false },
	{ name: "scale", arity: 1, build: ([a]) => Compute.scale(a), predicate: false },
	{ name: "minScale", arity: 1, build: ([a]) => Compute.minScale(a), predicate: false },
	{ name: "trimScale", arity: 1, build: ([a]) => Compute.trimScale(a), predicate: false },
	{ name: "eq", arity: 2, build: ([a, b]) => Compute.eq(a, b), predicate: true },
	{ name: "ne", arity: 2, build: ([a, b]) => Compute.ne(a, b), predicate: true },
	{ name: "lt", arity: 2, build: ([a, b]) => Compute.lt(a, b), predicate: true },
	{ name: "le", arity: 2, build: ([a, b]) => Compute.le(a, b), predicate: true },
	{ name: "gt", arity: 2, build: ([a, b]) => Compute.gt(a, b), predicate: true },
	{ name: "ge", arity: 2, build: ([a, b]) => Compute.ge(a, b), predicate: true },
	{ name: "between", arity: 3, build: ([a, b, c]) => Compute.between(a, b, c), predicate: true },
	{ name: "in", arity: 1, build: ([a], c) => Compute.in(a, inLists[c]), predicate: true },
	{
		name: "cond",
		arity: 3,
		build: ([a, b, c]) => Compute.cond(Compute.lt(a, b), b, c),
		predicate: false
	},
	{
		name: "and-or",
		arity: 3,
		build: ([a, b, c]) =>
			Compute.or(Compute.and(Compute.le(a, b), Compute.not(Compute.eq(b, c))), Compute.gt(c, a)),
		predicate: true
	}
]

const castTargets: ReadonlyArray<readonly [string, TestField]> = [
	["smallint", testPg.smallint],
	["integer", testPg.integer],
	["bigint", testPg.bigint],
	["numeric", testPg.numeric],
	["numeric(5,2)", testPg.numericOf(5, 2)],
	["numeric(3,-2)", testPg.numericOf(3, -2)],
	["real", testPg.real],
	["double precision", testPg.double],
	["money", testPg.money]
]

/** Whether `build` returns rather than throwing a CompileError; anything else thrown fails the test. */
const admitted = (build: () => unknown): boolean => catchCompileError(build).ok

let ord = 0

const makeCase = (
	label: string,
	expr: OpenExpr,
	bindings: Readonly<Record<string, LeafBinding>>,
	predicate: boolean
): EvalCase => {
	const lowered = lowerWith("query", spelled(expr), bindings, predicate, baseParams)
	if (!lowered.ok) {
		throw new Error(`${label}: ${String(lowered.error)}`)
	}
	const { root } = lowered.value
	const sql = renderSql(root.expr, plainRender)
	const money = root.actual.carrier === "money"
	return {
		ord: ord++,
		label,
		sql,
		valueSql: money ? `(${sql})::numeric` : sql,
		type: root.actual,
		host: evaluate(root.expr, constantEnv),
		allowed: allowedFailures(root.expr)
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

/** The (operation, carrier) pairs and casts the catalogue refuses, and the operations each carrier admits. */
const admission = () => {
	const refusedPairs: Array<string> = []
	const admittedPairs = new Set<string>()
	for (const c of gateCarriers) {
		const f = fields[c]
		const terms = [v("a", f), v("b", f), v("c", f)]
		for (const op of ops) {
			if (admitted(() => op.build(terms, c))) {
				admittedPairs.add(`${op.name}/${c}`)
			} else {
				refusedPairs.push(`${op.name}/${c}`)
			}
		}
		for (const [name, target] of castTargets) {
			if (!admitted(() => Compute.cast(terms[0], target))) {
				refusedPairs.push(`cast:${typeLabel(f.scalar)}->${name}`)
			}
		}
	}
	return { refusedPairs, admittedPairs }
}

/** Every admitted (operation, carrier) pair's cases over the edges and the case's generated operands. */
const buildCases = (operands: Operands): ReadonlyArray<EvalCase> => {
	const cases: Array<EvalCase> = []
	for (const c of gateCarriers) {
		const f = fields[c]
		const values = operandValues(c, operands)
		const terms = [v("a", f), v("b", f), v("c", f)]
		for (const op of ops) {
			if (!admitted(() => op.build(terms, c))) {
				continue
			}
			const expr = op.build(terms, c).expr
			const tuples = pick(
				values,
				op.arity === 1 ? Math.min(values.length * 2, 300) : 300,
				operands.walk ^ (op.name.length * 31 + c.length)
			)
			const unaries = op.arity === 1 ? Arr.map(values, (x) => [x, x, x]) : []
			/** Every pair of the corner values: the minimum over -1, a zero divisor, the infinities. */
			const corner = cornerValues(c)
			const pairs =
				op.arity === 1 ? [] : Arr.flatMap(corner, (x) => Arr.map(corner, (y) => [x, y, y]))
			for (const tuple of [...unaries, ...pairs, ...tuples]) {
				const bindings: Record<string, LeafBinding> = {
					a: { kind: "literal", type: f.scalar, value: at(tuple, 0) },
					b: { kind: "literal", type: f.scalar, value: at(tuple, 1) },
					c: { kind: "literal", type: f.scalar, value: at(tuple, 2) }
				}
				cases.push(makeCase(`${op.name}/${c}`, expr, bindings, op.predicate))
			}
		}
		for (const [name, target] of castTargets) {
			const label = `cast:${typeLabel(f.scalar)}->${name}`
			if (!admitted(() => Compute.cast(terms[0], target))) {
				continue
			}
			const expr = Compute.cast(terms[0], target).expr
			for (const x of values) {
				cases.push(
					makeCase(label, expr, { a: { kind: "literal", type: f.scalar, value: x } }, false)
				)
			}
		}
	}
	/** width_bucket over numeric operands and an integer count. */
	const numericValues = operandValues("numeric", operands)
	const counts = [-1, 0, 1, 3, 10, 2147483647]
	const wb = Compute.widthBucket(
		v("a", testPg.numeric),
		v("b", testPg.numeric),
		v("c", testPg.numeric),
		v("n", testPg.integer)
	).expr
	for (const [i, t] of pick(numericValues, 1200, operands.walk ^ 77).entries()) {
		cases.push(
			makeCase(
				"widthBucket/numeric",
				wb,
				{
					a: { kind: "literal", type: testPg.numeric.scalar, value: at(t, 0) },
					b: { kind: "literal", type: testPg.numeric.scalar, value: at(t, 1) },
					c: { kind: "literal", type: testPg.numeric.scalar, value: at(t, 2) },
					n: { kind: "literal", type: testPg.integer.scalar, value: at(counts, i % counts.length) }
				},
				false
			)
		)
	}
	for (let i = 0; i < 600; i++) {
		const lo = Decimal.of(BigInt(-(i % 17)))
		const hi = Decimal.of(`${(i % 13) + 1}.${i % 7}`)
		const x = at(numericValues, i % numericValues.length)
		cases.push(
			makeCase(
				"widthBucket/numeric",
				wb,
				{
					a: { kind: "literal", type: testPg.numeric.scalar, value: x },
					b: { kind: "literal", type: testPg.numeric.scalar, value: i % 2 === 0 ? lo : hi },
					c: { kind: "literal", type: testPg.numeric.scalar, value: i % 2 === 0 ? hi : lo },
					n: { kind: "literal", type: testPg.integer.scalar, value: (i % 9) + 1 }
				},
				false
			)
		)
	}
	return cases
}

const bind = (a: Decimal, b: Decimal): Record<string, LeafBinding> => ({
	a: { kind: "literal", type: testPg.numeric.scalar, value: a },
	b: { kind: "literal", type: testPg.numeric.scalar, value: b },
	c: { kind: "literal", type: testPg.numeric.scalar, value: b }
})

/**
 * Numeric operands at the format's limits: a 131072-digit integer part with a half to round, the largest
 * power of ten, and the smallest positive value; each meets every operation that can carry it past the limit.
 */
const limitCases = (): ReadonlyArray<EvalCase> => {
	const nines = Str.repeat(131072)("9")
	const extremes = Arr.map([`${nines}.5`, `-${nines}.5`, "1e131071", "1e-16383"], (t) =>
		Decimal.of(t)
	)
	const partners = Arr.map(["0.001", "2", "-0.5"], (t) => Decimal.of(t))
	const unary = ["round", "round2", "round-1", "trunc", "ceil", "floor", "sqrt", "neg", "abs"]
	const binary = ["add", "sub", "mul", "div", "quot", "mod", "rem", "power"]
	const terms = [v("a", testPg.numeric), v("b", testPg.numeric), v("c", testPg.numeric)]
	const out: Array<EvalCase> = []
	for (const op of ops) {
		if (!unary.includes(op.name) && !binary.includes(op.name)) {
			continue
		}
		const expr = op.build(terms, "numeric").expr
		for (const x of extremes) {
			if (unary.includes(op.name)) {
				out.push(makeCase(`${op.name}/numeric`, expr, bind(x, x), false))
				continue
			}
			for (const y of partners) {
				for (const [a, b] of [
					[x, y],
					[y, x]
				] as const) {
					out.push(makeCase(`${op.name}/numeric`, expr, bind(a, b), false))
				}
			}
		}
	}
	return out
}

/**
 * The typed failures every case meets over the edges: overflow, division by zero, out-of-range casts, and scale and
 * min_scale raising for NaN and the infinities rather than returning NULL.
 */
const failureKeys = [
	"add/int2:22003",
	"add/int4:22003",
	"add/int8:22003",
	"mul/int8:22003",
	"mul/float8:22003",
	"div/int4:22012",
	"div/numeric:22012",
	"div/float8:22012",
	"mod/int8:22012",
	"neg/int4:22003",
	"abs/int2:22003",
	"gcd/int2:22003",
	"sqrt/numeric:2201F",
	"sqrt/float8:2201F",
	"widthBucket/numeric:2201G",
	"cast:numeric->integer:0A000",
	"cast:numeric->smallint:22003",
	"cast:double precision->integer:22003",
	"cast:double precision->real:22003",
	"cast:bigint->integer:22003",
	"cast:numeric->numeric(5,2):22003",
	"scale/numeric:0A000",
	"minScale/numeric:0A000"
] as const

/**
 * The failures PostgreSQL raises for a node the host declines by design: float power's refusal, among its listed
 * failures.
 */
const declinedFailureKeys = ["power/float8:2201F"] as const

/** The typed failures numeric meets at its weight limit. */
const limitFailureKeys = [
	"add/numeric:22003",
	"mul/numeric:22003",
	"div/numeric:22003",
	"quot/numeric:22003",
	"round/numeric:22003",
	"round-1/numeric:22003",
	"ceil/numeric:22003",
	"floor/numeric:22003",
	"power/numeric:22003",
	"power/numeric:2201F"
] as const

/**
 * What a case reached: each typed failure the host agreed on, each failure of a node it declined by design, numeric
 * power agreeing on a value, and a node the host declined by design.
 */
type CatalogueFeature =
	| (typeof failureKeys)[number]
	| (typeof declinedFailureKeys)[number]
	| "power/numeric value"
	| "declined by the host"

layer(Substrate.layer)("the Compute catalogue against PostgreSQL 19", (it) => {
	it.effect(
		"agrees with PostgreSQL on the result type and value of every operation, and on every failure",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session, schema } = yield* Substrate
					const db = yield* session(ownerSession())
					const s = yield* schema(freshSchema)
					yield* installEvaluator(db, s)
					/** Every Compute operation over the five gate types is admitted where PostgreSQL defines it. */
					const { refusedPairs, admittedPairs } = admission()
					const gate: ReadonlyArray<Carrier> = ["int2", "int4", "int8", "numeric", "float8"]
					const exercised = (fn: string): ReadonlyArray<Carrier> =>
						Arr.filter(gate, (c) => admittedPairs.has(`${fn}/${c}`))
					assert.deepEqual(exercised("add"), gate)
					assert.deepEqual(exercised("div"), gate)
					assert.deepEqual(exercised("sign"), gate)
					assert.deepEqual(exercised("abs"), gate)
					assert.deepEqual(exercised("least"), gate)
					assert.deepEqual(exercised("eq"), gate)
					assert.deepEqual(exercised("in"), gate)
					assert.deepEqual(exercised("cond"), gate)
					assert.deepEqual(exercised("mod"), ["int2", "int4", "int8", "numeric"])
					assert.deepEqual(exercised("gcd"), ["int2", "int4", "int8", "numeric"])
					assert.deepEqual(exercised("power"), ["numeric", "float8"])
					assert.deepEqual(exercised("sqrt"), ["numeric", "float8"])
					assert.deepEqual(exercised("round"), ["numeric"])
					assert.deepEqual(exercised("scale"), ["numeric"])
					assert.deepEqual(
						Arr.sort(
							Arr.filter(refusedPairs, (p) => Arr.some(gate, (c) => Str.endsWith(`/${c}`)(p))),
							Order.String
						),
						Arr.sort(
							[
								...Arr.flatMap(["int2", "int4", "int8", "float8"], (c) => [
									`quot/${c}`,
									`rem/${c}`,
									`round/${c}`,
									`round2/${c}`,
									`round-1/${c}`,
									`trunc/${c}`,
									`trunc3/${c}`,
									`trunc-2/${c}`,
									`ceil/${c}`,
									`floor/${c}`,
									`scale/${c}`,
									`minScale/${c}`,
									`trimScale/${c}`
								]),
								...Arr.flatMap(["int2", "int4", "int8"], (c) => [`power/${c}`, `sqrt/${c}`]),
								"mod/float8",
								"gcd/float8",
								"lcm/float8"
							],
							Order.String
						)
					)
					/**
					 * At numeric's weight limit: every case agrees, overflow and numeric power's refusal met as typed failures.
					 */
					const limits = limitCases()
					const limitResult = compareAnswers(limits, yield* runCases(db, s, limits, 20))
					assert.deepEqual(limitResult.mismatches.slice(0, 10), [])
					assert.equal(limitResult.typedOnly, 0)
					assert.deepEqual(
						Arr.filter(limitFailureKeys, (key) => !limitResult.failures.has(key)),
						[],
						"the typed failures met at numeric's weight limit"
					)
					return yield* explore(
						{
							suite: "pg/compute/catalogue",
							draw: drawn(operandsGen),
							literal: Formatter.format,
							features: features<CatalogueFeature>([
								...failureKeys,
								...declinedFailureKeys,
								"power/numeric value",
								"declined by the host"
							]),
							kept: [],
							runs: 1,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						(operands, c) =>
							Effect.gen(function* () {
								const cases = buildCases(operands)
								const answers = yield* runCases(db, s, cases, caseChunk)
								assert.equal(answers.length, cases.length)
								const result = compareAnswers(cases, answers)
								assert.deepEqual(result.mismatches.slice(0, 10), [])
								assert.equal(result.typedOnly, 0)
								if (result.declined > 0) {
									c.note("declined by the host")
								}
								c.noteAll(Arr.filter(failureKeys, (key) => result.failures.has(key)))
								c.noteAll(
									Arr.filter(declinedFailureKeys, (key) => result.declinedFailures.has(key))
								)
								if (
									Arr.some(
										cases,
										(k, i) =>
											k.label === "power/numeric" &&
											k.host._tag === "Success" &&
											answers[i]?.kind === "value"
									)
								) {
									c.note("power/numeric value")
								}
							})
					)
				})
			)
	)
})
