/**
 * A relation input's encoding, a hot path: every execution that binds a relation input normalizes it and writes each
 * of its facts here, so the per-fact work is native loops with no closure or Option per element.
 */
import { byteaArray } from "#compiler/codec/bytea.ts"
import { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
import {
	countParam,
	refinedMember,
	type ScalarCodec,
	scalarCodec,
	textParam
} from "#compiler/codec/scalar.ts"
import { nominal } from "#compiler/core/brand.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type { EncodingFailure, EncodingPlace } from "#compiler/core/errors.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { type ReadonlyTupleMap, TupleMap } from "#compiler/core/tuple-map.ts"
import type { Param, ParamText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
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
	admitted,
	compareFactIdentities,
	type FactIdentity,
	type HeadingField,
	type HeadingPlan,
	headingPlan,
	specContent
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
	/** The installation's codes, which a closed id's and a set's columns are written by. */
	readonly codes: Codebook
}

/** A normalized relation input: its normal facts and their text rows. */
export interface NormalizedRelation extends NormalFacts {
	/** Each fact's text forms in column order: the elements its arrays carry for it. */
	readonly rows: ReadonlyArray<ReadonlyArray<ParamText>>
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
		codec: scalarCodec(column.type, spec.codes)
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

/** A fact's row: each column's text of the fact's value, in column order, written by a native loop. */
const rowOf = (
	columns: ReadonlyArray<BuiltColumn>,
	fact: { readonly [field: string]: unknown }
): ReadonlyArray<ParamText> => {
	const row: Array<ParamText> = []
	for (const column of columns) {
		row.push(column.codec.text(fact[column.field]))
	}
	return Object.freeze(row)
}

/** The canonical text of a heading's fields and carrier specs' content (specContent) in field-name order. */
const headingText = (plan: HeadingPlan): string =>
	canonicalTextOf(plan.fields.map((f) => [f.name, specContent(f.spec)]))

type Fact = { readonly [field: string]: unknown }

/** The brand's one claim, which only normalFacts makes. */
const mintNormal = nominal<Pick<NormalFacts, "heading" | "facts" | "entries">, NormalFacts>()

/**
 * The one mint of normal facts: the facts of `byIdentity` under `heading`, keyed by their fact identities, which a
 * TupleMap holds once each, so the facts are distinct by construction, put in the canonical order of their identities
 * here (compareFactIdentities), and frozen.
 */
const normalFacts = (
	byIdentity: ReadonlyTupleMap<FactIdentity, { readonly fact: Fact }>,
	heading: string
): NormalFacts => {
	const entries = Array.from(byIdentity, ([identity, { fact }]): IdentifiedFact =>
		Object.freeze({ identity, fact })
	)
	entries.sort((a, b) => compareFactIdentities(a.identity, b.identity))
	return mintNormal(
		Object.freeze({
			heading,
			facts: Object.freeze(entries.map((e) => e.fact)),
			entries: Object.freeze(entries)
		})
	)
}

/**
 * Admitted facts as normal facts over a heading, keyed by their fact identities: each fact was admitted by
 * factIdentity over that heading, its key is its identity, and it is frozen. The TupleMap holds each identity once, so
 * the facts are a set by construction, and the normal form puts them in identity order itself.
 */
export type NormalForm = (
	byIdentity: ReadonlyTupleMap<FactIdentity, { readonly fact: Fact }>
) => NormalFacts

/**
 * Relation-valued inputs: the array encoder and the Stream collector.
 *
 * An enumerated ChangeSet member and a relation parameter are one thing, a set of facts the input binds, whatever its
 * size. It travels as parallel arrays, one text-format array literal per column, a bytes column's a binary bytea[]
 * (codec/bytea.ts) where a member carries it, every column's array one element per
 * fact in the same order, or, for an input of no column, as its count of facts (sql/ast.ts ArraysSource); every member,
 * a Stream included, travels this way. The host codec owns the set property and the null ban for these forms:
 *
 * - it validates every field's representation through the exact carrier boundary, which also applies PostgreSQL's
 *   native coercion, because coercion happens before fact identity is established: numeric(5,2) inputs
 *   1.231 and 1.232 are one fact;
 * - it refuses any null member and any null field (nullValue);
 * - it deduplicates complete facts by fact identity (values/identity.ts factIdentity: numeric 1.0 = 1.00, NaN = NaN,
 *   -0 = +0, uuid case), so the input is a set without a DISTINCT;
 * - it encodes canonically: facts in the canonical order of their identities (compareFactIdentities), every column's
 *   array in that order, every element the quoted canonical text of its value (scalar.ts, `arrayElement`), so equal
 *   inputs give byte-identical parameters whatever their order, and NaN, the infinities and money's numeric text reach
 *   the element type's input function exactly.
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
	return (byIdentity) => normalFacts(byIdentity, heading)
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
		const byIdentity = new TupleMap<FactIdentity, { readonly fact: Fact }>()
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
				byIdentity.set(identity, { fact: value })
			}
		}
		const normal = normalFacts(byIdentity, ownHeading)
		return Result.ok(
			Object.freeze({
				...normal,
				rows: Object.freeze(normal.facts.map((fact) => rowOf(columns, fact))),
				count: normal.facts.length
			})
		)
	}
	return normalize
}

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

/** An array literal of parameter texts, itself a parameter text: minted here, where each one is written. */
const arrayLiteral = nominal<string, ParamText>()

/** One column's array literal while arrayTexts writes it: its column, its length so far and its elements. */
interface OpenLiteral {
	readonly column: string
	length: number
	readonly elements: Array<string>
}

/**
 * `literal` grown by `added` UTF-16 code units, or its column's refusal where that passes `limit`: the one place a
 * literal's length grows, its braces as much as each element and its comma, so no literal arrayTexts or columnLiteral
 * writes, of no row or of many, passes the bound.
 */
const grown = (
	input: string,
	limit: number,
	literal: OpenLiteral,
	added: number
): LiteralBound | undefined => {
	const length = literal.length + added
	if (length > limit) {
		return { _tag: "LiteralBound", form: "text", input, column: literal.column, limit }
	}
	literal.length = length
	return undefined
}

/**
 * A literal of `column` with its braces counted and no element yet, or its refusal where the braces alone pass
 * `limit`.
 */
const opened = (
	input: string,
	limit: number,
	column: string
): Result.Result<OpenLiteral, LiteralBound> => {
	const literal: OpenLiteral = { column, length: 0, elements: [] }
	const refused = grown(input, limit, literal, "{}".length)
	return refused === undefined ? Result.ok(literal) : Result.err(refused)
}

/** `literal` with `text` written as its next element, or its column's refusal where that passes `limit`. */
const appended = (
	input: string,
	limit: number,
	literal: OpenLiteral,
	text: ParamText
): LiteralBound | undefined => {
	const comma = literal.elements.length === 0 ? 0 : 1
	const overhead = elementOverhead(text)
	const refused = grown(input, limit, literal, comma + text.length + overhead)
	if (refused !== undefined) {
		return refused
	}
	literal.elements.push(arrayElement(text, overhead))
	return undefined
}

/** A written literal's text: its elements between braces. */
const closed = (literal: OpenLiteral): ParamText => arrayLiteral(`{${literal.elements.join(",")}}`)

/**
 * The arrays of a normalized input, one placeholder text each (ir/products.ts ArrayTexts): over `columns` of it, one
 * text-format array literal per column, `{"t1","t2",...}` of its rows' texts in row order, or, of no column, the count
 * of its rows. Every literal is one string, so one longer than `limit` UTF-16 code units, the longest string the host
 * builds in production (core/limits.ts maxStringLength), is refused before it is built, as the bound of the column it
 * carries (ir/products.ts LiteralBound), by a count of its length that every character it gains goes through (grown),
 * its braces before any row; the literals are written by one pass over the rows.
 */
export const arrayTexts = (
	input: string,
	columns: ReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<ParamText>>,
	limit: number
): Result.Result<ArrayTexts, LiteralBound> => {
	if (columns.length === 0) {
		return Result.ok(Object.freeze([countParam(rows.length)]))
	}
	const literals: Array<OpenLiteral> = []
	for (const column of columns) {
		const literal = opened(input, limit, column)
		if (!literal.ok) {
			return Result.err(literal.error)
		}
		literals.push(literal.value)
	}
	for (const row of rows) {
		/** A normalized row holds one text per column, in column order. */
		const texts = row.values()
		for (const literal of literals) {
			const text = texts.next()
			if (text.done === true) {
				break
			}
			const refused = appended(input, limit, literal, text.value)
			if (refused !== undefined) {
				return Result.err(refused)
			}
		}
	}
	return Result.ok(Object.freeze(literals.map(closed)))
}

/**
 * One column's array literal, as arrayTexts writes each: `{"t1","t2",...}` of `text` of each of `items` in order,
 * refused as `column`'s bound before it passes `limit`.
 */
export const columnLiteral = <T>(
	input: string,
	column: string,
	items: ReadonlyArray<T>,
	text: (item: T) => ParamText,
	limit: number
): Result.Result<ParamText, LiteralBound> => {
	const literal = opened(input, limit, column)
	if (!literal.ok) {
		return Result.err(literal.error)
	}
	for (const item of items) {
		const refused = appended(input, limit, literal.value, text(item))
		if (refused !== undefined) {
			return Result.err(refused)
		}
	}
	return Result.ok(closed(literal.value))
}

/**
 * A text[] parameter of `values`, each the text carrier's parameter text, as one text-format array literal: the
 * shell's catalog statements' arrays of names.
 */
export const textArrayParam = (values: ReadonlyArray<string>): ParamText =>
	arrayLiteral(
		`{${values
			.map((v) => {
				const text = textParam(v)
				return arrayElement(text, elementOverhead(text))
			})
			.join(",")}}`
	)

/**
 * The writer of a placeholder's array of normal facts under `spec` (ir/products.ts ArrayEncoder): of the facts written
 * in the spec's column order, the array at a part, its column's literal (columnLiteral), a bytes column's binary bytea[]
 * of its admitted values (codec/bytea.ts byteaArray), or, of no column, their count.
 * Each placeholder writes its own array and no other, and never admits a fact again. Its columns are its input's whole
 * heading in the statement's order, which every statement over an input declares, so the facts are normal under the
 * spec's heading; facts normal under another are the compiler's defect, never the caller's input, since admitting them
 * again under it could only refuse them.
 */
export const normalArray = (
	spec: RelationSpec
): ((normal: NormalFacts, part: number) => Result.Result<Param, LiteralBound>) => {
	const built = buildSpec(spec)
	const ownHeading = headingText(built.plan)
	return (normal, part) => {
		if (normal.heading !== ownHeading) {
			throw defect(`a placeholder of ${spec.relation} reads a heading other than its input's`)
		}
		if (built.columns.length === 0) {
			return Result.ok(countParam(normal.facts.length))
		}
		const column = defined(built.columns[part], "a placeholder's column among its input's columns")
		return column.codec.spec.carrier === "bytes"
			? byteaArray(
					spec.relation,
					column.field,
					normal.facts.map((fact) => admitted({ carrier: "bytes" }, fact[column.field]))
				)
			: columnLiteral(
					spec.relation,
					column.field,
					normal.facts,
					(fact) => column.codec.text(fact[column.field]),
					maxStringLength.value
				)
	}
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
			Result.map(
				arrayTexts(spec.relation, fields, normalized.rows, maxStringLength.value),
				(arrays) => ({
					arrays,
					count: normalized.count
				})
			)
		)
}
