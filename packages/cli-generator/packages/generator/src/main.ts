import { jsonTextOf } from "@superstarter/json"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Match,
	Option,
	Path,
	Runtime,
	Schema,
	Stdio,
	Stream
} from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { checkSpecText } from "#check/index.ts"
import { generate, otherDocumentPathItems, setMembers, versionRefused } from "#generate.ts"
import type { GenerateError, GenerateInput, GenerateResult, SpecSource } from "#generate.ts"
import { defaultLoadLimits, readFileBounded, readStreamBounded } from "#load/budget.ts"
import { makeDocumentSet, parseDocumentPair } from "#load/document-set.ts"
import type { DocumentSet } from "#load/document-set.ts"
import { loadBytes } from "#load/index.ts"
import type { LoadRefusal } from "#load/index.ts"
import { DocumentUri } from "#model/brands.ts"
import { isDocumentRefusal, sortDiagnostics } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import { distinctDiagnostics } from "#normalize/operations.ts"
import generatorManifest from "#package.json" with { type: "json" }
import { humanLine, sanitizeField } from "#report/human.ts"
import { generatorExitStatus, printGenerationReport } from "#report/index.ts"
import { classifyVerdict } from "#report/verdict.ts"
import { resolve } from "#resolve/index.ts"
import { lineOf } from "#validate/dispatch.ts"
import { diagnoseDocument } from "#validate/index.ts"

type Document = typeof DocumentUri.Type

/**
 * A run that has already printed everything it has to say on stderr and exits 1 (design 8.1).
 */
class GeneratorExit extends Schema.TaggedError<GeneratorExit, { readonly brand: unique symbol }>()(
	"GeneratorExit",
	{}
) {
	override readonly [Runtime.errorExitCode] = 1

	override readonly [Runtime.errorReported] = false
}

/** The retrieval URI of a specification read from stdin; a file's is its `file:` URL (design 3.3). */
const stdinDocument = "stdin:"

const FailureReason = Schema.Struct({ reason: Schema.String })

const FailureSubject = Schema.Struct({ subject: Schema.String })

const decodeDocument = Schema.decodeUnknownEffect(DocumentUri)

const write = (sink: "stderr" | "stdout", text: string): Effect.Effect<void, never, Stdio.Stdio> =>
	Effect.gen(function* writeGen() {
		const stdio = yield* Stdio.Stdio

		yield* Stream.run(Stream.make(text), sink === "stderr" ? stdio.stderr() : stdio.stdout())
	}).pipe(Effect.ignore)

const printLines = (lines: readonly string[]): Effect.Effect<void, never, Stdio.Stdio> =>
	lines.length === 0
		? Effect.void
		: write(
				"stderr",
				Arr.join(
					Arr.map(lines, (line) => `${line}\n`),
					""
				)
			)

const printDiagnostics = (
	diagnostics: readonly Diagnostic[]
): Effect.Effect<void, never, Stdio.Stdio> => printLines(Arr.map(diagnostics, humanLine))

const exit = (lines: readonly string[]): Effect.Effect<never, GeneratorExit, Stdio.Stdio> =>
	printLines(lines).pipe(Effect.andThen(Effect.fail(GeneratorExit.make())))

interface Spec {
	readonly document: Document
	readonly source: SpecSource
}

/**
 * `-` is stdin; anything else is a path whose retrieval URI is the `file:` URL of its real path,
 * so the entry and a `--ref-root` copy of the same file are one document (design 3.3). A path
 * that has no real path keeps its absolute path; the loader then refuses it as unreadable.
 */
const specOf = (argument: string) =>
	Effect.gen(function* spec() {
		const stdio = yield* Stdio.Stdio
		const path = yield* Path.Path
		const fs = yield* FileSystem.FileSystem

		if (argument === "-") {
			const stdin: Spec = {
				document: yield* decodeDocument(stdinDocument),
				source: { _tag: "Stream", stream: stdio.stdin }
			}

			return stdin
		}

		const absolute = path.resolve(argument)
		const real = yield* fs.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute))
		const url = yield* path.toFileUrl(real)
		const file: Spec = {
			document: yield* decodeDocument(url.href),
			source: { _tag: "File", path: argument }
		}

		return file
	})

const configOf = (configPath: string) =>
	Effect.gen(function* config() {
		const path = yield* Path.Path
		const url = yield* path.toFileUrl(path.resolve(configPath))

		return { document: yield* decodeDocument(url.href), path: configPath }
	})

/**
 * One line for a failure that is not a diagnostic (design 8.1).
 */
export const failureLine = (error: Exclude<GenerateError, { _tag: "GenerateRefused" }>): string =>
	Match.value(error).pipe(
		Match.tag("RunLockHeld", () => "error: another run holds the output directory's lock"),
		Match.tag("WriteRefused", (refused) => `error: the output was not written (${refused.reason})`),
		Match.orElse((failure) => {
			const reason = Option.match(Schema.decodeUnknownOption(FailureReason)(failure), {
				onNone: () => "",
				onSome: (found) => ` reason ${sanitizeField(found.reason)}`
			})
			const subject = Option.match(Schema.decodeUnknownOption(FailureSubject)(failure), {
				onNone: () => "",
				onSome: (found) => ` subject ${sanitizeField(jsonTextOf(found.subject))}`
			})

			return `error: generation failed (${failure._tag})${reason}${subject}`
		})
	)

