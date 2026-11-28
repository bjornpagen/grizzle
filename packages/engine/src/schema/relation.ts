import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import { sameContent } from "#compiler/core/canonical.ts"
import { bitsColumn, codeColumn } from "#compiler/core/decoder.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { admitClosedIdField, type HeldName } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { builtMark, fieldMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList, isPlainRecord } from "#compiler/core/record.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import {
	builtNode,
	closedIdBase,
	type ClosedRow,
	closedRelationOver,
	closedRowKey,
	decodeDesc,
	type ExprDesc,
	type FieldDecl,
	type AdmittedClosedRelation,
	type FieldDesc,
	fieldTypes,
	type KeySlotDesc,
	type LiteralDesc,
	type PlaceOrderDesc,
	type QueryDesc,
	type RelationDesc,
	type RelationNaming,
	type RosterNaming,
	declaredNaming,
	derivedNaming,
	recordAdmitted,
	type RosterDesc,
	rosterOrderOf,
	relationOver,
	type SlotsDesc,
	type Writing
} from "#compiler/ir/desc.ts"
import {
	handlesInOrder,
	Roster as IrRoster,
	type RosterHandles,
	rosterOf,
	isZoneName,
	type RosterOrder,
	rosterOrders
} from "#compiler/ir/scalar.ts"
import { firstRepeatAt } from "#compiler/ir/shape.ts"
import {
	builtRosterParts,
	type ClosedIdParts,
	closedIdField,
	closedIdParts
} from "#compiler/scalar/closed-id.ts"
import { handleTerm } from "#compiler/scalar/compute/builders.ts"
import {
	type ClosedReadTyping,
	closedAtKey,
	closedAtTerm,
	closedHasPredicate,
	closedRowTerm
} from "#compiler/scalar/compute/closed.ts"
import { termExpr } from "#compiler/scalar/compute/term.ts"
import { admitMintKey } from "#compiler/scalar/contract.ts"
import { storedLiteral } from "#compiler/scalar/literal.ts"
import { unnamedIdRefusal } from "#compiler/scalar/minted.ts"
import { drawnTypes, isDrawnType, naturalDescriptor } from "#compiler/scalar/natural.ts"
import {
	carrierSql,
	type Described,
	describeFieldOrThrow,
	isOwnedDescriptor,
	registerWrittenField,
	type ScalarEnv,
	scalarTypeOf,
	writtenTypeOf
} from "#compiler/scalar/registry.ts"
import { RosterSet } from "#compiler/scalar/values/bits.ts"
import { handleMaxBytes } from "#compiler/schema/own.ts"
import {
	builderLoc,
	describedField,
	frozenCopy,
	frozenTuple,
	malformed,
	orThrow,
	ownedDesc,
	ownedEntry,
	ownedEntryOf,
	ownedKind,
	ownValue,
	queryDescOf,
	builderRefusal,
	requireDeclaredName,
	requireDerivedName,
	requireName,
	requireNames
} from "#compiler/schema/protocol.ts"
import { mint, record } from "#compiler/schema/record.ts"
import { rowScalars } from "#compiler/schema/terms.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import type { Minted } from "#compiler/types/core/phantom.ts"
import type {
	DefinitionKeys,
	DefinitionLevel,
	DefinitionQuery,
	DefinitionView,
	Derived,
	RuleReadOf
} from "#compiler/types/derived/derived.ts"
import type {
	AccumulatedField,
	Bits,
	ClosedIdField,
	DrawnField,
	PlaceDescriptor,
	PlaceField,
	FieldBase,
	GeneratedField,
	HandleOf
} from "#compiler/types/fields/field.ts"
import type {
	AnyRoster,
	ClosedId,
	ClosedRelation,
	FactOfFields,
	PayloadFieldOf,
	Relation,
	Roster
} from "#compiler/types/schema/relation.ts"
import type { SlotField } from "#compiler/types/schema/statements.ts"

export type OrdinaryRelationDesc = Extract<RelationDesc, { readonly kind: "relation" }>

/**
 * What derived records until schema.extend places it: the definition and the relations it reads. The Description
 * proper needs the level, which only the extended schema determines.
 */
export interface DerivedDraft {
	readonly name: string
	readonly query: QueryDesc
	readonly reads: ReadonlyArray<string>
	readonly loc: SourceLoc
}

/** A plain record a caller handed in as a record of field descriptors. */
const descriptorRecord = (fields: unknown, label: string): Readonly<Record<string, unknown>> => {
	if (!isPlainRecord(fields)) {
		throw malformed(label, "a record of field descriptors")
	}
	return fields
}

/**
 * A column's type, which says whose id it holds: a bare uuid is refused (scalar/minted.ts unnamedIdRefusal), and a
 * contract over uuid names the system it is an id of.
 */
const namedColumn = (described: Described, label: string): Described => {
	if (described.desc.kind === "uuid") {
		throw builderRefusal(label, unnamedIdRefusal)
	}
	return described
}

/**
 * The fields of a record of descriptors, each as describeDeclared reads it: its Description for the relation's, its
 * column for the relation's fact decoder; each a column, so none a bare uuid (`namedColumn`).
 */
const describedFields = (
	fields: Readonly<Record<string, unknown>>,
	label: string
): Readonly<Record<string, Described>> => {
	const out: Record<string, Described> = {}
	for (const [name, descriptor] of Object.entries(fields)) {
		const at = `${label} field ${name}`
		out[name] = namedColumn(describeDeclared(descriptor, builderLoc(at, [])), at)
	}
	return Object.freeze(out)
}

/**
 * What a field builder recorded for the field value it made: slot(type, fin) its declared type and the fin whose slots
 * its codes are; drawn(type), accumulated(type, start) and place(…) how it is written, the descriptor its
 * values are of registered with the registry, its one record (scalar/registry.ts registerWrittenField, writtenTypeOf);
 * the clock's instant its declared type, `stored`, the field of its type its caller writes, which the registry does not
 * hold, since where a field descriptor is asked of the instant it is one itself; and generated(type, term) its declared
 * type as the registry reads it and the term its value is.
 */
type FieldEntry =
	| { readonly kind: "slot"; readonly type: unknown; readonly slots: SlotsDesc }
	| {
			readonly kind: "written"
			readonly writing: Extract<Writing, { readonly kind: "drawn" | "accumulated" | "place" }>
	  }
	| { readonly kind: "instant"; readonly stored: object }
	| { readonly kind: "generated"; readonly type: Described; readonly term: unknown }

/**
 * The field values the field builders made, each under its entry. A WeakMap holds nothing alive and is never
 * enumerated, so it is no cache.
 */
const fieldEntries = new WeakMap<object, FieldEntry>()

const fieldEntryOf = (value: unknown): FieldEntry | undefined =>
	typeof value === "object" && value !== null ? fieldEntries.get(value) : undefined

/**
 * A copy of a field value generated(type, term) made, registered as the field it copies is: law(...)'s value
 * (schema/law-entries.ts), the copy the catalog entry of its generated law is held for. Undefined for any other value.
 */
export const generatedFieldCopy = <F extends object>(value: F): F | undefined => {
	const entry = fieldEntryOf(value)
	if (entry?.kind !== "generated") {
		return undefined
	}
	const copy: F = { ...value }
	Object.freeze(copy)
	fieldEntries.set(copy, entry)
	registerWrittenField(copy, hasProperties(value) ? value["type"] : undefined)
	return copy
}

