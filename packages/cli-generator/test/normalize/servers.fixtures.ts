/** What the property of servers.test.ts reads: its server sketches and the servers and origins design 6.4 states. */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	array,
	boolean,
	constant,
	type Gen,
	oneOf,
	option,
	subarray,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Record as Rec, String as Str } from "effect"
import { boundOrigins, effectiveServers, type ServerSource } from "#normalize/servers.ts"
import {
	authorConfigOf,
	configText,
	configUri,
	entryText,
	entryUri,
	openapiOf
} from "#test/support/normalizing.ts"

/** A host label: plain, or one that carries userinfo or a query once filled in. */
type Label = "api" | "eu" | "us" | "a@evil" | "evil?x"

/** A scheme a template may name. */
type Scheme = "https" | "http" | "ftp"

/** A part of a template: written as it is, or a variable with its members (an enum or none) and its default. */
type Part<A> =
	| Readonly<{ kind: "literal"; value: A }>
	| Readonly<{ kind: "variable"; members: ReadonlyArray<A>; enumerated: boolean; fallback: A }>

/** A path variable's value: plain, or one carrying a query, a fragment or a second authority. */
type PathValue = "v1" | "v2" | "v1?canary-secret=1" | "v2#canary-secret" | "/evil.com"

/** A template's path: none, a literal segment, or a variable segment. */
type PathPart =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "literal" }>
	| Readonly<{ kind: "variable"; members: ReadonlyArray<PathValue>; fallback: PathValue }>

/** How a server URL is written. */
type Form =
	| Readonly<{
			kind: "absolute"
			scheme: Part<Scheme>
			userinfo: boolean
			labels: Arr.NonEmptyReadonlyArray<Part<Label>>
			path: PathPart
			tail: "" | "?key=1" | "#top"
	  }>
	| Readonly<{ kind: "relative"; path: PathPart }>
	| Readonly<{ kind: "schemeless" }>
	| Readonly<{ kind: "invalid" }>
	| Readonly<{ kind: "undeclared" }>

/** A form a server can be built from: every form but an invalid template and one using an undeclared variable. */
type Usable = Exclude<Form, Readonly<{ kind: "invalid" }> | Readonly<{ kind: "undeclared" }>>

/** A Server Object, or an entry that is none; how the author config accepts it, if it does. */
type Entry =
	| Readonly<{ kind: "notObject" }>
	| Readonly<{ kind: "server"; form: Form; named: boolean; accepted: "no" | "url" | "name" }>

/** A level's `servers`: a value that is no list, or a list of entries. */
type Level =
	| Readonly<{ kind: "notList" }>
	| Readonly<{ kind: "list"; entries: ReadonlyArray<Entry> }>

/** An `acceptedOrigins` entry, an origin or not. */
type AcceptedOrigin =
	| "https://a.example.com"
	| "http://a.example.com"
	| "https://u:p@a.example.com"
	| "https://a.example.com/v1"
	| "https://a.example.com?x=1"
	| "https://a.example.com/"
	| "https://zz.example.com"

/** An operation's three server levels and the author config that accepts some of their servers. */
type ServersSketch = Readonly<{
	line: "3.1" | "3.2"
	root: Option.Option<Level>
	pathItem: Option.Option<Level>
	operation: Option.Option<Level>
	acceptImplicit: boolean
	allowInsecure: boolean
	retrievalUri: Option.Option<
		"https://docs.example.com/specs/openapi.json" | "http://docs.example.com/openapi.json"
	>
	acceptedOrigins: ReadonlyArray<AcceptedOrigin>
}>

/** What a case reaches. */
export type ServersFeature =
	| "operation level wins"
	| "path item level wins"
	| "root level"
	| "implicit server"
	| "empty override"
	| "servers not a list"
	| "server not an object"
	| "invalid template"
	| "undeclared variable"
	| "accepted by URL"
	| "accepted by name"
	| "name ignored before 3.2"
	| "server not accepted"
	| "insecure scheme refused"
	| "insecure scheme allowed"
	| "unsupported scheme"
	| "userinfo refused"
	| "query or fragment refused"
	| "relative needs retrievalUri"
	| "relative through retrievalUri"
	| "unsupported relative form"
	| "variable needs an enum"
	| "enumerated host expanded"
	| "two variables expanded"
	| "path variable value refused"
	| "value leaves the authority"
	| "accepted origin refused"
	| "accepted origins bound"

const label: Gen<Label> = oneOf([
	constant<Label>("api"),
	constant<Label>("eu"),
	constant<Label>("us"),
	constant<Label>("a@evil"),
	constant<Label>("evil?x")
])

