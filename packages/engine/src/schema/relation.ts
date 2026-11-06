import { nominal } from "#compiler/core/brand.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { bitsColumn, codeColumn } from "#compiler/core/decoder.ts"
import { defined } from "#compiler/core/invariant.ts"
import { handleMaxBytes } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import {
	type ContentDigest,
	contentDigest,
	decodeDesc,
	type ExprDesc,
	type FieldDecl,
	type AdmittedClosedRelation,
	type FieldDesc,
	fieldTypes,
	type KeySlotDesc,
	type LiteralDesc,
	type QueryDesc,
	type RelationDesc,
	recordAdmitted,
	type SlotsDesc,
	type Writing
} from "#compiler/ir/desc.ts"
import { handleTerm } from "#compiler/scalar/compute/builders.ts"
import {
	type ClosedReadTyping,
	closedAtKey,
	closedAtTerm,
	closedRowTerm
} from "#compiler/scalar/compute/closed.ts"
import { termExpr } from "#compiler/scalar/compute/term.ts"
import { isNaturalDesc } from "#compiler/scalar/natural.ts"
import {
	carrierSql,
	type Described,
	type ScalarEnv,
	scalarTypeOf
} from "#compiler/scalar/registry.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"
import { literalFor } from "#compiler/schema/literal.ts"
import {
	builderLoc,
	describedField,
	frozenCopy,
	frozenTuple,
	isPlainRecord,
	malformed,
	orThrow,
	ownedDesc,
	ownedEntry,
	ownedKind,
	ownValue,
	queryDescOf,
	requireName,
	requireNames,
	rosterHandlesOf
} from "#compiler/schema/protocol.ts"
import { mint, record } from "#compiler/schema/record.ts"
import { rowScalars } from "#compiler/schema/terms.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import type { Minted } from "#compiler/types/core/phantom.ts"
import type { DefinitionQuery, Derived } from "#compiler/types/derived/derived.ts"
import type {
	AccumulatedField,
	Bits,
	ClosedIdField,
	DrawnField,
	FieldBase,
	GeneratedField,
	HandleOf,
	NaturalField
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
export type RosterDesc = Extract<RelationDesc, { readonly kind: "closed" }>
export type ClosedRelationDesc = Extract<RelationDesc, { readonly kind: "closedRelation" }>
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
 * The fields of a record of descriptors, each a descriptor a builder made as the registry reads it: its Description
 * for the relation's, its column for the relation's fact decoder.
 */
const describedFields = (
	fields: Readonly<Record<string, unknown>>,
	label: string
): Readonly<Record<string, Described>> => {
	const out: Record<string, Described> = {}
	for (const [name, descriptor] of Object.entries(fields)) {
		out[name] = describedField(descriptorOf(descriptor), `${label} field ${name}`)
	}
	return Object.freeze(out)
}

/**
 * What slot(type, fin) recorded for the field value it made: the descriptor of its declared type, a closed id, and the
 * fin whose slots its codes are. A WeakMap holds nothing alive and is never enumerated, so it is no cache.
 */
interface Slotted {
	readonly type: unknown
	readonly slots: SlotsDesc
}

const slotted = new WeakMap<object, Slotted>()

const slottedOf = (value: unknown): Slotted | undefined =>
	typeof value === "object" && value !== null ? slotted.get(value) : undefined

/**
 * What drawn(type) and accumulated(type, start) recorded for the field value each made: the descriptor of its declared
 * type, and how it is written. A WeakMap holds nothing alive and is never enumerated, so it is no cache.
 */
interface WrittenBy {
	readonly type: unknown
	readonly writing: Extract<Writing, { readonly kind: "drawn" | "accumulated" }>
}

const writtenBy = new WeakMap<object, WrittenBy>()

const writtenByOf = (value: unknown): WrittenBy | undefined =>
	typeof value === "object" && value !== null ? writtenBy.get(value) : undefined

/**
 * How a field value is written: as drawn(…) or accumulated(…) recorded it, by its sequence for a serial descriptor,
 * whose `writing` member says so, and by its caller otherwise.
 */
export const writingOf = (value: unknown): Writing => {
	const recorded = writtenByOf(value)
	if (recorded !== undefined) {
		return recorded.writing
	}
	return hasProperties(value) && value["writing"] === "serial" ? { kind: "serial" } : callerWriting
}

/** How a caller's field is written. */
const callerWriting: Writing = Object.freeze({ kind: "caller" })

/**
 * drawn(type): a natural grizzle draws from the nested arrays its caller writes, a family's index or count or a
 * tree's start or end. The value carries the natural's column and SQL type, so it is read as every natural is.
 */
export const drawnField = (type: NaturalField, extra: ReadonlyArray<unknown>): DrawnField => {
	if (extra.length > 0) {
		throw malformed("drawn", "drawn(type): one argument")
	}
	const described = describedField(type, "drawn type")
	if (!isNaturalDesc(described.desc) || writtenByOf(type) !== undefined) {
		throw malformed("drawn", "natural, the one type a family's index and count are of")
	}
	const value: DrawnField = Object.freeze({
		...builtMark,
		writing: "drawn",
		natural: true,
		column: type.column,
		sql: type.sql
	})
	writtenBy.set(value, { type, writing: { kind: "drawn" } })
	return value
}

/**
 * accumulated(type, start): a field of `type` grizzle fills on the host and PostgreSQL proves, a fold's accumulator or
 * a copy along a family axis, holding `start` at its axis's base. `start` is a value of `type`, checked here as every
 * literal of it is.
 */
export const accumulatedField = <F extends FieldBase>(
	type: F,
	start: unknown,
	extra: ReadonlyArray<unknown>
): AccumulatedField<F> => {
	if (extra.length > 0) {
		throw malformed("accumulated", "accumulated(type, start): two arguments")
	}
	const described = describedField(type, "accumulated type")
	if (
		described.desc.kind === "span" ||
		described.desc.kind === "vector" ||
		writingOf(type).kind !== "caller"
	) {
		throw malformed(
			"accumulated",
			"an accumulated field of a value type: no span, vector or field of a writing of its own"
		)
	}
	const literal = literalFor(described.desc, start, "accumulated start", rosterHandlesOf(type))
	const value: AccumulatedField<F> = Object.freeze({
		...builtMark,
		writing: "accumulated",
		field: type,
		column: type.column,
		sql: type.sql
	})
	writtenBy.set(value, { type, writing: { kind: "accumulated", start: literal } })
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
		writtenByOf(type) !== undefined ||
		slottedOf(type) !== undefined
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
	slotted.set(value, { type, slots: fin.slots })
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
		if (slottedOf(descriptor) !== undefined && !keyFields.includes(field)) {
			throw malformed(label, `a slot that is a key field; ${field} is in the payload`)
		}
	}
	return keyFields.flatMap((field) => {
		const slot =
			typeof field === "string" && Object.hasOwn(descriptors, field)
				? slottedOf(descriptors[field])
				: undefined
		return slot === undefined || typeof field !== "string" ? [] : [{ field, fin: slot.slots }]
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
		if (slottedOf(values[name]) !== undefined) {
			throw malformed(
				label,
				`fields of an ordinary relation; ${name} is a slot, which only a closed relation's key holds`
			)
		}
		out[name] = { type: field.desc, writing: writingOf(values[name]) }
	}
	return out
}

/** A relation's Description decoded, or the refusal of what its arguments described. */
const ordinaryDesc = (
	label: string,
	relationName: string,
	fields: Readonly<Record<string, FieldDecl>>,
	primaryKey: unknown
): OrdinaryRelationDesc => {
	const desc = orThrow(
		decodeDesc("relation", {
			kind: "relation",
			name: relationName,
			fields,
			primaryKey,
			loc: builderLoc(label, [relationName])
		})
	)
	if (desc.kind !== "relation") {
		throw malformed(label, "a relation description of an ordinary relation")
	}
	return desc
}

/**
 * The admission core of relation(...): a JavaScript caller's arguments checked and described, the one path a relation's
 * Description is built by. Every field is one its caller writes.
 */
export const admitRelation = (
	name: unknown,
	fields: unknown,
	primaryKey: unknown,
	extra: ReadonlyArray<unknown>
): OrdinaryRelationDesc => {
	const label = `relation ${typeof name === "string" ? name : "?"}`
	/**
	 * The rules of the description (ir/desc.ts relationDescShape) are decodeDesc's: storable names, a field at least,
	 * and a nonempty primary key over the relation's own fields. The builder checks only what it reads before then: the
	 * name its location is built from, its arity, and the descriptors, which only a builder made.
	 */
	const relationName = requireName(name, label, "a relation name")
	if (extra.length > 0) {
		throw malformed(label, "relation(name, fields, primaryKey): three arguments")
	}
	const values = descriptorRecord(fields, label)
	const described = describedFields(values, label)
	return ordinaryDesc(label, relationName, writtenDecls(values, described, label), primaryKey)
}

/**
 * What generated(type, term) recorded for the field value it made: its declared type's descriptor as the registry reads
 * it, and the term its value is. A WeakMap holds nothing alive and is never enumerated, so it is no cache.
 */
interface GeneratedEntry {
	readonly type: Described
	readonly term: unknown
}

const generatedEntries = new WeakMap<object, GeneratedEntry>()

/**
 * generated(type, term): a field PostgreSQL writes, carrying its declared type's column and SQL type so that it is read
 * as every field of that type is. It records the term, which relation.generated reads against the row it was built
 * over. A serial is written by its sequence, so no generated field is one.
 */
export const generatedField = <F extends FieldBase>(
	type: F,
	term: unknown,
	extra: ReadonlyArray<unknown>
): GeneratedField<F> => {
	if (extra.length > 0) {
		throw malformed("generated", "generated(type, term): two arguments")
	}
	const described = describedField(type, "generated type")
	if (writingOf(type).kind !== "caller") {
		throw malformed("generated", "a value type, which no field of a writing of its own is")
	}
	const value: GeneratedField<F> = Object.freeze({
		writing: "generated",
		type,
		column: type.column,
		sql: type.sql
	})
	generatedEntries.set(value, { type: described, term })
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
	const entry =
		typeof value === "object" && value !== null ? generatedEntries.get(value) : undefined
	if (entry === undefined) {
		throw malformed(label, "a field built by generated(type, term)")
	}
	const expr = termExpr(entry.term)
	if (expr === undefined) {
		throw malformed(
			label,
			"a term of the row: one of its fields, a closed read, or a Compute expression"
		)
	}
	const decoded: ExprDesc = orThrow(decodeDesc("expr", expr))
	return { type: entry.type.desc, writing: { kind: "generated", expr: decoded } }
}

/**
 * The admission core of relation.generated(...): the written fields checked and described as relation's are, the
 * callback run once over their row, and each field it returns a generated field named apart from every written field.
 * The relation's fields are its written fields, then its generated ones. The row types each field by its declared
 * type, a drawn or an accumulated one's included, which the public type leaves out of the row: an expression a
 * JavaScript caller builds over one reaches the checker, which refuses it by name (GeneratedRule readsUnwritten).
 */
const admitGenerated = <G>(
	name: unknown,
	written: unknown,
	primaryKey: unknown,
	generate: RowCallback<G>["run"],
	extra: ReadonlyArray<unknown>
): { readonly desc: OrdinaryRelationDesc; readonly generated: G } => {
	const label = `relation ${typeof name === "string" ? name : "?"}`
	const relationName = requireName(name, label, "a relation name")
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
		Object.entries(descriptors).map(([field, d]) => [field, descriptorOf(d)] as const)
	)
	const row = rowScalars(fieldMap(described), declared, (field) =>
		rosterHandlesOf(descriptors[field])
	)
	const generated = generate(row)
	if (!isPlainRecord(generated)) {
		throw malformed(label, "a record of generated fields, each generated(type, term)")
	}
	const fields: Record<string, FieldDecl> = { ...writtenDecls(descriptors, described, label) }
	for (const [field, value] of Object.entries(generated)) {
		if (Object.hasOwn(fields, field)) {
			throw malformed(
				label,
				`a generated field named apart from the written fields; ${field} is written`
			)
		}
		fields[field] = generatedDecl(value, `${label} generated field ${field}`)
	}
	return { desc: ordinaryDesc(label, relationName, fields, primaryKey), generated }
}

