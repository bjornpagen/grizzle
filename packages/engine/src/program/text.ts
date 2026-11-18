/**
 * The one text of a value of a field's type, a function of its host value alone (public/text.ts codecText): the one
 * public reading of a host value as text.
 */
import { hostText } from "#compiler/codec/scalar.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type * as Result from "#compiler/core/result.ts"
import { describeFieldOrThrow, type SqlTag } from "#compiler/scalar/registry.ts"
import type { Field, StoredOnlySql } from "#compiler/types/fields/field.ts"

/**
 * codecText(field): the one text of each value of the field's type, a function of the value alone, its descriptor read
 * once: `const startText = codecText(Node.fields.start)`, then `startText(row.start)` is the value's text (codec/scalar.ts
 * hostText). Two values of the type have one text exactly when PostgreSQL's equality of the type holds them equal,
 * numeric 1.0 and 1.00 one value, NaN equal to NaN, -0 to +0, a text by its code points. A closed id's text is its
 * handle, its host value, and a set's its handles in its roster's declared order as a JSON array: a code is a storage
 * detail of one installation, which no text reads, so a text is the same in every installation. Every other carrier's
 * is the codec's own, which PostgreSQL's input function of the type reads as the value: an integer's decimal digits, a
 * numeric's numeric_out text, a double's shortest round-trip decimal, `true` or `false`, a date's ISO 8601 text, a text
 * itself. A value the codec does not admit, outside its type's range, typmod or roster, is its CodecFault, never a text.
 * A bytes value is stored only and travels as no text, so its field is a type error.
 */
export const codecText = <V>(
	field: Field<V, Exclude<SqlTag, StoredOnlySql>, unknown>
): ((value: V) => Result.Result<string, CodecFault>) => {
	const { scalar } = describeFieldOrThrow(field, captureLoc("codecText", []))
	return hostText(scalar)
}
