import { Array as Arr, Effect, Formatter, type Scope, String as Str } from "effect"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	type AnyClosed,
	type AnyLogin,
	type AnyRelation,
	type AnyRole,
	type AnySchema,
	type Declared,
	type Schema,
	type Statement,
	type StatementsByName,
	type StatementsReadBack,
	type StatementsWithin
} from "#compiler/public/schema.ts"
import { schema as builtSchema } from "#compiler/schema/schema.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import {
	type Installed,
	installMigrated as install,
	loadMigrated as load
} from "#test/support/install-migrate.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type ServedFixture, servedFixture } from "#test/support/served-db.ts"
import {
	ExpectationFailed,
	type PgErrorFields,
	type PsqlProcessError,
	pgErrorFields,
	type TransactionRolledBack
} from "#test/support/substrate/errors.ts"
import type { PsqlWriter } from "#test/support/substrate/psql.ts"
import { Substrate, worldPsql } from "#test/support/substrate/substrate.ts"

/** A schema's relations as the list it was built from, its record's members. */
type Listed<R> = ReadonlyArray<R[keyof R]>

/**
 * A schema value whose statements name only its relations and read back from their names as themselves, as
 * schema(...) checked when it was built, over the list of its relations it is rebuilt from.
 */
type Checked<N extends string, R, St extends ReadonlyArray<Statement>> = Schema<
	N,
	R,
	StatementsByName<St, R>
> & {
	readonly statements: St & StatementsWithin<St, R> & StatementsReadBack<St, Declared<Listed<R>>>
}

/** A schema's relations as the list it was built from: its record's members, in the record's order. */
const listed = <R extends Record<string, AnyRelation | AnyClosed>>(relations: R): Listed<R> => {
	const out: Array<R[keyof R]> = []
	for (const name in relations) {
		out.push(relations[name])
	}
	return out
}

export interface Fixture {
	readonly installed: Installed
	/**
	 * A relation's table or view by its declared name, as the installation places it: in the schema of the level that
	 * declares it, schema-qualified and quoted.
	 */
	readonly t: (relation: string) => string
	/** A schema value of the fixture (the installed one or a level below it) rebuilt under the installed name. */
	readonly rebuilt: <
		const N extends string,
		R extends Record<string, AnyRelation | AnyClosed>,
		const St extends ReadonlyArray<Statement>
	>(
		value: Checked<N, R, St>
	) => Schema<string, Declared<Listed<R>>, StatementsByName<St, Declared<Listed<R>>>>
	/**
	 * A login of the rebuilt worlds served as an application serves it, from its own served file over the installation
	 * (test/support/served-db.ts servedFixture): its served login, whose roles a Db opens, and its layer.
	 */
	readonly served: <L extends AnyLogin>(login: L) => Effect.Effect<ServedFixture<L>, ServedRefusal>
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
 * Shared helpers of the suites that open a fixture whole: the direct writers' native errors and the queue's and the
 * payroll's races.
 *
 * A fixture installs under a fresh schema name with its complete installation: its native laws and its derived
 * relations (packages/engine/src/physical/derived), as the fresh installer runs them. Its facts
 * load as the owner in one transaction, so every deferred law judges the loaded state at its COMMIT, and a schema value
 * of the fixture is rebuilt under the installed name from its own relations and statements, typed by them, so a login
 * of its worlds serves the installed objects and logs in as the installed login (test/pg/reads/support.ts). The
 * fixture installs with the logins its caller gives, over the declared schema; its worlds are rebuilt over the
 * installed name by the caller. Writers are grizzle (the members of a login served from its own served file, through
 * `served` and Db.open of its role) and psql children in a role's world, logged in as its login over verify-full TLS,
 * which see PostgreSQL's native errors ("Direct SQL writers").
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
		const fx: Fixture = {
			installed: done,
			t: (relation) => printObjectName(done.installation.names.relation(relation)),
			rebuilt: <
				const N extends string,
				R extends Record<string, AnyRelation | AnyClosed>,
				const St extends ReadonlyArray<Statement>
			>(
				value: Checked<N, R, St>
			) =>
				builtSchema<string, Listed<R>, St>(
					done.schema,
					listed<R>(value.relations),
					value.statements,
					[]
				),
			served: (login) => servedFixture(done, login),
			owner,
			rows: (sql) =>
				Effect.map(s.admin.queryValues(Str.replaceAll("$S", q)(sql), []), (rs) =>
					Arr.map(rs, (r) =>
						Arr.map(r, (x) =>
							x === null ? "NULL" : typeof x === "string" ? x : Formatter.format(x)
						)
					)
				),
			psql: (role) => s.psql({ ...worldPsql(done.world(role)), label: role.name })
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
