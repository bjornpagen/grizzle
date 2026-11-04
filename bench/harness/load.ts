import { Array as Arr, Duration, Effect, Fiber, Record as Rec, Schedule } from "effect"
import type { TransientReason } from "#adapter/errors/failures.ts"
import { transientFailureOf } from "#adapter/outcomes/index.ts"
import { elapsed, type Summary, summarize } from "#bench/cold/stats.ts"
import {
	type FailedOutcome,
	type Outcome,
	type OutcomeKey,
	outcomeKey
} from "#bench/harness/outcome.ts"
import type { Observed } from "#bench/harness/phases.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { UniqueAbort } from "#compiler/write/program/artifact.ts"
import type { SqlError } from "#test/support/pg.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"

/**
 * Concurrent load for the contention gates: lock waits, deadlock rate and transient failure rate by reason under
 * contention on one row; the queue claim's throughput, tail latency and transient failure rate by reason; and
 * the lock-wait time and throughput of one hot group (R19, R23).
 *
 * A load is a set of workers, each holding its own session, running one operation after another: a fixed number each,
 * or until a deadline. Every operation reports its outcome and the attempts it discarded; the load reports
 * throughput, latency, outcomes and retries by reason. grizzle makes one attempt per call and never retries, so the
 * harness retries as an application does (`withRetries`): Effect.retry with its own Schedule (`retryPolicy`, a few
 * retries with exponential backoff), while the attempt ended in a transient failure. A hand-written baseline and a
 * grizzle writer retry alike:
 * - a grizzle attempt is transient when it failed with TransientFailure, whose reason it reports;
 * - a hand-written attempt is transient when its SQLSTATE and constraint are one grizzle's own classification reads
 *   as a TransientFailure (packages/grizzle/src/adapter/outcomes transientFailureOf): 40001, 40P01, and a unique violation at a
 *   statement on a constraint the operation names in `uniqueAborts`.
 * Any other failure ends the operation, and so does the last attempt the policy allows; the last outcome stands,
 * never an error, because a load tallies outcomes. Each discarded attempt is kept whole (its reason and, when the
 * server raised one, where it failed, at which statement, its SQLSTATE and constraint) with, when the gate supplies a
 * classifier, the gate's own label for it, so a gate can split retries the SQLSTATE does not tell apart (the queue's
 * item collision against seat collision, both 40001).
 *
 * Lock waits are sampled from pg_stat_activity on an observer session while the load runs: each sample counts the
 * workers' backends whose wait event type is Lock. Sampling is an estimate; lockWaitSessionMs is the sum over samples
 * of waiting backends times the interval, the session-time spent waiting on locks to within the sampling interval.
 * Sampling sleeps between readings on the ambient clock, so a load with a sampler runs on the live clock.
 *
 * One attempt an operation discarded and retried: what refused it, its first wire failure when the server raised one (a
 * reason read from a grizzle statement's rows has none), and the gate's label for it when the gate classifies retries.
 */
export interface DiscardedAttempt {
	readonly reason: TransientReason["_tag"]
	readonly failed: FailedOutcome | undefined
	readonly label: string | undefined
}

/**
 * One attempt as the harness sees it: how it ended, and, when it ended in a transient failure, the attempt the harness
 * discards to retry it.
 */
export interface Attempted {
	readonly outcome: Outcome
	readonly transient: DiscardedAttempt | undefined
}

export interface OperationResult {
	readonly outcome: Outcome
	/** Attempts made, the final one included. */
	readonly attempts: number
	/** Every discarded attempt, in order. */
	readonly retries: ReadonlyArray<DiscardedAttempt>
}

/**
 * A caller-side retry policy: at most `times` retries after the first attempt, while the attempt is transient, spaced
 * by `schedule`.
 */
export interface RetryPolicy {
	readonly times: number
	readonly schedule: Schedule.Schedule<unknown>
}

/**
 * The harness's own policy: four retries with exponential backoff from 5 milliseconds. It is the harness's, as an
 * application's would be its own.
 */
export const retryPolicy: RetryPolicy = {
	times: 4,
	schedule: Schedule.exponential(Duration.millis(5))
}

export interface RetryOptions {
	/** The unique violations that are transient at the statement that raised them, by constraint. */
	readonly uniqueAborts: ReadonlyArray<UniqueAbort>
	/** The gate's label for a discarded attempt, tallied beside its reason; undefined leaves it unlabelled. */
	readonly label: (failed: FailedOutcome) => string | undefined
}

/**
 * The transient reason of a hand-written attempt's failed outcome, by grizzle's own classification, or undefined when
 * it is none. A unique violation is transient only at the statement that raised it, as in the runtime.
 */
export const outcomeTransientReason = (
	failed: FailedOutcome,
	uniqueAborts: ReadonlyArray<UniqueAbort>
): TransientReason | undefined =>
	transientFailureOf(
		serverError({
			...nothingReported,
			sqlstate: failed.sqlstate,
			constraint: failed.constraint.kind === "named" ? failed.constraint.name : undefined
		}),
		failed.at === "statement" ? uniqueAborts : []
	)?.reason

