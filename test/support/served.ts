import { Array as Arr, Order, Record as Rec } from "effect"
import { taggedValueOf } from "#compiler/core/canonical.ts"
import { isList, isRecord } from "#compiler/core/record.ts"

/** A path's text, its members dotted, the root's named. */
const pathText = (path: ReadonlyArray<string | number>): string =>
	path.length === 0 ? "(the root)" : Arr.join(Arr.map(path, String), ".")

/**
 * The first member at which two served values differ as the runtime reads them, its path dotted, or none: the same
 * primitive; arrays of equal length, element by element; Maps of the same entries in the same order and Sets of the same
 * members in the same order; canonical values (a Roster, a Decimal, a Money, an IR literal's text) of one class with one
 * canonical payload; records with the same members that are not undefined, whatever their prototypes, which the runtime
 * reads none of, a member left undefined being one left out.
 */
export const runtimeDifference = (
	a: unknown,
	b: unknown,
	path: ReadonlyArray<string | number> = []
): string | undefined => {
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
		return Object.is(a, b) ? undefined : pathText(path)
	}
	if (isList(a) || isList(b)) {
		if (!isList(a) || !isList(b) || a.length !== b.length) {
			return pathText(path)
		}
		for (const [i, item] of a.entries()) {
			const differs = runtimeDifference(item, b[i], [...path, i])
			if (differs !== undefined) {
				return differs
			}
		}
		return undefined
	}
	if (a instanceof Map || b instanceof Map) {
		if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) {
			return pathText(path)
		}
		return runtimeDifference([...a], [...b], [...path, "entries"])
	}
	if (a instanceof Set || b instanceof Set) {
		if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) {
			return pathText(path)
		}
		return runtimeDifference([...a], [...b], [...path, "members"])
	}
	const taggedA = taggedValueOf(a)
	const taggedB = taggedValueOf(b)
	if (taggedA !== undefined || taggedB !== undefined) {
		return taggedA !== undefined &&
			taggedB !== undefined &&
			Object.getPrototypeOf(a) === Object.getPrototypeOf(b) &&
			taggedA.tag === taggedB.tag &&
			taggedA.payload === taggedB.payload
			? undefined
			: pathText(path)
	}
	if (!isRecord(a) || !isRecord(b)) {
		return pathText(path)
	}
	const keys = Arr.sort(
		Arr.dedupe(
			Arr.filter([...Rec.keys(a), ...Rec.keys(b)], (k) => a[k] !== undefined || b[k] !== undefined)
		),
		Order.String
	)
	for (const key of keys) {
		const differs = runtimeDifference(a[key], b[key], [...path, key])
		if (differs !== undefined) {
			return differs
		}
	}
	return undefined
}
