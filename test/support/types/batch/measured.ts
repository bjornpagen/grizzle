import { assert, defined } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import {
	type FiniteSpace,
	type Kill,
	type Need,
	NeedFailed,
	type Oracle,
	type Property,
	property
} from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import type * as NodeServices from "@effect/platform-node/NodeServices"
import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Option, Path, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import type { PreludeAt } from "#test/support/prelude.ts"
import { entryFrom } from "#test/support/types/batch/batch.ts"
import { compiled } from "#test/support/types/batch/compiler.ts"
import { entriesFrom } from "#test/support/types/query/budget/generate.ts"

/**
 * A type cost gate: a generated program checked alone, as a cost gate reads it, its diagnostics and the checker's
 * counts of the types it made and the instantiations it ran (tsgo --extendedDiagnostics). A count is one program's, so
 * each program is a project of its own in a directory of its case's, outside every other, with the batch's compiler
 * options and no Effect language service, checked by one checker: several checkers each make the types of the files
 * they check, and how the files fall to them moves the counts by more than a small dimension's step. The programs of
 * one case are checked at once, each a process of its own whose counts its own program alone decides.
 *
 * A growth gate checks a program at three sizes of one dimension an equal step apart, 2h, 4h and 6h (EqualSteps), each
 * step a whole number of the periods its generator repeats with, so every step adds the same units in the same
 * proportions. It holds every program to no diagnostic, each step to add both types and instantiations, and the
 * instantiations to grow no faster than linearly, exactly (test/support/growth.ts incrementsDoNotGrow): the second step
 * adds no more than the first, so no unit costs more for the units before it, and a cost per unit that grows with the
 * program, a call that reads a schema-sized union per unit among them, instantiates more. No ratio is read; the three
 * sizes are the law's own definition, not a budget.
 *
 * The types a program makes are not judged by the law: the checker interns them, reusing a type it made before, and
 * orders a union's members by type id, so where a declaration elsewhere shifts the ids the checker meets a program's
 * types in another order and makes other intermediates, by tens, at one size and not the next. At 1d492a7c the
 * insertAll program's types at 10, 20 … 60 relations step by 5,145, 5,273, 5,173, 5,175 and 5,243, its instantiations
 * by exactly 48,902 each time. 1e51dd0d added 24 types of its own at every size (its WalPosition brand, its Result, the
 * invalidated notification's forms), and at 20 relations alone 50 anonymous type parameters and one union of 20 members
 * (each program traced with --generateTrace and its types diffed as a multiset), which turned that program's second
 * difference of types from -28 to +23 with no change of shape (GREENTRUNK, 2026-11-15).
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

/** "index.ts(12,3): error TS2345: ..." -> its file, line and code. */
const diagnosticLine = regex("^(.+?)\\((\\d+),(\\d+)\\): error (TS\\d+): ")

/** "Instantiations:  7747124" -> the count. */
const instantiationsLine = regex("^Instantiations:\\s+(\\d+)$")

/** "Types:  744562" -> the count. */
const typesLine = regex("^Types:\\s+(\\d+)$")

/** A continuation line of the diagnostic above it. */
const continuationLine = regex("^\\s")

/** The program's one module, the file every diagnostic of its own names. */
const programFile = "index.ts"

/** An error diagnostic of the program: its line, its code, and its first line with every continuation line. */
interface ProgramError {
	readonly line: number
	readonly code: string
	readonly lines: Array<string>
}

