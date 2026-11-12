import type { CheckedEntry } from "#compiler/analysis/schema.ts"
import { admitQuery } from "#compiler/check/index.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { rooted } from "#compiler/ir/dag.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { DeltaSide } from "#compiler/ir/rel.ts"
import type { ReadBack } from "#compiler/ir/write.ts"
import { type CatalogSchema, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { DeltaRelation } from "#compiler/lower/conservative/types.ts"
import { lowerOptimized, type OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import type { NameSupplyStart } from "#compiler/sql/naming.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import type { DeltaHeld } from "#compiler/write/readback/deltas.ts"
import { breachGuard } from "#compiler/write/refusal.ts"

interface ReadBackOptions {
	/** The installed names, whose schema holds the refusal function a breach raises through. */
	readonly names: WriteNames
	/** The names the read-back reads its relations under: reality's own, or a role's views. */
	readonly reads: PhysicalNames
	readonly params: ReadonlyArray<ParamDecl>
	/** The schema's law model and views, whose immediate keys and containments are the read-back's evidence. */
	readonly schema: CatalogSchema
	/** The query entries whose deltas the read-backs name, by name (`WriteFrontend.deltaEntries`). */
	readonly entries: ReadonlyMap<string, CheckedEntry>
}

/** Where a read-back's Delta nodes read each delta it names, by the relation the Delta names and its side. */
export type DeltasOf = (relation: string, side: DeltaSide) => DeltaRelation | undefined

/** The column of the delta CTE `held` that holds the relation field `field`. */
const heldColumn = (held: Extract<DeltaHeld, { readonly kind: "cte" }>, field: string): string =>
	defined(
		held.heading.find((c) => c.name === field),
		`the field ${field} in the delta CTE ${held.cte}`
	).column

/** The delta source of `relation` from what `heldOf` holds of the relation the ChangeSet writes: the relation it holds
 * whole, or, for a query entry, its target's with the entry's head columns, position by position in the entry's
 * heading, which is its head fields in compareText order, as the checker sorts a world relation's Delta heading and
 * `WritableEntry.head` is sorted; the empty relation for an empty delta. */
export const deltaSourceIn = (
	relation: string,
	entries: ReadonlyMap<string, CheckedEntry>,
	heldOf: (relation: string) => DeltaHeld | undefined
): DeltaRelation | undefined => {
	const entry = entries.get(relation)
	const held = heldOf(entry === undefined ? relation : entry.target.name)
	if (held === undefined) {
		return undefined
	}
	if (held.kind === "empty") {
		return held
	}
	const columns =
		entry === undefined
			? held.heading.map((c) => c.column)
			: [...entry.head].map(([, { field }]) => heldColumn(held, field.name))
	return { kind: "cte", cte: held.cte, columns }
}

/** The statements of one read-back: the optimized lowering of its query, its root a node of the WriteIR's DAG, in the transaction
 * context, its Delta nodes reading what `deltas` gives: a CTE of the write statement it rides, over that statement's
 * RETURNING, or the empty relation (write/readback/deltas.ts DeltaHeld). A read-back over a delta some statement
 * writes is a part of that statement, evaluated over its snapshot, which the schedule placed after every write of the
 * state it reads (write/schedule/plan.ts placeReadBacks); one that reads no written delta is a statement of its own
 * pipelined after the writes in the same transaction. It may attach, order, take and union like any query, so
 * its lowering is a program of statements, delivered to the host as a query's are (heading groups merged, attachments
 * stitched on their parent keys).
 *
 * Its root, a node of the write's DAG, is restated as a query of its own and admitted (check/index.ts admitQuery), the one
 * value the optimized lowering takes.
 *
 * The query is lowered by the optimized pipeline, because in every other respect a read-back is an ordinary query: it
 * fuses, deduplicates and orders as any query does. Its rewrites, duplicate-elimination placement and shapes rest on
 * the evidence of the transaction context a read-back runs in, immediate-constraint evidence only, against the
 * schema's law model. A Delta node is keyed by its relation's keys (`deltaProps`): delta.added(R) lies in R after the
 * change and delta.removed(R) in R before it, and R's immediate keys hold in both. So a read-back that joins a delta to
 * a relation on its key projects no DISTINCT, and PostgreSQL reads the relation through that key for the delta's rows
 * instead of deduplicating the whole relation. The conservative artifact keeps the conservative lowering of the same
 * read-back, over its state-comparison carriers, which is the write oracle's baseline. A statement whose take over a
 * declared relation parameter's rows is a per-execution choice carries its whole-relation variant as its large form
 * (`StatementForms`), which an execution runs when the parameter holds more distinct facts than the choice's
 * threshold, as a query's reader does.
 *
 * Its results are held until COMMIT succeeds, which the runtime does. Its rows are decoded only after that COMMIT, in
 * the write's one flight, so each statement delivering an attachment bare or as an option checks that type itself and
 * raises a breach through the installation's refusal function (`breachGuard`), which aborts the write. */
export const lowerReadBack = (
	read: ReadBack,
	deltas: DeltasOf,
	start: NameSupplyStart,
	options: ReadBackOptions
): OptimizedProgram => {
	const admitted = admitQuery(
		{ dag: rooted([read.node]), params: options.params },
		SourceLoc(`read ${read.name}`, [])
	)
	if (!admitted.ok) {
		throw new Refusal(admitted.error)
	}
	const program = lowerOptimized(admitted.value, {
		names: options.reads,
		/** Its conservative artifact is realized with its write, which the write oracle compares. */
		subject: {
			kind: "readBack",
			deltas,
			breach: breachGuard(options.names.schema),
			start
		},
		/** A read-back runs in its write's transaction and records no constraint premise. */
		catalog: evidenceCatalog(options.schema),
		context: "transaction"
	})
	if (!program.ok) {
		throw new Refusal(program.error)
	}
	return program.value
}
