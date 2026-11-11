import { Array as Arr, Data, Option, Result, String as Str } from "effect"
import { indices, maxOf } from "#compiler/core/array.ts"
import { type Limit, measured } from "#compiler/core/limits.ts"
import { numericMaxIntegerDigits } from "#compiler/ir/carriers.ts"
import { Decimal, type DecimalParts, type FiniteParts } from "#compiler/scalar/values/decimal.ts"
import { assert, defined } from "#test/support/assert.ts"
import { isqrt } from "#test/support/oracle/evaluate/numeric.ts"

/** numeric.c's constants for NBASE 10000. */
const NBASE = 10000
const DEC_DIGITS = 4
const NBASE_SQR = 100000000
const MUL_GUARD_DIGITS = 2
const DIV_GUARD_DIGITS = 4
const NUMERIC_MIN_SIG_DIGITS = 16
const NUMERIC_MIN_DISPLAY_SCALE = 0
const NUMERIC_MAX_DISPLAY_SCALE = 1000
const NUMERIC_MAX_RESULT_SCALE = 2000
const PG_INT32_MIN = -2147483648
const PG_INT32_MAX = 2147483647
const PG_INT64_MIN = -(2n ** 63n)
const PG_INT64_MAX = 2n ** 63n - 1n
const NBASE_SQR_N = BigInt(NBASE_SQR)
/**
 * numeric.c's literal for log10(e) in its estimates, read from its own spelling: it is not Math.LOG10E, and the
 * estimates must round exactly as PostgreSQL's do.
 */
const LOG10_E = Number.parseFloat("0.434294481903252")
/** numeric.c's literal for ln(10) in its estimates, which is Math.LN10 bit for bit. */
const LN_10 = Math.LN10
const LOG10_2 = 0.301029995663981
/** div_var's normalization threshold: (PG_INT64_MAX - PG_INT64_MAX / NBASE^2 - 1) / (NBASE^2 - 1), below 2^53. */
const DIV_NORMALIZE_LIMIT = Number(
	(PG_INT64_MAX - PG_INT64_MAX / NBASE_SQR_N - 1n) / (NBASE_SQR_N - 1n)
)

/** The SQLSTATEs numeric power fails with: overflow, division by zero, and an invalid argument for power. */
type PowerFailureCode = "22003" | "22012" | "2201F"

/**
 * Why numeric power yields no value: PostgreSQL's failure, or a result that hangs on a libm estimate (libmEstimate) in a
 * way the host cannot pin down, which PostgreSQL alone computes.
 */
type PowerStopReason =
	| { readonly kind: "failure"; readonly code: PowerFailureCode }
	| { readonly kind: "libm"; readonly what: string }

/** A stop inside the port, thrown and caught at the boundary (power) by caught. */
class PowerStop extends Data.TaggedError("PowerStop")<{ readonly reason: PowerStopReason }> {}

/** Runs `f`, turning a thrown PowerStop into a failure with its reason; any other throw is a defect and propagates. */
const caught = <A>(f: () => A): Result.Result<A, PowerStopReason> => {
	try {
		return Result.succeed(f())
	} catch (thrown) {
		if (thrown instanceof PowerStop) {
			return Result.fail(thrown.reason)
		}
		throw thrown
	}
}

const fail = (code: PowerFailureCode): never => {
	throw new PowerStop({ reason: { kind: "failure", code } })
}

const failed = (code: PowerFailureCode): Result.Result<never, PowerStopReason> =>
	Result.fail({ kind: "failure", code })

/**
 * The error model of the libm estimates: the separation, in representable doubles, between PostgreSQL's libm result and
 * the port's. numeric.c calls the platform libm's log and log10; the port calls V8's, which are fdlibm's. The bound is
 * the documented one, never a measurement:
 * - the GNU C Library manual, "Errors in Math Functions", holds glibc's functions to its testsuite, which "only flags
 *   results larger than 9ulp" (production runs PostgreSQL on Linux glibc);
 * - fdlibm's e_log.c and e_log10.c, which V8's ieee754 log and log10 port, state an error below one ulp.
 * So the two lie within 9 + 1 = 10 representable doubles of each other. (Apple's libm documents no bound; the largest
 * errors measured anywhere are under 2 ulps.) A wider band declines more results, and never claims a wrong one.
 */
const libmUlps = 10

const ordinalView = new DataView(new ArrayBuffer(8))

/**
 * The double `n` representable values from x, toward +Infinity for a positive n: the IEEE encodings, read as one
 * ordered integer line through zero.
 */
const ulpsAway = (x: number, n: number): number => {
	ordinalView.setFloat64(0, x)
	const bits = ordinalView.getBigUint64(0)
	const ordinal = (bits >> 63n === 0n ? bits : -(bits & 0x7fffffffffffffffn)) + BigInt(n)
	ordinalView.setBigUint64(0, ordinal >= 0n ? ordinal : -ordinal | 0x8000000000000000n)
	return ordinalView.getFloat64(0)
}

/**
 * A libm-decided estimate: the port's own and the range PostgreSQL's lies in. numeric.c computes it from the libm
 * results by monotone IEEE operations, so the ends are the estimate computed from the libm results' extremes.
 */
interface Estimate {
	readonly lo: number
	readonly at: number
	readonly hi: number
}

const exactEstimate = (x: number): Estimate => ({ lo: x, at: x, hi: x })

/**
 * What a computation reads of an estimate: its truncation and whether it is an integer, which together decide every
 * comparison of it with a nonzero integer. trunc maps both signs of a value in (-1, 1) to zero, so no comparison with
 * zero is among them: power_var_int compares its estimate only with numericMaxIntegerDigits (numeric.c's
 * (NUMERIC_WEIGHT_MAX + 1) * DEC_DIGITS) and -1001, and power_var reads its weight only through trunc.
 */
const sameReading = (a: number, b: number): boolean =>
	Math.trunc(a) === Math.trunc(b) && Number.isInteger(a) === Number.isInteger(b)

/**
 * Runs `k`, which reads an estimate only by its truncation and its comparisons with nonzero integers, on the port's estimate
 * when every estimate PostgreSQL's libm can give reads the same. Otherwise the range holds an integer m (and only one:
 * the range is far narrower than one), and the estimates read as one of three: below m, m, and above m. `k` runs on
 * each that the range holds, and the port claims the outcome only when they agree, a value at one display scale or one
 * failure; otherwise the result is not the host's to claim.
 */
const libmEstimate = (e: Estimate, what: string, k: (estimate: number) => NumVar): NumVar => {
	if (sameReading(e.lo, e.hi)) {
		return k(e.at)
	}
	const declined = (): never => {
		throw new PowerStop({ reason: { kind: "libm", what } })
	}
	if (e.hi - e.lo >= 1) {
		return declined()
	}
	const m = Math.ceil(e.lo)
	const [first, ...rest] = Arr.map([e.lo, ...(m <= e.hi ? [m] : []), e.hi], (x) =>
		caught(() => k(x))
	)
	if (first === undefined || Arr.some(rest, (other) => !sameOutcome(first, other))) {
		return declined()
	}
	if (Result.isSuccess(first)) {
		return first.success
	}
	throw new PowerStop({ reason: first.failure })
}

const sameOutcome = (
	a: Result.Result<NumVar, PowerStopReason>,
	b: Result.Result<NumVar, PowerStopReason>
): boolean => {
	if (Result.isSuccess(a)) {
		return (
			Result.isSuccess(b) &&
			a.success.dscale === b.success.dscale &&
			cmp(a.success, b.success) === 0
		)
	}
	return (
		Result.isFailure(b) &&
		a.failure.kind === "failure" &&
		b.failure.kind === "failure" &&
		a.failure.code === b.failure.code
	)
}

/**
 * The powers of ten binary64 holds exactly, 10^0..10^22: libm's log10 of one is exact, in V8 as in PostgreSQL (fdlibm's
 * e_log10.c, which V8 ports and glibc's log10 derives from, guarantees log10(10^n) = n; PostgreSQL 19rc1 on macOS returns all 23 exactly). A
 * leading-digits value can round to one (9999999999999999 is 10^16 in binary64), in PostgreSQL's arithmetic as in the
 * port's.
 */
