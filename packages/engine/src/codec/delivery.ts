/**
 * How a statement delivers its rows, a hot path: every read of a statement's answer goes through `assembled` once, so
 * its work is native loops over the answer's cells with no closure per cell.
 *
 * pg 8.23 reads every result cell as one UTF-8 string, so no cell carries a value longer than one JavaScript string
 * holds. A bytes column therefore never travels as a text: a statement whose columns include one sends each of its
 * rows as one result row per chunk of its longest bytes value (core/limits.ts bytesChunkLength), each chunk base64url
 * text, and `assembled` writes the chunks of each value into one fresh array over its own buffer. A row without a bytes
 * column travels whole, one result row each, its cells its columns' output texts. The one SQL form of either is
 * lower/delivery.ts's, built from the same `Delivery`, so the statement and its reader never disagree on a row's form,
 * and a bytes column's cell is never a text a reader could take for its value (core/decoder.ts bytesValueOf).
 */
import { bytesValueOf, rowCell, rowText } from "#compiler/core/decoder.ts"
import { defect } from "#compiler/core/invariant.ts"
import { bytesChunkLength } from "#compiler/core/limits.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { AssembledRows, Cell, OutputRows, OutputText } from "#compiler/core/wire.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/** How one delivered column's cell travels: as its output text, or, a bytes column's, as its value in chunks. */
export type CellKind = "text" | "bytes"

/** A column's cell kind by its type: a bytes column's value travels in chunks, every other column's as its text. */
export const cellKindOf = (type: ScalarType): CellKind =>
	type.carrier === "bytes" ? "bytes" : "text"

/**
 * A statement's delivery of rows of columns of the cell kinds `cells`, in output order, as `deliveryOf` alone builds
 * it:
 *
 * - whole, when no column is bytes: each result row is one delivered row, its cells its columns' output texts;
 * - chunked, when one is: each delivered row is the result rows `[ord, chunk, c1 … cn, l1 … lk]`, one per chunk of its
 *   longest bytes value, at least one. `ord` numbers the delivered rows in the statement's order, `chunk` numbers each
 *   one's result rows from 0, and `bytes` are the positions of its bytes columns among c1 … cn. Chunk 0 holds every
 *   text column's output text, each bytes column's length as its `l`, and every chunk its bytes columns' chunks: a
 *   bytes column's cell is the base64url text of its value's bytes from `chunk` times bytesChunkLength on, at most
 *   bytesChunkLength of them, empty past its end. A text column's cell and every `l` are empty past chunk 0.
 */
export type Delivery =
	| { readonly kind: "whole"; readonly cells: ReadonlyArray<CellKind> }
	| {
			readonly kind: "chunked"
			readonly cells: ReadonlyArray<CellKind>
			readonly bytes: NonEmptyReadonlyArray<number>
	  }

/** The delivery of rows of columns of the cell kinds `cells`, in output order. */
export const deliveryOf = (cells: ReadonlyArray<CellKind>): Delivery => {
	const bytes = cells.flatMap((kind, at) => (kind === "bytes" ? [at] : []))
	return isNonEmpty(bytes)
		? Object.freeze({ kind: "chunked", cells, bytes })
		: Object.freeze({ kind: "whole", cells })
}

/**
 * The position of a chunked result row's `ord`, its delivered row's number.
 *
 * @formatConstant a chunked result row's first cell
 */
const ordAt = 0

/**
 * The position of a chunked result row's `chunk`, its chunk's number within its delivered row.
 *
 * @formatConstant a chunked result row's second cell
 */
const chunkAt = 1

/**
 * The position of a chunked result row's first column cell, after its `ord` and `chunk`.
 *
 * @formatConstant a chunked result row's two leading cells
 */
const cellsFrom = 2

/** The cells of one result row of a delivery: its two leading numbers when chunked, its columns, its lengths. */
export const resultWidth = (delivery: Delivery): number => {
	switch (delivery.kind) {
		case "whole":
			return delivery.cells.length
		case "chunked":
			return cellsFrom + delivery.cells.length + delivery.bytes.length
	}
}

