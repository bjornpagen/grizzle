import type {
	ContainmentPairing,
	ResolvedPair,
	ResolvedSelector,
	ResolvedSide,
	TheoryArm,
	TheoryLaw,
	Weighed
} from "#compiler/analysis/theory/laws.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import type { Identity } from "#compiler/core/identity.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	dedupeNonEmpty,
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import * as Order from "#compiler/core/order.ts"
import type { LiteralDesc, Refs } from "#compiler/ir/desc.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type AlternativesArm,
	type AlternativesCheck,
	type Anchor,
	type AnchorPair,
	type ArmTagMove,
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
	type RosterHandle,
	type SelectedSide,
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

/** A side's selectors as the residual law records them (`plainSelector`). */
const plainSelection = (selection: ReadonlyArray<Selector>): ReadonlyArray<Selector> =>
	selection.map(plainSelector)

/** A side's selectors in its relation's declared field order. */
const orderedSelectors = (side: ResolvedSide): ReadonlyArray<ResolvedSelector> =>
	side.selection.toSorted((a, b) => a.col.position - b.col.position)

/** A side's selection as an index's rows record it, by name, in the relation's declared field order. */
const orderedSelection = (side: ResolvedSide): ReadonlyArray<Selector> =>
	plainSelection(orderedSelectors(side))

/** A selector as a native object, a residual law and its guards read it: the handle of its field, and its literal. */
const fieldSelector = (s: ResolvedSelector): FieldSelector => ({ field: s.col, value: s.value })

/** A tag a selected target needs on its source: a STORED constant column of the source `relation`, `field` the selector
 * field of the `target` relation and `value` its literal. */
export interface TagRef {
	readonly relation: TheoryRelation
	readonly target: TheoryRelation
	readonly field: LawField
	readonly value: TypedLiteral
}

/** An alternatives parent's generated arm tag as planned: its parent, its discriminator, and every handle another
 * handle tags (ir/law.ts ArmTagMove). */
export interface ArmTagRef {
	readonly relation: TheoryRelation
	readonly discriminator: LawField
	readonly moved: NonEmptyReadonlyArray<ArmTagMove>
}

/** A native object as planned: the frozen NativeObject kinds, with a tag still symbolic, a foreign key's deferral still
 * to decide, and a generated CHECK still to lower. */
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
			readonly columns: NonEmptyReadonlyArray<LawField>
	  }
	| {
			readonly kind: "PartialUnique"
			readonly relation: TheoryRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
			readonly where: ReadonlyArray<FieldSelector>
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
			readonly columns: NonEmptyReadonlyArray<LawField>
			readonly target: TheoryRelation
			readonly targetColumns: NonEmptyReadonlyArray<LawField>
	  }
	| {
			readonly kind: "TaggedForeignKey"
			readonly relation: TheoryRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
			readonly tag: TagRef
			readonly target: TheoryRelation
			readonly targetColumns: NonEmptyReadonlyArray<LawField>
	  }
	| { readonly kind: "StoredTag"; readonly tag: TagRef }
	| { readonly kind: "ArmTag"; readonly tag: ArmTagRef }
	| {
			readonly kind: "ArmUnique"
			readonly relation: TheoryRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
			readonly tag: ArmTagRef
	  }
	| {
			readonly kind: "ArmForeignKey"
			readonly relation: TheoryRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
			readonly tag: TagRef
			readonly target: TheoryRelation
			readonly targetColumns: NonEmptyReadonlyArray<LawField>
			readonly targetTag: ArmTagRef
	  }
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
			readonly columns: ReadonlyArray<LawField>
			readonly span: SpanField
			readonly target: TheoryRelation
			readonly targetColumns: ReadonlyArray<LawField>
			readonly targetSpan: SpanField
	  }
	| {
			readonly kind: "TaggedPeriodForeignKey"
			readonly relation: TheoryRelation
			readonly columns: ReadonlyArray<LawField>
			readonly tag: TagRef
			readonly span: SpanField
			readonly target: TheoryRelation
			readonly targetColumns: NonEmptyReadonlyArray<LawField>
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
			readonly columns: NonEmptyReadonlyArray<LawField>
	  }

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

