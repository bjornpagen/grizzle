import {
	type JoinColumn,
	type Met,
	meetType,
	metColumn,
	refuse,
	type SelfJoin,
	unwrapOr,
	type ViolationBuilder
} from "#compiler/analysis/theory/build.ts"
import {
	axisBase,
	drawnNamed,
	type FamilyShape,
	type FamilyStatement,
	FamilyEntry,
	familyKey,
	familyShape,
	familyText,
	type FoldEntry,
	foldEntry,
	type FoldStatement,
	isTree,
	membersSelection,
	Namings,
	type Ride,
	ridesOf,
	slotsText,
	type TreeFamily,
	type TreeStatement,
	treeShape
} from "#compiler/analysis/theory/families.ts"
import { combineRule } from "#compiler/check/fold.ts"
import { compareText, ownedText, withoutSourceLocs } from "#compiler/core/canonical.ts"
import { type Identity, identifierOf } from "#compiler/core/identity.ts"
import type { Identifier } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import {
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import {
	connectiveExpr,
	type ExprDesc,
	expandAlternatives,
	type LiteralDesc,
	type MonoidName,
	type SelectionDesc,
	type TermDesc,
	termText
} from "#compiler/ir/desc.ts"
import { type ExprSpec, OpId, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { AxisKind, Family, FamilyFold } from "#compiler/ir/family.ts"
import {
	type DeclaredSide,
	type FamilyId,
	fieldNames,
	isSpanField,
	type KeyName,
	type LawField,
	type LawShape,
	type LawSource,
	type NormalizedLaw,
	type RelationInfo,
	type Selector,
	type SpanField,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import { type CombineFn, monoidSpecs } from "#compiler/ir/monoid.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { conservativeMeta, type HeadingColumn } from "#compiler/ir/rel.ts"
import {
	baseOf,
	type ContractInfo,
	contractOf,
	type ScalarType,
	spanOf
} from "#compiler/ir/scalar.ts"
import { countOverload, unaryOverload } from "#compiler/scalar/aggregate.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import {
	type LowerEnv,
	lowerPredicate,
	lowerTerm,
	noParams
} from "#compiler/scalar/compute/lower.ts"
import { guardedTerm } from "#compiler/scalar/natural.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import type { TextLookup } from "#compiler/scalar/registry.ts"
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

/**
 * A law's detail as normalization states it, before its violation query is written: a row check's predicate not yet
 * lowered, and a family's or a tree's shape before the containments it carries and the folds over it. Every written
 * detail is one of these too, so a law's identity reads either.
 */
type StatedDetail =
	| Exclude<LawDetail, { readonly kind: "check" | "family" | "tree" }>
	| StatedCheck
	| { readonly kind: "family"; readonly family: Omit<Family, "axes" | "folds"> }
	| { readonly kind: "tree"; readonly family: Omit<TreeFamily, "axes" | "folds"> }

/**
 * Where a containment lowers: to its own native, or onto the axis of a family it rides (§2.1), its pairs beyond the
 * axis's key carried by that axis's foreign key and its law among the laws the foreign key states.
 */
export type ContainmentLowering =
	| { readonly kind: "own" }
	| { readonly kind: "rides"; readonly family: FamilyId; readonly axis: AxisKind }

/**
 * What a law states beyond its shape and sides, per shape family.
 *
 * Each side's fields are its pairs' fields on that side, in pair order. A family's and a tree's detail is its resolved
 * Family, every axis's carried pairs and every fold over it included; a fold's names its family and its position among
 * the family's folds, beside the statement it is.
 */
export type LawDetail =
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
			/** Its own native, or a family axis it rides (§2.1). */
			readonly lowers: ContainmentLowering
	  }
	| { readonly kind: "family"; readonly family: Family }
	| { readonly kind: "tree"; readonly family: TreeFamily }
	| {
			readonly kind: "fold"
			readonly family: FamilyId
			/** Its position among its family's folds (Family.folds). */
			readonly fold: number
			readonly monoid: MonoidName
			/** The step side over the family's member, and the end side over its owner, as the statement declares them. */
			readonly step: ResolvedSide
			readonly end: ResolvedSide
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

/** A selector of a declared side, with the handle of the field it selects. */
export interface ResolvedSelector extends Selector {
	readonly col: LawField
}

/**
 * One conjunct of a declared side's selection, resolved: its predicate and canonical text, which a law's identity
 * reads, and the fields of its relation it reads, in declared field order. It is `fixed` when it fixes a field to a
 * literal, `field = literal` with the literal typed at its field and no other conjunct fixing that field, the form a
 * constant selection and evidence read; any other is `general`.
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

/** A selection every conjunct of which is fixed: what evidence reads, and closed facts. */
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
 * - an alternatives statement: its expansion's containments (fin.md §7), each a containment law;
 * - a family (fin.md §5.2): a member with no owner, and, ordered, two members at one slot, a slot at or past its owner's
 *   count, a slot above zero with no member below it, or a count above zero with no member at its last slot; counted,
 *   an owner whose count is not its number of members; each arm naming the owner;
 * - a tree (trees.md §2): its family's lemmas over every row but its root, and T0 to T6 with the root pin, each arm
 *   naming a row;
 * - a fold (fin.md §4.3): with its accumulators named, its copies, its combine and its identity pins; hidden, an owner
 *   whose end is not the monoid's aggregate of its members' step values; each arm naming the owner;
 * - a containment that rides a family axis and carries an accumulated column: besides, a base row of the axis whose
 *   copy is not its start, each arm naming the axis's group.
 *
 * A containment pairing more than one span field is UnsupportedLawFamily. Coverage into a target without a span key has
 * an exact violation query and is normalized; its lowering, not its meaning, is what law specialization refuses.
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
	/** What lowering a law's predicate or term reads of the schema's types, and the closed relations it may apply. */
	readonly lowerEnv: {
		readonly fieldType: LowerEnv["fieldType"]
		readonly patterns: PatternAutomata
		readonly patternLanguage: TextLookup
		readonly closed: LowerEnv["closed"]
	}
}

/** A statement's pairs as a containment from its left side into its right. */
const leftToRight = (
	pairs: NonEmptyReadonlyArray<SidePair>
): NonEmptyReadonlyArray<ContainmentPair> =>
	mapNonEmpty(pairs, (p) => ({ from: p.left, to: p.right }))

/** Each field as a field term. */
const termsOfFields = (fields: ReadonlyArray<string>): ReadonlyArray<TermDesc> =>
	fields.map((field) => ({ kind: "field", field }))

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

/** A side's scope: its relation and its selection, the terms beside it. */
const scopeOf = (side: {
	readonly relation: string
	readonly selection: SelectionDesc
}): SideScope => ({
	relation: side.relation,
	selection: side.selection
})

/** A side over `relation` whose selection is `conjuncts`. */
const scopeOver = (relation: string, conjuncts: ReadonlyArray<ExprDesc>): SideScope => ({
	relation,
	selection: { conjuncts }
})

/** The two sides of a containment paired term by term: sides of one width. */
const pairedTerms = (
	left: { readonly relation: string; readonly terms: NonEmptyReadonlyArray<TermDesc> },
	right: { readonly relation: string; readonly terms: NonEmptyReadonlyArray<TermDesc> },
	loc: SourceLoc
): NonEmptyReadonlyArray<ContainmentPair> =>
	mapNonEmpty(left.terms, (from, j) => {
		const to = right.terms[j]
		if (to === undefined || right.terms.length !== left.terms.length) {
			return refuse(
				"MalformedDescription",
				loc,
				`a containment between sides of one width; on(${left.relation}, …) names ${left.terms.length} term(s) and on(${right.relation}, …) ${right.terms.length}`
			)
		}
		return { from, to }
	})

/** A field as a field term. */
const termOf = (f: LawField): TermDesc => ({ kind: "field", field: f.name })

/** A field as a description's operand, its contract stripped to its base: the form a fold's combine is proved in. */
const based = (f: LawField): ExprDesc => ({ kind: "base", arg: { kind: "field", field: f.name } })

/** `f`'s value holds the handle `h` of its roster: the set {h} meets it. */
const holds = (f: LawField, h: string): ExprDesc => ({
	kind: "not",
	arg: {
		kind: "compute",
		fn: "disjoint",
		args: [
			{ kind: "literal", value: { handles: [h] }, type: f.desc },
			{ kind: "field", field: f.name }
		]
	}
})

/**
 * A copy an axis carries whose source column is accumulated, pinned at the axis's base: its relation's rows where `at`
 * is 0 hold `start` in `field` (w4-w7 §2.3, OPEN-F2 (b)).
 */
interface Pin {
	readonly relation: RelationInfo
	readonly at: LawField
	readonly field: LawField
	/**
	 * What the field holds at the base: its start; or, at a tree's root, which references itself on the owner axis, the
	 * root's own value of the field the copy carries, as the axis's foreign key gives it.
	 */
	readonly base:
		| { readonly kind: "start"; readonly start: TypedLiteral }
		| { readonly kind: "own"; readonly field: LawField }
}

/**
 * The sides a family's laws read, each resolved once where its law is kept: the members over their group, over their
 * slots and over their predecessors' slots, and the owner over its key, over its count and over its last slot. The
 * slot sides are an ordered family's, whose index is a field.
 */
interface FamilySides {
	readonly witness: NonEmptyReadonlyArray<HeadingColumn>
	readonly group: ResolvedSide
	readonly owner: ResolvedSide
	readonly counted: ResolvedSide
	readonly slots:
		| {
				readonly at: ResolvedSide
				readonly before: ResolvedSide
				readonly last: ResolvedSide
		  }
		| undefined
}

/** The sides a tree's own laws read beside its family's (trees.md T0 to T6). */
interface TreeSides {
	/** T0: each member's root field in its parent's. */
	readonly rootCopy: readonly [ResolvedSide, ResolvedSide]
	/** T1: the root field and start, a key of every row. */
	readonly order: ResolvedSide
	/** T3: each first child's start less one is its parent's start. */
	readonly first: readonly [ResolvedSide, ResolvedSide]
	/** T4: each later child's start is its predecessor's end. */
	readonly next: readonly [ResolvedSide, ResolvedSide]
	/** T5: each parent's last child's end is the parent's end. */
	readonly close: readonly [ResolvedSide, ResolvedSide]
	/** T2, the root pin and T6, row checks of the tree relation. */
	readonly checks: ReadonlyArray<ExprDesc>
}

/** The sides one fold's law reads: its copies and pins when its accumulators are fields, its aggregate when hidden. */
type FoldSides =
	| {
			readonly kind: "visible"
			/** Per plane: the predecessor copy before ← after, and the last copy end ← after. */
			readonly planes: NonEmptyReadonlyArray<{
				readonly copy: readonly [ResolvedSide, ResolvedSide]
				readonly last: readonly [ResolvedSide, ResolvedSide]
				readonly before: LawField
				readonly end: LawField
				readonly identity: TypedLiteral
			}>
			readonly index: LawField
			/** The combine every member row proves, after = combine(before, x) where the step selects it. */
			readonly combine: ExprDesc
	  }
	| {
			readonly kind: "aggregate"
			readonly monoid: "count" | "sum" | "max"
			/** The members the fold steps over, by their group. */
			readonly members: ResolvedSide
			/** The owner over its key and its end. */
			readonly owner: ResolvedSide
			readonly x: LawField | undefined
			readonly identity: TypedLiteral
	  }
	| {
			readonly kind: "handles"
			/** Per handle of the step value's roster, the members holding it and the owners whose end plane holds it. */
			readonly handles: NonEmptyReadonlyArray<{
				readonly members: ResolvedSide
				readonly ends: NonEmptyReadonlyArray<ResolvedSide>
			}>
	  }

export class Normalizer {
	readonly env: NormalizeEnv
	readonly #primaryKeys: Array<PrimaryKeyKept> = []
	readonly #laws: Array<KeptLaw> = []
	/** Each kept law by its identity's canonical text, so an equivalent draft merges into it. */
	readonly #byIdentity = new Map<string, KeptLaw>()
	/** Every family and tree by its key (families.ts familyKey), in statement order: the axes a containment may ride. */
	readonly #families = new Map<string, FamilyEntry>()
	/** Which statement names each drawn and accumulated field. */
	readonly #namings = new Namings()
	/** The families once `resolve` has lowered their folds, by key. */
	#resolved: ReadonlyMap<string, Family> | undefined

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
	 * as one statement repeated at two levels states) merged into the law kept first. `onNew` sees a new law once.
	 */
	#push(draft: StatedDraft, tracked: SourceLoc): KeptLaw {
		return this.#pushing(draft, tracked, () => undefined)
	}

	/** Keeps a draft as `#push` does, `onNew` seeing a new law once, after it joins the laws. */
	#pushing(draft: StatedDraft, tracked: SourceLoc, onNew: (kept: KeptLaw) => void): KeptLaw {
		return this.#keep(lawDraft(draft), tracked, (kept) => {
			this.#laws.push(kept)
			onNew(kept)
		})
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

	/**
	 * Every family and tree statement's shape, before any law is normalized, so a containment knows the axes it may
	 * ride wherever it stands among the statements: one count counts one family, a relation is a member of at most one
	 * sequence (an ordered family or a tree) and of any number of counted families, each with its own axes and law
	 * columns, and each family names its drawn fields.
	 */
	families(statements: ReadonlyArray<OwnedStatement>): void {
		/** Each member relation's sequence, an ordered family or a tree: the caller nests a sequence's members, so one
		 * relation's rows are nested under at most one (rows-first §1). */
		const sequences = new Map<string, FamilyShape>()
		for (const s of statements) {
			if (s.kind !== "family" && s.kind !== "tree") {
				continue
			}
			const shape =
				s.kind === "family" ? familyShape(s, this.env.relations) : treeShape(s, this.env.relations)
			const key = familyKey(shape.id)
			const known = this.#families.get(key)
			if (known !== undefined) {
				refuse(
					"MalformedDescription",
					s.loc,
					`one count counts one family; ${slotsText(shape.id)} counts ${familyText(known.shape)} and ${familyText(shape)}`
				)
			}
			if (shape.index.kind === "field") {
				const sequence = sequences.get(shape.member.name)
				if (sequence !== undefined) {
					refuse(
						"MalformedDescription",
						s.loc,
						`a relation is a member of at most one ordered family or tree, which orders it, and of any number of counted ones; ${shape.member.name} is a member of ${familyText(sequence)} and of ${familyText(shape)}`
					)
				}
				sequences.set(shape.member.name, shape)
			}
			this.#families.set(key, new FamilyEntry(shape, s.loc))
			for (const d of drawnNamed(shape)) {
				this.#namings.name(d.relation, d.field, familyText(shape))
			}
		}
	}

	/**
	 * One statement's laws. An alternatives statement's are its containments (fin.md §7, desc.ts expandAlternatives),
	 * each a containment law of source `alternatives`, so a restated one is one law with both statements.
	 */
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
					{ statement: index, kind: "contained" },
					loc
				)
				return
			case "alternatives":
				for (const c of expandAlternatives(s)) {
					this.containment(
						scopeOf(c.left),
						scopeOf(c.right),
						pairedTerms(c.left, c.right, loc),
						{ statement: index, kind: "alternatives" },
						loc
					)
				}
				return
			case "family":
				this.#family(s, index)
				return
			case "tree":
				this.#tree(s, index)
				return
			case "fold":
				this.#fold(s, index)
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

	/** The family `id` counts, refused when no family or tree statement states one. */
	#entry(id: FamilyId, loc: SourceLoc): FamilyEntry {
		return (
			this.#families.get(familyKey(id)) ??
			refuse(
				"MalformedDescription",
				loc,
				`a fold over a family an ordered, counted or tree statement states; ${slotsText(id)} counts none`
			)
		)
	}

	/** Each family's shape, in statement order: what `ridesOf` tries. */
	*#shapes(): Generator<FamilyShape> {
		for (const entry of this.#families.values()) {
			yield entry.shape
		}
	}

	/** The family `id` resolved: its axes and folds complete, which only `resolve` makes. */
	#resolvedFamily(id: FamilyId): Family {
		const family = this.#resolved?.get(familyKey(id))
		if (family === undefined) {
			throw defect("a family law's violation is written after the theory resolves its families")
		}
		return family
	}

	/** The sides a family's lemmas read (FamilySides), over its members' selection. */
	#familySides(f: FamilyShape, loc: SourceLoc): FamilySides {
		const members = membersSelection(f)
		const group = mapNonEmpty(f.group, (p) => termOf(p.member))
		const keys = mapNonEmpty(f.group, (p) => termOf(p.owner))
		const memberSide = (terms: NonEmptyReadonlyArray<TermDesc>): ResolvedSide =>
			this.side(scopeOver(f.member.name, members), terms, loc)
		const ownerSide = (terms: NonEmptyReadonlyArray<TermDesc>): ResolvedSide =>
			this.side(scopeOver(f.owner.name, []), terms, loc)
		const index = f.index.kind === "field" ? f.index.field.name : undefined
		return {
			witness: familyWitness(f),
			group: memberSide(group),
			owner: ownerSide(keys),
			counted: ownerSide([...keys, termOf(f.count)]),
			slots:
				index === undefined
					? undefined
					: {
							at: memberSide([...group, { kind: "field", field: index }]),
							before: memberSide([...group, { kind: "pred", field: index }]),
							last: ownerSide([...keys, { kind: "pred", field: f.count.name }])
						}
		}
	}

	/** The family law `f`'s statement states, at `source`, with the sides its identity reads. */
	#familyIdentity(f: FamilyShape, source: LawSource): Omit<LawIdentity, "statements" | "detail"> {
		return {
			shape: source.kind === "tree" ? "tree" : "family",
			source,
			sides: [
				{
					relation: f.member.name,
					terms: [
						...f.group.map((p) => termOf(p.member)),
						...(f.index.kind === "field" ? [termOf(f.index.field)] : [])
					]
				},
				{ relation: f.owner.name, terms: [...f.group.map((p) => termOf(p.owner)), termOf(f.count)] }
			]
		}
	}

	/** An ordered or counted family's law: its lemmas (fin.md §5.2), read over its fields. */
	#family(s: FamilyStatement, index: number): void {
		const loc = s.loc
		const f = this.#entry(s.slots, loc).shape
		const sides = this.#familySides(f, loc)
		this.#keep(
			{
				identity: {
					...this.#familyIdentity(f, { statement: index, kind: "family" }),
					detail: { kind: "family", family: f }
				},
				sources: [{ index, loc }],
				write: (b) => ({
					violation: b.union(familyArms(b, this.env, sides, loc)),
					detail: { kind: "family", family: this.#resolvedFamily(f.id) }
				})
			},
			loc,
			(kept) => this.#laws.push(kept)
		)
	}

	/**
	 * A tree's law (trees.md): its family's lemmas over its members, every row but its root, and T0 to T6 with the root
	 * pin. Its copies are its axes' pairs: ‹ps› → start and r → r on the owner axis (T3, T0), start → end on the
	 * predecessor (T4), end → end on the last (T5).
	 */
	#tree(s: TreeStatement, index: number): void {
		const loc = s.loc
		const entry = this.#entry(s.slots, loc)
		const f = entry.shape
		if (!isTree(f)) {
			throw defect("a tree statement's family is a tree")
		}
		const sides = this.#familySides(f, loc)
		const t = f.members
		const parent = headNonEmpty(f.group).member
		const key = headNonEmpty(f.group).owner
		const at =
			f.index.kind === "field" ? f.index.field : defectField("a tree's index is its at field")
		const members = membersSelection(f)
		const every = (terms: NonEmptyReadonlyArray<TermDesc>): ResolvedSide =>
			this.side(scopeOver(f.member.name, []), terms, loc)
		const memberSide = (
			terms: NonEmptyReadonlyArray<TermDesc>,
			more: ReadonlyArray<ExprDesc>
		): ResolvedSide => this.side(scopeOver(f.member.name, [...members, ...more]), terms, loc)
		const field = (g: LawField): ExprDesc => ({ kind: "field", field: g.name })
		const zero: ExprDesc = { kind: "literal", value: 0n, type: undefined }
		const compare = (op: "eq" | "ne" | "gt", l: ExprDesc, r: ExprDesc): ExprDesc => ({
			kind: "compare",
			op,
			left: l,
			right: r
		})
		/** T2: the root is the one self-parented row, at start 0. */
		const rooted = connectiveExpr("or", [
			connectiveExpr("and", [
				compare("eq", field(parent), field(key)),
				compare("eq", field(t.start), zero)
			]),
			connectiveExpr("and", [
				compare("ne", field(parent), field(key)),
				compare("ne", field(t.start), zero)
			])
		])
		/** The root pin: the root, outside its family, is at slot 0. */
		const pinned = connectiveExpr("or", [
			compare("gt", field(t.start), zero),
			compare("eq", field(at), zero)
		])
		/** T6: every interval is non-empty, and a leaf's holds exactly itself. */
		const nonEmpty = connectiveExpr("and", [
			compare("gt", field(t.end), field(t.start)),
			connectiveExpr("or", [
				compare("gt", field(f.count), zero),
				compare("eq", based(t.end), {
					kind: "compute",
					fn: "add",
					args: [based(t.start), { kind: "literal", value: 1n, type: undefined }]
				})
			])
		])
		const tree: TreeSides = {
			rootCopy: [
				memberSide([termOf(parent), termOf(t.root)], []),
				every([termOf(key), termOf(t.root)])
			],
			order: every([termOf(t.root), termOf(t.start)]),
			first: [
				memberSide(
					[termOf(parent), { kind: "pred", field: t.start.name }],
					[compare("eq", field(at), zero)]
				),
				every([termOf(key), termOf(t.start)])
			],
			next: [
				memberSide([termOf(parent), { kind: "pred", field: at.name }, termOf(t.start)], []),
				memberSide([termOf(parent), termOf(at), termOf(t.end)], [])
			],
			close: [
				every([termOf(key), { kind: "pred", field: f.count.name }, termOf(t.end)]),
				memberSide([termOf(parent), termOf(at), termOf(t.end)], [])
			],
			checks: [rooted, pinned, nonEmpty]
		}
		this.#keep(
			{
				identity: {
					...this.#familyIdentity(f, { statement: index, kind: "tree" }),
					detail: { kind: "tree", family: f }
				},
				sources: [{ index, loc }],
				write: (b) => {
					const resolved = this.#resolvedFamily(f.id)
					if (resolved.members.kind !== "tree") {
						throw defect("a tree's resolved family keeps its tree members")
					}
					return {
						violation: b.union([
							...familyArms(b, this.env, sides, loc),
							...treeArms(b, this.env, sides.witness, f.member, tree, loc)
						]),
						detail: { kind: "tree", family: { ...resolved, members: resolved.members } }
					}
				}
			},
			loc,
			(kept) => {
				this.#laws.push(kept)
				const law = identifierOf(kept.named)
				entry.carry(
					"owner",
					{ kind: "law", column: t.parentStart },
					{ kind: "field", field: t.start },
					law
				)
				entry.carry(
					"owner",
					{ kind: "field", field: t.root },
					{ kind: "field", field: t.root },
					law
				)
				entry.carry(
					"predecessor",
					{ kind: "field", field: t.start },
					{ kind: "field", field: t.end },
					law
				)
				entry.carry("last", { kind: "field", field: t.end }, { kind: "field", field: t.end }, law)
			}
		)
	}

	/**
	 * A fold over a family (fin.md §4.3): resolved by families.ts foldEntry, which refuses what check/fold.ts foldRule
	 * refuses, and its proving CHECK typed by combineRule. Its copies are its family's axes' pairs, before ← after on the
	 * predecessor axis and end ← after on the last, and it names its accumulators and ends.
	 */
	#fold(s: FoldStatement, index: number): void {
		const loc = s.loc
		const entry = this.#entry(s.family, loc)
		const f = entry.shape
		const number = entry.folds.length
		const step = this.side(s.step, s.step.terms, loc)
		const end = this.side(s.end, s.end.terms, loc)
		const detail: Extract<LawDetail, { readonly kind: "fold" }> = {
			kind: "fold",
			family: f.id,
			fold: number,
			monoid: s.monoid,
			step,
			end
		}
		const identity = {
			shape: "fold" as const,
			source: { statement: index, kind: "fold" as const },
			sides: [step, end],
			detail
		}
		/** The fold's law's identifier, which names its hidden accumulators: its identity is no position among the
		 * family's folds, so removing another fold renames none of them. */
		const law = identifierOf(this.env.named({ ...identity, statements: [index] }))
		const fold = foldEntry(s, f, law)
		const monoid = monoidSpecs[s.monoid]
		const plane =
			fold.step.kind === "value" ? fold.step.field.type : headNonEmpty(fold.planes).end.type
		const unproved = combineRule(monoid, plane)
		if (unproved !== undefined) {
			refuse("MalformedDescription", loc, unproved)
		}
		const sides = this.#foldSides(f, fold, loc)
		const witness = familyWitness(f)
		this.#pushing(
			{
				identity,
				sources: [{ index, loc }],
				violation: (b) => b.union(foldArms(b, this.env, witness, f, sides, loc))
			},
			loc,
			(kept) => {
				entry.fold(fold, identifierOf(kept.named))
				for (const named of fold.named) {
					this.#namings.name(
						named.relation,
						named.field,
						`the ${s.monoid} fold over ${slotsText(f.id)}`
					)
				}
			}
		)
	}

	/** The sides a fold's law reads (FoldSides). */
	#foldSides(f: FamilyShape, fold: FoldEntry, loc: SourceLoc): FoldSides {
		const members = membersSelection(f)
		const group = mapNonEmpty(f.group, (p) => termOf(p.member))
		const keys = mapNonEmpty(f.group, (p) => termOf(p.owner))
		const memberSide = (
			terms: NonEmptyReadonlyArray<TermDesc>,
			more: ReadonlyArray<ExprDesc>
		): ResolvedSide => this.side(scopeOver(f.member.name, [...members, ...more]), terms, loc)
		const ownerSide = (
			terms: NonEmptyReadonlyArray<TermDesc>,
			more: ReadonlyArray<ExprDesc>
		): ResolvedSide => this.side(scopeOver(f.owner.name, more), terms, loc)
		const x = fold.step.kind === "value" ? fold.step.field : undefined
		if (fold.visible) {
			const index =
				f.index.kind === "field" ? f.index.field : defectField("a visible fold's family is ordered")
			const planes = mapNonEmpty(fold.planes, (p) => {
				const before =
					p.before.kind === "field" ? p.before.field : defectField("a visible before is a field")
				const after =
					p.after.kind === "field" ? p.after.field : defectField("a visible after is a field")
				return {
					copy: [
						memberSide([...group, { kind: "pred", field: index.name }, termOf(before)], []),
						memberSide([...group, termOf(index), termOf(after)], [])
					] as const,
					last: [
						ownerSide([...keys, { kind: "pred", field: f.count.name }, termOf(p.end)], []),
						memberSide([...group, termOf(index), termOf(after)], [])
					] as const,
					before,
					end: p.end,
					identity: p.identity
				}
			})
			const monoid = monoidSpecs[fold.monoid]
			const befores = mapNonEmpty(planes, (p) => based(p.before))
			const combined = monoid.combine<ExprDesc>(
				befores,
				x === undefined ? { kind: "one" } : { kind: "value", expr: based(x) },
				{
					one: { kind: "literal", value: 1n, type: undefined },
					apply: (fn: CombineFn, left, right) => ({ kind: "compute", fn, args: [left, right] })
				}
			)
			const afters = mapNonEmpty(fold.planes, (p) =>
				p.after.kind === "field" ? p.after.field : defectField("a visible after is a field")
			)
			const stepped = connectiveExpr(
				"and",
				afters.map((after, i): ExprDesc => ({
					kind: "compare",
					op: "eq",
					left: based(after),
					right: combined[i] ?? headNonEmpty(combined)
				}))
			)
			const kept = connectiveExpr(
				"and",
				afters.map((after, i): ExprDesc => ({
					kind: "compare",
					op: "eq",
					left: based(after),
					right: befores[i] ?? headNonEmpty(befores)
				}))
			)
			const selects = connectiveExpr("and", fold.where)
			return {
				kind: "visible",
				planes,
				index,
				combine:
					fold.where.length === 0
						? stepped
						: connectiveExpr("or", [
								connectiveExpr("and", [selects, stepped]),
								connectiveExpr("and", [{ kind: "not", arg: selects }, kept])
							])
			}
		}
		const stepping = memberSide(group, fold.where)
		switch (fold.monoid) {
			case "count":
			case "sum":
			case "max": {
				const p = headNonEmpty(fold.planes)
				return {
					kind: "aggregate",
					monoid: fold.monoid,
					members: stepping,
					owner: ownerSide([...keys, termOf(p.end)], []),
					x,
					identity: p.identity
				}
			}
			case "or":
			case "twos": {
				const roster =
					x === undefined
						? undefined
						: ((): ReadonlyArray<string> | undefined => {
								const base = baseOf(x.type)
								return base.carrier === "bits" ? base.roster.handles : undefined
							})()
				if (x === undefined || roster === undefined || !isNonEmpty(roster)) {
					throw defect(`foldRule admits ${fold.monoid} over a set's carrier`)
				}
				return {
					kind: "handles",
					handles: mapNonEmpty(roster, (h) => ({
						members: memberSide(group, [...fold.where, holds(x, h)]),
						ends: mapNonEmpty(fold.planes, (p) => ownerSide(keys, [holds(p.end, h)]))
					}))
				}
			}
			case "concat":
				throw defect("foldRule admits a concat fold only with its (before, after) pair named")
		}
	}

	/**
	 * The containment `statement` states from `from` into `to`, each source term paired with the target term it meets,
	 * declared by `source`, tracked at `tracked`. A containment of a family axis's shape rides it (families.ts ridesOf):
	 * its pairs beyond the axis's key join the axis's, each accumulated source column among them filled by it and pinned
	 * at the axis's base, which its law then states too. One of a span pair is coverage, a PERIOD foreign key of its own.
	 */
	containment(
		from: SideScope,
		to: SideScope,
		pairs: NonEmptyReadonlyArray<ContainmentPair>,
		source: LawSource,
		tracked: SourceLoc
	): KeptLaw {
		const loc = tracked
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
		const ride: Ride | undefined =
			span === undefined ? ridesOf(this.#shapes(), fromSide, toSide, resolved) : undefined
		const entry = ride === undefined ? undefined : this.#entry(ride.family, loc)
		const pins = ride === undefined || entry === undefined ? [] : ridingPins(entry.shape, ride)
		const width = resolved.length - (ride?.carried.length ?? 0)
		const violation = (b: ViolationBuilder): RelNode => {
			if (span !== undefined) {
				return coverageViolation(b, this.env, fromSide, toSide, resolved, span, loc)
			}
			const own = containmentViolation(b, this.env, fromSide, toSide, resolved, loc)
			const [lead, ...rest] = own.heading.slice(0, width)
			if (!isNonEmpty(pins) || lead === undefined) {
				return own
			}
			/** A pinned copy's law names its axis's group: the key a base row and a source tuple both hold. */
			const witness: NonEmptyReadonlyArray<HeadingColumn> = [lead, ...rest]
			const group = mapNonEmpty(
				witness,
				(_, j) => (resolved[j] ?? headNonEmpty(resolved)).from.column
			)
			return b.union([
				witnessed(b, own, witness),
				...mapNonEmpty(pins, (pin) => pinViolation(b, pin, group, witness))
			])
		}
		return this.#pushing(
			{
				identity: {
					shape: containmentShape(
						span === undefined ? { kind: "scalar" } : { kind: "span", ...span }
					),
					source,
					sides: [fromSide, toSide],
					detail: {
						kind: "containment",
						from: fromSide,
						to: toSide,
						pairs: resolved,
						pairing: span === undefined ? { kind: "scalar" } : { kind: "span", ...span },
						lowers:
							ride === undefined
								? { kind: "own" }
								: { kind: "rides", family: ride.family, axis: ride.axis }
					}
				},
				sources: [{ index: source.statement, loc }],
				violation
			},
			tracked,
			(kept) => {
				const display = `the containment ${kept.named.display}`
				if (ride === undefined || entry === undefined) {
					for (const p of resolved) {
						if (p.from.kind === "field" && p.from.column.writing.kind === "accumulated") {
							this.#namings.unridden(fromRel.name, p.from.column.name, display)
						}
					}
					return
				}
				const law = identifierOf(kept.named)
				for (const p of ride.carried) {
					entry.carry(
						ride.axis,
						{ kind: "field", field: p.from.column },
						{ kind: "field", field: p.to.column },
						law
					)
					if (p.from.column.writing.kind === "accumulated" && fromRel.kind === "relation") {
						this.#namings.name(fromRel, p.from.column, display)
					}
				}
			}
		)
	}

	/** Refuses a drawn or accumulated field no statement names, or two do: called once every statement is normalized. */
	finish(): void {
		this.#namings.refuseMisnamed(this.env.relations.values())
	}

	/**
	 * Every family resolved, in statement order: its axes' pairs complete, and each fold's step selection lowered into
	 * the theory's DAG over a scan of the member's row, as a row check's predicate is. Called once, after `finish` and
	 * before any law's violation is written, which reads the resolved families.
	 */
	resolve(b: ViolationBuilder): ReadonlyArray<Family> {
		const families = [...this.#families.values()].map((entry): Family => {
			const shape = entry.shape
			const folds = entry.folds.map((f): FamilyFold => {
				const region = b.scan(shape.member, shape.member.fields, [])
				return Object.freeze({
					monoid: f.monoid,
					where: Object.freeze(
						f.where.map((c) => lowerTotal(b, this.env, c, f.loc, rowLeaf(shape.member, region)))
					),
					step: f.step,
					planes: Object.freeze(mapNonEmpty(f.planes, (p) => Object.freeze({ ...p })))
				})
			})
			return Object.freeze({ ...shape, axes: entry.axes(), folds: Object.freeze(folds) })
		})
		this.#resolved = new Map(families.map((f) => [familyKey(f.id), f] as const))
		return Object.freeze(families)
	}

	/**
	 * The fields each family statement pairs, beside its containments' pairs: each member group field with its owner key
	 * field, a fold's step value with its accumulators and ends, and a tree's start with its end (T4, T5), so the field
	 * classes hold every pairing a family's laws compare.
	 */
	familyPairings(): ReadonlyArray<{
		readonly a: string
		readonly f: LawField
		readonly b: string
		readonly g: LawField
		readonly loc: SourceLoc
	}> {
		return [...this.#families.values()].flatMap((entry) => {
			const shape = entry.shape
			const loc = entry.loc
			const group = shape.group.map((p) => ({
				a: shape.member.name,
				f: p.member,
				b: shape.owner.name,
				g: p.owner,
				loc
			}))
			const tree =
				shape.members.kind === "tree"
					? [
							{
								a: shape.member.name,
								f: shape.members.start,
								b: shape.member.name,
								g: shape.members.end,
								loc
							}
						]
					: []
			const folds = entry.folds.flatMap((fold) => {
				const x = fold.step.kind === "value" ? fold.step.field : undefined
				return fold.named.flatMap((n) =>
					x === undefined
						? []
						: [{ a: shape.member.name, f: x, b: n.relation.name, g: n.field, loc: fold.loc }]
				)
			})
			return [...group, ...tree, ...folds]
		})
	}
}

