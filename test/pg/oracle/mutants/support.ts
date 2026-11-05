import { drawn } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import type { Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { Array as Arr, Effect, Formatter } from "effect"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { mutantLowering, mutationSites } from "#test/support/oracle/mutants/index.ts"
import type { Mutant } from "#test/support/oracle/mutants/mutants.ts"
import {
	comparisonFailed,
	conservative,
	oracleKill,
	printOracleCase,
	runOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** What a mutant's population reaches: a case the mutant rewrote, and one whose conservative run delivered a row. */
type MutantFeature = "mutation applied" | "nonempty"

/**
 * The cases of a kill population's rotating stream, which runs a quarter as many on its floor. The floor and the
 * steered phase are the kill population: the suite's label fixes both, so a mutant is killed on every run seed or on
 * none, and a kill only the rotating stream finds is unwitnessed.
 */
const within = 500

/**
 * Running one mutant against the conservative lowering on generated cases.
 *
 * A case on which the mutant makes no rewrite runs an identical program, so it cannot tell the mutant from the
 * conservative lowering and is not run; every drawn case counts toward the kill population, the stricter reading.
 * Every run executes both programs on PostgreSQL and compares their raw text multisets. An invalid mutant is killed by
 * the first case on which some multiset differs, or on which the two agree but the mutant's own second reading
 * delivers otherwise than its first (runner.ts InvarianceFailed of the right side), and the kill search keeps the
 * shrunk case's verdict so the suite can judge the kill's shape. A harness failure (a lowering refused, a rewrite that
 * does not emit, a statement that does not run, the conservative lowering's own second reading delivering otherwise)
 * is never a kill and never a skip: it is recorded with the printed case and fails the suite, shrinking included.
 *
 * One mutant's kill population, explored as the named suite `suite`: its kill search's result (the shrunk kill's
 * outcome has the conservative run on the left, the mutant's on the right) and the harness failures it recorded.
 */
export const runMutant = (mutant: Mutant, gen: Gen<QueryCase>, suite: string) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label: "mutant" })
		const lowering = mutantLowering(mutant)
		const harnessErrors: Array<string> = []
		/** Unperturbed, as the kill populations always ran: a kill's listed shape rests on the facts as drawn. */
		const result = yield* oracleKill(
			drawn(gen),
			{
				suite,
				literal: Formatter.format,
				coverage: required<MutantFeature>(["mutation applied", "nonempty"], {
					cases: within,
					sense: notesOnly
				}),
				kept: [],
				runs: within,
				shrink: completeShrink,
				perturb: "none"
			},
			(c, k) =>
				Effect.gen(function* () {
					const m = mutationSites(mutant, c)
					if (m.kind === "refused") {
						harnessErrors.push(
							`mutant ${mutant.id} refused at ${m.stage}: ${m.message}\n${printOracleCase(c)}`
						)
						return
					}
					if (m.sites === 0) {
						return
					}
					k.note("mutation applied")
					const harnessFailure = (e: unknown) =>
						Effect.sync(() => {
							harnessErrors.push(`${String(e)}\n${printOracleCase(c)}`)
						})
					const outcome = yield* runOracle(c, conservative, lowering, {
						schema: { kind: "named", name: schema }
					}).pipe(
						Effect.catchTags({ OracleFailure: harnessFailure, SqlError: harnessFailure }),
						Effect.catchIf((verdict) => verdict.role === "left", harnessFailure)
					)
					if (outcome === undefined) {
						return
					}
					if (Arr.some(outcome.left.run.statements, (st) => st.rows.length > 0)) {
						k.note("nonempty")
					}
					if (!outcome.comparison.equal) {
						return yield* comparisonFailed(outcome)
					}
				})
		)
		return { result, harnessErrors }
	}).pipe(Effect.scoped)
