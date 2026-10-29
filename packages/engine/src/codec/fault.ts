import {
	type CodecFault,
	EncodingFailure,
	type EncodingPlace,
	type ValueFault
} from "#compiler/core/errors.ts"
import { isValueFault } from "#compiler/scalar/values/fault.ts"

const codecFaults: { readonly [F in Exclude<CodecFault, ValueFault>]: string } = {
	/** The null ban: no parameter or member field is ever null. */
	nullValue: "a non-null value: grizzle has no NULL, and absence is zero rows"
}

export const isCodecFault = (value: unknown): value is CodecFault =>
	isValueFault(value) || (typeof value === "string" && Object.hasOwn(codecFaults, value))

/**
 * The codec refusal vocabulary and the errors it maps onto.
 *
 * A codec refuses with one fixed word, never with the value: the exact value carriers' ValueFault words
 * (scalar/values/fault.ts) for host values, plus the word below for the null ban. An encoder's
 * refusal of a parameter or member value is EncodingFailure{ reason: { _tag: word }, place }. Reading a result refuses
 * nothing: a result text is PostgreSQL's own output, converted without a check (values/convert.ts).
 *
 * The refusal of a host value: its fault, at `place`, the parameter, member or field slot that frames it, or a whole
 * fact when none does (a stream's value, a parameters argument).
 */
export const encodeFailure = (fault: CodecFault, place: EncodingPlace): EncodingFailure =>
	EncodingFailure.make({ reason: { _tag: fault }, place })

/** The place of the parameter, member or field slot `name`. */
export const slotPlace = (name: string): EncodingPlace => ({ _tag: "Slot", name })

/** The place of a whole fact, which no slot frames. */
export const factPlace: EncodingPlace = { _tag: "Fact" }
