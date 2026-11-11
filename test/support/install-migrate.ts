import { inspect } from "node:util"
import {
	Array as Arr,
	DateTime,
	Effect,
	Option,
	Path,
	pipe,
	Record as Rec,
	type Scope,
	String as Str
} from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { applyOnSession, type SchemaApplyReport } from "#adapter/migrate/apply.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { migrationSession } from "#adapter/migrate/session.ts"
import { formatTimestamp } from "#cli/clock.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import * as Engine from "#compiler/core/result.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { folderName } from "#compiler/deploy/render/folder.ts"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { LoginDesc, RoleDesc } from "#compiler/ir/desc.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import type { AnySchema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { AnyLogin, AnyRole } from "#compiler/types/schema/world.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { installationAbstraction, sameCatalog } from "#test/pg/migrate/support.ts"
import { type AmbientOwner, type AmbientSession, ambientOwner } from "#test/support/ambient.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { checkInstallation } from "#test/support/catalog/installed.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"
import { draftedSql, type FixtureSchema, filledSql } from "#test/support/compile.ts"
import { paths, repoRoot } from "#test/support/files.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	draftCodes,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations,
	parsedMigrationName,
	type Previous
} from "#test/support/migrate/kit.ts"
import { type Placeholder, review } from "#test/support/migrate/review.ts"
import { type FactSet, factStatements, loadFacts } from "#test/support/oracle/install/load.ts"
import {
	type InstallCompile,
	type LoginSource,
	planRealInstall,
	type RealInstallOptions,
	type RealInstallPlan
} from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { type SqlError, wireSession } from "#test/support/pg.ts"
import { schemaDescIn } from "#test/support/policy.ts"
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
 *    row in its own transaction, and the drift check after it refuses any drift. A history of versions
 *    (installMigratedThrough) drafts each later version's folder from the snapshot the one before it reached, and the
 *    runner applies each in turn.
 * 4. The equality check. The migration must install the catalog the fresh-install compiler's script of the same
 *    installation installs, the ledger aside: the two paths must produce identical catalogs. An installation is
 *    certified from its statements when the migration runs the script's statements and otherwise only statements that
 *    leave no object, its privileges in the script's order (runsInstallScript); one it cannot certify is compared in
 *    full: the script runs under another allocated name and the two catalogs, function bodies, trigger events and view
 *    queries included, must be equal (test/pg/migrate/support.ts sameCatalog).
 * 5. The snapshot. The generated snapshot, of the schema rebuilt under the allocated name, stands for the committed
 *    `migrations/<schema>/snapshot.json` the application knows: a layer is given its JSON value (snapshot-json.ts
 *    snapshotValue), as an application's import of the file, and a Db opened on it, of a schema value of that name or
 *    of a level below it, admits the database against it.
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
	/**
	 * The credentials of the installation's decoder login (physical/ddl/live.ts), its role the live source's stem,
	 * issued through the substrate as each login's; an installation whose live plan reads no relation holds none, and
	 * asking for it is a defect of the test.
	 */
	readonly decoder: () => Credentials
	/** A role as a direct SQL writer takes it on: the credentials of the login that holds it, and its theory role. */
	readonly world: (role: AnyRole | RoleDesc) => SubstrateWorld
}

/** 2026-10-13T00:00:00Z, the instant an installation's first folder is drafted at. */
const installInstant = 1_791_849_600_000

/**
 * The time a history's folder `step`, from 0, is drafted at: `step` seconds after the first, as the CLI formats it, so
 * its folders sort in drafting order; the folder name only orders a schema's own migrations.
 */
const installTimestamp = (step: number): string =>
	formatTimestamp(DateTime.makeUnsafe(installInstant + step * 1000))
const installName = "install"

/**
 * How a version's installation is planned under an identity the naming door mints from a substrate's allocated name,
 * owned by a role: the complete installation (oracle/install/real.ts) with the codes its migration drafted, under the
 * history's own identity or another, a fresh install's.
 */
type VersionPlanner = (
	installation: Identity<"schema">,
	owner: string
) => Engine.Result<RealInstallPlan, CompileError>

/** The installation's script with every name minted under its schema's identity abstracted
 * (installationAbstraction): one key per installation shape. */
