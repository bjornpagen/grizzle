/**
 * A statement's executions in the call's one flight: its one, inline, or, where its nested rows' arrays are past one
 * Bind message, its staged form's, its carriers created and filled chunk by chunk, their ANALYZE and the staged
 * statement (write/program/staged.ts, which compiles the staged form and says why).
 */
import { byteaElementBytes, byteaHeaderBytes } from "#compiler/codec/bytea.ts"
import { literalAlone } from "#compiler/codec/recordset.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import type { Param } from "#compiler/core/wire.ts"
import type { LiteralBound } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { typedColumnArray } from "#compiler/runtime/write/arrays.ts"
import type { MemberCell } from "#compiler/runtime/write/draw.ts"
import type { Transport } from "#compiler/runtime/write/transport.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { Unsendable } from "#compiler/write/family/order.ts"

/**
 * One carrier of a staged statement: its creation, its fill, and the positions among the inline form's placeholders
 * of the columns its fill carries, in the order of the fill's own, one source of nested rows.
 */
export interface StagedCarrier {
	readonly create: EmittedText
	readonly fill: EmittedText
	readonly columns: NonEmptyReadonlyArray<number>
}

/**
 * How a statement's nested rows may travel: `none`, a statement that reads none, whose every array rides its own Bind
 * message; or `carriers`, its staged form: a carrier per FROM item of its nested rows, their ANALYZE, its text reading
 * them, and the positions among the inline form's placeholders it keeps, in its own placeholders' order.
 */
export type Staged =
	| { readonly kind: "none" }
	| {
			readonly kind: "carriers"
			readonly carriers: NonEmptyReadonlyArray<StagedCarrier>
			readonly analyze: EmittedText
			readonly sql: EmittedText
			readonly kept: ReadonlyArray<number>
	  }

/**
 * What one execution of an artifact statement does: `create`, a CREATE TEMPORARY TABLE, a carrier step's of the
 * program's own or a staged carrier's, the one kind a role without TEMPORARY on the database is refused; `fill`, a
 * carrier's fill, a staged one's of a chunk of its rows among them; `analyze`, an ANALYZE of carriers; or `statement`,
 * any other, a staged statement and a chunk of a family step among them.
 */
export type ExecutionPart = "statement" | "create" | "fill" | "analyze"

/** One execution of an artifact statement: its text, its placeholders' values and what it is. */
export interface Execution {
	readonly sql: EmittedText
	readonly params: ReadonlyArray<Param>
	readonly part: ExecutionPart
}

/**
 * A stratum's nested rows of one relation as their placeholders carry them: their sent layout's column types, and each
 * row's cells in the same order (runtime/write/draw.ts rowTexts).
 */
export interface NestedCells {
	readonly relation: string
	readonly types: ReadonlyArray<ScalarType>
	readonly rows: ReadonlyArray<ReadonlyArray<MemberCell>>
}

/** A nested row no fill carries even alone, as the relation it is a row of names it. */
export interface NestedRowBound {
	readonly _tag: "NestedRowBound"
	readonly relation: string
	readonly row: Unsendable
}

/** The type of column `part` of nested rows. */
const typeAt = (cells: NestedCells, part: number): ScalarType =>
	defined(cells.types[part], `column ${part + 1} of ${cells.relation}'s sent layout`)

/** The cell of column `part` of a nested row. */
const cellAt = (row: ReadonlyArray<MemberCell>, part: number): MemberCell =>
	defined(row[part], "a nested row holds each column of its sent layout")

/**
 * The array of column `part` of `rows` as a nested rows placeholder carries it (write/family/order.ts
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

/** A column's array of no element: an empty binary array's header for a text column, `{}` for any other. */
const emptyMeasure = (type: ScalarType): Measure =>
	type.carrier === "text"
		? { bytes: byteaHeaderBytes(0), units: 0 }
		: { bytes: "{}".length, units: "{}".length }

/** The array of column `part` over every row of `cells`, measured from its cells' lengths, none of it written. */
const columnMeasure = (cells: NestedCells, part: number): Measure => {
	const type = typeAt(cells, part)
	let measure: Measure | undefined
	for (const row of cells.rows) {
		const element = elementOf(type, cellAt(row, part))
		measure = measure === undefined ? aloneMeasure(element) : grownMeasure(measure, element)
	}
	return measure ?? emptyMeasure(type)
}

/** The bytes a placeholder's value adds to its Bind message's parameters. */
const paramBytes = (param: Param): number =>
	typeof param === "string" ? utf8Length(param) : param.byteLength

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
				row: { kind: "literal", column: widePart, limit: literalUnits, statement: "insert" }
			})
		}
		const bytes = alone.reduce((sum, m) => sum + m.bytes, fixed)
		if (bytes > messageBytes) {
			return Result.err({
				_tag: "NestedRowBound",
				relation: cells.relation,
				row: { kind: "message", bytes, limit: messageBytes, statement: "insert" }
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

/** A placeholder of nested rows as one execution binds it: its column's part, and its source's rows. */
export interface NestedPlaceholder {
	readonly part: number
	readonly cells: NestedCells
}

/**
 * A statement as its executions read it: its inline text, its staged form, and each placeholder's nested rows, by
 * position, none for a placeholder of any other value; the placeholders of one source share its cells.
 */
export interface StagedStatement {
	readonly sql: EmittedText
	readonly staged: Staged
	readonly nested: ReadonlyArray<NestedPlaceholder | undefined>
}

/**
 * A statement's executions (see the header): its one, inline, where it reads no nested rows or its Bind message, its
 * nested rows' arrays measured from their cells, fits the transport; otherwise its staged form's, each carrier created
 * and filled chunk by chunk, their ANALYZE, then the staged statement. `part` is what the statement itself does, which
 * its inline execution is. `encode` writes the value of the placeholder at a position that carries no nested rows.
 * Each array of nested rows is written once, in the executions that send it.
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
			const array = nestedColumn(slot.cells, slot.part, slot.cells.rows)
			if (!array.ok) {
				return array
			}
			params.push(array.value)
		}
		return Result.ok([{ sql: statement.sql, params, part }])
	}
	const staged = statement.staged
	if (staged.kind === "none") {
		return inline()
	}
	const { frame, messageBytes, literalUnits } = transport
	let bind = frame.statement
	let literalsFit = true
	for (const [position, slot] of statement.nested.entries()) {
		if (slot === undefined) {
			bind += frame.parameter + paramBytes(defined(values.get(position), "an encoded value"))
			continue
		}
		const measure = columnMeasure(slot.cells, slot.part)
		bind += frame.parameter + measure.bytes
		literalsFit &&= measure.units <= literalUnits
	}
	if (bind <= messageBytes && literalsFit) {
		return inline()
	}
	const out: Array<Execution> = []
	for (const carrier of staged.carriers) {
		const slots = mapNonEmpty(carrier.columns, (position) =>
			defined(statement.nested[position], "a carrier's column of nested rows")
		)
		const [{ cells }] = slots
		const parts = mapNonEmpty(slots, (slot) => slot.part)
		out.push({ sql: carrier.create, params: [], part: "create" })
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
			out.push({ sql: carrier.fill, params, part: "fill" })
		}
	}
	out.push({ sql: staged.analyze, params: [], part: "analyze" })
	out.push({
		sql: staged.sql,
		params: staged.kept.map((position) =>
			defined(values.get(position), "the value of a placeholder the staged statement keeps")
		),
		part
	})
	return Result.ok(out)
}