const plainLabel: Gen<Label> = oneOf([
	constant<Label>("api"),
	constant<Label>("eu"),
	constant<Label>("us")
])

const scheme: Gen<Scheme> = oneOf([
	constant<Scheme>("https"),
	constant<Scheme>("http"),
	constant<Scheme>("ftp")
])

/** A part: a literal, or a variable over some members (an enum, or none) with a default. */
const part = <A>(value: Gen<A>, members: Gen<ReadonlyArray<A>>): Gen<Part<A>> =>
	oneOf([
		(source): Part<A> => ({ kind: "literal", value: value(source) }),
		(source): Part<A> => ({
			kind: "variable",
			members: members(source),
			enumerated: boolean(source) || boolean(source),
			fallback: value(source)
		})
	])

const pathValue = (relative: boolean): Gen<PathValue> =>
	oneOf([
		constant<PathValue>("v1"),
		constant<PathValue>("v2"),
		constant<PathValue>("v1?canary-secret=1"),
		constant<PathValue>("v2#canary-secret"),
		...(relative ? [constant<PathValue>("/evil.com")] : [])
	])

const pathPart = (relative: boolean): Gen<PathPart> =>
	oneOf([
		constant<PathPart>({ kind: "none" }),
		constant<PathPart>({ kind: "literal" }),
		(source): PathPart => ({
			kind: "variable",
			members: uniqueKeys(pathValue(relative), { min: 0, max: 2 })(source),
			fallback: pathValue(relative)(source)
		})
	])

const form: Gen<Form> = oneOf([
	(source): Form => ({
		kind: "absolute",
		scheme: part(
			scheme,
			uniqueKeys(oneOf([constant<Scheme>("https"), constant<Scheme>("http")]), { min: 1, max: 2 })
		)(source),
		userinfo: boolean(source) && boolean(source),
		labels: [
			part(label, uniqueKeys(label, { min: 1, max: 4 }))(source),
			...array(part(plainLabel, uniqueKeys(plainLabel, { min: 1, max: 3 })), { min: 0, max: 1 })(
				source
			)
		],
		path: pathPart(false)(source),
		tail: weighted<"" | "?key=1" | "#top">([
			[2, constant("")],
			[1, constant("?key=1")],
			[1, constant("#top")]
		])(source)
	}),
	(source): Form => ({ kind: "relative", path: pathPart(true)(source) }),
	constant<Form>({ kind: "schemeless" }),
	constant<Form>({ kind: "invalid" }),
	constant<Form>({ kind: "undeclared" })
])

const entry: Gen<Entry> = oneOf([
	constant<Entry>({ kind: "notObject" }),
	(source): Entry => ({
		kind: "server",
		form: form(source),
		named: boolean(source),
		accepted: weighted<"no" | "url" | "name">([
			[1, constant("no")],
			[2, constant("url")],
			[1, constant("name")]
		])(source)
	}),
	(source): Entry => ({
		kind: "server",
		form: form(source),
		named: boolean(source),
		accepted: oneOf([constant<"url">("url"), constant<"name">("name")])(source)
	})
])

const level: Gen<Level> = weighted([
	[1, constant<Level>({ kind: "notList" })],
	[1, (source): Level => ({ kind: "list", entries: array(entry, { min: 0, max: 2 })(source) })],
	[2, (source): Level => ({ kind: "list", entries: array(entry, { min: 1, max: 2 })(source) })]
])

const acceptedOrigin: Gen<AcceptedOrigin> = oneOf([
	constant<AcceptedOrigin>("https://a.example.com"),
	constant<AcceptedOrigin>("http://a.example.com"),
	constant<AcceptedOrigin>("https://u:p@a.example.com"),
	constant<AcceptedOrigin>("https://a.example.com/v1"),
	constant<AcceptedOrigin>("https://a.example.com?x=1"),
	constant<AcceptedOrigin>("https://a.example.com/"),
	constant<AcceptedOrigin>("https://zz.example.com")
])

/** An operation's levels and an author config over them. */
const serversDrawn: Gen<ServersSketch> = (source) => ({
	line: oneOf([constant<"3.1">("3.1"), constant<"3.2">("3.2")])(source),
	root: option(level)(source),
	pathItem: boolean(source) ? option(level)(source) : Option.none(),
	operation: boolean(source) ? option(level)(source) : Option.none(),
	acceptImplicit: boolean(source),
	allowInsecure: boolean(source),
	retrievalUri: option(
		oneOf([
			constant<"https://docs.example.com/specs/openapi.json">(
				"https://docs.example.com/specs/openapi.json"
			),
			constant<"http://docs.example.com/openapi.json">("http://docs.example.com/openapi.json")
		])
	)(source),
	acceptedOrigins: subarray([acceptedOrigin(source), acceptedOrigin(source)])(source)
})

