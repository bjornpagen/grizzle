import type { Stream } from "effect"
import type { Column, Decoded } from "#compiler/core/decoder.ts"
import type { built, Domained, Languaged, Phantom } from "#compiler/core/phantom.ts"
import type { AggregateName } from "#compiler/scalar/aggregate.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type {
	Carriers,
	ConstantOrigin,
	DomainOf,
	HasOrigin,
	Headed,
	LanguageOf,
	InputOrigin,
	Literal,
	LiteralOrigin,
	Meets,
	Minted,
	Origin,
	OriginOfTerm,
	ParamNeeds,
	ParamsContribution,
	ParamsOfTerm,
	Refusal,
	Retyped,
	Source,
	SourceOrigin,
	SqlOfCarrier,
	TermBase,
	UnionToIntersection,
	ValueOfTerm
} from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { HoldingMatches, OriginsOf, ScopedKey } from "#compiler/types/evidence/evidence.ts"
import type { LiteralOf } from "#compiler/types/fields/field.ts"
import type {
	AnyClosed,
	AnyRelation,
	FactOfFields,
	HeadingOf
} from "#compiler/types/schema/relation.ts"
import type { AnyContext, AnyWorld } from "#compiler/types/schema/world.ts"

/**
 * A fold whose result is not a term, and the parameters its argument needs. The runtime value names its fold, and
 * carries the column of its result, whose values are T, and its SQL type, read off its argument's; D is its domain and
 * L its language, its argument's for min and max, which return an input unchanged, else its result's.
 */
export interface Aggregate<
	out T,
	in P = unknown,
	out Sql extends SqlTag = SqlTag,
	out D = T,
	out L = T
>
	extends
		Domained<D>,
		Languaged<L>,
		Phantom<{
			readonly aggregate: T
			readonly needs: ParamNeeds<P>
		}> {
	readonly aggregate: AggregateName
	readonly column: Column<T>
	readonly sql: Sql
}

/**
 * A head term yielding zero or more facts per binding. The runtime value names its producer, and carries its span
 * operand's column, whose values are T, and SQL type; its span operand's domain is its domain D and its language L. O
 * is the origin of what it reads, a computation over its operands' (ComputedOrigin), which the evidence reads as a
 * term's: unknown, which nothing determines, where it states none.
 */
export interface Producer<out T, in P = unknown, out D = T, out L = T, out O = unknown>
	extends
		Domained<D>,
		Languaged<L>,
		Phantom<{
			readonly produces: T
			readonly needs: ParamNeeds<P>
			readonly origin: O
		}> {
	readonly produces: "intersection" | "difference" | "pack"
	readonly column: Column<T>
	readonly sql: "range"
}

/**
 * A relation-valued parameter: a source whose matching rule needs the parameter bound to a set of facts, supplied as
 * an array or a Stream, of the heading of fields C.
 */
export interface ParamSource<Name extends string, C>
	extends
		Source<
			FactOfFields<C>,
			{ readonly [K in Name]: ReadonlyArray<FactOfFields<C>> | Stream.Stream<FactOfFields<C>> }
		>,
		Headed<C> {}

/**
 * Query building blocks: variables with origin brands, bindings, head terms and result typing.
 * The runtime terms are the builder's (packages/engine/src/query/build/terms.ts).
 *
 * The parent variables attach passes its child, minted over the parent's heading of carriers C. Each is an input, and
 * keeps the relation field its parent head field was matched at, and its scope, when the parent's evidence records one,
 * which is what lets a declared containment from that field prove the child, read with the other fields of its scope's
 * fact.
 */
export type ParentVars<C, Ev> = Minted<C, ParentOrigins<C, Ev>>
type ParentOrigins<C, Ev> = {
	readonly [K in keyof C]: InputOrigin & ParentOriginOf<OriginsOf<Ev>, K>
}
type ParentOriginOf<O, K> = K extends keyof O ? (O[K] extends Origin ? O[K] : unknown) : unknown

