/**
 * The type-test batch (test/types/batch/batch.ts) and its builder, against models of what they must deliver:
 *
 * - Attribution: a planted batch's units, fixtures and programs, armed and disarmed, each line clean or raising one of
 *   two diagnostics, alone or under a directive of each claim (directives.ts Claim), built through any spelling of the
 *   root. Every diagnostic reaches the unit whose file it names, each directive's line is promised, and the unit's
 *   problems are exactly the model's: a disarmed unit with no directive, a line raising another code than its
 *   directive claims, a twin's label on one line alone, and the lines of one label raising different diagnostics; and
 *   a diagnostic in a file no unit owns fails the batch, naming that file. Oracle: a second implementation, the model
 *   of each planted line's diagnostics armed and disarmed, compared as sets.
 * - The stall guard: a compiler that makes no CPU progress for its window fails with CompilerStalled and its
 *   goroutines, and one that checks to its end never does. Oracle: tsgo's watch mode, which idles after its first check.
 * - The builder: a run without type tests starts no batch; with them, its builder runs in a process of its own on the
 *   run's request, each unit's file it wrote is delivered, one it withheld is refused, and a builder that fails fails
 *   every check, naming its status and stderr. Oracle: a model of the request and of what each planted builder writes.
 *
 * Plants (~/.cache/grizzle-release/BR14/plants): batch-twin-blind.patch compares no twin's diagnostics, so a twin
 * label whose lines differ passes; batch-code-blind.patch accepts any code under a code claim; batch-unowned.patch
 * attributes a diagnostic in a file no unit owns to some unit instead of failing the batch; batch-stall-blind.patch never
 * judges a compiler stalled; batch-withheld-read.patch reads a unit's missing file as a unit with no diagnostic;
 * batch-builder-silent.patch writes an empty batch for a builder that failed, naming no failure.
 */
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
	Result,
	String as Str
} from "effect"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { scopedTempDir } from "#test/support/temp.ts"
import {
	batchLayout,
	buildBatchAt,
	type Problem,
	readUnit,
	type UnitSpec,
	whenWritten
} from "#test/types/batch/batch.ts"
import { guardedRun } from "#test/types/batch/compiler.ts"
import { type Diagnostic, type Place, placeKey } from "#test/types/batch/directives.ts"
import { startBatch } from "#test/types/batch/global-setup.ts"
import { type BatchAt, type TypeRun, typeRun } from "#test/types/batch/provided.ts"

/** The test file that reads these batches, which the runner's batch never holds. */
const owner = "test/types/batch/batch.test.ts"

/** The directory every planted file goes under, beside this file, relative to the repository. */
const plantedIn = "test/types/batch"

/**
 * What a planted line's declaration raises: nothing, TS2322 (a string where a number is declared) or TS2741 (an object
 * missing the property its declared type requires).
 */
const RAISES = ["nothing", "TS2322", "TS2741"] as const

type Raises = (typeof RAISES)[number]

/** A twin's labels: two, so a unit may hold two twins, each on one line or on several. */
const LABELS = ["a", "b"] as const

/**
 * The directive over a planted line: none; a code claim, always of TS2322; refused; or a twin of a label.
 */
type Over =
	| Readonly<{ kind: "none" | "code" | "refused" }>
	| Readonly<{ kind: "twin"; label: (typeof LABELS)[number] }>

type PlantedLine = Readonly<{ raises: Raises; over: Over }>

/** The kinds of unit the batch places: a directory's fixtures, their disarmed copy, and a program armed or disarmed. */
const UNIT_KINDS = ["fixtures", "disarmed", "program", "disarmed program"] as const

type UnitKind = (typeof UNIT_KINDS)[number]

