import {
	type JoinColumn,
	type Met,
	meetType,
	metColumn,
	refusal,
	refuse,
	type ScanSelector,
	unwrapOr,
	type ViolationBuilder
} from "#compiler/analysis/theory/build.ts"
import { sameOrder } from "#compiler/core/array.ts"
import { compareText, ownedText, withoutSourceLocs } from "#compiler/core/canonical.ts"
import { type Identity, identifierOf } from "#compiler/core/identity.ts"
import { fieldIdSpellingParts, type Identifier } from "#compiler/core/ids.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import {
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import { compareNumbers, mapInput } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { integerDigits } from "#compiler/ir/carriers.ts"
import {
	type BoundDesc,
	type BoundValueDesc,
	type ExprDesc,
	type LiteralDesc,
	type SelectionDesc,
	type TermDesc,
	termText,
	type WeightDesc
} from "#compiler/ir/desc.ts"
import { type ExprSpec, OpId, type ScalarExpr } from "#compiler/ir/expr.ts"
import {
	type CapacityAggregate,
	type CapacityBound,
	type CapacityBounds,
	type DeclaredSide,
	type ExactCarrier,
	fieldNames,
	isSpanField,
	type KeyName,
	type LawField,
	type LawShape,
	type NormalizedLaw,
	type RelationInfo,
	type RosterHandleOf,
	type Selector,
	type SpanField,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { type AggregateCallOver, conservativeMeta, type HeadingColumn } from "#compiler/ir/rel.ts"
import {
	baseOf,
	type ContractInfo,
	contractOf,
	rosterOf,
	type ScalarType,
	type SpanInfo,
	spanCarriers,
	spanOf
} from "#compiler/ir/scalar.ts"
import { type AggregateOverload, countOverload, unaryOverload } from "#compiler/scalar/aggregate.ts"
import type { RegexMember } from "#compiler/scalar/compute/evaluate.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import {
	type LowerEnv,
	lowerPredicate,
	lowerTerm,
	noExtension,
	noParams
} from "#compiler/scalar/compute/lower.ts"
import { guardedTerm } from "#compiler/scalar/natural.ts"
import { numericValue } from "#compiler/scalar/registry.ts"
import type {
	OwnedContract,
	OwnedKey,
	OwnedStatement,
	SidePair,
	SideScope
} from "#compiler/schema/own.ts"

/** A row check as its statement states it: its relation, its name and predicate, and its constraint identifier, which
 * ownership named. */
interface StatedCheck {
	readonly kind: "check"
	readonly relation: string
	readonly rel: TheoryRelation
	readonly name: string
	readonly predicate: ExprDesc
	readonly named: Identity<"check">
}

/** A law's detail as normalization states it, before its violation query is written: a row check's predicate not yet
 * lowered, every other detail whole. */
type StatedDetail = Exclude<LawDetail, { readonly kind: "check" }> | StatedCheck

/**
 * What a law states beyond its shape and sides, per shape family.
 *
 * Each side's fields are its pairs' fields on that side, in pair order.
 *
 * An alternatives family's law, every arm's reverse obligation, with the family its expansion was recognized as.
 */
type LawDetail =
	| {
			readonly kind: "key"
			readonly relation: string
			readonly rel: TheoryRelation
			/** The key as the checked schema minted it: its fields' handles, its span, its constraint identifier. */
			readonly key: KeyName
	  }
	| (StatedCheck & {
			/** The predicate as the law's violation query lowers it, a node of the theory's DAG. */
			readonly lowered: ScalarExpr
	  })
	| {
			readonly kind: "contract"
			readonly contract: string
			readonly owned: OwnedContract
			readonly uses: ReadonlyArray<ContractUse>
	  }
	| {
			/** A key over a side beyond a relation key's: a selected side's, or one with a pred term. */
			readonly kind: "projectedKey"
			readonly side: ResolvedSide
	  }
	| {
			readonly kind: "containment"
			readonly from: ResolvedSide
			readonly to: ResolvedSide
			readonly pairs: NonEmptyReadonlyArray<ResolvedPair>
			readonly pairing: ContainmentPairing
	  }
	| {
			readonly kind: "alternatives"
			/** The origin marker, FieldId(parent, discriminator). */
			readonly family: string
			readonly parent: string
			readonly parentRel: TheoryRelation
			readonly parentKey: NonEmptyReadonlyArray<string>
			/** The handles of the parent key's fields, in key order. */
			readonly parentFields: NonEmptyReadonlyArray<LawField>
			readonly discriminator: string
			readonly discriminatorField: LawField
			readonly roster: string
			/** Every handle of the roster, in roster order: armed with its arm, or unarmed, owing no payload and no
			 * further law. At least one is armed. */
			readonly handles: NonEmptyReadonlyArray<RosterHandleOf<TheoryArm>>
	  }
	| {
			/** An alternatives arm relation's law: each of its rows belongs to a parent whose kind it is the arm of. */
			readonly kind: "alternativesArm"
			/** The origin marker, FieldId(parent, discriminator). */
			readonly family: string
			readonly parent: string
			readonly parentRel: TheoryRelation
			readonly parentKey: NonEmptyReadonlyArray<string>
			readonly discriminator: string
			readonly discriminatorField: LawField
			readonly arm: string
			readonly armRel: TheoryRelation
			/** The arm's key, each field paired with the parent key field it meets, in parent key order. */
			readonly key: NonEmptyReadonlyArray<ResolvedArmPair>
			/** The handles it is the arm of, in roster order. */
			readonly handles: NonEmptyReadonlyArray<string>
			/** The arm relation over its key, every fact. */
			readonly from: ResolvedSide
			/** The parent over its key, the facts of the handles it is the arm of: its discriminator equal to its one handle,
			 * or in its handles. Each fact of `from` is contained in it, the arm's forward law as a partial projection. */
			readonly to: ResolvedSide
	  }
	| {
			readonly kind: "capacity"
			/** Each side selected by field = literal conjunctions, the selections a capacity reads. */
			readonly target: ResolvedSide<FixedSelection>
			readonly from: ResolvedSide<FixedSelection>
			readonly pairs: NonEmptyReadonlyArray<ResolvedCapacityPair>
			/** A statement that weighs nothing counts its source facts. */
			readonly weight: WeightDesc
			/** The weight with the source field it reads, resolved. */
			readonly weighed: Weighed
			readonly aggregate: CapacityAggregate
			/** The bounds as the statement states them, which the law's identity reads. */
			readonly within: BoundDesc
			/** The bounds parsed against the aggregate, which the law's consumers read. */
			readonly bounds: CapacityBounds
	  }

/** A containment's source term with the target term it meets. */
export interface ContainmentPair {
	readonly from: TermDesc
	readonly to: TermDesc
}

/** A term of a declared side, the handle of its field resolved: the field's own value, or its pred. */
export type ResolvedTerm = TermDesc & { readonly column: LawField }

/** A containment pair with its two terms resolved. */
interface ResolvedPair {
	readonly from: ResolvedTerm
	readonly to: ResolvedTerm
}

/** A capacity's target field with the source field that groups the target's sources by it. */
interface CapacityPair {
	readonly target: string
	readonly from: string
}

/** A capacity pair with the handles of its two fields. */
interface ResolvedCapacityPair extends CapacityPair {
	readonly targetColumn: LawField
	readonly fromColumn: LawField
}

/** An alternatives arm's key field with the parent key field it meets. */
interface ArmPair {
	readonly arm: string
	readonly parent: string
}

/** An arm pair with the handles of its two fields. */
interface ResolvedArmPair extends ArmPair {
	readonly armColumn: LawField
	readonly parentColumn: LawField
}

/** A selector of a declared side, with the handle of the field it selects. */
export interface ResolvedSelector extends Selector {
	readonly col: LawField
}

/**
 * One conjunct of a declared side's selection, resolved: its predicate and canonical text, which a law's identity
 * reads, and the fields of its relation it reads, in declared field order. It is `fixed` when it fixes a field to a
 * literal, `field = literal` with the literal typed at its field and no other conjunct fixing that field, the form a
 * constant selection, evidence and the residual families read; any other is `general`.
 */
export type ResolvedConjunct =
	| (ConjunctOf<"fixed"> & { readonly selector: ResolvedSelector })
	| ConjunctOf<"general">

/** What every resolved conjunct holds, of its form `K`. */
interface ConjunctOf<K extends "fixed" | "general"> {
	readonly kind: K
	readonly predicate: ExprDesc
	readonly text: string
	readonly reads: ReadonlyArray<LawField>
}

/** A fixed conjunct (`ResolvedConjunct`). */
type FixedConjunct = Extract<ResolvedConjunct, { readonly kind: "fixed" }>

/** A declared side's selection resolved: its conjuncts, in canonical order. None reads every fact. */
export interface ResolvedSelection {
	readonly conjuncts: ReadonlyArray<ResolvedConjunct>
}

/** A selection every conjunct of which is fixed: what the three residual families read, and closed facts. */
export interface FixedSelection extends ResolvedSelection {
	readonly conjuncts: ReadonlyArray<FixedConjunct>
}

/** The selection as one of fixed conjuncts, or undefined when a conjunct is general. */
export const fixedSelection = (selection: ResolvedSelection): FixedSelection | undefined => {
	const fixed = selection.conjuncts.filter((c): c is FixedConjunct => c.kind === "fixed")
	return fixed.length === selection.conjuncts.length ? { conjuncts: fixed } : undefined
}

/** A fixed selection's selectors, in field name order: none for every fact. */
export const selectorsOf = (selection: FixedSelection): ReadonlyArray<ResolvedSelector> =>
	selection.conjuncts.map((c) => c.selector).toSorted((a, b) => compareText(a.column, b.column))

