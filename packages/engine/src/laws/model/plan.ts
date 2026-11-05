import {
	fixedSelection,
	type ResolvedSelection,
	type ResolvedSelector,
	type ResolvedSide,
	type ResolvedTerm,
	selectorsOf,
	type TheoryArm,
	type TheoryLaw,
	type Weighed
} from "#compiler/analysis/theory/laws.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import type { Identity } from "#compiler/core/identity.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	dedupeNonEmpty,
	extendNonEmpty,
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import * as Order from "#compiler/core/order.ts"
import { fieldTermsOf, type LiteralDesc, type Refs, termText } from "#compiler/ir/desc.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type AlternativesArm,
	type AlternativesCheck,
	type Anchor,
	type AnchorPair,
	type CapacityBound,
	type CheckedBound,
	type ClosedTheoryRelation,
	type DetailCodec,
	type EventsOf,
	type FamilyDetail,
	fieldNames,
	type FieldSelector,
	type FieldValue,
	type ImageGuard,
	isSpanField,
	type KeyName,
	type LawField,
	type LawWeight,
	participantEvents,
	plainFields,
	type RosterHandle,
	type Selector,
	type SpanField,
	type SpanKeyScalars,
	type TheoryRelation
} from "#compiler/ir/law.ts"

import {
	allRows,
	defaultOpclass,
	type IndexRequest,
	type IndexRows,
	type LawIndexRequest
} from "#compiler/ir/products.ts"
import { closedCell, type KeySet, type RelNode } from "#compiler/ir/rel.ts"
import { baseOf, type Carrier, rosterOf, type SpanInfo } from "#compiler/ir/scalar.ts"
import { literalKey } from "#compiler/laws/model/names.ts"
import type { OwnedContract } from "#compiler/schema/own.ts"

/** A refusal deep inside recognition is a core Refusal, which the model's boundary returns (`catchRefusal`). */
const refuse = (tag: ProseTag, loc: SourceLoc, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, loc, capability)))
}

/** A key of `relation` over `key` whose index entry is unrepresentable, for `fault`. */
const unrepresentable = (
	loc: SourceLoc,
	subject: string,
	key: ReadonlyArray<string>,
	fault: KeyFault
): never => {
	throw new Refusal(CompileError.make({ _tag: "UnrepresentableKey", at: loc, subject, key, fault }))
}

/** A selector as a residual law, its guards and its indexes record it: its column's name and its value, the resolved
 * column left with the theory, so what the law's digest reads is the names alone. */
const plainSelector = (s: Selector): Selector => ({ column: s.column, value: s.value })

/** Literal selectors in their relation's declared field order. */
const orderedSelectors = (
	selection: ReadonlyArray<ResolvedSelector>
): ReadonlyArray<ResolvedSelector> => selection.toSorted((a, b) => a.col.position - b.col.position)

/** A selection as an index's rows record it, by name, in the relation's declared field order. */
const orderedSelection = (selection: ReadonlyArray<ResolvedSelector>): ReadonlyArray<Selector> =>
	orderedSelectors(selection).map(plainSelector)

/** A selector as a native object, a residual law and its guards read it: the handle of its field, and its literal. */
const fieldSelector = (s: ResolvedSelector): FieldSelector => ({ field: s.col, value: s.value })

/**
 * A column a law adds to its relation, as planned (ir/law.ts LawColumn), its name and expressions still to settle: a
 * constant a selected target fixes on its source `relation`, the value of the target's `field`; or a term of a side of
 * `relation` under the side's selection, a pred term or any term of a selected side. A field term over every fact is
 * the field itself, never a law column (`sideColumns`).
 */
export type LawColumnPlan =
	| {
			readonly kind: "constant"
			readonly relation: TheoryRelation
			readonly target: TheoryRelation
			readonly field: LawField
			readonly value: TypedLiteral
	  }
	| {
			readonly kind: "term"
			readonly relation: TheoryRelation
			readonly term: ResolvedTerm
			readonly selection: ResolvedSelection
	  }

/** A constant law column, which a constant selection places on its source. */
type ConstantColumn = Extract<LawColumnPlan, { readonly kind: "constant" }>

/** A column a planned native reads: a field, or a law column. */
export type PlannedColumn =
	| { readonly kind: "field"; readonly field: LawField }
	| { readonly kind: "law"; readonly column: LawColumnPlan }

/** A field as a planned native reads it. */
const fieldColumn = (field: LawField): PlannedColumn => ({ kind: "field", field })

/** A native object as planned: the frozen NativeObject kinds, with a law column still symbolic, a foreign key's deferral
 * still to decide, and a generated CHECK still to lower. */
export type NativePlan =
	| {
			readonly kind: "PrimaryKey"
			readonly relation: TheoryRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
			readonly named: Identity<"primaryKey" | "key">
	  }
	| {
			readonly kind: "Unique"
			readonly relation: TheoryRelation
			readonly columns: NonEmptyReadonlyArray<PlannedColumn>
	  }
	| { readonly kind: "Domain"; readonly contract: OwnedContract }
	| {
			readonly kind: "TableCheck"
			readonly relation: TheoryRelation
			readonly name: string
			readonly named: Identity<"check">
			/** The predicate as the check law's violation query lowers it. */
			readonly predicate: ScalarExpr
	  }
	| {
			readonly kind: "GeneratedCheck"
			readonly relation: TheoryRelation
			/** The predicate over the table's own columns, lowered in "check" mode, where no operation raises. */
			readonly predicate: CheckPredicate
	  }
	| { readonly kind: "Enum"; readonly name: string; readonly handles: ReadonlyArray<string> }
	| {
			readonly kind: "FiniteCheck"
			readonly relation: TheoryRelation
			readonly facts: ReadonlyArray<NonEmptyReadonlyArray<FieldValue>>
	  }
	| {
			readonly kind: "ForeignKey"
			readonly relation: TheoryRelation
			readonly columns: NonEmptyReadonlyArray<PlannedColumn>
			readonly target: TheoryRelation
			readonly targetColumns: NonEmptyReadonlyArray<PlannedColumn>
	  }
	| { readonly kind: "LawColumn"; readonly column: LawColumnPlan }
	| {
			readonly kind: "WithoutOverlaps"
			readonly relation: TheoryRelation
			readonly span: SpanField
			readonly key: SpanKeyScalars
			readonly named: Identity<"primaryKey" | "key">
	  }
	| {
			readonly kind: "PeriodForeignKey"
			readonly relation: TheoryRelation
			readonly columns: ReadonlyArray<PlannedColumn>
			readonly span: SpanField
			readonly target: TheoryRelation
			readonly targetColumns: ReadonlyArray<PlannedColumn>
			readonly targetSpan: SpanField
	  }
	| {
			readonly kind: "TemporalUnique"
			readonly relation: TheoryRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
			readonly span: SpanField
	  }
	| {
			readonly kind: "ReverseIndex"
			readonly relation: TheoryRelation
			readonly columns: NonEmptyReadonlyArray<PlannedColumn>
	  }

/** The law column natives a list of planned columns reads, each once. */
const lawColumns = (columns: ReadonlyArray<PlannedColumn>): ReadonlyArray<NativePlan> =>
	columns.flatMap((c): ReadonlyArray<NativePlan> =>
		c.kind === "law" ? [{ kind: "LawColumn", column: c.column }] : []
	)

/**
 * The columns a side lowers to, one per term (§ partial projections): a field term of an unselected side is its field;
 * every term of a selected side, and every pred term, is a law column generated `CASE WHEN φ THEN t END`, null
 * wherever the side reads no tuple, so a key over it holds apart only the rows it reads and a reference from it
 * references only from them.
 */
const sideColumns = (side: ResolvedSide): NonEmptyReadonlyArray<PlannedColumn> =>
	mapNonEmpty(side.terms, (term): PlannedColumn =>
		term.kind === "field" && side.selection.conjuncts.length === 0
			? fieldColumn(term.column)
			: {
					kind: "law",
					column: { kind: "term", relation: side.rel, term, selection: side.selection }
				}
	)

