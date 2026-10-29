import type { ParamId } from "#compiler/core/ids.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { RelNode, ValidDag } from "#compiler/ir/rel.ts"

export type ActionSource =
	| { readonly kind: "enumerated"; readonly slot: ParamId }
	| { readonly kind: "stream"; readonly slot: ParamId }
	| { readonly kind: "described"; readonly node: RelNode }

/**
 * The serial class of an insertion's facts: generated, an addition that omits the relation's serial fields, which the
 * relation's sequences draw; complete, facts that carry every field. A put and a deletion name complete facts. Complete
 * facts of a relation with serial fields carry explicit serial values (write/serial/advance.ts carriesSerial).
 */
export type SerialClass = "generated" | "complete"

/** An operation, an insertion with the serial class of its facts. */
export type ActionOp =
	| { readonly op: "insert"; readonly serial: SerialClass }
	| { readonly op: "put" }
	| { readonly op: "delete" }

/**
 * Whether an operation adds complete facts: a put, or an insertion of complete facts. A deletion of the relation reads
 * D EXCEPT A over these additions of its stratum.
 */
export const completeAddition = (a: ActionOp): boolean =>
	a.op === "put" || (a.op === "insert" && a.serial === "complete")

/** What an action does: insert, put or delete its source's facts. */
export type ActionCore = ActionOp & { readonly relation: string; readonly source: ActionSource }

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

/** A delta source a read-back names: delta.added(R) or delta.removed(R). */
interface DeltaSource {
	readonly relation: string
	readonly side: "added" | "removed"
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
 * relation and serial class, a deletion's is the exact deletion, and a put's is chosen from what only the whole
 * ChangeSet shows (write/put/choose.ts).
 *
 * The described members and the read-backs are queries in the WriteIR's own DAG, so the delta sources a read-back
 * names are structural: the front end derives them from the DAG (write/frontend/dag.ts deltaSources).
 */
export interface WriteIR<Info> {
	/** The described members' and the read-backs' queries. */
	readonly dag: ValidDag
	readonly strata: ReadonlyArray<Stratum<Info>>
	readonly reads: ReadonlyArray<ReadBack>
	readonly params: ReadonlyArray<ParamId>
}
