/**
 * The optimized lowering with graph recognition against the conservative lowering on PostgreSQL 19.
 *
 * Seeded graph-shaped recursive queries (test/support/oracle/gen/recursive.ts: chains, trees, diamonds, self-loops,
 * dense cycles, random graphs, parallel edges, multiple roots carrying origin) are lowered by the full optimized
 * pipeline, graph pass and R37 seeding included, and by the conservative lowering, run on PostgreSQL, and compared
 * statement by statement as raw text sets, with no repeated row on the optimized side.
 *
 * - The general population covers every consumer and recursion family; every recursion, bounded or not, is the
 *   recursive CTE (its kernel feature registry).
 * - The attachment population is every recursion attached to its roots by origin: each is seeded once
 *   from the delivered parents' key recordset (R37), and the suite requires every attachment statement to be seeded:
 *   equal values have one canonical cell text, so every origin type stitches by key.
 * - The seed-filter population is three result predicates: a filter on the origin, which the graph
 *   pass pushes into the seed (graph.seedPushdown), and a filter on the end vertex and a final inequality, which it
 *   must not move. The suite requires the pushdown to have fired on origin filters and agreement everywhere. The
 *   generator filters the recursion directly, the filter site; the constant and region sites agree in
 *   seed-sites.test.ts.
 * - Fixed-length connected matches give the same set through joins and through a bounded recursive relation, both
 *   optimized (the conservative pair is test/pg/recursion/oracle/fixed-length.test.ts).
 * - In every population each case's optimized program shows a WITH RECURSIVE anywhere in a statement when its query
 *   reaches a recursion, and none when it reaches none (graph/support.ts formsBroken), and a case that breaks it
 *   fails.
 *
 * @cpu-bound
 */

