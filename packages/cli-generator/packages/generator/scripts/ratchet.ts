import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Formatter,
	Number as Num,
	Option,
	Order,
	Path,
	Record,
	Schema,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * The finding ratchet: while the generator is being cleaned, each tool of the gate runs over it in full and fails
 * when its finding count rises above the count `ratchet.json` holds. The ledger only falls: `--lower` writes the
 * current counts when no tool rose. A tool at zero leaves the ledger and runs as the plain tool; when every tool is
 * at zero this script and its ledger are deleted. A tool that fails to run, or whose own summary disagrees with the
 * findings read from its output, fails the check: a count the ratchet could not read is never a pass.
 */

/** The tools the ratchet holds, each by the gate task that runs it. */
const TOOLS = ["typecheck", "superlint", "oxlint", "dead-code", "architecture"] as const

type Tool = (typeof TOOLS)[number]

const Tool = Schema.Literals(TOOLS)

/** One tool's findings: how many in all, and how many in each file, by its path relative to the repository root. */
const Count = Schema.Struct({
	total: Schema.Int,
	files: Schema.Record(Schema.String, Schema.Int)
})

type Count = typeof Count.Type

/** The ledger: each held tool's committed count, by the tool's name. A tool absent from it is at zero. */
const Ledger = Schema.Record(Schema.String, Count)

type Ledger = typeof Ledger.Type

const decodeLedger = Schema.decodeUnknownEffect(Schema.fromJsonString(Ledger))

/** The repository root, relative to this script's package. */
const ROOT = `${import.meta.dirname}/../../..`

const LEDGER = `${import.meta.dirname}/../ratchet.json`

/** The generator package, relative to the repository root, as the tools' outputs name its files. */
const PACKAGE = "packages/generator"

/** A failure of the ratchet itself: the tool did not run, or its output could not be read. */
class RatchetFailure extends Schema.TaggedError<
	RatchetFailure,
	{ readonly brand: unique symbol }
>()("RatchetFailure", {
	detail: Schema.String
}) {}

/** One run of a tool: where it runs, the command, the exit code it answers when it finds something, and how its
 * output's findings and summary read. */
type Run = Readonly<{
	directory: string
	command: string
	arguments: ReadonlyArray<string>
	foundExit: number
	findings: (stdout: string, stderr: string) => Effect.Effect<ReadonlyArray<string>, RatchetFailure>
}>

/** The lines of a tool's output that report a finding, each mapped to the file it names. */
const linesNaming = (
	output: string,
	fileOf: (line: string) => Option.Option<string>
): ReadonlyArray<string> =>
	Arr.getSomes(Arr.map(Arr.fromIterable(Str.linesIterator(output)), fileOf))

/** The part of a line before a marker, when the line holds the marker. */
const before = (line: string, marker: string): Option.Option<string> =>
	Option.map(Str.indexOf(marker)(line), (index) => Str.slice(0, index)(line))

const fromPackage = (file: string): string => `${PACKAGE}/${file}`

/** A count the tool states about itself, checked against the findings read from its lines. */
const agreeing = (
	tool: Tool,
	stated: number,
	files: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<string>, RatchetFailure> =>
	stated === files.length
		? Effect.succeed(files)
		: RatchetFailure.make({
				detail: `${tool} states ${String(stated)} findings, and ${String(files.length)} were read from its output`
			})

/** The last line of an output that ends with a suffix, its leading number read. */
const statedCount = (output: string, prefix: string, suffix: string): Option.Option<number> =>
	Arr.findLast(
		Arr.fromIterable(Str.linesIterator(output)),
		(line) => Str.startsWith(prefix)(line) && Str.endsWith(suffix)(line)
	).pipe(
		Option.map((line) => Str.slice(prefix.length, line.length - suffix.length)(line)),
		Option.flatMap(Num.parse)
	)

/** fallow's report, as the ratchet reads it: the total, and each issue's file. */
const FallowIssue = Schema.Struct({
	path: Schema.optionalKey(Schema.String),
	from_path: Schema.optionalKey(Schema.String),
	locations: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String })))
})

const FallowReport = Schema.fromJsonString(Schema.Struct({ total_issues: Schema.Int }))

const decodeFallowTotal = Schema.decodeUnknownEffect(FallowReport)

const decodeFallowSections = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
)

const decodeFallowIssues = Schema.decodeUnknownEffect(Schema.Array(FallowIssue))

const fileOfIssue = (issue: typeof FallowIssue.Type): string =>
	issue.path ?? issue.from_path ?? issue.locations?.[0]?.path ?? "."

