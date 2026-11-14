import type { ClockUnit } from "#compiler/core/clock.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Phantom } from "#compiler/core/phantom.ts"
import type {
	AnyChangeSet,
	ChangeSetAt,
	PlannedStrata,
	RepeatedArraysOf
} from "#compiler/types/changeset/changeset.ts"
import type { MembersTyped, Refusal } from "#compiler/types/core/phantom.ts"
import type { AnyMaterialized } from "#compiler/types/derived/derived.ts"
import type {
	ContextsReadOf,
	OrderedAt,
	OrderedBase,
	PageOf,
	ParamsOf,
	QueryAt,
	QueryBase
} from "#compiler/types/query/query.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema, LevelsOf, RelationOf } from "#compiler/types/schema/schema.ts"
import type { CandidateKey } from "#compiler/types/schema/statements.ts"
import type {
	AnyRole,
	RefreshListOf,
	WithinRoleContexts,
	WriteListOf
} from "#compiler/types/schema/world.ts"

/** A stored or closed relation of L, which a key reads through. */
type KeyedAt<L> = L extends unknown ? Extract<RelationOf<L>, AnyRelation | AnyClosed> : never

/**
 * A key of a relation over L: the relation itself, for its primary key, or a candidate key of an ordinary relation of
 * L, a Key from key() over a side of its whole relation's fields.
 */
type KeyAt<L> = KeyedAt<L> | CandidateKey<Extract<KeyedAt<L>, AnyRelation>>

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
 * A workload member that runs its read X, a query, an ordered query, a paged one, a relation's key or a clocked query
 * or ordered query, in a SERIALIZABLE
 * READ ONLY DEFERRABLE transaction: deferrable(X). Each call waits for a safe snapshot, until every SERIALIZABLE
 * read-write transaction running on the cluster when it began has ended, then reads untracked by SSI: it never fails
 * with a serialization failure, never dooms another transaction and holds no SIRead lock. Any other read member reads at
 * once, may fail retryably, and holds its SIRead locks until the serializable transactions it overlapped have ended.
 */
export interface Deferrable<X> {
	readonly deferrable: X
}

/** A deferrable member's read, or the program itself where it is none (Deferrable). */
export type ReadOf<X> = X extends Deferrable<infer Y> ? Y : X

/**
 * A workload member that refreshes the materialized derived relations of the nonempty list Rs: refresh(Rs), whose handle
 * refreshes them all in one transaction (`yield* db.workload.<name>.once({ params: {}, facts: {} })`), lower levels
 * first. It reads and writes nothing else.
 */
export interface Refresh<Rs> {
	readonly refresh: Rs
}

/**
 * A workload member that serves the program X, a query, an ordered query or a ChangeSet, with each parameter its binding
 * B names bound to the database's clock in that parameter's unit: clocked(X, B). The reading is the instant the call's
 * transaction began, transaction_timestamp(), one value in every statement of the call and at or before every snapshot
 * it takes, counted since the Unix epoch, floored: in microseconds, PostgreSQL's own resolution, or milliseconds. No call
 * supplies it, so the member's input holds every other parameter of X alone. A clocked read is answered at that instant
 * and never live, since time passing is no change: its handle answers `once` and no `watch`.
 */
export interface Clocked<X, B> {
	readonly clocked: X
	readonly clock: B
}

/**
 * The parameters of X a clock reading may bind: each scalar parameter whose values are bigints, bigint or a contract
 * over it, by the language its entry states (types/core ParamType).
 */
type ClockableOf<X> = {
	readonly [N in keyof ParamsOf<X>]: ParamsOf<X>[N] extends { readonly language: bigint }
		? N
		: never
}[keyof ParamsOf<X>]

/**
 * What clocked(X, B) binds: at least one parameter, each a bigint parameter of X (ClockableOf), each to a unit; any other
 * name is refused by the Refusal the types name.
 */
type ClockBindingOf<X, B> = [keyof B] extends [never]
	? Refusal<"clocked binds at least one parameter of the program to the database's clock">
	: [Exclude<keyof B, ClockableOf<X>>] extends [never]
		? unknown
		: Refusal<"clocked binds only parameters of the program whose values are bigints: bigint or a contract over it">

/** clocked(program, binding): the workload member that binds `program`'s parameters to the database's clock (Clocked). */
export type ClockedConstructor = <
	const X extends QueryBase | OrderedBase | AnyChangeSet,
	const B extends { readonly [N in string]: ClockUnit }
