/**
 * A statement's nested rows past one Bind message, carried through transaction carriers in the call's one flight.
 *
 * A family additions statement reads a stratum's nested rows of a relation as one array per column of their sent
 * layout (write/family/additions.ts), and PostgreSQL reads no Bind message longer than its longest message (core/
 * limits.ts messageMaxBytes), nor any array longer. The statement draws every family's indexes, counts and ends from
 * the rows it holds, and its laws judge what it writes at its end, so it is never run over a part of its rows: a fresh
 * owner's insert carries the count its whole family draws, which no part's members copy, and a mutable owner's
 * recount would write a count and ends one statement never writes. So the rows are moved, not the statement cut:
 *
 *   CREATE TEMPORARY TABLE "pg_temp"."__carrier_<k>" ("c5" uuid NOT NULL, "c6" bytea NOT NULL, ...) ON COMMIT DROP
 *   INSERT INTO "pg_temp"."__carrier_<k>" ("c5", "c6", ...)
 *     SELECT "r7"."c5", "r7"."c6", ... FROM (SELECT pg_catalog.unnest($1::uuid[]) AS "c5", ...) AS "r7"
 *   ... the fill again, once per chunk of the rows ...
 *   ANALYZE "pg_temp"."__carrier_<k>", ...
 *   <the statement, each nested rows FROM item "pg_temp"."__carrier_<k>" AS "r7", its other placeholders from $1>
 *
 * The staged form (`stagedOf`) is compiled with the statement: each FROM item that reads its nested rows' arrays reads
 * a carrier of the same columns under the same alias instead, and the placeholders left are numbered again in order.
 * The runtime (`executionsOf`) sends the statement inline where its Bind message, measured from the rows' encoded
 * lengths, fits the transport, and otherwise the carriers' creations, their fills, each chunk of the rows as long as
 * one fill's Bind message carries, their ANALYZE and the staged statement, in that order, every one in the call's
 * flight. The statement runs once over every row, so what it writes and what its laws judge are the inline
 * statement's. A carrier is the session's own, named after the program's carriers (sql/naming.ts carrierName), drops at
 * COMMIT, and a rollback drops it with the rest; the role creates it under the database's TEMPORARY privilege. Its
 * ANALYZE counts its rows before the statement joins them against stored relations, as the program's own carriers'
 * does (write/program/analyze.ts).
 */
import { byteaElementBytes, byteaHeaderBytes } from "#compiler/codec/bytea.ts"
import { literalAlone } from "#compiler/codec/recordset.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import type { Param } from "#compiler/core/wire.ts"
import type { LiteralBound } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { partIndex } from "#compiler/lower/template.ts"
import type {
	ArrayColumn,
	CreateCarrier,
	EmittedText,
	FromSource,
	Insert,
	SqlStatement
} from "#compiler/sql/ast.ts"
import { arrays, col, positionalValue, provedCore, select, target } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { type CarrierName, carrierName, emptyNameMap } from "#compiler/sql/naming.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import type { MemberCell } from "#compiler/write/family/draw.ts"
import { type Transport, typedColumnArray, type Unsendable } from "#compiler/write/family/order.ts"

/** A placeholder of a stratum's nested rows of `relation`: the column at `part` of their sent layout. */
export interface NestedColumnSlot {
	readonly stratum: StratumAt
	readonly relation: string
	readonly part: number
}

/** The column of nested rows a placeholder carries, none for any other. */
export const nestedColumnOf = (slot: WriteParamSlot): NestedColumnSlot | undefined =>
	slot.kind === "nestedRows"
		? { stratum: slot.stratum, relation: slot.relation, part: partIndex(slot.part) }
		: undefined

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

const noStaging: Staged = Object.freeze({ kind: "none" })

/** A FROM item reading a relation input's arrays, of at least one column. */
type ColumnsSource = Extract<FromSource, { readonly kind: "arrays" }> & {
	readonly source: { readonly kind: "columns" }
}

/** A FROM item of a statement's nested rows: the item, its columns, and the carrier it reads once staged. */
interface StagedSource {
	readonly item: ColumnsSource
	readonly columns: NonEmptyReadonlyArray<ArrayColumn>
	readonly carrier: CarrierName
}

