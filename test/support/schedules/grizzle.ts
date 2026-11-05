import { Array as Arr, Effect, Equal, Formatter, Option, Record, Result } from "effect"
import type { ApplyError, TransientFailure } from "#adapter/errors/execution.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import { maxOf } from "#compiler/core/array.ts"
import { type TransientReason } from "#compiler/core/errors.ts"
import type { Law, Witness } from "#compiler/public/changeset.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { op } from "#test/support/schedules/build.ts"
import { firstMet, meets, misses } from "#test/support/schedules/match.ts"
import type { Expectation, Step, Verdict, Wait } from "#test/support/schedules/types.ts"

/**
 * What a retried operation reports: the reason of each refused call in order, then the value of the call that
 * answered.
 */
export interface Retried<A> {
	readonly refused: ReadonlyArray<TransientReason["_tag"]>
	readonly answered: A
}

/**
 * Grizzle operations as schedule steps: the caller's retry of a TransientFailure, as an application retries, and the
 * judges of the typed result.
 *
 * grizzle makes one attempt per call (the round-trip suite, test/pg/adapter/suites/round-trips.ts, holds every public
 * call to one round trip). A judge checks the refusals the caller met against the expectation's Calls, and `applied`
 * the outcome itself, exactly: an accepted outcome's counts for every relation it reports, a refusal's law and
 * witness, compared structurally.
 *
 * Every refusal is a concurrent transaction's (PostgreSQL 19rc1's src/backend/storage/lmgr/README-SSI: "no transaction
 * is canceled until one of the other transactions in the set of conflicts which could generate an anomaly has
 * successfully committed"), and no count of them is PostgreSQL's: while one commits, every attempt that reads its
 * writes is refused until the commit is visible to a new snapshot, however many (test/schedules/platform/support.ts
 * runGrizzle). So the retries are bounded by what judges them, never by a count of their own: a scripted step's
 * expectation names the most refusals it admits, and past them no answer could meet it (retriedOp); a write a model
 * judges admits any number, and is retried until it answers (untilAnswered), which it does once the schedule's other
 * transactions have ended, a write that never answers being its case's hang (caseHang).
 *
 * Runs `call` again after each TransientFailure, at most `most` times. Any other failure, or a refusal past them, is
 * the failure.
 */
const retried = <A, R>(
	call: Effect.Effect<A, ApplyError, R>,
	most: number
): Effect.Effect<Retried<A>, ApplyError, R> =>
	Effect.gen(function* () {
		const refused: Array<TransientReason["_tag"]> = []
		for (;;) {
			const result = yield* Effect.result(call)
			if (Result.isSuccess(result)) {
				return { refused, answered: result.success }
			}
			const error = result.failure
			if (error._tag !== "TransientFailure" || refused.length === most) {
				return yield* Effect.fail(error)
			}
			refused.push(error.reason._tag)
		}
	})

/**
 * Runs `call` again after each TransientFailure until a call answers: the retry of a write a model judges (see
 * retried). Any other failure is the failure, so none is a refusal.
 */
export const untilAnswered = <A, R>(
	call: Effect.Effect<A, ApplyError, R>
): Effect.Effect<Retried<A>, Exclude<ApplyError, TransientFailure>, R> =>
	Effect.gen(function* () {
		const refused: Array<TransientReason["_tag"]> = []
		for (;;) {
			const result = yield* Effect.result(call)
			if (Result.isSuccess(result)) {
				return { refused, answered: result.success }
			}
			const error = result.failure
			if (error._tag !== "TransientFailure") {
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

/** The most refusals `calls` admits: past them no answer meets it. */
const mostRefused = (calls: Calls): number => {
	switch (calls._tag) {
		case "Exactly":
			return calls.refused.length
		case "Refusals":
			return calls.count
		case "Within":
			return calls.most
	}
}

/**
 * What a scripted step's retried operation must produce: the most refusals its expectation admits, which bound the
 * caller's retries (see retried), and the expectation of the retried result.
 */
export interface RetriedJudge<A> {
	readonly most: number
	readonly expect: Expectation<Result.Result<Retried<A>, ApplyError>>
}

/**
 * A judge of a retried operation's result, in order, the first miss winning: it answered; its refusals are `calls`;
 * and `answered` judges the answered value.
 */
const judge = <A>(
	calls: Calls,
	answered: (value: A) => (shown: string) => Verdict
): RetriedJudge<A> => ({
	most: mostRefused(calls),
	expect: (actual) => {
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
})

/**
 * The first of `judges` the result meets, as anyOf judges; the caller's retries are bounded by the most refusals any
 * of them admits.
 */
export const anyRetried = <A>(
	...judges: Arr.NonEmptyReadonlyArray<RetriedJudge<A>>
): RetriedJudge<A> => ({
	most: maxOf(
		Arr.map(judges, (j) => j.most),
		0
	),
	expect: firstMet(Arr.map(judges, (j) => j.expect))
})

/**
 * A grizzle operation of a scripted schedule, run on behalf of `session` as an application runs it: called again after
 * each TransientFailure, at most as many times as `expected` admits refusals, and its result judged by it.
 */
export const retriedOp = <G extends string, A, W extends string>(
	session: G,
	name: string,
	call: Effect.Effect<A, ApplyError>,
	expected: RetriedJudge<NoInfer<A>>,
	wait: Wait<W>
): Step<never, G, W> => op(session, name, retried(call, expected.most), expected.expect, wait)

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
export const applied = (want: Applied): RetriedJudge<ApplyOutcome<unknown>> =>
	judge(want.calls, (value) => (shown) => outcomeMeets(want, value, shown))

/** The judge of a retried db.refresh, which answers nothing. */
export const refreshed = (calls: Calls): RetriedJudge<void> => judge(calls, () => meets)
