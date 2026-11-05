import { Array as Arr, Effect, Formatter, Layer, Option, type Scope, String as Str } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { namedDetail } from "#compiler/ir/law.ts"
import {
	type AnyClosed,
	type AnyLogin,
	type AnyLoginRole,
	type AnyRelation,
	type AnyRole,
	type AnySchema,
	type Schema,
	type Statement,
	type StatementsWithin,
	type UnderOwnNames,
	schema
} from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { strictDetail } from "#test/support/detail.ts"
import {
	type Installed,
	installMigrated as install,
	loadMigrated as load
} from "#test/support/install-migrate.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	ExpectationFailed,
	type PgErrorFields,
	type PsqlProcessError,
	pgErrorFields,
	type TransactionRolledBack
} from "#test/support/substrate/errors.ts"
import type { PsqlWriter } from "#test/support/substrate/psql.ts"
import { Substrate, worldPsql } from "#test/support/substrate/substrate.ts"
import { loginLayerIn, tokenOf } from "#test/support/worlds.ts"

/**
 * A schema value whose relations sit under their own names and whose statements name only its relations, as
 * schema(...) checked when it was built.
 */
type Checked<N extends string, R, St extends ReadonlyArray<Statement>> = Schema<N, R, St> & {
	readonly relations: UnderOwnNames<R>
	readonly statements: StatementsWithin<St, R>
}

export interface Fixture {
	readonly installed: Installed
	/** The PostgreSQL schema, quoted. */
	readonly q: string
	/** A table of the installation, schema-qualified and quoted. */
	readonly t: (table: string) => string
	/** A schema value of the fixture (the installed one or a level below it) rebuilt under the installed name. */
	readonly rebuilt: <
		const N extends string,
		R extends Record<string, AnyRelation | AnyClosed>,
		const St extends ReadonlyArray<Statement>
	>(
		value: Checked<N, R, St>
	) => Schema<string, R, readonly [...St]>
	/** The DbLayer of a login over the installation, aimed at the substrate's target. */
	readonly layer: <L extends AnyLogin>(login: L) => Layer.Layer<DbLayerOf<L>, OpenError>
	/** Owner statements in one transaction; `$S` is the quoted schema. */
	readonly owner: (
		sql: ReadonlyArray<string>
	) => Effect.Effect<void, SqlError | TransactionRolledBack>
	/** One owner query's rows as texts. */
	readonly rows: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, SqlError>
	/**
	 * A psql child in a role's world: logged in as the login that holds it, the role taken on; closed with the scope.
	 */
	readonly psql: (role: AnyRole) => Effect.Effect<PsqlWriter, PsqlProcessError, Scope.Scope>
	/**
	 * Runs `body` with `role`, a role of the rebuilt worlds reached through its login, opened through a DbLayer of that
	 * login. The Db is typed by no particular role: the bodies apply ChangeSets through its runtime
	 * (test/support/runtime-db.ts).
	 */
	readonly withDb: <A, E>(
		role: AnyLoginRole,
		body: (db: Db<AnyRole, unknown>) => Effect.Effect<A, E, Scope.Scope>
	) => Effect.Effect<A, E | OpenError>
}

export interface OpenOptions {
	/** The facts loaded after the install: `noFacts` for none. */
	readonly facts: FactSet
	/** SQL run as the owner after the facts, in one transaction: none when empty. */
	readonly after: ReadonlyArray<string>
}

/** No fact: the fixture installed empty. */
const noFacts: FactSet = {}

/** A fixture installed empty, with nothing run after. */
export const bareFixture: OpenOptions = { facts: noFacts, after: [] }

