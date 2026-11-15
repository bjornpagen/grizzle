import { Array as Arr, Effect, FileSystem, Option, Path, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { assert, defined } from "#test/support/assert.ts"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import type { PreludeAt } from "#test/support/prelude.ts"
import { scopedTempDir } from "#test/support/temp.ts"
import { compiled } from "#test/types/batch/compiler.ts"
import { entriesFrom } from "#test/types/query/budget/generate.ts"

import { regex } from "arkregex"
/**
 * A generated program checked alone, as a scaling test reads it: its diagnostics and the checker's counts of the types
 * it made and the instantiations it ran (tsgo --extendedDiagnostics). A count is one program's, so each program is a
 * project of its own, outside the type-test batch, with the batch's compiler options and no Effect language service,
 * checked by one checker: several checkers each make the types of the files they check, and how the files fall to
 * them moves the counts by more than a small dimension's step.
 *
 * A scaling test checks a program at three sizes of one dimension an equal step apart, 2h, 4h and 6h (EqualSteps), each step
 * a whole number of the periods its generator repeats with, so every step adds the same units in the same proportions.
 * It holds every program to no diagnostic, each step to add both types and instantiations, and the instantiations to
 * grow no faster than linearly, exactly (test/support/growth.ts incrementsDoNotGrow): the second step adds no more than
 * the first, so no unit costs more for the units before it, and a cost per unit that grows with the program, a call
 * that reads a schema-sized union per unit among them, instantiates more. No ratio is read.
 *
 * The types a program makes are not judged by the law: the checker interns them, reusing a type it made before, and
 * orders a union's members by type id, so where a declaration elsewhere shifts the ids the checker meets a program's
 * types in another order and makes other intermediates, by tens, at one size and not the next. At 1d492a7c the
 * insertAll program's types at 10, 20 … 60 relations step by 5,145, 5,273, 5,173, 5,175 and 5,243, its instantiations
 * by exactly 48,902 each time. 1e51dd0d added 24 types of its own at every size (its WalPosition brand, its Result, the
 * invalidated notification's forms), and at 20 relations alone 50 anonymous type parameters and one union of 20 members
 * (each program traced with --generateTrace and its types diffed as a multiset), which turned that program's second
 * difference of types from -28 to +23 with no change of shape (GREENTRUNK, 2026-11-15). Every plant of a superlinear
 * cost the type tier keeps turns the instantiations red (~/.cache/grizzle-release/GREENTRUNK/out/plant-scales.txt).
 */

/**
 * The sizes a dimension is checked at: one step, two and three, as incrementsDoNotGrow reads them (2h, 4h and 6h). A
 * step is even, and a whole number of the periods its generator repeats with, the units after which every pattern of
 * its program recurs (a key on every fifth relation, a shape of six, a family tree on every fourth unit).
 */
export interface EqualSteps {
	readonly half: number
	readonly sizes: readonly [number, number, number]
}

export const equalSteps = (step: number): EqualSteps => ({
	half: step / 2,
	sizes: [step, 2 * step, 3 * step]
})

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
 * The program `source` writes at `size`, written into a fresh directory under the repository directory `dir`, so it
 * resolves the sources as the fixtures there do, and checked by the repository's compiler with its extended
 * diagnostics: what it reported. The check is never incremental, as tsconfig.base.json is, so its counts are a whole
 * program's.
 */
const measuredProgram = (dir: string, size: number, source: (entries: PreludeAt) => string) =>
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
			yield* fs.writeFileString(path.join(programDir, "package.json"), '{ "type": "module" }\n')
			yield* fs.writeFileString(path.join(programDir, "index.ts"), source(entriesFrom(entry)))
			yield* fs.writeFileString(
				path.join(programDir, "tsconfig.json"),
				jsonText({
					extends: path.relative(programDir, path.join(root, "tsconfig.base.json")),
					compilerOptions: {
						noEmit: true,
						incremental: false,
						noErrorTruncation: true,
						plugins: []
					},
					files: ["index.ts"]
				})
			)
			const ran = yield* compiled(root, [
				"--pretty",
				"false",
				"--extendedDiagnostics",
				"--checkers",
				"1",
				"-p",
				path.join(programDir, "tsconfig.json")
			])
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
			return measured
		})
	)

/**
 * The program at each of the steps' sizes, every size checked at once: each check is a process of its own with one
 * checker, whose counts its own program alone decides, so checking them at once moves no count.
 */
export const measuredSizes = (
	dir: string,
	at: EqualSteps,
	source: (size: number, entries: PreludeAt) => string
) =>
	Effect.forEach(
		at.sizes,
		(size) => measuredProgram(dir, size, (entries) => source(size, entries)),
		{ concurrency: at.sizes.length }
	)

/** A program typechecks with no diagnostic: no error of its own and no line about anything else. */
export const assertClean = (m: Measured, what: string): void => {
	assert.deepEqual(
		{ errors: Arr.map(m.errors, (e) => e.text), unattributed: m.unattributed },
		{ errors: [], unattributed: [] },
		`${what} at ${m.size} typechecks with no diagnostic`
	)
}

/**
 * Each step of the program measured at the steps' sizes adds types and instantiations, so the dimension costs what it
 * measures, and its instantiations grow no faster than linearly (incrementsDoNotGrow); its types are interned, so they
 * are not judged by the law (see the header).
 */
export const assertGrowthLaw = (
	what: string,
	at: EqualSteps,
	measured: ReadonlyArray<Measured>
): void => {
	const sized = (size: number): Measured =>
		defined(
			Option.getOrUndefined(Arr.findFirst(measured, (m) => m.size === size)),
			`${what} is measured at ${size}`
		)
	for (const [count, of] of [
		["types", (m: Measured) => m.types],
		["instantiations", (m: Measured) => m.instantiations]
	] as const) {
		const [small, middle] = at.sizes
		assert.ok(
			of(sized(middle)) > of(sized(small)),
			`each step of ${what} adds ${count}: ${of(sized(small))} at ${small}, ${of(sized(middle))} at ${middle}`
		)
	}
	incrementsDoNotGrow((size) => sized(size).instantiations, at.half, `instantiations of ${what}`)
}
