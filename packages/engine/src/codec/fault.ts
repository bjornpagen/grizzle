import { type CodecFault, EncodingFailure, type EncodingPlace } from "#compiler/core/errors.ts"

/**
 * The codec refusal vocabulary and the errors it maps onto.
 *
 * A codec refuses with one fixed word, never with the value: the exact value carriers' ValueFault words
 * (scalar/values/fault.ts) for host values, the exact parse, plus nullValue for the null ban (core/errors.ts CodecFault):
 * a parameter's contract and pattern are PostgreSQL's, which its placeholder's domain checks as it is bound. An
 * encoder's
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
