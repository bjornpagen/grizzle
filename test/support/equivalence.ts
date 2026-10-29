import { type Equivalence, equivalence } from "@grizzle/testing/oracle"
import { Array as Arr, Equal, Formatter, Record as Rec } from "effect"
import { Decimal } from "#compiler/scalar/values/decimal.ts"

/** Whether an object is a plain record: of Object's prototype or none. */
const isPlainRecord = (value: object): value is Readonly<Record<string, unknown>> => {
	const proto: unknown = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/**
 * Two values one under PostgreSQL's value identity: a Decimal by numeric equality (1.0 is 1.00, whatever the display
 * scale), arrays and plain records element by element so a Decimal anywhere inside is compared so too, and every other
 * value by Effect's structural equality.
 */
const sameValue = (left: unknown, right: unknown): boolean => {
	if (left instanceof Decimal || right instanceof Decimal) {
		return left instanceof Decimal && right instanceof Decimal && left.equals(right)
	}
	if (Arr.isArray(left) && Arr.isArray(right)) {
		return left.length === right.length && Arr.every(left, (l, i) => sameValue(l, right[i]))
	}
	if (
		typeof left === "object" &&
		left !== null &&
		typeof right === "object" &&
		right !== null &&
		isPlainRecord(left) &&
		isPlainRecord(right)
	) {
		const keys = Rec.keys(left)
		return (
			keys.length === Rec.keys(right).length &&
			Arr.every(keys, (k) => Rec.has(right, k) && sameValue(left[k], right[k]))
		)
	}
	return Equal.equals(left, right)
}

/**
 * The testing library's exact for the values grizzle delivers: structural equality, but a Decimal compared as
 * PostgreSQL's numeric equality compares it, which no structural comparison of its fields can.
 */
export const exactValue: Equivalence<unknown> = equivalence(sameValue, Formatter.format)
