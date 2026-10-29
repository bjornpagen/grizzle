import {
	base64urlDecode,
	base64urlEncode,
	base64urlLength
} from "#compiler/codec/cursor/base64url.ts"

import {
	bytesEqual,
	utf8ByteLength,
	utf8Bytes,
	utf8Text,
	varintLength,
	varintMax
} from "#compiler/codec/cursor/bytes.ts"
import { cursorError } from "#compiler/codec/cursor/fault.ts"
import {
	type CursorComparator,
	type CursorDigest,
	type CursorGeneration,
	comparatorDigest,
	digestBytes,
	generationDigest,
	queryDigest
} from "#compiler/codec/cursor/identity.ts"
import { headerBytes, readCursor, writeCursor } from "#compiler/codec/cursor/layout.ts"
import { boundaryValue } from "#compiler/codec/cursor/value.ts"
import { type ScalarCodec, scalarCodec } from "#compiler/codec/scalar.ts"
import { type CompileError, type CursorError, unsupported } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import type { NumericTypmod, ScalarType } from "#compiler/ir/scalar.ts"
import { type CarrierHost, isHostValue } from "#compiler/scalar/values/identity.ts"

/** The host value of one comparator's type. */
export type CursorValue<T extends ScalarType> = CarrierHost[T["carrier"]]

/** The comparison tuple of a comparator sequence, position by position. */
type CursorTuple<Cs extends ReadonlyArray<CursorComparator>> = {
	readonly [K in keyof Cs]: Cs[K] extends CursorComparator<infer T extends ScalarType>
		? CursorValue<T>
		: never
}

interface DecodedCursor<Cs extends ReadonlyArray<CursorComparator>> {
	/** The boundary values, the decoded host values of the comparators' carriers. */
	readonly values: CursorTuple<Cs>
	/** Each value's canonical text, the seek predicate's parameter text (bound untyped and cast to the base type). */
	readonly texts: ReadonlyArray<string>
}

export interface CursorSpec<Cs extends ReadonlyArray<CursorComparator>> {
	/**
	 * The canonical fingerprint of the ordered query: semantic, independent of SQL aliases, the page size and the
	 * request variant.
	 */
	readonly query: string
	/** The completed order, possibly empty for the zero-column result. */
	readonly comparators: Cs
	readonly generation: CursorGeneration
}

/**
 * The token lengths a codec can produce, in characters: the shortest token, and the longest one, unbounded when a comparator's text has no static bound (text without a proved bound, unconstrained numeric).
 */
interface CursorTokenBound {
	readonly min: number
	readonly max: number | "unbounded"
	/** Whether every token fits within the codec's byte bound, so cursorTupleOversized cannot occur. */
	readonly fits: boolean
}

export interface CursorCodec<Cs extends ReadonlyArray<CursorComparator>> {
	readonly comparators: Cs
	readonly identity: {
		readonly generation: CursorDigest
		readonly query: CursorDigest
		readonly comparators: CursorDigest
	}
	readonly bound: CursorTokenBound
	readonly encode: (tuple: CursorTuple<Cs>) => Result.Result<string, CursorError>
	/**
	 * encode's admission core: the same checks over a tuple from any caller, so a value a JavaScript caller passes
	 * outside the comparators' types is refused as encode refuses it.
	 */
	readonly admit: (tuple: unknown) => Result.Result<string, CursorError>
	readonly decode: (token: unknown) => Result.Result<DecodedCursor<Cs>, CursorError>
}

/**
 * The longest shortest-round-trip text of a binary64 value (ECMAScript Number::toString): a sign, then 17 digits
 * written positionally after "0.00000" below 1e-5 (25 characters), or with a point and an exponent such as "e-308"
 * (24 characters); integers below 1e21 have at most 21 digits.
 */
const floatMaxText = 25
const specialMaxText = "-Infinity".length

const numericMaxText = ({ precision: p, scale: s }: NumericTypmod): number =>
	Math.max(1 + Math.max(p - s, 1) + (s > 0 ? 1 + s : 0), specialMaxText)

/**
 * The largest UTF-8 length of a boundary value's canonical text for this type (codec/scalar.ts), unbounded when it has
 * no static bound (text without a proved byte bound, numeric without a typmod): a static bound for the token's bound.
 */