/** Whether a field value is one slot(type, fin) made. */
const isSlot = (value: unknown): boolean => fieldEntryOf(value)?.kind === "slot"

/**
 * The first step of every admission of a field its caller writes (a context's field, a heading's or a signature's, an
 * accumulated or a generated field's type, a closed relation's field), taken before the field is described: a field
 * grizzle writes, a drawn, accumulated, generated or instant field, is refused by `refusal`, which names why,
 * where its description would refuse it as no descriptor. A slot's codes are its caller's, so a slot passes.
 */
const refuseWritten = (value: unknown, refusal: () => CompileError): void => {
	const entry = fieldEntryOf(value)
	if (entry?.kind === "written" || entry?.kind === "instant" || entry?.kind === "generated") {
		throw refusal()
	}
}

/** A value type's descriptor, after the first step (refuseWritten). */
export const valueTypeOf = (
	value: unknown,
	label: string,
	refusal: () => CompileError
): Described => {
	refuseWritten(value, refusal)
	return describedField(value, label)
}

/** How a field value is written: as drawn(…), accumulated(…), place(…) or instant recorded it, and by its
 * caller otherwise, instant.stored among them. */
export const writingOf = (value: unknown): Writing => {
	const recorded = fieldEntryOf(value)
	switch (recorded?.kind) {
		case "written":
			return recorded.writing
		case "instant":
			return instantWriting
		case "slot":
		case "generated":
		case undefined:
			return callerWriting
	}
}

/** How a caller's field is written. */
const callerWriting: Writing = Object.freeze({ kind: "caller" })

/** How the clock's instant is written. */
const instantWriting: Writing = Object.freeze({ kind: "instant" })

/**
 * drawn(type): a value of `type` grizzle draws from the nested arrays its caller writes, a family's index or count or a
 * tree's start or end: natural, or a contract over an integer (scalar/natural.ts isDrawnType), a consumer's under its key,
 * the one value `rest` holds (scalar/contract.ts admitMintKey), since grizzle makes its values by counting. The value
 * carries its type, its column and its SQL type, so it is read as every field of its type is.
 */
export const drawnField = <F extends FieldBase>(
	type: F,
	rest: ReadonlyArray<unknown>
): DrawnField<F> => {
	const described = valueTypeOf(type, "drawn type", () => builderRefusal("drawn", drawnTypes))
	if (!isDrawnType(described.desc)) {
		throw builderRefusal("drawn", drawnTypes)
	}
	admitMintKey(
		described.scalar,
		rest,
		builderLoc("drawn", []),
		"drawn(type): one argument",
		"drawn(C, key)"
	)
	const value: DrawnField<F> = Object.freeze({
		...builtMark,
		...fieldMark,
		writing: "drawn",
		field: type,
		column: type.column,
		sql: type.sql
	})
	fieldEntries.set(value, { kind: "written", writing: { kind: "drawn" } })
	registerWrittenField(value, type)
	return value
}

/**
 * `value`, the instant descriptor of the database's clock (scalar/instant.ts instantDescriptor), registered: a field
 * whose instant the database writes (ir/desc.ts Writing `instant`), stamped by the insert that adds its row or carried
 * from a stored one as the schema's laws make it (analysis/theory/instants.ts), its declared type instant's, `stored`'s,
 * the field of that type its caller writes as it is.
 */
export const clockInstant = <F extends { readonly stored: object }>(value: F): F => {
	fieldEntries.set(value, { kind: "instant", stored: value.stored })
	return value
}

/** The members every place field carries: natural's column and SQL type, so it is read as every natural is. */
const placeMembers = {
	...builtMark,
	...fieldMark,
	writing: "place",
	natural: true,
	column: naturalDescriptor.column,
	sql: naturalDescriptor.sql
} as const

/**
 * `value`, a place field of `order` (ir/desc.ts PlaceOrderDesc), registered: a natural the insert that adds its row
 * stamps, one past the greatest place its group holds, 0 for its first (ir/instant.ts PlaceHead), the order how a
 * migration that adds it to stored rows numbers them, which the schema checks once it reads the relation
 * (analysis/theory/instants.ts).
 */
const placed = <F extends PlaceField>(value: F, order: PlaceOrderDesc): F => {
	fieldEntries.set(value, { kind: "written", writing: { kind: "place", order } })
	registerWrittenField(value, naturalDescriptor)
	return value
}

/**
 * place.by(field): a place whose stored rows a migration that adds it numbers in `field`'s order, from 0 in each group;
 * one argument, the name of another field of its relation.
 */
const placeBy = (field: unknown, extra: ReadonlyArray<unknown>): PlaceField => {
	if (extra.length > 0 || typeof field !== "string") {
		throw malformed(
			"place.by",
			"place.by(field): one argument, the name of the field that orders the rows a migration that adds the place finds stored"
		)
	}
	return placed(Object.freeze({ ...placeMembers }), { kind: "by", by: field })
}

/**
 * place: a row's place in its group, stamped by the insert that adds the row, which states no order of stored rows, so a
 * migration adds it only where each stored row stands alone in its group; `place.by(field)` is the place whose stored
 * rows a migration numbers by `field`.
 */
export const placeDescriptor: PlaceDescriptor = placed(
	Object.freeze({
		...placeMembers,
		by: (field: string, ...extra: ReadonlyArray<never>): PlaceField => placeBy(field, extra)
	}),
	{ kind: "unordered" }
)

/**
 * accumulated(type, start): a field of `type` grizzle fills on the host and PostgreSQL proves, a fold's accumulator or
 * a copy along a family axis, holding `start` at its axis's base. `start` is a value of `type`, checked here as every
 * literal of it is. A consumer's contract accumulates under its key, the one value `rest` holds (scalar/contract.ts
 * admitMintKey), since a fold makes its values from its members'.
 */
export const accumulatedField = <F extends FieldBase>(
	type: F,
	start: unknown,
	rest: ReadonlyArray<unknown>
): AccumulatedField<F> => {
	const valueType: Refused =
		"an accumulated field is of a value type: no range, vector or field of a writing of its own"
	const described = valueTypeOf(type, "accumulated type", () =>
		builderRefusal("accumulated", valueType)
	)
	if (described.desc.kind === "span" || described.desc.kind === "vector") {
		throw builderRefusal("accumulated", valueType)
	}
	admitMintKey(
		described.scalar,
		rest,
		builderLoc("accumulated", []),
		"accumulated(type, start): two arguments",
		"accumulated(C, start, key)"
	)
	const stored = storedLiteral(described.scalar, start)
	if (!stored.ok) {
		throw malformed("accumulated start", stored.error)
	}
	const literal = stored.value
	const value: AccumulatedField<F> = Object.freeze({
		...builtMark,
		...fieldMark,
		writing: "accumulated",
		field: type,
		column: type.column,
		sql: type.sql
	})
	fieldEntries.set(value, { kind: "written", writing: { kind: "accumulated", start: literal } })
	registerWrittenField(value, type)
	return value
}

/**
 * slot(type, fin(O, n)): a closed relation's key field of `type`, a closed id, whose codes are fin(O, n)'s slots, O a
 * closed relation whose key pairs with the key's first fields and n a natural field of it. The value carries the closed
 * id's column, SQL type and roster, so it is read as `type` is; its fin is `slots`.
 */
