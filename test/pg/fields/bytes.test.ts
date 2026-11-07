import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, bytes as byteValues, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Order } from "effect"
import { Digest } from "effect/crypto"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A bytes field is written and read back whole, on PostgreSQL 19rc1: every value a case draws (the empty value, every
 * byte value 0x00 to 0xff in a drawn rotation, short drawn values, and a long value of a few MiB) is written through
 * db.apply, one fact per call or all in one batched insert, whose member array travels as a binary bytea[], and read
 * back by a query, whose cells are byteaout's hex text.
 *
 * Oracle: the drawn bytes themselves, and PostgreSQL's own octet_length and md5 of each stored value, read in the same
 * check beside Effect's md5 of the drawn bytes, lowercase hex as md5(bytea) writes it. Every value read back is a fresh
 * Uint8Array over its own buffer.
 */

/** The bytes of a long value: `length` bytes of a xorshift stream from `seed`, so a case draws two numbers, not MiB. */
const longBytes = (length: number, seed: number): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(length)
	let x = seed | 1
	for (let i = 0; i < length; i += 1) {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		out[i] = x & 0xff
	}
	return out
}

/** A drawn value and the arm it was drawn from. */
interface Value {
	readonly arm: "empty" | "every byte" | "short" | "long"
	readonly body: Uint8Array<ArrayBuffer>
}

/** Every byte value once, rotated by a drawn offset, so the value's first and last bytes move. */
const everyByte: Gen<Value> = (s) => {
	const offset = s.draw(int(0, 255))
	return {
		arm: "every byte",
		body: Uint8Array.from({ length: 256 }, (_, i) => (i + offset) & 0xff)
	}
}

const value: Gen<Value> = weighted<Value>([
	[1, () => ({ arm: "empty", body: new Uint8Array(0) })],
	[2, everyByte],
	[4, (s) => ({ arm: "short", body: Uint8Array.from(s.draw(byteValues({ min: 1, max: 64 }))) })]
])

/** A long value of 1 to 4 MiB. */
const long: Gen<Value> = (s) => ({
	arm: "long",
	body: longBytes(s.draw(int(1 << 20, 4 << 20)), s.draw(int(1, 0x7fff_ffff)))
})

/** A drawn case: its values, each a fact of its own id, and whether one apply inserts them all. */
interface Drawn {
	readonly values: ReadonlyArray<Value>
	readonly batched: boolean
}

const cases: Gen<Drawn> = (s) => {
	const batched = s.draw(boolean)
	const values = s.draw(array(value, batched ? { min: 1, max: 40 } : { min: 1, max: 4 }))
	const withLong = s.draw(boolean)
	return { values: withLong ? [...values, s.draw(long)] : values, batched }
}

type Feature =
	| "the empty value"
	| "every byte value"
	| "a long value"
	| "many rows in one batched insert"
	| "one fact per apply"

const Blob = relation("Blob", { id: pg.integer, body: bytes }, ["id"])
const Blobs = schema("Bytes", { Blob }, [])

layer(Layer.merge(Substrate.layer, Digest.layerWebCrypto), { excludeTestServices: true })(
	"bytes written and read back whole",
	(it) => {
		it.effect(
			"stores every drawn value exactly, single or batched, and reads each back as a fresh array of its bytes",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/fields/bytes",
							oracle: {
								kind: "second-implementation",
								name: "the drawn bytes, and PostgreSQL's octet_length and md5 beside Effect's md5"
							},
							draw: drawn(cases),
							literal: (d: Drawn) =>
								Formatter.format({
									batched: d.batched,
									values: Arr.map(d.values, (x) => ({ arm: x.arm, length: x.body.length }))
								}),
							coverage: required<Feature>(
								[
									"the empty value",
									"every byte value",
									"a long value",
									"many rows in one batched insert",
									"one fact per apply"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(d: Drawn, c: Case<Feature>) =>
							Effect.scoped(
								Effect.gen(function* () {
									const o = yield* installed(Blobs, {}, { label: "bytes", extensions: [] })
									const s = yield* Substrate
									const names = namesOf(o.installed)
									const facts = Arr.map(d.values, (x, id) => ({ id, body: x.body }))
									yield* Effect.gen(function* () {
										const db = yield* Db.open(o.server.roles.app, {})
										const batches = d.batched ? [facts] : Arr.map(facts, (fact) => [fact])
										for (const batch of batches) {
											const outcome = yield* db.apply(
												ChangeSet.empty(o.schema).insert(Blob, batch),
												{}
											)
											assert.equal(outcome.kind, "accepted", "every bytes value is written")
										}
										const read = yield* (yield* db.execute(
											query(o.schema).rule((r) => {
												const { id, body } = v(Blob, "b")
												return r.match(Blob, { id, body }).find({ id, body })
											}),
											{}
										)).collect
										const rows = Arr.sort(
											read,
											Order.mapInput(Order.Number, (row: { readonly id: number }) => row.id)
										)
										assert.deepEqual(
											Arr.map(rows, (row) => ({ id: row.id, body: row.body })),
											Arr.map(facts, (f) => ({ id: f.id, body: f.body })),
											"every value reads back as the bytes written"
										)
										assert.equal(
											Arr.every(
												rows,
												(row) =>
													row.body.byteOffset === 0 &&
													row.body.byteLength === row.body.buffer.byteLength
											),
											true,
											"every value read back is an array over a buffer of its own"
										)
										assert.equal(
											new Set(Arr.map(rows, (row) => row.body.buffer)).size,
											rows.length,
											"no two values read back share a buffer"
										)
									}).pipe(
										(body) =>
											Effect.flatMap(Layer.build(o.layer), (context) =>
												Effect.provideContext(body, context)
											),
										Effect.scoped
									)
									const owner = yield* s.session(ownerSession())
									const column = names.column(Blob, "body")
									const stored = yield* owner.values(
										`SELECT octet_length(${column})::text, md5(${column}) FROM ${names.table(Blob)} ORDER BY ${names.column(Blob, "id")}`,
										[]
									)
									const digest = yield* Digest.Digest
									const md5s = yield* Effect.forEach(facts, (f) =>
										digest.digestHex(Digest.md5, f.body)
									)
									assert.deepEqual(
										Arr.map(stored, (row) => Arr.map(row, (cell) => String(cell))),
										Arr.zipWith(facts, md5s, (f, md5) => [String(f.body.length), md5]),
										"PostgreSQL stores each value's length and bytes exactly"
									)
									for (const x of d.values) {
										if (x.arm === "empty") {
											c.note("the empty value")
										}
										if (x.arm === "every byte") {
											c.note("every byte value")
										}
										if (x.arm === "long") {
											c.note("a long value")
										}
									}
									if (d.batched && d.values.length >= 16) {
										c.note("many rows in one batched insert")
									}
									if (!d.batched) {
										c.note("one fact per apply")
									}
								})
							)
					)
				)
		)
	}
)