export const cursorValueMaxBytes = (type: ScalarType): number | "unbounded" => {
	switch (type.carrier) {
		case "int2":
			return 6
		case "int4":
			return 11
		case "int8":
			return 20
		case "numeric":
			return type.typmod === undefined ? "unbounded" : numericMaxText(type.typmod)
		case "float4":
		case "float8":
			return floatMaxText
		case "money":
			return "-92233720368547758.08".length
		case "bool":
			return 5
		case "uuid":
			return 36
		case "text":
			return type.text.byteBound ?? "unbounded"
		case "enum":
			return Math.max(0, ...type.roster.handles.map(utf8ByteLength))
		case "range4":
			return 25
		case "range8":
			return 43
		case "vector": {
			const { dims } = type.typmod
			return 2 + dims * floatMaxText + Math.max(dims - 1, 0)
		}
	}
}

/** The smallest UTF-8 length of a boundary value's canonical text for this type. */
export const cursorValueMinBytes = (type: ScalarType): number => {
	switch (type.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
			return 1
		case "money":
			return "0.00".length
		case "bool":
			return "true".length
		case "uuid":
			return 36
		case "text":
			return 0
		case "enum":
			return Math.min(...type.roster.handles.map(utf8ByteLength))
		case "range4":
		case "range8":
			return "[0,1)".length
		case "vector": {
			const { dims } = type.typmod
			return 2 + dims + Math.max(dims - 1, 0)
		}
	}
}

const tokenBound = (
	comparators: ReadonlyArray<CursorComparator>,
	maxBytes: number
): CursorTokenBound => {
	const count = varintLength(comparators.length)
	let min = headerBytes + count
	let max: number | "unbounded" = headerBytes + count
	for (const c of comparators) {
		const lo = cursorValueMinBytes(c.type)
		min += varintLength(lo) + lo
		const hi = cursorValueMaxBytes(c.type)
		max = max === "unbounded" || hi === "unbounded" ? "unbounded" : max + varintLength(hi) + hi
	}
	const minLength = base64urlLength(min)
	const maxLength = max === "unbounded" ? max : base64urlLength(max)
	return {
		min: minLength,
		max: maxLength,
		fits: maxLength !== "unbounded" && maxLength <= maxBytes
	}
}

/**
 * Whether `values` is a comparison tuple of the comparators: one value per comparator, each of the host type of that
 * comparator's carrier.
 */
const isCursorTuple = <Cs extends ReadonlyArray<CursorComparator>>(
	comparators: Cs,
	values: ReadonlyArray<unknown>
): values is CursorTuple<Cs> =>
	values.length === comparators.length &&
	comparators.every((c, i) => isHostValue(c.type.carrier, values[i]))

/**
 * The cursor codec of one ordered query.
 *
 * `cursorCodec` is built once per ordered template from its semantic identity: the ordered-query fingerprint, the
 * completed comparator sequence and the semantic generation. It returns two straight-line closures (no eval):
 *
 * - `encode` makes the opaque token of one delivered edge from its comparison tuple. The values must be the ones the
 *   row decoder produced from the database output, never recomputed from presentation values. Each is
 *   admitted again through its carrier and written as the parameter codec's canonical text, so -0 is one zero, NaN
 *   is NaN, a bigint and a Decimal keep every digit, and text keeps every scalar (supplementary planes included). A
 *   token longer than the codec's byte bound is CursorError cursorTupleOversized: full values are never replaced by
 *   hashes.
 * - `decode` validates a caller's token on the host before any SQL is issued, in this order, and returns the boundary
 *   values or the first refusal as CursorError (fault.ts): type, size, base64url, layout, generation, query,
 *   comparator sequence, tuple arity (cursorMalformed, checked here because the count is meaningful only against a
 *   matching comparator sequence; fault.ts), and each value's reading (value.ts). The boundary's seek parameter is
 *   the canonical text of the value read.
 *
 * The token is unsigned and unencrypted by design: every value in it is already in the caller's edges, a tampered
 * boundary only moves the page boundary of a query the caller can already run, and the digests bind a token to its
 * query and generation.
 *
 * Every token is stateless: it names a boundary of the live query and is accepted by any later page of that query.
 *
 * Builds the cursor codec of an ordered query, whose tokens are at most `maxBytes` long (core/policy.ts cursorMaxBytes
 * in production; at most the layout's largest field length, bytes.ts varintMax). Refuses an inconsistent spec as
 * MalformedDescription, a comparator without an equality-compatible native order as UnsupportedOperation, and an order
 * whose shortest token already exceeds `maxBytes` as UnsupportedOperation: no correct bounded representation exists.
 */
