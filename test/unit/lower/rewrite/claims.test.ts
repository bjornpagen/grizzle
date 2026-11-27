/**
 * Every pass of the rewrite pipeline leaves a DAG whose claims are what an analysis of it states (lower/optimize
 * pipeline.ts rewritePasses): a node's logical keys, with their premises and the implications that prove them, its
 * cardinality, its context, the parameters it depends on and the relations it reads (ir/rel.ts Meta), each a fact the
 * logical analysis derives of the node's content (logical/annotate.ts), which the lowering after the pipeline reads as
 * it stands (the key sets its statements compute their nodes at, lower/shapes/share/keyed.ts, and the shapes). A pass
 * that rebuilds a node keeps the claims its cell held before the rewrite, so a pruned column's name stays in an
 * implication and a key the rewrite's new structure proves is claimed by no node.
 *
 * The box, exhausted: every plan of the core grammar of up to two operators (test/unit/analysis/small/plans.ts), under
 * every key and containment variant of the small universe, in every context it can be read in, checked as a compilation
 * checks it and made the optimized input a query's compile makes (pipeline.ts optimizedInput, under queryEvidence).
 *
 * Per case: after each pass, every node's claims, encoded canonically, are the claims an analysis of the pass's output
 * in the same evidence states of it. Oracle: a second implementation, the logical analysis of the output alone. Kill:
 * the pipeline's passes leaving the DAG as they rebuilt it, its claims unread (pipeline.ts claimed).
 *
 * And the claims cost the nodes the passes build (pipeline.ts OptimizedInput, one store of the compile's analyses): a
 * compile's annotations, counted per node (logical/annotate.ts, a run's `annotate`), are at most the nodes of its
 * optimized input, and for each pass that rebuilt the DAG, the nodes of its output no earlier form of the DAG held,
 * and those at or above an attachment, a recursion or its feedback, which every analysis annotates again
 * (logical/annotate.ts SharedState selves): a budget of work, counted, never time. Its box: the same plans, searched.
 * Kill: an analysis reading nothing an earlier one of the compile annotated, so every pass's output is annotated whole.
 *
 * Features: a pass that rewrote the DAG, one that left it as it was; the transaction context.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { inputsOf, type RelNode } from "#compiler/ir/rel.ts"
import { analyzeLogical, everyNode, queryEvidence } from "#compiler/logical/annotate.ts"
import { optimizedInput, rewritePasses } from "#compiler/lower/optimize/pipeline.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts, type CountedFunction } from "#test/support/kernel/calls.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	coreGrammar,
	descOf,
	type Plan,
	plansUpTo,
	printPlan
} from "#test/unit/analysis/small/plans.ts"
import {
	contextsOf,
	type Installed,
	installed,
	type Variant,
	variants
} from "#test/unit/analysis/small/universe.ts"

type Feature =
	| "a pass that rewrote the DAG"
	| "a pass that left it as it was"
	| "context transaction"

/** Each node of `query` whose claims are not those an analysis of its DAG states, by label and kind, with both. */
const staleClaims = (query: LogicalQuery): ReadonlyArray<string> => {
	const fresh = succeeded(analyzeLogical(query.dag, queryEvidence, everyNode))
	return Arr.flatMap(topoOrder(query.dag), (node) => {
		const stated = succeeded(encode(node.meta, everyProperty))
		const derived = succeeded(encode(fresh.of(node).node.meta, everyProperty))
		return stated === derived
			? []
			: [`${node.id} (${node.kind}): claims ${stated}, its analysis ${derived}`]
	})
}

/** One plan under one installed variant, in each context: every pass leaves the claims its output's analysis states. */
const passesKeepClaims = (inst: Installed, plan: Plan, c: Case<Feature>): void => {
	const where = `${inst.variant.name}: ${printPlan(plan)}`
	const checked = checkQuery(checking(inst.desc), descOf(plan), checkOptions("query"))
	if (!checked.ok) {
		throw new Error(
			`the checker refuses a plan the space offers: ${checked.error.message}\n${where}`
		)
	}
	const inContext = (context: TemplateContext): void => {
		if (context === "transaction") {
			c.note("context transaction")
		}
		const ctx = makePassContext({
			evidenceContext: context,
			catalog: inst.physical(context).catalog
		})
		const input = succeeded(optimizedInput(checked.value, queryEvidence))
		let current: LogicalQuery = input.query
		for (const [i, pass] of rewritePasses(input.analyses).entries()) {
			const out = succeeded(pass.run(current, ctx), `${where} (${context}): pass ${i} ${pass.name}`)
			c.note(
				out.dag === current.dag ? "a pass that left it as it was" : "a pass that rewrote the DAG"
			)
			const stale = staleClaims(out)
			assert.equal(
				stale.length,
				0,
				`${where} (${context}): pass ${i} ${pass.name} leaves claims its output's analysis does not state:\n${Arr.join(stale, "\n")}`
			)
			current = out
		}
	}
	for (const context of contextsOf(inst.variant)) {
		inContext(context)
	}
}

const installs: ReadonlyMap<Variant, Installed> = new Map(
	Arr.map(variants, (variant) => [variant, installed(variant)] as const)
)

const plans: Gen<readonly [Variant, Plan]> = (source) =>
	[source.draw(element(variants)), source.draw(plansUpTo(coreGrammar, 2))] as const

