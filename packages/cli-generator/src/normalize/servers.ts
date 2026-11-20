import { regex } from "arkregex"
import { Array as Arr, Option, Order, Predicate, Record, Result, String as Str } from "effect"
import { Url } from "effect/http"
import type { AuthorConfig } from "#model/author-config.ts"
import { DocumentUri, isDocumentUri, isSafeText, isServerTemplate } from "#model/brands.ts"
import type { SafeText } from "#model/brands.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import type { RowId, Server } from "#model/entities.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import { formatPointer } from "#model/pointer.ts"
import type { Json, JsonPointer } from "#model/pointer.ts"

/**
 * The `servers` value of one level and where it sits, as its pointer's reference tokens, which each server's origin
 * extends; `value` is none when the level does not declare `servers`.
 */
export interface ServerSource {
	readonly tokens: readonly string[]
	readonly value: Option.Option<Json>
}

/**
 * The three levels an operation's servers can come from.
 */
export interface ServerLevels {
	readonly operation?: ServerSource
	readonly pathItem?: ServerSource
	readonly root: ServerSource
}

/**
 * What servers normalization needs besides the spec value: the author config and the document it
 * was read from, the spec document and its full `openapi` string.
 */
export interface ServersContext {
	readonly config: AuthorConfig
	readonly configDocument: DocumentUri
	readonly document: DocumentUri
	readonly openapi: string
}

/**
 * Normalized servers and the diagnostics raised while producing them.
 */
export interface ServersResult {
	readonly diagnostics: readonly Diagnostic[]
	readonly servers: readonly Server[]
}

/**
 * The bound origin set, sorted and without duplicates, and the diagnostics raised producing it.
 */
export interface BoundOrigins {
	readonly diagnostics: readonly Diagnostic[]
	readonly origins: readonly DocumentUri[]
}

type ServerLevel = Server["level"]

/** A Server Variable Object as servers normalization reads it: its default, and its enum when it has one. */
type Variable = Readonly<{ default: string; enum: Option.Option<readonly string[]> }>

/**
 * A Server Object as servers normalization reads it: its url, its name when it has one, and its variables by name, none
 * when it declares none.
 */
type RawServer = Readonly<{
	name: Option.Option<string>
	url: string
	variables: Readonly<Record<string, Variable>>
}>

/** The strings of a JSON array, none when it is no array of strings. */
const stringsOf = (value: Json): Option.Option<readonly string[]> =>
	isArray(value) && Arr.every(value, Predicate.isString) ? Option.some(value) : Option.none()

/** A Server Variable Object: a string `default`, and an `enum` of strings when it has one; none when it is not. */
const variableOf = (value: Json): Option.Option<Variable> => {
	if (!isObject(value)) {
		return Option.none()
	}

	const members = Record.get(value, "enum")

	return Option.flatMap(
		Option.filter(Record.get(value, "default"), Predicate.isString),
		(fallback) =>
			Option.isNone(members)
				? Option.some({ default: fallback, enum: Option.none() })
				: Option.map(stringsOf(members.value), (strings) => ({
						default: fallback,
						enum: Option.some(strings)
					}))
	)
}

/**
 * A Server Object: a string `url`, a string `name` when it has one, and `variables`, when it has them, an object of
 * Server Variable Objects; none when any of these is not what it reads.
 */
const rawServerOf = (entry: Json): Option.Option<RawServer> => {
	if (!isObject(entry)) {
		return Option.none()
	}

	const name = Record.get(entry, "name")
	const declared = Record.get(entry, "variables")
	const variables = Option.isNone(declared)
		? Option.some({})
		: Option.flatMap(Option.liftPredicate(declared.value, isObject), (object) =>
				Option.all(Record.map(object, variableOf))
			)

	return Option.flatMap(Option.filter(Record.get(entry, "url"), Predicate.isString), (url) =>
		Option.isSome(name) && !Predicate.isString(name.value)
			? Option.none()
			: Option.map(variables, (read) => ({
					name: Option.filter(name, Predicate.isString),
					url,
					variables: read
				}))
	)
}

interface Refusal {
	readonly code: string
	readonly element: string
	readonly hint?: string
	readonly message: string
	readonly row: RowId
	readonly scope: Diagnostic["scope"]
}

/**
 * A refusal of servers normalization under its inventory row: its code is the row, a slash and the reason, so a code
 * always names its row.
 */
const refusal = (row: RowId, reason: string, fields: Omit<Refusal, "code" | "row">): Refusal => ({
	code: `${row}/${reason}`,
	row,
	...fields
})

