/**
 * The conservative lowering against the brute-force reference evaluator on PostgreSQL 19.
 *
 * 2,000 generated cases of the generator's own population, and 2,000 more with denser facts so that fewer results are
 * empty, in the run's rotating stream (and a quarter as many in the suite's floor stream), each case under a plan
 * perturbation: one to four relations with composite and candidate keys, closed rosters, pure sets and
 * containments, small-domain facts including NaN, -0, numeric display scales and supplementary-plane text in their
 * stored spellings, and queries over match, filter, project, semi- and anti-join, union, intersection, difference,
 * group, take, attach and recursion, at the root as a plain set, with attachments, or as a heterogeneous union. For
 * every case, every statement the conservative lowering emits returns exactly the canonical cell set the
 * reference evaluator computes by definition: the same rows, each once, since every statement delivers a set. And the
 * runner judges the case against itself (runner.ts runOracle, its second reading): its facts stored otherwise, another
 * storage order and one value in another spelling, under another plan, must deliver exactly the same rows, with no
 * reference in the judgment. A failing case shrinks and is reported in printable form.
 */
import { layer } from "@effect/vitest"
import { drawn } from "@grizzle/testing/explore"
import { rating, required } from "@grizzle/testing/features"
import type { Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { TestContext } from "vitest"
import {
	type ConservativeFeature,
	caseFeatures,
	declineFeatures,
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
const situations = [
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
	"nonempty",
	"facts reordered",
	"a fact respelled"
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
					coverage: rating(
						required<ConservativeFeature>(situations, { cases: cases, sense: notesOnly }),
						declineFeatures
					),
					kept: [],
					runs: cases,
					shrink: completeShrink,
					perturb: "all"
				},
				(c, k) =>
					Effect.gen(function* () {
						k.noteAll(caseFeatures(c))
						const options = {
							...defaultRunOptions,
							schema: { kind: "named", name: schema }
						} as const
						const outcome = yield* runOracle(c, conservative, reference, options)
						if (!outcome.comparison.equal) {
							return yield* new PropertyFailed({ report: printOutcome(outcome) })
						}
						if (outcome.right.kind === "reference") {
							k.noteAll(Arr.map(outcome.right.declines, (reason) => `declined ${reason}` as const))
						}
						if (outcome.again.reordered) {
							k.note("facts reordered")
						}
						if (outcome.again.respelled) {
							k.note("a fact respelled")
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
	it.effect(`agrees on ${cases} generated cases, raw text sets, with no repeated row`, (ctx) =>
		agreeOn(ctx, queryCaseGen(defaultGenConfig), "conservative/generated")
	)

	it.effect(`agrees on ${cases} generated cases with dense facts`, (ctx) =>
		agreeOn(ctx, denseQueryCaseGen(defaultGenConfig), "conservative/dense")
	)
})
