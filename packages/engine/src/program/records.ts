/**
 * A query's records: the relations that hold the rows a query found, each column the query's own field, each
 * attachment, at any depth, a relation of its own, and the query that reads them back through the query's own decoder
 * (records, recordsQuery and recordsFacts, the public schema barrel's, typed by types/schema/records.ts).
 *
 * - records(stem, query, owner, ownerKey): the root relation `${stem}Row`, the owner's fields, then one stored field per
 *   column of the query's heading, then a drawn count under the name of each array attachment, keyed by the owner's
 *   key. A column's field is its type's (schema/field-desc.ts fieldDescOf over the column's ScalarType, the one reading of a
 *   column's type as a field's, a derived relation's among its readers), its column the query's own (core/decoder.ts
 *   Column), so a contract column is the schema's own declaration of the contract, brand and check, a variant column the
 *   schema's own declaration of the variant, its arms' checks with it, a closed id a closed
 *   id of its roster, resolved by name in the level that lists the records, a refined text the text of its patterns, a
 *   computed numeric numeric within its bound (pg.numeric.within), numeric of no typmod at numeric's own limits
 *   pg.numeric, an instant a stored instant (instant.stored), which the database draws nothing of, and a search
 *   document a stored one (pg.tsvector). A head literal is stored nowhere: the read writes it again; head literals of
 *   several values at one key, a union's, are a column whose values are exactly them (literalsField). A union of several
 *   headings or a column of a contract or a variant the schema does not declare is refused, each naming what it lacks.
 * - Each attachment's relation (types/schema/records.ts types each): the name its author states for the attachment's
 *   path in the options' `names` (its attachment names from the root joined by `.`), or `${stem}${Capitalize<name>}`,
 *   or its parent's name followed by `Capitalize<name>` where that name is another attachment's or the root's `Row`, so
 *   a parent's stated name leads its children's. A stated name is declared (ir/desc.ts RelationNaming `declared`), its
 *   table and whole view its conversion, refused past PostgreSQL's identifier (IdentifierTooLong) as every declared
 *   name is. A name records derive, the root's among them, is derived at its path (RelationNaming `derived`,
 *   ir/desc.ts derivedNaming): the schema type's key at any length, never cut short, its table and whole view hashed
 *   over the name and spelled after the stem and the path (core/identity.ts identity.derivedTable,
 *   identity.derivedWholeView), so every records compile whatever their depth.
 *   Its fields its parent's key carried, each name fresh beside its own columns and attachments, its place `at` for an
 *   array, its stored columns and its arrays' counts; keyed by the carried key, then its place. Its law over its
 *   parent: an array is the parent's ordered family counted at its name, so an insert nests its members in order and
 *   its places are 0 … n − 1 by grizzle's family laws; an option is contained in its parent, keyed by its parent's key
 *   alone; one mirrors its parent.
 * - recordPaths(query): the path of each attachment, at any depth, as `names` keys it (recordPathsOf), the run time's
 *   reading of RecordPaths<Q>.
 * - recordsQuery(level, records): the rows stored at one value of the owner's key, each key field a parameter of its
 *   name, read by one rule over the root, each attachment attached as the query states its delivery, over its relation
 *   keyed by its parent's delivered key and an array ordered by its place, and delivered through the query's own
 *   decoders (query/build/query.ts decodedBy): the one decoder, whose form is the query's, so its rows are the query's
 *   under either reading.
 * - recordsFacts(level, records): the insert of found rows, each beside its owner's values, as insertAll takes it:
 *   under the root's name each row's fact, its owner's values then its stored columns, each array's members nested at
 *   its count with theirs; under each other attachment's relation its facts, its carried key's values then its own.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	type DecoderForm,
	type Delivery,
	decoderOf,
	formFields,
	headingsOf
} from "#compiler/core/decoder.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { parseDerivedName, type HeldName } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { declaredNaming, derivedNaming } from "#compiler/ir/desc.ts"
import type { Roster } from "#compiler/ir/scalar.ts"
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
import { type RecordsHolder, type RecordsLayout, recordsFacts } from "#compiler/runtime/records.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { defineField, type ScalarEnv } from "#compiler/scalar/registry.ts"
import { type Declarations, fieldDescOf } from "#compiler/schema/field-desc.ts"
import type { Level } from "#compiler/schema/level.ts"
import type { SchemaContent } from "#compiler/schema/levels.ts"
import { literalsField } from "#compiler/schema/literals.ts"
import {
	builderLoc,
	builderRefusal,
	type HeadingTyping,
	malformed,
	orThrow,
	requireDeclaredName,
	requireName
} from "#compiler/schema/protocol.ts"
import { recordFields, recordsValue } from "#compiler/schema/record.ts"
import { drawnField, namedRelationBuilder } from "#compiler/schema/relation.ts"
import {
	containedBuilder,
	finBuilder,
	mirrorsBuilder,
	onBuilder,
	orderedBuilder
} from "#compiler/schema/statements.ts"
import type { ServedRecords } from "#compiler/served/forms.ts"
import type { Carrier, Carriers } from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { ArmOf, HeadOf, ImmediateHeadOf } from "#compiler/types/query/query.ts"
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

/** How an attachment's relation holds its child's records: as an array at its place, an option or the one child. */
type Holding =
	| { readonly kind: "array"; readonly place: string }
	| { readonly kind: "option" }
	| { readonly kind: "one" }

