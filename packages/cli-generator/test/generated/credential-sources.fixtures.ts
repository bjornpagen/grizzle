import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import {
	aimed,
	boolean,
	characterOf,
	constant,
	element,
	finite,
	type FiniteSpace,
	type Gen,
	string
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Option,
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
	runBin,
	workerFixture
} from "#test/support/cli-package.ts"
import { valuesOf, type WireRequest } from "#test/support/http.ts"
import { printedText } from "#test/support/printed.ts"
import { latin1Bytes } from "#test/support/wire.ts"

/** What the credential-sources properties (credential-sources.test.ts) draw and their fixture: the box's runs. */

/** The schemes of the box, one per kind and place a credential travels. */
type Scheme = "bearerAuth" | "basicAuth" | "headerKey" | "queryKey" | "cookieKey" | "oauth" | "oidc"

/** Every scheme of the box. */
export const SCHEMES: Arr.NonEmptyReadonlyArray<Scheme> = [
	"bearerAuth",
	"basicAuth",
	"headerKey",
	"queryKey",
	"cookieKey",
	"oauth",
	"oidc"
]

/** Each scheme's credential setting and file flag, as `<PREFIX>_<SCHEME>` and `--<scheme>-file` spell them. */
export const NAMES: Readonly<Record<Scheme, Readonly<{ env: string; flag: string }>>> = {
	bearerAuth: { env: "CRED_BEARER_AUTH", flag: "--bearer-auth-file" },
	basicAuth: { env: "CRED_BASIC_AUTH", flag: "--basic-auth-file" },
	headerKey: { env: "CRED_HEADER_KEY", flag: "--header-key-file" },
	queryKey: { env: "CRED_QUERY_KEY", flag: "--query-key-file" },
	cookieKey: { env: "CRED_COOKIE_KEY", flag: "--cookie-key-file" },
	oauth: { env: "CRED_OAUTH", flag: "--oauth-file" },
	oidc: { env: "CRED_OIDC", flag: "--oidc-file" }
}

/** The scopes the token schemes' requirements and flows name, which no request may carry. */
const SCOPES: ReadonlyArray<string> = [
	"pets:read",
	"pets:write",
	"pets:admin",
	"openid",
	"profile:read"
]

/** The landing response's JSON. */
const landed = {
	content: { "application/json": { schema: { type: "object" } } },
	description: "Landed."
} as const

/** The document: one GET per scheme at `/s/<scheme>`, each requiring that scheme alone; flow URLs name `origin`. */
const specOf = (origin: string): string =>
	jsonText({
		openapi: "3.1.0",
		info: { title: "Credential sources", version: "1.0.0" },
		paths: Rec.fromEntries(
			Arr.map(SCHEMES, (scheme) => [
				`/s/${scheme}`,
				{
					get: {
						operationId: `get-${scheme}`,
						security: [
							{
								[scheme]:
									scheme === "oauth"
										? ["pets:read", "pets:write"]
										: scheme === "oidc"
											? ["openid", "profile:read"]
											: []
							}
						],
						responses: { "200": landed }
					}
				}
			])
		),
		components: {
			securitySchemes: {
				bearerAuth: { type: "http", scheme: "bearer" },
				basicAuth: { type: "http", scheme: "basic" },
				headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
				queryKey: { type: "apiKey", in: "query", name: "api_key" },
				cookieKey: { type: "apiKey", in: "cookie", name: "session" },
				oauth: {
					type: "oauth2",
					flows: {
						clientCredentials: {
							tokenUrl: `${origin}/flow/token`,
							scopes: { "pets:admin": "Administer pets" }
						},
						authorizationCode: {
							authorizationUrl: `${origin}/flow/authorize`,
							tokenUrl: `${origin}/flow/token`,
							refreshUrl: `${origin}/flow/refresh`,
							scopes: { "pets:read": "Read pets", "pets:write": "Write pets" }
						}
					}
				},
				oidc: {
					type: "openIdConnect",
					openIdConnectUrl: `${origin}/flow/.well-known/openid-configuration`
				}
			}
		}
	})