/**
 * What v mints variables over: a source value holding its heading of carriers, a relation, closed or derived relation,
 * a query, a bound import, an interior stage, a relation parameter or a recursive definition's self.
 */
export type VSource = (
	| AnyRelation
	| AnyClosed
	| AnyDerived
	| AnyWorld
	| AnyContext
	| Source<unknown>
) &
	Headed<Carriers>

/**
 * The variables `v` mints over a source in the scope named N, one per carrier of its heading (schema/record.ts mint). A
 * variable over a relation, closed relation or derived relation names the relation and field it came from and its
 * scope, so the variables of two scopes of one relation are of two types; key retention through find is decided from
 * that origin. A variable over any other source names the source's field and its scope (SourceOrigin).
 */
export type VarsOf<R extends Headed<Carriers>, N extends string> = Minted<
	R["heading"],
	VarOrigins<R, N>
>
export type VarOrigins<R, N extends string> =
	R extends Headed<infer C>
		? R extends {
				readonly kind: "relation" | "closed" | "closedRelation" | "derived" | "world" | "context"
				readonly name: infer Rel extends string
			}
			? { readonly [K in keyof C]: Origin<Rel, K & string, N> }
			: { readonly [K in keyof C]: SourceOrigin<K & string, N> }
		: unknown

/**
 * What a match or negation may bind each field to: a JavaScript value of the field's language, every value of its
 * type, which the source's carrier states (LanguageOf), or a term that meets the field's type (Meets, the one relation:
 * a computed exact value of a plain integer or money field's family among them, which the checker compares with the
 * column widened, as Compute.eq does), the domain and SQL type the carrier states. A JavaScript value or a typed
 * constant selects the arms whose field delivers its value.
 */
export type Bindings<Head, C> = { readonly [K in AnyKeyOf<Head>]: BindingAt<C, K> }
type BindingAt<C, K> =
	| (K extends keyof C ? LiteralOf<LanguageOf<C[K]>> : never)
	| (K extends keyof C ? Meets<DomainOf<C[K]>, SqlOfCarrier<C[K]>> : never)
/** The heading of carriers a source holds, whose types its bindings meet. */
export type CarriersOf<R> = R extends Headed<infer C> ? C : never

/**
 * What a rule's match and negation read of a source, inferred from their argument, and from a generic argument's
 * constraint where the argument is one: its kind K, its name N, heading C and primary key PK, and the brand BT of a
 * built source, a query, stage, delta, context, derived or world relation, which an ordinary relation holds none of.
 * A source whose every member is an ordinary relation is read by what it shows (OrdinaryKind), so the bindings of a
 * generic relation are typed by the heading its relations share (types/schema/statements.ts Shows), and every other
 * source by its own type. A generic relation whose relations share no heading is refused.
 */
export interface SourceShows<out K, out N, out C, out PK, out BT> {
	readonly kind?: K
	readonly name?: N
	readonly heading?: C | Refusal<"a generic source's relations share one heading">
	readonly primaryKey?: PK
	readonly [built]?: BT
}

/** The kind a source is read as: "relation" where every member of it is an ordinary relation, its own otherwise. */
export type OrdinaryKind<K, BT> = [K] extends ["relation"]
	? unknown extends BT
		? "relation"
		: "mixed"
	: K

/** The heading of a source of kind K that shows C: an ordinary relation's facts of C, any other source's own. */
export type ShownHeading<R, K, C> = [K] extends ["relation"] ? FactOfFields<C> : HeadingOf<R>

/** The carriers of a source of kind K that shows C: an ordinary relation's C, any other source's own. */
export type ShownCarriers<R, K, C> = [K] extends ["relation"] ? C : CarriersOf<R>

/**
 * A source v mints variables over whose heading of carriers is F: a relation, or a generic relation whose relations share
 * that heading, which v infers from its constraint (types/schema/statements.ts Shows); one whose relations share none
 * is refused.
 */