/**
 * A side a statement declares, with the relation it names and the field of each term resolved where the statement is
 * normalized, and its selection resolved, of the kind `S` proves. The terms and the conjuncts' predicates stay what a
 * law's identity reads; the resolved members are what its consumers read.
 */
export interface ResolvedSide<
	S extends ResolvedSelection = ResolvedSelection
> extends DeclaredSide {
	readonly rel: TheoryRelation
	readonly terms: NonEmptyReadonlyArray<ResolvedTerm>
	readonly selection: S
}

/** A side as the residual families read it: selected by fixed conjuncts alone, or undefined. */
const fixedSide = (side: ResolvedSide): ResolvedSide<FixedSelection> | undefined => {
	const selection = fixedSelection(side.selection)
	return selection === undefined ? undefined : { ...side, selection }
}

/** A capacity side selected by fixed conjuncts; any other conjunct is refused, since the residual capacity reads
 * fixed selections alone until capacity is deleted. */
const capacitySide = (side: ResolvedSide, loc: SourceLoc): ResolvedSide<FixedSelection> =>
	fixedSide(side) ??
	refuse(
		"UnsupportedLawFamily",
		loc,
		`a capacity whose sides select by conjunctions of field = literal; select(${side.relation}, ...) selects by another predicate`
	)

/**
 * One arm of an alternatives family: the payload relation of a handle, its key, each field paired with the parent key
 * field it meets, in parent key order, and the forward containment that declares it.
 */
export interface TheoryArm {
	readonly handle: string
	readonly relation: string
	readonly rel: TheoryRelation
	readonly key: NonEmptyReadonlyArray<ResolvedArmPair>
	readonly statement: number
}

/**
 * How a containment law's sides pair: term by term, or with one span field each, a coverage law that pairs the
 * source's span `from` with the target's span `to`.
 */
type ContainmentPairing = { readonly kind: "scalar" } | ({ readonly kind: "span" } & SpanPair)

/** The shape a containment law is: a coverage law when its sides pair a span, else a containment. */
const containmentShape = (pairing: ContainmentPairing): LawShape => {
	switch (pairing.kind) {
		case "span":
			return "coverage"
		case "scalar":
			return "contained"
	}
}

/** Where a contract's values are stored: a column of the contract itself, or one endpoint of a span over it. */
export interface ContractUse {
	readonly relation: string
	readonly rel: TheoryRelation
	readonly field: LawField
	readonly at: "column" | "lower" | "upper"
}

/**
 * A normalized law: the frozen record (ir/law.ts) with every statement it came from and its detail.
 *
 * Law normalization: statements to normalized laws with their violation queries.
 *
 * Every law is a query that must be empty. Each statement of the owned schema is normalized into one or
 * more recognized shapes, each with its source identity, its sides, and the violation query the shape denotes. A side
 * is a partial projection: each row its selection holds on gives the tuple of its terms where every term is defined,
 * a pred term where its field is above zero.
 *
 * - a relation's primary key and each candidate key: two facts agreeing on the key and differing elsewhere; a key
 *   with a span field is a pointwise nonoverlap rule, so two different facts agreeing on its scalar fields whose spans
 *   share a point;
 * - a key over a projected side: two rows of the side agreeing on its terms and differing elsewhere;
 * - a contract: a stored value whose contract predicate is false, at every column of the contract and at both
 *   endpoints of every span over it;
 * - a row check: a row whose predicate is false;
 * - a containment: a source tuple with no matching target tuple, a pred term compared in numeric; one whose sides pair
 *   a span field is a coverage law: a source fact a point of whose span no target fact of its scalar group covers, evaluated
 *   against the maximal covered segments;
 * - an alternatives expansion, recognized as one family from the origin marker its statements carry:
 *   its head containment; each arm relation's law, a row of it whose key no parent of a handle it is the arm of holds;
 *   and one family law for every arm's reverse obligation, a parent selecting a handle with no row in that handle's
 *   arm, so lowering can tag each arm relation once and dispatch one selected arm;
 * - a capacity: a target fact whose group's count or total weight lies outside its bounds, the empty group included
 *   when zero lies outside them.
 *
 * Pointwise capacity over spans has no violation query in the admitted fragment, so it is UnsupportedLawFamily here;
 * so are a containment pairing more than one span field, and a capacity over a pred term or a selection beyond literal
 * equalities. Coverage into a target without a
 * span key has an exact violation query and is normalized; its lowering, not its meaning, is what the first compiler
 * rejects, which law specialization decides.
 */
export interface TheoryLaw extends NormalizedLaw {
	/** A theory law's own identifier, never a text pattern's. */
	readonly id: Identifier<"law">
	/** The law's identity at the naming door (theory.ts lawIdentityOf), whose identifier is its `id`. */
	readonly named: Identity<"law">
	readonly statements: ReadonlyArray<number>
	readonly detail: LawDetail
}

/** What a law's identity is computed from: everything but its id and its violation node, its detail as stated. */
export type LawIdentity = Omit<TheoryLaw, "id" | "named" | "violation" | "loc" | "detail"> & {
	readonly detail: StatedDetail
}

/**
 * The laws of an alternatives family, at L: its family law, every arm's reverse obligation, whose detail is the
 * recognized family; and each arm relation's law, each of its rows a payload of a parent of one of its handles, in
 * roster order of the relations' first handles. A theory's families name laws by id (L = LawId); the drafts, by index.
 */
export interface AlternativesFamily<L> {
	/** The origin marker, FieldId(parent, discriminator). */
	readonly id: string
	readonly reverse: L
	readonly arms: NonEmptyReadonlyArray<{
		readonly relation: string
		readonly handles: NonEmptyReadonlyArray<string>
		readonly forward: L
	}>
}

/** One statement of an alternatives expansion, at its index in the owned schema's statements. */
export interface FamilyMember {
	readonly s: OwnedStatement
	readonly index: number
}

/** A statement a law comes from: its index in the owned schema's statements, and where it is declared. */
interface StatementSource {
	readonly index: number
	readonly loc: SourceLoc
}

/**
 * A law before it has an identity: its record but its statements, the statements it comes from, and how to write its
 * violation query.
 */
interface LawDraft {
	readonly identity: Omit<LawIdentity, "statements">
	readonly sources: ReadonlyArray<StatementSource>
	readonly write: (b: ViolationBuilder) => WrittenLaw
}

/** A law's violation query as written, and its detail as the theory law carries it: a row check's with its predicate
 * as the query lowers it, any other law's as stated. */
interface WrittenLaw {
	readonly violation: RelNode
	readonly detail: LawDetail
}

/** A draft whose detail its violation query leaves as stated: every law but a row check. */
interface StatedDraft {
	readonly identity: Omit<LawIdentity, "statements" | "detail"> & {
		readonly detail: Exclude<LawDetail, { readonly kind: "check" }>
	}
	readonly sources: ReadonlyArray<StatementSource>
	readonly violation: (b: ViolationBuilder) => RelNode
}

/** A stated draft as a law draft: its violation written, its detail as stated. */
const lawDraft = (draft: StatedDraft): LawDraft => ({
	identity: draft.identity,
	sources: draft.sources,
	write: (b) => ({ violation: draft.violation(b), detail: draft.identity.detail })
})

/** The draft of a key ownership owned over `r`, its handles the checked schema's: a relation's primary key, or a key
 * statement's. */
const keyDraft = (
	r: TheoryRelation,
	key: KeyName,
	source: { readonly kind: "relation" | "key"; readonly statement: number },
	sources: ReadonlyArray<StatementSource>
): StatedDraft => {
	const relation = r.name
	const shape: LawShape =
		key.span !== undefined ? "spanKey" : source.kind === "relation" ? "pk" : "key"
	return {
		identity: {
			shape,
			source,
			sides: [{ relation, terms: termsOfFields(fieldNames(key.fields)) }],
			detail: { kind: "key", relation, rel: r, key }
		},
		sources,
		violation: (b) => keyViolation(b, r, key)
	}
}

/** An ordinary relation with the law of its primary key, as kept. */
export interface PrimaryKeyKept {
	readonly relation: RelationInfo
	readonly kept: KeptLaw
}

/** A row check's violation query, and its predicate as the query lowers it. */
interface CheckViolation {
	readonly violation: RelNode
	readonly predicate: ScalarExpr
}

/**
 * A law the normalizer keeps: the first draft of its identity, with the statements of every equivalent draft merged
 * into it, and the location its first draft was tracked at.
 */
export class KeptLaw {
	readonly named: Identity<"law">
	readonly draft: LawDraft
	/** Where the first draft was normalized: a statement's, a relation's for its primary key, a contract's. */
	readonly tracked: SourceLoc
	#sources: ReadonlyArray<StatementSource>

	constructor(named: Identity<"law">, draft: LawDraft, tracked: SourceLoc) {
		this.named = named
		this.draft = draft
		this.tracked = tracked
		this.#sources = draft.sources
	}

