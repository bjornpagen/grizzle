import { defined } from "@bjornpagen/testing/assert"
import { passed, type WildKind, wildOf } from "@bjornpagen/testing/lsw"
import {
	Array as Arr,
	Cause,
	Context,
	Data,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	Ref,
	Result,
	Scope
} from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { openServed } from "#adapter/db/served.ts"
import { fromEngine } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { compileServed, type ServedRefusal } from "#adapter/public/compile.ts"
import { served } from "#adapter/public/layer.ts"
import type { DbLayerOf, DbLayerService, ServedLogin, ServedRole } from "#adapter/types/layer.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { codebookOf, noWorkload, writeRuntimeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { namedRole, roleReadNames, worldNames } from "#compiler/physical/ddl/names.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { login as loginBuilder } from "#compiler/program/workload/login.ts"
import { type OwnedRole, ownRole } from "#compiler/schema/own.ts"
import { roleDescOf, roleBuilder } from "#compiler/schema/world.ts"
import type { LoginRole } from "#compiler/types/schema/world.ts"
import type { AmbientSession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { installedCodes, type TestCompileOptions, testCompile } from "#test/support/compile.ts"
import {
	appliedGenerated,
	generatedDraft,
	type Installed,
	noPlaceholders
} from "#test/support/install-migrate.ts"
import {
	type InstalledAt,
	installationNamesOf,
	installationOf,
	parsedSchemaName,
	standUpCallsOf
} from "#test/support/kernel/naming.ts"
import {
	type DecoderCredential,
	decodersIn,
	type SourcedLayer,
	servedSourcedLayer
} from "#test/support/live-layer.ts"
import { fromEmpty, generate, noDeclarations } from "#test/support/migrate/kit.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { clusterConnection, clusterPool, type SqlError } from "#test/support/pg.ts"
import { snapshotJson, snapshotValue } from "#test/support/snapshot-json.ts"
import type { PsqlWriter } from "#test/support/substrate/psql.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { rolePsql, Substrate } from "#test/support/substrate/substrate.ts"
import { templatePassword } from "#test/support/substrate/templates.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	type Built,
	type BuiltLogin,
	type BuiltRole,
	baseBuild,
	buildInstall,
	domainOf
} from "#test/support/worlds/execute/build.ts"
import {
	type Catalog,
	draftNext,
	drift,
	failedFolder,
	landedFolders,
	migrationRefused,
	type RunEnd,
	runEndOf,
	type RunOutcome,
	runFolders,
	tamper
} from "#test/support/worlds/execute/catalog.ts"
import type { DirectNames } from "#test/support/worlds/execute/direct.ts"
import { beginSql } from "#test/support/worlds/execute/direct.ts"
import { carrierOf, valueOfText } from "#test/support/worlds/execute/host.ts"
import { leakOf } from "#test/support/worlds/execute/leak.ts"
import { installedRoleName, namesOfBuiltAt } from "#test/support/worlds/execute/names.ts"
import { openRefused, refusalReader, witnessTexts } from "#test/support/worlds/execute/observe.ts"
import { leaseRecording, probePool } from "#test/support/worlds/execute/pool.ts"
import { RealizeRefused, Thrown } from "#test/support/worlds/execute/refused.ts"
import {
	applySession,
	applyValue,
	type DbSession,
	entryFields,
	executeValue,
	readSession,
	refusedWith,
	type Seen,
	seen
} from "#test/support/worlds/execute/session.ts"
import { type Handed, handedOf, worldVerify } from "#test/support/worlds/execute/token.ts"
import {
	type DirectSession,
	endDirect,
	type LawReading,
	probeDirect,
	runDirect
} from "#test/support/worlds/execute/writer.ts"
import { fieldDomain, judgedLawOf } from "#test/support/worlds/model/host.ts"
import { parametersOf, startStatements } from "#test/support/worlds/model/session/direct.ts"
import { loginVerifies, roleOf } from "#test/support/worlds/model/session/state.ts"
import { probeOf } from "#test/support/worlds/model/session/writes.ts"
import type {
	Action,
	DirectStatement,
	FieldDomain,
	HostFact,
	HostState,
	InstalledNames,
	InstallSpec,
	Isolation,
	Observation,
	Probe,
	RoleRef,
	SnapshotRef,
	WorldFunction
} from "#test/support/worlds/model/types.ts"

/**
 * The real system a worlds model is checked against: an InstallSpec built through grizzle's builders, installed through
 * its first migration (test/support/install-migrate.ts), each login with a DbLayer whose verify reads the test token's JSON
 * text, and each action performed on PostgreSQL as grizzle's caller or as a direct SQL writer would.
 *
 * `perform` never fails: every outcome is an Observation, and a refusal any of whose texts (an error's message, DETAIL
 * or HINT, a notice, a witness value) holds one of the hidden tokens is that leak instead. An answer no observation
 * names (a lost connection, a decode grizzle could not do) is raised as a defect: a finding of the run.
 */
export interface RealWorld {
	/** The names of the current installation, read from its compilation: a migrate replaces them. */
	readonly names: InstalledNames
	/**
	 * Begins a case in the caller's scope: closes every session left (rolling back open direct transactions), replaces
	 * every base fact with `reality` as the owner, and restarts session ids at 0. Every direct writer the case begins after
	 * it lives in that scope, so its transaction ends when the case does, however the case ends: never left open for a
	 * later case's reset, which a shared world may not reach for minutes while each SERIALIZABLE snapshot it holds keeps
	 * the cluster's SSI cleanup from advancing.
	 */
	readonly reset: (reality: HostState) => Effect.Effect<void, SqlError, Scope.Scope>
	/**
	 * Every base table's stored facts, in one snapshot, read past row security (substrate.ts superuserRead): a catalog
	 * change that forces a table's row security on its owner hides none of them.
	 */
	readonly stored: Effect.Effect<HostState>
	readonly perform: (action: Action, hidden: ReadonlySet<string>) => Effect.Effect<Observation>
	/** An action performed as `perform` does, with the texts of the error behind its observation, for a report. */
	readonly performed: (action: Action, hidden: ReadonlySet<string>) => Effect.Effect<Performed>
	readonly probe: (session: number) => Effect.Effect<Probe>
	/**
	 * Direct session `session`'s transaction begun again, as its writer runs a transaction again after PostgreSQL refused
	 * it with 40001 for the cluster's load (drive/index.ts answered, schedules/worlds.ts): at `isolation`, on the
	 * session's own connection while it is open, on a new one of `login` once its COMMIT closed it, then `sent` in order,
	 * the session's every statement, so the session stands where it stood before the refused statement or COMMIT. It
	 * answers what each statement answered this time, a draw an insert made shown anew: ok or rows, since no session the
	 * caller drives touched what they read meanwhile; one refused with 40001 begins the transaction again, and any other
	 * answer is a defect of the run.
	 */
	readonly rebegin: (
		session: number,
		login: string,
		isolation: Isolation,
		sent: ReadonlyArray<DirectStatement>
	) => Effect.Effect<ReadonlyArray<Observation>>
	/**
	 * A psql child logged in as a login of the current installation, as a direct writer's is, with no transaction
	 * begun: the caller begins and ends its transactions, and its scope ends the child. A schedule holds a lock with it
	 * outside the model, as a transaction in flight does.
	 */
	readonly psql: (login: string) => Effect.Effect<PsqlWriter, never, Scope.Scope>
	/**
	 * The login every migration, drift and ledger session of the installation logs in as (test/support/ambient.ts
	 * AmbientOwner), by which a schedule finds a running migration's backend.
	 */
	readonly migrator: string
}

/** A snapshot.json as a login's layer is given it (DbConfig): what an open reads of it, its fingerprint. */
type Fingerprinted = { readonly fingerprint: string }

/**
 * What an action did: its observation (a value hidden from the acting session that grizzle showed replacing it, as a
 * leak), and every text of the error behind it (its messages, details and hints), none for an outcome no error carried.
 */
export interface Performed {
	readonly observation: Observation
	readonly because: ReadonlyArray<string>
}

export interface RacingWorld extends RealWorld {
	/**
	 * The backend serving an open session: a direct writer's, read once when its BEGIN opened it; or the connection a
	 * Db's own lease holds (DbSession.backend), none while it holds no lease.
	 */
	readonly backend: (session: number) => Effect.Effect<Option.Option<number>>
}

type Session =
	| DbSession
	| DirectSession
	| { readonly kind: "closed"; readonly was: "db" | "direct" }

