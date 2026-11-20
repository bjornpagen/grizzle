/** What the properties of credentials.test.ts read: the credential worlds, requests and hosts they draw, and models. */

import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	subset,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Cause,
	ConfigProvider,
	Context,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	PlatformError,
	Predicate,
	Queue,
	Record,
	Redacted,
	Ref,
	Result,
	Runtime,
	Schema,
	Sink,
	Stdio,
	Stream,
	String as Str,
	Terminal
} from "effect"
import { TerminalCapabilities } from "effect/cli"
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/http"
import { operationHelp } from "#emit/help.ts"
import { Operation, SecurityScheme } from "#model/entities.ts"
import * as Auth from "#runtime-src/runtime/auth.ts"
import * as BaseUrl from "#runtime-src/runtime/base-url.ts"
import { Transport } from "#runtime-src/runtime/client.ts"
import * as Input from "#runtime-src/runtime/input.ts"
import * as Output from "#runtime-src/runtime/output.ts"
import { RunCredentials, type ScrubEntry } from "#runtime-src/runtime/redact.ts"
import * as Serialize from "#runtime-src/runtime/serialize.ts"
import { appendingTo, chunkText } from "#test/support/stdio.ts"

/** A scheme of the generated security table every credential case runs against. */
export type SchemeName =
	| "apiKey"
	| "basicAuth"
	| "bearerAuth"
	| "other"
	| "queryKey"
	| "sessionCookie"
	| "oauthAuth"
	| "oidcAuth"
	| "legacyKey"
	| "oddCookie"

const SCHEMES: Arr.NonEmptyReadonlyArray<SchemeName> = [
	"apiKey",
	"basicAuth",
	"bearerAuth",
	"other",
	"queryKey",
	"sessionCookie",
	"oauthAuth",
	"oidcAuth",
	"legacyKey",
	"oddCookie"
]

/** The emitted `api/security.ts` the cases run against. */
const TABLE: Auth.SecurityTable = {
	schemes: {
		apiKey: { in: "header", kind: "apiKey", name: "X-Key" },
		basicAuth: { kind: "http", scheme: "basic" },
		bearerAuth: { kind: "http", scheme: "bearer" },
		other: { env: "OTHER_TOKEN", kind: "http", scheme: "bearer" },
		queryKey: { in: "query", kind: "apiKey", name: "api_key" },
		sessionCookie: { in: "cookie", kind: "apiKey", name: "sid" },
		oauthAuth: { kind: "oauth2" },
		oidcAuth: { kind: "openIdConnect" },
		legacyKey: { deprecated: true, in: "header", kind: "apiKey", name: "X-Legacy" },
		oddCookie: { in: "cookie", kind: "apiKey", name: "a; admin=1" }
	}
}

/** Each scheme's names as design 4.4 derives them: its environment variable and its file flag. */
const NAMES: Readonly<Record<SchemeName, readonly [env: string, file: string]>> = {
	apiKey: ["EXAMPLE_API_KEY", "api-key-file"],
	basicAuth: ["EXAMPLE_BASIC_AUTH", "basic-auth-file"],
	bearerAuth: ["EXAMPLE_BEARER_AUTH", "bearer-auth-file"],
	other: ["OTHER_TOKEN", "other-file"],
	queryKey: ["EXAMPLE_QUERY_KEY", "query-key-file"],
	sessionCookie: ["EXAMPLE_SESSION_COOKIE", "session-cookie-file"],
	oauthAuth: ["EXAMPLE_OAUTH_AUTH", "oauth-auth-file"],
	oidcAuth: ["EXAMPLE_OIDC_AUTH", "oidc-auth-file"],
	legacyKey: ["EXAMPLE_LEGACY_KEY", "legacy-key-file"],
	oddCookie: ["EXAMPLE_ODD_COOKIE", "odd-cookie-file"]
}

const isScheme = (name: string): name is SchemeName => Arr.contains<string>(SCHEMES, name)

/** What a credential file holds: text, nothing readable, or bytes that are not UTF-8. */
export type FileContent =
	| Readonly<{ kind: "text"; text: string }>
	| Readonly<{ kind: "unreadable" }>
	| Readonly<{ kind: "notUtf8" }>

/** Where a scheme's credential is given: its variable and its file flag (a path, or `-` for stdin), each or none. */
export type Sources = Readonly<{
	env: Option.Option<string>
	file: Option.Option<"stdin" | FileContent>
}>

/** The operator's answer to the TTY prompt: typed text, or a quit. */
export type Answer = Readonly<{ kind: "typed"; text: string }> | Readonly<{ kind: "quit" }>

/** One evaluation: the operation's requirement, each scheme's sources, stdin and its holder, the terminal. */
export type World = Readonly<{
	requirement: ReadonlyArray<ReadonlyArray<string>>
	sources: ReadonlyArray<readonly [SchemeName, Sources]>
	stdin: string
	claimedByBody: boolean
	stdinTty: boolean
	stdoutTty: boolean
	answer: Answer
}>

const CHOICE_SCHEMES: Arr.NonEmptyReadonlyArray<SchemeName> = [
	"apiKey",
	"basicAuth",
	"bearerAuth",
	"other",
	"oauthAuth",
	"legacyKey"
]

const VALUES = [
	"s3cr3t-value",
	"key-value",
	"bearer-value",
	"from-env",
	"tok-AU1-SECRET",
	"user:pa55"
] as const

const value: Gen<string> = element(VALUES)

const fileContent: Gen<FileContent> = weighted<FileContent>([
	[
		6,
		map(
			oneOf([value, map(value, (text) => `${text}\n`), map(value, (text) => `${text}\r\n`)]),
			(text): FileContent => ({ kind: "text", text })
		)
	],
	[1, constant<FileContent>({ kind: "text", text: "\n" })],
	[1, constant<FileContent>({ kind: "unreadable" })],
	[1, constant<FileContent>({ kind: "notUtf8" })]
])

const sourcesOf: Gen<Sources> = (drawn) => ({
	env: weighted<Option.Option<string>>([
		[3, constant(Option.none())],
		[3, map(value, Option.some)],
		[1, constant(Option.some(""))]
	])(drawn),
	file: weighted<Option.Option<"stdin" | FileContent>>([
		[4, constant(Option.none())],
		[2, map(fileContent, (content): Option.Option<"stdin" | FileContent> => Option.some(content))],
		[1, constant(Option.some<"stdin" | FileContent>("stdin"))]
	])(drawn)
})

const alternative: Gen<ReadonlyArray<string>> = weighted<ReadonlyArray<string>>([
	[1, constant([])],
	[6, subset([...CHOICE_SCHEMES, "undeclared"], { min: 1, max: 2 })]
])

const world: Gen<World> = (drawn) => ({
	requirement: array(alternative, { min: 0, max: 3 })(drawn),
	sources: uniqueArray(
		element(CHOICE_SCHEMES),
		(scheme) => map(sourcesOf, (given) => [scheme, given] as const),
		{
			min: 0,
			max: 3
		}
	)(drawn),
	stdin: map(value, (text) => `${text}\n`)(drawn),
	claimedByBody: weighted<boolean>([
		[5, constant(false)],
		[1, constant(true)]
	])(drawn),
	stdinTty: boolean(drawn),
	stdoutTty: boolean(drawn),
	answer: weighted<Answer>([
		[
			5,
			map(element(["pr0mpt-s3cr3t", "typed-answer"]), (text): Answer => ({ kind: "typed", text }))
		],
		[1, constant<Answer>({ kind: "typed", text: "" })],
		[1, constant<Answer>({ kind: "quit" })]
	])(drawn)
})

const prompted: Gen<World> = map(world, (drawn) => ({
	...drawn,
	requirement: [["bearerAuth"]],
	sources: [],
	claimedByBody: false,
	stdinTty: true,
	stdoutTty: true
}))

/** A world whose one credential file, the bearer scheme's, holds `content`, which the choice refuses. */
const fileRefusedBy = (content: FileContent): Gen<World> =>
	constant<World>({
		requirement: [["bearerAuth"]],
		sources: [["bearerAuth", { env: Option.none(), file: Option.some(content) }]],
		stdin: "",
		claimedByBody: false,
		stdinTty: false,
		stdoutTty: false,
		answer: { kind: "typed", text: "" }
	})

