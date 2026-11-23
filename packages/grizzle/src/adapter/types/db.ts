import type { Effect, Stream } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { DbLayerService, ServedRole } from "#adapter/types/layer.ts"
import type {
	CallError,
	EventOfShape,
	InputCheck,
	InputCheckOf,
	AnsweredShape,
	KeyRead,
	ServedArrays,
	ServedInput,
	ServedOutcome,
	ServedParams,
	ServedRow,
	ServedShape,
	ServedValue
} from "#compiler/live/index.ts"
import type { AnyChangeSet, BrokenLaws, Witness } from "#compiler/plan/change.ts"
import type {
	AnyRole,
	AttestedFactsOf,
	Clocked,
	Invariant,
	Phantom,
	ReadsAttested,
	ReadsToken
} from "#compiler/plan/common.ts"

/**
 * Db.open's token: what the layer's verify turns into the payload the role's token contexts are decoded from, once per
 * Db. It is required exactly when the role declares a context of a token's claims (ReadsToken), and a role that
 * declares none may still be opened with one, which verify reads.
 */
export type TokenOptions<R> =
	ReadsToken<R> extends true ? { readonly token: string } : { readonly token?: string }

/**
 * Db.open's attested facts: under each context the role declares that its server attests (attested(...)), its one fact
 * or none (AttestedFactsOf), stated by the server where it opens the Db, never read from a token. It is required exactly
 * when the role declares such a context (ReadsAttested), absent where it declares none, and optional for a role whose
 * type does not say.
 */
export type AttestedOptions<R> =
	unknown extends ReadsAttested<R>
		? { readonly attested?: AttestedFactsOf<R> }
		: ReadsAttested<R> extends true
			? { readonly attested: AttestedFactsOf<R> }
			: { readonly attested?: never }

/**
 * Db.open's options for role R: its token (TokenOptions) and its attested facts (AttestedOptions), each required exactly
 * when the role declares a context of its source, so `{}` opens a role that declares none. The snapshot is the layer's
 * (DbConfig), since an application has exactly one.
 */
export type OpenOptions<R> = TokenOptions<R> & AttestedOptions<R>

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
	/**
	 * Db.openMoved(role, options, instant): a test's Db of `role` over a moved clock (adapter/db/moved.ts), opened as
	 * Db.open opens it, its role a role of a served file compiled for a moved clock (compileServedMoved): each call of a
	 * clocked read or a change reads `instant` once, a bigint count of microseconds since the Unix epoch, and every
	 * reading of the database's clock in it, each clocked parameter's and each stamp's, is exactly that instant.
	 */
	openMoved<R extends AnyRole, P>(
		role: ServedRole<R, P>,
		options: OpenOptions<R>,
		instant: Effect.Effect<bigint>
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
 * `{ params, facts, window }`), and a read's or a change's explains; an answered read's (workload Answered), a clocked
 * one's among them, `once` alone, since its answer is its read at its call's instant, which no change wakes. X itself is in the type, so a handle of
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
 * A served member's calls (MemberHandle): its once, and its watch but for an answered read's, a clocked one's among
 * them, whose shape is an answered one (live/events.ts AnsweredShape). Each takes an input I inferred apart from X and checked after as X's input exactly
 * (live/program.ts InputCheck): its params, its facts and a paged member's window, each refused where the runtime
 * refuses it.
 */
export type MemberCalls<X> = CallsOf<
	ServedShape<X>,
	ServedInput<X>,
	ServedArrays<X>,
	ServedParams<X>,
	KeyRead<X>,
	ServedValue<X>,
	EventOfShape<ServedShape<X>, ServedRow<X>, ServedOutcome<X>>
>

/**
 * MemberCalls over the parts of X its calls read, each read once X is known (live/program.ts ServedShape, ServedInput,
 * ServedArrays, ServedParams, KeyRead, ServedValue, and its events): its shape Sh, its input In, its array members A,
 * its parameters Ps, whether it reads by a key, its value V and its events Ev. A call of a member of an interface over X
 * maps X to the program through the call's own mapper, which instantiates the program whole, its schema with it, so
 * the calls are over X's parts alone; and the shape is a parameter of its own, since a tuple of an alias over X,
 * `[ShapeOf<X>] extends [...]`, is a reference the checker resolves later, holding X.
 */
