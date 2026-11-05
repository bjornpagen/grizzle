/**
 * The type-level public API, whose shared phantom primitives this module declares.
 *
 * Each directory of types/ declares the full signatures of one area: core, schema, fields, compute, query, evidence,
 * db, changeset, derived, page and vector. The runtime values (relation, query, ChangeSet, Compute, ...) live in the
 * modules that implement them, and the public barrels (public/) bind them to these signatures; the shell types Db in
 * packages/grizzle/src/adapter/types/db.ts. An implementation may sharpen an approximation but keeps the shapes;
 * widening a type is always sound, narrowing one needs the evidence to be proved.
 *
 * Design note
 *
 * 1. Phantom P threading. The parameters a query needs are read from the terms it uses, never an open map of unknown
 *    values. Every term, predicate, aggregate and producer carries a phantom parameter map P (below).
 *    `r.param("account", uuid)` is a term of uuid's host type whose map is `{ account: Uuid }`; it meets a term of
 *    exactly its type (`r.param("amount", Cents)` for a Cents field), and stands wherever a term of its type stands,
 *    first included, since the Description records its descriptor. Each Rule method intersects the maps of its operands into
 *    `Rule<S, P>`, find carries P into Finished, and QueryBuilder.rule into `Query<S, Head, Ev, P>`;
 *    ParamsOf<Q> reads it back. A relation parameter, `r.relation(name, heading)`, is a ParamSource whose matching
 *    contributes `{ name: ReadonlyArray<Row> | Stream<Row> }`. A parameterized query is
 *    matched only through Q.bind: match refuses a source whose `params` is nonempty, bind refuses one bound to a
 *    relation parameter the same way, and bind requires every parameter and passes outer parameters through at the
 *    inner parameter's type. Query, Ordered and ChangeSet also carry P invariantly (`paramsInvariant`), so a value that
 *    needs parameters never passes for one that needs none, which is what a bound ChangeSet and match's refusal rely
 *    on. Compatible uses of one name unify by intersection, so incompatible uses leave a parameter no value can
 *    satisfy.
 *
 * 2. Origin brands. `v(Task, "task").id` is `Term<Uuid, unknown, Origin<"Task", "id", "task">>`: every variable names
 *    the relation and field it came from and its scope, the name v was given, so two scopes of one relation are two
 *    types. A rule records which origins its matches witness, a variable bound at the very field it was minted from,
 *    and a query's evidence carries the witnessed origin of each head field, per scope, where one match's fact holds
 *    every head variable of the scope (HeadOrigins), so a scope's origins are fields of one fact and a self-join's two
 *    scopes are two facts. Parent variables inside attach are `InputOrigin` terms that keep
 *    that origin (ParentVars): a key of a matched relation bound entirely to inputs (literals, parameters, parent
 *    variables) pins that occurrence to at most one fact per input binding, and a declared containment from the parent
 *    fields of one scope onto the key proves exactly one. An origin names one variable of its rule, since a rule holds
 *    one scope of each name, so a key's variables may be bound through other matches, a self-join's two scopes included:
 *    the head's keys are what its variables determine under every match's keys (HeadKeys), and the empty key, every head
 *    variable determined by the inputs, makes a keyed lookup and a keyed attachment atMostOne (evidence/evidence.ts). A
 *    Compute expression's origin is the variables it reads (ComputedOrigin), so a computed term is determined wherever
 *    they are. The host type T of a term is invariant, so a contract never silently widens to its base in a join or
 *    comparison; a JavaScript value adopts the base (LiteralOf); a constant's T is its domain and its column its value.
 *    A scope's name keeps the declared-name rule in its type (DeclaredName), so a name the builder refuses never types.
 *
 * 3. The seven statement-tuple readers. `schema(name, relations, statements)` captures its statements as a const
 *    tuple, and statement values carry the types they name. That one type parameter is read seven times,
 *    each through a projection that is a property read, one Extract over the tuple's element union, or
 *    a lookup in an index built once per schema, never a recursion over the schema graph:
 *    - attach: DeliveryClaim checks the stated delivery against the child's evidence, which reads KeysOf through
 *      HeadKeys and ContainmentsOf through ContainmentProof;
 *    - get: QueryReader.get accepts a query whose evidence card is atMostOne or one;
 *    - alternatives: ArmsCompatible checks each arm's key against the parent key, and DiscriminatorsOf the
 *      discriminator against the roster;
 *    - derived: KeysOf reads a derived relation's keys from its definition's evidence, which pin a match on it like
 *      declared keys (HeadKeys), and the statement constructors
 *      refuse a derived relation (kind "derived"), which is LawOnDerived at the type level;
 *    - apply: WriteListOf<R> reads the opened role's write list, and db.apply and compile refuse a ChangeSet
 *      whose Writes lie outside it; RefreshListOf does the same for db.refresh;
 *    - orderBy: DeliveredKeys, the columns the query delivers; the retained key that completes the order is the
 *      compiler's;
 *    - mirrors and contained: SidesCompatible compares the two sides' fields position by position, by domain and
 *      PostgreSQL type, so contract and roster identity count, two text patterns join, and text never joins uuid.
 *
 * 4. Query invariance. Query, Ordered and ChangeSet carry their schema as `schema: Invariant<S>`, a phantom
 *    `(s: S) => S` whose variance TypeScript measures reliably, so Query<Ext> is never a Query<Base> and a derived
 *    definition cannot read its own level. Schema records the schema it extends (`extends`), and
 *    LevelsOf<S> is S and every level below it. Where a query over a base must stand for a query over an
 *    extension, the consumer is generic over a level: `execute<L extends LevelsOf<S>, ...>(query: Query<L, ...>)` on
 *    every reader, the same on db.apply, compile, plan and explain, and level unions (QueryAt<LevelsOf<S>>) for
 *    attachment children, ChangeSet members, read-backs and the workload. ChangeSet.union and sequence take a schema
 *    per argument and are over the higher of them (HigherLevel), refusing schemas of which neither is a level of the
 *    other. schema.extend accepts a derived relation only over a level of
 *    its base, and Rule<S>.match accepts only relations of S and sources over a level of S: a query,
 *    a bound import (Q.bind keeps the query's schema) and an interior stage are SchemaSources carrying their schema
 *    invariantly, IsLevelOf compares it with each level invariantly, and a relation parameter bound to a source is
 *    checked against the imported query's levels, so no import reads a level above the importing rule's schema. An
 *    arm's attachment child is over a level of its rule's schema, as for Query.attach. A contravariant phantom over the
 *    relations record would express "a query over a base is a query over an extension" as plain assignability, but
 *    TypeScript compares a measured variance on the whole type argument, and an extension's statement tuple is not
 *    assignable to its base's, so the reading would hold only where variance measurement fails; invariance plus
 *    level-generic consumers holds everywhere.
 *
 * 5. Db.open opens a role reached through its login. The layer cannot say which role: it is the Effect's
 *    requirement, an output of the call, from which TypeScript cannot infer a type argument. `Db.open(Web.roles.user,
 *    { token })` names the role, with the programs of the login's workloads it runs (LoginRole's phantom); its
 *    requirement DbLayer<UserBlog> is provided only by the layer of the login that holds the role (DbLayerOf), and its
 *    options require a token exactly when the role's relations read a context (ReadsContext over the contexts phantom
 *    its query entries carry). The runtime reads the role's login off the value it was given and fails with OpenError
 *    at stage `role` when no provided layer serves it.
 *
 * Type cost. Readers of the statement tuple go through per-schema indexes (KeyIndexOf, RelationIndexOf) built once
 * per schema, so a match costs a property lookup, not a pass over every statement. One cost remains linear in the
 * schema per generic call: a call whose return type mentions S (QueryBuilder.rule, Rule.match, ChangeSet.insert)
 * instantiates that return type with a fresh mapper, and TypeScript walks every object-literal type inside S (the
 * relations record, each relation's fields) because such types may contain type variables. The harness in
 * test/types/skeleton records the resulting growth.
 *
 * Approximations that may be sharpened later, each of which widens soundly today: key retention through find by origin,
 * and the attach proofs, which read the same shapes logical/attach.ts reads, so a delivery the type licenses an
 * attachment to state is one the analysis licenses its decoder to bind (evidence/evidence.ts); they read a parent's
 * fields by scope, so a variable of one scope that the other scope's match also binds at its own field, a field of
 * both facts to the analysis, proves with its own scope's fields alone; a union's arms keep no head origins. A query
 * carries the decoders of its heading for snapshot reads and of its immediate heading for reads inside a write
 * transaction (query/query.ts HeadOf, ImmediateHeadOf).
 */
