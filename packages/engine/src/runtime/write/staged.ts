/**
 * A statement's executions in the call's one flight: its one, inline, or, where its nested rows' arrays are past one
 * Bind message, its staged form's, its carriers emptied and filled chunk by chunk and the staged statement
 * (write/program/staged.ts, which compiles the staged form and says why).
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { byteaElementBytes, byteaHeaderBytes } from "#compiler/codec/bytea.ts"
import { literalAlone } from "#compiler/codec/recordset.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import type { Prepared } from "#compiler/core/prepared.ts"
import type { Param } from "#compiler/core/wire.ts"
import type { LiteralBound } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { typedColumnArray } from "#compiler/runtime/write/arrays.ts"
import type { MemberCell } from "#compiler/runtime/write/draw.ts"
import type { WriteText } from "#compiler/runtime/write/parted.ts"
import type { Transport } from "#compiler/runtime/write/transport.ts"
import type { CreateCarrier, EmittedText } from "#compiler/sql/ast.ts"

/**
 * One carrier of a staged statement: its table, which the session's stand-up of the write makes (flight.ts StandUp),
 * its emptying, its fill, and the positions among the inline form's placeholders of the columns its fill carries, in the
 * order of the fill's own, one source of nested rows.
 */
export interface StagedCarrier {
	readonly table: CreateCarrier
	readonly empty: EmittedText
	readonly fill: EmittedText
	readonly columns: NonEmptyReadonlyArray<number>
}

/**
 * How a statement's nested rows may travel: `none`, a statement that reads none, whose every array rides its own Bind
 * message; or `carriers`, its staged form: a carrier per FROM item of its nested rows, its text reading them, and the positions among the inline form's placeholders it keeps, in its own placeholders'
 * order.
 */
export type Staged =
	| { readonly kind: "none" }
	| {
			readonly kind: "carriers"
			readonly carriers: NonEmptyReadonlyArray<StagedCarrier>
			readonly sql: EmittedText
			readonly kept: ReadonlyArray<number>
	  }

/** A staged carrier as a served write holds it: its emptying and its fill each named (core/prepared.ts); its table is
 * the write's stand-up's (flight.ts ServedWrite `standUps`). */
export interface PreparedCarrier {
	readonly empty: Prepared<EmittedText>
	readonly fill: Prepared<EmittedText>
	readonly columns: NonEmptyReadonlyArray<number>
}

/** A statement's staged form as a served write holds it (Staged): every text of it named. */
export type PreparedStaged =
	| { readonly kind: "none" }
	| {
			readonly kind: "carriers"
			readonly carriers: NonEmptyReadonlyArray<PreparedCarrier>
			readonly sql: Prepared<EmittedText>
			readonly kept: ReadonlyArray<number>
	  }

/**
 * What one execution of an artifact statement does: `empty`, a carrier's emptying before a use fills it, a carrier step's
 * of the program's own or a staged carrier's; `fill`, a carrier's fill, a staged one's of a chunk of its rows among
 * them; or `statement`, any other, a staged statement and a chunk of a family step among them.
 */
export type ExecutionPart = "statement" | "empty" | "fill"

/** One execution of an artifact statement: its prepared text, its placeholders' values and what it is. */
export interface Execution {
	readonly text: Prepared<WriteText>
	readonly params: ReadonlyArray<Param>
	readonly part: ExecutionPart
}

/**
 * A stratum's nested rows of one relation as their placeholders carry them: their sent layout's column types, and each
 * row's cells in the same order, its key's first (runtime/write/nesting.ts cellsReader).
 */
export interface NestedCells {
	readonly relation: StoredRelationName
	readonly types: ReadonlyArray<ScalarType>
	readonly rows: ReadonlyArray<ReadonlyArray<MemberCell>>
}

/**
 * Why a nested row goes in no insert of its relation even alone: its column at `column` would make an array literal
 * longer than `limit` code units, or its Bind message would be `bytes` long, past `limit`.
 */
