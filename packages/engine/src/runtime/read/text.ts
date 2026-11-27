/**
 * The one text of a row a query found (rowTextOf), read off the query's decoder form alone, each column's value's text
 * framed: what the compile's rowText (program/text.ts) and a served login's records (recordedOf) read a row's text by,
 * so a row has one text whether its query's value or its served form is at hand. It loads no compiler: the form and the
 * rosters it names are data.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { handleList, handleText, specText } from "#compiler/codec/scalar.ts"
import {
	type ColumnForm,
	type DecoderForm,
	formFields,
	type FieldForm,
	type OptionVocabulary
} from "#compiler/core/decoder.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import type { Roster } from "#compiler/ir/scalar.ts"
import { conversionSpec } from "#compiler/scalar/values/convert.ts"

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
 * handle (handleText), a set's its handles in its roster's declared order as a list (handleList), a bytes value's
 * its digest, its canonical text, and a variant's its tag's handle and its arm's fields' texts by their own columns, as
 * a list. Each is the column's type's one text of the value, so two values have one text exactly where the type's
 * equality holds them equal.
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
		case "variant": {
			const arms = new Map(
				column.arms.map(
					(arm) =>
						[
							arm.handle,
							arm.fields.map(([name, form]) => [name, columnText(form, rosterOf)] as const)
						] as const
				)
			)
			return (value) => {
				if (!isRecord(value) || typeof value["tag"] !== "string") {
					return Result.err("variantType")
				}
				const fields = arms.get(value["tag"])
				if (fields === undefined) {
					return Result.err("variantTag")
				}
				const texts: Array<string> = [value["tag"]]
				for (const [name, text] of fields) {
					const t = text(value[name])
					if (!t.ok) {
						return t
					}
					texts.push(t.value)
				}
				return Result.ok(framedList(texts))
			}
		}
	}
}

/**
 * A field's value's text: a column's (columnText); an attachment's children's texts as a list, an array's in their
 * order, an Option's none or its one, the one child's alone.
 */
const fieldText = (
	field: FieldForm,
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
							defect("an array attachment's value is its children's list")
						}
						return children(value)
					}
				case "option":
					return (value) => children(options.held(value))
				case "one":
					return (value) => children([value])
			}
		}
	}
}

/**
 * The text of a row of a decoder form's records: its heading's place among the form's headings, then each field's text
 * in the heading's order (fieldText), each one framed, so the text is the row's alone. A row's heading is the one
 * whose keys it holds; a value of no heading's keys is a defect, since the row is one the query's decoder delivered.
 * The one text of a found row: a query's (program/text.ts rowTextOver, over its rows' form and its schema's rosters)
 * and a served records' (packages/grizzle adapter/public/records.ts recordedOf, over the form and the declared rosters
 * its served file carries) alike.
 */
export const rowTextOf = (
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
			defect("a found row is a record")
		}
		const heading = byKeys.get(Object.keys(value).toSorted().join("\n"))
		if (heading === undefined) {
			defect("a found row holds the keys of one of its query's headings")
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
