import type { Effect, Stream } from "effect"
import type { DeferrableReadError, OpenError, ReadError } from "#adapter/errors/execution.ts"
import type { DbLayerService, ServedRole } from "#adapter/types/layer.ts"
import type {
	CallError,
	EventOf,
	InputCheck,
	InstantShape,
	ShapeOf,
	ValueOf
} from "#compiler/live/index.ts"
import type { AnyChangeSet, Refused, Witness } from "#compiler/plan/change.ts"
import type {
	AnyRole,
	Clocked,
	Deferrable,
	Invariant,
	Phantom,
	ReadsContext,
	Refresh
} from "#compiler/plan/common.ts"

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

/**
 * The opened database: its workload handles. packages/grizzle/src/adapter implements Db (db/served.ts, db/handles.ts);
 * the declarations here are its types.
 *
 * A Db is opened for a role R through its login, whose workloads' programs over R or a level of it are P: `workload`
 * holds their handles, one per program, each loaded once by the layer from the login's served file (DbLayer.make).
 * Every program runs as `grizzle generate` compiled it; a Db compiles none at the call.
 */
export interface DbOf<R, P> {
	readonly workload: WorkloadHandles<R, P>
}

/**
 * A Db's workload handles: each program of P under its name, for R (MemberHandle), so a handle of one Db's program is
 * no handle of another schema's.
 */
export type WorkloadHandles<R, P> = {
	readonly [K in keyof P]: MemberHandle<P[K]> & Phantom<{ readonly schema: Invariant<R> }>
}

/**
 * The calls of a served member of program X, whatever login serves X and whatever role it runs on: exactly `once` and
 * `watch`, each taking the program's input (live/program.ts InputOf: `{ params, facts }`, a paged member's
 * `{ params, facts, window }`), and a read's or a change's explains; a clocked read's (workload Clocked) `once` alone,
 * since its answer is its read at its call's instant, which no change reaches. X itself is in the type, so a handle of
 * one program is no handle of another, whatever calls the two share, and a function over one served program takes any
 * login's handle of it.
 *
 * - `watch(input)`: the call's events (live/events.ts), typed by the program's shape (EventOf). A read's are `reset`,
 *   an `upsert` per row as it decodes, provisional, then `ready` after its COMMIT, then, live, an `upsert` or `remove`
 *   per change; a write's are its `outcome` after its COMMIT. Every failure is one `error` with its CallError, then
 *   `end`; the Stream itself never fails, and a read's runs until the consumer interrupts it.
 * - `once(input)`: watch taken to `ready`, folded (live/fold.ts): a read's value (ValueOf: a set read's KeyedSet, an
 *   ordered or paged read's KeyedList), or a write's outcome; the CallError that ended it is its error.
 */
export type MemberHandle<X> = MemberCalls<X> &
	ExplainOf<X> &
	Phantom<{ readonly program: Invariant<X> }>

/**
 * A served member's calls (MemberHandle): its once, and its watch but for a clocked read's, whose shape is an instant's
 * (live/events.ts InstantShape). Each takes an input I inferred apart from X and checked after as X's input exactly
 * (live/program.ts InputCheck): its params, its facts and a paged member's window, each refused where the runtime
 * refuses it.
 */
export type MemberCalls<X> = [ShapeOf<X>] extends [InstantShape]
	? OnceCall<X>
	: OnceCall<X> & WatchCall<X>

/** A served member's once: its events taken to ready, folded, the value or the CallError that ended them. */
interface OnceCall<X> {
	once<const I>(input: I & NoInfer<InputCheck<I, X>>): Effect.Effect<ValueOf<X>, CallError>
}

/** A served member's watch: its events, a read's live after its ready. */
interface WatchCall<X> {
	watch<const I>(input: I & NoInfer<InputCheck<I, X>>): Stream.Stream<EventOf<X>>
}

/**
 * A served member's explains by its program's kind: a deferrable read's, whose transaction meets no serialization
 * failure, a read's, a change's, a clocked member's by its program's, each taking the member's own input, and a
 * refresh's none.
 */
type ExplainOf<X> =
	X extends Deferrable<unknown>
		? ReadExplain<X, DeferrableReadError>
		: X extends Refresh<unknown>
			? unknown
			: (X extends Clocked<infer P, unknown> ? P : X) extends AnyChangeSet
				? ChangeExplain<X>
				: ReadExplain<X, ReadError>

