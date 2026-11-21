/**
 * A query's records: the relations that hold the rows a query found, each column the query's own field, each
 * attachment, at any depth, a relation of its own, and the query that reads them back through the query's own decoder
 * (records, recordsQuery and recordsFacts, the public schema barrel's, typed by types/schema/records.ts).
 *
 * - records(stem, query, owner, ownerKey): the root relation `${stem}Row`, the owner's fields, then one stored field per
 *   column of the query's heading, then a drawn count under the name of each array attachment, keyed by the owner's
 *   key. A column's field is its type's (analysis/derived fieldDescOf over the column's ScalarType, the one reading of a
 *   column's type as a field's, a derived relation's among its readers), its column the query's own (core/decoder.ts
 *   Column), so a contract column is the schema's own declaration of the contract, brand and check, a closed id a closed
 *   id of its roster, resolved by name in the level that lists the records, a refined text the text of its patterns, a
 *   computed numeric numeric within its bound (pg.numeric.within), numeric of no typmod at numeric's own limits
 *   pg.numeric, an instant a stored instant (instant.stored), which the database draws nothing of, and a search
 *   document a stored one (pg.tsvector). A head literal is stored nowhere: the read writes it again; head literals of
 *   several values at one key, a union's, are a column whose values are exactly them (literalsField). A union of several
 *   headings or a column of a contract the schema does not declare is refused, each naming what it lacks.
 * - Each attachment's relation (types/schema/records.ts types each): `${stem}${Capitalize<name>}`, or its
 *   parent's name followed by `Capitalize<name>` where that name is another attachment's or the root's `Row`; its fields
 *   its parent's key carried, each name fresh beside its own columns and attachments, its place `at` for an array, its
 *   stored columns and its arrays' counts; keyed by the carried key, then its place. Its law over its parent: an array is
 *   the parent's ordered family counted at its name, so an insert nests its members in order and its places are 0 … n − 1
 *   by grizzle's family laws; an option is contained in its parent, keyed by its parent's key alone; one mirrors its
 *   parent; the arms of one discriminator field are one alternatives law over it.
 * - recordsQuery(level, records): the rows stored at one value of the owner's key, each key field a parameter of its
 *   name, read by one rule over the root, each attachment attached as the query states its delivery, over its relation
 *   keyed by its parent's delivered key and an array ordered by its place, and delivered through the query's own
 *   decoders (query/build/query.ts decodedBy): the one decoder, whose form is the query's, so its rows are the query's
 *   under either reading.
 * - recordsFacts(level, records): the insert of found rows, each beside its owner's values, as insertAll takes it:
 *   under the root's name each row's fact, its owner's values then its stored columns, each array's members nested at
 *   its count with theirs; under each other attachment's relation its facts, its carried key's values then its own.
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { fieldDescOf } from "#compiler/analysis/derived/fields.ts"
import { decoderOf, headingsOf } from "#compiler/core/decoder.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { arm } from "#compiler/query/build/attach.ts"
import {
	decodedBy,
	type OrderedValue,
	type QueryValue,
	queryOver,
	varsOver
} from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import {
	type AttachedChild,
	headingOf,
	headingTypings,
	type QueryState,
	queryState
} from "#compiler/query/build/state.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { defineField, type ScalarEnv } from "#compiler/scalar/registry.ts"
import type { Level } from "#compiler/schema/level.ts"
import { literalsField } from "#compiler/schema/literals.ts"
import { type Owned, own, ownRole } from "#compiler/schema/own.ts"
import {
	builderLoc,
	type HeadingTyping,
	malformed,
	orThrow,
	requireName
} from "#compiler/schema/protocol.ts"
import {
	type RecordsFact,
	recordFields,
	recordsInsert,
	recordsValue
} from "#compiler/schema/record.ts"
import { drawnField, relationBuilder } from "#compiler/schema/relation.ts"
import {
	alternativesBuilder,
	containedBuilder,
	finBuilder,
	mirrorsBuilder,
	onBuilder,
	orderedBuilder
} from "#compiler/schema/statements.ts"
import type { Carrier, Carriers } from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type {
	ArmOf,
	AttachmentDelivery,
	HeadOf,
	ImmediateHeadOf
} from "#compiler/types/query/query.ts"
import type {
	AnyRecords,
	OwnerFacts,
	OwnerParams,
	RecordApart,
	RecordChildren,
	RecordedQuery,
	RecordFields,
	RecordLaws,
	RecordOwner,
	Records,
	RecordsInsert,
	RecordsQuery,
	RecordsRelation
} from "#compiler/types/schema/records.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"

/**
 * A field of a records relation's key: its name there, and the descriptor a child relation carries it by, the field's
 * own but for a place, drawn where its ordered family draws it and a plain natural where a child carries it.
 */
