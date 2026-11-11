import { Array as Arr, Data, Formatter, Redacted, Result } from "effect"
import { readHost } from "#adapter/engine.ts"
import {
	type ConnectionEnvironmentRefused,
	type SettingFault as ConnectionSettingFault,
	settingFaultText
} from "#adapter/errors/failures.ts"
import type { WorkloadPlace } from "#adapter/served/compile.ts"
import type { DeclarationRefused } from "#cli/renames.ts"
import type { FamilyId } from "#compiler/plan/change.ts"
import {
	type CompileError,
	compileReasonText,
	isCompileError,
	nominal
} from "#compiler/plan/common.ts"
import {
	maxMigrationNameLength,
	metaFileName,
	type UnservedMember,
	type UnservedReason
} from "#compiler/plan/migration.ts"
import { manifestFileName, snapshotFileName } from "#compiler/plan/serve.ts"

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
 *   name of no folder's shape, a rename or drop its text shows wrong, or a schema choice the configuration does not
 *   allow;
 * - `config`: the configuration file the command names is missing, fails to load, or is not a configuration
 *   (config.ts), or migrate and drift refuse its connection (connection.ts);
 * - `environment`: migrate and drift refuse the process environment grizzle runs in, which sets a startup variable pg
 *   would send at their sessions' startup (connection.ts ownerEnvironment);
 * - `filesystem`: the migrations directory could not be read or written, or holds what no generator wrote;
 * - `snapshot`: a schema's committed snapshot.json is not the generator's (edited, or of another schema), or it and the
 *   schema's folders disagree, so neither a draft nor an apply could continue the chain;
 * - `codes`: a roster declares its handles out of the order of the codes the committed snapshot records for them, so
 *   no draft could keep every stored code's meaning;
 * - `generate`: the compiler refused the schema, its logins' workloads or the draft, or a login's served workload.
 *
 * Every refusal happens before anything is written: a generate writes no folder of any schema until every configured
 * schema has drafted, and an apply hands nothing to the runner until every schema's directory reads.
 *
 * A failure underneath is grizzle's own classified value where it is one (a CompileError); a foreign value is held as
 * a Thrown: what importing the configuration file threw, or the platform's file system failure, and what the
 * configuration's connection threw. Nothing a CliError reports carries a credential, a connection password or a stored
 * value: the configuration is named by its keys, its connection by the setting the connection parser refuses, a thrown
 * value by its name and message alone, and the compiler's diagnostics carry source locations and capabilities only.
 */
export type CliStage =
	| "usage"
	| "config"
	| "environment"
	| "filesystem"
	| "snapshot"
	| "codes"
	| "generate"

/**
 * The operating system's error code a file system failure carries, as a refusal names it, or nothing. The failure is
 * the platform's, an Error whose own cause is the operating system's error; Effect's PlatformError is one, an unstable
 * API a reason does not name.
 */
const codeOf = (failure: Error): string => {
	const os = failure.cause
	return Error.isError(os) && "code" in os && typeof os.code === "string" ? ` (${os.code})` : ""
}

declare const thrownBrand: unique symbol

/**
 * What a refusal states of a thrown value, as values (saidOf): a CompileError a builder threw by its message (its reason,
 * location and sentence); any other Error by its name and message; an Error whose name or message throws when read, or
 * is no text, as unreadable; and a value that is no Error by nothing of its content, which is data, not a message, and
 * may hold a credential. A Redacted value an Error's message interpolates reads as its own rendering, `<redacted>`.
 */
export type Said =
	| { readonly kind: "compileError"; readonly message: string }
	| { readonly kind: "error"; readonly name: string; readonly message: string }
	| { readonly kind: "unreadable" }
	| { readonly kind: "noError" }

/**
 * What the application's code threw, read once where it was caught (thrownOf): the value itself, `cause`, held Redacted,
 * so no rendering of a refusal (its message, Formatter, inspect, JSON) shows any of its data, and `said`, what a refusal
 * states of it. Only thrownOf mints one, so a refusal never states what it did not read off its own cause.
 */
export interface Thrown {
	readonly cause: Redacted.Redacted<unknown>
	readonly said: Said
	readonly [thrownBrand]: true
}

/** The parts of a Thrown, which thrownOf alone brands. */
interface ThrownParts {
	readonly cause: Redacted.Redacted<unknown>
	readonly said: Said
}

const unreadable: Said = { kind: "unreadable" }

