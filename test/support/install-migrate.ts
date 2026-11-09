import { inspect } from "node:util"
import {
	Array as Arr,
	Effect,
	Option,
	pipe,
	Record as Rec,
	type Scope,
	String as Str
} from "effect"
import { registerSnapshot } from "#adapter/admission/snapshots.ts"
import { fromEngine } from "#adapter/engine.ts"
import { applyOnSession, type SchemaApplyReport } from "#adapter/migrate/apply.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { migrationSession } from "#adapter/migrate/session.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import type * as Engine from "#compiler/core/result.ts"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { LoginDesc, RoleDesc, SchemaDesc } from "#compiler/ir/desc.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { AnyLogin, AnyRole } from "#compiler/types/schema/world.ts"
import { folderSource, installationAbstraction, sameCatalog } from "#test/pg/migrate/support.ts"
import { type AmbientOwner, type AmbientSession, ambientOwner } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { checkInstallation } from "#test/support/catalog/installed.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"
import { installationSql } from "#test/support/compile.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { fromEmpty, generate, noDeclarations } from "#test/support/migrate/kit.ts"
import { type FactSet, factStatements, loadFacts } from "#test/support/oracle/install/load.ts"
import {
	planRealInstall,
	type RealInstallOptions,
	type RealInstallPlan
} from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { type SqlError, wireSession } from "#test/support/pg.ts"
import { owning, schemaDescIn } from "#test/support/policy.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import type { Credentials, SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/**
 * Installing a compiled schema into the test file's database through its migrations.
 *
 * A schema is installed the way a deployment installs it: `grizzle generate` drafts its first migration from the empty
 * snapshot, and `grizzle migrate` runs that folder as the migration identity, which owns the schema. In order:
 *
 * 1. The name. The substrate allocates a unique schema name, because login and world roles are cluster-wide and every
 *    pg and schedules file instantiates its fixtures afresh, and the schema is installed under the identity the naming
 *    door mints from it (Installed.schema is that identity's identifier). A test opens the installation through the
 *    schema rebuilt under the allocated name itself (Installed.declared) from the same relations and statements: the
 *    installed schema but for its declared name, whose only physical consequence is the PostgreSQL schema.
 * 2. The installation. The schema compiles complete, as `grizzle generate` composes it (physical/complete.ts): the
 *    residual laws, the caller's extensions, the derived relations, and the refined constants' validation every
 *    installation carries. The oracle's view of the installation (oracle/install/real.ts) is what loads facts and names
 *    the lowerings' physical objects.
 * 3. The migration. generateMigration drafts the folder from the empty snapshot, and the real
 *    apply runner (packages/grizzle/src/adapter/migrate) runs it on a migration session of the installation's owner
 *    login over verify-full TLS (a test helper's connection, see applyFolders), which acts as the substrate's owner
 *    under the ambient session the caller gives (test/support/ambient.ts AmbientOwner): the ledger is absent, so the
 *    database is at the empty snapshot, the first Prepare file creates the schema and its ledger, every file records its
 *    row in its own transaction, and the drift check after it refuses any drift.
 * 4. The equality check. The migration must install the catalog the fresh-install compiler's script of the same
 *    installation installs, the ledger aside: the two paths must produce identical catalogs. An installation is
 *    certified from its statements when the migration runs the script's statements and otherwise only statements that
 *    leave no object, its privileges in the script's order (runsInstallScript); one it cannot certify is compared in
 *    full: the script runs under another allocated name and the two catalogs, function bodies, trigger events and view
 *    queries included, must be equal (test/pg/migrate/support.ts sameCatalog).
 * 5. The snapshot. The generated snapshot is registered with the schema rebuilt under the allocated name
 *    (adapter/admission/snapshots.ts): it stands for the committed `migrations/<schema>/snapshot.json` the application
 *    knows, and a Db opened on a layer given it, of a schema value of that name or of a level below it, admits the
 *    database against it.
 * 6. Logins. The installation carries the logins the caller gives, over the schema as declared (a login value or a
 *    LoginDesc), and every login role gets a password through the substrate, so a test logs in as it over verify-full
 *    TLS exactly as a grizzle connection or a psql writer would, and takes on a role of it per transaction or session;
 *    the substrate's schema finalizer drops the schema and its roles.
 * 7. The posture. The installed-catalog checker (test/support/catalog checkInstallation) judges the catalog the
 *    migration reached against its installation: worlds, policies, filter and advance functions, grants, memberships
 *    and login defaults, so every suite's installation holds the posture whatever the suite tests. An installation in
 *    another database (installMigratedIn) is the first one's copy, judged with it.
 */
export interface Installed {
	/** The initialised cluster of the substrate it was migrated in: the CA its logins' connections verify. */
	readonly cluster: InitializedClusterShape
	/** The substrate database the installation was migrated in. */
	readonly database: string
	/** The PostgreSQL schema the installation lives in: the identifier the naming door mints from `declared`. */
	readonly schema: string
	/**
	 * The name the installation's schema identity is minted from (the substrate's allocation): the declared name of the
	 * schema a test rebuilds to open it, or to compile a query against it, never its PostgreSQL schema.
	 */
	readonly declared: string
	readonly installation: Installation
	readonly plan: RealInstallPlan
	/** The physical names the lowerings emit: the installation's own (physical/ddl/names.ts InstallNames). */
	readonly names: PhysicalNames
	/**
	 * The migrations that installed it, in order, as they were applied, and the snapshot the last one reached: what a
	 * DbLayer of its logins is given.
	 */
	readonly folders: Arr.NonEmptyReadonlyArray<FolderSource>
	readonly snapshot: DeploySnapshot
	/**
	 * The owner as the installation's own sessions log in, with the ambient session they start under: what every later
	 * migration or drift check of the installation logs in as.
	 */
	readonly ambientOwner: AmbientOwner
	/**
	 * The installed theory role of a role, `<schema>__<role>`; a role the installation does not hold is a defect of the
	 * test. Each lookup takes the value (or its Description), never a spelled name.
	 */
	readonly role: (role: AnyRole | RoleDesc) => string
	/** Login credentials of a login; a login the installation does not hold is a defect of the test. */
	readonly as: (login: AnyLogin | LoginDesc) => Credentials
	/** A role as a direct SQL writer takes it on: the credentials of the login that holds it, and its theory role. */
	readonly world: (role: AnyRole | RoleDesc) => SubstrateWorld
}

/** The folders are drafted at one fixed time: the folder name only orders a schema's own migrations. */
const installTimestamp = "20261013000000"
const installName = "install"

/** The plan of the complete installation under `installation` (oracle/install/real.ts), with the caller's logins and
 * extensions, and a fresh installation's codes, as the first migration from an empty directory drafts them. */
const completePlan = (
	desc: SchemaDesc,
	installation: Identity<"schema">,
	owner: string,
	options: RealInstallOptions
): Engine.Result<RealInstallPlan, CompileError> =>
	planRealInstall(desc, {
		installation,
		owner,
		logins: options.logins,
		extensions: options.extensions,
		codes: firstCodebook(rostersOf(owning(desc)))
	})

/** The installation's script with every name minted under its schema's identity abstracted
 * (installationAbstraction): one key per installation shape. */
const shapeKey = (installation: Installation): string =>
	Arr.join(Arr.map(installationSql(installation), installationAbstraction(installation)), "\n")

const normalized = (statement: string): string =>
	pipe(Str.trim(statement), Str.replace(regex(";$"), ""))

/** A statement without its leading comment lines. */
const body = (statement: string): string =>
	Str.trim(
		Arr.join(
			Arr.filter(Str.split(statement, "\n"), (l) => !pipe(Str.trimStart(l), Str.startsWith("--"))),
			"\n"
		)
	)

/**
 * A statement a first migration runs beyond the fresh-install script that leaves no object but the migrations ledger:
 * the ledger's own DDL, guard trigger and grants, the LOCK opening a residual law's Validate file, and the DO block
 * running the law's full violation query there, which reads and raises only. The snapshot guard's function names the
 * ledger in its body but is the installation's own object, in the script too, so a CREATE ... FUNCTION is never one.
 */
const leavesNoObject = (statement: string, schema: string): boolean => {
	const text = body(statement)
	return (
		(pipe(text, Str.includes(`${quoteIdent(schema)}.${quoteIdent(ledgerTableName)}`)) &&
			!Str.startsWith("CREATE OR REPLACE FUNCTION ")(text)) ||
		Str.startsWith("LOCK TABLE ")(text) ||
		(Str.startsWith("DO $$")(text) &&
			Str.includes("-- The full violation query of law ")(statement))
	)
}

/**
 * The statements whose order decides privileges: grants, revokes and default privileges, which apply to the objects
 * created before them.
 */
const isPrivilege = (statement: string): boolean => {
	const text = body(statement)
	return (
		Str.startsWith("GRANT ")(text) ||
		Str.startsWith("REVOKE ")(text) ||
		Str.startsWith("ALTER DEFAULT PRIVILEGES ")(text)
	)
}

/**
 * Whether the migration provably installs the fresh-install script's catalog, the ledger aside: it runs every statement
 * of the script exactly once and otherwise only statements that leave no object; each object's grants and revokes, and
 * the default privileges, run in the script's order; and every default privilege runs after every object is created,
 * as in the script. Every other statement creates or alters an object of its own, so its position decides nothing a catalog
 * shows (a statement that needs an earlier one fails the apply instead).
 */
export const runsInstallScript = (folder: FolderSource, installation: Installation): boolean => {
	const schema = installation.names.schema
	const script = Arr.map(installationSql(installation), normalized)
	const migration = Arr.map(
		Arr.flatMap(folder.files, (f) => splitStatements(f.text)),
		normalized
	)
	const pending = new Map<string, number>()
	for (const s of script) {
		pending.set(s, (pending.get(s) ?? 0) + 1)
	}
	for (const m of migration) {
		const left = pending.get(m) ?? 0
		if (left > 0) {
			pending.set(m, left - 1)
		} else if (!leavesNoObject(m, schema)) {
			return false
		}
	}
	if (Arr.some([...pending.values()], (n) => n > 0)) {
		return false
	}
	/** Each object's grants and revokes, in order; default privileges form one sequence of their own. */
	const privileges = (list: ReadonlyArray<string>) => {
		const byObject = new Map<string, Array<string>>()
		for (const s of list) {
			if (!isPrivilege(s) || leavesNoObject(s, schema)) {
				continue
			}
			const text = body(s)
			/**
			 * A GRANT or REVOKE of a privilege names its object between ON and TO or FROM; one of a role membership names no
			 * object, and is keyed by its granted role and its member, the pair whose grants and revokes are ordered;
			 * ALTER DEFAULT PRIVILEGES, which names an object class there, is the one sequence of its own.
			 */
			const membership = regex(
				'^(?:GRANT|REVOKE)(?: (?:ADMIN|INHERIT|SET) OPTION FOR)? ("[^"]+") (?:TO|FROM) ("[^"]+")'
			).exec(text)
			const key = Str.startsWith("ALTER DEFAULT PRIVILEGES ")(text)
				? "default privileges"
				: membership !== null && !Str.includes(" ON ")(text)
					? `membership ${membership[1]} ${membership[2]}`
					: defined(
							regex(" ON (.+?) (?:TO|FROM) ", "s").exec(text)?.[1],
							`a privilege statement that names no object: ${text}`
						)
			byObject.set(key, [...(byObject.get(key) ?? []), s])
		}
		return byObject
	}
	const a = privileges(script)
	const b = privileges(migration)
	if (a.size !== b.size) {
		return false
	}
	for (const [key, list] of a) {
		const other = b.get(key)
		if (
			other === undefined ||
			other.length !== list.length ||
			Arr.some(list, (s, i) => s !== other[i])
		) {
			return false
		}
	}
	const lastCreate = Arr.findLastIndex(migration, (s) => pipe(body(s), Str.startsWith("CREATE ")))
	const firstDefault = Arr.findFirstIndex(migration, (s) =>
		pipe(body(s), Str.startsWith("ALTER DEFAULT PRIVILEGES "))
	)
	return (
		Option.isNone(firstDefault) ||
		Option.isNone(lastCreate) ||
		firstDefault.value > lastCreate.value
	)
}

/**
 * Asserts that the migrated schema holds the catalog the fresh-install script of the same installation produces. An
 * installation whose migration runsInstallScript cannot certify is compared in full: the fresh-install script runs
 * under another allocated name, and the two catalogs, function bodies, trigger events and view queries included, must
 * be equal, the ledger aside, because the two paths must produce identical catalogs. The fresh schema and its roles are
 * dropped as soon as they are compared.
 */
const expectFreshCatalog = (
	desc: SchemaDesc,
	migrated: Installation,
	folder: FolderSource,
	options: RealInstallOptions
): Effect.Effect<void, CompileError | SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		if (runsInstallScript(folder, migrated)) {
			return
		}
		const substrate = yield* Substrate
		const fresh = yield* substrate.schema({ create: false, label: "fresh" })
		const plan = yield* fromEngine(
			completePlan(desc, identity.schema(parsedSchemaName(fresh)), substrate.owner.role, options)
		)
		assert.equal(
			shapeKey(plan.installation),
			shapeKey(migrated),
			"the fresh install compiles the same script"
		)
		yield* transaction(substrate.admin, plan.sql)
		const schema = migrated.names.schema
		yield* sameCatalog(
			migrated,
			plan.installation,
			`the migration of ${schema} against its fresh install`
		)
	}).pipe(Effect.scoped)

