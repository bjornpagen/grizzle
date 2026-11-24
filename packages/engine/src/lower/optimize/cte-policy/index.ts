import { immediateDominators, postorder } from "@bjornpagen/grizzle-text/base/graph"
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
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	deliveredInput,
	inputsOf,
	keptRowsOf,
	type NodeOf,
	type Occurrence,
	regionVarClasses,
	type RelKind,
	type RelNode,
	unionArms,
	type ValidDag,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import { feedbackReadsOf, nodeGraph } from "#compiler/lower/optimize/demand/editor.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

export type CteStrategy = "inline" | "notMaterialized" | "materialized" | "recursive"

export type CostClass = "scan" | "join" | "expensive"

type CteReason =
	| "singleUse"
	| "recursive"
	| "correlated"
	| "sharedCorrelated"
	| "feedback"
	| "cheapScan"
	| "sharedExpensive"
	| "sharedRestricted"
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
	 * Where the CTE stands: the statement's own WITH, or, for a shared correlated node (`sharedCorrelated`), the query
	 * of the holder that holds it (holderOf), a region's SELECT or a call's evaluation's query, named by its label, which
	 * encloses every read of it and inside which every value it reads of an outer row is in scope.
	 */
	readonly scope:
		| { readonly kind: "statement" }
		| { readonly kind: "held"; readonly holder: NodeId }
}

export interface CtePlan {
	/** One decision per shared node; every other node is inlined. */
	readonly decisions: Readonly<Record<NodeId, CteDecision>>
	/**
	 * The evaluation of each call whose evaluation's query holds a CTE (holderOf), by the call's label: the holder a
	 * decision names, which the lowering opens where it builds that query.
	 */
	readonly evaluations: Readonly<Record<NodeId, NodeId>>
}

/** The plan of a statement whose stages no policy shared: every node is inlined. */
export const emptyCtePlan: CtePlan = { decisions: {}, evaluations: {} }

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
export const ownCost = (node: RelNode): CostClass =>
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

/** The sources whose rows a restriction of any column restricts as it stands: each reads no input it could fix. */
const restrictedLeaves: ReadonlyArray<RelKind> = ["Base", "Closed", "Context", "InputSet", "Delta"]

/**
 * Whether fixing each of `columns` of `node` restricts every relation it reads to the rows those values pick, so a read
 * of it with them fixed derives nothing whole: through the rows a node keeps of its input (ir/rel.ts keptRowsOf, a
 * take's aside, whose bound is counted before any restriction above it), a step's, its input's rows unchanged,
 * projections of columns, every arm of a union and a fold's grouping columns, to a stored or given relation; in a region, each column a variable some occurrence
 * binds whose source the column restricts so, PostgreSQL carrying a fixed value through the region's equalities to every
 * occurrence that binds it: no fixed value stops at a fold's aggregate, a bound, a window or a recursion, past
 * which PostgreSQL derives the rows whole for each value (an existence test's right side read per left row,
 * lower/conservative/semi-join/exists.ts).
 */
export const restrictedByKeys = (node: RelNode, columns: ReadonlyArray<string>): boolean => {
	if (restrictedLeaves.includes(node.kind)) {
		return true
	}
	if (node.kind === "Union") {
		return unionArms(node.groups).every((arm) => restrictedByKeys(arm, columns))
	}
	if (node.kind === "ProjectSet") {
		const read = columns.flatMap((c) => {
			const e = node.out.find((o) => o.name === c)?.expr
			return e?.kind === "column" && e.column.node === node.input.id ? [e.column.name] : []
		})
		return read.length === columns.length && restrictedByKeys(node.input, read)
	}
	if (node.kind === "Group") {
		return columns.every((c) => node.keys.includes(c)) && restrictedByKeys(node.input, columns)
	}
	if (node.kind === "Step") {
		return restrictedByKeys(node.input, columns)
	}
	if (node.kind === "MatchRegion") {
		const vars = columns.flatMap((c) => node.vars.filter((v) => v.name === c))
		return (
			vars.length === columns.length &&
			vars.every((v) =>
				node.occurrences.some((o) =>
					o.bindings.some((b) => b.var === v && restrictedByKeys(o.source, [b.column]))
				)
			)
		)
	}
	const kept = node.kind === "Take" ? undefined : keptRowsOf(node)
	return kept !== undefined && restrictedByKeys(kept.input, columns)
}

/**
 * The length of the longest prefix of one of a stored relation's declared keys (its primary key, then each other in
 * declared order) whose every column is bound, by `bound` or by a constant, holding at least one `bound` column: the
 * rows a seek at such a prefix reads share the key's own value, never another's; 0 where no such prefix stands. A prefix
 * of constants alone is none: its rows are every key value's.
 */
