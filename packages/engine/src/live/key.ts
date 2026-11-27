import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { nominal } from "#compiler/core/brand.ts"
import { type TextsId, textsId } from "#compiler/core/text.ts"

/**
 * The coordinate a live stream places its rows by: the head fields its reset names, in key order, the fields of the
 * completed order its read delivers them in (served/forms.ts ServedKey), so an upsert's `after` and a window's anchor
 * are one coordinate. Generate records which fields, in the served file.
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

/**
 * The words a value's form spells its members' kinds by, each one unit no other opens with: a text, which the form
 * holds apart as it is (`formOf`); a number, a bigint, true, false, undefined and NULL; and the tags a composite value
 * opens with, so forms of two shapes never meet.
 */
const formWords = {
	text: "s",
	number: "n",
	bigint: "b",
	true: "t",
	false: "f",
	undefined: "u",
	null: "z",
	list: "L",
	bytes: "B",
	floats: "F",
	set: "S",
	record: "R"
} as const

/** What ends a number's or a bigint's spelling in a form's shape: no number's text holds it. */
const formEnd = ";"

/** A form as it is built: its shape's words, and its texts in order. */
interface FormParts {
	readonly shape: Array<string>
	readonly texts: Array<string>
}

/**
 * Appends a number's word and spelling: its text, so 0 and -0 are one, as are any two NaNs, as a Map compares them
 * (SameValueZero), and every other two numbers two; but -0 apart from 0 where `zeros` holds them apart, a variant's
 * field's, whose variant's one equality, its identity, does (ir/codes.ts FieldLayout `zero`), as its key does.
 */
const pushNumber = (value: number, into: FormParts, zeros: "one" | "apart"): void => {
	into.shape.push(
		formWords.number,
		zeros === "apart" && Object.is(value, -0) ? "-0" : String(value),
		formEnd
	)
}

/**
 * Appends `value`'s form to `into`: a text as itself, apart, and its word in the shape; any other primitive as its
 * word and its spelling there; a composite as its tag, its size, then its members' forms, in their own order (a list's
 * and a typed array's by index, a set's by iteration, which its decoder builds in code order, a record's by its own
 * keys, each key before its value). A decoded value is built of these alone, so equal values have equal forms and a
 * form is never read back.
 */
const pushForm = (value: unknown, into: FormParts): void => {
	switch (typeof value) {
		case "string":
			into.shape.push(formWords.text)
			into.texts.push(value)
			return
		case "number":
			pushNumber(value, into, "one")
			return
		case "bigint":
			into.shape.push(formWords.bigint, value.toString(), formEnd)
			return
		case "boolean":
			into.shape.push(value ? formWords.true : formWords.false)
			return
		case "undefined":
			into.shape.push(formWords.undefined)
			return
		case "symbol":
		case "function":
			defect("a decoded value is a primitive, a list, a typed array, a set or a record")
		case "object":
			break
	}
	if (value === null) {
		into.shape.push(formWords.null)
		return
	}
	if (Array.isArray(value)) {
		into.shape.push(formWords.list)
		pushNumber(value.length, into, "one")
		for (const element of value) {
			pushForm(element, into)
		}
		return
	}
	if (value instanceof Uint8Array || value instanceof Float32Array) {
		into.shape.push(value instanceof Uint8Array ? formWords.bytes : formWords.floats)
		pushNumber(value.length, into, "one")
		for (const element of value) {
			pushNumber(element, into, "one")
		}
		return
	}
	if (value instanceof Set) {
		into.shape.push(formWords.set)
		pushNumber(value.size, into, "one")
		for (const member of value) {
			pushForm(member, into)
		}
		return
	}
	const fields = Object.keys(value)
	into.shape.push(formWords.record)
	pushNumber(fields.length, into, "one")
	for (const field of fields) {
		into.shape.push(formWords.text)
		into.texts.push(field)
		const member = fieldOf(value, field)
		if (typeof member === "number") {
			pushNumber(member, into, "apart")
		} else {
			pushForm(member, into)
		}
	}
}

/**
 * The form of `key`, each of its values' forms in key order (pushForm): an identity of texts (core/text.ts TextsId),
 * its shape, the words of its values' members in order and every non-text member spelled, then each text member as it
 * is, equal exactly for keys of equal values. A word opens with a unit no other does and a spelling ends where formEnd
 * stands, so a shape and its texts spell one key alone; no text is joined, and a map of forms is a TextsMap, which
 * hashes them by their digest: a key's texts are a row's, of any length, and V8 hashes a text past 16,383 units by its
 * length alone.
 */
export const formOf = (key: RowKey): TextsId => {
	const into: FormParts = { shape: [], texts: [] }
	for (const value of key) {
		pushForm(value, into)
	}
	return textsId([into.shape.join(""), ...into.texts])
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
