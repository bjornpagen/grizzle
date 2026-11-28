import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	flatMapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import { catchRefusal, everyProperty, Refusal, unwrap } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { type DomainDigest, domainDigest } from "#compiler/core/fingerprint.ts"
import {
	conversionOf,
	type DeclaredName,
	DeclaredNamespace,
	type Identity,
	identifierOf,
	identity,
	type ParamPlace,
	paramPlaceText
} from "#compiler/core/identity.ts"
import type { ConstraintName, DomainName, Identifier } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { type ContractFieldDesc, descText, type FieldDesc } from "#compiler/ir/desc.ts"
import { exprClosure, predicateTree } from "#compiler/ir/expr.ts"
import type { DomainCheck, DomainCheckTerm, LawField, TableRelation } from "#compiler/ir/law.ts"
import {
	domainBase,
	type LibraryFn,
	missing,
	type PhysicalNames,
	qualifiedType,
	splitLibrary
} from "#compiler/ir/physical.ts"
import { type ParamDecl, type PhysicalReason, paramColumns } from "#compiler/ir/products.ts"
import { exprsOf, type HeadingColumn, type RelNode } from "#compiler/ir/rel.ts"
import {
	baseOf,
	type ContractInfo,
	type PlainType,
	patternsText,
	regexOf,
	type RegexRef,
	type ScalarType,
	type VariantInfo
} from "#compiler/ir/scalar.ts"
import { domainCheck, type LawModel } from "#compiler/laws/model/model.ts"
import { type InstallBuilder, isVectorRef } from "#compiler/physical/ddl/context.ts"
import { lowerPersistent } from "#compiler/physical/ddl/expr.ts"
import { calledLibrary } from "#compiler/physical/ddl/library.ts"
import type { ContractSource, InstallNames } from "#compiler/physical/ddl/names.ts"
import { enforcement, lawReasons, type Node } from "#compiler/physical/obligations/graph.ts"
import { fieldEntry } from "#compiler/schema/declared-entries.ts"
import { declareRelation, type Owned, type OwnedRelation } from "#compiler/schema/own.ts"
import {
	type Collation,
	type CreateDomain,
	type Expr,
	nameKey,
	type NameKey,
	type ObjectName,
	type TypeRef,
	type TypeSchema
} from "#compiler/sql/ast.ts"
import { and } from "#compiler/sql/build.ts"
import { Transform } from "#compiler/sql/transform.ts"
import { digestedHooks, digestedTypes } from "#compiler/sql/type-schemas.ts"
import { domainValue, membershipTerms, textDomainDefinition } from "#compiler/text/membership.ts"
import type { DeclaredEntry, StatedLaw } from "#compiler/types/changeset/changeset.ts"

/** The regex of a column that a structural text domain types: refined text outside any contract. */
export const structuralRegex = (t: ScalarType): RegexRef | undefined =>
	t.carrier === "text" && t.contract === undefined ? regexOf(t.text) : undefined

/** A domain columns are typed by: its name, the identity it was minted from, and its object, when the installation
 * creates one. */
export interface UsedType {
	readonly name: ObjectName
	readonly identity: Identity<
		| "contractDomain"
		| "textDomain"
		| "rosterDomain"
		| "bitsDomain"
		| "digestDomain"
		| "variantDomain"
	>
	readonly node: Node<"setup"> | undefined
}

/** The domains columns are typed by, by name; and whether one is a vector. */
export interface TypeUse {
	readonly domains: Map<NameKey, UsedType>
	vector: boolean
}

export const emptyUse = (): TypeUse => ({ domains: new Map(), vector: false })

/** The domains a column of type `t` names: a contract's and the domains its domain rests on (restingDomains), a text
 * refinement's, a closed id's roster domain, a set's bits domain and a digest's domain. A span column names none: it is
 * its range, a builtin, whatever contract its endpoints are of, so a role uses an endpoint contract only where a column
 * of its own is typed by the contract itself. */
const typeDomains = (b: InstallBuilder, t: ScalarType, use: TypeUse): void => {
	const { contract } = t
	if (contract !== undefined) {
		const name = b.names.contractDomain(contract.name)
		use.domains.set(nameKey(name), {
			name,
			identity: b.names.contractNamed(contract.name),
			node: b.typeNamed(name)
		})
		restingDomains(b, contract.base, use)
		return
	}
	carrierDomains(b, t, use)
	const regex = structuralRegex(t)
	if (regex !== undefined) {
		const name = b.names.textDomain(regex)
		use.domains.set(nameKey(name), {
			name,
			identity: b.names.textNamed(regex),
			node: b.typeNamed(name)
		})
	}
}

/**
 * The domains a contract's domain rests on, as its base is installed (ir/physical.ts domainBase): an inner contract's,
 * down its own chain, or its base carrier's own domain, a closed id's roster domain, a set's bits domain or the digest
 * domain; never a refinement's text domain, whose pattern the contract's own CHECK carries over `text`, nor a span's
 * endpoints', which its range holds as a builtin. A domain no column rests on is named by nothing of a role's.
 */
const restingDomains = (b: InstallBuilder, base: ScalarType, use: TypeUse): void => {
	if (base.contract === undefined) {
		carrierDomains(b, base, use)
		return
	}
	typeDomains(b, base, use)
}

/**
 * The domain a value of `t`'s carrier is held by: a closed id's roster domain, a set's bits domain, a digest's domain,
 * a variant's domain with every domain an arm's field is held by, which its CHECK casts each present field to
 * (physical/ddl/variants.ts judged); and a vector's extension. Never a variant's tag's roster domain: the CHECK reads the
 * tag as the smallint its composite holds, against literal codes, and calls no constant of the roster, so a writer of a
 * variant column whose roster no column of its own types reads nothing of the roster (PostgreSQL 19.0, 2026-11-26: such
 * a writer's served insert of each arm is accepted with EXECUTE on the roster's live constant revoked), where it was
 * granted EXECUTE on that constant, which the installed-catalog checker refused as excess.
 */
