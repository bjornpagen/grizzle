/** What the property of parse-decimal-bounds.test.ts reads: its space and the typing of a parse over a bounded text. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Spelled } from "#compiler/ir/desc.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { TermTyping } from "#compiler/scalar/compute/typing.ts"
import { numericTextMaxBytes } from "#compiler/scalar/lexical.ts"
import { describedDesc } from "#compiler/schema/protocol.ts"
import { baseParams, field, spelledExpr, typeWith, v } from "#test/support/unit/compute/support.ts"

/**
 * A text operand's byte bound: a few bytes, around numericTextMaxBytes, or past it by up to two hundred thousand bytes,
 * which every regex-matched text's bound (regexTextMaxBytes) is past by far.
 */
export const bytesGen: Gen<number> = oneOf([
	int(1, 64),
	int(numericTextMaxBytes - 4, numericTextMaxBytes + 4),
	int(numericTextMaxBytes + 5, 200_000)
])

/** The typing of Text.parseNumeric(t) for a column t of any text within `bytes` UTF-8 bytes. */
export const parsedOver = (bytes: number): Result.Result<TermTyping<Spelled>, CompileError> => {
	const t = field(
		describedDesc(str.bytes(bytes, str.regex("^.*$", "su")), "a bounded text"),
		"text"
	)
	return typeWith(
		spelledExpr(computeCore.parseNumeric(v("t", t)).expr),
		{ t: { kind: "column", type: t.scalar } },
		false,
		baseParams
	)
}
