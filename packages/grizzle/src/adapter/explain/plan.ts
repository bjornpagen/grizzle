import { Array as Arr, Result } from "effect"
import type { Plan } from "#adapter/types/db.ts"
import { trustedJson } from "#compiler/core/trusted.ts"

/**
 * Reading PostgreSQL's EXPLAIN (FORMAT JSON) as the public Plan.
 *
 * `EXPLAIN (FORMAT JSON) <statement>` returns one row of one json column: an array holding one object whose "Plan" is
 * the root node. Each node has "Node Type", "Startup Cost", "Total Cost", "Plan Rows", "Plan Width" and, when it has
 * children, "Plans". The Plan keeps exactly those, recursively, and drops every other field PostgreSQL reports
 * ("Relation Name", "Index Cond", ...), so the typed plan is the same across server minor versions. No EXPLAIN here
 * is ever ANALYZE, so no node carries actual times or rows: the library never runs EXPLAIN ANALYZE. The EXPLAIN statement of
 * one emitted statement is the engine's (sql/emit.ts explainOf): estimate-only, never executing the statement.
 */

/** One plan node as PostgreSQL prints it, read for only the members the Plan keeps. A leaf prints no "Plans". */
interface PlanNode {
	readonly "Node Type": string
	readonly "Startup Cost": number
	readonly "Total Cost": number
	readonly "Plan Rows": number
	readonly "Plan Width": number
	readonly Plans?: ReadonlyArray<PlanNode>
}

/** EXPLAIN (FORMAT JSON)'s one value: one object holding the root node. */
type Explained = readonly [{ readonly Plan: PlanNode }]

const toPlan = (node: PlanNode): Plan =>
	Object.freeze({
		node: node["Node Type"],
		startupCost: node["Startup Cost"],
		totalCost: node["Total Cost"],
		rows: node["Plan Rows"],
		width: node["Plan Width"],
		children: Object.freeze(node.Plans === undefined ? [] : Arr.map(node.Plans, toPlan))
	})

/**
 * The Plan of one EXPLAIN (FORMAT JSON) answer's first cell, its json text, the only form the driver hands over (every
 * cell is raw text): PostgreSQL's answer to grizzle's own statement, parsed once and trusted. An answer with no row is
 * refused.
 */
export const decodePlan = (cell: string | undefined): Result.Result<Plan, string> =>
	cell === undefined
		? Result.fail("an EXPLAIN that answered no row")
		: Result.succeed(toPlan(trustedJson<Explained>(cell)[0].Plan))