const carrierDomains = (b: InstallBuilder, t: PlainType, use: TypeUse): void => {
	if (t.carrier === "code") {
		const name = b.names.rosterDomain(t.roster.closed)
		use.domains.set(nameKey(name), {
			name,
			identity: b.names.rosterNamed(t.roster.closed),
			node: b.typeNamed(name)
		})
	}
	if (t.carrier === "bits") {
		const name = b.names.bitsDomain(t.roster.closed)
		use.domains.set(nameKey(name), {
			name,
			identity: b.names.bitsNamed(t.roster.closed),
			node: b.typeNamed(name)
		})
	}
	if (t.carrier === "sha256") {
		const name = b.names.digestDomain
		use.domains.set(nameKey(name), {
			name,
			identity: identity.digestDomain(),
			node: b.digestDomain
		})
	}
	if (t.carrier === "vector") {
		use.vector = true
	}
	if (t.carrier === "variant") {
		const name = b.names.variantDomain(t.variant.name)
		use.domains.set(nameKey(name), {
			name,
			identity: identity.variantDomain(t.variant.name),
			node: b.typeNamed(name)
		})
		for (const arm of t.variant.arms) {
			for (const f of arm.fields) {
				typeDomains(b, f.type, use)
			}
		}
	}
}

/** The types of every column of `heading`. */
export const columnDomains = (
	b: InstallBuilder,
	heading: ReadonlyArray<HeadingColumn>,
	use: TypeUse
): void => {
	for (const c of heading) {
		typeDomains(b, c.type, use)
	}
}

/** The objects of the domains `use` holds, each the installation creates. */
export const usedNodes = (use: TypeUse): ReadonlyArray<Node<"setup">> =>
	[...use.domains.values()].flatMap((t) => (t.node === undefined ? [] : [t.node]))

/** A pattern law as grizzle's artifacts record it: with the entry its field's type declares, where it declares one. */
type RecordedPattern =
	| Extract<StatedLaw, { readonly kind: "pattern" }>
	| (Extract<StatedLaw, { readonly kind: "pattern" }> & { readonly entry: DeclaredEntry })

/** A stored field whose patterns state a law: its relation, the field, its refinement, and the law, spelled as the
 * field declares its patterns, with the catalog entry its type declares, the type's one at every field it types. */
export interface FieldPatternLaw {
	readonly relation: TableRelation
	readonly field: LawField
	readonly regex: RegexRef
	readonly law: RecordedPattern
}

/**
 * The pattern laws of a schema's law model: one per field of a stored relation that a structural text domain types
 * (structuralRegex), by relation name, each relation's fields in declared order. A tautology erases (text/refinement.ts),
 * a contract's pattern is its contract's law, and a closed relation, a derived relation or a context field stores no
 * field, so none of them states one. The installation lists its text domains' laws from these
 * (physical/install/compile.ts) and lawsOf lists their laws (program/laws.ts), so the two can never disagree.
 */
export const fieldPatternLaws = (model: LawModel): ReadonlyArray<FieldPatternLaw> =>
	[...model.relations.values()].flatMap(({ relation }) =>
		relation.fields.flatMap((field): ReadonlyArray<FieldPatternLaw> => {
			const regex = structuralRegex(field.type)
			if (regex === undefined) {
				return []
			}
			const stated = Object.freeze({
				kind: "pattern",
				relation: relation.name,
				field: field.name,
				patterns: regex.patterns
			} as const)
			const entry = fieldEntry(model.owned.declared.patterns, relation.name, field.name)
			return [
				Object.freeze({
					relation,
					field,
					regex,
					law: entry === undefined ? stated : Object.freeze({ ...stated, entry })
				})
			]
		})
	)

/**
 * The identity of the pattern law of `p`'s field under `domain`, the text domain its pattern's key is planned as
 * (planTextDomains): what a violation of that domain's CHECK on the field's column reports, what lawsOf gives the law
 * and the one place it is minted.
 */
export const patternLawId = (
	domain: Identity<"textDomain">,
	p: Pick<FieldPatternLaw, "relation" | "field">
): Identifier<"patternLaw"> =>
	identifierOf(identity.patternLaw(domain, p.relation.name, p.field.name))

/** A stored field a variant types (no contract is over a variant), and its law: its relation, the field, the variant and
 * the law, by the relation's and the field's names and the variant's. */
export interface FieldVariantLaw {
	readonly relation: TableRelation
	readonly field: LawField
	readonly variant: VariantInfo
	readonly law: Extract<StatedLaw, { readonly kind: "variant" }>
}

/**
 * The variant laws of a schema's law model: one per field of a stored relation a variant types, by relation name, each
 * relation's fields in declared order. The installation lists the variant's domain's law at each such field's column,
 * and each domain of an arm's field, a contract's or a text pattern's, the same law at that column
 * (physical/install/plan.ts), and lawsOf lists their laws (program/laws.ts), so the two can never disagree.
 */
export const fieldVariantLaws = (model: LawModel): ReadonlyArray<FieldVariantLaw> =>
	[...model.relations.values()].flatMap(({ relation }) =>
		relation.fields.flatMap((field): ReadonlyArray<FieldVariantLaw> => {
			const base = baseOf(field.type)
			return base.carrier === "variant"
				? [
						Object.freeze({
							relation,
							field,
							variant: base.variant,
							law: Object.freeze({
								kind: "variant",
								relation: relation.name,
								field: field.name,
								variant: base.variant.name
							} as const)
						})
					]
				: []
		})
	)

/**
 * The identity of the variant law of `v`'s field, under the variant's domain: what a violation of that domain's CHECK,
 * or of an arm's field's domain, on the field's column reports, what lawsOf gives the law and the one place it is
 * minted.
 */