export type Unsendable =
	| { readonly kind: "literal"; readonly column: number; readonly limit: number }
	| { readonly kind: "message"; readonly bytes: number; readonly limit: number }

/** A nested row no fill carries even alone, as the relation it is a row of names it. */
export interface NestedRowBound {
	readonly _tag: "NestedRowBound"
	readonly relation: StoredRelationName
	readonly row: Unsendable
}

/** The type of column `part` of nested rows. */
const typeAt = (cells: NestedCells, part: number): ScalarType =>
	defined(cells.types[part], `column ${part + 1} of ${cells.relation}'s sent layout`)

/** The cell of column `part` of a nested row. */
const cellAt = (row: ReadonlyArray<MemberCell>, part: number): MemberCell =>
	defined(row[part], "a nested row holds each column of its sent layout")

/**
 * The array of column `part` of `rows` as a nested rows placeholder carries it (runtime/write/arrays.ts
 * typedColumnArray): a text column's binary text[], a bytes column's binary bytea[], any other's text array literal.
 */
export const nestedColumn = (
	cells: NestedCells,
	part: number,
	rows: ReadonlyArray<ReadonlyArray<MemberCell>>
): Result.Result<Param, LiteralBound | EncodingFailure> =>
	typedColumnArray(
		cells.relation,
		`column ${part + 1}`,
		typeAt(cells, part),
		rows.map((row) => cellAt(row, part))
	)

/**
 * What one cell adds to its column's array, as the array's encoder writes it: a binary array's element, its length
 * word and its bytes, or a literal's alone, its UTF-16 code units and its UTF-8 bytes (codec/recordset.ts
 * literalAlone).
 */
type Element =
	| { readonly kind: "binary"; readonly bytes: number }
	| { readonly kind: "literal"; readonly bytes: number; readonly units: number }

/** A cell's element in the array of a column of `type` (`nestedColumn`). */
const elementOf = (type: ScalarType, cell: MemberCell): Element => {
	if (typeof cell !== "string") {
		return { kind: "binary", bytes: byteaElementBytes(cell.bytes.length) }
	}
	if (type.carrier === "text") {
		return { kind: "binary", bytes: byteaElementBytes(utf8Length(cell)) }
	}
	return { kind: "literal", ...literalAlone(cell) }
}

/** One column's array as it grows: its bytes, and a literal's UTF-16 code units, none for a binary array. */
interface Measure {
	readonly bytes: number
	readonly units: number
}

/** A column's array of one element alone. */
const aloneMeasure = (element: Element): Measure =>
	element.kind === "binary"
		? { bytes: byteaHeaderBytes(1) + element.bytes, units: 0 }
		: { bytes: element.bytes, units: element.units }

/** A column's array with one more element: a binary array's grows by it, a literal's by it less the brace it shares. */
const grownMeasure = (measure: Measure, element: Element): Measure =>
	element.kind === "binary"
		? { bytes: measure.bytes + element.bytes, units: 0 }
		: { bytes: measure.bytes + element.bytes - 1, units: measure.units + element.units - 1 }

/**
 * One column of a source's every row: its array as a placeholder carries it (`nestedColumn`), or why it has none. A
 * written array is its own measure, its bytes and a literal's UTF-16 code units, which the cut reads; a column with no
 * array travels in chunks.
 */
interface SourceColumn {
	readonly whole: Result.Result<Param, LiteralBound | EncodingFailure>
}

/**
 * A stratum's nested rows of one relation as every statement that sends them reads them: their cells, and each column
 * of their sent layout, by its part, written whole once (`SourceColumn`), so no statement writes a column of a source
 * another statement sends. A write builds each of its sources once (runtime/write/bind.ts).
 */
export interface NestedSource {
	readonly cells: NestedCells
	readonly columns: ReadonlyArray<SourceColumn>
}

/** The source of `cells` (`NestedSource`): each column of their sent layout written over every row. */
export const nestedSource = (cells: NestedCells): NestedSource => ({
	cells,
	columns: cells.types.map((_, part) => ({ whole: nestedColumn(cells, part, cells.rows) }))
})

