import type { FieldHost } from "#compiler/core/decoder.ts"
import type { Built, delta, Phantom, phantom } from "#compiler/core/phantom.ts"
import type {
	ComputedOrigin,
	ConstantOrigin,
	HeldAt,
	InputOrigin,
	Invariant,
	IsOneLiteral,
	IsInputValue,
	Literal,
	LiteralOrigin,
	Origin,
	OriginOfTerm,
	ParamOrigin,
	ParamsOfTerm,
	Refusal,
	SourceOrigin,
	RosterKeysOf,
	TermBase,
	TypeOfTerm,
	UnionToIntersection,
	ValueOfTerm
} from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { FieldBase, GeneratedField } from "#compiler/types/fields/field.ts"
import type { Aggregate, Producer, ResultOf } from "#compiler/types/query/terms.ts"
import type { AnyClosed, AnyRelation, HeadingOf, NameOf } from "#compiler/types/schema/relation.ts"
import type { ContainmentsOf, DeclaredKeysOfAll, OwnKeysOf } from "#compiler/types/schema/schema.ts"
import type { Containment, Side } from "#compiler/types/schema/statements.ts"
import type { AnyContext, AnyWorld } from "#compiler/types/schema/world.ts"

type Card = "many" | "atMostOne" | "one"

/**
 * Evidence: the keys and cardinality TypeScript can prove about a query relative to its inputs, and the claims an
 * attachment's stated delivery makes of its child (DeliveryClaim). This is an approximation; the IR proof stays
 * authoritative (analysis/logical), and a stated delivery is bound against the delivery the IR computes for the
 * attachment (logical/attach.ts), so the two read the same proofs.
 *
 * An origin names one variable of its rule, the field of one scope (core/phantom.ts Origin), so a variable's origin is
 * its identity, a self-join's two scopes included, and the type level reads the engine's key rule (HeadKeys): each
 * match states that a key of its relation determines every variable it binds, a filter's equality with an input fixes
 * its variable and one between two variables makes each determine the other (Stating), a computation is determined by
 * the variables it reads (Needs), and a set of head fields is a key when the variables it holds, with the inputs and
 * the fixed variables, determine every head term. A key's variables may be bound through other matches, so a
 * projection keeps a key through a join. From that and the head's shape:
 *
 * - a plain head is keyed by its whole heading, which a set always is, and by every key HeadKeys proves; the empty key,
 *   a pinned head, is atMostOne, and anything else many;
 * - a union of arms of one heading is atMostOne when every arm fixes every field to one value, and keyed by each arm's
 *   keys joined with the field the engine keeps of those the arms fix to different literals (UnionEvidence);
 * - an aggregate head is keyed by its group terms and every key within them; with the empty key it is atMostOne;
 * - a producer in the head yields zero or more facts per binding, so the head is many.
 *
 * Exactly one (which licenses the bare child) is proved inside attach in two ways, the two rows of the attach table:
 *
 * - a containment (ContainmentProof): the child's only clause is a match of a stored or closed relation whose
 *   parent-bound fields are exactly a declared key of it, each bound to the parent variable whose origin is the
 *   matching field of a declared `contained`'s source, in order, all of one scope, and every other binding a fresh
 *   variable at its own field, so nothing filters the match. Composite keys and ordinary relations included;
 * - a reflexive self-match (ReflexiveProof): the child is an aggregate grouped only by parent variables over one
 *   match of the relation the parent's fact was read from, every parent variable it reads of one scope, whose filters
 *   that very fact satisfies, so its group is never empty.
 *
 * A parent's origins are kept per scope, and a scope's are fields of one fact (terms.ts HeadOrigins), so each proof
 * reads the origins of one scope: over a self-join parent, the fields of each scope prove what that scope's fact
 * proves, and no proof joins a field of one scope with a field of the other.
 *
 * The query type serves Db's reads, which may rely on lawful committed snapshots. A read inside a write transaction, a
 * read-back (changes.read), uses immediate evidence only. Of the two proofs, only a containment that is not immediate
 * differs: a containment into a roster is its domain's, and one into a closed relation a table CHECK, both immediate;
 * every other containment lowers to a foreign key, which may be deferred and so false before COMMIT. A read-back reads a stated one child as an Option whatever the proof (query.ts
 * ReadBack), which is at most one child under either reading, so the evidence carries the snapshot card alone.
 *
 * Anything else widens. A wider type is sound only where the runtime value has the same representation, so a proof
 * the IR makes is one these types make too, and the agreement is tested (test/types/evidence).
 */
export type Evidence = {
	/** The key sets of a known evidence, or unknown where no key is known. */
	readonly keys: unknown
	readonly card: Card
	/**
	 * Where each head field came from, where that is known: the relation field a variable was matched at, or the
	 * parameter a head alone uses (OriginMap). attach mints its parent variables from it, so a child's evidence can
	 * read the parent's fields, and a ChangeSet types a head-only parameter at the field its member writes.
	 */
	readonly origins?: OriginMap
	/**
	 * Each head field's value where the rule fixes it per binding and the types name it (HeadValues), which a union reads
	 * (UnionEvidence): absent where there is none.
	 */
	readonly values?: ValueMap
}

/** Each head field's provenance: a witnessed variable origin. */
type OriginMap = { readonly [field: string]: Origin }
/** Each head field's value per binding: one literal, a parameter by name, or a parent's field (Fixed). */
type ValueMap = { readonly [field: string]: unknown }
export type OriginsOf<Ev> = Ev extends { readonly origins: infer O } ? O : unknown
/**
 * What a site that infers an evidence requires of it: an evidence's required members, its keys and its card, never its
 * optional ones. Every evidence grizzle's types build is an Evidence; an inferred type parameter is compared with its
 * constraint at every call, and Evidence's optional members would have the checker read the evidence whole there, every
 * head field's origin among them (types/query/terms.ts HeadOrigins), at every rule a query writes, where an origin is
 * read only by what reads it (an attachment's parent variables, a delivery's claim, a take). It is a supertype of
 * Evidence that every type reference requiring an Evidence admits, so a type a caller writes is held to Evidence whole.
 */
export type InferredEvidence = { readonly keys: unknown; readonly card: Card }

export declare namespace Evidence {
	/** What the type level falls back to when it cannot decide. */
	type Unknown = { readonly keys: unknown; readonly card: "many" }
	/**
	 * A set of many facts keyed by its whole heading Row and by nothing narrower: a recursion's fixed point, which its
	 * UNION deduplicates as complete states, as the engine keys a Recursive node (logical/props.ts: none beyond the whole
	 * heading, a set), so a fold may read it matched at every field, and a derived relation over it is keyed so.
	 */
	type Set<Row> = { readonly keys: readonly [KeyOver<keyof Row & string>]; readonly card: "many" }
}

/** A key over exactly the field names in K. Field order is immaterial to a key, so a key is the union of its names. */
type KeyOver<K extends string> = ReadonlyArray<K>

/**
 * What an attachment's stated delivery K claims of its child, whose evidence is ChildEv: unknown when the evidence
 * proves it, a Refusal otherwise. Every child may be delivered as an array; an Option needs a child proved at most one
 * per parent, and the one child a child proved exactly one, card "one" including an aggregate child whose group a
 * reflexive self-match on parent-bound variables proves nonempty.
 */
export type DeliveryClaim<K, ChildEv> = Claims<ChildEv>[K & keyof Claims<ChildEv>]

interface Claims<ChildEv> {
	readonly array: unknown
	readonly option: ChildEv extends { readonly card: "atMostOne" | "one" }
		? unknown
		: Refusal<"an Option needs a child the evidence proves at most one per parent">
	readonly one: ChildEv extends { readonly card: "one" }
		? unknown
		: Refusal<"the one child needs a child the evidence proves exactly one per parent">
}

/** The key of origin (R, F, N), `relation.scope.field`: the one variable of its rule it names. */
export type ScopedKey<R extends string, F extends string, N extends string> = `${R}.${N}.${F}`

/**
 * The key of a variable of a source that is no relation (SourceOrigin), `:scope.field`: no relation's name begins with
 * a colon, so it is no ScopedKey, and a rule holds one scope of each name, so it names one variable of its rule.
 */
type SourceKey<F extends string, N extends string> = `:${N}.${F}`

/** The key of a variable's origin (ScopedKey, SourceKey); never for an input or a computed term. */
type OriginKey<X> =
	X extends Phantom<{ readonly origin: infer O }>
		? [O] extends [InputOrigin]
			? never
			: O extends Origin<infer R, infer F, infer N>
				? ScopedKey<R, F, N>
				: O extends SourceOrigin<infer F, infer N>
					? SourceKey<F, N>
					: never
		: never

/**
 * The matches whose fact holds the variable of origin O: the places, among a rule's occurrences, of the matches of O's
 * relation that bind it at its own field. The engine's provenance of a column bound at a scan names that scan
 * (logical/props.ts provenanceOf), so variables with a holding match in common are fields of that match's one fact.
 */
export type HoldingMatches<Os extends ReadonlyArray<unknown>, O> =
	O extends Origin<infer R, infer F, infer N>
		? {
				[I in keyof Os & `${number}`]-?: BindsAt<Os[I], R, F, ScopedKey<R, F, N>> extends true
					? I
					: never
			}[keyof Os & `${number}`]
		: never

/**
 * Whether a match is of relation R and binds the variable of origin key Key at R's field F: a match of a named source
 * (NamedShown) of R's name. A generic relation's name is the union of its relations' names, which no match tells apart
 * from another generic relation's, so a variable of one is held by no match.
 */
type BindsAt<M, R, F, Key> =
	M extends SoleMatch<infer Sh, infer B>
		? Sh extends NamedShown
			? [R] extends [UnionToIntersection<R> & Sh["name"]]
				? F extends keyof B
					? Key extends OriginKey<B[F]>
						? true
						: false
					: false
				: false
			: false
		: false

/**
 * What determines a term, by origin key, once the rule's filters are read: nothing for an input (a literal, a
 * parameter, a parent variable, a handle) or a variable whose origin the rule fixes to an input (FixedFields); a
 * variable's own origin key; and what a computation's operands need (ComputedOrigin), a span producer's among them,
 * but the fixed ones. Lost for a term of
 * unknown origin, which nothing the rule states determines, and for a binding that may be absent. The engine reads the
 * same (logical/props.ts): a scan's column bound to a computation follows from the variables it reads, a projection's
 * computed output from the columns it reads, and an equality with a value that reads no column fixes its column.
 */
