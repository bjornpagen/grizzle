import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	type Gen,
	int,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Order, Result } from "effect"
import { compiledOpen } from "#adapter/db/open.ts"
import { assembledIn } from "#compiler/codec/delivery.ts"
import {
	type DeliveredColumn,
	deliveredRows,
	deliveryOfColumns,
	textColumn
} from "#compiler/lower/delivery.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { col, desc, lit, provedCore, table, targetAs, types } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { strictDelivered } from "#test/support/kernel/strict.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { outputRows } from "#test/support/wire.ts"
import { loginLayer } from "#test/support/worlds.ts"

/**
 * A statement's delivery against PostgreSQL 19rc1 at chunk boundaries (lower/delivery.ts deliveredRows): rows of two
 * bytes columns and a text column, each value at a length about a boundary of a small chunk length, stored by db.apply
 * and read back by the delivered form of a read of their table, ordered and limited or not, under that chunk length.
 * PostgreSQL's answer reads strictly as the delivery the statement states (test/support/kernel/strict.ts
 * strictDelivered), and the library's assembly of it (codec/delivery.ts assembledIn) is exactly the rows stored, in the
 * statement's order. The chunk length is a parameter of both sides, so a case of a few bytes meets every boundary the
 * one in force meets at megabytes (test/pg/fields/bytes.test.ts).
 *
 * Oracle: the drawn rows themselves.
 */

/** `length` bytes of a xorshift stream from `seed`. */
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

/** A stored row: its id, its two bytes values and its text. */
interface Stored {
	readonly id: number
	readonly a: Uint8Array<ArrayBuffer>
	readonly b: Uint8Array<ArrayBuffer>
	readonly t: string
}

/** A case: the chunk length, the rows, and the read's order and limit. */
interface Drawn {
	readonly chunkLength: number
	readonly rows: ReadonlyArray<Stored>
	readonly ordered: boolean
	readonly limit: number | undefined
}

type Feature =
	| "an answer of no row"
	| "an empty value"
	| "a value one short of its chunks"
	| "a value of exactly its chunks"
	| "a value one past its chunks"
	| "a value of three chunks or more"
	| "two values of different chunk counts in one row"
	| "an ordered read"
	| "a limited read"

/** A length about the boundaries of chunks of `chunk` bytes: none, one either side of k chunks, or any. */
const lengthAbout = (chunk: number): Gen<number> =>
	weighted([
		[1, constant(0)],
		[3, (s) => Math.max(0, s.draw(int(1, 4)) * chunk - 1)],
		[3, (s) => s.draw(int(1, 4)) * chunk],
		[3, (s) => s.draw(int(1, 4)) * chunk + 1],
		[2, int(0, 3 * chunk)]
	])

const cases: Gen<Drawn> = (s) => {
	const chunkLength = s.draw(int(1, 8))
	const values = s.draw(
		array(
			(r) => ({
				a: streamBytes(r.draw(lengthAbout(chunkLength)), r.draw(int(1, 0x7fff_ffff))),
				b: streamBytes(r.draw(lengthAbout(chunkLength)), r.draw(int(1, 0x7fff_ffff))),
				t: r.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 4 }))
			}),
			{ min: 0, max: 6 }
		)
	)
	const ordered = s.draw(boolean)
	const limit = ordered && s.draw(boolean) ? s.draw(int(0, 6)) : undefined
	return {
		chunkLength,
		rows: Arr.map(values, (v, id) => ({ id, ...v })),
		ordered,
		limit
	}
}

/** The case a witness runs: its drawn one, or, while no case has answered no row, the drawn one with no row stored. */
const aimed = (d: Drawn, c: Case<Feature>): Drawn =>
	Option.exists(c.steering, (pending) => pending.has("an answer of no row"))
		? { ...d, rows: [] }
		: d

const Blob = relation("Blob", { id: pg.integer, a: bytes, b: bytes, t: str.regex("^.*$", "su") }, [
	"id"
])
const Blobs = schema("Delivery", { Blob }, [])

/** The delivered columns of the read, in its order: id and t as texts, a and b as bytes. */
const columns: ReadonlyArray<DeliveredColumn> = [
	textColumn,
	{ kind: "bytes" },
	{ kind: "bytes" },
	textColumn
]

/** A text PostgreSQL answered, as the substrate's session hands it back. */
const answered = (cell: unknown): string => {
	if (typeof cell !== "string") {
		throw new Error(`a cell that is no text: ${Formatter.format(cell)}`)
	}
	return cell
}

/** Whether two bytes values hold the same bytes. */
const sameBytes = (x: Uint8Array, y: Uint8Array): boolean =>
	x.length === y.length && x.every((byte, at) => byte === y[at])

const notes = (d: Drawn): ReadonlyArray<Feature> => {
	const c = d.chunkLength
	const lengths = Arr.flatMap(d.rows, (r) => [r.a.length, r.b.length])
	const out: Array<Feature> = []
	if (d.rows.length === 0 || d.limit === 0) {
		out.push("an answer of no row")
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
	if (Arr.some(d.rows, (r) => Math.ceil(r.a.length / c) !== Math.ceil(r.b.length / c))) {
		out.push("two values of different chunk counts in one row")
	}
	if (d.ordered) {
		out.push("an ordered read")
	}
	if (d.limit !== undefined) {
		out.push("a limited read")
	}
	return out
}

layer(Substrate.layer, { excludeTestServices: true })("a delivery at chunk boundaries", (it) => {
	it.effect(
		"reads back every row stored, in the statement's order, its chunks strictly its delivery's",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/fields/delivery",
						oracle: { kind: "second-implementation", name: "the drawn rows themselves" },
						draw: drawn(cases),
						literal: (d: Drawn) =>
							Formatter.format({
								chunkLength: d.chunkLength,
								rows: Arr.map(d.rows, (r) => ({ a: r.a.length, b: r.b.length, t: r.t })),
								ordered: d.ordered,
								limit: d.limit
							}),
						coverage: required<Feature>(
							[
								"an answer of no row",
								"an empty value",
								"a value one short of its chunks",
								"a value of exactly its chunks",
								"a value one past its chunks",
								"a value of three chunks or more",
								"two values of different chunk counts in one row",
								"an ordered read",
								"a limited read"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 24,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnCase: Drawn, c: Case<Feature>) =>
						Effect.scoped(
							Effect.gen(function* () {
								const d = aimed(drawnCase, c)
								for (const feature of notes(d)) {
									c.note(feature)
								}
								const o = yield* installed(
									Blobs,
									{},
									{ label: "delivery", extensions: [], programs: {} }
								)
								const s = yield* Substrate
								if (d.rows.length > 0) {
									yield* Effect.gen(function* () {
										const db = yield* compiledOpen(o.server.roles.app, {})
										const outcome = yield* db.apply(
											ChangeSet.empty(o.schema).insert(Blob, d.rows),
											{}
										)
										assert.equal(outcome.kind, "accepted", "every row is written")
									}).pipe(
										(body) =>
											Effect.flatMap(Layer.build(loginLayer(o.installed, o.server)), (context) =>
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
								const values = yield* owner.values(emitText(read, supply.map()).text, [])
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
						)
				)
			)
	)
})
