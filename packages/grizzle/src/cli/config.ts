import { Array as Arr, Effect, Option, Path, Record as Rec, Result } from "effect"
import { definedConfig } from "#adapter/config/define.ts"
import { toResult } from "#adapter/engine.ts"
import { loginRoleValues } from "#adapter/pool/registry.ts"
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
import { declaredAlike, identifierOf } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isList } from "#compiler/core/record.ts"
import { type BuiltSchema, parseBuiltSchema } from "#compiler/program/schema.ts"
import type { LoginWorkloads } from "#compiler/program/workload/compile.ts"
import { type Owned, type OwnedLogin, own, ownLogin } from "#compiler/schema/own.ts"
import { ownedEntry } from "#compiler/schema/protocol.ts"
import type { AnyWorkload } from "#compiler/types/db/workload.ts"

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
 *   owned fingerprint is the configured schema's), every login and role of one schema under a name of its own, a login
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
 * before any command runs.
 */
/**
 * One login's workloads as the configuration gives them, and its role values: what DbLayer.make compiles for the
 * login (adapter/pool/registry.ts loginRoles), which generate compiles too.
 */
export interface ConfiguredWorkloads extends LoginWorkloads {
	readonly workloads: ReadonlyArray<AnyWorkload>
	readonly roles: ReadonlyArray<unknown>
}

export interface ConfiguredSchema {
	/** The schema value as configured. */
	readonly value: unknown
	readonly owned: Owned
	/** The declared name and the PostgreSQL schema identifier. */
	readonly declared: string
	readonly ident: string
	/** The logins over the schema, in configured order. */
	readonly logins: ReadonlyArray<OwnedLogin>
	/** Each login's workloads, in configured order, with the role values its Dbs open. */
	readonly workloads: ReadonlyArray<ConfiguredWorkloads>
	/** `<migrations>/<ident>`. */
	readonly directory: string
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

/** `schemas[index]` of the configuration file `file` parsed as a built schema, read once where it names it. */
const builtSchema = (
	value: unknown,
	index: number,
	file: string
): Result.Result<BuiltSchema, CliError> =>
	Result.mapError(toResult(parseBuiltSchema(value, SourceLoc(file, []))), () =>
		cliError(new SchemaEntryRefused({ index, fault: { kind: "notBuilt" } }))
	)

/** `schemas[index]`, a built schema, owned, or the configuration's refusal of a schema that does not compile. */
const ownSchema = (schema: BuiltSchema, index: number): Result.Result<Owned, CliError> =>
	Result.mapError(toResult(own(schema.desc)), (error) =>
		cliError(new SchemaEntryRefused({ index, fault: { kind: "uncompiled", error } }))
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
	/** Each configured schema as it is read; its logins and their workloads are attached once the list is read. */
	const schemas: Array<
		Omit<ConfiguredSchema, "workloads" | "logins"> & {
			logins: Array<OwnedLogin>
			workloads: Array<ConfiguredWorkloads>
		}
	> = []
	for (const [i, s] of schemaValues.entries()) {
		const built = builtSchema(s, i, file)
		if (Result.isFailure(built)) {
			return Result.fail(built.failure)
		}
		const owned = ownSchema(built.success, i)
		if (Result.isFailure(owned)) {
			return Result.fail(owned.failure)
		}
		const o = owned.success
		const ident = identifierOf(o.installation)
		const clash = Arr.findFirst(schemas, (c) => c.ident === ident)
		if (Option.isSome(clash)) {
			return Result.fail(
				cliError(
					new SchemaEntryRefused({
						index: i,
						fault: { kind: "shared", name: o.name, other: clash.value.declared, ident }
					})
				)
			)
		}
		schemas.push({
			value: s,
			owned: o,
			declared: o.name,
			ident,
			logins: [],
			workloads: [],
			directory: path.join(migrations, ident)
		})
	}
	if (!isList(loginValues)) {
		return malformedSetting("logins")
	}
	for (const [i, l] of loginValues.entries()) {
		const refuseLogin = (fault: LoginEntryRefused["fault"]): CliError =>
			cliError(new LoginEntryRefused({ index: i, fault }))
		const built = ownedEntry(l, "login")
		if (built === undefined) {
			return Result.fail(refuseLogin({ kind: "notBuilt" }))
		}
		const owned = Result.mapError(toResult(ownLogin(built.desc)), (error) =>
			refuseLogin({ kind: "uncompiled", error })
		)
		if (Result.isFailure(owned)) {
			return Result.fail(owned.failure)
		}
		const login = owned.success
		const listed = Arr.findFirst(schemas, (c) => c.declared === login.base.name)
		if (Option.isNone(listed)) {
			return Result.fail(
				refuseLogin({ kind: "unlisted", login: login.name, schema: login.base.name })
			)
		}
		const entry = listed.value
		if (login.base.fingerprint !== entry.owned.fingerprint) {
			return Result.fail(
				refuseLogin({ kind: "otherVersion", login: login.name, schema: entry.declared })
			)
		}
		/** Logins and roles are PostgreSQL roles of one namespace per schema (`<schema>__<name>`): no two names alike
		 * (core/identity.ts declaredAlike). */
		const taken = Arr.flatMap(entry.logins, (other) => [
			{ name: other.name, holder: { kind: "login", name: other.name } as const },
			...Arr.map(other.roles, (r) => ({
				name: r.name,
				holder: { kind: "role", name: r.name, login: other.name } as const
			}))
		])
		/** The first of the login's names alike to one another login or role holds, with what holds it. */
		const clash = Arr.findFirst([login.name, ...Arr.map(login.roles, (r) => r.name)], (name) =>
			Option.map(
				Arr.findFirst(taken, (t) => declaredAlike(t.name, name)),
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
		entry.logins.push(login)
		entry.workloads.push({
			login: login.name,
			workloads: built.value.workload,
			roles: loginRoleValues(built.value)
		})
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
