import { Clock, Deferred, Duration, Effect, Option, Result, type Scope, Stream } from "effect"
import type { Expiry } from "#adapter/db/claims.ts"
import type { ServerError } from "#adapter/errors/failures.ts"
import { addRoutes, removeRoutes, route, type RouteIndex } from "#adapter/live/router.ts"
import type { ChangeSink, ChangeSource, SourceLoss, SourceRefusal } from "#adapter/live/source.ts"
import {
	type CallError,
	callError,
	type Keyed,
	type ReadShape,
	type ReadState
} from "#compiler/live/index.ts"
import { defect, type RouteKey } from "#compiler/plan/runtime.ts"

/**
 * A layer's live reads: one registry per DbLayer, explicit state its scope owns and closes (pool/served.ts
 * ServedSessions), which holds the layer's one change source (live/source.ts) and the routing index of every
 * subscription registered on it (live/router.ts).
 *
 * The source is opened when the first read registers, in a scope of the layer's own, so it outlives every subscription
 * and closes with the layer; once it is lost, every subscription on it ends, and the next read to register opens
 * another. A source that does not open ends the read that waited for it, and the next opens another.
 *
 * A subscription is registered before its first read begins, so every change its first read's snapshot misses is
 * routed to it: its state is `clean`, `marked` once a change touched its rows since its last read began, or `ended`
 * with the error that ends it. A change only marks it, so a write rate costs it nothing; a read only clears it, just
 * before it begins, so any change after that marks it again. Its stream re-reads only when it is pulled and marked:
 * Effect's backpressure is its coalescing, and what it holds is the one value its client last received.
 */
type SubscriptionState =
	| { readonly kind: "clean" }
	| { readonly kind: "marked" }
	| { readonly kind: "ended"; readonly error: CallError }

const cleanState: SubscriptionState = { kind: "clean" }
const markedState: SubscriptionState = { kind: "marked" }

/** One registered read: its state, and the wait of its stream for the state to leave `clean`, if it waits. */
interface Subscription {
	state: SubscriptionState
	waiting: Deferred.Deferred<void> | undefined
}

/** The subscription's stream, waiting for its state to leave `clean`, resumed. */
const wake = (subscription: Subscription): void => {
	const waiting = subscription.waiting
	if (waiting !== undefined) {
		subscription.waiting = undefined
		Deferred.doneUnsafe(waiting, Effect.void)
	}
}

/** A change touched the subscription's rows: a clean one is marked; a marked or ended one stays as it is. */
const markSubscription = (subscription: Subscription): void => {
	if (subscription.state.kind === "clean") {
		subscription.state = markedState
		wake(subscription)
	}
}

/** The subscription ended with `error`, unless it already ended. */
const endSubscription = (subscription: Subscription, error: CallError): void => {
	if (subscription.state.kind !== "ended") {
		subscription.state = { kind: "ended", error }
		wake(subscription)
	}
}

/** The subscription's state once it is no longer clean: marked, or ended. */
const settled = (
	subscription: Subscription
): Effect.Effect<Exclude<SubscriptionState, { readonly kind: "clean" }>> =>
	Effect.suspend(() => {
		const state = subscription.state
		if (state.kind !== "clean") {
			return Effect.succeed(state)
		}
		const waiting = Deferred.makeUnsafe<void>()
		subscription.waiting = waiting
		return Effect.flatMap(Deferred.await(waiting), () => settled(subscription))
	})

/**
 * One opening of the layer's change source and what it routes to: `opening` until its source succeeds, `open` while
 * keys reach its index, and `lost` with the error that ended it, after which it routes nothing again. Its subscriptions
 * are its members, each under its keys in its index; `opened` is done once it leaves `opening`, and `ended` once it is
 * lost, which closes the scope its source runs in.
 */
interface Generation {
	state:
		| { readonly kind: "opening" }
		| { readonly kind: "open" }
		| { readonly kind: "lost"; readonly error: CallError }
	readonly members: Set<Subscription>
	readonly index: RouteIndex<Subscription>
	readonly opened: Deferred.Deferred<void, CallError>
	readonly ended: Deferred.Deferred<void>
}

