import { searchInRows } from "#compiler/check/approximate/attach.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { lateralParentMax } from "#compiler/core/limits.ts"
import {
	extendNonEmpty,
	isNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import type { CompletedOrder, Heading, NodeOf, RelKind, RelNode } from "#compiler/ir/rel.ts"
import {
	columnIn,
	columnType,
	distinctSelect,
	type Env,
	emptyEnv,
	headingTargets,
	type LowerContext,
	type NodeDispatch,
	type NodeLowerer,
	nodeLabel,
	outputNames,
	refuse
} from "#compiler/lower/conservative/context.ts"

import {
	attachmentRows,
	checkedAttachment,
	Delivery,
	groupOrder,
	groupTake,
	type HeterogeneousPlan,
	headingGroupsDelivery,
	type Place,
	parentColumnsOf,
	positions,
	printedStatement,
	statementRows
} from "#compiler/lower/conservative/deliver.ts"
import { conservativeLowerers } from "#compiler/lower/conservative/dispatch.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { orderItemsOf } from "#compiler/lower/conservative/take/order.ts"
import {
	type AttachedTree,
	type ConservativeParamSlot,
	type ConservativeProgram,
	type ConservativeStatement,
	type DeclaredParamSlot,
	mapTree,
	type PageParamSlot,
	type StatementPlacement,
	type StatementRoots,
	statementOutput
} from "#compiler/lower/conservative/types.ts"
import type { CtePlan, CteStrategy } from "#compiler/lower/optimize/cte-policy/index.ts"
import { aggregateLowerer } from "#compiler/lower/shapes/aggregate/index.ts"
import { seededAttachment } from "#compiler/lower/shapes/attach-recursive/index.ts"
import type { FusedAttachment } from "#compiler/lower/shapes/attach/decode.ts"
import {
	attachmentRowsIdentity,
	boundTimes,
	type DeliveredRows,
	fusedLayout,
	type PipelinedAttachment,
	pipelinedAttachment,
	type RowsBound,
	type RowsIdentity,
	withFusedAttachments
} from "#compiler/lower/shapes/attach/index.ts"
import { catalogLowerers } from "#compiler/lower/shapes/catalog/native.ts"
import { recursionLowerer } from "#compiler/lower/shapes/recursion/index.ts"
import { refineDelivered } from "#compiler/lower/shapes/refined/index.ts"
import { regionLowerer } from "#compiler/lower/shapes/region/index.ts"
import { inputSetLowerer } from "#compiler/lower/shapes/relparam/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { producerLowerer } from "#compiler/lower/shapes/spans/index.ts"
import {
	type ChoiceInput,
	chooseTakeShape,
	decorrelatedTake,
	lateralTake,
	outerCorrelations,
	type ParentSet,
	parentSetOf,
	type RelationInput,
	type TakeShape,
	takeLowerer
} from "#compiler/lower/shapes/take/index.ts"
import { orderIsTotal } from "#compiler/lower/shapes/take/order.ts"
import { groupRows, unionLowerer } from "#compiler/lower/shapes/union/index.ts"
import { approximateLowerer } from "#compiler/lower/shapes/vector/index.ts"
import {
	type Cte,
	isSetQuery,
	type OperandBody,
	type OperandSelect,
	type OrderItem,
	type Select
} from "#compiler/sql/ast.ts"
import {
	and,
	conjunction,
	cteRead,
	type DefinedCte,
	keyedSet,
	select
} from "#compiler/sql/build.ts"

/**
 * Which form a per-execution take choice lowers to in one lowering of a statement: the LATERAL form for a small parent
 * set, the whole-relation form for a large one.
 */
export type InputChoiceMode = "small" | "large"

/**
 * A per-execution choice one statement's shape made: the take, the input whose size decides (a relation parameter's
 * distinct fact count, or a page's requested size), and the threshold at or below which the small form applies.
 */
export interface ShapeChoice<Source extends ChoiceInput = ChoiceInput> {
	readonly take: NodeId
	readonly source: Source
	readonly threshold: number
	readonly small: TakeShape
	readonly large: TakeShape
}

/**
 * A choice by a relation parameter's distinct fact count: every choice of a delivery that is no page's, since a page's
 * requested size bounds only a page's own rows (page/compile.ts deliveredRowsOf), which no other delivery reads.
 */
export type RelationChoice = ShapeChoice<RelationInput>

/**
 * A statement the runtime sends, as its flight's `answer`th: its position among its program's sent statements in flight
 * order (conservative/types.ts flight), the order the runtime sends them in.
 */
export interface Sent {
	readonly kind: "sent"
	readonly answer: number
}

/**
 * How the runtime has a statement's rows: it sends the statement, or feeds it the rows of the earlier sent statement
 * that computes the same sub-query (shapes/share arrivalsOf), whose arrival it holds.
 */
export type Arrival = Sent | { readonly kind: "fed"; readonly feeder: Sent }

/** The arrival of the statement at `position` of a program the runtime sends whole. */
export const sentAt = (position: number): Sent => ({ kind: "sent", answer: position })

/**
 * A statement of an optimized delivery: the conservative statement shape, with the attachments fused into it as output
 * columns after the heading, in order (none when each is pipelined), as the runtime binds and decodes it.
 */
export type FusedStatement<Slot extends ConservativeParamSlot = DeclaredParamSlot> =
	ConservativeStatement<Slot> & {
		readonly fused: ReadonlyArray<FusedAttachment>
	}

/** A conservative statement as an optimized delivery places it: it fuses no attachment and has one form. */
export const asDelivered = <C, Slot extends ConservativeParamSlot>(
	s: ConservativeStatement<Slot>
): DeliveredStatement<C, Slot> => ({
	...s,
	fused: [],
	forms: oneForm
})

/** A delivered statement with how the runtime has its rows. */
export const withArrival = <C, Slot extends ConservativeParamSlot>(
	s: DeliveredStatement<C, Slot>,
	arrival: Arrival
): OptimizedStatement<C, FusedStatement<Slot>, Slot> => ({ ...s, arrival })

/**
 * A statement as one optimized delivery lowered it, its small form, with its forms by the per-execution choices of a
 * delivery's choice kind C its shapes made in it: its large form is the same statement lowered in the large mode
 * (OptimizedDelivery.formed).
 */
export type DeliveredStatement<
	C,
	Slot extends ConservativeParamSlot = DeclaredParamSlot
> = FusedStatement<Slot> & { readonly forms: StatementForms<C, FusedStatement<Slot>> }

/** One lowering of a statement in one per-execution mode: the statement, and the choices its lowering made. */
interface Lowered<C, Slot extends ConservativeParamSlot> {
	readonly statement: FusedStatement<Slot>
	readonly choices: ReadonlyArray<C>
}

/** An optimized delivery's statements, each with its forms. */
export interface DeliveredProgram<
	C,
	Slot extends ConservativeParamSlot = DeclaredParamSlot
> extends ConservativeProgram<Slot> {
	readonly roots: StatementRoots<DeliveredStatement<C, Slot>>
}

/**
 * The forms of a statement: one; or, when per-execution choices of its shapes pick between two, the small form, the
 * statement itself, and the large form L an execution sends when some choice's input exceeds its threshold
 * (runsLargeForm): the same statement lowered in the large mode, of the same placement. Both forms deliver the same
 * rows in the same heading, so the choice is cost only.
 */
export type StatementForms<C, L> =
	| { readonly kind: "one" }
	| { readonly kind: "chosen"; readonly choices: NonEmptyReadonlyArray<C>; readonly large: L }

export const oneForm: { readonly kind: "one" } = Object.freeze({ kind: "one" })

/**
 * A statement of the optimized artifact: a delivered statement with its forms, by choices of kind C (a relation
 * parameter's count, outside a page; a page's attachments also by its size) with large form L (the large mode's
 * statement, or a template's with its spec), and how the runtime has its rows. A reader of neither names neither.
 */
export type OptimizedStatement<
	C = unknown,
	L = unknown,
	Slot extends ConservativeParamSlot = DeclaredParamSlot
> = FusedStatement<Slot> & {
	readonly forms: StatementForms<C, L>
	readonly arrival: Arrival
}

/**
 * A conservative statement at `position` as the runtime reads an optimized one: it fuses no attachment, has one form
 * and is sent.
 */
const asOptimizedStatement = <C, L, Slot extends ConservativeParamSlot>(
	s: ConservativeStatement<Slot>,
	position: number
): OptimizedStatement<C, L, Slot> => ({
	...s,
	fused: [],
	forms: oneForm,
	arrival: sentAt(position)
})

/** The conservative artifact as the runtime reads an optimized one (asOptimizedStatement). */
export const deliveredAsOptimized = <C, L, Slot extends ConservativeParamSlot>(
	program: ConservativeProgram<Slot>
): OptimizedDeliveryProgram<C, L, Slot> => ({
	...program,
	roots: mapTree(program.roots, (s, position) => asOptimizedStatement<C, L, Slot>(s, position))
})

export interface OptimizedDeliveryProgram<
	C = unknown,
	L = unknown,
	Slot extends ConservativeParamSlot = DeclaredParamSlot
> extends ConservativeProgram<Slot> {
	readonly roots: StatementRoots<OptimizedStatement<C, L, Slot>>
}

/** The CTEs one statement defined while it was lowered: its WITH entries, and each shared node's CTE by node. */
interface CteLog {
	readonly ctes: Set<Cte>
	readonly defined: Map<RelNode, DefinedCte>
}

/** What one statement accumulated while it was lowered: its WITH entries and its per-execution choices. */
interface StatementLog<C> extends CteLog {
	readonly choices: ReadonlyArray<C>
}

const freshLog = (): CteLog => ({ ctes: new Set(), defined: new Map() })

/**
 * The attachment whose child a take is lowered in: the nodes of its delivered rows, and the parents those rows are,
 * the parent rows of a pipelined statement or one row for a fused attachment's correlated subquery per delivered parent
 * row.
 */
interface AttachmentContext<I extends ChoiceInput> {
	/** The labels of the delivered rows' nodes, which a correlation's column references name. */
	readonly spine: ReadonlySet<NodeId>
	readonly parents: ParentSet<I>
}

/**
 * The parent set of a pipelined attachment's child: the parent rows' bound. A page's attachment chooses per execution
 * by the requested size, which bounds the delivered page; any other count is known only once the parent statement has
 * run, which shares the child's flight, so the facts' bound fixes the form, and without one the child is read for
 * every group.
 */
const parentsOfRows = <I extends ChoiceInput>(bound: RowsBound<I>): ParentSet<I> => {
	switch (bound.kind) {
		case "count":
			return { kind: "bounded", max: bound.max }
		case "input":
			return { kind: "input", source: bound.source, factor: bound.factor }
		case "unbounded":
			return { kind: "whole" }
	}
}

/**
 * What the lowerers of one optimized delivery read and record of its state: the per-execution mode the statement being
 * lowered is lowered in, the CTE plan's strategy for a node, the CTEs that statement defined, and each per-execution
 * choice its shapes make, by an input of `I`: a relation parameter's in any delivery, a page's requested size only in a
 * page's.
 */
export interface ShapeLog<I extends ChoiceInput> {
	readonly mode: InputChoiceMode
	readonly log: CteLog
	strategy(node: RelNode): CteStrategy | undefined
	readonly record: (choice: ShapeChoice<I>) => void
}

/**
 * The mutable state of one optimized delivery: the CTE plan, and the statement being lowered, with the per-execution
 * mode it is lowered in and the choices it made by inputs of `I`.
 *
 * The optimized lowering's kind table and statement delivery.
 *
 * The kind table is written once and imports every shape plug-in from its fixed directory. Its type is a mapped type
 * over the closed kind union, so a kind added to the IR fails to typecheck here until it has a plug-in, as the
 * conservative table does (lower/conservative/dispatch.ts).
 *
 * Every node is lowered under the duplicate-elimination placement (lower/optimize/dedup), read through ShapeFacts
 * (shapes/share/physical.ts), never through logical keys or node kinds:
 *
 * - the sources, filters, projections, regions, existence tests and feedback scans are the conservative plug-ins with
 *   their outermost SELECT DISTINCT dropped where the placement realized the node `plain`; a semi-join over the
 *   feedback of a recursion keeps it, because there its DISTINCT is the semi-join's own set semantics
 *   (lower/conservative/semi-join/exists.ts); a region past PostgreSQL's collapse limit is the conservative region's
 *   parts as an explicit JOIN chain in an evidence-chosen order, so its planning stays bounded (region/);
 * - Union, Take, Group and InputSet are the set-boundary shapes (union, take with the R20 parent-set policy, aggregate
 *   with R24, relparam), each discharging its own input's obligation unless the facts prove it unique;
 * - Window and OrderedSetAggregate are the compile-target catalog's native targets (shapes/catalog);
 * - Intersect and Difference keep their set forms and Recursive its recursive UNION (dedup/policy.ts pins them);
 * - an attachment, an ordered result and a law lower as the rows they deliver.
 *
 * A node the CTE policy shares (lower/optimize/cte-policy) is spelled once per statement as a WITH entry,
 * MATERIALIZED or NOT MATERIALIZED as the policy decided, and every use reads it under a fresh alias; every other node
 * is inlined at each use.
 *
 * The delivery schedules a query's statements: the main statement, or one statement per heading group
 * of a heterogeneous union delivered to the host (R21), and the attachments, fused into their parent statement as
 * ARRAY(SELECT ...) where the R36 rule selects it and otherwise pipelined: a statement of their own in the same
 * flight, which computes the parent's rows again (conservative/deliver.ts). A take correlated to a relation parameter,
 * or in a page's attachment to the delivered page, chooses its form per execution by that input's size, known before
 * the flight is sent: the delivery lowers each statement in the small mode and, when that lowering made
 * choices, again in the large mode (OptimizedDelivery.formed). A take correlated to the parent rows of any other
 * pipelined attachment takes the form the parent rows' bound fixes (parentsOf).
 */
export class ShapeState<I extends ChoiceInput> implements ShapeLog<I> {
	readonly cte: CtePlan
	#mode: InputChoiceMode
	#log: CteLog = freshLog()
	#choices: Array<ShapeChoice<I>> = []

	/** A state whose first statement is lowered in `mode`. */
	constructor(mode: InputChoiceMode, cte: CtePlan) {
		this.#mode = mode
		this.cte = cte
	}

	get mode(): InputChoiceMode {
		return this.#mode
	}

	/** The next statement, lowered in `mode`, with a fresh log. */
	begin(mode: InputChoiceMode): void {
		this.#mode = mode
		this.#log = freshLog()
		this.#choices = []
	}

	get log(): CteLog {
		return this.#log
	}

	readonly record = (choice: ShapeChoice<I>): void => {
		this.#choices.push(choice)
	}

	/** The statement's WITH entries and choices, and a fresh log for the next statement. */
	drain(): StatementLog<ShapeChoice<I>> {
		const log = { ...this.#log, choices: this.#choices }
		this.#log = freshLog()
		this.#choices = []
		return log
	}

	strategy(node: RelNode): CteStrategy | undefined {
		return this.cte.decisions[node.id]?.strategy
	}
}

/**
 * A query without its outermost set boundary: the plain realization of a conservative plug-in whose query is a SELECT
 * DISTINCT, under the proof the physical analysis made of it (`certified`), or an operand where it made none and the
 * node's consumers make its rows a set. A set operation, DISTINCT ON, or a query without DISTINCT is returned
 * unchanged.
 */
export const withoutBoundary = (
	query: OperandSelect,
	rows: "certified" | "operand"
): OperandSelect => {
	const body = query.body
	if (body.kind !== "core" || body.distinct !== true) {
		return query
	}
	return {
		...query,
		body:
			rows === "operand" ? { ...body, distinct: false, rows } : { ...body, distinct: false, rows }
	}
}

/**
 * Whether a query's outermost form eliminates repeats exactly: SELECT DISTINCT, UNION, INTERSECT, EXCEPT, or a
 * recursive CTE under UNION.
 */
const exactBody = (body: OperandBody): boolean =>
	(body.kind === "core" && body.distinct === true) ||
	(body.kind === "setOp" && body.op !== "UNION ALL") ||
	(body.kind === "select" && exactBody(body.body))

/**
 * A query with an exact set boundary: unchanged when its outermost form already eliminates repeats, otherwise read as
 * a derived table under SELECT DISTINCT.
 */
export const withBoundary = (cx: LowerContext, node: RelNode, query: OperandSelect): Select => {
	if ((exactBody(query.body) || query.with?.recursive === true) && isSetQuery(query)) {
		return query
	}
	const source = cx.wrap(query, node.heading, { kind: "node", node: node.id })
	return distinctSelect(headingTargets(node.heading, source.map), [source.item], [])
}

/** A conservative plug-in realized as the placement decided. */
const realized =
	<K extends RelKind>(facts: ShapeFacts, lower: NodeLowerer<K>): NodeLowerer<K> =>
	(node, cx, env) => {
		const query = lower(node, cx, env)
		return facts.realization(node) === "plain"
			? withoutBoundary(query, facts.unique(node) ? "certified" : "operand")
			: withBoundary(cx, node, query)
	}

/**
 * A plug-in that lowers a node as the rows it delivers (an attachment, an ordered result, a law): its input's query,
 * whose boundary is its input's to keep or drop. Placement never realizes such a node `distinct` (rel.ts
 * deliveredInput, dedup/policy.ts placementTarget); were one requested, the boundary is added.
 */
const delivering =
	<K extends RelKind>(facts: ShapeFacts, lower: NodeLowerer<K>): NodeLowerer<K> =>
	(node, cx, env) => {
		const query = lower(node, cx, env)
		return facts.realization(node) === "distinct" ? withBoundary(cx, node, query) : query
	}

/**
 * The parents a take is evaluated for: the parent set of the attachment being lowered when it correlates to that
 * attachment's delivered rows, the parent rows of a pipelined statement or one row of a fused attachment's per-parent
 * subquery, and otherwise what the DAG and the facts say (take/index.ts parentSetOf).
 */
const parentsOf = <I extends ChoiceInput>(
	cx: LowerContext,
	take: NodeOf<"Take">,
	facts: ShapeFacts,
	context: AttachmentContext<I> | undefined
): ParentSet<I | RelationInput> => {
	if (context !== undefined) {
		const reads = outerCorrelations(take).flatMap((c) => c.expr.deps.nodes)
		if (reads.length > 0 && reads.every((n) => context.spine.has(n))) {
			return context.parents
		}
	}
	return parentSetOf(cx.dag, take, facts)
}

/**
 * A correlated take lowered over every group: the per-group query read as a derived table, joined to
 * its parents by its outer correlations. The wrapper is a simple subquery, so PostgreSQL pulls it up and evaluates the
 * per-group query once for every parent rather than once per parent.
 */
const wholeRelationTake = (
	node: NodeOf<"Take">,
	cx: LowerContext,
	env: Env,
	facts: ShapeFacts,
	shape: "distinctOn" | "rowNumber"
): Select => {
	const d = decorrelatedTake(node, cx, env, facts, shape)
	const source = cx.wrap(d.query, node.heading, { kind: "node", node: node.id })
	const joins = d.joins.map((j) =>
		cx.equal(
			columnType(node.heading, j.column),
			columnIn(source.map, j.column),
			lowerExpr(cx, j.expr, env)
		)
	)
	return select(
		keyedSet(
			headingTargets(node.heading, source.map),
			[source.item],
			conjunction(joins),
			"a decorrelated take's rows"
		)
	)
}

/** The R20 take: the fixed policy over the parent set, a per-execution choice lowered in the delivery's mode. */
const takeShape =
	<I extends ChoiceInput>(
		facts: ShapeFacts,
		state: ShapeLog<I | RelationInput>,
		attachment: AttachmentContext<I> | undefined
	): NodeLowerer<"Take"> =>
	(node, cx, env) => {
		const choice = chooseTakeShape(
			node,
			parentsOf(cx, node, facts, attachment),
			facts,
			lateralParentMax.value
		)
		if (choice.kind !== "fixed") {
			state.record({
				take: node.id,
				source: choice.source,
				threshold: choice.threshold,
				small: choice.small,
				large: choice.large
			})
		}
		const shape: TakeShape =
			choice.kind === "fixed" ? choice.shape : state.mode === "small" ? choice.small : choice.large
		switch (shape) {
			case "limit":
				return takeLowerer(facts)(node, cx, env)
			case "lateral":
				return lateralTake(node, cx, env, facts)
			case "distinctOn":
			case "rowNumber":
				return wholeRelationTake(node, cx, env, facts, shape)
		}
	}

/** A semi-join keeps its DISTINCT over a recursion's feedback, where it lowers as a join (semi-join/exists.ts). */
const semiJoinShape = (facts: ShapeFacts): NodeLowerer<"SemiJoin"> => {
	const plain = realized(facts, conservativeLowerers.SemiJoin)
	return (node, cx, env) =>
		cx.readsFeedback(node.right)
			? conservativeLowerers.SemiJoin(node, cx, env)
			: plain(node, cx, env)
}

/** The kind table. */
const optimizedLowerers = <I extends ChoiceInput>(
	facts: ShapeFacts,
	state: ShapeLog<I | RelationInput>,
	attachment: AttachmentContext<I> | undefined
): { readonly [K in RelKind]: NodeLowerer<K> } => ({
	Base: realized(facts, conservativeLowerers.Base),
	Closed: realized(facts, conservativeLowerers.Closed),
	Context: realized(facts, conservativeLowerers.Context),
	InputSet: inputSetLowerer(facts),
	Delta: realized(facts, conservativeLowerers.Delta),
	MatchRegion: realized(facts, regionLowerer(facts)),
	Filter: realized(facts, conservativeLowerers.Filter),
	ProjectSet: realized(facts, conservativeLowerers.ProjectSet),
	SemiJoin: semiJoinShape(facts),
	AntiJoin: realized(facts, conservativeLowerers.AntiJoin),
	Union: unionLowerer(facts),
	Intersect: conservativeLowerers.Intersect,
	Difference: conservativeLowerers.Difference,
	Take: takeShape(facts, state, attachment),
	Group: aggregateLowerer(facts),
	Produce: producerLowerer(facts),
	Recursive: recursionLowerer(facts),
	SelfRef: realized(facts, conservativeLowerers.SelfRef),
	ApproximateNearest: approximateLowerer(facts),
	OrderedResult: delivering(facts, conservativeLowerers.OrderedResult),
	Attach: delivering(facts, conservativeLowerers.Attach),
	Forbid: delivering(facts, conservativeLowerers.Forbid),
	Window: catalogLowerers.Window,
	OrderedSetAggregate: catalogLowerers.OrderedSetAggregate
})

const cteMaterialization = (strategy: CteStrategy): NonNullable<Cte["materialized"]> | undefined =>
	strategy === "materialized"
		? "MATERIALIZED"
		: strategy === "notMaterialized"
			? "NOT MATERIALIZED"
			: undefined

/**
 * The one dispatch, in the child of `attachment` or outside any attachment: a node to its kind's plug-in, or, for a node
 * the CTE policy shares, a read of its statement-level CTE, defined at its first use in the statement. The CTE policy
 * shares only uncorrelated nodes off every recursion's feedback (cte-policy rule 3), so the body is lowered outside any
 * outer scope: a reference to one would be refused rather than hoisted.
 */
const dispatchIn = <I extends ChoiceInput>(
	facts: ShapeFacts,
	state: ShapeLog<I | RelationInput>,
	attachment: AttachmentContext<I> | undefined
): NodeDispatch => {
	const table = optimizedLowerers(facts, state, attachment)
	/** The table is a mapped type over the kinds, so its entry at a node's kind takes that kind's node. */
	const plugIn = <K extends RelKind>(
		node: NodeOf<K>,
		cx: LowerContext,
		env: Env
	): OperandSelect => {
		const lower: NodeLowerer<K> = table[node.kind]
		return lower(node, cx, env)
	}
	return (node, cx, env) => {
		const strategy = state.strategy(node)
		const materialized = strategy === undefined ? undefined : cteMaterialization(strategy)
		if (materialized === undefined || cx.readsFeedback(node)) {
			return plugIn(node, cx, env)
		}
		const origin = { kind: "node", node: node.id } as const
		const log = state.log
		let defined = log.defined.get(node)
		if (defined === undefined) {
			const query = plugIn(node, cx, emptyEnv)
			const name = cx.relationAlias(origin)
			const columns = cx.supply.columns(outputNames(node.heading).map(() => origin))
			log.ctes.add({ name, columns, materialized, query })
			defined = { name, columns, set: isSetQuery(query) }
			log.defined.set(node, defined)
		}
		return cteRead(cx.relationAlias(origin), defined)
	}
}

/**
 * The dispatch of a delivery's statements, outside any attachment: its rows, and a parent's rows computed again inside
 * an attachment's statement, are lowered as in their own statement.
 */
export const optimizedDispatch = (
	facts: ShapeFacts,
	state: ShapeLog<RelationInput>
): NodeDispatch => dispatchIn<never>(facts, state, undefined)

/**
 * What one fused attachment column carries, as the runtime's decoder reads it: the parent columns it correlates on and
 * its layout (attach/index.ts fusedLayout).
 */
const fusedDescription = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>,
	heading: Heading
): FusedAttachment => ({
	attach,
	name: attach.name,
	parentColumns: parentColumnsOf(cx, attach, spine, heading).map((c) => c.name),
	layout: fusedLayout(attach, attach.child.heading, attach.parent.heading)
})

/** The bound of a rows statement's rows over `node`: the facts' maximum cardinality. */
const rowsBoundOf = (facts: ShapeFacts, node: RelNode): RowsBound<never> => {
	const max = facts.maxCard(node)
	return max.kind === "unbounded" ? { kind: "unbounded" } : { kind: "count", max: max.rows }
}

interface DeliveredAttachment {
	readonly attach: NodeOf<"Attach">
	/** The nodes whose rows are the delivered rows, under the delivered heading's column names. */
	readonly spine: ReadonlyArray<RelNode>
}

interface RowsSpec<I extends ChoiceInput> {
	/**
	 * The rows, lowered in the statement being lowered: the statement's own, or a later statement's computing them
	 * again.
	 */
	readonly rel: () => OperandSelect
	readonly heading: Heading
	/** The node whose rows the statement delivers, for the facts. */
	readonly origin: RelNode
	readonly attachments: ReadonlyArray<DeliveredAttachment>
	readonly order: CompletedOrder | undefined
	readonly statement: StatementPlacement
	/** What identifies a delivered row: a row of `origin`, or nothing the facts know for a heading group. */
	readonly identity: RowsIdentity
	/** How many rows the statement delivers at most. */
	readonly bound: RowsBound<I>
}

/**
 * An optimized delivery whose delivered rows an input of `I` may bound (a page's requested size in a page, none
 * elsewhere), so its statements make per-execution choices by those inputs and by relation parameters (ShapeState).
 */
export class OptimizedDelivery<
	I extends ChoiceInput,
	Own extends PageParamSlot = never
> extends Delivery<Own> {
	readonly facts: ShapeFacts
	readonly state: ShapeState<I | RelationInput>

	constructor(cx: LowerContext, facts: ShapeFacts, state: ShapeState<I | RelationInput>) {
		super(cx)
		this.facts = facts
		this.state = state
	}

	/**
	 * The statement delivering `query`, a relation of heading `rows`, after the columns its role puts first, with the
	 * choices its lowering made: the refined output casts, the statement's WITH entries, the public names (the output
	 * heading, then each fused attachment's column), printed by sql/emit. A zero-column relation delivers its private
	 * unit column.
	 */
	#emitted(
		query: Select,
		rows: Heading,
		statement: StatementPlacement,
		fused: ReadonlyArray<FusedAttachment>
	): Lowered<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own> {
		const output = statementOutput(statement.role, rows, fused)
		const log = this.state.drain()
		let shaped = refineDelivered(this.cx, query, output.heading)
		const logged = [...log.ctes]
		if (isNonEmpty(logged)) {
			shaped = {
				...shaped,
				with:
					shaped.with === undefined
						? { ctes: logged, recursive: false }
						: { ...shaped.with, ctes: extendNonEmpty(logged, shaped.with.ctes) }
			}
		}
		return {
			statement: {
				...statement,
				...printedStatement(shaped, output.names, this.cx.supply),
				params: [...this.params.slots],
				heading: rows,
				fused
			},
			choices: log.choices
		}
	}

	/** One lowering of a statement by `lower` in `mode`, with names, placeholders and WITH entries of its own. */
	#lowered(
		mode: InputChoiceMode,
		lower: () => Select,
		rows: Heading,
		statement: StatementPlacement,
		fused: ReadonlyArray<FusedAttachment>
	): Lowered<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own> {
		this.state.begin(mode)
		this.beginStatement()
		return this.#emitted(lower(), rows, statement, fused)
	}

	/**
	 * The statement in its forms: its query lowered by `lower` in the small mode, each per-execution take
	 * in its small form, and, when that lowering made choices, lowered again in the large mode, each take in its large
	 * form, as the statement's large form. Both forms are this placement's, so they share its role and heading; only
	 * the query, its names and its placeholders differ.
	 */
	formed(
		lower: () => Select,
		rows: Heading,
		statement: StatementPlacement,
		fused: ReadonlyArray<FusedAttachment>
	): DeliveredStatement<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own> {
		const small = this.#lowered("small", lower, rows, statement, fused)
		const choices = small.choices
		if (!isNonEmpty(choices)) {
			return { ...small.statement, forms: oneForm }
		}
		const large = this.#lowered("large", lower, rows, statement, fused)
		return { ...small.statement, forms: { kind: "chosen", choices, large: large.statement } }
	}

	/**
	 * The delivered rows of a relation, ordered by its completed order with the heading appended only where the facts
	 * do not prove the order total (take/order.ts).
	 */
	deliveredRows(
		rel: OperandSelect,
		heading: Heading,
		origin: RelNode,
		order: CompletedOrder | undefined
	): Select {
		const source = this.cx.wrap(rel, heading, { kind: "node", node: origin.id })
		const orderBy: ReadonlyArray<OrderItem> =
			order === undefined || heading.length === 0
				? []
				: orderItemsOf(order, heading, source.map, {
						leading: [],
						total: orderIsTotal(this.facts, origin, order, heading),
						fixed: []
					})
		return {
			...select(
				keyedSet(headingTargets(heading, source.map), [source.item], undefined, "a delivery")
			),
			orderBy
		}
	}

	override program(
		root: RelNode
	): DeliveredProgram<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own> {
		const cx = this.cx
		const plan = this.heterogeneousPlan(root)
		if (plan !== undefined) {
			return { roots: this.headingGroups(plan), delivery: headingGroupsDelivery(plan) }
		}
		const order = root.kind === "OrderedResult" ? root.order : undefined
		const rows = root.kind === "OrderedResult" ? root.input : root
		const spine = this.spine(rows)
		const main = this.rowsStatement({
			rel: () => cx.lower(rows, emptyEnv),
			heading: rows.heading,
			origin: rows,
			attachments: spine.attachments.map((attach) => ({ attach, spine: spine.nodes })),
			order,
			statement: { role: { kind: "main" }, dependsOn: [] },
			identity: { kind: "node", node: rows },
			bound: rowsBoundOf(this.facts, rows)
		})
		const place = positions()
		const statement = place(main.build)
		return {
			roots: [{ statement, attachments: main.attachments(place) }],
			delivery: { kind: "rows" }
		}
	}

	/**
	 * The scope of the child of an attachment `context` describes. The delivery's own context lowers outside any
	 * attachment (optimizedDispatch), so a parent's rows computed again inside an attachment's statement, through it,
	 * are lowered as in their own statement.
	 */
	inAttachment(context: AttachmentContext<I>): LowerContext {
		return this.cx.withDispatch(dispatchIn(this.facts, this.state, context))
	}

	/**
	 * A rows statement and its attachments (R36): fused as columns of the statement, which `build` builds at the
	 * position it is placed at, or each a pipelined statement under it, which `attachments` places once the rows
	 * statement is placed.
	 *
	 * An attachment is the nest operator: for each delivered parent fact, the set of its correlated child facts; the
	 * parent set is unchanged, never filtered, multiplied or reordered. Two lowerings deliver identical nested results,
	 * chosen by the rule and never by the caller:
	 *
	 * - pipelined: one statement per attached query, in the parent statement's flight and snapshot, which computes the
	 *   parent's rows again as a derived table of its own (conservative/deliver.ts parentRowsSource); the library
	 *   stitches children onto parents by key;
	 * - fused: the child inside the parent statement as `ARRAY(SELECT ...)`, an empty array rather than NULL, directly
	 *   for a single field and as `ARRAY(SELECT to_jsonb(...))` for several, decoded by the attachment's codec
	 *   (attach/decode.ts), a child whose correlated columns the parent row supplies included.
	 *
	 * A LEFT JOIN with padded columns is never emitted. Parent predicates stay on the parent and are never pushed into a
	 * child, which correlates to delivered parents only: the fused column is computed over the parent's delivered rows,
	 * read as a derived table, so the parent's plan is the plan it would have alone and an attachment on a page is
	 * evaluated over the delivered page only.
	 *
	 * Every attachment is pipelined, its own statement in the same round trip, unless the statement's rows read an
	 * approximate search: then every one is fused, since a pipelined statement computes its parent's rows again, which
	 * would run the search a second time, and two HNSW searches in one snapshot need not retrieve the same set. A child
	 * that must be a statement of its own (check/approximate/attach.ts pipelinedOnly: a recursive child, seeded once
	 * from the parent keys (R37, attach-recursive), a child over an approximate source, evaluated once per execution,
	 * and a child with attachments of its own, a heterogeneous union or a bytes column, whose values travel in chunks
	 * (codec/delivery.ts), each delivering more than one array can carry) never sits under rows that read a search: the
	 * lowering takes only an admitted query (check/index.ts AdmittedQuery). No width or count decides the form: a
	 * pipelined statement's cost is one more statement in the flight, never a different answer.
	 */
	rowsStatement(spec: RowsSpec<I>): {
		readonly build: (
			position: number
		) => DeliveredStatement<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own>
		readonly attachments: (
			place: Place
		) => ReadonlyArray<
			AttachedTree<DeliveredStatement<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own>>
		>
	} {
		const cx = this.cx
		const searches = searchInRows(spec.origin) !== undefined
		const fused = searches ? spec.attachments : []
		const pipelined = searches ? [] : spec.attachments
		/** withFusedAttachments reads every fused child over one spine: the delivered rows' nodes. */
		const spine = [...new Set(fused.flatMap((a) => a.spine))]
		const lowered = (): Select => {
			const rel = spec.rel()
			return fused.length === 0
				? this.deliveredRows(rel, spec.heading, spec.origin, spec.order)
				: withFusedAttachments(
						this.inAttachment({
							spine: new Set(spine.map((n) => n.id)),
							parents: { kind: "bounded", max: 1n }
						}),
						rel,
						spec.rel,
						spec.heading,
						spec.origin,
						spine,
						fused.map((a) => a.attach),
						this.facts,
						spec.order
					).query
		}
		const columns = fused.map((a) => fusedDescription(cx, a.attach, a.spine, spec.heading))
		return {
			build: () => this.formed(lowered, spec.heading, spec.statement, columns),
			attachments: (place) => {
				const rows: DeliveredRows<I> = {
					...statementRows(spec.heading, spec.rel),
					identity: spec.identity,
					bound: spec.bound
				}
				return pipelined.map((a) => this.pipelined(place, a.attach, a.spine, rows))
			}
		}
	}

	/**
	 * One pipelined attachment's statement in the statement being lowered, or its seeded recursive form (R37), with
	 * its child lowered over the parent rows' bound and its parent key `parentKey`.
	 */
	pipelinedQuery(
		attach: NodeOf<"Attach">,
		spine: ReadonlyArray<RelNode>,
		rows: DeliveredRows<I>,
		parentKey: Heading
	): PipelinedAttachment {
		const child = this.inAttachment({
			spine: new Set(spine.map((n) => n.id)),
			parents: parentsOfRows(rows.bound)
		})
		return (
			seededAttachment(child, attach, spine, rows, this.facts, parentKey) ??
			pipelinedAttachment(child, attach, spine, rows, this.facts, parentKey)
		)
	}

	/**
	 * One pipelined attachment, a statement of its own in its parent's flight that computes the parent's rows again;
	 * its child's own attachments are pipelined after it, over its rows. Those rows read no search: the query is
	 * admitted (check/index.ts AdmittedQuery).
	 */
	pipelined(
		place: Place,
		attach: NodeOf<"Attach">,
		spine: ReadonlyArray<RelNode>,
		rows: DeliveredRows<I>
	): AttachedTree<DeliveredStatement<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own>> {
		const cx = this.cx
		this.oneHeadingAttached(attach)
		const child = attach.child
		const parentKey = parentColumnsOf(cx, attach, spine, rows.heading)
		const statement = place(() =>
			this.formed(
				() =>
					checkedAttachment(
						cx,
						attach,
						this.pipelinedQuery(attach, spine, rows, parentKey).query,
						parentKey,
						child.heading,
						rows
					),
				child.heading,
				{ role: { kind: "attachment", parentKey }, dependsOn: [] },
				[]
			)
		)
		const childSpine = this.spine(attach.child)
		const childRows: DeliveredRows<I> = {
			...attachmentRows(
				parentKey,
				child.heading,
				() => this.pipelinedQuery(attach, spine, rows, parentKey).rows
			),
			identity: attachmentRowsIdentity(cx, attach, spine),
			bound: boundTimes(rows.bound, this.facts.maxCard(attach.child))
		}
		const attachments = childSpine.attachments.map((nested) =>
			this.pipelined(place, nested, childSpine.nodes, childRows)
		)
		return { statement, attach, attachments }
	}

	/** One statement per heading group (R21), each with its pipelined attachments' statements (groupSpec). */
	headingGroups(
		plan: HeterogeneousPlan
	): StatementRoots<DeliveredStatement<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own>> {
		const place = positions()
		return mapNonEmpty(plan.union.groups, (group, gi) => {
			const built = this.rowsStatement(this.groupSpec(plan, gi, group))
			const statement = place(built.build)
			return { statement, attachments: built.attachments(place) }
		})
	}

	/**
	 * The rows of heading group `gi`, in the statement it begins: the group's rows, deduplicated unless proved unique
	 * (union/index.ts groupRows), the plan's filters, the take's first k in the common completed order, the delivery
	 * order, and the attachments above the union and those of a group's single arm.
	 */
	groupSpec(
		plan: HeterogeneousPlan,
		gi: number,
		group: HeterogeneousPlan["union"]["groups"][number]
	): RowsSpec<I> {
		const cx = this.cx
		const { union } = plan
		const take = groupTake(plan)
		const at = nodeLabel(union)
		const scopeNodes = [...plan.spineNodes, union]
		/** The group's rows, lowered in the statement being lowered: its own, or an attachment's computing them again. */
		const lowered = (): Select => {
			let rel = groupRows(cx, union, group, emptyEnv, this.facts)
			const filters = plan.filters
			if (isNonEmpty(filters)) {
				const input = cx.wrap(rel, group.heading, {
					kind: "node",
					node: lastNonEmpty(filters).id
				})
				const scope: Env = new Map(scopeNodes.map((n) => [n.id, input.map]))
				rel = select(
					keyedSet(
						headingTargets(group.heading, input.map),
						[input.item],
						and(mapNonEmpty(filters, (f) => lowerExpr(cx, f.pred, scope))),
						"a heading group's filtered rows"
					)
				)
			}
			if (take !== undefined) {
				const bounded = cx.wrap(rel, group.heading, { kind: "node", node: take.id })
				const orderBy = orderItemsOf(take.order, group.heading, bounded.map, {
					leading: [],
					total: orderIsTotal(this.facts, union, take.order, union.heading),
					fixed: []
				})
				rel = {
					...select(
						keyedSet(
							headingTargets(group.heading, bounded.map),
							[bounded.item],
							undefined,
							"a heading group's bounded rows"
						)
					),
					orderBy,
					limit: cx.boundExpr(take.bound)
				}
			}
			return rel
		}
		const rel = lowered
		const attachments: Array<DeliveredAttachment> = plan.attachments.map((attach) => ({
			attach,
			spine: scopeNodes
		}))
		const [only, ...others] = group.arms
		if (others.length === 0) {
			const armSpine = this.spine(only)
			for (const attach of armSpine.attachments) {
				attachments.push({ attach, spine: armSpine.nodes })
			}
		} else {
			const attached = group.arms.find((arm) => this.spine(arm).attachments.length > 0)
			if (attached !== undefined) {
				refuse(
					"UnsupportedOperation",
					at,
					`attachments on the arm ${attached.id} of a heading group of several arms`
				)
			}
		}
		return {
			rel,
			heading: group.heading,
			origin: union,
			attachments,
			order: groupOrder(plan),
			statement: { role: { kind: "headingGroup", group: gi }, dependsOn: [] },
			identity: { kind: "unkeyed" },
			bound: rowsBoundOf(this.facts, union)
		}
	}
}
