/**
 * The join of physical justifications (analysis/physical/fds.ts joinJustifications) over drawn lists of up to five,
 * each resting on something (what `justify` makes of drawn premises, contexts, reasons, operators, coercions and outer
 * columns, repeats and any order among them), on a context alone, or on nothing (`structural`, or `justify` of no
 * grounds).
 *
 * - The join is the union by its definition (referenceJoin, the join at 94aa830e1, which built every union whole):
 *   every premise by its text, the most demanding context, every reason once in first-given order, every operator,
 *   coercion and outer column once in order.
 * - A join that meets at most one justification resting on something builds nothing: it is that justification itself,
 *   which is normal (fds.ts Justification), or `structural` when it meets none. Every physical table embeds each
 *   input's implications through it (DependencyDraft embed, one justification and its representatives' structural
 *   ones), so it is most joins the analysis takes: 87% of pantry's 975,261 at 94aa830e1.
 *
 * Features: no member resting on anything, one, several; a member of no grounds but a demanding context.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { joinJustifications, structural } from "#compiler/analysis/physical/fds.ts"
import {
	contextAlone,
	groundsOf,
	joinedGen,
	referenceJoin,
	restsOnNothing
} from "#test/unit/analysis/physical/justification-join.fixtures.ts"

type Situation = "none held" | "one held" | "several held" | "a context alone"

/** The join is the union by its definition, and builds nothing where it meets at most one justification resting on something. */
export const theJoinIsTheUnionByItsDefinitionAndBuildsNothingWhereItMeetsAtMostOneJustificationRestingOnSomething =
	property.explore(joinedGen, {
		needs: {},
		situations: [
			"none held",
			"one held",
			"several held",
			"a context alone"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (justs) =>
			Effect.sync(() => {
				const joined = joinJustifications(justs)
				assert.deepEqual(
					groundsOf(joined),
					referenceJoin(justs),
					"the join is the union by its definition"
				)
				const held = Arr.filter(justs, (j) => !restsOnNothing(j))
				const [only] = held
				if (only === undefined) {
					assert.equal(
						joined,
						structural,
						"a join of none resting on anything is structural itself"
					)
					c.note("none held")
				} else if (held.length === 1) {
					assert.equal(
						joined,
						only,
						"a join of one resting on something is that justification itself"
					)
					c.note("one held")
				} else {
					c.note("several held")
				}
				if (Arr.some(justs, contextAlone)) {
					c.note("a context alone")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the union built whole from every member (referenceJoin, fds.ts at 94aa830e1)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/fds.ts",
				original: "\treturn held.length === 1 ? first : normalized(held)\n",
				replacement: "\treturn normalized(held)\n",
				why: "Every join of something builds its union whole, as the join at 94aa830e1 did: a join of one justification resting on something is a new justification equal to it, not it, and the search fails."
			},
			{
				file: "packages/engine/src/analysis/physical/fds.ts",
				original: '\tj.context === "queryLocal" &&\n\tj.premises.length === 0 &&',
				replacement: "\tj.premises.length === 0 &&",
				why: "A justification of no grounds in a demanding context is dropped as resting on nothing, so its context is lost from the join: the join's context is less demanding than the union's, and the search fails."
			}
		]
	})