import type { Brand, Stream } from "effect"
import type { Column, FieldHost } from "#compiler/core/decoder.ts"
import type {
	Built,
	constants,
	Domained,
	Languaged,
	Phantom,
	phantom,
	Proving,
	retyped
} from "#compiler/core/phantom.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { Vector } from "#compiler/scalar/values/vector.ts"

/**
 * Where a variable came from: the relation and field `v` read it from, and the scope N it minted the variable in, the
 * name it was given, which tells two scopes of one relation apart. Key retention through `find` is decided from it.
 */
export interface Origin<
	out R extends string = string,
	out F extends string = string,
	out N extends string = string
> {
	readonly relation: R
	readonly field: F
	readonly scope: N
}

/**
 * A term the rule receives rather than binds: a parameter, a constant, or a parent variable inside `attach`. A key
 * bound entirely to inputs pins its occurrence to at most one fact per input binding.
 */
export interface InputOrigin {
	readonly input: true
}

/**
 * A parameter, `r.param(name, descriptor)`: an input term of its descriptor's host type and facts. The Description
 * records a parameter by name and descriptor, so it stands wherever a term of its type stands, first included.
 */
export interface ParamOrigin extends InputOrigin {
	readonly param: true
}

/**
 * A JavaScript value in a head, as find holds it (HeadTerms): an input term of the value's own type. The Description
 * records it by value, untyped, and the checker types it from what it meets, so like a parameter it never stands
 * first.
 */
