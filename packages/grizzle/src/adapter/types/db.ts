import type { Array as Arr, Effect, Option, Scope } from "effect"
import type { ApplyError, OpenError, ReadError } from "#adapter/errors/execution.ts"
import type { DbLayerService } from "#adapter/types/layer.ts"
import type { RowDecoder } from "#compiler/core/decoder.ts"
import type { CompileError, CursorError } from "#compiler/core/errors.ts"
import type { Phantom } from "#compiler/core/phantom.ts"
import type {
	AnyChangeSet,
	ChangeSet,
	Law,
	Witness,
	WritesOf
} from "#compiler/types/changeset/changeset.ts"

import type {
	Carriers,
	Invariant,
	ParamArg,
	ParamValue,
	Refusal
} from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type { Page, PageRequest } from "#compiler/types/page/page.ts"
import type {
	ContextsOf,
	EvidenceOfQuery,
	Ordered,
	OrderedBase,
	PageOf,
	ParamsOf,
	Query,
	QueryBase,
	UnionArms
} from "#compiler/types/query/query.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { LevelsOf } from "#compiler/types/schema/schema.ts"
import type { CandidateKey, KeyValues } from "#compiler/types/schema/statements.ts"
import type {
	AnyRole,
	LoginRole,
	ReadsContext,
	RefreshListOf,
	WithinRoleContexts,
	WriteListOf
} from "#compiler/types/schema/world.ts"

/**
 * Db.open's options for role R: `token` is what the layer's verify turns into the payload the role's contexts are
 * decoded from, once per Db, required exactly when the role's relations read a context. A Db opened without one has no
 * context facts. The snapshot is the layer's (DbConfig), since an application has exactly one.
 */
export type OpenOptions<R> =
	ReadsContext<R> extends true ? { readonly token: string } : { readonly token?: string }

/**
 * Db.open; packages/grizzle/src/adapter/db/open.ts implements it. It admits the database before it yields.
 * Usage: Db.open(Web.roles.member, { token }), provided by DbLayer.make({ login: Web, snapshot, ... }): the role is
 * reached through its login, whose workloads give the Db its programs (`db.workload`). The requirement DbLayer<R> is
 * provided only by the layer of the login that holds R.
 */
export interface DbConstructor {
	open<R extends AnyRole, P>(
		role: LoginRole<R, P>,
		options: OpenOptions<R>
	): Effect.Effect<DbOf<R, P>, OpenError, DbLayerService<R>>
}

/** A ChangeSet's writes lie within the role's write list. */
type WithinWriteList<R, W> = [W] extends [WriteListOf<R>]
	? unknown
	: Refusal<"a ChangeSet writes only relations its role's write list names">

/**
 * Reads, the opened database, and its write, refresh and explain operations. packages/grizzle/src/adapter implements Db
 * (db/open.ts, db/db.ts, reader/); the declarations here are its types.
 *
 * A program's parameters are inferred from the program alone: each `params` argument is NoInfer<P>, so P is the
 * query's or ChangeSet's own parameter map (types/query ParamsOf) and the argument is checked against it. Without it a
 * literal argument would take part in inferring the invariant P, widen ("Front" to string), and refuse a correct call.
 *
 * A Db is opened for a role R, a schema whose relations are defined over its base (types/schema/world.ts), reached
 * through its login, whose workloads' programs over R or a level of it are P (ProgramsOf): `workload` holds their
 * handles, compiled once when the layer was built. Every reader
 * accepts a query over R or over any level below it (L extends LevelsOf<R>): Query is invariant in its schema, and a
 * full role holds its base among its levels, so a query written over the base is a query over the full role.
 * db.apply, compile and explain accept a ChangeSet over any level the same way. Every program matches only the
 * contexts R's relations read (WithinRoleContexts), whose facts the Db's claims hold.
 *
 * Every read sees a lawful committed snapshot and delivers the query's heading: the records its decoder assembles
 * (query `rows`, a relation's `fact`), each bound once to the layout of the statements that deliver them.
 */
