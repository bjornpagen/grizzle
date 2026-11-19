import { aimed, characterOf, element, type Gen, option, string } from "@bjornpagen/testing/gen"
import { jsonTextOf } from "@superstarter/json"
import { regex } from "arkregex"
import { Array as Arr, Duration, Effect, Option, String as Str } from "effect"
import {
	type CaptureServer,
	captureServer,
	type PlainOrigin,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	workerFixture
} from "#test/support/cli-package.ts"
import { valuesOf, type WireRequest } from "#test/support/http.ts"
import {
	followChain,
	type ModelRun,
	type Redirect,
	redirectsOf,
	type RedirectStatus
} from "#test/support/redirect-model.ts"
import { latin1Bytes } from "#test/support/wire.ts"

/** What the redirect-chains property (redirect-chains.test.ts) draws and its fixture: the spec, the chains, the model. */

/** The landing the chain ends with: an empty JSON object. */
export const landing: ScriptedResponse = {
	status: 200,
	headers: [["Content-Type", "application/json"]],
	delay: Duration.zero,
	body: { kind: "complete", bytes: latin1Bytes("{}") }
}

/** The landing response's JSON. */
const landed = {
	content: { "application/json": { schema: { type: "object" } } },
	description: "Landed."
} as const

/** One path with a GET and a POST whose JSON body is optional, behind four schemes that must all be sent. */
const spec = jsonTextOf({
	openapi: "3.1.0",
	info: { title: "Redirect chains", version: "1.0.0" },
	paths: {
		"/hop": {
			get: { operationId: "hop-get", responses: { "200": landed } },
			post: {
				operationId: "hop-send",
				requestBody: {
					required: false,
					content: {
						"application/json": {
							schema: { type: "object", properties: { note: { type: "string" } } }
						}
					}
				},
				responses: { "200": landed }
			}
		}
	},
	components: {
		securitySchemes: {
			bearerAuth: { type: "http", scheme: "bearer" },
			headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
			queryKey: { type: "apiKey", in: "query", name: "api_key" },
			cookieKey: { type: "apiKey", in: "cookie", name: "session" }
		}
	},
	security: [{ bearerAuth: [], headerKey: [], queryKey: [], cookieKey: [] }]
})