export interface LiteralOrigin extends InputOrigin {
	readonly literal: true
}

/** A typed constant, X.handle(member) or Compute.literal(F, x): an input of its stated type, which may stand first. */
export interface ConstantOrigin extends InputOrigin {
	readonly constant: true
}

/**
 * A computation's origin, a Compute expression's or a predicate's: Operands is the union of its operands' origins
 * (OperandOrigin), so its value is a function of the variables they read, through computations too, and it is
 * determined wherever they are, as logical/props.ts reads a computed output from the columns it reads. A computation
 * over inputs alone reads no variable and is fixed per binding; one over an operand of unknown origin is
 * ComputedOrigin<unknown>, which nothing determines. Holding the operands' origins, not a conditional type over them,
 * keeps it covariant in each, as a Scalar's comparison methods need; evidence/evidence.ts Needs reads it.
 */
export interface ComputedOrigin<out Operands> {
	readonly computed: Operands
}

/** The origin of a computation's operand: a term's or a predicate's own, and a JavaScript value's LiteralOrigin. */
export type OperandOrigin<X> = X extends TermBase | PredicateBase ? OriginOfTerm<X> : LiteralOrigin

/**
 * Any term: the members every runtime term has. A term records its expression, its column and its SQL type; it is
 * never a predicate.
 */
export interface TermBase extends Built {
	readonly expr: OpenExpr
	readonly column: Column<unknown>
	readonly sql: SqlTag
	readonly predicate?: undefined
}

/**
 * The phantom primitives every area threads: the public phantom types of scalar expressions and their supporting
 * types. Declare-only, except `typeRefusals`, the closed vocabulary the type tests read at run time; brands carry no
 * behavior.
 *
 * Three phantoms ride on every scalar term:
 *
 * - T, the domain, is invariant: the host type the term meets columns, operands and joins at, the host type of its SQL
 *   type, which it states again as a carrier's domain (Domained). A contract and its bare base are incompatible in
 *   joins, comparisons and containments, and a covariant T would let inference widen `Term<Cents>` to `Term<bigint>`.
 * - P, the parameter map, is what the term needs bound before it can run: `unknown` for a variable or a constant,
 *   `{ account: Uuid }` for `r.param("account", uuid)`. Every combinator intersects the maps of its operands, so a
 *   rule's parameters are the union of the parameters its terms use.
 * - O, the origin, says where a term came from: `Origin<"Task", "id", "task">` for `v(Task, "task").id`,
 *   `InputOrigin` for a parent variable inside `attach`, `ParamOrigin` for a parameter, `ConstantOrigin` for a typed
 *   constant, `LiteralOrigin` for a JavaScript value in a head, `ComputedOrigin` of the variables a Compute expression
 *   or a predicate reads, and `unknown` when nothing is known.
 *
 * None of the three is a runtime member. Every phantom of the type vocabulary rides under one declared symbol that no
 * runtime value holds, as an optional member (Phantom): a runtime value that has a type's real members has the type,
 * and the member's type keeps the variance, `Invariant<T>` for an invariant domain. The real members stay required: a
 * term's `expr`, its `column` (the conversion of a cell into V, which a head reads it with) and its SQL type `sql`,
 * which Compute and aggregate result types are read off; a predicate's `predicate` and `expr`. A phantom is read
 * through the bundle that holds it (TypeOfTerm, OriginOfTerm, ParamsOfTerm), never by inferring a term's parameters.
 *
 * A scalar term: a variable from `v`, a parameter, a constant, or a Compute expression. Its type is one descriptor,
 * the type-level mirror of the engine's ScalarType (ir/scalar.ts): T, its identity, every component the checker's
 * `compatible` reads (scalar/compute/types.ts): a contract's brand, a roster's (Rostered), a vector's dimensions, a
 * span's endpoint, and the facts its values are proved to have (F); Sql, its carrier's SQL type; and V, the values its
 * column delivers: T, but for a constant, whose own value it is (`X.handle("Published")` is a term of X's enum whose
 * column delivers "Published"), and for a variable minted over a carrier whose values are narrower than its domain;
 * and L, its language, every value of its type, which a JavaScript value opposite it is one of (Languaged): V, but for
 * a constant and a variable minted over a constant's column, whose type has more values than they deliver. A refined
 * text's identity is text, which every pattern meets, and its language the pattern's (ArkRegex's inference, RegexInfer);
 * a uuid's identity and language are uuid_out's spelling (Uuid). Every position takes a term through one relation,
 * Meets, and a JavaScript value by the language of the term it stands opposite.
 */