/** A family law's witness: its owner's key, each column at the type the member's group field and it meet as. */
const familyWitness = (f: FamilyShape): NonEmptyReadonlyArray<HeadingColumn> =>
	mapNonEmpty(f.group, (p) => ({ name: p.owner.name, type: meetType(p.member.type, p.owner.type) }))

/** A defect: a field the resolved shape guarantees. */
const defectField = (what: string): never => {
	throw defect(what)
}

/**
 * The pins of a riding containment's accumulated carried columns, at its axis's base: the copy's start there, but on a
 * tree's owner axis, whose root references itself, the root's own value of the field it copies.
 */
const ridingPins = (f: FamilyShape, ride: Ride): ReadonlyArray<Pin> => {
	const base = axisBase(f, ride.axis)
	const own = ride.axis === "owner" && f.members.kind === "tree"
	return base === undefined
		? []
		: ride.carried.flatMap((p): ReadonlyArray<Pin> => {
				const w = p.from.column.writing
				return w.kind === "accumulated"
					? [
							{
								relation: base.relation,
								at: base.at,
								field: p.from.column,
								base: own ? { kind: "own", field: p.to.column } : { kind: "start", start: w.start }
							}
						]
					: []
			})
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
		case "closedAt":
		case "closedRow":
			return e.args.some((a) => mentions(a, field))
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
 * The pairs of rows of a projected key's side that agree on its terms and differ elsewhere: both selected, each term
 * defined. pred is injective where defined, so a pred term agrees exactly where its field does.
 */
const clashes = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	side: ResolvedSide,
	loc: SourceLoc
): { readonly filtered: RelNode; readonly join: SelfJoin } => {
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
	const holdsAt = (row: "left" | "right"): ReadonlyArray<ScalarExpr> => [
		...side.selection.conjuncts.map((c) => lowerTotal(b, env, c.predicate, loc, over(row))),
		...guarded.flatMap((t) => t.guard.map((g) => lowerTotal(b, env, g, loc, over(row))))
	]
	const pred = b.connective("and", [
		...holdsAt("left"),
		...holdsAt("right"),
		b.connective("or", differs)
	])
	return { filtered: b.filter(join.node, pred), join }
}

