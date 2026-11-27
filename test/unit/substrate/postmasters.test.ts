/**
 * The postmasters build.sh refuses to exchange the shared prefix under (packages/pg/src/postmasters.ts postmastersOf,
 * through foreign-postmasters.ts): every process running the bin/postgres of a tree it is given, found from the
 * processes themselves wherever their data directories lie.
 *
 * Each case makes a process of its own and asks for the postmasters of its own tree, so no case meets another's: the
 * tree's bin/postgres and another tree's are hard links of one copy of this Node binary, a program that names its pid
 * and runs until it is killed, and the process runs one of them in a data directory of its own, outside every
 * cluster's state directory. Its pid is the one it names, never the child's the case started, which the testing
 * library runs under strace(1) where it cannot record it (postmasters.fixtures.ts caseOf).
 * The box is each binary it runs (the tree's; the tree's, replaced after it started, as a build replaces it; another
 * tree's), each lock file its data directory holds (postmaster.pid naming the process, naming another process as a
 * backend's directory does, absent, or no lock file at all), and what else its scan meets: nothing, or a process /proc
 * lists that the kernel reaps before the scan reads it, whose read fails as Node's file system fails it there (ESRCH),
 * as any process of a loaded machine can end mid-scan.
 *
 * Oracle: the specification. A process running the tree's binary, or one replaced since it started, whose lock file
 * names it, is the one postmaster found, with its lock file's data directory and port and the executable the kernel
 * names; a lock file that is no lock file is refused as LockFileUnparsed wherever the binary is the tree's; any other
 * process is none, a process reaped as it is read among them, so it changes no verdict.
 *
 * Features: each verdict, by the reason for it, and a reaped process skipped.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect, Formatter, Result } from "effect"
import {
	caseOf,
	type PostmasterFeature,
	predicted,
	sketchGen
} from "#test/unit/substrate/postmasters.fixtures.ts"

/** The postmasters running a tree's build are every process running the tree's bin/postgres whose lock file names it, wherever its data directory lies. */
export const thePostmastersRunningATreesBuildAreEveryProcessRunningTheTreesBinPostgresWhoseLockFileNamesItWhereverItsDataDirectoryLies =
	property.exhaust(finite(sketchGen), {
		needs: { dir: Scratch.dir },
		situations: [
			"a postmaster of the tree listed",
			"a postmaster of a replaced binary listed",
			"another tree's process unlisted",
			"a backend's directory unlisted",
			"a process without a lock file unlisted",
			"a malformed lock file refused",
			"a process reaped as it is read skipped"
		] satisfies ReadonlyArray<Reached<PostmasterFeature>>,
		check: (resources, c: Case<PostmasterFeature>) => (s) =>
			Effect.scoped(
				Effect.gen(function* () {
					const dir = yield* resources.dir
					const [verdict, feature] = predicted(s)
					const { found, listed } = yield* caseOf(dir, s)
					switch (verdict) {
						case "unparsed":
							assert.ok(
								Result.isFailure(found) && found.failure._tag === "LockFileUnparsed",
								`a malformed lock file is refused: ${Formatter.format(found)}`
							)
							break
						case "listed":
							assert.deepEqual(Result.getOrThrow(found), [listed])
							break
						case "unlisted":
							assert.deepEqual(Result.getOrThrow(found), [])
							break
					}
					c.note(feature)
					if (s.scan === "beside a process reaped as it is read") {
						c.note("a process reaped as it is read skipped")
					}
				})
			),
		oracle: {
			kind: "specification",
			name: "a process of the tree's binary whose lock file names it is a postmaster"
		},
		box: "one process a case, each binary it runs (the tree's, the tree's replaced since it started, another tree's), each lock file its data directory holds (naming it, naming another process, absent, malformed), and what else its scan meets (nothing, a process reaped as it is read)",
		kept: [
			{
				token: ReplayToken(
					"test/unit/substrate/postmasters.test.ts#thePostmastersRunningATreesBuildAreEveryProcessRunningTheTreesBinPostgresWhoseLockFileNamesItWhereverItsDataDirectoryLies:-:0.0.0"
				),
				reason:
					"a postmaster of the tree, its lock file naming it, scanned alone (the merged tree's unit tier from INTEG on, toolchain 54e53afb): the testing library ran the case's child under strace(1), so the pid the case started was strace's, and its lock file named a process of no tree, which the scan rightly listed as none; the case's process names its own pid (postmasters.fixtures.ts caseOf)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/pg/src/postmasters.ts",
				original:
					'\t\tconst pids = yield* Effect.mapError(\n\t\t\tfs.readDirectory("/proc"),\n\t\t\t(cause) => new Unreadable({ path: "/proc", cause })',
				replacement: `\t\tconst stateRoot = \`\${process.env["HOME"]}/.local/var/grizzle\`\n\t\tconst states = yield* Effect.orElseSucceed(fs.readDirectory(stateRoot), () => [])\n\t\tconst pids = yield* Effect.forEach(states, (state) =>\n\t\t\tEffect.orElseSucceed(\n\t\t\t\tEffect.map(\n\t\t\t\t\tfs.readFileString(\`\${stateRoot}/\${state}/data/postmaster.pid\`),\n\t\t\t\t\t(text) => text.split("\\n")[0] ?? ""\n\t\t\t\t),\n\t\t\t\t() => ""\n\t\t\t)`,
				why: "The postmasters are read from the lock files of the clusters' state directories under ~/.local/var/grizzle, not from the processes, so a postmaster whose data directory lies elsewhere is never found; the property fails at the first case that lists one."
			},
			{
				file: "packages/pg/src/postmasters.ts",
				original:
					"\t\t\tUnknown: (reason, error) => (reaped(reason.cause) ? Effect.succeedNone : Effect.fail(error))\n",
				replacement: "\t\t\tUnknown: (_reason, error) => Effect.fail(error)\n",
				why: "A process reaped as the scan reads it, whose read Node's file system fails with ESRCH (an Unknown system error), is Unreadable, so the scan dies whenever any process of the machine ends between /proc's listing and its read, as this property did under load in the unit tier of grizzle 864cc4cc6 with toolchain b1e430ad2 (case 9, /proc/1973307/exe); the property fails at the first case beside a reaped process."
			}
		]
	})