const shapeKey = (installation: Installation): string =>
	Arr.join(
		Arr.map(draftedSql(installation).statements, installationAbstraction(installation)),
		"\n"
	)

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
 * Whether the migrations, in order, provably install the fresh-install script's catalog, the ledger aside: they run every statement
 * of the script exactly once and otherwise only statements that leave no object; each object's grants and revokes, and
 * the default privileges, run in the script's order; and every default privilege runs after every object is created,
 * as in the script. Every other statement creates or alters an object of its own, so its position decides nothing a catalog
 * shows (a statement that needs an earlier one fails the apply instead). Both are read as migrate sends them into
 * `database` (filledSql), each variable filled.
 */
export const runsInstallScript = (
	folders: ReadonlyArray<FolderSource>,
	installation: Installation,
	database: string
): boolean => {
	const schema = installation.names.schema
	const script = Arr.map(filledSql(draftedSql(installation), database), normalized)
	const migration = Arr.map(
		filledSql(
			{
				statements: Arr.flatMap(folders, (folder) =>
					Arr.flatMap(folder.files, (f) => splitStatements(f.text))
				)
			},
			database
		),
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
 * Asserts that the migrated schema holds the catalog the fresh-install script of the same installation, planned with
 * the codes its migrations drafted, produces. An installation whose migrations runsInstallScript cannot certify is
 * compared in full: the fresh-install script runs under another allocated name, and the two catalogs, function bodies,
 * trigger events and view queries included, must be equal, the ledger aside, because the two paths must produce
 * identical catalogs. The fresh schema and its roles are dropped as soon as they are compared.
 */
export const expectFreshCatalog = (
	migrated: Installation,
	folders: ReadonlyArray<FolderSource>,
	planned: VersionPlanner
): Effect.Effect<void, CompileError | SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		if (runsInstallScript(folders, migrated, substrate.database)) {
			return
		}
		const fresh = yield* substrate.schema({ create: false, label: "fresh" })
		const plan = yield* fromEngine(
			planned(identity.schema(parsedSchemaName(fresh)), substrate.owner.role)
		)
		assert.equal(
			shapeKey(plan.installation),
			shapeKey(migrated),
			"the fresh install compiles the same script"
		)
		yield* transaction(substrate.admin, filledSql(plan.drafted, substrate.database))
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
		yield* applied(
			applyOnSession(migrationSession(connection, { database, roles: { kind: "stems" } }), [
				{ snapshot, folders }
			])
		)
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
		const { live } = plan.installation
		const decoder =
			live.tables.length + live.views.length === 0
				? undefined
				: yield* substrate.login(identifierOf(identity.liveSource(plan.installation.names.schema)))
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
			decoder: () =>
				defined(decoder, `the decoder login of ${plan.declared}, whose live plan reads a relation`),
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
 * One version of a history: its schema (a schema value, a SchemaDesc or an owned schema), the logins its installation
 * carries, over that schema as declared, and the renames and drops its migration declares (`--rename`, `--drop`;
 * noDeclarations for none), which its codes are drafted under too.
 */
export interface InstallVersion {
	readonly schema: FixtureSchema
	readonly logins: ReadonlyArray<LoginSource>
	readonly declarations: Declarations
}

/**
 * How every version of a history is drafted: with the caller's extensions, and by the compile of its installation,
 * compileInstallation, as `grizzle generate` composes it, or another compile of the same schema a suite installs beside
 * it, such as a lowering's trigger oracle (conservativeInstallation).
 */
interface DraftOptions {
	readonly extensions: ReadonlyArray<InstallExtension>
	readonly compile: InstallCompile
}

/**
 * What a history's installation takes beside its versions and how they are drafted: its label, and the ambient session
 * (test/support/ambient.ts) its owner sessions start under.
 */
export interface HistoryOptions extends DraftOptions {
	readonly label: string
	readonly ambient: AmbientSession
}

/**
 * One version of a history, as its migration drafts it: its plan and its reviewed folder, the snapshot it reaches, and
 * its planner under another identity, for a fresh install of it (expectFreshCatalog).
 */
export interface DraftedVersion {
	readonly plan: RealInstallPlan
	readonly planned: VersionPlanner
	readonly folder: FolderSource
	readonly snapshot: DeploySnapshot
}

/** Where a version is drafted: its installation identity, its owner, the snapshot before it, and its folder's step. */
interface DraftAt {
	readonly installation: Identity<"schema">
	readonly owner: string
	readonly previous: Previous
	readonly step: number
}

/** A drafted folder's placeholder: a defect of the test, since a history's caller states every value in its schema. */
const noPlaceholder = (placeholder: Placeholder): string => {
	throw new Error(`a history drafted a placeholder of ${placeholder.table.name}`)
}

/**
 * `version` as `grizzle generate` drafts it `at` its step, from 0, of a history: planned under the identity by
 * `options.compile` with its logins, the caller's extensions and the codes its declarations draft from the snapshot
 * before it (migrate/kit.ts draftCodes), its folder, drafted under the same declarations at its step's instant,
 * reviewed as a person reviews it with every loss written in (migrate/review.ts), and the snapshot it reaches.
 */
export const draftVersion = (
	version: InstallVersion,
	at: DraftAt,
	options: DraftOptions
): Effect.Effect<DraftedVersion, CompileError> =>
	Effect.gen(function* () {
		const desc = yield* fromEngine(schemaDescIn(version.schema))
		const codes = yield* fromEngine(draftCodes(desc, at.previous, version.declarations))
		const planned: VersionPlanner = (installation, owner) =>
			planRealInstall(desc, {
				installation,
				owner,
				logins: version.logins,
				extensions: options.extensions,
				codes,
				compile: options.compile
			})
		const plan = yield* fromEngine(planned(at.installation, at.owner))
		const g = yield* fromEngine(
			generate({
				installation: plan.installation,
				name: installName,
				timestamp: installTimestamp(at.step),
				previous: at.previous,
				workload: noWorkload,
				declared: version.declarations
			})
		)
		const reviewed = review(g, { losses: "written", value: noPlaceholder })
		return {
			plan,
			planned,
			folder: { name: g.folder.name, metaText: g.folder.metaText, files: reviewed.files },
			snapshot: g.snapshot
		}
	})

/**
 * Installs the last of `versions` under a unique schema name in the scope through a history, as the header describes:
 * the first version's migration from the empty snapshot, then each later version's from the snapshot the one before it
 * reached, each drafted under that name (draftVersion) and applied in turn by the real runner, every one of which must
 * apply, as an owner login of its own whose sessions start under the ambient session `options.ambient`
 * (test/support/ambient.ts ambientOwner), made before the first migration and dropped when the scope closes. A history
 * of one version is a first migration. The fresh install the history's catalog is compared with is the last version's,
 * planned with the same codes.
 *
 * Every installation holds the installed-catalog posture, whatever the suite tests.
 */
export const installMigratedThrough = (
	versions: Arr.NonEmptyReadonlyArray<InstallVersion>,
	options: HistoryOptions
): Effect.Effect<
	Installed,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: options.label })
		const installation = identity.schema(parsedSchemaName(name))
		const drafts: Array<DraftedVersion> = []
		let previous: Previous = fromEmpty
		for (const [step, version] of versions.entries()) {
			const drafted = yield* draftVersion(
				version,
				{ installation, owner: substrate.owner.role, previous, step },
				options
			)
			drafts.push(drafted)
			previous = fromSnapshot(drafted.snapshot)
		}
		const history = nonEmpty(drafts, "a history has its first version")
		const last = Arr.lastNonEmpty(history)
		const folders = Arr.map(history, (d) => d.folder)
		const owner = yield* ambientOwner(options.ambient, installedSchemas(last.plan.installation))
		for (const [step, draft] of history.entries()) {
			yield* applyFolders(owner, substrate.database, draft.snapshot, Arr.take(folders, step + 1))
		}
		yield* expectFreshCatalog(last.plan.installation, folders, last.planned)
		const installed = yield* installedOf({
			plan: last.plan,
			declared: name,
			folders,
			snapshot: last.snapshot,
			ambientOwner: owner
		})
		yield* checkInstallation(installed)
		return installed
	})