/** What one program's check reported: its size, its error diagnostics, every other output line, and its counts. */
export interface Measured {
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
 * The declarations of the checkout's engine and shell (packages/engine, packages/grizzle) a measured program reads in
 * place of their sources: each package's tsconfig in its worker's mirror, which a program's tsconfig references.
 */
export type Declarations = Readonly<{ engine: string; grizzle: string }>

/**
 * Where a gate's case measures its programs: the checkout whose compiler and sources they are checked against (a
 * mutant's worker tree under the mutator), the case's own directory, each program a directory of its own in it, and
 * the declarations its programs read the engine and the shell through.
 */
export type Measuring = Readonly<{ root: string; dir: string; declarations: Declarations }>

/** A program to measure: its size, as its report names it, and its source, its imports reached through `entries`. */
export interface SizedProgram {
	readonly size: number
	readonly source: (entries: PreludeAt) => string
}

/**
 * The program `program` writes, written into the empty directory `programDir` beside a package.json that makes it a
 * module, the checkout's node_modules and a tsconfig extending its base configuration that references the engine's and
 * the shell's declarations, so an import of either reads its declaration and the check pays for the program alone, and
 * checked by the checkout's compiler with its extended diagnostics and one checker: what it reported. The check is
 * never incremental, as tsconfig.base.json is, so its counts are a whole program's; the engine's and the shell's part
 * of them is the same in every program of a case, so it cancels in every increment a law reads.
 */
const measuredProgram = (at: Measuring, programDir: string, program: SizedProgram) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const root = at.root
		yield* fs.makeDirectory(programDir)
		yield* fs.writeFileString(path.join(programDir, "package.json"), '{ "type": "module" }\n')
		yield* fs.symlink(path.join(root, "node_modules"), path.join(programDir, "node_modules"))
		yield* fs.writeFileString(
			path.join(programDir, programFile),
			program.source(entriesFrom(entryFrom(path, root, programDir)))
		)
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
				files: [programFile],
				references: [
					{ path: path.relative(programDir, at.declarations.engine) },
					{ path: path.relative(programDir, at.declarations.grizzle) }
				]
			})
		)
		const ran = yield* compiled(root, programDir, [
			"--pretty",
			"false",
			"--extendedDiagnostics",
			"--checkers",
			"1",
			"-p",
			"tsconfig.json"
		])
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
			if (diagnostic[1] === programFile) {
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
			size: program.size,
			errors: Arr.map(errors, (e) => ({
				line: e.line,
				code: e.code,
				text: Arr.join(e.lines, "\n")
			})),
			unattributed: [
				...unattributed,
				...Arr.filter(Str.split(ran.stderr, "\n"), (l) => Str.trim(l) !== "")
			],
			types: defined(types, `tsgo reports the types of the program at ${program.size}`),
			instantiations: defined(
				instantiations,
				`tsgo reports the instantiations of the program at ${program.size}`
			)
		}
		return measured
	})

/**
 * Each program, in order, each in a directory of its own under the case's directory, every one checked at once: each
 * check is a process of its own with one checker, whose counts its own program alone decides, so checking them at once
 * moves no count.
 */
export const measuredEach = (at: Measuring, programs: ReadonlyArray<SizedProgram>) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		return yield* Effect.forEach(
			programs,
			(program, index) => measuredProgram(at, path.join(at.dir, `p${index}`), program),
			{ concurrency: "unbounded" }
		)
	})