export const slotField = <F extends ClosedIdField<AnyRoster>, Fi>(
	type: F,
	slots: Fi,
	extra: ReadonlyArray<unknown>
): SlotField<F, Fi> => {
	if (extra.length > 0) {
		throw malformed("slot", "slot(type, fin(owner, count)): two arguments")
	}
	const described = describedField(type, "slot type")
	if (
		described.desc.kind !== "closedId" ||
		fieldEntryOf(type)?.kind === "written" ||
		fieldEntryOf(type)?.kind === "instant" ||
		isSlot(type)
	) {
		throw malformed("slot", "a closed id, closedId(roster), whose codes number the slots")
	}
	const fin = finOf(slots, "slot")
	if (fin.owner.kind !== "closedRelation") {
		throw malformed(
			"slot",
			`a closed relation's count; ${fin.owner.name} is an ordinary relation, whose count a family draws`
		)
	}
	const value: SlotField<F, Fi> = Object.freeze({ ...type, slots })
	fieldEntries.set(value, { kind: "slot", type, slots: fin.slots })
	return value
}

/**
 * The slots of a closed relation's key: each key field whose descriptor slot(type, fin) made, with its fin, in key
 * order. A slot that is no key field is refused: its codes number slots only where the key reads them. A key that is
 * no list leaves its refusal to the Description's shape.
 */
const keySlots = (
	descriptors: Readonly<Record<string, unknown>>,
	key: unknown,
	label: string
): ReadonlyArray<KeySlotDesc> => {
	const keyFields = isList(key) ? key : []
	for (const [field, descriptor] of Object.entries(descriptors)) {
		if (isSlot(descriptor) && !keyFields.includes(field)) {
			throw malformed(label, `a slot that is a key field; ${field} is in the payload`)
		}
	}
	return keyFields.flatMap((field) => {
		const slot =
			typeof field === "string" && Object.hasOwn(descriptors, field)
				? fieldEntryOf(descriptors[field])
				: undefined
		return slot?.kind !== "slot" || typeof field !== "string" ? [] : [{ field, fin: slot.slots }]
	})
}

const fieldMap = (
	described: Readonly<Record<string, Described>>
): Readonly<Record<string, FieldDesc>> => {
	const out: Record<string, FieldDesc> = {}
	for (const [name, field] of Object.entries(described)) {
		out[name] = field.desc
	}
	return out
}

/**
 * Each field of a record of field values, declared with its type and how it is written (writingOf). A slot is a closed
 * relation's key field, so an ordinary relation's is refused.
 */
const writtenDecls = (
	values: Readonly<Record<string, unknown>>,
	described: Readonly<Record<string, Described>>,
	label: string
): Readonly<Record<string, FieldDecl>> => {
	const out: Record<string, FieldDecl> = {}
	for (const [name, field] of Object.entries(described)) {
		if (isSlot(values[name])) {
			throw malformed(
				label,
				`fields of an ordinary relation; ${name} is a slot, which only a closed relation's key holds`
			)
		}
		out[name] = { type: field.desc, writing: writingOf(values[name]) }
	}
	return out
}

/** A key as its caller lists it, its fields each once: a field listed twice breaks a rule the types name too. */
const keyListedOnce = (key: unknown, label: string): void => {
	if (
		isList(key) &&
		firstRepeatAt(
			key.filter((f): f is string => typeof f === "string"),
			(f) => f
		) !== undefined
	) {
		throw builderRefusal(label, "a key lists each field once")
	}
}

/**
 * A relation's Description over its fields' declarations, decoded where each descriptor was registered, or the
 * refusal of what its arguments described (ir/desc.ts relationOver).
 */
const ordinaryDesc = (
	label: string,
	relationName: string,
	naming: RelationNaming,
	fields: Readonly<Record<string, FieldDecl>>,
	primaryKey: unknown
): OrdinaryRelationDesc => {
	keyListedOnce(primaryKey, label)
	const desc = orThrow(
		relationOver(relationName, naming, fields, primaryKey, builderLoc(label, [relationName]))
	)
	for (const [field, decl] of Object.entries(desc.fields)) {
		if (closedIdBase(decl.type) !== undefined) {
			orThrow(admitClosedIdField(relationName, field, builderLoc(label, [relationName, field])))
		}
	}
	return desc
}

/**
 * A relation's or roster's name, a `kind`'s, admitted by the naming its Description records (ir/desc.ts RelationNaming,
 * RosterNaming): a declared name, refused past PostgreSQL's identifier (requireDeclaredName), or a name a library
 * derives, a declared name's characters at any length (requireDerivedName).
 */
const admittedName = (
	name: unknown,
	naming: RelationNaming | RosterNaming,
	label: string,
	kind: string
): HeldName => {
	switch (naming.kind) {
		case "declared":
			return requireDeclaredName(name, label, kind)
		case "derived":
			return requireDerivedName(name, label, kind)
	}
}

/**
 * The naming a library states for the relations and rosters it derives the names of (the package root's derivedName):
 * the stem and the path their hashed objects are spelled after, each a word a JavaScript caller writes.
 */
export interface DerivedNamingInput {
	readonly stem: string
	readonly path: ReadonlyArray<string>
}

/**
 * The admission core of derivedName(...): a JavaScript caller's naming checked, its stem a name and its path a list of
 * names (requireName, the storable text every name is), and described as a relation's derived naming (ir/desc.ts
 * derivedNaming); its relations' names are admitted where each is built, by the derived-name rule.
 */
export const admitDerivedNaming = (
	naming: unknown,
	extra: ReadonlyArray<unknown>
): RelationNaming => {
	const label = "derivedName"
	if (extra.length > 0) {
		throw malformed(label, "derivedName({ stem, path }): one argument")
	}
	if (!hasProperties(naming) || !isList(naming["path"])) {
		throw malformed(label, "a naming { stem, path }: a stem and a list of names")
	}
	return derivedNaming(
		requireName(naming["stem"], label, "a stem"),
		naming["path"].map((word) => requireName(word, label, "a path's name"))
	)
}

/**
 * The admission core of relation(...) and of each relation records make: a JavaScript caller's arguments checked and
 * described under the relation's naming, the one path a relation's Description is built by. Every field is one its
 * caller writes.
 */
export const admitRelation = (
	name: unknown,
	naming: RelationNaming,
	fields: unknown,
	primaryKey: unknown,
	extra: ReadonlyArray<unknown>
): OrdinaryRelationDesc => {
	const label = `relation ${typeof name === "string" ? name : "?"}`
	/**
	 * The rules of the description (ir/desc.ts relationDescShape) are relationOver's: storable names, a field at least,
	 * and a nonempty primary key over the relation's own fields. The builder checks only what it reads before then: the
	 * name its location is built from, by its naming, its arity, and the descriptors, which only a builder made.
	 */
	const relationName = admittedName(name, naming, label, "relation")
	if (extra.length > 0) {
		throw malformed(label, "relation(name, fields, primaryKey): three arguments")
	}
	const values = descriptorRecord(fields, label)
	const described = describedFields(values, label)
	return ordinaryDesc(
		label,
		relationName,
		naming,
		writtenDecls(values, described, label),
		primaryKey
	)
}

