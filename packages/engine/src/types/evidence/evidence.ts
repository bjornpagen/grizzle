import type { Built, Phantom, phantom } from "#compiler/core/phantom.ts"
import type {
	ComputedOrigin,
	ConstantOrigin,
	InputOrigin,
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
	TermBase,
	UnionToIntersection,
	ValueOfTerm
} from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { Aggregate, Producer } from "#compiler/types/query/terms.ts"
import type { AnyClosed, AnyRelation, HeadingOf, NameOf } from "#compiler/types/schema/relation.ts"
import type { ContainmentsOf, KeysOf, StatementsOf } from "#compiler/types/schema/schema.ts"
import type {
	Alternatives,
	AlternativesBase,
	Containment,
	KeyFieldsOf,
	RelationOfKey,
	Side
} from "#compiler/types/schema/statements.ts"
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
 *   keys joined with a field the arms fix to different literals (UnionEvidence);
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
 * ReadBack), which is at most one child under either reading, so the evidence carries the snapshot card alone. An
 * alternatives arm keyed by the parent's key is at most one child under both readings: its stated arm narrows it to
 * Some in the records the parent's handle selects and None in the others, which the `arm` the evidence records
 * licenses, and a read-back reads it as an Option.
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
	/** The child reads the arm relation of one handle of an alternatives law, keyed by the parent's key (ArmProof). */
	readonly arm?: ArmProof
	/**
	 * Each head field's value where the rule fixes it per binding and the types name it (HeadValues), which a union reads
	 * (UnionEvidence): absent where there is none.
	 */
	readonly values?: ValueMap
}

/**
 * The arm of handle Handle of an alternatives law over Parent discriminated by Discriminator: a fact of the arm exists
 * exactly for the parent facts of that handle, the fact of the parent's scope Scope whose key the arm's key is bound
 * to.
 */
interface ArmProof<
	Parent extends string = string,
	Discriminator extends string = string,
	Handle = unknown,
	Scope extends string = string
> {
	readonly parent: Parent
	readonly discriminator: Discriminator
	readonly handle: Handle
	readonly scope: Scope
}

/** Each head field's provenance: a witnessed variable origin. */
type OriginMap = { readonly [field: string]: Origin }
/** Each head field's value per binding: one literal, a parameter by name, or a parent's field (Fixed). */
type ValueMap = { readonly [field: string]: unknown }
export type OriginsOf<Ev> = Ev extends { readonly origins: infer O } ? O : unknown
export declare namespace Evidence {
	/** What the type level falls back to when it cannot decide. */
	type Unknown = { readonly keys: unknown; readonly card: "many" }
}

/** A key over exactly the field names in K. Field order is immaterial to a key, so a key is the union of its names. */
type KeyOver<K extends string> = ReadonlyArray<K>

/**
 * What an attachment's stated delivery K claims of its child, whose evidence is ChildEv, under a parent of evidence
 * ParentEv and heading Head: unknown when the evidence proves it, a Refusal otherwise. Every child may be delivered as
 * an array; an Option needs a child proved at most one per parent, and the one child a child proved exactly one, card
 * "one" including an aggregate child whose group a reflexive self-match on parent-bound variables proves nonempty.
 * arm(F, Hd) needs the child to be the arm of handle Hd of an alternatives law keyed by the parent's key (ArmProof),
 * F the one parent head field that holds the discriminator of the parent's fact the key is of, its scope's, and Hd one
 * literal of F's type: the arm's
 * records whose F is not Hd are narrowed by `row[F] !== Hd`, a true predicate of Exclude<Head[F], Hd> only when Hd is
 * one value.
 */
export type DeliveryClaim<K, F, Hd, ChildEv, ParentEv, Head> = Claims<
	F,
	Hd,
	ChildEv,
	ParentEv,
	Head
>[K & keyof Claims<F, Hd, ChildEv, ParentEv, Head>]

