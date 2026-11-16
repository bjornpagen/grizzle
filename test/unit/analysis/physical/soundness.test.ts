/**
 * Soundness of the physical analysis against the rows themselves.
 *
 * Over generated cases (the oracle generator, test/support/oracle/gen, and the mutant suite's rooted and hand-built
 * cases), every claim the analysis makes about a node is checked against what that node's plain SQL delivers, computed
 * by the fragment evaluator: each physical key, each maximum cardinality, every node it says owes no elimination, every
 * obligation it says is discharged. "Unknown evidence gets conservative duplicate elimination, never guessed
 * uniqueness": a single counterexample fails the suite. The same check runs with every node realized
 * `distinct`, the conservative lowering's shape, where every claim must still hold.
 *
 * Suites: plain and distinct realizations over generated cases, the mutant suite's population, its rooted cases, and
 * noninjective key expressions (k % 2, k % 3 and abs(k) over a key, test/support/oracle/mutants/cases.ts), each against
 * the fragment evaluator; and the order of a filter's conjuncts, which
 * neither analysis reads, a metamorphic relation.
 *
 * Features: each claim checked (a key, nothing owed, an obligation discharged, a bound), each node kind evaluated, a
 * correlated node evaluated per outer tuple, a node read by two consumers, a constant read laterally; a filter of two
 * conjuncts and a column fixed to two values for the conjunct order.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { boolean } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { type PhysicalEnv, unplaced } from "#compiler/analysis/physical/analyze.ts"
import { assert } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import {
	defaultGenConfig,
	queryCaseGen,
	soundnessGenConfig
} from "#test/support/oracle/gen/case.ts"
import { noninjectiveKeyCaseGen } from "#test/support/oracle/mutants/cases.ts"
import {
	claimsOf,
	fixedTwice,
	hasTwoConjuncts,
	reversedConjuncts,
	twiceFixed
} from "#test/unit/analysis/physical/order.ts"
import {
	check,
	claimFeatures,
	type CounterexampleRoot,
	counterexampleRoots,
	inputOf,
	type OrderFeature,
	rootedCases,
	type SoundnessFeature
} from "#test/unit/analysis/physical/soundness.fixtures.ts"

/**
 * Every physical claim holds on the delivered rows generated cases, plain realization.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/physical/soundness.test.ts:194 at 8cad5bce, its runs and its coverage's cases).
 */
export const everyPhysicalClaimHoldsOnTheDeliveredRowsGeneratedCasesPlainRealization =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: claimFeatures satisfies ReadonlyArray<Reached<SoundnessFeature>>,
		check: (_, c: Case<SoundnessFeature>) => (q) =>
			Effect.sync(() => {
				check(q.query.dag, inputOf(q), undefined, c)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the fragment evaluator: what each node's plain SQL delivers"
		},
		kept: [],
		kills: []
	})

/**
 * Every physical claim holds on the delivered rows generated cases, every node deduplicated.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/physical/soundness.test.ts:221 at 8cad5bce, its runs and its coverage's cases).
 */
export const everyPhysicalClaimHoldsOnTheDeliveredRowsGeneratedCasesEveryNodeDeduplicated =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: claimFeatures satisfies ReadonlyArray<Reached<SoundnessFeature>>,
		check: (_, c: Case<SoundnessFeature>) => (q) =>
			Effect.sync(() => {
				check(q.query.dag, inputOf(q), "distinct", c)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the fragment evaluator: what each node's plain SQL delivers"
		},
		kept: [],
		kills: []
	})

/**
 * Every physical claim holds on the delivered rows the soundness population, both realizations: lateral sources,
 * correlated variables and takes, shared nodes, windows and approximate searches.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/physical/soundness.test.ts:248 at 8cad5bce, its runs and its coverage's cases).
 */
