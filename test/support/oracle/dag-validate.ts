import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, Record as Rec } from "effect"
import { compileReasonText } from "#compiler/core/errors.ts"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import {
	type ConstraintName,
	ExprId,
	type LawId,
	NodeId,
	OccurrenceId,
	ParamId,
	ScopeId,
	VarId
} from "#compiler/core/ids.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import { directions } from "#compiler/core/order.ts"
import { assembledDag, relNode } from "#compiler/ir/dag.ts"
import {
	constraintKinds,
	type EvidenceContext,
	evidenceContexts,
	type Premise
} from "#compiler/ir/evidence.ts"
import {
	builtExpr,
	condProblems,
	describeOp,
	exprEffects,
	firstArgumentCycle,
	type LiveArgs,
	literalProblem,
	mapArgs,
	nativeEqualityKey,
	OpId,
	type ScalarExpr,
	type TableArgs,
	type TableExpr,
	type TableExprOf
} from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import {
	type AtMostOneWitness,
	type Dependency,
	type EqualWitness,
	type FixedWitness,
	type Implication,
	type KeyProof,
	keyIn,
	type Rule,
	type Separation,
	type ViewKey
} from "#compiler/ir/keys.ts"
import type { NativeProof, OperationProof } from "#compiler/ir/proof.ts"
import {
	type AggregateFn,
	type CompletedOrder,
	type DagTable,
	exprsOf,
	fieldParams,
	type FrameBound,
	type Heading,
	type HeadingColumn,
	type Identified,
	type InputSetInput,
	inputsOf,
	type FoldInput,
	type KeySet,
	keptRowsOf,
	type KindOver,
	mapNode,
	metaSpecOf,
	type NodeMeta,
	orderedSetFns,
	type RelDag,
	type RelKind,
	type RelNode,
	scopeExprs,
	type SpecRefs,
	type TableNode,
	type TableRefs,
	type TakeBound,
	type TerminationCert,
	type ValidDag,
	type VarDecl,
	type WindowFn,
	type WindowFrame,
	windowFns
} from "#compiler/ir/rel.ts"
import {
	calledFunctionShape,
	literalShape,
	scalarTypeShape,
	tableExprShape
} from "#compiler/ir/scalar-shape.ts"
import { baseOf, isRefined, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import * as S from "#compiler/ir/shape.ts"
import { meets } from "#compiler/scalar/compute/types.ts"
import { definedness } from "#test/support/compute.ts"
import { toTable } from "#test/support/dag.ts"
import { nativeProofHolds, operationProofHolds, proofCovers } from "#test/support/oracle/proof.ts"

/**
 * The strict re-reader of a DAG: every rule a DAG grizzle's builders and editors assemble holds by construction,
 * checked again over the outside form of the DAGs the tests build and corrupt (dag.ts toTable). A table's shape is
 * conformed strictly (dagTableShape), then its semantics are checked.
 */

/**
 * Every rule the validator holds a DAG to, as it reports one broken: the shape stage's (dagTableShape), whose refusal
 * names none of them, and the semantic stage's, each problem under its own. A corruption (test/unit/ir/corruptions.ts)
 * names the rule it breaks among these, so a misspelt rule is a compile error.
 */
export type DagRule =
	| "a feedback edge names a node"
	| "a column reference names a column of its node"
	| "a binding names a declared variable"
	| "a variable is declared by one region"
	| "a region declares a variable once"
	| "a region's variables have distinct names"
	| "an occurrence id is fresh"
	| "a region binds its own variables only"
	| "a heading names each column once"
	| "a heading column has a name"
	| "a heading is the one its kind defines"
	| "a heading column has the type its kind defines"
	| "a group's keys lie in its bound tuple"
	| "a declared key names columns of the heading"
	| "a union of several headings has a discriminant"
	| "every arm binds the discriminant to a literal"
	| "arms of different headings differ in their discriminant literals"
	| "an arm has its group's heading"
	| "an attachment binds a parent variable"
	| "an attachment delivers no narrower than its child's evidence"
	| "an order belongs to a delivered array"
	| "a delivery node lies on its root's delivered rows"
	| "a filter's predicate is boolean"
	| "an approximate search is sealed and scored by a double precision column"
	| "a take's bound is positive"
	| "set operation inputs have equal headings"
	| "join columns exist on both sides at one base type"
	| "a producer has its arity"
	| "a closed row has the heading's width"
	| "closed facts are distinct under native equality"
	| "an expression reads its node's input only"
	| "a scope expression's column is bound on its way to every root"
	| "a semi-join's right side reads nothing of its left"
	| "an aggregate reads only its bound tuple"
	| "a node's read dependencies are the computed ones"
	| "a node's parameter dependencies are the computed ones"
	| "an order is total"
	| "a logical key names heading columns"
	| "logical keys are distinct"
	| "the empty key needs at most one row"
	| "a recursion's self is its feedback reference"
	| "a recursion's base and step have its state heading"
	| "a recursion has one feedback reference"
	| "a recursion's base never reads its feedback"
	| "a recursion's step reads its feedback"
	| "only the step reads the feedback"
	| "a window function has its arity"
	| "lead and lag take an integer offset and a default of the value's type"
	| "a ROWS frame belongs to an ordered window aggregate, start before end"
	| "only a count is filtered"
	| "an aggregate has its arity"
	| "an ordered-set aggregate orders by one column, with a double precision fraction per output"
	| "a literal fits its type"
	| "a comparison parameter is bound as its base type"
	| "an expression's dependencies are the computed ones"
	| "an expression is stable when an argument is"
	| "a conditional has a boolean condition and branches of its type"
	| "VALUE appears only in a contract predicate"
	| "a column reference keeps its column's type"
	| "a partial operation stands with a proof the kernel re-derives"
	| "every precondition of a partial operation stands with a proof of its own"
	| "a domain cast targets a refined type"
	| "a node or expression holds its kind's properties only"
	| "no field holds null"
	| "a data input or argument names an entry of the table, through no cycle"
	| "a termination premise names a node"
	| "an occurrence reads columns of its source at their types"
	| "equated variables have one base type"
	| "a relation parameter or a context has a column"
	| "a call's rows are its result's heading, of a column"
	| "a call's rows argument delivers its heading's fields"
	| "a column a node names lies in the heading it reads"
	| "a union's groups have distinct headings"
	| "an aggregate's name differs from its group's keys"
	| "an attachment's name differs from its parent's columns"
	| "an order-sensitive window function is ordered"
	| "an operation is an overload the registry holds"
	| "an operation defined everywhere stands with no proof"
	| "a native operation stands with a proof the kernel re-derives"
	| "a closed read stands only in a side's predicate or a generated field's expression"

/** A rule a DAG breaks: the rule, where it breaks it, `path`, inside its table, and `message`, what it lacks there. */
interface DagProblem {
	readonly path: ReadonlyArray<string | number>
	readonly rule: DagRule
	readonly message: string
}

/** A rule an expression of a DAG breaks, before the place it breaks it at is known. */
interface ExprProblem {
	readonly rule: DagRule
	readonly message: string
}

/** A node of the table form, of one kind. */
type TableOf<K extends RelKind> = KindOver<K, TableRefs> & Identified

const nodeAt = (table: DagTable, id: NodeId): TableNode | undefined =>
	Rec.has(table.nodes, id) ? table.nodes[id] : undefined

const exprAt = (table: DagTable, id: ExprId): TableExpr | undefined =>
	Rec.has(table.exprs, id) ? table.exprs[id] : undefined

/** The expressions `roots` reach through their arguments in a table, each once, in first-visit order. */
const closureOf = (table: DagTable, roots: ReadonlyArray<ExprId>): ReadonlyArray<TableExpr> => {
	const seen = new Set<ExprId>()
	const out: Array<TableExpr> = []
	const queue = [...roots]
	for (const id of queue) {
		const e = seen.has(id) ? undefined : exprAt(table, id)
		seen.add(id)
		if (e !== undefined) {
			out.push(e)
			appendAll(queue, e.args)
		}
	}
	return out
}

/**
 * The node names a node holds beside its data edges, each with the rule it keeps by naming a node of the table: a
 * SelfRef's Recursive and a certificate's node premises.
 */
const namesOf = (
	node: TableNode
): ReadonlyArray<{ readonly id: NodeId; readonly rule: DagRule }> => {
	switch (node.kind) {
		case "SelfRef":
			return [{ id: node.recursive, rule: "a feedback edge names a node" }]
		case "Recursive":
			return Arr.flatMap(node.termination.premises, (p) =>
				p.kind === "node" ? [{ id: p.node, rule: "a termination premise names a node" }] : []
			)
		case "Call":
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "MatchRegion":
		case "Filter":
		case "ProjectSet":
		case "SemiJoin":
		case "AntiJoin":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Take":
		case "Group":
		case "Produce":
		case "ApproximateNearest":
		case "Step":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return []
	}
}

/**
 * The defect a DAG grizzle built raises at its first problem: grizzle's own compiler assembled it, so a rule it breaks
 * is a bug in grizzle, never a refusal of anyone's input. It names the rule and where the DAG breaks it.
 */
const broken = (p: Pick<DagProblem, "path" | "message">): Error =>
	defect(
		`a DAG grizzle built breaks a rule at ${formatLoc(SourceLoc("relational DAG", p.path))}: ${p.message}`
	)

const columnOf = (heading: Heading, name: string): HeadingColumn | undefined =>
	Option.getOrUndefined(Arr.findFirst(heading, (c) => c.name === name))

const hasColumn = (heading: Heading, name: string): boolean =>
	Arr.some(heading, (c) => c.name === name)

/** The column `name` of a heading that may be unknown; none when the heading is unknown or lacks it. */
const columnIn = (heading: Heading | undefined, name: string): HeadingColumn | undefined =>
	heading === undefined ? undefined : columnOf(heading, name)

const sameColumns = (a: Heading, b: Heading): boolean =>
	a.length === b.length &&
	Arr.every(a, (c, i) => {
		const d = b[i]
		return d !== undefined && c.name === d.name && sameScalarType(c.type, d.type)
	})

/**
 * The rule a heading unequal to the one its kind defines breaks: the column types, when its column names are the
 * defined ones in their order, and otherwise the heading itself.
 */
const headingRule = (actual: Heading, defined: Heading): DagRule =>
	actual.length === defined.length && Arr.every(actual, (c, i) => defined[i]?.name === c.name)
		? "a heading column has the type its kind defines"
		: "a heading is the one its kind defines"

/** Equal as sets of (name, type), whatever the order. */
const sameColumnSet = (a: Heading, b: Heading): boolean =>
	a.length === b.length &&
	Arr.every(a, (c) => {
		const other = columnOf(b, c.name)
		return other !== undefined && sameScalarType(c.type, other.type)
	})

const describeHeading = (h: Heading): string =>
	`(${Arr.join(
		Arr.map(h, (c) => c.name),
		", "
	)})`

const isBool = (t: ScalarType): boolean => baseOf(t).carrier === "bool"

const windowArity: Readonly<Record<WindowFn, readonly [number, number]>> = {
	rowNumber: [0, 0],
	rank: [0, 0],
	denseRank: [0, 0],
	count: [0, 0],
	sum: [1, 1],
	avg: [1, 1],
	min: [1, 1],
	max: [1, 1],
	/** LEAD(value [, offset [, default]]). */
	lag: [1, 3],
	lead: [1, 3]
}

/**
 * The nodes whose rows are `root`'s delivered rows, by label, outermost first: down the kept rows (rel.ts keptRowsOf)
 * and into the one arm of a union of one arm (dag.ts deliverySpine), each label read through the table.
 */
const spineNodes = (table: DagTable, root: NodeId): ReadonlyArray<NodeId> => {
	const nodes: Array<NodeId> = []
	const met = new Set<NodeId>()
	for (let node = nodeAt(table, root); node !== undefined && !met.has(node.id);) {
		met.add(node.id)
		nodes.push(node.id)
		const arms: ReadonlyArray<NodeId> =
			node.kind === "Union" ? Arr.flatMap(node.groups, (g) => g.arms) : []
		if (arms.length > 1) {
			return nodes
		}
		const next = node.kind === "Union" ? arms[0] : keptRowsOf(node)?.input
		node = next === undefined ? undefined : nodeAt(table, next)
	}
	return nodes
}

/**
 * Records in `placed` every delivery node on `root`'s delivered rows: the ordered results and attachments on its spine,
 * its attachments' children's spines, and the spines of the arms of the union of several arms it ends at.
 */
const placeDeliveries = (table: DagTable, root: NodeId, placed: Set<NodeId>): void => {
	for (let node = nodeAt(table, root); node !== undefined && !placed.has(node.id);) {
		if (node.kind === "Attach") {
			placed.add(node.id)
			placeDeliveries(table, node.child, placed)
		} else if (node.kind === "OrderedResult") {
			placed.add(node.id)
		}
		const arms: ReadonlyArray<NodeId> =
			node.kind === "Union" ? Arr.flatMap(node.groups, (g) => g.arms) : []
		if (arms.length > 1) {
			for (const arm of arms) {
				placeDeliveries(table, arm, placed)
			}
			return
		}
		const next = node.kind === "Union" ? arms[0] : keptRowsOf(node)?.input
		node = next === undefined ? undefined : nodeAt(table, next)
	}
}

/**
 * The delivery nodes (attachments and ordered results) `root` reaches through data inputs that lie off its delivered
 * rows: off its spine, its attachments' children's spines and the spines of the arms it ends at, each once.
 */
const misplacedDeliveries = (table: DagTable, root: NodeId): ReadonlyArray<NodeId> => {
	const placed = new Set<NodeId>()
	placeDeliveries(table, root, placed)
	return Arr.filter(
		reachFrom([root], (id) => {
			const node = nodeAt(table, id)
			return node === undefined ? [] : inputsOf(node)
		}),
		(id) => {
			const node = nodeAt(table, id)
			return (node?.kind === "Attach" || node?.kind === "OrderedResult") && !placed.has(id)
		}
	)
}

/**
 * The nodes reachable from `starts` through `next`, each once, breadth-first in first-visit order, the starts
 * included.
 */
const reachFrom = (
	starts: ReadonlyArray<NodeId>,
	next: (id: NodeId) => ReadonlyArray<NodeId>
): ReadonlyArray<NodeId> => {
	const seen = new Set<NodeId>(starts)
	const queue = [...starts]
	for (const id of queue) {
		const fresh = Arr.filter(next(id), (n) => !seen.has(n))
		for (const n of fresh) {
			seen.add(n)
		}
		appendAll(queue, fresh)
	}
	return queue
}

/** The nodes that read each node of a table as a data input. */
const consumersOf = (table: DagTable): ReadonlyMap<NodeId, ReadonlyArray<NodeId>> => {
	const map = new Map<NodeId, ReadonlyArray<NodeId>>()
	for (const node of Rec.values(table.nodes)) {
		for (const input of inputsOf(node)) {
			map.set(input, [...(map.get(input) ?? []), node.id])
		}
	}
	return map
}

/** Whether two lists of ids hold the same ids, each list without repeats. */
const sameIds = (xs: ReadonlyArray<string>, ys: ReadonlyArray<string>): boolean =>
	xs.length === ys.length && Arr.every(xs, (x) => ys.includes(x))

/** The exact number of arguments of each aggregate: count(*) has none, every other one. */
const aggregateArity = (fn: AggregateFn): number => (fn === "count" ? 0 : 1)

/**
 * The window functions whose result depends on the order of rows within a partition rather than only on their set, so
 * their order must be total: ROW_NUMBER, and LEAD and LAG, which read a neighbouring row.
 */
export const orderSensitiveWindowFns: ReadonlyArray<WindowFn> = ["rowNumber", "lag", "lead"]

const windowAggregates: ReadonlyArray<WindowFn> = ["count", "sum", "avg", "min", "max"]
const bigintResults: ReadonlyArray<WindowFn> = ["rowNumber", "rank", "denseRank", "count"]

/**
 * Every table node after its inputs (each data input a node of the table, through no cycle), from the table's nodes
 * in table order; undefined when an input dangles or the inputs close a cycle, which no DAG of direct references has
 * and only a hand-made table can.
 */
const resolvedOrder = (table: DagTable): ReadonlyArray<TableNode> | undefined => {
	const order: Array<TableNode> = []
	const state = new Map<NodeId, "open" | "done">()
	for (const start of Rec.values(table.nodes)) {
		if (state.has(start.id)) {
			continue
		}
		state.set(start.id, "open")
		const stack: Array<{
			readonly node: TableNode
			readonly inputs: ReadonlyArray<NodeId>
			next: number
		}> = [{ node: start, inputs: inputsOf(start), next: 0 }]
		for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
			const id = frame.inputs[frame.next]
			if (id === undefined) {
				stack.pop()
				state.set(frame.node.id, "done")
				order.push(frame.node)
				continue
			}
			frame.next++
			const input = nodeAt(table, id)
			const reached = state.get(id)
			if (input === undefined || reached === "open") {
				return undefined
			}
			if (reached === undefined) {
				state.set(id, "open")
				stack.push({ node: input, inputs: inputsOf(input), next: 0 })
			}
		}
	}
	return order
}

