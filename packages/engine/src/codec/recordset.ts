/**
 * A relation input's encoding, a hot path: every execution that binds a relation input normalizes it and writes each
 * of its facts here, so the per-fact work is native loops with no closure or Option per element.
 */
import {
	byteaElementBytes,
	byteaHeaderBytes,
	textArray as binaryTextArray
} from "#compiler/codec/bytea.ts"
import { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
import {
	countParam,
	refinedMember,
	type ScalarCodec,
	scalarCodec,
	textParam
} from "#compiler/codec/scalar.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { EncodingFailure, EncodingPlace } from "#compiler/core/errors.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { type ReadonlyTupleMap, TupleMap } from "#compiler/core/tuple-map.ts"
import type { Param, ParamText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type {
	ArrayTexts,
	IdentifiedFact,
	KeyedFacts,
	LiteralBound,
	NormalFacts
} from "#compiler/ir/products.ts"
import type { Carrier, ScalarType } from "#compiler/ir/scalar.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import { AdmittedBytes, DigestBook } from "#compiler/scalar/values/bytes.ts"
import {
	admitted,
	compareFactIdentities,
	digestFact,
	type FactIdentity,
	type HeadingField,
	type HeadingPlan,
	headingPlan,
	type ReadFact,
	readFact
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

/** An admitted relation input: its normal facts and how many they are. */
export interface AdmittedRelation extends NormalFacts {
	readonly count: number
}

/** A normalized relation parameter's input: its normal facts and their text rows. */
export interface NormalizedRelation extends AdmittedRelation {
	/** Each fact's text forms in column order: the elements its arrays carry for it. */
	readonly rows: ReadonlyArray<ReadonlyArray<ParamText>>
}

/**
 * A relation input read (scalar/values/identity.ts readFact), none of its bytes read yet, with what its binary arrays
 * take at least (codec/bytea.ts): `together`, each bytes column's array over its reads of distinct parts, which are
 * distinct facts, so a statement that carries the whole input carries at least that; `widest`, the arrays of its
 * widest fact alone, which a statement that carries that fact carries at least.
 */
export interface ReadRelation {
	readonly reads: ReadonlyArray<ReadFact>
	readonly together: number
	readonly widest: number
}

/**
 * A relation input's admission, a ChangeSet member's or a nested write's level's, in two steps, so its caller measures
 * it between them (write/normalize/normalize.ts): `read`, the null ban and each fact read, no bytes read; then `admit`,
 * each bytes value digested and held in its write's `book` (scalar/values/bytes.ts DigestBook), so a digest is one
 * value across the write, the facts deduplicated and put in canonical order. `columns` is how many arrays it travels
 * as, each one placeholder.
 */
export interface RelationNormalizer {
	readonly columns: number
	readonly read: (facts: Iterable<unknown>) => Result.Result<ReadRelation, EncodingFailure>
	readonly admit: (
		read: ReadRelation,
		book: DigestBook
	) => Result.Result<AdmittedRelation, EncodingFailure>
}

/** A relation parameter's normalization, its facts' text rows written beside them. */
export type ParameterNormalizer = (
	facts: Iterable<unknown>
) => Result.Result<NormalizedRelation, EncodingFailure>

interface BuiltColumn {
	readonly field: string
	readonly codec: ScalarCodec
	/** How the column travels as one placeholder's array, in its carrier's form (arrayForms). */
	readonly form: ArrayForm
}

/**
 * One column's array of admitted facts' values at the field `column`, as one placeholder carries it, or the column's
 * bound past which none can: `input` names the relation input, which a refusal names with the field.
 */
type ColumnArray = (
	input: string,
	column: string,
	facts: ReadonlyArray<Fact>
) => Result.Result<Param, LiteralBound>

/**
 * How a column travels: as the array its placeholder writes (`written`), a text array literal of its values' canonical
 * texts or, a text column, a binary text[] of their UTF-8 bytes; or, a bytes column, as the binary array its member
 * wrote once for the whole write (ir/products.ts KeyedFacts), which its placeholder carries.
 */
type ArrayForm =
	| { readonly kind: "written"; readonly array: ColumnArray }
	| { readonly kind: "binary" }

/** A text array literal of the values' canonical texts (columnLiteral), within the longest string. */
const literalArray = (codec: ScalarCodec): ArrayForm => ({
	kind: "written",
	array: (input, column, facts) =>
		columnLiteral(input, column, facts, (fact) => codec.text(fact[column]), maxStringLength.value)
})

/** A text column's binary text[] of its values' canonical texts (codec/bytea.ts textArray), which no literal of the
 * whole array carries, so a column of any length within a message travels. */
const textBinaryArray = (codec: ScalarCodec): ArrayForm => ({
	kind: "written",
	array: (input, column, facts) =>
		binaryTextArray(
			input,
			column,
			facts.map((fact) => codec.text(fact[column]))
		)
})

/** A bytes column's form: its member's binary array, whose values no text carries at their own size. */
const binaryArray: ArrayForm = { kind: "binary" }

/**
 * How each carrier's column travels as one placeholder's array, chosen by its type and never by its size: a text
 * column's binary text[], a bytes column's its member's binary bytea[], and any other's text array literal of its
 * canonical texts. Chosen once per column, when its relation's spec is built, so no fact meets the choice.
 */
const arrayForms: { readonly [C in Carrier]: (codec: ScalarCodec) => ArrayForm } = {
	int2: literalArray,
	int4: literalArray,
	int8: literalArray,
	numeric: literalArray,
	float4: literalArray,
	float8: literalArray,
	money: literalArray,
	bool: literalArray,
	uuid: literalArray,
	date: literalArray,
	text: textBinaryArray,
	bytes: () => binaryArray,
	code: literalArray,
	bits: literalArray,
	range4: literalArray,
	range8: literalArray,
	rangeDate: literalArray,
	vector: literalArray,
	exactInteger: literalArray,
	exactMoney: literalArray
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
	const columns = spec.columns.map((column): BuiltColumn => {
		const codec = scalarCodec(column.type, spec.codes)
		return { field: column.field, codec, form: arrayForms[codec.spec.carrier](codec) }
	})
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

type Fact = { readonly [field: string]: unknown }

/** The brand's one claim, which only normalFacts makes. */
const mintNormal = nominal<Pick<NormalFacts, "facts" | "entries">, NormalFacts>()

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
 * The one mint of normal facts: the facts of `byIdentity`, each admitted by factIdentity over one heading and frozen,
 * keyed by its fact identity, which a TupleMap holds once each, so the facts are distinct by construction, put in the
 * canonical order of their identities here (compareFactIdentities), and frozen.
 */
export const normalFacts = (
	byIdentity: ReadonlyTupleMap<FactIdentity, { readonly fact: Fact }>
): NormalFacts => {
	const entries = Array.from(byIdentity, ([identity, { fact }]): IdentifiedFact =>
		Object.freeze({ identity, fact })
	)
	entries.sort((a, b) => compareFactIdentities(a.identity, b.identity))
	return mintNormal(
		Object.freeze({
			facts: Object.freeze(entries.map((e) => e.fact)),
			entries: Object.freeze(entries)
		})
	)
}

/**
 * The normalizer of one relation input: admission, the null ban, deduplication, and canonical order. Facts of one
 * identity are one fact, so the facts never depend on input order. It writes no text: a relation parameter's rows are
 * its own normalizer's (`parameterNormalizer`), and a member's arrays are written from its facts (`normalArray`).
 */
export const relationNormalizer = (spec: RelationSpec): RelationNormalizer =>
	normalizerOf(buildSpec(spec))

const normalizerOf = (s: BuiltSpec): RelationNormalizer => {
	const { columns } = s
	const bytesAt = s.plan.entries.flatMap((f, at) => (f.spec.carrier === "bytes" ? [at] : []))
	/** The bytes one fact's value at bytes field `at` takes in its column's array, past the array's header. */
	const elements = (read: ReadFact, at: number): number => {
		const value = read.values[at]
		if (value instanceof AdmittedBytes) {
			return byteaElementBytes(value.bytes.length)
		}
		if (!(value instanceof Uint8Array)) {
			throw defect("a read fact's bytes field holds the caller's array")
		}
		return byteaElementBytes(value.length)
	}
	const read = (facts: Iterable<unknown>): Result.Result<ReadRelation, EncodingFailure> => {
		const reads: Array<ReadFact> = []
		const distinct = new TupleMap<ReadonlyArray<string>, ReadFact>()
		let widest = 0
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
			const one = readFact(s.plan, fact)
			if (!one.ok) {
				return Result.err(encodeFailure(one.error.fault, placeOf(s, one.error.field)))
			}
			reads.push(one.value)
			if (bytesAt.length > 0) {
				if (!distinct.has(one.value.parts)) {
					distinct.set(one.value.parts, one.value)
				}
				widest = Math.max(
					widest,
					bytesAt.reduce((sum, at) => sum + byteaHeaderBytes(1) + elements(one.value, at), 0)
				)
			}
		}
		let together = 0
		for (const at of bytesAt) {
			together += byteaHeaderBytes(distinct.size)
			for (const one of distinct.values()) {
				together += elements(one, at)
			}
		}
		return Result.ok({ reads, together, widest })
	}
	const admit = (
		relation: ReadRelation,
		book: DigestBook
	): Result.Result<AdmittedRelation, EncodingFailure> => {
		const byIdentity = new TupleMap<FactIdentity, { readonly fact: Fact }>()
		for (const one of relation.reads) {
			const { identity, fact } = digestFact(s.plan, one)
			for (const at of bytesAt) {
				const field = defined(s.plan.entries[at], "a bytes field of the heading").name
				if (!book.holds(admitted({ carrier: "bytes" }, fact[field]))) {
					return Result.err(encodeFailure("bytesCollision", placeOf(s, field)))
				}
			}
			if (!byIdentity.has(identity)) {
				byIdentity.set(identity, { fact })
			}
		}
		const normal = normalFacts(byIdentity)
		return Result.ok(Object.freeze({ ...normal, count: normal.facts.length }))
	}
	return { columns: columns.length, read, admit }
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

/**
 * The literal of `text` alone, as `columnLiteral` writes it, measured without writing it: its UTF-16 code units, its
 * braces, quotes and escaping backslashes among them (`elementOverhead`), and its UTF-8 bytes, the text's own
 * (core/sha256.ts utf8Length) and one for each character the literal adds, all of them ASCII.
 */
export const literalAlone = (
	text: ParamText
): { readonly units: number; readonly bytes: number } => {
	const added = "{}".length + elementOverhead(text)
	return { units: text.length + added, bytes: utf8Length(text) + added }
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
 * The placeholder of `spec`'s column at `part`: the column, or none for an input of no column. Its columns are its
 * input's whole heading in the statement's order, which every statement over an input declares, so the facts it writes
 * are normal under the spec's heading.
 */
const placeholderOf = (spec: RelationSpec) => {
	const built = buildSpec(spec)
	return (part: number): BuiltColumn | undefined =>
		built.columns.length === 0
			? undefined
			: defined(built.columns[part], "a placeholder's column among its input's columns")
}

/**
 * The writer of a relation parameter's placeholder's array of normal facts under `spec` (ir/products.ts
 * RelationEncoder): of the facts written in the spec's column order, the array at a part, its column's array as its
 * form writes it (`ArrayForm`), or, of no column, their count. Each placeholder writes its own array and no other, and never admits
 * a fact again. No parameter is of bytes, so a binary column here is the compiler's defect.
 */
export const normalArray = (
	spec: RelationSpec
): ((normal: NormalFacts, part: number) => Result.Result<Param, LiteralBound>) => {
	const placeholder = placeholderOf(spec)
	return (normal, part) => {
		const column = placeholder(part)
		if (column === undefined) {
			return Result.ok(countParam(normal.facts.length))
		}
		if (column.form.kind === "binary") {
			throw defect(`a relation parameter's column ${column.field} of bytes`)
		}
		return column.form.array(spec.relation, column.field, normal.facts)
	}
}

/**
 * The writer of a member placeholder's array (ir/products.ts MemberEncoder): a column's array its placeholder writes,
 * as a relation parameter's (`normalArray`), and a bytes column's binary array its member wrote once for the whole
 * write (ir/products.ts KeyedFacts), which every placeholder of the column carries.
 */
export const memberArray = (
	spec: RelationSpec
): ((normal: KeyedFacts, part: number) => Result.Result<Param, LiteralBound>) => {
	const placeholder = placeholderOf(spec)
	return (normal, part) => {
		const column = placeholder(part)
		if (column === undefined) {
			return Result.ok(countParam(normal.facts.length))
		}
		return column.form.kind === "binary"
			? Result.ok(
					defined(
						normal.binary.get(column.field),
						`the binary array of ${column.field}, a bytes column`
					)
				)
			: column.form.array(spec.relation, column.field, normal.facts)
	}
}

/**
 * The normalizer of a relation parameter's input, a read's and a write's alike: the relation normalizer, then each value
 * of a refined column checked against its refinements (scalar.ts refinedMember), as a scalar parameter is, since the
 * input's array carries it as its base type, so a fact outside them is refused at bind (refinedValue) before any SQL;
 * and each fact's text row, its arrays' elements, every field's text its value's canonical text, so equal inputs give
 * equal rows whatever their order. No parameter is of bytes, the one carrier of no parameter text, so the book its
 * admission holds bytes values in is its own and holds none (scalar/values/bytes.ts DigestBook). A ChangeSet
 * member's facts are no parameter: one outside its column's domain is refused by the domain's law (relationNormalizer).
 */
export const parameterNormalizer = (
	spec: RelationSpec,
	patterns: PatternReads
): ParameterNormalizer => parameterNormalizerOf(buildSpec(spec), patterns)

const parameterNormalizerOf = (built: BuiltSpec, patterns: PatternReads): ParameterNormalizer => {
	const normalize = normalizerOf(built)
	const refined = built.columns.flatMap((c) => {
		const member = refinedMember(c.codec.type, patterns)
		return member === undefined ? [] : [{ field: c.field, member }]
	})
	return (facts) => {
		const read = normalize.read(facts)
		if (!read.ok) {
			return read
		}
		const normalized = normalize.admit(read.value, new DigestBook())
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
		return Result.ok(
			Object.freeze({
				...normalized.value,
				rows: Object.freeze(normalized.value.facts.map((fact) => rowOf(built.columns, fact)))
			})
		)
	}
}
