/**
 * The cost of a family write whose members copy their owners' columns grows linearly with the write, on PostgreSQL 19:
 * a ChangeSet inserting n owners and two members of each, every member copying two of its owner's columns along the
 * family's owner axis, the owners inserted in the same write, so the family additions statement reads each copy from
 * the owners' facts it holds (schedule.ts CopySource `held`), at three sizes, n, 2n and 4n owners.
 *
 * Property, for each situation: the rows the write's statements read and pair (rowsScannedAndPaired,
 * bench/harness/explain.ts: every scan's rows over all of its loops, and every pair a join examined past its keys, the
 * same whichever sort, hash or merge the planner chooses for a step) at most double with each doubling of the owners,
 * from n to 2n and from 2n to 4n. A cost of a fixed part and a part per owner, a·n + b, at most doubles, since its
 * fixed part does not double, whatever constant a plan switch between sizes adds below that part; a cost with any term
 * above linear more than doubles once that term outgrows the fixed part, which the sizes reach: no slack, no
 * threshold, no clock. The pages the statements read and the temp they wrote are reported
 * beside the rows, unjudged.
 *
 * Statistics play no part: every size is measured on a fresh installation that no ANALYZE has run on, which the case
 * checks (pg_stat_user_tables), and the statement reads its owners from the call's own facts, of which PostgreSQL holds
 * none. Each case also holds the write to the copy's contract and the emission discipline: the write applied stores
 * every member with its owner's columns as its copies (a specification oracle of the copy, which the window's
 * first_value over the held owners must meet), and every statement passes the structural audit
 * (test/support/write-audit.ts), which refuses NULL and outer joins.
 *
 * The box, exhausted: the members inserted, so their groups start empty and the insert is arbitrated, or put, so each
 * group's stored state and its stored owner are probed beside the owners' facts; each at a smallest size n of 125 and of
 * 250 owners. The owner relation is immutable, so the write recounts no stored owner. Each size's write is applied once,
 * on a fresh installation, its statements each under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its place,
 * its transaction ended by ROLLBACK (bench/write/support/writes.ts
 * explainedChange). The oracle is the law itself, the definition of linear growth; the family suites
 * (test/pg/write/swarm/families.test.ts, test/pg/write/fill-order) judge the rows the same statements write.
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
import { contained, counted, fin, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
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
const situations = ["members inserted", "members put"] as const

type Situation = (typeof situations)[number]

/** The members each owner holds. */
const membersPerOwner = 2

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

const sketchGen: Gen<Sketch> = (source) => ({
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

const costText = (c: Cost): string =>
	`${c.rows} rows read and paired at ${c.owners} owners (${c.pages} pages read, ${c.temp} temp pages written)`

/**
 * The cost of writing `owners` owners and their members on a fresh installation of `situation`, with the times
 * PostgreSQL analyzed its tables, which a never-analyzed installation holds at none.
 */
const costOf = (situation: Situation, owners: number) =>
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

layer(Substrate.layer)(
	"the cost of a family write whose members copy their owners' columns",
	(it) => {
		it.effect("the rows it reads at most double with each doubling of its owners", (ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "pg/write/owner-copy-cost",
						generator: sketchGen,
						literal: Formatter.format,
						box: "each situation of the box written at n, 2n and 4n owners of two members each, each size on a fresh installation, at n of 125 and of 250",
						oracle: {
							kind: "specification",
							name: "linear growth: a cost of a fixed part and a part per row at most doubles when its rows double, the fixed part not doubling, and a cost above linear more than doubles"
						},
						coverage: requiredInSpace<Situation>(situations),
						caseHang
					},
					(sketch, c) =>
						Effect.gen(function* () {
							const [n, twice, four] = yield* Effect.all([
								costOf(sketch.situation, sketch.n),
								costOf(sketch.situation, 2 * sketch.n),
								costOf(sketch.situation, 4 * sketch.n)
							])
							c.note(sketch.situation)
							for (const at of [n, twice, four]) {
								assert.equal(
									at.copied,
									membersPerOwner * at.cost.owners,
									`${sketch.situation}: at ${at.cost.owners} owners, a member's copies are not its owner's columns`
								)
								assert.equal(
									at.analyzed,
									0,
									`${sketch.situation}: the installation measured at ${at.cost.owners} owners was analyzed`
								)
							}
							assert.ok(
								twice.cost.rows <= 2 * n.cost.rows && four.cost.rows <= 2 * twice.cost.rows,
								`${sketch.situation}: its write reads rows faster than linearly: ${Arr.join(
									Arr.map([n.cost, twice.cost, four.cost], costText),
									"; "
								)}`
							)
						})
				)
			)
		)
	}
)