interface KeyField {
	readonly name: string
	readonly carried: FieldBase
}

/** How an attachment's relation holds its child's records: as an array at its place, an option, the one child or an arm. */
type Holding =
	| { readonly kind: "array"; readonly place: string }
	| { readonly kind: "option" }
	| { readonly kind: "one" }
	| { readonly kind: "arm"; readonly field: string; readonly handle: string }

/** A relation that holds records, as the attachments under it read it: the relation, and its key in order. */
interface Parent {
	readonly relation: RecordsRelation
	readonly key: ReadonlyArray<KeyField>
}

/**
 * A relation that holds records, as its read and its insert read it: the relation, its key in order, its stored
 * columns, each head literal's value under its key, and each attachment's records under it, in the order attached.
 */
interface Holder extends Parent {
	readonly columns: ReadonlyArray<string>
	readonly literals: ReadonlyArray<readonly [string, unknown]>
	readonly attachments: ReadonlyArray<AttachmentRecords>
}

/**
 * An attachment's records: its name, how its relation holds its child's records, each field of its relation that
 * carries its parent's key with the parent's key field it carries, in key order, and the relation as a holder.
 */
interface AttachmentRecords {
	readonly name: string
	readonly holding: Holding
	readonly carries: ReadonlyArray<readonly [string, string]>
	readonly holder: Holder
}

/**
 * What a records value holds beside its public members, read by its read and its facts: the root as a holder, the
 * owner's fields in order with their descriptors, and the relations an insert states apart from the root.
 */
interface RecordsState {
	readonly root: Holder
	readonly owner: ReadonlyArray<string>
	readonly ownerFields: RecordOwner
	readonly apart: ReadonlyArray<RecordsRelation>
}

/** Each records value's state, by the value: a WeakMap, so it holds nothing alive and is never enumerated. */
const states = new WeakMap<object, RecordsState>()

/** The owned schema a query's level is over, whose contracts its contract columns are declared by. */
const ownedOf = (level: Level, label: string): Result.Result<Owned, CompileError> => {
	switch (level.kind) {
		case "schema":
			return own(level.desc)
		case "role":
			return Result.map(ownRole(level.desc), (role) => role.base)
		case "fragment":
			return Result.err(
				malformed(label, "a query over a schema or a role, whose records a level lists")
			)
	}
}

/** One column of a query's heading as its records hold it: a stored field, or a head literal's value. */
type HeadColumn =
	| { readonly kind: "stored"; readonly name: string; readonly field: FieldBase }
	| { readonly kind: "literal"; readonly name: string; readonly value: unknown }

/**
 * A column of the query's heading as its records hold it (see the header): a head literal's value, its carrier's one
 * constant, whatever the builder typed it as (a JavaScript value's head is typed by its position alone), or the stored
 * field of the column's declared type over the column itself.
 */