export const everyPhysicalClaimHoldsOnTheDeliveredRowsTheSoundnessPopulationBothRealizationsLateralSourcesCorrelatedVariablesAndTakesSharedNodesWindowsAndApproximateSearches =
	property.explore(
		(source) => [source.draw(queryCaseGen(soundnessGenConfig)), source.draw(boolean)] as const,
		{
			needs: {},
			budget: { runs: 400, steered: 400 },
			situations: [
				...claimFeatures,
				"a constant read laterally",
				"a correlated MatchRegion evaluated per outer tuple",
				"a correlated Take evaluated per outer tuple",
				"a node read by two consumers",
				"evaluated Window",
				"evaluated ApproximateNearest"
			] satisfies ReadonlyArray<Reached<SoundnessFeature>>,
			check:
				(_, c: Case<SoundnessFeature>) =>
				([q, distinct]) =>
					Effect.sync(() => {
						check(q.query.dag, inputOf(q), distinct ? "distinct" : undefined, c)
					}),
			oracle: {
				kind: "second-implementation",
				name: "the fragment evaluator: what each node's plain SQL delivers"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/physical/rules.ts",
					original: "\t\tif (new Set(values).size === values.length && rows.length > 0) {",
					replacement:
						"\t\tif ((new Set(values).size === values.length || new Set(values).size === 1) && rows.length > 0) {",
					why: "A closed relation's column of one repeated value claimed a key (analysis/physical/rules.ts closedProps); the evaluator suites fail."
				}
			]
		}
	)

/**
 * Every physical claim holds on the delivered rows the counterexample roots: projections, joins, witnesses, groups,
 * unions, bounds under EXISTS.
 *
 * Budget: 80 runs and 80 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/physical/soundness.test.ts:291 at 8cad5bce, its runs and its coverage's cases).
 */
export const everyPhysicalClaimHoldsOnTheDeliveredRowsTheCounterexampleRootsProjectionsJoinsWitnessesGroupsUnionsBoundsUnderEXISTS =
	property.explore(rootedCases, {
		needs: {},
		budget: { runs: 80, steered: 80 },
		situations: Arr.map(
			counterexampleRoots,
			([root]): `root ${CounterexampleRoot}` => `root ${root}`
		) satisfies ReadonlyArray<Reached<SoundnessFeature | `root ${CounterexampleRoot}`>>,
		check:
			(_, c: Case<SoundnessFeature | `root ${CounterexampleRoot}`>) =>
			([root, q]) =>
				Effect.sync(() => {
					c.note(`root ${root}`)
					check(q.query.dag, inputOf(q), undefined, c)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the fragment evaluator: what each node's plain SQL delivers"
		},
		kept: [],
		kills: []
	})

/**
 * Every physical claim holds on the delivered rows noninjective key expressions.
 *
 * Budget: 100 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/physical/soundness.test.ts:327 at 8cad5bce, its runs and its coverage's cases).
 */
export const everyPhysicalClaimHoldsOnTheDeliveredRowsNoninjectiveKeyExpressions = property.explore(
	noninjectiveKeyCaseGen,
	{
		needs: {},
		budget: { runs: 100, steered: 0 },
		situations: [],
		check: (_, c: Case<string>) => (q) =>
			Effect.sync(() => {
				check(q.query.dag, inputOf(q), undefined, c)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the fragment evaluator: what each node's plain SQL delivers"
		},
		kept: [],
		kills: []
	}
)

/**
 * Neither analysis reads the order of a filter's conjuncts generated cases, every filter's conjuncts reversed.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/physical/soundness.test.ts:363 at 8cad5bce, its runs and its coverage's cases).
 */
export const neitherAnalysisReadsTheOrderOfAFiltersConjunctsGeneratedCasesEveryFiltersConjunctsReversed =
	property.explore(queryCaseGen(soundnessGenConfig), {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"a filter of two conjuncts",
			"a column fixed to two values"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check: (_, c: Case<OrderFeature>) => (q) =>
			Effect.sync(() => {
				const dag = twiceFixed(q.query.dag)
				const env: PhysicalEnv = {
					context: "snapshot",
					catalog: genCatalog(q.schema),
					realization: unplaced,
					roots: "result"
				}
				if (hasTwoConjuncts(dag)) {
					c.note("a filter of two conjuncts")
				}
				if (fixedTwice(dag, env)) {
					c.note("a column fixed to two values")
				}
				assert.deepEqual(claimsOf(reversedConjuncts(dag), env), claimsOf(dag, env))
			}),
		oracle: {
			kind: "universal",
			name: "metamorphic: both analyses claim the same of a DAG and of it with every filter's conjuncts reversed"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/rules.ts",
				original: "\tconst held = heldPoints(conjuncts(node.pred))",
				replacement: "\tconst held = heldPoints(conjuncts(node.pred).slice(0, 1))",
				why: "A filter's first conjunct alone fixes a column (analysis/physical/rules.ts filterProps); the conjunct order fails."
			}
		]
	})
