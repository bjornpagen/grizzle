import type { CheckedEntry } from "#compiler/analysis/schema.ts"
import type { BudgetMeter } from "#compiler/core/budget.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { rooted } from "#compiler/ir/dag.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { ReadBack } from "#compiler/ir/write.ts"
import { type CatalogSchema, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { DeltaSource } from "#compiler/lower/conservative/types.ts"
import { lowerOptimized, type OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { type Carrier, carrierColumns, carrierField } from "#compiler/write/carriers/carriers.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { type DeltaPlan, sideCarrier } from "#compiler/write/readback/deltas.ts"
import { breachGuard } from "#compiler/write/refusal.ts"

interface ReadBackOptions {
	/** The installed names, whose schema holds the refusal function a breach raises through. */
	readonly names: WriteNames
	/** The names the read-back reads its relations under: reality's own, or a role's views. */
	readonly reads: PhysicalNames
	readonly params: ReadonlyArray<ParamDecl>
	/** The schema's law model and views, whose immediate keys and containments are the read-back's evidence. */
	readonly schema: CatalogSchema
	readonly meter: BudgetMeter
	/** The query entries whose deltas the read-backs name, by name (`WriteFrontend.deltaEntries`). */
	readonly entries: ReadonlyMap<string, CheckedEntry>
}

/** The delta relation a Delta node reads: the plan's carrier for that relation and side; for a query entry its target's,
 * each column of the entry's heading read from the target field its head field writes (deltaSourceIn). */
const deltaSourceOf =
	(plan: DeltaPlan, entries: ReadonlyMap<string, CheckedEntry>) =>
	(relation: string, side: "added" | "removed"): DeltaSource | undefined =>
		deltaSourceIn(relation, entries, (target) => {
			const carriers = plan.carriers.get(target)
			return carriers === undefined ? undefined : sideCarrier(carriers, side)
		})

/** The delta source of `relation` from the carrier `carrierOf` names for a relation the ChangeSet writes: the carrier
 * whole, or, for a query entry, the carrier of its target with the entry's head columns, position by position in the
 * entry's heading, which is its head fields in compareText order, as the checker sorts a world relation's Delta heading
 * and `WritableEntry.head` is sorted. */
export const deltaSourceIn = (
	relation: string,
	entries: ReadonlyMap<string, CheckedEntry>,
	carrierOf: (relation: string) => Carrier | undefined
): DeltaSource | undefined => {
	const entry = entries.get(relation)
	const carrier = carrierOf(entry === undefined ? relation : entry.target.name)
	if (carrier === undefined) {
		return undefined
	}
	if (entry === undefined) {
		return { carrier: carrier.name, columns: carrierColumns(carrier) }
	}
	return {
		carrier: carrier.name,
		columns: [...entry.head].map(([, { field }]) => carrierField(carrier, field.name).column)
	}
}

/** The statements of one read-back: the optimized lowering of its query, its root a node of the WriteIR's DAG, in the transaction
 * context, its Delta nodes reading the plan's delta carriers, after the last stratum's statements.
 * A read-back that reads post-change state is a separate statement pipelined after the writes in the same
 * transaction, because sibling CTEs share the pre-statement snapshot; the deltas it needs are carried to it in a
 * transaction-scoped carrier filled from those RETURNING CTEs. It may attach, order, take and union like any query, so
 * its lowering is a program of statements, delivered to the host as a query's are (heading groups merged, attachments
 * stitched on their parent keys).
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
	plan: DeltaPlan,
	options: ReadBackOptions
): OptimizedProgram => {
	const program = lowerOptimized(
		{ dag: rooted([read.node]), params: options.params },
		{
			names: options.reads,
			/** Its conservative artifact is realized with its write, which the write oracle compares. */
			subject: {
				kind: "readBack",
				deltas: deltaSourceOf(plan, options.entries),
				breach: breachGuard(options.names.schema)
			},
			/** A read-back runs in its write's transaction and records no constraint premise. */
			catalog: evidenceCatalog(options.schema),
			context: "transaction",
			meter: options.meter
		}
	)
	if (!program.ok) {
		throw new Refusal(program.error)
	}
	return program.value
}
