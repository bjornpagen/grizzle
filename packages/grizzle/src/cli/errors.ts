import { Array as Arr, type Config, Data, Formatter } from "effect"
import type { ConnectionEnvironmentRefused } from "#adapter/errors/failures.ts"
import { type CompileError, compileReasonText, isCompileError } from "#compiler/core/errors.ts"
import { maxMigrationNameLength, metaFileName } from "#compiler/deploy/render/folder.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"

/**
 * The failure of a `grizzle` command outside the apply runner.
 *
 * The apply runner fails with its own MigrateError (adapter/migrate/errors.ts), whose stage says what the database
 * holds. Everything the command line itself refuses is a CliError, whose classified case is its `reason`: one of the
 * classes here, each a Data.TaggedError carrying exactly what was refused and rendering its own `message`. What
 * follows from a reason is a getter of the error, never a stored field: the stage it stopped at, and the declared
 * schema it concerns. The stages:
 *
 * - `usage`: the command line does not name one of the commands, or names it with a malformed argument, a migration
 *   name of no folder's shape, or a schema choice the configuration does not allow;
 * - `config`: grizzle.config.ts is missing, fails to load, or is not a configuration (config.ts), or migrate finds no
 *   connection it accepts, or a process environment that would send a startup variable at its sessions (connection.ts);
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
 * The operating system's error code a file system failure carries, as a refusal names it, or nothing. The failure is
 * the platform's, an Error whose own cause is the operating system's error; Effect's PlatformError is one, an unstable
 * API a reason does not name.
 */
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
type SchemaNames = { readonly declared: string; readonly ident: string }

const schemaListText = (schemas: ReadonlyArray<SchemaNames>): string =>
	Arr.join(
		Arr.map(schemas, (s) => (s.declared === s.ident ? s.declared : `${s.declared} (${s.ident})`)),
		", "
	)

/** The commands of the command line. */
type CommandName = "generate" | "check" | "migrate" | "drift" | "names" | "skill"

/** The flags of `grizzle generate`, and those that take a value. */
type Flag = "custom" | "name" | "schema"
type ValuedFlag = "name" | "schema"

/**
 * How a command line fails to parse: its command is none of them, a command takes no argument it was given, an option
 * of generate is unknown, a flag is given twice, or a valued flag has no value.
 */
type ArgumentFault =
	| { readonly kind: "unknownCommand"; readonly command: string }
	| {
			readonly kind: "unexpectedArgument"
			readonly command: CommandName
			readonly argument: string
	  }
	| { readonly kind: "unknownOption"; readonly option: string }
	| { readonly kind: "repeatedFlag"; readonly flag: Flag }
	| { readonly kind: "flagWithoutValue"; readonly flag: ValuedFlag }

/** The command line does not parse, for `fault` (args.ts). */
export class ArgumentsRefused extends Data.TaggedError("ArgumentsRefused")<{
	readonly fault: ArgumentFault
}> {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "unknownCommand":
				return `unknown command ${Formatter.format(fault.command)}; the commands are generate, check, migrate, drift, names and skill`
			case "unexpectedArgument":
				return fault.command === "generate"
					? `grizzle generate takes no argument, not ${Formatter.format(fault.argument)}; name the migration with --name`
					: `grizzle ${fault.command} takes no argument, not ${Formatter.format(fault.argument)}`
			case "unknownOption":
				return `unknown option ${Formatter.format(fault.option)}`
			case "repeatedFlag":
				return `--${fault.flag} is given twice`
			case "flagWithoutValue":
				return `--${fault.flag} needs a value`
		}
	}
}

/** The migration name `--name` gives, `migration`, or a custom folder's, is not of a folder name's shape. */
export class MigrationNameRefused extends Data.TaggedError("MigrationNameRefused")<{
	readonly migration: string
}> {
	override get message(): string {
		return `migration name ${Formatter.format(this.migration)} is not lowercase ASCII letters and digits joined by _ or -, at most ${maxMigrationNameLength} characters`
	}
}

/**
 * The schema generate applies to cannot be chosen: `--schema` given while the configuration declares one schema,
 * `--schema` naming none of the configured `schemas`, or a custom migration without `--schema` while the configuration
 * declares several.
 */
type SchemaChoiceFault =
	| { readonly kind: "single" }
	| {
			readonly kind: "unknown"
			readonly named: string
			readonly schemas: ReadonlyArray<SchemaNames>
	  }
	| { readonly kind: "unchosen"; readonly schemas: ReadonlyArray<SchemaNames> }

