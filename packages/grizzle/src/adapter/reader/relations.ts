import { Array as Arr, Predicate, Result } from "effect"
import { InputTooLarge } from "#adapter/errors/failures.ts"
import type { ExecutionInputs, HostParams } from "#adapter/reader/execution.ts"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import {
	type NormalizedRelation,
	normalRows,
	positionalColumns,
	type RelationSpec,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { paramEncoder } from "#compiler/codec/scalar.ts"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import type { Encoder, ParamDecl, RelationParamDecl } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { relationBound, type TransportLimits } from "#compiler/lower/shapes/relparam/index.ts"

/**
 * A read's inputs made ready for one execution: every declared parameter admitted, and the size rule.
 *
 * One walk of the read's declared parameters admits every one of them, whether or not the selected artifact's
 * statements bind it (an optimizer may prove a rule empty and drop the parameters only it read): a scalar parameter's
 * value is encoded by its declared type's codec, a relation parameter's input normalized within the size rule. The
 * statements bind their placeholders from what this walk produced (execution.ts readBinding) and send only those, so a
 * read's refusal never depends on what the optimizer eliminated, and what is admitted is what is sent.
 *
 * Every relation input travels by the VALUES or the recordset path, chosen per execution from its distinct fact count
 * n (lower/shapes/relparam relationTransport):
 *
 * - 0 < n <= valuesMaxRows: a VALUES list of typed literals, which gives the planner exact row estimates; the template
 *   keeps the recordset form, and the statement of this execution is specialized (run.ts, relparam specializeValues);
 * - otherwise, up to recordsetMaxRows: one jsonb_to_recordset parameter, the template's own form;
 * - above recordsetMaxRows: the input is refused before any SQL is sent, as InputTooLarge: a write's ExecutionFailure
 *   reason, and a read's ReadFailure reason at stage resource, the stage of a read's resource failures.
 *
 * Every relation input of the read is normalized once, before any of its SQL is sent, exactly as a statement's
 * recordset encoder normalizes it (codec/recordset.ts: field validation, the null ban, deduplication of complete facts,
 * canonical order). So an input the codec refuses is the codec's EncodingFailure (the parameter, `parameter.field` for a
 * fact's field, and the fault), a read's ReadFailure reason at stage encode, and an input above the recordset rule is
 * refused before any SQL, whatever statement would have read it first. A Stream parameter arrives here collected
 * (params.ts), so its distinct facts follow the same rule.
 *
 * The delivered parent keys of an attachment are not a relation input of the read: the runtime builds them from the
 * rows of its parent statement, and they always travel as the template's recordset (run.ts).
 *
 * Why an input never reaches a statement: its codec refused it, with the EncodingFailure that names the parameter and the
 * fault, or a relation input is past the size limit. A read reports it as its ReadFailure's reason, a write as its own
 * EncodingFailure or its ExecutionFailure's reason.
 */
export type InputRefusal = EncodingFailure | InputTooLarge

/** The columns a statement's relation slot reads, in its recordset's definition order. */
type SlotColumns = ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>

/** One relation input, normalized, within the recordset rule. */
interface RelationInput {
	readonly decl: ParamDecl
	readonly normalized: NormalizedRelation
	/**
	 * The input normalized over `columns`, its rows in their column order, which is the declared heading's order unless
	 * a statement's slot lists the heading otherwise.
	 */
	readonly over: (columns: SlotColumns) => Result.Result<NormalizedRelation, InputRefusal>
}

export type RelationInputs = ReadonlyMap<ParamId, RelationInput>

/** The recordset spec of a relation parameter's columns `columns`, in the order a statement's slot lists them. */
const specOver = (decl: RelationParamDecl, columns: SlotColumns): RelationSpec => ({
	relation: decl.name,
	slot: { kind: "slot", name: decl.name },
	columns: positionalColumns(columns)
})

/** The normalizer of a relation input over `columns`. */
const normalizerOver = (decl: RelationParamDecl, columns: SlotColumns) =>
	relationNormalizer(specOver(decl, columns))

/** The rows of a relation input's normal facts over `columns`, as normalizerOver's heading writes them. */
const rowsOver = (decl: RelationParamDecl, columns: SlotColumns) =>
	normalRows(specOver(decl, columns))

const sameColumns = (a: SlotColumns, b: SlotColumns): boolean =>
	a.length === b.length &&
	Arr.every(
		Arr.zip(a, b),
		([x, y]) => x.name === y.name && canonicalEquals(x.type, y.type, everyProperty)
	)

type Normalizer = ReturnType<typeof normalizerOver>

/**
 * The codec of one declared parameter: a scalar parameter's encoder, by its declared type; a relation parameter's
 * normalizer, over its declared heading.
 */
export type ParamCodec =
	| {
			readonly kind: "scalar"
			readonly decl: Extract<ParamDecl, { readonly kind: "scalar" }>
			readonly encode: Encoder
	  }
	| { readonly kind: "relation"; readonly decl: RelationParamDecl; readonly normalize: Normalizer }

/**
 * The codecs of a read's or write's declared parameters, in declaration order, built once where its template is
 * compiled: once per call for a direct read or apply, which compiles per call, and once for a db.compile handle, whose
 * every execution encodes with them.
 */
export type ParamCodecs = ReadonlyArray<ParamCodec>

export const paramCodecs = (declared: ReadonlyArray<ParamDecl>): ParamCodecs =>
	Arr.map(declared, (decl): ParamCodec =>
		decl.kind === "relation"
			? { kind: "relation", decl, normalize: normalizerOver(decl, decl.heading) }
			: { kind: "scalar", decl, encode: paramEncoder(decl.type, decl.name) }
	)

/**
 * Normalizes one relation input, refused above the recordset rule.
 *
 * The recordset encoder's own shape rule: an iterable object of facts (lower/template.ts).
 */
const prepareInput = (
	codec: Extract<ParamCodec, { readonly kind: "relation" }>,
	value: unknown,
	limits: TransportLimits
): Result.Result<RelationInput, InputRefusal> => {
	const decl = codec.decl
	if (typeof value !== "object" || !Predicate.isIterable(value)) {
		return Result.fail(encodeFailure("factShape", slotPlace(decl.name)))
	}
	const facts = value
	const declared: SlotColumns = decl.heading
	const normalized = codec.normalize(facts)
	if (!normalized.ok) {
		return Result.fail(normalized.error)
	}
	if (!relationBound(normalized.value.count, limits).ok) {
		return Result.fail(new InputTooLarge())
	}
	/**
	 * The input over a statement's column list: as normalized above in the declared order, and in another order the
	 * normal facts above written again, not the input: an iterator input is spent by then, and normal facts over the same
	 * heading are only written in this column order (normalRows).
	 */
	const over = (columns: SlotColumns): Result.Result<NormalizedRelation, InputRefusal> => {
		if (sameColumns(columns, declared)) {
			return Result.succeed(normalized.value)
		}
		const again = rowsOver(decl, columns)(normalized.value)
		return again.ok ? Result.succeed(again.value) : Result.fail(again.error)
	}
	return Result.succeed({ decl, normalized: normalized.value, over })
}

/**
 * The inputs of one execution, from one walk of the declared parameters' codecs (see the header): every relation
 * parameter's input normalized within the size rule and every scalar parameter's text encoded by its declared type's
 * codec, or the read's refusal before any SQL at the first declaration refused. The statements bind their placeholders
 * from nothing else. `limits` are lower/shapes/relparam transportLimits in production.
 */
export const executionInputs = (
	codecs: ParamCodecs,
	params: HostParams,
	limits: TransportLimits
): Result.Result<ExecutionInputs, InputRefusal> => {
	const relations = new Map<ParamId, RelationInput>()
	const scalars = new Map<ParamId, string>()
	for (const codec of codecs) {
		if (codec.kind === "relation") {
			const input = prepareInput(codec, params[codec.decl.name], limits)
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
	return Result.succeed({ params, scalars, relations, limits })
}
