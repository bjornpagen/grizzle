import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
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
import { Substrate } from "#test/support/substrate/substrate.ts"

/** R37: a recursive attachment seeded once from the parent keys reads only the edges of the delivered parents' chains, in one Recursive Union for the page. */
export const r37ARecursiveAttachmentSeededOnceFromTheParentKeysReadsOnlyTheEdgesOfTheDeliveredParentsChainsInOneRecursiveUnionForThePage =
	property.explore(forestGen, {
		needs: { tx: Substrate.transaction },
		situations: [
			"a page of one root",
			"a page of several roots",
			"a page of chains of two depths"
		] satisfies ReadonlyArray<Reached<ForestFeature>>,
		/** Its pre-conversion budget: runs 6, coverage cases 8 (r37.test.ts at 4fbc3e95). */
		budget: { runs: 6, steered: 8 },
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
							 * With hash joins the planner reads the small edge table whole once per statement, and so it does
							 * through a nested loop over the page materialized, which it prefers to probing while the edge
							 * table fits a heap page: at 40 edges, each probe of the key index is costed a random heap page,
							 * the whole table one. The page the attachment reads is the statement's MATERIALIZED CTE
							 * (lower/shapes/index.ts OptimizedDelivery heldRows), which no planner setting keeps a nested loop
							 * from rescanning, so the probed reading costs a random page as a sequential one. Where it probes
							 * the edge relation's key index instead, the rows read are those of the traversal itself.
							 */
							const measured = yield* inInstalledCase(c, schema, (session, plan) =>
								Effect.gen(function* () {
									const names = plan.installation.names
									const optimized = lowerAligned(logicalOf(c), "query", {
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
									const planned = {
										seeded: yield* measure(optimized.value, "optimized"),
										pipelined: yield* measure(baseline.value, "conservative")
									}
									for (const setting of [
										"enable_seqscan",
										"enable_hashjoin",
										"enable_mergejoin",
										"enable_material"
									]) {
										yield* session.query(`SET LOCAL ${setting} = off`, []).pipe(Effect.orDie)
									}
									yield* session.query("SET LOCAL random_page_cost = 1", []).pipe(Effect.orDie)
									const probed = { seeded: yield* measure(optimized.value, "optimized") }
									return { planned, probed }
								})
							)
							const { planned, probed } = measured
							/** The page's closures, every vertex below each of its roots, and the forest's, every root's. */
							const closures = Arr.reduce(f.page, 0, (a, b) => a + b)
							const detail = Formatter.format(measured)
							assert.equal(planned.seeded.delivered, closures)
							assert.equal(planned.pipelined.delivered, closures)
							assert.deepEqual(planned.seeded.unionLoops, [1], detail)
							assert.deepEqual(planned.seeded.states, [closures], detail)
							assert.ok(planned.seeded.feedback <= closures, detail)
							assert.deepEqual(probed.seeded.states, [closures], detail)
							assert.ok(probed.seeded.read <= pageEdges(f), detail)
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
					"a page of two roots of one edge each, over 40 edges on one heap page, which PostgreSQL reads whole through a nested loop over the page materialized rather than probe the key index twice",
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
