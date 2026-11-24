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

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { type PhysicalEnv, unplaced } from "#compiler/analysis/physical/analyze.ts"
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
		kills: [
			{
				file: "packages/engine/src/analysis/physical/fds.ts",
				original: "\t\t\tif (narrower !== undefined) {",
				replacement: "\t\t\tif (narrower === undefined) {",
				why: "Operator mutant fa08c4e02c at packages/engine/src/analysis/physical/fds.ts:790 in #minimized: `!==` becomes `===`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
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
		kept: [
			{
				token: ReplayToken(
					"test/unit/analysis/physical/soundness.test.ts#everyPhysicalClaimHoldsOnTheDeliveredRowsGeneratedCasesEveryNodeDeduplicated:-:2.0.1.1.3.0.1.b.0.0.0.0.0.0.0.0.2.1.0.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.9.8.5.2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.2.1.3.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.b.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a relation parameter of a real column holding 0 and -0, realized distinct, was identified by its whole heading as a key, though its facts are a set by their identity, two facts PostgreSQL's equality holds equal",
				since: "2026-11-22"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/rules.ts",
				original: '\t\t\t\tdedup: { kind: "facts" },',
				replacement: "\t\t\t\tdedup: placed,",
				why: "A relation parameter realized distinct is identified by its whole heading under native equality (analysis/physical/rules.ts InputSet), as a placed DISTINCT would be, though its facts stay a set by their identity: the kept case fails."
			},
			{
				file: "packages/engine/src/core/ids.ts",
				original: "\t\tcounts[kind] += 1",
				replacement: "\t\tcounts[kind] += 0",
				why: "Operator mutant b0e061e231 at packages/engine/src/core/ids.ts:243 in next: `1` becomes `0`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
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
			kept: [
				{
					token: ReplayToken(
						"test/unit/analysis/physical/soundness.test.ts#everyPhysicalClaimHoldsOnTheDeliveredRowsTheSoundnessPopulationBothRealizationsLateralSourcesCorrelatedVariablesAndTakesSharedNodesWindowsAndApproximateSearches:-:1.b.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.8.6.4.1.2.1.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.b.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.1.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0"
					),
					reason:
						"a relation parameter of a real column holding 0 and -0, two facts natively equal, was identified by its whole heading as a key",
					since: "2026-11-22"
				},
				{
					token: ReplayToken(
						"test/unit/analysis/physical/soundness.test.ts#everyPhysicalClaimHoldsOnTheDeliveredRowsTheSoundnessPopulationBothRealizationsLateralSourcesCorrelatedVariablesAndTakesSharedNodesWindowsAndApproximateSearches:0:1.0.1.2.2.1.b.0.0.b.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.2.2.1.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.b.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
					),
					reason:
						"a closed payload of float4 holding Open 0 and Done -0, one value under PostgreSQL's equality, claimed a key",
					since: "2026-11-19"
				}
			],
			kills: [
				{
					file: "packages/engine/src/analysis/physical/rules.ts",
					original: "\t\t\tif (!apart && facts !== undefined) {",
					replacement: "\t\t\tif ((apart || !apart) && facts !== undefined) {",
					why: "A relation parameter of a float column is identified by its whole heading (analysis/physical/rules.ts InputSet), though two of its facts apart in a zero's sign alone are natively equal; the kept case fails."
				},
				{
					file: "packages/engine/src/ir/expr.ts",
					original:
						'\t\t\tliteral.kind === "floatSpecial" && literal.value === "-0" ? floatLiteral(0) : literal',
					replacement: "\t\t\tliteral",
					why: "A literal's equality key tells -0 from +0, so a closed payload of both zeros claims a key PostgreSQL's equality breaks (ir/expr.ts nativeEqualityKey); the kept case fails."
				},
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
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original:
					'{\n\t\t\tconst input: S["node"] = yield n.input\n\t\t\tconst out = n.out.map((o) => ({ name: o.name, expr: m.expr(o.expr) }))\n\t\t\treturn { ...n, input, out, meta: m.meta(n.meta) }\n\t\t}\n\t\tcase "SemiJoin": {\n\t\t\tconst left: S["node"] = yield n.left\n\t\t\tconst right: S["node"] = yield n.right\n\t\t\treturn { ...n, left, right: keptRight(right), meta: m.meta(n.meta) }\n\t\t}',
				replacement:
					'{    const left: S["node"] = yield n.left    const right: S["node"] = yield n.right    return { ...n, left, right: keptRight(right), meta: m.meta(n.meta) }   }   case "SemiJoin": {    const input: S["node"] = yield n.input    const out = n.out.map((o) => ({ name: o.name, expr: m.expr(o.expr) }))    return { ...n, input, out, meta: m.meta(n.meta) }   }',
				why: 'Operator mutant ce9b2811c1 at packages/engine/src/ir/rel.ts:1060 in mapNode: `{    const input: S["node"] = yield n.input    const out = n.out.map((o) => ({ name: o.name, expr: m.expr(o.expr) }))    return { ...n, input, out, meta: m.meta(n.meta) }   }   case "SemiJoin": {    const left: S["node"] = yield n.left    const right: S["node"] = yield n.right    return { ...n, left, right: keptRight(right), meta: m.meta(n.meta) }   }` becomes `{    const left: S["node"] = yield n.left    const right: S["node"] = yield n.right    return { ...n, left, right: keptRight(right), meta: m.meta(n.meta) }   }   case "SemiJoin": {    const input: S["node"] = yield n.input    const out = n.out.map((o) => ({ name: o.name, expr: m.expr(o.expr) }))    return { ...n, input, out, meta: m.meta(n.meta) }   }`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
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
		kills: [
			{
				file: "packages/text/src/regex/ir.ts",
				original: '\t\tif (max !== "unbounded" && max < min) {',
				replacement: '\t\tif (max !== "unbounded" && max >= min) {',
				why: "Operator mutant bb62591850 at packages/text/src/regex/ir.ts:596 in <module>: `<` becomes `>=`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
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