/**
 * Shared helpers of the law-bearing end-to-end suites.
 *
 * A fixture installs under a fresh schema name with its complete installation: the natives, its residual laws
 * (packages/engine/src/physical/laws) and its derived relations (packages/engine/src/physical/derived), as the fresh installer runs
 * them. Its facts
 * load as the owner in one transaction, so every deferred law judges the loaded state at its COMMIT, and a schema value
 * of the fixture is rebuilt under the installed name from its own relations and statements, typed by them, so a Db
 * opened on it compiles to the installed objects and logs in as the installed logins (test/pg/reads/support.ts). The
 * fixture installs with the logins its caller gives, over the declared schema; its worlds are rebuilt over the
 * installed name by the caller. Writers are grizzle (db.apply and db.compile through Db.open of a role) and psql
 * children in a role's world, logged in as its login over verify-full TLS, which see PostgreSQL's native errors
 * ("Direct SQL writers").
 *
 * Installs `fixture` completely under a fresh schema name with `logins`, each over the declared fixture, loads its
 * facts, and returns the helpers above.
 */
export const openFixture = (
	fixture: AnySchema,
	logins: ReadonlyArray<AnyLogin>,
	options: OpenOptions
): Effect.Effect<
	Fixture,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const done = yield* install(fixture, {
			ambient: ordinarySession,
			extensions: [],
			logins,
			label: "real"
		})
		yield* load(done, options.facts)
		const q = quoteIdent(done.schema)
		const owner = (sql: ReadonlyArray<string>) =>
			transaction(
				s.admin,
				Arr.map(sql, (x) => Str.replaceAll("$S", q)(x))
			)
		if (options.after.length > 0) {
			yield* owner(options.after)
		}
		const layer = <L extends AnyLogin>(login: L): Layer.Layer<DbLayerOf<L>, OpenError> =>
			loginLayerIn(s.database, done, login)
		const fx: Fixture = {
			installed: done,
			q,
			t: (table) => `${q}.${quoteIdent(table)}`,
			rebuilt: <
				const N extends string,
				R extends Record<string, AnyRelation | AnyClosed>,
				const St extends ReadonlyArray<Statement>
			>(
				value: Checked<N, R, St>
			) => schema<string, R, St>(done.schema, value.relations, value.statements),
			layer,
			owner,
			rows: (sql) =>
				Effect.map(s.admin.queryValues(Str.replaceAll("$S", q)(sql), []), (rs) =>
					Arr.map(rs, (r) =>
						Arr.map(r, (x) =>
							x === null ? "NULL" : typeof x === "string" ? x : Formatter.format(x)
						)
					)
				),
			psql: (role) => s.psql({ ...worldPsql(done.world(role)), label: role.name }),
			withDb: (role, body) =>
				Effect.scoped(
					Effect.flatMap(Layer.build(layer(role.login)), (context) =>
						Effect.provideContext(
							Effect.scoped(Effect.flatMap(Db.open(role, { token: tokenOf({}) }), body)),
							context
						)
					)
				)
		}
		return fx
	})

/** The PostgreSQL error a psql statement or transaction failed with, or a failure naming what happened instead. */
export const failure = <A, E, R>(
	effect: Effect.Effect<A, E, R>
): Effect.Effect<PgErrorFields, ExpectationFailed, R> =>
	Effect.matchEffect(effect, {
		onSuccess: () =>
			Effect.fail(
				new ExpectationFailed({ message: "expected a PostgreSQL error, but it succeeded" })
			),
		onFailure: (error) => {
			const fields = pgErrorFields(error)
			return fields === undefined
				? Effect.fail(
						new ExpectationFailed({ message: `expected a PostgreSQL error, got ${String(error)}` })
					)
				: Effect.succeed(fields)
		}
	})

/** The key texts of a law's DETAIL, through the law model's own codec, for a law of an installation. */
export const decodedDetail = (
	fixture: Fixture,
	law: string,
	detail: Option.Option<string>
): ReadonlyArray<string> => {
	const residual = Arr.findFirst(
		fixture.installed.installation.laws.residuals,
		(r) => r.lawId === law
	)
	assert.ok(Option.isSome(residual), `no residual law ${law}`)
	assert.ok(Option.isSome(detail), `law ${law} raised without a DETAIL`)
	return strictDetail(namedDetail(residual.value.detail), detail.value)
}