>(
	program: X,
	binding: B & ClockBindingOf<X, B>
) => Clocked<X, B>

/** The materialized derived relations of a level L, one level at a time. */
type MaterializedAt<L> = L extends unknown ? Extract<RelationOf<L>, AnyMaterialized> : never

/**
 * What a refresh member of a workload over S refreshes: over a role, only the relations its refresh list names, as a Db
 * of the role refreshes them; over a schema, any materialized derived relation of it or a level below it.
 */
type RefreshableBy<S> = S extends AnyRole ? RefreshListOf<S> : MaterializedAt<LevelsOf<S>>

/** A read of a workload over L: a query, an ordered query, an ordered query that pages, or a relation's key. */
type ReadAt<L> = QueryAt<L> | OrderedAt<L> | Paged<OrderedAt<L>> | KeyAt<L>

/**
 * A program of a workload over S, over S or a level below it, L: a read, run at once or deferrable, a ChangeSet, one of
 * a query, an ordered query or a ChangeSet with parameters bound to the database's clock (Clocked), a clocked read run
 * deferrable, or a refresh of materialized derived relations S may refresh. What a ChangeSet writes is each member's
 * check (WritesWithin), so its refusal names the rule.
 */
type ProgramAt<S, L> =
	| ReadAt<L>
	| Deferrable<ReadAt<L>>
	| ChangeSetAt<L>
	| Clocked<QueryAt<L> | OrderedAt<L> | ChangeSetAt<L>, unknown>
	| Deferrable<Clocked<QueryAt<L> | OrderedAt<L>, unknown>>
	| Refresh<NonEmptyReadonlyArray<RefreshableBy<S>>>

/**
 * The contexts a program of a workload matches: a query's or ordered query's, a paged one's, a clocked one's program's,
 * a deferrable one's read's, or a ChangeSet's, its members' and read-backs'; a key and a refresh match none.
 */
type ProgramContexts<X> =
	X extends Deferrable<infer Y>
		? ProgramContexts<Y>
		: X extends Paged<infer O>
			? ContextsReadOf<O>
			: X extends Clocked<infer P, unknown>
				? ProgramContexts<P>
				: X extends AnyChangeSet
					? X extends Phantom<{ readonly contexts: infer Cx }>
						? Cx
						: never
					: ContextsReadOf<X>

/**
 * A ChangeSet program's array members, which a served call's facts key by op and relation (FactsCheck): none two of one
 * op and one relation in two strata (RepeatedArraysOf, read from the members' positions, never their rows), as generate
 * refuses them (UnservedMember `repeated`).
 */
type ArraysOnce<X> = X extends AnyChangeSet
	? [RepeatedArraysOf<X>] extends [never]
		? unknown
		: Refusal<"a served ChangeSet's facts hold one array for each op and relation: merge the strata's array members of this op and relation into one">
	: unknown

/** The program a member serves: a clocked member's program, or the member itself. */
type ClockedProgram<X> = X extends Clocked<infer P, unknown> ? P : X

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
	const Programs extends Record<string, ProgramAt<S, LevelsOf<S>>>
>(
	schema: S,
	programs: Programs & {
		readonly [K in keyof Programs]: PlannedStrata<ClockedProgram<Programs[K]>> &
			ArraysOnce<ClockedProgram<Programs[K]>> &
			WritesWithin<S, ClockedProgram<Programs[K]>> &
			WithinRoleContexts<S, ProgramContexts<Programs[K]>>
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
 * What deferrable takes: a read, a query, an ordered query, a paged one, a relation's key or a clocked query; a
 * ChangeSet, a clocked one, a refresh and a deferrable member are refused with the Refusal that names what it takes.
 * Which schema the read is over is the workload's to judge (ProgramAt).
 */
type DeferrableArgument<X> = X extends
	| Deferrable<unknown>
	| Refresh<unknown>
	| AnyChangeSet
	| Clocked<AnyChangeSet, unknown>
	? Refusal<"deferrable takes a read: a query, an ordered query, a paged one, a relation's key or a clocked one">
	: unknown

/** deferrable(read): the workload member that runs the read `read` in a deferrable transaction (Deferrable). */
export type DeferrableConstructor = <const X extends object>(
	read: X & DeferrableArgument<X>
) => Deferrable<X>

/**
 * refresh(relations): the workload member that refreshes the materialized derived relations of the nonempty list
 * `relations` (Refresh).
 */
export type RefreshConstructor = <const Rs extends NonEmptyReadonlyArray<AnyMaterialized>>(
	relations: Rs
) => Refresh<Rs>
