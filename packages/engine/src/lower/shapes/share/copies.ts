import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { analyzeDemand, noPins } from "#compiler/analysis/demand/demand.ts"
import { outerOf } from "#compiler/analysis/physical/rules.ts"
import { maxStringLength, unwrap } from "#compiler/core/canonical.ts"
import { DagDigests, DagTemplates, type OuterRead } from "#compiler/ir/dag-digest.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import { edgesOf, inputsOf, type RelNode, type ValidDag } from "#compiler/ir/rel.ts"
import { equalityIsIdentity } from "#compiler/ir/scalar.ts"
import {
	costClass,
	type CtePlan,
	restrictedByValues
} from "#compiler/lower/optimize/cte-policy/index.ts"
import { feedbackReadsOf, nodeGraph } from "#compiler/lower/optimize/demand/editor.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"

/**
 * A sub-query a statement reads at several sites, computed once for each row that drives it (keyed.ts KeyedLowering
 * carried).
 *
 * A rule statement's import read at the values a region binds is one node for each region that binds them (check/
 * checker.ts importedKey: an outer value by the node it is read through), so a sub-query each rule of a union reads at its
 * own row's values is a copy in each, correlated to that rule's region, and the lowering spelled it at each, a copy of
 * the same SQL: metis's first budget judge read the sitting time limits, a union of 217 KB, in each of five rules, 73% of
 * its 1.36 MB, planned five times (METISMEASURE, grizzle 9c5218ed4). Two copies are one sub-query exactly when their
 * forms are one with each node outside them named by its place (ir/dag-digest.ts DagDigests positional), each reading
 * the same columns of the rows in the same places: the sub-query at a site's outer values.
 *
 * Each site reads those values off one row of a node the statement reads where it stands and holds whole, its driver:
 * a node it computes once or one its own values restrict (a delta, the call's input), through steps, filters and
 * projections. Copies are one class exactly when their forms are one and their drivers' are too, alpha-equivalent alike,
 * each place read off the same column of its driver: then every driver of the class delivers the same rows, and the
 * class is computed once for each of them, beside it, `E = SELECT d.*, a.* FROM <driver> AS d, LATERAL (SELECT
 * array_agg(c.<column>), ... FROM (<the copy at d's values>) AS c) AS a`, each driver of the class read as E and each
 * site reading its own driver row's arrays, `unnest(d.<array>)`, no lookup and no scan: O(k log n) for E's k driver rows
 * and O(1) for each site beside the copy's own rows, where reading E at each site's values, a CTE no index reads, read
 * all of it once for each driver row, O(k * |E|). A LATERAL aggregate is never pulled up, so PostgreSQL computes the
 * copy at each driver row's values, each read a B-tree probe, whatever it estimates; no join of E to the sites stands
 * for an estimate to choose the method of. Copies whose drivers differ in form stay where they stand, each read at its
 * own row's values, k probes for each site.
 */

/**
 * A class of copies (the module header): its index among its driving set's classes, the set its carried columns are
 * named by (context.ts carriedName), the copy whose lowering computes it, and each column it reads of outer rows at its
 * place (ir/dag-digest.ts positional) with the column of its driver that place reads.
 */
export interface CopyClass {
	readonly index: number
	readonly representative: RelNode
	readonly outer: NonEmptyReadonlyArray<{ readonly read: OuterRead; readonly driver: string }>
}

/**
 * The rows that drive classes of copies, one form for every driver of theirs: the driver whose rows the classes are
 * computed beside, and those classes, in the statement's order.
 */
export interface DrivingSet {
	readonly driver: RelNode
	readonly classes: NonEmptyReadonlyArray<CopyClass>
}

/** A site of a class of copies: its driving set and class, and its own driver, whose row's arrays it reads. */
export interface CopySite {
	readonly driving: DrivingSet
	readonly copied: CopyClass
	readonly driver: RelNode
}

/** The copies a statement computes once beside their drivers: each site, and each driver's driving set. */
export interface CopyPlan {
	readonly sites: ReadonlyMap<RelNode, CopySite>
	readonly drivers: ReadonlyMap<RelNode, DrivingSet>
}

/** No copy computed beside a driver. */
export const noCopies: CopyPlan = { sites: new Map(), drivers: new Map() }

/**
 * Whether a key is compared by equality as itself: its type's equality is identity (ir/scalar.ts equalityIsIdentity),
 * no float, whose -0 and +0 equality makes one value. A site's region may bind its outer column from another source
 * than its driver, equal to the driver's by the region's equality, so the copy at the driver's value is the copy at the
 * site's alone where equal values are one.
 */
const exactKey = equalityIsIdentity

