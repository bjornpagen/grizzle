import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { type PhysicalEnv, unplaced } from "#compiler/analysis/physical/analyze.ts"
import { isUnique, type Realization } from "#compiler/analysis/physical/props.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { inputsOf, type RelDag, type RelKind, type RelNode } from "#compiler/ir/rel.ts"
import { assert } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import {
	defaultGenConfig,
	type QueryCase,
	queryCaseGen,
	soundnessGenConfig
} from "#test/support/oracle/gen/case.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	existsOverTakeRoot,
	fanoutJoinRoot,
	groupRoot,
	keyedJoinRoot,
	noninjectiveKeyCaseGen,
	projectGroupRoot,
	projectRoot,
	rootedCaseGen,
	taggedUnionRoot,
	untaggedUnionRoot,
	witnessRoot
} from "#test/support/oracle/mutants/cases.ts"
import { type ReferenceInput, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import {
	claimsOf,
	fixedTwice,
	hasTwoConjuncts,
	reversedConjuncts,
	twiceFixed
} from "#test/unit/analysis/physical/order.ts"
import {
	BagReference,
	owedOf,
	physical,
	propsOf,
	soundness
} from "#test/unit/analysis/physical/support.ts"

/**
 * Soundness of the physical analysis against the rows themselves.
 *
 * Over generated cases (the oracle generator, test/support/oracle/gen, and the mutant suite's rooted and hand-built
 * cases), every claim the analysis makes about a node is checked against what that node's plain SQL delivers, computed
 * by the bag evaluator: each physical key, each maximum cardinality, every node it says owes no elimination, every
 * obligation it says is discharged. "Unknown evidence gets conservative duplicate elimination, never guessed
 * uniqueness": a single counterexample fails the suite. The same check runs with every node realized
 * `distinct`, the conservative lowering's shape, where every claim must still hold.
 */

/** What a case's analysis claimed and its evaluation reached. */
const claimFeatures = [
	"a key claimed",
	"nothing owed",
	"an obligation discharged",
	"a bound claimed"
] as const

type SoundnessFeature =
	| (typeof claimFeatures)[number]
	| `evaluated ${RelKind}`
	| `a correlated ${RelKind} evaluated per outer tuple`
	| "a node read by two consumers"
	| "a constant read laterally"

/**
 * Every claim the analysis makes holds on every relation the bag evaluator computes. A case the reference cannot
 * evaluate is a gap of the oracle, never a pass: it fails.
 */
const check = (
	dag: RelDag,
	input: ReferenceInput,
	all: Realization | undefined,
	c: Case<SoundnessFeature>
): void => {
	const analysis = physical(dag, {
		context: "snapshot",
		catalog: genCatalog(input.schema),
		realization: () => all,
		roots: "result"
	})
	const bag = BagReference.bag(dag, input, (node) => analysis.of(node).realization)
	const violations = soundness(analysis, bag)
	if (violations.length > 0) {
		throw new Error(`unsound claims: ${Formatter.format(violations)}`)
	}
	const readers = new Map<RelNode, number>()
	for (const node of topoOrder(dag)) {
		for (const read of inputsOf(node)) {
			readers.set(read, (readers.get(read) ?? 0) + 1)
		}
	}
	for (const node of analysis.order) {
		const p = propsOf(analysis, node)
		c.note(`evaluated ${node.kind}`)
		if (bag.evaluations.correlated(node)) {
			c.note(`a correlated ${node.kind} evaluated per outer tuple`)
		}
		if ((readers.get(node) ?? 0) > 1) {
			c.note("a node read by two consumers")
		}
		if (
			node.kind === "MatchRegion" &&
			Arr.some(node.occurrences, (o) => Arr.some(o.constants, (k) => k.expr.kind === "column"))
		) {
			c.note("a constant read laterally")
		}
		if (isUnique(p)) {
			c.note("a key claimed")
		}
		if (p.maxCard.kind === "atMost") {
			c.note("a bound claimed")
		}
		if (owedOf(analysis, node).kind === "none") {
			c.note("nothing owed")
		}
	}
	if (Arr.some(analysis.obligations, (o) => o.discharged)) {
		c.note("an obligation discharged")
	}
}

const inputOf = (c: {
	readonly schema: ReferenceInput["schema"]
	readonly facts: ReferenceInput["facts"]
	readonly query: { readonly params: ReferenceInput["params"] }
}): ReferenceInput => ({
	schema: c.schema,
	facts: c.facts,
	params: c.query.params,
	observer: unobserved
})

/** The counterexample roots of the mutant suite, by what each builds. */
type CounterexampleRoot =
	| "a projection"
	| "a keyed join"
	| "a fanout join"
	| "a witness"
	| "a group"
	| "a projected group"
	| "a tagged union"
	| "an untagged union"
	| "a bound under EXISTS"

const counterexampleRoots: Arr.NonEmptyReadonlyArray<
	readonly [CounterexampleRoot, Gen<QueryCase>]
> = [
	["a projection", rootedCaseGen(projectRoot, defaultGenConfig)],
	["a keyed join", rootedCaseGen(keyedJoinRoot, defaultGenConfig)],
	["a fanout join", rootedCaseGen(fanoutJoinRoot, defaultGenConfig)],
	["a witness", rootedCaseGen(witnessRoot, defaultGenConfig)],
	["a group", rootedCaseGen(groupRoot, defaultGenConfig)],
	["a projected group", rootedCaseGen(projectGroupRoot, defaultGenConfig)],
	["a tagged union", rootedCaseGen(taggedUnionRoot, defaultGenConfig)],
	["an untagged union", rootedCaseGen(untaggedUnionRoot, defaultGenConfig)],
	["a bound under EXISTS", rootedCaseGen(existsOverTakeRoot, defaultGenConfig)]
]

/** A case rooted at one of the counterexample roots, each equally often. */
const rootedCases: Gen<readonly [CounterexampleRoot, QueryCase]> = (source) => {
	const [root, cases] = source.draw(element(counterexampleRoots))
	return [root, source.draw(cases)] as const
}

describe("every physical claim holds on the delivered rows", () => {
	it.effect("generated cases, plain realization", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/analysis/physical/soundness-plain",
					draw: drawn(queryCaseGen(defaultGenConfig)),
					literal: Formatter.format,
					coverage: required<SoundnessFeature>(claimFeatures, { cases: 400, sense: notesOnly }),
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(q, c) =>
					Effect.sync(() => {
						check(q.query.dag, inputOf(q), undefined, c)
					})
			)
		)
	)

	it.effect("generated cases, every node deduplicated", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/analysis/physical/soundness-distinct",
					draw: drawn(queryCaseGen(defaultGenConfig)),
					literal: Formatter.format,
					coverage: required<SoundnessFeature>(claimFeatures, { cases: 200, sense: notesOnly }),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(q, c) =>
					Effect.sync(() => {
						check(q.query.dag, inputOf(q), "distinct", c)
					})
			)
		)
	)

	it.effect(
		"the soundness population, both realizations: lateral sources, correlated variables and takes, shared nodes, windows and approximate searches",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/physical/soundness-population",
						draw: drawn(
							(source) =>
								[source.draw(queryCaseGen(soundnessGenConfig)), source.draw(boolean)] as const
						),
						literal: Formatter.format,
						coverage: required<SoundnessFeature>(
							[
								...claimFeatures,
								"a constant read laterally",
								"a correlated MatchRegion evaluated per outer tuple",
								"a correlated Take evaluated per outer tuple",
								"a node read by two consumers",
								"evaluated Window",
								"evaluated ApproximateNearest"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([q, distinct], c) =>
						Effect.sync(() => {
							check(q.query.dag, inputOf(q), distinct ? "distinct" : undefined, c)
						})
				)
			)
	)

	it.effect(
		"the counterexample roots: projections, joins, witnesses, groups, unions, bounds under EXISTS",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/physical/soundness-roots",
						draw: drawn(rootedCases),
						literal: Formatter.format,
						coverage: required<SoundnessFeature | `root ${CounterexampleRoot}`>(
							Arr.map(
								counterexampleRoots,
								([root]): `root ${CounterexampleRoot}` => `root ${root}`
							),
							{ cases: 80 * counterexampleRoots.length, sense: notesOnly }
						),
						kept: [],
						runs: 80 * counterexampleRoots.length,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([root, q], c) =>
						Effect.sync(() => {
							c.note(`root ${root}`)
							check(q.query.dag, inputOf(q), undefined, c)
						})
				)
			)
	)

	it.effect("noninjective key expressions", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/analysis/physical/soundness-noninjective",
					draw: drawn(noninjectiveKeyCaseGen),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(q, c) =>
					Effect.sync(() => {
						check(q.query.dag, inputOf(q), undefined, c)
					})
			)
		)
	)
})

/**
 * What a case's filters reached: two conjuncts to reverse, and a column they fix to two values. Each generated case's
 * equalities of a column to a value fixed per evaluation are doubled by a twin over a parameter of their own
 * (twiceFixed), so the cases hold such columns wherever their filters fix one.
 */
type OrderFeature = "a filter of two conjuncts" | "a column fixed to two values"

describe("neither analysis reads the order of a filter's conjuncts", () => {
	it.effect("generated cases, every filter's conjuncts reversed", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/analysis/physical/conjunct-order",
					draw: drawn(queryCaseGen(soundnessGenConfig)),
					literal: Formatter.format,
					coverage: required<OrderFeature>(
						["a filter of two conjuncts", "a column fixed to two values"],
						{ cases: 400, sense: notesOnly }
					),
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(q, c) =>
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
					})
			)
		)
	)
})