/**
 * One version's pure part: its spec, its values under the installed schema name, its names, plan and snapshot, the JSON
 * value of its snapshot.json, and each login's served file compiled under it (servedOver), by the login's name, as a
 * served login and as the JSON generate writes (`files`), whose decoder logins an install gives their passwords.
 */
interface VersionPlan {
	readonly spec: InstallSpec
	readonly built: Built
	readonly names: InstalledNames
	readonly plan: RealInstallPlan
	readonly installation: Installation
	readonly snapshot: DeploySnapshot
	readonly snapshotJson: Fingerprinted
	readonly served: Readonly<Record<string, ServedLogin<BuiltLogin>>>
	readonly files: ReadonlyMap<string, unknown>
}

/** One installed version (VersionPlan), each login's credentials and its layer over its served file. */
interface Version extends VersionPlan {
	readonly credentials: Readonly<Record<string, Credentials>>
	readonly layers: Readonly<Record<string, LoginLayer>>
}

/**
 * A login's layer as an application builds it: the login's served file, compiled under a snapshot.json (`snapshot`, its
 * JSON value) and served under its name (served(file, name)), and the context of DbLayer.make over it.
 */
interface LoginLayer {
	readonly served: ServedLogin<BuiltLogin>
	readonly snapshot: unknown
	readonly context: Context.Context<DbLayerOf<BuiltLogin>>
}

/** A version a migration drafted: its spec, the plan it installs and the snapshot it reaches. */
interface Next {
	readonly spec: InstallSpec
	readonly plan: RealInstallPlan
	readonly snapshot: DeploySnapshot
}

/** A folder a run left pending, and the version it installs once it applies. */
interface PendingFolder {
	readonly folder: FolderTexts
	readonly next: Next
}

/**
 * The migrations directory as the operator keeps it: the folders generate wrote, in order, each one the migration runner
 * and its drift check are handed. The applied folders installed the current version; the pending ones, each a drafted
 * version over the one before it, a run stopped part-way through (at a law statement its data breaks, or a deploy
 * killed), the transactions before the stop committed and the stopped folder in progress in the ledger. A later run
 * resumes them oldest first. snapshot.json is the last folder's target.
 */
interface Directory {
	readonly applied: ReadonlyArray<FolderTexts>
	readonly pending: ReadonlyArray<PendingFolder>
}

/** Every folder of a directory, in order. */
const foldersOf = (directory: Directory): ReadonlyArray<FolderTexts> => [
	...directory.applied,
	...Arr.map(directory.pending, (p) => p.folder)
]

/** The login an unheld role is reached through, which no layer serves: a JavaScript caller's role of no installed login. */
const unheldLogin = "executorUnheld"

/** A role the current installation holds: its spec and the login it is in. */
interface Held {
	readonly role: InstallSpec["roles"][number]
	readonly login: string
}

/**
 * A role of no installed login whose login's served file the compile refuses, a role a name breaking the declared-name
 * rule names: no served file holds it, so no application holds a token of it to hand Db.open, and the compile's
 * refusal is the open's.
 */
class UnservableRole extends Data.TaggedError("UnservableRole")<{
	readonly refusal: ServedRefusal
}> {}

/**
 * What an open hands Db.open and runs under: the role value it names, that role reached through its login, the role the
 * installation holds it as (none for a role of no installed login), and its opening: the served role Db.open is handed,
 * the snapshot its login's file was compiled under, and the layers it is opened under. A served file the compile
 * refuses under the snapshot an open names is that open's refusal; a role no served file can hold is UnservableRole.
 */
interface OpenTarget {
	readonly value: BuiltRole
	readonly reached: LoginRole<BuiltRole, readonly []>
	readonly held: Option.Option<Held>
	readonly opening: Effect.Effect<Opening, OpenError | ServedRefusal | UnservableRole, Scope.Scope>
}

/** An open's served role, the snapshot its file was compiled under, and the layers it is opened under. */
interface Opening {
	readonly role: ServedRole<BuiltRole, unknown>
	readonly snapshot: unknown
	readonly context: Context.Context<DbLayerOf<BuiltLogin>>
}

/** The role of a login's served file, by its name: a role its login holds, which its file serves. */
const servedRoleOf = (
	login: ServedLogin<BuiltLogin>,
	role: string
): ServedRole<BuiltRole, unknown> =>
	defined(login.roles[role], `role ${role} of the served login ${login.name}`)

const heldOf = (spec: InstallSpec, role: string, login: string): Option.Option<Held> =>
	Option.map(Option.fromUndefinedOr(roleOf(spec, role)), (found) => ({ role: found, login }))

const missing = (what: string): Effect.Effect<never> =>
	Effect.die(new Error(`the executor has no ${what}`))

const get = <A>(record: Readonly<Record<string, A>>, key: string, what: string): Effect.Effect<A> =>
	Option.match(Rec.get(record, key), {
		onNone: () => missing(`${what} ${key}`),
		onSome: Effect.succeed
	})

/**
 * `login`'s served file with its own workloads, compiled under `snapshot`, the JSON value of a snapshot.json, as
 * generate compiles it (adapter/public/compile.ts compileServed), and served under its name, as an application serves
 * the file it imports.
 */
const servedOver = (
	login: BuiltLogin,
	snapshot: unknown
): Effect.Effect<ServedLogin<BuiltLogin>, ServedRefusal> =>
	Effect.map(
		Effect.suspend(() => compileServed(login, snapshot, login.workload)),
		(json) => served<BuiltLogin>(json, login.name)
	)

/**
 * One version's pure part (VersionPlan) of `spec`, installed under the declared name `declared` by `plan` at
 * `snapshot`: its values under that name (buildInstall), its names, and each login's served file compiled under the
 * snapshot's JSON value (servedOver), whose refusal is a defect of the run, as a layer's is.
 */
const versionPlanOf = (
	spec: InstallSpec,
	declared: string,
	plan: RealInstallPlan,
	snapshot: DeploySnapshot
): Effect.Effect<VersionPlan, RealizeRefused> =>
	Effect.gen(function* () {
		const built = yield* buildInstall(spec, declared)
		const at: InstalledAt = {
			kind: "installed",
			installation: identity.schema(parsedSchemaName(declared))
		}
		const names = yield* namesOfBuiltAt(spec, built, at, codebookOf(snapshot))
		const snapshotJson = snapshotValue(snapshot, plan.installation)
		const compiled = yield* Effect.forEach(spec.logins, (l) =>
			Effect.flatMap(get(built.logins, l.name, "login"), (value) =>
				Effect.map(
					Effect.orDie(Effect.suspend(() => compileServed(value, snapshotJson, value.workload))),
					(json) => [l.name, json] as const
				)
			)
		)
		return {
			spec,
			built,
			names,
			plan,
			installation: plan.installation,
			snapshot,
			snapshotJson,
			served: Rec.fromEntries(
				Arr.map(compiled, ([login, json]) => [login, served<BuiltLogin>(json, login)] as const)
			),
			files: new Map(compiled)
		}
	})

/**
 * The snapshot.json of a release of `base` alone, without its worlds and logins, drafted for the installation
 * `installation` as `name` at `timestamp`: what no ledger target of a realization is. Drafted once, by the first open
 * that is handed it (Effect.cached), so a world none of whose opens names that release drafts none: the draft is a
 * whole generate of the base.
 */
const releaseSnapshot = (
	base: Built["base"],
	installation: Identity<"schema">,
	name: string,
	timestamp: string
): Effect.Effect<Effect.Effect<Fingerprinted>> =>
	Effect.cached(Effect.suspend(() => releaseDraft(base, installation, name, timestamp)))

/** releaseSnapshot's draft, run when it is first read. */
const releaseDraft = (
	base: Built["base"],
	installation: Identity<"schema">,
	name: string,
	timestamp: string
): Effect.Effect<Fingerprinted> => {
	const draft = generate({
		installation: installationOf(base, { kind: "installed", installation }),
		name,
		timestamp,
		previous: fromEmpty,
		workload: noWorkload,
		declared: noDeclarations
	})
	return draft.ok
		? Effect.sync(() =>
				snapshotJson(
					succeeded(
						writeRuntimeSnapshot(draft.value.snapshot, draft.value.derived),
						"snapshot.json"
					)
				)
			)
		: Effect.die(draft.error)
}

