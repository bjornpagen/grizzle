import { Array as Arr, Effect, Option } from "effect"
import type { TestContext } from "vitest"
import type { Exhausted, Explored, Run } from "#explore.ts"
import { Run as RunService } from "#explore.ts"
import type { Reach } from "#features.ts"
import { runOfProcess } from "#vitest/run.ts"

/** How many decimals a risk or a miss prints with: a requirement whose miss prints as zero is left off the reach table. */
const RISK_DIGITS = 4

/** The residual line a passing exploration leaves on its test, for the run's residual table. */
const residualLine = (explored: Explored) =>
	`${explored.suite}: ${explored.residual.cases} independent cases, ${explored.residual.observed} situations, ${explored.residual.singletons} seen once, risk ${Option.match(explored.residual.risk, { onNone: () => "unknown", onSome: (risk) => risk.toFixed(RISK_DIGITS) })}`

/** The reach line of one requirement a fresh seed might miss, for the run's reach table. */
const reachLine = (explored: Explored, reach: Reach) =>
	`${explored.suite}: ${reach.requirement}: ${reach.independent} of ${explored.residual.cases} independent cases, ${reach.floor} floor, ${reach.steered} steered, miss ${reach.miss.toFixed(RISK_DIGITS)}`

/** The requirements of an exploration whose estimated miss shows at the printed precision. */
const atRisk = (explored: Explored): ReadonlyArray<Reach> =>
	Arr.filter(explored.reach, (reach) => Number(reach.miss.toFixed(RISK_DIGITS)) > 0)

/**
 * Runs a search as a Vitest test: provides this process's run, and leaves the exploration's residual and the reach of
 * every requirement a fresh seed might miss on its test, so the reporter can table every suite's risk and every such
 * requirement, likeliest first. Use it as the body of an `it.effect`:
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
				? Effect.andThen(
						Effect.promise(() =>
							ctx.annotate(residualLine(result), "residual", {
								body: Option.match(result.residual.risk, { onNone: () => "0", onSome: String })
							})
						),
						Effect.forEach(
							atRisk(result),
							(reach) =>
								Effect.promise(() =>
									ctx.annotate(reachLine(result, reach), "reach", { body: String(reach.miss) })
								),
							{ discard: true }
						)
					)
				: Effect.void
		),
		Effect.provideServiceEffect(RunService, runOfProcess)
	)
