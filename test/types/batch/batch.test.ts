/**
 * The type-test batch (test/types/batch/batch.ts) and its compiler's stall guard (compiler.ts), against models of what
 * they must deliver:
 *
 * - Attribution: a planted program of one or two modules, each line clean or raising one of two diagnostics, alone or
 *   under a directive of each claim (directives.ts Claim), each owned by the batch or by one of its cases, checked
 *   armed or disarmed, its checkout and its directory spelled through symbolic links or not. Each case's verdict is
 *   the model's: it agrees exactly when its own lines and the batch's own lines agree and nothing is reported outside
 *   the program; one that disagrees carries its own lines' promised lines, error lines and problems and the batch's,
 *   every diagnostic at the owner of its line, a twin's problem at every owner of one of its lines; and a diagnostic in
 *   a file outside the program, which its entry imports, fails every case, naming that file. Oracle: a second
 *   implementation, the model of each planted line's diagnostics armed and disarmed, compared owner by owner.
 * - The stall guard's reading: a planted process tree read through a file system that serves only its /proc, each file
 *   standing or failing as its task ended mid-reading (ENOENT reaped, ESRCH exited and not yet reaped), reads as the
 *   tree that stands, and never fails for a process or thread that ended. Oracle: a model of the reading over the
 *   standing processes and threads.
 * - The stall guard: a compiler whose process tree is idle for its window, no thread running, waiting for a CPU or on
 *   the disk and no CPU time spent, fails with CompilerStalled and its goroutines, and one that checks to its end never
 *   does, nor a command whose work runs past its window in a child while its own process waits. Oracle: tsgo's watch
 *   mode, which idles after its first check.
 *
 * The old builder property (a run's batch built in a builder process the global setup started, delivered over a
 * socket) is gone with that machinery: each batch is now checked inside its property's own evaluation.
 */
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Option,
	Path,
	String as Str
} from "effect"
import { assert, defined } from "#test/support/assert.ts"
import {
	attributed,
	busyScripts,
	modelReading,
	plantedCheck,
	plantedProc,
	plantedProgram,
	plantedTree,
	stallCaseDeadline,
	stallFeatureOf,
	treeFeatures
} from "#test/types/batch/batch.fixtures.ts"
import { guardedRun, readingOf } from "#test/types/batch/compiler.ts"

/**
 * Attributes every diagnostic to the owner of the line it names, through any spelling of the checkout and the program's
 * directory, holds each directive's line to its claim, and fails every case on a diagnostic no line of the program
 * owns. Its budget, 4 runs and the runner's 200 steered cases, is the pre-conversion suite's (runs: 4), restored
 * because it costs no more: at TEST_SEED=777, run beside the runner's default of 150, the whole process tree took 71.3
 * CPU-s against 77.4, every situation reached (96 steered cases) and all four kills killed
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/batch/attribution.*.txt, 2026-11-16).
 */
export const attribution = property.explore(plantedProgram, {
	needs: { dir: Scratch.dir },
	budget: { runs: 4, steered: 200 },
	situations: [
		"an armed program",
		"a disarmed program",
		"two modules",
		"an unused directive",
		"a code its directive does not claim",
		"a refused line",
		"twins that agree",
		"twins that differ",
		"a twin alone",
		"a twin across owners",
		"an unowned file that raises",
		"an unowned file that raises nothing",
		"a symlinked root",
		"a case that agrees beside one that disagrees",
		"the batch's own lines disagreeing"
	],
	check: (resources, c) => (planted) =>
		Effect.flatMap(resources.dir, (dir) => attributed(planted, c, dir)),
	oracle: {
		kind: "second-implementation",
		name: "a model of each planted line's diagnostic in an armed check and in a disarmed one, owner by owner"
	},
	kept: [],
	kills: [
		{
			file: "test/types/batch/batch.ts",
			original: "(codes.length === 1 && codes[0] === claim.code)",
			replacement: "codes.length === 1",
			why: "A code claim holds of any one code its line raises, so a TS2741 under a TS2322 claim agrees: the model's code problem is missing."
		},
		{
			file: "test/types/batch/batch.ts",
			original: "Arr.makeEquivalence(Equivalence.String)(signature, reference)",
			replacement: "Arr.makeEquivalence(Equivalence.String)(reference, reference)",
			why: "Every twin agrees with its first line, so lines of one label raising different diagnostics agree: the model's twins-differ problem is missing."
		},
		{
			file: "test/types/batch/batch.ts",
			original: "agrees(attributed.batch) && !Arr.isReadonlyArrayNonEmpty(attributed.unattributed)",
			replacement: "agrees(attributed.batch)",
			why: "A diagnostic in a file outside the program fails no case: every case beside a raising unowned file agrees where the model says it disagrees."
		},
		{
			file: "test/types/batch/batch.ts",
			original: "owner: owner.value,",
			replacement: "owner: batchOwned,",
			why: "Every error is judged the batch's, whatever line it stands on: a case's error lines and the batch's are not the model's."
		}
	]
})

/**
 * Fails a compiler that makes no CPU progress for its window with CompilerStalled and its goroutines, and never one
 * that checks to its end. Its budget, 4 runs and the runner's 200 steered cases, is the pre-conversion suite's (runs:
 * 4), restored because it costs less: at TEST_SEED=777, run beside the runner's default of 150, the whole process tree
 * took 66.0 CPU-s against 361.4, each case a tsgo check, every situation reached (16 steered cases) and its kill killed
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/batch/stallGuard.*.txt, 2026-11-16).
 */
