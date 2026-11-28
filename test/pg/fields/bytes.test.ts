/**
 * A bytes field is written and read back whole, on PostgreSQL 19: every value a case draws (the empty value, every
 * byte value 0x00 to 0xff in a drawn rotation, short drawn values, a long value of a few MiB, and values one short of,
 * at and one past a chunk of the delivery in force, bytesChunkLength, and of several chunks) is written
 * through db.apply, one fact per call or all in one batched insert, whose member array travels as a binary bytea[], and
 * returned by the insert in chunks (codec/delivery.ts); then read back by a query, by its ordered form, which delivers
 * the rows in its order, and by a query of the shelves the values sit on with each shelf's values attached, a statement
 * of its own; and one shelf's values deleted, which the delete returns in chunks too. A case aimed at it writes one
 * value past 268,435,443 bytes, the bound of a value whose hex text is one string, which every run reaches.
 *
 * Oracle: the drawn bytes themselves, and PostgreSQL's own octet_length and SHA-256 of each stored value, in lowercase
 * hex, read in the same check beside Effect's SHA-256 of the drawn bytes in lowercase hex. Every value read back is a
 * fresh Uint8Array over its own buffer.
 *
 * Features: the vocabulary Feature below, each value's length class and each path it is written and read by.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, Option, Order } from "effect"
import { Digest } from "effect/crypto"
import { Db } from "#adapter/public/db.ts"
import {
	Blob,
	Blobs,
	bodyOf,
	type Drawn,
	type Feature,
	firstDifference,
	notes,
	ownBuffers,
	sameBytes,
	space,
	blobsInstall,
	blobsTemplate
} from "#test/pg/fields/bytes.fixtures.ts"
import { writeAnswerOf, rowsOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** Bytes written and read back whole stores every drawn value exactly, single or batched, and reads each back as a fresh array of its bytes. */
export const bytesWrittenAndReadBackWholeStoresEveryDrawnValueExactlySingleOrBatchedAndReadsEachBackAsAFreshArrayOfItsBytes =
	property.explore(space, {
		needs: { fixture: Substrate.fresh(blobsTemplate) },
		situations: [
			"the empty value",
			"every byte value",
			"a long value",
			"a value one short of a chunk",
			"a value of exactly a chunk",
			"a value one past a chunk",
			"a value of several chunks",
			"a value past the old bound",
			"many rows in one batched insert",
			"one fact per apply",
			"a shelf of two values or more"
		] satisfies ReadonlyArray<Reached<Feature>>,
		/**
		 * Its pre-conversion runs, 8 (bytes.test.ts at 4fbc3e95), and the steered cases its witnesses need: the floor and
		 * 7 steered cases reach every required situation, 6 leave every byte value and many rows in one batched insert
		 * unreached (measured at TEST_SEED=1 on grizzle 01506d52; the witnesses are fixed by the property's identity). The
		 * old suite ran 8 cases and no coverage case at that seed; a whole steering window of 16 ran 26 cases a run.
		 */
		budget: { runs: 8, steered: 7 },
		check:
			({ fixture }, c: Case<Feature>) =>
			(d: Drawn) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.flatMap(Layer.build(Digest.layerWebCrypto), (digests) =>
							Effect.provideContext(
								Effect.scoped(
									Effect.gen(function* () {
										for (const feature of notes(d)) {
											c.note(feature)
										}
										const o = yield* openedIn(Blobs, {}, blobsInstall, taken)
										const s = yield* Substrate
										const names = namesOf(o.installed)
										const facts = Arr.map(d.values, (x, id) => ({
											id,
											shelf: id % d.shelves,
											body: bodyOf(x)
										}))
										const byId = Order.mapInput(
											Order.Number,
											(row: { readonly id: number }) => row.id
										)
										const shelf = 0
										const kept = Arr.filter(facts, (f) => f.shelf !== shelf)
										yield* Effect.gen(function* () {
											const db = yield* Db.open(o.served.login.roles.app, {})
											const shelved = yield* writeAnswerOf(
												db.workload.shelve.once({
													params: {},
													facts: { insert: { Shelf: upTo(d.shelves, (id) => ({ id })) } }
												})
											)
											assert.equal(shelved._tag, "accepted", "every shelf is written")
											const batches = d.batched ? [facts] : Arr.map(facts, (fact) => [fact])
											for (const batch of batches) {
												const outcome = yield* writeAnswerOf(
													db.workload.store.once({ params: {}, facts: { insert: { Blob: batch } } })
												)
												assert.equal(outcome._tag, "accepted", "every bytes value is written")
											}
											const collected = yield* rowsOf(
												db.workload.blobs.once({ params: {}, facts: {} })
											)
											const read = Arr.sort(collected, byId)
											assert.deepEqual(
												Arr.map(read, (row) => ({ id: row.id, length: row.body.length })),
												Arr.map(facts, (f) => ({ id: f.id, length: f.body.length })),
												"every value reads back at its id and the length written"
											)
											assert.deepEqual(
												Arr.flatten(
													Arr.zipWith(read, facts, (row, f) =>
														Option.toArray(
															Option.map(firstDifference(row.body, f.body), (at) => ({
																id: f.id,
																at
															}))
														)
													)
												),
												[],
												"every value reads back as the bytes written: no value departs at any offset"
											)
											assert.ok(
												ownBuffers(Arr.map(read, (row) => row.body)),
												"every value read back is an array over a buffer of its own"
											)
											const ordered = yield* rowsOf(
												db.workload.descending.once({ params: {}, facts: {} })
											)
											assert.deepEqual(
												Arr.map(ordered, (row) => row.id),
												Arr.reverse(Arr.map(facts, (f) => f.id)),
												"the ordered read delivers its rows in its order"
											)
											assert.ok(
												Arr.every(Arr.zip(ordered, Arr.reverse(facts)), ([row, f]) =>
													sameBytes(row.body, f.body)
												),
												"the ordered read delivers each value whole"
											)
											const onShelves = yield* rowsOf(
												db.workload.onShelf.once({ params: {}, facts: {} })
											)
											for (const row of onShelves) {
												const own = Arr.filter(facts, (f) => f.shelf === row.id)
												const attached = Arr.sort(row.blobs, byId)
												assert.equal(attached.length, own.length, "each shelf holds its values")
												assert.ok(
													Arr.every(
														Arr.zip(attached, own),
														([x, f]) => x.id === f.id && sameBytes(x.body, f.body)
													),
													"each attached value reads back whole"
												)
											}
											const deleted = yield* writeAnswerOf(
												db.workload.clearShelf.once({ params: { shelf }, facts: {} })
											)
											if (deleted._tag !== "accepted") {
												return assert.fail(`the shelf's values are deleted, not ${deleted._tag}`)
											}
											assert.equal(
												defined(
													Option.getOrUndefined(
														Arr.findFirst(deleted.counts, (n) => n.relation === "Blob")
													),
													"the deleted values' counts"
												).deleted,
												BigInt(facts.length - kept.length),
												"the delete returns every value it removed"
											)
										}).pipe(
											(body) =>
												Effect.flatMap(Layer.build(o.served.layer), (context) =>
													Effect.provideContext(body, context)
												),
											Effect.scoped
										)
										const owner = yield* s.session(ownerSession())
										const column = names.column(Blob, "body")
										const stored = yield* owner.values(
											`SELECT octet_length(${column})::text, encode(sha256(${column}), 'hex') FROM ${names.table(Blob)} ORDER BY ${names.column(Blob, "id")}`,
											[]
										)
										const digest = yield* Digest.Digest
										const sha256s = yield* Effect.forEach(kept, (f) =>
											digest.digestHex(Digest.sha256, f.body)
										)
										assert.deepEqual(
											Arr.map(stored, (row) => Arr.map(row, (cell) => String(cell))),
											Arr.zipWith(kept, sha256s, (f, sha256) => [String(f.body.length), sha256]),
											"PostgreSQL stores each value's length and bytes exactly"
										)
									})
								),
								digests
							)
						),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the drawn bytes, and PostgreSQL's octet_length and SHA-256 beside Effect's SHA-256"
		},
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
