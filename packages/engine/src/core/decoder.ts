import type { Option } from "effect"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { builtMark, type Phantom } from "#compiler/core/phantom.ts"
import * as Result from "#compiler/core/result.ts"

/** A column's conversion of its cell's text. */
interface ConvertColumn<out A> {
	readonly kind: "convert"
	readonly convert: (text: string) => A
}

/**
 * A closed handle's column: an enum cell is one of its roster's handles, which PostgreSQL's enum type enforces, so the
 * handle is the cell's text itself, read without a membership check under the record assembly's one claim
 * (schema/record.ts). The roster is never empty, and its handles are strings.
 */
interface HandleColumn<out A> {
	readonly kind: "handle"
	readonly handles: NonEmptyReadonlyArray<A>
}

/**
 * A pattern-refined text column (str.regex): the cell's text is its value, read without a check under the record
 * assembly's one claim. PostgreSQL holds every stored text to the pattern (the field's domain or CHECK), and A, the
 * pattern's inferred language (ArkRegex over the same source and flags), overapproximates it. A is a phantom of the
 * descriptor's own pattern, and the brand keeps a plain object from claiming it: textColumn, whose one caller is
 * str.regex (text/field.ts), and brandColumn are its only builders.
 */
interface TextColumn<out A> extends Phantom<{ readonly host: A }> {
	readonly kind: "text"
}

/**
 * Head literals' column: a head literal's own, or a union's whose arms deliver head literals alone at the key. Every
 * cell is the output text of one of the literals under their one SQL type (the checker types a union's column alike in
 * every arm), and is the literal equal to its conversion: `convert` is that type's conversion
 * (scalar/values/convert.ts), so a cell is read by its column's type and compared by its host value, never by its
 * spelling.
 */
interface ConstantColumn<out A> {
	readonly kind: "constant"
	readonly values: NonEmptyReadonlyArray<A>
	readonly convert: (text: string) => unknown
}

export type Column<A> = ConvertColumn<A> | HandleColumn<A> | TextColumn<A> | ConstantColumn<A>

/** What carries a column: a field descriptor, a term, an aggregate, a producer, a parameter, a head literal. */
export interface Columned<out A> {
	readonly column: Column<A>
}

export const convertColumn = <A>(convert: (text: string) => A): Column<A> =>
	Object.freeze({ kind: "convert", convert })

export const handleColumn = <A>(handles: NonEmptyReadonlyArray<A>): Column<A> =>
	Object.freeze({ kind: "handle", handles })

/** A pattern-refined text column over the pattern's inferred language A (str.regex). */
export const textColumn = <A extends string>(): Column<A> =>
	Object.freeze({ ...builtMark, kind: "text" })

/**
 * A contract's column over its base's: the brand, which has no runtime form (core/brand.ts nominal is the identity),
 * applied to every value the base's column yields, the handles of a closed base included; a refined text stays its
 * text.
 */
export const brandColumn = <A, B>(base: Column<A>, brand: (value: A) => B): Column<B> => {
	switch (base.kind) {
		case "convert":
			return convertColumn((text) => brand(base.convert(text)))
		case "handle":
			return handleColumn(mapNonEmpty(base.handles, (handle) => brand(handle)))
		case "text":
			return Object.freeze({ ...builtMark, kind: "text" })
		case "constant":
			return constants(
				mapNonEmpty(base.values, (value) => brand(value)),
				base.convert
			)
	}
}

const constants = <A>(
	values: NonEmptyReadonlyArray<A>,
	convert: (text: string) => unknown
): Column<A> => Object.freeze({ kind: "constant", values, convert })

/** A head literal's column (r.literal), read by `convert`, the conversion of the literal's SQL type. */
export const constantColumn = <A>(value: A, convert: (text: string) => unknown): Column<A> =>
	constants([value], convert)

/**
 * The literal a cell of head literals' column is: the one its text converts to (see ConstantColumn). The one site of
 * the fact that such a cell is one of the literals: the statement writes only those literals in that column, a runtime
 * set no type of a text carries.
 */
