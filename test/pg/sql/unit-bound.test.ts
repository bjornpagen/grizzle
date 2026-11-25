/**
 * The unit-bound walk's reading of PostgreSQL, judged by PostgreSQL 19 (sql/unit-bound.ts). Sound: wherever the walk
 * finds a scan of a unit's relation bound, every plan PostgreSQL makes of the statement compares the unit's column at
 * that scan to a value fixed for it. Complete for its rules: wherever every plan compares it to a value no join of the
 * scan's own plan supplies, a constant, a parameter, an InitPlan's output or an outer row's column a SubPlan is given,
 * the walk finds it bound; a comparison to a column of a row its own plan joins is a plan's choice, which a hash join
 * reads whole, so the walk leaves the scan unbound by construction (a scan equated to a sibling), and so is an outer
 * row's column in an EXISTS's SubPlan, which PostgreSQL may run hashed, once over every row: no plan's choice counts
 * against the walk. And under the statistics the installation itself declares, every scan the walk binds that
 * PostgreSQL costs for its every row and compares at its unit by an equality reads its unit's column through an index
 * condition: under a limit, on a semi- or an anti-join's inner side, or in an EXISTS's, an ANY's or an ALL's sub-plan,
 * it costs the fraction of its rows the first match or the limit needs, which a filtered scan may win; and a membership
 * of an array parameter a generic plan estimates as ten values (selfuncs.c estimate_array_length), which another index's
 * order may win. The walk models PostgreSQL's rewrites before any choice by cost (pull-up, sub-links made joins,
 * outer joins made inner, self-joins at a key made one scan, classes of equal values, restrictions moved into a query computed apart, a sub-link's outer
 * columns as parameters, one of no row of its level an InitPlan, its ARRAY a parameter); a scan it binds that a plan
 * does not is a rule it overstates, and a scan every plan compares to a fixed value that it leaves unbound a rule it
 * lacks. Whether PostgreSQL reads a compared column through an index is the declared statistics' to decide, never the
 * walk's: the third claim fails on a gap of theirs.
 *
 * The walk reads each outer row's column as PostgreSQL does, a parameter of the block that reads it, whatever holds it
 * (sql/unit-bound.ts OuterReading `parameter`): the invariant's own reading, which asks the outer column to be held, is
 * the definition's, no fact of PostgreSQL's (test/unit/sql/unit-bound.test.ts holds it to this one). The box and the
 * space are unit-bound.fixtures.ts's: the box installed by grizzle, filled, its sizes counted. A scan's conditions are
 * those its plan node compares, its index condition, its recheck and its filter, and its bitmap's index condition: a
 * join's condition is no condition of its scans, which a hash join reads whole. A scan of no plan, a join PostgreSQL
 * removed, is judged by no plan; one PostgreSQL plans twice, a CTE's read in place at two reads, is judged at each copy
 * (`copyOf`).
 *
 * And total: the walk reaches every scan the statement holds, each judged at a level of it (sql/unit-bound.ts readFaults,
 * against the statement's one total traversal), never one it leaves unwalked.
 *
 * Oracle: PostgreSQL's generic plans, the statement prepared and planned with plan_cache_mode at force_generic_plan as
 * every login's role plans it (unit-bound.fixtures.ts preparedAs, explainedPlan), under the declared statistics and
 * under four stated over them (as analyzed, huge with few values, tiny, huge with every value its own) and with the
 * nested loop off over the last (unit-bound.fixtures.ts statisticsStates), prepared again under each, the walk's verdict
 * judged against every one.
 *
 * Features: a scan bound and one left unbound, a fenced FROM query, a sub-link, a left join, a CTE, a set operation, an
 * ARRAY sub-select, a correlated one, a CTE read twice, a function of a sub-select, a restricted read of a MATERIALIZED
 * CTE.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { printStatement } from "#compiler/sql/print.ts"
import { readFaults } from "#compiler/sql/unit-bound.ts"
import {
	type BoundFeature,
	boxTables,
	boxTemplate,
	drawnGen,
	explainedPlan,
	installedStatement,
	preparedAs,
	scansOf,
	statisticsStates,
	unitBoundAt
} from "#test/pg/sql/unit-bound.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Whether a plan's scan alias `planned` is the drawn scan `drawn`'s: its alias, or a copy's, which EXPLAIN tells apart
 * by a suffix (ruleutils.c set_rtable_names), a CTE read in place at two reads, each read its body's own copy. No
 * drawn alias holds an underscore.
 */
const copyOf = (planned: string, drawn: string): boolean =>
	planned === drawn ||
	(Str.startsWith(`${drawn}_`)(planned) &&
		Arr.every(Str.split(Str.slice(drawn.length + 1)(planned), ""), (d) => d >= "0" && d <= "9"))

