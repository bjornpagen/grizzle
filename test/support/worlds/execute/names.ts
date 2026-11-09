import { Array as Arr, Effect, Record as Rec } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { everyProperty } from "#compiler/core/canonical.ts"
import { constantDigest } from "#compiler/core/fingerprint.ts"
import { conversionOf, identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { type Codebook, firstCodebook } from "#compiler/ir/codes.ts"
import { type ConstraintOwner, constraintLaw } from "#compiler/ir/products.ts"
import type { TextDomain } from "#compiler/physical/ddl/domains.ts"
import { loginIdentity, roleIdentity } from "#compiler/physical/ddl/names.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { Statement } from "#compiler/public/schema.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { namedRelation } from "#compiler/schema/relation.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import type { AlternativesBase } from "#compiler/types/schema/statements.ts"
import {
	type InstalledAt,
	installationNamesOf,
	installationWith,
	parsedName
} from "#test/support/kernel/naming.ts"
import { ownedInput } from "#test/support/policy.ts"
import { type Built, buildInstall } from "#test/support/worlds/execute/build.ts"
import { domainLawKey } from "#test/support/worlds/model/session/domains.ts"
import { roleContexts } from "#test/support/worlds/model/session/state.ts"
import type {
	ContextSpec,
	FieldSpec,
	InstallSpec,
	InstalledNames,
	LawIds,
	LawSpec,
	RelationSpec,
	HandleCodes
} from "#test/support/worlds/model/types.ts"

/** An installation's codes as the model reads them: each roster's handles by code, a hole's "". */
export const rosterCodesOf = (codes: Codebook): HandleCodes =>
	Rec.fromEntries(Arr.map([...codes.rosters], ([roster, codec]) => [roster, codec.names] as const))

/**
 * The names the compiler gives an installation, read from its compilation through the kernel's naming door
 * (kernel/naming.ts installationWith and installationNamesOf), never spelled: each relation's table and columns, each
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
		case "alternatives": {
			if (!isAlternatives(statement)) {
				return Effect.die(
					new Error(`the alternatives law of ${law.relation} built a ${statement.kind} statement`)
				)
			}
			const laws = names.alternativesOf(statement)
			return Effect.succeed({ kind: "alternatives", arms: laws.arms, reverse: laws.reverse })
		}
		case "key":
		case "spanKey":
		case "check":
		case "contained":
		case "covered":
			return Effect.succeed({ kind: law.kind, law: names.lawOf(statement) })
	}
}

/**
 * The PostgreSQL role an installation gives a role of a name over its top level, whether it holds one or not: a role it
 * dropped had this name, since the naming door mints it from the identity of its level's schema and the role's name
 * alone.
 */
export const installedRoleName = (installation: Installation, name: string): string =>
	identifierOf(
		roleIdentity(
			Arr.lastNonEmpty(installation.names.levels),
			parsedName(name),
			SourceLoc(`world ${name}`, [])
		)
	)

/**
 * The names of a fresh installation of `built` (the values of `spec`), installed under the schema `at` names: its
 * rosters' codes a first installation's, every handle in declared order.
 */
export const namesOfBuilt = (
	spec: InstallSpec,
	built: Built,
	at: InstalledAt
): Effect.Effect<InstalledNames> =>
	Effect.flatMap(Effect.orDie(fromEngine(ownedInput(built.base))), (owned) =>
		namesOfBuiltAt(spec, built, at, firstCodebook(rostersOf(owned)))
	)

/**
 * The names of the installation of `built` (the values of `spec`) with its logins, installed under the schema `at`
 * names with the roster codes `codes`, those the installed snapshot holds, holes and all (D17), which a roster's names
 * constant is named by.
 */
export const namesOfBuiltAt = (
	spec: InstallSpec,
	built: Built,
	at: InstalledAt,
	codes: Codebook
): Effect.Effect<InstalledNames> =>
	Effect.gen(function* () {
		const logins = yield* Effect.forEach(Rec.values(built.logins), (l) => {
			const desc = loginDescOf(l)
			return desc === undefined
				? Effect.die(new Error(`the login ${l.name} is no login(...) value`))
				: Effect.orDie(fromEngine(ownLogin(desc)))
		})
		const installation = yield* Effect.sync(() => installationWith(built.base, at, codes, logins))
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
		/** Whether the installation types a stored field's column by a text domain: a pattern every text matches has none. */
		const textTyped = (r: RelationSpec, f: RelationSpec["fields"][number]): boolean => {
			const table = names.tableIdent({ name: r.name })
			const column = names.columnIdent({ name: r.name }, f.name)
			return Arr.some(installation.textDomains, (d) =>
				Arr.some(d.uses, (u) => u.table === table && u.column === column)
			)
		}
		/**
		 * Each contract and refined-text field domain of the base's relations, by its key, with the law its DOMAIN's CHECK
		 * reports where PostgreSQL alone names it (constraintToLaw): a contract's from its declaration, a text's from the
		 * domain the installation types the field's column with, the law of the first field it types. A text whose pattern
		 * every text matches has no DOMAIN, and no law.
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
					if (!textTyped(r, f)) {
						return []
					}
					const typed = names.textDomain(
						namedRelation(built.relations[r.name], `relation ${r.name}`),
						f.name
					)
					const law = constraintLaw(
						installation.constraintToLaw,
						{ kind: "domain", name: typed.domain },
						typed.constraint
					)
					if (law === undefined) {
						throw new Error(
							`the text domain of the stored field ${r.name}.${f.name} reports no law`
						)
					}
					return [[domainLawKey(domain), law]]
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
		/**
		 * Each contract and refined-text field domain of a context the installation's roles read, by its key, with the law
		 * its DOMAIN's CHECK reports (constraintToLaw), which a hand-set claim the domain refuses meets wherever the context
		 * is read: a contract's domain is named by its definition; a text's is the structural domain the installation types
		 * the field with, a use at the context's and the field's conversions (physical/ddl/roles.ts worldTextDomainUses). A
		 * text whose pattern every text matches has no DOMAIN, and no law; a text domain only context fields carry types no
		 * stored field, so it states no law, and a claim it refuses meets a bare 23514.
		 */
		const claimDomainLaws = (
			c: ContextSpec,
			f: FieldSpec
		): ReadonlyArray<readonly [string, LawId]> => {
			const domain = f.domain
			const reported = (
				owner: Extract<ConstraintOwner, { readonly kind: "domain" }>,
				constraint: string
			): LawId => {
				const law = constraintLaw(installation.constraintToLaw, owner, constraint)
				if (law === undefined) {
					throw new Error(
						`the domain ${owner.name} of the context field ${c.name}.${f.name} reports no law`
					)
				}
				return law
			}
			switch (domain.kind) {
				case "contract": {
					const named = installation.names.contractNamed(parsedName(domain.name))
					return [
						[
							domainLawKey(domain),
							reported(
								{ kind: "domain", name: identifierOf(named) },
								identifierOf(identity.domainCheck(named))
							)
						]
					]
				}
				case "text": {
					const typed = Arr.dedupeWith(
						Arr.filter(installation.textDomains, (d) =>
							Arr.some(
								d.uses,
								(u) => u.table === conversionOf(c.name) && u.column === conversionOf(f.name)
							)
						),
						(a: TextDomain, b: TextDomain) => a.name === b.name
					)
					if (typed.length > 1) {
						throw new Error(
							`the context field ${c.name}.${f.name} is typed by ${typed.length} of the installation's text domains`
						)
					}
					return Arr.flatMap(typed, (d) => {
						const law = constraintLaw(
							installation.constraintToLaw,
							{ kind: "domain", name: d.name },
							d.constraint
						)
						return law === undefined ? [] : [[domainLawKey(domain), law] as const]
					})
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
		const read = new Set(Arr.flatMap(spec.roles, (r) => [...roleContexts(r)]))
		return {
			installation: installation.names.installation,
			schema,
			levels: mapNonEmpty(installation.names.levels, identifierOf),
			tables: Rec.fromEntries(
				Arr.map(stored, ([name]) => [name, installation.names.relation(name)] as const)
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
			rosterConstants: Rec.fromEntries(
				Arr.map(
					[...installation.names.codes.rosters],
					([roster, codec]) =>
						[
							roster,
							identifierOf(
								identity.rosterConstant(
									roster,
									constantDigest("roster-names", codec.names, everyProperty)
								)
							)
						] as const
				)
			),
			codes: rosterCodesOf(installation.names.codes),
			keys: Rec.fromEntries(
				Arr.map(
					[...installation.checked.relations.values()],
					(r) => [r.name, Arr.map(r.keyNames, (k) => Arr.map(k.fields, (f) => f.name))] as const
				)
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
									Arr.lastNonEmpty(installation.names.levels),
									parsedName(l.name),
									SourceLoc(`login ${l.name}`, [])
								)
							)
						] as const
				)
			),
			domains: Rec.fromEntries([
				...Arr.flatMap(
					Arr.filter(spec.base.contexts, (c) => read.has(c.name)),
					(c: ContextSpec) => Arr.flatMap(c.fields, (f) => claimDomainLaws(c, f))
				),
				...Arr.flatMap(spec.base.relations, (r) => Arr.flatMap(r.fields, (f) => domainLaws(r, f)))
			]),
			patterns: Rec.fromEntries(
				Arr.map(
					spec.base.relations,
					(r) =>
						[
							r.name,
							Rec.fromEntries(
								Arr.flatMap(r.fields, (f) =>
									f.domain.kind === "text" && textTyped(r, f)
										? [
												[
													f.name,
													names.patternLaw(
														namedRelation(built.relations[r.name], `relation ${r.name}`),
														f.name
													)
												] as const
											]
										: []
								)
							)
						] as const
				)
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
