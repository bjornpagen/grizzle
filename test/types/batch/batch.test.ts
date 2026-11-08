import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	string,
	unicodeScalar
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	Option,
	Order,
	Path,
	Record as Rec,
	String as Str
} from "effect"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { scopedTempDir } from "#test/support/temp.ts"
import { buildBatchAt, type UnitSpec, whenWritten } from "#test/types/batch/batch.ts"
import { guardedRun } from "#test/types/batch/compiler.ts"
import { diagnosticKey } from "#test/types/batch/directives.ts"
import { startBatch } from "#test/types/batch/global-setup.ts"
import { type TypeRun, typeRun } from "#test/types/batch/provided.ts"

/** The test file that reads these batches, which the runner's batch never holds. */
const owner = "test/types/batch/batch.test.ts"

/** The directory every planted file goes under, beside this file, relative to the repository. */
const plantedIn = "test/types/batch"

/** A planted directive, in the batch's grammar, naming the diagnostic the line under it raises. */
const DIRECTIVE = "// @ts-expect-error -- TS2322: a string is no number"

/**
 * A planted module's lines, each a declaration that typechecks or raises TS2322, either alone or under a directive: an
 * armed check reports an error alone and an unused directive (TS2578), and a disarmed copy reports every TS2322 and
 * promises one under each directive.
 */
const LINE_KINDS = ["clean", "error", "expected error", "unused directive"] as const

type LineKind = (typeof LINE_KINDS)[number]

/** The kinds of unit the batch places: a directory's fixtures, their disarmed copy, and a program armed or disarmed. */
const UNIT_KINDS = ["fixtures", "disarmed", "program", "disarmed program"] as const

type UnitKind = (typeof UNIT_KINDS)[number]

type PlantedUnit = Readonly<{
	kind: UnitKind
	modules: Arr.NonEmptyReadonlyArray<ReadonlyArray<LineKind>>
}>

/**
 * A planted batch: its units, a file no unit owns, which a program imports, whether it raises a diagnostic and which
 * unit imports it, and whether the root is spelled through a symlink outside the repository.
 */
type Planted = Readonly<{
	units: ReadonlyArray<PlantedUnit>
	unowned: Option.Option<Readonly<{ raises: boolean; importer: number }>>
	symlinked: boolean
}>

const linesGen: Gen<ReadonlyArray<LineKind>> = array(element(LINE_KINDS), { min: 1, max: 3 })

const plantedUnit: Gen<PlantedUnit> = (source) => ({
	kind: source.draw(element(UNIT_KINDS)),
	modules: Arr.prepend(source.draw(array(linesGen, { min: 0, max: 1 })), source.draw(linesGen))
})

const isProgram = (unit: PlantedUnit): boolean =>
	unit.kind === "program" || unit.kind === "disarmed program"

const isDisarmed = (unit: PlantedUnit): boolean =>
	unit.kind === "disarmed" || unit.kind === "disarmed program"

const plantedBatch: Gen<Planted> = (source) => {
	const units = source.draw(array(plantedUnit, { min: 1, max: 3 }))
	const programs = Arr.flatMap(units, (unit, at) => (isProgram(unit) ? [at] : []))
	const unowned =
		Arr.isReadonlyArrayNonEmpty(programs) && source.draw(boolean)
			? Option.some({ raises: source.draw(boolean), importer: source.draw(element(programs)) })
			: Option.none()
	return { units, unowned, symlinked: source.draw(boolean) }
}

type Feature =
	| "an armed fixtures unit"
	| "a disarmed fixtures unit"
	| "an armed program"
	| "a disarmed program"
	| "an unused directive"
	| "a disarmed unit with no directive"
	| "an unowned file that raises"
	| "an unowned file that raises nothing"
	| "a symlinked root"

const unitFeature = (kind: UnitKind): Feature => {
	switch (kind) {
		case "fixtures":
			return "an armed fixtures unit"
		case "disarmed":
			return "a disarmed fixtures unit"
		case "program":
			return "an armed program"
		case "disarmed program":
			return "a disarmed program"
	}
}

