/**
 * A generated CLI writes each multipart part under the content type its Encoding Object names, the one the operator
 * chose when it names several, with the part's declared headers in its head, and refuses before any connection a part
 * flag that cannot be honoured.
 *
 * - Parts: an upload whose file part may be `image/png` or `image/jpeg` (chosen with `--file-content-type`), and a
 *   document whose `image/png` file part declares a required `X-Checksum` header and an optional `X-Trace` one; each
 *   with its required title, and the file part sent or not. Oracle: the parts as the reference reader in multipart.ts
 *   reads them: the title's bytes; the file part's name, file name, content type essence, declared headers and bytes;
 *   and no file part when none was sent.
 * - Faults, planted one per run: a choice part without its content type, a content type without its part, a content
 *   type the part does not list, a part without its required header, a header flag without its part, and a header
 *   value with a line break. Oracle: exit 2 and no connection.
 *
 * Under the owner's swarm gate this suite has not been run yet, nor checked against plants.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import { drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import { bytes, characterOf, element, type Gen, option, string } from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Order,
	Path,
	Record as Rec,
	String as Str
} from "effect"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	harnessLayer,
	runBin
} from "#test/support/cli-package.ts"
import { type HeaderList, valuesOf, type WireRequest } from "#test/support/http.ts"
import { boundaryOf, type Part, partsOf, partType } from "#test/support/multipart.ts"

/** The operations of the box. */
type Operation = "uploads" | "docs"

/** The pointers of the box's operations. */
const POINTERS: Readonly<Record<Operation, string>> = {
	uploads: "/paths/~1uploads/post",
	docs: "/paths/~1docs/post"
}

/** A file part's schema. */
const fileSchema = { contentMediaType: "application/octet-stream", type: "string" }

/** An upload whose file part may be PNG or JPEG, and a document whose PNG file part declares two headers. */
const spec = jsonTextOf({
	openapi: "3.1.0",
	info: { title: "Multipart parts", version: "1.0.0" },
	paths: {
		"/uploads": {
			post: {
				operationId: "uploads-create",
				requestBody: {
					required: true,
					content: {
						"multipart/form-data": {
							encoding: { file: { contentType: "image/png, image/jpeg" } },
							schema: {
								type: "object",
								properties: { file: fileSchema, title: { type: "string" } },
								required: ["title"]
							}
						}
					}
				},
				responses: { "204": { description: "Stored." } }
			}
		},
		"/docs": {
			post: {
				operationId: "docs-upload",
				requestBody: {
					required: true,
					content: {
						"multipart/form-data": {
							encoding: {
								file: {
									contentType: "image/png",
									headers: {
										"X-Checksum": { required: true, schema: { type: "string" } },
										"X-Trace": { schema: { type: "string" } }
									}
								}
							},
							schema: {
								type: "object",
								properties: { file: fileSchema, title: { type: "string" } },
								required: ["title"]
							}
						}
					}
				},
				responses: { "204": { description: "Stored." } }
			}
		}
	}
})

