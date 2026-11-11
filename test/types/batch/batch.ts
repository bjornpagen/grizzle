import net from "node:net"
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import {
	Array as Arr,
	Cause,
	Data,
	Deferred,
	Duration,
	Effect,
	FileSystem,
	Layer,
	ManagedRuntime,
	Option,
	Order,
	Path,
	Record as Rec,
	Result,
	Stream,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { defined } from "#test/support/assert.ts"
import { testTimeout } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import { sourceCondition } from "#test/support/process.ts"
import { scopedTempDir } from "#test/support/temp.ts"
import { type CompilerStalled, compiled, type Ran } from "#test/types/batch/compiler.ts"
import {
	type Diagnostic,
	type Directive,
	diagnosticKey,
	disarm
} from "#test/types/batch/directives.ts"
import { type BatchAt, typeRun } from "#test/types/batch/provided.ts"

import { regex } from "arkregex"
/**
 * The type-test batch (Writing tests): every check of the type tests' fixtures and
 * generated programs is one tsgo program, so a run loads and checks the src type graph once, not once per fixture
 * directory. The toolchain tests stay out of it, because what they prove is a program of their own: the projects' own
 * configurations.
 *
 * A unit is a set of files whose diagnostics one test reads:
 * - `fixtures`: a directory's fixtures, checked in place;
 * - `disarmed`: the same fixtures copied beside ./fixtures, at the same depth, so their relative imports resolve
 *   unchanged, with every directive disarmed. A directive is `// @ts-expect-error -- TSnnnn: why` for a structural
 *   refusal, or `// @ts-expect-error -- TSnnnn refusal: <message>` for one grizzle's type names, a Refused. The
 *   copy must raise exactly code nnnn on the line after each directive, and that diagnostic must print
 *   `Refusal<"<message>">` exactly when the directive names one, so a refusal cannot pass for the wrong reason;
 * - `program`: a generated program, written into a fresh directory under the type-test directory that owns it, armed
 *   or disarmed.
 * A group is the units one test file reads. The batch places every unit of its groups, writes one tsconfig over all of
 * their files, runs tsgo once, and attributes each diagnostic line to the unit whose file it names. It works in the
 * root's real path, which tsgo runs in, and compares files by their real paths, so no symlink in the spelling of the
 * root or of a file hides a diagnostic from its unit. A diagnostic in a file no unit owns (src/, test support, the
 * batch's own tsconfig) fails the batch, BatchDiagnosticUnowned, and so every check. A line that names no file (an
 * option tsgo refuses, an abnormal exit) is reported to every unit, so it fails every check rather than none. A unit's
 * problems, a placement that failed, a disarmed unit with no directive or a directive its diagnostic contradicts, fail
 * its checks the same way.
 *
 * The type tier's global setup (global-setup.ts) starts the batch of the type-test files a run runs in a builder, a
 * process of its own (build.ts), beside the files, and provides the result's directory and the run's seed to every
 * test process (provided.ts). The builder writes each unit's result to a file of its own, then an index naming them
 * (batchLayout), and a test reads the index and its own unit's file once the writer has finished, nothing of the other
 * units'. Drawing a generated program is one long synchronous computation, so the batch never draws one in Vitest's own
 * process, whose timers start every test process, nor in a test process, which only reads the result. A unit the batch
 * lacks fails its checks, and so does a unit whose file cannot be read whole (BatchUnreadable). Every file the
 * batch reads or writes goes through Effect's FileSystem, every directory it writes is a scoped temporary directory, and
 * the builder and tsgo are child processes their scopes own, so nothing the batch makes outlives it.
 */

/**
 * Node's file system, paths and child processes, taken once from their layers: every file the batch reads or writes
 * and every tsgo it runs goes through them, so its entry points ask nothing of their caller.
 */
const platform = await ManagedRuntime.make(
	Layer.provideMerge(
		NodeChildProcessSpawner.layer,
		Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
	)
).context()

/** The batch could not read, write or run what it needs: the platform's failure. */
export class BatchPlatformFailed extends Data.TaggedError("BatchPlatformFailed")<{
	readonly cause: unknown
}> {}

/**
 * The socket that signals the batch written failed: the global setup could not open it at `at`, or a test process lost
 * its connection to it before the writer finished. Either way no test process can learn the batch is written, so the
 * run fails instead of waiting.
 */
export class BatchSignalFailed extends Data.TaggedError("BatchSignalFailed")<{
	readonly at: string
	readonly cause: unknown
}> {}

/**
 * tsgo reported a diagnostic in a file no unit of the batch owns: `file`, its real path, and `line`, the diagnostic's
 * first line as tsgo printed it. The batch answers for its units' files, so a diagnostic it cannot attribute fails it.
 */
class BatchDiagnosticUnowned extends Data.TaggedError("BatchDiagnosticUnowned")<{
	readonly file: string
	readonly line: string
}> {
	override get message(): string {
		return `tsgo reported a diagnostic in ${this.file}, which no unit of the type-test batch owns: ${this.line}`
	}
}

/**
 * The compiler checking one of the batch's programs stalled: `config` is the program's tsconfig, `units` the units it
 * held, whose every check the stall fails, and `stall` what the stall guard saw and the goroutines it dumped.
 */
class BatchStalled extends Data.TaggedError("BatchStalled")<{
	readonly config: string
	readonly units: ReadonlyArray<string>
	readonly stall: CompilerStalled
}> {
	override get message(): string {
		return `the type-test batch's ${this.config}, holding ${Arr.join(this.units, ", ")}, stalled: ${this.stall.message}`
	}
}

/** The repository root, three levels above this directory. */
const repoRoot: Effect.Effect<string, never, Path.Path> = Effect.gen(function* () {
	const path = yield* Path.Path
	return path.resolve(import.meta.dirname, "../../..")
})

export type UnitSpec =
	| { readonly kind: "fixtures"; readonly dir: string }
	| { readonly kind: "disarmed"; readonly dir: string }
	| {
			readonly kind: "program"
			readonly dir: string
			readonly prefix: string
			readonly disarm: boolean
			/** A program whose check takes far longer than any fixture's (see `rank`). */
			readonly heavy: boolean
			/** The program's modules, from their imports spelled by `entry` and the run's seed (provided.ts). */
			readonly source: (
				entry: (path: string) => string,
				seed: number
			) => Arr.NonEmptyReadonlyArray<ProgramModule>
	  }

/** One module of a generated program: its file name in the program's directory, and its source. */
export interface ProgramModule {
	readonly file: string
	readonly source: string
}

export interface Group {
	/** The test file that reads the group's units, relative to the repository. */
	readonly owner: string
	/** Unit ids are unique across every group. */
	readonly units: Readonly<Record<string, UnitSpec>>
}

/** A Diagnostic as plain data, which JSON carries as it stands. */
type PromisedDiagnostic = Pick<Diagnostic, keyof Diagnostic>

/** An error diagnostic, with its text: its first line plus its continuation lines, joined by "\n". */
type ErrorDiagnostic = PromisedDiagnostic & { readonly text: string }

/**
 * One unit's part of the batch, as the global setup writes it as JSON and each test process reads it back: plain data,
 * so it is Json as it stands.
 */
type UnitResult = {
	/** Every line tsgo printed for the unit's files, continuation lines included. */
	readonly output: ReadonlyArray<string>
	/** Where each of the unit's error diagnostics is, by file name; its text is the output's. */
	readonly errors: ReadonlyArray<PromisedDiagnostic>
	/** The diagnostics the unit's disarmed directives promise, in order, one per directive. */
	readonly directives: ReadonlyArray<PromisedDiagnostic>
	/**
	 * Why the unit's checks fail whatever tsgo reported: a placement that failed, a disarmed unit with no directive, a
	 * directive whose diagnostic does not carry what it claims.
	 */
	readonly problems: ReadonlyArray<string>
}

type BatchResult = {
	readonly units: Readonly<Record<string, UnitResult>>
	/** Lines no unit owns. */
	readonly unattributed: ReadonlyArray<string>
}

/**
 * A written batch's index, the last file its builder writes into the batch's directory: the units it wrote a result
 * file for (batchLayout), and the lines no unit owns, which every check reports. A batch that failed as a whole names
 * no unit, and its failure is its one unattributed line.
 */
type BatchIndex = {
	readonly units: ReadonlyArray<string>
	readonly unattributed: ReadonlyArray<string>
}

/**
 * Where a batch's directory holds its result: the index (BatchIndex), and each unit's result (UnitResult) at its name
 * under `units`, a `.json` file, so a test process reads its own unit and nothing of the others'.
 */
export const batchLayout = { index: "batch.json", units: "units" } as const

const indexFile = (path: Path.Path, dir: string): string => path.join(dir, batchLayout.index)

const unitFile = (path: Path.Path, dir: string, unit: string): string =>
	path.join(dir, batchLayout.units, `${unit}.json`)

/**
 * A file of a written batch that a test process could not read whole: missing, unreadable, empty or no JSON. Its check
 * fails with it, never reading it as a unit with no diagnostic.
 */
export class BatchUnreadable extends Data.TaggedError("BatchUnreadable")<{
	readonly file: string
	readonly cause: unknown
}> {
	override get message(): string {
		return `the type-test batch's ${this.file} could not be read: ${messageOf(this.cause)}`
	}
}

/** The `.ts` files of `dir`/fixtures, in name order. */
const fixtureFiles = (root: string, dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const names = yield* fs.readDirectory(path.join(root, dir, "fixtures"))
		return Arr.sort(
			Arr.filter(names, (file) => Str.endsWith(".ts")(file)),
			Order.String
		)
	})

