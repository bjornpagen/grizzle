import type { Stream } from "effect"
import type { RowDecoder } from "#compiler/core/decoder.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Built, Phantom } from "#compiler/core/phantom.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { Vector } from "#compiler/scalar/values/vector.ts"
import type {
	Carriers,
	DomainOf,
	Headed,
	InputTerm,
	Invariant,
	IsRetyped,
	ParamArg,
	Refusal,
	Simplify,
	SqlOfCarrier,
	Source
} from "#compiler/types/core/phantom.ts"
import type {
	ContextsOf,
	Decoders,
	OneName,
	OrderedAt,
	ParamsOf,
	QueryAt
} from "#compiler/types/query/query.ts"
import type { AnyRelation, Fact, NameOf, SerialFieldsOf } from "#compiler/types/schema/relation.ts"
import type {
	AnySchema,
	IsLevelOf,
	IsRelationOf,
	LevelsOf,
	RelationOf
} from "#compiler/types/schema/schema.ts"
import type { AnyWorld, WorldSerialFields, WriteListOf } from "#compiler/types/schema/world.ts"

/**
 * A member is an array of facts, a Stream of facts, or a query whose head is the relation's heading, or for an insert
 * the heading minus its serial fields. An array or a Stream is the query over a relation parameter the input binds.
 * Query is invariant in its head, so a query member is admitted at any head and MemberCheck compares the head by
 * assignability: a head literal such as `kind: "Manual"` is a value of its field, and a head that
 * supplies every serial field is an addition like an array that does. M is a const type
 * parameter: an array literal whose facts carry a literal-typed field (a closed relation's handle) would otherwise widen
 * that field, miss the constraint, and infer M as the constraint itself, whose query arm types the parameters `any`.
 */
export type Member<S, F> = ReadonlyArray<F> | Stream.Stream<F> | QueryAt<LevelsOf<S>>

/**
 * Each arm of a member's facts must be one arm of F exactly: assignable to it and with no field beyond it, so an
 * insert's facts either omit every serial field or supply them all, and no fact carries a field its
 * relation lacks. An array or Stream member is an inferred type argument, so TypeScript runs no excess-property check
 * on its elements; the check is this one, as for a query member's head. A query member's head also writes each field
 * of R at the field's own type (MistypedFields), as the checker requires (check/member.ts checkMemberHeading): an exact
 * integer or exact money binds at a plain integer or money column (Meets), but is stored into one only through
 * Compute.cast. This is the one place a member's membership is decided, for insert, delete and put, an addition that
 * omits its serial fields and a world relation's entry alike.
 */
type MemberCheck<M, F, R> =
	M extends Phantom<{ readonly heading: infer H }>
		? [UnfitArms<H, F>] extends [never]
			? [MistypedFields<M, R>] extends [never]
				? unknown
				: Refusal<"a member's head writes each field at its type: an exact value re-enters a plain field only by Compute.cast">
			: Refusal<"the query's head is not a fact of the relation">
		: M extends ReadonlyArray<infer E> | Stream.Stream<infer E, unknown, unknown>
			? [UnfitArms<E, F>] extends [never]
				? unknown
				: Refusal<"a member fact is not a fact of the relation">
			: unknown

/** The fields of R a query member's head delivers at a type other than the field's own (WritesAt). */
type MistypedFields<M, R> =
	M extends Headed<infer Hc>
		? R extends Headed<infer C>
			? {
					[K in keyof Hc & keyof C]-?: WritesAt<Hc[K], C[K]> extends true ? never : K
				}[keyof Hc & keyof C]
			: never
		: never

/**
 * Whether a head's carrier X writes the field F: a JavaScript value, which takes its field's type and stands as a
 * fact of the relation (MemberCheck), or a term of F's identity and SQL type exactly, as the checker compares a member
 * column with its field (scalar/compute/types.ts compatible), whatever its values, facts and language.
 */
type WritesAt<X, F> =
	IsRetyped<X> extends true
		? true
		: [InputTerm<DomainOf<X>, unknown, unknown, SqlOfCarrier<X>>] extends [
					InputTerm<DomainOf<F>, unknown, unknown, SqlOfCarrier<F>>
			  ]
			? true
			: false

type UnfitArms<H, F> = H extends unknown ? ([FitsAnArm<H, F>] extends [never] ? H : never) : never
type FitsAnArm<Ha, F> = F extends unknown
	? [Ha] extends [F]
		? [Exclude<SuppliedKeys<Ha>, keyof F>] extends [never]
			? true
			: never
		: never
	: never