/** A host label that is a variable over `members`, its enum, defaulting to the first. */
const enumeratedLabel = (members: Arr.NonEmptyReadonlyArray<Label>): Part<Label> => ({
	kind: "variable",
	members,
	enumerated: true,
	fallback: Arr.headNonEmpty(members)
})

/** A sketch whose one server, at the root and accepted by its URL, is written in `form`. */
const serverOf =
	(form: Form): Gen<ServersSketch> =>
	(source) => ({
		...serversDrawn(source),
		root: Option.some<Level>({
			kind: "list",
			entries: [{ kind: "server", form, named: false, accepted: "url" }]
		}),
		pathItem: Option.none(),
		operation: Option.none()
	})

/** An https host of these labels, with no path. */
const hostOf = (labels: Arr.NonEmptyReadonlyArray<Part<Label>>): Form => ({
	kind: "absolute",
	scheme: { kind: "literal", value: "https" },
	userinfo: false,
	labels,
	path: { kind: "none" },
	tail: ""
})

/**
 * An operation's levels and an author config over them, aimed at a host variable's enum expanded, at two variables
 * expanded together, and at a relative template's path value that opens a second authority, which plain draws reach
 * rarely.
 */
export const serversSpace = aimed<ServersSketch, ServersFeature>(serversDrawn, [
	["enumerated host expanded", serverOf(hostOf([enumeratedLabel(["api", "eu"])]))],
	[
		"two variables expanded",
		serverOf(hostOf([enumeratedLabel(["api", "eu", "us"]), enumeratedLabel(["eu", "us"])]))
	],
	[
		"value leaves the authority",
		(source) => ({
			...serverOf({
				kind: "relative",
				path: { kind: "variable", members: ["v1", "/evil.com"], fallback: "v1" }
			})(source),
			retrievalUri: Option.some("https://docs.example.com/specs/openapi.json")
		})
	]
])

/** The members a part may take: its enum then its default, each once. */
const domainOf = <A>(value: Part<A>): ReadonlyArray<A> =>
	value.kind === "literal"
		? [value.value]
		: Arr.dedupe([...(value.enumerated ? value.members : []), value.fallback])

/** The text a part writes into its template: its literal, or `{name}`. */
const partText = <A extends string>(value: Part<A>, name: string): string =>
	value.kind === "literal" ? value.value : `{${name}}`

/** A variable's name in a template: the scheme's, then each label's by place, then the path's. */
const labelName = (index: number): string => `h${index}`

const pathText = (path: PathPart, name: string): string => {
	switch (path.kind) {
		case "none":
			return ""
		case "literal":
			return "/v1"
		case "variable":
			return `/{${name}}`
	}
}

/** A Server Variable Object as written. */
type VariableJson = Readonly<{ default: string; enum?: ReadonlyArray<string> }>

const variableOf = <A extends string>(value: Part<A>): Option.Option<VariableJson> =>
	value.kind === "literal"
		? Option.none()
		: Option.some(
				value.enumerated
					? { default: value.fallback, enum: value.members }
					: { default: value.fallback }
			)

const pathVariable = (path: PathPart): Option.Option<VariableJson> =>
	path.kind === "variable"
		? Option.some(
				Arr.isReadonlyArrayNonEmpty(path.members)
					? { default: path.fallback, enum: path.members }
					: { default: path.fallback }
			)
		: Option.none()

/** A form's template and its declared variables. */
const written = (
	value: Form
): readonly [string, ReadonlyArray<readonly [string, VariableJson]>] => {
	switch (value.kind) {
		case "absolute": {
			const host = Arr.join(
				Arr.map(value.labels, (each, index) => partText(each, labelName(index))),
				"."
			)
			const template = `${partText(value.scheme, "scheme")}://${value.userinfo ? "user:canary-secret@" : ""}${host}.example.com${pathText(value.path, "v")}${value.tail}`
			return [
				template,
				[
					...Option.toArray(
						Option.map(variableOf(value.scheme), (variable) => ["scheme", variable] as const)
					),
					...Arr.flatMap(value.labels, (each, index) =>
						Option.toArray(
							Option.map(variableOf(each), (variable) => [labelName(index), variable] as const)
						)
					),
					...Option.toArray(
						Option.map(pathVariable(value.path), (variable) => ["v", variable] as const)
					)
				]
			]
		}
		case "relative":
			return [
				value.path.kind === "none" ? "/" : value.path.kind === "literal" ? "/v1" : "/{x}",
				Option.toArray(Option.map(pathVariable(value.path), (variable) => ["x", variable] as const))
			]
		case "schemeless":
			return ["v1:evil", []]
		case "invalid":
			return ["https://exa mple.com", []]
		case "undeclared":
			return ["https://{host}.example.com", []]
	}
}

