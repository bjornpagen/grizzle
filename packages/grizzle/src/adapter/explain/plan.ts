import { Array as Arr, Effect, Result, Schema } from "effect"
import type { Plan } from "#adapter/types/db.ts"

/**
 * Decoding PostgreSQL's EXPLAIN (FORMAT JSON) into the public Plan.
 *
 * `EXPLAIN (FORMAT JSON) <statement>` returns one row of one json column: an array holding one object whose "Plan" is
 * the root node. Each node has "Node Type", "Startup Cost", "Total Cost", "Plan Rows", "Plan Width" and, when it has
 * children, "Plans". The Plan keeps exactly those, recursively, and drops every other field PostgreSQL reports
 * ("Relation Name", "Index Cond", ...), so the typed plan is the same across server minor versions. No EXPLAIN here
 * is ever ANALYZE, so no node carries actual times or rows: the library never runs EXPLAIN ANALYZE. The EXPLAIN statement of
 * one emitted statement is the engine's (sql/emit.ts explainOf): estimate-only, never executing the statement.
 */

/**
 * One plan node as PostgreSQL prints it, admitted with only the members the Plan keeps. A leaf prints no "Plans", which
 * the decoder reads as no children.
 */
interface PlanNode {
	readonly "Node Type": string
	readonly "Startup Cost": number
	readonly "Total Cost": number
	readonly "Plan Rows": number
	readonly "Plan Width": number
	readonly Plans: ReadonlyArray<PlanNode>
}

const PlanNodeSchema: Schema.Decoder<PlanNode> = Schema.Struct({
	"Node Type": Schema.String,
	"Startup Cost": Schema.Finite,
	"Total Cost": Schema.Finite,
	"Plan Rows": Schema.Finite,
	"Plan Width": Schema.Finite,
	Plans: Schema.Array(Schema.suspend((): Schema.Decoder<PlanNode> => PlanNodeSchema)).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([]))
	)
})

/**
 * EXPLAIN (FORMAT JSON)'s one value, read from its json text, the only form the driver hands over (every cell is raw
 * text). The server is trusted: the reading only gives the text its type, and checks nothing PostgreSQL guarantees.
 */
const decodeExplain = Schema.decodeUnknownResult(
	Schema.fromJsonString(Schema.Tuple([Schema.Struct({ Plan: PlanNodeSchema })]))
)

const toPlan = (node: PlanNode): Plan =>
	Object.freeze({
		node: node["Node Type"],
		startupCost: node["Startup Cost"],
		totalCost: node["Total Cost"],
		rows: node["Plan Rows"],
		width: node["Plan Width"],
		children: Object.freeze(Arr.map(node.Plans, toPlan))
	})

/** The Plan of one EXPLAIN (FORMAT JSON) result cell, its json text. */
export const decodePlan = (cell: unknown): Result.Result<Plan, string> => {
	const decoded = decodeExplain(cell)
	if (Result.isFailure(decoded)) {
		return Result.fail(`an EXPLAIN result that is not one plan: ${decoded.failure.message}`)
	}
	return Result.succeed(toPlan(decoded.success[0].Plan))
}