/**
 * A world's installation as planned, before it holds a session: its first version (VersionPlan), the snapshot.json of
 * the release before the first (the base alone, drafted for the installed schema, which the ledger has moved past) and
 * another schema's (foreign), each drafted when an open is first handed it (releaseSnapshot), and the served file of a
 * login no installed role is in (the stranger's), which serves no role. A case that installs its own world plans it
 * after its install, and a template's world (worldTemplate) is planned once per worker under the template's names.
 */
export interface WorldPlan {
	readonly first: VersionPlan
	readonly earlier: Effect.Effect<Fingerprinted>
	readonly foreign: Effect.Effect<Fingerprinted>
	readonly stranger: ServedLogin<BuiltLogin>
}

/**
 * The world `spec` installs as `installed` says it was installed (WorldPlan): its first version under the installed
 * name, each login installed as the role its names give it, a mismatch being a defect of the run.
 */
export const worldPlanOf = (
	spec: InstallSpec,
	installed: Pick<Installed, "declared" | "plan" | "snapshot">
): Effect.Effect<WorldPlan, RealizeRefused> =>
	Effect.gen(function* () {
		const declared = yield* baseBuild(spec)
		const first = yield* versionPlanOf(spec, installed.declared, installed.plan, installed.snapshot)
		for (const l of spec.logins) {
			const planned = yield* get(installed.plan.logins, l.name, "planned login")
			if (planned.role !== first.names.logins[l.name]) {
				return yield* Effect.die(
					new Error(
						`the login ${l.name} is installed as ${planned.role}, not ${String(first.names.logins[l.name])}`
					)
				)
			}
		}
		const [firstRelation] = spec.base.relations
		const strangerWhole = yield* get(first.built.relations, firstRelation.name, "relation")
		const strangerRole = yield* Effect.sync(() =>
			roleBuilder(first.built.base, "executorStranger", { [firstRelation.name]: strangerWhole })
		)
		const strangerLogin: BuiltLogin = yield* Effect.sync(() =>
			loginBuilder(first.built.base, "executorStrangerLogin", [strangerRole])
		)
		return {
			first,
			earlier: yield* releaseSnapshot(
				declared.base,
				identity.schema(parsedSchemaName(installed.declared)),
				"earlier",
				"20261012000000"
			),
			foreign: yield* releaseSnapshot(
				declared.base,
				identity.schema(parsedSchemaName(`${installed.declared}_foreign`)),
				"foreign",
				"20261013000000"
			),
			stranger: yield* Effect.orDie(servedOver(strangerLogin, first.snapshotJson))
		}
	})

/**
 * Realizes `installSpec` in the substrate, its own install under the ambient session `ambient`, built under its
 * allocated name and drafted with its logins as `grizzle generate` drafts it (draftedWorld), applied by the real runner
 * (install-migrate.ts appliedGenerated), planned after it (worldPlanOf), its decoder logins issued by the substrate as a layer first asks
 * (live-layer.ts decodersIn), every login's pool `poolSize` connections or the cluster pool's (worldOver).
 */
const realizeWith = (
	installSpec: InstallSpec,
	ambient: AmbientSession,
	poolSize: Option.Option<number>
) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: "worlds" })
		const { installed } = yield* Effect.flatMap(draftedWorld(installSpec, name), (drafted) =>
			appliedGenerated([drafted], name, ambient, (fresh) =>
				Effect.map(Effect.orDie(draftedWorld(installSpec, fresh)), (again) => again.plan)
			)
		).pipe(
			Effect.catchTags({
				CompileError: (refusal) =>
					Effect.fail(new RealizeRefused({ what: "the installation", refusal })),
				TransactionRolledBack: (rolledBack) => Effect.die(rolledBack)
			})
		)
		const plan = yield* worldPlanOf(installSpec, installed)
		const scope = yield* Effect.scope
		const decoderOf = yield* decodersIn(substrate, scope)
		return yield* worldOver(plan, installed, decoderOf, poolSize)
	})

/**
 * `install` built under the name `name` (build.ts buildInstall) and drafted with its logins as `grizzle generate`
 * drafts its first migration (install-migrate.ts generatedDraft).
 */
export const draftedWorld = (install: InstallSpec, name: string) =>
	Effect.gen(function* () {
		const declared = yield* buildInstall(install, name)
		return yield* generatedDraft(
			{ schema: declared.base, logins: Rec.values(declared.logins), declarations: noDeclarations },
			{ installation: identity.schema(parsedSchemaName(name)), previous: fromEmpty, step: 0 },
			noPlaceholders
		)
	})

/**
 * The world of `plan`, installed as `installed` in the substrate's database, each login's decoder login's password
 * `decoderOf`'s, every login's pool, the stranger's among them, `poolSize` connections or the cluster pool's: see
 * RealWorld.
 */
