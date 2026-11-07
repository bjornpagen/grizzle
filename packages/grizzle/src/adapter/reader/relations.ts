import { Array as Arr, Predicate, Result } from "effect"
import { type InputTooLarge, literalBound } from "#adapter/errors/failures.ts"
import type { ExecutionInputs, HostParams } from "#adapter/reader/execution.ts"
import {
	type ArrayTexts,
	canonicalEquals,
	type Codebook,
	type Encoder,
	type EncodingFailure,
	everyProperty,
	maxStringLength,
	type ParamDecl,
	type ParamId,
	type ParamText,
	type RelationParamDecl,
	type ScalarType
} from "#compiler/plan/common.ts"
import {
	arrayTexts,
	encodeFailure,
	type NormalizedRelation,
	type NormalRows,
	normalRows,
	paramEncoder,
	parameterNormalizer,
	positionalColumns,
	type RelationColumn,
	type RelationNormalizer,
	type RelationSpec,
	slotPlace
} from "#compiler/plan/read.ts"

/**
 * A read's inputs made ready for one execution: every declared parameter admitted.
 *
 * One walk of the read's declared parameters admits every one of them, whether or not the selected artifact's
 * statements bind it (an optimizer may prove a rule empty and drop the parameters only it read): a scalar parameter's
 * value is encoded by its declared type's codec, a relation parameter's input normalized. The statements bind their
 * placeholders from what this walk produced (execution.ts readBinding) and send only those, so a read's refusal never
 * depends on what the optimizer eliminated, and what is admitted is what is sent.
 *
 * Every relation input travels as its arrays, whatever its size (lower/shapes/relparam): each of its placeholders in a
 * statement carries one array of its normal facts over the statement's columns, which are written once per execution
 * for each statement reading of it (`RelationInput.arrays`). The execution's Bind messages are bounded, not its rows:
 * one longer than PostgreSQL reads is refused before the flight is sent (wire/batch.ts), as is a column whose array is
 * longer than one string holds, here, each as InputTooLarge, a write's ExecutionFailure reason and a read's ReadFailure
 * reason at stage resource.
 *
 * Every relation input of the read is normalized once, before any of its SQL is sent, exactly as a statement's arrays
 * encoder normalizes it (codec/recordset.ts: field validation, the null ban, deduplication of complete facts,
 * canonical order). So an input the codec refuses is the codec's EncodingFailure (the parameter, `parameter.field` for
 * a fact's field, and the fault), a read's ReadFailure reason at stage encode, whatever statement would have read it
 * first. A Stream parameter arrives here collected (params.ts), so its distinct facts follow the same rule.
 *
 * Why an input never reaches a statement: its codec refused it, with the EncodingFailure that names the parameter and
 * the fault, or one of its arrays is longer than one string holds. A read reports it as its ReadFailure's reason, a
 * write as its own EncodingFailure or its ExecutionFailure's reason.
 */
export type InputRefusal = EncodingFailure | InputTooLarge

/** The columns a statement's relation slot reads, in its arrays' order. */
type SlotColumns = ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>

/** One relation input, normalized. */
interface RelationInput {
	readonly decl: ParamDecl
	readonly normalized: NormalizedRelation
	/**
	 * The input's arrays over a statement's `columns` (codec/recordset.ts arrayTexts), the columns its placeholders in
	 * that statement share: written at the first placeholder that asks, and found again by the others.
	 */
	readonly arrays: (
		columns: ReadonlyArray<RelationColumn>
	) => Result.Result<ArrayTexts, InputRefusal>
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

/** The rows of a relation input's normal facts over `columns`, as normalizerOver's heading writes them. */
const rowsOver = (decl: RelationParamDecl, columns: SlotColumns, codes: Codebook): NormalRows =>
	normalRows(specOver(decl, columns, codes))

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
): Result.Result<RelationInput, InputRefusal> => {
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
	 * The input over a statement's column list: as normalized above in the declared order, and in another order the
	 * normal facts above written again, not the input: an iterator input is spent by then, and normal facts over the same
	 * heading are only written in this column order (normalRows).
	 */
	const over = (columns: SlotColumns): Result.Result<NormalizedRelation, InputRefusal> => {
		if (sameColumns(columns, declared)) {
			return Result.succeed(normal)
		}
		const again = rowsOver(decl, columns, codec.codes)(normal)
		return again.ok ? Result.succeed(again.value) : Result.fail(again.error)
	}
	/** Each statement reading's arrays, by the columns its placeholders share, written once per execution. */
	const written = new Map<ReadonlyArray<RelationColumn>, ArrayTexts>()
	const arrays = (
		columns: ReadonlyArray<RelationColumn>
	): Result.Result<ArrayTexts, InputRefusal> => {
		const known = written.get(columns)
		if (known !== undefined) {
			return Result.succeed(known)
		}
		return Result.flatMap(over(columns), (rows) => {
			const texts = arrayTexts(
				decl.name,
				Arr.map(columns, (c) => c.name),
				rows.rows,
				maxStringLength.value
			)
			if (!texts.ok) {
				return Result.fail(literalBound(texts.error))
			}
			written.set(columns, texts.value)
			return Result.succeed(texts.value)
		})
	}
	return Result.succeed({ decl, normalized: normal, arrays })
}

/**
 * The inputs of one execution, from one walk of the declared parameters' codecs (see the header): every relation
 * parameter's input normalized and every scalar parameter's text encoded by its declared type's codec, or the read's
 * refusal before any SQL at the first declaration refused. The statements bind their placeholders from nothing else.
 */
export const executionInputs = (
	codecs: ParamCodecs,
	params: HostParams
): Result.Result<ExecutionInputs, InputRefusal> => {
	const relations = new Map<ParamId, RelationInput>()
	const scalars = new Map<ParamId, ParamText>()
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
