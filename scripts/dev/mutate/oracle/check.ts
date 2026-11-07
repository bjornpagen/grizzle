import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { type Coverage, noCoverage } from "@grizzle/testing/features"
import type { Gen } from "@grizzle/testing/gen"
import { boundedShrink } from "@grizzle/testing/shrink"
import { Config, Data, Effect, Formatter } from "effect"
import { caseHang } from "#test/support/limits.ts"

/** MUTATE_ORACLE_CASES names no positive case count. */
class NoOracleCases extends Data.TaggedError("NoOracleCases")<{ readonly cases: number }> {
	override get message(): string {
		return `MUTATE_ORACLE_CASES must be a positive integer, not ${this.cases}`
	}
}

/**
 * The oracle subset the mutation tester runs as its second stage (scripts/dev/mutate/main.ts): each `*.test.ts` file
 * here runs a few generated cases of one of the PostgreSQL oracles through firstFailure, and stops at the first
 * disagreement. Only the mutation tester runs them, under its own config (scripts/dev/mutate/vitest.config.ts).
 *
 * The case count per property is MUTATE_ORACLE_CASES, which main.ts sets for every run (--oracle-cases).
 */
export const oracleCases = Effect.runSync(
	Config.Int("MUTATE_ORACLE_CASES").pipe(
		Effect.filterOrFail(
			(cases) => cases > 0,
			(cases) => new NoOracleCases({ cases })
		)
	)
)

/** One exploration: its suite label, its generator, its run count and its property. */
interface Exploration<T, F extends string, E, R> {
	readonly suite: string
	readonly generator: Gen<T>
	readonly runs: number
	readonly property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>
}

/**
 * Runs `property` as an exploration under its own label: the label's floor stream, then `runs` cases of the rotating
 * stream of the run's TEST_SEED (main.ts sets it for every run, so every mutant meets the same cases), and fails on the
 * first failing case without shrinking, because a mutant needs a verdict, not a readable counterexample. It requires
 * no feature and never steers: a mutant's run reaches what the seed draws. A case hangs past the tiers' caseHang.
 */
export const firstFailure = <T, F extends string, E, R>({
	suite,
	generator,
	runs,
	property
}: Exploration<T, F, E, R>) => {
	const none: Coverage<F> = noCoverage
	return explore(
		{
			oracle: { kind: "unstated" },
			suite,
			draw: drawn(generator),
			literal: Formatter.format,
			coverage: none,
			kept: [],
			runs,
			shrink: boundedShrink(0),
			concurrency: 1,
			steerEvery: 16,
			caseHang
		},
		property
	)
}
