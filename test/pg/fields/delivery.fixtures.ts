/** What the property of delivery.test.ts reads: its cases, the Blob fixture and its template, and the delivery's columns. */
import {
	aimed,
	array,
	boolean,
	codePoint,
	constant,
	type Gen,
	int,
	map,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter } from "effect"
import { type DeliveredColumn, textColumn } from "#compiler/lower/delivery.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

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
export interface Stored {
	readonly id: number
	readonly a: Uint8Array<ArrayBuffer>
	readonly b: Uint8Array<ArrayBuffer>
	readonly t: string
}

/** A case: the chunk length, the rows, and the read's order and limit. */
export interface Drawn {
	readonly chunkLength: number
	readonly rows: ReadonlyArray<Stored>
	readonly ordered: boolean
	readonly limit: number | undefined
}

export type Feature =
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

/** The cases a witness draws: plain ones, or, while no case has answered no row (Pending `has`), each with no row
 * stored, the case it runs, prints and keeps. */
/** The cases, aimed at an answer of no row by a case that stores none. */
export const deliveryCases = aimed(cases, [
	["an answer of no row", map(cases, (d) => ({ ...d, rows: [] }))]
])

export const Blob = relation(
	"Blob",
	{ id: pg.integer, a: bytes, b: bytes, t: str.regex("^.*$", "su") },
	["id"]
)
export const Blobs = schema("Delivery", [Blob], [])

/** The full world's workload: Blob's rows written with the facts each call gives. */
const programs = Object.freeze({ write: ChangeSet.empty(Blobs).insert(Blob, []) })

/** The delivered columns of the read, in its order: id and t as texts, a and b as bytes. */
export const columns: ReadonlyArray<DeliveredColumn> = [
	textColumn,
	{ kind: "bytes" },
	{ kind: "bytes" },
	textColumn
]

/** A text PostgreSQL answered, as the substrate's session hands it back. */
export const answered = (cell: unknown): string => {
	if (typeof cell !== "string") {
		throw new Error(`a cell that is no text: ${Formatter.format(cell)}`)
	}
	return cell
}

/** Whether two bytes values hold the same bytes. */
export const sameBytes = (x: Uint8Array, y: Uint8Array): boolean =>
	x.length === y.length && x.every((byte, at) => byte === y[at])

export const notes = (d: Drawn): ReadonlyArray<Feature> => {
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

/** How a case prints: its chunk length, each row's value lengths and text, its order and its limit. */
export const showDrawn = (d: Drawn): string =>
	Formatter.format({
		chunkLength: d.chunkLength,
		rows: Arr.map(d.rows, (r) => ({ a: r.a.length, b: r.b.length, t: r.t })),
		ordered: d.ordered,
		limit: d.limit
	})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const blobsInstall = Object.freeze({ label: "delivery", programs })

/** Blobs installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const blobsTemplate = fixtureTemplate(import.meta, Blobs, blobsInstall)