type Needs<X, FixedFields extends string> = X extends TermBase | Producer<unknown, never>
	? OriginNeeds<OriginOfTerm<X>, FixedFields>
	: X extends undefined
		? Lost
		: never

type OriginNeeds<O, FixedFields extends string> = unknown extends O
	? Lost
	: O extends InputOrigin
		? never
		: O extends ComputedOrigin<infer Operands>
			? OriginNeeds<Operands, FixedFields>
			: O extends Origin<infer R, infer F, infer N>
				? Exclude<ScopedKey<R, F, N>, FixedFields>
				: O extends SourceOrigin<infer F, infer N>
					? Exclude<SourceKey<F, N>, FixedFields>
					: Lost
/** Whether a term's needs lie within the origins Known: never for an input, false for Lost. */
type DeterminedBy<Need, Known> = Lost extends Need ? false : [Need] extends [Known] ? true : false

/**
 * What a filter states of the rule's variables whatever value it has, as the engine's filter does (logical/props.ts
 * filterDependencies): an equality between a variable and a value fixed per binding (an input, or a computation over
 * inputs alone) fixes the variable, `r.eq(account, r.param("account"))` as a match binding account to the parameter
 * would (Fixed); and one between two variables makes each determine the other (a Dep each way). A predicate records its
 * statements as a phantom (Stating); where collects them, a conjunction passes its conjuncts' on, and anything else
 * states nothing. The statements are carried contravariantly: a predicate that states more is the narrower type, so
 * where TypeScript reduces a union of predicates to its widest members (a conditional's branches) it keeps the one that
 * states less, which is what holds whichever branch runs.
 */
export interface Stating<in Statements> extends Built {
	readonly [phantom]?: { readonly states: (stated: Statements) => void } | undefined
}

/**
 * A variable, by origin key, fixed per binding to Value: one literal, a parameter by name (ParamValue), a parent's field
 * by its origin (ParentValue), or unknown, a value the types do not name, such as a computation over inputs.
 */
interface Fixed<out Key extends string, out Value> {
	readonly fixed: Key
	readonly value: Value
}

interface ParamValue<out Name> {
	readonly param: Name
}

interface ParentValue<out O> {
	readonly parent: O
}

/** What r.eq(a, b) states: the variable side fixed when the other needs nothing determined, else two variables equal. */
export type EqualityStates<A, B> = [Needs<B, never>] extends [never]
	? FixedTo<OriginKey<A>, ValueOf<B>>
	: [Needs<A, never>] extends [never]
		? FixedTo<OriginKey<B>, ValueOf<A>>
		: Equal<OriginKey<A>, OriginKey<B>>
type FixedTo<K, V> = [K] extends [never] ? never : Fixed<K & string, V>

/**
 * A variable, by origin key, whose values a filter restricts to Values: a roster term r.in or Logic.in holds to some of
 * its handles, as the engine's WHERE holds it, so the head that finds the variable finds those handles alone (FoundOf).
 */
interface Restricted<out Key extends string, out Values> {
	readonly restricted: Key
	readonly values: Values
}

/**
 * What a membership test of A in Members states: a roster variable restricted to the handles Members lists, its values
 * the handles of its type among them; nothing of any other term, whose values no list of literals bounds as a type does.
 */
export type MembershipStates<A, Members> = [RosterKeysOf<TypeOfTerm<A>>] extends [never]
	? never
	: [OriginKey<A>] extends [never]
		? never
		: Restricted<OriginKey<A> & string, Extract<ValueOfTerm<A>, Members>>
type Equal<A, B> = [A] extends [never]
	? never
	: [B] extends [never]
		? never
		: Dep<A & string, B & string> | Dep<B & string, A & string>

/**
 * The value an input or a JavaScript value fixes a variable to, where the types name it: a constant's own value, from
 * its column.
 */
type ValueOf<X> = X extends TermBase
	? [OriginOfTerm<X>] extends [ParamOrigin]
		? ParamValue<keyof ParamsOfTerm<X>>
		: [OriginOfTerm<X>] extends [ConstantOrigin | LiteralOrigin]
			? OneValue<ValueOfTerm<X>>
			: [ParentOriginOf<X>] extends [never]
				? unknown
				: ParentValue<ParentOriginOf<X>>
	: OneValue<X>

/** V when it is one literal, unknown otherwise. */
type OneValue<V> = [V] extends [never]
	? unknown
	: [V] extends [UnionToIntersection<V>]
		? V extends Literal
			? string extends V
				? unknown
				: number extends V
					? unknown
					: bigint extends V
						? unknown
						: V
			: unknown
		: unknown
type StatesOfEach<X> =
	X extends Phantom<{ readonly states: (stated: infer St) => void }> ? St : never
type FixedKeys<St> = St extends Fixed<infer K, unknown> ? K : never
type EqualitiesOf<St> = St extends Dep<string, string> ? St : never
/**
 * What a predicate states whatever value it has: over a union of predicates, `flag ? r.eq(a, p) : r.eq(b, q)`, only what
 * every member states, since either may be the one that runs: a variable every member fixes, to the names they share or
 * to unknown, and an equality every member states.
 */
type MustState<X> = MustFix<X> | MustEqual<X> | MustRestrict<X>
type MustFix<X> = [FixedKeys<StatesOfEach<X>>] extends [infer All extends string]
	? All extends unknown
		? false extends (
				X extends unknown ? (All extends FixedKeys<StatesOfEach<X>> ? true : false) : never
			)
			? never
			: Fixed<All, OrUnknown<SharedNames<X, All>>>
		: never
	: never
/**
 * The names every member of a union of predicates X fixes the variable K to: each name some member fixes it to, kept
 * where every member fixes it to that name too. Names are compared as values, a literal, a parameter or a parent's
 * field, so a literal one member names and a parameter another names are no name they share.
 */
type SharedNames<X, K> = SharedAmong<X, AnyMemberNames<X, K>, K>
type AnyMemberNames<X, K> = X extends unknown ? NamedValues<StatesOfEach<X>, K> : never
type SharedAmong<X, N, K> = N extends unknown
	? false extends (
			X extends unknown ? (N extends NamedValues<StatesOfEach<X>, K> ? true : false) : never
		)
		? never
		: N
	: never
type OrUnknown<V> = [V] extends [never] ? unknown : V
type RestrictedKeys<St> = St extends Restricted<infer K, unknown> ? K : never
/**
 * The values every statement of St that restricts one of the variables Ks restricts it to: their intersection, each
 * restriction holding at once, as the WHERE's conjuncts do; never where none restricts one.
 */
type RestrictedTo<St, Ks> = [RestrictedSets<St, Ks>] extends [never]
	? never
	: UnionToIntersection<RestrictedSets<St, Ks>> extends { readonly restricted: infer V }
		? V
		: never
type RestrictedSets<St, Ks> =
	St extends Restricted<infer K, infer V>
		? K extends Ks
			? { readonly restricted: V }
			: never
		: never
/**
 * What a union of predicates restricts whatever member runs (MustState): each variable every member restricts, to the
 * values any of them restricts it to.
 */
type MustRestrict<X> = [RestrictedKeys<StatesOfEach<X>>] extends [infer All extends string]
	? All extends unknown
		? false extends (
				X extends unknown ? (All extends RestrictedKeys<StatesOfEach<X>> ? true : false) : never
			)
			? never
			: Restricted<All, X extends unknown ? RestrictedTo<StatesOfEach<X>, All> : never>
		: never
	: never
type MustEqual<X> = [EqualitiesOf<StatesOfEach<X>>] extends [infer All]
	? All extends unknown
		? false extends (
				X extends unknown ? (All extends EqualitiesOf<StatesOfEach<X>> ? true : false) : never
			)
			? never
			: All
		: never
	: never

/**
 * What a tuple of predicates states: the union of each position's. Only tuple positions count: a spread array of
 * unknown length, `where(...preds)`, may be empty at run time and states nothing.
 */
export type StatesOf<Ps> = Ps extends readonly [infer H, ...infer Rest]
	? MustState<H> | StatesOf<Rest>
	: never
/** The origins the statements fix, and the dependencies they state: a fixed variable is determined by nothing. */
type FixedBy<St> = St extends Fixed<infer K, unknown> ? K : never
type StatedDeps<St> = St extends Fixed<infer K, unknown> ? Dep<never, K> : EqualitiesOf<St>

type IsSingle<U> = [U] extends [never]
	? false
	: [UnionToIntersection<U>] extends [never]
		? false
		: true

type AggregateFields<H> = {
	[K in keyof H]-?: H[K] extends Aggregate<unknown, never> ? K : never
}[keyof H]
type ProducerFields<H> = {
	[K in keyof H]-?: H[K] extends Producer<unknown, never> ? K : never
}[keyof H]
/**
 * What a child's clauses prove beyond its keys (Rule.find): whether a containment proves it, true or never
 * (ContainmentProof), and whether a reflexive self-match proves a nonempty group (ReflexiveProof).
 */
export interface Proofs<out Contained extends true, out Reflexive extends boolean> {
	readonly contained: Contained
	readonly reflexive: Reflexive
}
type NoProofs = Proofs<never, false>

/**
 * The evidence of a finished head H over a rule whose head fields have the origins O and the values V (HeadValues),
 * whose clauses prove Pr, and whose keys are Keys (HeadKeys: each a union of head field names, wrapped as
 * `readonly [Fields]`, the empty one when the head is pinned); what its bindings prove of the head, B (RuleBindings),
 * whether it is pinned and a producer's card.
 */
export type EvidenceOf<
	H,
	Keys,
	V,
	O = unknown,
	Pr extends Proofs<true, boolean> = NoProofs,
	B extends RuleBindings<boolean, Card> = RuleBindings<
		IsPinned<Keys> extends true ? true : never,
		H[ProducerFields<H>] extends { readonly produces: "intersection" | "span" } ? never : "many"
	>
> = [ProducerFields<H>] extends [never]
	? [AggregateFields<H>] extends [never]
		? PlainEvidence<
				[Keys] extends [never]
					? readonly [KeyOver<keyof H & string>]
					: readonly [KeyOver<keyof H & string>, ...ReadonlyArray<KeyOf<Keys>>],
				B["pinned"],
				O,
				Pr
			> &
				ValuesPart<V>
		: GroupedEvidence<
				Exclude<keyof H, AggregateFields<H> | ConstantFields<H>>,
				Keys,
				B["pinned"],
				O,
				Pr
			> &
				ValuesPart<V>
	: {
			readonly keys: readonly [KeyOver<keyof H & string>]
			readonly card: B["card"]
			readonly origins: O
		}