const powersOfTen: ReadonlySet<number> = new Set(
	Arr.map(indices(23), (k) => Number(10n ** BigInt(k)))
)

/** C's integer division, which truncates toward zero. */
const cdiv = (a: number, b: number): number => Math.trunc(a / b)

const pow10 = (n: number): bigint => 10n ** BigInt(n)

/**
 * The work an evaluation does, counted as it goes: the base-NBASE digit operations of its multiplications, divisions
 * and square roots, which the power suite holds every generated power's evaluation within (powerWorkLimit). One
 * evaluation owns its meter and counts into it alone.
 */
interface Meter {
	work: number
}

/**
 * A NumericVar as numeric.c holds one: its sign, its base-NBASE digits from the most significant on, the weight of the
 * first (its power of NBASE), and the display scale each function sets as numeric.c sets it. The digits are stripped
 * (strip_var): no leading or trailing zero digit, zero being no digits at weight 0, not negative.
 */
interface NumVar {
	readonly neg: boolean
	readonly weight: number
	readonly digits: ReadonlyArray<number>
	readonly dscale: number
}

const HALF_NBASE = 5000

/** numeric.c's round_powers: the power of ten a rounding inside an NBASE digit keeps, by its decimal digits kept. */
const roundPowers: ReadonlyArray<number> = [0, 1000, 100, 10]

const zero = (dscale: number): NumVar => ({ neg: false, weight: 0, digits: [], dscale })
const isZero = (v: NumVar): boolean => v.digits.length === 0
const withScale = (v: NumVar, dscale: number): NumVar => ({ ...v, dscale })

/** strip_var: the value of `digits` from `weight` on, with its leading and trailing zero digits dropped. */
const strip = (neg: boolean, weight: number, digits: ArrayLike<number>, dscale: number): NumVar => {
	let first = 0
	while (first < digits.length && digits[first] === 0) {
		first++
	}
	let end = digits.length
	while (end > first && digits[end - 1] === 0) {
		end--
	}
	if (first === end) {
		return zero(dscale)
	}
	const kept: Array<number> = []
	for (let i = first; i < end; i++) {
		kept.push(digits[i] ?? 0)
	}
	return { neg, weight: weight - first, digits: kept, dscale }
}

/** numeric.c's constants: const_one, const_two, const_zero_point_nine and const_one_point_one. */
const ONE: NumVar = { neg: false, weight: 0, digits: [1], dscale: 0 }
const TWO: NumVar = { neg: false, weight: 0, digits: [2], dscale: 0 }
const ZERO_POINT_NINE: NumVar = { neg: false, weight: -1, digits: [9000], dscale: 1 }
const ONE_POINT_ONE: NumVar = { neg: false, weight: 0, digits: [1, 1000], dscale: 1 }

/** The weight of `v`'s last digit. */
const lastWeight = (v: NumVar): number => v.weight - v.digits.length + 1

/** cmp_abs. */
const cmpAbs = (a: NumVar, b: NumVar): -1 | 0 | 1 => {
	if (isZero(a) || isZero(b)) {
		return isZero(a) ? (isZero(b) ? 0 : -1) : 1
	}
	if (a.weight !== b.weight) {
		return a.weight > b.weight ? 1 : -1
	}
	const n = Math.max(a.digits.length, b.digits.length)
	for (let i = 0; i < n; i++) {
		const x = a.digits[i] ?? 0
		const y = b.digits[i] ?? 0
		if (x !== y) {
			return x > y ? 1 : -1
		}
	}
	return 0
}

/** cmp_var. */
const cmp = (a: NumVar, b: NumVar): -1 | 0 | 1 => {
	const sa = isZero(a) ? 0 : a.neg ? -1 : 1
	const sb = isZero(b) ? 0 : b.neg ? -1 : 1
	if (sa !== sb) {
		return sa > sb ? 1 : -1
	}
	const c = cmpAbs(a, b)
	return sa < 0 ? (c === 0 ? 0 : c > 0 ? -1 : 1) : c
}

/**
 * The digits of `v` placed from weight `high` down over `count` digits: zero outside its own, as the columns of an
 * addition read it.
 */
const placed = (v: NumVar, high: number, count: number): Float64Array => {
	const out = new Float64Array(count)
	const offset = high - v.weight
	for (let i = 0; i < v.digits.length; i++) {
		out[offset + i] = v.digits[i] ?? 0
	}
	return out
}

/** add_abs: |a| + |b|, exactly, as digits from the weight past both operands' first. */
const addAbs = (
	a: NumVar,
	b: NumVar
): { readonly weight: number; readonly digits: Float64Array } => {
	const high = Math.max(a.weight, b.weight) + 1
	const count = high - Math.min(lastWeight(a), lastWeight(b)) + 1
	const x = placed(a, high, count)
	const y = placed(b, high, count)
	const digits = new Float64Array(count)
	let carry = 0
	for (let i = count - 1; i >= 0; i--) {
		const sum = (x[i] ?? 0) + (y[i] ?? 0) + carry
		carry = sum >= NBASE ? 1 : 0
		digits[i] = sum - carry * NBASE
	}
	return { weight: high, digits }
}

/** sub_abs: |a| - |b| for |a| > |b|, exactly. */
const subAbs = (
	a: NumVar,
	b: NumVar
): { readonly weight: number; readonly digits: Float64Array } => {
	const high = a.weight
	const count = high - Math.min(lastWeight(a), lastWeight(b)) + 1
	const x = placed(a, high, count)
	const y = placed(b, high, count)
	const digits = new Float64Array(count)
	let borrow = 0
	for (let i = count - 1; i >= 0; i--) {
		const difference = (x[i] ?? 0) - (y[i] ?? 0) - borrow
		borrow = difference < 0 ? 1 : 0
		digits[i] = difference + borrow * NBASE
	}
	return { weight: high, digits }
}

/** add_var and sub_var: exact, at the larger display scale. */
const addSigned = (a: NumVar, bNeg: boolean, b: NumVar): NumVar => {
	const dscale = Math.max(a.dscale, b.dscale)
	if (isZero(b)) {
		return withScale(a, dscale)
	}
	if (isZero(a)) {
		return { ...b, neg: bNeg, dscale }
	}
	if (a.neg === bNeg) {
		const sum = addAbs(a, b)
		return strip(a.neg, sum.weight, sum.digits, dscale)
	}
	const order = cmpAbs(a, b)
	if (order === 0) {
		return zero(dscale)
	}
	const difference = order > 0 ? subAbs(a, b) : subAbs(b, a)
	return strip(order > 0 ? a.neg : bNeg, difference.weight, difference.digits, dscale)
}

const add = (a: NumVar, b: NumVar): NumVar => addSigned(a, b.neg, b)
const sub = (a: NumVar, b: NumVar): NumVar => addSigned(a, !b.neg, b)

/**
 * round_var: half away from zero at rscale fractional digits (rscale may be negative), judged by the first digit
 * dropped as numeric.c judges it; the display scale is rscale.
 */
const roundVar = (v: NumVar, rscale: number): NumVar => {
	const di = (v.weight + 1) * DEC_DIGITS + rscale
	if (di < 0) {
		return zero(rscale)
	}
	let ndigits = cdiv(di + DEC_DIGITS - 1, DEC_DIGITS)
	const within = di % DEC_DIGITS
	if (!(ndigits < v.digits.length || (ndigits === v.digits.length && within > 0))) {
		return withScale(v, rscale)
	}
	/** One spare digit before the first, for a carry out of it, as numeric.c's digit buffer keeps one. */
	const digits = [0, ...v.digits.slice(0, ndigits)]
	let carry = 0
	if (within === 0) {
		carry = (v.digits[ndigits] ?? 0) >= HALF_NBASE ? 1 : 0
	} else {
		const power = defined(roundPowers[within], "a rounding power of ten")
		const last = defined(digits[ndigits], "the last digit kept")
		const extra = last % power
		digits[ndigits] = last - extra
		if (extra >= power / 2) {
			const raised = last - extra + power
			carry = raised >= NBASE ? 1 : 0
			digits[ndigits] = raised - carry * NBASE
		}
		ndigits--
	}
	while (carry > 0) {
		const sum = defined(digits[ndigits], "a digit a carry reaches") + carry
		carry = sum >= NBASE ? 1 : 0
		digits[ndigits] = sum - carry * NBASE
		ndigits--
	}
	return strip(v.neg, v.weight + 1, digits, rscale)
}

