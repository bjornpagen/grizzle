/**
 * A compiled write binds by what its compile decided, never by the law model (runtime/write/binding.ts Binding). Over
 * drawn schemas of trees, ordered and counted families nested in each other, folds and copies (test/support/families/
 * fill.ts), and an instance of each inserted whole:
 *
 * - **Every judgment the binding holds is the law model's** (test/support/oracle/binding.ts): each member slot's
 *   proposal, each in-flight stratum's fresh owners, each written relation's stated and primary fields, row layout and
 *   owned counts and ends, and a fill that holds exactly the layouts its walks and fresh fills meet.
 * - **The slice binds as the whole does**: the write bound by its binding and bound by one whose fill is every layout
 *   of the schema's fill order and whose evaluator reads every closed relation send the same statements with the same
 *   placeholder texts, or refuse alike, so nothing the slice leaves out is one the write reads.
 * - **A served write binds without its front end as the planner binds it with it**: a write a served file holds
 *   (write/program/served.ts servedWrite), bound from its flight alone, sends what the read-flight planner over its
 *   compiled front end sends, or refuses alike (runtime/write/bind.ts RunnableWrite).
 *
 * Features: a nested write, a fresh owner's counts drawn, a write with no family.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property as propertyOf } from "@bjornpagen/testing/property"
import {
	type BindingSituation,
	caseGen,
	property,
	situations
} from "#test/unit/write/program/binding.fixtures.ts"

/**
 * A compiled write's binding holds the law model's judgments, and binds by its slice as by the whole.
 *
 * Budget: 60 runs and 120 steered cases, what its suite stated before it became a property
 * (test/unit/write/program/binding.test.ts:177 at 8cad5bce, its runs and its coverage's cases).
 */
export const aCompiledWritesBindingHoldsTheLawModelsJudgmentsAndBindsByItsSliceAsByTheWhole =
	propertyOf.explore(caseGen, {
		needs: {},
		budget: { runs: 60, steered: 120 },
		situations: situations satisfies ReadonlyArray<Reached<BindingSituation>>,
		check: (_, at: Case<BindingSituation>) => (c) => property(c, (s) => at.note(s)),
		oracle: {
			kind: "second-implementation",
			name: "the law model's own judgments of a binding (oracle/binding.ts) and the binding over the whole fill order"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/program/decide.ts",
				original:
					"\tconst fill = hostFillOf(frontend.laws.theory.fill, fillStarts(frontend, fresh))",
				replacement:
					"\tconst fill = hostFillOf(frontend.laws.theory.fill, fillStarts(frontend, []))",
				why: "A fill that misses the layouts a fresh owner's fill meets (write/program/decide.ts fillStarts given no fresh strata)."
			}
		]
	})