/** Columns of other nodes, by label. */
type OuterRefs = ReadonlyMap<NodeId, ReadonlySet<string>>

/**
 * What the re-reader computes of a node again, independently of its records and of the compiler's own walks: its
 * lexical parameter and read dependencies (dag.ts relNode), and its scope's outer references (dag.ts nodeScopes).
 */
interface Recomputed {
	readonly params: ReadonlyArray<string>
	readonly reads: ReadonlyArray<string>
	readonly outer: OuterRefs
}

/**
 * The outer references of `node` from its inputs': the column references its scope expressions make, and its inputs'
 * outer references, but those to a node it binds: itself, the nodes its scope expressions are evaluated over (a
 * region's sources, a take's input), and, for an input it evaluates per row of another, the nodes that row supplies
 * (an attachment's child: its parent's delivered rows; a semi-join's or anti-join's right side: its left).
 */
const outerOf = (
	table: DagTable,
	node: TableNode,
	inputs: ReadonlyArray<{ readonly id: NodeId; readonly outer: OuterRefs }>
): OuterRefs => {
	const over: ReadonlyArray<NodeId> =
		node.kind === "MatchRegion"
			? Arr.map(node.occurrences, (o) => o.source)
			: node.kind === "Take"
				? [node.input]
				: []
	const perRow: ReadonlyArray<{ readonly input: NodeId; readonly rows: ReadonlyArray<NodeId> }> =
		node.kind === "Attach"
			? [{ input: node.child, rows: spineNodes(table, node.parent) }]
			: node.kind === "SemiJoin" || node.kind === "AntiJoin"
				? [{ input: node.right, rows: [node.left] }]
				: []
	const binds = (rows: ReadonlyArray<NodeId>, id: NodeId): boolean =>
		id === node.id || over.includes(id) || rows.includes(id)
	const outer = new Map<NodeId, Set<string>>()
	const add = (id: NodeId, column: string): void => {
		outer.set(id, new Set([...(outer.get(id) ?? []), column]))
	}
	for (const e of closureOf(table, scopeExprs(node))) {
		if (e.kind === "column" && !binds([], e.column.node)) {
			add(e.column.node, e.column.name)
		}
	}
	for (const input of inputs) {
		const rows = Arr.flatMap(perRow, (p) => (p.input === input.id ? p.rows : []))
		for (const [id, columns] of input.outer) {
			if (!binds(rows, id)) {
				for (const c of columns) {
					add(id, c)
				}
			}
		}
	}
	return outer
}

/** Every node's recomputed dependencies and outer references, over a resolved order (resolvedOrder). */
const recompute = (
	table: DagTable,
	order: ReadonlyArray<TableNode>
): ReadonlyMap<NodeId, Recomputed> => {
	const out = new Map<NodeId, Recomputed>()
	for (const node of order) {
		const params = new Set<string>(fieldParams(node))
		for (const e of closureOf(table, exprsOf(node))) {
			if (e.kind === "param") {
				params.add(e.param)
			}
		}
		const reads = new Set<string>(node.kind === "Base" ? [node.relation] : [])
		const inputs: Array<{ readonly id: NodeId; readonly outer: OuterRefs }> = []
		for (const id of inputsOf(node)) {
			const known = out.get(id)
			if (known === undefined) {
				continue
			}
			for (const p of known.params) {
				params.add(p)
			}
			for (const r of known.reads) {
				reads.add(r)
			}
			inputs.push({ id, outer: known.outer })
		}
		out.set(node.id, {
			params: [...params],
			reads: [...reads],
			outer: outerOf(table, node, inputs)
		})
	}
	return out
}

class Checker {
	readonly table: DagTable
	readonly problems: Array<DagProblem> = []

	constructor(table: DagTable) {
		this.table = table
	}

	/** `rule`, broken at `path`, as `message` states what the DAG lacks there. */
	report(rule: DagRule, path: ReadonlyArray<string | number>, message: string) {
		this.problems.push({ path, rule, message })
	}

	headingOf(id: NodeId): Heading | undefined {
		return nodeAt(this.table, id)?.heading
	}

	exprType(id: ExprId): ScalarType | undefined {
		return exprAt(this.table, id)?.type
	}

	#consumers: ReadonlyMap<NodeId, ReadonlyArray<NodeId>> | undefined = undefined

	/** The nodes that read each node as a data input. */
	consumers(): ReadonlyMap<NodeId, ReadonlyArray<NodeId>> {
		this.#consumers ??= consumersOf(this.table)
		return this.#consumers
	}

	/** The nodes reachable from `start` through data inputs, `start` included. */
	reach(start: NodeId): ReadonlySet<NodeId> {
		return new Set(
			reachFrom([start], (id) => {
				const node = nodeAt(this.table, id)
				return node === undefined ? [] : inputsOf(node)
			})
		)
	}

	run(): void {
		const { table } = this
		this.checkIdentities()
		for (const node of Rec.values(table.nodes)) {
			this.checkNames(node)
		}
		for (const expr of Rec.values(table.exprs)) {
			this.checkExpr(expr)
		}
		/**
		 * A table built from direct references (dag.ts toTable) holds every data input and expression it names, through
		 * no cycle; the kind rules read headings through references, so they run over a table that does.
		 */
		const order = resolvedOrder(table)
		if (
			order === undefined ||
			firstArgumentCycle(table.exprs, Rec.keys(table.exprs)) !== undefined
		) {
			this.report(
				"a data input or argument names an entry of the table, through no cycle",
				["nodes"],
				"data inputs and expression arguments that name entries of the table, through no cycle"
			)
			return
		}
		for (const node of Rec.values(table.nodes)) {
			this.checkMeta(node)
			this.checkNode(node)
		}
		this.checkDependencies(recompute(table, order))
		if (this.problems.length === 0) {
			this.checkDeliveryPlacement()
		}
	}

	/**
	 * Every delivery node a root reaches lies on that root's delivered rows: an attachment or ordered result read off
	 * them is delivered by no statement. Each misplaced node is reported once, at the first root that misplaces it.
	 */
	checkDeliveryPlacement(): void {
		const reported = new Set<NodeId>()
		for (const root of this.table.roots) {
			for (const id of Arr.filter(
				misplacedDeliveries(this.table, root),
				(misplaced) => !reported.has(misplaced)
			)) {
				reported.add(id)
				this.report(
					"a delivery node lies on its root's delivered rows",
					["nodes", id],
					`a delivery node on the delivered rows of every root that reaches it; the root ${root} reads it off them, where no statement delivers it`
				)
			}
		}
	}

	/** The logical claims a node's metadata makes are about its own heading. */
	checkMeta(node: TableNode): void {
		const path = ["nodes", node.id, "meta"]
		const { meta, heading } = node
		const seen: Array<ReadonlySet<string>> = []
		for (const [i, claimed] of meta.logicalKeys.entries()) {
			const key = claimed.key
			this.requireColumns(
				"a logical key names heading columns",
				[...path, "logicalKeys", i],
				heading,
				key,
				"a logical key column"
			)
			if (key.length === 0 && meta.card === "many") {
				this.report(
					"the empty key needs at most one row",
					[...path, "logicalKeys", i],
					"the empty key only on a node of at most one row (card atMostOne or one), not on card many"
				)
			}
			const set = new Set(key)
			if (
				Arr.some(
					seen,
					(other) => other.size === set.size && Arr.every([...set], (c) => other.has(c))
				)
			) {
				this.report(
					"logical keys are distinct",
					[...path, "logicalKeys", i],
					`distinct logical keys; (${Arr.join(key, ", ")}) repeats`
				)
			}
			seen.push(set)
		}
	}

