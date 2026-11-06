import { CompileError } from "#compiler/core/errors.ts"
import { captureLoc, childLoc } from "#compiler/core/loc.ts"
import { lexicalFormOf } from "#compiler/scalar/lexical.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import { textBytesBeside } from "#compiler/schema/representability.ts"
import { type RegexText, regexField } from "#compiler/text/field.ts"
import type { Field, FieldBase } from "#compiler/types/fields/field.ts"

export { type RegexText, str } from "#compiler/text/field.ts"

/** The SQL types a text parses into, those with a lexical form (scalar/lexical.ts). */
type ParseSql =
	| "smallint"
	| "integer"
	| "bigint"
	| "numeric"
	| "double precision"
	| "boolean"
	| "date"

/**
 * lexicalForm(T): the pattern of T's lexical form, XML Schema's lexical space of T's datatype cut to the values T holds
 * exactly, for `str.regex` to type a lexical field by and for Compute.matches to guard a parse with: a text of the
 * form's language, or of a language inside it, casts into T total (Compute.cast). A contract's form is its base's.
 */
export const lexicalForm: (type: Field<unknown, ParseSql, unknown>) => string = lexicalFormOf
export type { RegexFlagsValidate, RegexInfer, RegexValidate } from "#compiler/types/fields/regex.ts"
export type { RegexFlags } from "#compiler/scalar/regex/parse.ts"

/**
 * lexical(T): the text field of T's lexical form, str.regex over lexicalForm(T): a field of it casts into T total, so
 * `generated(T, Compute.cast(row.lexical, T))` is a NOT NULL generated column of the value the text names.
 */
export const lexical = (type: Field<unknown, ParseSql, unknown>): RegexText<string, string, "u"> =>
	regexField<string, string, readonly []>(lexicalFormOf(type), [])

/**
 * keyTextBytes(fields): the most UTF-8 bytes a text can hold beside `fields` in every index grizzle plans over them and
 * the text, whatever their order and whichever of them is a hidden column that may hold NULL: PostgreSQL's limit on one
 * B-tree entry (BTMaxItemSize) less its header, its null bitmap and what the fields take at their longest, each at its
 * worst alignment padding. `fields` are every other column of the index: a key's other fields, declared or over a
 * selection; for a family axis that carries the text, its group fields, its natural index, the other values it carries
 * and a tree's `end`. A text field whose contract bounds it there,
 * `contract("KeyText", str.regex("^.*$", "su"), (v) => Compute.octetLength(v).le(keyTextBytes(fields)))`, sits in any of
 * them. It throws CompileError (UnrepresentableKey) for fields of no byte bound, such as an unbounded text, for more
 * fields than an index holds beside a text, and for fields that leave a text no byte.
 */
export const keyTextBytes = (fields: ReadonlyArray<FieldBase>): number => {
	const loc = captureLoc("keyTextBytes", [])
	const key = fields.map((_, i) => `fields[${i}]`)
	const room = textBytesBeside(
		fields.map((field, i) => ({
			field: `fields[${i}]`,
			desc: describeFieldOrThrow(field, childLoc(loc, i)).desc
		}))
	)
	if (!room.ok) {
		throw CompileError.make({
			_tag: "UnrepresentableKey",
			at: loc,
			subject: "a key of a text beside the fields",
			key,
			fault: room.error
		})
	}
	return room.value
}
