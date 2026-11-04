import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import { rewritePipeline } from "#compiler/lower/optimize/pipeline.ts"
import { defined } from "#test/support/assert.ts"
import { schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { type ReferenceInput, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	coreGrammar,
	descOf,
	extendedGrammar,
	type Grammar,
	type Plan,
	type PlanFeature,
	planOps,
	plansUpTo,
	printPlan
} from "#test/unit/analysis/small/plans.ts"

import {
	contextsOf,
	databases,
	type Installed,
	installed,
	parameterValues,
	seen,
	type Variant,
	variants
} from "#test/unit/analysis/small/universe.ts"
import { sameDelivery } from "#test/unit/lower/rewrite/support.ts"

/**
 * The rewrite pipeline preserves what every query of the small closed universe delivers, on every database the
 * query's context may see.
 *
 * Every plan of the small-scope grammars (test/unit/analysis/small/plans.ts: the core grammar up to three operators,
 * the extended one up to two), under every key and containment variant and every execution context it can be read in,
 * is checked as a compilation checks it and run through the optimizer's rewrite pipeline (lower/optimize/pipeline.ts
 * rewritePipeline: demand, semantic simplification, the relational rewrites, the compile-target catalog and graph
 * specialization) under the context's own catalog, with the evidence contexts its installation gives. On every
 * database of the universe the context may see, under every binding of the plan's parameters, the reference evaluator
 * computes the same statements, headings and row sets for the rewritten query as for the checked one
 * (rewrite/support.ts delivery). A database only a transaction may see (a containment broken until commit) is where a
 * rewrite that trusted evidence the context does not hold delivers something else.
 *
 * A refusal by the pipeline is a failure: the checker admitted the query, so the compilation must lower it.
 */

/**
 * What a plan of the universe reaches: its operators, the rules the pipeline fired, the context it ran in, and the
 * databases only a transaction may see.
 */
type UniverseFeature =
	| PlanFeature
	| CertificateRule
	| `context ${TemplateContext}`
	| "a dangling reference seen in a transaction"

/**
 * One plan under one installed variant: in each context, the rewritten query delivers what the checked one delivers on
 * every database the context may see.
 */
const preserves = (inst: Installed, plan: Plan, c: Case<UniverseFeature>): void => {
	const where = `${inst.variant.name}: ${printPlan(plan)}`
	const checked = checkQuery(checking(schemaDesc(inst.schema)), descOf(plan), checkOptions("query"))
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
			budgets: new BudgetMeter(compileBudgets),
			evidenceContext: context,
			catalog: inst.physical(context).catalog
		})
		const rewritten = rewritePipeline("query").run(query, ctx)
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
 * looked up in the property, so the space holds the variant's data and the report prints it.
 */
const exhaustUpTo = (
	grammar: Grammar,
	among: Arr.NonEmptyReadonlyArray<Variant>,
	operators: number,
	limit: number
) => {
	const installs = new Map(Arr.map(among, (variant) => [variant, installed(variant)] as const))
	return exhaust(
		{
			suite: `unit/lower/rewrite/universe-${grammar.name}-${operators}`,
			generator: (source) =>
				[source.draw(element(among)), source.draw(plansUpTo(grammar, operators))] as const,
			literal: Formatter.format,
			limit,
			coverage: requiredInSpace<UniverseFeature>(situations),
			caseHang: Duration.minutes(2)
		},
		([variant, plan], c) =>
			Effect.sync(() => {
				preserves(defined(installs.get(variant), `the installation of ${variant.name}`), plan, c)
			})
	)
}

describe("the rewrite pipeline over a small closed universe", () => {
	it.effect(
		"every core query of up to three operators delivers what it delivered before the rewrites",
		(ctx) => searched(ctx, exhaustUpTo(coreGrammar, variants, 3, 40_000))
	)

	it.effect(
		"every extended query of up to two operators delivers what it delivered before the rewrites",
		(ctx) => searched(ctx, exhaustUpTo(extendedGrammar, variants, 2, 4_500))
	)
})
