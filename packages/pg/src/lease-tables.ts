import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Option } from "effect"
import { substrateLeaseNames } from "#pg/lease.ts"

import { regex } from "arkregex"

/** A setting's value as its argument spells it: a decimal count, or none for anything else or a missing argument. */
const count = (arg: string | undefined): Option.Option<number> =>
	arg !== undefined && regex("^[0-9]+$").test(arg) ? Option.some(Number(arg)) : Option.none()

/**
 * Prints the names of the substrate lease's tables (lease.ts substrateLeaseNames), one per line,
 * for a cluster whose max_connections, superuser_reserved_connections and reserved_connections are its three
 * arguments: what scripts/pg/lib.sh lease_tables reads for init.sh, which creates them, and doctor.sh, which requires
 * them, so the shell holds no second spelling of the slots' formula or of the names. Any other arguments are refused,
 * with a failing exit.
 */
const main = Effect.gen(function* () {
	const [maxConnections, superuserReserved, reserved, ...rest] = yield* Effect.sync(
		(): ReadonlyArray<string> => process.argv.slice(2)
	)
	const settings = Option.all([count(maxConnections), count(superuserReserved), count(reserved)])
	if (rest.length > 0 || Option.isNone(settings)) {
		return yield* Effect.die(
			new Error(
				"usage: lease-tables.ts <max_connections> <superuser_reserved_connections> <reserved_connections>"
			)
		)
	}
	const [connections, superuser, reservedSlots] = settings.value
	yield* Effect.forEach(
		substrateLeaseNames(connections, superuser, reservedSlots),
		(name) => Console.log(name),
		{ discard: true }
	)
})

NodeRuntime.runMain(main)
