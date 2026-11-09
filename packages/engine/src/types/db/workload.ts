import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Phantom } from "#compiler/core/phantom.ts"
import type { ChangeSetAt, PlannedStrata } from "#compiler/types/changeset/changeset.ts"
import type { MembersTyped } from "#compiler/types/core/phantom.ts"
import type { AnyMaterialized } from "#compiler/types/derived/derived.ts"
import type { OrderedAt, OrderedBase, QueryAt } from "#compiler/types/query/query.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema, LevelsOf, RelationOf } from "#compiler/types/schema/schema.ts"
import type { CandidateKey } from "#compiler/types/schema/statements.ts"
import type { AnyRole, RefreshListOf, WriteListOf } from "#compiler/types/schema/world.ts"

/** A stored or closed relation of L, which a key reads through. */
type KeyedAt<L> = L extends unknown ? Extract<RelationOf<L>, AnyRelation | AnyClosed> : never

/**
 * A key of a relation over L: the relation itself, for its primary key, or a candidate key of an ordinary relation of
 * L, a Key from key() over a side of its whole relation's fields.
 */
type KeyAt<L> = KeyedAt<L> | CandidateKey<Extract<KeyedAt<L>, AnyRelation>>

/**
 * What a ChangeSet of a workload over S writes: over a role, only relations its write list names, as a Db of the role
 * applies it; over a schema, any of its relations.
 */
type WritableBy<S> = S extends AnyRole ? Phantom<{ readonly writes: WriteListOf<S> }> : unknown

/**
 * A workload member that pages its ordered query O: paged(O), whose handle pages as well as reading. A plain ordered
 * member reads only, and the layer compiles a page template only for a paged one.
 */
export interface Paged<O> {
	readonly paged: O
}

/**
 * A workload member that refreshes the materialized derived relations of the nonempty list Rs: refresh(Rs), whose handle
 * refreshes them all in one transaction (`yield* db.workload.<name>.refresh`), lower levels first. It reads and writes
 * nothing else.
 */
export interface Refresh<Rs> {
	readonly refresh: Rs
}

/** The materialized derived relations of a level L, one level at a time. */
type MaterializedAt<L> = L extends unknown ? Extract<RelationOf<L>, AnyMaterialized> : never

/**
 * What a refresh member of a workload over S refreshes: over a role, only the relations its refresh list names, as a Db
 * of the role refreshes them; over a schema, any materialized derived relation of it or a level below it.
 */
type RefreshableBy<S> = S extends AnyRole ? RefreshListOf<S> : MaterializedAt<LevelsOf<S>>

/**
 * A program of a workload over S, over S or a level below it, L: a query, an ordered query, an ordered query that pages,
 * a ChangeSet S writes, a relation's key, or a refresh of materialized derived relations S may refresh.
 */
type ProgramAt<S, L> =
	| QueryAt<L>
	| OrderedAt<L>
	| Paged<OrderedAt<L>>
	| (ChangeSetAt<L> & WritableBy<S>)
	| KeyAt<L>
	| Refresh<NonEmptyReadonlyArray<RefreshableBy<S>>>

/**
 * workload(schema, programs): each program over a level of the schema (ProgramAt), a ChangeSet's appends each beside
 * its immutable owner's insert (PlannedStrata). A program typed `any` is refused (MembersTyped).
 */
export type WorkloadConstructor = <
	S extends AnySchema | AnyRole,
	const Programs extends Record<string, ProgramAt<S, LevelsOf<S>>>
>(
	schema: S,
	programs: Programs & {
		readonly [K in keyof Programs]: PlannedStrata<Programs[K]>
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

/** paged(ordered): the workload member that pages the ordered query `ordered` (Paged). */
export type PagedConstructor = <const O extends OrderedBase>(ordered: O) => Paged<O>

/**
 * refresh(relations): the workload member that refreshes the materialized derived relations of the nonempty list
 * `relations` (Refresh).
 */
export type RefreshConstructor = <const Rs extends NonEmptyReadonlyArray<AnyMaterialized>>(
	relations: Rs
) => Refresh<Rs>