/** trunc_var: toward zero at rscale fractional digits. */
const truncVar = (v: NumVar, rscale: number): NumVar => {
	const di = (v.weight + 1) * DEC_DIGITS + rscale
	if (di <= 0) {
		return zero(rscale)
	}
	const ndigits = cdiv(di + DEC_DIGITS - 1, DEC_DIGITS)
	if (ndigits > v.digits.length) {
		return withScale(v, rscale)
	}
	const digits = v.digits.slice(0, ndigits)
	const within = di % DEC_DIGITS
	if (within > 0) {
		const power = defined(roundPowers[within], "a rounding power of ten")
		const last = defined(digits[ndigits - 1], "the last digit kept")
		digits[ndigits - 1] = last - (last % power)
	}
	return strip(v.neg, v.weight, digits, rscale)
}

/** The weight of `v`, numeric.c's var->weight: 0 for zero. */
const weightOf = (v: NumVar): number => v.weight

/** Digit pair `i` of `v`, base NBASE^2, the last of an odd count shifted up: mul_var's and div_var's working digits. */
const pair = (v: NumVar, i: number): number =>
	defined(v.digits[2 * i], "the first digit of a pair") * NBASE + (v.digits[2 * i + 1] ?? 0)

/** The decimal text of `digits`, DEC_DIGITS characters a digit. */
const digitsText = (digits: ReadonlyArray<number>): string =>
	Arr.join(
		Arr.map(digits, (d) => Str.padStart(DEC_DIGITS, "0")(String(d))),
		""
	)

/** The value of `v`'s digits as one integer, its last digit the units: v / NBASE^(weight of its last digit). */
const integerOf = (v: NumVar): bigint => (isZero(v) ? 0n : BigInt(digitsText(v.digits)))

/** The NumVar of `units` · 10^exp10, stripped, at `dscale`. */
const ofUnits = (neg: boolean, units: bigint, exp10: number, dscale: number): NumVar => {
	if (units === 0n) {
		return zero(dscale)
	}
	const pad = ((exp10 % DEC_DIGITS) + DEC_DIGITS) % DEC_DIGITS
	const text = units.toString() + Str.repeat(pad)("0")
	const count = Math.ceil(text.length / DEC_DIGITS)
	const padded = Str.padStart(count * DEC_DIGITS, "0")(text)
	const digits = Arr.map(indices(count), (i) =>
		Number(Str.slice(i * DEC_DIGITS, (i + 1) * DEC_DIGITS)(padded))
	)
	return strip(neg, (exp10 - pad) / DEC_DIGITS + count - 1, digits, dscale)
}

/**
 * Columns of base-NBASE digits, `columns[i]` holding the digit of weight `weight - i` and carries yet to propagate,
 * every one an exact double: the stripped NumVar they sum to. Each column stays below 2^53, numeric.c's uint64 digit
 * pairs being at most NBASE^4 apiece and a column summing fewer of them than NBASE^2 halves.
 */
const fromColumns = (
	neg: boolean,
	weight: number,
	columns: Float64Array,
	dscale: number
): NumVar => {
	const digits = new Float64Array(columns.length)
	let carry = 0
	for (let i = columns.length - 1; i >= 0; i--) {
		const value = (columns[i] ?? 0) + carry
		carry = Math.floor(value / NBASE)
		digits[i] = value - carry * NBASE
	}
	assert.ok(carry === 0, "the columns' sum fits their digits")
	return strip(neg, weight, digits, dscale)
}

/**
 * The shorter operand's base-NBASE digits from which mul_var sums its digit-pair products as BigInt products
 * (pairTriangle) rather than over double columns: a measured crossover, where V8's BigInt multiplication, whose cost
 * grows slower than the columns' quadratic one, overtakes the column loop; both give the same integer.
 */
const bigintTriangleDigits: Limit = measured({
	value: 6000,
	owner: "grizzle's test oracle",
	unit: "base-10000 digits of mul_var's shorter operand",
	scope:
		"the numeric power oracle's mul_var (test/support/oracle/evaluate/power.ts), which of two exact ways it sums its digit-pair products",
	evidence:
		"a scratch run of both ways over two values of n decimal digits each, rscale n, the best of 5 to 15 runs each, on 2026-11-06",
	observed: "one run of each size, interleaved, at a load average near 60",
	environment:
		"macOS (Darwin 27.0.0, an arm64 virtual machine) on 10 cores, Node 26.13.0, under the load of the other sessions on the machine",
	workload:
		"products of 1,000, 2,000, 4,000, 8,000, 16,000 and 32,000 decimal digits, 250 to 8,000 base-10000 digits a side",
	result:
		"the column loop took 0.02, 0.09, 0.61, 1.05 and 4.87 ms up to 16,000 decimal digits, the BigInt triangle 0.10, 0.24, 0.67, 1.07 and 7.01 ms; at 32,000 the loop took 45.38 ms and the triangle 31.07 ms",
	decision:
		"6,000 base-10000 digits, 24,000 decimal digits, lies between the last size the loop won and the first the triangle won; either way costs the same integer, so the bound moves only time",
	revalidate:
		"a Node or V8 upgrade that changes BigInt multiplication, a change to either way of summing, or a power suite whose large products slow"
})

/**
 * The sum of the digit-pair products mul_var keeps, as one integer whose last digit pair is the result's last: pair i1
 * of var1 times pair i2 of var2 at result pair i1 + i2 + pairOffset, for every i2 below min(var2ndigitpairs,
 * resNdigitpairs - i1 - pairOffset). The pairs of var1 whose limit is all of var2's pairs sum as one product of
 * var1's leading pairs and var2; each later pair full + t meets var2's leading n0 - t pairs, a square triangle, summed
 * by splitting it in halves into one product each and two smaller triangles (square), down to 16 pairs, where it is
 * summed pair by pair. Every step is an exact integer identity, so the sum is the one the pair-by-pair loop forms.
 */
const pairTriangle = (
	var1: NumVar,
	var2: NumVar,
	var1ndigitpairs: number,
	var2ndigitpairs: number,
	resNdigitpairs: number,
	pairOffset: number
): bigint => {
	const text1 = digitsText(var1.digits)
	const text2 = digitsText(var2.digits)
	/** `count` digit pairs of a value's text from pair `from` as one integer, pairs past its last being zero. */
	const pairsOf = (text: string, from: number, count: number): bigint => {
		const start = 2 * DEC_DIGITS * from
		const end = 2 * DEC_DIGITS * (from + count)
		const kept = Str.slice(start, Math.min(end, text.length))(text)
		return count <= 0 ? 0n : BigInt(kept + Str.repeat(end - start - kept.length)("0"))
	}
	const ys = (from: number, count: number): bigint => pairsOf(text2, from, count)
	const as = (from: number, count: number): bigint => pairsOf(text1, from, count)
	const square = (aFrom: number, count: number, yFrom: number): bigint => {
		if (count <= 16) {
			let sum = 0n
			for (let t = 0; t < count; t++) {
				sum += BigInt(pair(var1, aFrom + t)) * ys(yFrom, count - t)
			}
			return sum
		}
		const h = count >> 1
		return (
			ys(yFrom, count - h) * as(aFrom, h) * NBASE_SQR_N +
			square(aFrom, h, yFrom + count - h) +
			square(aFrom + h, count - h, yFrom)
		)
	}
	const full = Math.min(
		var1ndigitpairs,
		Math.max(0, resNdigitpairs - pairOffset - var2ndigitpairs + 1)
	)
	let total = 0n
	if (full > 0) {
		const shift = resNdigitpairs - pairOffset - var2ndigitpairs - (full - 1)
		total = as(0, full) * ys(0, var2ndigitpairs) * NBASE_SQR_N ** BigInt(shift)
	}
	if (full < var1ndigitpairs) {
		const count = var1ndigitpairs - full
		const n0 = resNdigitpairs - full - pairOffset
		total += ys(0, n0 - count) * as(full, count) * NBASE_SQR_N + square(full, count, n0 - count)
	}
	return total
}

