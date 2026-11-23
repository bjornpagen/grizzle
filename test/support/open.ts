/**
 * Open relations, as a test declares them. A relation is closed by default: its facts are inserted, never changed or
 * deleted. A relation a test puts or deletes is open, `mutable(R)` inside a unit whose heading its primary key leads
 * with (schema/own.ts ownUnits). A test's open relations sit each in the unit over its primary key's first field: one
 * unit per field and type, so relations whose keys lead with one field of one type share it, and no two such units nest,
 * a heading of one field leading another only where the two are one. A unit is named by its heading as a reader reads
 * it, its field and its type's name, `id_uuid`, so one heading is one unit wherever it is stated, on every level that
 * opens a relation under it, and two headings are two. A unit's name reaches SQL only as a borrow lock's text
 * (write/borrow/lock.ts lockId), never as an identifier, so no length bounds it.
 */
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { typeLabel } from "#compiler/ir/scalar.ts"
import { noRosters, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { describedField } from "#compiler/schema/protocol.ts"
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

/** A unit's heading of one field: the field and its type, and the unit's name, `<field>_<the type's name>`. */
export interface Leading<T> {
	readonly name: string
	readonly field: string
	readonly type: T
}

/**
 * The headings `relations` lead with, one over each primary key's first field, in the order the relations first lead
 * with it, each named `<field>_<the type's name>` (`nameOf`, which names one type one way and two types two), so
 * relations whose keys lead with one field of one type share one.
 */
export const leadingHeadings = <T>(
	relations: ReadonlyArray<Openable<T>>,
	nameOf: (type: T, at: string) => string
): ReadonlyArray<Leading<T>> => {
	const headings = new Map<string, Leading<T>>()
	for (const r of relations) {
		const field = defined(r.primaryKey[0], `${r.name}'s primary key`)
		const type = defined(r.fields[field], `${r.name}.${field}`)
		const name = `${field}_${nameOf(type, `${r.name}.${field}`)}`
		if (!headings.has(name)) {
			headings.set(name, { name, field, type })
		}
	}
	return [...headings.values()]
}

/** The units `relations` sit in, one over each primary key's first field (leadingHeadings), as schema values. */
const leadingUnits = (relations: ReadonlyArray<Openable<FieldBase>>): ReadonlyArray<UnitBase> =>
	Arr.map(
		leadingHeadings(relations, (type, at) => typeLabel(describedField(type, at).scalar)),
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

/** A fixture field's type's name, as a unit's heading names it (typeLabel). */
const fixtureTypeName = (field: FixtureField, at: string): string => {
	const scalar = scalarTypeOf(
		fixtureType(field),
		{ kind: "builder", roster: noRosters },
		SourceLoc(at, [])
	)
	if (!scalar.ok) {
		throw new Error(`the type of ${at} has no name: ${scalar.error.message}`)
	}
	return typeLabel(scalar.value)
}

/**
 * `relations` open, as descriptions state them, each a relation description as the schema lists it whose fields' types
 * are of `T`, each a field type (`descOf`) named as a unit's heading names it (`nameOf`): the units they lead with, then
 * each one's `mutable`.
 */
export const openedDescsOf = <T>(
	relations: ReadonlyArray<Openable<T>>,
	descOf: (type: T) => FieldDesc,
	nameOf: (type: T, at: string) => string
): ReadonlyArray<AuthoredStatementDesc> => [
	...Arr.map(leadingHeadings(relations, nameOf), (h) =>
		unitDesc(h.name, { [h.field]: descOf(h.type) })
	),
	...Arr.map(relations, (r) => mutableDesc(r.name))
]

/**
 * `relations` open, as fixtures state them (openedDescsOf), each type named by its scalar type, which a closed id's
 * roster outside any schema has none of: a test whose open relations' keys lead with one states their types as scalar
 * types (openedDescsOf over typeLabel).
 */
export const openedDescs = (
	relations: ReadonlyArray<Openable<FixtureField>>
): ReadonlyArray<AuthoredStatementDesc> => openedDescsOf(relations, fixtureType, fixtureTypeName)