/**
 * relation, relation.generated, closed, closed.relation and derived: the relation constructors.
 *
 * - `relation(name, fields, primaryKey)`: an ordinary relation, every field written by its caller. The primary key is
 *   required and nonempty, a list of the relation's own field names in the order written; a pure set lists every
 *   field. It lowers to PRIMARY KEY; there is no implicit full-row UNIQUE and no surrogate.
 * - `relation.generated(name, written, primaryKey, (row) => ({ f: generated(type, term), ... }))`: an ordinary
 *   relation whose callback-returned fields PostgreSQL writes, each a STORED generated column whose term reads the row
 *   of the written fields alone, as PostgreSQL's generation expressions read no generated column.
 * - `closed(name, handles)`: a roster, the handles it introduces in declared order, which is their codes' order and
 *   comparison order.
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
export const relation = <
	const Name extends string,
	const Fields extends Readonly<Record<string, FieldBase>>,
	const PrimaryKey extends ReadonlyArray<keyof Fields & string>
>(
	name: Name,
	fields: Fields,
	primaryKey: PrimaryKey,
	extra: ReadonlyArray<unknown>
): Relation<Name, Fields, readonly [...PrimaryKey]> => {
	/** Admission first: a JavaScript caller's malformed argument is MalformedDescription before anything is copied. */
	const desc = admitRelation(name, fields, primaryKey, extra)
	const copied = frozenCopy(fields)
	return ownValue(
		{
			kind: "relation",
			name,
			fields: copied,
			primaryKey: frozenTuple<PrimaryKey>(primaryKey),
			fact: record<[Fields]>(copied),
			heading: copied
		},
		"relation",
		desc,
		contentDigest("relation", desc)
	)
}

