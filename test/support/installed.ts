import { Array as Arr, Effect, type Layer, Option, type Scope, String as Str } from "effect"
import { openDbContext } from "#adapter/db/open.ts"
import type { CompiledOps } from "#adapter/db/ops.ts"
import type { OpenError, ReadError } from "#adapter/errors/execution.ts"
import type { SchemaApplyReport } from "#adapter/migrate/apply.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { compiledDbLayer } from "#adapter/pool/registry.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { QueryResultValue } from "#adapter/reader/reader.ts"
import type { CompiledDbConfigShape, DbLayerOf } from "#adapter/types/layer.ts"
import type { Json } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { type DraftWorkload, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { compileWorkload } from "#compiler/program/workload/compile.ts"
import {
	type AnyClosed,
	type AnyLogin,
	type AnyRelation,
	type AnyRole,
	type AnySchema,
	type Schema,
	type Statement,
	type StatementsByName,
	type StatementsReadBack,
	type StatementsWithin,
	type UnderOwnNames,
	roleNameOf,
	schema
} from "#compiler/public/schema.ts"
import { ownLogin } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { AnyLoginRole } from "#compiler/types/schema/world.ts"
import { apply, noFurther, openMigrator } from "#test/pg/migrate/support.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { deployedWorkloadOver, testArtifacts, testCompile } from "#test/support/compile.ts"
import { type Installed, installedOf } from "#test/support/install-migrate.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	draftCodes,
	fromEmpty,
	fromSnapshot,
	generate,
	type Previous,
	draftedAt
} from "#test/support/migrate/kit.ts"
import { type Decisions, type Placeholder, review } from "#test/support/migrate/review.ts"
import { planRealInstall, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { clusterConnection, clusterPool, type SqlError } from "#test/support/pg.ts"
import { compileRuntime, dbReader } from "#test/support/runtime-db.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { dropRole, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayer, testVerify, tokenOf } from "#test/support/worlds.ts"

/**
 * One version of a migrated schema: its schema value, built under the allocated name, and the logins over it whose
 * worlds its migration installs.
 */
export interface Version {
	readonly schema: AnySchema
	readonly logins: ReadonlyArray<AnyLogin>
}

/**
 * A schema migrated through a history of versions: the installation its last version reached (Installed, its folders
 * the history), with the migration identity's session and the history's apply again.
 */
interface Migrated extends Installed {
	/** A raw session of the migration identity, which owns the schema, for SQL a test runs as the owner. */
	readonly owner: RawSession
	/** Applies the folders applied so far again, nothing pending: the runner's drift check of the catalog alone. */
	readonly reapply: Effect.Effect<SchemaApplyReport, MigrateError>
	/** `$S` replaced by the quoted schema, run as the owner. */
	readonly sql: (text: string) => Effect.Effect<void, SqlError>
}

/**
 * The DbLayer of `login`, typed by it, given the committed `snapshot`, its role given a password in the scope this runs
 * in: the cluster's connection (test/support/pg.ts clusterConnection), the test pool, and testVerify.
 */
export const loginLayerOf = <L extends AnyLogin>(
	login: L,
	snapshot: CompiledDbConfigShape<L>["snapshot"]
): Effect.Effect<Layer.Layer<DbLayerOf<L>, OpenError>, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const given = yield* substrate.login(roleNameOf(login))
		return compiledDbLayer({
			...clusterConnection(substrate.cluster, substrate.database, given.password),
			pool: clusterPool,
			login,
			snapshot,
			verify: testVerify
		})
	})

/**
 * Rebuilds `fixture` under `name` from its own relations and statements: a schema value whose statements name only its
 * relations and read back from their names as themselves, as schema(...) checked when it was built.
 */
export const rebuild = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>
>(
	fixture: Schema<N, R, StatementsByName<St, R>> & {
		readonly relations: UnderOwnNames<R>
		readonly statements: St & StatementsWithin<St, R> & StatementsReadBack<St, R>
	},
	name: string
): Schema<string, R, StatementsByName<St, R>> =>
	schema<string, R, St>(name, fixture.relations, fixture.statements)

/**
 * The declared name a fixture is rebuilt under: a unique one, or a word PostgreSQL reserves (one installation of it at
 * a time in the database).
 */
type SchemaName = { readonly kind: "unique" } | { readonly kind: "reserved"; readonly word: string }

interface MigrateOptions {
	readonly label: string
	readonly schemaName: SchemaName
	/**
	 * The first version, built under the allocated name: a fixture rebuilt (`rebuild`), or a schema whose queries must
	 * be over the installed schema value built there, with its logins, whose workloads its migration plans.
	 */
	readonly first: (name: string) => Version
	/** Later versions of the schema, each a migration after the first, built over the same name. */
	readonly later: ReadonlyArray<(name: string) => Version>
	/**
	 * The placeholder values of every generated folder's review. A folder with a placeholder under `noPlaceholders` is a
	 * defect of the test.
	 */
	readonly apply:
		| { readonly kind: "noPlaceholders" }
		| { readonly kind: "values"; readonly value: Decisions["value"] }
	/**
	 * The renames and drops each version's migration declares (`--rename`, `--drop`), by the version's index, 0 the
	 * first: every drop of stored data is declared, a roster's removed handle among them, and a renamed handle keeps its
	 * code (deploy/diff/plan.ts Declarations).
	 */
	readonly declared: (version: number) => Declarations
	/**
	 * What runs as the owner after each version's migration applies, given the version's index: what a test reads
	 * between versions, such as a role's OID that a later rename keeps; none for a test that reads nothing there.
	 */
	readonly observe: Option.Option<Observe>
}

