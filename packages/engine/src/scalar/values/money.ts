import { type Canonicalizable, canonicalTag, type TaggedValue } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, type ValueFault } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { MoneyValue } from "#compiler/ir/carriers.ts"
import { Decimal, roundedUnits } from "#compiler/scalar/values/decimal.ts"
import { faultError } from "#compiler/scalar/values/fault.ts"
import { int8Max, int8Min } from "#compiler/scalar/values/integer.ts"

/** The fractional digits of the fixed C.UTF-8 monetary context. */
export const moneyFractionDigits = 2

/**
 * Whether the text is a canonical decimal integer of at most 19 digits: an optional minus sign, no leading zero, and
 * no minus zero. A per-value hot path, scanned in place.
 */
const isCanonicalInteger = (text: string): boolean => {
	const start = text.startsWith("-") ? 1 : 0
	const length = text.length - start
	if (length === 0 || length > 19) {
		return false
	}
	for (let i = start; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x30 || code > 0x39) {
			return false
		}
	}
	return text.charCodeAt(start) !== 0x30 || text.length === 1
}

/**
 * The owned Money carrier of pg.money.
 *
 * PostgreSQL's money is a signed 64-bit count of fractional units, compared as that integer (cash_send, cash_eq). The
 * carrier holds exactly that count and nothing else: no currency, no locale, no floating amount.
 *
 * Conversions to and from numeric follow PostgreSQL under the fixed C.UTF-8 monetary context, whose two fractional
 * digits admission verifies: money-to-numeric divides the count by 100 exactly at
 * scale 2 (cash_numeric), and numeric-to-money multiplies by 100 and rounds half away from zero to an integer, refusing
 * a result outside int64 (numeric_cash through numeric_int8). The exact money wire form rides on these.
 */
export class Money implements Canonicalizable {
	readonly minorUnits: bigint

	private constructor(minorUnits: bigint) {
		this.minorUnits = minorUnits
		Object.freeze(this)
	}

	static readonly zero: Money = new Money(0n)
	static readonly min: Money = new Money(int8Min)
	static readonly max: Money = new Money(int8Max)

	/** A Money value from its count of minor units: a bigint within the signed 64-bit range. */
	static make(minorUnits: unknown): Result.Result<Money, ValueFault> {
		if (typeof minorUnits !== "bigint") {
			return Result.err("moneyType")
		}
		if (minorUnits < int8Min || minorUnits > int8Max) {
			return Result.err("moneyRange")
		}
		return Result.ok(new Money(minorUnits))
	}

	/** The builders' throwing convenience. */
	static of(minorUnits: bigint): Money {
		const made = Money.make(minorUnits)
		if (!made.ok) {
			throw faultError(made.error, SourceLoc("Money literal", []))
		}
		return made.value
	}

	/** The Money of an IR money value (ir/carriers.ts MoneyValue), whose count is an int64 already. */
	static fromValue(value: MoneyValue): Money {
		return new Money(value.minorUnits)
	}

	/**
	 * numeric::money: round(amount * 100) half away from zero, refused outside int64; NaN and infinity have no money
	 * value (numeric_int8 refuses them).
	 */
	static fromDecimal(amount: Decimal): Result.Result<Money, ValueFault> {
		return Money.admitDecimal(amount)
	}

	/**
	 * The admission core `fromDecimal` runs, for what a JavaScript caller may pass: a value that is not a
	 * Decimal is moneyType.
	 */
	static admitDecimal(amount: unknown): Result.Result<Money, ValueFault> {
		if (!(amount instanceof Decimal)) {
			return Result.err("moneyType")
		}
		if (!amount.isFinite()) {
			return Result.err("moneySpecial")
		}
		return Money.make(roundedUnits(amount, moneyFractionDigits))
	}

	/**
	 * The amount of money::numeric text, trusted: an optional minus sign, integer digits and at most two fractional
	 * digits, such as "-0.50" (cash_numeric writes the scale of the monetary context, which admission verifies is 2).
	 * Nothing is checked.
	 */
	static fromOutput(text: string): Money {
		const negative = text.startsWith("-")
		const start = negative ? 1 : 0
		const point = text.indexOf(".", start)
		const digits =
			point < 0
				? text.slice(start) + "0".repeat(moneyFractionDigits)
				: text.slice(start, point) + text.slice(point + 1).padEnd(moneyFractionDigits, "0")
		const units = BigInt(digits)
		return new Money(negative ? -units : units)
	}

	/** The reviver for the canonical tag "m": the minor-unit count in canonical decimal integer form. */
	static fromCanonical(payload: string): Result.Result<Money, CompileError> {
		if (!isCanonicalInteger(payload)) {
			return Result.err(
				malformedDescription(
					SourceLoc("canonical Money", []),
					"the canonical decimal integer text of a minor-unit count"
				)
			)
		}
		const made = Money.make(BigInt(payload))
		if (!made.ok) {
			return Result.err(faultError(made.error, SourceLoc("canonical Money", [])))
		}
		return Result.ok(made.value)
	}

	/**
	 * money::numeric: the exact amount at scale 2.
	 *
	 * Every int64 count at scale 2 is within the numeric format.
	 */
	toDecimal(): Decimal {
		return Decimal.fromHundredths(this.minorUnits)
	}

	/** The numeric text of the amount, such as "-12.05". Money's own text output is locale-formatted and never used. */
	toString(): string {
		return this.toDecimal().toString()
	}

	compare(that: Money): -1 | 0 | 1 {
		return this.minorUnits < that.minorUnits ? -1 : this.minorUnits > that.minorUnits ? 1 : 0
	}

	equals(that: Money): boolean {
		return this.minorUnits === that.minorUnits
	}

	[canonicalTag](): TaggedValue {
		return { tag: "m", payload: this.minorUnits.toString() }
	}
}
