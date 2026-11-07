import { Array as Arr, Predicate, Result } from "effect"
import { type InputTooLarge, literalBound } from "#adapter/errors/failures.ts"
import type { ExecutionInputs, HostParams } from "#adapter/reader/execution.ts"
import {
	canonicalEquals,
	type Codebook,
	defined,
	Engine,
	type Encoder,
	type EncodingFailure,
	everyProperty,
	type LiteralBound,
	maxStringLength,
	type Param,
	type ParamDecl,
	type ParamId,
	type ParamText,
	type RelationParamDecl,
	type ScalarType
} from "#compiler/plan/common.ts"
import {
	columnLiteral,
	countParam,
	encodeFailure,
	type NormalizedRelation,
	normalArray,
	paramEncoder,
	parameterNormalizer,
	positionalColumns,
	type RelationColumn,
	type RelationNormalizer,
	type RelationSpec,
	slotPlace
} from "#compiler/plan/read.ts"

/** The columns a statement's relation slot reads, in its arrays' order. */
type SlotColumns = ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>

/** One relation input, normalized. */
interface RelationInput {
	readonly decl: ParamDecl
	readonly normalized: NormalizedRelation
	/**
	 * The array at `part` of the input over a statement's `columns`, the columns its placeholders in that statement
	 * share (codec/recordset.ts arrayTexts): its column's literal, or, of no column, the count; each placeholder writes
	 * its own.
	 */
	readonly array: (
		columns: ReadonlyArray<RelationColumn>,
		part: number
	) => Result.Result<Param, InputTooLarge>
}

export type RelationInputs = ReadonlyMap<ParamId, RelationInput>

/**
 * The spec of a relation parameter's columns `columns`, in the order a statement's slot lists them, under the
 * installation's codes `codes`.
 */
const specOver = (
	decl: RelationParamDecl,
	columns: SlotColumns,
	codes: Codebook
): RelationSpec => ({
	relation: decl.name,
	slot: { kind: "slot", name: decl.name },
	columns: positionalColumns(columns),
	codes
})

/** The normalizer of a relation input over `columns`: a relation parameter's, which refuses a value outside its refinements. */
const normalizerOver = (
	decl: RelationParamDecl,
	columns: SlotColumns,
	codes: Codebook
): RelationNormalizer => parameterNormalizer(specOver(decl, columns, codes))

const sameColumns = (a: SlotColumns, b: SlotColumns): boolean =>
	a.length === b.length &&
	Arr.every(
		Arr.zip(a, b),
		([x, y]) => x.name === y.name && canonicalEquals(x.type, y.type, everyProperty)
	)

type Normalizer = ReturnType<typeof normalizerOver>

/**
 * The codec of one declared parameter: a scalar parameter's encoder, by its declared type; a relation parameter's
 * normalizer, over its declared heading, with the installation's codes its normal facts are written again under in a
 * statement's own column order.
 */
export type ParamCodec =
	| {
			readonly kind: "scalar"
			readonly decl: Extract<ParamDecl, { readonly kind: "scalar" }>
			readonly encode: Encoder
	  }
	| {
			readonly kind: "relation"
			readonly decl: RelationParamDecl
			readonly normalize: Normalizer
			readonly codes: Codebook
	  }

/**
 * The codecs of a read's or write's declared parameters, in declaration order, built once where its template is
 * compiled: once per call for a direct read or apply, which compiles per call, and once for a db.compile handle, whose
 * every execution encodes with them.
 */
export type ParamCodecs = ReadonlyArray<ParamCodec>

export const paramCodecs = (declared: ReadonlyArray<ParamDecl>, codes: Codebook): ParamCodecs =>
	Arr.map(declared, (decl): ParamCodec =>
		decl.kind === "relation"
			? { kind: "relation", decl, normalize: normalizerOver(decl, decl.heading, codes), codes }
			: { kind: "scalar", decl, encode: paramEncoder(decl.type, decl.name, codes) }
	)

/**
 * Normalizes one relation input.
 *
 * The arrays encoder's own shape rule: an iterable object of facts (lower/template.ts).
 */
