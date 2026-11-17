import { Array as Arr } from "effect"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { builtinType, cast, types } from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import type { TypePlant } from "#test/pg/oracle/optimized/support.ts"
import { programJudged } from "#test/support/oracle/verify/types.ts"

/** What a case reaches: an attachment's part planted, or a program with no attachment's part to plant. */
export type PlantFeature = "a part planted" | "no attachment's part to plant"

/** The type the plant casts to: a pg_catalog type no delivered column is claimed as. */
const planted = builtinType("name")

/**
 * Each plant of a program: for each attachment's part of a statement of tagged parts whose query as lowered ends in a
 * core, which has a target, that query with its first output column cast through text to `planted`, beside every other
 * part as lowered.
 */
export const plantsOf = (program: OptimizedProgram): ReadonlyArray<TypePlant> => {
	const parts = program.parts
	if (parts.kind !== "tagged") {
		return []
	}
	const judged = programJudged(program, "optimized statement")
	const relations = flight(program.roots)
	return Arr.flatMap(parts.parts, (part, tag): ReadonlyArray<TypePlant> => {
		const body = part.delivered.body
		if (
			body.kind !== "core" ||
			!Arr.some(relations, (r) => r.answer === tag && r.role.kind === "attachment")
		) {
			return []
		}
		const [first, ...rest] = body.targets
		const text = printStatement({
			...part.delivered,
			body: {
				...body,
				targets: [{ ...first, expr: cast(cast(first.expr, types.text), planted) }, ...rest]
			}
		})
		const where = `optimized statement part ${tag}`
		return [
			{
				where,
				judged: Arr.map(judged, (j) =>
					j.where === where ? { ...j, statement: { ...j.statement, sql: { text } } } : j
				)
			}
		]
	})
}