export interface Term<
	in out T,
	out P = unknown,
	out O = unknown,
	out Sql extends SqlTag = SqlTag,
	out V = T,
	out F extends Facts = Facts,
	out L = V
>
	extends
		TermBase,
		Domained<T>,
		Proving<F>,
		Languaged<L>,
		Phantom<{ readonly type: Invariant<T>; readonly params: P; readonly origin: O }> {
	readonly column: Column<V>
	readonly sql: Sql
}

/**
 * The one relation a position takes a term by, as the engine's `meets` meets two types (scalar/compute/types.ts): a
 * term meets the type (T, Sql) when its identity is exactly T, invariantly, and its SQL type is Sql, whatever its values
 * and language (a roster's variable delivers its handles unbranded, and a refined text's its pattern's language); and
 * an exact value meets the plain integers or money of its family and they it, exactly (ExactFamily), which the engine
 * widens into the exact carrier. A binding, an operand, a Compute operand, a conditional's branch, a span operand, a
 * parent variable and a check's comparison each state the type they take through it, and a union's arms meet key by
 * key through it (ArmsMeet).
 */
export type Meets<T, Sql extends SqlTag> = InputTerm<T, unknown, unknown, Sql> | ExactFamily<T, Sql>

/** Whether A is B exactly: a plain number, bigint or Money, never a brand of one. */
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * The terms of the other side of an exact family a type (T, Sql) meets: an exact integer the plain integers and they
 * it, exact money plain money and it exact money, as values, exactly; a contract meets no exact value without
 * Compute.base.
 */
type ExactFamily<T, Sql extends SqlTag> = [Sql] extends ["exact integer"]
	?
			| InputTerm<number, unknown, unknown, "smallint" | "integer">
			| InputTerm<bigint, unknown, unknown, "bigint">
	: [Sql] extends ["exact money"]
		? InputTerm<Money, unknown, unknown, "money">
		: [Sql] extends ["smallint" | "integer"]
			? IsExactly<T, number> extends true
				? InputTerm<bigint, unknown, unknown, "exact integer">
				: never
			: [Sql] extends ["bigint"]
				? IsExactly<T, bigint> extends true
					? InputTerm<bigint, unknown, unknown, "exact integer">
					: never
				: [Sql] extends ["money"]
					? IsExactly<T, Money> extends true
						? InputTerm<Money, unknown, unknown, "exact money">
						: never
					: never

/**
 * A term in an input position: of type (T, Sql), its parameters P and origin O read off it, whatever values its column
 * delivers or language it admits, which are narrower than T for a roster's variable or a handle. Every parameter that
 * takes a term without returning its values is written through it, so none defaults them to T.
 */
export type InputTerm<T, P, O, Sql extends SqlTag> = Term<T, P, O, Sql, unknown, Facts, unknown>

/**
 * What a term's values are proved to have beside their type, each flag present only where proved: a contract's
 * predicate or a literal's value proves them, and a partial operation requires them. Every flag optional is nothing
 * proved, so more facts meet fewer.
 */
export interface Facts {
	readonly nonzero?: true
	readonly nonnegative?: true
	readonly finite?: true
}

/** A roster's identity in a domain: its closed relation's name, which tells two rosters of one member set apart. */
export type Rostered<Name extends string> = Brand.Brand<`roster ${Name}`>

/**
 * What carries a column and a SQL type: a descriptor or a term, an entry of a heading's record of carriers, from which
 * variables are minted. A is the values its column delivers; D its domain, F its values' facts and L its language,
 * which it states.
 */
export interface Carrier<
	out A = unknown,
	out Sql extends SqlTag = SqlTag,
	out D = A,
	out F extends Facts = Facts,
	out L = A
>
	extends Domained<D>, Proving<F>, Languaged<L> {
	readonly column: Column<A>
	readonly sql: Sql
}

/**
 * A JavaScript value's stated domain in a head: its JavaScript default's domain W at SQL type S, which a union's arms
 * that deliver the key by a term retype (UnionHeading), as the checker types a bare head literal by its position.
 */
export interface Retyped<out W, out S extends SqlTag> {
	readonly [retyped]: readonly [W, S]
}

/** A heading's record of carriers: a relation's fields, a closed relation's id and payload, a query's head. */
export interface Carriers {
	readonly [key: string]: Carrier
}

/** What a heading of carriers C is: the record of carriers a source value holds. */
export interface Headed<out C> {
	readonly heading: C
}
/** The SQL type a carrier states, SqlTag where it states none more precise. */
type StatedSql<X> = X extends { readonly sql: infer S extends SqlTag } ? S : SqlTag

/** The domain a carrier states: a type's identity, or a JavaScript value's Retyped. */
type StatedDomain<X> = X extends Domained<infer D> ? D : never