interface Claims<F, Hd, ChildEv, ParentEv, Head> {
	readonly array: unknown
	readonly option: ChildEv extends { readonly card: "atMostOne" | "one" }
		? unknown
		: Refusal<"an Option needs a child the evidence proves at most one per parent">
	readonly one: ChildEv extends { readonly card: "one" }
		? unknown
		: Refusal<"the one child needs a child the evidence proves exactly one per parent">
	readonly arm: ArmClaim<F, Hd, ChildEv, ParentEv, Head>
}

type ArmClaim<F, Hd, ChildEv, ParentEv, Head> = ChildEv extends {
	readonly arm: ArmProof<infer PN, infer D, infer ArmHandle, infer N>
}
	? [HandleField<OriginsOf<ParentEv>, PN, D, N>] extends [F]
		? [F] extends [HandleField<OriginsOf<ParentEv>, PN, D, N>]
			? IsOneLiteral<Hd> extends true
				? [Hd] extends [ArmHandle]
					? [ArmHandle] extends [Hd]
						? Hd extends Head[F & keyof Head]
							? unknown
							: Refusal<"the arm's handle is a value of the parent field's type">
						: Refusal<"the arm's handle is the handle the child is the arm of">
					: Refusal<"the arm's handle is the handle the child is the arm of">
				: Refusal<"the arm's handle is one literal">
			: Refusal<"the arm's field is the parent's head field that holds its discriminator">
		: Refusal<"the arm's field is the parent's head field that holds its discriminator">
	: Refusal<"an arm needs a child that is the arm of one handle of an alternatives law, keyed by the parent's key">

/** The one parent head field whose origin is the parent relation's discriminator in scope N, the arm key's. */
type HandleField<O, PN, D, N> = {
	[K in keyof O]-?: O[K] extends Origin<PN & string, D & string, N & string> ? K : never
}[keyof O] extends infer F
	? [F] extends [never]
		? never
		: IsOneLiteral<F> extends true
			? F & string
			: never
	: never

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

/** Whether a match is of relation R and binds the variable of origin key Key at R's field F. */
type BindsAt<M, R, F, Key> =
	M extends SoleMatch<infer Src, infer B>
		? Src extends AnyRelation | AnyClosed | AnyDerived | AnyWorld | AnyContext
			? R extends NameOf<Src>
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
type MustState<X> = MustFix<X> | MustEqual<X>
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
 * (ContainmentProof), whether a reflexive self-match proves a nonempty group (ReflexiveProof), and the arm an
 * alternatives law makes it (ArmProofOf).
 */
export interface Proofs<out Contained extends true, out Reflexive extends boolean, out Arm> {
	readonly contained: Contained
	readonly reflexive: Reflexive
	readonly arm: Arm
}
type NoProofs = Proofs<never, false, never>

/**
 * The evidence of a finished head H over a rule whose head fields have the origins O and the values V (HeadValues),
 * whose clauses prove Pr, and whose keys are Keys (HeadKeys: each a union of head field names, wrapped as
 * `readonly [Fields]`, the empty one when the head is pinned); a producer's head reads its rule's bindings R.
 */
export type EvidenceOf<
	H,
	Keys,
	V,
	O = unknown,
	Pr extends Proofs<true, boolean, unknown> = NoProofs,
	R = never
> = [ProducerFields<H>] extends [never]
	? [AggregateFields<H>] extends [never]
		? PlainEvidence<
				[Keys] extends [never]
					? readonly [KeyOver<keyof H & string>]
					: readonly [KeyOver<keyof H & string>, ...ReadonlyArray<KeyOf<Keys>>],
				PinnedOrSplit<Keys, H, R>,
				O,
				Pr
			> &
				ValuesPart<V>
		: GroupedEvidence<
				Exclude<keyof H, AggregateFields<H> | ConstantFields<H>>,
				Keys,
				PinnedOrSplit<Keys, H, R>,
				O,
				Pr
			> &
				ValuesPart<V>
	: {
			readonly keys: readonly [KeyOver<keyof H & string>]
			readonly card: ProducedCard<H, R>
			readonly origins: O
		}

