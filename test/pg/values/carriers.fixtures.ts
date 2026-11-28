/** What the properties of carriers.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { double } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, pipe, String as Str } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { makeSpan } from "#compiler/scalar/values/span.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { succeeded } from "#test/support/assert.ts"
import type { InputVerdict } from "#test/support/pg/vector/support.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"
import { upTo } from "#test/support/up-to.ts"

/** A batch of up to `max` values, a case's one recordset. */
export const batchOf = <A>(values: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	array(values, { min: 1, max })

/** One row of one column, trusted from what PostgreSQL answers. */
export const oneCellOf = (rows: unknown): readonly [readonly [unknown]] =>
	trusted<readonly [readonly [unknown]]>(rows)

export const pgFloatArray = (text: unknown): ReadonlyArray<number> => {
	const inner = pipe(String(text), Str.slice(1, -1))
	return inner.length === 0 ? [] : Arr.map(Str.split(inner, ","), Number)
}

/** The pinned pgvector installation's schema, quoted, and its vector type. */
export const vectorTypeOf = (db: CaseSession) =>
	Effect.map(
		db.values(
			"SELECT n.nspname::text FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'",
			[]
		),
		(rows) => {
			const extension = quoteIdent(String(rows[0]?.[0]))
			return { extension, vectorType: `${extension}."vector"` }
		}
	)

/** The binary64 midpoint between FLT_MAX and 2^128: nearest-even rounds it, and everything above it, to infinity. */
const overflowTie = 2 ** 128 - 2 ** 103

/**
 * Binary64 values whose binary32 rounding is a tie or an edge: a tie to even down to 1 and one up to 1 + 2^-22, a
 * subnormal tie, the smallest subnormal, FLT_MAX, and the largest values that still round to FLT_MAX.
 */
const roundingEdges: Arr.NonEmptyReadonlyArray<number> = [
	-0,
	0,
	1 + 2 ** -24,
	1 + 3 * 2 ** -24,
	1.5 * 2 ** -149,
	2 ** -149,
	-(2 ** -149),
	3.4028234663852886e38,
	overflowTie - 2 ** 75,
	-(overflowTie - 2 ** 75)
]

/**
 * A float8[] literal that PostgreSQL reads back as exactly these binary64 values: JavaScript's number text is the
 * shortest round-trip form, and -0 keeps its sign.
 */
export const float8ArrayText = (xs: ReadonlyArray<number>): string =>
	`{${Arr.join(
		Arr.map(xs, (x) => (Object.is(x, -0) ? "-0" : String(x))),
		","
	)}}`

/** Every int4 span of bounds within -5..5, its lower bound below its upper. */
const spanBounds = nonEmpty(
	Arr.flatMap(Arr.range(-5, 4), (lower) =>
		Arr.map(
			upTo(4 - lower, (i) => lower + 1 + i),
			(upper) => [lower, upper] as const
		)
	),
	"every span of bounds within -5..5"
)

/**
 * A vector input: its first components, drawn, and its length, theirs or near the storage limit, the rest ones. A
 * component is any binary64 across and past binary32's range, a rounding edge, NaN or an infinity.
 */
interface InputSketch {
	readonly head: Arr.NonEmptyReadonlyArray<number>
	readonly length: number
}

/**
 * The binary64 values cast to real and then to vector: float8_to_float4 refuses an overflow and an underflow to zero
 * (22003) as it casts each in order, then pgvector's array_to_vector refuses a length past the limit (54000) and then a
 * non-finite component (22000).
 */
export const binaryVerdict = (xs: ReadonlyArray<number>): InputVerdict => {
	for (const x of xs) {
		const rounded = Math.fround(x)
		if ((Number.isFinite(x) && !Number.isFinite(rounded)) || (x !== 0 && rounded === 0)) {
			return "22003"
		}
	}
	if (xs.length > vectorMaxDimensions) {
		return "54000"
	}
	return Arr.every(xs, Number.isFinite) ? "admitted" : "22000"
}

/** What a vector input reached. */
export type InputFeature =
	| "admitted"
	| "at the storage limit"
	| "a component past binary32"
	| "a non-finite component"
	| "past the storage limit"
	| "an underflow read as zero"

/** A component of a vector input. */
const inputComponent: Gen<number> = oneOf([
	(source) => {
		const negative = source.draw(boolean)
		const m = source.draw(double(1, 2 - 2 ** -52))
		const e = source.draw(int(-160, 135))
		return (negative ? -1 : 1) * m * 2 ** e
	},
	element(roundingEdges),
	element([
		overflowTie,
		-overflowTie,
		2 ** -150,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY
	])
])

export const inputGen: Gen<InputSketch> = (source) => {
	const head = nonEmpty(source.draw(array(inputComponent, { min: 1, max: 4 })), "a component")
	return {
		head,
		length: source.draw(
			weighted([
				[3, constant(head.length)],
				[1, int(vectorMaxDimensions - 1, vectorMaxDimensions + 1)]
			])
		)
	}
}

/** A sketch's components: its head, then ones up to its length. */
export const inputOf = (sketch: InputSketch): ReadonlyArray<number> =>
	Arr.appendAll(sketch.head, ones(Math.max(0, sketch.length - sketch.head.length)))

const ones = (n: number) => Array.from({ length: n }, () => 1)

/** The host's encode-time construction of the binary64 inputs once a Float32Array holds them. */
export const hostVector = (xs: ReadonlyArray<number>) =>
	Vector.from(Float32Array.from(xs), xs.length)

export const span = map(element(spanBounds), ([a, b]) => succeeded(makeSpan("int4", a, b)))

/**
 * Components drawn across the whole binary32 exponent range, subnormals included, with mantissas that are
 * arbitrary binary64 values so most of them need rounding. The float8-to-real cast raises on underflow and
 * on overflow (float8_to_float4), so the drawn magnitudes stay strictly between the binary32 underflow tie
 * 2^-150 and the overflow tie 2^128 - 2^103, by construction: at the least exponent, -150, the mantissa
 * stays above 1, and at the greatest, 127, below 2 - 2^-24; the input search below draws past both.
 */
const magnitude: Gen<number> = (source) => {
	const negative = source.draw(boolean)
	const e = source.draw(int(-150, 127))
	const m = source.draw(
		e === -150
			? double(1 + 2 ** -52, 2 - 2 ** -52)
			: e === 127
				? double(1, 2 - 2 ** -23)
				: double(1, 2 - 2 ** -52)
	)
	return (negative ? -1 : 1) * m * 2 ** e
}

export const components = array(oneOf([magnitude, element(roundingEdges)]), { min: 1, max: 12 })

export const sameComponents = (pg: ReadonlyArray<number>, host: ReadonlyArray<number>) =>
	pg.length === host.length && Arr.every(pg, (x, k) => x === host[k])

export const vector = map(array(element([-1, -0, 0, 0.5, 1]), { min: 1, max: 3 }), (xs) =>
	Vector.make(Float32Array.from(xs), xs.length)
)