	/**
	 * Every node's structural fields are the recomputed ones (lexical: its own and its inputs', dag.ts relNode), as an
	 * expression's dependencies are: a stale parameter or read record would let a cache or an invalidation miss a
	 * dependency. And every root's recomputed scope is closed (checkRootScopes).
	 */
	checkDependencies(computed: ReadonlyMap<NodeId, Recomputed>): void {
		this.checkRootScopes(computed)
		this.checkSemiJoinRights(computed)
		for (const node of Rec.values(this.table.nodes)) {
			const deps = computed.get(node.id)
			if (deps === undefined) {
				continue
			}
			if (!sameIds(node.meta.paramDeps, deps.params)) {
				this.report(
					"a node's parameter dependencies are the computed ones",
					["nodes", node.id, "meta", "paramDeps"],
					`parameter dependencies equal to the computed [${Arr.join(deps.params, ", ")}]`
				)
			}
			if (!sameIds(node.meta.reads, deps.reads)) {
				this.report(
					"a node's read dependencies are the computed ones",
					["nodes", node.id, "meta", "reads"],
					`read dependencies equal to the computed [${Arr.join(deps.reads, ", ")}]`
				)
			}
		}
	}

	/**
	 * Every column a scope expression reads is bound by a scope on its way up to every root that reaches it (dag.ts
	 * nodeScopes): a root's statement is lowered with nothing in scope, so a reference reaching a root is read where no
	 * scope binds it, a lateral source's to a node its region does not scan (another occurrence's source's input), a
	 * correlated take's read where its region does not hold it. Each referenced node is reported once, at the first
	 * root it reaches.
	 */
	checkRootScopes(computed: ReadonlyMap<NodeId, Recomputed>): void {
		const reported = new Set<NodeId>()
		for (const root of this.table.roots) {
			const deps = computed.get(root)
			if (deps === undefined) {
				continue
			}
			for (const [id, columns] of Arr.filter([...deps.outer], ([outer]) => !reported.has(outer))) {
				reported.add(id)
				this.report(
					"a scope expression's column is bound on its way to every root",
					["nodes", id],
					`every column a scope expression reads bound by a scope on its way to a root; ${Arr.join(
						Arr.map([...columns], (c) => `${id}.${c}`),
						", "
					)} reaches the root ${root} unbound`
				)
			}
		}
	}

	/**
	 * A semi-join's right side reads no column of its left (dag.ts nodeScopes binds the left for it, as it does an
	 * anti-join's, whose negation reads the rule's variables): the right side is one relation per evaluation of the
	 * semi-join, so a column it fixes is fixed there, and a left column paired with it is too (logical/props.ts, the
	 * key kernel's semiJoinPair). Read per left row, the right side's fixed column would hold one value per left row.
	 * The engine's node types hold it (ir/rel.ts SemiJoinRight: a semi-join's right side is only what semiJoinRight
	 * minted, reading the right side's subtree); this rule re-reads it over the outside form, where a node is its label
	 * and holds no brand.
	 */
	checkSemiJoinRights(computed: ReadonlyMap<NodeId, Recomputed>): void {
		for (const node of Rec.values(this.table.nodes)) {
			if (node.kind !== "SemiJoin") {
				continue
			}
			const read = computed.get(node.right)?.outer.get(node.left)
			if (read !== undefined) {
				this.report(
					"a semi-join's right side reads nothing of its left",
					["nodes", node.id, "right"],
					`a right side that reads no column of the left ${node.left}, not ${Arr.join(
						Arr.map([...read], (c) => `${node.left}.${c}`),
						", "
					)}`
				)
			}
		}
	}

	/**
	 * Every column an expression evaluated over `input`'s rows reads is a column of `input`. Returns the columns read,
	 * for the rules that restrict them further.
	 */
	requireScope(
		path: ReadonlyArray<string | number>,
		input: NodeId,
		exprs: ReadonlyArray<ExprId>,
		what: string
	): ReadonlyArray<string> {
		const columns: Array<string> = []
		for (const expr of closureOf(this.table, exprs)) {
			if (expr.kind !== "column") {
				continue
			}
			if (expr.column.node === input) {
				columns.push(expr.column.name)
			} else {
				this.report(
					"an expression reads its node's input only",
					path,
					`${what} reading its input ${input} only, not ${expr.column.node}.${expr.column.name}, which is out of scope`
				)
			}
		}
		return columns
	}

	/**
	 * The literal expression an arm binds `column` to: the projected literal, looked up through every node that keeps
	 * its input's rows (rel.ts keptRowsOf), pages and law checks included, since a kept row's values are its input row's
	 * (an arm may attach before it joins a union). The kind rules run once the data edges are acyclic, so the walk ends.
	 */
	literalBinding(arm: NodeId, column: string): TableExprOf<"literal"> | undefined {
		for (let node = nodeAt(this.table, arm); node !== undefined;) {
			if (node.kind === "ProjectSet") {
				const out = Arr.findFirst(node.out, (o) => o.name === column)
				const expr = Option.isNone(out) ? undefined : exprAt(this.table, out.value.expr)
				return expr?.kind === "literal" ? expr : undefined
			}
			const kept = keptRowsOf(node)
			node = kept === undefined ? undefined : nodeAt(this.table, kept.input)
		}
		return undefined
	}

	/**
	 * The discriminant is bound in every arm to a literal, and arms of different headings carry different literal
	 * tuples.
	 */
	checkDiscriminant(node: TableOf<"Union">): void {
		const path = ["nodes", node.id]
		const tuples: Array<ReadonlyArray<string>> = Arr.map(node.groups, (g, gi) =>
			Arr.flatMap(g.arms, (arm, ai) => {
				const values: Array<string> = []
				for (const column of node.discriminant) {
					const literal = this.literalBinding(arm, column)
					if (literal === undefined) {
						this.report(
							"every arm binds the discriminant to a literal",
							[...path, "groups", gi, "arms", ai],
							`a discriminant ${column} that the arm ${arm} binds to a literal`
						)
						return []
					}
					if (literalProblem(literal.value, literal.type) !== undefined) {
						return []
					}
					values.push(nativeEqualityKey(literal.value))
				}
				return [Arr.join(values, "\u0000")]
			})
		)
		const clashes = Arr.flatMap(tuples, (mine, gi) =>
			Arr.flatMap(tuples.slice(0, gi), (theirs, other) =>
				Arr.map(
					Arr.filter(mine, (tuple) => theirs.includes(tuple)),
					() => ({ gi, other })
				)
			)
		)
		for (const { gi, other } of clashes) {
			this.report(
				"arms of different headings differ in their discriminant literals",
				[...path, "groups", gi],
				`discriminant literals that differ from those of group ${other}, which has another heading`
			)
		}
	}

	/** The region each variable is declared in, as checkIdentities meets them. */
	readonly #declared = new Map<VarId, NodeId>()

	/** Records a region's variables, reporting one declared twice anywhere or a name repeated in the region. */
	declareVars(node: TableOf<"MatchRegion">): void {
		const names = new Set<string>()
		for (const [i, v] of node.vars.entries()) {
			const prior = this.#declared.get(v.id)
			if (prior !== undefined) {
				this.report(
					prior === node.id
						? "a region declares a variable once"
						: "a variable is declared by one region",
					["nodes", node.id, "vars", i],
					`a variable declared once; ${v.id} is also declared in ${prior}`
				)
			}
			this.#declared.set(v.id, node.id)
			if (names.has(v.name)) {
				this.report(
					"a region's variables have distinct names",
					["nodes", node.id, "vars", i],
					`distinct variable names; ${v.name} repeats`
				)
			}
			names.add(v.name)
		}
	}

	checkIdentities(): void {
		const occurrences = new Map<OccurrenceId, NodeId>()
		const claimOccurrence = (id: OccurrenceId, node: NodeId) => {
			const prior = occurrences.get(id)
			if (prior !== undefined) {
				this.report(
					"an occurrence id is fresh",
					["nodes", node],
					`a fresh occurrence id; ${id} also scans in ${prior}`
				)
			}
			occurrences.set(id, node)
		}
		for (const node of Rec.values(this.table.nodes)) {
			if (node.kind === "Base") {
				claimOccurrence(node.occurrence, node.id)
			}
			if (node.kind !== "MatchRegion") {
				continue
			}
			this.declareVars(node)
			for (const o of node.occurrences) {
				claimOccurrence(o.id, node.id)
			}
		}
		for (const node of Rec.values(this.table.nodes)) {
			if (node.kind !== "MatchRegion") {
				continue
			}
			/** Every binding, equality and correlation of a region names one of the region's own variables. */
			const local = new Set(Arr.map(node.vars, (v) => v.id))
			const uses = [
				...Arr.flatMap(node.occurrences, (o) => Arr.map(o.bindings, (b) => b.var)),
				...Arr.flatMap(node.equalities, (e) => [e.a, e.b]),
				...Arr.map(node.correlated, (c) => c.var)
			]
			for (const v of Arr.filter(uses, (used) => !local.has(used))) {
				const owner = this.#declared.get(v)
				this.report(
					owner === undefined
						? "a binding names a declared variable"
						: "a region binds its own variables only",
					["nodes", node.id],
					owner === undefined
						? `a declared variable, not the dangling ${v}`
						: `${v} declared by this region, not by ${owner}`
				)
			}
		}
	}

	/** Every node name a node holds beside its data edges names a node of the table: a feedback, a premise. */
	checkNames(node: TableNode): void {
		for (const name of namesOf(node)) {
			if (nodeAt(this.table, name.id) === undefined) {
				this.report(
					name.rule,
					["nodes", node.id],
					`a node named ${name.id} in the table, not a dangling reference`
				)
			}
		}
	}

	checkExpr(expr: TableExpr): void {
		const path = ["exprs", expr.id]
		const args: Array<TableExpr> = []
		for (const a of expr.args) {
			const arg = exprAt(this.table, a)
			if (arg !== undefined) {
				args.push(arg)
			}
		}
		/** Its volatility is its own joined with its arguments' (exprEffects): a stable argument makes it stable. */
		const effects = exprEffects(expr, args)
		if (effects.volatility !== expr.volatility) {
			this.report(
				"an expression is stable when an argument is",
				path,
				`${effects.volatility} volatility`
			)
		}
		for (const problem of this.kindProblems(expr, args)) {
			this.report(problem.rule, path, problem.message)
		}
		const params = new Set<string>()
		const nodes = new Set<string>()
		for (const e of closureOf(this.table, [expr.id])) {
			if (e.kind === "param") {
				params.add(e.param)
			}
			if (e.kind === "column") {
				nodes.add(e.column.node)
			}
		}
		if (!sameIds(expr.deps.params, [...params]) || !sameIds(expr.deps.nodes, [...nodes])) {
			this.report(
				"an expression's dependencies are the computed ones",
				path,
				"dependencies equal to the parameters and column nodes the expression reads"
			)
		}
	}

	/** The problems an expression's kind has of its own in a query DAG, given its arguments' entries. */
	kindProblems(expr: TableExpr, args: ReadonlyArray<TableExpr>): ReadonlyArray<ExprProblem> {
		switch (expr.kind) {
			case "column":
				return this.columnProblems(expr)
			case "value":
				return [
					{
						rule: "VALUE appears only in a contract predicate",
						message: "VALUE only inside a contract predicate, never in a query DAG"
					}
				]
			case "param":
				return expr.role === "compare" && isRefined(expr.type)
					? [
							{
								rule: "a comparison parameter is bound as its base type",
								message: "a comparison parameter bound as its base type, never a refined domain"
							}
						]
					: []
			case "literal": {
				const problem = literalProblem(expr.value, expr.type)
				return problem === undefined ? [] : [{ rule: "a literal fits its type", message: problem }]
			}
			case "domainCast":
				return !isRefined(expr.type)
					? [
							{
								rule: "a domain cast targets a refined type",
								message: "a contract or regex-refined target for a domain cast"
							}
						]
					: operationProofHolds(expr.proof, [{ kind: "contract" }], {
								type: expr.type,
								operand: args[0]?.type
						  })
						? []
						: [
								{
									rule: "a partial operation stands with a proof the kernel re-derives",
									message: "a proof the kernel re-derives from its premises"
								}
							]
			case "cond":
				return Arr.map(condProblems(expr.type, args), (message) => ({
					rule: "a conditional has a boolean condition and branches of its type",
					message
				}))
			case "cast":
				return "native" in expr
					? nativeProblems(expr.cast, expr.native, expr.type, args)
					: proofProblems(expr.cast, "proof" in expr ? expr.proof : undefined, expr.type, args)
			case "op":
				return "native" in expr
					? nativeProblems(expr.op, expr.native, expr.type, args)
					: proofProblems(expr.op, "proof" in expr ? expr.proof : undefined, expr.type, args)
			case "closedAt":
			case "closedRow":
				return [
					{
						rule: "a closed read stands only in a side's predicate or a generated field's expression",
						message:
							"a closed read only in a side's predicate or a generated field's expression, never in a query DAG"
					}
				]
			case "closedHas":
			case "call":
				return []
		}
	}

