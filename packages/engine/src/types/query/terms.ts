import type { Stream } from "effect"
import type { Column, Decoded } from "#compiler/core/decoder.ts"
import type { Phantom } from "#compiler/core/phantom.ts"
import type { AggregateName } from "#compiler/scalar/aggregate.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type {
	Carriers,
	HasOrigin,
	Headed,
	InputOrigin,
	Literal,
	Minted,
	Origin,
	OriginOfTerm,
	ParamsContribution,
	ParamsOfTerm,
	Refusal,
	Source,
	Term,
	TermBase,
	UnionToIntersection
} from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { OriginsOf } from "#compiler/types/evidence/evidence.ts"
import type { LiteralOf } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation, FactOfFields } from "#compiler/types/schema/relation.ts"
import type { AnyContext, AnyWorld } from "#compiler/types/schema/world.ts"

/**
 * A fold whose result is not a term, and the parameters its argument needs. The runtime value names its fold, and
 * carries the column of its result and its SQL type, read off its argument's.
 */
export interface Aggregate<
	out T,
	out P = unknown,
	out Sql extends SqlTag = SqlTag
> extends Phantom<{
	readonly aggregate: T
	readonly params: P
}> {
	readonly aggregate: AggregateName
	readonly column: Column<T>
	readonly sql: Sql
}

/**
 * A head term yielding zero or more facts per binding. The runtime value names its producer, and carries its span
 * operand's column.
 */
