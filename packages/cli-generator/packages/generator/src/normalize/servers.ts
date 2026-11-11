import { regex } from "arkregex"
import { Array as Arr, Option, Order, Record, Result, Schema, String as Str } from "effect"
import { Url } from "effect/http"
import type { AuthorConfig } from "#model/author-config.ts"
import {
	DocumentUri as DocumentUriSchema,
	JsonPointer as JsonPointerSchema,
	SafeText,
	ServerTemplate
} from "#model/brands.ts"
import { Diagnostic } from "#model/diagnostic.ts"
import { RowId, Server } from "#model/entities.ts"
import { isArray } from "#model/json-tree.ts"
import { childPointer, formatPointer } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"

/**
 * The `servers` value of one level and where it sits; `value` is none when the level does not
 * declare `servers`.
 */
export interface ServerSource {
	readonly pointer: JsonPointer
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

type DocumentUri = typeof DocumentUriSchema.Type

type JsonPointer = typeof JsonPointerSchema.Type

type ServerLevel = Server["level"]

/**
 * Most origins one accepted server may expand to. A proposal, not a design value: it bounds the
 * product of enumerated authority variables (design 9 I5).
 */
const maxExpansions = 256

const rawServer = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	url: Schema.String,
	variables: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Struct({
				default: Schema.String,
				enum: Schema.optionalKey(Schema.Array(Schema.String))
			})
		)
	)
})

type RawServer = typeof rawServer.Type

type Variable = Readonly<{ default: string; enum?: readonly string[] }>

interface Rule {
	readonly element: string
	readonly hint?: string
	readonly message: string
	readonly scope: Diagnostic["scope"]
}

const rules = {
	"SRV-01/invalid-server": {
		element: "Server",
		hint: "Write servers as a list of objects with a url string.",
		message: "A servers value is not a list of Server Objects.",
		scope: "operation"
	},
	"SRV-02/insecure-scheme": {
		element: "Accepted server",
		hint: "Use https, or set allowInsecure in the author config for a local fixture.",
		message: "An accepted default must use https.",
		scope: "document"
	},
	"SRV-02/not-an-origin": {
		element: "Accepted origin",
		hint: "List the scheme and authority only, such as https://api.example.com.",
		message: "An accepted origin has a path.",
		scope: "document"
	},
	"SRV-02/unparseable": {
		element: "Accepted server",
		message: "An accepted default does not parse as an absolute URL.",
		scope: "document"
	},
	"SRV-02/unsupported-form": {
		element: "Accepted server",
		hint: "Write a relative server URL with a leading slash.",
		message: "A relative server URL must start with a slash.",
		scope: "document"
	},
	"SRV-02/unsupported-scheme": {
		element: "Accepted server",
		message: "An accepted default must use https, or http with allowInsecure.",
		scope: "document"
	},
	"SRV-02/userinfo": {
		element: "Accepted server",
		hint: "Remove the user and password from the server URL.",
		message: "An accepted default must not carry userinfo.",
		scope: "document"
	},
	"SRV-02/value-leaves-authority": {
		element: "Accepted server",
		hint: "Keep path variable values to path text that stays under the server's origin.",
		message: "A path variable value moves an accepted server to another origin.",
		scope: "document"
	},
	"SRV-05/too-many-origins": {
		element: "Accepted server",
		hint: "Narrow the enums, or list the origins in acceptedOrigins.",
		message: "An accepted server expands to more origins than the generator allows.",
		scope: "document"
	},
	"SRV-05/variable-needs-enum": {
		element: "Accepted server",
		hint: "Give the variable an enum, or list the server's origins in acceptedOrigins.",
		message: "A scheme or authority variable of an accepted server needs an enum.",
		scope: "document"
	},
	"SRV-11/undeclared-variable": {
		element: "Server",
		hint: "Declare the variable under variables, or remove it from the url.",
		message: "A server URL uses a variable that the server does not declare.",
		scope: "operation"
	},
	"SRV-16/empty-override": {
		element: "Servers",
		hint: "Remove the empty servers list, or list the servers this level uses.",
		message: "An empty servers list at the path item or operation has no defined meaning.",
		scope: "operation"
	},
	"SRV-17/relative-needs-retrieval-uri": {
		element: "Accepted server",
		hint: "Set retrievalUri in the author config, or accept an absolute server.",
		message: "A relative server URL needs retrievalUri to become a default.",
		scope: "document"
	},
	"SRV-18/query-or-fragment": {
		element: "Accepted server",
		hint: "Remove the query or fragment.",
		message: "A server URL must not contain a query or a fragment.",
		scope: "document"
	},
	"SRV-19/invalid-template": {
		element: "Server",
		message: "A server url is not a valid server URL template.",
		scope: "operation"
	}
} as const satisfies Readonly<Record<string, Rule>>

