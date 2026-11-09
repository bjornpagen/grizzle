import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { contractLaw, lawDescription } from "#compiler/analysis/theory/description.ts"
import { contractLawIdentity } from "#compiler/analysis/theory/theory.ts"
import { appendAll } from "#compiler/core/array.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	type DeclaredName,
	type Identity,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import type { Identifier, LawId } from "#compiler/core/ids.ts"
import { headNonEmpty, isNonEmpty, mapNonEmpty, sortNonEmpty } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ClosedTheoryRelation, TableRelation } from "#compiler/ir/law.ts"
import type { ConstraintLaws } from "#compiler/ir/products.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	type ConstraintLaw,
	type ConstraintLawOf,
	type CycleSource,
	compileLaws,
	constraintLawMap,
	type DomainUse,
	type LawModel
} from "#compiler/laws/model/model.ts"
import {
	type ClosedNames,
	type ClosedPlan,
	closedNames,
	planClosed,
	qualifiedClosed
} from "#compiler/physical/ddl/constants.ts"
import type { InstallSettings } from "#compiler/physical/ddl/context.ts"
import {
	type ContextContract,
	contextContracts,
	contractDigest,
	type FieldPatternLaw,
	fieldPatternLaws,
	planTextDomains,
	storedTextDomains,
	type TextColumnUse,
	type TextDomain,
	type TextDomainNames,
	textDomainNames,
	type TextDomainPlan
} from "#compiler/physical/ddl/domains.ts"
import {
	type ContractSource,
	type InstallNames,
	installNames,
	selectionKeysOf
} from "#compiler/physical/ddl/names.ts"
import {
	type CheckedLogin,
	checkedRole,
	contextFieldsOf,
	worldTextDomainUses
} from "#compiler/physical/ddl/roles.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import {
	type SpanColumn,
	spanColumns,
	spanConstraintLaws
} from "#compiler/physical/span/storage.ts"
import { installationsOf, type Owned } from "#compiler/schema/own.ts"
import type { Slice } from "#compiler/schema/reach.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

/**
 * What an installation's plan is compiled over (planInstallation): the owned schema's law model (compileLaws) for a
 * slice, which reads the schema alone, the installation's codes, each closed relation's constants as readers address
 * them under those codes (physical/ddl/constants.ts NamedClosed), and the text domains its stored fields declare
 * (physical/ddl/domains.ts TextDomainNames), which name a refined text's domain whatever the slice reads. A login's
 * runtime compiles its law model for its roles' writes alone (schema/reach.ts loginSlice) and reads the constants' and
 * the text domains' names from its snapshot, which recorded them when the installation was generated (planBasis);
 * generate, check and every installation compile it over every relation (everySlice), plan the foreign key cycles from
 * every law, plan the constants from the closed relations' rows and the text domains from every stored field
 * (installBasis).
 */
export interface PlanBasis {
	readonly owned: Owned
	readonly model: LawModel
	readonly codes: Codebook
	readonly closed: ClosedNames
	readonly textDomains: TextDomainNames
}

/**
 * What every installation of an owned schema under one installation's codes is built over, whatever its settings and
 * extensions: its plan's basis, its closed relations' constants planned from their rows (physical/ddl/constants.ts
 * planClosed), each string of cells packed and named by its content's digest, and their names read off the planned
 * constants. A caller that installs one schema under several settings, generate's artifacts and then its draft,
 * compiles the basis once and installs over it each time.
 */
export interface InstallBasis extends PlanBasis {
	readonly planned: ClosedPlan
}

/** The basis of the installations of `owned` under the installation's codes `codes`, for `slice`, its law model's
 * foreign key cycles planned from every law (laws/model/model.ts CycleSource). */
export const installBasis = (
	owned: Owned,
	codes: Codebook,
	slice: Slice
): Result.Result<InstallBasis, CompileError> =>
	Result.flatMap(compileLaws(owned, slice, { kind: "planned" }), (model) =>
		catchRefusal((): InstallBasis => {
			const planned = planClosed(
				owned,
				Object.values(model.theory.relations).filter(
					(r): r is ClosedTheoryRelation => r.kind === "closed"
				),
				codes
			)
			return {
				owned,
				model,
				codes,
				closed: closedNames(planned),
				textDomains: storedTextDomains(owned, model.theory),
				planned
			}
		})
	)

/** The plan's basis of an installation of `owned` under its codes `codes`, its law model for `slice` under `cycles`,
 * each closed relation's constants named as `closed` records them and its text domains as `textDomains` does: a Db's,
 * from its snapshot, which packs no cell and types no field its slice does not read. */
