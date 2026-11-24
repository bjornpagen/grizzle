import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	sortNonEmpty
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { closedTableOf, derivedAnalysis } from "#compiler/analysis/schema.ts"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { contractLaw, lawDescription } from "#compiler/analysis/theory/description.ts"
import { contractLawIdentity } from "#compiler/analysis/theory/theory.ts"
import { catchRefusal, metFirst, settled, unwrap } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	type DeclaredName,
	type Identity,
	identifierOf,
	identity,
	type ParamPlace,
	paramPlaceText
} from "#compiler/core/identity.ts"
import type { Identifier, LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { FunctionTypeDesc } from "#compiler/ir/desc.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import type { ClosedTheoryRelation, TableRelation } from "#compiler/ir/law.ts"
import { installedSpellings } from "#compiler/ir/pattern.ts"
import type { LibraryFn } from "#compiler/ir/physical.ts"
import type { ConstraintLaws } from "#compiler/ir/products.ts"
import { patternsText, type RegexRef, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	type ConstraintLaw,
	type ConstraintLawOf,
	type CycleSource,
	compileLaws,
	conservativeLaws,
	constraintLawMap,
	type DomainUse,
	type LawModel
} from "#compiler/laws/model/model.ts"
import { theoryViolations } from "#compiler/laws/model/violations.ts"
import {
	type ClosedNames,
	type ClosedPlan,
	closedNames,
	persistentExprs,
	planClosed,
	qualifiedClosed
} from "#compiler/physical/ddl/constants.ts"
import type { InstallSettings } from "#compiler/physical/ddl/context.ts"
import {
	contractDigest,
	type FieldPatternLaw,
	fieldPatternLaws,
	type InstalledParams,
	noServedTypes,
	type OutsideContract,
	type OutsideContracts,
	outsideContracts,
	paramContractsDefined,
	type ParamDomainUse,
	type ServedTypes,
	patternLawId,
	dagObjects,
	type ParamContract,
	planTextDomains,
	structuralRegex,
	type TextColumnUse,
	type TextDomain,
	type TextDomainNames,
	paramDomainIdentity,
	textDomainIdentity,
	textDomainNames,
	type TextDomainPlan,
	typeContracts,
	typeRefinements
} from "#compiler/physical/ddl/domains.ts"
import { libraryCalls } from "#compiler/physical/ddl/library.ts"
import {
	type ContractSource,
	type InstallNames,
	installNames,
	namedRole,
	selectionKeysOf,
	uninstalled
} from "#compiler/physical/ddl/names.ts"
import {
	type CheckedLogin,
	checkedRole,
	contextFieldsOf,
	worldTextDomainUses
} from "#compiler/physical/ddl/roles.ts"
import {
	type SpanColumn,
	spanColumns,
	spanConstraintLaws
} from "#compiler/physical/span/storage.ts"
import { recordedLaw } from "#compiler/runtime/law-entry.ts"
import { constraintLawsOf } from "#compiler/runtime/write/laws.ts"
import { type DeclaredEntries, derivedStatement } from "#compiler/schema/declared-entries.ts"
import { installationsOf, type Owned } from "#compiler/schema/own.ts"
import type { Slice } from "#compiler/schema/reach.ts"
import type { AboveLaw, RecordedLaw } from "#compiler/types/changeset/changeset.ts"

/**
 * What an installation's plan is compiled over (planInstallation): the owned schema's law model (compileLaws) for a
 * slice, which reads the schema alone, the installation's codes, each closed relation's constants as readers address
 * them under those codes (physical/ddl/constants.ts NamedClosed), and the text domains it holds (physical/ddl/domains.ts
 * TextDomainNames), which name a refined text's domain whatever the slice reads. A login's runtime compiles its law
 * model for its roles' writes alone (schema/reach.ts loginSlice) and reads the constants' and the text domains' names
 * from its snapshot, which recorded the installation's whole set when it was generated (planBasis); generate, check and
 * every installation compile it over every relation (everySlice), plan the foreign key cycles from every law, plan the
 * constants from the closed relations' rows and the text domains from every artifact of the model
 * (declaredTextDomains), to which a plan adds its worlds' and its served programs' (installBasis).
 */
export interface PlanBasis {
	readonly owned: Owned
	readonly model: LawModel
	readonly codes: Codebook
	readonly closed: ClosedNames
	readonly textDomains: TextDomainNames
	/** The library functions it installs: a Db's, as its snapshot records them; a fresh basis's, its own artifacts'. */
	readonly library: ReadonlyArray<LibraryFn>
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
	Result.flatMap(compileLaws(owned, slice, { kind: "planned" }), (model) => basisOf(model, codes))

/** The basis of the law oracle's conservative installation of `owned` (install/compile.ts conservativeInstallation):
 * installBasis's, over the law model that discharges every rule over a query by its triggers (conservativeLaws). */
export const conservativeBasis = (
	owned: Owned,
	codes: Codebook,
	slice: Slice
): Result.Result<InstallBasis, CompileError> =>
	Result.flatMap(conservativeLaws(owned, slice), (model) => basisOf(model, codes))

/** The closed relations of a law model's theory, in its order. */
const closedRelationsOf = (model: LawModel): ReadonlyArray<ClosedTheoryRelation> =>
	Object.values(model.theory.relations).filter(
		(r): r is ClosedTheoryRelation => r.kind === "closed"
	)

/**
 * The objects an installation's own artifacts need beyond its stored fields' (artifactObjects): the columns outside the
 * stored relations a pattern types, the structural text refinements its artifacts type a value by where no column is,
 * the contracts they type a value by that no stored field of the base declares, and the library functions they call.
 */
interface ArtifactObjects {
	readonly columns: ReadonlyArray<TextColumnUse>
	readonly texts: ReadonlyArray<RegexRef>
	readonly contracts: ReadonlyArray<ParamContract>
	readonly library: ReadonlyArray<LibraryFn>
}

/** Each law model's ArtifactObjects, collected once whatever plans read it. */
const modelObjects = new WeakMap<LawModel, ArtifactObjects>()

/**
 * The objects an installation's own artifacts over `model` need beyond its stored fields', each of which it installs
 * (planTextDomains, outsideContracts, physical/ddl/library.ts addLibrary), one reachability walk for every kind of
 * object: `columns`, every stored derived
 * relation's column a pattern types, which its definition casts to that pattern's domain (a literal or a min of
 * refined text keeps its pattern); and, where no column is, the text refinements (`texts`, typeRefinements: a value's
 * own refinement, never a contract's base, whose pattern its contract's domain carries) and the contracts
 * (`contracts`, down each contract's chain) of a stored field's type; of each type of a persistent expression (physical/ddl/constants.ts
 * persistentExprs), a generated field's, a CHECK's, a law column's, a contract predicate's, a cast's target among them;
 * of every value a materialized definition's checked DAG types, and every one a law's checked violation query does
 * (laws/model/violations.ts theoryViolations), which the judge of a rule and the migration's probe of a law lower, a
 * live derived relation's computed text a rule reads through its definition and the common type a containment relabels
 * its sides to among them; and of each field of a declared function's result, which every read of the function's value
 * or rows casts to (lower/conservative/call calledRows, declaredCall), the one check PostgreSQL makes of what its body
 * returned, since the function's row type holds the field at its base (ir/physical.ts rowTypeOf); and `library`, each
 * library function a persistent expression or a key image calls (physical/ddl/library.ts libraryCalls) and each one a
 * materialized definition's or a law's checked DAG calls, a law's check over a derived relation calling Xml.isPattern
 * among them. So no refinement, contract or library function any of them needs requires a stored field, a check or a
 * contract to name it. Collected once per model (`modelObjects`).
 */
const artifactObjects = (model: LawModel): ArtifactObjects => {
	const known = modelObjects.get(model)
	if (known !== undefined) {
		return known
	}
	const { checked, owned, theory } = model
	const derived = derivedAnalysis(checked).order
	const columns = derived.flatMap((a) =>
		a.heading.flatMap((c): ReadonlyArray<TextColumnUse> => {
			const regex = structuralRegex(c.type)
			return regex === undefined
				? []
				: [{ regex, table: a.ident, column: identifierOf(identity.column(c.name)) }]
		})
	)
	const returned = (t: FunctionTypeDesc, loc: SourceLoc): ReadonlyArray<ScalarType> => {
		switch (t.kind) {
			case "value":
				return [checked.fieldType(t.type, loc)]
			case "rows":
			case "row":
				return t.heading.flatMap((f) => returned(f.type, loc))
		}
	}
	const persistent = SourceLoc(`the persistent expressions of schema ${owned.name}`, [])
	const persistentTerms = exprClosure(persistentExprs(model))
	const fieldTypes = Object.values(theory.relations).flatMap((r) =>
		r.fields.map((c) => ({ type: c.type, loc: persistent }))
	)
	const returnTypes = Object.values(owned.functions).flatMap((fn) =>
		returned(fn.desc.returns, fn.desc.loc).map((type) => ({ type, loc: fn.desc.loc }))
	)
	const typed: ReadonlyArray<{ readonly type: ScalarType; readonly loc: SourceLoc }> = [
		...fieldTypes,
		...persistentTerms.map((e) => ({ type: e.type, loc: persistent })),
		...returnTypes
	]
	/**
	 * The types whose text refinements the installation's own statements name: its stored fields', its declared
	 * functions' results', and each persistent expression's cast target, the one term whose SQL names a type's domain
	 * (lower/conservative/expr cast and domainCast, physical/ddl/expr.ts castType); a persistent term of a refined type
	 * that is no cast, a domain CHECK's VALUE among them, is read at its own type's base and names no domain.
	 */
	const textTyped = [
		...fieldTypes,
		...persistentTerms.flatMap((e) =>
			e.kind === "cast" || e.kind === "domainCast" ? [{ type: e.type, loc: persistent }] : []
		),
		...returnTypes
	]
	const lawsLoc = SourceLoc(`the laws of schema ${owned.name}`, [])
	const violations = unwrap(theoryViolations(checked, theory))
	/**
	 * The violation queries the installation and its migrations lower, each law's whose check a statement runs: a
	 * migration-discharged law's, which a migration's Validate file probes, and a rule over a query's, which its judge
	 * reads (deploy/snapshot/violation.ts lawChecks). Every other law is discharged by native objects, its violation
	 * query lowered nowhere, so no type of it is named by any statement.
	 */
	const lowered = [...model.migrationLaws, ...model.rules.map((r) => r.law.id)].map((law) =>
		defined(violations.forbids.get(law), `the violation query of law ${law}`)
	)
	const held = [
		...derived.map((a) => dagObjects(a.loc, [], a.query.dag.roots)),
		dagObjects(lawsLoc, [], lowered)
	]
	const own: ArtifactObjects = {
		columns,
		texts: [...textTyped.flatMap((t) => typeRefinements(t.type)), ...held.flatMap((h) => h.texts)],
		contracts: [
			...typed.flatMap((t) => typeContracts(t.type, t.loc)),
			...held.flatMap((h) => h.contracts)
		],
		library: distinctLibrary([
			...closedLibrary(owned),
			...libraryCalls(model),
			...held.flatMap((h) => h.library),
			...dagObjects(lawsLoc, [], violations.dag.roots).library
		])
	}
	modelObjects.set(model, own)
	return own
}

/**
 * The library functions an installation's closed relations need: closedRow, the reader of a closed relation's row of a
 * prefix (physical/ddl/library.ts, sql/constants.ts completions), wherever the schema declares a closed relation, so
 * every C.row any expression, artifact or served program, reads finds it installed beside the constants it reads.
 */
const closedLibrary = (owned: Owned): ReadonlyArray<LibraryFn> =>
	Object.values(owned.relations).some((r) => r.kind === "closedRelation") ? ["closedRow"] : []

/** Library functions `fns`, each once, in name order: the order an installation installs and records them in. */
const distinctLibrary = (fns: ReadonlyArray<LibraryFn>): ReadonlyArray<LibraryFn> =>
	[...new Set(fns)].toSorted(compareStrings)

/**
 * The text domains of a law model's own artifacts (artifactObjects): its stored fields', its views' and the rest its
 * persistent expressions, derived definitions, laws and declared functions type a value by, without a served program's
 * or a world's, which an installation's plan adds (planInstallation).
 */
const declaredTextDomains = (model: LawModel): TextDomainNames => {
	const own = artifactObjects(model)
	return textDomainNames(planTextDomains(model.owned, model.theory, own.columns, own.texts))
}

/**
 * The basis of the installations of a law model's owned schema under `codes`, over the model `model`: installBasis's
 * over the model it compiles, and a built schema's artifacts' over the one model its schema value holds
 * (program/schema.ts builtLawModel).
 */
export const basisOf = (
	model: LawModel,
	codes: Codebook
): Result.Result<InstallBasis, CompileError> =>
	metFirst(
		model.unrepresentable,
		catchRefusal((): InstallBasis => {
			const { owned } = model
			const planned = planClosed(owned, closedRelationsOf(model), codes)
			return {
				owned,
				model,
				codes,
				closed: closedNames(planned),
				textDomains: declaredTextDomains(model),
				library: artifactObjects(model).library,
				planned
			}
		})
	)

/** The plan's basis of an installation of `owned` under its codes `codes`, its law model for `slice` under `cycles`,
 * each closed relation's constants named as `closed` records them and its text domains as `textDomains` does: a Db's,
 * from its snapshot, which packs no cell and types no field its slice does not read. Its compile ends here, so every
 * unrepresentable key its model met is refused here, all at once (core/canonical.ts settled). */
export const planBasis = (
	owned: Owned,
	codes: Codebook,
	slice: Slice,
	closed: ClosedNames,
	textDomains: TextDomainNames,
	library: ReadonlyArray<LibraryFn>,
	cycles: CycleSource
): Result.Result<PlanBasis, CompileError> =>
	Result.flatMap(compileLaws(owned, slice, cycles), (model) =>
		settled(model.unrepresentable, Result.ok({ owned, model, codes, closed, textDomains, library }))
	)

/**
 * A law with its description, as grizzle's artifacts record it (types/changeset RecordedLaw), which an outcome names with
 * its entry (runtime/law-entry.ts namedLaw); L, the laws it may be, and D, the description's: a law of the
 * installation's own levels, or, where a Db over a lower level names one, a law of a level above it (AboveLaw).
 */
export interface DescribedLaw<
	L extends LawId = LawId,
	D extends RecordedLaw | AboveLaw<RecordedLaw> = RecordedLaw
> {
	readonly law: L
	readonly described: D
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
	/** The library functions the installation installs, those its artifacts and its served programs call
	 * (artifactObjects, ServedTypes `library`), with those a snapshot records, in name order. */
	readonly library: ReadonlyArray<LibraryFn>
	/** Each structural text domain, planned (planTextDomains). */
	readonly textPlans: ReadonlyArray<TextDomainPlan>
	/** The contracts the base does not declare that the context fields of the installed roles name, or the served
	 * workload's parameters are typed by (physical/ddl/domains.ts outsideContracts): each gets its domain, which
	 * admission validates a claim against and every placeholder of such a parameter is cast to. */
	readonly outsideContracts: OutsideContracts
	/** Each pattern parameter's own pattern domain the installation installs for the programs it serves, each identity
	 * once (ParamSource `planned`): none where its parameter types are recorded, since such a plan installs nothing. */
	readonly paramDomains: ReadonlyArray<ParamDomainUse>
	/** The parameter types the installation installs, in installed terms (physical/ddl/domains.ts InstalledParams):
	 * what snapshot.json records, and what a served compile under it casts parameters to (ParamSource `recorded`). */
	readonly installedParams: InstalledParams
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
	readonly described: ReadonlyMap<LawId, RecordedLaw>
}

/** Canonical use order, a domain's columns' order: table identifier, then column identifier. */
const canonicalUse = (a: DomainUse, b: DomainUse): number =>
	compareStrings(a.table, b.table) || compareStrings(a.column, b.column)

/**
 * Each structural text domain's constraint, with each stored field's column it types and that field's law
 * (fieldPatternLaws), described as its field spells its pattern and identified by patternLawId, which a violation on
 * that column reports, in canonical use order (table identifier, then column identifier). The
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
							law: patternLawId(domain.named, { relation, field }),
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
		return [
			{
				kind: "domainConstraint",
				name: domain.constraint,
				owner: domain.name,
				uses: sortNonEmpty(uses, canonicalUse)
			}
		]
	})
}

/** The contracts a value of `t` is checked under, outermost first: its contract and every contract its base chain
 * names. */
export const contractChain = (t: ScalarType): ReadonlyArray<DeclaredName> => {
	const { contract } = t
	return contract === undefined ? [] : [contract.name, ...contractChain(contract.base)]
}

/** A contract's law with its description, as its domain's constraint reports it, with the entry its author declares
 * (`declared`, Owned declared's `contracts`), where one does. */
const describedContract =
	(declared: DeclaredEntries["contracts"]) =>
	(contract: DeclaredName): ConstraintLawOf => ({
		law: identifierOf(contractLawIdentity(contract)),
		described: recordedLaw(contractLaw(contract), declared.get(contract) ?? derivedStatement)
	})

/**
 * Each checked contract domain's constraint, of the contracts `checked` whose domains have a CHECK, a base contract's,
 * a context contract's and a served parameter's alike: each column of a stored relation the domain checks, down its
 * type's contract chain, with the law of the contract that column's chain names
 * it by, which a violation on that column reports, in canonical use order; or, for a domain no stored column types,
 * the laws of every contract whose definition it holds, in contract name order, since contracts of one definition
 * share one domain.
 */
const contractConstraintLaws = (
	names: InstallNames,
	checked: ReadonlyArray<DeclaredName>,
	relations: ReadonlyArray<TableRelation>,
	declared: DeclaredEntries["contracts"]
): ReadonlyArray<ConstraintLaw> => {
	const described = describedContract(declared)
	const byDomain = new Map<
		string,
		{
			readonly named: Identity<"contractDomain">
			readonly contracts: [DeclaredName, ...Array<DeclaredName>]
		}
	>()
	for (const contract of checked.toSorted(compareStrings)) {
		const named = names.contractNamed(contract)
		const known = byDomain.get(named.identifier)
		if (known === undefined) {
			byDomain.set(named.identifier, { named, contracts: [contract] })
		} else {
			known.contracts.push(contract)
		}
	}
	return [...byDomain.values()].map(({ named, contracts: sharing }): ConstraintLaw => {
		const uses: ReadonlyArray<DomainUse> = relations
			.flatMap((r) =>
				r.fields.flatMap((f) =>
					contractChain(f.type)
						.filter((contract) => names.contractNamed(contract).identifier === named.identifier)
						.map((contract): DomainUse => ({
							table: r.ident,
							column: f.column,
							law: described(contract)
						}))
				)
			)
			.toSorted(canonicalUse)
		const name = identifierOf(identity.domainCheck(named))
		const owner = identifierOf(named)
		return isNonEmpty(uses)
			? { kind: "domainConstraint", name, owner, uses }
			: {
					kind: "unstoredDomainConstraint",
					name,
					owner,
					laws: mapNonEmpty(sharing, described)
				}
	})
}

/**
 * Every contract the installation gives a domain by its definition, by declared name, with what its domain is defined
 * from: each base contract's law-model native, then each contract outside the base, a role's context field's or a
 * served parameter's.
 */
const contractSources = (
	model: LawModel,
	outside: OutsideContracts
): ReadonlyMap<DeclaredName, ContractSource> =>
	new Map([
		...model.natives.flatMap((n) =>
			n.namespace === "domain"
				? [[n.object.name, { base: n.object.base, check: n.object.check }] as const]
				: []
		),
		...[...outside.context, ...outside.params].map(
			(c: OutsideContract) => [c.name, { base: c.contract.base, check: c.check }] as const
		)
	])

/**
 * Where the types a plan's statements cast their parameters to come from (physical/ddl/domains.ts ServedTypes). One rule
 * holds wherever an installation stands behind the plan: the plan names a parameter's pattern domain or a contract's
 * domain outside the base exactly when that installation installs it, and refuses any other as UninstalledDomain where
 * the statement is compiled.
 *
 * - `planned`: the plan of an installation serving programs whose declarations are `types`, as generate plans the
 *   installation of its workload and the artifacts its served files compile over: it installs each contract they name
 *   and each pattern parameter's own domain, and names those alone.
 * - `recorded`: the installation a snapshot describes, which installs `installed`, as snapshot.json records it: a served
 *   compile under the snapshot names those alone.
 * - `unserved`: no installation stands behind the plan, as for a compile that serves nothing (a query lowered to be
 *   read, a test's compile over a schema): it installs no parameter type, names each pattern parameter's own domain by
 *   its place and pattern, and names no contract outside the base.
 */
export type ParamSource =
	| { readonly kind: "planned"; readonly types: ServedTypes }
	| { readonly kind: "recorded"; readonly installed: InstalledParams }
	| { readonly kind: "unserved" }

/** A plan no installation stands behind (ParamSource `unserved`). */
export const unserved: ParamSource = { kind: "unserved" }

/** The identifiers of the pattern domains of `uses`, in code point order. */
const domainIdentifiers = (uses: ReadonlyArray<ParamDomainUse>): ReadonlyArray<string> =>
	uses
		.map(({ place, regex }) => identifierOf(paramDomainIdentity(place, regex)))
		.toSorted(compareStrings)

/**
 * A parameter's pattern domain where the installation installs it, `installed` holding its identifier, and otherwise
 * UninstalledDomain: the naming of an installation's plan (ParamSource `planned` and `recorded`).
 */
const installedParamNamed = (
	installed: ReadonlyArray<string>
): ((place: ParamPlace, regex: RegexRef) => Identity<"paramDomain">) => {
	const held = new Set(installed)
	return (place, regex) => {
		const named = paramDomainIdentity(place, regex)
		return held.has(identifierOf(named))
			? named
			: uninstalled({
					kind: "param",
					param: paramPlaceText(place),
					pattern: patternsText(regex.patterns)
				})
	}
}

/**
 * A pattern's structural text domain where the installation installs it, `installed` holding its pattern's key, and
 * otherwise UninstalledDomain: the naming of an installation's plan (ParamSource `planned` and `recorded`), which holds
 * the domain of every refinement any artifact over it types a value by (artifactDomains, ServedTypes `texts`), so only
 * a statement no artifact of the installation's compiled, a program served from no workload of its, meets the refusal.
 */
const installedTextNamed = (
	installed: TextDomainNames
): ((regex: RegexRef) => Identity<"textDomain">) => {
	return (regex) => {
		const digest = installed.get(regex.key)
		return digest === undefined
			? uninstalled({ kind: "text", pattern: patternsText(regex.patterns) })
			: identity.textDomain(digest)
	}
}

/** `uses`, each pattern domain identity once, in their order. */
const distinctDomains = (uses: ReadonlyArray<ParamDomainUse>): ReadonlyArray<ParamDomainUse> => {
	const seen = new Set<string>()
	return uses.filter(({ place, regex }) => {
		const id = identifierOf(paramDomainIdentity(place, regex))
		if (seen.has(id)) {
			return false
		}
		seen.add(id)
		return true
	})
}

/**
 * The plan of the installation over a basis (installBasis, planBasis) under `settings`, which its caller admitted
 * (physical/install/compile.ts installationOver) or made fresh (freshPlanSettings), with the domains its own artifacts
 * type a value by (artifactDomains), its worlds' and the types its served programs name from `params` (ParamSource):
 * planned from the programs, each contract outside the base admitted beside the context fields' (outsideContracts)
 * and held to its name's one definition once the names are read (paramContractsDefined); or recorded by a snapshot's
 * installation, whose whole set of domains it names, so a statement naming a domain the installation lacks is refused
 * where it is compiled.
 */
export const planInstallation = (
	basis: PlanBasis,
	settings: PlanSettings,
	params: ParamSource
): Result.Result<InstallPlan, CompileError> =>
	catchRefusal((): InstallPlan => {
		const { owned, model, codes, closed } = basis
		const roles = settings.logins.flatMap((l) => l.roles)
		const checked = model.checked
		const planned = params.kind === "planned" ? params.types : noServedTypes
		const paramDomains = distinctDomains(planned.domains)
		const fields = unwrap(contextFieldsOf(checked, roles))
		const logins = settings.logins.map((login): CheckedLogin => ({
			login,
			roles: login.roles.map((role) => {
				return unwrap(
					Result.flatMap(namedRole(role, settings.levels), (named) => checkedRole(checked, named))
				)
			})
		}))
		/** A Db's plan names the domains and functions its snapshot records, the installation's whole set, so it collects
		 * none of its own artifacts' objects again. */
		const own: ArtifactObjects =
			params.kind === "recorded"
				? { columns: [], texts: [], contracts: [], library: [] }
				: artifactObjects(model)
		const textPlans = planTextDomains(
			owned,
			model.theory,
			[
				...own.columns,
				...worldTextDomainUses(
					fields,
					logins.flatMap((l) => l.roles)
				)
			],
			[...own.texts, ...fields.flatMap((f) => typeRefinements(f.type)), ...planned.texts]
		)
		const outside = unwrap(
			outsideContracts(owned, fields, [...planned.contracts, ...planned.typed, ...own.contracts])
		)
		const contracts = contractSources(model, outside)
		const library = distinctLibrary([...own.library, ...planned.library, ...basis.library])
		const recorded = params.kind === "recorded" ? params.installed.contracts : []
		const names = installNames({
			owned,
			levels: settings.levels,
			vectorSchema: settings.vectorSchema,
			textNamed:
				params.kind === "unserved"
					? textDomainIdentity
					: installedTextNamed(new Map([...textDomainNames(textPlans), ...basis.textDomains])),
			contracts,
			recordedContracts: new Map(recorded.map((c) => [c.name, c.digest] as const)),
			paramNamed:
				params.kind === "unserved"
					? paramDomainIdentity
					: installedParamNamed(
							params.kind === "recorded"
								? params.installed.domains
								: domainIdentifiers(paramDomains)
						),
			define: contractDigest,
			codes,
			spellings: installedSpellings(codes.spellings, [owned.relations, owned.statements]),
			closed: qualifiedClosed(identifierOf(headNonEmpty(settings.levels)), closed),
			closedRelations: new Map(closedRelationsOf(model).map((r) => [r.name, r] as const)),
			closedTable: closedTableOf(checked),
			selectionKeys: selectionKeysOf(model.natives),
			library
		})
		unwrap(paramContractsDefined(names, owned, outside.context, planned.contracts))
		const installedParams: InstalledParams =
			params.kind === "recorded"
				? params.installed
				: {
						domains: domainIdentifiers(paramDomains),
						contracts: outside.params.map((c) => ({
							name: c.name,
							digest: contractDigest(names, c.name, { base: c.contract.base, check: c.check }),
							checked: c.check.kind === "checked"
						}))
					}
		const stored = [...model.relations.values()].map((r) => r.relation)
		const spans = spanColumns(model)
		const constraintLaws: ReadonlyArray<ConstraintLaw> = [
			...model.constraints,
			...textDomainConstraintLaws(textPlans, fieldPatternLaws(model)),
			...contractConstraintLaws(
				names,
				[
					...[...contracts].flatMap(([name, source]) =>
						source.check.kind === "checked" ? [name] : []
					),
					...recorded.flatMap((c) => (c.checked ? [c.name] : []))
				],
				stored,
				model.owned.declared.contracts
			),
			...spanConstraintLaws(spans, model.owned.declared.contracts)
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
			library,
			textPlans,
			outsideContracts: outside,
			paramDomains,
			installedParams,
			logins,
			spans,
			constraintLaws,
			constraintToLaw: constraintLawMap(constraintLaws),
			theoryLaws,
			described: new Map<LawId, RecordedLaw>([
				...theoryLaws.map((l): readonly [LawId, RecordedLaw] => [l.law, l.described]),
				...constraintLaws.flatMap((c) =>
					constraintLawsOf(c).map((l): readonly [LawId, RecordedLaw] => [l.law, l.described])
				)
			])
		}
	})
