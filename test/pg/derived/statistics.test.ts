import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record, Result } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import {
	build,
	byRowText,
	sketchGen,
	type StatisticsFeature,
	type StatisticsRow,
	workloadAims
} from "#test/pg/derived/statistics.fixtures.ts"
import { assert, defined } from "#test/support/assert.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { pickFrom } from "#test/support/pick.ts"
import { withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fixtureLogin, planOf } from "#test/unit/workload/fixtures.ts"

/**
 * Extended statistics on derived relations every statistics object a workload justifies is installed on its view or table and admitted, and a dropped one is drift.
 *
 * Its pre-conversion budget: runs 4, coverage cases 4 (test/pg/derived/statistics.test.ts at d8eed1786).
 */
export const extendedStatisticsOnDerivedRelationsEveryStatisticsObjectAWorkloadJustifiesIsInstalledOnItsViewOrTableAndAdmittedAndADroppedOneIsDrift =
	property.explore(aimed(sketchGen, workloadAims), {
		needs: { substrate: Substrate.installing },
		situations: [
			"statistics on a view",
			"statistics on a table",
			"view statistics two programs justify",
			"a view's statistics dropped"
		] satisfies ReadonlyArray<Reached<StatisticsFeature>>,
		check:
			({ substrate }, c: Case<StatisticsFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const built: Array<ReturnType<typeof build>> = []
							const m = yield* migrated({
								label: "derived_stats",
								schemaName: { kind: "unique" },
								first: (name) => {
									const b = build(name, sketch.workload)
									built.push(b)
									return { schema: b.value, logins: [b.server] }
								},
								apply: { kind: "noPlaceholders" },
								later: [],
								observe: noObservation,
								declared: () => noDeclarations
							})
							const b = defined(built[0], "the schema")
							const derivedNames = new Set(["Totals", "Placed"])
							/** The login's workload, planned as its migration planned it. */
							const plan = planOf(b.value, b.owned)
							const statistics = plan.statistics
							const access = Record.values(
								defined(plan.access[fixtureLogin], "the login's programs' access")
							)
							/** Every level's PostgreSQL schema: a level's tables and materialized views live in its own. */
							const levels = Arr.join(
								Arr.map(m.installation.names.levels, (l) => quoteString(identifierOf(l))),
								", "
							)
							/** The catalog's statistics are exactly the plan's, each on its relation in that relation's
							 * level's schema, with all three kinds. */
							const installed = () =>
								Effect.map(
									m.owner.values(
										`SELECT n.nspname::text, x.stxname::text, c.relname::text, c.relkind::text,
													(SELECT string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C")
													 FROM pg_catalog.pg_attribute AS a
													 WHERE a.attrelid = x.stxrelid AND a.attnum = ANY (x.stxkeys))::text,
													array_to_string(x.stxkind, ',')::text,
													pg_catalog.pg_get_statisticsobjdef(x.oid)::text
												 FROM pg_catalog.pg_statistic_ext AS x
												 JOIN pg_catalog.pg_class AS c ON c.oid = x.stxrelid
												 JOIN pg_catalog.pg_namespace AS n ON n.oid = x.stxnamespace
												 WHERE n.nspname IN (${levels})
												 ORDER BY 1, 2`,
										[]
									),
									(rows) => trusted<ReadonlyArray<StatisticsRow>>(rows)
								)
							const before = yield* installed()
							const expected = Arr.sort(
								Arr.map(statistics, (s) => {
									const on = m.installation.names.relation(s.relation)
									return [
										on.schema,
										on.name,
										derivedNames.has(s.relation) ? "m" : "r",
										Arr.join(
											Arr.sort(
												Arr.map(s.columns, (column) =>
													identifierOf(identity.column(parsedName(column)))
												),
												Order.String
											),
											","
										),
										"d,f,m"
									]
								}),
								byRowText
							)
							assert.deepEqual(
								Arr.sort(
									Arr.map(before, ([level, , table, kind, columns, kinds]) => [
										level,
										table,
										kind,
										columns,
										kinds
									]),
									byRowText
								),
								expected
							)
							for (const s of statistics) {
								if (!derivedNames.has(s.relation)) {
									c.note("statistics on a table")
								} else {
									c.note("statistics on a view")
									const requesting = Arr.filter(access, (a) =>
										Arr.some(
											a.statistics,
											(q) =>
												q.relation === s.relation &&
												Arr.join(q.columns, ",") === Arr.join(s.columns, ",")
										)
									)
									if (requesting.length > 1) {
										c.note("view statistics two programs justify")
									}
								}
							}
							/** Both paths admit the installed catalog. */
							const admitted = Effect.gen(function* () {
								const reapplied = yield* m.reapply
								assert.deepEqual(reapplied.applied, [])
								yield* withServedDb(m, b.server.roles.reader, {}, () => Effect.void)
							})
							yield* admitted
							const views = Arr.filter(before, ([, , , kind]) => kind === "m")
							if (views.length === 0) {
								return
							}
							const [level, dropped, , , , , definition] = pickFrom(
								[defined(views[0], "a view's statistics"), ...views.slice(1)],
								sketch.drop
							)
							yield* m.sql(`DROP STATISTICS ${quoteIdent(level)}.${quoteIdent(dropped)}`)
							c.note("a view's statistics dropped")
							const applied = yield* Effect.result(m.reapply)
							if (Result.isSuccess(applied)) {
								return assert.fail("migrate apply admits the dropped statistics")
							}
							assert.equal(applied.failure.stage, "drift")
							yield* withServedDb(m, b.server.roles.reader, {}, () => Effect.void)
							yield* m.sql(definition)
							yield* admitted
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the login's workload plan (planOf): the statistics it justifies, as PostgreSQL's catalog holds them, and the drift check's verdict on one dropped"
		},
		budget: { runs: 4, steered: 4 },
		kept: [],
		kills: []
	})
