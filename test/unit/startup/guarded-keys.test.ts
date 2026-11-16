/**
 * Startup and write compilation over k guarded keys, counted and never timed (test/support/kernel/calls.ts), so no
 * verdict depends on the machine.
 *
 * A relation T carrying k keys over selected sides, `key(on(select(T, kind = j), "a"))`, each a UNIQUE over law columns
 * guarded by its own predicate, beside a relation U with no law, and a login whose workload holds the ChangeSet that
 * inserts into both: `grizzle generate`, which compiles the ChangeSet into the login's served file, and DbLayer.make
 * over that file, which loads it and compiles nothing, no law model among it.
 *
 * - Each relation's unique objects beyond its primary key are decided once, as its law model is built (uniques.ts
 *   beyondPrimary, RelationLaws.beyond), and the law model specializes the schema once: no write compile, role probe or
 *   second specialization decides them again. The oracle is the specification's counts: one law model for generate,
 *   none for the layer, one specialization and one decision per ordinary relation per law model.
 * - A guard's predicate is encoded once, where its unique object is built, and compared by its label: the canonical
 *   encoder's calls grow at most linearly in k (test/support/growth.ts incrementsDoNotGrow, at 2h, 4h and 6h keys),
 *   where comparing every two guards by encoding both adds more at every step. No encoding changes shape above some
 *   number of keys: every key is the same selected side, its kind its own number.
 * - The installation's objects are ordered by a binary heap of the ready ones (obligations/graph.ts ReadyHeap), whose
 *   code bounds its comparisons (readyFirst): Kahn's order pushes each object once, when it becomes ready, and pops it
 *   once; a push sifts its object up one level a comparison, from a place at depth ⌊log2 h⌋ of a heap of h ≤ p objects,
 *   so at most ⌊log2 p⌋ comparisons; a pop sinks the last object from the root, comparing it with each of a node's two
 *   children (left, then right) at every level it descends, so at most 2·⌊log2 p⌋; p pushes and their p pops make at
 *   most (1 + 2)·p·⌊log2 p⌋, the 3 of the bound, where comparing every ready object at each step grows with their
 *   number squared. Over r relations with no law between them every table is ready at once.
 *
 * The boxes are exhausted: h of 1 and 2, so k of 2, 4, 6 and of 4, 8, 12; and r from 20 to 40 by tens.
 */

import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect } from "effect"
import { assert, defined } from "#test/support/assert.ts"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import {
	heapBound,
	keysGen,
	lawModels,
	orderedAt,
	ordinary,
	relationsGen,
	stepNames,
	type Steps,
	stepsAt
} from "#test/unit/startup/guarded-keys.fixtures.ts"

/** Guarded keys at startup decide each relation's objects beyond its primary key once, specialize once, and encode linearly in k. */
export const guardedKeysAtStartupDecideEachRelationsObjectsBeyondItsPrimaryKeyOnceSpecializeOnceAndEncodeLinearlyInK =
	property.exhaust(finite(keysGen), {
		needs: { dir: Scratch.dir },
		situations: [],
		check: (resources) => (half) =>
			Effect.gen(function* () {
				const dir = yield* resources.dir
				const sizes = [2 * half, 4 * half, 6 * half] as const
				const measured = yield* Effect.forEach(sizes, stepsAt(dir))
				const bySize = new Map(
					Arr.map(measured, (steps, i) => [2 * half * (i + 1), steps] as const)
				)
				const stepsOf = (k: number): Steps => defined(bySize.get(k), `the steps at ${k} keys`)
				const at = `k at ${Arr.join(Arr.map(sizes, String), ", ")}`
				for (const step of stepNames) {
					for (const steps of measured) {
						assert.equal(
							steps[step].compileLaws,
							lawModels[step],
							`${at}: ${step} compiles the law model ${lawModels[step]} times`
						)
						assert.equal(
							steps[step].specialize,
							steps[step].compileLaws,
							`${at}: ${step} specializes the schema once a law model`
						)
						assert.equal(
							steps[step].beyondPrimary,
							ordinary * steps[step].compileLaws,
							`${at}: ${step} decides each relation's objects beyond its primary key once`
						)
					}
					incrementsDoNotGrow((k) => stepsOf(k)[step].encode, half, `${step}'s encodings`)
				}
			}),
		oracle: {
			kind: "specification",
			name: "one law model, specialization and decision per relation; encodings whose second step adds no more than the first"
		},
		box: "2h, 4h and 6h guarded keys for h of 1 and 2",
		kept: [],
		kills: []
	})

/** The install order compares its objects within a binary heap's bound on its pushes. */
export const theInstallOrderComparesItsObjectsWithinABinaryHeapsBoundOnItsPushes = property.exhaust(
	finite(relationsGen),
	{
		needs: {},
		situations: [],
		check: () => (r) =>
			Effect.gen(function* () {
				const counts = yield* orderedAt(r)
				assert.ok(counts.push > 0, `r at ${r}: the order pushes its objects`)
				assert.ok(
					counts.readyFirst <= heapBound(counts.push),
					`r at ${r}: ${counts.readyFirst} comparisons over ${counts.push} pushes`
				)
			}),
		oracle: {
			kind: "specification",
			name: "ReadyHeap's own bound: ⌊log2 p⌋ comparisons a push's sift-up and 2·⌊log2 p⌋ a pop's sink, (1 + 2)·p·⌊log2 p⌋ over p pushes and their pops"
		},
		box: "r relations with no law between them, for r from 20 to 40 by tens",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/obligations/graph.ts",
				original:
					"\t\tconst top = this.#heap[0]\n\t\tif (top === undefined) {\n\t\t\treturn undefined\n\t\t}\n\t\tconst last = this.#at(this.#heap.length - 1)\n\t\tthis.#heap.pop()\n\t\tif (this.#heap.length > 0) {\n\t\t\tthis.#heap[0] = last\n\t\t\tthis.#sink(0)\n\t\t}\n\t\treturn top.node",
				replacement:
					"\t\tlet least = 0\n\t\tfor (let i = 1; i < this.#heap.length; i++) {\n\t\t\tif (readyFirst(this.#at(i), this.#at(least)) < 0) {\n\t\t\t\tleast = i\n\t\t\t}\n\t\t}\n\t\tconst [top] = this.#heap.splice(least, 1)\n\t\treturn top?.node",
				why: "Each pop compares every ready object, a scan in place of the heap's sink; the install order's bound fails."
			}
		]
	}
)
