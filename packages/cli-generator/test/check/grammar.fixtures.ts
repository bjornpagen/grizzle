/**
 * What the properties of grammar.test.ts read: their document sketches, the documents they write, and the findings
 * each rule of design 3.4 states for them, every finding its code, severity, scope, pointer and the operation it
 * concerns.
 */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	array,
	boolean,
	constant,
	element,
	finite,
	type Gen,
	int,
	oneOf,
	option,
	subarray,
	subset
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Record as Rec, String as Str } from "effect"
import { checkGrammar } from "#check/grammar.ts"
import { checkSpecText } from "#check/index.ts"
import { pointerOrder } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { documentAt, lineGen, resolvedAt, token } from "#test/support/normalizing.ts"

/** The members a document holds beside its info and its declared version. */
type Members = Rec.ReadonlyRecord<string, Json>

/** The operation a finding concerns, as a diagnostic names it. */
type Concerned = Readonly<{ method: string; path: string }>

/** A diagnostic as the properties compare it. */
export type Seen = Readonly<{
	code: string
	severity: Diagnostic["severity"]
	scope: Diagnostic["scope"]
	pointer: string
	operation: Option.Option<Concerned>
}>

const seenOf = (diagnostic: Diagnostic): Seen => ({
	code: diagnostic.code,
	severity: diagnostic.severity,
	scope: diagnostic.scope,
	pointer: String(diagnostic.pointer),
	operation: Option.map(Option.fromUndefinedOr(diagnostic.operation), (operation) => ({
		method: operation.method,
		path: operation.path
	}))
})

/** What checkGrammar finds in the document of `line` that holds `members`. */
const grammarOf = (line: SpecLine, members: Members) =>
	Effect.map(
		Effect.flatMap(resolvedAt(line, documentAt(line, members), []), checkGrammar),
		Arr.map(seenOf)
	)

/** A JSON Pointer from its tokens, each escaped. */
const pointerOf = (tokens: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(tokens, (each) => `/${token(each)}`),
		""
	)

/** A finding at `tokens` that concerns no one operation. */
const seenAt = (
	code: string,
	severity: Diagnostic["severity"],
	scope: Diagnostic["scope"],
	tokens: ReadonlyArray<string>
): Seen => ({ code, severity, scope, pointer: pointerOf(tokens), operation: Option.none() })

/** A finding at `tokens` at operation scope, for the operation it concerns. */
const operationSeen = (
	code: string,
	severity: Diagnostic["severity"],
	tokens: ReadonlyArray<string>,
	operation: Concerned
): Seen => ({
	code,
	severity,
	scope: "operation",
	pointer: pointerOf(tokens),
	operation: Option.some(operation)
})

/** The members of `value` when `present`, none otherwise. */
const when = (present: boolean, value: Members): Members => (present ? value : {})

/** The member `name` holding the value of `value`, none when it is absent. */
const optionally = <A>(
	name: string,
	value: Option.Option<A>,
	write: (present: A) => Json
): Members =>
	Option.match(value, { onNone: () => ({}), onSome: (present) => ({ [name]: write(present) }) })

/** The one response every drawn operation holds. */
const responses: Json = { "200": { description: "ok" } }

/** The methods the drawn path items' operations use. */
const methods = ["get", "put"] as const

type Method = (typeof methods)[number]

/** The operation a method of a path names, as a diagnostic names it. */
const concerned = (method: Method, path: string): Concerned => ({
	method: Str.toUpperCase(method),
	path
})

/** A server variable: no enum, a default among its enum, or a default outside it. */
type Variable = "free" | "listed" | "unlisted"

/**
 * A Server Object: what follows its URL's path (nothing, a query or a fragment), whether its one variable appears in
 * the URL twice, the variable, and its name.
 */
type Server = Readonly<{
	tail: "" | "?x=1" | "#top"
	repeated: boolean
	variable: Variable
	name: Option.Option<"prod" | "stage">
}>

/** A path item: its own servers, and its operations, each with its own. */
type ServersItem = Readonly<{
	servers: Option.Option<ReadonlyArray<Server>>
	operations: ReadonlyArray<readonly [Method, Option.Option<ReadonlyArray<Server>>]>
}>

/** A document's servers at every level: the root's, and two path items'. */
export type ServersSketch = Readonly<{
	line: SpecLine
	root: Option.Option<ReadonlyArray<Server>>
	items: Readonly<{ "/a": ServersItem; "/b": ServersItem }>
}>

/** What a case reaches. */
export type ServersFeature =
	| "operation servers"
	| "path item servers"
	| "root servers"
	| "no servers"
	| "an empty override"
	| "root servers no operation uses"
	| "one list for two operations"
	| "a query"
	| "a fragment"
	| "a repeated variable"
	| "a default outside its enum, refused"
	| "a default outside its enum, a 3.0 notice"
	| "a default among its enum"
	| "a repeated name in 3.2"
	| "a repeated name before 3.2"

const server: Gen<Server> = (source) => ({
	tail: element(["", "?x=1", "#top"])(source),
	repeated: boolean(source),
	variable: element(["free", "listed", "unlisted"])(source),
	name: option(element(["prod", "stage"]))(source)
})

const serverList: Gen<ReadonlyArray<Server>> = array(server, { min: 0, max: 3 })

/** A level's servers: absent as often as present, so an operation that no level gives a list is a common case. */
const serverLevel: Gen<Option.Option<ReadonlyArray<Server>>> = oneOf([
	constant(Option.none()),
	(source) => Option.some(serverList(source))
])

const serversItem: Gen<ServersItem> = (source) => ({
	servers: serverLevel(source),
	operations: Arr.map(subarray(methods)(source), (method) => [method, serverLevel(source)])
})

export const serversSpace: Gen<ServersSketch> = (source) => ({
	line: lineGen(source),
	root: serverLevel(source),
	items: { "/a": serversItem(source), "/b": serversItem(source) }
})

const variableOf = (variable: Variable): Json => {
	switch (variable) {
		case "free":
			return { default: "eu" }
		case "listed":
			return { default: "eu", enum: ["eu", "us"] }
		case "unlisted":
			return { default: "x", enum: ["eu", "us"] }
	}
}

const serverOf = (each: Server): Json => ({
	url: `https://{v}.example.com/v1${each.repeated ? "/{v}" : ""}${each.tail}`,
	variables: { v: variableOf(each.variable) },
	...optionally("name", each.name, (name) => name)
})

const serversOf = (list: ReadonlyArray<Server>): Json => Arr.map(list, serverOf)

const serversDocument = (sketch: ServersSketch): Members => ({
	...optionally("servers", sketch.root, serversOf),
	paths: Rec.map(sketch.items, (item) => ({
		...optionally("servers", item.servers, serversOf),
		...Rec.fromEntries(
			Arr.map(item.operations, ([method, servers]) => [
				method,
				{ responses, ...optionally("servers", servers, serversOf) }
			])
		)
	}))
})

/** The level whose list an operation uses (design 6.4, SRV-15): its own, its path item's, the root's, or none. */
type Level = "operation" | "path item" | "root" | "none"

/** The list an operation uses, the tokens of the object that holds it, and its level. */
type Effective = Readonly<{
	level: Level
	owner: ReadonlyArray<string>
	servers: ReadonlyArray<Server>
}>

const effectiveOf = (
	sketch: ServersSketch,
	path: string,
	method: Method,
	item: ServersItem,
	own: Option.Option<ReadonlyArray<Server>>
): Effective =>
	Option.match(own, {
		onSome: (servers): Effective => ({
			level: "operation",
			owner: ["paths", path, method],
			servers
		}),
		onNone: () =>
			Option.match(item.servers, {
				onSome: (servers): Effective => ({ level: "path item", owner: ["paths", path], servers }),
				onNone: () =>
					Option.match(sketch.root, {
						onSome: (servers): Effective => ({ level: "root", owner: [], servers }),
						onNone: (): Effective => ({ level: "none", owner: [], servers: [] })
					})
			})
	})

/** Every operation of the sketch, with the path that holds it and the list it uses. */
const serverUses = (sketch: ServersSketch) =>
	Arr.flatMap(Rec.toEntries(sketch.items), ([path, item]) =>
		Arr.map(item.operations, ([method, own]) => ({
			operation: concerned(method, path),
			effective: effectiveOf(sketch, path, method, item, own)
		}))
	)

/**
 * Each server's findings in the list an operation uses: a query or a fragment in its URL (SRV-18), a variable in it
 * twice (SRV-19), a default outside its variable's enum (SRV-12, a notice in 3.0, whose text only recommends it), and,
 * in 3.2, a name an earlier server of the list holds (SRV-04); every one at operation scope.
 */
