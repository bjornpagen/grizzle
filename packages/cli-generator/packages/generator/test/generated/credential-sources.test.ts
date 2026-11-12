/**
 * A generated CLI reads each scheme's credential from wherever the operator put it and sends it where the scheme says,
 * refuses a credential no request could carry, and refuses a run that needs a credential it was not given.
 *
 * - The box: one operation per scheme kind (http bearer and basic, apiKey in a header, the query and a cookie, oauth2
 *   with scopes and flows whose URLs name the capture server, openIdConnect).
 * - Sources, an exhaustion: every scheme with a simple value from the environment, a file or stdin (with and without a
 *   last line end, which is dropped), or with no credential at all.
 * - Values, a property: any value the scheme's carrier admits, an inner space and characters past ASCII among them, for
 *   a drawn scheme, or, while schemes are pending, one of them.
 * - Faults, an exhaustion: one planted fault of each family a carrier refuses (a line break or an edge space in a
 *   header, a basic credential without its colon, a cookie value with a separator), from every source. Oracles: one
 *   request to the operation, the credential in exactly the scheme's place (`Authorization` with the scheme word, the
 *   header, the query parameter, the cookie) and no other credential; no scope name anywhere in it and no request to a
 *   flow's URL; exit 3 and no request without a credential, exit 2 and no request for a planted fault; and the
 *   credential's value nowhere in what the run prints.
 *
 * Plants (local only, reverted): input.ts stripLineEnd keeping a credential file's line end; auth.ts appendCookie
 * joining the cookie's name and value with a colon.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import { drawn, exhaust, explore } from "@superstarter/testing/explore"
import { required, requiredInSpace } from "@superstarter/testing/features"
import { boolean, characterOf, element, type Gen, string } from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
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
	harnessLayer,
	runBin
} from "#test/support/cli-package.ts"
import { valuesOf, type WireRequest } from "#test/support/http.ts"
import { latin1Bytes } from "#test/support/wire.ts"

/** The schemes of the box, one per kind and place a credential travels. */
type Scheme = "bearerAuth" | "basicAuth" | "headerKey" | "queryKey" | "cookieKey" | "oauth" | "oidc"

/** Every scheme of the box. */
const SCHEMES: Arr.NonEmptyReadonlyArray<Scheme> = [
	"bearerAuth",
	"basicAuth",
	"headerKey",
	"queryKey",
	"cookieKey",
	"oauth",
	"oidc"
]

/** Each scheme's credential setting and file flag, as `<PREFIX>_<SCHEME>` and `--<scheme>-file` spell them. */
const NAMES: Readonly<Record<Scheme, Readonly<{ env: string; flag: string }>>> = {
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
}

