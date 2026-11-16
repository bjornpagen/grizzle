/**
 * A node's scope (ir/dag.ts nodeScopes) over generated DAGs and planted references.
 *
 * - Scope: each node's outer references are the references below it that no node on the way binds, its region's
 *   source, an attachment and a semi-join among the binders, and its free variables, as a set, are the variables those
 *   references name.
 *
 * Oracle: a second implementation, the definition walked over the table node by node.
 *
 * Features: every way a reference is made, bound and carried the search names, a free variable, a reference to a node
 * that is no region, and a scope shared with an input.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { NodeId } from "#compiler/core/ids.ts"
import { nodeScopes } from "#compiler/ir/dag.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { liveOf } from "#test/support/oracle/dag-validate.ts"
import {
	type Feature,
	listed,
	namedVars,
	nodeInputs,
	population,
	reference
} from "#test/unit/ir/scope.fixtures.ts"

/** A node's scope is the definition's: the references below it no node on the way binds, and the variables they name. */
export const aNodesScopeIsTheDefinitionsTheReferencesBelowItNoNodeOnTheWayBindsAndTheVariablesTheyName =
	property.explore(population, {
		needs: {},
		situations: [
			"a free variable",
			"a reference to a node that is no region",
			"a reference inside an expression tree",
			"a reference its maker binds",
			"a reference bound at the node it names",
			"a reference bound at a region's source",
			"a reference bound on one path and carried on another",
			"a reference bound at an attachment",
			"a reference bound at an attachment below its parent",
			"a reference an attachment carries from its parent",
			"a reference bound at a semi-join",
			"a reference a semi-join carries from below its left",
			"a scope shared with an input"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (d) =>
			Effect.sync(() => {
				/** Every table node is a root of the live DAG, so a region a reference names is one of its labels. */
				const live = liveOf(d)
				const scopes = nodeScopes({
					roots: Arr.map(Rec.keys(d.nodes), (id) => live.node(NodeId(id)))
				})
				const expected = reference(d, c.note)
				for (const n of Rec.values(d.nodes)) {
					const scope = scopes.of(live.node(n.id))
					const refs = expected.get(n.id)
					assert.ok(refs !== undefined, `${n.id} has a scope`)
					assert.deepEqual(listed(scope.outer), listed(refs), `the outer references of ${n.id}`)
					const vars = namedVars(d, refs)
					unorderedEqual(scope.freeVars, vars, `the free variables of ${n.id}`)
					const noted = [
						...(vars.length > 0 ? ["a free variable" as const] : []),
						...(Arr.some([...refs.keys()], (id) => d.nodes[id]?.kind !== "MatchRegion")
							? ["a reference to a node that is no region" as const]
							: []),
						...(refs.size > 0 &&
						Arr.some(nodeInputs(n), (input) => scopes.of(live.node(input)) === scope)
							? ["a scope shared with an input" as const]
							: [])
					]
					for (const f of noted) {
						c.note(f)
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the definition: the references below a node that no node on the way binds, and the variables they name"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\tadd(own, noNodes)\n",
				replacement: "",
				why: "A node that carries an input's references leaves its own scope expressions' references out of its scope; the scope property fails."
			}
		]
	})