/**
 * A relation that holds records, as the attachments under it read it: the relation, its key in order, and its path, the
 * attachment names from the root to it, none for the root.
 */
interface Parent {
	readonly relation: RecordsRelation
	readonly key: ReadonlyArray<KeyField>
	readonly path: ReadonlyArray<string>
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
	/** The records' stem, which names its served form (served/forms.ts ServedFile records). */
	readonly stem: string
	/** Its query's rows' decoder form, and the schema's roster of each name a code or set column of it names. */
	readonly form: DecoderForm
	readonly roster: (name: HeldName) => Roster | undefined
}

/** Each records value's state, by the value: a WeakMap, so it holds nothing alive and is never enumerated. */
const states = new WeakMap<object, RecordsState>()

/**
 * Each records' state by its root relation's value, which a level lists among its relations: how generate finds the
 * records a login's base lists (servedRecordsOf). A WeakMap, so it holds nothing alive.
 */
const rooted = new WeakMap<object, RecordsState>()

/**
 * The contracts and the variants a query's level declares, by name, which its contract and variant columns are declared
 * by: those its content holds from its build (levels.ts SchemaContent contracts and variants), a role's its base's. Read
 * off the content, so records own no level: ownership is the compile's, which refuses two declarations of a contract or
 * of a variant that differ.
 */
const declarationsOf = (level: Level, label: string): Result.Result<Declarations, CompileError> => {
	switch (level.kind) {
		case "schema":
			return Result.ok(contentDeclarations(level.content))
		case "role":
			return Result.ok(contentDeclarations(level.base))
		case "fragment":
			return Result.err(
				malformed(label, "a query over a schema or a role, whose records a level lists")
			)
	}
}

/** The contracts and the variants a level's content declares (levels.ts SchemaContent), by name. */
const contentDeclarations = (content: SchemaContent): Declarations => ({
	contract: (name) => content.contracts.get(name),
	variant: (name) => content.variants.get(name)
})

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
	declared: Declarations,
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
	const desc = fieldDescOf(scalar, declared)
	if (!desc.ok) {
		throw unsupported(
			SourceLoc(at, []),
			`a stored field of the ${desc.error.kind} ${desc.error.name}, which the schema declares`
		)
	}
	return {
		kind: "stored",
		name,
		field: defineField({}, typing.carrier.sql, desc.value, { column }, builderLoc(at, []), env)
	}
}

