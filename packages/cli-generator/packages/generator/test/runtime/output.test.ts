import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import {
	Cause,
	ConfigProvider,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Path,
	Redacted,
	Runtime,
	Sink,
	Stdio,
	Stream
} from "effect"
import { CliError } from "effect/cli"
import type { GlobalFlag } from "effect/cli"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import {
	ApiResponseError,
	CredentialMissing,
	OutputError as OutputErrorClass,
	TransportError,
	UsageError
} from "#runtime-src/domain/errors.ts"
import * as Auth from "#runtime-src/runtime/auth.ts"
import type { Credential } from "#runtime-src/runtime/auth.ts"
import * as BaseUrl from "#runtime-src/runtime/base-url.ts"
import { Transport } from "#runtime-src/runtime/client.ts"
import * as Input from "#runtime-src/runtime/input.ts"
import {
	ClientPolicy,
	dryRunSetting,
	Force,
	InternalError,
	OutputPath,
	finalCatch,
	readErrorBody,
	renderError,
	sanitize,
	send,
	valueFreeFormatter
} from "#runtime-src/runtime/output.ts"
import type { OperationMeta, ResponseBody } from "#runtime-src/runtime/output.ts"
import { queryWireForm, runCredentialsLayer, scrub } from "#runtime-src/runtime/redact.ts"
import { mapClientError } from "#runtime-src/runtime/response.ts"
import * as Serialize from "#runtime-src/runtime/serialize.ts"

const inDir = <A>(use: (dir: string, fs: FileSystem.FileSystem, path: Path.Path) => Promise<A>) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* step1() {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const dir = yield* fs.makeTempDirectoryScoped({ prefix: "rt6a-" })

				return yield* Effect.promise(() => use(dir, fs, path))
			})
		).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
	)

const failure = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
	Option.getOrUndefined(Exit.findErrorOption(exit))

const reasonOf = (error: { readonly _tag: string } | undefined) =>
	error instanceof OutputErrorClass ? error.reason : undefined

const canary = "CANARY-SECRET-123"

const bearer: Credential = {
	definition: { kind: "http", scheme: "bearer" },
	scheme: "bearer",
	value: Redacted.make(canary)
}

const utf8 = new TextEncoder()

const utf8Length = (text: string): number => utf8.encode(text).length

const chunked = (text: string, size: number): Stream.Stream<Uint8Array> => {
	const all = utf8.encode(text)
	const chunks: Uint8Array[] = []

	for (let at = 0; at < all.length; at += size) {
		chunks.push(all.subarray(at, at + size))
	}

	return Stream.fromIterable(chunks)
}

const bodyOf = (text: string, chunkSize = 1000) =>
	Effect.runPromise(readErrorBody(chunked(text, chunkSize), [bearer]))

const responseError = (fields: Partial<ConstructorParameters<typeof ApiResponseError>[0]> = {}) =>
	new ApiResponseError({
		body: "",
		matched: "404",
		operation: "users.get",
		status: 404,
		...fields
	})

const runCatch = <A, E>(program: Effect.Effect<A, E, Stdio.Stdio>, credentials = [bearer]) => {
	const stderr: Buffer[] = []
	const layer = Stdio.layerTest({
		stderr: () =>
			Sink.forEach((chunk: string | Uint8Array) =>
				Effect.sync(() => {
					stderr.push(Buffer.from(chunk))
				})
			)
	})

	return Effect.runPromise(
		Effect.exit(finalCatch(credentials)(program)).pipe(
			Effect.provide(Layer.merge(layer, runCredentialsLayer))
		)
	).then((exit) => ({ exit, stderr: Buffer.concat(stderr).toString("utf-8") }))
}

describe("readErrorBody reads the body whole", () => {
	test("a body across many chunks is read to its end", async () => {
		const text = await bodyOf("a".repeat(100_000), 7000)

		expect(text).toBe("a".repeat(100_000))
	})

	test("a character split across chunks is decoded whole", async () => {
		const text = await bodyOf("é".repeat(5000), 7)

		expect(utf8Length(text)).toBe(10_000)
		expect(text).toBe("é".repeat(5000))
	})

	test("a short body is returned whole", async () => {
		expect(await bodyOf("not found")).toBe("not found")
	})
})