/** Where a level's `servers` sits. */
const levelPointer = {
	root: "/servers",
	pathItem: "/paths/~1a/servers",
	operation: "/paths/~1a/get/servers"
} as const

type LevelName = keyof typeof levelPointer

/** The reference tokens of each level's `servers` pointer, as a caller of effectiveServers holds them. */
const levelTokens: Readonly<Record<LevelName, readonly string[]>> = {
	root: ["servers"],
	pathItem: ["paths", "/a", "servers"],
	operation: ["paths", "/a", "get", "servers"]
}

/** The levels in the order they are written: root, path item, operation. */
const levelsOf = (
	sketch: ServersSketch
): ReadonlyArray<readonly [LevelName, Option.Option<Level>]> => [
	["root", sketch.root],
	["pathItem", sketch.pathItem],
	["operation", sketch.operation]
]

/** A server's name, unique in the document by its level and place. */
const nameOf = (at: LevelName, index: number): string => `${at}${index}`

/** The JSON a level writes. */
const levelJson = (at: LevelName, value: Level): Json =>
	value.kind === "notList"
		? "https://example.com"
		: Arr.map(value.entries, (each, index): Json => {
				if (each.kind === "notObject") {
					return "https://example.com"
				}
				const [template, variables] = written(each.form)
				return {
					url: template,
					...(each.named ? { name: nameOf(at, index) } : {}),
					...(Arr.isReadonlyArrayNonEmpty(variables)
						? {
								variables: Rec.fromEntries(
									Arr.map(variables, ([name, variable]): readonly [string, Json] => [
										name,
										variable
									])
								)
							}
						: {})
				}
			})

/** The `servers.accepted` entries of the author config: each accepted server's URL or name, in level and place order. */
const acceptedEntries = (sketch: ServersSketch): ReadonlyArray<string> => [
	...(sketch.acceptImplicit ? ["/"] : []),
	...Arr.flatMap(levelsOf(sketch), ([at, value]) =>
		Option.match(value, {
			onNone: () => [],
			onSome: (declared) =>
				declared.kind === "notList"
					? []
					: Arr.flatMap(declared.entries, (each, index) => {
							if (each.kind === "notObject") {
								return []
							}
							switch (each.accepted) {
								case "no":
									return []
								case "url":
									return [written(each.form)[0]]
								case "name":
									return [nameOf(at, index)]
							}
						})
		})
	)
]

/** The author config's members a sketch writes. */
const configMembers = (sketch: ServersSketch): Readonly<Record<string, Json>> => ({
	...(Arr.isReadonlyArrayNonEmpty(acceptedEntries(sketch))
		? { servers: { accepted: acceptedEntries(sketch) } }
		: {}),
	...(sketch.allowInsecure ? { allowInsecure: true } : {}),
	...Option.match(sketch.retrievalUri, {
		onNone: () => ({}),
		onSome: (uri) => ({ retrievalUri: uri })
	}),
	...(Arr.isReadonlyArrayNonEmpty(sketch.acceptedOrigins)
		? { acceptedOrigins: sketch.acceptedOrigins }
		: {})
})

/** A diagnostic as the model states it. */
type Located = readonly [document: string, code: string, scope: string, pointer: string]

/** A server as the model states it. */
type ModelServer = Readonly<{
	accepted: boolean
	level: LevelName
	name: Option.Option<string>
	pointer: string
	origins: ReadonlyArray<string>
	rows: ReadonlyArray<string>
	template: string
	variables: ReadonlyArray<
		Readonly<{ name: string; default: string; enum: Option.Option<ReadonlyArray<string>> }>
	>
}>

/** The servers an operation uses and the origins the run binds, as the model states them. */
type ServersModel = Readonly<{
	servers: ReadonlyArray<ModelServer>
	diagnostics: ReadonlyArray<Located>
	bound: ReadonlyArray<string>
	boundDiagnostics: ReadonlyArray<Located>
}>