/** The author config, binding exactly the bound origin. */
const configOf = (bound: string): string =>
	jsonTextOf({
		package: { name: "redirect-chains", version: "1.0.0" },
		binName: "hops",
		envPrefix: "HOPS",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** The credentials one run is given, each a value of URL- and cookie-safe characters. */
type Credentials = Readonly<{ bearer: string; header: string; query: string; cookie: string }>

/** A run: the operation, its body when it is the POST, the chain the server answers, and the credentials. */
export type Chain = Readonly<{
	method: "GET" | "POST"
	note: Option.Option<string>
	redirects: ReadonlyArray<Redirect<PlainOrigin>>
	credentials: Credentials
}>

const safe: Gen<string> = string(characterOf(["a", "z", "0", "9", "-", "_"]), { min: 1, max: 8 })

const chain: Gen<Chain> = (source) => {
	const method = element<Chain["method"]>(["GET", "POST"])(source)
	return {
		method,
		note: method === "POST" ? option(safe)(source) : Option.none(),
		redirects: redirectsOf(element<PlainOrigin>(["127.0.0.1", "localhost"]), { min: 0, max: 16 })(
			source
		),
		credentials: credentialsOf(source)
	}
}

/** The credentials a run is given, each drawn from the safe characters. */
const credentialsOf: Gen<Credentials> = (source) => ({
	bearer: safe(source),
	header: safe(source),
	query: safe(source),
	cookie: safe(source)
})

/**
 * A chain made to reach a body refused across origins: a POST with a body whose first redirect, a 307 or a 308, which
 * keep the body, names the unbound origin.
 */
const bodyAcrossOrigins: Gen<Chain> = (source) => ({
	method: "POST",
	note: Option.some(safe(source)),
	redirects: [
		{
			status: element<RedirectStatus>([307, 308])(source),
			to: "localhost",
			path: "/elsewhere",
			relative: false
		}
	],
	credentials: credentialsOf(source)
})

/**
 * The chains a case draws: any chain, and for a case aimed at a body refused across origins while no witness has
 * reached it, a chain made to reach it, which a chain of any shape reaches too rarely for the witnesses to meet.
 */
export const chains = aimed<Chain, ChainFeature>(chain, [
	["a body refused across origins", bodyAcrossOrigins]
])

/** What one hop carried, as the oracle compares it: its origin, method, target, credentials and body. */
type Hop = Readonly<{
	origin: PlainOrigin
	method: string
	target: string
	authorization: ReadonlyArray<readonly [scheme: string, credential: string]>
	apiKey: ReadonlyArray<string>
	cookie: ReadonlyArray<string>
	trace: ReadonlyArray<string>
	body: Uint8Array
}>

/** An Authorization value split at its first space: the scheme, then the credential. */
const schemeAndCredential = (value: string): readonly [scheme: string, credential: string] =>
	Option.match(Str.indexOf(" ")(value), {
		onNone: () => [value, ""],
		onSome: (space) => [Str.slice(0, space)(value), Str.slice(space + 1)(value)]
	})

/** A recorded request as the oracle compares it. */
export const hopOf = (request: WireRequest & Readonly<{ origin: PlainOrigin }>): Hop => ({
	origin: request.origin,
	method: request.method,
	target: request.target,
	authorization: Arr.map(valuesOf(request.headers, "authorization"), schemeAndCredential),
	apiKey: valuesOf(request.headers, "x-api-key"),
	cookie: valuesOf(request.headers, "cookie"),
	trace: Arr.appendAll(valuesOf(request.headers, "traceparent"), valuesOf(request.headers, "b3")),
	body: request.body
})

/** The hop the model expects, on an origin and path, with a method and whether it carries the body. */
const expectedHop = (
	c: Chain,
	origin: PlainOrigin,
	path: string,
	method: string,
	withBody: boolean
): Hop => {
	const bound = origin === "127.0.0.1"
	return {
		origin,
		method,
		target: bound ? `${path}?api_key=${c.credentials.query}` : path,
		authorization: bound ? [["Bearer", c.credentials.bearer]] : [],
		apiKey: bound ? [c.credentials.header] : [],
		cookie: bound ? [`session=${c.credentials.cookie}`] : [],
		trace: [],
		body: withBody ? bodyOf(c) : new Uint8Array(0)
	}
}

/** The JSON body the POST sends, none for a POST without a note. */
const bodyOf = (c: Chain): Uint8Array =>
	Option.match(c.note, {
		onNone: () => new Uint8Array(0),
		onSome: (note) => latin1Bytes(jsonTextOf({ note }))
	})

/** The model's run: the hops in order, the exit code (0 once the chain lands, 4 for a refused hop), and the refusal. */
type Expected = Readonly<{
	hops: ReadonlyArray<Hop>
	exitCode: number
	refused: Option.Option<string>
}>

/** The loop's specification run over a chain. */
export const runOf = (c: Chain): ModelRun<PlainOrigin> =>
	followChain<PlainOrigin>(
		{ origin: "127.0.0.1", method: c.method, withBody: Option.isSome(c.note) },
		c.redirects
	)

/** The model's run, each hop dressed with what the bound origin's hops carry. */
export const expectedOf = (c: Chain, run: ModelRun<PlainOrigin>): Expected => ({
	hops: Arr.map(run.hops, (hop) => expectedHop(c, hop.origin, hop.path, hop.method, hop.withBody)),
	exitCode: run.end === "landed" ? 0 : 4,
	refused: run.end === "landed" ? Option.none() : Option.some(run.end)
})

/** The reason a refused redirect names on stderr, `redirect from <origin> to <origin> refused: <reason>`. */
const REFUSED = regex("redirect from \\S+ to \\S+ refused: ([A-Za-z]+)", "u")

/** The refusal reason the CLI's stderr bytes name, if any. */
export const refusedOf = (stderr: Uint8Array): Option.Option<string> =>
	Option.map(
		Option.fromNullishOr(REFUSED.exec(new TextDecoder().decode(stderr))),
		([, reason]) => reason
	)

export type ChainFeature =
	| "no redirect"
	| "a chain past ten redirects"
	| "a revisit under another method"
	| "a revisit at another origin"
	| "a loop refused"
	| "a hop to the unbound origin"
	| "back to the bound origin"
	| "a relative Location"
	| "a POST turned GET"
	| "a body kept across a 307 or 308"
	| "a body refused across origins"
	| `status ${RedirectStatus}`

/** A feature when it holds, none otherwise. */
const when = <F extends string>(holds: boolean, feature: F): ReadonlyArray<F> =>
	holds ? [feature] : []

/** The features a chain reaches, read off the chain and the model's run of it. */
export const chainFeatures = (
	c: Chain,
	run: ModelRun<PlainOrigin>,
	expected: Expected
): ReadonlyArray<ChainFeature> => {
	const followed = Arr.take(c.redirects, expected.hops.length - 1)
	const origins = Arr.map(expected.hops, (hop) => hop.origin)
	const revisits = Arr.flatMap(Arr.drop(run.hops, 1), (hop, index) =>
		Arr.map(
			Arr.filter(Arr.take(run.hops, index + 1), (sent) => sent.path === hop.path),
			(sent) => ({ sent, hop })
		)
	)
	return Arr.flatten<ReadonlyArray<ReadonlyArray<ChainFeature>>>([
		when(Arr.isReadonlyArrayEmpty(c.redirects), "no redirect"),
		when(followed.length > 10, "a chain past ten redirects"),
		when(
			Arr.some(
				revisits,
				({ sent, hop }) => sent.origin === hop.origin && sent.method !== hop.method
			),
			"a revisit under another method"
		),
		when(
			Arr.some(revisits, ({ sent, hop }) => sent.origin !== hop.origin),
			"a revisit at another origin"
		),
		when(run.end === "loop", "a loop refused"),
		when(Arr.contains(origins, "localhost"), "a hop to the unbound origin"),
		when(
			Arr.some(
				Arr.zip(origins, Arr.drop(origins, 1)),
				([from, to]) => from === "localhost" && to === "127.0.0.1"
			),
			"back to the bound origin"
		),
		when(
			Arr.some(Arr.zip(origins, followed), ([from, next]) => next.relative && next.to === from),
			"a relative Location"
		),
		when(
			Arr.some(
				Arr.zip(expected.hops, Arr.drop(expected.hops, 1)),
				([from, to]) => from.method === "POST" && to.method === "GET"
			),
			"a POST turned GET"
		),
		when(
			Arr.some(Arr.drop(expected.hops, 1), (hop) => hop.body.length > 0),
			"a body kept across a 307 or 308"
		),
		when(run.end === "crossOriginBody", "a body refused across origins"),
		Arr.map(followed, (next): ChainFeature => `status ${next.status}`)
	])
}

/** The pointers of the two operations, by the method the chain starts with. */
const POINTERS: Readonly<Record<Chain["method"], string>> = {
	GET: "/paths/~1hop/get",
	POST: "/paths/~1hop/post"
}

/** The suite's fixture, once per worker: the capture server, the package built against its bound origin, and each
 * operation's command. */
export const redirectFixture = workerFixture(
	"test/generated/redirect-chains.fixtures.ts redirectFixture",
	Effect.gen(function* () {
		const server = yield* captureServer
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins["127.0.0.1"]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const commandOf = (pointer: string) =>
			Effect.fromOption(
				Arr.findFirst(generated.result.report.commandNames, (name) => name.pointer === pointer)
			).pipe(Effect.map((name) => name.path))
		const commands = { GET: yield* commandOf(POINTERS.GET), POST: yield* commandOf(POINTERS.POST) }
		const opened: Readonly<{
			server: CaptureServer
			built: BuiltPackage
			commands: Readonly<Record<Chain["method"], ReadonlyArray<string>>>
		}> = { server, built, commands }
		return opened
	})
)
