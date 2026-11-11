import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Option from "effect/Option"
import * as Rec from "effect/Record"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { type SseEvent, sseEvents } from "#client/sse.ts"
import {
	type CallError,
	callError,
	defect,
	encodeInput,
	type EventDescriptor,
	events,
	fold,
	foldWrite,
	type Keyed,
	type MemberWire,
	opening,
	type ReadEvent,
	type ReadShape,
	type ReadState,
	type Shape,
	slotDecoders,
	trusted,
	trustedJson,
	trustedMember,
	type WireJson,
	type WireOptions,
	type WriteEvent,
	type WriteState,
	wireText,
	writeOpening
} from "#compiler/plan/client.ts"

/**
 * The bearer credential every call sends: a token, or the Effect that yields one, run once per call, so a refreshed
 * token is the next call's. Its failure is the caller's own, E, and fails the call before anything is sent.
 */
export type Token<E> = Redacted.Redacted | Effect.Effect<Redacted.Redacted, E>

/** A served program as the client calls it: the URL it posts to, the digest of its wire form, and the form. */
export interface ClientMember {
	readonly route: URL
	readonly digest: string
	readonly wire: MemberWire
}

/**
 * What a call's watch yields: a value whole at one committed snapshot, a read's at `ready` and a write's at its
 * outcome, with the events that made it since the value before, the event that made it whole last.
 */
export interface Answered<V, Ev> {
	readonly value: V
	readonly events: Arr.NonEmptyReadonlyArray<Ev>
}

/**
 * What arrives of an answer, read from its frames: an event of its value, the error that ends it, its end, or the cut
 * of its exchange, with the words of where it broke.
 */
type Arrival<Ev> =
	| { readonly kind: "event"; readonly event: Ev }
	| { readonly kind: "failed"; readonly error: CallError }
	| { readonly kind: "ended" }
	| { readonly kind: "cut"; readonly message: string }

/** What the answer's consumer sees: a value, the error that fails the call, or the call's end. */
type Step<V, Ev> =
	| { readonly kind: "answered"; readonly answered: Answered<V, Ev> }
	| { readonly kind: "failed"; readonly error: CallError }
	| { readonly kind: "ended" }

/**
 * How a call of one shape reads its answer: its state before any event, the event kind after which its value is
 * whole, the fold of a batch of events, the value of a state a batch made whole, and what a cut of the exchange means
 * after the state it left.
 */
interface Reading<St, V, Ev> {
	readonly opening: St
	readonly whole: string
	readonly fold: (state: St, batch: ReadonlyArray<Ev>) => St
	readonly valueOf: (state: St) => V
	readonly cut: (state: St, message: string) => Step<V, Ev>
}

/**
 * A read's reading: whole at `ready`, folded by the live fold. A cut ends a read with `transport`, whatever value it
 * held: a read changed nothing, and the same call may succeed.
 */
const readReading = <S extends ReadShape>(
	shape: S
): Reading<ReadState<S, object>, Keyed<S, object>, ReadEvent<S, object>> => ({
	opening: opening(shape),
	whole: "ready",
	fold,
	valueOf: (state) => {
		if (state.kind !== "ready") {
			throw defect("a read's batch ended at ready with no ready value")
		}
		return state.value
	},
	cut: (_state, message) => ({ kind: "failed", error: callError("transport", { message }) })
})

/**
 * A write's reading: whole at its outcome, folded by the write fold. A cut before the outcome is `commitUnknown`, since
 * the client cannot see whether COMMIT was sent; a cut after it ends the call, whose outcome came.
 */
const writeReading: Reading<WriteState<unknown>, unknown, WriteEvent<unknown>> = {
	opening: writeOpening(),
	whole: "outcome",
	fold: foldWrite,
	valueOf: (state) => {
		if (state.kind !== "ready") {
			throw defect("a write's batch ended at its outcome with no outcome")
		}
		return state.value
	},
	cut: (state, message) =>
		state.kind === "ready"
			? { kind: "ended" }
			: { kind: "failed", error: callError("commitUnknown", { message }) }
}

/** The descriptor of the event `kind` of an answer of shape `shape`: none for a kind the shape has not. */
const descriptorOf = (shape: Shape, kind: string): Option.Option<EventDescriptor> => {
	const table: { readonly [name: string]: EventDescriptor } = events[shape]
	return Option.map(
		Arr.findFirst(Rec.toEntries(table), ([name]) => name === kind),
		([, descriptor]) => descriptor
	)
}