/** A planted line as written: the line its directive sits on, the line of its declaration, and its kind. */
type Placed = Readonly<{ kind: LineKind; directive: number; statement: number }>

/** A planted module's text, after `header` lines, and where each of its lines landed. */
const written = (
	lines: ReadonlyArray<LineKind>,
	header: ReadonlyArray<string>
): Readonly<{ text: string; placed: ReadonlyArray<Placed> }> => {
	const text: Array<string> = [...header]
	const placed: Array<Placed> = []
	Arr.forEach(lines, (kind, index) => {
		const declaration = (raises: boolean) =>
			`export const v${index}: number = ${raises ? '"s"' : "1"}`
		switch (kind) {
			case "clean":
			case "error":
				text.push(declaration(kind === "error"))
				placed.push({ kind, directive: text.length, statement: text.length })
				return
			case "expected error":
			case "unused directive":
				text.push(DIRECTIVE, declaration(kind === "expected error"))
				placed.push({ kind, directive: text.length - 1, statement: text.length })
		}
	})
	return { text: `${Arr.join(text, "\n")}\n`, placed }
}

/**
 * What the model expects of a module: the diagnostics a check of it reports, as the batch keys them, and the
 * diagnostics a disarmed copy's directives promise.
 */
const expectedOf = (
	file: string,
	placed: ReadonlyArray<Placed>,
	disarmed: boolean
): Readonly<{ errors: ReadonlyArray<string>; directives: ReadonlyArray<string> }> => {
	const key = (line: number, code: string) => diagnosticKey({ file, line, code })
	return {
		errors: Arr.flatMap(placed, ({ kind, directive, statement }) => {
			switch (kind) {
				case "clean":
					return []
				case "error":
					return [key(statement, "TS2322")]
				case "expected error":
					return disarmed ? [key(statement, "TS2322")] : []
				case "unused directive":
					return disarmed ? [] : [key(directive, "TS2578")]
			}
		}),
		directives: disarmed
			? Arr.flatMap(placed, ({ kind, statement }) =>
					kind === "clean" || kind === "error" ? [] : [key(statement, "TS2322")]
				)
			: []
	}
}

/** Keys sorted and distinct, as a set compares them. */
const keySet = (keys: ReadonlyArray<string>) => Arr.sort(Arr.dedupe(keys), Order.String)

/** The file a planted module is: a program's entry and its second module, or a directory's fixtures. */
const fileOf = (kind: UnitKind, index: number): string =>
	kind === "fixtures" || kind === "disarmed" ? `f${index}.ts` : index === 0 ? "index.ts" : "m1.ts"

/** The repository spelled through a symlink outside it, which the scope removes. */
const linkedRoot = (repository: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const outside = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-batch-root-" })
		const linked = path.join(outside, "repository")
		yield* fs.symlink(repository, linked)
		return linked
	})

/** The prefix a planted program's directory starts with, which a disarmed program's problem names. */
const PROGRAM_PREFIX = ".attributed-"

/**
 * Plants a batch under the repository at `repository`, its real path, builds it through the root as the case spells
 * it, and holds the result to the model: every unit's errors, promised directives and problems, and no line left
 * unattributed; or, when the unowned file raises, BatchDiagnosticUnowned naming its real path.
 */