export interface Producer<out T, out P = unknown> extends Phantom<{
	readonly produces: T
	readonly params: P
}> {
	readonly produces: "intersection" | "difference" | "pack"
	readonly column: Column<T>
	readonly sql: SqlTag
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
 * Variables over a heading, every one a term carrying origin O. Over a union heading there is one
 * variable per field of any arm, typed over the arms that have the field, as the builder mints one per name of the
 * union heading: a match that binds the discriminant selects one arm and may
 * bind that arm's own fields, which needs a variable for them.
 */
export type Vars<Head, O = unknown> = {
	readonly [K in AnyKeyOf<Head>]: Term<FieldOfArms<Head, K>, unknown, O>
}

/**
 * The parent variables attach passes its child, minted over the parent's heading of carriers C. Each is an input, and
 * keeps the relation field its parent head field was matched at when the parent's evidence records one, which is what
 * lets a declared containment from that field prove the child.
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
 * The variables `v` mints over a source, one per carrier of its heading (schema/record.ts mint). A variable over a
 * relation, closed relation or derived relation names the relation and field it came from; key retention through find
 * is decided from that origin.
 */
export type VarsOf<R extends Headed<Carriers>> = Minted<R["heading"], VarOrigins<R>>
export type VarOrigins<R> = R extends {
	readonly kind: "relation" | "closed" | "derived" | "world" | "context"
	readonly name: infer N extends string
}
	? R extends Headed<infer C>
		? { readonly [K in keyof C]: Origin<N, K & string> }
		: unknown
	: unknown

/**
 * What a match or negation may bind each field to: a term of the field's exact host type, a parameter of it among
 * them, or a literal. Over a union heading, each arm's field, or a term of the field across the arms that have it (a
 * variable v mints over the union, or a parameter of that type).
 */
export type Bindings<Head> = { readonly [K in AnyKeyOf<Head>]: BindingAt<Head, K> }
type BindingAt<Head, K> =
	| (Head extends unknown
			? K extends keyof Head
				? BindingTerm<Head[K]> | LiteralOf<Head[K]>
				: never
			: never)
	| BindingTerm<FieldOfArms<Head, K>>
/**
 * A term of host type T, whatever parameters it needs and wherever it came from. Term is covariant in its parameters
 * and origin, so `unknown` admits every map and every origin.
 */
type BindingTerm<T> = Term<T>

/**
 * Refuses the keys of a binding object that name no field the binding may bind. A binding object is inferred as a
 * type parameter (`const B extends Partial<Bindings<H>>`), and TypeScript checks no excess property against an
 * inferred parameter's constraint, so `match(Task, { id, nope: id })` would otherwise typecheck where a plain
 * `bindings: Partial<Bindings<HeadingOf<R>>>` refuses it. Over a union heading, a match with the discriminant
 * bound narrows to the arms it selects and may bind their common fields; without it, only the fields common to every
 * arm may be bound, so `match(taskPayloads, { id, operator })` and
 * `match(taskPayloads, { kind: "Manual", id, budget })` are refused.
 */
export type NoExcess<B, H> = {
	readonly [
		K in Exclude<keyof B, AdmissibleKeys<H, B>>
	]: Refusal<"not a field of the arms the bindings select">
}
type AnyKeyOf<H> = H extends unknown ? keyof H : never
/**
 * The fields a binding object may bind: the fields common to the arms its literal bindings of common fields select,
 * when they select some but not all arms, and the common fields otherwise. Literals that select no arm are refused by
 * the bindings' own types: no arm's field admits them.
 */
type AdmissibleKeys<H, B> = [LiteralArms<H, B>] extends [never]
	? keyof H
	: [H] extends [LiteralArms<H, B>]
		? keyof H
		: keyof LiteralArms<H, B>

/**
 * The arms whose fields admit every literal the bindings give a field common to all arms, the discriminant among them.
 */
type LiteralArms<H, B> = H extends unknown
	? false extends {
			[K in CommonLiteralKeys<B, H>]-?: B[K] extends LiteralOf<H[K & keyof H]> ? true : false
		}[CommonLiteralKeys<B, H>]
		? never
		: H
	: never

type CommonLiteralKeys<B, H> = { [K in keyof B]-?: B[K] extends Literal ? K : never }[keyof B] &
	keyof H

/** The parameters a binding object needs: its terms' own. */
export type BindingParams<B> = UnionToIntersection<
	{ [K in keyof B]-?: ParamsContribution<ParamsOfTerm<B[K]>> }[keyof B]
>
/** A field's host type over every arm that has it. */
type FieldOfArms<H, K> = H extends unknown ? (K extends keyof H ? H[K] : never) : never

/**
 * The origins of a finished head: each variable the rule binds at its own field, in a rule that matches no source
 * twice, held by one head field. Under R1 such a rule binds one variable per origin, so the variable bound at its own
 * field is the one every binding of that origin names, a join variable included: the checker refuses a second variable
 * minted at Account.plan bound only at Upgrade.target, whose value no containment from Account.plan describes. A parent
 * variable's origin is the parent's, not this rule's: its value here was read from the parent's fact, so it is no
 * origin of this head.
 */
export type HeadOrigins<H, Positions extends string, Repeated extends boolean> = {
	readonly [
		K in keyof H as [HeadOriginOf<H, K, Positions, Repeated>] extends [never] ? never : K
	]: HeadOriginOf<H, K, Positions, Repeated>
}

type HeadOriginOf<
	H,
	K extends keyof H,
	Positions extends string,
	Repeated extends boolean
> = Repeated extends true
	? never
	: HasOrigin<H[K]> extends true
		? [OriginOfTerm<H[K]>] extends [InputOrigin]
			? never
			: OriginOfTerm<H[K]> extends infer O
				? O extends Origin<infer R, infer F>
					? `${R}.${F}@${R}.${F}` extends Positions
						? OnlyAt<HeadFieldsOfOrigin<H, `${R}.${F}`>, K> extends true
							? O
							: never
						: never
					: never
				: never
		: never
type OnlyAt<U, X> = [U] extends [X] ? ([X] extends [U] ? true : false) : false
type HeadFieldsOfOrigin<H, Key> = {
	[K in keyof H]-?: HasOrigin<H[K]> extends true
		? [OriginOfTerm<H[K]>] extends [InputOrigin]
			? never
			: OriginOfTerm<H[K]> extends infer O
				? O extends Origin<infer R, infer F>
					? `${R}.${F}` extends Key
						? K
						: never
					: never
				: never
		: never
}[keyof H]

/** What a head may hold: a term (a head literal, r.literal(x), among them), an aggregate or a producer. */
export type HeadTerm = TermBase | Aggregate<unknown> | Producer<unknown>
export type HeadShape = Record<string, HeadTerm>

/** The host value of each head term: the record a find over head H decodes to (schema/record.ts record). */
export type ResultOf<H> = Decoded<[H]>

/** The parameters a head's terms need: a union-to-intersection over the head's own values, never over the schema. */
export type HeadParams<H> = UnionToIntersection<
	{ [K in keyof H]-?: ParamsContribution<ParamsOfTerm<H[K]>> }[keyof H]
>
