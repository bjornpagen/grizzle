import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { contractLaw, lawDescription } from "#compiler/analysis/theory/description.ts"
import { contractLawIdentity } from "#compiler/analysis/theory/theory.ts"
import { appendAll } from "#compiler/core/array.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import {
	censusOf,
	type DeclaredName,
	DeclaredNamespace,
	type Identity,
	identifierOf,
	identity,
	maxIdentifierBytes
} from "#compiler/core/identity.ts"
import type { Identifier, IdentityKind, LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { type Codebook, firstCodebook } from "#compiler/ir/codes.ts"
import type { ClosedTheoryRelation, TableRelation } from "#compiler/ir/law.ts"
import type { ConstraintLaws, IndexRequest, InstallationManifest } from "#compiler/ir/products.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"

import {
	type ConstraintLaw,
	compileLaws,
	constraintLawMap,
	type LawModel
} from "#compiler/laws/model/model.ts"
import { addAdvanceFunctions } from "#compiler/physical/ddl/advance.ts"
import {
	addClosedRelations,
	addRosters,
	closedConstants,
	planClosed
} from "#compiler/physical/ddl/constants.ts"
import { InstallBuilder, type InstallSettings } from "#compiler/physical/ddl/context.ts"
import {
	addContextContractDomains,
	addContractDomains,
	addTextDomains,
	type ContextContract,
	contextContracts,
	contractDigest,
	planTextDomains,
	type TextColumnUse,
	type TextDomain
} from "#compiler/physical/ddl/domains.ts"
import {
	type ContractSource,
	type InstallNames,
	installNames
} from "#compiler/physical/ddl/names.ts"
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
import { refinedConstantsExtension } from "#compiler/physical/refined/constants.ts"
import { spanStorage } from "#compiler/physical/span/storage.ts"
import { planStatistics, type StatisticsRequest } from "#compiler/physical/statistics/statistics.ts"
import { type Owned, ownedIdentities, rostersOf } from "#compiler/schema/own.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import type { TextRefinement } from "#compiler/text/refinement.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

/** The settings the installation runs under (`InstallSettings`: the owner a fresh-install script names, undefined for
 * a migration; the PostgreSQL schema; the vector extension's and btree_gist's schemas; the logins over the schema), the
 * extensions it runs, in order, and the codes of the installation it compiles for. Index requests beyond the
 * law-maintenance ones come from an extension's contribution, as the workload's do (`workloadExtension`). */
export interface InstallOptions extends InstallSettings {
	readonly extensions: ReadonlyArray<InstallExtension>
	/** The installation's codes: every code a literal, a constant or a domain's CHECK holds, and every bit(n) width. */
	readonly codes: Codebook
}

/** The options of a fresh installation of `owned` under its declared name's identity, owned.installation, with the
 * vector extension in vector_ext and btree_gist in public (the local cluster's), no login, no extension beyond the
 * built-in ones, and the first codebook, each roster's handles numbered from 0 with no hole, as `owner` names it. A
 * caller that targets another schema, installs logins, adds extensions or compiles for an installation with a history
 * of codes states them over these. */
export const installOptions = (owned: Owned, owner: string | undefined): InstallOptions => ({
	owner,
	installation: owned.installation,
	vectorSchema: "vector_ext",
	extensionSchema: "public",
	logins: [],
	extensions: [],
	codes: firstCodebook(rostersOf(owned))
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
	/** Every law of the theory with its description, in theory order: the identities a write statement's refusal raises
	 * under. */
	readonly theoryLaws: ReadonlyArray<DescribedLaw<Identifier<"law">>>
	/** Every law a violation of the installation can report, by its LawId, as an outcome names it (types/changeset
	 * Law): the theory's laws, then each constraint's law, each described where it is built. */
	readonly described: ReadonlyMap<LawId, Law>
	/** Every identity the installation named an object by, ownership's, the law model's and the installer's, each as
	 * often as it was minted: the census its comments passed. */
	readonly identities: ReadonlyArray<Identity<IdentityKind>>
	/** What this installation leaves to other packages' extensions. */
	readonly deferred: {
		readonly derivedRelations: ReadonlyArray<string>
	}
}

/**
 * A schema identifier the installation may create: a plain lowercase identifier, at most maxIdentifierBytes, outside
 * pg_.
 */
const admittedSchema = (name: string): boolean => {
	if (name.length === 0 || name.length > maxIdentifierBytes.value || name.startsWith("pg_")) {
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

/** The installation of an owned schema, under the policy it was owned under, for the installation that holds
 * `options.codes`: the obligation graph of every native object, each with its DDL, its reasons and its phase, in a
 * deterministic install order; the manifest; the planned indexes with their merged provenance; and the install script,
 * its statements as SQL trees, printed only where they are sent or drafted. It is pure: no database, no clock, no file.
 *
 * The steps follow the dependency order: the namespace and the refusal function every write statement that can refuse
 * raises through; the isolation default and guard; each roster's names constant and domains and each closed
 * relation's constants (physical/ddl/constants.ts), the structural text domains and the contract domains;
 * the tables with their identities; the tags, keys, CHECKs and references the law model specialized; the shape, width
 * and contract-endpoint CHECKs of every span column (`spanStorage`), which every installation carries because a span's
 * storage is never optional; the validation of every closed payload with a nontrivial refinement
 * (`refinedConstantsExtension`), which every installation carries because the compiler relies on a closed fact's
 * membership only once PostgreSQL has validated it; then the caller's extensions; then the law-maintenance and workload
 * indexes, deduplicated against the key indexes; then, in Publish, the worlds: the logins, their roles with their
 * schemas, views, grants and policies, the logins' defaults, and the PUBLIC revokes. An extension of btree_gist precedes
 * any span key or GiST index with a scalar component.
 *
 * A contribution's constraints join the constraint-to-law list after the law model's own and the text domains', and a
 * name already listed must report the law already listed for it. A derived relation that no extension claims is
 * reported in `deferred`: the natives are installed, and the caller decides whether the installation is complete
 * enough for its purpose.
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
 * the law model plans no text domain, so the installation that names them lists them, a domain patterns of one
 * definition share once, with the first pattern's description. */
const textDomainConstraintLaws = (
	plans: ReadonlyArray<{ readonly domain: TextDomain; readonly refinement: TextRefinement }>
): ReadonlyArray<ConstraintLaw> =>
	plans
		.filter(({ domain }, i) => plans.findIndex((p) => p.domain.name === domain.name) === i)
		.map(({ domain, refinement }) => ({
			kind: "domainConstraint",
			name: domain.constraint,
			owner: domain.name,
			laws: [
				{
					law: identifierOf(identity.patternLaw(domain.named)),
					described: Object.freeze({
						kind: "pattern",
						source: refinement.source,
						flags: refinement.flags
					})
				}
			],
			uses: []
		}))

/** The contracts a value of `t` is checked under, outermost first: its contract and every contract its base chain
 * names. */
const contractChain = (t: ScalarType): ReadonlyArray<DeclaredName> => {
	const contract = contractOf(t)
	return contract === undefined ? [] : [contract.name, ...contractChain(contract.base)]
}

/**
 * Each checked contract domain's constraint, a base contract's and a context contract's alike: the laws of every
 * contract whose definition the domain holds, in contract name order, since contracts of one definition share one
 * domain (W6.Q10), and each column of a stored relation the domain checks, down its type's contract chain, with the law
 * of the contract that column's chain names it by, which a violation on that column reports.
 */
const contractConstraintLaws = (
	names: InstallNames,
	contracts: ReadonlyMap<DeclaredName, ContractSource>,
	relations: ReadonlyArray<TableRelation>
): ReadonlyArray<ConstraintLaw> => {
	const byDomain = new Map<
		string,
		{ named: Identity<"contractDomain">; contracts: Array<DeclaredName> }
	>()
	for (const [contract, source] of [...contracts].toSorted(([a], [b]) => compareStrings(a, b))) {
		if (source.check.kind !== "checked") {
			continue
		}
		const named = names.contractNamed(contract)
		const known = byDomain.get(named.identifier)
		if (known === undefined) {
			byDomain.set(named.identifier, { named, contracts: [contract] })
		} else {
			known.contracts.push(contract)
		}
	}
	return [...byDomain.values()].flatMap(({ named, contracts: sharing }) => {
		const laws = sharing.map((contract) => ({
			law: identifierOf(contractLawIdentity(contract)),
			described: contractLaw(contract)
		}))
		if (!isNonEmpty(laws)) {
			return []
		}
		const uses = relations.flatMap((r) =>
			r.fields.flatMap((f) =>
				contractChain(f.type)
					.filter((contract) => names.contractNamed(contract).identifier === named.identifier)
					.map((contract) => ({
						table: r.ident,
						column: f.column,
						law: identifierOf(contractLawIdentity(contract))
					}))
			)
		)
		return [
			{
				kind: "domainConstraint",
				name: identifierOf(identity.domainCheck(named)),
				owner: identifierOf(named),
				laws,
				uses
			} as const
		]
	})
}

/**
 * Every contract the installation gives a domain, by declared name, with what its domain is defined from: each base
 * contract's law-model native, then each context contract a role's context field names.
 */
const contractSources = (
	model: LawModel,
	context: ReadonlyArray<ContextContract>
): ReadonlyMap<DeclaredName, ContractSource> =>
	new Map([
		...model.natives.flatMap((n) =>
			n.namespace === "domain"
				? [[n.object.name, { base: n.object.base, check: n.object.check }] as const]
				: []
		),
		...context.map((c) => [c.name, { base: c.contract.base, check: c.check }] as const)
	])

const build = (
	owned: Owned,
	model: LawModel,
	options: InstallOptions
): Result.Result<Installation, CompileError> =>
	Result.flatMap(admittedSettings(owned, options), (settings) =>
		catchRefusal(() => {
			/** The built-in span CHECKs and closed facts' validation, then each extension in the caller's order, each
			 * once: a caller that lists a built-in extension again adds nothing twice. */
			const extensions = new Set([spanStorage, refinedConstantsExtension, ...options.extensions])
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
			const closed = planClosed(
				owned,
				Object.values(model.theory.relations).filter(
					(r): r is ClosedTheoryRelation => r.kind === "closed"
				),
				options.codes
			)
			const contracts = contractSources(model, claimContracts.value)
			const names = installNames({
				owned,
				installation: settings.installation,
				vectorSchema: settings.vectorSchema,
				textDomains: new Map(textPlans.map((p) => [p.key, p.domain.digest] as const)),
				contracts,
				define: contractDigest,
				codes: options.codes,
				closed: closedConstants(identifierOf(settings.installation), closed)
			})
			const b = new InstallBuilder({ owned, checked, model, names, settings })
			const rosters = addRosters(b)
			addClosedRelations(b, closed)
			const domains = [
				...rosters.flatMap((r) =>
					r.bits === undefined ? [r.domain.name] : [r.domain.name, r.bits.domain.name]
				),
				...addTextDomains(b, textPlans),
				...addContractDomains(b),
				...addContextContractDomains(b, claimContracts.value)
			]
			const { keyIndexes, tables, sequences } = addTables(b)
			const advance = addAdvanceFunctions(b)

			const claimedDerived = new Set<string>()
			const extensionRequests: Array<IndexRequest> = []
			const statisticsRequests: Array<StatisticsRequest> = []
			/** A contract's domain is named by its definition, which only the installation's names spell, so the
			 * installation lists every contract's domain constraint, as it lists the text domains'. */
			const constraintLaws: Array<ConstraintLaw> = [
				...model.constraints.filter((c) => c.kind !== "domainConstraint"),
				...textDomainConstraintLaws(textPlans),
				...contractConstraintLaws(
					names,
					contracts,
					[...model.relations.values()].map((r) => r.relation)
				)
			]
			for (const extension of extensions) {
				const contribution = extension.contribute(b)
				if (!contribution.ok) {
					throw new Refusal(contribution.error)
				}
				const c = contribution.value
				appendAll(extensionRequests, c.indexRequests)
				appendAll(statisticsRequests, c.statisticsRequests)
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
				...constraintLaws.flatMap((c) =>
					c.laws.map((l): readonly [LawId, Law] => [l.law, l.described])
				)
			])

			const requests = [...reverseRequests(b), ...extensionRequests]
			const indexes = planIndexes(b, keyIndexes, requests)
			if (!indexes.ok) {
				throw new Refusal(indexes.error)
			}
			planStatistics(b, statisticsRequests)

			const worlds = addWorlds(b, advance, { tables, sequences, domains }, logins)
			const identities = [...ownedIdentities(owned), ...model.identities, ...b.named()]
			const census = censusOf(identities)
			if (!census.ok) {
				throw new Refusal(census.error)
			}
			const ordered = b.graph.manifest({
				roleDefaults: worlds.roleDefaults,
				publicRevokes: worlds.publicRevokes
			})
			const created = ordered.objects.flatMap((o) => o.ddl)
			const comments = commentsOf(created, census.value)
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
				textDomains,
				indexes: indexes.value,
				worlds: worlds.worlds,
				constraintLaws,
				constraintToLaw,
				theoryLaws,
				described,
				identities,
				deferred: {
					derivedRelations: derived.filter((d) => !claimedDerived.has(d)).toSorted(compareStrings)
				}
			}
		})
	)
