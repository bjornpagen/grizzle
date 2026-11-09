import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Order } from "effect"
import { Digest } from "effect/crypto"
import { Db } from "#adapter/public/db.ts"
import { bytesChunkLength } from "#compiler/core/limits.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * A bytes field is written and read back whole, on PostgreSQL 19rc1: every value a case draws (the empty value, every
 * byte value 0x00 to 0xff in a drawn rotation, short drawn values, a long value of a few MiB, and values one short of,
 * at and one past a chunk of the delivery in force, core/limits.ts bytesChunkLength, and of several chunks) is written
 * through db.apply, one fact per call or all in one batched insert, whose member array travels as a binary bytea[], and
 * returned by the insert in chunks (codec/delivery.ts); then read back by a query, by its ordered form, which delivers
 * the rows in its order, and by a query of the shelves the values sit on with each shelf's values attached, a statement
 * of its own; and one shelf's values deleted, which the delete returns in chunks too. A kept case writes one value past
 * 268,435,443 bytes, the bound of a value whose hex text is one string.
 *
 * Oracle: the drawn bytes themselves, and PostgreSQL's own octet_length and md5 of each stored value, read in the same
 * check beside Effect's md5 of the drawn bytes, lowercase hex as md5(bytea) writes it. Every value read back is a fresh
 * Uint8Array over its own buffer.
 */

