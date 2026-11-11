import { Array as Arr, Effect, type Scope } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { admitLoginRoles } from "#compiler/ir/desc.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"

import { admitSchemaDesc } from "#compiler/schema/admit.ts"
import {
	fullRoleDesc,
	type OwnedLogin,
	type OwnedRole,
	ownLogin,
	ownRole
} from "#compiler/schema/own.ts"
import { declaredErasure } from "#test/support/catalog/declared.ts"
import {
	type GrantKind,
	type ProjectedCatalog,
	type ProjectedGrant,
	projectedGrants
} from "#test/support/catalog/expected.ts"
import { closedConstantsOf } from "#test/support/catalog/installed.ts"
import { type Catalog, readCatalog } from "#test/support/catalog/read.ts"
import type { ErasureExpectation } from "#test/support/catalog/verify.ts"
import { type FixtureSchema, installationSql } from "#test/support/compile.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The worlds a fixture description opens in, as values: the full role `writer`, holding every relation whole, writing
 * every stored one and refreshing every derived one, and `reader`, holding every relation whole and writing and
 * refreshing nothing, in the login `server`.
 */
export interface FixtureWorlds {
	readonly login: OwnedLogin
	readonly writer: OwnedRole
	readonly reader: OwnedRole
}

/** A compile step's value: the fixture's worlds are well formed, so a refusal is the fixture's defect, thrown. */
const accepted = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw r.error
	}
	return r.value
}

export const fixtureWorlds = (desc: SchemaDesc): FixtureWorlds => {
	const loc = SourceLoc(`the fixture login of ${desc.name}`, [])
	const base = accepted(admitSchemaDesc(desc))
	const writer = accepted(fullRoleDesc(base, "writer", loc))
	const reader = { ...writer, name: "reader", write: [], refresh: [] }
	return {
		login: accepted(
			Result.flatMap(
				admitLoginRoles(base, { name: "server", roles: [writer, reader], loc }),
				ownLogin
			)
		),
		writer: accepted(ownRole(writer)),
		reader: accepted(ownRole(reader))
	}
}

/** The fixture's login alone. */
export const fixtureLogin = (desc: SchemaDesc): OwnedLogin => fixtureWorlds(desc).login

/**
 * A role value's PostgreSQL roles as the installation created them: its login's and its theory role. A role the
 * installation does not hold is a defect of the test.
 */
export const installedRoleOf = (
	installation: Installation,
	role: OwnedRole
): { readonly login: string; readonly role: string } => {
	for (const login of installation.worlds) {
		for (const r of login.roles) {
			if (r.name === role.name) {
				return { login: login.role, role: r.role }
			}
		}
	}
	throw new Error(`the installation holds no role ${role.name}`)
}

/**
 * Installing a compiled schema in the substrate's database for the physical tests: each installation gets a unique
 * schema name, because roles are cluster-wide, and the substrate's schema finalizer drops the schema and every
 * `<schema>__*` role it created.
 *
 * Installs `desc` with `logins` under a fresh schema and reads its catalog.
 */
export const installed = (
	desc: FixtureSchema,
	label: string,
	logins: ReadonlyArray<OwnedLogin>
): Effect.Effect<InstalledFixture, SqlError | TransactionRolledBack, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schema = yield* substrate.schema({ create: false, label })
		const owned = owning(desc)
		const compiled = compileInstallation(owned, {
			...installOptions(owned, substrate.owner.role),
			levels: [identity.schema(parsedSchemaName(schema))],
			logins
		})
		if (!compiled.ok) {
			return yield* Effect.die(new Error(`compile: ${compiled.error.message}`))
		}
		const installation: Installation = compiled.value
		yield* transaction(substrate.admin, installationSql(installation))
		const read = yield* readCatalog(substrate.admin, [schema])
		if (read.kind === "absent") {
			return yield* Effect.die(new Error(`the installed schema ${schema} is absent`))
		}
		const catalog: Catalog = read.catalog
		return { installation, catalog, schema }
	})

/** An installed fixture: its installation, the catalog read back from it, and the schema it is installed under. */
interface InstalledFixture {
	readonly installation: Installation
	readonly catalog: Catalog
	readonly schema: string
}

/**
 * The expectation of a fixture installed with its worlds: the declaration's, the fixture's login with its two roles,
 * and the writer refreshing every derived relation's materialized view.
 */
export const worldsExpectation = (
	desc: SchemaDesc,
	installation: Installation,
	worlds: FixtureWorlds
): ErasureExpectation => {
	const writer = installedRoleOf(installation, worlds.writer)
	const reader = installedRoleOf(installation, worlds.reader)
	const declared = declaredErasure(desc)
	return {
		...declared,
		/** The description names no closed constant: the installation's, each as the verifier judges its executors. */
		functions: new Map([...declared.functions, ...closedConstantsOf(installation)]),
		logins: new Map([[writer.login, new Set([writer.role, reader.role])]]),
		refreshes: new Map([
			[
				writer.role,
				new Set(
					Arr.map(
						worlds.writer.refresh,
						(relation) => identity.view(parsedName(relation)).identifier
					)
				)
			],
			[
				reader.role,
				new Set(
					Arr.map(
						worlds.reader.refresh,
						(relation) => identity.view(parsedName(relation)).identifier
					)
				)
			]
		]),
		/** Whole entries all: every view plain. */
		barrierViews: new Set()
	}
}

