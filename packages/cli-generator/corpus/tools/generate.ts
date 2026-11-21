import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Data, Effect, FileSystem, Option, Path, Result } from "effect"
import { generate, refusalReasons } from "#generate.ts"
import type { GenerateRefused } from "#generate.ts"
import { isDocumentUri } from "#model/brands.ts"
import type { DocumentUri } from "#model/brands.ts"
import { isDiagnostic } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import { sha256Hex } from "#model/digest.ts"
import { isJsonPointer } from "#model/pointer.ts"
import type { JsonPointer } from "#model/pointer.ts"
import { commandNameSources } from "#names/plan.ts"
import type { CommandNameSource } from "#names/plan.ts"
import { parseJson } from "#runtime/json.ts"
import type { InvalidJsonText } from "#runtime/json.ts"
import {
	anything,
	array,
	boolean,
	literal,
	member,
	members,
	optionalMember,
	refine,
	string,
	struct,
	union
} from "#runtime/read.ts"
import type { Reader, ReadIssues } from "#runtime/read.ts"

/** The report file name inside a generated package, which the twin comparison leaves out. */
export const reportFile = "generation-report.json"

/** Where one format's package is generated from and written to. */
type Target = {
	readonly outDir: string
	readonly specPath: string
}

/**
 * What `run.ts` asks for: the pinned spec (and twin, where one is pinned) on disk, the author
 * config, where each package is written, and the file the result goes to.
 */
export type GenerationRequest = {
	readonly config: { readonly document: DocumentUri; readonly path: string }
	readonly document: DocumentUri
	readonly json: Target
	readonly result: string
	readonly twin?: Target
}

/** A command of the report as the verdict counts it: by the source of its name. */
type NamedCommand = {
	readonly command: CommandNameSource
}

/** A non-standard element of the report as the verdict lists it. */
type NonStandardChoice = {
	readonly choice: string
	readonly pointer: JsonPointer
	readonly row: string
}

/** Whether the YAML twin was generated, and the files where its package differs from the JSON's. */
type TwinComparison = {
	readonly checked: boolean
	readonly differing: readonly string[]
}

/**
 * What generation leaves for the verdict: the diagnostics, what the verdict reads of the report's
 * command names and non-standard entries, and the twin comparison; or the refusal, when nothing was
 * written.
 */
export type Generation =
	| {
			readonly _tag: "Generated"
			readonly commandNames: readonly NamedCommand[]
			readonly diagnostics: readonly Diagnostic[]
			readonly nonStandard: readonly NonStandardChoice[]
			readonly twin: TwinComparison
	  }
	| {
			readonly _tag: "Refused"
			readonly diagnostics: readonly Diagnostic[]
			readonly reason: GenerateRefused["reason"]
	  }

/**
 * The text the corpus run and its generation process hand each other, the request or the result,
 * is no JSON text, or its value is none of its kind: `cause` says which, and where.
 */
export class GenerationTextUnreadable extends Data.TaggedError("GenerationTextUnreadable")<{
	readonly cause: InvalidJsonText | ReadIssues
	readonly text: "request" | "result"
}> {}

const documentUriReader = refine(string, isDocumentUri, "an absolute URI")

const targetReader: Reader<Target> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				outDir: member(object, "outDir", string),
				specPath: member(object, "specPath", string)
			},
			false
		)
	)

const configReader: Reader<GenerationRequest["config"]> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				document: member(object, "document", documentUriReader),
				path: member(object, "path", string)
			},
			false
		)
	)

const requestReader: Reader<GenerationRequest> = (value) =>
	Result.flatMap(members(value), (object) =>
		Result.map(
			struct(
				object,
				{
					config: member(object, "config", configReader),
					document: member(object, "document", documentUriReader),
					json: member(object, "json", targetReader),
					result: member(object, "result", string),
					twin: optionalMember(object, "twin", targetReader)
				},
				false
			),
			({ twin, ...request }): GenerationRequest =>
				Option.match(twin, {
					onNone: () => request,
					onSome: (target) => ({ ...request, twin: target })
				})
		)
	)

const diagnosticsReader = array(refine(anything, isDiagnostic, "a diagnostic"))

const namedCommandReader: Reader<NamedCommand> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{ command: member(object, "command", union(Arr.map(commandNameSources, literal))) },
			false
		)
	)

const nonStandardReader: Reader<NonStandardChoice> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				choice: member(object, "choice", string),
				pointer: member(object, "pointer", refine(string, isJsonPointer, "a JSON Pointer")),
				row: member(object, "row", string)
			},
			false
		)
	)

