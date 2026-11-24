import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { CheckedEntry } from "#compiler/analysis/schema.ts"
import { admitQuery } from "#compiler/check/index.ts"
import { everyProperty, unwrap } from "#compiler/core/canonical.ts"
import { ownedDigest } from "#compiler/core/fingerprint.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { DagTemplates } from "#compiler/ir/dag-digest.ts"
import { dagDigest, rooted, topoOrder } from "#compiler/ir/dag.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { Delivered, DeltaSide, RelNode } from "#compiler/ir/rel.ts"
import type { ReadBack } from "#compiler/ir/write.ts"
import { type CatalogSchema, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { BoundCarrierOf, DeltaRelation } from "#compiler/lower/conservative/types.ts"
import { lowerOptimized } from "#compiler/lower/optimize/pipeline.ts"
import type { OptimizedDeliveryProgram, RelationChoice } from "#compiler/lower/shapes/index.ts"
import type { NameSupplyStart } from "#compiler/sql/naming.ts"
import { type CarrierColumn, carrierColumns } from "#compiler/write/carriers/carriers.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { type DeltaHeld, deltaTarget } from "#compiler/write/readback/deltas.ts"
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
	/** The templates of the write's compile, which a read-back's digest and lowering read (ReadBackLowering `templates`). */
	readonly templates: DagTemplates
	/** Where its InputSets of the relation parameters its ChangeSet binds to queries read (ReadBackLowering `bound`). */
	readonly bound: BoundCarrierOf
}

/** Where a read-back's Delta nodes read each delta it names, by the relation the Delta names and its side. */
export type DeltasOf = (relation: string, side: DeltaSide) => DeltaRelation | undefined

/** The column of `heading`, a delta CTE's or a carrier's, that holds the relation field `field`. */
const heldColumn = (heading: ReadonlyArray<CarrierColumn>, field: string): string =>
	defined(
		heading.find((c) => c.name === field),
		`the field ${field} in a held delta`
	).column

/** The delta source of `relation` from what `heldOf` holds of the relation the ChangeSet writes: the relation it holds
 * whole, each field in its column, or, for a query entry, its target's, each head field of the entry in the column of
 * the target's field it names, in a CTE of the statement making it or in its carrier; the empty relation for an empty
 * delta. */
export const deltaSourceIn = (
	relation: string,
	entries: ReadonlyMap<string, CheckedEntry>,
	heldOf: (relation: string) => DeltaHeld | undefined
): DeltaRelation | undefined => {
	const entry = entries.get(relation)
	const held = heldOf(deltaTarget(entries, relation))
	if (held === undefined) {
		return undefined
	}
	if (held.kind === "empty") {
		return held
	}
	const heading = held.kind === "cte" ? held.heading : held.carrier.heading
	const columns =
		entry === undefined
			? heading.map((c) => ({ field: c.name, column: c.column }))
			: [...entry.head].map(([head, { field }]) => ({
					field: head,
					column: heldColumn(heading, field.name)
				}))
	switch (held.kind) {
		case "cte":
			return { kind: "cte", cte: held.cte, columns }
		case "carrier":
			return {
				kind: "carrier",
				carrier: held.carrier.name,
				table: carrierColumns(held.carrier),
				columns
			}
	}
}

