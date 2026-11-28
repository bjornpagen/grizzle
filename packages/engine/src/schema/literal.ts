import { isPlainRecord } from "#compiler/core/record.ts"
import { validateText } from "#compiler/core/text.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { isVector, Vector } from "#compiler/scalar/values/vector.ts"
import { malformed } from "#compiler/schema/protocol.ts"

/** A number's literal: NaN and the infinities wrapped, every other number itself. */
const numberLiteral = (value: number): LiteralDesc =>
	Number.isNaN(value)
		? { float: "NaN" }
		: value === Number.POSITIVE_INFINITY
			? { float: "Infinity" }
			: value === Number.NEGATIVE_INFINITY
				? { float: "-Infinity" }
				: value

/**
 * A literal with no descriptor to adopt: an operand of a term whose type this package does not know (a scalar
 * expression of another package). The host kind alone decides; the checker types it against the term it meets.
 */
export const untypedLiteral = (value: unknown, label: string): LiteralDesc => {
	switch (typeof value) {
		case "bigint":
		case "boolean":
			return value
		case "number":
			return numberLiteral(value)
		case "string": {
			const text = validateText(value)
			if (text.ok) {
				return text.value
			}
			throw malformed(label, describeFault(text.error))
		}
		case "function":
		case "object":
		case "symbol":
		case "undefined":
			break
	}
	if (value instanceof Numeric || value instanceof Money) {
		return value
	}
	if (isVector(value)) {
		const canonical = Vector.canonical(value)
		if (canonical.ok) {
			return canonical.value
		}
		throw malformed(label, describeFault(canonical.error))
	}
	if (isPlainRecord(value) && Object.hasOwn(value, "start") && Object.hasOwn(value, "end")) {
		const { start, end } = value
		if (typeof start === "bigint" && typeof end === "bigint" && start < end) {
			return { span: { start, end } }
		}
		if (
			typeof start === "number" &&
			typeof end === "number" &&
			Number.isInteger(start) &&
			Number.isInteger(end) &&
			start < end
		) {
			return { span: { start, end } }
		}
	}
	throw malformed(
		label,
		"a literal: a number, bigint, boolean, string, Numeric, Money, Vector or range"
	)
}
