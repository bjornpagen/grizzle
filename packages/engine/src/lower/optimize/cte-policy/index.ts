import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { analyzeDemand, noPins } from "#compiler/analysis/demand/demand.ts"
import { outerOf } from "#compiler/analysis/physical/rules.ts"
import { catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import {
	type CertificateRule,
	localCertificate,
	makeCertificate
} from "#compiler/ir/certificate.ts"
import { freeVars, nodeScopes, nodesByLabel, type OuterRefs } from "#compiler/ir/dag.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	deliveredInput,
	inputsOf,
	keptRowsOf,
	type NodeOf,
	type Occurrence,
	type RelKind,
	type RelNode,
	unionArms,
	type ValidDag,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { feedbackReadsOf, nodeGraph } from "#compiler/lower/optimize/demand/editor.ts"

export type CteStrategy = "inline" | "notMaterialized" | "materialized" | "recursive"

type CostClass = "scan" | "join" | "expensive"

type CteReason =
	| "singleUse"
	| "recursive"
	| "correlated"
	| "sharedCorrelated"
	| "feedback"
	| "cheapScan"
	| "sharedExpensive"
	| "sharedJoin"
	| "readPerRow"

export interface CteDecision {
	readonly node: NodeId
	readonly strategy: CteStrategy
	readonly references: number
	readonly cost: CostClass
	readonly reason: CteReason
	/** The node's demanded columns: what a CTE for it must carry. */
	readonly columns: ReadonlyArray<string>
	/**
	 * Where the CTE stands: the statement's own WITH, or, for a shared correlated node (`sharedCorrelated`), the SELECT
	 * of the region that holds it (holdingRegion), which encloses every read of it and inside which every value it reads
	 * of an outer row is in scope.
	 */
	readonly scope:
		| { readonly kind: "statement" }
		| { readonly kind: "region"; readonly region: NodeId }
}

export interface CtePlan {
	/** One decision per shared node; every other node is inlined. */
	readonly decisions: Readonly<Record<NodeId, CteDecision>>
}

/** The plan of a statement whose stages no policy shared: every node is inlined. */
export const emptyCtePlan: CtePlan = { decisions: {} }

/**
 * What a compilation is, as the policy reads it: a workload's read (`query`), or another subject (a rule's probe over
 * its region, a derived relation's definition, a read-back, a membership), which rule 5b leaves as rule 1 has it.
 */
export type CteSubject = "query" | "other"

interface CtePlannedQuery extends LogicalQuery {
	readonly cte: CtePlan
}

const expensiveKinds: ReadonlyArray<RelKind> = [
	"Group",
	"Window",
	"OrderedSetAggregate",
	"Recursive",
	"Intersect",
	"Difference",
	"Union",
	"Take",
	"Produce",
	"ApproximateNearest",
	"Call"
]

/** The cost class of a node's own stage alone (costClass), its inputs' aside. */
const ownCost = (node: RelNode): CostClass =>
	expensiveKinds.includes(node.kind)
		? "expensive"
		: (node.kind === "MatchRegion" && node.occurrences.length > 1) ||
			  node.kind === "SemiJoin" ||
			  node.kind === "AntiJoin"
			? "join"
			: "scan"

/** The cost classes from the cheapest: a subtree's is its dearest stage's. */
const costRank: Readonly<Record<CostClass, number>> = { scan: 0, join: 1, expensive: 2 }

/**
 * Each node's cost class (costClass), for as long as the node lives: it reads only the node's immutable subtree, so one
 * value answers every reader of the node, and a node's is its own stage's and its inputs' dearest.
 */
const costs = new WeakMap<RelNode, CostClass>()

/**
 * The cost class of a node's subtree: expensive when any stage folds, sorts, bounds, recurses or compares sets; a join
 * when it matches several sources or tests existence; otherwise a scan of one source. The dearest of the node's own
 * stage's and its inputs' classes, each input's worked out once (costs), deepest first, where each node's walked its
 * whole subtree.
 */
export const costClass = (root: RelNode): CostClass => {
	const known = costs.get(root)
	if (known !== undefined) {
		return known
	}
	for (const node of postorder([root], (n) => inputsOf(n).filter((input) => !costs.has(input)))) {
		let cost = ownCost(node)
		for (const input of inputsOf(node)) {
			const below = defined(costs.get(input), "an input's cost class, worked out first")
			cost = costRank[below] > costRank[cost] ? below : cost
		}
		costs.set(node, cost)
	}
	return defined(costs.get(root), "the cost class of the node asked")
}

/** A shared node and the policy's decision for it. */
interface Decided {
	readonly node: RelNode
	readonly decision: CteDecision
}

/**
 * Whether every column of `columns` of `node` is bound, through the rows a node keeps of its input (ir/rel.ts
 * keptRowsOf: a filter's, a semi- or anti-join's left side's), projections of columns and every arm of a union, by one
 * occurrence of a stored relation in a region: a restriction by them is then a range of that relation, which the index
 * the workload's access paths request for it reads (physical/access), and the rest of the region joins each row of that
 * range by the variables it binds. A union's arms read its columns by name (lower/conservative/union/arms.ts), and
 * PostgreSQL moves a restriction of a UNION into each arm, so a restriction of a union is that range in each arm.
 */
const probedByKey = (node: RelNode, columns: ReadonlyArray<string>): boolean => {
	if (node.kind === "Union") {
		return unionArms(node.groups).every((arm) => probedByKey(arm, columns))
	}
	if (node.kind === "ProjectSet") {
		const read = columns.flatMap((c) => {
			const e = node.out.find((o) => o.name === c)?.expr
			return e?.kind === "column" && e.column.node === node.input.id ? [e.column.name] : []
		})
		return read.length === columns.length && probedByKey(node.input, read)
	}
	if (node.kind === "MatchRegion") {
		const vars = columns.flatMap((c) => node.vars.filter((v) => v.name === c))
		return (
			vars.length === columns.length &&
			node.occurrences.some(
				(o) => o.source.kind === "Base" && vars.every((v) => o.bindings.some((b) => b.var === v))
			)
		)
	}
	const kept = node.kind === "Take" ? undefined : keptRowsOf(node)
	return kept !== undefined && probedByKey(kept.input, columns)
}

/**
 * A fold a region reads per key (`foldsReadByKey`): the fold, the nodes its occurrence reads it through, from the
 * occurrence's source down, and each grouping column it restricts with the variable the occurrence binds through it.
 */
export interface FoldByKey {
	readonly fold: NodeOf<"Group">
	readonly through: ReadonlyArray<RelNode>
	readonly keys: NonEmptyReadonlyArray<{ readonly column: string; readonly variable: VarDecl }>
}

/**
 * The fold a source reads through projections that rename its columns and filters that keep its rows, the nodes it
 * reads it through, and the column of the fold each of `columns` is there; undefined where the source is no such chain
 * over a Group.
 */
const foldBeneath = (
	source: RelNode,
	columns: ReadonlyArray<string>
):
	| {
			readonly fold: NodeOf<"Group">
			readonly through: ReadonlyArray<RelNode>
			readonly columns: ReadonlyArray<string | undefined>
	  }
	| undefined => {
	let at = source
	let named: ReadonlyArray<string | undefined> = columns
	const through: Array<RelNode> = []
	while (at.kind === "Filter" || at.kind === "ProjectSet") {
		through.push(at)
		if (at.kind === "ProjectSet") {
			const input = at.input
			const out = new Map(at.out.map((o) => [o.name, o.expr]))
			named = named.map((name) => {
				const e = name === undefined ? undefined : out.get(name)
				return e?.kind === "column" && e.column.node === input.id ? e.column.name : undefined
			})
		}
		at = at.input
	}
	return at.kind === "Group" ? { fold: at, through, columns: named } : undefined
}

/**
 * The occurrences of a region whose folds a workload's read reads per key: each occurrence whose source is a fold, read
 * through projections that rename its columns and filters (`foldBeneath`), that binds grouping columns of it to
 * variables an occurrence of a stored relation binds, where one stored relation's range binds those columns in the
 * fold's input (probedByKey). The region places such an occurrence after the stored ones, which read nothing outside
 * themselves, and reads it for each of their bindings as the fold of that binding's keys alone, the keys restricted
 * below the aggregate, which the index the workload's access paths request reads (lower/shapes/region foldProbe), as an
 * attachment's fold by its correlation is read (`attachmentRead` perKey). A grouped derived table is never flattened,
 * so the whole fold joined beside its aggregate, or derived once for the statement (rule 5b), folds every row of its
 * input for each statement: edullm's learning-commons crosswalk, two counts of one standard's supports, each read
 * beside the pair folded every standard's (100 ms against 0.1 to 1 ms stored). Each binding meets the groups of its
 * keys, as the join of the whole fold does, so the region's bindings are the same set.
 */
export const foldsReadByKey = (
	region: NodeOf<"MatchRegion">
): ReadonlyMap<Occurrence, FoldByKey> => {
	const stored = new Set(
		region.occurrences.flatMap((o) =>
			o.source.kind === "Base" ? o.bindings.map((b) => b.var) : []
		)
	)
	const out = new Map<Occurrence, FoldByKey>()
	for (const o of region.occurrences) {
		const bound = o.source.kind === "Base" ? [] : o.bindings.filter((b) => stored.has(b.var))
		const beneath = foldBeneath(
			o.source,
			bound.map((b) => b.column)
		)
		if (beneath === undefined) {
			continue
		}
		const fold = beneath.fold
		const keys = bound.flatMap((b, i) => {
			const column = beneath.columns[i]
			return column !== undefined && fold.keys.includes(column) ? [{ column, variable: b.var }] : []
		})
		if (
			isNonEmpty(keys) &&
			probedByKey(
				fold.input,
				keys.map((k) => k.column)
			)
		) {
			out.set(o, { fold, through: beneath.through, keys })
		}
	}
	return out
}

/** The rows an attachment's child delivers: the child, through every attachment of its own to the rows it attaches to. */
const attachedRows = (child: RelNode): RelNode => {
	const input = deliveredInput(child)
	return input === undefined ? child : attachedRows(input)
}

/**
 * How a pipelined attachment's part reads its child's rows (lower/shapes/attach pipelinedAttachment), so that no form
 * derives them again for each parent row:
 *
 * - `perKey`: one stored relation's range binds every column the attachment correlates, in each arm of a union
 *   (probedByKey; for a fold by them, its input's), so the part reads the child once per parent key, the key's values
 *   fixed inside a LATERAL derived table PostgreSQL never pulls up: a fold restricted inside its grouping, any other
 *   child under DISTINCT. A union is restricted in each arm: edullm's `files`, ReferencePath ⋈ Media ∪ CandidatePath ⋈
 *   Media, read once for the statement, read every reference and media file stored for each item read.
 * - `once`: no stored relation's range binds them, so the statement derives `rows` once (rule 5b, a MATERIALIZED CTE)
 *   and the part joins each parent key to them beside.
 * - `take`: a take, which the take policy reads its own way (R20, lower/shapes/take), beside.
 */
export type AttachmentRead =
	| { readonly kind: "perKey" }
	| { readonly kind: "once"; readonly rows: RelNode }
	| { readonly kind: "take" }

export const attachmentRead = (attach: NodeOf<"Attach">): AttachmentRead => {
	const rows = attachedRows(attach.child)
	if (rows.kind === "Take") {
		return { kind: "take" }
	}
	const keys = attach.correlation.map((c) => c.child)
	const probed =
		rows.kind === "Group" && keys.every((k) => rows.keys.includes(k)) ? rows.input : rows
	return keys.length > 0 && probedByKey(probed, keys) ? { kind: "perKey" } : { kind: "once", rows }
}

/** The variables of a region a value fixes: a correlation that reads no relation, a parameter or a literal. */
const fixedByValue = (region: NodeOf<"MatchRegion">): ReadonlySet<VarDecl> =>
	new Set(region.correlated.flatMap((c) => (c.expr.deps.nodes.length === 0 ? [c.var] : [])))

/**
 * The nodes a reader reads once per row of its other input, as PostgreSQL evaluates them where they stand: the source
 * of a region's occurrence no value restricts (no constant fixes one of its columns, and no parameter or literal one of
 * the variables it binds), which the region joins to its other occurrences, but a fold the region reads per key
 * (`foldsReadByKey`), whose every read is its binding's groups; the right side of a semi- or anti-join,
 * which it tests for each row of its left; and an attachment's rows no stored relation's range binds by the columns it
 * correlates (attachmentRead `once`), which its part would otherwise read for each parent row.
 */
const readPerRow = (order: ReadonlyArray<RelNode>): ReadonlySet<RelNode> => {
	const out = new Set<RelNode>()
	for (const node of order) {
		if (node.kind === "MatchRegion") {
			const fixed = fixedByValue(node)
			const byKey = foldsReadByKey(node)
			for (const o of node.occurrences) {
				if (
					o.constants.length === 0 &&
					o.bindings.every((b) => !fixed.has(b.var)) &&
					!byKey.has(o)
				) {
					out.add(o.source)
				}
			}
		} else if (node.kind === "SemiJoin" || node.kind === "AntiJoin") {
			out.add(node.right)
		} else if (node.kind === "Attach") {
			const read = attachmentRead(node)
			if (read.kind === "once") {
				out.add(read.rows)
			}
		}
	}
	return out
}

/**
 * The policy's decision for every node of a DAG it computes as a CTE, in topological order: a node read more than
 * once, and, in a workload's read (`reads`), a node read once per row of another (readPerRow).
 */
const ctePlan = (dag: ValidDag, reads: CteSubject): ReadonlyArray<Decided> => {
	const d = analyzeDemand(dag, noPins)
	const scopes = nodeScopes()
	const labels = nodesByLabel(dag)
	const feedback = feedbackReadsOf(nodeGraph, d.order)
	const perRow = reads === "query" ? readPerRow(d.order) : new Set<RelNode>()
	const regionOf = holdingRegion(d.order, (node) => scopes.of(node).outer)
	const decided: Array<Decided> = []
	for (const node of d.order) {
		const references = d.references(node)
		if (references < 2 && !(perRow.has(node) && node.kind !== "Recursive")) {
			continue
		}
		const cost = costClass(node)
		const demanded = d.demanded(node)
		const decide = (
			strategy: CteStrategy,
			reason: CteReason,
			scope: CteDecision["scope"]
		): CteDecision => ({
			node: node.id,
			strategy,
			references,
			cost,
			reason,
			columns: node.heading.flatMap((c) => (demanded.has(c.name) ? [c.name] : [])),
			scope
		})
		let decision: CteDecision
		if (node.kind === "Recursive") {
			decision = decide("recursive", "recursive", statementScope)
		} else if (feedback.has(node)) {
			decision = decide("inline", "feedback", statementScope)
		} else if (
			outerOf(node).length > 0 ||
			freeVars(labels, scopes.of(node)).length > 0 ||
			d.lateral(node)
		) {
			const region = cost === "scan" ? undefined : regionOf(node, references)
			decision =
				region === undefined
					? decide("inline", "correlated", statementScope)
					: decide("materialized", "sharedCorrelated", { kind: "region", region: region.id })
		} else if (cost === "scan") {
			decision = decide("inline", "cheapScan", statementScope)
		} else if (perRow.has(node)) {
			decision = decide("materialized", "readPerRow", statementScope)
		} else if (cost === "expensive") {
			decision = decide("materialized", "sharedExpensive", statementScope)
		} else {
			decision = decide("notMaterialized", "sharedJoin", statementScope)
		}
		decided.push({ node, decision })
	}
	return decided
}

const cteRule = (strategy: Exclude<CteStrategy, "inline">): CertificateRule => `cte.${strategy}`

/** A CTE of the statement's own WITH. */
const statementScope: CteDecision["scope"] = { kind: "statement" }

/**
 * The region whose CTEs a node's SELECT holds (cte-policy `sharedCorrelated`): a region's own, and a relational filter's
 * over a region, an anti- or semi-join whose left input is the region or a filter over it in turn, which holds the
 * region's: the filter is lowered as a SELECT over the region's (lower/conservative/anti-join, semi-join), its test
 * reading what the region's rows bind, so a node read both inside the region and inside the test, the unit's definition
 * a containment's sides both read, is in scope for each read only in the filter's SELECT, where in the region's own the
 * test read none of it and spelled the node again at each of its reads. The lowering opens the region's table of CTEs
 * at the outermost such node (lower/shapes dispatchIn).
 */
export const filteredRegion = (node: RelNode): NodeOf<"MatchRegion"> | undefined =>
	node.kind === "MatchRegion"
		? node
		: node.kind === "AntiJoin" || node.kind === "SemiJoin"
			? filteredRegion(node.left)
			: undefined

/**
 * The region whose SELECT holds a shared correlated node's CTE (rule 3b), where `references`, the node's reads, are all
 * occurrences of regions and no expression reads it: the outermost node on the node's chain of dominators, the nodes
 * every path from a root to it passes through, that holds a region's CTEs (`filteredRegion`) and whose SELECT sees every
 * value the node reads of an outer row (`outer`, the node's outer references by label): each one the region's
 * correlation brings in from outside, or a column of a node outside that SELECT, which reads it from outside itself.
 * Dominating every read, that SELECT encloses each read's spelling, so the node is spelled and planned once there and
 * computed once per row the SELECT is read for, each occurrence a join of its rows; every node between it and the node
 * sees what the node reads, and none outside it sees a value its own rows bind. A node that reads no outer value,
 * correlated only by a reader's expression that reads its columns laterally, stands in the first such node, its
 * readers' own region, since no value it reads bounds how far out it would stand. A rule statement's import its rule's
 * unfolding reads more than once (analysis/theory/navigate.ts sharedImports) is one, each read a match of the rule
 * itself; and so is the import each rule of a union reads at the values its importer bound (check/checker.ts
 * #bindValue), the raw column of the unit or of a region outside them, every rule of the union a region of its own,
 * held by the region every read lies inside below the one whose rows bind those values, where no SELECT the rules
 * share sees them; inlined at each read, a chain of such definitions multiplied the statement at every level, and a
 * chain of unions by their rules at every level. None for any other node, which stays inlined (rule 3).
 *
 * The dominators are worked out once, readers before their inputs: each node's immediate dominator is where the
 * chains of its readers meet, a root's none.
 */
const holdingRegion = (
	order: ReadonlyArray<RelNode>,
	outer: (node: RelNode) => OuterRefs
): ((node: RelNode, references: number) => NodeOf<"MatchRegion"> | undefined) => {
	const readers = new Map<RelNode, Array<RelNode>>()
	for (const n of order) {
		for (const input of inputsOf(n)) {
			readers.getOrInsertComputed(input, () => []).push(n)
		}
	}
	const dominator = new Map<RelNode, RelNode | undefined>()
	const depth = new Map<RelNode, number>()
	const depthOf = (n: RelNode): number =>
		defined(depth.get(n), "a reader's depth, worked out first")
	const meet = (a: RelNode | undefined, b: RelNode | undefined): RelNode | undefined => {
		let x = a
		let y = b
		while (x !== y) {
			if (x === undefined || y === undefined) {
				return undefined
			}
			const dx = depthOf(x)
			const dy = depthOf(y)
			if (dx >= dy) {
				x = dominator.get(x)
			}
			if (dy >= dx) {
				y = dominator.get(y)
			}
		}
		return x
	}
	for (const n of order.toReversed()) {
		const [first, ...rest] = readers.get(n) ?? []
		const at = first === undefined ? undefined : rest.reduce(meet, first)
		dominator.set(n, at)
		depth.set(n, at === undefined ? 0 : depthOf(at) + 1)
	}
	/** Whether `at`'s SELECT, holding `region`'s CTEs, sees every value of `read`. */
	const sees = (at: RelNode, region: NodeOf<"MatchRegion">, read: OuterRefs): boolean => {
		const around = outer(at)
		for (const [id, columns] of read) {
			if (
				id === region.id
					? ![...columns].every((c) => region.correlated.some((v) => v.var.name === c))
					: !around.has(id)
			) {
				return false
			}
		}
		return true
	}
	return (node, references) => {
		let occurrences = 0
		for (const r of readers.get(node) ?? []) {
			if (r.kind !== "MatchRegion") {
				return undefined
			}
			occurrences += r.occurrences.filter((o) => o.source === node).length
		}
		if (occurrences !== references) {
			return undefined
		}
		const read = outer(node)
		let held: NodeOf<"MatchRegion"> | undefined
		for (let at = dominator.get(node); at !== undefined; at = dominator.get(at)) {
			const region = filteredRegion(at)
			if (region === undefined) {
				continue
			}
			if (!sees(at, region, read)) {
				break
			}
			held = region
			if (read.size === 0) {
				break
			}
		}
		return held
	}
}

/**
 * The policy as a pass: the query unchanged, with its plan, and a certificate for each shared stage the statement
 * computes as a CTE. The decision rests on no evidence (queryLocal); it is a placement, not a rewrite of meaning.
 *
 * The CTE policy: which shared stages a statement computes once.
 *
 * "A CTE is a relational program boundary, not inherently an optimization." The rewrites leave a DAG in which a node
 * read by several consumers is a sharing boundary; the emitter must spell each such node as a derived table at every
 * use (inline), a CTE PostgreSQL may fold into each use (NOT MATERIALIZED), or a CTE it computes once (MATERIALIZED).
 * The choice is the compiler's, never an application hint, and is made here from the graph alone: reference count,
 * complete parameter bindings, correlation, demanded fields and cost class. It runs no trial query and reads no
 * statistics. A node is shared when it is read more than once.
 *
 * The rules, in order:
 *
 * 1. A node read once, or never shared, is inlined: an eligible single-use stage folds, but for a node a workload's
 *    read reads once per row of another (readPerRow), which rule 5b decides.
 * 2. A recursive relation is a WITH RECURSIVE: always a CTE, computed once per statement.
 * 3. A correlated node, a node some expression reads laterally, and a node on a recursive step are inlined: a CTE of
 *    the statement's WITH cannot read an outer row, and a recursive term admits one self-reference.
 * 3b. But a shared correlated node of several sources whose every read is an occurrence of a region is MATERIALIZED in
 *    the SELECT of the outermost region that lies on every path to it and sees every outer value it reads, its
 *    correlated values or the columns of nodes outside it (holdingRegion): spelled and planned once, computed once per
 *    row that SELECT is read for, each occurrence a join of its rows. A rule statement's import its rule's unfolding
 *    reads more than once is one (analysis/theory/navigate.ts sharedImports), and so is the import each rule of a union
 *    reads at the unit's channels (check/checker.ts #sharedImport), held by the region below the unit's every read lies
 *    in; inlined at each read, a chain of such definitions multiplied the statement at every level, and a chain of
 *    unions by their rules at every level.
 * 4. A node whose stages are all scans, filters and projections of one source is inlined at each use: each use can then
 *    probe the source's indexes with its own restrictions, which a shared result would hide ("sharing an unfiltered
 *    computation is not automatically preferable to two selective indexed probes").
 * 5b. In a workload's read, a node of several sources, or one that folds, sorts, bounds, deduplicates a set operation
 *    or recurses, that a reader reads once per row of another (readPerRow) is MATERIALIZED, read once or shared: the
 *    statement derives it once, whatever PostgreSQL estimates. Inlined there, PostgreSQL plans it as the inner side of
 *    a nested loop it re-derives for each outer row, with the join key a filter above it, wherever its estimates make
 *    that look as cheap as reading it once: a scan of a relation whose rows a constant picks a few of from many
 *    (one LOM element per package of a table of every XML node) is estimated at one row, so a derivation of such scans
 *    is too, and a nested loop over it costs nothing to the planner, while it reads all of it for every row it joins
 *    (2026-11-18, edullm's `sets`: Current derived once per classification term row, 579 times, and the items
 *    attachment's ItemSet once per term). Its readers then join or test each row against rows the statement holds, and
 *    read no relation again. A rule's probe and every other compilation keep rule 1: they read a unit's rows, which a
 *    once-derived relation would read all of.
 * 5. A node that folds, sorts, bounds, deduplicates a set operation or recurses is expensive. Shared, it is
 *    MATERIALIZED: one evaluation feeds every use.
 * 6. Any other shared node, a join of several sources, is NOT MATERIALIZED: PostgreSQL may optimize each use jointly
 *    with its consumer, and the boundary stays a program boundary rather than a forced fence.
 *
 * NOT MATERIALIZED never erases a DISTINCT, aggregate or other semantic boundary, and MATERIALIZED blocks parent
 * restrictions from entering the stage: the restrictions every use shares were already moved below it by
 * predicate movement. Distinct imports with different parameter bindings are different nodes, so they are never shared.
 * CTE rows belong to one execution and are never a result cache.
 */
export const ctePolicyPass = (reads: CteSubject): Pass<LogicalQuery, CtePlannedQuery> => ({
	name: "ctePolicy",
	run: (query, ctx) =>
		catchRefusal(() => {
			const decided = ctePlan(query.dag, reads)
			const decisions: Record<NodeId, CteDecision> = {}
			for (const { node, decision } of decided) {
				decisions[node.id] = decision
			}
			for (const { node, decision } of decided) {
				if (decision.strategy === "inline") {
					continue
				}
				const cert = unwrap(
					makeCertificate(
						localCertificate(
							cteRule(decision.strategy),
							[decision.node],
							[decision.node],
							[decision.node],
							node.heading.map((c) => c.name)
						)
					)
				)
				ctx.certificates.record(cert)
			}
			return { ...query, cte: { decisions } }
		})
})
