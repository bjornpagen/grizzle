import { boolean, element, type Gen, oneOf, shuffled, type Space } from "@bjornpagen/testing/gen"
import { jsonTextOf } from "@superstarter/json"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Console,
	Effect,
	Exit,
	Function as Fn,
	Layer,
	Option,
	Runtime,
	Schema,
	Sink,
	Stdio,
	Stream,
	Record,
	String as Str
} from "effect"
import { CliOutput, Command, Flag } from "effect/cli"
import type { HttpBody } from "effect/http"
import * as Input from "#runtime-src/runtime/input.ts"
import * as Output from "#runtime-src/runtime/output.ts"
import { runCredentialsLayer } from "#runtime-src/runtime/redact.ts"
import * as Serialize from "#runtime-src/runtime/serialize.ts"

/** The kinds of flag the emitter writes for a field whose value the runtime checks, labels or reads from a file. */
export type FlagKind =
	| "an integer field"
	| "a number field"
	| "an int64 field"
	| "a secret-file field"
	| "a secret part"
	| "a number part"
	| "a deepObject JSON flag"

/** What a case notes beside its kind. */
export type Feature =
	| FlagKind
	| "a text the grammar refuses"
	| "an integer text the grammar refuses"
	| "a number's digits past a double's precision"
	| "a described secret"

/**
 * One field flag and what the operator gives it: a numeric field's flag name and the text after it, a secret's flag
 * name and the property's description, or a multipart number part's text.
 */
export type FlagCase =
	| Readonly<{ kind: "integer" | "number" | "int64"; name: string; text: string }>
	| Readonly<{
			kind: "secret-file" | "secret-part"
			name: string
			description: Option.Option<string>
	  }>
	| Readonly<{ kind: "number-part"; text: string }>
	| Readonly<{ kind: "deep-json"; name: string; entries: ReadonlyArray<readonly [string, string]> }>

/** The JSON grammar of an integer (RFC 8259 int), the reference a numeric text is checked against. */
const integerText = regex("^-?(?:0|[1-9][0-9]*)$", "u")

/** The JSON grammar of a number (RFC 8259 number). */
const numberText = regex("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$", "u")

/** Whether the JSON grammar of `kind` admits `text`: an int64 is an integer's digits. */
export const admits = (kind: "integer" | "number" | "int64", text: string): boolean =>
	kind === "number" ? numberText.test(text) : integerText.test(text)

/**
 * A numeric text built from a sign, integer digits, a fraction and an exponent, each part drawn from the forms the
 * grammar admits and the near misses it refuses (a plus sign, a leading zero, a bare point, a bare exponent), so the
 * texts reach both sides of the grammar and the digits past a double's precision.
 */
const numericTextGen: Gen<string> = (s) =>
	Arr.join(
		[
			s.draw(element(["", "-", "+"])),
			s.draw(element(["0", "7", "42", "9007199254740993", "01", ""])),
			s.draw(element(["", ".5", ".10000000000000000001", ".", ".0"])),
			s.draw(element(["", "e2", "E-7", "e+3", "e"]))
		],
		""
	)

const FIELD_NAMES: Arr.NonEmptyReadonlyArray<string> = ["count", "ratio", "total", "size"]

const SECRET_NAMES: Arr.NonEmptyReadonlyArray<string> = ["password-file", "secret", "token-file"]

const DESCRIPTIONS: Arr.NonEmptyReadonlyArray<string> = [
	"The account password.",
	"Read from the vault.",
	"Rotated each month"
]

/** The flag cases: every kind, its name and text or description drawn. */
export const caseGen: Gen<FlagCase> = oneOf<FlagCase>([
	(s) => ({
		kind: s.draw(element<"integer" | "number" | "int64">(["integer", "number", "int64"])),
		name: s.draw(element(FIELD_NAMES)),
		text: s.draw(numericTextGen)
	}),
	(s) => ({
		kind: s.draw(element<"secret-file" | "secret-part">(["secret-file", "secret-part"])),
		name: s.draw(element(SECRET_NAMES)),
		description: s.draw(boolean) ? Option.some(s.draw(element(DESCRIPTIONS))) : Option.none()
	}),
	(s) => ({
		kind: "deep-json",
		name: s.draw(element(["window", "created", "span"])),
		entries: Arr.map(s.draw(shuffled(["at", "gt", "lt"], { min: 1, max: 3 })), (key) => [
			key,
			s.draw(element(["v", "a b", "é", "1"]))
		])
	}),
	(s) => ({
		kind: "number-part",
		text: s.draw(element(["0.10000000000000000001", "9007199254740993", "-7", "1.5e300", "0"]))
	})
])

/** Whether a text holds more digits than a double keeps. */
const pastPrecision = (text: string): boolean =>
	Str.includes("9007199254740993")(text) || Str.includes("10000000000000000001")(text)