/** A primary key's native object as planned: a PRIMARY KEY, or a primary key WITHOUT OVERLAPS. */
export type PrimaryKeyPlan =
	| Extract<NativePlan, { readonly kind: "PrimaryKey" }>
	| (Extract<NativePlan, { readonly kind: "WithoutOverlaps" }> & {
			readonly key: Extract<SpanKeyScalars, { readonly kind: "primary" }>
	  })

/**
 * The native object of the primary key `key` of `r`: a PRIMARY KEY over a scalar key, or its span field last WITHOUT
 * OVERLAPS. A primary key whose only field is a span has no native lowering: PostgreSQL's PRIMARY KEY needs a column
 * before WITHOUT OVERLAPS (42601), and an exclusion constraint is no primary key, so it is UnrepresentableKey.
 */
export const primaryKeyPlan = (r: TheoryRelation, key: KeyName, loc: SourceLoc): PrimaryKeyPlan => {
	const { fields, span, named } = key
	if (span === undefined) {
		return { kind: "PrimaryKey", relation: r, columns: fields, named }
	}
	const scalars = fields.filter((f) => f !== span)
	if (!isNonEmpty(scalars)) {
		return unrepresentable(loc, `the primary key of ${r.name}`, fieldNames(fields), {
			kind: "spanAlone",
			field: span.name
		})
	}
	return { kind: "WithoutOverlaps", relation: r, span, key: { kind: "primary", scalars }, named }
}

/** A participant field and its family's pairing at the anchor-key field its value gives (ir/law.ts KeyComponent). */
export interface KeyColumn {
	readonly field: LawField
	readonly pair: AnchorPair
}

/** One row image of an event, each participant field that gives the anchor key from it with the anchor-key column it
 * gives, in anchor-key order, and its guard: the selection of the side the image plays, which a row outside it fails
 * (`ImageGuard`). An INSERT's image is of NEW and a DELETE's of OLD, so the event it belongs to is its side. */
export interface ImagePlan {
	readonly key: NonEmptyReadonlyArray<KeyColumn>
	readonly guard: ImageGuard
}

/** The image key of the anchor itself: each pair's anchor-key field gives its own column. */
const anchorColumns = (
	pairs: NonEmptyReadonlyArray<AnchorPair>
): NonEmptyReadonlyArray<KeyColumn> => mapNonEmpty(pairs, (pair) => ({ field: pair.anchor, pair }))

/** The image key of the paired side: each pair's own field gives its anchor-key column. */
const pairedColumns = (
	pairs: NonEmptyReadonlyArray<AnchorPair>
): NonEmptyReadonlyArray<KeyColumn> => mapNonEmpty(pairs, (pair) => ({ field: pair.field, pair }))

/** The anchor key paired with itself: the pairs of a family that pairs no side by the key. */
const ownPairs = (key: NonEmptyReadonlyArray<LawField>): NonEmptyReadonlyArray<AnchorPair> =>
	mapNonEmpty(key, (f) => ({ field: f, anchor: f }))

/** Each pair's field of one side with the anchor-key field it meets. */
const anchorPairs = <P>(
	pairs: NonEmptyReadonlyArray<P>,
	field: (pair: P) => LawField,
	anchor: (pair: P) => LawField
): NonEmptyReadonlyArray<AnchorPair> =>
	mapNonEmpty(pairs, (p) => ({ field: field(p), anchor: anchor(p) }))

/** An image every row of its relation gives. */
const always: ImageGuard = { kind: "always" }

/** An image of a side chosen by `selection`: a row the selection rejects gives none, an unselected side's every row does. */
const guardBy = (selection: ReadonlyArray<ResolvedSelector>): ImageGuard =>
	isNonEmpty(selection)
		? { kind: "selected", selections: [mapNonEmpty(selection, fieldSelector)] }
		: always

/** A participant's threatening events as planned: an INSERT, a DELETE or both, each with the row images that give its
 * affected anchor keys, and for a mutable relation the fields whose UPDATE matters, an UPDATE being the deletion of OLD
 * and the insertion of NEW, so its images are theirs. */
export type PlanEvents = EventsOf<NonEmptyReadonlyArray<ImagePlan>, NonEmptyReadonlyArray<LawField>>

/** One participating table of a residual law and its threatening events. */
export interface ParticipantPlan {
	readonly relation: TheoryRelation
	readonly events: PlanEvents
}

/** An alternatives law's participant plan, with what its writes can leave unpaid. */
export interface AlternativesPlan extends ParticipantPlan {
	readonly check: AlternativesCheck
}

/** What an arm relation's writes can leave unpaid: its own arms. */
type ArmsCheck = Extract<AlternativesCheck, { readonly kind: "arms" }>

/** An arm relation's participant plan, re-checking its own arms. */
interface ArmPlan extends ParticipantPlan {
	readonly check: ArmsCheck
}

/** The UPDATE OF fields of a participant: only a mutable relation has an UPDATE, no role holding UPDATE on an
 * immutable relation. Its images are its DELETE's and its INSERT's (ir/law.ts updateImages). */
const updateOf = (
	relation: TheoryRelation,
	of: NonEmptyReadonlyArray<LawField>
): NonEmptyReadonlyArray<LawField> | undefined => (relation.mutable ? of : undefined)

/** A participant whose INSERT threatens, at `image` of NEW, and whose UPDATE OF `of` does for a mutable relation. */
const inserting = (
	relation: TheoryRelation,
	image: ImagePlan,
	of: NonEmptyReadonlyArray<LawField>
): ParticipantPlan => ({
	relation,
	events: { insert: [image], delete: undefined, update: updateOf(relation, of) }
})

/** A participant whose DELETE threatens, at `image` of OLD, and whose UPDATE OF `of` does for a mutable relation. */
const deleting = (
	relation: TheoryRelation,
	image: ImagePlan,
	of: NonEmptyReadonlyArray<LawField>
): ParticipantPlan => ({
	relation,
	events: { insert: undefined, delete: [image], update: updateOf(relation, of) }
})

/** What each family checks beyond its anchor, with its participants as planned: one per relation. */
type PlannedDetail = FamilyDetail<
	NonEmptyReadonlyArray<ParticipantPlan>,
	NonEmptyReadonlyArray<AlternativesPlan>
>

interface ResidualPlan {
	/** The family, what it checks beyond the anchor, and its participants. */
	readonly checks: PlannedDetail
	readonly anchor: Anchor
	readonly violation: RelNode
	readonly indexes: NonEmptyReadonlyArray<Omit<LawIndexRequest, "justification">>
	readonly detail: DetailCodec
}

export interface LawPlan {
	readonly law: TheoryLaw
	readonly natives: ReadonlyArray<NativePlan>
	/** The law's residual check, none for a law its natives enforce alone. */
	readonly residual: ResidualPlan | undefined
}

const sameSet = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean =>
	a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))

const contains = <T>(outer: ReadonlyArray<T>, inner: ReadonlyArray<T>): boolean =>
	inner.every((x) => outer.includes(x))

const declaredKeys = (r: TheoryRelation): ReadonlyArray<KeySet> => [r.primaryKey, ...r.keys]

/** The handles of each declared key's fields, the primary key's first. */
const declaredFields = (r: TheoryRelation): ReadonlyArray<NonEmptyReadonlyArray<LawField>> => [
	r.primaryFields,
	...r.keyFields
]

/** The declared keys of `r` with no span field. */
const scalarKeys = (r: TheoryRelation): ReadonlyArray<NonEmptyReadonlyArray<LawField>> =>
	declaredFields(r).filter((k) => !k.some(isSpanField))

