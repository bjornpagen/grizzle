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
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import {
	integerRanges,
	moneyDigits,
	moneyFractionDigits,
	uuidTextLength
} from "#compiler/ir/carriers.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { IntegerCarrier, ScalarType } from "#compiler/ir/scalar.ts"
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
 * The token lengths a codec can produce, in characters: the shortest token, and the longest one, unbounded when a
 * comparator's text has no static bound (text without a proved byte bound).
 */
interface CursorTokenBound {
	readonly min: number
	readonly max: number | "unbounded"
	/** Whether every token fits within the codec's bound on a token's length, so cursorTupleOversized cannot occur. */
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
 *
 * @formatConstant ECMAScript Number::toString of a finite binary64 value: at most 25 characters
 */
const floatMaxText = 25

/**
 * The longest text of a special float or numeric value, "-Infinity".
 *
 * @formatConstant the canonical texts of NaN and the infinities: "-Infinity" the longest
 */
const specialMaxText = "-Infinity".length

/**
 * The delimiters of a bounded half-open range's text: its bracket, the comma between its ends and its parenthesis.
 *
 * @formatConstant range_out of a bounded half-open range: [start,end)
 */
const rangeDelimiters = "[,)".length

/**
 * The delimiters of a vector's text: its two brackets.
 *
 * @formatConstant vector_out: [c1,...,cn]
 */
const vectorDelimiters = "[]".length

/**
 * The longest canonical text of a decimal of at most `integer` integer digits and `fraction` fraction digits: its
 * sign, its integer digits (a zero when it has none), and its point and fraction digits when it has a fraction.
 */
const decimalMaxText = (integer: number, fraction: number): number =>
	1 + Math.max(integer, 1) + (fraction > 0 ? 1 + fraction : 0)

/** The longest canonical text of a numeric value of `integer` integer and `fraction` fraction digits, or a special's. */
const numericMaxText = (integer: number, fraction: number): number =>
	Math.max(decimalMaxText(integer, fraction), specialMaxText)

/**
 * The longest int2out, int4out or int8out text of a value of `carrier`: the longer of its range's ends' texts
 * (ir/carriers.ts integerRanges), its least value's, whose sign it spells.
 */
const integerMaxText = (carrier: IntegerCarrier): number => {
	const [least, greatest] = integerRanges[carrier]
	return Math.max(String(least).length, String(greatest).length)
}

/** The longest range_out text of a bounded half-open range over `endpoint`: its delimiters and its two ends' texts. */
const rangeMaxText = (endpoint: "int4" | "int8"): number =>
	rangeDelimiters + integerMaxText(endpoint) + integerMaxText(endpoint)

/**
 * The largest UTF-8 length of a boundary value's canonical text for this type (codec/scalar.ts), unbounded when it has
 * no static bound (text without a proved byte bound): a static bound for the token's bound. A numeric(p, s) has p - s
 * integer digits and s fraction digits, and a computed numeric the digits and the scale its bound proves.
 */
export const cursorValueMaxBytes = (type: ScalarType): number | "unbounded" => {
	switch (type.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return integerMaxText(type.carrier)
		case "numeric":
			return type.typmod === undefined
				? numericMaxText(type.bound.digits, type.bound.scale)
				: numericMaxText(type.typmod.precision - type.typmod.scale, type.typmod.scale)
		case "float4":
		case "float8":
			return floatMaxText
		case "money":
			return decimalMaxText(moneyDigits.value, moneyFractionDigits.value)
		case "bool":
			return "false".length
		case "uuid":
			return uuidTextLength
		case "text":
			return type.text.byteBound ?? "unbounded"
		case "code":
			return integerMaxText("int2")
		case "bits":
			throw defect("a set over a roster has no order, so no cursor compares one")
		case "range4":
			return rangeMaxText("int4")
		case "range8":
			return rangeMaxText("int8")
		case "vector": {
			const { dims } = type.typmod
			return vectorDelimiters + dims * floatMaxText + Math.max(dims - 1, 0)
		}
		case "exactInteger":
			return decimalMaxText(type.digits, 0)
		case "exactMoney":
			return decimalMaxText(type.digits, moneyFractionDigits.value)
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
		case "exactInteger":
			return 1
		case "money":
		case "exactMoney":
			return "0.00".length
		case "bool":
			return "true".length
		case "uuid":
			return uuidTextLength
		case "text":
			return 0
		case "code":
			return 1
		case "bits":
			throw defect("a set over a roster has no order, so no cursor compares one")
		case "range4":
		case "range8":
			return "[0,1)".length
		case "vector": {
			const { dims } = type.typmod
			return vectorDelimiters + dims + Math.max(dims - 1, 0)
		}
	}
}

const tokenBound = (
	comparators: ReadonlyArray<CursorComparator>,
	maxLength: number
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
	const shortest = base64urlLength(min)
	const longest = max === "unbounded" ? max : base64urlLength(max)
	return {
		min: shortest,
		max: longest,
		fits: longest !== "unbounded" && longest <= maxLength
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
 * The longest token a cursor codec issues or reads, in characters, the bound production passes cursorCodec: the
 * layout's own, since a token's bytes are fewer than its characters (base64url writes four characters for three
 * bytes), so no length or count in a token of at most this many characters exceeds a varint. A longer token is
 * CursorError cursorOversized, refused before any of it is decoded, and a tuple whose token would be longer is
 * cursorTupleOversized. It is bytes.ts varintMax, the largest length or count a varint of the layout writes: a token of
 * n characters holds at most n bytes, so every length and count in it is at most n.
 *
 * @formatConstant the cursor token: at most varintMax characters, one byte each in base64url
 */
export const cursorTokenMaxLength = varintMax

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
 *   token longer than the codec's bound is CursorError cursorTupleOversized: full values are never replaced by
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
 * Builds the cursor codec of an ordered query, whose tokens are at most `maxLength` characters long
 * (cursorTokenMaxLength in production, the layout's own bound, and at most it), under the installation's codes: a
 * closed id's boundary is its code, which never changes meaning, so a token stays valid across migrations, and one
 * whose code a removed handle left is refused as its value. Refuses an inconsistent spec as
 * MalformedDescription, a comparator without an equality-compatible native order as UnsupportedOperation, and an order
 * whose shortest token already exceeds `maxLength` as UnsupportedOperation: no correct bounded representation exists.
 */
export const cursorCodec = <const Cs extends ReadonlyArray<CursorComparator>>(
	spec: CursorSpec<Cs>,
	maxLength: number,
	codes: Codebook
): Result.Result<CursorCodec<Cs>, CompileError> => {
	if (maxLength > cursorTokenMaxLength) {
		return Result.err(
			unsupported(
				SourceLoc("cursor token bound", []),
				`a cursor token bound of at most ${cursorTokenMaxLength} characters, the layout's own`
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
	const codecs: ReadonlyArray<ScalarCodec> = spec.comparators.map((c) => scalarCodec(c.type, codes))
	/** Each comparator's codec, with its reader of a token's value text (value.ts). */
	const readers = codecs.map((codec) => ({ codec, read: boundaryValue(codec) }))
	const bound = tokenBound(spec.comparators, maxLength)
	if (bound.min > maxLength) {
		return Result.err(
			unsupported(
				SourceLoc("cursor comparators", []),
				`a completed order whose cursor token fits within ${maxLength} characters`
			)
		)
	}

	const generationBytes = digestBytes(generation.value)
	const queryBytes = digestBytes(query.value)
	const comparatorBytes = digestBytes(comparators.value)
	const arity = codecs.length

	/**
	 * A tuple's token. Its length is the layout's over its values' lengths (layout.ts: the digests, the count, and each
	 * value's varint length and bytes), so a tuple whose token would exceed the limit is refused at the first value that
	 * takes it past, before that value's bytes are built or anything is written.
	 */
	const admit = (tuple: unknown): Result.Result<string, CursorError> => {
		if (!isList(tuple) || tuple.length !== arity) {
			return Result.err(cursorError("cursorValue"))
		}
		const values = tuple
		const encoded: Array<Uint8Array> = []
		let length = headerBytes + varintLength(arity)
		let i = 0
		for (const codec of codecs) {
			const text = codec.encode(values[i])
			i++
			if (!text.ok) {
				return Result.err(cursorError("cursorValue"))
			}
			const valueBytes = utf8ByteLength(text.value)
			length += varintLength(valueBytes) + valueBytes
			if (base64urlLength(length) > maxLength) {
				return Result.err(cursorError("cursorTupleOversized"))
			}
			encoded.push(utf8Bytes(text.value))
		}
		return Result.ok(
			base64urlEncode(
				writeCursor({
					generation: generationBytes,
					query: queryBytes,
					comparators: comparatorBytes,
					tuple: encoded
				})
			)
		)
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
		const read = readCursor(bytes, arity)
		if (!read.ok) {
			return Result.err(cursorError("cursorMalformed"))
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
		if (fields.kind === "count") {
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
