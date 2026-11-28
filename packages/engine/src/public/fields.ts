import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { hostMintOf, type Marked } from "#compiler/core/brand.ts"
import {
	bitsColumn,
	type Column,
	type Columned,
	codeColumn,
	hostColumn
} from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { armRows } from "#compiler/query/build/call.ts"
import { bytesDescriptor } from "#compiler/scalar/bytes.ts"
import {
	compute,
	searchDocumentTerm,
	variantMake,
	variantDigest,
	variantTag
} from "#compiler/scalar/compute/builders.ts"
import { admitContractCall, callerContractParts } from "#compiler/scalar/contract.ts"
import { dateDescriptor } from "#compiler/scalar/date.ts"
import { exactIntegerDescriptor, exactMoneyDescriptor } from "#compiler/scalar/exact.ts"
import { instantDescriptor } from "#compiler/scalar/instant.ts"
import { minted, type mintedRefusal } from "#compiler/scalar/minted.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import {
	bool as boolDescriptor,
	cidr as cidrDescriptor,
	float4 as float4Descriptor,
	float8 as float8Descriptor,
	inet as inetDescriptor,
	int2 as int2Descriptor,
	int4 as int4Descriptor,
	int8 as int8Descriptor,
	money as moneyDescriptor,
	numeric as numericDescriptor
} from "#compiler/scalar/pg.ts"
import { bareEnv, carrierSql, defineField } from "#compiler/scalar/registry.ts"
import type { Described } from "#compiler/scalar/registry.ts"
import { searchDescriptor, storedSearchDescriptor } from "#compiler/scalar/search.ts"
import { sha256Descriptor } from "#compiler/scalar/sha256.ts"
import { spanColumn, spanParts } from "#compiler/scalar/span.ts"
import { uuidDescriptor } from "#compiler/scalar/uuid.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Cidr, Inet } from "#compiler/scalar/values/net.ts"
import type { Sha256 } from "#compiler/scalar/values/sha256.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"
import { vector as vectorDescriptor } from "#compiler/scalar/vector.ts"
import { variantSpellings } from "#compiler/schema/function.ts"
import { armSource, casesTerm } from "#compiler/schema/record.ts"
import {
	accumulatedField,
	bitsOf,
	clockInstant,
	closedIdOf,
	drawnField,
	generatedField,
	placeDescriptor,
	slotField
} from "#compiler/schema/relation.ts"
import {
	armChecks,
	readArms,
	variantCases,
	variantDesc,
	variantField,
	variantLoc
} from "#compiler/schema/variant.ts"
import type { BitApi } from "#compiler/types/compute/compute.ts"
import type { Scalar } from "#compiler/types/compute/scalar.ts"
import type {
	DomainValueOrigin,
	DomainOf,
	Facts,
	OriginOfTerm,
	Parameterless,
	Predicate,
	Refusal
} from "#compiler/types/core/phantom.ts"
import type {
	AccumulatedConstructor,
	ArmsAdmitted,
	BitConstructor,
	ClosedIdConstructor,
	DomainConstructor,
	VariantConstructor,
	DrawnConstructor,
	GeneratedConstructor,
	MintOfConstructor,
	NotInstantBase,
	KeyApart,
	OneDomainName,
	UniqueKey,
	RangeConstructor
} from "#compiler/types/fields/constructors.ts"