	/** A column reference names a column of a node in the table, at that column's type. */
	columnProblems(expr: TableExprOf<"column">): ReadonlyArray<ExprProblem> {
		const rule = "a column reference names a column of its node"
		const heading = this.headingOf(expr.column.node)
		if (heading === undefined) {
			return [
				{
					rule,
					message: `a column of a node in the table, not of the dangling ${expr.column.node}`
				}
			]
		}
		const column = columnOf(heading, expr.column.name)
		if (column === undefined) {
			return [
				{
					rule,
					message: `a column of ${expr.column.node} ${describeHeading(heading)}, not ${expr.column.name}`
				}
			]
		}
		return sameScalarType(column.type, expr.type)
			? []
			: [
					{
						rule: "a column reference keeps its column's type",
						message: `the type of ${expr.column.node}.${expr.column.name}; a column reference is never cast`
					}
				]
	}

	/** Columns named by the node must exist in `heading`. */
	requireColumns(
		rule: DagRule,
		path: ReadonlyArray<string | number>,
		heading: Heading | undefined,
		columns: ReadonlyArray<string>,
		what: string
	) {
		if (heading === undefined) {
			return
		}
		for (const c of columns) {
			if (!hasColumn(heading, c)) {
				this.report(rule, path, `${what} ${c} in ${describeHeading(heading)}`)
			}
		}
	}

	/**
	 * The columns `ordered` (order keys plus columns fixed per evaluation: partition, correlation) make the order of
	 * `input`'s rows total: they cover its whole heading, or one of its keys (a logical key by a column of each of its
	 * classes, or a Base's declared key). Ties would otherwise make take(k), pages and ordinals nondeterministic.
	 */
	requireTotalOrder(
		path: ReadonlyArray<string | number>,
		inputId: NodeId,
		ordered: ReadonlyArray<string>,
		what: string
	) {
		const input = nodeAt(this.table, inputId)
		if (input === undefined) {
			return
		}
		const covered = new Set(ordered)
		const declared = input.kind === "Base" ? [input.primaryKey, ...input.keys] : []
		const holds = (c: string) => covered.has(c)
		if (
			Arr.every(input.heading, (c) => covered.has(c.name)) ||
			Arr.some(input.meta.logicalKeys, (k) => keyIn(k, holds) !== undefined) ||
			Arr.some(declared, (k) => Arr.every(k, holds))
		) {
			return
		}
		this.report(
			"an order is total",
			path,
			`${what}: a completed total order, its columns covering ${describeHeading(input.heading)} or a key of it`
		)
	}

	/**
	 * A SelfRef is the single feedback reference of its Recursive, read by its step: the step reaches
	 * it, and every node that depends on it other than through the Recursive lies in the step, so the base is
	 * nonrecursive and no reader outside the recursion sees the working relation.
	 */
	checkFeedbackScope(rec: TableOf<"Recursive">): void {
		const self = nodeAt(this.table, rec.self)
		if (self?.kind !== "SelfRef" || self.recursive !== rec.id) {
			return
		}
		const step = this.reach(rec.step)
		if (!step.has(rec.self)) {
			this.report(
				"a recursion's step reads its feedback",
				["nodes", rec.id, "step"],
				`a step that reads its feedback reference ${rec.self}`
			)
		}
		const dependents = new Set(
			reachFrom([rec.self], (id) =>
				Arr.filter(this.consumers().get(id) ?? [], (reader) => reader !== rec.id)
			).slice(1)
		)
		if (rec.base === rec.self || dependents.has(rec.base)) {
			this.report(
				"a recursion's base never reads its feedback",
				["nodes", rec.id, "base"],
				`a nonrecursive base that does not read the feedback reference ${rec.self}`
			)
		}
		for (const d of dependents) {
			if (!step.has(d)) {
				this.report(
					"only the step reads the feedback",
					["nodes", d],
					`a reader of ${rec.self} only inside the step of ${rec.id}, not outside it`
				)
			}
		}
	}

	/**
	 * The delivered shape follows the child's evidence relative to the parent's variables, and wider is the only sound
	 * direction: the bare child needs card one; an option needs card atMostOne or one, or the correlated child columns
	 * covering a key of the child, a logical one by a column of each of its classes; an array is always sound. A
	 * completed order is the order of a delivered array, which alone carries one (rel.ts AttachDelivery).
	 */
	checkDelivered(node: TableOf<"Attach">, child: TableNode): void {
		const path = ["nodes", node.id, "delivered"]
		const card = child.meta.card
		const bound = new Set(Arr.map(node.correlation, (c) => c.child))
		const declared = child.kind === "Base" ? [child.primaryKey, ...child.keys] : []
		const holds = (c: string) => bound.has(c)
		const keyBound =
			Arr.some(child.meta.logicalKeys, (k) => keyIn(k, holds) !== undefined) ||
			Arr.some(declared, (k) => Arr.every(k, holds))
		if (node.delivered === "one" && card !== "one") {
			this.report(
				"an attachment delivers no narrower than its child's evidence",
				path,
				`a bare child only over evidence of exactly one row per parent, not card ${card}`
			)
		}
		if (node.delivered === "option" && card === "many" && !keyBound) {
			this.report(
				"an attachment delivers no narrower than its child's evidence",
				path,
				"an option only over a child of at most one row per parent: card atMostOne or one, or correlated child columns covering a key of the child"
			)
		}
	}

	requireHeading(node: TableNode, expected: Heading | undefined, what: string) {
		if (expected !== undefined && !sameColumns(node.heading, expected)) {
			this.report(
				headingRule(node.heading, expected),
				["nodes", node.id, "heading"],
				`the heading of ${what} ${describeHeading(expected)}, not ${describeHeading(node.heading)}`
			)
		}
	}

	checkNode(node: TableNode): void {
		const path = ["nodes", node.id]
		const heading = node.heading
		switch (node.kind) {
			case "Base":
				this.requireColumns(
					"a declared key names columns of the heading",
					path,
					heading,
					node.primaryKey,
					"a primary key column"
				)
				for (const key of node.keys) {
					this.requireColumns(
						"a declared key names columns of the heading",
						path,
						heading,
						key,
						"a key column"
					)
				}
				return
			case "Closed":
				this.checkClosed(node, path, heading)
				return
			case "InputSet":
				if (heading.length === 0) {
					this.report(
						"a relation parameter or a context has a column",
						path,
						"a relation parameter with at least one column"
					)
				}
				return
			case "Context":
				if (heading.length === 0) {
					this.report(
						"a relation parameter or a context has a column",
						path,
						"a context with at least one column"
					)
				}
				return
			case "Delta":
				for (const key of node.keys) {
					this.requireColumns(
						"a declared key names columns of the heading",
						path,
						heading,
						key,
						"a key column"
					)
				}
				return
			case "MatchRegion":
				this.checkRegion(node, path, heading)
				return
			case "Filter": {
				this.requireHeading(node, this.headingOf(node.input), "its input")
				this.requireScope([...path, "pred"], node.input, [node.pred], "a predicate")
				const t = this.exprType(node.pred)
				if (t !== undefined && !isBool(t)) {
					this.report("a filter's predicate is boolean", path, "a boolean predicate")
				}
				return
			}
			case "ProjectSet": {
				this.requireScope(
					[...path, "out"],
					node.input,
					Arr.map(node.out, (o) => o.expr),
					"a projection"
				)
				const names = Arr.map(node.out, (o) => o.name)
				const ok =
					heading.length === node.out.length &&
					Arr.every(node.out, (o, i) => {
						const t = this.exprType(o.expr)
						const col = heading[i]
						return (
							col !== undefined &&
							col.name === o.name &&
							(t === undefined || sameScalarType(t, col.type))
						)
					})
				const named =
					heading.length === node.out.length &&
					Arr.every(node.out, (o, i) => heading[i]?.name === o.name)
				if (!ok) {
					this.report(
						named
							? "a heading column has the type its kind defines"
							: "a heading is the one its kind defines",
						[...path, "heading"],
						`the projected heading (${Arr.join(names, ", ")}) at the output types`
					)
				}
				return
			}
			case "SemiJoin":
			case "AntiJoin":
				this.checkCorrelated(node, path)
				return
			case "Union":
				this.checkUnion(node, path, heading)
				return
			case "Intersect":
			case "Difference": {
				const left = this.headingOf(node.left)
				const right = this.headingOf(node.right)
				if (left !== undefined && right !== undefined && !sameColumnSet(left, right)) {
					this.report(
						"set operation inputs have equal headings",
						path,
						"compatible headings: equal columns at equal types"
					)
				}
				this.requireHeading(node, left, "its left input")
				return
			}
			case "Take": {
				this.requireHeading(node, this.headingOf(node.input), "its input")
				const ordered = Arr.map(node.order.keys, (k) => k.column)
				const correlated = Arr.map(node.correlation, (c) => c.column)
				this.requireColumns(
					"a column a node names lies in the heading it reads",
					path,
					heading,
					ordered,
					"an order column"
				)
				this.requireColumns(
					"a column a node names lies in the heading it reads",
					path,
					heading,
					correlated,
					"a correlated column"
				)
				this.requireTotalOrder([...path, "order"], node.input, [...ordered, ...correlated], "take")
				return
			}
			case "Group":
				this.checkGroup(node, path, heading)
				return
			case "Produce": {
				const input = this.headingOf(node.input)
				this.requireColumns(
					"a column a node names lies in the heading it reads",
					path,
					input,
					node.carried,
					"a carried column"
				)
				this.requireScope([...path, "args"], node.input, node.args, "a producer argument")
				const expected = [...node.carried, node.out]
				if (
					heading.length !== expected.length ||
					!Arr.every(expected, (n, i) => heading[i]?.name === n)
				) {
					this.report(
						"a heading is the one its kind defines",
						[...path, "heading"],
						`the produced heading (${Arr.join(expected, ", ")})`
					)
				}
				return
			}
			case "Recursive":
				this.checkRecursive(node, path, heading)
				return
			case "SelfRef": {
				const rec = nodeAt(this.table, node.recursive)
				if (rec?.kind !== "Recursive" || rec.self !== node.id) {
					this.report(
						"a recursion has one feedback reference",
						path,
						"a feedback reference to the Recursive node that names it as self"
					)
				} else {
					this.requireHeading(node, rec.heading, "its recursive relation")
				}
				return
			}
			case "ApproximateNearest": {
				const source = this.headingOf(node.source)
				this.requireHeading(node, source, "its source")
				const score = source === undefined ? undefined : columnOf(source, node.score)
				if (
					source !== undefined &&
					!(score !== undefined && baseOf(score.type).carrier === "float8")
				) {
					this.report(
						"an approximate search is sealed and scored by a double precision column",
						path,
						`a double precision cosine-distance column ${node.score}`
					)
				}
				return
			}
			case "Step":
				this.requireHeading(node, this.headingOf(node.input), "its input")
				return
			case "Call":
				if (heading.length === 0) {
					this.report(
						"a call's rows are its result's heading, of a column",
						path,
						"a call of at least one column"
					)
				}
				for (const arg of node.args) {
					if (arg.kind === "rows") {
						this.requireColumns(
							"a call's rows argument delivers its heading's fields",
							[...path, "args", arg.name],
							this.headingOf(arg.rows),
							Arr.map(arg.columns, (c) => c.name),
							"a field of the argument's heading"
						)
					}
				}
				return
			case "OrderedResult": {
				this.requireHeading(node, this.headingOf(node.input), "its input")
				const ordered = Arr.map(node.order.keys, (k) => k.column)
				this.requireColumns(
					"a column a node names lies in the heading it reads",
					path,
					heading,
					ordered,
					"an order column"
				)
				this.requireTotalOrder([...path, "order"], node.input, ordered, "an ordered result")
				return
			}
			case "Attach":
				this.checkAttach(node, path)
				return
			case "Forbid":
				this.requireHeading(node, this.headingOf(node.violation), "its violation query")
				return
			case "Window":
				this.checkWindow(node, path, heading)
				return
			case "OrderedSetAggregate":
				this.checkOrderedSetAggregate(node, path, heading)
				return
		}
	}

