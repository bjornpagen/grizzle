import { describe, it } from "@effect/vitest"
import { explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	relationalRewrites,
	semanticSimplification
} from "#compiler/lower/optimize/demand/phases.ts"
import { eliminatePass } from "#compiler/lower/optimize/eliminate/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { finishedDraw } from "#test/pg/oracle/frontier/finish.ts"
import { assert } from "#test/support/assert.ts"
import { rewriteFailingGenConfig } from "#test/support/oracle/gen/case.ts"
import { rewriteFailures, type VerdictKind } from "#test/support/oracle/verify/failures.ts"

/**
 * Prune, eliminate and the composed rewrite pipeline keep every failure the answer needs and invent none, over generated
 * cases with failing terms, judged host-side by the frontier reference (test/support/oracle/verify/failures.ts).
 *
 * Demand analysis, which drives prune and eliminate, has no notion of failure: prune drops undemanded
 * projection outputs and dead region bindings, and eliminate removes occurrences, without asking whether a dropped
 * expression must fail. That is sound exactly when a dropped expression is one the answer does not need. So for each
 * case and each rewrite:
 *
 * - a must-fail of the original stays a must-fail of the rewritten query, with SQLSTATEs the original can raise;
 * - a must-fail of the rewritten query is one the original could already meet, never a failure the rewrite invented;
 * - a rewrite never refuses a small generated query under the real compiler budgets (a false ResourceBound, the class
 *   of a hand-proved termination measure that misses a step).
 *
 * The cases are the rewrite passes' population with failing terms (gen/case.ts rewriteFailingGenConfig): computed terms
 * that divide by zero, overflow or cast out of range on the generated facts, under prunable projections, eliminable
 * occurrences and filters the pushdown rules move. Drawn for the shapes they meet, those terms seldom force a failure,
 * so half the plain roots end in the frontier's division by zero over the rows they deliver
 * (test/pg/oracle/frontier/finish.ts finishedDraw), and a failure the answer needs meets every run. A case the
 * reference does not evaluate is noted, never judged.
 */

type Passes = ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>

/** The rewrites judged: prune alone, eliminate after the prune it relies on, and the composed pipeline. */
const rewrites = {
	prune: [prunePass],
	eliminate: [prunePass, eliminatePass],
	pipeline: [semanticSimplification, relationalRewrites]
} as const satisfies Readonly<Record<string, Passes>>

type RewriteName = keyof typeof rewrites

const rewriteNames: ReadonlyArray<RewriteName> = ["prune", "eliminate", "pipeline"]

type FailuresFeature =
	| `${RewriteName} on ${VerdictKind | "unsupported"}`
	| `${RewriteName} fired ${CertificateRule}`

describe("rewrites keep every failure the answer needs", () => {
	it.effect(
		"prune, eliminate and the pipeline keep each must-fail and invent none on generated cases with failing terms",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/rewrite/failures",
						literal: Formatter.format,
						kept: [],
						draw: finishedDraw(rewriteFailingGenConfig),
						runs: 400,
						shrink: completeShrink,
						features: features<FailuresFeature>([
							"prune on must fail",
							"prune on may fail",
							"prune on rows",
							"eliminate on must fail",
							"pipeline on must fail",
							"prune fired prune.heading"
						]),
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(resolved, c) =>
						Effect.sync(() => {
							const q = c.draw(resolved)
							const problems = Arr.flatMap(rewriteNames, (name) => {
								const judged = rewriteFailures(q, name, rewrites[name])
								c.note(`${name} on ${judged.verdict}`)
								for (const rule of judged.rules) {
									c.note(`${name} fired ${rule}`)
								}
								return judged.problems
							})
							assert.deepEqual(
								problems,
								[],
								"every rewrite keeps the answer's needed failures and invents none"
							)
						})
				)
			)
	)
})
