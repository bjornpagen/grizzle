/**
 * A statement's delivery against PostgreSQL 19 at chunk boundaries (lower/delivery.ts deliveredRows): rows of two
 * bytes columns and a text column, each value at a length about a boundary of a small chunk length, stored by db.apply
 * and read back by the delivered form of a read of their table, ordered and limited or not, under that chunk length.
 * PostgreSQL's answer reads strictly as the delivery the statement states (test/support/kernel/strict.ts
 * strictDelivered), and the library's assembly of it (codec/delivery.ts assembledIn) is exactly the rows stored, in the
 * statement's order. The chunk length is a parameter of both sides, so a case of a few bytes meets every boundary the
 * one in force meets at megabytes (test/pg/fields/bytes.test.ts).
 *
 * Oracle: the drawn rows themselves.
 *
 * Features: the vocabulary Feature below, each boundary a value's length meets.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, Order, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { assembledIn } from "#compiler/codec/delivery.ts"
import { deliveredRows, deliveryOfColumns } from "#compiler/lower/delivery.ts"
import { col, desc, lit, provedCore, table, targetAs, types } from "#compiler/sql/build.ts"
import { emitText, costChosen } from "#compiler/sql/emit.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import {
	answered,
	Blob,
	Blobs,
	blobsInstall,
	blobsTemplate,
	columns,
	deliveryCases,
	type Drawn,
	type Feature,
	notes,
	sameBytes,
	showDrawn,
	type Stored
} from "#test/pg/fields/delivery.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { strictDelivered } from "#test/support/kernel/strict.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { outputRows } from "#test/support/wire.ts"

/** A delivery at chunk boundaries reads back every row stored, in the statement's order, its chunks strictly its delivery's. */
export const aDeliveryAtChunkBoundariesReadsBackEveryRowStoredInTheStatementsOrderItsChunksStrictlyItsDeliverys =
	property.explore(deliveryCases, {
		needs: { blobs: Substrate.fresh(blobsTemplate) },
		situations: [
			"an answer of no row",
			"an empty value",
			"a value one short of its chunks",
			"a value of exactly its chunks",
			"a value one past its chunks",
			"a value of three chunks or more",
			"two values of different chunk counts in one row",
			"an ordered read",
			"a limited read"
		] satisfies ReadonlyArray<Reached<Feature>>,
		show: showDrawn,
		/** Its pre-conversion budget: runs 24, coverage cases 24 (delivery.test.ts at 4fbc3e95). */
		budget: { runs: 24, steered: 24 },
		check:
			({ blobs }, c: Case<Feature>) =>
			(d: Drawn) =>
				Effect.flatMap(blobs, (taken) =>
					Effect.provideService(
						Effect.scoped(
							Effect.gen(function* () {
								for (const feature of notes(d)) {
									c.note(feature)
								}
								const o = yield* openedIn(Blobs, {}, blobsInstall, taken)
								const s = yield* Substrate
								if (d.rows.length > 0) {
									yield* Effect.gen(function* () {
										const db = yield* Db.open(o.served.login.roles.app, {})
										const outcome = yield* db.workload.write.once({
											params: {},
											facts: { insert: { Blob: d.rows } }
										})
										assert.equal(outcome._tag, "accepted", "every row is written")
									}).pipe(
										(body) =>
											Effect.flatMap(Layer.build(o.served.layer), (context) =>
												Effect.provideContext(body, context)
											),
										Effect.scoped
									)
								}
								const names = namesOf(o.installed).installation.names
								const stored = names.relation(Blob.name)
								const column = (field: string) => names.column(Blob.name, field)
								const supply = new NameSupply({ relationStart: 0, columnStart: 1 })
								const r = supply.relation({ kind: "internal", purpose: "stored blobs" })
								const read = deliveredRows(
									{
										kind: "select",
										with: undefined,
										body: provedCore(
											"keyed",
											Arr.map(["id", "a", "b", "t"], (field) =>
												targetAs(col(r, column(field)), field)
											),
											[table(stored.schema, stored.name, r)],
											undefined
										),
										orderBy: d.ordered ? [desc(col(r, column("id")))] : [],
										limit: d.limit === undefined ? undefined : lit.int(d.limit, types.bigint),
										offset: undefined
									},
									columns,
									[],
									supply,
									d.chunkLength
								)
								const owner = yield* s.session(ownerSession())
								const values = yield* owner.values(
									emitText(read, supply.map(), costChosen).text,
									[]
								)
								const answer = Arr.map(values, (row) => Arr.map(row, answered))
								const delivery = deliveryOfColumns(columns)
								const strict = strictDelivered(delivery, answer, d.chunkLength)
								if (Result.isFailure(strict)) {
									throw new Error(`the answer is no delivery of its columns: ${strict.failure}`)
								}
								const library = assembledIn(delivery, outputRows(answer), d.chunkLength)
								const byId = Order.mapInput(Order.Number, (row: Stored) => row.id)
								const descending = Arr.reverse(Arr.sort(d.rows, byId))
								const expected = !d.ordered
									? d.rows
									: d.limit === undefined
										? descending
										: Arr.take(descending, d.limit)
								const keyOf = (cells: ReadonlyArray<unknown>): number => Number(cells[0])
								const got = d.ordered
									? library
									: Arr.sort(library, Order.mapInput(Order.Number, keyOf))
								assert.equal(got.length, expected.length, "one delivered row per row read")
								for (const [cells, row] of Arr.zip(got, expected)) {
									const [id, a, b, t] = cells
									assert.ok(typeof id === "string" && Number(id) === row.id, "the id")
									assert.ok(a instanceof Uint8Array && sameBytes(a, row.a), "the first bytes value")
									assert.ok(
										b instanceof Uint8Array && sameBytes(b, row.b),
										"the second bytes value"
									)
									assert.ok(t === row.t, "the text")
								}
							})
						),
						Substrate,
						taken.substrate
					)
				),
		oracle: { kind: "second-implementation", name: "the drawn rows themselves" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/delivery.ts",
				original: "\t\tconst offset = Number(rowText(row, chunkAt)) * chunkLength",
				replacement: "\t\tconst offset = Number(rowText(row, chunkAt)) * (chunkLength - 1)",
				why: "A delivered chunk is written at the wrong offset."
			},
			{
				file: "packages/engine/src/codec/delivery.ts",
				original: "\t\t.toSorted((a, b) => a.ord - b.ord)",
				replacement: "\t\t.toSorted((a, b) => b.ord - a.ord)",
				why: "The assembled rows come back in reverse order."
			}
		]
	})