/** A reading between versions, given the version's index and the owner's session. */
type Observe = (version: number, owner: RawSession) => Effect.Effect<void, SqlError>

/** No reading between versions. */
export const noObservation: Option.Option<Observe> = Option.none()

/** The placeholder value of a migration whose options say it has none: a placeholder is a defect of the test. */
const noValue =
	(label: string) =>
	(placeholder: Placeholder): string => {
		throw new Error(
			`migrated: a placeholder of ${placeholder.table.name}, and no apply.value (${label})`
		)
	}

/**
 * What a version's logins' workloads add, planned as `grizzle generate` plans them with their roles' write filters
 * (cli/generate.ts draftInput): the installer extension of the plan, compiled against the schema the installation
 * installs (compile.ts deployedWorkloadOver), and the draft's workload. A version without a login plans nothing.
 */
export const workloadOf = (
	version: Version
): { readonly extensions: ReadonlyArray<InstallExtension>; readonly draft: DraftWorkload } => {
	if (version.logins.length === 0) {
		return { extensions: [], draft: noWorkload }
	}
	const owned = Arr.map(version.logins, (l) =>
		succeeded(ownLogin(defined(loginDescOf(l), `login ${l.name}, built by login(...)`)))
	)
	const plan = succeeded(
		compileWorkload(
			Arr.map(version.logins, (l) => ({ login: l.name, workloads: l.workload })),
			version.schema,
			{
				artifacts: succeeded(testArtifacts(version.schema, testCompile)),
				roles: Arr.flatMap(owned, (l) => l.roles)
			}
		)
	)
	return {
		extensions: [
			deployedWorkloadOver(
				Arr.map(version.logins, (l) => ({ login: l.name, workloads: l.workload }))
			)
		],
		draft: { access: plan.access, accessPaths: plan.requests }
	}
}

/**
 * A version's codes, drafted as `grizzle generate` drafts them (cli/generate.ts draftInput): from the codes the
 * previous snapshot records, the empty codebook before the first, with no rename declared. A draft that reorders a
 * roster is the test's defect: a history the test states appends new handles.
 */
const draftedCodes = (previous: Previous, version: Version, declared: Declarations): Codebook => {
	const drafted = draftCodes(version.schema, previous, declared)
	if (!drafted.ok) {
		throw new Error(`migrated: a version's codes are refused: ${drafted.error.message}`)
	}
	return drafted.value
}

/**
 * A reserved word as the declared name: whatever an earlier installation of it left is dropped before and after, its
 * roles' schemas and its roles with it.
 */
