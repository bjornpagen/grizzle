/**
 * What a served program takes and answers, at the type level, by its program type X: its input, its value and its
 * events, each chosen by the program's shape.
 */
import type { Delivering, phantom } from "#compiler/core/phantom.ts"
import type { EventOfShape } from "#compiler/live/events.ts"
import type { ReadState, WriteState } from "#compiler/live/fold.ts"
import type { RowKey } from "#compiler/live/key.ts"
import type { KeyedList, KeyedSet } from "#compiler/live/keyed.ts"
import type { AnyChangeSet, ArraysOf, FactsCheck } from "#compiler/types/changeset/changeset.ts"
import type {
	OnlyParams,
	ParamArg,
	ParamNeeds,
	ParamsContribution,
	ParamValue,
	Refusal,
	UnionToIntersection
} from "#compiler/types/core/phantom.ts"
import type { Clocked, Deferrable, Paged, ReadOf, Refresh } from "#compiler/types/db/workload.ts"
import type { OrderedBase, ParamsOf } from "#compiler/types/query/query.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { CandidateKey, KeyValues } from "#compiler/types/schema/statements.ts"

/**
 * The facts of a call of a program that holds no array member, every read and refresh among them: the record of no op,
 * which names no key, and which the runtime reads as a record with no own key (adapter db/input.ts noFacts).
 */
export type NoFacts = FactsBy<unknown>

/**
 * A call's input: exactly the parameters and facts its program takes, both always present, `{}` where none; a paged
 * program's adds its window (WindowInput).
 */
export interface Input<P, F> {
	readonly params: P
	readonly facts: F
}

/**
 * Where a window of an ordered program starts: its first rows; the rows after a key; its last rows; or the rows
 * before a key. A key is the program's completed order, so an anchor is a row's key as its events carry it.
 */
export type Anchor =
	| { readonly kind: "start" }
	| { readonly kind: "after"; readonly key: RowKey }
	| { readonly kind: "end" }
	| { readonly kind: "before"; readonly key: RowKey }

/**
 * A paged program's window, beside its params: `size` rows from `anchor`. An empty window is the end of the rows;
 * scrolling is a new call, and a window is live as any value is.
 */
export interface Window {
	readonly anchor: Anchor
	readonly size: number
}

/** The counts of one relation a write changed. */
export interface RelationCounts {
	readonly relation: string
	readonly added: bigint
	readonly deleted: bigint
	readonly put: bigint
}

/**
 * A ChangeSet's outcome, sent after its COMMIT: `accepted`, some relation's count is nonzero, with the counts and
 * the read-backs; or `unchanged`, with the read-backs. Every refusal is an error (CallError), never an outcome.
 */
export type WriteOutcome<Reads> =
	| {
			readonly kind: "accepted"
			readonly counts: ReadonlyArray<RelationCounts>
			readonly reads: Reads
	  }
	| { readonly kind: "unchanged"; readonly reads: Reads }

/** A refresh's outcome, sent after its COMMIT: every target refreshed. */
export interface Refreshed {
	readonly kind: "refreshed"
}

/** What a key member reads by: a relation's primary key, a closed relation's, or a candidate key. */
type KeyTarget = AnyRelation | AnyClosed | CandidateKey<AnyRelation>

/**
 * The shape of a served program's answer, a deferrable member's its read's: an ordered or paged read's is a list, a
 * write's a write, a read's a set, and a clocked read's its list or set at its call's instant alone.
 */
export type ShapeOf<X> = ShapeOfProgram<ReadOf<X>>

/** The shape of a program's answer (ShapeOf), a deferrable member's read unwrapped. */
type ShapeOfProgram<X> =
	X extends Paged<unknown>
		? "list"
		: X extends Refresh<unknown>
			? "write"
			: X extends Clocked<infer P, unknown>
				? P extends AnyChangeSet
					? "write"
					: P extends OrderedBase
						? "instantList"
						: "instantSet"
				: X extends AnyChangeSet
					? "write"
					: X extends OrderedBase
						? "list"
						: "set"