/**
 * What a rule binds, as a producer's head and a flagged filter's readings read it: its schema S, its occurrences Os,
 * what its filters state St, and its filters that are each one of several predicates (Sp, each a Split). An interface,
 * so a head that produces nothing and a rule that splits nothing never read it.
 */
export interface RuleBindings<out S, out Os, out St, out Sp> {
	readonly schema: S
	readonly occurrences: Os
	readonly stated: St
	readonly splits: Sp
}

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
 * Whether the head is pinned, at most one row per binding: by what the rule's filters state, or, a proof by cases, by
 * each reading of some one flagged filter (Split), every other filter at what all its readings state. That is one key
 * derivation per reading of each flagged filter, linear in them; a proof over several flagged filters read at once
 * would multiply them, and is not made.
 */
type PinnedOrSplit<Keys, H, R> = IsPinned<Keys> extends true ? true : SplitPinned<H, R>
type SplitPinned<H, R> =
	R extends RuleBindings<infer S, infer Os, infer St, infer Sp>
		? true extends PinnedBySplit<S, Os, H, St, Sp>
			? true
			: false
		: false
type PinnedBySplit<S, Os, H, St, Sp> =
	Sp extends Split<infer Rd> ? (false extends ReadingPins<S, Os, H, St, Rd> ? false : true) : never
type ReadingPins<S, Os, H, St, Rd> =
	Rd extends Reading<infer RS> ? IsPinned<HeadKeys<S, Os, H, St | RS>> : never

/**
 * A producer yields its facts per binding of its rule, the rule's whole region, which no projection onto the head
 * narrows (check/checker.ts #produceNode): an intersection at most one per binding, so at most one where every variable
 * the rule binds is pinned (RegionHead); a difference up to two and a pack any number (logical/props.ts Produce).
 */
type ProducedCard<H, R> = H[ProducerFields<H>] extends { readonly produces: "intersection" }
	? R extends RuleBindings<infer S, infer Os, infer St, unknown>
		? IsPinned<HeadKeys<S, Os, RegionHead<Os>, St>> extends true
			? "atMostOne"
			: "many"
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
 * as the engine reads a union (logical/props.ts unionProps): a field both fix to one value is fixed in the union, so
 * when every field is, the union is at most one row per binding; and a key of each, joined with a field the two fix to
 * different literals, which tells their rows apart, is a key of the union. Arms of different headings, whose rows are
 * of several heading groups, are evidence unknown: so is a union whose earlier arms are, read by each record of H1.
 */
export type UnionEvidence<Ev1, Ev2, H1, H2> = false extends (
	H1 extends unknown ? (H2 extends unknown ? SameValue<keyof H1, keyof H2> : never) : never
)
	? Evidence.Unknown
	: UnionOf<ValuesOf<Ev1>, ValuesOf<Ev2>, keyof H2 & string, KeyMembers<Ev1>, KeyMembers<Ev2>>
type ValuesOf<Ev> = Ev extends { readonly values: infer V } ? V : object
/** An evidence's keys, each a KeyOver, none where they are unknown. */
type KeyMembers<Ev> = Ev extends { readonly keys: infer K }
	? unknown extends K
		? never
		: K extends ReadonlyArray<infer E>
			? E
			: never
	: never

type UnionOf<V1, V2, F extends string, K1, K2> = UnionWith<
	Alike<V1, V2>,
	F,
	| ([Exclude<F, keyof Alike<V1, V2>>] extends [never] ? KeyOver<never> : never)
	| TellApart<K1, K2, Separators<V1, V2>>
>

/** The union's keys: its whole heading, the empty key when every field is fixed alike, and the keys told apart. */
type UnionWith<A, F extends string, Keys> = {
	readonly keys: [Keys] extends [never]
		? readonly [KeyOver<F>]
		: readonly [KeyOver<F>, ...ReadonlyArray<Keys>]
	readonly card: [Exclude<F, keyof A>] extends [never] ? "atMostOne" : "many"
} & ValuesPart<A>