describe("credential scrubbing", () => {
	test("a canary echoed in the body is absent and marked", async () => {
		const body = JSON.stringify({ echo: { authorization: `Bearer ${canary}` } })
		const text = await bodyOf(body, 5)

		expect(text).not.toContain(canary)
		expect(text).toContain("<redacted:bearer>")
	})

	test("a canary split across chunks leaves no part of it", async () => {
		const text = await bodyOf(`0123456789${canary}-tail`, 4)

		expect(text).toBe("0123456789<redacted:bearer>-tail")
	})

	test("the longest credential is scrubbed first", () => {
		const longer: Credential = { ...bearer, scheme: "long", value: Redacted.make(`${canary}-X`) }

		expect(scrub(`${canary}-X`, [bearer, longer])).toBe("<redacted:long>")
	})

	test("an empty credential value is ignored", () => {
		const empty: Credential = { ...bearer, value: Redacted.make("") }

		expect(scrub("text", [empty])).toBe("text")
	})
})

const longSecret = "SECRETTOKEN-abcdefghijklmnopqrstuvwxyz01"

const longBearer: Credential = { ...bearer, value: Redacted.make(longSecret) }

const basic: Credential = {
	definition: { kind: "http", scheme: "basic" },
	scheme: "basicAuth",
	value: Redacted.make("alice:pass/word+=CANARY")
}

const queryKey: Credential = {
	definition: { in: "query", kind: "apiKey", name: "api_key" },
	scheme: "apiKey",
	value: Redacted.make("key/with+plus=CANARY&")
}

const bodyWith = (text: string, credentials: readonly Credential[]) =>
	Effect.runPromise(readErrorBody(chunked(text, 7), credentials))

/**
 * The longest non-empty prefix of `secret` that `text` ends with, or "" when there is none.
 */
const trailingPrefix = (text: string, secret: string): string => {
	for (let size = secret.length; size > 0; size -= 1) {
		if (text.endsWith(secret.slice(0, size))) {
			return secret.slice(0, size)
		}
	}

	return ""
}

// The Authorization header exactly as HttpClientRequest.basicAuth sends it.
const basicHeader = (): string => {
	const sent = HttpClientRequest.basicAuth(
		HttpClientRequest.get("https://api.example.com"),
		"alice",
		"pass/word+=CANARY"
	)

	return sent.headers.authorization ?? ""
}

// The query string exactly as the client writes an apiKey query credential.
const queryWire = (): string => `api_key=${queryWireForm("key/with+plus=CANARY&")}`

// Audit M F1 probe values with each form a server may echo: raw, URLSearchParams, and the bytes
// the request target carries.
const queryProbes = [
	{ raw: "k e y", searchParams: "k+e+y", wire: "k%20e%20y" },
	{ raw: "a!b/c", searchParams: "a%21b%2Fc", wire: "a!b%2Fc" },
	{ raw: "a~b c", searchParams: "a%7Eb+c", wire: "a~b%20c" },
	{ raw: "x'y z", searchParams: "x%27y+z", wire: "x%27y%20z" }
] as const

describe("credential scrubbing across chunks (audit F1)", () => {
	test("a credential longer than its placeholder, split across chunks, leaves no prefix", async () => {
		const body = `${longSecret}${"x".repeat(61)}${longSecret}tail`
		const text = await bodyWith(body, [longBearer])

		expect(text).toContain("<redacted:bearer>")
		expect(text).not.toContain("SECRETTOKEN")
		expect(trailingPrefix(text, longSecret)).toBe("")
	})

	test("a basic token split across chunks leaves no prefix of it", async () => {
		const token = basicHeader().slice("Basic ".length)
		const body = `Basic ${token} ${"y".repeat(40)} Basic ${token}`
		const text = await bodyWith(body, [basic])

		expect(text).not.toContain(token.slice(0, 4))
		expect(trailingPrefix(text, token)).toBe("")
	})
})

