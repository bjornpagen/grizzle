import { Array as Arr, Order, Record as Rec } from "effect"
import { taggedValueOf } from "#compiler/core/canonical.ts"
import { isList, isRecord } from "#compiler/core/record.ts"

/** A path's text, its members dotted, the root's named. */
const pathText = (path: ReadonlyArray<string | number>): string =>
	path.length === 0 ? "(the root)" : Arr.join(Arr.map(path, String), ".")

/** The first member at which two served values under `path` differ (runtimeDifference), its path dotted, or none. */
const differenceAt = (
	a: unknown,
	b: unknown,
	path: ReadonlyArray<string | number>
): string | undefined => {
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
		return Object.is(a, b) ? undefined : pathText(path)
	}
	if (isList(a) || isList(b)) {
		if (!isList(a) || !isList(b) || a.length !== b.length) {
			return pathText(path)
		}
		for (const [i, item] of a.entries()) {
			const differs = differenceAt(item, b[i], [...path, i])
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
		return differenceAt([...a], [...b], [...path, "entries"])
	}
	if (a instanceof Set || b instanceof Set) {
		if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) {
			return pathText(path)
		}
		return differenceAt([...a], [...b], [...path, "members"])
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
		const differs = differenceAt(a[key], b[key], [...path, key])
		if (differs !== undefined) {
			return differs
		}
	}
	return undefined
}

/**
 * The first member at which two served values differ as the runtime reads them, its path dotted, or none: the same
 * primitive; arrays of equal length, element by element; Maps of the same entries in the same order and Sets of the same
 * members in the same order; canonical values (a Roster, a Decimal, a Money, an IR literal's text) of one class with one
 * canonical payload; records with the same members that are not undefined, whatever their prototypes, which the runtime
 * reads none of, a member left undefined being one left out.
 */
export const runtimeDifference = (a: unknown, b: unknown): string | undefined =>
	differenceAt(a, b, [])

/** The path of the first string under a member named `sql` within a served value, its records walked in key order. */
export const firstSql = (
	value: unknown,
	path: ReadonlyArray<string | number>
): ReadonlyArray<string | number> | undefined => {
	if (isList(value)) {
		for (const [i, item] of value.entries()) {
			const found = firstSql(item, [...path, i])
			if (found !== undefined) {
				return found
			}
		}
		return undefined
	}
	if (!isRecord(value) || value instanceof Map || value instanceof Set) {
		return undefined
	}
	for (const key of Arr.sort(Rec.keys(value), Order.String)) {
		const member = value[key]
		const found =
			key === "sql" && typeof member === "string"
				? [...path, key]
				: firstSql(member, [...path, key])
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

/** A served value with the string at `path` replaced by what `edit` makes of it, every value beside the path its own. */
export const editedAt = (
	value: unknown,
	path: ReadonlyArray<string | number>,
	edit: (text: string) => string
): unknown => {
	const [head, ...rest] = path
	if (head === undefined) {
		return typeof value === "string" ? edit(value) : value
	}
	if (isList(value) && typeof head === "number") {
		return Arr.map(value, (item, i) => (i === head ? editedAt(item, rest, edit) : item))
	}
	if (isRecord(value) && typeof head === "string") {
		return { ...value, [head]: editedAt(value[head], rest, edit) }
	}
	return value
}
