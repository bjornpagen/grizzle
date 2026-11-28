import type { RowDecoder } from "#compiler/core/decoder.ts"
import type { Built, Phantom } from "#compiler/core/phantom.ts"
import type {
	Carriers,
	Headed,
	Invariant,
	PhantomOf,
	Refusal
} from "#compiler/types/core/phantom.ts"
import type {
	ContextsOf,
	HeadOf,
	ParamsOf,
	QueryBase,
	UnionArm,
	UnionArms
} from "#compiler/types/query/query.ts"
import type { Producer } from "#compiler/types/query/terms.ts"
import type { FactOfFields, RelationName } from "#compiler/types/schema/relation.ts"
import type { LevelKeyOf } from "#compiler/types/schema/schema.ts"

/** A definition: a query holding its heading of carriers. */
export type DefinitionQuery = QueryBase & Headed<Carriers>

/** Any derived relation: the members every one has. */
export interface AnyDerived extends Built, Headed<Carriers> {
	readonly kind: "derived"
	readonly name: string
	readonly definition: QueryBase
	readonly fact: RowDecoder<unknown>
}

declare const ruleRead: unique symbol

/**
 * Whether a rule may read a derived relation, a phantom of its definition (RuleReadOf): `true`, or the refusals of the
 * arms a rule cannot read. on, select and check take a derived relation that is RuleReadDerived, so one of another
 * definition is refused where its side is written, the refusal named at this member.
 */
export interface RuleRead<out R> {
	readonly [ruleRead]?: R | undefined
}

/**
 * The refusal of a definition's arm a rule cannot read, or never for an arm a rule reads: a rule, a union of rules or a
 * recursion, no head term a span producer. An aggregate and a recursion are no refusal here: a rule over one is judged
 * whole, over the units a transaction wrote, where it is unit-local, which only the schema's compile decides
 * (analysis/theory/unit.ts), and refused there where it is not.
 */
type ArmRefusal<A> =
	A extends UnionArm<infer C, PropertyKey, infer Stage, boolean>
		? Stage extends "rule" | "union" | "recursive"
			? [KeysOfCarrier<C, Producer<unknown, never>>] extends [never]
				? never
				: Refusal<"a rule reads a derived relation whose definition joins, selects and projects: this one produces ranges">
			: Refusal<StageRefusals[Exclude<Stage, "rule" | "union" | "recursive">]>
		: never

/** The refusal of a definition's arm a stage beyond a rule made. */
interface StageRefusals {
	readonly take: "a rule reads a derived relation whose definition joins, selects and projects: this one orders and takes"
	readonly attach: "a rule reads a derived relation whose definition joins, selects and projects: this one attaches a nested query"
	readonly approximate: "a rule reads a derived relation whose definition joins, selects and projects: this one approximates a search"
}

/** The fields of a heading of carriers whose terms are of kind X. */
type KeysOfCarrier<C, X> = {
	readonly [K in keyof C]-?: [C[K]] extends [never] ? never : C[K] extends X ? K : never
}[keyof C]

/** The refusals of the arms of Q's definition, or never where every arm joins, selects and projects. */
type ArmsRefusals<Q> = ArmsRefusalsIn<PhantomOf<Q>["arms" & keyof PhantomOf<Q>]>
type ArmsRefusalsIn<Arms> = Arms extends UnionArms ? ArmRefusal<Arms[number]> : never

/**
 * Whether a rule may read a derived relation over the definition Q: `true`, or its arms' refusals (RuleRead). Its check
 * is unboxed, as DefinitionShape's are.
 */
export type RuleReadOf<Q> = ArmsRefusals<Q> extends never ? true : ArmsRefusals<Q>

/** A derived relation a rule may read: one whose definition joins, selects and projects (RuleRead). */
export type RuleReadDerived = AnyDerived & RuleRead<true>

/**
 * Derived relations: named queries, kept in tables where the installation infers them stored. The runtime constructor is
 * packages/engine/src/schema's, bound to this signature by the public schema barrel.
 *
 * A derived relation's kind is "derived": a key's, a check's and a containment's side may read it (a rule over its
 * definition), every other statement takes ordinary relations alone, and WritableOf excludes it from ChangeSet members. Its keys are the keys its definition's evidence proves (KeysOf, ../schema/schema.ts), and
 * schema.extend accepts it only over a level below the extension that declares it, because Query is invariant in its
 * schema (../schema/schema.ts DerivedAt).
 *
 * Its fields are its definition's heading, the record of carriers v mints variables over: each head term's column and
 * SQL type, a variable's its field's own, contract included, an aggregate's or a computed term's its result's. A view
 * column is a plain column of its type. The compiler's inference
 * (analysis/derived) of each column's descriptor is exact, and the snapshot records it. Its facts are decoded by
 * `fact`, the record of those carriers (schema/record.ts record), as a relation's are by its fields'.
 *
 * The fields are a phantom, its definition's heading, which RelationFieldsOf reads; the heading is a real member too,
 * which v mints variables over, and `fact` decodes the facts of that heading.
 *
 * Its type holds what is read of its definition, V (DefinitionView), read once where the relation is made, and never
 * the definition's query: a query holds the level it is over whole, every relation of it, and the checker instantiates
 * a type's every argument again wherever a type holding it is instantiated, a level's record of relations among them,
 * so a level of n derived relations over a base of m relations cost n × m wherever its type was read again (a
 * parameter of `ReturnType<typeof levelOf>`: TS2589 at edullm's DeliveryLevel, a Delivery over 711 relations). The
 * definition is still the relation's value, a query of its heading (test/types/schema/budget/levels).
 */