export interface DbOf<R, P> extends QueryReader<R> {
	/**
	 * The programs of the login's workloads over R or a level of it, each compiled once at startup (DbLayer.make), by
	 * name: a query's, ordered query's, key's or ChangeSet's handle, its operations db.compile's (Compiled).
	 */
	readonly workload: WorkloadHandles<R, P>
	/** Only ChangeSets whose writes lie within R's write list typecheck. */
	apply<L extends LevelsOf<R>, P, W extends string, Reads, Cx extends string>(
		changes: ChangeSet<L, P, W, Reads, Cx> & WithinWriteList<R, W> & WithinRoleContexts<R, Cx>,
		params: NoInfer<ParamArg<P>>
	): Effect.Effect<ApplyOutcome<Reads>, ApplyError>
	/**
	 * A query, ordered query or ChangeSet compiled once, run with each call's parameters through its handle: its
	 * statements are server statements of the Db's pool, parsed on each session's first use, and they close, and the
	 * compiled form drops, when the Scope ends.
	 */
	compile<X extends CompilableProgram, A>(
		program: CompileTarget<R, X, A>
	): Effect.Effect<Compiled<R, X, A>, CompileError, Scope.Scope>
	/**
	 * Brings derived relations to their definitions: one transaction, level order. Each must be in R's refresh list, and
	 * a call names at least one.
	 */
	refresh(
		...relations: Arr.NonEmptyReadonlyArray<RefreshListOf<R>>
	): Effect.Effect<void, ApplyError>
	explain<
		L extends LevelsOf<R>,
		Head,
		Ev extends Evidence,
		P,
		IHead,
		Hc extends Carriers,
		W extends string,
		Reads,
		Cx extends string,
		Arms extends UnionArms
	>(
		program: (
			| Query<L, Head, Ev, P, IHead, Hc, Cx, Arms>
			| Ordered<L, Head, Ev, P, IHead, Hc, Cx, Arms>
			| ChangeSet<L, P, W, Reads, Cx>
		) &
			WithinRoleContexts<R, Cx>,
		params: NoInfer<ParamArg<P>>
	): Effect.Effect<ReadonlyArray<Plan>, ReadError>
}

/** The schema a query, ordered query or ChangeSet is over. */
type ProgramSchema<X> = X extends Phantom<{ readonly schema: Invariant<infer L> }> ? L : never
/** Every reader accepts a program over S or over any level below it. */
type AtLevelOf<S, X> = [ProgramSchema<X>] extends [LevelsOf<S>]
	? unknown
	: Refusal<"a program over no level of the database's schema">

/**
 * What a reader's get reads: a query, or a key. A relation stands for its primary key, a Key from key() over a side of
 * its whole relation's fields for that candidate key.
 */
export type KeyTarget = AnyRelation | AnyClosed | CandidateKey<AnyRelation>

/**
 * What db.page reads: an ordered query Q over a level of S, whose rows decoder delivers A, matching only the contexts
 * S's relations read, and no bounded union of several headings (PageOf). A page and its cursors are Q's own.
 */
export type PageTarget<S, Q, A> = Q & { readonly rows: RowDecoder<A> } & PageClaim<S, Q>

/** What an ordered query claims of a page over S; a query no order closes is refused a page. */
type PageClaim<S, Q> = Q extends OrderedBase
	? AtLevelOf<S, Q> & WithinRoleContexts<S, ContextsOf<Q>> & PageOf<Q>
	: Refusal<"page needs an ordered query">

/** A query get reads is over a level of S and proved at most one row per parameter binding; a key always is. */
export type AtMostOneRow<S, X> = X extends KeyTarget
	? unknown
	: EvidenceOfQuery<X> extends { readonly card: "atMostOne" | "one" }
		? AtLevelOf<S, X>
		: Refusal<"get needs a query proved at most one row per parameter binding">

/**
 * get's second argument: a query's parameters, or a key's values.
 * A key's values are scalar parameters of the lookup, each a ParamValue, as ParamArg states for a program's.
 */
