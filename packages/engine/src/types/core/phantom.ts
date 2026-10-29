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
 *    `r.param("account", uuid)` is a term of uuid's host type whose map is `{ account: string }`; it meets a term of
 *    exactly its type (`r.param("amount", Cents)` for a Cents field), and never stands first, since the checker types a
 *    parameter from the term it meets. Each Rule method intersects the maps of its operands into
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
 * 2. Origin brands. `v(Task).id` is `Term<string, unknown, Origin<"Task", "id", typeof uuid>>`: every variable names the
 *    relation, field and descriptor it came from. The descriptor gives aggregates PostgreSQL's result type (SUM over
 *    integer is bigint, over bigint numeric). A rule records which origins its matches witness, a variable bound at the
 *    very field it was minted from, and a query's evidence carries the witnessed origin of each head field. Parent
 *    variables inside attach are `InputOrigin` terms that keep that origin (ParentVars): a key of a matched relation
 *    bound entirely to inputs (literals, parameters, parent variables) pins that occurrence to at most one fact per
 *    input binding, and a declared containment from the parent field onto the key proves exactly one. Under R1 an
 *    origin names one variable of a rule that matches no source twice, so a key's variables may be bound through other
 *    matches: the head's keys are what its variables determine under every match's keys (HeadKeys), and the empty key,
 *    every head variable determined by the inputs, makes a keyed lookup and a keyed attachment atMostOne
 *    (evidence/evidence.ts). A Compute expression's origin is the variables it reads (ComputedOrigin), so a computed
 *    term is determined wherever they are. The host type T of a term is invariant, so a contract never silently widens
 *    to its base in a join or comparison; literals adopt the base (LiteralOf).
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
 *    - orderBy: CommonKeys over the heading; the retained key that completes the order is the compiler's;
 *    - mirrors and contained: SidesCompatible compares the two sides' fields position by position, by host type and
 *      PostgreSQL type, so contract and roster identity count and text never joins uuid.
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
 * attachment to state is one the analysis licenses its decoder to bind (evidence/evidence.ts); a union's arms keep no
 * head origins. A query carries the decoders of its heading for snapshot reads and of its immediate heading for reads
 * inside a write transaction (query/query.ts HeadOf, ImmediateHeadOf).
 */
import type { Brand, Stream } from "effect"
import type { Column, FieldHost } from "#compiler/core/decoder.ts"
import type { Built, Phantom, phantom } from "#compiler/core/phantom.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { Vector } from "#compiler/scalar/values/vector.ts"

/**
 * Where a variable came from: the relation and field `v` read it from. Key retention through `find` is decided from
 * it.
 */
export interface Origin<out R extends string = string, out F extends string = string> {
	readonly relation: R
	readonly field: F
}

/**
 * A term the rule receives rather than binds: a parameter, a literal, or a parent variable inside `attach`. A key
 * bound entirely to inputs pins its occurrence to at most one fact per input binding.
 */
export interface InputOrigin {
	readonly input: true
}

/**
 * A parameter, `r.param(name, descriptor)`: an input term of its descriptor's host type. The Description records a
 * parameter by name only, and the checker types it from the term it meets, so a parameter never stands first
 * (IsUntypedInput).
 */
export interface ParamOrigin extends InputOrigin {
	readonly param: true
}

/**
 * A head literal, `r.literal(x)`: an input term of x's own literal type. The Description records it by value, untyped,
 * and the checker types it from the term it meets, so like a parameter it never stands first.
 */
