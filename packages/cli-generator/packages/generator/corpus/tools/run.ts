import { homedir } from "node:os"
import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Data,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Order,
	Path,
	Runtime,
	Schema,
	Stream
} from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { coverageOf } from "#corpus/tools/coverage.ts"
import type { Coverage, Invented, Missing } from "#corpus/tools/coverage.ts"
import { Corpus, fetchPinned, githubSource } from "#corpus/tools/fetch.ts"
import type { CorpusEntry, Pin } from "#corpus/tools/fetch.ts"
import { Generation, GenerationRequest, reportFile } from "#corpus/tools/generate.ts"
import { walk } from "#corpus/tools/walk.ts"
import { GenerateRefused } from "#generate.ts"
import { loadBytes } from "#load/index.ts"
import { DocumentUri } from "#model/brands.ts"
import { VerdictCoverage } from "#model/verdict.ts"
import { collectInformational } from "#normalize/informational.ts"
import generatorPackage from "#package.json" with { type: "json" }
import { makeVerdict, printVerdict } from "#report/verdict.ts"
import type { VerdictValue } from "#report/verdict.ts"
import { resolve } from "#resolve/index.ts"
import { Description } from "#runtime-src/runtime/describe.ts"
import { lineOf } from "#validate/dispatch.ts"
import { sha256Hex } from "#write/manifest.ts"

// The corpus run (design 8.2, CP-2): for each `ci` spec with an author config, generate from the
// pinned bytes, compare the YAML twin, build, run `--describe`, join coverage and print the
// verdict. `--check` compares the printed verdict with the committed one byte for byte, and fails
// on a committed verdict file that no `ci` entry names.
// Generation runs in its own process (`generate.ts`) that exits before the build, so the build
// never shares the memory ceiling with what generation held.

type Entry = typeof CorpusEntry.Type

const { version } = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
	generatorPackage
)

const decodeDocument = Schema.decodeUnknownEffect(DocumentUri)

const decodeCorpus = Schema.decodeUnknownEffect(Schema.fromJsonString(Corpus))

const decodeDescription = Schema.decodeUnknownEffect(Schema.fromJsonString(Description))

const decodeGeneration = Schema.decodeUnknownEffect(Schema.fromJsonString(Generation))

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(GenerationRequest))

const generateEntry = new URL("generate.ts", import.meta.url).pathname

/**
 * A step of the run that cannot produce a verdict: a build step that exited non-zero, a bin that
 * did not describe itself, a spec the generator could not read.
 */
export class CorpusRunFailed extends Data.TaggedError("CorpusRunFailed")<{
	readonly id: string
	readonly output: string
	readonly step: string
}> {}

/**
 * The generation process for one spec ended without writing its result: a defect of the generator
 * or of its input that the process has already logged. The run stops, as it does for any failure
 * of generation other than a refusal.
 */
export class CorpusGenerateFailed extends Data.TaggedError("CorpusGenerateFailed")<{
	readonly exitCode: number | null
	readonly id: string
}> {
	override get message(): string {
		return `${this.id}: generation exited ${String(this.exitCode)} without a result`
	}
}

/**
 * What the run found that a verdict records but the gate does not accept, other than a coverage
 * gap: a refused spec, an unequal twin, a verdict that differs from the committed file, bad
 * arguments. The process exits 1.
 */
export class CorpusFindings extends Data.TaggedError("CorpusFindings")<{
	readonly findings: readonly string[]
}> {
	readonly [Runtime.errorExitCode] = 1

	override get message(): string {
		return this.findings.join("\n")
	}
}

/**
 * The only thing the run found is coverage: the join reports an element nothing accounts for, or a
 * claim nothing in the spec stands behind. The process exits 3, so a caller can tell a coverage
 * proof that failed from a spec that did not build or was refused.
 */
export class CorpusCoverageGaps extends Data.TaggedError("CorpusCoverageGaps")<{
	readonly findings: readonly string[]
}> {
	readonly [Runtime.errorExitCode] = 3

	override get message(): string {
		return this.findings.join("\n")
	}
}

interface Context {
	readonly cacheDir: string
	// Where verdicts are written; `corpus/verdicts/` under `root` unless `--out` names a directory.
	readonly out: string | undefined
	readonly root: string
	readonly work: string
}

