/**
 * The conservative lowering against the brute-force reference evaluator on PostgreSQL 19.
 *
 * 2,000 generated cases of the generator's own population, and 2,000 more with denser facts so that fewer results are
 * empty, in the run's rotating stream (and a quarter as many in the suite's floor stream), each case under a plan
 * perturbation: one to four relations with composite and candidate keys, closed rosters, pure sets and
 * containments, small-domain facts including NaN, -0, numeric display scales and supplementary-plane text, and
 * queries over match, filter, project, semi- and anti-join, union, intersection, difference, group, take, attach and
 * recursion, at the root as a plain set, with attachments, or as a heterogeneous union. For every case, every
 * statement the conservative lowering emits returns exactly the raw text multiset the reference evaluator computes by
 * definition: the same rows, each once, since every statement delivers a set. A failing case shrinks and
 * is reported in printable form.
 */
import { layer } from "@effect/vitest"
import { drawn } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import type { Gen } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import type { TestContext } from "vitest"
import {
	type ConservativeFeature,
	caseFeatures,
	denseQueryCaseGen,
	operatorKinds
} from "#test/pg/oracle/support.ts"
import { defaultGenConfig, type QueryCase, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import {
	conservative,
	defaultRunOptions,
	oracleCheck,
	printOutcome,
	PropertyFailed,
	reference,
	runOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const cases = 2000

/**
 * The features the gate's population must contain: what its cases exercise, what only the real installer adds to their
 * plans, and "nonempty": a case whose conservative run delivered a row.
 */
const required = [
	"relations:1",
	"relations:2",
	"relations:3",
	"relations:4",
	"composite primary key",
	"candidate key",
	"composite candidate key",
	"pure set",
	"closed roster",
	"containment",
	"NaN fact",
	"-0 fact",
	"scaled numeric fact",
	"numeric spelling mismatch",
	"supplementary-plane text fact",
	...operatorKinds,
	"scalar parameter",
	"relation parameter",
	"parameter take bound",
	"nested attach",
	"text domain",
	"deferred foreign key",
	"nonempty"
] as const satisfies ReadonlyArray<ConservativeFeature>

/**
 * Every case of `gen` agrees with the reference. The suite explores its floor stream and the run's rotating stream, each
 * case under a plan perturbation drawn with it.
 */
const agreeOn = (ctx: TestContext, gen: Gen<QueryCase>, suite: string) =>
	searched(
		ctx,
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema({ create: false, label: "oracle" })
			return yield* oracleCheck(
				drawn(gen),
				{
					suite,
					literal: Formatter.format,
					features: features<ConservativeFeature>(required),
					kept: [],
					runs: cases,
					shrink: completeShrink,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2),
					perturb: "all"
				},
				(c, k) =>
					Effect.gen(function* () {
						k.noteAll(caseFeatures(c))
						const outcome = yield* runOracle(c, conservative, reference, {
							...defaultRunOptions,
							schema: { kind: "named", name: schema }
						})
						if (!outcome.comparison.equal || outcome.comparison.leftDuplicates > 0) {
							return yield* PropertyFailed.make({ report: printOutcome(outcome) })
						}
						const installation = outcome.plan.installation
						if (installation.textDomains.length > 0) {
							k.note("text domain")
						}
						if (
							Arr.some(
								installation.laws.natives,
								(n) => n.object.kind === "ForeignKey" && n.object.deferrable
							)
						) {
							k.note("deferred foreign key")
						}
						if (Arr.some(outcome.left.run.statements, (st) => st.rows.length > 0)) {
							k.note("nonempty")
						}
					})
			)
		})
	)

layer(Substrate.layer)("the conservative lowering against the reference evaluator", (it) => {
	it.effect(
		`agrees on ${cases} generated cases, raw text multisets, with no repeated row`,
		(ctx) => agreeOn(ctx, queryCaseGen(defaultGenConfig), "conservative/generated"),
		1_800_000
	)

	it.effect(
		`agrees on ${cases} generated cases with dense facts`,
		(ctx) => agreeOn(ctx, denseQueryCaseGen(defaultGenConfig), "conservative/dense"),
		1_800_000
	)
})