/**
 * What a rule's bindings prove of its head: whether the head is pinned, by what the rule's filters state or by each
 * reading of a flagged filter (PinnedOrSplit), and, for a producer's head, its card (ProducedCard). The rule reads both
 * off its schema where it finds its head (types/query/rule.ts FinishedHead), so the evidence holds no schema: the checker
 * walks a type whole each time it instantiates it, and a schema holds every relation and each relation's field record.
 */
export interface RuleBindings<out Pinned extends boolean, out Produced extends Card> {
	readonly pinned: Pinned
	readonly card: Produced
}

/**
 * RuleBindings over what a rule's bindings prove alone. An alias over an interface is a reference the checker resolves
 * later, holding the alias's arguments: this one holds the two proofs and never the schema they were read off.
 */
export type BindingsProved<Pinned extends boolean, Produced extends Card> = RuleBindings<
	Pinned,
	Produced
>

/** Proofs over what a rule's clauses prove alone, never the schema they were read off (BindingsProved). */
export type ProofsOf<Contained extends true, Reflexive extends boolean> = Proofs<
	Contained,
	Reflexive
>

/**
 * A filter that is one of several predicates, either of which may run, `flag ? r.eq(a, p) : r.eq(b, q)`: what each
 * reading states (Reading), beside what all of them state, which the rule's statements hold already (MustState).
 */
export interface Split<out Readings> {
	readonly readings: Readings
}
export interface Reading<out Statements> {
	readonly states: Statements
}

/**
 * Whether the head H, of keys Keys, is pinned, at most one row per binding, by the bindings of a rule over S: its
 * occurrences Os, what its filters state St, and its filters that are each one of several predicates (Sp, each a
 * Split). Pinned by what the rule's filters state, or, a proof by cases, by each reading of some one flagged filter,
 * every other filter at what all its readings state. That is one key derivation per reading of each flagged filter,
 * linear in them; a proof over several flagged filters read at once would multiply them, and is not made.
 */
export type PinnedOrSplit<S, Keys, H, Os, St, Sp> =
	IsPinned<Keys> extends true ? true : true extends PinnedBySplit<S, Os, H, St, Sp> ? true : false
type PinnedBySplit<S, Os, H, St, Sp> =
	Sp extends Split<infer Rd> ? (false extends ReadingPins<S, Os, H, St, Rd> ? false : true) : never
type ReadingPins<S, Os, H, St, Rd> =
	Rd extends Reading<infer RS> ? IsPinned<HeadKeys<S, Os, H, St | RS>> : never

/**
 * A producer yields its facts per binding of its rule, the rule's whole region, which no projection onto the head
 * narrows (check/checker.ts #produceNode): an intersection and a span from its ends at most one per binding, so at most
 * one where every variable the rule binds is pinned (RegionHead); a difference up to two and a pack any number
 * (ir/rel.ts piecesPerBinding). A head that produces nothing reads no card here (EvidenceOf).
 */
export type ProducedCard<S, H, Os, St> = [ProducerFields<H>] extends [never]
	? "many"
	: H[ProducerFields<H>] extends { readonly produces: "intersection" | "span" }
		? IsPinned<HeadKeys<S, Os, RegionHead<Os>, St>> extends true
			? "atMostOne"
			: "many"
		: "many"

/** A head of one field holding every term the rule's matches bind, pinned exactly where all of them are. */
interface RegionHead<Os> {
	readonly region: Os extends ReadonlyArray<infer M>
		? M extends SoleMatch<unknown, infer B>
			? B[keyof B]
			: never
		: never
}

/** The values an evidence carries, as the part of the evidence that keeps them: absent where it carries none. */
type ValuesPart<V> = [keyof V] extends [never] ? unknown : { readonly values: V }

/**
 * The record a find over head H decodes to (types/query/terms.ts ResultOf) where its rule's filters state Stated: each
 * field's host value, a roster term the filters restrict to some of its handles (Restricted) found as those handles
 * alone, the variable's and every variable an equality makes it equal to (Closure), by the rule the WHERE holds them by.
 */
export type FoundOf<H, Stated> = [RestrictedKeys<Stated>] extends [never]
	? ResultOf<H>
	: { readonly [K in keyof H]: FoundAt<FieldHost<H[K]>, H[K], Stated> }
type FoundAt<V, X, St> = [OriginKey<X>] extends [never]
	? V
	: [RestrictedTo<St, Closure<EqualitiesOf<St>, OriginKey<X> & string>>] extends [never]
		? V
		: Extract<V, RestrictedTo<St, Closure<EqualitiesOf<St>, OriginKey<X> & string>>>

/**
 * Each head field's values where the rule fixes it per binding and the types name it, as a union of its names: a
 * constant's own value, from its column; a parameter's by name; a parent variable's field; and every value the rule's
 * filters fix its variable to, directly or through equalities (Stated), which are one value wherever the rule has a row,
 * so each names it, in any order the filters are written. The engine reads a fixed column's names the same way
 * (logical/props.ts fixedNames), which a union compares across its arms.
 */
export type HeadValues<H, Stated> = {
	readonly [K in keyof H as [ValueAt<H[K], Stated>] extends [never] ? never : K]: ValueAt<
		H[K],
		Stated
	>
}

/** The names of a head term's value: none, never, where the types name none. */
type ValueAt<X, St> = X extends TermBase
	? [OriginOfTerm<X>] extends [ParamOrigin]
		? ParamValue<keyof ParamsOfTerm<X>>
		: [OriginOfTerm<X>] extends [ConstantOrigin | LiteralOrigin]
			? Named<OneValue<ValueOfTerm<X>>>
			: [ParentOriginOf<X>] extends [never]
				? [OriginKey<X>] extends [never]
					? never
					: NamedValues<St, Closure<EqualitiesOf<St>, OriginKey<X>>>
				: ParentValue<ParentOriginOf<X>>
	: never
/** A value the types name, never for unknown. */
type Named<V> = unknown extends V ? never : V
/** Every value the statements St fix one of the variables K to that the types name. */
type NamedValues<St, K> = St extends Fixed<K & string, infer V> ? Named<V> : never

/**
 * The evidence of a union of an arm or union of evidence Ev1 and heading H1 with an arm of evidence Ev2 and heading H2,
 * as the engine reads a union (logical/props.ts unionProps): a field every arm fixes to one value is fixed in the
 * union, so the fields the arms do not all fix alike are a key of it, the empty one, at most one row per binding, where
 * every field is fixed; and a key of each arm, joined with the separators the engine keeps (Kept), which tell every two
 * arms' rows apart, is a key of the union. The union reads every arm at once, as the engine does, so it carries its
 * arms (UnionArm). Arms of different headings, whose rows are of several heading groups, are evidence unknown: so is a
 * union whose earlier arms are, read by each record of H1 (HeadingsApart).
 *
 * A further arm costs what it adds, never what the arms before it cost again: it adds its values to the arms' values,
 * a union of their records written where it is made, and its arm to the union's arms, a tuple in their order, and the
 * union's keys and the fields its arms fix alike, which every arm at once decides, are read where they are read
 * (UnionEvidenceOf), so a union of n arms reads its arms once, where a union read its every earlier arm again at each
 * arm, every pair of them for its separators. Neither is made by an alias of its own over the union before it: a type
 * an alias makes keeps the alias and its arguments, and the checker instantiates them with it, so values an alias
 * united over the evidence before them, or arms an alias consed onto the arms before them, reached back through every
 * union before it at each arm, one more for each (TS2589 at 96 arms, metis's reconciliation split in two to stay below
 * it); and the fields fixed alike are met over every arm at once, where they were met one arm at a time.
 */
export type UnionEvidence<Ev1, Ev2, H1, H2> =
	HeadingsApart<Ev1, H1, H2> extends true
		? Evidence.Unknown
		: ArmsBefore<Ev1> extends infer Before extends ReadonlyArray<AnyArm>
			? UnionEvidenceOf<
					FirstValuesOf<Ev1>,
					ValuesBefore<Ev1> | ValuesOf<Ev2>,
					keyof H2 & string,
					readonly [...Before, ArmOf<Ev2>]
				>
			: never
type ValuesOf<Ev> = Ev extends { readonly values: infer V } ? V : object
/** The values the first arm of Ev1, an arm or a union, fixes its fields to: a union's own first, read by key. */
type FirstValuesOf<Ev1> = "arms" extends keyof Ev1 ? Ev1["first" & keyof Ev1] : ValuesOf<Ev1>
/** Every arm's values of Ev1, an arm or a union: a union's own, read by key, a union of the arms' records. */
type ValuesBefore<Ev1> = "arms" extends keyof Ev1 ? Ev1["armValues" & keyof Ev1] : ValuesOf<Ev1>
/** The arms of Ev1, an arm or a union, in order: a union's own, read by key. */
type ArmsBefore<Ev1> = "arms" extends keyof Ev1 ? Ev1["arms" & keyof Ev1] : readonly [ArmOf<Ev1>]
/**
 * Whether some record of H1 and some record of H2 have different keys: a union's records all have its heading's,
 * keyof H1, so a union is read by its heading once, and any other H1 by each of its records.
 */
type HeadingsApart<Ev1, H1, H2> = "arms" extends keyof Ev1
	? false extends (H2 extends unknown ? SameValue<keyof H1, keyof H2> : never)
		? true
		: false
	: false extends (
				H1 extends unknown ? (H2 extends unknown ? SameValue<keyof H1, keyof H2> : never) : never
		  )
		? true
		: false
/** An evidence's keys, each a KeyOver, none where they are unknown. */
type KeyMembers<Ev> = Ev extends { readonly keys: infer K }
	? unknown extends K
		? never
		: K extends ReadonlyArray<infer E>
			? E
			: never
	: never

/** One arm of a union, as the union reads every arm at once: the values it fixes its fields to, and its keys. */
interface UnionArm<out V, out K> {
	readonly values: V
	readonly keys: K
}
type ArmOf<Ev> = ArmWith<ValuesOf<Ev>, KeyMembers<Ev>>
type ArmWith<V, K> = UnionArm<V, K>

