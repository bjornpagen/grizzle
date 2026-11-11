import { maxOf } from "#compiler/core/array.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import {
	type AttachmentLayout,
	type BindContext,
	bytesValueOf,
	type CellConversion,
	type CodeNames,
	type ColumnForm,
	type DecoderForm,
	type Delivery,
	type FieldForm,
	formHeadings,
	type Layout,
	licenses,
	type OptionVocabulary,
	type Row,
	rowSlot,
	rowText
} from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import { converterOf } from "#compiler/scalar/values/convert.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"

/**
 * Binding a decoder: the interpreter of decoder forms (core/decoder.ts DecoderForm), the one reader of a decoder a
 * builder made and of one a served file carries.
 *
 * A record decoder bound to a layout: the record it reads from one row.
 */
type RecordReader = (row: Row) => Readonly<Record<string, unknown>>

/** A refusal of a layout, thrown inside a binding and caught by recordsReader. */
const refuseLayout = (key: string, what: string): never => {
	throw new Refusal(malformedDescription(SourceLoc(`delivered field ${key}`, []), what))
}

/** A column's position in a layout, refused when the layout does not deliver it. */
const columnAt = (layout: Layout, key: string): number =>
	layout.columns.get(key) ?? refuseLayout(key, "a column of the statement that delivers the record")

/** An attachment's slot in a layout, refused when the layout does not deliver it. */
const attachmentAt = (layout: Layout, key: string): AttachmentLayout =>
	layout.attachments.get(key) ?? refuseLayout(key, "an attachment of the statement's layout")

/** The text at a position of its layout, which bound the reader. */
const cellAt = (row: Row, position: number): OutputText => rowText(row.cells, position)

/** The bytes value at a position of its layout, which bound the reader (core/decoder.ts bytesValueOf). */
const bytesAt = (row: Row, position: number): Uint8Array<ArrayBuffer> =>
	bytesValueOf(rowSlot(row.cells, position))

const samePrimitive = (literal: unknown, host: unknown): boolean => literal === host

const sameDecimal = (literal: unknown, host: unknown): boolean =>
	literal instanceof Decimal && host instanceof Decimal && literal.equals(host)

const sameMoney = (literal: unknown, host: unknown): boolean =>
	literal instanceof Money && host instanceof Money && literal.equals(host)

/**
 * The equality of host values under a head literal's conversion: a Decimal's and a Money's `equals`, every other
 * literal's `===` (a string, a number, a bigint or a boolean).
 */
const literalEquality = (
	conversion: CellConversion
): ((literal: unknown, host: unknown) => boolean) =>
	conversion.carrier === "numeric"
		? sameDecimal
		: conversion.carrier === "money"
			? sameMoney
			: samePrimitive

/**
 * The literal a cell of head literals' column is: the one its text converts to. The one site of the fact that such a
 * cell is one of the literals: the statement writes only those literals in that column, a runtime set no type of a text
 * carries.
 */
const constantOf = (
	values: NonEmptyReadonlyArray<unknown>,
	conversion: CellConversion
): ((text: OutputText) => unknown) => {
	const convert = converterOf(conversion)
	const equal = literalEquality(conversion)
	return (text) => {
		const host = convert(text)
		for (const value of values) {
			if (equal(value, host)) {
				return value
			}
		}
		throw defect("a cell of head literals' column converts to one of them")
	}
}

/**
 * A text cell's conversion under its column: its conversion, the head literal it converts to, the text itself for a
 * refined text, the handle the installation's names give a closed id's code, and a fresh set of the handles a bit
 * string's 1 bits name, position i code i. A bytes column has no text conversion: its cell is its value (`fieldReader`).
 */
const cellConversion = (
	column: Exclude<ColumnForm, { readonly kind: "bytes" }>,
	names: CodeNames
): ((text: OutputText) => unknown) => {
	switch (column.kind) {
		case "convert":
			return converterOf(column.conversion)
		case "constant":
			return constantOf(column.values, column.conversion)
		case "text":
			return (text) => text
		case "code": {
			const handles = names(column.roster)
			return (text) => handles[Number(text)]
		}
		case "bits": {
			const handles = names(column.roster)
			return (text) => {
				const members = new Set<string>()
				for (let code = 0; code < text.length; code++) {
					const handle = handles[code]
					if (text[code] === "1" && handle !== undefined) {
						members.add(handle)
					}
				}
				return members
			}
		}
	}
}

