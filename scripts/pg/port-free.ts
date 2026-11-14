import { lookup } from "node:dns/promises"
import { createServer } from "node:net"
import { NodeRuntime } from "@effect/platform-node"
import { Data, Effect } from "effect"
import { localCluster } from "#test/support/env.ts"

/** The cluster's port cannot be listened on at an address localhost names: it is taken there, or not this user's. */
class PortTaken extends Data.TaggedError("PortTaken")<{
	readonly address: string
	readonly port: number
	readonly cause: Error
}> {
	override get message(): string {
		return `port ${this.port} at ${this.address}: ${this.cause.message}`
	}
}

/** localhost's addresses cannot be read. */
class LocalhostUnresolved extends Data.TaggedError("LocalhostUnresolved")<{
	readonly cause: unknown
}> {}

/** Listens on `port` at `address` and closes again, or fails with why it could not. */
const bind = (address: string, port: number): Effect.Effect<void, PortTaken> =>
	Effect.callback<void, PortTaken>((resume) => {
		const server = createServer()
		server.once("error", (cause) => {
			resume(Effect.fail(new PortTaken({ address, port, cause })))
		})
		server.listen({ port, host: address, exclusive: true }, () => {
			server.close(() => {
				resume(Effect.void)
			})
		})
	})

/**
 * Succeeds when the port of the local cluster GRIZZLE_PG_CLUSTER selects (test/support/env.ts localCluster) is free on
 * every address localhost names, each of which the cluster's listen_addresses = 'localhost' binds (scripts/pg/init.sh),
 * and otherwise fails with the first address it is taken at, with a failing exit: init.sh creates no cluster on a taken port.
 */
const main = Effect.gen(function* () {
	const addresses = yield* Effect.tryPromise({
		try: () => lookup("localhost", { all: true }),
		catch: (cause) => new LocalhostUnresolved({ cause })
	})
	yield* Effect.forEach(addresses, ({ address }) => bind(address, localCluster.port), {
		discard: true
	})
})

NodeRuntime.runMain(main)