/** Column `part` of a source. */
const columnAt = (source: NestedSource, part: number): SourceColumn =>
	defined(source.columns[part], `column ${part + 1} of ${source.cells.relation}'s sent layout`)

/** The bytes a placeholder's value adds to its Bind message's parameters. */
const paramBytes = (param: Param): number =>
	typeof param === "string" ? utf8Length(param) : param.byteLength

/**
 * The most bytes a placeholder's value may add to its Bind message: a binary value's own, and a text's three for each of
 * its UTF-16 code units, the most UTF-8 writes for one (a surrogate pair's four for its two), so no text is counted to
 * be found within a message whose bound its units already keep.
 */
const paramBytesAtMost = (param: Param): number =>
	typeof param === "string" ? 3 * param.length : param.byteLength

/**
 * Whether an inline execution's Bind message, its placeholders' values `params`, fits within `messageBytes`: at once
 * where it fits counted at its texts' most (`paramBytesAtMost`), and otherwise counted exactly.
 */
const inlineFits = (
	params: ReadonlyArray<Param>,
	frame: Transport["frame"],
	messageBytes: number
): boolean => {
	const sum = (bytes: (param: Param) => number): number =>
		params.reduce((total, param) => total + frame.parameter + bytes(param), frame.statement)
	return sum(paramBytesAtMost) <= messageBytes || sum(paramBytes) <= messageBytes
}

/** One chunk of a carrier's rows: the rows from `from` up to `to`, which one fill's Bind message carries. */
interface Chunk {
	readonly from: number
	readonly to: number
}

/**
 * A carrier's rows cut into consecutive chunks, each as long as one fill's Bind message carries: its arrays within the
 * transport's message, each literal within its longest string, measured from the cells' lengths. A row no fill carries
 * even alone refuses the cut.
 */
const chunksOf = (
	cells: NestedCells,
	parts: NonEmptyReadonlyArray<number>,
	transport: Transport
): Result.Result<ReadonlyArray<Chunk>, NestedRowBound> => {
	const { frame, messageBytes, literalUnits } = transport
	const fixed = frame.statement + parts.length * frame.parameter
	const types = parts.map((part) => typeAt(cells, part))
	const chunks: Array<Chunk> = []
	let open: { readonly from: number; readonly measures: ReadonlyArray<Measure> } | undefined
	const fits = (measures: ReadonlyArray<Measure>): boolean =>
		measures.reduce((sum, m) => sum + m.bytes, fixed) <= messageBytes &&
		measures.every((m) => m.units <= literalUnits)
	for (const [at, row] of cells.rows.entries()) {
		const elements = parts.map((part, i) =>
			elementOf(defined(types[i], "the type of each part"), cellAt(row, part))
		)
		const alone = elements.map(aloneMeasure)
		const wide = alone.findIndex((m) => m.units > literalUnits)
		const widePart = parts[wide]
		if (widePart !== undefined) {
			return Result.err({
				_tag: "NestedRowBound",
				relation: cells.relation,
				row: { kind: "literal", column: widePart, limit: literalUnits }
			})
		}
		const bytes = alone.reduce((sum, m) => sum + m.bytes, fixed)
		if (bytes > messageBytes) {
			return Result.err({
				_tag: "NestedRowBound",
				relation: cells.relation,
				row: { kind: "message", bytes, limit: messageBytes }
			})
		}
		const grown =
			open === undefined
				? undefined
				: open.measures.map((m, i) =>
						grownMeasure(m, defined(elements[i], "an element of each part"))
					)
		if (open !== undefined && grown !== undefined && fits(grown)) {
			open = { from: open.from, measures: grown }
			continue
		}
		if (open !== undefined) {
			chunks.push({ from: open.from, to: at })
		}
		open = { from: at, measures: alone }
	}
	if (open !== undefined) {
		chunks.push({ from: open.from, to: cells.rows.length })
	}
	return Result.ok(chunks)
}

/** A placeholder of nested rows as one execution binds it: its column's part, and its source. */
export interface NestedPlaceholder {
	readonly part: number
	readonly source: NestedSource
}

