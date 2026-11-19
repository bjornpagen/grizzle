/** What the properties of owner-copy-cost.test.ts read: its spaces, models and helpers. */

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
import { contained, counted, fin, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { writeAuditViolations } from "#test/support/write-audit.ts"

const Owner = relation("Owner", { id: pg.integer, v: pg.bigint, w: pg.bigint, n: drawn(natural) }, [
	"id"
])

const Item = relation(
	"Item",
	{
		id: pg.integer,
		owner: pg.integer,
		cv: accumulated(pg.bigint, 0n),
		cw: accumulated(pg.bigint, 0n)
	},
	["id"]
)

const build = (name: string) =>
	schema(
		name,
		[Owner, Item],
		[
			counted(on(Item, "owner"), fin(Owner, "n")),
			contained(on(Item, "owner", "cv"), on(Owner, "id", "v")),
			contained(on(Item, "owner", "cw"), on(Owner, "id", "w")),
			mutable(Item)
		]
	)

type Schema = ReturnType<typeof build>

/**
 * The situations of the box, each how the write appends its members: inserted, so their groups start empty and the
 * insert is arbitrated (write/family/additions.ts memberArbitrated, GroupState `base`); or put, so each group's stored
 * state and its stored owner are probed beside the owners' facts (GroupState `stored`).
 */
export const situations = ["members inserted", "members put"] as const

export type Situation = (typeof situations)[number]

/** The members each owner holds. */
export const membersPerOwner = 2

/** The write of `owners` owners and their members, appended as `situation` says, every owner's columns its own. */
const writeOf = (s: Schema, situation: Situation, owners: number) => {
	const withOwners = ChangeSet.empty(s).insert(
		Owner,
		Arr.map(indices(owners), (o) => ({ id: o, v: BigInt(3 * o + 1), w: BigInt(o % 11) }))
	)
	const members = Arr.flatMap(indices(owners), (o) =>
		Arr.map(indices(membersPerOwner), (m) => ({ id: membersPerOwner * o + m, owner: o }))
	)
	return situation === "members inserted"
		? withOwners.insert(Item, members)
		: withOwners.put(Item, members)
}

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
 * The cost of writing `owners` owners and their members on a fresh installation of `situation`, with the times
 * PostgreSQL analyzed its tables, which a never-analyzed installation holds at none.
 */
export const costOf = (situation: Situation, owners: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("OwnerCopyCost"), "ownercopycost", {
				programs: {},
				logins: []
			})
			const S = build(fx.installed.declared)
			const db = yield* openFull(fx, S)
			const write = writeOf(S, situation, owners)
			const plans = yield* explainedChange(db, write)
			assert.ok(plans.length > 0, `the write of ${owners} owners runs a statement`)
			const violations = yield* writeAuditViolations(db, write)
			assert.deepEqual(violations, [], "every statement of the write passes the structural audit")
			const applied = yield* (yield* observedChange(db, write, attemptLabel, {
				kind: "none"
			})).apply({})
			assert.equal(applied.value.kind, "accepted", `the write of ${owners} owners is accepted`)
			const substrate = yield* Substrate
			const analyzed = yield* substrate.admin.queryValues(
				`SELECT coalesce(sum(analyze_count + autoanalyze_count), 0)::text FROM pg_catalog.pg_stat_user_tables WHERE relid IN (${Arr.join(
					Arr.map(fx.tables, (table) => `'${table}'::pg_catalog.regclass`),
					", "
				)})`,
				[]
			)
			const copied = yield* substrate.admin.queryValues(
				`SELECT count(*)::text FROM ${fx.table("Item")} AS i JOIN ${fx.table("Owner")} AS o ON o.${fx.column("Owner", "id")} = i.${fx.column("Item", "owner")} WHERE i.${fx.column("Item", "cv")} = o.${fx.column("Owner", "v")} AND i.${fx.column("Item", "cw")} = o.${fx.column("Owner", "w")}`,
				[]
			)
			return {
				copied: Number(copied[0]?.[0]),
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