/** The statements of one read-back: the optimized lowering of its query, its root a node of the WriteIR's DAG, in the transaction
 * context, its Delta nodes reading what `deltas` gives: a CTE of the write statement it rides, over that statement's
 * RETURNING, the carrier that statement filled from it, or the empty relation (write/readback/deltas.ts DeltaHeld). A
 * read-back that rides the statement making its deltas is a part of that statement, evaluated over its snapshot, which
 * the schedule placed after every write of the state it reads (write/schedule/plan.ts placeReadBacks); any other is a
 * statement of its own pipelined after the writes in the same transaction, over its carried deltas. It may attach,
 * order, take and union like any query, so
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
 * raises a breach through the installation's refusal function (`breachGuard`), which aborts the write.
 *
 * A compile lowers each distinct read-back once (`lowered`): two ChangeSets of one role whose read-backs are one query
 * over one delta source at one numbering (a learner's answerTestItem and skipTestItem, nine read-backs alike, the
 * largest of 14,277 nodes) take the program the first lowered, where each lowered it again (qti's write compile at hub
 * 2c1aa525b: 68 s of skipTestItem's SERIALIZABLE compile in one read-back). What a caller reads of a read-back's
 * program is its delivery program alone (placeReadBack, the riding read-backs), never its query, plan or
 * certificates. A kept program's labels are the first lowering's: its generated names' origins, which travel in
 * diagnostics only and no statement prints (sql/naming.ts NameOrigin), and its delivered attachments' Attach nodes',
 * of which a delivery reads the name, the correlation and the judged type alone (served/read.ts servedAttach), so
 * every statement and delivery is the one a fresh lowering makes. */
export const lowerReadBack = (
	read: ReadBack,
	deltas: DeltasOf,
	start: NameSupplyStart,
	options: ReadBackOptions
): OptimizedDeliveryProgram<RelationChoice> => {
	const alike = keptOf(options.reads, options.schema.laws).getOrInsertComputed(
		surroundings(read, deltas, start, options),
		() => []
	)
	const query = new QueryDigest(read.node)
	const found = alike.find((kept) => kept.query.equals(query, options.templates))
	if (found !== undefined) {
		return found.program
	}
	const program = loweredAfresh(read, deltas, start, options)
	alike.push({ query, program })
	return program
}

/**
 * Each read-back's delivery program lowered, by the names it reads under and the law model its evidence comes from,
 * then by the digest of everything else its lowering reads but its query (`surroundings`), beside its query's digest
 * (QueryDigest), which tells apart the read-backs of one surroundings: the read-backs of one role's ChangeSets, which
 * read under the names one pass over the role reads under (program/schema.ts roleArtifacts, one per pass) over its law
 * model, meet here, and the programs go with the names they read under.
 */
const lowered = new WeakMap<PhysicalNames, WeakMap<LawModel, Map<string, Array<Kept>>>>()

/** A read-back's delivery program, kept beside its query's digest (`lowered`). */
interface Kept {
	readonly query: QueryDigest
	readonly program: OptimizedDeliveryProgram<RelationChoice>
}

/** The programs kept for read-backs read under `reads` over `laws` (`lowered`), by their surroundings. */
const keptOf = (reads: PhysicalNames, laws: LawModel): Map<string, Array<Kept>> =>
	lowered.getOrInsertComputed(reads, () => new WeakMap()).getOrInsertComputed(laws, () => new Map())

/**
 * The digest of a read-back query's claimed normal form (ir/dag.ts dagDigest): every field of every node and expression
 * its root reaches but their labels, which the digest numbers by first occurrence, their source locations, which only a
 * refusal names and a refusal is never kept, an Attach's judged type and what a relation's name decides (a Delta's
 * keys, a view's), each of which its surroundings or its names hold. It is taken where the query is first compared with
 * another of its surroundings (`equals`), which holds its root till then, so a read-back no other is lowered beside
 * digests nothing; a query whose digest is refused is no other's.
 */
class QueryDigest {
	#root: RelNode | undefined
	#digest: string | undefined

	constructor(root: RelNode) {
		this.#root = root
	}

	/**
	 * Whether the two queries are one: both digests taken, each from the templates of the compile comparing them, and one.
	 * A kept query holds no compile's templates, which it may be compared in after its own compile is gone.
	 */
	equals(other: QueryDigest, templates: DagTemplates): boolean {
		const digest = this.#taken(templates)
		return digest !== undefined && digest === other.#taken(templates)
	}

