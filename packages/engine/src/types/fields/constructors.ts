import type { HostKeysOf, HostMint } from "#compiler/core/brand.ts"
import type { Columned } from "#compiler/core/decoder.ts"
import type { Scalar } from "#compiler/types/compute/scalar.ts"
import type {
	DomainOf,
	Facts,
	InputTerm,
	IsOneLiteral,
	DomainValueOrigin,
	Hosted,
	OriginOfTerm,
	Parameterless,
	Predicate,
	Refusal,
	Repeats
} from "#compiler/types/core/phantom.ts"

import type {
	AccumulatedField,
	BitField,
	ClosedIdField,
	ClosedSubset,
	Domain,
	DrawnField,
	DrawnType,
	FieldBase,
	GeneratedField,
	Infer,
	MintKey,
	NamedId,
	NoWriting,
	NotDigest,
	NotInstant,
	NotSearchDocument,
	NotStoredOnly,
	RangeEndpointLike,
	RangeField,
	RangeWidthOf,
	StoredOnlySql,
	SubsetHandles,
	ArmChecks,
	VariantArms,
	VariantField,
	WritingTag
} from "#compiler/types/fields/field.ts"
import type { AnyRoster, HandleOf } from "#compiler/types/schema/relation.ts"
import type { VectorField } from "#compiler/types/vector/vector.ts"

/**
 * The signatures of the field descriptor constructors: contract, span and closedId, the runtime values of
 * packages/engine/src/scalar, which the public barrel public/fields.ts binds to them. str.regex is packages/engine/src/text's, with
 * its own signature (text/field.ts Str).
 *
 * A descriptor's host type is the type of its column, the conversion its builder made, and the runtime descriptors
 * carry their literal SQL names and members (scalar/registry.ts defineField), so every binding has its public type by
 * construction. Typmod arguments are runtime values: numeric precision and scale, vector dimensions and span widths
 * are checked by the runtime builders, which throw CompileError MalformedDescription on a malformed one. A vector's
 * dimension count is the one literal the type keeps, an equality-only tag.
 * A contract is its brand's minting function, the call of Effect's brand constructor: it brands without checking, and
 * the database validates on write. test/unit/scalar pins the runtime behavior, and test/types/fields the signatures.
 */

/**
 * A nominal contract over a base descriptor, with an optional total predicate over one value, whose values its consumer
 * makes: its host type is the base's host type under the consumer's key K, `Marked<host type, K>` (core/brand.ts),
 * `contract<GradedKey>()("Graded", numeric(9, 4), (v) => Logic.between(v, 0n, 1n))` beside `const graded =
 * Symbol("Graded")` and `type GradedKey = typeof graded` in the module that grades. So a write of the contract takes
 * only a value the key's mint made (mintOf), a read delivers one, and the contract itself makes none. K is a unique
 * symbol (UniqueKey); a key of its own per contract keeps two contracts over one base apart on the host.
 *
 * The predicate receives the base's scalar, of the base's domain and SQL type, whose language is the base's host type,
 * which the scalar catalogue's comparisons read. A contract is a value domain and lowers to a PostgreSQL domain, so its
 * base is a value type: never a field of a writing of its own (NoWriting), which grizzle or PostgreSQL writes. The name
 * is one literal, the contract's identity.
 *
 * After the predicate, `{ proves: ["nonzero"] }` declares the facts it proves, which the contract's type then states
 * of its values, so a divisor of the contract needs no guard; compilation proves each from the predicate, else refuses
 * the declaration: `contract<typeof divisorKey>()("Divisor", int8, (v) => Logic.ne(v, 0n), { proves: ["nonzero"] })`.
 */
export type DomainConstructor = <K extends symbol>() => <
	const Name extends string,
	B extends FieldBase,
	Pr extends Predicate<never> = Predicate,
	const Proved extends ReadonlyArray<keyof Facts> = readonly []
>(
	name: Name,
	base: B &
		NoWriting &
		NotStoredOnly<B["sql"]> &
		NotExactBase<B["sql"]> &
		NotDigest<B["sql"]> &
		NotSearchDocument<B["sql"]> &
		NotInstantBase<B> &
		UniqueKey<K> &
		KeyApart<K, B> &
		OneDomainName<NoInfer<Name>>,
	predicate?: (
		v: Scalar<DomainOf<B>, unknown, DomainValueOrigin, B["sql"], Infer<B>>
	) => Pr & Parameterless<Pr> & Hosted<Pr>,
	declared?: { readonly proves: Proved }
) => Domain<Name, B, K, Proved>