/**
 * Every failure prints and exits 1: a refusal as its diagnostic lines, anything else as one line.
 * A `GeneratorExit` has printed already.
 */
const reportFailure = (
	error: GenerateError | GeneratorExit
): Effect.Effect<never, GeneratorExit, Stdio.Stdio> =>
	Match.value(error).pipe(
		Match.tag("GeneratorExit", (done) => Effect.fail(done)),
		Match.tag("GenerateRefused", (refused) => exit(Arr.map(refused.diagnostics, humanLine))),
		Match.orElse((failure) => exit([failureLine(failure)]))
	)

/** A document refusal is a verdict (`refused`); any other failure leaves none. */
const verdictDiagnostics = (
	error: GenerateError | GeneratorExit
): Effect.Effect<readonly Diagnostic[], GeneratorExit, Stdio.Stdio> =>
	Match.value(error).pipe(
		Match.when({ _tag: "GenerateRefused", reason: "document" }, (refused) =>
			Effect.succeed(refused.diagnostics)
		),
		Match.orElse(reportFailure)
	)

const setupFailed = (what: string) => () => exit([`error: ${what}`])

const specArgument = Argument.String("spec").pipe(
	Argument.withDescription("The OpenAPI document's path, or - for stdin.")
)

const configFlag = Flag.String("config").pipe(Flag.withDescription("The author config's path."))

const documentFlag = Flag.String("document").pipe(
	Flag.withMetavar("uri=path"),
	Flag.atLeast(0),
	Flag.withDescription(
		"Add a document to the set $ref may resolve over: its absolute retrieval URI, then =, then its path. Repeatable. The value splits at the first =, so the URI cannot contain one."
	)
)

const refRootFlag = Flag.String("ref-root").pipe(
	Flag.withMetavar("dir"),
	Flag.optional,
	Flag.withDescription(
		"Add every .json, .yaml and .yml file under this directory to the document set, each under the file: URL of its real path. Links out of the directory are refused."
	)
)

const loadRefused = (refusal: LoadRefusal) => exit([humanLine(refusal.diagnostic)])

/**
 * The document set the flags name (design 3.3). The entry holds one slot of the budget, and a
 * member spelling its retrieval URI differently is refused at load.
 */
const documentSetOf = (
	entry: Document,
	documents: readonly string[],
	refRoot: Option.Option<string>
) =>
	makeDocumentSet(
		Arr.map(documents, parseDocumentPair),
		Option.match(refRoot, {
			onNone: () => ({ entry }),
			onSome: (dir) => ({ entry, refRoot: dir })
		})
	)

const runGenerate = (
	input: GenerateInput,
	config: { readonly document: Document; readonly path: string }
) => generate(input, config)

/**
 * `generate <spec|->`: writes the package (design 3, 8.1). stderr gets one line per diagnostic;
 * `--report json` prints the generation report on stdout.
 */
const generateCommand = Command.make(
	"generate",
	{
		config: configFlag,
		document: documentFlag,
		out: Flag.String("out").pipe(Flag.withDescription("The output directory.")),
		refRoot: refRootFlag,
		report: Flag.Literals("report", ["json"]).pipe(
			Flag.optional,
			Flag.withDescription("Print the generation report on stdout.")
		),
		spec: specArgument,
		strict: Flag.Boolean("strict").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Treat any refusal as fatal.")
		)
	},
	(flags) =>
		Effect.gen(function* generateRun() {
			const spec = yield* specOf(flags.spec).pipe(
				Effect.catch(setupFailed("the specification path has no file URL"))
			)
			const config = yield* configOf(flags.config).pipe(
				Effect.catch(setupFailed("the author config path has no file URL"))
			)
			const documents = yield* documentSetOf(spec.document, flags.document, flags.refRoot).pipe(
				Effect.catch(loadRefused)
			)
			const result: GenerateResult = yield* runGenerate(
				{ ...spec, documents, outDir: flags.out, strict: flags.strict },
				config
			).pipe(Effect.catch(reportFailure))

			yield* printDiagnostics(result.diagnostics)
			if (Option.isSome(flags.report)) {
				const report = yield* printGenerationReport(result.report).pipe(
					Effect.catch(setupFailed("the generation report cannot be printed"))
				)
				yield* write("stdout", report)
			}

			const status = generatorExitStatus({
				_tag: "Written",
				diagnostics: result.diagnostics,
				strict: flags.strict
			})

			if (status !== 0) {
				return yield* GeneratorExit.make()
			}
		})
).pipe(Command.withDescription("Generate a CLI package from an OpenAPI document."))