/**
 * Two rows of a projected key's side that agree on its terms and differ elsewhere (`clashes`). The witness is the
 * terms' values, in term order.
 */
const projectedKeyViolation = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	side: ResolvedSide,
	loc: SourceLoc
): RelNode => {
	const r = side.rel
	const { filtered } = clashes(b, env, side, loc)
	const guarded = mapNonEmpty(side.terms, guardedTerm)
	return b.project(
		filtered,
		mapNonEmpty(side.terms, (t, i) => {
			const term = (guarded[i] ?? headNonEmpty(guarded)).term
			return [termText(t), lowerTermTotal(b, env, term, loc, rowLeaf(r, filtered))] as const
		})
	)
}

/**
 * `node`'s rows as a family law's witness: its first columns, in order, each read at the witness column's type. Every
 * arm of a family's, a tree's or a fold's violation names the owner whose family breaks, so the arms are one heading.
 */
const witnessed = (
	b: ViolationBuilder,
	node: RelNode,
	witness: NonEmptyReadonlyArray<HeadingColumn>
): RelNode =>
	b.project(
		node,
		witness.map((w, j) => {
			const column = node.heading[j]
			if (column === undefined) {
				throw defect("a family law's arm leads with its witness columns")
			}
			return [w.name, b.as(b.col(node, column), w.type)] as const
		})
	)