/** The fields both fix to one value, a name they share, with every name they share. */
type Alike<V1, V2> = {
	readonly [
		K in keyof V1 & keyof V2 as [Extract<V1[K], V2[K]>] extends [never] ? never : K
	]: Extract<V1[K], V2[K]>
}
type SameValue<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/**
 * The fields each fixes to one literal, the two different: an arm whose names hold two literals at a field holds no row,
 * and tells nothing apart there.
 */
type Separators<V1, V2> = {
	[K in keyof V1 & keyof V2]-?: IsSingle<Extract<V1[K], Literal>> extends true
		? IsSingle<Extract<V2[K], Literal>> extends true
			? SameValue<Extract<V1[K], Literal>, Extract<V2[K], Literal>> extends true
				? never
				: K
			: never
		: never
}[keyof V1 & keyof V2]

/** Each key of one with each key of the other and a separator: a key of both whose rows the separator tells apart. */
type TellApart<K1, K2, Sep> =
	K1 extends ReadonlyArray<infer A>
		? K2 extends ReadonlyArray<infer B>
			? Sep extends string
				? KeyOver<(A & string) | (B & string) | Sep>
				: never
			: never
		: never

/** A wrapped key as the key over its fields. */
type KeyOf<K> = K extends readonly [infer F] ? KeyOver<F & string> : never
/** Whether the empty key is among the keys: the head has at most one row per input binding. */
type IsPinned<Keys> = [Extract<Keys, readonly [never]>] extends [never] ? false : true

/**
 * A plain head: one where a containment proves it, an Option otherwise when pinned, and an arm's Option records the
 * arm.
 */
type PlainEvidence<Keys, Pinned extends boolean, O, Pr> = Pinned extends true
	? Pr extends Proofs<infer C, boolean, infer A>
		? [C] extends [never]
			? [A] extends [never]
				? { readonly keys: Keys; readonly card: "atMostOne"; readonly origins: O }
				: { readonly keys: Keys; readonly card: "atMostOne"; readonly origins: O; readonly arm: A }
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
	readonly card: Pr extends Proofs<true, true, unknown>
		? "one"
		: Pinned extends true
			? "atMostOne"
			: "many"
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
> = MinimalOf<
	Passing<
		Candidates<S, Os, H, FixedFields>,
		H,
		DepsOf<S, Os[number], FixedFields> | Stated,
		FixedFields
	>
>

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
	M extends SoleMatch<infer R, infer B>
		? R extends AnyRelation | AnyClosed | AnyDerived | AnyWorld | AnyContext
			? KeyDeps<KeysOf<S, R>, B, FixedFields, BoundOrigins<B>, never>
			: KeyDeps<SourceKeys<R>, B, FixedFields, BoundOrigins<B>, SourceNeeds<R, FixedFields>>
		: never

/**
 * One dependency per key whose fields are all bound: from what the bound terms need, and what the source's own inputs
 * need (Extra), to To.
 */
type KeyDeps<Keys, B, FixedFields extends string, To, Extra> = 0 extends 1 & Keys
	? never
	: Keys extends ReadonlyArray<infer F extends string>
		? DepFrom<{ [K in F]-?: K extends keyof B ? Needs<B[K], FixedFields> : Lost }[F] | Extra, To>
		: never

/**
 * The keys of a source that is no relation, as a match of it reads them: its whole heading, every field of every arm,
 * since it is a set; and, for a query, a bound import or an interior stage, every key its own evidence proves, which
 * holds per binding of the inputs it reads (SourceNeeds). A relation parameter, a recursive definition's self and a
 * delta are keyed by their heading alone.
 */
type SourceKeys<R> =
	| ReadonlyArray<KeyOfAnyArm<HeadingOf<R>> & string>
	| (R extends Phantom<{ readonly evidence: { readonly keys: infer Ks } }>
			? Ks extends ReadonlyArray<infer K extends ReadonlyArray<string>>
				? K
				: never
			: never)
type KeyOfAnyArm<H> = H extends unknown ? keyof H : never

