/**
 * The float carriers' values (scalar/values/float.ts): a real is the binary32 value PostgreSQL's float8-to-float4 cast
 * stores, and both float types order as PostgreSQL's float comparison does, one text per value.
 *
 * - Admission: toReal stores a double as the binary32 value nearest it, ties to the even significand, -0 as 0, and
 *   NaN and the infinities as they are; it refuses a finite double the cast rounds to an infinity as realOverflow and a
 *   nonzero one it rounds to zero as realUnderflow.
 * - Order: compareFloat is PostgreSQL's float order, NaN equal to NaN and above every other value, -0 equal to 0, and
 *   otherwise the values' own order; two values compare equal exactly when their identity texts (floatText) are one.
 *
 * Oracles: IEEE 754 binary32 stated apart from the code. A double rounds to an infinity exactly when its magnitude is at
 * least binary32Max plus half its last place, 2^(emax - p + 1) / 2, and to zero exactly when it is nonzero and at most
 * half the least subnormal, 2^(least - 1); a stored value is a binary32 value (Math.fround fixes it) neither of whose
 * binary32 neighbours, stepped by its bit pattern, lies nearer the double. The order's model ranks a double by its
 * IEEE bit pattern read as a sign and a magnitude, -0 as 0, with NaN above it all.
 *
 * Features: a double rounded, one stored exactly, a binary32 subnormal stored, each refusal, -0 stored as 0, a special
 * kept; a NaN against another value, two NaNs, -0 against 0, an infinity, and two distinct finite values.
 *
 * Plants: values-real-subnormal (a double that rounds to a binary32 subnormal refused as realUnderflow),
 * values-float-nan-low (NaN sorted below every other value).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { double, float } from "@bjornpagen/testing/values"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Effect, Formatter } from "effect"
import {
	binary32LeastExponent,
	binary32Max,
	binary32MaxExponent,
	binary32Precision
} from "#compiler/ir/carriers.ts"
import { compareFloat, floatText, toReal } from "#compiler/scalar/values/float.ts"
import { assert, faulted, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** The specials a double can be beside a finite value: -0, NaN and the infinities. */
const specials: Gen<number> = element([
	-0,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY
])

/** The greatest binary32 subnormal, (2^(p - 1) - 1) · 2^least. */
const greatestSubnormal =
	(2 ** (binary32Precision.value - 1) - 1) * 2 ** binary32LeastExponent.value

/** The least magnitude a double rounds to a binary32 infinity at: binary32Max plus half its last place. */
const overflowAt = binary32Max.value + 2 ** (binary32MaxExponent.value - binary32Precision.value)

/** The greatest magnitude a nonzero double rounds to a binary32 zero at: half the least subnormal. */
const underflowAt = 2 ** (binary32LeastExponent.value - 1)

/**
 * A double the cast meets: any finite double by its place, a binary32 value, a binary32 subnormal, or a special, each a
 * named arm.
 */