/** A hand-written attempt's outcome as the harness sees it (see the head of this file). */
export const sqlAttempted = (outcome: Outcome, options: RetryOptions): Attempted => {
	if (outcome.kind !== "failed") {
		return { outcome, transient: undefined }
	}
	const reason = outcomeTransientReason(outcome, options.uniqueAborts)
	return {
		outcome,
		transient:
			reason === undefined
				? undefined
				: { reason: reason._tag, failed: outcome, label: options.label(outcome) }
	}
}

/**
 * What a retried operation did: the attempt that ended it (the last one the policy allows when every attempt was
 * transient), how many attempts it made, and the ones it discarded, in order.
 */
interface Retried<A> {
	readonly last: A
	readonly attempts: number
	readonly retries: ReadonlyArray<DiscardedAttempt>
}

/**
 * Runs `attempt` (given its 1-based number) under a caller-side retry (see the head of this file), while `transientOf`
 * reads the attempt as transient.
 */
export const retried = Effect.fn("retried")(function* <A, E, R>(
	attempt: (n: number) => Effect.Effect<A, E, R>,
	transientOf: (value: A) => DiscardedAttempt | undefined,
	policy: RetryPolicy
): Effect.fn.Return<Retried<A>, E, R> {
	const discarded: Array<DiscardedAttempt> = []
	let n = 0
	const once = Effect.tap(
		Effect.suspend(() => attempt(++n)),
		(value) =>
			Effect.sync(() => {
				const transient = transientOf(value)
				if (transient !== undefined) {
					discarded.push(transient)
				}
			})
	)
	const last = yield* Effect.repeat(once, {
		times: policy.times,
		schedule: policy.schedule,
		while: (value: A) => transientOf(value) !== undefined
	})
	if (transientOf(last) !== undefined) {
		discarded.pop()
	}
	const run: Retried<A> = { last, attempts: n, retries: discarded }
	return run
})

/** `retried` over attempts as the load reads them. */
export const withRetries = <E, R>(
	attempt: (n: number) => Effect.Effect<Attempted, E, R>,
	policy: RetryPolicy
): Effect.Effect<OperationResult, E, R> =>
	Effect.map(
		retried(attempt, (a) => a.transient, policy),
		(r) => ({
			outcome: r.last.outcome,
			attempts: r.attempts,
			retries: r.retries
		})
	)

export interface LockWaitSampler {
	readonly observer: BenchSession
	/** The workers' backend pids. */
	readonly pids: ReadonlyArray<number>
	readonly intervalMs: number
	/**
	 * Called with each sample's count of waiting workers as it is taken, before the next interval (a barrier for tests and
	 * gates that need a sample taken in a known state; Effect.void for none).
	 */
	readonly onSample: (waiting: number) => Effect.Effect<void>
}

export interface LockWaitSamples {
	readonly samples: number
	readonly intervalMs: number
	readonly waiting: Summary
	readonly lockWaitSessionMs: number
}

/**
 * How long a load runs: a number of operations per worker, or a wall-clock budget for the whole load, within which
 * every worker runs at least one operation.
 */
export type LoadBound =
	| { readonly kind: "operations"; readonly n: number }
	| { readonly kind: "deadline"; readonly ms: number }

export interface LoadOptions {
	readonly bound: LoadBound
	readonly sampler: { readonly kind: "none" } | ({ readonly kind: "sampled" } & LockWaitSampler)
}

export interface LoadMeasure {
	readonly workers: number
	readonly operations: number
	readonly wallMs: number
	readonly operationsPerSecond: number
	readonly committedPerSecond: number
	readonly latencyMs: Summary
	/** Over the operations that committed, when any did. */
	readonly committedLatencyMs: Observed<Summary>
	/** Final outcomes: `committed`, `rolledBack`, or a failure's cause. */
	readonly outcomes: Readonly<Partial<Record<OutcomeKey, number>>>
	readonly attempts: Summary
	readonly retries: {
		readonly total: number
		/** Discarded attempts per operation. */
		readonly perOperation: number
		/** By the TransientFailure reason. */
		readonly byReason: Readonly<Partial<Record<TransientReason["_tag"], number>>>
		/** By SQLSTATE, for the attempts the server refused. */
		readonly bySqlstate: Readonly<Record<string, number>>
		/** By the gate's label, for the attempts it labelled. */
		readonly byLabel: Readonly<Record<string, number>>
	}
	/** When the load had a sampler and it took a sample. */
	readonly lockWaits: Observed<LockWaitSamples>
}

/**
 * Whether every attempt of a load committed or was refused as a serialization failure or a deadlock, the last attempt
 * of an operation whose retries ran out included: what the hot-group gates check of each grizzle attempt.
 */
export const committedOrConflicted = (load: LoadMeasure): boolean =>
	Arr.every(
		Rec.keys<string, number>(load.outcomes),
		(k) => k === "committed" || k === "serialization" || k === "deadlock"
	) &&
	Arr.every(
		Rec.keys<string, number>(load.retries.byReason),
		(r) => r === "SerializationFailure" || r === "Deadlock"
	)

