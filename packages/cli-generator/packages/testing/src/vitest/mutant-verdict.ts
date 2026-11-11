import { type Duration, Effect, Option, type Scope } from "effect"

/** What a mutant's run says of it: killed by its first failing test, or survived by every test. */
export type RunVerdict = Readonly<{ kind: "killed"; by: string }> | Readonly<{ kind: "survived" }>

/** A run's verdict, or a timeout when the run was still going at its deadline. */
export type TimedVerdict = RunVerdict | Readonly<{ kind: "timeout" }>

/**
 * A mutant's suite, open for the enclosing scope: its run, whose outcome is the verdict. Closing the scope is the
 * suite's release, which stops what the run started.
 */
export type OpenSuite<E> = Effect.Effect<Effect.Effect<RunVerdict, E>, E, Scope.Scope>

/**
 * The verdict of a suite whose run must end by `deadline`: the run's own outcome, or a timeout when the run is still
 * going then. Only the run is timed: the release starts once the verdict is in and never decides it, so workers slow to
 * stop never turn a killed or surviving mutant into a timeout.
 */
export const verdictWithin = <E>(
	suite: OpenSuite<E>,
	deadline: Duration.Duration
): Effect.Effect<TimedVerdict, E> =>
	Effect.scoped(
		Effect.flatMap(suite, (run) =>
			Effect.map(Effect.timeoutOption(run, deadline), (ran) =>
				Option.getOrElse(ran, (): TimedVerdict => ({ kind: "timeout" }))
			)
		)
	)

/** A suite's run and how long it took: the release follows the timing and is never part of it. */
export const timedRun = <E>(
	suite: OpenSuite<E>
): Effect.Effect<[Duration.Duration, RunVerdict], E> =>
	Effect.scoped(Effect.flatMap(suite, (run) => Effect.timed(run)))