export class SchemaChoiceRefused extends Data.TaggedError("SchemaChoiceRefused")<{
	readonly fault: SchemaChoiceFault
}> {
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
export class ConfigMissing extends Data.TaggedError("ConfigMissing")<{
	readonly directory: string
}> {
	override get message(): string {
		return `no ${configFileName} in ${this.directory}; grizzle reads its configuration from the directory it runs in`
	}
}

/** grizzle.config.ts could not be found or imported: `cause` is what its import, or the file system, threw. */
export class ConfigUnloaded extends Data.TaggedError("ConfigUnloaded")<{
	readonly cause: unknown
}> {
	override get message(): string {
		return `${configFileName} failed to load: ${thrownText(this.cause)}`
	}
}

/** grizzle.config.ts has no default export, or its default export is no object, or no object defineConfig built. */
export class ExportRefused extends Data.TaggedError("ExportRefused")<{
	readonly fault: "missing" | "notAnObject" | "notDefined"
}> {
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
type ReadSetting = "schemas" | "logins" | "migrations"

const malformedSettingText: Readonly<Record<ReadSetting, string>> = {
	schemas: "schemas must be a nonempty list of the declared schema values to migrate",
	logins:
		"logins must be a list of the login values whose roles the migrations install, and whose workloads plan its indexes",
	migrations: "migrations must be a nonempty directory path when given"
}

/** A setting no configuration has (`unknown`), or one whose value is not of its kind (`malformed`). */
type SettingFault =
	| { readonly kind: "unknown"; readonly setting: string }
	| { readonly kind: "malformed"; readonly setting: ReadSetting }

export class SettingRefused extends Data.TaggedError("SettingRefused")<{
	readonly fault: SettingFault
}> {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "unknown":
				return `${configFileName} has no setting ${Formatter.format(fault.setting)}; its settings are ${Arr.join(configSettings, ", ")}`
			case "malformed":
				return malformedSettingText[fault.setting]
		}
	}
}

/**
 * `schemas[index]` is no schema value, does not compile, or is installed in the PostgreSQL schema `ident` of the
 * declared schema `other`, listed before it.
 */
type SchemaEntryFault =
	| { readonly kind: "notBuilt" }
	| { readonly kind: "uncompiled"; readonly error: CompileError }
	| {
			readonly kind: "shared"
			readonly name: string
			readonly other: string
			readonly ident: string
	  }

export class SchemaEntryRefused extends Data.TaggedError("SchemaEntryRefused")<{
	readonly index: number
	readonly fault: SchemaEntryFault
}> {
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
type NameHolder =
	| { readonly kind: "login"; readonly name: string }
	| { readonly kind: "role"; readonly name: string; readonly login: string }

/**
 * `logins[index]` is no login value, does not compile, is over a schema `schemas` does not list or over another version
 * of one it does, or names a login or role (`name`) alike to a name another login or role of its schema holds: their
 * segments agree, so both would be the one PostgreSQL role `<schema>__<conversion>`.
 */
type LoginEntryFault =
	| { readonly kind: "notBuilt" }
	| { readonly kind: "uncompiled"; readonly error: CompileError }
	| { readonly kind: "unlisted"; readonly login: string; readonly schema: string }
	| { readonly kind: "otherVersion"; readonly login: string; readonly schema: string }
	| {
			readonly kind: "nameTaken"
			readonly login: string
			readonly name: string
			readonly holder: NameHolder
			readonly schema: string
	  }

export class LoginEntryRefused extends Data.TaggedError("LoginEntryRefused")<{
	readonly index: number
	readonly fault: LoginEntryFault
}> {
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
export class ConnectionRefused extends Data.TaggedError("ConnectionRefused")<{
	readonly detail: string
}> {
	override get message(): string {
		return this.detail
	}
}

/** Neither the configuration nor DATABASE_URL says where grizzle migrate connects. */
export class ConnectionUnnamed extends Data.TaggedError("ConnectionUnnamed") {
	override get message(): string {
		return "grizzle migrate needs DATABASE_URL=postgresql://<role>[:<password>]@<host>[:<port>]/<database>, or a connection in grizzle.config.ts"
	}
}

/** The ConfigProvider could not read the environment variable `variable`, for `cause`. */
export class EnvironmentUnread extends Data.TaggedError("EnvironmentUnread")<{
	readonly variable: string
	readonly cause: Config.ConfigError
}> {
	override get message(): string {
		return `the environment variable ${this.variable} could not be read: ${this.cause.message}`
	}
}

/**
 * How DATABASE_URL is refused, never quoting it: it is no URL, its protocol is not postgresql:// or postgres://, it has
 * a fragment, a part's percent-encoding is malformed, it names no role, host or database, its port is 0, or it asks for
 * an sslmode other than verify-full or has a parameter other than sslmode and sslrootcert.
 */
type UrlFault =
	| { readonly kind: "notUrl" }
	| { readonly kind: "protocol"; readonly protocol: string }
	| { readonly kind: "fragment" }
	| { readonly kind: "encoding"; readonly part: "role" | "password" | "host" | "database" }
	| { readonly kind: "noRole" }
	| { readonly kind: "noHost" }
	| { readonly kind: "port"; readonly port: number }
	| { readonly kind: "noDatabase" }
	| { readonly kind: "sslmode"; readonly mode: string }
	| { readonly kind: "parameter"; readonly parameter: string }

export class DatabaseUrlRefused extends Data.TaggedError("DatabaseUrlRefused")<{
	readonly fault: UrlFault
}> {
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
				return `DATABASE_URL has the parameter ${Formatter.format(fault.parameter)}; its parameters are sslmode and sslrootcert`
		}
	}
}

