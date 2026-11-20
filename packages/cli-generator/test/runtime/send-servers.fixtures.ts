/**
 * What send-servers.test.ts's property reads: a document whose operations take their servers from each level OpenAPI
 * has (their own, their path item's, the root's), the package generated from it once a worker with each servers table
 * it emits read back from its source, the sends over its operations, and what design 6.4's bound origin sets say of
 * each.
 */

import { element, finite, type FiniteSpace } from "@bjornpagen/testing/gen"
import { syntaxOf } from "@bjornpagen/testing/syntax"
import { type Json, jsonText } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Effect, FileSystem, Option, Order, Path, Predicate, Record } from "effect"
import { HttpClientRequest } from "effect/http"
import {
	type Expression,
	isArrayLiteralExpression,
	isIdentifier,
	isNumericLiteral,
	isObjectLiteralExpression,
	isPropertyAssignment,
	isStringLiteral,
	isVariableStatement,
	type PropertyName,
	type SourceFile
} from "typescript/ast"
import type * as Auth from "#runtime-src/runtime/auth.ts"
import type * as BaseUrl from "#runtime-src/runtime/base-url.ts"
import type * as Output from "#runtime-src/runtime/output.ts"
import { generateFixture, workerFixture } from "#test/support/cli-package.ts"
import { plainWorld, type Sent, sendIn } from "#test/support/send.ts"

/** A level's servers, their URLs in document order: a level that declares servers declares at least one. */
type Servers = Arr.NonEmptyReadonlyArray<string>

/** The servers the author config accepts, by URL; every other server of the document is not accepted. */
const ACCEPTED: ReadonlyArray<string> = [
	"https://api.example.com/v1",
	"https://a.example.com/v1",
	"https://b.example.com"
]

/** The root's servers. */
const ROOT: Servers = ["https://api.example.com/v1"]

/** The document's operations, one GET each, by operationId. */
const OPERATION_IDS = ["a-get", "b-get", "c-get", "d-get", "r-get"] as const

type OperationId = (typeof OPERATION_IDS)[number]

/** One operation of the document: its path, and the servers it and its path item declare. */
type Operation = Readonly<{
	path: string
	own: Option.Option<Servers>
	pathItem: Option.Option<Servers>
}>

/**
 * `a-get` declares servers of its own, the second of which the author does not accept though the root binds its origin;
 * `b-get`'s path item declares the servers; `c-get` declares one server the author does not accept; `d-get` declares
 * servers of its own over its path item's; `r-get` takes the root's.
 */
const OPERATIONS: Readonly<Record<OperationId, Operation>> = {
	"a-get": {
		path: "/a",
		own: Option.some(["https://a.example.com/v1", "https://api.example.com/v2"]),
		pathItem: Option.none()
	},
	"b-get": { path: "/b", own: Option.none(), pathItem: Option.some(["https://b.example.com"]) },
	"c-get": { path: "/c", own: Option.some(["https://c.example.com"]), pathItem: Option.none() },
	"d-get": {
		path: "/d",
		own: Option.some(["https://a.example.com/v1"]),
		pathItem: Option.some(["https://b.example.com"])
	},
	"r-get": { path: "/r", own: Option.none(), pathItem: Option.none() }
}

/** The token the environment holds for the bearer scheme. */
const SECRET = "tok-SRV-SECRET"

/** The authorization header a hop carries the token in. */
const CREDENTIAL = "Bearer tok-SRV-SECRET"

const serverObjects = (servers: Servers): ReadonlyArray<Json> =>
	Arr.map(servers, (url) => ({ url }))

/** A level's `servers` member: absent where the level declares none. */
const serversMember = (servers: Option.Option<Servers>): Readonly<Record<string, Json>> =>
	Option.match(servers, {
		onNone: () => ({}),
		onSome: (declared) => ({ servers: serverObjects(declared) })
	})

const spec = jsonText({
	components: { securitySchemes: { bearerAuth: { scheme: "bearer", type: "http" } } },
	info: { title: "servers", version: "1" },
	openapi: "3.1.0",
	paths: Record.fromEntries(
		Arr.map(OPERATION_IDS, (operationId) => {
			const operation = OPERATIONS[operationId]
			return [
				operation.path,
				{
					get: {
						operationId,
						responses: { "200": { description: "ok" } },
						security: [{ bearerAuth: [] }],
						...serversMember(operation.own)
					},
					...serversMember(operation.pathItem)
				}
			] as const
		})
	),
	servers: serverObjects(ROOT)
})