/** A refused apply is a defect of the test's setup, reported with its message, which names its stage. */
const applied = (
	effect: Effect.Effect<ReadonlyArray<SchemaApplyReport>, MigrateError>
): Effect.Effect<ReadonlyArray<SchemaApplyReport>> =>
	Effect.catch(effect, (e) =>
		Effect.die(new Error(`test install: ${e.message} (schema ${e.schema ?? "none"})`, { cause: e }))
	)

/**
 * Runs `folders` with the real apply runner as `owner`, the installation's owner login, on `database`, toward
 * `snapshot`.
 * The migration session is scoped to the apply alone: held for the caller's scope, every install of a suite would keep
 * an idle connection until the suite ends, and suites that install many schemas exhaust the cluster's connection slots.
 * Its session is a test helper's (test/support/pg.ts wireSession), which retries a connection attempt that timed out
 * in a loaded shared test process, not the command line's (openMigrationSession, which test/pg/migrate exercises):
 * installing a fixture is setup, and a suite's synchronous work in the same process must not fail it. The migration
 * session over it is the real one (migrationSession), so the apply sends exactly what `grizzle migrate apply` sends.
 */
const applyFolders = (
	owner: AmbientOwner,
	database: string,
	snapshot: DeploySnapshot,
	folders: ReadonlyArray<FolderSource>
): Effect.Effect<void, never, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const connection = yield* Effect.catch(
			wireSession(substrate.cluster, {
				database,
				username: owner.credentials.role,
				password: owner.credentials.password
			}),
			(e) =>
				Effect.die(
					new Error(
						`test install: no migration session on ${database}\n${inspect(e, { depth: 12 })}`,
						{
							cause: e
						}
					)
				)
		)
		yield* applied(applyOnSession(migrationSession(connection), [{ snapshot, folders }]))
	}).pipe(Effect.scoped)

