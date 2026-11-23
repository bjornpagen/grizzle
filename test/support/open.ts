/**
 * Open relations, as a test declares them. A relation is closed by default: its facts are inserted, never changed or
 * deleted. A relation a test puts or deletes is open, `mutable(R)` inside a unit whose heading its primary key leads
 * with (schema/own.ts ownUnits). A test's open relations sit each in the unit over its primary key's first field: one
 * unit per field and type, so relations whose keys lead with one field of one type share it, and no two such units nest,
 * a heading of one field leading another only where the two are one.
 */
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr } from "effect"
import { descText, type FieldDesc } from "#compiler/ir/desc.ts"
import { describedDesc } from "#compiler/schema/protocol.ts"
import { mutableBuilder, unitBuilder } from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { Mutable, UnitBase } from "#compiler/types/schema/statements.ts"
import {
	type AuthoredStatementDesc,
	type FixtureField,
	mutable as mutableDesc,
	unit as unitDesc
} from "#test/support/fixtures/ir/desc.ts"

/** A relation as a test states it: its name, its fields' types by name, and its primary key, its first field leading. */
export interface Openable<T> {
	readonly name: string
	readonly fields: Readonly<Record<string, T>>
	readonly primaryKey: ReadonlyArray<string>
}

/** A unit's heading of one field: the field and its type, and the unit's name, the field's and its place among its types. */
export interface Leading<T> {
	readonly name: string
	readonly field: string
	readonly type: T
}

/**
 * The headings `relations` lead with, one over each primary key's first field, once per field and type (`textOf`, the
 * type's text, telling types apart), in the order the relations first lead with it. A unit is named by its field and its
 * place among the types that field leads a key with, `a0`, `a1`, ….
 */
export const leadingHeadings = <T>(
	relations: ReadonlyArray<Openable<T>>,
	textOf: (type: T, at: string) => string
): ReadonlyArray<Leading<T>> => {
	const byField = new Map<string, ReadonlyArray<string>>()
	const headings: Array<Leading<T>> = []
	for (const r of relations) {
		const field = defined(r.primaryKey[0], `${r.name}'s primary key`)
		const type = defined(r.fields[field], `${r.name}.${field}`)
		const text = textOf(type, `${r.name}.${field}`)
		const types = byField.get(field) ?? []
		if (types.includes(text)) {
			continue
		}
		byField.set(field, [...types, text])
		headings.push({ name: `${field}${types.length}`, field, type })
	}
	return headings
}

/** A field type's text, which tells two types apart as a unit's heading and a member's key field are compared. */
const typeText = (desc: FieldDesc, at: string): string => {
	const text = descText(desc)
	if (!text.ok) {
		throw new Error(`the type of ${at} has no text: ${text.error.message}`)
	}
	return text.value
}

/** The units `relations` sit in, one over each primary key's first field (leadingHeadings), as schema values. */
const leadingUnits = (relations: ReadonlyArray<Openable<FieldBase>>): ReadonlyArray<UnitBase> =>
	Arr.map(
		leadingHeadings(relations, (type, at) => typeText(describedDesc(type, at), at)),
		(h) => unitBuilder(h.name, { [h.field]: h.type }, [])
	)

/** `relations` open: the units they lead with (leadingUnits), then each one's `mutable`. */
export const opened = <R extends Openable<FieldBase>>(
	relations: ReadonlyArray<R>
): ReadonlyArray<UnitBase | Mutable<R>> => [
	...leadingUnits(relations),
	...Arr.map(relations, (r) => mutableBuilder(r))
]

/** A fixture field's type: a declaration's, or a bare type as it is. */
const fixtureType = (field: FixtureField): FieldDesc => ("writing" in field ? field.type : field)

/**
 * `relations` open, as descriptions state them, each a relation description as the schema lists it: the units they
 * lead with, then each one's `mutable`.
 */
export const openedDescs = (
	relations: ReadonlyArray<Openable<FixtureField>>
): ReadonlyArray<AuthoredStatementDesc> => [
	...Arr.map(
		leadingHeadings(relations, (field, at) => typeText(fixtureType(field), at)),
		(h) => unitDesc(h.name, { [h.field]: fixtureType(h.type) })
	),
	...Arr.map(relations, (r) => mutableDesc(r.name))
]
