import {
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	option
} from "@bjornpagen/testing/gen"
import { jsonTextOf } from "@superstarter/json"
import { regex } from "arkregex"
import { Array as Arr, Duration, Effect, Option, Order, Record as Rec, String as Str } from "effect"
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
import { type Head, valuesOf, type WireRequest } from "#test/support/http.ts"
import { type RecordingProxy, recordingProxy } from "#test/support/recording-proxy.ts"
import { latin1Bytes } from "#test/support/wire.ts"

/** What the proxy-routing property (proxy-routing.test.ts) draws and its fixture: the origins, routes and runs. */

/** The run's origins: A and B are loopback; N and M are names no resolver knows, which only the proxy reaches. */
export type Logical = "A" | "B" | "N" | "M"

/** The bound origins, which credentials reach. */
const BOUND: ReadonlyArray<Logical> = ["A", "N"]

/** Whether an origin's host is loopback. */
const isLoopback = (origin: Logical): boolean => origin === "A" || origin === "B"

/** The host names N and M travel under. */
const HOSTS: Readonly<Record<"N" | "M", string>> = { N: "n.test", M: "m.test" }

/** A no-proxy list: none, one host, or every host. */
type NoProxy =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "host"; host: string }>
	| Readonly<{ kind: "every host" }>

/** The proxy a run's environment names: by which variable and whether its URL carries userinfo. */
type Proxy = Readonly<{ variable: "HTTP_PROXY" | "http_proxy"; userinfo: boolean }>

/** One run: where it starts, whether the flag admits an unbound base, its chain, its proxy and its no-proxy list. */
type Run = Readonly<{
	base: Logical
	allow: boolean
	redirects: ReadonlyArray<Logical>
	proxy: Option.Option<Proxy>
	noProxy: NoProxy
}>

const logical: Gen<Logical> = element<Logical>(["A", "B", "N", "M"])

/** A proxy drawn as the suite drew it: either variable, with userinfo or without. */
const proxyOf =
	(variable: Gen<Proxy["variable"]>, userinfo: Gen<boolean>): Gen<Proxy> =>
	(source) => ({ variable: source.draw(variable), userinfo: source.draw(userinfo) })

const anyProxy: Gen<Proxy> = proxyOf(
	element<Proxy["variable"]>(["HTTP_PROXY", "http_proxy"]),
	boolean
)

const NO_PROXIES: Arr.NonEmptyReadonlyArray<NoProxy> = [
	{ kind: "none" },
	{ kind: "host", host: "n.test" },
	{ kind: "host", host: "m.test" },
	{ kind: "every host" }
]

/** A run, each of its parts drawn from its own generator. */
const runWith =
	(
		parts: Readonly<{
			base: Gen<Logical>
			allow: Gen<boolean>
			redirects: Gen<ReadonlyArray<Logical>>
			proxy: Gen<Option.Option<Proxy>>
			noProxy: Gen<NoProxy>
		}>
	): Gen<Run> =>
	(source) => ({
		base: source.draw(parts.base),
		allow: source.draw(parts.allow),
		redirects: source.draw(parts.redirects),
		proxy: source.draw(parts.proxy),
		noProxy: source.draw(parts.noProxy)
	})

/** Every part of a run drawn as the suite drew it before its conversion. */
const anyRun = {
	base: logical,
	allow: boolean,
	redirects: array(logical, { min: 0, max: 3 }),
	proxy: option(anyProxy),
	noProxy: element(NO_PROXIES)
} as const

const runOf: Gen<Run> = runWith(anyRun)

/** Whether a no-proxy list covers an origin's host. */
const covers = (list: NoProxy, origin: "N" | "M"): boolean => {
	switch (list.kind) {
		case "none":
			return false
		case "host":
			return list.host === HOSTS[origin]
		case "every host":
			return true
	}
}

/** How a hop travels: straight to its host, through the proxy, or nowhere, for a host only the proxy reaches. */
type Route = "direct" | "proxy" | "unreachable"

/** The routing rule: a loopback host goes direct; any other through the proxy when one is named and the list spares it. */
const routeOf = (r: Run, origin: Logical): Route => {
	if (origin === "A" || origin === "B") {
		return "direct"
	}
	return Option.isSome(r.proxy) && !covers(r.noProxy, origin) ? "proxy" : "unreachable"
}

/** One hop as the oracle compares it: the authority its Host names, whether it carried the token, and any Proxy-Authorization. */
type Hop = Readonly<{
	authority: string
	token: boolean
	proxyAuthorization: ReadonlyArray<string>
}>