export const constantOf = <A>(column: ConstantColumn<A>): ((text: string) => A) => {
	const { values, convert } = column
	return (text) => {
		const host = convert(text)
		for (const value of values) {
			if (value === host) {
				return value
			}
		}
		throw defect("a cell of head literals' column converts to one of them")
	}
}

/** A refined text's column over A, built only where a column of the record assembly's claim kinds is widened. */
const claimedText = <A>(): Column<A> => Object.freeze({ ...builtMark, kind: "text" })

/**
 * The column of one key of a union of arms, over both arms' columns: a cell of the union's rows comes from either arm,
 * and is the output text of the one type the checker gave the key in every arm, so it is read by that type, whichever
 * arm wrote it. Head literals with head literals are head literals' column, read by their type's conversion; a head
 * literal with a conversion is that conversion, which reads a literal's text as the literal; head literals with a
 * roster are the roster with them; two rosters read as their union; a refined text with a roster or a text reads as a
 * text of either language; two conversions are one conversion.
 */
export const unionColumn = <A, B>(a: Column<A>, b: Column<B>): Column<A | B> => {
	if (a.kind === "constant") {
		switch (b.kind) {
			case "constant":
				return constants<A | B>([...a.values, ...b.values], a.convert)
			case "convert":
				return b
			case "handle":
				return handleColumn<A | B>([...a.values, ...b.handles])
			case "text":
				return claimedText()
		}
	}
	if (b.kind === "constant") {
		return unionColumn(b, a)
	}
	if (a.kind === "handle" && b.kind === "handle") {
		return handleColumn<A | B>([...a.handles, ...b.handles])
	}
	if (a.kind === "convert") {
		return a
	}
	if (b.kind === "convert") {
		return b
	}
	return claimedText()
}

/**
 * One row as a decoder reads it: the heading group it belongs to (the index of its statement's layout among the
 * layouts its decoder is bound to; 0 for every statement that is not one of a heterogeneous union's heading groups),
 * the cell texts of its statement's row, and for each attachment slot of its layout the child rows delivered under it,
 * in the child's order.
 */
export interface Row {
	readonly group: number
	readonly texts: ReadonlyArray<string>
	readonly children: ReadonlyArray<ReadonlyArray<Row>>
}

/** How an attachment delivers its children: all of them, at most one, or exactly one. */
export type Delivery = "array" | "option" | "one"

/** What each delivery is, over a child of type A. */
export interface Delivered<A> {
	readonly array: ReadonlyArray<A>
	readonly option: Option.Option<A>
	readonly one: A
}

/**
 * How delivered rows spell an Option: the shell's constructors of Effect's Option, passed where it binds a decoder, so
 * the engine builds the public row's Option values without a runtime dependency on Effect.
 */
export interface OptionVocabulary {
	readonly some: <A>(value: A) => Option.Some<A>
	readonly none: Option.None<never>
}

/**
 * Whether a delivery the analysis proved licenses the stated one: an array always; an Option where at most one child
 * is proved; the one child only where exactly one is.
 */
export const licenses = (proved: Delivery, stated: Delivery): boolean =>
	stated === "array" || proved === "one" || (stated === "option" && proved === "option")

/**
 * Where a record's fields are in its statement's rows: each public column's position among a row's texts, and each
 * attachment's slot among a row's children, its child's layouts (one per heading group the child delivers, one for a
 * child of one heading), and the delivery the analysis proved for it.
 */
export interface Layout {
	readonly columns: ReadonlyMap<string, number>
	readonly attachments: ReadonlyMap<string, AttachmentLayout>
}

export interface AttachmentLayout {
	readonly slot: number
	readonly layouts: NonEmptyReadonlyArray<Layout>
	readonly proved: Delivery
}

/** The keys of the record a layout delivers. */
const layoutNames = (layout: Layout): ReadonlyArray<string> => [
	...layout.columns.keys(),
	...layout.attachments.keys()
]

