import type { Expr } from "#compiler/sql/ast.ts"
import { call, cast, lit, types } from "#compiler/sql/build.ts"

/** A run of a text's characters, from `start`, 1-based as substring counts, `length` of them. */
export interface TextSlice {
	readonly start: number
	readonly length: number
}

/** One part of a date text, its digits read by int4in: substring(text, start, length)::integer. */
const datePart = (text: Expr, slice: TextSlice): Expr =>
	cast(
		call("substring", [
			text,
			lit.int(slice.start, types.integer),
			lit.int(slice.length, types.integer)
		]),
		types.integer
	)

/**
 * The date a member of the date form names (scalar/lexical.ts), its year, month and day at `parts` (ir/date.ts
 * datePartSlices): make_date over the three, each the integer int4in reads from its digits. Every part is IMMUTABLE, as
 * a generated column and an index require: substring is text_substr, the casts are I/O conversions through textout and
 * int4in, and make_date is IMMUTABLE, where date_in, which `text::date` calls, is STABLE because it reads DateStyle and
 * the clock (now, today). The form proves the year 0001 to 9999 and a day its month has, so make_date never raises.
 */
export const dateOfText = (
	text: Expr,
	parts: { readonly year: TextSlice; readonly month: TextSlice; readonly day: TextSlice }
): Expr =>
	call("make_date", [
		datePart(text, parts.year),
		datePart(text, parts.month),
		datePart(text, parts.day)
	])