/** The kind a case reaches, and its variants. */
export const featuresOf = (drawnCase: FlagCase): ReadonlyArray<Feature> => {
	switch (drawnCase.kind) {
		case "integer":
		case "number":
		case "int64": {
			const refused = !admits(drawnCase.kind, drawnCase.text)
			return [
				drawnCase.kind === "integer"
					? "an integer field"
					: drawnCase.kind === "number"
						? "a number field"
						: "an int64 field",
				...(refused ? (["a text the grammar refuses"] as const) : []),
				...(refused && drawnCase.kind === "integer"
					? (["an integer text the grammar refuses"] as const)
					: []),
				...(!refused && drawnCase.kind === "number" && pastPrecision(drawnCase.text)
					? (["a number's digits past a double's precision"] as const)
					: [])
			]
		}
		case "secret-file":
		case "secret-part":
			return [
				drawnCase.kind === "secret-file" ? "a secret-file field" : "a secret part",
				...(Option.isSome(drawnCase.description) ? (["a described secret"] as const) : [])
			]
		case "number-part":
			return ["a number part"]
		case "deep-json":
			return ["a deepObject JSON flag"]
	}
}

/**
 * The aims of the flag cases: an integer field given an exponent or a fraction, which the integer grammar refuses, and
 * a number field given more digits than a double keeps, which reach the body as given.
 */
export const AIMS: ReadonlyArray<readonly [Feature, Space<FlagCase>]> = [
	[
		"an integer text the grammar refuses",
		(s) => ({
			kind: "integer",
			name: s.draw(element(FIELD_NAMES)),
			text: s.draw(element(["1e2", "1.0", "-0.5", "+1", "01"]))
		})
	],
	[
		"a number's digits past a double's precision",
		(s) => ({
			kind: "number",
			name: s.draw(element(FIELD_NAMES)),
			text: s.draw(element(["0.10000000000000000001", "-9007199254740993", "9007199254740993e2"]))
		})
	]
]

/** The flag the emitter writes for a numeric field, carried as a JsonNumber as the emitted command carries it. */
const numericFieldFlag = (kind: "integer" | "number" | "int64", name: string) =>
	kind === "int64"
		? Input.int64Flag(name).pipe(Flag.optional)
		: Input.numericFlag(name, kind).pipe(
				Flag.map((text) => new Input.JsonNumber(text)),
				Flag.optional
			)

const decoder = new TextDecoder()

const bodyText = (body: HttpBody.HttpBody): string =>
	body._tag === "Uint8Array" ? decoder.decode(body.body) : ""

/** A console that prints nothing; Object.assign keeps the host console's methods, which spreading would drop. */
const silent: Console.Console = Object.assign({}, globalThis.console, {
	error: Fn.constVoid,
	log: Fn.constVoid
})

/** A run of a generated command in process: its exit code, what it printed, and each JSON body it merged. */
type Ran = Readonly<{ code: number; printed: string; sent: ReadonlyArray<string> }>

/**
 * Runs `create` with its one field flag on `args` the way a generated command runs: the parsed value merged into the
 * JSON body as the field at `/<name>`, with the runtime's output, credential and stdin services and a console that
 * records what help prints.
 */
const runNumeric = (
	kind: "integer" | "number" | "int64",
	name: string,
	args: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const sent: Array<string> = []
		const printed: Array<string> = []
		const recording: Console.Console = Object.assign({}, silent, {
			log: (...parts: ReadonlyArray<unknown>) => {
				printed.push(Arr.join(Arr.map(parts, String), " "))
			}
		})
		const command = Command.make("create", { field: numericFieldFlag(kind, name) }, (flags) =>
			Input.mergeBody({
				constants: {},
				body: Option.none(),
				bodyFile: Option.none(),
				fields: { [`/${name}`]: flags.field },
				required: true,
				schema: Schema.Struct({ [name]: Schema.optionalKey(Schema.Finite) })
			}).pipe(Effect.flatMap((body) => Effect.sync(() => sent.push(bodyText(body)))))
		)
		return yield* ranWith(
			Command.runWith(command, { renderErrors: false, version: "0" })(args),
			recording,
			() => ({ printed, sent })
		)
	})

/** `--help` of `create` whose one flag is `flag`, run as `runNumeric` runs a command. */
const helpOf = <A>(flag: Flag.Flag<A>) =>
	Effect.gen(function* () {
		const printed: Array<string> = []
		const recording: Console.Console = Object.assign({}, silent, {
			log: (...parts: ReadonlyArray<unknown>) => {
				printed.push(Arr.join(Arr.map(parts, String), " "))
			}
		})
		const command = Command.make("create", { flag }, () => Effect.void)
		return yield* ranWith(
			Command.runWith(command, { renderErrors: false, version: "0" })(["--help"]),
			recording,
			() => ({ printed, sent: [] })
		)
	})