/**
 * mul_var: the product rounded to rscale fractional digits, as numeric.c forms it: the exact product through
 * mul_var_short when the shorter input has at most six digits and the exact scale is requested; otherwise the sum of
 * the digit-pair products whose position survives the maxdigits truncation (MUL_GUARD_DIGITS guard digits), each pair
 * product split over three base-NBASE columns, then rounded.
 */
const mulVar = (left: NumVar, right: NumVar, rscale: number, meter: Meter): NumVar => {
	const [var1, var2] = left.digits.length > right.digits.length ? [right, left] : [left, right]
	const var1ndigits = var1.digits.length
	const var2ndigits = var2.digits.length
	if (var1ndigits === 0) {
		return zero(rscale)
	}
	const resNeg = var1.neg !== var2.neg
	if (var1ndigits <= 6 && rscale === var1.dscale + var2.dscale) {
		const columns = new Float64Array(var1ndigits + var2ndigits)
		for (let i1 = 0; i1 < var1ndigits; i1++) {
			const x = var1.digits[i1] ?? 0
			for (let i2 = 0; i2 < var2ndigits; i2++) {
				columns[i1 + i2 + 1] = (columns[i1 + i2 + 1] ?? 0) + x * (var2.digits[i2] ?? 0)
			}
		}
		meter.work += var1ndigits * var2ndigits
		return fromColumns(resNeg, var1.weight + var2.weight + 1, columns, rscale)
	}
	let var1ndigitpairs = cdiv(var1ndigits + 1, 2)
	let var2ndigitpairs = cdiv(var2ndigits + 1, 2)
	const resNdigitsExact = var1ndigits + var2ndigits
	let resNdigitpairs = cdiv(resNdigitsExact, 2) + 1
	const pairOffset = resNdigitpairs - var1ndigitpairs - var2ndigitpairs + 1
	const resWeight =
		var1.weight +
		var2.weight +
		1 +
		2 * resNdigitpairs -
		resNdigitsExact -
		(var1ndigits & 1) -
		(var2ndigits & 1)
	const maxdigits = resWeight + 1 + cdiv(rscale + DEC_DIGITS - 1, DEC_DIGITS) + MUL_GUARD_DIGITS
	const maxdigitpairs = cdiv(maxdigits, 2) + 1
	resNdigitpairs = Math.min(resNdigitpairs, maxdigitpairs)
	if (resNdigitpairs <= pairOffset) {
		return zero(rscale)
	}
	var1ndigitpairs = Math.min(var1ndigitpairs, resNdigitpairs - pairOffset)
	var2ndigitpairs = Math.min(var2ndigitpairs, resNdigitpairs - pairOffset)
	for (let i1 = 0; i1 < var1ndigitpairs; i1++) {
		meter.work += Math.max(Math.min(var2ndigitpairs, resNdigitpairs - i1 - pairOffset), 0)
	}
	if (var1ndigits >= bigintTriangleDigits.value) {
		const triangle = pairTriangle(
			var1,
			var2,
			var1ndigitpairs,
			var2ndigitpairs,
			resNdigitpairs,
			pairOffset
		)
		const resNdigits = 2 * resNdigitpairs
		return roundVar(
			ofUnits(resNeg, triangle, DEC_DIGITS * (resWeight - resNdigits + 1), rscale),
			rscale
		)
	}
	/**
	 * Digit pair i1 of var1 times digit pair i2 of var2 adds to result pair i1 + i2 + pairOffset for i2 below
	 * min(var2ndigitpairs, resNdigitpairs - i1 - pairOffset). A pair (x0, x1) times a pair (y0, y1) is x0·y0 at the
	 * pair's high column less one, x0·y1 + x1·y0 at its high column and x1·y1 at its low one.
	 */
	const high2 = new Float64Array(var2ndigitpairs)
	const low2 = new Float64Array(var2ndigitpairs)
	for (let i = 0; i < var2ndigitpairs; i++) {
		high2[i] = var2.digits[2 * i] ?? 0
		low2[i] = var2.digits[2 * i + 1] ?? 0
	}
	const columns = new Float64Array(2 * resNdigitpairs)
	for (let i1 = 0; i1 < var1ndigitpairs; i1++) {
		const x0 = var1.digits[2 * i1] ?? 0
		const x1 = var1.digits[2 * i1 + 1] ?? 0
		const limit = Math.min(var2ndigitpairs, resNdigitpairs - i1 - pairOffset)
		let column = 2 * (i1 + pairOffset)
		for (let i2 = 0; i2 < limit; i2++, column += 2) {
			const y0 = high2[i2] ?? 0
			const y1 = low2[i2] ?? 0
			columns[column - 1] = (columns[column - 1] ?? 0) + x0 * y0
			columns[column] = (columns[column] ?? 0) + x0 * y1 + x1 * y0
			columns[column + 1] = (columns[column + 1] ?? 0) + x1 * y1
		}
	}
	return roundVar(fromColumns(resNeg, resWeight, columns, rscale), rscale)
}

/**
 * div_var_int: var / (ival · NBASE^ivalWeight) by short division, numeric.c's digits past the result's rscale digits
 * (one more where it rounds), then rounded or truncated. ival is an int32, so every carry, below ival · NBASE, is an
 * exact double.
 */
const divVarInt = (
	v: NumVar,
	ival: number,
	ivalWeight: number,
	rscale: number,
	round: boolean,
	meter: Meter
): NumVar => {
	if (ival === 0) {
		return fail("22012")
	}
	if (isZero(v)) {
		return zero(rscale)
	}
	const divisor = Math.abs(ival)
	const resWeight = v.weight - ivalWeight
	const resNdigits =
		Math.max(resWeight + 1 + cdiv(rscale + DEC_DIGITS - 1, DEC_DIGITS), 1) + (round ? 1 : 0)
	const digits: Array<number> = [0]
	let carry = 0
	for (let i = 0; i < resNdigits; i++) {
		carry = carry * NBASE + (v.digits[i] ?? 0)
		const q = Math.floor(carry / divisor)
		digits.push(q)
		carry -= q * divisor
	}
	meter.work += resNdigits
	const quotient = strip(v.neg !== ival < 0, resWeight + 1, digits, rscale)
	return round ? roundVar(quotient, rscale) : truncVar(quotient, rscale)
}

/**
 * div_var_int64: var / (ival · NBASE^ivalWeight) for an int64 ival, the short division over 128-bit carries, held here
 * as bigints.
 */
const divVarInt64 = (
	v: NumVar,
	ival: bigint,
	ivalWeight: number,
	rscale: number,
	round: boolean,
	meter: Meter
): NumVar => {
	if (isZero(v)) {
		return zero(rscale)
	}
	const divisor = ival < 0n ? -ival : ival
	const resWeight = v.weight - ivalWeight
	const resNdigits =
		Math.max(resWeight + 1 + cdiv(rscale + DEC_DIGITS - 1, DEC_DIGITS), 1) + (round ? 1 : 0)
	const digits: Array<number> = [0]
	let carry = 0n
	for (let i = 0; i < resNdigits; i++) {
		carry = carry * BigInt(NBASE) + BigInt(v.digits[i] ?? 0)
		digits.push(Number(carry / divisor))
		carry %= divisor
	}
	meter.work += resNdigits
	const quotient = strip(v.neg !== ival < 0n, resWeight + 1, digits, rscale)
	return round ? roundVar(quotient, rscale) : truncVar(quotient, rscale)
}