const prepareInput = (
	codec: Extract<ParamCodec, { readonly kind: "relation" }>,
	value: unknown
): Result.Result<RelationInput, EncodingFailure> => {
	const decl = codec.decl
	if (typeof value !== "object" || !Predicate.isIterable(value)) {
		return Result.fail(encodeFailure("factShape", slotPlace(decl.name)))
	}
	const declared: SlotColumns = decl.heading
	const normalized = codec.normalize(value)
	if (!normalized.ok) {
		return Result.fail(normalized.error)
	}
	const normal = normalized.value
	/**
	 * The input's array at `part` over a statement's column list: in the declared order, of the rows normalized above;
	 * in another, of the normal facts above written again (codec/recordset.ts normalArray), not the input: an iterator
	 * input is spent by then.
	 */
	const array = (
		columns: ReadonlyArray<RelationColumn>,
		part: number
	): Result.Result<Param, InputTooLarge> => {
		const written = sameColumns(columns, declared)
			? declaredArray(decl, normal, part)
			: normalArray(specOver(decl, columns, codec.codes))(normal, part)
		return written.ok ? Result.succeed(written.value) : Result.fail(literalBound(written.error))
	}
	return Result.succeed({ decl, normalized: normal, array })
}

/**
 * The array at `part` of a relation input over its declared columns, of the rows its normalization wrote in their order
 * (normalizerOver): its column's literal, or, of no column, the count of its facts.
 */
const declaredArray = (
	decl: RelationParamDecl,
	normal: NormalizedRelation,
	part: number
): Engine.Result<ParamText, LiteralBound> => {
	if (decl.heading.length === 0) {
		return Engine.ok(countParam(normal.count))
	}
	const column = defined(decl.heading[part], "a placeholder's column among its input's columns")
	return columnLiteral(
		decl.name,
		column.name,
		normal.rows,
		(row) => defined(row[part], "a normalized row's text at its column"),
		maxStringLength.value
	)
}

/**
 * The inputs of one execution, from one walk of the declared parameters' codecs: every relation parameter's input
 * normalized and every scalar parameter's text encoded by its declared type's codec, or the read's refusal before any
 * SQL at the first declaration refused. The statements bind their placeholders from nothing else.
 *
 * One walk of the read's declared parameters admits every one of them, whether or not the selected artifact's
 * statements bind it (an optimizer may prove a rule empty and drop the parameters only it read), and the statements
 * bind their placeholders from what this walk produced (execution.ts readBinding) and send only those, so a read's
 * refusal never depends on what the optimizer eliminated, and what is admitted is what is sent.
 *
 * Every relation input of the read is normalized once, before any of its SQL is sent (codec/recordset.ts: field
 * validation, the null ban, deduplication of complete facts, canonical order). So an input the codec refuses is the
 * codec's EncodingFailure (the parameter, `parameter.field` for a fact's field, and the fault), a read's ReadFailure
 * reason at stage encode and a write's own EncodingFailure, whatever statement would have read it first. A Stream
 * parameter arrives here collected (params.ts), so its distinct facts follow the same rule.
 *
 * Every relation input then travels as its arrays, whatever its size (lower/shapes/relparam): each of its placeholders
 * in a statement carries one array of its normal facts over the statement's columns, which that placeholder alone
 * writes (`RelationInput.array`), so the input's facts are encoded once in all. The execution's Bind messages are
 * bounded, not its rows: one longer than PostgreSQL reads is refused before the flight is sent (wire/batch.ts), as is a
 * column whose array is longer than one string holds, at its placeholder, each as InputTooLarge, a write's
 * ExecutionFailure reason and a read's ReadFailure reason at stage resource.
 */
export const executionInputs = (
	codecs: ParamCodecs,
	params: HostParams
): Result.Result<ExecutionInputs, EncodingFailure> => {
	const relations = new Map<ParamId, RelationInput>()
	const scalars = new Map<ParamId, Param>()
	for (const codec of codecs) {
		if (codec.kind === "relation") {
			const input = prepareInput(codec, params[codec.decl.name])
			if (Result.isFailure(input)) {
				return Result.fail(input.failure)
			}
			relations.set(codec.decl.id, input.success)
		} else {
			const text = codec.encode(params[codec.decl.name])
			if (!text.ok) {
				return Result.fail(text.error)
			}
			scalars.set(codec.decl.id, text.value)
		}
	}
	return Result.succeed({ params, scalars, relations })
}
