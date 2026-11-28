import { inspect } from "node:util"
import { ChunkView, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import type { Content } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Effect,
	Option,
	Path,
	pipe,
	Record as Rec,
	Redacted,
	type Scope,
	String as Str
} from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { applyOnSession, type SchemaApplyReport } from "#adapter/migrate/apply.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import { type FolderTexts, folderSource } from "#adapter/migrate/input.ts"
import { migrationSession } from "#adapter/migrate/session.ts"
import { served as servedLogin } from "#adapter/public/layer.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import { type CompiledSchema, compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchemaUnder, eachServedFile } from "#cli/generate.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { bookkeepingTables } from "#compiler/deploy/ledger/ledger.ts"
import { filed } from "#compiler/deploy/render/filed.ts"
import { folderName } from "#compiler/deploy/render/folder.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { LoginDesc, RoleDesc } from "#compiler/ir/desc.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import type { AnySchema } from "#compiler/public/schema.ts"
import { lex, type Token } from "#compiler/sql/lexer.ts"
import type { AnyLogin, AnyRole } from "#compiler/types/schema/world.ts"
import { defineConfig } from "#index.ts"
import {
	type AmbientOwner,
	type AmbientSession,
	ambientOwner,
	templateAmbientOwner
} from "#test/support/ambient.ts"
import { checkInstallation } from "#test/support/catalog/installed.ts"
import { chunked, joined, jsonOf } from "#test/support/chunked.ts"
import { draftedSql, type FixtureSchema, filledSql, migratedSql } from "#test/support/compile.ts"
import { paths, repoRoot } from "#test/support/files.ts"
import { asCompiler, installedPlan, keptHistory } from "#test/support/generate-draft.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations,
	parsedMigrationName,
	type Previous
} from "#test/support/migrate/kit.ts"
import { type Decisions, type Placeholder, review } from "#test/support/migrate/review.ts"
import { type FactSet, factStatements, loadFacts } from "#test/support/oracle/install/load.ts"
import {
	type InstallCompile,
	planRealInstall,
	type RealInstallPlan
} from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { type SqlError, wireSession } from "#test/support/pg.ts"
import { offlineOwner } from "#test/support/pg/cli/support.ts"
import { installationAbstraction, sameCatalog } from "#test/support/pg/migrate/support.ts"
import { schemaDescIn } from "#test/support/policy.ts"
import type { BudgetedCluster } from "#test/support/substrate/budget.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { type TemplateNames } from "#test/support/substrate/names.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import type { Credentials, SubstrateWorld } from "#test/support/substrate/session.ts"
import {
	type TemplateBinding,
	installTemplate,
	Substrate,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"
import { templatePassword } from "#test/support/substrate/templates.ts"

import { regex } from "arkregex"
import { silentPhases } from "#compiler/core/phase.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
/**
 * Installing a compiled schema into the test file's database through its migrations.
 *
 * A schema is installed the way a deployment installs it: `grizzle generate` drafts its first migration from the empty
 * snapshot, and `grizzle migrate` runs that folder as the migration identity, which owns the schema. In order:
 *
 * 1. The name. The substrate allocates a unique schema name, because login and world roles are cluster-wide and every
 *    pg and schedules file instantiates its fixtures afresh, and the schema is installed under the identity the naming
 *    door mints from it (Installed.schema is that identity's identifier). A test opens the installation through the
 *    schema rebuilt under the allocated name itself (Installed.declared) from the same relations, functions and
 *    statements (installed.ts rebuild): the installed schema but for its declared name, whose only physical consequence
 *    is the PostgreSQL schema.
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
 *    runner applies each in turn; a generated history (installGeneratedThrough) drafts each as `grizzle generate` does,
 *    with its logins' served files, and applies its later versions when the test says.
 * 4. The equality check. The migration must install the catalog the fresh-install compiler's script of the same
 *    installation installs, the ledger aside: the two paths must produce identical catalogs. An installation is
 *    certified from its statements when the migration runs the script's statements and otherwise only statements that
 *    leave no object, its privileges in the script's order (runsInstallScript); one it cannot certify is compared in
 *    full: the script runs under another allocated name and the two catalogs, function bodies, trigger events and view
 *    queries included, must be equal (test/support/pg/migrate/support.ts sameCatalog).
 * 5. The snapshot. The generated snapshot, of the schema rebuilt under the allocated name, stands for the committed
 *    `migrations/<schema>/snapshot.json` the application knows: a layer is given its JSON value (snapshot-json.ts
 *    snapshotValue), as an application's import of the file, and a Db opened on it, of a schema value of that name or
 *    of a level below it, admits the database against it.
 * 6. Logins. An installation with logins is drafted as `grizzle generate` drafts it (generatedDraft), with the logins
 *    the caller gives over the schema built under the allocated name, its served workload's grants, certificates,
 *    carriers, calls and fences among it, and each login's served file: no other draft carries a login (draftVersion
 *    drafts none). Every login role gets a password through the substrate, so a test logs in as it over verify-full
 *    TLS exactly as a grizzle connection or a psql writer would, and takes on a role of it per transaction or session;
 *    the substrate's schema finalizer drops the schema and its roles.
 * 7. The posture. The installed-catalog checker (test/support/catalog checkInstallation) judges the catalog the
 *    migration reached against its installation: worlds, policies, filter and advance functions, grants, memberships
 *    and login defaults, so every suite's installation holds the posture whatever the suite tests. An installation in
 *    another database (installMigratedIn) is the first one's copy, judged with it.
 */
export interface Installed {
	/**
	 * The initialised cluster of the substrate it was migrated in, with its file's budget: the CA its logins'
	 * connections verify, and the permits each of them draws.
	 */
	readonly cluster: BudgetedCluster
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
	readonly folders: Arr.NonEmptyReadonlyArray<FolderTexts>
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
	 * The credentials of the installation's decoder login (physical/ddl/live.ts), the role its served logins name
	 * (ServedLogin decoder, roleNameOf), issued through the substrate as each login's; an installation no served login
	 * of which reads, or one installed unserved (installMigrated), holds none, and asking for it is a defect of the test.
	 */
	readonly decoder: () => Credentials
	/** A role as a direct SQL writer takes it on: the credentials of the login that holds it, and its theory role. */
	readonly world: (role: AnyRole | RoleDesc) => SubstrateWorld
}

const installName = "install"

/**
 * How a version's installation is planned for a fresh install of it (expectFreshCatalog): under the identity the
 * naming door mints from another allocated name, owned by a role, the complete installation (oracle/install/real.ts)
 * with the codes its migration drafted.
 */
type VersionPlanner = (fresh: string) => Effect.Effect<RealInstallPlan, CompileError>

/** The installation's script with every name minted under its schema's identity abstracted
 * (installationAbstraction): one key per installation shape. */
const shapeKey = (installation: Installation): string =>
	Arr.join(
		Arr.map(draftedSql(installation).statements, installationAbstraction(installation)),
		"\n"
	)

const normalized = (statement: string): string =>
	pipe(Str.trim(statement), Str.replace(regex(";$"), ""))

/** Whether a token is the word `word`, as PostgreSQL folds an unquoted word. */
const isWord = (t: Token | undefined, word: string): t is Token =>
	t?.kind === "word" && t.upper === word

/** Whether a token is the punctuation `text`. */
const isPunct = (t: Token | undefined, text: string): boolean =>
	t?.kind === "punct" && t.text === text

/**
 * The units a statement installs, which runsInstallScript counts: each subcommand of an ALTER TABLE under the table's
 * head, and any other statement whole. A migration drafts one ALTER TABLE per table and slot (deploy/diff/diff.ts
 * Differ.alter) where the script holds one per object, and PostgreSQL runs one statement's subcommands pass by pass as
 * it runs them in statements of their own, so the subcommand is the unit both share. A subcommand ends at a comma
 * outside every parenthesis and bracket, read by PostgreSQL's scanner (sql/lexer.ts), so no comma of a string, a
 * quoted identifier or an expression splits one; its text runs from its first token to its last, so the line breaks
 * between subcommands compare alike. A statement the scanner does not read to its end is one unit, compared whole.
 */
const unitsOf = (statement: string): ReadonlyArray<string> => {
	const { tokens, error } = lex(statement)
	const [alter, table, name] = tokens
	if (
		error !== undefined ||
		!isWord(alter, "ALTER") ||
		!isWord(table, "TABLE") ||
		name === undefined
	) {
		return [statement]
	}
	let first = 3
	while (isPunct(tokens[first], ".") && tokens[first + 1] !== undefined) {
		first += 2
	}
	const start = tokens[first]?.start
	if (start === undefined) {
		return [statement]
	}
	const head = Str.trim(Str.slice(alter.start, start)(statement))
	const ends: Array<number> = []
	let depth = 0
	for (const t of tokens.slice(first)) {
		if (isPunct(t, "(") || isPunct(t, "[")) {
			depth++
		} else if (isPunct(t, ")") || isPunct(t, "]")) {
			depth--
		} else if (depth === 0 && isPunct(t, ",")) {
			ends.push(t.start)
		}
	}
	const bounds = Arr.zip([start, ...Arr.map(ends, (e) => e + 1)], [...ends, statement.length])
	return Arr.map(bounds, ([from, to]) => `${head} ${Str.trim(Str.slice(from, to)(statement))}`)
}

/** A statement without its leading comment lines. */
const body = (statement: string): string =>
	Str.trim(
		Arr.join(
			Arr.filter(Str.split(statement, "\n"), (l) => !pipe(Str.trimStart(l), Str.startsWith("--"))),
			"\n"
		)
	)

/**
 * A statement a first migration runs beyond the fresh-install script that leaves no object but grizzle's bookkeeping
 * tables beside it (deploy/ledger/ledger.ts bookkeepingTables, kernel/naming.ts isBookkeepingObject): a table's own DDL,
 * guard trigger, grants and declared statistics (its ALTER TABLE, and the DO block restoring them, which names the table
 * by its name as a literal), the LOCK opening a residual law's Validate file, the DO block running the law's full
 * violation query there, which reads and raises only, the DO block reading a zone roster's handles as time zones in
 * Setup, which reads and raises only too, and the INSERT that fills a stored derived relation's table the migration
 * creates (FillStored), which writes its rows and makes no object. The snapshot guard's function names the
 * ledger in its body and the live source's publication publishes it, but each is the installation's own object, in the
 * script too, so a CREATE ... FUNCTION or a CREATE PUBLICATION is never one. A DO block is its command whatever its
 * body's spelling: dollar-quoted, or the escape string a drafted file spells a body holding a control character as
 * (deploy/render/filed.ts filed).
 */
const leavesNoObject = (statement: string, schema: string): boolean => {
	const text = body(statement)
	return (
		(Arr.some(bookkeepingTables, (b) =>
			pipe(text, Str.includes(`${quoteIdent(schema)}.${quoteIdent(b.name)}`))
		) &&
			!Str.startsWith("CREATE OR REPLACE FUNCTION ")(text) &&
			!Str.startsWith("CREATE PUBLICATION ")(text)) ||
		Str.startsWith("LOCK TABLE ")(text) ||
		Str.startsWith("INSERT INTO ")(text) ||
		(Str.startsWith("DO ")(text) &&
			(Str.includes("-- The full violation query of law ")(statement) ||
				Str.includes("-- The time zones of roster ")(statement) ||
				(Str.includes('"pg_catalog"."pg_restore_attribute_stats"(')(text) &&
					Arr.some(bookkeepingTables, (b) => pipe(text, Str.includes(quoteString(b.name)))))))
	)
}

/** A relation alias a scope mints (sql/naming.ts Alias, `r<n>`), as a quoted identifier's text. */
const scopeAlias = regex("^r[0-9]+$")

/**
 * `unit` with each relation alias a scope minted (scopeAlias) named by its first appearance in it, `r1` first: one
 * statement up to the names of the aliases it binds. A migration's file binds every data step it drafts under its
 * transaction's one advice scope (deploy/render/advise.ts), so a step mints its aliases after the file's earlier steps'
 * (two refined constants' validations in Publish read `r1` and `r2`), where the script prints each statement under a
 * scope of its own, every one's first alias `r1`; a statement's meaning is the same under any names of the aliases it
 * binds. A quoted identifier is its lexeme (sql/lexer.ts), so no string or dollar-quoted body is renamed.
 */
const boundAliases = (unit: string): string => {
	const named = new Map<string, string>()
	const pieces: Array<string> = []
	let at = 0
	for (const t of lex(unit).tokens) {
		if (t.kind !== "quotedIdent" || !scopeAlias.test(t.text)) {
			continue
		}
		const name = named.get(t.text) ?? `r${named.size + 1}`
		named.set(t.text, name)
		pieces.push(Str.slice(at, t.start)(unit), quoteIdent(name))
		at = t.start + quoteIdent(t.text).length
	}
	pieces.push(Str.slice(at)(unit))
	return Arr.join(pieces, "")
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
 * Whether the migrations, in order, provably install the fresh-install script's catalog, the ledger aside, which the
 * live source's publication publishes too (compile.ts migratedSql): they run every unit of the script (unitsOf: a
 * statement, or a subcommand of an ALTER TABLE) exactly once and otherwise only units that leave no object; each
 * object's grants and revokes, and the default privileges, run in the script's order; and every default privilege runs
 * after every object is created, as in the script. Every other unit creates or alters an object of its own, so its
 * position decides nothing a catalog shows (a unit that needs an earlier one fails the apply instead). Both are read
 * as migrate sends them into `database` (filledSql), each variable filled, and split as migrate splits a file
 * (render/markers.ts splitStatements): a drafted statement may print two, as a grant on the database prints its lock
 * before it (sql/print.ts databaseWide), two on both sides. The script is spelled as a drafted file spells it
 * (deploy/render/filed.ts filed): a constant holding a control character or a line or paragraph separator is the escape
 * string of the same value, the one constant PostgreSQL reads from either spelling. A unit is read up to the names of
 * the relation aliases it binds (boundAliases), which a migration's file mints under its transaction's one advice scope.
 */
export const runsInstallScript = (
	folders: ReadonlyArray<FolderTexts>,
	installation: Installation,
	database: string
): boolean => {
	const schema = installation.names.schema
	const script = Arr.flatMap(
		filledSql(
			{
				statements: Arr.flatMap(migratedSql(installation).statements, (s) =>
					splitStatements(filed(s))
				)
			},
			database
		),
		(s) => Arr.map(unitsOf(normalized(s)), boundAliases)
	)
	const migration = Arr.flatMap(
		filledSql(
			{
				statements: Arr.flatMap(folders, (folder) =>
					Arr.flatMap(folder.files, (f) => splitStatements(new ChunkView(f.text)))
				)
			},
			database
		),
		(s) => Arr.map(unitsOf(normalized(s)), boundAliases)
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
			 * object, and is keyed by its granted role and its member, a role or the migration identity, CURRENT_USER, as the
			 * function owner is adopted (sql/ast.ts AdoptRole), the pair whose grants and revokes are ordered; ALTER DEFAULT
			 * PRIVILEGES, which names an object class there, is the one sequence of its own.
			 */
			const membership = regex(
				'^(?:GRANT|REVOKE)(?: (?:ADMIN|INHERIT|SET) OPTION FOR)? ("[^"]+") (?:TO|FROM) ("[^"]+"|CURRENT_USER)'
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
	folders: ReadonlyArray<FolderTexts>,
	planned: VersionPlanner
): Effect.Effect<void, CompileError | SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		if (runsInstallScript(folders, migrated, substrate.database)) {
			return
		}
		const fresh = yield* substrate.schema({ create: false, label: "fresh" })
		const plan = yield* planned(fresh)
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
const applied = <R>(
	effect: Effect.Effect<ReadonlyArray<SchemaApplyReport>, MigrateError, R>
): Effect.Effect<ReadonlyArray<SchemaApplyReport>, never, R> =>
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
 * The runner's refusal is its MigrateError, for a suite that judges it; applyFolders refuses as a defect of the setup.
 */
export const migrateFolders = (
	owner: AmbientOwner,
	database: string,
	snapshot: DeploySnapshot,
	folders: ReadonlyArray<FolderTexts>
): Effect.Effect<ReadonlyArray<SchemaApplyReport>, MigrateError, Substrate> =>
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
		return yield* applyOnSession(
			migrationSession(connection, { database, roles: { kind: "stems" } }),
			[{ snapshot, folders: Arr.map(folders, folderSource) }]
		)
	}).pipe(Effect.scoped)

/** Runs `folders` as migrateFolders does, a refusal a defect of the test's setup (applied). */
const applyFolders = (
	owner: AmbientOwner,
	database: string,
	snapshot: DeploySnapshot,
	folders: ReadonlyArray<FolderTexts>
): Effect.Effect<void, never, Substrate> =>
	Effect.asVoid(applied(migrateFolders(owner, database, snapshot, folders)))

/**
 * The decoder login the served files `files` name, each login's by its declared name, as an operator names the role
 * whose password LiveSource.layer takes: each served login's `decoder`, its PostgreSQL role under the installation's
 * role space, the stems' (roleNameOf), once; none where no served login reads, or no file was served.
 */
const decoderRoles = (files: ReadonlyMap<string, unknown>): ReadonlyArray<string> => [
	...new Set(
		Arr.flatMap([...files], ([name, json]) => {
			const { decoder } = servedLogin<AnyLogin>(json, name)
			return decoder.kind === "none" ? [] : [roleNameOf(decoder, {})]
		})
	)
]

/** Every login role of `plan`, and the decoder login its served files `files` name (decoderRoles). */
const loginRoles = (
	plan: RealInstallPlan,
	files: ReadonlyMap<string, unknown>
): ReadonlyArray<string> => [
	...Arr.map(Rec.values(plan.logins), (l) => l.role),
	...decoderRoles(files)
]

/**
 * The credentials of every login role of a template's installation `plan` and of the decoder login its served files
 * `files` name, as a case over a clone of the template logs in (substrate.ts installTemplate): each role's password the
 * member's owner password derives (templates.ts templatePassword), as the template's build gave it.
 */
const templateCredentials = (
	binding: TemplateBinding,
	roles: ReadonlyArray<string>
): ReadonlyMap<string, Credentials> =>
	new Map(Arr.map(roles, (role) => [role, templateLogin(binding, role)]))

/** The credentials of `role`, a login of a template's installation (templateCredentials). */
const templateLogin = (binding: TemplateBinding, role: string): Credentials => ({
	role,
	password: Redacted.make(templatePassword(binding.cluster, role))
})

/**
 * The credentials of every login role of `plan` and of the decoder login its served files `files` name (decoderRoles),
 * by PostgreSQL role: each one `kept` holds kept, as a later version of a history keeps every login it continues, whose
 * served layers log in with that password, and each other given a password in the scope through the substrate.
 */
export const loginCredentials = (
	plan: RealInstallPlan,
	files: ReadonlyMap<string, unknown>,
	kept: ReadonlyMap<string, Credentials>
): Effect.Effect<ReadonlyMap<string, Credentials>, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const credentials = new Map(kept)
		for (const role of loginRoles(plan, files)) {
			credentials.set(role, credentials.get(role) ?? (yield* substrate.login(role)))
		}
		return credentials
	})

