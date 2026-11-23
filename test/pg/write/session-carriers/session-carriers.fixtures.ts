/** What the property of session-carriers.test.ts reads: its schema, its shapes and each case's run. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import {
	attemptLabel,
	installWrites,
	observedChange,
	openFull,
	type ProbeSession
} from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	contained,
	counted,
	fin,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"

const Owner = relation("Owner", { id: pg.integer, v: pg.bigint, n: drawn(natural) }, ["id"])

const Item = relation(
	"Item",
	{ id: pg.integer, owner: pg.integer, cv: accumulated(pg.bigint, 0n) },
	["id"]
)

/**
 * A relation whose `w` is a candidate key, so its put deletes the facts it displaces and inserts its own, never updated
 * in place (write/put/choose.ts candidateKey).
 */
const Fixed = relation("Fixed", { id: pg.integer, w: pg.integer }, ["id"])

/**
 * Owners counting their items, each item copying its owner's v, and the candidate-keyed Fixed beside them, each
 * mutable inside the unit of its id.
 */
const build = (name: string) =>
	schema(
		name,
		[Owner, Item, Fixed],
		[
			counted(on(Item, "owner"), fin(Owner, "n")),
			contained(on(Item, "owner", "cv"), on(Owner, "id", "v")),
			key(on(Fixed, "w")),
			mutable(Owner),
			mutable(Item),
			mutable(Fixed),
			unit("Row", { id: pg.integer })
		]
	)

type Schema = ReturnType<typeof build>

/**
 * The shapes, each a write whose facts two or more of its statements read, so its program carries them in carriers of
 * its own (write/program/slot-carriers.ts), and each one a session repeats over its own last state: a candidate-keyed
 * relation put, its displacing deletion and its insert; and owners put, the UPDATE of the owners, their items refilled
 * and recounted.
 */
const shapes = ["a candidate-keyed relation put", "owners put"] as const

export type Shape = (typeof shapes)[number]

/** The keys each write names: one, and 256. */
const sizes = [1, 256] as const

type Size = (typeof sizes)[number]

/** A case: a shape, and the keys each of its writes names. */
export interface Sketch {
	readonly shape: Shape
	readonly keys: Size
}

export const sketchGen: Gen<Sketch> = (source) => ({
	shape: source.draw(element(shapes)),
	keys: source.draw(element(sizes))
})

export type Situation = `${Shape} at ${Size}`

export const situations: ReadonlyArray<Situation> = Arr.flatMap(shapes, (shape) =>
	Arr.map(sizes, (keys): Situation => `${shape} at ${keys}`)
)

/** The writes a case runs in its one session, one after another. */
const writes = 3

/** The owners stored before a case's writes, each with two items, and a Fixed fact per owner, each of its own w. */
const owners = 256

const seedOf = (s: Schema) =>
	ChangeSet.empty(s)
		.insert(
			Owner,
			Arr.map(indices(owners), (id) => ({ id, v: 0n }))
		)
		.insert(
			Item,
			Arr.flatMap(indices(owners), (o) => Arr.map(indices(2), (i) => ({ id: 2 * o + i, owner: o })))
		)
		.insert(
			Fixed,
			Arr.map(indices(owners), (id) => ({ id, w: id }))
		)

/** The `k`-th write of a case, from 1: its shape over its keys, every value written `k`. */
const writeOf = (s: Schema, sketch: Sketch, k: number) => {
	const named = indices(sketch.keys)
	switch (sketch.shape) {
		case "a candidate-keyed relation put":
			return ChangeSet.empty(s).put(
				Fixed,
				Arr.map(named, (id) => ({ id, w: k * owners + id }))
			)
		case "owners put":
			return ChangeSet.empty(s).put(
				Owner,
				Arr.map(named, (id) => ({ id, v: BigInt(k) }))
			)
	}
}

/** A carrier of the session as a write's transaction holds it just before its COMMIT: its relation and its size. */
interface HeldCarrier {
	readonly oid: number
	readonly name: string
	/** pg_total_relation_size: its heap, its TOAST table and its key's index, in bytes. */
	readonly bytes: number
}

/** What one write's transaction held just before its COMMIT: its backend, and the session's carriers, by name. */
interface Held {
	readonly backend: number
	readonly carriers: ReadonlyArray<HeldCarrier>
}

/** The backend and the carriers the session's temporary schema holds, read inside the write's transaction. */
const heldIn = (session: ProbeSession) =>
	Effect.gen(function* () {
		const backend = yield* session.rows("SELECT pg_catalog.pg_backend_pid()", [])
		const rows = yield* session.rows(
			"SELECT c.oid::pg_catalog.int8, c.relname::pg_catalog.text, pg_catalog.pg_total_relation_size(c.oid) FROM pg_catalog.pg_class AS c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relkind = 'r'::pg_catalog.char AND c.relname::pg_catalog.text LIKE '\\_\\_carrier\\_%'::pg_catalog.text ORDER BY c.relname",
			[]
		)
		return {
			backend: Number(backend[0]?.[0]),
			carriers: Arr.map(rows, ([oid, name, bytes]) => ({
				oid: Number(oid),
				name: String(name),
				bytes: Number(bytes)
			}))
		} satisfies Held
	})

/**
 * A case's writes on a fresh installation holding the stored state, each committed in turn through one served Db's
 * session: what each write's transaction held just before its COMMIT, read by a probe there (bench/write/support/
 * writes.ts BeforeCommit).
 */
export const heldOf = (sketch: Sketch) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("SessionCarriers"), "sessioncarriers", {
				programs: {},
				logins: []
			})
			const s = build(fx.installed.declared)
			const db = yield* openFull(fx, s)
			const seeded = yield* (yield* observedChange(db, seedOf(s), attemptLabel, {
				kind: "none"
			})).apply({})
			assert.equal(seeded.value.kind, "accepted", "the stored state is written")
			const held: Array<Held> = []
			for (const k of Arr.range(1, writes)) {
				const observed = yield* observedChange(db, writeOf(s, sketch, k), attemptLabel, {
					kind: "probe",
					run: (session) =>
						Effect.map(heldIn(session), (h) => {
							held.push(h)
						})
				})
				const applied = yield* observed.apply({})
				assert.equal(applied.value.kind, "accepted", `write ${k} of ${sketch.shape} is written`)
			}
			return held
		})
	)