/** Whether a carrier is a JavaScript value's, or a union's of such arms only, whose type its position decides. */
export type IsRetyped<X> = [StatedDomain<X>] extends [Retyped<unknown, SqlTag>] ? true : false

/**
 * A carrier's domain: the identity it states, or a JavaScript value's default (Retyped) where nothing typed it. Every
 * position reads a carrier's domain here, and a variable minted over the carrier has it.
 */
export type DomainOf<X> = IsRetyped<X> extends true ? DefaultOf<StatedDomain<X>> : StatedDomain<X>
type DefaultOf<D> = D extends Retyped<infer W, SqlTag> ? W : never

/** A carrier's SQL type: the one it states, or a JavaScript value's default where nothing typed it. */
export type SqlOfCarrier<X> =
	IsRetyped<X> extends true ? DefaultSqlOf<StatedDomain<X>> : StatedSql<X>
type DefaultSqlOf<D> = D extends Retyped<unknown, infer S> ? S : never

/** The facts a carrier's or a term's values are proved to have: none where it states none. */
export type FactsOf<X> = X extends Proving<infer F extends Facts> ? F : Facts

/**
 * A carrier's or a term's language, the one it states: every value of its type, which a JavaScript value standing at
 * the carrier, or opposite the term or a variable minted over the carrier, is one of. A JavaScript value's is its
 * default type's.
 */
export type LanguageOf<X> = X extends Languaged<infer L> ? L : never

/**
 * The heading of a union of two arms' headings A and B: each key of either arm, carried by the union of the arms'
 * columns that have it, of the domain, SQL type and language the arms that deliver it by a term state, a JavaScript
 * value taking theirs (Retyped), as the checker retypes a bare head literal by its position; a key only JavaScript
 * values deliver keeps their defaults. A JavaScript value outside the typed arms' language widens the key's language
 * to its default's, as the checker's common type widens a refined text to text. A fact holds of the union's key only
 * where every arm proves it.
 */
export type UnionHeading<A, B> = {
	readonly [K in keyof A | keyof B]: ConstantsAt<A, B, K> &
		([TypedAt<A, K> | TypedAt<B, K>] extends [never]
			? Carrier<
					CarriedAt<A, K> | CarriedAt<B, K>,
					SqlAt<A, K> | SqlAt<B, K>,
					StatedAt<A, K> | StatedAt<B, K>,
					FactsAt<A, K> | FactsAt<B, K>,
					LanguageAt<A, K> | LanguageAt<B, K>
				>
			: Carrier<
					CarriedAt<A, K> | CarriedAt<B, K>,
					TypedSqlAt<A, K> | TypedSqlAt<B, K>,
					TypedAt<A, K> | TypedAt<B, K>,
					FactsAt<A, K> | FactsAt<B, K>,
					| TypedLanguageAt<A, K>
					| TypedLanguageAt<B, K>
					| WidenedLanguageAt<A, K, TypedLanguageAt<A, K> | TypedLanguageAt<B, K>>
					| WidenedLanguageAt<B, K, TypedLanguageAt<A, K> | TypedLanguageAt<B, K>>
				>)
}

/**
 * What a union carrier states when every arm holds a constant at its key: the constants' values, which tell the arms
 * apart (a discriminant, query.ts ArmsMeet).
 */
export interface Constants<out V> {
	readonly [constants]?: V | undefined
}
type ConstantsAt<A, B, K> = [ConstantValuesAt<A, K>] extends [never]
	? unknown
	: [ConstantValuesAt<B, K>] extends [never]
		? unknown
		: Constants<ConstantValuesAt<A, K> | ConstantValuesAt<B, K>>
type ConstantValuesAt<X, K> = K extends keyof X ? ConstantValuesOf<X[K]> : never
/**
 * The values a carrier holds as a constant in every arm: a JavaScript value's, a typed constant's, a union's whose arms
 * all hold one; never for any other carrier.
 */
export type ConstantValuesOf<X> =
	IsRetyped<X> extends true
		? FieldHost<X>
		: [OriginOfTerm<X>] extends [ConstantOrigin]
			? ValueOfTerm<X>
			: X extends { readonly [constants]?: infer V }
				? unknown extends V
					? never
					: Exclude<V, undefined>
				: never
type CarriedAt<X, K> = K extends keyof X ? FieldHost<X[K]> : never
type SqlAt<X, K> = K extends keyof X ? StatedSql<X[K]> : never
type StatedAt<X, K> = K extends keyof X ? StatedDomain<X[K]> : never
type FactsAt<X, K> = K extends keyof X ? FactsOf<X[K]> : never
type LanguageAt<X, K> = K extends keyof X ? LanguageOf<X[K]> : never
type TypedAt<X, K> = K extends keyof X
	? IsRetyped<X[K]> extends true
		? never
		: StatedDomain<X[K]>
	: never
type TypedSqlAt<X, K> = K extends keyof X
	? IsRetyped<X[K]> extends true
		? never
		: StatedSql<X[K]>
	: never