	/** A closed relation's rows: each a value per column of its type, and no two the same fact. */
	checkClosed(
		node: TableOf<"Closed">,
		path: ReadonlyArray<string | number>,
		heading: Heading
	): void {
		const seen = new Set<string>()
		const idAt = Arr.findFirstIndex(heading, (col) => col.name === "id")
		for (const [r, row] of node.rows.entries()) {
			if (row.length !== heading.length) {
				this.report(
					"a closed row has the heading's width",
					[...path, "rows", r],
					`a row of ${heading.length} values`
				)
				continue
			}
			/**
			 * The row has a value per column, so each value has its column. A row holding a value that is no value
			 * of its column's type has no native identity to compare.
			 */
			const unfit = Arr.flatMap(row, (value, c) => {
				const col = heading[c]
				const problem = col === undefined ? undefined : literalProblem(value, col.type)
				return problem === undefined ? [] : [{ c, problem }]
			})
			for (const { c, problem } of unfit) {
				this.report("a literal fits its type", [...path, "rows", r, c], problem)
			}
			if (unfit.length > 0) {
				continue
			}
			const handle = Option.isNone(idAt) ? undefined : row[idAt.value]
			const key = Arr.join(
				Arr.map(handle === undefined ? row : [handle], nativeEqualityKey),
				"\u0000"
			)
			if (seen.has(key)) {
				this.report(
					"closed facts are distinct under native equality",
					[...path, "rows", r],
					"distinct closed facts: a set has no repeats"
				)
			}
			seen.add(key)
		}
	}

	/** A region's occurrences, equalities and heading, each at its variables' types. */
	checkRegion(
		node: TableOf<"MatchRegion">,
		path: ReadonlyArray<string | number>,
		heading: Heading
	): void {
		const vars = new Map(Arr.map(node.vars, (v) => [v.id, v] as const))
		for (const [i, o] of node.occurrences.entries()) {
			this.checkOccurrence(o, [...path, "occurrences", i], vars)
		}
		for (const [i, e] of node.equalities.entries()) {
			const a = vars.get(e.a)
			const b = vars.get(e.b)
			if (a !== undefined && b !== undefined && !sameScalarType(baseOf(a.type), baseOf(b.type))) {
				this.report(
					"equated variables have one base type",
					[...path, "equalities", i],
					"equated variables of one base type"
				)
			}
		}
		for (const [i, col] of heading.entries()) {
			const v = Arr.findFirst(node.vars, (d) => d.name === col.name)
			if (Option.isNone(v)) {
				this.report(
					"a heading is the one its kind defines",
					[...path, "heading", i],
					`a region column naming one of its variables, not ${col.name}`
				)
			} else if (!sameScalarType(v.value.type, col.type)) {
				this.report(
					"a heading column has the type its kind defines",
					[...path, "heading", i],
					`${col.name} at its variable's type`
				)
			}
		}
	}

	/**
	 * An occurrence's bindings and constants: columns of its source at the types of their variables, and constants of
	 * the column's base type or of the exact family it widens into (types.ts meets), compared as values.
	 */
	checkOccurrence(
		o: TableOf<"MatchRegion">["occurrences"][number],
		path: ReadonlyArray<string | number>,
		vars: ReadonlyMap<VarId, TableOf<"MatchRegion">["vars"][number]>
	): void {
		const source = this.headingOf(o.source)
		if (source === undefined) {
			return
		}
		for (const b of o.bindings) {
			const col = columnOf(source, b.column)
			const v = vars.get(b.var)
			if (col === undefined) {
				this.report(
					"an occurrence reads columns of its source at their types",
					path,
					`a source column ${b.column} in ${describeHeading(source)}`
				)
			} else if (v !== undefined && !sameScalarType(col.type, v.type)) {
				this.report(
					"an occurrence reads columns of its source at their types",
					path,
					`${b.var} of the type of ${b.column}`
				)
			}
		}
		for (const c of o.constants) {
			const col = columnOf(source, c.column)
			const t = this.exprType(c.expr)
			if (col === undefined) {
				this.report(
					"an occurrence reads columns of its source at their types",
					path,
					`a source column ${c.column} in ${describeHeading(source)}`
				)
			} else if (
				t !== undefined &&
				!sameScalarType(baseOf(col.type), baseOf(t)) &&
				!meets(baseOf(col.type), baseOf(t))
			) {
				this.report(
					"an occurrence reads columns of its source at their types",
					path,
					`a constant for ${c.column} of its base type or its exact family`
				)
			}
		}
	}

	/** A semi- or anti-join's correlated column pairs: one column of each input, of one base type. */
	checkCorrelated(
		node: TableOf<"SemiJoin" | "AntiJoin">,
		path: ReadonlyArray<string | number>
	): void {
		const left = this.headingOf(node.left)
		const right = this.headingOf(node.right)
		this.requireHeading(node, left, "its left input")
		for (const [i, p] of node.on.entries()) {
			const l = columnIn(left, p.left)
			const r = columnIn(right, p.right)
			if (l === undefined || r === undefined) {
				this.report(
					"join columns exist on both sides at one base type",
					[...path, "on", i],
					`columns ${p.left} and ${p.right} of the two inputs`
				)
			} else if (!sameScalarType(baseOf(l.type), baseOf(r.type))) {
				this.report(
					"join columns exist on both sides at one base type",
					[...path, "on", i],
					"correlated columns of one base type"
				)
			}
		}
	}

	/** A union group: every arm delivers the group's heading, and no earlier group has that heading. */
	checkUnionGroup(
		node: TableOf<"Union">,
		gi: number,
		g: TableOf<"Union">["groups"][number],
		path: ReadonlyArray<string | number>
	): void {
		for (const [ai, arm] of g.arms.entries()) {
			const h = this.headingOf(arm)
			if (h !== undefined && !sameColumnSet(h, g.heading)) {
				this.report(
					"an arm has its group's heading",
					[...path, "arms", ai],
					`an arm of the group heading ${describeHeading(g.heading)}`
				)
			}
		}
		for (const prior of node.groups.slice(0, gi)) {
			if (sameColumnSet(prior.heading, g.heading)) {
				this.report(
					"a union's groups have distinct headings",
					path,
					"distinct group headings; arms of one heading share a group"
				)
			}
		}
	}

	checkUnion(node: TableOf<"Union">, path: ReadonlyArray<string | number>, heading: Heading): void {
		for (const [gi, g] of node.groups.entries()) {
			this.checkUnionGroup(node, gi, g, [...path, "groups", gi])
		}
		if (node.groups.length > 1) {
			if (node.discriminant.length === 0) {
				this.report(
					"a union of several headings has a discriminant",
					path,
					"a literal discriminant present in every arm"
				)
			}
			for (const [gi, g] of node.groups.entries()) {
				this.requireColumns(
					"a column a node names lies in the heading it reads",
					[...path, "groups", gi],
					g.heading,
					node.discriminant,
					"a discriminant column"
				)
			}
			if (node.discriminant.length > 0) {
				this.checkDiscriminant(node)
			}
		}
		this.requireColumns(
			"a column a node names lies in the heading it reads",
			path,
			heading,
			node.discriminant,
			"a discriminant column"
		)
		const common = Arr.every(heading, (col) =>
			Arr.every(node.groups, (g) => {
				const other = columnOf(g.heading, col.name)
				return other !== undefined && sameScalarType(other.type, col.type)
			})
		)
		const named =
			(node.groups.length > 1 || heading.length === node.groups[0].heading.length) &&
			Arr.every(heading, (col) => Arr.every(node.groups, (g) => hasColumn(g.heading, col.name)))
		if (node.groups.length === 1 ? !sameColumnSet(heading, node.groups[0].heading) : !common) {
			this.report(
				named
					? "a heading column has the type its kind defines"
					: "a heading is the one its kind defines",
				[...path, "heading"],
				"the union's heading: its group's, or the columns common to every group"
			)
		}
	}

	/** A group's aggregate: it reads the bound tuple only, takes its fold's arity, filters only a count by a boolean, and has a name of its own. */
	checkAggregate(
		node: TableOf<"Group">,
		a: TableOf<"Group">["aggs"][number],
		path: ReadonlyArray<string | number>
	): void {
		/** The fold is defined over the distinct bound tuple, so it reads nothing outside it. */
		const read = this.requireScope(
			path,
			node.input,
			[...a.args, ...(a.filter === undefined ? [] : [a.filter])],
			"an aggregate"
		)
		for (const c of new Set(read)) {
			if (!node.bound.columns.includes(c)) {
				this.report(
					"an aggregate reads only its bound tuple",
					path,
					`an aggregate reading columns of the bound tuple only, not ${c}`
				)
			}
		}
		const arity = aggregateArity(a.fn)
		if (a.args.length !== arity) {
			this.report(
				"an aggregate has its arity",
				path,
				`${arity} argument(s) for ${a.fn}, not ${a.args.length}`
			)
		}
		if (a.filter !== undefined) {
			if (a.fn !== "count") {
				this.report(
					"only a count is filtered",
					path,
					"a filter on count only; a conditional sum is sum(CASE ...)"
				)
			}
			const t = this.exprType(a.filter)
			if (t !== undefined && !isBool(t)) {
				this.report("a filter's predicate is boolean", path, "a boolean filter")
			}
		}
		if (node.keys.includes(a.name)) {
			this.report(
				"an aggregate's name differs from its group's keys",
				path,
				`an aggregate name distinct from the keys, not ${a.name}`
			)
		}
	}

	checkGroup(node: TableOf<"Group">, path: ReadonlyArray<string | number>, heading: Heading): void {
		const input = this.headingOf(node.input)
		this.requireColumns(
			"a column a node names lies in the heading it reads",
			path,
			input,
			node.bound.columns,
			"a bound column"
		)
		for (const k of node.keys) {
			if (!node.bound.columns.includes(k)) {
				this.report(
					"a group's keys lie in its bound tuple",
					path,
					`a group key within the bound tuple, not ${k}`
				)
			}
		}
		for (const [i, a] of node.aggs.entries()) {
			this.checkAggregate(node, a, [...path, "aggs", i])
		}
		const expected = [...node.keys, ...Arr.map(node.aggs, (a) => a.name)]
		const keysTyped = Arr.every(node.keys, (k) => {
			const inCol = columnIn(input, k)
			const outCol = columnOf(heading, k)
			return (
				inCol === undefined || (outCol !== undefined && sameScalarType(inCol.type, outCol.type))
			)
		})
		if (
			heading.length !== expected.length ||
			!Arr.every(expected, (n) => hasColumn(heading, n)) ||
			!keysTyped
		) {
			const named =
				heading.length === expected.length && Arr.every(expected, (n) => hasColumn(heading, n))
			this.report(
				named
					? "a heading column has the type its kind defines"
					: "a heading is the one its kind defines",
				[...path, "heading"],
				`the group heading (${Arr.join(expected, ", ")})`
			)
		}
	}

	checkRecursive(
		node: TableOf<"Recursive">,
		path: ReadonlyArray<string | number>,
		heading: Heading
	): void {
		const self = nodeAt(this.table, node.self)
		if (self?.kind !== "SelfRef" || self.recursive !== node.id) {
			this.report(
				"a recursion's self is its feedback reference",
				path,
				`a SelfRef feeding back to ${node.id} as its self reference`
			)
		}
		for (const [side, id] of [
			["base", node.base],
			["step", node.step]
		] as const) {
			const h = this.headingOf(id)
			if (h !== undefined && !sameColumnSet(h, heading)) {
				this.report(
					"a recursion's base and step have its state heading",
					[...path, side],
					`the state heading ${describeHeading(heading)}`
				)
			}
		}
		this.requireColumns(
			"a column a node names lies in the heading it reads",
			[...path, "origin"],
			heading,
			node.origin,
			"an origin column of the state heading"
		)
		this.checkFeedbackScope(node)
	}