/** Any arm of a union, whatever its values and keys. */
type AnyArm = UnionArm<unknown, unknown>
/** The values an arm X of a union's arms fixes its fields to, and its keys, each read off the arm's own type. */
type ArmValuesIn<X> = X extends AnyArm ? X["values"] : never
type ArmKeysIn<X> = X extends AnyArm ? X["keys"] : never

/**
 * The union's keys: its whole heading; the fields its arms do not all fix alike, since a union is a set whose rows agree
 * on the rest, the empty key where every field is; and the keys told apart. And its arms, its first arm's values and
 * every arm's (Alike), which a further arm reads by key. The keys are a member, decided where a reader reads them, every
 * arm at once, never at each arm a further rule adds.
 */
type UnionEvidenceOf<First, V, F extends string, Arms> = {
	readonly keys: UnionKeys<
		KeyOver<Exclude<F, keyof Alike<First, V>>> | KeysBeside<Arms, Kept<Arms, V>>,
		F
	>
	readonly card: [Exclude<F, keyof Alike<First, V>>] extends [never] ? "atMostOne" : "many"
	readonly arms: Arms
	readonly first: First
	readonly armValues: V
}
type UnionKeys<Keys, F extends string> = [Keys] extends [never]
	? readonly [KeyOver<F>]
	: readonly [KeyOver<F>, ...ReadonlyArray<Keys>]

/**
 * The fields every arm fixes to one value, a name they all share, with every name they share: the first arm's names,
 * First, each held at its field by every arm's values, V the union of the arms' records, read once over every arm.
 */
type Alike<First, V> = {
	readonly [
		K in keyof First & keyof V as [HeldByEvery<First[K], V, K>] extends [never] ? never : K
	]: HeldByEvery<First[K], V, K>
}
/** The names among X every arm of V fixes its field K to. */
type HeldByEvery<X, V, K extends PropertyKey> = X extends unknown
	? false extends (V extends unknown ? ([X] extends [V[K & keyof V]] ? true : false) : never)
		? never
		: X
	: never
type SameValue<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** The one literal an arm's values fix field K to: none where they fix it to no literal or to two, which no row holds. */
type LiteralAt<V, K> = K extends keyof V
	? IsSingle<Extract<V[K], Literal>> extends true
		? Extract<V[K], Literal>
		: never
	: never

/**
 * The separators of a union: the fields every arm fixes to one literal, as the engine reads them, V every arm's values
 * read at once.
 */
type SeparatorsOf<V> = {
	[K in keyof V & string]-?: true extends (
		V extends unknown ? ([LiteralAt<V, K>] extends [never] ? true : false) : never
	)
		? never
		: K
}[keyof V & string]

/**
 * The separators the engine keeps (logical/props.ts unionProps): of the separators in heading order, code unit order,
 * each dropped from the end while the rest still tell every two arms apart, none where they do not (Agree). Kept from
 * the last (Descending): a separator stays where the separators before it and those kept after it leave two arms that
 * agree on all of them.
 */
type Kept<Arms, V> = KeptIn<Arms, Descending<SeparatorsOf<V>, "", readonly []>>
type KeptIn<Arms, Ds extends ReadonlyArray<string>> =
	Agree<Arms, Ds> extends true ? never : KeptFrom<Arms, Ds, readonly []>
type KeptFrom<
	Arms,
	Ds extends ReadonlyArray<string>,
	K extends ReadonlyArray<string>
> = Ds extends readonly [infer C extends string, ...infer Rest extends ReadonlyArray<string>]
	? Agree<Arms, readonly [...Rest, ...K]> extends true
		? KeptFrom<Arms, Rest, readonly [...K, C]>
		: KeptFrom<Arms, Rest, K>
	: K[number]

/**
 * Whether two arms fix the separators Cs to the same literals: each arm's literals at them, a tuple in their order, met
 * against every other arm's tuple, the arms read once each in one mapped type over their tuple.
 */
type Agree<Arms, Cs extends ReadonlyArray<string>> = AgreeAmong<{
	readonly [I in keyof Arms]: LiteralsAt<ArmValuesIn<Arms[I]>, Cs>
}>
/** Whether two of the tuples Ts are one: each met against every other, at once. */
type AgreeAmong<Ts> = true extends {
	[I in keyof Ts]: [Ts[I]] extends [Ts[Exclude<PlacesOf<Ts>, I>]] ? true : false
}[PlacesOf<Ts>]
	? true
	: false
/** The places of a tuple, "0" to its last. */
type PlacesOf<Ts> = Exclude<keyof Ts, keyof ReadonlyArray<unknown>>
/** An arm's literals at the separators Cs, in their order. */
type LiteralsAt<V, Cs extends ReadonlyArray<string>> = {
	readonly [I in keyof Cs]: LiteralAt<V, Cs[I]>
}

/**
 * The declared names U, the last in code unit order first: by their first characters from the last, each group's longer
 * names before the one character alone, each name behind the prefix P its walk came down by. A walk of their
 * characters, linear in the names' length.
 */
type Descending<
	U extends string,
	P extends string,
	Done extends ReadonlyArray<string>
> = DescendingFrom<U, "zyxwvutsrqponmlkjihgfedcba_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210", Done, P>
type DescendingFrom<
	U extends string,
	Order extends string,
	Done extends ReadonlyArray<string>,
	P extends string
> = [U] extends [never]
	? Done
	: Order extends `${infer C}${infer Rest}`
		? Descending<
				Exclude<U extends `${C}${infer Tail}` ? Tail : never, "">,
				`${P}${C}`,
				Done
			> extends infer Longer extends ReadonlyArray<string>
			? DescendingFrom<
					Exclude<U, `${C}${string}`>,
					Rest,
					C extends U ? readonly [...Longer, `${P}${C}`] : Longer,
					P
				>
			: never
		: Done

/** One key of each arm, together, with the kept separators T: a key of the union, every such combination. */
type KeysBeside<Arms, T> = [T] extends [never]
	? never
	: CrossOf<{ readonly [I in keyof Arms]: ArmKeysIn<Arms[I]> }, readonly [never]> extends infer C
		? C extends readonly [infer F]
			? KeyOver<(F & string) | (T & string)>
			: never
		: never
/**
 * Every combination of one key of each arm, each the union of their fields, Ks each arm's keys in a tuple of their own,
 * read once each: a walk of the keys alone, which hold no arm, so binding the rest of them by `infer` instantiates no arm
 * again.
 */
type CrossOf<Ks, Done> = Ks extends readonly [infer K, ...infer Rest]
	? CrossOf<Rest, CrossWith<Done, K>>
	: Done
type CrossWith<Done, K> = Done extends readonly [infer G]
	? K extends ReadonlyArray<infer F>
		? readonly [F | G]
		: never
	: never

/** A wrapped key as the key over its fields. */
type KeyOf<K> = K extends readonly [infer F] ? KeyOver<F & string> : never
/** Whether the empty key is among the keys: the head has at most one row per input binding. */
type IsPinned<Keys> = [Extract<Keys, readonly [never]>] extends [never] ? false : true

/** A plain head: one where a containment proves it, an Option otherwise when pinned. */
type PlainEvidence<Keys, Pinned extends boolean, O, Pr> = Pinned extends true
	? Pr extends Proofs<infer C, boolean>
		? [C] extends [never]
			? { readonly keys: Keys; readonly card: "atMostOne"; readonly origins: O }
			: { readonly keys: Keys; readonly card: "one"; readonly origins: O }
		: never
	: { readonly keys: Keys; readonly card: "many"; readonly origins: O }

/**
 * The head fields that hold a constant, a JavaScript value, a typed constant or a parameter: beside an aggregate each is
 * added over the groups, never a group term, as the checker groups (check/checker.ts #grouped).
 */
type ConstantFields<H> = {
	[K in keyof H]-?: H[K] extends Phantom<{ readonly origin: infer O }>
		? [O] extends [ParamOrigin | ConstantOrigin | LiteralOrigin]
			? K
			: never
		: never
}[keyof H]

/**
 * An aggregate head is keyed by its group terms, its fields but its aggregates and constants (ConstantFields), and by
 * every key the rule proves within them; it is one row per parent
 * when a reflexive self-match proves its group nonempty and its group terms are all inputs, which ReflexiveProof
 * requires.
 */
type GroupedEvidence<G, Keys, Pinned extends boolean, O, Pr> = {
	readonly keys: [Beside<Keys, G>] extends [never]
		? readonly [KeyOver<G & string>]
		: readonly [KeyOver<G & string>, ...ReadonlyArray<KeyOf<Beside<Keys, G>>>]
	readonly card: Pr extends Proofs<true, true> ? "one" : Pinned extends true ? "atMostOne" : "many"
	readonly origins: O
}

/** The keys other than exactly G. */
type Beside<Keys, G> = Keys extends readonly [infer X]
	? [X] extends [G]
		? [G] extends [X]
			? never
			: Keys
		: Keys
	: never

/**
 * The keys a head proves over its rule's matches and the statements of its filters (Stated): the minimal sets of head
 * fields that determine every field of the head but its aggregates, each wrapped as `readonly [Fields]`, the empty set
 * when the inputs and the fixed origins alone determine them (the head is pinned, at most one row per input binding).
 *
 * An origin key `R.n.f` names one variable, field f of the rule's scope n of R, so the type level reads the engine's
 * rule (logical/props.ts), a self-join's included: each match of a relation, closed, derived, world or context
 * relation states one dependency per key of it, from what the terms bound at the key's fields need (Needs:
 * inputs and fixed variables nothing, a computation the variables it reads) to every variable it binds; a head field
 * set is a key when the closure of its variables and the fixed ones under those dependencies holds what every head term
 * needs. The candidates are, per match, nothing or one of its keys' head fields, combined across matches. The variables
 * of a relation parameter, an imported query and an interior stage carry no origin, and their matches state no
 * dependency.
 */
export type HeadKeys<S, Occurrences, H, Stated> =
	Occurrences extends ReadonlyArray<unknown>
		? KeysUnder<S, Occurrences, H, FixedBy<Stated>, StatedDeps<Stated>>
		: never

type KeysUnder<
	S,
	Os extends ReadonlyArray<unknown>,
	H,
	FixedFields extends string,
	Stated
> = MinimalOf<Passing<Candidates<S, Os, H, FixedFields>, H, Stated, FixedFields>>