const headColumn = (
	name: string,
	typing: HeadingTyping,
	carrier: Carrier | undefined,
	owned: Owned,
	env: ScalarEnv,
	label: string
): HeadColumn => {
	const at = `${label} field ${name}`
	if (carrier?.column.kind === "constant") {
		const { values, conversion } = carrier.column
		const [value, ...others] = values
		return others.length === 0
			? { kind: "literal", name, value }
			: { kind: "stored", name, field: literalsField(values, conversion, carrier, env, at) }
	}
	if (typing.kind === "untyped") {
		throw malformed(at, "a column the builder typed: records of a query over typed sources")
	}
	const { scalar } = typing
	const column = typing.carrier.column
	const desc = fieldDescOf(scalar, owned.contracts)
	if (!desc.ok) {
		throw unsupported(
			SourceLoc(at, []),
			`a stored field of the contract ${desc.error.contract}, which the schema declares`
		)
	}
	return {
		kind: "stored",
		name,
		field: defineField({}, typing.carrier.sql, desc.value, { column }, builderLoc(at, []), env)
	}
}

/** The columns of a query's or an attachment child's heading as its records hold them (headColumn). */
const columnsOf = (state: QueryState, owned: Owned, label: string): ReadonlyArray<HeadColumn> => {
	const carriers = headingOf(state.carriers)
	return [...headingTypings(state)].map(([column, typing]) =>
		headColumn(
			column,
			typing,
			Object.hasOwn(carriers, column) ? carriers[column] : undefined,
			owned,
			state.schema.env,
			label
		)
	)
}

/** The stored columns among a heading's, each under its name. */
const storedOf = (
	columns: ReadonlyArray<HeadColumn>
): ReadonlyArray<readonly [string, FieldBase]> =>
	columns.flatMap((c) => (c.kind === "stored" ? [[c.name, c.field] as const] : []))

/** The head literals among a heading's, each value under its name. */
const literalsOf = (
	columns: ReadonlyArray<HeadColumn>
): ReadonlyArray<readonly [string, unknown]> =>
	columns.flatMap((c) => (c.kind === "literal" ? [[c.name, c.value] as const] : []))

/** A natural, the type a family draws its counts and places in. */
const drawnNatural = (): FieldBase => drawnField(naturalDescriptor, [])

/** The drawn count of each array attachment, under the attachment's name: the field its ordered family counts. */
const countsOf = (
	attached: ReadonlyArray<AttachedChild>
): ReadonlyArray<readonly [string, FieldBase]> =>
	attached.flatMap((a) => (a.delivery === "array" ? [[a.name, drawnNatural()] as const] : []))