const attributed = (planted: Planted, c: Case<Feature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const repository = yield* fs.realPath(path.resolve(import.meta.dirname, "../../.."))
			const unownedFile = yield* Option.match(planted.unowned, {
				onNone: () => Effect.succeedNone,
				onSome: ({ raises }) =>
					Effect.gen(function* () {
						c.note(raises ? "an unowned file that raises" : "an unowned file that raises nothing")
						const dir = yield* scopedTempDir(path.join(repository, plantedIn), ".unowned-")
						const file = path.join(dir, "planted.ts")
						yield* fs.writeFileString(
							file,
							`export const planted: number = ${raises ? '"s"' : "1"}\n`
						)
						const real = yield* fs.realPath(file)
						return Option.some(real)
					})
			})
			const units = yield* Effect.forEach(planted.units, (unit, at) =>
				Effect.gen(function* () {
					c.note(unitFeature(unit.kind))
					if (Arr.some(unit.modules, (lines) => Arr.contains(lines, "unused directive"))) {
						c.note("an unused directive")
					}
					const header = (entry: (repoPath: string) => string): ReadonlyArray<string> =>
						Option.match(
							Option.filter(unownedFile, () =>
								Option.exists(planted.unowned, (unowned) => unowned.importer === at)
							),
							{
								onNone: () => [],
								onSome: (file) => [
									`import { planted } from "${entry(path.relative(repository, file))}"`,
									"export const read: number = planted"
								]
							}
						)
					const modulesOf = (entry: (repoPath: string) => string) =>
						Arr.map(unit.modules, (lines, index) => ({
							file: fileOf(unit.kind, index),
							module: written(lines, index === 0 ? header(entry) : [])
						}))
					const disarmed = isDisarmed(unit)
					const expected = Arr.map(
						modulesOf(() => ""),
						({ file, module }) => expectedOf(file, module.placed, disarmed)
					)
					const directives = Arr.flatMap(expected, (e) => e.directives)
					const placeFixtures = Effect.gen(function* () {
						const dir = yield* scopedTempDir(path.join(repository, plantedIn), ".fixtures-")
						yield* fs.makeDirectory(path.join(dir, "fixtures"))
						yield* Effect.forEach(
							modulesOf(() => ""),
							({ file, module }) =>
								fs.writeFileString(path.join(dir, "fixtures", file), module.text)
						)
						return path.relative(repository, dir)
					})
					const spec: UnitSpec =
						unit.kind === "fixtures"
							? { kind: "fixtures", dir: yield* placeFixtures }
							: unit.kind === "disarmed"
								? { kind: "disarmed", dir: yield* placeFixtures }
								: {
										kind: "program",
										dir: plantedIn,
										prefix: PROGRAM_PREFIX,
										disarm: disarmed,
										heavy: false,
										source: (entry) =>
											Arr.map(modulesOf(entry), ({ file, module }) => ({
												file,
												source: module.text
											}))
									}
					const vacuous = disarmed && !Arr.isReadonlyArrayNonEmpty(directives)
					if (vacuous) {
						c.note("a disarmed unit with no directive")
					}
					const problemDir = spec.kind === "program" ? `${spec.dir}/${spec.prefix}` : spec.dir
					return {
						id: `batch/u${at}`,
						spec,
						expected: {
							errors: keySet(Arr.flatMap(expected, (e) => e.errors)),
							directives,
							problems: vacuous
								? [`${problemDir}: a disarmed unit with no directive proves nothing`]
								: []
						}
					}
				})
			)
			if (planted.symlinked) {
				c.note("a symlinked root")
			}
			const root = planted.symlinked ? yield* linkedRoot(repository) : repository
			const built = yield* Effect.exit(
				buildBatchAt(
					root,
					[{ owner, units: Rec.fromEntries(Arr.map(units, (unit) => [unit.id, unit.spec])) }],
					typeRun().seed
				)
			)
			const raisingUnowned = Option.filter(unownedFile, () =>
				Option.exists(planted.unowned, (unowned) => unowned.raises)
			)
			if (Option.isSome(raisingUnowned)) {
				const failure = Exit.findErrorOption(built)
				assert.deepEqual(
					Option.map(failure, (failed) =>
						failed._tag === "BatchDiagnosticUnowned" ? failed.file : failed._tag
					),
					raisingUnowned
				)
				return
			}
			assert.deepEqual(
				Option.map(Exit.getSuccess(built), (batch) => ({
					unattributed: batch.unattributed,
					units: Arr.map(units, (unit) =>
						Option.map(Option.fromUndefinedOr(batch.units[unit.id]), (result) => ({
							errors: keySet(Arr.map(result.errors, diagnosticKey)),
							directives: Arr.map(result.directives, diagnosticKey),
							problems: result.problems
						}))
					)
				})),
				Option.some({
					unattributed: [],
					units: Arr.map(units, (unit) => Option.some(unit.expected))
				})
			)
		})
	)

