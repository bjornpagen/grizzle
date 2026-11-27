/**
 * What PostgreSQL holds of a role's world objects in an installation: each one's statement as grizzle compiles and prints
 * it, which the worlds model reads where a migration's world change turns on it (catalog.ts worldObjects). A role's
 * view, filter function or key probe is lowered under the installation's keys and containments, and its statement says
 * what the lowering proves (a DISTINCT dropped where a key makes the rows a set), which the model has no lowering of its
 * own to restate: it reads the statement, and states only which objects there are and what each reads.
 */

import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { heldOf } from "#compiler/deploy/diff/privileges.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { namedRole, type WorldNames, worldNames } from "#compiler/physical/ddl/names.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { ownRole } from "#compiler/schema/own.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import type { ObjectName, SqlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { buildInstall, type Built } from "#test/support/worlds/execute/build.ts"
import { plannedVersion } from "#test/support/worlds/execute/catalog.ts"
import type { InstallSpec } from "#test/support/worlds/model/types.ts"

/**
 * Where a role's world object stands among an installation's statements: its view of a role relation (a whole entry's
 * relation or a query entry's name), its policy on a table it writes, a written query entry's filter function, or its
 * key probe over a key of its target.
 */
export type WorldLocus =
	| { readonly kind: "view"; readonly relation: string }
	| { readonly kind: "policy"; readonly target: string }
	| { readonly kind: "filter"; readonly entry: string }
	| { readonly kind: "key-probe"; readonly entry: string; readonly key: ReadonlyArray<string> }

/** The schema every installation is compiled under to be read here: one name, so two versions' statements compare. */
const compiledSchema = "worlds_model"

/** An installation compiled as `grizzle generate` compiles a first version (execute/catalog.ts plannedVersion). */
interface Compiled {
	readonly built: Built
	readonly installation: Installation
}

/** Each installation's compile, made once per InstallSpec value, as baseBuild builds it once. */
const compiles = new WeakMap<InstallSpec, Compiled>()

const compiledOf = (install: InstallSpec): Compiled => {
	const known = compiles.get(install)
	if (known !== undefined) {
		return known
	}
	const compiled = Effect.runSync(
		Effect.orDie(
			Effect.gen(function* () {
				const built = yield* buildInstall(install, compiledSchema)
				const { plan } = yield* plannedVersion(
					built.base,
					Rec.values(built.logins),
					compiledSchema,
					emptySnapshot({ schemaName: compiledSchema, schema: compiledSchema }),
					{ step: 0, declarations: noDeclarations }
				)
				return { built, installation: plan.installation }
			})
		)
	)
	compiles.set(install, compiled)
	return compiled
}

/** The names of a role's world objects in a compiled installation. */
const namesOf = (compiled: Compiled, role: string): WorldNames => {
	const value = compiled.built.roles[role]
	const desc = value === undefined ? undefined : roleDescOf(value)
	if (desc === undefined) {
		throw new Error(`the worlds model reads role ${role}, which the installation does not build`)
	}
	const owned = Effect.runSync(Effect.orDie(fromEngine(ownRole(desc))))
	return worldNames(
		succeeded(namedRole(owned, compiled.installation.names.levels), `role ${role} named`),
		compiled.installation.names
	)
}

const sameName = (a: ObjectName, b: ObjectName): boolean =>
	a.schema === b.schema && a.name === b.name

/** Whether a statement creates the world object at `locus` of the role named by `names`. */
const creates =
	(compiled: Compiled, names: WorldNames, locus: WorldLocus) =>
	(s: SqlStatement): boolean => {
		switch (locus.kind) {
			case "view":
				return s.kind === "createView" && sameName(s.name, names.view(locus.relation))
			case "policy":
				return (
					s.kind === "createPolicy" &&
					s.name === names.role &&
					sameName(s.table, compiled.installation.names.relation(locus.target))
				)
			case "filter":
				return (
					s.kind === "createFunction" && sameName(s.name, names.filterFunction(locus.entry, []))
				)
			case "key-probe":
				return (
					s.kind === "createFunction" &&
					sameName(s.name, names.keyProbe(locus.entry, locus.key, []))
				)
		}
	}

