import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { assert, defined } from "#test/support/assert.ts"
import { run } from "#test/support/process.ts"
import { scopedTempDir } from "#test/support/temp.ts"
import { disarm } from "#test/types/batch/directives.ts"
import { type BudgetEntries, entriesFrom } from "#test/types/query/budget/generate.ts"

import { regex } from "arkregex"
/**
 * A generated program checked alone, as a scaling test reads it: its diagnostics and the checker's counts of the types
 * it made and the instantiations it ran (tsgo --extendedDiagnostics). A count is one program's, so each program is a
 * project of its own, outside the type-test batch, with the batch's compiler options and no Effect language service,
 * checked by one checker: several checkers each make the types of the files they check, and how the files fall to
 * them moves the counts by more than a small dimension's step.
 *
 * A scaling test checks a program at three sizes of one dimension, n, 2n and 4n, and holds every one to no diagnostic
 * and both counts to linear growth (linearIn): for a count a + b·n^k the increment from 2n to 4n is 2^k times the one
 * from n to 2n, so a linear count gives 2 and a quadratic one 4, and a ratio of 3 or more, the midpoint, is refused. The
 * constant a, what the public barrels cost before the dimension adds anything, cancels in the increments.
 */

/** The repository root, three levels above this directory. */
const repoRoot = Effect.gen(function* () {
	const path = yield* Path.Path
	return path.resolve(import.meta.dirname, "../../..")
})

/** "test/types/schema/.scale-x/index.ts(12,3): error TS2345: ..." -> its file, line and code. */
const diagnosticLine = regex("^(.+?)\\((\\d+),(\\d+)\\): error (TS\\d+): ")

/** "Instantiations:  7747124" -> the count. */
const instantiationsLine = regex("^Instantiations:\\s+(\\d+)$")

/** "Types:  744562" -> the count. */
const typesLine = regex("^Types:\\s+(\\d+)$")

/** A continuation line of the diagnostic above it. */
const continuationLine = regex("^\\s")

/** An error diagnostic of the program: its line, its code, and its first line with every continuation line. */
interface ProgramError {
	readonly line: number
	readonly code: string
	readonly lines: Array<string>
}

/** What one program's check reported: its size, its error diagnostics, every other output line, and its counts. */
interface Measured {
	readonly size: number
	readonly errors: ReadonlyArray<{
		readonly line: number
		readonly code: string
		readonly text: string
	}>
	readonly unattributed: ReadonlyArray<string>
	readonly types: number
	readonly instantiations: number
}

/**
 * The program `source` writes at `size`, armed or disarmed, written into a fresh directory under the repository
 * directory `dir`, so it resolves the sources as the fixtures there do, and checked by the repository's compiler with
 * its extended diagnostics: what it reported, and the directives its disarmed copy must raise.
 */