/** The program at each of the steps' sizes, every size checked at once (measuredEach). */
const measuredSizes = (
	at: Measuring,
	steps: EqualSteps,
	source: (size: number, entries: PreludeAt) => string
) =>
	measuredEach(
		at,
		Arr.map(steps.sizes, (size) => ({
			size,
			source: (entries: PreludeAt) => source(size, entries)
		}))
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
const assertGrowthLaw = (what: string, at: EqualSteps, measured: ReadonlyArray<Measured>): void => {
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

/** What a cost gate's case needs: a directory of its own for its programs, and the checkout the compiler reads. */
/** The packages whose declarations a measured program reads, each with the packages it references. */
const declaredPackages = [
	{ name: "engine", references: [] },
	{ name: "grizzle", references: ["engine"] }
] as const

/** The declarations could not be built: the step that failed, or the compiler's report of the build. */
const declarationsFailed = (message: string) =>
	NeedFailed.make({
		need: declarationsKey,
		message: `the engine's and the shell's declarations: ${message}`
	})

const declarationsKey =
	"grizzle type tier: the declarations of packages/engine and packages/grizzle"

/**
 * The checkout's engine and shell as declarations, once per worker: the checkout's own (packages/<name>/types), which
 * the typecheck builds, where a dry build (tsc -b --dry, which writes nothing) finds both projects up to date, so a run
 * on a typechecked checkout builds nothing; otherwise built into a directory of the worker's own (removed with the
 * worker), as a mutant's worker tree, which holds no packages/<name>/types, always is: a mirror of the two package
 * directories, each its package.json, its sources and its node_modules linked from the checkout, the checkout's
 * node_modules linked at the mirror's root, and a tsconfig extending the package's own with its output in the mirror,
 * built by the checkout's compiler (tsc -b, the shell's build building the engine's; the build flag comes first, as
 * tsc reads it). No build writes a file another worker reads or the checkout's own packages/<name>/types.
 */
const declarations: Need<Declarations> = {
	key: declarationsKey,
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const takeCheckout = yield* Checkout.dir.open
		const checkout = yield* Effect.scoped(takeCheckout)
		const root = yield* fs.realPath(checkout)
		const dry = yield* compiled(root, root, [
			"-b",
			"packages/grizzle/tsconfig.json",
			"--dry",
			"--pretty",
			"false"
		])
		if (dry.status === 0 && !Str.includes("A non-dry build would")(dry.stdout)) {
			const own: Declarations = {
				engine: path.join(root, "packages/engine/tsconfig.json"),
				grizzle: path.join(root, "packages/grizzle/tsconfig.json")
			}
			return own
		}
		const mirror = yield* fs.makeTempDirectoryScoped({ prefix: "declarations-" })
		yield* fs.symlink(path.join(root, "node_modules"), path.join(mirror, "node_modules"))
		for (const declared of declaredPackages) {
			const source = path.join(root, "packages", declared.name)
			const target = path.join(mirror, "packages", declared.name)
			yield* fs.makeDirectory(target, { recursive: true })
			yield* fs.copyFile(path.join(source, "package.json"), path.join(target, "package.json"))
			yield* fs.symlink(path.join(source, "src"), path.join(target, "src"))
			yield* fs.symlink(path.join(source, "node_modules"), path.join(target, "node_modules"))
			yield* fs.writeFileString(
				path.join(target, "tsconfig.json"),
				jsonText({
					extends: path.relative(target, path.join(source, "tsconfig.json")),
					compilerOptions: { outDir: "types", tsBuildInfoFile: "types/tsconfig.tsbuildinfo" },
					references: Arr.map(declared.references, (name) => ({ path: `../${name}` }))
				})
			)
		}
		const built = yield* compiled(root, mirror, [
			"-b",
			"packages/grizzle/tsconfig.json",
			"--pretty",
			"false"
		])
		if (built.status !== 0) {
			return yield* declarationsFailed(
				`tsc -b exited with status ${built.status}: ${built.stdout}${built.stderr}`
			)
		}
		const made: Declarations = {
			engine: path.join(mirror, "packages/engine/tsconfig.json"),
			grizzle: path.join(mirror, "packages/grizzle/tsconfig.json")
		}
		return made
	}).pipe(
		Effect.map((made) => Effect.succeed(made)),
		Effect.catchTags({
			PlatformError: (error) => Effect.fail(declarationsFailed(error.message)),
			CompilerStalled: (error) => Effect.fail(declarationsFailed(error.message))
		})
	)
}

const gateNeeds = { dir: Scratch.dir, checkout: Checkout.dir, declarations } as const

