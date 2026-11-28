/**
 * The names of a node's fixed columns are worked out semi-naively (logical/props.ts FixedNames): each step that fixes a
 * column its closure of nothing reaches is worked out once, where it reads the value it fixes (stepSource), and makes
 * each name it offers once, however many rounds the names take to settle, where every round worked out every step
 * again and made every offer again: an equality offers its other column's names as they are given, so a chain of
 * equalities settles a round per link, and every round re-read the whole table.
 *
 * The box, exhausted: R's region under a filter whose equalities chain its columns a, b, c and d, one to three of
 * them, the last of the chain a constant and none, one or two of its columns, from the last back, also parameters of
 * their own (fixed-names.fixtures.ts chainDag), analyzed in a transaction with no containment, every node's names
 * worked out again from its properties. The chain is a filter's equalities of columns, built as the DAG, as a rewrite
 * leaves them: a rule's equality of two of its variables is one class of its region (check/checker.ts RuleCheck
 * #equated), whose names settle in one round.
 *
 * Property, per node: the offers made are the offers the steps offer when the names settle, each made once. Oracle:
 * specification. Kill: a step makes every offer again each round.
 *
 * And a node's properties hold no step sources (logical/props.ts finish): the sources are worked out in finish and
 * read there, by its naming and its fixed names, and the properties are built from the node's steps and naming alone,
 * where built from the table they held every row's sources, each input source's closure with it, for as long as the
 * analysis lived. Per node of the same box: its properties hold no `sources`. Kill: the properties spread the table.
 *
 * And an offered name is found among those its column holds by its identity, in one lookup (logical/props.ts
 * HeldNames): over a relation of m columns under a filter of each equal to the next and each to a parameter of its own
 * (fixed-names.fixtures.ts namedChainDag), whose columns each
 * hold m names offered by every step that fixes them, the identities the analysis reads are one for each offer made and
 * one for each name held, every node's names worked out again from its properties to count them, where each offer was
 * compared with every name its column held. Box: m at 4, 8 and 12. Oracle: specification. Kill: an offer compared with
 * every name held.
 *
 * Features: names settled in one round, names given in a later round; a chain of 4, 8 and 12.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { analyzeLogical, everyNode } from "#compiler/logical/annotate.ts"
import { type FixedNames, fixedNamesOf } from "#compiler/logical/props.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import type { CountedFunction } from "#test/support/kernel/coverage.ts"
import {
	chainGen,
	chainDag,
	namedChainDag
} from "#test/unit/analysis/logical/fixed-names.fixtures.ts"

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
				const dag = chainDag(chain)
				const analysis = analyzeLogical(
					dag,
					{
						context: "transaction",
						containments: [],
						keyedViews: false
					},
					everyNode
				)
				if (!analysis.ok) {
					throw new Error(`annotation refused: ${analysis.error.message}`)
				}
				for (const node of topoOrder(dag)) {
					const props = defined(analysis.value.props.get(node), "the node's properties, kept")
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

/** A node's properties hold no step sources: they are worked out and read in finish alone. */
export const aNodesPropertiesHoldNoStepSourcesTheyAreWorkedOutAndReadInFinishAlone =
	property.exhaust(finite(chainGen), {
		needs: {},
		situations: [],
		check: () => (chain) =>
			Effect.sync(() => {
				const dag = chainDag(chain)
				const analysis = analyzeLogical(
					dag,
					{
						context: "transaction",
						containments: [],
						keyedViews: false
					},
					everyNode
				)
				if (!analysis.ok) {
					throw new Error(`annotation refused: ${analysis.error.message}`)
				}
				for (const node of topoOrder(dag)) {
					assert.ok(
						!("sources" in defined(analysis.value.props.get(node), "the node's properties, kept")),
						`${node.id}: its properties hold no step sources`
					)
				}
			}),
		oracle: { kind: "specification", name: "the properties hold what their readers read" },
		box: "one to three equalities chaining R's columns, the last a constant, none to two of them parameters too",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original:
					"\t\tcolumns,\n\t\tstated,\n\t\touter: subject.outer,\n\t\tnaming: table.naming,\n",
				replacement: "\t\t...table,\n",
				why: "The properties spread the table, so every node's properties hold its rows' step sources for as long as the analysis lives."
			}
		]
	})

/** Where a column's offered name is told apart from the names it holds (logical/props.ts Fixing fresh, HeldNames). */
const nameChecks = Object.freeze({
	fixedEqual: { file: "packages/engine/src/logical/props.ts", name: "fixedEqual" },
	fixedNameKey: { file: "packages/engine/src/logical/props.ts", name: "fixedNameKey" }
} satisfies Readonly<Record<string, CountedFunction>>)

type ChainPoint = "m = 4" | "m = 8" | "m = 12"

const chainEnv = { context: "transaction", containments: [], keyedViews: false } as const

/**
 * An offered name is found among the names its column holds in one lookup: over a relation of m columns, each equal to
 * the next and each a parameter of its own, the identities read as the analysis works out its names are one for each
 * offer its steps make and one for each name they give, where each offer was compared with every name its column held.
 */
export const anOfferedNameIsFoundAmongTheNamesItsColumnHoldsInOneLookup = property.exhaust(
	finite(int(1, 3)),
	{
		needs: {},
		situations: ["m = 4", "m = 8", "m = 12"] satisfies ReadonlyArray<Reached<ChainPoint>>,
		check: (_, c: Case<ChainPoint>) => (k) =>
			Effect.gen(function* () {
				const m = 4 * k
				c.note(k === 1 ? "m = 4" : k === 2 ? "m = 8" : "m = 12")
				const dag = namedChainDag(m)
				const [, counts] = yield* callCounts(
					Effect.sync(() => analyzeLogical(dag, chainEnv, everyNode)),
					nameChecks
				)
				const analysis = succeeded(analyzeLogical(dag, chainEnv, everyNode), "the chain analyzes")
				let offers = 0
				let names = 0
				for (const node of topoOrder(dag)) {
					const fixed = fixedNamesOf(
						defined(analysis.props.get(node), "the node's properties, kept")
					)
					offers += fixed.made
					names += Arr.reduce([...fixed.names.values()], 0, (n, held) => n + held.length)
				}
				assert.equal(
					counts.fixedEqual + counts.fixedNameKey,
					offers + names,
					`the identities read at m = ${m}: one an offer, one a name`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one identity read for each offer made and each name given"
		},
		box: "a chain of m columns, m = 4k, k at 1, 2 and 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\tif (this.held.has(name)) {",
				replacement: "\t\t\tif (this.held.list.some((h) => fixedEqual(h.name, name))) {",
				why: "Each offer is compared with every name its column holds (logical/props.ts Fixing fresh); the identities read outnumber the offers and names."
			}
		]
	}
)