export const variantLawId = (
	v: Pick<FieldVariantLaw, "relation" | "field" | "variant">
): Identifier<"variantLaw"> =>
	identifierOf(
		identity.variantLaw(identity.variantDomain(v.variant.name), v.relation.name, v.field.name)
	)

/** A column outside the stored relations that the installation types by a text refinement: a derived relation's view
 * column, a role view's, or a context field a role reads. It is planned before any domain is installed, so its pattern
 * has a domain however the view comes by it. `table` and `column` are its
 * place in canonical use order (`TextDomainUse`). */
export interface TextColumnUse {
	readonly regex: RegexRef
	readonly table: string
	readonly column: string
}

/** A column a structural text domain types, by its place in canonical use order: its table's and column's identifiers,
 * a context field's context and field names as their conversions. Nothing is named by them. */
interface TextDomainUse {
	readonly table: string
	readonly column: string
}

/** Canonical use order: table identifier, then column identifier. */
const compareUses = (a: TextDomainUse, b: TextDomainUse): number =>
	a.table < b.table
		? -1
		: a.table > b.table
			? 1
			: a.column < b.column
				? -1
				: a.column > b.column
					? 1
					: 0

/**
 * A domain's physical definition, its CREATE DOMAIN but for the names it is created and checked under: its base type,
 * its collation and its CHECK's predicate, where it has one. Its digest is what the domain is named by
 * (definitionDigest), so two contracts or refinements of one definition share one domain, and a changed definition is
 * a new domain.
 */
export interface DomainDefinition {
	readonly base: TypeRef
	readonly collation: Collation | undefined
	readonly check: Expr | undefined
}

/** The digest of a domain's definition, which names it: its base, its collation and its CHECKs' predicates. */
const definitionDigest = (definition: DomainDefinition): DomainDigest =>
	domainDigest(
		{
			base: definition.base,
			collation: definition.collation,
			checks: definition.check === undefined ? [] : [definition.check]
		},
		everyProperty
	)

/**
 * A domain's CREATE DOMAIN: its definition under its name, and its CHECK, where it has one, under the name `constraint`
 * gives it, which no domain of no CHECK is asked for. No domain carries NOT NULL; every column does.
 */
export const createDomain = (
	definition: DomainDefinition,
	name: ObjectName,
	constraint: () => string
): CreateDomain => ({
	kind: "createDomain",
	name,
	base: definition.base,
	collation: definition.collation,
	constraints:
		definition.check === undefined ? [] : [{ name: constraint(), predicate: definition.check }]
})

/** The identity of the structural text domain of `regex`: the digest of its definition, text in pg_c_utf8 under the
 * pattern's membership, so every pattern that compiles to one membership shares one domain. */
export const textDomainIdentity = (regex: RegexRef): Identity<"textDomain"> =>
	identity.textDomain(definitionDigest(textDomainDefinition(regex.check)))

/**
 * A parameter's pattern domain's definition in the schema `types`: over its pattern's structural text domain
 * `structural` in that schema, with no CHECK of its own, so its check is that domain's. Read in no schema
 * (digestedTypes), it is the domain's whole definition, base included, which its name digests in every installation
 * (paramDomainIdentity).
 */
const paramDomainDefinition = (
	structural: Identity<"textDomain">,
	types: TypeSchema
): DomainDefinition => ({
	base: qualifiedType({ schema: types, name: identifierOf(structural) }),
	collation: undefined,
	check: undefined
})

/**
 * The pattern domain of a declared parameter's place over `regex`: named by the place and the digest of its whole
 * definition (paramDomainDefinition), a domain over the pattern's structural text domain, which is itself named by the digest
 * of its own. A refusal by it names the parameter alone, whatever stored field shares the pattern; a domain of one name
 * has one definition, so a migration never changes one in place: a changed definition is another domain.
 */
export const paramDomainIdentity = (place: ParamPlace, regex: RegexRef): Identity<"paramDomain"> =>
	identity.paramDomain(
		place,
		definitionDigest(paramDomainDefinition(textDomainIdentity(regex), digestedTypes))
	)

/** A pattern a served workload's parameter names, at its place: what the installation creates its domain for. */
export interface ParamDomainUse {
	readonly place: ParamPlace
	readonly regex: RegexRef
}

/** The patterns a pattern domain checks of a value of `t` at `place`: its pattern where it is refined text outside any
 * contract (structuralRegex), none otherwise, a contract's being its domain's. */
const placeUses = (place: ParamPlace, t: ScalarType): ReadonlyArray<ParamDomainUse> => {
	const regex = structuralRegex(t)
	return regex === undefined ? [] : [{ place, regex }]
}

/**
 * The pattern domains declared parameters `params` name: a scalar parameter's of a pattern, and each field of a pattern
 * of a relation parameter's facts, by the parameter's id, the name a placeholder of it is lowered under.
 */
export const paramDomainUses = (params: ReadonlyArray<ParamDecl>): ReadonlyArray<ParamDomainUse> =>
	params.flatMap((p) =>
		p.kind === "relation"
			? p.heading.flatMap((c) => placeUses({ kind: "field", name: p.id, field: c.name }, c.type))
			: placeUses({ kind: "scalar", name: p.id }, p.type)
	)

/**
 * A contract an artifact of the installation types a value by where no stored field of the base declares it, with
 * where: a served program's (a parameter's, a field of a relation parameter's facts among them, or any value its checked
 * IR holds), a declared function's result's, a persistent expression's, a derived definition's or a law's. Every
 * placeholder of a parameter is cast to its contract's domain (lower/conservative/context.ts paramTypeRef), and every
 * read of a function's value casts it to its field's (lower/conservative/call), so the installation gives the contract
 * a domain as it gives a stored field's (physical/install/plan.ts planInstallation).
 */
export interface ParamContract {
	readonly contract: ContractInfo
	readonly loc: SourceLoc
}