/** Two sides' terms paired by position: a lemma's sides are of one width. */
const zipped = (from: ResolvedSide, to: ResolvedSide): NonEmptyReadonlyArray<ResolvedPair> =>
	mapNonEmpty(from.terms, (t, j) => ({ from: t, to: to.terms[j] ?? headNonEmpty(to.terms) }))

/** A lemma containment's violation between two resolved sides of one width. */
const lemma = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	sides: readonly [ResolvedSide, ResolvedSide],
	loc: SourceLoc
): RelNode => containmentViolation(b, env, sides[0], sides[1], zipped(sides[0], sides[1]), loc)

/** The zero of a natural, the base every axis's pin and every family's emptiness reads. */
const zeroLiteral: TypedLiteral = Object.freeze({ kind: "int", value: 0n })

/**
 * The rows of `pin.relation` at its axis's base, `at` zero, whose `field` is not its base value, projected onto the
 * fields `group` as `witness`: an accumulated copy, or a fold's accumulator, off its start where the axis has no row to
 * copy, or a tree root's copy off its own value.
 */
const pinViolation = (
	b: ViolationBuilder,
	pin: Pin,
	group: NonEmptyReadonlyArray<LawField>,
	witness: NonEmptyReadonlyArray<HeadingColumn>
): RelNode => {
	const own = pin.base.kind === "own" ? [pin.base.field] : []
	const region = b.scan(pin.relation, [pin.at, pin.field, ...own, ...group], [])
	const baseValue =
		pin.base.kind === "own"
			? b.col(region, pin.base.field)
			: b.typed(pin.base.start, pin.field.type)
	const off = b.filter(
		region,
		b.connective("and", [
			b.op("eq", [b.col(region, pin.at), b.typed(zeroLiteral, pin.at.type)]),
			b.op("ne", [b.col(region, pin.field), baseValue])
		])
	)
	return b.project(
		off,
		mapNonEmpty(
			witness,
			(w, j) => [w.name, b.as(b.col(off, group[j] ?? headNonEmpty(group)), w.type)] as const
		)
	)
}

