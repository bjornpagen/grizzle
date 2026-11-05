/**
 * A relation parameter's recordset encoding, a hot path: every execution that binds a relation parameter normalizes
 * and writes each of its facts here, so the per-fact work is native loops with no closure or Option per element.
 */
import { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
import { refinedMember, type ScalarCodec, scalarCodec } from "#compiler/codec/scalar.ts"
import { nominal } from "#compiler/core/brand.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type { EncodingFailure, EncodingPlace } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import type { IdentifiedFact, NormalFacts, RelationParamEncoder } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	admitFact,
	type HeadingField,
	type HeadingPlan,
	headingPlan
} from "#compiler/scalar/values/identity.ts"

interface RelationColumn {
	/** The fact field this column carries. */
	readonly field: string
	readonly type: ScalarType
	/**
	 * The recordset column name, the JSON key: a statement's own key for the column, or the generated name
	 * (positionalColumns).
	 */
	readonly wire: string
}

declare const distinctColumnsBrand: unique symbol

/**
 * A recordset's columns, each field and each wire name distinct: what every recordset codec is built over, so building
 * one refuses nothing. Minted where a heading's columns become recordset columns (positionalColumns, keyedColumns): a
 * heading's names are distinct, since the checker builds every heading from a record's keys or a relation's declared
 * fields (schema/record.ts), and each wire name is the column's position or the key its statement minted for it.
 */
export type DistinctColumns = ReadonlyArray<RelationColumn> & {
	readonly [distinctColumnsBrand]: true
}

const distinctColumns = nominal<ReadonlyArray<RelationColumn>, DistinctColumns>()

/** The generated wire names, c1, c2, ... in column order, for a producer with no statement key of its own. */
export const positionalColumns = (
	heading: ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>
): DistinctColumns =>
	distinctColumns(heading.map((c, i) => ({ field: c.name, type: c.type, wire: `c${i + 1}` })))

/**
 * A statement slot's columns under the JSON keys its lowering minted for them, one fresh name per column
 * (conservative/context.ts relationColumns).
 */
export const keyedColumns = (
	columns: ReadonlyArray<{ readonly name: string; readonly type: ScalarType; readonly key: string }>
): DistinctColumns =>
	distinctColumns(columns.map((c) => ({ field: c.name, type: c.type, wire: c.key })))

/** One fact's text in one column, with the column it is written for: a VALUES row's cell. */
export interface Cell<C> {
	readonly column: C
	readonly text: string
}

/**
 * The cells of a fact normal under the heading of `columns`: each column with its text of the fact's value, in column
 * order, so a fact has one cell per column by construction (rowOf writes the same texts as a row).
 */
export const factCells = <C extends { readonly name: string; readonly type: ScalarType }>(
	columns: ReadonlyArray<C>
): ((fact: { readonly [field: string]: unknown }) => ReadonlyArray<Cell<C>>) => {
	const built = columns.map((column) => ({ column, codec: scalarCodec(column.type) }))
	return (fact) =>
		built.map(({ column, codec }) => ({ column, text: codec.text(fact[column.name]) }))
}

/** What an EncodingFailure reports before the field name: nothing, or the parameter or member it names. */
export type RelationSlot =
	| { readonly kind: "none" }
	| { readonly kind: "slot"; readonly name: string }

export interface RelationSpec {
	/** The relation's name, which a refusal of its columns locates. */
	readonly relation: string
	/** Every field of the facts, in recordset column order. */
	readonly columns: DistinctColumns
	readonly slot: RelationSlot
}

/** A normalized relation input: its normal facts and their text rows. */
export interface NormalizedRelation extends NormalFacts {
	/** Each fact's text forms in column order: the VALUES literals' texts and the recordset's JSON strings. */
	readonly rows: ReadonlyArray<ReadonlyArray<string>>
	readonly count: number
}

export type RelationNormalizer = (
	facts: Iterable<unknown>
) => Result.Result<NormalizedRelation, EncodingFailure>

interface BuiltColumn {
	readonly field: string
	readonly wire: string
	readonly codec: ScalarCodec
}

interface BuiltSpec {
	readonly columns: ReadonlyArray<BuiltColumn>
	readonly heading: ReadonlyArray<HeadingField>
	/** The heading as admitting a fact reads it, planned once with the spec. */
	readonly plan: HeadingPlan
	readonly slot: RelationSlot
}

const buildSpec = (spec: RelationSpec): BuiltSpec => {
	const columns = spec.columns.map((column): BuiltColumn => ({
		field: column.field,
		wire: column.wire,
		codec: scalarCodec(column.type)
	}))
	const heading = columns.map((c): HeadingField => ({ name: c.field, spec: c.codec.spec }))
	return { columns, heading, plan: headingPlan(heading), slot: spec.slot }
}

