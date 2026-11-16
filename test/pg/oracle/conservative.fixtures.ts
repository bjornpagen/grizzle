import type { Gen } from "@bjornpagen/testing/gen"
import type { Budget, Case, Kill } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { type ConservativeFeature, caseFeatures, operatorKinds } from "#test/pg/oracle/support.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import {
	conservative,
	defaultRunOptions,
	oracleProperty,
	printOutcome,
	PropertyFailed,
	reference,
	runOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

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
 * The conservative lowering against the reference evaluator over `gen`'s cases, each in its own database under its
 * own schema, under a plan perturbation (runner.ts oracleProperty), with `kills`.
 */
export const conservativeAgreement = (
	gen: Gen<QueryCase>,
	kills: ReadonlyArray<Kill>,
	budget: Budget
) =>
	oracleProperty(gen, {
		situations,
		perturb: "all",
		oracle: { kind: "second-implementation", name: "the brute-force reference evaluator" },
		kept: [],
		kills,
		budget,
		show: Formatter.format,
		check: (k: Case<ConservativeFeature>) => (c) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema({ create: false, label: "oracle" })
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
	})