const serverFindings = (line: SpecLine, effective: Effective, operation: Concerned) =>
	Arr.flatMap(effective.servers, (each, index): ReadonlyArray<Seen> => {
		const at = [...effective.owner, "servers", String(index)]
		const earlier = Arr.take(effective.servers, index)
		return [
			...(each.tail === ""
				? []
				: [operationSeen("SRV-18/query-or-fragment", "refusal", [...at, "url"], operation)]),
			...(each.repeated
				? [operationSeen("SRV-19/repeated-variable", "refusal", [...at, "url"], operation)]
				: []),
			...(each.variable === "unlisted"
				? [
						operationSeen(
							"SRV-12/default-not-in-enum",
							line === "3.0" ? "notice" : "refusal",
							[...at, "variables", "v"],
							operation
						)
					]
				: []),
			...(line === "3.2" &&
			Option.exists(each.name, (name) =>
				Arr.some(earlier, (before) => Option.contains(before.name, name))
			)
				? [operationSeen("SRV-04/duplicate-name", "refusal", [...at, "name"], operation)]
				: [])
		]
	})

export const serversExpected = (sketch: ServersSketch): ReadonlyArray<Seen> =>
	Arr.flatMap(serverUses(sketch), ({ operation, effective }) =>
		serverFindings(sketch.line, effective, operation)
	)

export const serversActual = (sketch: ServersSketch) =>
	grammarOf(sketch.line, serversDocument(sketch))

const repeatsAName = (servers: ReadonlyArray<Server>): boolean => {
	const names = Arr.getSomes(Arr.map(servers, (each) => each.name))
	return Arr.dedupe(names).length !== names.length
}

export const serversFeatures = (sketch: ServersSketch): ReadonlyArray<ServersFeature> => {
	const uses = serverUses(sketch)
	const used = Arr.flatMap(uses, ({ effective }) => effective.servers)
	const levels = Arr.map(uses, ({ effective }) => effective.level)
	const inheritRoot = Arr.filter(levels, (level) => level === "root").length
	return [
		...(Arr.contains(levels, "operation") ? (["operation servers"] as const) : []),
		...(Arr.contains(levels, "path item") ? (["path item servers"] as const) : []),
		...(Arr.contains(levels, "root") ? (["root servers"] as const) : []),
		...(Arr.contains(levels, "none") ? (["no servers"] as const) : []),
		...(Arr.some(
			uses,
			({ effective }) =>
				effective.level === "operation" && Arr.isReadonlyArrayEmpty(effective.servers)
		)
			? (["an empty override"] as const)
			: []),
		...(Option.isSome(sketch.root) && Arr.isReadonlyArrayNonEmpty(uses) && inheritRoot === 0
			? (["root servers no operation uses"] as const)
			: []),
		...(inheritRoot > 1 ? (["one list for two operations"] as const) : []),
		...(Arr.some(used, (each) => each.tail === "?x=1") ? (["a query"] as const) : []),
		...(Arr.some(used, (each) => each.tail === "#top") ? (["a fragment"] as const) : []),
		...(Arr.some(used, (each) => each.repeated) ? (["a repeated variable"] as const) : []),
		...(Arr.some(used, (each) => each.variable === "unlisted")
			? sketch.line === "3.0"
				? (["a default outside its enum, a 3.0 notice"] as const)
				: (["a default outside its enum, refused"] as const)
			: []),
		...(Arr.some(used, (each) => each.variable === "listed")
			? (["a default among its enum"] as const)
			: []),
		...(Arr.some(uses, ({ effective }) => repeatsAName(effective.servers))
			? sketch.line === "3.2"
				? (["a repeated name in 3.2"] as const)
				: (["a repeated name before 3.2"] as const)
			: [])
	]
}

/**
 * A name a security requirement uses: each declared scheme by its component name (an API key, OAuth 2 and OpenID
 * Connect), a name no scheme has, and the key scheme's URI.
 */
const schemeNames = ["key", "oauth", "oidc", "nope", "#/components/securitySchemes/key"] as const

type SchemeName = (typeof schemeNames)[number]

/** A Security Requirement Object: each name it lists, with no scopes or one. */
type Requirement = ReadonlyArray<readonly [SchemeName, "none" | "read"]>

/** The root's security list and the operations of one path item, each with its own list or none. */
export type SecuritySketch = Readonly<{
	line: SpecLine
	root: Option.Option<ReadonlyArray<Requirement>>
	operations: ReadonlyArray<readonly [Method, Option.Option<ReadonlyArray<Requirement>>]>
}>

/** What a case reaches. */
export type SecurityFeature =
	| "an unresolved name beside a usable alternative"
	| "every alternative unresolved"
	| "an empty alternative"
	| "a root list no alternative of leaves to an operation"
	| "a root list no alternative of, every operation its own"
	| "a scheme URI in 3.2"
	| "a scheme URI before 3.2"
	| "scopes on a scheme that takes none, in 3.0"
	| "scopes on a scheme that takes them"
	| "scopes on a scheme that takes none, after 3.0"

const requirement: Gen<Requirement> = (source) =>
	Arr.map(subset(schemeNames, { min: 0, max: 2 })(source), (name) => [
		name,
		element(["none", "read"])(source)
	])

const requirementList: Gen<ReadonlyArray<Requirement>> = array(requirement, { min: 0, max: 3 })

export const securitySpace: Gen<SecuritySketch> = (source) => ({
	line: lineGen(source),
	root: option(requirementList)(source),
	operations: Arr.map(subarray(methods)(source), (method) => [
		method,
		option(requirementList)(source)
	])
})

const requirementsOf = (list: ReadonlyArray<Requirement>): Json =>
	Arr.map(list, (each) =>
		Rec.fromEntries(Arr.map(each, ([name, scopes]) => [name, scopes === "none" ? [] : ["read"]]))
	)

const securityDocument = (sketch: SecuritySketch): Members => ({
	components: {
		securitySchemes: {
			key: { in: "header", name: "X-Key", type: "apiKey" },
			oauth: { flows: {}, type: "oauth2" },
			oidc: { openIdConnectUrl: "https://example.com/.well-known", type: "openIdConnect" }
		}
	},
	...optionally("security", sketch.root, requirementsOf),
	paths: {
		"/a": Rec.fromEntries(
			Arr.map(sketch.operations, ([method, list]) => [
				method,
				{ responses, ...optionally("security", list, requirementsOf) }
			])
		)
	}
})

/**
 * Whether a name resolves to a declared scheme: a component name on every line, and the scheme's URI in 3.2 alone
 * (SEC-10), where 3.0 and 3.1 read a name as a component name only (SEC-09).
 */
const resolves = (line: SpecLine, name: SchemeName): boolean =>
	name === "#/components/securitySchemes/key" ? line === "3.2" : name !== "nope"

/** Whether the scheme a resolving name names takes scopes: OAuth 2 and OpenID Connect only. */
const takesScopes = (name: SchemeName): boolean => name === "oauth" || name === "oidc"

/** A list's findings, before scoping: each name that resolves to no scheme, and each 3.0 scope list on a scheme that takes none. */
type ListFindings = Readonly<{
	exhausted: boolean
	unresolved: ReadonlyArray<ReadonlyArray<string>>
	scopes: ReadonlyArray<Seen>
}>

const listFindings = (
	line: SpecLine,
	list: ReadonlyArray<Requirement>,
	at: ReadonlyArray<string>
): ListFindings => {
	const unresolvedIn = (each: Requirement) => Arr.filter(each, ([name]) => !resolves(line, name))
	return {
		exhausted:
			Arr.isReadonlyArrayNonEmpty(list) &&
			Arr.every(list, (each) => Arr.isReadonlyArrayNonEmpty(unresolvedIn(each))),
		unresolved: Arr.flatMap(list, (each, index) =>
			Arr.map(unresolvedIn(each), ([name]) => [...at, String(index), name])
		),
		scopes: Arr.flatMap(list, (each, index) =>
			Arr.flatMap(each, ([name, scopes]) =>
				line === "3.0" && resolves(line, name) && !takesScopes(name) && scopes === "read"
					? [seenAt("SEC-12/non-empty-scopes", "refusal", "element", [...at, String(index), name])]
					: []
			)
		)
	}
}

const unresolvedCode = (line: SpecLine): string =>
	line === "3.2" ? "SEC-10/unresolved-scheme" : "SEC-09/unresolved-scheme"

/**
 * The security findings: a name that resolves to no scheme is refused at the name, as an element while another
 * alternative of its list stays usable, and as the refusal of each operation the list leaves no alternative, which for
 * the root's list is each operation that inherits it; a 3.0 scheme other than OAuth 2 and OpenID Connect listing scopes
 * is refused at the name (SEC-12).
 */
export const securityExpected = (sketch: SecuritySketch): ReadonlyArray<Seen> => {
	const code = unresolvedCode(sketch.line)
	const asElements = (found: ListFindings) =>
		Arr.map(found.unresolved, (at) => seenAt(code, "refusal", "element", at))
	const asOperation = (found: ListFindings, operation: Concerned) =>
		Arr.map(found.unresolved, (at) => operationSeen(code, "refusal", at, operation))
	const inheriting = Arr.filter(sketch.operations, ([, own]) => Option.isNone(own))
	const root = Option.match(sketch.root, {
		onNone: (): ReadonlyArray<Seen> => [],
		onSome: (list) => {
			const found = listFindings(sketch.line, list, ["security"])
			return [
				...(found.exhausted && Arr.isReadonlyArrayNonEmpty(inheriting)
					? Arr.flatMap(inheriting, ([method]) => asOperation(found, concerned(method, "/a")))
					: asElements(found)),
				...found.scopes
			]
		}
	})
	const own = Arr.flatMap(sketch.operations, ([method, list]) =>
		Option.match(list, {
			onNone: (): ReadonlyArray<Seen> => [],
			onSome: (present) => {
				const found = listFindings(sketch.line, present, ["paths", "/a", method, "security"])
				return [
					...(found.exhausted ? asOperation(found, concerned(method, "/a")) : asElements(found)),
					...found.scopes
				]
			}
		})
	)
	return [...root, ...own]
}