/**
 * relation.generated(name, written, primaryKey, generate): the relation of the written fields and the generated fields
 * `generate` returns over their row. Its value holds the written fields and then the generated ones, a frozen copy, and
 * its `fact` reads both: a generated field is read as every field is.
 */
export const generatedRelation = <
	const Name extends string,
	const Written extends Readonly<Record<string, FieldBase>>,
	const PrimaryKey extends ReadonlyArray<keyof Written & string>,
	const G extends Readonly<Record<string, GeneratedField<FieldBase>>>
>(
	name: Name,
	written: Written,
	primaryKey: PrimaryKey,
	generate: RowCallback<G>["run"],
	extra: ReadonlyArray<unknown>
): Relation<Name, Written & G, readonly [...PrimaryKey]> => {
	const admitted = admitGenerated(name, written, primaryKey, generate, extra)
	const copied = frozenCopy({ ...written, ...admitted.generated })
	return ownValue(
		{
			kind: "relation",
			name,
			fields: copied,
			primaryKey: frozenTuple<PrimaryKey>(primaryKey),
			fact: record<[Written & G]>(copied),
			heading: copied
		},
		"relation",
		admitted.desc,
		contentDigest("relation", admitted.desc)
	)
}

/** A roster: nonempty, distinct, each handle at most the bytes a name holds, as its names constant stores it. */
const handleList = (value: unknown, label: string): NonEmptyReadonlyArray<string> => {
	const handles = requireNames(value, label, "a nonempty roster of distinct handles")
	for (const h of handles) {
		if (utf8Length(h) > handleMaxBytes.value) {
			throw malformed(
				label,
				`handles of at most ${handleMaxBytes.value} UTF-8 bytes, the most a name holds (NAMEDATALEN - 1); ${JSON.stringify(h)} has ${utf8Length(h)}`
			)
		}
	}
	return handles
}

