/**
 * The cost of a family write's pair checks grows linearly with its rows, on PostgreSQL 19: a ChangeSet inserting n
 * owners and two members of each into an empty installation, the members a counted family's under a key of three
 * columns and one more unique object beside it, so the family additions statement probes its candidate members for two
 * of them that object cannot both hold (write/insert/unique.ts buildProbe, its pair branch), at n, 2n and 4n owners.
 * Every member is lawful, so no pair is found: each check reads every candidate it holds. The object is a key beside the
 * primary key, a key over a selection of the members (edullm's Attribute keys over a kind and a name are such), or a
 * no-overlap key over a span; the first two pair by equal fields, the third by overlapping spans. A key of several
 * columns is what PostgreSQL estimates the candidates' CTE at a row by, with no statistics of it, and a pair read as a
 * nested loop of two scans of it pairs every candidate with every other.
 *
 * Property, for each situation: the rows the write's statements read and pair (rowsScannedAndPaired,
 * bench/harness/explain.ts: every scan's rows over all of its loops, and every pair a join examined past its keys, the
 * same whichever sort, hash or merge the planner chooses for a step) at most double with each doubling of the owners,
 * from n to 2n and from 2n to 4n. A cost of a fixed part and a part per owner, a·n + b, at most doubles, since its
 * fixed part does not double, whatever constant a plan switch between sizes adds below that part; a cost with any term
 * above linear more than doubles once that term outgrows the fixed part, which the sizes reach: no slack, no
 * threshold, no clock. The pages the statements read and the temp they wrote are reported beside the rows, unjudged.
 * Every size is measured on a fresh installation that no ANALYZE has run on, which the case checks
 * (pg_stat_user_tables), and every statement of the write passes the structural audit (test/support/write-audit.ts),
 * which refuses NULL and outer joins.
 *
 * The box, exhausted: each unique object, at the smallest size n of 125 and of 250 owners. Each size's write is applied
 * once, its statements each under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its place, its transaction ended
 * by ROLLBACK (bench/write/support/writes.ts explainedChange). The oracle is the law itself; the family, key and span
 * suites (test/pg/write/swarm/families.test.ts, test/pg/write/unique-witness, test/pg/write/span-key,
 * test/pg/write/oracle) judge the refusals the same probe raises.
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
import { drawn, natural, pg, span } from "#compiler/public/fields.ts"
import { counted, fin, key, on, relation, schema, select } from "#compiler/public/schema.ts"
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
	{
		pkg: pg.integer,
		path: pg.integer,
		start: pg.bigint,
		name: pg.integer,
		kind: pg.integer,
		value: pg.bigint,
		during: span(pg.bigint)
	},
	["pkg", "path", "start", "name"]
)

/** The unique object beside Item's primary key whose pairs the family additions statement checks. */
const objects = [
	"a key beside the primary key",
	"a key over a selection",
	"a no-overlap key"
] as const

type UniqueObjectKind = (typeof objects)[number]

const objectStatement = (object: UniqueObjectKind) => {
	switch (object) {
		case "a key beside the primary key":
			return key(on(Item, "pkg", "path", "value"))
		case "a key over a selection":
			return key(
				on(
					select(Item, (r) => r.eq(r.kind, 1)),
					"pkg",
					"path",
					"start"
				)
			)
		case "a no-overlap key":
			return key(on(Item, "pkg", "path", "during"))
	}
}

const build = (name: string, object: UniqueObjectKind) =>
	schema(
		name,
		[Owner, Item],
		[counted(on(Item, "pkg", "path", "start"), fin(Owner, "n")), objectStatement(object)]
	)

type Schema = ReturnType<typeof build>

/** The members each owner holds: one of each kind, each with a value and a span of its own. */
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
					kind: m,
					value: BigInt(membersPerOwner * o + m),
					during: {
						start: BigInt(membersPerOwner * o + m),
						end: BigInt(membersPerOwner * o + m + 1)
					}
				}))
			)
		)

/** The smallest sizes a case writes, n owners: 2n and 4n follow. */
const sizes = ["n of 125", "n of 250"] as const

type Size = (typeof sizes)[number]

const smallest: Readonly<Record<Size, number>> = { "n of 125": 125, "n of 250": 250 }

type Situation = `${UniqueObjectKind}, ${Size}`

const situations: Arr.NonEmptyReadonlyArray<Situation> = Arr.flatMap(objects, (object) =>
	Arr.map(sizes, (size): Situation => `${object}, ${size}`)
)

/** A case: the unique object whose pairs it checks, and the smallest size its law measures it at. */
interface Sketch {
	readonly object: UniqueObjectKind
	readonly size: Size
}

const sketchGen: Gen<Sketch> = (source) => ({
	object: source.draw(element(objects)),
	size: source.draw(element(sizes))
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
 * The cost of writing `owners` owners and their members under `object` on a fresh installation, with the times
 * PostgreSQL analyzed its tables, which a never-analyzed installation holds at none.
 */
const costOf = (object: UniqueObjectKind, owners: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("PairCost", object), "paircost", {
				programs: {},
				logins: []
			})
			const S = build(fx.installed.declared, object)
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

layer(Substrate.layer)("the cost of a family write's pair checks", (it) => {
	it.effect("the rows it reads at most double with each doubling of its owners", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "pg/write/pair-cost",
					generator: sketchGen,
					literal: Formatter.format,
					box: "n, 2n and 4n owners of two lawful members each, all new, each size on a fresh installation, under a key beside the primary key, a key over a selection or a no-overlap key, at n of 125 and of 250",
					oracle: {
						kind: "specification",
						name: "linear growth: a cost of a fixed part and a part per row at most doubles when its rows double, the fixed part not doubling, and a cost above linear more than doubles"
					},
					coverage: requiredInSpace<Situation>(situations),
					caseHang
				},
				(sketch, c) =>
					Effect.gen(function* () {
						const least = smallest[sketch.size]
						const [n, twice, four] = yield* Effect.all([
							costOf(sketch.object, least),
							costOf(sketch.object, 2 * least),
							costOf(sketch.object, 4 * least)
						])
						c.note(`${sketch.object}, ${sketch.size}`)
						for (const at of [n, twice, four]) {
							assert.equal(
								at.analyzed,
								0,
								`the installation measured at ${at.cost.owners} owners was analyzed`
							)
						}
						assert.ok(
							twice.cost.rows <= 2 * n.cost.rows && four.cost.rows <= 2 * twice.cost.rows,
							`its write under ${sketch.object} reads rows faster than linearly: ${Arr.join(
								Arr.map([n.cost, twice.cost, four.cost], costText),
								"; "
							)}`
						)
					})
			)
		)
	)
})