/**
 * The program a served member runs: a deferrable member's read's, a paged member's ordered query, a clocked member's
 * program, or the member itself.
 */
type ProgramOf<X> =
	X extends Deferrable<infer R>
		? ProgramOf<R>
		: X extends Paged<infer O>
			? O
			: X extends Clocked<infer P, unknown>
				? P
				: X

/** The records a program delivers, as its own type states them: a read's rows, a ChangeSet's read-backs. */
type RecordsOf<X> = ProgramOf<X> extends Delivering<infer A> ? A : never

/** A served read's rows, each a record of its head fields: its program's. */
export type RowOf<X> = Extract<RecordsOf<X>, object>

/** A served write's outcome: a refresh's, or a ChangeSet's over its read-backs. */
export type OutcomeOf<X> = X extends Refresh<unknown> ? Refreshed : WriteOutcome<RecordsOf<X>>

/** A paged program's input: its ordered query's params, no facts, and the window it reads. */
export interface WindowInput<P> extends Input<P, NoFacts> {
	readonly window: Window
}

/**
 * The array members whose facts a served program X's calls take, by op, then relation name (ArraysOf): its program's
 * (ProgramOf), a clocked ChangeSet's its ChangeSet's; unknown, none, for a program that holds none.
 */
type ArraysTakenBy<X> = ArraysOf<ProgramOf<X>>

/**
 * The parameter map a served program X's calls bind, its read's for a deferrable member (ParamsOf): a paged member's
 * ordered query's; a clocked member's program's but for the params its clock binds, which no call supplies; none,
 * unknown, for a refresh.
 */
type ParamsTakenBy<X> = ParamsOfProgram<ReadOf<X>>

/** The parameter map a program's calls bind (ParamsTakenBy), its read unwrapped. */
type ParamsOfProgram<X> =
	X extends Paged<infer O>
		? ParamsOf<O>
		: X extends Refresh<unknown>
			? unknown
			: X extends Clocked<infer P, infer B>
				? Omit<ParamsOf<P>, keyof B>
				: ParamsOf<X>

/**
 * The facts of the array members A (ArraysOf): a record holding under each op of its members a record of an array of
 * rows under each relation of that op's members; for A of none, the record of no op (NoFacts), a record naming no key.
 */
type FactsBy<A> = object & {
	readonly [Op in keyof A]: {
		readonly [N in keyof A[Op]]: A[Op][N] extends { readonly row: infer Row }
			? ReadonlyArray<Row>
			: never
	}
}

/**
 * A served program's input: a key member's key values; a paged member's params and window; any other's params and
 * facts (ParamsTakenBy, ArraysTakenBy), a refresh's and a read's facts none; a deferrable member's its read's.
 */
export type InputOf<X> = InputOfProgram<ReadOf<X>>

/** A program's input (InputOf), its read unwrapped. */
type InputOfProgram<X> =
	X extends Paged<unknown>
		? WindowInput<ParamArg<ParamsOfProgram<X>>>
		: X extends KeyTarget
			? Input<KeyValues<X> & { readonly [K in keyof KeyValues<X>]: ParamValue }, NoFacts>
			: Input<ParamArg<ParamsOfProgram<X>>, FactsBy<ArraysTakenBy<X>>>

/**
 * What a caller's input I of a served program X must be: I is inferred from the input alone, apart from X, so a
 * literal's parameters take part in no inference that would widen them ("Front" to string), and checked here after,
 * each member at its own key, so a refusal lands where the input holds it, a variable of a wider type refused where the
 * runtime refuses it, as a literal is:
 * - its members X's input's exactly (InputOf), the runtime reading a record of exactly those (adapter db/input.ts);
 * - its params X's, naming no other parameter (OnlyParams, adapter reader/params.ts readParams), but a key member's,
 *   read by the key's fields alone, so a whole fact of its relation names its key;
 * - its facts exactly those of X's array members (FactsCheck, runtime/write/members.ts memberFactsOf, and the record of
 *   no op for a program that holds none, adapter db/input.ts noFacts): under each op of its members and no other, an
 *   array under each relation of that op's members and no other, each checked as insert, delete and put check their
 *   own, so no fact holds a field beyond its row and no two literal facts share a key with different values;
 * - a paged member's window a Window.
 */