/** A dependency among a rule's variables, by origin key: the origins From determine the origins To. */
interface Dep<out From extends string, out To extends string> {
	readonly from: From
	readonly to: To
}

interface Lost {
	readonly lost: true
}
/** Every origin a match binds. */
type BoundOrigins<B> = { [K in keyof B]-?: OriginKey<B[K]> }[keyof B]
/**
 * The dependencies each match states: one per key of its relation whose fields are all bound, determining the fact it
 * matches, so every variable the match binds. Only those: a variable minted at a field of the relation and bound
 * elsewhere, the field bound to something else, is no field of this fact (`match(Item, { id: p }).match(Note, { item:
 * item.owner })` binds Item's owner variable to Note's item, which Item's key does not determine).
 */
type DepsOf<S, M, FixedFields extends string> =
	M extends SoleMatch<infer Sh, infer B>
		? Sh extends AnyShown
			? | KeyDeps<
						NeedsOfKeys<KeysIn<S, Sh>, B, FixedFields, Sh["generations"]>,
						BoundOrigins<B>,
						OriginNeeds<Sh["reads"], FixedFields>
				  >
				| GenerationDeps<Sh["generations"], B, FixedFields>
			: never
		: never

/**
 * One dependency per key whose fields are all known: from what the bound terms need (KeyNeeds), and what the source's
 * own inputs need (Extra), to To.
 */
type KeyDeps<Kn, To, Extra> = Kn extends KeyNeeds<infer Known> ? DepFrom<Known | Extra, To> : never

/**
 * What a match's keys need to be known, one KeyNeeds per key, the needs of its fields together: a field the match binds
 * needs what its term needs (BoundNeeds), and a field it leaves unbound what KeyFieldNeeds says. Read once per match, by
 * its dependencies (KeyDeps) and its choices (KeyChoices) alike, a key's bound fields read off the match's needs by
 * field at once. A key of fields typed `string`, no field named, is the field `string`'s.
 */
type NeedsOfKeys<Keys, B, FixedFields extends string, Gen> = 0 extends 1 & Keys
	? never
	: Keys extends ReadonlyArray<infer F extends string>
		? string extends F
			? KeyNeeds<KeyFieldNeeds<string, B, FixedFields, Gen>>
			: KeyNeeds<
					| BoundNeeds<B, FixedFields>[F & keyof B]
					| UnboundNeeds<Exclude<F, keyof B>, B, FixedFields, Gen>
				>
		: never
/** What the term bound at each field of a match needs (Needs): read once per match. */
type BoundNeeds<B, FixedFields extends string> = { [K in keyof B]: Needs<B[K], FixedFields> }
/** What each of the key fields Ks a match leaves unbound needs (KeyFieldNeeds). */
type UnboundNeeds<Ks, B, FixedFields extends string, Gen> = Ks extends string
	? KeyFieldNeeds<Ks, B, FixedFields, Gen>
	: never
/** What one key of a match needs to be known: the origin keys its fields' terms need, Lost among them where one is lost. */
interface KeyNeeds<out Known> {
	readonly needs: Known
}

/**
 * What a match's key field K needs to be known: the term bound at it; or, unbound, the terms bound at every field its
 * generation reads, where it is a generated field of Gen (GenerationsOf), as the engine's Base states it determined by
 * them (ir/keys.ts GeneratedRead); Lost otherwise.
 */
type KeyFieldNeeds<K, B, FixedFields extends string, Gen> = K extends keyof B
	? Needs<B[K], FixedFields>
	: GeneratedNeeds<Extract<Gen, Generation<K & string, string>>, B, FixedFields>
/** What the generation of a key field needs, ReadNeeds; Lost where the field is no generated one of the relation. */
type GeneratedNeeds<G, B, FixedFields extends string> = [G] extends [never]
	? Lost
	: G extends Generation<string, infer Reads>
		? ReadNeeds<Reads, B, FixedFields>
		: Lost

/** What the terms bound at the fields Reads need: Lost where one of them is unbound. */
type ReadNeeds<Reads extends string, B, FixedFields extends string> = {
	[R in Reads]-?: R extends keyof B ? Needs<B[R], FixedFields> : Lost
}[Reads]

/**
 * One dependency per generation of a match's relation whose field and reads are all bound: from what the terms bound at
 * its reads need to the variable bound at its field, a function of them in every fact (ir/keys.ts GeneratedRead).
 */
type GenerationDeps<Gen, B, FixedFields extends string> =
	Gen extends Generation<infer G, infer Reads>
		? G extends keyof B
			? DepFrom<ReadNeeds<Reads, B, FixedFields>, OriginKey<B[G]>>
			: never
		: never

/** A stored relation's fields as it declares them, its generated ones each a GeneratedField (types/fields/field.ts). */
type FieldsOf<R> = R extends { readonly fields: infer Fields } ? Fields : never

/** A generated field G of a stored relation and the fields its generation reads, Reads, which determine it. */
export interface Generation<out G extends string, out Reads extends string> {
	readonly field: G
	readonly reads: Reads
}

/**
 * The generations of a stored relation's heading H that determine their fields (ir/keys.ts GeneratedRead): each
 * generated field whose term's origin names fields of its row alone (ReadFields), none of them a float, whose -0 and +0
 * are one key value a generation may tell apart; a generation reading what the types do not trace is none.
 */
export type GenerationsOf<H> = {
	[K in keyof H]-?: H[K] extends GeneratedField<FieldBase, infer O>
		? GenerationOver<K & string, ReadFields<O>, H>
		: never
}[keyof H]
type GenerationOver<G extends string, Reads, H> = Lost extends Reads
	? never
	: true extends ReadsFloat<Reads, H>
		? never
		: Generation<G, Reads & string>
type ReadsFloat<Reads, H> = Reads extends keyof H
	? H[Reads] extends { readonly sql: "real" | "double precision" }
		? true
		: false
	: false
/** The fields of its row a generation's term origin O names: each field an operand is, inputs none, Lost for any other. */
type ReadFields<O> = unknown extends O
	? Lost
	: O extends InputOrigin
		? never
		: O extends ComputedOrigin<infer Operands>
			? ReadFields<Operands>
			: O extends Origin<string, infer F>
				? F
				: Lost

type KeyOfAnyArm<H> = H extends unknown ? keyof H : never
type DepFrom<From, To> = Lost extends From ? never : Dep<From & string, To & string>
/** What Known determines under Deps: Known with each dependency's To whose From it holds, to a fixed point. */
type Closure<Deps, Known extends string> =
	ClosureStep<Deps, Known> extends infer Next extends string
		? [Next] extends [Known]
			? Known
			: Closure<Deps, Next>
		: Known

type ClosureStep<Deps, Known extends string> =
	| Known
	| (Deps extends Dep<infer F, infer T> ? ([F] extends [Known] ? T : never) : never)

/**
 * Each head field holding a non-input term of one origin key, with that key (OriginKey, SoleKey): read once per head,
 * so the fields holding what a key needs are one walk of these entries, never of the head's terms.
 */
type HeadEntries<H> = {
	[N in keyof H]-?: H[N] extends Phantom<{ readonly origin: infer HO }>
		? [HO] extends [InputOrigin]
			? never
			: EntryOf<SoleKey<OriginKey<H[N]>>, N>
		: never
}[keyof H]
/** A head field N's entry where its term holds one key K, none where it holds none or several. */
type EntryOf<K, N> = [K] extends [never] ? never : HeadEntry<K, N>
/** K where it is one key: never where it is several, or none. */
type SoleKey<K, All = K> = K extends unknown ? ([All] extends [K] ? K : never) : never
/** The head's entries whose key is one of Need. */
type EntriesIn<E, Need> =
	E extends HeadEntry<infer K, unknown> ? ([K] extends [Need] ? E : never) : never
/** The keys entries hold. */
type KeysOfEntries<E> = E extends HeadEntry<infer K, unknown> ? K : never
/** The fields of entries. */
type FieldsOfEntries<E> = E extends HeadEntry<unknown, infer N> ? N : never
/** A head field N and the one origin key its term holds, K. */
interface HeadEntry<out K, out N> {
	readonly key: K
	readonly field: N
}

/**
 * One match's candidate parts, each `readonly [Fields, Fired, Unfired]`: nothing, its dependencies left to the closure
 * (Unfired); or the head fields holding one of its keys' variables, with those holding what a bound import's bindings
 * read, whose dependency the fields' own origins fire, so every variable the match binds is known from the start
 * (Fired) and none of its dependencies, all of which conclude those variables, is read again.
 */
type Choices<S, M, H, FixedFields extends string> =
	| readonly [never, never, DepsOf<S, M, FixedFields>]
	| (M extends SoleMatch<infer Sh, infer B>
			? Sh extends AnyShown
				? KeyChoices<
						NeedsOfKeys<KeysIn<S, Sh>, B, FixedFields, Sh["generations"]>,
						H,
						OriginNeeds<Sh["reads"], FixedFields>,
						BoundOrigins<B> & string
					>
				: never
			: never)

/**
 * The choice of each key of a match (KeyNeeds): the head fields holding what its fields need and what the source's own
 * inputs need (Extra), each need held by some field, firing every variable the match binds (Fired).
 */
type KeyChoices<Kn, H, Extra, Fired> =
	Kn extends KeyNeeds<infer Known> ? HeadSet<HeadFieldsAt<Known | Extra, H>, Fired> : never
/**
 * The head fields holding the variables Need names, Lost when one of them is held by none or Need is Lost, and none,
 * the head unread, when Need names none (a key whose fields are inputs or fixed): what a head field holds, a term of
 * exactly one origin key (HeadEntries), holds that variable.
 */
type HeadFieldsAt<Need, H> = Lost extends Need
	? Lost
	: [Need] extends [never]
		? never
		: HeldFields<Need, EntriesIn<HeadEntries<H>, Need>>
/** The fields of the entries holding Need's keys, E, Lost when one of the keys is held by none. */
type HeldFields<Need, E> = [Need] extends [KeysOfEntries<E>] ? FieldsOfEntries<E> : Lost
type HeadSet<Fields, Fired> = Lost extends Fields ? never : readonly [Fields, Fired, never]
type Cross<A, B> = A extends readonly [infer X, infer XFired, infer XUnfired]
	? B extends readonly [infer Y, infer YFired, infer YUnfired]
		? readonly [X | Y, XFired | YFired, XUnfired | YUnfired]
		: never
	: never

