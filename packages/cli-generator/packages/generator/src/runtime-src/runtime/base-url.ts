import { regex } from "arkregex"
import {
	Array as Arr,
	Config,
	Context,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { Flag, GlobalFlag } from "effect/cli"
import { Url } from "effect/http"
import { UsageError } from "#domain/errors.ts"
import { asCliError } from "#runtime/input.ts"

/**
 * One server variable of the OpenAPI Server Object. `enum` is optional.
 */
export interface ServerVariable {
	readonly default: string
	readonly enum?: readonly string[]
}

/**
 * One server of the table. `name` is the OpenAPI 3.2 server name.
 */
export interface ServerEntry {
	readonly name?: string
	readonly url: string
	readonly variables?: Readonly<Record<string, ServerVariable>>
}

/**
 * The table the emitted `api/servers.ts` satisfies: the servers, the accepted default (an index,
 * absent when the author accepted none) and the bound origin set.
 */
export interface ServersTable {
	readonly boundOrigins: readonly string[]
	readonly defaultServer?: number
	readonly servers: readonly ServerEntry[]
}

/**
 * The generated servers table and the environment prefix, provided by `cli/root.ts`.
 */
export class Servers extends Context.Service<
	Servers,
	{ readonly table: ServersTable; readonly envPrefix: string }
>()("effect-openapi-cli-generator/runtime-src/runtime/base-url/Servers") {}

export const layer = (table: ServersTable, envPrefix: string): Layer.Layer<Servers> =>
	Layer.succeed(Servers, { envPrefix, table })

/**
 * Who chose the base: the operator (`--base-url`, `<PREFIX>_BASE_URL`) or the server table.
 */
export type Provenance = "operator" | "server"

/**
 * The chosen base. A server selection carries the server and its variables (defaults overlaid
 * with `--server-variable`); expanding the template is `m1-rt9b`'s work.
 */
export type Selection =
	| { readonly provenance: "operator"; readonly baseUrl: string }
	| {
			readonly provenance: "server"
			readonly server: ServerEntry
			readonly variables: Readonly<Record<string, string>>
	  }

export interface ServerVariableAssignment {
	readonly name: string
	readonly value: string
}

export interface SelectionInput {
	readonly baseUrl: Option.Option<string>
	readonly server: Option.Option<string>
	readonly serverVariables: readonly ServerVariableAssignment[]
}

const usage = (flag: string, cause: string): UsageError =>
	UsageError.make({ flag, message: `${flag}: ${cause}` })

/**
 * The characters that end an authority: the path, query and fragment delimiters.
 */
const authorityDelimiter = regex("[/?#]", "u")

/**
 * The text an authority check reads: from after the first `://` (from index 2 when the text has
 * none) up to the first `/`, `?` or `#`.
 */
const authorityOf = (raw: string): string => {
	const start = Option.match(Str.indexOf("://")(raw), { onNone: () => 2, onSome: (at) => at + 3 })
	const rest = Str.slice(start)(raw)

	return Option.match(Str.search(authorityDelimiter)(rest), {
		onNone: () => rest,
		onSome: (end) => Str.slice(0, end)(rest)
	})
}

/**
 * Check an operator-chosen base URL. `label` names the flag or env variable in the error. The
 * error names the cause and never the value.
 */
export const validateBaseUrl = (label: string, raw: string): Effect.Effect<string, UsageError> =>
	Result.match(Url.fromString(raw), {
		onFailure: () => Effect.fail(usage(label, "not an absolute URL")),
		onSuccess: (parsed) => {
			const { protocol } = parsed
			if (protocol !== "http:" && protocol !== "https:") {
				return Effect.fail(usage(label, "the scheme must be http or https"))
			}

			if (Str.includes("@")(authorityOf(raw)) || parsed.username !== "" || parsed.password !== "") {
				return Effect.fail(usage(label, "the URL must not contain userinfo"))
			}

			if (Str.includes("?")(raw)) {
				return Effect.fail(usage(label, "the URL must not contain a query"))
			}

			if (Str.includes("#")(raw)) {
				return Effect.fail(usage(label, "the URL must not contain a fragment"))
			}

			return Effect.succeed(raw)
		}
	})

/**
 * Split `name=value` at the first `=`. A missing `=` or an empty name is malformed.
 */
export const parseServerVariable = (
	raw: string
): Effect.Effect<ServerVariableAssignment, UsageError> =>
	Option.match(
		Option.filter(Str.indexOf("=")(raw), (at) => at > 0),
		{
			onNone: () => Effect.fail(usage("--server-variable", "expected name=value")),
			onSome: (at) => Effect.succeed({ name: Str.slice(0, at)(raw), value: Str.slice(at + 1)(raw) })
		}
	)

const serverIndex = regex("^\\d+$", "u")

const lookupServer = (table: ServersTable, raw: string): Effect.Effect<ServerEntry, UsageError> =>
	Effect.fromOption(
		Arr.findFirst(table.servers, (entry) => entry.name === raw).pipe(
			Option.orElse(() =>
				serverIndex.test(raw) ? Arr.get(table.servers, Number(raw)) : Option.none()
			)
		)
	).pipe(Effect.mapError(() => usage("--server", "unknown server")))

/**
 * The accepted default of a table: the server at `defaultServer`, none when the author accepted none.
 */
const acceptedDefault = (table: ServersTable): Option.Option<ServerEntry> =>
	table.defaultServer === undefined ? Option.none() : Arr.get(table.servers, table.defaultServer)

const expandVariables = (
	server: ServerEntry,
	assignments: readonly ServerVariableAssignment[]
): Effect.Effect<Readonly<Record<string, string>>, UsageError> =>
	Effect.gen(function* expandAll() {
		const declared = server.variables ?? {}
		const values = new Map(
			Arr.map(Rec.toEntries(declared), ([name, variable]) => [name, variable.default] as const)
		)
		const seen = new Set<string>()
		for (const { name, value } of assignments) {
			const variable = Rec.get(declared, name)
			if (Option.isNone(variable)) {
				return yield* usage("--server-variable", "unknown server variable")
			}

			if (seen.has(name)) {
				return yield* usage("--server-variable", "a server variable was given more than once")
			}

			const allowed = variable.value.enum
			if (allowed !== undefined && !Arr.contains(allowed, value)) {
				return yield* usage("--server-variable", "value outside the variable's allowed values")
			}

			seen.add(name)
			values.set(name, value)
		}

		return Rec.fromEntries(values)
	})

/**
 * Choose the base: `--base-url`, then `<PREFIX>_BASE_URL`, then `--server` with
 * `--server-variable`, then the accepted default. With none of them the error names `--base-url`.
 * `--server` and the default read the effective table (design 6.4): the operation's or path item's
 * override, else the root table from `Servers`, which the caller settles. Table-dependent causes
 * are checked here, not in the flags, because a flag's `mapEffect` cannot read the `Servers`
 * service.
 */
export const select = (
	input: SelectionInput,
	table: ServersTable
): Effect.Effect<Selection, UsageError, Servers> =>
	Effect.gen(function* choose() {
		const { envPrefix } = yield* Servers
		if (Option.isSome(input.baseUrl)) {
			const baseUrl = yield* validateBaseUrl("--base-url", input.baseUrl.value)

			return { baseUrl, provenance: "operator" } as const
		}

		const envName = `${envPrefix}_BASE_URL`
		const env = yield* Config.option(Config.String(envName)).pipe(
			Effect.mapError(() => usage(envName, "the environment could not be read"))
		)
		if (Option.isSome(env)) {
			const baseUrl = yield* validateBaseUrl(envName, env.value)

			return { baseUrl, provenance: "operator" } as const
		}

		const server = Option.isSome(input.server)
			? yield* Effect.asSome(lookupServer(table, input.server.value))
			: acceptedDefault(table)
		if (Option.isNone(server)) {
			return yield* usage("--base-url", "no server is accepted as a default; give a base URL")
		}

		const variables = yield* expandVariables(server.value, input.serverVariables)

		return { provenance: "server", server: server.value, variables } as const
	})

export const baseUrlSetting = GlobalFlag.Setting("base-url")({
	flag: Flag.String("base-url").pipe(
		Flag.withMetavar("url"),
		Flag.withDescription("Base URL of the API; overrides the spec's servers"),
		Flag.mapEffect((raw) => validateBaseUrl("--base-url", raw).pipe(Effect.mapError(asCliError))),
		Flag.optional
	)
})

export const serverSetting = GlobalFlag.Setting("server")({
	flag: Flag.String("server").pipe(
		Flag.withMetavar("name|index"),
		Flag.withDescription("Server from the spec to use"),
		Flag.optional
	)
})

export const serverVariableSetting = GlobalFlag.Setting("server-variable")({
	flag: Flag.String("server-variable").pipe(
		Flag.withMetavar("name=value"),
		Flag.withDescription("Server variable value; repeatable"),
		Flag.mapEffect((raw) => parseServerVariable(raw).pipe(Effect.mapError(asCliError))),
		Flag.atLeast(0)
	)
})

/**
 * One `{name}` of a server template; splitting a template by it leaves the literal text at even
 * indexes and the variable names at odd ones.
 */
const templateVariable = regex("\\{([^{}]*)\\}", "u")

/**
 * The flag a server-derived failure names: the variables when the server has any, else the server.
 */
const serverFlag = (server: ServerEntry): string =>
	server.variables !== undefined && !Rec.isEmptyReadonlyRecord(server.variables)
		? "--server-variable"
		: "--server"

/**
 * Substitute `{name}` in a server template. A value inside the scheme or authority is inserted as
 * given and judged by the origin check; a value after the authority is percent-encoded as one
 * path segment, so it cannot add a separator, a query or a fragment. Text outside the braces
 * keeps its bytes.
 */
const expandTemplate = (
	server: ServerEntry,
	variables: Readonly<Record<string, string>>
): Effect.Effect<string, UsageError> => {
	const flag = serverFlag(server)
	const { url } = server
	const authorityStart = Option.match(Str.indexOf("://")(url), {
		onNone: () => 0,
		onSome: (at) => at + 3
	})
	const authorityEnd = Option.map(
		Str.search(authorityDelimiter)(Str.slice(authorityStart)(url)),
		(end) => authorityStart + end
	)
	const inAuthority = (at: number): boolean =>
		Option.match(authorityEnd, { onNone: () => true, onSome: (end) => at < end })
	const pieces = Str.split(templateVariable)(url)

	return Effect.gen(function* expand() {
		let out = ""
		let at = 0
		for (const [index, piece] of pieces.entries()) {
			if (index % 2 === 0) {
				out += piece
				at += piece.length
				continue
			}

			const value = Rec.get(variables, piece)
			if (Option.isNone(value)) {
				return yield* usage(flag, "the server template names a variable that has no value")
			}

			const text = inAuthority(at)
				? value.value
				: yield* Effect.try({
						catch: () => usage(flag, "a server variable value is not valid text"),
						try: () => encodeURIComponent(value.value)
					})
			out += text
			at += piece.length + 2
		}

		return out
	})
}

/**
 * A brace left in an expanded template: the template was malformed.
 */
const templateBrace = regex("[{}]", "u")

const normalizeOrigin = (origin: string): string =>
	Result.match(Url.fromString(origin), {
		onFailure: () => origin,
		onSuccess: (parsed) => parsed.origin
	})

/**
 * The base URL a request is built on. An operator base is returned as validated. A server selection
 * is expanded, checked like an operator base (scheme, userinfo, query, fragment), parsed with the
 * same `URL` parser the client uses, and its origin must be in the bound set of the effective
 * `table`; otherwise a `UsageError` names `--server` or `--server-variable`, before any
 * connection. The operator's way to an unbound host is `--base-url`.
 */
export const resolve = (
	selection: Selection,
	table: ServersTable
): Effect.Effect<string, UsageError> =>
	Effect.gen(function* resolveBase() {
		if (selection.provenance === "operator") {
			return selection.baseUrl
		}

		const flag = serverFlag(selection.server)
		const expanded = yield* expandTemplate(selection.server, selection.variables)
		if (templateBrace.test(expanded)) {
			return yield* usage(flag, "the server template is malformed")
		}

		const base = yield* validateBaseUrl(flag, expanded)
		const origin = yield* Result.match(Url.fromString(base), {
			onFailure: () => Effect.fail(usage(flag, "not an absolute URL")),
			onSuccess: (parsed) => Effect.succeed(parsed.origin)
		})
		if (!Arr.some(table.boundOrigins, (bound) => normalizeOrigin(bound) === origin)) {
			return yield* usage(flag, "the server URL is outside the origins bound at generation")
		}

		return base
	})

/**
 * The request URL: the base, then the builder's path and serialized query (no leading `?`), by
 * string concatenation, never `new URL(path, base)`. One trailing `/` of the base is dropped so a
 * base of `https://host/v1/` and a path of `/users` do not double the separator.
 */
export const requestUrl = (base: string, path: string, query: string): string => {
	const root = Str.startsWith("/")(path) && Str.endsWith("/")(base) ? Str.slice(0, -1)(base) : base

	return query === "" ? `${root}${path}` : `${root}${path}?${query}`
}
