/**
 * The recording proxy records every head a client sends it, tunnels a `CONNECT` byte for byte, forwards an
 * absolute-form request in origin form without its hop headers, and refuses an authority its map does not name.
 *
 * - Hops: one client connection each, to the proxy, sequentially: a `CONNECT` to a mapped or unmapped authority with a
 *   request inside the tunnel, or an absolute-form request to one, with or without its port, a Proxy-Authorization
 *   line, a Proxy-Connection line and the client's own header lines. Every mapped authority reaches the capture server.
 *   Oracles: the proxy's heads are the heads as sent; the capture server records the tunnelled request exactly as
 *   wire.ts frames it, and the forwarded one with its path and query as written, the client's own header lines and
 *   `Connection: close`, and nothing for an unmapped authority; the client reads `200` then the server's answer
 *   through a tunnel, the server's answer for a forward, and `502` for an unmapped authority.
 *
 * Plants (local only, reverted): recording-proxy.ts routeOf keeping Proxy-Authorization; routeOf ignoring the
 * scheme's default port; serveProxied never answering `200 Connection Established`.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, constant, element, type Gen, oneOf, option } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { regex } from "arkregex"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	String as Str
} from "effect"
import {
	captureServer,
	type PlainOrigin,
	type RecordedRequest,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import type { Head, HeaderList, WireRequest } from "#test/support/http.ts"
import { recordingProxy } from "#test/support/recording-proxy.ts"
import {
	exchange,
	header,
	type HeaderSketch,
	latin1Bytes,
	method,
	recordedOf,
	request,
	type RequestSketch,
	requestBytes,
	target,
	untilClosed
} from "#test/support/wire.ts"

/**
 * Where a client sends a hop: a host, written in its own case or in upper case, and a port or none (the scheme's
 * default, 80, applies; a `CONNECT` always names one).
 */
type Destination = Readonly<{ host: string; upper: boolean; port: Option.Option<number> }>

/** The authorities the proxy's map names, in lower case with their ports; each reaches the capture server. */
const MAPPED: ReadonlyArray<string> = ["a.test:80", "b.test:8080", "192.0.2.10:443"]

const host: Gen<string> = element(["a.test", "b.test", "192.0.2.10", "unmapped.test"])

const port: Gen<number> = element([80, 8080, 443, 81])

/** Where an absolute-form request goes. */
const forwardDestination: Gen<Destination> = (source) => ({
	host: host(source),
	upper: boolean(source),
	port: option(port)(source)
})

/** Where a `CONNECT` goes. */
const connectDestination: Gen<Destination> = (source) => ({
	host: host(source),
	upper: boolean(source),
	port: Option.some(port(source))
})

/** The authority as the client writes it. */
const writtenOf = (destination: Destination): string =>
	`${destination.upper ? Str.toUpperCase(destination.host) : destination.host}${Option.match(
		destination.port,
		{
			onNone: () => "",
			onSome: (named) => `:${String(named)}`
		}
	)}`

/** Whether the proxy's map names the authority: its host in lower case and its port, 80 when it names none. */
const mappedOf = (destination: Destination): boolean =>
	Arr.contains(
		MAPPED,
		`${destination.host}:${String(Option.getOrElse(destination.port, () => 80))}`
	)

/** A path and query as an absolute-form target writes them after its authority: a path, none, or a query alone. */
const pathAfterAuthority: Gen<string> = oneOf([target, constant(""), constant("?q=1")])

/** One hop through the proxy. */
type Hop =
	| Readonly<{
			kind: "forward"
			destination: Destination
			method: string
			path: string
			proxyAuthorization: Option.Option<string>
			proxyConnection: boolean
			headers: ReadonlyArray<HeaderSketch>
	  }>
	| Readonly<{
			kind: "connect"
			destination: Destination
			proxyAuthorization: Option.Option<string>
			headers: ReadonlyArray<HeaderSketch>
			inner: RequestSketch
	  }>