/** What the oracle compares of a run. */
export type Outcome = Readonly<{
	hops: ReadonlyArray<Hop>
	exitCode: number
	proxied: ReadonlyArray<Proxied>
	warnings: Option.Option<number>
}>

/** Whether a hop carries the token: to a bound origin, or to the base when the flag admits it. */
const carriesToken = (r: Run, origin: Logical): boolean =>
	Arr.contains(BOUND, origin) || (r.allow && origin === r.base)

/** The hops the run sends before one has no route, and whether one had none. */
const hopsOf = (r: Run): Readonly<{ sent: ReadonlyArray<Logical>; stranded: boolean }> => {
	const all = Arr.prepend(r.redirects, r.base)
	const reachable = Arr.takeWhile(all, (origin) => routeOf(r, origin) !== "unreachable")
	return { sent: reachable, stranded: reachable.length < all.length }
}

/** Proxy heads as the oracle compares them: the host each names, and whether it carried Proxy-Authorization. */
type Proxied = Readonly<{ host: string; proxyAuthorization: boolean }>

const byHost = Order.mapInput(
	Order.String,
	(proxied: Proxied) => `${proxied.host} ${String(proxied.proxyAuthorization)}`
)

/**
 * The warnings the contract fixes: one when the flag sends credentials in plaintext to a base that is neither loopback
 * nor bound, none when the base is loopback; any other run's warnings are not fixed.
 */
const warningsOf = (r: Run): Option.Option<number> => {
	if (!r.allow || routeOf(r, r.base) === "unreachable") {
		return Option.none()
	}
	if (isLoopback(r.base)) {
		return Option.some(0)
	}
	return r.base === "M" ? Option.some(1) : Option.none()
}

/** The run the routing, binding and warning rules give, with each origin's authority as its requests name it. */
export const expectedOf = (r: Run, authorities: Readonly<Record<Logical, string>>): Outcome => {
	const { sent, stranded } = hopsOf(r)
	const viaProxy = Arr.dedupe(Arr.filter(sent, (origin) => routeOf(r, origin) === "proxy"))
	const userinfo = Option.exists(r.proxy, (proxy) => proxy.userinfo)
	return {
		hops: Arr.map(sent, (origin) => ({
			authority: authorities[origin],
			token: carriesToken(r, origin),
			proxyAuthorization: []
		})),
		exitCode: stranded ? 4 : 0,
		proxied: Arr.sort(
			Arr.map(viaProxy, (origin) => ({ host: authorities[origin], proxyAuthorization: userinfo })),
			byHost
		),
		warnings: warningsOf(r)
	}
}

/** The authority an absolute-form target names. */
const ABSOLUTE = regex("^http://([^/?#]+)", "u")

/** The authority a proxy head names: a CONNECT's target, or an absolute-form target's host and port. */
const authorityOfHead = (head: Head): string =>
	head.method === "CONNECT"
		? head.target
		: Option.match(Option.fromNullishOr(ABSOLUTE.exec(head.target)), {
				onNone: () => head.target,
				onSome: ([, authority]) => authority
			})

/** The token a run is given. */
export const TOKEN = "proxy-run-token-7c1e"

/** Whether an Authorization value is the run's bearer token. */
const isToken = (value: string): boolean =>
	Option.exists(
		Str.indexOf(" ")(value),
		(space) => Str.slice(0, space)(value) === "Bearer" && Str.slice(space + 1)(value) === TOKEN
	)

/** What a recorded request carried. */
export const hopOf = (request: WireRequest): Hop => ({
	authority: Arr.join(valuesOf(request.headers, "host"), ","),
	token: Arr.some(valuesOf(request.headers, "authorization"), isToken),
	proxyAuthorization: valuesOf(request.headers, "proxy-authorization")
})

/** The proxy's heads as the oracle compares them: the hosts named, once each, in order. */
export const proxiedOf = (heads: ReadonlyArray<Head>): ReadonlyArray<Proxied> =>
	Arr.sort(
		Arr.dedupeWith(
			Arr.map(heads, (head) => ({
				host: authorityOfHead(head),
				proxyAuthorization: Arr.isReadonlyArrayNonEmpty(
					valuesOf(head.headers, "proxy-authorization")
				)
			})),
			(left, right) =>
				left.host === right.host && left.proxyAuthorization === right.proxyAuthorization
		),
		byHost
	)

