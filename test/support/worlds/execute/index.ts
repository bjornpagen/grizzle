import { passed, type WildKind, wildOf } from "@grizzle/testing/lsw"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	Ref,
	Result,
	Scope
} from "effect"
import { registerSnapshot } from "#adapter/admission/snapshots.ts"
import { fromEngine } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import { identity } from "#compiler/core/identity.ts"
import { codebookOf, noWorkload, writeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { roleReadNames, worldNames } from "#compiler/physical/ddl/names.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { login as loginBuilder } from "#compiler/program/workload/login.ts"
import { type OwnedRole, ownRole } from "#compiler/schema/own.ts"
import { roleDescOf, role as roleBuilder } from "#compiler/schema/world.ts"
import { printObjectName, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import type { LoginRole } from "#compiler/types/schema/world.ts"
import type { AmbientSession } from "#test/support/ambient.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import {
	type InstalledAt,
	installationNamesOf,
	installationOf,
	parsedSchemaName
} from "#test/support/kernel/naming.ts"
import { fromEmpty, generate, noDeclarations } from "#test/support/migrate/kit.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { clusterConnection, clusterPool, type SqlError } from "#test/support/pg.ts"
import { contextOf } from "#test/support/runtime-db.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import type { PsqlWriter } from "#test/support/substrate/psql.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { rolePsql, Substrate } from "#test/support/substrate/substrate.ts"
import {
	type Built,
	type BuiltLogin,
	type BuiltRole,
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
import { openRefused, witnessTexts } from "#test/support/worlds/execute/observe.ts"
import { isNativePool, leasedBackend, probePool } from "#test/support/worlds/execute/pool.ts"
import { RealizeRefused, Thrown } from "#test/support/worlds/execute/refused.ts"
import {
	applySession,
	applyValue,
	type DbSession,
	derivedFields,
	entryFields,
	executeValue,
	readSession,
	refreshValue,
	relationValue,
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
import { identityFloor } from "#test/support/worlds/model/draws.ts"
import { fieldDomain } from "#test/support/worlds/model/host.ts"
import { startStatements } from "#test/support/worlds/model/session/direct.ts"
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
	 * Closes every session (rolling back open direct transactions), sets each identity where its range starts
	 * (model/draws.ts identityFloor), replaces every base fact with `reality` as the owner, refreshes every derived
	 * relation, and restarts session ids at 0.
	 */
	readonly reset: (reality: HostState) => Effect.Effect<void, SqlError>
	/**
	 * Every base table's and derived relation's stored facts, in one snapshot, read past row security (substrate.ts
	 * superuserRead): a catalog change that forces a table's row security on its owner hides none of them.
	 */
	readonly stored: Effect.Effect<{
		readonly reality: HostState
		readonly derived: Readonly<Record<string, ReadonlyArray<HostFact>>>
	}>
	readonly perform: (action: Action, hidden: ReadonlySet<string>) => Effect.Effect<Observation>
	/** An action performed as `perform` does, with the texts of the error behind its observation, for a report. */
	readonly performed: (action: Action, hidden: ReadonlySet<string>) => Effect.Effect<Performed>
	readonly probe: (session: number) => Effect.Effect<Probe>
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
	 * The backend serving an open session: a direct writer's, read once when its BEGIN opened it, or the connection its
	 * login's pool most recently leased.
	 */
	readonly backend: (session: number) => Effect.Effect<number>
}

type Session =
	| DbSession
	| DirectSession
	| { readonly kind: "closed"; readonly was: "db" | "direct" }

/** One installed version: its spec, its values under the installed schema name, its names, plan and snapshot. */
interface Version {
	readonly spec: InstallSpec
	readonly built: Built
	readonly names: InstalledNames
	readonly plan: RealInstallPlan
	readonly installation: Installation
	readonly snapshot: DeploySnapshot
	readonly credentials: Readonly<Record<string, Credentials>>
	readonly layers: Readonly<Record<string, Context.Context<DbLayerOf<BuiltLogin>>>>
}

/** A version a migration drafted: its spec, the plan it installs and the snapshot it reaches. */
interface Next {
	readonly spec: InstallSpec
	readonly plan: RealInstallPlan
	readonly snapshot: DeploySnapshot
}

/** A folder a run left pending, and the version it installs once it applies. */
interface PendingFolder {
	readonly folder: FolderSource
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
	readonly applied: ReadonlyArray<FolderSource>
	readonly pending: ReadonlyArray<PendingFolder>
}

/** Every folder of a directory, in order. */
const foldersOf = (directory: Directory): ReadonlyArray<FolderSource> => [
	...directory.applied,
	...Arr.map(directory.pending, (p) => p.folder)
]

/**
 * What a login layer serves: a version's sessions, whose pool the executor probes; or one open, its layer built with
 * another snapshot than the version's (SnapshotRef: an older version's, another schema's, an edited one, or the drafted
 * one of pending folders, main's ruling on "drafted"), which opens none and ends with the open.
 */
type LayerUse = "version" | "probe"

/** The login an unheld role is reached through, which no layer serves: a JavaScript caller's role of no installed login. */
const unheldLogin = "executorUnheld"

/** A role the current installation holds: its spec and the login it is in. */
interface Held {
	readonly role: InstallSpec["roles"][number]
	readonly login: string
}

/**
 * What an open hands Db.open and runs under: the role value it names, that role reached through its login, the role the
 * installation holds it as (none for a role of no installed login), and its layers, built in the open's scope.
 */
interface OpenTarget {
	readonly value: BuiltRole
	readonly reached: LoginRole<BuiltRole, unknown>
	readonly held: Option.Option<Held>
	readonly layers: Effect.Effect<Context.Context<DbLayerOf<BuiltLogin>>, OpenError, Scope.Scope>
}

const heldOf = (spec: InstallSpec, role: string, login: string): Option.Option<Held> =>
	Option.map(Option.fromUndefinedOr(roleOf(spec, role)), (found) => ({ role: found, login }))

const missing = (what: string): Effect.Effect<never> =>
	Effect.die(new Error(`the executor has no ${what}`))

const get = <A>(record: Readonly<Record<string, A>>, key: string, what: string): Effect.Effect<A> =>
	Option.match(Rec.get(record, key), {
		onNone: () => missing(`${what} ${key}`),
		onSome: Effect.succeed
	})

const realizeWith = (
	installSpec: InstallSpec,
	ambient: AmbientSession,
	poolSize: Option.Option<1 | 2>
) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const declared = yield* buildInstall(installSpec, installSpec.base.name)
		const installed = yield* install(declared.base, {
			ambient,
			logins: Rec.values(declared.logins),
			extensions: [],
			label: "worlds"
		}).pipe(
			Effect.catchTags({
				CompileError: (refusal) =>
					Effect.fail(new RealizeRefused({ what: "the installation", refusal })),
				TransactionRolledBack: (rolledBack) => Effect.die(rolledBack)
			})
		)
		/** The token the open in flight hands verify, none between opens (token.ts Handed). */
		const verifying: { handed: Option.Option<Handed> } = { handed: Option.none() }
		/** The verify calls of every login layer since the realization began. */
		const verified = { calls: 0 }
		const acquired = new Map<string, number>()
		const scope = yield* Effect.scope

		/** The verify of every login layer that takes one: it reads the token, and counts its calls. */
		const verify = worldVerify(
			() => verifying.handed,
			() => {
				verified.calls++
			}
		)

		/**
		 * A login's DbLayer, given `snapshot`: attachPool records, for a version's layer, the backend of each connection its
		 * pool's leases take, and verify is given exactly when a role of the login reads a context, as README "Permissions"
		 * requires it, so a login whose roles read none turns no token into claims.
		 */
		const layerOf = (
			spec: InstallSpec,
			built: Built,
			login: string,
			credentials: Credentials,
			snapshot: { readonly fingerprint: string },
			use: LayerUse
		): Effect.Effect<Layer.Layer<DbLayerOf<BuiltLogin>, OpenError>> =>
			Effect.map(get(built.logins, login, "login"), (value) =>
				DbLayer.make({
					...clusterConnection(substrate.cluster, substrate.database, credentials.password),
					pool: Option.match(poolSize, {
						onNone: () => clusterPool,
						onSome: (size) => ({ ...clusterPool, max: size })
					}),
					login: value,
					snapshot,
					...(loginVerifies(spec, login) ? { verify } : {}),
					attachPool: (pool) => {
						if (!isNativePool(pool)) {
							throw new Error("a login's pool is not node-postgres's Pool")
						}
						if (use === "version") {
							pool.on("acquire", (client) => {
								const pid = leasedBackend(client)
								if (pid !== undefined) {
									acquired.set(login, pid)
								}
							})
						}
					}
				})
			)

		const versionOf = (
			spec: InstallSpec,
			plan: RealInstallPlan,
			installation: Installation,
			snapshot: DeploySnapshot,
			credentials: Readonly<Record<string, Credentials>>
		): Effect.Effect<Version, RealizeRefused> =>
			Effect.gen(function* () {
				const built = yield* buildInstall(spec, installed.declared)
				const at: InstalledAt = {
					kind: "installed",
					installation: identity.schema(parsedSchemaName(installed.declared))
				}
				const names = yield* namesOfBuiltAt(spec, built, at, codebookOf(snapshot))
				yield* Effect.orDie(Effect.fromResult(registerSnapshot(built.base, snapshot)))
				/** Each login's layer, given the version's snapshot, built in the realization's scope. */
				const layers: Record<string, Context.Context<DbLayerOf<BuiltLogin>>> = {}
				for (const l of spec.logins) {
					const loginCredentials = yield* get(credentials, l.name, "credentials of")
					const layer = yield* layerOf(spec, built, l.name, loginCredentials, snapshot, "version")
					layers[l.name] = yield* Effect.orDie(Scope.provide(Layer.build(layer), scope))
				}
				return { spec, built, names, plan, installation, snapshot, credentials, layers }
			})

		const loginEntries = yield* Effect.forEach(installSpec.logins, (l) =>
			Effect.map(
				get(declared.logins, l.name, "login"),
				(value) => [l.name, installed.as(value)] as const
			)
		)
		const firstCredentials = Rec.fromEntries(loginEntries)
		const first = yield* versionOf(
			installSpec,
			installed.plan,
			installed.installation,
			installed.snapshot,
			firstCredentials
		)
		const crossChecked = installed.plan.logins
		for (const l of installSpec.logins) {
			const planned = yield* get(crossChecked, l.name, "planned login")
			if (planned.role !== first.names.logins[l.name]) {
				return yield* Effect.die(
					new Error(
						`the login ${l.name} is installed as ${planned.role}, not ${String(first.names.logins[l.name])}`
					)
				)
			}
		}
		/**
		 * The release before the first: the base alone, without its worlds and logins, drafted for the installed schema
		 * as its snapshot.json, which no ledger target of the realization is.
		 */
		const earlierDraft = generate({
			installation: installationOf(declared.base, {
				kind: "installed",
				installation: identity.schema(parsedSchemaName(installed.declared))
			}),
			name: "earlier",
			timestamp: "20261012000000",
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations
		})
		const earlier = earlierDraft.ok
			? snapshotJson(earlierDraft.value.snapshotText)
			: yield* Effect.die(earlierDraft.error)
		/**
		 * The current version, and the snapshot.json an older release of the installation had, which the ledger has
		 * moved past: the latest version's whose fingerprint is not the current one's, or, before any, the release
		 * before the first.
		 */
		const state: {
			current: Version
			stale: { readonly fingerprint: string }
			directory: Directory
		} = {
			current: first,
			stale: earlier,
			directory: { applied: installed.folders, pending: [] }
		}
		/** The layer of a login no installed role is in: what serves no role, where no other login is left. */
		const [firstRelation] = installSpec.base.relations
		const strangerWhole = yield* get(first.built.relations, firstRelation.name, "relation")
		const strangerRole = yield* Effect.sync(() =>
			roleBuilder(first.built.base, "executorStranger", { [firstRelation.name]: strangerWhole })
		)
		const strangerLogin: BuiltLogin = yield* Effect.sync(() =>
			loginBuilder(first.built.base, "executorStrangerLogin", [strangerRole])
		)
		const stranger = yield* Effect.orDie(
			Scope.provide(
				Layer.build(
					DbLayer.make({
						...clusterConnection(substrate.cluster, substrate.database, Redacted.make("")),
						pool: clusterPool,
						login: strangerLogin,
						snapshot: first.snapshot
					})
				),
				scope
			)
		)
		const sessions = yield* Ref.make<ReadonlyArray<Session>>([])
		const inFlight = yield* Ref.make<ReadonlyMap<number, Fiber.Fiber<Seen>>>(new Map())

		const foreignInstallation = installationOf(declared.base, {
			kind: "installed",
			installation: identity.schema(parsedSchemaName(`${installed.declared}_foreign`))
		})
		const foreignDraft = generate({
			installation: foreignInstallation,
			name: "foreign",
			timestamp: "20261013000000",
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations
		})
		const foreign = foreignDraft.ok
			? snapshotJson(foreignDraft.value.snapshotText)
			: yield* Effect.die(foreignDraft.error)

		/**
		 * The snapshot the opening role's login layer is given (DbConfig): the current version's and an older one's as the
		 * test installer registered them; another schema's snapshot.json (foreign) and the current one's with its schema
		 * name edited by hand (tampered) as the JSON value an import of the file yields, which is how an application holds
		 * one; and, as that JSON value too, the directory's snapshot.json while folders are pending (drafted), the target
		 * no complete migration reached, which the new application version deployed early imports.
		 */
		const snapshotOf = (ref: SnapshotRef): Effect.Effect<{ readonly fingerprint: string }> => {
			switch (ref) {
				case "current":
					return Effect.succeed(state.current.snapshot)
				case "stale":
					return Effect.succeed(state.stale)
				case "tampered": {
					const s = state.current.snapshot
					const text = writeSnapshot(s)
					return text.ok
						? Effect.succeed({ ...snapshotJson(text.value), schemaName: `${s.schemaName}_edited` })
						: Effect.die(text.error)
				}
				case "foreign":
					return Effect.succeed(foreign)
				case "drafted": {
					const text = writeSnapshot(directorySnapshot())
					return text.ok ? Effect.succeed(snapshotJson(text.value)) : Effect.die(text.error)
				}
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
				([, layer]) => layer
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
		): Effect.Effect<LoginRole<BuiltRole, unknown>> =>
			Effect.flatMap(
				Effect.sync(() => loginBuilder(base, unheldLogin, [value])),
				(unserved) => get(unserved.roles, value.name, "role of the unheld login")
			)

		/**
		 * A reference that is no installed role, as Db.open is handed it: a role value of its name over the current base
		 * that no installed login holds, reached through a login no layer serves and opened under every login's layer. A
		 * dropped role's is the value an application kept of a role a migration removed, a nonexistent one's a name no
		 * installation gave, and the owner's the owner's own PostgreSQL name; none is a role of an installed login,
		 * whatever its name.
		 */
		const unheld = (current: Version, name: string) =>
			Effect.gen(function* () {
				const [anyRelation] = current.spec.base.relations
				const whole = yield* get(current.built.relations, anyRelation.name, "relation")
				const value: BuiltRole = yield* Effect.sync(() =>
					roleBuilder(current.built.base, name, { [anyRelation.name]: whole })
				)
				return {
					value,
					reached: yield* reachedUnheld(current.built.base, value),
					held: Option.none<Held>(),
					context: allLayers(Option.none())
				}
			})

		/**
		 * The role value an open names, the login role Db.open is handed (the role reached through its login), and the
		 * version's layers it is opened under.
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
						return {
							value,
							reached: yield* get(holder.roles, ref.role, "role of login"),
							held: heldOf(current.spec, ref.role, name),
							context:
								ref.kind === "own"
									? yield* get(current.layers, name, "layer of")
									: allLayers(Option.some(name))
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
		 * The role value, the login role and the layers an open whose login layer is given the drafted snapshot names, as
		 * main ruled: the new application version, deployed before its migration finished, holds the pending version's
		 * role values and its login's layer, given the drafted snapshot (the login's password unchanged), so Db.open meets
		 * the folder in progress at ledger. That layer's pool serves no session the executor probes. A drafted open of a
		 * role the pending version drops or moves to a login it adds is no deploy the executor models, so it dies naming
		 * it; with nothing pending, the drafted snapshot is the current one, and so are the role and its layer.
		 */
		const draftedTarget = (ref: RoleRef): Effect.Effect<OpenTarget> =>
			Effect.gen(function* () {
				const pending = Arr.last(state.directory.pending)
				if (Option.isNone(pending) || (ref.kind !== "own" && ref.kind !== "other-login")) {
					const target = yield* roleFor(ref)
					return { ...target, layers: Effect.succeed(target.context) }
				}
				const spec = pending.value.next.spec
				const built = yield* Effect.orDie(buildInstall(spec, installed.declared))
				const value = yield* get(built.roles, ref.role, "drafted role")
				const login = yield* Option.match(
					Arr.findFirst(spec.logins, (l) => l.roles.includes(ref.role)),
					{
						onNone: () => missing(`login of the drafted role ${ref.role}`),
						onSome: (l) => Effect.succeed(l.name)
					}
				)
				const holder = yield* get(built.logins, login, "drafted login")
				const credentials = yield* get(
					state.current.credentials,
					login,
					"credentials of the drafted login"
				)
				const drafted = yield* snapshotOf("drafted")
				return {
					value,
					reached: yield* get(holder.roles, ref.role, "drafted role of login"),
					held: Option.none<Held>(),
					layers:
						ref.kind === "own"
							? yield* Effect.map(
									layerOf(spec, built, login, credentials, drafted, "probe"),
									Layer.build
								)
							: Effect.succeed(allLayers(Option.some(login)))
				}
			})

		/**
		 * What an open hands Db.open and the layers it runs under, its login layer given the snapshot it names: the
		 * version's layers for the current snapshot; for another, a layer of the role's login built for the open alone,
		 * whose refusal (a snapshot that does not parse, or is not of the login's base) is the open's. A reference that is
		 * no role of its own login meets the version's layers alone, whatever the snapshot, and is refused at role.
		 */
		const openTarget = (ref: RoleRef, snapshot: SnapshotRef): Effect.Effect<OpenTarget> =>
			Effect.gen(function* () {
				if (snapshot === "drafted") {
					return yield* draftedTarget(ref)
				}
				const target = yield* roleFor(ref)
				if (snapshot === "current" || ref.kind !== "own" || Option.isNone(target.held)) {
					return { ...target, layers: Effect.succeed(target.context) }
				}
				const current = state.current
				const login = target.held.value.login
				const credentials = yield* get(current.credentials, login, "credentials of")
				const probeSnapshot = yield* snapshotOf(snapshot)
				const layer = yield* layerOf(
					current.spec,
					current.built,
					login,
					credentials,
					probeSnapshot,
					"probe"
				)
				return { ...target, layers: Layer.build(layer) }
			})

		const opened = (
			value: BuiltRole,
			held: Option.Option<Held>,
			exit: Exit.Exit<Db<BuiltRole, unknown>, OpenError>,
			verifyCalls: 0 | 1
		): Effect.Effect<Seen> =>
			Exit.match(exit, {
				onFailure: (cause) =>
					Result.match(Cause.findError(cause), {
						onFailure: (rest) => Effect.failCause(rest),
						onSuccess: (error) =>
							Effect.map(openRefused(error, verifyCalls), (observation) =>
								refusedWith(observation, error)
							)
					}),
				onSuccess: (db) => openedDb(value, held, db, verifyCalls)
			})

		/** A Db opened: a session of its role in its login, minted; one for a role the installation does not hold is a defect. */
		const openedDb = (
			value: BuiltRole,
			held: Option.Option<Held>,
			db: Db<BuiltRole, unknown>,
			verifyCalls: 0 | 1
		): Effect.Effect<Seen> =>
			Option.match(held, {
				onNone: () =>
					Effect.die(new Error("a Db opened for a role the installation does not hold")),
				onSome: ({ role, login }) =>
					Effect.gen(function* () {
						const current = state.current
						const session = yield* mint({
							kind: "db",
							login,
							role,
							base: current.spec.base,
							described: current.installation.described,
							value,
							db
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
				/** A layer built for the open alone ends with it: its pool serves no session the executor probes. */
				const exit = yield* Effect.exit(
					Effect.scoped(
						Effect.flatMap(target.layers, (context) =>
							handing(handed, Effect.provideContext(Db.open(target.reached, options), context))
						)
					)
				)
				const calls = yield* verifyCallsSince(before)
				return yield* opened(target.value, target.held, exit, calls)
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
						const read = roleReadNames(v.installation.names, ownedRole)
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
				function: (fn) => functionOf(v, fn)
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

		const directBegin = (
			action: Extract<Action, { readonly kind: "direct-begin" }>
		): Effect.Effect<Seen> =>
			Effect.gen(function* () {
				const credentials = yield* get(state.current.credentials, action.login, "credentials of")
				const sessionScope = yield* Scope.fork(scope)
				const writer = yield* Effect.orDie(
					Scope.provide(
						substrate.psql({ ...rolePsql(credentials), label: `direct ${action.login}` }),
						sessionScope
					)
				)
				const pid = yield* Effect.orDie(writer.pid)
				yield* Effect.orDie(writer.run(beginSql(action.isolation)))
				const session: DirectSession = {
					kind: "direct",
					login: action.login,
					writer,
					pid,
					scope: sessionScope,
					prepared: new Map()
				}
				const id = yield* mint(session)
				return yield* started(id, session, startStatements(action.start))
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
						return yield* openWild(
							target.reached,
							Option.some(value),
							target.context,
							(db, verifyCalls) => openedDb(target.value, target.held, db, verifyCalls)
						)
					}
					case "session":
						return yield* call(at.session, (session) => {
							switch (at.call) {
								case "read":
									return executeValue(session, value)
								case "apply":
									return applyValue(session, value)
								case "refresh":
									return refreshValue(session, value)
							}
						})
				}
			})

		/**
		 * Db.open handed a value its types refuse, as a JavaScript caller hands it: a refusal is observed at its stage, and a
		 * Db it opens (a wild token it reads as no token, or as a payload) is `onOpened`'s.
		 */
		const openWild = (
			role: unknown,
			token: Option.Option<unknown>,
			context: Context.Context<DbLayerOf<BuiltLogin>>,
			onOpened: (db: Db<BuiltRole, unknown>, verifyCalls: 0 | 1) => Effect.Effect<Seen>
		): Effect.Effect<Seen> =>
			Effect.gen(function* () {
				const options = Option.match(token, {
					onNone: () => ({}),
					onSome: (t) => ({ token: t })
				})
				const opening: unknown = Reflect.apply(Db.open.bind(Db), undefined, [role, options])
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
					onSuccess: (db) => onOpened(db, verifyCalls)
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
				case "refresh":
					return call(action.session, (s) => refreshValue(s, relationValue(s, action.relation)))
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
				const version = yield* Effect.orDie(
					versionOf(next.spec, next.plan, next.plan.installation, next.snapshot, credentials)
				)
				if (version.snapshot.fingerprint !== state.current.snapshot.fingerprint) {
					state.stale = state.current.snapshot
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
			folders: ReadonlyArray<FolderSource>,
			end: RunEnd
		): Effect.Effect<RunOutcome> =>
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
				return outcome
			})

		/**
		 * The next version's migration, drafted from the directory's snapshot.json, landed and ended as `how` says and run
		 * with every folder of the directory. An installation grizzle's builders refuse, or one generate refuses for
		 * declaring a roster out of its codes' order (D1), is compile-refused before anything is drafted.
		 */
		const migrate = (action: Extract<Action, { readonly kind: "migrate" }>): Effect.Effect<Seen> =>
			Effect.gen(function* () {
				const built = yield* Effect.result(buildInstall(action.to, action.to.base.name))
				if (Result.isFailure(built)) {
					return refusedWith({ kind: "compile-refused" }, built.failure.refusal)
				}
				const next_ = yield* Effect.result(
					draftNext(
						built.success.base,
						Rec.values(built.success.logins),
						installed.declared,
						substrate.owner.role,
						{ snapshot: directorySnapshot(), folders: foldersOf(state.directory) }
					)
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
				return yield* probePool(contextOf(session.db).pool)
			})

		const storedRelations = (v: Version) => [
			...Arr.map(v.spec.base.relations, (r) => ({
				name: r.name,
				fields: Arr.map(r.fields, (f) => ({ field: f.name, domain: f.domain }))
			})),
			...Arr.map(v.spec.base.derived, (d) => ({
				name: d.name,
				fields: derivedFields(v.spec.base, d)
			}))
		]

		const readAll = substrate.superuserRead((rows) =>
			Effect.gen(function* () {
				const v = state.current
				const read = (
					name: string,
					fields: ReadonlyArray<{ readonly field: string; readonly domain: FieldDomain }>
				) =>
					Effect.gen(function* () {
						const tableName = yield* get(v.names.tables, name, "table")
						const table = `${quoteIdent(v.names.schema)}.${quoteIdent(tableName)}`
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
												valueOfText(f.domain, cell, `${name}.${f.field}`),
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
				const derived: Record<string, ReadonlyArray<HostFact>> = {}
				for (const d of storedRelations(v).slice(v.spec.base.relations.length)) {
					derived[d.name] = yield* read(d.name, d.fields)
				}
				return { reality, derived }
			})
		)

		const reset = (reality: HostState): Effect.Effect<void, SqlError> =>
			Effect.gen(function* () {
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
				/**
				 * Each serial field's identity set past the value its range starts at (draws.ts identityFloor), before the facts
				 * load and their advances, which never move it back, so every case draws from the same values.
				 */
				const ranges = yield* Effect.forEach(
					Arr.flatMap(v.spec.base.relations, (r) =>
						Arr.flatMap(r.fields, (f) =>
							f.domain.kind === "serial" ? [{ relation: r.name, field: f.name }] : []
						)
					),
					({ relation, field }) =>
						Effect.gen(function* () {
							const t = yield* get(v.plan.tables, relation, "the installed table of")
							const column = Option.getOrUndefined(
								Arr.findFirst(t.columns, (c) => c.field === field)
							)
							if (column?.sequence.kind !== "identity") {
								return yield* Effect.die(new Error(`${relation}.${field} has no identity sequence`))
							}
							return `SELECT pg_catalog.setval(${quoteString(printObjectName(column.sequence.name))}::regclass, ${String(identityFloor(v.spec.base, relation, field))})`
						})
				)
				yield* Effect.catchTag(
					replaceRows(
						substrate.admin,
						installationGroup(installationNamesOf(v.installation)),
						Arr.map([...ranges, ...statements], (sql) => ({ sql, params: [] }))
					),
					"TransactionRolledBack",
					(e) => Effect.die(e)
				)
				for (const d of v.spec.base.derived) {
					const view = yield* get(v.names.tables, d.name, "derived view")
					yield* substrate.admin.query(
						`REFRESH MATERIALIZED VIEW ${quoteIdent(v.names.schema)}.${quoteIdent(view)}`,
						[]
					)
				}
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
					if (session.kind === "direct") {
						return session.pid
					}
					const pid = acquired.get(session.login)
					return pid ?? (yield* missing(`leased connection of ${session.login}`))
				})
		}
		return world
	})

/**
 * A run's observation: `whole` when its folders all applied, `drifted` of the mismatches when its drift check refused
 * the catalog (a migrate's refusal at stage drift, a drift run's report), another refusal's, or interrupted for a
 * killed deploy.
 */
const ranSeen = (
	outcome: RunOutcome,
	whole: Observation,
	drifted: (objects: ReadonlyArray<string>) => Observation
): Effect.Effect<Seen> => {
	switch (outcome.kind) {
		case "applied":
			return Effect.succeed(seen(whole))
		case "refused":
			return migrationRefused(outcome.error, drifted)
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
				const world = worldNames(owned, v.installation.names.installation)
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
				const world = worldNames(owned, v.installation.names.installation)
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
			case "advance": {
				const name = v.installation.names.advance(fn.relation, fn.field)
				return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
			}
		}
	})

/** The wild value of a kind, handed on only at the call it is drawn for. */
const wildValue = (kind: WildKind): unknown => passed({ kind: "wild", wild: wildOf(kind) })

/**
 * Whether Db.open, handed a wild value, returned an Effect. It is read with Db.open's declared answer: a Db of the role
 * it was handed, its failure an OpenError (which the caller still checks on the value), its requirement the phantom
 * DbLayer service, which no runtime value holds (adapter/types/layer.ts).
 */
const isOpening = (
	value: unknown
): value is Effect.Effect<Db<BuiltRole, unknown>, OpenError, DbLayerOf<BuiltLogin>> =>
	Effect.isEffect(value)

/** Realizes an installation under the ambient session `ambient` (test/support/ambient.ts): see RealWorld. */
export const realize = (
	installSpec: InstallSpec,
	ambient: AmbientSession
): Effect.Effect<RealWorld, RealizeRefused | SqlError, Scope.Scope | Substrate> =>
	realizeWith(installSpec, ambient, Option.none())

/**
 * Realizes an installation under the ambient session `ambient` whose every login's pool holds `poolSize` connections,
 * for schedules that race sessions.
 */
export const realizeRace = (
	installSpec: InstallSpec,
	ambient: AmbientSession,
	poolSize: 1 | 2
): Effect.Effect<RacingWorld, RealizeRefused | SqlError, Scope.Scope | Substrate> =>
	realizeWith(installSpec, ambient, Option.some(poolSize))