/** The exactly rounded or truncated quotient at rscale fractional digits: what div_var with exact = true computes. */
const divExact = (a: NumVar, b: NumVar, rscale: number, round: boolean, meter: Meter): NumVar => {
	if (isZero(b)) {
		return fail("22012")
	}
	if (isZero(a)) {
		return zero(rscale)
	}
	/** a / b · 10^rscale = A · 10^shift / B, A and B their digits' integers. */
	const shift = DEC_DIGITS * (lastWeight(a) - lastWeight(b)) + rscale
	const num = integerOf(a) * (shift > 0 ? pow10(shift) : 1n)
	const den = integerOf(b) * (shift < 0 ? pow10(-shift) : 1n)
	let q = num / den
	if (round && (num % den) * 2n >= den) {
		q += 1n
	}
	meter.work += a.digits.length * b.digits.length
	return ofUnits(a.neg !== b.neg, q, -rscale, rscale)
}

/**
 * div_var: the quotient at rscale fractional digits, rounded or truncated. A divisor of up to two digits goes to
 * div_var_int and one of three or four to div_var_int64, numeric.c's short divisions; divisors of up to
 * 2 * (DIV_GUARD_DIGITS + 2) digits are always exact, and longer ones are exact only on request; otherwise the
 * approximate long division runs as numeric.c runs it.
 */
const divVar = (
	var1: NumVar,
	var2: NumVar,
	rscale: number,
	round: boolean,
	exactRequested: boolean,
	meter: Meter
): NumVar => {
	const var2ndigits = var2.digits.length
	if (var2ndigits === 0) {
		return fail("22012")
	}
	if (var2ndigits <= 2) {
		const first = defined(var2.digits[0], "the divisor's first digit")
		const ival = var2ndigits === 2 ? first * NBASE + (var2.digits[1] ?? 0) : first
		return divVarInt(
			var1,
			var2.neg ? -ival : ival,
			var2.weight - (var2ndigits - 1),
			rscale,
			round,
			meter
		)
	}
	if (var2ndigits <= 4) {
		const ival = integerOf(var2)
		return divVarInt64(
			var1,
			var2.neg ? -ival : ival,
			var2.weight - (var2ndigits - 1),
			rscale,
			round,
			meter
		)
	}
	if (isZero(var1)) {
		return zero(rscale)
	}
	const exact = exactRequested || var2ndigits <= 2 * (DIV_GUARD_DIGITS + 2)
	if (exact) {
		return divExact(var1, var2, rscale, round, meter)
	}
	return divApproximate(var1, var2, rscale, round, meter)
}

/** div_var's approximate long division (exact = false), over base-NBASE^2 working digits. */
const divApproximate = (
	var1: NumVar,
	var2: NumVar,
	rscale: number,
	round: boolean,
	meter: Meter
): NumVar => {
	const var1ndigits = var1.digits.length
	const var2ndigits = var2.digits.length
	const resNeg = var1.neg !== var2.neg
	const resWeight = var1.weight - var2.weight + 1
	let resNdigits = resWeight + 1 + cdiv(rscale + DEC_DIGITS - 1, DEC_DIGITS)
	resNdigits = Math.max(resNdigits, 1)
	if (round) {
		resNdigits++
	}
	resNdigits += DIV_GUARD_DIGITS
	let var1ndigitpairs = cdiv(var1ndigits + 1, 2)
	let var2ndigitpairs = cdiv(var2ndigits + 1, 2)
	const resNdigitpairs = cdiv(resNdigits + 1, 2)
	resNdigits = 2 * resNdigitpairs
	const divNdigitpairs = resNdigitpairs
	var1ndigitpairs = Math.min(var1ndigitpairs, divNdigitpairs)
	var2ndigitpairs = Math.min(var2ndigitpairs, divNdigitpairs)
	/** One spare dividend digit past div_ndigitpairs, always zero. */
	const dividend: Array<bigint> = Array.from({ length: divNdigitpairs + 1 }, () => 0n)
	for (let i = 0; i < var1ndigitpairs; i++) {
		dividend[i] = BigInt(pair(var1, i))
	}
	const divisor: Array<number> = []
	for (let i = 0; i < var2ndigitpairs; i++) {
		divisor.push(pair(var2, i))
	}
	let fdivisor = defined(divisor[0], "the divisor's leading digit pair") * NBASE_SQR
	if (var2ndigitpairs > 1) {
		fdivisor += defined(divisor[1], "the divisor's second digit pair")
	}
	const fdivisorinverse = 1.0 / fdivisor
	const at = (i: number): bigint => defined(dividend[i], "a dividend digit pair")
	const estimate = (qi: number): number => {
		let fdividend = Number(at(qi)) * NBASE_SQR
		fdividend += Number(at(qi + 1))
		const fquotient = fdividend * fdivisorinverse
		return fquotient >= 0.0 ? Math.trunc(fquotient) : Math.trunc(fquotient) - 1
	}
	let maxdiv = 1
	for (let qi = 0; qi < resNdigitpairs; qi++) {
		let qdigit = estimate(qi)
		if (qdigit !== 0) {
			maxdiv += Math.abs(qdigit)
			if (maxdiv > DIV_NORMALIZE_LIMIT) {
				let carry = 0n
				for (let i = Math.min(qi + var2ndigitpairs - 2, divNdigitpairs - 1); i > qi; i--) {
					let newdig = at(i) + carry
					if (newdig < 0n) {
						carry = -((-newdig - 1n) / NBASE_SQR_N) - 1n
						newdig -= carry * NBASE_SQR_N
					} else if (newdig >= NBASE_SQR_N) {
						carry = newdig / NBASE_SQR_N
						newdig -= carry * NBASE_SQR_N
					} else {
						carry = 0n
					}
					dividend[i] = newdig
				}
				dividend[qi] = at(qi) + carry
				maxdiv = 1
				qdigit = estimate(qi)
				maxdiv += Math.abs(qdigit)
			}
			if (qdigit !== 0) {
				const istop = Math.min(var2ndigitpairs, divNdigitpairs - qi)
				meter.work += istop
				const q = BigInt(qdigit)
				for (let i = 0; i < istop; i++) {
					dividend[qi + i] = at(qi + i) - q * BigInt(defined(divisor[i], "a divisor digit pair"))
				}
			}
		}
		dividend[qi + 1] = at(qi + 1) + at(qi) * NBASE_SQR_N
		dividend[qi] = BigInt(qdigit)
	}
	/** The final carry propagation back to base NBASE^2, then the quotient digits. */
	const pairs: Array<bigint> = Array.from({ length: resNdigitpairs }, () => 0n)
	let carry = 0n
	for (let i = resNdigitpairs - 1; i >= 0; i--) {
		let newdig = at(i) + carry
		if (newdig < 0n) {
			carry = -((-newdig - 1n) / NBASE_SQR_N) - 1n
			newdig -= carry * NBASE_SQR_N
		} else if (newdig >= NBASE_SQR_N) {
			carry = newdig / NBASE_SQR_N
			newdig -= carry * NBASE_SQR_N
		} else {
			carry = 0n
		}
		pairs[i] = newdig
	}
	assert.ok(carry === 0n, "div_var: no carry out of the quotient")
	const digits = Arr.flatMap(pairs, (p) => {
		const value = Number(p)
		const high = Math.floor(value / NBASE)
		return [high, value - high * NBASE]
	})
	const quotient = strip(resNeg, resWeight, digits, rscale)
	return round ? roundVar(quotient, rscale) : truncVar(quotient, rscale)
}

/**
 * sqrt_var: the integer square root of the input's leading src_ndigits digits, placed at res_weight and rounded to
 * rscale fractional digits (rscale may be negative). The Karatsuba iteration computes exactly that floor root.
 */