type RuleCode = keyof typeof rules

interface Site {
	readonly document: DocumentUri
	readonly pointer: string
}

const diagnose = (context: ServersContext, code: RuleCode, site: Site): Diagnostic => {
	const rule: Rule = rules[code]

	return Diagnostic.make({
		code,
		document: site.document,
		element: rule.element,
		...(rule.hint === undefined ? {} : { hint: rule.hint }),
		message: rule.message,
		openapi: context.openapi,
		pointer: JsonPointerSchema.make(site.pointer),
		row: RowId.make(Arr.headNonEmpty(Str.split(code, "/"))),
		scope: rule.scope,
		severity: "refusal",
		specSection: DocumentUriSchema.make(
			`https://spec.openapis.org/oas/v${context.openapi}.html#server-url`
		)
	})
}

const specSite = (context: ServersContext, pointer: string): Site => ({
	document: context.document,
	pointer
})

const configSite = (context: ServersContext, pointer: string): Site => ({
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

const isDocumentUri = Schema.is(DocumentUriSchema)

/**
 * Judges one concrete origin text against the baked-default rules and returns its origin as the
 * URL parser reads it.
 */
const judge = (
	text: string,
	base: string | undefined,
	allowInsecure: boolean
): Result.Result<DocumentUri, RuleCode> => {
	if (queryOrFragment.test(text)) {
		return Result.fail("SRV-18/query-or-fragment")
	}

	const url = Url.fromString(text, base)

	if (Result.isFailure(url)) {
		return Result.fail("SRV-02/unparseable")
	}

	const parsed = url.success

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return Result.fail("SRV-02/unsupported-scheme")
	}

	if (parsed.protocol === "http:" && !allowInsecure) {
		return Result.fail("SRV-02/insecure-scheme")
	}

	if (parsed.username !== "" || parsed.password !== "") {
		return Result.fail("SRV-02/userinfo")
	}

	return isDocumentUri(parsed.origin)
		? Result.succeed(parsed.origin)
		: Result.fail("SRV-02/unparseable")
}

const sortOrigins = (origins: readonly DocumentUri[]): readonly DocumentUri[] =>
	Arr.sort(Arr.dedupe(origins), Order.String)

const domainOf = (variable: Variable): readonly string[] =>
	Arr.dedupe([...(variable.enum ?? []), variable.default])

/**
 * The origins an accepted server expands to, or the rule that refuses it.
 */
type Expansion = Result.Result<readonly DocumentUri[], RuleCode>

const assignments = (
	names: readonly string[],
	variables: Readonly<Record<string, Variable>>
): readonly ReadonlyMap<string, string>[] =>
	Arr.reduce(names, [new Map()], (acc: readonly ReadonlyMap<string, string>[], name) => {
		const values = domainOf(variables[name] ?? { default: "" })

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
): Option.Option<RuleCode> => {
	const variables = raw.variables ?? {}
	const defaults = (name: string) => variables[name]?.default ?? ""

	for (const name of Arr.difference(variableNames(raw.url), spanNames)) {
		for (const value of domainOf(variables[name] ?? { default: "" })) {
			if (queryOrFragment.test(value)) {
				return Option.some("SRV-18/query-or-fragment")
			}

			const url = Url.fromString(
				fill(raw.url, (each) => (each === name ? value : defaults(each))),
				base
			)

			if (Result.isFailure(url)) {
				return Option.some("SRV-02/unparseable")
			}

			if (!Arr.contains(origins, url.success.origin)) {
				return Option.some("SRV-02/value-leaves-authority")
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
	const variables = raw.variables ?? {}
	const names = Option.match(span, { onNone: () => [], onSome: variableNames })

	if (Option.isNone(span) && !Str.startsWith("/")(raw.url)) {
		return Result.fail("SRV-02/unsupported-form")
	}

	if (!Option.exists(span, (text) => schemePrefix.test(text)) && retrievalUri === undefined) {
		return Result.fail("SRV-17/relative-needs-retrieval-uri")
	}

	if (Arr.some(names, (name) => variables[name]?.enum === undefined)) {
		return Result.fail("SRV-05/variable-needs-enum")
	}

	const count = Arr.reduce(
		names,
		1,
		(product, name) => product * domainOf(variables[name] ?? { default: "" }).length
	)

	if (count > maxExpansions) {
		return Result.fail("SRV-05/too-many-origins")
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
		(entry) => entry === raw.url || (line32 && raw.name !== undefined && entry === raw.name)
	)

const rowsOf = (
	raw: RawServer,
	level: ServerLevel,
	implicit: boolean
): readonly (typeof RowId.Type)[] =>
	Arr.map(
		Arr.sort(
			[
				"SRV-01",
				"SRV-02",
				...(Record.isEmptyRecord(raw.variables ?? {}) ? [] : ["SRV-05", "SRV-11"]),
				...(implicit ? ["SRV-10"] : []),
				...(level === "root" ? [] : ["SRV-15"])
			],
			Order.String
		),
		(row) => RowId.make(row)
	)

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

const isSafeText = Schema.is(SafeText)

const isServerTemplate = Schema.is(ServerTemplate)

const nameOf = (raw: RawServer, line32: boolean): Option.Option<typeof SafeText.Type> =>
	line32 ? Option.filter(Option.fromUndefinedOr(raw.name), isSafeText) : Option.none()

const build = (
	raw: RawServer,
	level: ServerLevel,
	pointer: string,
	implicit: boolean,
	context: ServersContext
): Built => {
	const site = specSite(context, pointer)
	const { url } = raw

	if (!isServerTemplate(url)) {
		return {
			diagnostics: [diagnose(context, "SRV-19/invalid-template", site)],
			server: Option.none()
		}
	}

	const variables = raw.variables ?? {}

	if (Arr.some(variableNames(url), (name) => variables[name] === undefined)) {
		return {
			diagnostics: [diagnose(context, "SRV-11/undeclared-variable", site)],
			server: Option.none()
		}
	}

	const line32 = Str.startsWith("3.2")(context.openapi)
	const acceptance = Option.map(
		acceptedIndex(raw, line32, context.config),
		(index): Acceptance => ({
			expansion: queryOrFragment.test(url)
				? Result.fail("SRV-18/query-or-fragment")
				: expandOrigins(raw, context, context.config.allowInsecure === true),
			index
		})
	)
	const name = nameOf(raw, line32)
	const server = Server.make({
		accepted: Option.exists(acceptance, ({ expansion }) => Result.isSuccess(expansion)),
		level,
		...(Option.isSome(name) ? { name: name.value } : {}),
		origin: { document: context.document, pointer: JsonPointerSchema.make(pointer) },
		origins: Option.match(acceptance, {
			onNone: () => [],
			onSome: ({ expansion }) => Result.getOrElse(expansion, () => [])
		}),
		rows: rowsOf(raw, level, implicit),
		template: url,
		variables: Arr.sort(
			Arr.map(Record.toEntries(variables), ([variable, { default: fallback, enum: members }]) =>
				members === undefined
					? { default: fallback, name: variable }
					: { default: fallback, enum: members, name: variable }
			),
			Order.mapInput(Order.String, (variable: { readonly name: string }) => variable.name)
		)
	})

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

const parseRaw = Schema.decodeUnknownOption(rawServer)

const implicitLevel = (
	pointer: string,
	level: ServerLevel,
	context: ServersContext
): ServersResult => {
	const built = build({ url: "/" }, level, pointer, true, context)

	return { diagnostics: built.diagnostics, servers: Option.toArray(built.server) }
}

const declaredLevel = (
	value: Json,
	pointer: string,
	level: ServerLevel,
	context: ServersContext
): ServersResult => {
	if (!isArray(value)) {
		return {
			diagnostics: [diagnose(context, "SRV-01/invalid-server", specSite(context, pointer))],
			servers: []
		}
	}

	if (!Arr.isReadonlyArrayNonEmpty(value)) {
		return level === "root"
			? implicitLevel(pointer, level, context)
			: {
					diagnostics: [diagnose(context, "SRV-16/empty-override", specSite(context, pointer))],
					servers: []
				}
	}

	const built = Arr.map(value, (entry, index): Built => {
		const itemPointer = childPointer(pointer, String(index))

		return Option.match(parseRaw(entry), {
			onNone: () => ({
				diagnostics: [diagnose(context, "SRV-01/invalid-server", specSite(context, itemPointer))],
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
		onNone: () => implicitLevel(source.pointer, level, context),
		onSome: (value) => declaredLevel(value, source.pointer, level, context)
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
		: Result.fail(diagnose(context, "SRV-02/not-an-origin", site))
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
