import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import { type CatalogRule, type Certificate, makeCertificate } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { EvidenceContext, Grounds } from "#compiler/ir/evidence.ts"
import type { OpId } from "#compiler/ir/expr.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Cell, RelKind, Roots, ValidDag } from "#compiler/ir/rel.ts"
import { analyzeLogical, queryEvidence } from "#compiler/logical/annotate.ts"
import {
	CatalogContext,
	type CatalogOptions,
	type ParentPolicy
} from "#compiler/lower/shapes/catalog/context.ts"
import { CatalogEditor } from "#compiler/lower/shapes/catalog/edit.ts"
import { attempt } from "#compiler/lower/shapes/catalog/exprs.ts"
import { tryMode } from "#compiler/lower/shapes/catalog/mode.ts"
import { tryAttachedNeighbor, tryBoundNeighbor } from "#compiler/lower/shapes/catalog/neighbor.ts"
import { tryOrdinal } from "#compiler/lower/shapes/catalog/ordinal.ts"
import { tryPercentile } from "#compiler/lower/shapes/catalog/percentile.ts"
import { tryShare } from "#compiler/lower/shapes/catalog/share.ts"

/** What one recognizer produced. */
interface Applied extends Grounds {
	readonly rules: ReadonlyArray<CatalogRule>
	readonly inputs: ReadonlyArray<NodeId>
	readonly outputs: ReadonlyArray<NodeId>
	readonly equality: ReadonlyArray<OpId>
}

type Recognizer = (cx: CatalogContext, cell: Cell) => Applied

/**
 * The context a rewrite needs: the narrowest its premises hold in (immediate facts hold at every statement, query-local
 * deductions only in this query).
 */
const weakest = (contexts: ReadonlyArray<EvidenceContext>): EvidenceContext => {
	const order: ReadonlyArray<EvidenceContext> = [
		"queryLocal",
		"validatedTx",
		"committedSnapshot",
		"immediate"
	]
	let narrowest: EvidenceContext = "immediate"
	for (const c of contexts) {
		if (order.indexOf(c) < order.indexOf(narrowest)) {
			narrowest = c
		}
	}
	return contexts.length === 0 ? "queryLocal" : narrowest
}

const families: ReadonlyArray<{
	readonly name: string
	readonly kinds: ReadonlyArray<RelKind>
	readonly run: Recognizer
}> = [
	{
		name: "percentile",
		kinds: ["ProjectSet"],
		run: (cx, cell) => {
			const r = tryPercentile(cx, cell)
			return {
				rules: [r.rule],
				inputs: r.inputs,
				outputs: r.outputs,
				premises: r.keys.flatMap((k) => k.premises),
				context: weakest(r.keys.map((k) => k.context)),
				equality: []
			}
		}
	},
	{
		name: "share",
		kinds: ["MatchRegion"],
		run: (cx, cell) => {
			const r = tryShare(cx, cell)
			return {
				rules: ["R28"],
				inputs: r.inputs,
				outputs: r.outputs,
				premises:
					r.premises.length === 0
						? [{ kind: "node", node: cell.id }]
						: r.premises.flatMap((k) => k.premises),
				context: r.premises.length === 0 ? "queryLocal" : weakest(r.premises.map((k) => k.context)),
				equality: []
			}
		}
	},
	{
		name: "bound neighbor",
		kinds: ["MatchRegion"],
		run: (cx, cell) => {
			const r = tryBoundNeighbor(cx, cell)
			return { ...r, premises: r.key.premises, context: r.key.context, equality: r.comparisons }
		}
	},
	{
		name: "attached neighbor",
		kinds: ["Attach"],
		run: (cx, cell) => {
			const r = tryAttachedNeighbor(cx, cell)
			return { ...r, premises: r.key.premises, context: r.key.context, equality: r.comparisons }
		}
	},
	{
		name: "mode",
		kinds: ["Take"],
		run: (cx, cell) => {
			const r = tryMode(cx, cell)
			return {
				rules: ["R31"],
				...r,
				premises: [{ kind: "node", node: cell.id }],
				context: "queryLocal",
				equality: []
			}
		}
	},
	{ name: "ordinal", kinds: ["Group"], run: tryOrdinal }
]

/**
 * An edited DAG annotated again (logical/annotate.ts analyzeLogical) under the evidence the optimized input is annotated
 * with (lower/optimize/pipeline.ts optimizedInput): every node a rewrite built keyed by what the analysis proves of it,
 * as every other node is.
 */
const annotated = <R extends Roots>(dag: ValidDag<R>): ValidDag<R> => {
	const analysis = analyzeLogical(dag, queryEvidence)
	if (!analysis.ok) {
		throw new Refusal(analysis.error)
	}
	return analysis.value.dag
}

/** Which rules an entry applied at a node, or why it was not applied: the inspectable record of the pass. */
type CatalogDecision =
	| { readonly node: NodeId; readonly entry: string; readonly applied: ReadonlyArray<string> }
	| { readonly node: NodeId; readonly entry: string; readonly reason: string }

export interface CatalogResult<R extends Roots = Roots> {
	readonly dag: ValidDag<R>
	readonly certificates: ReadonlyArray<Certificate>
	readonly decisions: ReadonlyArray<CatalogDecision>
}