// What a run found, by cause: `coverage` is read from the `Coverage` value, never from verdict text.
export interface Findings {
	readonly coverage: readonly string[]
	readonly other: readonly string[]
}

const noFindings: Findings = { coverage: [], other: [] }

interface Run {
	readonly findings: Findings
	readonly summary: string
	readonly verdict: VerdictValue
}

// One step at a time, so heavy steps never overlap: each runs to its end before the next starts.
// `env` is the whole environment: proxy variables never reach the generated CLI (design C6).
const spawn = (
	id: string,
	step: string,
	command: readonly [string, ...string[]],
	options: { readonly cwd: string; readonly env?: Record<string, string> }
): Effect.Effect<string, CorpusRunFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* spawnStep() {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const [file, ...args] = command
		const failed = (output: string) => new CorpusRunFailed({ id, output, step })
		const [stdout, stderr, exitCode] = yield* Effect.scoped(
			Effect.flatMap(
				spawner.spawn(
					ChildProcess.make(file, args, {
						cwd: options.cwd,
						env: options.env ?? {},
						extendEnv: options.env === undefined
					})
				),
				(handle) =>
					Effect.all(
						[
							Stream.mkString(Stream.decodeText(handle.stdout)),
							Stream.mkString(Stream.decodeText(handle.stderr)),
							handle.exitCode
						],
						{ concurrency: "unbounded" }
					)
			)
		).pipe(
			Effect.timeoutOrElse({
				duration: Duration.minutes(10),
				orElse: () => Effect.fail(failed("timed out after 10 minutes"))
			}),
			Effect.mapError((cause) => (cause instanceof CorpusRunFailed ? cause : failed(String(cause))))
		)

		return exitCode === 0
			? stdout
			: yield* Effect.fail(failed(`exit ${String(exitCode)}\n${stdout}${stderr}`))
	})

const describeElement = (element: Missing): string => {
	if (element.kind === "refusedField") {
		return `refusedField ${element.pointer} ${element.mediaType} ${element.name}`
	}

	if (element.kind === "parameter") {
		return `parameter ${element.pointer} ${element.in} ${element.name}`
	}

	if (element.kind === "requestMedia") {
		return `requestMedia ${element.pointer} ${element.mediaType}`
	}

	if (element.kind === "response") {
		return `response ${element.pointer} ${element.key}`
	}

	if (element.kind === "securityAlternative") {
		return `securityAlternative ${element.pointer} ${JSON.stringify(element.schemes)}`
	}

	return element.kind === "server"
		? `server ${element.pointer} ${element.url}`
		: `operation ${element.pointer}`
}

const describeInvented = (invented: Invented): string => {
	const head = `invented ${invented.kind} ${invented.document} ${invented.pointer}`

	if (invented.kind === "refusedField") {
		return `${head} ${invented.mediaType} ${invented.name}`
	}

	if (invented.kind === "requestMedia") {
		return `${head} ${invented.mediaType}`
	}

	if (invented.kind === "response") {
		return `${head} ${invented.key}`
	}

	if (invented.kind === "securityAlternative") {
		return `${head} ${JSON.stringify(invented.schemes)}`
	}

	return invented.kind === "server" ? `${head} ${invented.url}` : head
}

type CoverageEntries = typeof VerdictCoverage.Encoded

// A walk element or field refusal as the verdict lists it: its use site, its kind and the kind's
// value.
const elementEntry = (element: Missing): CoverageEntries["missing"][number] => {
	const site = { document: element.document, pointer: element.pointer }

	if (element.kind === "refusedField") {
		return { ...site, kind: element.kind, mediaType: element.mediaType, name: element.name }
	}

	if (element.kind === "parameter") {
		return { ...site, in: element.in, kind: element.kind, name: element.name }
	}

	if (element.kind === "requestMedia") {
		return { ...site, kind: element.kind, mediaType: element.mediaType }
	}

	if (element.kind === "response") {
		return { ...site, key: element.key, kind: element.kind }
	}

	if (element.kind === "securityAlternative") {
		return { ...site, kind: element.kind, schemes: element.schemes }
	}

	return element.kind === "server"
		? { ...site, kind: element.kind, url: element.url }
		: { ...site, kind: element.kind }
}