const worldOver = (
	plan: WorldPlan,
	installed: Installed,
	decoderOf: DecoderCredential,
	poolSize: Option.Option<number>
) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		/** The token the open in flight hands verify, none between opens (token.ts Handed). */
		const verifying: { handed: Option.Option<Handed> } = { handed: Option.none() }
		/** The verify calls of every login layer since the realization began. */
		const verified = { calls: 0 }
		const scope = yield* Effect.scope
		/** Every login layer's pool, the stranger's among them: `poolSize` connections, or the cluster pool's. */
		const pool = Option.match(poolSize, {
			onNone: () => clusterPool,
			onSome: (size) => ({ ...clusterPool, max: size })
		})

		/** The verify of every login layer that takes one: it reads the token, and counts its calls. */
		const verify = worldVerify(
			() => verifying.handed,
			() => {
				verified.calls++
			}
		)

		/**
		 * A login's layer over its served file `file`, as an application serves the file it imports: verify is given
		 * exactly when a role of the login reads a context, as README "Permissions" requires it, so a login whose roles
		 * read none turns no token into claims.
		 */
		const layerOver = (
			spec: InstallSpec,
			login: string,
			credentials: Credentials,
			file: ServedLogin<BuiltLogin>
		): SourcedLayer<BuiltLogin> =>
			servedSourcedLayer(decoderOf, {
				...clusterConnection(substrate.cluster, substrate.database, credentials.password),
				pool,
				login: file,
				...(loginVerifies(spec, login) ? { verify } : {})
			})

		/** A login's layer, its served file compiled under `snapshot` as generate compiles it (layerOver). */
		const layerOf = (
			spec: InstallSpec,
			built: Built,
			login: string,
			credentials: Credentials,
			snapshot: unknown
		): Effect.Effect<
			{
				readonly served: ServedLogin<BuiltLogin>
				readonly layer: SourcedLayer<BuiltLogin>
			},
			ServedRefusal
		> =>
			Effect.flatMap(get(built.logins, login, "login"), (value) =>
				Effect.map(servedOver(value, snapshot), (file) => ({
					served: file,
					layer: layerOver(spec, login, credentials, file)
				}))
			)

		/** A version (VersionPlan) with its logins' `credentials`, each login's layer built in the realization's scope. */
		const versionOver = (
			v: VersionPlan,
			credentials: Readonly<Record<string, Credentials>>
		): Effect.Effect<Version> =>
			Effect.gen(function* () {
				const layers: Record<string, LoginLayer> = {}
				for (const l of v.spec.logins) {
					const loginCredentials = yield* get(credentials, l.name, "credentials of")
					const file = yield* get(v.served, l.name, "served file of")
					const context = yield* Effect.orDie(
						Scope.provide(Layer.build(layerOver(v.spec, l.name, loginCredentials, file)), scope)
					)
					layers[l.name] = { served: file, snapshot: v.snapshotJson, context }
				}
				return { ...v, credentials, layers }
			})

		const firstCredentials = yield* Effect.forEach(plan.first.spec.logins, (l) =>
			Effect.map(
				get(plan.first.built.logins, l.name, "login"),
				(value) => [l.name, installed.as(value)] as const
			)
		)
		const first = yield* versionOver(plan.first, Rec.fromEntries(firstCredentials))
		/**
		 * The current version, and the snapshot.json an older release of the installation had, which the ledger has
		 * moved past: the latest version's whose fingerprint is not the current one's, or, before any, the release
		 * before the first.
		 */
		const state: {
			current: Version
			stale: Effect.Effect<Fingerprinted>
			directory: Directory
		} = {
			current: first,
			stale: plan.earlier,
			directory: { applied: installed.folders, pending: [] }
		}
		/** The layer of a login no installed role is in: what serves no role, where no other login is left. */
		const stranger = yield* Effect.orDie(
			Scope.provide(
				Layer.build(
					servedSourcedLayer(decoderOf, {
						...clusterConnection(substrate.cluster, substrate.database, Redacted.make("")),
						pool,
						login: plan.stranger
					})
				),
				scope
			)
		)
		const sessions = yield* Ref.make<ReadonlyArray<Session>>([])
		/** The scope of the case that last reset the world (reset), which each direct writer it begins lives in. */
		const caseScope = yield* Ref.make(Option.none<Scope.Scope>())
		const inFlight = yield* Ref.make<ReadonlyMap<number, Fiber.Fiber<Seen>>>(new Map())

		/**
		 * The snapshot the opening role's login layer is given (DbConfig), each the JSON value an import of its
		 * snapshot.json yields, which is how an application holds one: the current version's and an older one's; another
		 * schema's (foreign); and the directory's snapshot.json while folders are pending (drafted), the target no
		 * complete migration reached, which the new application version deployed early imports.
		 */
		const snapshotOf = (ref: SnapshotRef): Effect.Effect<Fingerprinted> => {
			switch (ref) {
				case "current":
					return Effect.succeed(state.current.snapshotJson)
				case "stale":
					return state.stale
				case "foreign":
					return plan.foreign
			}
		}

		const mint = (session: Session): Effect.Effect<number> =>
			Ref.modify(sessions, (all) => [all.length, [...all, session]])

		const sessionAt = (id: number): Effect.Effect<Option.Option<Session>> =>
			Effect.map(Ref.get(sessions), (all) => Option.fromNullishOr(all[id]))

		const setSession = (id: number, session: Session): Effect.Effect<void> =>
			Ref.update(sessions, (all) => Arr.map(all, (s, i) => (i === id ? session : s)))

		/** The layers of every login but `except`: a stranger's alone when none is left, so a role is served by none. */
		const allLayers = (except: Option.Option<string>): Context.Context<DbLayerOf<BuiltLogin>> => {
			const layers = Arr.map(
				Arr.filter(Rec.toEntries(state.current.layers), ([login]) =>
					Option.match(except, { onNone: () => true, onSome: (e) => e !== login })
				),
				([, layer]) => layer.context
			)
			const [firstLayer, ...rest] = layers
			return Arr.reduce(rest, firstLayer ?? stranger, (ctx, layer) => Context.merge(ctx, layer))
		}

		/**
		 * `value` reached through a login of its own over `base`, which no layer serves: how a role no installed login
		 * holds is handed to Db.open.
		 */
		const reachedUnheld = (
			base: Built["base"],
			value: BuiltRole
		): Effect.Effect<{
			readonly login: BuiltLogin
			readonly role: LoginRole<BuiltRole, readonly []>
		}> =>
			Effect.flatMap(
				Effect.sync(() => loginBuilder(base, unheldLogin, [value])),
				(unserved) =>
					Effect.map(get(unserved.roles, value.name, "role of the unheld login"), (role) => ({
						login: unserved,
						role
					}))
			)

		/**
		 * A reference that is no installed role, as Db.open is handed it: a role value of its name over the current base
		 * that no installed login holds, reached through a login no layer serves, whose served file is compiled under the
		 * current snapshot, and opened under every login's layer. A dropped role's is the value an application kept of a
		 * role a migration removed, a nonexistent one's a name no installation gave, and the owner's the owner's own
		 * PostgreSQL name; none is a role of an installed login, whatever its name.
		 */
		const unheld = (current: Version, name: string) =>
			Effect.gen(function* () {
				const [anyRelation] = current.spec.base.relations
				const whole = yield* get(current.built.relations, anyRelation.name, "relation")
				const value: BuiltRole = yield* Effect.sync(() =>
					roleBuilder(current.built.base, name, { [anyRelation.name]: whole })
				)
				const reached = yield* reachedUnheld(current.built.base, value)
				const file = yield* Effect.result(servedOver(reached.login, current.snapshotJson))
				return {
					value,
					reached: reached.role,
					held: Option.none<Held>(),
					served: Result.map(file, (served) => servedRoleOf(served, name)),
					snapshot: current.snapshotJson,
					context: allLayers(Option.none())
				}
			})

		/**
		 * The role value an open names, that role reached through its login, the served role Db.open is handed, the
		 * snapshot its login's file was compiled under, and the version's layers it is opened under.
		 */
		const roleFor = (ref: RoleRef) =>
			Effect.gen(function* () {
				const current = state.current
				switch (ref.kind) {
					case "own":
					case "other-login": {
						const login = Arr.findFirst(current.spec.logins, (l) => l.roles.includes(ref.role))
						if (Option.isNone(login)) {
							return yield* unheld(current, ref.role)
						}
						const value = yield* get(current.built.roles, ref.role, "role")
						const name = login.value.name
						const holder = yield* get(current.built.logins, name, "login")
						const layer = yield* get(current.layers, name, "layer of")
						const reached = yield* get(holder.roles, ref.role, "role of login")
						return {
							value,
							reached,
							held: heldOf(current.spec, ref.role, name),
							served: Result.succeed(servedRoleOf(layer.served, ref.role)),
							snapshot: layer.snapshot,
							context: ref.kind === "own" ? layer.context : allLayers(Option.some(name))
						}
					}
					case "dropped":
						return yield* unheld(current, ref.role)
					case "nonexistent":
						return yield* unheld(current, ref.name)
					case "owner":
						return yield* unheld(current, substrate.owner.role)
				}
			})

		/**
		 * What an open hands Db.open and the layers it runs under, its login's file compiled under the snapshot it names:
		 * the version's file and layers for the current snapshot; for another, the role's login's file compiled under
		 * that snapshot and a layer over it built for that open, in the realization's scope, so the Db it opens keeps its
		 * pool, and whose refusal (a compile that refuses the login's roles or programs under that snapshot's codes, a
		 * file the layer does not load) is the open's. A reference that is no role of its own login meets the version's
		 * layers alone, whatever the snapshot, and is refused at role.
		 */
		const openTarget = (ref: RoleRef, snapshot: SnapshotRef): Effect.Effect<OpenTarget> =>
			Effect.gen(function* () {
				const target = yield* roleFor(ref)
				const { value, reached, held } = target
				if (snapshot === "current" || ref.kind !== "own" || Option.isNone(held)) {
					return {
						value,
						reached,
						held,
						opening: Effect.mapBoth(Effect.fromResult(target.served), {
							onFailure: (refusal) => new UnservableRole({ refusal }),
							onSuccess: (role) => ({ role, snapshot: target.snapshot, context: target.context })
						})
					}
				}
				const current = state.current
				const login = held.value.login
				const credentials = yield* get(current.credentials, login, "credentials of")
				const probeSnapshot = yield* snapshotOf(snapshot)
				return {
					value,
					reached,
					held,
					opening: Effect.gen(function* () {
						const made = yield* layerOf(
							current.spec,
							current.built,
							login,
							credentials,
							probeSnapshot
						)
						const context = yield* Scope.provide(Layer.build(made.layer), scope)
						return {
							role: servedRoleOf(made.served, value.name),
							snapshot: probeSnapshot,
							context
						}
					})
				}
			})

		/** The options a session's per-action compile of a read again runs under: the installation's allocation and codes. */
		const compileOf = (v: Version): TestCompileOptions => ({
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared)),
			codes: installedCodes(codebookOf(v.snapshot))
		})

		/**
		 * An open's end: a refusal of Db.open at its stage; a served compile's refusal of the login's file under the
		 * snapshot the open names, which refuses the open at `schema` before any verify, as a layer refuses a file it
		 * cannot serve; the served compile's refusal of a role no served file can hold, compile-refused, since no
		 * application reaches Db.open with it; else the Db opened (openedDb).
		 */
		const opened = (
			target: OpenTarget,
			exit: Exit.Exit<
				{ readonly ctx: ServedDbContext; readonly snapshot: unknown },
				OpenError | ServedRefusal | UnservableRole
			>,
			verifyCalls: 0 | 1
		): Effect.Effect<Seen> =>
			Exit.match(exit, {
				onFailure: (cause) =>
					Result.match(Cause.findError(cause), {
						onFailure: (rest) => Effect.failCause(rest),
						onSuccess: (error) =>
							error instanceof UnservableRole
								? Effect.succeed(refusedWith({ kind: "compile-refused" }, error.refusal.error))
								: "place" in error
									? Effect.succeed(
											refusedWith(
												{ kind: "open-refused", stage: "schema", verifyCalls: 0 },
												error.error
											)
										)
									: Effect.map(openRefused(error, verifyCalls), (observation) =>
											refusedWith(observation, error)
										)
					}),
				onSuccess: (o) => openedDb(target, o.ctx, o.snapshot, verifyCalls)
			})

		/**
		 * A Db opened: a session of its role in its login, minted; one for a role the installation does not hold is a
		 * defect. Db.open contacts nothing, so the executor leases sessions of the Db's pool at once and releases them,
		 * sending nothing but new connections' startups: one, or a racing world's every connection (`poolSize`), leased
		 * together. The pool then holds its connections from the open on, as the model's connections are
		 * (model/session/open.ts), whatever the Db's first call meets, and which ready connection serves a race's call is
		 * the pool's choice, never how long a connection took to start.
		 */
		const openedDb = (
			target: Pick<OpenTarget, "value" | "reached" | "held">,
			ctx: ServedDbContext,
			snapshot: unknown,
			verifyCalls: 0 | 1
		): Effect.Effect<Seen> =>
			Option.match(target.held, {
				onNone: () =>
					Effect.die(new Error("a Db opened for a role the installation does not hold")),
				onSome: ({ role, login }) =>
					Effect.gen(function* () {
						yield* Effect.orDie(
							Effect.scoped(
								Effect.all(
									upTo(
										Option.getOrElse(poolSize, () => 1),
										() => ctx.pool.lease
									),
									{ concurrency: "unbounded" }
								)
							)
						)
						const current = state.current
						const backend = yield* Ref.make(Option.none<number>())
						const session = yield* mint({
							kind: "db",
							login,
							role,
							base: current.spec.base,
							refusals: refusalReader(current.installation),
							value: target.value,
							reached: target.reached,
							snapshot,
							compile: compileOf(current),
							ctx: { ...ctx, pool: leaseRecording(ctx.pool, backend) },
							backend
						})
						return seen({ kind: "opened", session, verifyCalls })
					})
			})

		const openDb = (action: Extract<Action, { readonly kind: "open-db" }>): Effect.Effect<Seen> =>
			Effect.gen(function* () {
				const target = yield* openTarget(action.role, action.snapshot)
				const handed = handedOf(action.token)
				const options = Option.match(handed, {
					onNone: () => ({}),
					onSome: (token) => ({ token: token.text })
				})
				const before = verified.calls
				const exit = yield* Effect.exit(
					Effect.scoped(
						Effect.flatMap(target.opening, (opening) =>
							Effect.map(
								handing(
									handed,
									Effect.provideContext(openServed(opening.role, options), opening.context)
								),
								(o) => ({ ctx: o.ctx, snapshot: opening.snapshot })
							)
						)
					)
				)
				const calls = yield* verifyCallsSince(before)
				return yield* opened(target, exit, calls)
			})

		/** An open with the token it hands verify in flight, and none once it ends, however it ends. */
		const handing = <A, E, R>(
			handed: Option.Option<Handed>,
			open: Effect.Effect<A, E, R>
		): Effect.Effect<A, E, R> =>
			Effect.ensuring(
				Effect.suspend(() => {
					verifying.handed = handed
					return open
				}),
				Effect.sync(() => {
					verifying.handed = Option.none()
				})
			)

		/** How often verify ran since `before`: once at most per open, as README "Permissions" says: verify runs once per Db. */
		const verifyCallsSince = (before: number): Effect.Effect<0 | 1> => {
			const calls = verified.calls - before
			return calls === 0
				? Effect.succeed(0)
				: calls === 1
					? Effect.succeed(1)
					: Effect.die(new Error(`verify ran ${calls} times for one Db.open`))
		}

		const dbSession = (id: number): Effect.Effect<Option.Option<DbSession>> =>
			Effect.map(sessionAt(id), (s) => Option.filter(s, (x): x is DbSession => x.kind === "db"))

		const directSession = (id: number): Effect.Effect<Option.Option<DirectSession>> =>
			Effect.map(sessionAt(id), (s) =>
				Option.filter(s, (x): x is DirectSession => x.kind === "direct")
			)

		const handleRefused = seen({ kind: "handle-refused" })

		/** A grizzle call on a Db session, registered as in flight so an interrupt can reach it. */
		const call = (
			id: number,
			body: (session: DbSession) => Effect.Effect<Seen>
		): Effect.Effect<Seen> =>
			Effect.gen(function* () {
				const session = yield* dbSession(id)
				if (Option.isNone(session)) {
					return handleRefused
				}
				const fiber = yield* Effect.forkChild(body(session.value))
				yield* Ref.update(inFlight, (m) => new Map([...m, [id, fiber]]))
				const exit = yield* Fiber.await(fiber)
				yield* Ref.update(inFlight, (m) => new Map(Arr.filter([...m], ([k]) => k !== id)))
				return Exit.hasInterrupts(exit) ? seen({ kind: "interrupted" }) : yield* exit
			})

		const reading = (): LawReading => ({
			base: state.current.spec.base,
			names: state.current.names,
			installation: state.current.installation
		})

		const directNames = (): DirectNames => {
			const v = state.current
			return {
				table: (relation) => get(v.plan.tables, relation, "installed table"),
				domain: (relation, field) => domainOf(v.spec.base, relation, field),
				view: (role, relation) =>
					Effect.gen(function* () {
						const ownedRole = yield* ownedOf(v, role)
						const spec = roleOf(v.spec, role)
						if (spec === undefined) {
							return yield* missing(`role ${role}`)
						}
						const read = roleReadNames(
							v.installation.names,
							worldNames(
								succeeded(namedRole(ownedRole, v.installation.names.levels), `role ${role} named`),
								v.installation.names
							),
							ownedRole
						)
						const view = read.relation(relation)
						const fields = Option.getOrElse(entryFields(v.spec.base, spec, relation), () => [])
						return {
							schema: view.schema,
							name: view.name,
							fields: Arr.map(fields, (f) => ({ ...f, column: read.column(relation, f.field) }))
						}
					}),
				role: (ref) => {
					switch (ref.kind) {
						case "own":
						case "other-login":
							return get(v.names.roles, ref.role, "role")
						case "dropped":
							return Effect.sync(() => installedRoleName(v.installation, ref.role))
						case "nonexistent":
							return Effect.succeed(ref.name)
						case "owner":
							return Effect.succeed(substrate.owner.role)
					}
				},
				function: (fn) =>
					Effect.map(functionOf(v, fn), (name) => ({
						name,
						parameters: Option.fromUndefinedOr(parametersOf(v.spec, fn))
					})),
				codes: v.installation.names.codes,
				contexts: v.spec.base.contexts,
				standUps: standUpCallsOf(v.installation, v.installation.names.schema)
			}
		}

		/** The current installation as a perturbation meets it; a database-level change is undone with the realization. */
		const catalogOf = (): Catalog => {
			const v = state.current
			return {
				names: v.names,
				installation: v.installation,
				database: substrate.database,
				owner: substrate.owner.role,
				owned: (role) => ownedOf(v, role),
				function: (fn) => functionOf(v, fn),
				domain: (relation, field) => domainOf(v.spec.base, relation, field),
				restoring: (undo) => Scope.addFinalizer(scope, Effect.orDie(undo)),
				superuser: substrate.superuser
			}
		}

		/**
		 * A psql child of `login` that has begun a transaction at `isolation`, its scope forked from the case's (reset): the
		 * case's end ends it. A direct writer begun before any case is a defect of its caller.
		 */
		const begun = (login: string, isolation: Isolation): Effect.Effect<DirectSession> =>
			Effect.gen(function* () {
				const credentials = yield* get(state.current.credentials, login, "credentials of")
				const owner = yield* Ref.get(caseScope)
				if (Option.isNone(owner)) {
					return yield* Effect.die(
						new Error(
							`a direct writer of ${login} begun before the world's first reset began a case`
						)
					)
				}
				const sessionScope = yield* Scope.fork(owner.value)
				const writer = yield* Effect.orDie(
					Scope.provide(
						substrate.psql({ ...rolePsql(credentials), label: `direct ${login}` }),
						sessionScope
					)
				)
				yield* Effect.orDie(writer.run(beginSql(isolation)))
				return {
					kind: "direct",
					login,
					writer,
					pid: writer.backend.pid,
					scope: sessionScope,
					prepared: new Map()
				}
			})

		const directBegin = (
			action: Extract<Action, { readonly kind: "direct-begin" }>
		): Effect.Effect<Seen> =>
			Effect.gen(function* () {
				const session = yield* begun(action.login, action.isolation)
				const id = yield* mint(session)
				return yield* started(id, session, startStatements(action.start))
			})

		/**
		 * The session at `id` with its transaction begun again: on its own connection while it is open, its aborted
		 * transaction rolled back and the reads it prepared, which outlive a transaction, deallocated; on a connection of
		 * its login's own once its COMMIT closed it. The backend serving an open session stays its own, so a schedule
		 * watching it sees every wait of its later moves.
		 */
		const begunAgain = (
			id: number,
			login: string,
			isolation: Isolation
		): Effect.Effect<DirectSession> =>
			Effect.gen(function* () {
				const held = yield* directSession(id)
				if (Option.isNone(held)) {
					const session = yield* begun(login, isolation)
					yield* setSession(id, session)
					return session
				}
				const session = held.value
				yield* Effect.orDie(session.writer.run("ROLLBACK"))
				yield* Effect.orDie(session.writer.run("DEALLOCATE ALL"))
				session.prepared.clear()
				yield* Effect.orDie(session.writer.run(beginSql(isolation)))
				return session
			})

		const rebegin = (
			id: number,
			login: string,
			isolation: Isolation,
			sent: ReadonlyArray<DirectStatement>
		): Effect.Effect<ReadonlyArray<Observation>> =>
			Effect.gen(function* () {
				const session = yield* begunAgain(id, login, isolation)
				const answers: Array<Observation> = []
				for (const statement of sent) {
					const answered = (yield* runDirect(reading(), directNames(), session, statement))
						.observation
					if (answered.kind === "refused" && answered.sqlstate === "40001") {
						return yield* rebegin(id, login, isolation, sent)
					}
					if (answered.kind !== "ok" && answered.kind !== "rows") {
						return yield* Effect.die(
							new Error(
								`session ${id}'s transaction begun again answered ${Formatter.format(answered)} to ${Formatter.format(statement)}, which it once answered ok`
							)
						)
					}
					answers.push(answered)
				}
				return answers
			})

		/**
		 * A begun writer's start statements (startStatements), each sent as its own statement: opened once every one is
		 * ok, otherwise the first one's refusal, as the worlds model's startedBranches judges them.
		 */
		const started = (
			id: number,
			session: DirectSession,
			statements: ReadonlyArray<DirectStatement>
		): Effect.Effect<Seen> => {
			const [first, ...rest] = statements
			return first === undefined
				? Effect.succeed(seen({ kind: "opened", session: id, verifyCalls: 0 }))
				: Effect.filterOrElse(
						runDirect(reading(), directNames(), session, first),
						(done) => done.observation.kind !== "ok",
						() => started(id, session, rest)
					)
		}

		const closeSession = (id: number, session: DbSession | DirectSession): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (session.kind === "direct") {
					yield* Scope.close(session.scope, Exit.void)
				}
				yield* setSession(id, { kind: "closed", was: session.kind })
			})

		const interrupt = (
			action: Extract<Action, { readonly kind: "interrupt" }>
		): Effect.Effect<Seen> =>
			Effect.gen(function* () {
				const session = yield* sessionAt(action.session)
				if (Option.isNone(session) || session.value.kind === "closed") {
					return handleRefused
				}
				const s = session.value
				if (s.kind === "direct") {
					const committing = yield* Effect.forkChild(s.writer.commit)
					yield* Fiber.interrupt(committing)
					yield* closeSession(action.session, s)
					return seen({ kind: "interrupted" })
				}
				const running = yield* Ref.get(inFlight)
				const fiber = Option.fromNullishOr(running.get(action.session))
				if (Option.isNone(fiber)) {
					return seen({ kind: "ok" })
				}
				yield* Fiber.interrupt(fiber.value)
				const exit = yield* Fiber.await(fiber.value)
				return Exit.hasInterrupts(exit) ? seen({ kind: "interrupted" }) : yield* exit
			})

		const wild = (action: Extract<Action, { readonly kind: "wild" }>): Effect.Effect<Seen> =>
			Effect.gen(function* () {
				const value = wildValue(action.wild)
				const at = action.at
				switch (at.kind) {
					case "open-role":
						return yield* openWild(value, Option.none(), allLayers(Option.none()), () =>
							Effect.die(new Error("Db.open opened a Db for a wild role"))
						)
					case "open-token": {
						const target = yield* roleFor({ kind: "own", role: at.role })
						const served = yield* Effect.orDie(Effect.fromResult(target.served))
						return yield* openWild(
							served,
							Option.some(value),
							target.context,
							(opened, verifyCalls) => openedDb(target, opened.ctx, target.snapshot, verifyCalls)
						)
					}
					case "session":
						return yield* call(at.session, (session) => {
							switch (at.call) {
								case "read":
									return executeValue(session, value)
								case "apply":
									return applyValue(session, value)
							}
						})
				}
			})

		/**
		 * Db.open handed a value its types refuse, as a JavaScript caller hands it, through openServed, the open Db.open
		 * keeps the Db of: a refusal is observed at its stage, and a Db it opens (a wild token it reads as no token, or as a
		 * payload) is `onOpened`'s.
		 */
		const openWild = (
			role: unknown,
			token: Option.Option<unknown>,
			context: Context.Context<DbLayerOf<BuiltLogin>>,
			onOpened: (
				opened: { readonly ctx: ServedDbContext },
				verifyCalls: 0 | 1
			) => Effect.Effect<Seen>
		): Effect.Effect<Seen> =>
			Effect.gen(function* () {
				const options = Option.match(token, {
					onNone: () => ({}),
					onSome: (t) => ({ token: t })
				})
				const opening: unknown = Reflect.apply(openServed, undefined, [role, options])
				if (!isOpening(opening)) {
					return yield* Effect.die(new Error("Db.open handed a wild value returned no Effect"))
				}
				const before = verified.calls
				/** A wild token that is a string is what verify reads; any other is refused before verify runs. */
				const handed = Option.flatMap(token, (t) =>
					typeof t === "string" ? Option.some({ text: t, wild: Option.none() }) : Option.none()
				)
				const exit = yield* Effect.exit(
					handing(
						handed,
						Effect.provideContext(
							Effect.mapError(opening, (cause) => new Thrown({ cause })),
							context
						)
					)
				)
				const verifyCalls = yield* verifyCallsSince(before)
				return yield* Exit.match(exit, {
					onFailure: (cause) =>
						Result.match(Cause.findError(cause), {
							onFailure: (rest) => Effect.failCause(rest),
							onSuccess: (thrown) =>
								thrown.cause instanceof OpenError
									? Effect.map(openRefused(thrown.cause, verifyCalls), (observation) =>
											refusedWith(observation, thrown.cause)
										)
									: Effect.die(thrown.cause)
						}),
					onSuccess: (opened) => onOpened(opened, verifyCalls)
				})
			})

		const seenOf = (action: Action): Effect.Effect<Seen> => {
			switch (action.kind) {
				case "open-db":
					return openDb(action)
				case "read":
					return call(action.session, (s) => readSession(s, action.relation, action.via))
				case "apply":
					return call(action.session, (s) => applySession(s, action.strata, action.reads))
				case "close":
					return Effect.gen(function* () {
						const s = yield* sessionAt(action.session)
						if (Option.isNone(s) || s.value.kind === "closed") {
							return handleRefused
						}
						yield* closeSession(action.session, s.value)
						return seen({ kind: "ok" })
					})
				case "direct-begin":
					return directBegin(action)
				case "direct":
					return Effect.gen(function* () {
						const s = yield* directSession(action.session)
						return Option.isNone(s)
							? handleRefused
							: yield* runDirect(reading(), directNames(), s.value, action.statement)
					})
				case "direct-end":
					return Effect.gen(function* () {
						const s = yield* directSession(action.session)
						if (Option.isNone(s)) {
							return handleRefused
						}
						const ended = yield* endDirect(reading(), s.value, action.end)
						yield* closeSession(action.session, s.value)
						return ended
					})
				case "interrupt":
					return interrupt(action)
				case "migrate":
					return migrate(action)
				case "tamper":
					return Effect.map(
						Effect.orDie(tamper(substrate.admin, catalogOf(), action.perturbation)),
						seen
					)
				case "drift":
					return driftRun
				case "wild":
					return wild(action)
			}
		}

		/** The snapshot.json the directory holds: the last folder's target, the current version's when none is pending. */
		const directorySnapshot = (): DeploySnapshot =>
			Option.match(Arr.last(state.directory.pending), {
				onNone: () => state.current.snapshot,
				onSome: (p) => p.next.snapshot
			})

		/**
		 * The last of the drafted versions a run landed, oldest first, made current: its values, its layers, and its
		 * logins' credentials. A login the current version and every landed one hold keeps its password; any other is a
		 * PostgreSQL role a landed folder created, a removed login being dropped and every rename declined (draftNext),
		 * which holds no password until the substrate sets one, whatever an earlier role of its name held.
		 */
		const makeCurrent = (landed: Arr.NonEmptyReadonlyArray<Next>): Effect.Effect<void> =>
			Effect.gen(function* () {
				const next = Arr.lastNonEmpty(landed)
				const kept = (login: string): boolean =>
					Arr.every([state.current.spec, ...Arr.map(landed, (p) => p.spec)], (spec) =>
						Arr.some(spec.logins, (l) => l.name === login)
					)
				const credentials: Record<string, Credentials> = {}
				for (const l of next.spec.logins) {
					const held = state.current.credentials[l.name]
					if (held !== undefined && kept(l.name)) {
						credentials[l.name] = held
					} else {
						const planned = yield* get(next.plan.logins, l.name, "planned login")
						credentials[l.name] = yield* Effect.orDie(
							Scope.provide(substrate.login(planned.role), scope)
						)
					}
				}
				const nextPlan = yield* Effect.orDie(
					versionPlanOf(next.spec, installed.declared, next.plan, next.snapshot)
				)
				const version = yield* versionOver(nextPlan, credentials)
				if (version.snapshot.fingerprint !== state.current.snapshot.fingerprint) {
					state.stale = Effect.succeed(state.current.snapshotJson)
				}
				state.current = version
			})

		/**
		 * The folders of `directory` run as grizzle migrate runs them, handed as `folders` (the directory's, but for a file
		 * edited by hand) and ended as `end` says, its pending folders resumed oldest first:
		 * - all applied: every pending version landed, the last one current, whether the drift check after them passes or
		 *   refuses a catalog tampered with beforehand;
		 * - stopped inside a pending folder, by a statement of it or a killed deploy (which dies inside the last): every
		 *   pending folder before it landed, the last of them current, and it and those after it stay pending;
		 * - refused before any file ran: the directory is as it was, the operator discarding a folder no run took.
		 */
		const runTo = (
			directory: Directory,
			folders: ReadonlyArray<FolderTexts>,
			end: RunEnd
		): Effect.Effect<Ran> =>
			Effect.gen(function* () {
				const target = Option.match(Arr.last(directory.pending), {
					onNone: () => state.current.snapshot,
					onSome: (p) => p.next.snapshot
				})
				const outcome = yield* runFolders(substrate, installed.ambientOwner, target, folders, end)
				const failedIn =
					outcome.kind === "refused" ? failedFolder(outcome.error) : Option.none<string>()
				const stoppedAt =
					outcome.kind === "killed"
						? Arr.last(directory.pending)
						: Option.flatMap(failedIn, (folder) =>
								Arr.findFirst(directory.pending, (p) => p.folder.name === folder)
							)
				const applied =
					outcome.kind === "applied" ||
					(outcome.kind === "refused" && outcome.error.stage === "drift")
				const landed = applied
					? directory.pending
					: Option.match(stoppedAt, {
							onNone: () => [],
							onSome: (stop) => directory.pending.slice(0, directory.pending.indexOf(stop))
						})
				if (Arr.isReadonlyArrayNonEmpty(landed)) {
					yield* makeCurrent(Arr.map(landed, (p) => p.next))
				}
				if (applied || Option.isSome(stoppedAt)) {
					state.directory = {
						applied: [...directory.applied, ...Arr.map(landed, (p) => p.folder)],
						pending: directory.pending.slice(landed.length)
					}
				}
				const lawOf = (identity: string): Effect.Effect<Option.Option<LawId>> =>
					Option.match(stoppedAt, {
						onNone: () => Effect.succeedNone,
						onSome: (stop) =>
							Effect.map(namesOfNext(stop.next), (names) =>
								judgedLawOf(stop.next.spec.base, names, identity)
							)
					})
				return { outcome, lawOf }
			})

		/** The names of a drafted version as the installation installs them, under the installation's declared name. */
		const namesOfNext = (next: Next): Effect.Effect<InstalledNames> =>
			Effect.gen(function* () {
				const built = yield* Effect.orDie(buildInstall(next.spec, installed.declared))
				const at: InstalledAt = {
					kind: "installed",
					installation: identity.schema(parsedSchemaName(installed.declared))
				}
				return yield* namesOfBuiltAt(next.spec, built, at, codebookOf(next.snapshot))
			})

		/**
		 * The next version's migration, drafted from the directory's snapshot.json, landed and ended as `how` says and run
		 * with every folder of the directory. An installation grizzle's builders refuse, or one generate refuses for
		 * declaring a roster out of its codes' order (D1), is compile-refused before anything is drafted.
		 */
		const migrate = (action: Extract<Action, { readonly kind: "migrate" }>): Effect.Effect<Seen> =>
			Effect.gen(function* () {
				const built = yield* Effect.result(buildInstall(action.to, installed.declared))
				if (Result.isFailure(built)) {
					return refusedWith({ kind: "compile-refused" }, built.failure.refusal)
				}
				const next_ = yield* Effect.result(
					draftNext(built.success.base, Rec.values(built.success.logins), installed.declared, {
						snapshot: directorySnapshot(),
						folders: foldersOf(state.directory)
					})
				)
				if (Result.isFailure(next_)) {
					return refusedWith({ kind: "compile-refused" }, next_.failure.refusal)
				}
				const drafted = next_.success
				const next: Next = { spec: action.to, plan: drafted.plan, snapshot: drafted.snapshot }
				const end = yield* runEndOf(drafted.folder, action.how)
				const outcome = yield* runTo(
					{
						applied: state.directory.applied,
						pending: [...state.directory.pending, { folder: drafted.folder, next }]
					},
					landedFolders(
						{
							applied: state.directory.applied,
							pending: Arr.map(state.directory.pending, (p) => p.folder)
						},
						drafted.folder,
						action.how
					),
					end
				)
				return yield* ranSeen(outcome, { kind: "ok" }, () => ({
					kind: "migration-refused",
					stage: "drift"
				}))
			})

		/**
		 * grizzle drift over the directory: its folders run, each applied one checked against its ledger row and the catalog
		 * against snapshot.json; pending folders are resumed, each landing as it applies.
		 */
		const driftRun: Effect.Effect<Seen> = Effect.suspend(() => {
			const directory = state.directory
			return directory.pending.length === 0
				? drift(substrate, installed.ambientOwner, state.current.snapshot, directory.applied)
				: Effect.flatMap(runTo(directory, foldersOf(directory), { kind: "runner" }), (outcome) =>
						ranSeen(outcome, { kind: "drift", objects: [] }, (objects) => ({
							kind: "drift",
							objects
						}))
					)
		})

		/**
		 * An action's answer with any hidden value it shows as that leak. A verify call outside an open is a defect of the
		 * run, which worldVerify raises: it runs once per Db.open, never for a call, and only while its open is in flight.
		 */
		const performedWith = (action: Action, hidden: ReadonlySet<string>): Effect.Effect<Performed> =>
			Effect.map(seenOf(action), (s) => ({
				observation: Option.getOrElse(
					leakOf(hidden, [
						...s.found,
						...Arr.map(witnessTexts(s.observation), (text) => ({ field: "witness" as const, text }))
					]),
					() => s.observation
				),
				because: s.told
			}))

		const perform = (action: Action, hidden: ReadonlySet<string>): Effect.Effect<Observation> =>
			Effect.map(performedWith(action, hidden), (p) => p.observation)

		const probe = (id: number): Effect.Effect<Probe> =>
			Effect.gen(function* () {
				const s = yield* sessionAt(id)
				if (Option.isNone(s) || s.value.kind === "closed") {
					return yield* missing(`open session ${id} to probe`)
				}
				const session = s.value
				if (session.kind === "direct") {
					return yield* probeDirect(session)
				}
				return yield* probePool(session.ctx.pool)
			})

		const readAll = substrate.superuserRead((rows) =>
			Effect.gen(function* () {
				const v = state.current
				const read = (
					name: string,
					fields: ReadonlyArray<{ readonly field: string; readonly domain: FieldDomain }>
				) =>
					Effect.gen(function* () {
						const named = yield* get(v.names.tables, name, "table")
						const table = `${quoteIdent(named.schema)}.${quoteIdent(named.name)}`
						const columns = yield* get(v.names.columns, name, "columns")
						const select = yield* Effect.forEach(fields, (f) =>
							Effect.map(get(columns, f.field, "column"), (c) => `${quoteIdent(c)}::text`)
						)
						const answered = yield* rows(`SELECT ${Arr.join(select, ", ")} FROM ${table}`)
						return yield* Effect.forEach(answered, (row) =>
							Effect.map(
								Effect.forEach(fields, (f, i) => {
									const cell = row[i]
									return cell !== undefined && cell !== null
										? Effect.map(
												valueOfText(
													f.domain,
													cell,
													`${name}.${f.field}`,
													v.installation.names.codes
												),
												(value) => [f.field, value] as const
											)
										: missing(`text of ${name}.${f.field}`)
								}),
								(entries): HostFact => Rec.fromEntries(entries)
							)
						)
					})
				const reality = new Map<string, ReadonlyArray<HostFact>>()
				for (const r of v.spec.base.relations) {
					const observed = yield* read(
						r.name,
						Arr.map(r.fields, (f) => ({ field: f.name, domain: f.domain }))
					)
					reality.set(r.name, observed)
				}
				return reality
			})
		)

		const reset = (reality: HostState): Effect.Effect<void, SqlError, Scope.Scope> =>
			Effect.gen(function* () {
				const owner = yield* Effect.scope
				yield* Ref.set(caseScope, Option.some(owner))
				const all = yield* Ref.get(sessions)
				yield* Effect.forEach(
					all,
					(s, i) => (s.kind === "closed" ? Effect.void : closeSession(i, s)),
					{
						discard: true
					}
				)
				yield* Ref.set(sessions, [])
				const v = state.current
				const facts = Rec.fromEntries(
					Arr.map(
						v.spec.base.relations,
						(r) =>
							[
								r.name,
								Arr.map(reality.get(r.name) ?? [], (fact) =>
									Rec.map(fact, (value, field) => {
										const domain = fieldDomain(
											v.spec.base,
											{ kind: "ordinary", name: r.name },
											field
										)
										return domain === undefined ? value : carrierOf(domain, value)
									})
								)
							] as const
					)
				)
				const statements = yield* Effect.orDie(fromEngine(factStatements(v.plan, facts)))
				yield* Effect.catchTag(
					replaceRows(
						substrate.admin,
						installationGroup(installationNamesOf(v.installation)),
						Arr.map(statements, (sql) => ({ sql, params: [] }))
					),
					"TransactionRolledBack",
					(e) => Effect.die(e)
				)
			})

		const world: RacingWorld = {
			get names() {
				return state.current.names
			},
			migrator: installed.ambientOwner.credentials.role,
			reset,
			stored: readAll,
			perform,
			performed: performedWith,
			probe,
			rebegin,
			psql: (login) =>
				Effect.gen(function* () {
					const credentials = yield* get(state.current.credentials, login, "credentials of")
					return yield* Effect.orDie(
						substrate.psql({ ...rolePsql(credentials), label: `direct ${login}` })
					)
				}),
			backend: (id) =>
				Effect.gen(function* () {
					const s = yield* sessionAt(id)
					if (Option.isNone(s) || s.value.kind === "closed") {
						return yield* missing(`open session ${id}`)
					}
					const session = s.value
					return session.kind === "direct"
						? Option.some(session.pid)
						: yield* Ref.get(session.backend)
				})
		}
		return world
	})

