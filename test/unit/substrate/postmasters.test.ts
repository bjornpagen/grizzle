/**
 * The postmasters build.sh refuses to exchange the shared prefix under (packages/pg/src/installation.ts postmastersOf,
 * through foreign-postmasters.ts): every process running the bin/postgres of a tree it is given, other than the
 * selected cluster's, found from the processes themselves wherever their data directories lie.
 *
 * Each case makes a process of its own and asks for the postmasters of its own tree, so no case meets another's: the
 * tree's bin/postgres and another tree's are hard links of one copy of this Node binary, a program that runs until it
 * is killed, and the process runs one of them in a data directory of its own, outside every cluster's state directory.
 * The box is each binary it runs (the tree's; the tree's, replaced after it started, as a build replaces it; another
 * tree's), each lock file its data directory holds (postmaster.pid naming the process, naming another process as a
 * backend's directory does, absent, or no lock file at all), and whether that directory is the selected cluster's.
 *
 * Oracle: the specification. A process running the tree's binary, or one replaced since it started, whose lock file
 * names it, is the one postmaster found, with its lock file's data directory and port and the executable the kernel
 * names, unless its directory is the selected cluster's; a lock file that is no lock file is refused as LockFileUnparsed
 * wherever the binary is the tree's; any other process is none.
 *
 * Features: each verdict, by the reason for it.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect, Formatter, Result } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	caseOf,
	type PostmasterFeature,
	predicted,
	sketchGen
} from "#test/unit/substrate/postmasters.fixtures.ts"

/** The postmasters running a tree's build are every process running the tree's bin/postgres whose lock file names it, wherever its data directory lies, but the selected cluster's. */
export const thePostmastersRunningATreesBuildAreEveryProcessRunningTheTreesBinPostgresWhoseLockFileNamesItWhereverItsDataDirectoryLiesButTheSelectedClusters =
	property.exhaust(finite(sketchGen), {
		needs: { dir: Scratch.dir },
		situations: [
			"a postmaster of the tree listed",
			"a postmaster of a replaced binary listed",
			"another tree's process unlisted",
			"a backend's directory unlisted",
			"a process without a lock file unlisted",
			"the selected cluster's postmaster unlisted",
			"a malformed lock file refused"
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
				})
			),
		oracle: {
			kind: "specification",
			name: "a process of the tree's binary whose lock file names it is a postmaster, unless its directory is the selected cluster's"
		},
		box: "one process a case, each binary it runs (the tree's, the tree's replaced since it started, another tree's), each lock file its data directory holds (naming it, naming another process, absent, malformed), its data directory the selected cluster's or another",
		kept: [],
		kills: [
			{
				file: "packages/pg/src/installation.ts",
				original:
					'\t\tconst pids = yield* Effect.mapError(\n\t\t\tfs.readDirectory("/proc"),\n\t\t\t(cause) => new Unreadable({ path: "/proc", cause })',
				replacement: `\t\tconst stateRoot = \`\${process.env["HOME"]}/.local/var/grizzle\`\n\t\tconst states = yield* Effect.orElseSucceed(fs.readDirectory(stateRoot), () => [])\n\t\tconst pids = yield* Effect.forEach(states, (state) =>\n\t\t\tEffect.orElseSucceed(\n\t\t\t\tEffect.map(\n\t\t\t\t\tfs.readFileString(\`\${stateRoot}/\${state}/data/postmaster.pid\`),\n\t\t\t\t\t(text) => text.split("\\n")[0] ?? ""\n\t\t\t\t),\n\t\t\t\t() => ""\n\t\t\t)`,
				why: "The postmasters are read from the lock files of the clusters' state directories under ~/.local/var/grizzle, not from the processes, so a postmaster whose data directory lies elsewhere is never found; the property fails at the first case that lists one."
			}
		]
	})
