import { defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { LawField } from "#compiler/ir/law.ts"

/** Columns allocated one per field, each paired with its field's handle where it is allocated: `pairs` in field order,
 * `columns` the columns alone, and `of` the column of one of the fields. A column is what a statement or a function
 * allocates for a field: an output column's name, or a parameter at its position. `of` is the one site of the fact "a
 * field a statement reads is one of those its columns were allocated for": a statement allocates columns over a list of
 * its relation's fields and reads them back for a subset it derives elsewhere (a unique object's fields, the primary
 * key, a predicate's), and no type ties a handle to the list it was allocated over. */
export interface FieldColumns<Column> {
	readonly pairs: ReadonlyArray<{ readonly field: LawField; readonly column: Column }>
	readonly columns: ReadonlyArray<Column>
	readonly of: (field: LawField) => Column
}

export const fieldColumns = <Column>(
	fields: ReadonlyArray<LawField>,
	allocate: (field: LawField, position: number) => Column
): FieldColumns<Column> => {
	const pairs = fields.map((field, position) => ({ field, column: allocate(field, position) }))
	const byField = new Map(pairs.map((p) => [p.field, p.column] as const))
	return {
		pairs,
		columns: pairs.map((p) => p.column),
		of: (field) => defined(byField.get(field), `the column of the field ${field.name}`)
	}
}

/** The members of `items` by `key`, compared as a Map compares its keys: each group nonempty with its members in input
 * order, the groups in the order their first members come. */
export const groupBy = <A, K>(
	items: Iterable<A>,
	key: (a: A) => K
): ReadonlyArray<readonly [K, NonEmptyReadonlyArray<A>]> => {
	const groups = new Map<K, [A, ...Array<A>]>()
	for (const a of items) {
		const k = key(a)
		const group = groups.get(k)
		if (group === undefined) {
			groups.set(k, [a])
		} else {
			group.push(a)
		}
	}
	return [...groups]
}

/** `f`'s nonempty lists for each element in order, concatenated: nonempty. */
export const flatMapNonEmpty = <A, B>(
	xs: NonEmptyReadonlyArray<A>,
	f: (a: A, i: number) => NonEmptyReadonlyArray<B>
): NonEmptyReadonlyArray<B> => {
	const [first, ...rest] = mapNonEmpty(xs, f)
	return [...first, ...rest.flat()]
}

/** The one member of a list of exactly one, undefined for any other length. */
export const only = <T extends object>(list: ReadonlyArray<T>): T | undefined =>
	list.length === 1 ? list[0] : undefined

/** A host value a relation parameter can be read from: an object whose Symbol.iterator is a method. */
export const isIterable = (value: unknown): value is Iterable<unknown> =>
	typeof value === "object" &&
	value !== null &&
	Symbol.iterator in value &&
	typeof value[Symbol.iterator] === "function"