/** The contracts a value of `t` is checked under, innermost first: each contract its base chain names, then its own. */
const innerFirstContracts = (t: ScalarType): ReadonlyArray<ContractInfo> => {
	const { contract } = t
	if (contract !== undefined) {
		return [...innerFirstContracts(contract.base), contract]
	}
	return t.carrier === "variant" ? armTypes(t).flatMap(innerFirstContracts) : []
}

/** The types of a variant's arms' fields, in order, which its composite's attributes are typed by. */
const armTypes = (t: ScalarType): ReadonlyArray<ScalarType> =>
	t.carrier === "variant" ? t.variant.arms.flatMap((arm) => arm.fields.map((f) => f.type)) : []

/** The contracts a value of `t` is typed by (innerFirstContracts), each placed at `loc`. */
export const typeContracts = (t: ScalarType, loc: SourceLoc): ReadonlyArray<ParamContract> =>
	innerFirstContracts(t).map((contract): ParamContract => ({ contract, loc }))

/**
 * The contracts the declared parameters `params` of the program `program` are typed by (ParamContract): each column a
 * parameter binds (ir/products.ts paramColumns), a scalar's, a clock reading's and each field of a relation's facts,
 * down its type's base chain, innermost first, so a contract follows the contracts its base names.
 */
const paramContracts = (
	program: string,
	params: ReadonlyArray<ParamDecl>
): ReadonlyArray<ParamContract> =>
	params.flatMap((p) => {
		const loc = SourceLoc(`parameter ${p.name} of program ${program}`, [])
		return paramColumns(p).flatMap((c) => typeContracts(c.type, loc))
	})

/**
 * The types the programs an installation serves name, which it installs: each pattern parameter's own pattern domain at
 * its place (ParamDomainUse); each contract a parameter is typed by (`contracts`, ParamContract), as the programs'
 * declarations name them, each held to its name's one definition (paramContractsDefined); each contract the programs'
 * checked IR types a value by (`typed`, dagObjects), a function's result's or a query's own cast target among them,
 * which names the domain of its name's definition; and every structural text refinement the programs type a value by
 * (`texts`), a parameter's, a column's of any node of theirs and an expression's (dagObjects), whose domain each
 * statement of theirs may name (a carrier's column, a cast, a delivered value's check); and every library function
 * their expressions call (`library`), so no served statement names a domain or calls a function the installation lacks. A served program that types a value by a refinement or a contract new to the
 * installation is a change of the installation, which generate drafts a migration for, as it drafts any other domain.
 */
export interface ServedTypes {
	readonly domains: ReadonlyArray<ParamDomainUse>
	readonly contracts: ReadonlyArray<ParamContract>
	readonly typed: ReadonlyArray<ParamContract>
	readonly texts: ReadonlyArray<RegexRef>
	readonly library: ReadonlyArray<LibraryFn>
}

/** No served type: what a plan serving no program is given. */
export const noServedTypes: ServedTypes = {
	domains: [],
	contracts: [],
	typed: [],
	texts: [],
	library: []
}

/** The types every one of `served` names, each kind in their order: what the programs of a plan serve together. */
export const servedTogether = (served: ReadonlyArray<ServedTypes>): ServedTypes => ({
	domains: served.flatMap((p) => p.domains),
	contracts: served.flatMap((p) => p.contracts),
	typed: served.flatMap((p) => p.typed),
	texts: served.flatMap((p) => p.texts),
	library: served.flatMap((p) => p.library)
})

/** The types the program `program`, its declared parameters `params` and the nodes `roots` its plan reads, names
 * (ServedTypes). */
export const servedTypesOf = (
	program: string,
	params: ReadonlyArray<ParamDecl>,
	roots: ReadonlyArray<RelNode>
): ServedTypes => {
	const held = dagObjects(SourceLoc(`program ${program}`, []), params, roots)
	return {
		domains: paramDomainUses(params),
		contracts: paramContracts(program, params),
		typed: held.contracts,
		texts: held.texts,
		library: held.library
	}
}

/**
 * The structural text refinement a value of `t` is typed by: its own pattern where it is refined text outside any
 * contract (structuralRegex), and none for any other value. A contract's value is its contract's domain's, which
 * carries its base's pattern in its own CHECK over `text` (ir/physical.ts domainBase), so a contract over a refined
 * text names no text domain; a value read at the base is a value of the base's own type, which the node or expression
 * holding it names; a variant's are its arms' fields', which its composite's attributes are typed by. So the
 * installation holds a text domain only where something types a value by it.
 */
export const typeRefinements = (t: ScalarType): ReadonlyArray<RegexRef> => {
	const own = structuralRegex(t)
	return own === undefined ? armTypes(t).flatMap(typeRefinements) : [own]
}

/** The objects a checked DAG's values need of its installation whatever stored field declares them (dagObjects): the
 * domains it types its values by and the library functions its expressions call. */
export interface DagObjects {
	readonly texts: ReadonlyArray<RegexRef>
	readonly contracts: ReadonlyArray<ParamContract>
	readonly library: ReadonlyArray<LibraryFn>
}

/**
 * The objects a checked DAG needs of its installation, a program's, a derived definition's or a law's violation
 * query's, one reachability walk for every kind: each structural text refinement it types a value by
 * (typeRefinements), each pattern key once, a refinement a built-in source gives (r.tokens' token, Text.collapse's
 * language) and a declared function's result's among them, and each contract (typeContracts) at `loc`, each name once,
 * of each column its declared parameters `params` bind, of each column of every node `roots` reach and of each
 * expression a node holds; and each library function an expression calls (physical/ddl/library.ts calledLibrary), a
 * law's Xml.isPattern over a derived relation among them, or a split's lowering calls (ir/physical.ts splitLibrary), a
 * decoded path's. Each once, its first in that order, so a workload states as
 * many objects as its programs need, never one per typed column.
 */