/** A server's report as a read's error states it: its message, and its hint where it gives one. */
const reported = (error: ServerError): string =>
	error.hint === undefined ? error.message : `${error.message} (${error.hint})`

/**
 * The error a source's refusal or loss ends a read with: `unavailable`, which a client calls again, for every one but
 * an answer no format reads or a slot's secret that is no key, which are `failed`; the server's own report keeps its
 * hint, which names the setting a refusal like 53400's asks to raise.
 */
const sourceError = (reason: SourceRefusal | SourceLoss): CallError => {
	switch (reason._tag) {
		case "ServerError":
			return callError("unavailable", { message: reported(reason) })
		case "LeaderFailed":
			return callError("unavailable", {
				message:
					reason.reason._tag === "ServerError"
						? `the installation's live leader in this process failed: ${reported(reason.reason)}`
						: reason.message
			})
		case "UnreadableAnswer":
		case "SecretUnreadable":
			return callError("failed", { message: reason.message })
		case "CredentialError":
		case "ConnectTimedOut":
		case "SocketFailed":
		case "StartupRefused":
		case "TlsRefused":
		case "ConnectionClosed":
		case "DriverRefused":
		case "NoCancelKey":
		case "ConnectionLost":
		case "DriverFailure":
		case "InputTooLarge":
		case "SlotAbsent":
		case "ListenerLost":
		case "SourceInvalidated":
			return callError("unavailable", { message: reason.message })
	}
}

/** The error a source's scope closing ends its reads with: the layer was released. */
const sourceClosed = (): CallError =>
	callError("unavailable", {
		message: "the DbLayer the live read was registered on has been released"
	})

/** The error a read's token's expiry ends it with. */
const tokenExpired = (): CallError =>
	callError("tokenExpired", { message: "the token the Db was opened with expired" })

/** The generation open: a subscription waiting for it registers. */
const openGeneration = (generation: Generation): void => {
	if (generation.state.kind === "opening") {
		generation.state = { kind: "open" }
		Deferred.doneUnsafe(generation.opened, Effect.void)
	}
}

/**
 * The generation lost with `error`, unless it already is: a subscription waiting for it is refused, every member ends,
 * and its source's scope closes.
 */
const loseGeneration = (generation: Generation, error: CallError): void => {
	if (generation.state.kind === "lost") {
		return
	}
	generation.state = { kind: "lost", error }
	Deferred.doneUnsafe(generation.opened, Effect.fail(error))
	for (const member of generation.members) {
		endSubscription(member, error)
	}
	Deferred.doneUnsafe(generation.ended, Effect.void)
}

/**
 * How a live read's answer is made, one per read shape (db/handles.ts setAnswer, listAnswer): its events of one run
 * settled into its state from before its reset (live/fold.ts fold), the least change from one value to another as
 * those events (live/fold.ts diffSet, diffList), and its `ready`, its error and its `end`.
 */
export interface LiveAnswer<S extends ReadShape, Row extends object, E> {
	readonly settle: (events: ReadonlyArray<E>) => ReadState<S, Row>
	readonly diff: (previous: Keyed<S, Row>, next: Keyed<S, Row>) => ReadonlyArray<E>
	readonly ready: E
	readonly error: (error: CallError) => E
	readonly end: E
}

/**
 * A read registered live: `read`, one run of it, its answer's events from its reset to its ready or its error, the
 * same statement on the same Db's frame each time it runs, so every run has the subscription's login, role and claims;
 * how its answer is made; the routing keys its changes reach it by (live/router.ts routeKeys); and its Db's expiry,
 * which ends it.
 */
export interface LiveRequest<S extends ReadShape, Row extends object, E> {
	readonly read: Stream.Stream<E>
	readonly answer: LiveAnswer<S, Row, E>
	readonly keys: ReadonlyArray<RouteKey>
	readonly expiry: Expiry
}