/** The bytes of a value: `length` bytes of a xorshift stream from `seed`, so a case draws two numbers, not MiB. */
const streamBytes = (length: number, seed: number): Uint8Array<ArrayBuffer> => {
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

type Arm = "empty" | "every byte" | "short" | "long" | "about a chunk" | "past the old bound"

/** A drawn value: the arm it was drawn from, its length and its seed, its bytes made when the case runs. */
interface Value {
	readonly arm: Arm
	readonly length: number
	readonly seed: number
}

/** A value's bytes: every byte value once, rotated by its seed, or its stream. */
const bodyOf = (value: Value): Uint8Array<ArrayBuffer> =>
	value.arm === "every byte"
		? Uint8Array.from({ length: 256 }, (_, i) => (i + value.seed) & 0xff)
		: streamBytes(value.length, value.seed)

const seed: Gen<number> = int(1, 0x7fff_ffff)

const value: Gen<Value> = weighted<Value>([
	[1, () => ({ arm: "empty", length: 0, seed: 1 })],
	[2, (s) => ({ arm: "every byte", length: 256, seed: s.draw(int(0, 255)) })],
	[4, (s) => ({ arm: "short", length: s.draw(int(1, 64)), seed: s.draw(seed) })],
	[
		2,
		(s) => ({
			arm: "about a chunk",
			length: s.draw(element([1, 2])) * bytesChunkLength.value + s.draw(element([-1, 0, 1])),
			seed: s.draw(seed)
		})
	]
])

/** A long value of 1 to 4 MiB. */
const long: Gen<Value> = (s) => ({
	arm: "long",
	length: s.draw(int(1 << 20, 4 << 20)),
	seed: s.draw(seed)
})

/** A drawn case: its values, each a fact of its own id, whether one apply inserts them all, and its shelves. */
interface Drawn {
	readonly values: ReadonlyArray<Value>
	readonly batched: boolean
	readonly shelves: number
}

const cases: Gen<Drawn> = (s) => {
	const batched = s.draw(boolean)
	const values = s.draw(array(value, batched ? { min: 1, max: 12 } : { min: 1, max: 4 }))
	const withLong = s.draw(boolean)
	return {
		values: withLong ? [...values, s.draw(long)] : values,
		batched,
		shelves: s.draw(int(1, 3))
	}
}

type Feature =
	| "the empty value"
	| "every byte value"
	| "a long value"
	| "a value one short of a chunk"
	| "a value of exactly a chunk"
	| "a value one past a chunk"
	| "a value of several chunks"
	| "a value past the old bound"
	| "many rows in one batched insert"
	| "one fact per apply"
	| "a shelf of two values or more"

/** The bound a value's hex text kept one string under, past which a value was refused before the chunked delivery. */
const oldBound = 268_435_443

/** One value just past the old bound, alone: the one case of a value no hex text of one string holds. */
const pastTheOldBound: Kept<Drawn, Feature> = {
	note: "one value of 268,435,444 bytes, one past the bound a value whose hex text is one string was held to",
	sketch: {
		values: [{ arm: "past the old bound", length: oldBound + 1, seed: 7 }],
		batched: false,
		shelves: 1
	},
	draws: "",
	reaches: ["a value past the old bound", "one fact per apply"]
}

const notes = (d: Drawn): ReadonlyArray<Feature> => {
	const c = bytesChunkLength.value
	const out: Array<Feature> = []
	for (const x of d.values) {
		if (x.arm === "empty") {
			out.push("the empty value")
		}
		if (x.arm === "every byte") {
			out.push("every byte value")
		}
		if (x.arm === "long") {
			out.push("a long value")
		}
		if (x.length > 0 && (x.length + 1) % c === 0) {
			out.push("a value one short of a chunk")
		}
		if (x.length > 0 && x.length % c === 0) {
			out.push("a value of exactly a chunk")
		}
		if (x.length > c && (x.length - 1) % c === 0) {
			out.push("a value one past a chunk")
		}
		if (x.length > c) {
			out.push("a value of several chunks")
		}
		if (x.length > oldBound) {
			out.push("a value past the old bound")
		}
	}
	if (d.batched && d.values.length >= 8) {
		out.push("many rows in one batched insert")
	}
	if (!d.batched) {
		out.push("one fact per apply")
	}
	if (d.values.length >= 2 * d.shelves) {
		out.push("a shelf of two values or more")
	}
	return out
}

const Shelf = relation("Shelf", { id: pg.integer }, ["id"])
const Blob = relation("Blob", { id: pg.integer, shelf: pg.integer, body: bytes }, ["id"])
const Blobs = schema("Bytes", { Shelf, Blob }, [])

/** Every bytes value with its shelf. */
const blobs = query(Blobs).rule((r) => {
	const { id, shelf, body } = v(Blob, "b")
	return r.match(Blob, { id, shelf, body }).find({ id, shelf, body })
})

/**
 * The full world's workload: shelves and bytes values written with the facts each call gives; every value read back,
 * and in descending id order; each shelf with its values attached; and a shelf's values deleted, the shelf a parameter.
 */
const programs = {
	shelve: ChangeSet.empty(Blobs).insert(Shelf, []),
	store: ChangeSet.empty(Blobs).insert(Blob, []),
	blobs,
	descending: blobs.orderBy(["id", "desc"]),
	onShelf: query(Blobs)
		.rule((r) => {
			const { id } = v(Shelf, "s")
			return r.match(Shelf, { id }).find({ id })
		})
		.attach(
			"blobs",
			(parent) =>
				query(Blobs).rule((r) => {
					const { id, body } = v(Blob, "b")
					return r.match(Blob, { id, shelf: parent.id, body }).find({ id, body })
				}),
			"array"
		),
	clearShelf: ChangeSet.empty(Blobs).delete(
		Blob,
		query(Blobs).rule((r) => {
			const { id, shelf, body } = v(Blob, "b")
			return r
				.match(Blob, { id, shelf, body })
				.where(r.eq(shelf, r.param("shelf", pg.integer)))
				.find({ id, shelf, body })
		})
	)
}

/** Whether two bytes values hold the same bytes. */
const sameBytes = (x: Uint8Array, y: Uint8Array): boolean =>
	x.length === y.length && x.every((byte, at) => byte === y[at])

/** Whether every value of `values` is an array over a buffer of its own, no two sharing one. */
const ownBuffers = (values: ReadonlyArray<Uint8Array>): boolean =>
	Arr.every(values, (b) => b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) &&
	new Set(Arr.map(values, (b) => b.buffer)).size === values.length

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
									shelves: d.shelves,
									values: Arr.map(d.values, (x) => ({ arm: x.arm, length: x.length }))
								}),
							coverage: required<Feature>(
								[
									"the empty value",
									"every byte value",
									"a long value",
									"a value one short of a chunk",
									"a value of exactly a chunk",
									"a value one past a chunk",
									"a value of several chunks",
									"many rows in one batched insert",
									"one fact per apply",
									"a shelf of two values or more"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [pastTheOldBound],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(d: Drawn, c: Case<Feature>) =>
							Effect.scoped(
								Effect.gen(function* () {
									for (const feature of notes(d)) {
										c.note(feature)
									}
									const o = yield* installed(
										Blobs,
										{},
										{ label: "bytes", extensions: [], programs }
									)
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
										const shelved = yield* db.workload.shelve.apply(
											{ Shelf: upTo(d.shelves, (id) => ({ id })) },
											{}
										)
										assert.equal(shelved.kind, "accepted", "every shelf is written")
										const batches = d.batched ? [facts] : Arr.map(facts, (fact) => [fact])
										for (const batch of batches) {
											const outcome = yield* db.workload.store.apply({ Blob: batch }, {})
											assert.equal(outcome.kind, "accepted", "every bytes value is written")
										}
										const executed = yield* db.workload.blobs.execute({})
										const collected = yield* executed.collect
										const read = Arr.sort(collected, byId)
										assert.deepEqual(
											Arr.map(read, (row) => ({ id: row.id, body: row.body })),
											Arr.map(facts, (f) => ({ id: f.id, body: f.body })),
											"every value reads back as the bytes written"
										)
										assert.ok(
											ownBuffers(Arr.map(read, (row) => row.body)),
											"every value read back is an array over a buffer of its own"
										)
										const ordered = yield* (yield* db.workload.descending.execute({})).collect
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
										const onShelves = yield* (yield* db.workload.onShelf.execute({})).collect
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
										const deleted = yield* db.workload.clearShelf.apply({ shelf })
										if (deleted.kind !== "accepted") {
											return assert.fail(`the shelf's values are deleted, not ${deleted.kind}`)
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
										`SELECT octet_length(${column})::text, md5(${column}) FROM ${names.table(Blob)} ORDER BY ${names.column(Blob, "id")}`,
										[]
									)
									const digest = yield* Digest.Digest
									const md5s = yield* Effect.forEach(kept, (f) =>
										digest.digestHex(Digest.md5, f.body)
									)
									assert.deepEqual(
										Arr.map(stored, (row) => Arr.map(row, (cell) => String(cell))),
										Arr.zipWith(kept, md5s, (f, md5) => [String(f.body.length), md5]),
										"PostgreSQL stores each value's length and bytes exactly"
									)
								})
							)
					)
				)
		)
	}
)
