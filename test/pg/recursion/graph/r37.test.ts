import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { printAdvice } from "#compiler/sql/advice.ts"
import { AdviceScope } from "#compiler/sql/naming.ts"
import { resolvePlan } from "#compiler/sql/plan.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	caseOf,
	chainsCase,
	type ForestFeature,
	forestGen,
	pageBelow,
	pageEdges
} from "#test/pg/recursion/graph/r37.fixtures.ts"
import {
	inInstalledCase,
	logicalOf,
	rowsOverLoops,
	statementParams,
	tableRowsRead
} from "#test/pg/recursion/graph/support.ts"
import {
	advisedExplain,
	apart,
	flightScope,
	lawsHold,
	type PgClassState,
	pgClassStates,
	standIn
} from "#test/support/advice.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import { everyRow } from "#test/support/oracle/install/capture.ts"
import { runProgram, sentConservative, type SentProgram } from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** R37: a recursive attachment seeded once from the parent keys reads only the edges of the delivered parents' chains, in one Recursive Union for the page. */
export const r37ARecursiveAttachmentSeededOnceFromTheParentKeysReadsOnlyTheEdgesOfTheDeliveredParentsChainsInOneRecursiveUnionForThePage =
	property.explore(forestGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"a page of one root",
			"a page of several roots",
			"a page of chains of two depths"
		] satisfies ReadonlyArray<Reached<ForestFeature>>,
		/**
		 * Its search budget: 5 runs of its rotating stream, so a floor of 2 (a quarter of the runs, rounded up), and no
		 * steered case: its floor reaches every required situation. Its floor is fixed by its identity, so every run seed
		 * reaches its situations and judges its kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/graph/r37.test.ts's property, its search
		 * @unit cases: the rotating stream's runs, and the steered phase's most
		 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
		 *   stream
		 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
		 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
		 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
		 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged
		 *   after its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under
		 *   a verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
		 * @observed 2026-11-23 03:27 to 04:39 UTC
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
		 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
		 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
		 * @workload this property at { runs, steered } of { 6, 8 }, its pre-conversion budget (r37.test.ts at 4fbc3e95), then
		 *   { 1, 2000 }, { 5, 2000 }
		 * @result At { 6, 8 }, 10 cases at f1bf91a2f's gate, its kill went red on its first kept case. Green, every required
		 *   situation reached by a witness, and every kill killed at { 1, 2000 } (20 cases, 16 steered); { 5, 2000 } (9
		 *   cases, 0 steered); and at { 5, 0 } again under a verdict cache of its own (final1). Worker CPU is a loaded
		 *   machine's and not compared
		 * @decision runs 5 and steered 0, the fewest cases measured: a floor of 2 reaches every situation with no steered
		 *   case, where a floor of 1 needs 16; its kill is red on its kept case at every budget. The steered phase stops once
		 *   every situation is reached, so its cap costs no case beyond those it runs. No headroom: a run that reaches fewer
		 *   situations says which
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 5, steered: 0 },
		check:
			({ tx }, k: Case<ForestFeature>) =>
			(f) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const seat = yield* OracleSeat
							const schema = yield* seat.schema("seededx")
							const c = caseOf("PageBelow", pageBelow(f.page.length), {}, f)
							/** The page's closures, every vertex below each of its roots. */
							const closures = Arr.reduce(f.page, 0, (a, b) => a + b)
							yield* inInstalledCase(c, schema, (session, plan, load) =>
								Effect.gen(function* () {
									const installation = plan.installation
									const optimized = lowerAligned(logicalOf(c), "query", {
										binding: {
											kind: "advised",
											scope: new AdviceScope(),
											catalog: installation.catalog
										},
										names: installation.names,
										context: "snapshot",
										catalog: installedCatalog(installation)
									})
									const baseline = Result.flatMap(
										lowerConservative(conservativeInput(logicalOf(c)), {
											names: installation.names,
											params: logicalOf(c).params,
											subject: { kind: "query" }
										}),
										sentConservative
									)
									if (!optimized.ok || !baseline.ok) {
										throw new Error("lowering failed")
									}
									const edgeTable = defined(plan.tables["E"], "the installed table of E").name.name
									const bench: BenchSession = { values: session.queryValues }
									/**
									 * The case's facts written a chain at a time, every table stood in `state`
									 * (test/support/advice.ts standIn).
									 */
									const netTables = Arr.map(
										[plan.tables["V"], plan.tables["E"], plan.tables["Root"]] as const,
										(t) => printObjectName(defined(t, "an installed table of Net").name)
									)
									const stood = (state: PgClassState) =>
										standIn(
											bench,
											{
												tables: netTables,
												units: f.roots,
												load: (from, to) => load(chainsCase(c, f, from, to))
											},
											state
										)
									/** The rows a program delivers for its attachment part, run in full. */
									const delivered = (program: SentProgram, side: string) =>
										Effect.map(runProgram(session, c, program, side, everyRow), (run) => {
											const index = Option.getOrThrowWith(
												Arr.findFirstIndex(
													flight(program.roots),
													(st) => st.role.kind === "attachment"
												),
												() => new Error(`${side}: no attachment part`)
											)
											return defined(run.statements[index], `${side}: the attachment run`).rows
												.length
										})
									const pipelined = yield* apart(
										bench,
										"r37_pipelined",
										netTables,
										Effect.andThen(stood("analyzed"), delivered(baseline.value, "conservative"))
									)
									assert.equal(pipelined, closures)
									const statement = optimized.value.statement
									const resolve = installation.resolve
									const scope = flightScope(
										"the seeded attachment",
										[statement.sql],
										resolve,
										printAdvice(resolvePlan(statement.sql.plan, resolve))
									)
									/**
									 * The seeded statement in `state`, under the advice it carries once the plan laws
									 * hold over it (test/support/advice.ts lawsHold), run in full and explained
									 * (advisedExplain), its attachment's part the one that reads the edges: the distinct
									 * states its recursion computed, the working-table rows its iterations fed back, and the
									 * edges it read.
									 */
									const seeded = (state: PgClassState) =>
										apart(
											bench,
											"r37_seeded",
											netTables,
											Effect.gen(function* () {
												yield* stood(state)
												yield* lawsHold(bench, scope)
												const rows = yield* delivered(optimized.value, "optimized")
												const root = yield* advisedExplain(
													bench,
													statement.sql.text,
													statementParams(c, statement)
												)
												const nodes = [...planNodes(root)]
												const unions = Arr.filter(nodes, (n) => n.nodeType === "Recursive Union")
												const measured = {
													state,
													delivered: rows,
													read: tableRowsRead(root, edgeTable),
													states: Arr.map(unions, rowsOverLoops),
													unionLoops: Arr.map(unions, (n) => n.actualLoops),
													feedback: Arr.reduce(
														Arr.filter(nodes, (n) => n.nodeType === "WorkTable Scan"),
														0,
														(sum, n) => sum + rowsOverLoops(n)
													)
												}
												const detail = Formatter.format(measured)
												assert.equal(measured.delivered, closures, detail)
												assert.deepEqual(measured.unionLoops, [1], detail)
												assert.deepEqual(measured.states, [closures], detail)
												assert.ok(measured.feedback <= closures, detail)
												assert.ok(measured.read <= pageEdges(f), detail)
											})
										)
									for (const state of pgClassStates) {
										yield* seeded(state)
									}
								})
							)
							k.note(f.page.length === 1 ? "a page of one root" : "a page of several roots")
							if (new Set(f.page).size > 1) {
								k.note("a page of chains of two depths")
							}
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "specification",
			name: "the page's closures counted on the host: states, rows read and delivered rows bounded by them"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/recursion/graph/r37.test.ts#r37ARecursiveAttachmentSeededOnceFromTheParentKeysReadsOnlyTheEdgesOfTheDeliveredParentsChainsInOneRecursiveUnionForThePage:-:0.0.1.2.0.0"
				),
				reason:
					"a page of two roots of one edge each, over 40 edges on one heap page, which PostgreSQL read whole by its own costs, through a nested loop over the page materialized, rather than probe the key index twice; and the step joined the working table to the edges by a hash of all of them, until the feedback started its chain (cte-policy heldSet), each state's edges a fenced seek, which the statement's advice reads by the key index in every pg_class state",
				since: "2026-11-17"
			},
			{
				token: ReplayToken(
					"test/pg/recursion/graph/r37.test.ts#r37ARecursiveAttachmentSeededOnceFromTheParentKeysReadsOnlyTheEdgesOfTheDeliveredParentsChainsInOneRecursiveUnionForThePage:-:0.0.1.4.0.0.4.5"
				),
				reason:
					"a page whose chains of five and six edges loop the recursion's working table over several iterations, whose rows per loop PostgreSQL reports to two decimal places",
				since: "2026-11-17"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/attach-recursive/index.ts",
				original: "\tif (cx.feedback.has(child.id)) {",
				replacement: "\tif (!cx.feedback.has(child.id)) {",
				why: 'seedDecision refuses every recursive attachment as "the recursion being lowered" (the feedback test inverted), so no attachment is seeded and the pipelined statement stands.'
			}
		]
	})
