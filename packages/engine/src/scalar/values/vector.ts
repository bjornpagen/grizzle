import type { Brand } from "effect"
import { nominal } from "#compiler/core/brand.ts"
import {
	type CompileError,
	type EncodingFailure,
	malformedDescription,
	type ValueFault
} from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { phantom } from "#compiler/core/phantom.ts"
import * as Result from "#compiler/core/result.ts"
import {
	cosineNormMax,
	cosineNormMin,
	VectorText,
	vectorMaxDimensions
} from "#compiler/ir/carriers.ts"
import { encodingFailure, faultError } from "#compiler/scalar/values/fault.ts"

/**
 * A buffer a vector of N dimensions is made from: any Float32Array, or a Vector of N dimensions. The dimension tag rides
 * under the phantom key (core/phantom.ts), a member no runtime value holds: covariant, so a Vector<1536> is a
 * Vector<number>, and distinct per literal, so a Vector<768> is not a Vector<1536>.
 */
type VectorBuffer<N extends number = number> = Float32Array & { readonly [phantom]?: N | undefined }

/**
 * The Vector carrier of pg.vector(n).
 *
 * A Vector<N> is a Float32Array: an Effect brand (by nominal, unchecked) plus the dimension tag N, with no wrapper
 * class. `Vector.make(buffer, n)` checks the buffer's length against the dimension count and returns the same
 * buffer, branded; mutating the buffer afterwards is the caller's business. Every boundary that admits a vector, the
 * codec's and a literal's, copies its components once into a plain Float32Array grizzle alone holds, through the typed
 * array's internal slots, so a subclass's methods and a later write to the caller's buffer reach no admitted value:
 * the identity, the checks and every row text read that copy. A Float32Array's components are binary32 values by
 * construction, so there is no rounding here: a JavaScript number becomes a component through the typed array's own
 * conversion, which the caller performs. The tag N is an equality-only phantom: a Vector<1536> is not a Vector<768>,
 * and the runtime checks the length. There is no number[] anywhere in the vector API.
 *
 * Dimensions are 1..vectorMaxDimensions, pgvector's storage limit (VECTOR_MAX_DIM); the 2000-dimension HNSW limit is a
 * retrieval capability, not a value limit.
 *
 * The encode-time checks. Every component the codec writes must be finite: NaN and infinity are
 * refused with vectorNonFinite, as pgvector refuses them (CheckElement). -0 is written as 0, the signed-zero identity
 * pgvector's equality already has (vector_cmp_internal compares -0 = +0); identity texts, canonical payloads and
 * literals map it the same way. Every stored vector's native norm, pgvector's vector_norm, lies in the cosine domain
 * [cosineNormMin, cosineNormMax] (ir/carriers.ts), the norms for which pgvector's binary32 cosine_distance is a number
 * in [0, 2]. The database CHECK is the authority for stored values (physical/vector); the host boundary is
 * `norm` and `inCosineDomain`, which the codec's admission applies to every vector parameter and member (identity.ts)
 * and `Vector.from` to an explicit check. `norm` is vector_norm's own arithmetic: each binary32 component widened to
 * double, its exact square (a 24-bit by 24-bit product fits a double's 53 bits) summed in double, then the square root.
 * pgvector builds that loop with -fassociative-math, so its summation order may differ from index order and the two
 * norms can differ by rounding; near a bound the host can refuse a value the database would admit, or admit one its
 * CHECK refuses. Construction never checks the components or the domain, and neither does the conversion of vector_out
 * text, which reads what the CHECK admitted.
 *
 * Native equality is component equality of the stored float32 values; order is pgvector's vector_cmp:
 * components first, then dimensions.
 *
 * A vector of N dimensions: a Float32Array of N binary32 components under the Effect brand "Vector".
 */
export type Vector<N extends number = number> = VectorBuffer<N> & Brand.Brand<"Vector">

