import { Array as Arr, Config, Formatter, Schema } from "effect"
import { CompileErrorSchema } from "#adapter/errors/failures.ts"
import { compileReasonText, isCompileError } from "#compiler/core/errors.ts"
import { maxMigrationNameLength, metaFileName } from "#compiler/deploy/render/folder.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"

/**
 * The failure of a `grizzle` command outside the apply runner.
 *
 * The apply runner fails with its own MigrateError (adapter/migrate/errors.ts), whose stage says what the database
 * holds. Everything the command line itself refuses is a CliError, whose classified case is its `reason`: one of the
 * classes here, each a Schema.TaggedError carrying exactly what was refused and rendering its own `message`. What
 * follows from a reason is a getter of the error, never a stored field: the stage it stopped at, and the declared
 * schema it concerns. The stages:
 *
 * - `usage`: the command line does not name one of the commands, or names it with a malformed argument, a migration
 *   name of no folder's shape, or a schema choice the configuration does not allow;
 * - `config`: grizzle.config.ts is missing, fails to load, or is not a configuration (config.ts), or migrate finds no
 *   connection it accepts (connection.ts);
 * - `filesystem`: the migrations directory could not be read or written, or holds what no generator wrote;
 * - `snapshot`: a schema's committed snapshot.json is not the generator's (edited, or of another schema), or it and the
 *   schema's folders disagree, so neither a draft nor an apply could continue the chain;
 * - `generate`: the compiler refused the schema, its logins' workloads or the draft.
 *
 * Every refusal happens before anything is written: a generate writes no folder of any schema until every configured
 * schema has drafted, and an apply hands nothing to the runner until every schema's directory reads.
 *
 * A failure underneath is grizzle's own classified value where it is one (a CompileError); `cause` is only a foreign
 * value wrapped: what importing grizzle.config.ts threw, the platform's file system failure, the ConfigProvider's.
 * Nothing a CliError reports carries a credential, a connection password or a stored value: the configuration is
 * named by its keys, a URL by its parts, and the compiler's diagnostics carry source locations and capabilities only.
 */
export type CliStage = "usage" | "config" | "filesystem" | "snapshot" | "generate"

/**
 * The platform's file system failure, as a reason wraps it: an Error whose own cause is the operating system's error.
 * Effect's PlatformError is one, an unstable API a reason does not name.
 */
const FileSystemFailureSchema = Schema.instanceOf(Error)

/** The operating system's error code a file system failure carries, as a refusal names it, or nothing. */
const codeOf = (failure: Error): string => {
	const os = failure.cause
	return Error.isError(os) && "code" in os && typeof os.code === "string" ? ` (${os.code})` : ""
}

/**
 * The text of a thrown value. A CompileError a builder threw is named by its message (its reason, location and sentence); any
 * other error by its name and message; anything else by its formatting.
 */
const thrownText = (thrown: unknown): string => {
	if (isCompileError(thrown)) {
		return `CompileError ${thrown.message}`
	}
	if (Error.isError(thrown)) {
		return `${thrown.name}: ${thrown.message}`
	}
	return Formatter.format(thrown)
}

/** A configured schema as a refusal names it: its declared name, with its PostgreSQL schema when the two differ. */
const SchemaNamesSchema = Schema.Struct({ declared: Schema.String, ident: Schema.String })

const schemaListText = (schemas: ReadonlyArray<typeof SchemaNamesSchema.Type>): string =>
	Arr.join(
		Arr.map(schemas, (s) => (s.declared === s.ident ? s.declared : `${s.declared} (${s.ident})`)),
		", "
	)

/** The commands of the command line. */
const CommandNameSchema = Schema.Literals([
	"generate",
	"check",
	"migrate",
	"drift",
	"names",
	"skill"
])

/** The flags of `grizzle generate`, and those that take a value. */
const FlagSchema = Schema.Literals(["custom", "name", "schema"])
const ValuedFlagSchema = Schema.Literals(["name", "schema"])

/**
 * How a command line fails to parse: its command is none of them, a command takes no argument it was given, an option
 * of generate is unknown, a flag is given twice, or a valued flag has no value.
 */
const ArgumentFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("unknownCommand"), command: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("unexpectedArgument"),
		command: CommandNameSchema,
		argument: Schema.String
	}),
	Schema.Struct({ kind: Schema.Literal("unknownOption"), option: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("repeatedFlag"), flag: FlagSchema }),
	Schema.Struct({ kind: Schema.Literal("flagWithoutValue"), flag: ValuedFlagSchema })
])