/**
 * A planted check: a tiny program, clean or raising, checked once or held in watch mode, under a drawn window and a
 * drawn interval between readings.
 */
type PlantedCheck = Readonly<{
	raises: boolean
	watch: boolean
	windowMillis: number
	everyMillis: number
}>

const plantedCheck: Gen<PlantedCheck> = (source) => ({
	raises: source.draw(boolean),
	watch: source.draw(boolean),
	windowMillis: source.draw(int(1000, 3000)),
	everyMillis: source.draw(int(50, 300))
})

/**
 * What a planted builder does once it has read its request to the end: prints a batch of `units`, one output line each,
 * whose unattributed lines are the request it read, whether it ran in a process of its own, and `padding` copies of
 * `character`; or prints a partial line on stdout and `stderr`, then exits with `status`.
 */
type PlantedBuilder =
	| Readonly<{ kind: "prints"; units: ReadonlyArray<number>; character: string; padding: number }>
	| Readonly<{ kind: "fails"; stderr: string; status: number }>

/** A test module's tier: a type test, which the batch is for, or a unit test, which it ignores. */
type Tier = "types" | "unit"

const TIERS = ["types", "unit"] as const satisfies ReadonlyArray<Tier>

/**
 * A planted run: its seed and the tier of each of its test modules, and, for a run with type tests, the builder its
 * batch runs; a run without type tests starts none.
 */
type PlantedRun =
	| Readonly<{ kind: "without type tests"; seed: number; modules: ReadonlyArray<"unit"> }>
	| Readonly<{
			kind: "with type tests"
			seed: number
			modules: ReadonlyArray<Tier>
			builder: PlantedBuilder
	  }>

/** The most a pipe holds unread, 64 KiB on macOS and Linux: a longer output reaches its reader in several reads. */
const PIPE_BUFFER_BYTES = 65_536

const printing =
	(padding: Gen<number>): Gen<PlantedBuilder> =>
	(source) => ({
		kind: "prints",
		units: source.draw(array(int(0, 9), { min: 0, max: 3 })),
		character: source.draw(unicodeScalar),
		padding: source.draw(padding)
	})

const failing: Gen<PlantedBuilder> = (source) => ({
	kind: "fails",
	stderr: source.draw(string(unicodeScalar, { min: 1, max: 24 })),
	status: source.draw(int(1, 255))
})

const withoutTypeTests: Gen<PlantedRun> = (source) => ({
	kind: "without type tests",
	seed: source.draw(int(0, 0xffff_ffff)),
	modules: source.draw(array(constant<"unit">("unit"), { min: 0, max: 3 }))
})

/** A run with type tests: unit tests, then a type test, then tests of either tier, around a builder of `builder`'s. */
const withTypeTests =
	(builder: Gen<PlantedBuilder>): Gen<PlantedRun> =>
	(source) => ({
		kind: "with type tests",
		seed: source.draw(int(0, 0xffff_ffff)),
		modules: [
			...source.draw(array(constant<Tier>("unit"), { min: 0, max: 2 })),
			"types",
			...source.draw(array(element(TIERS), { min: 0, max: 2 }))
		],
		builder: source.draw(builder)
	})

/** Each situation the search requires is an arm of its own, drawn as often as the others. */
const plantedRun: Gen<PlantedRun> = oneOf<PlantedRun>([
	withoutTypeTests,
	withTypeTests(printing(int(0, 64))),
	withTypeTests(printing(int(PIPE_BUFFER_BYTES + 1, 2 * PIPE_BUFFER_BYTES))),
	withTypeTests(failing)
])

type RunFeature =
	| "a run without type tests"
	| "a builder that prints its batch"
	| "an output past a pipe's buffer"
	| "a builder that fails"

/** A planted batch's units: one per drawn value, its one output line the value. */
const unitsOf = (values: ReadonlyArray<number>) =>
	Rec.fromEntries(
		Arr.map(values, (value, at) => [
			`u${at}`,
			{ output: [String(value)], errors: [], directives: [], problems: [] }
		])
	)

/** Where a planted builder says it ran when it ran in a process other than the run's. */
const APART = "a process of its own"