export const measuredProgram = (
	dir: string,
	size: number,
	source: (entries: BudgetEntries) => string,
	armed: boolean
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const spelled = yield* repoRoot
			const root = yield* fs.realPath(spelled)
			const programDir = yield* scopedTempDir(path.join(root, dir), ".scale-")
			const entry = (repoPath: string): string => {
				const relative = path.relative(programDir, path.join(root, repoPath))
				return Str.startsWith(".")(relative) ? relative : `./${relative}`
			}
			const written = source(entriesFrom(entry))
			const placed = armed ? { source: written, directives: [] } : disarm("index.ts", written)
			yield* fs.writeFileString(path.join(programDir, "package.json"), '{ "type": "module" }\n')
			yield* fs.writeFileString(path.join(programDir, "index.ts"), placed.source)
			yield* fs.writeFileString(
				path.join(programDir, "tsconfig.json"),
				jsonText({
					extends: Arr.map(["packages/devtools/tsconfig.base.json", "tsconfig.base.json"], (base) =>
						path.relative(programDir, path.join(root, base))
					),
					compilerOptions: {
						noEmit: true,
						noErrorTruncation: true,
						customConditions: ["grizzle-source"],
						plugins: []
					},
					files: ["index.ts"]
				})
			)
			const ran = yield* run(
				process.execPath,
				[
					path.join(root, "node_modules/typescript/bin/tsc"),
					"--pretty",
					"false",
					"--extendedDiagnostics",
					"--checkers",
					"1",
					"-p",
					path.join(programDir, "tsconfig.json")
				],
				{ cwd: root, env: { PWD: root } }
			)
			const program = path.relative(root, path.join(programDir, "index.ts"))
			const errors: Array<ProgramError> = []
			const unattributed: Array<string> = []
			let instantiations: number | undefined
			let types: number | undefined
			let current: ProgramError | undefined
			for (const line of Str.split(ran.stdout, "\n")) {
				if (current !== undefined && continuationLine.test(line)) {
					current.lines.push(line)
					continue
				}
				current = undefined
				const counted = instantiationsLine.exec(Str.trim(line))
				if (counted !== null) {
					instantiations = Number(counted[1])
					continue
				}
				const made = typesLine.exec(Str.trim(line))
				if (made !== null) {
					types = Number(made[1])
					continue
				}
				const diagnostic = diagnosticLine.exec(line)
				if (diagnostic === null) {
					continue
				}
				if (diagnostic[1] === program) {
					current = {
						line: Number(diagnostic[2]),
						code: defined(diagnostic[4], "the code a diagnostic names"),
						lines: [line]
					}
					errors.push(current)
				} else {
					unattributed.push(line)
				}
			}
			const measured: Measured = {
				size,
				errors: Arr.map(errors, (e) => ({
					line: e.line,
					code: e.code,
					text: Arr.join(e.lines, "\n")
				})),
				unattributed: [
					...unattributed,
					...Arr.filter(Str.split(ran.stderr, "\n"), (l) => Str.trim(l) !== "")
				],
				types: defined(types, `tsgo reports the types of the program at ${size}`),
				instantiations: defined(
					instantiations,
					`tsgo reports the instantiations of the program at ${size}`
				)
			}
			return { measured, directives: placed.directives }
		})
	)

/** The program at each size, armed, checked one after another: each check uses the cores tsgo takes. */
export const measuredSizes = (
	dir: string,
	sizes: ReadonlyArray<number>,
	source: (size: number, entries: BudgetEntries) => string
) =>
	Effect.forEach(sizes, (size) =>
		Effect.map(
			measuredProgram(dir, size, (entries) => source(size, entries), true),
			(checked) => checked.measured
		)
	)

/** A program typechecks with no diagnostic: no error of its own and no line about anything else. */
export const assertClean = (m: Measured, what: string): void => {
	assert.deepEqual(
		{ errors: Arr.map(m.errors, (e) => e.text), unattributed: m.unattributed },
		{ errors: [], unattributed: [] },
		`${what} at ${m.size} typechecks with no diagnostic`
	)
}

/** One count's growth over sizes n, 2n and 4n is linear: an increment ratio under 3. */
const linearCount = (
	what: string,
	count: string,
	at: (m: Measured) => number,
	sizes: ReadonlyArray<Measured>
): void => {
	const [small, middle, large] = sizes
	const s = defined(small, `${what} is measured at n`)
	const m = defined(middle, `${what} is measured at 2n`)
	const l = defined(large, `${what} is measured at 4n`)
	assert.equal(m.size, 2 * s.size, `${what} is measured at n and 2n`)
	assert.equal(l.size, 2 * m.size, `${what} is measured at 2n and 4n`)
	const first = at(m) - at(s)
	const second = at(l) - at(m)
	assert.ok(first > 0, `each step of ${what} adds ${count}: ${first} from ${s.size} to ${m.size}`)
	assert.ok(
		second < 3 * first,
		`${count} linear in ${what}: ${second} from ${m.size} to ${l.size} against ${first} from ${s.size} to ${m.size}, a ratio of ${(second / first).toFixed(2)}, which a linear count holds at 2 and a quadratic one at 4`
	)
}

/** Types and instantiations both grow linearly over the sizes n, 2n and 4n of one dimension. */
export const assertLinear = (what: string, sizes: ReadonlyArray<Measured>): void => {
	linearCount(what, "types", (m) => m.types, sizes)
	linearCount(what, "instantiations", (m) => m.instantiations, sizes)
}