/** The load, validate, resolve and check stages (design 3) over the document set; nothing is written. */
const check = (spec: Spec, documents: DocumentSet) =>
	Effect.gen(function* checkGen() {
		const { document } = spec
		const members = yield* setMembers(spec, documents).pipe(Effect.catch(loadRefused))
		const order = (diagnostics: readonly Diagnostic[]) =>
			sortDiagnostics(
				[document, ...Arr.map(members, (member) => member.document)],
				distinctDiagnostics(diagnostics)
			)
		const bytes = yield* (
			spec.source._tag === "File"
				? readFileBounded(spec.source.path, defaultLoadLimits, document)
				: readStreamBounded(spec.source.stream, defaultLoadLimits, document)
		).pipe(Effect.catch(loadRefused))
		const loaded = yield* loadBytes(bytes, { document }).pipe(Effect.catch(loadRefused))
		const { diagnosis, line } = yield* Effect.all({
			diagnosis: diagnoseDocument(loaded.value, document),
			line: lineOf(loaded.value)
		}).pipe(Effect.catchTag("UnsupportedOpenApiVersion", versionRefused(document)))
		const validated = [
			...diagnosis.notices,
			...Arr.map(diagnosis.refusals, (entry) => entry.diagnostic)
		]
		if (diagnosis.refusals.length > 0) {
			return order(validated)
		}

		const resolved = yield* Effect.result(resolve({ document, line, members, value: loaded.value }))
		if (resolved._tag === "Failure") {
			return order([...validated, resolved.failure.diagnostic])
		}

		const checked = yield* checkSpecText(resolved.success)
		const outside = yield* otherDocumentPathItems(resolved.success)

		return order([...validated, ...resolved.success.diagnostics, ...checked, ...outside])
	})

/**
 * `validate <spec|->`: load, validate, resolve and check over the document set, and write nothing.
 * stderr gets one line per diagnostic; a document refusal exits 1.
 */
const validateCommand = Command.make(
	"validate",
	{ document: documentFlag, refRoot: refRootFlag, spec: specArgument },
	(flags) =>
		Effect.gen(function* validateRun() {
			const spec = yield* specOf(flags.spec).pipe(
				Effect.catch(setupFailed("the specification path has no file URL"))
			)
			const documents = yield* documentSetOf(spec.document, flags.document, flags.refRoot).pipe(
				Effect.catch(loadRefused)
			)
			const diagnostics = yield* check(spec, documents).pipe(Effect.catch(reportFailure))

			yield* printDiagnostics(diagnostics)

			if (Arr.some(diagnostics, isDocumentRefusal)) {
				return yield* GeneratorExit.make()
			}
		})
).pipe(Command.withDescription("Check an OpenAPI document without writing anything."))

/**
 * `verdict <spec|-> --config <path>`: generates into a temporary directory that is removed
 * afterwards and prints the verdict class (design 8.2): `accepted`, `partly-refused` or `refused`.
 * stderr gets one line per diagnostic. It exits 1 only when no verdict could be reached.
 */
const verdictCommand = Command.make(
	"verdict",
	{ config: configFlag, spec: specArgument },
	(flags) =>
		Effect.gen(function* verdictRun() {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const spec = yield* specOf(flags.spec).pipe(
				Effect.catch(setupFailed("the specification path has no file URL"))
			)
			const config = yield* configOf(flags.config).pipe(
				Effect.catch(setupFailed("the author config path has no file URL"))
			)
			const dir = yield* fs
				.makeTempDirectoryScoped({ prefix: "openapi-verdict-" })
				.pipe(Effect.catch(setupFailed("no temporary directory could be made")))
			const diagnostics = yield* runGenerate(
				{ ...spec, outDir: path.join(dir, "out"), strict: false },
				config
			).pipe(
				Effect.map((result) => result.diagnostics),
				Effect.catch(verdictDiagnostics)
			)

			yield* printDiagnostics(diagnostics)
			yield* write("stdout", `${classifyVerdict(diagnostics)}\n`)
		}).pipe(Effect.scoped)
).pipe(Command.withDescription("Print the verdict class of an OpenAPI document."))

/**
 * Root command of the generator CLI.
 */
const root = Command.make("effect-openapi-cli-generator").pipe(
	Command.withSubcommands([generateCommand, validateCommand, verdictCommand])
)

const isShowHelp = (error: unknown): error is CliError.ShowHelp =>
	CliError.isCliError(error) && error._tag === "ShowHelp"

/**
 * Runs the root command with the arguments supplied by the `Stdio` service, at the version the
 * generator's `package.json` names. Help and parse errors are presented by `effect/cli`; a parse
 * error then exits 1 without being reported again.
 */
export const main = Command.run(root, { version: generatorManifest.version }).pipe(
	Effect.catchIf(isShowHelp, (help) =>
		help.errors.length === 0 ? Effect.void : Effect.fail(GeneratorExit.make())
	),
	Effect.catchIf(CliError.isCliError, () => Effect.fail(GeneratorExit.make()))
)
