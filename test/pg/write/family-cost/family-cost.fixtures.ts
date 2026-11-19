/** What the properties of family-cost.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import { rowsScannedAndPaired } from "#bench/harness/explain.ts"
import {
	attemptLabel,
	explainedChange,
	installWrites,
	observedChange,
	openFull
} from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { assert } from "#test/support/assert.ts"

const Group = relation("Group", { id: pg.integer, size: drawn(natural) }, ["id"])

const Tag = relation("Tag", { id: pg.integer, grp: pg.integer, payload: pg.integer }, ["id"])

const Purse = relation(
	"Purse",
	{ id: pg.integer, coins: drawn(natural), total: accumulated(pg.integer, 0) },
	["id"]
)

const Coin = relation("Coin", { id: pg.integer, purse: pg.integer, x: pg.integer }, ["id"])

const build = (name: string) => {
	const coins = counted(on(Coin, "purse"), fin(Purse, "coins"))
	return schema(
		name,
		[Group, Tag, Purse, Coin],
		[
			counted(on(Tag, "grp"), fin(Group, "size")),
			coins,
			fold(coins, Monoid.sum, on(Coin, "purse", "x"), on(Purse, "id", "total")),
			mutable(Group),
			mutable(Tag),
			mutable(Purse),
			mutable(Coin)
		]
	)
}

type Schema = ReturnType<typeof build>

/** The families of the box, by the situation each covers. */
export const families = [
	"a counted family drawing its index and its copy of the count, from slot 0",
	"a counted family with a sum fold, past a stored member"
] as const

export type FamilyName = (typeof families)[number]

/** A family of the box: its stored group, and the ChangeSet appending L members to it. */
interface Appended {
	/** The group of id `id` as stored before the append: its owner, and the members it holds. */
	readonly stored: (s: Schema, id: number) => unknown
	/** The append of `length` members, ids from `from` on, to the group of id `id`. */
	readonly append: (s: Schema, id: number, from: number, length: number) => unknown
}

export const box: Readonly<Record<FamilyName, Appended>> = {
	"a counted family drawing its index and its copy of the count, from slot 0": {
		stored: (s, id) => ChangeSet.empty(s).insert(Group, [{ id }]),
		append: (s, id, from, length) =>
			ChangeSet.empty(s).insert(
				Tag,
				Arr.map(indices(length), (k) => ({ id: from + k, grp: id, payload: k }))
			)
	},
	"a counted family with a sum fold, past a stored member": {
		stored: (s, id) =>
			ChangeSet.empty(s)
				.insert(Purse, [{ id }])
				.insert(Coin, [{ id: -id, purse: id, x: 1 }]),
		append: (s, id, from, length) =>
			ChangeSet.empty(s).insert(
				Coin,
				Arr.map(indices(length), (k) => ({ id: from + k, purse: id, x: (k % 7) - 3 }))
			)
	}
}

/** The shortest lengths a case appends, n: 2n and 4n follow. */
const shortest = [125, 250] as const

/** A case: a family of the box, and the shortest length its law measures it at. */
interface Sketch {
	readonly family: FamilyName
	readonly n: (typeof shortest)[number]
}

export const sketchGen: Gen<Sketch> = (source) => ({
	family: source.draw(element(families)),
	n: source.draw(element(shortest))
})

/** What one length's write cost: the rows its statements read, and the pages they read and the temp they wrote. */
interface Cost {
	readonly length: number
	readonly rows: number
	readonly pages: number
	readonly temp: number
}

export const costText = (c: Cost): string =>
	`${c.rows} rows read at ${c.length} members (${c.pages} pages read, ${c.temp} temp pages written)`

/**
 * The cost of appending `length` members to the group `id` of a fresh installation's `family`: the group stored first
 * through the Db, then the append explained in its place (explainedChange).
 */
export const costOf = (family: Appended, label: string) =>
	Effect.gen(function* () {
		const fx = yield* installWrites(build("FamilyCost"), label, { programs: {}, logins: [] })
		const S = build(fx.installed.declared)
		return (length: number, id: number) =>
			Effect.scoped(
				Effect.gen(function* () {
					const db = yield* openFull(fx, S)
					const stored = yield* observedChange(db, family.stored(S, id), attemptLabel, {
						kind: "none"
					})
					const applied = yield* stored.apply({})
					assert.equal(applied.value.kind, "accepted", `the group ${id} is stored`)
					const plans = yield* explainedChange(db, family.append(S, id, 1 + 100_000 * id, length))
					assert.ok(plans.length > 0, `the append of ${length} members runs a statement`)
					return {
						length,
						rows: Arr.reduce(plans, 0, (sum, p) => sum + rowsScannedAndPaired(p.plan)),
						pages: Arr.reduce(
							plans,
							0,
							(sum, p) => sum + p.plan.buffers.sharedHit + p.plan.buffers.sharedRead
						),
						temp: Arr.reduce(plans, 0, (sum, p) => sum + p.plan.buffers.tempWritten)
					} satisfies Cost
				})
			)
	})