/** The DETAIL codec of a residual law whose violating facts are facts of `r`: their key
 * columns only, never a payload column. A projection that is exactly a declared key of `r` is spelled in the
 * projection's order, which is the order the function holds it in; any other projection, a superkey or a group key
 * that some payload field enters, is replaced by the primary key, which the function reads from the violating fact. */
const detailOf = (r: TheoryRelation, fields: NonEmptyReadonlyArray<LawField>): DetailCodec => ({
	relation: r,
	keys: declaredFields(r).some((k) => sameSet<LawField>(k, fields)) ? fields : r.primaryFields
})

/** `fields`, each a field of `r`, once each in declared field order. */
const inHeadingOrder = (fields: NonEmptyReadonlyArray<LawField>): NonEmptyReadonlyArray<LawField> =>
	sortNonEmpty(
		dedupeNonEmpty(fields),
		Order.mapInput(Order.compareNumbers, (f: LawField) => f.position)
	)

/** A term of a generated CHECK: a field of the row, a literal, or the width of a span field. A field carries its
 * handle beside its name, and a width the span its field holds, which the lowering reads them at. */
type FieldTerm = { readonly kind: "field"; readonly field: string; readonly column: LawField }

/** The references of a generated CHECK's predicate lowered as an expression: its table's own fields, each with its
 * handle, and no other leaf. */
export interface CheckRefs extends Refs {
	readonly var: never
	readonly parent: never
	readonly interior: never
	readonly leaf: FieldTerm
}

export type CheckTerm =
	| FieldTerm
	| { readonly kind: "literal"; readonly value: LiteralDesc; readonly type: undefined }
	| {
			readonly kind: "compute"
			readonly fn: "width"
			readonly args: readonly [FieldTerm]
			readonly span: SpanInfo
	  }
/** A term a literal meets: a field of the row, or a span field's width. A literal never stands first. */
type MetTerm = Exclude<CheckTerm, { readonly kind: "literal" }>

/** A generated CHECK's predicate over its table's own fields: comparisons of terms under and, or and not. */
export type CheckPredicate =
	| {
			readonly kind: "compare"
			readonly op: "eq" | "ne" | "ge" | "le"
			readonly left: CheckTerm
			readonly right: CheckTerm
	  }
	| { readonly kind: "and"; readonly args: NonEmptyReadonlyArray<CheckPredicate> }
	| { readonly kind: "or"; readonly args: NonEmptyReadonlyArray<CheckPredicate> }
	| { readonly kind: "not"; readonly arg: CheckPredicate }

const field = (column: LawField): FieldTerm => ({ kind: "field", field: column.name, column })

/** The carrier a literal opposite `term` is lowered at, which the generated CHECK's lowering adopts from the term it
 * meets (`operand`): a field's own, or a width's, an exact integer, the difference of its span's endpoints. */
const metCarrier = (term: MetTerm): Carrier => {
	switch (term.kind) {
		case "field":
			return baseOf(term.column.type).carrier
		case "compute":
			return "exactInteger"
	}
}

/** The literal `literal` stated in the host convention of the carrier it meets, which the Description lowering reads it
 * in (`irLiteral`): an integer is a JavaScript number at int2 and int4 and a bigint elsewhere.
 * A bound the carrier cannot hold stays irLiteral's typed refusal: beyond 2^53 - 1 the number is no safe integer, and
 * within it the range check refuses what int2 or int4 cannot hold. */
const literalAt = (carrier: Carrier, literal: TypedLiteral): CheckTerm => {
	switch (literal.kind) {
		case "int": {
			return {
				kind: "literal",
				value: carrier === "int2" || carrier === "int4" ? Number(literal.value) : literal.value,
				type: undefined
			}
		}
		case "numeric":
		case "float":
		case "money":
		case "bool":
		case "text":
		case "uuid":
		case "vector":
			return { kind: "literal", value: literal.value, type: undefined }
		case "floatSpecial":
			return { kind: "literal", value: { float: literal.value }, type: undefined }
		case "enum":
			return { kind: "literal", value: literal.handle, type: undefined }
		case "span":
			return {
				kind: "literal",
				value: { span: { start: literal.start, end: literal.end } },
				type: undefined
			}
	}
}

/** `left <op> literal`, the literal typed at the term it meets. */
const compareLiteral = (
	op: "eq" | "ne" | "ge" | "le",
	left: MetTerm,
	literal: TypedLiteral
): CheckPredicate => ({
	kind: "compare",
	op,
	left,
	right: literalAt(metCarrier(left), literal)
})

/** A predicate over a row with its statically known parts folded: `true` and `false` are decided, anything else is a
 * CheckPredicate. */
type Pred = boolean | CheckPredicate

const andP = (ps: ReadonlyArray<Pred>): Pred => {
	if (ps.includes(false)) {
		return false
	}
	const rest = ps.flatMap((p) => (typeof p === "boolean" ? [] : [p]))
	if (!isNonEmpty(rest)) {
		return true
	}
	return rest.length === 1 ? headNonEmpty(rest) : { kind: "and", args: rest }
}

const orP = (ps: ReadonlyArray<Pred>): Pred => {
	if (ps.includes(true)) {
		return true
	}
	const rest = ps.flatMap((p) => (typeof p === "boolean" ? [] : [p]))
	if (!isNonEmpty(rest)) {
		return false
	}
	return rest.length === 1 ? headNonEmpty(rest) : { kind: "or", args: rest }
}

const notP = (p: Pred): Pred => (typeof p === "boolean" ? !p : { kind: "not", arg: p })

/** A literal selection over a row of its relation, each selector compared at its column's type. */
const selectionPred = (selection: ReadonlyArray<ResolvedSelector>): Pred =>
	andP(
		selection.map((s): Pred => ({
			kind: "compare",
			op: "eq",
			left: field(s.col),
			right: literalAt(baseOf(s.col.type).carrier, s.value)
		}))
	)

/** A closed fact projected onto columns: each column with the fact's value of it. */
type ClosedTuple<C> = NonEmptyReadonlyArray<{ readonly column: C; readonly value: TypedLiteral }>

/** A closed tuple's values as one comparable text. */
const tupleKey = <C>(tuple: ClosedTuple<C>): string =>
	tuple.map((c) => literalKey(c.value)).join("\u0000")

/** A side's selectors, or the refusal of `what` over a side with a conjunct that fixes no field, which `what` reads as
 * a conjunction of field = literal alone. */
const literalsOf = (
	side: ResolvedSide,
	loc: SourceLoc,
	what: string
): ReadonlyArray<ResolvedSelector> => {
	const fixed = fixedSelection(side.selection)
	return fixed === undefined
		? refuse(
				"UnsupportedLawFamily",
				loc,
				`${what} whose sides select by conjunctions of field = literal; select(${side.relation}, ...) selects by another predicate`
			)
		: selectorsOf(fixed)
}

/** A side's fields, or the refusal of `what` over a side with a pred term, which `what` reads as fields alone. */
const fieldsOf = (
	side: ResolvedSide,
	loc: SourceLoc,
	what: string
): NonEmptyReadonlyArray<LawField> => {
	const fields = fieldTermsOf(side.terms)
	return fields === undefined
		? refuse(
				"UnsupportedLawFamily",
				loc,
				`${what} over fields; ${side.relation}(${side.terms.map(termText).join(", ")}) has a pred term`
			)
		: mapNonEmpty(fields, (t) => t.column)
}

/** Whether a key over `key` keys `target`: every conjunct of the key's selection is one of the target's, which so
 * reads only facts the key holds apart, and the target's terms hold every term of the key, each of one kind over one
 * field. */
const keyedBy = (key: ResolvedSide, target: ResolvedSide): boolean =>
	key.selection.conjuncts.every((k) => target.selection.conjuncts.some((c) => c.text === k.text)) &&
	key.terms.every((k) => target.terms.some((t) => t.kind === k.kind && t.column === k.column))

