import { lexicalFormOf } from "#compiler/scalar/lexical.ts"
import { type RegexText, regexField } from "#compiler/text/field.ts"
import type { Field } from "#compiler/types/fields/field.ts"

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
