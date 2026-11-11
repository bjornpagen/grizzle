import { Formatter } from "effect"
import { type Keyed, type ReadShape, sameValue } from "#compiler/live/index.ts"

/**
 * A read's value compared as its contract states it (live/keyed.ts): two values of one shape keyed by the same fields
 * are one when they hold the same rows, each row compared by its decoded value (live/key.ts sameValue); a list's in
 * order, each with its key; a set's whatever order its keys arrived in, which says nothing.
 */
export const sameKeyed = <S extends ReadShape, Row extends object>(
	a: Keyed<S, Row>,
	b: Keyed<S, Row>
): boolean => {
	if (a.shape !== b.shape || !sameValue(a.fields, b.fields) || a.size !== b.size) {
		return false
	}
	if (a.shape === "list") {
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
	for (const entry of a.entries()) {
		const other = b.at(entry.form)
		if (other === undefined || !sameValue(entry.row, other.row)) {
			return false
		}
	}
	return true
}

/** A value as a report prints it: its shape, its key fields and its rows in order. */
export const printKeyed = <S extends ReadShape, Row extends object>(value: Keyed<S, Row>): string =>
	`${value.shape} keyed by ${Formatter.format(value.fields)}: ${Formatter.format([...value])}`
