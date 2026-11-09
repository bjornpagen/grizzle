import { Array as Arr, Effect, type Layer, Option, type Scope } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberOps } from "#adapter/db/handles.ts"
import type { CompiledOps } from "#adapter/db/ops.ts"
import { openServed } from "#adapter/db/served.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import { compileServed, type ServedRefusal } from "#adapter/public/compile.ts"
import { DbLayer, served } from "#adapter/public/layer.ts"
import { type LoadedMember, loadServed } from "#adapter/served/load.ts"
import type { DbLayerOf, ServedLogin, ServedRole } from "#adapter/types/layer.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { workload } from "#compiler/program/workload/value.ts"
import type { AnyLogin, AnyLoginRole, AnyRole } from "#compiler/public/schema.ts"
import type { AnyWorkload } from "#compiler/types/db/workload.ts"
import { defined } from "#test/support/assert.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { snapshotValue } from "#test/support/snapshot-json.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/**
 * Served programs for the tests: every program a test runs on PostgreSQL is a member of a login's served workload, compiled
 * in process by the one compile `grizzle generate` and `grizzle check` run, through the public compile entry an
 * application's tests use (adapter/public/compile.ts compileServed), its file's text parsed as an application's import of
 * the committed file yields it, and loaded by the layer's own loader (adapter/served/load.ts loadServed). Nothing here compiles a program at a call: a test that draws its programs at run
 * time compiles them into a served file of its own first, as a deployment's generate would.
 *
 * - servedFixture: a login serving its own workloads, typed by its login's type, through the public served(...) and
 *   DbLayer.make, as an application serves it: `Db.open(fixture.login.roles.<role>, { token })` and
 *   `db.workload.<member>`.
 * - withServedDb: one Db of a role per installation, opened through its login's served layer, whose `serve` compiles a
 *   test's drawn programs into members of the role's workload, each loaded and run on that Db's context: the same pool,
 *   prologue and claims, and the operations a workload handle runs (adapter/db/handles.ts memberOps).
 *
 * The served file of `login` with `workloads` in place of its own, compiled under the snapshot the installation reached
 * and parsed: what an application imports. A program the compile refuses is its ServedRefusal, naming the role and the
 * program.
 */
export const servedJson = (
	installed: Installed,
	login: AnyLogin,
	workloads: ReadonlyArray<AnyWorkload>
): Effect.Effect<unknown, ServedRefusal> =>
	Effect.suspend(() =>
		compileServed(login, snapshotValue(installed.snapshot, installed.installation), workloads)
	)

/** A login served as an application serves it: its served login, typed by L, and its DbLayer over the installation. */
export interface ServedFixture<L> {
	readonly login: ServedLogin<L>
	readonly layer: Layer.Layer<DbLayerOf<L>, OpenError>
}

/**
 * `login` serving its own workloads over `installed`: its served file (servedJson), served under L's type, and the
 * DbLayer of it on the cluster's connection with the login's password, the test pool and testVerify, in the database
 * the installation was migrated in.
 */
export const servedFixture = <L extends AnyLogin>(
	installed: Installed,
	login: L
): Effect.Effect<ServedFixture<L>, ServedRefusal> =>
	Effect.map(servedJson(installed, login, login.workload), (json) => {
		const file = served<L>(json, login.name)
		return {
			login: file,
			layer: DbLayer.make({
				...clusterConnection(installed.cluster, installed.database, installed.as(login).password),
				pool: clusterPool,
				login: file,
				verify: testVerify
			})
		}
	})

/**
 * One Db of a role over an installation: its context, which every member it serves runs over; `load`, which compiles
 * `programs`, each a program workload(...) admits (a query, an ordered query, paged(...) of one, a ChangeSet, a
 * relation's key or refresh(...)), into members of the role's workload under their names, and gives each one loaded, by
 * name, for a test that runs it over a context or executor of its own (adapter/db/handles.ts memberOpsOn) or reads its
 * loaded program; and `serve`, which gives each one's operations over the context, by name: the operations its program
 * allows run, the others refuse before any SQL.
 */
export interface ServedDb {
	readonly ctx: ServedDbContext
	readonly load: (
		programs: Readonly<Record<string, unknown>>
	) => Effect.Effect<ReadonlyMap<string, LoadedMember>, ServedRefusal | OpenError>
	readonly serve: (
		programs: Readonly<Record<string, unknown>>
	) => Effect.Effect<ReadonlyMap<string, CompiledOps<unknown>>, ServedRefusal | OpenError>
}

/** The members of the role `role` of a loaded login, by its name in the login. */
const roleMembers = (
	members: ReadonlyArray<{ readonly name: string; readonly members: ReadonlyArray<LoadedMember> }>,
	role: string
): ReadonlyArray<LoadedMember> =>
	defined(
		Option.getOrUndefined(Arr.findFirst(members, (r) => r.name === role)),
		`role ${role} of the served login`
	).members

/** The token of `role`, reached through its login, of the login's served file. */
const servedRoleOf = (
	file: ServedLogin<AnyLogin>,
	role: AnyLoginRole
): ServedRole<AnyRole, unknown> =>
	defined(file.roles[role.role.name], `role ${role.role.name} of login ${file.name}'s served file`)

/**
 * Opens `role`, a role reached through its login, over `installed`, with a token whose payload is `payload`, through the
 * login's served layer, and runs `body` with the Db (ServedDb) inside the layer's scope. Each `serve` compiles its
 * programs into one served file of the login (servedJson), the role's workload holding exactly them, loads it, and runs
 * its members on the opened Db's context, so a case's programs share its Db's pool and claims.
 */
export const withServedDb = <A, E>(
	installed: Installed,
	role: AnyLoginRole,
	payload: Json,
	body: (db: ServedDb) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E | ServedRefusal | OpenError, Scope.Scope> =>
	Effect.gen(function* () {
		const login = role.login
		const fixture = yield* servedFixture(installed, login)
		return yield* Effect.gen(function* () {
			const { ctx } = yield* openServed(servedRoleOf(fixture.login, role), {
				token: tokenOf(payload)
			})
			const load: ServedDb["load"] = (programs) =>
				Effect.gen(function* () {
					const json = yield* servedJson(installed, login, [workload(role.role, programs)])
					const loaded = yield* Effect.fromResult(loadServed(json, login.name))
					return new Map(
						Arr.map(
							roleMembers(loaded.roles, role.role.name),
							(m): readonly [string, LoadedMember] => [m.name, m]
						)
					)
				})
			const serve: ServedDb["serve"] = (programs) =>
				Effect.map(
					load(programs),
					(loaded) =>
						new Map(
							Arr.map([...loaded], ([name, m]): readonly [string, CompiledOps<unknown>] => [
								name,
								memberOps(ctx, m)
							])
						)
				)
			return yield* body({ ctx, load, serve })
		}).pipe(withLayer(fixture.layer))
	})

/** The member under `name` of those `load` or `serve` gave: a name it did not give is a defect of the test. */
export const member = <M>(served: ReadonlyMap<string, M>, name: string): M =>
	defined(served.get(name), `the served member ${name}`)