/** The command line does not parse, for `fault` (args.ts). */
export class ArgumentsRefused extends Schema.TaggedError<
	ArgumentsRefused,
	{ readonly brand: unique symbol }
>()("ArgumentsRefused", { fault: ArgumentFaultSchema }) {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "unknownCommand":
				return `unknown command ${JSON.stringify(fault.command)}; the commands are generate, check, migrate, drift, names and skill`
			case "unexpectedArgument":
				return fault.command === "generate"
					? `grizzle generate takes no argument, not ${JSON.stringify(fault.argument)}; name the migration with --name`
					: `grizzle ${fault.command} takes no argument, not ${JSON.stringify(fault.argument)}`
			case "unknownOption":
				return `unknown option ${JSON.stringify(fault.option)}`
			case "repeatedFlag":
				return `--${fault.flag} is given twice`
			case "flagWithoutValue":
				return `--${fault.flag} needs a value`
		}
	}
}

/** The migration name `--name` gives, `migration`, or a custom folder's, is not of a folder name's shape. */
export class MigrationNameRefused extends Schema.TaggedError<
	MigrationNameRefused,
	{ readonly brand: unique symbol }
>()("MigrationNameRefused", { migration: Schema.String }) {
	override get message(): string {
		return `migration name ${JSON.stringify(this.migration)} is not lowercase ASCII letters and digits joined by _ or -, at most ${maxMigrationNameLength} characters`
	}
}

/**
 * The schema generate applies to cannot be chosen: `--schema` given while the configuration declares one schema,
 * `--schema` naming none of the configured `schemas`, or a custom migration without `--schema` while the configuration
 * declares several.
 */
const SchemaChoiceFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("single") }),
	Schema.Struct({
		kind: Schema.Literal("unknown"),
		named: Schema.String,
		schemas: Schema.Array(SchemaNamesSchema)
	}),
	Schema.Struct({ kind: Schema.Literal("unchosen"), schemas: Schema.Array(SchemaNamesSchema) })
])

export class SchemaChoiceRefused extends Schema.TaggedError<
	SchemaChoiceRefused,
	{ readonly brand: unique symbol }
>()("SchemaChoiceRefused", { fault: SchemaChoiceFaultSchema }) {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "single":
				return "--schema is accepted only when grizzle.config.ts declares several schemas; it declares one"
			case "unknown":
				return `--schema ${fault.named} names no configured schema; grizzle.config.ts declares ${schemaListText(fault.schemas)}`
			case "unchosen":
				return `a custom migration is a folder of one schema, and grizzle.config.ts declares ${schemaListText(fault.schemas)}; name one with --schema`
		}
	}
}

/** The configuration file grizzle reads. */
export const configFileName = "grizzle.config.ts"

/** No grizzle.config.ts is in `directory`, the one grizzle runs in. */
export class ConfigMissing extends Schema.TaggedError<
	ConfigMissing,
	{ readonly brand: unique symbol }
>()("ConfigMissing", { directory: Schema.String }) {
	override get message(): string {
		return `no ${configFileName} in ${this.directory}; grizzle reads its configuration from the directory it runs in`
	}
}

/** grizzle.config.ts could not be found or imported: `cause` is what its import, or the file system, threw. */
export class ConfigUnloaded extends Schema.TaggedError<
	ConfigUnloaded,
	{ readonly brand: unique symbol }
>()("ConfigUnloaded", { cause: Schema.Unknown }) {
	override get message(): string {
		return `${configFileName} failed to load: ${thrownText(this.cause)}`
	}
}

/** grizzle.config.ts has no default export, or its default export is no object, or no object defineConfig built. */
export class ExportRefused extends Schema.TaggedError<
	ExportRefused,
	{ readonly brand: unique symbol }
>()("ExportRefused", { fault: Schema.Literals(["missing", "notAnObject", "notDefined"]) }) {
	override get message(): string {
		switch (this.fault) {
			case "missing":
				return `${configFileName} has no default export; export the configuration as default`
			case "notAnObject":
				return `the default export of ${configFileName} must be a configuration object`
			case "notDefined":
				return `the default export of ${configFileName} must be built by defineConfig, imported from @bjornpagen/grizzle: export default defineConfig({ schemas: [...], logins: [...] })`
		}
	}
}