/** The document: one GET per scheme at `/s/<scheme>`, each requiring that scheme alone; flow URLs name `origin`. */
const specOf = (origin: string): string =>
	jsonTextOf({
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
	jsonTextOf({
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

/** Header-safe text: no edge space, an inner space maybe, and characters up to U+00FF. */
const headerText: Gen<string> = (source) => {
	const core = string(characterOf(["a", "Z", "0", "-", ".", "_", "~", "+", "/", "=", "é"]), {
		min: 8,
		max: 12
	})(source)
	return boolean(source) ? `${Str.slice(0, 4)(core)} ${Str.slice(4)(core)}` : core
}

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
		const scheme = element(SCHEMES)(source)
		return {
			scheme,
			source: from,
			value: { kind: "valid", text: BASE[scheme] },
			lineEnd: lineEndOf(from)(source)
		}
	}

/** A run of any value its scheme's carrier admits, from the environment, for a scheme the property may aim. */
const valueCaseOf =
	(scheme: Scheme): Gen<Case> =>
	(source) => ({
		scheme,
		source: "the environment",
		value: { kind: "valid", text: validText(scheme)(source) },
		lineEnd: false
	})

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
const carriedOf = (request: WireRequest): Carried => {
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
const expectedCarried = (scheme: Scheme, text: string): Carried => {
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
type Outcome = Readonly<{ exitCode: number; requests: ReadonlyArray<Carried>; leaked: boolean }>

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
const landing: ScriptedResponse = {
	status: 200,
	headers: [["Content-Type", "application/json"]],
	delay: Duration.zero,
	body: { kind: "complete", bytes: latin1Bytes("{}") }
}

type CredentialFeature =
	| Scheme
	| Source
	| Fault
	| "a value ending in a line end"
	| "a value holding a space"
	| "a value beyond ASCII"

/** The features a run reaches. */
const caseFeatures = (c: Case): ReadonlyArray<CredentialFeature> =>
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
const checkRun = Effect.fn("credentialSources.check")(function* (c: Case, runner: Runner) {
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
	const printed = `${new TextDecoder().decode(observed.result.stdout)}${new TextDecoder().decode(observed.result.stderr)}`
	deepStrictEqual<Outcome>(
		{
			exitCode: observed.result.exitCode,
			requests: Arr.map(observed.requests, carriedOf),
			leaked: Str.includes(Str.trim(c.value.text))(printed)
		},
		expectedOf(c),
		"the credential goes exactly where its scheme says, a fault or a missing credential sends nothing, and the value is never printed"
	)
})

/** The suite's fixture: the capture server, the package built against it, and each scheme's command. */
class CredentialFixture extends Context.Service<
	CredentialFixture,
	Readonly<{
		server: CaptureServer
		built: BuiltPackage
		commands: Readonly<Record<Scheme, ReadonlyArray<string>>>
	}>
>()("effect-openapi-cli-generator/test/generated/credential-sources.test/CredentialFixture") {}

const fixture = Layer.effect(
	CredentialFixture,
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
		return { server, built, commands }
	})
).pipe(Layer.provideMerge(harnessLayer))

/** Every source a run's credential may come from. */
const SOURCES: Arr.NonEmptyReadonlyArray<Source> = [
	"the environment",
	"a file",
	"stdin",
	"no source"
]

/** The planted fault families, grouped so each group's exhaustion stays small. */
const FAULT_GROUPS: ReadonlyArray<Arr.NonEmptyReadonlyArray<Fault>> = [
	["a line break"],
	["an edge space"],
	["no colon", "a cookie separator"]
]

/** What a source's exhaustion must reach: every scheme, the source, and a last line end where the source can hold one. */
const sourceFeatures = (from: Source): Arr.NonEmptyReadonlyArray<CredentialFeature> =>
	Arr.appendAll(
		Arr.append(SCHEMES, from),
		from === "a file" || from === "stdin" ? ["a value ending in a line end" as const] : []
	)

/** Checks the contract on every case of a small box of runs, against the suite's built package. */
const exhaustRuns = (
	suite: string,
	generator: Gen<Case>,
	situations: Arr.NonEmptyReadonlyArray<CredentialFeature>
) =>
	Effect.gen(function* () {
		const { server, built, commands } = yield* CredentialFixture
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "credential-box-" })
		return yield* exhaust(
			{
				suite,
				generator,
				literal: Formatter.format,
				limit: 32,
				coverage: requiredInSpace<CredentialFeature>(situations),
				caseHang: Duration.seconds(60)
			},
			(c, k) =>
				Effect.gen(function* () {
					k.noteAll(caseFeatures(c))
					yield* checkRun(c, {
						server,
						built,
						commands,
						fs,
						file: path.join(scratch, "credential")
					})
				})
		)
	}).pipe(Effect.scoped)

layer(fixture, { excludeTestServices: true })("a generated CLI's credentials", (it) => {
	Arr.forEach(SOURCES, (from) => {
		it.effect(`go where their scheme says from ${from}, and nowhere else`, (ctx) =>
			searched(
				ctx,
				exhaustRuns(`credential sources: ${from}`, sourceCaseOf(from), sourceFeatures(from))
			)
		)
	})

	it.effect("carry any value their scheme's carrier admits exactly as given", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { server, built, commands } = yield* CredentialFixture
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "credential-values-" })
				return yield* explore(
					{
						suite: "credential values",
						draw: drawn(element(SCHEMES)),
						literal: Formatter.format,
						coverage: required<CredentialFeature>(
							[...SCHEMES, "a value holding a space", "a value beyond ASCII"],
							{ cases: 20, sense: notesOnly }
						),
						kept: [],
						runs: 8,
						shrink: { kind: "bounded", candidates: 30 },
						concurrency: 1,
						steerEvery: 2,
						caseHang: Duration.seconds(60)
					},
					(drawnScheme, k) =>
						Effect.gen(function* () {
							const scheme = Option.match(
								Option.flatMap(k.steering, (pending) =>
									Arr.match(
										Arr.filter(SCHEMES, (candidate) => pending.names(candidate)),
										{
											onEmpty: () => Option.none(),
											onNonEmpty: (pendingSchemes) => Option.some(pendingSchemes)
										}
									)
								),
								{
									onNone: () => drawnScheme,
									onSome: (pendingSchemes) => k.draw(element(pendingSchemes))
								}
							)
							const c = k.draw(valueCaseOf(scheme))
							k.noteAll(caseFeatures(c))
							yield* checkRun(c, {
								server,
								built,
								commands,
								fs,
								file: path.join(scratch, "credential")
							})
						})
				)
			}).pipe(Effect.scoped)
		)
	)

	Arr.forEach(FAULT_GROUPS, (families) => {
		it.effect(
			`refuse ${Arr.join(families, " and ")} before any request, from every source`,
			(ctx) =>
				searched(
					ctx,
					exhaustRuns(
						`credential faults: ${Arr.join(families, ", ")}`,
						faultCaseOf(families),
						Arr.appendAll(families, ["the environment", "a file", "stdin"])
					)
				)
		)
	})
})