/**
 * What a bound import's facts depend on beside its keys: the variables its bindings read, whose values select which
 * facts it holds (BoundSource's `reads`); nothing for any other source, whose inputs are the rule's own parameters.
 */
type SourceNeeds<R, FixedFields extends string> =
	R extends Phantom<{ readonly reads: infer Rd }> ? OriginNeeds<Rd, FixedFields> : never
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

/** The head fields holding a non-input term of origin key Key. */
type HeadFieldsOf<H, Key> = {
	[N in keyof H]-?: H[N] extends Phantom<{ readonly origin: infer HO }>
		? [HO] extends [InputOrigin]
			? never
			: OriginKey<H[N]> extends Key
				? [Key] extends [OriginKey<H[N]>]
					? N
					: never
				: never
		: never
}[keyof H]

/**
 * One match's candidate parts: nothing, or the head fields holding one of its keys' variables, with those holding what
 * a bound import's bindings read.
 */
type Choices<S, M, H, FixedFields extends string> =
	| readonly [never]
	| (M extends SoleMatch<infer R, infer B>
			? R extends AnyRelation | AnyClosed | AnyDerived | AnyWorld | AnyContext
				? KeyChoices<KeysOf<S, R>, B, H, FixedFields, never>
				: KeyChoices<SourceKeys<R>, B, H, FixedFields, SourceNeeds<R, FixedFields>>
			: never)

type KeyChoices<Keys, B, H, FixedFields extends string, Extra> = 0 extends 1 & Keys
	? never
	: Keys extends ReadonlyArray<infer F extends string>
		? HeadSet<
				| { [K in F]-?: K extends keyof B ? HeadFieldsAt<Needs<B[K], FixedFields>, H> : Lost }[F]
				| HeadFieldsAt<Extra, H>
			>
		: never
/** The head fields holding each variable a key field needs, Lost when one is held by none or the field is Lost. */
type HeadFieldsAt<Need, H> = Lost extends Need ? Lost : HeadFieldsEach<Need, H>
type HeadFieldsEach<Need, H> = Need extends string
	? [HeadFieldsOf<H, Need>] extends [never]
		? Lost
		: HeadFieldsOf<H, Need>
	: never
type HeadSet<Fields> = Lost extends Fields ? never : readonly [Fields]
type Cross<A, B> = A extends readonly [infer X]
	? B extends readonly [infer Y]
		? readonly [X | Y]
		: never
	: never

/** Every combination of one choice per match. */
type Candidates<S, Os, H, FixedFields extends string> = Os extends readonly [infer M, ...infer Rest]
	? Cross<Choices<S, M, H, FixedFields>, Candidates<S, Rest, H, FixedFields>>
	: readonly [never]
/** The head fields that need determining: every field but an aggregate. */
type TargetFields<H> = Exclude<keyof H, AggregateFields<H>>
/** The origin keys of the head fields C holds. */
type OriginsOfFields<H, C> = { [N in keyof H & C]-?: OriginKey<H[N]> }[keyof H & C]
/**
 * The candidates whose closure holds every head field: a field in the candidate, or a term whose needs are reached (an
 * input, a variable reached, a computation over variables reached).
 */
type Passing<Cs, H, Deps, FixedFields extends string> = Cs extends readonly [infer C]
	? Covers<
			H,
			C,
			Closure<Deps, (OriginsOfFields<H, C> & string) | FixedFields>,
			FixedFields
		> extends true
		? Cs
		: never
	: never

type Covers<H, C, Known extends string, FixedFields extends string> = false extends {
	[N in TargetFields<H>]-?: N extends C ? true : DeterminedBy<Needs<H[N], FixedFields>, Known>
}[TargetFields<H>]
	? false
	: true

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
 * is at most one fact after any take, and the handle reads no arm's Option after it as Some or None.
 */