/**
 * What the batch knows of a unit before tsgo runs: the diagnostics its directives promise, and why its checks fail
 * whatever tsgo reports.
 */
interface Placement {
	readonly directives: ReadonlyArray<Directive>
	readonly problems: ReadonlyArray<string>
}

interface Placed extends Placement {
	/** Absolute paths of the unit's files. */
	readonly files: ReadonlyArray<string>
}

/** A disarmed unit proves its refusals only through its directives: with none it proves nothing. */
const vacuous = (dir: string, directives: ReadonlyArray<Directive>): ReadonlyArray<string> =>
	directives.length === 0 ? [`${dir}: a disarmed unit with no directive proves nothing`] : []

/** A unit that could not be placed: why, as its problem says. */
class PlacementFailed extends Data.TaggedError("PlacementFailed")<{
	readonly reason: string
}> {}

/** A thrown placement step (a directive outside the grammar, a generator's refusal) as the unit's problem. */
const placing = <A>(step: () => A): Effect.Effect<A, PlacementFailed> =>
	Effect.try({ try: step, catch: (thrown) => new PlacementFailed({ reason: messageOf(thrown) }) })

/**
 * Writes a unit's files, if it has any to write, into temporary directories the batch's scope removes; a generated
 * program is generated under the run's seed.
 */
