import { Array as Arr, Option, pipe, Result, Schema, String as Str } from "effect"
import { indices, maxOf } from "#compiler/core/array.ts"
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
const NUMERIC_WEIGHT_MAX = 32767
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

/**
 * Why numeric power yields no value: PostgreSQL's failure, or a result that hangs on a libm estimate (libmEstimate) in a
 * way the host cannot pin down, which PostgreSQL alone computes.
 */
const PowerStopReason = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("failure"),
		code: Schema.Literals(["22003", "22012", "2201F"])
	}),
	Schema.Struct({ kind: Schema.Literal("libm"), what: Schema.String })
])
type PowerStopReason = typeof PowerStopReason.Type

/** The SQLSTATEs numeric power fails with: overflow, division by zero, and an invalid argument for power. */
type PowerFailureCode = Extract<PowerStopReason, { readonly kind: "failure" }>["code"]

/** A stop inside the port, thrown and caught at the boundary (power) by caught. */
class PowerStop extends Schema.TaggedError<PowerStop, { readonly brand: unique symbol }>()(
	"PowerStop",
	{
		reason: PowerStopReason
	}
) {}

/** Runs `f`, turning a thrown PowerStop into a failure with its reason; any other throw is a defect and propagates. */
const caught = <A>(f: () => A): Result.Result<A, PowerStopReason> => {
	try {
		return Result.succeed(f())
	} catch (thrown) {
		if (Schema.is(PowerStop)(thrown)) {
			return Result.fail(thrown.reason)
		}
		throw thrown
	}
}

