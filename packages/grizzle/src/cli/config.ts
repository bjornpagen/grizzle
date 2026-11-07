import { Array as Arr, Effect, Option, Path, Record as Rec, Result } from "effect"
import { definedConfig } from "#adapter/config/define.ts"
import { toResult } from "#adapter/engine.ts"
import { type BuiltLogin, builtLogin, ownLoginOver } from "#adapter/pool/registry.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import {
	type CliError,
	configSettings,
	ExportRefused,
	LoginEntryRefused,
	cliError,
	SchemaEntryRefused,
	SettingRefused
} from "#cli/errors.ts"
import {
	type BuiltSchema,
	type CompileError,
	declaredAlike,
	identifierOf,
	isList,
	own,
	type Owned,
	type OwnedLogin,
	parseBuiltSchema,
	parseDeclaredName,
	schemaInstallation,
	SourceLoc
} from "#compiler/plan/common.ts"

/**
 * The configuration file: what the command line manages, a lean config.
 *
 * Every command names its configuration file as its one argument (args.ts), grizzle.config.ts by convention; no
 * command reads a file it does not name. Node runs it as TypeScript, as it runs every grizzle source, and its default
 * export is the configuration (adapter/types/config.ts), always built by defineConfig (adapter/config/define.ts),
 * imported from the package root:
 *
 *     import { defineConfig } from "@bjornpagen/grizzle"
 *     import { connection, Web, Work } from "./src/db.ts"
 *
 *     export default defineConfig({ schemas: [Work], logins: [Web], migrations: "migrations", connection })
 *
 * - `schemas`: the declared schema values to migrate, at least one, each a schema(...) or schema.extend(...) value
 *   (its outermost level). Each lives in its own PostgreSQL schema, which names its directory `<migrations>/<schema>/`
 *   holding its snapshot.json and its folders; two declared schemas of
 *   one PostgreSQL schema are refused.
 * - `logins`: the login(...) values whose roles the migrations install, each over a configured schema (its base's
 *   content digest is the configured schema's), every login and role of one schema under a name of its own, a login
 *   over a schema the configuration does not list refused. A role is installed exactly with its login. Each login's
 *   workloads (login(..., { workload })), which login(...) admitted, plan the schema's access paths; a schema whose
 *   logins own none drafts no access path.
 * - `migrations`: the migrations directory, absolute or relative to the configuration file's directory.
 * - `connection`: where `grizzle migrate` and `grizzle drift` connect (connection.ts). It is kept as given and checked
 *   only by them: generate, check and names never read it, and the configuration refuses only its absence.
 *
 * A plain object is refused with the fix, to wrap it in defineConfig: an Effect password's requirements and error
 * channel exist only in its type, which defineConfig's signature checks. Every setting is required and nothing else is
 * configurable: an unknown key is refused, so a misspelt one is never ignored. The default export is checked here
 * before any command runs, and nothing of it is compiled: the configuration's names, identifiers and directories are
 * read from the values as built, and only generate and check compile a schema and its logins (compileSchema).
 */
/** A login of the configuration: its index in `logins`, which a refusal names, and the login value, read. */
export interface ConfiguredLogin {
	readonly index: number
	readonly login: BuiltLogin
}

/**
 * A configured schema as every command reads it, nothing compiled: its index in `schemas`, the schema value, its
 * declared name, the identifier of its PostgreSQL schema, `<migrations>/<ident>`, and the logins over it, in configured
 * order. A command that applies committed SQL (migrate, drift, names) reads only this.
 */
export interface ConfiguredSchema {
	readonly index: number
	readonly built: BuiltSchema
	readonly declared: string
	readonly ident: string
	readonly directory: string
	readonly logins: ReadonlyArray<ConfiguredLogin>
}

/** A login of a compiled schema: the login value, and the login owned over the schema's Owned. */
export interface CompiledLogin {
	readonly login: BuiltLogin
	readonly owned: OwnedLogin
}

/**
 * A configured schema compiled, as generate and check draft it: the schema owned once, and each of its logins owned
 * over that Owned, in configured order (compileSchema).
 */
export interface CompiledSchema {
	readonly configured: ConfiguredSchema
	readonly owned: Owned
	readonly logins: ReadonlyArray<CompiledLogin>
}