/** The refusals servers normalization raises, by reason. */
const refusals = {
	invalidServer: refusal("SRV-01", "invalid-server", {
		element: "Server",
		hint: "Write servers as a list of objects with a url string.",
		message: "A servers value is not a list of Server Objects.",
		scope: "operation"
	}),
	insecureScheme: refusal("SRV-02", "insecure-scheme", {
		element: "Accepted server",
		hint: "Use https, or set allowInsecure in the author config for a local fixture.",
		message: "An accepted default must use https.",
		scope: "document"
	}),
	notAnOrigin: refusal("SRV-02", "not-an-origin", {
		element: "Accepted origin",
		hint: "List the scheme and authority only, such as https://api.example.com.",
		message: "An accepted origin has a path.",
		scope: "document"
	}),
	unparseable: refusal("SRV-02", "unparseable", {
		element: "Accepted server",
		message: "An accepted default does not parse as an absolute URL.",
		scope: "document"
	}),
	unsupportedForm: refusal("SRV-02", "unsupported-form", {
		element: "Accepted server",
		hint: "Write a relative server URL with a leading slash.",
		message: "A relative server URL must start with a slash.",
		scope: "document"
	}),
	unsupportedScheme: refusal("SRV-02", "unsupported-scheme", {
		element: "Accepted server",
		message: "An accepted default must use https, or http with allowInsecure.",
		scope: "document"
	}),
	userinfo: refusal("SRV-02", "userinfo", {
		element: "Accepted server",
		hint: "Remove the user and password from the server URL.",
		message: "An accepted default must not carry userinfo.",
		scope: "document"
	}),
	valueLeavesAuthority: refusal("SRV-02", "value-leaves-authority", {
		element: "Accepted server",
		hint: "Keep path variable values to path text that stays under the server's origin.",
		message: "A path variable value moves an accepted server to another origin.",
		scope: "document"
	}),
	variableNeedsEnum: refusal("SRV-05", "variable-needs-enum", {
		element: "Accepted server",
		hint: "Give the variable an enum, or list the server's origins in acceptedOrigins.",
		message: "A scheme or authority variable of an accepted server needs an enum.",
		scope: "document"
	}),
	undeclaredVariable: refusal("SRV-11", "undeclared-variable", {
		element: "Server",
		hint: "Declare the variable under variables, or remove it from the url.",
		message: "A server URL uses a variable that the server does not declare.",
		scope: "operation"
	}),
	emptyOverride: refusal("SRV-16", "empty-override", {
		element: "Servers",
		hint: "Remove the empty servers list, or list the servers this level uses.",
		message: "An empty servers list at the path item or operation has no defined meaning.",
		scope: "operation"
	}),
	relativeNeedsRetrievalUri: refusal("SRV-17", "relative-needs-retrieval-uri", {
		element: "Accepted server",
		hint: "Set retrievalUri in the author config, or accept an absolute server.",
		message: "A relative server URL needs retrievalUri to become a default.",
		scope: "document"
	}),
	queryOrFragment: refusal("SRV-18", "query-or-fragment", {
		element: "Accepted server",
		hint: "Remove the query or fragment.",
		message: "A server URL must not contain a query or a fragment.",
		scope: "document"
	}),
	invalidTemplate: refusal("SRV-19", "invalid-template", {
		element: "Server",
		message: "A server url is not a valid server URL template.",
		scope: "operation"
	})
}

interface Site {
	readonly document: DocumentUri
	readonly pointer: JsonPointer
}

const diagnose = (context: ServersContext, found: Refusal, site: Site): Diagnostic => ({
	code: found.code,
	document: site.document,
	element: found.element,
	...(found.hint === undefined ? {} : { hint: found.hint }),
	message: found.message,
	openapi: context.openapi,
	pointer: site.pointer,
	row: found.row,
	scope: found.scope,
	severity: "refusal",
	specSection: DocumentUri.make(`https://spec.openapis.org/oas/v${context.openapi}.html#server-url`)
})

const specSite = (context: ServersContext, pointer: JsonPointer): Site => ({
	document: context.document,
	pointer
})

const configSite = (context: ServersContext, pointer: JsonPointer): Site => ({
	document: context.configDocument,
	pointer
})

/**
 * A server variable in a template: a brace pair around a name. Splitting a template at it yields
 * the text before the first variable, then each variable's name followed by the text after it, so
 * the names sit at the odd indices.
 */
