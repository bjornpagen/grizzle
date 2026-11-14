import { NodeFileSystem, NodeRuntime } from "@effect/platform-node"
import { Array as Arr, Console, Effect, FileSystem, Option, String as Str } from "effect"
import {
	type ClusterFamily,
	FamilyUnrecorded,
	familyFile,
	familyMembers,
	familyText,
	parseFamily,
	readFamily
} from "#pg/family.ts"
import { localCluster } from "#pg/local-cluster.ts"
import { freePort } from "#pg/ports.ts"

import { regex } from "arkregex"

/** A port as an argument spells it: canonical decimal, as a cluster's name does; none for anything else. */
const portArgument = (arg: string): Option.Option<number> =>
	regex("^[1-9][0-9]{0,4}$").test(arg) && Number(arg) <= 65_535
		? Option.some(Number(arg))
		: Option.none()

/** Every argument as a port, or none when any is no port. */
const portArguments = (args: ReadonlyArray<string>): Option.Option<ReadonlyArray<number>> =>
	Option.all(Arr.map(args, portArgument))

const usage = `usage: family-cli.ts size | members | recorded | file | free <taken port>... | record <port>...`

/**
 * The family GRIZZLE_PG_CLUSTER names (local-cluster.ts localCluster, its first member), for scripts/pg/lib.sh, one
 * subcommand a run, so the shell holds no second spelling of the family's size, of its file or of how a port is found:
 * - `size`: the members a family has (family.ts familyMembers);
 * - `members`: the recorded members' ports, one a line in member order, read from the family file (readFamily); a
 *   family recorded otherwise, or none, fails with FamilyUnrecorded;
 * - `recorded`: the ports the family file records, however many, each else as `members` requires: what --adopt keeps
 *   of a family recorded before its size grew (scripts/pg/init.sh);
 * - `file`: the family file's path (familyFile);
 * - `free <taken port>...`: a port free on every address localhost names and none of those given (ports.ts freePort);
 * - `record <port>...`: writes the family file of the family those ports are, refused unless they are one (parseFamily).
 * Anything else is refused with a failing exit.
 */
const main = Effect.gen(function* () {
	const [command, ...args] = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const ports = portArguments(args)
	if (command === "size" && args.length === 0) {
		return yield* Console.log(`${familyMembers}`)
	}
	if (command === "members" && args.length === 0) {
		const family = yield* readFamily(localCluster)
		return yield* Effect.forEach(family.members, (member) => Console.log(`${member.port}`), {
			discard: true
		})
	}
	if (command === "recorded" && args.length === 0) {
		const file = familyFile(localCluster)
		const fs = yield* FileSystem.FileSystem
		const text = yield* Effect.mapError(
			fs.readFileString(file),
			(error) => new FamilyUnrecorded({ file, reason: error.message })
		)
		const lines = Arr.filter(Str.split(text, "\n"), (line) => line.length > 0)
		const family = yield* Effect.mapError(
			Effect.fromResult(parseFamily(localCluster, lines.length, text)),
			(reason) => new FamilyUnrecorded({ file, reason })
		)
		return yield* Effect.forEach(family.members, (member) => Console.log(`${member.port}`), {
			discard: true
		})
	}
	if (command === "file" && args.length === 0) {
		return yield* Console.log(familyFile(localCluster))
	}
	if (command === "free" && Option.isSome(ports)) {
		const port = yield* freePort(ports.value)
		return yield* Console.log(`${port}`)
	}
	if (command === "record" && Option.isSome(ports)) {
		const file = familyFile(localCluster)
		const text = Arr.join(
			Arr.map(ports.value, (port) => `${port}\n`),
			""
		)
		const family: ClusterFamily = yield* Effect.mapError(
			Effect.fromResult(parseFamily(localCluster, familyMembers, text)),
			(reason) => new FamilyUnrecorded({ file, reason })
		)
		const fs = yield* FileSystem.FileSystem
		return yield* fs.writeFileString(file, familyText(family))
	}
	return yield* Effect.die(new Error(usage))
})

NodeRuntime.runMain(main.pipe(Effect.provide(NodeFileSystem.layer)))