/** The author config, binding the capture server's origin. */
const configOf = (bound: string): string =>
	jsonTextOf({
		package: { name: "multipart-parts", version: "1.0.0" },
		binName: "parts",
		envPrefix: "PARTS",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** The content types the upload's file part lists. */
type ImageType = "image/png" | "image/jpeg"

/** A fault planted in a run. */
type Fault =
	| "a part without its content type"
	| "a content type without its part"
	| "a content type the part does not list"
	| "a part without its required header"
	| "a header flag without its part"
	| "a header value with a line break"

/** One run: an upload, a document, or a planted fault. */
type Run =
	| Readonly<{
			kind: "upload"
			title: string
			file: Option.Option<Readonly<{ bytes: Uint8Array; type: ImageType }>>
	  }>
	| Readonly<{
			kind: "document"
			title: string
			file: Option.Option<
				Readonly<{ bytes: Uint8Array; checksum: string; trace: Option.Option<string> }>
			>
	  }>
	| Readonly<{ kind: "fault"; fault: Fault }>

/** Text every part head and body carries as written. */
const text: Gen<string> = string(characterOf(["a", "Z", "0", "-", "_", "."]), { min: 1, max: 6 })

const runOf: Gen<Run> = (source) => {
	const kind = element<Run["kind"]>(["upload", "document", "fault"])(source)
	switch (kind) {
		case "upload":
			return {
				kind,
				title: text(source),
				file: option((inner): Readonly<{ bytes: Uint8Array; type: ImageType }> => ({
					bytes: bytes({ min: 0, max: 24 })(inner),
					type: element<ImageType>(["image/png", "image/jpeg"])(inner)
				}))(source)
			}
		case "document":
			return {
				kind,
				title: text(source),
				file: option((inner) => ({
					bytes: bytes({ min: 0, max: 24 })(inner),
					checksum: string(characterOf(["0", "9", "a", "f"]), { min: 4, max: 8 })(inner),
					trace: option(text)(inner)
				}))(source)
			}
		case "fault":
			return {
				kind,
				fault: element<Fault>([
					"a part without its content type",
					"a content type without its part",
					"a content type the part does not list",
					"a part without its required header",
					"a header flag without its part",
					"a header value with a line break"
				])(source)
			}
	}
}

/** The file every run that sends one writes, by its name. */
const FILE_NAME = "part.bin"

/** How a run is invoked: its operation, its arguments after the command, and the file's bytes. */
type Invocation = Readonly<{ operation: Operation; args: ReadonlyArray<string>; file: Uint8Array }>

/** How a fault is invoked. */
const faultInvocation = (fault: Fault, file: string): Invocation => {
	const none = new Uint8Array(0)
	switch (fault) {
		case "a part without its content type":
			return { operation: "uploads", args: ["--title", "t", "--file", file], file: none }
		case "a content type without its part":
			return {
				operation: "uploads",
				args: ["--title", "t", "--file-content-type", "image/png"],
				file: none
			}
		case "a content type the part does not list":
			return {
				operation: "uploads",
				args: ["--title", "t", "--file", file, "--file-content-type", "image/gif"],
				file: none
			}
		case "a part without its required header":
			return { operation: "docs", args: ["--title", "t", "--file", file], file: none }
		case "a header flag without its part":
			return {
				operation: "docs",
				args: ["--title", "t", "--file-x-checksum", "9f86d0"],
				file: none
			}
		case "a header value with a line break":
			return {
				operation: "docs",
				args: ["--title", "t", "--file", file, "--file-x-checksum", "a\r\nX-Evil: 1"],
				file: none
			}
	}
}

/** How a run is invoked, given where its file lies. */
const invocationOf = (r: Run, file: string): Invocation => {
	switch (r.kind) {
		case "upload":
			return {
				operation: "uploads",
				args: Arr.appendAll(
					["--title", r.title],
					Option.match(r.file, {
						onNone: () => [],
						onSome: (sent) => ["--file", file, "--file-content-type", sent.type]
					})
				),
				file: Option.match(r.file, {
					onNone: () => new Uint8Array(0),
					onSome: (sent) => sent.bytes
				})
			}
		case "document":
			return {
				operation: "docs",
				args: Arr.appendAll(
					["--title", r.title],
					Option.match(r.file, {
						onNone: () => [],
						onSome: (sent) =>
							Arr.flatten([
								["--file", file, "--file-x-checksum", sent.checksum],
								Option.match(sent.trace, {
									onNone: () => [],
									onSome: (trace) => ["--file-x-trace", trace]
								})
							])
					})
				),
				file: Option.match(r.file, {
					onNone: () => new Uint8Array(0),
					onSome: (sent) => sent.bytes
				})
			}
		case "fault":
			return faultInvocation(r.fault, file)
	}
}

/**
 * A part as the oracle compares it: the title by its name and bytes alone, which is all its contract fixes; a file
 * part by its name, file name, content type essence, the headers its Encoding declares and its bytes.
 */
type Compared = Readonly<{
	name: string
	filename: Option.Option<string>
	contentType: Option.Option<string>
	declared: HeaderList
	body: Uint8Array
}>

/** The header lines a document's file part declares, by their names in lower case. */
const DECLARED: ReadonlyArray<string> = ["x-checksum", "x-trace"]

const byName = Order.mapInput(Order.String, (header: readonly [string, string]) =>
	Str.toLowerCase(header[0])
)

/** A part read off the wire, compared as its contract fixes it. */
const comparedOf = (part: Part): Compared =>
	part.name === "file"
		? {
				name: part.name,
				filename: part.filename,
				contentType: partType(part),
				declared: Arr.sort(
					Arr.filter(part.headers, ([name]) => Arr.contains(DECLARED, Str.toLowerCase(name))),
					byName
				),
				body: part.body
			}
		: {
				name: part.name,
				filename: Option.none(),
				contentType: Option.none(),
				declared: [],
				body: part.body
			}

const byPart = Order.mapInput(Order.String, (part: Compared) => part.name)

/** What the oracle compares of a run. */
type Outcome = Readonly<{
	exitCode: number
	connections: number
	parts: ReadonlyArray<ReadonlyArray<Compared>>
}>

/** The checksum header line a document's file part carries. */
const checksumLine = (checksum: string): HeaderList => [["X-Checksum", checksum]]

/** The title part a run sends. */
const titlePart = (title: string): Compared => ({
	name: "title",
	filename: Option.none(),
	contentType: Option.none(),
	declared: [],
	body: new TextEncoder().encode(title)
})

/** The run each case's contract gives. */
const expectedOf = (r: Run): Outcome => {
	const sent = (parts: ReadonlyArray<Compared>): Outcome => ({
		exitCode: 0,
		connections: 1,
		parts: [Arr.sort(parts, byPart)]
	})
	switch (r.kind) {
		case "upload":
			return sent(
				Arr.append(
					Option.match(r.file, {
						onNone: (): ReadonlyArray<Compared> => [],
						onSome: (file): ReadonlyArray<Compared> => [
							{
								name: "file",
								filename: Option.some(FILE_NAME),
								contentType: Option.some(file.type),
								declared: [],
								body: file.bytes
							}
						]
					}),
					titlePart(r.title)
				)
			)
		case "document":
			return sent(
				Arr.append(
					Option.match(r.file, {
						onNone: (): ReadonlyArray<Compared> => [],
						onSome: (file): ReadonlyArray<Compared> => [
							{
								name: "file",
								filename: Option.some(FILE_NAME),
								contentType: Option.some("image/png"),
								declared: Arr.sort(
									Arr.appendAll(
										checksumLine(file.checksum),
										Option.match(file.trace, {
											onNone: (): HeaderList => [],
											onSome: (trace): HeaderList => [["X-Trace", trace]]
										})
									),
									byName
								),
								body: file.bytes
							}
						]
					}),
					titlePart(r.title)
				)
			)
		case "fault":
			return { exitCode: 2, connections: 0, parts: [] }
	}
}

/** A recorded request's parts, compared as their contract fixes them. */
const partsSent = (request: WireRequest): ReadonlyArray<Compared> =>
	Option.match(
		boundaryOf(Option.getOrElse(Arr.head(valuesOf(request.headers, "content-type")), () => "")),
		{
			onNone: () => [],
			onSome: (boundary) => Arr.sort(Arr.map(partsOf(request.body, boundary), comparedOf), byPart)
		}
	)

/** An empty `204`. */
const done: ScriptedResponse = {
	status: 204,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

type PartFeature =
	| Fault
	| "a PNG upload"
	| "a JPEG upload"
	| "an upload without its file"
	| "a document with its trace"
	| "a document without its trace"
	| "a document without its file"

/** The features a run reaches. */
const runFeatures = (r: Run): ReadonlyArray<PartFeature> => {
	switch (r.kind) {
		case "upload":
			return [
				Option.match(r.file, {
					onNone: (): PartFeature => "an upload without its file",
					onSome: (file): PartFeature =>
						file.type === "image/png" ? "a PNG upload" : "a JPEG upload"
				})
			]
		case "document":
			return [
				Option.match(r.file, {
					onNone: (): PartFeature => "a document without its file",
					onSome: (file): PartFeature =>
						Option.isSome(file.trace) ? "a document with its trace" : "a document without its trace"
				})
			]
		case "fault":
			return [r.fault]
	}
}

/** The suite's fixture: the capture server, the package built against it, and each operation's command. */
class PartsFixture extends Context.Service<
	PartsFixture,
	Readonly<{
		server: CaptureServer
		built: BuiltPackage
		commands: Readonly<Record<Operation, ReadonlyArray<string>>>
	}>
>()("effect-openapi-cli-generator/test/generated/multipart-parts.test/PartsFixture") {}

const fixture = Layer.effect(
	PartsFixture,
	Effect.gen(function* () {
		const server = yield* captureServer
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins["127.0.0.1"]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const commands = yield* Effect.all(
			Rec.map(POINTERS, (pointer) =>
				Effect.map(
					Effect.fromOption(
						Arr.findFirst(generated.result.report.commandNames, (name) => name.pointer === pointer)
					),
					(name) => name.path
				)
			)
		)
		return { server, built, commands }
	})
).pipe(Layer.provideMerge(harnessLayer))

layer(fixture, { excludeTestServices: true })("a generated CLI's multipart parts", (it) => {
	it.effect(
		"carry their chosen or declared content type and declared headers, and nothing for a bad part flag",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { server, built, commands } = yield* PartsFixture
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "multipart-parts-" })
					const file = path.join(scratch, FILE_NAME)
					return yield* explore(
						{
							suite: "multipart parts",
							draw: drawn(runOf),
							literal: Formatter.format,
							coverage: required<PartFeature>(
								[
									"a PNG upload",
									"a JPEG upload",
									"an upload without its file",
									"a document with its trace",
									"a document without its trace",
									"a document without its file",
									"a part without its content type",
									"a content type without its part",
									"a content type the part does not list",
									"a part without its required header",
									"a header flag without its part",
									"a header value with a line break"
								],
								{ cases: 30, sense: notesOnly }
							),
							kept: [],
							runs: 12,
							shrink: { kind: "bounded", candidates: 30 },
							concurrency: 1,
							steerEvery: 3,
							caseHang: Duration.seconds(60)
						},
						(r, k) =>
							Effect.gen(function* () {
								k.noteAll(runFeatures(r))
								const invoked = invocationOf(r, file)
								yield* fs.writeFile(file, invoked.file)
								const observed = yield* server.observe(
									() => done,
									runBin(built, {
										args: Arr.flatten([
											commands[invoked.operation],
											["--base-url", server.origins["127.0.0.1"]],
											invoked.args
										]),
										env: {},
										stdin: new Uint8Array(0)
									})
								)
								deepStrictEqual<Outcome>(
									{
										exitCode: observed.result.exitCode,
										connections: observed.connections.length,
										parts: Arr.map(observed.requests, partsSent)
									},
									expectedOf(r),
									"each part carries its chosen or declared content type and headers, and a bad part flag sends nothing"
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