const config = jsonText({
	binName: "x",
	envPrefix: "X",
	package: { name: "x-cli", version: "1.0.0" },
	servers: { accepted: ACCEPTED }
})

/** Where an operation's servers come from: its own, its path item's, or the root's. */
type Level = "operation" | "path item" | "root"

/** The servers an operation sends by, and the level they come from. */
type Effective = Readonly<{ level: Level; servers: Servers }>

/** OpenAPI's precedence: an operation's own servers, else its path item's, else the root's. */
const effectiveOf = (operation: Operation): Effective =>
	Option.match(operation.own, {
		onSome: (servers): Effective => ({ level: "operation", servers }),
		onNone: () =>
			Option.match(operation.pathItem, {
				onSome: (servers): Effective => ({ level: "path item", servers }),
				onNone: (): Effective => ({ level: "root", servers: ROOT })
			})
	})

const isAccepted = (url: string): boolean => Arr.contains(ACCEPTED, url)

const originOf = (url: string): string => new URL(url).origin

/**
 * A servers table as the generated package holds it (runtime-src/runtime/base-url.ts ServersTable): every server of the
 * level, the index of the first accepted one as its default, and its bound origin set.
 */
type Table = Readonly<{
	boundOrigins: ReadonlyArray<string>
	defaultServer: Option.Option<number>
	servers: ReadonlyArray<Readonly<{ url: string }>>
}>

/** Design 6.4: a level's bound origin set is the origins of its accepted servers, sorted, each once. */
const tableOf = (servers: Servers): Table => ({
	boundOrigins: Arr.sort(
		Arr.dedupe(Arr.map(Arr.filter(servers, isAccepted), originOf)),
		Order.String
	),
	defaultServer: Arr.findFirstIndex(servers, isAccepted),
	servers: Arr.map(servers, (url) => ({ url }))
})

/** A table as the runtime takes it, whose default is a member it leaves out where the level accepts no server. */
const runtimeTable = (table: Table): BaseUrl.ServersTable => ({
	boundOrigins: table.boundOrigins,
	servers: table.servers,
	...Option.match(table.defaultServer, {
		onNone: () => ({}),
		onSome: (defaultServer) => ({ defaultServer })
	})
})

/** The tables the generator emitted: the root's (api/servers.ts), and each operation's own (its meta's), if it has one. */
type Emitted = Readonly<{ root: Table; own: Readonly<Record<OperationId, Option.Option<Table>>> }>

const nameOf = (name: PropertyName): Option.Option<string> =>
	isIdentifier(name) || isStringLiteral(name) ? Option.some(name.text) : Option.none()

/** An object literal's members by key, none when it states anything but `key: value` members. */
const membersOf = (expression: Expression): Option.Option<Readonly<Record<string, Expression>>> =>
	isObjectLiteralExpression(expression)
		? Option.map(
				Option.all(
					Arr.map(expression.properties, (member) =>
						isPropertyAssignment(member)
							? Option.map(nameOf(member.name), (key) => [key, member.initializer] as const)
							: Option.none()
					)
				),
				Record.fromEntries
			)
		: Option.none()

/** An object literal's members, none when it states a key beyond `keys`. */
const onlyMembersOf = (
	expression: Expression,
	keys: ReadonlyArray<string>
): Option.Option<Readonly<Record<string, Expression>>> =>
	Option.filter(membersOf(expression), (members) =>
		Arr.every(Record.keys(members), (key) => Arr.contains(keys, key))
	)

const stringOf = (expression: Expression): Option.Option<string> =>
	isStringLiteral(expression) ? Option.some(expression.text) : Option.none()

const indexOf = (expression: Expression): Option.Option<number> =>
	isNumericLiteral(expression)
		? Option.filter(Option.some(Number(expression.text)), Number.isSafeInteger)
		: Option.none()

/** An array literal read element by element, none when it is no array literal or one element is unread. */
const listOf =
	<A>(read: (element: Expression) => Option.Option<A>) =>
	(expression: Expression): Option.Option<ReadonlyArray<A>> =>
		isArrayLiteralExpression(expression)
			? Option.all(Arr.map(expression.elements, read))
			: Option.none()

/** A server entry's literal: its `url` and nothing else. */
const serverOf = (expression: Expression): Option.Option<Readonly<{ url: string }>> =>
	Option.flatMap(onlyMembersOf(expression, ["url"]), (members) =>
		Option.map(Option.flatMap(Record.get(members, "url"), stringOf), (url) => ({ url }))
	)