/** The vocabulary a member's codecs spell an Option in: Effect's. */
const wireOptions: WireOptions = {
	some: Option.some,
	none: Option.none(),
	is: Option.isOption,
	match: (option, cases) => Option.match(option, cases)
}

/**
 * The reader of an answer's frames, the server's own, through the member's slot decoders: an item or `ready` is its
 * event, an `error` its CallError, an `end` the end. Its event is the program's, Ev, as the member's wire form says and
 * the server wrote it: the one site of that trust. A frame of a kind the shape has not is a defect of the server.
 */
const framesOf = <Ev>(wire: MemberWire): ((frame: SseEvent) => Arrival<Ev>) => {
	const decoders = slotDecoders(wire, wireOptions)
	return (frame) => {
		const descriptor = Option.getOrThrowWith(descriptorOf(wire.shape, frame.type), () =>
			defect(`an answer's frame of a kind its shape has not, ${frame.type}`)
		)
		const data = trustedJson<{ readonly [member: string]: WireJson }>(frame.data)
		switch (descriptor.role) {
			case "error":
				return { kind: "failed", error: decoders.error(trustedMember(data, "error")) }
			case "end":
				return { kind: "ended" }
			case "item":
			case "ready": {
				const event: Record<string, unknown> = { kind: frame.type }
				for (const [member, slot] of Rec.toEntries(descriptor.payload)) {
					event[member] = decoders[slot](trustedMember(data, member))
				}
				return { kind: "event", event: trusted<Ev>(event) }
			}
		}
	}
}

/**
 * The batch being read: the state after the batches before it, its events so far, held by this read of the answer
 * alone until its value is whole and the batch is handed on, and whether the answer is over.
 */
interface Batch<St, Ev> {
	readonly state: St
	readonly pending: Array<Ev>
	readonly over: boolean
}

/**
 * The next arrival read into the batch: an event joins it, and the event that makes the value whole folds the batch
 * into one value, once per batch, so a read of n rows copies its value once; an error, an end or a cut ends the answer
 * as the shape reads it.
 */
const advance =
	<St, V, Ev extends { readonly kind: string }>(reading: Reading<St, V, Ev>) =>
	(
		batch: Batch<St, Ev>,
		arrival: Arrival<Ev>
	): readonly [Batch<St, Ev>, ReadonlyArray<Step<V, Ev>>] => {
		if (batch.over) {
			return [batch, []]
		}
		switch (arrival.kind) {
			case "event": {
				batch.pending.push(arrival.event)
				if (arrival.event.kind !== reading.whole || !Arr.isArrayNonEmpty(batch.pending)) {
					return [batch, []]
				}
				const state = reading.fold(batch.state, batch.pending)
				const answered = { value: reading.valueOf(state), events: batch.pending }
				return [{ state, pending: [], over: false }, [{ kind: "answered", answered }]]
			}
			case "failed":
				return [{ ...batch, over: true }, [{ kind: "failed", error: arrival.error }]]
			case "ended":
				return [{ ...batch, over: true }, [{ kind: "ended" }]]
			case "cut":
				return [{ ...batch, over: true }, [reading.cut(batch.state, arrival.message)]]
		}
	}

/** Why an exchange gave no answer: the request refused, or a status other than the event stream's 200. */
interface Unanswered {
	readonly message: string
}

/** The frames of the member's answer to one call, its request sent with `token` and the input's JSON. */
const exchange = (
	member: ClientMember,
	token: Option.Option<Redacted.Redacted>,
	input: unknown
): Stream.Stream<SseEvent, Unanswered, HttpClient.HttpClient> => {
	const bearer = Option.match(token, {
		onNone: () => ({}),
		onSome: (given) => ({ authorization: `Bearer ${Redacted.value(given)}` })
	})
	const request = HttpClientRequest.post(member.route, {
		accept: "text/event-stream",
		headers: { "grizzle-wire": member.digest, ...bearer },
		body: HttpBody.text(wireText(encodeInput(member.wire.input, input)), "application/json")
	})
	return request.pipe(
		HttpClient.execute,
		Effect.map((response) =>
			response.status === 200
				? sseEvents(response.stream)
				: Stream.fail({ message: `the server answered ${response.status}, no event stream` })
		),
		Stream.unwrap
	)
}