type CallsOf<Sh, In, A, Ps, Key extends boolean, V, Ev> = [Sh] extends [AnsweredShape]
	? OnceCall<In, A, Ps, Key, V>
	: OnceCall<In, A, Ps, Key, V> & WatchCall<In, A, Ps, Key, Ev>

/** A served member's once: its events taken to ready, folded, the value V or the CallError that ended them. */
interface OnceCall<In, A, Ps, Key extends boolean, V> {
	once<const I>(input: I & NoInfer<InputCheckOf<I, In, A, Ps, Key>>): Effect.Effect<V, CallError>
}

/** A served member's watch: its events Ev, a read's live after its ready. */
interface WatchCall<In, A, Ps, Key extends boolean, Ev> {
	watch<const I>(input: I & NoInfer<InputCheckOf<I, In, A, Ps, Key>>): Stream.Stream<Ev>
}

/**
 * A served member's explains by its program's kind: a read's, a change's, a clocked member's by its program's, each
 * taking the member's own input. The kind is told by the program's keys (live/program.ts ServedShape), never by a test
 * of the program,
 * which holds its schema: a value typed `any` or `never`, whose keys are every symbol, is read structurally.
 */
type ExplainOf<X> = symbol extends keyof X ? ExplainOfProgram<X> : ExplainByKey<X>
type ExplainByKey<X> = X extends unknown
	? "write" extends ServedShape<X>
		? ChangeExplain<X>
		: ReadExplain<X>
	: never
/** The explains of a program read structurally: none for a program typed `any`, which may be any program; a change's or a
 * read's by what the program is. */
type ExplainOfProgram<X> = 0 extends 1 & X
	? unknown
	: (X extends Clocked<infer P, unknown> ? P : X) extends AnyChangeSet
		? ChangeExplain<X>
		: ReadExplain<X>

/**
 * A served read member's plans for a call's input, as its once takes it: the one statement its once sends, a paged
 * member's for its window's template and anchor, planned by PostgreSQL for those values in one transaction of the Db's
 * role that is rolled back, the read's own, at its level (served/forms.ts ServedRead isolation). `explain` asks
 * for PostgreSQL's estimates alone and runs nothing; `explainAnalyze` runs the statement under EXPLAIN ANALYZE and
 * reports what each node did beside its estimates. Each fails as the member's once fails, with the CallError its read
 * would end in.
 */
export interface ReadExplain<X> {
	explain<const I>(
		input: I & NoInfer<InputCheck<I, X>>
	): Effect.Effect<ReadonlyArray<StatementPlan>, CallError>
	explainAnalyze<const I>(
		input: I & NoInfer<InputCheck<I, X>>
	): Effect.Effect<ReadonlyArray<ExecutedStatement>, CallError>
}

/**
 * A served change member's plans for a call's input, as its once takes it: the estimates of every statement its once
 * sends, in one transaction of the Db's role at SERIALIZABLE that is rolled back, so it writes nothing. A ChangeSet's
 * statements are never run under EXPLAIN ANALYZE, which would run them. It fails with the CallError a read of its statements would end in.
 */
export interface ChangeExplain<X> {
	explain<const I>(
		input: I & NoInfer<InputCheck<I, X>>
	): Effect.Effect<ReadonlyArray<StatementPlan>, CallError>
}

/**
 * What db.apply and a compiled ChangeSet's apply answer: the ChangeSet was accepted, with each written relation's counts
 * and the read-backs; it changed nothing; laws rejected it, `refused` saying which and how grizzle decided them
 * (types/changeset BrokenLaws), with the witness; or a fact it inserts or puts lies outside the written world relation. A
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
			readonly refused: BrokenLaws
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
		refused: BrokenLaws,
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
 * - `relation`: a relation's table, an authored or a stored derived relation's, by the relation's declared name, read
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