/** Every combination of one choice per match, each with what its keys fire and the dependencies its closure reads. */
type Candidates<S, Os, H, FixedFields extends string> = Os extends readonly [infer M, ...infer Rest]
	? Cross<Choices<S, M, H, FixedFields>, Candidates<S, Rest, H, FixedFields>>
	: readonly [never, never, never]
/** The head fields that need determining: every field but an aggregate. */
type TargetFields<H> = Exclude<keyof H, AggregateFields<H>>
/** The origin keys of the head fields C holds, read off the head's keys by field (OriginKeysOf). */
type OriginsOfFields<H, C> = OriginKeysOf<H>[keyof H & C]
/** Each head field's origin keys (OriginKey), read once per head. */
type OriginKeysOf<H> = { [N in keyof H]-?: OriginKey<H[N]> }
/**
 * The candidates whose closure holds every head field, each as `readonly [Fields]`: a field in the candidate, or a term
 * whose needs are reached (an input, a variable reached, a computation over variables reached). A candidate's closure
 * starts from its fields' origins, the fixed ones and what its keys fire, and reads the statements' dependencies and
 * those of the matches it keys none of: the closure of its fields' origins under every dependency, read once per
 * dependency of each match it keys nothing of, never once per key of every match for each candidate.
 */
type Passing<Cs, H, Stated, FixedFields extends string> = Cs extends readonly [
	infer C,
	infer Fired extends string,
	infer Unfired
]
	? Covers<
			H,
			C,
			Closure<Unfired | Stated, (OriginsOfFields<H, C> & string) | Fired | FixedFields>,
			FixedFields
		> extends true
		? readonly [C]
		: never
	: never

type Covers<H, C, Known extends string, FixedFields extends string> = DeterminedBy<
	NeedsOf<H, FixedFields>[Exclude<TargetFields<H>, C> & keyof NeedsOf<H, FixedFields>],
	Known
>
/** What each head field that needs determining needs (Needs), read once per head and fixed fields. */
type NeedsOf<H, FixedFields extends string> = { [N in TargetFields<H>]-?: Needs<H[N], FixedFields> }

/** The candidates no other candidate lies strictly within. */
type MinimalOf<All> = All extends readonly [infer X]
	? true extends ProperSubsetIn<X, All>
		? never
		: All
	: never

type ProperSubsetIn<X, All> = All extends readonly [infer Y]
	? [Y] extends [X]
		? [X] extends [Y]
			? false
			: true
		: false
	: false

/**
 * take(k) closes an ordered query into a set: take(1) is atMostOne. The child of a take is no plain
 * match and no grouped region, so neither attach proof reads through it (logical/attach.ts): a proved "one"
 * is at most one fact after any take.
 */
export type TakeEvidence<Ev extends Evidence, K> = K extends 1
	? { readonly keys: Ev["keys"]; readonly card: "atMostOne" } & OriginsPart<Ev>
	: Ev["card"] extends "one"
		? { readonly keys: Ev["keys"]; readonly card: "atMostOne" } & OriginsPart<Ev>
		: Ev

/** The origins an evidence carries, as the part of another evidence that keeps them: absent where it carries none. */
type OriginsPart<Ev> = Ev extends { readonly origins: infer O extends OriginMap }
	? { readonly origins: O }
	: unknown

/**
 * A match as the rule's evidence reads it: its source as the match shows it (Shown) and its bindings. It is each of the
 * rule's occurrences, and the rule's only match while it is the rule's only clause: no second match and no where ("the
 * child has no further predicate"). NoMatch before any match, Joined after anything more.
 */
export interface SoleMatch<R, B> {
	readonly sole: R
	readonly bindings: B
}

/**
 * The kind of source a match shows: a named one, a relation, a closed relation or roster, a derived or world relation
 * or a context, whose variables name it (VarOrigins); a delta of an ordinary relation, folded by that relation's keys;
 * or any other source, a query, a bound import, an interior stage, a relation parameter, a recursive definition's self
 * or a delta of a world relation.
 */
type ShownKind = "relation" | "closed" | "derived" | "world" | "context" | "delta" | "source"
/** The kinds S declares candidate keys of: a relation's own (KeysOf), and a delta's relation's, which its fold reads. */
type Declaring = "relation" | "closed" | "derived" | "world"

/**
 * A matched source as its rule's evidence reads it, and nothing else of it: its kind, which the attach table's rows and
 * a variable's holding read; its name, a named source's or a delta's relation's, never any other's; its keys, the field
 * lists that determine its facts, a named source's own (OwnKeysOf) and any other's its heading's and its evidence's
 * (ShownKeysOf); the keys a fold reads it by, a named source's own, a delta's relation's own, and any other source's
 * heading; and the origins a bound import's bindings read, none for any other source. The rule adds the keys its schema
 * declares (KeysIn, FoldsIn).
 *
 * It holds no source: a query, a bound import, an interior stage, a derived or world relation and a delta of one hold
 * a schema, every relation of it, and so does every type that names one among its arguments, so a reader of the
 * source, and each later instantiation of a type holding it, would instantiate the schema whole. ShownOf reads the
 * source once, where the match is written, into types none of which names it.
 */
export interface Shown<out Kind extends ShownKind, out N, out Keys, out Folds, out Rd, out Gen> {
	readonly kind: Kind
	readonly name: N
	readonly keys: Keys
	readonly folds: Folds
	readonly reads: Rd
	/** A stored relation's generations that determine their fields (GenerationsOf), none for any other source. */
	readonly generations: Gen
}
type AnyShown = Shown<ShownKind, string, unknown, unknown, unknown, unknown>
/** A source a variable's origin names. */
type NamedShown = Shown<
	Exclude<ShownKind, "delta" | "source">,
	string,
	unknown,
	unknown,
	unknown,
	unknown
>

/** The keys of a match's source in the rule's schema S: its own, and those S declares for a named source (KeysOf). */
type KeysIn<S, Sh> =
	Sh extends Shown<infer Kind, infer N extends string, infer Keys, unknown, unknown, unknown>
		? Kind extends Declaring
			? Keys | DeclaredKeysOfAll<S, N>
			: Keys
		: never
/** The keys a fold reads a match's source by in the rule's schema S: its own, and those S declares (KeysOf). */
export type FoldsIn<S, Sh> =
	Sh extends Shown<infer Kind, infer N extends string, unknown, infer Folds, unknown, unknown>
		? Kind extends Declaring | "delta"
			? Folds | DeclaredKeysOfAll<S, N>
			: Folds
		: never

/**
 * Each member of a matched source R as a match shows it, each its own, as every reader of a match distributes over its
 * source: a named source by its kind, its name and its own keys; a delta by its relation's, a world relation's by its
 * heading; and any other source by its heading's and its evidence's keys, folded by its heading, and the origins its
 * bindings read.
 *
 * Every part is read off R as an argument of an alias whose own arguments are the parts alone (NamedShownOf,
 * SourceShownOf), so no type it makes names R: a type reference written inside an alias whose arguments read another
 * alias is one the checker defers, holding the alias's mapper, and every later instantiation of a type that holds it
 * instantiates what that mapper holds again, a query whole, its schema with it. A derived relation's type holds no query
 * (types/derived/derived.ts DefinitionView), so a reference holding it holds nothing of a schema; it is read as the other
 * named sources are.
 */
export type ShownOf<R> = R extends AnyContext
	? NamedShownOf<"context", NameOf<R>, readonly []>
	: R extends AnyRelation
		? RelationShownOf<NameOf<R>, OwnKeysOf<R>, GenerationsOf<FieldsOf<R>>>
		: R extends AnyClosed
			? NamedShownOf<"closed", NameOf<R>, OwnKeysOf<R>>
			: R extends AnyDerived
				? NamedShownOf<"derived", NameOf<R>, OwnKeysOf<R>>
				: R extends AnyWorld
					? NamedShownOf<"world", NameOf<R>, OwnKeysOf<R>>
					: typeof delta extends keyof R
						? DeltaShownOf<
								DeltaOf<R>,
								HeadingOf<R>,
								ShownKeysOf<HeadingOf<R>, EvidenceKeys<R>>,
								ReadsOf<R>
							>
						: SourceShownOf<
								ShownKeysOf<HeadingOf<R>, EvidenceKeys<R>>,
								HeadingFolds<HeadingOf<R>>,
								ReadsOf<R>
							>
/** A named source of kind Kind, its name N and its own keys K. */
type NamedShownOf<Kind extends ShownKind, N, K> = Shown<Kind, N, K, K, never, never>
/** A stored relation of name N, its own keys K and its generations that determine their fields Gen (GenerationsOf). */
type RelationShownOf<N, K, Gen> = Shown<"relation", N, K, K, never, Gen>
/** A source that is no named one, keyed by Keys (ShownKeysOf), folded by Folds, its bindings reading Rd. */
type SourceShownOf<Keys, Folds, Rd> = Shown<"source", never, Keys, Folds, Rd, never>
/**
 * A delta of the relation D, of heading H and keys Keys: a world relation's folded by its heading, any other's by its
 * relation's own keys and those its rule's schema declares of the relation's name (FoldsIn); one whose relation the
 * types do not read is folded by no key.
 */
type DeltaShownOf<D, H, Keys, Rd> = [D] extends [never]
	? SourceShownOf<Keys, never, Rd>
	: D extends AnyWorld
		? SourceShownOf<Keys, HeadingFolds<H>, Rd>
		: DeltaRelationShownOf<NameOf<D>, Keys, OwnKeysOf<D>, Rd>
type DeltaRelationShownOf<N, Keys, Folds, Rd> = Shown<"delta", N, Keys, Folds, Rd, never>
/** The relation a delta source holds facts of: never where its phantom names none. */
type DeltaOf<R> = R extends { readonly [delta]?: Invariant<infer D> | undefined } ? D : never

/**
 * The keys of a source that is no relation, as a match of it reads them: its whole heading H, every field of every arm,
 * since it is a set; and, for a query, a bound import, an interior stage or a call's rows, every key its own evidence
 * proves, Ks, which holds per binding of the inputs it reads (ReadsOf): a call's, the keys of one evaluation's rows at
 * its arguments (types/compute/call.ts CallEvidence), so an arm's source of a cell is keyed by the cell alone. A
 * relation parameter, a recursive definition's self and a delta are keyed by their heading alone.
 */
