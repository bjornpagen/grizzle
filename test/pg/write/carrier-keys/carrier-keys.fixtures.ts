/** What the property of carrier-keys.test.ts reads: its schema, its shapes and each shape's plans. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { planNodes, type PlanNode } from "#bench/harness/explain.ts"
import {
	attemptLabel,
	explainedChange,
	installWrites,
	observedChange,
	openFull
} from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import { contained, counted, fin, mutable, on, relation, schema } from "#compiler/public/schema.ts"

const Owner = relation("Owner", { id: pg.integer, v: pg.bigint, n: drawn(natural) }, ["id"])

const Item = relation(
	"Item",
	{ id: pg.integer, owner: pg.integer, cv: accumulated(pg.bigint, 0n) },
	["id"]
)

/** A relation no role updates, whose put deletes the facts it displaces and inserts its own (write/put/choose.ts). */
const Fixed = relation("Fixed", { id: pg.integer, w: pg.integer }, ["id"])

/**
 * The box's schema: owners counting their items, each item copying its owner's v (a refill when the owner's v changes),
 * both mutable, and an immutable relation beside them.
 */
const build = (name: string) =>
	schema(
		name,
		[Owner, Item, Fixed],
		[
			counted(on(Item, "owner"), fin(Owner, "n")),
			contained(on(Item, "owner", "cv"), on(Owner, "id", "v")),
			mutable(Owner),
			mutable(Item)
		]
	)

type Schema = ReturnType<typeof build>

/** The relations of the box, every one a statement of a shape may read stored rows of. */
const boxRelations = ["Owner", "Item", "Fixed"] as const

/**
 * The shapes, each a write whose facts two or more of its statements read, so its program carries them in a carrier of
 * its own (write/program/slot-carriers.ts) that every one of those statements joins to a stored relation:
 *
 * - an immutable relation put: the displacing deletion (delete/exact.ts) and the insert;
 * - owners put: the UPDATE of the owners (put/statement.ts), their items refilled (family/removals.ts refill) and
 *   recounted (family/additions.ts);
 * - items moved: items deleted and others put into another owner's group, the removals statement's removed, touched,
 *   regrouped and re-placed members, its group reads and its writes (family/removals.ts), and the additions' recount;
 * - owners put and items deleted: the edited and refilled members' keyset of one removals statement.
 */
const shapes = [
	"an immutable relation put",
	"owners put",
	"items moved",
	"owners put and items deleted"
] as const

export type Shape = (typeof shapes)[number]

/** The keys a case's write names, the carrier's rows: one, and 4096, the larger of main's two sizes. */
const sizes = [1, 4096] as const

type Size = (typeof sizes)[number]

/** A case: a shape, and the keys its write names. */
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

/**
 * The owners stored before a case's write, twice the most keys it names, so a stored relation read whole is never the
 * cheaper read of the keys a write names, and each owner's items.
 */
const owners = 2 * 4096

const itemsPerOwner = 2

const itemOf = (owner: number, i: number) => ({ id: itemsPerOwner * owner + i, owner })

/** The stored state: every owner with its items, and a Fixed fact per owner. */
const seedOf = (s: Schema) =>
	ChangeSet.empty(s)
		.insert(
			Owner,
			Arr.map(indices(owners), (id) => ({ id, v: BigInt(id) }))
		)
		.insert(
			Item,
			Arr.flatMap(indices(owners), (o) => Arr.map(indices(itemsPerOwner), (i) => itemOf(o, i)))
		)
		.insert(
			Fixed,
			Arr.map(indices(owners), (id) => ({ id, w: 0 }))
		)

/** The write of a case: its shape over the first `keys` owners, a moved item going to the owner `owners / 2` on. */
const writeOf = (s: Schema, sketch: Sketch) => {
	const named = indices(sketch.keys)
	const ownersPut = Arr.map(named, (id) => ({ id, v: BigInt(id + 1) }))
	switch (sketch.shape) {
		case "an immutable relation put":
			return ChangeSet.empty(s).put(
				Fixed,
				Arr.map(named, (id) => ({ id, w: 1 }))
			)
		case "owners put":
			return ChangeSet.empty(s).put(Owner, ownersPut)
		case "items moved":
			return ChangeSet.empty(s)
				.delete(
					Item,
					Arr.map(named, (o) => itemOf(o, 0))
				)
				.put(
					Item,
					Arr.map(named, (o) => ({ ...itemOf(o, 1), owner: o + owners / 2 }))
				)
		case "owners put and items deleted":
			return ChangeSet.empty(s)
				.put(Owner, ownersPut)
				.delete(
					Item,
					Arr.map(named, (o) => itemOf(o + owners / 2, 0))
				)
	}
}

/** The scans that read a stored relation through an index by their own index condition. */
const indexScans: ReadonlySet<string> = new Set(["Index Scan", "Index Only Scan"])

/** Whether a scan reads its stored rows by a key: an index scan by an index condition, a bitmap heap scan by its bitmap's,
 * or a TID scan, which reads only the tids it is given. */
const keyed = (n: PlanNode): boolean =>
	n.nodeType === "Tid Scan" ||
	(indexScans.has(n.nodeType) && Option.isSome(n.indexCond)) ||
	(n.nodeType === "Bitmap Heap Scan" &&
		Arr.every(
			Arr.filter([...planNodes(n)], (b) => b.nodeType === "Bitmap Index Scan"),
			(b) => Option.isSome(b.indexCond)
		))

/** What a case's write planned: every scan of a stored relation of the box that reads no key, each named by its
 * statement, node and relation, and the carriers its statements read. */
interface Planned {
	readonly unkeyed: ReadonlyArray<string>
	readonly carriers: number
}

/**
 * A case's write on a fresh installation holding the stored state: its statements each run under EXPLAIN ANALYZE in its
 * place, its carriers created and filled as the call fills them and never analyzed (bench/write/support/writes.ts
 * explainedChange), and every scan of a box relation that reads no key.
 */
export const plannedOf = (sketch: Sketch) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("CarrierKeys"), "carrierkeys", {
				programs: {},
				logins: []
			})
			const s = build(fx.installed.declared)
			const db = yield* openFull(fx, s)
			const seeded = yield* (yield* observedChange(db, seedOf(s), attemptLabel, {
				kind: "none"
			})).apply({})
			assert.equal(seeded.value.kind, "accepted", "the stored state is written")
			const names = new Map(Arr.map(boxRelations, (r) => [fx.relationName(r), r] as const))
			const plans = yield* explainedChange(db, writeOf(s, sketch))
			assert.ok(plans.length > 0, "the write runs a statement")
			const unkeyed = Arr.flatMap(plans, (p, i) =>
				Arr.flatMap([...planNodes(p.plan)], (n) =>
					Option.match(n.relation, {
						onNone: () => [],
						onSome: (table) => {
							const r = names.get(table)
							return r === undefined ||
								Option.isSome(n.operation) ||
								n.nodeType === "Bitmap Index Scan" ||
								keyed(n)
								? []
								: [`statement ${i}: ${n.nodeType} of ${r}`]
						}
					})
				)
			)
			const carriers = Arr.filter(
				Arr.flatMap(plans, (p) =>
					Arr.flatMap([...planNodes(p.plan)], (n) => Option.toArray(n.relation))
				),
				Str.startsWith("__carrier_")
			).length
			return { unkeyed, carriers } satisfies Planned
		})
	)