export const planBasis = (
	owned: Owned,
	codes: Codebook,
	slice: Slice,
	closed: ClosedNames,
	textDomains: TextDomainNames,
	cycles: CycleSource
): Result.Result<PlanBasis, CompileError> =>
	Result.map(compileLaws(owned, slice, cycles), (model): PlanBasis => ({
		owned,
		model,
		codes,
		closed,
		textDomains
	}))

/** A law of the installation with its description, as an outcome names it (types/changeset Law); L, the laws it may be. */
export interface DescribedLaw<L extends LawId = LawId> {
	readonly law: L
	readonly described: Law
}

/** What an installation's plan reads of its settings (InstallSettings): each level's PostgreSQL schema, the vector
 * extension's schema, and the logins whose roles' views and context fields its text and contract domains type. The
 * owner and the extension schema are its DDL's alone (physical/install/compile.ts). */
export type PlanSettings = Pick<InstallSettings, "levels" | "vectorSchema" | "logins">

/** The plan settings of a fresh installation of `owned`: each level under its declared name's identity
 * (installationsOf), the vector extension in vector_ext, and no login. */
export const freshPlanSettings = (owned: Owned): PlanSettings => ({
	levels: installationsOf(owned),
	vectorSchema: "vector_ext",
	logins: []
})

/**
 * An installation's plan: everything its readers read of it and everything its DDL is built from, without the DDL. Its
 * names (physical/ddl/names.ts InstallNames), which every query, write and grant addresses; the structural text domains,
 * the context contracts, the logins' roles read against the schema and the span columns its DDL installs; and every
 * constraint the installation installs, unique index and domain constraint included, with the law a violation of it
 * reports, then the theory's laws described. A compilation reads the plan alone (program/schema.ts baseArtifacts); the
 * installation (physical/install/compile.ts installationOver) builds its objects from it.
 */
export interface InstallPlan {
	readonly owned: Owned
	/** The checker's reading of the owned schema, the law model's, whose relation handles its theory read. */
	readonly checked: CheckedSchema
	readonly laws: LawModel
	readonly names: InstallNames
	/** Each closed relation's constants as readers address them, the basis's: what the snapshot records. */
	readonly closed: ClosedNames
	/** Each structural text domain, planned (planTextDomains). */
	readonly textPlans: ReadonlyArray<TextDomainPlan>
	/** The contracts the context fields of the installed roles name that the base does not declare: each gets its
	 * domain, which admission validates a claim against. */
	readonly contextContracts: ReadonlyArray<ContextContract>
	/** Each login's roles read against the installed schema, once: the worlds install them, and the text domains read
	 * their query entries' view columns, which type their own patterns as a derived relation's do. */
	readonly logins: ReadonlyArray<CheckedLogin>
	/** Each span column of a stored relation with its endpoint CHECKs, named (physical/span/storage.ts). */
	readonly spans: ReadonlyArray<SpanColumn>
	/** Every table constraint, unique index and domain constraint, with its owner and the law a violation of it reports:
	 * the law model's, the text domains', the contract domains', then the span endpoint CHECKs'. A reader that iterates
	 * them iterates this list. */
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
}

/** Canonical use order, a domain's columns' order: table identifier, then column identifier. */
const canonicalUse = (a: DomainUse, b: DomainUse): number =>
	compareStrings(a.table, b.table) || compareStrings(a.column, b.column)

/**
 * Each structural text domain's constraint, with the law of every stored field it types (fieldPatternLaws), each
 * described as its field spells its pattern and identified by identity.patternLaw, and each field's column with that
 * law, which a violation on that column reports, in canonical use order (table identifier, then column identifier). The
 * law model plans no text domain, so the installation that names them lists them. A field's domain is the planned one
 * of its pattern's key (planTextDomains), which types its column: patterns of one membership share one, named by the
 * definition its CHECK spells, so a field whose pattern is spelled otherwise is that domain's too, and two keys of one
 * definition are one domain. A domain no stored field types (a view column's, a context field's, a closed payload's)
 * states no law and lists no constraint: PostgreSQL refuses a value there in a statement no write states, and no
 * outcome names it.
 */
const textDomainConstraintLaws = (
	plans: ReadonlyArray<TextDomainPlan>,
	fields: ReadonlyArray<FieldPatternLaw>
): ReadonlyArray<ConstraintLaw> => {
	const byDomain = new Map<
		string,
		{ readonly domain: TextDomain; readonly uses: Array<DomainUse> }
	>()
	for (const { key, domain } of plans) {
		const known = byDomain.get(domain.name) ?? { domain, uses: [] }
		for (const { relation, field, regex, law } of fields) {
			if (regex.key === key) {
				known.uses.push(
					Object.freeze({
						table: relation.ident,
						column: field.column,
						law: Object.freeze({
							law: identifierOf(identity.patternLaw(domain.named, relation.name, field.name)),
							described: law
						})
					})
				)
			}
		}
		byDomain.set(domain.name, known)
	}
	return [...byDomain.values()].flatMap(({ domain, uses }): ReadonlyArray<ConstraintLaw> => {
		if (!isNonEmpty(uses)) {
			return []
		}
		const ordered = sortNonEmpty(uses, canonicalUse)
		return [
			{
				kind: "domainConstraint",
				name: domain.constraint,
				owner: domain.name,
				laws: mapNonEmpty(ordered, (u) => u.law),
				uses: ordered
			}
		]
	})
}