export interface HeadedBy<out F> {
	readonly heading: F | Refusal<"a generic source's relations share one heading">
}

/** A source's name, where it has one: a relation's, or the union of a generic relation's relations' names. */
export interface SourceNamed<out N> {
	readonly name?: N
}

/**
 * The origins of the variables v mints in the scope Sc over a source named N whose heading is F: a named source's, a
 * relation's, closed, derived or world relation's or a context's, name its field and scope (VarOrigins), read off the
 * name v infers, which a generic relation's constraint gives; a source with no name, its own (VarOrigins).
 */
export type ShownOrigins<R, Sc extends string, N, F> = [N] extends [string]
	? { readonly [K in keyof F]: Origin<N, K & string, Sc> }
	: VarOrigins<R, Sc>

/**
 * Refuses the keys of a binding object that name no field the binding may bind. A binding object is inferred as a
 * type parameter (`const B extends Partial<Bindings<H, C>>`), and TypeScript checks no excess property against an
 * inferred parameter's constraint, so `match(Task, { id, nope: id })` would otherwise typecheck where a plain
 * `bindings: Partial<Bindings<HeadingOf<R>, CarriersOf<R>>>` refuses it. Over a union heading, a match whose constants
 * select some of the arms, the discriminant among them, may bind the fields common to those arms; otherwise only the
 * fields common to every arm, so `match(taskPayloads, { id, operator })` and
 * `match(taskPayloads, { kind: "Manual", id, budget })` are refused.
 */
export type NoExcess<B, H> = {
	readonly [
		K in Exclude<keyof B, AdmissibleKeys<H, B>>
	]: Refusal<"not a field of the arms the bindings select">
}
type AnyKeyOf<H> = H extends unknown ? keyof H : never
/**
 * The fields a binding object may bind: the fields common to the arms its constants select (LiteralArms), when they
 * select some but not all arms, and the common fields otherwise.
 */
type AdmissibleKeys<H, B> = [LiteralArms<H, B>] extends [never]
	? keyof H
	: [H] extends [LiteralArms<H, B>]
		? keyof H
		: keyof LiteralArms<H, B>

/**
 * Refuses a binding object whose constants select no arm of the source (LiteralArms), at every field common to the
 * arms it binds to a constant: a filter no fact of the source can meet, which the checker refuses alike (check/
 * checker.ts RuleCheck #selected). Only the constants of their fields' types (C, the source's carriers) select, as the
 * checker selects by the values its column's type admits: one of another type is the bindings' own refusal
 * (BindingAt). A source with no head constant, a relation's or a context's, delivers every value of its fields' types,
 * so its constants always select it.
 */
export type DeadConstants<B, H, C> = [H] extends [never]
	? unknown
	: [LiteralArms<H, WellTyped<B, C>>] extends [never]
		? {
				readonly [
					K in CommonLiteralKeys<WellTyped<B, C>, H>
				]: Refusal<"no arm of the source delivers the bound constants">
			}
		: unknown
/** The bindings of B a binding of their field may be (BindingAt), the field's carrier in C. */
type WellTyped<B, C> = {
	readonly [
		K in keyof B as K extends keyof C
			? B[K] extends LiteralOf<LanguageOf<C[K]>> | Meets<DomainOf<C[K]>, SqlOfCarrier<C[K]>>
				? K
				: never
			: never
	]: B[K]
}

/**
 * The arms that admit every constant the bindings give one of their fields: an arm admits a constant when the
 * constant's values may be among those its field delivers (Overlaps), its own constant's value or its column's type's
 * values. A constant whose value the types carry, a JavaScript primitive or a handle, is told apart from every other
 * value; one whose value they do not, a Decimal, a Money, a typed Compute.literal, a value of a non-literal type, may
 * be any value of its type, so it selects every arm whose field it fits.
 */
