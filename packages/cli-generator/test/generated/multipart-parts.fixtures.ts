import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	bytes,
	characterOf,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	option,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Duration, Effect, Option, Order, Record as Rec, String as Str } from "effect"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	workerFixture
} from "#test/support/cli-package.ts"
import { type HeaderList, valuesOf, type WireRequest } from "#test/support/http.ts"
import { boundaryOf, type Part, partsOf, partType } from "#test/support/multipart.ts"

/** What the multipart-parts property (multipart-parts.test.ts) draws and its fixture: the box, its runs and faults. */

/** The operations of the box. */
type Operation = "uploads" | "docs"

/** The pointers of the box's operations. */
const POINTERS: Readonly<Record<Operation, string>> = {
	uploads: "/paths/~1uploads/post",
	docs: "/paths/~1docs/post"
}

/** A file part's schema. */
const fileSchema = { contentMediaType: "application/octet-stream", type: "string" } as const

/** An upload whose file part may be PNG or JPEG, and a document whose PNG file part declares two headers. */
const spec = jsonText({
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
	jsonText({
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

type UploadFile = Readonly<{ bytes: Uint8Array; type: ImageType }>

type DocumentFile = Readonly<{ bytes: Uint8Array; checksum: string; trace: Option.Option<string> }>

const uploadFile =
	(type: Gen<ImageType>): Gen<UploadFile> =>
	(source) => ({ bytes: source.draw(bytes({ min: 0, max: 24 })), type: source.draw(type) })

const documentFile =
	(trace: Gen<Option.Option<string>>): Gen<DocumentFile> =>
	(source) => ({
		bytes: source.draw(bytes({ min: 0, max: 24 })),
		checksum: source.draw(string(characterOf(["0", "9", "a", "f"]), { min: 4, max: 8 })),
		trace: source.draw(trace)
	})

const upload =
	(file: Gen<Option.Option<UploadFile>>): Gen<Run> =>
	(source) => ({ kind: "upload", title: source.draw(text), file: source.draw(file) })

const documentRun =
	(file: Gen<Option.Option<DocumentFile>>): Gen<Run> =>
	(source) => ({ kind: "document", title: source.draw(text), file: source.draw(file) })

const FAULTS: Arr.NonEmptyReadonlyArray<Fault> = [
	"a part without its content type",
	"a content type without its part",
	"a content type the part does not list",
	"a part without its required header",
	"a header flag without its part",
	"a header value with a line break"
]

const planted =
	(fault: Gen<Fault>): Gen<Run> =>
	(source) => ({ kind: "fault", fault: source.draw(fault) })

const IMAGE_TYPES: Arr.NonEmptyReadonlyArray<ImageType> = ["image/png", "image/jpeg"]

const runOf: Gen<Run> = oneOf([
	upload(option(uploadFile(element(IMAGE_TYPES)))),
	documentRun(option(documentFile(option(text)))),
	planted(element(FAULTS))
])

/** The file every run that sends one writes, by its name. */
export const FILE_NAME = "part.bin"

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
export const invocationOf = (r: Run, file: string): Invocation => {
	switch (r.kind) {
		case "upload":
			return {
				operation: "uploads",
				args: Arr.appendAll(
					[`--title=${r.title}`],
					Option.match(r.file, {
						onNone: () => [],
						onSome: (sent) => ["--file", file, `--file-content-type=${sent.type}`]
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
					[`--title=${r.title}`],
					Option.match(r.file, {
						onNone: () => [],
						onSome: (sent) =>
							Arr.flatten([
								["--file", file, `--file-x-checksum=${sent.checksum}`],
								Option.match(sent.trace, {
									onNone: () => [],
									onSome: (trace) => [`--file-x-trace=${trace}`]
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
export type Outcome = Readonly<{
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
export const expectedOf = (r: Run): Outcome => {
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
export const partsSent = (request: WireRequest): ReadonlyArray<Compared> =>
	Option.match(
		boundaryOf(Option.getOrElse(Arr.head(valuesOf(request.headers, "content-type")), () => "")),
		{
			onNone: () => [],
			onSome: (boundary) => Arr.sort(Arr.map(partsOf(request.body, boundary), comparedOf), byPart)
		}
	)

/** An empty `204`. */
export const done: ScriptedResponse = {
	status: 204,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

export type PartFeature =
	| Fault
	| "a PNG upload"
	| "a JPEG upload"
	| "an upload without its file"
	| "a document with its trace"
	| "a document without its trace"
	| "a document without its file"

/** The features a run reaches. */
export const runFeatures = (r: Run): ReadonlyArray<PartFeature> => {
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

export const FEATURES: Arr.NonEmptyReadonlyArray<PartFeature> = [
	"a PNG upload",
	"a JPEG upload",
	"an upload without its file",
	"a document with its trace",
	"a document without its trace",
	"a document without its file",
	...FAULTS
]

/** The run a focus draws: one made to reach that feature, every other choice drawn at random. */
const caseFor = (focus: PartFeature): Gen<Run> => {
	switch (focus) {
		case "a PNG upload":
			return upload(map(uploadFile(constant<ImageType>("image/png")), Option.some))
		case "a JPEG upload":
			return upload(map(uploadFile(constant<ImageType>("image/jpeg")), Option.some))
		case "an upload without its file":
			return upload(constant(Option.none()))
		case "a document with its trace":
			return documentRun(map(documentFile(map(text, Option.some)), Option.some))
		case "a document without its trace":
			return documentRun(map(documentFile(constant(Option.none())), Option.some))
		case "a document without its file":
			return documentRun(constant(Option.none()))
		case "a part without its content type":
		case "a content type without its part":
		case "a content type the part does not list":
		case "a part without its required header":
		case "a header flag without its part":
		case "a header value with a line break":
			return planted(constant(focus))
	}
}

/** A focus, or none, each half the time: none draws any run. */
const FOCUS: Gen<Option.Option<PartFeature>> = weighted([
	[1, constant(Option.none())],
	[1, map(element(FEATURES), Option.some)]
])

/** The suite's fixture, once per worker: the capture server, the package built against it, and each operation's
 * command. */
export const partsFixture = workerFixture(
	"test/generated/multipart-parts.fixtures.ts partsFixture",
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
		const opened: Readonly<{
			server: CaptureServer
			built: BuiltPackage
			commands: Readonly<Record<Operation, ReadonlyArray<string>>>
		}> = { server, built, commands }
		return opened
	})
)

/**
 * The runs a case draws: the floor's and the rotating stream's from FOCUS, a feature's run or any run, each half the
 * time; a case aimed at a required feature still pending, from the run made to reach it (caseFor).
 */
const unsteered: Gen<Run> = (source) =>
	Option.match(FOCUS(source), { onNone: () => runOf, onSome: caseFor })(source)

export const parts = aimed(
	unsteered,
	Arr.map(FEATURES, (feature) => [feature, caseFor(feature)] as const)
)
