import { Array as Arr, Effect, Option, Record as Rec, Result, String as Str } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { applyOnSession } from "#adapter/migrate/apply.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { type MigrationSession, migrationSession } from "#adapter/migrate/session.ts"
import type { BatchStatement } from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import { nextTimestamp, parseTimestamp } from "#cli/clock.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Declarations, Named } from "#compiler/deploy/diff/plan.ts"
import { emptySnapshot, noWorkload, rosterFates } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { draftCodebook, noRenames, reorderRefusal } from "#compiler/ir/codes.ts"
import { isolationGuardName } from "#compiler/physical/ddl/isolation.ts"
import { roleIdentity, worldNames } from "#compiler/physical/ddl/names.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { AnySchema } from "#compiler/public/schema.ts"
import { type Owned, type OwnedRole, own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { CreatePolicy, CreateView, ObjectName, RoleSetting } from "#compiler/sql/ast.ts"
import { and, col, derived, lit, provedSelect, target } from "#compiler/sql/build.ts"
import { printStatement, quoteIdent, quoteString, storedSettingValue } from "#compiler/sql/print.ts"
import type { AmbientOwner } from "#test/support/ambient.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftedAt, fromSnapshot, generate, noDeclarations } from "#test/support/migrate/kit.ts"
import { review } from "#test/support/migrate/review.ts"
import { planRealInstall, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { type PgConnection, type SqlError, wireSession } from "#test/support/pg.ts"
import type { SubstrateShape } from "#test/support/substrate/substrate.ts"
import { buildInstall } from "#test/support/worlds/execute/build.ts"
import { sqlStateOf } from "#test/support/worlds/execute/observe.ts"
import { RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import type { Seen } from "#test/support/worlds/execute/session.ts"
import { refusedWith, seen } from "#test/support/worlds/execute/session.ts"
import type {
	CatalogPerturbation,
	FieldDomain,
	InstalledNames,
	InstallSpec,
	MigrationHow,
	MigrationRefusal,
	Observation,
	TriggerRef,
	WorldFunction
} from "#test/support/worlds/model/types.ts"

/**
 * The installation's catalog as the migration identity meets it: `grizzle drift`'s check of the applied folders, and a
 * perturbation of the catalog behind grizzle's back, made as the owner with the installation's own names.
 */
const refusals: ReadonlySet<string> = new Set([
	"edited",
	"ledger",
	"order",
	"marker",
	"decision",
	"drift"
])

const isRefusal = (stage: string): stage is MigrationRefusal => refusals.has(stage)

/**
 * A MigrateError as the observation of the refusal it is: drift, as the action that ran meets it (`drifted` of the
 * mismatches: a drift run's report, a migrate's refusal at stage drift); a file's statement PostgreSQL refused (a law the
 * data breaks, installed by its index or constraint), refused with its SQLSTATE; a refusal stage the model names; or a
 * defect for any other.
 */
export const migrationRefused = (
	error: MigrateError,
	drifted: (objects: ReadonlyArray<string>) => Observation
): Effect.Effect<Seen> => {
	const reason = error.reason
	if (reason._tag === "Drifted") {
		return Effect.succeed(seen(drifted(Arr.map(reason.mismatches, (m) => `${m.kind} ${m.fact}`))))
	}
	const server = error.server
	if (error.stage === "statement" && server.by === "server") {
		return Effect.succeed(
			refusedWith({ kind: "refused", sqlstate: sqlStateOf(server.error.sqlstate) }, error)
		)
	}
	return isRefusal(error.stage)
		? Effect.succeed(refusedWith({ kind: "migration-refused", stage: error.stage }, error))
		: Effect.die(
				new Error(`a migration failed at ${error.stage}, which no refusal names`, {
					cause: error
				})
			)
}

/** The folder a run stopped in when one of its files failed: a statement, its ledger record or its COMMIT. */
export const failedFolder = (error: MigrateError): Option.Option<string> => {
	const reason = error.reason
	switch (reason._tag) {
		case "StatementFailed":
		case "TransactionFailed":
		case "FileCommitRefused":
			return Option.some(reason.folder)
		case "LedgerUnlocked":
		case "RecordFailed":
		case "FileCommitLost":
			return Option.some(reason.at.folder)
		case "ConnectRefused":
		case "SurveyFailed":
		case "StackTooShallow":
		case "RoleUnread":
		case "OwnerUnread":
		case "OwnedByAnother":
		case "InputRefused":
		case "LockUnread":
		case "ApplyBusy":
		case "LedgerUncompiled":
		case "LedgerUnread":
		case "LedgerDamaged":
		case "AppliedEdited":
		case "FolderRefused":
		case "SnapshotUnreached":
		case "MarkersUnresolved":
		case "LossesUndecided":
		case "Drifted":
		case "DriftUnchecked":
			return Option.none()
	}
}

/**
 * The ledger record a killed deploy dies at: the row of one file of a folder. The deploy's connection ends as it sends
 * that record's transaction, so nothing of it commits.
 */
interface KillPoint {
	readonly folder: string
	readonly file: string
}

/** How a run of the migration runner ends: as the runner ends it, or killed at a ledger record, as a deploy dies. */
export type RunEnd =
	| { readonly kind: "runner" }
	| { readonly kind: "killed"; readonly at: KillPoint }

/**
 * What a run did: every folder applied and the drift check passed; the runner refused (a MigrateError, raised before,
 * while or after its folders applied); or its process was killed part-way, the transactions before committed.
 */
export type RunOutcome =
	| { readonly kind: "applied" }
	| { readonly kind: "refused"; readonly error: MigrateError }
	| { readonly kind: "killed" }

/**
 * Whether a statement writes the file row `at` names: $1 folder, $3 file, of seven parameters, as
 * adapter/migrate/ledger.ts fileParams spells it.
 */
const writesRecord = (at: KillPoint, statement: BatchStatement): boolean => {
	const params = statement.params
	return params.length === 7 && params[0] === at.folder && params[2] === at.file
}

/**
 * The migration session of a deploy killed at `at`: as the runner sends the transaction holding that record, the
 * connection ends at once, failing it and whatever follows, as when the process running the runner dies.
 */
const killedAt = (session: Session, at: KillPoint): MigrationSession => {
	const inner = migrationSession(session)
	return {
		apart: inner.apart,
		alongside: inner.alongside,
		transaction: (statements) =>
			Effect.suspend(() => {
				if (Arr.some(statements, (statement) => writesRecord(at, statement))) {
					session.destroy()
				}
				return inner.transaction(statements)
			})
	}
}

/**
 * Runs the migration runner in the substrate's database with `folders` (applied or pending) on a migration session of
 * `owner`, the installation's owner login, under the ambient session it was installed under: what `grizzle migrate`
 * sends, its drift check after it, ended as `end` says. Nothing pending runs the drift check alone, as `grizzle drift`
 * does.
 */
export const runFolders = (
	substrate: SubstrateShape,
	owner: AmbientOwner,
	snapshot: DeploySnapshot,
	folders: ReadonlyArray<FolderSource>,
	end: RunEnd
): Effect.Effect<RunOutcome> =>
	Effect.scoped(
		Effect.gen(function* () {
			const connection = yield* Effect.orDie(
				wireSession(substrate.cluster, {
					database: substrate.database,
					username: owner.credentials.role,
					password: owner.credentials.password
				})
			)
			const session =
				end.kind === "runner" ? migrationSession(connection) : killedAt(connection, end.at)
			const ran = yield* Effect.result(applyOnSession(session, [{ snapshot, folders }]))
			if (Result.isSuccess(ran)) {
				return { kind: "applied" }
			}
			return connection.state() === "ended" && end.kind === "killed"
				? { kind: "killed" }
				: { kind: "refused", error: ran.failure }
		})
	)

/** `grizzle drift`: the applied folders run again, nothing pending, so only the drift check runs. */
export const drift = (
	substrate: SubstrateShape,
	owner: AmbientOwner,
	snapshot: DeploySnapshot,
	folders: ReadonlyArray<FolderSource>
): Effect.Effect<Seen> =>
	Effect.flatMap(runFolders(substrate, owner, snapshot, folders, { kind: "runner" }), (outcome) => {
		switch (outcome.kind) {
			case "applied":
				return Effect.succeed(seen({ kind: "drift", objects: [] }))
			case "refused":
				return migrationRefused(outcome.error, (objects) => ({ kind: "drift", objects }))
			case "killed":
				return Effect.die(new Error("a drift run no one killed was killed"))
		}
	})

/**
 * What a perturbation is made with: the current installation's names and compiled statements, the database it is in,
 * its owner, and the finalizer that restores what outlives the installation's own objects.
 */
export interface Catalog {
	readonly names: InstalledNames
	readonly installation: Installation
	readonly database: string
	readonly owner: string
	/** A grizzle role's owned role, read from its value. */
	readonly owned: (role: string) => Effect.Effect<OwnedRole>
	/** The schema-qualified, quoted name of a function the installation defines. */
	readonly function: (fn: WorldFunction) => Effect.Effect<string>
	/** The domain of a field of an ordinary relation of the base. */
	readonly domain: (relation: string, field: string) => Effect.Effect<FieldDomain>
	/**
	 * Registers what undoes a database-level change when the realization ends: the database and the owner outlive
	 * every installation the file makes, and the shared database is released only as the template left it.
	 */
	readonly restoring: (undo: Effect.Effect<void, SqlError>) => Effect.Effect<void>
	/** One statement as the cluster's superuser, for what only an operator with every right may do. */
	readonly superuser: (sql: string) => Effect.Effect<void>
}

/** The role attributes only a superuser grants: an operator with every right, which drift must catch. */
const operatorAttributes: ReadonlySet<string> = new Set([
	"SUPERUSER",
	"BYPASSRLS",
	"REPLICATION",
	"CREATEDB"
])

const rawName = (
	record: Readonly<Record<string, string>>,
	key: string,
	what: string
): Effect.Effect<string> =>
	Option.match(Rec.get(record, key), {
		onNone: () => Effect.die(new Error(`the installation names no ${what} ${key}`)),
		onSome: Effect.succeed
	})

const nameOf = (
	record: Readonly<Record<string, string>>,
	key: string,
	what: string
): Effect.Effect<string> => Effect.map(rawName(record, key, what), quoteIdent)

/** A grizzle role or login by its declared name. */
const worldRole = (names: InstalledNames, name: string): Effect.Effect<string> =>
	nameOf({ ...names.roles, ...names.logins }, name, "role or login")

/** A relation's table or view, in the schema of the level declaring it. */
const tableNamed = (names: InstalledNames, relation: string): Effect.Effect<ObjectName> =>
	Option.match(Rec.get(names.tables, relation), {
		onNone: () => Effect.die(new Error(`the installation names no table ${relation}`)),
		onSome: Effect.succeed
	})

const tableOf = (names: InstalledNames, relation: string): Effect.Effect<string> =>
	Effect.map(tableNamed(names, relation), (t) => `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`)

const columnOf = (names: InstalledNames, relation: string, field: string): Effect.Effect<string> =>
	nameOf(names.columns[relation] ?? {}, field, `column of ${relation}`)

/** The table of the base's first stored relation, which the extra role is granted a privilege on. */
const firstTable = (names: InstalledNames): Effect.Effect<string> =>
	Option.match(Arr.head(Rec.keys(names.tables)), {
		onNone: () => Effect.die(new Error("the installation names no table")),
		onSome: (relation) => tableOf(names, relation)
	})

/**
 * A role the executor grants memberships and privileges through, on one side of the world roles: a parent, which a
 * login or a world role is granted (an extra membership, an inherited grant), or a member, which is granted a world role.
 * One role on both sides would close a cycle of memberships, which PostgreSQL refuses (0LP01), so a member-extra and an
 * inherited grant of one role could not both be made.
 */
type ExtraSide = "parent" | "member"

/**
 * The executor's role on a side, named by the installation's own role naming under its schema, so the substrate
 * releases it with the installation's logins and roles.
 */
const extraRole = (catalog: Catalog, side: ExtraSide): string =>
	identifierOf(
		roleIdentity(
			catalog.installation.names.installation,
			parsedName(side === "parent" ? "executorParent" : "executorMember"),
			SourceLoc(`the executor's ${side} role`, [])
		)
	)

const ensureExtraRole = (
	admin: PgConnection,
	catalog: Catalog,
	side: ExtraSide
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const role = extraRole(catalog, side)
		const found = yield* admin.queryValues(
			"SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1::text",
			[role]
		)
		if (found.length === 0) {
			yield* admin.query(printStatement({ kind: "createRole", name: role, login: false }), [])
		}
	})

/** The PostgreSQL role a role setting names: a login's or a grizzle role's. */
const settingRole = (names: InstalledNames, who: SettingWho): Effect.Effect<string> =>
	who.kind === "login"
		? rawName(names.logins, who.login, "login")
		: rawName(names.roles, who.role, "role")

type SettingWho = Extract<CatalogPerturbation, { readonly kind: "role-setting" }>["who"]

/** The role-level defaults the installation stores for a PostgreSQL role, in install order. */
const installedDefaults = (installation: Installation, role: string): ReadonlyArray<RoleSetting> =>
	Arr.filterMap(installation.statements, (s) =>
		s.kind === "alterRole" && s.name === role && s.action.kind === "set"
			? Result.succeed(s.action.setting)
			: Result.failVoid
	)

/**
 * The server's default of `setting`'s parameter, `boot`, as ALTER ROLE ... SET spells it: pg_settings spells a
 * search_path as the list it is, each schema as quote_identifier does; any other value is one string literal.
 */
const bootSql = (setting: RoleSetting, boot: string): string =>
	setting.parameter === "search_path" ? boot : quoteString(boot)

/** The value the server gives a parameter no setting names. */
const bootValue = (admin: PgConnection, parameter: string): Effect.Effect<string, SqlError> =>
	Effect.flatMap(
		admin.queryValues("SELECT boot_val FROM pg_catalog.pg_settings WHERE name = $1::text", [
			parameter
		]),
		(rows) => {
			const value = rows[0]?.[0]
			return typeof value === "string"
				? Effect.succeed(value)
				: Effect.die(new Error(`the server has no parameter ${parameter}`))
		}
	)

/** A parameter the installation never stores for any role: what an extra setting sets. */
const extraParameter = { parameter: "work_mem", value: "8MB" } as const

/**
 * A role setting changed behind grizzle's back, at the role's own level or in this database only:
 * - default-reset: the parameter the installation stores first for the role back at the server's default, by RESET at
 *   its own level, by a setting of the server's default in this database; a role the installation stores nothing for
 *   has nothing to reset;
 * - default-changed: extra_float_digits, which the installation stores for every login, at another value;
 * - extra: a parameter the installation never stores.
 */
const roleSettingStatements = (
	admin: PgConnection,
	catalog: Catalog,
	p: Extract<CatalogPerturbation, { readonly kind: "role-setting" }>
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.gen(function* () {
		const role = yield* settingRole(catalog.names, p.who)
		const at =
			p.scope === "own"
				? `ALTER ROLE ${quoteIdent(role)}`
				: `ALTER ROLE ${quoteIdent(role)} IN DATABASE ${quoteIdent(catalog.database)}`
		const defaults = installedDefaults(catalog.installation, role)
		switch (p.change) {
			case "default-reset":
				return yield* Option.match(Arr.head(defaults), {
					onNone: () => Effect.succeed([]),
					onSome: (d) =>
						p.scope === "own"
							? Effect.succeed([`${at} RESET ${d.parameter}`])
							: Effect.map(bootValue(admin, d.parameter), (value) => [
									`${at} SET ${d.parameter} = ${bootSql(d, value)}`
								])
				})
			case "default-changed": {
				const installed = Arr.findFirst(defaults, (d) => d.parameter === "extra_float_digits")
				const value = Option.exists(installed, (d) => storedSettingValue(d) === "0") ? "1" : "0"
				return [`${at} SET extra_float_digits = ${quoteString(value)}`]
			}
			case "extra":
				return [`${at} SET ${extraParameter.parameter} = ${quoteString(extraParameter.value)}`]
		}
	})

/** The installation's own database default, which restores the database's isolation once the realization ends. */
const databaseDefault = (installation: Installation): Effect.Effect<string> =>
	Option.match(
		Arr.findFirst(installation.statements, (s) => s.kind === "alterDatabaseDefault"),
		{
			onNone: () => Effect.die(new Error("the installation stores no database default")),
			onSome: (s) => Effect.succeed(printStatement(s))
		}
	)

/**
 * A database-level setting changed behind grizzle's back: the default isolation changed or reset, or a setting of the
 * owner's in this database, which the drift check does not judge. Each is undone when the realization ends.
 */
const databaseSettingStatements = (
	admin: PgConnection,
	catalog: Catalog,
	change: Extract<CatalogPerturbation, { readonly kind: "database-setting" }>["change"]
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.gen(function* () {
		const database = quoteIdent(catalog.database)
		switch (change) {
			case "isolation-changed":
			case "isolation-reset": {
				const restore = yield* databaseDefault(catalog.installation)
				yield* catalog.restoring(admin.query(restore, []))
				return change === "isolation-changed"
					? [`ALTER DATABASE ${database} SET default_transaction_isolation = 'read committed'`]
					: [`ALTER DATABASE ${database} RESET default_transaction_isolation`]
			}
			case "owner-setting": {
				const owner = `ALTER ROLE ${quoteIdent(catalog.owner)} IN DATABASE ${database}`
				yield* catalog.restoring(admin.query(`${owner} RESET ${extraParameter.parameter}`, []))
				return [`${owner} SET ${extraParameter.parameter} = ${quoteString(extraParameter.value)}`]
			}
		}
	})

/** A writable entry's one policy over its target's table, as the installation created it, or none for another entry. */
const policyOf = (
	catalog: Catalog,
	role: string,
	entry: string
): Effect.Effect<Option.Option<CreatePolicy>> =>
	Effect.gen(function* () {
		const owned = yield* catalog.owned(role)
		const theory = worldNames(owned, catalog.installation.names).role
		const target = Option.map(Option.fromNullishOr(owned.writes.get(entry)), (e) =>
			e.kind === "whole" ? e.relation.name : e.writable.target
		)
		return Option.flatMap(target, (relation) => {
			const table = catalog.installation.names.relation(relation)
			return Arr.findFirst(
				catalog.installation.statements,
				(s): s is CreatePolicy =>
					s.kind === "createPolicy" &&
					s.name === theory &&
					s.table.schema === table.schema &&
					s.table.name === table.name
			)
		})
	})

/** A role relation's view as the installation created it, or none for a closed whole entry, which has no view. */
const viewOf = (
	catalog: Catalog,
	role: string,
	entry: string
): Effect.Effect<Option.Option<CreateView>> =>
	Effect.gen(function* () {
		const owned = yield* catalog.owned(role)
		const view = yield* Effect.sync(() => worldNames(owned, catalog.installation.names).view(entry))
		return Arr.findFirst(
			catalog.installation.statements,
			(s): s is CreateView =>
				s.kind === "createView" && s.name.schema === view.schema && s.name.name === view.name
		)
	})

/** A view's definition replaced by one of the same rows that reads differently: its query under a WHERE true. */
const redefinedView = (view: CreateView): Effect.Effect<string> => {
	const alias = "executor_redefined"
	const query = provedSelect(
		"keyed",
		Arr.map(view.columns, (c) => target(col(alias, c))),
		[derived(view.query, alias, view.columns, false)],
		lit.bool(true)
	)
	const created = printStatement({ ...view, query })
	return Str.startsWith("CREATE VIEW ")(created)
		? Effect.succeed(Str.replace("CREATE VIEW ", "CREATE OR REPLACE VIEW ")(created))
		: Effect.die(new Error("a view prints as no CREATE VIEW"))
}

/** A default the column's domain admits, as SQL: an identity column takes none, so a serial field has none. */
const defaultOf = (domain: FieldDomain): Effect.Effect<string> => {
	switch (domain.kind) {
		case "uuid":
			return Effect.succeed(quoteString("00000000-0000-0000-0000-000000000000"))
		case "text":
			return Effect.succeed(quoteString(""))
		case "integer":
		case "contract":
			return Effect.succeed("0")
		case "boolean":
			return Effect.succeed("false")
		case "handle":
			return Effect.succeed(quoteString(domain.members[0]))
		case "span":
			return Effect.succeed(quoteString("empty"))
		case "serial":
			return Effect.die(new Error("a serial field is an identity column, which takes no default"))
	}
}

/**
 * The functions the triggers of a trigger reference run, each with the table it is on when that names it: a table's
 * isolation guard, the one trigger grizzle installs (fin.md §7).
 */
const triggerFunctions = (
	catalog: Catalog,
	trigger: TriggerRef
): Effect.Effect<
	Arr.NonEmptyReadonlyArray<{ readonly name: string; readonly table: Option.Option<string> }>
> =>
	Effect.map(tableNamed(catalog.names, trigger.relation), (table) => [
		{ name: isolationGuardName, table: Option.some(table.name) }
	])

/** Every trigger of the installation's schema that runs a function of it, by its name: each one's table and name. */
const triggersQuery =
	"SELECT c.relname::text, t.tgname::text FROM pg_catalog.pg_trigger AS t JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid " +
	"JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal AND c.relnamespace = pg_catalog.to_regnamespace($1::text) " +
	"AND p.pronamespace = pg_catalog.to_regnamespace($1::text) AND p.proname = $2::name"

/** The installation's triggers of `trigger`'s function, on its table when it names one, each disabled. */
const disabledTriggers = (
	admin: PgConnection,
	catalog: Catalog,
	trigger: TriggerRef
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.gen(function* () {
		const schema = catalog.names.schema
		const functions = yield* triggerFunctions(catalog, trigger)
		const statements = yield* Effect.forEach(functions, (fn) =>
			Effect.gen(function* () {
				const rows = yield* Option.match(fn.table, {
					onNone: () => admin.queryValues(`${triggersQuery} ORDER BY 1, 2`, [schema, fn.name]),
					onSome: (table) =>
						admin.queryValues(`${triggersQuery} AND c.relname = $3::name ORDER BY 1, 2`, [
							schema,
							fn.name,
							table
						])
				})
				const disabled = yield* Effect.forEach(rows, ([table, name]) =>
					typeof table === "string" && typeof name === "string"
						? Effect.succeed(
								`ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(table)} DISABLE TRIGGER ${quoteIdent(name)}`
							)
						: Effect.die(new Error("a trigger row without its table and name"))
				)
				return Arr.isReadonlyArrayNonEmpty(disabled)
					? disabled
					: yield* Effect.die(new Error(`the installation has no trigger running ${fn.name}`))
			})
		)
		return Arr.flatten(statements)
	})

/** The statements that make one perturbation, as the owner, in order. */
const perturbationStatements = (
	admin: PgConnection,
	catalog: Catalog,
	p: CatalogPerturbation
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.gen(function* () {
		const names = catalog.names
		switch (p.kind) {
			case "membership-admin":
				return [
					`GRANT ${yield* worldRole(names, p.role)} TO ${yield* worldRole(names, p.login)} WITH ADMIN OPTION`
				]
			case "membership-inherit":
				return [
					`GRANT ${yield* worldRole(names, p.role)} TO ${yield* worldRole(names, p.login)} WITH INHERIT TRUE`
				]
			case "membership-revoked":
				return [
					`REVOKE ${yield* worldRole(names, p.role)} FROM ${yield* worldRole(names, p.login)}`
				]
			case "role-attribute": {
				const role = yield* worldRole(names, p.role)
				if (!operatorAttributes.has(p.attribute)) {
					return [`ALTER ROLE ${role} ${p.attribute}`]
				}
				yield* catalog.superuser(`ALTER ROLE ${role} ${p.attribute}`)
				yield* catalog.restoring(catalog.superuser(`ALTER ROLE ${role} NO${p.attribute}`))
				return []
			}
			case "role-setting":
				return yield* roleSettingStatements(admin, catalog, p)
			case "database-setting":
				return yield* databaseSettingStatements(admin, catalog, p.change)
			case "row-security": {
				const state = p.state === "disabled" ? "DISABLE" : p.state === "forced" ? "FORCE" : "ENABLE"
				return [`ALTER TABLE ${yield* tableOf(names, p.relation)} ${state} ROW LEVEL SECURITY`]
			}
			case "extra-grant":
				return [
					`GRANT ${p.privilege} ON ${yield* tableOf(names, p.relation)} TO ${yield* worldRole(names, p.role)}`
				]
			case "grant-revoked":
				return [
					`REVOKE ${p.privilege} ON ${yield* tableOf(names, p.relation)} FROM ${yield* worldRole(names, p.role)}`
				]
			case "public-grant":
				return [`GRANT SELECT ON ${yield* tableOf(names, p.relation)} TO PUBLIC`]
			case "not-null-dropped":
				return [
					`ALTER TABLE ${yield* tableOf(names, p.relation)} ALTER COLUMN ${yield* columnOf(names, p.relation, p.field)} DROP NOT NULL`
				]
			case "extra-index":
				return [
					`CREATE INDEX ON ${yield* tableOf(names, p.relation)} (${yield* columnOf(names, p.relation, p.field)})`
				]
			case "extra-table":
				return [
					`CREATE TABLE ${quoteIdent(names.schema)}.${quoteIdent("executor_extra")} (x integer)`
				]
			case "membership-extra": {
				yield* ensureExtraRole(admin, catalog, "parent")
				const extra = quoteIdent(extraRole(catalog, "parent"))
				const granted = `GRANT ${extra} TO ${yield* worldRole(names, p.login)} WITH INHERIT ${p.inherit ? "TRUE" : "FALSE"}, SET ${p.set ? "TRUE" : "FALSE"}`
				return p.holds === "nothing"
					? [granted]
					: [granted, `GRANT SELECT ON ${yield* firstTable(names)} TO ${extra}`]
			}
			case "member-extra":
				yield* ensureExtraRole(admin, catalog, "member")
				return [
					`GRANT ${yield* worldRole(names, p.role)} TO ${quoteIdent(extraRole(catalog, "member"))} WITH SET ${p.set ? "TRUE" : "FALSE"}`
				]
			case "extra-column-grant":
				return [
					`GRANT ${p.privilege} (${yield* columnOf(names, p.relation, p.field)}) ON ${yield* tableOf(names, p.relation)} TO ${yield* worldRole(names, p.role)}`
				]
			case "inherited-grant": {
				yield* ensureExtraRole(admin, catalog, "parent")
				const extra = quoteIdent(extraRole(catalog, "parent"))
				return [
					`GRANT ${p.privilege} ON ${yield* tableOf(names, p.relation)} TO ${extra}`,
					`GRANT ${extra} TO ${yield* worldRole(names, p.role)} WITH INHERIT TRUE`
				]
			}
			case "policy-dropped": {
				const existingPolicy = yield* policyOf(catalog, p.role, p.entry)
				return Option.match(existingPolicy, {
					onNone: () => [],
					onSome: (policy) => [
						printStatement({ kind: "dropPolicy", name: policy.name, table: policy.table })
					]
				})
			}
			case "policy-edited": {
				const currentPolicy = yield* policyOf(catalog, p.role, p.entry)
				return Option.match(currentPolicy, {
					onNone: () => [],
					onSome: (policy) => [
						printStatement({ kind: "dropPolicy", name: policy.name, table: policy.table }),
						printStatement({ ...policy, filter: and([policy.filter, lit.bool(true)]) })
					]
				})
			}
			case "view-redefined": {
				const existingView = yield* viewOf(catalog, p.role, p.entry)
				return yield* Option.match(existingView, {
					onNone: () => Effect.succeed([]),
					onSome: (view) => Effect.map(redefinedView(view), (sql) => [sql])
				})
			}
			case "function-redefined":
				return [`ALTER FUNCTION ${yield* catalog.function(p.fn)} COST 7`]
			case "search-path-altered":
				return [
					`ALTER FUNCTION ${yield* catalog.function(p.fn)} SET search_path = public, pg_catalog, pg_temp`
				]
			case "column-default":
				return [
					`ALTER TABLE ${yield* tableOf(names, p.relation)} ALTER COLUMN ${yield* columnOf(names, p.relation, p.field)} SET DEFAULT ${yield* Effect.flatMap(catalog.domain(p.relation, p.field), defaultOf)}`
				]
			case "trigger-disabled":
				return yield* disabledTriggers(admin, catalog, p.trigger)
			case "rewrite-rule":
				return [
					`CREATE RULE ${quoteIdent("executor_rule")} AS ON UPDATE TO ${yield* tableOf(names, p.relation)} DO INSTEAD NOTHING`
				]
			case "default-privileges":
				return p.privilege === "EXECUTE"
					? [
							`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(names.schema)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`
						]
					: [
							`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(names.schema)} GRANT USAGE ON TYPES TO PUBLIC`
						]
		}
	})

/**
 * One perturbation of the catalog behind grizzle's back, made as the owner in one transaction, with the installation's
 * own names: its compiled policies and views edited where it compiled them, its functions and triggers by the names it
 * gave them, its roles and the extra role by its own role naming. A perturbation of an object the installation does
 * not hold (the policy of an entry it does not write, the view of a closed whole entry) changes nothing.
 */
export const tamper = (
	admin: PgConnection,
	catalog: Catalog,
	p: CatalogPerturbation
): Effect.Effect<Observation, SqlError> =>
	Effect.gen(function* () {
		const statements = yield* perturbationStatements(admin, catalog, p)
		yield* Effect.scoped(
			Effect.gen(function* () {
				const connection = yield* admin.pin
				yield* connection.query("BEGIN", [])
				for (const statement of statements) {
					yield* Effect.onError(connection.query(statement, []), () =>
						Effect.ignore(connection.query("ROLLBACK", []))
					)
				}
				yield* connection.query("COMMIT", [])
			})
		)
		return { kind: "ok" }
	})

/** What a migration installs: its plan, the folder it applies as `how` says, and the snapshot it reaches. */
export interface Drafted {
	readonly plan: RealInstallPlan
	readonly folder: FolderSource
	readonly snapshot: DeploySnapshot
}

/** The version a migration continues: the snapshot it drafts from and the folders the ledger has applied. */
interface Continued {
	readonly snapshot: DeploySnapshot
	readonly folders: ReadonlyArray<FolderSource>
}

/**
 * Every drop of stored state from `previous` to `owned` and its `logins`, declared as a reviewer declares it
 * (`--drop`): each login the snapshot holds that the next version does not, each stored relation or roster the snapshot
 * holds that the next version lacks, each field of a relation both hold that the next version's lacks, and each live
 * handle of a roster both hold that the next version no longer declares. The worlds declare no rename: a login, relation
 * or handle that goes is dropped, and one that comes is new.
 */
const dropsOf = (
	previous: DeploySnapshot,
	owned: Owned,
	logins: ReadonlyArray<string>
): Declarations => {
	const drops: Array<Named> = []
	for (const login of Rec.keys(previous.logins)) {
		if (!logins.includes(login)) {
			drops.push({ kind: "login", login: parsedName(login) })
		}
	}
	for (const [name, r] of Rec.toEntries(previous.theory.relations)) {
		const now = owned.relations[name]
		const relation = parsedName(name)
		if (r.kind === "derived") {
			continue
		}
		if (now === undefined) {
			drops.push({ kind: "relation", relation })
			continue
		}
		if (r.kind === "relation" && now.kind === "relation") {
			for (const f of r.fields) {
				if (!Rec.has(now.fields, f.name)) {
					drops.push({ kind: "field", relation, field: parsedName(f.name) })
				}
			}
		}
		if (r.kind === "closed" && now.kind === "closed") {
			for (const slot of r.codes) {
				if (slot.kind === "live" && !now.desc.handles.includes(slot.handle)) {
					drops.push({ kind: "handle", roster: relation, handle: slot.handle })
				}
			}
		}
	}
	return { renames: [], drops }
}

/**
 * The next migration of an installation under `schema`, drafted from the directory's snapshot as `grizzle generate`
 * drafts it, no rename declared, every drop declared (dropsOf) and every loss written in, at the CLI's timestamp. A
 * version that declares a roster out of its codes' order is refused as generate refuses it (D1), before anything is
 * drafted. A draft that needs a placeholder value is a defect of the drawn spec.
 */
export const draftNext = (
	declared: AnySchema,
	logins: ReadonlyArray<unknown>,
	schema: string,
	owner: string,
	previous: Continued
): Effect.Effect<Drafted, RealizeRefused> =>
	Effect.gen(function* () {
		const now = parseTimestamp(draftedAt(1))
		if (Option.isNone(now)) {
			return yield* Effect.die(new Error("the stand-in clock names no UTC second"))
		}
		/** The CLI's timestamp: its clock's second, or one after the newest folder applied, so the folder sorts last. */
		const timestamp = nextTimestamp(
			now.value,
			Arr.map(previous.folders, (f) => Str.slice(0, 14)(f.name))
		)
		const desc = schemaDescOf(declared)
		if (desc === undefined) {
			return yield* Effect.die(new Error("the next version's base is no schema value"))
		}
		const owned = yield* Effect.orDie(fromEngine(own(desc)))
		/** The codes the next version's rosters take, every handle the snapshot holds keeping its own (D1). */
		const rosters = rostersOf(owned)
		const drafted = draftCodebook(
			rosterFates(
				previous.snapshot,
				noDeclarations,
				Arr.map(rosters, (r) => r.closed)
			),
			noRenames,
			rosters
		)
		if (!drafted.ok) {
			return yield* new RealizeRefused({
				what: `the codes of roster ${drafted.error.roster}`,
				refusal: reorderRefusal(drafted.error)
			})
		}
		const plan = yield* Effect.orDie(
			fromEngine(
				planRealInstall(desc, {
					installation: identity.schema(parsedSchemaName(schema)),
					owner,
					logins,
					extensions: [],
					codes: drafted.value
				})
			)
		)
		const drops = dropsOf(
			previous.snapshot,
			owned,
			Arr.map(plan.installation.worlds, (l) => l.name)
		)
		const g = yield* Effect.orDie(
			fromEngine(
				generate({
					installation: plan.installation,
					name: "next",
					timestamp,
					previous: fromSnapshot(previous.snapshot),
					workload: noWorkload,
					declared: drops
				})
			)
		)
		const reviewed = review(g, {
			losses: "written",
			value: (placeholder) => {
				throw new Error(
					`the next version needs a value for a placeholder of ${placeholder.table.name}`
				)
			}
		})
		const files = Arr.map(reviewed.files, (f) => ({ name: f.name, text: f.text }))
		return {
			plan,
			folder: { name: g.folder.name, metaText: g.folder.metaText, files },
			snapshot: g.snapshot
		}
	})

/**
 * The phase of each file of the folder `grizzle generate` drafts for a migration from one installation to another, in
 * order (`NN-<phase>.sql`), the first installation drafted from the empty snapshot under `schema`: the drafter's word on
 * a folder's files, which the worlds model's folderFiles restates. An installation grizzle's builders refuse is the
 * refusal.
 */
export const draftedPhases = (
	from: InstallSpec,
	to: InstallSpec,
	schema: string
): Effect.Effect<ReadonlyArray<string>, RealizeRefused> =>
	Effect.gen(function* () {
		const owner = `${schema}_owner`
		const before = yield* buildInstall(from, from.base.name)
		const after = yield* buildInstall(to, to.base.name)
		const first = yield* draftNext(before.base, Rec.values(before.logins), schema, owner, {
			snapshot: emptySnapshot({ schemaName: from.base.name, schema }),
			folders: []
		})
		const next = yield* draftNext(after.base, Rec.values(after.logins), schema, owner, {
			snapshot: first.snapshot,
			folders: [first.folder]
		})
		return Arr.map(next.folder.files, (f) => Str.slice(3, -4)(f.name))
	})

/** A file with a line a person added by hand, after it was written. */
const editedByHand = (file: FolderSource["files"][number]): FolderSource["files"][number] => ({
	name: file.name,
	text: `${file.text}\n-- edited by hand\n`
})

/** The folders of a migrations directory: the ones the ledger applied, oldest first, and the ones still pending. */
interface FolderList {
	readonly applied: ReadonlyArray<FolderSource>
	readonly pending: ReadonlyArray<FolderSource>
}

/**
 * The folders a migration hands the runner, its new folder whole after the directory's (applied, then pending): as
 * written, or, edited by hand, with the last applied folder's first file a person edited after it ran, which the runner
 * refuses before it runs anything (an edit to a folder not yet applied is legal, README "Migrations", so a pending
 * folder is never the one edited).
 */
export const landedFolders = (
	directory: FolderList,
	folder: FolderSource,
	how: MigrationHow
): ReadonlyArray<FolderSource> => {
	switch (how) {
		case "complete":
		case "half-applied":
			return [...directory.applied, ...directory.pending, folder]
		case "hand-edited":
			return [
				...Arr.map(directory.applied, (applied, i) =>
					i === directory.applied.length - 1
						? {
								...applied,
								files: Arr.map(applied.files, (f, j) => (j === 0 ? editedByHand(f) : f))
							}
						: applied
				),
				...directory.pending,
				folder
			]
	}
}

/**
 * How a migration's run ends, as `how` says: as the runner ends it, or, half-applied, a deploy killed inside its new
 * folder once k of its n files committed, k half of n and less than n (none for a folder of one file), so the folder is
 * left in progress in the ledger, or not started (main's ruling). A half-applied migration is drawn only to an
 * installation that differs, so a new folder with no file to stop in is a defect of the run.
 */
export const runEndOf = (folder: FolderSource, how: MigrationHow): Effect.Effect<RunEnd> => {
	switch (how) {
		case "complete":
		case "hand-edited":
			return Effect.succeed({ kind: "runner" })
		case "half-applied": {
			const cut =
				folder.files[Math.min(Math.floor(folder.files.length / 2), folder.files.length - 1)]
			return cut === undefined
				? Effect.die(new Error(`the half-applied folder ${folder.name} has no file to stop in`))
				: Effect.succeed({ kind: "killed", at: { folder: folder.name, file: cut.name } })
		}
	}
}
