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
 * an answer no format reads or a slot's secret that is no key, which are `failed`, and a migration of the installation,
 * `stale`, which the process's served files then are; the server's own report keeps its hint, which names the setting
 * a refusal like 53400's asks to raise.
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
		case "SourceMigrated":
			return callError("stale", { message: reason.message })
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
 * `changes` continues from the value its client holds each time it runs, so a consumer may stop and run it again, and
 * a run it interrupts marks the subscription again. `turn` is one turn now, never waiting: none where the subscription
 * is clean or its run read the same value, else that run's events. `state` reads where its subscription stands now:
 * `clean`, `marked` or `ended`.
 */
export interface Live<E> {
	readonly initial: Stream.Stream<E>
	readonly changes: Stream.Stream<E>
	readonly turn: Effect.Effect<Option.Option<ReadonlyArray<E>>>
	readonly state: Effect.Effect<SubscriptionState["kind"]>
}

/** The layer's registry: what a live read registers on, for as long as the scope it registers in. */
export interface Subscriptions {
	readonly register: <S extends ReadShape, Row extends object, E>(
		request: LiveRequest<S, Row, E>
	) => Effect.Effect<Live<E>, never, Scope.Scope>
}

/**
 * The registry of no installation's live source: a live source's built over a login whose served file holds none
 * (pool/live.ts), and a layer's whose login's file holds none (pool/served.ts), which none of its own calls reaches,
 * since it has no watched read. A read registered on it, which only a layer of another login of the installation
 * provided with such a source can register, ends at once with `failed`, and nothing connects.
 */
