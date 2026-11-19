import * as net from "node:net"
import type { PgMember } from "@bjornpagen/testing/pg"
import { Array as Arr, Data, Effect, Exit, Option, Scope } from "effect"
import type { PgSocket } from "#adapter/types/driver.ts"
import type { Transport } from "#adapter/types/layer.ts"

/**
 * A connection asked of a budget whose every permit is drawn: the budget's width, the connections it grants at once.
 * It is refused at once, before any connection is sent, and never waits, since a test that holds every permit and asks
 * for one more would wait on itself. A test that asks past its budget is a defect of the test, which no test handles,
 * so every opener dies with it: the transport's `open` is synchronous and its throw is the adapter's defect
 * (packages/grizzle/src/adapter/wire/session.ts attemptFor, connectOne, cancelRequest), and the Effect openers die with
 * it alike, so a test reads one refusal however it opened the connection.
 */
export class LeaseBudgetExhausted extends Data.TaggedError("LeaseBudgetExhausted")<{
	readonly width: number
}> {
	override get message(): string {
		return `a connection past the budget of ${this.width}: the file holds every connection its lease grants on the cluster at once`
	}
}

/**
 * The connections a test file may hold on the cluster at once, as permits it draws: every connection test support
 * opens on the cluster draws one for its life, a session of test/support/pg.ts, an adapter session through
 * `transport`, a psql writer and a superuser's client (substrate.ts). A plain counter, so the adapter's synchronous
 * socket factory draws from the same count as an Effect does; past `width` a draw is refused with LeaseBudgetExhausted.
 */
export interface LeaseBudget {
	/** The permits the budget grants at once. */
	readonly width: number
	/**
	 * The connection `open` opens, in the current scope, drawing one permit for its life: drawn before `open` runs, so
	 * nothing is sent when none is free (LeaseBudgetExhausted, a defect), given back when the scope closes, after `open`'s
	 * own finalizers, and at once when `open` fails, so a connection refused holds none.
	 */
	readonly opened: <A, E, R>(
		open: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E, Exclude<R, Scope.Scope> | Scope.Scope>
	/**
	 * `width` permits drawn at once for the current scope, as a budget of exactly them: what a pool or a child process
	 * that holds that many connections at most draws when it is built, its own connections then drawing from it.
	 * LeaseBudgetExhausted, a defect, when fewer are free, and none is drawn.
	 */
	readonly within: (width: number) => Effect.Effect<LeaseBudget, never, Scope.Scope>
	/**
	 * `transport` whose every socket draws one permit as `open` makes it, before anything is sent on it, and gives it back
	 * when the socket closes, its TLS upgrade's end included. `open` throws LeaseBudgetExhausted when none is free. A
	 * CancelRequest's connection holds no backend, but the transport opens it as it opens a session's, so it draws one for
	 * the moment it lives.
	 */
	readonly transport: (transport: Transport) => Transport
	/**
	 * The connections the budget's openers hold open now (HeldConnection): every socket of `transport` that connected and
	 * is not destroyed, by its ports, and every backend `hold` holds.
	 */
	readonly held: () => ReadonlyArray<HeldConnection>
	/**
	 * `pid`, the backend a session opened in the current scope runs on, as the session read it as it opened, held until
	 * the scope closes: what a session opened outside `transport` (a raw session, a psql writer) states of itself.
	 */
	readonly hold: (pid: number) => Effect.Effect<void, never, Scope.Scope>
}

/**
 * A connection test support holds open on the cluster: a socket `transport` opened, connected and has not destroyed,
 * by its own port and the server's, which name its backend's client in pg_stat_activity; or a backend a session read its
 * own pid of and holds (`hold`). What a role's release tells a session still open from one ended and on its way out
 * (kernel/sanitize.ts heldBackends).
 */
export type HeldConnection =
	| { readonly kind: "socket"; readonly local: number; readonly remote: number }
	| { readonly kind: "backend"; readonly pid: number }

/** A budget of `width` permits, none drawn. */
export const leaseBudget = (width: number): LeaseBudget => {
	let drawn = 0
	/** Draws `count` permits when that many are free: whether it did. */
	const draw = (count: number): boolean => {
		if (drawn + count > width) {
			return false
		}
		drawn += count
		return true
	}
	const permits = (count: number): Effect.Effect<void, never, Scope.Scope> =>
		Effect.acquireRelease(
			Effect.suspend(() =>
				draw(count) ? Effect.void : Effect.die(new LeaseBudgetExhausted({ width }))
			),
			() =>
				Effect.sync(() => {
					drawn -= count
				})
		)
	/** Every socket `transport` opened that has not closed, with its ports once it connected. */
	const sockets = new Map<
		PgSocket,
		Option.Option<{ readonly local: number; readonly remote: number }>
	>()
	/** The backends `hold` holds, one entry each, its own until its scope closes. */
	const backends = new Set<{ readonly pid: number }>()
	return {
		width,
		opened: (open) =>
			Effect.gen(function* () {
				const scope = yield* Effect.scope
				const own = yield* Scope.fork(scope)
				yield* Scope.provide(permits(1), own)
				return yield* Effect.onError(Scope.provide(open, own), (cause) =>
					Scope.close(own, Exit.failCause(cause))
				)
			}),
		within: (inner) => Effect.as(permits(inner), leaseBudget(inner)),
		transport: (transport) => ({
			...transport,
			open: () => {
				if (!draw(1)) {
					throw new LeaseBudgetExhausted({ width })
				}
				const socket = transport.open()
				sockets.set(socket, Option.none())
				if (socket instanceof net.Socket) {
					socket.once("connect", () => {
						const { localPort, remotePort } = socket
						if (sockets.has(socket) && localPort !== undefined && remotePort !== undefined) {
							sockets.set(socket, Option.some({ local: localPort, remote: remotePort }))
						}
					})
				}
				socket.once("close", () => {
					drawn--
					sockets.delete(socket)
				})
				return socket
			}
		}),
		held: () => [
			...Arr.flatMap([...sockets], ([socket, ports]) =>
				socket.destroyed
					? []
					: Option.match(ports, {
							onNone: () => [],
							onSome: (p): ReadonlyArray<HeldConnection> => [{ kind: "socket", ...p }]
						})
			),
			...Arr.map([...backends], (b): HeldConnection => ({ kind: "backend", pid: b.pid }))
		],
		hold: (pid) =>
			Effect.asVoid(
				Effect.acquireRelease(
					Effect.sync(() => {
						const entry = { pid }
						backends.add(entry)
						return entry
					}),
					(entry) =>
						Effect.sync(() => {
							backends.delete(entry)
						})
				)
			)
	}
}

/**
 * The initialised cluster with the budget every connection opened on it draws from: a test file's, which its lease
 * grants (shared.ts leaseConnections), or one the lease itself, the global setup or the sweep holds outside any file's.
 * Every opener of test support takes one, so no connection is opened outside a budget.
 */
export interface BudgetedCluster extends PgMember {
	readonly budget: LeaseBudget
}

/** `cluster` with `budget`. */
export const budgeted = (cluster: PgMember, budget: LeaseBudget): BudgetedCluster => ({
	...cluster,
	budget
})