/**
 * A contract's name is one literal: a union of names would give its values every one of them as their identity, and a
 * wider string would make every contract over a base with such a name one type. It is apart from natural and instant,
 * grizzle's own, so every contract of another name is its consumer's (scalar/contract.ts isOwnedName).
 */
export type OneDomainName<Name extends string> =
	IsOneLiteral<Name> extends true
		? [Name] extends ["natural"] | ["instant"]
			? Refusal<"a domain's name is apart from natural and instant, grizzle's own types">
			: unknown
		: Refusal<"a domain's name is one literal, the brand of its values">

/**
 * mintOf(key): the mint of the host types under `key`, a unique symbol of its module's own, `const graded =
 * Symbol("Graded")`, the one unchecked conversion its consumer makes: `const toGraded = mintOf(graded)`, then
 * `toGraded(score)` is a `Marked<Numeric, typeof graded>`. The key is the capability: a module that does not hold it
 * cannot mint under it, so where the key lives, and whether it is exported, decides who mints. A key of type `symbol`,
 * a registered one's from Symbol.for, which any module reads, is refused.
 */
export type MintOfConstructor = <const K extends symbol>(key: K & UniqueKey<K>) => HostMint<K>

/**
 * A contract over another is under a key of its own, apart from its base's: under its base's key its values would be
 * its base's on the host, and a mint into it would take one key for two contracts (MintKeys).
 */
export type KeyApart<K extends symbol, B> = [K] extends [HostKeysOf<Infer<B>>]
	? Refusal<"a domain over another is under a key of its own, apart from its base's">
	: unknown

/** The refusal of a key K that is no unique symbol: `symbol`, which any symbol is, a registered one's among them. */
export type UniqueKey<K extends symbol> = symbol extends K
	? Refusal<"a host's key is a unique symbol: its module's own Symbol(name), never a registered one, which any module reads">
	: unknown

/**
 * A contract's base that is no exact value, arithmetic's own type of any size (exactInteger, exactMoney), which no
 * contract is over: a contract bounds an integer or an amount over int8, numeric(p, s) or money.
 */
export type NotExactBase<Sql> = [Sql] extends ["exact integer" | "exact money"]
	? Refusal<"no domain is over an exact value of any size: declare it over int8, numeric(p, s) or money">
	: unknown

/** A contract's base or a span's endpoint that is no instant, which no caller brands (NotInstant). */
export type NotInstantBase<B> = NotInstant<DomainOf<B>>

/**
 * A bounded half-open span over an integer or a date endpoint. The width is upper - lower, a
 * positive value of the endpoint's base type, or a count of days over a date, checked at runtime. The span's column
 * converts each endpoint with the endpoint's own column, so span(Cents) delivers Span<Cents> and span(date)
 * Span<CalendarDate>.
 */
export type RangeConstructor = <E extends RangeEndpointLike>(
	endpoint: E & Columned<Infer<E>> & NoWriting & NotInstantBase<E>,
	width?: RangeWidthOf<Infer<E>>
) => RangeField<Infer<E>, DomainOf<E>>

/**
 * A closed reference: its column is the roster's handles, the roster's tuple of literals, or the subset `subset` states
 * of them (SubsetHandles), its host type and language that subset's handles, none over an empty roster, whose closed id
 * is the empty type. A subset lists each handle once, and `except` leaves at least one.
 */
export type ClosedIdConstructor = <
	C extends AnyRoster,
	const Subset extends ClosedSubset<C> | undefined = undefined
>(
	roster: C & { readonly handles: ReadonlyArray<HandleOf<C>> },
	subset?: Subset & SubsetStated<C, Subset>
) => ClosedIdField<C, SubsetHandles<C, Subset>>

/** The SQL types no arm's field is of (scalar/registry.ts isArmFieldType). */
type UnarmedSql = "bytea" | "tsvector" | "vector" | "money" | "exact money" | "variant"

/**
 * variant(name, roster, arms, checks?): a typed sum, one arm per handle of the subset of `roster`'s handles its arms
 * name, every handle or some, each a record of typed fields; a field of it holds one arm's handle under `tag` and that
 * arm's fields (schema/variant.ts), and a handle no arm names is no value of it. `checks` states at most one predicate
 * per arm with a field, over that arm's fields alone, part of the variant's own type (public/fields.ts variant).
 */
export type VariantConstructor = <
	const Name extends string,
	C extends AnyRoster,
	const Arms extends VariantArms<C>
>(
	name: Name,
	roster: C & { readonly handles: ReadonlyArray<HandleOf<C>> },
	arms: Arms & ArmsAdmitted<C, Arms>,
	checks?: ArmChecks<Name, Arms>
) => VariantField<Name, C, Arms>

