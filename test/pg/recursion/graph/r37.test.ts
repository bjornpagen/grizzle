import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { costChosen } from "#compiler/sql/emit.ts"
import { printStatement } from "#compiler/sql/print.ts"
import {
	caseOf,
	type ForestFeature,
	forestGen,
	pageBelow,
	pageEdges
} from "#test/pg/recursion/graph/r37.fixtures.ts"
import {
	executedPlan,
	inInstalledCase,
	logicalOf,
	rowsOverLoops,
	statementParams,
	tableRowsRead
} from "#test/pg/recursion/graph/support.ts"
import { lowerAligned, partStatement } from "#test/support/compile.ts"
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
							/**
							 * Under no planner setting, beside the roots the forest holds besides its own (r37.fixtures.ts
							 * besideRoots), an edge table worth planning: each step of the seeded recursion probes the edge
							 * relation's key index at the working table's vertices, so the rows read are those of the
							 * traversal itself, where over a forest of a few dozen edges on one heap page the planner read the
							 * table whole for what a probe costs.
							 */
							const measured = yield* inInstalledCase(c, schema, (session, plan) =>
								Effect.gen(function* () {
									const names = plan.installation.names
									const optimized = lowerAligned(logicalOf(c), "query", {
										binding: costChosen(),
										names,
										context: "snapshot",
										catalog: installedCatalog(plan.installation)
									})
									const baseline = Result.flatMap(
										lowerConservative(conservativeInput(logicalOf(c)), {
											names,
											params: logicalOf(c).params,
											subject: { kind: "query" }
										}),
										sentConservative
									)
									if (!optimized.ok || !baseline.ok) {
										throw new Error("lowering failed")
									}
									const edgeTable = plan.tables["E"]?.name.name
									if (edgeTable === undefined) {
										throw new Error("no installed table for E")
									}
									/**
									 * One side's attachment: its program run whole, and its part alone executed under EXPLAIN
									 * (test/support/compile.ts partStatement), the CTEs it reads with it.
									 */
									const measure = (program: SentProgram, side: string) =>
										Effect.gen(function* () {
											const run = yield* runProgram(session, c, program, side, everyRow)
											const index = Option.getOrThrowWith(
												Arr.findFirstIndex(
													flight(program.roots),
													(st) => st.role.kind === "attachment"
												),
												() => new Error(`${side}: no attachment part`)
											)
											const part = flight(program.roots)[index]
											if (part === undefined) {
												throw new Error(`${side}: no attachment part`)
											}
											const root = yield* executedPlan(
												session,
												printStatement(partStatement(program, part.answer)),
												statementParams(c, program.statement)
											)
											const nodes = [...planNodes(root)]
											return {
												read: tableRowsRead(root, edgeTable),
												/**
												 * The distinct states the recursion computed, and the working-table rows its iterations
												 * fed back, over all of them.
												 */
												states: Arr.map(
													Arr.filter(nodes, (n) => n.nodeType === "Recursive Union"),
													rowsOverLoops
												),
												unionLoops: Arr.map(
													Arr.filter(nodes, (n) => n.nodeType === "Recursive Union"),
													(n) => n.actualLoops
												),
												feedback: Arr.reduce(
													Arr.filter(nodes, (n) => n.nodeType === "WorkTable Scan"),
													0,
													(sum, n) => sum + rowsOverLoops(n)
												),
												delivered: defined(run.statements[index], `${side}: the attachment run`)
													.rows.length
											}
										})
									return {
										seeded: yield* measure(optimized.value, "optimized"),
										pipelined: yield* measure(baseline.value, "conservative")
									}
								})
							)
							const planned = measured
							/** The page's closures, every vertex below each of its roots, and the forest's, every root's. */
							const closures = Arr.reduce(f.page, 0, (a, b) => a + b)
							const detail = Formatter.format(measured)
							assert.equal(planned.seeded.delivered, closures)
							assert.equal(planned.pipelined.delivered, closures)
							assert.deepEqual(planned.seeded.unionLoops, [1], detail)
							assert.deepEqual(planned.seeded.states, [closures], detail)
							assert.ok(planned.seeded.feedback <= closures, detail)
							assert.ok(planned.seeded.read <= pageEdges(f), detail)
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
					"a page of two roots of one edge each, over 40 edges on one heap page, which PostgreSQL reads whole through a nested loop over the page materialized rather than probe the key index twice; under no planner setting, beside 2,048 edges more (r37.fixtures.ts besideRoots), the step joined the working table to the edges by a hash of all 2,088, until the feedback started its chain (cte-policy heldSet), each state's edges a fenced seek",
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
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\tnode.kind === "Closed" || node.kind === "SelfRef" || restrictedByValues(node)',
				replacement: '\tnode.kind === "Closed" || restrictedByValues(node)',
				why: "The feedback starts no chain, so the seeded recursion's step joins the working table to the edges by PostgreSQL's estimate of it, a hash of every edge at each iteration: the page of two one-edge chains reads all 2,088 edges."
			},
			{
				file: "packages/engine/src/lower/shapes/attach-recursive/index.ts",
				original: "\tif (cx.feedback.has(child.id)) {",
				replacement: "\tif (!cx.feedback.has(child.id)) {",
				why: 'seedDecision refuses every recursive attachment as "the recursion being lowered" (the feedback test inverted), so no attachment is seeded and the pipelined statement stands.'
			}
		]
	})