/**
 * The fields an arm supplies. An array literal of differently shaped objects is inferred as a union whose arms carry
 * each other's fields as `k?: undefined`; such a key supplies nothing.
 */
type SuppliedKeys<Ha> = {
	[K in keyof Ha]-?: [Ha] extends [Record<K, Ha[K]>] ? K : [Ha[K]] extends [undefined] ? never : K
}[keyof Ha]

/**
 * The relations a ChangeSet over S writes: its ordinary relations, and over a role the world relations its write list
 * names. Neither closed nor derived relations.
 */
export type WritableOf<S> =
	| Extract<RelationOf<S>, AnyRelation>
	| Extract<Extract<RelationOf<S>, AnyWorld>, { readonly name: WriteListOf<S> }>

/**
 * The same test for one relation, as membership in S's relations (IsRelationOf): members name an ordinary relation of
 * S, or a world relation S's write list names.
 */
type WritableCheck<S, R> =
	IsRelationOf<S, R> extends true
		? R extends AnyWorld
			? NameOf<R> extends WriteListOf<S>
				? unknown
				: Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">
			: unknown
		: Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">

/**
 * An Addition omits either all of its relation's serial fields or none, and no other field: a world relation's serial
 * fields are the head fields its definition takes from a serial field of the base (WorldSerialFields).
 */
export type Addition<R> = Fact<R> | Omit<Fact<R>, SerialFieldsOf<R> | WorldSerialFields<R>>

/**
 * Params is carried invariantly as well as read through `params`, so a ChangeSet that still needs parameters is never
 * a bound one.
 * Any ChangeSet, and any ChangeSet over S: the members every runtime ChangeSet has. ChangeSet is invariant in its
 * schema and parameters, so no instance of it is universal.
 */
export interface AnyChangeSet extends Built {
	readonly reads: RowDecoder<unknown>
	bind(params: never): AnyChangeSet
}

interface ChangeSetOver<in out S>
	extends AnyChangeSet, Phantom<{ readonly schema: Invariant<S> }> {}
/** A ChangeSet over one of the levels L. */
export type ChangeSetAt<L> = L extends unknown ? ChangeSetOver<L> : never

/**
 * ChangeSets, deltas, outcomes and witnesses. packages/engine/src/write/changeset implements the sealed ChangeSet value, and
 * it is bound here.
 *
 * A ChangeSet carries S invariantly, like Query; db.apply accepts a ChangeSet over any level of the database's role.
 * Writes is the union of the relation names its members write; db.apply checks it against the role's write list. Over
 * a role a ChangeSet writes the world relations the role's write list names, besides ordinary relations. Cx is the union
 * of the contexts its members and read-backs match, which db.apply checks against the role's (WithinRoleContexts).
 *
 * What an applied ChangeSet's outcome reads back is a real member: `reads`, the decoder of the record of its
 * read-backs, each under its name the rows its query's immediate decoder delivers (schema/record.ts record of named
 * attachments). read adds one, and union and sequence merge their arguments' (core/decoder.ts merge), so Reads is the
 * type of the records that decoder assembles (ReadsOf).
 */
export interface ChangeSet<
	S,
	Params = unknown,
	Writes extends string = never,
	Reads = unknown,
	Cx = never
> extends Phantom<{
	readonly params: Params
	readonly paramsInvariant: Invariant<Params>
	readonly writes: Writes
	readonly contexts: Cx
	readonly schema: Invariant<S>
}> {
	/** The decoder of the outcome's read-backs, by name. */
	readonly reads: RowDecoder<Reads>
	insert<R extends AnyRelation | AnyWorld, const M extends Member<S, Addition<R>>>(
		relation: R & WritableCheck<S, R>,
		facts: M & MemberCheck<M, Addition<R>, R>
	): ChangeSet<S, Simplify<Params & ParamsOf<M>>, Writes | NameOf<R>, Reads, Cx | ContextsOf<M>>
	delete<R extends AnyRelation | AnyWorld, const M extends Member<S, Fact<R>>>(
		relation: R & WritableCheck<S, R>,
		facts: M & MemberCheck<M, Fact<R>, R>
	): ChangeSet<S, Simplify<Params & ParamsOf<M>>, Writes | NameOf<R>, Reads, Cx | ContextsOf<M>>
	/** After the change, R's fact at each member's key is that member. */
	put<R extends AnyRelation | AnyWorld, const M extends Member<S, Fact<R>>>(
		relation: R & WritableCheck<S, R>,
		facts: M & MemberCheck<M, Fact<R>, R>
	): ChangeSet<S, Simplify<Params & ParamsOf<M>>, Writes | NameOf<R>, Reads, Cx | ContextsOf<M>>
	/**
	 * A query over the post-change state and the change's own delta, delivered in the outcome under `name`. It runs
	 * before COMMIT, so its rows are typed by immediate-constraint evidence only: they are the records its immediate
	 * decoder assembles.
	 */
	read<const Name extends string, Q extends QueryAt<LevelsOf<S>> | OrderedAt<LevelsOf<S>>, IHead>(
		name: ReadName<Name, Reads>,
		readBack: (delta: Delta<S>) => Q & Decoders<unknown, IHead>
	): ChangeSet<
		S,
		Simplify<Params & ParamsOf<Q>>,
		Writes,
		Simplify<Reads & { readonly [K in Name]: ReadonlyArray<IHead> }>,
		Cx | ContextsOf<Q>
	>
	bind(params: ParamArg<Params>): ChangeSet<S, unknown, Writes, Reads, Cx>
}