/**
 * A variant's arms as its constructor admits them (public/fields.ts variant): at least one, each named by a handle of
 * the roster, the subset of its handles the variant holds; each field named apart from `tag`, which names the arm in a
 * value, and of a type an arm holds (scalar/registry.ts isArmFieldType).
 */
export type ArmsAdmitted<C, Arms> = [keyof Arms] extends [never]
	? Refusal<"a variant holds at least one arm, each named by a handle of its roster">
	: [Exclude<keyof Arms, HandleOf<C>>] extends [never]
		? {
				readonly [H in keyof Arms]: {
					readonly [F in keyof Arms[H]]: F extends "tag"
						? Refusal<"a variant arm's field is named apart from tag, which names its arm">
						: Arms[H][F] extends { readonly sql: UnarmedSql }
							? Refusal<"a variant arm's field is a value of a type that is no variant, bytea, search document, vector or money">
							: unknown
				}
			}
		: Refusal<"a variant holds at least one arm, each named by a handle of its roster">

/**
 * A subset stated as a closed id takes it/**
 * A subset stated as a closed id takes it: each handle its list names once, and some handle left, which `except` of
 * every handle leaves none of.
 */
type SubsetStated<C, Subset> = Subset extends { readonly only: infer H }
	? Repeats<H> extends true
		? Refusal<"a closed id's subset lists each handle once">
		: unknown
	: Subset extends { readonly except: infer H }
		? Repeats<H> extends true
			? Refusal<"a closed id's subset lists each handle once">
			: [SubsetHandles<C, Subset>] extends [never]
				? Refusal<"a closed id's subset holds some handle: except leaves none">
				: unknown
		: unknown

/** A set over a roster: its column reads a bit string into the set of handles its 1 bits' codes name. */
export type BitConstructor = <C extends AnyRoster>(
	roster: C & { readonly handles: ReadonlyArray<HandleOf<C>> }
) => BitField<C>

/**
 * drawn(type): a value grizzle draws, a family's index or count or a tree's start or end, of `type`, natural or a
 * contract over an integer (DrawnType). A contract of a consumer's is drawn under its key, `drawn(TestNumber,
 * testNumberKey)`, since grizzle makes its values from counting (MintKey).
 */
export type DrawnConstructor = <const F extends FieldBase>(
	type: F & DrawnType<F>,
	...key: MintKey<F>
) => DrawnField<F>

/**
 * An accumulated field is of a value type: no span, no vector, and no field of a writing of its own; and no bytes, which
 * grizzle never fills (NotStoredOnly).
 */
export type Accumulable<F> = F extends
	| RangeField<unknown, unknown>
	| VectorField<number>
	| { readonly writing: WritingTag }
	? Refusal<"an accumulated field is of a value type: no range, vector or field of a writing of its own">
	: F extends { readonly sql: StoredOnlySql }
		? NotStoredOnly<StoredOnlySql>
		: unknown

/**
 * accumulated(type, start): a field of `type` grizzle fills on the host and PostgreSQL proves, a fold's accumulator or
 * a copy along a family axis, holding `start`, a value of `type`, at its axis's base. A contract of a consumer's
 * accumulates under its key, `accumulated(Micros, toMicros(0n), microsKey)`, since a fold makes its values from its
 * members' (MintKey).
 */
export type AccumulatedConstructor = <const F extends FieldBase>(
	type: F & Accumulable<F>,
	start: Infer<F>,
	...key: MintKey<F>
) => AccumulatedField<F>

/**
 * A term of the declared type F exactly: its identity and SQL type are F's, as PostgreSQL types a generation expression
 * by its column's type, with no implicit cast.
 */
export type GeneratedTermOf<F extends FieldBase> = InputTerm<DomainOf<F>, never, unknown, F["sql"]>

/**
 * generated(type, term): a field PostgreSQL writes, a STORED generated column of `type` whose value is `term`, read off
 * the row relation.generated hands its callback. The term is of `type` exactly and reads no parameter: its row's
 * written fields and closed reads are all a generation expression may read. The field carries the term's origin, the
 * fields it reads (GeneratedField O), which determine it wherever the relation is matched.
 */
export type GeneratedConstructor = <F extends FieldBase, T extends GeneratedTermOf<F>>(
	type: F & NoWriting & NotStoredOnly<F["sql"]> & NamedId<F>,
	term: T & Parameterless<T> & Hosted<T>
) => GeneratedField<F, OriginOfTerm<T>>
