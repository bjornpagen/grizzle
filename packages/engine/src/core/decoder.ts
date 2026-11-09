import type { Option } from "effect"
import { defect } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { builtMark, type Phantom } from "#compiler/core/phantom.ts"
import type { Cell, OutputText } from "#compiler/core/wire.ts"

/**
 * The carriers whose cell text converts by its carrier alone (scalar/values/convert.ts convertByCarrier): every carrier
 * of a text cell but a closed id's and a set's, which read their roster's names, and a vector's, which reads its
 * dimensions. scalar/values/convert.ts maps each to its conversion, so a carrier named here that converts no text is a
 * type error there.
 */
export type ConvertedCarrier =
	| "int2"
	| "int4"
	| "int8"
	| "numeric"
	| "float4"
	| "float8"
	| "money"
	| "bool"
	| "uuid"
	| "date"
	| "text"
	| "range4"
	| "range8"
	| "rangeDate"
	| "exactInteger"
	| "exactMoney"

/** How a column converts its cell's text, as data: its carrier's conversion, a vector's by its dimensions. */
export type CellConversion =
	| { readonly carrier: ConvertedCarrier }
	| { readonly carrier: "vector"; readonly dimensions: number }

/** A column's conversion of its cell's text, PostgreSQL's output, by its carrier (CellConversion). */
interface ConvertColumn<out A> extends Phantom<{ readonly host: A }> {
	readonly kind: "convert"
	readonly conversion: CellConversion
}

/**
 * A closed id's column: the cell is its code's int2out text, one of its roster's live codes, which the roster's domain
 * admits alone, read as the handle the installation's names give the code (BindContext names), without a membership
 * check, under the record assembly's one claim (schema/record.ts). A hole names no handle, and no stored code is one.
 * `handles` are the values the column may deliver, its roster's handles or the literals of a head, never empty.
 */
interface CodeColumn<out A> {
	readonly kind: "code"
	readonly roster: string
	readonly handles: NonEmptyReadonlyArray<A>
}

/**
 * A set's column: the cell is its bit(n) text, position i code i, read into a fresh Set of the handles the
 * installation's names give its 1 bits, under the record assembly's one claim. A is the set's host type, a phantom of
 * the descriptor's roster.
 */
interface BitsColumn<out A> extends Phantom<{ readonly host: A }> {
	readonly kind: "bits"
	readonly roster: string
}

/**
 * A column whose cell's text is its value, a member of a language A, read without a check under the record assembly's
 * one claim: a pattern-refined text's (str.regex), where PostgreSQL holds every stored text to the pattern (the
 * field's domain or CHECK) and A is the pattern's inferred language (ArkRegex over the same source and flags), and a
 * uuid's, whose every cell is uuid_out's canonical spelling and A its language (scalar/values/uuid.ts Uuid). A
 * overapproximates the texts PostgreSQL writes. It is a phantom of the descriptor's own pattern, and the brand keeps a
 * plain object from claiming it: textColumn, whose callers are str.regex (text/field.ts) and the uuid descriptor
 * (scalar/uuid.ts), and brandColumn are its only builders.
 */
interface TextColumn<out A> extends Phantom<{ readonly host: A }> {
	readonly kind: "text"
}

/**
 * Head literals' column: a head literal's own, or a union's whose arms deliver head literals alone at the key. Every
 * cell is the output text of one of the literals under their one SQL type (the checker types a union's column alike in
 * every arm), and is the literal equal to its conversion: `conversion` is that type's, and the literals are compared
 * by that type's equality of host values (`===` for a string, number, bigint or boolean, `equals` for a Decimal or a
 * Money), so a cell is read by its column's type and compared by its host value, never by its spelling.
 */
interface ConstantColumn<out A> {
	readonly kind: "constant"
	readonly values: NonEmptyReadonlyArray<A>
	readonly conversion: CellConversion
}

/**
 * A bytes column's: its cell is the value itself, which its statement's delivery assembled from the chunks it travels in
 * (codec/delivery.ts), read without a copy under the record assembly's one claim. A is the bytes descriptor's host type,
 * a phantom of it, and bytesColumn its one builder.
 */
