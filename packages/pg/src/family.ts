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
import { clusterAt, type LocalCluster } from "#pg/local-cluster.ts"

import { filesPerCluster } from "@grizzle/limits"
import { regex } from "arkregex"

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