/** The settings of a configuration, in the order a refusal lists them. */
export const configSettings = ["schemas", "logins", "migrations", "connection"] as const

/** The settings whose value the configuration reads itself; `connection` is migrate's to check. */
const ReadSettingSchema = Schema.Literals(["schemas", "logins", "migrations"])

const malformedSettingText: Readonly<Record<typeof ReadSettingSchema.Type, string>> = {
	schemas: "schemas must be a nonempty list of the declared schema values to migrate",
	logins:
		"logins must be a list of the login values whose roles the migrations install, and whose workloads plan its indexes",
	migrations: "migrations must be a nonempty directory path when given"
}

/** A setting no configuration has (`unknown`), or one whose value is not of its kind (`malformed`). */
const SettingFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("unknown"), setting: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("malformed"), setting: ReadSettingSchema })
])

export class SettingRefused extends Schema.TaggedError<
	SettingRefused,
	{ readonly brand: unique symbol }
>()("SettingRefused", { fault: SettingFaultSchema }) {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "unknown":
				return `${configFileName} has no setting ${JSON.stringify(fault.setting)}; its settings are ${Arr.join(configSettings, ", ")}`
			case "malformed":
				return malformedSettingText[fault.setting]
		}
	}
}

/**
 * `schemas[index]` is no schema value, does not compile, or is installed in the PostgreSQL schema `ident` of the
 * declared schema `other`, listed before it.
 */
const SchemaEntryFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("notBuilt") }),
	Schema.Struct({ kind: Schema.Literal("uncompiled"), error: CompileErrorSchema }),
	Schema.Struct({
		kind: Schema.Literal("shared"),
		name: Schema.String,
		other: Schema.String,
		ident: Schema.String
	})
])

export class SchemaEntryRefused extends Schema.TaggedError<
	SchemaEntryRefused,
	{ readonly brand: unique symbol }
>()("SchemaEntryRefused", { index: Schema.Int, fault: SchemaEntryFaultSchema }) {
	override get message(): string {
		const at = `schemas[${this.index}]`
		const fault = this.fault
		switch (fault.kind) {
			case "notBuilt":
				return `${at} is not a schema value built by schema(...) or schema.extend(...)`
			case "uncompiled":
				return `${at} does not compile: ${fault.error.message}`
			case "shared":
				return `${at} (${fault.name}) and ${fault.other} are both installed in PostgreSQL schema ${fault.ident}; each declared schema has its own schema, snapshot and ledger`
		}
	}
}

/**
 * What already holds a name alike to one a login takes: another login of the schema, `name`, or a role `name` of login
 * `login`.
 */
const NameHolderSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("login"), name: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("role"), name: Schema.String, login: Schema.String })
])

/**
 * `logins[index]` is no login value, does not compile, is over a schema `schemas` does not list or over another version
 * of one it does, or names a login or role (`name`) alike to a name another login or role of its schema holds: their
 * segments agree, so both would be the one PostgreSQL role `<schema>__<conversion>`.
 */
const LoginEntryFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("notBuilt") }),
	Schema.Struct({ kind: Schema.Literal("uncompiled"), error: CompileErrorSchema }),
	Schema.Struct({ kind: Schema.Literal("unlisted"), login: Schema.String, schema: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("otherVersion"),
		login: Schema.String,
		schema: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("nameTaken"),
		login: Schema.String,
		name: Schema.String,
		holder: NameHolderSchema,
		schema: Schema.String
	})
])

export class LoginEntryRefused extends Schema.TaggedError<
	LoginEntryRefused,
	{ readonly brand: unique symbol }
>()("LoginEntryRefused", { index: Schema.Int, fault: LoginEntryFaultSchema }) {
	override get message(): string {
		const at = `logins[${this.index}]`
		const fault = this.fault
		switch (fault.kind) {
			case "notBuilt":
				return `${at} is not a login value built by login(...)`
			case "uncompiled":
				return `${at} does not compile: ${fault.error.message}`
			case "unlisted":
				return `${at} (${fault.login}) is over schema ${fault.schema}, which schemas does not list; a login is installed with its schema`
			case "otherVersion":
				return `${at} (${fault.login}) is over another version of schema ${fault.schema} than the one schemas lists; a login must be built over the configured schema value`
			case "nameTaken": {
				const holder =
					fault.holder.kind === "login"
						? `login ${fault.holder.name}`
						: `role ${fault.holder.name} of login ${fault.holder.login}`
				return `${at} (${fault.login}) names ${fault.name}, one name with ${holder} of schema ${fault.schema}; logins and roles of one schema have names that convert apart, their PostgreSQL roles being <schema>__<name>, so rename one of them`
			}
		}
	}
}

