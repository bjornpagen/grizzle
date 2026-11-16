/**
 * The cost of recounting a mutable owner's family grows linearly with the owners a write recounts, on PostgreSQL 19: a
 * ChangeSet appending two members to each of n owners of a mutable owner relation, whose counted family's count and a
 * sum fold's end each owner holds, so the family additions statement recounts every owner it appends to
 * (write/family/additions.ts recountOf), at n, 2n and 4n owners. The fold's scan reads each member's before, the after
 * before it, by lag() (write/family/scan.ts), which the structural audit holds to its default (R27).
 *
 * Property, for each situation: the rows the write's statements read and pair (rowsScannedAndPaired,
 * bench/harness/explain.ts: every scan's rows over all of its loops, and every pair a join examined past its keys, the
 * same whichever sort, hash or merge the planner chooses for a step) at most double with each doubling of the owners,
 * from n to 2n and from 2n to 4n. A cost of a fixed part and a part per owner, a·n + b, at most doubles, since its
 * fixed part does not double, whatever constant a plan switch between sizes adds below that part; a cost with any term
 * above linear more than doubles once that term outgrows the fixed part, which the sizes reach: no slack, no
 * threshold, no clock. A recount that reads its recount source once per owner row,
 * or once per owner row and recounted column, grows by more. The pages the statements read and the temp they wrote are
 * reported beside the rows, unjudged. Every size is measured on a fresh installation that no ANALYZE has run on when
 * the write begins, which the case checks (pg_stat_user_tables): the owners a case stores first are committed, which
 * autovacuum may analyze later, after the write it measures. Every statement of the write passes the structural audit
 * (test/support/write-audit.ts), which refuses NULL and outer joins.
 *
 * The box, exhausted: the owners inserted in the same write as their members, or stored before it, the write appending
 * to them; to one of their families or to two, a family's recount then joined to the other's at their keys; each at a
 * smallest size n of 125 and of 250 owners. Each size's write is applied once, its statements each
 * under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its place, its transaction ended by ROLLBACK
 * (bench/write/support/writes.ts explainedChange). The oracle is the law itself; the family suites
 * (test/pg/write/swarm/families.test.ts, test/pg/write/fill-order, test/pg/write/family-cost) judge the rows the same
 * statements write.
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
const situations = [
	"owners inserted with their members, one family",
	"owners inserted with their members, two families",
	"owners stored before the write, one family",
	"owners stored before the write, two families"
] as const

type Situation = (typeof situations)[number]

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
 * The cost of appending to `owners` owners of `situation` on a fresh installation, the owners stored first through the
 * Db where they stand before the write, with the times PostgreSQL had analyzed its tables when the write began, which a
 * never-analyzed installation holds at none.
 */
const costOf = (situation: Situation, owners: number) =>
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

layer(Substrate.layer)("the cost of recounting a mutable owner's family", (it) => {
	it.effect("the rows it reads at most double with each doubling of its owners", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "pg/write/recount-cost",
					generator: sketchGen,
					literal: Formatter.format,
					box: "each situation of the box at n, 2n and 4n owners of two appended items each and, with two families, one tag each, each size on a fresh installation, at n of 125 and of 250",
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
})
