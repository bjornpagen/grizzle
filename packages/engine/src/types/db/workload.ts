import type { HostKeysOf } from "#compiler/core/brand.ts"
import type { ClockUnit } from "#compiler/core/clock.ts"
import type { Phantom } from "#compiler/core/phantom.ts"
import type {
	AnyChangeSet,
	ChangeSetAt,
	PlannedStrata,
	RepeatedArraysOf
} from "#compiler/types/changeset/changeset.ts"
import type { MembersTyped, Refusal } from "#compiler/types/core/phantom.ts"
import type {
	ContextsOf,
	OrderedAt,
	OrderedBase,
	PageOf,
	ParamsOf,
	QueryAt,
	QueryBase
} from "#compiler/types/query/query.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema, LevelsOf, RelationOf } from "#compiler/types/schema/schema.ts"
import type { Side } from "#compiler/types/schema/statements.ts"
import type { AnyRole, WithinRoleContexts, WriteListOf } from "#compiler/types/schema/world.ts"

/** A stored or closed relation of L, which a key reads through. */
type KeyedAt<L> = L extends unknown ? Extract<RelationOf<L>, AnyRelation | AnyClosed> : never

/**
 * A key of a relation over L: the relation itself, for its primary key, or a candidate key of an ordinary relation of
 * L, a Key from key() over a side of its whole relation's fields (KeyOn).
 */
type KeyAt<L> = KeyedAt<L> | KeyOn<Extract<KeyedAt<L>, AnyRelation>>

/**
 * A candidate key of one of the relations R, told by its kind and its side, whose source is one of them, as key()
 * builds one (schema/statements.ts CandidateKey), and never by the records it delivers. CandidateKey of a union of
 * relations is one key over all of them, whose records the checker infers from the side's source as the union of every
 * relation's, reduced by subtype at each member's check against the workload's programs: past a thousand relations of
 * distinct headings, as a role of metis's reads, more than the checker represents (TS2590). Told by its side, a key is
 * held to its own relation, one member of R.
 */
interface KeyOn<R> {
	readonly kind: "key"
	readonly side: Side<R, ReadonlyArray<string>>
}

/**
 * What a ChangeSet X of a workload over S writes: over a role, only relations its write list names, as the role's compile
 * refuses any other by name; over a schema, any of its relations. A read writes nothing, and a ChangeSet whose type
 * states no writes, a JavaScript caller's, is the compile's alone to judge.
 */
type WritesWithin<S, X> = S extends AnyRole
	? X extends AnyChangeSet
		? X extends Phantom<{ readonly writes: WriteListOf<S> }>
			? unknown
			: Refusal<"a ChangeSet writes only relations its role's write list names">
		: unknown
	: unknown

/**
 * A workload member that pages its ordered query O: paged(O), whose handle reads a window of it, its input's `window`
 * anchored at the start, the end, or after or before a row's key. A plain ordered member reads the whole query, and
 * generate compiles a page template only for a paged one.
 */
export interface Paged<O> {
	readonly paged: O
}

/**
 * A workload member that answers its read X, a query, an ordered query, a paged one or a relation's key, at its call's
 * instant alone and never live: answered(X). Its handle holds `once` and its explains, and no `watch`, and over HTTP its
 * answer is its reset, its upserts, its ready, then its end: no change wakes it, so its login needs no live source for
 * it. A clocked read is answered already, with its clock (Clocked).
 */
export interface Answered<X> {
	readonly answered: X
}

/** The read a member runs, past its answered(...) (Answered), or the program itself where it is no answered member. */
export type ReadOf<X> = X extends Answered<infer Y> ? Y : X

/**
 * A workload member that serves the program X, a query, an ordered query or a ChangeSet, with each parameter its binding
 * B names bound to the database's clock in that parameter's unit: clocked(X, B). The reading is the instant the call's
 * transaction began, transaction_timestamp(), one value in every statement of the call and at or before every snapshot
 * it takes, counted since the Unix epoch, floored: in microseconds, PostgreSQL's own resolution, or milliseconds. No call
 * supplies it, so the member's input holds every other parameter of X alone. A clocked read is an answered one with its
 * clock (Answered), answered at that instant and never live, since time passing is no change: its handle answers
 * `once` and no `watch`.
 */
export interface Clocked<X, B> {
	readonly clocked: X
	readonly clock: B
}

/** Whether a union of keys is of two members or more, a contract over another's host keys: none or one is not. */
type ManyKeys<K, All = K> = [K] extends [never]
	? false
	: K extends unknown
		? [All] extends [K]
			? false
			: true
		: never

/** The language a parameter N of X delivers, its scalar entry's (types/core ParamType). */
type LanguageOf<X, N> = N extends keyof ParamsOf<X>
	? ParamsOf<X>[N] extends { readonly language: infer L }
		? L
		: never
	: never

/**
 * The parameters of X a clock reading may bind: each scalar parameter whose values are bigints, by the language its
 * entry states (types/core ParamType): bigint, natural, or one consumer's contract over either, whose language holds
 * its one key (core/brand.ts HostKeysOf), never a contract over another's, whose two a binding's one key would not make.
 */
