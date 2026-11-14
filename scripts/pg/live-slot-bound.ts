import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Option } from "effect"
import { liveSlotBound } from "#test/support/substrate/shared.ts"

import { regex } from "arkregex"

/** A setting's value as its argument spells it: a decimal count, or none for anything else or a missing argument. */
const count = (arg: string | undefined): Option.Option<number> =>
	arg !== undefined && regex("^[0-9]+$").test(arg) ? Option.some(Number(arg)) : Option.none()

/**
 * Prints the live source bound (test/support/substrate/shared.ts liveSlotBound) of a cluster whose max_connections,
 * superuser_reserved_connections and reserved_connections are its three arguments: what scripts/pg/lib.sh
 * live_slot_bound reads for init.sh and doctor.sh, so the shell holds no second spelling of the formula. Any other
 * arguments are refused, with a failing exit.
 */
const main = Effect.gen(function* () {
	const [maxConnections, superuserReserved, reserved, ...rest] = yield* Effect.sync(
		(): ReadonlyArray<string> => process.argv.slice(2)
	)
	const settings = Option.all([count(maxConnections), count(superuserReserved), count(reserved)])
	if (rest.length > 0 || Option.isNone(settings)) {
		return yield* Effect.die(
			new Error(
				"usage: live-slot-bound.ts <max_connections> <superuser_reserved_connections> <reserved_connections>"
			)
		)
	}
	const [connections, superuser, reservedSlots] = settings.value
	yield* Console.log(liveSlotBound(connections, superuser, reservedSlots))
})

NodeRuntime.runMain(main)