type ShownKeysOf<H, Ks> = HeadingKey<KeyOfAnyArm<H>> | Ks
type HeadingKey<F> = ReadonlyArray<F & string>
/** The keys a source's evidence proves: none where it carries no evidence. */
type EvidenceKeys<R> =
	R extends Phantom<{ readonly evidence: { readonly keys: infer Ks } }>
		? Ks extends ReadonlyArray<infer K extends ReadonlyArray<string>>
			? K
			: never
		: never
/**
 * What a bound import's or a call's facts depend on beside their keys: the origins its bindings or its arguments read,
 * whose values select which facts it holds (BoundSource's and CallSource's `reads`); none for any other source, whose
 * inputs are the rule's own parameters.
 */
type ReadsOf<R> = R extends Phantom<{ readonly reads: infer Rd }> ? Rd : never
/** A source keyed by its heading H alone: one key of every field its arms share. */
type HeadingFolds<H> = ReadonlyArray<keyof H>

/**
 * Parent variables and fresh variables, as the attach proofs read a binding.
 *
 * A parent variable is an input whose origin names the relation field its parent head field was matched at, and its
 * scope (terms.ts ParentVars); a fresh variable is a non-input variable whose origin is the bound relation at the very
 * field it is bound to, which matches every fact and so filters nothing.
 */
type ParentOriginOf<X> =
	X extends Phantom<{ readonly origin: infer O }>
		? [O] extends [InputOrigin]
			? O extends Origin<infer R, infer F, infer N>
				? Origin<R, F, N>
				: never
			: never
		: never

type IsParentAt<X, PN, F, N> =
	X extends Phantom<{ readonly origin: infer O }>
		? [O] extends [InputOrigin]
			? O extends Origin<PN & string, F & string, N & string>
				? true
				: false
			: false
		: false

/**
 * The scope every parent variable bound at the fields Fs shares, one literal: never where they are of two scopes. A
 * scope's origins are fields of one fact of the parent (terms.ts HeadOrigins), so a proof that reads the parent
 * variables of one scope reads one fact.
 */
type SharedScope<B, Fs> =
	Fs extends ReadonlyArray<infer G>
		? ScopeOf<B[G & keyof B]> extends infer N
			? IsOneLiteral<N> extends true
				? N
				: never
			: never
		: never
/** The scopes of the parent variables among X. */
type ScopeOf<X> = ScopeOfOrigin<ParentOriginOf<X>>
type ScopeOfOrigin<O> = O extends Origin<string, string, infer N> ? N : never

type IsFreeAt<X, RN, K> =
	X extends Phantom<{ readonly origin: infer O }>
		? [O] extends [InputOrigin]
			? false
			: O extends Origin<RN & string, K & string>
				? true
				: false
		: false

/** "parent", "free" or "other" for each binding of a match over relation RN. */
type BindingKinds<B, RN> = {
	[K in keyof B]-?: [ParentOriginOf<B[K]>] extends [never]
		? IsFreeAt<B[K], RN, K> extends true
			? "free"
			: "other"
		: "parent"
}

type ParentFields<B, RN> = {
	[K in keyof B]-?: BindingKinds<B, RN>[K] extends "parent" ? K : never
}[keyof B]
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** Whether the fields U are exactly one of the keys Keys. */
type IsKeyOf<Keys, U> = true extends KeyEquals<Keys, U> ? true : false
type KeyEquals<Keys, U> = 0 extends 1 & Keys
	? false
	: Keys extends ReadonlyArray<infer F>
		? SameSet<F, U>
		: false

/** Each field RF[i] is bound to the parent variable of origin PN.LF[i] in scope N, position by position. */
type ParentsAt<B, RF, PN, LF, N> = RF extends readonly [infer G, ...infer RRest]
	? LF extends readonly [infer F, ...infer LRest]
		? G extends keyof B
			? IsParentAt<B[G], PN, F, N> extends true
				? ParentsAt<B, RRest, PN, LRest, N>
				: false
			: false
		: false
	: RF extends readonly []
		? LF extends readonly []
			? true
			: false
		: false

/**
 * The parent variables a head holds are bound by the match: a parent variable read elsewhere is correlated to the
 * child rather than bound, and filters it.
 */
type HeadParentsBound<H, B, RN> = false extends {
	[K in keyof H]-?: [ParentOriginOf<H[K]>] extends [never]
		? true
		: ParentOriginOf<H[K]> extends ParentOriginOf<B[ParentFields<B, RN>]>
			? true
			: false
}[keyof H]
	? false
	: true

/**
 * The match keyed by the parent: a stored or closed relation, every binding a parent variable or a fresh one, and the
 * parent-bound fields exactly a key of it.
 */
type KeyedByParent<S, Sh, B, H> =
	Sh extends Shown<"relation" | "closed", infer RN, unknown, unknown, unknown, unknown>
		? "other" extends BindingKinds<B, RN>[keyof B]
			? false
			: HeadParentsBound<H, B, RN> extends true
				? IsKeyOf<KeysIn<S, Sh>, ParentFields<B, RN>>
				: false
		: false
/** The name a match's source shows: never for a source that is no named one. */
type ShownName<Sh> = Sh extends NamedShown ? Sh["name"] : never

/**
 * The containment row of the attach table: the child's only clause is a match keyed by the parent (KeyedByParent), and
 * S declares contained(on(Parent, ...from), on(R, ...to)) with `to` exactly the parent-bound fields and each `to` field
 * bound to the parent variable of origin Parent.from at the same position, every one of one scope, so of one fact of
 * Parent. The result is true where one proves the child, never otherwise. A span coverage law proves coverage, not
 * scalar existence, and a selected source needs the parent's selection, so neither proves.
 */
export type ContainmentProof<S, Sole, H> =
	Sole extends SoleMatch<infer Sh, infer B>
		? KeyedByParent<S, Sh, B, H> extends true
			? OneRelationEach<ShownName<Sh>, B> extends true
				? ContainmentsInto<
						ContainmentsBetween<S, ParentRelations<B>, ShownName<Sh>>,
						ShownName<Sh>,
						B
					>
				: never
			: never
		: never

/**
 * Whether a proof by name reads one relation at each end: a matched relation of one name, and parent variables each of
 * an origin of one. A generic relation's name is the union of its relations' names (types/schema/statements.ts Shows),
 * and a law of one of them proves nothing of the others, so a proof over it, or over a parent variable of its, is none.
 */
type OneRelationEach<RN, B> =
	IsOneLiteral<RN> extends true
		? false extends OneNamed<ParentOriginOf<B[keyof B]>>
			? false
			: true
		: false
type OneNamed<O> = O extends Origin<infer R> ? IsOneLiteral<R> : true

/**
 * S's containments between two ordinary or closed relations, each under the pair of names `${source} ${target}`, the
 * relation its left side reads and the one its right side reads, and none under any other pair. It is built once per
 * schema, so a proof reads the containments from the parent's relations into the matched relation by name, never in a
 * pass over every containment S declares: the checker reads a proof's every branch while it infers a rule's head, so a
 * pass would cost every rule the size of the schema.
 */
type ContainmentIndexOf<S> = {
	readonly [C in ContainmentsOf<S> as ContainmentPair<C>]: C
} & { readonly [pair: string]: never }

type ContainmentPair<C> =
	C extends Containment<
		Side<infer PRel extends AnyRelation | AnyClosed>,
		Side<infer RRel extends AnyRelation | AnyClosed>
	>
		? `${NameOf<PRel>} ${NameOf<RRel>}`
		: never

/** The containments S declares from one of the relations named PN into the relation named RN. */
type ContainmentsBetween<S, PN, RN extends string> = PN extends string
	? ContainmentIndexOf<S>[`${PN} ${RN}`]
	: never

/** The relations whose fields the parent variables bound in B were matched at. */
type ParentRelations<B> = RelationOfOrigin<ParentOriginOf<B[keyof B]>>
type RelationOfOrigin<O> = O extends Origin<infer R> ? R : never

type ContainmentsInto<C, RN, B> =
	C extends Containment<
		Side<infer PRel, infer LF extends ReadonlyArray<string>>,
		Side<infer RRel, infer RF extends ReadonlyArray<string>>
	>
		? PRel extends AnyRelation | AnyClosed
			? RRel extends AnyRelation | AnyClosed
				? NameOf<RRel> extends RN
					? SameSet<RF extends ReadonlyArray<infer F> ? F : never, ParentFields<B, RN>> extends true
						? ParentsAt<B, RF, NameOf<PRel>, LF, SharedScope<B, RF>> extends true
							? true extends CoversSpan<PRel, LF>
								? never
								: true
							: never
						: never
					: never
				: never
			: never
		: never

/** A span field among the parent fields the parent variables were matched at: a coverage law. */
type CoversSpan<PRel, LF> =
	LF extends ReadonlyArray<infer G>
		? HeadingFieldOf<PRel, G> extends { readonly sql: "range" }
			? true
			: false
		: false

/**
 * The carrier of a relation's heading under field G: a relation's descriptor, a closed relation's id or payload one.
 */
type HeadingFieldOf<R, G> = R extends { readonly heading: infer C }
	? G extends keyof C
		? C[G]
		: never
	: never

/**
 * The reflexive row of the attach table, as logical/attach.ts reflexiveOne reads it: the
 * child's only match is of a stored or derived relation R; every binding is a parent variable at the field its origin
 * names, or a variable of the child no other binding shares; the head's group terms are all parent variables; at least
 * one parent variable is read; every parent variable read has its origin in R, some one scope's fact holding each, as
 * reflexiveOne tries each scan the parent's columns were read from; and every filter is true when the child's fact is
 * the parent's own: a variable bound at field f, and a parent variable of origin R.f, both read the fact's f, so
 * `r.le(t.id, s.id)` holds and `r.lt(t.at, s.at)` fails. A scope's origins are fields of one fact (terms.ts
 * HeadOrigins), so every parent variable of origin R in that scope reads the one fact, and over a self-join parent each
 * scope proves its own fact's group, a field both facts hold, bound at its own field in each, read in either (HeldAt).
 */
export type ReflexiveProof<Occurrences, Filters, H> = Occurrences extends readonly [
	SoleMatch<infer Sh, infer B>
]
	? Sh extends Shown<"relation" | "derived", infer RN, unknown, unknown, unknown, unknown>
		? OneRelationEach<RN, B> extends true
			? ReflexiveOf<RN, B, Filters, H>
			: false
		: false
	: false