/**
 * The unchecked brand constructor: the dimension tag is a phantom, so the branded buffer is a Vector of any N. The
 * converter of vector_out text (convert.ts) brands the buffer it fills with it, checking nothing.
 */
const brand = nominal<Float32Array, Float32Array & Brand.Brand<"Vector">>()

const isDimensions = (n: unknown): n is number =>
	typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= vectorMaxDimensions.value

/** What a vector's read answers for a buffer it could not read: no vector. */
const notVector = (): ValueFault => "vectorType"

/** Whether a value has the vector host type: a Float32Array, branded without checking (nominal). */
export const isVector = (value: unknown): value is Vector => value instanceof Float32Array

/** The first non-finite component's refusal, or undefined when every component is finite. */
const nonFinite = (buffer: Float32Array): ValueFault | undefined => {
	for (const x of buffer) {
		if (!Number.isFinite(x)) {
			return "vectorNonFinite"
		}
	}
	return undefined
}

/**
 * The text of one component: its shortest round-trip text, -0 written as 0. A component is binary32-exact, so its text
 * read back as binary32 (pgvector's strtof input included) is exactly the component.
 */
const componentTextOf = (x: number): string => (x === 0 ? "0" : String(x))

/**
 * The shape check over a buffer as `read` takes it: `buffer` is a Float32Array of exactly `dimensions` components,
 * 1..vectorMaxDimensions. A JavaScript caller can pass anything, so both arguments are checked. Reading the buffer can
 * run the caller's code (instanceof runs a proxy's getPrototypeOf trap), so it is read once through hostRead, and a
 * value whose reading throws is refused as no vector.
 */
const shaped = <const N extends number>(
	buffer: unknown,
	dimensions: N,
	read: (buffer: Float32Array) => Float32Array
): Result.Result<Vector<N>, ValueFault> =>
	hostRead(notVector, (): Result.Result<Vector<N>, ValueFault> => {
		if (!isDimensions(dimensions)) {
			return Result.err("vectorDimensions")
		}
		if (!(buffer instanceof Float32Array)) {
			return Result.err("vectorType")
		}
		const held = read(buffer)
		if (held.length !== dimensions) {
			return Result.err("vectorDimensions")
		}
		return Result.ok(brand(held))
	})

/**
 * A fresh plain Float32Array of `buffer`'s components. The typed array constructor reads a typed array argument through
 * its internal slots, never through its methods or its iterator, so what a subclass overrides is never called and the
 * copy holds the components the buffer holds now.
 */
const copied = (buffer: Float32Array): Float32Array => new Float32Array(buffer)

/** The buffer itself. */
const same = (buffer: Float32Array): Float32Array => buffer

/**
 * The admission of a buffer: the shape check, then a copy grizzle alone holds (copied), so the admitted vector is what
 * the buffer held at admission and nothing the caller does later, or a subclass does at any time, reaches it.
 */
const admit = <const N extends number>(
	buffer: unknown,
	dimensions: N
): Result.Result<Vector<N>, ValueFault> => shaped(buffer, dimensions, copied)

/**
 * The strict constructor, the builders' throwing convenience: `Vector.make(buffer, 1536)` is a
 * Vector<1536>. It checks the length, never the components or the cosine domain, and returns the same buffer: every
 * boundary that admits it copies it then (admit).
 */
const make = <const N extends number>(
	buffer: VectorBuffer<NoInfer<N>>,
	dimensions: N
): Vector<N> => {
	const made = shaped(buffer, dimensions, same)
	if (!made.ok) {
		throw faultError(made.error, SourceLoc("Vector literal", []))
	}
	return made.value
}

/** pgvector's vector_norm: the Euclidean norm in double precision, summed in component order. */
const norm = (vector: Float32Array): number => {
	let sum = 0
	for (const x of vector) {
		sum += x * x
	}
	return Math.sqrt(sum)
}

/** Whether the norm lies in the cosine domain [cosineNormMin, cosineNormMax]. A NaN norm lies outside. */
const inCosineDomain = (vector: Float32Array): boolean => {
	const n = norm(vector)
	return n >= cosineNormMin.value && n <= cosineNormMax.value
}