/** The admission core of closed(...): a JavaScript caller's arguments checked and described. */
export const admitRoster = (
	name: unknown,
	handles: unknown,
	extra: ReadonlyArray<unknown>
): RosterDesc => {
	const label = `closed ${typeof name === "string" ? name : "?"}`
	const rosterName = requireName(name, label, "a roster name")
	if (extra.length > 0) {
		throw malformed(
			label,
			"closed(name, handles): two arguments; a closed relation over a roster is closed.relation(name, fields, key, rows)"
		)
	}
	const desc = orThrow(
		decodeDesc("relation", {
			kind: "closed",
			name: rosterName,
			handles: handleList(handles, label),
			loc: builderLoc(label, [rosterName])
		})
	)
	if (desc.kind !== "closed") {
		throw malformed(label, "a relation description of a roster")
	}
	return desc
}

/**
 * closed(name, handles): a roster. The id of every fact is the roster's closed id column, over the caller's handles,
 * which admission read; a fact is the handle under id. `handle(member)` is the member as a typed constant
 * (scalar/compute/builders.ts handleTerm).
 */
export const closed = <
	const Name extends string,
	const Handles extends NonEmptyReadonlyArray<string>
>(
	name: Name,
	handles: Handles & NonEmptyReadonlyArray<Handles[number]>,
	extra: ReadonlyArray<unknown>
): Roster<Name, readonly [...Handles]> => {
	const desc = admitRoster(name, handles, extra)
	const roster = frozenTuple<Handles>(handles)
	const id: ClosedId<Handles[number], Name> = Object.freeze({
		id: Object.freeze({ column: codeColumn<Handles[number]>(name, handles), sql: carrierSql.code })
	})
	const value: Roster<Name, readonly [...Handles]> = ownValue(
		{
			kind: "closed",
			name,
			handles: roster,
			fact: record<[ClosedId<Handles[number], Name>]>(id),
			heading: id,
			handle: <const M extends Handles[number]>(member: M) => handleTerm(value, member)
		},
		"closed",
		desc,
		contentDigest("relation", desc)
	)
	return value
}

