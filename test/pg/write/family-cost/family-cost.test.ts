/**
 * The cost of a family write grows linearly with the members it draws, on PostgreSQL 19: a ChangeSet appending L members
 * to one stored group, the family additions statement drawing each appended member's columns (write/family/scan.ts), at
 * three lengths, L = n, 2n and 4n.
 *
 * Property, for each family: the rows the write's statements read and pair (rowsScannedAndPaired, bench/harness/explain.ts: every scan's rows over all of
 * its loops, and every pair a join examined past its keys) grow by no more from 2n to 4n than twice what they grow by
 * from n to 2n. A cost of a fixed part and a part per member grows by exactly twice as much over the
 * doubled step; a cost with any term above linear, a recursion that rereads the appended members once per member it
 * draws among them, grows by more, at every length: no slack, no threshold, no clock. The pages the statements read and
 * the temp they wrote are reported beside the rows, unjudged.
 *
 * The box, exhausted: the families a scan draws differently. A counted family whose appended members draw only their
 * index and their copy of the count (bench/write/families.bench.ts's append, whose 100,000 members' recursive scan wrote
 * some 570 GB of temp before it was cancelled), appended to an empty group, which draws from slot 0; and a counted
 * family with a sum fold, whose hidden before is its predecessor's after, appended past a stored member, which draws
 * from its seed; each at a shortest length n of 125 and of 250 members. Each length's write is applied once on a group
 * of its own, its statements each under EXPLAIN (ANALYZE,
 * BUFFERS, SETTINGS, FORMAT JSON) in its place, its transaction ended by ROLLBACK (bench/write/support/writes.ts
 * explainedChange). The oracle is the law itself, the definition of linear growth; the family suites
 * (test/pg/write/swarm/families.test.ts, test/pg/write/fill-order) judge the rows the same statements write.
 *
 * @plant test/plants/pg/write/family-cost/family-scan-recursive.patch The scan is a WITH RECURSIVE walk of one member
 * per step, as before 2026-11-14 (write/family/scan.ts); the property fails on its growth.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { rowsScannedAndPaired } from "#bench/harness/explain.ts"
import {
	attemptLabel,
	explainedChange,
	installWrites,
	observedChange,
	openFull
} from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
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
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

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
const families = [
	"a counted family drawing its index and its copy of the count, from slot 0",
	"a counted family with a sum fold, past a stored member"
] as const

type FamilyName = (typeof families)[number]

/** A family of the box: its stored group, and the ChangeSet appending L members to it. */
interface Appended {
	/** The group of id `id` as stored before the append: its owner, and the members it holds. */
	readonly stored: (s: Schema, id: number) => unknown
	/** The append of `length` members, ids from `from` on, to the group of id `id`. */
	readonly append: (s: Schema, id: number, from: number, length: number) => unknown
}

const box: Readonly<Record<FamilyName, Appended>> = {
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

const sketchGen: Gen<Sketch> = (source) => ({
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

const costText = (c: Cost): string =>
	`${c.rows} rows read at ${c.length} members (${c.pages} pages read, ${c.temp} temp pages written)`

/**
 * The cost of appending `length` members to the group `id` of a fresh installation's `family`: the group stored first
 * through the Db, then the append explained in its place (explainedChange).
 */
const costOf = (family: Appended, label: string) =>
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

layer(Substrate.layer)("the cost of a family write", (it) => {
	it.effect(
		"the rows a family's append reads grow by no more from 2n to 4n members than twice what they grow by from n to 2n",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "pg/write/family-cost",
						generator: sketchGen,
						literal: Formatter.format,
						box: "each family of the box appended n, 2n and 4n members, each length to a group of its own, at n of 125 and of 250",
						oracle: {
							kind: "specification",
							name: "linear growth: a cost of a fixed part and a part per member grows by exactly twice as much from 2n to 4n as from n to 2n, and a cost above linear by more"
						},
						coverage: requiredInSpace<FamilyName>(families),
						caseHang,
						concurrency: 1
					},
					(sketch, c) =>
						Effect.gen(function* () {
							const at = yield* costOf(box[sketch.family], "familycost")
							const [n, twice, four] = yield* Effect.all(
								[at(sketch.n, 1), at(2 * sketch.n, 2), at(4 * sketch.n, 3)],
								{ concurrency: 1 }
							)
							c.note(sketch.family)
							assert.ok(
								four.rows - twice.rows <= 2 * (twice.rows - n.rows),
								`${sketch.family}: its write reads rows faster than linearly: ${Arr.join(
									Arr.map([n, twice, four], costText),
									"; "
								)}`
							)
						})
				)
			)
	)
})