export const dagObjects = (
	loc: SourceLoc,
	params: ReadonlyArray<ParamDecl>,
	roots: ReadonlyArray<RelNode>
): DagObjects => {
	const texts = new Map<string, RegexRef>()
	const contracts = new Map<string, ParamContract>()
	const library = new Set<LibraryFn>()
	const add = (t: ScalarType): void => {
		for (const regex of typeRefinements(t)) {
			if (!texts.has(regex.key)) {
				texts.set(regex.key, regex)
			}
		}
		for (const c of typeContracts(t, loc)) {
			if (!contracts.has(c.contract.name)) {
				contracts.set(c.contract.name, c)
			}
		}
	}
	for (const p of params) {
		for (const c of paramColumns(p)) {
			add(c.type)
		}
	}
	for (const node of topoOrder({ roots })) {
		for (const c of node.heading) {
			add(c.type)
		}
		const split =
			node.kind === "Call" && node.function.kind === "split"
				? splitLibrary(node.function.split)
				: undefined
		if (split !== undefined) {
			library.add(split)
		}
		for (const e of exprClosure(exprsOf(node))) {
			add(e.type)
			const fn = calledLibrary(e)
			if (fn !== undefined) {
				library.add(fn)
			}
		}
	}
	return {
		texts: [...texts.values()],
		contracts: [...contracts.values()],
		library: [...library].toSorted(compareStrings)
	}
}

/**
 * A contract outside the base whose domain an installation installs for its served parameters, in installed terms:
 * its declared name, the digest of its domain's definition, which names the domain (InstallNames.contractNamed), and
 * whether the domain has a CHECK, which a refusal by it reports as the contract's law.
 */
export interface InstalledContract {
	readonly name: DeclaredName
	readonly digest: DomainDigest
	readonly checked: boolean
}

/**
 * The served types an installation installs (ServedTypes in installed terms, its text domains beside them in
 * snapshot.json's derived.textDomains), as snapshot.json records them: each parameter's pattern domain by its
 * identifier, in code point order, and each contract outside the base an artifact or a served program types a value by
 * (InstalledContract), base first. A served compile under the snapshot casts a value only to these.
 */
export interface InstalledParams {
	readonly domains: ReadonlyArray<string>
	readonly contracts: ReadonlyArray<InstalledContract>
}

/** A parameter's pattern domain as a refusal by it names the parameter: its place and its patterns. */
export interface ParamDomain {
	readonly param: ParamPlace
	readonly patterns: Patterns
}

/**
 * Each pattern domain the declared parameters `params` name (paramDomainUses), by its identifier, the data type
 * PostgreSQL reports a refusal by it under, with the parameter it checks.
 */
export const paramDomainsOf = (
	params: ReadonlyArray<ParamDecl>
): ReadonlyMap<string, ParamDomain> =>
	new Map(
		paramDomainUses(params).map(({ place, regex }) => [
			identifierOf(paramDomainIdentity(place, regex)),
			{ param: place, patterns: regex.patterns }
		])
	)

/**
 * The pattern domains of `uses` as objects in Setup, each identity once. Every placeholder of the parameter is cast to
 * its own (ir/physical.ts paramDomain), so PostgreSQL checks the value as it binds it, and a refusal by it is the
 * parameter's (adapter ParamRejected): PostgreSQL reports the domain the value is cast to, never an ancestor of it.
 * Each is `CREATE DOMAIN <schema>.<domain> AS <schema>.<text domain>` with no CHECK of its own (paramDomainDefinition),
 * after its pattern's structural text domain, which the installation holds for every pattern its served programs'
 * parameters name (planTextDomains). So no two domains of the installation hold one CHECK body, and a parameter's
 * domain has one definition wherever the pattern is stored, so its name, which digests that definition, is the same in
 * every compile over the installation. Their names, in order.
 */
export const addParamDomains = (
	b: InstallBuilder,
	uses: ReadonlyArray<ParamDomainUse>
): ReadonlyArray<ObjectName> => {
	const seen = new Set<string>()
	return uses.flatMap(({ place, regex }): ReadonlyArray<ObjectName> => {
		const named = paramDomainIdentity(place, regex)
		if (seen.has(named.canonical)) {
			return []
		}
		seen.add(named.canonical)
		const structural = b.names.textNamed(regex)
		const textNode = defined(
			b.typeNamed({ schema: b.names.types, name: identifierOf(structural) }),
			"the structural text domain of a served parameter's pattern"
		)
		const ddl = createDomain(
			paramDomainDefinition(structural, b.names.types),
			{ schema: b.names.types, name: b.name(named) },
			() => b.name(identity.domainCheck(named))
		)
		b.addType(
			"domain",
			b.names.installation,
			named,
			{
				ddl: [ddl],
				reasons: [
					enforcement(
						`pattern ${patternsText(regex.patterns)} of parameter ${paramPlaceText(place)}`
					)
				]
			},
			[b.schemaNode, textNode]
		)
		return [ddl.name]
	})
}

/**
 * A structural text domain of the installation: the digest of its physical definition, its identity at the naming door
 * and its one CHECK's, their identifiers, and the columns it types in canonical order (table identifier, then column
 * identifier).
 */
export interface TextDomain {
	readonly digest: DomainDigest
	readonly named: Identity<"textDomain">
	readonly check: Identity<"domainCheck">
	readonly name: DomainName
	readonly constraint: ConstraintName
	readonly uses: ReadonlyArray<TextDomainUse>
}

/** A structural text domain as planned: it types every column whose pattern has its key. */
export interface TextDomainPlan {
	/** The canonical pattern key of the regex it types. */
	readonly key: string
	readonly domain: TextDomain
	/** The refinement of the domain's first use, whose enforcement its CHECK spells. */
	readonly regex: RegexRef
}

/** The installed relation a theory relation's columns are of: a closed relation's conversion, a stored one's table. */
const theoryTable = (o: OwnedRelation): string => {
	switch (o.kind) {
		case "closedRelation":
			return conversionOf(o.name)
		case "derived":
			return missing(`physical: the derived relation ${o.name} is no relation of the theory`)
		case "relation":
		case "closed":
			return o.ident
	}
}