/** A side's selection over a row of its relation, each selector compared at its column's type. */
const selectionPred = (side: ResolvedSide): Pred =>
	andP(
		side.selection.map((s): Pred => ({
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

/** The recognition table: each normalized law to its plan of native objects and at most one residual law. Laws are
 * database obligations.
 *
 * A shape the recognizer does not know is rejected, never interpreted. Each case below states the row it
 * implements; everything else is refused with UnsupportedLawFamily, naming what the compiler admits. A plan is
 * pure data: tag column names, foreign key deferral and the generated CHECK predicates are settled afterwards, over
 * every plan at once (`compileLaws`), because they depend on the whole schema.
 *
 * The rules it implements:
 *
 * - A containment target is keyed when its projection contains a declared key of the target (a superkey). When the
 *   projection is exactly a declared key the foreign key references that key; otherwise the recognizer generates the
 *   composite UNIQUE the reference needs, which is exact because a superkey of a key is unique (the same holds for a
 *   selected target). A containment into a projection that contains no key is not admitted.
 * - A selected target or a selected coverage target has exactly one selector field, because a tagged reference carries
 *   one STORED tag (`TaggedForeignKey`, `PeriodForeignKey`); a containment whose both sides are selected has no
 *   admitted lowering (each side alone is admitted). Both are UnsupportedLawFamily.
 * - Capacity's at-most-one specialization is taken for a count with upper bound one over an unselected
 *   target, as a unique index on the source projection, partial with the source selector, so
 *   it is named as an index; over a selected target it would also bound the groups of unselected targets, so that law
 *   keeps the residual count law. Over an unselected target the index also bounds source groups that no target fact
 *   names, which is accepted.
 * - A selected source into closed facts is a row CHECK conditional on its selector: `NOT <selector> OR <tuple in the
 *   facts>`. A capacity whose source is its target on one key is a row CHECK too: each selected target fact's own
 *   weight, or zero when the source selection rejects it, lies within its bounds.
 * - A capacity whose weight is a count or a span width can only grow by an insertion and shrink by a deletion, so its
 *   event table drops a source insertion when it has no upper bound and a source deletion when its lower bound is a
 *   literal of zero or less; a field weight may be negative, so both stay. A count or width capacity
 *   whose bounds are vacuous, a lower bound of at most zero and no upper bound, holds in every state and installs
 *   nothing.
 * - A residual capacity is admitted only when its target projection contains a declared key of the target; otherwise
 *   it is UnsupportedLawFamily (`#capacityAnchor`). Its native specializations need none. The at-most-one bound is a
 *   unique index on the source projection, partial when the source is selected; a lower bound of one keeps a residual
 *   existence law for that bound alone.
 * - Each probe of a residual law asks for an index on the keys it fixes by equality and states the rows it reads
 *   (`IndexRows`): a probe of a selected source (a selected-source containment's probe, a capacity's
 *   group aggregate, a coverage's uncovered-span probe) reads only the rows of the source's selection, listed in
 *   declared field order, which the index engine serves by a partial index of that selection; an anchor read reads
 *   every row.
 * - A key containing a span field is a pointwise nonoverlap rule: facts may share its scalar fields provided their
 *   spans share no point. Its native lowering places the span last WITHOUT OVERLAPS, as the primary key or as
 *   `UNIQUE (..., span WITHOUT OVERLAPS)` for a candidate key, both under the key's own constraint name; every scalar component needs a btree_gist operator class, which Setup creates if absent
 *   and verifies. A key whose only field is a span needs none: it is `EXCLUDE USING gist (span WITH &&)` under the same
 *   name, and since an exclusion constraint is no primary key, every span-only key is a candidate key. A key with two
 *   span fields, and a primary key whose only field is a span, have no native lowering and are UnrepresentableKey at
 *   recognition: an exclusion constraint is no PRIMARY KEY, and PostgreSQL's PRIMARY KEY needs a column before WITHOUT
 *   OVERLAPS (42601), while the same rule as a candidate key, key(R, [span]), has its lowering.
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
				return done(this.#alternativesArm(d), undefined)
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
			return [{ kind: "Unique", relation: d.rel, columns: fields }]
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

	/** An alternatives arm relation's native half: its rows' constant STORED tag, the first handle it is the arm of, and
	 * its deferred foreign key from its key and that tag into the parent's key and arm tag, with the UNIQUE over them it
	 * references, which refuses a row whose parent is of no handle the relation is the arm of. The arm tag (`ArmTag`) is
	 * the discriminator itself when every arm relation is the arm of one handle, a tagged foreign key into UNIQUE (key,
	 * discriminator); when some arm relation is the arm of several, it is the parent's STORED column mapping each of
	 * them to the relation's first handle, so the relation meets each of their parents at its one tag. */
	#alternativesArm(
		d: Extract<TheoryLaw["detail"], { readonly kind: "alternativesArm" }>
	): ReadonlyArray<NativePlan> {
		const tag: TagRef = {
			relation: d.armRel,
			target: d.parentRel,
			field: d.discriminatorField,
			value: { kind: "enum", handle: d.handles[0] }
		}
		const columns = mapNonEmpty(d.key, (p) => p.armColumn)
		const targetColumns = mapNonEmpty(d.key, (p) => p.parentColumn)
		const reverse: NativePlan = { kind: "ReverseIndex", relation: d.armRel, columns }
		switch (d.armTag.kind) {
			case "discriminator": {
				const tagged = appendNonEmpty(targetColumns, d.discriminatorField)
				return [
					{ kind: "StoredTag", tag },
					{ kind: "Unique", relation: d.parentRel, columns: tagged },
					{
						kind: "TaggedForeignKey",
						relation: d.armRel,
						columns,
						tag,
						target: d.parentRel,
						targetColumns: tagged
					},
					reverse
				]
			}
			case "generated": {
				const armTag: ArmTagRef = {
					relation: d.parentRel,
					discriminator: d.discriminatorField,
					moved: d.armTag.moved
				}
				return [
					{ kind: "StoredTag", tag },
					{ kind: "ArmTag", tag: armTag },
					{ kind: "ArmUnique", relation: d.parentRel, columns: targetColumns, tag: armTag },
					{
						kind: "ArmForeignKey",
						relation: d.armRel,
						columns,
						tag,
						target: d.parentRel,
						targetColumns,
						targetTag: armTag
					},
					reverse
				]
			}
		}
	}

	/** The alternatives family's reverse obligation, anchored on the parent row; the native half is the arms' tagged
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

	/** The rows a probe of a side reads: the rows its selection chooses, in the relation's declared field order, or every
	 * row of an unselected side. */
	#rowsOf(side: ResolvedSide): IndexRows {
		const selection = orderedSelection(side)
		return isNonEmpty(selection) ? { kind: "selected", selection } : allRows
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
					return done(this.#intoClosed(d, fromRel, toRel), undefined)
			}
		}
		if (d.from.selection.length > 0 && d.to.selection.length > 0) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a containment with at most one selected side; ${d.from.relation} and ${d.to.relation} are both selected, and the first compiler admits a selected target or a selected source`
			)
		}
		switch (d.pairing.kind) {
			case "span":
				return this.#coverage(law, d, d.pairing, fromRel, toRel, loc, done)
			case "scalar":
				return this.#scalarContainment(law, d, fromRel, toRel, loc, done)
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
		const targets = new Set(
			this.#closedTuples(toRel, d.to, d.pairs, (p) => p.toColumn).map(tupleKey)
		)
		for (const t of this.#closedTuples(fromRel, d.from, d.pairs, (p) => p.fromColumn)) {
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

	/** The distinct facts of a closed relation that a side selects, each projected onto `columns`, a column's cell the
	 * fact's value of the field `fieldOf` gives. */
	#closedTuples<C>(
		r: ClosedTheoryRelation,
		side: ResolvedSide,
		columns: NonEmptyReadonlyArray<C>,
		fieldOf: (column: C) => LawField
	): ReadonlyArray<ClosedTuple<C>> {
		const cell = (row: ReadonlyArray<TypedLiteral>, f: LawField): TypedLiteral =>
			closedCell(row, f.position)
		const seen = new Set<string>()
		const out: Array<ClosedTuple<C>> = []
		for (const row of r.rows) {
			const selected = side.selection.every(
				(s) => literalKey(cell(row, s.col)) === literalKey(s.value)
			)
			if (!selected) {
				continue
			}
			const tuple = mapNonEmpty(columns, (column) => ({
				column,
				value: cell(row, fieldOf(column))
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
		toRel: ClosedTheoryRelation
	): ReadonlyArray<NativePlan> {
		const tuples = this.#closedTuples(toRel, d.to, d.pairs, (p) => p.toColumn)
		if (d.from.selection.length === 0) {
			const [only, ...more] = d.pairs
			const roster = rosterOf(baseOf(only.fromColumn.type))
			if (
				more.length === 0 &&
				only.to === "id" &&
				d.to.selection.length === 0 &&
				roster?.closed === toRel.name
			) {
				return [{ kind: "Enum", name: toRel.name, handles: roster.handles }]
			}
			return [
				{
					kind: "FiniteCheck",
					relation: fromRel,
					facts: tuples.map((t) =>
						mapNonEmpty(t, (c): FieldValue => ({ field: c.column.fromColumn, value: c.value }))
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
						left: field(column.fromColumn),
						right: literalAt(baseOf(column.fromColumn.type).carrier, value)
					}))
				)
			)
		)
		const check = this.#generatedCheck(fromRel, orP([notP(selectionPred(d.from)), membership]))
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

	/** The keys of `r` that a projection contains, or a refusal naming the missing key. */
	#keyedBy(
		r: TheoryRelation,
		fields: NonEmptyReadonlyArray<LawField>,
		loc: SourceLoc,
		what: string
	): NonEmptyReadonlyArray<LawField> {
		const exact = scalarKeys(r).find((k) => sameSet<LawField>(k, fields))
		if (exact !== undefined) {
			return exact
		}
		if (scalarKeys(r).some((k) => contains<LawField>(fields, k))) {
			return fields
		}
		return refuse(
			"UnsupportedLawFamily",
			loc,
			`${what} into a projection that contains a key of ${r.name}; (${fieldNames(fields).join(", ")}) contains none, and a containment into an unkeyed projection is not admitted`
		)
	}

	#scalarContainment(
		law: TheoryLaw,
		d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>,
		fromRel: TheoryRelation,
		toRel: TheoryRelation,
		loc: SourceLoc,
		done: (natives: ReadonlyArray<NativePlan>, residual: ResidualPlan | undefined) => LawPlan
	): LawPlan {
		const from = d.from
		const to = d.to
		if (to.selection.length > 0) {
			/** The tagged foreign key alone. */
			const selector = this.#oneSelector(to, loc)
			this.#keyedBy(toRel, to.columns, loc, "a containment into a selected target")
			if (to.columns.includes(selector.col)) {
				return refuse(
					"UnsupportedLawFamily",
					loc,
					`a selected target whose selector ${selector.column} is not a referenced field`
				)
			}
			const tag: TagRef = {
				relation: fromRel,
				target: toRel,
				field: selector.col,
				value: selector.value
			}
			const targetColumns = appendNonEmpty(to.columns, selector.col)
			return done(
				[
					{ kind: "StoredTag", tag },
					{ kind: "Unique", relation: toRel, columns: targetColumns },
					{
						kind: "TaggedForeignKey",
						relation: fromRel,
						columns: from.columns,
						tag,
						target: toRel,
						targetColumns
					},
					{ kind: "ReverseIndex", relation: fromRel, columns: from.columns }
				],
				undefined
			)
		}
		if (!isNonEmpty(from.selection)) {
			/** A foreign key, generating the unique target a superkey needs, and its reverse index. */
			const key = this.#keyedBy(toRel, to.columns, loc, "a containment")
			const natives: Array<NativePlan> = []
			if (!scalarKeys(toRel).some((k) => sameSet<LawField>(k, to.columns))) {
				natives.push({ kind: "Unique", relation: toRel, columns: key })
			}
			natives.push(
				{
					kind: "ForeignKey",
					relation: fromRel,
					columns: from.columns,
					target: toRel,
					targetColumns: to.columns
				},
				{ kind: "ReverseIndex", relation: fromRel, columns: from.columns }
			)
			return done(natives, undefined)
		}
		/** A selected source. A mirrors half from a selected side is the residual half of a conditional mirrors, anchored
		 * on that side's row; a `contained` is selected-source containment, anchored on the target row. */
		const selection = mapNonEmpty(from.selection, fieldSelector)
		switch (d.stated.kind) {
			case "mirrors":
				this.#keyedBy(fromRel, from.columns, loc, "a conditional mirrors' selected side")
				return done([], this.#conditionalMirrors(law, from, selection, fromRel, toRel, d.pairs))
			case "contained":
				this.#keyedBy(toRel, to.columns, loc, "a containment from a selected source")
				return done(
					[],
					this.#selectedSourceContainment(law, from, selection, fromRel, toRel, d.pairs)
				)
		}
	}

	/** Every selected source fact's projection is the key of a target row, the anchor, of the relation `target`, each
	 * source field paired with the target field it meets. Source insertion and target deletion threaten, so a mutable
	 * source's UPDATE checks its new anchor and a mutable target's its old key. */
	#selectedSourceContainment(
		law: TheoryLaw,
		from: ResolvedSide,
		selection: NonEmptyReadonlyArray<FieldSelector>,
		fromRel: TheoryRelation,
		toRel: TheoryRelation,
		pairs: NonEmptyReadonlyArray<ResolvedPair>
	): ResidualPlan {
		const key = mapNonEmpty(pairs, (p) => p.toColumn)
		const sourcePairs = anchorPairs(
			pairs,
			(p) => p.fromColumn,
			(p) => p.toColumn
		)
		const sourceKey = pairedColumns(sourcePairs)
		const sourceUpdate = inHeadingOrder([...from.columns, ...from.selection.map((s) => s.col)])
		const source: SelectedSide = { relation: fromRel, pairs: sourcePairs, selection }
		return {
			checks: {
				family: "selectedSourceContainment",
				source,
				participants: mergeParticipants(
					[
						inserting(fromRel, { key: sourceKey, guard: guardBy(from.selection) }, sourceUpdate),
						deleting(toRel, { key: anchorColumns(sourcePairs), guard: always }, inHeadingOrder(key))
					],
					mergeTwo
				)
			},
			anchor: { relation: toRel, key },
			violation: law.violation,
			indexes: [
				this.#indexRequest(
					fromRel.name,
					from.fields,
					"btree",
					"selected-source probe",
					this.#rowsOf(from)
				)
			],
			detail: detailOf(fromRel, from.columns)
		}
	}

	#oneSelector(side: ResolvedSide, loc: SourceLoc): ResolvedSelector {
		const only = side.selection[0]
		if (side.selection.length !== 1 || only === undefined) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a selected target with one selector field, which becomes its source's STORED tag; select(${side.relation}, ...) has ${side.selection.length}`
			)
		}
		return only
	}

	/** The parent, the anchor, requires its selected child of the relation `child`, each parent field paired with the
	 * child field it meets. Parent insertion and child deletion threaten, so a mutable parent's key or selector update
	 * checks the parent's new key, and a mutable child's move its old parent. */
	#conditionalMirrors(
		law: TheoryLaw,
		parent: ResolvedSide,
		selection: NonEmptyReadonlyArray<FieldSelector>,
		parentRel: TheoryRelation,
		childRel: TheoryRelation,
		pairs: NonEmptyReadonlyArray<ResolvedPair>
	): ResidualPlan {
		const key = mapNonEmpty(pairs, (p) => p.fromColumn)
		const childPairs = anchorPairs(
			pairs,
			(p) => p.toColumn,
			(p) => p.fromColumn
		)
		const parentKey = anchorColumns(childPairs)
		const childFields = mapNonEmpty(pairs, (p) => p.toColumn)
		const childKey = pairedColumns(childPairs)
		return {
			checks: {
				family: "conditionalMirrors",
				selection,
				child: { relation: childRel, pairs: childPairs },
				participants: mergeParticipants(
					[
						inserting(
							parentRel,
							{ key: parentKey, guard: guardBy(parent.selection) },
							inHeadingOrder([...parent.columns, ...parent.selection.map((s) => s.col)])
						),
						deleting(childRel, { key: childKey, guard: always }, inHeadingOrder(childFields))
					],
					mergeTwo
				)
			},
			anchor: { relation: parentRel, key },
			violation: law.violation,
			indexes: [this.#indexRequest(parentRel.name, parent.fields, "btree", "anchor read", allRows)],
			detail: detailOf(parentRel, parent.columns)
		}
	}

	/** Coverage into a target whose span key it matches is a PERIOD foreign key, a
	 * selected target adds a tag and a generated temporal unique constraint, and a selected source is the residual
	 * range_agg coverage law anchored on the target rows of the source's scalar group. */
	#coverage(
		law: TheoryLaw,
		d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>,
		span: Extract<ContainmentPairing, { readonly kind: "span" }>,
		fromRel: TheoryRelation,
		toRel: TheoryRelation,
		loc: SourceLoc,
		done: (natives: ReadonlyArray<NativePlan>, residual: ResidualPlan | undefined) => LawPlan
	): LawPlan {
		const from = d.from
		const to = d.to
		const pair = span.pair
		const hasSpanKey = declaredFields(toRel).some(
			(k) =>
				sameSet<LawField>(k, to.columns) &&
				k.filter(isSpanField).length === 1 &&
				k.includes(span.to)
		)
		if (!hasSpanKey) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`coverage into a target whose span key it matches; ${to.relation} has no span key over (${to.fields.join(", ")}), and coverage into a target without a span key needs an exact lowering the first compiler does not have`
			)
		}
		/** The scalar pairs: every pair but the spans'. */
		const scalars = d.pairs.filter((p) => p.from !== pair.from)
		if (!isNonEmpty(scalars)) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`coverage grouped by at least one scalar field; ${from.relation} into ${to.relation} pairs only spans, an ungrouped span law`
			)
		}
		const fromScalars = mapNonEmpty(scalars, (p) => p.from)
		const toScalars = mapNonEmpty(scalars, (p) => p.to)
		const toScalarFields = mapNonEmpty(scalars, (p) => p.toColumn)
		const fromScalarFields = mapNonEmpty(scalars, (p) => p.fromColumn)
		if (isNonEmpty(from.selection)) {
			const selection = mapNonEmpty(from.selection, fieldSelector)
			const sourcePairs = anchorPairs(
				scalars,
				(p) => p.fromColumn,
				(p) => p.toColumn
			)
			const sourceKey = pairedColumns(sourcePairs)
			const sourceUpdate = inHeadingOrder([...from.columns, ...from.selection.map((s) => s.col)])
			return done([], {
				checks: {
					family: "selectedSourceCoverage",
					target: {
						relation: toRel,
						pairs: anchorPairs(
							scalars,
							(p) => p.toColumn,
							(p) => p.toColumn
						),
						span: span.to,
						/** The residual accumulates the target spans into a multirange of the target span's carrier. */
						carrier: span.to.type.carrier
					},
					source: { relation: fromRel, pairs: sourcePairs, span: span.from, selection },
					participants: mergeParticipants(
						[
							inserting(fromRel, { key: sourceKey, guard: guardBy(from.selection) }, sourceUpdate),
							deleting(
								toRel,
								{ key: anchorColumns(sourcePairs), guard: always },
								inHeadingOrder(to.columns)
							)
						],
						mergeTwo
					)
				},
				anchor: { relation: toRel, key: toScalarFields },
				violation: law.violation,
				indexes: [
					this.#indexRequest(toRel.name, [...toScalars, pair.to], "gist", "group listing", allRows),
					this.#indexRequest(
						fromRel.name,
						fromScalars,
						"btree",
						"coverage probe",
						this.#rowsOf(from)
					)
				],
				detail: detailOf(fromRel, from.columns)
			})
		}
		const reverse: NativePlan = {
			kind: "ReverseIndex",
			relation: fromRel,
			columns: appendNonEmpty(fromScalarFields, span.from)
		}
		if (to.selection.length === 0) {
			return done(
				[
					{
						kind: "PeriodForeignKey",
						relation: fromRel,
						columns: fromScalarFields,
						span: span.from,
						target: toRel,
						targetColumns: toScalarFields,
						targetSpan: span.to
					},
					reverse
				],
				undefined
			)
		}
		const selector = this.#oneSelector(to, loc)
		if (to.columns.includes(selector.col)) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a selected target whose selector ${selector.column} is not a referenced field`
			)
		}
		const tag: TagRef = {
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
				{ kind: "StoredTag", tag },
				{ kind: "TemporalUnique", relation: toRel, columns: temporal, span: span.to },
				{
					kind: "TaggedPeriodForeignKey",
					relation: fromRel,
					columns: fromScalarFields,
					tag,
					span: span.from,
					target: toRel,
					targetColumns,
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
		const { low, high } = d.within
		const nonnegative = d.weight.kind !== "field"
		if (
			d.target.relation === d.from.relation &&
			d.pairs.every((p) => p.target === p.from) &&
			declaredKeys(target).some((k) => contains(d.target.fields, k))
		) {
			const check = this.#selfCapacity(d, target)
			return done(check === undefined ? [] : [check], undefined)
		}
		/** A count of at most one is the source's partial unique index's, never the function's. */
		const unique =
			d.weight.kind === "count" &&
			high === 1n &&
			d.target.selection.length === 0 &&
			typeof low === "bigint"
		const natives: ReadonlyArray<NativePlan> = unique
			? [
					{
						kind: "PartialUnique",
						relation: source,
						columns: d.from.columns,
						where: orderedSelectors(d.from).map(fieldSelector)
					}
				]
			: []
		/** The bounds a group can break, low before high: a count or a width is never negative, so a literal lower bound
		 * of zero or less holds for every group, and an upper bound the unique index enforces is not the function's.
		 * With none left the law holds in every state the natives allow, and needs no function. */
		const removes = nonnegative ? typeof low !== "bigint" || low > 0n : true
		const checkedHigh = unique ? undefined : d.bounds.high
		const lowBounds: ReadonlyArray<CheckedBound> = removes
			? [{ side: "low", value: d.bounds.low }]
			: []
		const bounds: ReadonlyArray<CheckedBound> =
			checkedHigh === undefined ? lowBounds : [...lowBounds, { side: "high", value: checkedHigh }]
		if (!isNonEmpty(bounds)) {
			return done(natives, undefined)
		}
		this.#capacityAnchor(d, target, loc)
		const adds = nonnegative ? checkedHigh !== undefined : true
		const refs = [d.bounds.low, d.bounds.high].flatMap((b) => (b?.kind === "ref" ? [b.field] : []))
		const sourceGuard = guardBy(d.from.selection)
		const sourcePairs = anchorPairs(
			d.pairs,
			(p) => p.fromColumn,
			(p) => p.targetColumn
		)
		const sourceKey = pairedColumns(sourcePairs)
		const key = mapNonEmpty(d.pairs, (p) => p.targetColumn)
		/** A source's insertion threatens a bound above and its deletion one below; a source neither threatens is no
		 * participant. */
		const sourceImage: ImagePlan = { key: sourceKey, guard: sourceGuard }
		const sourceEvents: PlanEvents | undefined = participantEvents(
			adds ? [sourceImage] : undefined,
			removes ? [sourceImage] : undefined,
			updateOf(
				source,
				inHeadingOrder([
					...d.from.columns,
					...weightFields(d.weighed),
					...d.from.selection.map((s) => s.col)
				])
			)
		)
		const targetPlan = inserting(
			target,
			{ key: anchorColumns(sourcePairs), guard: guardBy(d.target.selection) },
			inHeadingOrder([...key, ...refs, ...d.target.selection.map((s) => s.col)])
		)
		return done(natives, {
			checks: {
				family: "scalarCapacity",
				selection: d.target.selection.map(fieldSelector),
				source: {
					relation: source,
					pairs: sourcePairs,
					selection: d.from.selection.map(fieldSelector)
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
			anchor: { relation: target, key },
			violation: law.violation,
			indexes: [
				this.#indexRequest(
					source.name,
					d.from.fields,
					"btree",
					"group aggregate",
					this.#rowsOf(d.from)
				)
			],
			detail: detailOf(target, d.target.columns)
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
		if (!declaredKeys(target).some((k) => contains(d.target.fields, k))) {
			refuse(
				"UnsupportedLawFamily",
				loc,
				`a residual capacity whose target projection (${d.target.fields.join(", ")}) contains a declared key of ${d.target.relation}, so that its anchor is one target row`
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
		const selected = selectionPred(d.from)
		const body = orP([andP([selected, within(value)]), andP([notP(selected), within(0n)])])
		return this.#generatedCheck(target, orP([notP(selectionPred(d.target)), body]))
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
