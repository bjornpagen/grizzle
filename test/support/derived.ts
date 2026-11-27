/** Every derived relation of a checked schema analyzed, for a property of the analysis itself. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { Array as Arr, Order, Record as Rec } from "effect"
import {
	analyzeDerivedRelation,
	type DerivedRelationAnalysis
} from "#compiler/analysis/derived/analyze.ts"
import type { CheckedSchema, DerivedAnalysis } from "#compiler/analysis/schema.ts"
import type { CompileError } from "#compiler/core/errors.ts"

/**
 * Every derived relation of `checked` analyzed (analysis/derived/analyze.ts), in level order and by name: a stored one's
 * analysis as its checked schema made it, and a live one's made over the same schema as it would be were it stored, so
 * a property of the analysis reads every relation the box draws, whatever the installation infers of its storage, and
 * meets the first refusal the analysis makes of one. Each is found under its own name, which a reader of it names: two
 * relations of one definition share one canonical relation (analysis/derived/canonical.ts, 8a2fe37d5a), whose analysis
 * is named by the first of them.
 */
export const analysesOf = (
	checked: CheckedSchema
): Result.Result<DerivedAnalysis, CompileError> => {
	const order: Array<DerivedRelationAnalysis> = []
	const named: Array<readonly [string, DerivedRelationAnalysis]> = []
	const derived = Arr.flatMap(Rec.values(checked.owned.relations), (r) =>
		r.kind === "derived" && checked.holdings.has(r.name) ? [r] : []
	)
	for (const r of Arr.sort(
		derived,
		Order.combine(
			Order.mapInput(Order.Number, (d: (typeof derived)[number]) => d.desc.level),
			Order.mapInput(Order.String, (d: (typeof derived)[number]) => d.name)
		)
	)) {
		const holding = checked.holdings.get(r.name)
		const canonical = checked.canonicalOf(r.name)
		const analyzed =
			holding?.kind === "stored"
				? Result.ok(holding.analysis)
				: analyzeDerivedRelation(checked, canonical.subject, canonical.definition)
		if (!analyzed.ok) {
			return analyzed
		}
		order.push(analyzed.value)
		named.push([r.name, analyzed.value])
	}
	return Result.ok({ schema: checked, relations: Rec.fromEntries(named), order })
}
