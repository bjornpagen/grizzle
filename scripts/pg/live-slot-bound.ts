/**
 * Prints the live source bound (test/support/substrate/shared.ts liveSlotBound) of a cluster whose max_connections,
 * superuser_reserved_connections and reserved_connections are its three arguments: what scripts/pg/lib.sh
 * live_slot_bound reads for init.sh and doctor.sh, so the shell holds no second spelling of the formula.
 */
import { liveSlotBound } from "#test/support/substrate/shared.ts"

const settings = process.argv.slice(2).map(Number)
if (settings.length !== 3 || settings.some(Number.isNaN)) {
	throw new Error(
		"usage: live-slot-bound.ts <max_connections> <superuser_reserved_connections> <reserved_connections>"
	)
}
const [maxConnections, superuserReserved, reserved] = settings
console.log(liveSlotBound(maxConnections, superuserReserved, reserved))