import type { TextSearchConfiguration } from "#compiler/ir/search.ts"
import type {
	AccumulatedField,
	Bits as BitsValue,
	BitField,
	ByteaField,
	ClosedIdField,
	ClosedSubset,
	Domain,
	DateField,
	DrawnField,
	DrawnType,
	ExactIntegerField,
	ExactMoneyField,
	Field,
	FieldBase,
	GeneratedField,
	HandleOf,
	Infer,
	InstantField,
	MintKey,
	RangeEndpointLike,
	NaturalField,
	NoWriting,
	NumericField,
	PlaceDescriptor,
	RangeField,
	RangeWidthOf,
	SubsetHandles,
	ArmChecks,
	ArmHandles,
	VariantArms,
	VariantField,
	VariantValueOf
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
import type { VectorField } from "#compiler/types/vector/vector.ts"

export { Numeric } from "#compiler/scalar/values/decimal.ts"
export { Money } from "#compiler/scalar/values/money.ts"
/** The uuid host value, uuid_out's spelling as ArkRegex infers it, and its parse from a plain string. */
export { Uuid } from "#compiler/scalar/values/uuid.ts"
/**
 * The inet and cidr host values, the one text inet_out and cidr_out print of a value, and their parses from any text
 * PostgreSQL's inet_in and cidr_in read (scalar/values/net.ts).
 */
export { Cidr, Inet } from "#compiler/scalar/values/net.ts"
/** pgvector's carrier, a branded Float32Array. */
export { Vector } from "#compiler/scalar/values/vector.ts"
/** A contract's host type, its base's host type under its consumer's key, which only mintOf(key) makes. */
export type { HostMint, Marked } from "#compiler/core/brand.ts"
/**
 * The identity a term of a descriptor's type meets, its domain: a contract's, its base's under its name, apart from its
 * host type, so a function over a contract's term types it `Term<DomainOf<typeof Cents>, unknown, InputOrigin, "bigint">`.
 */
export type { DomainOf } from "#compiler/types/core/phantom.ts"

/** A SHA-256 digest, its 32 bytes, and its digests of bytes and of a text (Sha256.ofBytes, Sha256.ofText). */
export { Sha256 } from "#compiler/scalar/values/sha256.ts"
export type {
	AccumulatedField,
	AnyDomain,
	BitField,
	ByteaField,
	CalendarDate,
	ClosedIdField,
	ClosedSubset,
	Domain,
	DateField,
	DrawnField,
	DrawnType,
	ExactIntegerField,
	ExactMoneyField,
	Field,
	FieldBase,
	GeneratedField,
	HandleOf,
	Infer,
	Instant,
	InstantDomain,
	InstantField,
	IntegerLike,
	RangeEndpointLike,
	LiteralOf,
	MintKey,
	OwnKeyOf,
	MintKeys,
	NaturalDomain,
	NaturalField,
	NumericBoundField,
	NumericField,
	NumericHostOf,
	NumericTypmodField,
	PatternField,
	PlaceDescriptor,
	PlaceField,
	RangeField,
	RangeWidthOf,
	SqlOf,
	StoredInstantField,
	SubsetHandles,
	TextField,
	VariantArms,
	VariantField,
	VariantValueOf,
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
 * Public barrel: Scalar field descriptors: uuid, sha256, natural, date, bytea, exactInteger, exactMoney, PostgreSQL's
 * plain types under their pg_type names (int2, int4, int8, numeric, float4, float8, money, bool, inet, cidr, vector,
 * tsvector), contract, range and closedId, the runtime values of
 * packages/engine/src/scalar bound to their public signatures (types/fields), with the exact carriers Numeric and Money,
 * the uuid host value Uuid, the digest Sha256 and pgvector's carrier Vector. str.regex is the text barrel's.
 *
 * The runtime descriptors carry their literal SQL names, their members and their columns (scalar/registry.ts
 * defineField), so each binding has its public type by construction: a descriptor's host type is its column's. A
 * contract is a descriptor with the contract's members and Description, whose host type its consumer declares, its
 * base's host type under the consumer's key (core/brand.ts Marked): it makes no value, its consumer's mint does
 * (mintOf), the database validates every write, and its column is its base's, read as the host type (core/decoder.ts
 * hostColumn). A JavaScript caller can pass anything, an empty name, a value to the first call or a fourth argument
 * included, which the admission cores refuse.
 */
export const uuid: Field<Uuid, "uuid"> = uuidDescriptor

/**
 * sha256: a SHA-256 digest, exactly 32 bytes, its host value a Sha256 (scalar/sha256.ts): what Crypto.sha256 yields, so
 * `generated(sha256, Crypto.sha256(row.text))` is a digest field, and a key, a unique, a family axis or a reference may
 * hold one, where the text itself may be too long for any index entry.
 */
export const sha256: Field<Sha256, "sha256"> = sha256Descriptor

/** natural: a bigint never below zero, the builtin contract over int8 that pred reads (scalar/natural.ts). */
export const natural: NaturalField = naturalDescriptor

/** date: a calendar day, 0001-01-01 to 9999-12-31, its host value its ISO 8601 text (scalar/date.ts). */
export const date: DateField = dateDescriptor

/**
 * bytea: PostgreSQL's bytea, its host value a Uint8Array over its own ArrayBuffer, written and read back whole and
 * nothing else (scalar/bytes.ts).
 */
export const bytea: ByteaField = bytesDescriptor

/**
 * exactInteger: an integer of any size, a bigint, the type integer arithmetic delivers, stored as numeric under the
 * CHECK of the integers (scalar/exact.ts).
 */
export const exactInteger: ExactIntegerField = exactIntegerDescriptor

/**
 * exactMoney: an amount of money of any size, a Money, the type money arithmetic and a money sum deliver, stored as
 * numeric under the CHECK of money's scale (scalar/exact.ts).
 */
export const exactMoney: ExactMoneyField = exactMoneyDescriptor

/** int2: PostgreSQL's two-byte integer, its host value a number. */
export const int2: Field<number, "int2"> = int2Descriptor

/** int4: PostgreSQL's four-byte integer, its host value a number. */
export const int4: Field<number, "int4"> = int4Descriptor

/** int8: PostgreSQL's eight-byte integer, its host value a bigint. */
export const int8: Field<bigint, "int8"> = int8Descriptor

/**
 * numeric: PostgreSQL's numeric of no typmod, every value numeric holds, NaN and the infinities among them, its host
 * value a Numeric: a field, a parameter, a declared function's argument or result or a domain's base of it passes each
 * value as it is (scalar/pg.ts).
 *
 * - `numeric(p, s)` is numeric with its typmod, precision and scale both declared, so every value a field of it holds
 *   has the digits its typmod states, under PostgreSQL's numerictypmodin rule: precision 1-numericMaxPrecision and scale
 *   numericMinScale-numericMaxScale (ir/carriers.ts), both integers, a scale larger than the precision permitted. Its
 *   host value follows its values: a bigint at scale 0, whose values are integers and never NaN, and a Numeric at any
 *   other scale.
 * - `numeric.within(digits, scale)` is numeric of no typmod within a computed numeric's bound, the type a stored field of
 *   a sum's or a mean's value is of, exactly.
 *
 * A malformed typmod from a JavaScript caller is CompileError MalformedDescription, thrown synchronously, the builders'
 * convention.
 */
export const numeric: NumericField = numericDescriptor

/** float4: PostgreSQL's single-precision float, its host value a number. */
export const float4: Field<number, "float4"> = float4Descriptor

/** float8: PostgreSQL's double-precision float, its host value a number. */
export const float8: Field<number, "float8"> = float8Descriptor

/** money: PostgreSQL's money, its host value a Money. */
export const money: Field<Money, "money"> = moneyDescriptor

/** bool: PostgreSQL's boolean, its host value a boolean. */
export const bool: Field<boolean, "bool"> = boolDescriptor

/**
 * inet and cidr: PostgreSQL's network address types, an address with its network's mask and a network, each host value
 * the one text inet_out or cidr_out prints of it (scalar/values/net.ts Inet, Cidr), so '1.2.3.4/32' is the inet
 * '1.2.3.4'.
 */
export const inet: Field<Inet, "inet"> = inetDescriptor

/** cidr: a network, whose address has no bit set right of its mask (inet). */
export const cidr: Field<Cidr, "cidr"> = cidrDescriptor

/**
 * smallserial, serial, bigserial and uuidv7 are no fields but the refusal of one (scalar/minted.ts): grizzle mints no
 * ids, so a declaration that names one is a type error that names the model.
 */
export const smallserial: Refusal<typeof mintedRefusal> = minted
export const serial: Refusal<typeof mintedRefusal> = minted
export const bigserial: Refusal<typeof mintedRefusal> = minted
export const uuidv7: Refusal<typeof mintedRefusal> = minted

/** vector(1536): a model-agnostic pgvector field; the dimension count is an equality-only tag (scalar/vector.ts). */
export const vector: <const N extends number>(dimensions: N) => VectorField<N> = vectorDescriptor

/**
 * tsvector("english"): a search document of the configuration, a field its caller writes, each value a document a read
 * delivered (SearchDocument), written back as it is (scalar/search.ts storedSearchDescriptor); the configuration is an
 * equality-only tag. The generated field PostgreSQL parses from its row's texts is searchDocument's.
 */
export const tsvector: <const C extends TextSearchConfiguration>(
	configuration: C
) => SearchDocumentField<C> = storedSearchDescriptor

export const domain: DomainConstructor = <K extends symbol>(...first: ReadonlyArray<never>) => {
	admitContractCall(first)
	return <
		const Name extends string,
		B extends FieldBase,
		Pr extends Predicate<never> = Predicate,
		const Proved extends ReadonlyArray<keyof Facts> = readonly []
	>(
		name: Name,
		base: B &
			NoWriting &
			NotInstantBase<B> &
			UniqueKey<K> &
			KeyApart<K, B> &
			OneDomainName<NoInfer<Name>>,
		predicate:
			| ((
					v: Scalar<DomainOf<B>, unknown, DomainValueOrigin, B["sql"], Infer<B>>
			  ) => Pr & Parameterless<Pr>)
			| undefined,
		declared: { readonly proves: Proved } | undefined,
		...extra: ReadonlyArray<never>
	): Domain<Name, B, K, Proved> => {
		const parts = callerContractParts(name, base, [predicate, declared, ...extra])
		const column: Column<Marked<Infer<B>, K>> = hostColumn(base.column)
		const members =
			parts.predicate === undefined
				? { name, base, column }
				: { name, base, predicate: parts.predicate, column }
		return defineField({}, base.sql, parts.desc, members, parts.loc, parts.env)
	}
}

/**
 * mintOf(key): the mint of the host types under a key of its caller's module (core/brand.ts hostMintOf), the one
 * unchecked conversion a consumer makes into a contract's host type.
 */
export const mintOf: MintOfConstructor = hostMintOf

/**
 * range(endpoint, width?): PostgreSQL's range over the endpoint the admission core admitted, int4range, int8range or
 * daterange, its column converting endpoints with the endpoint's own.
 */
export const range: RangeConstructor = <E extends RangeEndpointLike>(
	endpoint: E & Columned<Infer<E>> & NoWriting,
	width: RangeWidthOf<Infer<E>> | undefined,
	...extra: ReadonlyArray<never>
): RangeField<Infer<E>, DomainOf<E>> => {
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
 * one, its column the roster's codes read as those literal handles: an unrestricted closed id's the roster's own
 * handles, shared, a restricted one's its subset's, so a field over a roster costs nothing per handle unless it
 * restricts it.
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
	/** Whether the closed id holds every handle of `handles`, its roster's: at once where it holds no subset (readSubset),
	 * and never where it holds one, which leaves some handle out. */
	const holdsEvery = (
		handles: ReadonlyArray<HandleOf<C>>
	): handles is ReadonlyArray<SubsetHandles<C, Subset>> =>
		only === undefined || handles.every(holds)
	return defineField(
		{},
		carrierSql.code,
		parts.desc,
		{
			roster,
			column: codeColumn<SubsetHandles<C, Subset>>(
				parts.roster.closed,
				holdsEvery(roster.handles) ? roster.handles : roster.handles.filter(holds)
			)
		},
		parts.loc,
		parts.env
	)
}

/**
 * variant(name, roster, arms, checks?): a typed sum, one arm per handle of the subset of `roster`'s handles its arms
 * name, every handle or some, each a record of typed fields; a field of it holds one arm's handle under `tag` and that
 * arm's fields (schema/variant.ts). The roster is a closed relation's, read as closedId reads one, so its codes, which
 * are history, tag the arms, and its tag is a closed id of the arms' handles, as closedId(roster, { only }) is of its
 * subset's: its column delivers those, and the variant's domain's CHECK refuses the code of any other handle. `checks`
 * states at most one predicate per arm with a field, over that arm's fields alone, part of the variant's own type: the
 * variant's domain's CHECK holds it under the arm's code, so every relation holding the variant holds it
 * (schema/variant.ts armChecks).
 */
export const variant: VariantConstructor = <
	const Name extends string,
	C extends AnyRoster,
	const Arms extends VariantArms<C>
>(
	name: Name,
	roster: C & { readonly handles: ReadonlyArray<HandleOf<C>> },
	arms: Arms & ArmsAdmitted<C, Arms>,
	checks: ArmChecks<Name, Arms> | undefined
): VariantField<Name, C, Arms> => {
	const loc = variantLoc(name)
	const closedParts = closedIdOf(roster, [])
	const stated: Arms = arms
	const unchecked = { name, roster: closedParts, arms: readArms(arms, closedParts, loc), loc }
	const parts = { ...unchecked, arms: armChecks(unchecked, arms, checks) }
	const named = new Set<string>(parts.arms.map((arm) => arm.handle))
	/** Whether the variant holds `handle`: an arm names it (schema/variant.ts readArms). */
	const holds = (handle: HandleOf<C>): handle is ArmHandles<C, Arms> => named.has(handle)
	const tagColumn = codeColumn<ArmHandles<C, Arms>>(
		closedParts.roster.closed,
		roster.handles.filter(holds)
	)
	const cases = variantCases(parts, arms, tagColumn)
	const spellings = variantSpellings(parts)
	/** The descriptor make names as its type, made below: a make runs only once the descriptor is made. */
	const self: { descriptor: VariantField<Name, C, Arms> | undefined } = { descriptor: undefined }
	const terms: Pick<
		VariantField<Name, C, Arms>,
		"tag" | "digest" | "make" | "cases" | "code" | "attribute" | "of" | "arm"
	> = {
		arm: (value, handle) => {
			const arm = defined(
				parts.arms.find((a) => a.handle === handle),
				`an arm ${handle} of variant ${name}`
			)
			const carriers: { readonly [field: string]: Described } = Object.freeze(
				Object.fromEntries(arm.fields)
			)
			return armSource(
				armRows(variantDesc(parts), arm.handle, arm.fields, carriers, value, `variant ${name}.arm`)
			)
		},
		code: (handle) => spellings.code(handle),
		attribute: (handle, field) => spellings.attribute(handle, field),
		of: (handle, fields) => spellings.of(handle, fields),
		tag: (value) => variantTag(value, tagColumn),
		digest: (value) => variantDigest(value),
		make: (handle, fields) =>
			variantMake(defined(self.descriptor, "a variant's descriptor, made"), handle, fields),
		cases: (value, handlers) => casesTerm(cases(value, handlers))
	}
	const descriptor = variantField<
		VariantValueOf<Arms>,
		{ name: Name; roster: C; arms: Arms } & Pick<
			VariantField<Name, C, Arms>,
			"tag" | "digest" | "make" | "cases" | "code" | "attribute" | "of" | "arm"
		>
	>(parts, { name, roster, arms: stated, ...terms })
	self.descriptor = descriptor
	return descriptor
}

/**
 * bit(roster): a set over the roster the admission core admitted, its column PostgreSQL's bit(n), one bit per code the
 * roster has minted, read as the set of its codes' handles.
 */
export const bit: BitConstructor = <C extends AnyRoster>(
	roster: C & { readonly handles: ReadonlyArray<HandleOf<C>> }
): BitField<C> => {
	const parts = closedIdOf(roster, [])
	return defineField(
		{},
		carrierSql.bits,
		{ kind: "bits", roster: parts.roster.closed },
		{ roster, column: bitsColumn<BitsValue<C>>(parts.roster.closed) },
		SourceLoc(`bit(${parts.roster.closed})`, []),
		parts.env
	)
}

/** The Bit namespace: Bit.of, a set value, and the set algebra over set terms (BitApi). */
type BitNamespace = BitApi & {
	readonly of: <C extends AnyRoster, const H extends ReadonlyArray<HandleOf<C>>>(
		roster: C,
		handles: H & DistinctMembers<H>
	) => BitsValue<C>
}

/**
 * Bit.of(roster, handles): the set of `handles`, each a handle of `roster`, each once; a fresh Set, branded by the
 * roster, which every boundary that admits it copies. A JavaScript caller's handle outside the roster, or a repeat, is MalformedDescription.
 * Beside it, the set algebra over set terms of one roster (types/compute/compute.ts BitApi), the scalar catalogue's
 * members over the bit type.
 */
export const Bit: BitNamespace = Object.freeze<BitNamespace>({
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
export const generated: GeneratedConstructor = <F extends FieldBase, T>(
	type: F & NoWriting,
	term: T,
	...extra: ReadonlyArray<never>
): GeneratedField<F, OriginOfTerm<T>> => generatedField<F, OriginOfTerm<T>>(type, term, extra)

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
	const descriptor = searchDescriptor(configuration, "searchDocument")
	return generatedField<SearchDocumentField<C>>(
		descriptor,
		searchDocumentTerm(descriptor, parts),
		[]
	)
}

/**
 * instant: microseconds since the Unix epoch on the database's clock, written only by the database: an insert stamps
 * its relation's clock from its scope's head, its unit's or its child's, and a reference holds a stored instant a
 * containment carries it to
 * (scalar/instant.ts, analysis/theory/instants.ts). Installed as natural's domain. A read delivers its values as
 * Instant, which `instant.stored`, a field of its type its caller writes, stores as it is, the database drawing
 * nothing (schema/relation.ts clockInstant).
 */
export const instant: InstantField = clockInstant(instantDescriptor)

/**
 * drawn(type): a value of `type`, natural or a contract over an integer, grizzle draws from the nested arrays its caller
 * writes (schema/relation.ts drawnField); a consumer's contract under its key, drawn(C, key).
 */
export const drawn: DrawnConstructor = <const F extends FieldBase>(
	type: F & DrawnType<F>,
	...key: MintKey<F>
): DrawnField<F> => drawnField<F>(type, key)

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
 * accumulatedField); a consumer's contract under its key, accumulated(C, start, key).
 */
export const accumulated: AccumulatedConstructor = <const F extends FieldBase>(
	type: F,
	start: Infer<F>,
	...key: MintKey<F>
): AccumulatedField<F> => accumulatedField<F>(type, start, key)
