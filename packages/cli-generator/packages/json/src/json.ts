import { Formatter } from "effect"

/**
 * A JSON value (RFC 8259): what JSON text spells, and nothing it cannot. An object member that may
 * be absent is optional, never `undefined`, so a value of this type always has exactly one text.
 */
export type Json =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<Json>
	| { readonly [member: string]: Json }

/**
 * The one door every JSON text written from our own value goes through, total because the value's
 * type is JSON: exactly `JSON.stringify`'s text, compact, each object's members in the value's own
 * order.
 */
export const jsonTextOf = (value: Json): string => Formatter.formatJson(value)
