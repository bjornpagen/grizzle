import type { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { DeltaSide, RelNode, ValidDag } from "#compiler/ir/rel.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"

export type ActionSource =
	| { readonly kind: "enumerated"; readonly slot: ParamId }
	| { readonly kind: "stream"; readonly slot: ParamId }
	| { readonly kind: "described"; readonly node: RelNode }

/** An operation: an insertion, a put or a deletion. */
export type ActionOp =
	| { readonly op: "insert" }
	| { readonly op: "put" }
	| { readonly op: "delete" }

/** What an action does: insert, put or delete its source's facts. */
export type ActionCore = ActionOp & {
	readonly relation: StoredRelationName
	readonly source: ActionSource
}

/**
 * An action of a stratum, with the indices of the earlier actions of its stratum that must complete first (the
 * schedule's edges, write/frontend/schedule.ts), and what its compiler knows of it beside (`Info`): the write front
 * end's information on its relation and source.
 */
export type Action<Info> = ActionCore & {
	readonly dependsOn: ReadonlyArray<number>
	readonly info: Info
}
export type PutAction<Info> = Extract<Action<Info>, { readonly op: "put" }>

export interface Stratum<Info> {
	readonly actions: ReadonlyArray<Action<Info>>
}

/** A delta source a read-back names: delta.added(R), delta.removed(R) or delta.met(R). */
interface DeltaSource {
	readonly relation: string
	readonly side: DeltaSide
}

export interface ReadBack {
	readonly name: string
	/** The read-back's query as its ChangeSet's Description states it, whose attachments' delivered heads the runtime
	 * reads. */
	readonly query: QueryDesc
	readonly node: RelNode
	/**
	 * The delta sources the read-back's query reads: the Delta nodes it reaches in the WriteIR's DAG. A put whose
	 * relation's delta.removed is named here cannot be an ON CONFLICT DO UPDATE or a MERGE.
	 */
	readonly deltas: ReadonlyArray<DeltaSource>
}

/**
 * The write IR.
 *
 * A ChangeSet compiles to strata of physical actions. A stratum comes only from ChangeSet.sequence;
 * within one, every member is evaluated against the state before the stratum's writes, and the actions form a
 * dependency graph: removals freeing unique slots before replacements, exact conflict verification, and
 * the RETURNING channels that form delta.added and delta.removed. Read-backs run after the last stratum, over the
 * post-change state, typed by immediate evidence only.
 *
 * The WriteIR records what each action does, never the statement that realizes it: an insertion's follows from its
 * relation, a deletion's is the exact deletion, and a put's is chosen from what only the whole
 * ChangeSet shows (write/put/choose.ts).
 *
 * The described members and the read-backs are queries in the WriteIR's own DAG, so the delta sources a read-back
 * names are structural: the front end derives them from the DAG (write/frontend/dag.ts deltaSources).
 */
export interface WriteIR<Info> {
	/** The described members', the read-backs' and the carried bound rows' queries. */
	readonly dag: ValidDag
	readonly strata: ReadonlyArray<Stratum<Info>>
	readonly reads: ReadonlyArray<ReadBack>
	readonly params: ReadonlyArray<ParamId>
	/** The relation parameters its ChangeSet binds to queries whose one evaluation is carried (`BoundInput`). */
	readonly bound: ReadonlyArray<BoundInput>
}

/**
 * A relation parameter a ChangeSet binds to a query (ChangeSetDesc `boundRows`), an input of the call: one value,
 * evaluated once in the state before the first stratum of the part it was bound on (BoundRowsDesc `stratum`), which
 * every member and read-back that reads it reads. Where every reader reads that state, members of the first stratum at
 * or after it that writes, or read-backs where none does, the parameter's query is a part of theirs, as any import's is
 * (write/frontend/compile.ts), and no BoundInput names it. Where a reader reads another state, a later stratum's member
 * or a read-back, it is carried: `node`, its query, is evaluated once, right before the statements of `stratum`, into a
 * carrier (write/schedule/plan.ts, step `bound`), after every write of the strata before it, and every reader's
 * InputSet of it (ir/rel.ts InputSetInput `bound`) reads that carrier. The two realize one meaning, the parameter's rows
 * in the state before its part, as a CTE inlined or held does one query.
 */
export interface BoundInput {
	readonly param: ParamId
	/** The stratum before whose statements it is evaluated: the first that writes at or after the part's first. */
	readonly stratum: StratumAt
	readonly node: RelNode
}