describe("every wire form of a credential is scrubbed (audit F2)", () => {
	test("the I4 Authorization echo of a basic credential is scrubbed in the body and render", async () => {
		const echo = basicHeader()
		const token = echo.slice("Basic ".length)
		const text = await bodyWith(echo, [basic])
		const rendered = renderError(responseError({ body: echo, status: 401 }), [basic])

		for (const output of [text, rendered]) {
			expect(output).not.toContain(token)
			expect(output).not.toContain("CANARY")
			expect(output).toContain("<redacted:basicAuth>")
		}
	})

	test("the password of a basic credential alone is scrubbed", () => {
		expect(scrub("password was pass/word+=CANARY", [basic])).toBe(
			"password was <redacted:basicAuth>"
		)
	})

	test("a percent-encoded query key echoed in a URL is scrubbed", async () => {
		const url = `https://api.example.com/users?${queryWire()}`
		const text = await bodyWith(`redirected to ${url}`, [queryKey])
		const rendered = renderError(new TransportError({ reason: "connect", url }), [queryKey])

		expect(queryWire()).toContain("%2F")
		for (const output of [text, rendered]) {
			expect(output).not.toContain("CANARY")
			expect(output).toContain("<redacted:apiKey>")
		}
	})
})

describe("every echoed form of a query credential is scrubbed (audit M F1)", () => {
	for (const probe of queryProbes) {
		const credential: Credential = { ...queryKey, value: Redacted.make(probe.raw) }

		for (const form of ["raw", "searchParams", "wire"] as const) {
			test(`${JSON.stringify(probe.raw)} echoed as its ${form} form in a body and request id`, async () => {
				const echo = `api_key=${probe[form]}`
				const text = await bodyWith(`echo ${echo} end`, [credential])
				const rendered = renderError(
					responseError({ body: `echo ${echo} end`, requestId: `id-${probe[form]}` }),
					[credential]
				)

				expect(text).toBe("echo api_key=<redacted:apiKey> end")
				expect(rendered).toContain("Request ID: id-<redacted:apiKey>")
				expect(rendered).not.toContain(probe[form])
			})
		}
	}
})

describe("overlapping credential forms are scrubbed as one run (recheck N1)", () => {
	test("a short form overlapping the start of a longer credential leaves neither in clear", () => {
		const token = "SECRETTOKEN-abcdefghijklmnopqrstuvwxyz01"
		const longToken: Credential = { ...bearer, value: Redacted.make(token) }
		const shortPassword: Credential = { ...basic, value: Redacted.make("alice:word2SECRET") }
		const text = scrub(`echo word2${token} end`, [longToken, shortPassword])

		expect(text).toBe("echo <redacted:basicAuth> end")
		expect(text).not.toContain("word2")
		expect(text).not.toContain("TOKEN")
	})

	test("forms that only touch are replaced once", () => {
		expect(scrub(`[${canary}${canary}]`, [bearer])).toBe("[<redacted:bearer>]")
	})
})

describe("sanitize", () => {})

describe("renderError", () => {
	test("an ApiResponseError shows its line, request id and scrubbed body", () => {
		const text = renderError(
			responseError({ body: `echo ${canary}\u001B[31m`, requestId: "req-1" }),
			[bearer]
		)

		expect(text).toContain("users.get")
		expect(text).toContain("404")
		expect(text).toContain("Request ID: req-1")
		expect(text).toContain("<redacted:bearer>")
		expect(text).not.toContain(canary)
		expect(text).not.toContain("\u001B")
	})

	test("an empty body prints no body section", () => {
		expect(renderError(responseError(), [bearer]).trimEnd().split("\n")).toHaveLength(1)
	})

	test("a credential in a request id or transport URL is scrubbed", () => {
		const api = renderError(responseError({ requestId: `id-${canary}` }), [bearer])
		const transport = renderError(
			new TransportError({ reason: "connect", url: `https://h/?k=${canary}` }),
			[bearer]
		)

		expect(api).not.toContain(canary)
		expect(transport).not.toContain(canary)
	})

	test("a long body prints whole", () => {
		const body = "y".repeat(100_000)
		const text = renderError(responseError({ body }), [bearer])

		expect(text.split("\n").at(-1)).toBe(body)
	})
})

describe("valueFreeFormatter", () => {
	const invalid = new CliError.InvalidValue({
		expected: `Expected a port, got "${canary}"`,
		kind: "flag",
		option: "port",
		value: canary
	})

	test("an InvalidValue names the option and never the value or expectation", () => {
		for (const text of [
			valueFreeFormatter.formatError(invalid),
			valueFreeFormatter.formatErrors([invalid]),
			valueFreeFormatter.formatCliError(invalid)
		]) {
			expect(text).toContain("port")
			expect(text).not.toContain(canary)
			expect(text).not.toContain("Expected")
		}
	})

	test("an argument names its position label, not its value", () => {
		const argument = new CliError.InvalidValue({
			expected: "integer",
			kind: "argument",
			option: "count",
			value: canary
		})

		expect(valueFreeFormatter.formatErrors([argument])).toContain("count")
		expect(valueFreeFormatter.formatErrors([argument])).not.toContain(canary)
	})
})

