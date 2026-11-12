import { Array as Arr, Effect, Formatter, type Scope } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	type AnyClosed,
	type AnyRelation,
	type Declared,
	type Schema,
	type Statement,
	type StatementsByName,
	type StatementsReadBack,
	type StatementsWithin
} from "#compiler/public/schema.ts"
import { schema as builtSchema } from "#compiler/schema/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import {
	type Installed,
	installGenerated,
	loadMigrated as load
} from "#test/support/install-migrate.ts"
import { quietPolls } from "#test/support/kernel/sanitize.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type ServedFixture, servedFixtureOf } from "#test/support/served-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { randomHex } from "#test/support/substrate/names.ts"
import { connect } from "#test/support/substrate/session.ts"
import { Substrate, type SubstrateShape } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

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
										`  backend ${String(pid)} of ${String(role)}: ${String(state)}, last query ${Formatter.format(String(text))}`
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

/** A schema a full world can be built over: what fullWorld takes. */
type Reality = Parameters<typeof fullWorld>[0]

/** The full world built over `S` itself, its role typed by S's own relations, its login's workload holding P. */
type WorldOver<S extends Reality, P extends Readonly<Record<string, unknown>>> = ReturnType<
	typeof fullWorld<S, P>
>

export interface Opened<S extends Reality, P extends Readonly<Record<string, unknown>>> {
	readonly installed: Installed
	/**
	 * The fixture rebuilt under the installed schema name: its relations and statements, under a name known only at
	 * run time, which places the installation. A query or ChangeSet built over the fixture runs against it too: a level
	 * is its content, not its name (program/schema.ts levelSchema).
	 */
	readonly schema: S
	/**
	 * The full world's role over the rebuilt schema, which every program over the fixture runs on, and its login, whose
	 * workload holds the fixture's programs.
	 */
	readonly app: WorldOver<S, P>["app"]
	readonly server: WorldOver<S, P>["server"]
	/**
	 * The login served as an application serves it, from the file generate wrote (test/support/served-db.ts
	 * servedFixtureOf): a Db opens through
	 * `served.login.roles.app` on `served.layer`, in the substrate's database, and runs the programs as
	 * `db.workload.<name>`.
	 */
	readonly served: ServedFixture<WorldOver<S, P>["server"]>
}

/**
 * What an installation of a read fixture states: the label of its allocated schema name, and the programs its login's
 * workload holds, each a member a Db of its full world runs by its name. Its one world is its full world.
 */
export interface FixtureInstall<P extends Readonly<Record<string, unknown>>> {
	readonly label: string
	readonly programs: P
}

/**
 * Installs `fixture` under a fresh schema as `grizzle generate` drafts and serves it (test/support/install-migrate.ts
 * installGenerated), with its full world's login, whose workload holds `options.programs`, so the installation holds
 * the live source of every read the programs serve; loads `facts`, rebuilds the fixture under the installed name, and
 * serves that login from the file generate wrote: a program of its own the compile refuses is a defect of the test.
 * The fixture is a schema value whose relations sit under their own names and whose statements name only its
 * relations and read back from their names as themselves, as schema(...) checked when it was built.
 */
export const installed = <
	const N extends string,
	R extends Record<string, AnyRelation | AnyClosed>,
	const St extends ReadonlyArray<Statement>,
	const P extends Readonly<Record<string, unknown>>
>(
	fixture: Schema<N, R, StatementsByName<St, R>> & {
		readonly statements: St &
			StatementsWithin<St, R> &
			StatementsReadBack<St, Declared<ReadonlyArray<R[keyof R]>>>
	},
	facts: FactSet,
	options: FixtureInstall<P>
): Effect.Effect<
	Opened<
		Schema<
			string,
			Declared<ReadonlyArray<R[keyof R]>>,
			StatementsByName<St, Declared<ReadonlyArray<R[keyof R]>>>
		>,
		P
	>,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const relations: Array<R[keyof R]> = []
		for (const name in fixture.relations) {
			relations.push(fixture.relations[name])
		}
		const named = (name: string) =>
			builtSchema<string, ReadonlyArray<R[keyof R]>, St>(name, relations, fixture.statements, [])
		const generated = yield* installGenerated(
			(name) => ({
				schema: named(name),
				logins: [fullWorld(named(name), options.programs).server]
			}),
			{ label: options.label, ambient: ordinarySession }
		)
		const done = generated.installed
		yield* load(done, facts)
		const rebuilt = named(done.declared)
		const world = fullWorld(rebuilt, options.programs)
		return {
			installed: done,
			schema: rebuilt,
			app: world.app,
			server: world.server,
			served: servedFixtureOf(
				done,
				world.server,
				defined(generated.served.get(world.server.name), `login ${world.server.name}'s served file`)
			)
		}
	})
