import { Array as Arr, Effect, Record as Rec } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { loginIdentity, roleIdentity } from "#compiler/physical/ddl/names.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { Statement } from "#compiler/public/schema.ts"
import { namedRelation } from "#compiler/schema/relation.ts"
import type { AlternativesBase } from "#compiler/types/schema/statements.ts"
import {
	type InstalledAt,
	installationNamesOf,
	installationOf,
	parsedName
} from "#test/support/kernel/naming.ts"
import { type Built, buildInstall } from "#test/support/worlds/execute/build.ts"
import { atMostOne } from "#test/support/worlds/model/host.ts"
import { domainLawKey } from "#test/support/worlds/model/session/domains.ts"
import type {
	InstallSpec,
	InstalledNames,
	LawIds,
	LawSpec,
	RelationSpec
} from "#test/support/worlds/model/types.ts"

/**
 * The names the compiler gives an installation, read from its compilation through the kernel's naming door
 * (kernel/naming.ts installationOf and installationNamesOf), never spelled: each relation's table and columns, each
 * law's identities, and each role's and login's PostgreSQL role.
 */
const isAlternatives = (statement: Statement): statement is AlternativesBase & Statement =>
	statement.kind === "alternatives"

/** The law identities of one law spec, of its kind. */
const lawIdsOf = (
	names: ReturnType<typeof installationNamesOf>,
	law: LawSpec,
	statement: Statement
): Effect.Effect<LawIds> => {
	switch (law.kind) {
		case "mirrors": {
			const pair = names.mirrorsOf(statement)
			return Effect.succeed({
				kind: "mirrors",
				leftToRight: pair.leftToRight,
				rightToLeft: pair.rightToLeft
			})
		}
		case "alternatives": {
			if (!isAlternatives(statement)) {
				return Effect.die(
					new Error(`the alternatives law of ${law.relation} built a ${statement.kind} statement`)
				)
			}
			const laws = names.alternativesOf(statement)
			return Effect.succeed({
				kind: "alternatives",
				head: laws.head,
				arms: laws.arms,
				reverse: laws.reverse
			})
		}
		case "key":
		case "spanKey":
		case "check":
		case "contained":
		case "covered":
		case "capacity":
			return Effect.succeed({ kind: law.kind, law: names.lawOf(statement) })
	}
}

/**
 * The PostgreSQL role an installation gives a role of a name, whether it holds one or not: a role it dropped had this
 * name, since the naming door mints it from the installed schema's identity and the role's name alone.
 */
export const installedRoleName = (installation: Installation, name: string): string =>
	identifierOf(
		roleIdentity(installation.names.installation, parsedName(name), SourceLoc(`world ${name}`, []))
	)

/** The names of the installation of `built` (the values of `spec`), installed under the schema `at` names. */
export const namesOfBuilt = (
	spec: InstallSpec,
	built: Built,
	at: InstalledAt
): Effect.Effect<InstalledNames> =>
	Effect.gen(function* () {
		const installation = yield* Effect.sync(() => installationOf(built.base, at))
		const names = installationNamesOf(installation)
		const schema = installation.names.schema
		const laws = yield* Effect.forEach(spec.base.laws, (law, i) => {
			const statement = built.laws[i]
			return statement === undefined
				? Effect.die(new Error(`no statement was built for law ${i}`))
				: lawIdsOf(names, law, statement)
		})
		const stored = [
			...Arr.map(spec.base.relations, (r) => [r.name, Arr.map(r.fields, (f) => f.name)] as const),
			...Arr.map(spec.base.derived, (d) => [d.name, Rec.keys(d.rules[0].head)] as const)
		]
		const roleOf = (name: string): string => installedRoleName(installation, name)
		/**
		 * Each contract and refined-text field domain of the base's relations, by its key, with its DOMAIN's CHECK law: a
		 * contract's from its declaration, a text's from the domain the installation types the field's column with. A
		 * text whose pattern every text matches has no DOMAIN, and no law.
		 */
		const domainLaws = (
			r: RelationSpec,
			f: RelationSpec["fields"][number]
		): ReadonlyArray<readonly [string, LawId]> => {
			const domain = f.domain
			switch (domain.kind) {
				case "contract":
					return [[domainLawKey(domain), names.contract(domain.name).law]]
				case "text": {
					const table = names.tableIdent({ name: r.name })
					const column = names.columnIdent({ name: r.name }, f.name)
					const typed = Arr.some(installation.textDomains, (d) =>
						Arr.some(d.uses, (u) => u.table === table && u.column === column)
					)
					return typed
						? [
								[
									domainLawKey(domain),
									names.textDomain(
										namedRelation(built.relations[r.name], `relation ${r.name}`),
										f.name
									).law
								]
							]
						: []
				}
				case "uuid":
				case "integer":
				case "serial":
				case "boolean":
				case "handle":
				case "span":
					return []
			}
		}
		return {
			installation: installation.names.installation,
			schema,
			tables: Rec.fromEntries(
				Arr.map(stored, ([name]) => [name, names.tableIdent({ name })] as const)
			),
			columns: Rec.fromEntries(
				Arr.map(
					stored,
					([name, fields]) =>
						[
							name,
							Rec.fromEntries(Arr.map(fields, (f) => [f, names.columnIdent({ name }, f)] as const))
						] as const
				)
			),
			primaryKeys: Rec.fromEntries(
				Arr.map(spec.base.relations, (r) => [r.name, names.primaryKeyLaw(r)] as const)
			),
			laws,
			uniqueIndexes: Rec.fromEntries(
				Arr.flatMap(spec.base.laws, (law, i): ReadonlyArray<readonly [string, ConstraintName]> => {
					const ids = laws[i]
					return atMostOne(law) && ids?.kind === "capacity"
						? [[ids.law, names.constraintOf(ids.law, "PartialUnique")]]
						: []
				})
			),
			roles: Rec.fromEntries(Arr.map(spec.roles, (r) => [r.name, roleOf(r.name)] as const)),
			logins: Rec.fromEntries(
				Arr.map(
					spec.logins,
					(l) =>
						[
							l.name,
							identifierOf(
								loginIdentity(
									installation.names.installation,
									parsedName(l.name),
									SourceLoc(`login ${l.name}`, [])
								)
							)
						] as const
				)
			),
			domains: Rec.fromEntries(
				Arr.flatMap(spec.base.relations, (r) => Arr.flatMap(r.fields, (f) => domainLaws(r, f)))
			)
		}
	})

/**
 * The names of `spec`'s installation under its declared schema name, from its compilation alone: no PostgreSQL. A
 * spec grizzle refuses to build is a defect of its generator here.
 */
export const installedNames = (spec: InstallSpec): InstalledNames =>
	Effect.runSync(
		Effect.orDie(
			Effect.flatMap(buildInstall(spec, spec.base.name), (built) =>
				namesOfBuilt(spec, built, { kind: "declared" })
			)
		)
	)
