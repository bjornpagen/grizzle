/**
 * A generated CLI sends a JSON body's members that admit one value itself, as it sends a constant parameter, and reads
 * every other member from its flags:
 *
 * - A required member whose schema admits exactly one value (a `const`, a one-member `enum`, or a closed object whose
 *   every member is required and admits one value, `{}` among them) has no flag; `--help` lists it under CONSTANTS as
 *   `body <pointer> = <JSON>`, and every request built from field flags holds it. A constant inside an object whose
 *   other members are flags is one too. An optional member that admits one value keeps its flag: sending it or not is
 *   the operator's choice.
 * - A string whose `allOf` members only refine it (a `pattern`) is a string flag, its value sent as a JSON string.
 * - `--body` is sent byte for byte as given: it is checked against the schema, constants included, so a whole body
 *   that leaves a constant out is refused (exit 2) before any connection, like a missing required field flag and an
 *   optional constant given another value.
 *
 * One package with one POST whose body holds each form. A property draws a run, by field flags or by a whole body,
 * each member given or not; the oracle is the schema's constants and the drawn values: the body that reached the
 * capture server, compared as JSON, or exit 2 and no request.
 *
 * Plants, each applied to the generator, seen to fail this suite and reverted: flatten.ts oneValue answering none (every
 * constant a flag again); input.ts mergeSources skipping the constants; flatten.ts shapes answering true for every
 * allOf member (the refined string a JSON flag).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import {
	boolean,
	characterOf,
	element,
	type Gen,
	int,
	option,
	string
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Formatter,
	Layer,
	Option,
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

/** The body's members that admit one value, by RFC 6901 pointer, each with that value. */
const CONSTANTS: ReadonlyArray<readonly [string, Schema.Json]> = [
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
const spec = jsonTextOf({
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
	jsonTextOf({
		package: { name: "body-constants", version: "1.0.0" },
		binName: "constants",
		envPrefix: "CONSTANTS",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** The optional constant's flag: absent, its one value, or another. */
type Chosen = "absent" | "its value" | "another value"

/** One run: by field flags or by a whole body, each member given or not. */
type Run =
	| Readonly<{
			kind: "fields"
			name: Option.Option<string>
			count: Option.Option<number>
			note: Option.Option<string>
			chosen: Chosen
	  }>
	| Readonly<{
			kind: "whole"
			name: string
			count: number
			note: string
			withConstants: boolean
	  }>

const word: Gen<string> = string(characterOf(["a", "b", "z"]), { min: 0, max: 8 })

const run: Gen<Run> = (source) =>
	boolean(source)
		? {
				kind: "fields",
				name: option(word)(source),
				count: option(int(-3, 3))(source),
				note: option(word)(source),
				chosen: element<Chosen>(["absent", "its value", "another value"])(source)
			}
		: {
				kind: "whole",
				name: word(source),
				count: int(-3, 3)(source),
				note: word(source),
				withConstants: boolean(source)
			}

/** The body holding every constant, the meta object's note beside its tag. */
const constantsWith = (note: string): Readonly<Record<string, Schema.Json>> => ({
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
const argsOf = (r: Run): ReadonlyArray<string> => {
	if (r.kind === "whole") {
		const members = { name: r.name, count: r.count }
		const body = r.withConstants
			? { ...constantsWith(r.note), ...members }
			: { ...members, meta: { tag: "t", note: r.note } }
		return [`--body=${jsonTextOf(body)}`]
	}
	return [
		...Option.match(r.name, { onNone: () => [], onSome: (name) => [`--name=${name}`] }),
		...Option.match(r.count, { onNone: () => [], onSome: (count) => [`--count=${String(count)}`] }),
		...Option.match(r.note, { onNone: () => [], onSome: (note) => [`--meta.note=${note}`] }),
		...(r.chosen === "absent"
			? []
			: [`--chosen=${jsonTextOf(r.chosen === "its value" ? "opt" : "other")}`])
	]
}

/** What a run should do: send this body, or refuse before any connection. */
type Expected = Readonly<{ kind: "sent"; body: Schema.Json }> | Readonly<{ kind: "refused" }>

const expectedOf = (r: Run): Expected => {
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

const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/** An empty `200`. */
const done: ScriptedResponse = {
	status: 200,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

/** The suite's fixture: the capture server, the package built against it, and its one command. */
class ConstantsFixture extends Context.Service<
	ConstantsFixture,
	Readonly<{ server: CaptureServer; built: BuiltPackage; command: ReadonlyArray<string> }>
>()("effect-openapi-cli-generator/test/generated/body-constants.test/ConstantsFixture") {}

const fixture = Layer.effect(
	ConstantsFixture,
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
		return { server, built, command }
	})
).pipe(Layer.provideMerge(harnessLayer))

type ConstantFeature =
	| "a body built from field flags"
	| "a whole body sent as given"
	| "a whole body without its constants refused"
	| "a missing required flag refused"
	| "an optional constant given"
	| "an optional constant left out"
	| "an optional constant given another value refused"

const featuresOf = (r: Run, expected: Expected): ReadonlyArray<ConstantFeature> => {
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

/** The CONSTANTS line `--help` prints for the body's constants, in the order the body declares them. */
const constantsLine = Arr.join(
	Arr.map(CONSTANTS, ([pointer, value]) => `body ${pointer} = ${jsonTextOf(value)}`),
	"; "
)

layer(fixture, { excludeTestServices: true })("a generated CLI's body constants", (it) => {
	it.effect(
		"have no flag and are listed under CONSTANTS, a refined string keeping its string flag",
		() =>
			Effect.gen(function* () {
				const { built, command } = yield* ConstantsFixture
				const help = yield* runBin(built, {
					args: [...command, "--help"],
					env: {},
					stdin: new Uint8Array(0)
				})
				const text = new TextDecoder().decode(help.stdout)
				const lines = Arr.map(Str.split("\n")(text), Str.trim)
				const flagNames = Arr.flatMap(lines, (line) =>
					Str.startsWith("--")(line) ? [Arr.headNonEmpty(Str.split(" ")(line))] : []
				)
				deepStrictEqual(
					{
						exitCode: help.exitCode,
						flags: Arr.sort(flagNames, Str.Order),
						nameIsString: Arr.some(lines, Str.startsWith("--name string")),
						constants: Arr.some(lines, Str.includes(constantsLine))
					},
					{
						exitCode: 0,
						flags: ["--body", "--body-file", "--chosen", "--count", "--meta.note", "--name"],
						nameIsString: true,
						constants: true
					}
				)
			})
	)

	it.effect(
		"are sent by every body built from field flags, and a whole body is sent as given",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { server, built, command } = yield* ConstantsFixture
					return yield* explore(
						{
							suite: "body constants",
							oracle: {
								kind: "specification",
								name: "the schema's constants and the drawn values: the body that reached the server, as JSON, or exit 2 and no request"
							},
							draw: drawn(run),
							literal: Formatter.format,
							coverage: required<ConstantFeature>(
								[
									"a body built from field flags",
									"a whole body sent as given",
									"a whole body without its constants refused",
									"a missing required flag refused",
									"an optional constant given",
									"an optional constant left out",
									"an optional constant given another value refused"
								],
								{ cases: 60, sense: notesOnly }
							),
							kept: [],
							runs: 30,
							shrink: { kind: "bounded", candidates: 40 },
							concurrency: 1,
							steerEvery: 10,
							caseHang: Duration.seconds(60)
						},
						(r, k) =>
							Effect.gen(function* () {
								const expected = expectedOf(r)
								k.noteAll(featuresOf(r, expected))
								const observed = yield* server.observe(
									() => done,
									runBin(built, {
										args: [...command, "--base-url", server.origins["127.0.0.1"], ...argsOf(r)],
										env: {},
										stdin: new Uint8Array(0)
									})
								)
								const bodies = yield* Effect.forEach(observed.requests, (request) =>
									decodeBody(new TextDecoder().decode(request.body))
								)
								deepStrictEqual(
									{ exitCode: observed.result.exitCode, bodies },
									expected.kind === "sent"
										? { exitCode: 0, bodies: [expected.body] }
										: { exitCode: 2, bodies: [] },
									"the body holds every constant and the drawn values, or the run is refused before any connection"
								)
							})
					)
				})
			)
	)
})