/** Whether a field descriptor is a closed id, through any depth of contracts. */
const isClosedIdDesc = (desc: FieldDesc): boolean =>
	desc.kind === "closedId" || (desc.kind === "contract" && isClosedIdDesc(desc.base))

/**
 * A closed relation's rows as a JavaScript caller wrote them, checked and described, as the set of facts they state: a
 * row written twice is one row, its first, and two rows of one key but other payloads break the key law, refused naming
 * the key and both payloads. `kept` is the index of each row of the set among those written, in their order. Rows are
 * keyed by their key fields' handles (closed ids, which literalFor reads as their handles), and a pair's payloads are
 * compared only where their keys meet, so the set costs a text per row.
 */
const closedRows = (
	rows: unknown,
	fields: Readonly<Record<string, FieldDesc>>,
	descriptors: Readonly<Record<string, unknown>>,
	key: unknown,
	label: string
): {
	readonly rows: ReadonlyArray<Readonly<Record<string, LiteralDesc>>>
	readonly kept: ReadonlyArray<number>
} => {
	if (!isList(rows)) {
		throw malformed(label, "rows: a list of the relation's facts")
	}
	const names = Object.keys(fields)
	/** Each field with its roster's handles where it is a closed id, read once into a set each cell is found in. */
	const typed = Object.entries(fields).map(([field, desc]) => {
		if (!isClosedIdDesc(desc)) {
			return { field, desc, handles: undefined }
		}
		const roster = rosterHandlesOf(descriptors[field])
		if (roster === undefined) {
			throw malformed(
				label,
				`a closed id ${field} built by closedId(roster), which carries its roster`
			)
		}
		return { field, desc, handles: new Set<LiteralDesc>(roster) }
	})
	const keyFields =
		isList(key) && key.every((k): k is string => typeof k === "string" && names.includes(k))
			? key
			: names
	const shown = (value: LiteralDesc | undefined): string =>
		typeof value === "string" ? value : canonicalTextOf(value)
	const payloadOf = (row: Readonly<Record<string, LiteralDesc>>): string =>
		canonicalTextOf(
			Object.fromEntries(names.filter((f) => !keyFields.includes(f)).map((f) => [f, row[f]]))
		)
	const byKey = new Map<string, number>()
	const out: Array<Readonly<Record<string, LiteralDesc>>> = []
	const kept: Array<number> = []
	for (const [i, row] of rows.entries()) {
		if (!isPlainRecord(row)) {
			throw malformed(label, `row ${i}: a fact, a record of a value per field`)
		}
		const own = Object.keys(row)
		if (own.length !== names.length || !names.every((f) => Object.hasOwn(row, f))) {
			throw malformed(label, `row ${i} with exactly the fields ${names.join(", ")}`)
		}
		const literals: Record<string, LiteralDesc> = {}
		for (const { field, desc, handles } of typed) {
			const at = `${label} row ${i} field ${field}`
			const literal = literalFor(desc, row[field], at, undefined)
			if (handles !== undefined && !handles.has(literal)) {
				throw malformed(at, describeFault("codeHandle"))
			}
			literals[field] = literal
		}
		const handles = keyFields.map((f) => literals[f])
		const keyText = handles.every((h): h is string => typeof h === "string")
			? handles.join("\u0000")
			: canonicalTextOf(handles)
		const earlier = byKey.get(keyText)
		if (earlier === undefined) {
			byKey.set(keyText, out.length)
			out.push(literals)
			kept.push(i)
			continue
		}
		const first = defined(out[earlier], "a row of a key seen")
		if (payloadOf(first) !== payloadOf(literals)) {
			throw malformed(
				label,
				`one fact per key; rows ${defined(kept[earlier], "the row's index")} and ${i} hold the key (${keyFields.map((f) => `${f} = ${shown(literals[f])}`).join(", ")}) with the payloads ${payloadOf(first)} and ${payloadOf(literals)}`
			)
		}
	}
	return { rows: out, kept }
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
	/** The index of each row of the set among those written (closedRows). */
	readonly kept: ReadonlyArray<number>
} => {
	const label = `closed.relation ${typeof name === "string" ? name : "?"}`
	const relationName = requireName(name, label, "a closed relation name")
	if (extra.length > 0) {
		throw malformed(label, "closed.relation(name, fields, key, rows): four arguments")
	}
	const descriptors = descriptorRecord(fields, label)
	for (const [field, value] of Object.entries(descriptors)) {
		if (writingOf(value).kind !== "caller") {
			throw malformed(
				label,
				`fields its declaration's rows hold; ${field} is written by ${writingOf(value).kind === "serial" ? "its sequence" : "grizzle"}`
			)
		}
	}
	const described = describedFields(descriptors, label)
	const fieldDescs = fieldMap(described)
	const facts = closedRows(rows, fieldDescs, descriptors, key, label)
	/**
	 * The description decoded without its rows, which closedRows proved, each a value of exactly the relation's fields
	 * as literalFor reads it, one per key: decoding them again would prove it twice, and is most of a large relation's
	 * cost. The description shape's own row check holds of the rows trivially, and the schema's decode reads them again.
	 */
	const desc = orThrow(
		decodeDesc("relation", {
			kind: "closedRelation",
			name: relationName,
			fields: fieldDescs,
			key,
			slots: keySlots(descriptors, key, label),
			rows: [],
			loc: builderLoc(label, [relationName])
		})
	)
	if (desc.kind !== "closedRelation") {
		throw malformed(label, "a relation description of a closed relation")
	}
	const admitted = recordAdmitted({ ...desc, rows: facts.rows })
	return { desc: admitted, described, kept: facts.kept }
}

