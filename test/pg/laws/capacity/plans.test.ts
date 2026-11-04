/**
 * A capacity law's maintenance never scans the counted relation whole: its work stays proportional to the group.
 *
 * PL/pgSQL caches each query of a function's body for the session, and after five custom plans PostgreSQL's
 * plan_cache_mode = auto may switch to a generic plan, one planned without the key values. When one wide
 * group dominates the source's statistics, the generic estimate for `grp = $1` is a large share of the table, and the
 * generic plan of the empty-group branch, `NOT EXISTS (SELECT 1 FROM seat WHERE quota = $1)`, is a sequential scan
 * that expects a match within a few rows: for a small or empty group it reads the whole table on every firing. A law
 * function therefore fixes `plan_cache_mode = force_custom_plan` beside its search_path, so each firing plans its
 * queries for the affected key.
 *
 * The property, over Quota(id, limit) and Seat(id, quota) under `capacity(on(Quota, "id"), { from: on(Seat, "quota"),
 * within: within(0n, ref("limit")) })`: a case draws the width of one wide quota, the size of a small one (none
 * included), and a number of firings past the plan cache's switch. Each case fills Seat with that skew, analyzed, and
 * plants its premise, that the generic plan of the group probe reads Seat sequentially (a required feature, read by
 * the tree's one EXPLAIN decoder). Then a fresh writer session fires the law that many times for the small quota,
 * each a seat inserted and the law made immediate in its own rolled-back transaction, and the transaction's own
 * statistics show Seat read by an index and never sequentially on every firing.
 */
import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { planNodeTypes } from "#bench/harness/explain.ts"
import { quotas, quotasLaw } from "#test/pg/laws/capacity/schemas.ts"
import { installCapacity, writerOf } from "#test/pg/laws/capacity/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The custom plans PostgreSQL makes before plan_cache_mode = auto may choose a generic one. */
const customPlansBeforeGeneric = 5

/** One drawn skew: the wide quota's seats, the small quota's (the group every firing lands in), and the firings. */
interface SkewSketch {
	readonly wide: number
	readonly small: number
	readonly firings: number
}

/**
 * The wide quota is wide enough that a custom plan for a small group reads Seat by its index: a table of a page or two
 * is read whole by any plan.
 */
const skewSketchGen: Gen<SkewSketch> = (source) => ({
	wide: source.draw(int(1000, 4000)),
	small: source.draw(element([0, 1, 3])),
	firings: source.draw(int(customPlansBeforeGeneric + 1, 12))
})

type SkewFeature = "a generic plan scans Seat" | `a small group of ${"none" | "some"}`

/** Planted: an empty small group, a third of the drawn sizes and so a few cases a run. */
const plantedSkews: ReadonlyArray<Kept<SkewSketch, SkewFeature>> = [
	{
		note: "an empty small quota beside a thousand seats",
		sketch: { wide: 1000, small: 0, firings: customPlansBeforeGeneric + 1 },
		draws: "",
		reaches: ["a small group of none"]
	}
]

layer(Substrate.layer)("capacity law plans on skewed statistics", (it) => {
	it.effect(
		"the law reads the counted relation through its index on every firing, never by a sequential scan",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { admin } = yield* Substrate
					const install = yield* installCapacity(quotas(), "capplans")
					const quota = install.table("Quota")
					const seat = install.table("Seat")
					/** Seat's sequential and index scans in the current transaction. */
					const scans = `SELECT seq_scan::int4, idx_scan::int4 FROM pg_catalog.pg_stat_xact_all_tables WHERE relid = '${install.schema}.seat'::regclass`
					return yield* explore(
						{
							suite: "laws/capacity-plans",
							draw: drawn(skewSketchGen),
							literal: Formatter.format,
							kept: plantedSkews,
							runs: 16,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							coverage: required<SkewFeature>(
								["a generic plan scans Seat", "a small group of none", "a small group of some"],
								{ cases: 16, sense: notesOnly }
							),
							caseHang: Duration.minutes(2)
						},
						(sketch, c) =>
							Effect.gen(function* () {
								c.note(`a small group of ${sketch.small === 0 ? "none" : "some"}`)
								yield* transaction(admin, [
									`TRUNCATE ${seat}, ${quota}`,
									`INSERT INTO ${quota} ("id", "limit") VALUES (1, 99999.0), (2, 99999.0)`,
									`INSERT INTO ${seat} ("id", "quota") SELECT g, 1 FROM pg_catalog.generate_series(1, ${sketch.wide}) AS g`,
									`INSERT INTO ${seat} ("id", "quota") SELECT ${sketch.wide} + g, 2 FROM pg_catalog.generate_series(1, ${sketch.small}) AS g`
								])
								yield* admin.query(`VACUUM (ANALYZE) ${quota}, ${seat}`, [])

								yield* admin.query("BEGIN", [])
								yield* admin.query("SET LOCAL plan_cache_mode = force_generic_plan", [])
								yield* admin.query(
									`PREPARE capplans_probe(int4) AS SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${seat} AS "r" WHERE "r"."quota" = $1)`,
									[]
								)
								const generic = yield* admin.queryValues(
									"EXPLAIN (FORMAT JSON) EXECUTE capplans_probe(2)",
									[]
								)
								yield* admin.query("DEALLOCATE capplans_probe", [])
								yield* admin.query("ROLLBACK", [])
								if (
									planNodeTypes(defined(generic[0]?.[0], "the EXPLAIN cell")).includes("Seq Scan")
								) {
									c.note("a generic plan scans Seat")
								}

								yield* Effect.scoped(
									Effect.gen(function* () {
										const w = yield* writerOf(install, "writer")
										for (let i = 0; i < sketch.firings; i++) {
											yield* w.begin
											const [before] = yield* w.values(scans, [])
											yield* w.query(
												`INSERT INTO ${seat} ("id", "quota") VALUES (${sketch.wide + sketch.small + 1 + i}, 2)`,
												[]
											)
											yield* w.query(install.immediate(quotasLaw, "Seat"), [])
											const [after] = yield* w.values(scans, [])
											yield* w.rollback
											const seq = Number(after?.[0]) - Number(before?.[0])
											const idx = Number(after?.[1]) - Number(before?.[1])
											assert.equal(seq, 0, `firing ${i + 1} scans Seat sequentially`)
											assert.ok(idx > 0, `firing ${i + 1} reads Seat by an index`)
										}
									})
								)
							})
					)
				})
			),
		600_000
	)
})
