import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { contractLaw, lawDescription } from "#compiler/analysis/theory/description.ts"
import { contractLawIdentity } from "#compiler/analysis/theory/theory.ts"
import { appendAll } from "#compiler/core/array.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import {
	censusOf,
	DeclaredNamespace,
	type Identity,
	identifierOf,
	identity,
	maxIdentifierBytes
} from "#compiler/core/identity.ts"
import type { Identifier, IdentityKind, LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import type { ConstraintLaws, IndexRequest, InstallationManifest } from "#compiler/ir/products.ts"

import {
	type ConstraintLaw,
	compileLaws,
	constraintLawMap,
	type LawModel
} from "#compiler/laws/model/model.ts"
import { addAdvanceFunctions } from "#compiler/physical/ddl/advance.ts"
import { addEnums, type ClosedTemplate } from "#compiler/physical/ddl/closed.ts"
import { InstallBuilder, type InstallSettings } from "#compiler/physical/ddl/context.ts"
import {
	addContextContractDomains,
	addContractDomains,
	addTextDomains,
	type ContextContract,
	contextContracts,
	planTextDomains,
	type TextColumnUse,
	type TextDomain
} from "#compiler/physical/ddl/domains.ts"
import { type InstallNames, installNames } from "#compiler/physical/ddl/names.ts"
import {
	addWorlds,
	type CheckedLogin,
	checkedRole,
	contextFieldsOf,
	type InstalledLogin,
	worldTextDomainUses
} from "#compiler/physical/ddl/roles.ts"
import { addTables } from "#compiler/physical/ddl/tables.ts"
import {
	type PlannedIndex,
	planIndexes,
	reverseRequests
} from "#compiler/physical/indexes/engine.ts"
import { commentsOf } from "#compiler/physical/install/comments.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { numericBoundStorage } from "#compiler/physical/numeric/bound.ts"
import { refinedConstantsExtension } from "#compiler/physical/refined/constants.ts"
import { spanStorage } from "#compiler/physical/span/storage.ts"
import { planStatistics, type StatisticsRequest } from "#compiler/physical/statistics/statistics.ts"
import { type Owned, ownedIdentities } from "#compiler/schema/own.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import type { TextRefinement } from "#compiler/text/refinement.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

/** The settings the installation runs under (`InstallSettings`: the owner a fresh-install script names, undefined for
 * a migration; the PostgreSQL schema; the vector extension's and btree_gist's schemas; the logins over the schema) and
 * the extensions it runs, in order. Index requests beyond the law-maintenance ones come from an extension's
 * contribution, as the workload's do (`workloadExtension`). */
export interface InstallOptions extends InstallSettings {
	readonly extensions: ReadonlyArray<InstallExtension>
}

/** The options of an installation of `owned` under its declared name's identity, owned.installation, with the vector
 * extension in vector_ext and btree_gist in public (the local cluster's), no login, and no extension beyond the
 * built-in ones, as `owner` names it. A caller that targets another schema, installs logins or adds extensions states
 * them over these. */
export const installOptions = (owned: Owned, owner: string | undefined): InstallOptions => ({
	owner,
	installation: owned.installation,
	vectorSchema: "vector_ext",
	extensionSchema: "public",
	logins: [],
	extensions: []
})

/** A law of the installation with its description, as an outcome names it (types/changeset Law); L, the laws it may be. */
export interface DescribedLaw<L extends LawId = LawId> {
	readonly law: L
	readonly described: Law
}

export interface Installation {
	readonly owned: Owned
	/** The checker's reading of the owned schema, the one the installation read. */
	readonly checked: CheckedSchema
	readonly laws: LawModel
	readonly settings: InstallSettings
	readonly names: InstallNames
	readonly manifest: InstallationManifest<SqlStatement>
	/** The install script: every object's DDL in install order, then the PUBLIC revokes, the logins' defaults and every
	 * installed object's COMMENT. */
	readonly statements: ReadonlyArray<SqlStatement>
	readonly closedTemplates: Readonly<Record<string, ClosedTemplate>>
	readonly textDomains: ReadonlyArray<TextDomain>
	readonly indexes: ReadonlyArray<PlannedIndex>
	/** The logins and their roles, in name order. */
	readonly worlds: ReadonlyArray<InstalledLogin>
	/** Every table constraint, unique index and domain constraint, with its owner and the law a violation of it reports:
	 * the law model's, the text domains', the context contracts', then each extension's. A reader that iterates them
	 * iterates this list. */
	readonly constraintLaws: ReadonlyArray<ConstraintLaw>
	/** Each owner's constraint, unique index and domain constraint names to the law a violation reports, built from
	 * constraintLaws. */
	readonly constraintToLaw: ConstraintLaws
	/** Every law of the theory with its description, in theory order: the identities a residual law's function and a
	 * write statement's refusal raise under. */
	readonly theoryLaws: ReadonlyArray<DescribedLaw<Identifier<"law">>>
	/** Every law a violation of the installation can report, by its LawId, as an outcome names it (types/changeset
	 * Law): the theory's laws, then each constraint's law, each described where it is built. */
	readonly described: ReadonlyMap<LawId, Law>
	/** Every identity the installation named an object by, ownership's, the law model's and the installer's, each as
	 * often as it was minted: the census its comments passed. */
	readonly identities: ReadonlyArray<Identity<IdentityKind>>
	/** What this installation leaves to other packages' extensions. */
	readonly deferred: {
		readonly residualLaws: ReadonlyArray<LawId>
		readonly derivedRelations: ReadonlyArray<string>
	}
}

/** A schema identifier the installation may create: a plain lowercase identifier, at most 63 bytes, outside pg_. */
const admittedSchema = (name: string): boolean => {
	if (name.length === 0 || name.length > maxIdentifierBytes || name.startsWith("pg_")) {
		return false
	}
	for (let i = 0; i < name.length; i++) {
		const ch = name.charAt(i)
		const lower = ch >= "a" && ch <= "z"
		if (!(lower || ch === "_" || (i > 0 && ch >= "0" && ch <= "9"))) {
			return false
		}
	}
	return true
}

/** The installation of an owned schema, under the policy it was owned under: the obligation graph of every native
 * object, each with its DDL, its reasons and its phase, in a deterministic install order; the manifest; the VALUES
 * templates of the closed relations; the planned indexes with their merged provenance; and the install script, its
 * statements as SQL trees, printed only where they are sent or drafted. It is pure: no database, no clock, no file.
 *
 * The steps follow the dependency order: the namespace and the refusal function every write statement that can refuse
 * raises through; the isolation default and guard; the enums, the structural text domains and the contract domains;
 * the tables with their identities; the tags, keys, CHECKs and references the law model specialized; the shape, width
 * and contract-endpoint CHECKs of every span column (`spanStorage`), which every installation carries because a span's
 * storage is never optional; the bound CHECK of every bare numeric column (`numericBoundStorage`), which every
 * installation carries because every numeric digit bound rests on it; the validation of every closed payload with a nontrivial refinement
 * (`refinedConstantsExtension`), which every installation carries because the compiler relies on a closed fact's
 * membership only once PostgreSQL has validated it; then the caller's extensions; then the law-maintenance and workload
 * indexes, deduplicated against the key indexes; then, in Publish, the worlds: the logins, their roles with their
 * schemas, views, grants and policies, the logins' defaults, and the PUBLIC revokes. An extension of btree_gist precedes
 * any span key or GiST index with a scalar component.
 *
 * A contribution's constraints join the constraint-to-law list after the law model's own and the text domains', and a
 * name already listed must report the law already listed for it. A residual law or derived relation that no extension
 * claims is reported in `deferred`: the natives are installed, and the caller decides whether the installation is
 * complete enough for its purpose (the alternatives DDL without its residual law is not a complete implementation).
 *
 * The script is one transaction run as the migration identity, the owner; on a fresh schema every table is empty, so
 * ordinary CREATE INDEX serves. */
export const compileInstallation = (
	owned: Owned,
	options: InstallOptions
): Result.Result<Installation, CompileError> =>
	Result.flatMap(compileLaws(owned), (model) => build(owned, model, options))

/** The settings of `options`, refused unless every schema identifier it names is one the installation may create, the
 * installed schema's being the naming door's, the extension schema lies outside the installed schema, which it outlives,
 * every login is over the installed schema, and the logins' and their roles' names convert apart: each one's
 * PostgreSQL role is `<schema>__<name>`, so they are one namespace of declared names (IdentifierCollision). */
const admittedSettings = (
	owned: Owned,
	options: InstallOptions
): Result.Result<InstallSettings, CompileError> => {
	const at = SourceLoc(`installation of schema ${owned.name}`, [])
	const settings: InstallSettings = {
		owner: options.owner,
		installation: options.installation,
		vectorSchema: options.vectorSchema,
		extensionSchema: options.extensionSchema,
		logins: options.logins
	}
	for (const [what, name] of [
		...(settings.owner === undefined ? [] : [["owner", settings.owner] as const]),
		["vector schema", settings.vectorSchema],
		["extension schema", settings.extensionSchema]
	] as const) {
		if (!admittedSchema(name)) {
			return Result.err(
				malformedDescription(
					at,
					`an admitted ${what} identifier; ${JSON.stringify(name)} is not one`
				)
			)
		}
	}
	if (settings.extensionSchema === identifierOf(settings.installation)) {
		return Result.err(
			malformedDescription(
				at,
				"an extension schema outside the installed schema, which outlives it"
			)
		)
	}
	const roles = new DeclaredNamespace(`schema ${owned.name}'s login and role`)
	for (const login of settings.logins) {
		if (login.base.fingerprint !== owned.fingerprint || login.base.name !== owned.name) {
			return Result.err(
				malformedDescription(
					login.loc,
					`a login over the installed schema ${owned.name}; login ${login.name} is over ${login.base.name}`
				)
			)
		}
		const named = [
			roles.declare(login.name, "login", login.loc),
			...login.roles.map((r) => roles.declare(r.name, "role", r.loc))
		]
		for (const n of named) {
			if (!n.ok) {
				return n
			}
		}
	}
	return Result.ok(settings)
}

/** Each structural text domain's constraint, reporting the domain's law (identity.patternLaw), as a contract's does;
 * the law model plans no text domain, so the installation that names them lists them. */
const textDomainConstraintLaws = (
	plans: ReadonlyArray<{ readonly domain: TextDomain; readonly refinement: TextRefinement }>
): ReadonlyArray<ConstraintLaw> =>
	plans.map(({ domain, refinement }) => ({
		kind: "domainConstraint",
		name: domain.constraint,
		owner: domain.name,
		law: identifierOf(identity.patternLaw(domain.named)),
		described: Object.freeze({
			kind: "pattern",
			source: refinement.source,
			flags: refinement.flags
		})
	}))

/** Each checked context contract's domain constraint, reporting its contract's law, as a base contract's does: one
 * contract is one law wherever its domain is installed. */
const contextContractConstraintLaws = (
	contracts: ReadonlyArray<ContextContract>
): ReadonlyArray<ConstraintLaw> =>
	contracts.flatMap((c) =>
		c.check.kind === "checked"
			? [
					{
						kind: "domainConstraint",
						name: c.check.ident,
						owner: c.owner,
						law: identifierOf(contractLawIdentity(c.name)),
						described: contractLaw(c.name)
					} as const
				]
			: []
	)

const build = (
	owned: Owned,
	model: LawModel,
	options: InstallOptions
): Result.Result<Installation, CompileError> =>
	Result.flatMap(admittedSettings(owned, options), (settings) =>
		catchRefusal(() => {
			/** The built-in span CHECKs and closed facts' validation, then each extension in the caller's order, each
			 * once: a caller that lists a built-in extension again adds nothing twice. */
			const extensions = new Set([
				spanStorage,
				numericBoundStorage,
				refinedConstantsExtension,
				...options.extensions
			])
			const roles = settings.logins.flatMap((l) => l.roles)
			/** The checker's reading of the schema, the law model's, whose relation handles its theory read: every extension
			 * and world of the installation reads it. */
			const checked = model.checked
			const extraUses: Array<TextColumnUse> = []
			for (const extension of extensions) {
				const uses = extension.textDomainUses(checked)
				if (!uses.ok) {
					throw new Refusal(uses.error)
				}
				appendAll(extraUses, uses.value)
			}
			const fields = contextFieldsOf(checked, roles)
			if (!fields.ok) {
				throw new Refusal(fields.error)
			}
			/** Each login's roles read against the installed schema, once: the worlds install them, and the text domains read
			 * their query entries' view columns, which type their own patterns as a derived relation's do. */
			const logins = settings.logins.map((login): CheckedLogin => ({
				login,
				roles: login.roles.map((role) => {
					const read = checkedRole(checked, settings.installation, role)
					if (!read.ok) {
						throw new Refusal(read.error)
					}
					return read.value
				})
			}))
			appendAll(
				extraUses,
				worldTextDomainUses(
					fields.value,
					logins.flatMap((l) => l.roles)
				)
			)
			const textPlans = planTextDomains(owned, model.theory, extraUses)
			/** The contracts the context fields of the installed roles name that the base does not declare: each gets
			 * its domain, which admission validates a claim against. */
			const claimContracts = contextContracts(owned, fields.value)
			if (!claimContracts.ok) {
				throw new Refusal(claimContracts.error)
			}
			const textDomains = textPlans.map((p) => p.domain)
			const names = installNames({
				owned,
				installation: settings.installation,
				vectorSchema: settings.vectorSchema,
				textDomains: new Set(textDomains.map((d) => d.digest))
			})
			const b = new InstallBuilder({ owned, checked, model, names, settings })
			const { templates, enums } = addEnums(b)
			const domains = [
				...addTextDomains(b, textPlans),
				...addContractDomains(b),
				...addContextContractDomains(b, claimContracts.value)
			]
			const { keyIndexes, tables, sequences } = addTables(b)
			const advance = addAdvanceFunctions(b)

			const claimedResiduals = new Set<LawId>()
			const claimedDerived = new Set<string>()
			const extensionRequests: Array<IndexRequest> = []
			const statisticsRequests: Array<StatisticsRequest> = []
			const constraintLaws: Array<ConstraintLaw> = [
				...model.constraints,
				...textDomainConstraintLaws(textPlans),
				...contextContractConstraintLaws(claimContracts.value)
			]
			for (const extension of extensions) {
				const contribution = extension.contribute(b)
				if (!contribution.ok) {
					throw new Refusal(contribution.error)
				}
				const c = contribution.value
				appendAll(extensionRequests, c.indexRequests)
				appendAll(statisticsRequests, c.statisticsRequests)
				for (const law of c.residualLaws) {
					claimedResiduals.add(law)
				}
				for (const d of c.derivedRelations) {
					claimedDerived.add(d)
				}
				appendAll(constraintLaws, c.constraintLaws)
			}
			/** Each owner and name is one entry: every object is named once, each under its own identity, and the census
			 * holds distinct identities to distinct identifiers. */
			const constraintToLaw = constraintLawMap(constraintLaws)
			const theoryLaws = model.theory.laws.map((law): DescribedLaw<Identifier<"law">> =>
				Object.freeze({ law: law.id, described: lawDescription(law) })
			)
			const described = new Map<LawId, Law>([
				...theoryLaws.map((l): readonly [LawId, Law] => [l.law, l.described]),
				...constraintLaws.map((c): readonly [LawId, Law] => [c.law, c.described])
			])

			const requests = [
				...reverseRequests(b),
				...model.residuals.flatMap((r) => r.indexes),
				...extensionRequests
			]
			const indexes = planIndexes(b, keyIndexes, requests)
			if (!indexes.ok) {
				throw new Refusal(indexes.error)
			}
			planStatistics(b, statisticsRequests)

			const worlds = addWorlds(b, advance, { tables, sequences, enums, domains }, logins)
			const identities = [...ownedIdentities(owned), ...model.identities, ...b.named()]
			const census = censusOf(identities)
			const ordered = b.graph.manifest({
				roleDefaults: worlds.roleDefaults,
				publicRevokes: worlds.publicRevokes
			})
			const created = ordered.objects.flatMap((o) => o.ddl)
			const comments = commentsOf(created, census)
			const manifest = { ...ordered, comments }
			const statements = [...created, ...worlds.publicRevokes, ...worlds.roleDefaults, ...comments]
			const derived = Object.values(owned.relations)
				.filter((r) => r.kind === "derived")
				.map((r) => r.name)
			return {
				owned,
				checked,
				laws: model,
				settings,
				names,
				manifest,
				statements,
				closedTemplates: templates,
				textDomains,
				indexes: indexes.value,
				worlds: worlds.worlds,
				constraintLaws,
				constraintToLaw,
				theoryLaws,
				described,
				identities,
				deferred: {
					residualLaws: model.residuals
						.map((r) => r.lawId)
						.filter((law) => !claimedResiduals.has(law)),
					derivedRelations: derived.filter((d) => !claimedDerived.has(d)).toSorted(compareStrings)
				}
			}
		})
	)