export type InputCheck<I, X> = OnlyInputMembers<I, X> & {
	readonly [K in keyof InputOf<X>]: K extends "facts"
		? FactsCheck<FactsIn<I>, ArraysTakenBy<X>>
		: K extends "params"
			? InputOf<X>[K] & ParamsCheck<I, X>
			: InputOf<X>[K]
}

/** An input I holds X's input members alone (InputCheck). */
type OnlyInputMembers<I, X> = [Exclude<keyof I, keyof InputOf<X>>] extends [never]
	? unknown
	: Refusal<"an input holds its params and facts, and a paged member's window, alone">

/** An input I's params name only X's parameters, but a key member's (InputCheck). */
type ParamsCheck<I, X> =
	ReadOf<X> extends KeyTarget ? unknown : OnlyParams<ParamsIn<I>, ParamsTakenBy<X>>

/** The parameters an input holds. */
type ParamsIn<I> = I extends { readonly params: infer P } ? P : unknown

/** The facts an input holds. */
type FactsIn<I> = I extends { readonly facts: infer F } ? F : unknown

/**
 * The served program readers by key, what a workload handle reads its program X by (adapter types/db.ts
 * MemberHandle): each of ShapeOf, RowOf, OutcomeOf, InputOf, InputCheck, ValueOf and EventOf, the program's kind told by
 * its keys and its parts read by key (ReadByKey, ProgramByKey, the phantom's members), never by a test of it. A query
 * holds its schema, and a conditional the checker resolves instantiates its operands whole, every relation of the
 * schema with them, once for every query a Db serves. A program's keys tell its kind: a deferrable member's
 * `deferrable`, a paged one's `paged`, a clocked one's `clocked`, a refresh's `refresh`, a ChangeSet's `reads`, an
 * ordered query's `take`, and a relation's, a closed relation's or a candidate key's `kind`; a query has none of them. A
 * value typed `any` or `never`, or one with a symbol index signature, whose keys are every symbol, is read by the
 * structural readers above (ByKeys). The structural readers stay what a type generic in its program reads (client
 * Watched, ProgramClient): the checker measures a generic type's variance in its program through them, and a test of a
 * program's keys relates no two programs, which would make such a type invariant in it.
 */
type ByKeys<X> = symbol extends keyof X ? false : true

/** A deferrable member's read, or the program itself where it is none (workload.ts ReadOf), by its keys. */
type ReadByKey<X> = X extends unknown
	? ByKeys<X> extends true
		? "deferrable" extends keyof X
			? X["deferrable" & keyof X]
			: X
		: ReadOf<X>
	: never

/** ShapeOf by the program's keys. */
export type ServedShape<X> = ShapeOfRead<ReadByKey<X>>

/** The shape of a program's answer (ShapeOf), a deferrable member's read unwrapped, by its keys. */
type ShapeOfRead<X> = X extends unknown
	? ByKeys<X> extends true
		? "paged" extends keyof X
			? "list"
			: "refresh" extends keyof X
				? "write"
				: "clocked" extends keyof X
					? InstantShapeOf<X["clocked" & keyof X]>
					: "reads" extends keyof X
						? "write"
						: "take" extends keyof X
							? "list"
							: "set"
		: ShapeOfProgram<X>
	: never

/** A clocked member's shape by its program's keys: a ChangeSet's a write, an ordered query's a list at its instant. */
type InstantShapeOf<P> = P extends unknown
	? ByKeys<P> extends true
		? "reads" extends keyof P
			? "write"
			: "take" extends keyof P
				? "instantList"
				: "instantSet"
		: ShapeOfProgram<Clocked<P, unknown>>
	: never