/** Worlds, with constructed cases for the situations a plain draw reaches rarely. */
export const worlds = {
	space: world,
	prompted,
	quit: map(prompted, (drawn): World => ({ ...drawn, answer: { kind: "quit" } })),
	stdinBeforePrompt: map(prompted, (drawn): World => ({
		...drawn,
		requirement: [["bearerAuth", "apiKey"]],
		sources: [["apiKey", { env: Option.none(), file: Option.some("stdin") }]]
	})),
	twoStdin: map(world, (drawn): World => ({
		...drawn,
		requirement: [["apiKey", "bearerAuth"]],
		sources: [
			["apiKey", { env: Option.none(), file: Option.some("stdin") }],
			["bearerAuth", { env: Option.none(), file: Option.some("stdin") }]
		],
		claimedByBody: false
	})),
	bodyHoldsStdin: map(world, (drawn): World => ({
		...drawn,
		requirement: [["apiKey"]],
		sources: [["apiKey", { env: Option.none(), file: Option.some("stdin") }]],
		claimedByBody: true
	})),
	deprecatedChosen: map(world, (drawn): World => ({
		...drawn,
		requirement: [["legacyKey"], ["apiKey"]],
		sources: [["legacyKey", { env: Option.some("canary-credential-value"), file: Option.none() }]]
	})),
	andAlternative: map(world, (drawn): World => ({
		...drawn,
		requirement: [["apiKey", "bearerAuth"]],
		sources: [
			["apiKey", { env: Option.some("key-value"), file: Option.none() }],
			["bearerAuth", { env: Option.some("bearer-value"), file: Option.none() }]
		]
	})),
	fromStdin: map(world, (drawn): World => ({
		...drawn,
		requirement: [["apiKey"]],
		sources: [["apiKey", { env: Option.none(), file: Option.some("stdin") }]],
		claimedByBody: false
	})),
	emptyFile: fileRefusedBy({ kind: "text", text: "\n" }),
	unreadableFile: fileRefusedBy({ kind: "unreadable" }),
	notUtf8File: fileRefusedBy({ kind: "notUtf8" }),
	noRequirement: map(world, (drawn): World => ({ ...drawn, requirement: [] })),
	skippedAlternative: map(world, (drawn): World => ({
		...drawn,
		requirement: [["apiKey", "bearerAuth"], ["basicAuth"]],
		sources: [
			["apiKey", { env: Option.some("key-value"), file: Option.none() }],
			["basicAuth", { env: Option.some("user:pa55"), file: Option.none() }]
		]
	})),
	override: map(world, (drawn): World => ({
		...drawn,
		requirement: [["other"]],
		sources: [["other", { env: Option.some("s3cr3t-value"), file: Option.none() }]]
	})),
	emptyAnswer: map(prompted, (drawn): World => ({ ...drawn, answer: { kind: "typed", text: "" } })),
	fileBeatsEnv: map(fileContent, (content): World => ({
		requirement: [["bearerAuth"]],
		sources: [["bearerAuth", { env: Option.some("from-env"), file: Option.some(content) }]],
		stdin: "",
		claimedByBody: false,
		stdinTty: false,
		stdoutTty: false,
		answer: { kind: "typed", text: "" }
	}))
} as const

/** What evaluating a world settles on, and what it printed and asked. */
export type Chosen = Readonly<{
	outcome:
		| Readonly<{ kind: "credentials"; credentials: ReadonlyArray<readonly [string, string]> }>
		| Readonly<{ kind: "missing"; alternatives: ReadonlyArray<string>; exit: number }>
		| Readonly<{ kind: "usage"; flag: string; message: string; exit: number }>
		| Readonly<{ kind: "interrupted" }>
	asked: number
	notices: string
}>

const stripOne = (text: string): string => {
	if (Str.endsWith("\r\n")(text)) {
		return Str.slice(0, -2)(text)
	}
	return Str.endsWith("\n")(text) ? Str.slice(0, -1)(text) : text
}

const describeAlternative = (alt: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(alt, (scheme) =>
			isScheme(scheme)
				? `${scheme} (--${NAMES[scheme][1]}, env ${NAMES[scheme][0]})`
				: `${scheme} (--${scheme}-file)`
		),
		" + "
	)

/** A step of the model's evaluation: its value, or the outcome the evaluation stops at. */
type Step<A> = Result.Result<A, Chosen["outcome"]>

/**
 * The model of design 6.5's run-time choice: each scheme resolved once (its file flag before its variable, `-` under
 * the one stdin claim, one trailing line end stripped, an empty file refused, an empty variable unset), the first
 * alternative whose every scheme resolves, else anonymous when allowed, else the TTY prompt filling the first
 * alternative whose schemes are all defined, else CredentialMissing; a chosen deprecated scheme is named once.
 */
export const expectedChoice = (drawn: World): Chosen => {
	const holder = { flag: drawn.claimedByBody ? Option.some("body-file") : Option.none<string>() }
	const claim = (flag: string): boolean => {
		if (Option.isSome(holder.flag)) {
			return false
		}
		holder.flag = Option.some(flag)
		return true
	}
	const given = new Map(drawn.sources)
	const resolved = new Map<string, Step<Option.Option<string>>>()
	const usage = (scheme: SchemeName, message: string): Step<Option.Option<string>> =>
		Result.fail({ kind: "usage", flag: NAMES[scheme][1], message, exit: 2 })
	const read = (scheme: SchemeName, sources: Sources): Step<Option.Option<string>> => {
		const flag = NAMES[scheme][1]
		if (Option.isNone(sources.file)) {
			return Result.succeed(Option.filter(sources.env, (text) => text !== ""))
		}
		const file = sources.file.value
		if (file === "stdin") {
			const before = Option.getOrElse(holder.flag, () => "")
			if (!claim(flag)) {
				return Result.fail({
					kind: "usage",
					flag,
					message: `--${flag}: standard input is already read by --${before}`,
					exit: 2
				})
			}
		}
		const content: FileContent = file === "stdin" ? { kind: "text", text: drawn.stdin } : file
		switch (content.kind) {
			case "unreadable":
				return usage(scheme, `cannot read the credential for ${scheme}`)
			case "notUtf8":
				return usage(scheme, `the credential for ${scheme} is not valid UTF-8`)
			case "text": {
				const text = stripOne(content.text)
				return text === ""
					? usage(scheme, `the credential for ${scheme} is empty`)
					: Result.succeed(Option.some(text))
			}
		}
	}
	const resolve = (scheme: string): Step<Option.Option<string>> => {
		const known = resolved.get(scheme)
		if (known !== undefined) {
			return known
		}
		const found = isScheme(scheme)
			? read(scheme, given.get(scheme) ?? { env: Option.none(), file: Option.none() })
			: Result.succeed(Option.none<string>())
		resolved.set(scheme, found)
		return found
	}
	const notices = (schemes: ReadonlyArray<string>) =>
		Arr.join(
			Arr.flatMap(schemes, (scheme) =>
				scheme === "legacyKey" ? ["Notice: the security scheme legacyKey is deprecated\n"] : []
			),
			""
		)
	const stopped = (outcome: Chosen["outcome"], asked: number): Chosen => ({
		outcome,
		asked,
		notices: ""
	})
	for (const alt of drawn.requirement) {
		if (alt.length === 0) {
			continue
		}
		const found: Array<readonly [string, string]> = []
		for (const scheme of alt) {
			const credential = resolve(scheme)
			if (Result.isFailure(credential)) {
				return stopped(credential.failure, 0)
			}
			if (Option.isNone(credential.success)) {
				break
			}
			found.push([scheme, credential.success.value])
		}
		if (found.length === alt.length) {
			return {
				outcome: { kind: "credentials", credentials: found },
				asked: 0,
				notices: notices(alt)
			}
		}
	}
	if (drawn.requirement.length === 0 || Arr.some(drawn.requirement, (alt) => alt.length === 0)) {
		return { outcome: { kind: "credentials", credentials: [] }, asked: 0, notices: "" }
	}
	const missing = (asked: number): Chosen =>
		stopped(
			{ kind: "missing", alternatives: Arr.map(drawn.requirement, describeAlternative), exit: 3 },
			asked
		)
	const target = Arr.findFirst(drawn.requirement, (alt) => Arr.every(alt, isScheme))
	if (Option.isNone(target) || !(drawn.stdinTty && drawn.stdoutTty)) {
		return missing(0)
	}
	const configured: Array<readonly [string, Option.Option<string>]> = []
	for (const scheme of target.value) {
		const found = resolve(scheme)
		if (Result.isFailure(found)) {
			return stopped(found.failure, 0)
		}
		configured.push([scheme, found.success])
	}
	const credentials: Array<readonly [string, string]> = []
	let claimed = false
	let asked = 0
	for (const [scheme, found] of configured) {
		if (Option.isSome(found)) {
			credentials.push([scheme, found.value])
		} else {
			claimed = claimed || (isScheme(scheme) && claim(NAMES[scheme][1]))
			if (!claimed) {
				return missing(asked)
			}
			asked += 1
			if (drawn.answer.kind === "quit") {
				return stopped({ kind: "interrupted" }, asked)
			}
			if (drawn.answer.text === "") {
				return missing(asked)
			}
			credentials.push([scheme, drawn.answer.text])
		}
	}
	return { outcome: { kind: "credentials", credentials }, asked, notices: notices(target.value) }
}

/** What a choice case reaches. */
export type ChoiceFeature =
	| "the first qualifying alternative"
	| "an alternative not all configured skipped"
	| "an AND alternative"
	| "anonymous allowed"
	| "no requirement, anonymous"
	| "a variable override"
	| "the file beats the variable"
	| "a credential read from stdin"
	| "an empty variable unset"
	| "an empty file refused"
	| "an unreadable file refused"
	| "a file not UTF-8 refused"
	| "two stdin readers refused"
	| "stdin held by the body"
	| "an undeclared scheme"
	| "the prompt answered"
	| "the prompt skipped off a TTY"
	| "an empty answer"
	| "a quit prompt"
	| "a stdin file before the prompt"
	| "a deprecated scheme chosen"
	| "CredentialMissing"