/**
 * A served read member's plans for a call's input, as its once takes it: the one statement its once sends, a paged
 * member's for its window's template and anchor, planned by PostgreSQL for those values in one transaction of the Db's
 * role that is rolled back, the read's own: SERIALIZABLE READ ONLY, DEFERRABLE for a deferrable member, whose error E
 * then holds no serialization failure. `explain` asks for PostgreSQL's estimates alone and runs nothing;
 * `explainAnalyze` runs the statement under EXPLAIN ANALYZE and reports what each node did beside its estimates.
 */
export interface ReadExplain<X, E> {
	explain<const I>(
		input: I & NoInfer<InputCheck<I, X>>
	): Effect.Effect<ReadonlyArray<StatementPlan>, E>
	explainAnalyze<const I>(
		input: I & NoInfer<InputCheck<I, X>>
	): Effect.Effect<ReadonlyArray<ExecutedStatement>, E>
}

/**
 * A served change member's plans for a call's input, as its once takes it: the estimates of every statement its once
 * sends, in one transaction of the Db's role at SERIALIZABLE that is rolled back, so it writes nothing. A ChangeSet's
 * statements are never run under EXPLAIN ANALYZE: a write rolled back still advances its serial fields' sequences,
 * which no rollback undoes.
 */
export interface ChangeExplain<X> {
	explain<const I>(
		input: I & NoInfer<InputCheck<I, X>>
	): Effect.Effect<ReadonlyArray<StatementPlan>, ReadError>
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

/**
 * An index a plan node reads through, by its PostgreSQL name, one of its table's within its table's schema. A plan names
 * an index alone; `indexesOf(snapshot)` on @bjornpagen/grizzle/compile reads its key columns and why the installation
 * holds it from the snapshot.json a caller passes it.
 */
export interface PlanIndex {
	readonly name: string
}

/**
 * What a plan node reads or writes, as the login's served file names the installation, never parsed back from
 * PostgreSQL's names:
 * - `relation`: a relation's table or a materialized derived relation's view, by the relation's declared name, read
 *   whole or by a bitmap (Seq Scan, Bitmap Heap Scan), or written (Insert, Update, Delete, Merge);
 * - `index`: a relation read through one of its indexes (Index Scan, Index Only Scan, Bitmap Index Scan);
 * - `carrier`: a temporary table the explained ChangeSet itself created and filled for its statements, read whole, since
 *   a carrier holds no index;
 * - `none`: no relation, as a join, a sort, an aggregate or a scan of a CTE, a function or VALUES reads none.
 */
export type PlanTarget =
	| { readonly kind: "none" }
	| { readonly kind: "relation"; readonly relation: string }
	| { readonly kind: "index"; readonly relation: string; readonly index: PlanIndex }
	| { readonly kind: "carrier" }

/**
 * One node of PostgreSQL's plan of a statement: its node type as PostgreSQL names it ("Index Scan", "Hash Join", ...),
 * what it reads (PlanTarget), the planner's estimated startup and total cost, rows and row width, and its children in
 * PostgreSQL's order. Every other member PostgreSQL reports is dropped, so a Plan is one shape across server versions.
 */
export interface Plan {
	readonly node: string
	readonly on: PlanTarget
	readonly startupCost: number
	readonly totalCost: number
	readonly rows: number
	readonly width: number
	readonly children: ReadonlyArray<Plan>
}

/**
 * A node of a plan EXPLAIN ANALYZE ran: a Plan's members, then what the node did, its actual time to its first row
 * and to its last in milliseconds, the rows it returned and the loops it ran, each per loop as PostgreSQL averages
 * them, and the shared buffers it found in memory and read in. A node the run never reached ran no loop.
 */
export interface ExecutedPlan extends Omit<Plan, "children"> {
	readonly actual: {
		readonly startupMs: number
		readonly totalMs: number
		readonly rows: number
		readonly loops: number
	}
	readonly buffers: { readonly sharedHit: number; readonly sharedRead: number }
	readonly children: ReadonlyArray<ExecutedPlan>
}

/**
 * One statement a member sends, planned: the name its text is prepared under on every session (grizzle_ and its
 * SHA-256 in base32, as pg_prepared_statements and pg_stat_statements show it), and its plan's root node. A
 * statement's plan is PostgreSQL's custom plan for the call's values, which a session plans for the statement's first
 * executions; a session that has run it often may run a generic plan instead.
 */
export interface StatementPlan {
	readonly statement: string
	readonly plan: Plan
}

/** One statement a read member sends, run under EXPLAIN ANALYZE: its name, its planning and execution times in
 * milliseconds, and its executed plan's root node. */
export interface ExecutedStatement {
	readonly statement: string
	readonly planningMs: number
	readonly executionMs: number
	readonly plan: ExecutedPlan
}