export const securityActual = (sketch: SecuritySketch) =>
	grammarOf(sketch.line, securityDocument(sketch))

export const securityFeatures = (sketch: SecuritySketch): ReadonlyArray<SecurityFeature> => {
	const lists = [
		...Option.toArray(sketch.root),
		...Arr.flatMap(sketch.operations, ([, list]) => Option.toArray(list))
	]
	const requirements = Arr.flatten(lists)
	const names = Arr.flatten(requirements)
	const found = Arr.map(lists, (list) => listFindings(sketch.line, list, []))
	const rootExhausted = Option.exists(
		sketch.root,
		(list) => listFindings(sketch.line, list, []).exhausted
	)
	const inherited = Arr.some(sketch.operations, ([, own]) => Option.isNone(own))
	return [
		...(Arr.some(found, (each) => !each.exhausted && Arr.isReadonlyArrayNonEmpty(each.unresolved))
			? (["an unresolved name beside a usable alternative"] as const)
			: []),
		...(Arr.some(found, (each) => each.exhausted)
			? (["every alternative unresolved"] as const)
			: []),
		...(Arr.some(requirements, Arr.isReadonlyArrayEmpty)
			? (["an empty alternative"] as const)
			: []),
		...(rootExhausted && inherited
			? (["a root list no alternative of leaves to an operation"] as const)
			: []),
		...(rootExhausted && !inherited
			? (["a root list no alternative of, every operation its own"] as const)
			: []),
		...(Arr.some(names, ([name]) => name === "#/components/securitySchemes/key")
			? sketch.line === "3.2"
				? (["a scheme URI in 3.2"] as const)
				: (["a scheme URI before 3.2"] as const)
			: []),
		...(Arr.some(names, ([name, scopes]) => scopes === "read" && takesScopes(name))
			? (["scopes on a scheme that takes them"] as const)
			: []),
		...(Arr.some(
			names,
			([name, scopes]) => scopes === "read" && resolves(sketch.line, name) && !takesScopes(name)
		)
			? sketch.line === "3.0"
				? (["scopes on a scheme that takes none, in 3.0"] as const)
				: (["scopes on a scheme that takes none, after 3.0"] as const)
			: [])
	]
}

/** A content key: an RFC 9110 media type or range, or a key that is none. */
const contentKeys = [
	"application/json",
	"text/*",
	"*/*",
	"application/vnd.github.v3+json",
	"text/plain; charset=utf-8",
	"not a type",
	"string",
	"text/",
	"/json"
] as const

type ContentKey = (typeof contentKeys)[number]

/** Whether a content key is an RFC 9110 media type or range: a type and a subtype, or a range of either. */
const isMediaRange = (key: ContentKey): boolean =>
	key === "application/json" ||
	key === "text/*" ||
	key === "*/*" ||
	key === "application/vnd.github.v3+json" ||
	key === "text/plain; charset=utf-8"

/**
 * Every Content map a document holds: an operation's parameter, request body and response, the components'
 * parameter, request body, response and header, a response's header, a callback's request body and a webhook's.
 */
const contentSites = [
	"parameter",
	"requestBody",
	"response",
	"responseHeader",
	"callback",
	"webhook",
	"componentParameter",
	"componentRequestBody",
	"componentResponse",
	"componentHeader"
] as const

type ContentSite = (typeof contentSites)[number]

/** Each Content map a document holds, with its keys. */
export type ContentSketch = Readonly<{
	line: SpecLine
	maps: ReadonlyArray<readonly [ContentSite, ReadonlyArray<ContentKey>]>
}>

/** What a case reaches. */
export type ContentFeature =
	| `a key that is no media range, under ${ContentSite}`
	| "a media range"
	| "a webhook in 3.0"

export const contentSpace: Gen<ContentSketch> = (source) => ({
	line: lineGen(source),
	maps: Arr.map(subset(contentSites, { min: 1, max: 4 })(source), (site) => [
		site,
		subset(contentKeys, { min: 1, max: 3 })(source)
	])
})

/** The tokens of each site's Content map. */
const contentAt: Readonly<Record<ContentSite, ReadonlyArray<string>>> = {
	parameter: ["paths", "/a", "get", "parameters", "0", "content"],
	requestBody: ["paths", "/a", "post", "requestBody", "content"],
	response: ["paths", "/a", "get", "responses", "200", "content"],
	responseHeader: ["paths", "/a", "get", "responses", "200", "headers", "X-Rate", "content"],
	callback: [
		"paths",
		"/a",
		"post",
		"callbacks",
		"done",
		"{$request.body#/url}",
		"post",
		"requestBody",
		"content"
	],
	webhook: ["webhooks", "done", "post", "requestBody", "content"],
	componentParameter: ["components", "parameters", "P", "content"],
	componentRequestBody: ["components", "requestBodies", "B", "content"],
	componentResponse: ["components", "responses", "R", "content"],
	componentHeader: ["components", "headers", "H", "content"]
}

const contentDocument = (sketch: ContentSketch): Members => {
	const content = (site: ContentSite): Json =>
		Option.match(
			Arr.findFirst(sketch.maps, ([each]) => each === site),
			{
				onNone: () => ({ "application/json": {} }),
				onSome: ([, keys]) => Rec.fromEntries(Arr.map(keys, (key) => [key, {}]))
			}
		)
	const body = (site: ContentSite): Members => ({
		requestBody: { content: content(site) },
		responses
	})
	return {
		components: {
			headers: { H: { content: content("componentHeader") } },
			parameters: { P: { content: content("componentParameter"), in: "query", name: "q" } },
			requestBodies: { B: { content: content("componentRequestBody") } },
			responses: { R: { content: content("componentResponse"), description: "ok" } }
		},
		paths: {
			"/a": {
				get: {
					parameters: [{ content: content("parameter"), in: "query", name: "q" }],
					responses: {
						"200": {
							content: content("response"),
							description: "ok",
							headers: { "X-Rate": { content: content("responseHeader") } }
						}
					}
				},
				post: {
					...body("requestBody"),
					callbacks: { done: { "{$request.body#/url}": { post: body("callback") } } }
				}
			}
		},
		webhooks: { done: { post: body("webhook") } }
	}
}

/**
 * MED-24: a key of any Content map that is no RFC 9110 media type or range is refused at the key, as an element;
 * webhooks, which 3.0 does not have, are read from 3.1 on.
 */
export const contentExpected = (sketch: ContentSketch): ReadonlyArray<Seen> =>
	Arr.flatMap(sketch.maps, ([site, keys]) =>
		site === "webhook" && sketch.line === "3.0"
			? []
			: Arr.flatMap(keys, (key) =>
					isMediaRange(key)
						? []
						: [seenAt("MED-24/invalid-media-type", "refusal", "element", [...contentAt[site], key])]
				)
	)

export const contentActual = (sketch: ContentSketch) =>
	grammarOf(sketch.line, contentDocument(sketch))

export const contentFeatures = (sketch: ContentSketch): ReadonlyArray<ContentFeature> => [
	...Arr.flatMap(sketch.maps, ([site, keys]): ReadonlyArray<ContentFeature> =>
		Arr.some(keys, (key) => !isMediaRange(key))
			? [`a key that is no media range, under ${site}`]
			: []
	),
	...(Arr.some(sketch.maps, ([, keys]) => Arr.some(keys, isMediaRange))
		? (["a media range"] as const)
		: []),
	...(sketch.line === "3.0" && Arr.some(sketch.maps, ([site]) => site === "webhook")
		? (["a webhook in 3.0"] as const)
		: [])
]

/** A header name: an RFC 9110 token, or a name that is none. */
const headerNames = ["X-Good", "Accept", "X Bad", "bad:name", "a/b"] as const

type HeaderName = (typeof headerNames)[number]

const isToken = (name: HeaderName): boolean => name === "X-Good" || name === "Accept"

/**
 * Every place a document names a header: a header parameter of an operation, of a path item and of the components,
 * a response's header and a component response's, and a multipart encoding's; and a query parameter, whose name is
 * no header.
 */
const nameSites = [
	"operationParameter",
	"pathItemParameter",
	"componentParameter",
	"queryParameter",
	"responseHeader",
	"componentResponseHeader",
	"encodingHeader"
] as const

type NameSite = (typeof nameSites)[number]

/** The name each place uses. */
export type NamesSketch = Readonly<{
	line: SpecLine
	names: Readonly<Record<NameSite, HeaderName>>
}>

/** What a case reaches. */
export type NamesFeature = `a name that is no token, at ${NameSite}` | "a token"