	checkAttach(node: TableOf<"Attach">, path: ReadonlyArray<string | number>): void {
		const parent = this.headingOf(node.parent)
		const childNode = nodeAt(this.table, node.child)
		this.requireHeading(node, parent, "its parent (the parent set is unchanged)")
		if (node.correlation.length === 0 && parent?.length !== 0) {
			this.report(
				"an attachment binds a parent variable",
				path,
				"a child that binds a parent variable"
			)
		}
		this.requireColumns(
			"a column a node names lies in the heading it reads",
			path,
			parent,
			Arr.map(node.correlation, (c) => c.parent),
			"a parent column"
		)
		this.requireColumns(
			"a column a node names lies in the heading it reads",
			path,
			childNode?.heading,
			Arr.map(node.correlation, (c) => c.child),
			"a child column"
		)
		if (childNode !== undefined) {
			this.checkDelivered(node, childNode)
		}
		if (node.order !== undefined) {
			const ordered = Arr.map(node.order.keys, (k) => k.column)
			this.requireColumns(
				"a column a node names lies in the heading it reads",
				path,
				childNode?.heading,
				ordered,
				"a child order column"
			)
			this.requireTotalOrder(
				[...path, "order"],
				node.child,
				[...ordered, ...Arr.map(node.correlation, (c) => c.child)],
				"an ordered attachment"
			)
		}
		if (parent !== undefined && hasColumn(parent, node.name)) {
			this.report(
				"an attachment's name differs from its parent's columns",
				path,
				`an attachment name distinct from the parent's columns, not ${node.name}`
			)
		}
	}

	checkWindow(
		node: TableOf<"Window">,
		path: ReadonlyArray<string | number>,
		heading: Heading
	): void {
		const input = this.headingOf(node.input)
		const ordered = Arr.map(node.order.keys, (k) => k.column)
		this.requireColumns(
			"a column a node names lies in the heading it reads",
			path,
			input,
			node.partition,
			"a partition column"
		)
		this.requireColumns(
			"a column a node names lies in the heading it reads",
			path,
			input,
			ordered,
			"an order column"
		)
		this.requireScope(
			[...path, "args"],
			node.input,
			[...node.args, ...(node.filter === undefined ? [] : [node.filter])],
			"a window argument"
		)
		const [lo, hi] = windowArity[node.fn]
		if (node.args.length < lo || node.args.length > hi) {
			this.report(
				"a window function has its arity",
				path,
				`${lo === hi ? lo : `${lo} to ${hi}`} argument(s) for ${node.fn}, not ${node.args.length}`
			)
		}
		const aggregate = windowAggregates.includes(node.fn)
		const sensitive = orderSensitiveWindowFns.includes(node.fn)
		if ((sensitive || node.fn === "rank" || node.fn === "denseRank") && ordered.length === 0) {
			this.report(
				"an order-sensitive window function is ordered",
				path,
				`an ORDER BY for ${node.fn}`
			)
		}
		if (node.frame !== undefined && !aggregate) {
			this.report(
				"a ROWS frame belongs to an ordered window aggregate, start before end",
				path,
				`a frame only on a window aggregate; ${node.fn} ignores it`
			)
		}
		if (node.frame !== undefined && ordered.length === 0) {
			this.report(
				"a ROWS frame belongs to an ordered window aggregate, start before end",
				path,
				"an ORDER BY for a ROWS frame"
			)
		}
		if (aggregate && ordered.length > 0 && node.frame === undefined) {
			this.report(
				"a ROWS frame belongs to an ordered window aggregate, start before end",
				path,
				"an explicit ROWS frame on an ordered window aggregate"
			)
		}
		if (sensitive || node.frame !== undefined) {
			this.requireTotalOrder(
				[...path, "order"],
				node.input,
				[...node.partition, ...ordered],
				`${node.fn} over a window`
			)
		}
		if (node.filter !== undefined) {
			if (node.fn !== "count") {
				this.report("only a count is filtered", path, "a filter on count only")
			}
			const t = this.exprType(node.filter)
			if (t !== undefined && !isBool(t)) {
				this.report("a filter's predicate is boolean", path, "a boolean filter")
			}
		}
		const value = node.args[0] === undefined ? undefined : this.exprType(node.args[0])
		if (node.fn === "lag" || node.fn === "lead") {
			const offset = node.args[1] === undefined ? undefined : this.exprType(node.args[1])
			const fallback = node.args[2] === undefined ? undefined : this.exprType(node.args[2])
			if (offset !== undefined && baseOf(offset).carrier !== "int4") {
				this.report(
					"lead and lag take an integer offset and a default of the value's type",
					path,
					`an integer offset for ${node.fn}`
				)
			}
			if (value !== undefined && fallback !== undefined && !sameScalarType(value, fallback)) {
				this.report(
					"lead and lag take an integer offset and a default of the value's type",
					path,
					`a ${node.fn} default of the value's type`
				)
			}
		}
		if (input !== undefined) {
			const ok =
				heading.length === input.length + 1 &&
				sameColumns(heading.slice(0, input.length), input) &&
				heading[input.length]?.name === node.out
			const named =
				heading.length === input.length + 1 &&
				Arr.every(input, (c, i) => heading[i]?.name === c.name) &&
				heading[input.length]?.name === node.out
			if (!ok) {
				this.report(
					named
						? "a heading column has the type its kind defines"
						: "a heading is the one its kind defines",
					[...path, "heading"],
					`its input's heading then ${node.out}`
				)
			}
		}
		const out = columnOf(heading, node.out)
		if (out !== undefined) {
			if (bigintResults.includes(node.fn) && out.type.carrier !== "int8") {
				this.report(
					"a heading column has the type its kind defines",
					[...path, "heading"],
					`a bigint ${node.out} for ${node.fn}`
				)
			}
			if (
				(node.fn === "lag" || node.fn === "lead" || node.fn === "min" || node.fn === "max") &&
				value !== undefined &&
				!sameScalarType(value, out.type)
			) {
				this.report(
					"a heading column has the type its kind defines",
					[...path, "heading"],
					`${node.out} at the type of ${node.fn}'s value`
				)
			}
		}
	}

	checkOrderedSetAggregate(
		node: TableOf<"OrderedSetAggregate">,
		path: ReadonlyArray<string | number>,
		heading: Heading
	): void {
		const input = this.headingOf(node.input)
		const ordered = Arr.map(node.order.keys, (k) => k.column)
		this.requireColumns(
			"a column a node names lies in the heading it reads",
			path,
			input,
			node.keys,
			"a group key"
		)
		this.requireColumns(
			"a column a node names lies in the heading it reads",
			path,
			input,
			ordered,
			"an order column"
		)
		this.requireScope([...path, "fractions"], node.input, node.fractions, "a fraction")
		if (ordered.length !== 1) {
			this.report(
				"an ordered-set aggregate orders by one column, with a double precision fraction per output",
				path,
				"WITHIN GROUP (ORDER BY value): exactly one order column"
			)
		}
		if (node.fn === "mode") {
			if (node.fractions.length > 0 || node.outs.length !== 1) {
				this.report(
					"an ordered-set aggregate orders by one column, with a double precision fraction per output",
					path,
					"mode with no fraction and one output"
				)
			}
		} else if (node.fractions.length === 0 || node.fractions.length !== node.outs.length) {
			this.report(
				"an ordered-set aggregate orders by one column, with a double precision fraction per output",
				path,
				`one fraction per output for ${node.fn}`
			)
		}
		for (const [i, f] of node.fractions.entries()) {
			const t = this.exprType(f)
			if (t !== undefined && baseOf(t).carrier !== "float8") {
				this.report(
					"an ordered-set aggregate orders by one column, with a double precision fraction per output",
					[...path, "fractions", i],
					"a double precision fraction"
				)
			}
		}
		const expected = [...node.keys, ...node.outs]
		if (
			heading.length !== expected.length ||
			!Arr.every(expected, (n, i) => heading[i]?.name === n)
		) {
			this.report(
				"a heading is the one its kind defines",
				[...path, "heading"],
				`the heading (${Arr.join(expected, ", ")})`
			)
		}
		const valueColumn = ordered[0] === undefined ? undefined : columnIn(input, ordered[0])
		for (const name of node.outs) {
			const out = columnOf(heading, name)
			if (out === undefined || valueColumn === undefined) {
				continue
			}
			if (node.fn !== "percentileCont" && !sameScalarType(valueColumn.type, out.type)) {
				this.report(
					"a heading column has the type its kind defines",
					[...path, "heading"],
					`${name} at the ordered value's type`
				)
			}
			if (node.fn === "percentileCont" && baseOf(out.type).carrier !== "float8") {
				this.report(
					"a heading column has the type its kind defines",
					[...path, "heading"],
					`a double precision ${name}`
				)
			}
		}
	}
}

const nodeIdShape = S.branded(NodeId, S.nonEmptyString)
const exprIdShape = S.branded(ExprId, S.nonEmptyString)
const varIdShape = S.branded(VarId, S.nonEmptyString)
const occurrenceIdShape = S.branded(OccurrenceId, S.nonEmptyString)
const paramIdShape = S.branded(ParamId, S.nonEmptyString)

const headingColumnShape: S.Shape<HeadingColumn> = S.struct({
	name: S.nonEmptyString,
	type: scalarTypeShape
})

/** What fills an InputSet, by its kind. */
const inputSetInputShape: S.Shape<InputSetInput> = S.tagged("kind", {
	declared: S.struct({ param: paramIdShape }),
	member: S.struct({ slot: paramIdShape, relation: S.nonEmptyString })
})

const headingShape: S.Shape<Heading> = S.uniqueArray(
	headingColumnShape,
	(c) => c.name,
	"column names"
)

const keySetShape: S.Shape<KeySet> = S.uniqueStrings("key columns", S.nonEmptyString)
/** A fold's bound tuple with the key of each matched fact it holds (ir/rel.ts FoldInput). */
const foldInputShape: S.Shape<FoldInput> = S.struct({
	columns: keySetShape,
	keyed: S.array(S.struct({ occurrence: occurrenceIdShape, key: keySetShape }))
})

/**
 * The name brands a DAG admits (a Forbid node's law, an evidence premise's object), through the naming door's admitting
 * function (core/identity.ts admittedIdentifier): the spelling decoded is one the compiler itself derived when it built
 * the DAG.
 */
const lawIdShape: S.Shape<LawId> = S.branded(
	(text: string): LawId => admittedIdentifier(text),
	S.nonEmptyString
)

/** A premise names a constraint or unique index by its constraint name, or a containment by its law. */
const premiseObjectShape: S.Shape<ConstraintName> = S.branded(
	(text: string): ConstraintName => admittedIdentifier(text),
	S.nonEmptyString
)

const premiseShape: S.Shape<Premise> = S.tagged("kind", {
	constraint: S.struct({
		constraint: premiseObjectShape,
		constraintKind: S.literalsShape(constraintKinds)
	}),
	law: S.struct({ law: lawIdShape }),
	node: S.struct({ node: nodeIdShape }),
	param: S.struct({ param: paramIdShape })
})

const evidenceContextShape: S.Shape<EvidenceContext> = S.literalsShape(evidenceContexts)

const implicationShape: S.Shape<Implication> = S.ref("an implication", () => implicationBody)

/** The shape of two union arms told apart on a column (ir/keys.ts Separation). */
const separationShape: S.Shape<Separation> = S.ref("a separation", () => separationBody)

/** The decoder separationShape refers to (S.ref). */
const separationBody: S.Shape<Separation> = S.struct({
	arms: S.pairShape(S.nonNegativeInteger),
	column: S.nonEmptyString,
	fixed: S.pairShape(implicationShape)
})

/** The shape of a key proof, as a node's metadata records it (rel.ts NodeMeta). */
const keyProofShape: S.Shape<KeyProof> = S.ref("a key proof", () => keyProofBody)

/** The decoder keyProofShape refers to (S.ref). */
const keyProofBody: S.Shape<KeyProof> = S.struct({
	key: keySetShape,
	premises: S.array(premiseShape),
	context: evidenceContextShape,
	members: S.array(
		S.struct({ of: S.nonEmptyString, column: S.nonEmptyString, determines: implicationShape })
	),
	factors: S.array(
		S.struct({
			key: S.nonEmptyUniqueStrings("a factor's key columns"),
			alternatives: S.array(S.struct({ columns: keySetShape, determines: implicationShape }))
		})
	),
	basis: S.tagged("kind", {
		rows: S.struct({ implication: implicationShape }),
		union: S.struct({
			arms: S.nonEmptyArray(keyProofShape),
			separations: S.array(separationShape)
		}),
		within: S.struct({ implication: implicationShape, inner: keyProofShape })
	})
})

/** The shape of a view's key, as the checker stamps it on a Base over the view (rel.ts ViewBase). */
const viewKeyShape: S.Shape<ViewKey> = S.struct({
	fields: S.nonEmptyUniqueStrings("view key columns"),
	premises: S.array(premiseShape),
	context: evidenceContextShape,
	members: S.array(S.struct({ of: S.nonEmptyString, column: S.nonEmptyString })),
	alternatives: S.array(
		S.struct({
			of: keySetShape,
			columns: keySetShape,
			given: keySetShape,
			premises: S.array(premiseShape),
			context: evidenceContextShape
		})
	)
})