interface BytesColumn<out A> extends Phantom<{ readonly host: A }> {
	readonly kind: "bytes"
}

/**
 * A delivered column: data, its host type A a phantom of its builder's. What reads a cell under it is the decoder's
 * interpreter's (schema/record.ts), from its data alone.
 */
export type Column<A> =
	| ConvertColumn<A>
	| CodeColumn<A>
	| BitsColumn<A>
	| TextColumn<A>
	| ConstantColumn<A>
	| BytesColumn<A>

/** What carries a column: a field descriptor, a term, an aggregate, a producer, a parameter, a head literal. */
export interface Columned<out A> {
	readonly column: Column<A>
}

/** The column converting its cell's text by `conversion`, whose host type A its caller states (scalar/values/convert.ts). */
export const convertColumn = <A>(conversion: CellConversion): Column<A> =>
	Object.freeze({ ...builtMark, kind: "convert", conversion })

/** A closed id's column over roster `roster`, which may deliver `handles`. */
export const codeColumn = <A>(roster: string, handles: NonEmptyReadonlyArray<A>): Column<A> =>
	Object.freeze({ kind: "code", roster, handles })

/** A set's column over roster `roster`, whose values are A. */
export const bitsColumn = <A>(roster: string): Column<A> =>
	Object.freeze({ ...builtMark, kind: "bits", roster })

/** The bytes descriptor's column (scalar/bytes.ts), whose cell is its assembled value. */
export const bytesColumn: Column<Uint8Array<ArrayBuffer>> = Object.freeze({
	...builtMark,
	kind: "bytes"
})

/** A text column over the language A its cells are in: a refined text's pattern's (str.regex), or uuid_out's. */
export const textColumn = <A extends string>(): Column<A> =>
	Object.freeze({ ...builtMark, kind: "text" })

const constants = <A>(values: NonEmptyReadonlyArray<A>, conversion: CellConversion): Column<A> =>
	Object.freeze({ kind: "constant", values, conversion })

/**
 * A contract's column over its base's: the brand, which has no runtime form (core/brand.ts nominal is the identity),
 * applied to every value the base's column holds, the handles of a closed base and the literals of head literals
 * included; a conversion and a refined text stay their base's. No contract is over a set or bytes, so either is a
 * defect here.
 */
export const brandColumn = <A, B>(base: Column<A>, brand: (value: A) => B): Column<B> => {
	switch (base.kind) {
		case "convert":
			return convertColumn(base.conversion)
		case "code":
			return codeColumn(
				base.roster,
				mapNonEmpty(base.handles, (handle) => brand(handle))
			)
		case "bits":
			throw defect("no contract is over a set over a roster")
		case "bytes":
			throw defect("no contract is over bytes")
		case "text":
			return Object.freeze({ ...builtMark, kind: "text" })
		case "constant":
			return constants(
				mapNonEmpty(base.values, (value) => brand(value)),
				base.conversion
			)
	}
}

/**
 * A head literal's column, a JavaScript value's in a head: read by `conversion`, the conversion of the literal's SQL
 * type, and matched by that type's equality.
 */
export const constantColumn = <A>(value: A, conversion: CellConversion): Column<A> =>
	constants([value], conversion)

/** A refined text's column over A, built only where a column of the record assembly's claim kinds is widened. */
const claimedText = <A>(): Column<A> => Object.freeze({ ...builtMark, kind: "text" })

/**
 * The column of one key of a union of arms, over both arms' columns: a cell of the union's rows comes from either arm,
 * and is the output text of the one type the checker gave the key in every arm, so it is read by that type, whichever
 * arm wrote it. Head literals with head literals are head literals' column, read by their type's conversion; a head
 * literal with a conversion is that conversion, which reads a literal's text as the literal; head literals with a
 * closed id are that closed id with them; two closed ids of one roster read as their union, and two sets of one
 * roster as one; a refined text with a text reads as a text of either language; two conversions are one conversion.
 * A closed id's or a set's cell is its type's alone, so one beside a column of another roster, or of any other kind
 * but head literals, is a defect, as is a bytes column beside any but a bytes column: the checker gives the key one type
 * in every arm.
 */
