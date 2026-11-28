/**
 * The reference evaluator's set algebra (test/support/oracle/evaluate/catalog.ts evaluate), each operation over two
 * sets of one roster's handles, against a naive model of sets of codes.
 *
 * - The oracle, a second implementation: a set is a Set<number> of its codes in a roster of five handles; union,
 *   intersection and difference are the Set operations, cardinality the count, subset and disjointness the membership
 *   tests, and a set with one more handle (set_bit, Bit.singleton's over the empty set) the set with its code
 *   added. It shares no code with the evaluator, which reads sets of handles.
 * - The box, exhausted: every pair of subsets of the five handles (1,024 cases), each with every handle added to the
 *   first and to the empty set.
 * - Features, required in the space: an empty set, a strict subset, disjoint sets, overlapping sets.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { agrees, pairs, type Situation } from "#test/unit/oracle/bits.fixtures.ts"

/** The reference evaluator's set algebra agrees with a model of sets of codes. */
export const theReferenceEvaluatorsSetAlgebraAgreesWithAModelOfSetsOfCodes = property.exhaust(
	finite(pairs),
	{
		needs: {},
		situations: [
			"an empty set",
			"a strict subset",
			"disjoint sets",
			"overlapping sets"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (value) => agrees(value, c),
		oracle: { kind: "second-implementation", name: "a Set<number> model of the codes" },
		box: "every pair of subsets of a roster of five handles",
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/ir.ts",
				original:
					'return listed(`{"kind":"seq","items":[`, node.items)\n\t\tcase "alt":\n\t\t\treturn listed(`{"kind":"alt","arms":[`, node.arms)',
				replacement:
					'return listed(`{"kind":"alt","arms":[`, node.arms)   case "alt":    return listed(`{"kind":"seq","items":[`, node.items)',
				why: 'Operator mutant dd852114e7 at packages/text/src/regex/ir.ts:344 in writtenPieces: `return listed(`{"kind":"seq","items":[`, node.items)   case "alt":    return listed(`{"kind":"alt","arms":[`, node.arms)` becomes `return listed(`{"kind":"alt","arms":[`, node.arms)   case "alt":    return listed(`{"kind":"seq","items":[`, node.items)`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	}
)
