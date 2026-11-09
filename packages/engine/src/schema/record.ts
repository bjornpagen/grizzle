import { maxOf } from "#compiler/core/array.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import {
	type AttachmentLayout,
	type BindContext,
	bytesValueOf,
	type CodeNames,
	type Column,
	type ColumnForm,
	columnForm,
	type Conversion,
	type Decoded,
	type DecoderForm,
	decoderOf,
	type Delivery,
	type FieldForm,
	formHeadings,
	type Layout,
	licenses,
	Named,
	type OptionVocabulary,
	type Part,
	type RecordFieldOf,
	type Row,
	type RowDecoder,
	rowSlot,
	rowText,
	unionColumn
} from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import { converterOf } from "#compiler/scalar/values/convert.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type {
	Carrier,
	Carriers,
	IsOneLiteral,
	Minted,
	Refusal as TypeRefusal,
	Term,
	UnionHeading
} from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { HeadLiteral, HeadShape, HeadTerms, HeadValue } from "#compiler/types/query/terms.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type {
	AnyWorld,
	EntryValue,
	RoleRelations,
	WholeEntries
} from "#compiler/types/schema/world.ts"

/** A name that is one literal: a union of names would claim keys the record does not hold. */
type OneName<N extends string> =
	IsOneLiteral<N> extends true ? unknown : TypeRefusal<"one literal name">

export const named = <const N extends string, X extends RecordFieldOf<unknown>>(
	name: N & OneName<N>,
	field: X
): Named<N, X> => new Named(name, field)

const duplicate = (key: string): CompileError =>
	malformedDescription(
		SourceLoc(`delivered field ${key}`, []),
		"distinct field names across a record's parts"
	)

/** The parts' fields in key order, refused when two parts name one key. */
const fieldsOf = (
	parts: ReadonlyArray<Part>
): ReadonlyArray<readonly [string, RecordFieldOf<unknown>]> => {
	const out: Array<readonly [string, RecordFieldOf<unknown>]> = []
	const seen = new Set<string>()
	for (const part of parts) {
		const entries: ReadonlyArray<readonly [string, RecordFieldOf<unknown>]> =
			part instanceof Named ? [[part.name, part.field]] : Object.entries(part)
		for (const [key, field] of entries) {
			if (seen.has(key)) {
				throw duplicate(key)
			}
			seen.add(key)
			out.push([key, field])
		}
	}
	return out
}

/** A field as a decoder holds it: a column carrier's column (core/decoder.ts columnForm), or the field's own form. */
const fieldForm = (field: RecordFieldOf<unknown>): FieldForm =>
	"column" in field
		? Object.freeze({ kind: "column", column: columnForm(field.column) })
		: field.form

/**
 * The module's one assertion: a record given the type R its caller's construction states (see the header): an
 * assembled record's, or a decoder's records', whose type its builder's phantom states.
 */
const claimed = <R>(record: Readonly<Record<string, unknown>>): R => record as R

/**
 * A frozen null-prototype record holding, under each key of `entries`, its closure's value at `input`, at the type its
 * caller's construction gives it (see the header).
 */
const assembled = <R, I>(
	entries: ReadonlyArray<readonly [string, (input: I) => unknown]>,
	input: I
): R => claimed<R>(assembledRecord(entries, input))