type TypedLanguageAt<X, K> = K extends keyof X
	? IsRetyped<X[K]> extends true
		? never
		: LanguageOf<X[K]>
	: never
/**
 * A JavaScript value's arm at a key typed arms of language L deliver: nothing when its value is of L, the type the
 * checker gives it, else its default's language, which the key's common type then holds.
 */
type WidenedLanguageAt<X, K, L> = K extends keyof X
	? IsRetyped<X[K]> extends true
		? [FieldHost<X[K]>] extends [BaseOf<L>]
			? never
			: LanguageOf<X[K]>
		: never
	: never

/**
 * The record of terms schema/record.ts's mint makes over carriers F: each key's term of its carrier's domain and SQL
 * type (DomainOf, SqlOfCarrier), whose column delivers its carrier's values, whose values have its facts and whose
 * language is its, its origin read from Origins, a phantom. A key carried by nothing, a head entry find refused
 * (query/terms.ts HeadTerms), mints never, which stands wherever a term does: the refusal is its one diagnostic.
 */
export type Minted<F, Origins> = {
	readonly [K in keyof F]: [F[K]] extends [never]
		? never
		: Term<
				DomainOf<F[K]>,
				unknown,
				K extends keyof Origins ? Origins[K] : unknown,
				SqlOfCarrier<F[K]>,
				FieldHost<F[K]>,
				FactsOf<F[K]>,
				LanguageOf<F[K]>
			>
}

/** Any predicate: the members every runtime predicate has. */
export interface PredicateBase extends Built {
	readonly predicate: true
	readonly expr: OpenExpr
}

/**
 * A non-null SQL Boolean expression, the parameters it needs, and its origin: a comparison, a connective or a span
 * predicate is a computation over its operands (ComputedOrigin), and a relational negation, which reads a relation,
 * has the unknown origin.
 */
export interface Predicate<out P = unknown, out O = unknown>
	extends PredicateBase, Phantom<{ readonly params: P; readonly origin: O }> {}

/**
 * Anything `match` consumes. SP is what the source contributes to the parameters of a rule that
 * matches it: a relation parameter contributes its own name, a bound query the parameters its bindings use.
 */
export interface Source<out Head, out SP = unknown> extends Built {
	readonly [phantom]?: { readonly heading: Head; readonly sourceParams: SP } | undefined
}

/**
 * A source written over schema S: a query, a bound import, or an interior stage. It carries S invariantly, like
 * Query, so a rule matches it only where S is one of the rule's levels, and a derived definition cannot read its own
 * level through an imported query. Relation parameters, deltas and a recursive query's self are local
 * to the rule that receives them and carry no schema.
 */
export interface SchemaSource<in out S, out Head, out SP = unknown> extends Built {
	readonly [phantom]?:
		| { readonly heading: Head; readonly sourceParams: SP; readonly schema: Invariant<S> }
		| undefined
}

/** A primitive JavaScript value: a string, a number, a bigint or a boolean. */
export type Literal = string | number | bigint | boolean

/**
 * Flattens an intersection for display and for exact comparisons. It and the type operators after it are shallow: no
 * recursion over the schema graph.
 */
export type Simplify<T> = { readonly [K in keyof T]: T[K] }

/**
 * Whether a string type is one finite literal: no union of names, and no wider string (string itself, or a template
 * with a string hole), whose record type is an index signature that a record of never-valued keys already satisfies.
 */
export type IsOneLiteral<N> = [N] extends [never]
	? false
	: [N] extends [UnionToIntersection<N>]
		? N extends string
			? Readonly<Record<string, never>> extends Record<N, true>
				? false
				: true
			: false
		: false

/**
 * A literal name N as a declared name keeps it, refused where it breaks the rule's characters: ASCII letters, digits
 * and underscores, a letter first (core/identity.ts parseNameCharacters), forever.
 */
export type DeclaredName<N extends string> =
	IsDeclaredName<N> extends true
		? unknown
		: Refusal<"a declared name: ASCII letters, digits and underscores, a letter first">
type IsDeclaredName<N extends string> = N extends `${infer First}${infer Rest}`
	? First extends NameLetter
		? NameTail<Rest>
		: false
	: false
type NameTail<S extends string> = S extends `${infer C}${infer Rest}`
	? C extends NameLetter | NameDigit | "_"
		? NameTail<Rest>
		: false
	: true
type LowerLetter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z"
type NameLetter = LowerLetter | Uppercase<LowerLetter>
type NameDigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"

/**
 * A parameter map as one contribution to a union fold (UnionToIntersection): never when it needs no parameter. A map
 * that needs none is unknown, the identity of intersection, and in a union unknown absorbs every other member, so a
 * fold over contributions drops it before it can erase its neighbours' parameters.
 */
export type ParamsContribution<P> = unknown extends P ? never : P

export type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
	i: infer I
) => void
	? I
	: never

