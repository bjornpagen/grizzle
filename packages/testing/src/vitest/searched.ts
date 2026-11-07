import { Array as Arr, Effect, Option } from "effect"
import type { TestContext } from "vitest"
import type { Box, Exhausted, Explored, Oracle, Run } from "#explore.ts"
import { Run as RunService } from "#explore.ts"
import { RISK_BOUND_MISS, type Residual } from "#features.ts"
import { EXHAUSTED, ORACLE, RESIDUAL } from "#vitest/reporter.ts"
import { runOfTest } from "#vitest/run.ts"

/** How many decimals a risk prints with. */
const RISK_DIGITS = 4

/** How many decimals Chao1's estimate of the unseen situations prints with. */
const UNSEEN_DIGITS = 1

/** A search's oracle as its report line prints it, and its absence named, so a suite that states none shows. */
const oracleText = (oracle: Oracle): string => {
	switch (oracle.kind) {
		case "unstated":
			return "oracle not stated"
		case "second-implementation":
		case "specification":
		case "universal":
		case "postgresql":
			return `oracle: ${oracle.kind}, ${oracle.name}`
	}
}

/** An exhaustion's box as its report line prints it, and its absence named. */
const boxText = (box: Box): string => (typeof box === "string" ? box : "a box not stated")

/** The rated features of an exploration, each with how many of its independent cases reached it, after a semicolon. */
const ratesText = (explored: Explored): string =>
	Arr.isReadonlyArrayNonEmpty(explored.rates)
		? `; ${Arr.join(
				Arr.map(explored.rates, (r) => `${r.feature} ${r.cases}/${explored.residual.cases}`),
				", "
			)}`
		: ""

/** The run of cases a residual's bound rests on, as its line prints it. */
const runText = (sinceNew: number): string =>
	sinceNew === 0
		? "its last case reached a new situation"
		: sinceNew === 1
			? "none new in its last case"
			: `none new in its last ${sinceNew} cases`

/**
 * A residual's risk as its line prints it: unknown, and why, or Good–Turing's estimate beside its bound, the confidence
 * the bound holds at, and the run of cases it rests on.
 */
const riskText = (residual: Residual): string => {
	switch (residual.risk.kind) {
		case "unknown":
			return residual.risk.why === "no-cases"
				? "risk unknown: no independent case ran"
				: "risk unknown: no case noted a situation"
		case "estimated":
			return `risk ${residual.risk.estimate.toFixed(RISK_DIGITS)}, at most ${residual.risk.bound.toFixed(RISK_DIGITS)} at ${Math.round((1 - RISK_BOUND_MISS) * 100)}% (${runText(residual.sinceNew)}), unseen ${Option.match(residual.unseen, { onNone: () => "unknown", onSome: (unseen) => `about ${unseen.toFixed(UNSEEN_DIGITS)}` })}`
	}
}

/**
 * How the residual table orders a residual, riskiest first: by its bound, and an unknown risk before every bound, so a
 * search that measured nothing heads the table.
 */
const riskOrderOf = (residual: Residual): number =>
	residual.risk.kind === "unknown" ? Number.POSITIVE_INFINITY : residual.risk.bound

/**
 * The residual line a passing exploration leaves on its test, for the run's residual table: its independent cases,
 * the situations they reached, those seen once, and its risk (riskText), each a property of the generator and its
 * features, never of the program; the steered cases its label-fixed coverage cost; the rate of each feature its
 * coverage rates; and its oracle.
 */
const residualLine = (explored: Explored) =>
	`${explored.suite}: ${explored.residual.cases} independent cases, ${explored.residual.observed} situations, ${explored.residual.singletons} seen once, ${riskText(explored.residual)}, ${explored.steered} steered${ratesText(explored)}; ${oracleText(explored.oracle)}`

/** The line a passing exhaustion leaves on its test: a proof inside its box, its cases and the limit, and its oracle. */
const exhaustedLine = (exhausted: Exhausted) =>
	`${exhausted.suite}: a proof inside ${boxText(exhausted.box)}, ${exhausted.cases} cases within a limit of ${exhausted.limit}; ${oracleText(exhausted.oracle)}`

/** The annotation a passing search leaves on its test: an exploration's residual, or an exhaustion's proof. */
const annotationOf = (
	result: Explored | Exhausted
): Readonly<{ message: string; type: string; body: string }> => {
	switch (result.kind) {
		case "explored":
			return {
				message: residualLine(result),
				type: RESIDUAL,
				body: String(riskOrderOf(result.residual))
			}
		case "exhausted":
			return { message: exhaustedLine(result), type: EXHAUSTED, body: String(result.cases) }
	}
}

/**
 * Runs a search as a Vitest test: provides this test's run, this process's with the test's deadline, so the search
 * reports what it found before the test's own timeout fails it bare, and leaves its result on its test, an
 * exploration's residual and an exhaustion's proof, so the reporter can table every suite, riskiest first. Use it as
 * the body of an `it.effect`: `it.effect("lifecycle", (ctx) => searched(ctx, explore(spec, property)))`. The search
 * may set up what its property needs first, so it fails with its own errors as well as the search's.
 */
export const searched = <A extends Explored | Exhausted, E, R>(
	ctx: TestContext,
	search: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Run>> =>
	search.pipe(
		Effect.tap((result) => {
			const { message, type, body } = annotationOf(result)
			return Effect.andThen(
				Effect.promise(() => ctx.annotate(message, type, { body })),
				Effect.promise(() => ctx.annotate(result.suite, ORACLE, { body: result.oracle.kind }))
			)
		}),
		Effect.provideServiceEffect(RunService, runOfTest(ctx))
	)