/**
 * Installs `schema` through its first migration (installMigratedThrough), planned as `grizzle generate` composes it
 * (compileInstallation), with the logins and extensions of `options`.
 */
export const installMigrated = (
	schema: FixtureSchema,
	options: MigratedOptions
): Effect.Effect<
	Installed,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	installMigratedThrough([{ schema, logins: options.logins, declarations: noDeclarations }], {
		label: options.label,
		extensions: options.extensions,
		ambient: options.ambient,
		compile: compileInstallation
	})

/**
 * A schema installed as `grizzle generate` drafts it with its logins (installGenerated): the installation, which holds
 * each role at the level its served workload certifies (program/isolation/certification.ts) and keeps each table's
 * guard by those levels, and each login's served file, projected from the same plan at the same levels (servedFiles),
 * by the login's declared name.
 */
export interface Generated {
	readonly installed: Installed
	readonly served: ReadonlyMap<string, unknown>
}

/** Where a generated installation's configuration stands, for its directories alone: nothing is read from it. */
const generatedConfig = `${repoRoot}app/grizzle.config.ts`

/**
 * Installs `build(name)` under a unique schema name `name` in the scope as `grizzle generate` drafts and serves it: its
 * configuration resolved and compiled as the command line compiles it (cli/config.ts), its first migration drafted from
 * the empty snapshot with its logins' served workload certified once (cli/generate.ts draftSchema), named, reviewed
 * and applied by the real runner as installMigrated's is, as an owner login of its own whose sessions start under
 * `options.ambient`, and each login's served file projected from the same plan (servedFiles). Its catalog is the fresh
 * install's, since its migration runs the installation's script alone (runsInstallScript); a draft that does not, or
 * one the command line refuses, is a defect of the setup.
 */
