import { Array as Arr, Effect, type Layer, type Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	type AnyClosed,
	type AnyRelation,
	type Schema,
	type Statement,
	type StatementsWithin,
	schema
} from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	type Installed,
	installMigrated as install,
	loadMigrated as load
} from "#test/support/install-migrate.ts"
import { quietPolls } from "#test/support/kernel/sanitize.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import type { RealInstallOptions } from "#test/support/oracle/install/real.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { randomHex } from "#test/support/substrate/names.ts"
import { connect } from "#test/support/substrate/session.ts"
import { Substrate, type SubstrateShape } from "#test/support/substrate/substrate.ts"
import { type FullWorld, fullWorld, loginLayer } from "#test/support/worlds.ts"

/**
 * Shared helpers for the read suites (test/pg/reads).
 *
 * A schema opens under the PostgreSQL schema its declared name converts to, and its login and world roles are
 * `<schema>__<name>`. Roles are cluster-wide, so every test installs its fixture under a unique schema name, with its
 * full world (test/support/worlds.ts): the fixture is installed by the fresh-install compiler under the name the
 * substrate allocated (test/support/install-migrate.ts), and then rebuilt with that name as its declared name from the very same
 * relations and statements, typed by them under a name known only at run time, its full world over the rebuilt schema.
 * Allocated names are fixed points of the identifier conversion (test/support/substrate/names.ts), so the rebuilt
 * schema compiles to the installed objects and its world logs in as the installed roles. Facts load as the owner
 * through the oracle's typed-literal loader.
 *
 * A database of the test's own, `gz_t_<pid>_<label>_<8 hex>`, created from template0 with `options`, holding no grizzle
 * object and no extension. The installed roles are cluster-wide, and PUBLIC may connect to a new database, so they log
 * in to it. When the scope closes it is released, never dropped: a database is dropped only by the sweep
 * (test/support/substrate/shared.ts) once no file of this process runs, since DROP DATABASE holds its transaction id
 * through the checkpoint it forces and so summarizes every other file's SERIALIZABLE transactions (test/support/pg.ts).
 *
 * The release waits until no client session is left in the database: a pool closed at its scope's end sends each
 * session's Terminate, and the backend exits a moment later, so the wait reads PostgreSQL's own fact, the database's
 * client backends in pg_stat_activity, polling back to back until none is left, and judges nothing by time
 * (kernel/sanitize.ts): a session the test never closed keeps its backend, the wait does not end, and the test's
 * timeout reports it as hung, the backends it waits for printed on stderr after `quietPolls` polls.
 * Then, connected to the database, it revokes everything the test's roles hold or own there (DROP OWNED BY every role
 * that depends on an object of it, as the owner, who holds each role's privileges as the substrate's dropRole grants
 * them), so their DROP ROLE succeeds while the database waits for the sweep.
 */
export const bareDatabase = (
	label: string,
	options: string
): Effect.Effect<string, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const name = `gz_t_${process.pid}_${label}_${randomHex(4)}`
		yield* s.admin.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE template0 ${options}`, [])
		yield* Effect.addFinalizer(() => Effect.orDie(releaseWhenIdle(s, name)))
		return name
	})

const releaseWhenIdle = (
	substrate: SubstrateShape,
	database: string
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		for (let polls = 1; ; polls++) {
			const left = yield* substrate.admin.queryValues(
				"SELECT pid::int4, usename::text, coalesce(state, 'unknown')::text, left(coalesce(query, ''), 200) FROM pg_catalog.pg_stat_activity WHERE datname = $1::name AND backend_type = 'client backend' ORDER BY pid",
				[database]
			)
			if (left.length === 0) {
				break
			}
			if (polls === quietPolls) {
				yield* Effect.sync(() =>
					process.stderr.write(
						`${Arr.join(
							[
								`waiting for database ${database}'s sessions to end; a session the test never closed keeps its release, and its test, from finishing:`,
								...Arr.map(
									left,
									([pid, role, state, text]) =>
										`  backend ${String(pid)} of ${String(role)}: ${String(state)}, last query ${JSON.stringify(String(text))}`
								)
							],
							"\n"
						)}\n`
					)
				)
			}
			yield* Effect.yieldNow
		}
		yield* Effect.scoped(
			Effect.gen(function* () {
				const inside = yield* connect(substrate.cluster, {
					database,
					credentials: substrate.owner,
					label: "release"
				})
				const roles = yield* inside.queryValues(
					"SELECT DISTINCT r.rolname::text FROM pg_catalog.pg_shdepend AS d JOIN pg_catalog.pg_roles AS r ON r.oid = d.refobjid WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()) AND r.rolname <> CURRENT_USER AND NOT starts_with(r.rolname, 'pg_') ORDER BY 1",
					[]
				)
				const names = Arr.map(roles, ([role]) => quoteIdent(String(role)))
				if (names.length === 0) {
					return
				}
				for (const role of names) {
					yield* inside.query(`GRANT ${role} TO CURRENT_USER WITH INHERIT TRUE`, [])
				}
				yield* inside.query(`DROP OWNED BY ${Arr.join(names, ", ")}`, [])
			})
		)
	})

export interface Opened<S> {
	readonly installed: Installed
	/**
	 * The fixture rebuilt under the installed schema name: its relations and statements, under a name known only at
	 * run time, which places the installation. A query or ChangeSet built over the fixture runs against it too: a level
	 * is its content, not its name (program/schema.ts levelSchema).
	 */
	readonly schema: S
	/**
	 * The full world's role over the rebuilt schema, which every program over the fixture runs on, its login, through
	 * which a Db opens it (`server.roles.app`), and the DbLayer of the login in the substrate's database, given the
	 * installation's snapshot (loginLayerIn builds one in another).
	 */
	readonly app: FullWorld["app"]
	readonly server: FullWorld["server"]
	readonly layer: Layer.Layer<DbLayerOf<FullWorld["server"]>, OpenError>
}

/**
 * What an installation of a read fixture states: the label of its allocated schema name and the installer extensions
 * it gives. Its one world is its full world.
 */
export type FixtureInstall = Pick<RealInstallOptions, "label" | "extensions">

/**
 * Installs `fixture` under a fresh schema, loads `facts`, and rebuilds the fixture under the installed name. The
 * fixture is a schema value whose statements name only its relations, as schema(...) checked when it was built.
 */
export const installed = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>
>(
	fixture: Schema<N, R, St> & { readonly statements: StatementsWithin<St, R> },
	facts: FactSet,
	options: FixtureInstall
): Effect.Effect<
	Opened<Schema<string, R, readonly [...St]>>,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const done = yield* install(fixture, { ...options, logins: [fullWorld(fixture).server] })
		yield* load(done, facts)
		const rebuilt = schema<string, R, St>(done.schema, fixture.relations, fixture.statements)
		const world = fullWorld(rebuilt)
		return {
			installed: done,
			schema: rebuilt,
			app: world.app,
			server: world.server,
			layer: loginLayer(done, world.server)
		}
	})