/**
 * The configuration's `connection` is refused, for `detail`: the connection parser's own refusal, naming the setting
 * (adapter/connection/config.ts parseConnection), as a DbConfig's is.
 */
export class ConnectionRefused extends Schema.TaggedError<
	ConnectionRefused,
	{ readonly brand: unique symbol }
>()("ConnectionRefused", { detail: Schema.String }) {
	override get message(): string {
		return this.detail
	}
}

/** Neither the configuration nor DATABASE_URL says where grizzle migrate connects. */
export class ConnectionUnnamed extends Schema.TaggedError<
	ConnectionUnnamed,
	{ readonly brand: unique symbol }
>()("ConnectionUnnamed", {}) {
	override get message(): string {
		return "grizzle migrate needs DATABASE_URL=postgresql://<role>[:<password>]@<host>[:<port>]/<database>, or a connection in grizzle.config.ts"
	}
}

/** The ConfigProvider could not read the environment variable `variable`, for `cause`. */
export class EnvironmentUnread extends Schema.TaggedError<
	EnvironmentUnread,
	{ readonly brand: unique symbol }
>()("EnvironmentUnread", {
	variable: Schema.String,
	cause: Schema.instanceOf(Config.ConfigError)
}) {
	override get message(): string {
		return `the environment variable ${this.variable} could not be read: ${this.cause.message}`
	}
}

/**
 * How DATABASE_URL is refused, never quoting it: it is no URL, its protocol is not postgresql:// or postgres://, it has
 * a fragment, a part's percent-encoding is malformed, it names no role, host or database, its port is 0, or it asks for
 * an sslmode other than verify-full or has a parameter other than sslmode and sslrootcert.
 */
const UrlFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("notUrl") }),
	Schema.Struct({ kind: Schema.Literal("protocol"), protocol: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("fragment") }),
	Schema.Struct({
		kind: Schema.Literal("encoding"),
		part: Schema.Literals(["role", "password", "host", "database"])
	}),
	Schema.Struct({ kind: Schema.Literal("noRole") }),
	Schema.Struct({ kind: Schema.Literal("noHost") }),
	Schema.Struct({ kind: Schema.Literal("port"), port: Schema.Int }),
	Schema.Struct({ kind: Schema.Literal("noDatabase") }),
	Schema.Struct({ kind: Schema.Literal("sslmode"), mode: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("parameter"), parameter: Schema.String })
])

export class DatabaseUrlRefused extends Schema.TaggedError<
	DatabaseUrlRefused,
	{ readonly brand: unique symbol }
>()("DatabaseUrlRefused", { fault: UrlFaultSchema }) {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "notUrl":
				return "DATABASE_URL is not a URL; its form is postgresql://<role>[:<password>]@<host>[:<port>]/<database>"
			case "protocol":
				return `DATABASE_URL must start with postgresql://, not ${fault.protocol}//`
			case "fragment":
				return "DATABASE_URL has a fragment, which names nothing"
			case "encoding":
				return `DATABASE_URL has a malformed percent-encoding in its ${fault.part}`
			case "noRole":
				return "DATABASE_URL names no role: postgresql://<role>@<host>/<database>"
			case "noHost":
				return "DATABASE_URL names no host"
			case "port":
				return `DATABASE_URL names port ${fault.port}; a port is from 1 to 65535`
			case "noDatabase":
				return "DATABASE_URL names no database: postgresql://<role>@<host>/<database>"
			case "sslmode":
				return `DATABASE_URL asks for sslmode=${fault.mode}; TLS is always verify-full, so sslmode may only be verify-full`
			case "parameter":
				return `DATABASE_URL has the parameter ${JSON.stringify(fault.parameter)}; its parameters are sslmode and sslrootcert`
		}
	}
}

/** Where a CA file is named: DATABASE_URL's `sslrootcert` parameter, or the PGSSLROOTCERT variable. */
const CaSourceSchema = Schema.Literals(["sslrootcert", "PGSSLROOTCERT"])