	/** Merges an equivalent draft's statements: every statement once, in statement order. */
	merge(sources: ReadonlyArray<StatementSource>): void {
		this.#sources = [
			...new Map([...this.#sources, ...sources].map((s) => [s.index, s] as const)).values()
		].toSorted((a, b) => a.index - b.index)
	}

	/** The law's record but its id, violation and location: the draft's, with every statement it came from. */
	get identity(): LawIdentity {
		return { ...this.draft.identity, statements: this.#sources.map((s) => s.index) }
	}

	/**
	 * Where the law is declared: its first declaring statement's location, or, for a primary key or a contract, which no
	 * statement declares, the relation's or the contract's it was tracked at.
	 */
	get loc(): SourceLoc {
		const [first] = this.#sources
		return first === undefined ? this.tracked : first.loc
	}
}

/** The span pair of a coverage law: the pair, and the handles of its source and target spans. */
interface SpanPair {
	readonly pair: ResolvedPair
	readonly from: SpanField
	readonly to: SpanField
}

interface NormalizeEnv {
	readonly relations: ReadonlyMap<string, TheoryRelation>
	/** A law's identity at the naming door (theory.ts lawIdentityOf). */
	readonly named: (law: LawIdentity) => Identity<"law">
	/** What lowering a law's predicate or term reads of the schema's types. */
	readonly lowerEnv: {
		readonly fieldType: LowerEnv["fieldType"]
		readonly regexMember: RegexMember
	}
}

const isSpan = (t: ScalarType): boolean => spanCarriers.includes(baseOf(t).carrier)

/** A statement's pairs as a containment from its left side into its right. */
const leftToRight = (
	pairs: NonEmptyReadonlyArray<SidePair>
): NonEmptyReadonlyArray<ContainmentPair> =>
	mapNonEmpty(pairs, (p) => ({ from: p.left, to: p.right }))

/** Each field as a field term. */
const termsOfFields = (fields: ReadonlyArray<string>): ReadonlyArray<TermDesc> =>
	fields.map((field) => ({ kind: "field", field }))

/** A capacity statement as ownership admitted it. */
type CapacityStatement = Extract<OwnedStatement, { readonly kind: "capacity" }>

/** A key statement as ownership admitted it. */
type KeyStatement = Extract<OwnedStatement, { readonly kind: "key" }>

/** Each contract a type is, from the outside in (a contract may be declared over another, scalar/compute/types.ts). */
const contractChain = (t: ScalarType): ReadonlyArray<ContractInfo> => {
	const chain: Array<ContractInfo> = []
	for (let contract = contractOf(t); contract !== undefined; contract = contractOf(contract.base)) {
		chain.push(contract)
	}
	return chain
}

export class Normalizer {
	readonly env: NormalizeEnv
	readonly #primaryKeys: Array<PrimaryKeyKept> = []
	readonly #laws: Array<KeptLaw> = []
	/** Each kept law by its identity's canonical text, so an equivalent draft merges into it. */
	readonly #byIdentity = new Map<string, KeptLaw>()
	readonly families: Array<AlternativesFamily<KeptLaw>> = []

	constructor(env: NormalizeEnv) {
		this.env = env
	}

	/** Each ordinary relation's primary-key law, in the order the relations were kept. */
	get primaryKeys(): ReadonlyArray<PrimaryKeyKept> {
		return this.#primaryKeys
	}

	/** Every law kept but the primary keys', in the order its first draft was pushed. */
	get laws(): ReadonlyArray<KeptLaw> {
		return this.#laws
	}

	#relation(name: string, loc: SourceLoc): TheoryRelation {
		const r = this.env.relations.get(name)
		if (r === undefined) {
			return refuse("MalformedDescription", loc, `a relation or closed relation named ${name}`)
		}
		return r
	}

	/** The handle of the field `field` of `r`, refused when `r` has none: the one place a law's field name is resolved. */
	#column(r: TheoryRelation, field: string, loc: SourceLoc): LawField {
		return (
			r.fields.find((f) => f.name === field) ??
			refuse("MalformedDescription", loc, `a field ${r.name}.${field}`)
		)
	}

	/** The law side of `scope` over `terms`, its relation and each term's field resolved, and its selection resolved. */
	side(scope: SideScope, terms: NonEmptyReadonlyArray<TermDesc>, loc: SourceLoc): ResolvedSide {
		const r = this.#relation(scope.relation, loc)
		return this.#sideOver(
			scope,
			r,
			mapNonEmpty(terms, (t) => this.#term(r, t, loc)),
			loc
		)
	}

	/** The term `t` of a side of `r`, its field resolved. */
	#term(r: TheoryRelation, t: TermDesc, loc: SourceLoc): ResolvedTerm {
		return { ...t, column: this.#column(r, t.field, loc) }
	}