export const namesSpace: Gen<NamesSketch> = (source) => ({
	line: lineGen(source),
	names: {
		operationParameter: element(headerNames)(source),
		pathItemParameter: element(headerNames)(source),
		componentParameter: element(headerNames)(source),
		queryParameter: element(headerNames)(source),
		responseHeader: element(headerNames)(source),
		componentResponseHeader: element(headerNames)(source),
		encodingHeader: element(headerNames)(source)
	}
})

const namesDocument = (sketch: NamesSketch): Members => {
	const { names } = sketch
	return {
		components: {
			parameters: { H: { in: "header", name: names.componentParameter, schema: {} } },
			responses: {
				R: { description: "ok", headers: { [names.componentResponseHeader]: { schema: {} } } }
			}
		},
		paths: {
			"/a": {
				parameters: [{ in: "header", name: names.pathItemParameter, schema: {} }],
				get: {
					parameters: [
						{ in: "header", name: names.operationParameter, schema: {} },
						{ in: "query", name: names.queryParameter, schema: {} }
					],
					responses: {
						"200": { description: "ok", headers: { [names.responseHeader]: { schema: {} } } }
					}
				},
				post: {
					requestBody: {
						content: {
							"multipart/form-data": {
								encoding: { file: { headers: { [names.encodingHeader]: { schema: {} } } } },
								schema: {}
							}
						}
					},
					responses
				}
			}
		}
	}
}

/**
 * Each header name that is no RFC 9110 token is refused, as an element: a header parameter's at its name (PRM-20), a
 * response header's at its key (RSP-09), an encoding header's at its key (HDR-01); a query parameter's name is never
 * refused so.
 */
export const namesExpected = (sketch: NamesSketch): ReadonlyArray<Seen> => {
	const { names } = sketch
	const refused = (
		name: HeaderName,
		code: string,
		tokens: ReadonlyArray<string>
	): ReadonlyArray<Seen> => (isToken(name) ? [] : [seenAt(code, "refusal", "element", tokens)])
	return [
		...refused(names.operationParameter, "PRM-20/invalid-header-name", [
			"paths",
			"/a",
			"get",
			"parameters",
			"0",
			"name"
		]),
		...refused(names.pathItemParameter, "PRM-20/invalid-header-name", [
			"paths",
			"/a",
			"parameters",
			"0",
			"name"
		]),
		...refused(names.componentParameter, "PRM-20/invalid-header-name", [
			"components",
			"parameters",
			"H",
			"name"
		]),
		...refused(names.responseHeader, "RSP-09/invalid-header-name", [
			"paths",
			"/a",
			"get",
			"responses",
			"200",
			"headers",
			names.responseHeader
		]),
		...refused(names.componentResponseHeader, "RSP-09/invalid-header-name", [
			"components",
			"responses",
			"R",
			"headers",
			names.componentResponseHeader
		]),
		...refused(names.encodingHeader, "HDR-01/invalid-header-name", [
			"paths",
			"/a",
			"post",
			"requestBody",
			"content",
			"multipart/form-data",
			"encoding",
			"file",
			"headers",
			names.encodingHeader
		])
	]
}

export const namesActual = (sketch: NamesSketch) => grammarOf(sketch.line, namesDocument(sketch))

export const namesFeatures = (sketch: NamesSketch): ReadonlyArray<NamesFeature> => [
	...Arr.flatMap(nameSites, (site): ReadonlyArray<NamesFeature> =>
		isToken(sketch.names[site]) ? [] : [`a name that is no token, at ${site}`]
	),
	...(Arr.some(nameSites, (site) => isToken(sketch.names[site])) ? (["a token"] as const) : [])
]

/** A member of a composition: a reference to a component schema, or a schema written in place; requiring `kind` or not. */
type Member = Readonly<{ form: "reference" | "inline"; requires: boolean }>

/** A composition keyword whose members are the schema's own. */
const keywords = ["allOf", "oneOf", "anyOf"] as const

type Keyword = (typeof keywords)[number]

/**
 * What the discriminating schema composes: nothing, its own members under a keyword, or, as a component, the base
 * an allOf child references (DSC-11).
 */
type Composition =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "members"; keyword: Keyword; members: Arr.NonEmptyReadonlyArray<Member> }>
	| Readonly<{ kind: "allOfBase" }>

/** A mapping value: a component name, a reference to the component, a name no schema has, a URI outside the set. */
const targets = ["name", "reference", "unknown", "remote"] as const

type Target = (typeof targets)[number]

/**
 * A schema with a discriminator on `kind`: where it sits (a component, or a request body's schema), what it composes,
 * whether it requires `kind` itself, its mapping's targets and its defaultMapping.
 */
export type DiscriminatorSketch = Readonly<{
	line: SpecLine
	site: "component" | "requestBody"
	composition: Composition
	own: boolean
	mapping: ReadonlyArray<Target>
	defaultMapping: Option.Option<"name" | "unknown">
}>

/** What a case reaches. */
export type DiscriminatorFeature =
	| "no composition"
	| "an allOf base"
	| `members under ${Keyword}`
	| "an inline member"
	| "required by the schema itself"
	| `required through its ${Keyword} members, sparing a refusal`
	| "not required"
	| "not required, with a defaultMapping in 3.2"
	| "a mapping target that resolves"
	| "a mapping target that does not resolve"
	| "a defaultMapping that does not resolve"
	| "a defaultMapping before 3.2"
	| "in a request body"

const member: Gen<Member> = (source) => ({
	form: element(["reference", "inline"])(source),
	requires: boolean(source)
})

const composition = (site: DiscriminatorSketch["site"]): Gen<Composition> =>
	oneOf([
		constant<Composition>({ kind: "none" }),
		(source): Composition => ({
			kind: "members",
			keyword: element(keywords)(source),
			members: [member(source), ...array(member, { min: 0, max: 1 })(source)]
		}),
		...(site === "component" ? [constant<Composition>({ kind: "allOfBase" })] : [])
	])

export const discriminatorSpace: Gen<DiscriminatorSketch> = (source) => {
	const site = element(["component", "requestBody"])(source)
	return {
		line: lineGen(source),
		site,
		composition: composition(site)(source),
		own: boolean(source),
		mapping: subset(targets, { min: 0, max: 2 })(source),
		defaultMapping: option(element(["name", "unknown"]))(source)
	}
}

const kindProperty: Json = { kind: { type: "string" } }

const memberOf = (each: Member): Json =>
	each.form === "reference"
		? { $ref: each.requires ? "#/components/schemas/Req" : "#/components/schemas/Opt" }
		: { properties: kindProperty, type: "object", ...when(each.requires, { required: ["kind"] }) }

const targetValue: Readonly<Record<Target, string>> = {
	name: "Cat",
	reference: "#/components/schemas/Cat",
	unknown: "Dog",
	remote: "https://example.com/other.json#/Dog"
}

const discriminatingSchema = (sketch: DiscriminatorSketch): Json => ({
	discriminator: {
		propertyName: "kind",
		...(Arr.isReadonlyArrayNonEmpty(sketch.mapping)
			? { mapping: Rec.fromEntries(Arr.map(sketch.mapping, (each) => [each, targetValue[each]])) }
			: {}),
		...optionally("defaultMapping", sketch.defaultMapping, (each) => targetValue[each])
	},
	properties: kindProperty,
	...when(sketch.own, { required: ["kind"] }),
	...(sketch.composition.kind === "members"
		? { [sketch.composition.keyword]: Arr.map(sketch.composition.members, memberOf) }
		: {})
})

const discriminatorDocument = (sketch: DiscriminatorSketch): Members => ({
	components: {
		schemas: {
			Cat: { properties: kindProperty, required: ["kind"], type: "object" },
			Opt: { properties: kindProperty, type: "object" },
			Req: { properties: kindProperty, required: ["kind"], type: "object" },
			...when(sketch.site === "component", { Pet: discriminatingSchema(sketch) }),
			...when(sketch.composition.kind === "allOfBase", {
				Child: { allOf: [{ $ref: "#/components/schemas/Pet" }, { type: "object" }] }
			})
		}
	},
	paths: {
		"/a": {
			post: {
				...when(sketch.site === "requestBody", {
					requestBody: { content: { "application/json": { schema: discriminatingSchema(sketch) } } }
				}),
				responses
			}
		}
	}
})

/** Whether the schema requires `kind`: itself, through any allOf member, or through every oneOf or anyOf member. */
const discriminatorRequired = (sketch: DiscriminatorSketch): boolean => {
	if (sketch.own) {
		return true
	}
	switch (sketch.composition.kind) {
		case "none":
		case "allOfBase":
			return false
		case "members":
			return sketch.composition.keyword === "allOf"
				? Arr.some(sketch.composition.members, (each) => each.requires)
				: Arr.every(sketch.composition.members, (each) => each.requires)
	}
}

const resolvingTarget = (target: Target): boolean => target === "name" || target === "reference"

const discriminatingAt = (sketch: DiscriminatorSketch): ReadonlyArray<string> =>
	sketch.site === "component"
		? ["components", "schemas", "Pet", "discriminator"]
		: [
				"paths",
				"/a",
				"post",
				"requestBody",
				"content",
				"application/json",
				"schema",
				"discriminator"
			]

