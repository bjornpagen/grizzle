import { immediateDominators, postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { analyzeDemand, noPins } from "#compiler/analysis/demand/demand.ts"
import { outerOf } from "#compiler/analysis/physical/rules.ts"
import { maxStringLength, unwrap } from "#compiler/core/canonical.ts"
import { DagDigests, DagTemplates, type OuterRead } from "#compiler/ir/dag-digest.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import { inputsOf, type RelNode, type ValidDag } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { costClass, type CtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import { feedbackReadsOf, nodeGraph } from "#compiler/lower/optimize/demand/editor.ts"
import { type CopiedSites, type Keys, keySetReads } from "#compiler/lower/shapes/share/keys.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"

/**
 * A sub-query a statement reads at several sites, computed once (keyed.ts KeyedLowering copied).
 *
 * A rule statement's import read at the values a region binds is one node for each region that binds them (check/
 * checker.ts importedKey: an outer value by the node it is read through), so a sub-query each rule of a union reads at its
 * own row's values is a copy in each, correlated to that rule's region, and the lowering spelled it at each, a copy of
 * the same SQL: metis's first budget judge read the sitting time limits, a union of 217 KB, in each of five rules, 73% of
 * its 1.36 MB, planned five times (METISMEASURE, grizzle 9c5218ed4). Two copies are one sub-query exactly when their
 * forms are one with each node outside them named by its place (ir/dag-digest.ts DagDigests positional), each reading
 * the same columns of the rows in the same places: the sub-query at a site's outer values.
 *
 * Such a sub-query is computed once at the innermost scope that encloses all its sites, at the union of the sites' keys,
 * and each site reads that one evaluation at its own key: the statement's, where the nodes every path to a site passes
 * through meet at one that reads no outer row, its key set every site's outer values where they stand (keys.ts
 * KeyAnalysis copyKeys). Where they meet only inside an evaluation per outer row, a unit's, the scope is that
 * evaluation, and the statement leaves each copy where it stands: computed once over every unit's keys, each unit's run
 * would read the rows of every unit's.
 */

/**
 * A sub-query a statement reads at several sites: the copy whose lowering computes it and the columns it reads of outer
 * rows, each at its place (ir/dag-digest.ts positional), the type of each place, and the key set, every site's outer
 * values by place.
 */
export interface CopyClass {
	readonly representative: RelNode
	readonly outer: NonEmptyReadonlyArray<OuterRead>
	readonly types: NonEmptyReadonlyArray<ScalarType>
	readonly keys: Keys
}

/** A site of a sub-query a statement reads at several (CopyClass): its class, and the columns its places read. */
export interface CopySite {
	readonly copied: CopyClass
	readonly outer: NonEmptyReadonlyArray<OuterRead>
}

/** A class of copies, its sites in the statement's order, its places' types, and the key set its sites ask (keys.ts). */
export interface CopyCandidate {
	readonly sites: NonEmptyReadonlyArray<{
		readonly node: RelNode
		readonly outer: NonEmptyReadonlyArray<OuterRead>
	}>
	readonly types: NonEmptyReadonlyArray<ScalarType>
	readonly request: CopiedSites
}

/**
 * Whether a key is compared by equality as itself: no float, whose -0 and +0 equality makes one value, and no vector,
 * whose equality is the extension's.
 */
const exactKey = (t: ScalarType): boolean => {
	const carrier = baseOf(t).carrier
	return carrier !== "float4" && carrier !== "float8" && carrier !== "vector"
}

/**
 * The classes of copies a statement over `dag` reads at more than one site (the module header): the nodes, in `order`,
 * every path to which meets at a node that reads no outer row, each read once, where it stands (no CTE policy decision),
 * correlated, of one column at least, more than a scan of one source, off every recursion's feedback, read laterally by
 * no expression and holding no node a holder outside it holds; grouped by their positional forms and their realizations
 * (`realization`), each a set or rows that may repeat alike, every outer column an exact key. A node of no column is
 * an existence test's right side, which its test reads where it stands, per left row through the index its join
 * columns request (lower/conservative/semi-join/exists.ts readPerLeftRow): its one evaluation would hold its sites'
 * keys alone, each site scanning all of them for its own.
 */
export const copyCandidates = (
	dag: ValidDag,
	order: ReadonlyArray<RelNode>,
	cte: CtePlan,
	realization: (node: RelNode) => string
): ReadonlyArray<CopyCandidate> => {
	const demand = analyzeDemand(dag, noPins)
	const feedback = feedbackReadsOf(nodeGraph, demand.order)
	const labels = nodesByLabel(dag)
	const digests = new DagDigests(() => labels, maxStringLength, new DagTemplates())
	/**
	 * Whether a node under `node` is held in the query of a holder outside it (cte-policy `sharedCorrelated`): its CTE is
	 * entered in that holder's WITH, which a statement's CTE of the copy's evaluation cannot read.
	 */
	const heldOutside = (node: RelNode): boolean => {
		const under = postorder([node], inputsOf)
		const inside = new Set(under.map((n) => n.id))
		return under.some((n) => {
			const scope = cte.decisions[n.id]?.scope
			return scope?.kind === "held" && !inside.has(scope.holder)
		})
	}
	const groups = new Map<
		string,
		Array<{ readonly node: RelNode; readonly outer: NonEmptyReadonlyArray<OuterRead> }>
	>()
	for (const node of order) {
		if (
			outerOf(node).length === 0 ||
			node.heading.length === 0 ||
			cte.decisions[node.id] !== undefined ||
			costClass(node) === "scan" ||
			node.kind === "Recursive" ||
			node.kind === "SelfRef" ||
			feedback.has(node) ||
			demand.lateral(node) ||
			heldOutside(node)
		) {
			continue
		}
		const form = unwrap(digests.positional([node], "copies"))
		const [read, ...reads] = form.outer
		if (read !== undefined) {
			groups
				.getOrInsertComputed(`${form.digest} ${realization(node)}`, () => [])
				.push({ node, outer: [read, ...reads] })
		}
	}
	const readers = new Map<RelNode, Array<RelNode>>()
	for (const node of order) {
		for (const input of inputsOf(node)) {
			readers.getOrInsertComputed(input, () => []).push(node)
		}
	}
	const roots = new Set<RelNode>(dag.roots)
	const dominator = immediateDominators(
		order,
		(node) => readers.get(node) ?? [],
		(node) => roots.has(node)
	)
	/** The nodes every path to `node` passes through, nearest first. */
	const chain = (node: RelNode): ReadonlyArray<RelNode> => {
		const out: Array<RelNode> = []
		for (let at = dominator(node); at !== undefined; at = dominator(at)) {
			out.push(at)
		}
		return out
	}
	/** Whether the sites' paths meet at no node that reads an outer row: the statement's scope, or one as wide. */
	const statementScope = (sites: ReadonlyArray<RelNode>): boolean => {
		const [first, ...rest] = sites.map(chain)
		const others = rest.map((c) => new Set(c))
		const meet = (first ?? []).find((n) => others.every((o) => o.has(n)))
		return meet === undefined || outerOf(meet).length === 0
	}
	return [...groups.values()].flatMap((group): ReadonlyArray<CopyCandidate> => {
		const [first, ...others] = group
		if (first === undefined || !isNonEmpty(others)) {
			return []
		}
		const types = mapNonEmpty(first.outer, (o) =>
			columnType(
				defined(labels.get(o.node), "an outer row's node, of the statement's DAG").heading,
				o.column
			)
		)
		if (!types.every(exactKey) || !statementScope(group.map((s) => s.node))) {
			return []
		}
		return [
			{
				sites: [first, ...others],
				types,
				request: {
					columns: mapNonEmpty(first.outer, (_, i) => `place ${String(i)}`),
					sites: group.map((s) => s.outer)
				}
			}
		]
	})
}

/**
 * Each site of the classes a statement computes once (CopySite), each candidate with its key set (`keys`, keys.ts
 * KeyAnalysis copyKeys), highest first: a class whose key set reads none of its sites, and none of whose sites lies
 * under a site of a class taken before it, which that class's one evaluation reads once.
 */
export const copySites = (
	order: ReadonlyArray<RelNode>,
	candidates: ReadonlyArray<CopyCandidate>,
	keys: ReadonlyArray<Keys | undefined>
): ReadonlyMap<RelNode, CopySite> => {
	const place = new Map(order.map((node, i) => [node, i] as const))
	const placeOf = (c: CopyCandidate): number =>
		c.sites.reduce((most, s) => Math.max(most, place.get(s.node) ?? 0), 0)
	const out = new Map<RelNode, CopySite>()
	const below = new Set<RelNode>()
	for (const [i, c] of [...candidates.entries()].toSorted(
		([, a], [, b]) => placeOf(b) - placeOf(a)
	)) {
		const at = keys[i]
		const sites = new Set(c.sites.map((s) => s.node))
		if (
			at === undefined ||
			c.sites.some((s) => below.has(s.node)) ||
			postorder(keySetReads(at), inputsOf).some((n) => sites.has(n))
		) {
			continue
		}
		const copied: CopyClass = {
			representative: c.sites[0].node,
			outer: c.sites[0].outer,
			types: c.types,
			keys: at
		}
		for (const s of c.sites) {
			out.set(s.node, { copied, outer: s.outer })
			for (const n of postorder(inputsOf(s.node), inputsOf)) {
				below.add(n)
			}
		}
	}
	return out
}