const boundPrefix = (
	base: NodeOf<"Base">,
	bound: ReadonlySet<string>,
	constant: ReadonlySet<string>
): number => {
	let longest = 0
	for (const key of [base.primaryKey, ...base.keys]) {
		let length = 0
		let keyed = false
		for (const column of key) {
			if (bound.has(column)) {
				keyed = true
			} else if (!constant.has(column)) {
				break
			}
			length += 1
		}
		if (keyed && length > longest) {
			longest = length
		}
	}
	return longest
}

/**
 * A region's occurrences in the order a read of it at `columns` chains them (keyedRegionChain): first the occurrence
 * the columns bind on the longest declared-key prefix, then each occurrence the columns or those before it bind on the
 * longest, ties broken by placement, the canonical order of the region's occurrences, never by an estimate; undefined where an occurrence is never bound on one, a stored relation by no
 * declared-key prefix (boundPrefix) or any other source by none of its keys (keyPrefixBound).
 */
export const keyedRegionChain = (
	region: NodeOf<"MatchRegion">,
	columns: ReadonlyArray<string>
): ReadonlyArray<Occurrence> | undefined => {
	const classOf = regionVarClasses(region)
	const bound = new Set(
		columns.flatMap((c) => region.vars.filter((v) => v.name === c).map((v) => classOf(v)))
	)
	const chain: Array<Occurrence> = []
	const pending = [...region.occurrences]
	/** Whether every variable of the region a source reads from outside itself is bound. */
	const readsBound = (source: RelNode): boolean =>
		outerOf(source).every(
			(c) =>
				c.node !== region.id ||
				region.vars.some((v) => v.name === c.column && bound.has(classOf(v)))
		)
	/**
	 * How long a prefix `o` is bound on now, 0 for none: a stored relation's longest bound declared-key prefix
	 * (boundPrefix); any other source 1 where its bound columns prove it (keyPrefixBound); and below every such, a set the
	 * statement holds (none of the store's rows) or a row function of values once every value its arguments read is
	 * bound, which reads no store and is evaluated per row of what it follows (`statementHeld`).
	 */
	const prefixOf = (o: Occurrence): number => {
		const at = o.bindings.flatMap((b) => (bound.has(classOf(b.var)) ? [b.column] : []))
		const constant = new Set(o.constants.map((c) => c.column))
		const source = o.source
		return source.kind === "Base"
			? boundPrefix(source, new Set(at), constant)
			: at.length > 0 && keyPrefixBound(source, at)
				? 1
				: statementHeld.includes(source.kind) ||
					  (source.kind === "Call" &&
							source.args.every((a) => a.kind === "value") &&
							readsBound(source))
					? 0.5
					: 0
	}
	while (pending.length > 0) {
		let best: { readonly at: number; readonly prefix: number } | undefined
		for (const [at, o] of pending.entries()) {
			const prefix = prefixOf(o)
			if (prefix > 0 && (best === undefined || prefix > best.prefix)) {
				best = { at, prefix }
			}
		}
		if (best === undefined) {
			return undefined
		}
		const [next] = pending.splice(best.at, 1)
		if (next === undefined) {
			return undefined
		}
		chain.push(next)
		for (const b of next.bindings) {
			bound.add(classOf(b.var))
		}
	}
	return chain
}

/**
 * Whether fixing each of `columns` of `node` binds every stored relation its rows read on a non-empty prefix of one of
 * its declared keys, by the columns or by a relation bound before it (keyedRegionChain): each read at the values a
 * seek of that prefix, its rows the key's own, never another key's, whatever PostgreSQL estimates, so the node at one
 * key reads rows of that key alone, however many keys the store holds. Through the rows a node keeps of its input,
 * a step's, projections of columns, every arm of a union, a fold's grouping columns (a fold over a keyed relation, its
 * groups that key's) and a region's chain; a set the statement holds (a delta, the call's input or context, a closed
 * relation's rows) is read whole, none of the store's. The proof a per-key read stands on (cte-policy attachmentRead
 * `perKey`), the declared facts alone, never a reading of selectivity: a prefix of constants alone, or a value no key
 * leads with, reads every key's rows (read-once's terms, each read by its purpose's value, every package's).
 */
/** The sources a statement holds itself, none of the store's rows: a delta, the call's input or context, a closed relation. */
const statementHeld: ReadonlyArray<RelKind> = ["InputSet", "Delta", "Context", "Closed"]