// A claim as the verdict lists it: its kind, the command's path and the value.
const inventedEntry = (invented: Invented): CoverageEntries["invented"][number] => {
	const { path } = invented

	if (invented.kind === "refusedField") {
		return { kind: invented.kind, mediaType: invented.mediaType, name: invented.name, path }
	}

	if (invented.kind === "requestMedia") {
		return { kind: invented.kind, mediaType: invented.mediaType, path }
	}

	if (invented.kind === "response") {
		return { key: invented.key, kind: invented.kind, path }
	}

	if (invented.kind === "securityAlternative") {
		return { kind: invented.kind, path, schemes: invented.schemes }
	}

	return invented.kind === "server"
		? { kind: invented.kind, path, url: invented.url }
		: { kind: invented.kind, path }
}

const decodeCoverage = Schema.decodeEffect(VerdictCoverage)

// The verdict's coverage (design 8.2): each list typed, none of them text.
const coverageEntries = (coverage: Coverage) =>
	decodeCoverage({
		byNotice: coverage.byNotice.map(elementEntry),
		checked: true,
		invented: coverage.invented.map(inventedEntry),
		missing: coverage.missing.map(elementEntry)
	})

/**
 * The causes a coverage join reports, one line each naming the spec id and the element: what
 * nothing accounts for, and what nothing in the spec stands behind. Elements accounted only by a
 * notice are not causes.
 */
export const coverageFindings = (id: string, coverage: Coverage): readonly string[] => [
	...coverage.missing.map((element) => `${id}: missing ${describeElement(element)}`),
	...coverage.invented.map((invented) => `${id}: ${describeInvented(invented)}`)
]

interface Twin {
	readonly checked: boolean
	readonly differing: readonly string[]
}

const twinState = (twin: Twin): string => {
	if (!twin.checked) {
		return "unchecked"
	}

	return twin.differing.length === 0 ? "equal" : "unequal"
}

// Generates the package (and the twin) in a child process and reads back what the verdict needs.
// The child's output and logs are the run's own; a refusal fails here as `generate` would.
const generateApart = (id: string, request: typeof GenerationRequest.Type) =>
	Effect.gen(function* generateRun() {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const exitCode = yield* spawner
			.exitCode(
				ChildProcess.make(
					process.execPath,
					[...process.execArgv, generateEntry, yield* encodeRequest(request)],
					{ extendEnv: true, stdout: "inherit", stderr: "inherit" }
				)
			)
			.pipe(Effect.mapError(() => new CorpusGenerateFailed({ exitCode: null, id })))
		if (exitCode !== 0 || !(yield* fs.exists(request.result))) {
			return yield* new CorpusGenerateFailed({ exitCode, id })
		}

		const generation = yield* decodeGeneration(yield* fs.readFileString(request.result))

		return generation._tag === "Refused"
			? yield* new GenerateRefused({
					diagnostics: generation.diagnostics,
					reason: generation.reason
				})
			: generation
	})

