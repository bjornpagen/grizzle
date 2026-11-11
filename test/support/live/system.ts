import { awaitFact } from "@grizzle/testing/fact"
import {
	Array as Arr,
	Data,
	Effect,
	Fiber,
	Formatter,
	Option,
	Ref,
	type Scope,
	Stream
} from "effect"
import type { CallError, Keyed, ReadShape } from "#compiler/live/index.ts"
import { printKeyed, sameKeyed } from "#test/support/live/values.ts"

/**
 * The live suites' one seam to the system under test: a served member called by its name, in process (a Db's
 * once/watch) or over HTTP (the handler, through the client and its fold), each answering in the live event model's
 * terms (live/events.ts, live/fold.ts), so a suite states its property once for both and a change in how a surface is
 * reached touches this module alone.
 */

/** A read's value: a keyed set or list (live/keyed.ts). */
export type LiveValue = Keyed<ReadShape, object>

/** A call's input: its parameters, its facts, and a paged member's window. */
export type CallInput =
	| { readonly params: object; readonly facts: object }
	| { readonly params: object; readonly facts: object; readonly window: object }

/** How a suite reaches the served members of one login: in process, or over HTTP. */
export type Surface = "in process" | "over HTTP"

/** The calls of one surface. */
export interface LiveCalls {
	readonly surface: Surface
	/** A read's value at its ready, or the error that ended it. */
	readonly once: (member: string, input: CallInput) => Effect.Effect<LiveValue, CallError>
	/** A write's outcome, or the error that ended it. */
	readonly write: (member: string, input: CallInput) => Effect.Effect<unknown, CallError>
	/**
	 * A read's values, one each time its answer is whole at a committed snapshot (each `ready`: its first, then each live
	 * batch's), until its error or its end.
	 */
	readonly watch: (member: string, input: CallInput) => Stream.Stream<LiveValue, CallError>
}

/** A registered subscription's state (LIVE-SUBSCRIBE): no re-run pending, a re-run pending, or ended. */
export type MarkState = "clean" | "marked" | "ended"

/**
 * A subscription registered in process and read to its first ready, its re-runs only those a suite asks for: its state,
 * read without a race, since a subscription no one turns never re-runs; its first value; and `turn`, one turn now
 * (LIVE-SUBSCRIBE's Live turn): a clean subscription runs nothing, a marked one re-runs exactly once and gives its value
 * at the ready its batch ends with where the value changed, and an ended one fails with the error that ended it.
 */
export interface Registration {
	readonly state: Effect.Effect<MarkState>
	readonly value: LiveValue
	readonly turn: Effect.Effect<Option.Option<LiveValue>, CallError>
}

/** Registers `member` with `input` in process and reads it to its first ready (Registration). */
export type Register = (
	member: string,
	input: CallInput
) => Effect.Effect<Registration, CallError, Scope.Scope>

/** One server-sent event as the HTTP answer's body frames it, before any decoding: its type and its data. */
export interface RawEvent {
	readonly type: string
	readonly data: string
}

/**
 * The surfaces of one login: in process, over HTTP, and the HTTP handler answering a request a suite writes itself,
 * read to the end of its body.
 */
export interface LiveSurfaces {
	readonly inProcess: LiveCalls
	readonly http: LiveCalls
	readonly raw: (request: RawRequest) => Effect.Effect<ReadonlyArray<RawEvent>>
}

/** A request a suite writes itself: its method, its path, its headers and its body's text, well formed or not. */
export interface RawRequest {
	readonly method: string
	readonly path: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
}

/** Where a subscription stands: still opening, live at its last ready's value, or ended by an error. */
export type Standing =
	| { readonly kind: "opening" }
	| { readonly kind: "live"; readonly value: LiveValue; readonly readies: number }
	| { readonly kind: "ended"; readonly error: CallError }

/**
 * A subscription consumed as it arrives: every value its stream was whole at (each `ready`), in order, and where it
 * stands now. The consumer runs in the scope and stops with it.
 */
export interface Consumed {
	readonly checkpoints: Effect.Effect<ReadonlyArray<LiveValue>>
	readonly standing: Effect.Effect<Standing>
	/** Drops the call: interrupts its consumer, as a client that goes away does, and waits for it to end. */
	readonly drop: Effect.Effect<void>
}