/** What an installation is made of, whichever way it was installed (installedOf, installedAt). */
interface InstalledParts {
	readonly plan: RealInstallPlan
	readonly declared: string
	readonly folders: Arr.NonEmptyReadonlyArray<FolderTexts>
	readonly snapshot: DeploySnapshot
	readonly ambientOwner: AmbientOwner
	readonly files: ReadonlyMap<string, unknown>
	readonly credentials: ReadonlyMap<string, Credentials>
}

/**
 * The installation of `plan` under the declared name `declared`, migrated by `folders` to `snapshot` in `binding`'s
 * database as `ambientOwner`, each login and the decoder its served files `files` name logging in with its
 * `credentials` (loginCredentials), so a test logs in as it over verify-full TLS, and the lookups of its roles and
 * logins by their values. The one representation of an installation a test migrated, whether by one first migration
 * (installMigrated), a history of versions (installMigratedThrough, test/support/installed.ts migrated), generate's
 * (installGeneratedThrough), or a template's, bound to a case's clone of it (migratedTemplate).
 */
const installedAt = (input: InstalledParts, binding: TemplateBinding): Installed => {
	const { plan, credentials } = input
	const credentialsOf = (role: string): Credentials =>
		defined(credentials.get(role), `the login role ${role} of ${plan.declared}`)
	const loginOf = (name: string) =>
		defined(plan.logins[name], `the login ${name} of ${plan.declared}`)
	const world = (role: AnyRole | RoleDesc): SubstrateWorld => {
		for (const login of Rec.values(plan.logins)) {
			const r = login.roles[role.name]
			if (r !== undefined) {
				return { login: credentialsOf(login.role), role: r.role }
			}
		}
		throw new Error(`no role ${role.name} in ${plan.declared}`)
	}
	return {
		cluster: binding.cluster,
		database: binding.database,
		schema: plan.schema,
		declared: input.declared,
		installation: plan.installation,
		plan,
		names: plan.installation.names,
		folders: input.folders,
		snapshot: input.snapshot,
		ambientOwner: input.ambientOwner,
		role: (role) => world(role).role,
		as: (login) => credentialsOf(loginOf(login.name).role),
		decoder: () =>
			credentialsOf(
				defined(
					decoderRoles(input.files)[0],
					`the decoder login of ${plan.declared}, which a served login that reads names`
				)
			),
		world
	}
}

