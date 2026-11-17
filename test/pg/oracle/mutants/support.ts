import type { Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { mutantLowering, mutationSites } from "#test/support/oracle/mutants/index.ts"
import type { Mutant } from "#test/support/oracle/mutants/mutants.ts"
import {
	comparisonFailed,
	conservative,
	killSearched,
	printOracleCase,
	reference,
	runOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"

/** What a mutant's population reaches against the conservative lowering: a case the mutant rewrote, and one whose conservative run delivered a row. */
type MutantFeature = "mutation applied" | "nonempty"

/**
 * The rotating stream's cases of a kill population, whose floor, a quarter of them, is its first witnesses, and the
 * steered cases it may run while a situation is unreached: the old kill searches' `within` (support.ts at 4fbc3e95),
 * whose floor and steered phase were the kill population.
 */
const within = 500

/**
 * Running one mutant against the conservative lowering on generated cases.
 *
 * A case on which the mutant makes no rewrite runs an identical program, so it cannot tell the mutant from the
 * conservative lowering and is not run; every drawn case counts toward the kill population, the stricter reading.
 * Every run executes both programs on PostgreSQL and compares their raw text sets. An invalid mutant is killed by
 * the first witness on which some set differs, or on which the two agree but the mutant's own second reading
 * delivers otherwise than its first (runner.ts InvarianceFailed of the right side), and the kill search keeps the
 * shrunk case's verdict so the property can judge the kill's shape. A harness failure (a lowering refused, a rewrite
 * that does not emit, a statement that does not run, the conservative lowering's own second reading delivering
 * otherwise) is never a kill and never a skip: it is recorded with the printed case and fails the property, shrinking
 * included.
 *
 * One mutant's kill population, searched as `id` (runner.ts killSearched) on the case's own substrate under one schema
 * name: its kill search's result (the shrunk kill's outcome has the conservative run on the left, the mutant's on the
 * right) and the harness failures it recorded.
 */
export const runMutant = (mutant: Mutant, gen: Gen<QueryCase>, id: string) =>
	Effect.gen(function* () {
		const seat = yield* OracleSeat
		const schema = yield* seat.schema("mutant")
		const lowering = mutantLowering(mutant)
		const harnessErrors: Array<string> = []
		/** Unperturbed, as the kill populations always ran: a kill's listed shape rests on the facts as drawn. */
		const result = yield* killSearched(
			id,
			gen,
			{
				situations: ["mutation applied", "nonempty"] satisfies ReadonlyArray<MutantFeature>,
				budget: { runs: within, steered: within },
				oracle: {
					kind: "second-implementation",
					name: "the conservative lowering, whose raw text sets the mutant must break"
				},
				show: printOracleCase
			},
			(k) => (c) =>
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

/**
 * The I1 mutant against the brute-force reference evaluator on its population, searched as `id`, unperturbed, the
 * mutant the left side and the reference the right (the order of the two is no contract): its kill search's result and
 * the harness failures it recorded (a statement that does not run, an oracle failure).
 */
export const runAgainstReference = (mutant: Mutant, gen: Gen<QueryCase>, id: string) =>
	Effect.gen(function* () {
		const seat = yield* OracleSeat
		const name = yield* seat.schema("oracle")
		const lowering = mutantLowering(mutant)
		const harnessErrors: Array<string> = []
		const result = yield* killSearched(
			id,
			gen,
			{
				situations: [],
				/** The old reference suite's kill population: runs 500, no coverage (reference.test.ts at 4fbc3e95). */
				budget: { runs: within, steered: 0 },
				oracle: {
					kind: "second-implementation",
					name: "the brute-force reference evaluator, which the I1 mutant must break"
				},
				show: printOracleCase
			},
			() => (c) =>
				Effect.gen(function* () {
					const harnessFailure = (e: unknown) =>
						Effect.sync(() => {
							harnessErrors.push(`${String(e)}\n${printOracleCase(c)}`)
						})
					const outcome = yield* runOracle(c, lowering, reference, {
						schema: { kind: "named", name }
					}).pipe(Effect.catchTags({ OracleFailure: harnessFailure, SqlError: harnessFailure }))
					if (outcome !== undefined && !outcome.comparison.equal) {
						return yield* comparisonFailed(outcome)
					}
				})
		)
		return { result, harnessErrors }
	}).pipe(Effect.scoped)