/** Whether a FROM item reads a relation input's columns. */
const isColumnsSource = (source: FromSource): source is ColumnsSource =>
	source.kind === "arrays" && source.source.kind === "columns"

/** Every FROM item of `ast` that reads nested rows, in the transform's order, each with its carrier from `first`. */
const nestedSources = (
	ast: SqlStatement,
	nested: ReadonlyArray<NestedColumnSlot | undefined>,
	first: number
): ReadonlyArray<StagedSource> => {
	const found: Array<StagedSource> = []
	transformStatement(ast, {
		...identityHooks,
		replaceSource: (source) => {
			if (!isColumnsSource(source)) {
				return undefined
			}
			const columns = source.source.columns
			const of = columns.map((c) => nested[c.array.number - 1])
			if (of.every((slot) => slot === undefined)) {
				return undefined
			}
			const [head] = of
			if (
				head === undefined ||
				source.source.ordinal !== undefined ||
				!of.every(
					(slot) =>
						slot !== undefined && slot.stratum === head.stratum && slot.relation === head.relation
				)
			) {
				throw defect(
					"a FROM item of nested rows reads one stratum's rows of one relation alone, with no ordinal"
				)
			}
			found.push({ item: source, columns, carrier: carrierName(first + found.length) })
			return undefined
		}
	})
	return found
}

/** A carrier's CREATE TEMPORARY TABLE: a column per array of its FROM item, of its element type and collation. */
const createOf = (source: StagedSource): CreateCarrier => ({
	kind: "createCarrier",
	name: source.carrier,
	columns: source.columns.map((c) => ({
		name: c.definition.name,
		type: c.definition.type,
		collation: c.definition.collation,
		generated: undefined
	})),
	primaryKey: undefined
})

/** A carrier's fill: its FROM item's arrays, its placeholders numbered from $1 in column order, inserted whole. */
const fillOf = (source: StagedSource): Insert => {
	const alias = source.item.alias
	const columns = mapNonEmpty(source.columns, (c, i) => ({
		definition: c.definition,
		array: positionalValue(i + 1)
	}))
	return {
		kind: "insert",
		with: undefined,
		table: source.carrier,
		alias: undefined,
		overriding: undefined,
		onConflict: undefined,
		returning: [],
		columns: source.columns.map((c) => c.definition.name),
		source: {
			kind: "query",
			query: select(
				provedCore(
					"input",
					source.columns.map((c) => target(col(alias, c.definition.name))),
					[arrays({ kind: "columns", columns, ordinal: undefined }, alias)],
					undefined
				)
			)
		}
	}
}

/**
 * The staged form of a statement (see the header), its carriers named from the program's `first`-th: none where it
 * reads no nested rows. `nested` gives each of its placeholders, by position, the column of nested rows it carries, or
 * none. A placeholder of nested rows anywhere but the FROM item of their columns is a defect: a statement reads its
 * nested rows once, as one source.
 */
export const stagedOf = (
	ast: SqlStatement,
	nested: ReadonlyArray<NestedColumnSlot | undefined>,
	first: number
): Staged => {
	if (nested.every((slot) => slot === undefined)) {
		return noStaging
	}
	const sources = nestedSources(ast, nested, first)
	if (!isNonEmpty(sources)) {
		throw defect("a statement's placeholders of nested rows read in a FROM item of their columns")
	}
	const moved = new Set(sources.flatMap((s) => s.columns.map((c) => c.array.number)))
	const kept = nested.flatMap((_, i) => (moved.has(i + 1) ? [] : [i]))
	const numbered = new Map(kept.map((position, i) => [position + 1, i + 1] as const))
	const renumbered = (number: number): number =>
		defined(numbered.get(number), `placeholder $${number}, which no nested rows' FROM item carries`)
	const carriers = new Map<FromSource, CarrierName>(sources.map((s) => [s.item, s.carrier]))
	const staged = transformStatement(ast, {
		...identityHooks,
		replaceSource: (source) => {
			const carrier = carriers.get(source)
			return carrier === undefined || source.kind !== "arrays"
				? undefined
				: { kind: "table", table: carrier, alias: source.alias }
		},
		expr: (e) =>
			e.kind === "param" ? { ...e, slot: positionalValue(renumbered(e.slot.number)) } : e,
		fromSource: (source) => {
			if (source.kind !== "arrays") {
				return source
			}
			const read = source.source
			return read.kind === "count"
				? { ...source, source: { ...read, count: positionalValue(renumbered(read.count.number)) } }
				: {
						...source,
						source: {
							...read,
							columns: mapNonEmpty(read.columns, (c) => ({
								...c,
								array: positionalValue(renumbered(c.array.number))
							}))
						}
					}
		}
	})
	return Object.freeze({
		kind: "carriers",
		carriers: mapNonEmpty(sources, (s) =>
			Object.freeze({
				create: emitText(createOf(s), emptyNameMap).text,
				fill: emitText(fillOf(s), emptyNameMap).text,
				columns: mapNonEmpty(s.columns, (c) => c.array.number - 1)
			})
		),
		analyze: emitText(
			{ kind: "analyze", carriers: mapNonEmpty(sources, (s) => s.carrier) },
			emptyNameMap
		).text,
		sql: emitText(staged, emptyNameMap).text,
		kept: Object.freeze(kept)
	})
}

