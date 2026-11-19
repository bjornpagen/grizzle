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
	/** Its pre-conversion budget: runs 1200, coverage cases 1200 (equivalence.test.ts `general` at 4fbc3e95). */
	budget: { runs: 1200, steered: 1200 },
	kills: [
		{
			file: "packages/engine/src/lower/shapes/recursion/index.ts",
			original: '\t\t\t\t\tquery: select({ kind: "setOp", op: "UNION", arms: [base, step] }),',
			replacement:
				'\t\t\t\t\tquery: select({ kind: "setOp", op: "UNION ALL", rows: "operand", arms: [base, step] }),',
			why: "The optimized lowering's recursive CTE feeds back with UNION ALL, so repeated states are kept and a cycle never reaches its fixed point."
		}
	],
	check: agreementOnly
})

/** Every attached recursion is seeded from the parent keys and agrees (R37). */
export const attached = agreeOn({
	limits: { ...defaultRecursiveLimits, consumers: ["attach"] },
	situations: ["seeded attachment"] satisfies ReadonlyArray<Reached<GraphFeature>>,
	/** Its pre-conversion budget: runs 400, coverage cases 400 (equivalence.test.ts `attached` at 4fbc3e95). */
	budget: { runs: 400, steered: 400 },
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
	/** Its pre-conversion budget: runs 200, coverage cases 200 (equivalence.test.ts `filtered / 2` at 4fbc3e95). */
	budget: { runs: 200, steered: 200 },
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
	/** Its pre-conversion budget: runs 200, no coverage (equivalence.test.ts `filtered / 2` at 4fbc3e95). */
	budget: { runs: 200, steered: 0 },
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
	/** Its pre-conversion budget: runs 250, coverage cases 250 (equivalence.test.ts `fixedLength` at 4fbc3e95). */
	budget: { runs: 250, steered: 250 },
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
