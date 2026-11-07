import type * as Interleave from "@grizzle/testing/interleave"
import { exact, ordered, set } from "@grizzle/testing/oracle"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import type { ApplyError, TransientFailure } from "#adapter/errors/execution.ts"
import { defined } from "#test/support/assert.ts"
import { exactValue } from "#test/support/equivalence.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { Actors, DirectActor } from "#test/support/schedules/actors.ts"
import { type Retried, untilAnswered } from "#test/support/schedules/grizzle.ts"
import {
	allowed,
	type ExploreEnv,
	exploreInterleavings,
	type Footprint,
	type Interleaving,
	interleaveStep,
	type Judgment,
	refusedJudgment,
	runawayInterleavings,
	type Strategy,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { describeStepOutcome } from "#test/support/schedules/match.ts"
import type { DirectAction, StepOutcome } from "#test/support/schedules/types.ts"
import type { TextRows } from "#test/support/substrate/substrate.ts"

/** One statement of a direct transaction, and what it reaches. */
export interface RaceStatement {
	readonly sql: string
	readonly footprint: Footprint
}

/**
 * One transaction of a race: a direct session's statements, ended by its COMMIT or its ROLLBACK as written; or one
 * call of a grizzle session, which its caller calls again after each TransientFailure until it answers, as an
 * application does.
 */
export type RaceTxn<A> =
	| {
			readonly kind: "direct"
			readonly session: string
			readonly statements: Arr.NonEmptyReadonlyArray<RaceStatement>
			readonly end: "commit" | "rollback"
	  }
	| {
			readonly kind: "grizzle"
			readonly session: string
			readonly label: string
			readonly call: Effect.Effect<A, ApplyError>
			readonly footprint: Footprint
	  }

/**
 * How a session of a run ended: a direct transaction committed, ended by its ROLLBACK as written, aborted by
 * PostgreSQL as a transient failure (a serialization failure or a deadlock), or failed otherwise, with that failure; a
 * grizzle call answered, after the refusals it met.
 */
export type SessionEnd<A> =
	| { readonly kind: "committed"; readonly outcomes: ReadonlyArray<StepOutcome> }
	| { readonly kind: "rolled back" }
	| { readonly kind: "aborted"; readonly code: TransientCode }
	| {
			readonly kind: "failed"
			readonly outcomes: ReadonlyArray<StepOutcome>
			readonly failure: StepOutcome
	  }
	| { readonly kind: "answered"; readonly retried: Retried<A> }

/** The SQLSTATEs of PostgreSQL's transient failures: a serialization failure and a deadlock. */
type TransientCode = "40001" | "40P01"

/** A run the serial reference explained: how each session ended, and the serial order that explains it. */
export interface Explained<A> {
	readonly run: Interleaving
	readonly ends: ReadonlyMap<string, SessionEnd<A>>
	readonly order: ReadonlyArray<string>
}

/**
 * A race judged by its serial reference: its transactions, the reset that writes its initial state before every run
 * (and before every serial run), and the read of the state a run leaves, as text rows that are each distinct.
 */
export interface SerialRace<A, E> {
	readonly name: string
	readonly txns: Arr.NonEmptyReadonlyArray<RaceTxn<A>>
	readonly reset: Effect.Effect<void, E>
	readonly state: Effect.Effect<TextRows, E | SqlError>
}

/**
 * A race the serial reference refused, with the run, why and the script that replays it, or one the driver could not
 * run.
 */
export type SerialRaceFailed = Interleave.InterleavingFailed | Interleave.AfterCycle

/** What a transaction placed in a serial order showed: a direct one's outcomes, or a grizzle call's answer. */
type Shown<A> =
	| { readonly kind: "direct"; readonly outcomes: ReadonlyArray<StepOutcome> }
	| { readonly kind: "answered"; readonly answer: A }
	| { readonly kind: "failed"; readonly what: string }

/** A serial run of an order: what each transaction showed alone, and the state after the last. */
interface Reference<A> {
	readonly shown: ReadonlyMap<string, Shown<A>>
	readonly state: TextRows
}

const succeeded: StepOutcome = { _tag: "Ok", rows: [], rowCount: 0 }

const transientCode = (outcome: StepOutcome): TransientCode | undefined =>
	outcome._tag === "PgError" && (outcome.fields.code === "40001" || outcome.fields.code === "40P01")
		? outcome.fields.code
		: undefined

const sameRows = set(ordered(exact))

/** Two outcomes alike: rows as a set with the same count, or the same SQLSTATE on the same constraint. */
const sameOutcome = (a: StepOutcome, b: StepOutcome): boolean => {
	switch (a._tag) {
		case "Ok":
			return b._tag === "Ok" && a.rowCount === b.rowCount && Option.isNone(sameRows(a.rows, b.rows))
		case "PgError":
			return (
				b._tag === "PgError" &&
				a.fields.code === b.fields.code &&
				a.fields.constraint === b.fields.constraint
			)
		case "RolledBack":
			return b._tag === "RolledBack"
		case "Failed":
		case "Interrupted":
			return false
	}
}

const sameShown = <A>(a: Shown<A>, b: Shown<A>): boolean => {
	switch (a.kind) {
		case "direct":
			return (
				b.kind === "direct" &&
				a.outcomes.length === b.outcomes.length &&
				Arr.every(a.outcomes, (o, i) => sameOutcome(o, defined(b.outcomes[i], "an outcome")))
			)
		case "answered":
			return b.kind === "answered" && Option.isNone(exactValue(a.answer, b.answer))
		case "failed":
			return false
	}
}

const describeShown = <A>(shown: Shown<A>): string => {
	switch (shown.kind) {
		case "direct":
			return `[${Arr.join(Arr.map(shown.outcomes, describeStepOutcome), "; ")}]`
		case "answered":
			return Formatter.format(shown.answer)
		case "failed":
			return `failed: ${shown.what}`
	}
}

/**
 * Every order of `sessions` that respects real time: a session whose span ended before another's began comes before
 * it.
 */
const serialOrders = (
	sessions: ReadonlyArray<string>,
	spans: Interleaving["spans"]
): ReadonlyArray<ReadonlyArray<string>> => {
	const before = (a: string, b: string): boolean => {
		const x = spans[a]
		const y = spans[b]
		return x !== undefined && y !== undefined && x.end < y.start
	}
	const extend = (
		placed: ReadonlyArray<string>,
		left: ReadonlyArray<string>
	): ReadonlyArray<ReadonlyArray<string>> =>
		left.length === 0
			? [placed]
			: Arr.flatMap(left, (next) => {
					const rest = Arr.filter(left, (s) => s !== next)
					return Arr.some(rest, (other) => before(other, next))
						? []
						: extend([...placed, next], rest)
				})
	return extend([], sessions)
}

const overlapping = (spans: Interleaving["spans"], session: string): boolean => {
	const own = spans[session]
	return (
		own !== undefined &&
		Arr.some(
			Rec.toEntries(spans),
			([other, span]) => other !== session && span.start < own.end && own.start < span.end
		)
	)
}

/**
 * Runs `race` on `actors` through the one concurrency driver, in the orders `strategy` chooses, and judges every run
 * by the race's serial reference.
 *
 * The serial reference: the transactions the run placed, each run alone on the real system from the race's initial
 * state, one after another in an order that respects real time, must show what the run showed: each direct
 * transaction's outcomes statement by statement (its rows, or its SQLSTATE on its constraint), each grizzle call's
 * answer, and the state the run left. A transaction is placed when it took effect or failed for a reason of its own: a
 * direct transaction that committed or failed with anything but a transient failure, and every grizzle call, which
 * its caller calls until it answers. A direct transaction that ended by its ROLLBACK as written took no effect and is
 * placed nowhere, and one PostgreSQL aborted as a serialization failure or a deadlock is no outcome of its own: it
 * must have overlapped another session, as every refusal a grizzle call met must, since a transient failure always
 * has a concurrent cause. Run alone, a transaction never meets a transient failure but one the cluster's own SSI
 * bookkeeping gives it, so it is run again until it ends otherwise, as the race's every order is: the reference is
 * the race's serializability, judged against the system itself running one transaction at a time.
 *
 * Each order's serial run is made once per race, when a run first needs it, and kept in the race's table of them;
 * `noteRun` sees every run the reference explained.
 */
export const runSerialRace = <A, E>(
	env: ExploreEnv,
	actors: Actors<string, string>,
	race: SerialRace<A, E>,
	strategy: Strategy,
	noteRun: (explained: Explained<A>) => void
): Effect.Effect<void, SerialRaceFailed | E | SqlError> =>
	Effect.gen(function* () {
		const seen = new Map<string, Result.Result<Retried<A>, Exclude<ApplyError, TransientFailure>>>()
		const references = new Map<string, Reference<A>>()
		const bySession = new Map(Arr.map(race.txns, (t) => [t.session, t] as const))
		const actorOf = (session: string): DirectActor =>
			defined(actors.direct[session], `the direct actor of ${session}`)
		const perform = (session: string, action: DirectAction) => actorOf(session).perform(action)
		const directAlone = (
			t: Extract<RaceTxn<A>, { readonly kind: "direct" }>
		): Effect.Effect<Shown<A>> =>
			Effect.gen(function* () {
				for (;;) {
					const begun = yield* perform(t.session, { _tag: "Begin" })
					if (begun._tag !== "Ok") {
						return yield* Effect.die(
							new Error(`${t.session} could not begin alone: ${describeStepOutcome(begun)}`)
						)
					}
					const outcomes: Array<StepOutcome> = []
					for (const statement of t.statements) {
						const outcome = yield* perform(t.session, { _tag: "Sql", sql: statement.sql })
						outcomes.push(outcome)
						if (outcome._tag !== "Ok") {
							break
						}
					}
					const last = defined(outcomes[outcomes.length - 1], "a statement's outcome")
					if (last._tag === "Ok") {
						const ended = yield* perform(
							t.session,
							t.end === "commit" ? { _tag: "Commit" } : { _tag: "Rollback" }
						)
						outcomes.push(ended)
					} else {
						yield* perform(t.session, { _tag: "Rollback" })
					}
					const final = defined(outcomes[outcomes.length - 1], "the transaction's last outcome")
					if (transientCode(final) === undefined) {
						return { kind: "direct", outcomes }
					}
				}
			})
		const alone = (t: RaceTxn<A>): Effect.Effect<Shown<A>> =>
			t.kind === "direct"
				? directAlone(t)
				: Effect.map(Effect.result(untilAnswered(t.call)), (r): Shown<A> =>
						Result.isSuccess(r)
							? { kind: "answered", answer: r.success.answered }
							: { kind: "failed", what: r.failure._tag }
					)
		const referenceOf = (order: ReadonlyArray<string>): Effect.Effect<Reference<A>, E | SqlError> =>
			Effect.gen(function* () {
				const key = Arr.join(order, "\u0000")
				const kept = references.get(key)
				if (kept !== undefined) {
					return kept
				}
				yield* race.reset
				const shown = new Map<string, Shown<A>>()
				for (const session of order) {
					const showed = yield* alone(defined(bySession.get(session), `${session}'s transaction`))
					shown.set(session, showed)
				}
				const after = yield* race.state
				const made: Reference<A> = { shown, state: after }
				references.set(key, made)
				return made
			})
		const endOf = (run: Interleaving, t: RaceTxn<A>): SessionEnd<A> | string => {
			if (t.kind === "grizzle") {
				const answer = seen.get(t.session)
				if (answer === undefined) {
					return `${t.session}'s call never answered`
				}
				return Result.isSuccess(answer)
					? { kind: "answered", retried: answer.success }
					: `${t.session}'s call failed with ${answer.failure._tag}: ${answer.failure.message}`
			}
			const result = run.results[t.session]
			if (result === undefined) {
				return `${t.session} never ran`
			}
			switch (result._tag) {
				case "Committed":
					return { kind: "committed", outcomes: result.outcomes }
				case "RolledBack":
					return { kind: "rolled back" }
				case "Failed": {
					const code = transientCode(result.failure)
					return code === undefined
						? { kind: "failed", outcomes: result.outcomes, failure: result.failure }
						: { kind: "aborted", code }
				}
			}
		}
		const judge = (run: Interleaving): Effect.Effect<Judgment, E | SqlError> =>
			Effect.gen(function* () {
				const state = yield* race.state
				const ends = new Map<string, SessionEnd<A>>()
				for (const t of race.txns) {
					const end = endOf(run, t)
					if (typeof end === "string") {
						return refusedJudgment(end)
					}
					ends.set(t.session, end)
				}
				const shownInRun = new Map<string, Shown<A>>()
				for (const [session, end] of ends) {
					switch (end.kind) {
						case "committed":
						case "failed":
							shownInRun.set(session, { kind: "direct", outcomes: end.outcomes })
							break
						case "answered":
							if (end.retried.refused.length > 0 && !overlapping(run.spans, session)) {
								return refusedJudgment(
									`${session}'s call was refused by [${Arr.join(end.retried.refused, ", ")}] beside no other session`
								)
							}
							shownInRun.set(session, { kind: "answered", answer: end.retried.answered })
							break
						case "aborted":
							if (!overlapping(run.spans, session)) {
								return refusedJudgment(
									`${session} was aborted with ${end.code} beside no other session`
								)
							}
							break
						case "rolled back":
							break
					}
				}
				const placed = [...shownInRun.keys()]
				const tried: Array<string> = []
				for (const order of serialOrders(placed, run.spans)) {
					const reference = yield* referenceOf(order)
					const differs = Arr.findFirst(order, (session) => {
						const alone = defined(reference.shown.get(session), `${session} alone`)
						const ran = defined(shownInRun.get(session), `${session} in the run`)
						return !sameShown(ran, alone)
					})
					const stateDiffers = sameRows(state, reference.state)
					if (Option.isNone(differs) && Option.isNone(stateDiffers)) {
						noteRun({ run, ends, order })
						return allowed
					}
					tried.push(
						`  in the order ${Arr.join(order, ", ")}: ${Option.match(differs, {
							onSome: (session) =>
								`${session} alone shows ${describeShown(defined(reference.shown.get(session), session))}, the run ${describeShown(defined(shownInRun.get(session), session))}`,
							onNone: () => `the state differs: ${Option.getOrElse(stateDiffers, () => "")}`
						})}`
					)
				}
				return refusedJudgment(
					`no serial order of the placed transactions [${Arr.join(placed, ", ")}] explains the run:\n${Arr.join(tried, "\n")}`
				)
			})
		const txns: ReadonlyArray<Txn> = Arr.map(race.txns, (t): Txn => {
			if (t.kind === "direct") {
				return {
					kind: "direct",
					session: t.session,
					steps: Arr.map(t.statements, (s) => interleaveStep(s.sql, s.footprint)),
					end: t.end,
					after: undefined
				}
			}
			return {
				kind: "grizzle",
				session: t.session,
				steps: [
					{
						label: t.label,
						outcome: Effect.map(Effect.result(untilAnswered(t.call)), (r) => {
							seen.set(t.session, r)
							return succeeded
						}),
						footprint: t.footprint
					}
				],
				after: undefined
			}
		})
		yield* exploreInterleavings(
			env,
			actors,
			{
				name: race.name,
				txns,
				reset: Effect.andThen(
					Effect.sync(() => {
						seen.clear()
					}),
					race.reset
				),
				state: { _tag: "Unread" },
				model: judge,
				maxInterleavings: runawayInterleavings
			},
			strategy
		)
	})