/**
 * generated(type, term): a field PostgreSQL writes, carrying its declared type's column and SQL type so that it is read
 * as every field of that type is. It records the term, which relation.generated reads against the row it was built
 * over. O is the term's origin as its caller's type reads it (types/fields/field.ts GeneratedField), a phantom no
 * runtime value holds: unknown where the caller traces none.
 */
export const generatedField = <F extends FieldBase, O = unknown>(
	type: F,
	term: unknown,
	extra: ReadonlyArray<unknown>
): GeneratedField<F, O> => {
	if (extra.length > 0) {
		throw malformed("generated", "generated(type, term): two arguments")
	}
	const described = namedColumn(
		valueTypeOf(type, "generated type", () =>
			malformed("generated", "a value type, which no field of a writing of its own is")
		),
		"generated type"
	)
	const value: GeneratedField<F, O> = Object.freeze({
		writing: "generated",
		type,
		column: type.column,
		sql: type.sql
	})
	fieldEntries.set(value, { kind: "generated", type: described, term })
	registerWrittenField(value, type)
	return value
}

/**
 * A callback over a relation's row as its builder calls it. The member is a method, so the facade's callback over the
 * row's precise type (types/schema RowScalars) stands for it: the builder hands it the row rowScalars builds over the
 * same fields, which is that type's value.
 */
interface RowCallback<G> {
	run(row: Readonly<Record<string, unknown>>): G
}

/**
 * A generated field's declaration: its declared type and its value's expression, decoded as a Description's. What the
 * expression may read and of what type it is are the checker's rules (analysis/schema.ts), which it applies to every
 * Description, a decoded one's included.
 */
const generatedDecl = (value: unknown, label: string): FieldDecl => {
	const entry = fieldEntryOf(value)
	if (entry?.kind !== "generated") {
		throw malformed(label, "a field built by generated(type, term)")
	}
	const expr = termExpr(entry.term)
	if (expr === undefined) {
		throw malformed(
			label,
			"a term of the row: one of its fields, a closed read, or a scalar expression"
		)
	}
	const decoded: ExprDesc = orThrow(decodeDesc("expr", expr))
	return { type: entry.type.desc, writing: { kind: "generated", expr: decoded } }
}

/**
 * The admission core of relation.generated(...), its name admitted by its naming as relation's is: the written fields
 * checked and described as relation's are, the callback run once over their row, and each field it returns a generated
 * field named apart from every written field.
 * The relation's fields are its written fields, then its generated ones. The row types each field by its declared
 * type, a drawn or an accumulated one's included, as the public type's row does (schema/api.ts GenerationRow).
 */
const admitGenerated = <G>(
	name: unknown,
	naming: RelationNaming,
	written: unknown,
	primaryKey: unknown,
	generate: RowCallback<G>["run"],
	extra: ReadonlyArray<unknown>
): { readonly desc: OrdinaryRelationDesc; readonly generated: G } => {
	const label = `relation ${typeof name === "string" ? name : "?"}`
	const relationName = admittedName(name, naming, label, "relation")
	if (extra.length > 0) {
		throw malformed(
			label,
			"relation.generated(name, written, primaryKey, (row) => generated): four arguments"
		)
	}
	if (typeof generate !== "function") {
		throw malformed(label, "a callback (row) => ({ field: generated(type, term), ... })")
	}
	const descriptors = descriptorRecord(written, label)
	const described = describedFields(descriptors, label)
	const declared = Object.fromEntries(
		Object.entries(descriptors).map(([field, d]) => [field, declaredDescriptorOf(d)] as const)
	)
	const row = rowScalars(fieldMap(described), declared, (field) =>
		rosterOfField(descriptors[field])
	)
	const generated = generate(row)
	if (!isPlainRecord(generated)) {
		throw malformed(label, "a record of generated fields, each generated(type, term)")
	}
	const fields: Record<string, FieldDecl> = { ...writtenDecls(descriptors, described, label) }
	for (const [field, value] of Object.entries(generated)) {
		if (Object.hasOwn(fields, field)) {
			throw builderRefusal(
				`${label} generated field ${field}`,
				"a generated field is named apart from the relation's written fields"
			)
		}
		fields[field] = generatedDecl(value, `${label} generated field ${field}`)
	}
	return { desc: ordinaryDesc(label, relationName, naming, fields, primaryKey), generated }
}

/**
 * relation, relation.generated, closed.ordered, closed.unordered, closed.relation and derived: the relation
 * constructors.
 *
 * - `relation(name, fields, primaryKey)`: an ordinary relation, every field written by its caller. The primary key is
 *   required and nonempty, a list of the relation's own field names in the order written; a pure set lists every
 *   field. It lowers to PRIMARY KEY; there is no implicit full-row UNIQUE and no surrogate.
 * - `relation.generated(name, written, primaryKey, (row) => ({ f: generated(type, term), ... }))`: an ordinary
 *   relation whose callback-returned fields PostgreSQL writes, each a STORED generated column whose term reads the row
 *   of the written fields alone, as PostgreSQL's generation expressions read no generated column.
 * - `closed.ordered(name, handles)`: a roster, the handles it introduces in declared order, which is their codes'
 *   order and comparison order.
 * - `closed.unordered(name, handles)`: a roster whose order means nothing, the handles it introduces in any order,
 *   held in their canonical order (ir/scalar.ts handlesInOrder): no ordered operation reads a closed id of it.
 * - `closed.relation(name, fields, key, rows)`: a closed relation, rows fixed when the schema compiles. Its key is
 *   required and is closed ids; a set lists every field; no two rows share a key.
 * - `derived(name, definition)`: a stored query whose fields come from the definition's head and whose keys from its
 *   evidence. The definition is parameterless. Its level, 1 over base relations and n + 1
 *   over a level-n derived relation, depends on the schema it is declared in, so schema.extend computes
 *   it; derived records the definition and what it reads.
 *
 * Each builder is the one implementation of its value: admission first (its admission core checks a JavaScript caller's
 * arguments and records the Description), then the literal of its arguments, frozen copies, owned with the Description
 * (protocol.ts ownValue), so the value has its public type (types/schema/relation.ts, types/derived) by construction.
 * Its type parameters are as wide as that value allows; the typed facade (schema/api.ts, public/schema.ts) is a view
 * that narrows them to the public signatures. The source location of the declaration travels in the Description under
 * `loc` and is excluded from semantic identity.
 *
 * relation(name, fields, primaryKey). The value holds a frozen copy of the fields and of the primary key, `readonly
 * [...PrimaryKey]`, which is PrimaryKey itself for every key a call writes; its `fact` is the decoder of its facts, made
 * once by record(...) from its fields' columns, and its heading the fields, the carriers v mints its variables over.
 */
export const relationBuilder = <
	const Name extends string,
	const Fields extends Readonly<Record<string, FieldBase>>,
	const PrimaryKey extends ReadonlyArray<keyof Fields & string>
>(
	name: Name,
	fields: Fields,
	primaryKey: PrimaryKey,
	extra: ReadonlyArray<unknown>
): Relation<Name, Fields, readonly [...PrimaryKey]> =>
	namedRelationBuilder(name, declaredNaming, fields, primaryKey, extra)

/**
 * The relation of `name` under `naming` (ir/desc.ts RelationNaming): relation(...)'s, declared; derivedName's, derived;
 * and each relation records make (program/records.ts), declared where its name is stated and derived where records
 * derive it, one builder.
 */