/** A name with its first character upper case, as TypeScript's Capitalize spells it. */
const capitalized = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`

/** Each attachment's capitalized name, at any depth, in the order attached. */
const capitalizedNames = (attached: ReadonlyArray<AttachedChild>): ReadonlyArray<string> =>
	attached.flatMap((a) => [capitalized(a.name), ...capitalizedNames(a.child.attached)])

/** The first of `base`, `${base}2`, `${base}3`, … that `taken` does not hold (types/schema/records.ts Fresh). */
const fresh = (base: string, taken: ReadonlySet<string>): string => {
	if (!taken.has(base)) {
		return base
	}
	for (let n = 2; ; n += 1) {
		const name = `${base}${n}`
		if (!taken.has(name)) {
			return name
		}
	}
}

/** How an attachment's relation holds its child's records, by its stated delivery, an array at its place. */
const holdingOf = (delivery: AttachmentDelivery, place: () => string): Holding => {
	if (typeof delivery !== "string") {
		return { kind: "arm", field: delivery.field, handle: delivery.handle }
	}
	switch (delivery) {
		case "array":
			return { kind: "array", place: place() }
		case "option":
			return { kind: "option" }
		case "one":
			return { kind: "one" }
	}
}

/** What the relations of a tree of attachments come to: each relation and law, in the order built. */
interface Built {
	readonly relations: Array<RecordsRelation>
	readonly laws: Array<Statement>
	readonly apart: Array<RecordsRelation>
}

/** What building the attachments' relations reads: the stem, how often each capitalized name occurs, the level. */
interface Building {
	readonly stem: string
	readonly occurrences: ReadonlyMap<string, number>
	readonly owned: Owned
	readonly level: Level
	readonly label: string
}

/**
 * The roster of the closed id field `field` of a holder's stored columns, by name in the query's level: the roster an
 * arm's alternatives law reads.
 */
const rosterOf = (holder: Parent, field: string, building: Building): unknown => {
	const label = `${building.label} arm over ${field}`
	const column = holder.relation.fields[field]?.column
	if (column?.kind !== "code") {
		throw malformed(
			label,
			`an arm whose field is a stored closed id of its parent; ${field} is not one`
		)
	}
	const relations: Readonly<Record<string, unknown>> =
		building.level.kind === "role"
			? building.level.value.base.relations
			: building.level.value.relations
	const roster = relations[column.roster]
	if (roster === undefined) {
		throw malformed(label, `the roster ${column.roster} among the query's level's relations`)
	}
	return roster
}

/**
 * The relations and laws of the attachments `attached` under the holder `parent`, at any depth, into `built`: each
 * attachment's relation (see the header), its law over its parent, and the arms of one discriminator field one
 * alternatives law; its records as a holder, in the order attached.
 */
const attachmentsUnder = (
	parent: Parent,
	attached: ReadonlyArray<AttachedChild>,
	building: Building,
	built: Built
): ReadonlyArray<AttachmentRecords> => {
	const records = attached.map((a) => attachmentRecords(parent, a, building, built))
	const arms = new Map<string, Map<string, RecordsRelation>>()
	for (const a of records) {
		if (a.holding.kind !== "arm") {
			continue
		}
		const byHandle = arms.get(a.holding.field) ?? new Map<string, RecordsRelation>()
		if (byHandle.has(a.holding.handle)) {
			throw malformed(
				`${building.label} attachment ${a.name}`,
				`one arm attachment per handle of a field; ${a.holding.field} holds ${a.holding.handle} twice`
			)
		}
		byHandle.set(a.holding.handle, a.holder.relation)
		arms.set(a.holding.field, byHandle)
	}
	for (const [field, byHandle] of arms) {
		built.laws.push(
			alternativesBuilder(
				parent.relation,
				field,
				rosterOf(parent, field, building),
				Object.fromEntries(byHandle)
			)
		)
	}
	return records
}

/** One attachment's records under `parent` (see the header), its relation and law into `built`, then those under it. */
const attachmentRecords = (
	parent: Parent,
	a: AttachedChild,
	building: Building,
	built: Built
): AttachmentRecords => {
	const label = `${building.label} attachment ${a.name}`
	const columns = columnsOf(a.child, building.owned, label)
	const taken = new Set<string>([
		...columns.map((c) => c.name),
		...a.child.attached.map((c) => c.name)
	])
	const carried = parent.key.map((k): readonly [string, FieldBase] => {
		const name = fresh(k.name, taken)
		taken.add(name)
		return [name, k.carried]
	})
	const holding = holdingOf(a.delivery, () => fresh("at", taken))
	const place: ReadonlyArray<readonly [string, FieldBase]> =
		holding.kind === "array" ? [[holding.place, drawnNatural()]] : []
	const occurs = building.occurrences.get(capitalized(a.name)) ?? 0
	const name = `${occurs > 1 ? parent.relation.name : building.stem}${capitalized(a.name)}`
	const fields = [...carried, ...place, ...storedOf(columns), ...countsOf(a.child.attached)]
	const keyNames = [...carried, ...place].map(([field]) => field)
	const relation = relationBuilder(name, recordFields<RecordOwner>(fields), keyNames, [])
	built.relations.push(relation)
	const carriedNames = carried.map(([field]) => field)
	const parentKey = parent.key.map((k) => k.name)
	switch (holding.kind) {
		case "array":
			built.laws.push(
				orderedBuilder(onBuilder(relation, keyNames), finBuilder(parent.relation, a.name))
			)
			break
		case "option":
			built.apart.push(relation)
			built.laws.push(
				containedBuilder(onBuilder(relation, carriedNames), onBuilder(parent.relation, parentKey))
			)
			break
		case "one":
			built.apart.push(relation)
			built.laws.push(
				mirrorsBuilder(onBuilder(relation, carriedNames), onBuilder(parent.relation, parentKey))
			)
			break
		case "arm":
			built.apart.push(relation)
			break
	}
	const key: ReadonlyArray<KeyField> = [
		...carried.map(([field, type]) => ({ name: field, carried: type })),
		...(holding.kind === "array" ? [{ name: holding.place, carried: naturalDescriptor }] : [])
	]
	return {
		name: a.name,
		holding,
		carries: carried.map(
			([field], i) => [field, defined(parentKey[i], "a carried key field")] as const
		),
		holder: {
			relation,
			key,
			columns: storedOf(columns).map(([column]) => column),
			literals: literalsOf(columns),
			attachments: attachmentsUnder({ relation, key }, a.child.attached, building, built)
		}
	}
}

/** What records(...) admits: the stem, the query's state and columns, and the owner's fields and key. */
interface Admitted {
	readonly stem: string
	readonly state: QueryState
	readonly columns: ReadonlyArray<HeadColumn>
	readonly owner: RecordOwner
	readonly key: ReadonlyArray<string>
	readonly owned: Owned
	readonly label: string
}

/** The owner's descriptor of its key field `field`, which admission found among its fields. */
const ownerField = (owner: RecordOwner, field: string): FieldBase =>
	defined(owner[field], "an owner key field among the owner's fields")

/**
 * The admission core of records(...): the stem a name, the query one the builder made over typed sources, of one
 * heading, the owner a record of descriptors named apart from the query's columns and attachments, and its key a
 * nonempty list of the owner's names. Each relation's builder admits its name, fields and key as relation's does
 * (schema/relation.ts relationBuilder).
 */
const admitRecords = (
	stem: unknown,
	query: RecordedQuery,
	owner: unknown,
	ownerKey: unknown,
	extra: ReadonlyArray<unknown>
): Admitted => {
	const label = `records ${typeof stem === "string" ? stem : "?"}`
	const name = requireName(stem, label, "a stem, the name its relations' names start with")
	if (extra.length > 0) {
		throw malformed(label, "records(stem, query, owner, ownerKey): four arguments")
	}
	const state = queryState(query)
	if (state === undefined) {
		throw malformed(label, "a query the builder made")
	}
	if (headingsOf(query.rows).length !== 1) {
		throw unsupported(
			SourceLoc(label, []),
			"records of a query of one heading; a union's heading groups are a later cut"
		)
	}
	if (!isRecord(owner) || isList(owner)) {
		throw malformed(label, "an owner: a record of field descriptors")
	}
	if (!isList(ownerKey) || ownerKey.length === 0) {
		throw malformed(label, "an owner key: a nonempty list of the owner's field names")
	}
	const key = ownerKey.map((k) => {
		if (typeof k !== "string" || !Object.hasOwn(owner, k)) {
			throw malformed(
				label,
				`an owner key of the owner's field names; ${JSON.stringify(k)} is not one`
			)
		}
		return k
	})
	const owned = orThrow(ownedOf(state.schema.over, label))
	const columns = columnsOf(state, owned, label)
	for (const n of [...columns.map((c) => c.name), ...state.attached.map((a) => a.name)]) {
		if (Object.hasOwn(owner, n)) {
			throw malformed(
				label,
				`owner fields named apart from the query's columns and attachments; ${n} is both`
			)
		}
	}
	return {
		stem: name,
		state,
		columns,
		owner: recordFields<RecordOwner>(Object.entries(owner)),
		key,
		owned,
		label
	}
}