export type TakeEvidence<Ev extends Evidence, K> = K extends 1
	? { readonly keys: Ev["keys"]; readonly card: "atMostOne" } & OriginsPart<Ev>
	: Ev["card"] extends "one"
		? { readonly keys: Ev["keys"]; readonly card: "atMostOne" } & OriginsPart<Ev>
		: Ev extends { readonly arm: unknown }
			? { readonly keys: Ev["keys"]; readonly card: Ev["card"] } & OriginsPart<Ev>
			: Ev

/** The origins an evidence carries, as the part of another evidence that keeps them: absent where it carries none. */
type OriginsPart<Ev> = Ev extends { readonly origins: infer O extends OriginMap }
	? { readonly origins: O }
	: unknown
export type TakeOneEvidence<Ev extends Evidence> = TakeEvidence<Ev, 1>

/**
 * The rule's only match, while it is the rule's only clause: no second match and no where ("the child has
 * no further predicate"). NoMatch before any match, Joined after anything more.
 */
export interface SoleMatch<R, B> {
	readonly sole: R
	readonly bindings: B
}

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
/** Whether the fields U are exactly one key of R. */
type IsKeyOf<S, R, U> = true extends KeyEquals<KeysOf<S, R>, U> ? true : false
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
type KeyedByParent<S, R, B, H> = R extends AnyRelation | AnyClosed
	? "other" extends BindingKinds<B, NameOf<R>>[keyof B]
		? false
		: HeadParentsBound<H, B, NameOf<R>> extends true
			? IsKeyOf<S, R, ParentFields<B, NameOf<R>>>
			: false
	: false

/**
 * The containment row of the attach table: the child's only clause is a match keyed by the parent (KeyedByParent), and
 * S declares contained(on(Parent, ...from), on(R, ...to)) with `to` exactly the parent-bound fields and each `to` field
 * bound to the parent variable of origin Parent.from at the same position, every one of one scope, so of one fact of
 * Parent. The result is true where one proves the child, never otherwise. A span coverage law proves coverage, not
 * scalar existence, and a selected source needs the parent's selection, so neither proves.
 */
export type ContainmentProof<S, Sole, H> =
	Sole extends SoleMatch<infer R, infer B>
		? KeyedByParent<S, R, B, H> extends true
			? ContainmentsInto<ContainmentsBetween<S, ParentRelations<B>, NameOf<R>>, NameOf<R>, B>
			: never
		: never

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
 * The alternatives row of the attach table: the child's only clause is a match of an arm relation keyed by the parent
 * (KeyedByParent), and S declares alternatives(parentKey, D, roster, arms) whose arm at a handle is that relation,
 * with the arm key exactly the parent-bound fields, each bound to the parent variable of origin Parent.parentKey at
 * the same position, every one of one scope, whose fact's discriminator the arm's handle is read against (ArmClaim).
 * The arm exists exactly for the parent facts of that handle: the law's expansion mirrors the parent's facts selected
 * by that handle with the arm. The handle is read from the alternatives value's arm map, since a selection's
 * predicate is its Description's, which no type reads.
 */
export type ArmProofOf<S, Sole, H> =
	Sole extends SoleMatch<infer R, infer B>
		? KeyedByParent<S, R, B, H> extends true
			? ArmsOf<AlternativesBetween<S, ParentRelations<B>, NameOf<R>>, NameOf<R>, B>
			: never
		: never

/**
 * S's alternatives laws, each under the pair of names `${parent} ${arm}` for every arm relation it names, and none under
 * any other pair: built once per schema, so a proof reads the laws that make the matched relation an arm of the
 * parent's relation by name, as ContainmentIndexOf reads containments.
 */
type AlternativesIndexOf<S> = {
	readonly [A in Extract<StatementsOf<S>[number], AlternativesBase> as AlternativesPairs<A>]: A
} & { readonly [pair: string]: never }

type AlternativesPairs<A> =
	A extends Alternatives<infer PK, string, unknown, infer Arms>
		? `${NameOf<RelationOfKey<PK>>} ${NameOf<RelationOfKey<Exclude<Arms[keyof Arms], undefined>>>}`
		: never