/**
 * The installation of `plan` under the declared name `declared`, migrated by `folders` to `snapshot` in the
 * substrate's database as `ambientOwner`: every login given a password in the scope, through the substrate, so a test
 * logs in as it over verify-full TLS, and the lookups of its roles and logins by their values. The one representation
 * of an installation a test migrated, whether by one first migration (installMigrated) or a history of versions
 * (test/support/installed.ts migrated).
 */
export const installedOf = (input: {
	readonly plan: RealInstallPlan
	readonly declared: string
	readonly folders: Arr.NonEmptyReadonlyArray<FolderSource>
	readonly snapshot: DeploySnapshot
	readonly ambientOwner: AmbientOwner
}): Effect.Effect<Installed, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const { plan } = input
		const credentials = new Map<string, Credentials>()
		for (const login of Rec.values(plan.logins)) {
			const issued = yield* substrate.login(login.role)
			credentials.set(login.name, issued)
		}
		const credentialsOf = (name: string): Credentials =>
			defined(credentials.get(name), `the login ${name} of ${plan.declared}`)
		const world = (role: AnyRole | RoleDesc): SubstrateWorld => {
			for (const login of Rec.values(plan.logins)) {
				const r = login.roles[role.name]
				if (r !== undefined) {
					return { login: credentialsOf(login.name), role: r.role }
				}
			}
			throw new Error(`no role ${role.name} in ${plan.declared}`)
		}
		return {
			cluster: substrate.cluster,
			database: substrate.database,
			schema: plan.schema,
			declared: input.declared,
			installation: plan.installation,
			plan,
			names: plan.installation.names,
			folders: input.folders,
			snapshot: input.snapshot,
			ambientOwner: input.ambientOwner,
			role: (role) => world(role).role,
			as: (login) => credentialsOf(login.name),
			world
		}
	})