export const unionColumn = <A, B>(a: Column<A>, b: Column<B>): Column<A | B> => {
	if (a.kind === "constant") {
		switch (b.kind) {
			case "constant":
				return constants<A | B>([...a.values, ...b.values], a.conversion)
			case "convert":
				return convertColumn(b.conversion)
			case "code":
				return codeColumn<A | B>(b.roster, [...a.values, ...b.handles])
			case "bits":
				throw defect("a set's column meets only a set's column of its roster")
			case "bytes":
				throw defect("a bytes column meets only a bytes column")
			case "text":
				return claimedText()
		}
	}
	if (b.kind === "constant") {
		return unionColumn(b, a)
	}
	if (a.kind === "bytes" || b.kind === "bytes") {
		if (a.kind !== "bytes" || b.kind !== "bytes") {
			throw defect("a bytes column meets only a bytes column")
		}
		return Object.freeze({ ...builtMark, kind: "bytes" })
	}
	if (a.kind === "code" || b.kind === "code") {
		if (a.kind !== "code" || b.kind !== "code" || a.roster !== b.roster) {
			throw defect("a closed id's column meets only a closed id's column of its roster")
		}
		return codeColumn<A | B>(a.roster, [...a.handles, ...b.handles])
	}
	if (a.kind === "bits" || b.kind === "bits") {
		if (a.kind !== "bits" || b.kind !== "bits" || a.roster !== b.roster) {
			throw defect("a set's column meets only a set's column of its roster")
		}
		return bitsColumn<A | B>(a.roster)
	}
	if (a.kind === "convert") {
		return convertColumn(a.conversion)
	}
	if (b.kind === "convert") {
		return convertColumn(b.conversion)
	}
	return claimedText()
}

/**
 * One row as a decoder reads it: the heading group it belongs to (the index of its statement's layout among the
 * layouts its decoder is bound to; 0 for every statement that is not one of a heterogeneous union's heading groups),
 * the cells of its statement's row as its delivery assembled them (codec/delivery.ts), and for each attachment slot of
 * its layout the child rows delivered under it, in the child's order.
 */