/**
 * One call's answer read by its shape's reading: each value whole at a committed snapshot with the events that made
 * it, failing with the server's CallError or with the cut of its exchange as the shape reads it, and ending at `end`.
 */
const answer = <St, V, Ev extends { readonly kind: string }>(
	member: ClientMember,
	reading: Reading<St, V, Ev>,
	token: Option.Option<Redacted.Redacted>,
	input: unknown
): Stream.Stream<Answered<V, Ev>, CallError, HttpClient.HttpClient> => {
	const halted = (batch: Batch<St, Ev>): ReadonlyArray<Step<V, Ev>> =>
		batch.over ? [] : [reading.cut(batch.state, "the answer ended before its terminal event")]
	return exchange(member, token, input).pipe(
		Stream.map(framesOf<Ev>(member.wire)),
		Stream.orElseSucceed((broken): Arrival<Ev> => ({ kind: "cut", message: broken.message })),
		Stream.mapAccum(
			(): Batch<St, Ev> => ({ state: reading.opening, pending: [], over: false }),
			advance(reading),
			{ onHalt: halted }
		),
		Stream.takeUntil((step) => step.kind !== "answered"),
		Stream.mapEffect((step) =>
			step.kind === "failed" ? Effect.fail(step.error) : Effect.succeed(step)
		),
		Stream.filterMap((step) =>
			step.kind === "answered" ? Result.succeed(step.answered) : Result.fail(step)
		)
	)
}

/** The token a call sends: none, the token, or what the Effect yields for this call. */
const tokenFor = <E>(
	token: Option.Option<Token<E>>
): Effect.Effect<Option.Option<Redacted.Redacted>, E> =>
	Option.match(token, {
		onNone: () => Effect.succeedNone,
		onSome: (given) =>
			Redacted.isRedacted(given) ? Effect.succeedSome(given) : Effect.asSome(given)
	})

/** A served program's two operations, untyped by its program: its stream of values, and its first value. */
export interface ProgramCalls<V, Ev, E> {
	readonly watch: (
		input: unknown
	) => Stream.Stream<Answered<V, Ev>, CallError | E, HttpClient.HttpClient>
	readonly once: (input: unknown) => Effect.Effect<V, CallError | E, HttpClient.HttpClient>
}

/** The operations of a member read by `reading`, each call's token taken first. */
const callsOf = <St, V, Ev extends { readonly kind: string }, E>(
	member: ClientMember,
	reading: Reading<St, V, Ev>,
	token: Option.Option<Token<E>>
): ProgramCalls<V, Ev, E> => {
	const watch = (
		input: unknown
	): Stream.Stream<Answered<V, Ev>, CallError | E, HttpClient.HttpClient> =>
		tokenFor(token).pipe(
			Effect.map((bearer) => answer(member, reading, bearer, input)),
			Stream.unwrap
		)
	return {
		watch,
		once: (input) =>
			Effect.flatMap(Stream.runHead(watch(input)), (first) =>
				Option.match(first, {
					onNone: () => Effect.die(defect("an answer ended before its first value")),
					onSome: (answered) => Effect.succeed(answered.value)
				})
			)
	}
}

/**
 * A member's operations with the shape its wire form reads them by: a set read's and a list read's, whose values are
 * keyed values, and a write's, whose value is its outcome.
 */
export type ShapedCalls<E> =
	| {
			readonly shape: "set"
			readonly calls: ProgramCalls<Keyed<"set", object>, ReadEvent<"set", object>, E>
	  }
	| {
			readonly shape: "list"
			readonly calls: ProgramCalls<Keyed<"list", object>, ReadEvent<"list", object>, E>
	  }
	| { readonly shape: "write"; readonly calls: ProgramCalls<unknown, WriteEvent<unknown>, E> }

/**
 * A member's operations by its wire form's shape: a set read's and a list read's through the live fold, a write's
 * through the write fold, each chosen once, here, where the member's shape is read.
 */
export const memberCalls = <E>(
	member: ClientMember,
	token: Option.Option<Token<E>>
): ShapedCalls<E> => {
	switch (member.wire.shape) {
		case "set":
			return { shape: "set", calls: callsOf(member, readReading("set"), token) }
		case "list":
			return { shape: "list", calls: callsOf(member, readReading("list"), token) }
		case "write":
			return { shape: "write", calls: callsOf(member, writeReading, token) }
	}
}
