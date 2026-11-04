import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Order, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError, PreconditionKind } from "#compiler/core/errors.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { type Carrier, typeLabel } from "#compiler/ir/scalar.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	caseChunk,
	compareAnswers,
	type EvalCase,
	installEvaluator,
	type PgAnswer,
	runCases
} from "#test/pg/compute/support.ts"
import { assert } from "#test/support/assert.ts"
import { constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { numericPaddings } from "#test/support/oracle/gen/domain.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql,
	spelled,
	type TestField,
	testPg,
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

const limits: Readonly<Record<"int2" | "int4" | "int8", readonly [bigint, bigint]>> = {
	int2: [-32768n, 32767n],
	int4: [-2147483648n, 2147483647n],
	int8: [-(2n ** 63n), 2n ** 63n - 1n]
}

/**
 * How a case spells an operand in SQL, which its value cannot tell: as it is; a finite numeric cast to numeric(1000, s)
 * and back to bare numeric, the value at display scale s past its least scale, which only a reading of the display
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

const intBoundaries = (lo: bigint, hi: bigint, asNumber: boolean): ReadonlyArray<Boundary> =>
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
 * The boundary classes of each carrier: its range's ends and their neighbours, zero and the units, and for numeric and
 * the floats NaN and the infinities, the largest and smallest magnitudes, and the halves an integer cast rounds. Every
 * (entry, class) pair is a situation the search must reach: an agreement on a value, or a refusal the operand's value
 * justifies.
 */
const boundaries: { readonly [C in Gate]: ReadonlyArray<Boundary> } = {
	int2: intBoundaries(-32768n, 32767n, true),
	int4: intBoundaries(-2147483648n, 2147483647n, true),
	int8: intBoundaries(-(2n ** 63n), 2n ** 63n - 1n, false),
	numeric: Arr.map(
		[
			["zero", "0"],
			["one", "1"],
			["minus one", "-1"],
			["half", "2.5"],
			["tiny", "1e-20"],
			["largest", `${Str.repeat(1000)("9")}`],
			["int4 half", "2147483647.5"],
			["int8 half", "9223372036854775807.5"],
			["NaN", "NaN"],
			["Infinity", "Infinity"],
			["-Infinity", "-Infinity"]
		] as const,
		([name, text]) => ({ name, value: Decimal.of(text) })
	),
	float8: [
		{ name: "zero", value: 0 },
		{ name: "one", value: 1 },
		{ name: "minus one", value: -1 },
		{ name: "half", value: 2.5 },
		{ name: "largest", value: Number.MAX_VALUE },
		{ name: "least", value: 5e-324 },
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

/** A boundary class as an operand: as it is, and a float's zero as -0 too. */
const boundaryOperands = (c: Gate): ReadonlyArray<Operand> => [
	...Arr.map(boundaries[c], (b) => plainOperand(b.value, b.name)),
	...(c === "float8" || c === "float4"
		? [{ value: 0, spelling: { kind: "negative zero" } as const, boundary: "-0" }]
		: [])
]

/** The display scale numeric(1000, s) holds at most, NUMERIC_MAX_SCALE. */
const maxPaddedScale = 1000

/** A numeric operand padded by `digits` fraction digits past its least scale; NaN and the infinities as they are. */
const numericOperand = (value: Decimal, digits: number, boundary: string): Operand => {
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
 * The generated operands of one case, per type: a batch of up to 80 values (120 numerics, each with its drawn padding),
 * the padding of each numeric boundary class, and the drawn start of the pseudo-random walk over a type's operand
 * values (pick).
 */
interface Operands {
	readonly int2: ReadonlyArray<bigint>
	readonly int4: ReadonlyArray<bigint>
	readonly int8: ReadonlyArray<bigint>
	readonly numeric: ReadonlyArray<readonly [string, number]>
	readonly numericBoundaryPaddings: ReadonlyArray<number>
	readonly float8: ReadonlyArray<FloatDraw>
	readonly float4: ReadonlyArray<FloatDraw>
	readonly money: ReadonlyArray<bigint>
	readonly walk: number
}

const batchOf = <A>(values: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	array(values, { min: 1, max })

const integerGen = (c: "int2" | "int4" | "int8"): Gen<bigint> => {
	const [lo, hi] = limits[c]
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

const operandsGen: Gen<Operands> = (source) => ({
	int2: source.draw(batchOf(integerGen("int2"), 80)),
	int4: source.draw(batchOf(integerGen("int4"), 80)),
	int8: source.draw(batchOf(integerGen("int8"), 80)),
	numeric: source.draw(batchOf((s) => [s.draw(decimalText), s.draw(paddingGen)] as const, 120)),
	numericBoundaryPaddings: source.draw(
		array(paddingGen, { min: boundaries.numeric.length, max: boundaries.numeric.length })
	),
	float8: source.draw(batchOf(floatGen, 80)),
	float4: source.draw(batchOf(floatGen, 80)),
	money: source.draw(batchOf(bigint(-(10n ** 12n), 10n ** 12n), 80)),
	walk: source.draw(int(0, 2 ** 31 - 1))
})

/** The element at `i`, which the caller's index arithmetic keeps in range. */
const at = <A>(xs: ReadonlyArray<A>, i: number): A => {
	const x = xs[i]
	if (x === undefined) {
		throw new Error(`no element at ${i} of ${xs.length}`)
	}
	return x
}

/** The boundary classes of a carrier, a numeric one each padded as drawn. */
const boundaryValues = (c: Gate, operands: Operands): ReadonlyArray<Operand> =>
	c === "numeric"
		? Arr.map(boundaries.numeric, (b, i) => {
				const value = b.value instanceof Decimal ? b.value : Decimal.zero
				return numericOperand(value, at(operands.numericBoundaryPaddings, i), b.name)
			})
		: boundaryOperands(c)

/** The operands of each type: its boundary classes, then the case's generated operands. */
const operandValues = (c: Gate, operands: Operands): ReadonlyArray<Operand> => {
	const drawnOperands = (): ReadonlyArray<Operand> => {
		switch (c) {
			case "int2":
			case "int4":
				return Arr.map(operands[c], (x) => plainOperand(Number(x), "drawn"))
			case "int8":
				return Arr.map(operands.int8, (x) => plainOperand(x, "drawn"))
			case "numeric":
				return Arr.map(operands.numeric, ([t, d]) => numericOperand(Decimal.of(t), d, "drawn"))
			case "float8":
				return Arr.map(operands.float8, floatOperand)
			case "float4":
				return Arr.flatMap(Arr.map(operands.float4, floatOperand), realOperand)
			case "money":
				return Arr.map(operands.money, (m) => plainOperand(Money.of(m), "drawn"))
		}
	}
	return [...boundaryValues(c, operands), ...drawnOperands()]
}

/** The term a case reads operand `name` through: the variable itself, padded, or negated. */
const spelledTerm = (name: string, f: TestField, operand: Operand): ScalarTerm => {
	const term = v(name, f)
	switch (operand.spelling.kind) {
		case "plain":
			return term
		case "padded":
			return Compute.cast(
				Compute.cast(term, testPg.numericOf(maxPaddedScale, operand.spelling.scale)),
				testPg.numeric
			)
		case "negative zero":
			return Compute.neg(term)
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
	type: f.scalar,
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
	readonly name: string
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
	numeric: [Decimal.nan, Decimal.infinity, Decimal.negativeInfinity, "0", "1.0", "-2.5", 3n],
	float8: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1, 2.5, 1e308],
	float4: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1, 2.5],
	money: [Money.of(0n), Money.of(100n), Money.of(-1n), Money.of(9223372036854775807n)]
}

/**
 * The catalogue's entries. Every operand is a literal, so each partial operation's precondition is decided at
 * compilation from the literals' own values and bounds: proved, and the case runs, or refused (PartialOperation), and
 * the refusal is judged against the operands' values. The chained entries put an exact integer or exact money in an
 * operand: a sum, a product or a quotient of an exact value, and its comparison and narrowing.
 */
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
	{ name: "minScale", arity: 1, build: ([a]) => Compute.minScale(a), predicate: false },
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
	},
	{
		name: "exact add",
		arity: 3,
		build: ([a, b, c]) => Compute.add(Compute.add(a, b), c),
		predicate: false
	},
	{
		name: "exact mul",
		arity: 3,
		build: ([a, b, c]) => Compute.mul(Compute.mul(a, b), c),
		predicate: false
	},
	{
		name: "exact div",
		arity: 3,
		build: ([a, b, c]) => Compute.div(Compute.mul(a, b), c),
		predicate: false
	},
	{
		name: "exact compare",
		arity: 3,
		build: ([a, b, c]) => Compute.lt(Compute.sub(a, b), c),
		predicate: true
	},
	{
		name: "guarded div",
		arity: 2,
		build: ([a, b]) =>
			Compute.when(Compute.nonzero(b), (d: ScalarTerm) => Compute.div(a, d), Compute.sub(a, a)),
		predicate: false
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

/** What one case of an entry is: a case PostgreSQL runs, or a refusal at compilation with its precondition. */
type Built =
	| { readonly kind: "case"; readonly evalCase: EvalCase }
	| { readonly kind: "refused"; readonly label: string; readonly precondition: PreconditionKind }

let ord = 0

/** The precondition a compilation refusal names, or a defect: a case refuses only for a partial operation. */
const refusalOf = (label: string, error: CompileError): PreconditionKind => {
	if (error.reason._tag !== "PartialOperation") {
		throw new Error(`${label}: ${error.message}`)
	}
	return error.reason.precondition
}

const makeCase = (
	label: string,
	expr: OpenExpr,
	bindings: Readonly<Record<string, LeafBinding>>,
	predicate: boolean
): Built => {
	const lowered = lowerWith("query", spelled(expr), bindings, predicate, baseParams)
	if (!lowered.ok) {
		return { kind: "refused", label, precondition: refusalOf(label, lowered.error) }
	}
	const { root } = lowered.value
	const sql = renderSql(root.expr, plainRender)
	const money = root.actual.carrier === "money"
	return {
		kind: "case",
		evalCase: {
			ord: ord++,
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

const operandNames = ["a", "b", "c"] as const

/** The entries an operand of carrier `c` meets: its admitted operations and casts, width_bucket's for numeric. */
const entriesOf = (c: Gate): ReadonlyArray<string> => {
	const f = fields[c]
	const terms = [v("a", f), v("b", f), v("c", f)]
	return [
		...Arr.map(
			Arr.filter(ops, (op) => admitted(() => op.build(terms, c))),
			(op) => `${op.name}/${c}`
		),
		...Arr.map(
			Arr.filter(castTargets, ([, target]) => admitted(() => Compute.cast(terms[0], target))),
			([name]) => `cast:${typeLabel(f.scalar)}->${name}`
		),
		...(c === "numeric" ? ["widthBucket/numeric"] : [])
	]
}

/** The entries the host declines for every value by design (a float's pow, evaluation "database"): no verdict. */
const declinedEntries: ReadonlySet<string> = new Set(["power/float8", "power/float4"])

/** An entry met at one of its carrier's boundary classes: `<entry> @ <class>`. */
type BoundarySituation = `${string} @ ${string}`

/** What a spelled operand reached: an entry that read a padded numeric or a float -0 and agreed on a value. */
type SpelledSituation = `padded ${string}` | `negative zero ${string}`

/** Every admitted entry at every boundary class of its carrier, but the entries the host declines by design. */
const boundarySituations: ReadonlyArray<BoundarySituation> = Arr.flatMap(gateCarriers, (c) =>
	Arr.flatMap(
		Arr.filter(entriesOf(c), (e) => !declinedEntries.has(e)),
		(e) =>
			Arr.map(
				[
					...Arr.map(boundaries[c], (b) => b.name),
					...(c === "float8" || c === "float4" ? ["-0"] : [])
				],
				(b): BoundarySituation => `${e} @ ${b}`
			)
	)
)

/** Every entry with a numeric operand, read padded, and every float entry, read at -0. */
const spelledSituations: ReadonlyArray<SpelledSituation> = [
	...Arr.map(entriesOf("numeric"), (e): SpelledSituation => `padded ${e}`),
	...Arr.map(
		Arr.filter([...entriesOf("float8"), ...entriesOf("float4")], (e) => !declinedEntries.has(e)),
		(e): SpelledSituation => `negative zero ${e}`
	)
]

/** A case, the spelling of the operands its expression reads, and their boundary classes. */
interface ReadCase {
	readonly built: Built
	readonly spelling: Spelling["kind"]
	readonly read: ReadonlyArray<Operand>
}

/** Whether an operand's value is zero, below zero, or not finite: what a refused precondition must rest on. */
const isZero = (x: LiteralDesc): boolean =>
	x === 0 ||
	x === 0n ||
	(x instanceof Decimal && x.isFinite() && x.parts.coefficient === 0n) ||
	(x instanceof Money && x.minorUnits === 0n)

const isNegative = (x: LiteralDesc): boolean =>
	(typeof x === "number" && x < 0) ||
	(typeof x === "bigint" && x < 0n) ||
	(x instanceof Decimal && x.isFinite() && x.parts.negative && x.parts.coefficient !== 0n) ||
	(x instanceof Decimal && x.parts.kind === "-infinity") ||
	(typeof x === "object" && "float" in x && x.float === "-Infinity")

const isSpecial = (x: LiteralDesc): boolean =>
	(x instanceof Decimal && !x.isFinite()) || (typeof x === "object" && "float" in x)

/**
 * Whether a refusal is the operands' values': a nonzero precondition over a zero operand, a nonnegative one over a
 * negative operand, a finite one over NaN or an infinity. The others rest on magnitudes compilation bounds (a
 * narrowing's range, a power's, a bucket's, a digit bound), whose refusals are the residues it decides from intervals.
 */
const justified = (precondition: PreconditionKind, read: ReadonlyArray<Operand>): boolean => {
	switch (precondition) {
		case "nonzero":
			return Arr.some(read, (o) => isZero(o.value))
		case "nonnegative":
			return Arr.some(read, (o) => isNegative(o.value))
		case "finite":
			return Arr.some(read, (o) => isSpecial(o.value))
		case "fits":
		case "contract":
		case "powerDomain":
		case "bucketDomain":
			return true
	}
}

/** The situations a run reached, from its cases and the answers to those PostgreSQL ran. */
const reached = (
	cases: ReadonlyArray<ReadCase>,
	agreed: ReadonlyMap<ReadCase, boolean>
): ReadonlyArray<BoundarySituation | SpelledSituation> =>
	Arr.flatMap(cases, (k): ReadonlyArray<BoundarySituation | SpelledSituation> => {
		const label = k.built.kind === "case" ? k.built.evalCase.label : k.built.label
		const ok =
			k.built.kind === "case" ? agreed.get(k) === true : justified(k.built.precondition, k.read)
		if (!ok) {
			return []
		}
		const atBoundary = Arr.map(k.read, (o): BoundarySituation => `${label} @ ${o.boundary}`)
		const spelledReach: ReadonlyArray<SpelledSituation> =
			k.built.kind !== "case"
				? []
				: k.spelling === "padded"
					? [`padded ${label}`]
					: k.spelling === "negative zero"
						? [`negative zero ${label}`]
						: []
		return [...atBoundary, ...spelledReach]
	})

/**
 * Every admitted entry's cases: each boundary class of its carrier at each operand position, every pair of boundary
 * classes for a binary entry, and a walk over the boundary and generated operands; each operand read through its
 * spelling's term.
 */
const buildCases = (operands: Operands): ReadonlyArray<ReadCase> => {
	const cases: Array<ReadCase> = []
	const add = (
		label: string,
		expr: OpenExpr,
		bindings: Readonly<Record<string, LeafBinding>>,
		predicate: boolean,
		read: ReadonlyArray<Operand>
	) => {
		cases.push({
			built: makeCase(label, expr, bindings, predicate),
			spelling: spellingOf(read),
			read
		})
	}
	for (const c of gateCarriers) {
		const f = fields[c]
		const values = operandValues(c, operands)
		const classes = boundaryValues(c, operands)
		const terms = [v("a", f), v("b", f), v("c", f)]
		for (const op of ops) {
			if (!admitted(() => op.build(terms, c))) {
				continue
			}
			const walk = pick(values, 200, operands.walk ^ (op.name.length * 31 + c.length))
			const atPositions = Arr.flatMap(Arr.range(0, op.arity - 1), (p) =>
				Arr.map(classes, (k, i) =>
					Arr.map([0, 1, 2], (q) => (q === p ? k : at(at(walk, i % walk.length), q)))
				)
			)
			const pairs =
				op.arity === 1 ? [] : Arr.flatMap(classes, (x) => Arr.map(classes, (y) => [x, y, y]))
			for (const tuple of [...atPositions, ...pairs, ...walk]) {
				const expr = op.build(
					Arr.map(operandNames, (name, k) => spelledTerm(name, f, at(tuple, k))),
					c
				).expr
				add(
					`${op.name}/${c}`,
					expr,
					{
						a: literalOf(f, at(tuple, 0)),
						b: literalOf(f, at(tuple, 1)),
						c: literalOf(f, at(tuple, 2))
					},
					op.predicate,
					tuple.slice(0, op.arity)
				)
			}
		}
		for (const [name, target] of castTargets) {
			const label = `cast:${typeLabel(f.scalar)}->${name}`
			if (!admitted(() => Compute.cast(terms[0], target))) {
				continue
			}
			for (const x of values) {
				add(
					label,
					Compute.cast(spelledTerm("a", f, x), target).expr,
					{ a: literalOf(f, x) },
					false,
					[x]
				)
			}
		}
	}
	const numeric = testPg.numeric
	const numericValues = operandValues("numeric", operands)
	const counts = [-1, 0, 1, 3, 10, 2147483647]
	const bucket = (a: Operand, b: Operand, c: Operand, n: number) =>
		add(
			"widthBucket/numeric",
			Compute.widthBucket(
				spelledTerm("a", numeric, a),
				spelledTerm("b", numeric, b),
				spelledTerm("c", numeric, c),
				v("n", testPg.integer)
			).expr,
			{
				a: literalOf(numeric, a),
				b: literalOf(numeric, b),
				c: literalOf(numeric, c),
				n: { kind: "literal", type: testPg.integer.scalar, value: n }
			},
			false,
			[a, b, c]
		)
	for (const [i, t] of pick(numericValues, 1200, operands.walk ^ 77).entries()) {
		bucket(at(t, 0), at(t, 1), at(t, 2), at(counts, i % counts.length))
	}
	for (const [i, k] of boundaryValues("numeric", operands).entries()) {
		const lo = plainOperand(Decimal.of(BigInt(-(i % 17))), "drawn")
		const hi = plainOperand(Decimal.of(`${(i % 13) + 1}.${i % 7}`), "drawn")
		bucket(k, lo, hi, (i % 9) + 1)
		bucket(lo, k, hi, (i % 9) + 1)
		bucket(lo, hi, k, (i % 9) + 1)
	}
	return cases
}

/**
 * What a case reached: each entry at each boundary class of its carrier, agreeing on a value or refused as the
 * operands' values justify; each entry over a padded numeric or a float -0, agreeing on a value; numeric power
 * agreeing on a value; and a node the host declined by design.
 */
type CatalogueFeature =
	| BoundarySituation
	| SpelledSituation
	| "power/numeric value"
	| "declined by the host"

layer(Substrate.layer)("the Compute catalogue against PostgreSQL 19", (it) => {
	it.effect(
		"agrees with PostgreSQL on the result type and value of every operation at every boundary, and refuses only what the values justify",
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
					assert.deepEqual(exercised("minScale"), ["numeric"])
					assert.deepEqual(exercised("exact add"), gate)
					assert.deepEqual(exercised("guarded div"), gate)
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
									`minScale/${c}`
								]),
								...Arr.flatMap(["int2", "int4", "int8"], (c) => [`power/${c}`, `sqrt/${c}`]),
								"mod/float8",
								"gcd/float8",
								"lcm/float8"
							],
							Order.String
						)
					)
					return yield* explore(
						{
							suite: "pg/compute/catalogue",
							draw: drawn(operandsGen),
							literal: Formatter.format,
							coverage: required<CatalogueFeature>(
								[
									"power/numeric value",
									"declined by the host",
									...boundarySituations,
									...spelledSituations
								],
								{ cases: 1, sense: notesOnly }
							),
							kept: [],
							runs: 1,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.minutes(2)
						},
						(operands, c) =>
							Effect.gen(function* () {
								const all = buildCases(operands)
								const ran = Arr.flatMap(all, (k) => (k.built.kind === "case" ? [k] : []))
								const cases = Arr.flatMap(ran, (k) =>
									k.built.kind === "case" ? [k.built.evalCase] : []
								)
								const answers: ReadonlyArray<PgAnswer> = yield* runCases(db, s, cases, caseChunk)
								assert.equal(answers.length, cases.length)
								const result = compareAnswers(cases, answers)
								assert.deepEqual(result.mismatches.slice(0, 10), [])
								assert.equal(result.typedOnly, 0)
								const unjustified = Arr.flatMap(all, (k) =>
									k.built.kind === "refused" && !justified(k.built.precondition, k.read)
										? [
												`${k.built.label} refused for ${k.built.precondition} at ${Arr.join(
													Arr.map(k.read, (o) => Formatter.format(o.value)),
													", "
												)}`
											]
										: []
								)
								assert.deepEqual(unjustified.slice(0, 10), [])
								const agreed = new Map(
									Arr.map(ran, (k, i) => [k, result.agreed[i] === true] as const)
								)
								if (result.declined > 0) {
									c.note("declined by the host")
								}
								c.noteAll(reached(all, agreed))
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