const place = (root: string, spec: UnitSpec, seed: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		switch (spec.kind) {
			case "fixtures": {
				const fixtures = yield* fixtureFiles(root, spec.dir)
				const placed: Placed = {
					files: Arr.map(fixtures, (file) => path.join(root, spec.dir, "fixtures", file)),
					directives: [],
					problems: []
				}
				return placed
			}
			case "disarmed": {
				/** The copy sits beside ./fixtures, at the same depth, so the fixtures' relative imports resolve unchanged. */
				const copy = yield* scopedTempDir(path.join(root, spec.dir), ".disarmed-")
				const files = yield* fixtureFiles(root, spec.dir)
				const disarmed = yield* Effect.forEach(files, (file) =>
					Effect.gen(function* () {
						const source = yield* fs.readFileString(path.join(root, spec.dir, "fixtures", file))
						const armed = yield* placing(() => disarm(file, source))
						yield* fs.writeFileString(path.join(copy, file), armed.source)
						return { file: path.join(copy, file), directives: armed.directives }
					})
				)
				const directives = Arr.flatMap(disarmed, (d) => d.directives)
				const placed: Placed = {
					files: Arr.map(disarmed, (d) => d.file),
					directives,
					problems: vacuous(spec.dir, directives)
				}
				return placed
			}
			case "program": {
				/** Inside the repository, so the program resolves effect and arkregex as the sources do. */
				const scratch = yield* scopedTempDir(path.join(root, spec.dir), spec.prefix)
				yield* fs.writeFileString(path.join(scratch, "package.json"), '{ "type": "module" }\n')
				const entry = (repoPath: string): string => {
					const relative = path.relative(scratch, path.join(root, repoPath))
					return Str.startsWith(".")(relative) ? relative : `./${relative}`
				}
				const modules = yield* placing(() => spec.source(entry, seed))
				const written = yield* Effect.forEach(modules, (m) =>
					Effect.gen(function* () {
						const file = path.join(scratch, m.file)
						const armed = spec.disarm
							? yield* placing(() => disarm(m.file, m.source))
							: { source: m.source, directives: [] }
						yield* fs.writeFileString(file, armed.source)
						return { file, directives: armed.directives }
					})
				)
				const directives = Arr.flatMap(written, (w) => w.directives)
				const placed: Placed = {
					files: Arr.map(written, (w) => w.file),
					directives,
					problems: spec.disarm ? vacuous(`${spec.dir}/${spec.prefix}`, directives) : []
				}
				return placed
			}
		}
	})