type LiteralArms<H, B> = H extends unknown
	? false extends {
			[K in CommonLiteralKeys<B, H>]-?: Overlaps<
				LiteralOf<BoundValues<B[K]>>,
				LiteralOf<H[K & keyof H]>
			>
		}[CommonLiteralKeys<B, H>]
		? never
		: H
	: never

/** The fields of H a binding object binds to a constant: a JavaScript value, or a typed constant. */
type CommonLiteralKeys<B, H> = {
	[K in keyof B]-?: B[K] extends Literal ? K : IsConstant<B[K]> extends true ? K : never
}[keyof B] &
	keyof H
/** The values a constant binding holds: a JavaScript value itself, a typed constant its column's. */
type BoundValues<X> = X extends TermBase ? ValueOfTerm<X> : X
/**
 * Whether two value sets may share a value: a number and a bigint of one spelling are one value of a bigint column, a
 * bare head number a union types as bigint by its position, as the checker compares them, typed at the column.
 */
type Overlaps<X, Y> = [Spelled<X> & Spelled<Y>] extends [never] ? false : true
type Spelled<X> = X extends number | bigint ? `${X}` : X
/** A typed constant, X.handle(member) or Compute.literal(F, x). */
type IsConstant<X> = X extends TermBase
	? [OriginOfTerm<X>] extends [ConstantOrigin]
		? true
		: false
	: false

/** The parameters a binding object needs: its terms' own. */
export type BindingParams<B> = UnionToIntersection<
	{ [K in keyof B]-?: ParamsContribution<ParamsOfTerm<B[K]>> }[keyof B]
>

/**
 * The origins of a finished head: each variable a match of its relation binds at its own field, held by one head
 * field, of a scope whose head variables are fields of one fact. An origin names one variable of its rule, its scope's
 * field, so the variable bound at its own field is the one every binding of that origin names, a join variable
 * included: a variable of another scope of Account.plan bound only at Upgrade.target is another origin, whose value no
 * containment from Account.plan describes. A variable is a field of the fact of each match that binds it at its own
 * field (evidence/evidence.ts HoldingMatches), and a scope keeps its origins where one match's fact holds every head
 * variable of it, so a proof over a parent's origins (ContainmentProof, ArmClaim, ReflexiveProof) reads one scope's
 * origins as one fact's fields: a self-join's two scopes are two facts, each proving its own. A scope whose head
 * variables no one fact holds, each bound at its own field in another match, keeps none. A parent variable's origin is
 * the parent's, not this rule's: its value here was read from the parent's fact, so it is no origin of this head.
 */
export type HeadOrigins<H, Occurrences extends ReadonlyArray<unknown>> = OneFactScopes<
	Witnessed<H, Occurrences>,
	Occurrences
>

/** The head fields holding a variable some match binds at its own field, alone among the head's fields. */
type Witnessed<H, Os extends ReadonlyArray<unknown>> = {
	readonly [K in keyof H as [WitnessedAt<H, K, Os>] extends [never] ? never : K]: WitnessedAt<
		H,
		K,
		Os
	>
}

type WitnessedAt<H, K extends keyof H, Os extends ReadonlyArray<unknown>> =
	HasOrigin<H[K]> extends true
		? [OriginOfTerm<H[K]>] extends [InputOrigin]
			? never
			: OriginOfTerm<H[K]> extends infer O
				? O extends Origin<infer R, infer F, infer N>
					? [HoldingMatches<Os, O>] extends [never]
						? never
						: OnlyAt<HeadFieldsByOrigin<H>[ScopedKey<R, F, N>], K> extends true
							? O
							: never
					: never
				: never
		: never

/** The witnessed origins of the scopes one match holds every witnessed head variable of. */
type OneFactScopes<W, Os extends ReadonlyArray<unknown>> = {
	readonly [K in keyof W as [SharedMatches<W, W[K], Os>] extends [never] ? never : K]: W[K]
}

/** The matches that hold every witnessed head variable of origin O's scope. */
type SharedMatches<W, O, Os extends ReadonlyArray<unknown>> =
	O extends Origin<infer R, string, infer N> ? ScopeMatches<W, R, N, Os> : never

