import { Array as Arr, Effect, Formatter, type Scope, String as Str } from "effect"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type {
	AnyClosed,
	AnyLogin,
	AnyRelation,
	AnyRole,
	Statement
} from "#compiler/public/schema.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import {
	type Installed,
	installGenerated,
	loadMigrated as load,
	type Version
} from "#test/support/install-migrate.ts"
import { type Rebuildable, type Rebuilt, rebuild } from "#test/support/installed.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type ServedFixture, servedFixture } from "#test/support/served-db.ts"
import {
	type PsqlProcessError,
	type TransactionRolledBack
} from "#test/support/substrate/errors.ts"
import type { PsqlWriter } from "#test/support/substrate/psql.ts"
import {
	claimsOfNoFact,
	Substrate,
	type SubstrateShape,
	worldPsql
} from "#test/support/substrate/substrate.ts"

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
		value: Rebuildable<N, R, St>
	) => Rebuilt<R, St>
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
	/** The facts loaded after the install. */
	readonly facts: FactSet
	/** SQL run as the owner after the facts, in one transaction: none when empty. */
	readonly after: ReadonlyArray<string>
}

/**
 * Shared helpers of the suites that open a fixture whole: the direct writers' native errors and the queue's and the
 * payroll's races.
 *
 * A fixture installs under a fresh schema name with its complete installation: its native laws and its derived
 * relations (packages/engine/src/physical/derived), as the fresh installer runs them. Its facts
 * load as the owner in one transaction, so every deferred law judges the loaded state at its COMMIT, and a schema value
 * of the fixture is rebuilt under the installed name (installed.ts rebuild), typed by its relations and statements, so a
 * login of its worlds serves the installed objects and logs in as the installed login (test/support/pg/reads/support.ts). The
 * fixture installs with the logins its caller builds under the allocated name; its worlds are rebuilt over the
 * installed name by the caller. Writers are grizzle (the members of a login served from its own served file, through
 * `served` and Db.open of its role) and psql children in a role's world, logged in as its login over verify-full TLS,
 * which see PostgreSQL's native errors ("Direct SQL writers").
 *
 * Installs `build(name)`, the fixture and its logins under the allocated name `name`, completely under a fresh schema
 * name as `grizzle generate` drafts and serves it (install-migrate.ts installGenerated), loads its facts, and returns
 * the helpers above.
 */
export const openFixture = (
	build: (name: string) => Version,
	options: OpenOptions
): Effect.Effect<
	Fixture,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const { installed: done } = yield* installGenerated(build, {
			ambient: ordinarySession,
			label: "real"
		})
		yield* load(done, options.facts)
		const fx = fixtureOf(s, done)
		if (options.after.length > 0) {
			yield* fx.owner(options.after)
		}
		return fx
	})

/** The fixture of the installation `done` in the substrate `s`: its names, its owner's statements and its psql children. */
const fixtureOf = (s: SubstrateShape, done: Installed): Fixture => {
	const q = quoteIdent(done.schema)
	return {
		installed: done,
		t: (relation) => printObjectName(done.installation.names.relation(relation)),
		rebuilt: <
			const N extends string,
			R extends Record<string, AnyRelation | AnyClosed>,
			const St extends ReadonlyArray<Statement>
		>(
			value: Rebuildable<N, R, St>
		) => rebuild(value, done.declared),
		served: (login) => servedFixture(done, login),
		owner: (sql) =>
			transaction(
				s.admin,
				Arr.map(sql, (x) => Str.replaceAll("$S", q)(x))
			),
		rows: (sql) =>
			Effect.map(s.admin.queryValues(Str.replaceAll("$S", q)(sql), []), (rs) =>
				Arr.map(rs, (r) =>
					Arr.map(r, (x) => (x === null ? "NULL" : typeof x === "string" ? x : Formatter.format(x)))
				)
			),
		psql: (role) => s.psql({ ...worldPsql(done.world(role), claimsOfNoFact), label: role.name })
	}
}