type ReflexiveOf<RN, B, Filters, H> =
	ReflexiveBindings<B, RN> extends true
		? GroupTermsAreParents<H, RN> extends true
			? Filters extends ReadonlyArray<unknown>
				? true extends ReadsParent<B, H, Filters>
					? HoldsOne<CommonScopes<ScopeBoxesRead<B, H, Filters>>> extends true
						? AllTrue<Filters, { readonly relation: RN; readonly bindings: B }>
						: false
					: false
				: false
			: false
		: false

/**
 * The scopes whose facts hold each parent variable the child reads, each variable's boxed apart (ScopeBox): in its
 * bindings, its head and its filters.
 */
type ScopeBoxesRead<B, H, Filters> =
	| { [K in keyof B]-?: ScopeBox<B[K]> }[keyof B]
	| { [K in keyof H]-?: ScopeBox<H[K]> }[keyof H]
	| (Filters extends ReadonlyArray<infer P> ? ShapeScopes<ShapeOf<P>> : never)

/**
 * The scopes whose facts hold the parent variable X, boxed apart from any other variable's: those its origin records
 * (HeldAt), its own scope alone where it records none; none for any other term.
 */
type ScopeBox<X> = [ParentOriginOf<X>] extends [never] ? never : { readonly scopes: HoldingOf<X> }
type HoldingOf<X> =
	X extends Phantom<{ readonly origin: infer O }>
		? O extends HeldAt<infer N>
			? N
			: ScopeOfOrigin<O>
		: never

/** The scopes every box of the union Boxes holds: never where they hold none in common, or where there is no box. */
type CommonScopes<Boxes> =
	UnionToIntersection<Boxes> extends { readonly scopes: infer N } ? N : never

/** Whether the scopes N hold one literal scope at least. */
type HoldsOne<N> = [N] extends [never] ? false : string extends N ? false : true

/**
 * A parent variable at the field of R its origin names, or a child variable whose origin key no other binding shares.
 */
type ReflexiveBindings<B, RN> = false extends {
	[K in keyof B]-?: [ParentOriginOf<B[K]>] extends [never]
		? [OriginKey<B[K]>] extends [never]
			? false
			: IsSingle<SharedOriginFields<B, OriginKey<B[K]>>>
		: IsParentAt<B[K], RN, K, string>
}[keyof B]
	? false
	: true

/** The bindings of B whose variable's origin keys all lie among Key. */
type SharedOriginFields<B, Key> = WithinKeys<B, BindingsByOrigin<B>[Key & string], Key>

/**
 * The bindings of B by the origin key of the variable each binds: each binding under each of its origin keys and none
 * under any other key, built in one pass over B, so the bindings that share a variable's origin are one property read,
 * never a pass over the bindings per binding.
 */
type BindingsByOrigin<B> = {
	readonly [K in keyof B as OriginKey<B[K]>]: K
} & { readonly [key: string]: never }

/** The bindings among Ks whose every origin key lies among Key. */
type WithinKeys<B, Ks, Key> = Ks extends keyof B
	? [OriginKey<B[Ks]>] extends [Key]
		? Ks
		: never
	: never

/** The head is an aggregate whose every other term is a parent variable of origin in R. */
type GroupTermsAreParents<H, RN> = [AggregateFields<H>] extends [never]
	? false
	: [ProducerFields<H>] extends [never]
		? false extends {
				[K in Exclude<keyof H, AggregateFields<H>>]-?: ParentOriginOf<H[K]> extends Origin<
					RN & string
				>
					? [ParentOriginOf<H[K]>] extends [never]
						? false
						: true
					: false
			}[Exclude<keyof H, AggregateFields<H>>]
			? false
			: true
		: false

/** Some parent variable is read: a parent's fact to substitute exists only then. */
type ReadsParent<B, H, Filters> =
	| ([ParentOriginOf<B[keyof B]>] extends [never] ? false : true)
	| ([ParentOriginOf<H[Exclude<keyof H, AggregateFields<H>>]>] extends [never] ? false : true)
	| (Filters extends ReadonlyArray<infer P> ? ShapeReadsParent<ShapeOf<P>> : false)

/**
 * Predicate shapes, the phantom the rule's filters record for the reflexive proof (query/rule.ts): a comparison and
 * its operands, a conjunction or disjunction of predicates, an opaque predicate over its terms, and a relational
 * negation, which is no filter of the child's region at all.
 */
export interface Shaped<out Sh> extends Built {
	readonly [phantom]?: { readonly shape: Sh } | undefined
}
export type ComparisonOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge"
export interface Comparison<out Op extends ComparisonOp, out A, out B> {
	readonly op: Op
	readonly left: A
	readonly right: B
}

export interface Conjunction<out Ps> {
	readonly and: Ps
}

export interface Disjunction<out Ps> {
	readonly or: Ps
}

/** A predicate the reflexive proof does not evaluate, over the terms it reads. */
export interface Opaque<out Terms> {
	readonly opaque: Terms
}

export interface Negation {
	readonly negation: true
}
type ShapeOf<P> = P extends Phantom<{ readonly shape: infer Sh }> ? Sh : Unshaped
interface Unshaped {
	readonly unshaped: true
}

/**
 * Three-valued truth, plus X: the proof fails whatever the other filters say. A parent variable whose origin is not
 * in R has no field of the parent's fact, and a computed term or an unshaped predicate may read one.
 */
type Truth = "T" | "F" | "U" | "X"
interface ReflexiveContext {
	readonly relation: unknown
	readonly bindings: unknown
}

/** Every member of each filter is true. */
type AllTrue<Filters, Cx extends ReflexiveContext> = Filters extends readonly [
	infer P,
	...infer Rest
]
	? [Eval<P, Cx>] extends ["T"]
		? AllTrue<Rest, Cx>
		: false
	: Filters extends readonly []
		? true
		: false
type Eval<P, Cx extends ReflexiveContext> = P extends unknown ? EvalShape<ShapeOf<P>, Cx> : never
type EvalShape<Sh, Cx extends ReflexiveContext> =
	Sh extends Comparison<infer Op, infer A, infer B>
		? Compare<Op, Sym<A, Cx>, Sym<B, Cx>>
		: Sh extends Conjunction<infer Ps>
			? Fold<Ps, Cx, "F", "T">
			: Sh extends Disjunction<infer Ps>
				? Fold<Ps, Cx, "T", "F">
				: Sh extends Opaque<infer Terms>
					? "X" extends SymsOf<Terms, Cx>
						? "X"
						: "U"
					: "X"

/** A conjunction is F on any F and T when all are T; a disjunction is T on any T and F when all are F. X wins. */
type Fold<Ps, Cx extends ReflexiveContext, Absorb extends Truth, Unit extends Truth> =
	Ps extends ReadonlyArray<unknown>
		? number extends Ps["length"]
			? "X"
			: FoldOf<{ [I in keyof Ps]: Eval<Ps[I], Cx> }[number], Absorb, Unit>
		: "X"

/** An empty list folds to the unit: `[never] extends [Unit]`. */
type FoldOf<V, Absorb, Unit> = "X" extends V
	? "X"
	: Absorb extends V
		? Absorb
		: [V] extends [Unit]
			? Unit
			: "U"

/** Two operands that read the same field of the parent's fact compare equal (logical/attach.ts evaluate). */
type Compare<Op, A, B> = "X" extends A | B
	? "X"
	: "U" extends A | B
		? "U"
		: SameSet<A, B> extends true
			? IsSingle<A> extends true
				? Op extends "eq" | "le" | "ge"
					? "T"
					: "F"
				: "U"
			: "U"

/**
 * The field of the parent's fact an operand reads, as `f:<field>`: a parent variable of origin R.f reads f, a child
 * variable its binding field. A parameter, a JavaScript value or a typed constant is unknown; a parent variable from
 * elsewhere, a variable bound nowhere in the match, or a computed term fails the proof.
 */
type Sym<X, Cx extends ReflexiveContext> =
	IsInputValue<X> extends true
		? "U"
		: X extends Literal
			? "U"
			: X extends Phantom<{ readonly origin: infer O }>
				? [O] extends [ConstantOrigin]
					? "U"
					: [O] extends [InputOrigin]
						? O extends Origin<Cx["relation"] & string, infer F>
							? `f:${F}`
							: "X"
						: [OriginKey<X>] extends [never]
							? "X"
							: BindingFieldOf<Cx["bindings"], OriginKey<X>> extends infer K extends string
								? [K] extends [never]
									? "X"
									: `f:${K}`
								: "X"
				: "X"
type BindingFieldOf<B, Key> = SharedOriginFields<B, Key> & string
type SymsOf<Terms, Cx extends ReflexiveContext> = Terms extends readonly [infer T, ...infer Rest]
	? Sym<T, Cx> | SymsOf<Rest, Cx>
	: Terms extends readonly []
		? never
		: "X"

/** Whether a shape reads some parent variable. */
type ShapeReadsParent<Sh> =
	Sh extends Comparison<ComparisonOp, infer A, infer B>
		? IsParentVar<A> | IsParentVar<B>
		: Sh extends Conjunction<infer Ps>
			? ListReadsParent<Ps>
			: Sh extends Disjunction<infer Ps>
				? ListReadsParent<Ps>
				: Sh extends Opaque<infer Terms>
					? Terms extends ReadonlyArray<infer T>
						? IsParentVar<T>
						: false
					: false
type ListReadsParent<Ps> = Ps extends ReadonlyArray<infer P> ? ShapeReadsParent<ShapeOf<P>> : false
type IsParentVar<X> = [ParentOriginOf<X>] extends [never] ? false : true

/** The scopes whose facts hold each parent variable a shape reads, each variable's boxed apart (ScopeBox). */
type ShapeScopes<Sh> =
	Sh extends Comparison<ComparisonOp, infer A, infer B>
		? ScopeBox<A> | ScopeBox<B>
		: Sh extends Conjunction<infer Ps>
			? ListScopes<Ps>
			: Sh extends Disjunction<infer Ps>
				? ListScopes<Ps>
				: Sh extends Opaque<infer Terms>
					? Terms extends ReadonlyArray<infer T>
						? T extends unknown
							? ScopeBox<T>
							: never
						: never
					: never
type ListScopes<Ps> = Ps extends ReadonlyArray<infer P> ? ShapeScopes<ShapeOf<P>> : never