export type GetArg<X> = X extends KeyTarget
	? KeyValues<X> & { readonly [K in keyof KeyValues<X>]: ParamValue }
	: ParamArg<ParamsOf<X>>

/**
 * What decodes the row get delivers, whose records are A: a query's rows decoder, a relation's or closed relation's
 * fact decoder, or a key's, its side's relation's.
 */
export type Decoding<A> =
	| { readonly rows: RowDecoder<A> }
	| { readonly fact: RowDecoder<A> }
	| { readonly side: { readonly source: { readonly fact: RowDecoder<A> } } }

/** get's target: a query or key X over S, whose decoder delivers A, matching only the contexts S's relations read. */
export type GetTarget<S, X, A> = X &
	Decoding<A> &
	AtMostOneRow<S, X> &
	WithinRoleContexts<S, ContextsOf<X>>

export interface QueryReader<S> {
	/**
	 * Any query proved at most one row per parameter binding, with its parameters; or a keyed lookup, with the key's
	 * values. The row is the target's decoder's: the query's heading, or the keyed relation's fact.
	 */
	get<X extends QueryBase | KeyTarget, A>(
		target: GetTarget<S, X, A>,
		params: NoInfer<GetArg<X>>
	): Effect.Effect<Option.Option<A>, ReadError>
	execute<
		L extends LevelsOf<S>,
		Head,
		Ev extends Evidence,
		P,
		IHead,
		Hc extends Carriers,
		Cx extends string,
		Arms extends UnionArms
	>(
		query: (
			| Query<L, Head, Ev, P, IHead, Hc, Cx, Arms>
			| Ordered<L, Head, Ev, P, IHead, Hc, Cx, Arms>
		) &
			WithinRoleContexts<S, Cx>,
		params: NoInfer<ParamArg<P>>
	): Effect.Effect<QueryResult<Head>, ReadError>
	/**
	 * A page of an ordered query Q over a level of S, with its parameters: its records are Q's, and its cursors are
	 * Q's own, typed by the very query passed in.
	 */
	page<Q, A>(
		query: PageTarget<S, Q, A>,
		params: NoInfer<ParamArg<ParamsOf<Q>>>,
		request: PageRequest
	): Effect.Effect<Page<A, Q>, ReadError | CursorError>
}

/** What db.compile compiles: a query, an ordered query or a ChangeSet. */
export type CompilableProgram = QueryBase | OrderedBase | AnyChangeSet

/** The records a compiled program delivers, A: a query's rows, or a ChangeSet's read-backs. */
export type ProgramDecoding<A> =
	| { readonly rows: RowDecoder<A> }
	| { readonly reads: RowDecoder<A> }

/** The contexts a program matches: a ChangeSet's, or a query's. */
type ProgramContexts<X> = X extends AnyChangeSet
	? X extends Phantom<{ readonly contexts: infer Cx }>
		? Cx
		: never
	: ContextsOf<X>

/** A ChangeSet's writes lie within the role's write list; a query writes nothing. */
type CompiledWrites<R, X> = X extends AnyChangeSet ? WithinWriteList<R, WritesOf<X>> : unknown

/**
 * db.compile's target: a program X over a level of S, whose decoder delivers A, matching only the contexts S's
 * relations read, and, for a ChangeSet, writing only what S's write list names.
 */
export type CompileTarget<S, X, A> = X &
	ProgramDecoding<A> &
	AtLevelOf<S, X> &
	WithinRoleContexts<S, ProgramContexts<X>> &
	CompiledWrites<S, X>

/**
 * The operations a compiled program allows: a query or ordered query reads, a ChangeSet applies, and a workload's key
 * gets.
 */
type ReadOp<X> = X extends AnyChangeSet
	? Refusal<"a compiled ChangeSet applies, and a compiled query reads">
	: X extends KeyTarget
		? Refusal<"a key gets its one row">
		: unknown

type ApplyOp<X> = X extends AnyChangeSet
	? unknown
	: Refusal<"a compiled ChangeSet applies, and a compiled query reads">