/** The recognition table: each normalized law to its plan of native objects and at most one residual law. Laws are
 * database obligations.
 *
 * A shape the recognizer does not know is rejected, never interpreted. Each case below states the row it
 * implements; everything else is refused with UnsupportedLawFamily, naming what the compiler admits. A plan is
 * pure data: law column names, foreign key deferral and the generated CHECK predicates are settled afterwards, over
 * every plan at once (`compileLaws`), because they depend on the whole schema.
 *
 * The rules it implements, the partial projections first:
 *
 * - A side lowers to one column per term (`sideColumns`): an unselected side's field term is its field, and every term
 *   of a selected side and every pred term is a law column generated `CASE WHEN φ₁ AND … THEN t END` STORED over its
 *   selection's conjuncts, pred(x) being `CASE WHEN x > 0 THEN x - 1 END` (scalar/natural.ts guardedTerm). A row whose
 *   side reads no tuple holds a null there.
 * - A key over a side is UNIQUE NULLS DISTINCT over its columns, which holds apart only the rows the side reads.
 * - A containment is FOREIGN KEY MATCH SIMPLE from the source's columns, which references nothing from a row whose side
 *   reads no tuple, into a UNIQUE over exactly the target's columns, and its referencing columns are indexed. The
 *   target must contain a key: a declared key of its relation among its field terms, or a projected key of the
 *   relation whose conjuncts are among the target's and whose terms are among its terms. Its UNIQUE is that key's when
 *   the columns are exactly a declared key's, and otherwise a generated superkey, exact because a superkey of a key is
 *   unique.
 * - A constant selection of a target: its fixed conjuncts over fields that are none of its terms, which, with its field
 *   terms, contain a declared key of the target, are a constant law column each on the source instead, matched against
 *   the target's terms under its other conjuncts and then its fixed fields, so every constant shares one target
 *   UNIQUE. An alternatives arm of one handle is one: its parent selected by the handle.
 * - A selected source into closed facts is a row CHECK conditional on its selector: `NOT <selector> OR <tuple in the
 *   facts>`. A capacity whose source is its target on one key is a row CHECK too: each selected target fact's own
 *   weight, or zero when the source selection rejects it, lies within its bounds. Both read selections every conjunct
 *   of which is fixed, over fields.
 * - A capacity whose weight is a count or a span width can only grow by an insertion and shrink by a deletion, so its
 *   event table drops a source insertion when it has no upper bound and a source deletion when its lower bound is a
 *   literal of zero or less; a field weight may be negative, so both stay. A count or width capacity whose bounds are
 *   vacuous, a lower bound of at most zero and no upper bound, holds in every state and installs nothing.
 * - A residual capacity is admitted only when its target projection contains a declared key of the target; otherwise
 *   it is UnsupportedLawFamily (`#capacityAnchor`). The three residual families (alternatives reverse, capacity and
 *   selected-source coverage) read selections every conjunct of which is fixed, over fields alone.
 * - Each probe of a residual law asks for an index on the keys it fixes by equality and states the rows it reads
 *   (`IndexRows`): a probe of a selected source (a capacity's group aggregate, a coverage's uncovered-span probe) reads
 *   only the rows of the source's selection, listed in declared field order, which the index engine serves by a
 *   partial index of that selection; an anchor read reads every row.
 * - A key containing a span field is a pointwise nonoverlap rule: facts may share its scalar fields provided their
 *   spans share no point. Its native lowering places the span last WITHOUT OVERLAPS, as the primary key or as
 *   `UNIQUE (..., span WITHOUT OVERLAPS)` for a candidate key, both under the key's own constraint name; every scalar component needs a btree_gist operator class, which Setup creates if absent
 *   and verifies. A key whose only field is a span needs none: it is `EXCLUDE USING gist (span WITH &&)` under the same
 *   name, and since an exclusion constraint is no primary key, every span-only key is a candidate key. A key with two
 *   span fields, and a primary key whose only field is a span, have no native lowering and are UnrepresentableKey at
 *   recognition: an exclusion constraint is no PRIMARY KEY, and PostgreSQL's PRIMARY KEY needs a column before WITHOUT
 *   OVERLAPS (42601), while the same rule as a candidate key, key(on(R, span)), has its lowering.
 * - Every writer meets a span key's overlap as SQLSTATE 23P01 under the key's constraint name, which the
 *   constraint-to-LawId map turns into the span key law: a grizzle writer reports it as invariant-rejected with that
 *   law, and its witness carries the law id alone, because PostgreSQL reports the conflicting key only in its message
 *   text, which grizzle never parses. The complete key tuple of a span key is unique, because an equal nonempty span
 *   overlaps itself: that is why the target's span key identifies one row of a coverage group and
 *   why the span key's GiST index serves equality on the whole tuple. A span key is no ON CONFLICT ... DO SELECT
 *   arbiter: PostgreSQL refuses an exclusion constraint there, and a B-tree UNIQUE beside it as the arbiter reports a
 *   concurrent exact repeat as an overlap. The write compiler's insert into a span key names it as a DO NOTHING arbiter
 *   and classifies each fact it did not insert in a later statement. */
export class Recognizer {
	/** Each relation's keys over projected sides, by relation name, which a containment's target may contain. */
	readonly #projectedKeys: ReadonlyMap<string, ReadonlyArray<ResolvedSide>>

	constructor(laws: ReadonlyArray<TheoryLaw>) {
		const keys = new Map<string, Array<ResolvedSide>>()
		for (const law of laws) {
			if (law.detail.kind === "projectedKey") {
				const side = law.detail.side
				keys.set(side.relation, [...(keys.get(side.relation) ?? []), side])
			}
		}
		this.#projectedKeys = keys
	}

