import type { ScalarType } from "#compiler/ir/scalar.ts"

/**
 * The units a reading of the database's clock counts since the Unix epoch, floored: `micros`, PostgreSQL's own
 * resolution, the exact reading; `millis`, the unit of JavaScript's Date and Effect's DateTime.
 */
export const clockUnits = ["micros", "millis"] as const
export type ClockUnit = (typeof clockUnits)[number]

/** Whether a value is the name of a clock unit (clockUnits). */
export const isClockUnit = (value: unknown): value is ClockUnit =>
	value === "micros" || value === "millis"

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
