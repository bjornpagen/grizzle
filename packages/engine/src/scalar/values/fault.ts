import { sha256Octets } from "#compiler/core/digest.ts"
import {
	type CompileError,
	EncodingFailure,
	malformedDescription,
	type ValueFault,
	valueFaultWords
} from "#compiler/core/errors.ts"
import { maxAllocSize } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import {
	binary32MaxExponent,
	binary32MinExponent,
	binary32Precision
} from "#compiler/scalar/values/float.ts"

/**
 * A varlena's header, VARHDRSZ, which translate's result allocation counts beside its characters.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the header of one variable-length datum, uncompressed and in line: a numeric, a text, a range, a vector
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/c.h#L787
 * @quote #define VARHDRSZ ((int32) sizeof(int32))
 * @verified 2026-11-20
 */
export const varlenaHeaderBytes = 4

/**
 * The most bytes one bytes value holds, the most one bytea holds: a value arrives in binary, which bytearecv copies into
 * an allocation of its bytes and its header, and palloc refuses an allocation past MaxAllocSize, which also bounds a
 * varlena's length word, so no bytea of any writer is longer. A longer value is refused at its boundary (bytesLength),
 * before any SQL.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one bytes value, one bytea, as bytearecv reads it from a binary parameter
 * @derivation bytearecv allocates "result = (bytea *) palloc(nbytes + VARHDRSZ);" for a value of nbytes bytes
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/bytea.c#L365, verified 2026-11-20),
 *   and "#define AllocSizeIsValid(size) ((Size) (size) <= MaxAllocSize)"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/memutils.h#L42), so nbytes is at most
 *   MaxAllocSize - VARHDRSZ
 * @from {@link maxAllocSize}, {@link varlenaHeaderBytes}
 */
export const byteaMaxLength = maxAllocSize - varlenaHeaderBytes

/**
 * The most bytes PostgreSQL holds of a tsvector's lexemes and positions, and of a tsquery's operands: a document or a
 * query past it is refused where it is made, "string is too long for tsvector" or "value is too big in tsquery" (54000).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's full text search
 * @unit bytes
 * @scope the lexemes and positions of one tsvector, and the operands of one tsquery
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/tsearch/ts_type.h#L52
 * @quote #define MAXSTRPOS ( (1<<20) - 1)
 * @verified 2026-11-20
 */
export const textSearchStringMaxBytes = (1 << 20) - 1

/**
 * The most UTF-8 bytes one lexeme of a search document holds: tsvectorin refuses a longer one, "word is too long (2048
 * bytes, max 2047 bytes)" (54000).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's full text search
 * @unit bytes
 * @scope one lexeme of one tsvector, as tsvectorin reads it
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/tsearch/ts_type.h#L51
 * @quote #define MAXSTRLEN ( (1<<11) - 1)
 * @verified 2026-11-21
 */
export const searchLexemeMaxBytes = (1 << 11) - 1

/**
 * The greatest position a lexeme of a search document holds: tsvectorin stores a greater one as this one (LIMITPOS), so
 * a text that states one would be stored as another document than it spells.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's full text search
 * @unit positions
 * @scope one position of one lexeme of one tsvector
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/tsearch/ts_type.h#L91
 * @quote #define MAXENTRYPOS (1<<14)
 * @verified 2026-11-21
 */
export const searchPositionMax = (1 << 14) - 1

/**
 * The most positions one lexeme of a search document holds: tsvectorin keeps a lexeme's first this many distinct
 * positions and drops the rest, so a text that states more would be stored as another document than it spells.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's full text search
 * @unit positions
 * @scope the positions of one lexeme of one tsvector
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/tsearch/ts_type.h#L82
 * @quote #define MAXNUMPOS	(256)
 * @verified 2026-11-21
 */
export const searchPositionsMax = 256

/**
 * The greatest precision a numeric typmod declares.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the precision p of numeric(p, s): a field's, a cast's, a parameter's or a typed literal's
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/numeric.h#L35
 * @quote #define NUMERIC_MAX_PRECISION 1000
 * @verified 2026-11-20
 */
export const numericMaxPrecision = 1000

/**
 * The least scale a numeric typmod declares: a negative scale rounds to a power of ten.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the scale s of numeric(p, s)
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/numeric.h#L37
 * @quote #define NUMERIC_MIN_SCALE (-1000)
 * @verified 2026-11-20
 */
export const numericMinScale = -1000