const sampleOnce = (sampler: LockWaitSampler): Effect.Effect<number, SqlError> =>
	Effect.map(
		sampler.observer.values(
			"SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_stat_activity WHERE pid = ANY ($1::int4[]) AND wait_event_type = 'Lock'::text",
			[`{${Arr.join(Arr.map(sampler.pids, String), ",")}}`]
		),
		(rows) => {
			const [[waiting]] = trusted<readonly [readonly [waiting: string]]>(rows)
			return Number(waiting)
		}
	)

interface Done {
	readonly ms: number
	readonly result: OperationResult
}

const round2 = (x: number): number => Math.round(x * 100) / 100

/** Runs the load: every worker starts at once and runs `operation` until its count or the deadline. */
export const runLoad = Effect.fn("runLoad")(function* <W, E, R>(
	workers: ReadonlyArray<W>,
	operation: (worker: W, index: number, iteration: number) => Effect.Effect<OperationResult, E, R>,
	options: LoadOptions
): Effect.fn.Return<LoadMeasure, E | SqlError, R> {
	if (workers.length === 0) {
		return yield* Effect.die(new RangeError("runLoad: no workers"))
	}

	const waiting: Array<number> = []
	const sampler = options.sampler
	const fiber =
		sampler.kind === "none"
			? undefined
			: yield* Effect.forkChild(
					Effect.forever(
						Effect.andThen(
							Effect.flatMap(sampleOnce(sampler), (n) => {
								waiting.push(n)
								return sampler.onSample(n)
							}),
							Effect.sleep(Duration.millis(sampler.intervalMs))
						)
					)
				)

	const start = performance.now()
	const bound = options.bound
	/**
	 * Under a deadline a worker's first operation always runs: the deadline is set before the workers start, and a worker
	 * that starts after it (a loaded machine, a busy event loop) would otherwise measure nothing.
	 */
	const goesOn = (i: number): boolean => {
		switch (bound.kind) {
			case "operations":
				return i < bound.n
			case "deadline":
				return i === 0 || performance.now() < start + bound.ms
		}
	}
	const done = yield* Effect.forEach(
		workers,
		(worker, index) =>
			Effect.gen(function* () {
				const mine: Array<Done> = []
				for (let i = 0; goesOn(i); i++) {
					const t = performance.now()
					const result = yield* operation(worker, index, i)
					mine.push({ ms: elapsed(t), result })
				}
				return mine
			}),
		{ concurrency: "unbounded" }
	)
	const wallMs = elapsed(start)
	if (fiber !== undefined) {
		yield* Fiber.interrupt(fiber)
	}

	const all = done.flat()
	if (all.length === 0) {
		return yield* Effect.die(new RangeError("runLoad: no operation completed"))
	}
	const outcomes: Partial<Record<OutcomeKey, number>> = {}
	const byReason: Partial<Record<TransientReason["_tag"], number>> = {}
	const bySqlstate: Record<string, number> = {}
	const byLabel: Record<string, number> = {}
	for (const d of all) {
		const key = outcomeKey(d.result.outcome)
		outcomes[key] = (outcomes[key] ?? 0) + 1
		for (const r of d.result.retries) {
			byReason[r.reason] = (byReason[r.reason] ?? 0) + 1
			if (r.failed !== undefined) {
				bySqlstate[r.failed.sqlstate] = (bySqlstate[r.failed.sqlstate] ?? 0) + 1
			}
			if (r.label !== undefined) {
				byLabel[r.label] = (byLabel[r.label] ?? 0) + 1
			}
		}
	}
	const committed = Arr.filter(all, (d) => d.result.outcome.kind === "committed")
	const retries = Arr.reduce(all, 0, (sum, d) => sum + d.result.retries.length)
	const perSecond = (n: number): number => round2((n / wallMs) * 1000)
	return {
		workers: workers.length,
		operations: all.length,
		wallMs,
		operationsPerSecond: perSecond(all.length),
		committedPerSecond: perSecond(committed.length),
		latencyMs: summarize(Arr.map(all, (d) => d.ms)),
		committedLatencyMs:
			committed.length === 0
				? { kind: "unobserved" }
				: { kind: "observed", value: summarize(Arr.map(committed, (d) => d.ms)) },
		outcomes,
		attempts: summarize(Arr.map(all, (d) => d.result.attempts)),
		retries: {
			total: retries,
			perOperation: round2(retries / all.length),
			byReason,
			bySqlstate,
			byLabel
		},
		lockWaits:
			sampler.kind === "none" || waiting.length === 0
				? { kind: "unobserved" }
				: {
						kind: "observed",
						value: {
							samples: waiting.length,
							intervalMs: sampler.intervalMs,
							waiting: summarize(waiting),
							lockWaitSessionMs: Arr.reduce(waiting, 0, (sum, n) => sum + n) * sampler.intervalMs
						}
					}
	} satisfies LoadMeasure
})
