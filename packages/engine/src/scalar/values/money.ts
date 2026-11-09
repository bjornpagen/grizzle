import { type Canonicalizable, canonicalTag, type TaggedValue } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, type ValueFault } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { int8Digits, moneyFractionDigits, type MoneyValue } from "#compiler/ir/carriers.ts"
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

/** What a Money's make answers for minor units it could not read. */
const notMoney = (): ValueFault => "moneyType"

/** The key the one mint takes, which no other module holds. */
const minting: unique symbol = Symbol("Money")

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
	/** The brand `instanceof Money` reads: installed only by the constructor, which only this module can call. */
	readonly #minted = true

	/**
	 * The one mint. It refuses a call without the module's key, so a JavaScript caller that reaches past the private
	 * constructor, a subclass's `super` included, makes no Money: every Money is one of the checked constructors' below,
	 * its count a bigint and its text written from that count alone.
	 */
	private constructor(key: typeof minting, minorUnits: bigint) {
		if (key !== minting) {
			throw faultError("moneyType", SourceLoc("Money constructor", []))
		}
		this.minorUnits = minorUnits
		Object.freeze(this)
	}

	/**
	 * A Money is exactly what this module minted: `instanceof` reads the private brand, which no object built on
	 * Money.prototype and no proxy holds, so a forged Money is never mistaken for one and runs no code of its own.
	 */
	static [Symbol.hasInstance](value: unknown): value is Money {
		return typeof value === "object" && value !== null && #minted in value
	}

	static readonly zero: Money = new Money(minting, 0n)
	static readonly min: Money = new Money(minting, int8Min.value)
	static readonly max: Money = new Money(minting, int8Max.value)

	/** A Money value from its count of minor units: a bigint within the signed 64-bit range. */
	static make(minorUnits: unknown): Result.Result<Money, ValueFault> {
		if (typeof minorUnits !== "bigint") {
			return Result.err("moneyType")
		}
		if (minorUnits < int8Min.value || minorUnits > int8Max.value) {
			return Result.err("moneyRange")
		}
		return Result.ok(new Money(minting, minorUnits))
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
		if (typeof minorUnits !== "bigint") {
			throw faultError("moneyType", SourceLoc("Money literal", []))
		}
		return new Money(minting, minorUnits)
	}

	/**
	 * The Money of an IR money value (ir/carriers.ts MoneyValue): a Money as it is, and any other value's count admitted
	 * as a money field's is (make), since its count is the caller's; a count that is no int64 bigint is refused with
	 * CompileError MalformedDescription.
	 */
	static fromValue(value: MoneyValue): Money {
		if (value instanceof Money) {
			return value
		}
		const made = hostRead(notMoney, () => Money.make(value.minorUnits))
		if (!made.ok) {
			throw faultError(made.error, SourceLoc("Money value", []))
		}
		return made.value
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
		return new Money(minting, negative ? -units : units)
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