type PlantedUnit = Readonly<{
	kind: UnitKind
	modules: Arr.NonEmptyReadonlyArray<ReadonlyArray<PlantedLine>>
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

/**
 * A line's directive in a unit of twins, whose directed lines are all twins, so its labels meet one another; and in
 * any other unit.
 */
const twinOver: Gen<Over> = oneOf<Over>([
	constant<Over>({ kind: "none" }),
	(source) => ({ kind: "twin", label: source.draw(element(LABELS)) })
])

const singleOver: Gen<Over> = oneOf<Over>([
	constant<Over>({ kind: "none" }),
	constant<Over>({ kind: "code" }),
	constant<Over>({ kind: "refused" })
])

const lineGen =
	(over: Gen<Over>): Gen<PlantedLine> =>
	(source) => ({
		raises: source.draw(element(RAISES)),
		over: source.draw(over)
	})

const plantedUnit: Gen<PlantedUnit> = (source) => {
	const kind = source.draw(element(UNIT_KINDS))
	const lines = array(lineGen(source.draw(boolean) ? twinOver : singleOver), { min: 1, max: 3 })
	return {
		kind,
		modules: Arr.prepend(source.draw(array(lines, { min: 0, max: 1 })), source.draw(lines))
	}
}

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
	| "a code its directive does not claim"
	| "a refused line"
	| "twins that agree"
	| "twins that differ"
	| "a twin alone"
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

/** A planted line as written: the line its directive sits on, the line of its declaration, and the line planted. */
type Written = Readonly<{ planted: PlantedLine; directive: number; statement: number }>

/** A declaration that raises what `raises` names. */
const declaration = (raises: Raises, index: number): string => {
	switch (raises) {
		case "nothing":
			return `export const v${index}: number = 1`
		case "TS2322":
			return `export const v${index}: number = "s"`
		case "TS2741":
			return `export const v${index}: { readonly a: number } = {}`
	}
}

/** The directive line over a planted line, if it has one. */
const directiveOf = (over: Over): ReadonlyArray<string> => {
	switch (over.kind) {
		case "none":
			return []
		case "code":
			return ["// @ts-expect-error -- TS2322: the declared type refuses the value"]
		case "refused":
			return ["// @ts-expect-error -- refused: the declared type refuses the value"]
		case "twin":
			return [`// @ts-expect-error -- twin ${over.label}: one probe at two places`]
	}
}

/** A planted module's text, after `header` lines, and where each of its lines landed. */
const writtenOf = (
	lines: ReadonlyArray<PlantedLine>,
	header: ReadonlyArray<string>
): Readonly<{ text: string; lines: ReadonlyArray<Written> }> => {
	const text: Array<string> = [...header]
	const written: Array<Written> = []
	Arr.forEach(lines, (planted, index) => {
		const directive = directiveOf(planted.over)
		text.push(...directive, declaration(planted.raises, index))
		written.push({
			planted,
			directive: text.length - directive.length,
			statement: text.length
		})
	})
	return { text: `${Arr.join(text, "\n")}\n`, lines: written }
}

/** A module's lines, by its file name. */
type ModuleLines = Readonly<{ file: string; lines: ReadonlyArray<Written> }>

/**
 * What the model expects of a unit's modules: the diagnostics a check of them reports, the lines a disarmed copy's
 * directives promise, and its problems.
 */
const expectedOf = (
	modules: ReadonlyArray<ModuleLines>,
	disarmed: boolean
): Readonly<{
	errors: ReadonlyArray<Diagnostic>
	directives: ReadonlyArray<Place>
	problems: ReadonlyArray<Problem>
}> => {
	const lines = Arr.flatMap(modules, ({ file, lines: written }) =>
		Arr.map(written, (w) => ({ file, ...w }))
	)
	const errors = Arr.flatMap(
		lines,
		({ file, planted, directive, statement }): ReadonlyArray<Diagnostic> => {
			const raised: ReadonlyArray<Diagnostic> =
				planted.raises === "nothing" ? [] : [{ file, line: statement, code: planted.raises }]
			if (disarmed || planted.over.kind === "none") {
				return raised
			}
			return planted.raises === "nothing" ? [{ file, line: directive, code: "TS2578" }] : []
		}
	)
	if (!disarmed) {
		return { errors, directives: [], problems: [] }
	}
	const directed = Arr.filter(lines, ({ planted }) => planted.over.kind !== "none")
	const raisedAt = (raises: Raises): ReadonlyArray<string> => (raises === "nothing" ? [] : [raises])
	const coded = Arr.flatMap(directed, ({ file, planted, statement }): ReadonlyArray<Problem> =>
		planted.over.kind === "code" && planted.raises === "TS2741"
			? [{ kind: "code", at: { file, line: statement }, claimed: "TS2322", raised: ["TS2741"] }]
			: []
	)
	const twins = Arr.flatMap(LABELS, (label): ReadonlyArray<Problem> => {
		const of = Arr.filter(
			directed,
			({ planted }) => planted.over.kind === "twin" && planted.over.label === label
		)
		const [first, ...rest] = of
		if (first === undefined) {
			return []
		}
		if (!Arr.isReadonlyArrayNonEmpty(rest)) {
			return [{ kind: "twin alone", label, at: { file: first.file, line: first.statement } }]
		}
		return Arr.every(rest, ({ planted }) => planted.raises === first.planted.raises)
			? []
			: [
					{
						kind: "twins differ",
						label,
						lines: Arr.map(of, ({ file, planted, statement }) => ({
							at: { file, line: statement },
							raised: raisedAt(planted.raises)
						}))
					}
				]
	})
	return {
		errors,
		directives: Arr.map(directed, ({ file, statement }) => ({ file, line: statement })),
		problems: [
			...(Arr.isReadonlyArrayNonEmpty(directed) ? [] : [{ kind: "vacuous" as const }]),
			...coded,
			...twins
		]
	}
}

/** Diagnostics as a set compares them: sorted by file, line and code, and distinct. */
const diagnosticSet = (diagnostics: ReadonlyArray<Diagnostic>): ReadonlyArray<Diagnostic> =>
	Arr.dedupeWith(
		Arr.sort(
			diagnostics,
			Order.Struct({ file: Order.String, line: Order.Number, code: Order.String })
		),
		(a, b) => a.file === b.file && a.line === b.line && a.code === b.code
	)

/** The place a problem names first, and its kind: the order the problems of a unit are compared in, as a set. */
const problemOrder: Order.Order<Problem> = Order.mapInput(
	Order.Struct({ kind: Order.String, label: Order.String, file: Order.String, line: Order.Number }),
	(problem: Problem) => {
		const at = (place: Place) => ({ file: place.file, line: place.line })
		switch (problem.kind) {
			case "code":
			case "refusal missing":
			case "refusal unnamed":
				return { kind: problem.kind, label: "", ...at(problem.at) }
			case "twin alone":
				return { kind: problem.kind, label: problem.label, ...at(problem.at) }
			case "twins differ":
				return { kind: problem.kind, label: problem.label, file: "", line: 0 }
			case "unplaced":
			case "vacuous":
			case "lacking":
				return { kind: problem.kind, label: "", file: "", line: 0 }
		}
	}
)

/** The features a unit's expected problems and lines reach. */
const notesOf = (unit: PlantedUnit, problems: ReadonlyArray<Problem>): ReadonlyArray<Feature> => {
	const lines = Arr.flatten(unit.modules)
	const agreeing = Arr.some(LABELS, (label) => {
		const of = Arr.filter(lines, ({ over }) => over.kind === "twin" && over.label === label)
		const [first, ...rest] = of
		return (
			first !== undefined &&
			Arr.isReadonlyArrayNonEmpty(rest) &&
			Arr.every(rest, ({ raises }) => raises === first.raises)
		)
	})
	return [
		unitFeature(unit.kind),
		...(Arr.some(lines, ({ raises, over }) => raises === "nothing" && over.kind !== "none") &&
		!isDisarmed(unit)
			? ["an unused directive" as const]
			: []),
		...(isDisarmed(unit) && Arr.some(lines, ({ over }) => over.kind === "refused")
			? ["a refused line" as const]
			: []),
		...Arr.map(problems, (problem): Feature => {
			switch (problem.kind) {
				case "vacuous":
					return "a disarmed unit with no directive"
				case "code":
					return "a code its directive does not claim"
				case "twin alone":
					return "a twin alone"
				case "twins differ":
					return "twins that differ"
				case "unplaced":
				case "refusal missing":
				case "refusal unnamed":
				case "lacking":
					return unitFeature(unit.kind)
			}
		}),
		...(isDisarmed(unit) && agreeing ? ["twins that agree" as const] : [])
	]
}

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

/** The prefix a planted program's directory starts with. */
const PROGRAM_PREFIX = ".attributed-"

/**
 * Plants a batch under the repository at `repository`, its real path, builds it through the root as the case spells
 * it, and holds the result to the model: every unit's errors, promised lines and problems, as sets, and no line left
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
							module: writtenOf(lines, index === 0 ? header(entry) : [])
						}))
					const disarmed = isDisarmed(unit)
					const expected = expectedOf(
						Arr.map(
							modulesOf(() => ""),
							({ file, module }) => ({ file, lines: module.lines })
						),
						disarmed
					)
					for (const feature of notesOf(unit, expected.problems)) {
						c.note(feature)
					}
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
					return { id: `batch/u${at}`, spec, expected }
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
			const asSets = (result: {
				readonly errors: ReadonlyArray<Diagnostic>
				readonly directives: ReadonlyArray<Place>
				readonly problems: ReadonlyArray<Problem>
			}) => ({
				errors: diagnosticSet(result.errors),
				directives: Arr.map(result.directives, placeKey),
				problems: Arr.sort(result.problems, problemOrder)
			})
			assert.deepEqual(
				Option.map(Exit.getSuccess(built), (batch) => ({
					unattributed: batch.unattributed,
					units: Arr.map(units, (unit) =>
						Option.map(Option.fromUndefinedOr(batch.units[unit.id]), asSets)
					)
				})),
				Option.some({
					unattributed: [],
					units: Arr.map(units, (unit) => Option.some(asSets(unit.expected)))
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
 * What a planted builder does once it has read its request to the end: writes a batch of `units` into the request's
 * directory, one output line each, whose unattributed lines are the request it read and whether it ran in a process of
 * its own; writes such a batch but withholds the file of the unit at `withheld`, which its index still names; or prints
 * a partial line on stdout and `stderr`, then exits with `status`.
 */
type PlantedBuilder =
	| Readonly<{ kind: "writes"; units: ReadonlyArray<number> }>
	| Readonly<{ kind: "withholds"; units: ReadonlyArray<number>; withheld: number }>
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

const writing: Gen<PlantedBuilder> = (source) => ({
	kind: "writes",
	units: source.draw(array(int(0, 9), { min: 0, max: 3 }))
})

const withholding: Gen<PlantedBuilder> = (source) => {
	const units = source.draw(array(int(0, 9), { min: 1, max: 3 }))
	return { kind: "withholds", units, withheld: source.draw(int(0, units.length - 1)) }
}

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
	withTypeTests(writing),
	withTypeTests(withholding),
	withTypeTests(failing)
])

