/**
 * The site-free typing of a scalar description (scalar/compute/typing.ts typeOf) against the lowering's emission of it
 * (scalar/compute/lower.ts), over generated descriptions of the whole scalar catalogue over a heading of every carrier
 * it reads, guarded by every guard a Logic.when holds.
 *
 * - Scope key: two recorded nodes compute one value one way (sameNode), the key a guarded node finds its Logic.when
 *   by and a byte guard its text's occurrences, exactly where their emissions state one computation: one kind, one
 *   source, one overload, one literal and the same arguments.
 *
 * Oracle: a second implementation, each emitted expression's computation written out as a key.
 *
 * Features: a computation recorded twice, and two computations of one kind over one argument list.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { sameNode } from "#compiler/scalar/compute/typing.ts"
import { baseParams, lowerWith, typeWith } from "#test/support/unit/compute/support.ts"
import {
	computationKey,
	descriptions,
	type Feature,
	recorded,
	vars
} from "#test/unit/compute/typing.fixtures.ts"

/**
 * Two recorded nodes compute one value one way exactly where their emissions state one computation: one kind, one
 * source, one overload, one literal and the same arguments.
 *
 * Budget: 600 runs and 1000 steered cases, at well under a millisecond each.
 */
export const twoRecordedNodesComputeOneValueOneWayExactlyWhereTheirEmissionsStateOneComputation =
	property.explore(descriptions, {
		needs: {},
		budget: { runs: 600, steered: 1000 },
		situations: [
			"a computation recorded twice",
			"two computations of one kind over one argument list"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (desc) =>
			Effect.sync(() => {
				const lowered = lowerWith("query", desc, vars, false, baseParams)
				const typed = typeWith(desc, vars, false, baseParams)
				if (!lowered.ok || !typed.ok) {
					return
				}
				const nodes = recorded(typed.value)
				const emitted = lowered.value.emitted
				assert.equal(nodes.length, emitted.length, "a recorded node for every emitted expression")
				const keys = Arr.map(emitted, computationKey)
				Arr.forEach(nodes, (a, i) => {
					Arr.forEach(nodes, (b, j) => {
						const same = keys[i] === keys[j]
						if (i < j && same) {
							c.note("a computation recorded twice")
						}
						const x = emitted[i]
						const y = emitted[j]
						if (
							x !== undefined &&
							y !== undefined &&
							!same &&
							x.kind === y.kind &&
							x.args.length > 0 &&
							Arr.join(Arr.map(x.args, computationKey), ",") ===
								Arr.join(Arr.map(y.args, computationKey), ",")
						) {
							c.note("two computations of one kind over one argument list")
						}
						assert.equal(
							sameNode(a, b),
							same,
							`nodes ${i} and ${j} compute one value one way exactly where their emissions do`
						)
					})
				})
			}),
		oracle: {
			kind: "second-implementation",
			name: "each emitted expression's computation written out as a key: its kind, what names it, and its arguments' keys"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t\treturn y.kind === "op" && x.op === y.op',
				replacement: '\t\t\treturn y.kind === "op"',
				why: "Two operations over one argument list are one computation whatever their overloads; the scope key property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\t\t\treturn y.kind === "literal" && canonicalTextOf(x.value) === canonicalTextOf(y.value)',
				replacement: '\t\t\treturn y.kind === "literal"',
				why: "Two literals are one computation whatever their values; the scope key property fails."
			}
		]
	})