export const stallGuard = property.explore(plantedCheck, {
	needs: { dir: Scratch.dir },
	budget: { runs: 4, steered: 200 },
	caseDeadline: stallCaseDeadline,
	situations: ["stalled", "checked clean", "checked with an error", "worked past its window"],
	check:
		(resources, c) =>
		({ work, windowMillis, everyMillis }) =>
			Effect.gen(function* () {
				c.note(stallFeatureOf(work))
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const repository = yield* fs.realPath(path.resolve(import.meta.dirname, "../../.."))
				const dir = yield* resources.dir
				yield* fs.writeFileString(path.join(dir, "parent.mjs"), busyScripts.parent)
				yield* fs.writeFileString(path.join(dir, "child.mjs"), busyScripts.child)
				const args =
					work.kind === "busy child"
						? [
								path.join(dir, "parent.mjs"),
								path.join(dir, "child.mjs"),
								String(windowMillis + everyMillis)
							]
						: [
								path.join(repository, "node_modules/typescript/bin/tsc"),
								...(work.watch ? ["--watch"] : []),
								"--pretty",
								"false",
								"-p",
								path.join(dir, "tsconfig.json")
							]
				yield* fs.writeFileString(
					path.join(dir, "index.ts"),
					`export const checked: number = ${work.kind === "check" && work.raises ? '"s"' : "1"}\n`
				)
				yield* fs.writeFileString(
					path.join(dir, "tsconfig.json"),
					'{ "compilerOptions": { "noEmit": true, "strict": true, "types": [] }, "files": ["index.ts"] }\n'
				)
				const ran = yield* Effect.exit(
					guardedRun(process.execPath, args, repository, {
						window: Duration.millis(windowMillis),
						every: Duration.millis(everyMillis)
					})
				)
				const failure = Exit.findErrorOption(ran)
				assert.deepEqual(
					{
						stalled: Option.map(failure, (failed) =>
							failed._tag === "CompilerStalled"
								? {
										idled: failed.idleMillis >= windowMillis,
										dumped: Str.includes("goroutine ")(failed.goroutines)
									}
								: failed._tag
						),
						status: Exit.isSuccess(ran) ? Option.some(ran.value.status) : Option.none()
					},
					work.kind === "check" && work.watch
						? { stalled: Option.some({ idled: true, dumped: true }), status: Option.none() }
						: {
								stalled: Option.none(),
								status: Option.some(work.kind === "check" && work.raises ? 2 : 0)
							}
				)
			}),
	oracle: {
		kind: "specification",
		name: "tsgo's watch mode idles at 0% CPU after its first check; a check run once never does, and Go answers SIGQUIT with every goroutine's stack"
	},
	kept: [],
	kills: [
		{
			file: "test/types/batch/compiler.ts",
			original: 'yield* handle.kill({ killSignal: "SIGQUIT", forceKillAfter: guard.window })',
			replacement:
				'yield* handle.kill({ killSignal: "SIGQUIT", forceKillAfter: guard.window })\n\t\t\t\t\treturn { status: 0, stdout: yield* Fiber.join(stdout), stderr: yield* Fiber.join(stderr) }',
			why: "A stalled check is reported as one that exited cleanly once it is killed: the watch mode's stall raises no CompilerStalled."
		}
	]
})

/**
 * Reads a process tree as it stands though its processes and threads end mid-reading, never failing for one that ended.
 * It runs the runner's default budget, not the pre-conversion suite's 200 runs: at TEST_SEED=777, run beside it, the
 * default's whole process tree took 12.5 CPU-s against 12.7, both reaching every situation and killing both kills
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/batch/stallReading.*.txt, 2026-11-16).
 */
export const stallReading = property.explore(plantedTree, {
	needs: {},
	situations: [
		"a thread ended as it was read",
		"a process reaped as it was read",
		"a busy child under a waiting parent",
		"a command name holding a parenthesis"
	],
	check: (_resources, c) => (tree) =>
		Effect.gen(function* () {
			Arr.forEach(treeFeatures(tree), (f) => c.note(f))
			const root = defined(tree.processes[0], "the tree's root")
			const read = yield* Effect.exit(readingOf(plantedProc(tree), root.pid))
			assert.deepEqual(read, Exit.succeed(modelReading(tree, root.pid)))
		}),
	oracle: {
		kind: "second-implementation",
		name: "a model of the planted tree's reading, over the processes and threads whose files stand"
	},
	kept: [],
	kills: [
		{
			file: "test/types/batch/compiler.ts",
			original: "const read = yield* Effect.forEach(childPids, (child) => readingOf(fs, child))",
			replacement:
				"const read = yield* Effect.forEach(Arr.take(childPids, 0), (child) => readingOf(fs, child))",
			why: "The reading stops at the root process and never reads a child its threads started, so a busy child under a waiting parent reads idle and its ticks are lost."
		},
		{
			file: "test/types/batch/compiler.ts",
			original: 'const ENDED_ERRNOS: ReadonlySet<string> = new Set(["ENOENT", "ESRCH"])',
			replacement: 'const ENDED_ERRNOS: ReadonlySet<string> = new Set(["ENOENT"])',
			why: "A thread that exited and is not yet reaped (ESRCH) fails the reading instead of reading as gone."
		}
	]
})
