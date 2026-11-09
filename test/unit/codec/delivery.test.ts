/**
 * A statement's delivery read back on the host (codec/delivery.ts assembledIn): rows of text and bytes columns, each
 * bytes value at a length about a chunk boundary, sent as their delivery's result rows in any order, assemble into
 * exactly the rows drawn, in their numbers' order, each bytes value a fresh array over a buffer of its own.
 *
 * Oracle: a second implementation, the delivery's result rows written from its specification (codec/delivery.ts
 * Delivery) with the platform's own base64url encoder, which shares no code with the assembly, then shuffled. The
 * chunk length is drawn small, so a case meets every boundary of a value of a few chunks, and the one in force
 * (core/limits.ts bytesChunkLength) in some cases.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	shuffled,
	string,
	codePoint,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { assembledIn, type CellKind, deliveryOf } from "#compiler/codec/delivery.ts"
import { maxOf } from "#compiler/core/array.ts"
import { bytesChunkLength } from "#compiler/core/limits.ts"
import type { Cell } from "#compiler/core/wire.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"
import { outputRows } from "#test/support/wire.ts"

/** A drawn cell: a text column's text, or a bytes column's value. */
type DrawnCell = string | Uint8Array<ArrayBuffer>

/** A case: its chunk length, its columns' kinds, its rows, their numbers, and the order its result rows arrive in. */
interface Drawn {
	readonly chunkLength: number
	readonly kinds: ReadonlyArray<CellKind>
	readonly rows: ReadonlyArray<ReadonlyArray<DrawnCell>>
	readonly ords: ReadonlyArray<number>
	readonly arrival: ReadonlyArray<number>
}

type Feature =
	| "whole rows"
	| "an empty value"
	| "a value one short of its chunks"
	| "a value of exactly its chunks"
	| "a value one past its chunks"
	| "a value of three chunks or more"
	| "two bytes values of different chunk counts in one row"
	| "a later chunk arriving before chunk 0"
	| "rows numbered with gaps"
	| "the chunk length in force"

/**
 * The period of a long value's bytes: a prime, so no chunk length a case meets is a multiple of it, and a chunk written
 * at another chunk's offset holds other bytes.
 */
const period = 4093

/**
 * `length` bytes of a xorshift stream from `seed`, its first `period` repeated past them, so a case draws two numbers,
 * not the bytes, and a value of many MiB is made at native speed.
 */
const streamBytes = (length: number, seed: number): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(length)
	let x = seed | 1
	for (let i = 0; i < Math.min(length, period); i += 1) {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		out[i] = x & 0xff
	}
	for (let filled = period; filled < length; filled *= 2) {
		out.copyWithin(filled, 0, Math.min(filled, length - filled))
	}
	return out
}

/** A bytes value's length about the boundaries of chunks of `chunk` bytes: none, one either side of k chunks, or any. */
const lengthAbout = (chunk: number): Gen<number> =>
	weighted([
		[1, constant(0)],
		[3, (s) => Math.max(0, s.draw(int(1, 4)) * chunk - 1)],
		[3, (s) => s.draw(int(1, 4)) * chunk],
		[3, (s) => s.draw(int(1, 4)) * chunk + 1],
		[2, int(0, 3 * chunk)]
	])

/** A text column's text: a few printable characters, empty included. */
const text: Gen<string> = string(codePoint(0x20, 0x7e), { min: 0, max: 6 })

const cases: Gen<Drawn> = (s) => {
	const chunkLength = s.draw(
		weighted([
			[1, constant(bytesChunkLength.value)],
			[19, int(1, 8)]
		])
	)
	const kinds = s.draw(array(element(["text", "bytes"] as const), { min: 1, max: 4 }))
	const rows = s.draw(
		array(
			(r) =>
				Arr.map(kinds, (kind): DrawnCell =>
					kind === "text"
						? r.draw(text)
						: streamBytes(r.draw(lengthAbout(chunkLength)), r.draw(int(1, 0x7fff_ffff)))
				),
			{ min: 0, max: 5 }
		)
	)
	const ords: Array<number> = []
	let ord = 0
	for (const _ of rows) {
		ord += s.draw(
			weighted([
				[4, constant(1)],
				[1, int(2, 4)]
			])
		)
		ords.push(ord)
	}
	const count = sent(kinds, rows, ords, chunkLength).length
	const order = Array.from({ length: count }, (_, i) => i)
	const arrival = kinds.includes("bytes")
		? s.draw(shuffled(order, { min: count, max: count }))
		: order
	return { chunkLength, kinds, rows, ords, arrival }
}

/** The bytes values of a row's cells. */
const valuesOf = (cells: ReadonlyArray<DrawnCell>): ReadonlyArray<Uint8Array<ArrayBuffer>> =>
	Arr.flatMap(cells, (cell) => (typeof cell === "string" ? [] : [cell]))

/** How many result rows a row of `cells` takes: the chunks of its longest bytes value, at least one. */
const resultRowsOf = (cells: ReadonlyArray<DrawnCell>, chunk: number): number =>
	maxOf(
		Arr.map(valuesOf(cells), (value) => Math.ceil(value.length / chunk)),
		1
	)

/** A text column's cell: a bytes value where one stands is the case's own error. */
const textOf = (cell: DrawnCell): string => {
	if (typeof cell !== "string") {
		throw new Error("a bytes value in a text column")
	}
	return cell
}

/**
 * The result rows a delivery of columns of `kinds` sends for `rows`, numbered by `ords`, written from its
 * specification: with no bytes column, each row its texts; else per row one result row per chunk,
 * `[ord, chunk, cells…, lengths…]`, a text on chunk 0 and empty after it, a bytes value's chunk its bytes from
 * chunk · `chunk` on, at most `chunk` of them, in base64url without padding, and each length on chunk 0.
 */