/**
 * The typing of a closed relation's reads (scalar/compute/closed.ts): each key field's declared type, each payload
 * field's type and carrier, and the set over the last key field's roster, whose descriptor carries the roster.
 */
const closedReadTyping = (
	desc: ClosedRelationDesc,
	described: Readonly<Record<string, Described>>,
	descriptors: Readonly<Record<string, unknown>>,
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
	const last = desc.key[desc.key.length - 1] ?? desc.key[0]
	const lastDesc = typeOf(last).desc
	const handles = rosterHandlesOf(descriptors[last])
	if (lastDesc.kind !== "closedId" || handles === undefined || !isNonEmpty(handles)) {
		throw malformed(label, `a key of closed ids, each built by closedId(roster); ${last} is none`)
	}
	const roster = lastDesc.roster
	const env: ScalarEnv = {
		kind: "builder",
		roster: (n) => (n === roster ? handles : undefined)
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
 * its `fact` is the decoder of its rows' fields, and its heading its fields. `at` and `row` are its closed reads
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
	const typing = closedReadTyping(admitted.desc, admitted.described, copied, label)
	return ownValue(
		{
			kind: "closedRelation",
			name,
			fields: copied,
			key: frozenTuple<Key>(key),
			rows: Object.freeze(admitted.kept.map((i) => frozenCopy(defined(rows[i], "a kept row")))),
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
			row: (...args: ReadonlyArray<unknown>) => closedRowTerm(typing, args)
		},
		"closedRelation",
		admitted.desc,
		contentDigest("relation", admitted.desc)
	)
}

/** The brand of a set over a roster, minted only by bitsOf from handles it checked. */
const mintBits = <C>() => nominal<ReadonlySet<HandleOf<C>>, Bits<C>>()

/**
 * Bits.of(roster, handles): the set of `handles`, a fresh Set branded by the roster, which the caller owns: a Set
 * cannot be frozen, and every boundary that admits one copies it. Each handle is one of the roster's, each once: a
 * JavaScript caller's other value is MalformedDescription.
 */
export const bitsOf = <C extends AnyRoster>(
	roster: C,
	handles: ReadonlyArray<HandleOf<C>>,
	extra: ReadonlyArray<unknown>
): Bits<C> => {
	const label = "Bits.of"
	if (extra.length > 0) {
		throw malformed(label, "Bits.of(roster, handles): two arguments")
	}
	if (ownedKind(roster) !== "closed" || !isList(handles)) {
		throw malformed(label, "a roster built by closed(name, handles), and a list of its handles")
	}
	const members = new Set<HandleOf<C>>()
	for (const h of handles) {
		if (!roster.handles.includes(h)) {
			throw malformed(label, `handles of ${roster.name}; ${JSON.stringify(h)} is none`)
		}
		if (members.has(h)) {
			throw malformed(label, `each handle once; ${JSON.stringify(h)} repeats`)
		}
		members.add(h)
	}
	return mintBits<C>()(members)
}

/** The admission core of derived(...): the definition checked and recorded, as relation's is. */
export const admitDerived = (
	name: unknown,
	definition: unknown,
	extra: ReadonlyArray<unknown>
): DerivedDraft => {
	const label = `derived ${typeof name === "string" ? name : "?"}`
	const derivedName = requireName(name, label, "a derived relation name")
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
			`a definition that matches no context, which a materialized view holds no session for; it matches ${[...uses.contexts.keys()].toSorted(compareStrings).join(", ")}`
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
 */
export const derived = <const Name extends string, Q extends DefinitionQuery>(
	name: Name,
	definition: Q,
	extra: ReadonlyArray<unknown>
): Derived<Name, Q> => {
	const draft = admitDerived(name, definition, extra)
	const heading: Q["heading"] = definition.heading
	return ownValue(
		{ ...builtMark, kind: "derived", name, definition, heading, fact: record(heading) },
		"derived",
		draft,
		contentDigest("relation", draft)
	)
}

/**
 * The Description of a relation, roster or closed relation value: an owned value's own, or a JavaScript look-alike's,
 * described by the admission core so that it is checked exactly as a built one is.
 */
export const relationDescOf = (
	value: unknown,
	label: string
): OrdinaryRelationDesc | RosterDesc | ClosedRelationDesc => {
	const owned =
		ownedDesc(value, "relation") ?? ownedDesc(value, "closed") ?? ownedDesc(value, "closedRelation")
	if (owned !== undefined) {
		return owned
	}
	if (hasProperties(value) && ownedKind(value) === undefined) {
		if (value["kind"] === "relation") {
			return admitRelation(value["name"], value["fields"], value["primaryKey"], [])
		}
		if (value["kind"] === "closed") {
			return admitRoster(value["name"], value["handles"], [])
		}
		if (value["kind"] === "closedRelation") {
			return admitClosedRelation(value["name"], value["fields"], value["key"], value["rows"], [])
				.desc
		}
	}
	throw malformed(
		label,
		"a relation, roster or closed relation, built by relation(...), closed(...) or closed.relation(...)"
	)
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
		throw malformed(label, "the slots of a count, built by fin(owner, count)")
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
 * A relation, roster or closed relation of a schema's record, with its content digest: a built value's, which it carries
 * from its build, or a JavaScript look-alike's, admitted here (relationDescOf) and digested once, where it enters.
 */
export const relationContentOf = (
	value: unknown,
	label: string
): {
	readonly desc: OrdinaryRelationDesc | RosterDesc | ClosedRelationDesc
	readonly digest: ContentDigest
} => {
	const owned =
		ownedEntry(value, "relation") ??
		ownedEntry(value, "closed") ??
		ownedEntry(value, "closedRelation")
	if (owned !== undefined) {
		return { desc: owned.desc, digest: owned.content }
	}
	const desc = relationDescOf(value, label)
	return { desc, digest: contentDigest("relation", desc) }
}

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
			readonly roster: NonEmptyReadonlyArray<string>
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
 * The handles a field of a relation, roster or closed relation holds, when it is a closed handle: a roster's id holds
 * its roster, and a closedId field the roster its descriptor carries.
 */
export const fieldRoster = (
	rel: Exclude<NamedRelation, { readonly kind: "derived" }>,
	field: string
): ReadonlyArray<string> | undefined =>
	rel.kind === "closed" && field === "id" ? rel.roster : rosterHandlesOf(rel.descriptors[field])

/** The descriptor a field value was built from: its own, or a drawn, accumulated, slot or generated field's declared
 * type's. */
const descriptorOf = (value: unknown): unknown => {
	const recorded = writtenByOf(value) ?? slottedOf(value)
	if (recorded !== undefined) {
		return recorded.type
	}
	const entry =
		typeof value === "object" && value !== null ? generatedEntries.get(value) : undefined
	return entry === undefined ? value : hasProperties(value) ? value["type"] : value
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
			out[field] = descriptorOf(d)
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
				fields: { id: { kind: "closedId", roster: desc.name } },
				primaryKey: ["id"],
				roster: desc.handles,
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