/**
 * A registered read's answer: `initial`, its first run's events as they come, or the error its source's refusal ends it
 * with; then `changes`, after its `ready`: each run's change followed by `ready`, so a client's value is whole at a
 * run's snapshot exactly at each `ready`, then the error that ends it and `end`; or `end` alone after an initial error.
 * `state` reads where its subscription stands now: `clean`, `marked` or `ended`.
 */
export interface Live<E> {
	readonly initial: Stream.Stream<E>
	readonly changes: Stream.Stream<E>
	readonly state: Effect.Effect<SubscriptionState["kind"]>
}

/** The layer's registry: what a live read registers on, for as long as the scope it registers in. */
export interface Subscriptions {
	readonly register: <S extends ReadShape, Row extends object, E>(
		request: LiveRequest<S, Row, E>
	) => Effect.Effect<Live<E>, never, Scope.Scope>
}

/** What one turn of a live read came to: a change, with the value it leaves, or the error that ends the read. */
type Turn<S extends ReadShape, Row extends object, E> =
	| {
			readonly kind: "changed"
			readonly changes: ReadonlyArray<E>
			readonly value: Keyed<S, Row>
	  }
	| { readonly kind: "ended"; readonly error: CallError }

/**
 * A turn bounded by `expiry`: it ends with tokenExpired at the expiry's instant, interrupting a run in flight, and at
 * once when the instant has passed.
 */
const expiring = <S extends ReadShape, Row extends object, E>(
	expiry: Expiry,
	turn: Effect.Effect<Turn<S, Row, E>>
): Effect.Effect<Turn<S, Row, E>> => {
	switch (expiry.kind) {
		case "never":
			return turn
		case "at":
			return Effect.flatMap(Clock.currentTimeMillis, (now) => {
				const expired: Turn<S, Row, E> = { kind: "ended", error: tokenExpired() }
				return now >= expiry.epochMillis
					? Effect.succeed(expired)
					: Effect.raceFirst(
							turn,
							Effect.as(Effect.sleep(Duration.millis(expiry.epochMillis - now)), expired)
						)
			})
	}
}