/** What a program with no file reports: nothing, a clean exit. */
const nothingRan: Ran = { status: 0, stdout: "", stderr: "" }

/** "test/types/page/fixtures/page.ts(12,3): error TS2345: ..." -> its path, line, category and code. */
const diagnosticLine = regex(
	"^(.+?)\\((\\d+),(\\d+)\\): (error|warning|message|suggestion) (TS\\d+): "
)

/** An error diagnostic as tsgo printed it: its first line, then each continuation line. */
interface Printed extends Diagnostic {
	readonly lines: Array<string>
}

/** The text from `Refusal<"` through the next `">`: the refusal a diagnostic prints, none where it prints none. */
const refusalFragment = (text: string): Option.Option<string> =>
	Option.flatMap(Str.indexOf('Refusal<"')(text), (start) =>
		Option.map(Str.indexOf('">')(Str.slice(start)(text)), (length) =>
			Str.slice(start, start + length + 2)(text)
		)
	)

/**
 * What each directive's diagnostic contradicts in its claim: a named refusal the diagnostic does not print, or a
 * refusal the diagnostic prints that a prose directive does not name.
 */
const contradicted = (
	directives: ReadonlyArray<Directive>,
	errors: ReadonlyArray<ErrorDiagnostic>
): ReadonlyArray<string> =>
	Arr.flatMap(directives, (directive): ReadonlyArray<string> => {
		const at = `${directive.file}:${directive.line}`
		const matched = Arr.filter(
			errors,
			(e) => e.file === directive.file && e.line === directive.line && e.code === directive.code
		)
		const claim = directive.claim
		switch (claim.kind) {
			case "refusal": {
				const printed = `Refusal<"${claim.refusal}">`
				return Arr.some(matched, (e) => Str.includes(printed)(e.text))
					? []
					: [`${at}: the diagnostic carries no ${printed}`]
			}
			case "prose": {
				return Option.match(
					Arr.findFirst(matched, (e) => refusalFragment(e.text)),
					{
						onNone: () => [],
						onSome: (fragment) => [
							`${at}: the diagnostic carries ${fragment}: name it, "// @ts-expect-error -- ${directive.code} refusal: <message>"`
						]
					}
				)
			}
		}
	})

/**
 * Attributes every line tsgo printed to the unit whose file it names, then compares each directive with its
 * diagnostic. tsgo ran in `root`, so a file it names resolves against `root`, and `owners` is keyed by real path. A
 * diagnostic in a file no unit owns fails the batch.
 */