// One spec through generation, twin, build, `--describe` and the coverage join. The spec is read
// in this process only after the build, so the build runs beside nothing generation held.
const runEntry = (entry: Entry, corpusVersion: number, context: Context) =>
	Effect.gen(function* runOne() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const configName = `corpus/config/${entry.id}.json`
		const configPath = path.join(context.root, configName)
		const fetch = (pin: Pin) =>
			fetchPinned(pin, context.cacheDir, githubSource).pipe(Effect.provide(FetchHttpClient.layer))
		const specPath = yield* fetch(entry)
		// The spec is named by its pinned source URL and the config by its repository path, never by
		// a host path (C8); the twin is named as the JSON is, so only the format differs.
		const document = yield* decodeDocument(entry.sourceUrl)
		const configDocument = yield* decodeDocument(`file:///${configName}`)

		yield* fs.makeDirectory(context.work, { recursive: true })

		const scratch = yield* fs.makeTempDirectoryScoped({
			directory: context.work,
			prefix: `corpus-${entry.id}-`
		})
		const jsonDir = path.join(scratch, "json")
		const request = {
			config: { document: configDocument, path: configPath },
			document,
			json: { outDir: jsonDir, specPath },
			result: path.join(scratch, "generation.json")
		}
		const twinPin = entry.twin
		const generated = yield* generateApart(
			entry.id,
			twinPin === undefined
				? request
				: {
						...request,
						twin: { outDir: path.join(scratch, "yaml"), specPath: yield* fetch(twinPin) }
					}
		)
		const { twin } = generated

		yield* spawn(
			entry.id,
			"install",
			["pnpm", "install", "--prefer-offline", "--ignore-scripts", "--ignore-workspace"],
			{ cwd: jsonDir }
		)
		yield* spawn(entry.id, "build", ["pnpm", "run", "build"], { cwd: jsonDir })

		const manifest = yield* fs.readFileString(path.join(jsonDir, "package.json"))
		const { bin } = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) }))
		)(manifest)
		const binPaths = Object.values(bin)
		const [binPath] = binPaths
		if (binPath === undefined || binPaths.length !== 1) {
			return yield* new CorpusRunFailed({ id: entry.id, output: manifest, step: "bin" })
		}

		const configBytes = yield* fs.readFile(configPath)
		const loaded = yield* loadBytes(yield* fs.readFile(specPath), { document })
		const resolution = yield* resolve({
			document,
			line: yield* lineOf(loaded.value),
			value: loaded.value
		})
		const openapi = yield* Schema.decodeUnknownEffect(Schema.Struct({ openapi: Schema.String }))(
			loaded.value
		)
		const informational = (yield* collectInformational(resolution)).length
		const elements = yield* walk(resolution)
		const total = elements.filter((element) => element.kind === "operation").length

		const describe = yield* spawn(
			entry.id,
			"describe",
			[process.execPath, path.join(jsonDir, ...binPath.split("/")), "--describe"],
			{ cwd: jsonDir, env: {} }
		)
		const report = yield* fs.readFileString(path.join(jsonDir, reportFile))
		const coverage = yield* coverageOf({ describe, report, resolution })
		const { commands } = yield* decodeDescription(describe)
		const inventedCommands = new Set(
			coverage.invented.flatMap((invented) =>
				invented.kind === "command" ? [`${invented.document}\u0000${invented.pointer}`] : []
			)
		)
		const bound = Arr.dedupe(
			commands.map((command) => `${command.document}\u0000${command.pointer}`)
		)
		const operations = {
			generated: bound.filter((site) => !inventedCommands.has(site)).length,
			total
		}

		const { commandNames, nonStandard } = generated
		const configSha256 = yield* sha256Hex(configBytes)
		const verdict = makeVerdict({
			commandNames,
			corpusVersion,
			coverage: yield* coverageEntries(coverage),
			diagnostics: generated.diagnostics,
			generator: { config: configName, configSha256, version },
			informational,
			nonStandard,
			operations,
			spec: { id: entry.id, openapi: openapi.openapi, sha256: entry.sha256 },
			twinEquality: { checked: twin.checked, equal: twin.checked && twin.differing.length === 0 }
		})

		const findings: Findings = {
			coverage: coverageFindings(entry.id, coverage),
			other: [
				...(verdict.verdict === "refused" ? [`${entry.id}: verdict is refused`] : []),
				...twin.differing.map((file) => `${entry.id}: YAML twin differs at ${file}`)
			]
		}
		const summary = [
			`${entry.id}: ${String(commands.length)} commands, ${String(operations.generated)}/${String(total)} operations generated`,
			`refusals ${String(verdict.refusals.length)}, notices ${String(verdict.notices.length)}`,
			`coverage missing ${String(coverage.missing.length)} invented ${String(coverage.invented.length)} byNotice ${String(coverage.byNotice.length)}`,
			`twin ${twinState(twin)}`
		].join("; ")
		const byNotice = coverage.byNotice.map(
			(element) => `${entry.id}: by notice ${describeElement(element)}`
		)

		const result: Run = { findings, summary: [summary, ...byNotice].join("\n"), verdict }

		return result
	})

