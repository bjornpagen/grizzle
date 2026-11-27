/**
 * Access indexes over one column list in several directions (physical/access): a B-tree serves its order forward and
 * its exact reverse backward, so an access index's identity is its columns and its direction vector's class under
 * reversal. Each drawn case is a workload of ordered programs over one relation's columns (a, b, id), every order
 * stated in full, each in a drawn direction vector, optionally behind an equality on g, whose direction within the seek
 * is free. The installation:
 *
 * - succeeds, so no two indexes share an identifier;
 * - creates one access index on the relation per class of the drawn vectors under reversal, its order keys a, b and
 *   id, after g where every program is prefixed, in a vector of that class, whichever of the two;
 * - names distinct classes distinctly;
 * - serves each program's ordered request from the index of its class, as its vector or its exact reverse.
 *
 * Oracle: the classes, computed from the drawn vectors by reversal alone.
 *
 * Features: an exact reverse pair, a mixed vector, an all-descending vector, two classes, and a prefix.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record } from "effect"
import { withWorkload } from "#compiler/physical/access/extension.ts"
import { keyTermText } from "#compiler/physical/indexes/engine.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import { owning } from "#test/support/policy.ts"
import {
	canonical,
	caseGen,
	type DirectionFeature,
	Dirs,
	program,
	reversed,
	text,
	vectorOf
} from "#test/unit/physical/index-directions.fixtures.ts"

/** Access indexes over one column list in several directions install one index per class under reversal, distinctly named, serving each order forward or backward. Its budget is its suite's before it was a property (test/unit/physical/index-directions.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const accessIndexesOverOneColumnListInSeveralDirectionsInstallOneIndexPerClassUnderReversalDistinctlyNamedServingEachOrderForwardOrBackward =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"an exact reverse pair",
			"a mixed vector",
			"an all-descending vector",
			"two classes",
			"a prefix"
		] satisfies ReadonlyArray<Reached<DirectionFeature>>,
		check:
			(_, c: Case<DirectionFeature>) =>
			({ vectors, prefixed }) =>
				Effect.sync(() => {
					const programs = Record.fromEntries(
						Arr.map(vectors, (vector, i) => [`p${i}`, program(vector, prefixed)])
					)
					const plan = succeeded(
						compileTestWorkload(
							[{ login: "server", workloads: [workload(Dirs, programs)] }],
							Dirs,
							testCompile
						)
					)
					const owned = owning(Dirs)
					const installed = compileInstallation(owned, withWorkload(installOptions(owned), plan))
					if (!installed.ok) {
						throw new Error(
							`${Arr.join(Arr.map(vectors, text), " | ")}: ${installed.error.message}`
						)
					}
					/** The indexes created for the ordered programs: those serving a seek. */
					const isSeek = (
						r: (typeof installed.value.indexes)[number]["requests"][number]
					): boolean => r.role === "access" && (r.use === "page seek" || r.use === "take seek")
					const created = Arr.filter(
						installed.value.indexes,
						(i) => i.index.kind === "created" && i.relation === "T" && Arr.some(i.requests, isSeek)
					)
					const classes = new Set(Arr.map(vectors, (vector) => text(canonical(vector))))
					/** The order columns, behind g when prefixed: g's direction is free, so it follows the first ascending key. */
					const orderKeys = (index: (typeof created)[number]) => index.keys.slice(prefixed ? 1 : 0)
					/** The class of an index's order keys under reversal. */
					const classOf = (index: (typeof created)[number]): string =>
						text(canonical(vectorOf(Arr.map(orderKeys(index), (k) => k.dir))))
					assert.deepEqual(
						new Set(Arr.map(created, classOf)),
						classes,
						"one index per class, its keys a vector of the class"
					)
					assert.equal(created.length, classes.size, "no class installs twice")
					assert.equal(
						new Set(Arr.map(created, (index) => index.index.name)).size,
						created.length,
						"distinct names"
					)
					for (const index of created) {
						assert.deepEqual(
							Arr.map(orderKeys(index), (k) => keyTermText(k.column)),
							["a", "b", "id"]
						)
					}
					for (const vector of vectors) {
						const served = Arr.filter(created, (index) =>
							Arr.some(
								index.requests,
								(r) =>
									isSeek(r) &&
									r.role === "access" &&
									[text(vector), text(reversed(vector))].includes(
										text(Arr.map(r.keys.slice(prefixed ? 1 : 0), (k) => k.dir))
									)
							)
						)
						assert.deepEqual(
							Arr.map(served, classOf),
							[text(canonical(vector))],
							`${text(vector)} is served by its class's index`
						)
					}
					if (
						Arr.some(vectors, (vector) =>
							Arr.some(vectors, (w) => text(w) === text(reversed(vector)))
						)
					) {
						c.note("an exact reverse pair")
					}
					if (Arr.some(vectors, (vector) => new Set(vector).size > 1)) {
						c.note("a mixed vector")
					}
					if (Arr.some(vectors, (vector) => Arr.every(vector, (d) => d === "desc"))) {
						c.note("an all-descending vector")
					}
					if (classes.size > 1) {
						c.note("two classes")
					}
					if (prefixed) {
						c.note("a prefix")
					}
				}),
		oracle: {
			kind: "specification",
			name: "the drawn vectors' classes under reversal"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/chains.ts",
				original: "\treturn along.every((same) => same) || along.every((same) => !same)",
				replacement: "\treturn along.every((same) => same)",
				why: "An index serves its order forward alone, so a vector and its exact reverse install two indexes."
			}
		]
	})
