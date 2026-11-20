import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Brand } from "effect"
import { nominal } from "#compiler/core/brand.ts"
import { bitsColumn, brandColumn, type Columned, codeColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { bytesDescriptor } from "#compiler/scalar/bytes.ts"
import { compute, searchDocumentTerm } from "#compiler/scalar/compute/builders.ts"
import { callerContractParts } from "#compiler/scalar/contract.ts"
import { dateDescriptor } from "#compiler/scalar/date.ts"
import { instantDescriptor } from "#compiler/scalar/instant.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { bareEnv, carrierSql, defineField } from "#compiler/scalar/registry.ts"
import { searchDescriptor } from "#compiler/scalar/search.ts"
import { spanColumn, spanParts } from "#compiler/scalar/span.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"
import {
	accumulatedField,
	bitsOf,
	closedIdOf,
	drawnField,
	generatedField,
	placeDescriptor,
	retirementField,
	slotField
} from "#compiler/schema/relation.ts"
import type { BitsApi } from "#compiler/types/compute/compute.ts"
import type { Scalar } from "#compiler/types/compute/scalar.ts"
import type {
	ContractValueOrigin,
	DomainOf,
	Facts,
	Parameterless,
	Predicate
} from "#compiler/types/core/phantom.ts"
import type {
	AccumulatedConstructor,
	BitsConstructor,
	ClosedIdConstructor,
	ContractBase,
	ContractConstructor,
	DrawnConstructor,
	GeneratedConstructor,
	GeneratedTermOf,
	NotInstantBase,
	OneContractName,
	Pg,
	SpanConstructor
} from "#compiler/types/fields/constructors.ts"

import type { TextSearchConfiguration } from "#compiler/ir/search.ts"
import type {
	AccumulatedField,
	Bits as BitsValue,
	BitsField,
	BytesField,
	ClosedIdField,
	ClosedSubset,
	Contract,
	DateField,
	DrawnField,
	DrawnType,
	Field,
	FieldBase,
	GeneratedField,
	HandleOf,
	Infer,
	InstantField,
	SpanEndpointLike,
	NaturalField,
	NoWriting,
	PlaceDescriptor,
	RetirementField,
	SpanField,
	SpanWidthOf,
	SubsetHandles
} from "#compiler/types/fields/field.ts"
import type {
	AnyClosedRelation,
	AnyRoster,
	DistinctMembers
} from "#compiler/types/schema/relation.ts"
import type { Fin, NaturalFieldOf, SlotField } from "#compiler/types/schema/statements.ts"
import type {
	SearchDocumentConstructor,
	SearchDocumentField,
	SearchPart
} from "#compiler/types/search/search.ts"

export { Decimal } from "#compiler/scalar/values/decimal.ts"
export { Money } from "#compiler/scalar/values/money.ts"
export type { Span } from "#compiler/scalar/values/span.ts"
/** The uuid host value, uuid_out's spelling as ArkRegex infers it, and its parse from a plain string. */
export { Uuid } from "#compiler/scalar/values/uuid.ts"
/** pgvector's carrier, a branded Float32Array. */
export { Vector } from "#compiler/scalar/values/vector.ts"
export type {
	AccumulatedField,
	BitsField,
	BytesField,
	CalendarDate,
	ClosedIdField,
	ClosedSubset,
	Contract,
	DateField,
	DrawnField,
	DrawnType,
	Field,
	FieldBase,
	GeneratedField,
	HandleOf,
	Infer,
	InstantDomain,
	InstantField,
	IntegerLike,
	SpanEndpointLike,
	LiteralOf,
	NaturalDomain,
	NaturalField,
	NumericField,
	NumericHostOf,
	NumericTypmodField,
	PatternField,
	PlaceDescriptor,
	PlaceField,
	RetirementField,
	SpanField,
	SpanWidthOf,
	SqlOf,
	SubsetHandles,
	TextField,
	WritingTag
} from "#compiler/types/fields/field.ts"
export type { VectorField } from "#compiler/types/vector/vector.ts"
export {
	textQueryMaxBytes,
	textSearchConfigurations,
	textSearchWeights
} from "#compiler/ir/search.ts"
export type {
	SearchDocument,
	SearchDocumentField,
	SearchPart,
	TextQuery,
	TextQueryParser,
	TextSearchConfiguration,
	TextSearchWeight
} from "#compiler/types/search/search.ts"

/**
 * Public barrel: Scalar field descriptors: uuid, natural, date, bytes, pg, contract, span and closedId, the runtime values of
 * packages/engine/src/scalar bound to their public signatures (types/fields), with the exact carriers Decimal and Money,
 * the uuid host value Uuid and pgvector's carrier Vector. str.regex is the text barrel's.
 *
 * The runtime descriptors carry their literal SQL names, their members and their columns (scalar/registry.ts
 * defineField), so each binding has its public type by construction: a descriptor's host type is its column's. A
 * contract is an unchecked brand constructor (core/brand.ts nominal, to Effect's type-level brand) with the contract's
 * members and Description defined onto it: it brands without checking, and the database validates on write; its column
 * is its base's, branded by that same constructor. A JavaScript caller can pass anything, an empty name or a fourth argument included, which the
 * admission cores refuse.
 */
export const uuid: Field<Uuid, "uuid"> = uuidDescriptor

/** natural: a bigint never below zero, the builtin contract over pg.bigint that pred reads (scalar/natural.ts). */
export const natural: NaturalField = naturalDescriptor

/** date: a calendar day, 0001-01-01 to 9999-12-31, its host value its ISO 8601 text (scalar/date.ts). */
export const date: DateField = dateDescriptor

/**
 * bytes: PostgreSQL's bytea, its host value a Uint8Array over its own ArrayBuffer, written and read back whole and
 * nothing else (scalar/bytes.ts).
 */
export const bytes: BytesField = bytesDescriptor

export const pg: Pg = pgDescriptors

export const contract: ContractConstructor = <
	const Name extends string,
	B extends FieldBase,
	Pr extends Predicate<never> = Predicate,
	const Proved extends ReadonlyArray<keyof Facts> = readonly []
>(
	name: Name,
	base: B &
		NoWriting &
		NotInstantBase<B> &
		ContractBase<NoInfer<Name>, B> &
		OneContractName<NoInfer<Name>>,
	predicate:
		| ((
				v: Scalar<DomainOf<B>, unknown, ContractValueOrigin, B["sql"], Infer<B>>
		  ) => Pr & Parameterless<Pr>)
		| undefined,
	declared: { readonly proves: Proved } | undefined,
	...extra: ReadonlyArray<never>
): Contract<Name, B, Proved> => {
	const parts = callerContractParts(name, base, [predicate, declared, ...extra])
	type Unbranded = Brand.Brand.Unbranded<Infer<B> & Brand.Brand<Name>>
	const brand = nominal<Unbranded, Unbranded & Infer<B> & Brand.Brand<Name>>()
	const column = brandColumn(base.column, brand)
	const members =
		parts.predicate === undefined
			? { name, base, column }
			: { name, base, predicate: parts.predicate, column }
	return defineField(brand, base.sql, parts.desc, members, parts.loc, parts.env)
}

/** A span over the endpoint the admission core admitted, its column converting endpoints with the endpoint's own. */
export const span: SpanConstructor = <E extends SpanEndpointLike>(
	endpoint: E & Columned<Infer<E>> & NoWriting,
	width: SpanWidthOf<Infer<E>> | undefined,
	...extra: ReadonlyArray<never>
): SpanField<Infer<E>, DomainOf<E>> => {
	const parts = spanParts(endpoint, [width, ...extra])
	const column = spanColumn(endpoint.column)
	return defineField(
		{},
		carrierSql.range4,
		parts.desc,
		width === undefined
			? { endpoint: parts.endpoint, column }
			: { endpoint: parts.endpoint, width, column },
		parts.loc,
		bareEnv
	)
}

/**
 * A reference to the roster the admission core admitted, holding the subset of its handles `subset` states or every
 * one, its column the roster's codes read as those literal handles.
 */
export const closedId: ClosedIdConstructor = <
	C extends AnyRoster,
	const Subset extends ClosedSubset<C> | undefined = undefined
>(
	roster: C & { readonly handles: ReadonlyArray<HandleOf<C>> },
	subset: Subset | undefined,
	...extra: ReadonlyArray<never>
): ClosedIdField<C, SubsetHandles<C, Subset>> => {
	const parts = closedIdOf(roster, [subset, ...extra])
	const only = parts.only === undefined ? undefined : new Set<string>(parts.only)
	/** Whether the closed id holds `handle`: every handle where it holds no subset, else its subset's (readSubset). */
	const holds = (handle: HandleOf<C>): handle is SubsetHandles<C, Subset> =>
		only === undefined || only.has(handle)
	return defineField(
		{},
		carrierSql.code,
		parts.desc,
		{
			roster,
			column: codeColumn<SubsetHandles<C, Subset>>(
				parts.roster.closed,
				roster.handles.filter(holds)
			)
		},
		parts.loc,
		parts.env
	)
}

/** A set over the roster the admission core admitted, its column a bit string read as the set of its codes' handles. */
export const bits: BitsConstructor = <C extends AnyRoster>(
	roster: C & { readonly handles: ReadonlyArray<HandleOf<C>> }
): BitsField<C> => {
	const parts = closedIdOf(roster, [])
	return defineField(
		{},
		carrierSql.bits,
		{ kind: "bits", roster: parts.roster.closed },
		{ roster, column: bitsColumn<BitsValue<C>>(parts.roster.closed) },
		SourceLoc(`bits(${parts.roster.closed})`, []),
		parts.env
	)
}

/** The Bits namespace: Bits.of, a set value, and the set algebra over set terms (BitsApi). */
type BitsNamespace = BitsApi & {
	readonly of: <C extends AnyRoster, const H extends ReadonlyArray<HandleOf<C>>>(
		roster: C,
		handles: H & DistinctMembers<H>
	) => BitsValue<C>
}

/**
 * Bits.of(roster, handles): the set of `handles`, each a handle of `roster`, each once; a fresh Set, branded by the
 * roster, which every boundary that admits it copies. A JavaScript caller's handle outside the roster, or a repeat, is MalformedDescription.
 * Beside it, the set algebra over set terms of one roster (types/compute/compute.ts BitsApi), the scalar catalogue's
 * members over the bits type.
 */
export const Bits: BitsNamespace = Object.freeze<BitsNamespace>({
	of: <C extends AnyRoster, const H extends ReadonlyArray<HandleOf<C>>>(
		roster: C,
		handles: H & DistinctMembers<H>,
		...extra: ReadonlyArray<never>
	): BitsValue<C> => bitsOf<C>(roster, handles, extra),
	union: (a, b) => compute.union(a, b),
	intersection: (a, b) => compute.intersection(a, b),
	difference: (a, b) => compute.difference(a, b),
	cardinality: (a) => compute.cardinality(a),
	subset: (a, b) => compute.subset(a, b),
	disjoint: (a, b) => compute.disjoint(a, b),
	singleton: (id) => compute.singleton(id)
})

/**
 * generated(type, term): a field PostgreSQL writes from its row, of `type`, whose value is `term`; it stands in the
 * record relation.generated's callback returns (schema/relation.ts generatedField).
 */
export const generated: GeneratedConstructor = <F extends FieldBase>(
	type: F & NoWriting,
	term: GeneratedTermOf<F>,
	...extra: ReadonlyArray<never>
): GeneratedField<F> => generatedField<F>(type, term, extra)

/**
 * searchDocument(configuration, [weight, text], ...): a generated field PostgreSQL parses from its row's texts under
 * `configuration`, one of pg_catalog's text search configurations, each text's positions labelled by its weight, A to
 * D, and the parts concatenated in their order: `setweight(to_tsvector(configuration, text), weight) || ...`, a
 * tsvector it stores and a GIN index serves the matches of. It stands in the record relation.generated's callback
 * returns, over the row's text fields; a query matches and ranks it with Search.matches, textRank and textRankCd.
 */
export const searchDocument: SearchDocumentConstructor = <const C extends TextSearchConfiguration>(
	configuration: C,
	...parts: NonEmptyReadonlyArray<SearchPart>
): GeneratedField<SearchDocumentField<C>> => {
	const descriptor = searchDescriptor(configuration)
	return generatedField<SearchDocumentField<C>>(
		descriptor,
		searchDocumentTerm(descriptor, parts),
		[]
	)
}

/**
 * retirement: a retirable statement's header field, a boolean false while its group is open and true once its group is
 * retired, never written by a caller (schema/relation.ts retirementField).
 */
export const retirement: RetirementField = retirementField(pgDescriptors.boolean)

/**
 * instant: microseconds since the Unix epoch on the database's clock, written only by the database: an insert stamps
 * its relation's clock per child, and a reference holds a stored instant a containment carries it to
 * (scalar/instant.ts, analysis/theory/instants.ts). Installed as natural's domain.
 */
export const instant: InstantField = instantDescriptor

/**
 * drawn(type): a value of `type`, natural or a contract over an integer, grizzle draws from the nested arrays its caller
 * writes (schema/relation.ts drawnField).
 */
export const drawn: DrawnConstructor = <const F extends FieldBase>(
	type: F & DrawnType<F>,
	...extra: ReadonlyArray<never>
): DrawnField<F> => drawnField<F>(type, extra)

/**
 * place: a row's place in its group, its primary key's fields before it, a natural the insert that adds the row stamps
 * one past the group's greatest, 0 for its first; `place.by(field)` is the place whose stored rows a migration that adds
 * it numbers in `field`'s order (schema/relation.ts placeDescriptor, analysis/theory/instants.ts).
 */
export const place: PlaceDescriptor = placeDescriptor

/**
 * slot(type, fin(O, n)): a closed relation's key field of `type`, a closed id, whose codes are fin(O, n)'s slots, O a
 * closed relation whose key pairs with the key's first fields: each owner's slots are the codes 0 to its count n - 1,
 * so the relation's constant holds each owner's block after the blocks before it instead of the key's full product
 * (schema/relation.ts slotField).
 */
export const slot = <
	F extends ClosedIdField<AnyRoster>,
	O extends AnyClosedRelation,
	const N extends NaturalFieldOf<O>
>(
	type: F,
	slots: Fin<O, N>,
	...extra: ReadonlyArray<never>
): SlotField<F, Fin<O, N>> => slotField(type, slots, extra)

/**
 * accumulated(type, start): a field grizzle fills on the host, `start` at its axis's base (schema/relation.ts
 * accumulatedField).
 */
export const accumulated: AccumulatedConstructor = <const F extends FieldBase>(
	type: F,
	start: Infer<F>,
	...extra: ReadonlyArray<never>
): AccumulatedField<F> => accumulatedField<F>(type, start, extra)
