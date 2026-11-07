import { type Equivalence, equivalence } from "@grizzle/testing/oracle"
import { Array as Arr, Equal, Formatter, Hash, Order, Record as Rec } from "effect"
import { Decimal } from "#compiler/scalar/values/decimal.ts"

/** Whether an object is a plain record: of Object's prototype or none. */
const isPlainRecord = (value: object): value is Readonly<Record<string, unknown>> => {
	const proto: unknown = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/**
 * Two values one, `numbers` comparing two doubles: a Decimal by numeric equality (1.0 is 1.00, whatever the display
 * scale), arrays and plain records element by element so a Decimal or a double anywhere inside is compared so too, and
 * every other value by Effect's structural equality.
 */
const sameValueBy = (numbers: (left: number, right: number) => boolean) => {
	const same = (left: unknown, right: unknown): boolean => {
		if (typeof left === "number" && typeof right === "number") {
			return numbers(left, right)
		}
		if (left instanceof Decimal || right instanceof Decimal) {
			return left instanceof Decimal && right instanceof Decimal && left.equals(right)
		}
		if (Arr.isArray(left) && Arr.isArray(right)) {
			return left.length === right.length && Arr.every(left, (l, i) => same(l, right[i]))
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
				Arr.every(keys, (k) => Rec.has(right, k) && same(left[k], right[k]))
			)
		}
		return Equal.equals(left, right)
	}
	return same
}

/**
 * The testing library's exact for the values grizzle delivers: structural equality, but a Decimal compared as
 * PostgreSQL's numeric equality compares it, which no structural comparison of its fields can.
 */
export const exactValue: Equivalence<unknown> = equivalence(
	sameValueBy((left, right) => Equal.equals(left, right)),
	Formatter.format
)

/**
 * Two deliveries identical, as every value is delivered in its one form: exactValue, but a double by Object.is, so a
 * delivered -0 is no 0 and NaN is NaN.
 */
export const identicalValue: Equivalence<unknown> = equivalence(
	sameValueBy((left, right) => Object.is(left, right)),
	Formatter.format
)

/**
 * A delivered value's hash, consistent with exactValue and identicalValue, so a set comparison groups by it: a Decimal
 * by its one text, which equal Decimals share; arrays and plain records by their items, a record's in key order; every
 * other value by Effect's structural hash, which Equal.equals keeps, and two doubles Object.is finds one share too.
 */
export const valueHash = (value: unknown): number => {
	if (value instanceof Decimal) {
		return Hash.string(value.text)
	}
	if (Arr.isArray(value)) {
		return Arr.reduce(value, Hash.string("array"), (hash, item) =>
			Hash.combine(hash, valueHash(item))
		)
	}
	if (typeof value === "object" && value !== null && isPlainRecord(value)) {
		return Arr.reduce(Arr.sort(Rec.keys(value), Order.String), Hash.string("record"), (hash, key) =>
			Hash.combine(Hash.combine(hash, Hash.string(key)), valueHash(value[key]))
		)
	}
	return Hash.hash(value)
}