const attribute = Effect.fn("attribute")(function* (
	ran: Ran,
	root: string,
	owners: ReadonlyMap<string, string>,
	placements: ReadonlyMap<string, Placement>
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	/** Each unit's placement, and the lines and errors tsgo printed for its files. */
	const units = new Map<
		string,
		{
			readonly placement: Placement
			readonly output: Array<string>
			readonly errors: Array<Printed>
		}
	>()
	for (const [unit, placement] of placements) {
		units.set(unit, { placement, output: [], errors: [] })
	}
	const unattributed: Array<string> = []
	/** The output a continuation line belongs to, the last diagnostic's, and the error it continues, if it is one. */
	let current: Array<string> | undefined
	let continued: Printed | undefined
	for (const line of Str.split(ran.stdout, "\n")) {
		if (Str.trim(line) === "") {
			continue
		}
		if (regex("^\\s").test(line) && current !== undefined) {
			current.push(line)
			continued?.lines.push(line)
			continue
		}
		continued = undefined
		const match = diagnosticLine.exec(line)
		if (match === null) {
			unattributed.push(line)
			current = unattributed
			continue
		}
		const printed = defined(match[1], "the file a diagnostic names")
		const named = yield* fs.realPath(path.resolve(root, printed))
		const owner = owners.get(named)
		const unit = owner === undefined ? undefined : units.get(owner)
		if (unit === undefined) {
			return yield* new BatchDiagnosticUnowned({ file: named, line })
		}
		unit.output.push(line)
		current = unit.output
		if (match[4] === "error") {
			continued = {
				file: path.basename(printed),
				line: Number(match[2]),
				code: defined(match[5], "the code a diagnostic names"),
				lines: [line]
			}
			unit.errors.push(continued)
		}
	}
	for (const line of Str.split(ran.stderr, "\n")) {
		if (Str.trim(line) !== "") {
			unattributed.push(line)
		}
	}
	if (ran.status > 2) {
		unattributed.push(`tsgo exited abnormally: status ${ran.status}`)
	}
	const results: Record<string, UnitResult> = {}
	for (const [unit, { placement, output, errors: diagnostics }] of units) {
		const errors = Arr.map(diagnostics, ({ file, line, code, lines }) => ({
			file,
			line,
			code,
			text: Arr.join(lines, "\n")
		}))
		results[unit] = {
			output,
			errors: Arr.map(errors, ({ file, line, code }) => ({ file, line, code })),
			directives: Arr.map(placement.directives, ({ file, line, code }) => ({ file, line, code })),
			problems: [...placement.problems, ...contradicted(placement.directives, errors)]
		}
	}
	const result: BatchResult = { units: results, unattributed }
	return result
})

/**
 * tsgo's checkers take the program's files round robin, in program order, where a file follows the files it imports.
 * The generated programs come last, after the fixtures have loaded everything they import, so they take consecutive
 * places, and the heavy ones last of all, so no two of them share a checker.
 */
const rank = (spec: UnitSpec): number => (spec.kind !== "program" ? 0 : spec.heavy ? 2 : 1)

/**
 * The batch's hang guard: as long as one test may run (testTimeout). Every test that reads the batch waits for it
 * within its own timeout, so a check still running past that serves no test, and the guard catches a hang without
 * judging a slow check, which the growing-schema programs make for as long as tsgo takes.
 */
const hangGuard = Duration.millis(testTimeout.value)

/**
 * Places every unit of `groups` under the run's seed, typechecks them as one program, and attributes the diagnostics.
 * A unit that cannot be placed (a directive outside the grammar, a refusal naming no Refused) reports why as a
 * problem. Every directory it writes is removed when it returns, however it returns.
 */
const buildBatch = (groups: ReadonlyArray<Group>, seed: number) =>
	repoRoot.pipe(
		Effect.provideContext(platform),
		Effect.flatMap((root) => buildBatchAt(root, groups, seed))
	)

/** The batch of `groups` over the repository at `root`, however `root` spells it. */
export const buildBatchAt = (root: string, groups: ReadonlyArray<Group>, seed: number) =>
	buildBatchOn(root, groups, seed).pipe(
		Effect.catchTag("PlatformError", (cause) => Effect.fail(new BatchPlatformFailed({ cause }))),
		Effect.provideContext(platform)
	)