/** A row of `r` whose predicate is false, named by `witness`, each read from the field of `fields` at its position. */
const rowViolation = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	r: TheoryRelation,
	predicate: ExprDesc,
	fields: NonEmptyReadonlyArray<LawField>,
	witness: NonEmptyReadonlyArray<HeadingColumn>,
	loc: SourceLoc
): RelNode => {
	const region = b.scan(r, r.fields, [])
	const pred = lowerTotal(b, env, predicate, loc, rowLeaf(r, region))
	const refused = b.filter(region, b.not(pred))
	return b.project(
		refused,
		mapNonEmpty(
			witness,
			(w, j) => [w.name, b.as(b.col(refused, fields[j] ?? headNonEmpty(fields)), w.type)] as const
		)
	)
}

/**
 * The facts of a side's relation its selection holds on, every field bound so that two facts agreeing on some fields are
 * two rows: what a group counts or sums.
 */
const sideFacts = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	side: ResolvedSide,
	loc: SourceLoc
): RelNode => {
	const r = side.rel
	const conjuncts = side.selection.conjuncts
	const region = b.scan(
		r,
		r.fields,
		conjuncts.flatMap((c) => (c.kind === "fixed" ? [c.selector] : []))
	)
	const general = conjuncts.flatMap((c) => (c.kind === "general" ? [c] : []))
	return isNonEmpty(general)
		? b.filter(
				region,
				b.connective(
					"and",
					general.map((c) => lowerTotal(b, env, c.predicate, loc, rowLeaf(r, region)))
				)
			)
		: region
}