/** Where a CA file is named: DATABASE_URL's `sslrootcert` parameter, or the PGSSLROOTCERT variable. */
type CaSource = "sslrootcert" | "PGSSLROOTCERT"

const caSourceText = (source: CaSource): string =>
	source === "sslrootcert" ? "DATABASE_URL's sslrootcert" : "PGSSLROOTCERT"

/** The CA file `source` names, `file`, does not exist (`missing`) or holds no certificate (`empty`). */
export class CaRefused extends Data.TaggedError("CaRefused")<{
	readonly source: CaSource
	readonly file: string
	readonly fault: "missing" | "empty"
}> {
	override get message(): string {
		return `${caSourceText(this.source)} names ${this.file}, which ${this.fault === "missing" ? "does not exist" : "holds no certificate"}`
	}
}

/** The CA file `source` names, `file`, could not be read, for `cause`. */
export class CaUnread extends Data.TaggedError("CaUnread")<{
	readonly source: CaSource
	readonly file: string
	readonly cause: Error
}> {
	override get message(): string {
		return `${caSourceText(this.source)} names ${this.file}, which could not be read${codeOf(this.cause)}`
	}
}

/**
 * The migrations directory of `schema` holds what no generator writes: `directory`, its directory, is no directory; it
 * holds `entry`, neither snapshot.json nor a migration folder; or the migration folder at `folder` has no meta.json, or
 * holds `entry`, which is no file.
 */
type TreeFault =
	| { readonly kind: "notDirectory"; readonly directory: string }
	| { readonly kind: "strayEntry"; readonly directory: string; readonly entry: string }
	| { readonly kind: "noMeta"; readonly folder: string }
	| { readonly kind: "notAFile"; readonly folder: string; readonly entry: string }