export const unsourced: Subscriptions = {
	register: (request) =>
		Effect.sync(() => {
			const error = callError("failed", {
				message:
					"the live source was built over a login whose served file holds no live source: build it over one that serves a read"
			})
			return {
				initial: Stream.make(request.answer.error(error)),
				changes: Stream.make(request.answer.end),
				turn: Effect.succeedSome([request.answer.end]),
				state: Effect.succeed<SubscriptionState["kind"]>("ended")
			}
		})
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
 * What one run of a live read came to: a turn (Turn), or the same value read again, `unchanged`, with what it read, or a
 * run SERIALIZABLE refused, `refused`.
 */
type Ran<S extends ReadShape, Row extends object, E> =
	| Turn<S, Row, E>
	| { readonly kind: "unchanged"; readonly value: Keyed<S, Row> }
	| { readonly kind: "refused" }

/** What a read's token's expiry ends it with. */
const expired = { kind: "ended", error: tokenExpired() } as const

/**
 * `effect` bounded by `expiry`: at the expiry's instant it is interrupted and `expiredAs` answers in its place, and at
 * once when the instant has passed.
 */
const expiring = <A>(expiry: Expiry, effect: Effect.Effect<A>, expiredAs: A): Effect.Effect<A> => {
	switch (expiry.kind) {
		case "never":
			return effect
		case "at":
			return Effect.flatMap(Clock.currentTimeMillis, (now) =>
				now >= expiry.epochMillis
					? Effect.succeed(expiredAs)
					: Effect.raceFirst(
							effect,
							Effect.as(Effect.sleep(Duration.millis(expiry.epochMillis - now)), expiredAs)
						)
			)
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
						turn: Effect.succeedSome([answer.end]),
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
						for (const event of events) {
							seen.push(event)
						}
						return events
					}),
					Stream.onEnd(
						Effect.sync(() => {
							const folded = answer.settle(seen)
							if (folded.kind === "ready") {
								holding.value = folded.value
							}
							Deferred.doneUnsafe(first, Effect.succeed(folded))
						})
					)
				)

				/** The value the subscription's client holds: the one its initial run or its last batch left. */
				const holding: { value: Keyed<S, Row> | undefined } = { value: undefined }

				/**
				 * One run of the read from the held value, the subscription marked: it clears the mark, unless it ended
				 * meanwhile, runs the read, and answers the change from the held value to what it read, or `unchanged` with
				 * what it read where that is the same value. A run SERIALIZABLE refused changed nothing, so its value has not
				 * advanced and the subscription is marked again, `refused`; any other error ends it. A run interrupted marks
				 * the subscription again, so a later pull runs it. The value is held only where its caller sends the change
				 * (hold), so a change a consumer never received is diffed again.
				 */
				const rerun = (value: Keyed<S, Row>): Effect.Effect<Ran<S, Row, E>> =>
					Effect.suspend(() => {
						if (subscription.state.kind === "marked") {
							subscription.state = cleanState
						}
						return Effect.onInterrupt(
							Effect.flatMap(
								Stream.runCollect(request.read),
								(events): Effect.Effect<Ran<S, Row, E>> => {
									const after = answer.settle(events)
									switch (after.kind) {
										case "ready": {
											const changes = answer.diff(value, after.value)
											return Effect.succeed(
												changes.length > 0
													? { kind: "changed", changes, value: after.value }
													: { kind: "unchanged", value: after.value }
											)
										}
										case "failed":
											if (after.error.kind === "transient") {
												markSubscription(subscription)
												return Effect.succeed({ kind: "refused" })
											}
											return Effect.succeed({ kind: "ended", error: after.error })
										case "opening":
										case "provisional":
											return Effect.die(
												defect("a live read's run ended before its ready or its error")
											)
									}
								}
							),
							() =>
								Effect.sync(() => {
									markSubscription(subscription)
								})
						)
					})

				/** `value` held: what a turn's run read, once its change is sent or found none. */
				const hold = (value: Keyed<S, Row>): void => {
					holding.value = value
				}

				/** The value held, once the initial run reached it: what every turn runs from. */
				const held = (value: Keyed<S, Row> | undefined): Effect.Effect<Keyed<S, Row>> =>
					value === undefined
						? Effect.die(defect("a live read's turn ran before its initial value"))
						: Effect.succeed(value)

				/**
				 * The subscription's next change from the value its client holds: it waits until it is marked, then runs
				 * the read, again at once while a run changes nothing or SERIALIZABLE refuses it, since its progress is bound
				 * to commits, never to a time; its own end ends it.
				 */
				const next: Effect.Effect<Turn<S, Row, E>> = Effect.flatMap(
					settled(subscription),
					(mark): Effect.Effect<Turn<S, Row, E>> =>
						mark.kind === "ended"
							? Effect.succeed({ kind: "ended", error: mark.error })
							: Effect.flatMap(
									Effect.flatMap(
										Effect.suspend(() => held(holding.value)),
										rerun
									),
									(turn): Effect.Effect<Turn<S, Row, E>> => {
										switch (turn.kind) {
											case "unchanged":
												hold(turn.value)
												return next
											case "refused":
												return next
											case "changed":
											case "ended":
												return Effect.succeed(turn)
										}
									}
								)
				)

				/** A turn's events: its change then `ready`, or its error then `end`. */
				const eventsOf = (turn: Turn<S, Row, E>): ReadonlyArray<E> =>
					turn.kind === "changed"
						? [...turn.changes, answer.ready]
						: [answer.error(turn.error), answer.end]

				const live: Stream.Stream<E> = Stream.paginate(true, () =>
					Effect.map(
						expiring(request.expiry, next, expired),
						(turn): readonly [ReadonlyArray<E>, Option.Option<boolean>] => {
							if (turn.kind === "changed") {
								hold(turn.value)
								return [eventsOf(turn), Option.some(true)]
							}
							return [eventsOf(turn), Option.none()]
						}
					)
				)

				const changes = first.pipe(
					Deferred.await,
					Effect.map((folded) => (folded.kind === "ready" ? live : Stream.make(answer.end))),
					Stream.unwrap
				)

				/**
				 * One turn now, never waiting: none where the subscription is clean; its error then `end` where it ended;
				 * else its read run (rerun) under its expiry, again while SERIALIZABLE refuses it, its change then `ready`
				 * where it changed the held value, its error then `end` where it ended, none where it read the same value.
				 */
				const once: Effect.Effect<Option.Option<ReadonlyArray<E>>> = Effect.suspend(() => {
					const mark = subscription.state
					switch (mark.kind) {
						case "clean":
							return Effect.succeedNone
						case "ended":
							return Effect.succeedSome(eventsOf({ kind: "ended", error: mark.error }))
						case "marked":
							return Effect.flatMap(
								Effect.flatMap(held(holding.value), (value) =>
									expiring(request.expiry, rerun(value), expired)
								),
								(ran): Effect.Effect<Option.Option<ReadonlyArray<E>>> => {
									switch (ran.kind) {
										case "refused":
											return once
										case "unchanged":
											hold(ran.value)
											return Effect.succeedNone
										case "changed":
											hold(ran.value)
											return Effect.succeedSome(eventsOf(ran))
										case "ended":
											return Effect.succeedSome(eventsOf(ran))
									}
								}
							)
					}
				})

				const turn: Effect.Effect<Option.Option<ReadonlyArray<E>>> = Effect.flatMap(
					Deferred.await(first),
					(folded) => (folded.kind === "ready" ? once : Effect.succeedSome([answer.end]))
				)
				return { initial, changes, turn, state }
			})

		return { register }
	})