/**
 * Strips a contract brand: a contract contributes its base. The spelling `E extends infer B & Brand.Brand<any> ? B :
 * E` resolves to E itself in TypeScript; Brand.Brand.Unbranded is the working spelling of the same intent.
 */
export type BaseOf<E> =
	E extends Brand.Brand<infer K> ? (K extends string ? Brand.Brand.Unbranded<E> : E) : E

/**
 * The parts of a term, read from its phantom bundle: its domain, TypeOfTerm. ParamsOfTerm reads the parameter map of
 * anything that carries one: a term, a predicate, an aggregate, a producer, a query or a ChangeSet.
 */
export type TypeOfTerm<X> =
	X extends Phantom<infer B> ? (B extends { readonly type: Invariant<infer T> } ? T : never) : never
/** The values a term's column delivers: its domain, but a constant's own value. */
export type ValueOfTerm<X> = X extends { readonly column: Column<infer V> } ? V : never
/** The SQL type of a term: its `sql` member's type. */
export type SqlOfTerm<X> = X extends TermBase ? X["sql"] : SqlTag
export type ParamsOfTerm<X> =
	X extends Phantom<infer B> ? (B extends { readonly params: infer P } ? P : unknown) : unknown

export type OriginOfTerm<X> =
	X extends Phantom<infer B> ? (B extends { readonly origin: infer O } ? O : unknown) : unknown

/** Whether X carries an origin phantom: a term or a predicate does, a literal does not. */
export type HasOrigin<X> =
	X extends Phantom<infer B> ? (B extends { readonly origin: unknown } ? true : false) : false

/**
 * Whether X is an input whose value is supplied apart from the data, a parameter or a JavaScript value in a head:
 * evidence reads neither as a field (evidence/evidence.ts Sym).
 */
export type IsInputValue<X> =
	HasOrigin<X> extends true
		? [OriginOfTerm<X>] extends [ParamOrigin | LiteralOrigin]
			? true
			: false
		: false

/**
 * The intersection of the parameter maps of a tuple of terms, predicates, aggregates or producers. A fold over the
 * tuple, not a union-to-intersection over arbitrary unions, so `unknown` members never absorb their neighbours.
 */
export type ParamsOfEach<Xs> = Xs extends readonly [infer H, ...infer Rest]
	? ParamsOfTerm<H> & ParamsOfEach<Rest>
	: unknown

/**
 * A scalar parameter's entry in a parameter map: the type `r.param(name, descriptor)` declared it at, the descriptor's
 * domain D, the identity a term binding it meets (Meets), its SQL type Sql, and its language L, every value of its
 * type, which a JavaScript value binding it and the argument a caller passes for it are one of. Two uses of one name
 * intersect: their languages intersect, and two SQL types leave the entry never, which no argument satisfies. A
 * phantom: no runtime value has this type, and a caller passes the language's value (ParamArg).
 */
export interface ParamType<in out D, out Sql extends SqlTag, out L = D> {
	readonly domain: Invariant<D>
	readonly sql: Sql
	readonly language: L
}

/** What a caller passes for a parameter map's entry: a scalar parameter's language, a relation parameter's facts. */
type ArgumentOf<X> = X extends { readonly language: infer L } ? L : X

/**
 * A value a parameter may hold: a scalar parameter's host value (a field's host type, a contract
 * over one, or a closed handle), or a relation parameter's facts, an array or a Stream with no error or requirement
 * channel. Every argument a ParamsOf map's entries take is one of these, so every ParamArg is.
 */
export type ParamValue =
	| string
	| number
	| bigint
	| boolean
	| Decimal
	| Money
	| Vector
	| Span<number>
	| Span<bigint>
	| ReadonlyArray<unknown>
	| Stream.Stream<unknown, unknown>

/** A program's parameter values by name, as the runtime takes them from the typed Db boundary. */
export interface ParamMap {
	readonly [name: string]: ParamValue
}

/**
 * The argument a program's parameter map P is bound with: each scalar parameter's value of its language, each relation
 * parameter's facts. A parameterless program's map is `unknown`, the identity of the intersection parameter maps
 * accumulate by, which every value is assignable to; its argument is an object with no key instead, so `42`, `"x"`,
 * `[1]` and `{ extra: 1 }` are refused as an extra key is refused for a program that has parameters. Each argument is a
 * ParamValue, which the second member of the intersection states by construction, so the runtime takes every argument
 * as a ParamMap: a Stream relation parameter is a Stream with no requirement because the program's type says so, never
 * because a run-time check claims it.
 */
export type ParamArg<P> = [keyof P] extends [never]
	? { readonly [key: string]: never }
	: { readonly [K in keyof P]: ArgumentOf<P[K]> } & { readonly [K in keyof P]: ParamValue }