/** The encode-time component check: every component finite, the norm in the cosine domain. */
const checkEncodable = (vector: Float32Array): ValueFault | undefined =>
	nonFinite(vector) ?? (inCosineDomain(vector) ? undefined : "vectorNorm")

/**
 * The encode-time boundary, read from the buffer as it is now: a Float32Array of `dimensions` finite components whose
 * native norm lies in the cosine domain [cosineNormMin, cosineNormMax], copied at admission (admit) and checked on the
 * copy, which is returned branded and never normalized. The codec's admission (identity.ts) and `Vector.from` both run
 * it.
 */
export const admitEncodable = <const N extends number>(
	buffer: unknown,
	dimensions: N
): Result.Result<Vector<N>, ValueFault> => {
	const made = admit(buffer, dimensions)
	if (!made.ok) {
		return made
	}
	const fault = checkEncodable(made.value)
	return fault === undefined ? made : Result.err(fault)
}

/**
 * The explicit validated boundary: admitEncodable, its refusal the codec's EncodingFailure with its
 * fixed fault word, never the value.
 */
const from = <const N extends number>(
	buffer: VectorBuffer<NoInfer<N>>,
	dimensions: N
): Result.Result<Vector<N>, EncodingFailure> =>
	Result.mapError(admitEncodable(buffer, dimensions), encodingFailure)

/**
 * "[c1,...,cn]", written from the buffer: each component's shortest round-trip text, -0 as 0. A non-finite component
 * is the caller's to refuse first (admitVector, the literal boundary).
 */
const componentText = (vector: Float32Array): string => {
	let text = "["
	for (const [i, component] of vector.entries()) {
		if (i > 0) {
			text += ","
		}
		text += componentTextOf(component)
	}
	return `${text}]`
}

/** pgvector's order (vector_cmp): the first differing component, then the dimension count. -0 and 0 are equal. */
const compare = (a: Float32Array, b: Float32Array): -1 | 0 | 1 => {
	const ys = b.values()
	for (const x of a.subarray(0, b.length)) {
		const next = ys.next()
		if (next.done === true) {
			break
		}
		const y = next.value
		if (x < y) {
			return -1
		}
		if (x > y) {
			return 1
		}
	}
	return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/** Equal float32 components with the same dimensions. */
const equals = (a: Float32Array, b: Float32Array): boolean =>
	a.length === b.length && compare(a, b) === 0

/**
 * The canonical form of a vector a Description carries: the frozen "~v:[c1,...,cn]" payload of its
 * components at this moment, so a later write to the buffer never reaches a built description. A non-finite
 * component has no payload and is refused.
 */
const canonical = (vector: Float32Array): Result.Result<VectorText, ValueFault> => {
	const fault = nonFinite(vector)
	if (fault !== undefined) {
		return Result.err(fault)
	}
	return Result.mapError(VectorText.of(vector), (): ValueFault => "vectorDimensions")
}

/** A fresh Float32Array of an IR vector value's components (ir/carriers.ts VectorText). */
const fromValue = (value: VectorText): Vector => brand(Float32Array.from(value.components))

/** The reviver for the canonical tag "v": a fresh Float32Array of the components `componentText` writes. */
const fromCanonical = (payload: string): Result.Result<Vector, CompileError> => {
	const parsed = VectorText.parse(payload)
	if (parsed === undefined) {
		return Result.err(
			malformedDescription(
				SourceLoc("canonical Vector", []),
				"the canonical text of a Vector: [c1,...,cn] with binary32 components"
			)
		)
	}
	return Result.ok(fromValue(parsed))
}

/** The vector operations, beside the Vector type of the same name. */
export const Vector = Object.freeze({
	branded: brand,
	admit,
	make,
	from,
	norm,
	inCosineDomain,
	componentText,
	compare,
	equals,
	canonical,
	fromValue,
	fromCanonical
})