type ClockableOf<X> = {
	readonly [N in keyof ParamsOf<X>]: ParamsOf<X>[N] extends {
		readonly language: infer L extends bigint
	}
		? [ManyKeys<HostKeysOf<L>>] extends [true]
			? never
			: N
		: never
}[keyof ParamsOf<X>]

/** The parameters B binds whose type is a consumer's contract: each holds its key in the language its entry states. */
type KeyedOf<X, B> = {
	readonly [N in keyof B]: [HostKeysOf<LanguageOf<X, N>>] extends [never] ? never : N
}[keyof B]

/**
 * What clocked(X, B) takes after its binding: where B binds a parameter of a consumer's contract, the reading is cast to
 * the contract's domain at bind, a value of it the clock makes, so it takes the contract's key by the parameter's name,
 * `{ now: millisKey }`, as mintOf takes it on the host; nothing otherwise.
 */
type ClockKeysOf<X, B> = [KeyedOf<X, B>] extends [never]
	? readonly []
	: readonly [keys: { readonly [N in KeyedOf<X, B>]: HostKeysOf<LanguageOf<X, N>> }]

/**
 * What clocked(X, B) binds: at least one parameter, each a bigint parameter of X (ClockableOf), each to a unit; any other
 * name is refused by the Refusal the types name.
 */
type ClockBindingOf<X, B> = [keyof B] extends [never]
	? Refusal<"clocked binds at least one parameter of the program to the database's clock">
	: [Exclude<keyof B, ClockableOf<X>>] extends [never]
		? unknown
		: Refusal<"clocked binds only parameters of the program whose values are bigints: bigint, natural, or one consumer's contract over either, under its key">

/**
 * clocked(program, binding, keys): the workload member that binds `program`'s parameters to the database's clock
 * (Clocked), under the keys of the consumers' contracts it binds (ClockKeysOf).
 */
export type ClockedConstructor = <
	const X extends QueryBase | OrderedBase | AnyChangeSet,
	const B extends { readonly [N in string]: ClockUnit }
>(
	program: X,
	binding: B & ClockBindingOf<X, B>,
	...keys: ClockKeysOf<X, B>
) => Clocked<X, B>

/** A read of a workload over L: a query, an ordered query, an ordered query that pages, or a relation's key. */
type ReadAt<L> = QueryAt<L> | OrderedAt<L> | Paged<OrderedAt<L>> | KeyAt<L>

/**
 * A program of a workload over S, over S or a level below it, L: a read, live or answered (Answered), a ChangeSet, or
 * one of a query, an ordered query or a ChangeSet with parameters bound to the database's clock (Clocked). A read's
 * isolation is no part of it: generate infers it (core/isolation.ts ReadIsolation). What a ChangeSet writes is each
 * member's check (WritesWithin), so its refusal names the rule.
 */
type ProgramAt<L> =
	| ReadAt<L>
	| Answered<ReadAt<L>>
	| ChangeSetAt<L>
	| Clocked<QueryAt<L> | OrderedAt<L> | ChangeSetAt<L>, unknown>

/**
 * The contexts a program of a workload matches: a query's or ordered query's, a paged one's, a clocked one's program's,
 * an answered one's read's, or a ChangeSet's, its members' and read-backs'; a key matches none.
 */
type ProgramContexts<X> =
	X extends Answered<infer Y>
		? ProgramContexts<Y>
		: X extends Paged<infer O>
			? ContextsOf<O>
			: X extends Clocked<infer P, unknown>
				? ProgramContexts<P>
				: X extends AnyChangeSet
					? X extends Phantom<{ readonly contexts: infer Cx }>
						? Cx
						: never
					: ContextsOf<X>

/**
 * A ChangeSet program's array members, which a served call's facts key by op and relation (FactsCheck): none two of one
 * op and one relation in two strata (RepeatedArraysOf, read from the members' positions, never their rows), as generate
 * refuses them (UnservedMember `repeated`). The repeated arrays are a parameter of their own (ArraysRepeated): a tuple
 * of RepeatedArraysOf here would be a reference the checker defers, holding the ChangeSet in its mapper, and deciding it
 * would instantiate the ChangeSet whole, its schema with it.
 */
type ArraysOnce<X> = X extends AnyChangeSet ? ArraysRepeated<RepeatedArraysOf<X>> : unknown
type ArraysRepeated<Repeated> = [Repeated] extends [never]
	? unknown
	: Refusal<"a served ChangeSet's facts hold one array for each op and relation: merge the strata's array members of this op and relation into one">

/** The program a member serves: a clocked member's program, or the member itself. */
type ClockedProgram<X> = X extends Clocked<infer P, unknown> ? P : X