/** What a value EXPLAIN prints may begin with where it is no column: a constant, a parameter, a sub-plan's output. */
const valueStarts = ["(", "'", "$", "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const

/**
 * Whether a comparison's other side is a value a join supplies, never fixed whatever plan PostgreSQL chooses: a column
 * of a row its own plan reads (`local`), or, in an EXISTS's SubPlan, which PostgreSQL may run hashed (`hashable`), any
 * column, an outer row's among them.
 */
const joinSupplied = (side: string, local: ReadonlySet<string>, hashable: boolean): boolean => {
	const [alias, ...rest] = Str.split(side, ".")
	const column =
		rest.length > 0 && alias !== "" && Arr.every(valueStarts, (p) => !Str.startsWith(p)(alias))
	return column && (hashable || local.has(alias))
}

/**
 * A scan the walk binds is compared at its unit's column by every plan PostgreSQL makes, and one every plan compares
 * so the walk binds: its model of PostgreSQL's rewrites neither overstates nor lacks a rule. Under the declared
 * statistics each one it binds that is costed for its every row is read through an index condition on its unit's column.
 */
export const aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds =
	property.explore(drawnGen, {
		needs: { stored: Substrate.rolledBack(boxTemplate) },
		situations: [
			"a scan the walk binds",
			"a scan the walk leaves unbound",
			"a fenced FROM query",
			"a sub-link",
			"a left join",
			"a CTE",
			"a set operation",
			"an ARRAY sub-select",
			"a correlated ARRAY sub-select",
			"a CTE read twice",
			"a function of a sub-select",
			"a restricted read of a MATERIALIZED CTE"
		] satisfies ReadonlyArray<Reached<BoundFeature>>,
		check:
			({ stored }, c: Case<BoundFeature>) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value: installed } = yield* stored
					yield* connection.query("SET LOCAL plan_cache_mode = force_generic_plan", [])
					const statement = installedStatement(drawn.statement, installed)
					const sql = printStatement(statement)
					const faults = readFaults(
						{ kind: "statement", statement },
						boxTables(installed),
						"parameter"
					)
					const unwalked = Arr.flatMap(faults, (f) =>
						f.kind === "unboundUnitRead" && Arr.some(f.missing, (m) => m.reason === "unwalked")
							? [f.alias]
							: []
					)
					assert.ok(
						unwalked.length === 0,
						`the walk reached no level that holds ${Arr.join(unwalked, ", ")}: statement ${sql}`
					)
					const unbound = new Set(
						Arr.flatMap(faults, (f) => (f.kind === "unboundUnitRead" ? [f.alias] : []))
					)
					/**
					 * Each unit scan's verdict in each state's plan: compared everywhere it stands, or not, and compared so to a
					 * value no join of its own plan supplies (a constant, a parameter, an outer row's), or not.
					 */
					const truth = new Map<
						string,
						Array<{
							readonly state: string
							readonly bound: boolean
							readonly fixed: boolean
							readonly seen: string
						}>
					>()
					for (const state of statisticsStates(installed)) {
						for (const s of state.statements) {
							yield* connection.query(s, [])
						}
						yield* connection.query(preparedAs("judged", sql), [])
						const rows = yield* connection.queryValues(explainedPlan("judged"), [])
						yield* connection.query("DEALLOCATE judged", [])
						const nodes = scansOf(rows[0]?.[0])
						for (const scan of drawn.scans) {
							const unit = scan.table.unit
							const at = Arr.filter(nodes, (n) => copyOf(n.alias, scan.alias))
							if (unit === undefined || at.length === 0) {
								continue
							}
							const column = (c: string): string => installed.names.column(scan.table.name, c)
							truth
								.getOrInsertComputed(scan.alias, () => [])
								.push({
									state: state.name,
									bound: Arr.every(at, (n) =>
										unitBoundAt(n.conditions, n.alias, scan.table, column, () => false)
									),
									seen: Arr.join(
										Arr.map(
											at,
											(n) => `${n.node} ${n.alias} comparing ${Arr.join(n.conditions, " and ")}`
										),
										"; "
									),
									fixed: Arr.every(at, (n) =>
										unitBoundAt(n.conditions, n.alias, scan.table, column, (side) =>
											joinSupplied(side, n.local, n.hashable)
										)
									)
								})
							if (state.name === "declared" && !unbound.has(scan.alias)) {
								assert.ok(
									Arr.every(
										at,
										(n) =>
											n.fractioned ||
											!unitBoundAt(n.conditions, n.alias, scan.table, column, (side) =>
												Str.startsWith("ANY (")(side)
											) ||
											unitBoundAt(n.indexed, n.alias, scan.table, column, () => false)
									),
									`${scan.alias}: the walk binds it, and under the declared statistics no index condition reads its unit at it, a gap of the declared statistics': its scans ${Arr.join(
										Arr.map(at, (n) => `${n.node} comparing ${Arr.join(n.conditions, " and ")}`),
										"; "
									)}; statement ${sql}`
								)
							}
						}
					}
					for (const feature of drawn.features) {
						c.note(feature)
					}
					for (const [alias, states] of truth) {
						const walked = !unbound.has(alias)
						c.note(walked ? "a scan the walk binds" : "a scan the walk leaves unbound")
						const plans = Arr.join(
							Arr.map(
								states,
								(s) =>
									`${s.state}: ${s.fixed ? "compared to a value no join supplies" : s.bound ? "compared through a join" : "not compared"} (${s.seen})`
							),
							"; "
						)
						assert.ok(
							walked ? Arr.every(states, (s) => s.bound) : !Arr.every(states, (s) => s.fixed),
							`${alias}: the walk finds it ${walked ? "bound" : "unbound"}; PostgreSQL's plans ${plans}; statement ${sql}`
						)
					}
				}),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL 19's generic plans under the declared statistics, four stated over them and the nested loop off, each unit scan compared at its unit's column or not, against the walk's verdict; under the declared ones, an index condition at each scan it binds that is costed for its every row"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:0.1.1.1.0.0.1.0.3.0.0.0.0.1.0.0.0.0.0.0.0.1.0.1.0.0.0.0.0.0.4.2.3.0.0.1.4.0.0.0.2.0.2.0.0.3.0.0.1.3.0.4.2.1.0.0.0.1.0.0.0.0.1.0.0.0.2.0.0.0.0.0.1.1.0.0.1.0.0.0.0.2.0.0.0.0.0.1.1.0.4.0.0.1.0.3.0.0.0.0.0.0.0.4.1.1.0.0.0.1.0.0.0.0.0.0.1.3.0.4.0.0.3.0.3.0.0.0.0.0.0.0.0.0.0.0.0.6.1.0.0.0.0.0.3.0.0.0.0.0.2.0.0.0.0.0.0.0.0.4.0.0.1.0.3.0.0.0.0.0.0.0.4.2.4.1.0.0.1.2.0.0.0.0.0.2.0.0.0.4.0.0.2.0.0.0.0.0.3.0.0.1.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.6.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.8.1.4.0.0.0.0.0.0.2.0.0.1.0.0.3.0.2.0.0.2.0.0.0.0.0.0.0.1.0.0.1.2.0.2.7.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0"
				),
				reason:
					"a level its WHERE equates to two literals, whose sub-link reads a function of a sub-select of ua whole: PostgreSQL still plans the sub-link as a SubPlan, its scan read whole",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:0.1.1.0.2.0.0.1.3.0.3.0.6.0.0.1.0.0.0.0.0.0.0.0.0.0.1.3.0.0.2.0.0.3.1.0.0.0.0.0.0.0"
				),
				reason:
					"a MATERIALIZED CTE whose read is restricted at a column its body delivers a unit's column at: PostgreSQL computes the CTE whole, so the restriction reaches none of its scans",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.1.3.1.3.2.3.1.0.0.1.0.0.0.1.0.0.1.0.0.0.0.2.0.0.0.0.0.0.0.0.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.3.0.4.0.0.3.0.2.0.0.2.0.0.0.0.0.0.0.0.0.4.0.0.2.0.2.0.0.2.0.0.0.0.0.4.0.0.0.0.0.0.0.0.3.2.1.0.0.2.0.0.0.0.0.3.0.0.0.0.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.1.3.0.0.2.0.0.0.0.0.2.0.0.0.1.3.0.0.0.0.0.4.0.0.1.0.3.0.0.0.0.4.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.2.0.0.0.1.1.2.1.1.2.1.0.0.0.1.0.0.0.0.1.0.0.2.0.0.0.0.0.2.0.2.0.0.0.0.0.1.1.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.1.1.1.1.1.0.0.1.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.1.3.0.0.0.0.0.3.0.0.0.0.0.0.0.0.1.2.0.6.0.0.1.0.2.0.0.0.0.4.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.1.0.7.1.1.3.1.0.0.1.0.0.0.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.3.3.0.0.0.0.7.0.0.1.1.1.0.0.1.0.0.0.0.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.1.0.2.0.0.0.2.1.1.0.0.0.0.0.3.0.2.0.0.0.0.0.0.3.0.0.0.0.0.0.1.1.0.0.2.0.0.0.0.0.2.0.0.0.0.0.1.3.0.4.0.0.1.0.3.0.0.0.0.0.0.0.0.6.1.0.0.1.1.0.0.0.0.0.0.0.0.3.4.0.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a constant of an EXCEPT's reader, which PostgreSQL moves into no arm of the EXCEPT, so its arms' scans read every row",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:0.1.1.0.0.1.0.0.0.1.0.0.0.0.0.0.0.3.0.4.1.0.0.1.3.0.0.0.0.0.3.0.0.0.0.0.0.1.0.4.0.0.2.0.0.0.0.0.3.0.0.1.0.4.0.0.0.0.0.0.1.0.0.0.2.1.2.1.1.1.0.0.0.0.1.1.0.6.1.3.3.1.2.6.0.0.0.6.0.0.1.0.0.0.0.0.0.1.0.1.0.0.0.0.0.0.0.0.0.1.1.0.0.1.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.1.1.1.0.1.1.0.3.1.0.0.0.0.1.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0"
				),
				reason:
					"a NOT MATERIALIZED CTE read in place three times, two of the reads in a query whose condition equates one column to two literals: PostgreSQL proves that query empty and plans none of its copies, the third copy compared at its constant",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:0.1.1.1.0.0.1.0.2.0.0.0.0.0.1.0.0.0.2.0.0.0.0.0.1.1.0.4.0.0.1.0.0.0.0.0.0.0.1.0.0.0.0.0.1.1.1.0.1.0.0.0.1.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.4.0.3.3.0.2.0.0.6.1.0.0.1.1.0.2.0.0.0.0.6.0.0.2.0.2.0.0.2.0.0.0.0.0.0.0.4.1.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.3.0.6.0.0.1.0.2.0.0.0.0.6.0.0.1.0.0.0.0.0.0.0.4.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.1.1.1.2.1.0.0.3.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.1.1.0.0.1.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.1.0.0.0.0.1.1.1.1.1.0.0.0.0.0.3.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.3.0.3.0.4.0.1.1.0.0.1.1.0.2.0.2.0.0.0.0.0.1.0.2.0.0.0.0.0.4.0.1.1.0.0.1.3.3.2.4.8.2.3.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"two scans of ua whose n is equated and whose class of n holds another column of one of them: PostgreSQL may join them on that column instead and keeps both scans, the constant of one fixing nothing of the other",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.0.0.0.2.3.4.0.0.0.0.3.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"an EXISTS of one scan of ua joined at the candidate key n to the outer scan of ua: PostgreSQL makes the semi-join inner (reduce_unique_semijoins) and the two scans one, so the outer constant fixes the inner scan",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.0.1.1.0.1.1.2.0.0.1.1.0.0.1.1.0.0.0.0.0.0.0.0.0.0.1.1.0.0.1.3.0.0.0.0.0.0.0.0.0.3.0.0.0.0.3.0.0.0.0.0.4.0.0.0.0.0.0.0.4.1.0.0.0.0.2.2.0.3.5.0.0.0.0.0.0.2.0.0.0.2.2.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"an EXISTS of a query pulled up whose own left join its WHERE reads strictly: the semi-join's condition stands above the EXISTS's rows, so PostgreSQL makes that join inner and its constant fixes the inner scan",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.2.0.0.1.0.0.0.0.0.0.1.0.3.0.0.2.1.0.0.1.0.2.0.2.0.0.0.0.0.1.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.1.1.1.0.0.0.2.0.4.1.1.1.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.1.3.0.7.1.1.1.0.1.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.1.2.0.0.0.0.1.1.1.0.0.1.0.2.0.0.0.0.0.0.0.0.2.0.4.0.0.3.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.6.2.1.1.2.0.0.0.0.1.0.0.1.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.2.0.6.0.1.1.0.0.1.3.0.2.0.0.0.0.0.0.3.1.0.0.0.0.3.0.2.0.0.0.0.0.0.3.0.0.0.7.1.0.1.1.0.0.1.0.1.0.0.0.0.2.0.0.0.0.0.4.1.0.0.0.0.0.1.5.0.0.0.3.0.0.0.2.2.0.0.0.0.0"
				),
				reason:
					"an EXISTS inside a query computed apart whose condition makes its own left join inner: its constant fixes the joined scan",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.0.1.1.2.1.1.1.1.1.0.0.0.0.0.0.2.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.1.0.2.0.0.0.0.0.1.1.1.0.0.1.1.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.1.2.0.4.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.1.2.0.0.0.0.1.1.0.0.3.0.0.0.0.0.2.0.0.0.0.0.1.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.1.0.0.0.0.2.0.3.0.6.0.1.1.2.1.1.0.0.1.1.0.3.2.0.0.0.0.0.0.0.0.0.0.2.1.0.2.1.2.4.0.0.0.4.2.g.2.0.0.0.2.2.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a LATERAL query pulled up beside a left join, its WHERE strict on the join's inner side: its conditions stand above its own rows alone, so PostgreSQL keeps the join outer and the inner scan unbound",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:1ff.1:1.2.1.1.1.1.1.2.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.1.3.0.0.0.0.0.2.0.0.2.0.0.0.0.0.0.0.1.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.4.1.0.0.0.0.1.1.0.6.1.0.0.0.0.0.0.0.0.0.0.0.0.6.1.1.1.0.0.1.0.0.0.0.0.1.1.0.0.0.0.0.3.0.0.0.0.0.2.0.0.2.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.1.0.1.0.0.0.2.0.3.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.1.1.1.1.2.1.0.0.2.0.2.0.0.2.0.0.0.0.0.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.1.1.0.0.0.2.0.4.1.0.0.1.3.0.0.0.0.0.0.0.0.0.3.3.0.0.0.8.0.0.1.0.2.2.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a correlated ARRAY sub-select, a SubPlan PostgreSQL computes for each outer row, its scan compared at an outer row's column it is given as a parameter",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:1ff.1:1.2.1.1.1.1.1.2.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.1.3.0.0.0.0.0.2.0.0.2.0.0.0.0.0.0.0.1.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.4.1.0.0.0.0.1.1.0.6.1.0.0.0.0.0.0.0.0.0.0.0.0.6.1.1.1.0.0.1.0.0.0.0.0.1.1.0.0.0.0.0.3.0.0.0.0.0.2.0.0.2.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.1.0.1.0.0.0.2.0.3.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.1.1.1.1.2.1.0.0.2.0.2.0.0.2.0.0.0.0.0.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.1.1.0.0.0.2.0.4.1.0.0.1.3.0.0.0.0.0.0.0.0.0.3.3.0.0.0.8.0.0.1.0.2.2.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a scan compared to an ARRAY of a sub-select correlated to its own row, a SubPlan PostgreSQL computes again for each row it reads: no fixed value",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.1.0.0.1.1.2.0.0.1.0.0.0.0.0.1.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.1.1.1.2.0.0.1.1.0.0.1.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.7.1.0.0.0.3.0.4.1.0.0.1.1.0.2.0.0.0.0.0.6.0.0.3.0.0.0.0.0.3.0.0.0.0.0.0.0.3.0.0.0.0.8.1.1.1.0.0.0.0.0.0.0.0.0.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.3.0.2.0.0.4.0.0.0.0.0.0.0.4.1.3.3.0.0.0.3.8.2.9.0.3.3.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"two scans of pp joined at package, each path fixed by its own constant, a parameter and a literal: no self-join PostgreSQL makes one, so the membership of one fixes nothing of the other",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.1.1.1.2.1.0.1.0.0.0.3.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.4.1.1.1.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.4.1.0.0.1.1.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.1.1.0.1.1.2.0.0.1.0.0.0.1.0.0.0.2.1.1.1.0.0.1.1.5.0.0.0.2.0.5.0.2.2.0.0.1.0.2.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0"
				),
				reason:
					"a left join whose inner side its own condition fixes, its equality to the preserved side's unit column: PostgreSQL gives the inner side's constant to no scan of the preserved side",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:0.1.2.1.0.0.0.2.0.0.0.0.0.1.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.9.4.0.1.2.3.0.0.0.3.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.3.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"an anti-join's inner scan equated to a left join's inner column, which a constant fixes below the left join: read above it the column may be NULL, so PostgreSQL compares the anti-join's scan at nothing",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:0.1.1.1.0.0.1.0.0.0.0.2.0.0.0.0.0.1.1.0.0.0.0.0.3.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.1.2.0.3.0.3.0.0.0.0.0.2.1.1.1.1.0.1.0.1.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.3.1.0.1.0.0.0.0.1.0.1.0.1.0.0.1.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.1.3.1.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.1.3.1.1.0.4.0.3.1.0.4.2.3.3.0.0.0.0.2.0.0.0.0.3.4.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a NOT EXISTS reading a left join's inner column inside a semi-join, the column fixed only below its join: PostgreSQL leaves the anti-join's scan unbound",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.0.1.1.1.1.0.1.0.0.0.1.0.3.0.0.0.0.0.0.0.0.0.1.1.2.1.1.0.0.1.0.1.3.0.1.0.0.0.1.1.1.0.0.1.2.4.2.0.0.3.2.0.0.3.2.2.1.0.1.h.3.0.1.1.3.0.0.0.0.0.0.0.0.0.2.0.0.0.1.1.0.0.0.0"
				),
				reason:
					"a scan bound by a membership of an array parameter beside another index's order: PostgreSQL estimates the membership as ten values and reads the scan in that order, filtering it",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.0.1.1.0.1.1.1.1.1.0.0.0.0.0.2.0.0.0.0.0.2.0.0.0.0.0.1.0.0.0.2.0.0.0.0.0.1.1.0.4.1.0.0.0.3.1.1.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"an EXISTS whose left join a strict condition makes inner, its two scans of ua joined at the candidate key n: PostgreSQL makes them one scan inside the semi-join's inner side, compared at the other's constant",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:0.1.0.0.0.2.0.4.0.1.2.0.2.1.3.0.0.0.0.0.0.3.0.0.0.0.0.2.2.1.1.3.3.1.2.0.3.0.0.0.0.0.0.0"
				),
				reason:
					"a NOT MATERIALIZED CTE read in place at two reads of one level: two copies, one restricted and one read whole, each judged on its own",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.0.1.1.0.1.1.2.1.1.0.0.1.1.0.0.0.0.0.0.0.0.1.1.0.0.1.1.0.3.0.0.0.0.1.0.0.1.3.0.3.0.3.3.4.1.0.0.1.2.5.3.3.2.j.8.0.1.0.0.0.1.2.0.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0"
				),
				reason:
					"a membership-bound scan on an anti-join's inner side, which PostgreSQL reads for the first match of each outer row and may scan by another index",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.0.0.0.2.0.7.0.0.0.0.0.1.0.0.0.0.0.0.2.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.1.3.0.0.0.0.0.2.0.0.4.1.0.0.1.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.7.1.2.1.1.1.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.4.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.2.1.1.0.0.0.0.0.0.0.3.0.0.0.0.0.2.7.0.4.0.0.1.0.0.0.0.0.0.0.2.0.0.0.2.2.1.1.0.0.0.0.8.2.2.0.0.0"
				),
				reason:
					"a LATERAL query reading an outer row in its WHERE beside an EXISTS: PostgreSQL makes the EXISTS a semi-join that wraps the query's conditions, so it no longer pulls the query up, and the reader's scan is compared only through a join",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.2.1.0.0.0.1.0.0.0.0.1.0.0.0.2.1.1.0.0.1.0.0.0.0.0.1.1.0.0.1.2.0.0.0.0.0.2.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.1.1.0.1.0.0.0.1.0.0.0.0.2.0.2.0.0.4.0.0.1.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.2.0.6.1.0.0.1.0.1.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.1.0.2.0.0.0.0.6.2.1.1.1.1.1.0.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0.0.2.0.0.0.0.0.0.0.0.2.0.0.0.0.0.1.1.0.6.1.0.0.1.0.0.0.0.0.0.0.1.1.2.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.1.0.2.0.2.0.0.0.0.0.1.2.1.0.1.0.0.0.2.0.0.0.0.0.3.3.4.0.0.3.0.2.0.0.2.2.0.2.0.0.0.0.0.6.0.0.0.0.0.0.4.0.0.0.0.0.0.2.0.0.3.2.2.1.3.0.2.f.0.3.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"an EXISTS in the WHERE of a LATERAL query pulled up, reading the query's own row and an outer row of the level it is pulled into: PostgreSQL converts the query's sub-links before it pulls it up, the outer row a parameter there, so the EXISTS is a semi-join whose constant fixes its scan",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:0.0.1.0.0.0.0.0.0.0.0.0.1.0.2.0.0.0.0.0.1.0.0.1.0.1.0.0.0.0.1.0.0.0.0.0.0.0.1.1.0.0.3.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.2.0.1.1.0.0.0.0.2.0.3.0.0.2.0.0.0.1.0.2.3.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a left join made inner by its WHERE, whose class holds two outputs of a DISTINCT query computed apart: PostgreSQL restricts the query by their equality and inside it a constant fixes both",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.0.1.1.1.0.0.1.1.2.0.0.0.0.1.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.2.5.0.0.0.1.0.0.0.1.0.4.2.1.1.0.0.1.0.1.0.0.0.0.1.1.0.0.1.0.1.0.0.0.0.1.1.0.0.1.0.0.0.0.0.0.0.0.0.0.2.0.2.0.0.4.1.0.0.1.2.0.2.c.0.0.0.0.5.1.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"an EXISTS nested in a semi-join's condition that reads the semi-join's outer side: PostgreSQL keeps it a SubPlan, its conversion reading the inner side's rows alone (available_rels)",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:0:1.2.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.4.1.1.1.2.0.0.1.1.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.1.0.0.0.0.0.0.0.0.0.0.3.0.2.0.0.3.0.4.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.1.1.2.0.0.2.0.0.3.0.3.0.0.0.0.0.2.2.1.0.0.2.2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a LATERAL query below an outer join that reads a row outside it: PostgreSQL plans it apart (is_simple_subquery), its equality to that row a parameter of its own",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/pg/sql/unit-bound.test.ts#aScanTheWalkBindsIsComparedAtItsUnitByEveryPlanAndOneEveryPlanComparesItBinds:-:1.0.1.1.1.0.0.1.1.2.0.0.0.0.1.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.2.5.0.0.0.1.0.0.0.1.0.4.2.1.1.0.0.1.0.1.0.0.0.0.1.1.0.0.1.0.1.0.0.0.0.1.1.0.0.1.0.0.0.0.0.0.0.0.0.0.2.0.2.0.0.4.1.0.0.1.2.0.2.c.0.0.0.0.5.1.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"an EXISTS with a GROUP BY, kept a SubPlan inside a semi-join's condition since it reads the semi-join's outer side, correlated by equalities alone: PostgreSQL drops its GROUP BY and may run it hashed, reading every row",
				since: "2026-11-25"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/print-once.ts",
				original:
					'\tq.orderBy.length === 0 &&\n\tq.limit === undefined &&\n\tq.offset === undefined &&\n\tq.body.kind === "core" &&\n',
				replacement: '\tq.orderBy.length === 0 &&\n\tq.body.kind === "core" &&\n',
				why: "A bounded FROM query read as pulled up: a restriction of its reader seems to reach the scans under its bound, which PostgreSQL never moves past a LIMIT, so a scan the walk binds is read whole."
			},
			{
				file: "packages/engine/src/sql/print-once.ts",
				original:
					'\tq.body.kind === "core" &&\n\tq.body.distinct === false &&\n\tq.body.groupBy.length === 0 &&\n',
				replacement: '\tq.body.kind === "core" &&\n\tq.body.groupBy.length === 0 &&\n',
				why: "A DISTINCT FROM query read as pulled up: a LATERAL one's outer columns become join conditions of its reader's level, which fix nothing, where PostgreSQL plans it apart with them as its parameters and compares its scans at them."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					"\t\tconst moves = q.limit === undefined && q.offset === undefined ? pushed : nothingPushed\n",
				replacement: "\t\tconst moves = pushed\n",
				why: "A constant moved past a bound into the query under it: PostgreSQL moves none past a LIMIT or an OFFSET, so the scan under it reads every row."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original: '\t\t\t\tconst into = body.op === "EXCEPT" ? nothingPushed : moves\n',
				replacement: "\t\t\t\tconst into = moves\n",
				why: "A constant moved into an EXCEPT's arms, which PostgreSQL never pushes a restriction into."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					'\t\t\t\t\tconst inner = level.groups.push({ kind: "outer", parent: group }) - 1\n\t\t\t\t\tthis.#source(level, step.source, inner, [...at, "leftJoin"])\n',
				replacement:
					'\t\t\t\t\tconst inner = group\n\t\t\t\t\tthis.#source(level, step.source, inner, [...at, "leftJoin"])\n',
				why: "A left join's condition read as an inner join's: the preserved side takes a constant of the nullable side's class, which PostgreSQL never gives back across an outer join."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					'\t\t\t\tconst inner = exists.not ? level.groups.push({ kind: "inner", parent: group }) - 1 : group\n',
				replacement: "\t\t\t\tconst inner = group\n",
				why: "A NOT EXISTS made a join of the level's own: the outer side takes the inner side's constants, which an anti-join never gives back, its outer rows those the inner side holds no row for."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					'\t\t\t\tconst inner = exists.not ? level.groups.push({ kind: "inner", parent: group }) - 1 : group\n',
				replacement:
					'\t\t\t\tconst inner = level.groups.push({ kind: "inner", parent: group }) - 1\n',
				why: "An EXISTS read as an anti-join: the outer side never takes the inner side's constant, where PostgreSQL's semi-join puts both sides' equalities in one class, so a scan of the outer side, or under it past a union, is compared at it."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					"\t\t\t\tif (a !== undefined && b !== undefined) {\n\t\t\t\t\tclasses.union(a, b)\n",
				replacement:
					"\t\t\t\tif (a !== undefined && b !== undefined && (a === constantKey || b === constantKey)) {\n\t\t\t\t\tclasses.union(a, b)\n",
				why: "No class of equal columns: a column equal to another the level fixes is left unfixed, where PostgreSQL's equivalence class fixes both."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original: '\t\t\t\t\tc.materialized === "NOT MATERIALIZED" &&\n',
				replacement: "\t\t\t\t\tc.materialized !== undefined &&\n",
				why: "A MATERIALIZED CTE read in place: PostgreSQL computes it whole, once, so its reader's restriction reaches none of its scans."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					'\t\treturn held !== undefined && (this.#outer === "parameter" || held[0] === true)\n',
				replacement: "\t\treturn held !== undefined && held[0] === true\n",
				why: "An ARRAY of a sub-select of no outer row taken for fixed only where its output is held: PostgreSQL evaluates it once, an InitPlan, and compares the scan at its array, a parameter, whatever the sub-select reads."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original: '\t\t\t\t\t\tthis.#fixedBy(t, level) === "class"\n',
				replacement: "\t\t\t\t\t\tthis.fixed(t, level)\n",
				why: "A membership read as a class's constant across a join: the other side of a left join's equality to a column = ANY of an array seems fixed, where PostgreSQL derives nothing from a membership and compares that side only through the join."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original: "\t\t\t\t\treturn level.encloses(level.resolved(t.item.group), group) &&\n",
				replacement: "\t\t\t\t\treturn true &&\n",
				why: "A left join's inner side read as fixed above its join: its class's constant fixes its scan, but read from outside the join its column may be NULL, so PostgreSQL derives nothing from it for an anti-join's or another join's scan."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original: '\t\t\t\t\t\tjoin?.kind === "outer" &&\n',
				replacement: '\t\t\t\t\t\tjoin?.kind === "never" &&\n',
				why: "No left join made an inner join: one whose inner side a strict condition of the level reads, its WHERE's, a semi-join's or a restriction moved in from outside, keeps no NULL-extended row, so PostgreSQL makes it an inner join, its scans one class with the level's, and a constant that condition equates them to fixes them."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					'\t\treturn rows.length > 0 && rows.every((a) => available.kind === "every" || available.rows.has(a))\n',
				replacement: "\t\treturn rows.length > 0\n",
				why: "An EXISTS made a join wherever it reads the level's rows: one nested in a semi-join's condition that reads the semi-join's outer side PostgreSQL keeps a SubPlan, its conversion reading the inner side's rows alone (available_rels), so its constant reaches no outer scan."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					'\t\t\tconst hashed = (s.label === "exists" || s.label === "notExists") && this.#hashable(s.query)\n',
				replacement: "\t\t\tconst hashed = false\n",
				why: "An EXISTS PostgreSQL keeps as a SubPlan read as compared at its outer row always: correlated by equalities alone, PostgreSQL may run it hashed, once over every row, so no outer value fixes its scans."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original: "\t\t\tconst twins = this.#twins(item, level)\n",
				replacement: "\t\t\tconst twins: ReadonlyArray<Item> = []\n",
				why: "No self-join made one scan: two scans of a table equated at every column of one of its keys PostgreSQL makes one (remove_useless_self_joins), so a membership or a constant that fixes one fixes the other."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					"\t\tif (pulledUp(q) && (!lateral || this.#lateralPulled(q, level, this.#outerJoin))) {\n",
				replacement: "\t\tif (pulledUp(q)) {\n",
				why: "Every plain LATERAL query pulled up: one below an outer join that reads a row outside it PostgreSQL plans apart (is_simple_subquery), so its equality to that row is a parameter of its own and no class of its reader's, and the reader's scan it equates is read whole."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original: "\t\t\tlevel.empty = [...values.values()].some((v) => v.size > 1)\n",
				replacement: "\t\t\tlevel.empty = false\n",
				why: "No level proved empty: one whose own class is equated to two different literals PostgreSQL plans as no rows at all, none of its scans, so a scan of it the walk faults has no plan to judge it against while a copy elsewhere is compared."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original: "\t\t\t\tlevel.readsApart(s.call)\n",
				replacement: "",
				why: "A function's arguments walked by no one: the scans of a sub-select a FROM function reads, an InitPlan PostgreSQL runs, are reached at no level of the walk, which the statement's total traversal finds unjudged."
			},
			{
				file: "packages/engine/src/sql/unit-bound.ts",
				original:
					'\t\t\t\treturn this.#outer === "parameter" || this.held(this.#column(table, column, at), at)\n',
				replacement: "\t\t\t\treturn this.held(this.#column(table, column, at), at)\n",
				why: "An outer row's column read as fixed only where held: a block PostgreSQL evaluates per outer row compares its scans at that row's values, its parameters, whatever holds them."
			}
		]
	})
