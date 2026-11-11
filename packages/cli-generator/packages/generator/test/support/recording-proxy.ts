import { connect, createServer, type Socket as NetSocket } from "node:net"
import { regex } from "arkregex"
import { Array as Arr, Effect, MutableRef, Option, Record as Rec, String as Str } from "effect"
import type { Scope } from "effect"
import {
	closedOf,
	type ListenFailed,
	listen,
	makeSessions,
	tracked
} from "#test/support/connection.ts"
import { type Head, parseHead } from "#test/support/http.ts"

/** The local listener a proxied authority reaches. */
type ProxyTarget = Readonly<{ host: string; port: number }>

/**
 * What a run did to the proxy: the run's result and the head of every request the proxy read, in the order it read
 * them: a `CONNECT` it tunnelled or refused, or an absolute-form request it forwarded or refused.
 */
type ProxyObserved<A> = Readonly<{ result: A; heads: ReadonlyArray<Head> }>

/**
 * A recording forward proxy on 127.0.0.1: its URL, the URL with userinfo a client sends as Proxy-Authorization, and
 * `observe`, which runs an effect and waits until every connection the run opened to the proxy has closed.
 * Observations never overlap; a connection outside one is closed unanswered and unrecorded.
 */
type RecordingProxy = Readonly<{
	url: string
	urlWithUserinfo: (username: string, password: string) => string
	observe: <A, E, R>(run: Effect.Effect<A, E, R>) => Effect.Effect<ProxyObserved<A>, E, R>
}>

const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

const ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n"

/** The header lines a proxy consumes and never forwards. */
const HOP_HEADERS: ReadonlyArray<string> = ["connection", "proxy-authorization", "proxy-connection"]

/** An absolute-form target: its scheme, its authority as written and the path and query after it. */
const ABSOLUTE = regex("^(http|https)://([^/?#]+)([^#]*)$", "u")

/** An authority that names its port. */
const WITH_PORT = regex(":[0-9]+$", "u")

/**
 * Where a request goes, by the `host:port` authority it names in lower case. A `CONNECT` tunnels to its authority as
 * written. Any other request names an absolute-form target, whose authority takes its scheme's default port when it
 * names none; it is sent there in origin form (its path and query exactly as written), without the hop headers and with
 * `Connection: close`, so each hop is its own proxy connection. None when the head names neither.
 */
const routeOf = (head: Head): Option.Option<Readonly<{ authority: string; prefix: string }>> => {
	if (head.method === "CONNECT") {
		return Option.some({ authority: Str.toLowerCase(head.target), prefix: "" })
	}
	return Option.map(
		Option.fromNullishOr(ABSOLUTE.exec(head.target)),
		([, scheme, authority, rest]) => ({
			authority: Str.toLowerCase(
				WITH_PORT.test(authority) ? authority : `${authority}:${scheme === "https" ? "443" : "80"}`
			),
			prefix: `${Arr.join(
				[
					`${head.method} ${Str.startsWith("/")(rest) ? rest : `/${rest}`} HTTP/1.1`,
					...Arr.flatMap(head.headers, ([name, value]) =>
						Arr.contains(HOP_HEADERS, Str.toLowerCase(name)) ? [] : [`${name}: ${value}`]
					),
					"Connection: close"
				],
				"\r\n"
			)}\r\n\r\n`
		})
	)
}

/** Reads the request head off a fresh connection: its head and the bytes after it, or none when the bytes are not one. */
const headOf = (conn: NetSocket): Effect.Effect<Option.Option<readonly [Head, Buffer]>> =>
	Effect.callback<Option.Option<readonly [Head, Buffer]>>((resume) => {
		const received = MutableRef.make(Buffer.alloc(0))
		const onData = (chunk: Buffer) => {
			const parsed = parseHead(
				MutableRef.updateAndGet(received, (buffer) => Buffer.concat([buffer, chunk]))
			)
			if (parsed.kind === "incomplete") {
				return
			}
			conn.off("data", onData)
			conn.pause()
			resume(
				parsed.kind === "complete"
					? Effect.succeedSome<readonly [Head, Buffer]>([parsed.value, parsed.rest])
					: Effect.succeedNone
			)
		}
		conn.on("data", onData)
		return Effect.sync(() => {
			conn.off("data", onData)
		})
	})