/** A servers table's literal: its bound origins, its servers and its default, if any, and nothing else. */
const tableFrom = (expression: Expression): Option.Option<Table> =>
	Option.flatMap(
		onlyMembersOf(expression, ["boundOrigins", "defaultServer", "servers"]),
		(members) =>
			Option.all({
				boundOrigins: Option.flatMap(Record.get(members, "boundOrigins"), listOf(stringOf)),
				defaultServer: Option.match(Record.get(members, "defaultServer"), {
					onNone: () => Option.some(Option.none<number>()),
					onSome: (index) => Option.map(indexOf(index), Option.some)
				}),
				servers: Option.flatMap(Record.get(members, "servers"), listOf(serverOf))
			})
	)

/** Each top-level `const` of a module: its name and its initializer. */
const constsOf = (tree: SourceFile): ReadonlyArray<readonly [string, Expression]> =>
	Arr.flatMap(tree.statements, (statement) =>
		isVariableStatement(statement)
			? Arr.flatMap(statement.declarationList.declarations, (declaration) =>
					isIdentifier(declaration.name) && declaration.initializer !== undefined
						? [[declaration.name.text, declaration.initializer] as const]
						: []
				)
			: []
	)

/** api/servers.ts's `servers` table. */
const rootTableOf = (tree: SourceFile): Option.Option<Table> =>
	Option.flatMap(
		Arr.findFirst(constsOf(tree), ([name, initializer]) =>
			name === "servers" ? Option.some(initializer) : Option.none()
		),
		tableFrom
	)

/**
 * An operation's own table, the `servers` member of the meta whose `operationId` is its id: none when the meta names no
 * table, and unread (the outer none) when no meta is the operation's or its table is unread.
 */
const ownTableOf =
	(tree: SourceFile) =>
	(operationId: OperationId): Option.Option<Option.Option<Table>> =>
		Option.flatMap(
			Arr.findFirst(constsOf(tree), ([, initializer]) =>
				Option.exists(
					Option.flatMap(
						Option.flatMap(membersOf(initializer), (members) => Record.get(members, "operationId")),
						stringOf
					),
					(id) => id === operationId
				)
					? Option.some(initializer)
					: Option.none()
			),
			(meta) =>
				Option.match(
					Option.flatMap(membersOf(meta), (members) => Record.get(members, "servers")),
					{
						onNone: () => Option.some(Option.none<Table>()),
						onSome: (table) => Option.map(tableFrom(table), Option.some)
					}
				)
		)

/**
 * The property's fixture, once per worker: the document generated with its author config, and the tables the package
 * emitted read back from its api modules' syntax.
 */
export const serversFixture = workerFixture(
	"test/runtime/send-servers.fixtures.ts serversFixture",
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: config },
			authorFiles: []
		})
		const read = <A>(module: string, reader: (tree: SourceFile) => Option.Option<A>) => {
			const file = path.join(generated.dir, "src/api", module)
			return Effect.flatMap(
				Effect.flatMap(fs.readFileString(file), (text) => syntaxOf(file, text, reader)),
				Effect.fromOption
			)
		}
		const emitted: Emitted = {
			root: yield* read("servers.ts", rootTableOf),
			own: yield* read("root.ts", (tree) =>
				Option.all(Record.map(OPERATIONS, (_, operationId) => ownTableOf(tree)(operationId)))
			)
		}
		return emitted
	})
)

/** A server of an operation's level that a run's `--server` names, by its index. */
type Named = Readonly<{ index: number; url: string }>

/**
 * One send: the operation, the server `--server` names (none for the level's accepted default), and where the answer to
 * the first hop redirects with a 302 (none for a 200).
 */
type SendCase = Readonly<{
	operation: OperationId
	server: Option.Option<Named>
	location: Option.Option<string>
}>

/** Each origin the document names, and one it does not. */
const ORIGINS: ReadonlyArray<string> = Arr.dedupe(
	Arr.map(
		[
			...ROOT,
			...Arr.flatMap(OPERATION_IDS, (operationId) =>
				Arr.flatten([
					...Option.toArray(OPERATIONS[operationId].own),
					...Option.toArray(OPERATIONS[operationId].pathItem)
				])
			),
			"https://elsewhere.example.com"
		],
		originOf
	)
)