/**
 * A run of the directory's folders, and the law of the folder it stopped in that each identity names (host.ts
 * judgedLawOf), read of that folder's installation's names once a refusal names one: none where it stopped in no
 * pending folder.
 */
interface Ran {
	readonly outcome: RunOutcome
	readonly lawOf: (identity: string) => Effect.Effect<Option.Option<LawId>>
}

/**
 * A run's observation: `whole` when its folders all applied, `drifted` of the mismatches when its drift check refused
 * the catalog (a migrate's refusal at stage drift, a drift run's report), another refusal's, or interrupted for a
 * killed deploy.
 */
const ranSeen = (
	{ outcome, lawOf }: Ran,
	whole: Observation,
	drifted: (objects: ReadonlyArray<string>) => Observation
): Effect.Effect<Seen> => {
	switch (outcome.kind) {
		case "applied":
			return Effect.succeed(seen(whole))
		case "refused":
			return migrationRefused(outcome.error, drifted, lawOf)
		case "killed":
			return Effect.succeed(seen({ kind: "interrupted" }))
	}
}

/** A grizzle role of a version, owned as the installation owns it. */
const ownedOf = (v: Version, role: string): Effect.Effect<OwnedRole> =>
	Effect.gen(function* () {
		const value = yield* get(v.built.roles, role, "role")
		const desc = roleDescOf(value)
		if (desc === undefined) {
			return yield* missing(`role value ${role}`)
		}
		return yield* Effect.orDie(fromEngine(ownRole(desc)))
	})

