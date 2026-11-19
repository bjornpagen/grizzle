import type { ClockUnit } from "#compiler/core/clock.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/**
 * The parameters a served member binds to the database's clock, by their declared names, each with the unit it reads
 * in (workload clocked). The reading is transaction_timestamp(), the instant the server began the call's transaction:
 * one value in every statement, row and flight of the call, at or before every snapshot it takes. None for a member
 * that binds none.
 */
export type ClockBinding = Readonly<Record<string, ClockUnit>>

/** The binding of a member that binds no parameter to the clock. */
export const noClock: ClockBinding = Object.freeze({})

/** An int8 type: bigint, or a contract over it, natural among them: the only type a clock reading binds. */
export type Int8Type = Extract<ScalarType, { readonly carrier: "int8" }>

/** Whether a type is an int8's, bigint or a contract over it. */
export const isInt8Type = (t: ScalarType): t is Int8Type => t.carrier === "int8"

/**
 * What a parameter reads when a call binds it: `stated`, a value its caller, an import or a column states; or `clock`, the
 * database's clock in `unit`, the parameter its served member binds to the clock (ClockBinding), whose values are the
 * clock's range (core/clock.ts clockReadingRange) beside its type's.
 */
export type ParamReading =
	| { readonly kind: "stated" }
	| { readonly kind: "clock"; readonly unit: ClockUnit }

/** A parameter's reading as a call stating it binds it. */
export const statedReading: ParamReading = Object.freeze({ kind: "stated" })

/** What `binding` binds the program parameter `name` to: the clock in its unit, or a stated value. */
export const readingOf = (binding: ClockBinding, name: string): ParamReading => {
	const unit = Object.hasOwn(binding, name) ? binding[name] : undefined
	return unit === undefined ? statedReading : { kind: "clock", unit }
}