/**
 * What a migrated installation takes: the installation's own options, and the ambient session (test/support/ambient.ts)
 * its owner sessions start under, the migration's and the drift check's, its owner login's alone: a suite that draws
 * none states the cluster's own, ordinarySession.
 */
export interface MigratedOptions extends RealInstallOptions {
	readonly ambient: AmbientSession
}

/** The schemas an installation creates, its own first, then each role's: the grizzle-first path's schemas. */
export const installedSchemas = (installation: Installation): Arr.NonEmptyReadonlyArray<string> => [
	installation.names.schema,
	...Arr.flatMap(installation.statements, (s) =>
		s.kind === "createSchema" && s.name !== installation.names.schema ? [s.name] : []
	)
]

/**
 * Installs `schema` (a schema value, a SchemaDesc or an owned schema) under a unique schema name in the scope, through
 * its first migration, as the header describes, as an owner login of its own whose sessions start under the ambient
 * session `options.ambient` (test/support/ambient.ts ambientOwner), made before the migration and dropped when the
 * scope closes.
 *
 * Every installation holds the installed-catalog posture, whatever the suite tests.
 */
export const installMigrated = (
	schema: unknown,
	options: MigratedOptions
): Effect.Effect<
	Installed,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const desc = yield* fromEngine(schemaDescIn(schema))
		const name = yield* substrate.schema({ create: false, label: options.label })
		const plan = yield* fromEngine(
			completePlan(desc, identity.schema(parsedSchemaName(name)), substrate.owner.role, options)
		)
		const installation = plan.installation
		const g = yield* fromEngine(
			generate({
				installation,
				name: installName,
				timestamp: installTimestamp,
				previous: fromEmpty,
				workload: noWorkload,
				declared: noDeclarations
			})
		)
		const folder = folderSource(g.folder)
		const owner = yield* ambientOwner(options.ambient, installedSchemas(installation))
		yield* applyFolders(owner, substrate.database, g.snapshot, [folder])
		yield* expectFreshCatalog(desc, installation, folder, options)
		yield* Effect.fromResult(registerSnapshot(g.snapshot))
		const installed = yield* installedOf({
			plan,
			declared: name,
			folders: [folder],
			snapshot: g.snapshot,
			ambientOwner: owner
		})
		yield* checkInstallation(installed)
		return installed
	})