/**
 * The schema-qualified, quoted name of a function, as the installation's naming gives it: the one the installation
 * defines, or, for a filter or a probe it holds no function of (a query entry that needs no filter), a function no call
 * finds.
 */
const functionOf = (v: Version, fn: WorldFunction): Effect.Effect<string> =>
	Effect.gen(function* () {
		switch (fn.kind) {
			case "filter": {
				const owned = yield* ownedOf(v, fn.role)
				const world = worldNames(
					succeeded(namedRole(owned, v.installation.names.levels), `role ${fn.role} named`),
					v.installation.names
				)
				const name = world.filterFunction(fn.entry, [])
				return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
			}
			case "key-probe": {
				const role = roleOf(v.spec, fn.role)
				if (role === undefined) {
					return yield* missing(`role ${fn.role}`)
				}
				const probe = probeOf(v.spec.base, role, fn)
				const owned = yield* ownedOf(v, fn.role)
				const world = worldNames(
					succeeded(namedRole(owned, v.installation.names.levels), `role ${fn.role} named`),
					v.installation.names
				)
				/**
				 * A probe the installation defines, by its key (the model's notion, writes.ts probeOf); one it defines none
				 * of (an entry it writes through no query entry, a key its target lacks) as a probe over no key, which no
				 * installation defines, so no call finds it.
				 */
				const name =
					probe === undefined
						? world.keyProbe(fn.entry, [], [])
						: world.keyProbe(fn.entry, probe.key, [])
				return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
			}
		}
	})

