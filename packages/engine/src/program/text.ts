/**
 * The one text of a value of a field's type, a function of its host value alone (codecText, the shell's, packages/grizzle
 * adapter/public/host.ts): the one public reading of a host value as text; and the one text of a row a query found,
 * each column's value's text so, framed (rowText, the shell's).
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Result as Public } from "effect"
import { handleText, hostText, handleList, specText } from "#compiler/codec/scalar.ts"
import {
	type ColumnForm,
	type DecoderForm,
	formFields,
	type FormField,
	type OptionVocabulary
} from "#compiler/core/decoder.ts"
import { type CodecFault, type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { PublicResult } from "#compiler/core/public-result.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import type { Roster } from "#compiler/ir/scalar.ts"
import { queryState } from "#compiler/query/build/state.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import { conversionSpec } from "#compiler/scalar/values/convert.ts"
import { describeDeclared } from "#compiler/schema/relation.ts"
import type { Field, GeneratedField, StoredOnlySql } from "#compiler/types/fields/field.ts"
import type { Decoders, HeadOf } from "#compiler/types/query/query.ts"

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

/** A text, framed: its length in UTF-16 code units, a colon, then the text, so a reader tells where it ends. */
const framed = (text: string): string => `${text.length}:${text}`

/** Texts, framed as a list: their count, a colon, then each framed, so a list and its members are told apart. */
const framedList = (texts: ReadonlyArray<string>): string =>
	`${texts.length}:${texts.map(framed).join("")}`

/** The text of a found row's value, or its CodecFault: a value its column's type does not admit. */
type ValueText = (value: unknown) => Result.Result<string, CodecFault>

/** Each value's text by `text`, framed as a list, or the first CodecFault. */
const listText =
	(text: ValueText) =>
	(values: ReadonlyArray<unknown>): Result.Result<string, CodecFault> => {
		const texts: Array<string> = []
		for (const value of values) {
			const t = text(value)
			if (!t.ok) {
				return t
			}
			texts.push(t.value)
		}
		return Result.ok(framedList(texts))
	}

/**
 * A column's value's text by its form (core/decoder.ts ColumnForm), framed: a converted column's and head literals'
 * its conversion's carrier's one text (codec/scalar.ts specText), a refined text's the text itself, a closed id's its
 * handle (handleText), a set's its handles in its roster's declared order as a list (handleList), and a bytes value's
 * its digest, its canonical text. Each is the column's type's one text of the value, so two values have one text
 * exactly where the type's equality holds them equal.
 */
const columnText = (column: ColumnForm, rosterOf: (name: string) => Roster): ValueText => {
	switch (column.kind) {
		case "convert":
		case "constant": {
			const text = specText(conversionSpec(column.conversion))
			return (value) => Result.map(text(value), framed)
		}
		case "text": {
			const text = specText({ carrier: "text" })
			return (value) => Result.map(text(value), framed)
		}
		case "bytes": {
			const text = specText({ carrier: "bytes" })
			return (value) => Result.map(text(value), framed)
		}
		case "code": {
			const text = handleText(rosterOf(column.roster), undefined)
			return (value) => Result.map(text(value), framed)
		}
		case "bits": {
			const handles = handleList(rosterOf(column.roster))
			return (value) => Result.map(handles(value), framedList)
		}
	}
}

/**
 * A field's value's text: a column's (columnText); an attachment's children's texts as a list, an array's in their
 * order, an Option's none or its one, the one child's alone; an alternatives arm's, an Option, its none or its one.
 */
const fieldText = (
	field: FormField,
	rosterOf: (name: string) => Roster,
	options: OptionVocabulary
): ValueText => {
	switch (field.kind) {
		case "column":
			return columnText(field.column, rosterOf)
		case "attachment": {
			const children = listText(rowTextOf(field.child, rosterOf, options))
			switch (field.delivery) {
				case "array":
					return (value) => {
						if (!isList(value)) {
							throw defect("an array attachment's value is its children's list")
						}
						return children(value)
					}
				case "option":
					return (value) => children(options.held(value))
				case "one":
					return (value) => children([value])
			}
		}
		case "some":
		case "none":
		case "arm": {
			const children = listText(rowTextOf(field.child, rosterOf, options))
			return (value) => children(options.held(value))
		}
	}
}

/**
 * The text of a row of a decoder form's records: its heading's place among the form's headings, then each field's text
 * in the heading's order (fieldText), each one framed, so the text is the row's alone. A row's heading is the one
 * whose keys it holds; a value of no heading's keys is a defect, since the row is one the query's decoder delivered.
 */
const rowTextOf = (
	form: DecoderForm,
	rosterOf: (name: string) => Roster,
	options: OptionVocabulary
): ValueText => {
	const headings = formFields(form).map((fields, place) => ({
		place,
		keys: fields
			.map(([key]) => key)
			.toSorted()
			.join("\n"),
		fields: fields.map(([key, field]) => [key, fieldText(field, rosterOf, options)] as const)
	}))
	const byKeys = new Map(headings.map((heading) => [heading.keys, heading] as const))
	return (value) => {
		if (!isRecord(value)) {
			throw defect("a found row is a record")
		}
		const heading = byKeys.get(Object.keys(value).toSorted().join("\n"))
		if (heading === undefined) {
			throw defect("a found row holds the keys of one of its query's headings")
		}
		let text = `${heading.place}:`
		for (const [key, read] of heading.fields) {
			const t = read(value[key])
			if (!t.ok) {
				return t
			}
			text += t.value
		}
		return Result.ok(text)
	}
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