	/** A capacity's side of `scope` over `r` with its terms resolved, selected by literal equalities (`capacitySide`). */
	#capacitySide(
		scope: SideScope,
		r: TheoryRelation,
		terms: NonEmptyReadonlyArray<ResolvedTerm>,
		loc: SourceLoc
	): ResolvedSide<FixedSelection> {
		return capacitySide(this.#sideOver(scope, r, terms, loc), loc)
	}

	/** The side of `scope` over `r` with its terms resolved, its selection resolved. */
	#sideOver(
		scope: SideScope,
		r: TheoryRelation,
		terms: NonEmptyReadonlyArray<ResolvedTerm>,
		loc: SourceLoc
	): ResolvedSide {
		return {
			relation: scope.relation,
			rel: r,
			terms,
			selection: this.#selection(r, scope.selection, loc)
		}
	}

	/**
	 * A side's selection resolved over `r` (`ResolvedSelection`): each conjunct with its canonical text and the fields it
	 * reads, fixed where it fixes a field no other conjunct fixes, its literal typed at that field.
	 */
	#selection(r: TheoryRelation, selection: SelectionDesc, loc: SourceLoc): ResolvedSelection {
		const read = selection.conjuncts.map((predicate) => {
			const equality = fieldEquality(predicate)
			return {
				predicate,
				text: ownedText(predicate, withoutSourceLocs),
				reads: r.fields.filter((f) => mentions(predicate, f.name)),
				selector:
					equality === undefined
						? undefined
						: this.#selector(r, equality.field, equality.value, loc)
			}
		})
		const fixings = (field: string): number =>
			read.filter((c) => c.selector?.column === field).length
		return {
			conjuncts: read.map(({ selector, ...c }): ResolvedConjunct =>
				selector === undefined || fixings(selector.column) > 1
					? { kind: "general", ...c }
					: { kind: "fixed", ...c, selector }
			)
		}
	}

	#selector(
		r: TheoryRelation,
		column: string,
		value: LiteralDesc,
		loc: SourceLoc
	): ResolvedSelector {
		const col = this.#column(r, column, loc)
		const typed = irLiteral(value, col.type)
		if (!typed.ok) {
			return refuse(
				"MalformedDescription",
				loc,
				`a selection on ${r.name}.${column}: ${typed.error}`
			)
		}
		return { column, value: typed.value.literal, col }
	}

	/**
	 * Keeps a draft, tracked at `tracked`: a new law, or the statements of an equivalent draft (one law identity, such
	 * as one statement repeated at two levels states) merged into the law kept first.
	 */
	#push(draft: StatedDraft, tracked: SourceLoc): KeptLaw {
		return this.#keep(lawDraft(draft), tracked, (kept) => this.#laws.push(kept))
	}

	/** Keeps a draft as `#push` does, a new law handed to `keepNew`. */
	#keep(draft: LawDraft, tracked: SourceLoc, keepNew: (kept: KeptLaw) => void): KeptLaw {
		const named = this.env.named({
			...draft.identity,
			statements: draft.sources.map((s) => s.index)
		})
		const prior = this.#byIdentity.get(named.canonical)
		if (prior !== undefined) {
			prior.merge(draft.sources)
			return prior
		}
		const kept = new KeptLaw(named, draft, tracked)
		this.#byIdentity.set(named.canonical, kept)
		keepNew(kept)
		return kept
	}

	/** The law of the primary key of the ordinary relation `r`, the `index`-th stored relation, kept with `r`: its key is
	 * the first ownership declared on it (`keyNames`). */
	primaryKey(r: RelationInfo, index: number): void {
		this.#keep(
			lawDraft(keyDraft(r, r.keyNames[0], { statement: index, kind: "relation" }, [])),
			r.loc,
			(kept) => this.#primaryKeys.push({ relation: r, kept })
		)
	}

	/** The key a key statement states over `r`, as the checked schema minted it. */
	#statedKey(r: TheoryRelation, key: OwnedKey, loc: SourceLoc): KeyName {
		return (
			r.keyNames.find((k) => identifierOf(k.named) === key.constraint) ??
			refuse("MalformedDescription", loc, `a key ownership owned over ${r.name}`)
		)
	}

	/** The contract `name`, whose predicate is undefined when it refines nothing; `base` types its VALUE. */
	contract(
		owned: OwnedContract,
		predicate: ExprDesc | undefined,
		index: number,
		uses: ReadonlyArray<ContractUse>,
		base: () => ScalarType,
		loc: SourceLoc
	): void {
		const name = owned.name
		this.#push(
			{
				identity: {
					shape: "contract",
					source: { statement: index, kind: "contract" },
					sides: [...new Set(uses.map((u) => u.relation))].map((relation) => ({
						relation,
						terms: termsOfFields([
							...new Set(uses.filter((u) => u.relation === relation).map((u) => u.field.name))
						])
					})),
					detail: { kind: "contract", contract: name, owned, uses }
				},
				sources: [],
				violation: (b) => contractViolation(b, this.env, name, predicate, uses, base, loc)
			},
			loc
		)
	}

	statement(s: OwnedStatement, index: number): void {
		const loc = s.loc
		const sources = [{ index, loc }]
		switch (s.kind) {
			case "key":
				this.#key(s, index, sources)
				return
			case "check": {
				const r = this.#relation(s.relation, loc)
				const fields = r.fields.map((f) => f.name).filter((f) => mentions(s.predicate, f))
				const stated: StatedCheck = {
					kind: "check",
					relation: s.relation,
					rel: r,
					name: s.name,
					predicate: s.predicate,
					named: s.check.named
				}
				this.#keep(
					{
						identity: {
							shape: "check",
							source: { statement: index, kind: "check" },
							sides: [{ relation: s.relation, terms: termsOfFields(fields) }],
							detail: stated
						},
						sources,
						write: (b) => {
							const written = checkViolation(b, this.env, r, s.predicate, loc)
							return {
								violation: written.violation,
								detail: { ...stated, lowered: written.predicate }
							}
						}
					},
					loc,
					(kept) => this.#laws.push(kept)
				)
				return
			}
			case "contained":
				this.containment(
					s.left,
					s.right,
					leftToRight(s.pairs),
					index,
					s.origin?.alternatives,
					loc,
					loc
				)
				return
			case "capacity":
				this.capacity(s, index, loc)
				return
			case "mutable":
				return
		}
	}

	/** A key statement: a candidate key as the checked schema minted it, or a key over a projected side. */
	#key(s: KeyStatement, index: number, sources: ReadonlyArray<StatementSource>): void {
		const loc = s.loc
		switch (s.key.kind) {
			case "candidate": {
				const r = this.#relation(s.side.relation, loc)
				this.#push(
					keyDraft(
						r,
						this.#statedKey(r, s.key.key, loc),
						{ statement: index, kind: "key" },
						sources
					),
					loc
				)
				return
			}
			case "projected": {
				const side = this.side(s.side, s.side.terms, loc)
				this.#push(
					{
						identity: {
							shape: "key",
							source: { statement: index, kind: "key" },
							sides: [side],
							detail: { kind: "projectedKey", side }
						},
						sources,
						violation: (b) => projectedKeyViolation(b, this.env, side, loc)
					},
					loc
				)
				return
			}
		}
	}

	/**
	 * The containment `statement` states from `from` into `to`, each source term paired with the target term it meets,
	 * from the alternatives expansion `alternatives` or declared as itself (undefined), tracked at `tracked`.
	 */
	containment(
		from: SideScope,
		to: SideScope,
		pairs: NonEmptyReadonlyArray<ContainmentPair>,
		statement: number,
		alternatives: string | undefined,
		loc: SourceLoc,
		tracked: SourceLoc
	): KeptLaw {
		const fromRel = this.#relation(from.relation, loc)
		const toRel = this.#relation(to.relation, loc)
		const resolved = mapNonEmpty(pairs, (p): ResolvedPair => ({
			from: this.#term(fromRel, p.from, loc),
			to: this.#term(toRel, p.to, loc)
		}))
		const fromSide = this.#sideOver(
			from,
			fromRel,
			mapNonEmpty(resolved, (p) => p.from),
			loc
		)
		const toSide = this.#sideOver(
			to,
			toRel,
			mapNonEmpty(resolved, (p) => p.to),
			loc
		)
		/**
		 * The pairing is decided here, once: sides with no span field pair term by term, and sides with one are a
		 * coverage law.
		 */
		const [first, ...more] = resolved.filter((p) => isSpanField(p.from.column))
		if (more.length > 0) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a coverage law pairs one span field; this one pairs ${more.length + 1}`
			)
		}
		/** A source span paired with a target field of another identity is no coverage: the field classes refuse it. */
		const span =
			first?.from.kind === "field" &&
			first.to.kind === "field" &&
			isSpanField(first.from.column) &&
			isSpanField(first.to.column)
				? { pair: first, from: first.from.column, to: first.to.column }
				: undefined
		const paired: {
			readonly pairing: ContainmentPairing
			readonly violation: (b: ViolationBuilder) => RelNode
		} =
			span === undefined
				? {
						pairing: { kind: "scalar" },
						violation: (b) => containmentViolation(b, this.env, fromSide, toSide, resolved, loc)
					}
				: {
						pairing: { kind: "span", ...span },
						violation: (b) => coverageViolation(b, this.env, fromSide, toSide, resolved, span, loc)
					}
		return this.#push(
			{
				identity: {
					shape: containmentShape(paired.pairing),
					source: { statement, kind: "contained", alternatives },
					sides: [fromSide, toSide],
					detail: {
						kind: "containment",
						from: fromSide,
						to: toSide,
						pairs: resolved,
						pairing: paired.pairing
					}
				},
				sources: [{ index: statement, loc }],
				violation: paired.violation
			},
			tracked
		)
	}

	/** A capacity's weight resolved against its source relation `from`: a duration weight's field holds a span. */
	#weighed(s: CapacityStatement, from: TheoryRelation, loc: SourceLoc): Weighed {
		const weight = s.weight
		switch (weight.kind) {
			case "count":
				return { kind: "count" }
			case "field":
				return { kind: "field", field: this.#column(from, weight.field, loc) }
			case "duration": {
				const field = this.#column(from, weight.field, loc)
				const span = spanOf(baseOf(field.type))
				return span === undefined
					? refuse(
							"MalformedDescription",
							loc,
							`a duration weight over a span field; ${from.name}.${field.name} holds no span`
						)
					: { kind: "duration", field, span }
			}
		}
	}

	/**
	 * A `ref` bound is compared exactly with that exact sum, which no carrier does for a real or double precision
	 * bound: PostgreSQL converts a float to numeric at its significant digits (15 for double precision, 6 for
	 * real), and comparing in the float would round the sum. So a ref bound is of an exact type; a literal bound is
	 * an integer by its description. A money bound converts to numeric exactly.
	 */
	capacity(s: CapacityStatement, index: number, loc: SourceLoc): void {
		const target = this.#relation(s.target.relation, loc)
		const from = this.#relation(s.from.relation, loc)
		/** A capacity groups by fields: a pred term is no field. */
		const groupField = (t: TermDesc): string =>
			t.kind === "field"
				? t.field
				: refuse(
						"UnsupportedLawFamily",
						loc,
						`a capacity grouped by fields; ${termText(t)} is a pred term`
					)
		const pairs = mapNonEmpty(s.pairs, (p): ResolvedCapacityPair => {
			const targetField = groupField(p.left)
			const fromField = groupField(p.right)
			return {
				target: targetField,
				from: fromField,
				targetColumn: this.#column(target, targetField, loc),
				fromColumn: this.#column(from, fromField, loc)
			}
		})
		const pointwise = [
			...pairs.map((p) => p.targetColumn.type),
			...pairs.map((p) => p.fromColumn.type)
		].some(isSpan)
		if (pointwise) {
			throw refusal(
				"UnsupportedLawFamily",
				loc,
				"a capacity grouped by scalar fields; a grouping that includes a span is pointwise capacity over spans, which the first compiler does not admit"
			)
		}
		const weighed = this.#weighed(s, from, loc)
		const aggregate = capacityAggregate(s, weighed, loc)
		const parse = (bound: BoundValueDesc): CapacityBound => {
			if (typeof bound === "bigint") {
				const typed = irLiteral(bound, aggregate.type)
				if (!typed.ok) {
					return refuse("MalformedDescription", loc, `a capacity bound: ${typed.error}`)
				}
				return { kind: "literal", literal: typed.value.literal, stated: bound }
			}
			const column = this.#column(target, bound.ref, loc)
			const carrier = baseOf(column.type).carrier
			if (carrier === "float4" || carrier === "float8") {
				throw refusal(
					"UnsupportedLawFamily",
					loc,
					`a capacity bound of an exact type, compared exactly with the exact sum; ${s.target.relation}.${bound.ref} is ${carrier}`
				)
			}
			return {
				kind: "ref",
				field: column,
				carrier: comparisonCarrier(aggregate.type, column.type, loc)
			}
		}
		const bounds: CapacityBounds = {
			low: parse(s.within.low),
			high: s.within.high === "*" ? undefined : parse(s.within.high)
		}
		const targetSide = this.#capacitySide(
			s.target,
			target,
			mapNonEmpty(pairs, (p): ResolvedTerm => ({
				kind: "field",
				field: p.target,
				column: p.targetColumn
			})),
			loc
		)
		const fromSide = this.#capacitySide(
			s.from,
			from,
			mapNonEmpty(pairs, (p): ResolvedTerm => ({
				kind: "field",
				field: p.from,
				column: p.fromColumn
			})),
			loc
		)
		this.#push(
			{
				identity: {
					shape: "capacity",
					source: { statement: index, kind: "capacity" },
					sides: [targetSide, fromSide],
					detail: {
						kind: "capacity",
						target: targetSide,
						from: fromSide,
						pairs,
						weight: s.weight,
						weighed,
						aggregate,
						within: s.within,
						bounds
					}
				},
				sources: [{ index, loc }],
				violation: (b) =>
					capacityViolation(
						b,
						this.env,
						targetSide,
						fromSide,
						weighed,
						s.within,
						bounds,
						pairs,
						loc
					)
			},
			loc
		)
	}

	/**
	 * An alternatives expansion: per arm, the two containments between its arm relation and the parent selected by the
	 * arm's handle, each carrying the origin marker FieldId(parent, discriminator). The statements are normalized here
	 * instead of one by one. The roster is the discriminator's: a closedId field's type holds it to its handles.
	 */
	alternatives(id: string, members: NonEmptyReadonlyArray<FamilyMember>): void {
		const loc = members[0].s.loc
		const contained = members.flatMap((m) =>
			m.s.kind === "contained" ? [{ s: m.s, index: m.index }] : []
		)
		const arms = contained
		if (!isNonEmpty(arms) || contained.length !== members.length) {
			throw refusal(
				"MalformedDescription",
				loc,
				`an alternatives expansion ${id}: the two containments of each arm`
			)
		}
		const named = fieldIdSpellingParts(id)
		const parent = this.#relation(named.relation, loc)
		const discriminator = named.field
		const discriminatorField = this.#column(parent, discriminator, loc)
		const rosterType = rosterOf(baseOf(discriminatorField.type))
		const roster = rosterType === undefined ? undefined : this.env.relations.get(rosterType.closed)
		if (roster?.kind !== "closed") {
			throw refusal(
				"MalformedDescription",
				loc,
				`an alternatives expansion ${id} whose discriminator is a closedId field of its roster`
			)
		}
		const handles = roster.handles
		/** The handle a side selects the parent by, when it selects the parent by its discriminator alone. */
		const selected = (side: SideScope): string | undefined => {
			const [only, ...more] = side.relation === parent.name ? side.selection.conjuncts : []
			const equality = only === undefined || more.length > 0 ? undefined : fieldEquality(only)
			return equality?.field === discriminator && typeof equality.value === "string"
				? equality.value
				: undefined
		}
		/** A field term's field; an arm pairs fields alone. */
		const fieldOf = (t: TermDesc, at: SourceLoc): string =>
			t.kind === "field"
				? t.field
				: refuse("MalformedDescription", at, `an alternatives arm of ${id} pairing fields`)
		/** Each arm containment, with its direction: from the selected parent into its arm, or back. */
		const directed = mapNonEmpty(arms, (m) => {
			const st = m.s
			const leftHandle = selected(st.left)
			const rightHandle = leftHandle === undefined ? selected(st.right) : undefined
			if (leftHandle !== undefined) {
				return {
					m,
					direction: "reverse" as const,
					armSide: st.right,
					handle: leftHandle,
					key: mapNonEmpty(st.pairs, (p) => ({
						arm: fieldOf(p.right, st.loc),
						parent: fieldOf(p.left, st.loc)
					}))
				}
			}
			if (rightHandle !== undefined) {
				return {
					m,
					direction: "forward" as const,
					armSide: st.left,
					handle: rightHandle,
					key: mapNonEmpty(st.pairs, (p) => ({
						arm: fieldOf(p.left, st.loc),
						parent: fieldOf(p.right, st.loc)
					}))
				}
			}
			return refuse(
				"MalformedDescription",
				st.loc,
				`an alternatives arm of ${id} selecting ${parent.name} by its discriminator ${discriminator}`
			)
		})
		type Directed = (typeof directed)[number]
		const pairText = (d: Directed): string =>
			d.key.map((p) => `${p.arm}\u0000${p.parent}`).join("\u0001")
		/** Each arm by its forward containment, with the reverse containment it pairs with. */
		const forwardArms = directed.filter((d) => d.direction === "forward")
		const reverseArms = directed.filter((d) => d.direction === "reverse")
		const paired = forwardArms.map((f) => {
			const twins = reverseArms.filter(
				(r) =>
					r.handle === f.handle &&
					r.armSide.relation === f.armSide.relation &&
					pairText(r) === pairText(f)
			)
			const [reverse, ...extra] = twins
			if (reverse === undefined || extra.length > 0) {
				return refuse(
					"MalformedDescription",
					f.m.s.loc,
					`an alternatives arm of ${id} at ${JSON.stringify(f.handle)} stated as one containment each way`
				)
			}
			return { ...f, reverse }
		})
		if (!isNonEmpty(paired) || paired.length !== reverseArms.length) {
			throw refusal(
				"MalformedDescription",
				loc,
				`an alternatives expansion ${id}: the two containments of each arm`
			)
		}
		const resolved = paired
		const parentKey = mapNonEmpty(resolved[0].key, (p) => p.parent)
		const parentKeyText = parentKey.join("\u0000")
		const position = new Map(handles.map((h, i) => [h, i] as const))
		const seen = new Set<string>()
		const placed = mapNonEmpty(resolved, (a) => {
			const at = position.get(a.handle)
			if (at === undefined || seen.has(a.handle)) {
				throw refusal(
					"MalformedDescription",
					a.m.s.loc,
					`an alternatives arm of ${id} for a distinct handle of ${roster.name}; ${JSON.stringify(a.handle)} is not one`
				)
			}
			seen.add(a.handle)
			if (a.armSide.relation === parent.name) {
				throw refusal(
					"MalformedDescription",
					a.m.s.loc,
					`an alternatives arm of ${id} on a relation other than its parent ${parent.name}`
				)
			}
			if (mapNonEmpty(a.key, (p) => p.parent).join("\u0000") !== parentKeyText) {
				throw refusal(
					"MalformedDescription",
					a.m.s.loc,
					`every arm of ${id} keyed by one parent key`
				)
			}
			return { ...a, at }
		})
		type Placed = (typeof placed)[number]
		const ordered = sortNonEmpty(
			placed,
			mapInput(compareNumbers, (a: Placed) => a.at)
		)
		const first = ordered[0]
		/** The parent over its key, the facts `conjuncts` select. */
		const parentOver = (conjuncts: ReadonlyArray<ExprDesc>): ResolvedSide =>
			this.side(
				{ relation: parent.name, selection: { conjuncts } },
				mapNonEmpty(parentKey, (field): TermDesc => ({ kind: "field", field })),
				loc
			)
		const parentSide = parentOver([])
		const parentFields = mapNonEmpty(parentSide.terms, (t) => t.column)
		const armed = mapNonEmpty(ordered, (a) => {
			if (a.armSide.selection.conjuncts.length > 0) {
				throw refusal(
					"MalformedDescription",
					a.m.s.loc,
					`an alternatives arm of ${id} over its whole relation ${a.armSide.relation}`
				)
			}
			const side = this.side(
				a.armSide,
				mapNonEmpty(a.key, (p): TermDesc => ({ kind: "field", field: p.arm })),
				a.m.s.loc
			)
			const arm: TheoryArm = {
				handle: a.handle,
				relation: a.armSide.relation,
				rel: side.rel,
				key: mapNonEmpty(a.key, (p): ResolvedArmPair => ({
					...p,
					armColumn: this.#column(side.rel, p.arm, loc),
					parentColumn: this.#column(parent, p.parent, loc)
				})),
				statement: a.m.index
			}
			return { side, arm, loc: a.m.s.loc, reverse: a.reverse.m }
		})
		type Armed = (typeof armed)[number]
		const [lead, ...later] = armed
		const leads: NonEmptyReadonlyArray<Armed> = [
			lead,
			...later.filter(
				(a, i) => ![lead, ...later.slice(0, i)].some((b) => b.arm.relation === a.arm.relation)
			)
		]
		const groups = mapNonEmpty(leads, (l) => {
			const sharing: NonEmptyReadonlyArray<Armed> = [
				l,
				...armed.filter((a) => a !== l && a.arm.relation === l.arm.relation)
			]
			const armKey = mapNonEmpty(l.arm.key, (p) => p.arm)
			for (const m of sharing) {
				if (
					!sameOrder(
						mapNonEmpty(m.arm.key, (p) => p.arm),
						armKey
					)
				) {
					throw refusal(
						"MalformedDescription",
						loc,
						`an arm relation of ${id} keyed by one key at every handle it is the arm of; ${l.arm.relation} is keyed differently at ${l.arm.handle} and ${m.arm.handle}`
					)
				}
			}
			return { lead: l, handles: mapNonEmpty(sharing, (m) => m.arm.handle), members: sharing }
		})
		/** The discriminator among an arm relation's handles: equal to its one handle, or in them. */
		const ofHandles = (armHandles: NonEmptyReadonlyArray<string>): ExprDesc => {
			const field: ExprDesc = { kind: "field", field: discriminator }
			const [only, ...more] = armHandles
			return more.length === 0
				? {
						kind: "compare",
						op: "eq",
						left: field,
						right: { kind: "literal", value: only, type: undefined }
					}
				: { kind: "in", arg: field, values: armHandles }
		}
		const forwards = mapNonEmpty(groups, (g) => {
			const arm = g.lead.arm
			const to = parentOver([ofHandles(g.handles)])
			return {
				relation: arm.relation,
				handles: g.handles,
				forward: this.#push(
					{
						identity: {
							shape: "alternativesArm",
							source: { statement: arm.statement, kind: "contained", alternatives: id },
							sides: [g.lead.side, to],
							detail: {
								kind: "alternativesArm",
								family: id,
								parent: parent.name,
								parentRel: parent,
								parentKey,
								discriminator,
								discriminatorField,
								arm: arm.relation,
								armRel: arm.rel,
								key: arm.key,
								handles: g.handles,
								from: g.lead.side,
								to
							}
						},
						sources: g.members.map((m) => ({ index: m.arm.statement, loc: m.loc })),
						violation: (b) =>
							alternativesArmViolation(b, parent, discriminatorField, arm.rel, arm.key, g.handles)
					},
					loc
				)
			}
		})
		const familyArms = mapNonEmpty(armed, (a) => a.arm)
		const armOf = new Map(familyArms.map((arm) => [arm.handle, arm] as const))
		const rosterHandles = mapNonEmpty(handles, (handle): RosterHandleOf<TheoryArm> => {
			const arm = armOf.get(handle)
			return arm === undefined ? { kind: "unarmed", handle } : { kind: "armed", arm }
		})
		const reverse = this.#push(
			{
				identity: {
					shape: "alternatives",
					source: { statement: first.reverse.m.index, kind: "contained", alternatives: id },
					sides: [parentSide, ...armed.map((a) => a.side)],
					detail: {
						kind: "alternatives",
						family: id,
						parent: parent.name,
						parentRel: parent,
						parentKey,
						parentFields,
						discriminator,
						discriminatorField,
						roster: roster.name,
						handles: rosterHandles
					}
				},
				sources: ordered.map((a) => ({ index: a.reverse.m.index, loc: a.reverse.m.s.loc })),
				violation: (b) => alternativesViolation(b, parent, discriminatorField, familyArms)
			},
			loc
		)
		this.families.push({ id, reverse, arms: forwards })
	}
}

/** The field a predicate fixes and the literal it fixes it to: a field compared equal with a literal on either side. */
const fieldEquality = (
	e: ExprDesc
): { readonly field: string; readonly value: LiteralDesc } | undefined => {
	if (e.kind !== "compare" || e.op !== "eq") {
		return undefined
	}
	if (e.left.kind === "field" && e.right.kind === "literal") {
		return { field: e.left.field, value: e.right.value }
	}
	if (e.left.kind === "literal" && e.right.kind === "field") {
		return { field: e.right.field, value: e.left.value }
	}
	return undefined
}

/** Whether a row check's predicate reads `field`. */
const mentions = (e: ExprDesc, field: string): boolean => {
	switch (e.kind) {
		case "field":
			return e.field === field
		case "compute":
		case "and":
		case "or":
			return e.args.some((a) => mentions(a, field))
		case "cast":
		case "base":
		case "not":
		case "in":
			return mentions(e.arg, field)
		case "cond":
			return mentions(e.pred, field) || mentions(e.onTrue, field) || mentions(e.onFalse, field)
		case "when":
			return mentions(e.subject, field) || mentions(e.proved, field) || mentions(e.otherwise, field)
		case "compare":
			return mentions(e.left, field) || mentions(e.right, field)
		case "between":
			return mentions(e.arg, field) || mentions(e.low, field) || mentions(e.high, field)
		case "allen":
			return mentions(e.left, field) || mentions(e.right, field)
		case "pointIn":
			return mentions(e.point, field) || mentions(e.span, field)
		case "var":
		case "value":
		case "parent":
		case "param":
		case "literal":
		case "absent":
			return false
	}
}

/**
 * Two facts of R agreeing on the key and differing elsewhere; for a key with span fields, two different
 * facts agreeing on its scalar fields whose spans share a point. The witness is the key, in key order.
 */
const keyViolation = (b: ViolationBuilder, r: TheoryRelation, key: KeyName): RelNode => {
	const { fields, span } = key
	const spans = span === undefined ? [] : [span]
	const shared = new Set<LawField>(fields.filter((f) => f !== span))
	const join = b.selfJoin(r, shared)
	const differs = r.fields
		.filter((f) => !shared.has(f))
		.map((f) => {
			const pair = join.pair(f)
			return b.op("ne", [b.col(join.node, pair.left), b.col(join.node, pair.right)])
		})
	const overlaps = spans.map((s) => {
		const pair = join.pair(s)
		return b.rangeOp(
			"range_overlaps",
			s.type.carrier,
			b.col(join.node, pair.left),
			b.col(join.node, pair.right)
		)
	})
	const pred = b.connective("and", [...overlaps, b.connective("or", differs)])
	const filtered = b.filter(join.node, pred)
	const witness = mapNonEmpty(fields, (field) => ({ field, pair: join.pair(field) }))
	return b.project(
		filtered,
		witness.map((k) => [k.field.name, b.col(filtered, k.pair.left)] as const)
	)
}

/** A row of R whose predicate is false; the witness is R's primary key. */
const checkViolation = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	r: TheoryRelation,
	predicate: ExprDesc,
	loc: SourceLoc
): CheckViolation => {
	const region = b.scan(r, r.fields, [])
	const pred = lowerTotal(b, env, predicate, loc, (desc, at) => {
		const field = desc.kind === "field" ? r.fields.find((f) => f.name === desc.field) : undefined
		if (field === undefined) {
			return refuse(
				"MalformedDescription",
				at,
				`a field of ${r.name}, not a ${desc.kind} reference`
			)
		}
		return Result.ok(columnLeaf(region, field))
	})
	const filtered = b.filter(region, b.not(pred))
	return {
		violation: b.project(
			filtered,
			mapNonEmpty(r.primaryFields, (f) => [f.name, b.col(filtered, f)] as const)
		),
		predicate: pred
	}
}

const columnLeaf = (node: RelNode, c: HeadingColumn): ExprSpec => ({
	kind: "column",
	column: { node: node.id, name: c.name },
	args: [],
	type: c.type,
	nonNull: "storage"
})

/** Lowers a total predicate (a row check or a contract predicate) into the builder's DAG. */
const lowerTotal = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	predicate: ExprDesc,
	loc: SourceLoc,
	leaf: LowerEnv["leaf"]
) =>
	unwrapOr(
		Result.map(
			lowerPredicate(predicate, {
				...env.lowerEnv,
				mode: "check",
				loc,
				emit: (spec) => b.expr(spec),
				leaf,
				params: noParams
			}),
			(l) => l.expr
		)
	)

/**
 * A stored value of the contract whose predicate is false. Every column of the contract and both
 * endpoints of every span over it contribute one arm; the witness is the value alone, because a domain violation
 * reports no key. A contract without a predicate admits every value of its base, and one no relation
 * stores has no stored value, so their violation queries are the empty relation.
 */
const contractViolation = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	name: string,
	predicate: ExprDesc | undefined,
	uses: ReadonlyArray<ContractUse>,
	base: () => ScalarType,
	loc: SourceLoc
): RelNode => {
	const arms = uses.map((use) => {
		const region = b.scan(use.rel, [use.field], [])
		const columnType = use.field.type
		const declared = use.at === "column" ? columnType : spanOf(baseOf(columnType))?.endpoint
		const info =
			declared === undefined ? undefined : contractChain(declared).find((c) => c.name === name)
		if (info === undefined) {
			return refuse(
				"MalformedDescription",
				loc,
				`${use.relation}.${use.field.name} of the contract ${name}`
			)
		}
		/** The stored value at the contract's base type, over the node that supplies the row. */
		const valueOver = (node: RelNode) => {
			const column = b.col(node, use.field)
			return b.as(use.at === "column" ? column : b.op(use.at, [column]), info.base)
		}
		const value = valueOver(region)
		const pred =
			predicate === undefined
				? b.bool(true)
				: lowerTotal(b, env, predicate, childLoc(loc, "predicate"), (desc, at) =>
						desc.kind === "value"
							? Result.ok(value)
							: refuse(
									"MalformedDescription",
									at,
									`a contract predicate reads only its VALUE, not ${desc.kind}`
								)
					)
		const refused = b.filter(region, b.not(pred))
		return b.project(refused, [["value", valueOver(refused)]])
	})
	if (isNonEmpty(arms)) {
		return b.union(arms)
	}
	return b.node({
		kind: "Closed",
		closed: name,
		rows: [],
		heading: [{ name: "value", type: base() }],
		loc: undefined,
		meta: conservativeMeta
	})
}

/** A column of a relation's projection: the field it reads, and its column there, of the type it casts it to. */
interface ProjectedColumn {
	readonly field: LawField
	readonly column: HeadingColumn
}

/** The projection of the rows of `r` its literal selectors pick onto `columns`. */
const sideProjection = (
	b: ViolationBuilder,
	r: TheoryRelation,
	selection: ReadonlyArray<ScanSelector>,
	columns: ReadonlyArray<ProjectedColumn>
): RelNode => {
	const region = b.scan(
		r,
		columns.map((c) => c.field),
		selection
	)
	return b.project(
		region,
		columns.map((c) => [c.column.name, b.as(b.col(region, c.field), c.column.type)] as const)
	)
}

/** The leaf reader of a row expression of `r` over the row `node` binds: each field of `r` its column there. */
const rowLeaf =
	(r: TheoryRelation, node: RelNode): LowerEnv["leaf"] =>
	(desc, at) => {
		const field = desc.kind === "field" ? r.fields.find((f) => f.name === desc.field) : undefined
		if (field === undefined) {
			return refuse(
				"MalformedDescription",
				at,
				`a field of ${r.name}, not a ${desc.kind} reference`
			)
		}
		return Result.ok(columnLeaf(node, field))
	}

/** A term of a row expression lowered, total, into the builder's DAG: a law side's term, a field or pred's difference. */
const lowerTermTotal = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	term: ExprDesc,
	loc: SourceLoc,
	leaf: LowerEnv["leaf"]
): ScalarExpr =>
	unwrapOr(
		Result.map(
			lowerTerm(term, {
				...env.lowerEnv,
				mode: "check",
				loc,
				emit: (spec) => b.expr(spec),
				leaf,
				params: noParams
			}),
			(l) => l.expr
		)
	)

/**
 * The rows of a law side's partial projection, with each of `terms`' values over them: the rows its selection holds on,
 * a fixed conjunct fixing its field in the scan and any other filtering it, where every term is defined (each term's
 * guard, scalar/natural.ts guardedTerm: pred(x) above zero).
 */
const sideRows = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	side: ResolvedSide,
	terms: NonEmptyReadonlyArray<ResolvedTerm>,
	loc: SourceLoc
): { readonly rows: RelNode; readonly values: NonEmptyReadonlyArray<ScalarExpr> } => {
	const r = side.rel
	const conjuncts = side.selection.conjuncts
	const general = conjuncts.flatMap((c) => (c.kind === "general" ? [c] : []))
	const region = b.scan(
		r,
		[...terms.map((t) => t.column), ...general.flatMap((c) => c.reads)],
		conjuncts.flatMap((c) => (c.kind === "fixed" ? [c.selector] : []))
	)
	const guarded = mapNonEmpty(terms, guardedTerm)
	const leaf = rowLeaf(r, region)
	const guards = [
		...general.map((c) => lowerTotal(b, env, c.predicate, loc, leaf)),
		...guarded.flatMap((t) => t.guard.map((g) => lowerTotal(b, env, g, loc, leaf)))
	]
	const rows = isNonEmpty(guards) ? b.filter(region, b.connective("and", guards)) : region
	return {
		rows,
		values: mapNonEmpty(guarded, (t) => lowerTermTotal(b, env, t.term, loc, rowLeaf(r, rows)))
	}
}

/**
 * Each pair's met column, its source term naming its left column and `right` its target's, at the type its two terms'
 * values meet as: a field's own, pred's difference the Compute lowering's.
 */
const pairsMet = (
	pairs: NonEmptyReadonlyArray<ResolvedPair>,
	from: NonEmptyReadonlyArray<ScalarExpr>,
	to: NonEmptyReadonlyArray<ScalarExpr>,
	right: (pair: ResolvedPair) => string
): NonEmptyReadonlyArray<Met> =>
	mapNonEmpty(pairs, (pair, i) => {
		const left = from[i] ?? headNonEmpty(from)
		const target = to[i] ?? headNonEmpty(to)
		return metColumn(meetType(left.type, target.type), termText(pair.from), right(pair))
	})

/** Rows projected onto columns, each value read at its column's type. */
const projected = (
	b: ViolationBuilder,
	rows: RelNode,
	values: NonEmptyReadonlyArray<ScalarExpr>,
	columns: NonEmptyReadonlyArray<HeadingColumn>
): RelNode =>
	b.project(
		rows,
		columns.map((c, i) => [c.name, b.as(values[i] ?? headNonEmpty(values), c.type)] as const)
	)

/** A source projection with no matching target fact; the witness is the source projection. */
const containmentViolation = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	from: ResolvedSide,
	to: ResolvedSide,
	pairs: NonEmptyReadonlyArray<ResolvedPair>,
	loc: SourceLoc
): RelNode => {
	const source = sideRows(
		b,
		env,
		from,
		mapNonEmpty(pairs, (p) => p.from),
		loc
	)
	const target = sideRows(
		b,
		env,
		to,
		mapNonEmpty(pairs, (p) => p.to),
		loc
	)
	const met = pairsMet(pairs, source.values, target.values, (p) => `target#${termText(p.to)}`)
	return b.anti(
		projected(
			b,
			source.rows,
			source.values,
			mapNonEmpty(met, (m) => m.left)
		),
		projected(
			b,
			target.rows,
			target.values,
			mapNonEmpty(met, (m) => m.right)
		),
		met
	)
}