/** The author config, binding exactly the capture server's origin. */
const configOf = (bound: string): string =>
	jsonText({
		package: { name: "credential-sources", version: "1.0.0" },
		binName: "cred",
		envPrefix: "CRED",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** Where a run's credential comes from: its setting, a file, stdin, or nowhere. */
type Source = "the environment" | "a file" | "stdin" | "no source"

/** A planted fault, from the family the scheme's carrier refuses. */
type Fault = "a line break" | "an edge space" | "no colon" | "a cookie separator"

/** A credential value: one its carrier admits, or one with a planted fault. */
type Value =
	| Readonly<{ kind: "valid"; text: string }>
	| Readonly<{ kind: "faulty"; fault: Fault; text: string }>

/** One run: the scheme, where its credential comes from, the value, and whether a file or stdin ends it with a line end. */
type Case = Readonly<{ scheme: Scheme; source: Source; value: Value; lineEnd: boolean }>

/** The schemes whose value travels in a header: it may hold an inner space and characters up to U+00FF. */
const HEADER_SCHEMES: Arr.NonEmptyReadonlyArray<Scheme> = [
	"bearerAuth",
	"headerKey",
	"oauth",
	"oidc"
]

/**
 * Header-safe text: no edge space, an inner space where `spaced` draws one, and characters up to U+00FF, an é at
 * its start where `accented` is set.
 */
const headerTextOf =
	(spaced: Gen<boolean>, accented: boolean): Gen<string> =>
	(source) => {
		const drawn = string(characterOf(["a", "Z", "0", "-", ".", "_", "~", "+", "/", "=", "é"]), {
			min: 8,
			max: 12
		})(source)
		const core = accented ? `é${Str.slice(1)(drawn)}` : drawn
		return spaced(source) ? `${Str.slice(0, 4)(core)} ${Str.slice(4)(core)}` : core
	}

/** Header-safe text, an inner space half the time. */
const headerText: Gen<string> = headerTextOf(boolean, false)

/** Text of URL-unreserved characters, sent in the query as written. */
const queryText: Gen<string> = string(characterOf(["a", "Z", "0", "-", ".", "_", "~"]), {
	min: 8,
	max: 12
})

/** RFC 6265 cookie octets: no space, double quote, comma, semicolon or backslash. */
const cookieText: Gen<string> = string(
	characterOf([
		"a",
		"Z",
		"0",
		"!",
		"#",
		"$",
		"%",
		"&",
		"'",
		"(",
		")",
		"*",
		"+",
		"-",
		".",
		"/",
		":",
		"<",
		"=",
		">",
		"?",
		"@",
		"[",
		"]",
		"^",
		"_",
		"`",
		"{",
		"|",
		"}",
		"~"
	]),
	{ min: 8, max: 12 }
)

/** A basic credential: a user id without a colon, then a password that may hold one. */
const basicText: Gen<string> = (source) =>
	`${string(characterOf(["a", "Z", "0", "-", "_"]), { min: 4, max: 6 })(source)}:${string(characterOf(["a", "Z", "0", ":", "!", "-"]), { min: 4, max: 8 })(source)}`

/** The value a scheme's carrier admits. */
const validText = (scheme: Scheme): Gen<string> => {
	switch (scheme) {
		case "queryKey":
			return queryText
		case "cookieKey":
			return cookieText
		case "basicAuth":
			return basicText
		case "bearerAuth":
		case "headerKey":
		case "oauth":
		case "oidc":
			return headerText
	}
}

/** The schemes whose carrier refuses a fault: header carriers a line break or an edge space, basic a missing colon, a cookie a separator. */
const schemesRefusing = (fault: Fault): Arr.NonEmptyReadonlyArray<Scheme> => {
	switch (fault) {
		case "a line break":
		case "an edge space":
			return ["bearerAuth", "headerKey", "oauth", "oidc"]
		case "no colon":
			return ["basicAuth"]
		case "a cookie separator":
			return ["cookieKey"]
	}
}

/** A valid value with the fault planted in it. */
const plant = (fault: Fault, text: string): string => {
	switch (fault) {
		case "a line break":
			return `${Str.slice(0, 4)(text)}\n${Str.slice(4)(text)}`
		case "an edge space":
			return ` ${text}`
		case "no colon":
			return Str.replaceAll(":", "")(text)
		case "a cookie separator":
			return `${Str.slice(0, 4)(text)};${Str.slice(4)(text)}`
	}
}

/** The value each scheme's runs from every source carry, and its planted faults are planted in: a simple one its carrier admits. */
const BASE: Readonly<Record<Scheme, string>> = {
	bearerAuth: "token-0001",
	basicAuth: "user:pass",
	headerKey: "token-0002",
	queryKey: "query-0003",
	cookieKey: "cookie-0004",
	oauth: "token-0005",
	oidc: "token-0006"
}

/** Whether a run ends its value with a line end: only a file or stdin can, so only they draw it. */
const lineEndOf =
	(from: Source): Gen<boolean> =>
	(source) =>
		from === "a file" || from === "stdin" ? boolean(source) : false

/** A run of a scheme's simple value from one source, or with no credential at all. */
const sourceCaseOf =
	(from: Source): Gen<Case> =>
	(source) => {
		const scheme = source.draw(element(SCHEMES))
		return {
			scheme,
			source: from,
			value: { kind: "valid", text: BASE[scheme] },
			lineEnd: lineEndOf(from)(source)
		}
	}

/** A run of a value its scheme's carrier admits, from the environment. */
const valueCaseOf =
	(scheme: Scheme, text: Gen<string>): Gen<Case> =>
	(source) => ({
		scheme,
		source: "the environment",
		value: { kind: "valid", text: text(source) },
		lineEnd: false
	})

/** A run of the value a drawn scheme's carrier admits. */
const anyValueCase: Gen<Case> = (source) => {
	const scheme = source.draw(element(SCHEMES))
	return source.draw(valueCaseOf(scheme, validText(scheme)))
}

/** A run of a drawn header scheme's value, `text`. */
const headerValueCase =
	(text: Gen<string>): Gen<Case> =>
	(source) =>
		source.draw(valueCaseOf(source.draw(element(HEADER_SCHEMES)), text))

/** A planted fault's run: a fault of the given families, a scheme whose carrier refuses it, and a source that delivers it. */
const faultCaseOf =
	(families: Arr.NonEmptyReadonlyArray<Fault>): Gen<Case> =>
	(source) => {
		const fault = element(families)(source)
		const scheme = element(schemesRefusing(fault))(source)
		return {
			scheme,
			source: element<Source>(["the environment", "a file", "stdin"])(source),
			value: { kind: "faulty", fault, text: plant(fault, BASE[scheme]) },
			lineEnd: false
		}
	}

/** What a request carried of the credentials, as the oracle compares it. */
type Carried = Readonly<{
	target: string
	authorization: ReadonlyArray<readonly [scheme: string, credential: string]>
	apiKey: ReadonlyArray<string>
	cookie: ReadonlyArray<string>
	scopes: ReadonlyArray<string>
}>

/** An Authorization value split at its first space: the scheme word, then the credential. */
const schemeAndCredential = (value: string): readonly [scheme: string, credential: string] =>
	Option.match(Str.indexOf(" ")(value), {
		onNone: () => [value, ""],
		onSome: (space) => [Str.slice(0, space)(value), Str.slice(space + 1)(value)]
	})

/** What a recorded request carried, and the scope names its whole text holds. */
export const carriedOf = (request: WireRequest): Carried => {
	const text = Arr.join(
		Arr.appendAll(
			[request.target, Buffer.from(request.body).toString("latin1")],
			Arr.flatten(request.headers)
		),
		"\n"
	)
	return {
		target: request.target,
		authorization: Arr.map(valuesOf(request.headers, "authorization"), schemeAndCredential),
		apiKey: valuesOf(request.headers, "x-api-key"),
		cookie: valuesOf(request.headers, "cookie"),
		scopes: Arr.filter(SCOPES, (scope) => Str.includes(scope)(text))
	}
}

/** What the scheme's credential puts on the request, and nothing else. */
export const expectedCarried = (scheme: Scheme, text: string): Carried => {
	const none: Carried = {
		target: `/s/${scheme}`,
		authorization: [],
		apiKey: [],
		cookie: [],
		scopes: []
	}
	switch (scheme) {
		case "bearerAuth":
		case "oauth":
		case "oidc":
			return { ...none, authorization: [["Bearer", text]] }
		case "basicAuth":
			return { ...none, authorization: [["Basic", Buffer.from(text, "utf8").toString("base64")]] }
		case "headerKey":
			return { ...none, apiKey: [text] }
		case "queryKey":
			return { ...none, target: `/s/${scheme}?api_key=${text}` }
		case "cookieKey":
			return { ...none, cookie: [`session=${text}`] }
	}
}

/** What a run did, as the oracle compares it: the exit code, what each request carried, and the value's leaks. */
export type Outcome = Readonly<{
	exitCode: number
	requests: ReadonlyArray<Carried>
	leaked: boolean
}>

/**
 * The run the contract gives: no credential, exit 3 and no request; a planted fault, exit 2 and no request; a valid
 * credential, exit 0 and one request carrying it. The value never leaks.
 */
const expectedOf = (c: Case): Outcome => {
	if (c.source === "no source") {
		return { exitCode: 3, requests: [], leaked: false }
	}
	return c.value.kind === "faulty"
		? { exitCode: 2, requests: [], leaked: false }
		: { exitCode: 0, requests: [expectedCarried(c.scheme, c.value.text)], leaked: false }
}

/** The landing: an empty JSON object. */
export const landing: ScriptedResponse = {
	status: 200,
	headers: [["Content-Type", "application/json"]],
	delay: Duration.zero,
	body: { kind: "complete", bytes: latin1Bytes("{}") }
}

export type CredentialFeature =
	| Scheme
	| Source
	| Fault
	| "a value ending in a line end"
	| "a value holding a space"
	| "a value beyond ASCII"

/** The features a run reaches. */
export const caseFeatures = (c: Case): ReadonlyArray<CredentialFeature> =>
	Arr.flatten<ReadonlyArray<ReadonlyArray<CredentialFeature>>>([
		[c.scheme, c.source],
		c.value.kind === "faulty" && c.source !== "no source" ? [c.value.fault] : [],
		c.lineEnd && (c.source === "a file" || c.source === "stdin")
			? ["a value ending in a line end"]
			: [],
		c.value.kind === "valid" && Str.includes(" ")(c.value.text) && c.source !== "no source"
			? ["a value holding a space"]
			: [],
		c.value.kind === "valid" &&
		Arr.some(Arr.fromIterable(c.value.text), (character) => character > "\u007f") &&
		c.source !== "no source"
			? ["a value beyond ASCII"]
			: []
	])

/** What a run needs from the suite: the server, the package, its commands, the file system and the credential file. */
type Runner = Readonly<{
	server: CaptureServer
	built: BuiltPackage
	commands: Readonly<Record<Scheme, ReadonlyArray<string>>>
	fs: FileSystem.FileSystem
	file: string
}>

/** Runs a case's command with its credential from its source, and checks the run against the contract. */
export const checkRun = Effect.fn("credentialSources.check")(function* (c: Case, runner: Runner) {
	const names = NAMES[c.scheme]
	const written = c.lineEnd ? `${c.value.text}\n` : c.value.text
	if (c.source === "a file") {
		yield* runner.fs.writeFileString(runner.file, written)
	}
	const observed = yield* runner.server.observe(
		() => landing,
		runBin(runner.built, {
			args: Arr.flatten([
				runner.commands[c.scheme],
				["--base-url", runner.server.origins["127.0.0.1"]],
				c.source === "a file"
					? [names.flag, runner.file]
					: c.source === "stdin"
						? [names.flag, "-"]
						: []
			]),
			env: c.source === "the environment" ? { [names.env]: c.value.text } : {},
			stdin: c.source === "stdin" ? new TextEncoder().encode(written) : new Uint8Array(0)
		})
	)
	const printed = `${printedText(observed.result.stdout)}${printedText(observed.result.stderr)}`
	assert.deepEqual<Outcome>(
		{
			exitCode: observed.result.exitCode,
			requests: Arr.map(observed.requests, carriedOf),
			leaked: Str.includes(Str.trim(c.value.text))(printed)
		},
		expectedOf(c),
		"the credential goes exactly where its scheme says, a fault or a missing credential sends nothing, and the value is never printed"
	)
})

/** The suite's fixture, once per worker: the capture server, the package built against it, and each scheme's command. */
export const credentialFixture = workerFixture(
	"test/generated/credential-sources.fixtures.ts credentialFixture",
	Effect.gen(function* () {
		const server = yield* captureServer
		const origin = server.origins["127.0.0.1"]
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: specOf(origin) },
			config: { path: "author-config.json", text: configOf(origin) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const commands = yield* Effect.all(
			Rec.map(NAMES, (_names, scheme) =>
				Effect.map(
					Effect.fromOption(
						Arr.findFirst(
							generated.result.report.commandNames,
							(name) => name.pointer === `/paths/~1s~1${scheme}/get`
						)
					),
					(name) => name.path
				)
			)
		)
		const opened: Readonly<{
			server: CaptureServer
			built: BuiltPackage
			commands: Readonly<Record<Scheme, ReadonlyArray<string>>>
		}> = { server, built, commands }
		return opened
	})
)

/** Every source a run's credential may come from. */
const SOURCES: Arr.NonEmptyReadonlyArray<Source> = [
	"the environment",
	"a file",
	"stdin",
	"no source"
]

/** What a source's cases must reach: every scheme, the source, and a last line end where the source can hold one. */
const sourceFeatures = (from: Source): Arr.NonEmptyReadonlyArray<CredentialFeature> =>
	Arr.appendAll(
		Arr.append(SCHEMES, from),
		from === "a file" || from === "stdin" ? ["a value ending in a line end" as const] : []
	)

/** Every planted fault family a carrier refuses. */
const FAULTS: Arr.NonEmptyReadonlyArray<Fault> = [
	"a line break",
	"an edge space",
	"no colon",
	"a cookie separator"
]

/** Every scheme's simple credential from every source, with and without a last line end where it can hold one. */
export const sourceCases: FiniteSpace<Case> = finite((source) =>
	source.draw(sourceCaseOf(source.draw(element(SOURCES))))
)

/** What the source cases must reach: every scheme, every source, and a last line end. */
export const SOURCE_FEATURES: ReadonlyArray<CredentialFeature> = Arr.dedupe(
	Arr.flatMap(SOURCES, sourceFeatures)
)

/** Every fault of every family, under each scheme whose carrier refuses it, from the environment, a file and stdin. */
export const faultCases: FiniteSpace<Case> = finite(faultCaseOf(FAULTS))

/** What the fault cases must reach: every family and every source that delivers a value. */
export const FAULT_FEATURES: ReadonlyArray<CredentialFeature> = [
	...FAULTS,
	"the environment",
	"a file",
	"stdin"
]

/** Any value a drawn scheme's carrier admits; a case aimed at a pending scheme or value, from one made to reach it. */
export const valueCases = aimed(anyValueCase, [
	...Arr.map(SCHEMES, (scheme) => [scheme, valueCaseOf(scheme, validText(scheme))] as const),
	["a value holding a space", headerValueCase(headerTextOf(constant(true), false))],
	["a value beyond ASCII", headerValueCase(headerTextOf(boolean, true))]
])

/** A prompt's run: the scheme it asks for and the text typed. */
type Typed = Readonly<{ scheme: Scheme; text: string }>

/** The prompt run of `scheme`, the text typed one its carrier admits. */
const typedOf =
	(scheme: Gen<Scheme>): Gen<Typed> =>
	(source) => {
		const drawn = source.draw(scheme)
		return { scheme: drawn, text: source.draw(validText(drawn)) }
	}

/** A drawn scheme's prompt run; a case aimed at a pending scheme, from that scheme's. */
export const typedCases = aimed(
	typedOf(element(SCHEMES)),
	Arr.map(SCHEMES, (scheme) => [scheme, typedOf(constant(scheme))] as const)
)

/** The one help page the box holds: the root's. */
export const rootHelp: FiniteSpace<"--help"> = finite(constant("--help"))