/** A record field bound to a layout: it reads its value from one row. */
interface Bound<out A> {
	readonly read: (row: Row) => A
}

/**
 * A record field that is no column: it binds to a layout under its key, throwing a Refusal when the layout does not
 * hold it as it needs; an Option it delivers is spelled by `options`.
 */
export interface RecordField<out A> {
	readonly bind: (layout: Layout, key: string, options: OptionVocabulary) => Bound<A>
}

/**
 * Typed decoders of delivered rows: what a builder value carries so that the rows it delivers have its type by
 * construction.
 *
 * - A field descriptor and a term carry a Column of their host type: the trusting conversion of a cell's text, or, for
 *   a closed handle, the roster the text is one of.
 * - A record (a relation's facts, a query's head, a ChangeSet's read-backs) is assembled from its fields by
 *   schema/record.ts, the one place TypeScript is told a record's type: a homomorphic mapped type over a runtime record
 *   is beyond what it can check, however the record is built.
 * - An attachment delivers its child's records in the delivery its author stated, an array, an Option or the one
 *   child, read from the child statement's rows the runtime grouped under each parent row.
 *
 * Conversion trusts its input: grizzle's own SQL wrote every text, under the type the compiler declared for its column,
 * and the outermost SELECT cast it to text. So a decoder converts and checks nothing a row could break, and has no
 * failure channel. A layout that does not hold a field the decoder reads, or an attachment the analysis did not prove
 * in the stated delivery, is the binding's CompileError, once per compiled program.
 *
 * A decoder is built once per program value. RowDecoder.bind resolves it against the layout of the statement that
 * delivers its rows, once per compiled program; the bound decoder is a straight closure over one row.
 *
 * A delivered record's decoder: the key sets of the records it may decode (one for a record, one per arm for a union),
 * and its binding to a layout.
 */
export interface RowDecoder<out A> {
	readonly headings: ReadonlyArray<ReadonlyArray<string>>
	readonly bind: (
		layout: Layout,
		options: OptionVocabulary
	) => Result.Result<(row: Row) => A, CompileError>
}

/**
 * A decoder bound to every heading group's layout: each row is read by its own group's binding. A decoder of one
 * heading binds one layout, and its rows are read by that binding whatever their group.
 */
export const bindGroups = <A>(
	decoder: RowDecoder<A>,
	layouts: NonEmptyReadonlyArray<Layout>,
	options: OptionVocabulary
): Result.Result<(row: Row) => A, CompileError> => {
	const [first, ...rest] = layouts
	if (rest.length === 0) {
		return decoder.bind(first, options)
	}
	const readers: Array<(row: Row) => A> = []
	for (const layout of layouts) {
		const bound = decoder.bind(layout, options)
		if (!bound.ok) {
			return bound
		}
		readers.push(bound.value)
	}
	return Result.ok((row) => rowSlot(readers, row.group)(row))
}

/** A refusal of a layout, thrown inside a binding and caught by RowDecoder.bind. */
export const refuseLayout = (key: string, what: string): never => {
	throw new Refusal(malformedDescription(SourceLoc(`delivered field ${key}`, []), what))
}

/** A bound decoder, or the Refusal its binding threw. */
export const binding = <A>(
	bind: () => (row: Row) => A
): Result.Result<(row: Row) => A, CompileError> => catchRefusal(bind)

/** A column's position in a layout, refused when the layout does not deliver it. */
export const columnAt = (layout: Layout, key: string): number =>
	layout.columns.get(key) ?? refuseLayout(key, "a column of the statement that delivers the record")

/**
 * The member at a position of a positional row from PostgreSQL: a text of a delivered row or of a written statement's
 * answer row, a delivered row's children under an attachment slot, or its heading group's reader. The one site of the
 * fact that such a row holds a member at every position of the layout that names the position: the width is the
 * statement's select list and attachment slots, which PostgreSQL's row description fixes for every row of the answer
 * and the shell's assembly keeps, and a group is one of the statement's heading groups. It is a runtime length, which
 * no TypeScript type of an array carries, so a miss is a defect.
 */
