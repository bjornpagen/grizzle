import {
	type BindContext,
	type Column,
	columnForm,
	type Decoded,
	decoderOf,
	type FieldForm,
	type Layout,
	Named,
	type Part,
	type RecordFieldOf,
	type Row,
	type RowDecoder,
	unionColumn
} from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { assembledRecord, recordsReader } from "#compiler/runtime/read/record.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
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
import type { AnySchema, Declared, DeclaredOver } from "#compiler/types/schema/schema.ts"
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
	Result.map(
		recordsReader(decoder.form, layouts, context),
		(read) =>
			(row: Row): A =>
				claimed<A>(read(row))
	)

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
 * - levelRecord(names) and levelRecordOver(base, names): a level's record (schema/schema.ts), each relation of
 *   the list under its own name, the one declaration of each name the level's build admitted (`names`, in list order),
 *   after the base's relations for an extension, which holds a name the base declares as the base's:
 *   Declared<Rs> and DeclaredOver<B, Rs> (types/schema/schema.ts).
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

/** A root level's record over its list (see the header): `names` each declaration's name and value, in list order. */
export const levelRecord = <Rs extends ReadonlyArray<unknown>>(
	names: ReadonlyArray<readonly [string, unknown]>
): Declared<Rs> =>
	assembled<Declared<Rs>, undefined>(
		names.map(([name, value]) => [name, () => value] as const),
		undefined
	)

/**
 * An extension's record (see the header): the base's relations, then each declaration `names` holds of a name the base
 * does not, in list order.
 */
export const levelRecordOver = <
	B extends AnySchema["relations"],
	Rs extends ReadonlyArray<unknown>
>(
	base: B,
	names: ReadonlyArray<readonly [string, unknown]>
): DeclaredOver<B, Rs> =>
	assembled<DeclaredOver<B, Rs>, undefined>(
		[
			...Object.entries(base).map(([name, value]) => [name, () => value] as const),
			...names.flatMap(([name, value]) =>
				Object.hasOwn(base, name) ? [] : [[name, () => value] as const]
			)
		],
		undefined
	)

/**
 * The public heading of a described query or arm (query/build QueryCarriers): no key carries a column, so v over it
 * mints untyped terms. Only the JavaScript view, whose carriers type is the wide Carriers, makes one.
 */
export const describedHeading = <C extends Carriers>(): C => assembled<C, undefined>([], undefined)
