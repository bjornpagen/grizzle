import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { type ClosedVocabulary, required, type Situations } from "@bjornpagen/testing/features"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { Array as Arr, Effect, Formatter } from "effect"
import type { NodeId } from "#compiler/core/ids.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { nodesByLabel, rooted, topoOrder } from "#compiler/ir/dag.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { exprsOf, type NodeOf, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import { succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type GenConfig,
	type QueryCase,
	queryCaseSketchGen,
	resolveQueryCase,
	rewriteGenConfig
} from "#test/support/oracle/gen/case.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import {
	agrees,
	caseQuery,
	lowerConservatively,
	passContext,
	type Ran,
	type RewriteAgreement,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/**
 * The guard searches: a rewrite pass over generated queries that hold the shapes its guards are about, held to the
 * delivery the reference evaluator computes for the query it was given.
 *
 * A pass's guards keep a rewrite from a node whose rows depend on more than the node: a source an expression correlates
 * with an outer tuple, a source another occurrence reads laterally, a take whose rows are selected per outer tuple or
 * ranked before a filter above it, an aggregate's result. The population is the rewrite passes' own (gen/case.ts
 * rewriteGenConfig), one level deeper, with more takes, filters and groups and more imported queries among a region's
 * sources, so a filter meets a take below it and a region a group, and with the analysis soundness population's
 * per-evaluation shapes besides (query.ts soundnessFeatures), each behind its swarm: constants and correlated variables
 * that read an earlier occurrence's source, correlated takes, and a semi- or anti-join's right side shared with another
 * reader. A rewrite a guard should have refused moves a predicate or a
 * source onto rows of another evaluation, which the reference delivers differently, or leaves a reference out of scope,
 * which the DAG's strict re-reader refuses; every case's rewritten query must also lower conservatively.
 */

/**
 * The rewrite population, deeper, with more takes, filters and groups, more imported queries among a region's sources,
 * and the per-evaluation shapes besides.
 */
const guardPopulation: GenConfig = {
	...rewriteGenConfig,
	query: {
		...rewriteGenConfig.query,
		soundness: true,
		maxDepth: rewriteGenConfig.query.maxDepth + 1,
		imported: 8,
		weights: { ...rewriteGenConfig.query.weights, take: 10, filter: 10, group: 8 }
	}
}

/** The labels of the nodes outside `node`'s subtree that its expressions read: the outer tuples it depends on. */
const freeReads = (node: RelNode): ReadonlySet<NodeId> => {
	const reach = topoOrder({ roots: [node] })
	const inside = new Set(Arr.map(reach, (n) => n.id))
	const free = new Set<NodeId>()
	for (const expr of exprClosure(Arr.flatMap(reach, (n) => exprsOf(n)))) {
		if (expr.kind === "column" && !inside.has(expr.column.node)) {
			free.add(expr.column.node)
		}
	}
	return free
}

/** The sources of a region an expression correlates with an outer tuple. */
const correlatedSources = (region: NodeOf<"MatchRegion">): ReadonlySet<NodeId> =>
	new Set(
		Arr.flatMap(region.occurrences, (o) => (freeReads(o.source).size > 0 ? [o.source.id] : []))
	)

/** The sources of a region another of its occurrences reads laterally, through a constant or through its own source. */
const lateralSources = (region: NodeOf<"MatchRegion">): ReadonlySet<NodeId> => {
	const read = new Set<NodeId>()
	for (const reader of region.occurrences) {
		const reads = new Set([
			...freeReads(reader.source),
			...Arr.flatMap(exprClosure(Arr.map(reader.constants, (k) => k.expr)), (e) =>
				e.kind === "column" ? [e.column.node] : []
			)
		])
		for (const o of region.occurrences) {
			if (o !== reader && reads.has(o.source.id)) {
				read.add(o.source.id)
			}
		}
	}
	return read
}

/** The sources no rewrite may take out of their region: the correlated ones and those read laterally. */
const scopedSources = (region: NodeOf<"MatchRegion">): ReadonlySet<NodeId> =>
	new Set([...correlatedSources(region), ...lateralSources(region)])

/**
 * Throws unless every scoped source of every region of `input` still feeds an occurrence of that region in `output`,
 * itself or under a node a rewrite inserted above it; how many it judged.
 */
export const scopedStay = (input: RelDag, output: RelDag): number => {
	const after = nodesByLabel(output)
	let judged = 0
	for (const region of topoOrder(input)) {
		if (region.kind !== "MatchRegion") {
			continue
		}
		const kept = after.get(region.id)
		for (const source of scopedSources(region)) {
			const feeds =
				kept?.kind === "MatchRegion" &&
				Arr.some(kept.occurrences, (o) =>
					Arr.some(topoOrder({ roots: [o.source] }), (n) => n.id === source)
				)
			if (!feeds) {
				throw new Error(`the source ${source} left the region ${region.id}`)
			}
			judged++
		}
	}
	return judged
}