const caSourceText = (source: typeof CaSourceSchema.Type): string =>
	source === "sslrootcert" ? "DATABASE_URL's sslrootcert" : "PGSSLROOTCERT"

/** The CA file `source` names, `file`, does not exist (`missing`) or holds no certificate (`empty`). */
export class CaRefused extends Schema.TaggedError<CaRefused, { readonly brand: unique symbol }>()(
	"CaRefused",
	{
		source: CaSourceSchema,
		file: Schema.String,
		fault: Schema.Literals(["missing", "empty"])
	}
) {
	override get message(): string {
		return `${caSourceText(this.source)} names ${this.file}, which ${this.fault === "missing" ? "does not exist" : "holds no certificate"}`
	}
}

/** The CA file `source` names, `file`, could not be read, for `cause`. */
export class CaUnread extends Schema.TaggedError<CaUnread, { readonly brand: unique symbol }>()(
	"CaUnread",
	{
		source: CaSourceSchema,
		file: Schema.String,
		cause: FileSystemFailureSchema
	}
) {
	override get message(): string {
		return `${caSourceText(this.source)} names ${this.file}, which could not be read${codeOf(this.cause)}`
	}
}

/**
 * The migrations directory of `schema` holds what no generator writes: `directory`, its directory, is no directory; it
 * holds `entry`, neither snapshot.json nor a migration folder; or the migration folder at `folder` has no meta.json, or
 * holds `entry`, which is no file.
 */
const TreeFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("notDirectory"), directory: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("strayEntry"),
		directory: Schema.String,
		entry: Schema.String
	}),
	Schema.Struct({ kind: Schema.Literal("noMeta"), folder: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("notAFile"), folder: Schema.String, entry: Schema.String })
])

export class TreeRefused extends Schema.TaggedError<
	TreeRefused,
	{ readonly brand: unique symbol }
>()("TreeRefused", {
	schema: Schema.String,
	fault: TreeFaultSchema
}) {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "notDirectory":
				return `${fault.directory} is not a directory; it is schema ${this.schema}'s migrations directory`
			case "strayEntry":
				return `${fault.directory} holds ${fault.entry}, which is neither ${snapshotFileName} nor a migration folder`
			case "noMeta":
				return `migration folder ${fault.folder} has no ${metaFileName}; every drafted folder has one`
			case "notAFile":
				return `migration folder ${fault.folder} holds ${fault.entry}, which is not a file; a folder holds meta.json and its NN-<phase>.sql files`
		}
	}
}

/** The migrations directory of `schema`, `directory`, could not be read, for `cause`. */
export class TreeUnread extends Schema.TaggedError<TreeUnread, { readonly brand: unique symbol }>()(
	"TreeUnread",
	{
		schema: Schema.String,
		directory: Schema.String,
		cause: FileSystemFailureSchema
	}
) {
	override get message(): string {
		return `${this.directory} could not be read${codeOf(this.cause)}`
	}
}

/** A drafted folder of `schema` would be written at `path`, which exists: a migration folder is never overwritten. */
export class FolderExists extends Schema.TaggedError<
	FolderExists,
	{ readonly brand: unique symbol }
>()("FolderExists", { schema: Schema.String, path: Schema.String }) {
	override get message(): string {
		return `${this.path} already exists; a migration folder is never overwritten`
	}
}

/** The migration folder `folder` of `schema` could not be written, for `cause`. */
export class FolderUnwritten extends Schema.TaggedError<
	FolderUnwritten,
	{ readonly brand: unique symbol }
>()("FolderUnwritten", {
	schema: Schema.String,
	folder: Schema.String,
	cause: FileSystemFailureSchema
}) {
	override get message(): string {
		return `migration folder ${this.folder} could not be written${codeOf(this.cause)}`
	}
}

/** The snapshot.json of `schema` could not be written, for `cause`. */
export class SnapshotUnwritten extends Schema.TaggedError<
	SnapshotUnwritten,
	{ readonly brand: unique symbol }
>()("SnapshotUnwritten", { schema: Schema.String, cause: FileSystemFailureSchema }) {
	override get message(): string {
		return `${snapshotFileName} of ${this.schema} could not be written${codeOf(this.cause)}`
	}
}

/**
 * The migrations directory, `directory`, could not be read for the schemas a first draft abandons, for `cause`; it
 * concerns no one schema.
 */
export class MigrationsUnread extends Schema.TaggedError<
	MigrationsUnread,
	{ readonly brand: unique symbol }
