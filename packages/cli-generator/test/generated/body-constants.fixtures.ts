import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
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
import { Array as Arr, Duration, Effect, Option } from "effect"
import type { Json } from "#model/pointer.ts"
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

/** What the body-constants properties (body-constants.test.ts) draw and their fixture: the runs of the one POST. */

/** The body's members that admit one value, by RFC 6901 pointer, each with that value. */
const CONSTANTS: ReadonlyArray<readonly [string, Json]> = [
	["/kind", "widget"],
	["/version", 2],
	["/flag", true],
	["/none", null],
	["/one", "only"],
	["/empty", {}],
	["/pinned", { a: 1, b: "x" }],
	["/meta/tag", "t"]
]

/** The one POST: a JSON body holding every form a member may take. */
const spec = jsonText({
	openapi: "3.2.0",
	info: { title: "Body constants", version: "1.0.0" },
	paths: {
		"/c": {
			post: {
				operationId: "create",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								additionalProperties: false,
								required: [
									"kind",
									"version",
									"flag",
									"none",
									"one",
									"empty",
									"pinned",
									"meta",
									"name",
									"count"
								],
								properties: {
									kind: { const: "widget" },
									version: { const: 2 },
									flag: { const: true },
									none: { const: null },
									one: { enum: ["only"] },
									empty: { type: "object", properties: {}, additionalProperties: false },
									pinned: {
										type: "object",
										properties: { a: { const: 1 }, b: { enum: ["x"] } },
										required: ["a", "b"],
										additionalProperties: false
									},
									meta: {
										type: "object",
										properties: { tag: { const: "t" }, note: { type: "string" } },
										required: ["tag", "note"],
										additionalProperties: false
									},
									name: { type: "string", pattern: "^[a-z]*$", allOf: [{ pattern: "^.{0,8}$" }] },
									count: { type: "integer" },
									chosen: { const: "opt" }
								}
							}
						}
					}
				},
				responses: { "200": { description: "Done." } }
			}
		}
	}
})

