import * as Result from "@bjornpagen/grizzle-text/base/result"
import { Array as Arr, Effect } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
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
import {
	closedConstantsOf,
	lawFunctionsOf,
	lawTriggersOf
} from "#test/support/catalog/installed.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import type { ErasureExpectation } from "#test/support/catalog/verify.ts"
import { type FixtureSchema, installationSql } from "#test/support/compile.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { owning } from "#test/support/policy.ts"
import { noTables } from "#test/support/substrate/replace.ts"
import {
	installTemplate,
	Substrate,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"

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

/** `desc` compiled for the physical tests under the schema `schema`, with `logins`: a defect where it does not compile. */
export const compiledFixture = (
	desc: FixtureSchema,
	schema: string,
	logins: ReadonlyArray<OwnedLogin>
): Installation => {
	const owned = owning(desc)
	const compiled = compileInstallation(owned, {
		...installOptions(owned),
		levels: [identity.schema(parsedSchemaName(schema))],
		logins
	})
	if (!compiled.ok) {
		throw new Error(`compile: ${compiled.error.message}`)
	}
	return compiled.value
}

/** A fixture a template installed: its installation and the schema it is installed under. */
export interface TemplateFixture {
	readonly installation: Installation
	readonly schema: string
}

/**
 * `installed`'s installation as a template (substrate.ts installTemplate): compiled under the template's schema name by
 * every worker as it plans, its script run once per member, where a suite installed it before its cases. A case reads
 * its catalog from its clone (fixtureCatalog); its seat empties no table, since a case writes only in a transaction it
 * rolls back.
 */
export const physicalTemplate = (spec: {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly desc: FixtureSchema
	readonly logins: ReadonlyArray<OwnedLogin>
}): SubstrateTemplate<TemplateFixture> =>
	installTemplate({
		declaredIn: spec.declaredIn,
		name: spec.name,
		content: { fixture: spec.desc.name },
		plan: (names) =>
			Effect.sync(() => ({
				schema: names.schema,
				installation: compiledFixture(spec.desc, names.schema, spec.logins)
			})),
		install: ({ installation }) =>
			Effect.flatMap(Substrate, (substrate) =>
				transaction(substrate.admin, installationSql(installation, substrate.database))
			),
		bind: (fixture) => fixture,
		reset: () => noTables
	})

/** The catalog of a template's fixture as its case's clone holds it. */
export const fixtureCatalog = (fixture: TemplateFixture) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const read = yield* readCatalog(substrate.admin, [fixture.schema])
		if (read.kind === "absent") {
			return yield* Effect.die(new Error(`the installed schema ${fixture.schema} is absent`))
		}
		return read.catalog
	})

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
		/** The description names no closed constant and no law function: the installation's, each as the verifier
		 * judges its executors, a rule's captures among them. */
		functions: new Map([
			...declared.functions,
			...closedConstantsOf(installation),
			...lawFunctionsOf(installation)
		]),
		triggers: new Map([...declared.triggers, ...lawTriggersOf(installation)]),
		logins: new Map([
			[writer.login, { roles: new Set([writer.role, reader.role]), fenced: new Set<string>() }]
		]),
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
 * mutable one, and EXECUTE on every serial field's advance function, and refreshes every derived one, so it holds
 * MAINTAIN on its materialized view; both roles hold EXECUTE on the refusal function, whatever they write; the login
 * holds USAGE on the schema and EXECUTE on the snapshot guard; each role's schema grants USAGE to its role alone; and both roles hold EXECUTE on a declared closed
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
	 * reads call, and the writer on one a CHECK or generated column of a table it writes calls, as on every row function
	 * and library function a table's CHECKs and generated columns call.
	 */
	const closedExecutors = Arr.flatMap(
		closedConstantsOf(installation),
		([name, fn]): ReadonlyArray<ProjectedGrant> => {
			switch (fn.kind) {
				case "closedConstant":
					return on(
						"function",
						name,
						fn.declared ? [writer.role, reader] : fn.tables.length > 0 ? [writer.role] : [],
						["EXECUTE"]
					)
				case "rowFunction":
				case "libraryFunction":
					return on("function", name, fn.tables.length > 0 ? [writer.role] : [], ["EXECUTE"])
				case "world":
				case "immutableGuard":
				case "declared":
				case "refusal":
				case "snapshotGuard":
				case "isolationGuard":
				case "rule":
				case "hold":
				case "retire":
				case "names":
				case "live":
					return []
			}
		}
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
					return on("function", name, [writer.role, reader], ["EXECUTE"])
				case "snapshotGuard":
					return on("function", name, [writer.login], ["EXECUTE"])
				case "names":
				case "live":
					return on("function", name, [writer.role, reader], ["EXECUTE"])
				case "world":
				case "isolationGuard":
				case "immutableGuard":
				case "rule":
				case "hold":
				case "retire":
				case "closedConstant":
				case "rowFunction":
				case "libraryFunction":
				case "declared":
					return []
			}
		}),
		...closedExecutors
	])
}