export const rowSlot = <A>(members: ReadonlyArray<A>, position: number): A => {
	const member = members[position]
	if (member === undefined) {
		throw defect(`a positional row holds its layout's member ${position}`)
	}
	return member
}

/** The text at a position of a positional row from PostgreSQL (rowSlot). */
export const rowText = (texts: ReadonlyArray<string>, position: number): string =>
	rowSlot(texts, position)

/** The cell at a position of its layout, which bound the reader. */
export const cellAt = (row: Row, position: number): string => rowText(row.texts, position)

/** The Option of at most one child: Some of the first, None of none. */
const optionOf = <A>(children: ReadonlyArray<A>, options: OptionVocabulary): Option.Option<A> =>
	isNonEmpty(children) ? options.some(children[0]) : options.none

/** Each delivery's reading of the children of one row. */
const deliveries = <A>(
	options: OptionVocabulary
): { readonly [D in Delivery]: (children: ReadonlyArray<A>) => Delivered<A>[D] } => ({
	array: (children) => children,
	option: (children) => optionOf(children, options),
	one: (children) => provenChild(children)
})

/**
 * The child a row holds under an attachment a law proves it holds: one the analysis proves delivers exactly one (a
 * containment into the child's key, enforced at commit), or an alternatives arm's on a row whose handle selects the arm
 * (the alternatives family law). The one site of the fact that the database holds the laws its proofs rest on, so the
 * row has its child: a row count is the database's state, which no type carries.
 */
const provenChild = <A>(children: ReadonlyArray<A>): A => {
	const [child] = children
	if (child === undefined) {
		throw defect("a row holds the child a law proves it holds")
	}
	return child
}

/** The children of one row under the attachment at `slot`, each read by `read`. */
const childrenAt = <A>(row: Row, slot: number, read: (row: Row) => A): ReadonlyArray<A> =>
	rowSlot(row.children, slot).map(read)

/** An attachment delivering `child`'s records as `delivery`, licensed by the delivery the analysis proved. */
export const attachment = <A, D extends Delivery>(
	child: RowDecoder<A>,
	delivery: D
): RecordField<Delivered<A>[D]> => ({
	bind: (layout, key, options) => {
		const at =
			layout.attachments.get(key) ?? refuseLayout(key, "an attachment of the statement's layout")
		if (!licenses(at.proved, delivery)) {
			refuseLayout(
				key,
				`an attachment the analysis proves to deliver as ${delivery}; it proves ${at.proved}`
			)
		}
		const bound = bindGroups(child, at.layouts, options)
		if (!bound.ok) {
			throw new Refusal(bound.error)
		}
		const read = bound.value
		const deliver: (children: ReadonlyArray<A>) => Delivered<A>[D] =
			deliveries<A>(options)[delivery]
		const { slot } = at
		return {
			read: (row) => deliver(Object.freeze(childrenAt(row, slot, read)))
		}
	}
})

/**
 * Two decoders' records as one: each row is both records' fields. The keys are disjoint, which the attachment and
 * read-back builders check where they name a new key. Its headings are every pairing of the two decoders' headings.
 */
export const merge = <A, B>(a: RowDecoder<A>, b: RowDecoder<B>): RowDecoder<A & B> => ({
	headings: a.headings.flatMap((x) => b.headings.map((y) => [...x, ...y])),
	bind: (layout, options) =>
		Result.flatMap(a.bind(layout, options), (readA) =>
			Result.map(
				b.bind(layout, options),
				(readB) =>
					(row: Row): A & B =>
						Object.freeze({ ...readA(row), ...readB(row) })
			)
		)
})

/** The size of the largest of `headings` whose keys the layout delivers, or undefined when it delivers none of them. */
const largestIn = (
	headings: ReadonlyArray<ReadonlyArray<string>>,
	names: ReadonlySet<string>
): number | undefined => {
	const delivered = headings.filter((heading) => heading.every((key) => names.has(key)))
	return delivered.length === 0
		? undefined
		: Math.max(...delivered.map((heading) => heading.length))
}

