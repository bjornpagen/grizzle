import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeProgram,
	flight
} from "#compiler/lower/conservative/types.ts"
import type { Term } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema as declareSchema } from "#compiler/public/schema.ts"
import {
	executedPlan,
	inInstalledCase,
	logicalOf,
	publicCase,
	tableRowsRead,
	statementParams
} from "#test/pg/recursion/graph/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import type { GenContainment } from "#test/support/oracle/gen/schema.ts"
import { indices } from "#test/support/oracle/pick.ts"
import { runProgram } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R37: a recursive attachment seeded once from the parent keys.
 *
 * A forest of 200 roots, each heading a chain of six edges, and a page of three roots (the first three by id) with
 * the vertices below each attached. The attached recursion's base reads the parent's id, which the checker carries in
 * the state as the origin (check/recursion/origin.ts), so its base is every edge and the pipelined statement computes
 * the closure of every root and keeps the delivered parents' (the conservative artifact). The optimized artifact
 * seeds one recursive statement from the delivered parents' key recordset: its rows read from the edge relation are
 * proportional to the three closures, not to the forest, and one Recursive Union runs once for the page.
 *
 * That the seeded statement delivers exactly the pipelined closures is the graph suite's (equivalence.test.ts, the
 * attachment population against the conservative lowering) and the recursion oracle's (consumer:attach against the
 * reference evaluator).
 *
 * Measured alone, its suites hold the event loop for up to 18 s at a time, which starves the driver timers of
 * other files in a shared job, so the file is a CPU-bound job of its own.
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

/** The forest: root r = 10i heads the chain r -> r+1 -> ... -> r+6. */
const roots = 200
const depth = 6
const int = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const rootIds = Arr.map(indices(roots), (i) => 10 * i)
const edges = Arr.flatMap(rootIds, (r) =>
	Arr.map(indices(depth), (k) => [r + k, r + k + 1] as const)
)

const facts = {
	V: Arr.flatMap(rootIds, (r) => Arr.map(indices(depth + 1), (k) => [int(r + k)])),
	E: Arr.map(edges, ([a, b]) => [int(a), int(b)]),
	Root: Arr.map(rootIds, (r) => [int(r)]),
	Pair: [
		[int(0), int(10)],
		[int(10), int(3)],
		[int(23), int(20)]
	]
}

const caseOf = (
	label: string,
	q: unknown,
	params: Readonly<Record<string, TypedLiteral>>
): QueryCase =>
	publicCase({
		schema: Net,
		name: "Net",
		relations: ["V", "E", "Root", "Pair"],
		containments,
		facts,
		label,
		query: q,
		params
	})

/** The transition arm the definition uses: a rule over Net, and the feedback of a state of one vertex. */
type NetRule = Rule<typeof Net>
type NodeSelf = SelfSource<{ readonly node: typeof pg.integer }>

const forward = (r: NetRule, self: NodeSelf) => {
	const { node } = v(self, "self")
	const { to } = v(E, "e")
	return r.match(self, { node }).match(E, { from: node, to }).find({ node: to })
}

/** The first three roots by id: the page the closures are attached to. */
const page = () =>
	query(Net)
		.rule((r) => {
			const { id } = v(Root, "root")
			return r.match(Root, { id }).find({ id })
		})
		.orderBy(["id", "asc"])
		.take(3)

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

const PageBelow = page().attach("below", (p) => below(p.id), "array")

layer(Substrate.layer)("R37: a recursive attachment seeded once from the parent keys", (it) => {
	it.effect(
		"reads rows proportional to the delivered parents' closures, in one Recursive Union for the page",
		() =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema({ create: false, label: "seededx" })
				const c = caseOf("PageBelow", PageBelow, {})
				/**
				 * With hash joins the planner reads the small edge table whole once per statement. Where it probes
				 * the edge relation's key index instead, the rows read are those of the traversal itself.
				 */
				const measured = yield* inInstalledCase(c, schema, (session, plan) =>
					Effect.gen(function* () {
						const names = plan.installation.names
						const optimized = lowerAligned(logicalOf(c), "query", {
							names,
							context: "snapshot",
							catalog: installedCatalog(plan.installation),
							meter: new BudgetMeter(compileBudgets)
						})
						const baseline = lowerConservative(conservativeInput(logicalOf(c)), {
							names,
							params: logicalOf(c).params,
							subject: { kind: "query" },
							meter: new BudgetMeter(compileBudgets)
						})
						if (!optimized.ok || !baseline.ok) {
							throw new Error("lowering failed")
						}
						const edgeTable = plan.tables["E"]?.name.name
						if (edgeTable === undefined) {
							throw new Error("no installed table for E")
						}
						const measure = (program: ConservativeProgram, side: string) =>
							Effect.gen(function* () {
								const run = yield* runProgram(session, c, program, side)
								const index = Option.getOrThrowWith(
									Arr.findFirstIndex(flight(program.roots), (st) => st.role.kind === "attachment"),
									() => new Error(`${side}: no attachment statement`)
								)
								const statement = flight(program.roots)[index]
								if (statement === undefined) {
									throw new Error(`${side}: no attachment statement`)
								}
								const root = yield* executedPlan(
									session,
									statement.sql.text,
									statementParams(c, statement)
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
										(n) => n.actualRows * n.actualLoops
									),
									unionLoops: Arr.map(
										Arr.filter(nodes, (n) => n.nodeType === "Recursive Union"),
										(n) => n.actualLoops
									),
									feedback: Arr.reduce(
										Arr.filter(nodes, (n) => n.nodeType === "WorkTable Scan"),
										0,
										(sum, n) => sum + n.actualRows * n.actualLoops
									),
									delivered: defined(run.statements[index], `${side}: the attachment run`).rows
										.length
								}
							})
						const planned = {
							seeded: yield* measure(optimized.value, "optimized"),
							pipelined: yield* measure(baseline.value, "conservative")
						}
						for (const setting of ["enable_seqscan", "enable_hashjoin", "enable_mergejoin"]) {
							yield* session.query(`SET LOCAL ${setting} = off`, []).pipe(Effect.orDie)
						}
						const probed = {
							seeded: yield* measure(optimized.value, "optimized"),
							pipelined: yield* measure(baseline.value, "conservative")
						}
						return { planned, probed }
					})
				)
				const { planned, probed } = measured
				const closures = 3 * depth
				const detail = Formatter.format(measured)
				assert.equal(planned.seeded.delivered, closures)
				assert.equal(planned.pipelined.delivered, closures)
				assert.deepEqual(planned.seeded.unionLoops, [1], detail)
				assert.deepEqual(planned.seeded.states, [closures], detail)
				assert.ok(planned.seeded.feedback <= closures, detail)
				assert.ok((planned.pipelined.states[0] ?? 0) >= roots * depth, detail)
				assert.deepEqual(probed.seeded.states, [closures], detail)
				assert.ok(probed.seeded.read <= 2 * (closures + 3), detail)
				assert.ok(probed.pipelined.read >= edges.length, detail)
			})
	)
})