/** The contracts a value of `t` is checked under, outermost first: its contract and every contract its base chain
 * names. */
const contractChain = (t: ScalarType): ReadonlyArray<DeclaredName> => {
	const contract = contractOf(t)
	return contract === undefined ? [] : [contract.name, ...contractChain(contract.base)]
}

/** A contract's law with its description, as its domain's constraint reports it. */
const describedContract = (contract: DeclaredName): ConstraintLawOf => ({
	law: identifierOf(contractLawIdentity(contract)),
	described: contractLaw(contract)
})

/**
 * Each checked contract domain's constraint, a base contract's and a context contract's alike: the laws of every
 * contract whose definition the domain holds, in contract name order, since contracts of one definition share one
 * domain, and each column of a stored relation the domain checks, down its type's contract chain, with the law
 * of the contract that column's chain names it by, which a violation on that column reports, in canonical use order.
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
		const laws = sharing.map(describedContract)
		if (!isNonEmpty(laws)) {
			return []
		}
		const uses = relations
			.flatMap((r) =>
				r.fields.flatMap((f) =>
					contractChain(f.type)
						.filter((contract) => names.contractNamed(contract).identifier === named.identifier)
						.map((contract): DomainUse => ({
							table: r.ident,
							column: f.column,
							law: describedContract(contract)
						}))
				)
			)
			.toSorted(canonicalUse)
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

/**
 * The plan of the installation over a basis (installBasis, planBasis) under `settings`, which its caller admitted
 * (physical/install/compile.ts installationOver) or made fresh (freshPlanSettings), with the text domain uses of
 * `extensions`, each once.
 */
export const planInstallation = (
	basis: PlanBasis,
	settings: PlanSettings,
	extensions: ReadonlyArray<InstallExtension>
): Result.Result<InstallPlan, CompileError> =>
	catchRefusal((): InstallPlan => {
		const { owned, model, codes, closed } = basis
		const roles = settings.logins.flatMap((l) => l.roles)
		const checked = model.checked
		const extraUses: Array<TextColumnUse> = []
		for (const extension of new Set(extensions)) {
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
		const logins = settings.logins.map((login): CheckedLogin => ({
			login,
			roles: login.roles.map((role) => {
				const read = checkedRole(checked, settings.levels, role)
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
		const claimContracts = contextContracts(owned, fields.value)
		if (!claimContracts.ok) {
			throw new Refusal(claimContracts.error)
		}
		const contracts = contractSources(model, claimContracts.value)
		const names = installNames({
			owned,
			levels: settings.levels,
			vectorSchema: settings.vectorSchema,
			textDomains: new Map([...textDomainNames(textPlans), ...basis.textDomains]),
			contracts,
			define: contractDigest,
			codes,
			closed: qualifiedClosed(identifierOf(headNonEmpty(settings.levels)), closed),
			selectionKeys: selectionKeysOf(model.natives)
		})
		const stored = [...model.relations.values()].map((r) => r.relation)
		const spans = spanColumns(model)
		const constraintLaws: ReadonlyArray<ConstraintLaw> = [
			...model.constraints.filter((c) => c.kind !== "domainConstraint"),
			...textDomainConstraintLaws(textPlans, fieldPatternLaws(model)),
			...contractConstraintLaws(names, contracts, stored),
			...spanConstraintLaws(spans)
		]
		const theoryLaws = model.theory.laws.map((law): DescribedLaw<Identifier<"law">> =>
			Object.freeze({ law: law.id, described: lawDescription(law) })
		)
		return {
			owned,
			checked,
			laws: model,
			names,
			closed,
			textPlans,
			contextContracts: claimContracts.value,
			logins,
			spans,
			constraintLaws,
			constraintToLaw: constraintLawMap(constraintLaws),
			theoryLaws,
			described: new Map<LawId, Law>([
				...theoryLaws.map((l): readonly [LawId, Law] => [l.law, l.described]),
				...constraintLaws.flatMap((c) =>
					c.laws.map((l): readonly [LawId, Law] => [l.law, l.described])
				)
			])
		}
	})