/**
 * Installs an installation once more in another database of the cluster, through the same migration, since Db.open
 * admits a schema only where its ledger and catalog are the snapshot's. Login and world roles are cluster-wide and
 * already exist, so the reviewer deletes the statements that create them; every other statement, the memberships and
 * the login defaults included, runs as drafted, and the state reached is the snapshot's. It runs as the installation's
 * owner login, whose ambient defaults are the substrate database's alone, so another database's sessions start under
 * none.
 */
export const installMigratedIn = (
	database: string,
	installed: Installed
): Effect.Effect<void, never, Substrate> =>
	applyFolders(
		installed.ambientOwner,
		database,
		installed.snapshot,
		Arr.map(installed.folders, (folder) => ({
			...folder,
			files: Arr.map(folder.files, (f) => ({
				name: f.name,
				text: Arr.join(
					Arr.filter(
						Str.split(f.text, "\n\n"),
						(statement) => !pipe(Str.trimStart(statement), Str.startsWith("CREATE ROLE "))
					),
					"\n\n"
				)
			}))
		}))
	)

/**
 * Stores `facts` (each relation's facts as field-to-host-value records) as typed literal INSERTs in one transaction, as
 * the owner.
 */
export const loadMigrated = (
	installed: Installed,
	facts: FactSet
): Effect.Effect<void, CompileError | SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		yield* loadFacts(substrate.admin, installed.plan, facts)
	})

/**
 * Replaces every stored relation's facts with its facts in `facts`, none where it names none, as the owner, in one
 * transaction that truncates every stored relation's table first (substrate/replace.ts installationGroup): the reset of
 * a case that reads and writes, which a reset reading the rows it deletes would make an SSI pivot under load. An
 * installation of closed relations alone stores nothing, and `facts` can name nothing of it.
 */
export const replaceMigrated = (
	installed: Installed,
	facts: FactSet
): Effect.Effect<void, CompileError | SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const statements = yield* fromEngine(factStatements(installed.plan, facts))
		yield* replaceRows(
			substrate.admin,
			installationGroup(namesOf(installed)),
			Arr.map(statements, (sql) => ({ sql, params: [] }))
		)
	})
