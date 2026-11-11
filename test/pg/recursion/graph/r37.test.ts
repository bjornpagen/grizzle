import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import { indices } from "#compiler/core/array.ts"
import * as Result from "#compiler/core/result.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import type { Term } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema as declareSchema } from "#compiler/public/schema.ts"
import { printStatement } from "#compiler/sql/print.ts"
import {
	executedPlan,
	inInstalledCase,
	logicalOf,
	publicCase,
	rowsOverLoops,
	tableRowsRead,
	statementParams
} from "#test/pg/recursion/graph/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { lowerAligned, partStatement } from "#test/support/compile.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import { caseHang } from "#test/support/limits.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import type { GenContainment } from "#test/support/oracle/gen/schema.ts"
import { runProgram, type SentProgram, sentConservative } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R37: a recursive attachment seeded once from the parent keys.
 *
 * A drawn forest of 40 to 200 roots, each heading a chain of up to six edges, and a page of one to four roots (the
 * first by id), each chain of its own drawn depth, with the vertices below each attached. The attached recursion's
 * base reads the parent's id, which the checker carries in the state as the origin (check/recursion/origin.ts), so its
 * base is every edge and the pipelined statement computes the closure of every root and keeps the delivered parents'
 * (the conservative artifact). The optimized artifact seeds one recursive statement from the delivered parents' key
 * recordset: its states are exactly the page's closures, its rows read from the edge relation are proportional to
 * them, not to the forest, and one Recursive Union runs once for the page.
 *
 * That the seeded statement delivers exactly the pipelined closures is the graph suite's (equivalence.test.ts, the
 * attachment population against the conservative lowering) and the recursion oracle's (consumer:attach against the
 * reference evaluator).
 */

const V = relation("V", { id: pg.integer }, ["id"])
const E = relation("E", { from: pg.integer, to: pg.integer }, ["from", "to"])
const Root = relation("Root", { id: pg.integer }, ["id"])
const Pair = relation("Pair", { a: pg.integer, b: pg.integer }, ["a", "b"])
const Net = declareSchema("Net", { V, E, Root, Pair }, [
	contained(on(E, "from"), on(V, "id")),
	contained(on(E, "to"), on(V, "id")),
	contained(on(Root, "id"), on(V, "id")),
	contained(on(Pair, "a"), on(V, "id")),
	contained(on(Pair, "b"), on(V, "id"))
])