/**
 * The discriminator's findings, each an element refusal: one beside no oneOf, anyOf or allOf, and on no allOf base,
 * is refused alone (DSC-05); otherwise a discriminating property no schema requires is refused at the propertyName in
 * 3.0 and 3.1 (DSC-09), and in 3.2 at the discriminator unless a defaultMapping stands in (DSC-10); each mapping
 * value that names no schema of the set is refused at its key (DSC-03), and in 3.2 so is such a defaultMapping
 * (DSC-04).
 */
export const discriminatorExpected = (sketch: DiscriminatorSketch): ReadonlyArray<Seen> => {
	const at = discriminatingAt(sketch)
	const refused = (code: string, tokens: ReadonlyArray<string>) =>
		seenAt(code, "refusal", "element", tokens)
	if (sketch.composition.kind === "none") {
		return [refused("DSC-05/no-composition", at)]
	}
	const required = discriminatorRequired(sketch)
	return [
		...(!required && sketch.line !== "3.2"
			? [refused("DSC-09/property-not-required", [...at, "propertyName"])]
			: []),
		...(!required && sketch.line === "3.2" && Option.isNone(sketch.defaultMapping)
			? [refused("DSC-10/missing-default-mapping", at)]
			: []),
		...Arr.flatMap(sketch.mapping, (each) =>
			resolvingTarget(each) ? [] : [refused("DSC-03/unresolved-target", [...at, "mapping", each])]
		),
		...(sketch.line === "3.2" && Option.contains(sketch.defaultMapping, "unknown")
			? [refused("DSC-04/unresolved-target", [...at, "defaultMapping"])]
			: [])
	]
}

export const discriminatorActual = (sketch: DiscriminatorSketch) =>
	grammarOf(sketch.line, discriminatorDocument(sketch))

export const discriminatorFeatures = (
	sketch: DiscriminatorSketch
): ReadonlyArray<DiscriminatorFeature> => {
	const { composition: composed } = sketch
	const composes = composed.kind !== "none"
	const required = discriminatorRequired(sketch)
	return [
		...(composed.kind === "none" ? (["no composition"] as const) : []),
		...(composed.kind === "allOfBase" ? (["an allOf base"] as const) : []),
		...(composed.kind === "members"
			? [
					`members under ${composed.keyword}` as const,
					...(Arr.some(composed.members, (each) => each.form === "inline")
						? (["an inline member"] as const)
						: [])
				]
			: []),
		...(composes && sketch.own ? (["required by the schema itself"] as const) : []),
		...(composed.kind === "members" &&
		required &&
		!sketch.own &&
		(sketch.line !== "3.2" || Option.isNone(sketch.defaultMapping))
			? [`required through its ${composed.keyword} members, sparing a refusal` as const]
			: []),
		...(composes && !required ? (["not required"] as const) : []),
		...(composes && !required && sketch.line === "3.2" && Option.isSome(sketch.defaultMapping)
			? (["not required, with a defaultMapping in 3.2"] as const)
			: []),
		...(composes && Arr.some(sketch.mapping, resolvingTarget)
			? (["a mapping target that resolves"] as const)
			: []),
		...(composes && Arr.some(sketch.mapping, (each) => !resolvingTarget(each))
			? (["a mapping target that does not resolve"] as const)
			: []),
		...(composes && sketch.line === "3.2" && Option.contains(sketch.defaultMapping, "unknown")
			? (["a defaultMapping that does not resolve"] as const)
			: []),
		...(composes && sketch.line !== "3.2" && Option.isSome(sketch.defaultMapping)
			? (["a defaultMapping before 3.2"] as const)
			: []),
		...(sketch.site === "requestBody" ? (["in a request body"] as const) : [])
	]
}

/** A schema of a graph: whether it requires `kind` itself, the schemas its allOf lists, and those its alternatives list. */
type GraphNode = Readonly<{
	required: boolean
	allOf: ReadonlyArray<number>
	alternatives: Readonly<{ keyword: "oneOf" | "anyOf"; members: ReadonlyArray<number> }>
}>

/** Component schemas S0 to Sn, each with a discriminator on `kind`, referencing one another, cycles among them. */
export type GraphSketch = Readonly<{ line: SpecLine; nodes: Arr.NonEmptyReadonlyArray<GraphNode> }>

/** What a case reaches. */
export type GraphFeature =
	| "a cycle"
	| "a requirement reached around a cycle, met first while its schema is walked"
	| "required through allOf"
	| "required through every alternative"
	| "not required"
	| "an alternative not required"
	| "a schema that composes nothing"
	| "an allOf base composing nothing"

/**
 * How many schemas a graph holds: enough for a cycle through three of them beside a schema outside it, which the
 * search's every case can still walk by hand.
 */
const nodeCount = 4

const nodeIndex: Gen<number> = int(0, nodeCount - 1)

const graphNode: Gen<GraphNode> = (source) => ({
	required: boolean(source),
	allOf: array(nodeIndex, { min: 0, max: 2 })(source),
	alternatives: {
		keyword: element(["oneOf", "anyOf"])(source),
		members: array(nodeIndex, { min: 0, max: 2 })(source)
	}
})

const anyGraph: Gen<GraphSketch> = (source) => ({
	line: lineGen(source),
	nodes: Arr.makeBy(nodeCount, () => graphNode(source))
})

/**
 * A graph whose S0 requires `kind` through S2 but meets S1 first, and S1 requires it only through S0: S1's answer met
 * inside S0's walk is no for now, which S1's own check, after S0's, must not read as settled.
 */
const aroundACycleGraph: Gen<GraphSketch> = (source) => ({
	line: lineGen(source),
	nodes: [
		{ required: false, allOf: [1, 2], alternatives: { keyword: "oneOf", members: [] } },
		{ required: false, allOf: [0], alternatives: { keyword: "anyOf", members: [] } },
		{ ...graphNode(source), required: true },
		graphNode(source)
	]
})

export const graphSpace = aimed(anyGraph, [
	["a requirement reached around a cycle, met first while its schema is walked", aroundACycleGraph]
])

const nodeName = (index: number): string => `S${String(index)}`

const referenceTo = (index: number): Json => ({ $ref: `#/components/schemas/${nodeName(index)}` })

const graphDocument = (sketch: GraphSketch): Members => ({
	components: {
		schemas: Rec.fromEntries(
			Arr.map(sketch.nodes, (node, index) => [
				nodeName(index),
				{
					discriminator: { propertyName: "kind" },
					...when(node.required, { required: ["kind"] }),
					...when(Arr.isReadonlyArrayNonEmpty(node.allOf), {
						allOf: Arr.map(node.allOf, referenceTo)
					}),
					...when(Arr.isReadonlyArrayNonEmpty(node.alternatives.members), {
						[node.alternatives.keyword]: Arr.map(node.alternatives.members, referenceTo)
					})
				}
			])
		)
	},
	paths: {}
})

/**
 * Which schemas require `kind`, the schemas `withheld` counted as requiring nothing: the least fixed point of "it
 * lists `kind` in required, or an allOf member requires it, or it has alternatives and every one requires it",
 * reached by iterating from none, so a cycle proves nothing by itself and a requirement reached around one still
 * counts.
 */
const requiredWithout = (
	nodes: ReadonlyArray<GraphNode>,
	withheld: ReadonlyArray<number>
): ReadonlyArray<boolean> => {
	const step = (known: ReadonlyArray<boolean>): ReadonlyArray<boolean> =>
		Arr.map(
			nodes,
			(node, at) =>
				!Arr.contains(withheld, at) &&
				(node.required ||
					Arr.some(node.allOf, (index) => Arr.getUnsafe(known, index)) ||
					(Arr.isReadonlyArrayNonEmpty(node.alternatives.members) &&
						Arr.every(node.alternatives.members, (index) => Arr.getUnsafe(known, index))))
		)
	const fixed = (known: ReadonlyArray<boolean>): ReadonlyArray<boolean> => {
		const next = step(known)
		return Arr.makeEquivalence((left: boolean, right: boolean) => left === right)(next, known)
			? known
			: fixed(next)
	}
	return fixed(Arr.map(nodes, () => false))
}

const requiredSchemas = (nodes: ReadonlyArray<GraphNode>): ReadonlyArray<boolean> =>
	requiredWithout(nodes, [])

/**
 * Whether S0, the first schema checked, requires `kind` through a later member while its walk meets first a schema
 * that requires it only through S0 itself: that schema's answer, met while S0 is still being walked, is no only for
 * now, and the schema's own check must not read it.
 */
const aroundACycle = (nodes: Arr.NonEmptyReadonlyArray<GraphNode>): boolean => {
	const first = Arr.headNonEmpty(nodes)
	const required = requiredSchemas(nodes)
	const withoutFirst = requiredWithout(nodes, [0])
	return (
		!first.required &&
		Arr.getUnsafe(required, 0) &&
		Option.exists(
			Arr.head(first.allOf),
			(met) => met !== 0 && Arr.getUnsafe(required, met) && !Arr.getUnsafe(withoutFirst, met)
		)
	)
}