describe("finalCatch", () => {
	test("an unknown defect prints one scrubbed line and exits 70", async () => {
		const { exit, stderr } = await runCatch(Effect.die(new Error(`boom ${canary}\nsecond`)))
		const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

		expect(error).toBeInstanceOf(InternalError)
		expect(Runtime.getErrorExitCode(error)).toBe(70)
		expect(Runtime.getErrorReported(error)).toBe(false)
		expect(stderr).toContain("internal error, please report")
		expect(stderr).toContain("<redacted:bearer>")
		expect(stderr).not.toContain(canary)
		expect(stderr.trimEnd().split("\n")).toHaveLength(2)
	})

	test("a non-transport HttpClientError reason prints one internal-error line and exits 70", async () => {
		const encode = new HttpClientError.HttpClientError({
			reason: new HttpClientError.EncodeError({
				request: HttpClientRequest.get("https://api.example.test/pets")
			})
		})
		const { exit, stderr } = await runCatch(
			Effect.fail(encode).pipe(Effect.catchTag("HttpClientError", mapClientError))
		)
		const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

		expect(Runtime.getErrorExitCode(error)).toBe(70)
		expect(stderr).toBe(
			"Error: Encode error (GET https://api.example.test/pets)\ninternal error, please report\n"
		)
	})

	test("an unrecognized typed failure also exits 70", async () => {
		const { exit } = await runCatch(Effect.fail("plain string"))

		expect(Exit.isFailure(exit) && Runtime.getErrorExitCode(Cause.squash(exit.cause))).toBe(70)
	})

	test("a known error is rendered once and keeps its tag and exit code", async () => {
		const original = responseError({ body: `echo ${canary}`, matched: "401", status: 401 })
		const { exit, stderr } = await runCatch(Effect.fail(original))
		const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

		expect(error).toBe(original)
		expect(Runtime.getErrorExitCode(error)).toBe(3)
		expect(Runtime.getErrorReported(error)).toBe(false)
		expect(stderr).not.toContain(canary)
		expect(stderr).toContain("<redacted:bearer>")
		expect(stderr.match(/users\.get/gu)).toHaveLength(1)
	})

	test("each known class keeps its exit code", async () => {
		const known = [
			[new UsageError({ message: "bad" }), 2],
			[new CredentialMissing({ alternatives: ["a"], operation: "op" }), 3],
			[new TransportError({ reason: "dns", url: "https://h" }), 4],
			[new OutputErrorClass({ path: "p", reason: "write" }), 5]
		] as const

		const codes = await Promise.all(
			known.map(async ([error]) => {
				const { exit } = await runCatch(Effect.fail(error))

				return Exit.isFailure(exit) ? Runtime.getErrorExitCode(Cause.squash(exit.cause)) : 0
			})
		)

		expect(codes).toEqual(known.map(([, code]) => code))
	})

	test("help with no parse errors passes through unprinted", async () => {
		const help = new CliError.ShowHelp({ commandPath: [], errors: [] })
		const { exit, stderr } = await runCatch(Effect.fail(help))

		expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(help)
		expect(stderr).toBe("")
	})

	test("a parse error is rendered once, value-free, and keeps exit 1 (audit F5)", async () => {
		const invalid = new CliError.InvalidValue({
			expected: `Expected a port, got "${canary}"`,
			kind: "flag",
			option: "port",
			value: canary
		})
		const help = new CliError.ShowHelp({ commandPath: ["cli"], errors: [invalid] })
		const { exit, stderr } = await runCatch(Effect.fail(help))
		const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

		expect(error).toBe(help)
		expect(Runtime.getErrorExitCode(error)).toBe(1)
		expect(Runtime.getErrorReported(error)).toBe(false)
		expect(stderr.match(/--port/gu)).toHaveLength(1)
		expect(stderr).not.toContain(canary)
		expect(stderr).not.toContain("Expected")
	})

	test("a CliError outside help is rendered once through the value-free formatter", async () => {
		const invalid = new CliError.InvalidValue({
			expected: canary,
			kind: "argument",
			option: "count",
			value: canary
		})
		const { exit, stderr } = await runCatch(Effect.fail(invalid))

		expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(invalid)
		expect(Runtime.getErrorReported(invalid)).toBe(false)
		expect(stderr.match(/<count>/gu)).toHaveLength(1)
		expect(stderr).not.toContain(canary)
	})
})