/**
 * A source fact a point of whose span no target fact of its scalar group covers. The target spans of
 * each scalar group are packed into maximal covered segments, so a source span is covered exactly when one segment
 * contains it; the violation is every source projection minus the covered ones. Both projections name each column by
 * its source term.
 */
const coverageViolation = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	from: ResolvedSide,
	to: ResolvedSide,
	pairs: NonEmptyReadonlyArray<ResolvedPair>,
	spanPair: SpanPair,
	loc: SourceLoc
): RelNode => {
	const source = sideRows(
		b,
		env,
		from,
		mapNonEmpty(pairs, (p) => p.from),
		loc
	)
	const target = sideRows(
		b,
		env,
		to,
		mapNonEmpty(pairs, (p) => p.to),
		loc
	)
	const met = pairsMet(pairs, source.values, target.values, (p) => termText(p.from))
	const paired = mapNonEmpty(pairs, (pair, i) => ({ pair, met: met[i] ?? headNonEmpty(met) }))
	const span = (paired.find((m) => m.pair === spanPair.pair) ?? headNonEmpty(paired)).met
	const sources = projected(
		b,
		source.rows,
		source.values,
		mapNonEmpty(met, (m) => m.left)
	)
	const targets = projected(
		b,
		target.rows,
		target.values,
		mapNonEmpty(met, (m) => m.right)
	)
	const scalar = paired.filter((m) => m.pair !== spanPair.pair)
	const packed = b.pack(
		targets,
		span.right,
		scalar.map((m) => m.met.right),
		`${termText(spanPair.pair.from)}#cover`
	)
	const region = b.join(
		sources,
		paired.map((m): JoinColumn =>
			m.pair === spanPair.pair ? { kind: "own", column: m.met.left } : { kind: "met", met: m.met }
		),
		packed.node,
		[packed.out]
	)
	const covered = b.filter(
		region,
		b.rangeOp(
			"range_contains",
			spanPair.from.type.carrier,
			b.col(region, packed.out),
			b.col(region, span.left)
		)
	)
	const coveredSources = b.project(
		covered,
		paired.map((m) => [m.met.left.name, b.col(covered, m.met.left)] as const)
	)
	return b.difference(sources, coveredSources)
}