/**
 * The children of one row under an attachment the analysis proves delivers at most one, held to that proof: a second
 * child is a state the proof excludes, so it is a defect naming the attachment `key`, never a first of several taken
 * silently. A row count is the database's state, which no type carries, so this is the one site of the fact that a row
 * holds at most the one child its law allows.
 */
const atMostOne = <A>(key: string, children: ReadonlyArray<A>): ReadonlyArray<A> => {
	if (children.length > 1) {
		throw defect(
			`a row holds at most one child under the attachment ${key}, which the analysis proves delivers at most one`
		)
	}
	return children
}

/**
 * The child a row holds under the attachment `key`, which a law proves it holds exactly once: one the analysis proves
 * delivers exactly one (a containment into the child's key, enforced at commit), or an alternatives arm's on a row whose
 * handle selects the arm (the alternatives family law). The one site of the fact that the database holds the laws its
 * proofs rest on, so the row has its child and no other (atMostOne): no child, or a second, is a defect naming the
 * attachment.
 */
const provenChild = <A>(key: string, children: ReadonlyArray<A>): A => {
	const [child] = atMostOne(key, children)
	if (child === undefined) {
		throw defect(`a row holds the child the attachment ${key} proves it holds`)
	}
	return child
}

/** A delivery's reading of the children of one row under the attachment `key`. */
const delivered = (
	key: string,
	delivery: Delivery,
	options: OptionVocabulary
): ((children: ReadonlyArray<unknown>) => unknown) => {
	switch (delivery) {
		case "array":
			return (children) => children
		case "option":
			return (children) => {
				const held = atMostOne(key, children)
				return isNonEmpty(held) ? options.some(held[0]) : options.none
			}
		case "one":
			return (children) => provenChild(key, children)
	}
}

/** The children of one row under the attachment at `slot`, each read by `read`. */
const childrenAt = <A>(row: Row, slot: number, read: (row: Row) => A): ReadonlyArray<A> =>
	rowSlot(row.children, slot).map(read)

/** The children of one row under an alternatives arm's attachment, which the analysis licenses as "option". */
const optionChildren = (
	child: DecoderForm,
	layout: Layout,
	key: string,
	context: BindContext
): ((row: Row) => ReadonlyArray<Readonly<Record<string, unknown>>>) => {
	const at = attachmentAt(layout, key)
	if (!licenses(at.proved, "option")) {
		refuseLayout(
			key,
			`an alternatives arm the analysis proves at most one child of; it proves ${at.proved}`
		)
	}
	const read = groupsReader(child, at.layouts, context)
	const { slot } = at
	return (row) => childrenAt(row, slot, read)
}

/** A field's reader under `key` in `layout`. */
const fieldReader = (
	field: FieldForm,
	key: string,
	layout: Layout,
	context: BindContext
): ((row: Row) => unknown) => {
	switch (field.kind) {
		case "column": {
			const column = field.column
			const position = columnAt(layout, key)
			if (column.kind === "bytes") {
				return (row) => bytesAt(row, position)
			}
			const convert = cellConversion(column, context.names)
			return (row) => convert(cellAt(row, position))
		}
		case "attachment": {
			const at = attachmentAt(layout, key)
			if (!licenses(at.proved, field.delivery)) {
				refuseLayout(
					key,
					`an attachment the analysis proves to deliver as ${field.delivery}; it proves ${at.proved}`
				)
			}
			const read = groupsReader(field.child, at.layouts, context)
			const deliver = delivered(key, field.delivery, context.options)
			const { slot } = at
			return (row) => deliver(Object.freeze(childrenAt(row, slot, read)))
		}
		case "some": {
			const children = optionChildren(field.child, layout, key, context)
			return (row) => context.options.some(provenChild(key, children(row)))
		}
		case "none": {
			const children = optionChildren(field.child, layout, key, context)
			return (row) => {
				if (isNonEmpty(children(row))) {
					throw defect(
						`a row holds no child under the attachment ${key} of an alternatives arm its handle does not select`
					)
				}
				return context.options.none
			}
		}
	}
}

/** The size of the largest of `headings` whose keys the layout delivers, or undefined when it delivers none of them. */
const largestIn = (
	headings: ReadonlyArray<ReadonlyArray<string>>,
	names: ReadonlySet<string>
): number | undefined => {
	const delivering = headings.filter((heading) => heading.every((key) => names.has(key)))
	return delivering.length === 0
		? undefined
		: maxOf(
				delivering.map((heading) => heading.length),
				0
			)
}