/** The code that refuses a server or an origin. */
type Refused = Readonly<{ kind: "refused"; code: string }>

/** One concrete origin text judged against the baked defaults: its origin, or the code that refuses it. */
type Verdict = Readonly<{ kind: "origin"; origin: string }> | Refused

const hasQueryOrFragment = (text: string): boolean =>
	Str.includes("?")(text) || Str.includes("#")(text)

/** A scheme, a userinfo and a host judged as the baked defaults state (design 6.4). */
const judgeOrigin = (
	schemeText: string,
	userinfo: boolean,
	host: string,
	allowInsecure: boolean
): Verdict => {
	if (hasQueryOrFragment(host)) {
		return { kind: "refused", code: "SRV-18/query-or-fragment" }
	}
	if (schemeText !== "https" && schemeText !== "http") {
		return { kind: "refused", code: "SRV-02/unsupported-scheme" }
	}
	if (schemeText === "http" && !allowInsecure) {
		return { kind: "refused", code: "SRV-02/insecure-scheme" }
	}
	if (userinfo || Str.includes("@")(host)) {
		return { kind: "refused", code: "SRV-02/userinfo" }
	}
	return { kind: "origin", origin: `${schemeText}://${host}` }
}

/** The one assignment of no variables. */
const emptyAssignment: ReadonlyArray<ReadonlyArray<string>> = [[]]