export const namedRelationBuilder = <
	const Name extends string,
	const Fields extends Readonly<Record<string, FieldBase>>,
	const PrimaryKey extends ReadonlyArray<keyof Fields & string>
>(
	name: Name,
	naming: RelationNaming,
	fields: Fields,
	primaryKey: PrimaryKey,
	extra: ReadonlyArray<unknown>
): Relation<Name, Fields, readonly [...PrimaryKey]> => {
	/** Admission first: a JavaScript caller's malformed argument is MalformedDescription before anything is copied. */
	const desc = admitRelation(name, naming, fields, primaryKey, extra)
	const copied = frozenCopy(fields)
	return ownValue({
		kind: "relation",
		value: {
			kind: "relation",
			name,
			fields: copied,
			primaryKey: frozenTuple<PrimaryKey>(primaryKey),
			fact: record<[Fields]>(copied),
			heading: copied
		},
		desc: desc,
		content: undefined
	})
}

/**
 * relation.generated(name, written, primaryKey, generate): the relation of the written fields and the generated fields
 * `generate` returns over their row, its name declared (namedGeneratedRelation).
 */
export const generatedRelation = <
	const Name extends string,
	const Written extends Readonly<Record<string, FieldBase>>,
	const PrimaryKey extends ReadonlyArray<keyof (Written & G) & string>,
	const G extends Readonly<Record<string, GeneratedField<FieldBase>>>
>(
	name: Name,
	written: Written,
	primaryKey: PrimaryKey,
	generate: RowCallback<G>["run"],
	extra: ReadonlyArray<unknown>
): Relation<Name, Written & G, readonly [...PrimaryKey]> =>
	namedGeneratedRelation(name, declaredNaming, written, primaryKey, generate, extra)

/**
 * The relation of `name` under `naming` (ir/desc.ts RelationNaming) whose fields are the written fields and the
 * generated fields `generate` returns over their row: relation.generated(...)'s, declared, and a derived name's (the
 * package root's derivedName), one builder. Its value holds the written fields and then the generated ones, a frozen
 * copy, and its `fact` reads both: a generated field is read as every field is.
 */
export const namedGeneratedRelation = <
	const Name extends string,
	const Written extends Readonly<Record<string, FieldBase>>,
	const PrimaryKey extends ReadonlyArray<keyof (Written & G) & string>,
	const G extends Readonly<Record<string, GeneratedField<FieldBase>>>
>(
	name: Name,
	naming: RelationNaming,
	written: Written,
	primaryKey: PrimaryKey,
	generate: RowCallback<G>["run"],
	extra: ReadonlyArray<unknown>
): Relation<Name, Written & G, readonly [...PrimaryKey]> => {
	const admitted = admitGenerated(name, naming, written, primaryKey, generate, extra)
	const copied = frozenCopy({ ...written, ...admitted.generated })
	return ownValue({
		kind: "relation",
		value: {
			kind: "relation",
			name,
			fields: copied,
			primaryKey: frozenTuple<PrimaryKey>(primaryKey),
			fact: record<[Written & G]>(copied),
			heading: copied
		},
		desc: admitted.desc,
		content: undefined
	})
}

/**
 * A roster: distinct handles, each at most the bytes a name holds, as its names constant stores it, or none: an empty
 * roster, a closed id over which is the empty type, its domain admitting no value.
 */
const handleList = (value: unknown, label: string): ReadonlyArray<string> => {
	if (!isList(value)) {
		throw malformed(label, "a roster of distinct handles: a list of names")
	}
	const handles =
		value.length === 0
			? []
			: requireNames(
					value,
					label,
					"a roster of distinct handles",
					"a roster lists each handle once"
				)
	for (const h of handles) {
		if (utf8Length(h) > handleMaxBytes) {
			throw malformed(
				label,
				`handles of at most ${handleMaxBytes} UTF-8 bytes, the most a name holds (NAMEDATALEN - 1); ${JSON.stringify(h)} has ${utf8Length(h)}`
			)
		}
	}
	return handles
}

/**
 * The admission core of closed.ordered(...) and closed.unordered(...): a JavaScript caller's arguments checked and
 * described, an unordered roster's handles held in its canonical order (ir/scalar.ts handlesInOrder) and its order
 * stated, an ordered roster's in declared order, which is its order; and its name, admitted by its naming (ir/desc.ts
 * RosterNaming): a declared name, parsed by the declared-name rule, or a derived one, its characters at any length,
 * which names the roster it types.
 */
export const admitRoster = (
	name: unknown,
	handles: unknown,
	order: RosterOrder,
	naming: RosterNaming,
	extra: ReadonlyArray<unknown>
): { readonly desc: RosterDesc; readonly declared: HeldName } => {
	const label = `closed ${typeof name === "string" ? name : "?"}`
	const rosterName = admittedName(name, naming, label, "roster")
	if (extra.length > 0) {
		throw malformed(
			label,
			`closed.${order}(name, handles): two arguments; a closed relation over a roster is closed.relation(name, fields, key, rows)`
		)
	}
	const listed = handleList(handles, label)
	const notZone = order === "zones" ? listed.find((h) => !isZoneName(h)) : undefined
	if (notZone !== undefined) {
		throw malformed(
			label,
			`closed.zones(name, zones): each zone's IANA name in its Area/Location form, such as "America/Chicago" or "Etc/UTC"; ${JSON.stringify(notZone)} is none, and PostgreSQL would read a name of one component as an abbreviation first`
		)
	}
	const held = Object.freeze(handlesInOrder(order, listed))
	const loc = builderLoc(label, [rosterName])
	const desc: RosterDesc =
		order === "ordered"
			? builtNode({ kind: "closed", name: rosterName, naming, handles: held, loc })
			: builtNode({ kind: "closed", name: rosterName, naming, handles: held, order, loc })
	return { desc, declared: rosterName }
}

/** closed.ordered(name, handles) and closed.unordered(name, handles): a roster of `order`, its name declared
 * (namedClosedBuilder). */
export const closedBuilder = <
	const Name extends string,
	const Handles extends ReadonlyArray<string>,
	const Order extends RosterOrder
>(
	name: Name,
	handles: Handles,
	order: Order,
	extra: ReadonlyArray<unknown>
): Roster<Name, readonly [...Handles], Order> =>
	namedClosedBuilder(name, declaredNaming, handles, order, extra)

/**
 * The roster of `name` under `naming` (ir/desc.ts RosterNaming) of `order`: closed.ordered(...)'s and
 * closed.unordered(...)'s, declared, and a derived name's (the package root's derivedName), one builder. The id of every
 * fact is the roster's closed id column, over the caller's handles, which admission read; a fact is the handle under id.
 * `handle(member)` is the member as a typed constant (scalar/compute/builders.ts handleTerm). Its owned entry holds the
 * roster its admitted name and handles type, their digest taken once (ir/scalar.ts Roster), which every closed id over
 * it reads (closedIdOf). A name its naming's rule refuses is refused here, so every built roster types one.
 */
export const namedClosedBuilder = <
	const Name extends string,
	const Handles extends ReadonlyArray<string>,
	const Order extends RosterOrder