/** What a refusal states of `thrown` (Said), its name and message read once each. */
const saidOf = (thrown: unknown): Said => {
	if (isCompileError(thrown)) {
		const message: unknown = thrown.message
		return typeof message === "string" ? { kind: "compileError", message } : unreadable
	}
	if (Error.isError(thrown)) {
		const name: unknown = thrown.name
		const message: unknown = thrown.message
		return typeof name === "string" && typeof message === "string"
			? { kind: "error", name, message }
			: unreadable
	}
	return { kind: "noError" }
}

/** A Said as a refusal's message states it. */
const saidText = (said: Said): string => {
	switch (said.kind) {
		case "compileError":
			return `CompileError ${said.message}`
		case "error":
			return `${said.name}: ${said.message}`
		case "unreadable":
			return "an Error whose name or message is no text, or throws when read"
		case "noError":
			return "a value that is no Error, whose content no refusal quotes"
	}
}

/**
 * The Thrown of `thrown`, read once at the boundary (adapter/engine.ts readHost): its name and message read now, once,
 * so a getter that answers otherwise later, or throws, meets nothing that reads it again; an Error whose reading throws
 * is said to be unreadable.
 */
export const thrownOf = (thrown: unknown): Thrown =>
	nominal<ThrownParts, Thrown>()({
		cause: Redacted.make(thrown),
		said: Result.merge(readHost(unreadable, () => Result.succeed(saidOf(thrown))))
	})

/** A configured schema as a refusal names it: its declared name, with its PostgreSQL schema when the two differ. */
type SchemaNames = { readonly declared: string; readonly ident: string }

const schemaListText = (schemas: ReadonlyArray<SchemaNames>): string =>
	Arr.join(
		Arr.map(schemas, (s) => (s.declared === s.ident ? s.declared : `${s.declared} (${s.ident})`)),
		", "
	)

/** The commands of the command line. */
export type CommandName = "generate" | "check" | "migrate" | "drift" | "names"

/**
 * The flags of `grizzle generate`: its switches, the flags that take a value once, and the flags that take one each
 * time they are given, a declaration each (renames.ts).
 */
export const generateFlags = {
	switches: ["custom"],
	valued: ["name", "schema"],
	repeated: ["rename", "drop"]
} as const
export type SwitchFlag = (typeof generateFlags.switches)[number]
export type ValuedFlag = (typeof generateFlags.valued)[number]
export type RepeatedFlag = (typeof generateFlags.repeated)[number]
type Flag = SwitchFlag | ValuedFlag

/**
 * How a command line fails to parse: its command is none of them; a command is given no configuration file, or an
 * argument besides it; an option is not one its command takes; a flag is given twice; a valued flag has no value; or a
 * custom migration has no name.
 */
type ArgumentFault =
	| { readonly kind: "unknownCommand"; readonly command: string }
	| { readonly kind: "noConfig"; readonly command: CommandName }
	| {
			readonly kind: "unexpectedArgument"
			readonly command: CommandName
			readonly argument: string
	  }
	| { readonly kind: "unknownOption"; readonly command: CommandName; readonly option: string }
	| { readonly kind: "repeatedFlag"; readonly flag: Flag }
	| { readonly kind: "flagWithoutValue"; readonly flag: ValuedFlag | RepeatedFlag }
	| { readonly kind: "unnamedCustom" }

/** The command line does not parse, for `fault` (args.ts). */
export class ArgumentsRefused extends Data.TaggedError("ArgumentsRefused")<{
	readonly fault: ArgumentFault
}> {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "unknownCommand":
				return `unknown command ${Formatter.format(fault.command)}; the commands are generate, check, migrate, drift and names`
			case "noConfig":
				return `grizzle ${fault.command} needs the configuration file as its argument: grizzle ${fault.command} <config>`
			case "unexpectedArgument":
				return fault.command === "generate"
					? `grizzle generate takes one argument, the configuration file, not also ${Formatter.format(fault.argument)}; name the migration with --name`
					: `grizzle ${fault.command} takes one argument, the configuration file, not also ${Formatter.format(fault.argument)}`
			case "unknownOption":
				return fault.command === "generate"
					? `unknown option ${Formatter.format(fault.option)}; grizzle generate takes --custom, --name, --schema, --rename and --drop`
					: `grizzle ${fault.command} takes no option, not ${Formatter.format(fault.option)}`
			case "repeatedFlag":
				return `--${fault.flag} is given twice`
			case "flagWithoutValue":
				return `--${fault.flag} needs a value`
			case "unnamedCustom":
				return "grizzle generate --custom needs --name: a custom migration is named by its data step"
		}
	}
}