/**
 * records(stem, query, owner, ownerKey), the public schema barrel's (see the header): the records of `query`, its
 * decoders the query's own, at the types its caller's construction states (types/schema/records.ts).
 */
export const recordsBuilder = <
	Stem extends string,
	Q extends RecordedQuery,
	Owner extends RecordOwner,
	Key extends ReadonlyArray<keyof Owner & string>
>(
	stem: Stem,
	query: Q,
	owner: Owner,
	ownerKey: Key,
	extra: ReadonlyArray<unknown>
): Records<
	Stem,
	HeadOf<Q>,
	ImmediateHeadOf<Q>,
	RecordFields<Owner, Q>,
	Owner,
	Key,
	RecordChildren<Stem, Owner, Key, Q>,
	RecordLaws<Stem, Owner, Key, Q>,
	RecordApart<Stem, Owner, Key, Q>
> => {
	const admitted = admitRecords(stem, query, owner, ownerKey, extra)
	const { state } = admitted
	const row = relationBuilder(
		`${stem}Row`,
		recordFields<RecordOwner>([
			...Object.entries(admitted.owner),
			...storedOf(admitted.columns),
			...countsOf(state.attached)
		]),
		ownerKey,
		[]
	)
	const rootKey: ReadonlyArray<KeyField> = admitted.key.map((k) => ({
		name: k,
		carried: ownerField(admitted.owner, k)
	}))
	const occurrences = new Map<string, number>()
	for (const n of ["Row", ...capitalizedNames(state.attached)]) {
		occurrences.set(n, (occurrences.get(n) ?? 0) + 1)
	}
	const built: Built = { relations: [], laws: [], apart: [] }
	const attachments = attachmentsUnder(
		{ relation: row, key: rootKey },
		state.attached,
		{
			stem: admitted.stem,
			occurrences,
			owned: admitted.owned,
			level: state.schema.over,
			label: admitted.label
		},
		built
	)
	const value = recordsValue<
		Records<
			Stem,
			HeadOf<Q>,
			ImmediateHeadOf<Q>,
			RecordFields<Owner, Q>,
			Owner,
			Key,
			RecordChildren<Stem, Owner, Key, Q>,
			RecordLaws<Stem, Owner, Key, Q>,
			RecordApart<Stem, Owner, Key, Q>
		>
	>([
		["kind", "records"],
		["stem", stem],
		["row", row],
		["relations", Object.freeze([row, ...built.relations])],
		["rules", Object.freeze([...built.laws])],
		["apart", Object.freeze([...built.apart])],
		["owner", owner],
		["ownerKey", ownerKey],
		["rows", decoderOf<HeadOf<Q>>(query.rows.form)],
		["immediate", decoderOf<ImmediateHeadOf<Q>>(query.immediate.form)]
	])
	states.set(value, {
		root: {
			relation: row,
			key: rootKey,
			columns: storedOf(admitted.columns).map(([column]) => column),
			literals: literalsOf(admitted.columns),
			attachments
		},
		owner: Object.keys(admitted.owner),
		ownerFields: admitted.owner,
		apart: built.apart
	})
	return value
}