const credentials: Gen<Option.Option<string>> = option(
	element(["Basic dXNlcjpwYXNz", "Bearer t0k3n"])
)

const hop: Gen<Hop> = (source) =>
	boolean(source)
		? {
				kind: "connect",
				destination: connectDestination(source),
				proxyAuthorization: credentials(source),
				headers: array(header, { min: 0, max: 2 })(source),
				inner: request(source)
			}
		: {
				kind: "forward",
				destination: forwardDestination(source),
				method: method(source),
				path: pathAfterAuthority(source),
				proxyAuthorization: credentials(source),
				proxyConnection: boolean(source),
				headers: array(header, { min: 0, max: 2 })(source)
			}

/** The Proxy-Connection line a forward may carry. */
const proxyConnection: HeaderList = [["Proxy-Connection", "keep-alive"]]

/** A hop's head as the client writes it and the proxy should record it. */
const headOf = (sent: Hop): Head => {
	const own: HeaderList = [
		["Host", writtenOf(sent.destination)],
		...Option.match(sent.proxyAuthorization, {
			onNone: (): HeaderList => [],
			onSome: (value): HeaderList => [["Proxy-Authorization", value]]
		}),
		...(sent.kind === "forward" && sent.proxyConnection ? proxyConnection : []),
		...Arr.map(sent.headers, (line): readonly [string, string] => [line.name, line.value])
	]
	return sent.kind === "connect"
		? { method: "CONNECT", target: writtenOf(sent.destination), headers: own }
		: {
				method: sent.method,
				target: `http://${writtenOf(sent.destination)}${sent.path}`,
				headers: own
			}
}

/** The bytes a client writes for a hop: its head, with the client's whitespace, and a tunnelled request after it. */
const hopBytes = (sent: Hop): Uint8Array => {
	const head = headOf(sent)
	const ownCount = head.headers.length - sent.headers.length
	const lines = [
		...Arr.map(Arr.take(head.headers, ownCount), ([name, value]) => `${name}: ${value}`),
		...Arr.map(sent.headers, (line) => `${line.name}:${line.before}${line.value}${line.after}`)
	]
	const written = latin1Bytes(
		`${head.method} ${head.target} HTTP/1.1\r\n${Arr.join(
			Arr.map(lines, (line) => `${line}\r\n`),
			""
		)}\r\n`
	)
	return sent.kind === "connect"
		? Uint8Array.from(Buffer.concat([written, requestBytes(sent.inner, true)]))
		: written
}

/** The request the capture server should record for a mapped hop. */
const forwardedOf = (sent: Hop): WireRequest => {
	if (sent.kind === "connect") {
		return recordedOf(sent.inner, true)
	}
	return {
		method: sent.method,
		target: Str.startsWith("/")(sent.path) ? sent.path : `/${sent.path}`,
		headers: [
			["Host", writtenOf(sent.destination)],
			...Arr.map(sent.headers, (line): readonly [string, string] => [line.name, line.value]),
			["Connection", "close"]
		],
		body: new Uint8Array(0)
	}
}

/** The statuses a client reads on a hop: the tunnel's and then the server's, the server's alone, or the proxy's 502. */
const statusesOf = (sent: Hop): ReadonlyArray<string> =>
	mappedOf(sent.destination) ? (sent.kind === "connect" ? ["200", "200"] : ["200"]) : ["502"]

const STATUS = regex("^HTTP/1\\.1 ([0-9]{3}) ", "u")

/** The status codes of every status line in what a client read. */
const statusesIn = (received: Uint8Array): ReadonlyArray<string> =>
	Arr.flatMap(Str.split("\r\n")(Buffer.from(received).toString("latin1")), (line) =>
		Option.match(Option.fromNullishOr(STATUS.exec(line)), {
			onNone: () => [],
			onSome: ([, code]) => [code]
		})
	)