/** The warning lines a run printed. */
export const warningsPrinted = (stderr: Uint8Array): number =>
	Arr.length(
		Arr.filter(Str.split("\n")(new TextDecoder().decode(stderr)), (line) =>
			Str.startsWith("Warning:")(line)
		)
	)

/** The landing response: an empty JSON object. */
const landing: ScriptedResponse = {
	status: 200,
	headers: [["Content-Type", "application/json"]],
	delay: Duration.zero,
	body: { kind: "complete", bytes: latin1Bytes("{}") }
}

const CHAIN_PATH = regex("^/chain/([0-9]+)$", "u")

/** The chain's script: the request after `index` redirects answers the next redirect's absolute Location, or lands. */
export const scriptOf =
	(r: Run, urls: Readonly<Record<Logical, string>>) =>
	(request: WireRequest): ScriptedResponse => {
		const index = Option.match(
			Option.fromNullishOr(CHAIN_PATH.exec(Arr.headNonEmpty(Str.split("?")(request.target)))),
			{ onNone: () => 0, onSome: ([, at]) => Number(at) }
		)
		return Option.match(Arr.get(r.redirects, index), {
			onNone: () => landing,
			onSome: (next) => ({
				status: 307,
				headers: [["Location", `${urls[next]}/chain/${String(index + 1)}`]],
				delay: Duration.zero,
				body: { kind: "complete", bytes: new Uint8Array(0) }
			})
		})
	}

/** The landing response's JSON. */
const landed = {
	content: { "application/json": { schema: { type: "object" } } },
	description: "Landed."
} as const

/** One GET behind a bearer token. */
const spec = jsonTextOf({
	openapi: "3.1.0",
	info: { title: "Proxy routing", version: "1.0.0" },
	paths: { "/hop": { get: { operationId: "hop-get", responses: { "200": landed } } } },
	components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
	security: [{ bearerAuth: [] }]
})

/** The author config, binding A and N. */
const configOf = (bound: ReadonlyArray<string>): string =>
	jsonTextOf({
		package: { name: "proxy-routing", version: "1.0.0" },
		binName: "routes",
		envPrefix: "ROUTES",
		acceptedOrigins: bound,
		allowInsecure: true
	})

/**
 * The suite's fixture, once per worker: the capture server, the proxy that maps N and M to it, the package, its
 * command and the origins.
 */