export class TreeRefused extends Data.TaggedError("TreeRefused")<{
	readonly schema: string
	readonly fault: TreeFault
}> {
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
export class TreeUnread extends Data.TaggedError("TreeUnread")<{
	readonly schema: string
	readonly directory: string
	readonly cause: Error
}> {
	override get message(): string {
		return `${this.directory} could not be read${codeOf(this.cause)}`
	}
}

/** A drafted folder of `schema` would be written at `path`, which exists: a migration folder is never overwritten. */
export class FolderExists extends Data.TaggedError("FolderExists")<{
	readonly schema: string
	readonly path: string
}> {
	override get message(): string {
		return `${this.path} already exists; a migration folder is never overwritten`
	}
}

/** The migration folder `folder` of `schema` could not be written, for `cause`. */
export class FolderUnwritten extends Data.TaggedError("FolderUnwritten")<{
	readonly schema: string
	readonly folder: string
	readonly cause: Error
}> {
	override get message(): string {
		return `migration folder ${this.folder} could not be written${codeOf(this.cause)}`
	}
}

/** The snapshot.json of `schema` could not be written, for `cause`. */
export class SnapshotUnwritten extends Data.TaggedError("SnapshotUnwritten")<{
	readonly schema: string
	readonly cause: Error
}> {
	override get message(): string {
		return `${snapshotFileName} of ${this.schema} could not be written${codeOf(this.cause)}`
	}
}

/**
 * The migrations directory, `directory`, could not be read for the schemas a first draft abandons, for `cause`; it
 * concerns no one schema.
 */
export class MigrationsUnread extends Data.TaggedError("MigrationsUnread")<{
	readonly directory: string
	readonly cause: Error
}> {
	override get message(): string {
		return `${this.directory} could not be read${codeOf(this.cause)}`
	}
}

/** grizzle skill could not read the skill it ships, or write it, for `cause`. */
export class SkillUninstalled extends Data.TaggedError("SkillUninstalled")<{
	readonly cause: Error
}> {
	override get message(): string {
		return `the skill could not be installed${codeOf(this.cause)}`
	}
}

/** The snapshot.json of `schema` in `directory` does not decode as a snapshot, for `error`. */
export class SnapshotUnreadable extends Data.TaggedError("SnapshotUnreadable")<{
	readonly schema: string
	readonly directory: string
	readonly error: CompileError
}> {
	override get message(): string {
		return `${this.directory}/snapshot.json is not a snapshot the generator wrote: ${compileReasonText(this.error.reason)}`
	}
}

/**
 * The snapshot.json in `directory` is the snapshot of another schema: of the declared schema `found.schemaName` in the
 * PostgreSQL schema `found.schema`, not of `schema` in `ident`.
 */
export class SnapshotForeign extends Data.TaggedError("SnapshotForeign")<{
	readonly schema: string
	readonly ident: string
	readonly directory: string
	readonly found: { readonly schemaName: string; readonly schema: string }
}> {
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
export type ChainFault =
	| { readonly kind: "unreadableMeta"; readonly folder: string; readonly failure: CompileError }
	| { readonly kind: "foreignMeta"; readonly folder: string; readonly schema: string }
	| { readonly kind: "brokenChain"; readonly folder: string }

/**
 * Why a draft cannot continue a schema's committed chain: a folder not named `<YYYYMMDDHHMMSS>_<name>` (`misnamed`), a
 * ChainFault, or a whole chain that does not reach snapshot.json's fingerprint `snapshot`: no folder at all
 * (`unreached`), or a newest folder reaching `reached` (`diverged`).
 */
export type ChainBreak =
	| { readonly kind: "misnamed"; readonly folder: string }
	| ChainFault
	| { readonly kind: "unreached"; readonly snapshot: string }
	| {
			readonly kind: "diverged"
			readonly folder: string
			readonly reached: string
			readonly snapshot: string
	  }

/** The committed chain of `schema`, installed in `ident`, in `directory`, breaks at `fault`. */
export class ChainRefused extends Data.TaggedError("ChainRefused")<{
	readonly schema: string
	readonly ident: string
	readonly directory: string
	readonly fault: ChainBreak
}> {
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
type DraftStep = "workload" | "schema" | "draft" | "custom"

const draftStepText: Readonly<Record<DraftStep, string>> = {
	workload: "a login's workload does not compile",
	schema: "the schema does not compile",
	draft: "the migration could not be drafted",
	custom: "the custom migration could not be created"
}

/** The compiler refused `step` of the draft of `schema`, for `error`. */
export class DraftRefused extends Data.TaggedError("DraftRefused")<{
	readonly schema: string
	readonly step: DraftStep
	readonly error: CompileError
}> {
	override get message(): string {
		return `${draftStepText[this.step]}: ${this.error.message}`
	}
}

/** Why a `grizzle` command stopped before the apply runner, or outside it. */
type CliReason =
	| ArgumentsRefused
	| MigrationNameRefused
	| SchemaChoiceRefused
	| ConfigMissing
	| ConfigUnloaded
	| ExportRefused
	| SettingRefused
	| SchemaEntryRefused
	| LoginEntryRefused
	| ConnectionRefused
	| ConnectionUnnamed
	| EnvironmentUnread
	| ConnectionEnvironmentRefused
	| DatabaseUrlRefused
	| CaRefused
	| CaUnread
	| TreeRefused
	| TreeUnread
	| FolderExists
	| FolderUnwritten
	| SnapshotUnwritten
	| MigrationsUnread
	| SkillUninstalled
	| SnapshotUnreadable
	| SnapshotForeign
	| ChainRefused
	| DraftRefused

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
	ConnectionEnvironmentRefused: "config",
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
export class CliError extends Data.TaggedError("CliError")<{ readonly reason: CliReason }> {
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
export const cliError = (reason: CliReason): CliError => new CliError({ reason })
