import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { bytesChunkLength } from "#compiler/core/limits.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, drawn as drawnField, natural, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fin, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A family's members carrying bytes, on PostgreSQL 19rc1: an owner is inserted with members nested in order, each
 * member's bytes value empty, short, or one short of, at or one past a chunk of the delivery in force
 * (core/limits.ts bytesChunkLength), or of several chunks; then one member is deleted, which re-places every later
 * sibling: grizzle reads the stored suffix, its bytes values in chunks (write/family/decode.ts), and writes each
 * re-placed member again whole, its bytes value in its column's binary array (write/family/order.ts columnArray).
 * Every member reads back at its slot with its bytes, before and after.
 *
 * Oracle: the drawn values, in slot order, less the one deleted.
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

/** A member's value: its length and its seed, its bytes made when the case runs. */
interface Value {
	readonly length: number
	readonly seed: number
}

/** A case: the members' values in slot order, and the slot of the one deleted. */
interface Drawn {
	readonly values: ReadonlyArray<Value>
	readonly cut: number
}

const length: Gen<number> = weighted([
	[1, () => 0],
	[3, int(1, 64)],
	[2, (s) => s.draw(element([1, 2])) * bytesChunkLength.value + s.draw(element([-1, 0, 1]))]
])

const cases: Gen<Drawn> = (s) => {
	const values = s.draw(
		array((r) => ({ length: r.draw(length), seed: r.draw(int(1, 0x7fff_ffff)) }), {
			min: 1,
			max: 4
		})
	)
	return { values, cut: s.draw(int(0, values.length - 1)) }
}

type Feature =
	| "the first member deleted"
	| "the last member deleted"
	| "a member re-placed"
	| "a re-placed member of an empty value"
	| "a re-placed member of a chunk or more"
	| "a re-placed member of several chunks"

const notes = (d: Drawn): ReadonlyArray<Feature> => {
	const c = bytesChunkLength.value
	const replaced = d.values.slice(d.cut + 1)
	const out: Array<Feature> = []
	if (d.cut === 0) {
		out.push("the first member deleted")
	}
	if (d.cut === d.values.length - 1) {
		out.push("the last member deleted")
	}
	if (replaced.length > 0) {
		out.push("a member re-placed")
	}
	if (Arr.some(replaced, (x) => x.length === 0)) {
		out.push("a re-placed member of an empty value")
	}
	if (Arr.some(replaced, (x) => x.length >= c)) {
		out.push("a re-placed member of a chunk or more")
	}
	if (Arr.some(replaced, (x) => x.length > c)) {
		out.push("a re-placed member of several chunks")
	}
	return out
}

const Owner = relation("Owner", { id: uuid, members: drawnField(natural) }, ["id"])
const Member = relation("Member", { id: uuid, owner: uuid, at: drawnField(natural), body: bytes }, [
	"id"
])
const Files = schema("BytesFamily", { Owner, Member }, [
	ordered(on(Member, "owner", "at"), fin(Owner, "members")),
	mutable(Owner)
])

/** Whether two bytes values hold the same bytes. */
const sameBytes = (x: Uint8Array, y: Uint8Array): boolean =>
	x.length === y.length && x.every((byte, at) => byte === y[at])

layer(Substrate.layer, { excludeTestServices: true })("a family's bytes members", (it) => {
	it.effect(
		"read their stored suffix in chunks and write each re-placed member's bytes whole",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/fields/bytes-family",
						oracle: {
							kind: "second-implementation",
							name: "the drawn values in slot order, less the one deleted"
						},
						draw: drawn(cases),
						literal: (d: Drawn) =>
							Formatter.format({ lengths: Arr.map(d.values, (x) => x.length), cut: d.cut }),
						coverage: required<Feature>(
							[
								"the first member deleted",
								"the last member deleted",
								"a member re-placed",
								"a re-placed member of an empty value",
								"a re-placed member of a chunk or more",
								"a re-placed member of several chunks"
							],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 12,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(d: Drawn, c: Case<Feature>) =>
						Effect.scoped(
							Effect.gen(function* () {
								for (const feature of notes(d)) {
									c.note(feature)
								}
								const o = yield* installed(Files, {}, { label: "bytesfamily", extensions: [] })
								yield* Effect.gen(function* () {
									const db = yield* Db.open(o.server.roles.app, {})
									const owner = uuidOf(1)
									const members = Arr.map(d.values, (x, i) => ({
										id: uuidOf(100 + i),
										body: streamBytes(x.length, x.seed)
									}))
									const inserted = yield* db.apply(
										ChangeSet.empty(o.schema).insert(Owner, [{ id: owner, members }]),
										{}
									)
									assert.equal(inserted.kind, "accepted", "the owner and its members are written")
									const stored = query(o.schema).rule((r) => {
										const { id, owner: of, at, body } = v(Member, "m")
										return r.match(Member, { id, owner: of, at, body }).find({ id, at, body })
									})
									const bySlot = Order.mapInput(
										Order.BigInt,
										(row: { readonly at: bigint }) => row.at
									)
									const readBack = (expected: ReadonlyArray<(typeof members)[number]>) =>
										Effect.gen(function* () {
											const result = yield* db.execute(stored, {})
											const collected = yield* result.collect
											const rows = Arr.sort(collected, bySlot)
											assert.equal(rows.length, expected.length, "every member reads back")
											for (const [i, [row, member]] of Arr.zip(rows, expected).entries()) {
												assert.equal(row.at, BigInt(i), "a member reads back at its slot")
												assert.equal(row.id, member.id, "the member at its slot")
												assert.ok(
													sameBytes(row.body, member.body),
													"a member's bytes read back whole"
												)
											}
										})
									yield* readBack(members)
									const cut = defined(members[d.cut], "the member deleted")
									const deleted = yield* db.apply(
										ChangeSet.empty(o.schema).delete(Member, [
											{ id: cut.id, owner, body: cut.body }
										]),
										{}
									)
									assert.equal(deleted.kind, "accepted", "the member is deleted")
									yield* readBack(Arr.filter(members, (m) => m.id !== cut.id))
								}).pipe(
									(body) =>
										Effect.flatMap(Layer.build(o.layer), (context) =>
											Effect.provideContext(body, context)
										),
									Effect.scoped
								)
							})
						)
				)
			)
	)
})