// The first line where two different texts differ, each side shown as JSON.
const firstDifference = (committed: string, regenerated: string) => {
	const left = committed.split("\n")
	const right = regenerated.split("\n")
	const index = left.findIndex((text, at) => text !== right[at])
	const at = index === -1 ? left.length : index

	return {
		committed: JSON.stringify(left[at] ?? "(end of file)"),
		number: at + 1,
		regenerated: JSON.stringify(right[at] ?? "(end of file)")
	}
}

// The verdict file an entry owns under `corpus/verdicts/`: its id and the first 12 hex digits of its
// pinned sha256.
const verdictName = (entry: Entry): string => `${entry.id}@${entry.sha256.slice(0, 12)}.json`

// A refused document writes no package, so there is no verdict to build: the run names the codes.
const refusedFinding = (id: string, refused: GenerateRefused): Findings => ({
	coverage: [],
	other: [
		`${id}: refused (${refused.reason}): ${refused.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`
	]
})

// Runs one `ci` entry and writes its verdict, or with `check` compares it with the committed file.
// An entry without an author config is listed as skipped, and is a finding under `check`: every
// `ci` entry has a config and a verdict (design 8.2). Returns the run's findings.
const verdictFor = (entry: Entry, corpusVersion: number, context: Context, check: boolean) =>
	Effect.gen(function* verdictOne() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const { root } = context
		const configName = `corpus/config/${entry.id}.json`
		if (!(yield* fs.exists(path.join(root, ...configName.split("/"))))) {
			if (check) {
				return { coverage: [], other: [`${entry.id}: no author config at ${configName}`] }
			}

			yield* Effect.log(`${entry.id}: skipped, no ${configName}`)

			return noFindings
		}

		const attempt = yield* Effect.scoped(runEntry(entry, corpusVersion, context)).pipe(
			Effect.map((run): Run | Findings => run),
			Effect.catchTag("GenerateRefused", (refused) =>
				refused.reason === "document"
					? Effect.succeed(refusedFinding(entry.id, refused))
					: Effect.fail(refused)
			),
			// A failed step is a finding, so the other selected specs still run and are reported.
			Effect.catchTag("CorpusRunFailed", (failure) =>
				Effect.logError(`${failure.id}: ${failure.step} failed\n${failure.output}`).pipe(
					Effect.as({ coverage: [], other: [`${failure.id}: ${failure.step} failed`] })
				)
			)
		)
		if (!("verdict" in attempt)) {
			return attempt
		}

		const result = attempt
		yield* Effect.log(result.summary)

		const printed = yield* printVerdict(result.verdict)
		const name = verdictName(entry)
		const relative = `corpus/verdicts/${name}`
		const target =
			!check && context.out !== undefined
				? path.join(context.out, name)
				: path.join(root, ...relative.split("/"))

		if (!check) {
			yield* fs.makeDirectory(path.dirname(target), { recursive: true })
			yield* fs.writeFileString(target, printed)
			yield* Effect.log(
				`${entry.id}: wrote ${context.out === undefined ? relative : path.join(context.out, name)}`
			)

			return result.findings
		}

		const other = (text: string): Findings => ({
			coverage: result.findings.coverage,
			other: [...result.findings.other, text]
		})

		if (!(yield* fs.exists(target))) {
			return other(`${entry.id}: no committed verdict at ${relative}`)
		}

		const committed = yield* fs.readFileString(target)
		if (committed !== printed) {
			const line = firstDifference(committed, printed)

			return other(
				`${entry.id}: ${relative} differs from the regenerated verdict at line ${String(line.number)}: committed ${line.committed}, regenerated ${line.regenerated}`
			)
		}

		return result.findings
	})

// The committed verdicts that no `ci` entry names (design 8.2 Drift check): a file left behind by a
// pin change or a removed entry. Every `ci` entry names its file, whether `--only` selected it or not.
const staleVerdicts = (ci: readonly Entry[], root: string) =>
	Effect.gen(function* stale() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = path.join(root, "corpus", "verdicts")
		if (!(yield* fs.exists(directory))) {
			return []
		}

		const named = new Set(ci.map(verdictName))
		const files = yield* fs.readDirectory(directory)

		const unnamed = files.filter((file) => file.endsWith(".json") && !named.has(file))

		return Arr.sort(unnamed, Order.String).map(
			(file) => `corpus/verdicts/${file}: stale verdict, no ci entry has this name`
		)
	})