/** The installation of `input` in the substrate's database (installedAt). */
export const installedOf = (input: InstalledParts): Effect.Effect<Installed, never, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		return installedAt(input, substrate)
	})

/**
 * What a migrated installation takes: the label of its allocated schema name, the installer extensions besides the
 * residual laws' and the derived relations' (oracle/install/real.ts RealPlanOptions), and the ambient session
 * (test/support/ambient.ts) its owner sessions start under, the migration's and the drift check's, its owner login's
 * alone: a suite that draws none states the cluster's own, ordinarySession. It carries no login: an installation with
 * logins is drafted as `grizzle generate` drafts it (installGenerated).
 */
interface MigratedOptions {
	readonly label: string
	readonly extensions: ReadonlyArray<InstallExtension>
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
 * One version of a history without logins: its schema (a schema value, a SchemaDesc or an owned schema), and the
 * renames and drops its migration declares (`--rename`, `--drop`; noDeclarations for none), which its codes are drafted
 * under too. A version with logins is a GeneratedVersion, drafted as `grizzle generate` drafts it (generatedDraft).
 */
interface InstallVersion {
	readonly schema: FixtureSchema
	readonly declarations: Declarations
}

/**
 * How each drafted folder of a history is reviewed: with no placeholder, one of which is the test's defect; with the
 * placeholders' values; or with their values and the reviewer's data steps, each reviewed file of a version's folder
 * as `edit` writes it, given the version's index, as a person adds an UPDATE before a placeholder's DROP DEFAULT.
 */
export type Review =
	| { readonly kind: "noPlaceholders" }
	| { readonly kind: "values"; readonly value: Decisions["value"] }
	| {
			readonly kind: "reviewed"
			readonly value: Decisions["value"]
			readonly edit: (version: number, file: ReviewedText) => string
	  }

/** A review of folders that hold no placeholder (Review `noPlaceholders`). */
export const noPlaceholders: Review = { kind: "noPlaceholders" }

/** A reviewed file of a drafted folder: its name and its text. */
export interface ReviewedText {
	readonly name: string
	readonly text: string
}

/**
 * How every version of a history is drafted: with the caller's extensions, by the compile of its installation,
 * compileInstallation, as `grizzle generate` composes it, or another compile of the same schema a suite installs beside
 * it, such as a lowering's trigger oracle (conservativeInstallation), and each folder reviewed as `review` says.
 */
interface DraftOptions {
	readonly extensions: ReadonlyArray<InstallExtension>
	readonly compile: InstallCompile
	readonly review: Review
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
	readonly folder: FolderTexts
	readonly snapshot: DeploySnapshot
}

/** Where a version is drafted: its installation identity, the snapshot before it, and its folder's step. */
interface DraftAt {
	readonly installation: Identity<"schema">
	readonly previous: Previous
	readonly step: number
}

/** A drafted folder's placeholder under no value: a defect of the test, whose history states every value it drafts. */
const noPlaceholder = (placeholder: Placeholder): string => {
	throw new Error(
		`a history drafted a placeholder of ${placeholder.table.name}, and no review value`
	)
}

/** The placeholder values `review` gives a folder's review. */
const reviewValue = (review: Review): Decisions["value"] =>
	review.kind === "noPlaceholders" ? noPlaceholder : review.value

/** A reviewed file of version `version` as `review` writes it. */
const reviewedText = (
	review: Review,
	version: number,
	file: { readonly name: string; readonly text: TextChunks }
): TextChunks =>
	review.kind === "reviewed"
		? chunked(review.edit(version, { name: file.name, text: joined(file.text) }))
		: file.text

/**
 * `version` drafted `at` its step, from 0, of a history whose installation carries no login and serves no workload:
 * planned under the identity by `options.compile` with the caller's extensions, and the codes its declarations draft
 * from the snapshot before it (migrate/kit.ts draftCodes), its folder, drafted under the same declarations at its step's
 * instant, reviewed as a person reviews it with every loss written in (migrate/review.ts) as `options.review` says, and
 * the snapshot it reaches. A version with logins is drafted as `grizzle generate` drafts it (generatedDraft), its
 * served workload's grants and certificates among it.
 */
export const draftVersion = (
	version: InstallVersion,
	at: DraftAt,
	options: DraftOptions
): Effect.Effect<DraftedVersion, CompileError> =>
	Effect.gen(function* () {
		const desc = yield* fromEngine(schemaDescIn(version.schema))
		const codes = yield* fromEngine(draftCodes(desc, at.previous, version.declarations))
		const plannedUnder = (installation: Identity<"schema">) =>
			planRealInstall(desc, {
				installation,
				extensions: options.extensions,
				codes,
				compile: options.compile
			})
		const plan = yield* fromEngine(plannedUnder(at.installation))
		const g = yield* fromEngine(
			generate({
				installation: plan.installation,
				name: installName,
				timestamp: draftedAt(at.step),
				previous: at.previous,
				workload: noWorkload,
				declared: version.declarations
			})
		)
		const reviewed = review(g, { losses: "written", value: reviewValue(options.review) })
		return {
			plan,
			planned: (fresh) => fromEngine(plannedUnder(identity.schema(parsedSchemaName(fresh)))),
			folder: {
				name: g.folder.name,
				metaText: g.folder.metaText,
				files: Arr.map(reviewed.files, (f) => ({
					name: f.name,
					text: reviewedText(options.review, at.step, f)
				}))
			},
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
const installMigratedThrough = (
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
		const history = yield* draftedHistory(versions, options, name)
		return yield* appliedHistory(history, name, options, new Map())
	})

/**
 * Every version of `versions` drafted under the name `name` (draftVersion): the first from the empty snapshot, each
 * later one from the snapshot the one before it reached. Pure: what installMigratedThrough and migrated apply.
 */
export const draftedHistory = (
	versions: Arr.NonEmptyReadonlyArray<InstallVersion>,
	options: DraftOptions,
	name: string
): Effect.Effect<Arr.NonEmptyReadonlyArray<DraftedVersion>, CompileError> =>
	Effect.gen(function* () {
		const installation = identity.schema(parsedSchemaName(name))
		const drafts: Array<DraftedVersion> = []
		let previous: Previous = fromEmpty
		for (const [step, version] of versions.entries()) {
			const drafted = yield* draftVersion(version, { installation, previous, step }, options)
			drafts.push(drafted)
			previous = fromSnapshot(drafted.snapshot)
		}
		return nonEmpty(drafts, "a history has its first version")
	})

/**
 * A drafted history (draftedHistory) applied under `name` in the substrate's database, as installMigratedThrough
 * describes: its owner login under `options.ambient`, each version's migration in turn, the fresh install's catalog
 * compared with the last, every login and the decoder login the served files `files` name given its password
 * (loginCredentials), and the installed-catalog posture checked.
 */
export const appliedHistory = (
	history: Arr.NonEmptyReadonlyArray<DraftedVersion>,
	name: string,
	options: HistoryOptions,
	files: ReadonlyMap<string, unknown>
): Effect.Effect<
	Installed,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
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
			ambientOwner: owner,
			files,
			credentials: yield* loginCredentials(last.plan, files, new Map())
		})
		yield* checkInstallation(installed)
		return installed
	})

