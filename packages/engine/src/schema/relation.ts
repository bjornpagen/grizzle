import { handleColumn } from "#compiler/core/decoder.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { hasProperties } from "#compiler/core/record.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import {
	decodeDesc,
	type FieldDesc,
	type LiteralDesc,
	type QueryDesc,
	type RelationDesc
} from "#compiler/ir/desc.ts"
import { handleTerm } from "#compiler/scalar/compute/builders.ts"
import type { Described } from "#compiler/scalar/registry.ts"
import { literalFor } from "#compiler/schema/literal.ts"
import {
	builderLoc,
	describedField,
	frozenCopies,
	frozenCopy,
	frozenRecord,
	frozenTuple,
	isPlainRecord,
	malformed,
	maxEnumLabelBytes,
	orThrow,
	ownedDesc,
	ownedKind,
	ownValue,
	queryDescOf,
	requireName,
	requireNames,
	rosterHandlesOf
} from "#compiler/schema/protocol.ts"
import { record } from "#compiler/schema/record.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import type { DefinitionQuery, Derived } from "#compiler/types/derived/derived.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type {
	Closed,
	ClosedId,
	EnumClosed,
	FactsOf,
	Relation
} from "#compiler/types/schema/relation.ts"

export type OrdinaryRelationDesc = Extract<RelationDesc, { readonly kind: "relation" }>
export type ClosedRelationDesc = Extract<RelationDesc, { readonly kind: "closed" }>
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
		out[name] = describedField(descriptor, `${label} field ${name}`)
	}
	return Object.freeze(out)
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
 * The admission core of relation(...): a JavaScript caller's arguments checked and described, the one path a relation's
 * Description is built by.
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
	const descriptors = descriptorRecord(fields, label)
	const described = describedFields(descriptors, label)
	const loc = builderLoc(label, [relationName])
	const desc = orThrow(
		decodeDesc("relation", {
			kind: "relation",
			name: relationName,
			fields: fieldMap(described),
			primaryKey,
			loc
		})
	)
	if (desc.kind !== "relation") {
		throw malformed(label, "a relation description of an ordinary relation")
	}
	return desc
}

/**
 * relation, closed and derived: the relation constructors.
 *
 * - `relation(name, fields, primaryKey)`: an ordinary relation. The primary key is required and nonempty, a list of
 *   the relation's own field names in the order written; a pure set lists every field. It
 *   lowers to PRIMARY KEY; there is no implicit full-row UNIQUE and no surrogate.
 * - `closed(name, handles)` and `closed(name, handles).with(payload, facts)`: a closed relation, first-class finite
 *   facts with the heading { id } & payload and primary key ["id"]. The roster order is declared order,
 *   which is comparison order. The payload descriptors are kept as written, and each handle's fact is
 *   checked against them at construction: every handle has exactly one fact with exactly the payload's fields. The two
 *   forms agree: closed(n, hs) is closed(n, hs).with({}, { h: {} ... }), one Description.
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
		desc
	)
}

/** A roster: nonempty, distinct, each handle a PostgreSQL enum label of at most 63 UTF-8 bytes. */
const handleList = (value: unknown, label: string): NonEmptyReadonlyArray<string> => {
	const handles = requireNames(value, label, "a nonempty roster of distinct handles")
	for (const h of handles) {
		if (utf8Length(h) > maxEnumLabelBytes.value) {
			throw malformed(
				label,
				`handles of at most ${maxEnumLabelBytes.value} UTF-8 bytes, the limit of a PostgreSQL enum label; ${JSON.stringify(h)} has ${utf8Length(h)}`
			)
		}
	}
	return handles
}

/**
 * The payload a closed relation's facts carry: its descriptors, and one fact per handle. closed(name, handles) has
 * none, which is the empty payload with an empty fact for every handle.
 */
interface ClosedPayload {
	readonly payload: unknown
	readonly facts: unknown
}

/**
 * What the admission core of closed checked: the Description, and the host facts it read, one per handle, the enum-only
 * form's empty ones among them.
 */