/**
 * The greatest scale a numeric typmod declares.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the scale s of numeric(p, s)
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/numeric.h#L38
 * @quote #define NUMERIC_MAX_SCALE 1000
 * @verified 2026-11-20
 */
export const numericMaxScale = 1000

/**
 * The most integer digits a numeric value has, |x| < 10^numericMaxIntegerDigits: past it PostgreSQL's arithmetic raises
 * 22003 "value overflows numeric format", so a numeric expression whose proved bound passes it is ResourceBound, and one
 * over an operand bounded by nothing but it is admitted at it (resultDigits).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the integer digits of every numeric value, a computed one's bound included
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/datatype.sgml#L399
 * @quote up to 131072 digits before the decimal point; up to 16383 digits after the decimal point
 * @verified 2026-11-20
 */
export const numericMaxIntegerDigits = 131072

/**
 * The most fraction digits a numeric value has: NUMERIC_DSCALE_MAX, past which numeric multiplication rounds
 * (numeric.c mul_var's caller) and a value's text is refused.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the fraction digits of every numeric value, a computed one's bound included
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/datatype.sgml#L399
 * @quote up to 131072 digits before the decimal point; up to 16383 digits after the decimal point
 * @verified 2026-11-20
 */
export const numericMaxFractionDigits = 16383

/**
 * The integer digits a numeric result is bounded by, `needed` its making's bound over operands of `operands` integer
 * digits: `needed` itself, where it lies within numeric's own limit or every operand is proved within it, so a bound past
 * the limit is the compilation's to refuse (ResourceBound); and numeric's own limit where it passes the limit over an
 * operand already at it, a value bounded by nothing proved but the limit, numeric's (numericOwnBound). There no bound
 * the operands have keeps the result within the limit, and none is missing: PostgreSQL enforces its own, refusing a
 * value past it with 22003, numeric_value_out_of_range, as the host's arithmetic refuses it ("format",
 * scalar/compute/numeric.ts). Every numeric result's bound is read here: an operation's (scalar/compute/bounds.ts
 * ownLimited) and an aggregate's (scalar/aggregate.ts).
 */
export const resultDigits = (needed: number, operands: ReadonlyArray<number>): number =>
	needed > numericMaxIntegerDigits && operands.some((digits) => digits >= numericMaxIntegerDigits)
		? numericMaxIntegerDigits
		: needed

/**
 * numeric's own limits as a bound (ir/scalar.ts NumericBound): numericMaxIntegerDigits integer digits and
 * numericMaxFractionDigits fraction digits, which every numeric value lies within, the bound of numeric of no typmod
 * as numeric declares it (scalar/registry.ts numericOwnLimits).
 */
export const numericOwnBound: { readonly digits: number; readonly scale: number } = Object.freeze({
	digits: numericMaxIntegerDigits,
	scale: numericMaxFractionDigits
})

/**
 * The cosine domain, the norms between cosineNormMin and cosineNormMax inclusive, as vector_norm computes them: the
 * norms of the vectors pgvector's cosine_distance is a number in [0, 2] for. pgvector 0.8.7's VectorCosineSimilarity
 * (src/vector.c) accumulates the dot product and both squared norms in binary32 floats, in any order and with fused
 * multiply-adds (the Makefile's -fassociative-math -ffp-contract=fast), and returns similarity / sqrt(norma * normb),
 * clamped to [-1, 1] unless it is NaN. A zero norma or normb makes it 0 / 0, NaN, and an infinite one Infinity /
 * Infinity or 0, so the distance is NaN or not the vectors'; and HNSW's vector_cosine_ops never indexes a vector whose
 * vector_norm is not positive (src/hnswutils.c HnswCheckNorm), so an approximate search would miss it. Within the
 * domain every accumulator is positive and finite, the quotient finite, and the clamp yields [0, 2].
 *
 * The least norm keeps norma positive. Its largest square rounds to a positive binary32 value only when it exceeds
 * 2^(emin - p), half the least subnormal, which rounds to zero; a vector of n components has a square of at least
 * norm^2 / n, and with n below 2^ceil(log2(n + 1)) the norm 2^ceil((emin - p + ceil(log2(n + 1))) / 2) makes every
 * vector of at most vectorMaxDimensions components have one, strictly, its 2.4% margin (2^14 / 16000) far above
 * vector_norm's own double rounding. A sum of nonnegative roundings is at least its largest term.
 *
 * @limitKind derived
 * @owner pgvector 0.8.7 cosine_distance over IEEE 754-2019 binary32
 * @unit a vector norm
 * @scope the norm of every vector a column stores, a parameter binds and a literal states
 * @derivation 2^ceil((emin - p + ceil(log2(n + 1))) / 2), n = vectorMaxDimensions: the largest of n squares of a
 *   vector of this norm exceeds 2^(emin - p), so it rounds to a positive binary32 value
 * @from {@link binary32Precision}, {@link binary32MinExponent}, {@link vectorMaxDimensions}
 */