/** The state of a records value records(...) made; any other value is refused. */
const stateOf = (records: unknown, label: string): RecordsState => {
	const state = isRecord(records) ? states.get(records) : undefined
	if (state === undefined) {
		throw malformed(label, "records that records(...) made")
	}
	return state
}

/** The delivery an attachment's read states: the query's own, an array's, an option's, the one child's or the arm's. */
const deliveryOf = (holding: Holding): AttachmentDelivery => {
	switch (holding.kind) {
		case "array":
		case "option":
		case "one":
			return holding.kind
		case "arm":
			return arm(holding.field, holding.handle)
	}
}

/**
 * The read of a holder's attachments over `parent`, its query (see the header): each attached as the query states its
 * delivery, its child one rule over its relation keyed by the parent's delivered key, finding its own key, its stored
 * columns and its head literals, with its own attachments, and an array ordered by its place. An array's members
 * match their carried key by variables of their own, each held to the parent's by an equality, so they deliver their
 * whole key from their own relation, which their children's laws read it as; an option, the one child and an arm
 * match theirs at the parent's variables themselves, the binding their delivery's proof reads (an alternatives arm keyed
 * by the parent, a containment of the parent's key into the child's).
 */
const attachedReads = (parent: QueryValue, holder: Holder, level: unknown): QueryValue =>
	holder.attachments.reduce(
		(q, a) =>
			q.attach(
				a.name,
				(p: Readonly<Record<string, unknown>>) => childRead(a, p, level),
				deliveryOf(a.holding)
			),
		parent
	)