/**
 * Every structural text domain of an installation, each named at the naming door by its definition's digest
 * (textDomainIdentity), whatever uses it, so no use renames a domain, every compilation names a pattern alike, and
 * patterns of one membership share one domain. One rule holds: the installation holds the domain of every refinement
 * any artifact over it types a value by (physical/install/plan.ts artifactDomains), so every statement's cast to one
 * names an installed domain, and no refinement needs a stored field to exist. Its uses are the stored fields of the
 * theory's relations; `columns`, the other columns the installation types by a pattern (a derived relation's view
 * column, a role view's, a context field a role reads); and `refinements`, the refinements its artifacts type a value
 * by where no column is (a persistent expression's, a declared function's result's, a served program's), each a domain
 * whether or not any column carries its pattern. A contract's base is none of them: the contract's domain carries its
 * pattern in its own CHECK over `text` (typeRefinements), so a domain exists only where something names it.
 *
 * A text refinement that is neither a tautology nor wrapped in a contract is a structural domain shared by every field
 * whose pattern recognizes the same values: `CREATE DOMAIN <schema>.<domain> AS text COLLATE pg_catalog.pg_c_utf8
 * CONSTRAINT <check> CHECK (VALUE IS NULL OR (<membership>) IS TRUE)`. A closed relation's refined text payload counts
 * as a use, which the closed facts' validation casts to its domain. A context field an installed role reads has the
 * domain of its refined type, since Db.open's admission validates each claim against it. The domains a stored column
 * carries come first, in the order of their first use in canonical order, each CHECK spelled from that first use, so
 * it follows one rule whatever order the relations are met in; then every other, by its pattern's key.
 */
export const planTextDomains = (
	owned: Owned,
	theory: Theory,
	/** The columns outside the stored relations the installation types by a refinement (TextColumnUse). */
	columns: ReadonlyArray<TextColumnUse>,
	/** The refinements its artifacts type a value by where no column is (`TextRefinements`). */
	refinements: ReadonlyArray<RegexRef>
): ReadonlyArray<TextDomainPlan> => {
	/** Each pattern key a stored column carries: its regex and its stored uses. */
	const stored = new Map<
		string,
		{ readonly regex: RegexRef; readonly uses: [TextDomainUse, ...Array<TextDomainUse>] }
	>()
	/** Each other pattern key: its regex and its uses, each a column outside the stored relations, none for a
	 * refinement no column carries. */
	const unstored = new Map<
		string,
		{ readonly regex: RegexRef; readonly uses: Array<TextDomainUse> }
	>()
	for (const [name, r] of Object.entries(theory.relations).toSorted(([a], [b]) =>
		compareStrings(a, b)
	)) {
		if (r.kind === "stored") {
			continue
		}
		const o = defined(owned.relations[name], "ownership holds every relation of the theory")
		const table = theoryTable(o)
		for (const c of r.fields) {
			const regex = structuralRegex(c.type)
			if (regex === undefined) {
				continue
			}
			const field = defined(
				o.fields[c.name],
				"ownership holds every field of the theory's relations"
			)
			const u = { table, column: field.column }
			const known = stored.get(regex.key)
			if (known === undefined) {
				stored.set(regex.key, { regex, uses: [u] })
			} else {
				known.uses.push(u)
			}
		}
	}
	const outside = (regex: RegexRef): Array<TextDomainUse> | undefined => {
		if (stored.has(regex.key)) {
			return undefined
		}
		const known = unstored.get(regex.key)
		if (known !== undefined) {
			return known.uses
		}
		const uses: Array<TextDomainUse> = []
		unstored.set(regex.key, { regex, uses })
		return uses
	}
	for (const e of columns) {
		outside(e.regex)?.push({ table: e.table, column: e.column })
	}
	for (const regex of refinements) {
		outside(regex)
	}
	const plan = (regex: RegexRef, uses: ReadonlyArray<TextDomainUse>): TextDomainPlan => {
		const named = textDomainIdentity(regex)
		const check = identity.domainCheck(named)
		return {
			key: regex.key,
			domain: {
				digest: definitionDigest(textDomainDefinition(regex.check)),
				named,
				check,
				name: identifierOf(named),
				constraint: identifierOf(check),
				uses
			},
			regex
		}
	}
	return [
		...[...stored.values()]
			.map((k) => ({ regex: k.regex, uses: sortNonEmpty(k.uses, compareUses) }))
			.toSorted((a, b) => compareUses(a.uses[0], b.uses[0]))
			.map((k) => plan(k.regex, k.uses)),
		...[...unstored]
			.toSorted(([a], [b]) => compareStrings(a, b))
			.map(([, k]) => plan(k.regex, k.uses.toSorted(compareUses)))
	]
}

/**
 * Each structural text domain an installation holds (planTextDomains), by its pattern language's key (RegexRef.key),
 * with the digest of its domain's definition, which names it (textDomainIdentity): the one set every compile over the
 * installation names a refined text's domain from, which generate records in snapshot.json (deploy/snapshot/types.ts SnapshotDerived) and a Db reads there.
 */
export type TextDomainNames = ReadonlyMap<string, DomainDigest>

/** The names of planned text domains (planTextDomains), each by its pattern language's key. */
export const textDomainNames = (plans: ReadonlyArray<TextDomainPlan>): TextDomainNames =>
	new Map(plans.map((p) => [p.key, p.domain.digest] as const))

/** The structural text domains as objects in Setup, each after the schema, each definition once: their names, in
 * order. A pattern whose definition another's domain already holds adds its reason to that domain. */
export const addTextDomains = (
	b: InstallBuilder,
	plans: ReadonlyArray<TextDomainPlan>
): ReadonlyArray<ObjectName> =>
	plans.flatMap(({ domain, regex }) => {
		const reasons = [enforcement(`text refinement ${patternsText(regex.patterns)}`)]
		const known = b.typeNamed({ schema: b.schema, name: domain.name })
		if (known !== undefined) {
			b.graph.addReasons(known, reasons)
			return []
		}
		const ddl = createDomain(
			textDomainDefinition(regex.check),
			{ schema: b.schema, name: b.name(domain.named) },
			() => b.name(domain.check)
		)
		b.addType("domain", b.names.installation, domain.named, { ddl: [ddl], reasons }, [b.schemaNode])
		return [ddl.name]
	})