export interface Row {
	readonly group: number
	readonly cells: ReadonlyArray<Cell>
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
 * Each roster's names in code order, a hole the empty name, by the roster's declared name: the installation's, which
 * its codebook gives (ir/codes.ts codeNames). A closed id's cell is read as names(roster)[code].
 */
export type CodeNames = (roster: string) => ReadonlyArray<string>

/** What a decoder binds under besides its layout: how its Options are spelled, and the installation's names. */
export interface BindContext {
	readonly options: OptionVocabulary
	readonly names: CodeNames
}

/**
 * Whether a delivery the analysis proved licenses the stated one: an array always; an Option where at most one child
 * is proved; the one child only where exactly one is.
 */
export const licenses = (proved: Delivery, stated: Delivery): boolean =>
	stated === "array" || proved === "one" || (stated === "option" && proved === "option")

/**
 * Where a record's fields are in its statement's rows: each public column's position among a row's cells, and each
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

/**
 * A column as a decoder holds it: its kind and what its interpreter reads, the conversion of a converted or head
 * literals' column, the roster of a closed id's or a set's, and head literals' values; no brand, since a decoder is
 * data a served file carries (served/forms.ts), and no handles, which only type a closed id's values.
 */
export type ColumnForm =
	| { readonly kind: "convert"; readonly conversion: CellConversion }
	| { readonly kind: "code"; readonly roster: string }
	| { readonly kind: "bits"; readonly roster: string }
	| { readonly kind: "text" }
	| {
			readonly kind: "constant"
			readonly values: NonEmptyReadonlyArray<unknown>
			readonly conversion: CellConversion
	  }
	| { readonly kind: "bytes" }

/** The form of a column, as a decoder holds it (ColumnForm). */
export const columnForm = (column: Column<unknown>): ColumnForm => {
	switch (column.kind) {
		case "convert":
			return Object.freeze({ kind: "convert", conversion: column.conversion })
		case "code":
			return Object.freeze({ kind: "code", roster: column.roster })
		case "bits":
			return Object.freeze({ kind: "bits", roster: column.roster })
		case "text":
			return Object.freeze({ kind: "text" })
		case "constant":
			return Object.freeze({
				kind: "constant",
				values: column.values,
				conversion: column.conversion
			})
		case "bytes":
			return Object.freeze({ kind: "bytes" })
	}
}

/**
 * A record field as a decoder holds it: a column, read from the cell under its key; an attachment, delivering its
 * child's records from the rows under its slot as stated; or an alternatives arm's attachment on a row whose handle
 * selects the arm (its one child, as Some) or another (None).
 */
export type FieldForm =
	| { readonly kind: "column"; readonly column: ColumnForm }
	| { readonly kind: "attachment"; readonly child: DecoderForm; readonly delivery: Delivery }
	| { readonly kind: "some"; readonly child: DecoderForm }
	| { readonly kind: "none"; readonly child: DecoderForm }

/** A field that reads itself, no column: an attachment's, or an alternatives arm's. */
export type AttachedForm = Exclude<FieldForm, { readonly kind: "column" }>

/**
 * A decoder of delivered records, as data: a record of fields, in key order; two decoders' records as one, each row
 * both records' fields; a union of two decoders' records, a layout binding the arm that owns the largest heading it
 * delivers; a parent's records with the alternatives arm of `handle` under `name`, Some of the child where the parent's
 * `field` holds `handle` and None elsewhere; or the decoder of a query whose rows no builder can decode, which refuses
 * every layout. Its interpreter is schema/record.ts bindGroups, which a served file's decoder runs through as one a
 * builder made.
 */
export type DecoderForm =
	| { readonly kind: "record"; readonly fields: ReadonlyArray<readonly [string, FieldForm]> }
	| { readonly kind: "merge"; readonly first: DecoderForm; readonly second: DecoderForm }
	| { readonly kind: "oneOf"; readonly first: DecoderForm; readonly second: DecoderForm }
	| {
			readonly kind: "arm"
			readonly parent: DecoderForm
			readonly name: string
			readonly child: DecoderForm
			readonly field: string
			readonly handle: string
	  }
	| { readonly kind: "refused" }

/**
 * A record field that is no column, its delivered value A a phantom of its builder's: an attachment's or an
 * alternatives arm's, as data (AttachedForm).
 */
export interface RecordField<out A> extends Phantom<{ readonly host: A }> {
	readonly form: AttachedForm
}

/**
 * Typed decoders of delivered rows: what a builder value carries so that the rows it delivers have its type by
 * construction.
 *
 * - A field descriptor and a term carry a Column of their host type: the conversion of a cell's text, or, for a closed
 *   id or a set over a roster, the roster whose names its cell's codes are read by.
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
 * A decoder is data (DecoderForm), built once per program value, its record type A a phantom of its builder's: the same
 * data a served file carries for it. Binding it (schema/record.ts bindGroups) resolves it against the layout of the
 * statement that delivers its rows, once per compiled program; the bound decoder is a straight closure over one row.
 */
export interface RowDecoder<out A> extends Phantom<{ readonly host: A }> {
	readonly form: DecoderForm
}

/**
 * The key sets of the records a decoder form may decode, one per heading it delivers: a record's own keys, every
 * pairing of a merge's, both arms' of a union, and an arm's parent's each with the arm's attachment.
 */
export const formHeadings = (form: DecoderForm): ReadonlyArray<ReadonlyArray<string>> => {
	switch (form.kind) {
		case "record":
			return [form.fields.map(([key]) => key)]
		case "merge": {
			const second = formHeadings(form.second)
			return formHeadings(form.first).flatMap((x) => second.map((y) => [...x, ...y]))
		}
		case "oneOf":
			return [...formHeadings(form.first), ...formHeadings(form.second)]
		case "arm":
			return formHeadings(form.parent).map((x) => [...x, form.name])
		case "refused":
			return []
	}
}

/** The key sets of the records a decoder may decode (formHeadings). */
export const headingsOf = (decoder: RowDecoder<unknown>): ReadonlyArray<ReadonlyArray<string>> =>
	formHeadings(decoder.form)

/** The decoder whose records the form `form` reads, A its builder's statement of their type. */
export const decoderOf = <A>(form: DecoderForm): RowDecoder<A> =>
	Object.freeze({ ...builtMark, form })

/** An attachment delivering `child`'s records as `delivery`, licensed by the delivery the analysis proved. */
export const attachment = <A, D extends Delivery>(
	child: RowDecoder<A>,
	delivery: D
): RecordField<Delivered<A>[D]> =>
	Object.freeze({
		...builtMark,
		form: Object.freeze({ kind: "attachment", child: child.form, delivery })
	})

/**
 * Two decoders' records as one: each row is both records' fields. The keys are disjoint, which the attachment and
 * read-back builders check where they name a new key.
 */
export const merge = <A, B>(a: RowDecoder<A>, b: RowDecoder<B>): RowDecoder<A & B> =>
	decoderOf(Object.freeze({ kind: "merge", first: a.form, second: b.form }))

/**
 * A union of two decoders' records: a layout binds the arm owning the largest heading the layout delivers. A heading
 * group's layout holds exactly one arm's heading, and no two arms share a heading (the union builder keys its groups by
 * heading, query/build unionRecords), so only that arm's heading and its strict subsets are delivered by it.
 */
export const oneOf = <A, B>(a: RowDecoder<A>, b: RowDecoder<B>): RowDecoder<A | B> =>
	decoderOf(Object.freeze({ kind: "oneOf", first: a.form, second: b.form }))

/** An alternatives arm's attachment on a row whose handle selects the arm: its one child, as Some. */
export const someChild = <A>(child: RowDecoder<A>): RecordField<Option.Some<A>> =>
	Object.freeze({ ...builtMark, form: Object.freeze({ kind: "some", child: child.form }) })

/**
 * An alternatives arm's attachment on a row whose handle selects another arm: None. The layout must deliver the arm's
 * attachment, as for a selected arm. The alternatives family law holds the row's children under it empty, so a child
 * there is a state the law excludes: a defect naming the attachment, never a child dropped silently.
 */
export const noChild = <A>(child: RowDecoder<A>): RecordField<Option.None<A>> =>
	Object.freeze({ ...builtMark, form: Object.freeze({ kind: "none", child: child.form }) })

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

/** The cell at a position of a delivered row (rowSlot). */
export const rowCell = (cells: ReadonlyArray<Cell>, position: number): Cell =>
	rowSlot(cells, position)

/**
 * A text column's cell as its output text. The one site of the fact that a text column's cell is its output text: a
 * column's delivery is its type's, which travels a bytes column alone in chunks (codec/delivery.ts), and a row's cells
 * are a runtime array no TypeScript type ties to its columns' types, so a value there is a defect.
 */
export const outputTextOf = (cell: Cell): OutputText => {
	if (typeof cell !== "string") {
		throw defect("a text column's cell is its output text")
	}
	return cell
}

/**
 * A bytes column's cell as its value, which its delivery assembled. The one site of the fact that a bytes column's cell
 * is its value, never a text (`outputTextOf`): a text there is a defect, so no bytes value is ever read from a text.
 */
export const bytesValueOf = (cell: Cell): Uint8Array<ArrayBuffer> => {
	if (typeof cell === "string") {
		throw defect("a bytes column's cell is its assembled value")
	}
	return cell
}

/** The text at a position of a delivered row (rowSlot): a text column's cell (`outputTextOf`). */
export const rowText = (cells: ReadonlyArray<Cell>, position: number): OutputText =>
	outputTextOf(rowSlot(cells, position))

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