/** The situations a choice case reaches, read from the world and the model's verdict. */
export const choiceFeatures = (drawn: World): ReadonlyArray<ChoiceFeature> => {
	const chosen = expectedChoice(drawn)
	const outcome = chosen.outcome
	const credentials = outcome.kind === "credentials" ? outcome.credentials : []
	const credentialed = Arr.filter(drawn.requirement, (alt) => alt.length > 0)
	const given = new Map(drawn.sources)
	const message = outcome.kind === "usage" ? outcome.message : ""
	const chosenSources = Arr.flatMap(credentials, ([scheme]) =>
		isScheme(scheme) ? Option.toArray(Option.fromNullishOr(given.get(scheme))) : []
	)
	const facts: ReadonlyArray<readonly [boolean, ChoiceFeature]> = [
		[
			credentials.length > 0 &&
				chosen.asked === 0 &&
				Arr.some(credentialed, (alt) => alt.length > 0),
			"the first qualifying alternative"
		],
		[
			credentials.length > 0 &&
				Option.exists(
					Arr.head(credentialed),
					(first) =>
						!Arr.every(first, (scheme) => Arr.some(credentials, ([name]) => name === scheme))
				),
			"an alternative not all configured skipped"
		],
		[credentials.length > 1, "an AND alternative"],
		[outcome.kind === "credentials" && credentials.length === 0, "anonymous allowed"],
		[
			outcome.kind === "credentials" && Arr.isReadonlyArrayEmpty(drawn.requirement),
			"no requirement, anonymous"
		],
		[Arr.some(credentials, ([scheme]) => scheme === "other"), "a variable override"],
		[
			Arr.some(
				chosenSources,
				(sources) => Option.isSome(sources.env) && Option.isSome(sources.file)
			),
			"the file beats the variable"
		],
		[
			Arr.some(chosenSources, (sources) => Option.exists(sources.file, (file) => file === "stdin")),
			"a credential read from stdin"
		],
		[
			Arr.some(
				drawn.sources,
				([, sources]) =>
					Option.exists(sources.env, (text) => text === "") && Option.isNone(sources.file)
			),
			"an empty variable unset"
		],
		[Str.includes("is empty")(message), "an empty file refused"],
		[Str.startsWith("cannot read the credential")(message), "an unreadable file refused"],
		[Str.includes("not valid UTF-8")(message), "a file not UTF-8 refused"],
		[
			Str.includes("already read by --")(message) && !Str.includes("--body-file")(message),
			"two stdin readers refused"
		],
		[Str.includes("already read by --body-file")(message), "stdin held by the body"],
		[Arr.some(drawn.requirement, (alt) => Arr.contains(alt, "undeclared")), "an undeclared scheme"],
		[chosen.asked > 0 && outcome.kind === "credentials", "the prompt answered"],
		[
			outcome.kind === "missing" && !(drawn.stdinTty && drawn.stdoutTty),
			"the prompt skipped off a TTY"
		],
		[
			chosen.asked > 0 && drawn.answer.kind === "typed" && drawn.answer.text === "",
			"an empty answer"
		],
		[outcome.kind === "interrupted", "a quit prompt"],
		[
			outcome.kind === "missing" &&
				chosen.asked === 0 &&
				drawn.stdinTty &&
				drawn.stdoutTty &&
				Arr.some(drawn.sources, ([, sources]) =>
					Option.exists(sources.file, (file) => file === "stdin")
				),
			"a stdin file before the prompt"
		],
		[chosen.notices !== "", "a deprecated scheme chosen"],
		[outcome.kind === "missing", "CredentialMissing"]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

const encoder = new TextEncoder()

const key = (name: string, input: Option.Option<string>): Terminal.UserInput => ({
	input,
	key: { ctrl: false, meta: false, name, shift: false }
})

const claimOf = Effect.map(Layer.build(Input.stdinClaimLayer), Context.get(Input.StdinClaim))

const fileBytes = (
	content: FileContent
): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
	switch (content.kind) {
		case "text":
			return Stream.make(encoder.encode(content.text))
		case "unreadable":
			return Stream.fail(
				PlatformError.systemError({
					_tag: "Unknown",
					cause: "EIO: device detail",
					method: "stream",
					module: "FileSystem"
				})
			)
		case "notUtf8":
			return Stream.make(Uint8Array.from([0xff, 0xfe]))
	}
}

/** What the runtime's evaluation of a world did, and every line it rendered on the terminal and stdio. */
type Evaluated = Readonly<{ chosen: Chosen; rendered: string }>

const failureOf = (exit: Exit.Exit<ReadonlyArray<Auth.Credential>, unknown>): Chosen["outcome"] => {
	if (Exit.isSuccess(exit)) {
		return {
			kind: "credentials",
			credentials: Arr.map(
				exit.value,
				(credential) => [credential.scheme, Redacted.value(credential.value)] as const
			)
		}
	}
	if (Cause.hasInterruptsOnly(exit.cause)) {
		return { kind: "interrupted" }
	}
	const failure = Cause.squash(exit.cause)
	const exitCode = Runtime.getErrorExitCode(failure)
	if (
		Predicate.isTagged(failure, "CredentialMissing") &&
		Predicate.hasProperty(failure, "alternatives") &&
		Arr.isArray(failure.alternatives)
	) {
		return {
			kind: "missing",
			alternatives: Arr.filter(failure.alternatives, Predicate.isString),
			exit: exitCode
		}
	}
	return {
		kind: "usage",
		flag:
			Predicate.hasProperty(failure, "flag") && Predicate.isString(failure.flag)
				? failure.flag
				: "",
		message:
			Predicate.hasProperty(failure, "message") && Predicate.isString(failure.message)
				? failure.message
				: "",
		exit: exitCode
	}
}

/** One evaluation of the world by `Auth.evaluate`, on a recorded terminal and stdio, a no-op file system of its files. */
export const evaluated = (drawn: World) =>
	Effect.gen(function* () {
		const rendered: Array<string> = []
		const stderr: Array<string> = []
		const asked = yield* Ref.make(0)
		const typed = drawn.answer.kind === "typed" ? drawn.answer.text : "par"
		const terminal = Terminal.make({
			columns: Effect.succeed(80),
			display: (text) =>
				Effect.sync(() => {
					rendered.push(text)
				}),
			readInput: Effect.gen(function* () {
				yield* Ref.update(asked, (count) => count + 1)
				const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>()
				const keys = Arr.map(Arr.fromIterable(typed), (char) => key(char, Option.some(char)))
				yield* Queue.offerAll(
					queue,
					drawn.answer.kind === "quit" ? keys : [...keys, key("enter", Option.none())]
				)
				if (drawn.answer.kind === "quit") {
					yield* Queue.end(queue)
				}
				return queue
			}),
			readLine: Effect.die("unused"),
			rows: Effect.succeed(24),
			size: Effect.die("unused")
		})
		const files = new Map<string, FileContent>(
			Arr.flatMap(drawn.sources, ([scheme, sources]) =>
				Option.match(sources.file, {
					onNone: () => [],
					onSome: (file) => (file === "stdin" ? [] : [[`/run/${scheme}`, file] as const])
				})
			)
		)
		const settings = Arr.flatMap(drawn.sources, ([scheme, sources]) =>
			Option.match(sources.file, {
				onNone: () => [],
				onSome: (file) => [
					[Auth.credentialFileSetting(scheme), file === "stdin" ? "-" : `/run/${scheme}`] as const
				]
			})
		)
		const claim = yield* claimOf
		if (drawn.claimedByBody) {
			yield* Effect.ignore(claim.claim("body-file"))
		}
		const env = Record.fromEntries(
			Arr.flatMap(drawn.sources, ([scheme, sources]) =>
				Option.toArray(Option.map(sources.env, (text) => [NAMES[scheme][0], text] as const))
			)
		)
		const run = Arr.reduce(
			settings,
			Auth.evaluate("users-update", drawn.requirement),
			(program, [setting, path]) => program.pipe(Effect.provideService(setting, Option.some(path)))
		)
		const exit = yield* run.pipe(
			Effect.provideService(Auth.Schemes, {
				envPrefix: "EXAMPLE",
				files: Arr.map(settings, ([setting]) => setting),
				table: TABLE
			}),
			Effect.provideService(
				FileSystem.FileSystem,
				FileSystem.makeNoop({
					stream: (path) =>
						Option.match(Option.fromNullishOr(files.get(path)), {
							onNone: () => Stream.empty,
							onSome: fileBytes
						})
				})
			),
			Effect.provideService(
				Stdio.Stdio,
				Stdio.make({
					args: Effect.succeed([]),
					stdin: Stream.make(encoder.encode(drawn.stdin)),
					stdout: appendingTo(rendered),
					stderr: appendingTo(stderr),
					stdinIsTerminal: Effect.succeed(drawn.stdinTty),
					stdoutIsTerminal: Effect.succeed(drawn.stdoutTty)
				})
			),
			Effect.provideService(TerminalCapabilities.TerminalCapabilities, {
				canColor: false,
				canAnimate: drawn.stdoutTty,
				canPrompt: drawn.stdinTty && drawn.stdoutTty
			}),
			Effect.provideService(Terminal.Terminal, terminal),
			Effect.provideService(Input.StdinClaim, claim),
			Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
			Effect.exit
		)
		const chosen: Chosen = {
			outcome: failureOf(exit),
			asked: yield* Ref.get(asked),
			notices: Arr.join(stderr, "")
		}
		const evaluation: Evaluated = { chosen, rendered: Arr.join([...rendered, ...stderr], "") }
		return evaluation
	})

/** Every secret a world holds that a rendered line must never carry: each value given and the typed answer. */
export const secretsOf = (drawn: World): ReadonlyArray<string> =>
	Arr.filter(
		Arr.dedupe([
			...Arr.flatMap(drawn.sources, ([, sources]) => Option.toArray(sources.env)),
			...(drawn.answer.kind === "typed" ? [drawn.answer.text] : []),
			...Arr.flatMap(drawn.sources, ([, sources]) =>
				Option.match(sources.file, {
					onNone: () => [],
					onSome: (file) => (file !== "stdin" && file.kind === "text" ? [stripOne(file.text)] : [])
				})
			)
		]),
		(text) => text.length > 3
	)

/** The file flag each scheme with a file registers: its name, and it takes a path or none. */
export const settingsRead = (drawn: World) =>
	Effect.forEach(drawn.sources, ([scheme]) => {
		const setting = Auth.credentialFileSetting(scheme)
		return Effect.all([
			Effect.succeed(setting.id),
			setting.flag.parse({ arguments: [], flags: {} }).pipe(Effect.map(([, given]) => given)),
			setting.flag
				.parse({ arguments: [], flags: { [setting.id]: ["/run/x"] } })
				.pipe(Effect.map(([, given]) => given))
		])
	})

/** The reading the model expects of each scheme's file setting. */
export const expectedSettings = (
	drawn: World
): ReadonlyArray<readonly [string, Option.Option<string>, Option.Option<string>]> =>
	Arr.map(
		drawn.sources,
		([scheme]) => [NAMES[scheme][1], Option.none(), Option.some("/run/x")] as const
	)

/** A base or request origin as drawn: the bound origin, spelled as given, or another. */
export type OriginSketch =
	| "bound"
	| "boundUpper"
	| "boundPort"
	| "unbound"
	| "sibling"
	| "unparseable"

const BOUND = "https://api.example.test"

const UNBOUND = "https://evil.example.test"

const originText: Readonly<Record<OriginSketch, string>> = {
	bound: BOUND,
	boundUpper: "HTTPS://API.EXAMPLE.TEST",
	boundPort: "https://api.example.test:443",
	unbound: UNBOUND,
	sibling: "https://api.example.test.evil.test",
	unparseable: "not a url"
}

const normalizedOrigin = (sketch: OriginSketch): Option.Option<string> => {
	switch (sketch) {
		case "bound":
		case "boundUpper":
		case "boundPort":
			return Option.some(BOUND)
		case "unbound":
			return Option.some(UNBOUND)
		case "sibling":
			return Option.some("https://api.example.test.evil.test")
		case "unparseable":
			return Option.none()
	}
}

/** One attach case: the gate that chooses the credential origins, the request with its stale values, the credentials. */
export type Placement = Readonly<{
	gate: Readonly<{
		allowUnboundBase: boolean
		base: OriginSketch
		provenance: "operator" | "server"
	}>
	target: OriginSketch
	urlQuery: ReadonlyArray<string>
	staleHeaders: ReadonlyArray<"authorization" | "x-key" | "x-legacy">
	cookies: ReadonlyArray<string>
	params: ReadonlyArray<"api_key" | "page">
	credentials: ReadonlyArray<readonly [SchemeName, string]>
}>

const HOSTILE = [
	"\r",
	"\n",
	"\u0000",
	" ",
	"\t",
	"€",
	"é",
	";",
	'"',
	",",
	"\\",
	"\u0007",
	"\u0085",
	"\u007F",
	"\uD800",
	":"
] as const

const credentialValue: Gen<string> = weighted<string>([
	[4, element(["key-1", "tok-4", "user:pa55", "josé:sec:ret", "user:", "k"])],
	[
		2,
		(drawn) => {
			const base = element(["tok", "user:pw", "k"])(drawn)
			const at = int(0, 2)(drawn)
			const char = element(HOSTILE)(drawn)
			return at === 0
				? `${char}${base}`
				: at === 1
					? `${base}${char}`
					: `${Str.slice(0, 1)(base)}${char}${Str.slice(1)(base)}`
		}
	]
])

const ORIGINS: Arr.NonEmptyReadonlyArray<OriginSketch> = [
	"bound",
	"boundUpper",
	"boundPort",
	"unbound",
	"sibling",
	"unparseable"
]

const placement: Gen<Placement> = (drawn) => ({
	gate: {
		allowUnboundBase: boolean(drawn),
		base: element(ORIGINS)(drawn),
		provenance: element(["operator", "server"] as const)(drawn)
	},
	target: weighted<OriginSketch>([
		[4, constant<OriginSketch>("bound")],
		[3, element(ORIGINS)]
	])(drawn),
	urlQuery: subset(["API_KEY=leak", "page=2", "api_key=leak"], { min: 0, max: 3 })(drawn),
	staleHeaders: subset(["authorization", "x-key", "x-legacy"] as const, { min: 0, max: 3 })(drawn),
	cookies: subset(["theme=dark", "sid=stale", "lang=en"], { min: 0, max: 3 })(drawn),
	params: subset(["api_key", "page"] as const, { min: 0, max: 2 })(drawn),
	credentials: uniqueArray(
		element(SCHEMES),
		(scheme) => map(credentialValue, (text) => [scheme, text] as const),
		{
			min: 0,
			max: 3
		}
	)(drawn)
})

/** Placements, with constructed cases for the situations a plain draw reaches rarely. */
export const placements = {
	space: placement,
	cookieStrip: map(placement, (drawn): Placement => ({
		...drawn,
		target: "bound",
		gate: { ...drawn.gate, provenance: "server" },
		cookies: ["theme=dark", "sid=stale", "lang=en"],
		credentials: [["sessionCookie", "tok-3"]]
	})),
	widened: map(placement, (drawn): Placement => ({
		...drawn,
		target: "unbound",
		gate: { allowUnboundBase: true, base: "unbound", provenance: "operator" },
		credentials: [["apiKey", "k"]]
	})),
	oddCookie: map(placement, (drawn): Placement => ({
		...drawn,
		target: "bound",
		credentials: [["oddCookie", "tok"]]
	})),
	schemesOnBound: map(placement, (drawn): Placement => ({
		...drawn,
		target: "boundPort",
		credentials: [
			["basicAuth", "jos\u00E9:sec:ret"],
			["bearerAuth", "tok-4"]
		]
	})),
	upperCase: map(placement, (drawn): Placement => ({
		...drawn,
		target: "boundUpper",
		credentials: [["apiKey", "k"]]
	})),
	headerRefused: map(
		element(["ab\rcd", "ab\ncd", "ab\u0000cd", " tok", "tok\t", "k\u20ACy"]),
		(text): Placement => ({
			gate: { allowUnboundBase: false, base: "bound", provenance: "server" },
			target: "bound",
			urlQuery: [],
			staleHeaders: [],
			cookies: [],
			params: [],
			credentials: [["apiKey", text]]
		})
	),
	loneSurrogate: map(element(["us\uD800er:pw", "user:p\uDC00w"]), (text): Placement => ({
		gate: { allowUnboundBase: false, base: "bound", provenance: "server" },
		target: "bound",
		urlQuery: [],
		staleHeaders: [],
		cookies: [],
		params: [],
		credentials: [["basicAuth", text]]
	})),
	sibling: map(placement, (drawn): Placement => ({
		...drawn,
		target: "sibling",
		credentials: [
			["apiKey", "k"],
			["bearerAuth", "tok-4"]
		]
	})),
	serverBase: map(placement, (drawn): Placement => ({
		...drawn,
		gate: { allowUnboundBase: true, base: "unbound", provenance: "server" },
		target: "unbound"
	})),
	basicRefused: map(
		element(["us\u0007er:pw", "us\uD800er:pw", "userpw", "user:pw\u007F"]),
		(text): Placement => ({
			gate: { allowUnboundBase: false, base: "bound", provenance: "server" },
			target: "bound",
			urlQuery: [],
			staleHeaders: [],
			cookies: [],
			params: [],
			credentials: [["basicAuth", text]]
		})
	)
} as const

/** What the model expects of one attach: the credential origins, then the request's url, headers and params, or a refusal. */
export type Attached = Readonly<{
	origins: ReadonlyArray<string>
	request:
		| Readonly<{
				kind: "sent"
				url: string
				headers: Readonly<Record<string, string>>
				params: Readonly<Record<string, string | ReadonlyArray<string>>>
		  }>
		| Readonly<{ kind: "refused"; flag: string; message: string }>
}>

const isWide = (char: string): boolean => Option.getOrElse(Str.codePointAt(0)(char), () => 0) > 0xff

const isControl = (char: string): boolean => {
	const point = Option.getOrElse(Str.codePointAt(0)(char), () => 0)
	return point < 0x20 || (point >= 0x7f && point <= 0x9f)
}

const isLoneSurrogate = (char: string): boolean => {
	const point = Option.getOrElse(Str.codePointAt(0)(char), () => 0)
	return point >= 0xd800 && point <= 0xdfff
}

const unsafeHeader = (text: string): boolean => {
	const chars = Arr.fromIterable(text)
	const edges = [" ", "\t", "\r", "\n"]
	return (
		Arr.some(
			chars,
			(char) => char === "\r" || char === "\n" || char === "\u0000" || isWide(char)
		) ||
		Option.exists(Arr.head(chars), (char) => Arr.contains(edges, char)) ||
		Option.exists(Arr.last(chars), (char) => Arr.contains(edges, char))
	)
}

const isToken = (text: string): boolean =>
	text.length > 0 &&
	Arr.every(
		Arr.fromIterable(text),
		(char) =>
			(char >= "0" && char <= "9") ||
			(char >= "a" && char <= "z") ||
			(char >= "A" && char <= "Z") ||
			Arr.contains(
				["!", "#", "$", "%", "&", "'", "*", "+", ".", "^", "_", "`", "|", "~", "-"],
				char
			)
	)

const isCookieOctets = (text: string): boolean =>
	Arr.every(Arr.fromIterable(text), (char) => {
		const point = Option.getOrElse(Str.codePointAt(0)(char), () => 0)
		return (
			point === 0x21 ||
			(point >= 0x23 && point <= 0x2b) ||
			(point >= 0x2d && point <= 0x3a) ||
			(point >= 0x3c && point <= 0x5b) ||
			(point >= 0x5d && point <= 0x7e)
		)
	})

const cookieNameOf = (pair: string): string => Arr.headNonEmpty(Str.split("=")(pair))

/** An Authorization header value: its scheme word, a space, its token. */
const authorization = (word: string, token: string): string => Arr.join([word, token], " ")

const MANAGED_COOKIES = ["sid"] as const

/** The URL a case requests, with its own query pairs. */
const urlOf = (drawn: Placement): string =>
	`${originText[drawn.target]}/v1${drawn.urlQuery.length === 0 ? "" : `?${Arr.join(drawn.urlQuery, "&")}`}`

/** The model of the attach transform under the model of the credential gate. */
export const expectedAttached = (drawn: Placement): Attached => {
	const base =
		drawn.gate.provenance === "operator" && drawn.gate.allowUnboundBase
			? Option.toArray(normalizedOrigin(drawn.gate.base))
			: []
	const origins = Arr.dedupe([BOUND, ...base])
	const keptQuery = Arr.filter(drawn.urlQuery, (pair) => !Str.startsWith("api_key=")(pair))
	const url = `${originText[drawn.target]}/v1${keptQuery.length === 0 ? "" : `?${Arr.join(keptQuery, "&")}`}`
	const headers = new Map<string, string>()
	const cookies = Arr.filter(
		drawn.cookies,
		(pair) => !Arr.contains<string>(MANAGED_COOKIES, cookieNameOf(pair))
	)
	const params = new Map<string, string>(Arr.contains(drawn.params, "page") ? [["page", "2"]] : [])
	const bound = Option.exists(normalizedOrigin(drawn.target), (origin) =>
		Arr.contains(origins, origin)
	)
	const sent = () => ({
		kind: "sent" as const,
		url,
		headers: Record.fromEntries([
			...headers,
			...(cookies.length === 0 ? [] : [["cookie", Arr.join(cookies, "; ")] as const])
		]),
		params: Record.fromEntries(params)
	})
	if (!bound) {
		return { origins, request: sent() }
	}
	for (const [scheme, text] of drawn.credentials) {
		const refuse = (rule: string): Attached => ({
			origins,
			request: {
				kind: "refused",
				flag: NAMES[scheme][1],
				message: `the credential for ${scheme} ${rule}`
			}
		})
		const headerRule =
			"has a CR, LF, NUL, leading or trailing whitespace or a code point above U+00FF"
		switch (scheme) {
			case "apiKey":
			case "legacyKey":
				if (unsafeHeader(text)) {
					return refuse(headerRule)
				}
				headers.set(scheme === "apiKey" ? "x-key" : "x-legacy", text)
				break
			case "bearerAuth":
			case "other":
			case "oauthAuth":
			case "oidcAuth":
				if (unsafeHeader(text)) {
					return refuse(headerRule)
				}
				headers.set("authorization", authorization("Bearer", text))
				break
			case "basicAuth": {
				if (!Str.includes(":")(text)) {
					return refuse("must be <user-id>:<password>")
				}
				const chars = Arr.fromIterable(text)
				if (Arr.some(chars, isLoneSurrogate)) {
					return refuse("has a lone surrogate")
				}
				if (Arr.some(chars, isControl)) {
					return refuse("has a control character")
				}
				headers.set(
					"authorization",
					authorization("Basic", Buffer.from(text, "utf8").toString("base64"))
				)
				break
			}
			case "queryKey":
				params.set("api_key", text)
				break
			case "sessionCookie":
			case "oddCookie": {
				const name = scheme === "sessionCookie" ? "sid" : "a; admin=1"
				if (!isToken(name)) {
					return refuse("has a cookie name that is not a token")
				}
				if (!isCookieOctets(text)) {
					return refuse("is not a valid cookie value")
				}
				cookies.push(`${name}=${text}`)
				break
			}
		}
	}
	return { origins, request: sent() }
}

const staleRequest = (drawn: Placement): HttpClientRequest.HttpClientRequest => {
	const withHeaders = Arr.reduce(
		drawn.staleHeaders,
		HttpClientRequest.get(urlOf(drawn)),
		(request, name) =>
			HttpClientRequest.setHeader(
				request,
				name,
				name === "authorization" ? "Bearer stale" : "stale"
			)
	)
	const withCookies =
		drawn.cookies.length === 0
			? withHeaders
			: HttpClientRequest.setHeader(withHeaders, "cookie", Arr.join(drawn.cookies, "; "))
	return Arr.reduce(drawn.params, withCookies, (request, name) =>
		HttpClientRequest.setUrlParam(request, name, name === "page" ? "2" : "stale")
	)
}

/** What `Auth.credentialOrigins` and `Auth.attach` did with one case. */
export const actualAttached = (drawn: Placement) =>
	Effect.gen(function* () {
		const origins = Auth.credentialOrigins({
			allowUnboundBase: drawn.gate.allowUnboundBase,
			baseOrigin: originText[drawn.gate.base],
			boundOrigins: [BOUND],
			provenance: drawn.gate.provenance
		})
		const credentials = Arr.flatMap(drawn.credentials, ([scheme, text]) =>
			Option.toArray(
				Option.map(Option.fromNullishOr(TABLE.schemes[scheme]), (definition): Auth.Credential => ({
					definition,
					scheme,
					value: Redacted.make(text)
				}))
			)
		)
		const result = yield* Effect.result(
			Auth.attach(TABLE, { credentials, origins })(staleRequest(drawn))
		)
		const attached: Attached = {
			origins,
			request: Result.isFailure(result)
				? { kind: "refused", flag: result.failure.flag ?? "", message: result.failure.message }
				: {
						kind: "sent",
						url: result.success.url,
						headers: Record.fromEntries(
							Arr.flatMap(Record.toEntries(result.success.headers), ([name, text]) =>
								Predicate.isString(text) ? [[name, text] as const] : []
							)
						),
						params: UrlParams.toRecord(UrlParams.fromInput(result.success.urlParams))
					}
		}
		return attached
	})

/** What a placement case reaches. */
export type PlacementFeature =
	| "an apiKey header"
	| "an apiKey query pair"
	| "an apiKey cookie after kept cookies"
	| "a managed cookie pair replaced"
	| "http basic"
	| "a bearer token"
	| "an oauth2 or OIDC token"
	| "an unbound origin stripped"
	| "a managed query name in the url stripped"
	| "an origin matched by origin, not case or port"
	| "a sibling host carries nothing"
	| "an unparseable url carries nothing"
	| "a header value refused"
	| "a cookie value refused"
	| "a cookie name refused"
	| "a basic credential refused"
	| "a lone surrogate refused"
	| "a bad value unchecked off origin"
	| "the gate widened to the operator base"
	| "the gate ignores a server base"

/** The situations a placement case reaches. */
export const placementFeatures = (drawn: Placement): ReadonlyArray<PlacementFeature> => {
	const attached = expectedAttached(drawn)
	const sent = attached.request.kind === "sent"
	const bound = Option.exists(normalizedOrigin(drawn.target), (origin) =>
		Arr.contains(attached.origins, origin)
	)
	const message = attached.request.kind === "refused" ? attached.request.message : ""
	const schemes = Arr.map(drawn.credentials, ([scheme]) => scheme)
	const has = (...names: ReadonlyArray<SchemeName>) =>
		sent && bound && Arr.some(names, (name) => Arr.contains(schemes, name))
	const facts: ReadonlyArray<readonly [boolean, PlacementFeature]> = [
		[has("apiKey", "legacyKey"), "an apiKey header"],
		[has("queryKey"), "an apiKey query pair"],
		[has("sessionCookie") && drawn.cookies.length > 0, "an apiKey cookie after kept cookies"],
		[
			has("sessionCookie") && Arr.contains(drawn.cookies, "sid=stale"),
			"a managed cookie pair replaced"
		],
		[has("basicAuth"), "http basic"],
		[has("bearerAuth", "other"), "a bearer token"],
		[has("oauthAuth", "oidcAuth"), "an oauth2 or OIDC token"],
		[
			!bound && sent && (drawn.staleHeaders.length > 0 || Arr.contains(drawn.cookies, "sid=stale")),
			"an unbound origin stripped"
		],
		[
			Arr.contains(drawn.urlQuery, "api_key=leak") && sent,
			"a managed query name in the url stripped"
		],
		[
			(drawn.target === "boundUpper" || drawn.target === "boundPort") &&
				bound &&
				drawn.credentials.length > 0 &&
				sent,
			"an origin matched by origin, not case or port"
		],
		[drawn.target === "sibling" && drawn.credentials.length > 0, "a sibling host carries nothing"],
		[
			drawn.target === "unparseable" && drawn.credentials.length > 0,
			"an unparseable url carries nothing"
		],
		[Str.includes("CR, LF, NUL")(message), "a header value refused"],
		[Str.includes("not a valid cookie value")(message), "a cookie value refused"],
		[Str.includes("cookie name")(message), "a cookie name refused"],
		[
			Str.includes("user-id")(message) || Str.includes("control character")(message),
			"a basic credential refused"
		],
		[Str.includes("lone surrogate")(message), "a lone surrogate refused"],
		[
			!bound && Arr.some(drawn.credentials, ([, text]) => unsafeHeader(text)),
			"a bad value unchecked off origin"
		],
		[
			drawn.gate.provenance === "operator" &&
				drawn.gate.allowUnboundBase &&
				drawn.gate.base === "unbound" &&
				drawn.target === "unbound",
			"the gate widened to the operator base"
		],
		[
			drawn.gate.provenance === "server" &&
				drawn.gate.allowUnboundBase &&
				drawn.gate.base === "unbound",
			"the gate ignores a server base"
		]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

/** One base URL host as drawn: an IPv4 address in some notation, an IPv6 form, or a name. */
export type HostSketch =
	| Readonly<{ kind: "ipv4"; address: number; notation: "dotted" | "integer" | "hexDotted" }>
	| Readonly<{ kind: "ipv6"; form: "loopback" | "unspecified" | "two" | "mapped"; mapped: number }>
	| Readonly<{ kind: "name"; labels: ReadonlyArray<string>; upper: boolean; dots: 0 | 1 | 2 }>

/** One plaintext-warning case: the base URL's scheme, userinfo, host and port, and whether the flag was given. */
export type Plaintext = Readonly<{
	scheme: "http" | "https"
	userinfo: boolean
	host: HostSketch
	port: Option.Option<number>
	allowed: boolean
}>

const octets = (address: number): ReadonlyArray<number> => [
	(address >>> 24) & 255,
	(address >>> 16) & 255,
	(address >>> 8) & 255,
	address & 255
]

const ipv4Text = (address: number, notation: "dotted" | "integer" | "hexDotted"): string => {
	const parts = octets(address)
	switch (notation) {
		case "dotted":
			return Arr.join(Arr.map(parts, String), ".")
		case "integer":
			return String(address >>> 0)
		case "hexDotted":
			return Arr.join(
				Arr.map(parts, (part, at) => (at === 0 ? `0x${part.toString(16)}` : String(part))),
				"."
			)
	}
}

const ipv6Text = (form: "loopback" | "unspecified" | "two" | "mapped", mapped: number): string => {
	switch (form) {
		case "loopback":
			return "[::1]"
		case "unspecified":
			return "[::]"
		case "two":
			return "[::2]"
		case "mapped":
			return `[::ffff:${Arr.join(Arr.map(octets(mapped), String), ".")}]`
	}
}

const hostText = (host: HostSketch): string => {
	switch (host.kind) {
		case "ipv4":
			return ipv4Text(host.address, host.notation)
		case "ipv6":
			return ipv6Text(host.form, host.mapped)
		case "name": {
			const name = `${Arr.join(host.labels, ".")}${Str.repeat(host.dots)(".")}`
			return host.upper ? Str.toUpperCase(name) : name
		}
	}
}

/** The model of design 6.5's loopback hosts: 127.0.0.0/8 in any notation or mapped, `::1`, and `localhost` names. */
const loopbackInModel = (host: HostSketch): boolean => {
	switch (host.kind) {
		case "ipv4":
			return host.address >>> 24 === 127
		case "ipv6":
			return host.form === "loopback" || (host.form === "mapped" && host.mapped >>> 24 === 127)
		case "name":
			return host.dots < 2 && Option.exists(Arr.last(host.labels), (label) => label === "localhost")
	}
}

const ipv4: Gen<number> = weighted<number>([
	[3, map(int(0, 0xff_ffff), (low) => 127 * 0x100_0000 + low)],
	[2, element([0, 0x7f_ff_ff_ff + 1, 0x0a_00_00_01, 0x08_08_08_08, 0x7e_ff_ff_ff])]
])

const hostSketch: Gen<HostSketch> = oneOf<HostSketch>([
	(drawn) => ({
		kind: "ipv4",
		address: ipv4(drawn),
		notation: element(["dotted", "integer", "hexDotted"] as const)(drawn)
	}),
	(drawn) => ({
		kind: "ipv6",
		form: element(["loopback", "unspecified", "two", "mapped"] as const)(drawn),
		mapped: ipv4(drawn)
	}),
	(drawn) => ({
		kind: "name",
		labels: element([
			["localhost"],
			["api", "localhost"],
			["localhost", "example", "com"],
			["example", "test"],
			["127", "example", "com"]
		])(drawn),
		upper: boolean(drawn),
		dots: weighted<0 | 1 | 2>([
			[2, constant(0)],
			[1, constant(1)],
			[1, constant(2)]
		])(drawn)
	})
])

/** Plaintext-warning cases over every host form. */
export const plaintexts: Gen<Plaintext> = (drawn) => ({
	scheme: weighted<"http" | "https">([
		[4, constant("http" as const)],
		[1, constant("https" as const)]
	])(drawn),
	userinfo: boolean(drawn),
	host: hostSketch(drawn),
	port: option(element([8080, 443, 80]))(drawn),
	allowed: weighted<boolean>([
		[4, constant(true)],
		[1, constant(false)]
	])(drawn)
})

/** The base URL of a plaintext case. */
const baseUrlOf = (drawn: Plaintext): string =>
	`${drawn.scheme}://${drawn.userinfo ? "operator:s3cr3t-value@" : ""}${hostText(drawn.host)}${Option.match(drawn.port, { onNone: () => "", onSome: (port) => `:${port}` })}/v1`

/** What a plaintext case reads as: whether its host is loopback, and the warning line, when one is printed. */
export type Warned = Readonly<{ loopback: boolean; warning: Option.Option<string> }>

/** The model: a warning only with the flag, over `http:`, to a host that is not loopback, naming the host and port. */
export const expectedWarned = (drawn: Plaintext): Warned => {
	const loopback = loopbackInModel(drawn.host)
	return {
		loopback,
		warning:
			drawn.allowed && drawn.scheme === "http" && !loopback
				? Option.some(
						`Warning: --allow-credentials-for-base-url sends credentials to ${new URL(baseUrlOf(drawn)).host} over plaintext http`
					)
				: Option.none()
	}
}

/** What the runtime answers for a plaintext case. */
export const actualWarned = (drawn: Plaintext): Warned => ({
	loopback: Auth.isLoopbackHost(new URL(baseUrlOf(drawn)).hostname),
	warning: Auth.plaintextWarning(baseUrlOf(drawn), drawn.allowed)
})

/** What a plaintext case reaches. */
export type PlaintextFeature =
	| "a dotted 127/8 address"
	| "a 127/8 address in another notation"
	| "IPv6 loopback"
	| "an IPv4-mapped loopback"
	| "a localhost name"
	| "a trailing dot"
	| "two trailing dots"
	| "a name only holding localhost"
	| "a public address warned"
	| "userinfo left out"
	| "https never warned"
	| "no warning without the flag"

/** The situations a plaintext case reaches. */
export const plaintextFeatures = (drawn: Plaintext): ReadonlyArray<PlaintextFeature> => {
	const { host } = drawn
	const loopback = loopbackInModel(host)
	const warned = Option.isSome(expectedWarned(drawn).warning)
	const facts: ReadonlyArray<readonly [boolean, PlaintextFeature]> = [
		[host.kind === "ipv4" && host.notation === "dotted" && loopback, "a dotted 127/8 address"],
		[
			host.kind === "ipv4" && host.notation !== "dotted" && loopback,
			"a 127/8 address in another notation"
		],
		[host.kind === "ipv6" && host.form === "loopback", "IPv6 loopback"],
		[host.kind === "ipv6" && host.form === "mapped" && loopback, "an IPv4-mapped loopback"],
		[host.kind === "name" && loopback, "a localhost name"],
		[host.kind === "name" && host.dots === 1, "a trailing dot"],
		[host.kind === "name" && host.dots === 2, "two trailing dots"],
		[
			host.kind === "name" && !loopback && Arr.some(host.labels, (label) => label === "localhost"),
			"a name only holding localhost"
		],
		[warned, "a public address warned"],
		[warned && drawn.userinfo, "userinfo left out"],
		[drawn.scheme === "https" && drawn.allowed && !loopback, "https never warned"],
		[!drawn.allowed && drawn.scheme === "http" && !loopback, "no warning without the flag"]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

/** Plaintext cases aimed at the forms a plain draw reaches rarely. */
export const plaintextArms = {
	mapped: map(plaintexts, (drawn): Plaintext => ({
		...drawn,
		host: { kind: "ipv6", form: "mapped", mapped: 0x7f_00_00_01 }
	})),
	twoDots: map(plaintexts, (drawn): Plaintext => ({
		...drawn,
		host: { kind: "name", labels: ["localhost"], upper: false, dots: 2 }
	})),
	dotted: map(plaintexts, (drawn): Plaintext => ({
		...drawn,
		host: { kind: "ipv4", address: 127 * 0x100_0000 + 0x09_09_09, notation: "dotted" }
	})),
	ipv6: map(plaintexts, (drawn): Plaintext => ({
		...drawn,
		host: { kind: "ipv6", form: "loopback", mapped: 0 }
	})),
	trailingDot: map(plaintexts, (drawn): Plaintext => ({
		...drawn,
		host: { kind: "name", labels: ["api", "localhost"], upper: true, dots: 1 }
	})),
	noFlag: map(plaintexts, (drawn): Plaintext => ({
		...drawn,
		scheme: "http",
		allowed: false,
		host: { kind: "name", labels: ["example", "test"], upper: false, dots: 0 }
	})),
	userinfo: map(plaintexts, (drawn): Plaintext => ({
		...drawn,
		scheme: "http",
		allowed: true,
		userinfo: true,
		host: { kind: "name", labels: ["example", "test"], upper: false, dots: 0 }
	})),
	https: map(plaintexts, (drawn): Plaintext => ({
		...drawn,
		scheme: "https",
		allowed: true,
		host: { kind: "name", labels: ["example", "test"], upper: false, dots: 0 }
	}))
} as const

/** The operation `send` is asked to call: its security requirement and whether the document marks it deprecated. */
export type Call = Readonly<{
	requirement: ReadonlyArray<ReadonlyArray<"oauthAuth" | "oidcAuth" | "bearerAuth" | "apiKey">>
	env: ReadonlyArray<readonly ["oauthAuth" | "oidcAuth" | "bearerAuth" | "apiKey", string]>
	base: "server" | "operatorBound" | "operatorUnbound"
	allow: boolean
	hop: "none" | "same" | "away"
	deprecated: "unmarked" | "false" | "withId" | "withoutId"
	echo: boolean
}>

const SEND_SCHEMES = ["oauthAuth", "oidcAuth", "bearerAuth", "apiKey"] as const

/** Calls over every requirement shape, base, redirect, deprecation mark and echoing response. */
export const calls: Gen<Call> = (drawn) => ({
	requirement: array(subset(SEND_SCHEMES, { min: 0, max: 2 }), { min: 0, max: 2 })(drawn),
	env: uniqueArray(
		element(SEND_SCHEMES),
		(scheme) =>
			map(element(["tok", "key"]), (text) => [scheme, `${text}-${scheme}-SECRET`] as const),
		{
			min: 0,
			max: 3
		}
	)(drawn),
	base: element(["server", "operatorBound", "operatorUnbound"] as const)(drawn),
	allow: boolean(drawn),
	hop: element(["none", "same", "away"] as const)(drawn),
	deprecated: element(["unmarked", "false", "withId", "withoutId"] as const)(drawn),
	echo: weighted<boolean>([
		[4, constant(false)],
		[1, constant(true)]
	])(drawn)
})

/** Calls aimed at the situations a plain draw reaches rarely. */
export const callArms = {
	withheld: map(calls, (drawn): Call => ({
		...drawn,
		base: "operatorUnbound",
		allow: false,
		requirement: [["oauthAuth"]],
		env: [["oauthAuth", "tok-AU1-SECRET"]]
	})),
	sameOrigin: map(calls, (drawn): Call => ({
		...drawn,
		base: "server",
		hop: "same",
		requirement: [["oauthAuth"]],
		env: [["oauthAuth", "tok-oauthAuth-SECRET"]]
	})),
	allowed: map(calls, (drawn): Call => ({
		...drawn,
		base: "operatorUnbound",
		allow: true,
		requirement: [["oauthAuth"]],
		env: [["oauthAuth", "tok-oauthAuth-SECRET"]]
	})),
	echoed: map(calls, (drawn): Call => ({
		...drawn,
		base: "server",
		echo: true,
		requirement: [["bearerAuth"]],
		env: [["bearerAuth", "tok-AU1-BEARER"]]
	})),
	fallsThrough: map(calls, (drawn): Call => ({
		...drawn,
		requirement: [["oauthAuth", "apiKey"], ["bearerAuth"]],
		env: [
			["oauthAuth", "tok-oauthAuth-SECRET"],
			["bearerAuth", "tok-bearerAuth-SECRET"]
		]
	})),
	away: map(calls, (drawn): Call => ({
		...drawn,
		base: "server",
		hop: "away",
		requirement: [["oidcAuth"]],
		env: [["oidcAuth", "tok-AU1-SECRET"]]
	}))
} as const

const API = "https://api.example.com"

const ELSEWHERE = "https://elsewhere.example.net"

const OTHER = "https://other.example.org"

/** One hop of a call as the recording client saw it: its URL and the credential headers it carried. */
export type Hop = Readonly<{
	url: string
	authorization: Option.Option<string>
	key: Option.Option<string>
}>

/** What one call did: its outcome, the hops sent, stderr, and whether the deprecation notice preceded the request. */
export type Called = Readonly<{
	outcome:
		| Readonly<{ kind: "ok" }>
		| Readonly<{ kind: "missing" }>
		| Readonly<{ kind: "apiError"; body: string }>
	hops: ReadonlyArray<Hop>
	stderr: string
	noticeFirst: boolean
	leaked: boolean
}>

const baseOf = (drawn: Call): string => {
	switch (drawn.base) {
		case "server":
		case "operatorBound":
			return API
		case "operatorUnbound":
			return ELSEWHERE
	}
}

const pathOf = (drawn: Call): string => {
	switch (drawn.hop) {
		case "none":
			return "42"
		case "same":
			return "same"
		case "away":
			return "away"
	}
}

const echoBody = (token: string): string => `raw=${token} json={"t":"${token}"}`

/** The model of one call: the choice, the credential gate per hop, the notices in order, and a scrubbed echo. */
export const expectedCalled = (drawn: Call): Called => {
	const env = new Map(drawn.env)
	const chosen = Arr.findFirst(
		drawn.requirement,
		(alt) => alt.length > 0 && Arr.every(alt, (scheme) => env.has(scheme))
	)
	const anonymous =
		drawn.requirement.length === 0 || Arr.some(drawn.requirement, (alt) => alt.length === 0)
	const name = drawn.deprecated === "withoutId" ? "GET /users/{id}" : "users-read"
	const deprecatedNotice =
		drawn.deprecated === "withId" || drawn.deprecated === "withoutId"
			? `Notice: the operation ${name} is deprecated\n`
			: ""
	if (Option.isNone(chosen) && !anonymous) {
		return {
			outcome: { kind: "missing" },
			hops: [],
			stderr: deprecatedNotice,
			noticeFirst: true,
			leaked: false
		}
	}
	const credentials = Option.getOrElse(chosen, () => [])
	const base = baseOf(drawn)
	const origins = drawn.base === "operatorUnbound" && drawn.allow ? [API, ELSEWHERE] : [API]
	const withheld = credentials.length > 0 && !Arr.contains(origins, base)
	const withheldNotice = withheld
		? `Notice: not sending credentials (${Arr.join(Arr.dedupe(credentials), ", ")}) to an unbound base URL; --allow-credentials-for-base-url sends them\n`
		: ""
	const carried = (origin: string): Hop => {
		const on = Arr.contains(origins, origin)
		const bearer = Arr.findLast(credentials, (scheme) => scheme !== "apiKey")
		return {
			url: "",
			authorization: on
				? Option.map(bearer, (scheme) => authorization("Bearer", env.get(scheme) ?? ""))
				: Option.none(),
			key:
				on && Arr.contains(credentials, "apiKey")
					? Option.fromNullishOr(env.get("apiKey"))
					: Option.none()
		}
	}
	const first = { ...carried(base), url: `${base}/users/${pathOf(drawn)}` }
	const second: ReadonlyArray<Hop> =
		drawn.hop === "same"
			? [{ ...carried(base), url: `${base}/landed` }]
			: drawn.hop === "away"
				? [{ ...carried(OTHER), url: `${OTHER}/landed` }]
				: []
	const echoed = drawn.echo && credentials.length > 0
	const token = Option.flatMap(Arr.head(credentials), (scheme) =>
		Option.fromNullishOr(env.get(scheme))
	)
	return {
		outcome:
			echoed && Option.isSome(token)
				? {
						kind: "apiError",
						body: echoBody(`<redacted:${Option.getOrElse(Arr.head(credentials), () => "")}>`)
					}
				: { kind: "ok" },
		hops: [first, ...second],
		stderr: `${deprecatedNotice}${withheldNotice}`,
		noticeFirst: true,
		leaked: false
	}
}

const respondTo = (drawn: Call, url: URL): Response => {
	const token = Option.flatMap(
		Arr.findFirst(
			drawn.requirement,
			(alt) =>
				alt.length > 0 &&
				Arr.every(alt, (scheme) => Arr.some(drawn.env, ([name]) => name === scheme))
		),
		(alt) =>
			Option.flatMap(Arr.head(alt), (scheme) =>
				Option.fromNullishOr(new Map(drawn.env).get(scheme))
			)
	)
	if (Str.endsWith("/users/same")(url.pathname)) {
		return new Response(null, { headers: { location: `${url.origin}/landed` }, status: 307 })
	}
	if (Str.endsWith("/users/away")(url.pathname)) {
		return new Response(null, { headers: { location: `${OTHER}/landed` }, status: 307 })
	}
	return drawn.echo && Option.isSome(token)
		? new Response(echoBody(token.value), {
				headers: { "content-type": "text/plain" },
				status: 500
			})
		: new Response("", { status: 200 })
}

const recordStderr = (events: Array<string>, into: Array<string>) => (chunk: string | Uint8Array) =>
	Effect.map(chunkText(chunk), (text) => {
		events.push(Str.startsWith("Notice:")(text) ? "notice" : "stderr")
		into.push(text)
	})

/** One call of `Output.send` through the final catch, against a recording client that answers by path. */
export const actualCalled = (drawn: Call) =>
	Effect.gen(function* () {
		const hops: Array<Hop> = []
		const events: Array<string> = []
		const stderr: Array<string> = []
		const client = HttpClient.make((sent, url) =>
			Effect.sync(() => {
				events.push("request")
				hops.push({
					url: url.href,
					authorization: Headers.get(sent.headers, "authorization"),
					key: Headers.get(sent.headers, "x-key")
				})
				return HttpClientResponse.fromWeb(sent, respondTo(drawn, url))
			})
		)
		const meta: Output.OperationMeta = {
			media: { request: [], responses: { "200": [] } },
			method: "GET",
			pathTemplate: "/users/{id}",
			security: drawn.requirement,
			...(drawn.deprecated === "withoutId" ? {} : { operationId: "users-read" }),
			...(drawn.deprecated === "unmarked" ? {} : { deprecated: drawn.deprecated !== "false" })
		}
		const request = Serialize.request("GET", {
			headers: [],
			path: Serialize.path("/users/{id}", [
				Serialize.simple("id", pathOf(drawn), { allowReserved: false, explode: false })
			]),
			query: []
		})
		const claim = yield* claimOf
		const exit = yield* Output.finalCatch([])(request.pipe(Effect.flatMap(Output.send(meta)))).pipe(
			Effect.provideService(BaseUrl.Servers, {
				envPrefix: "EXAMPLE",
				table: { boundOrigins: [API], defaultServer: 0, servers: [{ url: API, variables: {} }] }
			}),
			Effect.provideService(Auth.Schemes, { envPrefix: "EXAMPLE", files: [], table: TABLE }),
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromEnv({
					env: Record.fromEntries(
						Arr.map(drawn.env, ([scheme, text]) => [NAMES[scheme][0], text] as const)
					)
				})
			),
			Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
			Effect.provideService(
				Stdio.Stdio,
				Stdio.make({
					args: Effect.succeed([]),
					stdin: Stream.empty,
					stdout: () => Sink.drain,
					stderr: () => Sink.forEach(recordStderr(events, stderr))
				})
			),
			Effect.provideService(Input.StdinClaim, claim),
			Effect.provideServiceEffect(RunCredentials, Ref.make<ReadonlyArray<ScrubEntry>>([])),
			Effect.provideService(Transport, {
				certified: Option.none(),
				plain: { direct: client, environment: client }
			}),
			Effect.provideService(Output.ClientPolicy, { binName: "example", version: "1.2.3" }),
			Effect.provideService(Output.OutputPath, Option.none()),
			Effect.provideService(Output.Force, false),
			Effect.provideService(
				BaseUrl.baseUrlSetting,
				drawn.base === "server" ? Option.none() : Option.some(baseOf(drawn))
			),
			Effect.provideService(BaseUrl.serverSetting, Option.none()),
			Effect.provideService(BaseUrl.serverVariableSetting, []),
			Effect.provideService(Auth.allowCredentialsForBaseUrl, drawn.allow),
			Effect.exit
		)
		const failure = Exit.isFailure(exit)
			? Option.fromNullishOr(Cause.squash(exit.cause))
			: Option.none()
		const outcome: Called["outcome"] = Option.match(failure, {
			onNone: () => ({ kind: "ok" }),
			onSome: (error) =>
				Predicate.isTagged(error, "CredentialMissing")
					? { kind: "missing" }
					: {
							kind: "apiError",
							body:
								Predicate.hasProperty(error, "body") && Predicate.isString(error.body)
									? error.body
									: ""
						}
		})
		const firstNotice = events.indexOf("notice")
		const firstRequest = events.indexOf("request")
		const called: Called = {
			outcome,
			hops,
			stderr: Arr.join(
				Arr.filter(stderr, (text) => Str.startsWith("Notice:")(text)),
				""
			),
			noticeFirst: firstNotice === -1 || firstRequest === -1 || firstNotice < firstRequest,
			leaked: Arr.some(stderr, (text) =>
				Arr.some(drawn.env, ([, token]) => Str.includes(token)(text))
			)
		}
		return called
	})

/** What a call case reaches. */
export type CallFeature =
	| "an oauth2 token as Bearer"
	| "an OIDC token as Bearer"
	| "an apiKey header sent"
	| "a same-origin redirect keeps the token"
	| "a redirect off origin strips the token"
	| "a token withheld from an unbound base, one notice"
	| "the allow flag sends to an unbound base"
	| "an alternative falls through"
	| "CredentialMissing before any request"
	| "a deprecated operation named by its id"
	| "a deprecated operation named by method and path"
	| "deprecated: false writes nothing"
	| "an echoed credential scrubbed"

/** The situations a call case reaches. */
export const callFeatures = (drawn: Call): ReadonlyArray<CallFeature> => {
	const called = expectedCalled(drawn)
	const first = Arr.head(called.hops)
	const sentWith = (prefix: string) =>
		Option.exists(first, (hop) => Option.exists(hop.authorization, Str.startsWith(prefix)))
	const env = new Map(drawn.env)
	const chosen = Arr.findFirst(
		drawn.requirement,
		(alt) => alt.length > 0 && Arr.every(alt, (scheme) => env.has(scheme))
	)
	const credentials = Option.getOrElse(chosen, () => [])
	const facts: ReadonlyArray<readonly [boolean, CallFeature]> = [
		[sentWith("Bearer") && Arr.contains(credentials, "oauthAuth"), "an oauth2 token as Bearer"],
		[sentWith("Bearer") && Arr.contains(credentials, "oidcAuth"), "an OIDC token as Bearer"],
		[Option.exists(first, (hop) => Option.isSome(hop.key)), "an apiKey header sent"],
		[
			drawn.hop === "same" &&
				Option.exists(
					Arr.get(called.hops, 1),
					(hop) => Option.isSome(hop.authorization) || Option.isSome(hop.key)
				),
			"a same-origin redirect keeps the token"
		],
		[
			drawn.hop === "away" &&
				credentials.length > 0 &&
				Option.exists(first, (hop) => Option.isSome(hop.authorization) || Option.isSome(hop.key)),
			"a redirect off origin strips the token"
		],
		[
			Str.includes("not sending credentials")(called.stderr),
			"a token withheld from an unbound base, one notice"
		],
		[
			drawn.base === "operatorUnbound" && drawn.allow && credentials.length > 0,
			"the allow flag sends to an unbound base"
		],
		[
			Option.exists(chosen, (alt) =>
				Option.exists(Arr.head(drawn.requirement), (head) => head !== alt)
			),
			"an alternative falls through"
		],
		[called.outcome.kind === "missing", "CredentialMissing before any request"],
		[drawn.deprecated === "withId", "a deprecated operation named by its id"],
		[drawn.deprecated === "withoutId", "a deprecated operation named by method and path"],
		[drawn.deprecated === "false", "deprecated: false writes nothing"],
		[called.outcome.kind === "apiError", "an echoed credential scrubbed"]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

/** One operation's AUTH help: the schemes the document defines, and the operation's alternatives over them. */
export type AuthHelp = Readonly<{
	schemes: ReadonlyArray<readonly [name: string, deprecated: boolean]>
	alternatives: ReadonlyArray<ReadonlyArray<string>>
	declared: boolean
}>

const HELP_NAMES = ["old", "current", "legacyKey", "apiKey"] as const

/** AUTH help cases: a few apiKey header schemes, some deprecated, and alternatives that may name an undefined one. */
export const authHelps: Gen<AuthHelp> = (drawn) => ({
	schemes: uniqueArray(
		element(HELP_NAMES),
		(name) => map(boolean, (deprecated) => [name, deprecated] as const),
		{ min: 0, max: 3 }
	)(drawn),
	alternatives: array(subset(HELP_NAMES, { min: 0, max: 2 }), { min: 0, max: 3 })(drawn),
	declared: boolean(drawn)
})

/** AUTH help cases constructed for each situation: a scheme deprecated or current, `{}`, an undefined name, none. */
export const authArms = {
	deprecated: map(authHelps, (drawn): AuthHelp => ({
		...drawn,
		schemes: [["old", true]],
		alternatives: [["old"], ...drawn.alternatives]
	})),
	current: map(authHelps, (drawn): AuthHelp => ({
		...drawn,
		schemes: [["current", false]],
		alternatives: [["current"], ...drawn.alternatives]
	})),
	anonymous: map(authHelps, (drawn): AuthHelp => ({
		...drawn,
		alternatives: [[], ...drawn.alternatives]
	})),
	undefinedName: map(authHelps, (drawn): AuthHelp => ({
		...drawn,
		schemes: Arr.filter(drawn.schemes, ([name]) => name !== "legacyKey"),
		alternatives: [["legacyKey"], ...drawn.alternatives]
	})),
	none: map(authHelps, (drawn): AuthHelp => ({ ...drawn, alternatives: [] }))
} as const

const origin = { document: "file:///spec.json", pointer: "/paths/~1x/get" } as const

const decodeScheme = Schema.decodeUnknownEffect(SecurityScheme)

const decodeOperation = Schema.decodeUnknownEffect(Operation)

/** The AUTH line the model expects: `no authentication` for `{}`, each use as its name, kind and deprecated mark. */
export const expectedAuth = (drawn: AuthHelp): string => {
	if (drawn.alternatives.length === 0) {
		return drawn.declared ? "no authentication" : "no authentication documented"
	}
	const defined = new Map(drawn.schemes)
	return Arr.join(
		Arr.map(drawn.alternatives, (alt) =>
			alt.length === 0
				? "no authentication"
				: Arr.join(
						Arr.map(alt, (name) =>
							Option.match(Option.fromNullishOr(defined.get(name)), {
								onNone: () => name,
								onSome: (deprecated) =>
									`${name} (apiKey header X-Key)${deprecated ? " [deprecated]" : ""}`
							})
						),
						" and "
					)
		),
		" or "
	)
}

/** The AUTH line `operationHelp` writes for the case. */
export const actualAuth = (drawn: AuthHelp) =>
	Effect.gen(function* () {
		const schemes = yield* Effect.forEach(drawn.schemes, ([name, deprecated]) =>
			decodeScheme({
				credentialSources: ["env"],
				deprecated,
				kind: { in: "header", name: "X-Key", type: "apiKey" },
				name,
				origin,
				rows: ["SSC-11"],
				source: "spec"
			})
		)
		const operation = yield* decodeOperation({
			deprecated: false,
			docs: {},
			key: { method: "GET", path: "/x" },
			origin,
			parameters: [],
			responses: [],
			rows: ["OPR-01"],
			security: {
				alternatives: Arr.map(drawn.alternatives, (alt) => ({
					uses: Arr.map(alt, (scheme) => ({ scheme, scopes: [] }))
				})),
				declared: drawn.declared,
				origin,
				rows: ["SSC-11"]
			},
			servers: [],
			tags: []
		})
		const help = operationHelp({ credentials: [], diagnostics: [], flags: [], operation, schemes })
		return Option.getOrElse(
			Option.map(
				Arr.findFirst(help.sections, ([title]) => title === "AUTH"),
				([, text]) => text
			),
			() => ""
		)
	})

/** What an AUTH help case reaches. */
export type AuthFeature =
	| "a deprecated scheme marked"
	| "a current scheme unmarked"
	| "an anonymous alternative"
	| "an undefined scheme named"
	| "no alternatives"

/** The situations an AUTH help case reaches. */
export const authFeatures = (drawn: AuthHelp): ReadonlyArray<AuthFeature> => {
	const defined = new Map(drawn.schemes)
	const used = Arr.flatten(drawn.alternatives)
	const facts: ReadonlyArray<readonly [boolean, AuthFeature]> = [
		[Arr.some(used, (name) => defined.get(name) === true), "a deprecated scheme marked"],
		[Arr.some(used, (name) => defined.get(name) === false), "a current scheme unmarked"],
		[Arr.some(drawn.alternatives, (alt) => alt.length === 0), "an anonymous alternative"],
		[Arr.some(used, (name) => !defined.has(name)), "an undefined scheme named"],
		[drawn.alternatives.length === 0, "no alternatives"]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}
