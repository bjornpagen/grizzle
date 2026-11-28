/**
 * Two variables of a rule's region a rule states equal are one class of the region, whether a variable binds a second
 * column of another refinement (check/checker.ts RuleCheck `#equated`, its hidden variable of that column's type) or its
 * where states it equal to another variable, a parent's column an attachment's child reads among them (`#variablePair`):
 * the checker states each pair among the region's equalities, which every analysis of the region's variables reads
 * (ir/rel.ts regionVarClasses), the key analysis's crossing and the restriction walk among them
 * (lower/shapes/share/keys.ts), so every read the region makes of a fold reaches it at that variable. metis, before: its
 * submit's call's `sittings` learner, of the text its guards delivered, was bound to the ledger's learner of LearnerId by
 * a filter's equality, which joined no class, so ItemDuration and the presentations' spans under it were keyed at each
 * item and stage alone, every learner's moments of the stage scanned once per item, 403k pages and 4.2 s a call at
 * 41,227 sittings; and its review read each question's latest attempt at the member's key and, by a filter, the
 * learner, every learner's latest attempt of the item.
 *
 * The box, exhausted: the learner typed as the ledger keys it or at another refinement, read by a read or by a write's
 * member binding the call's sittings to the ledger, or by an attachment's child stating the fold's learner and stage
 * equal to its head's (rebound-keys.fixtures.ts), metis's test-run-call `durations` and review over two folds.
 *
 * Oracle: specification, every read of the spans fold reads it at the learner and the stage, and a read or a write at the
 * item's too. Kept: metis's submit statement 12, the write at another refinement; its review's latest attempt, the
 * attachment at another refinement.
 *
 * Features: each heading, for each program.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	boxGen,
	type Feature,
	requiredOf,
	spanReadsOf
} from "#test/unit/lower/shapes/rebound-keys.fixtures.ts"

/** A fold a region reads at a variable it equates with another of another refinement is read at that variable. */
export const aFoldReadAtAVariableEquatedWithAnotherOfAnotherRefinementIsReadAtIt = property.exhaust(
	finite(boxGen),
	{
		needs: {},
		situations: [
			"the ledger's refinement, a read",
			"the ledger's refinement, a write",
			"the ledger's refinement, an attachment",
			"another refinement, a read",
			"another refinement, a write",
			"another refinement, an attachment"
		],
		check: (_, k: Case<Feature>) => (box) =>
			Effect.sync(() => {
				k.note(`${box.heading}, ${box.program}`)
				const reads = spanReadsOf(box)
				assert.ok(reads.length > 0, `${Formatter.format(box)}: the program reads the spans fold`)
				for (const columns of reads) {
					assert.ok(
						Arr.every(requiredOf(box), (c) => columns.includes(c)),
						`${Formatter.format(box)}: the spans fold is read at ${Arr.join(requiredOf(box), ", ")}; it is read at ${columns.length === 0 ? "every row" : Arr.join(columns, ", ")}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "every read of the spans fold reads it at the learner and the stage, and a read or a write at the item's too"
		},
		box: "the learner typed as the ledger keys it or at another refinement, read by a read, a write's member or an attachment's child, over metis's durations of its two folds",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/sites.ts",
				original:
					'\treturn last > 0 && steps.slice(0, last).every((step) => step.bound.rank === "key")\n',
				replacement: "\treturn last > 0\n",
				why: "A region evaluated once reads its row sites at its rows' values whatever comes before them, many rows among them: the read's spans fold, a site of its region's chain, is read at every row, where the key analysis read it at child, package, path and stage."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\tthis.#filters = [...this.#filters, ...owed]\n",
				replacement:
					"\t\tthis.#filters = [...this.#filters, ...joined, ...owed]\n\t\tthis.#equated.length = 0\n",
				why: "A variable's hidden twin, and two variables the where equates, are equated by the rule's filter, which joins no class of the region: the key analysis's crossing never reaches the ledger's learner from the call's sittings, nor the restriction walk from the attachment's head, and the spans fold is read at the item and the stage alone, every learner's moments read."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: '\t\tif (condition.kind !== "op" || nativeOp(condition.op)?.fn !== "eq") {\n',
				replacement: '\t\tif (condition.kind !== "op" || true) {\n',
				why: "An equality the where states of two variables stays a filter's: the attachment's child states the fold's learner equal to its head's of another refinement, which joins no class, and the head's learner restricts the fold at the stage alone."
			}
		]
	}
)
