/**
 * The one text of a value of a field's type, a function of its host value alone (codecText, the shell's, packages/grizzle
 * adapter/public/host.ts): the one public reading of a host value as text.
 */
import type { Result as Public } from "effect"
import { hostText } from "#compiler/codec/scalar.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type { PublicResult } from "#compiler/core/public-result.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import { describeDeclared } from "#compiler/schema/relation.ts"
import type { Field, GeneratedField, StoredOnlySql } from "#compiler/types/fields/field.ts"

/** The SQL types of a field with a text: every one but those of storage alone (StoredOnlySql). */
type TextSql = Exclude<SqlTag, StoredOnlySql>

/**
 * A field whose values have a text, of host type V: a descriptor a builder made (a caller's field; a drawn,
 * accumulated, retirement or slot field, each one), or a generated field, which carries its declared type's column
 * and no builder's brand. A bytes field is stored only and has none.
 */
export type TextedField<V> = Field<V, TextSql, unknown> | GeneratedField<Field<V, TextSql, unknown>>

/**
 * codecText(field), the shell's, over `answer`, its spelling of a caller's Result: the one text of each value of the
 * field's type, a function of the value alone, its descriptor read once: `const startText = codecText(Node.fields.start)`, then `startText(row.start)` is the value's text (codec/scalar.ts
 * hostText). The field is any field of a relation: a caller's is its own descriptor, and a drawn, accumulated,
 * retirement, generated or slot field reads its declared type's, the one its column is stored and read with
 * (schema/relation.ts describeDeclared), so a drawn natural's text is its integer's. Two values of the type have
 * one text exactly when PostgreSQL's equality of the type holds them equal, numeric 1.0 and 1.00 one value, NaN equal
 * to NaN, -0 to +0, a text by its code points. A closed id's text is its handle, its host value, and a set's its
 * handles in its roster's declared order as a JSON array: a code is a storage detail of one installation, which no text
 * reads, so a text is the same in every installation. Every other carrier's is the codec's own, which PostgreSQL's
 * input function of the type reads as the value: an integer's decimal digits, a numeric's numeric_out text, a double's
 * shortest round-trip decimal, `true` or `false`, a date's ISO 8601 text, a text itself. A value the codec does not
 * admit, outside its type's range, typmod or roster, is its CodecFault, never a text. A bytes value is stored only and
 * travels as no text, so its field is a type error.
 */
export const codecTextOver = <V>(
	field: TextedField<V>,
	answer: PublicResult
): ((value: V) => Public.Result<string, CodecFault>) => {
	const { scalar } = describeDeclared(field, captureLoc("codecText", []))
	const text = hostText(scalar)
	return (value) => answer(text(value))
}