export const cosineNormMin =
	2 **
	Math.ceil(
		(binary32MinExponent - binary32Precision + Math.ceil(Math.log2(vectorMaxDimensions + 1))) / 2
	)

/**
 * The greatest norm keeps every accumulator finite. A binary32 sum rounds to Infinity once it reaches 2^(emax + 1) -
 * 2^(emax - p), the midpoint past the greatest finite value; n rounded products and n roundings of nonnegative partial
 * sums, in any order, are at most (1 + 2^-p)^n times the exact norm^2, and the dot product's partial sums at most that
 * times |a| |b| (Cauchy-Schwarz). So the greatest power of two whose square times (1 + 2^-p)^n stays below the midpoint
 * bounds both, with every partial sum at most the total; binary64's range holds norma * normb, between 2^-298 and
 * 2^254, exactly.
 *
 * @limitKind derived
 * @owner pgvector 0.8.7 cosine_distance over IEEE 754-2019 binary32
 * @unit a vector norm
 * @scope the norm of every vector a column stores, a parameter binds and a literal states
 * @derivation 2^floor(log2((2^(emax + 1) - 2^(emax - p)) / (1 + 2^-p)^n) / 2), n = vectorMaxDimensions: a squared norm
 *   or dot product of vectors of this norm, summed in binary32, stays below the midpoint that rounds to Infinity
 * @from {@link binary32Precision}, {@link binary32MaxExponent}, {@link vectorMaxDimensions}
 */
export const cosineNormMax =
	2 **
	Math.floor(
		Math.log2(
			(2 ** (binary32MaxExponent + 1) - 2 ** (binary32MaxExponent - binary32Precision)) /
				(1 + 2 ** -binary32Precision) ** vectorMaxDimensions
		) / 2
	)

/**
 * The refusal vocabulary of the exact value carriers.
 *
 * A value boundary refuses a host value with one fixed word, never with the value itself: diagnostics never contain
 * parameter values. The carriers return `Result<_, ValueFault>`; each caller maps the
 * word onto its own tagged error:
 *
 * - a builder (a literal, a closed fact) into CompileError MalformedDescription, through `faultError`;
 * - a parameter or member encoder into EncodingFailure, through `encodingFailure`.
 *
 * The words are declared in core/errors.ts (valueFaultWords), where they join the codec vocabulary
 * EncodingFailure.reason names.
 */