export interface LiteralOrigin extends InputOrigin {
	readonly literal: true
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

/** The origin of a computation's operand: a term's or a predicate's own, and a literal's that of an input. */
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
 * - T, the host type, is invariant. A contract and its bare base are incompatible in joins, comparisons and
 *   containments, and a covariant T would let inference widen `Term<Cents>` to `Term<bigint>`.
 * - P, the parameter map, is what the term needs bound before it can run: `unknown` for a variable or literal,
 *   `{ account: string }` for `r.param("account", uuid)`. Every combinator intersects the maps of its operands, so a
 *   rule's parameters are the union of the parameters its terms use.
 * - O, the origin, says where a term came from: `Origin<"Task", "id">` for `v(Task).id`, `InputOrigin` for a parent
 *   variable inside `attach`, `ParamOrigin` for a parameter, `LiteralOrigin` for a head literal, `ComputedOrigin` of
 *   the variables a Compute expression or a predicate reads, and `unknown` when nothing is known.
 *
 * None of the three is a runtime member. Every phantom of the type vocabulary rides under one declared symbol that no
 * runtime value holds, as an optional member (Phantom): a runtime value that has a type's real members has the type,
 * and the member's type keeps the variance, `Invariant<T>` for an invariant host type. The real members stay required:
 * a term's `expr`, its `column` (the conversion of a cell into T, which a head reads it with) and its SQL type `sql`,
 * which Compute and aggregate result types are read off; a predicate's `predicate` and `expr`. A phantom is read by
 * inference through the interface that declares it (`X extends Term<infer T>`).
 *
 * A scalar term: a variable from `v`, a parameter, a literal, or a Compute expression. Its column delivers T, and Sql is
 * its SQL type.
 */
export interface Term<in out T, out P = unknown, out O = unknown, out Sql extends SqlTag = SqlTag>
	extends
		TermBase,
		Phantom<{ readonly type: Invariant<T>; readonly params: P; readonly origin: O }> {
	readonly column: Column<T>
	readonly sql: Sql
}

/**
 * What carries a column and a SQL type: a descriptor or a term, an entry of a heading's record of carriers, from which
 * variables are minted.
 */
export interface Carrier<out A = unknown, out Sql extends SqlTag = SqlTag> {
	readonly column: Column<A>
	readonly sql: Sql
}

/** A heading's record of carriers: a relation's fields, a closed relation's id and payload, a query's head. */
export interface Carriers {
	readonly [key: string]: Carrier
}

/** What a heading of carriers C is: the record of carriers a source value holds. */
export interface Headed<out C> {
	readonly heading: C
}
/** The SQL type of a carrier, SqlTag where it states none more precise. */
export type SqlOfCarrier<X> = X extends { readonly sql: infer S extends SqlTag } ? S : SqlTag

/**
 * The heading of a union of two arms' headings A and B: each key of either arm, carried
 * by the union of the arms' columns that have it, at the union of their SQL types.
 */
export type UnionHeading<A, B> = {
	readonly [K in keyof A | keyof B]: Carrier<
		CarriedAt<A, K> | CarriedAt<B, K>,
		SqlAt<A, K> | SqlAt<B, K>
	>
}
type CarriedAt<X, K> = K extends keyof X ? FieldHost<X[K]> : never
type SqlAt<X, K> = K extends keyof X ? SqlOfCarrier<X[K]> : never

/**
 * The record of terms schema/record.ts's mint makes over carriers F: each key's term of its carrier's host and SQL type,
 * its origin read from Origins, a phantom.
 */
export type Minted<F, Origins> = {
	readonly [K in keyof F]: Term<
		FieldHost<F[K]>,
		unknown,
		K extends keyof Origins ? Origins[K] : unknown,
		SqlOfCarrier<F[K]>
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

/** A JavaScript value a head may hold verbatim, typically a discriminant literal. */
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
 * The parts of a term, read from its phantom bundle. ParamsOfTerm reads the parameter map of anything that carries
 * one: a term, a predicate, an aggregate, a producer, a query or a ChangeSet.
 */
export type TypeOfTerm<X> = X extends Term<infer T> ? T : never
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
 * Whether X is an input the Description records untyped, a parameter or a head literal: it never stands first, since
 * the checker types it from the term it meets.
 */
export type IsUntypedInput<X> =
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
 * A value a parameter may hold: a scalar parameter's host value (a field's host type, a contract
 * over one, or a closed handle), or a relation parameter's facts, an array or a Stream with no error or requirement
 * channel. A ParamsOf map holds only these, so every ParamArg does.
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
 * The argument a program's parameter map P is bound with. A parameterless program's map is `unknown`, the identity
 * of the intersection parameter maps accumulate by, which every value is assignable to; its argument is an object with
 * no key instead, so `42`, `"x"`, `[1]` and
 * `{ extra: 1 }` are refused as an extra key is refused for a program that has parameters. Each of P's
 * values is a ParamValue, which the second member of the intersection states by construction, so the runtime takes
 * every argument as a ParamMap: a Stream relation parameter is a Stream with no requirement because the program's
 * type says so, never because a run-time check claims it.
 */
export type ParamArg<P> = [keyof P] extends [never]
	? { readonly [key: string]: never }
	: P & { readonly [K in keyof P]: ParamValue }

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
	"a derived definition has at least one field",
	"a derived definition has one heading: a materialized view stores one heading group",
	"a derived definition reads no context: a materialized view holds no session",
	"a key gets its one row",
	"a key lists each field once",
	"a login's roles share its base",
	"a login's workload is over its base, a level of it, or one of its roles",
	"a member fact is not a fact of the relation",
	"a new field name for the attachment",
	"a program on a Db of a role matches only the contexts the role's relations read, whose facts its claims hold",
	"a program over no level of the database's schema",
	"a query entry is a query over the role's base",
	"a schema predicate reads no parameter",
	"a span term is required",
	"a statement names a relation no level of the schema declares",
	"a term first: a parameter or a literal takes its place opposite a term, never first",
	"a whole entry is a relation of the base under its own name",
	"alternatives takes at least one arm",
	"an Option needs a child the evidence proves at most one per parent",
	"an arm needs a child that is the arm of one handle of an alternatives law, keyed by the parent's key",
	"an attached heterogeneous union; one attachment statement delivers one heading",
	"bind the query's parameters before matching it: Q.bind({ ... })",
	"get needs a query proved at most one row per parameter binding",
	"not a field of the arms the bindings select",
	"one literal name",
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