const buildBatchOn = (spelled: string, groups: ReadonlyArray<Group>, seed: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const root = yield* fs.realPath(spelled)
			const units = Arr.sort(
				Arr.flatMap(groups, (group) => Rec.toEntries(group.units)),
				Order.mapInput(Order.Number, ([, spec]: readonly [string, UnitSpec]) => rank(spec))
			)
			const owners = new Map<string, string>()
			const placements = new Map<string, Placement>()
			for (const [unit, spec] of units) {
				const placed = yield* Effect.result(place(root, spec, seed))
				if (Result.isFailure(placed)) {
					const reason =
						placed.failure instanceof PlacementFailed
							? placed.failure.reason
							: messageOf(placed.failure)
					placements.set(unit, { directives: [], problems: [`${unit}: ${reason}`] })
					continue
				}
				for (const file of placed.success.files) {
					const realPath = yield* fs.realPath(file)
					owners.set(realPath, unit)
				}
				placements.set(unit, {
					directives: placed.success.directives,
					problems: placed.success.problems
				})
			}
			const batch = yield* scopedTempDir(path.join(root, "test/types"), ".batch-")
			/**
			 * A disarmed generated program is checked as a program of its own, apart from its armed twin: a checker reports a
			 * diagnostic once per instantiation it caches (TS2589, the instantiation depth limit, is reported only where the
			 * type is first instantiated), so in one program the armed twin's suppressed diagnostic would hide the disarmed
			 * one's.
			 */
			const apart = new Set(
				Arr.flatMap(units, ([unit, spec]) => (spec.kind === "program" && spec.disarm ? [unit] : []))
			)
			const programs = [
				{ config: "tsconfig.json", holds: (unit: string) => !apart.has(unit) },
				{ config: "tsconfig.disarmed.json", holds: (unit: string) => apart.has(unit) }
			]
			const results = yield* Effect.forEach(
				programs,
				({ config, holds }) =>
					Effect.gen(function* () {
						const held = new Map(Arr.filter([...owners], ([, unit]) => holds(unit)))
						const placed = new Map(Arr.filter([...placements], ([unit]) => holds(unit)))
						if (held.size === 0) {
							return yield* attribute(nothingRan, root, held, placed)
						}
						/**
						 * The compiler's strictness alone: no Effect language service, as in the engine's project, so a
						 * program checks the types its fixtures state, and their Effect diagnostics stay the typecheck gate's,
						 * under tsconfig.json's per-file overrides. No truncation, so a Refusal<"…"> deep in a long type is
						 * never elided from a diagnostic. The package's own name resolves to src, as in tsconfig.json
						 * (package.json's grizzle-source export).
						 */
						const tsconfig = jsonText({
							extends: Arr.map(
								["packages/devtools/tsconfig.base.json", "tsconfig.base.json"],
								(base) => path.relative(batch, path.join(root, base))
							),
							compilerOptions: {
								noEmit: true,
								noErrorTruncation: true,
								customConditions: ["grizzle-source"],
								plugins: []
							},
							files: Arr.map([...held.keys()], (file) => path.relative(batch, file))
						})
						yield* fs.writeFileString(path.join(batch, config), tsconfig)
						const ran = yield* Effect.timeout(
							compiled(root, ["--pretty", "false", "-p", path.join(batch, config)]),
							hangGuard
						).pipe(
							Effect.catchTag("CompilerStalled", (stall) =>
								Effect.fail(new BatchStalled({ config, units: [...placed.keys()], stall }))
							)
						)
						return yield* attribute(ran, root, held, placed)
					}),
				{ concurrency: "unbounded" }
			)
			const result: BatchResult = {
				units: Rec.fromEntries(Arr.flatMap(results, (r) => Rec.toEntries(r.units))),
				unattributed: Arr.flatMap(results, (r) => r.unattributed)
			}
			return result
		})
	)

/**
 * What a run asks of its builder (build.ts): the run's seed, its type-test files, relative to the repository, and the
 * directory to write the batch into (batchLayout).
 */
export type BuildRequest = Readonly<{
	seed: number
	files: Arr.NonEmptyReadonlyArray<string>
	dir: string
}>

/**
 * The builder ended without writing a batch: it exited with `status`, having printed `stderr`. A build that fails
 * still writes its failure (buildInto), so this is the process failing: a module it could not load, a crash, a signal.
 */
class BatchBuilderFailed extends Data.TaggedError("BatchBuilderFailed")<{
	readonly status: number
	readonly stderr: string
}> {
	override get message(): string {
		return `the type-test batch's builder exited with status ${this.status}: ${this.stderr}`
	}
}

