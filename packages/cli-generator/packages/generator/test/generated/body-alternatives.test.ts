/**
 * A generated CLI sends one of an operation's request body alternatives, the one `--content-type` names (JSON when
 * none does, even when another is listed first), encoded as that media type says, and refuses before any connection a
 * flag that belongs to another alternative or a media type the operation does not declare.
 *
 * - Bodies: a message posted as JSON, by default or named, as a form or as multipart; an upload whose multipart
 *   alternative is listed before JSON, posted by default; and events sent as NDJSON from stdin. Fields of URL-safe text:
 *   the message's text, its tags (a form field the Encoding Object joins with commas) and its ids (repeated pairs), the
 *   multipart file's bytes. Oracles: the media type's own reading of the body: JSON parsed to the fields given, form
 *   pairs in schema order under the Encoding rules, multipart parts by name with each part's content type and the
 *   file's name and bytes, NDJSON byte for byte and chunked.
 * - Faults, planted one per run: a part flag under the JSON default, `--body` with multipart named, and a media type
 *   the operation does not declare. Oracle: exit 2 and no connection.
 *
 * Under the owner's swarm gate this suite has not been run yet, nor checked against plants.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import { drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import {
	array,
	boolean,
	bytes,
	characterOf,
	element,
	type Gen,
	option,
	string
} from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import { regex } from "arkregex"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Path,
	Order,
	Record as Rec,
	Schema,
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
import { valuesOf, type WireRequest } from "#test/support/http.ts"

/** The operations of the box. */
type Operation = "messages" | "uploads" | "events"

/** The pointers of the box's operations. */
const POINTERS: Readonly<Record<Operation, string>> = {
	messages: "/paths/~1channels~1{id}~1messages/post",
	uploads: "/paths/~1files/post",
	events: "/paths/~1events/post"
}

/** A message, a form of it and its multipart parts; an upload listed multipart first; events as JSON, NDJSON or text. */
const spec = jsonTextOf({
	openapi: "3.1.0",
	info: { title: "Body alternatives", version: "1.0.0" },
	components: {
		schemas: {
			Message: {
				type: "object",
				properties: {
					content: { type: "string" },
					tags: { type: "array", items: { type: "string" } },
					ids: { type: "array", items: { type: "string" } }
				}
			},
			MessageParts: {
				type: "object",
				properties: {
					content: { type: "string" },
					file: { type: "string", contentMediaType: "application/octet-stream" }
				},
				required: ["file"]
			},
			Upload: {
				type: "object",
				properties: {
					file: { type: "string", contentMediaType: "application/octet-stream" },
					purpose: { type: "string" }
				},
				required: ["file", "purpose"]
			},
			UploadLink: {
				type: "object",
				properties: { purpose: { type: "string" }, url: { type: "string" } },
				required: ["purpose"]
			},
			Event: { type: "object", properties: { name: { type: "string" } } }
		}
	},
	paths: {
		"/channels/{id}/messages": {
			post: {
				operationId: "messages-create",
				parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: { $ref: "#/components/schemas/Message" } },
						"application/x-www-form-urlencoded": {
							schema: { $ref: "#/components/schemas/Message" },
							encoding: { tags: { explode: false } }
						},
						"multipart/form-data": {
							schema: { $ref: "#/components/schemas/MessageParts" },
							encoding: {
								content: { contentType: "text/plain" },
								file: { contentType: "application/octet-stream" }
							}
						}
					}
				},
				responses: { "204": { description: "Posted." } }
			}
		},
		"/files": {
			post: {
				operationId: "files-upload",
				requestBody: {
					required: true,
					content: {
						"multipart/form-data": {
							schema: { $ref: "#/components/schemas/Upload" },
							encoding: {
								file: { contentType: "application/octet-stream" },
								purpose: { contentType: "text/plain" }
							}
						},
						"application/json": { schema: { $ref: "#/components/schemas/UploadLink" } }
					}
				},
				responses: { "204": { description: "Uploaded." } }
			}
		},
		"/events": {
			post: {
				operationId: "events-send",
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: { $ref: "#/components/schemas/Event" } },
						"application/x-ndjson": { schema: { $ref: "#/components/schemas/Event" } },
						"text/plain": { schema: { type: "string" } }
					}
				},
				responses: { "204": { description: "Sent." } }
			}
		}
	}
})