const containments: ReadonlyArray<GenContainment> = [
	{ from: { relation: "E", fields: ["from"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "E", fields: ["to"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "Root", fields: ["id"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "Pair", fields: ["a"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "Pair", fields: ["b"] }, to: { relation: "V", fields: ["id"] } }
]

/**
 * A forest: `roots` roots, root i = 10i heading the chain r -> r+1 -> ... -> r+d of its own depth d, the first `page`
 * roots by id the page, each chain of the page its drawn depth and every other `depth` deep.
 */
interface Forest {
	readonly roots: number
	readonly depth: number
	readonly page: ReadonlyArray<number>
}

/** A forest whose page is one root as often as it is two to four, so the streams that judge coverage reach both. */
const forestGen: Gen<Forest> = (source) => ({
	roots: source.draw(int(40, 200)),
	depth: source.draw(int(1, 6)),
	page: source.draw(
		oneOf([map(int(1, 6), (depth) => [depth]), array(int(1, 6), { min: 2, max: 4 })])
	)
})

const int4 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** Each root's id and its chain's depth. */
const chainsOf = (f: Forest): ReadonlyArray<readonly [root: number, depth: number]> =>
	Arr.map(indices(f.roots), (i) => [10 * i, f.page[i] ?? f.depth] as const)

const edgesOf = (f: Forest): ReadonlyArray<readonly [number, number]> =>
	Arr.flatMap(chainsOf(f), ([r, d]) => Arr.map(indices(d), (k) => [r + k, r + k + 1] as const))

const factsOf = (f: Forest) => ({
	V: Arr.flatMap(chainsOf(f), ([r, d]) => Arr.map(indices(d + 1), (k) => [int4(r + k)])),
	E: Arr.map(edgesOf(f), ([a, b]) => [int4(a), int4(b)]),
	Root: Arr.map(chainsOf(f), ([r]) => [int4(r)]),
	Pair: []
})

const caseOf = (
	label: string,
	q: unknown,
	params: Readonly<Record<string, TypedLiteral>>,
	f: Forest
): QueryCase =>
	publicCase({
		schema: Net,
		name: "Net",
		relations: ["V", "E", "Root", "Pair"],
		containments,
		facts: factsOf(f),
		label,
		query: q,
		params
	})

type ForestFeature =
	| "a page of one root"
	| "a page of several roots"
	| "a page of chains of two depths"

/** The forests kept from failure reports, each replayed first by value. */
const kept: ReadonlyArray<Kept<Forest, ForestFeature>> = [
	{
		note: "a page of two roots of one edge each, over 40 edges on one heap page, which PostgreSQL reads whole through a nested loop over the page materialized rather than probe the key index twice",
		sketch: { roots: 40, depth: 1, page: [1, 1] },
		draws: "",
		reaches: ["a page of several roots"]
	},
	{
		note: "a page whose chains of five and six edges loop the recursion's working table over several iterations, whose rows per loop PostgreSQL reports to two decimal places",
		sketch: { roots: 40, depth: 1, page: [1, 1, 5, 6] },
		draws: "",
		reaches: ["a page of several roots", "a page of chains of two depths"]
	}
]

/** The transition arm the definition uses: a rule over Net, and the feedback of a state of one vertex. */
type NetRule = Rule<typeof Net>
type NodeSelf = SelfSource<{ readonly node: typeof pg.integer }>

const forward = (r: NetRule, self: NodeSelf) => {
	const { node } = v(self, "self")
	const { to } = v(E, "e")
	return r.match(self, { node }).match(E, { from: node, to }).find({ node: to })
}

/** The first `n` roots by id: the page the closures are attached to. */
const page = (n: number) =>
	query(Net)
		.rule((r) => {
			const { id } = v(Root, "root")
			return r.match(Root, { id }).find({ id })
		})
		.orderBy(["id", "asc"])
		.take(n)

/**
 * The vertices one or more steps below the parent: the base reads the parent's column `from`, its id unless an
 * attachment names another.
 */
const below = (from: Term<number, unknown, unknown, "integer">) =>
	query(Net).recursive("Below", {
		row: { node: pg.integer },
		base: [
			(r) => {
				const { to } = v(E, "e")
				return r.match(E, { from, to }).find({ node: to })
			}
		],
		rec: [forward]
	})

const pageBelow = (n: number) => page(n).attach("below", (p) => below(p.id), "array")

layer(Substrate.layer)("R37: a recursive attachment seeded once from the parent keys", (it) => {
	it.effect(
		"reads rows proportional to the delivered parents' closures, in one Recursive Union for the page",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/recursion/graph/r37",
						draw: drawn(forestGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the page's closures counted on the host: states, rows read and delivered rows bounded by them"
						},
						coverage: required<ForestFeature>(
							["a page of one root", "a page of several roots", "a page of chains of two depths"],
							{ cases: 8, sense: notesOnly }
						),
						kept,
						runs: 6,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(f, k) =>
						Effect.gen(function* () {
							const s = yield* Substrate
							const schema = yield* s.schema({ create: false, label: "seededx" })
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
											const run = yield* runProgram(session, c, program, side)
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
									const probed = {
										seeded: yield* measure(optimized.value, "optimized"),
										pipelined: yield* measure(baseline.value, "conservative")
									}
									return { planned, probed }
								})
							)
							const { planned, probed } = measured
							/** The page's closures, every vertex below each of its roots, and the forest's, every root's. */
							const closures = Arr.reduce(f.page, 0, (a, b) => a + b)
							const edges = edgesOf(f).length
							const detail = Formatter.format(measured)
							assert.equal(planned.seeded.delivered, closures)
							assert.equal(planned.pipelined.delivered, closures)
							assert.deepEqual(planned.seeded.unionLoops, [1], detail)
							assert.deepEqual(planned.seeded.states, [closures], detail)
							assert.ok(planned.seeded.feedback <= closures, detail)
							assert.ok((planned.pipelined.states[0] ?? 0) >= edges, detail)
							assert.deepEqual(probed.seeded.states, [closures], detail)
							assert.ok(probed.seeded.read <= 2 * (closures + f.page.length), detail)
							assert.ok(probed.pipelined.read >= edges, detail)
							k.note(f.page.length === 1 ? "a page of one root" : "a page of several roots")
							if (new Set(f.page).size > 1) {
								k.note("a page of chains of two depths")
							}
						})
				)
			)
	)
})