/** Whether two values differ, compared in their common carrier, or in numeric when their carriers differ (a sum). */
const differ = (b: ViolationBuilder, left: ScalarExpr, right: ScalarExpr): ScalarExpr =>
	baseOf(left.type).carrier === baseOf(right.type).carrier
		? b.op("ne", [left, right])
		: b.op("ne", [b.toCarrier(left, "numeric"), b.toCarrier(right, "numeric")])

/**
 * An owner whose end is not the aggregate of its members' values: the members of `members` (over the group, the
 * selection what the aggregate steps over) grouped by their group, `aggregate` over each group, against `owner`'s end
 * (over the key, then the end); and an owner of no member whose end is not `identity`, the aggregate of none.
 */
const aggregateArms = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	members: ResolvedSide,
	owner: ResolvedSide,
	aggregate: "count" | "sum" | "max",
	x: LawField | undefined,
	identityLiteral: TypedLiteral,
	loc: SourceLoc
): readonly [RelNode, RelNode] => {
	const facts = sideFacts(b, env, members, loc)
	const groupFields = mapNonEmpty(members.terms, (t) => t.column)
	const overload =
		aggregate === "count" || x === undefined
			? countOverload()
			: unwrapOr(unaryOverload(aggregate, x.type, loc))
	const value: HeadingColumn = { name: "aggregate#", type: overload.result }
	const grouped = b.group(facts, members.rel.fields, groupFields, [
		{
			column: value,
			call:
				overload.fn === "count" || x === undefined
					? { fn: "count", args: [] }
					: { fn: overload.fn, args: [b.col(facts, x)] },
			op: OpId(overload.op)
		}
	])
	const keyFields = owner.terms.slice(0, groupFields.length)
	const met = mapNonEmpty(groupFields, (g, j) => {
		const k = keyFields[j] ?? headNonEmpty(owner.terms)
		return metColumn(meetType(k.column.type, g.type), `key#${j}`, `key#${j}`)
	})
	const groups = b.project(grouped, [
		...met.map(
			(m, j) =>
				[
					m.right.name,
					b.as(b.col(grouped, groupFields[j] ?? headNonEmpty(groupFields)), m.right.type)
				] as const
		),
		[value.name, b.col(grouped, value)] as const
	])
	const ownerRows = sideRows(b, env, owner, owner.terms, loc)
	const endValue = ownerRows.values[groupFields.length]
	if (endValue === undefined) {
		throw defect("an aggregate's owner side holds its key, then its end")
	}
	const end: HeadingColumn = { name: "end#", type: endValue.type }
	const owners = b.project(ownerRows.rows, [
		...met.map(
			(m, j) => [m.left.name, b.as(ownerRows.values[j] ?? endValue, m.left.type)] as const
		),
		[end.name, endValue] as const
	])
	const joined = b.join(
		owners,
		[...met.map((m): JoinColumn => ({ kind: "met", met: m })), { kind: "own", column: end }],
		groups,
		[value]
	)
	const unequal = b.filter(joined, differ(b, b.col(joined, end), b.col(joined, value)))
	const empty = b.anti(owners, groups, met)
	const off = b.filter(empty, b.op("ne", [b.col(empty, end), b.typed(identityLiteral, end.type)]))
	return [unequal, off]
}

