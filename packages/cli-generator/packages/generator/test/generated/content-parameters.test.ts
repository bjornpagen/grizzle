/**
 * A generated CLI sends a parameter written by `content` as its one media type's encoding of the value it was given:
 * JSON content as the JSON text of the value the flag parsed, text content as the text, in the parameter's place.
 *
 * - Parameters: a required JSON object in the query, an optional JSON array of strings in the query (the optional
 *   content parameter with an array schema, which reaches its builder as one value), an optional text header and an
 *   optional text cookie, each given or not; and planted faults, one per run: the required parameter missing, and
 *   text that is not JSON in a JSON flag. Oracles: the query's pairs percent-decoded and their JSON parsed back to the
 *   values given; the header's and the cookie's text as given; and exit 2 with no connection for each fault.
 * - Help: each JSON content flag shows `json` as its value in `--help`.
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
	characterOf,
	element,
	type Gen,
	int,
	option,
	string
} from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Formatter,
	Layer,
	Option,
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
import { type Pair, queryPairs } from "#test/support/form.ts"
import { metavarOf } from "#test/support/help.ts"
import { valuesOf, type WireRequest } from "#test/support/http.ts"

/** One GET with a JSON object and a JSON array in the query, a text header and a text cookie, each by `content`. */
const spec = jsonTextOf({
	openapi: "3.1.0",
	info: { title: "Content parameters", version: "1.0.0" },
	paths: {
		"/notes": {
			get: {
				operationId: "notes-list",
				parameters: [
					{
						in: "query",
						name: "coordinates",
						required: true,
						content: { "application/json": { schema: { type: "object" } } }
					},
					{
						in: "query",
						name: "tags",
						content: {
							"application/json": { schema: { type: "array", items: { type: "string" } } }
						}
					},
					{
						in: "header",
						name: "X-Trace",
						content: { "text/plain": { schema: { type: "string" } } }
					},
					{ in: "cookie", name: "c", content: { "text/plain": { schema: { type: "string" } } } }
				],
				responses: { "204": { description: "Done." } }
			}
		}
	}
})

