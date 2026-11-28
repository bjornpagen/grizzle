import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { unrepresentableKeys, unsupported } from "#compiler/core/errors.ts"
import { captureLoc, childLoc } from "#compiler/core/loc.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import type { CastTargetsBySql } from "#compiler/scalar/compute/registry.ts"
import {
	formOctets,
	formSource,
	type LexicalTarget,
	lexicalTargetOf
} from "#compiler/scalar/lexical.ts"
import { Pattern } from "#compiler/scalar/regex/pattern.ts"
import { describeDeclared } from "#compiler/schema/relation.ts"
import { keyLayout, textBytesBeside } from "#compiler/schema/representability.ts"
import { type RegexText, regexField, str } from "#compiler/text/field.ts"
import type { Field, FieldBase, GeneratedField } from "#compiler/types/fields/field.ts"

/**
 * The lexical form of a field descriptor's type (lexicalForm(T), lexical(T)), a relation's field read as its declared
 * type (schema/relation.ts describeDeclared): its pattern under flags "u" types a lexical field and guards a parse, so a
 * text of the form casts into T total (Type.cast). A contract's form is its base's, which a cast into the contract
 * parses, then enters the contract by its predicate's proof: date's, whose range is the form's own. A type with no form
 * is refused, UnsupportedOperation.
 */