	plan(law: TheoryLaw): LawPlan {
		const loc = law.loc
		const d = law.detail
		const done = (
			natives: ReadonlyArray<NativePlan>,
			residual: ResidualPlan | undefined
		): LawPlan => ({
			law,
			natives,
			residual
		})
		switch (d.kind) {
			case "key":
				return done(this.#key(d, loc), undefined)
			case "projectedKey":
				return done(this.#projectedKey(d.side, loc), undefined)
			case "check":
				return done(
					[
						{
							kind: "TableCheck",
							relation: d.rel,
							name: d.name,
							named: d.named,
							predicate: d.lowered
						}
					],
					undefined
				)
			case "contract":
				return done([{ kind: "Domain", contract: d.owned }], undefined)
			case "alternatives":
				return done([], this.#alternatives(law, d))
			case "alternativesArm":
				return done(this.#alternativesArm(d, loc), undefined)
			case "containment":
				return this.#containment(law, d, loc, done)
			case "capacity":
				return this.#capacity(law, d, loc, done)
		}
	}

	/** A scalar key is PRIMARY KEY or UNIQUE; a span key places its span field last
	 * WITHOUT OVERLAPS, or, alone, is an exclusion constraint under the key's name. */
	#key(
		d: Extract<TheoryLaw["detail"], { readonly kind: "key" }>,
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		const { fields, span, primary, named } = d.key
		if (primary) {
			return [primaryKeyPlan(d.rel, d.key, loc)]
		}
		if (span === undefined) {
			return [{ kind: "Unique", relation: d.rel, columns: mapNonEmpty(fields, fieldColumn) }]
		}
		return [
			{
				kind: "WithoutOverlaps",
				relation: d.rel,
				span,
				key: { kind: "unique", scalars: fields.filter((f) => f !== span) },
				named
			}
		]
	}

	/** A key over a projected side: UNIQUE NULLS DISTINCT over its columns, a stored relation's. */
	#projectedKey(side: ResolvedSide, loc: SourceLoc): ReadonlyArray<NativePlan> {
		if (side.rel.kind === "closed") {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a key over a side of a stored relation; ${side.relation} is closed, and its facts are declared`
			)
		}
		const columns = sideColumns(side)
		return [...lawColumns(columns), { kind: "Unique", relation: side.rel, columns }]
	}

	/** An alternatives arm relation's native half: its forward law, each of its facts contained in the parent over the
	 * parent key, selected by the handles it is the arm of (analysis/theory/laws.ts), lowered as every containment is.
	 * An arm of one handle selects the parent by a constant, so it references the parent's UNIQUE (key, discriminator)
	 * through a constant law column of its own; an arm of several references law columns of the parent, its key where
	 * its discriminator is among them. */
	#alternativesArm(
		d: Extract<TheoryLaw["detail"], { readonly kind: "alternativesArm" }>,
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		return this.#scalarContainment(d.from, d.to, loc)
	}

	/** The alternatives family's reverse obligation, anchored on the parent row; the native half is the arms'
	 * references (their own laws). The violation is a union of one term per armed handle, each reading the parent and
	 * that handle's arm relation alone, so a write to an arm relation can break only its own arms' terms: the parent
	 * re-checks the whole roster, each arm relation its own arms. A parent deletion and an arm insertion break no term.
	 * The parent is no arm relation (the theory refuses its own arm), so its participant is its own, and an arm relation
	 * of several handles is one participant re-checking each of its arms. */
	#alternatives(
		law: TheoryLaw,
		family: Extract<TheoryLaw["detail"], { readonly kind: "alternatives" }>
	): ResidualPlan {
		const parentKey = anchorColumns(ownPairs(family.parentFields))
		const armOf = (arm: TheoryArm): AlternativesArm => ({
			handle: arm.handle,
			relation: arm.rel,
			pairs: anchorPairs(
				arm.key,
				(p) => p.armColumn,
				(p) => p.parentColumn
			)
		})
		const parent: AlternativesPlan = {
			...inserting(
				family.parentRel,
				{ key: parentKey, guard: always },
				inHeadingOrder([...family.parentFields, family.discriminatorField])
			),
			check: {
				kind: "roster",
				handles: mapNonEmpty(family.handles, (h): RosterHandle => {
					switch (h.kind) {
						case "armed":
							return { kind: "armed", arm: armOf(h.arm) }
						case "unarmed":
							return h
					}
				})
			}
		}
		const arms = family.handles.flatMap((h): ReadonlyArray<ArmPlan> => {
			if (h.kind === "unarmed") {
				return []
			}
			const arm = h.arm
			const key = mapNonEmpty(arm.key, (p) => ({
				field: p.armColumn,
				pair: { field: p.parentColumn, anchor: p.parentColumn }
			}))
			return [
				{
					...deleting(
						arm.rel,
						{ key, guard: always },
						inHeadingOrder(mapNonEmpty(arm.key, (p) => p.armColumn))
					),
					check: { kind: "arms", arms: [armOf(arm)] }
				}
			]
		})
		return {
			checks: {
				family: "alternativesReverse",
				discriminator: family.discriminatorField,
				participants: [
					parent,
					...(isNonEmpty(arms)
						? mergeParticipants(arms, (prior, p) => ({
								...mergeTwo(prior, p),
								check: uniteArms(prior.check, p.check)
							}))
						: [])
				]
			},
			anchor: { relation: family.parentRel, key: family.parentFields },
			violation: law.violation,
			indexes: [
				this.#indexRequest(family.parent, family.parentKey, "btree", "anchor read", allRows)
			],
			detail: detailOf(family.parentRel, family.parentFields)
		}
	}

	/** A probe's index request: its relation's keys, every one fixed by equality, and the rows the probe reads. */
	#indexRequest(
		relation: string,
		keys: KeySet,
		method: IndexRequest["method"],
		use: string,
		rows: IndexRows
	): Omit<LawIndexRequest, "justification"> {
		return {
			relation,
			keys: keys.map((k) => ({ expr: k, dir: "asc" as const, opclass: defaultOpclass })),
			method,
			role: "lawMaintenance",
			use,
			rows
		}
	}

	/** The rows a probe reads: the rows its literal selection chooses, in the relation's declared field order, or every
	 * row of an unselected side. */
	#rowsOf(selection: ReadonlyArray<ResolvedSelector>): IndexRows {
		const ordered = orderedSelection(selection)
		return isNonEmpty(ordered) ? { kind: "selected", selection: ordered } : allRows
	}

	#containment(
		law: TheoryLaw,
		d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>,
		loc: SourceLoc,
		done: (natives: ReadonlyArray<NativePlan>, residual: ResidualPlan | undefined) => LawPlan
	): LawPlan {
		const fromRel = d.from.rel
		const toRel = d.to.rel
		if (fromRel.kind === "closed") {
			return done(this.#fromClosed(d, fromRel, toRel, loc), undefined)
		}
		if (toRel.kind === "closed") {
			switch (d.pairing.kind) {
				case "span":
					return refuse(
						"UnsupportedLawFamily",
						loc,
						`a coverage law into a span-keyed stored relation; ${d.to.relation} is closed`
					)
				case "scalar":
					return done(this.#intoClosed(d, fromRel, toRel, loc), undefined)
			}
		}
		switch (d.pairing.kind) {
			case "span":
				return this.#coverage(law, d, fromRel, toRel, loc, done)
			case "scalar":
				return done(this.#scalarContainment(d.from, d.to, loc), undefined)
		}
	}

	/** A containment between closed relations is decided by their declared facts: nothing to install when they satisfy
	 * it, a malformed schema when they do not. Closed facts into a stored relation require stored rows to exist, which
	 * no admitted family enforces. */
	#fromClosed(
		d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>,
		fromRel: ClosedTheoryRelation,
		toRel: TheoryRelation,
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		if (toRel.kind !== "closed") {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a containment whose source is a stored relation or whose target is closed; ${d.from.relation}'s closed facts into the stored ${d.to.relation} would require its rows to exist`
			)
		}
		const what = "a containment between closed relations"
		const fromFields = fieldsOf(d.from, loc, what)
		const toFields = fieldsOf(d.to, loc, what)
		const targets = new Set(
			this.#closedTuples(toRel, literalsOf(d.to, loc, what), toFields).map(tupleKey)
		)
		for (const t of this.#closedTuples(fromRel, literalsOf(d.from, loc, what), fromFields)) {
			if (!targets.has(tupleKey(t))) {
				return refuse(
					"MalformedDescription",
					loc,
					`a containment the declared facts of ${d.from.relation} and ${d.to.relation} satisfy; one fact of ${d.from.relation} has no match`
				)
			}
		}
		return []
	}

	/** The distinct facts of a closed relation that a literal selection selects, each projected onto `columns`, a
	 * column's cell the fact's value of its field. */
	#closedTuples(
		r: ClosedTheoryRelation,
		selection: ReadonlyArray<ResolvedSelector>,
		columns: NonEmptyReadonlyArray<LawField>
	): ReadonlyArray<ClosedTuple<number>> {
		const cell = (row: ReadonlyArray<TypedLiteral>, f: LawField): TypedLiteral =>
			closedCell(row, f.position)
		const seen = new Set<string>()
		const out: Array<ClosedTuple<number>> = []
		for (const row of r.rows) {
			const selected = selection.every((s) => literalKey(cell(row, s.col)) === literalKey(s.value))
			if (!selected) {
				continue
			}
			const tuple = mapNonEmpty(columns, (column, i) => ({
				column: i,
				value: cell(row, column)
			}))
			const key = tupleKey(tuple)
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
			out.push(tuple)
		}
		return out
	}