>(
	name: Name,
	naming: RosterNaming,
	handles: Handles,
	order: Order,
	extra: ReadonlyArray<unknown>
): Roster<Name, readonly [...Handles], Order> => {
	const { desc, declared } = admitRoster(name, handles, order, naming, extra)
	const roster = frozenTuple<Handles>(handles)
	const id: ClosedId<Handles[number], Name, Order> = Object.freeze({
		id: Object.freeze({ column: codeColumn<Handles[number]>(name, handles), sql: carrierSql.code })
	})
	const typed = IrRoster.of(declared, order, desc.handles)
	const parts = builtRosterParts(desc.name, { order, handles: desc.handles }, [], typed)
	const value: Roster<Name, readonly [...Handles], Order> = ownValue({
		kind: "closed",
		value: {
			kind: "closed",
			name,
			order,
			handles: roster,
			fact: record<[ClosedId<Handles[number], Name, Order>]>(id),
			heading: id,
			handle: <const M extends Handles[number]>(member: M) => handleTerm(value, parts, member)
		},
		desc: desc,
		content: typed
	})
	return value
}

/**
 * The parts of a closed id over `value` holding the subset `rest` states, the arguments after its roster: none for every
 * handle, or the subset of them a caller states. Its roster is one closed.ordered or closed.unordered built, read off
 * what its build admitted and the roster it typed, or a JavaScript look-alike's, admitted by closedId's own core
 * (scalar/closed-id.ts closedIdParts).
 */
export const closedIdOf = (value: unknown, rest: ReadonlyArray<unknown>): ClosedIdParts => {
	const built = ownedEntry(value, "closed")
	return built === undefined
		? closedIdParts(value, rest)
		: builtRosterParts(
				built.desc.name,
				{ order: rosterOrderOf(built.desc), handles: built.desc.handles },
				rest,
				built.content
			)
}

/**
 * The descriptor of a closed id over every handle of `value`, for a caller that holds no literal handles: its parts
 * closedIdOf's, its column the admitted roster's handles (scalar/closed-id.ts closedIdField).
 */
export const admittedClosedId = (value: unknown) => closedIdField(value, closedIdOf(value, []))

/**
 * A closed relation's rows as a JavaScript caller wrote them, checked and described, as the facts they state, over its
 * key, which its description proved a list of its own closed-id fields (ir/desc.ts closedRelationOver): a row written
 * twice is one fact, its first, and two rows of one key but other payloads break the key law, refused naming the key
 * and both payloads. A fact is told apart by its key's handles in a TupleMap, so no key is joined into a text, and two
 * facts are compared only where their keys meet. `written` is the index of each fact's row among those written, which
 * the relation's value holds its rows by, in the order of their set (ir/desc.ts recordAdmitted).
 */
const closedRows = (
	rows: unknown,
	described: Readonly<Record<string, Described>>,
	key: NonEmptyReadonlyArray<string>,
	label: string
): {
	readonly rows: ReadonlyArray<ClosedRow>
	readonly written: ReadonlyMap<ClosedRow, number>
} => {
	if (!isList(rows)) {
		throw malformed(label, "rows: a list of the relation's facts")
	}
	const names = Object.keys(described)
	const typed = Object.entries(described).map(([field, { scalar }]) => ({ field, scalar }))
	const facts = new TupleMap<ReadonlyArray<string>, ClosedRow>()
	const written = new Map<ClosedRow, number>()
	for (const [i, row] of rows.entries()) {
		if (!isPlainRecord(row)) {
			throw malformed(label, `row ${i}: a fact, a record of a value per field`)
		}
		const own = Object.keys(row)
		if (own.length !== names.length || !names.every((f) => Object.hasOwn(row, f))) {
			throw malformed(label, `row ${i} with exactly the fields ${names.join(", ")}`)
		}
		const literals: Record<string, LiteralDesc> = {}
		for (const { field, scalar } of typed) {
			const literal = storedLiteral(scalar, row[field])
			if (!literal.ok) {
				throw malformed(`${label} row ${i} field ${field}`, literal.error)
			}
			literals[field] = literal.value
		}
		const handles = closedRowKey(key, literals)
		const earlier = facts.get(handles)
		if (earlier === undefined) {
			facts.set(handles, literals)
			written.set(literals, i)
			continue
		}
		if (!sameContent(earlier, literals)) {
			throw builderRefusal(
				`${label} rows ${defined(written.get(earlier), "the row's index")} and ${i}`,
				"two facts of one relation share a key with different values; a key names one fact"
			)
		}
	}
	return { rows: [...facts.values()], written }
}

/** The admission core of closed.relation(...): a JavaScript caller's arguments checked and described. */
export const admitClosedRelation = (
	name: unknown,
	fields: unknown,
	key: unknown,
	rows: unknown,
	extra: ReadonlyArray<unknown>
): {
	readonly desc: AdmittedClosedRelation
	readonly described: Readonly<Record<string, Described>>
	/** The index of each fact's row among those written (closedRows). */
	readonly written: ReadonlyMap<ClosedRow, number>
} => {
	const label = `closed.relation ${typeof name === "string" ? name : "?"}`
	const relationName = requireDeclaredName(name, label, "closed relation")
	if (extra.length > 0) {
		throw malformed(label, "closed.relation(name, fields, key, rows): four arguments")
	}
	const descriptors = descriptorRecord(fields, label)
	for (const [field, value] of Object.entries(descriptors)) {
		refuseWritten(value, () =>
			malformed(label, `fields its declaration's rows hold; ${field} is written by grizzle`)
		)
	}
	keyListedOnce(key, label)
	const described = describedFields(descriptors, label)
	/**
	 * The description over the fields' decoded types, its caller's key and slots decoded as a decode of the whole
	 * relation decodes them, before its rows, which closedRows proves over the key it holds, each a value of exactly the
	 * relation's fields as literalFor reads it, one per key.
	 */
	const desc = orThrow(
		closedRelationOver(
			relationName,
			fieldMap(described),
			key,
			keySlots(descriptors, key, label),
			builderLoc(label, [relationName])
		)
	)
	const facts = closedRows(rows, described, desc.key, label)
	return {
		desc: recordAdmitted({ ...desc, rows: facts.rows }),
		described,
		written: facts.written
	}
}

/**
 * The typing of a closed relation's reads (scalar/compute/closed.ts): each key field's declared type, each payload
 * field's type and carrier, and the set over the last key field's roster, whose descriptor carries the roster.
 */
const closedReadTyping = (
	desc: AdmittedClosedRelation,
	described: Readonly<Record<string, Described>>,
	label: string
): ClosedReadTyping => {
	const typeOf = (field: string): Described => {
		const d = described[field]
		if (d === undefined) {
			throw malformed(label, `a key over the relation's own fields; ${field} is none`)
		}
		return d
	}
	const types = new Map(Object.entries(described).map(([field, d]) => [field, d.scalar] as const))
	const payload = new Set(Object.keys(described).filter((field) => !desc.key.includes(field)))
	const last = lastNonEmpty(desc.key)
	const { desc: lastDesc, scalar: lastType } = typeOf(last)
	if (lastDesc.kind !== "closedId" || lastType.carrier !== "code") {
		throw malformed(label, `a key of closed ids, each built by closedId(roster); ${last} is none`)
	}
	const roster = lastDesc.roster
	const env: ScalarEnv = {
		kind: "builder",
		roster: (n) => (n === roster ? rosterOf(lastType) : undefined)
	}
	const set = orThrow(scalarTypeOf({ kind: "bits", roster }, env, SourceLoc(label, [])))
	return {
		relation: desc.name,
		key: mapNonEmpty(desc.key, (field) => ({ field, type: typeOf(field).scalar })),
		types,
		payload,
		row: { type: set, carrier: { column: bitsColumn(roster), sql: carrierSql.bits } }
	}
}

