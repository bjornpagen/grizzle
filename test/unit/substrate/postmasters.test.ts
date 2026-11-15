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
 *
 * @plant test/plants/unit/substrate/foreign-state-directories.patch The postmasters are read from the lock files of
 * the clusters' state directories under ~/.local/var/grizzle, not from the processes, so a postmaster whose data
 * directory lies elsewhere is never found; the property fails at the first case that lists one.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect, FileSystem, Formatter, Layer, Result } from "effect"
import { ChildProcess } from "effect/process"
import { postmastersOf } from "#pg/installation.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** The binary a case's process runs: its tree's, its tree's replaced after the process started, or another tree's. */
const binaries = ["the tree's", "the tree's, replaced", "another tree's"] as const
type Binary = (typeof binaries)[number]

/** What the data directory's postmaster.pid holds: the process, another process, nothing, or text of no lock file. */
const locks = ["naming it", "naming another process", "absent", "malformed"] as const
type Lock = (typeof locks)[number]

/** Whether the process's data directory is the selected cluster's, which is no foreign postmaster. */
const directories = ["another cluster's", "the selected cluster's"] as const
type Directory = (typeof directories)[number]

/** A case: one process, by the binary it runs, its lock file and its data directory. */
interface Sketch {
	readonly binary: Binary
	readonly lock: Lock
	readonly directory: Directory
}

const sketchGen: Gen<Sketch> = (source) => ({
	binary: source.draw(element(binaries)),
	lock: source.draw(element(locks)),
	directory: source.draw(element(directories))
})

/** What postmastersOf finds of a case's process: it, nothing, or a lock file it refuses. */
type Verdict = "listed" | "unlisted" | "unparsed"

/** The reason for a case's verdict, as the search must reach each. */
type PostmasterFeature =
	| "a postmaster of the tree listed"
	| "a postmaster of a replaced binary listed"
	| "another tree's process unlisted"
	| "a backend's directory unlisted"
	| "a process without a lock file unlisted"
	| "the selected cluster's postmaster unlisted"
	| "a malformed lock file refused"

/** The model: what postmastersOf finds of a case's process, and why. */
const predicted = (s: Sketch): readonly [Verdict, PostmasterFeature] => {
	if (s.binary === "another tree's") {
		return ["unlisted", "another tree's process unlisted"]
	}
	switch (s.lock) {
		case "malformed":
			return ["unparsed", "a malformed lock file refused"]
		case "absent":
			return ["unlisted", "a process without a lock file unlisted"]
		case "naming another process":
			return ["unlisted", "a backend's directory unlisted"]
		case "naming it":
			return s.directory === "the selected cluster's"
				? ["unlisted", "the selected cluster's postmaster unlisted"]
				: [
						"listed",
						s.binary === "the tree's"
							? "a postmaster of the tree listed"
							: "a postmaster of a replaced binary listed"
					]
	}
}

/** The port a case's lock file records. */
const port = 5999

/** The kernel's suffix to the name of an executable replaced or removed after its process started. */
const deleted = " (deleted)"

/**
 * A case's process and its verdict: under a directory of its own, a tree and another tree whose bin/postgres are hard
 * links of `binary`, the process running the chosen one in its data directory until the case ends, the lock file
 * written once its pid is known, and the binary replaced when the case asks.
 */
const caseOf = (binary: string, s: Sketch) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const root = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-postmasters-" })
		const tree = `${root}/tree`
		const other = `${root}/other`
		const data = `${root}/data`
		const selected = s.directory === "the selected cluster's" ? data : `${root}/selected`
		yield* Effect.forEach(
			[`${tree}/bin`, `${other}/bin`, data, `${root}/selected`],
			(path) => fs.makeDirectory(path, { recursive: true }),
			{ discard: true }
		)
		yield* fs.link(binary, `${tree}/bin/postgres`)
		yield* fs.link(binary, `${other}/bin/postgres`)
		const executable = `${s.binary === "another tree's" ? other : tree}/bin/postgres`
		const child = yield* ChildProcess.make(executable, ["-e", "setInterval(() => {}, 2 ** 30)"], {
			cwd: data,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			killSignal: "SIGKILL"
		})
		const pid = Number(child.pid)
		const holder = s.lock === "naming another process" ? process.pid : pid
		if (s.lock !== "absent") {
			yield* fs.writeFileString(
				`${data}/postmaster.pid`,
				s.lock === "malformed" ? "no lock file\n" : `${holder}\n${data}\n0\n${port}\n`
			)
		}
		if (s.binary === "the tree's, replaced") {
			yield* fs.remove(`${tree}/bin/postgres`)
			yield* fs.link(binary, `${tree}/bin/postgres`)
		}
		const found = yield* Effect.result(postmastersOf([tree], selected))
		return {
			found,
			listed: {
				pid,
				data,
				port,
				executable: s.binary === "the tree's, replaced" ? `${executable}${deleted}` : executable
			}
		}
	})

const nodeLayer = Layer.mergeAll(
	NodeChildProcessSpawner.layer.pipe(
		Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
	),
	NodeFileSystem.layer
)

layer(nodeLayer, { excludeTestServices: true })("the postmasters running a tree's build", (it) => {
	it.effect(
		"are every process running the tree's bin/postgres whose lock file names it, wherever its data directory lies, but the selected cluster's",
		(ctx) =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const copies = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-postmaster-binary-" })
					const binary = `${copies}/postgres`
					yield* fs.copyFile(process.execPath, binary)
					return yield* searched(
						ctx,
						exhaust(
							{
								suite: "unit/substrate/postmasters",
								generator: sketchGen,
								literal: Formatter.format,
								box: "one process a case, each binary it runs (the tree's, the tree's replaced since it started, another tree's), each lock file its data directory holds (naming it, naming another process, absent, malformed), its data directory the selected cluster's or another",
								oracle: {
									kind: "specification",
									name: "a process of the tree's binary whose lock file names it is a postmaster, unless its directory is the selected cluster's"
								},
								coverage: requiredInSpace<PostmasterFeature>([
									"a postmaster of the tree listed",
									"a postmaster of a replaced binary listed",
									"another tree's process unlisted",
									"a backend's directory unlisted",
									"a process without a lock file unlisted",
									"the selected cluster's postmaster unlisted",
									"a malformed lock file refused"
								]),
								caseHang
							},
							(s, c) =>
								Effect.scoped(
									Effect.gen(function* () {
										const [verdict, feature] = predicted(s)
										const { found, listed } = yield* caseOf(binary, s)
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
								)
						)
					)
				})
			)
	)
})