/**
 * Two rows of a projected key's side that agree on its terms and differ elsewhere: both selected, each term defined.
 * pred is injective where defined, so a pred term agrees exactly where its field does. The witness is the terms'
 * values, in term order.
 */
const projectedKeyViolation = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	side: ResolvedSide,
	loc: SourceLoc
): RelNode => {
	const r = side.rel
	const shared = new Set<LawField>(side.terms.map((t) => t.column))
	const join = b.selfJoin(r, shared)
	const differs = r.fields
		.filter((f) => !shared.has(f))
		.map((f) => {
			const pair = join.pair(f)
			return b.op("ne", [b.col(join.node, pair.left), b.col(join.node, pair.right)])
		})
	/** A row expression over one of the two rows, each field read as that row's column of it. */
	const over =
		(row: "left" | "right"): LowerEnv["leaf"] =>
		(desc, at) => {
			const field = desc.kind === "field" ? r.fields.find((f) => f.name === desc.field) : undefined
			if (field === undefined) {
				return refuse(
					"MalformedDescription",
					at,
					`a field of ${r.name}, not a ${desc.kind} reference`
				)
			}
			return Result.ok(columnLeaf(join.node, join.pair(field)[row]))
		}
	const guarded = mapNonEmpty(side.terms, guardedTerm)
	const holds = (row: "left" | "right"): ReadonlyArray<ScalarExpr> => [
		...side.selection.conjuncts.map((c) => lowerTotal(b, env, c.predicate, loc, over(row))),
		...guarded.flatMap((t) => t.guard.map((g) => lowerTotal(b, env, g, loc, over(row))))
	]
	const pred = b.connective("and", [
		...holds("left"),
		...holds("right"),
		b.connective("or", differs)
	])
	const filtered = b.filter(join.node, pred)
	return b.project(
		filtered,
		mapNonEmpty(side.terms, (t, i) => {
			const term = (guarded[i] ?? headNonEmpty(guarded)).term
			return [termText(t), lowerTermTotal(b, env, term, loc, rowLeaf(r, filtered))] as const
		})
	)
}