describe("a credential split by invisible characters is scrubbed (security review)", () => {
	test.each(["\u202E", "\u200B", "\u0001"])(
		"renderError and the error body redact a credential split by %#",
		async (split) => {
			const echo = `x CANARY-SECRET${split}-123 y`
			const rendered = renderError(responseError({ body: echo, requestId: echo, status: 401 }), [
				bearer
			])
			const body = await bodyWith(echo, [bearer])

			for (const output of [rendered, body]) {
				expect(output).not.toContain("CANARY")
				expect(output).toContain("<redacted:bearer>")
			}
		}
	)
})

// Audit S2: a credential holding characters `sanitize` removes (U+00AD, the C1 NEL and the C0 SOH),
// which `auth.ts` accepts. The echo carries it as sent, then split by a bidi control.
const strippable = "CANARY\u00AD\u0085\u0001SECRET"

const strippableBearer: Credential = { ...bearer, value: Redacted.make(strippable) }

const strippableEcho = `x ${strippable} y CANARY\u202E\u00AD\u0085\u0001SECRET z`

describe("credentials are scrubbed before the text is sanitized (audit S2, design 7.4)", () => {
	test("the error body", async () => {
		const body = await bodyWith(strippableEcho, [strippableBearer])

		expect(body).toBe("x <redacted:bearer> y <redacted:bearer> z")
	})

	test("the request id line and the body of a rendered error", () => {
		const rendered = renderError(
			responseError({ body: strippableEcho, requestId: strippableEcho }),
			[strippableBearer]
		)

		expect(rendered.split("\n").slice(1)).toEqual([
			"Request ID: x <redacted:bearer> y <redacted:bearer> z",
			"x <redacted:bearer> y <redacted:bearer> z"
		])
	})

	test("a single line: the defect report", async () => {
		const { stderr } = await runCatch(Effect.die(strippableEcho), [strippableBearer])

		expect(stderr).toContain("Error: x <redacted:bearer> y <redacted:bearer> z\n")
		expect(stderr).not.toMatch(/CANARY|SECRET/u)
	})

	test("the final report of a parse error", async () => {
		const unknown = new CliError.UnrecognizedOption({
			option: `--${strippableEcho}`,
			suggestions: []
		})
		const { stderr } = await runCatch(Effect.fail(unknown), [strippableBearer])

		expect(stderr).toContain("--x <redacted:bearer> y <redacted:bearer> z")
		expect(stderr).not.toMatch(/CANARY|SECRET/u)
	})
})

// Audit S2 residual: an earlier echo of the credential turns into a shorter placeholder; the echo
// after it holds the credential split by a stripped character.
describe("a credential split by a stripped character after an earlier echo (audit S2)", () => {
	for (const split of ["\u00AD", "\u0085", "\u0001"]) {
		test(`split by ${JSON.stringify(split)}`, async () => {
			const cut = `${longSecret.slice(0, 6)}${split}${longSecret.slice(6)}`
			const body = await bodyWith(`${longSecret}${cut}-tail`, [longBearer])

			expect(body).not.toContain("SECRETTOKEN")
			expect(body).toContain("<redacted:bearer>")
			expect(body.endsWith("-tail")).toBe(true)
		})
	}
})

const created: OperationMeta = {
	media: { request: [], responses: { "201": ["application/json"] } },
	method: "POST",
	operationId: "widgets-create",
	pathTemplate: "/widgets",
	security: []
}

const createRequest = Serialize.request("POST", {
	headers: [],
	path: Serialize.path("/widgets", []),
	query: []
})

/**
 * Run `send` once with `--output <target>` against a scripted client that counts the requests it
 * receives; `onRequest` runs inside the client before it answers 201 with `{"id":"w1"}`.
 */
