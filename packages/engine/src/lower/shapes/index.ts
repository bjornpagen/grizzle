import { searchInRows } from "#compiler/check/approximate/attach.ts"
import { appendAll } from "#compiler/core/array.ts"
import { canonicalEquals, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { lateralParentMax } from "#compiler/core/limits.ts"
import {
	concatNonEmpty,
	extendNonEmpty,
	isNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import type { CompletedOrder, Heading, NodeOf, RelKind, RelNode } from "#compiler/ir/rel.ts"
import {
	columnIn,
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
	checkedAttachment,
	Delivery,
	groupOrder,
	groupTake,
	type HeterogeneousPlan,
	headingGroupsDelivery,
	parentColumnsOf,
	printedStatement,
	statementRows
} from "#compiler/lower/conservative/deliver.ts"
import { conservativeLowerers } from "#compiler/lower/conservative/dispatch.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { bindLaterally } from "#compiler/lower/conservative/expr/lateral.ts"
import {
	keySetOf,
	type ParentFixed,
	parentFixed,
	type RowKeys
} from "#compiler/lower/conservative/keys.ts"
import { orderItemsOf } from "#compiler/lower/conservative/take/order.ts"
import {
	type ConservativeParamSlot,
	type ConservativeProgram,
	type ConservativeStatement,
	type DeclaredParamSlot,
	flight,
	type PageParamSlot,
	type ProgramDelivery
} from "#compiler/lower/conservative/types.ts"
import type { CtePlan, CteStrategy } from "#compiler/lower/optimize/cte-policy/index.ts"
import { partQuery, shiftedPart, type TaggedPart, taggedParts } from "#compiler/lower/parts.ts"
import { aggregateLowerer } from "#compiler/lower/shapes/aggregate/index.ts"
import { seededAttachment } from "#compiler/lower/shapes/attach-recursive/index.ts"
import {
	boundTimes,
	type DeliveredRows,
	fusedLayout,
	type PipelinedAttachment,
	pipelinedAttachment,
	type RowsBound,
	withFusedAttachments
} from "#compiler/lower/shapes/attach/index.ts"
import { catalogLowerers } from "#compiler/lower/shapes/catalog/native.ts"
import { recursionLowerer } from "#compiler/lower/shapes/recursion/index.ts"
import { refineDelivered } from "#compiler/lower/shapes/refined/index.ts"
import { regionLowerer } from "#compiler/lower/shapes/region/index.ts"
import { inputSetLowerer } from "#compiler/lower/shapes/relparam/index.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
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
import { executableQuery, executableQueryFrom } from "#compiler/lower/template.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import { oneForm, type StatementForms } from "#compiler/runtime/lower/forms.ts"
import type { FusedAttachment } from "#compiler/runtime/lower/fused.ts"
import {
	type AttachedTree,
	deliveredHeading,
	mapTree,
	type RowsRole,
	type StatementRole,
	statementOutput,
	type StatementRoots,
	type StatementTree
} from "#compiler/runtime/lower/tree.ts"
import {
	type Cte,
	type EmittedSql,
	isSetQuery,
	type OperandBody,
	type OperandSelect,
	type OrderItem,
	type Select
} from "#compiler/sql/ast.ts"
import {
	and,
	col,
	conjunction,
	cteRead,
	type DefinedCte,
	derived,
	keyedSet,
	select,
	target
} from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import {
	freshNames,
	type NameMap,
	type NameOrigin,
	NameSupply,
	namesPast
} from "#compiler/sql/naming.ts"

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
 * A statement of an optimized delivery as the conservative statement shape, with the attachments fused into it as
 * output columns after the heading, in order: the statement a page's conservative artifact places, and what a
 * statement of a conservative program fuses (none).
 */
export type FusedStatement<Slot extends ConservativeParamSlot = DeclaredParamSlot> =
	ConservativeStatement<Slot> & {
		readonly fused: ReadonlyArray<FusedAttachment>
	}

/**
 * A delivered relation of a program, as the runtime reads it: its role (an attachment's with its parent key), the
 * heading of the relation, its fused attachments, and `answer`, the position of its rows among the runs of the
 * program's answer, its part's tag (StatementParts).
 */
export interface DeliveredPart {
	readonly role: StatementRole
	readonly heading: Heading
	readonly fused: ReadonlyArray<FusedAttachment>
	readonly answer: number
}

/**
 * A part of a statement of tagged parts as its lowering built it: how the host reads its rows (lower/parts.ts
 * TaggedPart), and `delivered`, the query whose rows it delivers as lowered, before its executable form casts its
 * outputs to texts and the statement tags them: a query of its own, its WITH each CTE of the statement it may read, its
 * operands not yet bound laterally (lower/conservative/expr/lateral.ts bindLaterally), which moves a binding into its
 * core's FROM and changes no column's type. The type oracle describes it as it describes a statement of one part.
 */
export interface LoweredTaggedPart extends TaggedPart {
	readonly delivered: Select
}

/**
 * How the rows of a program's statement divide into its parts: all of them its one part's, the statement its part
 * delivers as lowered (`delivered`, which an embedding reads, before its executable form casts its outputs to text);
 * or each behind its tag, the part's position in part order, each as lowered (LoweredTaggedPart).
 */
export type StatementParts<Slot extends ConservativeParamSlot = DeclaredParamSlot> =
	| { readonly kind: "one"; readonly delivered: FusedStatement<Slot> }
	| { readonly kind: "tagged"; readonly parts: NonEmptyReadonlyArray<LoweredTaggedPart> }

/** One form of the statement a program sends: its executable AST, its text and its placeholders. */
export interface SentStatement<Slot extends ConservativeParamSlot = DeclaredParamSlot> {
	readonly ast: Select
	readonly sql: EmittedSql
	readonly params: ReadonlyArray<Slot>
}

/**
 * The statement an optimized program sends, in its small form, with its forms by the per-execution choices of kind C
 * its shapes made: its large form is the same parts lowered in the large mode.
 */
export type FormedStatement<
	C,
	Slot extends ConservativeParamSlot = DeclaredParamSlot
> = SentStatement<Slot> & { readonly forms: StatementForms<C, SentStatement<Slot>> }

/**
 * The one statement a program sends, in its forms, how its rows divide into parts, and each part's delivered relation,
 * in their tree, in part order.
 */
export interface PartedStatement<
	C = unknown,
	Slot extends ConservativeParamSlot = DeclaredParamSlot
> {
	readonly statement: FormedStatement<C, Slot>
	readonly parts: StatementParts<Slot>
	readonly roots: StatementRoots<DeliveredPart>
}

/** An optimized delivery's program: its parted statement, and how the runtime delivers its parts' rows. */
export interface OptimizedDeliveryProgram<
	C = unknown,
	Slot extends ConservativeParamSlot = DeclaredParamSlot
> extends PartedStatement<C, Slot> {
	readonly delivery: ProgramDelivery
}

/**
 * A conservative program's statements as the parts of one statement, as the runtime runs an optimized program's: the
 * oracles' baseline. A program of one statement sends that statement's executable query; one of several sends each as
 * a part (lower/parts.ts), its executable query a CTE whose rows the statement delivers behind its tag, its
 * placeholders renumbered past the earlier statements' (shiftedPart). Each part still computes its parent key's set
 * itself and reads nothing of another part. Its lowering named each statement past the one before
 * (conservative/context.ts beginStatement), so no name is defined twice in it, and the parts' CTEs name past them all.
 */
export const partedConservative = <Slot extends ConservativeParamSlot>(
	roots: StatementRoots<ConservativeStatement<Slot>>
): PartedStatement<never, Slot> => {
	const parts = mapTree(roots, (s, answer): DeliveredPart => ({
		role: s.role,
		heading: s.heading,
		fused: [],
		answer
	}))
	const [only, ...others] = flight(roots)
	if (!isNonEmpty(others)) {
		const delivered: FusedStatement<Slot> = { ...only, fused: [] }
		const ast = executableQuery(delivered)
		return {
			statement: {
				ast,
				sql: emitted(ast, only.sql.nameMap),
				params: only.params,
				forms: oneForm
			},
			parts: { kind: "one", delivered },
			roots: parts
		}
	}
	const statements: NonEmptyReadonlyArray<ConservativeStatement<Slot>> = [only, ...others]
	const supply = new NameSupply(
		statements.reduce((start, s) => namesPast(s.sql.nameMap, start), freshNames)
	)
	const params: Array<Slot> = []
	const names: Array<NameMap[number]> = []
	const tagged = mapNonEmpty(statements, (s) => {
		const shift = shiftedPart(s.ast, s.params, params.length)
		appendAll(params, shift.params)
		appendAll(names, s.sql.nameMap)
		const executable = executableQueryFrom(
			{ ast: shift.query, role: s.role, heading: s.heading, fused: [] },
			supply
		)
		const { query, columns, shape } = partQuery(executable, supply)
		const name = supply.relation({ kind: "internal", purpose: "statement part" })
		return {
			cte: { name, columns, materialized: undefined, query },
			shape: { ...shape, delivered: shift.query }
		}
	})
	const { body } = taggedParts(
		mapNonEmpty(tagged, (p) => ({ name: p.cte.name, columns: p.cte.columns })),
		0
	)
	const ast: Select = {
		...select(body),
		with: { recursive: false, ctes: mapNonEmpty(tagged, (p) => p.cte) }
	}
	return {
		statement: {
			ast,
			sql: emitted(ast, [...names, ...supply.map()]),
			params,
			forms: oneForm
		},
		parts: { kind: "tagged", parts: mapNonEmpty(tagged, (p) => p.shape) },
		roots: parts
	}
}

/** A conservative program as one statement of parts (partedConservative), delivered as the program delivers. */
export const conservativeStatement = <Slot extends ConservativeParamSlot>(
	program: ConservativeProgram<Slot>
): OptimizedDeliveryProgram<never, Slot> => ({
	...partedConservative(program.roots),
	delivery: program.delivery
})

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
 * the parent rows of an attachment's own part or one row for a fused attachment's correlated subquery per delivered
 * parent row.
 */
interface AttachmentContext<I extends ChoiceInput> {
	/** The labels of the delivered rows' nodes, which a correlation's column references name. */
	readonly spine: ReadonlySet<NodeId>
	readonly parents: ParentSet<I>
}

/**
 * The parent set of the child of an attachment of its own part: the parent rows' bound. A page's attachment chooses
 * per execution by the requested size, which bounds the delivered page; any other count is known only once the parent
 * rows are, in the child's own statement, so the facts' bound fixes the form, and without one the child is read for
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
 * The delivery lowers a query's program as one statement of parts: the main rows, or one part per heading group of a
 * heterogeneous union delivered to the host (R21), and the attachments, fused into their parent's part as
 * ARRAY(SELECT ...) where the R36 rule selects it and otherwise parts of their own, over their parent's rows the
 * statement holds once (OptimizedDelivery rowsPart). A take correlated to a relation parameter, or in a page's
 * attachment to the delivered page, chooses its form per execution by that input's size, known before the statement is
 * sent: the delivery lowers the statement in the small mode and, when that lowering made choices, again in the large
 * mode (OptimizedDelivery #program). A take correlated to the parent rows of any other attachment takes the form the
 * parent rows' bound fixes (parentsOf).
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
			? withoutBoundary(query, facts.unique(node) === undefined ? "operand" : "certified")
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
 * attachment's delivered rows, the parent rows of an attachment's own part or one row of a fused attachment's
 * per-parent subquery, and otherwise what the DAG and the facts say (take/index.ts parentSetOf).
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
 * The dispatch of a delivery's parts, outside any attachment: its rows, and a parent's rows computed again inside an
 * attachment's part, are lowered as in their own part.
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
	/** The rows, lowered in the statement being lowered: delivered by their part, or held for their attachments. */
	readonly rel: () => OperandSelect
	readonly heading: Heading
	/** The node whose rows the part delivers, for the facts. */
	readonly origin: RelNode
	readonly attachments: ReadonlyArray<DeliveredAttachment>
	readonly order: CompletedOrder | undefined
	readonly role: RowsRole
	/** How many rows the part delivers at most. */
	readonly bound: RowsBound<I>
}

/** A part of the statement being lowered: its rows' query in its delivery order, its role, heading and fused columns. */
interface LoweredPart {
	readonly query: Select
	readonly role: StatementRole
	readonly heading: Heading
	readonly fused: ReadonlyArray<FusedAttachment>
}

/** An attachment placed as a part of its own under its parent's rows: the attachment, its parent key and its part. */
interface PlacedAttachment {
	readonly attach: NodeOf<"Attach">
	readonly parentKey: Heading
	readonly part: DeliveredPart
}

/** Rows a statement holds once (OptimizedDelivery #held): every column of them, a set. */
interface HeldRows {
	readonly rows: () => OperandSelect
}

/**
 * An attachment part's rows a statement holds once (OptimizedDelivery #heldPairs), each a parent key and a child, and
 * the child's columns alone: a set where the child fixes its parent key (keys.ts ParentFixed), since each pair is one
 * row and the child names its one parent, and an operand otherwise.
 */
interface HeldPairs extends HeldRows {
	readonly children: () => OperandSelect
}

/**
 * `query` with the statement entries `entries` leading its WITH, as a statement of its own holds the CTEs its lowering
 * defined.
 */
const withEntries = (query: Select, entries: ReadonlyArray<Cte>): Select =>
	isNonEmpty(entries)
		? {
				...query,
				with:
					query.with === undefined
						? { ctes: entries, recursive: false }
						: { ...query.with, ctes: extendNonEmpty(entries, query.with.ctes) }
			}
		: query

/** The text of the statement `ast` under the names `nameMap`, which a statement the lowering built always prints. */
const emitted = (ast: Select, nameMap: NameMap): EmittedSql => {
	const printed = emit(ast, nameMap)
	if (!printed.ok) {
		throw new Refusal(printed.error)
	}
	return printed.value
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

	/** The parts of the statement being lowered, in part order. */
	#placed: Array<LoweredPart> = []
	/** The attachments placed under each parent's rows in the statement being lowered, by those rows, in part order. */
	#siblings = new Map<DeliveredRows<I>, Array<PlacedAttachment>>()

	/** The part `part`, placed at the next position of the statement being lowered, as the runtime reads it. */
	#place(part: LoweredPart): DeliveredPart {
		const answer = this.#placed.length
		this.#placed.push(part)
		return { role: part.role, heading: part.heading, fused: part.fused, answer }
	}

	/**
	 * The rows `query` delivers, `width` columns, a set, held once by the statement being lowered: a MATERIALIZED CTE of
	 * its WITH, defined here, after every CTE `query` reads, which a part and every part under it read in place of
	 * computing them again. Its name and columns.
	 */
	#hold(query: OperandSelect, width: number, origin: NameOrigin): Omit<DefinedCte, "set"> {
		const name = this.cx.relationAlias(origin)
		const columns = this.cx.supply.columns(Array.from({ length: width }, () => origin))
		this.state.log.ctes.add({ name, columns, materialized: "MATERIALIZED", query })
		return { name, columns }
	}

	/** The rows `query` delivers, `width` columns, held once (`#hold`). */
	#held(query: OperandSelect, width: number, origin: NameOrigin): HeldRows {
		const held = this.#hold(query, width, origin)
		return { rows: () => cteRead(this.cx.relationAlias(origin), { ...held, set: true }) }
	}

	/**
	 * An attachment part's rows `query` delivers, the parent key's `keyWidth` columns then the child's `childWidth`,
	 * held once (`#hold`), its children alone a set where `fixed` proves the child fixes its parent key.
	 */
	#heldPairs(
		query: OperandSelect,
		keyWidth: number,
		childWidth: number,
		origin: NameOrigin,
		fixed: ParentFixed | undefined
	): HeldPairs {
		const held = this.#hold(query, keyWidth + childWidth, origin)
		return {
			rows: () => cteRead(this.cx.relationAlias(origin), { ...held, set: true }),
			children: () =>
				cteRead(this.cx.relationAlias(origin), {
					name: held.name,
					columns: held.columns.slice(keyWidth),
					set: fixed !== undefined
				})
		}
	}

	/**
	 * What the rows a part delivers of `node` prove of their keys (keys.ts keySetOf): the physical analysis's key of one
	 * evaluation of `node`, which holds across evaluations where `node` reads nothing of an enclosing node or, for an
	 * attachment's child, where `fixed` proves the child fixes its parent key.
	 */
	#rowKeys(node: RelNode, fixed: ParentFixed | undefined): RowKeys {
		return (columns) =>
			keySetOf(columns, this.facts.keyedBy(node, columns), this.cx.freeRefs(node), fixed)
	}

	/**
	 * The program `place` places, in its forms: its parts lowered in one statement in the small mode, each
	 * per-execution take in its small form, and, when that lowering made choices, lowered again in the large mode as
	 * the statement's large form. Both forms place the same parts, so they share the parts' tree and how the rows divide
	 * into them; only the statement, its names and its placeholders differ.
	 */
	#program(
		place: () => StatementRoots<DeliveredPart>
	): PartedStatement<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own> {
		const small = this.#statement("small", place)
		if (!isNonEmpty(small.choices)) {
			return {
				statement: { ...small.sent, forms: oneForm },
				parts: small.parts,
				roots: small.roots
			}
		}
		const large = this.#statement("large", place)
		return {
			statement: {
				...small.sent,
				forms: { kind: "chosen", choices: small.choices, large: large.sent }
			},
			parts: small.parts,
			roots: small.roots
		}
	}

	/**
	 * The one statement of the parts `place` places, lowered in `mode` with names, placeholders and WITH entries of its
	 * own, every part in that statement.
	 *
	 * One part is the statement: its query, its refined output casts, the statement's WITH entries and its public
	 * names, printed by sql/emit, then its executable form (template.ts executableQueryFrom), exactly as a statement of
	 * its own. Several parts are each part's executable form as a CTE of the statement after its WITH entries
	 * (lower/parts.ts partQuery), and the statement's rows are each part's rows behind its tag (lower/parts.ts
	 * taggedParts). A part's refined outputs are refined over the statement's WITH entries, which the refinement retypes
	 * with the part, so every part and entry reads one placeholder alike.
	 */
	#statement(
		mode: InputChoiceMode,
		place: () => StatementRoots<DeliveredPart>
	): {
		readonly sent: SentStatement<DeclaredParamSlot | Own>
		readonly parts: StatementParts<DeclaredParamSlot | Own>
		readonly roots: StatementRoots<DeliveredPart>
		readonly choices: ReadonlyArray<ShapeChoice<I | RelationInput>>
	} {
		this.state.begin(mode)
		this.beginStatement()
		this.#placed = []
		this.#siblings = new Map()
		const roots = place()
		const placed = this.#placed
		this.#placed = []
		this.#siblings = new Map()
		const log = this.state.drain()
		const cx = this.cx
		const supply = cx.supply
		const [only, ...others] = placed
		if (only === undefined) {
			throw defect("a program places its rows' part")
		}
		if (!isNonEmpty(others)) {
			const output = statementOutput(only.role, only.heading, only.fused)
			const printed = printedStatement(
				withEntries(refineDelivered(cx, only.query, output.heading), [...log.ctes]),
				output.names,
				supply
			)
			const executable = executableQueryFrom(
				{ ast: printed.ast, role: only.role, heading: only.heading, fused: only.fused },
				new NameSupply(namesPast(printed.sql.nameMap, freshNames))
			)
			const params = [...this.params.slots]
			return {
				sent: { ast: executable, sql: emitted(executable, printed.sql.nameMap), params },
				parts: {
					kind: "one",
					delivered: {
						...printed,
						params,
						role: only.role,
						heading: only.heading,
						fused: only.fused
					}
				},
				roots,
				choices: log.choices
			}
		}
		let entries: ReadonlyArray<Cte> = [...log.ctes]
		const parts = mapNonEmpty([only, ...others], (part) => {
			const output = statementOutput(part.role, part.heading, part.fused)
			const refined = refineDelivered(cx, withEntries(part.query, entries), output.heading)
			const refinedWith = refined.with?.ctes ?? []
			const own = refinedWith.slice(entries.length)
			entries = refinedWith.slice(0, entries.length)
			const executable = executableQueryFrom(
				{
					ast: {
						...refined,
						with:
							isNonEmpty(own) && refined.with !== undefined
								? { ...refined.with, ctes: own }
								: undefined
					},
					role: part.role,
					heading: part.heading,
					fused: part.fused
				},
				supply
			)
			const { query, columns, shape } = partQuery(executable, supply)
			const name = supply.relation({ kind: "internal", purpose: "statement part" })
			return {
				cte: { name, columns, materialized: undefined, query },
				shape: { ...shape, delivered: refined }
			}
		})
		const { body } = taggedParts(
			mapNonEmpty(parts, (p) => ({ name: p.cte.name, columns: p.cte.columns })),
			0
		)
		const ast = bindLaterally(
			{
				...select(body),
				with: {
					recursive: false,
					ctes: concatNonEmpty(
						entries,
						mapNonEmpty(parts, (p) => p.cte)
					)
				}
			},
			supply
		)
		return {
			sent: { ast, sql: emitted(ast, supply.map()), params: [...this.params.slots] },
			parts: { kind: "tagged", parts: mapNonEmpty(parts, (p) => p.shape) },
			roots,
			choices: log.choices
		}
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

	/** The program delivering `root`'s rows, its attachments' and its heading groups', as one statement (`#program`). */
	optimizedProgram(
		root: RelNode
	): OptimizedDeliveryProgram<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own> {
		const cx = this.cx
		const plan = this.heterogeneousPlan(root)
		if (plan !== undefined) {
			return {
				...this.#program(() => this.headingGroups(plan)),
				delivery: headingGroupsDelivery(plan)
			}
		}
		const order = root.kind === "OrderedResult" ? root.order : undefined
		const rows = root.kind === "OrderedResult" ? root.input : root
		const spine = this.spine(rows)
		const program = this.#program(() => [
			this.rowsPart({
				rel: () => cx.lower(rows, emptyEnv),
				heading: rows.heading,
				origin: rows,
				attachments: spine.attachments.map((attach) => ({ attach, spine: spine.nodes })),
				order,
				role: { kind: "main" },
				bound: rowsBoundOf(this.facts, rows)
			})
		])
		return { ...program, delivery: { kind: "rows" } }
	}

	/**
	 * A page's program of the parts `place` places (shapes/page/compile.ts), as one statement (`#program`): its rows
	 * parts (placedRows) and their attachments' (pipelinedPart), over the page's rows the statement holds (heldRows).
	 */
	pageProgram(
		place: () => StatementRoots<DeliveredPart>
	): PartedStatement<ShapeChoice<I | RelationInput>, DeclaredParamSlot | Own> {
		return this.#program(place)
	}

	/** The part delivering `query`, rows of heading `heading` in their delivery order, of role `role`, placed next. */
	placedRows(query: Select, heading: Heading, role: RowsRole): DeliveredPart {
		return this.#place({ query, role, heading, fused: [] })
	}

	/**
	 * The rows `query` delivers, of heading `heading`, held once by the statement being lowered (`#held`), as the parts
	 * of the attachments over them read them, at most `bound` of them.
	 */
	heldRows(
		query: OperandSelect,
		heading: Heading,
		origin: RelNode,
		bound: RowsBound<I>
	): DeliveredRows<I> {
		const held = this.#held(query, deliveredHeading(heading).length, {
			kind: "node",
			node: origin.id
		})
		return {
			...statementRows(this.cx, heading, origin, held.rows, this.#rowKeys(origin, undefined)),
			bound
		}
	}

	/**
	 * The scope of the child of an attachment `context` describes. The delivery's own context lowers outside any
	 * attachment (optimizedDispatch), so a parent's rows computed again inside an attachment's part, through it, are
	 * lowered as in their own part.
	 */
	inAttachment(context: AttachmentContext<I>): LowerContext {
		return this.cx.withDispatch(dispatchIn(this.facts, this.state, context))
	}

	/**
	 * A rows part and its attachments (R36): fused as columns of the part, or each a part of its own in the same
	 * statement after it.
	 *
	 * An attachment is the nest operator: for each delivered parent fact, the set of its correlated child facts; the
	 * parent set is unchanged, never filtered, multiplied or reordered. Two lowerings deliver identical nested results,
	 * chosen by the rule and never by the caller:
	 *
	 * - a part of its own: the child's facts correlated to each parent key of the parent's rows. A parent with
	 *   attachments of this kind holds its rows once, a MATERIALIZED CTE of the statement (`#held`), which its own part
	 *   delivers and every attachment under it reads its parent key's set from (conservative/deliver.ts
	 *   parentKeysSource), so no part computes a relation above it again; the library stitches children onto parents by
	 *   key, each part's rows read behind its tag;
	 * - fused: the child inside the parent's part as `ARRAY(SELECT ...)`, an empty array rather than NULL, directly for a
	 *   single field and as `ARRAY(SELECT to_jsonb(...))` for several, decoded by the attachment's codec
	 *   (runtime/lower/fused.ts), a child whose correlated columns the parent row supplies included.
	 *
	 * A LEFT JOIN with padded columns is never emitted. Parent predicates stay on the parent and are never pushed into a
	 * child, which correlates to delivered parents only, so the parent's plan is the plan it would have alone and an
	 * attachment on a page is evaluated over the delivered page only.
	 *
	 * Every attachment is a part of its own unless the parent's rows read an approximate search: then every one is
	 * fused, since the search would be read again by the attachments' parts, and two HNSW searches in one snapshot need
	 * not retrieve the same set. A child that must be a part of its own (check/approximate/attach.ts pipelinedOnly: a
	 * recursive child, seeded once from the parent keys (R37, attach-recursive), a child over an approximate source,
	 * evaluated once per execution, and a child with attachments of its own, a heterogeneous union or a bytes column,
	 * whose values travel in chunks (codec/delivery.ts), each delivering more than one array can carry) never sits
	 * under rows that read a search: the lowering takes only an admitted query (check/index.ts AdmittedQuery). No width
	 * or count decides the form.
	 */
	rowsPart(spec: RowsSpec<I>): StatementTree<DeliveredPart> {
		const cx = this.cx
		const searches = searchInRows(spec.origin) !== undefined
		const fused = searches ? spec.attachments : []
		const pipelined = searches ? [] : spec.attachments
		if (!isNonEmpty(pipelined)) {
			/** withFusedAttachments reads every fused child over one spine: the delivered rows' nodes. */
			const spine = [...new Set(fused.flatMap((a) => a.spine))]
			const rel = spec.rel()
			const query =
				fused.length === 0
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
			const columns = fused.map((a) => fusedDescription(cx, a.attach, a.spine, spec.heading))
			return {
				statement: this.#place({ query, role: spec.role, heading: spec.heading, fused: columns }),
				attachments: []
			}
		}
		const origin = { kind: "node", node: spec.origin.id } as const
		const held = this.#held(spec.rel(), deliveredHeading(spec.heading).length, origin)
		const statement = this.#place({
			query: this.deliveredRows(held.rows(), spec.heading, spec.origin, spec.order),
			role: spec.role,
			heading: spec.heading,
			fused: []
		})
		const rows: DeliveredRows<I> = {
			...statementRows(
				cx,
				spec.heading,
				spec.origin,
				held.rows,
				this.#rowKeys(spec.origin, undefined)
			),
			bound: spec.bound
		}
		return {
			statement,
			attachments: pipelined.map((a) => this.pipelinedPart(a.attach, a.spine, rows))
		}
	}

	/**
	 * One pipelined attachment's rows in the part being lowered, or its seeded recursive form (R37), with its child
	 * lowered over the parent rows' bound and its parent key `parentKey`.
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
	 * One pipelined attachment, a part of its own in its parent's statement over its parent key's set; its child's own
	 * attachments are parts after it, over its rows, which it then holds once (`#held`) and delivers from. Those rows
	 * read no search: the query is admitted (check/index.ts AdmittedQuery).
	 */
	pipelinedPart(
		attach: NodeOf<"Attach">,
		spine: ReadonlyArray<RelNode>,
		rows: DeliveredRows<I>
	): AttachedTree<DeliveredPart> {
		const cx = this.cx
		this.oneHeadingAttached(attach)
		const child = attach.child
		const parentKey = parentColumnsOf(cx, attach, spine, rows.heading)
		const role: StatementRole = { kind: "attachment", parentKey }
		const childSpine = this.spine(child)
		const siblings = this.#siblings.get(rows) ?? []
		this.#siblings.set(rows, siblings)
		const placed = (part: DeliveredPart): DeliveredPart => {
			siblings.push({ attach, parentKey, part })
			return part
		}
		if (!isNonEmpty(childSpine.attachments)) {
			const feeder = siblings.find((s) => this.#sameRows(s, attach, parentKey))
			if (feeder !== undefined) {
				return {
					statement: { role, heading: child.heading, fused: [], answer: feeder.part.answer },
					attach,
					attachments: []
				}
			}
			const built = this.pipelinedQuery(attach, spine, rows, parentKey)
			return {
				statement: placed(
					this.#place({
						query: checkedAttachment(cx, attach, built.query, parentKey, child.heading, rows),
						role,
						heading: child.heading,
						fused: []
					})
				),
				attach,
				attachments: []
			}
		}
		const built = this.pipelinedQuery(attach, spine, rows, parentKey)
		const origin = { kind: "node", node: attach.id } as const
		const childColumns = deliveredHeading(child.heading)
		const fixed = parentFixed(attach, parentKey)
		const held = this.#heldPairs(
			checkedAttachment(cx, attach, built.rows, parentKey, child.heading, rows),
			parentKey.length,
			childColumns.length,
			origin,
			fixed
		)
		const statement = placed(
			this.#place({
				query: this.#heldAttachment(held, parentKey, childColumns, built.order, origin),
				role,
				heading: child.heading,
				fused: []
			})
		)
		const childRows: DeliveredRows<I> = {
			...statementRows(cx, child.heading, child, held.children, this.#rowKeys(child, fixed)),
			bound: boundTimes(rows.bound, this.facts.maxCard(child))
		}
		return {
			statement,
			attach,
			attachments: childSpine.attachments.map((nested) =>
				this.pipelinedPart(nested, childSpine.nodes, childRows)
			)
		}
	}

	/**
	 * Whether the attachment placed as `placed` delivers the rows `attach` would, both under one parent's rows (R25):
	 * one parent key, each correlated to the same child column, one delivered type and order, a child of one heading,
	 * and children of one share key (share/index.ts shareKey), so in one snapshot they compute the same set. The share
	 * keys are read only where the rest agree.
	 */
	#sameRows(placed: PlacedAttachment, attach: NodeOf<"Attach">, parentKey: Heading): boolean {
		const other = placed.attach
		if (
			other.delivered !== attach.delivered ||
			!canonicalEquals(other.order, attach.order, everyProperty) ||
			!canonicalEquals(other.correlation, attach.correlation, everyProperty) ||
			!canonicalEquals(placed.parentKey, parentKey, everyProperty) ||
			!canonicalEquals(other.child.heading, attach.child.heading, everyProperty)
		) {
			return false
		}
		return this.#shareKey(other.child) === this.#shareKey(attach.child)
	}

	/** The share key of `child` within the delivery's DAG; a DAG it cannot key is refused. */
	#shareKey(child: RelNode): string {
		const key = shareKey(this.cx.dag, child)
		if (!key.ok) {
			throw new Refusal(key.error)
		}
		return key.value
	}

	/**
	 * An attachment part's rows from the rows `held` holds, the parent key's columns `parentKey` then the child's
	 * `child`, in the attachment's order (PipelinedAttachment order).
	 */
	#heldAttachment(
		held: HeldRows,
		parentKey: Heading,
		child: Heading,
		order: PipelinedAttachment["order"],
		origin: NameOrigin
	): Select {
		const cx = this.cx
		const alias = cx.relationAlias(origin)
		const keys = parentKey.map((c) => ({ name: c.name, column: cx.supply.column(origin) }))
		const own = child.map((c) => ({ name: c.name, column: cx.supply.column(origin) }))
		const columns = [...keys, ...own].map((c) => c.column)
		return {
			...select(
				keyedSet(
					columns.map((c) => target(col(alias, c))),
					[derived(held.rows(), alias, columns, false)],
					undefined,
					"an attachment's held rows"
				)
			),
			orderBy: order(
				new Map(keys.map((k) => [k.name, col(alias, k.column)])),
				new Map(own.map((c) => [c.name, col(alias, c.column)]))
			)
		}
	}

	/** One part per heading group (R21), each with its attachments' parts (groupSpec). */
	headingGroups(plan: HeterogeneousPlan): StatementRoots<DeliveredPart> {
		return mapNonEmpty(plan.union.groups, (group, gi) =>
			this.rowsPart(this.groupSpec(plan, gi, group))
		)
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
			role: { kind: "headingGroup", group: gi },
			bound: rowsBoundOf(this.facts, union)
		}
	}
}
