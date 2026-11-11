import type { Server, Socket as NetSocket } from "node:net"
import { Effect, FiberSet, MutableRef, Option, Schema, Semaphore } from "effect"
import type { Fiber, Scope } from "effect"

/** A listener could not bind its port on 127.0.0.1. */
export class ListenFailed extends Schema.TaggedError<
	ListenFailed,
	{ readonly brand: unique symbol }
>()("ListenFailed", { cause: Schema.Defect() }) {}

/** The port a listening server's address names. */
const decodeAddress = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))

/**
 * Listens on 127.0.0.1 at a port the system picks, and answers the port. Closing the scope closes the server once its
 * connections are gone; `tracked` destroys them first.
 */
export const listen = (server: Server): Effect.Effect<number, ListenFailed, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.callback<number, ListenFailed>((resume) => {
			server.once("error", (cause) => {
				resume(Effect.fail(ListenFailed.make({ cause })))
			})
			server.listen({ host: "127.0.0.1", port: 0 }, () => {
				resume(
					decodeAddress(server.address()).pipe(
						Effect.map(({ port }) => port),
						Effect.orDie
					)
				)
			})
		}),
		() =>
			Effect.callback<void>((resume) => {
				server.close(() => {
					resume(Effect.void)
				})
			})
	)

/**
 * The server, with its raw connections tracked so that closing the scope destroys every one still open. Acquire it
 * before `listen`, so its release runs after the listener stops accepting and before the server waits to close.
 */
export const tracked = <S extends Server>(server: S): Effect.Effect<S, never, Scope.Scope> => {
	const sockets = new Set<NetSocket>()
	server.on("connection", (socket: NetSocket) => {
		sockets.add(socket)
		socket.once("close", () => {
			sockets.delete(socket)
		})
	})
	return Effect.acquireRelease(Effect.succeed(server), () =>
		Effect.sync(() => {
			sockets.forEach((socket) => {
				socket.destroy()
			})
		})
	)
}

/** Completes once the socket has closed. */
export const closedOf = (conn: NetSocket): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		if (conn.closed) {
			resume(Effect.void)
			return
		}
		const onClose = () => {
			resume(Effect.void)
		}
		conn.once("close", onClose)
		return Effect.sync(() => {
			conn.off("close", onClose)
		})
	})

/**
 * A listener's observations, one at a time. `accept` serves a connection in the current observation, or closes it
 * unserved when there is none; a socket error closes the connection, which a client's reset is; `observe` makes `state` current, runs the effect, then waits until every connection the
 * observation accepted has been served to its close.
 */
type Sessions<S> = Readonly<{
	accept: (conn: NetSocket, serve: (state: S) => Effect.Effect<void>) => void
	observe: <A, E, R>(state: S, run: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}>

/** One observation in progress: its state and the runner that forks its connections' fibers. */
type Current<S> = Readonly<{ state: S; fork: (effect: Effect.Effect<void>) => Fiber.Fiber<void> }>

/** A listener's sessions: none current until an observation starts. */
export const makeSessions = <S>(): Effect.Effect<Sessions<S>> =>
	Effect.gen(function* () {
		const current = MutableRef.make<Option.Option<Current<S>>>(Option.none())
		const lock = yield* Semaphore.make(1)
		const sessions: Sessions<S> = {
			accept: (conn, serve) => {
				conn.on("error", () => {
					conn.destroy()
				})
				Option.match(MutableRef.get(current), {
					onNone: () => {
						conn.destroy()
					},
					onSome: ({ state, fork }) => {
						fork(serve(state))
					}
				})
			},
			observe: (state, run) =>
				Semaphore.withPermits(
					lock,
					1
				)(
					Effect.scoped(
						Effect.gen(function* () {
							const fibers = yield* FiberSet.make<void>()
							const fork = yield* FiberSet.runtime(fibers)()
							yield* Effect.acquireRelease(
								Effect.sync(() => {
									MutableRef.set(current, Option.some({ state, fork }))
								}),
								() =>
									Effect.sync(() => {
										MutableRef.set(current, Option.none())
									})
							)
							const result = yield* run
							yield* FiberSet.awaitEmpty(fibers)
							return result
						})
					)
				)
		}
		return sessions
	})