/**
 * closed.relation(name, fields, key, rows): a closed relation. Its value holds frozen copies of its fields, key and rows;
 * its `fact` is the decoder of its rows' fields, and its heading its fields. `at`, `row` and `has` are its closed reads
 * (scalar/compute/closed.ts), typed by its own descriptors.
 */
export const closedRelation = <
	const Name extends string,
	const Fields extends Readonly<Record<string, FieldBase>>,
	const Key extends NonEmptyReadonlyArray<keyof Fields & string>
>(
	name: Name,
	fields: Fields,
	key: Key,
	rows: ReadonlyArray<FactOfFields<Fields>>,
	extra: ReadonlyArray<unknown>
): ClosedRelation<Name, Fields, readonly [...Key]> => {
	const label = `closed.relation ${name}`
	const admitted = admitClosedRelation(name, fields, key, rows, extra)
	const copied = frozenCopy(fields)
	const typing = closedReadTyping(admitted.desc, admitted.described, label)
	return ownValue({
		kind: "closedRelation",
		value: {
			kind: "closedRelation",
			name,
			fields: copied,
			key: frozenTuple<Key>(key),
			rows: Object.freeze(
				admitted.desc.rows.map((fact) =>
					frozenCopy(
						defined(rows[defined(admitted.written.get(fact), "a fact's row")], "a fact's row")
					)
				)
			),
			fact: record<[Fields]>(copied),
			heading: copied,
			at: <const P extends PayloadFieldOf<Fields, readonly [...Key]>>(
				field: P,
				...args: ReadonlyArray<unknown>
			): Minted<Fields, unknown>[P] => {
				const at = closedAtKey(typing, field, args)
				return mint<unknown, Fields>(copied, (carrier, f) => closedAtTerm(typing, f, at, carrier))[
					field
				]
			},
			row: (...args: ReadonlyArray<unknown>) => closedRowTerm(typing, args),
			has: (...args: ReadonlyArray<unknown>) => closedHasPredicate(typing, args)
		},
		desc: admitted.desc,
		content: undefined
	})
}

/** The brand of a set over a roster, minted only by bitsOf from handles it checked. */
const mintBits = <C>() => nominal<ReadonlySet<HandleOf<C>>, Bits<C>>()

/**
 * Bits.of(roster, handles): the set of `handles`, a fresh Set branded by the roster, which the caller owns: a Set
 * cannot be frozen, and every boundary that admits one copies it. Each handle is one of the roster's, each once: a
 * JavaScript caller's other value is MalformedDescription. The set states its roster (scalar/values/bits.ts RosterSet),
 * so a literal or a parameter at another roster's field refuses it whatever its handles' names.
 */
export const bitsOf = <C extends AnyRoster>(
	roster: C,
	handles: ReadonlyArray<HandleOf<C>>,
	extra: ReadonlyArray<unknown>
): Bits<C> => {
	const label = "Bit.of"
	if (extra.length > 0) {
		throw malformed(label, "Bit.of(roster, handles): two arguments")
	}
	if (ownedKind(roster) !== "closed" || !isList(handles)) {
		throw malformed(
			label,
			"a roster built by closed.ordered(name, handles) or closed.unordered(name, handles), and a list of its handles"
		)
	}
	const members = new Set<HandleOf<C>>()
	for (const h of handles) {
		if (!roster.handles.includes(h)) {
			throw malformed(label, `handles of ${roster.name}; ${JSON.stringify(h)} is none`)
		}
		if (members.has(h)) {
			throw builderRefusal(label, "a set lists each of its handles once")
		}
		members.add(h)
	}
	return mintBits<C>()(new RosterSet(roster.name, members))
}

/** The admission core of derived(...): the definition checked and recorded, as relation's is. Whether its rows are
 * stored is no declaration of its: the checked schema infers it from what its definition reads (analysis/schema.ts
 * CheckedSchema, analysis/derived/storage.ts). */
export const admitDerived = (
	name: unknown,
	definition: unknown,
	extra: ReadonlyArray<unknown>
): DerivedDraft => {
	const label = `derived ${typeof name === "string" ? name : "?"}`
	const derivedName = requireDeclaredName(name, label, "derived relation")
	if (extra.length > 0) {
		throw malformed(label, "derived(name, definition): two arguments")
	}
	const query = queryDescOf(definition, `${label} definition`)
	if (query.stage.kind === "order") {
		throw malformed(
			label,
			"a definition that is a Query, not an Ordered: take closes an order into a set"
		)
	}
	const uses = queryUses(query)
	if (uses.inputs.size > 0) {
		throw malformed(
			label,
			`a parameterless definition; it reads ${[...uses.inputs].toSorted(compareStrings).join(", ")}`
		)
	}
	if (uses.contexts.size > 0) {
		throw malformed(
			label,
			`a definition that matches no context, which no session's claims stand for at the COMMIT that keeps it; it matches ${[...uses.contexts.keys()].toSorted(compareStrings).join(", ")}`
		)
	}
	const draft: DerivedDraft = Object.freeze({
		name: derivedName,
		query,
		reads: Object.freeze([...uses.relations].toSorted(compareStrings)),
		loc: builderLoc(label, [derivedName])
	})
	return draft
}

/**
 * derived(name, definition): the value of the definition under its name, owned with the draft its admission core
 * records; its heading is the definition's, which v mints variables over, and its `fact` the decoder of that heading.
 * Where its rows live is the installation's inference, never its declaration's: in a table of its own, which grizzle
 * keeps equal to its definition at every COMMIT, where its definition is unit-local within one declared unit and its
 * table can hold its rows, and its definition's alone otherwise (analysis/derived/storage.ts).
 */
export const derivedBuilder = <const Name extends string, Q extends DefinitionQuery>(
	name: Name,
	definition: Q,
	extra: ReadonlyArray<unknown>
): Derived<
	Name,
	DefinitionView<Q["heading"], DefinitionKeys<Q>, RuleReadOf<Q>, DefinitionLevel<Q>>
> => {
	const draft = admitDerived(name, definition, extra)
	const heading: Q["heading"] = definition.heading
	return ownValue({
		kind: "derived",
		value: {
			...builtMark,
			kind: "derived",
			name,
			definition,
			heading,
			fact: record(heading)
		},
		desc: draft,
		content: undefined
	})
}

/**
 * The Description of a relation, roster or closed relation value: an owned value's own, or a JavaScript look-alike's,
 * described by the admission core so that it is checked exactly as a built one is.
 */
export const relationDescOf = (
	value: unknown,
	label: string
): OrdinaryRelationDesc | RosterDesc | AdmittedClosedRelation => {
	const owned = ownedEntryOf(value)
	if (owned?.kind === "relation" || owned?.kind === "closed" || owned?.kind === "closedRelation") {
		return owned.desc
	}
	if (hasProperties(value) && owned === undefined) {
		if (value["kind"] === "relation") {
			return admitRelation(value["name"], declaredNaming, value["fields"], value["primaryKey"], [])
		}
		if (value["kind"] === "closed") {
			return admitRoster(
				value["name"],
				value["handles"],
				rosterOrderRead(value["order"], label),
				declaredNaming,
				[]
			).desc
		}
		if (value["kind"] === "closedRelation") {
			return admitClosedRelation(value["name"], value["fields"], value["key"], value["rows"], [])
				.desc
		}
	}
	throw malformed(
		label,
		"a relation, roster or closed relation, built by relation(...), closed.ordered(...), closed.unordered(...) or closed.relation(...)"
	)
}