/** Whether a size the layout delivers beats another, where an undelivered one beats nothing. */
const larger = (x: number | undefined, y: number | undefined): boolean =>
	x !== undefined && (y === undefined || x > y)

/** One write of a row's value into the record the row fills, under the key its field reads. */
type Fill = (record: Record<string, unknown>, row: Row) => void

/** The write of `read`'s value of a row under `key`. */
const fillOf =
	(key: string, read: (row: Row) => unknown): Fill =>
	(record, row) => {
		record[key] = read(row)
	}

/**
 * A decoder form bound to one layout, flattened into the writes that fill one record of a row, in order: a record's
 * fields, each read by its own reader; a merge's first record's writes, then its second's; the writes of a union's arm
 * that owns the largest heading the layout delivers; an alternatives arm's parent's writes, then its own field, Some of
 * the child where the field the parent wrote holds the arm's handle, None elsewhere; and a refused decoder's refusal.
 * Every write lands in the one record, so no row builds a record per part or copies one into another.
 */
const fillsOf = (form: DecoderForm, layout: Layout, context: BindContext): ReadonlyArray<Fill> => {
	switch (form.kind) {
		case "record":
			return form.fields.map(([key, field]) =>
				fillOf(key, fieldReader(field, key, layout, context))
			)
		case "merge":
			return [...fillsOf(form.first, layout, context), ...fillsOf(form.second, layout, context)]
		case "oneOf": {
			const names = new Set([...layout.columns.keys(), ...layout.attachments.keys()])
			const inFirst = largestIn(formHeadings(form.first), names)
			const inSecond = largestIn(formHeadings(form.second), names)
			if (inFirst === undefined && inSecond === undefined) {
				return refuseLayout(
					[...names].join(", "),
					"a union arm whose keys are among the statement's columns"
				)
			}
			return larger(inFirst, inSecond)
				? fillsOf(form.first, layout, context)
				: fillsOf(form.second, layout, context)
		}
		case "arm": {
			const { name, field, handle, child } = form
			const some = fieldReader({ kind: "some", child }, name, layout, context)
			const none = fieldReader({ kind: "none", child }, name, layout, context)
			const arm: Fill = (record, row) => {
				record[name] = record[field] === handle ? some(row) : none(row)
			}
			return [...fillsOf(form.parent, layout, context), arm]
		}
		case "refused":
			return refuseLayout(
				"query",
				"a query whose rows the builder can decode: one built with query(S) over sources whose fields it types"
			)
	}
}

/** A decoder form bound to one layout: one frozen null-prototype record per row, filled by the form's writes. */
const recordReader = (form: DecoderForm, layout: Layout, context: BindContext): RecordReader => {
	const fills = fillsOf(form, layout, context)
	return (row) => {
		const record: Record<string, unknown> = { __proto__: null }
		for (const fill of fills) {
			fill(record, row)
		}
		return Object.freeze(record)
	}
}

/**
 * A decoder form bound to every heading group's layout: each row is read by its own group's binding. A decoder of one
 * heading binds one layout, and its rows are read by that binding whatever their group.
 */
const groupsReader = (
	form: DecoderForm,
	layouts: NonEmptyReadonlyArray<Layout>,
	context: BindContext
): RecordReader => {
	const [first, ...rest] = layouts
	if (rest.length === 0) {
		return recordReader(form, first, context)
	}
	const readers = layouts.map((layout) => recordReader(form, layout, context))
	return (row) => rowSlot(readers, row.group)(row)
}

/** A frozen null-prototype record holding, under each key of `entries`, its closure's value at `input`. */
export const assembledRecord = <I>(
	entries: ReadonlyArray<readonly [string, (input: I) => unknown]>,
	input: I
): Readonly<Record<string, unknown>> => {
	const out: Record<string, unknown> = { __proto__: null }
	for (const [key, valueAt] of entries) {
		out[key] = valueAt(input)
	}
	return Object.freeze(out)
}

/**
 * A decoder form bound to every heading group's layout (groupsReader), once per program: each delivered Row read to its
 * record. A layout that does not hold a field the form reads, or an attachment the analysis did not prove in the stated
 * delivery, is the binding's CompileError.
 */
export const recordsReader = (
	form: DecoderForm,
	layouts: NonEmptyReadonlyArray<Layout>,
	context: BindContext
): Result.Result<RecordReader, CompileError> =>
	catchRefusal(() => groupsReader(form, layouts, context))