	/** Membership in closed facts, of a containment over scalar fields, is the enum type when a single field of the
	 * roster's type references every handle, and otherwise an exact row-local CHECK over the complete closed tuples; a
	 * selected source makes the CHECK conditional on its selector. */
	#intoClosed(
		d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>,
		fromRel: TheoryRelation,
		toRel: ClosedTheoryRelation,
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		const what = "a containment into a closed relation"
		const fromFields = fieldsOf(d.from, loc, what)
		const toFields = fieldsOf(d.to, loc, what)
		const fromSelection = literalsOf(d.from, loc, what)
		const toSelection = literalsOf(d.to, loc, what)
		const tuples = this.#closedTuples(toRel, toSelection, toFields)
		const sourceOf = (i: number): LawField => fromFields[i] ?? headNonEmpty(fromFields)
		if (fromSelection.length === 0) {
			const [only, ...more] = d.pairs
			const roster = rosterOf(baseOf(only.from.column.type))
			if (
				more.length === 0 &&
				only.to.column.name === "id" &&
				toSelection.length === 0 &&
				roster?.closed === toRel.name
			) {
				return [{ kind: "Enum", name: toRel.name, handles: roster.handles }]
			}
			return [
				{
					kind: "FiniteCheck",
					relation: fromRel,
					facts: tuples.map((t) =>
						mapNonEmpty(t, (c): FieldValue => ({ field: sourceOf(c.column), value: c.value }))
					)
				}
			]
		}
		const membership = orP(
			tuples.map((t) =>
				andP(
					t.map(({ column, value }): Pred => ({
						kind: "compare",
						op: "eq",
						left: field(sourceOf(column)),
						right: literalAt(baseOf(sourceOf(column).type).carrier, value)
					}))
				)
			)
		)
		const check = this.#generatedCheck(
			fromRel,
			orP([notP(selectionPred(fromSelection)), membership])
		)
		return check === undefined ? [] : [check]
	}

	/** A generated CHECK from a folded predicate. One that always holds needs no object; one that never holds forbids
	 * every row, as `<field> <> <field>` over a NOT NULL column, which is false on every row. */
	#generatedCheck(relation: TheoryRelation, predicate: Pred): NativePlan | undefined {
		if (predicate === true) {
			return undefined
		}
		if (predicate === false) {
			const first = headNonEmpty(relation.fields)
			return {
				kind: "GeneratedCheck",
				relation,
				predicate: { kind: "compare", op: "ne", left: field(first), right: field(first) }
			}
		}
		return { kind: "GeneratedCheck", relation, predicate }
	}

	/** Whether `fields` contain a declared scalar key of `r`. */
	#containsKey(r: TheoryRelation, fields: ReadonlyArray<LawField>): boolean {
		return scalarKeys(r).some((k) => contains<LawField>(fields, k))
	}

	/**
	 * A containment from one side into another: a foreign key MATCH SIMPLE from the source's columns into the target's,
	 * the UNIQUE over the target's columns it references, the law columns either side reads, and the index over the
	 * referencing columns. A target fixed by a constant selection references through constant law columns on the
	 * source, which the index leaves out: a constant narrows no lookup.
	 */
	#scalarContainment(
		from: ResolvedSide,
		to: ResolvedSide,
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		const fromRel = from.rel
		const toRel = to.rel
		const sourceColumns = sideColumns(from)
		const constant = this.#constantTarget(to, fromRel)
		const columns: NonEmptyReadonlyArray<PlannedColumn> =
			constant === undefined
				? sourceColumns
				: extendNonEmpty(
						sourceColumns,
						constant.tags.map((column): PlannedColumn => ({ kind: "law", column }))
					)
		const targetColumns = constant === undefined ? sideColumns(to) : constant.columns
		if (constant === undefined && !this.#targetKeyed(to)) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a containment into a side that contains a key of ${toRel.name}; ${to.relation}(${to.terms.map(termText).join(", ")}) contains no declared key among its fields and no key over its own selection, and a containment into an unkeyed side is not admitted`
			)
		}
		/** A generated unique over the target's columns, but where they are exactly a declared scalar key's fields. */
		const fields = plainFields(targetColumns)
		const declared =
			fields !== undefined && scalarKeys(toRel).some((k) => sameSet<LawField>(k, fields))
		return [
			...lawColumns(columns),
			...lawColumns(targetColumns),
			...(declared ? [] : [{ kind: "Unique" as const, relation: toRel, columns: targetColumns }]),
			{ kind: "ForeignKey", relation: fromRel, columns, target: toRel, targetColumns },
			{ kind: "ReverseIndex", relation: fromRel, columns: sourceColumns }
		]
	}

	/**
	 * A target side fixed by a constant selection (see the recognition table): the target's terms are fields, and its
	 * fixed conjuncts over fields that are none of them, with its field terms, contain a declared key of the target. Its
	 * fixed conjuncts' constants are law columns of the source, and the target's columns are its terms under its other
	 * conjuncts (`sideColumns`), then its fixed fields: a fact the other conjuncts reject holds a null among its terms,
	 * which references nothing, and the declared key holds the rest apart, so one UNIQUE over them serves every
	 * constant. Undefined for any other target.
	 */
	#constantTarget(
		to: ResolvedSide,
		fromRel: TheoryRelation
	):
		| {
				readonly tags: NonEmptyReadonlyArray<ConstantColumn>
				readonly columns: NonEmptyReadonlyArray<PlannedColumn>
		  }
		| undefined {
		const fields = fieldTermsOf(to.terms)
		if (fields === undefined) {
			return undefined
		}
		const terms = fields.map((t) => t.column)
		const fixes = (c: ResolvedSelection["conjuncts"][number]): boolean =>
			c.kind === "fixed" && !terms.includes(c.selector.col)
		const selected = orderedSelectors(
			to.selection.conjuncts.flatMap((c) => (c.kind === "fixed" && fixes(c) ? [c.selector] : []))
		)
		if (
			!isNonEmpty(selected) ||
			!this.#containsKey(to.rel, [...terms, ...selected.map((s) => s.col)])
		) {
			return undefined
		}
		const rest: ResolvedSide = {
			...to,
			selection: { conjuncts: to.selection.conjuncts.filter((c) => !fixes(c)) }
		}
		return {
			tags: mapNonEmpty(selected, (s): ConstantColumn => ({
				kind: "constant",
				relation: fromRel,
				target: to.rel,
				field: s.col,
				value: s.value
			})),
			columns: extendNonEmpty(
				sideColumns(rest),
				selected.map((s) => fieldColumn(s.col))
			)
		}
	}

	/** Whether a target side contains a key: a declared scalar key of its relation among its field terms, or a projected
	 * key of the relation over its own selection among its terms. */
	#targetKeyed(to: ResolvedSide): boolean {
		const fields = to.terms.flatMap((t) => (t.kind === "field" ? [t.column] : []))
		return (
			this.#containsKey(to.rel, fields) ||
			(this.#projectedKeys.get(to.relation) ?? []).some((k) => keyedBy(k, to))
		)
	}

	/** Coverage into a target whose span key it matches is a PERIOD foreign key, a
	 * selected target adds a constant law column and a generated temporal unique constraint, and a selected source is
	 * the residual range_agg coverage law anchored on the target rows of the source's scalar group. Its sides pair fields
	 * and select by literal equalities. */
	#coverage(
		law: TheoryLaw,
		d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>,
		fromRel: TheoryRelation,
		toRel: TheoryRelation,
		loc: SourceLoc,
		done: (natives: ReadonlyArray<NativePlan>, residual: ResidualPlan | undefined) => LawPlan
	): LawPlan {
		const span = d.pairing
		if (span.kind !== "span") {
			return refuse("UnsupportedLawFamily", loc, "a coverage law pairing a span")
		}
		const what = "a coverage law"
		const from = d.from
		const to = d.to
		const fromFields = fieldsOf(from, loc, what)
		const toFields = fieldsOf(to, loc, what)
		const fromSelection = literalsOf(from, loc, what)
		const toSelection = literalsOf(to, loc, what)
		if (isNonEmpty(fromSelection) && isNonEmpty(toSelection)) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a coverage law with at most one selected side; ${from.relation} and ${to.relation} are both selected`
			)
		}
		const pair = span.pair
		const hasSpanKey = declaredFields(toRel).some(
			(k) =>
				sameSet<LawField>(k, toFields) && k.filter(isSpanField).length === 1 && k.includes(span.to)
		)
		if (!hasSpanKey) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`coverage into a target whose span key it matches; ${to.relation} has no span key over (${fieldNames(toFields).join(", ")}), and coverage into a target without a span key needs an exact lowering the first compiler does not have`
			)
		}
		/** The scalar pairs: every pair but the spans'. */
		const scalars = d.pairs.filter((p) => p !== pair)
		if (!isNonEmpty(scalars)) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`coverage grouped by at least one scalar field; ${from.relation} into ${to.relation} pairs only spans, an ungrouped span law`
			)
		}
		const toScalarFields = mapNonEmpty(scalars, (p) => p.to.column)
		const fromScalarFields = mapNonEmpty(scalars, (p) => p.from.column)
		if (isNonEmpty(fromSelection)) {
			const selection = mapNonEmpty(fromSelection, fieldSelector)
			const sourcePairs = anchorPairs(
				scalars,
				(p) => p.from.column,
				(p) => p.to.column
			)
			const sourceKey = pairedColumns(sourcePairs)
			const sourceUpdate = inHeadingOrder([...fromFields, ...fromSelection.map((s) => s.col)])
			return done([], {
				checks: {
					family: "selectedSourceCoverage",
					target: {
						relation: toRel,
						pairs: anchorPairs(
							scalars,
							(p) => p.to.column,
							(p) => p.to.column
						),
						span: span.to,
						/** The residual accumulates the target spans into a multirange of the target span's carrier. */
						carrier: span.to.type.carrier
					},
					source: { relation: fromRel, pairs: sourcePairs, span: span.from, selection },
					participants: mergeParticipants(
						[
							inserting(fromRel, { key: sourceKey, guard: guardBy(fromSelection) }, sourceUpdate),
							deleting(
								toRel,
								{ key: anchorColumns(sourcePairs), guard: always },
								inHeadingOrder(toFields)
							)
						],
						mergeTwo
					)
				},
				anchor: { relation: toRel, key: toScalarFields },
				violation: law.violation,
				indexes: [
					this.#indexRequest(
						toRel.name,
						[...fieldNames(toScalarFields), pair.to.column.name],
						"gist",
						"group listing",
						allRows
					),
					this.#indexRequest(
						fromRel.name,
						fieldNames(fromScalarFields),
						"btree",
						"coverage probe",
						this.#rowsOf(fromSelection)
					)
				],
				detail: detailOf(fromRel, fromFields)
			})
		}
		const reverse: NativePlan = {
			kind: "ReverseIndex",
			relation: fromRel,
			columns: mapNonEmpty(appendNonEmpty(fromScalarFields, span.from), fieldColumn)
		}
		const [selector, ...moreSelectors] = toSelection
		if (selector === undefined) {
			return done(
				[
					{
						kind: "PeriodForeignKey",
						relation: fromRel,
						columns: fromScalarFields.map(fieldColumn),
						span: span.from,
						target: toRel,
						targetColumns: toScalarFields.map(fieldColumn),
						targetSpan: span.to
					},
					reverse
				],
				undefined
			)
		}
		if (moreSelectors.length > 0) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a selected coverage target with one selector field, which becomes its source's constant law column; select(${to.relation}, ...) has ${toSelection.length}`
			)
		}
		if (toFields.includes(selector.col)) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a selected target whose selector ${selector.column} is not a referenced field`
			)
		}
		const tag: ConstantColumn = {
			kind: "constant",
			relation: fromRel,
			target: toRel,
			field: selector.col,
			value: selector.value
		}
		const targetColumns = appendNonEmpty(toScalarFields, selector.col)
		/** The temporal unique compares its scalar fields through btree_gist, which has no operator class for a vector. */
		const temporal = mapNonEmpty(targetColumns, (f) =>
			f.type.carrier !== "vector"
				? f
				: unrepresentable(
						loc,
						`the temporal unique (${fieldNames(targetColumns).join(", ")}) of ${to.relation}`,
						fieldNames(targetColumns),
						{ kind: "gistOperatorClass", field: f.name }
					)
		)
		return done(
			[
				{ kind: "LawColumn", column: tag },
				{ kind: "TemporalUnique", relation: toRel, columns: temporal, span: span.to },
				{
					kind: "PeriodForeignKey",
					relation: fromRel,
					columns: [...fromScalarFields.map(fieldColumn), { kind: "law", column: tag }],
					span: span.from,
					target: toRel,
					targetColumns: targetColumns.map(fieldColumn),
					targetSpan: span.to
				},
				reverse
			],
			undefined
		)
	}

	/** Scalar-group capacity. */
	#capacity(
		law: TheoryLaw,
		d: Extract<TheoryLaw["detail"], { readonly kind: "capacity" }>,
		loc: SourceLoc,
		done: (natives: ReadonlyArray<NativePlan>, residual: ResidualPlan | undefined) => LawPlan
	): LawPlan {
		const target = d.target.rel
		const source = d.from.rel
		if (target.kind === "closed" || source.kind === "closed") {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a capacity over stored relations; ${target.kind === "closed" ? d.target.relation : d.from.relation} is closed, and its facts fire no law`
			)
		}
		const targetFields = mapNonEmpty(d.pairs, (p) => p.targetColumn)
		const fromFields = mapNonEmpty(d.pairs, (p) => p.fromColumn)
		const { low } = d.within
		const nonnegative = d.weight.kind !== "field"
		if (
			d.target.relation === d.from.relation &&
			d.pairs.every((p) => p.target === p.from) &&
			declaredKeys(target).some((k) => contains(fieldNames(targetFields), k))
		) {
			const check = this.#selfCapacity(d, target)
			return done(check === undefined ? [] : [check], undefined)
		}
		/** The bounds a group can break, low before high: a count or a width is never negative, so a literal lower bound
		 * of zero or less holds for every group. With none left the law holds in every state, and needs no function. */
		const removes = nonnegative ? typeof low !== "bigint" || low > 0n : true
		const checkedHigh = d.bounds.high
		const lowBounds: ReadonlyArray<CheckedBound> = removes
			? [{ side: "low", value: d.bounds.low }]
			: []
		const bounds: ReadonlyArray<CheckedBound> =
			checkedHigh === undefined ? lowBounds : [...lowBounds, { side: "high", value: checkedHigh }]
		if (!isNonEmpty(bounds)) {
			return done([], undefined)
		}
		this.#capacityAnchor(d, target, loc)
		const adds = nonnegative ? checkedHigh !== undefined : true
		const refs = [d.bounds.low, d.bounds.high].flatMap((b) => (b?.kind === "ref" ? [b.field] : []))
		const fromSelection = selectorsOf(d.from.selection)
		const targetSelection = selectorsOf(d.target.selection)
		const sourceGuard = guardBy(fromSelection)
		const sourcePairs = anchorPairs(
			d.pairs,
			(p) => p.fromColumn,
			(p) => p.targetColumn
		)
		const sourceKey = pairedColumns(sourcePairs)
		/** A source's insertion threatens a bound above and its deletion one below; a source neither threatens is no
		 * participant. */
		const sourceImage: ImagePlan = { key: sourceKey, guard: sourceGuard }
		const sourceEvents: PlanEvents | undefined = participantEvents(
			adds ? [sourceImage] : undefined,
			removes ? [sourceImage] : undefined,
			updateOf(
				source,
				inHeadingOrder([
					...fromFields,
					...weightFields(d.weighed),
					...fromSelection.map((s) => s.col)
				])
			)
		)
		const targetPlan = inserting(
			target,
			{ key: anchorColumns(sourcePairs), guard: guardBy(targetSelection) },
			inHeadingOrder([...targetFields, ...refs, ...targetSelection.map((s) => s.col)])
		)
		return done([], {
			checks: {
				family: "scalarCapacity",
				selection: targetSelection.map(fieldSelector),
				source: {
					relation: source,
					pairs: sourcePairs,
					selection: fromSelection.map(fieldSelector)
				},
				weight: lawWeight(d.weighed),
				aggregate: d.aggregate,
				bounds,
				participants: mergeParticipants(
					sourceEvents === undefined
						? [targetPlan]
						: [targetPlan, { relation: source, events: sourceEvents }],
					mergeTwo
				)
			},
			anchor: { relation: target, key: targetFields },
			violation: law.violation,
			indexes: [
				this.#indexRequest(
					source.name,
					fieldNames(fromFields),
					"btree",
					"group aggregate",
					this.#rowsOf(fromSelection)
				)
			],
			detail: detailOf(target, targetFields)
		})
	}

	/** What a residual capacity needs of its anchor: its target projection contains a declared key of the target, so the
	 * anchor is one row found by a key probe and the family's body runs once for it. A
	 * projection containing no key groups several target facts under one key. */
	#capacityAnchor(
		d: Extract<TheoryLaw["detail"], { readonly kind: "capacity" }>,
		target: TheoryRelation,
		loc: SourceLoc
	): void {
		const fields = d.pairs.map((p) => p.target)
		if (!declaredKeys(target).some((k) => contains(fields, k))) {
			refuse(
				"UnsupportedLawFamily",
				loc,
				`a residual capacity whose target projection (${fields.join(", ")}) contains a declared key of ${d.target.relation}, so that its anchor is one target row`
			)
		}
	}

	/** The row check of a capacity whose source is its target on one key: the group of a target fact is the fact itself
	 * when it satisfies the source selection, and empty otherwise, so the law is that each target fact's own weight, or
	 * zero, lies within its bounds.
	 * `target` is the relation of both sides. */
	#selfCapacity(
		d: Extract<TheoryLaw["detail"], { readonly kind: "capacity" }>,
		target: TheoryRelation
	): NativePlan | undefined {
		const value = weightTerm(d.weighed)
		const high = d.bounds.high
		const within = (v: MetTerm | 0n | 1n): Pred =>
			andP([boundPred(v, d.bounds.low, "ge"), high === undefined ? true : boundPred(v, high, "le")])
		const selected = selectionPred(selectorsOf(d.from.selection))
		const body = orP([andP([selected, within(value)]), andP([notP(selected), within(0n)])])
		return this.#generatedCheck(
			target,
			orP([notP(selectionPred(selectorsOf(d.target.selection))), body])
		)
	}
}