/**
 * A statement as its executions read it: its inline text, its staged form, and each placeholder's nested rows, by
 * position, none for a placeholder of any other value; the placeholders of one source share it, as every statement
 * that sends the source does.
 */
export interface StagedStatement {
	readonly text: Prepared<WriteText>
	readonly staged: PreparedStaged
	readonly nested: ReadonlyArray<NestedPlaceholder | undefined>
}

/**
 * A statement's executions (see the header): its one, inline, where it reads no nested rows or its Bind message, its
 * nested rows' arrays as written, fits the transport; otherwise its staged form's, each carrier created
 * and filled chunk by chunk, then the staged statement. `part` is what the statement itself does, which
 * its inline execution is. `encode` writes the value of the placeholder at a position that carries no nested rows.
 * An inline execution sends each column's array as its source holds it, written once for every statement that sends
 * it, whose bytes and code units the cut reads; a fill writes its chunk's arrays.
 */
export const executionsOf = (
	statement: StagedStatement,
	part: ExecutionPart,
	encode: (position: number) => Result.Result<Param, LiteralBound | EncodingFailure>,
	transport: Transport
): Result.Result<ReadonlyArray<Execution>, LiteralBound | EncodingFailure | NestedRowBound> => {
	const values = new Map<number, Param>()
	for (const [position, slot] of statement.nested.entries()) {
		if (slot !== undefined) {
			continue
		}
		const value = encode(position)
		if (!value.ok) {
			return value
		}
		values.set(position, value.value)
	}
	const inline = (): Result.Result<ReadonlyArray<Execution>, LiteralBound | EncodingFailure> => {
		const params: Array<Param> = []
		for (const [position, slot] of statement.nested.entries()) {
			if (slot === undefined) {
				params.push(defined(values.get(position), "the value of a placeholder of no nested rows"))
				continue
			}
			const array = columnAt(slot.source, slot.part).whole
			if (!array.ok) {
				return array
			}
			params.push(array.value)
		}
		return Result.ok([{ text: statement.text, params, part }])
	}
	const staged = statement.staged
	if (staged.kind === "none") {
		return inline()
	}
	const { frame, messageBytes, literalUnits } = transport
	/** The placeholders' values as the inline execution binds them, up to a column of nested rows with no whole array or
	 * whose literal is past the transport's longest, which travels in chunks. */
	const bound: Array<Param> = []
	let wholes = true
	for (const [position, slot] of statement.nested.entries()) {
		if (slot === undefined) {
			bound.push(defined(values.get(position), "an encoded value"))
			continue
		}
		const { whole } = columnAt(slot.source, slot.part)
		if (!whole.ok || (typeof whole.value === "string" && whole.value.length > literalUnits)) {
			wholes = false
			break
		}
		bound.push(whole.value)
	}
	if (wholes && inlineFits(bound, frame, messageBytes)) {
		return inline()
	}
	const out: Array<Execution> = []
	for (const carrier of staged.carriers) {
		const slots = mapNonEmpty(carrier.columns, (position) =>
			defined(statement.nested[position], "a carrier's column of nested rows")
		)
		const [{ source }] = slots
		const { cells } = source
		const parts = mapNonEmpty(slots, (slot) => slot.part)
		out.push({ text: carrier.empty, params: [], part: "empty" })
		const chunks = chunksOf(cells, parts, transport)
		if (!chunks.ok) {
			return chunks
		}
		for (const chunk of chunks.value) {
			const rows = cells.rows.slice(chunk.from, chunk.to)
			const params: Array<Param> = []
			for (const column of parts) {
				const array = nestedColumn(cells, column, rows)
				if (!array.ok) {
					return array
				}
				params.push(array.value)
			}
			out.push({ text: carrier.fill, params, part: "fill" })
		}
	}
	out.push({
		text: staged.sql,
		params: staged.kept.map((position) =>
			defined(values.get(position), "the value of a placeholder the staged statement keeps")
		),
		part
	})
	return Result.ok(out)
}