/** A site of a candidate class of copies: the copy, its driver, and each place's outer column and driver column. */
interface CopyCandidate {
	readonly node: RelNode
	readonly driver: RelNode
	readonly outer: NonEmptyReadonlyArray<{ readonly read: OuterRead; readonly driver: string }>
}

/**
 * Each node's shape, numbered by first occurrence: its kind, its heading's column names and its data edges' shapes in
 * structural order (rel.ts edgesOf), each node's read once for the whole statement. A node's form (ir/dag-digest.ts
 * positional) holds its kind and its heading and names each data edge by its place, and two forms are one only where
 * every node of one reach is a node of the other's of one form, so two copies whose forms are one have one shape. A
 * candidate whose shape no other candidate holds is a class of one, which no plan takes, so its form, whose cost is its
 * whole reach, is never written: only candidates that share a shape write theirs, and the shapes cost one read of each
 * node, so a statement whose correlated sub-queries nest, no two alike, writes no form at all.
 */
class Shapes {
	readonly #numbers = new Map<string, number>()
	readonly #of = new Map<RelNode, number>()

	/** The shape of `root`, each node under it numbered on its first read, children before the node that reads them. */
	of(root: RelNode): number {
		const pending: Array<RelNode> = [root]
		for (let at = pending.at(-1); at !== undefined; at = pending.at(-1)) {
			if (this.#of.has(at)) {
				pending.pop()
				continue
			}
			const edges = edgesOf(at)
			const unread = edges.filter((e) => !this.#of.has(e))
			if (unread.length > 0) {
				appendAll(pending, unread)
				continue
			}
			pending.pop()
			const key = [
				at.kind,
				...at.heading.map((c) => c.name),
				...edges.map((e) => this.#of.get(e))
			].join("\u0000")
			this.#of.set(
				at,
				this.#numbers.getOrInsertComputed(key, () => this.#numbers.size)
			)
		}
		return defined(this.#of.get(root), "a shape is numbered once its edges' are")
	}
}

/** Where a site reads one outer column: its driver, the driver's column, and the driver row it reads it off. */
interface Driven {
	readonly node: RelNode
	readonly column: string
	readonly row: object
}

/**
 * The driver an outer row's column `column` of node `id` is read off where the row stands in scope, its rows entering
 * the scope by its column map (conservative/context.ts LowerContext sourceAs): an enclosing region's variable, by the
 * occurrence that binds it, of a source the region reads where it stands and matches once, or by the outer column its
 * correlation reads in turn; or the node itself, where it reads no outer row.
 */
const drivenBy = (
	labels: ReadonlyMap<string, RelNode>,
	id: string,
	column: string
): Driven | undefined => {
	const node = labels.get(id)
	if (node === undefined) {
		return undefined
	}
	if (node.kind !== "MatchRegion") {
		return outerOf(node).length === 0 ? { node, column, row: node } : undefined
	}
	const v = node.vars.find((x) => x.name === column)
	if (v === undefined) {
		return undefined
	}
	for (const q of node.occurrences) {
		const b = q.bindings.find((x) => x.var === v)
		if (
			b !== undefined &&
			outerOf(q.source).length === 0 &&
			node.occurrences.every((o) => o === q || o.source !== q.source)
		) {
			return { node: q.source, column: b.column, row: q }
		}
	}
	const c = node.correlated.find((x) => x.var === v)
	return c?.expr.kind === "column"
		? drivenBy(labels, c.expr.column.node, c.expr.column.name)
		: undefined
}

/**
 * The copies a statement over `dag` computes beside their drivers (the module header): each node, in `order`, read once
 * where it stands (no CTE policy decision), correlated, of one column at least, more than a scan of one source, off
 * every recursion's feedback, read laterally by no expression and holding no node a holder outside it holds, whose
 * every outer column is an exact key read off one row of one driver, a node `once` holds or the statement's values
 * restrict, through steps, filters and projections; grouped by their positional forms, their realizations
 * (`realization`), their drivers' forms and realizations and the driver's column each place reads, each class of two
 * sites at least; classes highest first, none with a site under a site of a class taken before it, which that class's
 * one evaluation reads once. A node of no column is an existence test's right side, which its test reads where it
 * stands, per left row through the index its join columns request (lower/optimize/cte-policy rightPerLeftRow), and
 * carries nothing.
 */
export const copyPlan = (
	dag: ValidDag,
	order: ReadonlyArray<RelNode>,
	cte: CtePlan,
	once: ReadonlySet<RelNode>,
	realization: (node: RelNode) => string
): CopyPlan => {
	const demand = analyzeDemand(dag, noPins)
	const feedback = feedbackReadsOf(nodeGraph, demand.order)
	const labels = nodesByLabel(dag)
	const digests = new DagDigests(() => labels, maxStringLength, new DagTemplates("derivation"))
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
	/**
	 * Whether the statement holds a driver's rows whole wherever it reads them: a node it computes once, or one its own
	 * values restrict (cte-policy restrictedByValues: a delta, the call's input), through steps, filters and projections;
	 * never a stored relation's scan, which read beside each of its rows for the copy would read every unit's rows
	 * (test/pg/laws/rule-aggregate: a probe of the touched groups read 1,605 rows beside 800 untouched groups where it
	 * read 405).
	 */
	const heldWhole = (node: RelNode): boolean =>
		once.has(node) ||
		restrictedByValues(node) ||
		((node.kind === "Step" || node.kind === "Filter" || node.kind === "ProjectSet") &&
			heldWhole(node.input))
	/** Each class's sites, by its key: the copy's form and realization, its driver's, and each place's driver column. */
	const groups = new Map<
		string,
		{ readonly driving: string; readonly sites: Array<CopyCandidate> }
	>()
	const candidates = order.filter(
		(node) =>
			outerOf(node).length > 0 &&
			node.heading.length > 0 &&
			cte.decisions[node.id] === undefined &&
			costClass(node) !== "scan" &&
			node.kind !== "Recursive" &&
			node.kind !== "SelfRef" &&
			!feedback.has(node) &&
			!demand.lateral(node)
	)
	const shapes = new Shapes()
	const shared = new Set(
		[...Map.groupBy(candidates, (node) => shapes.of(node)).values()].flatMap((nodes) =>
			nodes.length > 1 ? nodes : []
		)
	)
	for (const node of candidates) {
		if (!shared.has(node) || heldOutside(node)) {
			continue
		}
		const form = unwrap(digests.positional([node], "copies"))
		const [read, ...reads] = form.outer
		if (read === undefined) {
			continue
		}
		const outer = mapNonEmpty([read, ...reads], (o) => ({
			read: o,
			driven: drivenBy(labels, o.node, o.column),
			type: columnType(
				defined(labels.get(o.node), "an outer row's node, of the statement's DAG").heading,
				o.column
			)
		}))
		const first = outer[0].driven
		if (
			first === undefined ||
			!heldWhole(first.node) ||
			!outer.every((o) => o.driven?.row === first.row && exactKey(o.type))
		) {
			continue
		}
		const driver = first.node
		const places = mapNonEmpty(outer, (o) => ({
			read: o.read,
			driver: defined(o.driven, "a place read off the site's one driver row").column
		}))
		const driving = [
			unwrap(digests.positional([driver], "copy drivers")).digest,
			realization(driver),
			driver.heading.map((c) => c.name).join(",")
		].join(" ")
		groups
			.getOrInsertComputed(
				[form.digest, realization(node), driving, places.map((p) => p.driver).join(",")].join(" "),
				() => ({ driving, sites: [] })
			)
			.sites.push({ node, driver, outer: places })
	}
	const place = new Map(order.map((node, i) => [node, i] as const))
	const placeOf = (sites: ReadonlyArray<{ readonly node: RelNode }>): number =>
		sites.reduce((most, s) => Math.max(most, place.get(s.node) ?? 0), 0)
	const taken: Array<{ readonly driving: string; readonly sites: ReadonlyArray<CopyCandidate> }> =
		[]
	const below = new Set<RelNode>()
	for (const group of [...groups.values()].toSorted(
		(a, b) => placeOf(b.sites) - placeOf(a.sites)
	)) {
		if (group.sites.length < 2 || group.sites.some((s) => below.has(s.node))) {
			continue
		}
		taken.push(group)
		for (const s of group.sites) {
			for (const n of postorder(inputsOf(s.node), inputsOf)) {
				below.add(n)
			}
		}
	}
	const sites = new Map<RelNode, CopySite>()
	const drivers = new Map<RelNode, DrivingSet>()
	const byDriving = new Map<string, Array<(typeof taken)[number]>>()
	for (const group of taken.toSorted((a, b) => placeOf(a.sites) - placeOf(b.sites))) {
		byDriving.getOrInsertComputed(group.driving, () => []).push(group)
	}
	for (const classes of byDriving.values()) {
		const [head, ...rest] = classes
		if (head === undefined) {
			continue
		}
		const made = mapNonEmpty([head, ...rest], (group, index) => {
			const representative = defined(group.sites[0], "a class's first site")
			return {
				group,
				copied: { index, representative: representative.node, outer: representative.outer }
			}
		})
		const driving: DrivingSet = {
			driver: defined(head.sites[0], "a class's first site").driver,
			classes: mapNonEmpty(made, (m) => m.copied)
		}
		for (const { group, copied } of made) {
			for (const s of group.sites) {
				sites.set(s.node, { driving, copied, driver: s.driver })
				drivers.set(s.driver, driving)
			}
		}
	}
	return { sites, drivers }
}
