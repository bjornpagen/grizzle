/** What the properties of bytes-family.test.ts read: its spaces, models and helpers. */

import { aimed, array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { bytesChunkLength } from "#compiler/codec/delivery.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, drawn as drawnField, natural } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fin, mutable, on, ordered, relation, schema, unit } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { Id } from "#test/support/ids.ts"

/** `length` bytes of a xorshift stream from `seed`. */
export const streamBytes = (length: number, seed: number): Uint8Array<ArrayBuffer> => {
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
export interface Drawn {
	readonly values: ReadonlyArray<Value>
	readonly cut: number
}

const length: Gen<number> = weighted([
	[1, () => 0],
	[3, int(1, 64)],
	[2, (s) => s.draw(element([1, 2])) * bytesChunkLength + s.draw(element([-1, 0, 1]))]
])

/** A member's value of a drawn length and seed. */
const member: Gen<Value> = (r) => ({ length: r.draw(length), seed: r.draw(int(1, 0x7fff_ffff)) })

const cases: Gen<Drawn> = (s) => {
	const values = s.draw(array(member, { min: 1, max: 4 }))
	return { values, cut: s.draw(int(0, values.length - 1)) }
}

/**
 * A case whose first member is deleted and whose later members, re-placed, are of every kind a re-placed member is
 * noted by: an empty value, and one about two chunks (one short of, at or one past them), so of a chunk or more and of
 * several chunks.
 */
const everyKindReplaced: Gen<Drawn> = (s) => ({
	values: [
		s.draw(member),
		{ length: 0, seed: s.draw(int(1, 0x7fff_ffff)) },
		{
			length: 2 * bytesChunkLength + s.draw(element([-1, 0, 1])),
			seed: s.draw(int(1, 0x7fff_ffff))
		}
	],
	cut: 0
})

/** The cases, aimed: a case whose turn aims at a kind of re-placed member draws re-placed members of every kind. */
export const space = aimed(cases, [
	["a re-placed member of an empty value", everyKindReplaced],
	["a re-placed member of a chunk or more", everyKindReplaced],
	["a re-placed member of several chunks", everyKindReplaced]
])

export type Feature =
	| "the first member deleted"
	| "the last member deleted"
	| "a member re-placed"
	| "a re-placed member of an empty value"
	| "a re-placed member of a chunk or more"
	| "a re-placed member of several chunks"

export const notes = (d: Drawn): ReadonlyArray<Feature> => {
	const c = bytesChunkLength
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

const Owner = relation("Owner", { id: Id, badge: bytes, members: drawnField(natural) }, ["id"])

const Member = relation("Member", { id: Id, owner: Id, at: drawnField(natural), body: bytes }, [
	"id"
])

export const Files = schema(
	"BytesFamily",
	[Owner, Member],
	[
		ordered(on(Member, "owner", "at"), fin(Owner, "members")),
		mutable(Owner),
		mutable(Member),
		unit("File", { id: Id })
	]
)

/**
 * The full world's workload: an owner written with its members nested, the owners and the members read back, and a
 * member deleted, each with the facts each call gives.
 */
const programs = Object.freeze({
	insertOwner: ChangeSet.empty(Files).insert(Owner, []),
	owners: query(Files).rule((r) => {
		const { id, badge } = v(Owner, "o")
		return r.match(Owner, { id, badge }).find({ id, badge })
	}),
	members: query(Files).rule((r) => {
		const { id, owner, at, body } = v(Member, "m")
		return r.match(Member, { id, owner, at, body }).find({ id, at, body })
	}),
	deleteMember: ChangeSet.empty(Files).delete(Member, [])
})

/** Whether two bytes values hold the same bytes. */
export const sameBytes = (x: Uint8Array, y: Uint8Array): boolean =>
	x.length === y.length && x.every((byte, at) => byte === y[at])

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const filesInstall = Object.freeze({ label: "bytesfamily", programs })

/** Files installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const filesTemplate = fixtureTemplate(import.meta, Files, filesInstall)