/** A planted builder as a Node program, which reads its request on stdin to the end before it acts. */
const builderProgram = (builder: PlantedBuilder): string => {
	const read = [
		"const chunks = []",
		"for await (const chunk of process.stdin) chunks.push(chunk)",
		'const request = Buffer.concat(chunks).toString("utf8")'
	]
	switch (builder.kind) {
		case "prints":
			return Arr.join(
				[
					...read,
					`const where = process.pid === ${process.pid} ? "the run's own process" : ${jsonText(APART)}`,
					`const padded = ${jsonText(builder.character)}.repeat(${builder.padding})`,
					`process.stdout.write(JSON.stringify({ units: ${jsonText(unitsOf(builder.units))}, unattributed: [request, where, padded] }))`,
					""
				],
				"\n"
			)
		case "fails":
			return Arr.join(
				[
					...read,
					'process.stdout.write("partial")',
					`process.stderr.write(${jsonText(builder.stderr)})`,
					`process.exitCode = ${builder.status}`,
					""
				],
				"\n"
			)
	}
}

/** The request a run sends its builder (BuildRequest), as a planted builder reads it back. */
type SentRequest = Readonly<{ seed: number; files: ReadonlyArray<string> }>

/** A planted test module's path, relative to the repository: its tier's directory, and its place in the run. */
const moduleOf = (tier: Tier, at: number): string => `test/${tier}/m${at}.test.ts`

/** What a run's batch file holds once its builder has run: what the builder printed, or its failure. */
const heldBy = (
	builder: PlantedBuilder,
	result: Effect.Success<ReturnType<typeof whenWritten>>,
	expected: SentRequest,
	c: Case<RunFeature>
): void => {
	switch (builder.kind) {
		case "prints": {
			c.note("a builder that prints its batch")
			const padded = Str.repeat(builder.padding)(builder.character)
			if (new TextEncoder().encode(padded).length > PIPE_BUFFER_BYTES) {
				c.note("an output past a pipe's buffer")
			}
			const [request, where, printed, ...rest] = result.unattributed
			assert.deepEqual(
				{
					units: result.units,
					request: Option.map(Option.fromUndefinedOr(request), (text) =>
						trustedJson<SentRequest>(text)
					),
					where,
					verbatim: printed === padded,
					rest
				},
				{
					units: unitsOf(builder.units),
					request: Option.some(expected),
					where: APART,
					verbatim: true,
					rest: []
				}
			)
			return
		}
		case "fails": {
			c.note("a builder that fails")
			const { stderr, status } = builder
			assert.deepEqual(
				{
					units: result.units,
					named: Arr.map(
						result.unattributed,
						(line) => Str.includes(stderr)(line) && Str.includes(`status ${status}`)(line)
					)
				},
				{ units: {}, named: [true] }
			)
		}
	}
}

/**
 * Starts a planted run as the type tier's global setup starts one, with a planted builder, and holds what it provides
 * to the model: no batch for a run without type tests; otherwise the file the builder's result reaches, which holds
 * what the builder printed, its request read in a process of its own, or, for a builder that fails, one line naming its
 * status and what it printed on stderr.
 */
const delivered = (planted: PlantedRun, c: Case<RunFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const repository = yield* fs.realPath(path.resolve(import.meta.dirname, "../../.."))
			const dir = yield* scopedTempDir(path.join(repository, plantedIn), ".builder-")
			const builder = path.join(dir, "builder.mjs")
			const provided: Array<TypeRun> = []
			const start = (modules: ReadonlyArray<Tier>) =>
				startBatch({
					root: repository,
					seed: planted.seed,
					moduleIds: Arr.map(modules, (tier, at) => path.join(repository, moduleOf(tier, at))),
					builder,
					provide: (run) => {
						provided.push(run)
					}
				})
			switch (planted.kind) {
				case "without type tests": {
					c.note("a run without type tests")
					yield* start(planted.modules)
					assert.deepEqual(provided, [{ seed: planted.seed, batch: { kind: "none" } }])
					return
				}
				case "with type tests": {
					yield* fs.writeFileString(builder, builderProgram(planted.builder))
					yield* start(planted.modules)
					assert.deepEqual(
						Arr.map(provided, (run) => ({ seed: run.seed, kind: run.batch.kind })),
						[{ seed: planted.seed, kind: "batch" }]
					)
					const file = defined(
						Arr.flatMap(provided, (run) => (run.batch.kind === "batch" ? [run.batch.file] : []))[0],
						"the file of the run's batch"
					)
					const result = yield* whenWritten(file)
					heldBy(
						planted.builder,
						result,
						{
							seed: planted.seed,
							files: Arr.flatMap(planted.modules, (tier, at) =>
								tier === "types" ? [moduleOf(tier, at)] : []
							)
						},
						c
					)
				}
			}
		})
	)

