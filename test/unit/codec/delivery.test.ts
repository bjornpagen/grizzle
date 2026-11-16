/**
 * A statement's delivery read back on the host (codec/delivery.ts assembledIn): rows of text and bytes columns, each
 * bytes value at a length about a chunk boundary, sent as their delivery's result rows in any order, assemble into
 * exactly the rows drawn, in their numbers' order, each bytes value a fresh array over a buffer of its own.
 *
 * Oracle: a second implementation, the delivery's result rows written from its specification (codec/delivery.ts
 * Delivery) with the platform's own base64url encoder, which shares no code with the assembly, then shuffled. The
 * chunk length is drawn small, so a case meets every boundary of a value of a few chunks, and the one in force
 * (bytesChunkLength) in some cases.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { assembledIn, deliveryOf } from "#compiler/codec/delivery.ts"
import { assert } from "#test/support/assert.ts"
import { outputRows } from "#test/support/wire.ts"
import {
	arrivedAt,
	cases,
	type Drawn,
	type Feature,
	notes,
	sameCell,
	sent
} from "#test/unit/codec/delivery.fixtures.ts"

/**
 * A statement's delivery assembles its result rows, in any order, into the rows sent, each bytes value a fresh array
 * of its bytes.
 *
 * Budget: its suite's count before the conversion (unit/codec/delivery: 200 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const aStatementsDeliveryAssemblesItsResultRowsInAnyOrderIntoTheRowsSentEachBytesValueAFreshArrayOfItsBytes =
	property.explore(cases, {
		needs: {},
		situations: [
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
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (d: Drawn) =>
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
					Arr.every(buffers, (b) => b.byteOffset === 0 && b.byteLength === b.buffer.byteLength),
					"every bytes value is an array over a buffer of its own"
				)
				assert.equal(
					new Set(Arr.map(buffers, (b) => b.buffer)).size,
					buffers.length,
					"no two bytes values share a buffer"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the delivery's result rows written from its specification with the platform's base64url"
		},
		show: (d: Drawn) =>
			Formatter.format({
				chunkLength: d.chunkLength,
				kinds: d.kinds,
				rows: Arr.map(d.rows, (cells) =>
					Arr.map(cells, (cell) => (typeof cell === "string" ? cell : cell.length))
				),
				ords: d.ords,
				arrival: d.arrival
			}),
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/delivery.ts",
				original: "\t\t.toSorted((a, b) => a.ord - b.ord)",
				replacement: "\t\t.toSorted((a, b) => b.ord - a.ord)",
				why: "The delivered rows of a chunked answer are assembled in the reverse of their numbers' order."
			}
		]
	})
