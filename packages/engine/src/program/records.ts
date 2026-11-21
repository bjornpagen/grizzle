/**
 * A query's records: the relations that hold the rows a query found, each column the query's own field, and the query
 * that reads them back through the query's own decoder (records, recordsQuery and recordsFacts, the public schema
 * barrel's, typed by types/schema/records.ts).
 *
 * - records(stem, query, owner, ownerKey): the root relation `${stem}Row`, the owner's fields then one stored field per
 *   column of the query's heading, keyed by the owner's key. A column's field is its declared type's (analysis/derived
 *   declaredDescOf over the column's ScalarType, the one reading of a column's type as a declaration, a derived
 *   relation's among its readers), its column the query's own (core/decoder.ts Column), so a contract column is the
 *   schema's own declaration of the contract, brand and check, a closed id a closed id of its roster, resolved by name
 *   in the level that lists the records, and a refined text the text of its patterns. A head literal is stored
 *   nowhere: the read writes it again; head literals of several values at one key, a union's, are a column whose values
 *   are exactly them (literalsField). A query with an attachment, a union of several headings or a column of a type no
 *   stored field declares is refused, each naming what it lacks.
 * - recordsQuery(level, records): the rows stored at one value of the owner's key, each key field a parameter of its
 *   name, read by one rule over the root and delivered through the query's own decoders (query/build/query.ts
 *   decodedBy): the one decoder, whose form is the query's, so its rows are the query's under either reading.
 * - recordsFacts(level, records): the insert of one owner's found rows, under the root's name each row's fact, the
 *   owner's values then the row's stored columns, as ChangeSet.insertAll takes it.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { end, RegexBuilder, seq, start } from "@bjornpagen/grizzle-text/regex/ir"
import { printSource } from "@bjornpagen/grizzle-text/regex/print"
import { sourceFlags } from "@bjornpagen/grizzle-text/regex/source"
import { literal } from "@bjornpagen/grizzle-text/regex/words"
import { declaredDescOf } from "#compiler/analysis/derived/fields.ts"
import { type CellConversion, decoderOf } from "#compiler/core/decoder.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { isNumericValue, typeLabel } from "#compiler/ir/scalar.ts"
import { decodedBy, queryOver, v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { headingOf, queryState } from "#compiler/query/build/state.ts"
import { defineField, type ScalarEnv } from "#compiler/scalar/registry.ts"
import type { Level } from "#compiler/schema/level.ts"
import { type Owned, own, ownRole } from "#compiler/schema/own.ts"
import {
	builderLoc,
	type HeadingTyping,
	malformed,
	orThrow,
	queryHeadingOf,
	requireName
} from "#compiler/schema/protocol.ts"
import { recordFields, recordsInsert } from "#compiler/schema/record.ts"
import { describeDeclared, relationBuilder } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import type { Carrier, Carriers } from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { ArmOf, HeadOf, ImmediateHeadOf } from "#compiler/types/query/query.ts"
import type {
	AnyRecords,
	OwnerFacts,
	OwnerParams,
	RecordedQuery,
	RecordFields,
	RecordOwner,
	Records,
	RecordsInsert,
	RecordsQuery
} from "#compiler/types/schema/records.ts"
import type { Relation } from "#compiler/types/schema/relation.ts"

/**
 * What a records value holds beside its public members, read by its read and its facts: the root relation, the owner's
 * fields and key, its stored columns' names, and each head literal's value under its key.
 */