/** A batch that failed as a whole: no unit, and its failure, the one line every check reports. */
const failedResult = (cause: Cause.Cause<unknown>): BatchResult => ({
	units: {},
	unattributed: [`the type-test batch failed: ${Cause.pretty(cause)}`]
})

/**
 * Writes `result` into the batch's directory `dir` (batchLayout): each unit's result to a file of its own, then the
 * index, by a rename, so the index names only units whose files are whole.
 */
const writeResult = (dir: string, result: BatchResult) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		for (const [unit, written] of Rec.toEntries(result.units)) {
			const file = unitFile(path, dir, unit)
			yield* fs.makeDirectory(path.dirname(file), { recursive: true })
			yield* fs.writeFileString(file, jsonText(written))
		}
		const index: BatchIndex = { units: Rec.keys(result.units), unattributed: result.unattributed }
		const at = indexFile(path, dir)
		yield* fs.writeFileString(`${at}.partial`, jsonText(index))
		yield* fs.rename(`${at}.partial`, at)
	})

/**
 * The builder's half: builds the batch of `groups` under the run's seed and writes it into `dir`, or, when the build
 * fails, its failure, so every reader learns it.
 */
export const buildInto = (groups: ReadonlyArray<Group>, seed: number, dir: string) =>
	Effect.flatMap(
		Effect.catchCause(buildBatch(groups, seed), (cause) => Effect.succeed(failedResult(cause))),
		(result) => writeResult(dir, result)
	).pipe(
		Effect.catchTag("PlatformError", (cause) => Effect.fail(new BatchPlatformFailed({ cause }))),
		Effect.provideContext(platform)
	)

/**
 * Runs the builder, the Node program at `builder`, on `request`, which it reads on stdin, to its exit: it writes the
 * batch into the request's directory itself, and an exit other than 0 is BatchBuilderFailed with what it printed on
 * stderr. The builder belongs to the run's scope, so an interrupted run kills it.
 */
const builderRan = (request: BuildRequest, builder: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(process.execPath, [sourceCondition, builder], {
				cwd: yield* repoRoot,
				stdin: { stream: Stream.make(new TextEncoder().encode(jsonText(request))), endOnDone: true }
			})
			const [, stderr, status] = yield* Effect.all(
				[
					Stream.runDrain(handle.stdout),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					handle.exitCode
				],
				{ concurrency: "unbounded" }
			)
			if (status !== 0) {
				return yield* new BatchBuilderFailed({ status, stderr })
			}
		})
	)

/**
 * The global setup's half: runs the builder at `builder` on `request`, which writes the batch into the request's
 * directory, and, when the builder ends otherwise, writes its failure there instead, so every reader learns it.
 */
export const writeBatch = (request: BuildRequest, builder: string) =>
	Effect.catchCause(builderRan(request, builder), (cause) =>
		writeResult(request.dir, failedResult(cause))
	).pipe(
		Effect.catchTag("PlatformError", (cause) => Effect.fail(new BatchPlatformFailed({ cause }))),
		Effect.provideContext(platform)
	)

/**
 * The Unix socket at `at`, open for the scope, which ends every connection once `written` is done: a test process waits
 * on it for the batch (whenWritten), so its wait ends with the writer's own completion, the result written or not, and
 * never on how the file system reports the result's rename. A connection made after the writer finished ends at once;
 * one still open when the scope closes is destroyed, which its test process sees as the batch lost.
 */
export const writtenSignal = (at: string, written: Deferred.Deferred<void>) =>
	Effect.gen(function* () {
		const waiting = new Set<net.Socket>()
		yield* Effect.acquireRelease(
			Effect.callback<net.Server, BatchSignalFailed>((resume) => {
				const server = net.createServer((connection) => {
					if (Deferred.isDoneUnsafe(written)) {
						connection.end()
						return
					}
					waiting.add(connection)
					connection.once("close", () => waiting.delete(connection))
				})
				server.once("error", (cause) => resume(Effect.fail(new BatchSignalFailed({ at, cause }))))
				server.listen(at, () => resume(Effect.succeed(server)))
			}),
			(server) =>
				Effect.callback<void>((resume) => {
					for (const connection of waiting) {
						connection.destroy()
					}
					server.close(() => resume(Effect.void))
				})
		)
		yield* Effect.forkScoped(
			Effect.andThen(
				Deferred.await(written),
				Effect.sync(() => {
					for (const connection of waiting) {
						connection.end()
					}
				})
			)
		)
	})