/**
 * The order a JavaScript look-alike of a roster states under `order`: one of the roster orders (ir/scalar.ts
 * RosterOrder), as closed.ordered and closed.unordered state theirs; any other value is MalformedDescription.
 */
const rosterOrderRead = (order: unknown, label: string): RosterOrder => {
	const read = rosterOrders.find((o) => o === order)
	if (read === undefined) {
		throw malformed(label, `a roster's order, one of ${rosterOrders.join(", ")}`)
	}
	return read
}

/**
 * What a fin value names: its owner, an ordinary or a closed relation, and its count, a field of the owner. An
 * ordinary owner's count is a drawn natural, which a family draws; a closed owner's is a natural field, which numbers
 * the slots of a closed relation's key; each reader judges its own.
 */
export const finOf = (
	value: unknown,
	label: string
): {
	readonly owner: Extract<NamedRelation, { readonly kind: "relation" | "closedRelation" }>
	readonly slots: SlotsDesc
} => {
	if (!hasProperties(value) || value["kind"] !== "fin") {
		throw builderRefusal(label, "a family's slots are fin(owner, count), the owner's count")
	}
	const owner = namedRelation(value["owner"], `${label} owner`)
	if (owner.kind !== "relation" && owner.kind !== "closedRelation") {
		throw malformed(label, `an ordinary or a closed relation's count; ${owner.name} is neither`)
	}
	const count = requireName(value["count"], label, "a count field of the owner")
	if (!Object.hasOwn(owner.fields, count)) {
		throw malformed(
			label,
			`fields of ${owner.name}; ${JSON.stringify(count)} is not one of its fields`
		)
	}
	return { owner, slots: { owner: owner.name, count } }
}

export const derivedDraftOf = (value: unknown): DerivedDraft | undefined =>
	ownedDesc(value, "derived")

/**
 * The name and kind of anything a statement may name. A relation, a roster or a closed relation has a known heading:
 * its fields' types, its primary key, and the descriptors its fields were built from, which literal contexts read (a
 * closedId field's roster); a generated field's descriptor is its declared type's. A roster's heading is its id, which
 * has no descriptor, and its roster, the handles the id holds, is its own member. A closed relation's key is its
 * primary key. A derived relation's fields are inferred at compilation, so a statement knows only its name.
 */
export type NamedRelation =
	| {
			readonly kind: "relation"
			readonly name: string
			readonly fields: Readonly<Record<string, FieldDesc>>
			readonly primaryKey: ReadonlyArray<string>
			readonly descriptors: Readonly<Record<string, unknown>>
	  }
	| {
			readonly kind: "closed"
			readonly name: string
			readonly fields: Readonly<Record<string, FieldDesc>>
			readonly primaryKey: ReadonlyArray<string>
			readonly roster: RosterHandles
			readonly descriptors: Readonly<Record<string, unknown>>
	  }
	| {
			readonly kind: "closedRelation"
			readonly name: string
			readonly fields: Readonly<Record<string, FieldDesc>>
			readonly primaryKey: NonEmptyReadonlyArray<string>
			readonly descriptors: Readonly<Record<string, unknown>>
	  }
	| { readonly kind: "derived"; readonly name: string }

/**
 * The roster a field of a relation, roster or closed relation holds a handle of, its order and handles, when it is a
 * closed handle: a roster's id holds its roster, and a closedId field the roster its descriptor carries.
 */
export const fieldRoster = (
	rel: Exclude<NamedRelation, { readonly kind: "derived" }>,
	field: string
): RosterHandles | undefined =>
	rel.kind === "closed" && field === "id" ? rel.roster : rosterOfField(rel.descriptors[field])

/**
 * The descriptor a field value was built from: its own, or a slot's or the clock instant's declared type's, or the one a
 * drawn, accumulated, place or generated field's values are of, as the registry holds it (FieldEntry).
 */
const declaredDescriptorOf = (value: unknown): unknown => {
	const entry = fieldEntryOf(value)
	switch (entry?.kind) {
		case "slot":
			return entry.type
		case "instant":
			return entry.stored
		case "written":
		case "generated":
			return writtenTypeOf(value)
		case undefined:
			return value
	}
}

/**
 * The description of a field value, any field of a relation or a descriptor itself: its declared type's descriptor
 * (declaredDescriptorOf) as the registry reads it, its FieldDesc, ScalarType and column, or MalformedDescription at
 * `loc` for a value that is neither. It is the one reading of a field value as a type: a relation's column is described
 * by it (describedFields), and every public reading of a field reads it, codecText (program/text.ts codecTextOver),
 * keyTextBytes, lexicalForm and lexical (public/text.ts), so none of them refuses a field its type admits.
 */
export const describeDeclared = (value: unknown, loc: SourceLoc): Described =>
	describeFieldOrThrow(declaredDescriptorOf(value), loc)

/**
 * The handles of the roster a field value's closedId or bits descriptor references, through a slot, drawn, accumulated or
 * generated field's declared type and any depth of contracts: the roster its descriptor's type holds, whose handles
 * closedId(roster) and bits(roster) admitted when they built it, a contract's read through its base (ir/scalar.ts rosterOf);
 * undefined for any other value.
 */
export const rosterHandlesOf = (value: unknown): ReadonlyArray<string> | undefined =>
	rosterOfField(value)?.handles

/** The roster a field value's closedId or bits descriptor references, as rosterHandlesOf reads it. */
const rosterOfField = (value: unknown): IrRoster | undefined => {
	const descriptor = declaredDescriptorOf(value)
	return isOwnedDescriptor(descriptor) ? rosterOf(descriptor.scalar) : undefined
}

export const namedRelation = (value: unknown, label: string): NamedRelation => {
	const draft = derivedDraftOf(value)
	if (draft !== undefined) {
		return { name: draft.name, kind: "derived" }
	}
	const desc = relationDescOf(value, label)
	/** relationDescOf admitted the value, so it is a record whose fields are a record of descriptors. */
	const member = (key: string): Readonly<Record<string, unknown>> => {
		const descriptors = hasProperties(value) ? value[key] : undefined
		if (!hasProperties(descriptors)) {
			return {}
		}
		const out: Record<string, unknown> = {}
		for (const [field, d] of Object.entries(descriptors)) {
			out[field] = declaredDescriptorOf(d)
		}
		return out
	}
	switch (desc.kind) {
		case "relation":
			return {
				name: desc.name,
				kind: "relation",
				fields: fieldTypes(desc.fields),
				primaryKey: desc.primaryKey,
				descriptors: member("fields")
			}
		case "closed":
			return {
				name: desc.name,
				kind: "closed",
				fields: { id: { kind: "closedId", roster: desc.name, only: undefined } },
				primaryKey: ["id"],
				roster: { order: rosterOrderOf(desc), handles: desc.handles },
				descriptors: {}
			}
		case "closedRelation":
			return {
				name: desc.name,
				kind: "closedRelation",
				fields: desc.fields,
				primaryKey: desc.key,
				descriptors: member("fields")
			}
	}
}