type PageOp<X> = X extends OrderedBase ? PageOf<X> : Refusal<"page needs an ordered query">
type GetOp<X> = X extends AnyChangeSet
	? Refusal<"a compiled ChangeSet applies, and a compiled query reads">
	: X extends KeyTarget
		? unknown
		: EvidenceOfQuery<X> extends { readonly card: "atMostOne" | "one" }
			? unknown
			: Refusal<"get needs a query proved at most one row per parameter binding">

/** What a compiled program's operations take: a program's parameters, or a key's values. */
type CompiledArg<X> = X extends KeyTarget ? GetArg<X> : ParamArg<ParamsOf<X>>

/**
 * A program compiled once, by db.compile or at startup as a workload program (`db.workload`), run with each call's
 * parameters, over records A (its rows, its read-backs, or a key's relation's facts). Exactly the operations its
 * program allows typecheck: execute for a query or ordered query, get for one proved at most one row per parameter
 * binding and for a key, page for an ordered query, apply for a ChangeSet. A page's cursors are for the compiled
 * query X.
 */
export interface Compiled<S, X, A> extends Phantom<{ readonly schema: Invariant<S> }> {
	execute(params: NoInfer<CompiledArg<X>> & ReadOp<X>): Effect.Effect<QueryResult<A>, ReadError>
	get(params: NoInfer<CompiledArg<X>> & GetOp<X>): Effect.Effect<Option.Option<A>, ReadError>
	page(
		params: NoInfer<CompiledArg<X>> & PageOp<X>,
		request: PageRequest
	): Effect.Effect<Page<A, X>, ReadError | CursorError>
	apply(params: NoInfer<CompiledArg<X>> & ApplyOp<X>): Effect.Effect<ApplyOutcome<A>, ApplyError>
}

/** The records a program's handle delivers: a query's rows, a ChangeSet's read-backs, a key's relation's facts. */
type RecordsOf<X> = X extends { readonly rows: RowDecoder<infer A> }
	? A
	: X extends { readonly reads: RowDecoder<infer A> }
		? A
		: X extends { readonly fact: RowDecoder<infer A> }
			? A
			: X extends { readonly relation: { readonly fact: RowDecoder<infer A> } }
				? A
				: never

/** A Db's workload handles: each program of P under its name, compiled for R. */
export type WorkloadHandles<R, P> = { readonly [K in keyof P]: Compiled<R, P[K], RecordsOf<P[K]>> }

/**
 * What db.apply and a compiled ChangeSet's apply answer: the ChangeSet was accepted, with each written relation's counts
 * and the read-backs; it changed nothing; laws rejected it, with the witness; or a fact it inserts or puts lies outside
 * the written world relation. A rejection names one law wherever what grizzle controls decides which, and the laws one
 * native object discharges together where it cannot, as a family's axis foreign key does every containment merged
 * into it (packages/grizzle/src/adapter/witness/classify.ts).
 */
export type ApplyOutcome<Reads> =
	| {
			readonly kind: "accepted"
			readonly counts: ReadonlyArray<{
				readonly relation: string
				readonly added: bigint
				readonly deleted: bigint
				readonly put: bigint
			}>
			readonly reads: Reads
	  }
	| { readonly kind: "no-change"; readonly reads: Reads }
	| {
			readonly kind: "invariant-rejected"
			readonly laws: Arr.NonEmptyReadonlyArray<Law>
			readonly witness: Witness
	  }
	| { readonly kind: "outside-world"; readonly relation: string }

export interface QueryResult<Head> {
	/** The rows, as an Effect: each run of it runs the query again. */
	readonly collect: Effect.Effect<ReadonlyArray<Head>, ReadError>
}

/** An estimate-only plan, one per emitted statement in execution order; never EXPLAIN ANALYZE. */
export interface Plan {
	readonly node: string
	readonly startupCost: number
	readonly totalCost: number
	readonly rows: number
	readonly width: number
	readonly children: ReadonlyArray<Plan>
}