/** The carriers a staged form names, which the next statement's are numbered after. */
export const carriersOf = (staged: Staged): number =>
	staged.kind === "carriers" ? staged.carriers.length : 0

/**
 * What one execution of an artifact statement sends: the statement itself, inline or staged, or a chunk of a family
 * step; a staged carrier's creation, named by the relation of the rows it holds; a fill of a chunk of them; or the
 * carriers' ANALYZE.
 */
export type ExecutionPart =
	| { readonly kind: "statement" }
	| { readonly kind: "create"; readonly relation: string }
	| { readonly kind: "fill"; readonly relation: string }
	| { readonly kind: "analyze" }

/** One execution of an artifact statement: its text, its placeholders' values and what it is. */
export interface Execution {
	readonly sql: EmittedText
	readonly params: ReadonlyArray<Param>
	readonly part: ExecutionPart
}

/** The part of an execution that is its statement itself. */
export const statementPart: ExecutionPart = Object.freeze({ kind: "statement" })

const analyzePart: ExecutionPart = Object.freeze({ kind: "analyze" })

/**
 * A stratum's nested rows of one relation as their placeholders carry them: their sent layout's column types, and each
 * row's cells in the same order (write/family/draw.ts rowTexts).
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
 * and filled chunk by chunk, their ANALYZE, then the staged statement. `encode` writes the value of the placeholder at
 * a position that carries no nested rows. Each array of nested rows is written once, in the executions that send it.
 */
export const executionsOf = (
	statement: StagedStatement,
	encode: (position: number) => Result.Result<Param, LiteralBound | EncodingFailure>,
	transport: Transport
): Result.Result<ReadonlyArray<Execution>, LiteralBound | EncodingFailure | NestedRowBound> => {
	const values = new Map<number, Param>()
	for (const [position, slot] of statement.nested.entries()) {
		if (slot === undefined) {
			const value = encode(position)
			if (!value.ok) {
				return value
			}
			values.set(position, value.value)
		}
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
		return Result.ok([{ sql: statement.sql, params, part: statementPart }])
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
		out.push({
			sql: carrier.create,
			params: [],
			part: { kind: "create", relation: cells.relation }
		})
		const chunks = chunksOf(cells, parts, transport)
		if (!chunks.ok) {
			return chunks
		}
		for (const chunk of chunks.value) {
			const rows = cells.rows.slice(chunk.from, chunk.to)
			const params: Array<Param> = []
			for (const part of parts) {
				const array = nestedColumn(cells, part, rows)
				if (!array.ok) {
					return array
				}
				params.push(array.value)
			}
			out.push({ sql: carrier.fill, params, part: { kind: "fill", relation: cells.relation } })
		}
	}
	out.push({ sql: staged.analyze, params: [], part: analyzePart })
	out.push({
		sql: staged.sql,
		params: staged.kept.map((position) =>
			defined(values.get(position), "the value of a placeholder the staged statement keeps")
		),
		part: statementPart
	})
	return Result.ok(out)
}
