/**
 * The copy plan's work is linear in its statement (lower/shapes/share/copies.ts): over a check on a budget beside a
 * union nested `depth` unions deep, each read at the values of the arm that reads it, so each judge statement holds
 * `depth` sub-queries nested, each correlated to the region around it and no two of one shape, the calls the
 * installation's compile makes in the copy plan's module and in the forms' module (ir/dag-digest.ts) increment no more
 * from 4h to 6h deep than from 2h to 4h (test/support/growth.ts incrementsDoNotGrow, exact). A plan that wrote the
 * positional form of every candidate wrote each nested sub-query's whole reach again for each one enclosing it, the sum
 * of their reaches, which grows with the square of the depth; and a form that wrote the relations each node and its
 * inputs read (ir/dag-digest.ts ownMeta) named every relation below it at each node, the square again, once a
 * definition's every closed sub-expression is formed (analysis/derived/canonical.ts, 8a2fe37d5a).
 *
 * The count is work, never time: V8's precise coverage counts every function's calls in the two modules (kernel/calls.ts
 * everyCallCount). The box is exhausted: h at 1 and 2.
 *
 * Features: depths 2, 4 and 6; depths 4, 8 and 12.
 */

import { defined } from "@bjornpagen/testing/assert"
import type { Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import {
	callsAt,
	counted,
	halfGen,
	type Reached
} from "#test/unit/physical/copy-shapes.fixtures.ts"

/** The copy plan writes the form of no candidate whose shape no other holds, so its work is linear in its statement. */
export const theCopyPlansWorkIsLinearInItsStatementWritingNoFormOfACandidateWhoseShapeNoOtherHolds =
	property.exhaust(finite(halfGen), {
		needs: {},
		situations: ["depths 2, 4 and 6", "depths 4, 8 and 12"] satisfies ReadonlyArray<
			ReachedOf<Reached>
		>,
		check: (_, c: Case<Reached>) => (half) =>
			Effect.gen(function* () {
				c.note(half === 1 ? "depths 2, 4 and 6" : "depths 4, 8 and 12")
				const calls = new Map<number, number>()
				for (const depth of [2 * half, 4 * half, 6 * half]) {
					const made = yield* callsAt(depth)
					calls.set(depth, made)
				}
				incrementsDoNotGrow(
					(depth) => defined(calls.get(depth), `the calls at depth ${depth}`),
					half,
					`the calls in ${counted.copies} and ${counted.digests} of a judge over unions nested`
				)
			}),
		oracle: {
			kind: "universal",
			name: "a count that grows no faster than linearly increments no more over its second equal step than over its first"
		},
		box: "a check over a budget beside unions nested 2h, 4h and 6h deep, each correlated to the region that reads it, h at 1 and 2",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/copies.ts",
				original: "\t\tif (!shared.has(node) || heldOutside(node)) {\n",
				replacement: "\t\tif (heldOutside(node)) {\n",
				why: "Every candidate's positional form is written, each its whole reach: a nested sub-query's reach is written again for each one enclosing it, the digests' calls grow with the square of the depth, and the property fails."
			},
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original: "\tconst { paramDeps: _paramDeps, reads: _reads, ...own } = meta\n\treturn own\n",
				replacement: "\treturn meta\n",
				why: "Each node's form writes the stored relations it and its inputs read: a nested union's node names every relation below it, so the forms of a nest grow with the square of its depth, and the property fails."
			}
		]
	})