/**
 * The grants of a fixture installed with its worlds, as ProjectedCatalog.grants holds them, derived from its
 * declaration and the types the catalog holds, never from the installer: the writer and the reader hold every relation
 * whole, so each holds USAGE on the schema and on every enum and domain of it (a full role reads every type a
 * relation's heading uses, and the installer creates no other) but a closed relation's own pattern domain, and SELECT
 * on its view of every stored and derived relation; the writer writes every stored relation, so it holds SELECT, INSERT and DELETE on its table, UPDATE too on a
 * mutable one, and EXECUTE on the refusal function and on every serial field's advance function, and refreshes every
 * derived one, so it holds MAINTAIN on its materialized view; the login holds USAGE on the schema and EXECUTE on the
 * snapshot guard; each role's schema grants USAGE to its role alone; and both roles hold EXECUTE on a declared closed
 * relation's own constants, the writer on any constant a CHECK or generated column it writes calls.
 *
 * The writer refreshes every derived relation, which both read through their views.
 */
export const worldsGrants = (
	desc: SchemaDesc,
	installation: Installation,
	worlds: FixtureWorlds,
	catalog: ProjectedCatalog
): ReadonlyArray<ProjectedGrant> => {
	const declared = declaredErasure(desc)
	const writer = installedRoleOf(installation, worlds.writer)
	const reader = installedRoleOf(installation, worlds.reader).role
	/** Each of `grantees` holding each of `privileges` on the object of `kind` named `name`. */
	const on = (
		kind: GrantKind,
		name: string,
		grantees: ReadonlyArray<string>,
		privileges: ReadonlyArray<string>
	): ReadonlyArray<ProjectedGrant> =>
		Arr.flatMap(grantees, (grantee) =>
			Arr.map(privileges, (privilege) => ({ kind, name, grantee, privilege }))
		)
	/**
	 * A closed constant's executors: every world role on a declared closed relation's own constant, which its closed
	 * reads call, and the writer on one a CHECK or generated column of a table it writes calls.
	 */
	const closedExecutors = Arr.flatMap(
		closedConstantsOf(installation),
		([name, fn]): ReadonlyArray<ProjectedGrant> =>
			fn.kind === "closedConstant"
				? on(
						"function",
						name,
						fn.declared ? [writer.role, reader] : fn.tables.length > 0 ? [writer.role] : [],
						["EXECUTE"]
					)
				: []
	)
	/**
	 * The domains a full role reads: every domain of the schema but a text domain whose every use is a closed
	 * relation's field, which no table holds, the migration's validation of the closed facts alone casting to it.
	 */
	const tables = new Set(Arr.map(catalog.tables, (t) => t.name))
	const closedOnly = new Set<string>(
		Arr.flatMap(installation.textDomains, (d) =>
			Arr.some(d.uses, (u) => tables.has(u.table)) ? [] : [d.name]
		)
	)
	const usedDomains = Arr.filter(catalog.domains, (d) => !closedOnly.has(d.name))
	return projectedGrants([
		...on("schema", installation.names.schema, [writer.login, writer.role, reader], ["USAGE"]),
		...on("schema", writer.role, [writer.role], ["USAGE"]),
		...on("schema", reader, [reader], ["USAGE"]),
		...Arr.flatMap([...declared.tables], (table) => [
			...on(
				"table",
				table,
				[writer.role],
				declared.mutable.has(table)
					? ["SELECT", "INSERT", "DELETE", "UPDATE"]
					: ["SELECT", "INSERT", "DELETE"]
			),
			...on("table", `${writer.role}.${table}`, [writer.role], ["SELECT"]),
			...on("table", `${reader}.${table}`, [reader], ["SELECT"])
		]),
		...Arr.flatMap(usedDomains, (type) => on("type", type.name, [writer.role, reader], ["USAGE"])),
		...Arr.flatMap([...declared.views], (view) => [
			...on("table", view, [writer.role], ["MAINTAIN"]),
			...on("table", `${writer.role}.${view}`, [writer.role], ["SELECT"]),
			...on("table", `${reader}.${view}`, [reader], ["SELECT"])
		]),
		...Arr.flatMap([...declared.functions], ([name, fn]): ReadonlyArray<ProjectedGrant> => {
			switch (fn.kind) {
				case "refusal":
					return declared.tables.size > 0 ? on("function", name, [writer.role], ["EXECUTE"]) : []
				case "advance":
					return on("function", name, [writer.role], ["EXECUTE"])
				case "snapshotGuard":
					return on("function", name, [writer.login], ["EXECUTE"])
				case "names":
				case "live":
					return on("function", name, [writer.role, reader], ["EXECUTE"])
				case "world":
				case "isolationGuard":
				case "rule":
				case "closedConstant":
					return []
			}
		}),
		...closedExecutors
	])
}