const valueFaults: { readonly [F in ValueFault]: string } = {
	decimalNumber:
		"an exact decimal: a Numeric, a bigint, or an exact decimal string, never a JavaScript number",
	decimalType: "an exact decimal: a Numeric, a bigint, or an exact decimal string",
	decimalSyntax:
		"an exact decimal literal: digits with an optional fraction and exponent, NaN, or Infinity",
	decimalRange: `a numeric within PostgreSQL's format: below 10^${numericMaxIntegerDigits} with at most ${numericMaxFractionDigits} fractional digits`,
	numericTypmod: `a numeric precision 1-${numericMaxPrecision} and scale ${numericMinScale}-${numericMaxScale}, both integers`,
	numericScale:
		"a numeric of at most its scale's fractional digits, a multiple of 10^-scale at a negative scale: a value its column would round is refused, never rounded",
	numericOverflow:
		"a numeric of fewer integer digits than its precision less its scale, as its column stores it",
	numericInfinity: "a finite numeric: a field with a precision cannot hold an infinite value",
	numericNaN:
		"an integer: numeric(p, 0) holds integers alone, its host value a bigint, so never NaN",
	numericBound:
		"a numeric within its computed bound (numeric.within): NaN, an infinity, or a finite value below 10^digits in magnitude and a multiple of 10^-scale, a value of the bound refused rather than stored past it",
	moneyType: "a money amount as a bigint count of minor units",
	moneyRange: "a money amount within the signed 64-bit minor-unit range",
	moneySpecial: "a finite money amount: NaN and infinity have no money value",
	integerType:
		"an integer host value: a JavaScript integer for int2 and int4, a bigint for int8 and numeric(p, 0)",
	integerRange: "an integer within the PostgreSQL type's signed range",
	floatType: "a JavaScript number",
	realInexact:
		"a real that is a binary32 value exactly: a double binary32 cannot hold is refused, never rounded to the nearest one",
	realOverflow: "a real within binary32 range: the value overflows to infinity in single precision",
	realUnderflow:
		"a real within binary32 range: the nonzero value underflows to zero in single precision",
	boolType: "a boolean",
	uuidSyntax: "a uuid in the hyphenated 8-4-4-4-12 hexadecimal form",
	dateSyntax:
		"a calendar date in ISO 8601's extended form YYYY-MM-DD, a day from 0001-01-01 to 9999-12-31",
	inetSyntax:
		"an inet: a text PostgreSQL's inet_in reads, an IPv4 or IPv6 address with an optional /mask length",
	cidrSyntax:
		"a cidr: a text PostgreSQL's cidr_in reads, an IPv4 or IPv6 network with an optional /mask length",
	cidrHostBits:
		"a cidr whose address has no bit set right of its mask: a network, never an address within one, as PostgreSQL refuses it",
	textType: "a string",
	textNul: "text without NUL: PostgreSQL text cannot store U+0000",
	textSurrogate: "well-formed text: an unpaired UTF-16 surrogate is not a Unicode scalar",
	bytesType: "bytea: a Uint8Array",
	bytesLength: `bytes one bytea holds: at most ${byteaMaxLength} bytes`,
	bytesChanged:
		"bytes its caller leaves as they were from their admission to their send: a value changed meanwhile is refused rather than sent unlike the identity the write worked out from it",
	bytesCollision:
		"bytes whose SHA-256 digest no other bytes value of the write shares: two different values of one digest are a SHA-256 collision, refused rather than taken as one",
	bytesLiteral:
		"bytes in no literal: a bytea value is written and read back whole, never a rule's or a query's constant",
	sha256Value: `a SHA-256 digest: a Uint8Array of exactly ${sha256Octets} bytes`,
	sha256Syntax: `a SHA-256 digest's hex: exactly ${sha256Octets} pairs of lowercase hex digits`,
	codeHandle: "a handle of the closed relation's roster",
	codeSubset: "a handle of the subset of its roster the closed id holds",
	bitsType: "a set of handles: a Set whose members are strings",
	bitsMember: "a set of handles of the closed relation's roster",
	spanType: "a range: an object with exactly the fields start and end",
	spanEndpoint:
		"a range endpoint of the endpoint type: an integer number for int4, a bigint for int8, in range",
	spanOrder: "a nonempty range: start < end",
	spanWidth: "a range of the declared fixed width: end - start equals the width",
	vectorType: "a vector: a Float32Array of its components",
	vectorDimensions: `vector dimensions: an integer 1-${vectorMaxDimensions} that the components match`,
	vectorNonFinite: "a finite vector component: NaN and infinity are not vector values",
	vectorNorm: `a vector whose native norm lies in the cosine domain [${cosineNormMin}, ${cosineNormMax}]`,
	searchDocumentForm: `a search document as PostgreSQL prints it (tsvectorout): its lexemes quoted, each once in ascending byte order, its positions ascending within a lexeme, each at most ${searchPositionMax} and at most ${searchPositionsMax} of them; a text tsvectorin would store as another document is refused`,
	searchDocumentSize: `a search document tsvectorin holds: each lexeme at most ${searchLexemeMaxBytes} UTF-8 bytes, its lexemes and positions at most ${textSearchStringMaxBytes} bytes`,
	variantType:
		"a variant value: a plain object of its arm's handle as `tag` and exactly that arm's fields, none NULL",
	variantTag: "a variant value whose `tag` is the handle of one of its arms, the arm it holds",
	factShape: "a fact: a plain object with exactly the heading's fields"
}

export const isValueFault = (value: unknown): value is ValueFault =>
	valueFaultWords.some((word) => word === value)

/** What the refused position needed, for a diagnostic's `capability`. */
export const describeFault = (fault: ValueFault): string => valueFaults[fault]

/** A builder's refusal of a malformed literal or closed fact. */
export const faultError = (fault: ValueFault, loc: SourceLoc): CompileError =>
	malformedDescription(loc, describeFault(fault))

/** An encoder's refusal of a whole value, which no slot frames. */
export const encodingFailure = (fault: ValueFault): EncodingFailure =>
	EncodingFailure.make({ reason: { _tag: fault }, place: { _tag: "Fact" } })