const fixedWitnessShape: S.Shape<FixedWitness> = S.tagged("kind", {
	conjunct: S.struct({ expr: exprIdShape }),
	closedValue: S.struct({}),
	takeCorrelation: S.struct({ index: S.nonNegativeInteger }),
	semiJoinPair: S.struct({ index: S.nonNegativeInteger, right: implicationShape }),
	attachCorrelation: S.struct({ attach: nodeIdShape, index: S.nonNegativeInteger })
})

const equalWitnessShape: S.Shape<EqualWitness> = S.tagged("kind", {
	conjunct: S.struct({ expr: exprIdShape }),
	regionEquality: S.struct({ index: S.nonNegativeInteger }),
	sharedColumn: S.struct({ occurrence: occurrenceIdShape, column: S.nonEmptyString }),
	correlatedCopy: S.struct({ index: S.nonNegativeInteger }),
	viewMember: S.struct({}),
	arms: S.struct({ arms: S.nonEmptyArray(implicationShape) }),
	closedColumns: S.struct({}),
	lateralFixed: S.struct({
		occurrence: occurrenceIdShape,
		column: S.nonEmptyString,
		fixed: implicationShape
	})
})

const atMostOneWitnessShape: S.Shape<AtMostOneWitness> = S.tagged("kind", {
	context: S.struct({}),
	row: S.struct({}),
	singleFact: S.struct({}),
	partialSplit: S.struct({}),
	takeOne: S.struct({}),
	nearestOne: S.struct({}),
	falseConjunct: S.struct({ expr: exprIdShape })
})

const ruleShape: S.Shape<Rule> = S.tagged("rule", {
	declared: S.struct({ premises: S.array(premiseShape), context: evidenceContextShape }),
	fixed: S.struct({ witness: fixedWitnessShape }),
	equal: S.struct({ witness: equalWitnessShape }),
	correlated: S.struct({ index: S.nonNegativeInteger }),
	match: S.struct({ occurrence: occurrenceIdShape, source: implicationShape }),
	projection: S.struct({ input: implicationShape }),
	group: S.struct({}),
	grouped: S.struct({ input: implicationShape }),
	kept: S.struct({ input: implicationShape }),
	intersected: S.struct({ input: implicationShape }),
	atMostOne: S.struct({ witness: atMostOneWitnessShape }),
	distinct: S.struct({}),
	produced: S.struct({ input: keyProofShape }),
	ranked: S.struct({}),
	numbered: S.struct({}),
	agreed: S.struct({ arms: S.nonEmptyArray(implicationShape) }),
	unionKey: S.struct({ proof: keyProofShape }),
	separated: S.struct({
		arms: S.nonEmptyArray(implicationShape),
		separations: S.array(separationShape)
	}),
	viewAlternative: S.struct({ premises: S.array(premiseShape), context: evidenceContextShape })
})

const dependencyShape: S.Shape<Dependency> = S.struct({
	from: keySetShape,
	to: keySetShape,
	rule: ruleShape
})

/** The decoder implicationShape refers to (S.ref). */
const implicationBody: S.Shape<Implication> = S.struct({
	from: keySetShape,
	steps: S.array(dependencyShape)
})

const nodeMetaShape: S.Shape<NodeMeta> = S.struct({
	paramDeps: S.uniqueIds("parameter dependencies", S.branded(ParamId, S.nonEmptyString)),
	logicalKeys: S.array(keyProofShape),
	card: S.literalsShape(["many", "atMostOne", "one"]),
	reads: S.uniqueStrings("relation names", S.nonEmptyString),
	context: evidenceContextShape
})

const orderShape: S.Shape<CompletedOrder> = S.struct({
	keys: S.uniqueArray(
		S.struct({ column: S.nonEmptyString, dir: S.literalsShape(directions) }),
		(k) => k.column,
		"order columns"
	)
})

const takeBoundShape: S.Shape<TakeBound> = S.tagged("kind", {
	literal: S.struct({ k: S.refine(S.bigint, (k) => k > 0n, "a positive bound") }),
	param: S.struct({ param: paramIdShape })
})

const frameOffset = S.refine(S.bigint, (n) => n >= 0n, "a nonnegative frame offset")
const frameBoundShape: S.Shape<FrameBound> = S.unionShape(
	S.literalsShape(["unboundedPreceding", "currentRow"]),
	S.struct({ preceding: frameOffset }),
	S.struct({ following: frameOffset })
)

/**
 * A frame's position on the row axis: unbounded preceding first, then n preceding as -n, the current row 0, n
 * following as n. PostgreSQL refuses a frame whose start kind lies after its end kind; a frame whose start lies after
 * its end by offset is empty by construction, and is refused too.
 */
const framePosition = (b: FrameBound): number | bigint =>
	b === "unboundedPreceding"
		? Number.NEGATIVE_INFINITY
		: b === "currentRow"
			? 0n
			: "preceding" in b
				? -b.preceding
				: b.following

const frameShape: S.Shape<WindowFrame> = S.refine(
	S.struct({ unit: S.literalsShape(["rows"]), start: frameBoundShape, end: frameBoundShape }),
	(f) => f.end !== "unboundedPreceding" && framePosition(f.start) <= framePosition(f.end),
	"a ROWS frame whose start does not lie after its end"
)

const columnPairsShape = S.array(S.struct({ left: S.nonEmptyString, right: S.nonEmptyString }))
const correlationShape = S.array(S.struct({ column: S.nonEmptyString, expr: exprIdShape }))

const terminationShape: S.Shape<TerminationCert> = S.struct({
	kind: S.literalsShape(["finiteCarrier", "boundedState", "wellFounded"]),
	stateEstimate: S.refine(S.bigint, (n) => n > 0n, "a positive state estimate"),
	premises: S.array(premiseShape)
})

const common = { id: nodeIdShape, heading: headingShape, meta: nodeMetaShape } as const
/** A node's `loc`: an input may leave it out, and the decoded node states it, undefined where it is left out. */
const commonStated = { loc: S.sourceLoc } as const
/**
 * Every node has the common fields first and the common stated ones with its own stated fields, spread into each case
 * below.
 */
const produced = {
	carried: S.uniqueStrings("carried columns", S.nonEmptyString),
	out: S.nonEmptyString
} as const

const attachFields = {
	parent: nodeIdShape,
	child: nodeIdShape,
	name: S.nonEmptyString,
	correlation: S.array(S.struct({ parent: S.nonEmptyString, child: S.nonEmptyString })),
	judged: S.literalsShape(["array", "option", "one"])
} as const

/** A producer decodes by the producer it names; those of two arguments, two spans or a span's two ends, read one
 * shape. */
const twoArgumentProducer = S.structStated(
	{ ...common, input: nodeIdShape, args: S.pairShape(exprIdShape), ...produced },
	commonStated,
	{}
)

/** One aggregate of a Group, past its function: its arguments as many as the function's arity. */
const aggregateCase = <A>(args: S.Shape<A>) =>
	S.structStated(
		{ name: S.nonEmptyString, op: S.branded(OpId, S.nonEmptyString), args },
		{ filter: exprIdShape },
		{}
	)

/** An attachment decodes by what it delivers; a bare child and an option have no order. */
const unorderedAttach = S.structStated(
	{ ...common, ...attachFields },
	{ order: S.nothing, ...commonStated },
	{}
)

/**
 * A Base's own fields beside its relation kind: a stored relation's add its generated fields' reads, a view's the keys
 * the checker stamped on it.
 */
const baseFields = {
	relation: S.nonEmptyString,
	occurrence: occurrenceIdShape,
	primaryKey: S.nonEmptyUniqueStrings("primary key columns"),
	keys: S.array(S.nonEmptyUniqueStrings("key columns"))
} as const

const tableNodeShape: S.Shape<TableNode> = S.tagged("kind", {
	Base: S.tagged("relationKind", {
		relation: S.structStated(
			{
				...common,
				...baseFields,
				generated: S.array(S.struct({ field: S.nonEmptyString, reads: S.array(S.nonEmptyString) }))
			},
			commonStated,
			{}
		),
		derived: S.structStated(
			{ ...common, ...baseFields, view: S.array(viewKeyShape) },
			commonStated,
			{}
		),
		world: S.structStated(
			{ ...common, ...baseFields, view: S.array(viewKeyShape) },
			commonStated,
			{}
		)
	}),
	Closed: S.structStated(
		{ ...common, closed: S.nonEmptyString, rows: S.array(S.array(literalShape)) },
		commonStated,
		{}
	),
	Context: S.structStated({ ...common, context: S.nonEmptyString }, commonStated, {}),
	InputSet: S.structStated({ ...common, input: inputSetInputShape }, commonStated, {}),
	Delta: S.structStated(
		{
			...common,
			relation: S.nonEmptyString,
			side: S.literalsShape(["added", "removed"]),
			keys: S.array(S.nonEmptyUniqueStrings("key columns"))
		},
		commonStated,
		{}
	),
	MatchRegion: S.structStated(
		{
			...common,
			scope: S.branded(ScopeId, S.nonEmptyString),
			vars: S.array(S.struct({ id: varIdShape, name: S.nonEmptyString, type: scalarTypeShape })),
			occurrences: S.array(
				S.struct({
					id: occurrenceIdShape,
					source: nodeIdShape,
					bindings: S.array(S.struct({ column: S.nonEmptyString, var: varIdShape })),
					constants: S.array(S.struct({ column: S.nonEmptyString, expr: exprIdShape }))
				})
			),
			equalities: S.array(S.struct({ a: varIdShape, b: varIdShape })),
			correlated: S.array(S.struct({ var: varIdShape, expr: exprIdShape }))
		},
		commonStated,
		{}
	),
	Filter: S.structStated({ ...common, input: nodeIdShape, pred: exprIdShape }, commonStated, {}),
	ProjectSet: S.structStated(
		{
			...common,
			input: nodeIdShape,
			out: S.array(S.struct({ name: S.nonEmptyString, expr: exprIdShape }))
		},
		commonStated,
		{}
	),
	SemiJoin: S.structStated(
		{ ...common, left: nodeIdShape, right: nodeIdShape, on: columnPairsShape },
		commonStated,
		{}
	),
	AntiJoin: S.structStated(
		{ ...common, left: nodeIdShape, right: nodeIdShape, on: columnPairsShape },
		commonStated,
		{}
	),
	Union: S.structStated(
		{
			...common,
			groups: S.nonEmptyArray(
				S.struct({ heading: headingShape, arms: S.nonEmptyArray(nodeIdShape) })
			),
			discriminant: S.uniqueStrings("discriminant columns", S.nonEmptyString)
		},
		commonStated,
		{}
	),
	Intersect: S.structStated({ ...common, left: nodeIdShape, right: nodeIdShape }, commonStated, {}),
	Difference: S.structStated(
		{ ...common, left: nodeIdShape, right: nodeIdShape },
		commonStated,
		{}
	),
	Take: S.structStated(
		{
			...common,
			input: nodeIdShape,
			order: orderShape,
			bound: takeBoundShape,
			correlation: correlationShape
		},
		commonStated,
		{}
	),
	Group: S.structStated(
		{
			...common,
			input: nodeIdShape,
			bound: foldInputShape,
			keys: keySetShape,
			aggs: S.array(
				S.tagged("fn", {
					count: aggregateCase(S.empty(exprIdShape)),
					sum: aggregateCase(S.single(exprIdShape)),
					avg: aggregateCase(S.single(exprIdShape)),
					min: aggregateCase(S.single(exprIdShape)),
					max: aggregateCase(S.single(exprIdShape)),
					boolAnd: aggregateCase(S.single(exprIdShape)),
					boolOr: aggregateCase(S.single(exprIdShape))
				})
			)
		},
		commonStated,
		{}
	),
	Produce: S.tagged("producer", {
		spanPack: S.structStated(
			{ ...common, input: nodeIdShape, args: S.single(exprIdShape), ...produced },
			commonStated,
			{}
		),
		spanIntersection: twoArgumentProducer,
		spanDifference: twoArgumentProducer,
		spanFromEnds: twoArgumentProducer
	}),
	Recursive: S.structStated(
		{
			...common,
			name: S.nonEmptyString,
			base: nodeIdShape,
			step: nodeIdShape,
			self: nodeIdShape,
			termination: terminationShape,
			origin: keySetShape
		},
		commonStated,
		{}
	),
	SelfRef: S.structStated({ ...common, recursive: nodeIdShape }, commonStated, {}),
	ApproximateNearest: S.structStated(
		{
			...common,
			source: nodeIdShape,
			score: S.nonEmptyString,
			take: S.refine(S.bigint, (k) => k > 0n, "a positive bound"),
			params: S.uniqueIds("parameter ids", S.branded(ParamId, S.nonEmptyString)),
			sealed: S.literalsShape([true])
		},
		commonStated,
		{}
	),
	OrderedResult: S.structStated(
		{ ...common, input: nodeIdShape, order: orderShape },
		commonStated,
		{}
	),
	Step: S.structStated({ ...common, input: nodeIdShape }, commonStated, {}),
	Attach: S.tagged("delivered", {
		option: unorderedAttach,
		one: unorderedAttach,
		array: S.structStated({ ...common, ...attachFields, order: orderShape }, commonStated, {})
	}),
	Forbid: S.structStated(
		{ ...common, lawId: lawIdShape, violation: nodeIdShape },
		commonStated,
		{}
	),
	Window: S.structStated(
		{
			...common,
			input: nodeIdShape,
			partition: keySetShape,
			order: orderShape,
			fn: S.literalsShape(windowFns),
			op: S.branded(OpId, S.nonEmptyString),
			args: S.array(exprIdShape),
			out: S.nonEmptyString,
			rule: S.nonEmptyString
		},
		{ filter: exprIdShape, frame: frameShape, ...commonStated },
		{}
	),
	OrderedSetAggregate: S.structStated(
		{
			...common,
			input: nodeIdShape,
			keys: keySetShape,
			fn: S.literalsShape(orderedSetFns),
			op: S.branded(OpId, S.nonEmptyString),
			order: orderShape,
			fractions: S.array(exprIdShape),
			outs: S.nonEmptyUniqueStrings("output columns"),
			rule: S.nonEmptyString
		},
		commonStated,
		{}
	),
	Call: S.structStated(
		{
			...common,
			function: S.tagged("kind", {
				declared: calledFunctionShape,
				split: S.struct({
					split: S.tagged("kind", {
						tokens: S.struct({}),
						pieces: S.struct({ separator: S.nonEmptyString }),
						rest: S.struct({}),
						decodedPath: S.struct({}),
						resolvedWithin: S.struct({})
					})
				})
			}),
			args: S.array(
				S.tagged("kind", {
					value: S.struct({ name: S.nonEmptyString, expr: exprIdShape, type: scalarTypeShape }),
					rows: S.struct({
						name: S.nonEmptyString,
						rows: nodeIdShape,
						columns: S.nonEmptyArray(S.struct({ name: S.nonEmptyString, type: scalarTypeShape }))
					})
				})
			)
		},
		commonStated,
		{}
	)
})