const keyPrefixBound = (node: RelNode, columns: ReadonlyArray<string>): boolean => {
	if (columns.length === 0) {
		return false
	}
	switch (node.kind) {
		case "InputSet":
		case "Delta":
		case "Context":
		case "Closed":
			return true
		case "Base":
			return boundPrefix(node, new Set(columns), new Set()) > 0
		case "Union":
			return unionArms(node.groups).every((arm) => keyPrefixBound(arm, columns))
		case "ProjectSet": {
			/**
			 * A column the projection holds at a value that reads no relation (a parameter the constant-column pass reads in
			 * its place, or a literal) is one value at every key: the key's other columns prove the read, and a key every
			 * column of which is so held is one, read once, the statement's own.
			 */
			const read: Array<string> = []
			for (const c of columns) {
				const e = node.out.find((o) => o.name === c)?.expr
				if (e?.kind === "column" && e.column.node === node.input.id) {
					read.push(e.column.name)
				} else if (e === undefined || e.deps.nodes.length > 0) {
					return false
				}
			}
			return read.length === 0 || keyPrefixBound(node.input, read)
		}
		case "Group": {
			/** A fold's groups are its input's rows at its keys; a bound aggregate beside them filters those groups alone. */
			const keyed = columns.filter((c) => node.keys.includes(c))
			return keyed.length > 0 && keyPrefixBound(node.input, keyed)
		}
		case "Step":
		case "Filter":
			return keyPrefixBound(node.input, columns)
		case "SemiJoin":
		case "AntiJoin":
			return (
				keyPrefixBound(node.left, columns) &&
				keyPrefixBound(
					node.right,
					node.on.map((p) => p.right)
				)
			)
		case "MatchRegion":
			return keyedRegionChain(node, columns) !== undefined
		case "Attach":
			return keyPrefixBound(node.parent, columns)
		case "ApproximateNearest":
		case "Call":
		case "Difference":
		case "Forbid":
		case "Intersect":
		case "OrderedResult":
		case "OrderedSetAggregate":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "Take":
		case "Window":
			return false
	}
}

/** Each node's restriction by the statement's own values (restrictedByValues), for as long as the node lives. */
const restrictions = new WeakMap<RelNode, boolean>()

/** The nodes a node reads from outside itself (analysis/physical/rules.ts outerOf), by label. */
const outsideOf = (node: RelNode): ReadonlySet<NodeId> => new Set(outerOf(node).map((c) => c.node))

/**
 * Whether an expression is a value fixed where its region is evaluated: it reads a parameter or a column of an outer
 * row the region reads from outside itself (`outside`), and no other node, one value for each evaluation as a parameter
 * is one for the statement. A literal alone is none.
 */
const fixedValue = (e: ScalarExpr, outside: ReadonlySet<NodeId>): boolean =>
	(e.deps.params.length > 0 || e.deps.nodes.length > 0) && e.deps.nodes.every((n) => outside.has(n))

/**
 * Whether `node`'s rows are restricted where `reader` evaluates it (restrictedByValues): by the statement's values, or
 * by the values of an outer row `reader` reads from outside itself too, fixed for each evaluation of it. A source a row
 * inside `reader` correlates, a region's sibling read laterally or an existence test's own left row, is restricted only
 * once that row is, which no evaluation of `reader` fixes beforehand.
 */
export const restrictedWithin = (node: RelNode, reader: RelNode): boolean => {
	if (!restrictedByValues(node)) {
		return false
	}
	const outside = outsideOf(reader)
	return outerOf(node).every((c) => outside.has(c.node))
}

/**
 * Whether a region's rows are restricted by the values fixed where it is evaluated (restrictedByValues): every
 * occurrence is reached from one whose rows those values restrict, an occurrence of a stored relation a parameter or an
 * outer row's column fixes a column of (`fixedValue`), through the variables the reached ones bind, each occurrence it
 * reaches restricted by them, a stored relation's range at the bound columns or a source fixing them restricts at every
 * relation (restrictedByKeys); and a source restricted once the row it reads of an outer node is, each such node outside
 * the region (restrictedWithin) or a variable or an occurrence of the region already reached, a step a navigation reads
 * by the variables the steps before it bound (analysis/theory/navigate.ts), restricted for each of their rows as a
 * parameter restricts it for the statement. `also` are equalities between the region's variables a filter over it
 * states (`filterEqualities`), which restrict it as its own do. A correlated region is evaluated once per outer row,
 * which fixes the values its correlation reads as a parameter fixes them for the statement: edullm's decideStage
 * read-back evaluated attempt_marks_of per sitting, and the latest attempt of each session of the sitting's stage,
 * restricted by the sitting, was read per key by each of 162 rows arguments where it is one fold per sitting. A literal
 * fixes no such range: the kind codes a content read compares are no restriction of its rows to the statement's. metis's
 * hold gate read its due assignments, the call's user's beside the derived view Open, its step reading each assignment
 * again at the key the first read bound and the view's row equated to it by a filter: restricted by neither, the due
 * rows seeded no key set, and the union of each assignment's read-aloud stamps beside them was read whole, 97,379
 * assignments in each of its three arms per call.
 */