const sqrtVar = (arg: NumVar, rscale: number, meter: Meter): NumVar => {
	const stat = cmp(arg, zero(0))
	if (stat === 0) {
		return zero(rscale)
	}
	if (stat < 0) {
		return fail("2201F")
	}
	const resWeight = arg.weight >= 0 ? cdiv(arg.weight, 2) : -(cdiv(-arg.weight - 1, 2) + 1)
	let resNdigits =
		rscale + 1 >= 0
			? resWeight + 1 + cdiv(rscale + DEC_DIGITS, DEC_DIGITS)
			: resWeight + 1 - cdiv(-rscale - 1, DEC_DIGITS)
	resNdigits = Math.max(resNdigits, 1)
	let srcNdigits = arg.weight + 1 + (resNdigits - resWeight - 1) * 2
	srcNdigits = Math.max(srcNdigits, 1)
	const kept = arg.digits.slice(0, srcNdigits)
	const leading = BigInt(
		digitsText(kept) + Str.repeat(DEC_DIGITS * (srcNdigits - kept.length))("0")
	)
	const root = isqrt(leading)
	meter.work += srcNdigits * resNdigits
	const rootDigits = Math.ceil(root.toString().length / DEC_DIGITS)
	const placed = ofUnits(false, root, DEC_DIGITS * (resWeight - rootDigits + 1), rscale)
	return roundVar(placed, rscale)
}

/** A stripped value's decimal text, the point after its integer digits. */
const decimalText = (v: NumVar): string => {
	const text = digitsText(v.digits)
	const point = (v.weight + 1) * DEC_DIGITS
	return point <= 0
		? `0.${Str.repeat(-point)("0")}${text}`
		: point >= text.length
			? text + Str.repeat(point - text.length)("0")
			: `${Str.slice(0, point)(text)}.${Str.slice(point)(text)}`
}

/** numericvar_to_double_no_overflow: the value's text at its display scale, read by strtod. */
const toDouble = (v: NumVar): number => {
	const t = truncVar(v, Math.max(v.dscale, 0))
	return isZero(t) ? 0 : Number(`${t.neg ? "-" : ""}${decimalText(t)}`)
}

/** numericvar_to_int64: the value rounded to an integer, or none outside int64. */
const toInt64 = (v: NumVar): Option.Option<bigint> => {
	const r = roundVar(v, 0)
	const magnitude = integerOf(r) * (isZero(r) ? 1n : pow10(DEC_DIGITS * lastWeight(r)))
	const value = r.neg ? -magnitude : magnitude
	return value < PG_INT64_MIN || value > PG_INT64_MAX ? Option.none() : Option.some(value)
}

/** exp_var: e^arg at rscale fractional digits. */
const expVar = (arg: NumVar, rscale: number, meter: Meter): NumVar => {
	let x = arg
	let val = toDouble(x)
	if (Math.abs(val) >= NUMERIC_MAX_RESULT_SCALE * 3) {
		if (val > 0) {
			return fail("22003")
		}
		return zero(rscale)
	}
	const dweight = Math.trunc(val * LOG10_E)
	let ndiv2: number
	if (Math.abs(val) > 0.01) {
		ndiv2 = 1
		val /= 2
		while (Math.abs(val) > 0.01) {
			ndiv2++
			val /= 2
		}
		const localRscale = x.dscale + ndiv2
		x = divVarInt(x, 1 << ndiv2, 0, localRscale, true, meter)
	} else {
		ndiv2 = 0
	}
	let sigDigits = 1 + dweight + rscale + Math.trunc(ndiv2 * LOG10_2)
	sigDigits = Math.max(sigDigits, 0) + 8
	let localRscale = sigDigits - 1
	let result = add(ONE, x)
	let elem = mulVar(x, x, localRscale, meter)
	let ni = 2
	elem = divVarInt(elem, ni, 0, localRscale, true, meter)
	while (!isZero(elem)) {
		result = add(result, elem)
		elem = mulVar(elem, x, localRscale, meter)
		ni++
		elem = divVarInt(elem, ni, 0, localRscale, true, meter)
	}
	while (ndiv2-- > 0) {
		localRscale = sigDigits - weightOf(result) * 2 * DEC_DIGITS
		localRscale = Math.max(localRscale, NUMERIC_MIN_DISPLAY_SCALE)
		result = mulVar(result, result, localRscale, meter)
	}
	return roundVar(result, rscale)
}

/**
 * estimate_ln_dweight: the decimal weight of ln(var), from ln(1 + x) ~ x near one and from the leading digits
 * elsewhere, as an estimate whose truncation is the weight (libmEstimate).
 */
const estimateLnDweight = (v: NumVar): Estimate => {
	if (v.neg) {
		return exactEstimate(0)
	}
	if (cmp(v, ZERO_POINT_NINE) >= 0 && cmp(v, ONE_POINT_ONE) <= 0) {
		const x = sub(v, ONE)
		if (isZero(x)) {
			return exactEstimate(0)
		}
		/**
		 * log10 of a digit 1..9999 is exact at a power of ten and otherwise at least 4e-5 from an integer, far past any
		 * libm's error: the truncations agree, and the weight is exact.
		 */
		const leading = defined(x.digits[0], "a nonzero value's leading digit")
		return exactEstimate(x.weight * DEC_DIGITS + Math.trunc(Math.log10(leading)))
	}
	if (isZero(v)) {
		return exactEstimate(0)
	}
	let digits = defined(v.digits[0], "a nonzero value's leading digit")
	let dweight = v.weight * DEC_DIGITS
	if (v.digits.length > 1) {
		digits = digits * NBASE + defined(v.digits[1], "a value's second digit")
		dweight -= DEC_DIGITS
	}
	/**
	 * ln(var) from log(digits), then log10 of its magnitude, both through libm. Each is monotone in its libm result, and
	 * ln(var) keeps its sign across the range: a value within 0.9..1.1 took the branch above, so |ln(var)| > 0.09.
	 */
	const lnOf = (log: number): number => Math.abs(log + dweight * LN_10)
	const log = Math.log(digits)
	const lnEnds = [lnOf(ulpsAway(log, -libmUlps)), lnOf(ulpsAway(log, libmUlps))]
	const lnLo = Arr.reduce(lnEnds, Number.POSITIVE_INFINITY, (least, x) => Math.min(least, x))
	const lnHi = maxOf(lnEnds, Number.NEGATIVE_INFINITY)
	return {
		lo: ulpsAway(Math.log10(lnLo), -libmUlps),
		at: Math.log10(lnOf(log)),
		hi: ulpsAway(Math.log10(lnHi), libmUlps)
	}
}

/**
 * ln_var: the natural logarithm at rscale fractional digits, after reducing the input into (0.9, 1.1) by square roots.
 */
const lnVar = (arg: NumVar, rscale: number, meter: Meter): NumVar => {
	assert.ok(cmp(arg, zero(0)) > 0, "ln_var of a positive value")
	let x = arg
	let fact = TWO
	let nsqrt = 0
	while (cmp(x, ZERO_POINT_NINE) <= 0) {
		const localRscale = rscale - cdiv(weightOf(x) * DEC_DIGITS, 2) + 8
		x = sqrtVar(x, localRscale, meter)
		fact = mulVar(fact, TWO, 0, meter)
		nsqrt++
	}
	while (cmp(x, ONE_POINT_ONE) >= 0) {
		const localRscale = rscale - cdiv(weightOf(x) * DEC_DIGITS, 2) + 8
		x = sqrtVar(x, localRscale, meter)
		fact = mulVar(fact, TWO, 0, meter)
		nsqrt++
	}
	const localRscale = rscale + Math.trunc((nsqrt + 1) * LOG10_2) + 8
	let result = sub(x, ONE)
	let elem = add(x, ONE)
	result = divVar(result, elem, localRscale, true, false, meter)
	let xx = result
	x = mulVar(result, result, localRscale, meter)
	let ni = 1
	for (;;) {
		ni += 2
		xx = mulVar(xx, x, localRscale, meter)
		elem = divVarInt(xx, ni, 0, localRscale, true, meter)
		if (isZero(elem)) {
			break
		}
		result = add(result, elem)
		if (weightOf(elem) < weightOf(result) - cdiv(localRscale * 2, DEC_DIGITS)) {
			break
		}
	}
	return mulVar(result, fact, rscale, meter)
}