/** Every pass of the rewrite pipeline leaves the claims an analysis of its output states, over the small universe's core plans of up to two operators. */
export const everyPassOfTheRewritePipelineLeavesTheClaimsAnAnalysisOfItsOutputStatesOverTheSmallUniversesCorePlansOfUpToTwoOperators =
	property.exhaust(finite(plans), {
		needs: {},
		situations: [
			"a pass that rewrote the DAG",
			"a pass that left it as it was",
			"context transaction"
		],
		check:
			(_, c: Case<Feature>) =>
			([variant, plan]) =>
				Effect.sync(() => {
					passesKeepClaims(
						defined(installs.get(variant), `the installation of ${variant.name}`),
						plan,
						c
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the logical analysis of the pass's output alone"
		},
		box: "every plan of the core grammar of up to two operators, under every key and containment variant of the small universe, in every context it can be read in",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/pipeline.ts",
				original: "\t\t\tout.dag === query.dag ? Result.ok(out) : annotateQuery(out, analyses)\n",
				replacement: "\t\t\tResult.ok(out)\n",
				why: "The pipeline's passes leave the DAG as they rebuilt it, each rebuilt node holding the claims its cell held: a key R02's new region proves is claimed by none, and a proof names the occurrence R03 eliminated."
			}
		]
	})

/**
 * The nodes of `nodes`, in topological order, at or above an attachment, a recursion or its feedback: those every
 * analysis annotates again, whichever version of the DAG it reads (logical/annotate.ts SharedState selves).
 */
const annotatedAgain = (nodes: ReadonlyArray<RelNode>): ReadonlySet<RelNode> => {
	const above = new Set<RelNode>()
	for (const node of nodes) {
		if (
			node.kind === "Attach" ||
			node.kind === "Recursive" ||
			node.kind === "SelfRef" ||
			Arr.some(inputsOf(node), (input) => above.has(input))
		) {
			above.add(node)
		}
	}
	return above
}

/**
 * The annotations a compile's budget allows: the nodes of its optimized input, and for each pass that rebuilt the DAG,
 * the nodes of its output no earlier form held and those every analysis annotates again.
 */
const budgetOf = (forms: Arr.NonEmptyReadonlyArray<LogicalQuery>): number => {
	const [first, ...rest] = forms
	const met = new Set<RelNode>(topoOrder(first.dag))
	let budget = met.size
	let before = first
	for (const form of rest) {
		if (form.dag !== before.dag) {
			const nodes = topoOrder(form.dag)
			budget += new Set([...Arr.filter(nodes, (node) => !met.has(node)), ...annotatedAgain(nodes)])
				.size
			for (const node of nodes) {
				met.add(node)
			}
		}
		before = form
	}
	return budget
}

/** The logical analysis's annotation of one node, whose calls a case counts (logical/annotate.ts, a run's `annotate`). */
const annotations = Object.freeze({
	annotate: { file: "packages/engine/src/logical/annotate.ts", name: "annotate" }
} satisfies Readonly<Record<string, CountedFunction>>)

/** The claims of a compile's rewrite pipeline cost the nodes its passes build. */
export const theClaimsOfACompilesRewritePipelineCostTheNodesItsPassesBuildAtMostItsInputsAndEachRebuiltFormsNewNodes =
	property.explore(plans, {
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: ["a pass that rewrote the DAG", "context transaction"],
		check:
			(_, c: Case<Feature>) =>
			([variant, plan]) =>
				Effect.gen(function* () {
					const inst = defined(installs.get(variant), `the installation of ${variant.name}`)
					const where = `${variant.name}: ${printPlan(plan)}`
					const checked = succeeded(
						checkQuery(checking(inst.desc), descOf(plan), checkOptions("query"))
					)
					for (const context of contextsOf(inst.variant)) {
						if (context === "transaction") {
							c.note("context transaction")
						}
						const ctx = makePassContext({
							evidenceContext: context,
							catalog: inst.physical(context).catalog
						})
						const [forms, counts] = yield* callCounts(
							Effect.sync(() => {
								const input = succeeded(optimizedInput(checked, queryEvidence))
								const made: Array<LogicalQuery> = []
								let current: LogicalQuery = input.query
								for (const pass of rewritePasses(input.analyses)) {
									const out = succeeded(pass.run(current, ctx))
									if (out.dag !== current.dag) {
										c.note("a pass that rewrote the DAG")
									}
									made.push(out)
									current = out
								}
								return [input.query, ...made] as const
							}),
							annotations
						)
						const budget = budgetOf(forms)
						assert.ok(
							counts.annotate <= budget,
							`${where} (${context}): ${counts.annotate} annotations, past the budget of ${budget}`
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: "a node an analysis of the compile annotated is annotated again only at or above an attachment or a recursion"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/annotate.ts",
				original:
					"\t\tconst self = own(node)\n\t\tif (self !== undefined) {\n\t\t\treturn self\n\t\t}\n\t\tconst entry = entryOf(state, node)\n",
				replacement: "\t\tconst entry = undefined\n",
				why: "An analysis reads nothing an earlier analysis of the compile annotated, so every pass that rebuilt the DAG annotates its output whole, the nodes no pass touched among them."
			}
		]
	})
