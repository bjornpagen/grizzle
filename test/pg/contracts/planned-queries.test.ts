import { assert } from "@bjornpagen/testing/assert"
/**
 * Planned queries per action bounded by the compile: one call of a program makes at most as many pg_stat_statements
 * entries as plannedQueriesOf states for its member (adapter/public/compile.ts, engine plan/planned.ts), at each user it
 * runs as and each level, a session's first call, its stand-ups among it, included. A test that measures a call by
 * pg_stat_statements, resetting it before the call, sizes pg_stat_statements.max by the bound and loses no entry: qti-pie's
 * work budget bounded it by lexing its migrations' PL/pgSQL, 411,162 entries over its result composition, about 200 MB
 * of shared memory, nearly all an over-count.
 *
 * The bound is the call's statements, each as the user that runs it, and every query PostgreSQL plans behind them, read
 * off the installation's own statements (physical/planned/graph.ts): each function body the call reaches, a trigger's
 * for its event, each referential action, each queries' identity the jumble's. It is loose by what a call may plan and
 * this one did not: the RAISE options of the one refusal a call may meet, a judge's TRUNCATE of a delta past the pages
 * its emptying keeps, a branch over rows a call did not write, the forms a single statement's batched executions may
 * send, a ROLLBACK and a refusal's diagnosis; and by queries PostgreSQL jumbles alike that the graph names apart.
 *
 * Each case: a drawn schema and workload (planned-queries.fixtures.ts), installed as generate drafts and serves it, each
 * call on a brand-new backend after pg_stat_statements_reset of the case's database: reads, a lawful insert of every
 * member, an insert a rule over a query refuses where one holds, and a put and a delete of each mutable member.
 *
 * Oracle: PostgreSQL's pg_stat_statements, track all and track_planning on, every entry of the case's database a call
 * made, by its user and its level.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	measured,
	type PlannedFeature,
	planGen
} from "#test/pg/contracts/planned-queries.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** One call makes no more pg_stat_statements entries, at any user and level, than its member's planned bound. */
export const aCallMakesNoMoreStatementEntriesThanItsPlannedBound = property.explore(planGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"a rule over a query judged",
		"a refused write",
		"a mutable fact put",
		"a referenced row deleted",
		"a stored join kept",
		"a read"
	] satisfies ReadonlyArray<Reached<PlannedFeature>>,
	check:
		({ substrate }, c: Case<PlannedFeature>) =>
		(s) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.gen(function* () {
						const calls = yield* measured(s, c.note)
						for (const call of calls) {
							const bound = call.bound
							assert.ok(
								bound.kind === "bounded",
								`${call.program} is bounded: ${Formatter.format(bound)}`
							)
							const made = Arr.reduce([...call.entries.values()], 0, (sum, n) => sum + n)
							assert.ok(
								made <= bound.queries,
								`${call.program} made ${String(made)} entries past its bound ${String(bound.queries)}: ${Arr.join(call.texts, "; ")}`
							)
							for (const user of ["login", "role", "owner"] as const) {
								for (const level of ["top", "nested"] as const) {
									const at = call.entries.get(`${user} ${level}`) ?? 0
									assert.ok(
										at <= bound.by[user][level],
										`${call.program} made ${String(at)} entries as the ${user} at the ${level} level, past its bound ${String(bound.by[user][level])}: ${Arr.join(call.texts, "; ")}`
									)
								}
							}
						}
					})
				),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "pg_stat_statements, track all and track_planning on, every entry of the case's database one call on a brand-new backend made after its reset, by user and level"
	},
	budget: { runs: 8, steered: 8 },
	show: Formatter.format,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/planned/graph.ts",
			original: "\t\t\t\twalked: walkBody(fn, event, shape.table)\n",
			replacement:
				'\t\t\t\twalked:\n\t\t\t\t\tshape.kind === "capture"\n\t\t\t\t\t\t? { ...walkBody(fn, event, shape.table), identities: [], raises: [] }\n\t\t\t\t\t\t: walkBody(fn, event, shape.table)\n',
			why: "The rule judge's captures plan nothing: every capture's query of the rows its statement wrote, its log of them and its move of the arm, leaves the count, and a write of a captured table makes more entries as the installation's owner than its bound."
		}
	]
})