/**
 * power_var_int: base^exp for an int32 exponent, by repeated squaring at working scales that keep the result's
 * significant digits; numeric.c picks the result scale here.
 */
const powerVarInt = (base: NumVar, exp: number, expDscale: number, meter: Meter): NumVar => {
	if (isZero(base)) {
		return powerVarIntAt(base, exp, expDscale, 0, meter)
	}
	let leading = defined(base.digits[0], "a nonzero base's leading digit")
	let p = base.weight * DEC_DIGITS
	for (let i = 1; i < base.digits.length && i * DEC_DIGITS < 16; i++) {
		leading = leading * NBASE + defined(base.digits[i], "a digit of the base")
		p -= DEC_DIGITS
	}
	/**
	 * f, the approximate decimal weight of the result, exp * (log10(leading) + p): monotone in libm's log10, so its ends
	 * are f at the ends of log10's range. log10 of a power of ten is exact in every libm.
	 */
	const fOf = (log10: number): number => exp * (log10 + p)
	const log10 = Math.log10(leading)
	const ends = powersOfTen.has(leading)
		? [fOf(log10)]
		: [fOf(ulpsAway(log10, -libmUlps)), fOf(ulpsAway(log10, libmUlps))]
	const estimate = {
		lo: Arr.reduce(ends, Number.POSITIVE_INFINITY, (least, x) => Math.min(least, x)),
		at: fOf(log10),
		hi: maxOf(ends, Number.NEGATIVE_INFINITY)
	}
	return libmEstimate(estimate, "power_var_int's log10", (f) =>
		powerVarIntAt(base, exp, expDscale, f, meter)
	)
}

/**
 * power_var_int from its estimate f of the result's decimal weight on, which it reads by its truncation and by its
 * comparisons with integers.
 *
 * ln of an integer 2..2^31 is at least 2e-10 from an integer (the nearest is ln of an integer nearest e^k, k <= 21),
 * far past any libm's error: the truncations agree.
 */
const powerVarIntAt = (
	base: NumVar,
	exp: number,
	expDscale: number,
	f: number,
	meter: Meter
): NumVar => {
	if (f > numericMaxIntegerDigits.value) {
		return fail("22003")
	}
	if (f + 1 < -NUMERIC_MAX_DISPLAY_SCALE) {
		return zero(NUMERIC_MAX_DISPLAY_SCALE)
	}
	let rscale = NUMERIC_MIN_SIG_DIGITS - Math.trunc(f)
	rscale = Math.max(rscale, base.dscale)
	rscale = Math.max(rscale, expDscale)
	rscale = Math.max(rscale, NUMERIC_MIN_DISPLAY_SCALE)
	rscale = Math.min(rscale, NUMERIC_MAX_DISPLAY_SCALE)
	switch (exp) {
		case 0:
			return withScale(ONE, rscale)
		case 1:
			return roundVar(base, rscale)
		case -1:
			return divVar(ONE, base, rscale, true, true, meter)
		case 2:
			return mulVar(base, base, rscale, meter)
	}
	if (isZero(base)) {
		if (exp < 0) {
			return fail("22012")
		}
		return zero(rscale)
	}
	let sigDigits = 1 + rscale + Math.trunc(f)
	sigDigits += Math.trunc(Math.log(Math.abs(exp))) + 8
	let neg = exp < 0
	let mask = Math.abs(exp)
	let baseProd = base
	let result = mask % 2 === 1 ? base : ONE
	for (;;) {
		mask = Math.floor(mask / 2)
		if (mask <= 0) {
			break
		}
		let localRscale = sigDigits - 2 * weightOf(baseProd) * DEC_DIGITS
		localRscale = Math.min(localRscale, 2 * baseProd.dscale)
		localRscale = Math.max(localRscale, NUMERIC_MIN_DISPLAY_SCALE)
		baseProd = mulVar(baseProd, baseProd, localRscale, meter)
		if (mask % 2 === 1) {
			localRscale = sigDigits - (weightOf(baseProd) + weightOf(result)) * DEC_DIGITS
			localRscale = Math.min(localRscale, baseProd.dscale + result.dscale)
			localRscale = Math.max(localRscale, NUMERIC_MIN_DISPLAY_SCALE)
			result = mulVar(baseProd, result, localRscale, meter)
		}
		if (
			(Math.max(weightOf(baseProd), weightOf(result)) + 1) * DEC_DIGITS >
			numericMaxIntegerDigits.value
		) {
			if (!neg) {
				return fail("22003")
			}
			result = zero(result.dscale)
			neg = false
			break
		}
	}
	return neg ? divVar(ONE, result, rscale, true, false, meter) : roundVar(result, rscale)
}

/** power_var: base^exp, through power_var_int for an int32 exponent and exp(exp * ln(base)) otherwise. */
const powerVar = (baseIn: NumVar, exp: NumVar, meter: Meter): NumVar => {
	const integral = exp.digits.length === 0 || exp.digits.length <= exp.weight + 1
	if (integral) {
		const value = toInt64(exp)
		if (
			Option.isSome(value) &&
			value.value >= BigInt(PG_INT32_MIN) &&
			value.value <= BigInt(PG_INT32_MAX)
		) {
			return powerVarInt(baseIn, Number(value.value), exp.dscale, meter)
		}
	}
	if (cmp(baseIn, zero(0)) === 0) {
		return zero(NUMERIC_MIN_SIG_DIGITS)
	}
	let base = baseIn
	let resNeg = false
	if (base.neg) {
		if (!integral) {
			return fail("2201F")
		}
		const last = exp.digits.at(-1)
		resNeg = last !== undefined && exp.digits.length === exp.weight + 1 && (last & 1) === 1
		base = { ...base, neg: false }
	}
	return libmEstimate(estimateLnDweight(base), "estimate_ln_dweight's log and log10", (estimate) =>
		powerVarAt(base, exp, resNeg, Math.trunc(estimate), meter)
	)
}

/** power_var's exp(exp * ln(base)) from estimate_ln_dweight's weight on. */
const powerVarAt = (
	base: NumVar,
	exp: NumVar,
	resNeg: boolean,
	lnDweight: number,
	meter: Meter
): NumVar => {
	let localRscale = 8 - lnDweight
	localRscale = Math.max(localRscale, NUMERIC_MIN_DISPLAY_SCALE)
	let lnBase = lnVar(base, localRscale, meter)
	let lnNum = mulVar(lnBase, exp, localRscale, meter)
	let val = toDouble(lnNum)
	if (Math.abs(val) > NUMERIC_MAX_RESULT_SCALE * 3.01) {
		if (val > 0) {
			return fail("22003")
		}
		return zero(NUMERIC_MAX_DISPLAY_SCALE)
	}
	val *= LOG10_E
	let rscale = NUMERIC_MIN_SIG_DIGITS - Math.trunc(val)
	rscale = Math.max(rscale, base.dscale)
	rscale = Math.max(rscale, exp.dscale)
	rscale = Math.max(rscale, NUMERIC_MIN_DISPLAY_SCALE)
	rscale = Math.min(rscale, NUMERIC_MAX_DISPLAY_SCALE)
	let sigDigits = rscale + Math.trunc(val)
	sigDigits = Math.max(sigDigits, 0)
	localRscale = sigDigits - lnDweight + 8
	localRscale = Math.max(localRscale, NUMERIC_MIN_DISPLAY_SCALE)
	lnBase = lnVar(base, localRscale, meter)
	lnNum = mulVar(lnBase, exp, localRscale, meter)
	const result = expVar(lnNum, rscale, meter)
	return resNeg && !isZero(result) ? { ...result, neg: true } : result
}

/** A finite value in its one form as a NumVar, at the display scale trim_scale leaves it: its least scale. */
const fromParts = (p: FiniteParts): NumVar =>
	ofUnits(p.negative, p.coefficient, -p.minScale, p.minScale)

