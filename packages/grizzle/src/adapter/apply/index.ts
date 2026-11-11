import type { CompiledChange } from "#adapter/apply/compile.ts"
import type { BoundReads } from "#adapter/apply/run.ts"
import type { RowDecoder } from "#compiler/plan/common.ts"

/**
 * A ChangeSet compiled once for a role and the contexts `claims` holds a fact of, ahead of the applies that run it: its
 * program and its read-backs' decoder bound. db.compile compiles one for its Db's claims, and the layer one for each
 * set of a workload ChangeSet's fill contexts.
 */
export interface ChangeForm<R> {
	readonly entry: CompiledChange
	readonly bound: BoundReads<R>
	/** The ChangeSet's reads decoder, which its served form carries as data. */
	readonly decoder: RowDecoder<R>
}