layer(NodeServices.layer, { excludeTestServices: true })("the type-test batch", (it) => {
	it.effect(
		"attributes every diagnostic to the unit whose file it names, through any spelling of the root, and fails on one no unit owns",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "type batch attribution",
						oracle: {
							kind: "second-implementation",
							name: "a model of each planted line's diagnostic in an armed check and in a disarmed copy"
						},
						draw: drawn(plantedBatch),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"an armed fixtures unit",
								"a disarmed fixtures unit",
								"an armed program",
								"a disarmed program",
								"an unused directive",
								"a disarmed unit with no directive",
								"an unowned file that raises",
								"an unowned file that raises nothing",
								"a symlinked root"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 4,
						shrink: boundedShrink(8),
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					attributed
				)
			)
	)

	it.effect(
		"fails a compiler that makes no CPU progress for its window with CompilerStalled and its goroutines, and never one that checks to its end",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "compiler stall guard",
						oracle: {
							kind: "specification",
							name: "tsgo's watch mode idles at 0% CPU after its first check; a check run once never does, and Go answers SIGQUIT with every goroutine's stack"
						},
						draw: drawn(plantedCheck),
						literal: Formatter.format,
						coverage: required<"stalled" | "checked clean" | "checked with an error">(
							["stalled", "checked clean", "checked with an error"],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 4,
						shrink: boundedShrink(4),
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					({ raises, watch, windowMillis, everyMillis }, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								c.note(watch ? "stalled" : raises ? "checked with an error" : "checked clean")
								const fs = yield* FileSystem.FileSystem
								const path = yield* Path.Path
								const repository = yield* fs.realPath(path.resolve(import.meta.dirname, "../../.."))
								const dir = yield* scopedTempDir(path.join(repository, plantedIn), ".stall-")
								yield* fs.writeFileString(
									path.join(dir, "index.ts"),
									`export const checked: number = ${raises ? '"s"' : "1"}\n`
								)
								yield* fs.writeFileString(
									path.join(dir, "tsconfig.json"),
									'{ "compilerOptions": { "noEmit": true, "strict": true, "types": [] }, "files": ["index.ts"] }\n'
								)
								const ran = yield* Effect.exit(
									guardedRun(
										process.execPath,
										[
											path.join(repository, "node_modules/typescript/bin/tsc"),
											...(watch ? ["--watch"] : []),
											"--pretty",
											"false",
											"-p",
											path.join(dir, "tsconfig.json")
										],
										repository,
										{ window: Duration.millis(windowMillis), every: Duration.millis(everyMillis) }
									)
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
									{
										stalled: watch ? Option.some({ idled: true, dumped: true }) : Option.none(),
										status: watch ? Option.none() : Option.some(raises ? 2 : 0)
									}
								)
							})
						)
				)
			)
	)

	it.effect(
		"builds a run's batch in a builder process of its own, delivers what it printed, and fails every check when it fails",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "type batch builder",
						oracle: {
							kind: "second-implementation",
							name: "a model of the run's request, and of the batch each planted builder prints or the failure it ends with"
						},
						draw: drawn(plantedRun),
						literal: Formatter.format,
						coverage: required<RunFeature>(
							[
								"a run without type tests",
								"a builder that prints its batch",
								"an output past a pipe's buffer",
								"a builder that fails"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 4,
						shrink: boundedShrink(8),
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					delivered
				)
			)
	)
})