/** The columns of a query's or an attachment child's heading as its records hold them (headColumn). */
const columnsOf = (
	state: QueryState,
	declared: Declarations,
	label: string
): ReadonlyArray<HeadColumn> => {
	const carriers = headingOf(state.carriers)
	return [...headingTypings(state)].map(([column, typing]) =>
		headColumn(
			column,
			typing,
			Object.hasOwn(carriers, column) ? carriers[column] : undefined,
			declared,
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

/** The path of each attachment of `attached` under `path`, at any depth: its names from the root, joined by `.`. */
const attachmentPaths = (
	attached: ReadonlyArray<AttachedChild>,
	path: ReadonlyArray<string>
): ReadonlyArray<string> =>
	attached.flatMap((a) => {
		const at = [...path, a.name]
		return [at.join("."), ...attachmentPaths(a.child.attached, at)]
	})

/**
 * recordPaths(query), the public schema barrel's: the path of each of the query's attachments at any depth, its
 * attachment names from the root joined by `.`, each in the order attached and before those under it. It is the run
 * time's reading of RecordPaths<Q> (types/schema/records.ts), from the tree records' names are admitted by
 * (admitNames), so a generator that names every attachment's relation itself (den's lowering, whose names are its own
 * fixed form) states a name for each path and leaves records to derive none.
 */
export const recordPathsOf = (query: RecordedQuery): ReadonlyArray<string> => {
	const state = queryState(query)
	if (state === undefined) {
		throw malformed("recordPaths", "a query the builder made")
	}
	return attachmentPaths(state.attached, [])
}

/**
 * The relation names records' options state, by path (see the header): none where the options are left out, their
 * documented default; otherwise `{ names }`, each key the path of one of the query's attachments, each value a
 * relation's declared name, refused where PostgreSQL would cut it short (IdentifierTooLong) as every relation's is.
 */
const admitNames = (
	options: ReadonlyArray<unknown>,
	attached: ReadonlyArray<AttachedChild>,
	label: string
): ReadonlyMap<string, string> => {
	if (options.length > 1) {
		throw malformed(label, "records(stem, query, owner, ownerKey, options): five arguments at most")
	}
	if (options.length === 0) {
		return new Map()
	}
	const [given] = options
	const names =
		isRecord(given) && !isList(given) && Object.keys(given).length === 1
			? given["names"]
			: undefined
	if (!isRecord(names) || isList(names)) {
		throw malformed(
			label,
			"records' options: { names }, the relation names stated for the query's attachments, each by its path"
		)
	}
	const paths = new Set(attachmentPaths(attached, []))
	return new Map(
		Object.entries(names).map(([path, name]) => {
			if (!paths.has(path)) {
				throw builderRefusal(
					label,
					"records' names name only the query's attachments, each by its path"
				)
			}
			return [path, requireDeclaredName(name, label, "relation")] as const
		})
	)
}

/** How an attachment's relation holds its child's records, by its stated delivery, an array at its place. */
const holdingOf = (delivery: Delivery, place: () => string): Holding => {
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

/**
 * What building the attachments' relations reads: the stem, how often each capitalized name occurs, the names stated
 * by path, the level.
 */
interface Building {
	readonly stem: string
	readonly occurrences: ReadonlyMap<string, number>
	readonly names: ReadonlyMap<string, string>
	readonly declared: Declarations
	readonly level: Level
	readonly label: string
}

/**
 * The relations and laws of the attachments `attached` under the holder `parent`, at any depth, into `built`: each
 * attachment's relation (see the header) and its law over its parent; its records as a holder, in the order attached.
 */
const attachmentsUnder = (
	parent: Parent,
	attached: ReadonlyArray<AttachedChild>,
	building: Building,
	built: Built
): ReadonlyArray<AttachmentRecords> => {
	return attached.map((a) => attachmentRecords(parent, a, building, built))
}

/** One attachment's records under `parent` (see the header), its relation and law into `built`, then those under it. */
const attachmentRecords = (
	parent: Parent,
	a: AttachedChild,
	building: Building,
	built: Built
): AttachmentRecords => {
	const label = `${building.label} attachment ${a.name}`
	const columns = columnsOf(a.child, building.declared, label)
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
	const path = [...parent.path, a.name]
	const stated = building.names.get(path.join("."))
	const [name, naming] =
		stated === undefined
			? [
					`${occurs > 1 ? parent.relation.name : building.stem}${capitalized(a.name)}`,
					derivedNaming(building.stem, path)
				]
			: [stated, declaredNaming]
	const fields = [...carried, ...place, ...storedOf(columns), ...countsOf(a.child.attached)]
	const keyNames = [...carried, ...place].map(([field]) => field)
	const relation = namedRelationBuilder(
		name,
		naming,
		recordFields<RecordOwner>(fields),
		keyNames,
		[]
	)
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
			path,
			columns: storedOf(columns).map(([column]) => column),
			literals: literalsOf(columns),
			attachments: attachmentsUnder({ relation, key, path }, a.child.attached, building, built)
		}
	}
}

/**
 * What records(...) admits: the stem, the query's state and columns, the owner's fields and key, and the names its
 * options state by path.
 */
interface Admitted {
	readonly stem: string
	readonly state: QueryState
	readonly columns: ReadonlyArray<HeadColumn>
	readonly owner: RecordOwner
	readonly key: ReadonlyArray<string>
	readonly names: ReadonlyMap<string, string>
	readonly declared: Declarations
	readonly label: string
}

/** The owner's descriptor of its key field `field`, which admission found among its fields. */
const ownerField = (owner: RecordOwner, field: string): FieldBase =>
	defined(owner[field], "an owner key field among the owner's fields")

/**
 * The admission core of records(...): the stem a name, the query one the builder made over typed sources, of one
 * heading, the owner a record of descriptors named apart from the query's columns and attachments, its key a nonempty
 * list of the owner's names, and the options' stated names (admitNames). Each relation's builder admits its name,
 * fields and key as relation's does (schema/relation.ts relationBuilder).
 */
const admitRecords = (
	stem: unknown,
	query: RecordedQuery,
	owner: unknown,
	ownerKey: unknown,
	options: ReadonlyArray<unknown>
): Admitted => {
	const label = `records ${typeof stem === "string" ? stem : "?"}`
	const name = requireName(stem, label, "a stem, the name its relations' names start with")
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
	const declared = orThrow(declarationsOf(state.schema.over, label))
	const columns = columnsOf(state, declared, label)
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
		names: admitNames(options, state.attached, label),
		declared,
		label
	}
}

/**
 * records(stem, query, owner, ownerKey, options), the public schema barrel's (see the header): the records of `query`,
 * its decoders the query's own, at the types its caller's construction states (types/schema/records.ts).
 */
export const recordsBuilder = <
	Stem extends string,
	Q extends RecordedQuery,
	Owner extends RecordOwner,
	Key extends ReadonlyArray<keyof Owner & string>,
	Names
>(
	stem: Stem,
	query: Q,
	owner: Owner,
	ownerKey: Key,
	options: ReadonlyArray<unknown>
): Records<
	Stem,
	HeadOf<Q>,
	ImmediateHeadOf<Q>,
	RecordFields<Owner, Q>,
	Owner,
	Key,
	RecordChildren<Stem, Owner, Key, Q, Names>,
	RecordLaws<Stem, Owner, Key, Q, Names>,
	RecordApart<Stem, Owner, Key, Q, Names>
> => {
	const admitted = admitRecords(stem, query, owner, ownerKey, options)
	const { state } = admitted
	const row = namedRelationBuilder(
		`${admitted.stem}Row`,
		derivedNaming(admitted.stem, []),
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
		{ relation: row, key: rootKey, path: [] },
		state.attached,
		{
			stem: admitted.stem,
			occurrences,
			names: admitted.names,
			declared: admitted.declared,
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
			RecordChildren<Stem, Owner, Key, Q, Names>,
			RecordLaws<Stem, Owner, Key, Q, Names>,
			RecordApart<Stem, Owner, Key, Q, Names>
		>
	>([
		["kind", "records"],
		["name", stem],
		["row", row],
		["relations", Object.freeze([row, ...built.relations])],
		["rules", Object.freeze([...built.laws])],
		["apart", Object.freeze([...built.apart])],
		["owner", owner],
		["ownerKey", ownerKey],
		["rows", decoderOf<HeadOf<Q>>(query.rows.form)],
		["immediate", decoderOf<ImmediateHeadOf<Q>>(query.immediate.form)]
	])
	const root: Holder = {
		relation: row,
		key: rootKey,
		path: [],
		columns: storedOf(admitted.columns).map(([column]) => column),
		literals: literalsOf(admitted.columns),
		attachments
	}
	const recorded: RecordsState = {
		root,
		owner: Object.keys(admitted.owner),
		ownerFields: admitted.owner,
		apart: built.apart,
		stem: admitted.stem,
		form: query.rows.form,
		roster: (name) => state.schema.env.roster(name)
	}
	states.set(value, recorded)
	rooted.set(row, recorded)
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

/** The delivery an attachment's read states: an array's, an option's or the one child's. */
const deliveryOf = (holding: Holding): Delivery => {
	switch (holding.kind) {
		case "array":
		case "option":
		case "one":
			return holding.kind
	}
}

/**
 * The read of a holder's attachments over `parent`, its query (see the header): each attached as the query states its
 * delivery, its child one rule over its relation keyed by the parent's delivered key, finding its own key, its stored
 * columns and its head literals, with its own attachments, and an array ordered by its place. An array's members
 * match their carried key by variables of their own, each held to the parent's by an equality, so they deliver their
 * whole key from their own relation, which their children's laws read it as; an option and the one child match
 * theirs at the parent's variables themselves, the binding their delivery's proof reads (a containment of the parent's
 * key into the child's).
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
		const { match } = r
		const vars = varsOver(holder.relation, "row")
		const found = [...holder.key.slice(a.carries.length).map((k) => k.name), ...holder.columns].map(
			(c) => [c, vars[c]] as const
		)
		if (a.holding.kind === "array") {
			const carried = a.carries.map(([field]) => [field, vars[field]] as const)
			return whereEach(
				match(holder.relation, Object.fromEntries([...carried, ...found])),
				a.carries.map(([field, from]) => r.eq(vars[field], p[from]))
			).find(Object.fromEntries([...carried, ...found, ...holder.literals]))
		}
		const carried = a.carries.map(([field, from]) => [field, p[from]] as const)
		return match(holder.relation, Object.fromEntries([...carried, ...found])).find(
			Object.fromEntries([...carried, ...found, ...holder.literals])
		)
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
		const { match } = r
		const vars = varsOver(root.relation, "row")
		const keyNames = root.key.map((k) => k.name)
		const found = [...keyNames, ...root.columns].map((c) => [c, vars[c]] as const)
		return whereEach(
			match(root.relation, Object.fromEntries(found)),
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

/** A holder as its records' insert reads it (runtime/records.ts RecordsHolder): its relation's name, its key's field names, its stored columns and each attachment's, by its holding's kind. */
const holderLayout = (holder: Holder): RecordsHolder => ({
	relation: holder.relation.name,
	key: holder.key.map((k) => k.name),
	columns: holder.columns,
	attachments: holder.attachments.map((a) => ({
		name: a.name,
		holding: a.holding.kind,
		holder: holderLayout(a.holder)
	}))
})

/**
 * A records' layout (runtime/records.ts RecordsLayout), read off its state: what its insert is worked out from, by the
 * compile's recordsFacts and, carried in a served file (served/forms.ts ServedRecords), by a served login's recordedOf.
 */
const layoutOf = (state: RecordsState): RecordsLayout => ({
	owner: state.owner,
	root: holderLayout(state.root),
	apart: state.apart.map((relation) => relation.name)
})

/**
 * recordsFacts(level, records), the public schema barrel's (see the header): for found rows, each beside its owner's
 * values, the insert of them all, under the root's name each row's fact, its owner's values then its stored columns
 * with each array's members nested, and under each apart relation's name its facts (runtime/records.ts recordsFacts,
 * over the records' layout, as a served login's recordedOf works it out over the layout its file carries).
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
	return recordsFacts<RecordsInsert<L, R>>(layoutOf(stateOf(records, label)), (what) => {
		throw malformed(label, what)
	})
}

/** Each roster a code or set column of `form` names, at any depth of its attachments, into `names`. */
const formRosters = (form: DecoderForm, names: Set<string>): void => {
	for (const fields of formFields(form)) {
		for (const [, field] of fields) {
			switch (field.kind) {
				case "column":
					if (field.column.kind === "code" || field.column.kind === "bits") {
						names.add(field.column.roster)
					}
					break
				case "attachment":
					formRosters(field.child, names)
					break
			}
		}
	}
}

/** A records as a served file carries it (served/forms.ts ServedRecords): its form, the rosters it names, its layout. */
const servedRecords = (recorded: RecordsState): ServedRecords => {
	const names = new Set<string>()
	formRosters(recorded.form, names)
	return {
		form: recorded.form,
		rosters: new Map(
			[...names].toSorted(compareStrings).map((name) => {
				const parsed = parseDerivedName(name)
				const roster = parsed.ok ? recorded.roster(parsed.value) : undefined
				if (roster === undefined) {
					defect(`a column's roster ${name} is one its records' schema declares`)
				}
				return [name, { order: roster.order, handles: roster.handles }] as const
			})
		),
		layout: layoutOf(recorded)
	}
}

/**
 * The records a served file carries (served/forms.ts ServedFile records): each records whose root relation is among
 * `relations`, a login's base's relation values (its schema value's `relations`), and among `footprint`, the relations
 * the login's statements read and write, by its stem, in stem order.
 */
export const servedRecordsOf = (
	relations: Iterable<unknown>,
	footprint: ReadonlySet<string>
): ReadonlyMap<string, ServedRecords> => {
	const carried: Array<RecordsState> = []
	for (const relation of relations) {
		const recorded = isRecord(relation) ? rooted.get(relation) : undefined
		if (recorded !== undefined && footprint.has(recorded.root.relation.name)) {
			carried.push(recorded)
		}
	}
	return new Map(
		carried
			.toSorted((a, b) => compareStrings(a.stem, b.stem))
			.map((recorded) => [recorded.stem, servedRecords(recorded)] as const)
	)
}
