import type { Phantom } from "#compiler/core/phantom.ts"
import type { ChangeSetAt } from "#compiler/types/changeset/changeset.ts"
import type { OrderedAt, QueryAt } from "#compiler/types/query/query.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema, LevelsOf, RelationOf } from "#compiler/types/schema/schema.ts"
import type { CandidateKey } from "#compiler/types/schema/statements.ts"
import type { AnyRole, WriteListOf } from "#compiler/types/schema/world.ts"

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
 * A program of a workload over S, over S or a level below it, L: a query, an ordered query, a ChangeSet S writes or a
 * relation's key.
 */
type ProgramAt<S, L> = QueryAt<L> | OrderedAt<L> | (ChangeSetAt<L> & WritableBy<S>) | KeyAt<L>

export type WorkloadConstructor = <
	S extends AnySchema,
	const Programs extends Record<string, ProgramAt<S, LevelsOf<S>>>
>(
	schema: S,
	programs: Programs
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
export type AnyWorkload = Workload<AnySchema, Readonly<Record<string, unknown>>>