/** The workspace diagnostics and next steps fallow prints beside its issues, which are no findings. */
const FALLOW_ADVICE: ReadonlyArray<string> = ["workspace_diagnostics", "next_steps"]

const fallowFindings =
	(tool: Tool) =>
	(output: string): Effect.Effect<ReadonlyArray<string>, RatchetFailure> =>
		Effect.gen(function* () {
			const unreadable = () =>
				RatchetFailure.make({ detail: `${tool}'s JSON report is unreadable` })
			const { total_issues } = yield* decodeFallowTotal(output).pipe(Effect.mapError(unreadable))
			const sections = yield* decodeFallowSections(output).pipe(Effect.mapError(unreadable))
			const issues = yield* Effect.forEach(
				Arr.filter(
					Record.toEntries(sections),
					([name, value]) => Arr.isArray(value) && !Arr.contains(FALLOW_ADVICE, name)
				),
				([, value]) => decodeFallowIssues(value).pipe(Effect.mapError(unreadable))
			)
			return yield* agreeing(tool, total_issues, Arr.map(Arr.flatten(issues), fileOfIssue))
		})

const RUNS: Readonly<Record<Tool, Run>> = {
	typecheck: {
		directory: `${ROOT}/${PACKAGE}`,
		command: "effect-tsgo",
		arguments: ["tsrs"],
		foundExit: 2,
		findings: (stdout, stderr) =>
			Effect.succeed(
				linesNaming(`${stdout}\n${stderr}`, (line) =>
					Option.map(before(line, "): error TS"), (head) =>
						fromPackage(Option.getOrElse(before(head, "("), () => head))
					)
				)
			)
	},
	superlint: {
		directory: `${ROOT}/${PACKAGE}`,
		command: "superlint",
		arguments: [],
		foundExit: 1,
		findings: (output) =>
			Option.match(statedCount(output, "superlint: ", " finding(s)"), {
				onNone: () => RatchetFailure.make({ detail: "superlint printed no count of its findings" }),
				onSome: (stated) =>
					agreeing(
						"superlint",
						stated,
						linesNaming(output, (line) =>
							Str.startsWith(`${PACKAGE}/`)(line) ? before(line, ":") : Option.none()
						)
					)
			})
	},
	oxlint: {
		directory: `${ROOT}/${PACKAGE}`,
		command: "oxlint",
		arguments: ["--format=unix"],
		foundExit: 1,
		findings: (output) => {
			const files = linesNaming(output, (line) =>
				Str.endsWith("]")(line) && Str.includes(" [Error")(line)
					? Option.map(before(line, ":"), fromPackage)
					: Option.none()
			)
			return Option.match(statedCount(output, "", " problems"), {
				onNone: () => agreeing("oxlint", 0, files),
				onSome: (stated) => agreeing("oxlint", stated, files)
			})
		}
	},
	"dead-code": {
		directory: ROOT,
		command: "fallow",
		arguments: ["dead-code", "--format", "json"],
		foundExit: 1,
		findings: fallowFindings("dead-code")
	},
	architecture: {
		directory: ROOT,
		command: "fallow",
		arguments: ["architecture", "--format", "json"],
		foundExit: 1,
		findings: fallowFindings("architecture")
	}
}

/**
 * Runs a tool and answers its output and exit code. The tool writes into files through the shell, never into pipes:
 * effect-tsgo execs the native tsrs on the descriptors Node set non-blocking, and tsrs drops what a full pipe refuses,
 * so a pipe would read a count short of the findings.
 */
const runTool = Effect.fn("ratchet.runTool")(function* (tool: Tool) {
	const fs = yield* FileSystem.FileSystem
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const run = RUNS[tool]
	const stdoutFile = yield* fs.makeTempFileScoped()
	const stderrFile = yield* fs.makeTempFileScoped()
	const command = ChildProcess.make(
		"sh",
		[
			"-c",
			'err="$1"; shift; exec "$@" > "$0" 2> "$err"',
			stdoutFile,
			stderrFile,
			run.command,
			...run.arguments
		],
		{ cwd: run.directory, extendEnv: true }
	)
	const unreadable = () => RatchetFailure.make({ detail: `${tool} (${run.command}) could not run` })
	const exitCode = yield* spawner.exitCode(command).pipe(Effect.mapError(unreadable))
	const stdout = yield* fs.readFileString(stdoutFile).pipe(Effect.mapError(unreadable))
	const stderr = yield* fs.readFileString(stderrFile).pipe(Effect.mapError(unreadable))
	if (exitCode !== 0 && exitCode !== run.foundExit) {
		return yield* RatchetFailure.make({
			detail: `${tool} exited with ${String(exitCode)}:\n${stdout}${stderr}`
		})
	}
	const files = yield* run.findings(stdout, stderr)
	if ((exitCode === 0) !== Arr.isReadonlyArrayEmpty(files)) {
		return yield* RatchetFailure.make({
			detail: `${tool} exited with ${String(exitCode)} beside ${String(files.length)} findings read from its output`
		})
	}
	return { output: `${stdout}${stderr}`, count: countOf(files) }
}, Effect.scoped)

