import {
	aimed,
	array,
	boolean,
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

/** What the body-alternatives property (body-alternatives.test.ts) draws and its fixture: the box's runs. */
import { jsonTextOf } from "@superstarter/json"
import {
	Array as Arr,
	Duration,
	Effect,
	Option,
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
	workerFixture
} from "#test/support/cli-package.ts"
import { formPairs, type Pair } from "#test/support/form.ts"
import { valuesOf, type WireRequest } from "#test/support/http.ts"
import { boundaryOf, partsOf, partType } from "#test/support/multipart.ts"

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

/** A message's fields, each drawn from its own generator. */
const fieldsOf =
	(
		content: Gen<Option.Option<string>>,
		tags: Gen<ReadonlyArray<string>>,
		ids: Gen<ReadonlyArray<string>>
	): Gen<MessageFields> =>
	(source) => ({ content: source.draw(content), tags: source.draw(tags), ids: source.draw(ids) })

const someText: Gen<ReadonlyArray<string>> = array(text, { min: 0, max: 3 })

const severalTexts: Gen<ReadonlyArray<string>> = array(text, { min: 2, max: 3 })

const fields: Gen<MessageFields> = fieldsOf(option(text), someText, someText)

const FAULTS: Arr.NonEmptyReadonlyArray<Fault> = [
	"a part flag under the JSON default",
	"--body with multipart named",
	"an undeclared media type"
]

const asJson =
	(named: Gen<boolean>, given: Gen<MessageFields>): Gen<Send> =>
	(source) => ({ kind: "message as JSON", named: source.draw(named), fields: source.draw(given) })

const asForm =
	(given: Gen<MessageFields>): Gen<Send> =>
	(source) => ({ kind: "message as a form", fields: source.draw(given) })

const asMultipart: Gen<Send> = (source) => ({
	kind: "message as multipart",
	content: source.draw(option(text)),
	file: source.draw(bytes({ min: 0, max: 24 }))
})

const uploadByDefault: Gen<Send> = (source) => ({
	kind: "upload by default",
	purpose: source.draw(text)
})

const eventsAsNdjson: Gen<Send> = (source) => ({
	kind: "events as NDJSON",
	lines: source.draw(array((inner) => `{"name":"${inner.draw(text)}"}`, { min: 1, max: 3 }))
})

const planted =
	(fault: Gen<Fault>): Gen<Send> =>
	(source) => ({ kind: "fault", fault: source.draw(fault) })

const send: Gen<Send> = oneOf([
	asJson(boolean, fields),
	asForm(fields),
	asMultipart,
	uploadByDefault,
	eventsAsNdjson,
	planted(element(FAULTS))
])

/** The arguments for a message's fields: its text, each tag and each id as its own flag. */
const fieldArgs = (given: MessageFields): ReadonlyArray<string> =>
	Arr.flatten([
		Option.match(given.content, { onNone: () => [], onSome: (value) => [`--content=${value}`] }),
		Arr.map(given.tags, (tag) => `--tags=${tag}`),
		Arr.map(given.ids, (id) => `--ids=${id}`)
	])

/** The file a multipart run sends, by its name. */
export const FILE_NAME = "part.bin"

/** A run's arguments after its command, its stdin, and the operation it runs. */
type Invocation = Readonly<{ operation: Operation; args: ReadonlyArray<string>; stdin: Uint8Array }>

/** How a case is invoked, given where its file lies. */
export const invocationOf = (s: Send, file: string): Invocation => {
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
					Option.match(s.content, { onNone: () => [], onSome: (value) => [`--content=${value}`] }),
					["--file", file]
				]),
				stdin: none
			}
		case "upload by default":
			return { operation: "uploads", args: [`--purpose=${s.purpose}`], stdin: none }
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

/** A multipart part as the oracle compares it: its name, file name, content type essence and bytes. */
type ReadPart = Readonly<{
	name: string
	filename: Option.Option<string>
	contentType: Option.Option<string>
	body: Uint8Array
}>

/** What a body says, read by its media type's own rules. */
type Reading =
	| Readonly<{ kind: "json"; value: Schema.Json }>
	| Readonly<{ kind: "form"; pairs: ReadonlyArray<Pair> }>
	| Readonly<{ kind: "multipart"; parts: ReadonlyArray<ReadPart> }>
	| Readonly<{ kind: "bytes"; bytes: Uint8Array; chunked: boolean }>