const composesAny = (node: GraphNode): boolean =>
	Arr.isReadonlyArrayNonEmpty(node.allOf) || Arr.isReadonlyArrayNonEmpty(node.alternatives.members)

const allOfReferenced = (nodes: ReadonlyArray<GraphNode>, index: number): boolean =>
	Arr.some(nodes, (node) => Arr.contains(node.allOf, index))

/**
 * Each schema's discriminator is refused beside no composition unless an allOf references it (DSC-05), and
 * otherwise when the schema does not require `kind`: at its propertyName in 3.0 and 3.1 (DSC-09), at the
 * discriminator in 3.2 (DSC-10).
 */
export const graphExpected = (sketch: GraphSketch): ReadonlyArray<Seen> => {
	const required = requiredSchemas(sketch.nodes)
	return Arr.flatMap(sketch.nodes, (node, index): ReadonlyArray<Seen> => {
		const at = ["components", "schemas", nodeName(index), "discriminator"]
		if (!composesAny(node) && !allOfReferenced(sketch.nodes, index)) {
			return [seenAt("DSC-05/no-composition", "refusal", "element", at)]
		}
		if (Arr.getUnsafe(required, index)) {
			return []
		}
		return sketch.line === "3.2"
			? [seenAt("DSC-10/missing-default-mapping", "refusal", "element", at)]
			: [seenAt("DSC-09/property-not-required", "refusal", "element", [...at, "propertyName"])]
	})
}

export const graphActual = (sketch: GraphSketch) => grammarOf(sketch.line, graphDocument(sketch))

/** Whether a schema reaches itself through the members its compositions list. */
const onACycle = (nodes: ReadonlyArray<GraphNode>, start: number): boolean => {
	const next = (index: number): ReadonlyArray<number> => {
		const node = Arr.getUnsafe(nodes, index)
		return [...node.allOf, ...node.alternatives.members]
	}
	const reach = (frontier: ReadonlyArray<number>, seen: ReadonlyArray<number>): boolean =>
		Arr.contains(frontier, start) ||
		(Arr.isReadonlyArrayNonEmpty(frontier) &&
			reach(
				Arr.dedupe(Arr.filter(Arr.flatMap(frontier, next), (index) => !Arr.contains(seen, index))),
				[...seen, ...frontier]
			))
	return reach(next(start), [])
}

export const graphFeatures = (sketch: GraphSketch): ReadonlyArray<GraphFeature> => {
	const required = requiredSchemas(sketch.nodes)
	const checked = Arr.filter(
		Arr.map(sketch.nodes, (node, index) => ({ node, index })),
		({ node, index }) => composesAny(node) || allOfReferenced(sketch.nodes, index)
	)
	return [
		...(aroundACycle(sketch.nodes)
			? (["a requirement reached around a cycle, met first while its schema is walked"] as const)
			: []),
		...(Arr.some(sketch.nodes, (_, index) => onACycle(sketch.nodes, index))
			? (["a cycle"] as const)
			: []),
		...(Arr.some(
			checked,
			({ node }) =>
				!node.required && Arr.some(node.allOf, (index) => Arr.getUnsafe(required, index))
		)
			? (["required through allOf"] as const)
			: []),
		...(Arr.some(
			checked,
			({ node }) =>
				!node.required &&
				Arr.isReadonlyArrayNonEmpty(node.alternatives.members) &&
				Arr.every(node.alternatives.members, (index) => Arr.getUnsafe(required, index))
		)
			? (["required through every alternative"] as const)
			: []),
		...(Arr.some(checked, ({ index }) => !Arr.getUnsafe(required, index))
			? (["not required"] as const)
			: []),
		...(Arr.some(
			checked,
			({ node }) =>
				Arr.some(node.alternatives.members, (index) => Arr.getUnsafe(required, index)) &&
				Arr.some(node.alternatives.members, (index) => !Arr.getUnsafe(required, index))
		)
			? (["an alternative not required"] as const)
			: []),
		...(Arr.some(
			sketch.nodes,
			(node, index) => !composesAny(node) && !allOfReferenced(sketch.nodes, index)
		)
			? (["a schema that composes nothing"] as const)
			: []),
		...(Arr.some(
			sketch.nodes,
			(node, index) => !composesAny(node) && allOfReferenced(sketch.nodes, index)
		)
			? (["an allOf base composing nothing"] as const)
			: [])
	]
}

/**
 * Component schemas S0 to S`depth`: each level but the last a discriminator whose keyword lists the next level twice,
 * so the paths from S0 double at each level; the last requires `kind` or not.
 */
export type DiamondSketch = Readonly<{
	line: SpecLine
	depth: number
	keyword: Keyword
	leafRequires: boolean
}>

/** The deepest diamond the box holds: 2^64 paths from its top, which no walk that repeats a schema finishes. */
const deepest = 64

export const diamondSpace = finite<DiamondSketch>((source) => ({
	line: element(["3.0", "3.1", "3.2"])(source),
	depth: int(1, deepest)(source),
	keyword: element(keywords)(source),
	leafRequires: boolean(source)
}))

const diamondDocument = (sketch: DiamondSketch): Members => ({
	components: {
		schemas: Rec.fromEntries(
			Array.from({ length: sketch.depth + 1 }, (_, level): readonly [string, Json] => [
				nodeName(level),
				level === sketch.depth
					? { type: "object", ...when(sketch.leafRequires, { required: ["kind"] }) }
					: {
							[sketch.keyword]: [referenceTo(level + 1), referenceTo(level + 1)],
							discriminator: { propertyName: "kind" }
						}
			])
		)
	},
	paths: {}
})

/** Every level above the leaf requires `kind` exactly when the leaf does, since every path from it ends there. */
export const diamondExpected = (sketch: DiamondSketch): ReadonlyArray<Seen> =>
	sketch.leafRequires
		? []
		: Array.from({ length: sketch.depth }, (_, level) => {
				const at = ["components", "schemas", nodeName(level), "discriminator"]
				return sketch.line === "3.2"
					? seenAt("DSC-10/missing-default-mapping", "refusal", "element", at)
					: seenAt("DSC-09/property-not-required", "refusal", "element", [...at, "propertyName"])
			})

export const diamondActual = (sketch: DiamondSketch) =>
	grammarOf(sketch.line, diamondDocument(sketch))

/**
 * A Responses Object key: a status code, a range, default, an extension, or a key that is none of them (a code
 * outside 100 to 599, a range outside 1XX to 5XX, a word).
 */
const statusKeys = [
	"200",
	"404",
	"2XX",
	"5XX",
	"default",
	"x-note",
	"099",
	"600",
	"6XX",
	"ok"
] as const

type StatusKey = (typeof statusKeys)[number]

const isStatus = (key: StatusKey): boolean =>
	key === "200" || key === "404" || key === "2XX" || key === "5XX" || key === "default"

/** An operation's Responses Object, by its keys. */
export type ResponsesSketch = Readonly<{
	line: SpecLine
	keys: Arr.NonEmptyReadonlyArray<StatusKey>
}>

/** What a case reaches. */
export type ResponsesFeature =
	| "a key that is no status"
	| "a status"
	| "extensions alone, in 3.0"
	| "extensions alone, after 3.0"
	| "an extension beside a status"

export const responsesSpace: Gen<ResponsesSketch> = (source) => {
	const first = element(statusKeys)(source)
	return {
		line: lineGen(source),
		keys: [
			first,
			...subset(
				Arr.filter(statusKeys, (key) => key !== first),
				{ min: 0, max: 2 }
			)(source)
		]
	}
}

const responsesDocument = (sketch: ResponsesSketch): Members => ({
	paths: {
		"/a": {
			get: {
				responses: Rec.fromEntries(
					Arr.map(sketch.keys, (key): readonly [string, Json] => [
						key,
						key === "x-note" ? "an extension" : { description: "x" }
					])
				)
			}
		}
	}
})

const extensionsAlone = (sketch: ResponsesSketch): boolean =>
	Arr.every(sketch.keys, (key) => key === "x-note")

/**
 * A Responses Object key that is neither a status code from 100 to 599, a range from 1XX to 5XX, default nor an
 * extension is refused at the key, as an element (RSS-10); in 3.0, whose schema counts an extension toward the one
 * member it requires, a Responses Object of extensions alone is refused at itself, for the document (RSS-04).
 */
export const responsesExpected = (sketch: ResponsesSketch): ReadonlyArray<Seen> => {
	const at = ["paths", "/a", "get", "responses"]
	return [
		...(sketch.line === "3.0" && extensionsAlone(sketch)
			? [seenAt("RSS-04/no-response-code", "refusal", "document", at)]
			: []),
		...Arr.flatMap(sketch.keys, (key) =>
			key === "x-note" || isStatus(key)
				? []
				: [seenAt("RSS-10/invalid-status", "refusal", "element", [...at, key])]
		)
	]
}

export const responsesActual = (sketch: ResponsesSketch) =>
	grammarOf(sketch.line, responsesDocument(sketch))

