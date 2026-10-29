import { Array as Arr, Effect, Equal, Formatter, Option, Record, Result, Schema } from "effect"
import { type ApplyError, TransientFailure } from "#adapter/errors/execution.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import { type TransientReason } from "#compiler/core/errors.ts"
import type { Law, Witness } from "#compiler/public/changeset.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { meets, misses } from "#test/support/schedules/match.ts"
import type { Expectation, Verdict } from "#test/support/schedules/types.ts"

/**
 * What a retried operation reports: the reason of each refused call in order, then the value of the call that
 * answered.
 */
export interface Retried<A> {
	readonly refused: ReadonlyArray<TransientReason["_tag"]>
	readonly answered: A
}

/**
 * The caller's retry bound: a protective cap so an operation refused forever fails instead of looping; every
 * expectation names at most two refusals.
 */
const callerRetries = 5

/**
 * Grizzle operations as schedule steps: the caller's retry of a TransientFailure, as an application retries, and the
 * judges of the typed result.
 *
 * grizzle makes one attempt per call (the round-trip suite, test/pg/adapter/suites/round-trips.ts, holds every public
 * call to one round trip). A judge checks the refusals the caller met against the expectation's Calls, and `applied`
 * the outcome itself, exactly: an accepted outcome's counts for every relation it reports, a refusal's law and
 * witness, compared structurally.
 *
 * Runs `call` as an application does: a TransientFailure is retried by calling again, up to the caller's bound. Any
 * other failure, or a refusal past the bound, is the failure.
 */
export const retried = <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<Retried<A>, E, R> =>
	Effect.gen(function* () {
		const refused: Array<TransientReason["_tag"]> = []
		for (;;) {
			const result = yield* Effect.result(call)
			if (Result.isSuccess(result)) {
				return { refused, answered: result.success }
			}
			const error = result.failure
			if (!Schema.is(TransientFailure)(error) || refused.length === callerRetries) {
				return yield* Effect.fail(error)
			}
			refused.push(error.reason._tag)
		}
	})

/**
 * The refusals an operation's calls must meet: exactly these reasons in order, where the contract names the reason;
 * exactly `count` refusals of whatever reason, where the contract fixes only that the attempt meets concurrent work and
 * fails at once (README, "Transactions and concurrency"); or between `least` and `most` refusals, each among `among`, where which writer
 * PostgreSQL refuses is its own choice.
 */
export type Calls =
	| { readonly _tag: "Exactly"; readonly refused: ReadonlyArray<TransientReason["_tag"]> }
	| { readonly _tag: "Refusals"; readonly count: number }
	| {
			readonly _tag: "Within"
			readonly least: number
			readonly most: number
			readonly among: Arr.NonEmptyReadonlyArray<TransientReason["_tag"]>
	  }

export const exactly = (...refused: ReadonlyArray<TransientReason["_tag"]>): Calls => ({
	_tag: "Exactly",
	refused
})

export const refusals = (count: number): Calls => ({ _tag: "Refusals", count })

export const within = (
	least: number,
	most: number,
	among: Arr.NonEmptyReadonlyArray<TransientReason["_tag"]>
): Calls => ({
	_tag: "Within",
	least,
	most,
	among
})

/** An accepted outcome's counts for one relation. */
interface Counts {
	readonly added: bigint
	readonly deleted: bigint
	readonly put: bigint
}

/**
 * The apply outcome an operation must answer with: accepted with exactly these counts for every relation the outcome
 * reports, no-change, or refused by `law` with exactly this witness.
 */
type Applied =
	| {
			readonly kind: "accepted"
			readonly calls: Calls
			readonly counts: Readonly<Record<string, Counts>>
	  }
	| { readonly kind: "no-change"; readonly calls: Calls }
	| {
			readonly kind: "invariant-rejected"
			readonly calls: Calls
			readonly law: Law
			readonly witness: Witness
	  }

const describeCalls = (calls: Calls): string => {
	switch (calls._tag) {
		case "Exactly":
			return `exactly [${Arr.join(calls.refused, ", ")}]`
		case "Refusals":
			return `exactly ${calls.count} refusals`
		case "Within":
			return `${calls.least} to ${calls.most} refusals among [${Arr.join(calls.among, ", ")}]`
	}
}

const refusedAsCalled = (
	reasons: ReadonlyArray<TransientReason["_tag"]>,
	calls: Calls
): boolean => {
	switch (calls._tag) {
		case "Exactly":
			return Equal.equals(reasons, calls.refused)
		case "Refusals":
			return reasons.length === calls.count
		case "Within":
			return (
				calls.least <= reasons.length &&
				reasons.length <= calls.most &&
				Arr.every(reasons, (reason) => calls.among.includes(reason))
			)
	}
}

/**
 * A judge of a retried operation's result, in order, the first miss winning: it answered; its refusals are `calls`;
 * and `answered` judges the answered value.
 */
const judge =
	<A>(
		calls: Calls,
		answered: (value: A) => (shown: string) => Verdict
	): Expectation<Result.Result<Retried<A>, ApplyError>> =>
	(actual) => {
		const shown = Formatter.format(actual)
		if (Result.isFailure(actual)) {
			return misses(shown, `the operation failed with ${actual.failure._tag}`)
		}
		const reasons = actual.success.refused
		if (!refusedAsCalled(reasons, calls)) {
			return misses(
				shown,
				`the calls were refused by [${Arr.join(reasons, ", ")}], expected ${describeCalls(calls)}`
			)
		}
		return answered(actual.success.answered)(shown)
	}

const sameLaw = (a: Law, b: Law): boolean => Option.isNone(exactValue(a, b))

const outcomeMeets = (want: Applied, value: ApplyOutcome<unknown>, shown: string): Verdict => {
	switch (want.kind) {
		case "accepted": {
			if (value.kind !== "accepted") {
				return misses(shown, `expected accepted, the outcome is ${value.kind}`)
			}
			const counts = Record.fromEntries(
				Arr.map(
					value.counts,
					(c) => [c.relation, { added: c.added, deleted: c.deleted, put: c.put }] as const
				)
			)
			if (!Equal.equals(counts, want.counts)) {
				return misses(shown, `expected exactly the counts ${Formatter.format(want.counts)}`)
			}
			return meets(shown)
		}
		case "no-change":
			return value.kind === "no-change"
				? meets(shown)
				: misses(shown, `expected no-change, the outcome is ${value.kind}`)
		case "invariant-rejected": {
			if (value.kind !== "invariant-rejected") {
				return misses(
					shown,
					`expected invariant-rejected by ${Formatter.format(want.law)}, the outcome is ${value.kind}`
				)
			}
			if (!sameLaw(value.law, want.law)) {
				return misses(shown, `expected invariant-rejected by ${Formatter.format(want.law)}`)
			}
			if (!Equal.equals(value.witness, want.witness)) {
				return misses(shown, `expected exactly the witness ${Formatter.format(want.witness)}`)
			}
			return meets(shown)
		}
	}
}

/** The judge of a retried db.apply. */
export const applied = (
	want: Applied
): Expectation<Result.Result<Retried<ApplyOutcome<unknown>>, ApplyError>> =>
	judge(want.calls, (value) => (shown) => outcomeMeets(want, value, shown))

/** The judge of a retried db.refresh, which answers nothing. */
export const refreshed = (calls: Calls): Expectation<Result.Result<Retried<void>, ApplyError>> =>
	judge(calls, () => meets)
