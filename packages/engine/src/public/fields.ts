import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Brand } from "effect"
import { nominal } from "#compiler/core/brand.ts"
import { bitsColumn, brandColumn, type Columned, codeColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { bytesDescriptor } from "#compiler/scalar/bytes.ts"
import { callerContractParts } from "#compiler/scalar/contract.ts"
import { dateDescriptor } from "#compiler/scalar/date.ts"
import { instantDescriptor } from "#compiler/scalar/instant.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { bareEnv, carrierSql, defineField } from "#compiler/scalar/registry.ts"
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
	roster: C & { readonly handles: NonEmptyReadonlyArray<HandleOf<C>> },
	subset: Subset | undefined,
	...extra: ReadonlyArray<never>
): ClosedIdField<C, SubsetHandles<C, Subset>> => {
	const parts = closedIdOf(roster, [subset, ...extra])
	const only = parts.only === undefined ? undefined : new Set<string>(parts.only)
	/** Whether the closed id holds `handle`: every handle where it holds no subset, else its subset's (readSubset). */
	const holds = (handle: HandleOf<C>): handle is SubsetHandles<C, Subset> =>
		only === undefined || only.has(handle)
	const [first, ...rest] = roster.handles.filter(holds)
	if (first === undefined) {
		throw defect("a closed id's subset holds some handle (scalar/closed-id.ts readSubset)")
	}
	return defineField(
		{},
		carrierSql.code,
		parts.desc,
		{ roster, column: codeColumn<SubsetHandles<C, Subset>>(parts.roster.closed, [first, ...rest]) },
		parts.loc,
		parts.env
	)
}

/** A set over the roster the admission core admitted, its column a bit string read as the set of its codes' handles. */
export const bits: BitsConstructor = <C extends AnyRoster>(
	roster: C & { readonly handles: NonEmptyReadonlyArray<HandleOf<C>> }
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

/**
 * Bits.of(roster, handles): the set of `handles`, each a handle of `roster`, each once; a fresh Set, branded by the
 * roster, which every boundary that admits it copies. A JavaScript caller's handle outside the roster, or a repeat, is MalformedDescription.
 */
export const Bits: {
	readonly of: <C extends AnyRoster, const H extends ReadonlyArray<HandleOf<C>>>(
		roster: C,
		handles: H & DistinctMembers<H>
	) => BitsValue<C>
} = Object.freeze({
	of: <C extends AnyRoster, const H extends ReadonlyArray<HandleOf<C>>>(
		roster: C,
		handles: H & DistinctMembers<H>,
		...extra: ReadonlyArray<never>
	): BitsValue<C> => bitsOf<C>(roster, handles, extra)
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

/** drawn(natural): a natural grizzle draws from the nested arrays its caller writes (schema/relation.ts drawnField). */
export const drawn: DrawnConstructor = (
	type: NaturalField,
	...extra: ReadonlyArray<never>
): DrawnField => drawnField(type, extra)

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