const variableSplit = regex("\\{([^{}/?#\\s]+)\\}", "u")

const queryOrFragment = regex("[?#]", "u")

const authoritySpan = regex("^(?:[^/?#]*:)?//[^/?#]*", "u")

const schemePrefix = regex("^[^/?#]+://", "u")

const segmentsOf = (template: string): Arr.NonEmptyReadonlyArray<string> =>
	Str.split(template, variableSplit)

const isName = (_segment: string, index: number): boolean => index % 2 === 1

const variableNames = (text: string): readonly string[] =>
	Arr.dedupe(Arr.filter(segmentsOf(text), isName))

/**
 * The template with each variable replaced by the value `valueOf` gives its name.
 */
const fill = (template: string, valueOf: (name: string) => string): string =>
	Arr.join(
		Arr.map(segmentsOf(template), (segment, index) =>
			isName(segment, index) ? valueOf(segment) : segment
		),
		""
	)

/**
 * The prefix of a template that decides its origin: scheme and authority, or none for a relative
 * path.
 */
const originSpan = (template: string): Option.Option<string> =>
	Option.map(Str.match(authoritySpan)(template), (found) => found[0])

/**
 * Judges one concrete origin text against the baked-default rules and returns its origin as the
 * URL parser reads it.
 */
const judge = (
	text: string,
	base: string | undefined,
	allowInsecure: boolean
): Result.Result<DocumentUri, Refusal> => {
	if (queryOrFragment.test(text)) {
		return Result.fail(refusals.queryOrFragment)
	}

	const url = Url.fromString(text, base)

	if (Result.isFailure(url)) {
		return Result.fail(refusals.unparseable)
	}

	const parsed = url.success

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return Result.fail(refusals.unsupportedScheme)
	}

	if (parsed.protocol === "http:" && !allowInsecure) {
		return Result.fail(refusals.insecureScheme)
	}

	if (parsed.username !== "" || parsed.password !== "") {
		return Result.fail(refusals.userinfo)
	}

	return isDocumentUri(parsed.origin)
		? Result.succeed(parsed.origin)
		: Result.fail(refusals.unparseable)
}

const sortOrigins = (origins: readonly DocumentUri[]): readonly DocumentUri[] =>
	Arr.sort(Arr.dedupe(origins), Order.String)

/** Whether the server declares the variable `name` with an enum. */
const hasEnum = (variables: Readonly<Record<string, Variable>>, name: string): boolean =>
	Option.exists(Record.get(variables, name), (variable) => Option.isSome(variable.enum))

const domainOf = (variable: Variable): readonly string[] =>
	Arr.dedupe([...Option.getOrElse(variable.enum, () => []), variable.default])

/**
 * The origins an accepted server expands to, or the rule that refuses it.
 */
type Expansion = Result.Result<readonly DocumentUri[], Refusal>

const assignments = (
	names: readonly string[],
	variables: Readonly<Record<string, Variable>>
): readonly ReadonlyMap<string, string>[] =>
	Arr.reduce(names, [new Map()], (acc: readonly ReadonlyMap<string, string>[], name) => {
		const values = domainOf(variables[name] ?? { default: "", enum: Option.none() })

		return Arr.flatMap(acc, (assignment) =>
			Arr.map(values, (value) => new Map<string, string>([...assignment, [name, value]]))
		)
	})

/**
 * Judges the values of the variables outside the origin span, one value at a time with the other
 * variables at their defaults: a value must not carry a query or fragment, and the full URL must
 * stay on one of the origins already accepted. Returns the refusal, if any.
 */
const judgePathValues = (
	raw: RawServer,
	spanNames: readonly string[],
	origins: readonly DocumentUri[],
	base: string | undefined
): Option.Option<Refusal> => {
	const { variables } = raw
	const defaults = (name: string) => variables[name]?.default ?? ""

	for (const name of Arr.difference(variableNames(raw.url), spanNames)) {
		for (const value of domainOf(variables[name] ?? { default: "", enum: Option.none() })) {
			if (queryOrFragment.test(value)) {
				return Option.some(refusals.queryOrFragment)
			}

			const url = Url.fromString(
				fill(raw.url, (each) => (each === name ? value : defaults(each))),
				base
			)

			if (Result.isFailure(url)) {
				return Option.some(refusals.unparseable)
			}

			if (!Arr.contains(origins, url.success.origin)) {
				return Option.some(refusals.valueLeavesAuthority)
			}
		}
	}

	return Option.none()
}