/**
 * A parent selecting a handle with no row in that handle's arm, for every arm; the witness is the
 * parent key. Each parent key field meets every arm's field paired with it, so all arms project at one type per field.
 */
const alternativesViolation = (
	b: ViolationBuilder,
	parent: TheoryRelation,
	discriminator: LawField,
	arms: NonEmptyReadonlyArray<TheoryArm>
): RelNode => {
	/** The type a parent key field meets every arm's field paired with it as. */
	const metType = (field: LawField): ScalarType =>
		arms.reduce(
			(t, a) =>
				a.key
					.filter((p) => p.parentColumn === field)
					.reduce((u, p) => meetType(u, p.armColumn.type), t),
			field.type
		)
	return b.union(
		mapNonEmpty(arms, (a) => {
			const met = mapNonEmpty(a.key, (pair) => ({
				pair,
				met: metColumn(
					metType(pair.parentColumn),
					pair.parentColumn.name,
					`arm#${pair.parentColumn.name}`
				)
			}))
			const p = sideProjection(
				b,
				parent,
				[b.selector(parent, discriminator, a.handle)],
				met.map((m) => ({ field: m.pair.parentColumn, column: m.met.left }))
			)
			const c = sideProjection(
				b,
				a.rel,
				[],
				met.map((m) => ({ field: m.pair.armColumn, column: m.met.right }))
			)
			return b.anti(
				p,
				c,
				met.map((m) => m.met)
			)
		})
	)
}

/**
 * An alternatives arm relation's violation: a row of the arm whose key no parent fact of one of `handles` holds, the
 * handles the relation is the arm of. The witness is the arm's key, named by its fields.
 */
const alternativesArmViolation = (
	b: ViolationBuilder,
	parent: TheoryRelation,
	discriminator: LawField,
	arm: TheoryRelation,
	key: NonEmptyReadonlyArray<ResolvedArmPair>,
	handles: NonEmptyReadonlyArray<string>
): RelNode => {
	const met = mapNonEmpty(key, (pair) => ({
		pair,
		met: metColumn(
			meetType(pair.armColumn.type, pair.parentColumn.type),
			pair.arm,
			`parent#${pair.parent}`
		)
	}))
	const rows = sideProjection(
		b,
		arm,
		[],
		met.map((m) => ({ field: m.pair.armColumn, column: m.met.left }))
	)
	const parents = b.union(
		mapNonEmpty(handles, (h) =>
			sideProjection(
				b,
				parent,
				[b.selector(parent, discriminator, h)],
				met.map((m) => ({ field: m.pair.parentColumn, column: m.met.right }))
			)
		)
	)
	return b.anti(
		rows,
		parents,
		met.map((m) => m.met)
	)
}

/** The carriers a capacity compares exactly, and the integers among them, narrowest first. */
const exactCarriers: ReadonlyArray<ExactCarrier> = ["int2", "int4", "int8", "numeric", "money"]
const integerCarriers: ReadonlyArray<ExactCarrier> = ["int2", "int4", "int8"]