/** A history's template's spec, as migratedTemplate takes it. */
interface HistorySpec {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly content: Content
	readonly versions: Arr.NonEmptyReadonlyArray<InstallVersion>
	readonly options: HistoryOptions
}

/**
 * What a history's template's build (historyTemplate's) writes once the history is applied, as the build's owner: what
 * every case over a clone of it starts from.
 */
type Seed<E> = (installed: Installed) => Effect.Effect<void, E, Substrate | Scope.Scope>

/**
 * A history's template (substrate.ts installTemplate): `versions` drafted under the template's names (draftedHistory)
 * by every worker, applied once per member by the build exactly as installMigratedThrough applies a history
 * (appliedHistory) and seeded by `seed`, and each case's Installed the last version's, in the case's clone,
 * every login logging in with the password its template derived.
 */
const historyTemplate = <E>(spec: HistorySpec, seed: Seed<E>): SubstrateTemplate<Installed> =>
	installTemplate({
		budget: templateNeedBudget,
		declaredIn: spec.declaredIn,
		name: spec.name,
		content: spec.content,
		plan: (names) =>
			Effect.map(draftedHistory(spec.versions, spec.options, names.schema), (history) => ({
				names,
				history
			})),
		install: ({ names, history }) =>
			Effect.flatMap(appliedHistory(history, names.schema, spec.options, new Map()), seed),
		bind: ({ names, history }, binding) =>
			templateInstalled(names, history, spec.options.ambient, new Map(), binding)
	})

