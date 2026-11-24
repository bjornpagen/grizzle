import { Effect, Option, type Scope, Stream } from "effect"
import type { CallError, KeyedList } from "#compiler/live/index.ts"

/**
 * The live suites' one seam to the system under test: a served member called by its name, in process (a Db's
 * once/watch) or over HTTP (the handler, through the client and its fold), each answering in the live event model's
 * terms (live/events.ts, live/fold.ts), so a suite states its property once for both and a change in how a surface is
 * reached touches this module alone.
 */

/** A read's value: a keyed list (live/keyed.ts). */
export type LiveValue = KeyedList<object>

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