/** Every assignment of a span's variables, the first variable varying slowest. */
const assignmentsOf = (
	schemes: ReadonlyArray<string>,
	labels: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<readonly [string, ReadonlyArray<string>]> =>
	Arr.flatMap(schemes, (each) =>
		Arr.map(
			Arr.reduce(labels, emptyAssignment, (acc, values) =>
				Arr.flatMap(acc, (prefix) => Arr.map(values, (value) => [...prefix, value]))
			),
			(chosen) => [each, chosen] as const
		)
	)

/** The origins an accepted server's template expands to, or the code that refuses it (design 6.4's precedence). */
const expansionOf = (
	value: Usable,
	sketch: ServersSketch
):
	| Readonly<{ kind: "origins"; origins: ReadonlyArray<string> }>
	| Readonly<{ kind: "refused"; code: string }> => {
	const [template] = written(value)
	if (hasQueryOrFragment(template)) {
		return { kind: "refused", code: "SRV-18/query-or-fragment" }
	}
	switch (value.kind) {
		case "schemeless":
			return { kind: "refused", code: "SRV-02/unsupported-form" }
		case "relative":
			return Option.match(sketch.retrievalUri, {
				onNone: () => ({ kind: "refused", code: "SRV-17/relative-needs-retrieval-uri" }),
				onSome: (uri) => {
					const verdict = judgeOrigin(
						Str.startsWith("https")(uri) ? "https" : "http",
						false,
						"docs.example.com",
						sketch.allowInsecure
					)
					if (verdict.kind === "refused") {
						return verdict
					}
					const origins = [verdict.origin]
					return Option.match(pathRefusal(value.path, true), {
						onNone: () => ({ kind: "origins", origins }),
						onSome: (code) => ({ kind: "refused", code })
					})
				}
			})
		case "absolute": {
			const spanParts = [value.scheme, ...value.labels]
			if (Arr.some(spanParts, (each) => each.kind === "variable" && !each.enumerated)) {
				return { kind: "refused", code: "SRV-05/variable-needs-enum" }
			}
			const verdicts = Arr.map(
				assignmentsOf(domainOf(value.scheme), Arr.map(value.labels, domainOf)),
				([schemeText, chosen]) =>
					judgeOrigin(
						schemeText,
						value.userinfo,
						`${Arr.join(chosen, ".")}.example.com`,
						sketch.allowInsecure
					)
			)
			const refused = Arr.findFirst(
				verdicts,
				(verdict): verdict is Refused => verdict.kind === "refused"
			)
			if (Option.isSome(refused)) {
				return refused.value
			}
			const origins = Arr.sort(
				Arr.dedupe(
					Arr.flatMap(verdicts, (verdict) => (verdict.kind === "origin" ? [verdict.origin] : []))
				),
				Order.String
			)
			return Option.match(pathRefusal(value.path, false), {
				onNone: () => ({ kind: "origins", origins }),
				onSome: (code) => ({ kind: "refused", code })
			})
		}
	}
}

/**
 * The refusal a path variable's values earn, one at a time: a query or fragment, or (in a relative template) a value
 * that opens a second authority and so leaves the server's origin.
 */
const pathRefusal = (path: PathPart, relative: boolean): Option.Option<string> => {
	if (path.kind !== "variable") {
		return Option.none()
	}
	const values = Arr.dedupe([...path.members, path.fallback])
	return Arr.findFirst(
		values,
		(each) => hasQueryOrFragment(each) || (relative && Str.startsWith("/")(each))
	).pipe(
		Option.map((each) =>
			hasQueryOrFragment(each) ? "SRV-18/query-or-fragment" : "SRV-02/value-leaves-authority"
		)
	)
}

/** The rows a server records. */
const rowsOf = (variables: number, implicit: boolean, at: LevelName): ReadonlyArray<string> =>
	Arr.sort(
		[
			"SRV-01",
			"SRV-02",
			...(variables > 0 ? ["SRV-05", "SRV-11"] : []),
			...(implicit ? ["SRV-10"] : []),
			...(at === "root" ? [] : ["SRV-15"])
		],
		Order.String
	)

/** One server built at its level, with the diagnostics its acceptance raises. */
const builtOf = (
	sketch: ServersSketch,
	at: LevelName,
	pointer: string,
	value: Form,
	named: Option.Option<string>,
	implicit: boolean
): readonly [Option.Option<ModelServer>, ReadonlyArray<Located>] => {
	if (value.kind === "invalid") {
		return [Option.none(), [[entryText, "SRV-19/invalid-template", "operation", pointer]]]
	}
	if (value.kind === "undeclared") {
		return [Option.none(), [[entryText, "SRV-11/undeclared-variable", "operation", pointer]]]
	}
	const [template, variables] = written(value)
	const line32 = sketch.line === "3.2"
	const accepted = acceptedEntries(sketch)
	const index = Arr.findFirstIndex(
		accepted,
		(each) => each === template || (line32 && Option.exists(named, (name) => name === each))
	)
	const expansion = Option.map(index, () => expansionOf(value, sketch))
	const origins = Option.match(expansion, {
		onNone: () => [],
		onSome: (found) => (found.kind === "origins" ? found.origins : [])
	})
	const server: ModelServer = {
		accepted: Option.exists(expansion, (found) => found.kind === "origins"),
		level: at,
		name: line32 ? named : Option.none(),
		pointer,
		origins,
		rows: rowsOf(variables.length, implicit, at),
		template,
		variables: Arr.sort(
			Arr.map(variables, ([name, variable]) => ({
				name,
				default: variable.default,
				enum: Option.fromUndefinedOr(variable.enum)
			})),
			Order.mapInput(Order.String, (variable: { readonly name: string }) => variable.name)
		)
	}
	const diagnostics: ReadonlyArray<Located> = Option.match(Option.all([index, expansion]), {
		onNone: () => [],
		onSome: ([place, found]) =>
			found.kind === "refused"
				? [[configText, found.code, "document", `/servers/accepted/${place}`]]
				: []
	})
	return [Option.some(server), diagnostics]
}

/** The level an operation uses: the operation's, then the path item's, then the root's (design 6.4). */
const chosenLevel = (sketch: ServersSketch): readonly [LevelName, Option.Option<Level>] =>
	Option.isSome(sketch.operation)
		? ["operation", sketch.operation]
		: Option.isSome(sketch.pathItem)
			? ["pathItem", sketch.pathItem]
			: ["root", sketch.root]

/** The implicit `/` server of a root that lists none. */
const implicitServer = (
	sketch: ServersSketch
): readonly [Option.Option<ModelServer>, ReadonlyArray<Located>] =>
	builtOf(
		sketch,
		"root",
		"/servers",
		{ kind: "relative", path: { kind: "none" } },
		Option.none(),
		true
	)

/** An `acceptedOrigins` entry judged: its origin, or the code that refuses it. */
const acceptedOriginVerdict = (value: AcceptedOrigin, allowInsecure: boolean): Verdict => {
	switch (value) {
		case "https://a.example.com":
		case "https://a.example.com/":
			return { kind: "origin", origin: "https://a.example.com" }
		case "https://zz.example.com":
			return { kind: "origin", origin: "https://zz.example.com" }
		case "http://a.example.com":
			return allowInsecure
				? { kind: "origin", origin: "http://a.example.com" }
				: { kind: "refused", code: "SRV-02/insecure-scheme" }
		case "https://u:p@a.example.com":
			return { kind: "refused", code: "SRV-02/userinfo" }
		case "https://a.example.com/v1":
			return { kind: "refused", code: "SRV-02/not-an-origin" }
		case "https://a.example.com?x=1":
			return { kind: "refused", code: "SRV-18/query-or-fragment" }
	}
}

/** The servers the operation uses and the origins bound, as design 6.4 states them. */
export const expectedOf = (sketch: ServersSketch): ServersModel => {
	const [at, chosen] = chosenLevel(sketch)
	const pointer = levelPointer[at]
	const [servers, diagnostics] = Option.match(chosen, {
		onNone: () => {
			const [server, found] = implicitServer(sketch)
			return [Option.toArray(server), found] as const
		},
		onSome: (value): readonly [ReadonlyArray<ModelServer>, ReadonlyArray<Located>] => {
			if (value.kind === "notList") {
				return [[], [[entryText, "SRV-01/invalid-server", "operation", pointer]]]
			}
			if (!Arr.isReadonlyArrayNonEmpty(value.entries)) {
				if (at === "root") {
					const [server, found] = implicitServer(sketch)
					return [Option.toArray(server), found]
				}
				return [[], [[entryText, "SRV-16/empty-override", "operation", pointer]]]
			}
			const built = Arr.map(value.entries, (each, index) =>
				each.kind === "notObject"
					? ([
							Option.none(),
							[[entryText, "SRV-01/invalid-server", "operation", `${pointer}/${index}`] as const]
						] as const)
					: builtOf(
							sketch,
							at,
							`${pointer}/${index}`,
							each.form,
							each.named ? Option.some(nameOf(at, index)) : Option.none(),
							false
						)
			)
			return [
				Arr.getSomes(Arr.map(built, ([server]) => server)),
				Arr.flatMap(built, ([, found]) => found)
			]
		}
	})
	const listed = Arr.map(sketch.acceptedOrigins, (each) =>
		acceptedOriginVerdict(each, sketch.allowInsecure)
	)
	return {
		servers,
		diagnostics,
		bound: Arr.sort(
			Arr.dedupe([
				...Arr.flatMap(servers, (server) => (server.accepted ? server.origins : [])),
				...Arr.flatMap(listed, (verdict) => (verdict.kind === "origin" ? [verdict.origin] : []))
			]),
			Order.String
		),
		boundDiagnostics: Arr.flatMap(listed, (verdict, index): ReadonlyArray<Located> =>
			verdict.kind === "refused"
				? [[configText, verdict.code, "document", `/acceptedOrigins/${index}`]]
				: []
		)
	}
}

/** A level's source as effectiveServers reads it. */
const sourceOf = (value: Option.Option<Level>, at: LevelName): ServerSource => ({
	tokens: levelTokens[at],
	value: Option.map(value, (declared) => levelJson(at, declared))
})

/** The servers effectiveServers gives the operation, and the origins boundOrigins binds, under the sketch's config. */
export const actualOf = (sketch: ServersSketch) =>
	Effect.gen(function* () {
		const config = yield* authorConfigOf(configMembers(sketch))
		const context = {
			config,
			configDocument: configUri,
			document: entryUri,
			line: sketch.line,
			openapi: openapiOf[sketch.line]
		}
		const result = effectiveServers(
			{
				root: sourceOf(sketch.root, "root"),
				pathItem: sourceOf(sketch.pathItem, "pathItem"),
				operation: sourceOf(sketch.operation, "operation")
			},
			context
		)
		const bound = boundOrigins(result.servers, context)
		const located = (diagnostic: (typeof result.diagnostics)[number]): Located => [
			diagnostic.document,
			diagnostic.code,
			diagnostic.scope,
			String(diagnostic.pointer)
		]
		return {
			servers: Arr.map(result.servers, (server) => ({
				accepted: server.accepted,
				level: server.level,
				name: Option.fromUndefinedOr(server.name),
				pointer: String(server.origin.pointer),
				origins: Arr.map(server.origins, String),
				rows: Arr.map(server.rows, String),
				template: String(server.template),
				variables: Arr.map(server.variables, (variable) => ({
					name: variable.name,
					default: variable.default,
					enum: Option.fromUndefinedOr(variable.enum)
				}))
			})),
			diagnostics: Arr.map(result.diagnostics, located),
			bound: Arr.map(bound.origins, String),
			boundDiagnostics: Arr.map(bound.diagnostics, located)
		}
	})

/** The features a sketch and its model reach. */
export const serversFeatures = (
	sketch: ServersSketch,
	model: ServersModel
): ReadonlyArray<ServersFeature> => {
	const codes = new Set(
		Arr.map([...model.diagnostics, ...model.boundDiagnostics], ([, code]) => code)
	)
	const pointers = new Set(Arr.map(model.diagnostics, ([, , , pointer]) => pointer))
	const [at] = chosenLevel(sketch)
	const accepted = acceptedEntries(sketch)
	const entries = Arr.flatMap(levelsOf(sketch), ([, value]) =>
		Option.match(value, {
			onNone: () => [],
			onSome: (declared) => (declared.kind === "list" ? declared.entries : [])
		})
	)
	const facts: ReadonlyArray<readonly [boolean, ServersFeature]> = [
		[
			Option.isSome(sketch.operation) &&
				(Option.isSome(sketch.pathItem) || Option.isSome(sketch.root)),
			"operation level wins"
		],
		[
			Option.isNone(sketch.operation) &&
				Option.isSome(sketch.pathItem) &&
				Option.isSome(sketch.root),
			"path item level wins"
		],
		[
			at === "root" && Arr.some(model.servers, (server) => !Arr.contains(server.rows, "SRV-10")),
			"root level"
		],
		[Arr.some(model.servers, (server) => Arr.contains(server.rows, "SRV-10")), "implicit server"],
		[codes.has("SRV-16/empty-override"), "empty override"],
		[
			codes.has("SRV-01/invalid-server") &&
				Arr.some([...pointers], (pointer) => Str.endsWith("servers")(pointer)),
			"servers not a list"
		],
		[
			codes.has("SRV-01/invalid-server") &&
				Arr.some([...pointers], (pointer) => !Str.endsWith("servers")(pointer)),
			"server not an object"
		],
		[codes.has("SRV-19/invalid-template"), "invalid template"],
		[codes.has("SRV-11/undeclared-variable"), "undeclared variable"],
		[
			Arr.some(
				model.servers,
				(server) => server.accepted && Arr.contains(accepted, server.template)
			),
			"accepted by URL"
		],
		[
			sketch.line === "3.2" &&
				Arr.some(
					model.servers,
					(server) => server.accepted && !Arr.contains(accepted, server.template)
				),
			"accepted by name"
		],
		[
			sketch.line === "3.1" &&
				Arr.some(
					entries,
					(each) => each.kind === "server" && each.accepted === "name" && each.named
				),
			"name ignored before 3.2"
		],
		[Arr.some(model.servers, (server) => !server.accepted), "server not accepted"],
		[codes.has("SRV-02/insecure-scheme"), "insecure scheme refused"],
		[
			sketch.allowInsecure && Arr.some(model.bound, (origin) => Str.startsWith("http:")(origin)),
			"insecure scheme allowed"
		],
		[codes.has("SRV-02/unsupported-scheme"), "unsupported scheme"],
		[codes.has("SRV-02/userinfo"), "userinfo refused"],
		[codes.has("SRV-18/query-or-fragment"), "query or fragment refused"],
		[codes.has("SRV-17/relative-needs-retrieval-uri"), "relative needs retrievalUri"],
		[
			Arr.some(model.servers, (server) => server.accepted && Str.startsWith("/")(server.template)),
			"relative through retrievalUri"
		],
		[codes.has("SRV-02/unsupported-form"), "unsupported relative form"],
		[codes.has("SRV-05/variable-needs-enum"), "variable needs an enum"],
		[
			Arr.some(model.servers, (server) => server.accepted && server.origins.length > 1),
			"enumerated host expanded"
		],
		[
			Arr.some(model.servers, (server) => server.accepted && server.origins.length > 3),
			"two variables expanded"
		],
		[
			codes.has("SRV-18/query-or-fragment") &&
				Arr.some(
					model.servers,
					(server) =>
						!server.accepted &&
						Arr.some(server.variables, (variable) => variable.name === "v" || variable.name === "x")
				),
			"path variable value refused"
		],
		[codes.has("SRV-02/value-leaves-authority"), "value leaves the authority"],
		[Arr.isReadonlyArrayNonEmpty(model.boundDiagnostics), "accepted origin refused"],
		[
			Arr.some(
				model.bound,
				(origin) => origin === "https://a.example.com" || origin === "https://zz.example.com"
			),
			"accepted origins bound"
		]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}

/** No diagnostic repeats the secrets a server URL or a variable value carries. */
export const echoesNoSecret = (model: ServersModel): boolean =>
	!Arr.some([...model.diagnostics, ...model.boundDiagnostics], (located) =>
		Arr.some(
			located,
			(field) => Str.includes("canary-secret")(field) || Str.includes("evil.com")(field)
		)
	)
