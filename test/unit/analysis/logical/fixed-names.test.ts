/**
 * The names of a node's fixed columns are worked out semi-naively (logical/props.ts FixedNames): each step that fixes a
 * column its closure of nothing reaches is worked out once, where it reads the value it fixes (stepSource), and makes
 * each name it offers once, however many rounds the names take to settle, where every round worked out every step
 * again and made every offer again: an equality offers its other column's names as they are given, so a chain of
 * equalities settles a round per link, and every round re-read the whole table.
 *
 * The box, exhausted: a rule over R whose columns a, b, c and d are chained by one to three equalities, the last of the
 * chain a constant and none, one or two of its columns, from the last back, also parameters of their own
 * (fixed-names.fixtures.ts), analyzed in a transaction with no containment, every node's names worked out again from
 * its properties.
 *
 * Property, per node: the offers made are the offers the steps offer when the names settle, each made once. Oracle:
 * specification. Kill: a step makes every offer again each round.
 *
 * Features: names settled in one round, names given in a later round.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { analyzeLogical } from "#compiler/logical/annotate.ts"
import { type FixedNames, fixedNamesOf } from "#compiler/logical/props.ts"
import { chainGen, chainQuery } from "#test/unit/analysis/logical/fixed-names.fixtures.ts"

type Feature = "names settled in one round" | "names given in a later round"

/** Each step that fixes a column makes each name it offers once, however many rounds the names take to settle. */
export const eachStepThatFixesAColumnMakesEachNameItOffersOnceHoweverManyRoundsTheNamesTakeToSettle =
	property.exhaust(finite(chainGen), {
		needs: {},
		situations: [
			"names settled in one round",
			"names given in a later round"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (chain) =>
			Effect.sync(() => {
				const analysis = analyzeLogical(chainQuery(chain).dag, {
					context: "transaction",
					containments: [],
					keyedViews: false
				})
				if (!analysis.ok) {
					throw new Error(`annotation refused: ${analysis.error.message}`)
				}
				for (const node of topoOrder(analysis.value.dag)) {
					const props = analysis.value.of(node).props
					const fixed: FixedNames = fixedNamesOf(props)
					assert.equal(fixed.made, fixed.offered, `${node.id}: each offer made once`)
					c.note(fixed.rounds > 2 ? "names given in a later round" : "names settled in one round")
				}
			}),
		oracle: { kind: "specification", name: "a step's offer made once adds nothing made again" },
		box: "one to three equalities chaining R's columns, the last a constant, none to two of them parameters too",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\tthis.#made = count\n",
				replacement: "\t\tthis.#made = made\n",
				why: "A step makes every offer again each round, as every round re-read every step: a node whose names take two rounds makes its offers twice."
			}
		]
	})
