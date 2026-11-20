/** What the properties of postmasters.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Effect, FileSystem } from "effect"
import { ChildProcess } from "effect/process"
import { postmastersOf } from "#pg/postmasters.ts"

/** The binary a case's process runs: its tree's, its tree's replaced after the process started, or another tree's. */
const binaries = ["the tree's", "the tree's, replaced", "another tree's"] as const
type Binary = (typeof binaries)[number]

/** What the data directory's postmaster.pid holds: the process, another process, nothing, or text of no lock file. */
const locks = ["naming it", "naming another process", "absent", "malformed"] as const
type Lock = (typeof locks)[number]

/** A case: one process, by the binary it runs and its lock file. */
interface Sketch {
	readonly binary: Binary
	readonly lock: Lock
}

export const sketchGen: Gen<Sketch> = (source) => ({
	binary: source.draw(element(binaries)),
	lock: source.draw(element(locks))
})

/** What postmastersOf finds of a case's process: it, nothing, or a lock file it refuses. */
type Verdict = "listed" | "unlisted" | "unparsed"

/** The reason for a case's verdict, as the search must reach each. */
export type PostmasterFeature =
	| "a postmaster of the tree listed"
	| "a postmaster of a replaced binary listed"
	| "another tree's process unlisted"
	| "a backend's directory unlisted"
	| "a process without a lock file unlisted"
	| "a malformed lock file refused"

/** The model: what postmastersOf finds of a case's process, and why. */
export const predicted = (s: Sketch): readonly [Verdict, PostmasterFeature] => {
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
			return [
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
 * A case's process and its verdict: under `root`, the case's own directory, a copy of this Node binary, a program that
 * runs until it is killed, and a tree and another tree whose bin/postgres are hard links of it; the process running
 * the chosen one in its data directory until the case ends, the lock file written once its pid is known, and the
 * binary replaced when the case asks.
 */
export const caseOf = (root: string, s: Sketch) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const binary = `${root}/postgres`
		const tree = `${root}/tree`
		const other = `${root}/other`
		const data = `${root}/data`
		yield* fs.copyFile(process.execPath, binary)
		yield* Effect.forEach(
			[`${tree}/bin`, `${other}/bin`, data],
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
		const found = yield* Effect.result(postmastersOf([tree]))
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