/** The wild value of a kind, handed on only at the call it is drawn for. */
const wildValue = (kind: WildKind): unknown => passed({ kind: "wild", wild: wildOf(kind) })

/**
 * Whether openServed, handed a wild value, returned an Effect. It is read with its declared answer: the context of a Db
 * of the role it was handed, its failure an OpenError (which the caller still checks on the value), its requirement the
 * phantom DbLayer service, which no runtime value holds (adapter/types/layer.ts).
 */
const isOpening = (
	value: unknown
): value is Effect.Effect<
	{ readonly ctx: ServedDbContext },
	OpenError,
	DbLayerService<BuiltRole>
> => Effect.isEffect(value)

/** Realizes an installation under the ambient session `ambient` (test/support/ambient.ts): see RealWorld. */
export const realize = (
	installSpec: InstallSpec,
	ambient: AmbientSession
): Effect.Effect<RealWorld, RealizeRefused | SqlError, Scope.Scope | Substrate> =>
	realizeWith(installSpec, ambient, Option.none())

/**
 * Realizes an installation under the ambient session `ambient` whose every login's pool, the stranger's among them,
 * holds `poolSize` connections at most: one for a program that runs one action at a time (drive/suite.ts
 * programTests), whose open leases one (openedDb), and two for a schedule that races two sessions' calls.
 */
export const realizeRace = (
	installSpec: InstallSpec,
	ambient: AmbientSession,
	poolSize: number
): Effect.Effect<RacingWorld, RealizeRefused | SqlError, Scope.Scope | Substrate> =>
	realizeWith(installSpec, ambient, Option.some(poolSize))

/**
 * The world of a planned installation already installed in the substrate's database, as a case over a clone of a
 * template's world has it (template.ts worldTemplate): every login's and decoder login's password the one the template
 * derived for it (templates.ts templatePassword), every login's pool, the stranger's among them, `poolSize`
 * connections at most, or the cluster pool's.
 */
export const realizeInstalled = (
	plan: WorldPlan,
	installed: Installed,
	poolSize: Option.Option<number>
): Effect.Effect<RacingWorld, RealizeRefused | SqlError, Scope.Scope | Substrate> =>
	worldOver(
		plan,
		installed,
		(role) => Effect.succeed(Redacted.make(templatePassword(installed.cluster, role))),
		poolSize
	)