/** Every operation, with no `--server` and with each server of its level, answered by a 200 or a 302 to each origin. */
export const sends: FiniteSpace<SendCase> = finite((source) => {
	const operation = element(OPERATION_IDS)(source)
	const server = element([
		Option.none<Named>(),
		...Arr.map(effectiveOf(OPERATIONS[operation]).servers, (url, index) =>
			Option.some({ index, url })
		)
	])(source)
	const location = element([
		Option.none<string>(),
		...Arr.map(ORIGINS, (origin) => Option.some(`${origin}/moved`))
	])(source)
	return { operation, server, location }
})

/** A hop the run sent: its URL, and the authorization header it carried. */
type Hop = Readonly<{ url: string; authorization: Option.Option<string> }>

/** What a run failed with: a usage error, by the flag it names and its message, or any other error, as it is. */
type Failure =
	| Readonly<{ kind: "usage"; flag: Option.Option<string>; message: string }>
	| Readonly<{ kind: "other"; error: unknown }>

/** A run's failure, read: a usage error by its flag, if it names one, and its message; any other error as it is. */
const failureOf = (error: unknown): Failure =>
	Predicate.isTagged(error, "UsageError") &&
	Predicate.hasProperty(error, "message") &&
	Predicate.isString(error.message)
		? {
				kind: "usage",
				flag:
					Predicate.hasProperty(error, "flag") && Predicate.isString(error.flag)
						? Option.some(error.flag)
						: Option.none(),
				message: error.message
			}
		: { kind: "other", error }

/** What a send shows: the root's table and the operation's own as emitted, the hops it sent, and what it failed with. */
type Verdict = Readonly<{
	root: Table
	own: Option.Option<Table>
	hops: ReadonlyArray<Hop>
	failure: Option.Option<Failure>
}>

const security: Auth.SecurityTable = {
	schemes: { bearerAuth: { kind: "http", scheme: "bearer" } }
}

/** The operation's meta as the generated package holds it, its own table the one the generator emitted. */
const metaOf = (sendCase: SendCase, emitted: Emitted): Output.OperationMeta => ({
	media: { request: [], responses: { "200": [] } },
	method: "GET",
	operationId: sendCase.operation,
	pathTemplate: OPERATIONS[sendCase.operation].path,
	security: [["bearerAuth"]],
	servers: Option.getOrUndefined(Option.map(emitted.own[sendCase.operation], runtimeTable))
})

/**
 * Sends the case's operation once, by the tables the generator emitted, with the token in the environment: the server
 * answers the first hop with a 302 to the case's location, if it has one, and every other as the harness's world does.
 */
export const sentOf = (sendCase: SendCase, emitted: Emitted) => {
	const world = plainWorld(
		metaOf(sendCase, emitted),
		HttpClientRequest.get(OPERATIONS[sendCase.operation].path)
	)
	return sendIn({
		...world,
		servers: runtimeTable(emitted.root),
		security,
		env: { EXAMPLE_BEARER_AUTH: SECRET },
		reply: (received, url) =>
			Option.match(
				Option.filter(sendCase.location, () => received === 1),
				{
					onNone: () => world.reply(received, url),
					onSome: (to) => new Response(null, { headers: { location: to }, status: 302 })
				}
			),
		server: Option.map(sendCase.server, (named) => String(named.index))
	})
}

/** What the run showed: the tables the generator emitted, each hop's URL and authorization header, and its failure. */
export const observedOf = (sendCase: SendCase, emitted: Emitted, sent: Sent): Verdict => ({
	root: emitted.root,
	own: emitted.own[sendCase.operation],
	hops: Arr.map(sent.requests, (wire) => ({
		url: wire.url,
		authorization: Arr.findFirst(wire.headers, ([name, value]) =>
			name === "authorization" ? Option.some(value) : Option.none()
		)
	})),
	failure: Option.map(sent.failure, failureOf)
})

/** Where a run's base comes from: the server it sends to, or the usage error that refuses it before any hop. */
type Base =
	| Readonly<{ kind: "sent"; url: string }>
	| Readonly<{ kind: "refused"; failure: Failure }>

/** A usage error naming `flag`, its message the flag and why. */
const usage = (flag: string, why: string): Base => ({
	kind: "refused",
	failure: { kind: "usage", flag: Option.some(flag), message: `${flag}: ${why}` }
})