/**
 * A history's template (historyTemplate) whose build seeds nothing. `content` is what tells this template from another
 * its module declares (the versions' and options' data): its module's import closure covers their code.
 */
export const migratedTemplate = (spec: HistorySpec): SubstrateTemplate<Installed> =>
	historyTemplate(spec, () => Effect.void)

/**
 * A template's installation of `history` (draftedHistory under the template's names), as a case over a clone of it sees
 * it in `binding`'s database: the last version's, migrated by every version's folder as the template's owner login,
 * whose sessions start under `ambient`, every login and the decoder login the served files `files` name logging in
 * with the password the template derived for it (templateCredentials), as appliedHistory gave it in the build.
 */
export const templateInstalled = (
	names: TemplateNames,
	history: Arr.NonEmptyReadonlyArray<DraftedVersion>,
	ambient: AmbientSession,
	files: ReadonlyMap<string, unknown>,
	binding: TemplateBinding
): Installed => {
	const last = Arr.lastNonEmpty(history)
	return templateInstalledOf(
		names,
		{ plan: last.plan, folders: Arr.map(history, (d) => d.folder), snapshot: last.snapshot },
		ambient,
		files,
		binding
	)
}

/**
 * A template's installation as a case over a clone of it sees it in `binding`'s database (templateInstalled), from
 * what its build applied: the last version's plan and snapshot, and every folder it ran.
 */
export const templateInstalledOf = (
	names: TemplateNames,
	applied: {
		readonly plan: RealInstallPlan
		readonly folders: Arr.NonEmptyReadonlyArray<FolderTexts>
		readonly snapshot: DeploySnapshot
	},
	ambient: AmbientSession,
	files: ReadonlyMap<string, unknown>,
	binding: TemplateBinding
): Installed =>
	installedAt(
		{
			plan: applied.plan,
			declared: names.schema,
			folders: applied.folders,
			snapshot: applied.snapshot,
			ambientOwner: templateAmbientOwner(ambient, templateLogin(binding, names.ownerLogin)),
			files,
			credentials: templateCredentials(binding, loginRoles(applied.plan, files))
		},
		binding
	)

/**
 * Installs `schema` through its first migration (installMigratedThrough), planned as `grizzle generate` composes it
 * (compileInstallation), with the extensions of `options` and no login.
 */