const regionRestrictedByValues = (
	region: NodeOf<"MatchRegion">,
	also: ReadonlyArray<{ readonly a: VarDecl; readonly b: VarDecl }>
): boolean => {
	const outside = outsideOf(region)
	const reached = new Set<VarDecl>(
		region.correlated.flatMap((c) => (fixedValue(c.expr, outside) ? [c.var] : []))
	)
	const pending = new Set(region.occurrences)
	const reach = (o: Occurrence): void => {
		pending.delete(o)
		for (const b of o.bindings) {
			reached.add(b.var)
		}
	}
	for (const o of region.occurrences) {
		if (
			o.source.kind === "Base" &&
			(o.constants.some((c) => fixedValue(c.expr, outside)) ||
				o.bindings.some((b) => reached.has(b.var)))
		) {
			reach(o)
		}
	}
	/** Whether `o` reads an outer row's column `c` the region already fixes: outside it, or reached within it. */
	const fixedFor = (
		o: Occurrence,
		c: { readonly node: NodeId; readonly column: string }
	): boolean =>
		outside.has(c.node) ||
		(c.node === region.id && region.vars.some((v) => v.name === c.column && reached.has(v))) ||
		region.occurrences.some((q) => q !== o && !pending.has(q) && q.source.id === c.node)
	const equalities = [...region.equalities, ...also]
	for (let grew = true; grew;) {
		grew = false
		for (const e of equalities) {
			if (reached.has(e.a) === reached.has(e.b)) {
				continue
			}
			reached.add(e.a)
			reached.add(e.b)
			grew = true
		}
		for (const o of pending) {
			const joined = o.bindings.flatMap((b) => (reached.has(b.var) ? [b.column] : []))
			if (
				(isNonEmpty(joined) && (o.source.kind === "Base" || restrictedByKeys(o.source, joined))) ||
				(o.source.kind !== "Base" &&
					restrictedByValues(o.source) &&
					outerOf(o.source).every((c) => fixedFor(o, c)))
			) {
				reach(o)
				grew = true
			}
		}
	}
	return pending.size === 0
}

/**
 * The equalities a filter over a region states between two of its columns, each a variable of the region: the region
 * at them (regionRestrictedByValues `also`), as a navigation's step equates the row of a view it reads to the values
 * its reader passes in.
 */
const filterEqualities = (
	filter: NodeOf<"Filter">,
	region: NodeOf<"MatchRegion">
): ReadonlyArray<{ readonly a: VarDecl; readonly b: VarDecl }> =>
	conjuncts(filter.pred).flatMap((e) => {
		const [x, y, ...more] = e.kind === "op" && nativeOp(e.op)?.fn === "eq" ? e.args : []
		const a = x?.kind === "column" && x.column.node === region.id ? x.column.name : undefined
		const b = y?.kind === "column" && y.column.node === region.id ? y.column.name : undefined
		const va = region.vars.find((v) => v.name === a)
		const vb = region.vars.find((v) => v.name === b)
		return va !== undefined && vb !== undefined && more.length === 0 ? [{ a: va, b: vb }] : []
	})

/**
 * Whether the rows of `node` are restricted by the statement's own values, so the statement derives only what they
 * pick wherever it derives them: a set a call or a write passes in (an input set, a delta, the session's context); a
 * region every occurrence of which those values reach (regionRestrictedByValues); and a node over such rows, its
 * input's, a union's every arm's, a call's every rows argument's. A stored relation or a constant one read whole, and
 * a recursion, restrict nothing. A join so restricted is computed once where the statement shares it (rule 5d, and
 * lower/shapes/share/statements.ts sharedOnce): what inlining a join bought, each read's restriction pushed into it so
 * no read derives it whole, its own values already give it, so the one CTE holds the rows its reads restrict and no
 * more, where a join no value restricts stays inline at each read (rules 4 and 6), never derived whole.
 */
export const restrictedByValues = (node: RelNode): boolean => {
	const known = restrictions.get(node)
	if (known !== undefined) {
		return known
	}
	const restricted = ((): boolean => {
		switch (node.kind) {
			case "InputSet":
			case "Delta":
			case "Context":
				return true
			case "Base":
			case "Closed":
			case "Recursive":
			case "SelfRef":
				return false
			case "MatchRegion":
				return regionRestrictedByValues(node, [])
			case "Union":
				return unionArms(node.groups).every(restrictedByValues)
			case "Intersect":
				return restrictedByValues(node.left) || restrictedByValues(node.right)
			case "Call":
				return node.args.every((a) => a.kind === "value" || restrictedByValues(a.rows))
			case "Attach":
				return restrictedByValues(node.parent)
			case "Forbid":
				return restrictedByValues(node.violation)
			case "SemiJoin":
			case "AntiJoin":
			case "Difference":
				return restrictedByValues(node.left)
			case "Filter":
				return (
					restrictedByValues(node.input) ||
					valueEqualities(node).length > 0 ||
					(node.input.kind === "MatchRegion" &&
						regionRestrictedByValues(node.input, filterEqualities(node, node.input)))
				)
			case "ProjectSet":
			case "Take":
			case "Group":
			case "Produce":
			case "OrderedResult":
			case "Window":
			case "OrderedSetAggregate":
			case "Step":
				return restrictedByValues(node.input)
			case "ApproximateNearest":
				return restrictedByValues(node.source)
		}
	})()
	restrictions.set(node, restricted)
	return restricted
}