const expandOrigins = (
	raw: RawServer,
	context: ServersContext,
	allowInsecure: boolean
): Expansion => {
	const span = originSpan(raw.url)
	const { retrievalUri } = context.config
	const { variables } = raw
	const names = Option.match(span, { onNone: () => [], onSome: variableNames })

	if (Option.isNone(span) && !Str.startsWith("/")(raw.url)) {
		return Result.fail(refusals.unsupportedForm)
	}

	if (!Option.exists(span, (text) => schemePrefix.test(text)) && retrievalUri === undefined) {
		return Result.fail(refusals.relativeNeedsRetrievalUri)
	}

	if (Arr.some(names, (name) => !hasEnum(variables, name))) {
		return Result.fail(refusals.variableNeedsEnum)
	}

	const verdicts = Arr.map(assignments(names, variables), (assignment) =>
		Option.match(span, {
			onNone: () => judge(retrievalUri ?? "", undefined, allowInsecure),
			onSome: (text) =>
				judge(
					fill(text, (name) => assignment.get(name) ?? ""),
					retrievalUri,
					allowInsecure
				)
		})
	)
	const failure = Arr.findFirst(verdicts, Result.isFailure)

	if (Option.isSome(failure)) {
		return Result.fail(failure.value.failure)
	}

	const origins = sortOrigins(Arr.getSuccesses(verdicts))

	return Option.match(judgePathValues(raw, names, origins, retrievalUri), {
		onNone: () => Result.succeed(origins),
		onSome: Result.fail
	})
}

const acceptedIndex = (
	raw: RawServer,
	line32: boolean,
	config: AuthorConfig
): Option.Option<number> =>
	Arr.findFirstIndex(
		config.servers?.accepted ?? [],
		(entry) => entry === raw.url || (line32 && Option.contains(raw.name, entry))
	)

const rowsOf = (raw: RawServer, level: ServerLevel, implicit: boolean): readonly RowId[] => {
	const rows: readonly RowId[] = [
		"SRV-01",
		"SRV-02",
		...(Record.isEmptyRecord(raw.variables) ? [] : (["SRV-05", "SRV-11"] as const)),
		...(implicit ? (["SRV-10"] as const) : []),
		...(level === "root" ? [] : (["SRV-15"] as const))
	]

	return Arr.sort(rows, Order.String)
}

interface Built {
	readonly diagnostics: readonly Diagnostic[]
	readonly server: Option.Option<Server>
}

/**
 * Where an accepted server's entry sits in the author config, and its expansion there.
 */
interface Acceptance {
	readonly expansion: Expansion
	readonly index: number
}

const nameOf = (raw: RawServer, line32: boolean): Option.Option<SafeText> =>
	line32 ? Option.filter(raw.name, isSafeText) : Option.none()

const build = (
	raw: RawServer,
	level: ServerLevel,
	pointer: JsonPointer,
	implicit: boolean,
	context: ServersContext
): Built => {
	const site = specSite(context, pointer)
	const { url } = raw

	if (!isServerTemplate(url)) {
		return {
			diagnostics: [diagnose(context, refusals.invalidTemplate, site)],
			server: Option.none()
		}
	}

	const { variables } = raw

	if (Arr.some(variableNames(url), (name) => !Record.has(variables, name))) {
		return {
			diagnostics: [diagnose(context, refusals.undeclaredVariable, site)],
			server: Option.none()
		}
	}

	const line32 = Str.startsWith("3.2")(context.openapi)
	const acceptance = Option.map(
		acceptedIndex(raw, line32, context.config),
		(index): Acceptance => ({
			expansion: queryOrFragment.test(url)
				? Result.fail(refusals.queryOrFragment)
				: expandOrigins(raw, context, context.config.allowInsecure === true),
			index
		})
	)
	const name = nameOf(raw, line32)
	const server: Server = {
		accepted: Option.exists(acceptance, ({ expansion }) => Result.isSuccess(expansion)),
		level,
		...(Option.isSome(name) ? { name: name.value } : {}),
		origin: { document: context.document, pointer },
		origins: Option.match(acceptance, {
			onNone: () => [],
			onSome: ({ expansion }) => Result.getOrElse(expansion, () => [])
		}),
		rows: rowsOf(raw, level, implicit),
		template: url,
		variables: Arr.sort(
			Arr.map(Record.toEntries(variables), ([variable, { default: fallback, enum: members }]) =>
				Option.match(members, {
					onNone: () => ({ default: fallback, name: variable }),
					onSome: (strings) => ({ default: fallback, enum: strings, name: variable })
				})
			),
			Order.mapInput(Order.String, (variable: { readonly name: string }) => variable.name)
		)
	}

	return {
		diagnostics: Option.match(acceptance, {
			onNone: () => [],
			onSome: ({ expansion, index }) =>
				Result.match(expansion, {
					onFailure: (code) => [
						diagnose(
							context,
							code,
							configSite(context, formatPointer(["servers", "accepted", String(index)]))
						)
					],
					onSuccess: () => []
				})
		}),
		server: Option.some(server)
	}
}

