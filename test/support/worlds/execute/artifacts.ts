import { Array as Arr, Deferred, Effect, Exit, Option, Ref } from "effect"
import { type DbContext, dbContext, dbReadFrame } from "#adapter/db/context.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { makeReader, type ReaderValue, type ReadExecutor } from "#adapter/reader/reader.ts"
import {
	asReadFailure,
	type BatchOutcome,
	type FlightStatement,
	runFramed
} from "#adapter/wire/batch.ts"
import * as EngineResult from "#compiler/core/result.ts"
import type { CompiledTemplate } from "#compiler/program/template.ts"
import { factKeySet } from "#test/support/worlds/model/host.ts"
import type { HostFact } from "#test/support/worlds/model/types.ts"

/**
 * The differential of one read's two artifacts. Every template a Db reads through is compiled for the `snapshot`
 * context and holds two lowerings of the same query: the optimized artifact, which the Db runs, and the conservative
 * one, which rests on no evidence the context admits (program/context.ts). Both must deliver the same rows from the
 * same snapshot, each a keyed set; rows that differ, or that either artifact repeats, are `artifacts-disagree`, a defect
 * no model branch allows.
 *
 * The check reads through two readers over the Db's own context (adapter/reader/reader.ts makeReader), as the Db's own
 * reader is built. One keeps the Db's compilation, so it runs the very template the Db's read ran. The other's
 * compilation selects every template's conservative artifact. Their flights meet: each pair of flights, one per artifact, is sent
 * as one flight in one READ ONLY transaction of the Db's role and claims on one leased session, the optimized
 * statements first. Every read path (execute, get, every page, a compiled handle) sends its flights in turn, so the
 * k-th flight of one artifact meets the k-th of the other. A flight left without a partner, because the other artifact
 * read through in fewer flights, is sent alone.
 */
/** The Db context's compilation, every template selecting its conservative artifact. */
const conservativeCompile =
	(ctx: DbContext): DbContext["compile"] =>
	(input, request) =>
		EngineResult.map(ctx.compile(input, request), (prepared): CompiledTemplate => ({
			...prepared,
			selection: { artifact: "conservative", statements: prepared.template.conservative }
		}))

type Side = "optimized" | "conservative"

const otherSide = (side: Side): Side => (side === "optimized" ? "conservative" : "optimized")

/** A side's flight waiting for the other's: its statements, and where its own outcomes are delivered. */
interface Waiting {
	readonly side: Side
	readonly statements: ReadonlyArray<FlightStatement>
	readonly outcomes: Deferred.Deferred<ReadonlyArray<BatchOutcome>, ReadError>
}

/** Where the two sides stand: neither waiting, one waiting for the other, or one reading on after the other finished. */
type Meeting =
	| { readonly kind: "open" }
	| { readonly kind: "waiting"; readonly waiting: Waiting }
	| { readonly kind: "alone"; readonly side: Side }

/** What a side's arriving flight does: wait for the other's, go with the waiting one, or go alone. */
type Arrival =
	| { readonly kind: "wait" }
	| { readonly kind: "pair"; readonly other: Waiting }
	| { readonly kind: "alone" }
	| { readonly kind: "out-of-turn" }

const arrivalAt = (meeting: Meeting, mine: Waiting): readonly [Arrival, Meeting] => {
	switch (meeting.kind) {
		case "open":
			return [{ kind: "wait" }, { kind: "waiting", waiting: mine }]
		case "waiting":
			return meeting.waiting.side === mine.side
				? [{ kind: "out-of-turn" }, meeting]
				: [{ kind: "pair", other: meeting.waiting }, { kind: "open" }]
		case "alone":
			return meeting.side === mine.side
				? [{ kind: "alone" }, meeting]
				: [{ kind: "out-of-turn" }, meeting]
	}
}

/** One flight's statements sent on a session leased from the Db's pool, in one transaction of its read frame. */
const flown = (
	ctx: DbContext,
	statements: ReadonlyArray<FlightStatement>
): Effect.Effect<ReadonlyArray<BatchOutcome>, ReadError> =>
	Effect.scoped(
		Effect.flatMap(
			Effect.mapError(ctx.pool.lease, (reason) => new ReadFailure({ reason })),
			(session) => Effect.mapError(runFramed(session, dbReadFrame(ctx), statements), asReadFailure)
		)
	)

