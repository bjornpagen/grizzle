import type { ChangeSetAt } from "#compiler/types/changeset/changeset.ts"
import type { OrderedAt, QueryAt } from "#compiler/types/query/query.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema, LevelsOf, RelationOf } from "#compiler/types/schema/schema.ts"
import type { Key } from "#compiler/types/schema/statements.ts"

/** A stored or closed relation of L, which a key reads through. */
type KeyedAt<L> = L extends unknown ? Extract<RelationOf<L>, AnyRelation | AnyClosed> : never

/** A key of a relation over L: the relation itself, for its primary key, or a Key from key() over it. */
type KeyAt<L> = KeyedAt<L> | Key<KeyedAt<L>, ReadonlyArray<string>>

/** A program over S or a level below it: a query, an ordered query, a ChangeSet or a relation's key. */
type ProgramAt<L> = QueryAt<L> | OrderedAt<L> | ChangeSetAt<L> | KeyAt<L>

export type WorkloadConstructor = <
	S extends AnySchema,
	const Programs extends Record<string, ProgramAt<LevelsOf<S>>>
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