export const responsesFeatures = (sketch: ResponsesSketch): ReadonlyArray<ResponsesFeature> => [
	...(Arr.some(sketch.keys, (key) => key !== "x-note" && !isStatus(key))
		? (["a key that is no status"] as const)
		: []),
	...(Arr.some(sketch.keys, isStatus) ? (["a status"] as const) : []),
	...(extensionsAlone(sketch)
		? sketch.line === "3.0"
			? (["extensions alone, in 3.0"] as const)
			: (["extensions alone, after 3.0"] as const)
		: []),
	...(Arr.contains(sketch.keys, "x-note") && Arr.some(sketch.keys, isStatus)
		? (["an extension beside a status"] as const)
		: [])
]

/** A Header Object's field the 3.0 text gives a parameter alone. */
const parameterOnly = ["allowEmptyValue", "allowReserved"] as const

type ParameterOnly = (typeof parameterOnly)[number]

/**
 * Every place a document writes a Header Object: a response's header, a component header, a multipart encoding's
 * header and a component response's; and a parameter, whose fields they are.
 */
const fieldSites = [
	"responseHeader",
	"componentHeader",
	"encodingHeader",
	"componentResponseHeader",
	"parameter"
] as const

type FieldSite = (typeof fieldSites)[number]

/** The parameter-only fields each place writes, each true or false. */
export type FieldsSketch = Readonly<{
	line: SpecLine
	fields: Readonly<Record<FieldSite, ReadonlyArray<readonly [ParameterOnly, boolean]>>>
}>

/** What a case reaches. */
export type FieldsFeature =
	| `a parameter-only field at ${FieldSite}`
	| "a parameter-only field after 3.0"

const fieldsGen: Gen<ReadonlyArray<readonly [ParameterOnly, boolean]>> = (source) =>
	Arr.map(subset(parameterOnly, { min: 0, max: 2 })(source), (field) => [field, boolean(source)])

export const fieldsSpace: Gen<FieldsSketch> = (source) => ({
	line: lineGen(source),
	fields: {
		responseHeader: fieldsGen(source),
		componentHeader: fieldsGen(source),
		encodingHeader: fieldsGen(source),
		componentResponseHeader: fieldsGen(source),
		parameter: fieldsGen(source)
	}
})

const fieldsDocument = (sketch: FieldsSketch): Members => {
	const header = (site: FieldSite): Members => ({
		schema: {},
		...Rec.fromEntries(sketch.fields[site])
	})
	return {
		components: {
			headers: { Rate: header("componentHeader") },
			responses: {
				R: { description: "ok", headers: { "X-Rate": header("componentResponseHeader") } }
			}
		},
		paths: {
			"/a": {
				get: {
					parameters: [{ in: "query", name: "q", ...header("parameter") }],
					responses: {
						"200": { description: "ok", headers: { "X-Rate": header("responseHeader") } }
					}
				},
				post: {
					requestBody: {
						content: {
							"multipart/form-data": {
								encoding: { file: { headers: { "X-Part": header("encodingHeader") } } },
								schema: {}
							}
						}
					},
					responses
				}
			}
		}
	}
}

const headerAt: Readonly<Record<Exclude<FieldSite, "parameter">, ReadonlyArray<string>>> = {
	responseHeader: ["paths", "/a", "get", "responses", "200", "headers", "X-Rate"],
	componentHeader: ["components", "headers", "Rate"],
	encodingHeader: [
		"paths",
		"/a",
		"post",
		"requestBody",
		"content",
		"multipart/form-data",
		"encoding",
		"file",
		"headers",
		"X-Part"
	],
	componentResponseHeader: ["components", "responses", "R", "headers", "X-Rate"]
}

const headerSites: ReadonlyArray<Exclude<FieldSite, "parameter">> = [
	"responseHeader",
	"componentHeader",
	"encodingHeader",
	"componentResponseHeader"
]

/**
 * In 3.0, whose schema permits them, a Header Object's allowEmptyValue or allowReserved, written at all, is refused
 * at the field, for the document (HDR-13); a parameter keeps both, and the 3.1 and 3.2 schemas own the rule.
 */
export const fieldsExpected = (sketch: FieldsSketch): ReadonlyArray<Seen> =>
	sketch.line === "3.0"
		? Arr.flatMap(headerSites, (site) =>
				Arr.map(sketch.fields[site], ([field]) =>
					seenAt("HDR-13/parameter-only-field", "refusal", "document", [...headerAt[site], field])
				)
			)
		: []

export const fieldsActual = (sketch: FieldsSketch) => grammarOf(sketch.line, fieldsDocument(sketch))

export const fieldsFeatures = (sketch: FieldsSketch): ReadonlyArray<FieldsFeature> => [
	...Arr.flatMap(fieldSites, (site): ReadonlyArray<FieldsFeature> =>
		sketch.line === "3.0" && Arr.isReadonlyArrayNonEmpty(sketch.fields[site])
			? [`a parameter-only field at ${site}`]
			: []
	),
	...(sketch.line !== "3.0" &&
	Arr.some(headerSites, (site) => Arr.isReadonlyArrayNonEmpty(sketch.fields[site]))
		? (["a parameter-only field after 3.0"] as const)
		: [])
]

/** A schema's pattern: none, one that compiles in Unicode mode, or one that does not (`\-` outside a class). */
type Pattern = "none" | "compiles" | "fails"

/**
 * A Schema Object: its pattern, its type, whether it writes items, its readOnly and writeOnly marks (each written as
 * true or not written), and whether it is written as a Reference Object, its other members beside the `$ref`.
 */
type SchemaNode = Readonly<{
	pattern: Pattern
	type: "none" | "string" | "array"
	items: boolean
	readOnly: boolean
	writeOnly: boolean
	reference: boolean
}>

/** A keyword of a schema that holds schemas, as the 3.0 schema object has it, and the tokens of the one it holds. */
const placements = ["properties", "items", "allOf", "oneOf", "additionalProperties", "not"] as const

type Placement = (typeof placements)[number]

/** A component schema, a schema inside it, and a request body's schema. */
export type SchemasSketch = Readonly<{
	line: SpecLine
	top: SchemaNode
	child: Option.Option<readonly [Placement, SchemaNode]>
	media: SchemaNode
}>

/** What a case reaches. */
export type SchemasFeature =
	| "a pattern that fails in Unicode mode, in 3.0"
	| "a pattern that fails in Unicode mode, after 3.0"
	| "a pattern that compiles"
	| "an array without items, in 3.0"
	| "an array whose items is the nested schema"
	| "an array without items, after 3.0"
	| "readOnly and writeOnly, in 3.0"
	| "readOnly and writeOnly, after 3.0"
	| "a reference beside findings, in 3.0"
	| "a reference beside findings, after 3.0"
	| `a schema under ${Placement}`

const schemaNode: Gen<SchemaNode> = (source) => ({
	pattern: element(["none", "compiles", "fails"])(source),
	type: element(["none", "string", "array"])(source),
	items: boolean(source),
	readOnly: boolean(source),
	writeOnly: boolean(source),
	reference: boolean(source)
})

export const schemasSpace: Gen<SchemasSketch> = (source) => ({
	line: lineGen(source),
	top: schemaNode(source),
	child: option((inner): readonly [Placement, SchemaNode] => [
		element(placements)(inner),
		schemaNode(inner)
	])(source),
	media: schemaNode(source)
})

const patternText: Readonly<Record<Exclude<Pattern, "none">, string>> = {
	compiles: "^[a-z]+$",
	fails: "^\\d+\\-$"
}

/** The tokens, under its parent, of the schema a placement holds; a property is named `pattern`, a schema's keyword. */
const placedAt: Readonly<Record<Placement, ReadonlyArray<string>>> = {
	properties: ["properties", "pattern"],
	items: ["items"],
	allOf: ["allOf", "0"],
	oneOf: ["oneOf", "0"],
	additionalProperties: ["additionalProperties"],
	not: ["not"]
}

const placed = (placement: Placement, schema: Json): Members => {
	switch (placement) {
		case "properties":
			return { properties: { pattern: schema } }
		case "allOf":
		case "oneOf":
			return { [placement]: [schema] }
		case "items":
		case "additionalProperties":
		case "not":
			return { [placement]: schema }
	}
}

const schemaOf = (node: SchemaNode, inner: Members): Json => ({
	...when(node.reference, { $ref: "#/components/schemas/Clean" }),
	...(node.pattern === "none" ? {} : { pattern: patternText[node.pattern] }),
	...(node.type === "none" ? {} : { type: node.type }),
	...when(node.items, { items: {} }),
	...when(node.readOnly, { readOnly: true }),
	...when(node.writeOnly, { writeOnly: true }),
	...inner
})

const schemasDocument = (sketch: SchemasSketch): Members => ({
	components: {
		schemas: {
			A: schemaOf(
				sketch.top,
				Option.match(sketch.child, {
					onNone: () => ({}),
					onSome: ([placement, node]) => placed(placement, schemaOf(node, {}))
				})
			),
			Clean: { type: "object" }
		}
	},
	paths: {
		"/a": {
			post: {
				requestBody: { content: { "application/json": { schema: schemaOf(sketch.media, {}) } } },
				responses
			}
		}
	}
})