/** The count of a list of finding files. */
const countOf = (files: ReadonlyArray<string>): Count => ({
	total: files.length,
	files: Record.map(
		Arr.groupBy(Arr.sort(files, Order.String), (file) => file),
		(group) => group.length
	)
})

const readLedger = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const text = yield* fs
		.readFileString(LEDGER)
		.pipe(Effect.mapError(() => RatchetFailure.make({ detail: `${LEDGER} is unreadable` })))
	return yield* decodeLedger(text).pipe(
		Effect.mapError(() => RatchetFailure.make({ detail: `${LEDGER} is not a ratchet ledger` }))
	)
})

const writeLedger = (ledger: Ledger) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs
			.writeFileString(LEDGER, `${Formatter.formatJson(ledger, { space: "\t" })}\n`)
			.pipe(
				Effect.mapError(() => RatchetFailure.make({ detail: `${LEDGER} could not be written` }))
			)
	})

/** The files whose count rose above the ledger's, each with its committed and current count. */
const risen = (
	committed: Count,
	current: Count
): ReadonlyArray<Readonly<{ file: string; held: number; count: number }>> =>
	Arr.filter(
		Arr.map(Record.toEntries(current.files), ([file, count]) => ({
			file,
			held: Option.getOrElse(Record.get(committed.files, file), () => 0),
			count
		})),
		(entry) => entry.count > entry.held
	)

/** The lines of a tool's output that name one of the files, by its path inside the package or the repository. */
const linesOfFiles = (output: string, files: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.filter(Arr.fromIterable(Str.linesIterator(output)), (line) =>
		Arr.some(files, (file) =>
			Str.includes(
				Str.startsWith(`${PACKAGE}/`)(file) ? Str.slice(PACKAGE.length + 1)(file) : file
			)(line)
		)
	)

const main = Effect.gen(function* () {
	const path = yield* Path.Path
	const argv = yield* Effect.sync(() => process.argv)
	const tool = yield* Schema.decodeUnknownEffect(Tool)(argv[2]).pipe(
		Effect.mapError(() =>
			RatchetFailure.make({ detail: `usage: ratchet.ts <${Arr.join(TOOLS, "|")}> [--lower]` })
		)
	)
	const lower = Arr.contains(argv, "--lower")
	const ledger = yield* readLedger
	const committed = Option.getOrElse(Record.get(ledger, tool), () => countOf([]))
	const { output, count } = yield* runTool(tool)
	const shown = path.relative(ROOT, LEDGER)
	if (count.total > committed.total) {
		const rose = risen(committed, count)
		yield* Console.error(
			Arr.join(
				[
					...linesOfFiles(
						output,
						Arr.map(rose, (entry) => entry.file)
					),
					`ratchet: ${tool} has ${String(count.total)} findings in the generator, above the ${String(committed.total)} ${shown} holds. The files that rose:`,
					...Arr.map(
						rose,
						(entry) => `  ${entry.file}: ${String(entry.held)} -> ${String(entry.count)}`
					)
				],
				"\n"
			)
		)
		return 1
	}
	if (lower) {
		yield* writeLedger(
			count.total === 0 ? Record.remove(ledger, tool) : Record.set(ledger, tool, count)
		)
	}
	yield* Console.log(
		count.total === committed.total
			? `ratchet: ${tool} holds at ${String(count.total)} findings in the generator.`
			: `ratchet: ${tool} fell from ${String(committed.total)} to ${String(count.total)} findings in the generator${lower ? `; ${shown} now holds ${String(count.total)}.` : `: lower ${shown} with --lower.`}`
	)
	return 0
})

NodeRuntime.runMain(
	main.pipe(
		Effect.catchTag("RatchetFailure", (failure) =>
			Effect.as(Console.error(`ratchet: ${failure.detail}`), 2)
		),
		Effect.flatMap((status) =>
			Effect.sync(() => {
				process.exitCode = status
			})
		),
		Effect.provide(NodeServices.layer)
	)
)