/** make_result: the Decimal of the result, 22003 outside numeric's format. */
const toDecimal = (v: NumVar): Result.Result<Decimal, PowerStopReason> => {
	const shift = DEC_DIGITS * lastWeight(v) + v.dscale
	const units = integerOf(v)
	const unit = pow10(Math.max(-shift, 0))
	assert.ok(units % unit === 0n, "numeric power: a result with no digits past its display scale")
	const made = Decimal.fromParts(v.neg, (units / unit) * pow10(Math.max(shift, 0)), v.dscale)
	return made.ok ? Result.succeed(made.value) : failed("22003")
}

const signOf = (p: DecimalParts): -1 | 0 | 1 => {
	switch (p.kind) {
		case "infinity":
			return 1
		case "-infinity":
			return -1
		case "nan":
			return 0
		case "finite":
			return p.coefficient === 0n ? 0 : p.negative ? -1 : 1
	}
}

/** The Decimal 1. */
const one = (): Decimal => {
	const made = Decimal.fromParts(false, 1n, 0)
	if (!made.ok) {
		throw new Error(`numeric power: the Decimal 1 (${made.error})`)
	}
	return made.value
}

/** Whether a value is 1 or -1: in its one form, a coefficient 1 at scale 0. */
const isUnit = (p: DecimalParts, negative: boolean): boolean =>
	p.kind === "finite" && p.negative === negative && p.coefficient === 1n && p.minScale === 0

/** Whether a value is an integer: an infinity, or a finite value whose least scale is 0. */
const isIntegral = (p: DecimalParts): boolean => {
	switch (p.kind) {
		case "nan":
			return false
		case "infinity":
		case "-infinity":
			return true
		case "finite":
			return p.minScale === 0
	}
}

/** |p| > 1 for a finite p. */
const absAboveOne = (p: FiniteParts): boolean => p.coefficient > pow10(p.minScale)

/**
 * numeric_power's rules for NaN and the infinities, POSIX pow(3)'s, over operands one of which is no finite value.
 */
const specialPower = (a: Decimal, b: Decimal): Result.Result<Decimal, PowerStopReason> => {
	const x = a.parts
	const y = b.parts
	if (x.kind === "nan") {
		return y.kind === "finite" && y.coefficient === 0n
			? Result.succeed(one())
			: Result.succeed(Decimal.nan)
	}
	if (y.kind === "nan") {
		return isUnit(x, false) ? Result.succeed(one()) : Result.succeed(Decimal.nan)
	}
	const sign1 = signOf(x)
	const sign2 = signOf(y)
	if (sign1 === 0 && sign2 < 0) {
		return failed("2201F")
	}
	if (sign1 < 0 && !isIntegral(y)) {
		return failed("2201F")
	}
	if (isUnit(x, false)) {
		return Result.succeed(one())
	}
	if (sign2 === 0) {
		return Result.succeed(one())
	}
	if (sign1 === 0 && sign2 > 0) {
		return Result.succeed(Decimal.zero)
	}
	if (y.kind !== "finite") {
		if (isUnit(x, true)) {
			return Result.succeed(one())
		}
		const absXGtOne = x.kind === "finite" ? absAboveOne(x) : true
		return Result.succeed(absXGtOne === sign2 > 0 ? Decimal.infinity : Decimal.zero)
	}
	if (x.kind === "infinity") {
		return Result.succeed(sign2 > 0 ? Decimal.infinity : Decimal.zero)
	}
	if (sign2 < 0) {
		return Result.succeed(Decimal.zero)
	}
	/** a is -Infinity and b is finite and positive: -Infinity to an odd integer, +Infinity otherwise. */
	const d = fromParts(y)
	const last = d.digits.at(-1)
	const odd = last !== undefined && d.digits.length === d.weight + 1 && (last & 1) === 1
	return Result.succeed(odd ? Decimal.negativeInfinity : Decimal.infinity)
}

/**
 * PostgreSQL 19's numeric power, ported from src/backend/utils/adt/numeric.c (numeric_power, power_var,
 * power_var_int, ln_var, exp_var, estimate_ln_dweight, sqrt_var, mul_var, div_var, div_var_int), over the exact
 * Decimal carrier.
 *
 * numeric power is the one Compute operation whose result depends on PostgreSQL's intermediate rounding: power_var
 * picks its result scale from a low-precision estimate of exp * ln(base), computes ln and exp by series at local
 * scales it derives from that estimate, and multiplies and divides with truncated working precision. Agreeing with
 * PostgreSQL to the last digit therefore means reproducing each intermediate value, not computing the mathematically
 * exact power. Each function below is the numeric.c function of the same name, step for step:
 *
 * - A NumericVar is PostgreSQL's working value as numeric.c holds it: a sign, base-NBASE digits from the most
 *   significant on with the weight of the first, and the display scale (dscale) each function sets as numeric.c sets
 *   it, stripped (strip_var) as numeric.c keeps every working value before it is read again. Additions, roundings,
 *   truncations, comparisons, div_var_int and mul_var below bigintTriangleDigits run over the digits as numeric.c's
 *   do, so no working value is converted to decimal text on its way through a series; a longer mul_var, exact division
 *   and the integer square root read their operands as bigints, a few times a power.
 * - Where numeric.c computes an exactly rounded or truncated result (add_var, sub_var, round_var, trunc_var,
 *   div_var_int, div_var_int64, div_var with exact = true, mul_var_short, sqrt_var's integer square root), the port
 *   computes the exact value and rounds it the same way. Where numeric.c computes with truncated working precision,
 *   the port reproduces the truncation: mul_var sums exactly the digit-pair products its maxdigits bound keeps, and
 *   div_var with exact = false runs the same floating-point quotient estimates, carry normalizations and guard digits
 *   over int64 working digits, held here as bigints.
 * - The floating-point estimates are binary64 in both. Their arithmetic and the decimal-to-double conversion of
 *   numericvar_to_double_no_overflow are IEEE exact, so the port computes the same doubles. Their log and log10 are
 *   not: PostgreSQL calls the platform libm and the port V8's fdlibm ports, which agree only to within a few units in
 *   the last place. Each such estimate is read through libmEstimate, which refuses to claim a truncation an integer
 *   lies too near for the two to agree on: the result is then not host-evaluable (the host never claims a value it
 *   cannot reproduce bit for bit), and PostgreSQL alone computes it. The two truncations of an exact estimate, log10 of
 *   a power of ten or of a leading NBASE digit and log of an int32 exponent, are proved to agree and are plain.
 *
 * Failures are PostgreSQL's SQLSTATEs: 2201F for zero to a negative power and a negative base to a non-integer
 * power, 22003 when the result overflows numeric's format. A result that underflows is zero at the display scale
 * PostgreSQL gives it. test/pg/compute compares every case with PostgreSQL 19. The evaluation counts its work, the
 * digit operations numeric.c's own truncations leave it (Meter), which test/unit/compute/power-work.test.ts bounds.
 *
 * numeric_power over operands in their one form, trim_scale(a) and trim_scale(b), as SQL rendering passes them
 * (registry.ts OperandReading): POSIX pow(3)'s rules for NaN and the infinities, then power_var.
 */
export const powerWork = (
	a: Decimal,
	b: Decimal
): { readonly outcome: Result.Result<Decimal, PowerStopReason>; readonly work: number } => {
	const x = a.parts
	const y = b.parts
	if (x.kind !== "finite" || y.kind !== "finite") {
		return { outcome: specialPower(a, b), work: 0 }
	}
	if (signOf(x) === 0 && signOf(y) < 0) {
		return { outcome: failed("2201F"), work: 0 }
	}
	const meter: Meter = { work: 0 }
	const outcome = Result.flatMap(
		caught(() => toDecimal(powerVar(fromParts(x), fromParts(y), meter))),
		(result) => result
	)
	return { outcome, work: meter.work }
}

/** numeric power's outcome (powerWork). */
export const power = (a: Decimal, b: Decimal): Result.Result<Decimal, PowerStopReason> =>
	powerWork(a, b).outcome