/** `rule` filtered by each of `predicates`, one where at a time, so a list of any length is no spread argument. */
const whereEach = (rule: RuleValue, predicates: ReadonlyArray<unknown>): RuleValue =>
	predicates.reduce<RuleValue>((filtered, predicate) => filtered.where(predicate), rule)

/** The read of one attachment's records, its parent variables `p` (attachedReads). */
const childRead = (
	a: AttachmentRecords,
	p: Readonly<Record<string, unknown>>,
	level: unknown
): QueryValue | OrderedValue => {
	const { holder } = a
	const rule = queryOver(level).rule((r: RuleValue) => {
		const vars = varsOver(holder.relation, "row")
		const found = [...holder.key.slice(a.carries.length).map((k) => k.name), ...holder.columns].map(
			(c) => [c, vars[c]] as const
		)
		if (a.holding.kind === "array") {
			const carried = a.carries.map(([field]) => [field, vars[field]] as const)
			return whereEach(
				r.match(holder.relation, Object.fromEntries([...carried, ...found])),
				a.carries.map(([field, from]) => r.eq(vars[field], p[from]))
			).find(Object.fromEntries([...carried, ...found, ...holder.literals]))
		}
		const carried = a.carries.map(([field, from]) => [field, p[from]] as const)
		return r
			.match(holder.relation, Object.fromEntries([...carried, ...found]))
			.find(Object.fromEntries([...carried, ...found, ...holder.literals]))
	})
	const attached = attachedReads(rule, holder, level)
	return a.holding.kind === "array" ? attached.orderBy([a.holding.place, "asc"]) : attached
}

/**
 * recordsQuery(level, records), the public schema barrel's (see the header): one rule over the root, each owner key
 * field its variable held to the parameter of its name, finding the key, the columns and the head literals, its
 * attachments attached (attachedReads), delivered through the records' decoders, the query's own.
 */
export const recordsQueryOver = <L, R extends AnyRecords>(
	level: L,
	records: R,
	extra: ReadonlyArray<unknown>
): RecordsQuery<L, R> => {
	const label = "recordsQuery"
	if (extra.length > 0) {
		throw malformed(label, "recordsQuery(level, records): two arguments")
	}
	const state = stateOf(records, label)
	const { root } = state
	const built = queryOver(level).rule((r: RuleValue) => {
		const vars = varsOver(root.relation, "row")
		const keyNames = root.key.map((k) => k.name)
		const found = [...keyNames, ...root.columns].map((c) => [c, vars[c]] as const)
		return whereEach(
			r.match(root.relation, Object.fromEntries(found)),
			keyNames.map((k) => r.eq(vars[k], r.param(k, ownerField(state.ownerFields, k))))
		).find(Object.fromEntries([...found, ...root.literals]))
	})
	return decodedBy<
		L,
		HeadOf<R>,
		Evidence.Unknown,
		OwnerParams<R>,
		ImmediateHeadOf<R>,
		never,
		readonly [ArmOf<HeadOf<R>, Carriers>]
	>(attachedReads(built, root, level), {
		rows: decoderOf<HeadOf<R>>(records.rows.form),
		immediate: decoderOf<ImmediateHeadOf<R>>(records.immediate.form)
	})
}

/** An Option a decoded row holds, read by its tag: its value, or none. */
const optionValue = (
	value: unknown,
	label: string
): { readonly some: boolean; readonly value: unknown } => {
	if (isRecord(value) && value["_tag"] === "Some") {
		return { some: true, value: value["value"] }
	}
	if (isRecord(value) && value["_tag"] === "None") {
		return { some: false, value: undefined }
	}
	throw malformed(label, "an Option of the attachment's records")
}