const fail = (code: PowerFailureCode): never => {
	throw PowerStop.make({ reason: { kind: "failure", code } })
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
 * zero is among them: power_var_int compares its estimate only with 524288 and -1001, and power_var reads its weight
 * only through trunc.
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
		throw PowerStop.make({ reason: { kind: "libm", what } })
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
	throw PowerStop.make({ reason: first.failure })
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
 * A NumericVar: (-1)^neg * mag * 10^exp, mag not divisible by 10 (zero is mag 0, exp 0, not negative), with the
 * display scale numeric.c gives it.
 */
interface NumVar {
	readonly neg: boolean
	readonly mag: bigint
	readonly exp: number
	readonly dscale: number
}

const trailingZeros = (s: string): number => {
	let z = 0
	while (
		z < s.length - 1 &&
		Option.exists(Str.charCodeAt(s, s.length - 1 - z), (code) => code === 0x30)
	) {
		z++
	}
	return z
}

/** The NumericVar of a signed magnitude at a decimal exponent, normalized. */
const make = (neg: boolean, mag: bigint, exp: number, dscale: number): NumVar => {
	if (mag === 0n) {
		return { neg: false, mag: 0n, exp: 0, dscale }
	}
	if (mag % 10n !== 0n) {
		return { neg, mag, exp, dscale }
	}
	const s = mag.toString()
	const z = trailingZeros(s)
	return { neg, mag: BigInt(Str.slice(0, s.length - z)(s)), exp: exp + z, dscale }
}

const zero = (dscale: number): NumVar => ({ neg: false, mag: 0n, exp: 0, dscale })
const isZero = (v: NumVar): boolean => v.mag === 0n
const withScale = (v: NumVar, dscale: number): NumVar => ({ ...v, dscale })

/** numeric.c's constants: const_one, const_two, const_zero_point_nine and const_one_point_one. */
const ONE = make(false, 1n, 0, 0)
const TWO = make(false, 2n, 0, 0)
const ZERO_POINT_NINE = make(false, 9n, -1, 1)
const ONE_POINT_ONE = make(false, 11n, -1, 1)

/** The signed value as an integer count of 10^exp units. */
const signed = (v: NumVar): bigint => (v.neg ? -v.mag : v.mag)

/** Two values at a common exponent. */
const aligned = (
	a: NumVar,
	b: NumVar
): { readonly x: bigint; readonly y: bigint; readonly exp: number } => {
	const exp = Math.min(a.exp, b.exp)
	return { x: signed(a) * pow10(a.exp - exp), y: signed(b) * pow10(b.exp - exp), exp }
}

const fromSigned = (value: bigint, exp: number, dscale: number): NumVar =>
	make(value < 0n, value < 0n ? -value : value, exp, dscale)

/** cmp_var. */
const cmp = (a: NumVar, b: NumVar): -1 | 0 | 1 => {
	if (isZero(a) && isZero(b)) {
		return 0
	}
	const { x, y } = aligned(a, b)
	return x < y ? -1 : x > y ? 1 : 0
}

/** add_var and sub_var: exact, at the larger display scale. */
const add = (a: NumVar, b: NumVar): NumVar => {
	const { x, y, exp } = aligned(a, b)
	return fromSigned(x + y, exp, Math.max(a.dscale, b.dscale))
}

const sub = (a: NumVar, b: NumVar): NumVar => {
	const { x, y, exp } = aligned(a, b)
	return fromSigned(x - y, exp, Math.max(a.dscale, b.dscale))
}

/** round_var: half away from zero at rscale fractional digits (rscale may be negative); the display scale is rscale. */
const roundVar = (v: NumVar, rscale: number): NumVar => {
	if (v.exp >= -rscale) {
		return withScale(v, rscale)
	}
	const divisor = pow10(-rscale - v.exp)
	let q = v.mag / divisor
	if ((v.mag % divisor) * 2n >= divisor) {
		q += 1n
	}
	return make(v.neg, q, -rscale, rscale)
}

/** trunc_var: toward zero at rscale fractional digits. */
const truncVar = (v: NumVar, rscale: number): NumVar => {
	if (v.exp >= -rscale) {
		return withScale(v, rscale)
	}
	return make(v.neg, v.mag / pow10(-rscale - v.exp), -rscale, rscale)
}

/** The base-NBASE digits and weight of a stripped NumericVar, as numeric.c holds them. */
interface Digits {
	readonly digits: ReadonlyArray<number>
	readonly weight: number
	/** The digits' decimal text, DEC_DIGITS characters per digit. */
	readonly text: string
}

/** A NumVar's digits. */
const digitsOf = (v: NumVar): Digits => {
	if (isZero(v)) {
		return { digits: [], weight: 0, text: "" }
	}
	const pad = ((v.exp % DEC_DIGITS) + DEC_DIGITS) % DEC_DIGITS
	const raw = v.mag.toString() + Str.repeat(pad)("0")
	const lo = (v.exp - pad) / DEC_DIGITS
	const n = Math.ceil(raw.length / DEC_DIGITS)
	const text = Str.padStart(n * DEC_DIGITS, "0")(raw)
	const digits: Array<number> = []
	for (let i = 0; i < text.length; i += DEC_DIGITS) {
		digits.push(Number(Str.slice(i, i + DEC_DIGITS)(text)))
	}
	return { digits, weight: lo + n - 1, text }
}

const weightOf = (v: NumVar): number => {
	if (isZero(v)) {
		return 0
	}
	const pad = ((v.exp % DEC_DIGITS) + DEC_DIGITS) % DEC_DIGITS
	const length = v.mag.toString().length + pad
	return (v.exp - pad) / DEC_DIGITS + Math.ceil(length / DEC_DIGITS) - 1
}

/** The integer of `count` base-NBASE digits starting at `from`, missing digits past the last being zero. */
const digitInt = (d: Digits, from: number, count: number): bigint => {
	if (count <= 0) {
		return 0n
	}
	const missing = count - Math.max(0, Math.min(d.digits.length, from + count) - from)
	return BigInt(
		Str.slice(DEC_DIGITS * from, DEC_DIGITS * (from + count))(d.text) +
			Str.repeat(DEC_DIGITS * missing)("0")
	)
}

/** A digit pair of base NBASE^2, the last one of an odd-length input shifted up, as mul_var and div_var form them. */
const pair = (digits: ReadonlyArray<number>, i: number): number =>
	defined(digits[2 * i], "the first digit of a pair") * NBASE + (digits[2 * i + 1] ?? 0)

/**
 * mul_var: the product rounded to rscale fractional digits, computed from the digit-pair products whose position
 * survives the maxdigits truncation (MUL_GUARD_DIGITS guard digits), exactly as mul_var accumulates them; the exact
 * product when the shorter input has at most six digits and the exact scale is requested (mul_var_short).
 */
const mulVar = (left: NumVar, right: NumVar, rscale: number): NumVar => {
	let var1 = left
	let var2 = right
	let d1 = digitsOf(var1)
	let d2 = digitsOf(var2)
	if (d1.digits.length > d2.digits.length) {
		;[var1, var2, d1, d2] = [var2, var1, d2, d1]
	}
	const var1ndigits = d1.digits.length
	const var2ndigits = d2.digits.length
	if (var1ndigits === 0) {
		return zero(rscale)
	}
	const resNeg = var1.neg !== var2.neg
	if (var1ndigits <= 6 && rscale === var1.dscale + var2.dscale) {
		return make(resNeg, var1.mag * var2.mag, var1.exp + var2.exp, var1.dscale + var2.dscale)
	}
	let var1ndigitpairs = cdiv(var1ndigits + 1, 2)
	let var2ndigitpairs = cdiv(var2ndigits + 1, 2)
	const resNdigitsExact = var1ndigits + var2ndigits
	let resNdigitpairs = cdiv(resNdigitsExact, 2) + 1
	const pairOffset = resNdigitpairs - var1ndigitpairs - var2ndigitpairs + 1
	const resWeight =
		d1.weight +
		d2.weight +
		1 +
		2 * resNdigitpairs -
		resNdigitsExact -
		(var1ndigits & 1) -
		(var2ndigits & 1)
	const maxdigits = resWeight + 1 + cdiv(rscale + DEC_DIGITS - 1, DEC_DIGITS) + MUL_GUARD_DIGITS
	const maxdigitpairs = cdiv(maxdigits, 2) + 1
	resNdigitpairs = Math.min(resNdigitpairs, maxdigitpairs)
	const resNdigits = 2 * resNdigitpairs
	if (resNdigitpairs <= pairOffset) {
		return zero(rscale)
	}
	var1ndigitpairs = Math.min(var1ndigitpairs, resNdigitpairs - pairOffset)
	var2ndigitpairs = Math.min(var2ndigitpairs, resNdigitpairs - pairOffset)
	/**
	 * Digit pair i1 of var1 times digit pair i2 of var2 adds to dig[i1 + i2 + pairOffset] for i2 below
	 * min(var2ndigitpairs, resNdigitpairs - i1 - pairOffset). Over the pairs i1 whose limit is all of var2's pairs, the
	 * sum is (var1's leading pairs) * (var2's pairs) at one shift. Each later pair i1 = full + t meets the prefix of
	 * var2 that is n0 - t pairs long, n0 = resNdigitpairs - full - pairOffset, each product ending in the last result
	 * pair: the triangle sum over t of a(full + t) * y(0, n0 - t), where a(i) is var1's pair i and y(s, n) var2's n
	 * pairs from pair s as one integer (n0 is at least the number of triangle pairs, since each meets one pair or more).
	 */
	const ys = (from: number, count: number): bigint => digitInt(d2, 2 * from, 2 * count)
	const as = (from: number, count: number): bigint => digitInt(d1, 2 * from, 2 * count)
	/**
	 * The square triangle: the sum over t < count of a(aFrom + t) * y(yFrom, count - t). Summed pair by pair it costs
	 * count multiplications of count-pair integers. Split at h, y(yFrom, count - t) for t < h is
	 * y(yFrom, count - h) * NBASE^2^(h - t) + y(yFrom + count - h, h - t), so the first half is one product
	 * y(yFrom, count - h) * a's h pairs * NBASE^2 plus the square triangle of h pairs at yFrom + count - h, and the
	 * second half is the square triangle of count - h pairs at yFrom: the same integer from O(log count) levels of large
	 * multiplications. Every step is an exact integer identity, so the sum is the one the pair-by-pair loop forms.
	 */
	const square = (aFrom: number, count: number, yFrom: number): bigint => {
		if (count <= 16) {
			let sum = 0n
			for (let t = 0; t < count; t++) {
				sum += BigInt(pair(d1.digits, aFrom + t)) * ys(yFrom, count - t)
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
		const lead = as(0, full)
		const shift = resNdigitpairs - pairOffset - var2ndigitpairs - (full - 1)
		total = lead * ys(0, var2ndigitpairs) * NBASE_SQR_N ** BigInt(shift)
	}
	if (full < var1ndigitpairs) {
		/**
		 * y(0, n0 - t) is y(0, n0 - count) * NBASE^2^(count - t) + y(n0 - count, count - t): one product and a square.
		 */
		const count = var1ndigitpairs - full
		const n0 = resNdigitpairs - full - pairOffset
		total += ys(0, n0 - count) * as(full, count) * NBASE_SQR_N + square(full, count, n0 - count)
	}
	const product = make(resNeg, total, DEC_DIGITS * (resWeight - resNdigits + 1), rscale)
	return roundVar(product, rscale)
}

/**
 * The exactly rounded or truncated quotient at rscale fractional digits: what div_var_int, div_var_int64 and div_var
 * with exact = true compute.
 */
const divExact = (a: NumVar, b: NumVar, rscale: number, round: boolean): NumVar => {
	if (isZero(b)) {
		return fail("22012")
	}
	if (isZero(a)) {
		return zero(rscale)
	}
	/** a / b * 10^rscale = A * 10^(ea - eb + rscale) / B. */
	const shift = a.exp - b.exp + rscale
	const num = a.mag * (shift > 0 ? pow10(shift) : 1n)
	const den = b.mag * (shift < 0 ? pow10(-shift) : 1n)
	let q = num / den
	if (round && (num % den) * 2n >= den) {
		q += 1n
	}
	return make(a.neg !== b.neg, q, -rscale, rscale)
}

/** div_var_int: var / (ival * NBASE^ivalWeight), exact. */
const divVarInt = (
	v: NumVar,
	ival: number,
	ivalWeight: number,
	rscale: number,
	round: boolean
): NumVar =>
	divExact(v, make(ival < 0, BigInt(Math.abs(ival)), DEC_DIGITS * ivalWeight, 0), rscale, round)

/**
 * div_var: the quotient at rscale fractional digits, rounded or truncated. Divisors of up to four digits go to the
 * exact short divisions, divisors of up to 2 * (DIV_GUARD_DIGITS + 2) digits are always exact, and longer ones are
 * exact only on request; otherwise the approximate long division runs as numeric.c runs it.
 */
const divVar = (
	var1: NumVar,
	var2: NumVar,
	rscale: number,
	round: boolean,
	exactRequested: boolean
): NumVar => {
	const d2 = digitsOf(var2)
	if (d2.digits.length === 0) {
		return fail("22012")
	}
	if (d2.digits.length <= 4) {
		return divExact(var1, var2, rscale, round)
	}
	if (isZero(var1)) {
		return zero(rscale)
	}
	const exact = exactRequested || d2.digits.length <= 2 * (DIV_GUARD_DIGITS + 2)
	if (exact) {
		return divExact(var1, var2, rscale, round)
	}
	return divApproximate(var1, digitsOf(var1), var2, d2, rscale, round)
}

/** div_var's approximate long division (exact = false), over base-NBASE^2 working digits. */
const divApproximate = (
	var1: NumVar,
	d1: Digits,
	var2: NumVar,
	d2: Digits,
	rscale: number,
	round: boolean
): NumVar => {
	const var1ndigits = d1.digits.length
	const var2ndigits = d2.digits.length
	const resNeg = var1.neg !== var2.neg
	const resWeight = d1.weight - d2.weight + 1
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
		dividend[i] = BigInt(pair(d1.digits, i))
	}
	const divisor: Array<number> = []
	for (let i = 0; i < var2ndigitpairs; i++) {
		divisor.push(pair(d2.digits, i))
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
	let text = ""
	for (const p of pairs) {
		text += pipe(p.toString(), Str.padStart(2 * DEC_DIGITS, "0"))
	}
	const quotient = make(resNeg, BigInt(text), DEC_DIGITS * (resWeight - resNdigits + 1), rscale)
	return round ? roundVar(quotient, rscale) : truncVar(quotient, rscale)
}

/**
 * sqrt_var: the integer square root of the input's leading src_ndigits digits, placed at res_weight and rounded to
 * rscale fractional digits (rscale may be negative). The Karatsuba iteration computes exactly that floor root.
 */
const sqrtVar = (arg: NumVar, rscale: number): NumVar => {
	const stat = cmp(arg, zero(0))
	if (stat === 0) {
		return zero(rscale)
	}
	if (stat < 0) {
		return fail("2201F")
	}
	const a = digitsOf(arg)
	const resWeight = a.weight >= 0 ? cdiv(a.weight, 2) : -(cdiv(-a.weight - 1, 2) + 1)
	let resNdigits =
		rscale + 1 >= 0
			? resWeight + 1 + cdiv(rscale + DEC_DIGITS, DEC_DIGITS)
			: resWeight + 1 - cdiv(-rscale - 1, DEC_DIGITS)
	resNdigits = Math.max(resNdigits, 1)
	let srcNdigits = a.weight + 1 + (resNdigits - resWeight - 1) * 2
	srcNdigits = Math.max(srcNdigits, 1)
	const root = isqrt(digitInt(a, 0, srcNdigits))
	const rootDigits = Math.ceil(root.toString().length / DEC_DIGITS)
	const placed = make(false, root, DEC_DIGITS * (resWeight - rootDigits + 1), rscale)
	return roundVar(placed, rscale)
}

/** numericvar_to_double_no_overflow: the value's text at its display scale, read by strtod. */
const toDouble = (v: NumVar): number => {
	const scale = Math.max(v.dscale, 0)
	const t = truncVar(v, scale)
	if (isZero(t)) {
		return 0
	}
	const units = pipe((t.mag * pow10(t.exp + scale)).toString(), Str.padStart(scale + 1, "0"))
	const text =
		scale === 0
			? units
			: `${Str.slice(0, units.length - scale)(units)}.${Str.slice(units.length - scale)(units)}`
	return Number(t.neg ? `-${text}` : text)
}

/** numericvar_to_int64: the value rounded to an integer, or none outside int64. */
const toInt64 = (v: NumVar): Option.Option<bigint> => {
	const r = roundVar(v, 0)
	const value = signed(r) * pow10(r.exp)
	return value < PG_INT64_MIN || value > PG_INT64_MAX ? Option.none() : Option.some(value)
}

/** exp_var: e^arg at rscale fractional digits. */
const expVar = (arg: NumVar, rscale: number): NumVar => {
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
		x = divVarInt(x, 1 << ndiv2, 0, localRscale, true)
	} else {
		ndiv2 = 0
	}
	let sigDigits = 1 + dweight + rscale + Math.trunc(ndiv2 * LOG10_2)
	sigDigits = Math.max(sigDigits, 0) + 8
	let localRscale = sigDigits - 1
	let result = add(ONE, x)
	let elem = mulVar(x, x, localRscale)
	let ni = 2
	elem = divVarInt(elem, ni, 0, localRscale, true)
	while (!isZero(elem)) {
		result = add(result, elem)
		elem = mulVar(elem, x, localRscale)
		ni++
		elem = divVarInt(elem, ni, 0, localRscale, true)
	}
	while (ndiv2-- > 0) {
		localRscale = sigDigits - weightOf(result) * 2 * DEC_DIGITS
		localRscale = Math.max(localRscale, NUMERIC_MIN_DISPLAY_SCALE)
		result = mulVar(result, result, localRscale)
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
		const d = digitsOf(x)
		/**
		 * log10 of a digit 1..9999 is exact at a power of ten and otherwise at least 4e-5 from an integer, far past any
		 * libm's error: the truncations agree, and the weight is exact.
		 */
		const leading = defined(d.digits[0], "a nonzero value's leading digit")
		return exactEstimate(d.weight * DEC_DIGITS + Math.trunc(Math.log10(leading)))
	}
	if (isZero(v)) {
		return exactEstimate(0)
	}
	const d = digitsOf(v)
	let digits = defined(d.digits[0], "a nonzero value's leading digit")
	let dweight = d.weight * DEC_DIGITS
	if (d.digits.length > 1) {
		digits = digits * NBASE + defined(d.digits[1], "a value's second digit")
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
const lnVar = (arg: NumVar, rscale: number): NumVar => {
	assert.ok(cmp(arg, zero(0)) > 0, "ln_var of a positive value")
	let x = arg
	let fact = TWO
	let nsqrt = 0
	while (cmp(x, ZERO_POINT_NINE) <= 0) {
		const localRscale = rscale - cdiv(weightOf(x) * DEC_DIGITS, 2) + 8
		x = sqrtVar(x, localRscale)
		fact = mulVar(fact, TWO, 0)
		nsqrt++
	}
	while (cmp(x, ONE_POINT_ONE) >= 0) {
		const localRscale = rscale - cdiv(weightOf(x) * DEC_DIGITS, 2) + 8
		x = sqrtVar(x, localRscale)
		fact = mulVar(fact, TWO, 0)
		nsqrt++
	}
	const localRscale = rscale + Math.trunc((nsqrt + 1) * LOG10_2) + 8
	let result = sub(x, ONE)
	let elem = add(x, ONE)
	result = divVar(result, elem, localRscale, true, false)
	let xx = result
	x = mulVar(result, result, localRscale)
	let ni = 1
	for (;;) {
		ni += 2
		xx = mulVar(xx, x, localRscale)
		elem = divVarInt(xx, ni, 0, localRscale, true)
		if (isZero(elem)) {
			break
		}
		result = add(result, elem)
		if (weightOf(elem) < weightOf(result) - cdiv(localRscale * 2, DEC_DIGITS)) {
			break
		}
	}
	return mulVar(result, fact, rscale)
}

/**
 * power_var_int: base^exp for an int32 exponent, by repeated squaring at working scales that keep the result's
 * significant digits; numeric.c picks the result scale here.
 */
const powerVarInt = (base: NumVar, exp: number, expDscale: number): NumVar => {
	const b = digitsOf(base)
	if (b.digits.length === 0) {
		return powerVarIntAt(base, b, exp, expDscale, 0)
	}
	let leading = defined(b.digits[0], "a nonzero base's leading digit")
	let p = b.weight * DEC_DIGITS
	for (let i = 1; i < b.digits.length && i * DEC_DIGITS < 16; i++) {
		leading = leading * NBASE + defined(b.digits[i], "a digit of the base")
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
		powerVarIntAt(base, b, exp, expDscale, f)
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
	b: Digits,
	exp: number,
	expDscale: number,
	f: number
): NumVar => {
	if (f > (NUMERIC_WEIGHT_MAX + 1) * DEC_DIGITS) {
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
			return divVar(ONE, base, rscale, true, true)
		case 2:
			return mulVar(base, base, rscale)
	}
	if (b.digits.length === 0) {
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
		baseProd = mulVar(baseProd, baseProd, localRscale)
		if (mask % 2 === 1) {
			localRscale = sigDigits - (weightOf(baseProd) + weightOf(result)) * DEC_DIGITS
			localRscale = Math.min(localRscale, baseProd.dscale + result.dscale)
			localRscale = Math.max(localRscale, NUMERIC_MIN_DISPLAY_SCALE)
			result = mulVar(baseProd, result, localRscale)
		}
		if (weightOf(baseProd) > NUMERIC_WEIGHT_MAX || weightOf(result) > NUMERIC_WEIGHT_MAX) {
			if (!neg) {
				return fail("22003")
			}
			result = zero(result.dscale)
			neg = false
			break
		}
	}
	return neg ? divVar(ONE, result, rscale, true, false) : roundVar(result, rscale)
}

/** power_var: base^exp, through power_var_int for an int32 exponent and exp(exp * ln(base)) otherwise. */
const powerVar = (baseIn: NumVar, exp: NumVar): NumVar => {
	const e = digitsOf(exp)
	const integral = e.digits.length === 0 || e.digits.length <= e.weight + 1
	if (integral) {
		const value = toInt64(exp)
		if (
			Option.isSome(value) &&
			value.value >= BigInt(PG_INT32_MIN) &&
			value.value <= BigInt(PG_INT32_MAX)
		) {
			return powerVarInt(baseIn, Number(value.value), exp.dscale)
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
		const last = e.digits.at(-1)
		resNeg = last !== undefined && e.digits.length === e.weight + 1 && (last & 1) === 1
		base = { ...base, neg: false }
	}
	return libmEstimate(estimateLnDweight(base), "estimate_ln_dweight's log and log10", (estimate) =>
		powerVarAt(base, exp, resNeg, Math.trunc(estimate))
	)
}

/** power_var's exp(exp * ln(base)) from estimate_ln_dweight's weight on. */
const powerVarAt = (base: NumVar, exp: NumVar, resNeg: boolean, lnDweight: number): NumVar => {
	let localRscale = 8 - lnDweight
	localRscale = Math.max(localRscale, NUMERIC_MIN_DISPLAY_SCALE)
	let lnBase = lnVar(base, localRscale)
	let lnNum = mulVar(lnBase, exp, localRscale)
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
	lnBase = lnVar(base, localRscale)
	lnNum = mulVar(lnBase, exp, localRscale)
	const result = expVar(lnNum, rscale)
	return resNeg && !isZero(result) ? { ...result, neg: true } : result
}

/** A finite value in its one form as a NumVar, at the display scale trim_scale leaves it: its least scale. */
const fromParts = (p: FiniteParts): NumVar =>
	make(p.negative, p.coefficient, -p.minScale, p.minScale)

/** make_result: the Decimal of the result, 22003 outside numeric's format. */
const toDecimal = (v: NumVar): Result.Result<Decimal, PowerStopReason> => {
	assert.ok(v.exp >= -v.dscale, "numeric power: a result with no digits past its display scale")
	const made = Decimal.fromParts(v.neg, v.mag * pow10(v.exp + v.dscale), v.dscale)
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
	const d = digitsOf(fromParts(y))
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
 * - A NumericVar is PostgreSQL's working value: a sign, a value, and the display scale (dscale) each function sets as
 *   numeric.c sets it. The value is held exactly as an unscaled bigint and a decimal exponent; its base-NBASE digits
 *   and weight are derived on demand. numeric.c keeps every working value stripped (strip_var) before it is read
 *   again, so the derived digits are the ones PostgreSQL holds.
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
 * PostgreSQL gives it. test/pg/compute compares every case with PostgreSQL 19.
 *
 * numeric_power over operands in their one form, trim_scale(a) and trim_scale(b), as SQL rendering passes them
 * (registry.ts OperandReading): POSIX pow(3)'s rules for NaN and the infinities, then power_var.
 */
export const power = (a: Decimal, b: Decimal): Result.Result<Decimal, PowerStopReason> => {
	const x = a.parts
	const y = b.parts
	if (x.kind !== "finite" || y.kind !== "finite") {
		return specialPower(a, b)
	}
	if (signOf(x) === 0 && signOf(y) < 0) {
		return failed("2201F")
	}
	return Result.flatMap(
		caught(() => toDecimal(powerVar(fromParts(x), fromParts(y)))),
		(result) => result
	)
}