/** ProgramOf by the member's keys. */
type ProgramByKey<X> = X extends unknown
	? ByKeys<X> extends true
		? "deferrable" extends keyof X
			? ProgramByKey<X["deferrable" & keyof X]>
			: "paged" extends keyof X
				? X["paged" & keyof X]
				: "clocked" extends keyof X
					? X["clocked" & keyof X]
					: X
		: ProgramOf<X>
	: never

/** RecordsOf by the program's keys. */
type RecordsByKey<X> = ByKeys<X> extends true ? DeliveredBy<ProgramByKey<X>> : RecordsOf<X>

/**
 * What a program delivers (Delivering), read by key as the inference reads it: the member's type but undefined, and
 * unknown where it states none.
 */
type DeliveredBy<P> =
	ByKeys<P> extends true
		? DeliversKey extends keyof P
			? Exclude<P[DeliversKey & keyof P], undefined>
			: unknown
		: [P] extends [Delivering<infer A>]
			? A
			: never
type DeliversKey = keyof Delivering<unknown>

/** RowOf by the program's keys. */
export type ServedRow<X> = Extract<RecordsByKey<X>, object>

/** OutcomeOf by the program's keys. */
export type ServedOutcome<X> =
	ByKeys<X> extends true
		? X extends unknown
			? "refresh" extends keyof X
				? Refreshed
				: WriteOutcome<RecordsByKey<X>>
			: never
		: OutcomeOf<X>

/** ArraysTakenBy by the program's keys: a query's, an ordered query's and a refresh's none, as ArraysOf reads them. */
export type ServedArrays<X> =
	ByKeys<X> extends true ? ArraysByKey<ProgramByKey<X>> : ArraysTakenBy<X>
type ArraysByKey<P> = P extends unknown
	? ByKeys<P> extends true
		? "reads" extends keyof P
			? ArraysOf<P>
			: "kind" extends keyof P
				? ArraysOf<P>
				: unknown
		: ArraysOf<P>
	: never

/** ParamsTakenBy by the program's keys. */
export type ServedParams<X> = ByKeys<X> extends true ? ParamsOfRead<ReadByKey<X>> : ParamsTakenBy<X>

/** The parameter map a program's calls bind (ParamsOfProgram), its read unwrapped, by its keys. */
type ParamsOfRead<X> = X extends unknown
	? ByKeys<X> extends true
		? "paged" extends keyof X
			? ProgramParams<X["paged" & keyof X]>
			: "refresh" extends keyof X
				? unknown
				: "clocked" extends keyof X
					? Omit<ProgramParams<X["clocked" & keyof X]>, keyof X["clock" & keyof X]>
					: ProgramParams<X>
		: ParamsOfProgram<X>
	: never

/**
 * A program's parameter map (query.ts ParamsOf, core/phantom.ts ParamsOfTerm), read off its phantom by key, each
 * program of a union its own; a value indexed by number, an array, read by ParamsOf itself.
 */
type ProgramParams<P> = P extends unknown
	? ByKeys<P> extends true
		? number extends keyof P
			? ParamsOf<P>
			: UnionToIntersection<ParamsContribution<PhantomParams<P>>>
		: ParamsOf<P>
	: never
type PhantomParams<P> = typeof phantom extends keyof P
	? BundleParams<Exclude<P[typeof phantom & keyof P], undefined>>
	: unknown
type BundleParams<B> = B extends unknown
	? "needs" extends keyof B
		? NeedsOf<B["needs" & keyof B]>
		: "params" extends keyof B
			? B["params" & keyof B]
			: unknown
	: never
type NeedsOf<F> = F extends ParamNeeds<infer P> ? P : unknown

/** InputOf by the program's keys. */
export type ServedInput<X> =
	ByKeys<X> extends true ? InputOfRead<ReadByKey<X>> : InputOfProgram<ReadOf<X>>

