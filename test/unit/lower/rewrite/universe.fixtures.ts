/** What the properties of universe.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import {
	type Case,
	type Kept,
	type Kill,
	type Property,
	property
} from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import { annotatedInput, rewritePipeline } from "#compiler/lower/optimize/pipeline.ts"
import { type ReferenceInput, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	descOf,
	type Grammar,
	type Plan,
	type PlanFeature,
	planOps,
	plansUpTo,
	printPlan,
	type PlanStep
} from "#test/support/unit/analysis/small/plans.ts"
import {
	contextsOf,
	databases,
	type Installed,
	installed,
	parameterValues,
	seen,
	type Variant
} from "#test/support/unit/analysis/small/universe.ts"
import { sameDelivery } from "#test/support/unit/lower/rewrite/support.ts"

/**
 * What a plan of the universe reaches: its operators, the rules the pipeline fired, the context it ran in, and the
 * databases only a transaction may see.
 */
type UniverseFeature =
	| PlanFeature
	| CertificateRule
	| `context ${TemplateContext}`
	| "a dangling reference seen in a transaction"
	| `${PlanStep["op"]} at depth three`

/** The core grammar's operators after its scan (plans.ts plansUpTo), each one a search must reach at depth three. */
const coreSteps: Arr.NonEmptyReadonlyArray<PlanStep["op"]> = [
	"filter",
	"project",
	"join",
	"negate",
	"count",
	"take",
	"union",
	"attach",
	"ordinal"
]

/**
 * One plan under one installed variant: in each context, the rewritten query delivers what the checked one delivers on
 * every database the context may see.
 */
const preserves = (inst: Installed, plan: Plan, c: Case<UniverseFeature>): void => {
	const where = `${inst.variant.name}: ${printPlan(plan)}`
	const checked = checkQuery(checking(inst.desc), descOf(plan), checkOptions("query"))
	if (!checked.ok) {
		throw new Error(
			`the checker refuses a plan the space offers: ${checked.error.message}\n${where}`
		)
	}
	c.noteAll(planOps(plan))
	const query = checked.value
	/** The plan in one context: every database the context may see delivers alike through the rewrite. */
	const inContext = (context: TemplateContext): void => {
		const at = `${where} (${context})`
		const ctx = makePassContext({
			evidenceContext: context,
			catalog: inst.physical(context).catalog
		})
		const input = annotatedInput(query, queryEvidence)
		const rewritten = Result.flatMap(input, (annotated) =>
			rewritePipeline(annotated.analyses).run(annotated.query, ctx)
		)
		if (!rewritten.ok) {
			throw new Error(
				`the rewrite pipeline refuses a checked query: ${rewritten.error.message}\n${at}`
			)
		}
		for (const certificate of ctx.certificates.all()) {
			c.note(certificate.rule)
		}
		c.note(`context ${context}`)
		for (const db of databases(inst.variant)) {
			if (!seen(db, context)) {
				continue
			}
			if (db.dangles) {
				c.note("a dangling reference seen in a transaction")
			}
			for (const params of parameterValues(plan.params)) {
				const input: ReferenceInput = {
					schema: inst.schema,
					facts: db.facts,
					params,
					functions: noFunctions,
					observer: unobserved
				}
				sameDelivery(input, query, rewritten.value)
			}
		}
	}
	for (const context of contextsOf(inst.variant)) {
		inContext(context)
	}
}

/**
 * The rewrites the universe's queries must keep firing: an existential match made a semi-join, a key match an
 * immediate foreign key makes redundant removed, and a witness column pruned; and the contexts that break evidence.
 */
const situations: Arr.NonEmptyReadonlyArray<UniverseFeature> = [
	"R02.semiJoin",
	"R03.elimination",
	"prune.heading",
	"context transaction",
	"a dangling reference seen in a transaction"
]

/**
 * Every plan of `grammar` up to `operators` operators under every variant of `among`, each variant installed once and
 * looked up in the property, so the space holds the variant's data and the report prints it. The box is the grammar's
 * and the variants', exhausted whole; `kills` are the calling property's.
 */
export const exhaustUpTo = (spec: {
	readonly grammar: Grammar
	readonly among: Arr.NonEmptyReadonlyArray<Variant>
	readonly operators: number
	readonly kills: ReadonlyArray<Kill>
}): Property => {
	const { grammar, among, operators } = spec
	const installs = new Map(Arr.map(among, (variant) => [variant, installed(variant)] as const))
	const generator: Gen<readonly [Variant, Plan]> = (source) =>
		[source.draw(element(among)), source.draw(plansUpTo(grammar, operators))] as const
	return property.exhaust(finite(generator), {
		needs: {},
		situations,
		check:
			(_, c: Case<UniverseFeature>) =>
			([variant, plan]) =>
				Effect.sync(() => {
					preserves(defined(installs.get(variant), `the installation of ${variant.name}`), plan, c)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's delivery of the checked query"
		},
		box: `every plan of the ${grammar.name} grammar of up to ${operators} operators, under every key and containment variant, in every context it can be read in, on every database the context may see, under every binding of its parameters`,
		kept: [],
		kills: spec.kills
	})
}

/**
 * The plans of `grammar` up to three operators under every variant of `among`, searched: each case's plan preserves its
 * delivery as an exhausted one does, and the search must reach every operator of the core grammar as the third and
 * every context; `kept` and `kills` are the calling property's.
 *
 * Its budget is what this search stated before it built a property: 200 runs and 400 steered cases
 * (test/unit/lower/rewrite/universe.test.ts:215-218 at 8cad5bce).
 */
export const searchDepthThree = (spec: {
	readonly grammar: Grammar
	readonly among: Arr.NonEmptyReadonlyArray<Variant>
	readonly kept: ReadonlyArray<Kept>
	readonly kills: ReadonlyArray<Kill>
}): Property => {
	const { grammar, among } = spec
	const installs = new Map(Arr.map(among, (variant) => [variant, installed(variant)] as const))
	return property.explore(
		(source): readonly [Variant, Plan] =>
			[source.draw(element(among)), source.draw(plansUpTo(grammar, 3))] as const,
		{
			needs: {},
			budget: { runs: 200, steered: 400 },
			situations: [
				...Arr.map(coreSteps, (op): UniverseFeature => `${op} at depth three`),
				"context snapshot",
				"context transaction"
			],
			check:
				(_, c: Case<UniverseFeature>) =>
				([variant, plan]) =>
					Effect.sync(() => {
						const [, third] = plan.steps
						if (third !== undefined) {
							c.note(`${third.op} at depth three`)
						}
						preserves(
							defined(installs.get(variant), `the installation of ${variant.name}`),
							plan,
							c
						)
					}),
			oracle: {
				kind: "second-implementation",
				name: "the reference evaluator's delivery of the checked query"
			},
			kept: spec.kept,
			kills: spec.kills
		}
	)
}
