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
import { networkWorkers } from "#pg/workers.ts"

import { regex } from "arkregex"

/**
 * c*, the network test files one cluster runs at once at which its SERIALIZABLE commit throughput peaks: past it, more
 * files wait on the cluster's SSI LWLocks (SerializableFinishedList, SerializableXactHash, SerializablePredicateList),
 * which every SERIALIZABLE transaction of the cluster shares, and the cluster commits less. Provisional: measured on a
 * machine other lanes loaded, to be measured again at a quiet window after the cutover.
 */
const filesPerCluster: Limit = measured({
	value: 32,
	owner: "grizzle's network test tier (packages/pg/src/family.ts)",
	unit: "test files",
	scope:
		"the network test files one member of the local cluster family runs at once, each in a Vitest worker of its own, on a member sized for at least that many",
	evidence:
		"`TEST_SEED=1688532047 pnpm -s test:network --maxWorkers=<c> <files>` on one private cluster (GRIZZLE_PG_CLUSTER=<port>, pnpm pg:init, sized for 64 workers) at each c, sampled every 5 s as the bootstrap superuser: `SELECT sum(xact_commit) FROM pg_catalog.pg_stat_database` and, of pg_stat_activity's client backends, the active ones, those waiting on an LWLock named Serializable%, and those on the CPU (active, no wait event), beside the machine's 1-minute load; uncommitted run files in ~/.cache/grizzle-release/LEASEBUDGET/run/cstar (S<c>.tsv, H<c>.tsv, cdefault.tsv)",
	observed:
		"2026-11-14, 04:54 to 07:21 UTC: a full tier run at 64 (04:54 to 07:01), a light run at each c (05:55 to 06:08), heavy windows at each c (06:09 to 07:21)",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GB of memory, shared with other lanes' runs (the load beside each result); the local PostgreSQL 19rc2 (scripts/pg/pin.env) on a private cluster sized for 64 workers (max_connections 4423, shared_buffers 2432512 kB); grizzle f31086cc; Node 26.13.1, Vitest 5.1.0",
	workload:
		"the network tier's 334 files split by their durations in the full run at 64: the 144 that passed within 120 s (light) run to completion at each c of 4, 8, 16, 32 and 64; the other 190 (heavy, the long SERIALIZABLE suites) run for a 600 s window at each c, 16 and 32 twice; c is Vitest's maxWorkers, the files one cluster runs at once, one run at a time",
	result:
		"commits/s over the middle half of each run (its first and last quarters hold the setup's and teardown's sweeps, whose dropped databases leave pg_stat_database), the waiting share of the active backends, and the load. Light: 4 356 (0% of 2.0, load 88), 8 638 (1% of 2.8, 91), 16 1244 (2% of 4.5, 46), 32 2027 (8% of 8.8, 65), 64 1315 (63% of 26.9, 149); wall time 304, 196, 121, 72 and 107 s. Heavy: 4 721 (4% of 3.2, 107), 8 1802 (6% of 5.9, 55), 16 1837 (49% of 20.3, 52) and 1109 (58% of 21.9, 104), 32 1583 (79% of 57.4, 104) and 1727 (79% of 56.0, 83), 64 949 (88% of 93.6, 96). The full tier at 64: 4885 commits/s over its middle half, 89% of 68.8 active backends waiting, 7659 s, 46 tests past their 3600 s timeout. No cluster errors; LeaseBudgetExhausted only in the claim bench, since sized (2ea05562)",
	decision:
		"32, the maximum of the light runs (the one fixed workload run to completion at every c, 2027 commits/s in 72 s) and of the heavy windows at comparable load (83 to 107: 1583 and 1727 at 32, 1109 at 16, 949 at 64, 721 at 4). The heavy windows at 8 and 16 under half that load (1802 and 1837) lie within the spread one count shows across loads (16: 1837 and 1109), so these samples do not tell 16 from 32; between 32 and 64 is unmeasured. No headroom added",
	revalidate:
		"a quiet window after the cutover (load under the cores' count) to tell 16 from 32; a network tier whose files hold more SERIALIZABLE transactions or hold them longer; a change of SSI's settings (max_pred_locks_*) or of the lease's grant (leaseGrant); a PostgreSQL repin; another machine or core count"
})

/**
 * The clusters of a family, K: the network tier's workers spread over them, worker w on member (w − 1) mod K
 * (memberOf), so one cluster's SERIALIZABLE bookkeeping (its SSI lists and their LWLocks, shared by every transaction
 * of the cluster) serves only its share of the run, no more than c* files (filesPerCluster): ceil(networkWorkers / c*).
 * The machine's cores are read where networkWorkers is, and enter no Limit.
 */
export const familyMembers: number = Math.ceil(networkWorkers / filesPerCluster.value)

/**
 * The workers one member of a family serves at most, which scripts/pg/init.sh sizes each member for (size.ts
 * clusterSize): the run's workers over the family's members, rounded up, so the members together serve every worker.
 */
export const memberShare: number = Math.ceil(networkWorkers / familyMembers)

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
