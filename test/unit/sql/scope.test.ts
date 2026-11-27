/**
 * The printer's scope check is one walk of the printed statement (sql/scope.ts): each node visited once, each binding
 * made and undone once, and each reference one probe of the names bound at its place, whose window over its frame
 * decides at once whether the place reaches it. So along every dimension a statement grows in, the check's calls are
 * affine in the statement's size: n subqueries each correlated to the outermost query, n LATERAL FROM items each reading
 * the first, a join chain of n steps each reading its first source, n CTEs each reading the one before it. A resolution
 * that searched the scopes around each reference, or undid a frame by a search of every name bound, pays again at each
 * reference or frame for every name in reach, and its calls grow with the square of the statement.
 *
 * The count is work, never time: V8's precise coverage counts every function's calls in the check's module
 * (kernel/calls.ts everyCallCount). The box is exhausted: each dimension at 4s, 8s and 12s items, s at 1 and 2.
 *
 * Oracle: the growth law, affine (test/support/growth.ts), and the check finding each statement in scope.
 *
 * Features: each dimension, each step.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Record as Rec } from "effect"
import { affine } from "#test/support/growth.ts"
import { callsAt, type Dimension } from "#test/unit/sql/scope.fixtures.ts"

type ScopeCostFeature = `dimension ${Dimension}` | "step 1" | "step 2"

/** Every dimension a statement grows in, each measured at three sizes an equal step apart. */
const dimensions: { readonly [D in Dimension]: D } = {
	nesting: "nesting",
	width: "width",
	chain: "chain",
	ctes: "ctes"
}

/** The scope check's calls are affine in a statement's size along every dimension it grows in. */
export const theScopeCheckIsOneWalkOfTheStatementAffineInItsSizeAlongEveryDimension =
	property.exhaust(finite(int(1, 2)), {
		needs: {},
		situations: [
			"step 1",
			"step 2",
			"dimension nesting",
			"dimension width",
			"dimension chain",
			"dimension ctes"
		] satisfies ReadonlyArray<Reached<ScopeCostFeature>>,
		check: (_, c: Case<ScopeCostFeature>) => (step) =>
			Effect.gen(function* () {
				c.note(step === 1 ? "step 1" : "step 2")
				for (const dimension of Rec.values(dimensions)) {
					c.note(`dimension ${dimension}`)
					const counted = new Map<number, number>()
					for (const n of [4 * step, 8 * step, 12 * step]) {
						const calls = yield* callsAt(dimension, n)
						counted.set(n, calls)
					}
					affine(
						(n) => {
							const calls = counted.get(n)
							assert.ok(calls !== undefined, `the calls at ${n} items`)
							return calls
						},
						4 * step,
						`the scope check's calls along ${dimension}`
					)
				}
			}),
		oracle: {
			kind: "universal",
			name: "a size made of a fixed part and a part per item increments alike over two equal steps"
		},
		box: "each dimension at 4s, 8s and 12s items, s at 1 and 2",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/scope.ts",
				original: "\t\tconst stack = this.#relations.get(alias)\n",
				replacement:
					"\t\tconst stack = [...this.#relations.values()].flat().filter((binder) => binder.frame.names[binder.index] === alias)\n",
				why: "A reference resolved by a search of every binding in reach: each reference pays for every name bound around it, the check's calls grow with the square of the statement, and the property fails."
			},
			{
				file: "packages/engine/src/sql/scope.ts",
				original:
					"\t\tfor (const name of frame.names) {\n\t\t\tthis.#relations.get(name)?.pop()\n\t\t}\n",
				replacement:
					"\t\tthis.#relations.forEach((stack, name) => {\n\t\t\tif (frame.names.includes(name)) {\n\t\t\t\tstack.pop()\n\t\t\t}\n\t\t})\n",
				why: "A frame undone by a search of every name bound: each frame's close pays for every name in reach, the check's calls grow with the square of the statement, and the property fails."
			}
		]
	})