/**
 * One schema's own findings: a pattern that does not compile in Unicode mode is a notice at the pattern, under
 * S30-09 in 3.0 and SCH-37 after; in 3.0 alone, an array without items is refused at its items (S30-22), and
 * readOnly beside writeOnly at the schema (S30-30). A 3.0 Reference Object ignores its siblings (design 3.3), so
 * none of its members is read, and nothing inside it.
 */
const ownSchemaFindings = (
	line: SpecLine,
	node: SchemaNode,
	hasItems: boolean,
	at: ReadonlyArray<string>
): ReadonlyArray<Seen> => [
	...(node.pattern === "fails"
		? [
				seenAt(
					line === "3.0" ? "S30-09/not-unicode-compilable" : "SCH-37/not-unicode-compilable",
					"notice",
					"element",
					[...at, "pattern"]
				)
			]
		: []),
	...(line === "3.0" && node.type === "array" && !hasItems
		? [seenAt("S30-22/array-without-items", "refusal", "element", [...at, "items"])]
		: []),
	...(line === "3.0" && node.readOnly && node.writeOnly
		? [seenAt("S30-30/read-and-write-only", "refusal", "element", at)]
		: [])
]

const ignored = (line: SpecLine, node: SchemaNode): boolean => line === "3.0" && node.reference

export const schemasExpected = (sketch: SchemasSketch): ReadonlyArray<Seen> => {
	const { line } = sketch
	const top = ["components", "schemas", "A"]
	const childItems = Option.exists(sketch.child, ([placement]) => placement === "items")
	return [
		...(ignored(line, sketch.top)
			? []
			: [
					...ownSchemaFindings(line, sketch.top, sketch.top.items || childItems, top),
					...Option.match(sketch.child, {
						onNone: (): ReadonlyArray<Seen> => [],
						onSome: ([placement, node]) =>
							ignored(line, node)
								? []
								: ownSchemaFindings(line, node, node.items, [...top, ...placedAt[placement]])
					})
				]),
		...(ignored(line, sketch.media)
			? []
			: ownSchemaFindings(line, sketch.media, sketch.media.items, [
					"paths",
					"/a",
					"post",
					"requestBody",
					"content",
					"application/json",
					"schema"
				]))
	]
}

export const schemasActual = (sketch: SchemasSketch) =>
	grammarOf(sketch.line, schemasDocument(sketch))

/** Whether a schema, read where it is, would have a finding of its own. */
const findable = (node: SchemaNode): boolean =>
	node.pattern === "fails" || node.type === "array" || (node.readOnly && node.writeOnly)

export const schemasFeatures = (sketch: SchemasSketch): ReadonlyArray<SchemasFeature> => {
	const { line } = sketch
	const childNodes = Option.toArray(Option.map(sketch.child, ([, node]) => node))
	const read = Arr.filter(
		[...(ignored(line, sketch.top) ? [] : [sketch.top, ...childNodes]), sketch.media],
		(node) => !ignored(line, node)
	)
	const legacy = line === "3.0"
	const topItemsFromChild =
		!ignored(line, sketch.top) &&
		sketch.top.type === "array" &&
		!sketch.top.items &&
		Option.exists(sketch.child, ([placement]) => placement === "items")
	return [
		...(Arr.some(read, (node) => node.pattern === "fails")
			? legacy
				? (["a pattern that fails in Unicode mode, in 3.0"] as const)
				: (["a pattern that fails in Unicode mode, after 3.0"] as const)
			: []),
		...(Arr.some(read, (node) => node.pattern === "compiles")
			? (["a pattern that compiles"] as const)
			: []),
		...(Arr.some(read, (node) => node.type === "array" && !node.items)
			? legacy
				? (["an array without items, in 3.0"] as const)
				: (["an array without items, after 3.0"] as const)
			: []),
		...(topItemsFromChild ? (["an array whose items is the nested schema"] as const) : []),
		...(Arr.some(read, (node) => node.readOnly && node.writeOnly)
			? legacy
				? (["readOnly and writeOnly, in 3.0"] as const)
				: (["readOnly and writeOnly, after 3.0"] as const)
			: []),
		...(Arr.some(
			[sketch.top, ...childNodes, sketch.media],
			(node) => node.reference && findable(node)
		)
			? legacy
				? (["a reference beside findings, in 3.0"] as const)
				: (["a reference beside findings, after 3.0"] as const)
			: []),
		...Option.match(sketch.child, {
			onNone: (): ReadonlyArray<SchemasFeature> => [],
			onSome: ([placement]): ReadonlyArray<SchemasFeature> => [`a schema under ${placement}`]
		})
	]
}

/**
 * The defects a document for the check entry carries: a structure defect (a component key outside the key grammar,
 * a path variable no parameter declares) or a value and grammar defect (a content key that is no media type, a
 * pattern that fails in Unicode mode, a header parameter name that is no token, a server URL with a query).
 */
const defects = [
	"componentKey",
	"pathVariable",
	"contentKey",
	"pattern",
	"headerName",
	"serverQuery"
] as const

type Defect = (typeof defects)[number]

/** A document's defects, by kind. */
export type EntrySketch = Readonly<{ line: SpecLine; defects: ReadonlyArray<Defect> }>

/** What a case reaches. */
export type EntryFeature =
	| `a ${Defect} defect`
	| "a finding inside another's pointer"
	| "a clean document"

export const entrySpace: Gen<EntrySketch> = (source) => ({
	line: lineGen(source),
	defects: subarray(defects)(source)
})

const entryDocument = (sketch: EntrySketch): Members => {
	const has = (defect: Defect) => Arr.contains(sketch.defects, defect)
	const schemaName = has("componentKey") ? "bad key" : "Zip"
	const path = has("pathVariable") ? "/a/{x}" : "/a"
	return {
		components: {
			parameters: {
				P: {
					content: { [has("contentKey") ? "string" : "application/json"]: {} },
					in: "query",
					name: "q"
				}
			},
			schemas: { [schemaName]: { pattern: has("pattern") ? "\\-" : "^[a-z]+$" } }
		},
		paths: {
			[path]: {
				get: {
					parameters: [{ in: "header", name: has("headerName") ? "X Bad" : "X-Good", schema: {} }],
					responses,
					servers: [{ url: has("serverQuery") ? "https://example.com?x=1" : "https://example.com" }]
				}
			}
		}
	}
}

/**
 * The check entry's findings: every structure and every grammar finding, in document order (design 3.7), by pointer
 * token by token and then by code: a component key outside `^[a-zA-Z0-9.\-_]+$` at the key (CMP-13), a path variable
 * no parameter declares at the operation (PTH-03), and the grammar rules' findings at theirs.
 */
export const entryExpected = (sketch: EntrySketch): ReadonlyArray<readonly [string, string]> => {
	const has = (defect: Defect) => Arr.contains(sketch.defects, defect)
	const schema = ["components", "schemas", has("componentKey") ? "bad key" : "Zip"]
	const operation = ["paths", has("pathVariable") ? "/a/{x}" : "/a", "get"]
	const found: ReadonlyArray<readonly [string, string]> = [
		...(has("componentKey") ? [[pointerOf(schema), "CMP-13/invalid-key"] as const] : []),
		...(has("pathVariable") ? [[pointerOf(operation), "PTH-03/missing-parameter"] as const] : []),
		...(has("contentKey")
			? [
					[
						pointerOf(["components", "parameters", "P", "content", "string"]),
						"MED-24/invalid-media-type"
					] as const
				]
			: []),
		...(has("pattern")
			? [
					[
						pointerOf([...schema, "pattern"]),
						sketch.line === "3.0"
							? "S30-09/not-unicode-compilable"
							: "SCH-37/not-unicode-compilable"
					] as const
				]
			: []),
		...(has("headerName")
			? [
					[
						pointerOf([...operation, "parameters", "0", "name"]),
						"PRM-20/invalid-header-name"
					] as const
				]
			: []),
		...(has("serverQuery")
			? [[pointerOf([...operation, "servers", "0", "url"]), "SRV-18/query-or-fragment"] as const]
			: [])
	]
	return Arr.sort(
		found,
		Order.combine(
			Order.mapInput(pointerOrder, ([pointer]: readonly [string, string]) => pointer),
			Order.mapInput(Order.String, ([, code]: readonly [string, string]) => code)
		)
	)
}

export const entryActual = (sketch: EntrySketch) =>
	Effect.map(
		Effect.flatMap(
			resolvedAt(sketch.line, documentAt(sketch.line, entryDocument(sketch)), []),
			checkSpecText
		),
		Arr.map((diagnostic): readonly [string, string] => [
			String(diagnostic.pointer),
			diagnostic.code
		])
	)

export const entryFeatures = (sketch: EntrySketch): ReadonlyArray<EntryFeature> => [
	...Arr.map(sketch.defects, (defect): EntryFeature => `a ${defect} defect`),
	...(Arr.contains(sketch.defects, "componentKey") && Arr.contains(sketch.defects, "pattern")
		? (["a finding inside another's pointer"] as const)
		: []),
	...(Arr.isReadonlyArrayEmpty(sketch.defects) ? (["a clean document"] as const) : [])
]