/** An empty `200` answer. */
const ok: ScriptedResponse = {
	status: 200,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

type ProxyFeature =
	| "a tunnel"
	| "a forward"
	| "an unmapped authority"
	| "Proxy-Authorization"
	| "Proxy-Connection"
	| "a default port"
	| "an authority in another case"
	| "no path after the authority"
	| "two hops"

/** A feature when it holds, none otherwise. */
const when = <F extends string>(holds: boolean, feature: F): ReadonlyArray<F> =>
	holds ? [feature] : []

/** The features one hop reaches. */
const hopFeatures = (sent: Hop): ReadonlyArray<ProxyFeature> =>
	Arr.flatten<ReadonlyArray<ReadonlyArray<ProxyFeature>>>([
		when(sent.kind === "connect", "a tunnel"),
		when(sent.kind === "forward", "a forward"),
		when(!mappedOf(sent.destination), "an unmapped authority"),
		when(Option.isSome(sent.proxyAuthorization), "Proxy-Authorization"),
		when(sent.kind === "forward" && sent.proxyConnection, "Proxy-Connection"),
		when(Option.isNone(sent.destination.port) && mappedOf(sent.destination), "a default port"),
		when(
			sent.destination.upper && sent.destination.host !== "192.0.2.10",
			"an authority in another case"
		),
		when(sent.kind === "forward" && !Str.startsWith("/")(sent.path), "no path after the authority")
	])

describe("the recording proxy", () => {
	it.live(
		"records every head, tunnels and forwards to mapped authorities, and refuses the rest",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const server = yield* captureServer
					const listener = {
						host: "127.0.0.1",
						port: Number(new URL(server.origins["127.0.0.1"]).port)
					}
					const proxy = yield* recordingProxy(
						Rec.fromEntries(Arr.map(MAPPED, (authority) => [authority, listener]))
					)
					const proxyPort = Number(new URL(proxy.url).port)
					return yield* explore(
						{
							suite: "recording proxy",
							oracle: {
								kind: "specification",
								name: "the heads as sent, the tunnelled and forwarded requests as wire.ts frames them, and 502 for an unmapped authority"
							},
							draw: drawn((source): Arr.NonEmptyReadonlyArray<Hop> =>
								Arr.prepend(array(hop, { min: 0, max: 2 })(source), hop(source))
							),
							literal: Formatter.format,
							coverage: required<ProxyFeature>(
								[
									"a tunnel",
									"a forward",
									"an unmapped authority",
									"Proxy-Authorization",
									"Proxy-Connection",
									"a default port",
									"an authority in another case",
									"no path after the authority",
									"two hops"
								],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 60,
							shrink: { kind: "bounded", candidates: 200 },
							concurrency: 1,
							steerEvery: 20,
							caseHang: Duration.seconds(10)
						},
						(hops, k) =>
							Effect.gen(function* () {
								Arr.forEach(hops, (sent) => {
									k.noteAll(hopFeatures(sent))
								})
								if (hops.length > 1) {
									k.note("two hops")
								}
								const proxied = yield* proxy.observe(
									server.observe(
										() => ok,
										Effect.forEach(hops, (sent) => exchange(proxyPort, hopBytes(sent), untilClosed))
									)
								)
								const mapped = Arr.filter(hops, (sent) => mappedOf(sent.destination))
								deepStrictEqual(
									{
										heads: proxied.heads,
										requests: proxied.result.requests,
										statuses: Arr.map(proxied.result.result, statusesIn)
									},
									{
										heads: Arr.map(hops, headOf),
										requests: Arr.map(mapped, (sent, connection): RecordedRequest<PlainOrigin> => ({
											...forwardedOf(sent),
											origin: "127.0.0.1",
											connection
										})),
										statuses: Arr.map(hops, statusesOf)
									},
									"the proxy records every head and routes each hop as its authority says"
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