/** The registry of a layer whose change source is `source`, built in the layer's scope. */
export const makeSubscriptions = (
	source: ChangeSource
): Effect.Effect<Subscriptions, never, Scope.Scope> =>
	Effect.map(Effect.scope, (layer) => {
		const registry: { current: Generation | undefined } = { current: undefined }

		const sinkOf = (generation: Generation): ChangeSink => ({
			touched: (key) => {
				route(generation.index, key, markSubscription)
			},
			lost: (reason) => {
				loseGeneration(generation, sourceError(reason))
			}
		})

		/**
		 * The generation's source opened in a scope of its own, which closes once the generation is lost, its source's
		 * refusal or a loss while it opens losing it; the scope of the fiber that runs it is the layer's, whose end
		 * interrupts it and loses it.
		 */
		const run = (generation: Generation): Effect.Effect<void> =>
			Effect.ensuring(
				Effect.scoped(
					Effect.raceFirst(
						Effect.matchEffect(source.open(sinkOf(generation)), {
							onFailure: (refusal) =>
								Effect.sync(() => {
									loseGeneration(generation, sourceError(refusal))
								}),
							onSuccess: () =>
								Effect.flatMap(
									Effect.sync(() => {
										openGeneration(generation)
									}),
									() => Deferred.await(generation.ended)
								)
						}),
						Deferred.await(generation.ended)
					)
				),
				Effect.sync(() => {
					loseGeneration(generation, sourceClosed())
					if (registry.current === generation) {
						registry.current = undefined
					}
				})
			)

		/** The generation subscriptions register on: the current one, or a new one, its source opening. */
		const generationNow: Effect.Effect<Generation> = Effect.suspend(() => {
			const current = registry.current
			if (current !== undefined && current.state.kind !== "lost") {
				return Effect.succeed(current)
			}
			const generation: Generation = {
				state: { kind: "opening" },
				members: new Set(),
				index: new Map(),
				opened: Deferred.makeUnsafe(),
				ended: Deferred.makeUnsafe()
			}
			registry.current = generation
			return Effect.as(Effect.forkIn(run(generation), layer), generation)
		})

		const register = <S extends ReadShape, Row extends object, E>(
			request: LiveRequest<S, Row, E>
		): Effect.Effect<Live<E>, never, Scope.Scope> =>
			Effect.gen(function* () {
				const { answer } = request
				const subscription: Subscription = { state: cleanState, waiting: undefined }
				const state = Effect.sync(() => subscription.state.kind)
				const generation = yield* generationNow
				const opened = yield* generation.opened.pipe(Deferred.await, Effect.result)
				const standing = generation.state
				if (Result.isFailure(opened) || standing.kind !== "open") {
					const error = Result.isFailure(opened)
						? opened.failure
						: standing.kind === "lost"
							? standing.error
							: sourceClosed()
					endSubscription(subscription, error)
					return {
						initial: Stream.make(answer.error(error)),
						changes: Stream.make(answer.end),
						state
					}
				}
				generation.members.add(subscription)
				addRoutes(generation.index, subscription, request.keys)
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						generation.members.delete(subscription)
						removeRoutes(generation.index, subscription, request.keys)
					})
				)
				const first = Deferred.makeUnsafe<ReadState<S, Row>>()
				const seen: Array<E> = []
				const initial = request.read.pipe(
					Stream.mapArray((events) => {
						seen.push(...events)
						return events
					}),
					Stream.onEnd(
						Effect.sync(() => {
							Deferred.doneUnsafe(first, Effect.succeed(answer.settle(seen)))
						})
					)
				)

				/**
				 * The subscription's next change from `value`, the value its client holds: it waits until it is marked, clears
				 * the mark, runs the read again, and answers the change from `value` to what it read; a run that changes
				 * nothing waits again from what it read. A run SERIALIZABLE refused changed nothing, so its value has not
				 * advanced and the subscription is marked again, and runs again at once on a fresh snapshot: its progress is
				 * bound to commits, never to a time; any other error ends it, as does its own end.
				 */
				const next = (value: Keyed<S, Row>): Effect.Effect<Turn<S, Row, E>> =>
					Effect.flatMap(settled(subscription), (mark): Effect.Effect<Turn<S, Row, E>> => {
						if (mark.kind === "ended") {
							return Effect.succeed({ kind: "ended", error: mark.error })
						}
						subscription.state = cleanState
						return Effect.flatMap(Stream.runCollect(request.read), (events) => {
							const after = answer.settle(events)
							switch (after.kind) {
								case "ready": {
									const changes = answer.diff(value, after.value)
									return changes.length > 0
										? Effect.succeed({ kind: "changed", changes, value: after.value })
										: next(after.value)
								}
								case "failed":
									if (after.error.kind === "transient") {
										markSubscription(subscription)
										return next(value)
									}
									return Effect.succeed({ kind: "ended", error: after.error })
								case "opening":
								case "provisional":
									return Effect.die(defect("a live read's run ended before its ready or its error"))
							}
						})
					})

				const live = (value: Keyed<S, Row>): Stream.Stream<E> =>
					Stream.paginate(value, (current) =>
						Effect.map(
							expiring(request.expiry, next(current)),
							(turn): readonly [ReadonlyArray<E>, Option.Option<Keyed<S, Row>>] =>
								turn.kind === "changed"
									? [[...turn.changes, answer.ready], Option.some(turn.value)]
									: [[answer.error(turn.error), answer.end], Option.none()]
						)
					)

				const changes = first.pipe(
					Deferred.await,
					Effect.map((folded) =>
						folded.kind === "ready" ? live(folded.value) : Stream.make(answer.end)
					),
					Stream.unwrap
				)
				return { initial, changes, state }
			})

		return { register }
	})