/**
 * A region that reads one occurrence as it stands, its rows the source's rows renamed: no equality, no correlation, no
 * constant, each variable bound once; undefined for any other region.
 */
export const renamedSource = (
	region: NodeOf<"MatchRegion">
): { readonly occurrence: Occurrence } | undefined => {
	const [occurrence, ...others] = region.occurrences
	return occurrence !== undefined &&
		others.length === 0 &&
		region.equalities.length === 0 &&
		region.correlated.length === 0 &&
		occurrence.constants.length === 0 &&
		new Set(occurrence.bindings.map((b) => b.var.id)).size === occurrence.bindings.length
		? { occurrence }
		: undefined
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
 * - `perKey`: a declared-key prefix binds every relation the child reads at the correlated columns (keyPrefixBound):
 *   once per parent key, the key's values fixed inside a LATERAL derived table PostgreSQL never pulls up and carried
 *   into every node under the child that reads them (lower/shapes/share/keys.ts restrictionWalk), a fold's below its
 *   aggregate, a union's in each arm, a region's chain led by its longest bound prefix: edullm's `files`, ReferencePath ⋈ Media ∪ CandidatePath ⋈ Media, read
 *   once for the statement, read every reference and media file stored for each item read.
 * - `coGroup`: no declared-key prefix binds the correlated columns (keyPrefixBound), so a read at one key would read
 *   other keys' rows: the child derived once, whole, and co-grouped with the parent keys by one GROUP BY
 *   (lower/shapes/attach coGroupedRows). A child that reads its parent row's values itself is read per key, whatever
 *   binds it: no derivation of it holds for every parent at once.
 * - `take`: a take, which the take policy reads its own way (R20, lower/shapes/take), beside.
 */
export type AttachmentRead =
	| { readonly kind: "perKey" }
	| { readonly kind: "coGroup" }
	| { readonly kind: "take" }

export const attachmentRead = (attach: NodeOf<"Attach">): AttachmentRead => {
	const rows = attachedRows(attach.child)
	return rows.kind === "Take"
		? { kind: "take" }
		: outerOf(attach.child).length > 0 ||
			  keyPrefixBound(
					rows,
					attach.correlation.map((c) => c.child)
			  )
			? { kind: "perKey" }
			: { kind: "coGroup" }
}

/** The variables of a region a value fixes: a correlation that reads no relation, a parameter or a literal. */
const fixedByValue = (region: NodeOf<"MatchRegion">): ReadonlySet<VarDecl> =>
	new Set(region.correlated.flatMap((c) => (c.expr.deps.nodes.length === 0 ? [c.var] : [])))

/**
 * The nodes a reader reads once per row of its other input, as PostgreSQL evaluates them where they stand: the source
 * of a region's occurrence no value restricts (no constant fixes one of its columns, and no parameter or literal one of
 * the variables it binds), which the region joins to its other occurrences; the right side of a semi- or anti-join,
 * which it tests for each row of its left.
 */
const readPerRow = (order: ReadonlyArray<RelNode>): ReadonlySet<RelNode> => {
	const out = new Set<RelNode>()
	for (const node of order) {
		if (node.kind === "MatchRegion") {
			const fixed = fixedByValue(node)
			for (const o of node.occurrences) {
				if (o.constants.length === 0 && o.bindings.every((b) => !fixed.has(b.var))) {
					out.add(o.source)
				}
			}
		} else if (node.kind === "SemiJoin" || node.kind === "AntiJoin") {
			out.add(node.right)
		}
	}
	return out
}

/**
 * The columns of a filter's input a conjunct of it equates to a value that reads no relation, a parameter or a literal,
 * each with that value: the filter keeps only the rows at those values.
 */
export const valueFixings = (
	filter: NodeOf<"Filter">
): ReadonlyArray<{ readonly column: string; readonly value: ScalarExpr }> =>
	conjuncts(filter.pred).flatMap((e) => {
		const [x, y, ...more] = e.kind === "op" && nativeOp(e.op)?.fn === "eq" ? e.args : []
		if (x === undefined || y === undefined || more.length > 0) {
			return []
		}
		const columnAtValue = (
			column: ScalarExpr,
			value: ScalarExpr
		): ReadonlyArray<{ readonly column: string; readonly value: ScalarExpr }> =>
			column.kind === "column" &&
			column.column.node === filter.input.id &&
			value.deps.nodes.length === 0
				? [{ column: column.column.name, value }]
				: []
		return [...columnAtValue(x, y), ...columnAtValue(y, x)]
	})

/** The columns of a filter's input it keeps at values (valueFixings). */
const valueEqualities = (filter: NodeOf<"Filter">): ReadonlyArray<string> =>
	valueFixings(filter).map((f) => f.column)

/**
 * The policy's decision for every node of a DAG it computes as a CTE, in topological order: a node read more than
 * once, and, in a workload's read (`reads`), a node read once per row of another (readPerRow); and the evaluation of
 * each call whose evaluation's query holds one of them (CtePlan `evaluations`).
 */
const ctePlan = (
	dag: ValidDag,
	reads: CteSubject
): {
	readonly decided: ReadonlyArray<Decided>
	readonly evaluations: Readonly<Record<NodeId, NodeId>>
} => {
	const d = analyzeDemand(dag, noPins)
	const scopes = nodeScopes()
	const labels = nodesByLabel(dag)
	const feedback = feedbackReadsOf(nodeGraph, d.order)
	const perRow = reads === "query" ? readPerRow(d.order) : new Set<RelNode>()
	const evaluations = evaluationsOf(d.order)
	const holder = holderOf(d.order, evaluations, new Set(dag.roots), (node) => scopes.of(node).outer)
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
			const held = cost === "scan" ? undefined : holder(node, references)
			decision =
				held === undefined
					? decide("inline", "correlated", statementScope)
					: decide("materialized", "sharedCorrelated", { kind: "held", holder: held.id })
		} else if (cost === "scan") {
			decision = decide("inline", "cheapScan", statementScope)
		} else if (perRow.has(node)) {
			decision = decide("materialized", "readPerRow", statementScope)
		} else if (cost === "expensive") {
			decision = decide("materialized", "sharedExpensive", statementScope)
		} else if (restrictedByValues(node)) {
			decision = decide("materialized", "sharedRestricted", statementScope)
		} else {
			decision = decide("notMaterialized", "sharedJoin", statementScope)
		}
		decided.push({ node, decision })
	}
	const holders = new Set(
		decided.flatMap(({ decision }) =>
			decision.scope.kind === "held" ? [decision.scope.holder] : []
		)
	)
	const held: Record<NodeId, NodeId> = {}
	for (const [call, evaluation] of evaluations) {
		if (holders.has(evaluation.id)) {
			held[call.id] = evaluation.id
		}
	}
	return { decided, evaluations: held }
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
 * A call's evaluation, the other holder of rule 3b beside a region: the calls of one function at one argument tuple,
 * the very argument nodes and expressions, a declared function's rows or the reads of fields of its one row, which the
 * lowering evaluates once in a query of its own (lower/conservative/call evaluationQuery, or the read that evaluates it
 * itself), wherever a host places that query: the statement's WITH, its parent's rows' CTE, a region's LATERAL item.
 * That query's WITH holds what its arguments share; `id` names it, its first call's label.
 */