/** The place an EncodingFailure reports for `field` of the input, or for the input as a whole. */
const placeOf = (spec: BuiltSpec, field: string | undefined): EncodingPlace => {
	const slot = spec.slot
	if (slot.kind === "none") {
		return field === undefined ? factPlace : slotPlace(field)
	}
	return slotPlace(field === undefined ? slot.name : `${slot.name}.${field}`)
}

interface Entry {
	readonly identity: string
	readonly fact: { readonly [field: string]: unknown }
	/** The fact's text forms in column order: the bytes the recordset carries for it. */
	readonly row: ReadonlyArray<string>
}

/** A fact's row: each column's text of the fact's value, in column order, written by a native loop. */
const rowOf = (
	columns: ReadonlyArray<BuiltColumn>,
	fact: { readonly [field: string]: unknown }
): ReadonlyArray<string> => {
	const row: Array<string> = []
	for (const column of columns) {
		row.push(column.codec.text(fact[column.field]))
	}
	return Object.freeze(row)
}

/** The canonical text of a heading's fields and carrier specs in field-name order. */
const headingText = (plan: HeadingPlan): string =>
	canonicalTextOf(plan.fields.map((f) => [f.name, f.spec]))

/** The normal facts of `entries`, frozen, under `heading`. */
const normalFacts = (entries: ReadonlyArray<IdentifiedFact>, heading: string): NormalFacts =>
	Object.freeze({
		heading,
		facts: Object.freeze(entries.map((e) => e.fact)),
		entries: Object.freeze([...entries])
	})

/**
 * A list of admitted facts as normal facts over a heading: each `fact` was admitted by factIdentity over that heading,
 * `identity` is its fact identity, and the entries are distinct by identity and in identity order. The caller vouches
 * for the order and distinctness; the facts must be frozen.
 */
export type NormalForm = (entries: ReadonlyArray<IdentifiedFact>) => NormalFacts

/**
 * Relation-valued inputs: the recordset and VALUES encoder and the Stream collector.
 *
 * An enumerated ChangeSet member and a relation parameter are one thing, a set of facts the input binds.
 * Below the fixed size rule it travels as one jsonb_to_recordset parameter, or as a VALUES list of typed literals
 * below a smaller one; every member, a Stream included, travels this way, and one above the rule is refused before any
 * SQL is sent.
 * The host codec owns the set property and the null ban for these forms:
 *
 * - it validates every field's representation through the exact carrier boundary, which also applies PostgreSQL's
 *   native coercion, because coercion happens before fact identity is established: numeric(5,2) inputs
 *   1.231 and 1.232 are one fact;
 * - it refuses any null member and any null field (nullValue);
 * - it deduplicates complete facts by fact identity (values/identity.ts factIdentity: numeric 1.0 = 1.00, NaN = NaN,
 *   -0 = +0, uuid case), so the recordset is a set without a DISTINCT;
 * - it encodes canonically: facts in code point order of their identities, fields in column order, every value a
 *   JSON string holding its canonical text (scalar.ts), so equal inputs give byte-identical parameters whatever their
 *   order, and NaN, the infinities and money's numeric text reach the column's input function exactly.
 *
 * The recordset's column list names base types; money's column is numeric and the statement converts
 * it with ::money.
 *
 * A Stream member is collected on the host before it reaches this codec (the shell's adapter/apply/collect.ts and adapter/reader/params.ts),
 * bounded by the recordset's own size rule, and then normalized exactly like an array. A caller's retry replays the
 * Stream.
 *
 * The normal form over `spec`'s heading.
 */
export const normalForm = (spec: RelationSpec): NormalForm => {
	const heading = headingText(buildSpec(spec).plan)
	return (entries) => normalFacts(entries, heading)
}

/**
 * The normalizer of one relation input: admission, the null ban, deduplication, and canonical order. Facts of one
 * identity have one row, because every field's text is its value's canonical text, so the parameter bytes, the facts
 * and the rows never depend on input order.
 */
export const relationNormalizer = (spec: RelationSpec): RelationNormalizer =>
	normalizerOf(buildSpec(spec))

const normalizerOf = (s: BuiltSpec): RelationNormalizer => {
	const { columns } = s
	const ownHeading = headingText(s.plan)
	const normalize: RelationNormalizer = (facts) => {
		const byIdentity = new Map<string, Entry>()
		for (const fact of facts) {
			if (fact === null || fact === undefined) {
				return Result.err(encodeFailure("nullValue", placeOf(s, undefined)))
			}
			if (isRecord(fact)) {
				for (const column of columns) {
					if (Object.hasOwn(fact, column.field)) {
						const value = fact[column.field]
						if (value === null || value === undefined) {
							return Result.err(encodeFailure("nullValue", placeOf(s, column.field)))
						}
					}
				}
			}
			const admitted = admitFact(s.plan, fact)
			if (!admitted.ok) {
				return Result.err(encodeFailure(admitted.error.fault, placeOf(s, admitted.error.field)))
			}
			const { identity, fact: value } = admitted.value
			if (!byIdentity.has(identity)) {
				byIdentity.set(identity, { identity, fact: value, row: rowOf(columns, value) })
			}
		}
		const entries = [...byIdentity.values()]
		entries.sort((a, b) => compareCodePoints(a.identity, b.identity))
		const rows = entries.map((e) => e.row)
		const identified = entries.map(({ identity, fact }) => Object.freeze({ identity, fact }))
		return Result.ok(
			Object.freeze({
				...normalFacts(identified, ownHeading),
				rows: Object.freeze(rows),
				count: entries.length
			})
		)
	}
	return normalize
}

