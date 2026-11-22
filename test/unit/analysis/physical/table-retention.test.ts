/**
 * A dependency table keeps what it says alone, its columns, dependencies and stages: a question of it (closure, proof,
 * identification, keyAmong) builds the index its closures read the table through, each stage's start counts and the
 * deriving implications for itself and drops them as it returns (analysis/physical/fds.ts Questioning), where each
 * table kept its index and counts as long as it lived, as every node's properties do; and every dependency's empty
 * list, a dependency with no start, no span read at a point or no region join, is one frozen list (`nothing`), where
 * each held an empty list of its own. On qti's write compile at hub a8dbf06b8 (edullm qti-database, GENMEM's snapshot
 * entering certification) the kept indexes and counts were 309 MB of its two placement analyses' 1,064 MB of tables,
 * and the empty lists about 91 MB.
 *
 * Oracle: a bound, read off the heap: the Int32Arrays left alive (node:v8 queryObjects, after a full collection) once
 * every table of a batch kept alive has been asked its keys are no more than before it was asked, whatever the batch's
 * size; and identity: every empty list of every table's dependencies is the one frozen list.
 *
 * Features: a table whose dependencies hold an empty list; a batch of tables each asked a key.
 */

import { queryObjects } from "node:v8"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { specGen, tableOf } from "#test/unit/analysis/physical/dependencies.fixtures.ts"

type Situation =
	| "a table whose dependencies hold an empty list"
	| "a batch of tables each asked a key"

/** How many copies of a drawn table the batch holds. */
const batch = 64

/** The Int32Arrays alive after a full collection. */
const liveCounts = (): number => queryObjects(Int32Array, { format: "count" })

/** A table keeps no question's closure state once asked, and every empty list of its dependencies is the one frozen list. */
export const aDependencyTableKeepsNoQuestionsClosureStateAndItsEmptyListsAreOne = property.explore(
	specGen,
	{
		needs: {},
		budget: { runs: 20, steered: 20 },
		situations: [
			"a table whose dependencies hold an empty list",
			"a batch of tables each asked a key"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (s) =>
			Effect.sync(() => {
				const tables = Array.from({ length: batch }, () => tableOf(s))
				const empties = Arr.flatMap(tables, (t) =>
					Arr.flatMap(t.implications, (i) =>
						Arr.filter([i.from, i.at, i.join], (list) => list.length === 0)
					)
				)
				assert.ok(
					new Set(empties).size <= 1 && Arr.every(empties, (list) => Object.isFrozen(list)),
					`the ${empties.length} empty lists of the tables' dependencies are one frozen list`
				)
				if (empties.length > 0) {
					c.note("a table whose dependencies hold an empty list")
				}
				const before = liveCounts()
				for (const t of tables) {
					t.keyAmong(t.columns)
				}
				const after = liveCounts()
				assert.ok(
					after - before < tables.length,
					`asking ${tables.length} tables kept alive their keys leaves ${after - before} more Int32Arrays alive, fewer than one a table`
				)
				c.note("a batch of tables each asked a key")
			}),
		oracle: {
			kind: "universal",
			name: "a bound and identity: no Int32Array a question built outlives it on the tables it asked, and the tables' empty lists are one frozen list"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/fds.ts",
				original:
					"\t\tconst asking = new Questioning(this)\n\t\tconst candidate = inHeadingOrder(this.columns, columns)\n",
				replacement:
					"\t\tconst asking = (this.kept ??= new Questioning(this))\n\t\tconst candidate = inHeadingOrder(this.columns, columns)\n",
				why: "A table keeps its question's index and start counts as long as it lives, as each table kept its own at d23efe98a: every table asked a key holds its counts alive, and the property fails."
			},
			{
				file: "packages/engine/src/analysis/physical/fds.ts",
				original:
					"const shared = <A>(xs: ReadonlyArray<A>): ReadonlyArray<A> => (xs.length === 0 ? nothing : xs)\n",
				replacement: "const shared = <A>(xs: ReadonlyArray<A>): ReadonlyArray<A> => xs\n",
				why: "Each dependency holds an empty list of its own, as at d23efe98a: the tables' empty lists are many, and the property fails."
			}
		]
	}
)
