import type { Array as Arr, Effect, Option, Scope } from "effect"
import type { ApplyError, OpenError, ReadError } from "#adapter/errors/execution.ts"
import type { DbLayerService, ServedRole } from "#adapter/types/layer.ts"
import type {
	AnyChangeSet,
	ChangeSet,
	PlannedStrata,
	Refused,
	Witness,
	WritesOf
} from "#compiler/plan/change.ts"
import type {
	AnyClosed,
	AnyRelation,
	AnyRole,
	CandidateKey,
	Carriers,
	CompileError,
	CursorError,
	Evidence,
	Invariant,
	KeyValues,
	LevelsOf,
	OnlyParams,
	Paged,
	ParamArg,
	ParamValue,
	Phantom,
	ReadsContext,
	RefreshListOf,
	Refusal,
	RowDecoder,
	WithinRoleContexts,
	WriteListOf
} from "#compiler/plan/common.ts"
import type {
	ContextsOf,
	EvidenceOfQuery,
	Ordered,
	OrderedBase,
	Page,
	PageOf,
	PageRequest,
	ParamsOf,
	Query,
	QueryBase,
	UnionArms
} from "#compiler/plan/read.ts"

/**
 * Db.open's options with a token: what the layer's verify turns into the payload the role's contexts are decoded from,
 * once per Db.
 */
export interface TokenOptions {
	readonly token: string
}

/** Db.open's options without a token, `{}`: a Db opened so has no context facts. It holds no key, so none is left out. */
export type NoTokenOptions = Readonly<Record<string, never>>

/**
 * Db.open's options for role R: with a token, or, exactly when the role's relations read no context, without one. The
 * snapshot is the layer's (DbConfig), since an application has exactly one.
 */
export type OpenOptions<R> =
	ReadsContext<R> extends true ? TokenOptions : TokenOptions | NoTokenOptions

/**
 * Db.open; packages/grizzle/src/adapter/db/served.ts implements it. It contacts nothing: every transaction of the Db it
 * yields takes the fence and the snapshot guard in its own round trip, and Db.open refuses only what the host alone can
 * judge. Usage: Db.open(Web.roles.member, { token }), where `Web = served<typeof WebLogin>(file, "web")` and the layer is
 * DbLayer.make({ login: Web, ... }): the role is reached through its served login, whose workloads give the Db its
 * programs (`db.workload`). The requirement DbLayer<R> is provided only by the layer of the login that holds R.
 */