type RunFeature =
	| "a run without type tests"
	| "a builder that writes its batch"
	| "a unit's file withheld, refused"
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
		'import fs from "node:fs"',
		'import path from "node:path"',
		"const chunks = []",
		"for await (const chunk of process.stdin) chunks.push(chunk)",
		'const request = Buffer.concat(chunks).toString("utf8")'
	]
	switch (builder.kind) {
		case "writes":
		case "withholds":
			return Arr.join(
				[
					...read,
					"const { dir } = JSON.parse(request)",
					`const where = process.pid === ${process.pid} ? "the run's own process" : ${jsonText(APART)}`,
					`const units = ${jsonText(unitsOf(builder.units))}`,
					`const withheld = ${jsonText(builder.kind === "withholds" ? [`u${builder.withheld}`] : [])}`,
					`fs.mkdirSync(path.join(dir, ${jsonText(batchLayout.units)}), { recursive: true })`,
					"for (const [unit, result] of Object.entries(units)) {",
					"\tif (!withheld.includes(unit)) {",
					`\t\tfs.writeFileSync(path.join(dir, ${jsonText(batchLayout.units)}, unit + ".json"), JSON.stringify(result))`,
					"\t}",
					"}",
					`fs.writeFileSync(path.join(dir, ${jsonText(batchLayout.index)}), JSON.stringify({ units: Object.keys(units), unattributed: [request, where] }))`,
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
type SentRequest = Readonly<{ seed: number; files: ReadonlyArray<string>; dir: string }>

/** A planted test module's path, relative to the repository: its tier's directory, and its place in the run. */
const moduleOf = (tier: Tier, at: number): string => `test/${tier}/m${at}.test.ts`

/**
 * What a run's batch holds once its builder has run, read as a test process reads it: the units the builder wrote, each
 * from its own file, and what it put beside them; a unit whose file it withheld refused as BatchUnreadable; or its
 * failure.
 */
const heldBy = (
	builder: PlantedBuilder,
	batch: BatchAt,
	expected: SentRequest,
	c: Case<RunFeature>
) =>
	Effect.gen(function* () {
		const index = yield* whenWritten(batch)
		switch (builder.kind) {
			case "writes": {
				c.note("a builder that writes its batch")
				const units = yield* Effect.forEach(index.units, (unit) =>
					Effect.map(readUnit(batch, unit), (result) => [unit, result] as const)
				)
				const [request, where, ...rest] = index.unattributed
				assert.deepEqual(
					{
						units: Rec.fromEntries(units),
						request: Option.map(Option.fromUndefinedOr(request), (text) =>
							trustedJson<SentRequest>(text)
						),
						where,
						rest
					},
					{
						units: unitsOf(builder.units),
						request: Option.some(expected),
						where: APART,
						rest: []
					}
				)
				return
			}
			case "withholds": {
				c.note("a unit's file withheld, refused")
				const read = yield* Effect.forEach(index.units, (unit) =>
					Effect.map(
						Effect.result(readUnit(batch, unit)),
						(result) => [unit, Result.isFailure(result) ? result.failure._tag : "read"] as const
					)
				)
				assert.deepEqual(
					read,
					Arr.map(Rec.keys(unitsOf(builder.units)), (unit) =>
						unit === `u${builder.withheld}` ? [unit, "BatchUnreadable"] : [unit, "read"]
					)
				)
				return
			}
			case "fails": {
				c.note("a builder that fails")
				const { stderr, status } = builder
				assert.deepEqual(
					{
						units: index.units,
						named: Arr.map(
							index.unattributed,
							(line) => Str.includes(stderr)(line) && Str.includes(`status ${status}`)(line)
						)
					},
					{ units: [], named: [true] }
				)
			}
		}
	})

/**
 * Starts a planted run as the type tier's global setup starts one, with a planted builder, and holds what it provides
 * to the model: no batch for a run without type tests; otherwise the directory the builder's result reaches, which
 * holds what the builder wrote, its request read in a process of its own, each unit read from its own file and a
 * withheld one refused, or, for a builder that fails, one line naming its status and what it printed on stderr.
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
					const batch = defined(
						Arr.flatMap(provided, (run) => (run.batch.kind === "batch" ? [run.batch] : []))[0],
						"the run's batch"
					)
					yield* heldBy(
						planted.builder,
						batch,
						{
							seed: planted.seed,
							files: Arr.flatMap(planted.modules, (tier, at) =>
								tier === "types" ? [moduleOf(tier, at)] : []
							),
							dir: batch.dir
						},
						c
					)
				}
			}
		})
	)

layer(NodeServices.layer, { excludeTestServices: true })("the type-test batch", (it) => {
	it.effect(
		"attributes every diagnostic to the unit whose file it names, through any spelling of the root, holds each directive's line to its claim, and fails on a diagnostic no unit owns",
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
								"a code its directive does not claim",
								"a refused line",
								"twins that agree",
								"twins that differ",
								"a twin alone",
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
		"builds a run's batch in a builder process of its own, delivers each unit's file it wrote, refuses one it withheld, and fails every check when it fails",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "type batch builder",
						oracle: {
							kind: "second-implementation",
							name: "a model of the run's request, and of the batch each planted builder writes or the failure it ends with"
						},
						draw: drawn(plantedRun),
						literal: Formatter.format,
						coverage: required<RunFeature>(
							[
								"a run without type tests",
								"a builder that writes its batch",
								"a unit's file withheld, refused",
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