export interface Derived<Name extends string, V extends AnyDefinitionView>
	extends
		AnyDerived,
		Phantom<{
			readonly fields: V["heading"]
			readonly evidence: V["evidence"]
			readonly level: V["level"]
		}>,
		RuleRead<V["ruleRead"]> {
	readonly kind: "derived"
	readonly name: Name
	readonly definition: QueryBase & Headed<V["heading"]>
	readonly heading: V["heading"]
	readonly fact: RowDecoder<FactOfFields<V["heading"]>>
}

/**
 * What a derived relation's type holds of its definition (Derived): its heading of carriers H, its keys K, a union of
 * each key's fields (schema.ts OwnKeysOf reads them), whether a rule may read it RR (RuleReadOf), and the level it is
 * over Lv, told by its kind and name (LevelKeyOf), against which schema.extend reads it as a relation of a level of its
 * base (schema.ts DerivedAt). Each is read off the definition where the relation is made (DerivedConstructor).
 *
 * Every part is a type of its own, evaluated where the relation is made and holding nothing of the query: never a type
 * an alias makes over the query (ViewOf<Q> = DefinitionView<…>, a reference the checker defers with Q in its mapper, or
 * any alias instance, which keeps Q in its arguments), never a part bound by `Q extends Phantom<infer B>` or matched
 * against the query whole (a match instantiates it, its level with it), but each read off the query's phantom by key
 * (PhantomOf) and passed here as its own argument, DerivedConstructor naming the view inline. A part that keeps the
 * query keeps the whole level below, and every instantiation of a level of n such relations walks that level n times.
 */
export interface DefinitionView<out H extends Carriers, out K, out RR, out Lv> {
	readonly heading: H
	readonly evidence: { readonly keys: ReadonlyArray<K> }
	readonly ruleRead: RR
	readonly level: Lv
}

/** Any definition's view. */
export type AnyDefinitionView = DefinitionView<Carriers, unknown, unknown, unknown>

/** The keys a definition Q's evidence proves, each one key's fields, read off its phantom by key. */
export type DefinitionKeys<Q> = EvidenceKeys<PhantomOf<Q>["evidence" & keyof PhantomOf<Q>]>
type EvidenceKeys<Ev> = Ev["keys" & keyof Ev] extends ReadonlyArray<infer K> ? K : never

/** The level a definition Q is over (LevelKeyOf), its schema S read off its phantom's Invariant<S>. */
export type DefinitionLevel<Q> = SchemaLevel<PhantomOf<Q>["schema" & keyof PhantomOf<Q>]>
type SchemaLevel<I> = I extends Invariant<infer S> ? LevelKeyOf<S> : never

/** Whether the definition Q reads no parameter, decided off its parameters alone, never by a test of Q. */
type ReadsNoParams<Q> = keyof ParamsOf<Q> extends never ? true : false

/** The definition reads no parameter. */
export type NoParams<Q> = ReadsNoParams<Q> extends true ? Q : never

/** The fields of every arm of a union head, against the fields common to all of them. */
type AnyKeyOf<H> = H extends unknown ? keyof H : never

/**
 * The refusal a view's definition carries: none for a parameterless query of one heading with at least one field. A
 * stored table holds one heading, since arms of different headings would be several heading groups; arms that differ only in
 * a literal discriminant's value share their fields and are one heading. A role's query entry is checked by it too
 * (types/schema/world.ts).
 *
 * No check's subject is a naked type parameter, so none distributes and none is boxed in a tuple: a boxed check of a
 * definition costs the checker instantiations that grow with the schema the definition reads.
 */
export type DefinitionShape<Q> =
	ReadsNoParams<Q> extends false
		? never
		: keyof HeadOf<Q> extends never
			? Refusal<"a derived definition has at least one field">
			: AnyKeyOf<HeadOf<Q>> extends keyof HeadOf<Q>
				? unknown
				: Refusal<"a derived definition has one heading: a stored table holds one heading group">

/**
 * The refusal a derived definition carries: a view's (DefinitionShape), and any context it reads, since no session's
 * claims stand at the COMMIT that keeps a stored relation. Its check is unboxed, as DefinitionShape's are.
 */
export type DefinitionCheck<Q> =
	ContextsOf<Q> extends never
		? DefinitionShape<Q>
		: Refusal<"a derived definition reads no context: no session's claims stand at the COMMIT that keeps it">

/**
 * A definition Q as derived takes it, refused where DefinitionCheck refuses it. An alias of its own, so the checker reads a
 * signature's definition as another's by the alias's argument: derived's view (public/schema.ts) is checked against
 * DerivedConstructor with Q the one definition, never the definition intersected with its own check.
 */
export type CheckedDefinition<Q> = Q & DefinitionCheck<Q>

/**
 * A derived relation is a named query: fields from the query's head, keys from its evidence. It is declared in an
 * extension of the schema its definition reads. Where its rows live is never its declaration's: the installation keeps
 * it equal to its definition at every COMMIT in a table of its own where its definition is unit-local within one
 * declared unit, and reads its definition everywhere else (analysis/derived/storage.ts).
 */
export type DerivedConstructor = <const Name extends string, Q extends DefinitionQuery>(
	name: RelationName<Name>,
	definition: CheckedDefinition<Q>
) => Derived<
	Name,
	DefinitionView<Q["heading"], DefinitionKeys<Q>, RuleReadOf<Q>, DefinitionLevel<Q>>
>