/**
 * A contract's domain's definition: over the domain of the contract its base is, a closed id's roster domain, or the
 * unrefined base type, with its CHECK, the pattern test and the predicate as one conjunction, or none. Its digest names
 * the contract's domain (contractDigest), so the one definition both names and installs it.
 */
const contractDefinition = (
	names: PhysicalNames,
	contract: { readonly name: string; readonly base: ScalarType; readonly check: DomainCheck }
): DomainDefinition => {
	const terms = (t: DomainCheckTerm): NonEmptyReadonlyArray<Expr> => {
		switch (t.kind) {
			case "pattern":
				return membershipTerms(t.regex.check, domainValue)
			case "predicate":
				return [
					lowerPersistent(names, unwrap(predicateTree(t.predicate)), {
						reads: { kind: "domain" },
						loc: SourceLoc(`the predicate of contract ${contract.name}`, [])
					})
				]
		}
	}
	const { type, collation } = domainBase(names, contract.base)
	const check = contract.check
	return {
		base: type,
		collation,
		check: check.kind === "unchecked" ? undefined : and(flatMapNonEmpty(check.terms, terms))
	}
}

/** One contract's domain as an object in Setup, named by its definition (InstallNames.contractNamed), after the schema
 * and after the type its base names, which is added before it: an inner contract's domain, a roster's domain, or the
 * vector extension. A contract of a definition another's domain holds adds its reasons to that domain. Its name. */
const addContractDomain = (
	b: InstallBuilder,
	contract: { readonly name: DeclaredName; readonly base: ScalarType; readonly check: DomainCheck },
	reasons: ReadonlyArray<PhysicalReason>
): ObjectName => {
	const named = b.names.contractNamed(contract.name)
	const name: ObjectName = { schema: b.schema, name: identifierOf(named) }
	const known = b.typeNamed(name)
	if (known !== undefined) {
		b.graph.addReasons(known, reasons)
		return name
	}
	const ddl = createDomain(
		contractDefinition(b.names, contract),
		{ schema: b.schema, name: b.name(named) },
		() => b.name(identity.domainCheck(named))
	)
	b.addType("domain", b.names.installation, named, { ddl: [ddl], reasons }, [
		b.schemaNode,
		...(isVectorRef(b, ddl.base) ? [b.provider("vector")] : [])
	])
	return name
}

/** The contract domains, in contract name order, each after the schema and after the types its base names, each
 * definition once: two contracts of one definition share one domain. Every contract is a law, and the law
 * model's domain native holds its base and decides its CHECK.
 *
 * A contract is `CREATE DOMAIN <schema>.<domain> AS <base>`, named by its definition's digest. Its base is an inner
 * contract's domain, a closed id's roster domain, or the unrefined base type, `text COLLATE pg_catalog.pg_c_utf8` for a
 * text base. Its CHECK is the law model's (`DomainCheck`): `check`, the pattern test and the predicate as one
 * conjunction, or none for a brand-only contract over an unrefined base. No domain carries NOT NULL; every column does.
 * The CHECK's wrapper, `VALUE IS NULL OR (...) IS TRUE`, is the printer's, so the domain admits NULL. */
export const addContractDomains = (b: InstallBuilder): ReadonlyArray<ObjectName> => {
	const domains = b.natives
		.flatMap((n) => (n.namespace === "domain" ? [n] : []))
		.toSorted((x, y) => compareStrings(x.object.name, y.object.name))
	const byName = new Map(domains.map((d) => [d.object.name, d] as const))
	const added = new Map<string, ObjectName>()
	/** A contract's domain, after the domain of the contract its base is. */
	const add = (domain: (typeof domains)[number]): ObjectName => {
		const { object } = domain
		const known = added.get(object.name)
		if (known !== undefined) {
			return known
		}
		const baseContract = object.base.contract
		const inner = baseContract === undefined ? undefined : byName.get(baseContract.name)
		if (inner !== undefined) {
			add(inner)
		}
		const name = addContractDomain(
			b,
			{ name: object.name, base: object.base, check: object.check },
			lawReasons(object.lawIds)
		)
		added.set(object.name, name)
		return name
	}
	return domains.map(add)
}

/** A contract the base does not declare that the installation gives a domain, a context field's or a served
 * parameter's: its declared name (which names its law, analysis/theory/theory.ts contractLawIdentity), its type, and its
 * CHECK. Its domain is named by its definition, as a base contract's is (InstallNames.contractNamed). */
export interface OutsideContract {
	readonly name: DeclaredName
	readonly contract: ContractInfo
	readonly check: DomainCheck
}

/** The contracts outside the base an installation gives a domain (outsideContracts): its context fields', then its
 * served parameters' that no context field declares. */
export interface OutsideContracts {
	readonly context: ReadonlyArray<OutsideContract>
	readonly params: ReadonlyArray<OutsideContract>
}

/**
 * The digest of a contract's domain's definition over `names`, read in no schema (type-schemas.ts digestedHooks): what
 * InstallNames names the domain by. A definition over another domain, a contract's or a roster's, or calling a function
 * of the installation's library names the installation's schema, so the one contract would name its domain apart in
 * two installations of two names.
 */
export const contractDigest = (
	names: PhysicalNames,
	contract: DeclaredName,
	source: ContractSource
): DomainDigest =>
	definitionDigest(
		inNoSchema(
			names.installed,
			contractDefinition(names, { name: contract, base: source.base, check: source.check })
		)
	)