/**
 * A program's input (InputOfProgram), its read unwrapped, by its keys, each input built over its parts (InputFrom,
 * WindowFrom): an interface written over an alias of X is a reference the checker resolves later, holding X.
 */
type InputOfRead<X> = X extends unknown
	? ByKeys<X> extends true
		? "paged" extends keyof X
			? WindowFrom<ParamArg<ParamsOfRead<X>>>
			: "kind" extends keyof X
				? InputFrom<KeyValues<X> & { readonly [K in keyof KeyValues<X>]: ParamValue }, NoFacts>
				: InputFrom<ParamArg<ParamsOfRead<X>>, FactsBy<ArraysByKey<ProgramByKey<X>>>>
		: InputOfProgram<X>
	: never
type InputFrom<P, F> = Input<P, F>
type WindowFrom<P> = WindowInput<P>

/** Whether a served program X reads by a key (ParamsCheck's KeyTarget), by its keys. */
export type KeyRead<X> =
	ByKeys<X> extends true
		? false extends KeyReads<X>
			? false
			: true
		: ReadOf<X> extends KeyTarget
			? true
			: false
type KeyReads<X> = X extends unknown ? ("kind" extends keyof ReadByKey<X> ? true : false) : never

/**
 * InputCheck over what it reads of X, each part X's alone: its input In (InputOf), its array members A
 * (ArraysTakenBy), its parameters Ps (ParamsTakenBy) and whether it reads by a key (KeyRead), each a ServedInput,
 * ServedArrays, ServedParams and KeyRead of X where a handle reads it. A call checks its input I here once I is inferred,
 * after its program's parts are read: a type over I and X that waits for I holds X, and is instantiated again, X whole,
 * once I is known.
 */
export type InputCheckOf<I, In, A, Ps, Key extends boolean> = OnlyInputMembersOf<I, In> & {
	readonly [K in keyof In]: K extends "facts"
		? FactsCheck<FactsIn<I>, A>
		: K extends "params"
			? In[K] & (Key extends true ? unknown : OnlyParams<ParamsIn<I>, Ps>)
			: In[K]
}

/** An input I holds the members of its program's input In alone (OnlyInputMembers). */
type OnlyInputMembersOf<I, In> = [Exclude<keyof I, keyof In>] extends [never]
	? unknown
	: Refusal<"an input holds its params and facts, and a paged member's window, alone">

/** ValueOf by the program's keys. */
export type ServedValue<X> = {
	readonly set: KeyedSet<ServedRow<X>>
	readonly list: KeyedList<ServedRow<X>>
	readonly instantSet: KeyedSet<ServedRow<X>>
	readonly instantList: KeyedList<ServedRow<X>>
	readonly write: ServedOutcome<X>
}[ServedShape<X>]

/**
 * A served program's value: a set read's keyed set, an ordered read's keyed list, at its call's instant or live alike,
 * and a write's outcome.
 */
export type ValueOf<X> = {
	readonly set: KeyedSet<RowOf<X>>
	readonly list: KeyedList<RowOf<X>>
	readonly instantSet: KeyedSet<RowOf<X>>
	readonly instantList: KeyedList<RowOf<X>>
	readonly write: OutcomeOf<X>
}[ShapeOf<X>]

/** A served program's events, by its shape (live/events.ts events). */
export type EventOf<X> = EventOfShape<ShapeOf<X>, RowOf<X>, OutcomeOf<X>>

/** A served program's state as its events build it (live/fold.ts fold, foldWrite), by its shape. */
export type StateOf<X> = {
	readonly set: ReadState<"set", RowOf<X>>
	readonly list: ReadState<"list", RowOf<X>>
	readonly instantSet: ReadState<"set", RowOf<X>>
	readonly instantList: ReadState<"list", RowOf<X>>
	readonly write: WriteState<OutcomeOf<X>>
}[ShapeOf<X>]