export const installGenerated = (
	build: (name: string) => {
		readonly schema: AnySchema
		readonly logins: ReadonlyArray<AnyLogin>
	},
	options: { readonly label: string; readonly ambient: AmbientSession }
): Effect.Effect<Generated, CompileError | SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: options.label })
		const declared = build(name)
		const desc = yield* fromEngine(schemaDescIn(declared.schema))
		const codes = yield* fromEngine(draftCodes(desc, fromEmpty, noDeclarations))
		const { draft, entries } = yield* Effect.orDie(
			Effect.provideService(
				Effect.gen(function* () {
					const config = yield* resolveConfig(
						defineConfig({
							schemas: [declared.schema],
							logins: declared.logins,
							migrations: "migrations",
							connection: () => offlineOwner
						}),
						generatedConfig
					)
					const configured = defined(config.schemas[0], "the generated schema's configuration")
					const compiled = yield* Effect.fromResult(compileSchema(configured))
					const drafted = yield* draftSchema(
						compiled,
						emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
						[],
						noDeclarations
					)
					const served = yield* servedFiles(compiled, drafted.snapshotFiles, drafted.served)
					return { draft: drafted, entries: served }
				}),
				Path.Path,
				paths
			)
		)
		const folderAt = yield* fromEngine(
			folderName(installTimestamp(0), parsedMigrationName(installName))
		)
		const reviewed = review(
			{ ...draft, folder: { name: folderAt, ...draft.folder } },
			{ losses: "written", value: noPlaceholder }
		)
		const folder: FolderSource = {
			name: folderAt,
			metaText: draft.folder.metaText,
			files: reviewed.files
		}
		assert.ok(
			runsInstallScript([folder], draft.installation, substrate.database),
			"generate's first migration runs the installation's script alone"
		)
		const owner = yield* ambientOwner(options.ambient, installedSchemas(draft.installation))
		yield* applyFolders(owner, substrate.database, draft.snapshot, [folder])
		const plan = yield* fromEngine(
			planRealInstall(declared.schema, {
				installation: identity.schema(parsedSchemaName(name)),
				owner: substrate.owner.role,
				logins: declared.logins,
				extensions: [],
				codes,
				compile: () => Engine.ok(draft.installation)
			})
		)
		const installed = yield* installedOf({
			plan,
			declared: name,
			folders: [folder],
			snapshot: draft.snapshot,
			ambientOwner: owner
		})
		yield* checkInstallation(installed)
		return {
			installed,
			served: new Map(Arr.map(entries, (e) => [e.login, trustedJson<unknown>(e.text)] as const))
		}
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
