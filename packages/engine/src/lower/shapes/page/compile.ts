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
	HeadingColumn,
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
	Delivery,
	type Place,
	positions,
	statementRows
} from "#compiler/lower/conservative/deliver.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { completedOrderItems } from "#compiler/lower/conservative/take/order.ts"
import {
	type AttachedTree,
	type ConservativeOptions,
	type ConservativeStatement,
	mapTree,
	type PageParamSlot,
	type PageStatementSlot,
	type RowsRole,
	type StatementPlacement,
	type StatementRoots
} from "#compiler/lower/conservative/types.ts"
import { armCore, setOperation } from "#compiler/lower/conservative/union/arms.ts"
import type { CtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import type { DedupPlan } from "#compiler/lower/optimize/dedup/plan.ts"
import type { DeliveredRows, RowsIdentity } from "#compiler/lower/shapes/attach/index.ts"
import {
	asDelivered,
	type DeliveredStatement,
	type FusedStatement,
	OptimizedDelivery,
	type OptimizedStatement,
	optimizedDispatch,
	type ShapeChoice,
	ShapeState,
	sentAt,
	withArrival,
	withBoundary,
	withoutBoundary
} from "#compiler/lower/shapes/index.ts"
import { pagedRows, probeTest, retainedGroupRows } from "#compiler/lower/shapes/page/rows.ts"
import {
	type AnchoredVariant,
	anchoredSeek,
	anchoredSlots,
	type PageComparator,
	type PageDirection,
	type PageVariant,
	type PlainVariant,
	type ProbeKind,
	pageComparators,
	plainSlots,
	probeSeek,
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
import { orderIsTotal, orderItemsOf } from "#compiler/lower/shapes/take/order.ts"
import { assertMergeOrder, groupRows } from "#compiler/lower/shapes/union/index.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import type { Expr, OperandSelect, OrderItem, Select } from "#compiler/sql/ast.ts"
import { and, keyedSet, or, provedCore, select, target } from "#compiler/sql/build.ts"

/**
 * A page's statement, each with its forms: a page's attachments choose by a relation parameter or by the requested
 * size (deliveredRowsOf). Its page placeholders are each filled by one of `F`.
 */
export type PageStatement<F extends PageFill = PageFill> = OptimizedStatement<
	ShapeChoice,
	FusedStatement<PageStatementSlot<F>>,
	PageStatementSlot<F>
>

/** A page's statement as one delivery of the page lowered it, its page placeholders each filled by one of `F`. */
type PageDelivered<F extends PageFill> = DeliveredStatement<ShapeChoice, PageStatementSlot<F>>

/** One program of a page: its statements, whose page placeholders are each filled by one of `F`. */
export interface PageProgram<F extends PageFill = PageFill> {
	readonly roots: StatementRoots<PageStatement<F>>
}

/** How a request variant fetches and the flag its lookahead row proves. */
interface FetchFlags {
	readonly direction: PageDirection
	readonly lookahead: "hasNextPage" | "hasPreviousPage"
}

/** An anchored request's flags, and the probe of the opposite flag on its anchor (seek.ts probeKinds). */
interface AnchoredFlags extends FetchFlags {
	readonly probe: ProbeKind
}

/**
 * How each request variant fetches and establishes its flags. first and last have no probe: nothing precedes the first
 * tuple of D or follows its last.
 */
const requestFlags = {
	first: { direction: "forward", lookahead: "hasNextPage" },
	after: { direction: "forward", lookahead: "hasNextPage", probe: "atOrBefore" },
	last: { direction: "backward", lookahead: "hasPreviousPage" },
	before: { direction: "backward", lookahead: "hasPreviousPage", probe: "atOrAfter" }
} as const satisfies {
	readonly first: FetchFlags
	readonly after: AnchoredFlags
	readonly last: FetchFlags
	readonly before: AnchoredFlags
}
type PageRequestFlags = typeof requestFlags

/**
 * One request variant: the rows statements (one, or one per heading group) with their attachments after each, and
 * for a heterogeneous union the merge of its heading-group statements: each group's rows in `order`, the fetch order,
 * which the runtime merges and keeps the limit of.
 * A mapped type indexed by its own keys, so a union of variants is the union of their programs, and the program of a
 * generic variant is the one an implementation over that variant builds.
 */
export type PageRequestProgram<V extends PageVariant = PageVariant> = {
	readonly [P in V]: PageProgram<VariantFill[P]> &
		PageRequestFlags[P] & {
			readonly variant: P
			readonly delivery: PageRequestDelivery
		}
}[V]

/**
 * How the runtime delivers a request's rows: its one rows statement's, or a heterogeneous union's heading-group
 * statements, which it merges in `order`, the fetch order.
 */
type PageRequestDelivery =
	| { readonly kind: "rows" }
	| {
			readonly kind: "headingGroups"
			readonly discriminant: ReadonlyArray<string>
			readonly order: CompletedOrder
	  }

/** One probe: its one statement, delivering one row of its one Boolean column, `probeColumn`. */
export interface PageProbeProgram<K extends ProbeKind = ProbeKind> {
	readonly kind: K
	readonly statement: PageStatement
	readonly column: HeadingColumn
}

export interface PageArtifact {
	readonly requests: { readonly [V in PageVariant]: PageRequestProgram<V> }
	readonly probes: { readonly [K in ProbeKind]: PageProbeProgram<K> }
}

export interface PageTemplate {
	/**
	 * The presentation order: the user's stated order completed into a total order of the result by the order
	 * completion policy (pageOrderOf).
	 */
	readonly order: CompletedOrder
	/** The cursor's comparison tuple, read from each delivered edge by field name. */
	readonly comparators: ReadonlyArray<PageComparator>
	/**
	 * The delivered heading: the rows' heading, or a heterogeneous union's common heading, which every group carries.
	 * A heterogeneous union's requests deliver per heading group, each request's delivery naming the discriminant.
	 */
	readonly heading: Heading
	readonly optimized: PageArtifact
	readonly conservative: PageArtifact
}

interface PageCompileInput {
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

/** The column a probe statement delivers. */
const probeColumn = "__exists"

const probeBoolean: HeadingColumn = { name: probeColumn, type: plainType("bool") }

const probeHeading: Heading = [probeBoolean]

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
 * `F`, and the artifact's own forms of D's rows, a heading group's rows, the delivery order, a probe's input and the
 * pipelined attachments.
 */
interface Kit<F extends PageFill> {
	readonly cx: LowerContext
	readonly delivery: Delivery<PageParamSlot<F>>
	/**
	 * The statement delivering the query `lower` lowers in a statement of its own, of heading `rows`, built at the
	 * position it is placed at, as the runtime reads it.
	 */
	readonly statement: (
		lower: () => Select,
		rows: Heading,
		placement: StatementPlacement
	) => (position: number) => PageDelivered<F>
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
	readonly probeRel: (rel: OperandSelect) => OperandSelect
	readonly attach: (
		place: Place,
		rows: DeliveredRows<PageInput>,
		spine: ReadonlyArray<RelNode>,
		attachments: ReadonlyArray<NodeOf<"Attach">>
	) => ReadonlyArray<AttachedTree<PageDelivered<F>>>
}

/** A conservative attachment statement and those under it as a page's delivery places them (asDelivered). */
const deliveredTree = <F extends PageFill>(
	tree: AttachedTree<ConservativeStatement<PageStatementSlot<F>>>
): AttachedTree<PageDelivered<F>> => ({
	statement: asDelivered(tree.statement),
	attach: tree.attach,
	attachments: tree.attachments.map(deliveredTree)
})

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

const conservativeKit = <F extends PageFill>(input: PageCompileInput): Kit<F> => {
	const options: ConservativeOptions = {
		names: input.names,
		params: input.checked.params,
		subject: { kind: "query" }
	}
	const cx = new LowerContext(input.checked.dag, options, dispatchNode)
	const delivery = new Delivery<PageParamSlot<F>>(cx)
	return {
		cx,
		delivery,
		statement: (lower, rows, placement) => () => {
			delivery.beginStatement()
			return asDelivered(delivery.statement(lower(), rows, placement))
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
		probeRel: (rel) => rel,
		attach: (_place, rows, spine, attachments) =>
			delivery.attachments({ nodes: spine, attachments }, rows).map(deliveredTree)
	}
}

const optimizedKit = <F extends PageFill>(input: PageCompileInput, facts: ShapeFacts): Kit<F> => {
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
		statement: (lower, rows, placement) => () => delivery.formed(lower, rows, placement, []),
		/**
		 * The page's rows are lowered outside any attachment's context, in their own statement and in an attachment's
		 * computing them again alike.
		 */
		rows: (node) => {
			const lowered = cx.lower(node, emptyEnv)
			return facts.unique(node) ? lowered : withBoundary(cx, node, lowered)
		},
		group: (plan, g) =>
			filtered(cx, plan, groupRows(cx, plan.union, g, emptyEnv, facts), g.heading, false),
		order: (order, heading, map, origin, originHeading) =>
			orderItemsOf(order, heading, map, {
				leading: [],
				total: orderIsTotal(facts, origin, order, originHeading),
				fixed: []
			}),
		probeRel: (rel) => withoutBoundary(rel, "operand"),
		attach: (place, rows, spine, attachments) =>
			attachments.map((attach) => delivery.pipelined(place, attach, spine, rows))
	}
}

/**
 * The page shape of an artifact's DAG: its root an ordered result over D, or over a heterogeneous union delivered per
 * heading group.
 */
const shapeOf = <F extends PageFill>(
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

/** One delivered relation of a page: its rows, heading, statement and attachments. */
interface PageSource<F extends PageFill> {
	readonly rel: () => OperandSelect
	readonly heading: Heading
	/** The node whose rows these are, for names and facts. */
	readonly origin: RelNode
	/** The node and heading the order's totality is proved on. */
	readonly orderOrigin: RelNode
	readonly orderHeading: Heading
	readonly role: RowsRole
	/** What identifies a delivered row: a row of `origin`, or nothing the facts know for a heading group. */
	readonly identity: RowsIdentity
	/** Places the statements of its attachments, over its placed statement's rows. */
	readonly attachments: (
		place: Place,
		rows: DeliveredRows<PageInput>
	) => ReadonlyArray<AttachedTree<PageDelivered<F>>>
}

const sourcesOf = <F extends PageFill>(
	kit: Kit<F>,
	shape: PageShape
): NonEmptyReadonlyArray<PageSource<F>> => {
	if (shape.kind === "rows") {
		return [
			{
				rel: () => kit.rows(shape.rows),
				heading: shape.heading,
				origin: shape.rows,
				orderOrigin: shape.rows,
				orderHeading: shape.heading,
				role: { kind: "main" },
				identity: { kind: "node", node: shape.rows },
				attachments: (place, rows) =>
					kit.attach(place, rows, shape.spine.nodes, shape.spine.attachments)
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
		identity: { kind: "unkeyed" },
		attachments: (place: Place, rows: DeliveredRows<PageInput>) => {
			const above = kit.attach(place, rows, scope, plan.attachments)
			const [only, ...others] = g.arms
			if (others.length === 0) {
				const armSpine = kit.delivery.spine(only)
				return [...above, ...kit.attach(place, rows, armSpine.nodes, armSpine.attachments)]
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
 * The delivered rows of a page's rows statement, which its attachments' statements compute again by `retained`: at
 * most the requested size of them.
 */
const deliveredRowsOf = (
	heading: Heading,
	identity: RowsIdentity,
	retained: () => Select
): DeliveredRows<PageInput> => ({
	...statementRows(heading, retained),
	identity,
	bound: { kind: "input", source: { kind: "pageSize" }, factor: 1n },
	searches: false
})

/**
 * One request variant's statements, each statement's page placeholders those `slotsOf` allocates into its parameter
 * list: a plain request's sizes, an anchored one's sizes and boundaries.
 */
const requestStatements = <F extends PageFill>(
	kit: Kit<F>,
	shape: PageShape,
	comparators: ReadonlyArray<PageComparator>,
	variant: PageVariant,
	slotsOf: (params: StatementParams<PageParamSlot<F>>) => RequestSlots
): StatementRoots<PageDelivered<F>> => {
	const cx = kit.cx
	const direction = variantDirection(variant)
	const sources = sourcesOf(kit, shape)
	/**
	 * One source's rows after its anchor's seek, in the fetch order, bounded by `limit`, which is allocated after the
	 * rows' own placeholders and before the seek's.
	 */
	const paged = (source: PageSource<F>, slots: RequestSlots, limit: () => Expr): Select =>
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
	/**
	 * The rows the page delivers of source `si`, computed again in the statement being lowered, an attachment's, which
	 * is the next one pushed and takes the page placeholders allocated here.
	 */
	const retained = (source: PageSource<F>): Select => {
		const at = `node ${source.origin.id} (page ${variant} attachment)`
		const slots = slotsOf(kit.delivery.params)
		const size = (): Expr => slots.sizes.size()
		if (sources.length === 1) {
			return paged(source, slots, size)
		}
		return retainedGroupRows(cx, {
			groups: mapNonEmpty(sources, (g) => ({
				rows: () => paged(g, slots, size),
				heading: g.heading
			})),
			own: { rows: () => paged(source, slots, size), heading: source.heading },
			origin: { kind: "node", node: source.origin.id },
			comparators,
			direction,
			size: size(),
			at
		})
	}
	const place = positions()
	return mapNonEmpty(sources, (source) => {
		const query = (): Select => {
			const slots = slotsOf(kit.delivery.params)
			return paged(source, slots, () => slots.sizes.limit())
		}
		const statement = place(
			kit.statement(query, source.heading, { role: source.role, dependsOn: [] })
		)
		const attachments = source.attachments(
			place,
			deliveredRowsOf(source.heading, source.identity, () => retained(source))
		)
		return { statement, attachments }
	})
}

/** One probe's statement: SELECT EXISTS (D_1 after the seek) OR ... OR EXISTS (D_n after the seek). */
const probeStatement = (
	kit: Kit<PageFill>,
	shape: PageShape,
	comparators: ReadonlyArray<PageComparator>,
	kind: ProbeKind
): PageDelivered<PageFill> => {
	const cx = kit.cx
	const sources = sourcesOf(kit, shape)
	const query = (): Select => {
		const { anchor } = anchoredSlots(
			kit.delivery.params,
			(t) => cx.baseTypeRef(t),
			comparators,
			probeSeek(kind)
		)
		const tests = mapNonEmpty(sources, (source) =>
			probeTest(cx, {
				rel: kit.probeRel(source.rel()),
				heading: source.heading,
				origin: { kind: "node", node: source.origin.id },
				anchor
			})
		)
		return select(provedCore("oneRow", [target(or(tests))], [], undefined))
	}
	return kit.statement(query, probeHeading, {
		role: { kind: "main" },
		dependsOn: []
	})(0)
}

interface ArtifactStatements {
	readonly requests: { readonly [V in PageVariant]: StatementRoots<PageDelivered<VariantFill[V]>> }
	readonly probes: Readonly<Record<ProbeKind, PageDelivered<PageFill>>>
}

/**
 * Every program of one artifact in one mode, each lowered with a fresh kit, in the page's order: a plain request's
 * statements hold size fills alone, an anchored request's and a probe's boundaries too.
 */
const artifactStatements = (
	kitFor: <F extends PageFill>() => Kit<F>,
	root: NodeOf<"OrderedResult">,
	order: CompletedOrder,
	comparators: ReadonlyArray<PageComparator>
): ArtifactStatements => {
	const shapeIn = <F extends PageFill>(kit: Kit<F>): PageShape => ({
		...shapeOf(kit.delivery, root),
		order
	})
	const plainOf = (variant: PlainVariant): StatementRoots<PageDelivered<SizeFill>> => {
		const kit = kitFor<SizeFill>()
		return requestStatements(kit, shapeIn(kit), comparators, variant, plainSlots)
	}
	const anchoredOf = (variant: AnchoredVariant): StatementRoots<PageDelivered<PageFill>> => {
		const kit = kitFor<PageFill>()
		return requestStatements(kit, shapeIn(kit), comparators, variant, (params) =>
			anchoredSlots(params, (t) => kit.cx.baseTypeRef(t), comparators, anchoredSeek(variant))
		)
	}
	const probeOf = (kind: ProbeKind): PageDelivered<PageFill> => {
		const kit = kitFor<PageFill>()
		return probeStatement(kit, shapeIn(kit), comparators, kind)
	}
	/** Lowered in the order of pageVariants and probeKinds, each with a fresh kit. */
	const requests: ArtifactStatements["requests"] = {
		first: plainOf("first"),
		after: anchoredOf("after"),
		last: plainOf("last"),
		before: anchoredOf("before")
	}
	const probes: Record<ProbeKind, PageDelivered<PageFill>> = {
		atOrBefore: probeOf("atOrBefore"),
		atOrAfter: probeOf("atOrAfter")
	}
	return { requests, probes }
}

/** The statement at position `i` of one program, which the runtime sends whole. */
const pageForm = <F extends PageFill>(s: PageDelivered<F>, i: number): PageStatement<F> =>
	withArrival(s, sentAt(i))

/** Each statement of one program (pageForm). */
const pageForms = <F extends PageFill>(
	roots: StatementRoots<PageDelivered<F>>
): StatementRoots<PageStatement<F>> => mapTree(roots, pageForm)

const assemble = (statements: ArtifactStatements, shape: PageShape): PageArtifact => {
	const request = <V extends PageVariant>(variant: V): PageRequestProgram<V> => {
		const flags: PageRequestFlags[V] = requestFlags[variant]
		const delivery: PageRequestDelivery =
			shape.kind === "groups"
				? {
						kind: "headingGroups",
						discriminant: shape.plan.union.discriminant,
						order:
							flags.direction === "backward" ? reversedCompletedOrder(shape.order) : shape.order
					}
				: { kind: "rows" }
		const program: PageProgram<VariantFill[V]> & {
			readonly variant: V
			readonly delivery: PageRequestDelivery
		} = {
			variant,
			roots: pageForms(statements.requests[variant]),
			delivery
		}
		return { ...program, ...flags }
	}
	const requests: PageArtifact["requests"] = {
		first: request("first"),
		after: request("after"),
		last: request("last"),
		before: request("before")
	}
	const probe = <K extends ProbeKind>(kind: K): PageProbeProgram<K> => ({
		kind,
		statement: pageForm(statements.probes[kind], 0),
		column: probeBoolean
	})
	const probes: PageArtifact["probes"] = {
		atOrBefore: probe("atOrBefore"),
		atOrAfter: probe("atOrAfter")
	}
	return { requests, probes }
}

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
 * query-local facts, so one cursor serves a template in either context. The stated fields keep their sequence and
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
 * The page template of a compiled ordered query: every request variant and probe of both artifacts.
 *
 * The page compiler.
 *
 * A compiled ordered query becomes the statements of every page request, for both artifacts of its template
 * ("Two artifacts per template"):
 *
 * - four request variants, { first }, { first, after }, { last } and { last, before }, each its own statements with no
 *   nullable cursor slot. A variant's rows statement is take(k + 1) of the distinct result D
 *   in its fetch order after its seek (rows.ts): the declared order for first and after, every direction reversed for
 *   last and before, whose retained rows the runtime reverses back to the presentation order. The limit
 *   is a placeholder the runtime fills with the validated size plus one (seek.ts SizeSlots), and an anchored variant's
 *   boundary values are placeholders it fills from the decoded cursor, one per comparator (seek.ts BoundarySlots); a
 *   plain variant's statements hold no boundary placeholder, by their type (seek.ts VariantFill);
 * - two probes, each one statement of one Boolean column: whether D holds a tuple at or before, or at or after, a
 *   boundary. The lookahead proves the flag in the fetching direction; a probe proves the opposite one from the
 *   request's anchor, which decides it for an empty page and a nonempty one alike (seek.ts probeKinds), so the probe
 *   goes in the rows' flight. A first or last request needs no probe: nothing precedes the first tuple of D or follows
 *   its last. Rows and probe run in one snapshot, which the runtime provides;
 * - a heterogeneous union delivered per heading group (R21) pages each group: every group
 *   statement takes k + 1 in the common fetch order after the same seek on the common comparators, the discriminant
 *   among them, and the runtime merges the groups on that order and keeps k + 1 (union/index.ts mergeHeadingGroups),
 *   because the first n of the union lie among the first n of each group. A probe tests every group in one statement,
 *   EXISTS per group joined by OR. A bounded union (a take under the order) is refused: its members depend on the merge
 *   across groups, which no group statement sees;
 * - attachments are evaluated over the delivered page only: each is a pipelined statement in the rows statement's
 *   flight, which computes the delivered page again, the lookahead row dropped and a heading group's rows cut by the
 *   merge (rows.ts retainedGroupRows), so the parent's plan is the plan the page would have alone. A page never fuses
 *   an attachment into its rows statement (R36), whose array would be evaluated for the lookahead row as well.
 *
 * The optimized artifact lowers the rewritten query under its duplicate-elimination placement and CTE plan through the
 * shape dispatch (../index.ts); the conservative one lowers the checked query through the baseline plug-ins, which
 * deduplicate at every set boundary. Both deliver D as a set before the bound: the optimized rows are
 * deduplicated unless the facts prove them unique, so a retained-key page is a plain SELECT with no Unique node, and
 * no hidden key manufactures distinct answers (R17). A probe reads D under EXISTS, which is
 * duplicate-insensitive, so the optimized probe drops D's outermost DISTINCT.
 *
 * The comparators are the page order's keys over the delivered heading: the user's stated order completed by the order
 * completion policy under evidence valid in every execution context (pageOrderOf), the same in both artifacts, so one
 * cursor serves either. A shape choice per execution (R20), such as an attached take over the delivered page, chosen
 * by the requested size, yields each statement's other form as a variant, as the template does.
 *
 * Keyset pages in the optimized lowering.
 *
 * seek.ts: the request variants, the comparators, the seek predicate (native row comparison for one direction, the
 * lexicographic OR expansion for mixed directions, strict and inclusive) and the page placeholders. rows.ts: the paged
 * statement shape and the EXISTS probe. compile.ts: the page compiler, which turns a compiled ordered query into the
 * statements of every request variant and every probe, for both artifacts; it reads the shape dispatch (../index.ts),
 * so it is imported from its own path rather than re-exported here.
 *
 * A page is no node of the IR: it is compiled from the ordered query's template by compile.ts, which lowers the paged
 * statements directly in both artifacts.
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
		const conservativeShape = shapeOf(conservativeKit<PageFill>(input).delivery, checkedRoot)
		const optimizedShape = shapeOf(optimizedKit<PageFill>(input, facts).delivery, optimizedRoot)
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
		const conservative = artifactStatements(
			<F extends PageFill>(): Kit<F> => conservativeKit<F>(input),
			checkedRoot,
			order,
			comparators
		)
		const optimized = artifactStatements(
			<F extends PageFill>(): Kit<F> => optimizedKit<F>(input, facts),
			optimizedRoot,
			order,
			comparators
		)
		return {
			order,
			comparators,
			heading: conservativeShape.heading,
			optimized: assemble(optimized, {
				...optimizedShape,
				heading: conservativeShape.heading,
				order
			}),
			conservative: assemble(conservative, { ...conservativeShape, order })
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