/** The configuration file as the bin imported it: its path, and its default export, which resolveConfig checks. */
export interface ConfigFile {
	readonly file: string
	readonly value: unknown
}

export interface ResolvedConfig {
	/** The configuration file and its directory. */
	readonly file: string
	readonly directory: string
	/** The migrations directory, absolute. */
	readonly migrations: string
	/** In configured order. */
	readonly schemas: ReadonlyArray<ConfiguredSchema>
	/** The configuration's connection as given, checked only by `grizzle migrate` and `grizzle drift` (connection.ts). */
	readonly connection: MigrationConnectionConfig
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Arr.isArray(v)

/** Refuses a setting of a configuration `value` that no configuration has. */
const onlyKeys = (value: Record<string, unknown>): Result.Result<void, CliError> => {
	const allowed: ReadonlyArray<string> = configSettings
	const unknown = Arr.findFirst(Rec.keys(value), (k) => !allowed.includes(k))
	return Option.isNone(unknown)
		? Result.void
		: Result.fail(
				cliError(new SettingRefused({ fault: { kind: "unknown", setting: unknown.value } }))
			)
}

/** Refuses the value of `setting`, which is not of its kind. */
const malformedSetting = (
	setting: "schemas" | "logins" | "migrations"
): Result.Result<never, CliError> =>
	Result.fail(cliError(new SettingRefused({ fault: { kind: "malformed", setting } })))

const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0

/**
 * Whether two names logins and roles take are one PostgreSQL role, `<schema>__<name>`: both declared names whose
 * conversions agree (core/identity.ts declaredAlike). A name that is no declared name installs as no role, and the
 * compilation of its login refuses it.
 */
const takenAlike = (a: string, b: string): boolean => {
	const x = parseDeclaredName(a)
	const y = parseDeclaredName(b)
	return x.ok && y.ok && declaredAlike(x.value, y.value)
}

/** `schemas[index]` of the configuration file `file` parsed as a built schema, read once where it names it. */
const builtSchema = (
	value: unknown,
	index: number,
	file: string
): Result.Result<BuiltSchema, CliError> =>
	Result.mapError(toResult(parseBuiltSchema(value, SourceLoc(file, []))), () =>
		cliError(new SchemaEntryRefused({ index, fault: { kind: "notBuilt" } }))
	)

/** The configuration's refusal of `schemas[index]`, which does not compile, for `error`. */
const uncompiledSchema = (index: number) => (error: CompileError) =>
	cliError(new SchemaEntryRefused({ index, fault: { kind: "uncompiled", error } }))

/**
 * A configured schema compiled, for generate and check: the schema owned, once, and each of its logins owned over that
 * Owned, which login(...) held each login's roles to; a schema or login that does not compile is its configuration
 * entry's refusal.
 */
export const compileSchema = (schema: ConfiguredSchema): Result.Result<CompiledSchema, CliError> =>
	Result.flatMap(
		Result.mapError(toResult(own(schema.built.desc)), uncompiledSchema(schema.index)),
		(owned) =>
			Result.map(
				Result.all(
					Arr.map(schema.logins, (l) =>
						Result.mapError(
							Result.map(toResult(ownLoginOver(l.login, owned)), (o) => ({
								login: l.login,
								owned: o
							})),
							(error) =>
								cliError(
									new LoginEntryRefused({ index: l.index, fault: { kind: "uncompiled", error } })
								)
						)
					)
				),
				(logins): CompiledSchema => ({ configured: schema, owned, logins })
			)
	)

/** Checks a configuration value, the default export of `file`, whose directories `path` resolves. */
const resolveConfigWith = (
	path: Path.Path,
	value: unknown,
	file: string
): Result.Result<ResolvedConfig, CliError> => {
	const directory = path.dirname(file)
	if (!isObject(value)) {
		return Result.fail(cliError(new ExportRefused({ file, fault: "notAnObject" })))
	}
	const typed = definedConfig(value)
	if (Option.isNone(typed)) {
		return Result.fail(cliError(new ExportRefused({ file, fault: "notDefined" })))
	}
	const settings = onlyKeys(value)
	if (Result.isFailure(settings)) {
		return Result.fail(settings.failure)
	}
	const {
		migrations: migrationsSetting,
		schemas: schemaValues,
		logins: loginValues,
		connection: connectionSetting
	} = value
	if (!nonempty(migrationsSetting)) {
		return malformedSetting("migrations")
	}
	if (connectionSetting === undefined) {
		return Result.fail(cliError(new SettingRefused({ fault: { kind: "unconnected" } })))
	}
	const migrations = path.resolve(directory, migrationsSetting)
	if (!isList(schemaValues) || schemaValues.length === 0) {
		return malformedSetting("schemas")
	}
	/** Each configured schema as it is read; its logins are attached once the list is read. */
	const schemas: Array<Omit<ConfiguredSchema, "logins"> & { logins: Array<ConfiguredLogin> }> = []
	for (const [i, s] of schemaValues.entries()) {
		const built = builtSchema(s, i, file)
		if (Result.isFailure(built)) {
			return Result.fail(built.failure)
		}
		const desc = built.success.desc
		const installation = Result.mapError(
			toResult(schemaInstallation(desc.name, desc.loc)),
			uncompiledSchema(i)
		)
		if (Result.isFailure(installation)) {
			return Result.fail(installation.failure)
		}
		const ident = identifierOf(installation.success)
		const clash = Arr.findFirst(schemas, (c) => c.ident === ident)
		if (Option.isSome(clash)) {
			return Result.fail(
				cliError(
					new SchemaEntryRefused({
						index: i,
						fault: { kind: "shared", name: desc.name, other: clash.value.declared, ident }
					})
				)
			)
		}
		schemas.push({
			index: i,
			built: built.success,
			declared: desc.name,
			ident,
			logins: [],
			directory: path.join(migrations, ident)
		})
	}
	if (!isList(loginValues)) {
		return malformedSetting("logins")
	}
	for (const [i, l] of loginValues.entries()) {
		const refuseLogin = (fault: LoginEntryRefused["fault"]): CliError =>
			cliError(new LoginEntryRefused({ index: i, fault }))
		const read = builtLogin(l)
		if (read === undefined) {
			return Result.fail(refuseLogin({ kind: "notBuilt" }))
		}
		const login = read.desc
		const listed = Arr.findFirst(schemas, (c) => c.declared === login.base.name)
		if (Option.isNone(listed)) {
			return Result.fail(
				refuseLogin({ kind: "unlisted", login: login.name, schema: login.base.name })
			)
		}
		const entry = listed.value
		if (read.base.content.digest !== entry.built.content.digest) {
			return Result.fail(
				refuseLogin({ kind: "otherVersion", login: login.name, schema: entry.declared })
			)
		}
		/** Logins and roles are PostgreSQL roles of one namespace per schema (`<schema>__<name>`): no two names alike
		 * (core/identity.ts declaredAlike). */
		const taken = Arr.flatMap(entry.logins, ({ login: other }) => [
			{ name: other.desc.name, holder: { kind: "login", name: other.desc.name } as const },
			...Arr.map(other.desc.roles, (r) => ({
				name: r.name,
				holder: { kind: "role", name: r.name, login: other.desc.name } as const
			}))
		])
		/** The first of the login's names alike to one another login or role holds, with what holds it. */
		const clash = Arr.findFirst([login.name, ...Arr.map(login.roles, (r) => r.name)], (name) =>
			Option.map(
				Arr.findFirst(taken, (t) => takenAlike(t.name, name)),
				(t) => ({ name, holder: t.holder })
			)
		)
		if (Option.isSome(clash)) {
			return Result.fail(
				refuseLogin({
					kind: "nameTaken",
					login: login.name,
					name: clash.value.name,
					holder: clash.value.holder,
					schema: entry.declared
				})
			)
		}
		entry.logins.push({ index: i, login: read })
	}
	return Result.succeed({
		file,
		directory,
		migrations,
		schemas,
		connection: typed.value.connection
	})
}

/**
 * Checks a configuration value, the default export of `file`.
 *
 * @internal
 */
export const resolveConfig = Effect.fn("resolveConfig")(function* (
	value: unknown,
	file: string
): Effect.fn.Return<ResolvedConfig, CliError, Path.Path> {
	const path = yield* Path.Path
	return yield* Effect.fromResult(resolveConfigWith(path, value, file))
})