/**
 * How long one cost gate's case may run: its programs, checked at once, each by one checker, so its time is its slowest
 * program's, and a checker's work is one core's however many the machine has. A check that stops making progress is
 * the stall guard's (compiler.ts stallWindow), so this bounds only a check that is still working.
 *
 * @limitKind measured
 * @owner the type tier's cost gates (test/support/types/batch/measured.ts)
 * @unit milliseconds
 * @scope one case of a cost gate: one dimension's programs (three sizes of a growth gate, or the four and eight
 *   programs of a base-size gate) written and checked at once, each by one tsgo checker
 * @evidence ~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/cost-cases.txt (each gate's run on the runner, and
 *   families' programs under GNU time, tsgo --extendedDiagnostics --checkers 1) and measure/run-integrated-4.txt (every
 *   gate passing under this deadline)
 * @observed 2026-11-16, 03:00 to 03:30 UTC
 * @environment cassowary, Ubuntu 26.04 arm64, 64 cores, Node 26.13, TypeScript 7.1.0-beta (tsgo), grizzle 4ca3036a with
 *   toolchain 487b28e; load average 290 to 815 from other sessions
 * @workload every dimension of the eleven cost gates; the largest, schema/budget/families at 680, 1,360 and 2,040
 *   families
 * @result every case but one finished within 49 s with its kills; families at 2,040 families took 112.2 s of wall and
 *   61.4 s of CPU (1.6 GB) at load 452, at 1,360 families 60.7 s and 33.0 s, at 680 33.3 s and 17.1 s, so that case ran
 *   past the runner's 60 s case deadline
 * @decision 600 s, five times the slowest case's 112 s at load 452: one checker's CPU (61 s) is the floor on an idle
 *   machine, and a machine five times busier still finishes it
 * @revalidate a dimension whose largest program grows; a TypeScript 7 or tsgo upgrade; another machine
 */
const costCaseDeadline = 600_000

/**
 * What a cost gate states: the box its dimensions exhaust, in words; how a dimension prints; what measuring one checks;
 * its oracle; and its kills. A gate keeps no case: every dimension runs on every run.
 */
export type CostGateSpec<D, E> = Readonly<{
	box: string
	name: (dimension: D) => string
	measure: (at: Measuring, dimension: D) => Effect.Effect<void, E, NodeServices.NodeServices>
	oracle: Oracle
	kills: ReadonlyArray<Kill>
}>

/**
 * A cost gate over the dimensions of a program's roster: an exhaustion, each case one dimension, its programs measured
 * in the case's own directory against the checkout (Checkout.dir: the compiler reads the sources from disk, so a mutant
 * reaches it only in a worker tree).
 */
export const costGate = <D, E>(dimensions: FiniteSpace<D>, spec: CostGateSpec<D, E>): Property =>
	property.exhaust(dimensions, {
		box: spec.box,
		needs: gateNeeds,
		caseDeadline: costCaseDeadline,
		situations: [],
		oracle: spec.oracle,
		kept: [],
		kills: spec.kills,
		show: spec.name,
		check: (resources) => (dimension) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const dir = yield* resources.dir
				const checkout = yield* resources.checkout
				const root = yield* fs.realPath(checkout)
				const at = yield* fs.realPath(dir)
				const declared = yield* resources.declarations
				yield* spec.measure({ root, dir: at, declarations: declared }, dimension)
			})
	})

/** One dimension of a growth gate: its name, its equal steps, and its program at a size. */
export type GrowthDimension = Readonly<{
	name: string
	steps: EqualSteps
	source: (size: number, entries: PreludeAt) => string
}>

/**
 * A growth gate: each dimension's program at its three sizes, each typechecking with no diagnostic, each step adding
 * types and instantiations, and its instantiations growing no faster than linearly (assertGrowthLaw). Oracle: the
 * compiler's own counts, compared step against step.
 */
export const growthGate = (
	dimensions: FiniteSpace<GrowthDimension>,
	spec: Readonly<{ box: string; kills: ReadonlyArray<Kill> }>
): Property =>
	costGate(dimensions, {
		box: spec.box,
		name: (dimension) =>
			`${dimension.name} at ${Arr.join(
				Arr.map(dimension.steps.sizes, (n) => `${n}`),
				", "
			)}`,
		measure: (at, dimension) =>
			Effect.gen(function* () {
				const sizes = yield* measuredSizes(at, dimension.steps, dimension.source)
				for (const s of sizes) {
					assertClean(s, dimension.name)
				}
				assertGrowthLaw(dimension.name, dimension.steps, sizes)
			}),
		oracle: { kind: "universal", name: "the compiler's own counts, compared step against step" },
		kills: spec.kills
	})