/**
 * A predicate that reads no parameter: a row check and a contract predicate are part of the schema, evaluated by
 * PostgreSQL with nothing bound. Predicate is covariant in P, so `Predicate` alone would admit a predicate that
 * needs parameters; the callback's own predicate type is read and refused instead.
 */
export type Parameterless<X> = [keyof ParamsOfTerm<X>] extends [never]
	? unknown
	: Refusal<"a schema predicate reads no parameter">

/**
 * An invariant phantom: `Invariant<A>` is assignable to `Invariant<B>` exactly when A and B are mutually assignable.
 * TypeScript measures the variance of `(value: A) => A` reliably, so the check is by type argument, not structure.
 */
export type Invariant<A> = (value: A) => A

/**
 * The closed vocabulary of grizzle's type refusals: every message a Refusal or a Requires names, verbatim. A
 * message outside it does not compile (TS2344), and the type tests read it to tell a refusal from an incidental
 * mismatch.
 */
export const typeRefusals = [
	"PostgreSQL has no cast between these types that Compute admits",
	"a ChangeSet writes only relations its role's write list names",
	"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes",
	"a compiled ChangeSet applies, and a compiled query reads",
	"a contract is a value domain; a serial is a generation declaration, so use its integer type",
	"a contract's name is one literal, the brand of its values",
	"a declared name: ASCII letters, digits and underscores, a letter first",
	"a derived definition has at least one field",
	"a derived definition has one heading: a materialized view stores one heading group",
	"a derived definition reads no context: a materialized view holds no session",
	"a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)",
	"a key gets its one row",
	"a key lists each field once",
	"a login's roles share its base",
	"a login's workload is over its base, a level of it, or one of its roles",
	"a member fact is not a fact of the relation",
	"a new field name for the attachment",
	"a page over a bounded heterogeneous union: a group statement cannot tell which of its rows are among the union's first k",
	"a power's base proved nonnegative, and nonzero or its exponent nonnegative: guard it with Compute.when(Compute.positive(x), (x) => …, otherwise)",
	"a program on a Db of a role matches only the contexts the role's relations read, whose facts its claims hold",
	"a program over no level of the database's schema",
	"a query entry is a query over the role's base",
	"a radicand proved nonnegative: guard it with Compute.when(Compute.nonnegative(x), (x) => …, otherwise)",
	"a relation parameter has at least one field, as a relation does",
	"a schema predicate reads no parameter",
	"a span term is required",
	"a statement names a relation no level of the schema declares",
	"a term first: a literal takes its place opposite a term, never first",
	"a union's arms deliver each field at one type",
	"a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)",
	"a whole entry is a relation of the base under its own name",
	"alternatives takes at least one arm",
	"an Option needs a child the evidence proves at most one per parent",
	"an arm is a relation other than its parent",
	"an arm is keyed by a handle of its roster",
	"an arm needs a child that is the arm of one handle of an alternatives law, keyed by the parent's key",
	"an arm over a union of several headings: only a query's result delivers each heading group",
	"an arm's head delivers the row: each of its fields, at a type that meets the field's",
	"an attached heterogeneous union; one attachment statement delivers one heading",
	"an attachment on an arm of a union whose heading several arms share",
	"approximateNearest over one rule's projection; this source is a bounded subset, whose own order already selects among the rows",
	"approximateNearest over one rule's projection; this source is a query with attachments",
	"approximateNearest over one rule's projection; this source is a recursive relation",
	"approximateNearest over one rule's projection; this source is a union of rules, which no single index orders",
	"approximateNearest over one rule's projection; this source is another approximate search",
	"arms of different headings share a field that holds a different constant in each",
	"bind the query's parameters before matching it: Q.bind({ ... })",
	"get needs a query proved at most one row per parameter binding",
	"no arm of the source delivers the bound constants",
	"not a field of the arms the bindings select",
	"one literal name",
	"one take over a union of several headings: each heading group is a statement of its own, which one take bounds and the merge across them keeps",
	"page needs an ordered query",
	"read-back names are distinct: the ChangeSets share a read-back name",
	"read-back names are distinct: this ChangeSet already has a read-back of this name",
	"the ChangeSets' schemas are not levels of one another",
	"the arm's field is the parent's head field that holds its discriminator",
	"the arm's handle is a value of the parent field's type",
	"the arm's handle is one literal",
	"the arm's handle is the handle the child is the arm of",
	"the arm's key does not match the parent key",
	"the bound source is not over a level of the query's schema",
	"the one child needs a child the evidence proves exactly one per parent",
	"the query is not over a level of this query's schema",
	"the query's head is not a fact of the relation",
	"the relation is not in this query's schema",
	"the sides' field types differ",
	"two programs of one name across a login's workloads"
] as const
export type TypeRefusal = (typeof typeRefusals)[number]

/**
 * Readable type errors: an argument intersected with a Refusal names what is wrong instead of exposing a large
 * conditional reduction.
 */
export interface Refusal<Message extends TypeRefusal> {
	readonly "grizzle type error": Message
}
