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
import { typeRun } from "#test/types/batch/provided.ts"

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
 *   refusal, or `// @ts-expect-error -- TSnnnn refusal: <message>` for one grizzle's type names, a TypeRefusal. The
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
 * process of its own (build.ts), beside the files, and provides the result file and the run's seed to every test
 * process (provided.ts); a test reads its unit from that file once it is written. Drawing a generated program is one
 * long synchronous computation, so the batch never draws one in Vitest's own process, whose timers start every test
 * process, nor in a test process, which only reads the result. A unit the batch lacks fails its checks. Every file the
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
	/** The unit's error diagnostics, by file name. */
	readonly errors: ReadonlyArray<ErrorDiagnostic>
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
			errors,
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
 * A unit that cannot be placed (a directive outside the grammar, a refusal naming no TypeRefusal) reports why as a
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

/** What a run asks of its builder (build.ts): the run's seed, and its type-test files, relative to the repository. */
export type BuildRequest = Readonly<{ seed: number; files: Arr.NonEmptyReadonlyArray<string> }>

/**
 * The builder ended without printing a batch: it exited with `status`, having printed `stderr`. A build that fails
 * still prints its failure (builtText), so this is the process failing: a module it could not load, a crash, a signal.
 */
class BatchBuilderFailed extends Data.TaggedError("BatchBuilderFailed")<{
	readonly status: number
	readonly stderr: string
}> {
	override get message(): string {
		return `the type-test batch's builder exited with status ${this.status}: ${this.stderr}`
	}
}

/** A batch that failed as a whole, as JSON text: no unit, and its failure, the one line every check reports. */
const failedText = (cause: Cause.Cause<unknown>): string => {
	const failed: BatchResult = {
		units: {},
		unattributed: [`the type-test batch failed: ${Cause.pretty(cause)}`]
	}
	return jsonText(failed)
}

/** The builder's half: the batch of `groups` under the run's seed, or the failure that ended it, as JSON text. */
export const builtText = (groups: ReadonlyArray<Group>, seed: number): Effect.Effect<string> =>
	buildBatch(groups, seed).pipe(
		Effect.map(jsonText),
		Effect.catchCause((cause) => Effect.succeed(failedText(cause)))
	)

/**
 * What the builder, the Node program at `builder`, printed for `request`, which it reads on stdin: the batch as JSON
 * text, or BatchBuilderFailed when it exits otherwise. The builder belongs to the run's scope, so an interrupted run
 * kills it.
 */
const builderOutput = (request: BuildRequest, builder: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(process.execPath, [sourceCondition, builder], {
				cwd: yield* repoRoot,
				stdin: { stream: Stream.make(new TextEncoder().encode(jsonText(request))), endOnDone: true }
			})
			const [stdout, stderr, status] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					handle.exitCode
				],
				{ concurrency: "unbounded" }
			)
			if (status !== 0) {
				return yield* new BatchBuilderFailed({ status, stderr })
			}
			return stdout
		})
	)

/**
 * The global setup's half: runs the builder at `builder` on `request` and writes what it printed to `file`, or, when it
 * ends without printing a batch, its failure, so no reader waits forever. The file appears at once, by a rename.
 */
export const writeBatch = (
	request: BuildRequest,
	builder: string,
	file: string
): ReturnType<typeof writeBatchTo> => writeBatchTo(request, builder, file)

const writeBatchTo = (request: BuildRequest, builder: string, file: string) =>
	writeBatchOn(request, builder, file).pipe(
		Effect.catchTag("PlatformError", (cause) => Effect.fail(new BatchPlatformFailed({ cause }))),
		Effect.provideContext(platform)
	)

const writeBatchOn = (request: BuildRequest, builder: string, file: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* Effect.catchCause(builderOutput(request, builder), (cause) =>
			Effect.succeed(failedText(cause))
		)
		yield* fs.writeFileString(`${file}.partial`, text)
		yield* fs.rename(`${file}.partial`, file)
	})

/**
 * The batch at `file`, once it exists. It looks once the watcher on the file's directory is installed and again after
 * each event of the file system there, so the result's rename into place wakes it.
 */
export const whenWritten = (file: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const installed = yield* Deferred.make<void>()
		yield* Stream.merge(
			Stream.fromEffect(Deferred.await(installed)),
			fs.watch(path.dirname(file), { onReady: () => Deferred.doneUnsafe(installed, Effect.void) })
		).pipe(
			Stream.mapEffect(() => fs.exists(file)),
			Stream.takeUntil((exists) => exists),
			Stream.runDrain
		)
		const text = yield* fs.readFileString(file)
		return trustedJson<BatchResult>(text)
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

const checkedIn = (unit: string) =>
	checkedOn(unit).pipe(
		Effect.catchTag("PlatformError", (cause) => Effect.fail(new BatchPlatformFailed({ cause }))),
		Effect.provideContext(platform)
	)

const checkedOn = (unit: string) =>
	Effect.gen(function* () {
		const run = yield* Effect.sync(typeRun)
		switch (run.batch.kind) {
			case "none":
				return checkedOf(lacking(unit, "the run started no type-test batch"), [])
			case "batch": {
				const batch = yield* whenWritten(run.batch.file)
				return checkedOf(
					Option.match(Option.fromUndefinedOr(batch.units[unit]), {
						onNone: () =>
							lacking(
								unit,
								"the run's batch holds no such unit: no group of its files has it (groups.ts)"
							),
						onSome: (found) => found
					}),
					batch.unattributed
				)
			}
		}
	})