const doubleGen: Gen<number> = weighted([
	[6, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[2, float(-binary32Max.value, binary32Max.value)],
	[1, float(-greatestSubnormal, greatestSubnormal)],
	[1, specials]
])

/** The bit pattern of a binary32 value, read through one scratch buffer. */
const binary32 = Object.freeze(
	(() => {
		const scratch = new Float32Array(1)
		const bits = new Int32Array(scratch.buffer)
		const of = (pattern: number): number => {
			bits[0] = pattern
			return scratch[0] ?? 0
		}
		return {
			bitsOf: (value: number): number => {
				scratch[0] = value
				return bits[0] ?? 0
			},
			/** The binary32 values on either side of a finite one: the least subnormal's beside zero. */
			neighbours: (value: number): readonly [number, number] => {
				if (value === 0) {
					return [-(2 ** binary32LeastExponent.value), 2 ** binary32LeastExponent.value]
				}
				scratch[0] = value
				const pattern = bits[0] ?? 0
				return value > 0 ? [of(pattern - 1), of(pattern + 1)] : [of(pattern + 1), of(pattern - 1)]
			}
		}
	})()
)

type RealFeature =
	| "rounded"
	| "stored exactly"
	| "a binary32 subnormal stored"
	| "realOverflow"
	| "realUnderflow"
	| "-0 stored as 0"
	| "a special kept"

/** Checks toReal on one double against binary32's rounding, and names the situation it was in. */
const realVerdict = (x: number): RealFeature => {
	const real = toReal(x)
	if (Number.isNaN(x) || !Number.isFinite(x)) {
		assert.ok(Object.is(succeeded(real), x), `${x} is kept`)
		return "a special kept"
	}
	if (Math.abs(x) >= overflowAt) {
		faulted(real, "realOverflow", `${x}`)
		return "realOverflow"
	}
	if (x !== 0 && Math.abs(x) <= underflowAt) {
		faulted(real, "realUnderflow", `${x}`)
		return "realUnderflow"
	}
	const stored = succeeded(real, `${x}`)
	assert.ok(Object.is(Math.fround(stored), stored), `${x} is stored as ${stored}, a binary32 value`)
	assert.ok(!Object.is(stored, -0), `${x} is stored as -0`)
	const distance = Math.abs(stored - x)
	for (const neighbour of binary32.neighbours(stored)) {
		const nearer = Math.abs(neighbour - x)
		assert.ok(distance <= nearer, `${neighbour} lies nearer ${x} than its stored ${stored}`)
		if (distance === nearer) {
			assert.ok((binary32.bitsOf(stored) & 1) === 0, `${x} ties, stored at the odd ${stored}`)
		}
	}
	return Object.is(x, -0)
		? "-0 stored as 0"
		: stored !== 0 && Math.abs(stored) <= greatestSubnormal
			? "a binary32 subnormal stored"
			: stored === x
				? "stored exactly"
				: "rounded"
}

/** The order a difference states: -1, 0 or 1, never -0. */
const signOf = (n: bigint): -1 | 0 | 1 => (n < 0n ? -1 : n > 0n ? 1 : 0)

/** A non-NaN double's rank among the doubles by its bit pattern, a sign and a magnitude, -0 ranked as 0. */
const rankOf = (() => {
	const scratch = new Float64Array(1)
	const bits = new BigInt64Array(scratch.buffer)
	return (value: number): bigint => {
		scratch[0] = value === 0 ? 0 : value
		const pattern = bits[0] ?? 0n
		return pattern >= 0n ? pattern : -(pattern & 0x7fff_ffff_ffff_ffffn)
	}
})()

/** PostgreSQL's float order, modelled: NaN equal to itself and above all, every other value by its rank. */
const modelOrder = (a: number, b: number): -1 | 0 | 1 =>
	Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : Number.isNaN(b) ? -1 : signOf(rankOf(a) - rankOf(b))

type OrderFeature =
	| "a NaN against another value"
	| "two NaNs"
	| "-0 against 0"
	| "an infinity"
	| "two distinct finite values"

/** The situations a pair of doubles is in. */
const orderFeatures = (a: number, b: number): ReadonlyArray<OrderFeature> => [
	...(Number.isNaN(a) !== Number.isNaN(b) ? (["a NaN against another value"] as const) : []),
	...(Number.isNaN(a) && Number.isNaN(b) ? (["two NaNs"] as const) : []),
	...(a === 0 && b === 0 && Object.is(a, -0) !== Object.is(b, -0)
		? (["-0 against 0"] as const)
		: []),
	...(Math.abs(a) === Number.POSITIVE_INFINITY || Math.abs(b) === Number.POSITIVE_INFINITY
		? (["an infinity"] as const)
		: []),
	...(Number.isFinite(a) && Number.isFinite(b) && a !== b
		? (["two distinct finite values"] as const)
		: [])
]

/** A double of the order's draw: a special or zero half the time, so pairs meet NaN, -0 and the infinities. */
const orderedGen: Gen<number> = weighted([
	[1, doubleGen],
	[1, element([-0, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

describe("real admission", () => {
	it.effect(
		"stores a double as its nearest binary32 value, ties to even and -0 as 0, and refuses exactly what the cast refuses",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "binary32's rounding thresholds and nearest neighbours, stated apart from Math.fround's rounding"
						},
						suite: "unit/values/float-1",
						draw: drawn(doubleGen),
						literal: Formatter.format,
						coverage: required<RealFeature>(
							[
								"rounded",
								"stored exactly",
								"a binary32 subnormal stored",
								"realOverflow",
								"realUnderflow",
								"-0 stored as 0",
								"a special kept"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 5000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(x, c) =>
						Effect.sync(() => {
							c.note(realVerdict(x))
						})
				)
			)
	)
})

describe("PostgreSQL's float order", () => {
	it.effect("is the model's total order, and its equality is the identity text's", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "a rank by the IEEE bit pattern, -0 as 0, with NaN above it all"
					},
					suite: "unit/values/float-2",
					draw: drawn((source) => [source.draw(orderedGen), source.draw(orderedGen)] as const),
					literal: Formatter.format,
					coverage: required<OrderFeature>(
						[
							"a NaN against another value",
							"two NaNs",
							"-0 against 0",
							"an infinity",
							"two distinct finite values"
						],
						{ cases: 400, sense: notesOnly }
					),
					kept: [],
					runs: 5000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([a, b], c) =>
					Effect.sync(() => {
						c.noteAll(orderFeatures(a, b))
						const order = compareFloat(a, b)
						assert.equal(order, modelOrder(a, b), `${a} against ${b}`)
						assert.equal(order === 0, floatText(a) === floatText(b), `${a} and ${b}'s texts`)
					})
			)
		)
	)
})