interface Evaluation {
	readonly kind: "evaluation"
	readonly id: NodeId
	readonly calls: NonEmptyReadonlyArray<NodeOf<"Call">>
}

/** Where a shared correlated node's CTE stands (rule 3b): a region's SELECT, or a call's evaluation's query. */
type Holder = NodeOf<"MatchRegion"> | Evaluation

/** A vertex of the readers' graph holders are found in: a node, or an evaluation its calls read their arguments in. */
type Vertex = RelNode | Evaluation

/**
 * The evaluation of each call of a declared function or a field of one in `order` (Evaluation): the calls of one
 * function, by name, at the same argument nodes and expressions, each told apart by the object, are one evaluation; a
 * split or a series, grizzle's own, is evaluated where it is read.
 */
const evaluationsOf = (order: ReadonlyArray<RelNode>): ReadonlyMap<RelNode, Evaluation> => {
	const numbers = new Map<object, number>()
	const numberOf = (o: object): number => numbers.getOrInsertComputed(o, () => numbers.size)
	const groups = new Map<string, Array<NodeOf<"Call">>>()
	for (const node of order) {
		if (node.kind !== "Call") {
			continue
		}
		const fn = node.function
		if (fn.kind === "split" || fn.kind === "series") {
			continue
		}
		const args = node.args.map((a) => numberOf(a.kind === "rows" ? a.rows : a.expr))
		groups.getOrInsertComputed(`${fn.name} ${args.join(" ")}`, () => []).push(node)
	}
	const out = new Map<RelNode, Evaluation>()
	for (const calls of groups.values()) {
		const [first, ...rest] = calls
		if (first !== undefined) {
			const evaluation: Evaluation = { kind: "evaluation", id: first.id, calls: [first, ...rest] }
			for (const call of calls) {
				out.set(call, evaluation)
			}
		}
	}
	return out
}