/** A frozen null-prototype record holding, under each key of `entries`, its closure's value at `input`. */
const assembledRecord = <I>(
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
 * Binding a decoder: the interpreter of decoder forms (core/decoder.ts DecoderForm), the one reader of a decoder a
 * builder made and of one a served file carries.
 *
 * A record decoder bound to a layout: the record it reads from one row.
 */
type RecordReader = (row: Row) => Readonly<Record<string, unknown>>

/** A refusal of a layout, thrown inside a binding and caught by bindGroups. */
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
const literalEquality = (conversion: Conversion): ((literal: unknown, host: unknown) => boolean) =>
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
	conversion: Conversion
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

/** The record of one alternatives arm's attachment under `name`: Some of its child, or None. */
const armRecord = (name: string, field: FieldForm): DecoderForm => ({
	kind: "record",
	fields: [[name, field]]
})

/**
 * A decoder form bound to one layout: a record's fields each read by its own reader; a merge's two records as one; a
 * union's arm that owns the largest heading the layout delivers; an alternatives arm's parent record with Some of the
 * child where the parent's field holds the arm's handle, None elsewhere; and a refused decoder's refusal.
 */
const recordReader = (form: DecoderForm, layout: Layout, context: BindContext): RecordReader => {
	switch (form.kind) {
		case "record": {
			const readers = form.fields.map(
				([key, field]) => [key, fieldReader(field, key, layout, context)] as const
			)
			return (row) => assembledRecord(readers, row)
		}
		case "merge": {
			const first = recordReader(form.first, layout, context)
			const second = recordReader(form.second, layout, context)
			return (row) => Object.freeze({ ...first(row), ...second(row) })
		}
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
				? recordReader(form.first, layout, context)
				: recordReader(form.second, layout, context)
		}
		case "arm": {
			const head = recordReader(form.parent, layout, context)
			const some = recordReader(
				armRecord(form.name, { kind: "some", child: form.child }),
				layout,
				context
			)
			const none = recordReader(
				armRecord(form.name, { kind: "none", child: form.child }),
				layout,
				context
			)
			const { field, handle } = form
			return (row) => {
				const parent = head(row)
				return Object.freeze({ ...parent, ...(parent[field] === handle ? some(row) : none(row)) })
			}
		}
		case "refused":
			return refuseLayout(
				"query",
				"a query whose rows the builder can decode: one built with query(S) over sources whose fields it types"
			)
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

/**
 * A decoder bound to every heading group's layout (groupsReader), once per compiled program: each delivered Row read to
 * a record of its builder's type A. A layout that does not hold a field the decoder reads, or an attachment the analysis
 * did not prove in the stated delivery, is the binding's CompileError.
 */
export const bindGroups = <A>(
	decoder: RowDecoder<A>,
	layouts: NonEmptyReadonlyArray<Layout>,
	context: BindContext
): Result.Result<(row: Row) => A, CompileError> =>
	catchRefusal(() => {
		const read = groupsReader(decoder.form, layouts, context)
		return (row: Row): A => claimed<A>(read(row))
	})

/**
 * The one place TypeScript is told a record's type.
 *
 * A record whose type is a homomorphic mapped type over a runtime record, `{ readonly [K in keyof F]: G<F[K]> }`, is
 * beyond what TypeScript can check for a record built key by key, however its keys are iterated: an index write into a
 * generic mapped type is refused, and Object.fromEntries forgets the keys. Every such record grizzle builds is built
 * here, and given its type by the module's one assertion, in `claimed`:
 *
 * - record(...parts): the decoder of delivered records. Each part is a record of fields under their own keys (a
 *   relation's descriptors, a query's head) or one Named field (an attachment, a read-back). A field is a column
 *   carrier, whose value is its column's conversion of the cell under its key (a closed handle's cell is its handle, and
 *   a pattern-refined text's its text, the text itself), or a RecordField, whose value is what it reads. The decoder is
 *   data (core/decoder.ts DecoderForm), and bindGroups reads every row of it into a record holding exactly the parts'
 *   keys, which are distinct, each with its field's value: Decoded<Ps>, its builder's phantom.
 * - mint(fields, make): a record of fresh terms, one per carrier of a heading (a descriptor or a term), each made by
 *   `make` from its carrier, its column and SQL type, which TypeScript checks as a generic function of the column's
 *   host type and the SQL type: Minted<F, Origins> (types/core/phantom.ts), whose origins and domains are phantoms.
 * - headRecord(head, literal): a head as find holds it, each entry under its own key: a JavaScript value as the head
 *   literal `literal` makes of it, which TypeScript checks as a generic function of the value's type, and every other
 *   entry, a term, an aggregate or a producer, itself: HeadTerms<H> (types/query/terms.ts).
 * - sameHeadingRecord(carriers): the records of a union whose two arms deliver one heading key set, through one
 *   statement whose rows no binding tells apart: one record over `carriers`, the union of the arms' carriers, each
 *   column reading either arm's cell by the key's type (unionColumn). Each row is one arm's record,
 *   so its type is A | B.
 *
 * - roleRelations(relations, make): a role's relations (schema/world.ts role), one per entry of its relation record,
 *   each made by `make` from its key and value, which TypeScript checks: the base relation itself for a whole entry,
 *   the world relation of the key for a query entry: RoleRelations<Rs> (types/schema/world.ts).
 * - wholeEntries(relations): a full role's entries (schema/world.ts wholeEntriesOf), every relation of a schema's
 *   record under its own key but the closed relations, each kept or dropped by its kind, as its type keeps or drops it
 *   by its type: WholeEntries<Rs> (types/schema/world.ts).
 *
 * Nothing else asserts a type in the repository; this file's override in oxlint.config.ts allows this one, `claimed`.
 *
 * The decoder of records assembled from `parts` (see the header).
 */
export const record = <const Ps extends ReadonlyArray<Part>>(
	...parts: Ps
): RowDecoder<Decoded<Ps>> =>
	decoderOf(
		Object.freeze({
			kind: "record",
			fields: Object.freeze(fieldsOf(parts).map(([key, field]) => [key, fieldForm(field)] as const))
		})
	)

/**
 * A record of fresh terms over the carriers `fields` (see the header). The origins are the caller's phantom statement of
 * where each term came from.
 */
export const mint = <Origins, const F extends Carriers>(
	fields: F,
	make: <A, S extends SqlTag>(carrier: Carrier<A, S>, key: string) => Term<A, unknown, unknown, S>
): Minted<F, Origins> =>
	assembled<Minted<F, Origins>, undefined>(
		Object.entries(fields).map(([key, carrier]) => [key, () => make(carrier, key)] as const),
		undefined
	)

/** Whether a head entry is a JavaScript value: a string, a number, a bigint, a boolean, a Decimal or a Money. */
const isHeadValue = (entry: unknown) =>
	typeof entry === "string" ||
	typeof entry === "number" ||
	typeof entry === "bigint" ||
	typeof entry === "boolean" ||
	entry instanceof Decimal ||
	entry instanceof Money

/** A head as find holds it (see the header): a JavaScript value made the head literal `literal` gives it. */
export const headRecord = <const H extends HeadShape>(
	head: H,
	literal: <X extends HeadValue>(value: X, key: string) => HeadLiteral<X>
): HeadTerms<H> =>
	assembled<HeadTerms<H>, undefined>(
		Object.entries(head).map(
			([key, entry]) => [key, () => (isHeadValue(entry) ? literal(entry, key) : entry)] as const
		),
		undefined
	)

/** A column as a refusal names it: a closed id's or a set's by its roster, any other by its SQL type. */
const columnText = (carrier: Carrier): string => {
	switch (carrier.column.kind) {
		case "code":
			return `closedId(${carrier.column.roster})`
		case "bits":
			return `bits(${carrier.column.roster})`
		case "convert":
		case "text":
		case "constant":
		case "bytes":
			return carrier.sql
	}
}

/**
 * Whether two arms' columns of one key meet: a set's only a set's of its roster, since no head literal is a set; a
 * bytes column's only a bytes column's, since no head literal is bytes and its cell is no text; a closed id's only a
 * closed id's of its roster, or a head literal, a handle; any other two by their SQL types, which the checker judges.
 */
const columnsMeet = (x: Column<unknown>, y: Column<unknown>): boolean => {
	if (x.kind === "bits" || y.kind === "bits") {
		return x.kind === "bits" && y.kind === "bits" && x.roster === y.roster
	}
	if (x.kind === "bytes" || y.kind === "bytes") {
		return x.kind === "bytes" && y.kind === "bytes"
	}
	if (x.kind === "constant" || y.kind === "constant") {
		return true
	}
	if (x.kind === "code" || y.kind === "code") {
		return x.kind === "code" && y.kind === "code" && x.roster === y.roster
	}
	return true
}

/**
 * The carrier of a key both arms of a union deliver, x in one and y in the other (see the header). Two arms that
 * deliver a closed id or a set against anything but one of the same roster are a caller's union no column reads,
 * refused here, before their columns meet.
 */
const unionCarrier = (key: string, x: Carrier, y: Carrier): Carrier => {
	if (!columnsMeet(x.column, y.column)) {
		throw malformedDescription(
			SourceLoc(`union field ${key}`, []),
			`arms that deliver ${key} at one type; one arm delivers ${columnText(x)}, the other ${columnText(y)}`
		)
	}
	return Object.freeze({
		column: unionColumn(x.column, y.column),
		sql: x.column.kind === "constant" && y.column.kind !== "constant" ? y.sql : x.sql
	})
}

/**
 * The heading of a union of two arms' headings (see the header): a's keys in order, each united with b's carrier where
 * b delivers it too, then the keys b alone delivers.
 */
export const carrierUnion = <A extends Carriers, B extends Carriers>(
	a: A,
	b: B
): UnionHeading<A, B> =>
	assembled<UnionHeading<A, B>, undefined>(
		[
			...Object.entries(a).map(([key, x]) => {
				const y = b[key]
				return [key, () => (y === undefined ? x : unionCarrier(key, x, y))] as const
			}),
			...Object.entries(b).flatMap(([key, y]) =>
				a[key] === undefined ? [[key, () => y] as const] : []
			)
		],
		undefined
	)

/**
 * The records of a union of two arms of records A and B, each decoded over its carriers, whose carriers are one key set
 * (see the header): one record over `carriers`, their union. The arms' row types are the caller's statement, as mint's
 * origins are.
 */
export const sameHeadingRecord = <A, B>(carriers: Carriers): RowDecoder<A | B> =>
	decoderOf(
		Object.freeze({
			kind: "record",
			fields: Object.freeze(
				Object.entries(carriers).map(
					([key, c]) =>
						[key, Object.freeze({ kind: "column", column: columnForm(c.column) })] as const
				)
			)
		})
	)

/** A role's relations (see the header). */
export const roleRelations = <const Rs extends Readonly<Record<string, EntryValue>>>(
	relations: Rs,
	make: (key: string, value: EntryValue) => AnyRelation | AnyClosed | AnyDerived | AnyWorld
): RoleRelations<Rs> =>
	assembled<RoleRelations<Rs>, undefined>(
		Object.entries(relations).map(([key, value]) => [key, () => make(key, value)] as const),
		undefined
	)

/** A full role's entries over a schema's record of relations (see the header). */
export const wholeEntries = <const Rs extends AnySchema["relations"]>(
	relations: Rs
): WholeEntries<Rs> =>
	assembled<WholeEntries<Rs>, undefined>(
		Object.entries(relations).flatMap(([key, relation]) =>
			relation.kind === "closedRelation" ||
			(relation.kind === "derived" && relation.storage === "live")
				? []
				: [[key, () => relation] as const]
		),
		undefined
	)

/**
 * The public heading of a described query or arm (query/build QueryCarriers): no key carries a column, so v over it
 * mints untyped terms. Only the JavaScript view, whose carriers type is the wide Carriers, makes one.
 */
export const describedHeading = <C extends Carriers>(): C => assembled<C, undefined>([], undefined)