const twinReader: Reader<TwinComparison> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				checked: member(object, "checked", boolean),
				differing: member(object, "differing", array(string))
			},
			false
		)
	)

const generatedReader: Reader<Generation> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				_tag: member(object, "_tag", literal("Generated")),
				commandNames: member(object, "commandNames", array(namedCommandReader)),
				diagnostics: member(object, "diagnostics", diagnosticsReader),
				nonStandard: member(object, "nonStandard", array(nonStandardReader)),
				twin: member(object, "twin", twinReader)
			},
			false
		)
	)

const refusedReader: Reader<Generation> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				_tag: member(object, "_tag", literal("Refused")),
				diagnostics: member(object, "diagnostics", diagnosticsReader),
				reason: member(object, "reason", union(Arr.map(refusalReasons, literal)))
			},
			false
		)
	)

/**
 * Reads the text the corpus run or its generation process wrote, by `reader`: the request is the
 * process's one argument, which may be absent, and the result its file's text.
 */
const readText = <A>(
	text: unknown,
	reader: Reader<A>,
	which: GenerationTextUnreadable["text"]
): Result.Result<A, GenerationTextUnreadable> =>
	Result.mapError(
		Result.flatMap(Result.flatMap(string(text), parseJson), reader),
		(cause) => new GenerationTextUnreadable({ cause, text: which })
	)

/** The generation a process wrote for `run.ts`, read from its text. */
export const readGeneration = (text: string): Result.Result<Generation, GenerationTextUnreadable> =>
	readText(text, union([generatedReader, refusedReader]), "result")

/** Every emitted file but the report (which records each input's digest), compared by bytes. */
const twinDifferences = (json: string, yaml: string, files: readonly string[]) =>
	Effect.gen(function* compare() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const differing = yield* Effect.forEach(
			Arr.filter(files, (file) => file !== reportFile),
			(file) =>
				Effect.all([fs.readFile(path.join(json, file)), fs.readFile(path.join(yaml, file))]).pipe(
					Effect.flatMap(([a, b]) =>
						Effect.all([sha256Hex(a), sha256Hex(b)]).pipe(
							Effect.map(([left, right]) => (left === right ? [] : [file]))
						)
					)
				)
		)

		return Arr.flatten(differing)
	})

const generateBoth = (request: GenerationRequest) =>
	Effect.gen(function* generateRun() {
		const { config, document } = request
		const into = (target: Target) =>
			generate(
				{
					document,
					outDir: target.outDir,
					source: { _tag: "File", path: target.specPath },
					strict: false
				},
				config
			)
		const generated = yield* into(request.json)
		const twinOf = (twinTarget: Target) =>
			into(twinTarget).pipe(
				Effect.flatMap((yaml) =>
					twinDifferences(
						request.json.outDir,
						twinTarget.outDir,
						Arr.union(generated.files, yaml.files)
					)
				),
				Effect.map((differing) => ({ checked: true, differing }))
			)
		const twin =
			request.twin === undefined ? { checked: false, differing: [] } : yield* twinOf(request.twin)
		const result: Generation = {
			_tag: "Generated",
			commandNames: Arr.map(generated.report.commandNames, ({ command }) => ({ command })),
			diagnostics: generated.diagnostics,
			nonStandard: Arr.map(generated.report.nonStandard, ({ choice, pointer, row }) => ({
				choice,
				pointer,
				row
			})),
			twin
		}

		return result
	})

/**
 * The generation half of one corpus entry (design 8.2), run as its own process by `run.ts` so the
 * memory generation holds is returned to the system before the package build starts: the guarded
 * peak is then the larger of generation and build, not their sum. It generates the package, and
 * the YAML twin when one is pinned, and writes what the verdict needs from them as JSON.
 */
const main = (argument: unknown) =>
	Effect.gen(function* generateMain() {
		const fs = yield* FileSystem.FileSystem
		const request = yield* Effect.fromResult(readText(argument, requestReader, "request"))
		const generation = yield* generateBoth(request).pipe(
			Effect.catchTag("GenerateRefused", (refused) =>
				Effect.succeed<Generation>({
					_tag: "Refused",
					diagnostics: refused.diagnostics,
					reason: refused.reason
				})
			)
		)

		yield* fs.writeFileString(request.result, jsonText(generation))
	})

if (import.meta.main) {
	NodeRuntime.runMain(
		main(process.argv[2]).pipe(Effect.provide([NodeServices.layer, NodeCrypto.layerDigest]))
	)
}
