import type { Brand } from "effect"
import { nominal } from "#compiler/core/brand.ts"
import { bitsColumn, brandColumn, type Columned, codeColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { closedIdParts } from "#compiler/scalar/closed-id.ts"
import { contractParts } from "#compiler/scalar/contract.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import { bareEnv, carrierSql, defineField } from "#compiler/scalar/registry.ts"
import { spanColumn, spanParts } from "#compiler/scalar/span.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"
import { accumulatedField, bitsOf, drawnField, generatedField } from "#compiler/schema/relation.ts"
import type { Scalar } from "#compiler/types/compute/scalar.ts"
import type {
	BaseOf,
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
	NotSerialBase,
	OneContractName,
	Pg,
	SpanConstructor
} from "#compiler/types/fields/constructors.ts"

import type {
	AccumulatedField,
	Bits as BitsValue,
	BitsField,
	ClosedIdField,
	Contract,
	DrawnField,
	Field,
	FieldBase,
	GeneratedField,
	HandleOf,
	Infer,
	IntegerLike,
	NaturalField,
	NotSerial,
	SpanField
} from "#compiler/types/fields/field.ts"
import type { AnyRoster, DistinctMembers } from "#compiler/types/schema/relation.ts"

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
	ClosedIdField,
	Contract,
	DrawnField,
	Field,
	FieldBase,
	FloatField,
	GeneratedField,
	HandleOf,
	Infer,
	IntegerLike,
	LiteralOf,
	NaturalField,
	NumericTypmodField,
	SerialField,
	SpanField,
	SqlOf,
	TextField,
	WritingTag
} from "#compiler/types/fields/field.ts"
export type { VectorField } from "#compiler/types/vector/vector.ts"

/**
 * Public barrel: Scalar field descriptors: uuid, natural, pg, contract, span and closedId, the runtime values of
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

export const pg: Pg = pgDescriptors

export const contract: ContractConstructor = <
	const Name extends string,
	B extends FieldBase,
	Pr extends Predicate = Predicate,
	const Proved extends ReadonlyArray<keyof Facts> = readonly []
>(
	name: Name,
	base: B & NotSerialBase<B> & ContractBase<NoInfer<Name>, B> & OneContractName<NoInfer<Name>>,
	predicate:
		| ((v: Scalar<DomainOf<B>, unknown, unknown, B["sql"], Infer<B>>) => Pr & Parameterless<Pr>)
		| undefined,
	declared: { readonly proves: Proved } | undefined,
	...extra: ReadonlyArray<never>
): Contract<Name, B, Proved> => {
	const parts = contractParts(name, base, [predicate, declared, ...extra])
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
export const span: SpanConstructor = <E extends IntegerLike>(
	endpoint: E & Columned<Infer<E>>,
	width: BaseOf<Infer<E>> | undefined,
	...extra: ReadonlyArray<never>
): SpanField<Infer<E>> => {
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

/** A reference to the roster the admission core admitted, its column the roster's codes read as its literal handles. */
export const closedId: ClosedIdConstructor = <C extends AnyRoster>(
	roster: C & { readonly handles: NonEmptyReadonlyArray<HandleOf<C>> }
): ClosedIdField<C> => {
	const parts = closedIdParts(roster)
	return defineField(
		{},
		carrierSql.code,
		parts.desc,
		{ roster, column: codeColumn<HandleOf<C>>(parts.roster.closed, roster.handles) },
		parts.loc,
		parts.env
	)
}

/** A set over the roster the admission core admitted, its column a bit string read as the set of its codes' handles. */
export const bits: BitsConstructor = <C extends AnyRoster>(
	roster: C & { readonly handles: NonEmptyReadonlyArray<HandleOf<C>> }
): BitsField<C> => {
	const parts = closedIdParts(roster)
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
 * Bits.of(roster, handles): the set of `handles`, each a handle of `roster`, each once; a fresh frozen Set, branded by
 * the roster. A JavaScript caller's handle outside the roster, or a repeat, is MalformedDescription.
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
	type: F & NotSerial,
	term: GeneratedTermOf<F>,
	...extra: ReadonlyArray<never>
): GeneratedField<F> => generatedField<F>(type, term, extra)

/** drawn(natural): a natural grizzle draws from the nested arrays its caller writes (schema/relation.ts drawnField). */
export const drawn: DrawnConstructor = (
	type: NaturalField,
	...extra: ReadonlyArray<never>
): DrawnField => drawnField(type, extra)

/**
 * accumulated(type, start): a field grizzle fills on the host, `start` at its axis's base (schema/relation.ts
 * accumulatedField).
 */
export const accumulated: AccumulatedConstructor = <const F extends FieldBase>(
	type: F,
	start: Infer<F>,
	...extra: ReadonlyArray<never>
): AccumulatedField<F> => accumulatedField<F>(type, start, extra)
