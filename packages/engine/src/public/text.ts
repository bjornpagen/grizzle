import { CompileError } from "#compiler/core/errors.ts"
import { captureLoc, childLoc } from "#compiler/core/loc.ts"
import { formSource, lexicalTargetOfField } from "#compiler/scalar/lexical.ts"
import { Pattern } from "#compiler/scalar/regex/pattern.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import { textBytesBeside } from "#compiler/schema/representability.ts"
import { type RegexText, regexField } from "#compiler/text/field.ts"
import type { Field, FieldBase } from "#compiler/types/fields/field.ts"

export {
	bytesMaxLength,
	flightMaxBytes,
	type Limit,
	maxStringLength,
	messageMaxBytes
} from "#compiler/core/limits.ts"
export { decimalTextMaxBytes } from "#compiler/scalar/lexical.ts"
export { type JoinedHost, type RegexText, str } from "#compiler/text/field.ts"

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
 * exactly, a Pattern for Compute.matches to guard a parse with, whose source `str.regex` types a lexical field by
 * (lexical(T)): a text of the form's language, or of a language inside it, casts into T total (Compute.cast). A
 * contract's form is its base's.
 */
export const lexicalForm = (type: Field<unknown, ParseSql, unknown>): Pattern =>
	Pattern.ofForm(lexicalTargetOfField(type))
export type { Pattern } from "#compiler/scalar/regex/pattern.ts"
export type { RegexFlagsValidate, RegexInfer, RegexValidate } from "#compiler/types/fields/regex.ts"
export type { RegexFlags } from "#compiler/scalar/regex/parse.ts"

/**
 * doubleText: the Pattern of every decimal text of a double, Compute.parseDouble's operand, under flags "u": a mantissa
 * `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)` of any digits with an optional exponent `[eE][+-]?[0-9]+` of any digits, or `INF`,
 * `+INF`, `-INF` or `NaN`, the grammar of XML Schema 1.1's xs:double lexical space. A text of its language, or of a
 * language inside it, parses into a double total.
 */
export const doubleText: Pattern = Pattern.ofForm({ kind: "doubleText" })

/**
 * decimalText: the Pattern of every decimal text, Compute.parseDecimal's operand, under flags "u":
 * `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)` of any digits, the grammar of XML Schema 1.1's xs:decimal lexical space. The parse
 * reads a text of its language within decimalTextMaxBytes UTF-8 bytes, 16,384, every one of which names a value plain
 * numeric holds: a text of a language inside it whose bytes its type or a guard bounds within them parses into
 * numeric total, to its exact value.
 */
export const decimalText: Pattern = Pattern.ofForm({ kind: "decimalText" })

/**
 * lexical(T): the text field of T's lexical form, str.regex over lexicalForm(T): a field of it casts into T total, so
 * `generated(T, Compute.cast(row.lexical, T))` is a NOT NULL generated column of the value the text names.
 */
export const lexical = (type: Field<unknown, ParseSql, unknown>): RegexText<string> =>
	regexField<string>(formSource(lexicalTargetOfField(type)), [])

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
