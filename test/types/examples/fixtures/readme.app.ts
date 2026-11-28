import net from "node:net"
import { Signer } from "@aws-sdk/rds-signer"
import { CredentialError } from "@bjornpagen/grizzle"
import { Db, DbLayer, roleNameOf, served, TokenRefused } from "@bjornpagen/grizzle/runtime"
import { verifyToken } from "@clerk/backend"
import { Config, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import pgDriver from "pg"
import type { Indexer, TrackerApp, UsageApi, Web } from "#test/types/examples/fixtures/readme.ts"

/**
 * The README's application: every ```ts block of README.md that runs in the application, reading a login's served
 * file, is below, in order, with one mechanical substitution: each served file the README imports from
 * migrations/<schema>/served/<login>.json is a declared value, since this directory holds no migrations. The logins are
 * readme.ts's, imported as types alone, as the README's application imports them. Typechecked, never executed.
 */
declare const webFile: unknown
declare const trackerFile: unknown
declare const usageFile: unknown
declare const indexerFile: unknown
/** The CA bundle and Clerk's public key the README's ./certs.ts exports. */
declare const caPem: string
declare const clerkJwtKey: string

type Equals<A, B> =
	(<X>(x: X) => X extends A ? 1 : 2) extends <X>(x: X) => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

/** The web login's compiled programs, as `grizzle generate` wrote them: the app runs no schema code. */
const WebServed = served<typeof Web>(webFile, "web")

const connection = {
	driver: pgDriver,
	transport: {
		kind: "sslRequest",
		host: "db.internal",
		port: 5432,
		open: () => new net.Socket(),
		ca: caPem,
		servername: "db.internal"
	},
	database: "app"
} as const

/** One pool for the web login, built once per process. */
const web = ManagedRuntime.make(
	DbLayer.make({
		...connection,
		login: WebServed,
		password: Config.Redacted("WEB_DB_PASSWORD").pipe(
			Effect.mapError((cause) => new CredentialError({ cause }))
		),
		pool: { max: 10 },
		verify: (token) =>
			Effect.tryPromise({
				try: () => verifyToken(token, { jwtKey: clerkJwtKey }),
				catch: (cause) => new TokenRefused({ cause })
			})
	})
)

const bearer = (request: Request) =>
	/^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1]

/** GET /posts: the caller's organization's published posts. */
export const GET = (request: Request) =>
	web.runPromise(
		Effect.gen(function* () {
			const token = bearer(request)
			if (token === undefined) {
				return new Response(null, { status: 401 })
			}
			const db = yield* Db.open(WebServed.roles.member, { token })
			const posts = yield* db.workload.feed.once({ params: {}, facts: {} })
			return Response.json(posts)
		})
	)

const TrackerServed = served<typeof TrackerApp>(trackerFile, "tracker")

/** The caller's token names their organization; every read and write is held to it. */
export const projectTasks = (token: string, project: string) =>
	Effect.gen(function* () {
		const db = yield* Db.open(TrackerServed.roles.teammate, { token })
		return yield* db.workload.openTasks.once({ params: { project }, facts: {} })
	})

export const tokenless =
	// @ts-expect-error -- TS2345: Property 'token' is missing in type '{}' but required in type '{ readonly token: string; }'.
	Db.open(TrackerServed.roles.teammate, {})

const UsageServed = served<typeof UsageApi>(usageFile, "usage_api")

/** The first 50 calls, then the 50 after the last one shown. */
export const calls = (workspace: string) =>
	Effect.gen(function* () {
		const db = yield* Db.open(UsageServed.roles.analyst, {})
		const first = yield* db.workload.callLog.once({
			params: { workspace },
			facts: {},
			window: { anchor: { kind: "start" }, size: 50 }
		})
		const last = [...first.entries()].at(-1)
		if (last === undefined) {
			return [...first]
		}
		const next = yield* db.workload.callLog.once({
			params: { workspace },
			facts: {},
			window: { anchor: { kind: "after", key: last.key }, size: 50 }
		})
		return [...first, ...next]
	})

const IndexerServed = served<typeof Indexer>(indexerFile, "indexer")

/** The indexer signs a fresh RDS IAM token for every connection it opens. */
export const IndexerLayer = DbLayer.make({
	...connection,
	login: IndexerServed,
	pool: { max: 2 },
	password: Effect.tryPromise({
		try: () =>
			new Signer({
				hostname: "db.internal",
				port: 5432,
				region: "us-east-1",
				username: roleNameOf(IndexerServed, connection)
			}).getAuthToken(),
		catch: (cause) => new CredentialError({ cause })
	}).pipe(Effect.map(Redacted.make))
})

/** A post as the client sends it, decoded with Effect Schema. */
const NewPost = Schema.Struct({ slug: Schema.String, title: Schema.String, body: Schema.String })

/** POST /posts: 201 written, 200 already there, 409 refused by a rule, 422 not a post. */
export const POST = (request: Request) =>
	web.runPromise(
		Effect.gen(function* () {
			const token = bearer(request)
			if (token === undefined) {
				return 401
			}
			const post = yield* Effect.flatMap(
				Effect.promise(() => request.json()),
				Schema.decodeUnknownEffect(NewPost)
			)
			const db = yield* Db.open(WebServed.roles.member, { token })
			const outcome = yield* db.workload.write.once({
				params: {},
				facts: { insert: { MyPost: [{ ...post, status: "draft" }] } }
			})
			return outcome._tag === "accepted" ? 201 : 200
		}).pipe(
			Effect.catchTags({
				refused: () => Effect.succeed(409),
				SchemaError: () => Effect.succeed(422)
			}),
			Effect.map((status) => new Response(null, { status }))
		)
	)

/** "The indexer's layer needs nothing else: its login reads nothing live." */
export type IndexerNeedsNothing = Expect<Equals<Layer.Services<typeof IndexerLayer>, never>>