/** Whether a size the layout delivers beats another, where an undelivered one beats nothing. */
const larger = (x: number | undefined, y: number | undefined): boolean =>
	x !== undefined && (y === undefined || x > y)

/**
 * A union of two decoders' records: a layout binds the arm owning the largest heading the layout delivers. A heading
 * group's layout holds exactly one arm's heading, and no two arms share a heading (the union builder keys its groups by
 * heading, query/build unionRecords), so only that arm's heading and its strict subsets are delivered by it.
 */
export const oneOf = <A, B>(a: RowDecoder<A>, b: RowDecoder<B>): RowDecoder<A | B> => ({
	headings: [...a.headings, ...b.headings],
	bind: (layout, options) => {
		const names = new Set(layoutNames(layout))
		const inA = largestIn(a.headings, names)
		const inB = largestIn(b.headings, names)
		if (inA === undefined && inB === undefined) {
			return binding(() =>
				refuseLayout(
					[...names].join(", "),
					"a union arm whose keys are among the statement's columns"
				)
			)
		}
		return larger(inA, inB) ? a.bind(layout, options) : b.bind(layout, options)
	}
})

/** The children of one row under an attachment the analysis licenses as "option". */
const optionChildren = <A>(
	child: RowDecoder<A>,
	layout: Layout,
	key: string,
	options: OptionVocabulary
): ((row: Row) => ReadonlyArray<A>) => {
	const at =
		layout.attachments.get(key) ?? refuseLayout(key, "an attachment of the statement's layout")
	if (!licenses(at.proved, "option")) {
		refuseLayout(
			key,
			`an alternatives arm the analysis proves at most one child of; it proves ${at.proved}`
		)
	}
	const bound = bindGroups(child, at.layouts, options)
	if (!bound.ok) {
		throw new Refusal(bound.error)
	}
	const read = bound.value
	const { slot } = at
	return (row) => childrenAt(row, slot, read)
}

/** An alternatives arm's attachment on a row whose handle selects the arm: its one child, as Some. */
export const someChild = <A>(child: RowDecoder<A>): RecordField<Option.Some<A>> => ({
	bind: (layout, key, options) => {
		const children = optionChildren(child, layout, key, options)
		return {
			read: (row) => options.some(provenChild(children(row)))
		}
	}
})

/**
 * An alternatives arm's attachment on a row whose handle selects another arm: None. The layout must deliver the arm's
 * attachment, as for a selected arm; the row's children under it are never read, since the alternatives family law
 * holds them empty.
 */
export const noChild = <A>(child: RowDecoder<A>): RecordField<Option.None<A>> => ({
	bind: (layout, key, options) => {
		optionChildren(child, layout, key, options)
		return { read: () => options.none }
	}
})

/** One field under a name: an attachment's or a read-back's. */
export class Named<out N extends string, out X> {
	readonly name: N
	readonly field: X
	constructor(name: N, field: X) {
		this.name = name
		this.field = field
		Object.freeze(this)
	}
}

/** What a record field is: a column carrier, or a field that reads itself. */
export type RecordFieldOf<A> = Columned<A> | RecordField<A>

/** A part of a record: fields under their own keys, or one named field. */
export type Part =
	| { readonly [key: string]: RecordFieldOf<unknown> }
	| Named<string, RecordFieldOf<unknown>>

/** The host value a field decodes to. */
export type FieldHost<X> =
	X extends Columned<infer A> ? A : X extends RecordField<infer A> ? A : never

type PartHosts<P> =
	P extends Named<infer N, infer X>
		? { readonly [K in N]: FieldHost<X> }
		: { readonly [K in keyof P]: FieldHost<P[K]> }

/**
 * The record the parts Ps decode to: each part's keys with its fields' host values. It is the type of the records
 * schema/record.ts assembles, declared here so that the type layer can name it.
 */
export type Decoded<Ps> = Ps extends readonly [infer H, ...infer T]
	? PartHosts<H> & Decoded<T>
	: unknown