/** Normal facts to their normalized relation under one spec, written in its column order. */
export type NormalRows = (normal: NormalFacts) => Result.Result<NormalizedRelation, EncodingFailure>

const normalRowsOf = (s: BuiltSpec): NormalRows => {
	const { columns } = s
	const ownHeading = headingText(s.plan)
	const normalize = normalizerOf(s)
	return (normal) =>
		normal.heading === ownHeading
			? Result.ok(
					Object.freeze({
						...normal,
						rows: Object.freeze(normal.facts.map((fact) => rowOf(columns, fact))),
						count: normal.facts.length
					})
				)
			: normalize(normal.facts)
}

/**
 * Normal facts written as `spec`'s rows: facts normal under its heading are only written in its column order, never
 * admitted again; facts normal under another heading are normalized under this one.
 */
export const normalRows = (spec: RelationSpec): NormalRows => normalRowsOf(buildSpec(spec))

/** The recordset encoder of a member slot's placeholder, over the slot's normal facts (normalRows). */
export const normalEncoder = (
	spec: RelationSpec
): ((
	normal: NormalFacts
) => Result.Result<{ readonly json: string; readonly count: number }, EncodingFailure>) => {
	const built = buildSpec(spec)
	const rowsOf = normalRowsOf(built)
	const wires = built.columns.map((c) => c.wire)
	return (normal) =>
		Result.map(rowsOf(normal), (normalized) => ({
			json: recordsetJson(wires, normalized.rows),
			count: normalized.count
		}))
}

/**
 * The JSON text of a normalized input for `jsonb_to_recordset($n::jsonb) AS r(<wire> <type>, ...)`: an array of
 * objects whose keys are the wire names in column order and whose values are JSON strings of the text forms.
 */
export const recordsetJson = (
	wires: ReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<string>>
): string => {
	/** The text before each value: the row's opening brace with the first key, a comma with every other. */
	const prefixes = wires.map((w, i) => `${i === 0 ? "{" : ","}${JSON.stringify(w)}:`)
	const close = prefixes.length === 0 ? "{}" : "}"
	let json = "["
	let first = true
	for (const row of rows) {
		if (!first) {
			json += ","
		}
		first = false
		/** A normalized row holds one text per wire, in wire order: each wire's prefix with its text. */
		const texts = row.values()
		for (const prefix of prefixes) {
			const text = texts.next()
			if (text.done === true) {
				break
			}
			json += `${prefix}${JSON.stringify(text.value)}`
		}
		json += close
	}
	return `${json}]`
}

/**
 * The normalizer of a relation parameter's input, a read's and a write's alike: the relation normalizer, then each value
 * of a refined column checked against its refinements (scalar.ts refinedMember), as a scalar parameter is, since the
 * recordset carries it as its base type, so a fact outside them is refused at bind (refinedValue) before any SQL. A
 * ChangeSet member's facts are no parameter: one outside its column's domain is refused by the domain's law
 * (relationNormalizer).
 */
export const parameterNormalizer = (spec: RelationSpec): RelationNormalizer =>
	parameterNormalizerOf(buildSpec(spec))

const parameterNormalizerOf = (built: BuiltSpec): RelationNormalizer => {
	const normalize = normalizerOf(built)
	const refined = built.columns.flatMap((c) => {
		const member = refinedMember(c.codec.type)
		return member === undefined ? [] : [{ field: c.field, member }]
	})
	return (facts) => {
		const normalized = normalize(facts)
		if (!normalized.ok) {
			return normalized
		}
		for (const fact of normalized.value.facts) {
			for (const { field, member } of refined) {
				if (!member(fact[field])) {
					return Result.err(encodeFailure("refinedValue", placeOf(built, field)))
				}
			}
		}
		return normalized
	}
}

/**
 * The recordset parameter encoder of one relation input (ir/products.ts RelationParamEncoder): its normal facts as a
 * relation parameter's (parameterNormalizer), written as the recordset's JSON.
 */
export const recordsetEncoder = (spec: RelationSpec): RelationParamEncoder => {
	const built = buildSpec(spec)
	const normalize = parameterNormalizerOf(built)
	const wires = built.columns.map((c) => c.wire)
	return (facts) =>
		Result.map(normalize(facts), (normalized) => ({
			json: recordsetJson(wires, normalized.rows),
			count: normalized.count
		}))
}