/** A world object's place, as a defect names it. */
const locusText = (locus: WorldLocus): string => {
	switch (locus.kind) {
		case "view":
			return `view of ${locus.relation}`
		case "policy":
			return `policy on ${locus.target}`
		case "filter":
			return `filter function of ${locus.entry}`
		case "key-probe":
			return `key probe of ${locus.entry} over (${Arr.join(locus.key, ", ")})`
	}
}

/**
 * The statement PostgreSQL holds of a role's world object in an installation, as grizzle prints it: the one statement
 * that creates it. The model names only objects the installation creates, so one it names that has none is a defect of
 * the model.
 */
export const heldStatement = (install: InstallSpec, role: string, locus: WorldLocus): string => {
	const compiled = compiledOf(install)
	const statement = Arr.findFirst(
		compiled.installation.statements,
		creates(compiled, namesOf(compiled, role), locus)
	)
	if (Option.isNone(statement)) {
		throw new Error(
			`the worlds model names the ${locusText(locus)} of role ${role}, which the installation does not create`
		)
	}
	return printStatement(statement.value)
}

/** An object a statement creates or a GRANT names, by its kind and its schema-qualified name, a function's argument types
 * aside, as a world function is named once. */
const objectNamed = (kind: "TABLE" | "FUNCTION", name: ObjectName): string =>
	`${kind} ${name.schema}.${name.name}`

/**
 * The privileges a role holds in an installation on what no migration creates again under it: each privilege of each
 * GRANT to its role (deploy/diff/privileges.ts heldOf) and each column grant to it, but those on its world objects, a
 * view of it or a world function, which a migration grants right after it creates them, again or anew, and drops with
 * them (deploy/diff/diff.ts regrantWorld). A migration whose role holds other ones here drafts its grants and revokes in
 * Publish.
 */
export const standingGrants = (install: InstallSpec, role: string): ReadonlyArray<string> => {
	const compiled = compiledOf(install)
	const names = namesOf(compiled, role)
	const worlds = new Set(
		Arr.flatMap(compiled.installation.manifest.objects, (o) =>
			o.kind === "view" || o.kind === "worldFunction"
				? Arr.flatMap(o.ddl, (d) =>
						d.kind === "createView"
							? [objectNamed("TABLE", d.name)]
							: d.kind === "createFunction"
								? [objectNamed("FUNCTION", d.name)]
								: []
					)
				: []
		)
	)
	const held = Arr.flatMap(compiled.installation.statements, (s): ReadonlyArray<string> =>
		s.kind === "grant"
			? Arr.flatMap(heldOf(s), (h) =>
					h.grantee.kind === "role" &&
					h.grantee.name === names.role &&
					!(
						(h.object.kind === "TABLE" || h.object.kind === "FUNCTION") &&
						worlds.has(objectNamed(h.object.kind, h.object.name))
					)
						? [h.key]
						: []
				)
			: s.kind === "grantColumns" && s.to === names.role
				? [`${s.privilege} ${s.table.schema}.${s.table.name} (${Arr.join(s.columns, ",")})`]
				: []
	)
	return Arr.sort(Arr.dedupe(held), Order.String)
}

/**
 * Each table's declared statistics in an installation, as grizzle prints them, by the table's name: the numbers of
 * distinct values the solver derives from the relation's shape, its columns, keys, indexes and the bindings of every
 * statement that reads it (physical/statistics), which the model has no solver of its own to restate. A migration
 * declares each table whose declaration it changes or makes anew in Indexes (deploy/diff/plan.ts), a key added on a
 * table that holds rows among them.
 */
export const declaredStatistics = (install: InstallSpec): ReadonlyMap<string, string> =>
	new Map(
		Arr.flatMap(compiledOf(install).installation.statements, (s) =>
			s.kind === "declareStatistics"
				? [[objectNamed("TABLE", s.table), printStatement(s)] as const]
				: []
		)
	)
