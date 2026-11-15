import { testWorkers } from "@bjornpagen/testing/workers"
import {
	Array as Arr,
	Config,
	Data,
	Effect,
	FileSystem,
	Option,
	Result,
	String as Str
} from "effect"
import { indices } from "#compiler/core/array.ts"
import { type Limit, measured } from "#compiler/core/limits.ts"
import { clusterAt, type LocalCluster } from "#pg/local-cluster.ts"

import { regex } from "arkregex"

/**
 * c*, the network test files one member of the family runs at once. Every cost it divides is the member's own, a
 * cluster's, and grows with the files that share it: the SSI LWLocks (SerializableFinishedList, SerializableXactHash,
 * SerializablePredicateList) and SxactGlobalXmin, which every SERIALIZABLE transaction of the cluster shares; the safe
 * snapshot a DEFERRABLE read waits for, until every SERIALIZABLE writer of the cluster that began before it has ended;
 * and the one checkpointer, which syncs every file the cluster wrote since its last checkpoint. So it bounds the files
 * per member, and the members' count follows from it (familyMembers), each member's memory from its share (size.ts
 * clusterSize), so a family's total stays what one cluster sized for every worker would hold.
 */
const filesPerCluster: Limit = measured({
	value: 16,
	owner: "grizzle's network test tier (packages/pg/src/family.ts)",
	unit: "test files",
	scope:
		"the network test files one member of the local cluster family runs at once, each in a Vitest worker of its own, at a run's width (the testing library's testWorkers, one file per core), on a member sized for its share",
	evidence:
		"packages/experiments/cluster-share at 14b2e2b9 (deleted in the commit after it): two checkouts of grizzle 0b7b5f31 that differ only in this value, each tagged by tag.sh and on a private family pnpm pg:init made from it (2 members at 32, 4 at 16), run at once by `TEST_SEED=1234567 pair.sh <out> c32 <tree> 5771 c16 <tree> 5781`, every member's pg_stat_activity sampled each second and its SERIALIZABLE transactions every ten as the bootstrap superuser, then `compare.sh <out> c32 c16` with the seven files failing for causes outside this value left out; each member's checkpoint lines from its server log; uncommitted run files in ~/.cache/grizzle-release/IDLEXACT/measure (c32.out, c16.out, c32.wall, c16.wall, c32.<port>.samples, c16.<port>.samples, checkpoints.<port>.log, verdict.txt)",
	observed:
		"2026-11-14 23:08:31 to 2026-11-15 02:06:52 UTC, the two runs at once (16's ended at 01:49:31)",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GB of memory, shared with other lanes' runs (1-minute load 300 to 455 during the runs); the local PostgreSQL 19rc2 (scripts/pg/pin.env), each member sized by pnpm pg:init for its share (size.ts clusterSize: at 32, shared_buffers 1216256 kB and max_connections 2215 a member; at 16, 608128 kB and 1111); grizzle 0b7b5f31 with vendor/toolchain at its pin, whose testWorkers is availableParallelism(), 64; Node 26.13.1, Vitest 5.1.0",
	workload:
		"the whole network tier, 342 files and 594 tests, at 64 workers, TEST_SEED=1234567: at 32, 2 members of 32 files each; at 16, 4 members of 16; the two runs at once, one run at each value",
	result:
		"Wall time 10701 s at 32 and 9660 s at 16, both set by test/pg/substrate/tree.test.ts, the last file of both, cut by its hour (10515 s and 9230 s). Over the 311 files both runs passed, leaving out pg/fin/plans, schedules/install/database-default, pg/serverless/pool, pg/sql/print, pg/migrate/redraft, pg/live/routing and pg/world-model/inductive: 236111 s summed at 32 and 169681 s at 16, a ratio of 0.72, the per-file ratio's median 0.70 and geometric mean 0.69. Files cut by their hour: 23 at 32, 13 at 16, each of 16's also cut at 32 but pg/live/exactness; no other failure. SSI LWLock waiters, as a share of the active backends: 8% and 10% of the members at 32; 1%, 2%, 5% and 1% at 16 (92% on one cluster at be5f3ec4). The oldest SERIALIZABLE transaction: 571 s at 32, 439 s at 16 beside serverless/pool's hung lease (3591 s). Freeze windows (10 s and more with at most two backends on the CPU and half the active ones waiting on SSI's LWLocks): none at 32; one of 12 s at 16, as the hung lease's transaction ended. Checkpoints back to back on every member: 1.07 and 1.11 million files synced a member at 32, 0.59 to 0.92 million at 16, the longest 2267 s and 2296 s. Safe-snapshot waits past 10 s: 5482 samples at 32, 3236 at 16 (2326 of them behind the hung lease). A family's shared memory: 2 x 1454 MB at 32, 4 x 738 MB at 16. No cluster errors",
	decision:
		"16: at this load every measure favors it over 32: 28% less time over the files both runs passed, the ratio steady across them (median 0.70), 9.7% less wall time, ten fewer hour cuts, a tenth to a half of 32's SSI waiting share and less checkpoint sync work a member, for 44 MB more shared memory a family, since each member's memory follows its share (size.ts clusterSize, and init.sh --adopt sizes the members a growing family keeps). Every coupling it divides is a cluster's own, so the quantity is the files one member runs at once. One run at each value, at one seed, on a loaded machine; below 16 is unmeasured. No headroom added",
	revalidate:
		"a run at 8, and at 16 again, at a quiet window; a network tier whose files hold more SERIALIZABLE transactions or hold them longer, or create more databases (the checkpoints' sync work); a change of SSI's settings (max_pred_locks_*), of the checkpoint settings or of the lease's grant (leaseGrant); a PostgreSQL repin; another machine or core count"
})