const implicitLevel = (
	pointer: JsonPointer,
	level: ServerLevel,
	context: ServersContext
): ServersResult => {
	const built = build(
		{ name: Option.none(), url: "/", variables: {} },
		level,
		pointer,
		true,
		context
	)

	return { diagnostics: built.diagnostics, servers: Option.toArray(built.server) }
}

const declaredLevel = (
	value: Json,
	tokens: readonly string[],
	level: ServerLevel,
	context: ServersContext
): ServersResult => {
	const pointer = formatPointer(tokens)

	if (!isArray(value)) {
		return {
			diagnostics: [diagnose(context, refusals.invalidServer, specSite(context, pointer))],
			servers: []
		}
	}

	if (!Arr.isReadonlyArrayNonEmpty(value)) {
		return level === "root"
			? implicitLevel(pointer, level, context)
			: {
					diagnostics: [diagnose(context, refusals.emptyOverride, specSite(context, pointer))],
					servers: []
				}
	}

	const built = Arr.map(value, (entry, index): Built => {
		const itemPointer = formatPointer([...tokens, String(index)])

		return Option.match(rawServerOf(entry), {
			onNone: () => ({
				diagnostics: [diagnose(context, refusals.invalidServer, specSite(context, itemPointer))],
				server: Option.none()
			}),
			onSome: (raw) => build(raw, level, itemPointer, false, context)
		})
	})

	return {
		diagnostics: Arr.flatMap(built, (each) => each.diagnostics),
		servers: Arr.getSomes(Arr.map(built, (each) => each.server))
	}
}

const normalizeLevel = (
	source: ServerSource,
	level: ServerLevel,
	context: ServersContext
): ServersResult =>
	Option.match(source.value, {
		onNone: () => implicitLevel(formatPointer(source.tokens), level, context),
		onSome: (value) => declaredLevel(value, source.tokens, level, context)
	})

const declares = (source: ServerSource | undefined): source is ServerSource =>
	source !== undefined && Option.isSome(source.value)

/**
 * Chooses the servers an operation uses (operation, then path item, then root) and normalizes that
 * level. An empty override at the operation or path item is refused; an absent or empty root means
 * the single server `/`. A spec server is accepted only when the author config lists it.
 */
export const effectiveServers = (levels: ServerLevels, context: ServersContext): ServersResult => {
	if (declares(levels.operation)) {
		return normalizeLevel(levels.operation, "operation", context)
	}

	if (declares(levels.pathItem)) {
		return normalizeLevel(levels.pathItem, "pathItem", context)
	}

	return normalizeLevel(levels.root, "root", context)
}

/**
 * One `acceptedOrigins` entry: its origin, or the diagnostic that refuses it.
 */
const acceptedOrigin = (
	entry: string,
	index: number,
	context: ServersContext
): Result.Result<DocumentUri, Diagnostic> => {
	const site = configSite(context, formatPointer(["acceptedOrigins", String(index)]))
	const verdict = judge(entry, undefined, context.config.allowInsecure === true)

	if (Result.isFailure(verdict)) {
		return Result.fail(diagnose(context, verdict.failure, site))
	}

	const parsed = new URL(entry)

	return parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
		? Result.succeed(verdict.success)
		: Result.fail(diagnose(context, refusals.notAnOrigin, site))
}

/**
 * The bound origin set (design 6.4, 9 I3): the origins of the accepted servers' expansions plus the
 * author's `acceptedOrigins`, each checked against the baked-default rules.
 */
export const boundOrigins = (servers: readonly Server[], context: ServersContext): BoundOrigins => {
	const listed = Arr.map(context.config.acceptedOrigins ?? [], (entry, index) =>
		acceptedOrigin(entry, index, context)
	)

	return {
		diagnostics: Arr.getFailures(listed),
		origins: sortOrigins([
			...Arr.flatMap(servers, (server) => (server.accepted ? server.origins : [])),
			...Arr.getSuccesses(listed)
		])
	}
}