/** What the oracle compares of a run: its exit code, its connections, and each request's media type and reading. */
export type Outcome = Readonly<{
	exitCode: number
	connections: number
	requests: ReadonlyArray<Readonly<{ mediaType: string; reading: Reading }>>
}>

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

/** A content type's essence: the media type before any parameter. */
const essenceOf = (contentType: string): string =>
	Str.trim(Arr.headNonEmpty(Str.split(";")(contentType)))

/** A request as the oracle compares it: its media type's essence and its body as that media type reads it. */
type Received = Readonly<{ mediaType: string; reading: Reading }>

/** A recorded request's media type and its body read by that media type's rules. */
export const receivedOf = (request: WireRequest): Effect.Effect<Received, Schema.SchemaError> => {
	const contentType = Option.getOrElse(
		Arr.head(valuesOf(request.headers, "content-type")),
		() => ""
	)
	const mediaType = essenceOf(contentType)
	return Option.match(boundaryOf(contentType), {
		onSome: (boundary): Effect.Effect<Received, Schema.SchemaError> =>
			Effect.succeed({
				mediaType,
				reading: {
					kind: "multipart",
					parts: sortedParts(
						Arr.map(partsOf(request.body, boundary), (part) => ({
							name: part.name,
							filename: part.filename,
							contentType: partType(part),
							body: part.body
						}))
					)
				}
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
					reading: { kind: "form", pairs: formPairs(request.body) }
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
const sortedParts = (parts: ReadonlyArray<ReadPart>): ReadonlyArray<ReadPart> =>
	Arr.sort(
		parts,
		Order.mapInput(Order.String, (part: ReadPart) => part.name)
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
export const expectedOf = (s: Send): Outcome => {
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
								onNone: (): ReadonlyArray<ReadPart> => [],
								onSome: (value): ReadonlyArray<ReadPart> => [
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
export const done: ScriptedResponse = {
	status: 204,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

export type AlternativeFeature =
	| Send["kind"]
	| Fault
	| "JSON named"
	| "tags joined"
	| "ids repeated"
	| "a message without its text"

/** The features a case reaches. */
export const sendFeatures = (s: Send): ReadonlyArray<AlternativeFeature> => {
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

export const FEATURES: Arr.NonEmptyReadonlyArray<AlternativeFeature> = [
	"message as JSON",
	"message as a form",
	"message as multipart",
	"upload by default",
	"events as NDJSON",
	...FAULTS,
	"JSON named",
	"tags joined",
	"ids repeated",
	"a message without its text"
]

/** The case a focus draws: a run made to reach that feature, every other choice drawn at random. */
const caseFor = (focus: AlternativeFeature): Gen<Send> => {
	switch (focus) {
		case "message as JSON":
			return asJson(boolean, fields)
		case "JSON named":
			return asJson(constant(true), fields)
		case "a message without its text":
			return asJson(boolean, fieldsOf(constant(Option.none()), someText, someText))
		case "message as a form":
			return asForm(fields)
		case "tags joined":
			return asForm(fieldsOf(option(text), severalTexts, someText))
		case "ids repeated":
			return asForm(fieldsOf(option(text), someText, severalTexts))
		case "message as multipart":
			return asMultipart
		case "upload by default":
			return uploadByDefault
		case "events as NDJSON":
			return eventsAsNdjson
		case "fault":
			return planted(element(FAULTS))
		case "a part flag under the JSON default":
		case "--body with multipart named":
		case "an undeclared media type":
			return planted(constant(focus))
	}
}

/** A focus, or none, each half the time: none draws any run. */
const FOCUS: Gen<Option.Option<AlternativeFeature>> = weighted([
	[1, constant(Option.none())],
	[1, map(element(FEATURES), Option.some)]
])

/** The suite's fixture, once per worker: the capture server, the package built against it, and each operation's command. */
export const bodyFixture = workerFixture(
	"test/generated/body-alternatives.fixtures.ts bodyFixture",
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
 * The cases a search draws: the floor's and the rotating stream's from FOCUS, a feature's case or any case, each
 * half the time; a case aimed at a required feature still pending, from the case made to reach it (caseFor).
 */
const unsteered: Gen<Send> = (source) =>
	Option.match(source.draw(FOCUS), { onNone: () => send, onSome: caseFor })(source)

export const cases = aimed(
	unsteered,
	Arr.map(FEATURES, (feature) => [feature, caseFor(feature)] as const)
)
