import { Data, Effect, Exit, Scope } from "effect"
import type { Transport } from "#adapter/types/layer.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"

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
}

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
				socket.once("close", () => {
					drawn--
				})
				return socket
			}
		})
	}
}

/**
 * The initialised cluster with the budget every connection opened on it draws from: a test file's, which its lease
 * grants (shared.ts leaseConnections), or one the lease itself, the global setup or the sweep holds outside any file's.
 * Every opener of test support takes one, so no connection is opened outside a budget.
 */
export interface BudgetedCluster extends InitializedClusterShape {
	readonly budget: LeaseBudget
}

/** `cluster` with `budget`. */
export const budgeted = (
	cluster: InitializedClusterShape,
	budget: LeaseBudget
): BudgetedCluster => ({
	...cluster,
	budget
})