/**
 * Deltas name an ordinary relation of S, or any world relation of S: a world relation the ChangeSet writes nothing of
 * has an empty delta, a writable one written only through itself its target's projected onto its head, and any other
 * is refused by the write front end, which reads the ChangeSet's writes.
 */
type DeltaCheck<S, R> =
	IsRelationOf<S, R> extends true
		? unknown
		: Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">

export interface Delta<S> {
	/** Facts of R this application made present. */
	added<R extends (AnyRelation | AnyWorld) & Headed<Carriers>>(
		relation: R & DeltaCheck<S, R>
	): DeltaSource<R>
	/** Facts of R this application made absent. */
	removed<R extends (AnyRelation | AnyWorld) & Headed<Carriers>>(
		relation: R & DeltaCheck<S, R>
	): DeltaSource<R>
}

/**
 * A delta of R: a source of R's facts whose heading is R's own, so its variables are minted over R's fields. It names no
 * relation, so its variables carry no origin.
 */
export interface DeltaSource<R extends Headed<Carriers>>
	extends Source<Fact<R>>, Headed<R["heading"]> {}

/** The writes and the read-backs of a ChangeSet: Reads is its reads decoder's records. */
export type WritesOf<C> = C extends Phantom<{ readonly writes: infer W }> ? W : never
export type ReadsOf<C> = C extends { readonly reads: RowDecoder<infer R> } ? R : never

/**
 * A ChangeSet over a level of the other's schema combines with it, as db.apply accepts either: the result
 * is over the higher of the two schemas. Levels form one chain, so of two schemas either one is a level of the other
 * or they do not combine.
 */
type HigherLevel<A, B> = IsLevelOf<A, B> extends true ? A : IsLevelOf<B, A> extends true ? B : never
type LevelCheck<H> = [H] extends [never]
	? Refusal<"the ChangeSets' schemas are not levels of one another">
	: unknown

/**
 * Read-back names are distinct across a whole ChangeSet, its strata and unions included: a read whose name is already
 * a read-back, and a union or sequence of ChangeSets that share one, are type errors.
 */
type ReadNameCheck<Name extends string, Reads> = Name extends keyof Reads
	? Refusal<"read-back names are distinct: this ChangeSet already has a read-back of this name">
	: unknown
/** A read-back's name: one literal, the key of its rows in the outcome's record, and no read-back's name already. */
export type ReadName<Name extends string, Reads> = OneName<Name> & ReadNameCheck<Name, Reads>
type DisjointReads<A, B> = [keyof A & keyof B] extends [never]
	? unknown
	: Refusal<"read-back names are distinct: the ChangeSets share a read-back name">

export interface ChangeSetConstructor {
	empty<S extends AnySchema>(schema: S): ChangeSet<S>
	/** The commutative combination: one add-wins transition. */
	union<SA, SB, P1, P2, W1 extends string, W2 extends string, R1, R2, C1, C2>(
		a: ChangeSet<SA, P1, W1, R1, C1>,
		b: ChangeSet<SB, P2, W2, R2, C2> & LevelCheck<HigherLevel<SA, SB>> & DisjointReads<R1, R2>
	): ChangeSet<HigherLevel<SA, SB>, Simplify<P1 & P2>, W1 | W2, Simplify<R1 & R2>, C1 | C2>
	/**
	 * Strata: b is evaluated against the state a produced. The result is over the higher of the two schemas, each of
	 * which is a level of it. Strata are associative, so three are sequence(sequence(a, b), c).
	 */
	sequence<SA, SB, P1, P2, W1 extends string, W2 extends string, R1, R2, C1, C2>(
		a: ChangeSet<SA, P1, W1, R1, C1>,
		b: ChangeSet<SB, P2, W2, R2, C2> & LevelCheck<HigherLevel<SA, SB>> & DisjointReads<R1, R2>
	): ChangeSet<HigherLevel<SA, SB>, Simplify<P1 & P2>, W1 | W2, Simplify<R1 & R2>, C1 | C2>
}