/**
 * Design 6.4: with no `--server`, the level's first accepted server, and none accepted a usage error naming
 * `--base-url`; a `--server` entry whose origin the level does not bind, a usage error naming `--server`.
 */
const baseOf = (sendCase: SendCase, effective: Effective, table: Table): Base =>
	Option.match(sendCase.server, {
		onNone: () =>
			Option.match(Arr.findFirst(effective.servers, isAccepted), {
				onNone: () => usage("--base-url", "no server is accepted as a default; give a base URL"),
				onSome: (url): Base => ({ kind: "sent", url })
			}),
		onSome: (named): Base =>
			Arr.contains(table.boundOrigins, originOf(named.url))
				? { kind: "sent", url: named.url }
				: usage("--server", "the server URL is outside the origins bound at generation")
	})

/**
 * What design 6.4 says of a send: the root's table and the operation's own, which it has when its servers are not the
 * root's, each the table of its level; no hop when its base is refused, else a hop to the base and, after a 302, one to
 * the location, each carrying the credential exactly when the level's table binds its origin; and the refusal, if any.
 */
export const expectedOf = (sendCase: SendCase): Verdict => {
	const effective = effectiveOf(OPERATIONS[sendCase.operation])
	const table = tableOf(effective.servers)
	const hopTo = (url: string): Hop => ({
		url,
		authorization: Arr.contains(table.boundOrigins, originOf(url))
			? Option.some(CREDENTIAL)
			: Option.none()
	})
	const base = baseOf(sendCase, effective, table)
	return {
		root: tableOf(ROOT),
		own: effective.level === "root" ? Option.none() : Option.some(table),
		hops:
			base.kind === "refused"
				? []
				: [
						hopTo(`${base.url}${OPERATIONS[sendCase.operation].path}`),
						...Option.toArray(Option.map(sendCase.location, hopTo))
					],
		failure: base.kind === "refused" ? Option.some(base.failure) : Option.none()
	}
}

export type SendFeature =
	| "an operation's own servers"
	| "a path item's servers"
	| "the root's servers"
	| "its own servers over its path item's"
	| "a level that accepts no server"
	| "the accepted default"
	| "no accepted default"
	| "a --server entry the level binds"
	| "a --server entry only another level binds"
	| "a --server entry no level binds"
	| "a redirect within the bound set"
	| "a redirect to an origin only another level binds"
	| "a redirect to an origin no level binds"

/** Every origin some level binds: the root's, and each operation's level's. */
const everyBound: ReadonlyArray<string> = Arr.flatMap(
	[ROOT, ...Arr.map(OPERATION_IDS, (operationId) => effectiveOf(OPERATIONS[operationId]).servers)],
	(servers) => tableOf(servers).boundOrigins
)

/** The features a send reaches: its level, how it chooses its server, and where a redirect takes it. */
export const sendFeatures = (sendCase: SendCase): ReadonlyArray<SendFeature> => {
	const operation = OPERATIONS[sendCase.operation]
	const effective = effectiveOf(operation)
	const table = tableOf(effective.servers)
	const base = baseOf(sendCase, effective, table)
	const reach = (
		url: string,
		within: SendFeature,
		other: SendFeature,
		none: SendFeature
	): SendFeature =>
		Arr.contains(table.boundOrigins, originOf(url))
			? within
			: Arr.contains(everyBound, originOf(url))
				? other
				: none
	const levels: Readonly<Record<Level, SendFeature>> = {
		operation: "an operation's own servers",
		"path item": "a path item's servers",
		root: "the root's servers"
	}
	return [
		levels[effective.level],
		...(Option.isSome(operation.own) && Option.isSome(operation.pathItem)
			? ["its own servers over its path item's" as const]
			: []),
		...(Arr.some(effective.servers, isAccepted) ? [] : ["a level that accepts no server" as const]),
		...Option.match(sendCase.server, {
			onNone: (): ReadonlyArray<SendFeature> =>
				base.kind === "sent" ? ["the accepted default"] : ["no accepted default"],
			onSome: (named): ReadonlyArray<SendFeature> => [
				reach(
					named.url,
					"a --server entry the level binds",
					"a --server entry only another level binds",
					"a --server entry no level binds"
				)
			]
		}),
		...(base.kind === "sent"
			? Option.toArray(
					Option.map(sendCase.location, (location) =>
						reach(
							location,
							"a redirect within the bound set",
							"a redirect to an origin only another level binds",
							"a redirect to an origin no level binds"
						)
					)
				)
			: [])
	]
}
