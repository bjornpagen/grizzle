/**
 * An installed routine is one advice scope (CARRY THE PLAN Law 3, design point 4): every statement of its body is
 * bound under the one scope the installation gives it (sql/bind.ts bindRoutine), so no two FROM items of the routine
 * declare one alias, and each item of the advice its SET clause carries names one relation of one statement. A judge,
 * an upkeep or a guard of several statements whose statements each minted their own aliases would hold `r1` twice, an
 * item for it meeting two relations, matched in one and failed or misapplied in the other.
 *
 * Each case: one of the scaling dimensions' schemas at a size of one to three (test/unit/laws/scaling.fixtures.ts),
 * installed as generate installs it (installationOf), and every routine of its manifest, bound and advised.
 *
 * Oracle: the specification, every alias of a routine declared once across its statements.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { installationOf, scaled } from "#test/unit/laws/scaling.fixtures.ts"
import {
	readingStatements,
	repeatedAliases,
	routinesOf,
	scopeCases
} from "#test/unit/physical/routine-scope.fixtures.ts"

/** No two FROM items of one installed routine declare one alias, however many statements it runs. */
export const everyRoutineIsOneAdviceScope = property.exhaust(finite(scopeCases), {
	box: "every scaling dimension's schema at sizes one to three, installed, and every routine of it",
	needs: {},
	situations: ["a routine of two statements or more that read a relation"],
	check: (_, c) => (x) =>
		Effect.map(installationOf(scaled(x.dimension, x.n)), (installation) => {
			const routines = routinesOf(installation)
			if (Arr.some(routines, (fn) => readingStatements(fn) > 1)) {
				c.note("a routine of two statements or more that read a relation")
			}
			assert.deepEqual(Arr.flatMap(routines, repeatedAliases), [])
		}),
	oracle: {
		kind: "specification",
		name: "every alias a routine's statements declare, declared once across all of them"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/bind.ts",
			original: "\t\treturn { ...b, body: [this.pl(first), ...rest.map((s) => this.pl(s))] }\n",
			replacement:
				"\t\treturn { ...b, body: [this.pl(first), ...rest.map((s) => new Binder(new this.#scope.constructor(), this.#catalog).pl(s))] }\n",
			why: "A routine binds each statement after its first under a scope of its own, so its statements declare `r1` again and the advice of its SET clause names two relations by one alias; the property fails at a routine of two reading statements."
		}
	]
})
