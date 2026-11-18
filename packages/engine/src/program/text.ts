/**
 * The codec's own text of a value of a field's type, read under no installation (public/text.ts codecText): the one
 * public reading of a host value as text.
 */
import { declaredCodec } from "#compiler/codec/scalar.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type * as Result from "#compiler/core/result.ts"
import { describeFieldOrThrow, type SqlTag } from "#compiler/scalar/registry.ts"
import type { Field, StoredOnlySql } from "#compiler/types/fields/field.ts"

/**
 * codecText(field): the codec's own text of each value of the field's type, as a function, its descriptor read once:
 * `const startText = codecText(Node.fields.start)`, then `startText(row.start)` is the value's one text, the text the
 * codec writes it as (codec/scalar.ts encode, scalar/values/identity.ts canonicalText). Two values of the type have one
 * text exactly when PostgreSQL's equality of the type holds them equal, numeric 1.0 and 1.00 one value, NaN equal to
 * NaN, -0 to +0, a text by its code points, and PostgreSQL's input function of the type reads the text as the value: an
 * integer's decimal digits, a numeric's numeric_out text, a double's shortest round-trip decimal, `true` or `false`, a
 * date's ISO 8601 text, a text itself. A closed id and a set are stored as codes an installation holds, which no schema
 * alone determines (ir/codes.ts), so theirs are the texts of a fresh installation's codes, each handle's code its
 * position in its roster's declared order (codec/scalar.ts declaredCodec), the order rowEvaluator's evaluator ranks
 * them by: one text per value all the same, read under no installation. A closed id's host value, its handle, is its
 * name. A value the codec does not admit, outside its type's range or typmod, is its CodecFault, never a text. A bytes value
 * is stored only and travels as no text, so its field is a type error.
 */
export const codecText = <V>(
	field: Field<V, Exclude<SqlTag, StoredOnlySql>, unknown>
): ((value: V) => Result.Result<string, CodecFault>) => {
	const { scalar } = describeFieldOrThrow(field, captureLoc("codecText", []))
	return declaredCodec(scalar).encode
}