>()("MigrationsUnread", { directory: Schema.String, cause: FileSystemFailureSchema }) {
	override get message(): string {
		return `${this.directory} could not be read${codeOf(this.cause)}`
	}
}

/** grizzle skill could not read the skill it ships, or write it, for `cause`. */
export class SkillUninstalled extends Schema.TaggedError<
	SkillUninstalled,
	{ readonly brand: unique symbol }
>()("SkillUninstalled", { cause: FileSystemFailureSchema }) {
	override get message(): string {
		return `the skill could not be installed${codeOf(this.cause)}`
	}
}

/** The snapshot.json of `schema` in `directory` does not decode as a snapshot, for `error`. */
export class SnapshotUnreadable extends Schema.TaggedError<
	SnapshotUnreadable,
	{ readonly brand: unique symbol }
>()("SnapshotUnreadable", {
	schema: Schema.String,
	directory: Schema.String,
	error: CompileErrorSchema
}) {
	override get message(): string {
		return `${this.directory}/snapshot.json is not a snapshot the generator wrote: ${compileReasonText(this.error.reason)}`
	}
}

/**
 * The snapshot.json in `directory` is the snapshot of another schema: of the declared schema `found.schemaName` in the
 * PostgreSQL schema `found.schema`, not of `schema` in `ident`.
 */
export class SnapshotForeign extends Schema.TaggedError<
	SnapshotForeign,
	{ readonly brand: unique symbol }
>()("SnapshotForeign", {
	schema: Schema.String,
	ident: Schema.String,
	directory: Schema.String,
	found: Schema.Struct({ schemaName: Schema.String, schema: Schema.String })
}) {
	override get message(): string {
		return `${this.directory}/snapshot.json is the snapshot of schema ${this.found.schemaName} in PostgreSQL schema ${this.found.schema}, not of ${this.schema} in ${this.ident}`
	}
}

/**
 * What breaks a schema's committed chain besides a folder's name (cli/committed.ts committedChain): a folder whose
 * meta.json does not read (`unreadableMeta`), one whose meta.json is a migration of another PostgreSQL schema
 * (`foreignMeta`), and the first folder named `<YYYYMMDDHHMMSS>_<name>` whose source is not its predecessor's target,
 * the empty snapshot's for the first (`brokenChain`).
 */
const ChainFaultSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("unreadableMeta"),
		folder: Schema.String,
		failure: CompileErrorSchema
	}),
	Schema.Struct({
		kind: Schema.Literal("foreignMeta"),
		folder: Schema.String,
		schema: Schema.String
	}),
	Schema.Struct({ kind: Schema.Literal("brokenChain"), folder: Schema.String })
])
export type ChainFault = typeof ChainFaultSchema.Type

/**
 * Why a draft cannot continue a schema's committed chain: a folder not named `<YYYYMMDDHHMMSS>_<name>` (`misnamed`), a
 * ChainFault, or a whole chain that does not reach snapshot.json's fingerprint `snapshot`: no folder at all
 * (`unreached`), or a newest folder reaching `reached` (`diverged`).
 */
const ChainBreakSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("misnamed"), folder: Schema.String }),
	ChainFaultSchema,
	Schema.Struct({ kind: Schema.Literal("unreached"), snapshot: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("diverged"),
		folder: Schema.String,
		reached: Schema.String,
		snapshot: Schema.String
	})
])
export type ChainBreak = typeof ChainBreakSchema.Type

/** The committed chain of `schema`, installed in `ident`, in `directory`, breaks at `fault`. */
export class ChainRefused extends Schema.TaggedError<
	ChainRefused,
	{ readonly brand: unique symbol }
>()("ChainRefused", {
	schema: Schema.String,
	ident: Schema.String,
	directory: Schema.String,
	fault: ChainBreakSchema
}) {
	override get message(): string {
		const fault = this.fault
		const directory = this.directory
		switch (fault.kind) {
			case "misnamed":
				return `${directory}/${fault.folder} is not named <YYYYMMDDHHMMSS>_<name>`
			case "unreadableMeta":
				return `${directory}/${fault.folder}/meta.json is malformed: ${compileReasonText(fault.failure.reason)}`
			case "foreignMeta":
				return `${directory}/${fault.folder} is a migration of PostgreSQL schema ${fault.schema}, not ${this.ident}`
			case "brokenChain":
				return `${directory}/${fault.folder}/meta.json does not continue the committed chain: its source is not the previous folder's target; restore it from version control`
			case "unreached":
				return `${directory}/snapshot.json is snapshot ${fault.snapshot}, but no migration folder reaches it; restore the folders or the snapshot from version control`
			case "diverged":
				return `the newest migration ${fault.folder} reaches snapshot ${fault.reached}, but snapshot.json is ${fault.snapshot}; a draft must continue the committed chain, so restore the matching snapshot.json or folder from version control`
		}
	}
}