/**
 * The matches that hold every witnessed head variable of scope N of R: read once per scope, which every head field of
 * the scope shares, never once per field.
 */
type ScopeMatches<W, R extends string, N extends string, Os extends ReadonlyArray<unknown>> = {
	[I in keyof Os & `${number}`]-?: false extends {
		[K in keyof W]-?: W[K] extends Origin<R, string, N>
			? I extends HoldingMatches<Os, W[K]>
				? true
				: false
			: true
	}[keyof W]
		? never
		: I
}[keyof Os & `${number}`]
type OnlyAt<U, X> = [U] extends [X] ? ([X] extends [U] ? true : false) : false

/**
 * The head fields by the origin key of each variable they hold, an input aside: each field under the key of each of its
 * origins and none under any other key, built in one pass over the head, so a field's fellows of one origin are one
 * property read, never a pass over the head per field.
 */
type HeadFieldsByOrigin<H> = {
	readonly [K in keyof H as HeadOriginKeys<H[K]>]: K
} & { readonly [key: string]: never }

type HeadOriginKeys<X> =
	HasOrigin<X> extends true
		? [OriginOfTerm<X>] extends [InputOrigin]
			? never
			: OriginKeys<OriginOfTerm<X>>
		: never
type OriginKeys<O> = O extends Origin<infer R, infer F, infer N> ? ScopedKey<R, F, N> : never

/** A JavaScript value a head may hold, typed by what it meets or by its own default. */
export type HeadValue = Literal | Decimal | Money

/**
 * A JavaScript value as a head holds it (HeadTerms): a term whose column delivers the value, of its JavaScript
 * default's domain and SQL type, which a union's arms that deliver the key by a term retype (Retyped), as the checker
 * types a bare head literal by its position.
 */
export interface HeadLiteral<L>
	extends
		TermBase,
		Domained<Retyped<JavaScriptType<L>, JavaScriptSql<L>>>,
		Languaged<JavaScriptType<L>>,
		Phantom<{ readonly needs: ParamNeeds<unknown>; readonly origin: LiteralOrigin }> {
	readonly column: Column<L>
	readonly sql: SqlTag
}
/** The host type of a JavaScript value's default SQL type (check/checker.ts bareLiteralType). */
type JavaScriptType<L> = L extends string
	? string
	: L extends number
		? number
		: L extends bigint
			? bigint
			: L extends boolean
				? boolean
				: L
/** A JavaScript value's default SQL type: a string's text, a number's integer, a Decimal's numeric, a Money's money. */
type JavaScriptSql<L> = L extends string
	? "text"
	: L extends number
		? "integer"
		: L extends bigint
			? "bigint"
			: L extends boolean
				? "boolean"
				: L extends Decimal
					? "numeric"
					: "money"
/**
 * What a head may hold: a term, an aggregate, a producer, or a JavaScript value, which the checker types by the field
 * it writes, else by the type its union's other arms agree on, else by its own default.
 */
export type HeadTerm = TermBase | Aggregate<unknown, never> | Producer<unknown, never> | HeadValue
export type HeadShape = Record<string, HeadTerm>
/**
 * A head as its arm holds it: each JavaScript value its head literal (schema/record.ts headRecord), every other entry
 * itself.
 */
export type HeadTerms<H> = {
	readonly [K in keyof H]: H[K] extends HeadValue
		? HeadLiteral<H[K]>
		: Extract<H[K], TermBase | Aggregate<unknown, never> | Producer<unknown, never>>
}

/** The host value of each head term: the record a find over head H decodes to (schema/record.ts record). */
export type ResultOf<H> = Decoded<[H]>

/** The parameters a head's terms need: a union-to-intersection over the head's own values, never over the schema. */
export type HeadParams<H> = UnionToIntersection<
	{ [K in keyof H]-?: ParamsContribution<ParamsOfTerm<H[K]>> }[keyof H]
>