/** The runtime services a generated command runs on, built for one run. */
const runServices = Layer.mergeAll(
	Stdio.layerTest({ stderr: () => Sink.drain, stdout: () => Sink.drain }),
	runCredentialsLayer,
	Input.stdinClaimLayer,
	CliOutput.layer(Output.valueFreeFormatter),
	CliOutput.layerPresenter(Output.presenter)
)

/**
 * Runs a command's parse and handler as a generated CLI's entry runs it (help exits 0, failures render through the
 * runtime's final catch), on the runtime's services built for this run and the recording console, and gives its exit
 * code, what it printed and what it sent.
 */
const ranWith = <E, R>(
	program: Effect.Effect<void, E, R>,
	recording: Console.Console,
	recorded: () => Readonly<{ printed: ReadonlyArray<string>; sent: ReadonlyArray<string> }>
) =>
	Effect.gen(function* () {
		const services = yield* Layer.build(runServices)
		const exit = yield* Effect.exit(
			Effect.provideService(
				Effect.provideContext(program.pipe(Output.exitForHelp, Output.finalCatch([])), services),
				Console.Console,
				recording
			)
		)
		const { printed, sent } = recorded()
		const ran: Ran = {
			code: Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause)),
			printed: Str.replace(whiteSpace, " ")(Arr.join(printed, "\n")),
			sent
		}
		return ran
	})

const whiteSpace = regex("\\s+", "gu")

/** A numeric field's run on `--<name> <text>`, and its help. */
export const numericRuns = (kind: "integer" | "number" | "int64", name: string, text: string) =>
	Effect.all({
		given: runNumeric(kind, name, [`--${name}`, text]),
		help: runNumeric(kind, name, ["--help"])
	})

/** The help of a secret flag of `kind` named `name` with `description`. */
export const secretHelp = (
	kind: "secret-file" | "secret-part",
	name: string,
	description: Option.Option<string>
) =>
	kind === "secret-file"
		? helpOf(Input.secretFileFlag(name, description))
		: helpOf(Input.secretPartFlag(name, description).pipe(Flag.optional))

/** The note a secret flag's help ends with. */
export const SECRET_NOTE = "Read the value from a file or stdin (-); it is never echoed"

/** The bytes a multipart body sends for a number part `ratio` holding `text`. */
export const numberPartSent = (text: string) =>
	Effect.gen(function* () {
		const fields = yield* Serialize.assertFormData({
			flags: { ratio: "ratio" },
			repeated: [],
			required: true,
			schema: Schema.Struct({ ratio: Schema.Finite })
		})({ ratio: [new Input.JsonNumber(text)] })
		const built = yield* Serialize.request("POST", {
			body: Serialize.formData(fields, { parts: [["ratio", "text/plain"]], required: true }),
			headers: [],
			path: Serialize.path("/items", []),
			query: []
		})
		const chunks =
			built.body._tag === "Stream" ? yield* Stream.runCollect(Stream.orDie(built.body.stream)) : []
		return decoder.decode(Buffer.concat(Arr.map(chunks, (chunk) => Buffer.from(chunk))))
	})

/**
 * What a deepObject parameter's JSON flag sends for an object of string members: each member as
 * `<name>[<key>]=<value>`, every part percent-encoded as RFC 3986 encodes a query component, joined by `&` in member
 * order (OAS deepObject, explode true).
 */
export const deepObjectQuery = (
	name: string,
	entries: ReadonlyArray<readonly [string, string]>
): string =>
	Arr.join(
		Arr.map(
			entries,
			([key, value]) =>
				`${encodeURIComponent(name)}%5B${encodeURIComponent(key)}%5D=${encodeURIComponent(value)}`
		),
		"&"
	)

/** The JSON text of an object of `entries`. */
export const objectText = (entries: ReadonlyArray<readonly [string, string]>): string =>
	jsonTextOf(Record.fromEntries(entries))

/**
 * Runs `x` with the JSON flag the emitter writes for a deepObject parameter `name` on `text`, the parsed value handed
 * to the runtime's deepObject serializer as the generated command hands it on, and gives the query each run sent.
 */
export const deepObjectSent = (name: string, text: string) =>
	Effect.gen(function* () {
		const sent: Array<string> = []
		const command = Command.make("x", { value: Input.jsonFlag(name) }, ({ value }) =>
			Effect.map(
				Serialize.deepObject(name, value, { allowReserved: false, explode: true, required: false })
					.expand,
				(query) => {
					sent.push(query ?? "")
				}
			)
		)
		yield* Command.runWith(command, { version: "0" })([`--${name}`, text])
		return sent
	})
