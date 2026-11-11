import { approximatePageMisuse } from "#compiler/check/approximate/provenance.ts"
import { canonicalEquals, catchRefusal, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, reportedAt } from "#compiler/core/errors.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import {
	isNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { contextAdmits } from "#compiler/ir/evidence.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { LogicalQuery, PageFill, SizeFill } from "#compiler/ir/products.ts"
import type {
	CompletedOrder,
	Heading,
	HeadingGroup,
	NodeOf,
	OrderKey,
	RelNode
} from "#compiler/ir/rel.ts"
import {
	analyzeLogical,
	type LogicalEnv,
	orderSubjectOf,
	queryEvidence
} from "#compiler/logical/annotate.ts"
import { completeOrder } from "#compiler/logical/order.ts"
import {
	type ColumnMap,
	distinctSelect,
	type Env,
	emptyEnv,
	headingTargets,
	LowerContext,
	nodeLabel,
	refuse,
	type StatementParams
} from "#compiler/lower/conservative/context.ts"

import {
	ConservativeDelivery,
	type Delivery,
	statementRows
} from "#compiler/lower/conservative/deliver.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { noRowKeys } from "#compiler/lower/conservative/keys.ts"
import { completedOrderItems, orderItemsOf } from "#compiler/lower/conservative/take/order.ts"
import type {
	ConservativeOptions,
	ConservativeStatement,
	PageParamSlot,
	PageStatementSlot
} from "#compiler/lower/conservative/types.ts"
import { armCore, setOperation } from "#compiler/lower/conservative/union/arms.ts"
import type { CtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import type { DedupPlan } from "#compiler/lower/optimize/dedup/plan.ts"
import type { DeliveredRows } from "#compiler/lower/shapes/attach/index.ts"
import {
	type DeliveredPart,
	OptimizedDelivery,
	optimizedDispatch,
	type PartedStatement,
	partedConservative,
	type ShapeChoice,
	ShapeState,
	withBoundary
} from "#compiler/lower/shapes/index.ts"
import { pagedRows, retainedGroupRows } from "#compiler/lower/shapes/page/rows.ts"
import {
	type AnchoredVariant,
	anchoredSeek,
	anchoredSlots,
	type PageComparator,
	type PageDirection,
	type PageVariant,
	type PlainVariant,
	pageComparators,
	plainSlots,
	type RequestSlots,
	reversedCompletedOrder,
	type VariantFill,
	variantDirection
} from "#compiler/lower/shapes/page/seek.ts"

import {
	discardCertificates,
	type ShapeFacts,
	shapeFactsFromPlan
} from "#compiler/lower/shapes/share/physical.ts"
import type { ChoiceInput, PageInput } from "#compiler/lower/shapes/take/index.ts"
import { orderIsTotal } from "#compiler/lower/shapes/take/order.ts"
import { assertMergeOrder, groupRows } from "#compiler/lower/shapes/union/index.ts"
import type { AttachedTree, RowsRole, StatementRoots } from "#compiler/runtime/lower/tree.ts"
import type { Expr, OperandSelect, OrderItem, Select } from "#compiler/sql/ast.ts"
import { and, keyedSet, select } from "#compiler/sql/build.ts"

/**
 * A page's program in its optimized artifact: one statement of parts, whose attachments choose by a relation
 * parameter or by the requested size (heldRows), its page placeholders each filled by one of `F`.
 */
export type PageProgram<F extends PageFill = PageFill> = PartedStatement<
	ShapeChoice,
	PageStatementSlot<F>
>

/**
 * One window variant: the direction it fetches in, how it delivers its rows, and its program, the rows parts (one, or
 * one per heading group) with their attachments' after each; for a heterogeneous union the runtime merges its heading
 * groups' rows in `order`, the fetch order, and keeps the size of them.
 * A mapped type indexed by its own keys, so a union of variants is the union of their programs, and the program of a
 * generic variant is the one an implementation over that variant builds.
 */
export type PageRequestProgram<V extends PageVariant = PageVariant> = {
	readonly [P in V]: {
		readonly variant: P
		readonly direction: PageDirection
		readonly delivery: PageRequestDelivery
		readonly program: PageProgram<VariantFill[P]>
	}
}[V]

/**
 * How the runtime delivers a request's rows: its one rows part's, or a heterogeneous union's heading-group parts,
 * which it merges in `order`, the fetch order.
 */
type PageRequestDelivery =
	| { readonly kind: "rows" }
	| {
			readonly kind: "headingGroups"
			readonly discriminant: ReadonlyArray<string>
			readonly order: CompletedOrder
	  }

/** A page's artifact: every window variant's program. */
export interface PageArtifact {
	readonly requests: { readonly [V in PageVariant]: PageRequestProgram<V> }
}

export interface PageTemplate {
	/**
	 * The presentation order: the user's stated order completed into a total order of the result by the order
	 * completion policy (pageOrderOf).
	 */
	readonly order: CompletedOrder
	/** A row's comparison tuple, its key, read from each delivered row by field name. */
	readonly comparators: ReadonlyArray<PageComparator>
	/**
	 * The delivered heading: the rows' heading, or a heterogeneous union's common heading, which every group carries.
	 * A heterogeneous union's requests deliver per heading group, each request's delivery naming the discriminant.
	 */
	readonly heading: Heading
	/** The optimized artifact: every window variant's statements, as the runtime sends them. */
	readonly artifact: PageArtifact
}

export interface PageCompileInput {
	/** The template's checked query, which its conservative artifact lowers (program/compile.ts programs.checked). */
	readonly checked: LogicalQuery
	/**
	 * The user's own order keys, the fields and directions of the outermost orderBy of the template's Description
	 * (statedOrderOf), and where they were stated. The page completes them itself, by the policy the checker's
	 * completion uses (check/order.ts) and under the schema's query evidence (`derived`); a heterogeneous union's page
	 * also names the discriminant its group merge reads (unionPageOrder).
	 */
	readonly stated: StatedOrder
	/**
	 * The template's optimized lowering: the rewritten query, its duplicate-elimination placement and its CTE plan
	 * (lower/optimize/pipeline.ts OptimizedProgram).
	 */
	readonly optimized: {
		readonly query: LogicalQuery
		readonly plan: DedupPlan
		readonly cte: CtePlan
	}
	readonly names: PhysicalNames
}

/**
 * The order a user stated for a page: the outermost orderBy's fields and directions, located where the checker
 * locates the stated order (check/checker.ts), so a refusal to complete it names the caller's orderBy.
 */
interface StatedOrder {
	readonly keys: ReadonlyArray<OrderKey>
	readonly at: SourceLoc
}

/** What a page delivers in one artifact: one relation, or one per heading group. */
type PageShape =
	| {
			readonly kind: "rows"
			readonly order: CompletedOrder
			readonly rows: RelNode
			readonly heading: Heading
			readonly spine: ReturnType<Delivery["spine"]>
	  }
	| {
			readonly kind: "groups"
			readonly order: CompletedOrder
			readonly heading: Heading
			readonly plan: NonNullable<ReturnType<Delivery["heterogeneousPlan"]>>
	  }

/**
 * One artifact's lowering: a fresh context and delivery, whose statements' page placeholders are each filled by one of
 * `F`, its parts of kind `S` and programs of kind `P`, and the artifact's own forms of D's rows, a heading group's
 * rows, the delivery order and the attachments.
 */
interface Kit<F extends PageFill, S, P> {
	readonly cx: LowerContext
	readonly delivery: Delivery<PageParamSlot<F>>
	/** The program of the parts `place` places: one statement of them all, or a statement each. */
	readonly program: (place: () => StatementRoots<S>) => P
	/**
	 * The request slots `slotsOf` allocates as each part reads them: once for the statement every part is a part of,
	 * or once for each part's own statement, after it begins.
	 */
	readonly slots: (slotsOf: () => RequestSlots) => () => RequestSlots
	/** The part delivering the query `lower` lowers, rows of heading `rows`, of role `role`. */
	readonly part: (lower: () => Select, rows: Heading, role: RowsRole) => S
	readonly rows: (node: RelNode) => OperandSelect
	readonly group: (
		plan: Extract<PageShape, { kind: "groups" }>["plan"],
		group: HeadingGroup
	) => Select
	readonly order: (
		order: CompletedOrder,
		heading: Heading,
		map: ColumnMap,
		origin: RelNode,
		originHeading: Heading
	) => ReadonlyArray<OrderItem>
	/**
	 * The page's rows of `origin`, of heading `heading`, that its attachments read, which `retained` lowers: at most the
	 * requested size of them, held once by the statement or computed again in each attachment's own.
	 */
	readonly retained: (
		retained: () => Select,
		heading: Heading,
		origin: RelNode
	) => DeliveredRows<PageInput>
	/** The parts of `attachments` over the page's rows `rows`. */
	readonly attach: (
		rows: DeliveredRows<PageInput>,
		spine: ReadonlyArray<RelNode>,
		attachments: ReadonlyArray<NodeOf<"Attach">>
	) => ReadonlyArray<AttachedTree<S>>
}

/**
 * The filters above a heterogeneous union, applied to one group's rows over the scope of the nodes between the
 * delivery and the union (conservative/deliver.ts groups, shapes/index.ts headingGroups).
 */
const filtered = (
	cx: LowerContext,
	plan: Extract<PageShape, { kind: "groups" }>["plan"],
	rel: Select,
	heading: Heading,
	distinct: boolean
): Select => {
	const filters = plan.filters
	if (!isNonEmpty(filters)) {
		return rel
	}
	const input = cx.wrap(rel, heading, { kind: "node", node: lastNonEmpty(filters).id })
	const scope: Env = new Map([...plan.spineNodes, plan.union].map((n) => [n.id, input.map]))
	const where = and(mapNonEmpty(filters, (f) => lowerExpr(cx, f.pred, scope)))
	const targets = headingTargets(heading, input.map)
	return distinct
		? distinctSelect(targets, [input.item], [where])
		: select(keyedSet(targets, [input.item], where, "a page group's filtered rows"))
}

/** The bound of a page's delivered rows: at most the requested size of them. */
const pageBound = { kind: "input", source: { kind: "pageSize" }, factor: 1n } as const

/**
 * The conservative artifact's kit, the page oracle's baseline: each part lowered as a statement of its own, which
 * computes the page's rows again for each attachment, and the program those statements' parts are of
 * (shapes/index.ts partedConservative).
 */
const conservativeKit = <F extends PageFill>(
	input: PageCompileInput
): Kit<F, ConservativeStatement<PageStatementSlot<F>>, PageProgram<F>> => {
	const options: ConservativeOptions = {
		names: input.names,
		params: input.checked.params,
		subject: { kind: "query" }
	}
	const cx = new LowerContext(input.checked.dag, options, dispatchNode)
	const delivery = new ConservativeDelivery<PageParamSlot<F>>(cx)
	return {
		cx,
		delivery,
		program: (place) => partedConservative(place()),
		slots: (slotsOf) => slotsOf,
		part: (lower, rows, role) => {
			delivery.beginStatement()
			return delivery.statement(lower(), rows, role)
		},
		rows: (node) => cx.lower(node, emptyEnv),
		group: (plan, g) => {
			const rel = setOperation(
				"UNION",
				mapNonEmpty(g.arms, (arm) => armCore(cx, arm, g.heading, emptyEnv))
			)
			return filtered(cx, plan, rel, g.heading, true)
		},
		order: (order, heading, map) => completedOrderItems(order, heading, map),
		retained: (retained, heading, origin) => ({
			...statementRows(cx, heading, origin, retained, noRowKeys),
			bound: pageBound
		}),
		attach: (rows, spine, attachments) => delivery.attachments({ nodes: spine, attachments }, rows)
	}
}

const optimizedKit = <F extends PageFill>(
	input: PageCompileInput,
	facts: ShapeFacts
): Kit<F, DeliveredPart, PageProgram<F>> => {
	const query = input.optimized.query
	const state = new ShapeState<ChoiceInput>("small", input.optimized.cte)
	const options: ConservativeOptions = {
		names: input.names,
		params: query.params,
		subject: { kind: "query" }
	}
	const cx = new LowerContext(query.dag, options, optimizedDispatch(facts, state))
	const delivery = new OptimizedDelivery<PageInput, PageParamSlot<F>>(cx, facts, state)
	return {
		cx,
		delivery,
		program: (place) => delivery.pageProgram(place),
		slots: (slotsOf) => {
			const slots = slotsOf()
			return () => slots
		},
		part: (lower, rows, role) => delivery.placedRows(lower(), rows, role),
		/**
		 * The page's rows are lowered outside any attachment's context, in their part and in the rows its attachments
		 * read alike.
		 */
		rows: (node) => {
			const lowered = cx.lower(node, emptyEnv)
			return facts.unique(node) === undefined ? withBoundary(cx, node, lowered) : lowered
		},
		group: (plan, g) =>
			filtered(cx, plan, groupRows(cx, plan.union, g, emptyEnv, facts), g.heading, false),
		order: (order, heading, map, origin, originHeading) =>
			orderItemsOf(order, heading, map, {
				leading: [],
				total: orderIsTotal(facts, origin, order, originHeading),
				fixed: []
			}),
		retained: (retained, heading, origin) =>
			delivery.heldRows(retained(), heading, origin, pageBound),
		attach: (rows, spine, attachments) =>
			attachments.map((attach) => delivery.pipelinedPart(attach, spine, rows))
	}
}

/**
 * The page shape of an artifact's DAG: its root an ordered result over D, or over a heterogeneous union delivered per
 * heading group.
 */
const pageShapeOf = <F extends PageFill>(
	delivery: Delivery<PageParamSlot<F>>,
	root: NodeOf<"OrderedResult">
): PageShape => {
	const plan = delivery.heterogeneousPlan(root)
	if (plan !== undefined) {
		const bound = plan.bound
		switch (bound.kind) {
			case "take":
			case "takeThenOrder":
				return refuse(
					"UnsupportedOperation",
					nodeLabel(bound.take),
					"a page over a bounded heterogeneous union: a group statement cannot tell which of its rows are among the union's first k, which only the merge across groups decides"
				)
			case "none":
			case "order":
				assertMergeOrder(plan.union, root.order)
				return { kind: "groups", order: root.order, heading: plan.union.heading, plan }
		}
	}
	const rows = root.input
	return {
		kind: "rows",
		order: root.order,
		rows,
		heading: rows.heading,
		spine: delivery.spine(rows)
	}
}

/** One delivered relation of a page: its rows, heading, role and attachments. */
interface PageSource<S> {
	readonly rel: () => OperandSelect
	readonly heading: Heading
	/** The node whose rows these are, for names and facts. */
	readonly origin: RelNode
	/** The node and heading the order's totality is proved on. */
	readonly orderOrigin: RelNode
	readonly orderHeading: Heading
	readonly role: RowsRole
	/** The parts of its attachments, over the page's rows they read. */
	readonly attachments: (rows: DeliveredRows<PageInput>) => ReadonlyArray<AttachedTree<S>>
}

const sourcesOf = <F extends PageFill, S, P>(
	kit: Kit<F, S, P>,
	shape: PageShape
): NonEmptyReadonlyArray<PageSource<S>> => {
	if (shape.kind === "rows") {
		return [
			{
				rel: () => kit.rows(shape.rows),
				heading: shape.heading,
				origin: shape.rows,
				orderOrigin: shape.rows,
				orderHeading: shape.heading,
				role: { kind: "main" },
				attachments: (rows) => kit.attach(rows, shape.spine.nodes, shape.spine.attachments)
			}
		]
	}
	const { plan } = shape
	const union = plan.union
	const at = nodeLabel(union)
	const scope = [...plan.spineNodes, union]
	return mapNonEmpty(union.groups, (g, gi) => ({
		rel: () => kit.group(plan, g),
		heading: g.heading,
		origin: union,
		orderOrigin: union,
		orderHeading: union.heading,
		role: { kind: "headingGroup", group: gi },
		attachments: (rows: DeliveredRows<PageInput>) => {
			const above = kit.attach(rows, scope, plan.attachments)
			const [only, ...others] = g.arms
			if (others.length === 0) {
				const armSpine = kit.delivery.spine(only)
				return [...above, ...kit.attach(rows, armSpine.nodes, armSpine.attachments)]
			}
			for (const arm of g.arms) {
				if (kit.delivery.spine(arm).attachments.length > 0) {
					refuse(
						"UnsupportedOperation",
						at,
						`attachments on the arm ${arm.id} of a heading group of several arms`
					)
				}
			}
			return above
		}
	}))
}

/**
 * One window variant's program, its page placeholders those `slotsOf` allocates into its parameter list: a plain
 * window's size, an anchored one's size and boundaries.
 */
const requestProgram = <F extends PageFill, S, P>(
	kit: Kit<F, S, P>,
	shape: PageShape,
	comparators: ReadonlyArray<PageComparator>,
	variant: PageVariant,
	slotsOf: (params: StatementParams<PageParamSlot<F>>) => RequestSlots
): P => {
	const cx = kit.cx
	const direction = variantDirection(variant)
	const sources = sourcesOf(kit, shape)
	/**
	 * One source's rows after its anchor's seek, in the fetch order, bounded by `limit`, the window's size, which is
	 * allocated after the rows' own placeholders and before the seek's.
	 */
	const paged = (source: PageSource<S>, slots: RequestSlots, limit: () => Expr): Select =>
		pagedRows(cx, {
			rel: source.rel(),
			heading: source.heading,
			origin: { kind: "node", node: source.origin.id },
			anchor: slots.anchor,
			direction,
			order: (map) =>
				kit.order(shape.order, source.heading, map, source.orderOrigin, source.orderHeading),
			limit: limit()
		})
	return kit.program(() => {
		const slots = kit.slots(() => slotsOf(kit.delivery.params))
		/**
		 * The rows the window delivers of a source, a heading group's rows cut by the merge (rows.ts retainedGroupRows),
		 * which its attachments read.
		 */
		const retained = (source: PageSource<S>): Select => {
			const at = `node ${source.origin.id} (page ${variant} attachment)`
			const own = slots()
			const size = (): Expr => own.sizes.size()
			if (sources.length === 1) {
				return paged(source, own, size)
			}
			return retainedGroupRows(cx, {
				groups: mapNonEmpty(sources, (g) => ({
					rows: () => paged(g, own, size),
					heading: g.heading
				})),
				own: { rows: () => paged(source, own, size), heading: source.heading },
				origin: { kind: "node", node: source.origin.id },
				comparators,
				direction,
				size: size(),
				at
			})
		}
		return mapNonEmpty(sources, (source) => {
			const statement = kit.part(
				() => {
					const own = slots()
					return paged(source, own, () => own.sizes.size())
				},
				source.heading,
				source.role
			)
			const attachments = source.attachments(
				kit.retained(() => retained(source), source.heading, source.origin)
			)
			return { statement, attachments }
		})
	})
}

/**
 * How a window variant delivers its rows: its one rows part's, or a heterogeneous union's heading groups', which the
 * runtime merges in the fetch order.
 */
const requestDelivery = (shape: PageShape, variant: PageVariant): PageRequestDelivery => {
	if (shape.kind !== "groups") {
		return { kind: "rows" }
	}
	return {
		kind: "headingGroups",
		discriminant: shape.plan.union.discriminant,
		order:
			variantDirection(variant) === "backward" ? reversedCompletedOrder(shape.order) : shape.order
	}
}

/**
 * The kits of one artifact, each call a fresh one: a plain window's, whose statement holds its size fill alone, and an
 * anchored window's, which holds boundaries too.
 */
interface ArtifactKits<SP, SA> {
	readonly plain: () => Kit<SizeFill, SP, PageProgram<SizeFill>>
	readonly anchored: () => Kit<PageFill, SA, PageProgram>
}

/**
 * Every window variant of a page's artifact over the ordered result `root`, each lowered with a fresh kit of `kits`, in
 * the page's order.
 */
const artifactOf = <SP, SA>(
	kits: ArtifactKits<SP, SA>,
	root: NodeOf<"OrderedResult">,
	order: CompletedOrder,
	comparators: ReadonlyArray<PageComparator>
): PageArtifact => {
	const shapeIn = <F extends PageFill, S>(kit: Kit<F, S, PageProgram<F>>): PageShape => ({
		...pageShapeOf(kit.delivery, root),
		order
	})
	const plainOf = <V extends PlainVariant>(variant: V): PageRequestProgram<V> => {
		const kit = kits.plain()
		const shape = shapeIn(kit)
		return {
			variant,
			direction: variantDirection(variant),
			delivery: requestDelivery(shape, variant),
			program: requestProgram(kit, shape, comparators, variant, plainSlots)
		}
	}
	const anchoredOf = <V extends AnchoredVariant>(variant: V): PageRequestProgram<V> => {
		const kit = kits.anchored()
		const shape = shapeIn(kit)
		return {
			variant,
			direction: variantDirection(variant),
			delivery: requestDelivery(shape, variant),
			program: requestProgram(kit, shape, comparators, variant, (params) =>
				anchoredSlots(params, (t) => kit.cx.baseTypeRef(t), comparators, anchoredSeek(variant))
			)
		}
	}
	/** The variants, lowered in the order of pageVariants, each with a fresh kit. */
	const requests: PageArtifact["requests"] = {
		first: plainOf("first"),
		after: anchoredOf("after"),
		last: plainOf("last"),
		before: anchoredOf("before")
	}
	return { requests }
}

/**
 * The page oracle's baseline artifact over the checked query's ordered result `root`, in `order` and `comparators`:
 * every window variant lowered by the conservative kit (conservativeKit), which no page compiles
 * (test/support/conservative.ts conservativePage).
 */
export const conservativePageArtifact = (
	input: PageCompileInput,
	root: NodeOf<"OrderedResult">,
	order: CompletedOrder,
	comparators: ReadonlyArray<PageComparator>
): PageArtifact =>
	artifactOf(
		{
			plain: () => conservativeKit<SizeFill>(input),
			anchored: () => conservativeKit<PageFill>(input)
		},
		root,
		order,
		comparators
	)

/**
 * The user's stated order of an ordered query's Description: the fields and directions of its outermost orderBy, in
 * their sequence, located at the orderBy stage's own location. A query whose last stage is not an orderBy is no
 * Ordered, and a page refuses it, located at `root`, the location the Description is checked at.
 */
export const statedOrderOf = (
	desc: QueryDesc,
	root: SourceLoc
): Result.Result<StatedOrder, CompileError> =>
	desc.stage.kind === "order"
		? Result.ok({
				keys: desc.stage.order.map((o) => ({ column: o.column, dir: o.dir })),
				at: childLoc(desc.stage.loc, "order")
			})
		: Result.err(
				malformedDescription(
					root,
					"an Ordered query for a page: page reads the completed order of an orderBy"
				)
			)

/**
 * The order a page compares by: the user's stated keys completed into a total order of the delivered relation `origin`
 * by the order completion policy (logical/order.ts completeOrder), under `evidence` (the schema's query evidence) in
 * the transaction context: evidence that holds in every execution context and at every statement, immediate keys and
 * query-local facts, so one row's key anchors a window of the template in either context. The stated fields keep their sequence and
 * directions; if they are not total, a heterogeneous union's discriminant follows them, ascending, then the narrowest
 * proved retained key's other fields, ascending, or without one the rest of the heading. For the paging example's
 * orderedTasks that is priority DESC, id ASC. A relation of at most one tuple compares by the empty tuple. A union
 * whose common fields hold no proved key is refused with UnsupportedOperation.
 *
 * Keys resting on evidence a transaction-context read may not use prove no tie broken. A refusal names the caller's
 * orderBy, never the node the order completes over.
 */
const pageOrderOf = (
	query: LogicalQuery,
	origin: RelNode,
	stated: StatedOrder,
	evidence: LogicalEnv
): Result.Result<CompletedOrder, CompileError> => {
	const analysis = analyzeLogical(query.dag, { ...evidence, context: "transaction" })
	if (!analysis.ok) {
		return Result.err(analysis.error)
	}
	const analyzed = analysis.value.of(origin)
	const subject = orderSubjectOf(analyzed.node, analyzed.props, [], (k) =>
		contextAdmits("transaction", k.context)
	)
	return Result.mapError(completeOrder(subject, stated.keys), (e) => reportedAt(e, stated.at))
}

/**
 * The page order of a heterogeneous union: its completion, which a group merge reads the discriminant from
 * (union/index.ts mergeOrderProblem). When the stated keys alone are total the completion stops there (step 1) and holds no discriminant; appended after them it breaks no tie, so the order is the same total order.
 */
const unionPageOrder = (
	order: CompletedOrder,
	discriminant: ReadonlyArray<string>
): CompletedOrder => {
	const missing = discriminant.filter((d) => !order.keys.some((k) => k.column === d))
	return missing.length === 0
		? order
		: { keys: [...order.keys, ...missing.map((column) => ({ column, dir: "asc" as const }))] }
}

/**
 * The page template of a compiled ordered query: every window variant of its optimized artifact.
 *
 * The page compiler.
 *
 * A compiled ordered query becomes the statements of every window, one per anchor kind:
 *
 * - four window variants, first (from the start), after (a key), last (from the end) and before (a key), each one
 *   statement of its own parts with no nullable boundary slot. A variant's rows part is take(k) of the distinct result D
 *   in its fetch order after its seek (rows.ts): the declared order for first and after, every direction reversed for
 *   last and before, whose rows the runtime reverses back to the presentation order. The limit is a placeholder the
 *   runtime fills with the window's size (seek.ts SizeSlots), and an anchored variant's boundary values are placeholders
 *   it fills from the anchor's key, one per comparator, each written by its comparator's codec (seek.ts
 *   BoundarySlots); a plain variant's statement holds no boundary placeholder, by its type (seek.ts VariantFill).
 *   Whether rows lie beyond a window is no flag of it: the adjacent window, anchored at its first or last row's key,
 *   answers them, so no statement fetches past the size and no second statement asks;
 * - a heterogeneous union delivered per heading group (R21) pages each group: every group part takes k in the common
 *   fetch order after the same seek on the common comparators, the discriminant among them, and the runtime merges the
 *   groups on that order and keeps k (union/index.ts mergeHeadingGroups), because the first n of the union lie among
 *   the first n of each group. A bounded union (a take under the order) is refused: its members depend on the merge
 *   across groups, which no group part sees;
 * - attachments are evaluated over the delivered window only: each is a part of the window's statement over the
 *   delivered rows, which the statement holds once (OptimizedDelivery heldRows), a heading group's rows cut by the
 *   merge (rows.ts retainedGroupRows), so the parent's plan is the plan the window would have alone. A window never
 *   fuses an attachment into its rows part (R36).
 *
 * The optimized artifact lowers the rewritten query under its duplicate-elimination placement and CTE plan through the
 * shape dispatch (../index.ts); the page oracle's conservative one (test/support/conservative.ts conservativePage)
 * lowers the checked query through the baseline plug-ins, which deduplicate at every set boundary. Both deliver D as a
 * set before the bound: the optimized rows are deduplicated unless the facts prove them unique, so a retained-key
 * window is a plain SELECT with no Unique node, and no hidden key manufactures distinct answers (R17).
 *
 * The comparators are the page order's keys over the delivered heading: the user's stated order completed by the order
 * completion policy under evidence valid in every execution context (pageOrderOf), the same in both artifacts, so one
 * row's key anchors either. A shape choice per execution (R20), such as an attached take over the delivered window,
 * chosen by the window's size, yields each statement's other form as a variant, as the template does.
 *
 * Keyset windows in the optimized lowering.
 *
 * seek.ts: the window variants, the comparators, the strict seek predicate (native row comparison for one direction,
 * the lexicographic OR expansion for mixed directions) and the page placeholders. rows.ts: the paged statement shape.
 * compile.ts: the page compiler, which turns a compiled ordered query into the statements of every window variant; it
 * reads the shape dispatch (../index.ts), so it is imported from its own path rather than re-exported here.
 *
 * A page is no node of the IR: it is compiled from the ordered query's template by compile.ts, which lowers the paged
 * statements directly.
 */
export const compilePage = (input: PageCompileInput): Result.Result<PageTemplate, CompileError> =>
	catchRefusal(() => {
		const at = "page compiler"
		const checkedRoot = input.checked.dag.roots[0]
		const optimizedRoot = input.optimized.query.dag.roots[0]
		if (checkedRoot.kind !== "OrderedResult" || optimizedRoot.kind !== "OrderedResult") {
			return refuse(
				"MalformedDescription",
				at,
				"a page over an Ordered query, its root an ordered result"
			)
		}
		/** Exact page membership never rests on approximate retrieval. */
		const misuse = approximatePageMisuse(checkedRoot)
		if (misuse !== undefined) {
			refuse("UnsupportedOperation", at, misuse.capability)
		}
		/**
		 * The page records no shape certificate, and can rely on no premise its cache entry lacks: a shape's certificate
		 * names only the node it shaped, in a query-local context, so it carries no constraint premise and no context
		 * requirement a cache entry keys on. Every fact the page's shapes read is its query template's (the same
		 * placement analysis), whose certificates record the premises it rests on, and the page template lives exactly
		 * as long as that query template (adapter/page/template.ts).
		 */
		const facts = shapeFactsFromPlan(input.optimized.plan, {
			derivedDefinition: false,
			certify: discardCertificates
		})
		const conservativeShape = pageShapeOf(conservativeKit<PageFill>(input).delivery, checkedRoot)
		/** The checker's completion begins with the stated keys (check/checker.ts complete). */
		const statedPrefix = conservativeShape.order.keys.slice(0, input.stated.keys.length)
		if (
			!canonicalEquals(
				statedPrefix,
				input.stated.keys.map((k) => ({ column: k.column, dir: k.dir })),
				everyProperty
			)
		) {
			return refuse(
				"MalformedDescription",
				at,
				"a page template whose stated order begins its query's completed order"
			)
		}
		const completed =
			conservativeShape.kind === "rows"
				? pageOrderOf(input.checked, conservativeShape.rows, input.stated, queryEvidence)
				: Result.map(
						pageOrderOf(input.checked, conservativeShape.plan.union, input.stated, queryEvidence),
						(o) => unionPageOrder(o, conservativeShape.plan.union.discriminant)
					)
		if (!completed.ok) {
			throw new Refusal(completed.error)
		}
		const order = completed.value
		const comparators = pageComparators(order, conservativeShape.heading)
		return {
			order,
			comparators,
			heading: conservativeShape.heading,
			artifact: artifactOf(
				{
					plain: () => optimizedKit<SizeFill>(input, facts),
					anchored: () => optimizedKit<PageFill>(input, facts)
				},
				optimizedRoot,
				order,
				comparators
			)
		}
	})

/**
 * The page template of a query template's programs (program/compile.ts QueryTemplate.programs), with the stated order
 * of the template's Description (statedOrderOf).
 */
export const compilePageOf = (
	programs: { readonly checked: LogicalQuery; readonly optimized: PageCompileInput["optimized"] },
	options: Omit<PageCompileInput, "checked" | "optimized">
): Result.Result<PageTemplate, CompileError> =>
	compilePage({ checked: programs.checked, optimized: programs.optimized, ...options })