export interface DbConstructor {
	open<R extends AnyRole, P>(
		role: ServedRole<R, P>,
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
 * accepts a query over R or over any level below it (AtLevel): Query is invariant in its schema, and a
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
	apply<L, P, W extends string, Reads, Cx extends string, C, const Arg>(
		changes: C &
			ChangeSet<L, P, W, Reads, Cx> &
			AtLevel<R, L> &
			WithinWriteList<R, W> &
			WithinRoleContexts<R, Cx> &
			PlannedStrata<C>,
		params: NoInfer<ParamArg<P>> & Arg & NoInfer<OnlyParams<Arg, P>>
	): Effect.Effect<ApplyOutcome<Reads>, ApplyError>
	/**
	 * A query, ordered query or ChangeSet compiled once, run with each call's parameters through its handle: its
	 * compiled form drops when the Scope ends.
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
		L,
		Head,
		Ev extends Evidence,
		P,
		IHead,
		Hc extends Carriers,
		W extends string,
		Reads,
		Cx extends string,
		Arms extends UnionArms,
		C,
		const Arg
	>(
		program: C &
			(
				| Query<L, Head, Ev, P, IHead, Hc, Cx, Arms>
				| Ordered<L, Head, Ev, P, IHead, Hc, Cx, Arms>
				| ChangeSet<L, P, W, Reads, Cx>
			) &
			AtLevel<R, L> &
			WithinRoleContexts<R, Cx> &
			PlannedStrata<C>,
		params: NoInfer<ParamArg<P>> & Arg & NoInfer<OnlyParams<Arg, P>>
	): Effect.Effect<ReadonlyArray<Plan>, ReadError>
}

/** The schema a query, ordered query or ChangeSet is over. */
type ProgramSchema<X> = X extends Phantom<{ readonly schema: Invariant<infer L> }> ? L : never
/**
 * Every reader, apply and explain accept a program over S or over any level below it, L, and refuse one over any other
 * schema by name.
 */
type AtLevel<S, L> = [L] extends [LevelsOf<S>]
	? unknown
	: Refusal<"a program over no level of the database's schema">
type AtLevelOf<S, X> = AtLevel<S, ProgramSchema<X>>

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
	get<X extends QueryBase | KeyTarget, A, const Arg>(
		target: GetTarget<S, X, A>,
		params: NoInfer<GetArg<X>> & Arg & NoInfer<OnlyArg<Arg, X>>
	): Effect.Effect<Option.Option<A>, ReadError>
	execute<
		L,
		Head,
		Ev extends Evidence,
		P,
		IHead,
		Hc extends Carriers,
		Cx extends string,
		Arms extends UnionArms,
		const Arg
	>(
		query: (
			| Query<L, Head, Ev, P, IHead, Hc, Cx, Arms>
			| Ordered<L, Head, Ev, P, IHead, Hc, Cx, Arms>
		) &
			AtLevel<S, L> &
			WithinRoleContexts<S, Cx>,
		params: NoInfer<ParamArg<P>> & Arg & NoInfer<OnlyParams<Arg, P>>
	): Effect.Effect<QueryResult<Head>, ReadError>
	/**
	 * A page of an ordered query Q over a level of S, with its parameters: its records are Q's, and its cursors are
	 * Q's own, typed by the very query passed in.
	 */
	page<Q, A, const Arg>(
		query: PageTarget<S, Q, A>,
		params: NoInfer<ParamArg<ParamsOf<Q>>> & Arg & NoInfer<OnlyParams<Arg, ParamsOf<Q>>>,
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

/**
 * A ChangeSet's writes lie within the role's write list, every member's where the program is a union of them; a query
 * writes nothing.
 */
type CompiledWrites<R, X> = WithinWriteList<R, X extends AnyChangeSet ? WritesOf<X> : never>

/**
 * db.compile's target: a program X over a level of S, whose decoder delivers A, matching only the contexts S's
 * relations read, and, for a ChangeSet, writing only what S's write list names.
 */
export type CompileTarget<S, X, A> = X &
	ProgramDecoding<A> &
	AtLevelOf<S, X> &
	WithinRoleContexts<S, ProgramContexts<X>> &
	CompiledWrites<S, X> &
	PlannedStrata<X>

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
 * An argument Arg of program X names only X's parameters (OnlyParams), a variable of a wider type as well as a literal;
 * a key's values are read off by the key's fields, so a whole fact may hold them.
 */
type OnlyArg<Arg, X> = X extends KeyTarget ? unknown : OnlyParams<Arg, ParamsOf<X>>

/**
 * A program compiled once, by db.compile or at startup as a workload program (`db.workload`), run with each call's
 * parameters, over records A (its rows, its read-backs, or a key's relation's facts). Exactly the operations its
 * program allows typecheck: execute for a query or ordered query, get for one proved at most one row per parameter
 * binding and for a key, page for an ordered query, apply for a ChangeSet. A page's cursors are for the compiled
 * query X.
 */
export interface Compiled<S, X, A> extends Phantom<{ readonly schema: Invariant<S> }> {
	execute<const Arg>(
		params: NoInfer<CompiledArg<X>> & ReadOp<X> & Arg & NoInfer<OnlyArg<Arg, X>>
	): Effect.Effect<QueryResult<A>, ReadError>
	get<const Arg>(
		params: NoInfer<CompiledArg<X>> & GetOp<X> & Arg & NoInfer<OnlyArg<Arg, X>>
	): Effect.Effect<Option.Option<A>, ReadError>
	page<const Arg>(
		params: NoInfer<CompiledArg<X>> & PageOp<X> & Arg & NoInfer<OnlyArg<Arg, X>>,
		request: PageRequest
	): Effect.Effect<Page<A, X>, ReadError | CursorError>
	apply<const Arg>(
		params: NoInfer<CompiledArg<X>> & ApplyOp<X> & Arg & NoInfer<OnlyArg<Arg, X>>
	): Effect.Effect<ApplyOutcome<A>, ApplyError>
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

/**
 * A Db's workload handles: each program of P under its name, compiled for R. A paged member's handle pages its ordered
 * query; any other member's has no page, since the layer compiled no page template for it.
 */
export type WorkloadHandles<R, P> = {
	readonly [K in keyof P]: P[K] extends Paged<infer O>
		? Compiled<R, O, RecordsOf<O>>
		: Omit<Compiled<R, P[K], RecordsOf<P[K]>>, "page">
}

/**
 * What db.apply and a compiled ChangeSet's apply answer: the ChangeSet was accepted, with each written relation's counts
 * and the read-backs; it changed nothing; laws rejected it, `refused` saying which and how grizzle decided them
 * (types/changeset Refused), with the witness; or a fact it inserts or puts lies outside the written world relation. A
 * rejection names `every` law grizzle decides refused it: each rule of a table's CHECKs a row you stated breaks, the
 * one law of any other object grizzle's statement or PostgreSQL names, or the laws one native object discharges
 * together where it cannot tell them apart, as a family's axis foreign key does every containment merged into it; and
 * the `first` CHECK PostgreSQL reported where the refused row is one only PostgreSQL computes
 * (packages/grizzle/src/adapter/witness/classify.ts).
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
			readonly refused: Refused
			readonly witness: Witness
	  }
	| { readonly kind: "outside-world"; readonly relation: string }

/**
 * The outcome values' constructors, the ones the adapter answers with (adapter/outcomes), so an application's test
 * builds the exact outcome db.apply answers.
 */
export interface ApplyOutcomeConstructor {
	/**
	 * A committed application: `accepted` with `counts` when some relation's count is nonzero, and `no-change`
	 * otherwise, each with the read-backs `reads`. The kind follows the counts alone, as db.apply decides it.
	 */
	committed<Reads>(
		counts: Extract<ApplyOutcome<Reads>, { readonly kind: "accepted" }>["counts"],
		reads: Reads
	): Extract<ApplyOutcome<Reads>, { readonly kind: "accepted" | "no-change" }>
	/** A rejected application: the laws `refused` names and how grizzle decided them, with the `witness`. */
	invariantRejected(
		refused: Refused,
		witness: Witness
	): Extract<ApplyOutcome<never>, { readonly kind: "invariant-rejected" }>
	/** An application a query entry refused: a fact its addition requested lies outside the world `relation`. */
	outsideWorld(relation: string): Extract<ApplyOutcome<never>, { readonly kind: "outside-world" }>
}

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