/** The migration name `--name` gives, `migration`, is not of a folder name's shape (args.ts). */
export class MigrationNameRefused extends Data.TaggedError("MigrationNameRefused")<{
	readonly migration: string
}> {
	override get message(): string {
		return `migration name ${Formatter.format(this.migration)} is not lowercase ASCII letters and digits joined by _ or -, at most ${maxMigrationNameLength.value} characters`
	}
}

/**
 * The schema generate applies to cannot be chosen: `--schema` given while the configuration declares one schema,
 * `--schema` naming none of the configured `schemas`, or, while the configuration declares several, a custom migration
 * or a draft that declares renames or drops, each one schema's, without `--schema`.
 */
type SchemaChoiceFault =
	| { readonly kind: "single" }
	| {
			readonly kind: "unknown"
			readonly named: string
			readonly schemas: ReadonlyArray<SchemaNames>
	  }
	| {
			readonly kind: "unchosen"
			readonly by: "custom" | "declarations"
			readonly schemas: ReadonlyArray<SchemaNames>
	  }

export class SchemaChoiceRefused extends Data.TaggedError("SchemaChoiceRefused")<{
	readonly fault: SchemaChoiceFault
}> {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "single":
				return "--schema is accepted only when the configuration declares several schemas; it declares one"
			case "unknown":
				return `--schema ${fault.named} names no configured schema; the configuration declares ${schemaListText(fault.schemas)}`
			case "unchosen":
				return `${fault.by === "custom" ? "a custom migration is a folder of one schema" : "--rename and --drop declare one schema's changes"}, and the configuration declares ${schemaListText(fault.schemas)}; name one with --schema`
		}
	}
}

/** The configuration file the command names, `file`, does not exist. */
export class ConfigMissing extends Data.TaggedError("ConfigMissing")<{
	readonly file: string
}> {
	override get message(): string {
		return `${this.file} does not exist; name the configuration file as the command's argument, absolute or relative to the directory grizzle runs in`
	}
}

/** The configuration file `file` could not be imported: `thrown` is what its import, or the file system, threw. */
export class ConfigUnloaded extends Data.TaggedError("ConfigUnloaded")<{
	readonly file: string
	readonly thrown: Thrown
}> {
	override get message(): string {
		return `${this.file} failed to load: ${saidText(this.thrown.said)}`
	}
}

/**
 * The configuration file `file` has no default export, or its default export is no object, or no object defineConfig
 * built.
 */
export class ExportRefused extends Data.TaggedError("ExportRefused")<{
	readonly file: string
	readonly fault: "missing" | "notAnObject" | "notDefined"
}> {
	override get message(): string {
		switch (this.fault) {
			case "missing":
				return `${this.file} has no default export; export the configuration as default`
			case "notAnObject":
				return `the default export of ${this.file} must be a configuration object`
			case "notDefined":
				return `the default export of ${this.file} must be built by defineConfig, imported from @bjornpagen/grizzle: export default defineConfig({ schemas: [...], logins: [...], migrations: "...", connection: { ... } })`
		}
	}
}

/** The settings of a configuration, in the order a refusal lists them; each is required. */
export const configSettings = ["schemas", "logins", "migrations", "connection"] as const

/**
 * The settings whose value the configuration reads itself; `connection` is a function migrate and drift call and
 * check the result of, so the configuration refuses only a connection that is no function.
 */
type ReadSetting = "schemas" | "logins" | "migrations"

const malformedSettingText: Readonly<Record<ReadSetting, string>> = {
	schemas: "schemas must be a nonempty list of the declared schema values to migrate",
	logins:
		"logins must be a list of the login values whose roles the migrations install, and whose workloads plan its indexes",
	migrations:
		"migrations must be a nonempty path of the migrations directory, absolute or relative to the configuration file's directory"
}

/**
 * A setting no configuration has (`unknown`), one whose value is not of its kind (`malformed`), or the connection
 * not given as a function (`unconnected`).
 */
type SettingFault =
	| { readonly kind: "unknown"; readonly setting: string }
	| { readonly kind: "malformed"; readonly setting: ReadSetting }
	| { readonly kind: "unconnected" }

