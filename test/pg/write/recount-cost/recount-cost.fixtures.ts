/** What the properties of recount-cost.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
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
import { Substrate } from "#test/support/substrate/substrate.ts"
import { writeAuditViolations } from "#test/support/write-audit.ts"

const Owner = relation(
	"Owner",
	{ id: pg.integer, n: drawn(natural), total: accumulated(pg.bigint, 0n), tags: drawn(natural) },
	["id"]
)

const Item = relation("Item", { id: pg.integer, owner: pg.integer, x: pg.bigint }, ["id"])

const Tag = relation("Tag", { id: pg.integer, owner: pg.integer }, ["id"])

const build = (name: string) => {
	const items = counted(on(Item, "owner"), fin(Owner, "n"))
	return schema(
		name,
		[Owner, Item, Tag],
		[
			items,
			fold(items, Monoid.sum, on(Item, "owner", "x"), on(Owner, "id", "total")),
			counted(on(Tag, "owner"), fin(Owner, "tags")),
			mutable(Owner)
		]
	)
}

type Schema = ReturnType<typeof build>

/**
 * The situations of the box, each where the owners the write appends to stand, and how many of their families it
 * appends to: Item's alone, whose recount is its source's rows, or Item's and Tag's, whose recounts are the keys of
 * both sources, each source joined at its key.
 */
export const situations = [
	"owners inserted with their members, one family",
	"owners inserted with their members, two families",
	"owners stored before the write, one family",
	"owners stored before the write, two families"
] as const

export type Situation = (typeof situations)[number]

/** The members the write appends to each owner. */
const membersPerOwner = 2

/** The owners' facts of a write of `owners` owners. */
const ownerFacts = (owners: number) => Arr.map(indices(owners), (o) => ({ id: o }))

/** The members' facts of a write of `owners` owners, `membersPerOwner` of each. */
const memberFacts = (owners: number) =>
	Arr.flatMap(indices(owners), (o) =>
		Arr.map(indices(membersPerOwner), (m) => ({
			id: membersPerOwner * o + m,
			owner: o,
			x: BigInt((o + m) % 7)
		}))
	)

/** The smallest sizes a case writes, n owners: 2n and 4n follow. */
const smallest = [125, 250] as const

/** A case: a situation of the box, and the smallest size its law measures it at. */
interface Sketch {
	readonly situation: Situation
	readonly n: (typeof smallest)[number]
}

export const sketchGen: Gen<Sketch> = (source) => ({
	situation: source.draw(element(situations)),
	n: source.draw(element(smallest))
})

/** What one size's write cost: the rows its statements read and paired, and the pages they read and the temp they wrote. */
interface Cost {
	readonly owners: number
	readonly rows: number
	readonly pages: number
	readonly temp: number
}

export const costText = (c: Cost): string =>
	`${c.rows} rows read and paired at ${c.owners} owners (${c.pages} pages read, ${c.temp} temp pages written)`

/**
 * The cost of appending to `owners` owners of `situation` on a fresh installation, the owners stored first through the
 * Db where they stand before the write, with the times PostgreSQL had analyzed its tables when the write began, which a
 * never-analyzed installation holds at none.
 */
export const costOf = (situation: Situation, owners: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("RecountCost"), "recountcost", {
				programs: {},
				logins: []
			})
			const S: Schema = build(fx.installed.declared)
			const db = yield* openFull(fx, S)
			const inserted =
				situation === "owners inserted with their members, one family" ||
				situation === "owners inserted with their members, two families"
			const both =
				situation === "owners inserted with their members, two families" ||
				situation === "owners stored before the write, two families"
			const owned = inserted
				? ChangeSet.empty(S).insert(Owner, ownerFacts(owners))
				: ChangeSet.empty(S)
			const items = owned.insert(Item, memberFacts(owners))
			const write = both
				? items.insert(
						Tag,
						Arr.map(indices(owners), (o) => ({ id: o, owner: o }))
					)
				: items
			if (!inserted) {
				const stored = yield* observedChange(
					db,
					ChangeSet.empty(S).insert(Owner, ownerFacts(owners)),
					attemptLabel,
					{ kind: "none" }
				)
				const applied = yield* stored.apply({})
				assert.equal(applied.value.kind, "accepted", `the ${owners} owners are stored`)
			}
			const substrate = yield* Substrate
			const analyzed = yield* substrate.admin.queryValues(
				`SELECT coalesce(sum(analyze_count + autoanalyze_count), 0)::text FROM pg_catalog.pg_stat_user_tables WHERE relid IN (${Arr.join(
					Arr.map(fx.tables, (table) => `'${table}'::pg_catalog.regclass`),
					", "
				)})`,
				[]
			)
			const plans = yield* explainedChange(db, write)
			assert.ok(plans.length > 0, `the write of ${owners} owners runs a statement`)
			const violations = yield* writeAuditViolations(db, write)
			assert.deepEqual(violations, [], "every statement of the write passes the structural audit")
			return {
				analyzed: Number(analyzed[0]?.[0]),
				cost: {
					owners,
					rows: Arr.reduce(plans, 0, (sum, p) => sum + rowsScannedAndPaired(p.plan)),
					pages: Arr.reduce(
						plans,
						0,
						(sum, p) => sum + p.plan.buffers.sharedHit + p.plan.buffers.sharedRead
					),
					temp: Arr.reduce(plans, 0, (sum, p) => sum + p.plan.buffers.tempWritten)
				} satisfies Cost
			}
		})
	)