/** A key value a witness may carry: a vector field may be a key field. */
export type KeyHost =
	| string
	| number
	| bigint
	| boolean
	| Decimal
	| Money
	| Span<number>
	| Span<bigint>
	| Vector

/**
 * What a law's refusal names: the violating fact's key, or why it names none.
 *
 * - `key`: one violating fact's relation and its key values, never a payload column. A write statement's refusal names
 *   the key you submitted, in the fields you wrote it in, a collision with a fact outside the written entry included;
 *   a residual law names the key its function reports.
 * - `withheld`: a residual law's key, withheld from a role that does not hold the violating relation whole.
 * - `unreported`: a violation PostgreSQL raised itself, on a native constraint, states its key only in its message,
 *   which the runtime neither forwards nor parses.
 */
export type Witness =
	| {
			readonly kind: "key"
			readonly relation: string
			readonly values: Readonly<Record<string, KeyHost>>
	  }
	| { readonly kind: "withheld" }
	| { readonly kind: "unreported" }

/** A value a law states, a selection's literal, as the host holds it: a closed relation's handle is its string. */
export type LawValue =
	| string
	| number
	| bigint
	| boolean
	| Decimal
	| Money
	| Span<number>
	| Span<bigint>
	| Vector

/**
 * One side of a law as its statement declares it: a relation's fields, in the order the statement pairs them, over
 * the facts whose selected fields hold the selected values, in field name order.
 */
export interface LawSide {
	readonly relation: string
	readonly fields: NonEmptyReadonlyArray<string>
	readonly selection: ReadonlyArray<{ readonly field: string; readonly value: LawValue }>
}

/** How a capacity weighs each source fact: one each, or by a field's value or its span's width. */
export type LawWeight =
	| { readonly kind: "count" }
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "duration"; readonly field: string }

/** A capacity's inclusive bounds: a literal or a field of the target, and above, possibly unbounded. */
export interface LawBounds {
	readonly low: bigint | { readonly ref: string }
	readonly high: bigint | { readonly ref: string } | "*"
}

/**
 * A law as the schema states it, which an `invariant-rejected` outcome names: an application matches on it directly.
 *
 * - `primaryKey` and `key`: a relation's primary key or a declared key, by its fields (a span field makes it a
 *   nonoverlap key);
 * - `check`: a relation's row check, by its name;
 * - `contained`: a containment, a foreign key included, from its source side into its target side;
 * - `mirrors`: one half of a mirrors, from one side into the other;
 * - `coverage`: a containment or mirrors half whose sides pair a span field, the source's span covered by the target's;
 * - `alternatives`: an alternatives family's reverse obligation, by its parent relation and discriminator: a parent
 *   fact selecting a handle has its arm's fact (its head containment is `contained`);
 * - `alternativesArm`: an alternatives family's arm relation `arm`, by the parent relation and discriminator and the
 *   handles it is the arm of, in roster order: each of its facts is the payload of a parent fact selecting one of them;
 * - `capacity`: a capacity, by its target and source sides, its weight and its bounds;
 * - `contract`: a contract's predicate, by its name;
 * - `pattern`: a text pattern (str.regex), as its domain spells it: one law for every spelling of the same language;
 * - `numericBound`: a bare numeric field's bound, at most 1,000 integer digits, by its relation and field.
 */
export type Law =
	| {
			readonly kind: "primaryKey" | "key"
			readonly relation: string
			readonly fields: ReadonlyArray<string>
	  }
	| { readonly kind: "check"; readonly relation: string; readonly name: string }
	| { readonly kind: "contained" | "mirrors"; readonly from: LawSide; readonly to: LawSide }
	| {
			readonly kind: "coverage"
			readonly statement: "contained" | "mirrors"
			readonly from: LawSide
			readonly to: LawSide
	  }
	| { readonly kind: "alternatives"; readonly relation: string; readonly field: string }
	| {
			readonly kind: "alternativesArm"
			readonly relation: string
			readonly field: string
			readonly arm: string
			readonly handles: NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "capacity"
			readonly target: LawSide
			readonly from: LawSide
			readonly weight: LawWeight
			readonly within: LawBounds
	  }
	| { readonly kind: "contract"; readonly contract: string }
	| { readonly kind: "pattern"; readonly source: string; readonly flags: "u" | "su" }
	| { readonly kind: "numericBound"; readonly relation: string; readonly field: string }