const sendTo = async (
	target: string,
	settings: { readonly dryRun?: boolean; readonly force?: boolean } = {},
	onRequest: Effect.Effect<void> = Effect.void
) => {
	const requests = { count: 0 }
	const client = HttpClient.make((sent) =>
		Effect.gen(function* answer() {
			requests.count += 1
			yield* onRequest

			return HttpClientResponse.fromWeb(
				sent,
				new Response('{"id":"w1"}', {
					headers: { "content-type": "application/json" },
					status: 201
				})
			)
		})
	)
	const environment = Layer.mergeAll(
		BaseUrl.layer(
			{
				boundOrigins: ["https://api.example.com"],
				defaultServer: 0,
				servers: [{ url: "https://api.example.com", variables: {} }]
			},
			"EXAMPLE"
		),
		Auth.layer({ schemes: {} }, "EXAMPLE", []),
		ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
		NodeFileSystem.layer,
		NodePath.layer,
		Stdio.layerTest({}),
		Input.stdinClaimLayer,
		runCredentialsLayer,
		Layer.succeed(Transport, {
			certified: Option.none(),
			plain: { direct: client, environment: client }
		}),
		Layer.succeed(ClientPolicy, {
			allowed: new Set(["POST"]),
			binName: "example",
			direct: {},
			version: "1.2.3"
		}),
		Layer.succeed(OutputPath, Option.some(target)),
		Layer.succeed(Force, settings.force ?? false),
		Layer.succeed(dryRunSetting, settings.dryRun ?? false),
		Layer.succeed(BaseUrl.baseUrlSetting, Option.none()),
		Layer.succeed(BaseUrl.serverSetting, Option.none()),
		Layer.succeed(BaseUrl.serverVariableSetting, []),
		Layer.succeed(Auth.allowCredentialsForBaseUrl, false)
	)
	const exit = await Effect.runPromise(
		Effect.exit(createRequest.pipe(Effect.flatMap(send(created)))).pipe(Effect.provide(environment))
	)

	return { exit, requests: requests.count }
}

const readText = (fs: FileSystem.FileSystem, target: string) =>
	Effect.runPromise(fs.readFileString(target).pipe(Effect.provide(NodeFileSystem.layer)))

const writeText = (fs: FileSystem.FileSystem, target: string, text: string) =>
	Effect.runPromise(fs.writeFileString(target, text).pipe(Effect.provide(NodeFileSystem.layer)))

// HB4: the target is checked before the request is sent, so a refused --output never discards
// the answer of a request that took effect.
describe("--output through send", () => {
	test("an existing target without --force is refused before any request is sent", async () => {
		await inDir(async (dir, fs, path) => {
			const target = path.join(dir, "out.json")
			await writeText(fs, target, "keep")
			const result = await sendTo(target)
			expect(reasonOf(failure(result.exit))).toBe("exists")
			expect(result.requests).toBe(0)
			expect(await readText(fs, target)).toBe("keep")
		})
	})

	test("--force sends one request and replaces the existing target", async () => {
		await inDir(async (dir, fs, path) => {
			const target = path.join(dir, "out.json")
			await writeText(fs, target, "old")
			const result = await sendTo(target, { force: true })
			expect(Exit.isSuccess(result.exit)).toBe(true)
			expect(result.requests).toBe(1)
			expect(await readText(fs, target)).toBe('{"id":"w1"}')
		})
	})

	test("a target created after the check, while the request runs, is still refused by link", async () => {
		await inDir(async (dir, fs, path) => {
			const target = path.join(dir, "out.json")
			const racer = fs.writeFileString(target, "racer").pipe(Effect.orDie)
			const result = await sendTo(target, {}, racer.pipe(Effect.provide(NodeFileSystem.layer)))
			expect(reasonOf(failure(result.exit))).toBe("exists")
			expect(result.requests).toBe(1)
			expect(await readText(fs, target)).toBe("racer")
			expect(
				await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(NodeFileSystem.layer)))
			).toEqual(["out.json"])
		})
	})

	test("--dry-run with an existing target sends nothing and is not refused", async () => {
		await inDir(async (dir, fs, path) => {
			const target = path.join(dir, "out.json")
			await writeText(fs, target, "keep")
			const result = await sendTo(target, { dryRun: true })
			expect(Exit.isSuccess(result.exit)).toBe(true)
			expect(result.requests).toBe(0)
			expect(await readText(fs, target)).toBe("keep")
		})
	})
})
