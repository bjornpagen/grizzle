/**
 * The one text of a value of a field's type, a function of its host value alone (codecText, the shell's, packages/grizzle
 * adapter/public/host.ts): the one public reading of a host value as text; and the one text of a row a query found,
 * each column's value's text so, framed (rowText, the shell's).
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Result as Public } from "effect"
import { hostText } from "#compiler/codec/scalar.ts"
import { formFields, type OptionVocabulary } from "#compiler/core/decoder.ts"
import { type CodecFault, type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { PublicResult } from "#compiler/core/public-result.ts"
import type { Roster } from "#compiler/ir/scalar.ts"
import { queryState } from "#compiler/query/build/state.ts"
import { rowTextOf } from "#compiler/runtime/read/text.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import { describeDeclared } from "#compiler/schema/relation.ts"
import type { Field, GeneratedField, StoredOnlySql } from "#compiler/types/fields/field.ts"
import type { Decoders, HeadOf } from "#compiler/types/query/query.ts"

/** The SQL types of a field with a text: every one but those of storage alone (StoredOnlySql). */
type TextSql = Exclude<SqlTag, StoredOnlySql>

/**
 * A field whose values have a text, of host type V: a descriptor a builder made (a caller's field; a drawn,
 * accumulated or slot field, each one), or a generated field, which carries its declared type's column
 * and no builder's brand. A bytes field is stored only and has none.
 */
export type TextedField<V> = Field<V, TextSql, unknown> | GeneratedField<Field<V, TextSql, unknown>>

/**
 * codecText(field), the shell's, over `answer`, its spelling of a caller's Result: the one text of each value of the
 * field's type, a function of the value alone, its descriptor read once: `const startText = codecText(Node.fields.start)`, then `startText(row.start)` is the value's text (codec/scalar.ts
 * hostText). The field is any field of a relation: a caller's is its own descriptor, and a drawn, accumulated,
 * generated or slot field reads its declared type's, the one its column is stored and read with
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

/**
 * rowText(query), the shell's, over `answer`, its spelling of a caller's Result, and `options`, its reading of an Option:
 * the one text of each row the query delivers, its query's decoder form read once, as a Result whose error is the
 * CompileError of a query no builder can decode (one rebuilt from its Description). The text is the row's heading's
 * place among the query's, then each field's value's text in the heading's order: a column's its type's one text
 * (codecText's: a closed id's handle, every other carrier's codec's canonical text, a bytes value's digest), a set's
 * its handles in declared order, an attachment's children's texts in delivered order, an Option's none or one; each
 * framed by its length, a list by its count, so no text is two rows' and no JSON frames it. Two rows have one text
 * exactly where each of their values is equal under its type's equality and their attachments are, member by member,
 * in order. A value its type does not admit is its CodecFault.
 */
export const rowTextOver = <Q extends Decoders<unknown, unknown>>(
	query: Q,
	answer: PublicResult,
	options: OptionVocabulary
): Result.Result<(row: HeadOf<Q>) => Public.Result<string, CodecFault>, CompileError> => {
	const state = queryState(query)
	const form = query.rows.form
	if (state === undefined || !isNonEmpty(formFields(form))) {
		return Result.err(
			malformedDescription(
				SourceLoc("rowText", []),
				"a query whose rows the builder can decode: one built with query(S) over sources whose fields it types"
			)
		)
	}
	const rosters = new Map<string, Roster>()
	const rosterOf = (name: string): Roster => {
		const known = rosters.get(name)
		if (known !== undefined) {
			return known
		}
		const declared = parseDeclaredName(name)
		const roster = declared.ok ? state.schema.env.roster(declared.value) : undefined
		if (roster === undefined) {
			throw defect(`a column's roster ${name} is one its query's schema declares`)
		}
		rosters.set(name, roster)
		return roster
	}
	const text = rowTextOf(form, rosterOf, options)
	return Result.ok((row) => answer(text(row)))
}