/**
 * The holder whose query holds a shared correlated node's CTE (rule 3b), where `references`, the node's reads, are all
 * occurrences of regions and no expression reads it: the outermost holder on the node's chain of dominators, the
 * vertices every path from a root to it passes through (grizzle-text base/graph.ts immediateDominators, the DAG's roots
 * `roots` each reached directly whatever reads it too), whose query sees every value the node reads of an outer row
 * (`outer`, the node's outer references by label), and that every call's evaluation enclosing a read of the node
 * encloses too, or is. A holder is a region (`filteredRegion`), whose SELECT sees each value its correlation brings in
 * from outside and every column of a node outside it, or a call's evaluation (Evaluation), whose query sees what its
 * calls read from outside them; and an evaluation is a boundary, its query placed wherever its host stands, so nothing
 * its arguments read stands outside it but in the statement's WITH: edullm's decideStage read-back evaluated
 * attempt_marks_of for each sitting key, LATERAL in its parent's rows' CTE, and the latest attempt of each session of
 * the sitting's stage, a fold its 16 rows arguments read 162 times, was spelled at each read, 466 MB of planning where
 * one CTE in the evaluation's query computes it once per sitting.
 *
 * Dominating every read, the holder's query encloses each read's spelling, so the node is spelled and planned once
 * there and computed once per row the query is read for, each occurrence a join of its rows; every vertex between it
 * and the node sees what the node reads, and none outside it sees a value its own rows bind. A node that reads no outer
 * value, correlated only by a reader's expression that reads its columns laterally, stands in the first holder, since
 * no value it reads bounds how far out it would stand. A rule statement's import its rule's unfolding reads more than
 * once (analysis/theory/navigate.ts sharedImports) is one, each read a match of the rule itself; and so is the import
 * each rule of a union reads at the values its importer bound (check/checker.ts #bindValue), the raw column of the unit
 * or of a region outside them, every rule of the union a region of its own, held by the region every read lies inside
 * below the one whose rows bind those values, where no SELECT the rules share sees them; inlined at each read, a chain
 * of such definitions multiplied the statement at every level, and a chain of unions by their rules at every level.
 * None for any other node, which stays inlined (rule 3).
 *
 * The readers' graph has an evaluation read by its calls and reading their arguments; each vertex's enclosing
 * evaluations, those its readers lie in or are, are worked out once, readers first.
 */