/** The shapes of a query a guard is about, as the generated input holds them. */
type GuardShape =
	| "an occurrence over a correlated source"
	| "an occurrence whose source another occurrence reads laterally"
	| "a correlated take"
	| "a region over a group"
	| "a filter over a take"
	| "a filter over a group"

/** The node a stage holds below its filters and renames: what a fusion of the stage would inline. */
const stageBelow = (node: RelNode): RelNode =>
	node.kind === "Filter" || node.kind === "ProjectSet" ? stageBelow(node.input) : node

const regionShapes = (region: NodeOf<"MatchRegion">): ReadonlyArray<GuardShape> => {
	const shapes: Array<GuardShape> = []
	if (correlatedSources(region).size > 0) {
		shapes.push("an occurrence over a correlated source")
	}
	if (lateralSources(region).size > 0) {
		shapes.push("an occurrence whose source another occurrence reads laterally")
	}
	if (Arr.some(region.occurrences, (o) => stageBelow(o.source).kind === "Group")) {
		shapes.push("a region over a group")
	}
	return shapes
}

/** The guard shapes a node is: a region's, a correlated take, a filter over a take or over a group. */
const nodeShapes = (node: RelNode): ReadonlyArray<GuardShape> => {
	if (node.kind === "MatchRegion") {
		return regionShapes(node)
	}
	if (node.kind === "Take" && node.correlation.length > 0) {
		return ["a correlated take"]
	}
	if (node.kind === "Filter" && node.input.kind === "Take") {
		return ["a filter over a take"]
	}
	if (node.kind === "Filter" && node.input.kind === "Group") {
		return ["a filter over a group"]
	}
	return []
}

/** Every guard shape the DAG holds. */
const guardShapesOf = (dag: RelDag): ReadonlyArray<GuardShape> =>
	Arr.dedupe(Arr.flatMap(topoOrder(dag), nodeShapes))

/** What a guard search's case reaches: the shapes its input holds, the rules its passes fired, the reference's verdict. */
export type GuardFeature = GuardShape | CertificateRule | `reference ${RewriteAgreement}`

/**
 * Whether `after`, a node of the rewritten query, delivers the rows `before` delivers in the case's query, by the
 * reference; "unsupported" where the reference evaluates neither alone, as a node correlated with an outer tuple.
 */
export const rowsAgreeAt = (q: QueryCase, before: RelNode, after: RelNode): RewriteAgreement =>
	agrees(
		{ ...q, query: { ...q.query, dag: rooted([before]) } },
		{ dag: rooted([after]), params: [] }
	)

type Passes = ReadonlyArray<Pass<LogicalQuery, LogicalQuery>>

/**
 * Explores the guard population through `passes` in `evidence`'s context: each case's rewritten query delivers what
 * its input delivers by the reference, wherever the reference evaluates both, and lowers conservatively; `holds` states
 * the pass's own guard over the case, its input and what the passes made of it, and notes what it judged. The search
 * must reach `situations`, steered toward them by the notes for up to three times `runs` cases, on `runs` rotating
 * cases.
 */
export const guardSearch = <F extends string>(spec: {
	readonly suite: string
	readonly passes: Passes
	readonly evidence: TemplateContext
	readonly runs: number
	readonly situations: Situations<ClosedVocabulary<GuardFeature | F>>
	readonly holds: (q: QueryCase, input: LogicalQuery, ran: Ran, c: Case<GuardFeature | F>) => void
}) =>
	explore(
		{
			oracle: {
				kind: "second-implementation",
				name: "the reference evaluator's delivery of the query before the passes, and the pass's own guard"
			},
			suite: spec.suite,
			draw: drawn(queryCaseSketchGen(guardPopulation)),
			literal: Formatter.format,
			coverage: required<GuardFeature | F>(spec.situations, {
				cases: 3 * spec.runs,
				sense: notesOnly
			}),
			kept: [],
			runs: spec.runs,
			shrink: completeShrink,
			concurrency: 1,
			steerEvery: 16,
			caseHang
		},
		(sketch, c) =>
			Effect.sync(() => {
				const q = c.draw(resolveQueryCase(sketch, guardPopulation))
				const input = caseQuery(q)
				c.noteAll(guardShapesOf(input.dag))
				const ran = succeeded(
					runPasses(
						input,
						spec.passes,
						passContext({ catalog: genCatalog(q.schema), evidence: spec.evidence })
					)
				)
				for (const certificate of ran.certificates) {
					c.note(certificate.rule)
				}
				c.note(`reference ${agrees(q, ran.query)}`)
				succeeded(lowerConservatively(ran.query, schemaCodes(q.schema)))
				spec.holds(q, input, ran, c)
			})
	)