/**
 * The carrier a capacity's aggregate and a `ref` bound are compared in, exactly and never raising: their common carrier
 * when they are one, the wider of two integers, and numeric for any other pair of exact carriers, an integer, numeric
 * or money, each of which converts to numeric exactly. A real or double precision on either side is refused, which
 * the capacity normalization above already does for a weight and a bound, so the aggregate is bigint or numeric and a
 * money bound meets it in numeric. The law function compares in the same carrier (laws/families/capacity).
 */
const comparisonCarrier = (a: ScalarType, c: ScalarType, loc: SourceLoc): ExactCarrier => {
	const x = exactCarriers.find((e) => e === baseOf(a).carrier)
	const y = exactCarriers.find((e) => e === baseOf(c).carrier)
	if (x !== undefined && y !== undefined) {
		if (x === y) {
			return x
		}
		const ix = integerCarriers.indexOf(x)
		const iy = integerCarriers.indexOf(y)
		const wider = integerCarriers[Math.max(ix, iy)]
		return ix >= 0 && iy >= 0 && wider !== undefined ? wider : "numeric"
	}
	return refuse(
		"MalformedDescription",
		loc,
		`a capacity bound comparable with its weight exactly; ${baseOf(a).carrier} against ${baseOf(c).carrier} has no exact common carrier`
	)
}

/** A capacity's total: the count of its facts, or the sum of its weights. */
const weightedTotal = (
	weight: ScalarExpr | undefined,
	loc: SourceLoc
): { readonly overload: AggregateOverload; readonly call: AggregateCallOver<ScalarExpr> } => {
	if (weight === undefined) {
		return { overload: countOverload(), call: { fn: "count", args: [] } }
	}
	const overload = unwrapOr(unaryOverload("sum", weight.type, loc))
	return { overload, call: { fn: overload.fn, args: [weight] } }
}

/** A capacity's weight, resolved: a count, or the source field a field weight sums or a duration weight takes the width
 * of, a duration's with the span its field holds. */
export type Weighed =
	| { readonly kind: "count" }
	| { readonly kind: "field"; readonly field: LawField }
	| { readonly kind: "duration"; readonly field: LawField; readonly span: SpanInfo }

/**
 * A capacity's group total (ir/law.ts CapacityAggregate). A field weight is summed exactly, so the law function's
 * running total and a Validate's full one agree and neither raises: a sum of real or double precision rounds by the
 * order the rows arrive in, and a sum of money can overflow. So a weight is of an integer or numeric type, and its
 * aggregate bigint or numeric. A duration weight's widths are summed in numeric (capacityViolation): each the
 * difference of its endpoints, one integer digit more than an endpoint has.
 */
const capacityAggregate = (
	s: CapacityStatement,
	weighed: Weighed,
	loc: SourceLoc
): CapacityAggregate => {
	switch (weighed.kind) {
		case "count":
			return { carrier: "int8", type: countOverload().result }
		case "duration": {
			const width = numericValue({
				digits: integerDigits[weighed.span.endpoint.carrier].value + 1,
				scale: 0
			})
			return { carrier: "numeric", type: unwrapOr(unaryOverload("sum", width, loc)).result }
		}
		case "field": {
			const sum = unwrapOr(unaryOverload("sum", weighed.field.type, loc)).result
			const total = exactTotal(sum)
			if (total === undefined) {
				throw refusal(
					"UnsupportedLawFamily",
					loc,
					`a capacity weight of an integer or numeric type, summed exactly; ${s.from.relation}.${weighed.field.name} is ${baseOf(sum).carrier}`
				)
			}
			return total
		}
	}
}

/** A total of `type` when its carrier is exact, bigint or numeric. */
const exactTotal = (type: ScalarType): CapacityAggregate | undefined => {
	const carrier = baseOf(type).carrier
	return carrier === "int8" || carrier === "numeric" ? { carrier, type } : undefined
}

/**
 * A target fact whose group's count or total weight lies outside its bounds. Groups are formed over the
 * complete source facts, so every source fact contributes once; a target with no source fact has count
 * and weight zero, and is a violation exactly when zero lies outside its bounds. The witness is the target projection.
 */
const capacityViolation = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	target: ResolvedSide<FixedSelection>,
	from: ResolvedSide<FixedSelection>,
	weighed: Weighed,
	within: BoundDesc,
	bounds: CapacityBounds,
	pairs: NonEmptyReadonlyArray<ResolvedCapacityPair>,
	loc: SourceLoc
): RelNode => {
	/** Each pair with its group column, named by its target field, at the type its two fields meet as. */
	const groupsBy = mapNonEmpty(pairs, (p) => ({
		...p,
		met: metColumn(
			meetType(p.targetColumn.type, p.fromColumn.type),
			`group#${p.target}`,
			`group#${p.target}`
		)
	}))
	/** The target fields the bounds reference, each once. */
	const refs = [
		...new Set(
			[bounds.low, ...(bounds.high === undefined ? [] : [bounds.high])].flatMap((bound) =>
				bound.kind === "ref" ? [bound.field] : []
			)
		)
	]
	/** The column of the targets' projection that holds a referenced bound. */
	const boundColumn = (field: LawField): HeadingColumn => ({
		name: `bound#${field.name}`,
		type: field.type
	})
	/** The source facts, each a complete binding of its fields. */
	const sources = b.scan(from.rel, from.rel.fields, selectorsOf(from.selection))
	/** The weight's expression over a source fact; a count weighs none. */
	const weight = ((): ScalarExpr | undefined => {
		switch (weighed.kind) {
			case "count":
				return undefined
			case "field":
				return b.col(sources, weighed.field)
			case "duration": {
				const field = weighed.field
				/**
				 * A duration weight is the span's width with both endpoints cast to numeric first, upper(s)::numeric -
				 * lower(s)::numeric, summed in numeric, exactly as the law function computes it (laws/families/capacity):
				 * no width at the endpoint type's limits and no group total overflows, so the full violation query a
				 * Validate runs never raises where the incremental check passed.
				 */
				const endpoint = (fn: "lower" | "upper"): ScalarExpr =>
					b.toCarrier(
						unwrapOr(
							Result.map(
								lowerTerm(
									{ kind: "compute", fn, args: [{ kind: "var", var: field.name }] },
									{
										...env.lowerEnv,
										mode: "query",
										loc,
										emit: (spec) => b.expr(spec),
										params: noParams,
										extension: noExtension,
										leaf: (desc, at) =>
											desc.kind === "var" && desc.var === field.name
												? Result.ok(columnLeaf(sources, field))
												: refuse("MalformedDescription", at, `a field of ${from.rel.name}`)
									}
								),
								(l) => l.expr
							)
						),
						"numeric"
					)
				return b.op("sub", [endpoint("upper"), endpoint("lower")])
			}
		}
	})()
	const { overload, call } = weightedTotal(weight, loc)
	const weightColumn: HeadingColumn = { name: "weight#", type: overload.result }
	const grouped = b.group(
		sources,
		from.rel.fields,
		groupsBy.map((g) => g.fromColumn),
		[{ column: weightColumn, call, op: OpId(overload.op) }]
	)
	const groups = b.project(grouped, [
		...groupsBy.map(
			(g) => [g.met.right.name, b.as(b.col(grouped, g.fromColumn), g.met.right.type)] as const
		),
		[weightColumn.name, b.col(grouped, weightColumn)] as const
	])
	const targetRegion = b.scan(
		target.rel,
		[...groupsBy.map((g) => g.targetColumn), ...refs],
		selectorsOf(target.selection)
	)
	const targets = b.project(targetRegion, [
		...groupsBy.map(
			(g) => [g.met.left.name, b.as(b.col(targetRegion, g.targetColumn), g.met.left.type)] as const
		),
		...refs.map((field) => [boundColumn(field).name, b.col(targetRegion, field)] as const)
	])
	/** The bound predicate over a weight expression and the node whose columns hold the referenced bounds. */
	const outside = (node: RelNode, w: () => ScalarExpr): ScalarExpr => {
		const side = (bound: CapacityBound, op: "lt" | "gt") => {
			const weightExpr = w()
			if (bound.kind === "literal") {
				return b.op(op, [weightExpr, b.typed(bound.literal, weightExpr.type)])
			}
			const ref = b.col(node, boundColumn(bound.field))
			return b.op(op, [b.toCarrier(weightExpr, bound.carrier), b.toCarrier(ref, bound.carrier)])
		}
		return b.connective("or", [
			side(bounds.low, "lt"),
			...(bounds.high === undefined ? [] : [side(bounds.high, "gt")])
		])
	}
	const joined = b.join(
		targets,
		[
			...groupsBy.map((g): JoinColumn => ({ kind: "met", met: g.met })),
			...refs.map((field): JoinColumn => ({ kind: "own", column: boundColumn(field) }))
		],
		groups,
		[weightColumn]
	)
	const over = b.filter(
		joined,
		outside(joined, () => b.col(joined, weightColumn))
	)
	const witness = (node: RelNode) =>
		b.project(
			node,
			groupsBy.map((g) => [g.target, b.col(node, g.met.left)] as const)
		)
	const arms: [RelNode, ...Array<RelNode>] = [witness(over)]
	/** The empty group: weight zero, a violation only when zero lies outside the bounds. */
	const zeroOutside =
		typeof within.low !== "bigint" ||
		within.low > 0n ||
		(within.high !== "*" && (typeof within.high !== "bigint" || within.high < 0n))
	if (zeroOutside) {
		const empty = b.anti(
			targets,
			groups,
			groupsBy.map((g) => g.met)
		)
		const zero = () => b.literal(0n, overload.result, "the weight of an empty group")
		arms.push(witness(b.filter(empty, outside(empty, zero))))
	}
	return b.union(arms)
}
