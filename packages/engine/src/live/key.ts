import { nominal } from "#compiler/core/brand.ts"

/**
 * The coordinate a live stream places its rows by: the head fields its reset names, in key order. A read whose rows a
 * proven key keys (lower/conservative/keys.ts DeliveredKey) names that key's fields; an ordered read names its
 * completed order, so a list's `after` and a window's anchor are one coordinate; a read with no smaller proven key
 * names every head field, since a read's rows are a set. Generate records which fields, in the served file.
 */
export type KeyFields = ReadonlyArray<string>

declare const keyBrand: unique symbol

/**
 * A row's key: the decoded values of its stream's key fields, in key order (keyOf). Two keys are one exactly when
 * their values are, element by element, each compared by its one form (formOf).
 */
export type RowKey = ReadonlyArray<unknown> & { readonly [keyBrand]: true }

/**
 * A key from its values in key order, unchecked: what an event's decoder mints from the values of a key it reads, which
 * the stream's reset coordinates. Everything else derives a key from a row (keyOf).
 */
export const RowKey = nominal<ReadonlyArray<unknown>, RowKey>()

/** A head field's value in a decoded row, which a decoder builds as an own data property. */
const fieldOf = (row: object, field: string): unknown =>
	Reflect.getOwnPropertyDescriptor(row, field)?.value

/** The key of `row` under `fields`: each key field's value, in key order. */
export const keyOf = (fields: KeyFields, row: object): RowKey =>
	RowKey(fields.map((field) => fieldOf(row, field)))

/** The tags a composite value's form opens with, which no primitive equals, so forms of two shapes never meet. */
const formTags = {
	list: Symbol("list"),
	bytes: Symbol("bytes"),
	floats: Symbol("floats"),
	set: Symbol("set"),
	record: Symbol("record")
} as const

/**
 * Appends `value`'s form to `into`: a primitive as it is; a composite as its tag, its size, then its members' forms,
 * in their own order (a list's and a typed array's by index, a set's by iteration, which its decoder builds in code
 * order, a record's by its own keys, each key before its value). A decoded value is built of these alone, so equal
 * values have equal forms and a form is never read back.
 */
const pushForm = (value: unknown, into: Array<unknown>): void => {
	if (typeof value !== "object" || value === null) {
		into.push(value)
		return
	}
	if (Array.isArray(value)) {
		into.push(formTags.list, value.length)
		for (const element of value) {
			pushForm(element, into)
		}
		return
	}
	if (value instanceof Uint8Array || value instanceof Float32Array) {
		into.push(value instanceof Uint8Array ? formTags.bytes : formTags.floats, value.length)
		for (const element of value) {
			into.push(element)
		}
		return
	}
	if (value instanceof Set) {
		into.push(formTags.set, value.size)
		for (const member of value) {
			pushForm(member, into)
		}
		return
	}
	const fields = Object.keys(value)
	into.push(formTags.record, fields.length)
	for (const field of fields) {
		into.push(field)
		pushForm(fieldOf(value, field), into)
	}
}

/** A key's form: the primitives a TupleMap walks, equal exactly for keys of equal values. */
export type Form = ReadonlyArray<unknown>

/** The form of `key`: each of its values' forms in key order (pushForm). */
export const formOf = (key: RowKey): Form => {
	const into: Array<unknown> = []
	for (const value of key) {
		pushForm(value, into)
	}
	return into
}

/**
 * Whether two decoded values deliver as one: their forms' walk, read without building them, each primitive by
 * Object.is, so a row whose -0 became 0 is sent again, where a key's form takes them as one key, as PostgreSQL's
 * equality does. A diff reads it of every row a run keeps, so it allocates nothing.
 */
export const sameValue = (a: unknown, b: unknown): boolean => {
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
		return Object.is(a, b)
	}
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
	}
	if (a instanceof Uint8Array || a instanceof Float32Array) {
		return (
			(a instanceof Uint8Array ? b instanceof Uint8Array : b instanceof Float32Array) &&
			sameElements(a, b)
		)
	}
	if (a instanceof Set) {
		return b instanceof Set && a.size === b.size && sameMembers(a, b)
	}
	if (
		Array.isArray(b) ||
		b instanceof Uint8Array ||
		b instanceof Float32Array ||
		b instanceof Set
	) {
		return false
	}
	const fields = Object.keys(a)
	const others = Object.keys(b)
	return (
		fields.length === others.length &&
		fields.every(
			(field, i) => field === others[i] && sameValue(fieldOf(a, field), fieldOf(b, field))
		)
	)
}

/** Two typed arrays of one kind, element by element. */
const sameElements = (a: ArrayLike<number>, b: object): boolean => {
	if (!(b instanceof Uint8Array || b instanceof Float32Array) || a.length !== b.length) {
		return false
	}
	for (let i = 0; i < a.length; i++) {
		if (!sameValue(a[i], b[i])) {
			return false
		}
	}
	return true
}

/** Two sets of one size, member by member in iteration order, as their forms read them. */
const sameMembers = (a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean => {
	const others = b.values()
	for (const member of a) {
		const other = others.next()
		if (other.done === true || !sameValue(member, other.value)) {
			return false
		}
	}
	return true
}
