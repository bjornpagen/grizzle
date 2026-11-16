/**
 * The cost of an arbitrated insert grows linearly with its rows, on PostgreSQL 19: a ChangeSet inserting n owners and two
 * members of each into an empty installation, the members a counted family's under a key of three columns, so the
 * family additions statement inserts them by ON CONFLICT DO NOTHING and reads its met rows, the proposed rows its INSERT
 * did not return (sql/ast.ts FromSource `metRows`), as do the owners' own insert, at n, 2n and 4n owners. Every row is
 * new, so the INSERT returns every row it proposes and the met rows are none: the set difference of two CTEs of one
 * size. A key of several columns is what PostgreSQL estimates two such CTEs at a row each by, with no statistics of
 * them, and a nested loop of the two pairs every proposed row with every returned one.
 *
 * Property, for each situation: the rows the write's statements read and pair (rowsScannedAndPaired,
 * bench/harness/explain.ts: every scan's rows over all of its loops, and every pair a join examined past its keys, the
 * same whichever sort, hash or merge the planner chooses for a step) at most double with each doubling of the owners,
 * from n to 2n and from 2n to 4n. A cost of a fixed part and a part per owner, a·n + b, at most doubles, since its
 * fixed part does not double, whatever constant a plan switch between sizes adds below that part; a cost with any term
 * above linear more than doubles once that term outgrows the fixed part, which the sizes reach: no slack, no
 * threshold, no clock. The pages the statements read and the temp they wrote are
 * reported beside the rows, unjudged. Every size is measured on a fresh installation that no ANALYZE has run on, which
 * the case checks (pg_stat_user_tables), and every statement of the write passes the structural audit
 * (test/support/write-audit.ts), which refuses NULL and outer joins.
 *
 * The box, exhausted: the smallest size n, of 125 and of 250 owners. Each size's write is applied once, its statements
 * each under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its place, its transaction ended by ROLLBACK
 * (bench/write/support/writes.ts explainedChange). The oracle is the law itself; the insert and family suites
 * (test/pg/write/met, test/pg/write/oracle, test/pg/write/fill-order, test/pg/write/swarm/families.test.ts) judge the
 * rows the same statements write and the met rows they classify.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { rowsScannedAndPaired } from "#bench/harness/explain.ts"
import { explainedChange, installWrites, openFull } from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { counted, fin, on, relation, schema } from "#compiler/public/schema.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { writeAuditViolations } from "#test/support/write-audit.ts"

const Owner = relation(
	"Owner",
	{ pkg: pg.integer, path: pg.integer, start: pg.bigint, n: drawn(natural) },
	["pkg", "path", "start"]
)
const Item = relation(
	"Item",
	{ pkg: pg.integer, path: pg.integer, start: pg.bigint, name: pg.integer, value: pg.bigint },
	["pkg", "path", "start", "name"]
)

const build = (name: string) =>
	schema(name, [Owner, Item], [counted(on(Item, "pkg", "path", "start"), fin(Owner, "n"))])

type Schema = ReturnType<typeof build>

/** The members each owner holds. */
const membersPerOwner = 2

/** The write of `owners` owners and their members, inserted together into an empty installation. */
const writeOf = (s: Schema, owners: number) =>
	ChangeSet.empty(s)
		.insert(
			Owner,
			Arr.map(indices(owners), (o) => ({ pkg: 1, path: o % 7, start: BigInt(o) }))
		)
		.insert(
			Item,
			Arr.flatMap(indices(owners), (o) =>
				Arr.map(indices(membersPerOwner), (m) => ({
					pkg: 1,
					path: o % 7,
					start: BigInt(o),
					name: m,
					value: BigInt(10 * o + m)
				}))
			)
		)

/** The smallest sizes a case writes, n owners, each a situation of the box: 2n and 4n follow. */
const situations = ["n of 125", "n of 250"] as const

type Situation = (typeof situations)[number]

const smallest: Readonly<Record<Situation, number>> = { "n of 125": 125, "n of 250": 250 }

/** A case: the situation whose smallest size its law measures it at. */
interface Sketch {
	readonly situation: Situation
}

const sketchGen: Gen<Sketch> = (source) => ({ situation: source.draw(element(situations)) })

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
 * The cost of writing `owners` owners and their members on a fresh installation, with the times
 * PostgreSQL analyzed its tables, which a never-analyzed installation holds at none.
 */
const costOf = (owners: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("MetRowsCost"), "metrowscost", {
				programs: {},
				logins: []
			})
			const S = build(fx.installed.declared)
			const db = yield* openFull(fx, S)
			const write = writeOf(S, owners)
			const plans = yield* explainedChange(db, write)
			assert.ok(plans.length > 0, `the write of ${owners} owners runs a statement`)
			const violations = yield* writeAuditViolations(db, write)
			assert.deepEqual(violations, [], "every statement of the write passes the structural audit")
			const substrate = yield* Substrate
			const analyzed = yield* substrate.admin.queryValues(
				`SELECT coalesce(sum(analyze_count + autoanalyze_count), 0)::text FROM pg_catalog.pg_stat_user_tables WHERE relid IN (${Arr.join(
					Arr.map(fx.tables, (table) => `'${table}'::pg_catalog.regclass`),
					", "
				)})`,
				[]
			)
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

layer(Substrate.layer)("the cost of an arbitrated insert", (it) => {
	it.effect("the rows it reads at most double with each doubling of its owners", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "pg/write/met-rows-cost",
					generator: sketchGen,
					literal: Formatter.format,
					box: "n, 2n and 4n owners of two members each, all new, each size on a fresh installation, at n of 125 and of 250",
					oracle: {
						kind: "specification",
						name: "linear growth: a cost of a fixed part and a part per row at most doubles when its rows double, the fixed part not doubling, and a cost above linear more than doubles"
					},
					coverage: requiredInSpace<Situation>(situations),
					caseHang,
					concurrency: 1
				},
				(sketch, c) =>
					Effect.gen(function* () {
						const [n, twice, four] = yield* Effect.all(
							[
								costOf(smallest[sketch.situation]),
								costOf(2 * smallest[sketch.situation]),
								costOf(4 * smallest[sketch.situation])
							],
							{ concurrency: 1 }
						)
						c.note(sketch.situation)
						for (const at of [n, twice, four]) {
							assert.equal(
								at.analyzed,
								0,
								`the installation measured at ${at.cost.owners} owners was analyzed`
							)
						}
						assert.ok(
							twice.cost.rows <= 2 * n.cost.rows && four.cost.rows <= 2 * twice.cost.rows,
							`its write reads rows faster than linearly: ${Arr.join(
								Arr.map([n.cost, twice.cost, four.cost], costText),
								"; "
							)}`
						)
					})
			)
		)
	)
})