const sent = (
	kinds: ReadonlyArray<CellKind>,
	rows: ReadonlyArray<ReadonlyArray<DrawnCell>>,
	ords: ReadonlyArray<number>,
	chunk: number
): ReadonlyArray<ReadonlyArray<string>> =>
	!kinds.includes("bytes")
		? Arr.map(rows, (cells) => Arr.map(cells, textOf))
		: Arr.flatMap(rows, (cells, r) =>
				upTo(resultRowsOf(cells, chunk), (i) => [
					String(ords[r]),
					String(i),
					...Arr.map(cells, (cell) =>
						typeof cell === "string"
							? i === 0
								? cell
								: ""
							: cell
									.subarray(i * chunk, (i + 1) * chunk)
									.toBase64({ alphabet: "base64url", omitPadding: true })
					),
					...Arr.map(valuesOf(cells), (value) => (i === 0 ? String(value.length) : ""))
				])
			)

/** Whether two cells hold one value: equal texts, or bytes values of equal bytes. */
const sameCell = (a: Cell, b: DrawnCell): boolean =>
	typeof a === "string" || typeof b === "string"
		? a === b
		: a.length === b.length && a.every((byte, at) => byte === b[at])

/** The result row the case sent `at`th: its arrival order is a permutation of the rows sent. */
const arrivedAt = (
	raw: ReadonlyArray<ReadonlyArray<string>>,
	at: number
): ReadonlyArray<string> => {
	const row = raw[at]
	if (row === undefined) {
		throw new Error(`no result row ${at}`)
	}
	return row
}

const notes = (d: Drawn, raw: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<Feature> => {
	const out: Array<Feature> = []
	const lengths = Arr.flatMap(d.rows, (cells) => Arr.map(valuesOf(cells), (v) => v.length))
	const c = d.chunkLength
	if (!d.kinds.includes("bytes")) {
		out.push("whole rows")
	}
	if (lengths.includes(0)) {
		out.push("an empty value")
	}
	if (Arr.some(lengths, (n) => n > 0 && (n + 1) % c === 0)) {
		out.push("a value one short of its chunks")
	}
	if (Arr.some(lengths, (n) => n > 0 && n % c === 0)) {
		out.push("a value of exactly its chunks")
	}
	if (Arr.some(lengths, (n) => n > c && (n - 1) % c === 0)) {
		out.push("a value one past its chunks")
	}
	if (Arr.some(lengths, (n) => n > 2 * c)) {
		out.push("a value of three chunks or more")
	}
	if (
		Arr.some(d.rows, (cells) => {
			const counts = Arr.map(valuesOf(cells), (v) => Math.ceil(v.length / c))
			return new Set(counts).size > 1
		})
	) {
		out.push("two bytes values of different chunk counts in one row")
	}
	const seen = new Set<string>()
	for (const at of d.arrival) {
		const [ord, chunk] = arrivedAt(raw, at)
		if (chunk !== "0" && ord !== undefined && !seen.has(ord)) {
			out.push("a later chunk arriving before chunk 0")
		}
		if (chunk === "0" && ord !== undefined) {
			seen.add(ord)
		}
	}
	if (Arr.some(d.ords, (ord, i) => ord !== i + 1)) {
		out.push("rows numbered with gaps")
	}
	if (c === bytesChunkLength.value) {
		out.push("the chunk length in force")
	}
	return out
}

describe("a statement's delivery", () => {
	it.effect(
		"assembles its result rows, in any order, into the rows sent, each bytes value a fresh array of its bytes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/delivery",
						oracle: {
							kind: "second-implementation",
							name: "the delivery's result rows written from its specification with the platform's base64url"
						},
						draw: drawn(cases),
						literal: (d: Drawn) =>
							Formatter.format({
								chunkLength: d.chunkLength,
								kinds: d.kinds,
								rows: Arr.map(d.rows, (cells) =>
									Arr.map(cells, (cell) => (typeof cell === "string" ? cell : cell.length))
								),
								ords: d.ords,
								arrival: d.arrival
							}),
						coverage: required<Feature>(
							[
								"whole rows",
								"an empty value",
								"a value one short of its chunks",
								"a value of exactly its chunks",
								"a value one past its chunks",
								"a value of three chunks or more",
								"two bytes values of different chunk counts in one row",
								"a later chunk arriving before chunk 0",
								"rows numbered with gaps",
								"the chunk length in force"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d: Drawn, c) =>
						Effect.sync(() => {
							const raw = sent(d.kinds, d.rows, d.ords, d.chunkLength)
							for (const feature of notes(d, raw)) {
								c.note(feature)
							}
							const rows = assembledIn(
								deliveryOf(d.kinds),
								outputRows(Arr.map(d.arrival, (at) => arrivedAt(raw, at))),
								d.chunkLength
							)
							assert.equal(rows.length, d.rows.length, "one delivered row per row sent")
							for (const [got, want] of Arr.zip(rows, d.rows)) {
								assert.equal(got.length, want.length, "one cell per column")
								for (const [x, y] of Arr.zip(got, want)) {
									assert.ok(sameCell(x, y), "every cell holds the value sent")
								}
							}
							const buffers = Arr.flatMap(rows, (cells) =>
								Arr.flatMap(cells, (cell) => (typeof cell === "string" ? [] : [cell]))
							)
							assert.ok(
								Arr.every(
									buffers,
									(b) => b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
								),
								"every bytes value is an array over a buffer of its own"
							)
							assert.equal(
								new Set(Arr.map(buffers, (b) => b.buffer)).size,
								buffers.length,
								"no two bytes values share a buffer"
							)
						})
				)
			)
	)
})
