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
 */

import { coreGrammar, extendedGrammar } from "#test/unit/analysis/small/plans.ts"
import { variants } from "#test/unit/analysis/small/universe.ts"
import { exhaustUpTo, searchDepthThree } from "#test/unit/lower/rewrite/universe.fixtures.ts"

/** The rewrite pipeline over a small closed universe every core query of up to two operators delivers what it delivered before the rewrites. */
export const theRewritePipelineOverASmallClosedUniverseEveryCoreQueryOfUpToTwoOperatorsDeliversWhatItDeliveredBeforeTheRewrites =
	exhaustUpTo({
		grammar: coreGrammar,
		among: variants,
		operators: 2,
		kills: [
			{
				file: "packages/engine/src/lower/optimize/eliminate/index.ts",
				original: "\t\tcx.ctx.evidenceContext\n\t)\n",
				replacement: '\t\t"snapshot"\n\t)\n',
				why: "R03 reads a containment's evidence as a snapshot read would, so a deferred containment proves existence inside a transaction; the core and extended two-operator exhaustions fail."
			}
		]
	})

/** The rewrite pipeline over a small closed universe every searched core query of up to three operators delivers what it delivered before the rewrites. */
export const theRewritePipelineOverASmallClosedUniverseEverySearchedCoreQueryOfUpToThreeOperatorsDeliversWhatItDeliveredBeforeTheRewrites =
	searchDepthThree({
		grammar: coreGrammar,
		among: variants,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/registry.ts",
				original:
					'\t\tfn: cmp,\n\t\toperands: positional([carrier, carrier]),\n\t\tresult: "bool",',
				replacement: '\t\tfn: cmp,\n\t\toperands: positional([carrier]),\n\t\tresult: "bool",',
				why: "Operator mutant (element) at packages/engine/src/scalar/compute/registry.ts:565 in comparison: `[carrier, carrier]` becomes `[carrier]`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/engine/src/scalar/compute/registry.ts",
				original:
					'\t\tfn: cmp,\n\t\toperands: positional([carrier, carrier]),\n\t\tresult: "bool",',
				replacement: '\t\tfn: cmp,\n\t\toperands: positional([carrier]),\n\t\tresult: "bool",',
				why: "Operator mutant (element) at packages/engine/src/scalar/compute/registry.ts:565 in comparison: `[carrier, carrier]` becomes `[carrier]`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/** The rewrite pipeline over a small closed universe every extended query of up to two operators delivers what it delivered before the rewrites. */
export const theRewritePipelineOverASmallClosedUniverseEveryExtendedQueryOfUpToTwoOperatorsDeliversWhatItDeliveredBeforeTheRewrites =
	exhaustUpTo({
		grammar: extendedGrammar,
		among: variants,
		operators: 2,
		kills: [
			{
				file: "packages/engine/src/lower/optimize/eliminate/index.ts",
				original: "\t\tcx.ctx.evidenceContext\n\t)\n",
				replacement: '\t\t"snapshot"\n\t)\n',
				why: "R03 reads a containment's evidence as a snapshot read would, so a deferred containment proves existence inside a transaction; the core and extended two-operator exhaustions fail."
			}
		]
	})