/** The author config, binding the capture server's origin. */
const configOf = (bound: string): string =>
	jsonTextOf({
		package: { name: "body-alternatives", version: "1.0.0" },
		binName: "alts",
		envPrefix: "ALTS",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** A message's form fields: its text, its tags and its ids. */
type MessageFields = Readonly<{
	content: Option.Option<string>
	tags: ReadonlyArray<string>
	ids: ReadonlyArray<string>
}>

/** A fault planted in a message's run. */
type Fault =
	| "a part flag under the JSON default"
	| "--body with multipart named"
	| "an undeclared media type"

/** One run: an alternative sent with its fields, or a planted fault. */
type Send =
	| Readonly<{ kind: "message as JSON"; named: boolean; fields: MessageFields }>
	| Readonly<{ kind: "message as a form"; fields: MessageFields }>
	| Readonly<{ kind: "message as multipart"; content: Option.Option<string>; file: Uint8Array }>
	| Readonly<{ kind: "upload by default"; purpose: string }>
	| Readonly<{ kind: "events as NDJSON"; lines: ReadonlyArray<string> }>
	| Readonly<{ kind: "fault"; fault: Fault }>

/** URL-safe text, which every one of the box's encodings carries as written. */
const text: Gen<string> = string(characterOf(["a", "Z", "0", "-", "_", "."]), { min: 1, max: 6 })

const fields: Gen<MessageFields> = (source) => ({
	content: option(text)(source),
	tags: array(text, { min: 0, max: 3 })(source),
	ids: array(text, { min: 0, max: 3 })(source)
})

const send: Gen<Send> = (source) => {
	const kind = element<Send["kind"]>([
		"message as JSON",
		"message as a form",
		"message as multipart",
		"upload by default",
		"events as NDJSON",
		"fault"
	])(source)
	switch (kind) {
		case "message as JSON":
			return { kind, named: boolean(source), fields: fields(source) }
		case "message as a form":
			return { kind, fields: fields(source) }
		case "message as multipart":
			return { kind, content: option(text)(source), file: bytes({ min: 0, max: 24 })(source) }
		case "upload by default":
			return { kind, purpose: text(source) }
		case "events as NDJSON":
			return {
				kind,
				lines: array((inner) => `{"name":"${text(inner)}"}`, { min: 1, max: 3 })(source)
			}
		case "fault":
			return {
				kind,
				fault: element<Fault>([
					"a part flag under the JSON default",
					"--body with multipart named",
					"an undeclared media type"
				])(source)
			}
	}
}

/** The arguments for a message's fields: its text, each tag and each id as its own flag. */
const fieldArgs = (given: MessageFields): ReadonlyArray<string> =>
	Arr.flatten([
		Option.match(given.content, { onNone: () => [], onSome: (value) => ["--content", value] }),
		Arr.flatMap(given.tags, (tag) => ["--tags", tag]),
		Arr.flatMap(given.ids, (id) => ["--ids", id])
	])

/** The file a multipart run sends, by its name. */
const FILE_NAME = "part.bin"

/** A run's arguments after its command, its stdin, and the operation it runs. */
type Invocation = Readonly<{ operation: Operation; args: ReadonlyArray<string>; stdin: Uint8Array }>

/** How a case is invoked, given where its file lies. */
const invocationOf = (s: Send, file: string): Invocation => {
	const none = new Uint8Array(0)
	switch (s.kind) {
		case "message as JSON":
			return {
				operation: "messages",
				args: Arr.flatten([
					["c1"],
					s.named ? ["--content-type", "application/json"] : [],
					fieldArgs(s.fields)
				]),
				stdin: none
			}
		case "message as a form":
			return {
				operation: "messages",
				args: Arr.flatten([
					["c1", "--content-type", "application/x-www-form-urlencoded"],
					fieldArgs(s.fields)
				]),
				stdin: none
			}
		case "message as multipart":
			return {
				operation: "messages",
				args: Arr.flatten([
					["c1", "--content-type", "multipart/form-data"],
					Option.match(s.content, { onNone: () => [], onSome: (value) => ["--content", value] }),
					["--file", file]
				]),
				stdin: none
			}
		case "upload by default":
			return { operation: "uploads", args: ["--purpose", s.purpose], stdin: none }
		case "events as NDJSON":
			return {
				operation: "events",
				args: ["--content-type", "application/x-ndjson", "--body-file", "-"],
				stdin: new TextEncoder().encode(
					Arr.join(
						Arr.map(s.lines, (line) => `${line}\n`),
						""
					)
				)
			}
		case "fault":
			return { operation: "messages", args: faultArgs(s.fault, file), stdin: none }
	}
}

/** The arguments of a planted fault. */
const faultArgs = (fault: Fault, file: string): ReadonlyArray<string> => {
	switch (fault) {
		case "a part flag under the JSON default":
			return ["c1", "--file", file]
		case "--body with multipart named":
			return ["c1", "--content-type", "multipart/form-data", "--body", "{}"]
		case "an undeclared media type":
			return ["c1", "--content-type", "text/plain", "--content", "hi"]
	}
}

/** A multipart part as the reference reader reads it: its name, file name, content type and bytes. */
type Part = Readonly<{
	name: string
	filename: Option.Option<string>
	contentType: Option.Option<string>
	body: Uint8Array
}>

/** What a body says, read by its media type's own rules. */
type Reading =
	| Readonly<{ kind: "json"; value: Schema.Json }>
	| Readonly<{ kind: "form"; pairs: ReadonlyArray<readonly [string, string]> }>
	| Readonly<{ kind: "multipart"; parts: ReadonlyArray<Part> }>
	| Readonly<{ kind: "bytes"; bytes: Uint8Array; chunked: boolean }>

/** What the oracle compares of a run: its exit code, its connections, and each request's media type and reading. */
type Outcome = Readonly<{
	exitCode: number
	connections: number
	requests: ReadonlyArray<Readonly<{ mediaType: string; reading: Reading }>>
}>

const BOUNDARY = regex("^multipart/form-data; boundary=(.+)$", "u")

const DISPOSITION_NAME = regex('name="([^"]*)"', "u")

const DISPOSITION_FILE = regex('filename="([^"]*)"', "u")

/** A multipart body's parts: split at each boundary delimiter, each a head and a body before its trailing CRLF. */
const partsOf = (body: Uint8Array, boundary: string): ReadonlyArray<Part> => {
	const sections = Str.split(`--${boundary}`)(Buffer.from(body).toString("latin1"))
	return Arr.flatMap(Arr.drop(sections, 1), (section) =>
		Option.match(Str.indexOf("\r\n\r\n")(section), {
			onNone: () => [],
			onSome: (headEnd) => {
				const head = Str.slice(2, headEnd)(section)
				const content = Str.slice(headEnd + 4, section.length - 2)(section)
				const lines = Str.split("\r\n")(head)
				const disposition = Arr.findFirst(lines, (line) =>
					Str.startsWith("content-disposition:")(Str.toLowerCase(line))
				)
				return Option.match(
					Option.flatMap(disposition, (line) => Option.fromNullishOr(DISPOSITION_NAME.exec(line))),
					{
						onNone: () => [],
						onSome: ([, name]) => [
							{
								name,
								filename: Option.flatMap(disposition, (line) =>
									Option.map(Option.fromNullishOr(DISPOSITION_FILE.exec(line)), ([, file]) => file)
								),
								contentType: Option.map(
									Arr.findFirst(lines, (line) =>
										Str.startsWith("content-type:")(Str.toLowerCase(line))
									),
									(line) => Str.trim(Str.slice(13)(line))
								),
								body: Uint8Array.from(Buffer.from(content, "latin1"))
							}
						]
					}
				)
			}
		})
	)
}

/** A form body's pairs, each name and value percent-decoded. */
const pairsOf = (body: Uint8Array): ReadonlyArray<readonly [string, string]> =>
	Arr.map(
		Arr.filter(Str.split("&")(Buffer.from(body).toString("latin1")), Str.isNonEmpty),
		(pair): readonly [string, string] =>
			Option.match(Str.indexOf("=")(pair), {
				onNone: () => [decodeURIComponent(pair), ""],
				onSome: (at) => [
					decodeURIComponent(Str.slice(0, at)(pair)),
					decodeURIComponent(Str.slice(at + 1)(pair))
				]
			})
	)

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

/** A content type's essence: the media type before any parameter. */
const essenceOf = (contentType: string): string =>
	Str.trim(Arr.headNonEmpty(Str.split(";")(contentType)))

/** A request as the oracle compares it: its media type's essence and its body as that media type reads it. */
type Received = Readonly<{ mediaType: string; reading: Reading }>

/** A recorded request's media type and its body read by that media type's rules. */
const receivedOf = (request: WireRequest): Effect.Effect<Received, Schema.SchemaError> => {
	const contentType = Option.getOrElse(
		Arr.head(valuesOf(request.headers, "content-type")),
		() => ""
	)
	const mediaType = essenceOf(contentType)
	return Option.match(Option.fromNullishOr(BOUNDARY.exec(contentType)), {
		onSome: ([, boundary]): Effect.Effect<Received, Schema.SchemaError> =>
			Effect.succeed({
				mediaType,
				reading: { kind: "multipart", parts: sortedParts(partsOf(request.body, boundary)) }
			}),
		onNone: (): Effect.Effect<Received, Schema.SchemaError> => {
			if (mediaType === "application/json") {
				return Effect.map(decodeJson(Buffer.from(request.body).toString("utf8")), (value) => ({
					mediaType,
					reading: { kind: "json", value }
				}))
			}
			if (mediaType === "application/x-www-form-urlencoded") {
				return Effect.succeed({
					mediaType,
					reading: { kind: "form", pairs: pairsOf(request.body) }
				})
			}
			return Effect.succeed({
				mediaType,
				reading: {
					kind: "bytes",
					bytes: request.body,
					chunked: Arr.contains(valuesOf(request.headers, "transfer-encoding"), "chunked")
				}
			})
		}
	})
}

/** Parts in name order: the contract names each part, not their order. */
const sortedParts = (parts: ReadonlyArray<Part>): ReadonlyArray<Part> =>
	Arr.sort(
		parts,
		Order.mapInput(Order.String, (part: Part) => part.name)
	)

/** The JSON a message's fields make: each given field, and none that was not. */
const messageJson = (given: MessageFields): Schema.Json =>
	Rec.fromEntries(
		Arr.flatten<ReadonlyArray<ReadonlyArray<readonly [string, Schema.Json]>>>([
			Option.match(given.content, { onNone: () => [], onSome: (value) => [["content", value]] }),
			Arr.isReadonlyArrayNonEmpty(given.tags) ? [["tags", given.tags]] : [],
			Arr.isReadonlyArrayNonEmpty(given.ids) ? [["ids", given.ids]] : []
		])
	)

/** The pairs a message's fields make under its form's Encoding: tags joined with commas, each id its own pair. */
const messagePairs = (given: MessageFields): ReadonlyArray<readonly [string, string]> =>
	Arr.flatten<ReadonlyArray<ReadonlyArray<readonly [string, string]>>>([
		Option.match(given.content, { onNone: () => [], onSome: (value) => [["content", value]] }),
		Arr.isReadonlyArrayNonEmpty(given.tags) ? [["tags", Arr.join(given.tags, ",")]] : [],
		Arr.map(given.ids, (id): readonly [string, string] => ["ids", id])
	])

/** The run each alternative's contract gives: one request, its media type and what its body reads as. */
const expectedOf = (s: Send): Outcome => {
	const one = (received: Received): Outcome => ({
		exitCode: 0,
		connections: 1,
		requests: [received]
	})
	switch (s.kind) {
		case "message as JSON":
			return one({
				mediaType: "application/json",
				reading: { kind: "json", value: messageJson(s.fields) }
			})
		case "message as a form":
			return one({
				mediaType: "application/x-www-form-urlencoded",
				reading: { kind: "form", pairs: messagePairs(s.fields) }
			})
		case "message as multipart":
			return one({
				mediaType: "multipart/form-data",
				reading: {
					kind: "multipart",
					parts: sortedParts(
						Arr.appendAll(
							Option.match(s.content, {
								onNone: (): ReadonlyArray<Part> => [],
								onSome: (value): ReadonlyArray<Part> => [
									{
										name: "content",
										filename: Option.none(),
										contentType: Option.some("text/plain"),
										body: new TextEncoder().encode(value)
									}
								]
							}),
							[
								{
									name: "file",
									filename: Option.some(FILE_NAME),
									contentType: Option.some("application/octet-stream"),
									body: s.file
								}
							]
						)
					)
				}
			})
		case "upload by default":
			return one({
				mediaType: "application/json",
				reading: { kind: "json", value: { purpose: s.purpose } }
			})
		case "events as NDJSON":
			return one({
				mediaType: "application/x-ndjson",
				reading: {
					kind: "bytes",
					bytes: new TextEncoder().encode(
						Arr.join(
							Arr.map(s.lines, (line) => `${line}\n`),
							""
						)
					),
					chunked: true
				}
			})
		case "fault":
			return { exitCode: 2, connections: 0, requests: [] }
	}
}

/** An empty `204`. */
const done: ScriptedResponse = {
	status: 204,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

type AlternativeFeature =
	| Send["kind"]
	| Fault
	| "JSON named"
	| "tags joined"
	| "ids repeated"
	| "a message without its text"

/** The features a case reaches. */
const sendFeatures = (s: Send): ReadonlyArray<AlternativeFeature> => {
	switch (s.kind) {
		case "message as JSON":
			return Arr.flatten<ReadonlyArray<ReadonlyArray<AlternativeFeature>>>([
				[s.kind],
				s.named ? ["JSON named"] : [],
				Option.isNone(s.fields.content) ? ["a message without its text"] : []
			])
		case "message as a form":
			return Arr.flatten<ReadonlyArray<ReadonlyArray<AlternativeFeature>>>([
				[s.kind],
				s.fields.tags.length > 1 ? ["tags joined"] : [],
				s.fields.ids.length > 1 ? ["ids repeated"] : []
			])
		case "message as multipart":
		case "upload by default":
		case "events as NDJSON":
			return [s.kind]
		case "fault":
			return [s.kind, s.fault]
	}
}

/** The suite's fixture: the capture server, the package built against it, and each operation's command. */
class AlternativesFixture extends Context.Service<
	AlternativesFixture,
	Readonly<{
		server: CaptureServer
		built: BuiltPackage
		commands: Readonly<Record<Operation, ReadonlyArray<string>>>
	}>
>()("effect-openapi-cli-generator/test/generated/body-alternatives.test/AlternativesFixture") {}

const fixture = Layer.effect(
	AlternativesFixture,
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

layer(fixture, { excludeTestServices: true })("a generated CLI's request bodies", (it) => {
	it.effect(
		"are the alternative --content-type names, encoded by its media type, and nothing for a misplaced flag",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { server, built, commands } = yield* AlternativesFixture
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "body-alternatives-" })
					const file = path.join(scratch, FILE_NAME)
					return yield* explore(
						{
							suite: "body alternatives",
							draw: drawn(send),
							literal: Formatter.format,
							coverage: required<AlternativeFeature>(
								[
									"message as JSON",
									"message as a form",
									"message as multipart",
									"upload by default",
									"events as NDJSON",
									"a part flag under the JSON default",
									"--body with multipart named",
									"an undeclared media type",
									"JSON named",
									"tags joined",
									"ids repeated",
									"a message without its text"
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
						(s, k) =>
							Effect.gen(function* () {
								k.noteAll(sendFeatures(s))
								if (s.kind === "message as multipart") {
									yield* fs.writeFile(file, s.file)
								}
								const invoked = invocationOf(s, file)
								const observed = yield* server.observe(
									() => done,
									runBin(built, {
										args: Arr.flatten([
											commands[invoked.operation],
											["--base-url", server.origins["127.0.0.1"]],
											invoked.args
										]),
										env: {},
										stdin: invoked.stdin
									})
								)
								const requests = yield* Effect.forEach(observed.requests, receivedOf)
								deepStrictEqual<Outcome>(
									{
										exitCode: observed.result.exitCode,
										connections: observed.connections.length,
										requests
									},
									expectedOf(s),
									"the request is the named alternative, encoded by its media type, or none for a misplaced flag"
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
