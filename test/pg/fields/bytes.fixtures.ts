/** What the properties of bytes.test.ts read: its spaces, models and helpers. */

import { aimed, array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { bytesChunkLength } from "#compiler/codec/delivery.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

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
export const bodyOf = (value: Value): Uint8Array<ArrayBuffer> =>
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
			length: s.draw(element([1, 2])) * bytesChunkLength + s.draw(element([-1, 0, 1])),
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
export interface Drawn {
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

/**
 * One value just past the old bound, alone, one fact per apply: the one case of a value no hex text of one string holds,
 * 268,435,444 bytes, which no random arm draws. It was the old suite's kept case; a case aimed at "a value past the
 * old bound" draws it, so every run reaches it once, as the kept case ran once a run.
 */
const pastTheOldBound: Gen<Drawn> = (s) => ({
	values: [{ arm: "past the old bound", length: oldBound + 1, seed: s.draw(seed) }],
	batched: false,
	shelves: 1
})

export type Feature =
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

export const notes = (d: Drawn): ReadonlyArray<Feature> => {
	const c = bytesChunkLength
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

export const Blob = relation("Blob", { id: pg.integer, shelf: pg.integer, body: bytes }, ["id"])

/** Each id's rows one unit: a shelf's values are deleted, so Blob is mutable. */
export const Blobs = schema(
	"Bytes",
	[Shelf, Blob],
	[mutable(Blob), unit("Item", { id: pg.integer })]
)

/** Every bytes value with its shelf. */
const blobs = query(Blobs).rule((r) => {
	const { id, shelf, body } = v(Blob, "b")
	return r.match(Blob, { id, shelf, body }).find({ id, shelf, body })
})

/**
 * The full world's workload: shelves and bytes values written with the facts each call gives; every value read back,
 * and in descending id order; each shelf with its values attached; and a shelf's values deleted, the shelf a parameter.
 */
const programs = Object.freeze({
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
})

/** Whether two bytes values hold the same bytes. */
export const sameBytes = (x: Uint8Array, y: Uint8Array): boolean =>
	x.length === y.length && x.every((byte, at) => byte === y[at])

/**
 * Where a value read back first departs from the value written: the first offset whose bytes differ, or the shorter
 * length where one is the other's prefix; none where they hold the same bytes. A failure names that offset, never the
 * bytes, which reach 268,435,444 in the kept case and which no assertion's diff can print.
 */
export const firstDifference = (read: Uint8Array, written: Uint8Array): Option.Option<number> => {
	const shorter = Math.min(read.length, written.length)
	const at = read.subarray(0, shorter).findIndex((byte, i) => byte !== written[i])
	return at >= 0
		? Option.some(at)
		: read.length === written.length
			? Option.none()
			: Option.some(shorter)
}

/** Whether every value of `values` is an array over a buffer of its own, no two sharing one. */
export const ownBuffers = (values: ReadonlyArray<Uint8Array>): boolean =>
	Arr.every(values, (b) => b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) &&
	new Set(Arr.map(values, (b) => b.buffer)).size === values.length

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const blobsInstall = Object.freeze({ label: "bytes", programs })

/** Blobs installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const blobsTemplate = fixtureTemplate(import.meta, Blobs, blobsInstall)

/** A case of one value of exactly one or two chunks, which a random "about a chunk" value is a third of the time. */
const exactlyChunks: Gen<Drawn> = (s) => ({
	values: [
		{ arm: "about a chunk", length: s.draw(element([1, 2])) * bytesChunkLength, seed: s.draw(seed) }
	],
	batched: s.draw(boolean),
	shelves: s.draw(int(1, 3))
})

/** A case of eight to twelve values inserted by one batched apply. */
const manyBatched: Gen<Drawn> = (s) => ({
	values: s.draw(array(value, { min: 8, max: 12 })),
	batched: true,
	shelves: s.draw(int(1, 3))
})

/**
 * The cases, aimed: a case whose turn aims at a value past the old bound, a value of exactly a chunk or many rows in
 * one batched insert draws the case built to reach it, which a random case reaches seldom or never.
 */
export const space = aimed(cases, [
	["a value past the old bound", pastTheOldBound],
	["a value of exactly a chunk", exactlyChunks],
	["many rows in one batched insert", manyBatched]
])