/** The step of a draft the compiler refused: the workload, the schema's installation, the draft, or a custom folder. */
const DraftStepSchema = Schema.Literals(["workload", "schema", "draft", "custom"])

const draftStepText: Readonly<Record<typeof DraftStepSchema.Type, string>> = {
	workload: "a login's workload does not compile",
	schema: "the schema does not compile",
	draft: "the migration could not be drafted",
	custom: "the custom migration could not be created"
}

/** The compiler refused `step` of the draft of `schema`, for `error`. */
export class DraftRefused extends Schema.TaggedError<
	DraftRefused,
	{ readonly brand: unique symbol }
>()("DraftRefused", { schema: Schema.String, step: DraftStepSchema, error: CompileErrorSchema }) {
	override get message(): string {
		return `${draftStepText[this.step]}: ${this.error.message}`
	}
}

/** Why a `grizzle` command stopped before the apply runner, or outside it. */
const CliReasonSchema = Schema.Union([
	ArgumentsRefused,
	MigrationNameRefused,
	SchemaChoiceRefused,
	ConfigMissing,
	ConfigUnloaded,
	ExportRefused,
	SettingRefused,
	SchemaEntryRefused,
	LoginEntryRefused,
	ConnectionRefused,
	ConnectionUnnamed,
	EnvironmentUnread,
	DatabaseUrlRefused,
	CaRefused,
	CaUnread,
	TreeRefused,
	TreeUnread,
	FolderExists,
	FolderUnwritten,
	SnapshotUnwritten,
	MigrationsUnread,
	SkillUninstalled,
	SnapshotUnreadable,
	SnapshotForeign,
	ChainRefused,
	DraftRefused
])
type CliReason = typeof CliReasonSchema.Type

/** The stage each reason stops at. */
const stageOf: { readonly [Tag in CliReason["_tag"]]: CliStage } = {
	ArgumentsRefused: "usage",
	MigrationNameRefused: "usage",
	SchemaChoiceRefused: "usage",
	ConfigMissing: "config",
	ConfigUnloaded: "config",
	ExportRefused: "config",
	SettingRefused: "config",
	SchemaEntryRefused: "config",
	LoginEntryRefused: "config",
	ConnectionRefused: "config",
	ConnectionUnnamed: "config",
	EnvironmentUnread: "config",
	DatabaseUrlRefused: "config",
	CaRefused: "config",
	CaUnread: "config",
	TreeRefused: "filesystem",
	TreeUnread: "filesystem",
	FolderExists: "filesystem",
	FolderUnwritten: "filesystem",
	SnapshotUnwritten: "filesystem",
	MigrationsUnread: "filesystem",
	SkillUninstalled: "filesystem",
	SnapshotUnreadable: "snapshot",
	SnapshotForeign: "snapshot",
	ChainRefused: "snapshot",
	DraftRefused: "generate"
}

/**
 * A `grizzle` command stopped for `reason`, at the stage that reason stops at; its message names the stage, the
 * declared schema the reason concerns, if any, and the reason's own message.
 */
export class CliError extends Schema.TaggedError<CliError, { readonly brand: unique symbol }>()(
	"CliError",
	{
		reason: CliReasonSchema
	}
) {
	get stage(): CliStage {
		return stageOf[this.reason._tag]
	}

	/** The declared schema the reason concerns: none for the command line, the configuration or the connection. */
	get schema(): string | undefined {
		const reason = this.reason
		return "schema" in reason ? reason.schema : undefined
	}

	override get message(): string {
		const schema = this.schema
		return `${this.stage === "usage" ? "usage error" : `refused at stage ${this.stage}`}${schema === undefined ? "" : ` (schema ${schema})`}: ${this.reason.message}`
	}
}

/** The CliError of `reason`. */
export const cliError = (reason: CliReason): CliError => CliError.make({ reason })