/** The author config, binding the capture server's origin. */
const configOf = (bound: string): string =>
	jsonText({
		package: { name: "body-constants", version: "1.0.0" },
		binName: "constants",
		envPrefix: "CONSTANTS",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** The optional constant's flag: absent, its one value, or another. */
type Chosen = "absent" | "its value" | "another value"

/** A run by field flags, each member given or not. */
type Fields = Readonly<{
	kind: "fields"
	name: Option.Option<string>
	count: Option.Option<number>
	note: Option.Option<string>
	chosen: Chosen
}>

/** A run by a whole body, with the constants or without them. */
type Whole = Readonly<{
	kind: "whole"
	name: string
	count: number
	note: string
	withConstants: boolean
}>

/** One run: by field flags or by a whole body, each member given or not. */
export type Run = Fields | Whole

const text: Gen<string> = string(characterOf(["a", "b", "z"]), { min: 0, max: 8 })

const CHOICES: Arr.NonEmptyReadonlyArray<Chosen> = ["absent", "its value", "another value"]

/** A run by field flags, each member drawn from its own generator. */
const fieldsOf =
	(
		parts: Readonly<{
			name: Gen<Option.Option<string>>
			count: Gen<Option.Option<number>>
			note: Gen<Option.Option<string>>
			chosen: Gen<Chosen>
		}>
	): Gen<Run> =>
	(source) => ({
		kind: "fields",
		name: source.draw(parts.name),
		count: source.draw(parts.count),
		note: source.draw(parts.note),
		chosen: source.draw(parts.chosen)
	})

/** A run by a whole body, with its constants as `withConstants` draws. */
const wholeOf =
	(withConstants: Gen<boolean>): Gen<Run> =>
	(source) => ({
		kind: "whole",
		name: source.draw(text),
		count: source.draw(int(-3, 3)),
		note: source.draw(text),
		withConstants: source.draw(withConstants)
	})

/** Every field flag drawn given or not. */
const anyFields = {
	name: option(text),
	count: option(int(-3, 3)),
	note: option(text),
	chosen: element(CHOICES)
} as const

/** Every required field flag given, the optional constant as `chosen` draws. */
const givenFields = (chosen: Gen<Chosen>) =>
	fieldsOf({
		name: map(text, Option.some),
		count: map(int(-3, 3), Option.some),
		note: map(text, Option.some),
		chosen
	})

/** A run as the suite drew it before its conversion: by field flags or by a whole body, each half the time. */
const runOf: Gen<Run> = (source) =>
	source.draw(boolean) ? source.draw(fieldsOf(anyFields)) : source.draw(wholeOf(boolean))

/** The body holding every constant, the meta object's note beside its tag. */
const constantsWith = (note: string): Readonly<Record<string, Json>> => ({
	kind: "widget",
	version: 2,
	flag: true,
	none: null,
	one: "only",
	empty: {},
	pinned: { a: 1, b: "x" },
	meta: { tag: "t", note }
})

/** The arguments of a run after its command and base URL. */
export const argsOf = (r: Run): ReadonlyArray<string> => {
	if (r.kind === "whole") {
		const members = { name: r.name, count: r.count }
		const body = r.withConstants
			? { ...constantsWith(r.note), ...members }
			: { ...members, meta: { tag: "t", note: r.note } }
		return [`--body=${jsonText(body)}`]
	}
	return [
		...Option.match(r.name, { onNone: () => [], onSome: (name) => [`--name=${name}`] }),
		...Option.match(r.count, { onNone: () => [], onSome: (count) => [`--count=${String(count)}`] }),
		...Option.match(r.note, { onNone: () => [], onSome: (note) => [`--meta.note=${note}`] }),
		...(r.chosen === "absent"
			? []
			: [`--chosen=${jsonText(r.chosen === "its value" ? "opt" : "other")}`])
	]
}

/** What a run should do: send this body, or refuse before any connection. */
export type Expected = Readonly<{ kind: "sent"; body: Json }> | Readonly<{ kind: "refused" }>

export const expectedOf = (r: Run): Expected => {
	if (r.kind === "whole") {
		return r.withConstants
			? { kind: "sent", body: { ...constantsWith(r.note), name: r.name, count: r.count } }
			: { kind: "refused" }
	}
	if (
		Option.isNone(r.name) ||
		Option.isNone(r.count) ||
		Option.isNone(r.note) ||
		r.chosen === "another value"
	) {
		return { kind: "refused" }
	}
	return {
		kind: "sent",
		body: {
			...constantsWith(r.note.value),
			name: r.name.value,
			count: r.count.value,
			...(r.chosen === "its value" ? { chosen: "opt" } : {})
		}
	}
}

/** An empty `200`. */
export const done: ScriptedResponse = {
	status: 200,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

export type ConstantFeature =
	| "a body built from field flags"
	| "a whole body sent as given"
	| "a whole body without its constants refused"
	| "a missing required flag refused"
	| "an optional constant given"
	| "an optional constant left out"
	| "an optional constant given another value refused"

export const featuresOf = (r: Run, expected: Expected): ReadonlyArray<ConstantFeature> => {
	if (r.kind === "whole") {
		return [
			r.withConstants ? "a whole body sent as given" : "a whole body without its constants refused"
		]
	}
	const missing = Option.isNone(r.name) || Option.isNone(r.count) || Option.isNone(r.note)
	return Arr.flatten<ReadonlyArray<ReadonlyArray<ConstantFeature>>>([
		expected.kind === "sent" ? ["a body built from field flags"] : [],
		missing ? ["a missing required flag refused"] : [],
		!missing && r.chosen === "its value" ? ["an optional constant given"] : [],
		!missing && r.chosen === "absent" ? ["an optional constant left out"] : [],
		!missing && r.chosen === "another value"
			? ["an optional constant given another value refused"]
			: []
	])
}

/** Every feature the search must reach, in its suite's order. */
export const FEATURES: Arr.NonEmptyReadonlyArray<ConstantFeature> = [
	"a body built from field flags",
	"a whole body sent as given",
	"a whole body without its constants refused",
	"a missing required flag refused",
	"an optional constant given",
	"an optional constant left out",
	"an optional constant given another value refused"
]

/** The run a focus draws: one made to reach that feature, every other choice drawn at random. */
const caseFor = (focus: ConstantFeature): Gen<Run> => {
	switch (focus) {
		case "a body built from field flags":
			return givenFields(element<Chosen>(["absent", "its value"]))
		case "a whole body sent as given":
			return wholeOf(constant(true))
		case "a whole body without its constants refused":
			return wholeOf(constant(false))
		case "a missing required flag refused":
			return fieldsOf({ ...anyFields, name: constant(Option.none()) })
		case "an optional constant given":
			return givenFields(constant<Chosen>("its value"))
		case "an optional constant left out":
			return givenFields(constant<Chosen>("absent"))
		case "an optional constant given another value refused":
			return givenFields(constant<Chosen>("another value"))
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

/** The CONSTANTS line `--help` prints for the body's constants, in the order the body declares them. */
export const constantsLine = Arr.join(
	Arr.map(CONSTANTS, ([pointer, value]) => `body ${pointer} = ${jsonText(value)}`),
	"; "
)

/** The one help page the box holds: the command's own. */
export const helpPage: FiniteSpace<"--help"> = finite(constant("--help"))

/** The suite's fixture, once per worker: the capture server, the package built against it, and its one command. */
export const constantsFixture = workerFixture(
	"test/generated/body-constants.fixtures.ts constantsFixture",
	Effect.gen(function* () {
		const server = yield* captureServer
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins["127.0.0.1"]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const command = yield* Effect.fromOption(
			Option.map(Arr.head(generated.result.report.commandNames), (name) => name.path)
		)
		const opened: Readonly<{
			server: CaptureServer
			built: BuiltPackage
			command: ReadonlyArray<string>
		}> = { server, built, command }
		return opened
	})
)
