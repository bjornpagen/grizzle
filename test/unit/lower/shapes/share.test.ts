/**
 * R25 sharing (shapes/share/index.ts): the share key is the sub-query's semantic digest. A sub-query's key is equal
 * for two copies built at any allocation exactly when they read the same parameter, over a planted pair of twin
 * projections whose parameters and the ids burned between them are exhausted.
 *
 * Oracle: the digest's statement (a specification): equal exactly for the same reads, whatever the labels.
 * Features: shared and apart.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { Q, Task } from "#test/support/unit/lower/conservative/fixtures.ts"
import { params, tasksOf } from "#test/unit/lower/shapes/share.fixtures.ts"

/** The share key is equal for two copies at any allocation exactly when they read the same parameter. */
export const theShareKeyIsEqualForTwoCopiesAtAnyAllocationExactlyWhenTheyReadTheSameParameter =
	property.exhaust(
		finite((source) => [source.draw(params), source.draw(params), source.draw(int(0, 3))] as const),
		{
			needs: {},
			situations: ["shared", "apart"] satisfies ReadonlyArray<Reached<"shared" | "apart">>,
			check:
				(_, c: Case<"shared" | "apart">) =>
				([first, second, burned]) =>
					Effect.sync(() => {
						const q = new Q()
						const a = tasksOf(q, first)
						for (let i = 0; i < burned; i++) {
							q.base(Task, conservativeMeta)
						}
						const b = tasksOf(q, second)
						const built = q.build(q.union([a, b], []))
						const same =
							succeeded(shareKey(built.dag, a, new DagTemplates("derivation"))) ===
							succeeded(shareKey(built.dag, b, new DagTemplates("derivation")))
						assert.equal(same, first === second)
						c.note(same ? "shared" : "apart")
					}),
			oracle: {
				kind: "specification",
				name: "the semantic digest: equal exactly when the two copies read the same parameter"
			},
			box: "two twin projections over the same or another parameter, zero to three ids burned between them",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/share/index.ts",
					original: '\t\t[node],\n\t\t"share",\n',
					replacement: `\t\t[node],\n\t\t\`share \${node.id}\`,\n`,
					why: "The share key reads the node's label, so two copies read apart whenever their allocations differ; the search fails."
				}
			]
		}
	)