interface AdmittedClosed {
	readonly desc: ClosedRelationDesc
	readonly facts: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

/**
 * The admission core of closed(...) and of its .with(...): a JavaScript caller's arguments checked and
 * described. closed(name, handles) is closed(name, handles).with({}, { h: {} for each handle }), one Description.
 */
export const admitClosed = (
	name: unknown,
	handles: unknown,
	withPayload: ClosedPayload | undefined,
	extra: ReadonlyArray<unknown>
): AdmittedClosed => {
	const label = `closed ${typeof name === "string" ? name : "?"}`
	const closedName = requireName(name, label, "a closed relation name")
	if (extra.length > 0) {
		throw malformed(
			label,
			withPayload === undefined
				? "closed(name, handles): two arguments; a payload is closed(name, handles).with(payload, facts)"
				: "closed(name, handles).with(payload, facts): two arguments"
		)
	}
	const roster = handleList(handles, label)
	const payloadDescriptors = descriptorRecord(
		withPayload === undefined ? {} : withPayload.payload,
		`${label} payload`
	)
	const described = describedFields(payloadDescriptors, `${label} payload`)
	const payload = fieldMap(described)
	if (Object.hasOwn(payload, "id")) {
		throw malformed(label, "a payload without a field named id: id is the roster handle")
	}
	const facts: Record<string, Readonly<Record<string, LiteralDesc>>> = {}
	const hostFacts: Record<string, Readonly<Record<string, unknown>>> = {}
	if (withPayload === undefined) {
		for (const h of roster) {
			facts[h] = {}
			hostFacts[h] = Object.freeze({})
		}
	} else {
		const factsArg = withPayload.facts
		if (!isPlainRecord(factsArg)) {
			throw malformed(label, "facts: one payload fact per handle")
		}
		for (const key of Object.keys(factsArg)) {
			if (!roster.includes(key)) {
				throw malformed(label, `facts for the roster's handles only; ${key} is not one`)
			}
		}
		const payloadFields = Object.keys(payload)
		for (const h of roster) {
			const fact = factsArg[h]
			if (!isPlainRecord(fact)) {
				throw malformed(label, `a payload fact for every handle; ${h} has none`)
			}
			const keys = Object.keys(fact)
			if (
				keys.length !== payloadFields.length ||
				!payloadFields.every((f) => Object.hasOwn(fact, f))
			) {
				throw malformed(
					label,
					`the fact for ${h} with exactly the payload fields ${payloadFields.join(", ")}`
				)
			}
			const literals: Record<string, LiteralDesc> = {}
			for (const [f, fieldDesc] of Object.entries(payload)) {
				const handlesOfField = rosterHandlesOf(payloadDescriptors[f])
				literals[f] = literalFor(fieldDesc, fact[f], `${label} fact ${h}.${f}`, handlesOfField)
			}
			facts[h] = literals
			hostFacts[h] = frozenRecord(fact)
		}
	}
	const loc = builderLoc(label, [closedName])
	const desc = orThrow(
		decodeDesc("relation", {
			kind: "closed",
			name: closedName,
			handles: roster,
			payload,
			facts,
			loc
		})
	)
	if (desc.kind !== "closed") {
		throw malformed(label, "a relation description of a closed relation")
	}
	return { desc, facts: hostFacts }
}

/** Whether `facts` holds a fact for every handle, the check that types it as the empty facts of that roster. */
const emptyFactsOf = <H extends string>(
	facts: Readonly<Record<string, unknown>>,
	handles: ReadonlyArray<H>
): facts is Readonly<Record<string, unknown>> & FactsOf<H, unknown> =>
	handles.every((h) => Object.hasOwn(facts, h))

/**
 * closed(name, handles) is the enum-only form. Its `with(payload, facts)` builds a new closed relation of the same name
 * and roster with a payload fact for every handle; the enum-only form is that relation with the empty payload, one
 * Description. The id of every fact is the roster's handle column, an enum, over the caller's handles, which admission
 * read; a fact is the handle under id, beside the payload's fields. Each form's `handle(member)` is the member as a
 * typed constant (scalar/compute/builders.ts handleTerm).
 */
export const closed = <
	const Name extends string,
	const Handles extends NonEmptyReadonlyArray<string>
>(
	name: Name,
	handles: Handles & NonEmptyReadonlyArray<Handles[number]>,
	extra: ReadonlyArray<unknown>
): EnumClosed<Name, readonly [...Handles]> => {
	const admitted = admitClosed(name, handles, undefined, extra)
	const roster = frozenTuple<Handles>(handles)
	const facts = frozenRecord(admitted.facts)
	if (!emptyFactsOf(facts, roster)) {
		throw malformed(`closed ${name}`, "an empty fact for every handle")
	}
	const id: ClosedId<Handles[number], Name> = Object.freeze({
		id: Object.freeze({ column: handleColumn<Handles[number]>(handles), sql: "enum" })
	})
	const withPayload = <const Payload extends Record<string, FieldBase>>(
		payload: Payload,
		payloadFacts: FactsOf<Handles[number], Payload>,
		...more: ReadonlyArray<unknown>
	): Closed<Name, Handles[number], Payload, readonly [...Handles]> => {
		const { desc } = admitClosed(name, roster, { payload, facts: payloadFacts }, more)
		const copied = frozenCopy(payload)
		const withValue: Closed<Name, Handles[number], Payload, readonly [...Handles]> = ownValue(
			{
				kind: "closed",
				name,
				handles: roster,
				payload: copied,
				facts: frozenCopies(payloadFacts, roster),
				fact: record<[ClosedId<Handles[number], Name>, Payload]>(id, copied),
				heading: Object.freeze({ ...id, ...copied }),
				handle: <const M extends Handles[number]>(member: M) => handleTerm(withValue, member)
			},
			"closed",
			desc
		)
		return withValue
	}
	const empty = frozenCopy({})
	const value: EnumClosed<Name, readonly [...Handles]> = ownValue(
		{
			kind: "closed",
			name,
			handles: roster,
			payload: empty,
			facts,
			fact: record<[ClosedId<Handles[number], Name>]>(id),
			heading: id,
			handle: <const M extends Handles[number]>(member: M) => handleTerm(value, member),
			with: withPayload
		},
		"closed",
		admitted.desc
	)
	return value
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
		draft
	)
}