	/** The digest, taken on the first read and the root let go: none where it is refused. */
	#taken(templates: DagTemplates): string | undefined {
		const root = this.#root
		if (root !== undefined) {
			this.#root = undefined
			const digest = dagDigest(rooted([root]), "read-back", templates)
			this.#digest = digest.ok ? digest.value : undefined
		}
		return this.#digest
	}
}

/** What a read-back's surroundings carry of a node of its query (`surroundings`): a Delta's source, an Attach's judged
 * type, the carrier a bound relation parameter's InputSet reads, or a kind. */
type Carried =
	| { readonly source: readonly [string, DeltaSide] | readonly [string, DeltaSide, DeltaRelation] }
	| { readonly judged: Delivered }
	| { readonly bound: string }
	| RelNode["kind"]

/** The delta source a Delta node of `relation`'s `side` reads, as a read-back's surroundings carry it: its relation and
 * side, and the source `deltas` gives, none where it gives none, which the node's lowering refuses (lower/conservative
 * delta). */
const deltaSource = (
	relation: string,
	side: DeltaSide,
	deltas: DeltasOf
): readonly [string, DeltaSide] | readonly [string, DeltaSide, DeltaRelation] => {
	const source = deltas(relation, side)
	return source === undefined ? [relation, side] : [relation, side, source]
}

/**
 * What decides a read-back's lowering besides its query's digest (QueryDigest), the names it reads under and its law
 * model (`lowered`), digested: in its nodes' topological order, which is the structure the query's digest numbers
 * (ir/dag.ts topoOrder), each node's kind, the delta source each Delta node reads, its relation and side as `deltas`
 * gives it, and each Attach's judged type, which its delivered attachment carries (runtime/lower/tree.ts AttachedTree)
 * and a delivery reads (served/read.ts servedAttach); its parameters' declarations; where its names start; the schema
 * of the refusal function a breach raises through; and its catalog's views. Its context is the transaction's for every
 * read-back. Two read-backs of one query have one surroundings where the rest is one, and two of other kinds in that
 * order are of two queries, told apart here with no digest of either.
 */
const surroundings = (
	read: ReadBack,
	deltas: DeltasOf,
	start: NameSupplyStart,
	options: ReadBackOptions
): string =>
	ownedDigest(
		"read-back-lowering",
		[
			topoOrder(rooted([read.node])).flatMap((n): ReadonlyArray<Carried> =>
				n.kind === "Delta"
					? [n.kind, { source: deltaSource(n.relation, n.side, deltas) }]
					: n.kind === "Attach"
						? [n.kind, { judged: n.judged }]
						: n.kind === "InputSet" && n.input.kind === "bound"
							? [n.kind, { bound: options.bound(n.input.param)?.carrier ?? "" }]
							: [n.kind]
			),
			options.params,
			start.relationStart,
			start.columnStart,
			options.names.schema,
			options.schema.views
		],
		everyProperty
	)

/** A read-back's delivery program, lowered afresh (lowerReadBack): its statement, parts and delivery, which its readers
 * read, never the rewritten query, the placement plan or the certificates the lowering made beside them. */
const loweredAfresh = (
	read: ReadBack,
	deltas: DeltasOf,
	start: NameSupplyStart,
	options: ReadBackOptions
): OptimizedDeliveryProgram<RelationChoice> => {
	const admitted = unwrap(
		admitQuery(
			{ dag: rooted([read.node]), params: options.params },
			SourceLoc(`read ${read.name}`, [])
		)
	)
	const program = unwrap(
		lowerOptimized(admitted, {
			names: options.reads,
			/** Its conservative artifact is realized with its write, which the write oracle compares. */
			subject: {
				kind: "readBack",
				deltas,
				breach: breachGuard(options.names.schema),
				start,
				templates: options.templates,
				bound: options.bound
			},
			/** A read-back runs in its write's transaction and records no constraint premise. */
			catalog: evidenceCatalog(options.schema),
			context: "transaction"
		})
	)
	return {
		statement: program.statement,
		parts: program.parts,
		roots: program.roots,
		delivery: program.delivery
	}
}