/** `definition` read in no schema of `installed`'s (type-schemas.ts digestedHooks): its base and its CHECK. */
const inNoSchema = (
	installed: ReadonlySet<string>,
	definition: DomainDefinition
): DomainDefinition => {
	const t = new Transform(digestedHooks(installed))
	return {
		base: t.type(definition.base),
		collation: definition.collation,
		check: definition.check === undefined ? undefined : t.expr(definition.check)
	}
}

/** The contracts outside the base an installation gives a domain (OutsideContracts), each once with its CHECK, in
 * base-first order (a contract after the contracts its base chain names): every contract the context fields of
 * `fields` name, down each contract's base chain, then every contract `params` lists (ParamContract), each contract an
 * artifact of the installation or a served program types a value by (physical/install/plan.ts artifactDomains,
 * ServedTypes `contracts`), that the base does not declare. Each gets its domain whether a column carries it or not:
 * Db.open's admission validates each claim against a context contract's, every placeholder of a parameter is cast to
 * its contract's, and every read of a declared function's value to its field's. Each is named by the contract's name as a base contract's is: a declared name of the schema's one
 * namespace of relations, rosters and contracts, so one the declared-name rule refuses, or one converting as a base
 * relation's, roster's or contract's does, is refused (core/identity.ts DeclaredNamespace).
 *
 * One contract name has one definition, so one domain. A context field's contract the base declares is the base's:
 * its definition must be the base's, or the context is refused, as two context fields' contracts of one name must be
 * one definition. A parameter's contract the base or a context field declares, or another parameter before it, is
 * theirs, its definition held to theirs once the installation's names are read (paramContractsDefined). */
export const outsideContracts = (
	owned: Owned,
	fields: ReadonlyArray<{
		readonly context: string
		readonly field: string
		readonly desc: FieldDesc
		readonly type: ScalarType
		readonly loc: SourceLoc
	}>,
	params: ReadonlyArray<ParamContract>
): Result.Result<OutsideContracts, CompileError> =>
	catchRefusal(() => {
		const context: Array<OutsideContract> = []
		const planned = new Map<string, string>()
		const types = DeclaredNamespace.of("relation, roster and contract")
		for (const r of Object.values(owned.relations)) {
			unwrap(declareRelation(types, r, r.kind === "closed" ? "closed relation" : "relation", r.loc))
		}
		for (const c of Object.values(owned.contracts)) {
			unwrap(types.declare(c.name, "contract", c.loc))
		}
		const plan = (
			desc: ContractFieldDesc,
			info: ContractInfo,
			loc: SourceLoc,
			what: string
		): void => {
			const baseContract = info.base.contract
			if (desc.base.kind === "contract" && baseContract !== undefined) {
				plan(desc.base, baseContract, loc, what)
			}
			const text = unwrap(descText(desc))
			const declared = owned.contracts[info.name]
			const prior =
				declared === undefined ? planned.get(info.name) : unwrap(descText(declared.desc))
			if (prior !== undefined) {
				if (prior !== text) {
					throw new Refusal(
						malformedDescription(
							loc,
							`${what}: one definition per contract name; contract ${info.name} is defined otherwise ${declared === undefined ? "by another context field" : "by the base"}`
						)
					)
				}
				return
			}
			planned.set(info.name, text)
			context.push({
				name: unwrap(types.declare(info.name, "contract", loc)),
				contract: info,
				check: domainCheck(info)
			})
		}
		for (const f of fields) {
			const info = f.type.contract
			if (f.desc.kind === "contract" && info !== undefined) {
				plan(f.desc, info, f.loc, `context field ${f.context}.${f.field}`)
			}
		}
		const served: Array<OutsideContract> = []
		const named = new Set<string>([...Object.keys(owned.contracts), ...planned.keys()])
		for (const { contract, loc } of params) {
			if (named.has(contract.name)) {
				continue
			}
			named.add(contract.name)
			served.push({
				name: unwrap(types.declare(contract.name, "contract", loc)),
				contract,
				check: domainCheck(contract)
			})
		}
		return { context, params: served }
	})

/**
 * `params` (ParamContract) under the installation's names `names`, refused at the first whose contract's definition is
 * not the one its name's domain is named by (InstallNames.contractNamed): one contract name is one definition, the
 * base's, a context field's (`context`) or the first parameter's that names it (outsideContracts).
 */
export const paramContractsDefined = (
	names: InstallNames,
	owned: Owned,
	context: ReadonlyArray<OutsideContract>,
	params: ReadonlyArray<ParamContract>
): Result.Result<ReadonlyArray<ParamContract>, CompileError> => {
	const held = new Set<ContractInfo>()
	for (const { contract, loc } of params) {
		if (held.has(contract)) {
			continue
		}
		held.add(contract)
		const own = identity.contractDomain(
			contractDigest(names, contract.name, { base: contract.base, check: domainCheck(contract) })
		)
		if (own.canonical !== names.contractNamed(contract.name).canonical) {
			const by =
				owned.contracts[contract.name] !== undefined
					? "by the base"
					: context.some((c) => c.name === contract.name)
						? "by a context field"
						: "by another parameter"
			return Result.err(
				malformedDescription(
					loc,
					`one definition per contract name; contract ${contract.name} is defined otherwise ${by}`
				)
			)
		}
	}
	return Result.ok(params)
}

/** The domains of the contracts outside the base (OutsideContracts) as objects in Setup, base first, each after the
 * domain of a contract its base is: the context fields', then the served parameters'. */
export const addOutsideContractDomains = (
	b: InstallBuilder,
	contracts: OutsideContracts
): ReadonlyArray<ObjectName> => [
	...contracts.context.map((c) =>
		addContractDomain(b, { name: c.name, base: c.contract.base, check: c.check }, [
			enforcement(`contract ${c.name} of a context field`)
		])
	),
	...contracts.params.map((c) =>
		addContractDomain(b, { name: c.name, base: c.contract.base, check: c.check }, [
			enforcement(`contract ${c.name} of a served parameter`)
		])
	)
]
