import { Array as Arr, Effect, Option } from "effect"
import type { TestContext } from "vitest"
import type { Exhausted, Explored, Run } from "#explore.ts"
import { Run as RunService } from "#explore.ts"
import { runOfTest } from "#vitest/run.ts"

/** How many decimals a risk prints with. */
const RISK_DIGITS = 4

/** The rated features of an exploration, each with how many of its independent cases reached it, after a semicolon. */
const ratesText = (explored: Explored): string =>
	Arr.isReadonlyArrayNonEmpty(explored.rates)
		? `; ${Arr.join(
				Arr.map(explored.rates, (r) => `${r.feature} ${r.cases}/${explored.residual.cases}`),
				", "
			)}`
		: ""

/** The residual line a passing exploration leaves on its test, for the run's residual table, with the steered cases its
 * label-fixed coverage cost and the rate of each feature its coverage rates. */
const residualLine = (explored: Explored) =>
	`${explored.suite}: ${explored.residual.cases} independent cases, ${explored.residual.observed} situations, ${explored.residual.singletons} seen once, risk ${Option.match(explored.residual.risk, { onNone: () => "unknown", onSome: (risk) => risk.toFixed(RISK_DIGITS) })}, ${explored.steered} steered${ratesText(explored)}`

/**
 * Runs a search as a Vitest test: provides this test's run, this process's with the test's deadline, so the search
 * reports what it found before the test's own timeout fails it bare, and leaves the exploration's residual on its test,
 * so the reporter can table every suite's risk, riskiest first. Use it as the body of an `it.effect`:
 * `it.effect("lifecycle", (ctx) => searched(ctx, explore(spec, property)))`. The search may set up what its property
 * needs first, so it fails with its own errors as well as the search's.
 */
export const searched = <A extends Explored | Exhausted, E, R>(
	ctx: TestContext,
	search: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Run>> =>
	search.pipe(
		Effect.tap((result) =>
			result.kind === "explored"
				? Effect.promise(() =>
						ctx.annotate(residualLine(result), "residual", {
							body: Option.match(result.residual.risk, { onNone: () => "0", onSome: String })
						})
					)
				: Effect.void
		),
		Effect.provideServiceEffect(RunService, runOfTest(ctx))
	)