const dagRootsShape = S.array(S.branded(NodeId, S.nonEmptyString))
const dagNodesShape = S.recordShape(tableNodeShape, S.nonEmptyString)
const dagExprsShape = S.recordShape(tableExprShape, S.nonEmptyString)

/**
 * A DAG has a root, except the empty DAG of no nodes and no expressions: the law DAG of a schema that states no law,
 * one of closed relations only, has nothing to check. A DAG with a node but no root stays refused.
 */
export const dagTableShape: S.Shape<DagTable> = S.refine(
	S.struct({ roots: dagRootsShape, nodes: dagNodesShape, exprs: dagExprsShape }),
	(table) => table.roots.length > 0 || (Rec.size(table.nodes) === 0 && Rec.size(table.exprs) === 0),
	"a DAG with a root, or the empty DAG of no nodes and no expressions"
)

/** Every problem of an already-shaped table. */
export const dagProblems = (table: DagTable): ReadonlyArray<DagProblem> => {
	const checker = new Checker(table)
	checker.run()
	return checker.problems
}

/**
 * The decoded form of a table this package's own code built (shape.ts decodeWith): the shape stage's checks over every
 * node and expression. A table it builds that breaks the shape is a defect of its builder.
 */
const conformed = (table: DagTable): DagTable => {
	const decoded = S.decodeWith(dagTableShape, table, "relational DAG")
	if (!decoded.ok) {
		throw defect(`a value this package built has its shape: ${decoded.error.message}`)
	}
	return decoded.value
}

/**
 * The DAG validator.
 *
 * A DAG is checked over its outside form (dag.ts toTable) in two stages. The shape stage decodes the table strictly
 * (dagTableShape, shape.ts decodeWith): every node has a heading, every field has its declared form, no property is
 * unknown. The semantic stage checks what a shape cannot:
 *
 * - labels are unique: one node and one expression per label (toTable refuses two under one);
 * - every name resolves: a feedback's and a premise's node, every column reference (to a node whose heading has the
 *   column, at the column's type);
 * - identities are fresh: a VarId is declared by exactly one MatchRegion binding list, an OccurrenceId by exactly one
 *   scan, and every use of a VarId refers to a variable its region declares;
 * - every node's structural metadata is the recomputed one (its lexical parameter and read dependencies, dag.ts
 *   relNode), its logical keys are distinct sets of its heading's columns, the empty key only on a node of at most one
 *   row (unknown evidence is no evidence);
 * - every expression a node evaluates over its input rows (a Filter predicate, a projection, an aggregate, a window
 *   or ordered-set argument, a producer argument) reads columns of that input only, so it never names an alias out of
 *   scope; outer values enter only through a region's correlation or a Take's, and every column those read is bound by a
 *   scope on its way to every root (dag.ts nodeScopes), since a root's statement is lowered with nothing in scope;
 * - every expression's literal fits its type, its dependencies and its effects are the computed ones (expr.ts
 *   exprEffects), and no comparison parameter is cast to a refined domain (its arity and non-null proof are its kind's
 *   by shape);
 * - every node's heading is the one its kind defines from its inputs, and its column references exist there; a union of
 *   several heading groups has a discriminant that every arm binds to a literal, with differing literal tuples for arms
 *   of different headings (MissingDiscriminant); a Group's aggregates read only columns of its bound tuple; an
 *   attachment under a parent of columns binds a parent variable (AttachedParentUnbound), a child under a parent of
 *   no columns being its own result beside the parent's one row, and delivers no narrower shape than its child's
 *   evidence admits; a Recursive's origin fields lie in its state heading;
 * - literals are compared under native equality (nativeEqualityKey): numeric scale and float zero sign ignored;
 * - every order a node depends on for its rows is a completed total order: Take, OrderedResult, an attachment's order
 *   and an order-sensitive Window order by columns that cover their input's heading or a key of it, so take(k) and
 *   ordinals are deterministic; an attachment's correlated child columns are fixed per parent, so they take part in
 *   the child's order;
 * - a SelfRef is read only inside its Recursive's step: the step reaches it, and no node outside the step, the base
 *   included, reads it;
 * - the internal Window and OrderedSetAggregate nodes have their functions' arities, frames and headings (R26-R31,
 *   R41); a Group aggregate has its arity, and only count is filtered (R24);
 * - a delivery node (an attachment, an ordered result) a root reaches lies on that root's delivered rows (dag.ts
 *   deliverySpine), so nothing is attached or ordered where no statement delivers it; checked once every other rule
 *   holds.
 *
 * Data edges that resolve and close no cycle need no rule: a node holds its inputs themselves, built before it.
 *
 * Validates a table this package's own code built: its shape conformed, then its semantics. A rule it breaks is a
 * defect of grizzle, never a refusal: the first problem is thrown (broken).
 */
export const validateTable = (table: DagTable): DagTable => {
	const owned = conformed(table)
	const [problem] = dagProblems(owned)
	if (problem !== undefined) {
		throw broken(problem)
	}
	return owned
}

/**
 * The problems of an operation's or a cast's proof: the registry's overload is partial exactly where the node carries a
 * proof, and the proof kernel re-derives each precondition the registry's Totality requires from its own premises
 * (oracle/proof.ts operationProofHolds), so every partial operation a DAG holds stands where every precondition of it is
 * proved, the soundness half of "no read raises".
 */
const proofProblems = (
	op: OpId,
	proof: OperationProof | undefined,
	type: ScalarType,
	args: ReadonlyArray<TableExpr>
): ReadonlyArray<ExprProblem> => {
	const defined = definedness(op)
	switch (defined.kind) {
		case "unknown":
			return [
				{
					rule: "an operation is an overload the registry holds",
					message: `an overload the registry holds, not ${describeOp(op)}`
				}
			]
		case "everywhere":
			return proof === undefined
				? []
				: [
						{
							rule: "an operation defined everywhere stands with no proof",
							message: `no proof on an overload defined everywhere, ${describeOp(op)}`
						}
					]
		case "partial":
			if (proof === undefined) {
				return [
					{
						rule: "a partial operation stands with a proof the kernel re-derives",
						message: `the proof a partial overload stands with, ${describeOp(op)}`
					}
				]
			}
			if (!proofCovers(proof, defined.preconditions)) {
				return [
					{
						rule: "every precondition of a partial operation stands with a proof of its own",
						message: `one proof for each precondition of ${describeOp(op)}, in the registry's order`
					}
				]
			}
			return operationProofHolds(proof, defined.preconditions, { type, operand: args[0]?.type })
				? []
				: [
						{
							rule: "a partial operation stands with a proof the kernel re-derives",
							message: `a proof of each precondition of ${describeOp(op)}, re-derived from its own premises`
						}
					]
	}
}

/**
 * The problems of an IEEE 754 node's native proof: the proof kernel re-derives that PostgreSQL's own overload computes
 * it where it stands (oracle/proof.ts nativeProofHolds), which only an IEEE 754 overload can, so every node a DAG renders
 * natively instead of by its guarded form raises on none of its operands' values.
 */
const nativeProblems = (
	op: OpId,
	proof: NativeProof,
	type: ScalarType,
	args: ReadonlyArray<TableExpr>
): ReadonlyArray<ExprProblem> =>
	nativeProofHolds(proof, { op, type, operand: args[0]?.type })
		? []
		: [
				{
					rule: "a native operation stands with a proof the kernel re-derives",
					message: `a native proof the kernel re-derives, on an IEEE 754 overload, not ${describeOp(op)}`
				}
			]

/**
 * Validates a DAG grizzle built over its outside form (validateTable); a label two of its nodes share is a defect. It
 * hands back the DAG it read, as typed: an assembled DAG stays one, and reading another brands nothing.
 */
export const validateDag = <D extends RelDag>(dag: D): D => {
	const table = toTable(dag)
	if (!table.ok) {
		throw broken({ path: ["nodes"], message: compileReasonText(table.error.reason) })
	}
	validateTable(table.value)
	return dag
}

/**
 * A table (rel.ts DagTable) a test wrote, corrupted or normalized (test/support/dag.ts normalizeDag), read back into direct
 * references: every node and expression it holds built by the one constructor under its own label, inputs first, each
 * region's references to its variables the region's own declarations. `node` reads any table node's live node,
 * reachable from the roots or not. Its labels are the table's whatever they spell ("n#0" included); its key proofs are
 * carried as the table holds them. The table holds every entry it names, through no cycle; one that plants a dangling
 * entry fails here.
 */
export const liveOf = (
	table: DagTable
): { readonly dag: ValidDag; readonly node: (id: NodeId) => RelNode } => {
	const exprs = new Fold<ExprId, ScalarExpr>(function* (id) {
		const entry = defined(table.exprs[id], `an expression ${id} in the table`)
		const spec = yield* mapArgs<TableArgs, LiveArgs>(entry)
		return builtExpr(spec, id)
	})
	const nodes = new Fold<NodeId, RelNode>(function* (id) {
		const entry = defined(table.nodes[id], `a node ${id} in the table`)
		const vars: ReadonlyArray<VarDecl> = entry.kind === "MatchRegion" ? entry.vars : []
		const declared = (v: VarId): VarDecl =>
			defined(
				Option.getOrUndefined(Arr.findFirst(vars, (d) => d.id === v)),
				`the variable ${v} of ${id}`
			)
		const spec = yield* mapNode<TableRefs, SpecRefs>(entry, {
			expr: (e) => exprs.of(e),
			var: declared,
			decl: (d) => d,
			occurrence: (o) => o,
			scope: (s) => s,
			name: (n) => n,
			meta: metaSpecOf
		})
		return relNode(id, spec)
	})
	return {
		dag: assembledDag(Arr.map(table.roots, (id) => nodes.of(id))),
		node: (id) => nodes.of(id)
	}
}