/**
 * What a workload checks of its program X (WorkloadConstructor): a ChangeSet's appends beside its immutable owner's
 * insert (PlannedStrata), its array members of one op and relation in one stratum (ArraysOnce), its writes within its
 * role's write list (WritesWithin), and every program's contexts within its role's (WithinRoleContexts). A program
 * whose keys name no ChangeSet's reads and no clock, every program of a union of them included (Kinds), writes nothing
 * and holds no strata, so of the four checks only its contexts' can refuse it: that is all it is checked by, its
 * contexts read by key (ReadContexts). A read is told by its keys, never by a test of it: a query holds its schema,
 * and a conditional the checker resolves instantiates its operands whole, every relation of the schema with them.
 */
type ProgramChecks<S, X> = ChecksOf<S, X, Kinds<X>>
/**
 * ProgramChecks over the kinds K of X's programs, a parameter of its own: a tuple of an alias over X is a reference the
 * checker resolves later, holding X, and deciding the test instantiates it, X whole with it.
 */
type ChecksOf<S, X, K> = [K] extends ["read"]
	? ["read"] extends [K]
		? WithinRoleContexts<S, ReadContexts<X>>
		: AllChecks<S, X>
	: AllChecks<S, X>
type AllChecks<S, X> = PlannedStrata<ClockedProgram<X>> &
	ArraysOnce<ClockedProgram<X>> &
	WritesWithin<S, ClockedProgram<X>> &
	WithinRoleContexts<S, ProgramContexts<X>>

/**
 * Each program of X by its keys: "write" for a ChangeSet's (its reads) or a clocked member's (its clock), and for a
 * value typed `any`, whose keys are every name; "read" for any other.
 */
type Kinds<X> = X extends unknown
	? "reads" extends keyof X
		? "write"
		: "clocked" extends keyof X
			? "write"
			: "read"
	: never

/**
 * ProgramContexts of a program that is no ChangeSet, each member of a union its own, told by its keys: an answered
 * member's read's, a paged member's ordered query's, a clocked read's program's, and a query's own, read off its
 * phantom by key (ContextsOf). A value typed `any` or holding a ChangeSet's reads is read by ProgramContexts itself.
 */
type ReadContexts<X> = X extends unknown
	? symbol extends keyof X
		? ProgramContexts<X>
		: "answered" extends keyof X
			? ReadContexts<X["answered" & keyof X]>
			: "paged" extends keyof X
				? ContextsOf<X["paged" & keyof X]>
				: "clocked" extends keyof X
					? ReadContexts<X["clocked" & keyof X]>
					: "reads" extends keyof X
						? ProgramContexts<X>
						: ContextsOf<X>
	: never

/**
 * workload(schema, programs): each program over a level of the schema (ProgramAt), a ChangeSet's appends each beside
 * its immutable owner's insert (PlannedStrata) and its array members of one op and relation in one stratum
 * (ArraysOnce), and, over a role, a ChangeSet writing only what the role's write list names (WritesWithin) and every
 * program matching only the contexts the role's relations read (WithinRoleContexts), as the role's compile refuses any
 * other. A workload over a schema runs on each role of its login, so the compile alone judges its contexts. A program
 * typed `any` is refused (MembersTyped).
 */
export type WorkloadConstructor = <
	S extends AnySchema | AnyRole,
	const Programs extends Record<string, ProgramAt<LevelsOf<S>>>
>(
	schema: S,
	programs: Programs & {
		readonly [K in keyof Programs]: ProgramChecks<S, Programs[K]>
	} & MembersTyped<Programs>
) => Workload<S, Programs>

/**
 * A workload: the named programs an application runs over S, which a login owns (login(..., { workload })), whose
 * access paths justify indexes and which DbLayer.make compiles once, at startup. Types only:
 * packages/engine/src/program/workload implements workload.
 */
export interface Workload<S, Programs> {
	readonly schema: S
	readonly programs: Programs
}

/** Any workload: the members every one has. */
export type AnyWorkload = Workload<AnySchema | AnyRole, Readonly<Record<string, unknown>>>

/**
 * What paged takes: an ordered query, one orderBy(...) made, that is no page over a bounded heterogeneous union
 * (types/query/query.ts PageOf), which the page compiler refuses; any other value is refused with the Refusal a page's
 * read of it gives, so the diagnostic names it.
 */
type PagedArgument<O> = O extends OrderedBase ? PageOf<O> : Refusal<"page needs an ordered query">

/** paged(ordered): the workload member that pages the ordered query `ordered` (Paged). */
export type PagedConstructor = <const O>(ordered: O & PagedArgument<O>) => Paged<O>

/**
 * What answered takes: a read, a query, an ordered query, a paged one or a relation's key; a ChangeSet, a clocked one
 * and an answered member are refused with the Refusal that names what it takes. Which schema the read is over is the
 * workload's to judge (ProgramAt).
 */
type AnsweredArgument<X> = X extends Answered<unknown> | AnyChangeSet | Clocked<unknown, unknown>
	? Refusal<"answered takes a read: a query, an ordered query, a paged one or a relation's key">
	: unknown

/** answered(read): the workload member that answers the read `read` once, never live (Answered). */
export type AnsweredConstructor = <const X extends object>(
	read: X & AnsweredArgument<X>
) => Answered<X>
