/**
 * A relation input's encoding, a hot path: every execution that binds a relation input normalizes it and writes each
 * of its facts here, so the per-fact work is native loops with no closure or Option per element.
 */
import { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
import { refinedMember, type ScalarCodec, scalarCodec } from "#compiler/codec/scalar.ts"
import { nominal } from "#compiler/core/brand.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type { EncodingFailure, EncodingPlace } from "#compiler/core/errors.ts"
import { textMaxLength } from "#compiler/core/policy.ts"
import { isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import type {
	ArrayTexts,
	IdentifiedFact,
	LiteralBound,
	NormalFacts,
	RelationParamEncoder
} from "#compiler/ir/products.ts"
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
}

declare const distinctColumnsBrand: unique symbol

/**
 * A relation input's columns, each field distinct: what every relation codec is built over, so building one refuses
 * nothing. Minted where a heading's columns become an input's columns (positionalColumns): a heading's names are
 * distinct, since the checker builds every heading from a record's keys or a relation's declared fields
 * (schema/record.ts).
 */
export type DistinctColumns = ReadonlyArray<RelationColumn> & {
	readonly [distinctColumnsBrand]: true
}

const distinctColumns = nominal<ReadonlyArray<RelationColumn>, DistinctColumns>()

/** A heading's columns in its order, which is the order of the input's arrays. */
export const positionalColumns = (
	heading: ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>
): DistinctColumns => distinctColumns(heading.map((c) => ({ field: c.name, type: c.type })))

/** What an EncodingFailure reports before the field name: nothing, or the parameter or member it names. */
export type RelationSlot =
	| { readonly kind: "none" }
	| { readonly kind: "slot"; readonly name: string }

export interface RelationSpec {
	/** The relation's name, which a refusal of its columns locates. */
	readonly relation: string
	/** Every field of the facts, in the order of the input's arrays. */
	readonly columns: DistinctColumns
	readonly slot: RelationSlot
}

/** A normalized relation input: its normal facts and their text rows. */
export interface NormalizedRelation extends NormalFacts {
	/** Each fact's text forms in column order: the elements its arrays carry for it. */
	readonly rows: ReadonlyArray<ReadonlyArray<string>>
	readonly count: number
}

export type RelationNormalizer = (
	facts: Iterable<unknown>
) => Result.Result<NormalizedRelation, EncodingFailure>

interface BuiltColumn {
	readonly field: string
	readonly codec: ScalarCodec
}

interface BuiltSpec {
	readonly relation: string
	readonly columns: ReadonlyArray<BuiltColumn>
	readonly heading: ReadonlyArray<HeadingField>
	/** The heading as admitting a fact reads it, planned once with the spec. */
	readonly plan: HeadingPlan
	readonly slot: RelationSlot
}

const buildSpec = (spec: RelationSpec): BuiltSpec => {
	const columns = spec.columns.map((column): BuiltColumn => ({
		field: column.field,
		codec: scalarCodec(column.type)
	}))
	const heading = columns.map((c): HeadingField => ({ name: c.field, spec: c.codec.spec }))
	return {
		relation: spec.relation,
		columns,
		heading,
		plan: headingPlan(heading),
		slot: spec.slot
	}
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
	/** The fact's text forms in column order: the elements its arrays carry for it. */
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
 * Relation-valued inputs: the array encoder and the Stream collector.
 *
 * An enumerated ChangeSet member and a relation parameter are one thing, a set of facts the input binds, whatever its
 * size. It travels as parallel arrays, one text-format array literal per column, every column's array one element per
 * fact in the same order, or, for an input of no column, as its count of facts (sql/ast.ts ArraysSource); every member,
 * a Stream included, travels this way. The host codec owns the set property and the null ban for these forms:
 *
 * - it validates every field's representation through the exact carrier boundary, which also applies PostgreSQL's
 *   native coercion, because coercion happens before fact identity is established: numeric(5,2) inputs
 *   1.231 and 1.232 are one fact;
 * - it refuses any null member and any null field (nullValue);
 * - it deduplicates complete facts by fact identity (values/identity.ts factIdentity: numeric 1.0 = 1.00, NaN = NaN,
 *   -0 = +0, uuid case), so the input is a set without a DISTINCT;
 * - it encodes canonically: facts in code point order of their identities, every column's array in that order, every
 *   element the quoted canonical text of its value (scalar.ts, `arrayElement`), so equal inputs give byte-identical
 *   parameters whatever their order, and NaN, the infinities and money's numeric text reach the element type's input
 *   function exactly.
 *
 * Each array's element type is its column's base type; money's is numeric and the statement converts it with ::money.
 *
 * A Stream member is collected on the host before it reaches this codec (the shell's adapter/apply/collect.ts and
 * adapter/reader/params.ts), and then normalized exactly like an array. A caller's retry replays the Stream.
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

/**
 * One element of a text-format array literal (array_in, src/backend/utils/adt/arrayfuncs.c ReadArrayToken): the text
 * between double quotes, each backslash and double quote inside it after a backslash. Quoted, no element reads as
 * NULL, and no delimiter, brace, blank or backslash of the text is syntax, so the element type's input function reads
 * exactly the text: a range's `[1,5)`, a vector's `[1,2]`, a text holding `","` or `\\`. The delimiter is the comma,
 * every element type's but box's, which grizzle has none of. `overhead` is the text's elementOverhead, so a text with
 * nothing to escape is read once.
 */
const arrayElement = (text: string, overhead: number): string =>
	overhead === 2 ? `"${text}"` : `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/**
 * How many characters `arrayElement` adds to `text`: its two quotes, and a backslash before each backslash or quote;
 * two exactly when the text holds neither.
 */
const elementOverhead = (text: string): number => {
	let added = 2
	for (let at = text.indexOf("\\"); at >= 0; at = text.indexOf("\\", at + 1)) {
		added += 1
	}
	for (let at = text.indexOf('"'); at >= 0; at = text.indexOf('"', at + 1)) {
		added += 1
	}
	return added
}

/**
 * The arrays of a normalized input, one placeholder text each (ir/products.ts ArrayTexts): over `columns` of it, one
 * text-format array literal per column, `{"t1","t2",...}` of its rows' texts in row order, or, of no column, the count
 * of its rows. Every literal is one string, so one longer than `limit` UTF-16 code units, the longest string the host
 * builds in production (core/policy.ts textMaxLength), is refused before it is built, as the bound of the column it
 * carries (ir/products.ts LiteralBound), by a count of its length kept while the rows are read; the literals are
 * written by one pass over the rows.
 */
export const arrayTexts = (
	input: string,
	columns: ReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<string>>,
	limit: number
): Result.Result<ArrayTexts, LiteralBound> => {
	if (columns.length === 0) {
		return Result.ok(Object.freeze([String(rows.length)]))
	}
	/** Each column's literal so far: its length, both braces counted, and its elements. */
	const literals = columns.map((column) => ({ column, length: 2, elements: new Array<string>() }))
	for (const row of rows) {
		/** A normalized row holds one text per column, in column order. */
		const texts = row.values()
		for (const literal of literals) {
			const text = texts.next()
			if (text.done === true) {
				break
			}
			const comma = literal.elements.length === 0 ? 0 : 1
			const overhead = elementOverhead(text.value)
			const length = literal.length + comma + text.value.length + overhead
			if (length > limit) {
				return Result.err({ _tag: "LiteralBound", input, column: literal.column, limit })
			}
			literal.length = length
			literal.elements.push(arrayElement(text.value, overhead))
		}
	}
	return Result.ok(Object.freeze(literals.map((literal) => `{${literal.elements.join(",")}}`)))
}

/** The arrays encoder of a member slot's placeholders, over the slot's normal facts (normalRows). */
export const normalArrays = (
	spec: RelationSpec
): ((normal: NormalFacts) => Result.Result<ArrayTexts, EncodingFailure | LiteralBound>) => {
	const built = buildSpec(spec)
	const rowsOf = normalRowsOf(built)
	const fields = built.columns.map((c) => c.field)
	return (normal) =>
		Result.flatMap(rowsOf(normal), (normalized) =>
			arrayTexts(spec.relation, fields, normalized.rows, textMaxLength)
		)
}

/**
 * The normalizer of a relation parameter's input, a read's and a write's alike: the relation normalizer, then each value
 * of a refined column checked against its refinements (scalar.ts refinedMember), as a scalar parameter is, since the
 * input's array carries it as its base type, so a fact outside them is refused at bind (refinedValue) before any SQL. A
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
 * The arrays encoder of one relation parameter's input (ir/products.ts RelationParamEncoder): its normal facts as a
 * relation parameter's (parameterNormalizer), written as its arrays.
 */
export const arraysEncoder = (spec: RelationSpec): RelationParamEncoder => {
	const built = buildSpec(spec)
	const normalize = parameterNormalizerOf(built)
	const fields = built.columns.map((c) => c.field)
	return (facts) =>
		Result.flatMap(normalize(facts), (normalized) =>
			Result.map(arrayTexts(spec.relation, fields, normalized.rows, textMaxLength), (arrays) => ({
				arrays,
				count: normalized.count
			}))
		)
}