/** The JSON value of a written batch's `file`, or BatchUnreadable for a file missing, unreadable, empty or no JSON. */
const readWritten = <A>(file: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* Effect.mapError(
			fs.readFileString(file),
			(cause) => new BatchUnreadable({ file, cause })
		)
		return yield* Effect.try({
			try: () => trustedJson<A>(text),
			catch: (cause) => new BatchUnreadable({ file, cause })
		})
	})

/**
 * The index of the batch in `batch.dir`, once its writer has finished: the wait is a connection to the batch's signal
 * (writtenSignal), which the global setup ends when the writer finishes. A connection refused or lost is
 * BatchSignalFailed, and an index the writer did not write is BatchUnreadable.
 */
export const whenWritten = (batch: BatchAt) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		yield* Effect.callback<void, BatchSignalFailed>((resume) => {
			const connection = net.createConnection(batch.signal)
			let failure: unknown
			connection.on("error", (cause) => {
				failure = cause
			})
			connection.once("close", (hadError) =>
				resume(
					hadError
						? Effect.fail(new BatchSignalFailed({ at: batch.signal, cause: failure }))
						: Effect.void
				)
			)
			connection.resume()
			return Effect.sync(() => connection.destroy())
		})
		return yield* readWritten<BatchIndex>(indexFile(path, batch.dir))
	})

/** The result of `unit` in the written batch in `batch.dir`, or BatchUnreadable for a file missing or no JSON. */
export const readUnit = (batch: BatchAt, unit: string) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		return yield* readWritten<UnitResult>(unitFile(path, batch.dir, unit))
	})

interface Checked {
	/**
	 * Every line tsgo printed for the unit's files, then the unit's problems, then every line no unit owns: "" when the
	 * unit typechecks.
	 */
	readonly output: string
	/** The diagnostics the unit's directives promise, one per directive. */
	readonly directives: ReadonlyArray<Diagnostic>
	/** Those, as file:line:code, sorted and distinct. */
	readonly expected: ReadonlyArray<string>
	/**
	 * The unit's error diagnostics as file:line:code, sorted and distinct, then the unit's problems, then every line no
	 * unit owns.
	 */
	readonly actual: ReadonlyArray<string>
}

const checkedOf = (unit: UnitResult, unattributed: ReadonlyArray<string>): Checked => ({
	output: Arr.join([...unit.output, ...unit.problems, ...unattributed], "\n"),
	directives: unit.directives,
	expected: Arr.sort([...new Set(Arr.map(unit.directives, diagnosticKey))], Order.String),
	actual: [
		...Arr.sort([...new Set(Arr.map(unit.errors, diagnosticKey))], Order.String),
		...unit.problems,
		...unattributed
	]
})

/** A unit the run's batch does not hold: no diagnostic, and why, the problem that fails its every check. */
const lacking = (unit: string, why: string): UnitResult => ({
	output: [],
	errors: [],
	directives: [],
	problems: [`${unit}: ${why}`]
})

/** The diagnostics of `unit` in the run's batch, read in a test process of the type tier. */
export const checked = (unit: string): ReturnType<typeof checkedIn> => checkedIn(unit)

const checkedIn = (unit: string) => checkedOn(unit).pipe(Effect.provideContext(platform))

const checkedOn = (unit: string) =>
	Effect.gen(function* () {
		const run = yield* Effect.sync(typeRun)
		switch (run.batch.kind) {
			case "none":
				return checkedOf(lacking(unit, "the run started no type-test batch"), [])
			case "batch": {
				const index = yield* whenWritten(run.batch)
				if (!Arr.contains(index.units, unit)) {
					return checkedOf(
						lacking(
							unit,
							"the run's batch holds no such unit: no group of its files has it (groups.ts)"
						),
						index.unattributed
					)
				}
				const result = yield* readUnit(run.batch, unit)
				return checkedOf(result, index.unattributed)
			}
		}
	})