const lexicalTargetOfField = (type: unknown): LexicalTarget => {
	const loc = captureLoc("lexicalForm", [])
	const target = lexicalTargetOf(baseOf(describeDeclared(type, loc).scalar))
	if (target === undefined) {
		throw unsupported(
			loc,
			"lexicalForm of a type with a lexical form: int2, int4 or int8, an exact integer, numeric(p, s) with 0 <= s <= p, float8, bool or date"
		)
	}
	return target
}
export { byteaMaxLength } from "#compiler/scalar/values/fault.ts"
export { flightMaxBytes, messageMaxBytes } from "#compiler/core/wire.ts"
export { maxStringLength } from "#compiler/core/canonical.ts"
export { regexTextMaxBytes } from "#compiler/core/errors.ts"
export { numericTextMaxBytes } from "#compiler/scalar/lexical.ts"
export { regexMaxRepeat } from "@bjornpagen/grizzle-text/regex/parse"
export { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
export { type JoinedHost, type RegexText, str } from "#compiler/text/field.ts"

/** The SQL types a text parses into, those with a lexical form (scalar/lexical.ts): the engine's parses. */
type ParseSql = CastTargetsBySql["text"]

/**
 * lexicalForm(T): the pattern of T's lexical form, XML Schema's lexical space of T's datatype cut to the values T holds
 * exactly, a Pattern for Text.matches to guard a parse with, whose source `str.regex` types a lexical field by
 * (lexical(T)): a text of the form's language, or of a language inside it, casts into T total (Type.cast). A
 * contract's form is its base's, and a relation's field's its declared type's: a drawn natural's is a bigint's.
 */
export const lexicalForm = (type: Field<unknown, ParseSql, unknown>): Pattern =>
	Pattern.ofForm(lexicalTargetOfField(type))
export type { Pattern } from "#compiler/scalar/regex/pattern.ts"
export type { RegexFlagsValidate, RegexInfer, RegexValidate } from "#compiler/types/fields/regex.ts"
export type { RegexFlags } from "@bjornpagen/grizzle-text/regex/parse"

/**
 * float8Text: the Pattern of every decimal text of a double, Text.parseFloat8's operand, under flags "u": a mantissa
 * `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)` of any digits with an optional exponent `[eE][+-]?[0-9]+` of any digits, or `INF`,
 * `-INF` or `NaN`, XML Schema 1.0's xs:double lexical space, which has no `+INF`. A text of its language, or of a
 * language inside it, parses into a double total.
 */
export const float8Text: Pattern = Pattern.ofForm({ kind: "float8Text" })

/**
 * numericText: the Pattern of every decimal text, Text.parseNumeric's operand, under flags "u":
 * `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)` of any digits, the grammar of XML Schema 1.1's xs:decimal lexical space. The parse
 * reads a text of its language within numericTextMaxBytes UTF-8 bytes, 16,384, every one of which names a value plain
 * numeric holds: a text of a language inside it whose bytes its type or a guard bounds within them parses into
 * numeric total, to its exact value.
 */
export const numericText: Pattern = Pattern.ofForm({ kind: "numericText" })

/**
 * lexical(T): the text field of T's lexical form, str.regex over lexicalForm(T), within the form's byte bound where it
 * has one (an exact integer's digits, scalar/lexical.ts formOctets) as str.bytes bounds it: a field of it casts into T
 * total, so `generated(T, Type.cast(row.lexical, T))` is a NOT NULL generated column of the value the text names.
 */
export const lexical = (type: Field<unknown, ParseSql, unknown>): RegexText<string> => {
	const target = lexicalTargetOfField(type)
	const text = regexField<string>(formSource(target), [])
	const octets = formOctets(target)
	return octets === undefined ? text : str.bytes(octets, text)
}

/**
 * keyTextBytes(fields): the most UTF-8 bytes a text can hold as itself beside `fields` in every index grizzle plans over
 * them and the text, whatever their order and whichever of them is a hidden column that may hold NULL (a key over a longer
 * one is refused, UnrepresentableKey; grizzle holds no key column by a digest of its own, docs/limits.md "Keys and indexes"):
 * PostgreSQL's limit on one B-tree entry (BTMaxItemSize) less its header, its null bitmap and what the fields take at
 * their longest, each at its
 * worst alignment padding. `fields` are every other column of the index: a key's other fields, declared or over a
 * selection; for a family axis that carries the text, its group fields, its natural index, its natural successor, the
 * other values it carries and a tree's `end`. A text field whose contract bounds it there,
 * `contract("KeyText", str.regex("^.*$", "su"), (v) => Logic.le(Text.octetLength(v), keyTextBytes(fields)))`, sits in any of
 * them. A field of a relation is read as its declared type (schema/relation.ts describeDeclared), a drawn index or a
 * generated field among them. It throws CompileError (UnrepresentableKey) naming every fault at once: more fields than
 * an index holds beside a text, and each field of no byte bound, such as an unbounded text; or, where neither is, fields
 * that leave a text no byte.
 */
/**
 * keyFits(fields): whether a key over `fields`, in any order, holds every value they admit, each field as itself: its
 * B-tree entry within PostgreSQL's limit (BTMaxItemSize, schema/representability.ts btreeEntryBytes), at most
 * INDEX_MAX_KEYS columns, no bytes field and at most one span, a span key's GiST entry within a GiST page. It is the
 * verdict a relation keyed by them meets (UnrepresentableKey where it is false), as a value, never thrown, so a caller
 * weighs a key's fields before it declares one. A field of a relation is read as its declared type
 * (schema/relation.ts describeDeclared), a drawn index or a generated field among them.
 */
export const keyFits = (fields: ReadonlyArray<FieldBase | GeneratedField<FieldBase>>): boolean => {
	const loc = captureLoc("keyFits", [])
	return keyLayout(
		fields.map((field, i) => ({
			field: `fields[${i}]`,
			desc: describeDeclared(field, childLoc(loc, i)).desc
		}))
	).ok
}

export const keyTextBytes = (
	fields: ReadonlyArray<FieldBase | GeneratedField<FieldBase>>
): number => {
	const loc = captureLoc("keyTextBytes", [])
	const key = fields.map((_, i) => `fields[${i}]`)
	const room = textBytesBeside(
		fields.map((field, i) => ({
			field: `fields[${i}]`,
			desc: describeDeclared(field, childLoc(loc, i)).desc
		}))
	)
	if (!room.ok) {
		throw unrepresentableKeys(
			mapNonEmpty(room.error, (fault) => ({
				at: loc,
				subject: "a key of a text beside the fields",
				key,
				fault
			}))
		)
	}
	return room.value
}