export const cursorCodec = <const Cs extends ReadonlyArray<CursorComparator>>(
	spec: CursorSpec<Cs>,
	maxBytes: number
): Result.Result<CursorCodec<Cs>, CompileError> => {
	if (maxBytes > varintMax) {
		return Result.err(
			unsupported(
				SourceLoc("cursor byte bound", []),
				`a cursor byte bound of at most ${varintMax}, the layout's largest field length`
			)
		)
	}
	const generation = generationDigest(spec.generation)
	if (!generation.ok) {
		return Result.err(generation.error)
	}
	const query = queryDigest(spec.query)
	if (!query.ok) {
		return Result.err(query.error)
	}
	const comparators = comparatorDigest(spec.comparators)
	if (!comparators.ok) {
		return Result.err(comparators.error)
	}
	const codecs: ReadonlyArray<ScalarCodec> = spec.comparators.map((c) => scalarCodec(c.type))
	/** Each comparator's codec, with its reader of a token's value text (value.ts). */
	const readers = codecs.map((codec) => ({ codec, read: boundaryValue(codec) }))
	const bound = tokenBound(spec.comparators, maxBytes)
	if (bound.min > maxBytes) {
		return Result.err(
			unsupported(
				SourceLoc("cursor comparators", []),
				`a completed order whose cursor token fits within ${maxBytes} bytes`
			)
		)
	}

	const generationBytes = digestBytes(generation.value)
	const queryBytes = digestBytes(query.value)
	const comparatorBytes = digestBytes(comparators.value)
	const maxLength = maxBytes
	const arity = codecs.length

	/**
	 * A tuple's token. The token's text is longer than its bytes, which hold every encoded value, so a tuple whose
	 * values alone exceed the limit is refused before any value's bytes are built or anything is written.
	 */
	const admit = (tuple: unknown): Result.Result<string, CursorError> => {
		if (!isList(tuple) || tuple.length !== arity) {
			return Result.err(cursorError("cursorValue"))
		}
		const values = tuple
		const encoded: Array<Uint8Array> = []
		let total = 0
		let i = 0
		for (const codec of codecs) {
			const text = codec.encode(values[i])
			i++
			if (!text.ok) {
				return Result.err(cursorError("cursorValue"))
			}
			total += utf8ByteLength(text.value)
			if (total > maxLength) {
				return Result.err(cursorError("cursorTupleOversized"))
			}
			encoded.push(utf8Bytes(text.value))
		}
		const bytes = writeCursor({
			generation: generationBytes,
			query: queryBytes,
			comparators: comparatorBytes,
			tuple: encoded
		})
		const token = base64urlEncode(bytes)
		return token.length > maxLength
			? Result.err(cursorError("cursorTupleOversized"))
			: Result.ok(token)
	}
	const encode = (tuple: CursorTuple<Cs>): Result.Result<string, CursorError> => admit(tuple)

	const decode = (token: unknown): Result.Result<DecodedCursor<Cs>, CursorError> => {
		if (typeof token !== "string") {
			return Result.err(cursorError("cursorType"))
		}
		if (token.length > maxLength) {
			return Result.err(cursorError("cursorOversized"))
		}
		const bytes = base64urlDecode(token)
		if (bytes === undefined) {
			return Result.err(cursorError("cursorEncoding"))
		}
		const read = readCursor(bytes)
		if (!read.ok) {
			return Result.err(cursorError(read.error))
		}
		const fields = read.value
		if (!bytesEqual(fields.generation, generationBytes)) {
			return Result.err(cursorError("cursorGeneration"))
		}
		if (!bytesEqual(fields.query, queryBytes)) {
			return Result.err(cursorError("cursorQuery"))
		}
		if (!bytesEqual(fields.comparators, comparatorBytes)) {
			return Result.err(cursorError("cursorComparator"))
		}
		if (fields.tuple.length !== arity) {
			return Result.err(cursorError("cursorMalformed"))
		}
		const values: Array<unknown> = []
		const texts: Array<string> = []
		let i = 0
		for (const reader of readers) {
			const valueBytes = fields.tuple[i]
			i++
			if (valueBytes === undefined) {
				return Result.err(cursorError("cursorMalformed"))
			}
			const text = utf8Text(valueBytes)
			if (text === undefined) {
				return Result.err(cursorError("cursorValue"))
			}
			const value = reader.read(text)
			if (!value.ok) {
				return Result.err(cursorError("cursorValue"))
			}
			values.push(value.value)
			texts.push(reader.codec.text(value.value))
		}
		const frozen = Object.freeze(values)
		if (!isCursorTuple(spec.comparators, frozen)) {
			return Result.err(cursorError("cursorValue"))
		}
		return Result.ok({ values: frozen, texts: Object.freeze(texts) })
	}

	return Result.ok(
		Object.freeze({
			comparators: spec.comparators,
			identity: Object.freeze({
				generation: generation.value,
				query: query.value,
				comparators: comparators.value
			}),
			bound: Object.freeze(bound),
			encode,
			admit,
			decode
		})
	)
}