/**
 * A member whose index is past its owner's count: the members over (g…, i) joined with the owners over (k…, n) on the
 * group, where i ≥ n.
 */
const pastCount = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	at: ResolvedSide,
	counted: ResolvedSide,
	loc: SourceLoc
): RelNode => {
	const members = sideRows(b, env, at, at.terms, loc)
	const owners = sideRows(b, env, counted, counted.terms, loc)
	const width = at.terms.length - 1
	const index = members.values[width]
	const count = owners.values[width]
	if (index === undefined || count === undefined) {
		throw defect("a family's slot sides end with its index and its count")
	}
	const met = members.values
		.slice(0, width)
		.map((v, j) =>
			metColumn(meetType(v.type, (owners.values[j] ?? count).type), `key#${j}`, `key#${j}`)
		)
	const i: HeadingColumn = { name: "index#", type: index.type }
	const n: HeadingColumn = { name: "count#", type: count.type }
	const left = b.project(members.rows, [
		...met.map((m, j) => [m.left.name, b.as(members.values[j] ?? index, m.left.type)] as const),
		[i.name, index] as const
	])
	const right = b.project(owners.rows, [
		...met.map((m, j) => [m.right.name, b.as(owners.values[j] ?? count, m.right.type)] as const),
		[n.name, count] as const
	])
	const joined = b.join(
		left,
		[...met.map((m): JoinColumn => ({ kind: "met", met: m })), { kind: "own", column: i }],
		right,
		[n]
	)
	return b.filter(joined, b.op("ge", [b.col(joined, i), b.col(joined, n)]))
}

/**
 * A family's lemmas (fin.md §5.2) over its fields, each arm naming the owner whose family breaks:
 *
 * - every member has an owner: F[g] ⊆ O[k];
 * - ordered: no two members share a slot, every slot is below its owner's count, the downward closure F(g, pred(i)) ⊆
 *   F(g, i), and the last slot O(k, pred(n)) ⊆ F(g, i), so each owner's slots are exactly 0 … n − 1;
 * - counted: each owner's count is its number of members, 0 for an owner of none.
 */