const weightTerm = (weight: Weighed): MetTerm | 1n => {
	switch (weight.kind) {
		case "count":
			return 1n
		case "field":
			return field(weight.field)
		case "duration":
			return { kind: "compute", fn: "width", args: [field(weight.field)], span: weight.span }
	}
}

/** The source fields a weight reads. */
const weightFields = (weight: Weighed): ReadonlyArray<LawField> =>
	weight.kind === "count" ? [] : [weight.field]

/** A weight as the residual law reads it. */
const lawWeight = (weight: Weighed): LawWeight =>
	weight.kind === "count" ? weight : { kind: weight.kind, field: weight.field }

const flip = { ge: "le", le: "ge" } as const

/** `value <op> bound` over a row of `relation`, decided when both are literals; a literal operand never stands first,
 * and a literal bound or count weight enters as an IR integer typed at the term it meets. */
const boundPred = (value: MetTerm | 0n | 1n, bound: CapacityBound, op: "ge" | "le"): Pred => {
	if (bound.kind === "literal") {
		if (typeof value === "bigint") {
			return op === "ge" ? value >= bound.stated : value <= bound.stated
		}
		return compareLiteral(op, value, { kind: "int", value: bound.stated })
	}
	if (typeof value === "bigint") {
		return compareLiteral(flip[op], field(bound.field), { kind: "int", value })
	}
	return { kind: "compare", op, left: value, right: field(bound.field) }
}