/** Connects to a target, none when it refuses; closing the scope destroys the connection. */
const upstreamOf = (
	target: ProxyTarget
): Effect.Effect<Option.Option<NetSocket>, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.callback<Option.Option<NetSocket>>((resume) => {
			const upstream = connect(target.port, target.host)
			upstream.once("connect", () => {
				resume(Effect.succeedSome(upstream))
			})
			upstream.once("error", () => {
				upstream.destroy()
				resume(Effect.succeedNone)
			})
			return Effect.sync(() => {
				upstream.destroy()
			})
		}),
		(opened) =>
			Option.match(opened, {
				onNone: () => Effect.void,
				onSome: (upstream) =>
					Effect.sync(() => {
						upstream.destroy()
					})
			})
	)

/** Pipes the two sockets into each other until both have closed; an error on either destroys both. */
const relay = (client: NetSocket, upstream: NetSocket): Effect.Effect<void> =>
	Effect.suspend(() => {
		const destroyBoth = () => {
			client.destroy()
			upstream.destroy()
		}
		client.on("error", destroyBoth)
		upstream.on("error", destroyBoth)
		client.pipe(upstream)
		upstream.pipe(client)
		return Effect.all([closedOf(client), closedOf(upstream)], { discard: true, concurrency: 2 })
	})

/**
 * Serves one proxy connection: records its head, then tunnels or forwards it to its target, or answers `502` when the
 * map names no target for its authority or the target refuses, reading and dropping whatever the client sent after the
 * head so the refusal arrives whole. It ends when the client's connection closes.
 */
const serveProxied = (
	conn: NetSocket,
	targets: Readonly<Record<string, ProxyTarget>>,
	heads: Array<Head>
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const read = yield* headOf(conn)
		if (Option.isNone(read)) {
			conn.destroy()
			return
		}
		const [head, rest] = read.value
		heads.push(head)
		const route = routeOf(head)
		const upstream = yield* Option.match(
			Option.flatMap(route, ({ authority }) => Rec.get(targets, authority)),
			{ onNone: () => Effect.succeedNone, onSome: upstreamOf }
		)
		if (Option.isNone(route) || Option.isNone(upstream)) {
			conn.resume()
			conn.end(BAD_GATEWAY)
			return yield* closedOf(conn)
		}
		if (head.method === "CONNECT") {
			conn.write(ESTABLISHED)
		}
		upstream.value.write(Buffer.concat([Buffer.from(route.value.prefix, "latin1"), rest]))
		return yield* relay(conn, upstream.value)
	}).pipe(Effect.scoped, Effect.raceFirst(closedOf(conn)))

/**
 * Starts a recording forward proxy on 127.0.0.1 over a map from the `host:port` authority a client names, in lower case,
 * to the local listener it reaches. An authority missing from the map is answered `502`. A `CONNECT` is tunnelled byte for byte
 * after `200 Connection Established`; an absolute-form request is sent upstream in origin form. The scope stops it.
 */
export const recordingProxy = (
	targets: Readonly<Record<string, ProxyTarget>>
): Effect.Effect<RecordingProxy, ListenFailed, Scope.Scope> =>
	Effect.gen(function* () {
		const sessions = yield* makeSessions<Array<Head>>()
		const server = yield* tracked(createServer())
		server.on("connection", (conn: NetSocket) => {
			sessions.accept(conn, (heads) => serveProxied(conn, targets, heads))
		})
		const port = yield* listen(server)
		const host = `127.0.0.1:${String(port)}`
		const observe = <A, E, R>(run: Effect.Effect<A, E, R>): Effect.Effect<ProxyObserved<A>, E, R> =>
			Effect.suspend(() => {
				const heads: Array<Head> = []
				return Effect.map(sessions.observe(heads, run), (result) => ({ result, heads }))
			})
		const proxy: RecordingProxy = {
			url: `http://${host}`,
			urlWithUserinfo: (username, password) =>
				`http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}`,
			observe
		}
		return proxy
	})