import type { Reached } from "@bjornpagen/testing/features"
import type { Case } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	agreeOn,
	agreementOnly,
	everyAttachmentSeeded,
	generalRequired,
	type GraphFeature,
	noGraphRuleFired,
	optimizedAt
} from "#test/pg/recursion/graph/equivalence.fixtures.ts"
import { formsBroken, type Note } from "#test/pg/recursion/graph/support.ts"
import {
	defaultGraphLimits,
	defaultRecursiveLimits,
	fixedLengthCaseGen
} from "#test/support/oracle/gen/recursive.ts"
import {
	comparisonFailed,
	defaultRunOptions,
	oracleProperty,
	printOutcome,
	PropertyFailed,
	runOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"

/** Graph recognition agrees with the conservative lowering on seeded recursive queries of every family and consumer. */
export const general = agreeOn({
	limits: defaultRecursiveLimits,
	situations: generalRequired,
	/**
	 * Its search budget: 61 runs of its rotating stream, so a floor of 16 (a quarter of the runs, rounded up), and at most
	 * 48 steered cases, the phase that runs only while a required situation is unreached. Its witnesses, the floor and the
	 * steered phase, are fixed by its identity, so every run seed reaches its situations and judges its kills alike.
	 *
	 * @limitKind measured
	 * @owner test/pg/recursion/graph/equivalence.test.ts's property general, its search
	 * @unit cases: the rotating stream's runs, and the steered phase's most
	 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
	 *   stream
	 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
	 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
	 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
	 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged after
	 *   its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under a
	 *   verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
	 * @observed 2026-11-23 03:27 to 04:39 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
	 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
	 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
	 * @workload this property at { runs, steered } of { 1200, 1200 }, its pre-conversion budget (equivalence.test.ts
	 *   `general` at 4fbc3e95), then { 1, 2000 }, { 61, 2000 }
	 * @result At { 1200, 1200 }, 1500 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
	 *   situation reached by a witness, and every kill killed at { 1, 2000 } (130 cases, 128 steered); { 61, 2000 } (125
	 *   cases, 48 steered); and at { 61, 48 } again under a verdict cache of its own (final1). Worker CPU is a loaded
	 *   machine's and not compared
	 * @decision runs 61 and steered 48, the fewest cases measured: from a floor of 16 the steered phase reaches every
	 *   situation in 48 cases, from a floor of 1 in 128; its kill is red on floor case 0 at every budget measured. The
	 *   steered phase stops once every situation is reached, so its cap costs no case beyond those it runs. No headroom: a
	 *   run that reaches fewer situations says which
	 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
	 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's runner/search.ts,
	 *   random.ts and limits.ts)
	 */
	budget: { runs: 61, steered: 48 },
	kills: [
		{
			file: "packages/engine/src/lower/shapes/recursion/index.ts",
			original: '\t\t\t\t\t\tselect({ kind: "setOp", op: "UNION", arms: [base, step] }),',
			replacement:
				'\t\t\t\t\t\tselect({ kind: "setOp", op: "UNION ALL", rows: "operand", arms: [base, step] }),',
			why: "The optimized lowering's recursive CTE feeds back with UNION ALL, so repeated states are kept and a cycle never reaches its fixed point."
		}
	],
	check: agreementOnly
})

/** Every attached recursion is seeded from the parent keys and agrees (R37). */
export const attached = agreeOn({
	limits: { ...defaultRecursiveLimits, consumers: ["attach"] },
	situations: ["seeded attachment"] satisfies ReadonlyArray<Reached<GraphFeature>>,
	/**
	 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and no steered
	 * case: its floor reaches every required situation. Its floor is fixed by its identity, so every run seed reaches its
	 * situations and judges its kills alike.
	 *
	 * @limitKind measured
	 * @owner test/pg/recursion/graph/equivalence.test.ts's property attached, its search
	 * @unit cases: the rotating stream's runs, and the steered phase's most
	 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
	 *   stream
	 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
	 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
	 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
	 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged after
	 *   its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under a
	 *   verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
	 * @observed 2026-11-23 03:27 to 04:39 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
	 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
	 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
	 * @workload this property at { runs, steered } of { 400, 400 }, its pre-conversion budget (equivalence.test.ts
	 *   `attached` at 4fbc3e95), then { 1, 2000 }
	 * @result At { 400, 400 }, 500 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
	 *   situation reached by a witness, and every kill killed at { 1, 2000 } (2 cases, 0 steered); and at { 1, 0 } again
	 *   under a verdict cache of its own (final1). Worker CPU is a loaded machine's and not compared
	 * @decision runs 1, the fewest a rotating stream runs, and steered 0: a floor of one case reaches its situation, and
	 *   its kill is red on floor case 0 at every budget measured. The steered phase stops once every situation is reached,
	 *   so its cap costs no case beyond those it runs. No headroom: a run that reaches fewer situations says which
	 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
	 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's runner/search.ts,
	 *   random.ts and limits.ts)
	 */
	budget: { runs: 1, steered: 0 },
	kills: [
		{
			file: "packages/engine/src/lower/shapes/attach-recursive/index.ts",
			original: "\tif (cx.feedback.has(child.id)) {",
			replacement: "\tif (!cx.feedback.has(child.id)) {",
			why: 'seedDecision refuses every recursive attachment as "the recursion being lowered" (the feedback test inverted), so no attachment is seeded and the pipelined statement stands.'
		}
	],
	check: everyAttachmentSeeded
})

/** Origin filters are pushed into the seed. */
export const originFilter = agreeOn({
	limits: { ...defaultRecursiveLimits, consumers: ["originFilter"] },
	situations: ["graph.seedPushdown.filter"] satisfies ReadonlyArray<Reached<GraphFeature>>,
	/**
	 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and no steered
	 * case: its floor reaches every required situation. Its floor is fixed by its identity, so every run seed reaches its
	 * situations and judges its kills alike.
	 *
	 * @limitKind measured
	 * @owner test/pg/recursion/graph/equivalence.test.ts's property originFilter, its search
	 * @unit cases: the rotating stream's runs, and the steered phase's most
	 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
	 *   stream
	 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
	 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
	 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
	 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged after
	 *   its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under a
	 *   verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
	 * @observed 2026-11-23 03:27 to 04:39 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
	 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
	 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
	 * @workload this property at { runs, steered } of { 200, 200 }, its pre-conversion budget (equivalence.test.ts
	 *   `filtered / 2` at 4fbc3e95), then { 1, 2000 }
	 * @result At { 200, 200 }, 250 cases at f1bf91a2f's gate, its kill left graph.seedPushdown.filter unreached by every
	 *   witness. Green, every required situation reached by a witness, and every kill killed at { 1, 2000 } (2 cases, 0
	 *   steered); and at { 1, 0 } again under a verdict cache of its own (final1). Worker CPU is a loaded machine's and
	 *   not compared
	 * @decision runs 1, the fewest a rotating stream runs, and steered 0: a floor of one case reaches
	 *   graph.seedPushdown.filter, which its kill leaves unreached at every budget measured, so its witnesses go red. The
	 *   steered phase stops once every situation is reached, so its cap costs no case beyond those it runs. No headroom: a
	 *   run that reaches fewer situations says which
	 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
	 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's runner/search.ts,
	 *   random.ts and limits.ts)
	 */
	budget: { runs: 1, steered: 0 },
	kills: [
		{
			file: "packages/engine/src/lower/optimize/graph/index.ts",
			original: "\trules: [seedPushdown],",
			replacement: "\trules: [],",
			why: "The graph pass holds no seed pushdown rule, so no predicate over a recursion's carried columns reaches its seed."
		}
	],
	check: agreementOnly
})

/** No end-vertex filter or final inequality is moved. */
export const endpointFilter = agreeOn({
	limits: { ...defaultRecursiveLimits, consumers: ["endFilter", "endNe"] },
	situations: [],
	/**
	 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and no steered
	 * phase, since it requires no situation. Its floor is fixed by its identity, so every run seed judges its kills alike.
	 *
	 * @limitKind measured
	 * @owner test/pg/recursion/graph/equivalence.test.ts's property endpointFilter, its search
	 * @unit cases: the rotating stream's runs, and the steered phase's most
	 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
	 *   stream
	 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
	 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
	 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
	 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged after
	 *   its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under a
	 *   verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
	 * @observed 2026-11-23 03:27 to 04:39 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
	 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
	 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
	 * @workload this property at { runs, steered } of { 200, 0 }, its pre-conversion budget (equivalence.test.ts `filtered
	 *   / 2` at 4fbc3e95), then { 1, 0 }
	 * @result At { 200, 0 }, 250 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every case passing,
	 *   and every kill killed at { 1, 0 } (2 cases, 0 steered); and at { 1, 0 } again under a verdict cache of its own
	 *   (final1). Worker CPU is a loaded machine's and not compared
	 * @decision runs 1, the fewest a rotating stream runs: its kill is red on floor case 0 at every budget measured;
	 *   steered 0, as it requires no situation.
	 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
	 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's runner/search.ts,
	 *   random.ts and limits.ts)
	 */
	budget: { runs: 1, steered: 0 },
	kills: [
		{
			file: "packages/engine/src/ir/expr.ts",
			original: "\tsameOrder<ScalarExpr>(before.args, after.args)",
			replacement: "\tbefore.args.length === after.args.length",
			why: "sameArgs compares the arguments' count alone, so a rewrite that changed an argument keeps the expression; the property fails (first lane CATCH's operator mutant at grizzle 0baff5d6)."
		}
	],
	check: noGraphRuleFired
})

/** Fixed-length connected matches give the same set through joins and recursive CTEs, both optimized. */
export const fixedLength = oracleProperty(fixedLengthCaseGen(defaultGraphLimits), {
	situations: ["recursive CTE"] satisfies ReadonlyArray<Reached<GraphFeature>>,
	perturb: "all",
	oracle: {
		kind: "universal",
		name: "a fixed-length match through joins and through a hop-counting recursive CTE are one set, both optimized"
	},
	kept: [],
	/**
	 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and no steered
	 * case: its floor reaches every required situation. Its floor is fixed by its identity, so every run seed reaches its
	 * situations and judges its kills alike.
	 *
	 * @limitKind measured
	 * @owner test/pg/recursion/graph/equivalence.test.ts's property fixedLength, its search
	 * @unit cases: the rotating stream's runs, and the steered phase's most
	 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
	 *   stream
	 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
	 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
	 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
	 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged after
	 *   its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under a
	 *   verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
	 * @observed 2026-11-23 03:27 to 04:39 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
	 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
	 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
	 * @workload this property at { runs, steered } of { 250, 250 }, its pre-conversion budget (equivalence.test.ts
	 *   `fixedLength` at 4fbc3e95), then { 1, 2000 }
	 * @result At { 250, 250 }, 313 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
	 *   situation reached by a witness, and every kill killed at { 1, 2000 } (2 cases, 0 steered); and at { 1, 0 } again
	 *   under a verdict cache of its own (final1). Worker CPU is a loaded machine's and not compared
	 * @decision runs 1, the fewest a rotating stream runs, and steered 0: a floor of one case reaches its situation, and
	 *   its kill is red on floor case 0 at every budget measured. The steered phase stops once every situation is reached,
	 *   so its cap costs no case beyond those it runs. No headroom: a run that reaches fewer situations says which
	 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
	 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's runner/search.ts,
	 *   random.ts and limits.ts)
	 */
	budget: { runs: 1, steered: 0 },
	kills: [
		{
			file: "packages/engine/src/core/identity.ts",
			original:
				"const isConversion = (text: string): boolean => parsedName(text).ok && conversionOf(text) === text",
			replacement: "const isConversion = (text: string): boolean => false",
			why: "Operator mutant (boolean-return) at packages/engine/src/core/identity.ts:432 in isConversion: `parsedName(text).ok && conversionOf(text) === text` becomes `false`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	],
	show: Formatter.format,
	check: (notes: Case<GraphFeature>) => (c) =>
		Effect.gen(function* () {
			const seat = yield* OracleSeat
			const schema = yield* seat.schema("graphfixed")
			/** The features each root's lowering noted, the joins' and the recursive relation's. */
			const noting: Note = (fs) => {
				notes.noteAll(fs)
			}
			const both = yield* runOracle(c, optimizedAt(noting, 0), optimizedAt(noting, 1), {
				...defaultRunOptions,
				schema: { kind: "named", name: schema }
			})
			const cmp = both.comparison
			if (!cmp.equal) {
				return yield* comparisonFailed(both)
			}
			if (both.right.kind === "reference") {
				return yield* new PropertyFailed({
					report: `no optimized program of root 1\n${printOutcome(both)}`
				})
			}
			/**
			 * Each root shows the form of what it reaches: the joins no recursion, the recursive relation
			 * its one.
			 */
			const sides = [
				[0, both.left.program],
				[1, both.right.program]
			] as const
			for (const [which, program] of sides) {
				const root = c.query.dag.roots[which]
				if (root === undefined) {
					return yield* new PropertyFailed({
						report: `no optimized program of root ${which}\n${printOutcome(both)}`
					})
				}
				const unseen = formsBroken(root, program)
				if (unseen !== undefined) {
					return yield* new PropertyFailed({
						report: `root ${which}: ${unseen}\n${printOutcome(both)}`
					})
				}
			}
		})
})