/** A found row of a holder, refused where it is no record. */
const rowRecord = (row: unknown, label: string): Readonly<Record<string, unknown>> => {
	if (!isRecord(row)) {
		throw malformed(label, "found rows of the records' query")
	}
	return row
}

/** The facts of a holder's attachments for one of its rows, its key's values `key`: nested at counts, and apart. */
interface AttachmentFacts {
	readonly nested: ReadonlyArray<readonly [string, ReadonlyArray<RecordsFact>]>
	readonly apart: ReadonlyArray<readonly [string, RecordsFact]>
}

/**
 * The facts of the holder's attachments for its row `row`, whose key's values are `key` (see the header): an array's
 * members nested at its count, each its stored columns and its own arrays, its place its index; every other child's
 * facts apart under its relation's name, its carried key's values then its own.
 */
const attachmentFacts = (
	holder: Holder,
	key: ReadonlyArray<unknown>,
	row: Readonly<Record<string, unknown>>,
	label: string
): AttachmentFacts => {
	const nested: Array<readonly [string, ReadonlyArray<RecordsFact>]> = []
	const apart: Array<readonly [string, RecordsFact]> = []
	const stateApart = (a: AttachmentRecords, value: unknown): void => {
		const child = rowRecord(value, label)
		const below = attachmentFacts(a.holder, key, child, label)
		apart.push([
			a.holder.relation.name,
			{
				fields: [
					...a.holder.key.map((k, i) => [k.name, key[i]] as const),
					...a.holder.columns.map((c) => [c, child[c]] as const)
				],
				nested: below.nested
			}
		])
		for (const entry of below.apart) {
			apart.push(entry)
		}
	}
	for (const a of holder.attachments) {
		const value = row[a.name]
		switch (a.holding.kind) {
			case "array": {
				if (!isList(value)) {
					throw malformed(label, `an array of ${a.name}'s records`)
				}
				nested.push([
					a.name,
					value.map((member, i): RecordsFact => {
						const child = rowRecord(member, label)
						const below = attachmentFacts(a.holder, [...key, BigInt(i)], child, label)
						for (const entry of below.apart) {
							apart.push(entry)
						}
						return {
							fields: a.holder.columns.map((c) => [c, child[c]] as const),
							nested: below.nested
						}
					})
				])
				break
			}
			case "option":
			case "arm": {
				const option = optionValue(value, label)
				if (option.some) {
					stateApart(a, option.value)
				}
				break
			}
			case "one":
				stateApart(a, value)
				break
		}
	}
	return { nested, apart }
}

/**
 * recordsFacts(level, records), the public schema barrel's (see the header): for found rows, each beside its owner's
 * values, the insert of them all, under the root's name each row's fact, its owner's values then its stored columns
 * with each array's members nested, and under each apart relation's name its facts.
 */
export const recordsFactsOver = <L, R extends AnyRecords>(
	_level: L,
	records: R,
	extra: ReadonlyArray<unknown>
): ((entries: Iterable<readonly [OwnerFacts<R>, HeadOf<R>]>) => RecordsInsert<L, R>) => {
	const label = "recordsFacts"
	if (extra.length > 0) {
		throw malformed(label, "recordsFacts(level, records): two arguments")
	}
	const state = stateOf(records, label)
	const { root } = state
	return (entries) => {
		const apart = new Map<string, Array<RecordsFact>>(
			state.apart.map((relation) => [relation.name, []])
		)
		const facts = Array.from(entries, ([owner, delivered]): RecordsFact => {
			const values: Readonly<Record<string, unknown>> = owner
			const key = root.key.map((k) => values[k.name])
			const row = rowRecord(delivered, label)
			const below = attachmentFacts(root, key, row, label)
			for (const [name, fact] of below.apart) {
				apart.get(name)?.push(fact)
			}
			return {
				fields: [
					...state.owner.map((field) => [field, values[field]] as const),
					...root.columns.map((c) => [c, row[c]] as const)
				],
				nested: below.nested
			}
		})
		return recordsInsert<RecordsInsert<L, R>>([[root.relation.name, facts], ...apart])
	}
}