/**
 * The clusters of a family, K: the network tier's workers spread over them, worker w on member (w − 1) mod K
 * (memberOf), so one cluster's SERIALIZABLE bookkeeping (its SSI lists and their LWLocks, shared by every transaction
 * of the cluster) serves only its share of a run's workers, no more than c* files (filesPerCluster):
 * ceil(testWorkers / c*), testWorkers being the testing library's width, one file per core. A run of fewer files starts
 * fewer workers, spread over the same members. The machine's cores are read where testWorkers is, and enter no Limit.
 */
export const familyMembers: number = Math.ceil(testWorkers / filesPerCluster.value)

/**
 * The workers one member of a family serves at most, which scripts/pg/init.sh sizes each member for (size.ts
 * clusterSize): a run's workers (testWorkers) over the family's members, rounded up, so the members together serve every
 * worker of a run.
 */
export const memberShare: number = Math.ceil(testWorkers / familyMembers)

/**
 * A family of local clusters as its family file records it: its members in member order, the first the cluster
 * GRIZZLE_PG_CLUSTER names, whose state directory holds the family file (familyFile), and exactly familyMembers of
 * them, each on a port of its own.
 */
export interface ClusterFamily {
	readonly members: Arr.NonEmptyReadonlyArray<LocalCluster>
}

/**
 * The family file of the family whose first member is `first`: its members' names, their ports, one a line in member
 * order, in the first member's state directory. scripts/pg/init.sh writes it once every member exists, and every reader
 * of the family reads it, never a formula: a member's port is whatever port was free when init made it.
 */
export const familyFile = (first: LocalCluster): string => `${first.state}/family`

/** A family as its family file holds it. */
export const familyText = (family: ClusterFamily): string =>
	Arr.join(
		Arr.map(family.members, (member) => `${member.port}\n`),
		""
	)

/** A family file no family can be read from: unreadable, or what it holds is no family of its first member's. */
export class FamilyUnrecorded extends Data.TaggedError("FamilyUnrecorded")<{
	readonly file: string
	readonly reason: string
}> {
	override get message(): string {
		return `no cluster family is recorded at ${this.file}: ${this.reason}; scripts/pg/init.sh records one`
	}
}

/** A port in canonical decimal, as a cluster's name spells it (local-cluster.ts selectCluster). */
const portLine = regex("^[1-9][0-9]{0,4}$")

/**
 * The family `text` records for the family of `size` members whose first member is `first`, or why it records none:
 * each line a port in canonical decimal, no port twice, the first `first`'s, and `size` of them. Every reader passes
 * familyMembers; a test passes its own.
 */
export const parseFamily = (
	first: LocalCluster,
	size: number,
	text: string
): Result.Result<ClusterFamily, string> => {
	const lines = Arr.filter(Str.split(text, "\n"), (line) => line.length > 0)
	const bad = Arr.findFirst(lines, (line) => !portLine.test(line) || Number(line) > 65_535)
	if (Option.isSome(bad)) {
		return Result.fail(`"${bad.value}" is no port`)
	}
	const ports = Arr.map(lines, Number)
	if (new Set(ports).size !== ports.length) {
		return Result.fail(`a port is listed twice in ${Arr.join(lines, ", ")}`)
	}
	if (ports.length !== size) {
		return Result.fail(`it lists ${ports.length} members where the family has ${size}`)
	}
	const [head, ...rest] = ports
	if (head !== first.port) {
		return Result.fail(
			`its first member is ${head ?? "missing"}, not ${first.port}, the family's name`
		)
	}
	return Result.succeed({ members: [first, ...Arr.map(rest, clusterAt)] })
}

/** The family whose first member is `first`, as its family file records it (parseFamily). */
export const readFamily = (
	first: LocalCluster
): Effect.Effect<ClusterFamily, FamilyUnrecorded, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const file = familyFile(first)
		const text = yield* Effect.mapError(
			fs.readFileString(file),
			(error) => new FamilyUnrecorded({ file, reason: error.message })
		)
		return yield* Effect.mapError(
			Effect.fromResult(parseFamily(first, familyMembers, text)),
			(reason) => new FamilyUnrecorded({ file, reason })
		)
	})

/**
 * The Vitest worker this process is, from VITEST_POOL_ID, read through Config: a positive decimal integer, else none,
 * a process outside a worker.
 */
export const currentWorker: Effect.Effect<Option.Option<number>> = Effect.map(
	Effect.orDie(Config.option(Config.String("VITEST_POOL_ID"))),
	(value) =>
		Option.flatMap(value, (text) =>
			regex("^[1-9][0-9]*$").test(text) ? Option.some(Number(text)) : Option.none()
		)
)

/** The index of the member worker `worker` runs on in a family of `members` members: (worker − 1) mod members. */
const memberIndexOf = (members: number, worker: number): number => (worker - 1) % members

/**
 * The member a process reaches: worker w's, member (w − 1) mod K of the family (memberIndexOf), so the workers spread
 * over the members, none serving more than its share (memberShare); a process outside a worker reaches the first.
 */
export const memberOf = (family: ClusterFamily, worker: Option.Option<number>): LocalCluster =>
	Option.match(worker, {
		onNone: () => Arr.headNonEmpty(family.members),
		onSome: (w) => Arr.getUnsafe(family.members, memberIndexOf(family.members.length, w))
	})

/**
 * The workers whose files run on member `index` of a family of `members` members, among `workers` workers numbered 1
 * to `workers`: every worker memberIndexOf maps to it, the shared databases the global setup clones on that member.
 */
export const workersOf = (members: number, index: number, workers: number): ReadonlyArray<number> =>
	Arr.filter(
		Arr.map(indices(workers), (i) => i + 1),
		(w) => memberIndexOf(members, w) === index
	)