/** Two waiting flights sent as one, the optimized first; each side is delivered its own statements' outcomes. */
const together = (
	ctx: DbContext,
	mine: Waiting,
	other: Waiting
): Effect.Effect<ReadonlyArray<BatchOutcome>, ReadError> => {
	const [first, second] = mine.side === "optimized" ? [mine, other] : [other, mine]
	return Effect.gen(function* () {
		const exit = yield* Effect.exit(flown(ctx, [...first.statements, ...second.statements]))
		const cut = first.statements.length
		yield* Deferred.done(
			first.outcomes,
			Exit.map(exit, (all) => all.slice(0, cut))
		)
		yield* Deferred.done(
			second.outcomes,
			Exit.map(exit, (all) => all.slice(cut))
		)
		return yield* Deferred.await(mine.outcomes)
	})
}

/** A side's flight arriving at the meeting: it waits for the other's, goes with it, or goes alone. */
const arrive = (
	ctx: DbContext,
	meeting: Ref.Ref<Meeting>,
	side: Side,
	statements: ReadonlyArray<FlightStatement>
): Effect.Effect<ReadonlyArray<BatchOutcome>, ReadError> =>
	Effect.gen(function* () {
		const mine: Waiting = {
			side,
			statements,
			outcomes: yield* Deferred.make<ReadonlyArray<BatchOutcome>, ReadError>()
		}
		const arrival = yield* Ref.modify(meeting, (m) => arrivalAt(m, mine))
		switch (arrival.kind) {
			case "wait":
				return yield* Deferred.await(mine.outcomes)
			case "pair":
				return yield* together(ctx, mine, arrival.other)
			case "alone":
				return yield* flown(ctx, statements)
			case "out-of-turn":
				return yield* Effect.die(new Error(`the ${side} artifact sent a flight out of turn`))
		}
	})

/**
 * A side done reading, or interrupted: a flight of the other's still waiting goes alone, and so does every later one.
 * A side interrupted while its own flight waits leaves it unsent.
 */
const finished = (ctx: DbContext, meeting: Ref.Ref<Meeting>, side: Side): Effect.Effect<void> =>
	Effect.flatMap(
		Ref.modify(meeting, (m): readonly [Option.Option<Waiting>, Meeting] => {
			switch (m.kind) {
				case "open":
					return [Option.none(), { kind: "alone", side: otherSide(side) }]
				case "waiting":
					return m.waiting.side === side
						? [Option.none(), { kind: "alone", side: otherSide(side) }]
						: [Option.some(m.waiting), { kind: "alone", side: m.waiting.side }]
				case "alone":
					return [Option.none(), m]
			}
		}),
		(left) =>
			Option.match(left, {
				onNone: () => Effect.void,
				onSome: (waiting) =>
					Effect.flatMap(Effect.exit(flown(ctx, waiting.statements)), (exit) =>
						Effect.asVoid(Deferred.done(waiting.outcomes, exit))
					)
			})
	)

const executorAt = (ctx: DbContext, meeting: Ref.Ref<Meeting>, side: Side): ReadExecutor => ({
	run: (flight) =>
		Effect.flatMap(arrive(ctx, meeting, side, flight.statements), (outcomes) =>
			Effect.mapError(flight.read(outcomes), (reason) => new ReadFailure({ reason }))
		)
})

/**
 * Whether two deliveries are one keyed set: neither holds a fact twice, and each fact of one is a fact of the other,
 * each fact by every field and its value. Two artifacts that repeat one row alike deliver no set, so they do not agree.
 */
const sameFacts = (left: ReadonlyArray<HostFact>, right: ReadonlyArray<HostFact>): boolean => {
	const l = factKeySet(left)
	const r = factKeySet(right)
	return (
		l.size === left.length &&
		r.size === right.length &&
		l.size === r.size &&
		Arr.every([...l], (key) => r.has(key))
	)
}

/**
 * Whether the Db's two artifacts of the read `read` makes deliver the same facts (see the header). `read` reads
 * through the reader it is handed exactly as the Db's read did. A read the Db answered that either artifact refuses
 * here is an answer no observation names, so it is raised as a defect of the run.
 */
export const artifactsAgree = <E>(
	db: object,
	read: (reader: ReaderValue) => Effect.Effect<ReadonlyArray<HostFact>, E>
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const ctx = yield* Option.match(Option.fromNullishOr(dbContext(db)), {
			onNone: () => Effect.die(new Error("a Db session holds no Db context")),
			onSome: Effect.succeed
		})
		const meeting = yield* Ref.make<Meeting>({ kind: "open" })
		const sideRead = (side: Side, context: DbContext) =>
			Effect.ensuring(
				read(makeReader(context, executorAt(ctx, meeting, side))),
				finished(ctx, meeting, side)
			)
		const [optimized, conservative] = yield* Effect.orDie(
			Effect.all(
				[
					sideRead("optimized", ctx),
					sideRead("conservative", { ...ctx, compile: conservativeCompile(ctx) })
				],
				{ concurrency: "unbounded" }
			)
		)
		return sameFacts(optimized, conservative)
	})