export const installMigrated = (
	schema: FixtureSchema,
	options: MigratedOptions
): Effect.Effect<
	Installed,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	installMigratedThrough([{ schema, declarations: noDeclarations }], {
		label: options.label,
		extensions: options.extensions,
		ambient: options.ambient,
		compile: compileInstallation,
		review: noPlaceholders
	})

/**
 * installMigrated's installation as a template (migratedTemplate): `schema` migrated through its first migration with
 * `options`' extensions, planned as `grizzle generate` composes it (compileInstallation), once per member, and each
 * case's Installed the schema in its clone. A case over it does none of the install installMigrated does per call.
 * `name` tells it from the other templates its declaring module states; that module's import closure covers the
 * schema, the extensions and the ambient session.
 */
export const installedTemplate = (spec: {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly schema: FixtureSchema
	readonly options: MigratedOptions
}): SubstrateTemplate<Installed> => migratedTemplate(installedSpec(spec))

/** installMigrated's one version and its options, as a history's template takes them (installedTemplate). */
const installedSpec = (spec: {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly schema: FixtureSchema
	readonly options: MigratedOptions
}): HistorySpec => ({
	declaredIn: spec.declaredIn,
	name: spec.name,
	content: { label: spec.options.label },
	versions: [{ schema: spec.schema, declarations: noDeclarations }],
	options: {
		label: spec.options.label,
		extensions: spec.options.extensions,
		ambient: spec.options.ambient,
		compile: compileInstallation,
		review: noPlaceholders
	}
})

/**
 * installedTemplate's installation with what every case starts from written once per member, as the build's owner,
 * right after the install: `seed` (facts loaded) on the installation it made, where a
 * search did it once before its cases.
 */
export const seededTemplate = <E>(spec: {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly schema: FixtureSchema
	readonly options: MigratedOptions
	readonly seed: Seed<E>
}): SubstrateTemplate<Installed> => historyTemplate(installedSpec(spec), spec.seed)

/**
 * A schema installed as `grizzle generate` drafts it with its logins (installGenerated), at one version of its history:
 * the installation, which holds each role at the level its served workload certifies (program/isolation/certification.ts)
 * and keeps each table's guard by those levels, and each login's served file of that version, projected from the same
 * plan at the same levels (eachServedFile), by the login's declared name.
 */
export interface Generated {
	readonly installed: Installed
	readonly served: ReadonlyMap<string, unknown>
}

/**
 * A schema value built under the installation's allocated name and the logins `grizzle generate` serves over it: what
 * an installation with logins is drafted from (generatedDraft), the one draft that carries a login.
 */
export interface Version {
	readonly schema: AnySchema
	readonly logins: ReadonlyArray<AnyLogin>
}

/**
 * One version of a generated history: its schema and logins (Version), and the renames and drops its migration
 * declares (`--rename`, `--drop`; noDeclarations for none).
 */
export interface GeneratedVersion extends Version {
	readonly declarations: Declarations
}

/**
 * A generated history installed at its first version, and `migrate`, which migrates it through each later version in
 * turn and gives it at the last, serving the files generate wrote for that version: a test serves its first version,
 * runs `migrate` when its case says, a watch open across it, and serves the last.
 */
interface GeneratedHistory {
	readonly first: Generated
	readonly migrate: Effect.Effect<
		Generated,
		CompileError | SqlError | TransactionRolledBack,
		Substrate | Scope.Scope
	>
}

/** One version of a generated history as its migration drafts it: its plan and reviewed folder, the snapshot it
 * reaches, and each login's served file of it, by declared name. */
export interface GeneratedDraft {
	readonly plan: RealInstallPlan
	/** The draft as generate wrote it, its folder named at its step, before any review: its change among it. */
	readonly generated: GenerateResult
	readonly folder: FolderTexts
	readonly snapshot: DeploySnapshot
	readonly served: ReadonlyMap<string, unknown>
}

/** Where a generated installation's configuration stands, for its directories alone: nothing is read from it. */
const generatedConfig = `${repoRoot}app/grizzle.config.ts`

/** The snapshot a draft `at` its step continues: the one before it, or the empty snapshot of `compiled`'s schema. */
const previousSnapshot = (compiled: CompiledSchema, at: DraftAt): DeploySnapshot =>
	at.previous.kind === "snapshot"
		? at.previous.snapshot
		: emptySnapshot({ schemaName: compiled.declared, schema: identifierOf(at.installation) })

/**
 * A schema compiled as `grizzle generate` compiles its configuration (cli/config.ts CompiledSchema), drafted `at` its
 * step of a history and served, before any review, as generate drafts and serves it once its configuration is compiled:
 * drafted from the snapshot before it with its logins' served workload certified once (cli/generate.ts
 * draftSchemaUnder), its codes `codes`, holes included, continued as a history that holds them (generate-draft.ts
 * keptHistory), its folder named at its step's instant, its plan of `schema` the drafted installation, its logins'
 * worlds its own, under the identity `at` gives and those codes (generate-draft.ts installedPlan), and each login's
 * served file projected from the same plan (eachServedFile). Its command-line refusals are the compiler's (generate-draft.ts
 * asCompiler). A draft that drafts no change is the caller's to judge (its `generated.change`).
 */
const draftedCompiled = (
	compiled: CompiledSchema,
	schema: FixtureSchema,
	codes: Codebook,
	at: DraftAt,
	declarations: Declarations
): Effect.Effect<Omit<GeneratedDraft, "folder" | "snapshot">, CompileError> =>
	Effect.gen(function* () {
		const { draft, entries } = yield* asCompiler(
			Effect.gen(function* () {
				const drafted = yield* draftSchemaUnder(
					compiled,
					previousSnapshot(compiled, at),
					keptHistory(codes),
					at.previous.kind === "empty" ? at.previous.abandoned : [],
					declarations,
					silentPhases
				)
				const served = yield* eachServedFile(
					compiled,
					drafted,
					drafted.served,
					silentPhases,
					Effect.succeed
				)
				return { draft: drafted, entries: served }
			})
		)
		const folderAt = yield* fromEngine(
			folderName(draftedAt(at.step), parsedMigrationName(installName))
		)
		const generated: GenerateResult = { ...draft, folder: { name: folderAt, ...draft.folder } }
		const plan = yield* installedPlan(schema, draft.installation, at.installation, codes)
		return {
			plan,
			generated,
			served: new Map(Arr.map(entries, (e) => [e.login, jsonOf(e.text)] as const))
		}
	})

/**
 * `version` as `grizzle generate` drafts and serves it `at` its step of a history, before any review: its configuration
 * resolved and compiled as the command line compiles it (cli/config.ts), then drafted and served as generate drafts and
 * serves a compiled schema (draftedCompiled), under the codes generate drafts from the snapshot before it
 * (migrate/kit.ts draftCodes). A version the compiler refuses fails with the compiler's refusal (generate-draft.ts
 * asCompiler); a history that reviews its folders itself reads this draft.
 */
