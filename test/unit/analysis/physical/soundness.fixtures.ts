/** What the properties of soundness.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Formatter } from "effect"
import type { Realization } from "#compiler/analysis/physical/props.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { inputsOf, type RelDag, type RelKind, type RelNode } from "#compiler/ir/rel.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { defaultGenConfig, type QueryCase } from "#test/support/oracle/gen/case.ts"
import {
	existsOverTakeRoot,
	fanoutJoinRoot,
	groupRoot,
	keyedJoinRoot,
	projectGroupRoot,
	projectRoot,
	rootedCaseGen,
	taggedUnionRoot,
	untaggedUnionRoot,
	witnessRoot
} from "#test/support/oracle/mutants/cases.ts"
import { type ReferenceInput, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import {
	FragmentReference,
	owedOf,
	physical,
	propsOf,
	soundness
} from "#test/support/unit/analysis/physical/support.ts"

/** What a case's analysis claimed and its evaluation reached. */
export const claimFeatures = [
	"a key claimed",
	"nothing owed",
	"an obligation discharged",
	"a bound claimed"
] as const

export type SoundnessFeature =
	| (typeof claimFeatures)[number]
	| `evaluated ${RelKind}`
	| `a correlated ${RelKind} evaluated per outer tuple`
	| "a node read by two consumers"
	| "a constant read laterally"

/**
 * Every claim the analysis makes holds on every relation the fragment evaluator computes. A case the reference cannot
 * evaluate is a gap of the oracle, never a pass: it fails.
 */
export const check = (
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
	const fragments = FragmentReference.delivered(dag, input, (node) => analysis.of(node).realization)
	const violations = soundness(analysis, fragments)
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
		if (fragments.evaluations.correlated(node)) {
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
		if (p.uniqueness.kind !== "none") {
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

export const inputOf = (c: {
	readonly schema: ReferenceInput["schema"]
	readonly facts: ReferenceInput["facts"]
	readonly query: { readonly params: ReferenceInput["params"] }
}): ReferenceInput => ({
	schema: c.schema,
	facts: c.facts,
	params: c.query.params,
	functions: noFunctions,
	observer: unobserved
})

/** The counterexample roots of the mutant suite, by what each builds. */
export type CounterexampleRoot =
	| "a projection"
	| "a keyed join"
	| "a fanout join"
	| "a witness"
	| "a group"
	| "a projected group"
	| "a tagged union"
	| "an untagged union"
	| "a bound under EXISTS"

export const counterexampleRoots: Arr.NonEmptyReadonlyArray<
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
export const rootedCases: Gen<readonly [CounterexampleRoot, QueryCase]> = (source) => {
	const [root, cases] = source.draw(element(counterexampleRoots))
	return [root, source.draw(cases)] as const
}

/**
 * What a case's filters reached: two conjuncts to reverse, and a column they fix to two values. Each generated case's
 * equalities of a column to a value fixed per evaluation are doubled by a twin over a parameter of their own
 * (twiceFixed), so the cases hold such columns wherever their filters fix one.
 */
export type OrderFeature = "a filter of two conjuncts" | "a column fixed to two values"