/** One delivered row as chunked result rows assemble it: its number, which orders it, and its cells. */
interface Assembling {
	readonly ord: number
	readonly cells: ReadonlyArray<Cell>
}

/**
 * The delivered rows of a chunked answer, in their `ord` order, each a row of its delivery's cells: a text column's
 * output text from its chunk 0, and a bytes column's value, a fresh array of its length, into which every chunk writes
 * its base64url text's bytes at `chunk` times `chunkLength`. The result rows arrive in any order, a delivered row's
 * chunk 0 not necessarily first, so the arrays are made in a first pass over the chunk 0 rows and filled in a second.
 * PostgreSQL wrote every row of grizzle's own statement, so nothing is checked: an `ord` that names no chunk 0 is a
 * defect.
 */
const assembleChunks = (
	delivery: Extract<Delivery, { readonly kind: "chunked" }>,
	rows: OutputRows,
	chunkLength: number
): AssembledRows => {
	const { cells, bytes } = delivery
	const lengthsFrom = cellsFrom + cells.length
	const byOrd = new Map<string, Assembling>()
	for (const row of rows) {
		if (rowText(row, chunkAt) !== "0") {
			continue
		}
		const ord = rowText(row, ordAt)
		const assembled: Array<Cell> = []
		let length = lengthsFrom
		for (const [at, kind] of cells.entries()) {
			if (kind === "text") {
				assembled.push(rowText(row, cellsFrom + at))
			} else {
				assembled.push(new Uint8Array(Number(rowText(row, length))))
				length += 1
			}
		}
		byOrd.set(ord, { ord: Number(ord), cells: Object.freeze(assembled) })
	}
	for (const row of rows) {
		const into = byOrd.get(rowText(row, ordAt))
		if (into === undefined) {
			throw defect("a chunk of a delivered row whose chunk 0 the answer holds")
		}
		const offset = Number(rowText(row, chunkAt)) * chunkLength
		for (const at of bytes) {
			bytesValueOf(rowCell(into.cells, at))
				.subarray(offset)
				.setFromBase64(rowText(row, cellsFrom + at), { alphabet: "base64url" })
		}
	}
	return Array.from(byOrd.values())
		.toSorted((a, b) => a.ord - b.ord)
		.map((row) => row.cells)
}

/**
 * A statement's answer as its delivery's rows, in the statement's order: a whole delivery's result rows themselves,
 * and a chunked one's assembled (assembleChunks), its bytes values in chunks of `chunkLength` bytes, the length its
 * statement sends (lower/delivery.ts).
 */
export const assembledIn = (
	delivery: Delivery,
	rows: OutputRows,
	chunkLength: number
): AssembledRows => {
	switch (delivery.kind) {
		case "whole":
			return rows
		case "chunked":
			return assembleChunks(delivery, rows, chunkLength)
	}
}

/** A statement's answer as its delivery's rows (assembledIn), in chunks of bytesChunkLength. */
export const assembled = (delivery: Delivery, rows: OutputRows): AssembledRows =>
	assembledIn(delivery, rows, bytesChunkLength.value)

/**
 * A UNION ALL of tagged deliveries' answer (lower/delivery.ts taggedArm) split by tag: each arm's result rows, its tag
 * dropped, in the order they arrived, for its own delivery to read (`assembled`).
 */
export const byTag = (rows: OutputRows): ReadonlyMap<string, OutputRows> => {
	const arms = new Map<string, Array<ReadonlyArray<OutputText>>>()
	for (const row of rows) {
		const [tag, ...rest] = row
		if (tag === undefined) {
			throw defect("a tagged delivery's row leads with its tag")
		}
		const arm = arms.get(tag)
		if (arm === undefined) {
			arms.set(tag, [rest])
		} else {
			arm.push(rest)
		}
	}
	return arms
}
