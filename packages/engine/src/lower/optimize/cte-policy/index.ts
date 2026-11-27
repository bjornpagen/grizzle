import { immediateDominators, postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { analyzeDemand, noPins } from "#compiler/analysis/demand/demand.ts"
import type { Realization } from "#compiler/analysis/physical/props.ts"
import { outerOf } from "#compiler/analysis/physical/rules.ts"
import { catchRefusal, maxStringLength, unwrap } from "#compiler/core/canonical.ts"
import type { NodeId, VarId } from "#compiler/core/ids.ts"
import {
	type CertificateRule,
	localCertificate,
	makeCertificate
} from "#compiler/ir/certificate.ts"
import { DagTemplates, ShareKeys } from "#compiler/ir/dag-digest.ts"
import {
	type NodeScope,
	freeVars,
	nodeScopes,
	nodesByLabel,
	type OuterRefs
} from "#compiler/ir/dag.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { Fold } from "#compiler/ir/fold.ts"
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
import { baseOf, fewValued, type ScalarType } from "#compiler/ir/scalar.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import { feedbackReadsOf, nodeGraph } from "#compiler/lower/optimize/demand/editor.ts"
import { roots as regionRoots } from "#compiler/lower/optimize/demand/restriction.ts"
import { inPartition } from "#compiler/lower/shapes/take/partition.ts"
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
	| "sharedWhole"
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
	 * The label of the first of the copies the decision is one for (copyClasses), the node's own where it is no copy:
	 * every copy reads the one CTE defined for this label.
	 */
	readonly copies: NodeId
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

/** The kinds a closed derivation is built of: a closed relation, and each stage whose rows are its inputs' alone. */
const closedKinds: ReadonlySet<RelKind> = new Set<RelKind>([
	"Closed",
	"MatchRegion",
	"Filter",
	"Step",
	"ProjectSet",
	"SemiJoin",
	"AntiJoin",
	"Union",
	"Intersect",
	"Difference",
	"Group",
	"Window",
	"OrderedSetAggregate",
	"Take",
	"OrderedResult"
])

/**
 * What a node's rows are as constants (constancyOf): `closed`, a derivation of closed relations alone (closedKinds) that
 * reads the rows of at least one, which a VALUES list prints (lower/conservative/closed); `constant`, a derivation of no
 * closed relation's rows, the one row of a region of no occurrence, a closed relation of no row and what a filter, a
 * projection or a set operation makes of them, a constant printed in a few bytes that PostgreSQL folds wherever it
 * stands; `open`, a node that reads a stored relation, a parameter, an outer row or a set a call or a write passes in.
 */
type Constancy = "closed" | "constant" | "open"

/** Each node's constancy (constancyOf), for as long as the node lives. */
const constancies = new WeakMap<RelNode, Constancy>()

/** The constancy of a node (Constancy), each node's folded once from its inputs'. */
const constancyOf = (root: RelNode): Constancy => {
	const known = constancies.get(root)
	if (known !== undefined) {
		return known
	}
	for (const node of postorder([root], (n) =>
		inputsOf(n).filter((input) => !constancies.has(input))
	)) {
		const inputs = inputsOf(node).map((input) =>
			defined(constancies.get(input), "an input's constancy, met before its reader in postorder")
		)
		constancies.set(
			node,
			!closedKinds.has(node.kind) ||
				node.meta.paramDeps.length > 0 ||
				node.meta.reads.length > 0 ||
				outerOf(node).length > 0 ||
				inputs.includes("open")
				? "open"
				: (node.kind === "Closed" && node.rows.length > 0) || inputs.includes("closed")
					? "closed"
					: "constant"
		)
	}
	return defined(constancies.get(root), "the constancy of the node asked")
}

/**
 * Whether a node's rows are constants (Constancy `closed` or `constant`): a derivation of closed relations alone,
 * reading no stored relation, no parameter, no outer row and no set a call or a write passes in, so every read of it
 * reads the same rows, whole, wherever it stands, and no index of any read's finds them. A closed derivation that reads
 * a closed relation (Constancy `closed`) read at two sites or more is computed once, a MATERIALIZED CTE each site reads
 * (rule 3c, readWhole), where inlined at each it was printed, parsed and planned at each: edullm's decideTest printed a
 * closed relation of 49 KB four times and the processing calls' arguments built of it, 210 KB, twice.
 */
export const closedDerivation = (node: RelNode): boolean => constancyOf(node) !== "open"

/**
 * Whether a node's rows are proved empty where its DAG stands: a closed relation of no row, which the simplifier makes
 * of every relation it proves empty (lower/optimize/simplify `empty`), and each stage of one that keeps rows of its
 * input alone, a region one of whose sources is such, a union whose every arm is, a fold by keys over one. A fold of no
 * key over no row is one row, its aggregates' empty values, so it is none. A reader that reads such a node whole reads
 * no row of it, which it states as a value (a call's rows argument, the empty array) and derives nothing.
 */
export const provedEmpty = (node: RelNode): boolean => {
	switch (node.kind) {
		case "Closed":
			return node.rows.length === 0
		case "ProjectSet":
		case "Filter":
		case "Step":
		case "Take":
		case "OrderedResult":
		case "Window":
			return provedEmpty(node.input)
		case "Group":
			return node.keys.length > 0 && provedEmpty(node.input)
		case "SemiJoin":
			return provedEmpty(node.left) || provedEmpty(node.right)
		case "AntiJoin":
		case "Difference":
			return provedEmpty(node.left)
		case "Intersect":
			return provedEmpty(node.left) || provedEmpty(node.right)
		case "Union":
			return unionArms(node.groups).every(provedEmpty)
		case "MatchRegion":
			return node.occurrences.some((o) => provedEmpty(o.source))
		case "Base":
		case "Context":
		case "InputSet":
		case "Delta":
		case "Recursive":
		case "SelfRef":
		case "Produce":
		case "Attach":
		case "Forbid":
		case "OrderedSetAggregate":
		case "ApproximateNearest":
		case "Call":
			return false
	}
}

/**
 * Whether every read of a node computes it whole, apart from its reader, whatever the reader restricts: a derivation of
 * closed relations that reads one (Constancy `closed`), whose rows are constants no index of any read's finds; a step,
 * which every lowering reads apart (lower/conservative/step), so no read's restriction enters it; a node its placement
 * realizes behind a DISTINCT (lower/optimize/dedup, `realization`), which PostgreSQL never pulls up into a reader, so no
 * join of a reader's enters it either, computing the set whole at each read; and a node the statement's values fix at
 * one row at most (fixedByValues), which no reader narrows further. Such a node read at two sites or more is computed
 * once, a MATERIALIZED CTE each site reads (rule 3c), where inlined at each it was computed at each, and printed, parsed
 * and planned at each: edullm's decideTest read one navigation's first step, the item's root at the call's parameters,
 * in each of 18 rules' chains, 18 copies of 1.6 KB. A constant (Constancy `constant`) is none, a closed relation of no
 * row among them: printed in a few bytes and folded where it stands, by PostgreSQL wherever it reads one and by a call
 * as the empty array of its rows argument (lower/conservative/call provedEmpty), a CTE of its own would only add to the
 * statement's entries, each one PostgreSQL's planner pays for, and one of no row no plan could prove empty:
 * evaluation-core's empty arguments, each a filter of no row over a region of no occurrence, read by three arguments,
 * and that region's one row read beside them, were two MATERIALIZED CTEs of the statement.
 */
export const readWhole = (node: RelNode, realization: (node: RelNode) => Realization): boolean => {
	const constancy = constancyOf(node)
	return (
		(node.kind === "Step" ||
			realization(node) === "distinct" ||
			constancy === "closed" ||
			fixedByValues(node)) &&
		constancy !== "constant"
	)
}

/**
 * Whether the statement's own values fix a node at one row at most (restrictedByValues, its cardinality by its key at
 * those values), reading no outer row: no reader narrows its rows further, so rule 4's reason, each use probing the
 * source's indexes with its own restrictions, holds for none of its reads, and each read inlined derives the same row
 * again. edullm's recordAttempt read-backs read the answered item session, ItemSession at the call's four parameters, at
 * 102 sites of each statement.
 */
const fixedByValues = (node: RelNode): boolean =>
	node.meta.card !== "many" && outerOf(node).length === 0 && restrictedByValues(node)

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
 * projections of columns, every arm of a union and a fold's grouping columns, to a stored or given relation; in a
 * region, each column a variable some occurrence binds whose source the column restricts so, PostgreSQL carrying a fixed
 * value through the region's equalities to every occurrence that binds it: no fixed value stops at a fold's aggregate, a
 * bound, a window or a recursion, past which PostgreSQL derives the rows whole for each value (an existence test's right
 * side read per left row, lower/conservative/semi-join/exists.ts).
 */
const restrictedByKeys = (node: RelNode, columns: ReadonlyArray<string>): boolean => {
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

/** Whether an expression a region holds reads an outer row: a node, every one outside the region, one value for each evaluation. */
const readsOuterRow = (region: NodeOf<"MatchRegion">, e: ScalarExpr): boolean =>
	e.deps.nodes.length > 0 && e.deps.nodes.every((n) => n !== region.id)

/**
 * Whether an expression a region holds is a value fixed where the region is evaluated: a parameter or an outer row's
 * column (`readsOuterRow`), and no column of the region, one value for each evaluation as a parameter is one for the
 * statement. A literal alone is none: a closed code every key's rows share.
 */
const heldFixed = (region: NodeOf<"MatchRegion">, e: ScalarExpr): boolean =>
	(e.deps.params.length > 0 || e.deps.nodes.length > 0) &&
	e.deps.nodes.every((n) => n !== region.id)

/**
 * Whether a type is a code's (ir/scalar.ts fewValued): a closed id, one of a roster's handles, or a boolean. A column of
 * one holds few values, each every unit's rows share, so a value of it, whatever its source (a literal, a parameter, a
 * closed row's column), identifies no unit's rows: it extends a key's prefix, and starts none (boundPrefix).
 */
const codeTyped = (type: ScalarType): boolean => fewValued[baseOf(type).carrier]

/** The type of a column of a node's heading. */
const columnTypeOf = (node: RelNode, column: string): ScalarType | undefined =>
	node.heading.find((h) => h.name === column)?.type

/**
 * Whether a region holds a column at a value fixed where it is evaluated (`heldFixed`): an occurrence's constant, or a
 * correlation, at one, which a chain of the region reads its source at (keyedRegionChain).
 */
export const holdsFixedValue = (region: NodeOf<"MatchRegion">): boolean =>
	region.occurrences.some((o) => o.constants.some((k) => heldFixed(region, k.expr))) ||
	region.correlated.some((c) => heldFixed(region, c.expr))

/**
 * Whether a region is evaluated once for each row of what reads it: it holds a value an outer row fixes
 * (`readsOuterRow`), an occurrence's constant or a correlation, so it stands LATERAL to that row, as a navigation's step
 * reads the row before it (ir/rel.ts Step). What it reads beside its steps is read again at each evaluation: a set its
 * statement computes once and it joins is scanned whole at each, as no index reads it, so its row sites are read at
 * each row's values (share/sites.ts sitesAtRows).
 */
export const evaluatedPerRow = (region: NodeOf<"MatchRegion">): boolean =>
	region.occurrences.some((o) => o.constants.some((k) => readsOuterRow(region, k.expr))) ||
	region.correlated.some((c) => readsOuterRow(region, c.expr))

/**
 * The variables a region holds at values fixed where it is evaluated (`heldFixed`), none of a code's type
 * (`codeTyped`): each bound to a column an occurrence's constant holds at such a value, and each its correlation equates
 * to one. A chain of the region binds them from its start (keyedRegionChain), as a restriction's columns.
 */
export const fixedVariables = (region: NodeOf<"MatchRegion">): ReadonlyArray<string> => [
	...new Set([
		...region.occurrences.flatMap((o) =>
			o.constants.flatMap((k) =>
				heldFixed(region, k.expr)
					? o.bindings.flatMap((b) =>
							b.column === k.column && !codeTyped(b.var.type) ? [b.var.name] : []
						)
					: []
			)
		),
		...region.correlated.flatMap((c) =>
			heldFixed(region, c.expr) && !codeTyped(c.var.type) ? [c.var.name] : []
		)
	])
]

/**
 * The fields of a stored relation `bound` and `constant` hold, each closed under the dependencies its fields hold
 * (ir/keys.ts ContainedDependency, rel.ts Base determined): an ordinary relation's, its declared containments give it,
 * and a view's, its definition draws its columns from a relation whose key determines them. A dependency whose `by` they
 * hold holds every field it determines, bound where `by` holds a bound field, a constant where it holds constants alone.
 */
const closedUnder = (
	base: NodeOf<"Base">,
	bound: ReadonlySet<string>,
	constant: ReadonlySet<string>
): { readonly bound: ReadonlySet<string>; readonly constant: ReadonlySet<string> } => {
	const determined = base.determined
	const b = new Set(bound)
	const c = new Set(constant)
	for (let grew = true; grew;) {
		grew = false
		for (const d of determined) {
			if (!d.by.every((f) => b.has(f) || c.has(f))) {
				continue
			}
			const into = d.by.some((f) => b.has(f)) ? b : c
			for (const f of d.fields) {
				if (!b.has(f) && !c.has(f)) {
					into.add(f)
					grew = true
				}
			}
		}
	}
	return { bound: b, constant: c }
}

/**
 * The length of the longest prefix of one of a stored relation's declared keys (its primary key, then each other in
 * declared order) whose every column is bound, by `bound` or by a constant, holding at least one `bound` column, each
 * set closed under the dependencies its containments give it (`closedUnder`): the rows a seek at such a prefix reads
 * share the key's own value, never another's, whether the read binds the key's columns or fields that determine them
 * (an attempt's number, which its assignment's key names, holds its child); 0 where no such prefix stands. A prefix of
 * constants alone is none: its rows are every key value's. The seek itself lands on an index whose leading columns are
 * the columns the read binds (physical/indexes), which a field a dependency determines need not lead.
 */
const boundPrefix = (
	base: NodeOf<"Base">,
	held: ReadonlySet<string>,
	constants: ReadonlySet<string>
): number => {
	const { bound, constant } = closedUnder(base, held, constants)
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
 * Whether a stored relation's unit key (rel.ts StoredBase unit) is among `bound`: its rows there are one unit's.
 */
const coversUnit = (base: NodeOf<"Base">, bound: ReadonlySet<string>): boolean =>
	base.relationKind === "relation" && base.unit.length > 0 && base.unit.every((f) => bound.has(f))

/**
 * Whether fixing each of `columns` of `node` holds every stored relation its rows read at one unit's rows, as
 * keyPrefixBound holds them at a key's: a stored relation whose unit key the columns determine, through the dependencies
 * its containments give it (closedUnder); a union's every arm; a projection's, a filter's, a step's input at the columns
 * it keeps; a fold's input at its grouping keys among them; an existence test's left side; an attachment's parent; a
 * region with an occurrence of a stored relation so held at the classes the columns bind. A fold of a learner's
 * attempts narrowed to their stage is one learner's rows, as the learner's attempts are.
 */
const unitBound = (node: RelNode, columns: ReadonlyArray<string>): boolean => {
	if (columns.length === 0) {
		return false
	}
	switch (node.kind) {
		case "Base":
			return coversUnit(node, closedUnder(node, new Set(columns), new Set()).bound)
		case "Union":
			return unionArms(node.groups).every((arm) => unitBound(arm, columns))
		case "ProjectSet": {
			const read = columns.flatMap((c) => {
				const e = node.out.find((o) => o.name === c)?.expr
				return e?.kind === "column" && e.column.node === node.input.id ? [e.column.name] : []
			})
			return unitBound(node.input, read)
		}
		case "Group":
			return unitBound(
				node.input,
				columns.filter((c) => node.keys.includes(c))
			)
		case "Step":
		case "Filter":
			return unitBound(node.input, columns)
		case "SemiJoin":
		case "AntiJoin":
			return unitBound(node.left, columns)
		case "Attach":
			return unitBound(node.parent, columns)
		case "MatchRegion": {
			const classOf = regionVarClasses(node)
			const held = new Set(
				columns.flatMap((c) => node.vars.filter((v) => v.name === c).map((v) => classOf(v)))
			)
			return node.occurrences.some(
				(o) =>
					o.source.kind === "Base" &&
					coversUnit(
						o.source,
						closedUnder(
							o.source,
							new Set(o.bindings.flatMap((b) => (held.has(classOf(b.var)) ? [b.column] : []))),
							new Set()
						).bound
					)
			)
		}
		case "ApproximateNearest":
		case "Call":
		case "Closed":
		case "Context":
		case "Delta":
		case "Difference":
		case "Forbid":
		case "InputSet":
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

/**
 * What a chain's step reads (keyedRegionChain), each rank's rows a bound the declared facts prove: `key`, the bound
 * fields cover a declared key, its own or one the dependencies its containments give it determine, at most one row, a
 * descent of the key's index, its height in pages; `held`, a set the call or the statement passes in (`passedIn`: the
 * call's input, a delta, the session's context, a closed relation's rows), the call's own k rows, which the call pays
 * for, so a chain led by it costs k seeks, the O(k log n) a call's writes are bound by; `unit`, they determine its unit's
 * key, one unit's rows, a descent
 * and the pages of that unit's rows, however many units the store holds; `prefix`, any other, the rows of a key's
 * prefix, which grow with the store where the prefix names no unit (an assignment's test, which every learner's
 * assignments name, or a code); `cross`, a stored relation the region equates to no other occurrence and binds at no
 * value, read whole for each row before it in every lowering of the region, since no equality leaves a seek or a hash
 * that reads it at a value: read per key, it costs each key's rows before it times its own, never more than the region
 * read whole and joined to every key (pantry's listedMedia, every media type tested by its suffix against each media
 * path), so it continues a chain and starts none; `whole`, the root of a region nothing else binds (rootChain), every row
 * of it read where it stands, the rest at the keys its rows bind, so the region's rows are the root's, each with one row
 * of every other occurrence beside it: it starts a chain only where nothing else can.
 */
export type Rank = "key" | "held" | "unit" | "prefix" | "cross" | "whole"

const rankOrder: Readonly<Record<Rank, number>> = {
	key: 0,
	held: 1,
	unit: 2,
	prefix: 3,
	cross: 4,
	whole: 5
}

/**
 * Whether a source is a set the call or the statement passes in (Rank `held`): the call's input, a delta, the session's
 * context or a closed relation's rows, none of the store's, as many as the call itself holds.
 */
const passedIn = (node: RelNode): boolean =>
	node.kind === "InputSet" ||
	node.kind === "Delta" ||
	node.kind === "Context" ||
	node.kind === "Closed"

/**
 * How an occurrence is bound where a chain reaches it (keyedRegionChain): its `rank`; `length`, the declared-key prefix
 * its read is proved at, a stored relation's longest bound one (boundPrefix), any other source's the shortest of those
 * of the stored relations it reads (keyPrefixLength), one measure for both, 0 for none (a set the statement holds, or a
 * row function, half a column); and `derived`, whether its read derives its rows, a source no stored relation is,
 * which a read at a prefix computes at every row of it, where a stored relation's read is a seek of them.
 */
export interface Bound {
	readonly rank: Rank
	readonly length: number
	readonly derived: boolean
}

/**
 * Whether `a` leads `b`: the lower rank first, whatever the prefixes' lengths; within a rank, the longer prefix, so a
 * fold of a learner's attempts narrowed to their stage leads a read of the learner's every attempt, both one learner's
 * rows; at one prefix, a stored relation's seek before a derivation, whose cost at the prefix is at least that of the
 * stored rows it reads there and which the seek's bindings may bind tighter. qti-pie's session control read a test's
 * member controls, a union over the test's members, at the test (two bound columns, one key column of pantry's
 * TestMember, whose key leads with the package and the part), before the member the session's item names (one key
 * column), so each session derived its test's every member's controls; read after the member, they are its own.
 */
const leads = (a: Bound, b: Bound): boolean =>
	a.rank !== b.rank
		? rankOrder[a.rank] < rankOrder[b.rank]
		: a.length !== b.length
			? a.length > b.length
			: !a.derived && b.derived

/**
 * A region's occurrences in the order a read of it at `columns`, each fixed where it is evaluated, chains them: each
 * step the occurrence that leads (Bound, `leads`) among those bound on a declared-key prefix, a stored relation by
 * boundPrefix, each set closed under the dependencies its containments give it, any other source by keyPrefixBound,
 * ties broken by placement, the canonical order of the region's occurrences, never by an estimate; undefined where an
 * occurrence is never bound on one.
 *
 * The proof the order stands on, the declared facts alone: a step of rank `key` reads one row, of rank `unit` one unit's
 * rows, whatever the store holds beside them, each a bound in pages its rank states; a step of rank `prefix` reads a
 * prefix's rows, which may be every unit's. So the chain starts where the declared facts bound its rows tightest, and
 * each later step reads by a key the steps before it bound. A code, a roster's or a boolean's field whatever its
 * source, extends a prefix and starts none (boundPrefix's constants). metis's slot read, which PostgreSQL's estimates
 * entered by the assigned test's grade, every sitting of it, reads the user's own assignments first: the user determines
 * the assignment's learner through PersonUser's key, the learner its unit, where the grade is a catalog row's.
 */
export const keyedRegionChain = (
	region: NodeOf<"MatchRegion">,
	occurrences: ReadonlyArray<Occurrence>,
	columns: ReadonlyArray<string>
): ReadonlyArray<ChainStep> | undefined => {
	const steps = chainSteps(region, occurrences, columns)
	return steps.length === occurrences.length ? steps : undefined
}

/**
 * A step of a region's chain (keyedRegionChain): the occurrence it reads; `at`, the columns of its source the step's
 * seek binds, each column the steps before it bound and each its fixed values hold, then each column it holds at a
 * code's value, then each a literal holds, the columns an index for the seek leads with in that order (physical/access);
 * and how it is bound there (Bound), its rank over `at` closed under its containments' dependencies, which the seek
 * itself binds only `at` of.
 */
export interface ChainStep {
	readonly occurrence: Occurrence
	readonly at: ReadonlyArray<string>
	readonly bound: Bound
}

/**
 * The steps of the chain over `occurrences`, some or all of a region's, read at `columns` (keyedRegionChain), as far as
 * each next occurrence is bound on a declared-key prefix: every one of them where the chain is whole, fewer where one
 * is never bound. A chain over some of a region's occurrences reads the others' variables as unbound, unless `columns`
 * names them: a page's value set, the region's occurrences but the window's driver, chained from its fixed values
 * (lower/shapes/page).
 */
export const chainSteps = (
	region: NodeOf<"MatchRegion">,
	occurrences: ReadonlyArray<Occurrence>,
	columns: ReadonlyArray<string>
): ReadonlyArray<ChainStep> => {
	const classOf = regionVarClasses(region)
	return extendedChain(
		region,
		occurrences,
		new Set(columns.flatMap((c) => region.vars.filter((v) => v.name === c).map((v) => classOf(v)))),
		[]
	)
}

/**
 * A region's chain over `occurrences` with nothing bound (keyedRegionChain over no columns finds none) read from its root
 * (Rank `whole`): the first occurrence in placement order that binds, through the keys of the occurrences it reaches, a
 * declared key of every other (demand/restriction.ts roots, each class the region's correlation holds bound from the
 * start), every row of it read where it stands and each other occurrence then a seek of its key at the values the steps
 * before it bind, so the region's rows are the root's, each with at most one row of every other beside it, read in
 * O(r log n) for the root's r rows, whatever PostgreSQL estimates. A region of one occurrence, or of none such, has none,
 * and PostgreSQL joins it. pantry's namingRecords, each record under a resource's metadata with its resource's type and
 * the document its `href` names, filled whole: PostgreSQL's estimates joined each record of a manifest to every typed
 * resource of it by the manifest alone, a prefix of each key every row of the manifest shares, and probed each metadata
 * element by the manifest alone after; read from the records, each metadata element, `href` and type is a seek of its key.
 */
export const rootChain = (
	region: NodeOf<"MatchRegion">,
	occurrences: ReadonlyArray<Occurrence>
): ReadonlyArray<ChainStep> | undefined => {
	if (occurrences.length < 2) {
		return undefined
	}
	const classOf = regionVarClasses(region)
	const keyedAt = (at: number, columns: ReadonlyArray<string>): boolean => {
		const o = occurrences[at]
		const source = o?.source
		if (o === undefined || source?.kind !== "Base") {
			return false
		}
		const closed = closedUnder(source, new Set(columns), new Set(o.constants.map((c) => c.column)))
		return [source.primaryKey, ...source.keys].some(
			(k) =>
				k.some((f) => closed.bound.has(f)) &&
				k.every((f) => closed.bound.has(f) || closed.constant.has(f))
		)
	}
	const [root] = regionRoots({ ...region, occurrences }, keyedAt)
	const lead = root === undefined ? undefined : occurrences[root]
	if (lead === undefined) {
		return undefined
	}
	const steps = extendedChain(
		region,
		occurrences.filter((o) => o !== lead),
		new Set([
			...region.correlated.map((c) => classOf(c.var)),
			...lead.bindings.map((b) => classOf(b.var))
		]),
		[
			{
				occurrence: lead,
				at: [],
				bound: { rank: "whole", length: 0, derived: lead.source.kind !== "Base" }
			}
		]
	)
	return steps.length === occurrences.length && steps.slice(1).every((s) => s.bound.rank === "key")
		? steps
		: undefined
}

/**
 * The chain `chain` extended over `occurrences`, those it has not read, each next one the occurrence that leads (Bound,
 * `leads`) among those bound on a declared-key prefix by the classes `bound` holds and every class a step before it
 * binds (chainSteps), as far as one is.
 */
const extendedChain = (
	region: NodeOf<"MatchRegion">,
	occurrences: ReadonlyArray<Occurrence>,
	bound: Set<VarId>,
	chain: Array<ChainStep>
): ReadonlyArray<ChainStep> => {
	const classOf = regionVarClasses(region)
	const pending = [...occurrences]
	/** Whether every variable of the region a source reads from outside itself is bound. */
	const readsBound = (source: RelNode): boolean =>
		outerOf(source).every(
			(c) =>
				c.node !== region.id ||
				region.vars.some((v) => v.name === c.column && bound.has(classOf(v)))
		)
	const none: Bound = { rank: "prefix", length: 0, derived: false }
	/**
	 * Whether no equality joins `o` to anything the region reads beside it (Rank `cross`): no variable it binds is one
	 * class with a variable another occurrence binds, a column the read restricts or a value the region fixes.
	 */
	const equatesNone = (o: Occurrence): boolean =>
		o.bindings.every(
			(b) =>
				!bound.has(classOf(b.var)) &&
				region.occurrences.every(
					(q) => q === o || q.bindings.every((c) => classOf(c.var) !== classOf(b.var))
				)
		)
	/**
	 * How `o` is bound now (Bound): a stored relation on its longest bound declared-key prefix (boundPrefix), each column
	 * of a code's type a constant, ranked by the key or the unit key its bound fields determine; any other source where
	 * its bound columns prove it, on the shortest prefix they bind of the stored relations it reads (keyPrefixLength),
	 * ranked `unit` where they hold every stored relation it reads at one unit's rows (unitBound); a held set whose own
	 * values bind a declared key of every stored relation each of its arms leads with (`leadOf` `key`), ranked `key`, a row
	 * of each arm, so it leads a stored relation the values bind at its unit alone and is read first: edullm's
	 * AttemptValueAt, an attempt's values instant, two rules each at the attempt's key by the call's values, leads the values
	 * recorded at its instant, each then a seek of (learner, instant), where read after them every value of the learner was
	 * read at the learner alone; any other source whose seek holds one of its keys (MetaSpec logicalKeys, a fold's
	 * grouping columns among them), ranked `key`, at most one row of it at each binding, so it leads a stored relation a
	 * prefix binds, after which it was derived again for each row of the prefix at the same key: qti-pie's member
	 * controls read the nearest stated scope of a member, a fold at the member's place, after the stated attempts of every
	 * scope of its test, and derived it once for each, 350 rows for one session beside a test of 42 members, where read
	 * first it is one group and the attempts stated at its scope one seek; and below every such, a
	 * held set (`heldSet`: rows the statement's values restrict, or a closed relation's constant rows) or a row function
	 * of values, which reads no store and is evaluated per row of what it follows. A source that reads a variable of the
	 * region is bound by none of these until every variable it reads is (`readsBound`): it is evaluated per row of the
	 * steps that bind them, never before them.
	 */
	const boundOf = (
		o: Occurrence
	): { readonly at: ReadonlyArray<string>; readonly bound: Bound } => {
		const source = o.source
		const code = (column: string): boolean => {
			const type = columnTypeOf(source, column)
			return type !== undefined && codeTyped(type)
		}
		const held = [
			...o.bindings.flatMap((b) => (bound.has(classOf(b.var)) ? [b.column] : [])),
			...o.constants.flatMap((c) => (heldFixed(region, c.expr) ? [c.column] : []))
		]
		const at = held.filter((c) => !code(c))
		const constants = [
			...held.filter(code),
			...o.constants.flatMap((c) => (heldFixed(region, c.expr) ? [] : [c.column]))
		]
		const constant = new Set(constants)
		const seek = [...new Set([...at, ...constants])]
		if (source.kind === "Base" && seek.length === 0 && equatesNone(o)) {
			return { at: seek, bound: { rank: "cross", length: 0, derived: false } }
		}
		if (source.kind === "Base") {
			const closed = closedUnder(source, new Set(at), constant)
			const key = [source.primaryKey, ...source.keys].some(
				(k) =>
					k.some((f) => closed.bound.has(f)) &&
					k.every((f) => closed.bound.has(f) || closed.constant.has(f))
			)
			const unit = coversUnit(source, closed.bound)
			return {
				at: seek,
				bound: {
					rank: key ? "key" : unit ? "unit" : "prefix",
					length: boundPrefix(source, new Set(at), constant),
					derived: false
				}
			}
		}
		if (!readsBound(source)) {
			return { at: seek, bound: none }
		}
		if (passedIn(source)) {
			return { at: seek, bound: { rank: "held", length: 1, derived: false } }
		}
		if (heldSet(source) && leadOf(source) === "key") {
			return {
				at: seek,
				bound: { rank: "key", length: Math.max(1, keyPrefixLength(source, at)), derived: false }
			}
		}
		if (source.meta.logicalKeys.some((k) => k.key.every((c) => seek.includes(c)))) {
			return {
				at: seek,
				bound: {
					rank: "key",
					length: Math.max(1, keyPrefixLength(source, at)),
					derived: !heldSet(source)
				}
			}
		}
		const length = keyPrefixLength(source, at)
		if (length > 0) {
			return {
				at: seek,
				bound: {
					rank: unitBound(source, at) ? "unit" : "prefix",
					length,
					derived: !heldSet(source)
				}
			}
		}
		return {
			at: seek,
			bound:
				heldSet(source) || (source.kind === "Call" && source.args.every((a) => a.kind === "value"))
					? { rank: "prefix", length: 0.5, derived: false }
					: none
		}
	}
	while (pending.length > 0) {
		let best:
			| { readonly place: number; readonly at: ReadonlyArray<string>; readonly bound: Bound }
			| undefined
		for (const [place, o] of pending.entries()) {
			const b = boundOf(o)
			if (
				(b.bound.length > 0 || (b.bound.rank === "cross" && chain.length > 0)) &&
				(best === undefined || leads(b.bound, best.bound))
			) {
				best = { place, ...b }
			}
		}
		const [next] = best === undefined ? [] : pending.splice(best.place, 1)
		if (best === undefined || next === undefined) {
			return chain
		}
		chain.push({ occurrence: next, at: best.at, bound: best.bound })
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
 * groups that key's), a take's partition (its ranks at a key its input's rows at that key, take/partition.ts) and a
 * region's chain; a set the statement holds (a delta, the call's input or context, a closed
 * relation's rows) is read whole, none of the store's. The proof a per-key read stands on (cte-policy attachmentRead
 * `perKey`), the declared facts alone, never a reading of selectivity: a prefix of constants alone, or a value no key
 * leads with, reads every key's rows (read-once's terms, each read by its purpose's value, every package's).
 */
/**
 * A stored relation the rows before a read hold whole at `at` (`prefixOver`): at each value of those columns, every
 * row the relation holds there, read at exactly a proper prefix of one of its declared keys, at no constant, its other
 * columns bound by nothing else the rows before the read read.
 */
interface WholeAt {
	readonly base: NodeOf<"Base">
	readonly at: ReadonlyArray<string>
}

/** Whether `columns` are a proper prefix of one of `base`'s declared keys, whatever their order. */
const properKeyPrefix = (base: NodeOf<"Base">, columns: ReadonlyArray<string>): boolean =>
	columns.length > 0 &&
	[base.primaryKey, ...base.keys].some(
		(k) => columns.length < k.length && k.slice(0, columns.length).every((f) => columns.includes(f))
	)

/**
 * The columns a stored relation `read` is read at once for each of their values, a range of its declared key, where
 * read at each row of what comes before it it would descend its key once for each (the one decision, read by a
 * region's chain, `chainPrefix`, and by an attachment's child read per parent key, `attachmentPrefix`): the rows
 * before it hold a stored relation whole at a proper prefix of its key (WholeAt); `read` is bound, at each of its
 * `bound` columns, at a column of that relation (`held`), those at its prefix a prefix of one of `read`'s own declared
 * keys and the rest past it. Its rows at the prefix are then the rows every key before it reads and no other key's, one
 * descent and the range's leaf pages for each value of the prefix, the rest joined in memory; undefined for any other
 * read, read per row. metis's sitting read its 34 served items' 1,462 nodes, the node relation at its key set over
 * (package, path), and then each node's attributes, element types and namespaces at the node's key, 1,462 descents
 * each, 7.9k of its 12.7k pages, where once a document reads 34.
 */
const prefixOver = (
	read: NodeOf<"Base">,
	bound: ReadonlyArray<{ readonly column: string; readonly held: string | undefined }>,
	whole: WholeAt
): ReadonlyArray<string> | undefined => {
	const at = bound.flatMap((b) =>
		b.held !== undefined && whole.at.includes(b.held) ? [b.column] : []
	)
	return properKeyPrefix(whole.base, whole.at) &&
		at.length === whole.at.length &&
		properKeyPrefix(read, at) &&
		at.length < bound.length &&
		bound.every((b) => b.held !== undefined)
		? at
		: undefined
}

/**
 * Whether `base`'s occurrence `o` in `region` is held whole past `at`: at no constant, and each class it binds at a
 * column past `at` bound by no other occurrence of the region but `reader`, so nothing else the region reads keeps fewer
 * of its rows at the prefix than it holds.
 */
const wholePast = (
	region: NodeOf<"MatchRegion">,
	o: Occurrence,
	at: ReadonlyArray<string>,
	reader: Occurrence | undefined
): boolean => {
	const classOf = regionVarClasses(region)
	const past = new Set(o.bindings.flatMap((b) => (at.includes(b.column) ? [] : [classOf(b.var)])))
	return (
		o.constants.length === 0 &&
		region.occurrences.every(
			(q) => q === o || q === reader || q.bindings.every((b) => !past.has(classOf(b.var)))
		)
	)
}

/**
 * The columns a stored step of a region's chain is read at once for each of their values (`prefixOver`, lower/shapes/
 * region chainedSelect `keyset` at a prefix): the step right before it reads a stored relation held whole at the
 * columns the steps before bind of it, or at the key set its statement computes it at (`computedAt`), and the step's
 * columns are bound at that relation's columns, each by its variable's class.
 */
export const chainPrefix = (
	region: NodeOf<"MatchRegion">,
	before: ReadonlyArray<ChainStep>,
	step: ChainStep,
	computedAt: (node: RelNode) => ReadonlyArray<string> | undefined
): ReadonlyArray<string> | undefined => {
	const source = step.occurrence.source
	const previous = before.at(-1)
	const base = previous?.occurrence.source
	if (source.kind !== "Base" || previous === undefined || base?.kind !== "Base") {
		return undefined
	}
	const at = previous.at.length > 0 ? previous.at : (computedAt(base) ?? [])
	if (!wholePast(region, previous.occurrence, at, step.occurrence)) {
		return undefined
	}
	const classOf = regionVarClasses(region)
	return prefixOver(
		source,
		step.occurrence.bindings.flatMap((b) =>
			step.at.includes(b.column)
				? [
						{
							column: b.column,
							held: previous.occurrence.bindings.find((q) => classOf(q.var) === classOf(b.var))
								?.column
						}
					]
				: []
		),
		{ base, at }
	)
}

/**
 * A node's rows as a region's projected: the region, and each column of the node by the region's variable it reads;
 * undefined for any other node.
 */
const projectedRegion = (
	node: RelNode
):
	| {
			readonly region: NodeOf<"MatchRegion">
			readonly varOf: (column: string) => string | undefined
	  }
	| undefined => {
	if (node.kind === "MatchRegion") {
		return { region: node, varOf: (c) => c }
	}
	if (node.kind !== "ProjectSet" || node.input.kind !== "MatchRegion") {
		return undefined
	}
	const input = node.input
	return {
		region: input,
		varOf: (c) => {
			const e = node.out.find((o) => o.name === c)?.expr
			return e?.kind === "column" && e.column.node === input.id ? e.column.name : undefined
		}
	}
}

/**
 * How a node's rows hold a stored relation whole (`prefixOver`): the relation; each column of the node by the column of
 * the relation it is; and the columns of the relation at whose every value the node holds every row the relation holds
 * there, `every` where it holds them all. A stored relation read as it stands, or a region that reads one occurrence of
 * it as it stands, holds it all; a projection, an attachment (its parent's rows) and the rows a semi-join keeps of its
 * left side carry what their input holds, the semi-join at the columns its pairs test, whose every value it keeps whole
 * or drops; a node its statement computes at a key set (`computedAt`) holds what it holds at that set's columns.
 * undefined for any other node.
 */
const heldWhole = (
	node: RelNode,
	computedAt: (node: RelNode) => ReadonlyArray<string> | undefined
):
	| {
			readonly base: NodeOf<"Base">
			readonly columnOf: (column: string) => string | undefined
			readonly at: ReadonlyArray<string> | "every"
	  }
	| undefined => {
	const inner = ((): ReturnType<typeof heldWhole> => {
		switch (node.kind) {
			case "Base":
				return { base: node, columnOf: (c) => c, at: "every" }
			case "MatchRegion": {
				const one = renamedSource(node)
				const source = one?.occurrence.source
				return one === undefined || source?.kind !== "Base"
					? undefined
					: {
							base: source,
							columnOf: (c) => one.occurrence.bindings.find((b) => b.var.name === c)?.column,
							at: "every"
						}
			}
			case "ProjectSet": {
				const below = heldWhole(node.input, computedAt)
				return below === undefined
					? undefined
					: {
							...below,
							columnOf: (c) => {
								const e = node.out.find((o) => o.name === c)?.expr
								return e?.kind === "column" && e.column.node === node.input.id
									? below.columnOf(e.column.name)
									: undefined
							}
						}
			}
			case "Attach":
				return heldWhole(node.parent, computedAt)
			case "SemiJoin": {
				const below = heldWhole(node.left, computedAt)
				const tested = node.on.map((p) => below?.columnOf(p.left))
				if (below === undefined || !tested.every((c) => c !== undefined)) {
					return undefined
				}
				const at = below.at
				return at === "every"
					? { ...below, at: tested }
					: tested.every((c) => at.includes(c))
						? below
						: undefined
			}
			case "AntiJoin":
			case "ApproximateNearest":
			case "Call":
			case "Closed":
			case "Context":
			case "Delta":
			case "Difference":
			case "Filter":
			case "Forbid":
			case "Group":
			case "InputSet":
			case "Intersect":
			case "OrderedResult":
			case "OrderedSetAggregate":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "Step":
			case "Take":
			case "Union":
			case "Window":
				return undefined
		}
	})()
	const keyed = computedAt(node)
	if (inner === undefined || keyed === undefined || keyed.length === 0 || inner.at !== "every") {
		return inner
	}
	const at = keyed.map((c) => inner.columnOf(c))
	return at.every((c) => c !== undefined) ? { ...inner, at } : inner
}

/**
 * The correlation pairs an attachment reads its child at once for each of their values (`prefixOver`, lower/shapes/
 * attach pipelinedAttachment `perKey` at a prefix), the rest joined to its parent keys: a child read per parent key
 * (attachmentRead `perKey`) that reads no outer row, its rows a region's of one stored relation; and a parent that
 * holds a stored relation whole at a proper prefix of its key (`heldWhole`), each correlated column one of that
 * relation's: metis's sitting's served items' nodes, the nodes of the documents a semi-join keeps by the served
 * (package, path), each node's attributes attached by (package, path, start).
 */
export const attachmentPrefix = (
	attach: NodeOf<"Attach">,
	computedAt: (node: RelNode) => ReadonlyArray<string> | undefined
): ReadonlyArray<NodeOf<"Attach">["correlation"][number]> | undefined => {
	const child = projectedRegion(attachedRows(attach.child))
	const [only, ...others] = child?.region.occurrences ?? []
	const parent = heldWhole(attach.parent, computedAt)
	if (
		child === undefined ||
		parent === undefined ||
		parent.at === "every" ||
		only === undefined ||
		others.length > 0 ||
		only.source.kind !== "Base" ||
		outerOf(attach.child).length > 0 ||
		attachmentRead(attach).kind !== "perKey"
	) {
		return undefined
	}
	const read = only.source
	const bound = attach.correlation.flatMap((c) => {
		const column = only.bindings.find((b) => b.var.name === child.varOf(c.child))?.column
		return column === undefined ? [] : [{ pair: c, column, held: parent.columnOf(c.parent) }]
	})
	const prefix =
		bound.length === attach.correlation.length
			? prefixOver(read, bound, { base: parent.base, at: parent.at })
			: undefined
	return prefix === undefined
		? undefined
		: bound.flatMap((b) => (prefix.includes(b.column) ? [b.pair] : []))
}

/**
 * Whether a chain may start at `node` with nothing bound, below every stored relation a value binds on a declared-key
 * prefix (Bound `{prefix, 0.5}`): a held set, whose rows the statement's own values restrict (restrictedByValues: a
 * delta, the call's input or context, and every node over them at their keys, a carried share's, a statement CTE's or
 * an evaluation's rows among them), a closed relation's rows, a constant of the statement, or a recursion's feedback,
 * the working table of the states its last step found, which PostgreSQL holds and each step reads whole. Each is read
 * whole, none of the store's rows beyond what its own rows pick, so each later step is read per row of it at the values
 * it binds: a recursion's step reads each stored relation it joins to the feedback by a fenced seek per state, never
 * joined to the working table by PostgreSQL's estimate of it, which hashed the relation whole at every iteration (r37: a
 * page of two chains of one edge each read every one of 2,088 edges). None is "one row" (`key`), a held set holding as
 * many rows as the call, so a stored relation a parameter binds on a declared key leads it.
 */
export const heldSet = (node: RelNode): boolean =>
	node.kind === "Closed" || node.kind === "SelfRef" || restrictedByValues(node)

const keyPrefixBound = (node: RelNode, columns: ReadonlyArray<string>): boolean =>
	keyPrefixLength(node, columns) > 0

/**
 * The declared-key prefix a read of `node` at `columns` reads every stored relation of its rows at (keyPrefixBound):
 * the shortest of the prefixes those columns bind of the stored relations it reads, each a stored relation's own
 * measure (boundPrefix), through the rows a node keeps of its input as keyPrefixBound walks them, a region's the
 * shortest of its chain's steps' (a cross step, which reads its relation whole for each row before it and binds no
 * prefix, is none of the shortest), a union's of its arms'; a fold's at the columns of its keys, its groups its input's
 * rows at them, a bound aggregate beside them filtering those groups alone; a take's at the columns of its partition,
 * its rows at a key of it its input's rows at that key, ranked (take/partition.ts); a set the statement holds, and a
 * projection's key every column of which it holds at a value, read from no store, every column held; 0 where some
 * relation is bound on none. A chain compares a derived step with a stored one by it (`leads`), never by how many
 * columns either binds.
 */
const keyPrefixLength = (node: RelNode, columns: ReadonlyArray<string>): number => {
	if (columns.length === 0) {
		return 0
	}
	switch (node.kind) {
		case "InputSet":
		case "Delta":
		case "Context":
		case "Closed":
			return columns.length
		case "Base":
			return boundPrefix(node, new Set(columns), new Set())
		case "Union": {
			const [first, ...rest] = unionArms(node.groups)
			return rest.reduce(
				(low, arm) => Math.min(low, keyPrefixLength(arm, columns)),
				keyPrefixLength(first, columns)
			)
		}
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
					return 0
				}
			}
			return read.length === 0 ? columns.length : keyPrefixLength(node.input, read)
		}
		case "Group":
			return keyPrefixLength(
				node.input,
				columns.filter((c) => node.keys.includes(c))
			)
		case "Step":
		case "Filter":
			return keyPrefixLength(node.input, columns)
		case "Take":
			return keyPrefixLength(
				node.input,
				columns.filter((c) => inPartition(node, c))
			)
		case "SemiJoin":
		case "AntiJoin":
			return Math.min(
				keyPrefixLength(node.left, columns),
				keyPrefixLength(
					node.right,
					node.on.map((p) => p.right)
				)
			)
		case "MatchRegion": {
			const chain = keyedRegionChain(node, node.occurrences, columns)
			return chain === undefined
				? 0
				: chain.reduce(
						(low, step) => (step.bound.rank === "cross" ? low : Math.min(low, step.bound.length)),
						Number.POSITIVE_INFINITY
					)
		}
		case "Attach":
			return keyPrefixLength(node.parent, columns)
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
		case "Window":
			return 0
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
const restrictedWithin = (node: RelNode, reader: RelNode): boolean => {
	if (!restrictedByValues(node)) {
		return false
	}
	const outside = outsideOf(reader)
	return outerOf(node).every((c) => outside.has(c.node))
}

/**
 * Whether a region's rows are restricted by the values fixed where it is evaluated (restrictedByValues): every
 * occurrence is reached from one whose rows those values restrict, an occurrence of a stored relation a parameter or an
 * outer row's column fixes a column of (`fixedValue`), a column of no code's type (`codeTyped`: a code's value, whatever
 * its source, is every unit's), through the variables the reached ones bind, each occurrence it
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
		region.correlated.flatMap((c) =>
			fixedValue(c.expr, outside) && !codeTyped(c.var.type) ? [c.var] : []
		)
	)
	const pending = new Set(region.occurrences)
	const reach = (o: Occurrence): void => {
		pending.delete(o)
		for (const b of o.bindings) {
			reached.add(b.var)
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
	/**
	 * The columns `o` holds at values the region's evaluation fixes: each it binds to a reached variable, and each a
	 * constant holds at an expression of a parameter or of columns `fixedFor` judges fixed, none a literal alone and none
	 * of a code's type, whose value is every unit's.
	 */
	const heldColumns = (o: Occurrence): ReadonlyArray<string> => [
		...o.bindings.flatMap((b) => (reached.has(b.var) ? [b.column] : [])),
		...o.constants.flatMap((c) => {
			const type = columnTypeOf(o.source, c.column)
			return type !== undefined &&
				!codeTyped(type) &&
				(c.expr.deps.params.length > 0 || c.expr.deps.nodes.length > 0) &&
				exprClosure([c.expr]).every(
					(e) => e.kind !== "column" || fixedFor(o, { node: e.column.node, column: e.column.name })
				)
				? [c.column]
				: []
		})
	]
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
			const held = heldColumns(o)
			if (
				(isNonEmpty(held) && (o.source.kind === "Base" || restrictedByKeys(o.source, held))) ||
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
 * region every occurrence of which those values reach (regionRestrictedByValues); a semi-join its right side drives
 * (semiJoinDriven), its left side read at the right side's keys alone, the users the session's claims name read from
 * their sign-in's key; and a node over such rows, its input's, a union's every arm's, a call's every rows argument's. A stored relation or a constant one read whole, and
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
				return restrictedByValues(node.left) || semiJoinDriven(node) !== undefined
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
 *   once for the statement, read every reference and media file stored for each item read. A take is read so where its
 *   partition, the attachment's correlated columns, binds its input (take/partition.ts): its input at the key, ranked
 *   there, below its bound, where read beside its parents it was ranked over every key's rows (metis's results page,
 *   each session's latest credit ranked over the credit of every attempt of the database).
 * - `whole`: no declared-key prefix binds the correlated columns (keyPrefixBound), so a read at one key would read
 *   other keys' rows: the child derived once, whole, and joined to the parent keys at its correlation, a set join its
 *   binding hashes (lower/shapes/attach pipelinedAttachment). A child that reads its parent row's values itself is read
 *   per key, whatever binds it: no derivation of it holds for every parent at once.
 * - `take`: a take no declared-key prefix binds at its partition, read as its probe per parent (R20,
 *   lower/shapes/take takeShape), beside.
 */
export type AttachmentRead =
	| { readonly kind: "perKey" }
	| { readonly kind: "whole" }
	| { readonly kind: "take" }

export const attachmentRead = (attach: NodeOf<"Attach">): AttachmentRead => {
	const rows = attachedRows(attach.child)
	const keyed = keyPrefixBound(
		rows,
		attach.correlation.map((c) => c.child)
	)
	return rows.kind === "Take" && !keyed
		? { kind: "take" }
		: outerOf(attach.child).length > 0 || keyed
			? { kind: "perKey" }
			: { kind: "whole" }
}

/**
 * A source a region reads once per row of the outer row it is evaluated for, at the values its correlation fixes
 * there (a row site, as an attachment's child per parent key is): each column of the source an occurrence's constant
 * holds at an outer row's column, or bound to a variable the region correlates to one, with that column's expression.
 * Lowered where the region reads it, at
 * those values, carried into the nodes under it that read them (lower/shapes/share/keys.ts restrictionWalk), never the
 * statement's CTE keyed at every outer row's values: a call's rows argument bound at its region's row (edullm's
 * credit of each attempt, its values in force) and a correlated read of a fold (reviewOf's LatestAttempt at the
 * sitting's child and stage). Admitted by the per-key proof alone (keyPrefixBound): the columns bind every stored
 * relation the source reads on a declared-key prefix, so each row's read seeks that row's rows; a stored relation the
 * region reads itself is no site, its own conditions seeking it, and neither is a source the values fixed where the
 * region is evaluated restrict already (restrictedWithin): its rows are those values' for each evaluation, computed
 * once where its statement or the enclosing row's query shares it (rule 5d, cte-policy rule 3), so a site restricting
 * it again at them only spells it anew at each read: a judge's containment over a union read at the unit's channels the
 * enclosing row carries, inside a negation and beside it, spelled the union at both reads, 15 reads of Node past its 9.
 */
export interface CorrelatedSite {
	readonly source: RelNode
	readonly restriction: NonEmptyReadonlyArray<{
		readonly column: string
		readonly expr: ScalarExpr
	}>
}

/** Whether occurrence `q` holds its source at `restriction` alone: each column at an outer row's same column, and no other. */
const sameOuterRestriction = (
	region: NodeOf<"MatchRegion">,
	q: Occurrence,
	restriction: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>
): boolean => {
	const classOf = regionVarClasses(region)
	const held = [
		...q.constants.flatMap((k) =>
			readsOuterRow(region, k.expr) ? [{ column: k.column, expr: k.expr }] : []
		),
		...q.bindings.flatMap((b) => {
			const c = region.correlated.find(
				(x) => readsOuterRow(region, x.expr) && classOf(x.var) === classOf(b.var)
			)
			return c === undefined || q.constants.some((k) => k.column === b.column)
				? []
				: [{ column: b.column, expr: c.expr }]
		})
	]
	const same = (a: ScalarExpr, b: ScalarExpr): boolean =>
		a === b ||
		(a.kind === "column" &&
			b.kind === "column" &&
			a.column.node === b.column.node &&
			a.column.name === b.column.name)
	return (
		held.length === restriction.length &&
		held.every((h) => restriction.some((r) => r.column === h.column && same(r.expr, h.expr)))
	)
}

export const correlatedSites = (region: NodeOf<"MatchRegion">): ReadonlyArray<CorrelatedSite> => {
	const classOf = regionVarClasses(region)
	const readsOuter = (e: ScalarExpr): boolean => readsOuterRow(region, e)
	const outer = region.correlated.filter((c) => readsOuter(c.expr))
	const sites: Array<CorrelatedSite> = []
	for (const o of region.occurrences) {
		if (
			o.source.kind === "Base" ||
			restrictedWithin(o.source, region) ||
			sites.some((s) => s.source === o.source)
		) {
			continue
		}
		const restriction = [
			...o.constants.flatMap((k) =>
				readsOuter(k.expr) ? [{ column: k.column, expr: k.expr }] : []
			),
			...o.bindings.flatMap((b) => {
				const c = outer.find((x) => classOf(x.var) === classOf(b.var))
				return c === undefined || o.constants.some((k) => k.column === b.column)
					? []
					: [{ column: b.column, expr: c.expr }]
			})
		]
		if (
			isNonEmpty(restriction) &&
			region.occurrences.every(
				(q) => q.source !== o.source || sameOuterRestriction(region, q, restriction)
			) &&
			keyPrefixBound(
				o.source,
				restriction.map((r) => r.column)
			)
		) {
			sites.push({ source: o.source, restriction })
		}
	}
	return sites
}

/**
 * The pairs a semi-join's right side drives it at, none where it is not driven: the right side's rows are the
 * statement's own (restrictedByValues,
 * a sitting read by its key, the call's items), and its pairs bind every stored relation the left side reads on a
 * declared-key prefix (keyPrefixBound), and the values fixed where the left side is evaluated bind it no tighter than
 * the right side's bind it (`leadOf`, Rank). The left side is then read once per DISTINCT right-side key, at the key's
 * values, a row site (lower/shapes semiJoinShape, keys.ts rowReads), its chain led by the longest prefix the key binds,
 * where a key that entered the left side only as an existence test left PostgreSQL to read it by whatever its
 * estimates chose: a stage's latest attempts beside the sitting's existence test, every attempt of the child read
 * first. A left side its own values bind at a better rank is read at them, and the test per row of it: a child's seats
 * of a grade, the grade a parameter's, read every child's seats of the grade at its keys, where the child's own seats,
 * one unit's rows, are the read. An anti-join, whose test keeps the left rows no right row meets, is never driven.
 */
export const semiJoinDriven = (
	node: NodeOf<"SemiJoin">
): NonEmptyReadonlyArray<NodeOf<"SemiJoin">["on"][number]> | undefined => {
	const on = node.on
	return isNonEmpty(on) &&
		restrictedByValues(node.right) &&
		keyPrefixBound(
			node.left,
			on.map((p) => p.left)
		) &&
		!leftLeads(node)
		? on
		: undefined
}

/**
 * Whether the values fixed where an existence test is evaluated bind its left side at a better rank than its right
 * side (`leadOf`, Rank): the left side is then read at them, one unit's rows or one row, and the test per row of it
 * (semiJoinDriven, rightPerLeftRow), never the right side's rows first, which grow with the store
 * where its rank is a prefix's: a child's seats at the child's user beside a grade's seats.
 */
const leftLeads = (node: NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">): boolean => {
	const own = leadOf(node.left)
	const right = leadOf(node.right)
	return own !== undefined && right !== undefined && rankOrder[own] < rankOrder[right]
}

/**
 * The pairs an existence test reads its right side at once per left row, none where it reads it as a set: a right side
 * that reads a stored relation (`readsStored`), whose join columns each restrict every relation it reads
 * (restrictedByKeys), the right side one no value fixed where the test is evaluated restricts (restrictedWithin), the
 * statement's or an outer row's, its own left row's aside, or one the left side's own values bind at a better rank
 * (leftLeads). The right side is then lowered at the left row's values, each pushed into the nodes under it the
 * restriction reaches (keys.ts restrictionWalk), never read from a set the statement derives once, and its stored
 * relations are read at those values alone, through the index the test's join columns request (physical/access
 * extract.ts), whatever PostgreSQL estimates of either side, never the set a statement carries or derives once, which
 * the read of it then derives whole. metis's assign carried the standing invalidations, every invalidation the store
 * holds, for the two tests of its user's active sittings against them, and tested each sitting in a bare EXISTS over
 * that set, 1,118 pages a call where the user's few sittings read a few. A right side so restricted is small, derived
 * once where the test stands and read as a set; a right side that reads no stored relation, only the statement's own
 * sets, is one too. Every lowering reads a unit's rows but a law's full violation query, whose tests a hash join of
 * both sides reads once (semi-join/exists.ts readsWhole).
 */
export const rightPerLeftRow = (
	node: NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">
): NonEmptyReadonlyArray<NodeOf<"SemiJoin">["on"][number]> | undefined => {
	const on = node.on
	return isNonEmpty(on) &&
		(!restrictedWithin(node.right, node) || leftLeads(node)) &&
		readsStored(node.right) &&
		restrictedByKeys(
			node.right,
			on.map((p) => p.right)
		)
		? on
		: undefined
}

/** Whether a node reads a stored relation, a Base, which an index reads at a test's join columns. */
export const readsStored = (node: RelNode): boolean =>
	postorder([node], (n) => inputsOf(n)).some((n) => n.kind === "Base")

/**
 * The rank of the tightest bound the values fixed where `node` is evaluated prove of its rows (Rank, semiJoinDriven): a
 * set the call passes in or a closed relation, none of the store's rows, `held`; a region's, the tightest of each held
 * set it reads (heldSet), at that set's own rank, a test's assignments at a test parameter as loose as their own chain,
 * and the first step's of its chain at those values (chainSteps, fixedVariables), where a stored relation or a source
 * keyPrefixBound proves leads it; a filter's over a region, the first step's of the region's chain at the columns its
 * conjuncts hold at values too (valueEqualities), as a region's own constants; a union's, the loosest of its arms', each
 * arm's rows that bound; through a node that keeps its input's rows, its input's; undefined where no value bounds them.
 */
const leadOf = (node: RelNode): Rank | undefined => {
	if (leadRanks.has(node)) {
		return leadRanks.get(node)
	}
	const rank = leadOfNode(node)
	leadRanks.set(node, rank)
	return rank
}

/** Each node's lead (`leadOf`), for as long as the node lives: a chain asks it of a held set at each of its steps. */
const leadRanks = new WeakMap<RelNode, Rank | undefined>()

const leadOfNode = (node: RelNode): Rank | undefined => {
	switch (node.kind) {
		case "InputSet":
		case "Delta":
		case "Context":
		case "Closed":
			return "held"
		case "MatchRegion": {
			const [first] = chainSteps(node, node.occurrences, fixedVariables(node))
			const ranks = [
				...node.occurrences.flatMap((o) => (heldSet(o.source) ? [leadOf(o.source)] : [])),
				first === undefined || first.bound.length < 1 ? undefined : first.bound.rank
			].flatMap((r) => (r === undefined ? [] : [r]))
			return ranks.reduce<Rank | undefined>(
				(best, r) => (best === undefined || rankOrder[r] < rankOrder[best] ? r : best),
				undefined
			)
		}
		case "Filter": {
			const region = node.input
			if (region.kind !== "MatchRegion") {
				return leadOf(region)
			}
			const [first] = chainSteps(region, region.occurrences, [
				...fixedVariables(region),
				...valueEqualities(node)
			])
			return first === undefined || first.bound.length < 1 ? leadOf(region) : first.bound.rank
		}
		case "ProjectSet":
		case "Step":
			return leadOf(node.input)
		case "SemiJoin":
			return (
				leadOf(node.left) ?? (semiJoinDriven(node) === undefined ? undefined : leadOf(node.right))
			)
		case "AntiJoin":
			return leadOf(node.left)
		case "Attach":
			return leadOf(node.parent)
		case "Union": {
			const ranks = unionArms(node.groups).map(leadOf)
			return ranks.reduce<Rank | undefined>(
				(worst, r) =>
					worst === undefined || r === undefined
						? undefined
						: rankOrder[r] > rankOrder[worst]
							? r
							: worst,
				ranks[0]
			)
		}
		case "ApproximateNearest":
		case "Base":
		case "Call":
		case "Difference":
		case "Forbid":
		case "Group":
		case "Intersect":
		case "OrderedResult":
		case "OrderedSetAggregate":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "Take":
		case "Window":
			return undefined
	}
}

/**
 * The rank the rows of `node` are bounded at as a whole, the loosest of what bounds each of its steps (Rank): a set the
 * call passes in, `held`; a region's, the loosest step of its chain from the values fixed where it is evaluated
 * (keyedRegionChain, fixedVariables), each step's rows those of one key, one unit or a held set per row of the steps
 * before it, a held set at its own rows' rank; through a node that keeps or narrows its inputs' rows, the loosest of its
 * inputs'; undefined where no value bounds them: a stored relation read whole, a region whose chain reaches none of
 * its occurrences on a key, a recursion. Where `leadOf` ranks where a read starts, this ranks how many rows it may end
 * with, which a carrier holds whole (write/carriers/carriers.ts CarrierBound).
 */
export const rowsBound = (node: RelNode): Rank | undefined => {
	switch (node.kind) {
		case "InputSet":
		case "Delta":
		case "Context":
		case "Closed":
			return "held"
		case "MatchRegion": {
			const steps = keyedRegionChain(node, node.occurrences, fixedVariables(node))
			return steps === undefined
				? undefined
				: loosestRank(
						steps.map((s) =>
							heldSet(s.occurrence.source) ? rowsBound(s.occurrence.source) : s.bound.rank
						)
					)
		}
		case "SemiJoin":
		case "AntiJoin":
			return rowsBound(node.left)
		case "Attach":
			return rowsBound(node.parent)
		case "Base":
		case "Call":
		case "Recursive":
		case "SelfRef":
			return undefined
		case "ApproximateNearest":
		case "Difference":
		case "Forbid":
		case "Group":
		case "Intersect":
		case "OrderedResult":
		case "OrderedSetAggregate":
		case "Produce":
		case "ProjectSet":
		case "Filter":
		case "Step":
		case "Take":
		case "Union":
		case "Window":
			return loosestRank(inputsOf(node).map(rowsBound))
	}
}

/** The loosest of `ranks`, undefined where one is unbounded or there is none. */
export const loosestRank = (ranks: ReadonlyArray<Rank | undefined>): Rank | undefined =>
	ranks.reduce<Rank | undefined>(
		(worst, r) =>
			worst === undefined || r === undefined
				? undefined
				: rankOrder[r] > rankOrder[worst]
					? r
					: worst,
		ranks.length === 0 ? undefined : "key"
	)

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
	reads: CteSubject,
	realization: (node: RelNode) => Realization
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
	const classes = copyClasses(d, labels, scopes, feedback, realization)
	const decided: Array<Decided> = []
	for (const node of d.order) {
		const references = classes.references(node)
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
			copies: classes.first(node).id,
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
		} else if (references > 1 && readWhole(node, realization)) {
			decision = decide("materialized", "sharedWhole", statementScope)
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

/** A DAG's classes of copies (copyClasses): each node's class's first node, and the reads of its class. */
interface CopyClasses {
	readonly first: (node: RelNode) => RelNode
	readonly references: (node: RelNode) => number
}

/**
 * The classes of copies a DAG holds (rule 3d): each node the policy may compute once, uncorrelated, read laterally by no
 * expression, off every recursion's feedback, and no scan inlined at each read (rule 4) but one read whole (readWhole),
 * classed by its share key (ir/dag-digest.ts ShareKeys), equal for two nodes exactly when they compute the same set at
 * the same parameters; its class's first node in the demand's order stands for it, and its class's reads are every
 * copy's. A query imports a sub-query once for each read of it, each import a copy of its own
 * (lower/shapes/share/statements.ts), so a node a statement reads at two imports is two nodes read once each: decided
 * per node, each was inlined, or, read twice in each, computed as a CTE of its own, edullm's sittingItem computing one
 * key-set read of its item sessions in five MATERIALIZED CTEs of one text. Classed, the copies are one node read at
 * every copy's reads.
 */
const copyClasses = (
	d: ReturnType<typeof analyzeDemand>,
	labels: ReadonlyMap<NodeId, RelNode>,
	scopes: Fold<RelNode, NodeScope>,
	feedback: ReadonlySet<RelNode>,
	realization: (node: RelNode) => Realization
): CopyClasses => {
	const keys = new ShareKeys(
		() => labels,
		maxStringLength,
		(n) => scopes.of(n).outer.size === 0 && !feedback.has(n),
		new DagTemplates("derivation")
	)
	const keyOf = new Map<RelNode, string>()
	const firsts = new Map<string, RelNode>()
	const reads = new Map<string, number>()
	for (const node of d.order) {
		if (
			node.kind === "Recursive" ||
			node.kind === "SelfRef" ||
			(costClass(node) === "scan" && !readWhole(node, realization)) ||
			outerOf(node).length > 0 ||
			freeVars(labels, scopes.of(node)).length > 0 ||
			d.lateral(node) ||
			feedback.has(node)
		) {
			continue
		}
		const key = unwrap(keys.key(node))
		keyOf.set(node, key)
		firsts.getOrInsert(key, node)
		reads.set(key, (reads.get(key) ?? 0) + d.references(node))
	}
	return {
		first: (node) => {
			const key = keyOf.get(node)
			return key === undefined ? node : defined(firsts.get(key), "a class's first node")
		},
		references: (node) => {
			const key = keyOf.get(node)
			return key === undefined ? d.references(node) : defined(reads.get(key), "a class's reads")
		}
	}
}

/**
 * Each DAG's classes' first nodes under each realization (copyClassesOf), for as long as the DAG lives: one value for
 * every lowering of it under that realization.
 */
const firstsOf = new WeakMap<
	(node: RelNode) => Realization,
	WeakMap<ValidDag, (node: RelNode) => RelNode>
>()

/**
 * Each node's class of copies' first node (copyClasses, rule 3d), over `dag` whole, each node realized as `realization`
 * places it: the classes the CTE policy decides by, which a lowering that shares no node by the policy reads too, so a
 * copy is one shared node under one definition of the classes wherever a statement is printed (lower/conservative
 * dispatch, whose every node stands behind its set boundary).
 */
export const copyClassesOf = (
	dag: ValidDag,
	realization: (node: RelNode) => Realization
): ((node: RelNode) => RelNode) => {
	const byDag = firstsOf.getOrInsertComputed(realization, () => new WeakMap())
	const known = byDag.get(dag)
	if (known !== undefined) {
		return known
	}
	const d = analyzeDemand(dag, noPins)
	const first = copyClasses(
		d,
		nodesByLabel(dag),
		nodeScopes(),
		feedbackReadsOf(nodeGraph, d.order),
		realization
	).first
	byDag.set(dag, first)
	return first
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
		if (fn.kind === "split" || fn.kind === "series" || fn.kind === "arm") {
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
 * 3c. A shared node every read computes whole (readWhole), a closed derivation, whose rows are constants no index finds,
 *    or a step, which every read computes apart, is MATERIALIZED: computed, printed, parsed and planned once, each read
 *    a scan of its rows, as each read was a scan of the VALUES or the step it computed again.
 * 3d. Copies of one sub-query, nodes of one share key (copyClasses), are one node: their reads are counted together and
 *    one decision is theirs, every copy reading the one CTE it defines.
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
 *    other keys' rows of, is derived once and joined to its parents' keys at its correlation by a hash (attachmentRead
 *    `whole`, lower/shapes/attach pipelinedAttachment), the child the join's inner, read once.
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
export const ctePolicyPass = (
	reads: CteSubject,
	realization: (node: RelNode) => Realization
): Pass<LogicalQuery, CtePlannedQuery> => ({
	name: "ctePolicy",
	run: (query, ctx) =>
		catchRefusal(() => {
			const { decided, evaluations } = ctePlan(query.dag, reads, realization)
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