export class SettingRefused extends Data.TaggedError("SettingRefused")<{
	readonly fault: SettingFault
}> {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "unknown":
				return `the configuration has no setting ${Formatter.format(fault.setting)}; its settings are ${Arr.join(configSettings, ", ")}`
			case "malformed":
				return malformedSettingText[fault.setting]
			case "unconnected":
				return "connection must be a function returning where grizzle migrate and grizzle drift connect, as the role that owns the schemas"
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
				return `${at} (${fault.name}) and ${fault.other} are both installed over the root schema ${fault.ident}; an installation is listed once, by its top level, which installs every level below it in one migrations directory, snapshot and ledger`
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
 * The configuration's `connection` is refused: the setting the connection parser refuses and the rule it breaks
 * (adapter/connection/config.ts parseConnection, SettingFault), as a DbConfig's is, never a value.
 */
export class ConnectionRefused extends Data.TaggedError(
	"ConnectionRefused"
)<ConnectionSettingFault> {
	override get message(): string {
		return settingFaultText(this)
	}
}

/**
 * The configuration's `connection` threw instead of returning where `grizzle migrate` and `grizzle drift` connect:
 * `thrown` is what it threw, its cause held Redacted, and the refusal states its name and message (Thrown).
 */
export class ConnectionThrew extends Data.TaggedError("ConnectionThrew")<{
	readonly thrown: Thrown
}> {
	override get message(): string {
		return `connection threw ${saidText(this.thrown.said)}; it must return where grizzle migrate and grizzle drift connect`
	}
}

/**
 * The migrations directory of `schema` holds what no generator writes: `directory`, its directory, is no directory; it
 * holds `entry`, neither a snapshot file, the served directory nor a migration folder; its served directory, `directory`,
 * holds `entry`, no file named `<login>.json`; it holds one of the snapshot's two files, `present`, without the other,
 * `missing`, which generate writes together; or the migration folder at `folder` has no meta.json, or holds `entry`,
 * which is no file.
 */
type TreeFault =
	| { readonly kind: "notDirectory"; readonly directory: string }
	| { readonly kind: "strayEntry"; readonly directory: string; readonly entry: string }
	| { readonly kind: "strayServed"; readonly directory: string; readonly entry: string }
	| {
			readonly kind: "halfSnapshot"
			readonly directory: string
			readonly present: string
			readonly missing: string
	  }
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
				return `${fault.directory} holds ${fault.entry}, which is neither ${snapshotFileName}, ${manifestFileName}, the served directory nor a migration folder`
			case "strayServed":
				return `${fault.directory} holds ${fault.entry}, which is no file named <login>.json; grizzle generate writes one per login`
			case "halfSnapshot":
				return `${fault.directory} holds ${fault.present} without ${fault.missing}; grizzle generate writes the two together, so restore ${fault.missing} from version control`
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

/** The snapshot's files of `schema`, snapshot.json and manifest.json, could not be written, for `cause`. */
export class SnapshotUnwritten extends Data.TaggedError("SnapshotUnwritten")<{
	readonly schema: string
	readonly cause: Error
}> {
	override get message(): string {
		return `${snapshotFileName} and ${manifestFileName} of ${this.schema} could not be written${codeOf(this.cause)}`
	}
}

/** The served files of `schema` could not be written or removed, for `cause`. */
export class ServedUnwritten extends Data.TaggedError("ServedUnwritten")<{
	readonly schema: string
	readonly cause: Error
}> {
	override get message(): string {
		return `the served files of ${this.schema} could not be written${codeOf(this.cause)}`
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

/** The snapshot.json and manifest.json of `schema` in `directory` do not decode as a snapshot, for `error`. */
export class SnapshotUnreadable extends Data.TaggedError("SnapshotUnreadable")<{
	readonly schema: string
	readonly directory: string
	readonly error: CompileError
}> {
	override get message(): string {
		return `${this.directory}/${snapshotFileName} and ${manifestFileName} are not a snapshot the generator wrote: ${compileReasonText(this.error.reason)}`
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

/**
 * Roster `roster` of `schema` declares `earlier` before `later`, but the committed snapshot records the lower code for
 * `later` (ir/codes.ts RosterReordered). A stored code never changes meaning, so a roster's order, its comparison
 * order, is its codes' order, and no draft can reorder it: a new handle goes after every handle declared before it.
 */
export class RosterReordered extends Data.TaggedError("RosterReordered")<{
	readonly schema: string
	readonly roster: string
	readonly earlier: string
	readonly later: string
}> {
	override get message(): string {
		return `roster ${this.roster} declares ${Formatter.format(this.earlier)} before ${Formatter.format(this.later)}, whose code in snapshot.json is lower`
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

const workloadPlaceText = (place: WorkloadPlace): string => {
	switch (place.kind) {
		case "login":
			return ""
		case "role":
			return ` for role ${place.role}`
		case "program":
			return ` at program ${place.program} of role ${place.role}`
	}
}

/**
 * The compiler refused the workload of login `login` of `schema` at `place`, for `error`: the served file generate would
 * write for it (adapter/served/compile.ts), which its application serves, does not compile.
 */
export class ServedRefused extends Data.TaggedError("ServedRefused")<{
	readonly schema: string
	readonly login: string
	readonly place: WorkloadPlace
	readonly error: CompileError | UnservedMember
}> {
	override get message(): string {
		return `login ${this.login}'s workload does not compile${workloadPlaceText(this.place)}: ${servedRefusalText(this.error)}`
	}
}

/** Families as a refusal names them: each by its owner relation and count field. */
const familiesText = (families: ReadonlyArray<FamilyId>): string =>
	`${families.length === 1 ? "the family" : "the families"} ${Arr.join(
		Arr.map(families, (family) => `${family.owner}.${family.count}`),
		", "
	)}`

/** Why no served file can hold a workload ChangeSet: one reason's text, what is refused, the work it needs and what to
 * change where a declaration can (served/unserved.ts UnservedReason). */
const unservedReasonText = (reason: UnservedReason): string => {
	switch (reason.kind) {
		case "edit":
			return `stratum ${reason.stratum} edits ${reason.relation}, a member relation of ${familiesText(reason.families)}: each group it touches is rewritten from the group's stored suffix, which the host reads and fills before the write, and a served file holds no host fill`
		case "refill":
			return `stratum ${reason.stratum} refills ${familiesText(reason.families)}${reason.tree ? " through a tree" : ""}${reason.hops > 1 ? ` across ${reason.hops} owner hops` : ""}: their stale values are drawn again from the rows a read flight finds, which the host fills before the write, and a served file holds no host fill`
		case "nested":
			return `stratum ${reason.stratum} writes nested rows of ${familiesText(reason.families)}: the host walks each nested fact and fills those families' rows before the write, and a served file holds no host fill`
		case "stream":
			return `${reason.relation}'s Stream member (slot ${reason.slot}) supplies its facts as code, and a served call supplies arrays: give it an array member or a query member over parameters`
		case "opaqueBinding":
			return `the bound value ${reason.name} has no canonical text a served file can hold: bind a value of a declared type, or make it a parameter`
		case "repeated":
			return `two array members ${reason.op} ${reason.relation} in two strata (slots ${reason.slots[0]} and ${reason.slots[1]}): a call's facts hold one array for each op and relation, so merge them into one member`
	}
}

/** A served workload's refusal as a person reads it: a CompileError's message, or every reason no call can serve. */
const servedRefusalText = (error: CompileError | UnservedMember): string =>
	error._tag === "CompileError"
		? error.message
		: `a ChangeSet no served file can hold: ${Arr.join(Arr.map(error.reasons, unservedReasonText), "; ")}`

/** Why a `grizzle` command stopped before the apply runner, or outside it. */
type CliReason =
	| ArgumentsRefused
	| MigrationNameRefused
	| DeclarationRefused
	| SchemaChoiceRefused
	| ConfigMissing
	| ConfigUnloaded
	| ExportRefused
	| SettingRefused
	| SchemaEntryRefused
	| LoginEntryRefused
	| ConnectionRefused
	| ConnectionThrew
	| ConnectionEnvironmentRefused
	| TreeRefused
	| TreeUnread
	| FolderExists
	| FolderUnwritten
	| SnapshotUnwritten
	| ServedUnwritten
	| MigrationsUnread
	| SnapshotUnreadable
	| SnapshotForeign
	| ChainRefused
	| RosterReordered
	| DraftRefused
	| ServedRefused

/** The stage each reason stops at. */
const stageOf: { readonly [Tag in CliReason["_tag"]]: CliStage } = {
	ArgumentsRefused: "usage",
	MigrationNameRefused: "usage",
	DeclarationRefused: "usage",
	SchemaChoiceRefused: "usage",
	ConfigMissing: "config",
	ConfigUnloaded: "config",
	ExportRefused: "config",
	SettingRefused: "config",
	SchemaEntryRefused: "config",
	LoginEntryRefused: "config",
	ConnectionRefused: "config",
	ConnectionThrew: "config",
	ConnectionEnvironmentRefused: "environment",
	TreeRefused: "filesystem",
	TreeUnread: "filesystem",
	FolderExists: "filesystem",
	FolderUnwritten: "filesystem",
	SnapshotUnwritten: "filesystem",
	ServedUnwritten: "filesystem",
	MigrationsUnread: "filesystem",
	SnapshotUnreadable: "snapshot",
	SnapshotForeign: "snapshot",
	ChainRefused: "snapshot",
	RosterReordered: "codes",
	DraftRefused: "generate",
	ServedRefused: "generate"
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
