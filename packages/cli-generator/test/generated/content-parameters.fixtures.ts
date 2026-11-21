import { jsonText, type Json } from "@bjornpagen/grizzle-text/utf8"
import { word } from "@bjornpagen/testing/dictionary"
import {
	aimed,
	array,
	boolean,
	characterOf,
	constant,
	element,
	finite,
	type FiniteSpace,
	type Gen,
	int,
	map,
	option,
	string
} from "@bjornpagen/testing/gen"
import { Array as Arr, Duration, Effect, Option, Record as Rec, String as Str } from "effect"
import { jsonContentFlags } from "#test/generated/content-parameters.dictionary.ts"
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
import { type Pair, queryPairs } from "#test/support/form.ts"
import { valuesOf, type WireRequest } from "#test/support/http.ts"
import { printedJson } from "#test/support/printed.ts"

/** What the content-parameters properties (content-parameters.test.ts) draw and their fixture: the runs and faults. */

/** One GET with a JSON object and a JSON array in the query, a text header and a text cookie, each by `content`. */
const spec = jsonText({
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
	jsonText({
		package: { name: "content-parameters", version: "1.0.0" },
		binName: "notes",
		envPrefix: "NOTES",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** Text with no space, plus sign or separator, which every place a value goes carries as written once decoded. */
const wordText: Gen<string> = string(characterOf(["a", "Z", "0", "-", "_", ".", "é"]), {
	min: 1,
	max: 5
})

/** Text a header and a cookie carry as written. */
const plain: Gen<string> = string(characterOf(["a", "Z", "0", "-", "_", "."]), { min: 1, max: 6 })

/** A JSON leaf: a word, a whole number or a boolean. */
const leaf: Gen<Json> = (source) => {
	switch (source.draw(element<"word" | "number" | "boolean">(["word", "number", "boolean"]))) {
		case "word":
			return source.draw(wordText)
		case "number":
			return source.draw(int(-1000, 1000))
		case "boolean":
			return source.draw(boolean)
	}
}

/** A JSON object whose members are drawn from `member`, under distinct short keys. */
const objectOf =
	(member: Gen<Json>): Gen<Readonly<Record<string, Json>>> =>
	(source) =>
		Rec.fromEntries(
			Arr.map(
				Arr.dedupe(
					source.draw(
						array(string(characterOf(["a", "b", "c"]), { min: 1, max: 3 }), { min: 0, max: 3 })
					)
				),
				(key): readonly [string, Json] => [key, source.draw(member)]
			)
		)

/** A JSON object of leaves and of objects of leaves. */
const object: Gen<Readonly<Record<string, Json>>> = objectOf((source) =>
	source.draw(boolean) ? source.draw(leaf) : source.draw(objectOf(leaf))
)

/** A fault planted in a run. */
type Fault = "the required parameter missing" | "text that is not JSON"

/** The values a run gives, each optional one given or not. */
type Values = Readonly<{
	kind: "values"
	coordinates: Readonly<Record<string, Json>>
	tags: Option.Option<ReadonlyArray<string>>
	trace: Option.Option<string>
	cookie: Option.Option<string>
}>

/** One run: the values given, or a planted fault. */
export type Run = Values | Readonly<{ kind: "fault"; fault: Fault }>

const FAULTS: Arr.NonEmptyReadonlyArray<Fault> = [
	"the required parameter missing",
	"text that is not JSON"
]

/** A planted fault drawn from `fault`. */
const planted =
	(fault: Gen<Fault>): Gen<Run> =>
	(source) => ({ kind: "fault", fault: source.draw(fault) })

/** The values a run gives, each part drawn from its own generator. */
const givenOf =
	(
		parts: Readonly<{
			coordinates: Gen<Readonly<Record<string, Json>>>
			tags: Gen<Option.Option<ReadonlyArray<string>>>
			trace: Gen<Option.Option<string>>
			cookie: Gen<Option.Option<string>>
		}>
	): Gen<Run> =>
	(source) => ({
		kind: "values",
		coordinates: source.draw(parts.coordinates),
		tags: source.draw(parts.tags),
		trace: source.draw(parts.trace),
		cookie: source.draw(parts.cookie)
	})

/** Every part of the values drawn at random. */
const anyValues = {
	coordinates: object,
	tags: option(array(wordText, { min: 0, max: 3 })),
	trace: option(plain),
	cookie: option(plain)
} as const

/** A run as the suite drew it before its conversion: a planted fault a quarter of the time, else values. */
const runOf: Gen<Run> = (source) =>
	source.draw(boolean) && source.draw(boolean)
		? source.draw(planted(element(FAULTS)))
		: source.draw(givenOf(anyValues))

/** A run's arguments after the command. */
export const argsOf = (r: Run): ReadonlyArray<string> => {
	switch (r.kind) {
		case "values":
			return Arr.flatten([
				[`--coordinates=${jsonText(r.coordinates)}`],
				Option.match(r.tags, {
					onNone: () => [],
					onSome: (tags) => [`--tags=${jsonText(tags)}`]
				}),
				Option.match(r.trace, { onNone: () => [], onSome: (trace) => [`--x-trace=${trace}`] }),
				Option.match(r.cookie, { onNone: () => [], onSome: (cookie) => [`--c=${cookie}`] })
			])
		case "fault":
			return r.fault === "the required parameter missing" ? [] : ["--coordinates", "{not json"]
	}
}

/**
 * What a request carried, as the oracle compares it: the JSON each value of a query parameter holds, none for a value
 * that is no JSON text; the header and the cookie.
 */
type Carried = Readonly<{
	coordinates: ReadonlyArray<Option.Option<Json>>
	tags: ReadonlyArray<Option.Option<Json>>
	trace: ReadonlyArray<string>
	cookie: ReadonlyArray<string>
}>

/** The JSON each value of a query parameter holds. */
const jsonValues = (pairs: ReadonlyArray<Pair>, name: string): ReadonlyArray<Option.Option<Json>> =>
	Arr.flatMap(pairs, ([key, value]) => (key === name ? [printedJson(value)] : []))

/** What a recorded request carried. */
export const carriedOf = (request: WireRequest): Carried => {
	const pairs = queryPairs(request.target)
	return {
		coordinates: jsonValues(pairs, "coordinates"),
		tags: jsonValues(pairs, "tags"),
		trace: valuesOf(request.headers, "x-trace"),
		cookie: valuesOf(request.headers, "cookie")
	}
}

/** What the oracle compares of a run. */
export type Outcome = Readonly<{
	exitCode: number
	connections: number
	requests: ReadonlyArray<Carried>
}>

/** The run the contract gives: one request carrying each value given in its place, or none for a fault. */
export const expectedOf = (r: Run): Outcome => {
	switch (r.kind) {
		case "values":
			return {
				exitCode: 0,
				connections: 1,
				requests: [
					{
						coordinates: [Option.some(r.coordinates)],
						tags: Option.match(r.tags, { onNone: () => [], onSome: (tags) => [Option.some(tags)] }),
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
export const done: ScriptedResponse = {
	status: 204,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

export type ContentFeature =
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
export const runFeatures = (r: Run): ReadonlyArray<ContentFeature> => {
	if (r.kind === "fault") {
		return [r.fault]
	}
	const coordinates = jsonText(r.coordinates)
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

/** Every feature the search must reach, in its suite's order. */
export const FEATURES: Arr.NonEmptyReadonlyArray<ContentFeature> = [
	...FAULTS,
	"an empty object",
	"a nested value",
	"an array given",
	"an empty array",
	"a header given",
	"a cookie given",
	"text past ASCII"
]

/** The run a focus draws: one made to reach that feature, every other choice drawn at random. */
const caseFor = (focus: ContentFeature): Gen<Run> => {
	switch (focus) {
		case "the required parameter missing":
		case "text that is not JSON":
			return planted(constant(focus))
		case "an empty object":
			return givenOf({ ...anyValues, coordinates: constant({}) })
		case "a nested value":
			return givenOf({
				...anyValues,
				coordinates: map(objectOf(leaf), (inner) => ({ a: inner, b: { c: true } }))
			})
		case "an array given":
			return givenOf({ ...anyValues, tags: map(array(wordText, { min: 0, max: 3 }), Option.some) })
		case "an empty array":
			return givenOf({ ...anyValues, tags: constant(Option.some([])) })
		case "a header given":
			return givenOf({ ...anyValues, trace: map(plain, Option.some) })
		case "a cookie given":
			return givenOf({ ...anyValues, cookie: map(plain, Option.some) })
		case "text past ASCII":
			return givenOf({ ...anyValues, tags: constant(Option.some(["é"])) })
	}
}

/**
 * The runs a case draws: the rotating stream's as the suite drew them (runOf); a case aimed at a required feature still
 * pending, from the run made to reach it (caseFor).
 */
export const runs = aimed(
	runOf,
	Arr.map(FEATURES, (feature) => [feature, caseFor(feature)] as const)
)

/** The flags whose content is JSON, each a case of the help property. */
export const jsonFlags: FiniteSpace<string> = finite(word(jsonContentFlags))

/** The suite's fixture, once per worker: the capture server, the package built against it, and its command. */
export const contentFixture = workerFixture(
	"test/generated/content-parameters.fixtures.ts contentFixture",
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
		const opened: Readonly<{
			server: CaptureServer
			built: BuiltPackage
			command: ReadonlyArray<string>
		}> = { server, built, command: name.path }
		return opened
	})
)
