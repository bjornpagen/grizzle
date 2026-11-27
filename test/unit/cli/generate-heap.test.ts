/**
 * grizzle generate's live heap, once the compile has made what the draft's files are made from, holds at most one
 * artifact beyond it: each login's served file and OpenAPI document, the snapshot's two files and the folder are written
 * as they are made and held no longer (cli/generate.ts eachServedFile, stagedServed, stagedSnapshotFiles, renderedFolder;
 * cli/files.ts Staging), and the folder is rendered once the served files are written, without what they compiled over
 * (stagedOver); a schema's staged draft holds no text by its type (StagedDraft). Where every login's texts were held
 * until the last login had compiled, and every artifact's until the write, and the folder was rendered beside what the
 * served files compile over (metis's installation from nothing at grizzle dfc9f60e: 24 logins and 92 MB of served text,
 * 221 MB of artifacts, held at once, and the draft rendered over 515 MB of level artifacts).
 *
 * The bound, from first principles: from the plan's start on, the heap holds what the compile made, read at that start
 * (the compiled schema, the installation, what each login's served file compiles over), and the artifact in flight; a
 * text of b UTF-8 bytes has at most b UTF-16 code units, each at most two bytes on V8's heap, so the artifact in flight
 * takes at most twice its bytes (the allowance). The served files hold their inputs and one login's artifact: from the
 * first login's start, the snapshot read, no boundary of them is past it by more than the allowance. The folder renders
 * once their inputs are gone: what they compile over, every level's artifacts and every login's ChangeSets, is past the
 * allowance in every case of the box, so the render begins more than the allowance below the served files' start.
 *
 * Property, per case: the case's installation (generate-heap.fixtures.ts heapConfig) generated from nothing in a child
 * under --expose-gc, after a first generate in the same process has run every function it calls
 * (generate-heap.child.ts), its live heap read at each boundary of its plan's, served files', render's and
 * write's phases once every garbage is collected, the allowance twice the largest artifact's bytes (largestArtifact):
 * the peak from the plan's start on is within its start plus the allowance; each boundary of the served files from the
 * first login's start within that start plus the allowance; and the render's start more than the allowance below the
 * served files' start. Oracle: specification, the bound stated above. Kills: each login's staged record keeps its
 * texts, as every login's entry was kept until the last had compiled; the logins' certificates are read once the folder
 * is rendered, so what the served files compile over is held through the render.
 *
 * Features: none required.
 */

import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem } from "effect"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { hardenedNode, run } from "#test/support/process.ts"
import {
	fromPhase,
	type HeapBoundary,
	type HeapRun,
	heapCaseGen,
	largestArtifact,
	liveAt,
	phaseOf
} from "#test/unit/cli/generate-heap.fixtures.ts"

/** generate's live heap holds its compile and one artifact in flight, and its folder renders without the served files' inputs. */
export const generatesLiveHeapHoldsItsCompileAndOneArtifactInFlightAndItsFolderRendersWithoutTheServedFilesInputs =
	property.explore(heapCaseGen, {
		needs: { checkout: Checkout.dir },
		situations: [],
		check: (resources) => (c) =>
			Effect.flatMap(resources.checkout, (checkout) =>
				Effect.scoped(
					Effect.gen(function* () {
						const fs = yield* FileSystem.FileSystem
						const dir = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-heap-" })
						const ran = yield* run(
							process.execPath,
							[
								...hardenedNode,
								"--expose-gc",
								`${checkout}/test/unit/cli/generate-heap.child.ts`,
								jsonText(c),
								dir
							],
							{ cwd: checkout, env: {} }
						)
						assert.equal(ran.status, 0, `the child generated:\n${ran.stderr}`)
						const heap = trustedJson<HeapRun>(ran.stdout)
						const allowance = 2 * largestArtifact(heap)
						const within = (b: HeapBoundary, from: number, what: string) =>
							assert.ok(
								b.live <= from + allowance,
								`${b.label} ${b.edge}: ${b.live} bytes live, past ${what}'s ${from} and ${allowance} beside it`
							)
						const plan = liveAt(heap, "draft", "start")
						for (const b of fromPhase(heap, "draft")) {
							within(b, plan, "the plan's start")
						}
						const login = liveAt(heap, "servedLogin", "start")
						for (const b of Arr.takeWhile(
							fromPhase(heap, "servedLogin"),
							(b) => phaseOf(b) !== "render"
						)) {
							within(b, login, "the first login's start")
						}
						const served = liveAt(heap, "served", "start")
						const render = liveAt(heap, "render", "start")
						assert.ok(
							render + allowance < served,
							`the render's start: ${render} bytes live, not ${allowance} below the served files' start's ${served}`
						)
					})
				)
			),
		oracle: {
			kind: "specification",
			name: "the compile's heap and one artifact in flight, twice its UTF-8 bytes at most"
		},
		budget: { runs: 2, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/generate.ts",
				original: "\t\t\treturn {\n\t\t\t\tlogin: entry.login,\n",
				replacement: "\t\t\treturn {\n\t\t\t\tentry,\n\t\t\t\tlogin: entry.login,\n",
				why: "Each login's staged record keeps its served file's and OpenAPI document's texts, so every login's are held until the last has compiled, as every entry was."
			},
			{
				file: "packages/grizzle/src/cli/generate.ts",
				original: "\t\t\t\tserved: writes,\n\t\t\t\tcertification,\n",
				replacement:
					'\t\t\t\tserved: writes,\n\t\t\t\tcertification: served.kind === "logins" ? served.certification : certification,\n',
				why: "The logins' certificates are read once the folder is rendered, so what the served files compile over, every level's artifacts and every login's ChangeSets, is held through the render."
			}
		]
	})
