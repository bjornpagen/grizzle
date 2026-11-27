/**
 * How a statement delivers its rows, a hot path: every read of a statement's answer goes through `assembled` once, so
 * its work is native loops over the answer's cells with no closure per cell.
 *
 * pg 8.23 reads every result cell as one UTF-8 string, so no cell carries a value longer than one JavaScript string
 * holds. A bytes column therefore never travels as a text: a statement whose columns include one sends each of its
 * rows as one result row per chunk of its longest bytes value (bytesChunkLength), each chunk base64url
 * text, and `assembled` writes the chunks of each value into one fresh array over its own buffer. A row without a bytes
 * column travels whole, one result row each, its cells its columns' output texts. The one SQL form of either is
 * lower/delivery.ts's, built from the same `Delivery`, so the statement and its reader never disagree on a row's form,
 * and a bytes column's cell is never a text a reader could take for its value (core/decoder.ts bytesValueOf).
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { bytesValueOf, rowCell, rowText } from "#compiler/core/decoder.ts"
import { type AssembledRows, type Cell, intoWire, type OutputRows } from "#compiler/core/wire.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/**
 * The bytes of a bytes value one row of its delivery carries: a statement that delivers a bytes column sends each row as
 * one result row per chunk of this many bytes of its longest bytes value, each chunk base64url text
 * (codec/delivery.ts, lower/delivery.ts), since the driver reads every result cell as one string. Chunk i of a value is
 * its bytes from i times this on, and the host writes it there.
 *
 * @limitKind measured
 * @owner grizzle's bytes delivery (codec/delivery.ts, lower/delivery.ts)
 * @unit bytes
 * @scope one chunk of one bytes value in one result row
 * @evidence ~/.cache/grizzle-release/LIMITS/out/evidence/bytes/ on cassowary: bytes-2026-11-16T075151.json, the
 *   uncommitted record of `pnpm bench bytes` (bench/bytes/main.ts), and run.log, its console output with the machine's
 *   uptime before and after it. The first record, of 2026-11-14 08:03:32 to 08:06:35 UTC at grizzle 01cc8dda
 *   (bench/results/bytes/bytes-2026-11-14T080336.json in the clone it ran in), went with that clone
 * @observed 2026-11-16 07:51:46 to 07:56:04 UTC, one run
 * @environment cassowary, Ubuntu 26.04 on an AWS Graviton3 (Neoverse-V1, arm64) instance with 64 logical CPUs and 247
 *   GiB, Node 26.13.1, pg 8.23.1, PostgreSQL 19.0's TOAST slicing, lz4 and bytea functions, measured on the local
 *   19rc2 cluster family with scripts/pg/pin.env's three patches then, whose read path 19.0 keeps (git diff REL_19_RC2
 *   REL_19_0 -- src/backend/access/common src/backend/utils/adt/varlena.c src/backend/utils/adt/encode.c src/common
 *   src/backend/libpq is empty) and none of whose patches touched it, default_toast_compression lz4, grizzle ac71cfbb
 *   with lane LIMITS's move of the limits, which changes no delivery; load average 182 to 253 over the 64 CPUs from
 *   other sessions
 * @workload one row of one 256 MiB bytes value, once xorshift bytes, which PostgreSQL stores uncompressed, and once a
 *   repeating sentence, which it compresses, read back through its delivered SQL on one session and assembled, three
 *   runs a chunk length: 64 KiB to 64 MiB by factors of four for the random value, 1 MiB to 64 MiB for the repeating
 *   one
 * @result p50 of read and assembly in ms, random: 2,308 at 64 KiB, 1,588 at 256 KiB, 1,638 at 1 MiB, 1,538 at 4 MiB,
 *   1,637 at 16 MiB, 1,548 at 64 MiB; repeating: 15,845 at 1 MiB, 4,778 at 4 MiB, 2,487 at 16 MiB, 1,972 at 64 MiB,
 *   the square of the chunks since every chunk's substring decompresses the value from its start. Process rss after a
 *   case 2,067 to 3,984 MiB: 3,277 and 3,298 MiB at 16 MiB, 3,645 and 3,984 MiB at 64 MiB. Every value read back
 *   whole; no errors. The run of 2026-11-14 at load 5 to 8.5 found the same shape: random flat from 1 MiB, repeating
 *   1,544 ms at 16 MiB and 959 ms at 64 MiB
 * @decision 16 MiB: the random value's time is flat from 256 KiB on and no faster at 64 MiB, and the compressed
 *   value's falls with the square of the chunks to 2.5 s of 256 MiB at 16 MiB; 64 MiB saves the compressed value about
 *   0.5 s of 256 MiB for 350 to 700 MiB more rss, and a result row holds a base64url chunk of 4/3 of this for each
 *   bytes column its statement delivers within MaxAllocSize, which admits 47 such columns at 16 MiB and 11 at 64 MiB
 * @revalidate a PostgreSQL upgrade that changes TOAST slicing or the default compression; a driver or Node upgrade
 *   that changes how a result cell is read; a bytes value bound past 1 GiB
 */
export const bytesChunkLength = 16_777_216

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
			defect("a chunk of a delivered row whose chunk 0 the answer holds")
		}
		const offset = Number(rowText(row, chunkAt)) * chunkLength
		for (const at of bytes) {
			intoWire(bytesValueOf(rowCell(into.cells, at)).subarray(offset), rowText(row, cellsFrom + at))
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
	assembledIn(delivery, rows, bytesChunkLength)