const reservedSchema = (word: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const clear = Effect.gen(function* () {
			const worlds = yield* substrate.admin.queryValues(
				"SELECT nspname::text FROM pg_catalog.pg_namespace WHERE starts_with(nspname::text, $1::text) ORDER BY nspname",
				[`${word}__`]
			)
			for (const [world] of worlds) {
				yield* substrate.admin.query(
					`DROP SCHEMA IF EXISTS ${quoteIdent(String(world))} CASCADE`,
					[]
				)
			}
			const roles = yield* substrate.admin.queryValues(
				"SELECT rolname::text FROM pg_catalog.pg_roles WHERE starts_with(rolname::text, $1::text) ORDER BY rolname",
				[`${word}__`]
			)
			for (const [role] of roles) {
				yield* dropRole(substrate.admin, String(role))
			}
			yield* substrate.admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(word)} CASCADE`, [])
		})
		yield* clear
		yield* Effect.addFinalizer(() => Effect.orDie(clear))
		return word
	})

/** The declared name a fixture is rebuilt under. */
const schemaNameOf = (options: MigrateOptions) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		switch (options.schemaName.kind) {
			case "unique":
				return yield* substrate.schema({ create: false, label: options.label })
			case "reserved":
				return yield* reservedSchema(options.schemaName.word)
		}
	})

/**
 * Installing a fixture as a deployment does, and opening a Db over it.
 *
 * A fixture is installed the way a deployment installs it: its schema value is rebuilt under a unique name (roles are
 * cluster-wide) or a reserved word, its first migration is generated from the
 * empty snapshot (with its logins' workloads) and applied by the real runner (packages/grizzle/src/adapter/migrate) as the migration
 * identity, which checks, runs, records and drift-checks each folder (test/pg/migrate/support.ts), and the generated
 * snapshot is the one the application knows. Every generated folder is reviewed first by the one reviewer
 * (test/support/migrate/review.ts), every candidate rename kept or chosen as the caller says and every placeholder
 * given the caller's value, so no later version runs a placeholder raw. Each version states its
 * logins, whose worlds its migration installs and whose workloads it plans. Db.open then admits the database as one of
 * their roles, through its login's DbLayer, given the snapshot.
 *
 * Installs the schema through its generated migrations, as described in the header.
 */
export const migrated = (options: MigrateOptions) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const owner = substrate.owner.role
		const name = yield* schemaNameOf(options)
		const installation = identity.schema(parsedSchemaName(name))
		const versions: ReadonlyArray<Version> = [
			options.first(name),
			...Arr.map(options.later, (f) => f(name))
		]
		const session = yield* substrate.session({ ...ownerSession(), label: `owner ${options.label}` })
		const ownerLogin = yield* ambientOwner(ordinarySession, [identifierOf(installation)])
		const migrator = yield* openMigrator(substrate, ownerLogin.credentials)
		const placeholderValue =
			options.apply.kind === "values" ? options.apply.value : noValue(options.label)
		const folders: Array<FolderSource> = []
		const steps: Array<{
			readonly version: Version
			readonly plan: RealInstallPlan
			readonly snapshot: DeploySnapshot
		}> = []
		let previous: Previous = fromEmpty
		for (const [i, version] of versions.entries()) {
			const workload = workloadOf(version)
			/** The version's complete installation, every installer extension a deployment needs and its logins' worlds. */
			const plan = succeeded(
				planRealInstall(version.schema, {
					installation,
					owner,
					logins: version.logins,
					extensions: workload.extensions,
					codes: draftedCodes(previous, version, options.declared(i))
				})
			)
			const g = succeeded(
				generate({
					previous,
					installation: plan.installation,
					name: `step_${i + 1}`,
					timestamp: draftedAt(i + 1),
					workload: workload.draft,
					declared: options.declared(i)
				})
			)
			const decisions: Decisions = {
				losses: "written",
				value: placeholderValue
			}
			const reviewed = review(g, decisions)
			folders.push({
				name: g.folder.name,
				metaText: g.folder.metaText,
				files: reviewed.files
			})
			yield* apply(migrator, { snapshot: g.snapshot, folders: [...folders] }, noFurther)
			yield* Option.match(options.observe, {
				onNone: () => Effect.void,
				onSome: (observe) => observe(i, session)
			})
			steps.push({ version, plan, snapshot: g.snapshot })
			previous = fromSnapshot(g.snapshot)
		}
		const { plan, snapshot } = Arr.lastNonEmpty(
			nonEmpty(steps, "a migrated schema has its first version")
		)
		const history = nonEmpty(folders, "a migrated schema has its first migration")
		const installed = yield* installedOf({
			plan,
			declared: name,
			folders: history,
			snapshot,
			ambientOwner: ownerLogin
		})
		const quoted = quoteIdent(installed.schema)
		const result: Migrated = {
			...installed,
			owner: session,
			reapply: Effect.suspend(() => apply(migrator, { snapshot, folders: history }, noFurther)),
			sql: (text) => Effect.asVoid(session.query(Str.replaceAll("$S", quoted)(text), []))
		}
		return result
	})

/**
 * The operations of an opened Db these tests use, over a schema value known only at run time: the runtime the Db runs
 * (test/support/runtime-db.ts), which types every program `unknown`.
 */
interface OpenedDb {
	readonly execute: (query: unknown, params: unknown) => Effect.Effect<QueryResultValue, ReadError>
	readonly compile: (
		program: unknown
	) => Effect.Effect<CompiledOps<unknown>, CompileError, Scope.Scope>
}

/**
 * Db.open of `role`, a role reached through its login, through the runtime Db.open runs
 * (packages/grizzle/src/adapter/db/open.ts), with the operations of OpenedDb.
 */
const openDb = (
	role: AnyLoginRole,
	token: string
): Effect.Effect<OpenedDb, OpenError, DbLayer<AnyRole>> =>
	Effect.map(openDbContext(role, { token }), ({ ctx }) => {
		const reader = dbReader(ctx)
		return {
			execute: (query, params) => reader.execute(query, params),
			compile: (program) => compileRuntime(ctx, program)
		}
	})

/**
 * Opens the migrated schema as `role`, a role reached through its login, with a token whose payload is `payload`,
 * through its login's layer, which holds the snapshot the migrations reached, and runs `body` with the Db, inside the
 * layer's scope.
 */
export const withDbClaims = <A, E>(
	m: Installed,
	role: AnyLoginRole,
	payload: Json,
	body: (db: OpenedDb) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E | OpenError | SqlError, Scope.Scope> =>
	Effect.scoped(Effect.flatMap(openDb(role, tokenOf(payload)), body)).pipe(
		withLayer(loginLayer(m, role.login))
	)

/** Opens the migrated schema as `role` with a token that holds no claims, and runs `body` with the Db. */
export const withDb = <A, E>(
	m: Installed,
	role: AnyLoginRole,
	body: (db: OpenedDb) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E | OpenError | SqlError, Scope.Scope> => withDbClaims(m, role, {}, body)