const holderOf = (
	order: ReadonlyArray<RelNode>,
	evaluations: ReadonlyMap<RelNode, Evaluation>,
	roots: ReadonlySet<RelNode>,
	outer: (node: RelNode) => OuterRefs
): ((node: RelNode, references: number) => Holder | undefined) => {
	const readers = new Map<Vertex, Array<Vertex>>()
	/** The vertices, readers first: each evaluation after its last call, before their arguments. */
	const vertices: Array<Vertex> = []
	const callsLeft = new Map<Evaluation, number>()
	for (const n of order) {
		const evaluation = evaluations.get(n)
		for (const input of inputsOf(n)) {
			readers.getOrInsertComputed(input, () => []).push(evaluation ?? n)
		}
		if (evaluation !== undefined) {
			readers.getOrInsertComputed(evaluation, () => []).push(n)
			callsLeft.set(evaluation, (callsLeft.get(evaluation) ?? 0) + 1)
		}
	}
	for (const n of order.toReversed()) {
		vertices.push(n)
		const evaluation = evaluations.get(n)
		const left = evaluation === undefined ? undefined : (callsLeft.get(evaluation) ?? 0) - 1
		if (evaluation !== undefined && left !== undefined) {
			callsLeft.set(evaluation, left)
			if (left === 0) {
				vertices.push(evaluation)
			}
		}
	}
	const readersOf = (v: Vertex): ReadonlyArray<Vertex> => readers.get(v) ?? []
	const dominator = immediateDominators(
		vertices.toReversed(),
		readersOf,
		(v) => v.kind !== "evaluation" && roots.has(v)
	)
	const noEvaluation: ReadonlySet<Evaluation> = new Set()
	const enclosing = new Map<Vertex, ReadonlySet<Evaluation>>()
	/** The evaluations a read by `reader` lies in: the reader's own, and the reader itself where it is one. */
	const within = (reader: Vertex): ReadonlySet<Evaluation> => {
		const around = defined(enclosing.get(reader), "a reader's evaluations, worked out first")
		return reader.kind === "evaluation" ? new Set([...around, reader]) : around
	}
	for (const v of vertices) {
		const lying = readersOf(v).map(within)
		const [one, ...others] = lying
		enclosing.set(
			v,
			one === undefined
				? noEvaluation
				: others.every((o) => o === one)
					? one
					: new Set(lying.flatMap((o) => [...o]))
		)
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
	/** Whether an evaluation's query sees every value of `read`: each one its calls read from outside them. */
	const evaluationSees = (evaluation: Evaluation, read: OuterRefs): boolean => {
		const around = outer(evaluation.calls[0])
		return [...read.keys()].every((id) => around.has(id))
	}
	/**
	 * The evaluation that holds a node some of whose reads lie inside a call's evaluation (`lies`, each evaluation a read
	 * lies in): the innermost of them, which every other encloses, its query holding the node's CTE where it sees every
	 * value the node reads, each read inside it one join of that CTE's rows; a read outside it finds no table of it open
	 * and reads the node where it stands (lower/shapes ShapeState withHeldCtes). An evaluation is a boundary, its query
	 * placed wherever its host stands, so a node read inside it is held by it or by none, never by a holder outside it.
	 * None where the reads lie in evaluations no one of which the others enclose, or the innermost's query sees not every
	 * value the node reads. edullm's decideStage read-back reads the latest attempt of each session of the sitting's
	 * stage in each of attempt_marks_of's rows arguments, 160 reads inside the call's one evaluation, and in each mark
	 * read's own rule beside the call, 5 reads outside it, where no holder dominates every read.
	 */
	const evaluationOf = (lies: ReadonlySet<Evaluation>, read: OuterRefs): Evaluation | undefined => {
		const innermost = [...lies].find((e) => {
			const around = defined(enclosing.get(e), "an evaluation's evaluations, worked out")
			return [...lies].every((other) => other === e || around.has(other))
		})
		return innermost !== undefined && evaluationSees(innermost, read) ? innermost : undefined
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
		const lies = defined(enclosing.get(node), "the node's evaluations, worked out")
		if (lies.size > 0) {
			return evaluationOf(lies, read)
		}
		let held: NodeOf<"MatchRegion"> | undefined
		for (let at = dominator(node); at !== undefined; at = dominator(at)) {
			if (at.kind === "evaluation") {
				continue
			}
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
 *    the query of the outermost holder that lies on every path to it and sees every outer value it reads (holderOf): a
 *    region's SELECT, which sees its correlated values and the columns of nodes outside it, or a call's evaluation's
 *    query, which sees what the call reads from outside it, and never a holder outside an evaluation that encloses a
 *    read of it, whose host places it anywhere; spelled and planned once, computed once per row that query is read
 *    for, each occurrence a join of its rows. A rule statement's import its rule's unfolding reads more than once is
 *    one (analysis/theory/navigate.ts sharedImports), and so is the import each rule of a union reads at the unit's
 *    channels (check/checker.ts #sharedImport), held by the region below the unit's every read lies in; inlined at
 *    each read, a chain of such definitions multiplied the statement at every level, and a chain of unions by their
 *    rules at every level; and so is a fold a call's rows arguments each read at the call's parent row, held by the
 *    call's evaluation, computed once per parent row (edullm's decideStage read-back, 162 reads).
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
 * 5c. Magic sets: a union, a fold or a join a statement reads is computed at its reads' keys alone
 *    (lower/shapes/share/keys.ts KeyAnalysis), each read a site of one of two kinds. A site read once per row of a
 *    driver, an attachment's child per parent key (attachmentRead `perKey`), is lowered there at that row's values,
 *    each carried into the nodes under it that read them (keys.ts restrictionWalk), a fold's keys below its aggregate,
 *    a union's in each arm, a region's chain led by the relation its key binds on the longest declared-key prefix
 *    (keyedRegionChain), never read from a CTE, which no index reads: each per-key read is a seek of each relation at a
 *    prefix of one of its keys, its rows that key's alone. Every other site reads one evaluation of the node at the
 *    DISTINCT union of their keys, the key set a MATERIALIZED DISTINCT CTE of the statement and the node LATERAL per
 *    key (lower/shapes dispatchIn, share/keyed.ts KeyedLowering), each arm at it or the key below its aggregate; a site
 *    read per row adds no key to it, so a fold a head reads at its parameters and its attachment at each head row is
 *    computed at the head's keys, where the attachment's keys, the head's rows of the fold, closed a cycle no order
 *    computes first and derived it whole (edullm's latest decision, ~176k buffers a call for any child). PostgreSQL
 *    moves no restriction into a UNION's arms or below a grouping, so one evaluation of either for the statement read
 *    every row of its arms or its input (learning-commons' crosswalk, two counts of one standard's supports, each a
 *    read of one shared fold). A child no declared-key prefix binds at its correlation, which a read per key would read
 *    other keys' rows of, is derived once and co-grouped with its parents' keys by one GROUP BY (attachmentRead
 *    `coGroup`, lower/shapes/attach coGroupedRows), never joined beside them.
 * 5. A node that folds, sorts, bounds, deduplicates a set operation or recurses is expensive. Shared, it is
 *    MATERIALIZED: one evaluation feeds every use.
 * 5d. A shared join the statement's own values restrict (restrictedByValues: every occurrence reached from a
 *    parameter or a set the call passes in) is MATERIALIZED: what rule 6 keeps a join inline for, each use's
 *    restriction pushed into it so none derives it whole, its own values already give it, so one evaluation derives
 *    only the rows every use restricts it to, and PostgreSQL plans its sources once, where each inlined use planned
 *    them again inside its consumer's join (edullm's answerTestItem: the answered member's item session and controls,
 *    seven relations at the call's parameters, restated by each arm of its admission's arguments).
 * 6. Any other shared node, a join of several sources no value of the statement restricts, is NOT MATERIALIZED:
 *    PostgreSQL may optimize each use jointly with its consumer, each use's restriction pushed into it, and the
 *    boundary stays a program boundary rather than a forced fence; derived once, it would be derived whole.
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
			const { decided, evaluations } = ctePlan(query.dag, reads)
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
			return { ...query, cte: { decisions, evaluations } }
		})
})