interface Options {
	readonly check: boolean
	readonly listCi: boolean
	readonly only: readonly string[]
	readonly out: string | undefined
	readonly root: string | undefined
}

/**
 * Turns the findings of every selected spec into the run's outcome: success, `CorpusFindings`
 * (exit 1) when anything but coverage failed, or `CorpusCoverageGaps` (exit 3) when coverage is the
 * only failure.
 */
export const settle = (found: readonly Findings[]) =>
	Effect.gen(function* settled() {
		const other = found.flatMap((findings) => findings.other)
		const coverage = found.flatMap((findings) => findings.coverage)

		if (other.length > 0) {
			yield* new CorpusFindings({ findings: [...other, ...coverage] })
		}

		if (coverage.length > 0) {
			yield* new CorpusCoverageGaps({ findings: coverage })
		}
	})

const run = (options: Options) =>
	Effect.gen(function* corpusRun() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		// `--root` moves the corpus manifest, author configs, verdicts and scratch; the generator and
		// its pinned cache stay where they are.
		const root =
			options.root === undefined
				? path.resolve(import.meta.dirname, "../..")
				: path.resolve(options.root)
		const context: Context = {
			cacheDir:
				process.env.CORPUS_CACHE ?? path.join(homedir(), ".cache/effect-openapi-cli-generator"),
			out: options.out === undefined ? undefined : path.resolve(options.out),
			root,
			work: path.join(root, "work")
		}
		const corpus = yield* decodeCorpus(
			yield* fs.readFileString(path.join(root, "corpus/corpus.json"))
		)
		const ci = corpus.specs.filter((spec) => spec.tier === "ci")

		if (options.listCi) {
			yield* Effect.forEach(
				ci,
				(entry) =>
					Effect.sync(() => {
						console.log(entry.id)
					}),
				{ discard: true }
			)

			return
		}

		const unknownIds = options.only.filter((id) => !ci.some((entry) => entry.id === id))
		if (unknownIds.length > 0) {
			yield* new CorpusFindings({
				findings: unknownIds.map((id) => `--only ${id}: no ci entry with that id`)
			})
		}

		const selected = options.only.length === 0 ? ci : ci.filter((e) => options.only.includes(e.id))
		const found = yield* Effect.all(
			selected.map((entry) => verdictFor(entry, corpus.version, context, options.check))
		)

		const stale = options.check ? yield* staleVerdicts(ci, root) : []

		yield* settle([...found, { coverage: [], other: stale }])
	})

// `--only` repeats; `--only`, `--out` and `--root` each take a value. Anything else is refused.
const parseArguments = (
	args: readonly string[]
): { readonly options: Options } | { readonly problems: readonly string[] } => {
	const only: string[] = []
	const problems: string[] = []
	let check = false
	let listCi = false
	let out: string | undefined
	let root: string | undefined

	for (let at = 0; at < args.length; at += 1) {
		const arg = args[at] ?? ""
		const value = args[at + 1]
		if (arg === "--check") {
			check = true
		} else if (arg === "--list-ci") {
			listCi = true
		} else if (arg === "--only" || arg === "--out" || arg === "--root") {
			if (value === undefined || value.startsWith("--")) {
				problems.push(`${arg} needs a value`)
			} else {
				at += 1
				if (arg === "--only") {
					only.push(value)
				} else if (arg === "--out") {
					out = value
				} else {
					root = value
				}
			}
		} else {
			problems.push(`unknown argument: ${arg}`)
		}
	}

	if (check && out !== undefined) {
		problems.push("--out cannot be used with --check: --check compares committed verdicts")
	}

	return problems.length > 0 ? { problems } : { options: { check, listCi, only, out, root } }
}

if (import.meta.main) {
	const parsed = parseArguments(process.argv.slice(2))
	const program =
		"problems" in parsed
			? Effect.fail(new CorpusFindings({ findings: parsed.problems }))
			: run(parsed.options)

	NodeRuntime.runMain(
		program.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerDigest)))
	)
}
