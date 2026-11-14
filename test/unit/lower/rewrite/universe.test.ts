/**
 * The rewrite pipeline preserves what every query of the small closed universe delivers, on every database the
 * query's context may see.
 *
 * Every plan of the small-scope grammars (test/unit/analysis/small/plans.ts) up to two operators, under every key and
 * containment variant and every execution context it can be read in, is checked as a compilation checks it and run
 * through the optimizer's rewrite pipeline (lower/optimize/pipeline.ts rewritePipeline: demand, semantic
 * simplification, the relational rewrites, the compile-target catalog and graph specialization) under the context's
 * own catalog, with the evidence contexts its installation gives. On every database of the universe the context may
 * see, under every binding of the plan's parameters, the reference evaluator computes the same statements, headings
 * and row sets for the rewritten query as for the checked one (rewrite/support.ts delivery). A database only a
 * transaction may see (a containment broken until commit) is where a rewrite that trusted evidence the context does not
 * hold delivers something else. Plans of the core grammar up to three operators are searched with the same property.
 *
 * Three-operator exhaustion costs about 28 minutes per project (49,546 cases), so two operators are exhausted and three
 * searched.
 *
 * A refusal by the pipeline is a failure: the checker admitted the query, so the compilation must lower it.
 *
 * Oracle: the reference evaluator's delivery of the checked query (a second implementation). Features: each plan's
 * operators, the semi-join, elimination and pruning rules, the transaction context, a dangling reference a transaction
 * sees; and in the search, every core operator at depth three and every context. No kept cases: the runs whose limit
 * the three-operator space outgrew refused it before any case ran.
 *
 * Plant, failing every search: a deferred containment read as proving existence inside a transaction
 * (eliminate-deferred).
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import { rewritePipeline } from "#compiler/lower/optimize/pipeline.ts"
import { defined } from "#test/support/assert.ts"
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
	printPlan,
	type Step
} from "#test/unit/analysis/small/plans.ts"

import { caseHang } from "#test/support/limits.ts"
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
 * What a plan of the universe reaches: its operators, the rules the pipeline fired, the context it ran in, and the
 * databases only a transaction may see.
 */
type UniverseFeature =
	| PlanFeature
	| CertificateRule
	| `context ${TemplateContext}`
	| "a dangling reference seen in a transaction"
	| `${Step["op"]} at depth three`

/** The core grammar's operators after its scan (plans.ts plansUpTo), each one a search must reach at depth three. */
const coreSteps: Arr.NonEmptyReadonlyArray<Step["op"]> = [
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
 * looked up in the property, so the space holds the variant's data and the report prints it. The box is the grammar's
 * and the variants', exhausted whole.
 */
const exhaustUpTo = (
	grammar: Grammar,
	among: Arr.NonEmptyReadonlyArray<Variant>,
	operators: number
) => {
	const installs = new Map(Arr.map(among, (variant) => [variant, installed(variant)] as const))
	const generator: Gen<readonly [Variant, Plan]> = (source) =>
		[source.draw(element(among)), source.draw(plansUpTo(grammar, operators))] as const
	return exhaust(
		{
			box: `every plan of the ${grammar.name} grammar of up to ${operators} operators, under every key and containment variant, in every context it can be read in, on every database the context may see, under every binding of its parameters`,
			oracle: {
				kind: "second-implementation",
				name: "the reference evaluator's delivery of the checked query"
			},
			suite: `unit/lower/rewrite/universe-${grammar.name}-${operators}`,
			generator,
			literal: Formatter.format,
			coverage: requiredInSpace<UniverseFeature>(situations),
			caseHang,
			concurrency: 1
		},
		([variant, plan], c) =>
			Effect.sync(() => {
				preserves(defined(installs.get(variant), `the installation of ${variant.name}`), plan, c)
			})
	)
}

/**
 * The plans of `grammar` up to three operators under every variant of `among`, searched: each case's plan preserves its
 * delivery as an exhausted one does, and the search must reach every operator of the core grammar as the third and
 * every context.
 */
const searchDepthThree = (grammar: Grammar, among: Arr.NonEmptyReadonlyArray<Variant>) => {
	const installs = new Map(Arr.map(among, (variant) => [variant, installed(variant)] as const))
	return explore(
		{
			oracle: {
				kind: "second-implementation",
				name: "the reference evaluator's delivery of the checked query"
			},
			suite: `unit/lower/rewrite/universe-${grammar.name}-3-search`,
			draw: drawn(
				(source): readonly [Variant, Plan] =>
					[source.draw(element(among)), source.draw(plansUpTo(grammar, 3))] as const
			),
			literal: Formatter.format,
			coverage: required<UniverseFeature>(
				[
					...Arr.map(coreSteps, (op): UniverseFeature => `${op} at depth three`),
					"context snapshot",
					"context transaction"
				],
				{ cases: 400, sense: notesOnly }
			),
			kept: [],
			runs: 200,
			shrink: completeShrink,
			concurrency: 1,
			steerEvery: 16,
			caseHang
		},
		([variant, plan], c) =>
			Effect.sync(() => {
				const [, third] = plan.steps
				if (third !== undefined) {
					c.note(`${third.op} at depth three`)
				}
				preserves(defined(installs.get(variant), `the installation of ${variant.name}`), plan, c)
			})
	)
}

describe("the rewrite pipeline over a small closed universe", () => {
	it.effect(
		"every core query of up to two operators delivers what it delivered before the rewrites",
		(ctx) => searched(ctx, exhaustUpTo(coreGrammar, variants, 2))
	)

	it.effect(
		"every searched core query of up to three operators delivers what it delivered before the rewrites",
		(ctx) => searched(ctx, searchDepthThree(coreGrammar, variants))
	)

	it.effect(
		"every extended query of up to two operators delivers what it delivered before the rewrites",
		(ctx) => searched(ctx, exhaustUpTo(extendedGrammar, variants, 2))
	)
})