export const generatedDrafting = (
	version: GeneratedVersion,
	at: DraftAt
): Effect.Effect<Omit<GeneratedDraft, "folder" | "snapshot">, CompileError> =>
	Effect.gen(function* () {
		const desc = yield* fromEngine(schemaDescIn(version.schema))
		const codes = yield* fromEngine(draftCodes(desc, at.previous, version.declarations))
		const compiled = yield* asCompiler(
			Effect.provideService(
				Effect.gen(function* () {
					const config = yield* resolveConfig(
						defineConfig({
							schemas: [version.schema],
							logins: version.logins,
							migrations: "migrations",
							rolePrefixBytes: 0,
							connection: () => offlineOwner
						}),
						generatedConfig
					)
					const configured = defined(config.schemas[0], "the generated schema's configuration")
					return yield* Effect.fromResult(compileSchema(configured))
				}),
				Path.Path,
				paths
			)
		)
		return yield* draftedCompiled(compiled, version.schema, codes, at, version.declarations)
	})

/**
 * `version` drafted `at` its step as `grizzle generate` drafts and serves it (generatedDrafting), its folder reviewed as
 * `reviewing` says with every loss written in, as installMigrated's is, and the snapshot it reaches.
 */
export const generatedDraft = (
	version: GeneratedVersion,
	at: DraftAt,
	reviewing: Review
): Effect.Effect<GeneratedDraft, CompileError> =>
	Effect.map(generatedDrafting(version, at), (drafted) => {
		const reviewed = review(drafted.generated, { losses: "written", value: reviewValue(reviewing) })
		return {
			...drafted,
			folder: {
				name: drafted.generated.folder.name,
				metaText: drafted.generated.folder.metaText,
				files: Arr.map(reviewed.files, (f) => ({
					name: f.name,
					text: reviewedText(reviewing, at.step, f)
				}))
			},
			snapshot: drafted.generated.snapshot
		}
	})

/**
 * Every version of `versions` as `grizzle generate` drafts and serves it under the name `name` (generatedDraft), each
 * folder reviewed as `reviewing` says: the first from the empty snapshot, each later one from the snapshot the one
 * before it reached.
 */
export const generatedHistory = (
	versions: Arr.NonEmptyReadonlyArray<(name: string) => GeneratedVersion>,
	name: string,
	reviewing: Review
): Effect.Effect<Arr.NonEmptyReadonlyArray<GeneratedDraft>, CompileError> =>
	Effect.gen(function* () {
		const installation = identity.schema(parsedSchemaName(name))
		const drafts: Array<GeneratedDraft> = []
		let previous: Previous = fromEmpty
		for (const [step, build] of versions.entries()) {
			const drafted = yield* generatedDraft(
				build(name),
				{ installation, previous, step },
				reviewing
			)
			assert.equal(
				drafted.generated.change,
				"schema",
				"each version of a generated history drafts a migration"
			)
			drafts.push(drafted)
			previous = fromSnapshot(drafted.snapshot)
		}
		return nonEmpty(drafts, "a generated history has its first version")
	})

/** A generated installation at one version, served at it (Generated), from its draft, as `owner`, with `credentials`. */
const generatedAt = (
	drafted: GeneratedDraft,
	input: {
		readonly declared: string
		readonly folders: Arr.NonEmptyReadonlyArray<FolderTexts>
		readonly ambientOwner: AmbientOwner
		readonly credentials: ReadonlyMap<string, Credentials>
	}
): Effect.Effect<Generated, never, Substrate> =>
	Effect.gen(function* () {
		const installed = yield* installedOf({
			plan: drafted.plan,
			snapshot: drafted.snapshot,
			files: drafted.served,
			...input
		})
		yield* checkInstallation(installed)
		return { installed, served: drafted.served }
	})

/**
 * Installs the history `versions` under a unique schema name `name` in the scope as `grizzle generate` drafts and
 * serves each version (generatedHistory), every version drafted before the first applies, and gives it at its first
 * version (GeneratedHistory): that version's migration, which runs the installation's script alone (runsInstallScript)
 * and so installs the fresh install's catalog, applied by the real runner as installMigrated's is, as an owner login
 * of its own whose sessions start under `options.ambient`, the grizzle-first path listing the last version's schemas,
 * made before the first migration. `migrate` applies each later version's migration in turn by the same runner, as the
 * same owner, and holds the catalog the last reached to the fresh install of that version, drafted by the same history
 * under another allocated name so its codes are the same (expectFreshCatalog). Every login a later version continues
 * keeps its password, so a layer served at an earlier version still logs in, and only a login it adds gets one. Every
 * version a test is given holds the installed-catalog posture.
 */
export const installGeneratedThrough = (
	versions: Arr.NonEmptyReadonlyArray<(name: string) => GeneratedVersion>,
	options: { readonly label: string; readonly ambient: AmbientSession }
): Effect.Effect<GeneratedHistory, CompileError | SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: options.label })
		const history = yield* generatedHistory(versions, name, noPlaceholders)
		const first = Arr.headNonEmpty(history)
		const last = Arr.lastNonEmpty(history)
		const folders = Arr.map(history, (d) => d.folder)
		/** Each version's migration as the runner applies it: the snapshot it reaches and every folder through it. */
		const applies = Arr.map(history, (draft, step) => ({
			snapshot: draft.snapshot,
			folders: Arr.take(folders, step + 1)
		}))
		assert.ok(
			runsInstallScript([first.folder], first.plan.installation, substrate.database),
			"generate's first migration runs the installation's script alone"
		)
		const owner = yield* ambientOwner(options.ambient, installedSchemas(last.plan.installation))
		yield* applyFolders(owner, substrate.database, first.snapshot, [first.folder])
		const credentials = yield* loginCredentials(first.plan, first.served, new Map())
		return {
			first: yield* generatedAt(first, {
				declared: name,
				folders: [first.folder],
				ambientOwner: owner,
				credentials
			}),
			migrate: Effect.gen(function* () {
				for (const later of Arr.drop(applies, 1)) {
					yield* applyFolders(owner, substrate.database, later.snapshot, later.folders)
				}
				yield* expectFreshCatalog(last.plan.installation, folders, (fresh) =>
					Effect.map(
						generatedHistory(versions, fresh, noPlaceholders),
						(h) => Arr.lastNonEmpty(h).plan
					)
				)
				return yield* generatedAt(last, {
					declared: name,
					folders,
					ambientOwner: owner,
					credentials: yield* loginCredentials(last.plan, last.served, credentials)
				})
			})
		}
	})