export const routingFixture = workerFixture(
	"test/generated/proxy-routing.fixtures.ts routingFixture",
	Effect.gen(function* () {
		const server = yield* captureServer
		const portA = Number(new URL(server.origins["127.0.0.1"]).port)
		const portB = Number(new URL(server.origins.localhost).port)
		const authorities: Readonly<Record<Logical, string>> = {
			A: `127.0.0.1:${String(portA)}`,
			B: `localhost:${String(portB)}`,
			N: `${HOSTS.N}:${String(portA)}`,
			M: `${HOSTS.M}:${String(portB)}`
		}
		const urls = Rec.map(authorities, (authority) => `http://${authority}`)
		const proxy = yield* recordingProxy({
			[authorities.N]: { host: "127.0.0.1", port: portA },
			[authorities.M]: { host: "127.0.0.1", port: portB }
		})
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf([urls.A, urls.N]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const name = yield* Effect.fromOption(
			Arr.findFirst(
				generated.result.report.commandNames,
				(entry) => entry.pointer === "/paths/~1hop/get"
			)
		)
		const opened: Readonly<{
			server: CaptureServer
			proxy: RecordingProxy
			built: BuiltPackage
			command: ReadonlyArray<string>
			urls: Readonly<Record<Logical, string>>
			authorities: Readonly<Record<Logical, string>>
		}> = { server, proxy, built, command: name.path, urls, authorities }
		return opened
	})
)

export type RouteFeature =
	| "a loopback hop"
	| "a proxied hop"
	| "a hop with no route"
	| "a no-proxy list sparing a host"
	| "every host spared"
	| "proxy userinfo"
	| "the lower-case variable"
	| "an unbound base the flag admits"
	| "the plaintext warning"
	| "a redirect from a proxied host to a loopback one"

/** A feature when it holds, none otherwise. */
const when = <F extends string>(holds: boolean, feature: F): ReadonlyArray<F> =>
	holds ? [feature] : []

/** The features a run reaches. */
export const runFeatures = (r: Run, expected: Outcome): ReadonlyArray<RouteFeature> => {
	const { sent } = hopsOf(r)
	const routes = Arr.map(sent, (origin) => routeOf(r, origin))
	return Arr.flatten<ReadonlyArray<ReadonlyArray<RouteFeature>>>([
		when(Arr.contains(routes, "direct"), "a loopback hop"),
		when(Arr.contains(routes, "proxy"), "a proxied hop"),
		when(expected.exitCode === 4, "a hop with no route"),
		when(r.noProxy.kind === "host" && Option.isSome(r.proxy), "a no-proxy list sparing a host"),
		when(r.noProxy.kind === "every host" && Option.isSome(r.proxy), "every host spared"),
		when(
			Option.exists(r.proxy, (proxy) => proxy.userinfo),
			"proxy userinfo"
		),
		when(
			Option.exists(r.proxy, (proxy) => proxy.variable === "http_proxy"),
			"the lower-case variable"
		),
		when(r.allow && !Arr.contains(BOUND, r.base), "an unbound base the flag admits"),
		when(Option.contains(expected.warnings, 1), "the plaintext warning"),
		when(
			Arr.some(
				Arr.zip(routes, Arr.drop(routes, 1)),
				([from, to]) => from === "proxy" && to === "direct"
			),
			"a redirect from a proxied host to a loopback one"
		)
	])
}

/** The environment a run's proxy settings give. */
export const proxyEnv = (r: Run, proxy: RecordingProxy): Readonly<Record<string, string>> => ({
	...Option.match(r.proxy, {
		onNone: () => ({}),
		onSome: (named) => ({
			[named.variable]: named.userinfo
				? proxy.urlWithUserinfo("proxy-user", "proxy-pass")
				: proxy.url
		})
	}),
	...(r.noProxy.kind === "host"
		? { NO_PROXY: r.noProxy.host }
		: r.noProxy.kind === "every host"
			? { NO_PROXY: "*" }
			: {})
})

/** Every feature the search must reach, in its suite's order. */
export const FEATURES: Arr.NonEmptyReadonlyArray<RouteFeature> = [
	"a loopback hop",
	"a proxied hop",
	"a hop with no route",
	"a no-proxy list sparing a host",
	"every host spared",
	"proxy userinfo",
	"the lower-case variable",
	"an unbound base the flag admits",
	"the plaintext warning",
	"a redirect from a proxied host to a loopback one"
]

/** A proxy named by either variable, with userinfo or without, and a list that spares neither N's host nor M's. */
const proxied = {
	proxy: map(anyProxy, Option.some),
	noProxy: constant<NoProxy>({ kind: "none" })
} as const

/** The run a focus draws: one made to reach that feature, every other choice drawn at random. */
const caseFor = (focus: RouteFeature): Gen<Run> => {
	switch (focus) {
		case "a loopback hop":
			return runWith({ ...anyRun, base: element<Logical>(["A", "B"]) })
		case "a proxied hop":
			return runWith({ ...anyRun, ...proxied, base: element<Logical>(["N", "M"]) })
		case "a hop with no route":
			return runWith({
				...anyRun,
				base: element<Logical>(["N", "M"]),
				proxy: constant(Option.none())
			})
		case "a no-proxy list sparing a host":
			return runWith({
				...anyRun,
				proxy: map(anyProxy, Option.some),
				noProxy: element<NoProxy>([
					{ kind: "host", host: "n.test" },
					{ kind: "host", host: "m.test" }
				])
			})
		case "every host spared":
			return runWith({
				...anyRun,
				proxy: map(anyProxy, Option.some),
				noProxy: constant<NoProxy>({ kind: "every host" })
			})
		case "proxy userinfo":
			return runWith({
				...anyRun,
				proxy: map(
					proxyOf(element<Proxy["variable"]>(["HTTP_PROXY", "http_proxy"]), constant(true)),
					Option.some
				)
			})
		case "the lower-case variable":
			return runWith({
				...anyRun,
				proxy: map(proxyOf(constant<Proxy["variable"]>("http_proxy"), boolean), Option.some)
			})
		case "an unbound base the flag admits":
			return runWith({ ...anyRun, base: element<Logical>(["B", "M"]), allow: constant(true) })
		case "the plaintext warning":
			return runWith({ ...anyRun, ...proxied, base: constant<Logical>("M"), allow: constant(true) })
		case "a redirect from a proxied host to a loopback one":
			return runWith({
				...anyRun,
				...proxied,
				base: element<Logical>(["N", "M"]),
				redirects: map(array(logical, { min: 0, max: 2 }), (rest) => Arr.prepend(rest, "A"))
			})
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