/**
 * The catalog rewrites over a DAG.
 *
 * The catalog pass: every recognizer at every node, once, consumers before their inputs.
 *
 * The pass walks the DAG from the roots toward the sources, so an outer composition (a percentile over ordinals, a
 * share over counts) is seen whole before an inner entry (the ordinal itself) could rewrite part of it; a node an
 * earlier rewrite made unreachable is skipped. At each node it tries the entries that can root there, in a fixed order,
 * and keeps the first that applies. Each attempt is all or nothing: a recognizer that finds a condition false throws
 * NoMatch, the editor is restored, and the composition keeps its ordinary composed lowering, which is correct by
 * construction (a shape outside the catalog is not rejected). Each node is visited once per entry, so the
 * measure is one traversal.
 *
 * Each rewrite records a certificate: the rule, the matched and the produced nodes, the key evidence the total order
 * rests on, the context it needs, the preserved heading, and the native comparisons the recognized predicate uses.
 * The conservative lowering, which runs no pass, applies none.
 *
 * A DAG no rewrite edited is the valid DAG it was; an edited one is assembled, validated and annotated again, so no node
 * claims a key the logical analysis does not prove of it.
 *
 * The compile-target catalog.
 *
 * The language has no window function, ordered-set aggregate, FILTER clause, LATERAL or DISTINCT ON. Several
 * compositions of its sets, counts, sums, conds and takes have a native PostgreSQL form, and this package recognizes
 * them with their exact preconditions and lowers them there:
 *
 * | Entry | Composition | Target | Module |
 * | --- | --- | --- | --- |
 * | R26 | inclusive self-match counted | ROW_NUMBER() OVER (PARTITION BY group ORDER BY tuple) | ordinal.ts |
 * | R41 | inclusive self-match folded | <agg> OVER (... ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) | ordinal.ts |
 * | R27 | take(1) under the strict successor | LEAD(f, 1, f) and a ROWS 1 FOLLOWING presence count | neighbor.ts |
 * | R42 | take(1) as-of under <= or < | the LATERAL probe, or one ordered pass over a tagged union | neighbor.ts |
 * | R28 | count joined to its total or to its input | SUM(count) OVER () or COUNT(*) OVER (PARTITION BY key) | share.ts |
 * | R29 | selection by ordinal ceil(p · n) | PERCENTILE_DISC(p) WITHIN GROUP | percentile.ts |
 * | R30 | interpolation between two ordinals | PERCENTILE_CONT(p) WITHIN GROUP | percentile.ts |
 * | R31 | count per value, take(1) by count desc, value asc | MODE() WITHIN GROUP | mode.ts |
 *
 * The recognizers rewrite the relational DAG into the internal Window and OrderedSetAggregate nodes,
 * each with a certificate (rewrite.ts); native.ts lowers those nodes to SQL. Where a condition fails the composition
 * is left as it is, and its ordinary composed lowering is the fallback the catalog states, correct by construction:
 * the self-join and grouped count (quadratic in group size), the LATERAL take(1) per parent, the second aggregate
 * stage, the ordinal selection, the grouped count and take, the composed sums. No entry is caller-selectable and no
 * entry is a general interpreter. R24, the conditional aggregates, is the aggregate shapes' (shapes/aggregate); its
 * running form is R41's here. Bounded subsets are the take shapes' (shapes/take).
 */
export const rewriteCatalog = <R extends Roots>(
	dag: ValidDag<R>,
	options: CatalogOptions
): Result.Result<CatalogResult<R>, CompileError> =>
	catchRefusal(() => {
		const ed = new CatalogEditor(dag)
		const cx = new CatalogContext(ed, options)
		const certificates: Array<Certificate> = []
		const decisions: Array<CatalogDecision> = []
		let reachable = ed.reachable()
		for (const at of topoOrder(dag).toReversed()) {
			const cell = ed.cellOf(at)
			for (const family of families) {
				const node = cell.current
				if (!reachable.has(cell) || !family.kinds.includes(node.kind)) {
					continue
				}
				const mark = ed.mark()
				const found = attempt(() => family.run(cx, cell))
				if (found.kind === "noMatch") {
					ed.undo(mark)
					cx.invalidate()
					decisions.push({ node: cell.id, entry: family.name, reason: found.reason })
					continue
				}
				const applied = found.value
				for (const rule of applied.rules) {
					const certificate = makeCertificate({
						rule,
						inputs: applied.inputs,
						outputs: applied.outputs,
						premises: applied.premises,
						context: applied.context,
						preservedHeading: node.heading.map((h) => h.name),
						equality: applied.equality,
						coercion: [],
						params: undefined
					})
					if (!certificate.ok) {
						throw new Refusal(certificate.error)
					}
					certificates.push(certificate.value)
				}
				decisions.push({ node: cell.id, entry: family.name, applied: applied.rules })
				cx.invalidate()
				reachable = ed.reachable()
				break
			}
		}
		return {
			dag: decisions.some((d) => "applied" in d) ? annotated(ed.build()) : dag,
			certificates,
			decisions
		}
	})

/**
 * The catalog as a pass of the optimized pipeline: the rewrites, each certificate recorded in the context's log, for
 * the execution context the template is compiled for and under its evidence catalog.
 */
export const catalogPass = (parents: ParentPolicy): Pass<LogicalQuery, LogicalQuery> => ({
	name: "compileTargetCatalog",
	run: (query, ctx) => {
		const options: CatalogOptions = { catalog: ctx.catalog, parents }
		return Result.map(rewriteCatalog(query.dag, options), (result) => {
			for (const cert of result.certificates) {
				ctx.certificates.record(cert)
			}
			return { ...query, dag: result.dag }
		})
	}
})