/**
 * Installs `build(name)` under a unique schema name `name` in the scope as `grizzle generate` drafts and serves it: a
 * generated history of one version (installGeneratedThrough), at that version.
 */
export const installGenerated = (
	build: (name: string) => Version,
	options: { readonly label: string; readonly ambient: AmbientSession }
): Effect.Effect<Generated, CompileError | SqlError, Substrate | Scope.Scope> =>
	Effect.map(
		installGeneratedThrough(
			[(name) => ({ ...build(name), declarations: noDeclarations })],
			options
		),
		(history) => history.first
	)

/** A generated installation's template's spec, as generatedTemplate takes it. */
export interface GeneratedSpec {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly content: Content
	readonly build: (name: string) => Version
	readonly ambient: AmbientSession
}

/**
 * A generated installation's template (substrate.ts installTemplate): `build`'s schema and logins drafted and served
 * under the template's names as `grizzle generate` drafts them (generatedHistory) by every worker, applied once per
 * member by the build (appliedGenerated), and each case's Generated the installation in the case's clone, every login
 * logging in with the password its template derived, with each login's served file. `content` is what tells this
 * template from another its module declares: its module's import closure covers the code.
 */
export const generatedTemplate = (spec: GeneratedSpec): SubstrateTemplate<Generated> =>
	generatedTemplateOf(spec, templateNeedBudget, () => Effect.void)

/**
 * A generated installation's template (generatedTemplate) whose build writes `seed` on the installation it made, as the
 * build's owner, right after its migration, as seededTemplate seeds a history's: a population too costly to load in
 * every case that reads it, loaded once per member, each case's clone holding it. `budget` is the CPU its open may
 * spend with the seed written (Template budget), the template's own, since a population worth seeding costs more than
 * any template's install alone (templateNeedBudget).
 */
export const seededGeneratedTemplate = <E>(
	spec: GeneratedSpec,
	seed: Seed<E>,
	budget: number
): SubstrateTemplate<Generated> => generatedTemplateOf(spec, budget, seed)

/**
 * A generated template (generatedTemplate), its open's budget `budget`, its build ending in `seed` over the installation
 * it made.
 */
const generatedTemplateOf = <E>(
	spec: GeneratedSpec,
	budget: number,
	seed: Seed<E>
): SubstrateTemplate<Generated> => {
	const versions: Arr.NonEmptyReadonlyArray<(name: string) => GeneratedVersion> = [
		(name) => ({ ...spec.build(name), declarations: noDeclarations })
	]
	return installTemplate({
		budget,
		declaredIn: spec.declaredIn,
		name: spec.name,
		content: spec.content,
		plan: (names) =>
			Effect.map(generatedHistory(versions, names.schema, noPlaceholders), (history) => ({
				names,
				history
			})),
		install: ({ names, history }) =>
			Effect.flatMap(
				appliedGenerated(history, names.schema, spec.ambient, (fresh) =>
					Effect.map(
						generatedHistory(versions, fresh, noPlaceholders),
						(again) => Arr.lastNonEmpty(again).plan
					)
				),
				(generated) => seed(generated.installed)
			),
		bind: ({ names, history }, binding) => templateGenerated(names, history, spec.ambient, binding)
	})
}

/**
 * A generated history (generatedHistory), drafted under the declared name `declared`, applied in the substrate's
 * database as installGenerated applies it and migrates it on: its first version's migration, which runs the
 * installation's script alone (runsInstallScript), then each later version's in turn, by the real runner as an owner
 * login of its own whose sessions start under `ambient`; the catalog the last reached held to the fresh install of it
 * `planned` plans under another allocated name (expectFreshCatalog); every login and the decoder login the last
 * version's served files name given a password in the scope (loginCredentials); and the installed-catalog posture
 * checked, at the last version. A template's build installs its draft so (generatedTemplate).
 */
export const appliedGenerated = (
	history: Arr.NonEmptyReadonlyArray<GeneratedDraft>,
	declared: string,
	ambient: AmbientSession,
	planned: VersionPlanner
): Effect.Effect<
	Generated,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const first = Arr.headNonEmpty(history)
		const last = Arr.lastNonEmpty(history)
		const folders = Arr.map(history, (d) => d.folder)
		assert.ok(
			runsInstallScript([first.folder], first.plan.installation, substrate.database),
			"generate's first migration runs the installation's script alone"
		)
		const owner = yield* ambientOwner(ambient, installedSchemas(last.plan.installation))
		for (const [step, draft] of history.entries()) {
			yield* applyFolders(owner, substrate.database, draft.snapshot, Arr.take(folders, step + 1))
		}
		yield* expectFreshCatalog(last.plan.installation, folders, planned)
		const credentials = yield* loginCredentials(last.plan, last.served, new Map())
		return yield* generatedAt(last, { declared, folders, ambientOwner: owner, credentials })
	})

/**
 * A template's generated installation of `history`, drafted under the template's names, as a case over a clone of it
 * sees it in `binding`'s database: its last version's, migrated by every version's folder as the template's owner
 * login, whose sessions start under `ambient`, every login and the decoder login the last version's served files name
 * logging in with the password the template derived for it (templateCredentials), as appliedGenerated gave it in the
 * build, with each login's served file of that version.
 */
export const templateGenerated = (
	names: TemplateNames,
	history: Arr.NonEmptyReadonlyArray<GeneratedDraft>,
	ambient: AmbientSession,
	binding: TemplateBinding
): Generated => {
	const last = Arr.lastNonEmpty(history)
	return {
		installed: installedAt(
			{
				plan: last.plan,
				declared: names.schema,
				folders: Arr.map(history, (d) => d.folder),
				snapshot: last.snapshot,
				ambientOwner: templateAmbientOwner(ambient, templateLogin(binding, names.ownerLogin)),
				files: last.served,
				credentials: templateCredentials(binding, loginRoles(last.plan, last.served))
			},
			binding
		),
		served: last.served
	}
}

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
		yield* loadFacts(substrate.admin, installed.plan, facts, namesOf(installed).standUps)
	})

/**
 * Replaces every stored relation's facts with its facts in `facts`, none where it names none, as the owner, in one
 * transaction after every stored relation's rows are deleted in a READ COMMITTED transaction of their own
 * (substrate/replace.ts replaceRows, installationGroup): the reset of a case that reads and writes, which a
 * SERIALIZABLE reset reading the rows it deletes would make an SSI pivot under load. An installation of closed
 * relations alone stores nothing, and `facts` can name nothing of it.
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
