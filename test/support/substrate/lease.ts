import { availableParallelism } from "node:os"
import { indices } from "@bjornpagen/grizzle-text/base/array"
import { Array as Arr, Record as Rec } from "effect"

/**
 * The most sessions a test's pool holds at once (PoolBounds.max): one per core of the machine, the owner's all-cores
 * default, read from the machine itself. The local cluster runs on the same cores, so more statements at once than the
 * machine has cores only queue for them, and a call past the pool's sessions waits for one.
 */
export const testPoolMax: number = availableParallelism()

/**
 * The sessions a substrate holds for its life besides its lease's: its database's owner's, and the observer's that
 * reads other backends' lock waits (substrate.ts build). The lease's own session runs only LOCK, inside the transaction
 * that holds its slot, and a query there would keep its snapshot in the open portal (the extended protocol drops a
 * transaction's unnamed portal only at its next Bind or the transaction's end), holding the backend's xmin for the
 * lease's life, so no substrate's work runs on it.
 */
const substrateSessions = ["owner", "observer"] as const
/**
 * The connections a lease grants its file, the width of the budget every connection the file opens after its lease
 * draws from (budget.ts): a test's full pool (testPoolMax, one session per core) and the sessions its substrate holds
 * besides the lease's.
 */
export const leaseGrant = testPoolMax + substrateSessions.length
/** The connections one test file may hold at once, which one lease covers: what it grants, and its own session. */
export const connectionsPerLease = leaseGrant + 1
/** Whom a session outside every lease connects as: the cluster's owner, or the bootstrap superuser. */
type UnleasedRole = "owner" | "superuser"

/**
 * The sessions a member serves outside every lease, by who holds them, each by the role it connects as, every one its
 * holder may hold at once: the doctor's (toolchain-pg doctor, one psql at a time, its owner checks and, between them,
 * its admin checks, which are the superuser's), the runner's collection (toolchain-test's, one session a member before
 * its workers start), and the sweep (shared.ts sweep, a bench's: its admin, and the bootstrap superuser's session it
 * drops an owner login on, substrate.ts dropRole).
 */
export const unleasedSessions = {
	doctor: ["owner"],
	collection: ["owner"],
	sweep: ["owner", "superuser"]
} as const satisfies Readonly<Record<string, ReadonlyArray<UnleasedRole>>>

/**
 * The connections no lease covers that a member's sizing sets aside (pg.config.ts): the owner's sessions of
 * unleasedSessions. The bootstrap superuser's sessions, the sweep's, an operator's `pnpm pg admin`, the doctor's admin
 * checks and a member's lease setup (shared.ts ensureMemberSetUp), take PostgreSQL's superuser_reserved_connections,
 * which the sizing adds on top.
 *
 * @limitKind derived
 * @owner grizzle's network test tier (test/support/substrate/lease.ts)
 * @unit connections
 * @scope the owner's sessions one member serves outside every lease at once
 * @derivation every holder of unleasedSessions may hold its sessions at once (a doctor beside a run that collects
 *   beside a bench's sweep), so the member sets aside every one of them that is the owner's
 * @from {@link unleasedSessions}
 */
export const unleasedConnections = Arr.filter(
	Arr.flatten(Rec.values(unleasedSessions)),
	(role) => role === "owner"
).length

/**
 * The lease slots a cluster of `maxConnections` connections, `superuserReserved` and `reserved` of them reserved,
 * admits. Each slot costs its lease's connections (connectionsPerLease) and one more, the connection the gate's head
 * races it with while every slot is held (takeLease), except the slot the head wins, whose race connection is its
 * lease's own: s × connectionsPerLease + (s − 1) fits the connections no lease covers set aside. takeLease reads the
 * three settings from the server it leases on, so a cluster with more connections admits more processes.
 */
export const leaseSlots = (
	maxConnections: number,
	superuserReserved: number,
	reserved: number
): number =>
	Math.max(
		1,
		Math.floor(
			(maxConnections - superuserReserved - reserved - unleasedConnections + 1) /
				(connectionsPerLease + 1)
		)
	)

/**
 * A lease's tables in the owner's own database, by their names: one per slot, and the gate a file queues at while every
 * slot is held. The lease only locks them; the first lease on a member creates them (substrate/shared.ts leaseOn,
 * leaseTableNames), under an advisory lock, so no lease creates a table while another does.
 */
export interface LeaseTables {
	readonly slot: (index: number) => string
	readonly gate: string
}

/** The lease tables named after `stem`: `<stem>_<index>` for each slot, and `<stem>_gate`. */
const leaseTables = (stem: string): LeaseTables => ({
	slot: (index) => `${stem}_${index}`,
	gate: `${stem}_gate`
})

/** The substrate lease's tables: substrate_lease_<index> for each slot, and substrate_lease_gate. */
export const substrateLease = leaseTables("substrate_lease")

/** `tables`' names for `slots` slots: the gate and one table for each slot, the tables a lease on them locks. */
export const leaseTableNames = (tables: LeaseTables, slots: number): ReadonlyArray<string> => [
	tables.gate,
	...Arr.map(indices(slots), tables.slot)
]