const familyArms = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	s: FamilySides,
	loc: SourceLoc
): NonEmptyReadonlyArray<RelNode> => {
	const w = (node: RelNode): RelNode => witnessed(b, node, s.witness)
	const orphan = w(lemma(b, env, [s.group, s.owner], loc))
	if (s.slots === undefined) {
		const [unequal, off] = aggregateArms(
			b,
			env,
			s.group,
			s.counted,
			"count",
			undefined,
			zeroLiteral,
			loc
		)
		return [orphan, w(unequal), w(off)]
	}
	return [
		orphan,
		w(projectedKeyViolation(b, env, s.slots.at, loc)),
		w(pastCount(b, env, s.slots.at, s.counted, loc)),
		w(lemma(b, env, [s.slots.before, s.slots.at], loc)),
		w(lemma(b, env, [s.slots.last, s.slots.at], loc))
	]
}

/**
 * A tree's own laws beside its family's (trees.md T0 to T6), each arm naming a row of the tree: T0, each member's root
 * field its parent's; T1, (r, start) a key; T2, the root pin and T6, row checks; T3, each first child's start one past
 * its parent's; T4, each later child's start its predecessor's end; T5, each parent's end its last child's end.
 */
const treeArms = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	witness: NonEmptyReadonlyArray<HeadingColumn>,
	t: RelationInfo,
	s: TreeSides,
	loc: SourceLoc
): ReadonlyArray<RelNode> => {
	const w = (node: RelNode): RelNode => witnessed(b, node, witness)
	const key = mapNonEmpty(witness, (_, j) => t.primaryFields[j] ?? headNonEmpty(t.primaryFields))
	return [
		w(lemma(b, env, s.rootCopy, loc)),
		clashViolation(b, env, s.order, key, witness, loc),
		...s.checks.map((c) => rowViolation(b, env, t, c, key, witness, loc)),
		w(lemma(b, env, s.first, loc)),
		w(lemma(b, env, s.next, loc)),
		w(lemma(b, env, s.close, loc))
	]
}

/**
 * Two rows of a projected key's side that agree on its terms and differ elsewhere, named by the left row's `fields`
 * as `witness`: a tree's T1, whose violation names its rows by their key.
 */
const clashViolation = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	side: ResolvedSide,
	fields: NonEmptyReadonlyArray<LawField>,
	witness: NonEmptyReadonlyArray<HeadingColumn>,
	loc: SourceLoc
): RelNode => {
	const { filtered, join } = clashes(b, env, side, loc)
	return b.project(
		filtered,
		mapNonEmpty(
			witness,
			(wc, j) =>
				[
					wc.name,
					b.as(b.col(filtered, join.pair(fields[j] ?? headNonEmpty(fields)).left), wc.type)
				] as const
		)
	)
}

/**
 * A fold's law (fin.md §4.3), each arm naming the owner whose fold breaks:
 *
 * - accumulators named by its step side: each plane's before is its predecessor's after, and its identity at the first
 *   slot; each member's after is combine(before, x) where the step selects it and its before elsewhere; each owner's
 *   end is its last member's after, and its identity for an empty family;
 * - hidden accumulators: each owner's end is the monoid's aggregate of its selected members' step values, its identity
 *   for none: their count, their exact sum, or their greatest value; for or, each handle in the end exactly when a
 *   selected member holds it; for twos, besides, each handle in the twos plane exactly when two selected members do.
 */
const foldArms = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	witness: NonEmptyReadonlyArray<HeadingColumn>,
	f: FamilyShape,
	s: FoldSides,
	loc: SourceLoc
): NonEmptyReadonlyArray<RelNode> => {
	const w = (node: RelNode): RelNode => witnessed(b, node, witness)
	const group = mapNonEmpty(f.group, (p) => p.member)
	const keys = mapNonEmpty(f.group, (p) => p.owner)
	switch (s.kind) {
		case "visible": {
			const member = f.member
			const owner = f.owner
			const arms = s.planes.flatMap((p) => [
				w(lemma(b, env, p.copy, loc)),
				pinViolation(
					b,
					{
						relation: member,
						at: s.index,
						field: p.before,
						base: { kind: "start", start: p.identity }
					},
					group,
					witness
				),
				w(lemma(b, env, p.last, loc)),
				pinViolation(
					b,
					{
						relation: owner,
						at: f.count,
						field: p.end,
						base: { kind: "start", start: p.identity }
					},
					keys,
					witness
				)
			])
			return [rowViolation(b, env, f.member, s.combine, group, witness, loc), ...arms]
		}
		case "aggregate": {
			const [unequal, off] = aggregateArms(
				b,
				env,
				s.members,
				s.owner,
				s.monoid,
				s.x,
				s.identity,
				loc
			)
			return [w(unequal), w(off)]
		}
		case "handles": {
			const arms = s.handles.flatMap((h) => {
				const [ones, twos] = h.ends
				const held = [
					w(lemma(b, env, [h.members, ones], loc)),
					w(lemma(b, env, [ones, h.members], loc))
				]
				return twos === undefined
					? held
					: [...held, ...twoMembers(b, env, h.members, twos, witness, loc)]
			})
			if (!isNonEmpty(arms)) {
				throw defect("a set's roster holds a handle")
			}
			return arms
		}
	}
}

/**
 * twos' second plane at one handle: an owner holding the handle in it with fewer than two members holding it, and an
 * owner with two members holding it whose plane lacks it. Two members agree on the group and differ elsewhere.
 */
const twoMembers = (
	b: ViolationBuilder,
	env: NormalizeEnv,
	members: ResolvedSide,
	ends: ResolvedSide,
	witness: NonEmptyReadonlyArray<HeadingColumn>,
	loc: SourceLoc
): readonly [RelNode, RelNode] => {
	const pairs = projectedKeyViolation(b, env, members, loc)
	const owners = sideRows(b, env, ends, ends.terms, loc)
	const met = mapNonEmpty(witness, (wc) => metColumn(wc.type, wc.name, `pair#${wc.name}`))
	const held = b.project(
		owners.rows,
		mapNonEmpty(
			met,
			(m, j) =>
				[m.left.name, b.as(owners.values[j] ?? headNonEmpty(owners.values), m.left.type)] as const
		)
	)
	const twice = b.project(
		pairs,
		mapNonEmpty(met, (m, j) => {
			const column = pairs.heading[j] ?? headNonEmpty(witness)
			return [m.right.name, b.as(b.col(pairs, column), m.right.type)] as const
		})
	)
	const lacking = b.anti(
		twice,
		held,
		mapNonEmpty(met, (m) => metColumn(m.left.type, m.right.name, m.left.name))
	)
	return [witnessed(b, b.anti(held, twice, met), witness), witnessed(b, lacking, witness)]
}
