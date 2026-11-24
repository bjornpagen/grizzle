import { Formatter } from "effect"
import { type KeyedList, sameValue } from "#compiler/live/index.ts"

/**
 * A read's value compared as its contract states it (live/keyed.ts): two values keyed by the same fields are one when
 * they hold the same rows in the same order, each with its key, each row compared by its decoded value (live/key.ts
 * sameValue).
 */
export const sameKeyed = <Row extends object>(a: KeyedList<Row>, b: KeyedList<Row>): boolean => {
	if (!sameValue(a.fields, b.fields) || a.size !== b.size) {
		return false
	}
	const others = b.entries()
	for (const entry of a.entries()) {
		const other = others.next()
		if (
			other.done === true ||
			!sameValue(entry.key, other.value.key) ||
			!sameValue(entry.row, other.value.row)
		) {
			return false
		}
	}
	return true
}

/** A value as a report prints it: its key fields and its rows in order. */
export const printKeyed = <Row extends object>(value: KeyedList<Row>): string =>
	`keyed by ${Formatter.format(value.fields)}: ${Formatter.format([...value])}`
