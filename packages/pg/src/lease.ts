import { availableParallelism } from "node:os"
import { Array as Arr } from "effect"
import { indices } from "#compiler/core/array.ts"

/**
 * The most sessions a test's pool holds at once (PoolBounds.max): one per core of the machine, the owner's all-cores
 * default, read from the machine itself. The local cluster runs on the same cores, so more statements at once than the
 * machine has cores only queue for them, and a call past the pool's sessions waits for one.
 */
export const testPoolMax: number = availableParallelism()

/**
 * The sessions a substrate holds for its life besides its lease's: its shared database's claim's, that database's
 * owner's, and the observer's that reads other backends' lock waits (substrate.ts build). The claim has a session of
 * its own: the lease's runs only LOCK, inside the transaction that holds its slot, and a query there would keep its
 * snapshot in the open portal (the extended protocol drops a transaction's unnamed portal only at its next Bind or the
 * transaction's end), holding the backend's xmin for the file's life.
 */
const substrateSessions = ["claim", "owner", "observer"] as const
/**
 * The connections a lease grants its file, the width of the budget every connection the file opens after its lease
 * draws from (budget.ts): a test's full pool (testPoolMax, one session per core) and the sessions its substrate holds
 * besides the lease's.
 */
export const leaseGrant = testPoolMax + substrateSessions.length
/** The connections one test file may hold at once, which one lease covers: what it grants, and its own session. */
export const connectionsPerLease = leaseGrant + 1
/** Connections no lease covers: the global setup, the doctor, the sweep, and an operator's psql. */
export const unleasedConnections = 5

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
 * The installations on the local cluster outside the substrate's databases that serve live reads, each its own live
 * source, slot and walsender: qti-pie's and the dev database's.
 */
const standingInstallations = ["gr8des_qti", "the dev database"] as const

/**
 * The most live sources the local cluster serves at once, which its max_replication_slots and max_wal_senders hold:
 * one leader's slot and walsender per substrate's watched installation, which each substrate holds one of at a time,
 * so one per lease slot a cluster of `maxConnections`, `superuserReserved` and `reserved` connections admits
 * (leaseSlots), and one per standing installation. scripts/pg/init.sh sets both settings to it where they fall short,
 * and scripts/pg/doctor.sh checks them against it.
 */
export const liveSlotBound = (
	maxConnections: number,
	superuserReserved: number,
	reserved: number
): number => leaseSlots(maxConnections, superuserReserved, reserved) + standingInstallations.length

/**
 * A lease's tables in the owner's own database, by their names: one per slot, and the gate a file queues at while every
 * slot is held. The lease only locks them; whoever sets the lease up creates them first, so no lease creates a table
 * while another does: scripts/pg/init.sh creates the substrate's (substrateLeaseNames), and a test of the lease creates
 * its own, so it never takes one of the cluster's slots.
 */
export interface LeaseTables {
	readonly slot: (index: number) => string
	readonly gate: string
}

/** The lease tables named after `stem`: `<stem>_<index>` for each slot, and `<stem>_gate`. */
export const leaseTables = (stem: string): LeaseTables => ({
	slot: (index) => `${stem}_${index}`,
	gate: `${stem}_gate`
})

/** The substrate lease's tables: substrate_lease_<index> for each slot, and substrate_lease_gate. */
export const substrateLease = leaseTables("substrate_lease")

/**
 * The substrate lease's tables a cluster of `maxConnections` connections, `superuserReserved` and `reserved` of them
 * reserved, needs: the gate and one for each of its slots (leaseSlots). lease-tables.ts prints them, init.sh
 * creates them and doctor.sh requires every one.
 */
export const substrateLeaseNames = (
	maxConnections: number,
	superuserReserved: number,
	reserved: number
): ReadonlyArray<string> => [
	substrateLease.gate,
	...Arr.map(indices(leaseSlots(maxConnections, superuserReserved, reserved)), substrateLease.slot)
]