/** The author config, binding the capture server's origin. */
const configOf = (bound: string): string =>
	jsonTextOf({
		package: { name: "content-parameters", version: "1.0.0" },
		binName: "notes",
		envPrefix: "NOTES",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** Text with no space, plus sign or separator, which every place a value goes carries as written once decoded. */
const word: Gen<string> = string(characterOf(["a", "Z", "0", "-", "_", ".", "é"]), {
	min: 1,
	max: 5
})

/** Text a header and a cookie carry as written. */
const plain: Gen<string> = string(characterOf(["a", "Z", "0", "-", "_", "."]), { min: 1, max: 6 })

/** A JSON leaf: a word, a whole number or a boolean. */
const leaf: Gen<Schema.Json> = (source) => {
	switch (element<"word" | "number" | "boolean">(["word", "number", "boolean"])(source)) {
		case "word":
			return word(source)
		case "number":
			return int(-1000, 1000)(source)
		case "boolean":
			return boolean(source)
	}
}

/** A JSON object whose members are drawn from `member`, under distinct short keys. */
const objectOf =
	(member: Gen<Schema.Json>): Gen<Readonly<Record<string, Schema.Json>>> =>
	(source) =>
		Rec.fromEntries(
			Arr.map(
				Arr.dedupe(
					array(string(characterOf(["a", "b", "c"]), { min: 1, max: 3 }), { min: 0, max: 3 })(
						source
					)
				),
				(key): readonly [string, Schema.Json] => [key, member(source)]
			)
		)

/** A JSON object of leaves and of objects of leaves. */
const object: Gen<Readonly<Record<string, Schema.Json>>> = objectOf((source) =>
	boolean(source) ? leaf(source) : objectOf(leaf)(source)
)

/** A fault planted in a run. */
type Fault = "the required parameter missing" | "text that is not JSON"

/** One run: the values given, or a planted fault. */
type Run =
	| Readonly<{
			kind: "values"
			coordinates: Readonly<Record<string, Schema.Json>>
			tags: Option.Option<ReadonlyArray<string>>
			trace: Option.Option<string>
			cookie: Option.Option<string>
	  }>
	| Readonly<{ kind: "fault"; fault: Fault }>

const runOf: Gen<Run> = (source) =>
	boolean(source) && boolean(source)
		? {
				kind: "fault",
				fault: element<Fault>(["the required parameter missing", "text that is not JSON"])(source)
			}
		: {
				kind: "values",
				coordinates: object(source),
				tags: option(array(word, { min: 0, max: 3 }))(source),
				trace: option(plain)(source),
				cookie: option(plain)(source)
			}

/** A run's arguments after the command. */
const argsOf = (r: Run): ReadonlyArray<string> => {
	switch (r.kind) {
		case "values":
			return Arr.flatten([
				["--coordinates", jsonTextOf(r.coordinates)],
				Option.match(r.tags, { onNone: () => [], onSome: (tags) => ["--tags", jsonTextOf(tags)] }),
				Option.match(r.trace, { onNone: () => [], onSome: (trace) => ["--x-trace", trace] }),
				Option.match(r.cookie, { onNone: () => [], onSome: (cookie) => ["--c", cookie] })
			])
		case "fault":
			return r.fault === "the required parameter missing" ? [] : ["--coordinates", "{not json"]
	}
}

/** What a request carried, as the oracle compares it: each query parameter's JSON, the header and the cookie. */
type Carried = Readonly<{
	coordinates: ReadonlyArray<Schema.Json>
	tags: ReadonlyArray<Schema.Json>
	trace: ReadonlyArray<string>
	cookie: ReadonlyArray<string>
}>

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

/** The JSON each value of a query parameter holds. */
const jsonValues = (pairs: ReadonlyArray<Pair>, name: string) =>
	Effect.forEach(
		Arr.flatMap(pairs, ([key, value]) => (key === name ? [value] : [])),
		(value) => decodeJson(value)
	)

/** What a recorded request carried. */
const carriedOf = (request: WireRequest) =>
	Effect.gen(function* () {
		const pairs = queryPairs(request.target)
		const carried: Carried = {
			coordinates: yield* jsonValues(pairs, "coordinates"),
			tags: yield* jsonValues(pairs, "tags"),
			trace: valuesOf(request.headers, "x-trace"),
			cookie: valuesOf(request.headers, "cookie")
		}
		return carried
	})

/** What the oracle compares of a run. */
type Outcome = Readonly<{ exitCode: number; connections: number; requests: ReadonlyArray<Carried> }>

/** The run the contract gives: one request carrying each value given in its place, or none for a fault. */
const expectedOf = (r: Run): Outcome => {
	switch (r.kind) {
		case "values":
			return {
				exitCode: 0,
				connections: 1,
				requests: [
					{
						coordinates: [r.coordinates],
						tags: Option.match(r.tags, { onNone: () => [], onSome: (tags) => [tags] }),
						trace: Option.toArray(r.trace),
						cookie: Option.match(r.cookie, {
							onNone: () => [],
							onSome: (cookie) => [`c=${cookie}`]
						})
					}
				]
			}
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

type ContentFeature =
	| Fault
	| "an empty object"
	| "a nested value"
	| "an array given"
	| "an empty array"
	| "a header given"
	| "a cookie given"
	| "text past ASCII"

/** A feature when it holds, none otherwise. */
const when = <F extends string>(holds: boolean, feature: F): ReadonlyArray<F> =>
	holds ? [feature] : []

/** The features a run reaches. */
const runFeatures = (r: Run): ReadonlyArray<ContentFeature> => {
	if (r.kind === "fault") {
		return [r.fault]
	}
	const coordinates = jsonTextOf(r.coordinates)
	return Arr.flatten<ReadonlyArray<ReadonlyArray<ContentFeature>>>([
		when(coordinates === "{}", "an empty object"),
		when(Str.includes("{")(Str.slice(1)(coordinates)), "a nested value"),
		when(Option.isSome(r.tags), "an array given"),
		when(Option.exists(r.tags, Arr.isReadonlyArrayEmpty), "an empty array"),
		when(Option.isSome(r.trace), "a header given"),
		when(Option.isSome(r.cookie), "a cookie given"),
		when(Str.includes("é")(Arr.join(argsOf(r), " ")), "text past ASCII")
	])
}

/** The suite's fixture: the capture server, the package built against it, and its command. */
class ContentFixture extends Context.Service<
	ContentFixture,
	Readonly<{ server: CaptureServer; built: BuiltPackage; command: ReadonlyArray<string> }>
>()("effect-openapi-cli-generator/test/generated/content-parameters.test/ContentFixture") {}

const fixture = Layer.effect(
	ContentFixture,
	Effect.gen(function* () {
		const server = yield* captureServer
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins["127.0.0.1"]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const name = yield* Effect.fromOption(
			Arr.findFirst(
				generated.result.report.commandNames,
				(entry) => entry.pointer === "/paths/~1notes/get"
			)
		)
		return { server, built, command: name.path }
	})
).pipe(Layer.provideMerge(harnessLayer))

/** The flags whose content is JSON. */
const JSON_FLAGS: ReadonlyArray<string> = ["--coordinates", "--tags"]

layer(fixture, { excludeTestServices: true })("a generated CLI's content parameters", (it) => {
	it.effect("show json as the value of each JSON content flag in --help", () =>
		Effect.gen(function* () {
			const { built, command } = yield* ContentFixture
			const help = yield* runBin(built, {
				args: Arr.append(command, "--help"),
				env: {},
				stdin: new Uint8Array(0)
			})
			const text = Buffer.from(help.stdout).toString("utf8")
			deepStrictEqual<Readonly<{ exitCode: number; shown: ReadonlyArray<Option.Option<string>> }>>(
				{ exitCode: help.exitCode, shown: Arr.map(JSON_FLAGS, (flag) => metavarOf(text, flag)) },
				{ exitCode: 0, shown: Arr.map(JSON_FLAGS, () => Option.some("json")) },
				"a JSON content flag takes json"
			)
		})
	)

	it.effect(
		"carry their media type's encoding of the value given, and nothing for a fault",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { server, built, command } = yield* ContentFixture
					return yield* explore(
						{
							suite: "content parameters",
							draw: drawn(runOf),
							literal: Formatter.format,
							coverage: required<ContentFeature>(
								[
									"the required parameter missing",
									"text that is not JSON",
									"an empty object",
									"a nested value",
									"an array given",
									"an empty array",
									"a header given",
									"a cookie given",
									"text past ASCII"
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
								const observed = yield* server.observe(
									() => done,
									runBin(built, {
										args: Arr.flatten([
											command,
											["--base-url", server.origins["127.0.0.1"]],
											argsOf(r)
										]),
										env: {},
										stdin: new Uint8Array(0)
									})
								)
								const requests = yield* Effect.forEach(observed.requests, carriedOf)
								deepStrictEqual<Outcome>(
									{
										exitCode: observed.result.exitCode,
										connections: observed.connections.length,
										requests
									},
									expectedOf(r),
									"each content parameter carries its media type's encoding of the value given"
								)
							})
					)
				})
			)
	)
})