/** The alternatives laws S declares over one of the relations named PN with an arm the relation named RN. */
type AlternativesBetween<S, PN, RN extends string> = PN extends string
	? AlternativesIndexOf<S>[`${PN} ${RN}`]
	: never

type ArmsOf<A, RN, B> =
	A extends Alternatives<infer PK, infer D, unknown, infer Arms>
		? {
				[Hd in keyof Arms & string]-?: ArmAt<
					RelationOfKey<PK>,
					KeyFieldsOf<PK>,
					D,
					Hd,
					Exclude<Arms[Hd], undefined>,
					RN,
					B
				>
			}[keyof Arms & string]
		: never

/**
 * The arm at handle Hd of an alternatives law over parent P keyed by PKF, discriminated by D, when it is the matched
 * relation RN keyed by the parent: a handle and a discriminator that are no single literal tell no arm apart.
 */
type ArmAt<P, PKF, D extends string, Hd extends string, A, RN, B> =
	RelationOfKey<A> extends infer Arm extends AnyRelation
		? NameOf<Arm> extends RN
			? KeyFieldsOf<A> extends infer AKF extends ReadonlyArray<string>
				? SameSet<AKF[number], ParentFields<B, RN>> extends true
					? ParentsAt<B, AKF, NameOf<P>, PKF, SharedScope<B, AKF>> extends true
						? IsSingle<D> extends true
							? string extends Hd
								? never
								: ArmProof<NameOf<P> & string, D, Hd, SharedScope<B, AKF> & string>
							: never
						: never
					: never
				: never
			: never
		: never

/**
 * The reflexive row of the attach table, as logical/attach.ts reflexiveOne reads it: the
 * child's only match is of a stored or derived relation R; every binding is a parent variable at the field its origin
 * names, or a variable of the child no other binding shares; the head's group terms are all parent variables; at least
 * one parent variable is read; every parent variable read has its origin in R, all in one scope; and every filter is
 * true when the child's fact is the parent's own: a variable bound at field f, and a parent variable of origin R.f,
 * both read the fact's f, so `r.le(t.id, s.id)` holds and `r.lt(t.at, s.at)` fails. A scope's origins are fields of
 * one fact (terms.ts HeadOrigins), so every parent variable of origin R in that scope reads the one fact, and over a
 * self-join parent each scope proves its own fact's group.
 */
export type ReflexiveProof<Occurrences, Filters, H> = Occurrences extends readonly [
	SoleMatch<infer R, infer B>
]
	? R extends AnyRelation | AnyDerived
		? ReflexiveOf<NameOf<R>, B, Filters, H>
		: false
	: false

type ReflexiveOf<RN, B, Filters, H> =
	ReflexiveBindings<B, RN> extends true
		? GroupTermsAreParents<H, RN> extends true
			? Filters extends ReadonlyArray<unknown>
				? true extends ReadsParent<B, H, Filters>
					? IsOneLiteral<ScopesRead<B, H, Filters>> extends true
						? AllTrue<Filters, { readonly relation: RN; readonly bindings: B }>
						: false
					: false
				: false
			: false
		: false

/** The scopes of every parent variable the child reads: in its bindings, its head and its filters. */
type ScopesRead<B, H, Filters> =
	| ScopeOf<B[keyof B]>
	| ScopeOf<H[keyof H]>
	| (Filters extends ReadonlyArray<infer P> ? ShapeScopes<ShapeOf<P>> : never)

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

/** The scopes of the parent variables a shape reads. */
type ShapeScopes<Sh> =
	Sh extends Comparison<ComparisonOp, infer A, infer B>
		? ScopeOf<A> | ScopeOf<B>
		: Sh extends Conjunction<infer Ps>
			? ListScopes<Ps>
			: Sh extends Disjunction<infer Ps>
				? ListScopes<Ps>
				: Sh extends Opaque<infer Terms>
					? Terms extends ReadonlyArray<infer T>
						? ScopeOf<T>
						: never
					: never
type ListScopes<Ps> = Ps extends ReadonlyArray<infer P> ? ShapeScopes<ShapeOf<P>> : never