/**
 * The Description of a relation or closed relation value: an owned value's own, or a JavaScript look-alike's,
 * described by the admission core so that it is checked exactly as a built one is.
 */
export const relationDescOf = (
	value: unknown,
	label: string
): OrdinaryRelationDesc | ClosedRelationDesc => {
	const owned = ownedDesc(value, "relation") ?? ownedDesc(value, "closed")
	if (owned !== undefined) {
		return owned
	}
	if (hasProperties(value) && ownedKind(value) === undefined) {
		if (value["kind"] === "relation") {
			return admitRelation(value["name"], value["fields"], value["primaryKey"], [])
		}
		if (value["kind"] === "closed") {
			return admitClosed(
				value["name"],
				value["handles"],
				{ payload: value["payload"], facts: value["facts"] },
				[]
			).desc
		}
	}
	throw malformed(label, "a relation or closed relation, built by relation(...) or closed(...)")
}

export const derivedDraftOf = (value: unknown): DerivedDraft | undefined =>
	ownedDesc(value, "derived")

/**
 * The name and kind of anything a statement may name. A relation or a closed relation has a known heading: its fields'
 * Descriptions, its primary key, and the descriptors its fields were built from, which literal contexts read (a closedId
 * field's roster). A relation's descriptors are its fields'. A closed relation's are its payload's: its id has no
 * descriptor, and its roster, the handles the id holds, is its own member. A derived relation's fields are inferred at
 * compilation, so a statement knows only its name.
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
	| { readonly kind: "derived"; readonly name: string }

/**
 * The handles a field of a relation or closed relation holds, when it is a closed handle: a closed relation's id holds
 * its roster, and a closedId field the roster its descriptor carries.
 */
export const fieldRoster = (
	rel: Exclude<NamedRelation, { readonly kind: "derived" }>,
	field: string
): ReadonlyArray<string> | undefined =>
	rel.kind === "closed" && field === "id" ? rel.roster : rosterHandlesOf(rel.descriptors[field])

export const namedRelation = (value: unknown, label: string): NamedRelation => {
	const draft = derivedDraftOf(value)
	if (draft !== undefined) {
		return { name: draft.name, kind: "derived" }
	}
	const desc = relationDescOf(value, label)
	/** relationDescOf admitted the value, so it is a record whose fields or payload are a record of descriptors. */
	const member = (key: string): Readonly<Record<string, unknown>> => {
		const descriptors = hasProperties(value) ? value[key] : undefined
		return hasProperties(descriptors) ? descriptors : {}
	}
	if (desc.kind === "relation") {
		return {
			name: desc.name,
			kind: "relation",
			fields: desc.fields,
			primaryKey: desc.primaryKey,
			descriptors: member("fields")
		}
	}
	const closedId: FieldDesc = { kind: "closedId", roster: desc.name }
	return {
		name: desc.name,
		kind: "closed",
		fields: { id: closedId, ...desc.payload },
		primaryKey: ["id"],
		roster: desc.handles,
		descriptors: member("payload")
	}
}
