import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Console, Effect, Option } from "effect"
import { liveSlotBound, substrateLeaseNames } from "#pg/lease.ts"

import { regex } from "arkregex"

/** A setting's value as its argument spells it: a decimal count, or none for anything else or a missing argument. */
const count = (arg: string | undefined): Option.Option<number> =>
	arg !== undefined && regex("^[0-9]+$").test(arg) ? Option.some(Number(arg)) : Option.none()

/**
 * Prints what the connection lease asks of a cluster whose max_connections, superuser_reserved_connections and
 * reserved_connections are its three arguments: on the first line its live source bound (lease.ts liveSlotBound), which
 * max_replication_slots and max_wal_senders must each hold, then the names of the substrate lease's tables
 * (lease.ts substrateLeaseNames), one per line. It is what scripts/pg/lib.sh lease_facts reads for init.sh, which
 * creates the tables and raises the settings, and doctor.sh, which requires both, so the shell holds no second spelling
 * of the formulas or of the names, and a member's facts cost one process. Any other arguments are refused, with a
 * failing exit.
 */
const main = Effect.gen(function* () {
	const [maxConnections, superuserReserved, reserved, ...rest] = yield* Effect.sync(
		(): ReadonlyArray<string> => process.argv.slice(2)
	)
	const settings = Option.all([count(maxConnections), count(superuserReserved), count(reserved)])
	if (rest.length > 0 || Option.isNone(settings)) {
		return yield* Effect.die(
			new Error(
				"usage: lease-facts.ts <max_connections> <superuser_reserved_connections> <reserved_connections>"
			)
		)
	}
	const [connections, superuser, reservedSlots] = settings.value
	yield* Console.log(liveSlotBound(connections, superuser, reservedSlots))
	yield* Effect.forEach(
		substrateLeaseNames(connections, superuser, reservedSlots),
		(name) => Console.log(name),
		{ discard: true }
	)
})

NodeRuntime.runMain(main)
