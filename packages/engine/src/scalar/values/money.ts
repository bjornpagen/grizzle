import { type Canonicalizable, canonicalTag, type TaggedValue } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, type ValueFault } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import {
	int8Digits,
	int8Max,
	int8Min,
	moneyFractionDigits,
	type MoneyValue
} from "#compiler/ir/carriers.ts"
import { Decimal, roundedUnits } from "#compiler/scalar/values/decimal.ts"
import { faultError } from "#compiler/scalar/values/fault.ts"

/**
 * Whether the text is a canonical decimal integer of at most int8Digits digits: an optional minus sign, no leading
 * zero, and no minus zero. A per-value hot path, scanned in place.
 */
const isCanonicalInteger = (text: string): boolean => {
	const start = text.startsWith("-") ? 1 : 0
	const length = text.length - start
	if (length === 0 || length > int8Digits.value) {
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
 * carrier holds exactly a count and nothing else: no currency, no locale, no floating amount. A money field's count is
 * a signed 64-bit one (make); an exact amount, money arithmetic's value, is a count of any size (exact).
 *
 * Conversions to and from numeric follow PostgreSQL under the fixed C.UTF-8 monetary context, whose fraction digits
 * admission verifies (ir/carriers.ts moneyFractionDigits): money-to-numeric divides the count by
 * 10^moneyFractionDigits exactly at that scale (cash_numeric), and numeric-to-money multiplies by it and rounds half
 * away from zero to an integer, refusing a result outside int64 (numeric_cash through numeric_int8). The exact money
 * wire form rides on these.
 */
export class Money implements Canonicalizable {
	readonly minorUnits: bigint

	private constructor(minorUnits: bigint) {
		this.minorUnits = minorUnits
		Object.freeze(this)
	}

	static readonly zero: Money = new Money(0n)
	static readonly min: Money = new Money(int8Min.value)
	static readonly max: Money = new Money(int8Max.value)

	/** A Money value from its count of minor units: a bigint within the signed 64-bit range. */
	static make(minorUnits: unknown): Result.Result<Money, ValueFault> {
		if (typeof minorUnits !== "bigint") {
			return Result.err("moneyType")
		}
		if (minorUnits < int8Min.value || minorUnits > int8Max.value) {
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

	/**
	 * An exact amount: a count of minor units of any size, the value of money arithmetic and of a money sum (ir/scalar.ts
	 * ExactType exactMoney). A money field admits only a signed 64-bit count (make), which Compute.cast narrows into
	 * where it is proved to fit.
	 */
	static exact(minorUnits: bigint): Money {
		return new Money(minorUnits)
	}

	/** The Money of an IR money value (ir/carriers.ts MoneyValue), whose count is an int64 already. */
	static fromValue(value: MoneyValue): Money {
		return new Money(value.minorUnits)
	}

	/**
	 * numeric::money: round(amount * 10^moneyFractionDigits) half away from zero, refused outside int64; NaN and
	 * infinity have no money value (numeric_int8 refuses them).
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
		return Money.make(roundedUnits(amount, moneyFractionDigits.value))
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
				? text.slice(start) + "0".repeat(moneyFractionDigits.value)
				: text.slice(start, point) + text.slice(point + 1).padEnd(moneyFractionDigits.value, "0")
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
	 * money::numeric: the exact amount, in the Decimal's one form ("12.5" for 1250 minor units).
	 *
	 * Every int64 count of minor units is within the numeric format.
	 */
	toDecimal(): Decimal {
		return Decimal.fromMinorUnits(this.minorUnits)
	}

	/**
	 * The amount with its two fixed fractional digits, such as "-12.05" or "12.50", written from the minor-unit count:
	 * money::numeric's text, the canonical text of a Money. Money's own text output is locale-formatted and never used.
	 */
	toString(): string {
		const negative = this.minorUnits < 0n
		const digits = (negative ? -this.minorUnits : this.minorUnits)
			.toString()
			.padStart(moneyFractionDigits.value + 1, "0")
		const point = digits.length - moneyFractionDigits.value
		return `${negative ? "-" : ""}${digits.slice(0, point)}.${digits.slice(point)}`
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
