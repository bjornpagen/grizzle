import type { DeclaredName, Identity } from "#compiler/core/identity.ts"
import type { ColumnIdent, DomainName, RaisedLawId, RelationIdent } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { appendNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { ExprTable, ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import type { LawIndexRequest } from "#compiler/ir/products.ts"
import type { DeclaredKey, HeadingColumn, RelNode } from "#compiler/ir/rel.ts"
import type { RegexRef, ScalarType, SpanCarrier, ValueType } from "#compiler/ir/scalar.ts"

/** The recognized shapes. */
const lawShapes = [
	"pk",
	"key",
	"contract",
	"check",
	"contained",
	"mirrorsHalf",
	"alternatives",
	"capacity",
	"spanKey",
	"coverage"
] as const
export type LawShape = (typeof lawShapes)[number]

/**
 * A field of a stored or closed relation, resolved once where the theory types its relation (analysis/theory/theory.ts):
 * the heading column a law reads it as, its name and type, and its installed column. A law that names the field carries
 * this handle, so no later pass looks the name up again.
 */
export interface LawField extends HeadingColumn {
	/** The descriptor ownership owned it with, which its type is typed from. */
	readonly desc: FieldDesc
	readonly column: ColumnIdent
	/** Its position in its relation's fields and heading, the order a closed relation's facts hold their values in. */
	readonly position: number
}

/**
 * A stored or closed relation, resolved once where the theory types it: its declared name, its installed table or enum
 * identifier, and its fields in declared order. A law, a native object or a residual law that names the relation
 * carries this handle.
 */
export interface LawRelation {
	readonly name: string
	readonly ident: RelationIdent
	readonly fields: NonEmptyReadonlyArray<LawField>
	/** The keys ownership declared on it, the primary key first, each with its constraint identifier. */
	readonly keyNames: ReadonlyArray<KeyName>
}

/** A span field's type: a range. */
export type SpanType = Extract<ScalarType, { readonly carrier: SpanCarrier }>

/** A field of a declared key: its relation's own handle, of any type, a vector's among them. */
export type KeyField = LawField

/** A key's span field: its relation's own handle, of a range type. */
export interface SpanField extends LawField {
	readonly type: SpanType
}

export const isSpanField = (f: LawField): f is SpanField =>
	f.type.carrier === "range4" || f.type.carrier === "range8"

/** The names of fields, in their order. */
export const fieldNames = (fields: ReadonlyArray<LawField>): ReadonlyArray<string> =>
	fields.map((f) => f.name)

/**
 * A key ownership declared: the handles of its fields in key order, its span field if it has one (ownership refuses a
 * key of two), whether it is the primary key, and the identity its constraint is named by.
 */
export interface KeyName {
	readonly fields: NonEmptyReadonlyArray<KeyField>
	readonly span: SpanField | undefined
	readonly primary: boolean
	readonly named: Identity<"primaryKey" | "key">
}

/**
 * A stored relation of the owned schema, resolved once where the checked schema types it (analysis/schema.ts): its
 * handle (LawRelation), its fields' handles in declared order (`fields`, the installed table's column order) and in
 * canonical order (`heading`), and its declared keys as names and as handles. A query, a write and the theory's laws
 * read this one handle.
 */
interface StoredRelationOf<Kind extends "relation" | "closed"> extends LawRelation {
	readonly kind: Kind
	/** Its fields in canonical order (analysis/schema.ts CheckedSchema): the heading a query reads it as and a write
	 * writes it as. */
	readonly heading: NonEmptyReadonlyArray<LawField>
	readonly primaryKey: DeclaredKey
	/** The additional candidate keys declared with key(), in statement order. */
	readonly keys: ReadonlyArray<DeclaredKey>
	/** The handles of the primary key's fields, in key order. */
	readonly primaryFields: NonEmptyReadonlyArray<KeyField>
	/** The handles of each additional candidate key's fields, as `keys` lists them. */
	readonly keyFields: ReadonlyArray<NonEmptyReadonlyArray<KeyField>>
	readonly mutable: boolean
	/** The schema level that declares it: 0 for the root schema, n for its n-th extension. */
	readonly level: number
	readonly loc: SourceLoc
}

/** An ordinary relation: the only kind a ChangeSet writes. */
export interface RelationInfo extends StoredRelationOf<"relation"> {
	/** The keys ownership declared on it, its primary key first. */
	readonly keyNames: NonEmptyReadonlyArray<KeyName>
	/** The fields declared as serial generation requests, in heading order. */
	readonly serial: ReadonlyArray<string>
}

/** A closed relation, whose primary key is its handle field `id`, with its facts. */
export interface ClosedTheoryRelation extends StoredRelationOf<"closed"> {
	/** The roster's handles, in roster order: a roster has at least one. */
	readonly handles: NonEmptyReadonlyArray<string>
	/** The facts as typed rows in declared field order (`fields`), the handle first, in roster order: one per handle. */
	readonly rows: NonEmptyReadonlyArray<ReadonlyArray<TypedLiteral>>
}

/** A stored relation the theory's laws read: an ordinary relation, or a closed relation with its facts. */
export type TheoryRelation = RelationInfo | ClosedTheoryRelation

/** A heading's columns as an IR node carries them: each field's name and type, never its handle. */
export const headingColumns = (
	fields: NonEmptyReadonlyArray<LawField>
): NonEmptyReadonlyArray<HeadingColumn> =>
	mapNonEmpty(fields, (f): HeadingColumn => ({ name: f.name, type: f.type }))

/** A literal selector of a law side: the side's facts whose `column` holds `value`. */
export interface Selector {
	readonly column: string
	readonly value: TypedLiteral
}

/** A selector of a native object's or a residual law's side: the handle of the field it selects, and its literal. */
export interface FieldSelector {
	readonly field: LawField
	readonly value: TypedLiteral
}

/**
 * One side of a law: a relation's projection, optionally restricted by literal selectors. A check's side projects the
 * fields its predicate mentions, which may be none.
 */
export interface LawSide {
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	readonly selection: ReadonlyArray<Selector>
}

/**
 * A side a statement declares (desc.ts SideDesc), as a containment's and a capacity's are: a projection on at least
 * one field.
 */
export interface DeclaredSide extends LawSide {
	readonly fields: NonEmptyReadonlyArray<string>
}

/**
 * What declares a law: `statement` is the index of the declaring statement in the schema description, of the relation
 * for a primary key, or of the contract for a contract. A contained or mirrors statement, an alternatives family's
 * included, also names the alternatives expansion it came from, or undefined for one declared as itself.
 */
export type LawSource =
	| {
			readonly kind: "relation" | "key" | "contract" | "check" | "capacity"
			readonly statement: number
	  }
	| {
			readonly kind: "contained" | "mirrors"
			readonly statement: number
			readonly alternatives: string | undefined
	  }

/**
 * Laws: the normalized law node, its native objects, and its residual law.
 *
 * Every law is one IR node, a violation query that must be empty (rel.ts Forbid); the public constructors
 * produce its recognized shapes. A NormalizedLaw records one recognized obligation with its source identity. Its
 * LawLowering partitions it into exact native objects and at most one residual law: one deferred constraint trigger
 * per participating table and threatening event, each executing its own PL/pgSQL function, anchored so that every
 * threatening event fires its trigger or modifies an anchor.
 *
 * The absent-anchor rule of each residual family is fixed and frozen here. A residual law's type carries its shape: a
 * nonempty anchor key, one participant per participating table with an INSERT or a DELETE and each event kind once,
 * each event its own unit, row images and DETAIL keys, and its family with exactly the detail that family checks,
 * recognized once, so a family's plug-in never reads the theory again. Only a mutable participant has an UPDATE event,
 * the world roles that write its relation alone holding UPDATE.
 */
export interface NormalizedLaw {
	readonly id: RaisedLawId
	readonly source: LawSource
	readonly shape: LawShape
	readonly sides: ReadonlyArray<LawSide>
	/** The Forbid node whose violation query must be empty, a node of the theory's DAG. */
	readonly violation: RelNode
	/**
	 * Where the law is declared: its first declaring statement's location, or for a law no statement declares, the
	 * relation of its primary key or its contract.
	 */
	readonly loc: SourceLoc
}

/**
 * Native objects: laws the database enforces itself. A native body is what the object is; the object records every
 * law it discharges besides.
 */
type NativeBody =
	| {
			readonly kind: "PrimaryKey"
			readonly relation: LawRelation
			readonly columns: NonEmptyReadonlyArray<KeyField>
			/** The identity ownership named the primary key's constraint by. */
			readonly named: Identity<"primaryKey" | "key">
	  }
	| {
			readonly kind: "Unique"
			readonly relation: LawRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
	  }
	| {
			readonly kind: "PartialUnique"
			readonly relation: LawRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
			readonly where: ReadonlyArray<FieldSelector>
	  }
	| {
			readonly kind: "Domain"
			readonly name: DeclaredName
			/** The domain's identity at the naming door, and that identity's identifier. */
			readonly named: Identity<"contractDomain">
			readonly domain: DomainName
			readonly base: ValueType
			readonly check: DomainCheck
	  }
	| {
			readonly kind: "TableCheck"
			readonly relation: LawRelation
			readonly check: TableCheckOrigin
			readonly predicate: ScalarExpr
	  }
	| { readonly kind: "Enum"; readonly name: string; readonly handles: ReadonlyArray<string> }
	| {
			readonly kind: "FiniteCheck"
			readonly relation: LawRelation
			/** The facts the checked fields must hold together, each a tuple of the checked fields' values in field order. */
			readonly facts: ReadonlyArray<NonEmptyReadonlyArray<FieldValue>>
	  }
	| {
			readonly kind: "ForeignKey"
			readonly relation: LawRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
			readonly target: LawRelation
			readonly targetColumns: NonEmptyReadonlyArray<LawField>
			readonly deferrable: boolean
	  }
	| {
			readonly kind: "TaggedForeignKey"
			readonly relation: LawRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
			/** The child's constant STORED tag column. */
			readonly tag: ColumnIdent
			readonly target: LawRelation
			readonly targetColumns: NonEmptyReadonlyArray<LawField>
	  }
	| {
			readonly kind: "StoredTag"
			readonly relation: LawRelation
			readonly column: ColumnIdent
			readonly value: TypedLiteral
			readonly selector: { readonly relation: LawRelation; readonly field: LawField }
	  }
	| {
			readonly kind: "WithoutOverlaps"
			readonly relation: LawRelation
			readonly span: SpanField
			readonly key: SpanKeyScalars
			/** The identity ownership named the span key's constraint by. */
			readonly named: Identity<"primaryKey" | "key">
	  }
	| {
			readonly kind: "PeriodForeignKey"
			readonly relation: LawRelation
			readonly columns: ReadonlyArray<LawField>
			readonly span: SpanField
			readonly target: LawRelation
			readonly targetColumns: ReadonlyArray<LawField>
			readonly targetSpan: SpanField
	  }
	| {
			readonly kind: "TaggedPeriodForeignKey"
			readonly relation: LawRelation
			readonly columns: ReadonlyArray<LawField>
			readonly tag: ColumnIdent
			readonly span: SpanField
			readonly target: LawRelation
			readonly targetColumns: NonEmptyReadonlyArray<LawField>
			readonly targetSpan: SpanField
	  }
	| {
			readonly kind: "TemporalUnique"
			readonly relation: LawRelation
			readonly columns: NonEmptyReadonlyArray<KeyField>
			readonly span: SpanField
	  }
	| {
			readonly kind: "ReverseIndex"
			readonly relation: LawRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
	  }

/**
 * What a row CHECK enforces: a declared row check, its name and the identity ownership named its constraint by, or a
 * CHECK the law model generates for a law, named for its table and that law at the naming door.
 */
export type TableCheckOrigin =
	| { readonly kind: "declared"; readonly name: string; readonly named: Identity<"check"> }
	| { readonly kind: "generated"; readonly law: RaisedLawId }

/** A field's value in a fact: the handle of the field, and the literal the fact holds there. */
export interface FieldValue {
	readonly field: LawField
	readonly value: TypedLiteral
}

/**
 * The scalar fields of a span key, compared for equality before its span: a primary key has one at least, since
 * PostgreSQL's PRIMARY KEY needs a column before WITHOUT OVERLAPS (42601); a candidate key may have none.
 */
export type SpanKeyScalars =
	| { readonly kind: "primary"; readonly scalars: NonEmptyReadonlyArray<KeyField> }
	| { readonly kind: "unique"; readonly scalars: ReadonlyArray<KeyField> }

/** The fields of a span key in its index's order: its scalar fields, then its span. */
export const spanKeyColumns = (o: {
	readonly span: SpanField
	readonly key: SpanKeyScalars
}): NonEmptyReadonlyArray<KeyField> => appendNonEmpty(o.key.scalars, o.span)

export type NativeObject = { readonly lawIds: NonEmptyReadonlyArray<RaisedLawId> } & NativeBody

/** A contract's domain native. */
export type DomainNative = Extract<NativeObject, { readonly kind: "Domain" }>

export type NativeOf<K extends NativeObject["kind"]> = Extract<NativeObject, { readonly kind: K }>

/**
 * The CHECK a contract's domain carries, <name>__check: the conjunction of its terms, its base's refined text pattern
 * first, then its own predicate. A contract over a contract checks only its own predicate,
 * since the inner domain checks the rest; a brand-only contract over an unrefined base has none.
 */
export type DomainCheck =
	| { readonly kind: "unchecked" }
	| {
			readonly kind: "checked"
			readonly terms: NonEmptyReadonlyArray<DomainCheckTerm>
	  }

/** One term of a domain CHECK: membership in its base's refined text pattern, or the contract's predicate. */
export type DomainCheckTerm =
	| { readonly kind: "pattern"; readonly regex: RegexRef }
	| { readonly kind: "predicate"; readonly predicate: ExprTable }

export type NativeKind = NativeObject["kind"]

/** The admitted residual families. */
const residualFamilies = [
	"alternativesReverse",
	"conditionalMirrors",
	"selectedSourceContainment",
	"scalarCapacity",
	"selectedSourceCoverage"
] as const
export type ResidualFamily = (typeof residualFamilies)[number]

export type AbsentAnchor = "noObligation" | "violation"

/**
 * What an absent anchor means for each family. Where the anchor carries the obligation, absence is
 * no obligation; where the obligation points to it, absence is a violation.
 */
export const familyAbsentAnchor: Readonly<Record<ResidualFamily, AbsentAnchor>> = {
	alternativesReverse: "noObligation",
	conditionalMirrors: "noObligation",
	selectedSourceContainment: "violation",
	scalarCapacity: "noObligation",
	selectedSourceCoverage: "violation"
}

/**
 * What guards a row image: always checked, or checked only when the row satisfies one of the selections of the sides
 * it plays (the recognizer records it; laws/residual skeleton.ts reads it).
 */
export type ImageGuard =
	| { readonly kind: "always" }
	| {
			readonly kind: "selected"
			readonly selections: NonEmptyReadonlyArray<NonEmptyReadonlyArray<FieldSelector>>
	  }

/**
 * One row image of an event, the anchor key it gives and its guard: one component per anchor-key field, in anchor-key
 * order (`KeyComponent`); the image gives its key only when its row passes the guard.
 */
export interface KeyImage {
	readonly key: NonEmptyReadonlyArray<KeyComponent>
	readonly guard: ImageGuard
}

/** A row image as its event reads it: an insertion's of NEW, a deletion's of OLD. */
export interface SidedImage {
	readonly side: "old" | "new"
	readonly image: KeyImage
}

/** Images of one side, each as its event reads it. */
const sided = (images: Images, side: "old" | "new"): NonEmptyReadonlyArray<SidedImage> =>
	mapNonEmpty(images, (image) => ({ side, image }))

/**
 * One component of an image's anchor key: the participant field that holds it, its family's pairing at that anchor-key
 * field (`AnchorPair`: the field of the side the family pairs with the anchor, or the anchor's own for a family that
 * pairs none by the key), and the field's column of the image's Delta in the law model's DAG (laws/model/model.ts),
 * the added side for the NEW image and the removed side for the OLD one.
 */
export interface KeyComponent {
	readonly field: LawField
	readonly pair: AnchorPair
	readonly expr: ScalarExpr
}

/** The row images an event checks, the anchor key each gives. */
export type Images = NonEmptyReadonlyArray<KeyImage>

/** An UPDATE's fields whose change matters. An UPDATE is the deletion of OLD and the insertion of NEW, so its images
 * are the participant's DELETE images on OLD and its INSERT images on NEW (`updateImages`), and no other. */
export interface UpdateOf {
	readonly of: NonEmptyReadonlyArray<LawField>
}

/** One threatening event of a participant: what it checks, the trigger that fires on it alone, and the function that
 * trigger alone executes. */
export interface EventUnit<E> {
	readonly on: E
	readonly trigger: Identity<"lawTrigger">
	readonly function: Identity<"lawFunction">
}

/**
 * The threatening events of one relation, each kind at most once, by what each holds: an INSERT, a DELETE or both, and
 * an UPDATE beside either. An UPDATE threatens only as the deletion of OLD and the insertion of NEW, so no relation
 * has an UPDATE alone.
 */
export type EventsOf<I extends object, U extends object> = InsertEvents<I, U> | DeleteEvents<I, U>
interface InsertEvents<I, U> {
	readonly insert: I
	readonly delete: I | undefined
	readonly update: U | undefined
}
interface DeleteEvents<I, U> {
	readonly insert: undefined
	readonly delete: I
	readonly update: U | undefined
}

/**
 * Whether the events hold an INSERT, else a DELETE. An event is an object, so its absence alone is undefined; a generic
 * event type is no discriminant TypeScript narrows by, so the generic readers narrow through this.
 */
const inserts = <I extends object, U extends object>(
	events: EventsOf<I, U>
): events is InsertEvents<I, U> => events.insert !== undefined

/** The threatening events of the law's event table on one relation: an INSERT, a DELETE or both, each with the images
 * it checks, and an UPDATE when the relation is `mutable`, whose images are theirs. Each is its own unit. */
export type ParticipantEvents = EventsOf<EventUnit<Images>, EventUnit<UpdateOf>>

/** The events of a relation from each kind, or none when neither an INSERT nor a DELETE threatens it, and so no UPDATE
 * either. */
export const participantEvents = <I extends object, U extends object>(
	insert: I | undefined,
	del: I | undefined,
	update: U | undefined
): EventsOf<I, U> | undefined =>
	insert !== undefined
		? { insert, delete: del, update }
		: del !== undefined
			? { insert: undefined, delete: del, update }
			: undefined

/** The events with each INSERT and DELETE mapped by `image` and the UPDATE by `update`, each kind kept. */
export const mapEvents = <I extends object, U extends object, J extends object, V extends object>(
	events: EventsOf<I, U>,
	image: (i: I, event: "INSERT" | "DELETE") => J,
	update: (u: U) => V
): EventsOf<J, V> => {
	const updated = events.update === undefined ? undefined : update(events.update)
	if (inserts(events)) {
		return {
			insert: image(events.insert, "INSERT"),
			delete: events.delete === undefined ? undefined : image(events.delete, "DELETE"),
			update: updated
		}
	}
	return { insert: undefined, delete: image(events.delete, "DELETE"), update: updated }
}

/** An UPDATE's images: its DELETE's, on OLD, then its INSERT's, on NEW. */
export const updateImages = <I extends { readonly on: Images }, U extends object>(
	events: EventsOf<I, U>
): NonEmptyReadonlyArray<SidedImage> => {
	if (!inserts(events)) {
		return sided(events.delete.on, "old")
	}
	const inserted = sided(events.insert.on, "new")
	return events.delete === undefined ? inserted : [...sided(events.delete.on, "old"), ...inserted]
}

/** What a reader makes of each event unit of a participant, with the images its event reads, each on its side. */
export interface EventCases<A> {
	readonly insert: (unit: EventUnit<Images>, images: NonEmptyReadonlyArray<SidedImage>) => A
	readonly delete: (unit: EventUnit<Images>, images: NonEmptyReadonlyArray<SidedImage>) => A
	readonly update: (unit: EventUnit<UpdateOf>, images: NonEmptyReadonlyArray<SidedImage>) => A
}

/** A participant's event units in INSERT, DELETE, UPDATE order, each made by its case. */
export const eventsInOrder = <A>(
	events: ParticipantEvents,
	cases: EventCases<A>
): NonEmptyReadonlyArray<A> => {
	const update =
		events.update === undefined ? [] : [cases.update(events.update, updateImages(events))]
	if (events.insert === undefined) {
		return [cases.delete(events.delete, sided(events.delete.on, "old")), ...update]
	}
	return [
		cases.insert(events.insert, sided(events.insert.on, "new")),
		...(events.delete === undefined
			? []
			: [cases.delete(events.delete, sided(events.delete.on, "old"))]),
		...update
	]
}

/** One participating relation of a residual law and its event units. */
export interface Participant {
	readonly relation: LawRelation
	readonly events: ParticipantEvents
}

/**
 * The fixed text encoding of a residual law's DETAIL: its tag, the relation, then the key columns in order
 * (laws/model/detail.ts is the codec).
 */
export interface DetailCodec {
	readonly relation: LawRelation
	readonly keys: NonEmptyReadonlyArray<LawField>
}

/** A DETAIL codec by name, as a digest and the runtime's decoder read it. */
export interface NamedDetailCodec {
	readonly relation: string
	readonly keys: NonEmptyReadonlyArray<string>
}

/** The codec's names, which its digest and the runtime's decoder read. */
export const namedDetail = (d: DetailCodec): NamedDetailCodec => ({
	relation: d.relation.name,
	keys: mapNonEmpty(d.keys, (k) => k.name)
})

/** The relation whose rows a residual law reads as its anchor, and their key, the order an affected key is given in. */
export interface Anchor {
	readonly relation: LawRelation
	readonly key: NonEmptyReadonlyArray<LawField>
}

/**
 * A side of a residual law beside its anchor: a relation's fields, each paired with the anchor key field it meets,
 * in anchor key order (`AnchorPair`).
 */
export interface PairedSide {
	readonly relation: LawRelation
	readonly pairs: NonEmptyReadonlyArray<AnchorPair>
}

/** A side's field and the anchor key field it meets. */
export interface AnchorPair {
	readonly field: LawField
	readonly anchor: LawField
}

/** A paired side with its span field: the scalar fields pair with the anchor key, the span is the cover's. */
export interface SpanSide extends PairedSide {
	readonly span: LawField
}

/**
 * A coverage's target side: its span field's carrier is the one its cover accumulates the spans in, int4multirange for
 * range4 and int8multirange for range8.
 */
export interface CoverTarget extends SpanSide {
	readonly carrier: SpanCarrier
}

/** A paired side whose facts its literal selectors choose, if any. */
interface ResidualSide extends PairedSide {
	readonly selection: ReadonlyArray<FieldSelector>
}

/** A paired side whose facts are chosen by at least one literal selector. */
export interface SelectedSide extends PairedSide {
	readonly selection: NonEmptyReadonlyArray<FieldSelector>
}

/** One arm of an alternatives law: a handle, and the payload relation a parent selecting it owes, keyed like the
 * parent. */
export interface AlternativesArm extends PairedSide {
	readonly handle: string
}

/** A handle of an alternatives roster: armed, owing its arm's payload row, or unarmed, owing nothing. The theory's arm
 * carries its declaring statement, a residual law's its pairs. */
export type RosterHandleOf<Arm> =
	| { readonly kind: "armed"; readonly arm: Arm }
	| { readonly kind: "unarmed"; readonly handle: string }

/** A handle of an alternatives roster as the parent's function dispatches it. */
export type RosterHandle = RosterHandleOf<AlternativesArm>

/** A roster handle's own handle. */
export const handleOf = <Arm extends { readonly handle: string }>(
	h: RosterHandleOf<Arm>
): string => {
	switch (h.kind) {
		case "armed":
			return h.arm.handle
		case "unarmed":
			return h.handle
	}
}

/** What one participating relation's writes can leave unpaid, which its functions re-check for each affected parent:
 * every handle of the roster, in roster order, for the parent; only its own arms, in roster order, for an arm
 * relation. */
export type AlternativesCheck =
	| { readonly kind: "roster"; readonly handles: NonEmptyReadonlyArray<RosterHandle> }
	| { readonly kind: "arms"; readonly arms: NonEmptyReadonlyArray<AlternativesArm> }

/** An alternatives law's participant, with what its writes can leave unpaid. */
export interface AlternativesParticipant extends Participant {
	readonly check: AlternativesCheck
}

/**
 * A capacity's group total: COUNT's bigint, or the exact SUM of its weight, a bigint or a numeric (a width sums as
 * numeric); its carrier, and its type, which a residual's zero branch and literal bounds are written in.
 */
export interface CapacityAggregate {
	readonly carrier: "int8" | "numeric"
	readonly type: ScalarType
}

/** The carriers a capacity compares its total and a bound in exactly: the integers, numeric and money. */
export type ExactCarrier = "int2" | "int4" | "int8" | "numeric" | "money"

/**
 * A capacity bound as its normalization parsed it, compared with the group's total exactly: a literal of the total's
 * type, or a field of the target row with the exact carrier the two meet in (analysis/theory/laws.ts comparisonCarrier).
 */
export type CapacityBound =
	| {
			readonly kind: "literal"
			readonly literal: TypedLiteral
			/** The integer as the statement states it, before it is typed at the total's type. */
			readonly stated: bigint
	  }
	| { readonly kind: "ref"; readonly field: LawField; readonly carrier: ExactCarrier }

/** A capacity's bounds as parsed: its lower one, and its upper one, which `within(low, "*")` leaves undefined. */
export interface CapacityBounds {
	readonly low: CapacityBound
	readonly high: CapacityBound | undefined
}

/** A bound a group's total can break, below or above, and what it is compared with. */
export interface CheckedBound {
	readonly side: "low" | "high"
	readonly value: CapacityBound
}

/** What each family checks beyond its anchor, as the recognizer found it (laws/model plan.ts), with its participants:
 * `P` for every family but alternatives, whose participants `A` carry what each can leave unpaid. */
export type FamilyDetail<P, A> =
	| {
			readonly family: "selectedSourceContainment"
			readonly source: SelectedSide
			readonly participants: P
	  }
	| {
			readonly family: "conditionalMirrors"
			readonly selection: NonEmptyReadonlyArray<FieldSelector>
			readonly child: PairedSide
			readonly participants: P
	  }
	| {
			readonly family: "alternativesReverse"
			readonly discriminator: LawField
			readonly participants: A
	  }
	| {
			readonly family: "scalarCapacity"
			readonly selection: ReadonlyArray<FieldSelector>
			readonly source: ResidualSide
			readonly weight: LawWeight
			readonly aggregate: CapacityAggregate
			readonly bounds: NonEmptyReadonlyArray<CheckedBound>
			readonly participants: P
	  }
	| {
			readonly family: "selectedSourceCoverage"
			readonly target: CoverTarget
			readonly source: SelectedSide & { readonly span: LawField }
			readonly participants: P
	  }

/** A family's detail with its participants mapped: `p` for every family but alternatives, `a` for alternatives. */
export const withParticipants = <P, A, Q, B>(
	d: FamilyDetail<P, A>,
	p: (participants: P) => Q,
	a: (participants: A) => B
): FamilyDetail<Q, B> => {
	switch (d.family) {
		case "alternativesReverse":
			return { ...d, participants: a(d.participants) }
		case "selectedSourceContainment":
		case "conditionalMirrors":
		case "scalarCapacity":
		case "selectedSourceCoverage":
			return { ...d, participants: p(d.participants) }
	}
}

/** What each family checks beyond its anchor, with its participants: one per participating relation, in law order. */
export type ResidualDetail = FamilyDetail<
	NonEmptyReadonlyArray<Participant>,
	NonEmptyReadonlyArray<AlternativesParticipant>
>

/** How a capacity weighs each source fact: one each, or by the source field's value or its span's width. */
export type LawWeight =
	| { readonly kind: "count" }
	| { readonly kind: "field" | "duration"; readonly field: LawField }

/**
 * A residual law: its family with the detail the family checks and its participants' event units. What an absent anchor
 * means is its family's (familyAbsentAnchor).
 */
export type ResidualLaw = ResidualDetail & {
	readonly lawId: RaisedLawId
	readonly anchor: Anchor
	readonly violation: RelNode
	/**
	 * The indexes its probes need: the anchor read's or the violation probe's, and for a selected-source coverage law
	 * both, the target's listing and the source's probe.
	 */
	readonly indexes: NonEmptyReadonlyArray<LawIndexRequest>
	readonly detail: DetailCodec
}

export type FamilyLaw<F extends ResidualFamily> = Extract<ResidualLaw, { readonly family: F }>

/** One event unit of a residual law with its participant and the images its event reads: an INSERT's or a DELETE's
 * images, or an UPDATE's fields, by its event. */
export type LawUnit =
	| {
			readonly participant: ResidualLaw["participants"][number]
			readonly event: "INSERT" | "DELETE"
			readonly unit: EventUnit<Images>
			readonly images: NonEmptyReadonlyArray<SidedImage>
	  }
	| {
			readonly participant: ResidualLaw["participants"][number]
			readonly event: "UPDATE"
			readonly unit: EventUnit<UpdateOf>
			readonly images: NonEmptyReadonlyArray<SidedImage>
	  }

/** Every event unit of a residual law, participant by participant in law order, each in INSERT, DELETE, UPDATE order. */
export const lawUnits = (law: ResidualLaw): NonEmptyReadonlyArray<LawUnit> => {
	const [first, ...rest] = law.participants
	const of = (participant: ResidualLaw["participants"][number]) =>
		eventsInOrder(participant.events, {
			insert: (unit, images): LawUnit => ({ participant, event: "INSERT", unit, images }),
			delete: (unit, images): LawUnit => ({ participant, event: "DELETE", unit, images }),
			update: (unit, images): LawUnit => ({ participant, event: "UPDATE", unit, images })
		})
	return [...of(first), ...rest.flatMap((p) => of(p))]
}

export interface LawLowering {
	readonly natives: ReadonlyArray<NativeObject>
	/** The residual law, or undefined when the natives enforce the law alone. */
	readonly residual: ResidualLaw | undefined
}