/** The guard of one image two sides of a relation share: always when either side's image is, else the union of their
 * selections, the earlier plan's first. */
const uniteGuards = (a: ImageGuard, b: ImageGuard): ImageGuard =>
	a.kind === "always" || b.kind === "always"
		? { kind: "always" }
		: { kind: "selected", selections: [...a.selections, ...b.selections] }

const imageKey = (i: ImagePlan) => i.key.map((c) => c.field.name).join("\u0000")

/** `a`'s images of one event with `b`'s: each of `a`'s under the union of its guard and its twin's in `b`, then the ones
 * of `b` that `a` lacks, each under its own. */
const extend = (
	a: NonEmptyReadonlyArray<ImagePlan>,
	b: NonEmptyReadonlyArray<ImagePlan> | undefined
): NonEmptyReadonlyArray<ImagePlan> => {
	if (b === undefined) {
		return a
	}
	const twins = new Map(b.map((x) => [imageKey(x), x] as const))
	const known = new Set(a.map(imageKey))
	return [
		...mapNonEmpty(a, (i) => {
			const twin = twins.get(imageKey(i))
			return twin === undefined ? i : { key: i.key, guard: uniteGuards(i.guard, twin.guard) }
		}),
		...b.filter((i) => !known.has(imageKey(i)))
	]
}

/** Two image lists of one event as one (`extend`), none when neither has any. */
const uniteImages = (
	a: NonEmptyReadonlyArray<ImagePlan> | undefined,
	b: NonEmptyReadonlyArray<ImagePlan> | undefined
): NonEmptyReadonlyArray<ImagePlan> | undefined => (a === undefined ? b : extend(a, b))

/** Two UPDATE OF lists of one relation as one: the fields of either, in heading order. */
const uniteUpdates = (
	a: NonEmptyReadonlyArray<LawField> | undefined,
	b: NonEmptyReadonlyArray<LawField> | undefined
): NonEmptyReadonlyArray<LawField> | undefined =>
	a === undefined
		? b
		: b === undefined
			? a
			: sortNonEmpty(
					dedupeNonEmpty([...a, ...b]),
					Order.mapInput(Order.compareNumbers, (f: LawField) => f.position)
				)

/** Two plans' events of one relation as one, each kind united. */
const uniteEvents = (a: PlanEvents, b: PlanEvents): PlanEvents => {
	const update = uniteUpdates(a.update, b.update)
	if (a.insert !== undefined) {
		return { insert: extend(a.insert, b.insert), delete: uniteImages(a.delete, b.delete), update }
	}
	if (b.insert !== undefined) {
		return { insert: b.insert, delete: extend(a.delete, b.delete), update }
	}
	return { insert: undefined, delete: extend(a.delete, b.delete), update }
}

/** Two plans of one relation as one. */
const mergeTwo = (prior: ParticipantPlan, p: ParticipantPlan): ParticipantPlan => ({
	relation: p.relation,
	events: uniteEvents(prior.events, p.events)
})

/** What two arm plans of one relation re-check, as one: the earlier plan's arms, then the later's. The planner visits
 * the arms in roster order, so these are too. */
const uniteArms = (a: ArmsCheck, b: ArmsCheck): ArmsCheck => ({
	kind: "arms",
	arms: [...a.arms, ...b.arms]
})

/** One participant per participating table, in the order each relation is first planned: the plans of one relation
 * merged by `merge`, events and images united. Two images of one event and fields are one image, under the union of
 * their guards; an image one plan has and the other lacks keeps its own guard. */
const mergeParticipants = <P extends ParticipantPlan>(
	plans: NonEmptyReadonlyArray<P>,
	merge: (prior: P, p: P) => P
): NonEmptyReadonlyArray<P> => {
	const [first, ...rest] = plans
	let head = first
	const byRelation = new Map<string, P>()
	for (const p of rest) {
		if (p.relation.name === head.relation.name) {
			head = merge(head, p)
			continue
		}
		const prior = byRelation.get(p.relation.name)
		byRelation.set(p.relation.name, prior === undefined ? p : merge(prior, p))
	}
	return [head, ...byRelation.values()]
}