/** Runs `values` in the scope, recording each value whole at a ready, its first and each live batch's (Consumed). */
const consume = (
	values: Stream.Stream<LiveValue, CallError>
): Effect.Effect<Consumed, never, Scope.Scope> =>
	Effect.gen(function* () {
		const checkpoints = yield* Ref.make<ReadonlyArray<LiveValue>>([])
		const standing = yield* Ref.make<Standing>({ kind: "opening" })
		const ready = (value: LiveValue) =>
			Effect.andThen(
				Ref.update(checkpoints, (all) => [...all, value]),
				Ref.update(standing, (was): Standing => ({
					kind: "live",
					value,
					readies: was.kind === "live" ? was.readies + 1 : 1
				}))
			)
		const fiber = yield* Effect.forkScoped(
			values.pipe(
				Stream.runForEach(ready),
				Effect.catch((error) => Ref.set(standing, { kind: "ended", error }))
			)
		)
		return {
			checkpoints: Ref.get(checkpoints),
			standing: Ref.get(standing),
			drop: Fiber.interrupt(fiber)
		}
	})

/**
 * Where a subscription's checkpoints stand against a sequence of fresh values, one per commit prefix: each checkpoint
 * matches the least prefix at or after the one before it whose fresh value it equals, so the prefixes never decrease;
 * `matched` is the last checkpoint's prefix, or a checkpoint that matched none.
 */
export type Matched =
	| { readonly kind: "matched"; readonly prefix: number; readonly checked: number }
	| { readonly kind: "unmatched"; readonly at: number; readonly value: LiveValue }

/** Matches `checkpoints` against `fresh` from where `from` left off (Matched). */
const matchCheckpoints = (
	checkpoints: ReadonlyArray<LiveValue>,
	fresh: ReadonlyArray<LiveValue>,
	from: Extract<Matched, { readonly kind: "matched" }>
): Matched => {
	let prefix = from.prefix
	for (let at = from.checked; at < checkpoints.length; at++) {
		const value = Arr.getUnsafe(checkpoints, at)
		const found = Arr.findFirstIndex(fresh, (f, j) => j >= prefix && sameKeyed(f, value))
		if (Option.isNone(found)) {
			return { kind: "unmatched", at, value }
		}
		prefix = found.value
	}
	return { kind: "matched", prefix, checked: checkpoints.length }
}

/** A report of a checkpoint no prefix explains: the checkpoint and every prefix's fresh value. */
const unmatchedReport = (
	label: string,
	unmatched: Extract<Matched, { readonly kind: "unmatched" }>,
	fresh: ReadonlyArray<LiveValue>
): string =>
	`${label}: its ready ${unmatched.at} held ${printKeyed(unmatched.value)}, the value at no commit prefix since its last:\n${Arr.join(
		Arr.map(fresh, (f, j) => `  prefix ${j}: ${printKeyed(f)}`),
		"\n"
	)}`

/** A case the live oracle disagrees with: a subscription's ready at no prefix, or one that ended. */
export class Inexact extends Data.TaggedError("Inexact")<{ readonly report: string }> {}

/** A subscription a case runs: its place, its surface, what it consumed, and how far its readies matched. */
export interface Tracked {
	readonly place: number
	readonly surface: Surface
	readonly consumed: Consumed
	readonly matched: Ref.Ref<Extract<Matched, { readonly kind: "matched" }>>
}

/** `values` consumed in the scope (consume) as subscription `place` over `surface`, no ready matched yet. */
export const tracked = (
	place: number,
	surface: Surface,
	values: Stream.Stream<LiveValue, CallError>
): Effect.Effect<Tracked, never, Scope.Scope> =>
	Effect.gen(function* () {
		const consumed = yield* consume(values)
		const matched = yield* Ref.make<Extract<Matched, { readonly kind: "matched" }>>({
			kind: "matched",
			prefix: 0,
			checked: 0
		})
		return { place, surface, consumed, matched }
	})

/**
 * Waits until `running`'s last ready holds `target`, judging every ready it sent since the last wait against `fresh`,
 * the fresh values at every prefix so far: one at no prefix at or after the last one matched fails the case, as does a
 * subscription that ended. A wait observes the subscription's own readies, never the clock: one that never comes is the
 * case's hang guard's to report.
 */
export const reaches = (
	running: Tracked,
	fresh: ReadonlyArray<LiveValue>,
	target: LiveValue,
	label: string
): Effect.Effect<void, Inexact> =>
	awaitFact(
		Effect.gen(function* () {
			const standing = yield* running.consumed.standing
			if (standing.kind === "ended") {
				return yield* new Inexact({
					report: `${label}: ended with ${Formatter.format(standing.error)}`
				})
			}
			const checkpoints = yield* running.consumed.checkpoints
			const from = yield* Ref.get(running.matched)
			const matched = matchCheckpoints(checkpoints, fresh, from)
			if (matched.kind === "unmatched") {
				return yield* new Inexact({ report: unmatchedReport(label, matched, fresh) })
			}
			yield* Ref.set(running.matched, matched)
			return standing.kind === "live" && sameKeyed(standing.value, target)
				? Option.some(undefined)
				: Option.none()
		})
	)