interface RecordsState {
	readonly row: Relation<string, RecordOwner, ReadonlyArray<string>>
	readonly owner: ReadonlyArray<string>
	readonly ownerFields: RecordOwner
	readonly ownerKey: ReadonlyArray<string>
	readonly columns: ReadonlyArray<string>
	readonly literals: ReadonlyArray<readonly [string, unknown]>
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
 * A column of the query's heading as its records hold it (see the header): a head literal's value, or the stored field
 * of the column's declared type over the column itself.
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
	if (carrier !== undefined && carrier.column.kind === "constant") {
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
	if (isNumericValue(scalar)) {
		throw unsupported(
			SourceLoc(at, []),
			`a stored field of the computed numeric ${typeLabel(scalar)}`
		)
	}
	const desc = declaredDescOf(scalar, owned.contracts)
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

/**
 * The stored field of head literals of several values at one key, a union's arms each writing its own (core/decoder.ts
 * unionColumn): a field whose values are exactly the literals, over the literals' column, so the read delivers the
 * stored literal's text and the query's decoder reads it as the literal it is. Text literals are a text of the pattern
 * of exactly them (`^(?:a|b)$`, printed from their alternation by grizzle's own grammar, text/regex print.ts
 * printSource); boolean literals, which are both values, are a boolean. A literal of any other type has no field whose
 * values are exactly the literals, so it is refused.
 */
const literalsField = (
	values: NonEmptyReadonlyArray<unknown>,
	conversion: CellConversion,
	carrier: Carrier,
	env: ScalarEnv,
	at: string
): FieldBase => {
	const loc = builderLoc(at, [])
	switch (conversion.carrier) {
		case "text": {
			const texts = values.map((value) => {
				if (typeof value !== "string") {
					throw defect("a text literal is a string")
				}
				return value
			})
			const source = printSource(
				seq([start, new RegexBuilder().alt(texts.map(literal)), end]),
				(set) => set
			)
			const { desc } = describeDeclared(regexField<string>(source, [sourceFlags]), loc)
			return defineField({}, carrier.sql, desc, { column: carrier.column }, loc, env)
		}
		case "bool":
			return defineField(
				{},
				carrier.sql,
				{ kind: "pg", type: "boolean" },
				{ column: carrier.column },
				loc,
				env
			)
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "uuid":
		case "date":
		case "tsvector":
		case "range4":
		case "range8":
		case "rangeDate":
		case "exactInteger":
		case "exactMoney":
		case "vector":
			throw unsupported(
				SourceLoc(at, []),
				`a stored field whose values are exactly the ${conversion.carrier} literals ${values.map(String).join(", ")}`
			)
	}
}

/** What records(...) admits: the root's name, fields and key, and the state its read and facts read. */
interface Admitted {
	readonly name: string
	readonly fields: ReadonlyArray<readonly [string, unknown]>
	readonly key: ReadonlyArray<string>
	readonly state: Omit<RecordsState, "row">
}

/**
 * The admission core of records(...): the stem a name, the query one the builder made over typed sources, of one
 * heading with no attachment (its decoder a record's), the owner a record of descriptors named apart from the query's
 * columns, and its key a nonempty list of the owner's names. The root relation's builder admits its name, fields and
 * key as relation's does (schema/relation.ts relationBuilder).
 */
const admitRecords = (
	stem: unknown,
	query: unknown,
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
	const heading = queryHeadingOf(query)
	if (
		state === undefined ||
		heading === undefined ||
		!isRecord(query) ||
		!isRecord(query["rows"])
	) {
		throw malformed(label, "a query the builder made")
	}
	if (state.heading.attached.size > 0) {
		throw unsupported(
			SourceLoc(label, []),
			"records of a query with no attachment; its attachments' relations are a later cut"
		)
	}
	const form = query["rows"]["form"]
	if (!isRecord(form) || form["kind"] !== "record") {
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
	const carriers: Readonly<Record<string, Carrier | undefined>> = headingOf(state.carriers)
	const columns = [...heading].map(([column, typing]) =>
		headColumn(column, typing, carriers[column], owned, state.schema.env, label)
	)
	for (const c of columns) {
		if (Object.hasOwn(owner, c.name)) {
			throw malformed(label, `owner fields named apart from the query's columns; ${c.name} is both`)
		}
	}
	const ownerEntries = Object.entries(owner)
	const stored = columns.flatMap((c) => (c.kind === "stored" ? [[c.name, c.field] as const] : []))
	return {
		name: `${name}Row`,
		fields: [...ownerEntries, ...stored],
		key,
		state: {
			owner: ownerEntries.map(([field]) => field),
			ownerFields: recordFields<RecordOwner>(ownerEntries),
			ownerKey: key,
			columns: stored.map(([column]) => column),
			literals: columns.flatMap((c) => (c.kind === "literal" ? [[c.name, c.value] as const] : []))
		}
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
): Records<Stem, HeadOf<Q>, ImmediateHeadOf<Q>, RecordFields<Owner, Q>, Owner, Key> => {
	const admitted = admitRecords(stem, query, owner, ownerKey, extra)
	const row = relationBuilder<`${Stem}Row`, RecordFields<Owner, Q>, Key>(
		`${stem}Row`,
		recordFields<RecordFields<Owner, Q>>(admitted.fields),
		ownerKey,
		[]
	)
	const value: Records<
		Stem,
		HeadOf<Q>,
		ImmediateHeadOf<Q>,
		RecordFields<Owner, Q>,
		Owner,
		Key
	> = Object.freeze({
		kind: "records",
		stem,
		row,
		relations: Object.freeze([row] as const),
		rules: Object.freeze([] as const),
		owner,
		ownerKey,
		rows: decoderOf<HeadOf<Q>>(query.rows.form),
		immediate: decoderOf<ImmediateHeadOf<Q>>(query.immediate.form)
	})
	states.set(value, { ...admitted.state, row })
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

/**
 * recordsQuery(level, records), the public schema barrel's (see the header): one rule over the root, matching each
 * owner key field to the parameter of its name and each stored column to its variable, finding the columns and the
 * head literals, delivered through the records' decoders, the query's own.
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
	const built = queryOver(level).rule((r: RuleValue) => {
		const vars: Readonly<Record<string, unknown>> = v(state.row, "row")
		const bindings = Object.fromEntries([
			...state.ownerKey.map((k) => [k, r.param(k, state.ownerFields[k])] as const),
			...state.columns.map((c) => [c, vars[c]] as const)
		])
		const head = Object.fromEntries([
			...state.columns.map((c) => [c, vars[c]] as const),
			...state.literals
		])
		return r.match(state.row, bindings).find(head)
	})
	return decodedBy<
		L,
		HeadOf<R>,
		Evidence.Unknown,
		OwnerParams<R>,
		ImmediateHeadOf<R>,
		never,
		readonly [ArmOf<HeadOf<R>, Carriers>]
	>(built, {
		rows: decoderOf<HeadOf<R>>(records.rows.form),
		immediate: decoderOf<ImmediateHeadOf<R>>(records.immediate.form)
	})
}

/**
 * recordsFacts(level, records), the public schema barrel's (see the header): for found rows each under its owner's
 * values, the insert of them all, under the root's name each row's fact, its owner's values then its stored columns, a
 * head literal's left out; an owner of several rows is pairs that share it. A level that does not list the records is
 * refused, as an insert into it would be.
 */
export const recordsFactsOver = <L, R extends AnyRecords>(
	level: L,
	records: R,
	extra: ReadonlyArray<unknown>
): ((entries: Iterable<readonly [OwnerFacts<R>, HeadOf<R>]>) => RecordsInsert<L, R>) => {
	const label = "recordsFacts"
	if (extra.length > 0) {
		throw malformed(label, "recordsFacts(level, records): two arguments")
	}
	const state = stateOf(records, label)
	const relations = isRecord(level) ? level["relations"] : undefined
	if (!isRecord(relations) || relations[state.row.name] !== state.row) {
		throw malformed(
			label,
			`a level that lists the records, its relation ${state.row.name} among them`
		)
	}
	return (entries) =>
		recordsInsert<RecordsInsert<L, R>>(
			state.row.name,
			Array.from(entries, ([owner, row]) => {
				const values: Readonly<Record<string, unknown>> = owner
				if (!isRecord(row)) {
					throw malformed(label, "found rows of the records' query")
				}
				return [
					...state.owner.map((field) => [field, values[field]] as const),
					...state.columns.map((c) => [c, row[c]] as const)
				]
			})
		)
}
