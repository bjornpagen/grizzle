import {
	type CompileError,
	EncodingFailure,
	malformedDescription,
	type ValueFault,
	valueFaultWords
} from "#compiler/core/errors.ts"
import { bytesMaxLength } from "#compiler/core/limits.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import {
	cosineNormMax,
	cosineNormMin,
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale,
	vectorMaxDimensions
} from "#compiler/ir/carriers.ts"

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
		"an exact decimal: a Decimal, a bigint, or an exact decimal string, never a JavaScript number",
	decimalType: "an exact decimal: a Decimal, a bigint, or an exact decimal string",
	decimalSyntax:
		"an exact decimal literal: digits with an optional fraction and exponent, NaN, or Infinity",
	decimalRange: `a numeric within PostgreSQL's format: below 10^${numericMaxIntegerDigits.value} with at most ${numericMaxFractionDigits.value} fractional digits`,
	numericTypmod: `a numeric precision 1-${numericMaxPrecision.value} and scale ${numericMinScale.value}-${numericMaxScale.value}, both integers`,
	numericOverflow:
		"a numeric that rounds to fewer integer digits than its precision less its scale",
	numericInfinity: "a finite numeric: a field with a precision cannot hold an infinite value",
	moneyType: "a money amount as a bigint count of minor units",
	moneyRange: "a money amount within the signed 64-bit minor-unit range",
	moneySpecial: "a finite money amount: NaN and infinity have no money value",
	integerType:
		"an integer host value: a JavaScript integer for smallint and integer, a bigint for bigint",
	integerRange: "an integer within the PostgreSQL type's signed range",
	floatType: "a JavaScript number",
	realOverflow: "a real within binary32 range: the value overflows to infinity in single precision",
	realUnderflow:
		"a real within binary32 range: the nonzero value underflows to zero in single precision",
	boolType: "a boolean",
	uuidSyntax: "a uuid in the hyphenated 8-4-4-4-12 hexadecimal form",
	dateSyntax:
		"a calendar date in ISO 8601's extended form YYYY-MM-DD, a day from 0001-01-01 to 9999-12-31",
	textType: "a string",
	textNul: "text without NUL: PostgreSQL text cannot store U+0000",
	textSurrogate: "well-formed text: an unpaired UTF-16 surrogate is not a Unicode scalar",
	bytesType: "bytes: a Uint8Array",
	bytesLength: `bytes one bytea holds: at most ${bytesMaxLength.value} bytes`,
	bytesChanged:
		"bytes its caller leaves as they were from their admission to their send: a value changed meanwhile is refused rather than sent unlike the identity the write worked out from it",
	bytesCollision:
		"bytes whose SHA-256 digest no other bytes value of the write shares: two different values of one digest are a SHA-256 collision, refused rather than taken as one",
	bytesLiteral:
		"bytes in no literal: a bytes value is written and read back whole, never a rule's or a query's constant",
	codeHandle: "a handle of the closed relation's roster",
	bitsType: "a set of handles: a Set whose members are strings",
	bitsMember: "a set of handles of the closed relation's roster",
	spanType: "a span: an object with exactly the fields start and end",
	spanEndpoint:
		"a span endpoint of the endpoint type: an integer number for integer, a bigint for bigint, in range",
	spanOrder: "a nonempty span: start < end",
	spanWidth: "a span of the declared fixed width: end - start equals the width",
	vectorType: "a vector: a Float32Array of its components",
	vectorDimensions: `vector dimensions: an integer 1-${vectorMaxDimensions.value} that the components match`,
	vectorNonFinite: "a finite vector component: NaN and infinity are not vector values",
	vectorNorm: `a vector whose native norm lies in the cosine domain [${cosineNormMin.value}, ${cosineNormMax.value}]`,
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
