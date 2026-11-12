/**
 * What a served program takes and answers, at the type level, by its program type X: its input, its value and its
 * events, each chosen by the program's shape.
 */
import type { Delivering } from "#compiler/core/phantom.ts"
import type { EventOfShape } from "#compiler/live/events.ts"
import type { ReadState, WriteState } from "#compiler/live/fold.ts"
import type { RowKey } from "#compiler/live/key.ts"
import type { KeyedList, KeyedSet } from "#compiler/live/keyed.ts"
import type { AnyChangeSet, ArraysOf } from "#compiler/types/changeset/changeset.ts"
import type { ParamArg, ParamValue } from "#compiler/types/core/phantom.ts"
import type { Clocked, Paged, Refresh } from "#compiler/types/db/workload.ts"
import type { OrderedBase, ParamsOf } from "#compiler/types/query/query.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { CandidateKey, KeyValues } from "#compiler/types/schema/statements.ts"

/** The empty record: the params of a program that declares none, and the facts of every call that writes no array. */
export type Empty = { readonly [member: string]: never }

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
 * The shape of a served program's answer: an ordered or paged read's is a list, a write's a write, a read's a set, and
 * a clocked read's its list or set at its call's instant alone.
 */
export type ShapeOf<X> =
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

/** The program a served member runs: a paged member's ordered query, a clocked member's program, or the member itself. */
type ProgramOf<X> = X extends Paged<infer O> ? O : X extends Clocked<infer P, unknown> ? P : X

/** The records a program delivers, as its own type states them: a read's rows, a ChangeSet's read-backs. */
type RecordsOf<X> = ProgramOf<X> extends Delivering<infer A> ? A : never

/** A served read's rows, each a record of its head fields: its program's. */
export type RowOf<X> = Extract<RecordsOf<X>, object>

/** A served write's outcome: a refresh's, or a ChangeSet's over its read-backs. */
export type OutcomeOf<X> = X extends Refresh<unknown> ? Refreshed : WriteOutcome<RecordsOf<X>>

/** A paged program's input: its ordered query's params, no facts, and the window it reads. */
export interface WindowInput<P> extends Input<P, Empty> {
	readonly window: Window
}

/**
 * A ChangeSet's facts: under each op of its array members, an array of rows under each relation of that op's
 * members; the empty record for one that holds none.
 */
type FactsOf<X> = [keyof ArraysOf<X>] extends [never]
	? Empty
	: {
			readonly [Op in keyof ArraysOf<X>]: {
				readonly [N in keyof ArraysOf<X>[Op]]: ArraysOf<X>[Op][N] extends {
					readonly row: infer Row
				}
					? ReadonlyArray<Row>
					: never
			}
		}

/**
 * A served program's input: a paged member's params and window; a ChangeSet's params and facts; a key member's key
 * values; a refresh's nothing; a read's params; a clocked member's its program's, but for the params it binds to the
 * database's clock, which no call supplies.
 */
export type InputOf<X> =
	X extends Paged<infer O>
		? WindowInput<ParamArg<ParamsOf<O>>>
		: X extends Refresh<unknown>
			? Input<Empty, Empty>
			: X extends Clocked<infer P, infer B>
				? Input<ParamArg<Omit<ParamsOf<P>, keyof B>>, P extends AnyChangeSet ? FactsOf<P> : Empty>
				: X extends AnyChangeSet
					? Input<ParamArg<ParamsOf<X>>, FactsOf<X>>
					: X extends KeyTarget
						? Input<KeyValues<X> & { readonly [K in keyof KeyValues<X>]: ParamValue }, Empty>
						: Input<ParamArg<ParamsOf<X>>, Empty>

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
