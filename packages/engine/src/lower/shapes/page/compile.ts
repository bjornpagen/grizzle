import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	lastNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { approximatePageMisuse } from "#compiler/check/approximate/provenance.ts"
import { canonicalEquals, catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, reportedAt } from "#compiler/core/errors.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { contextAdmits } from "#compiler/ir/evidence.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { LogicalQuery, PageFill, SizeFill } from "#compiler/ir/products.ts"
import {
	type CompletedOrder,
	type GroupOrders,
	type Heading,
	type HeadingGroup,
	type NodeOf,
	type OrderKey,
	type RelNode,
	soleOrder
} from "#compiler/ir/rel.ts"
import {
	analyzeLogical,
	keptNodes,
	type LogicalEnv,
	orderSubjectOf,
	queryEvidence
} from "#compiler/logical/annotate.ts"
import { completeGroups } from "#compiler/logical/order.ts"
import {
	type ColumnMap,
	columnIn,
	distinctSelect,
	emptyEnv,
	type Env,
	envOf,
	carriesNothing,
	evaluatedAsItStands,
	headingTargets,
	LowerContext,
	nodeLabel,
	refuse,
	restrictedEnv,
	type StatementParams
} from "#compiler/lower/conservative/context.ts"

import {
	ConservativeDelivery,
	type Delivery,
	type ParentRows,
	statementRows
} from "#compiler/lower/conservative/deliver.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { noRowKeys } from "#compiler/lower/conservative/keys.ts"
import {
	completedOrderItems,
	orderItemsOf,
	sharedOrder
} from "#compiler/lower/conservative/take/order.ts"
import type {
	ConservativeOptions,
	ConservativeStatement,
	PageParamSlot,
	PageStatementSlot
} from "#compiler/lower/conservative/types.ts"
import { armCore, setOperation } from "#compiler/lower/conservative/union/arms.ts"
import type { CtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import type { DedupPlan } from "#compiler/lower/optimize/dedup/plan.ts"
import {
	type DeliveredPart,
	OptimizedDelivery,
	optimizedDispatch,
	type PartedStatement,
	partedConservative,
	ShapeState,
	withBoundary
} from "#compiler/lower/shapes/index.ts"
import {
	asItStands,
	type PageWindow,
	type WindowDriver
} from "#compiler/lower/shapes/page/driver.ts"
import {
	drivenRows,
	pagedRows,
	positionedGroupRows,
	retainedGroupRows
} from "#compiler/lower/shapes/page/rows.ts"
import {
	type AnchoredFill,
	type AnchoredVariant,
	anchoredSeek,
	anchoredSlots,
	edgeStart,
	type PageComparator,
	type PageDirection,
	type PageVariant,
	type PlainVariant,
	type PositionedFill,
	type PositionedVariant,
	pageComparators,
	plainSlots,
	positionedSlots,
	type RequestSlots,
	reversedCompletedOrder,
	reversedOrder,
	type VariantFill,
	variantDirection,
	type WindowStart
} from "#compiler/lower/shapes/page/seek.ts"

import { chainSelect } from "#compiler/lower/shapes/region/index.ts"
import { readPerDrivingRow } from "#compiler/lower/shapes/semi-join/index.ts"
import type { StatementKeys } from "#compiler/lower/shapes/share/keyed.ts"
import {
	discardCertificates,
	type ShapeFacts,
	shapeFactsFromPlan
} from "#compiler/lower/shapes/share/physical.ts"
import { orderIsTotal } from "#compiler/lower/shapes/take/order.ts"
import { groupRows } from "#compiler/lower/shapes/union/index.ts"
import type { AttachedTree, RowsRole, StatementRoots } from "#compiler/runtime/lower/tree.ts"
import { searchedOnly, storedOnly } from "#compiler/scalar/registry.ts"
import type {
	EmittedSql,
	Expr,
	FromItem,
	OperandSelect,
	OrderItem,
	Select
} from "#compiler/sql/ast.ts"
import { and, binary, conjunction, keyedSet, select, unitRow } from "#compiler/sql/build.ts"
import { type Emitting, sentText } from "#compiler/sql/emit.ts"

/**
 * A page's program in its optimized artifact: one statement of parts, its page placeholders each filled by one of `F`.
 */
export type PageProgram<F extends PageFill = PageFill> = PartedStatement<PageStatementSlot<F>>

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
	 * pages by the union's own order, every heading group's (pagedGroupsOrder).
	 */
	readonly stated: StatedOrder
	/**
	 * The template's optimized lowering: the rewritten query, its duplicate-elimination placement, its CTE plan and its
	 * key sets (lower/optimize/pipeline.ts OptimizedProgram).
	 */
	readonly optimized: {
		readonly query: LogicalQuery
		readonly plan: DedupPlan
		readonly cte: CtePlan
		readonly keys: StatementKeys
		readonly window: PageWindow
	}
	readonly names: PhysicalNames
	/** What its optimized statements are bound under (sql/emit.ts Emitting): its read's transaction's. */
	readonly binding: Emitting
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
	/**
	 * How the artifact's windows read the page's rows (driver.ts): the conservative artifact's as they stand, the
	 * optimized artifact's as its lowering decided, driven by the window's driver where one meets the rule.
	 */
	readonly window: PageWindow
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
	readonly retained: (retained: () => Select, heading: Heading, origin: RelNode) => Retained
	/** The parts of `attachments` over the page's rows `rows`. */
	readonly attach: (
		rows: ParentRows,
		spine: ReadonlyArray<RelNode>,
		attachments: ReadonlyArray<NodeOf<"Attach">>
	) => ReadonlyArray<AttachedTree<S>>
}

/**
 * A window's rows as its attachments read them (`rows`), and how its rows part reads them: the rows the statement holds
 * once for its attachments (`held`, the optimized artifact's), so no part computes the window twice, or computed again
 * in its own statement (`own`, the conservative artifact's, each part a statement of its own).
 */
interface Retained {
	readonly rows: ParentRows
	readonly part:
		| { readonly kind: "held"; readonly read: () => OperandSelect }
		| { readonly kind: "own" }
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
	const scope: Env = envOf([...plan.spineNodes, plan.union].map((n) => [n.id, input.map] as const))
	const where = and(mapNonEmpty(filters, (f) => lowerExpr(cx, f.pred, scope)))
	const targets = headingTargets(heading, input.map)
	return distinct
		? distinctSelect(targets, [input.item], [where])
		: select(keyedSet(targets, [input.item], where, "a page group's filtered rows"))
}

/**
 * The conservative artifact's kit, the page oracle's baseline: each part lowered as a statement of its own, which
 * computes the page's rows again for each attachment, and the program those statements' parts are of
 * (shapes/index.ts partedConservative).
 */
const conservativeKit = <F extends PageFill>(
	input: Pick<PageCompileInput, "checked" | "names">
): Kit<F, ConservativeStatement<PageStatementSlot<F>>, PageProgram<F>> => {
	const options: ConservativeOptions = {
		names: input.names,
		params: input.checked.params,
		subject: { kind: "query" }
	}
	const cx = new LowerContext(
		input.checked.dag,
		options,
		dispatchNode,
		evaluatedAsItStands,
		carriesNothing
	)
	const delivery = new ConservativeDelivery<PageParamSlot<F>>(cx)
	return {
		cx,
		delivery,
		window: asItStands,
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
			rows: statementRows(cx, heading, origin, retained, noRowKeys),
			part: { kind: "own" }
		}),
		attach: (rows, spine, attachments) => delivery.attachments({ nodes: spine, attachments }, rows)
	}
}

const optimizedKit = <F extends PageFill>(
	input: PageCompileInput,
	facts: ShapeFacts
): Kit<F, DeliveredPart, PageProgram<F>> => {
	const query = input.optimized.query
	const state = new ShapeState(input.optimized.cte, input.optimized.keys)
	const options: ConservativeOptions = {
		names: input.names,
		params: query.params,
		subject: { kind: "query" }
	}
	const dispatching = optimizedDispatch(facts, state)
	const cx = new LowerContext(
		query.dag,
		options,
		dispatching.dispatch,
		state.evaluationHolding,
		dispatching.carrying
	)
	const delivery = new OptimizedDelivery<PageParamSlot<F>, EmittedSql>(
		cx,
		facts,
		state,
		sentText(input.binding)
	)
	return {
		cx,
		delivery,
		window: input.optimized.window,
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
		retained: (retained, heading, origin) => {
			const held = delivery.heldRows(retained(), heading, origin)
			return { rows: held.rows, part: { kind: "held", read: held.read } }
		},
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
				return {
					kind: "groups",
					order: pagedGroupsOrder(plan.union, root.orders),
					heading: plan.union.heading,
					plan
				}
		}
	}
	const rows = root.input
	return {
		kind: "rows",
		order: soleOrder(root.orders),
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
	/** Whether attachments read its rows, which the statement then holds once (Retained). */
	readonly attached: boolean
	/** The parts of its attachments, over the page's rows they read. */
	readonly attachments: (rows: ParentRows) => ReadonlyArray<AttachedTree<S>>
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
				attached: shape.spine.attachments.length > 0,
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
		attached: true,
		attachments: (rows: ParentRows) => {
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
 * A window's rows part over the rows its statement holds for its attachments (Retained `held`): those rows in the fetch
 * order, which the runtime reverses for a backward window as it reverses any.
 */
const heldWindow = (
	cx: LowerContext,
	held: OperandSelect,
	source: { readonly heading: Heading; readonly origin: RelNode },
	order: (map: ColumnMap) => ReadonlyArray<OrderItem>,
	direction: PageDirection
): Select => {
	const rows = cx.wrap(held, source.heading, { kind: "node", node: source.origin.id })
	const declared = order(rows.map)
	return {
		...select(
			keyedSet(
				headingTargets(source.heading, rows.map),
				[rows.item],
				undefined,
				"a window's held rows"
			)
		),
		orderBy: direction === "backward" ? reversedOrder(declared) : declared
	}
}

/** The type of a column of a window driver's relation. */
const typeOfColumn = (driver: WindowDriver, column: string) =>
	defined(
		driver.base.heading.find((h) => h.name === column),
		"a window driver's column, its relation's"
	).type

/** The heading of a window driver's rows: its columns the take reads, by D's names, each its driver column's type. */
const driverHeading = (driver: WindowDriver): Heading =>
	driver.columns.map((c) => ({ name: c.heading, type: typeOfColumn(driver, c.column) }))

/**
 * One part of a driven window (driver.ts): its driver's relation read at one row of S, `values`, by the driver's
 * names: each point the call fixes, each column of c̄ at S's row, and each end of the interval, the filter's own
 * comparison read at the driver's column, so the part's rows are the filter's; its key's and order's columns named as
 * D's, which the part's take reads (rows.ts drivenRows).
 */
const driverRows = (cx: LowerContext, driver: WindowDriver, values: ColumnMap): Select => {
	const base = cx.wrap(cx.lower(driver.base, emptyEnv), driver.base.heading, {
		kind: "node",
		node: driver.base.id
	})
	const ends = [driver.interval.lower, driver.interval.upper].flatMap((end) =>
		end.kind === "open"
			? []
			: [
					lowerExpr(cx, end.comparison.expr, {
						...emptyEnv,
						columns: new Map([
							[
								end.comparison.node,
								new Map([[end.comparison.column, columnIn(base.map, end.column)]])
							]
						])
					})
				]
	)
	const where = conjunction([
		...driver.values.points.map((f) =>
			cx.equal(
				typeOfColumn(driver, f.column),
				columnIn(base.map, f.column),
				lowerExpr(cx, f.value, emptyEnv)
			)
		),
		...driver.values.read.map((r) =>
			cx.equal(
				typeOfColumn(driver, r.column),
				columnIn(base.map, r.column),
				columnIn(values, r.column)
			)
		),
		...ends
	])
	const named: ColumnMap = new Map(
		driver.columns.map((c) => [c.heading, columnIn(base.map, c.column)])
	)
	return select(
		keyedSet(headingTargets(driverHeading(driver), named), [base.item], where, "a window's driver")
	)
}

/**
 * S, the rows of a window driver's prefix the call reads (driver.ts DriverValues), as each part of the window reads
 * them (rows.ts drivenRows), its columns by the driver's names: the unit row where the call's points fix the whole
 * prefix; else P's chain from the call's values, DISTINCT over c̄, printed as every chain is (lower/shapes/region
 * chainSelect), the region held at the call's values of P's classes, its restriction (restrictedEnv), as a region read
 * at a restriction it holds is.
 */
const driverValues = (
	cx: LowerContext,
	driver: WindowDriver
): { readonly item: FromItem; readonly map: ColumnMap } => {
	const { region, steps, read } = driver.values
	const origin = { kind: "node", node: driver.base.id } as const
	if (!isNonEmpty(steps)) {
		return { item: unitRow(cx.relationAlias(origin)), map: new Map() }
	}
	const targets = defined(
		isNonEmpty(read) ? read : undefined,
		"a window's value set, a column of the driver its chain reads"
	)
	const env = restrictedEnv(
		emptyEnv,
		new Map([
			[
				region,
				driver.values.restriction.map((r) => ({
					column: r.column,
					value: lowerExpr(cx, r.value, emptyEnv)
				}))
			]
		])
	)
	const chain = defined(
		chainSelect(
			cx,
			env,
			region,
			steps,
			mapNonEmpty(targets, (r) => ({ name: r.column, var: r.var }))
		),
		"a window's value set, its chain's read"
	)
	return cx.wrap(
		chain,
		read.map((r) => ({ name: r.column, type: typeOfColumn(driver, r.column) })),
		origin
	)
}

/**
 * One window variant's program, its page placeholders those `slotsOf` allocates into its parameter list: a plain
 * window's size, an anchored one's size and boundaries, a positioned one's size and offset.
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
	 * One source's rows from `start` in the fetch order, bounded by `limit`, which is allocated after the rows' own
	 * placeholders and before the seek's or the offset's.
	 */
	const paged = (source: PageSource<S>, start: WindowStart, limit: () => Expr): Select => {
		const origin = { kind: "node", node: source.origin.id } as const
		const order = (map: ColumnMap, heading: Heading) =>
			kit.order(shape.order, heading, map, source.orderOrigin, source.orderHeading)
		const window = kit.window
		if (window.kind === "driven" && sources.length === 1) {
			const driver = window.driver
			return drivenRows(cx, {
				values: driverValues(cx, driver),
				driver: (values) => driverRows(cx, driver, values),
				driverHeading: driverHeading(driver),
				heading: source.heading,
				origin,
				start,
				direction,
				order,
				limit,
				rows: (keys) =>
					readPerDrivingRow(
						cx,
						emptyEnv,
						driver.rows,
						driver.key.map((column) => ({ column, value: columnIn(keys, column) })),
						{ kind: "node", node: driver.rows.id }
					)
			})
		}
		return pagedRows(cx, {
			rel: source.rel(),
			heading: source.heading,
			origin,
			start,
			direction,
			order: (map) => order(map, source.heading),
			limit: limit()
		})
	}
	return kit.program(() => {
		const slots = kit.slots(() => slotsOf(kit.delivery.params))
		/**
		 * The window's rows of a source, as its rows part delivers them (`delivered`) and as its attachments read them
		 * (`retained`). One source's are its rows from the window's start, at most its size of them, delivered and
		 * read alike. A heading group's, from an edge or a seek, are delivered as the group's first k, which the runtime
		 * merges and cuts, and read as those of them the merge keeps (rows.ts retainedGroupRows); from an offset, they
		 * are the group's rows of the window, delivered and read alike (rows.ts positionedGroupRows), each group's first
		 * o+k read from the order's first row.
		 */
		const windowRows = (source: PageSource<S>, read: "delivered" | "retained"): Select => {
			const own = slots()
			const size = (): Expr => own.size.value()
			if (sources.length === 1) {
				return paged(source, own.start, size)
			}
			const origin = { kind: "node", node: source.origin.id } as const
			const start = own.start
			switch (start.kind) {
				case "edge":
				case "seek":
					return read === "delivered"
						? paged(source, start, size)
						: retainedGroupRows(cx, {
								groups: mapNonEmpty(sources, (g) => ({
									rows: () => paged(g, start, size),
									heading: g.heading
								})),
								own: { rows: () => paged(source, start, size), heading: source.heading },
								origin,
								comparators,
								direction,
								size: size(),
								at: `node ${source.origin.id} (page ${variant} attachment)`
							})
				case "offset": {
					const reach = (): Expr => binary("+", start.offset.value(), size())
					return positionedGroupRows(cx, {
						groups: mapNonEmpty(sources, (g) => ({
							rows: () => paged(g, edgeStart, reach),
							heading: g.heading
						})),
						own: { rows: () => paged(source, edgeStart, reach), heading: source.heading },
						origin,
						comparators,
						size: size(),
						offset: start.offset.value()
					})
				}
			}
		}
		return mapNonEmpty(sources, (source) => {
			if (sources.length > 1 || !source.attached) {
				const statement = kit.part(
					() => windowRows(source, "delivered"),
					source.heading,
					source.role
				)
				/** A source no attachment reads holds no rows for one: its window is its rows part alone. */
				const attachments = source.attached
					? source.attachments(
							kit.retained(() => windowRows(source, "retained"), source.heading, source.origin).rows
						)
					: []
				return { statement, attachments }
			}
			/**
			 * One source's window, which its attachments read: held once by the statement, its rows part delivering the
			 * held rows in the fetch order, so the window is computed once (Retained).
			 */
			const retained = kit.retained(
				() => windowRows(source, "retained"),
				source.heading,
				source.origin
			)
			const part = retained.part
			const statement = kit.part(
				() =>
					part.kind === "held"
						? heldWindow(
								cx,
								part.read(),
								source,
								(map) =>
									kit.order(
										shape.order,
										source.heading,
										map,
										source.orderOrigin,
										source.orderHeading
									),
								direction
							)
						: windowRows(source, "delivered"),
				source.heading,
				source.role
			)
			return { statement, attachments: source.attachments(retained.rows) }
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
 * The kits of one artifact, each call a fresh one: a plain window's, whose statement holds its size fill alone, an
 * anchored window's, which holds boundaries too, and a positioned window's, which holds its offset too.
 */
interface ArtifactKits<SP, SA, SO> {
	readonly plain: () => Kit<SizeFill, SP, PageProgram<SizeFill>>
	readonly anchored: () => Kit<AnchoredFill, SA, PageProgram<AnchoredFill>>
	readonly positioned: () => Kit<PositionedFill, SO, PageProgram<PositionedFill>>
}

/**
 * Every window variant of a page's artifact over the ordered result `root`, each lowered with a fresh kit of `kits`, in
 * the page's order.
 */
const artifactOf = <SP, SA, SO>(
	kits: ArtifactKits<SP, SA, SO>,
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
	const positionedOf = <V extends PositionedVariant>(variant: V): PageRequestProgram<V> => {
		const kit = kits.positioned()
		const shape = shapeIn(kit)
		return {
			variant,
			direction: variantDirection(variant),
			delivery: requestDelivery(shape, variant),
			program: requestProgram(kit, shape, comparators, variant, positionedSlots)
		}
	}
	/** The variants, lowered in the order of pageVariants, each with a fresh kit. */
	const requests: PageArtifact["requests"] = {
		first: plainOf("first"),
		after: anchoredOf("after"),
		last: plainOf("last"),
		before: anchoredOf("before"),
		at: positionedOf("at")
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
			anchored: () => conservativeKit<AnchoredFill>(input),
			positioned: () => conservativeKit<PositionedFill>(input)
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
): Result.Result<GroupOrders, CompileError> => {
	const analysis = analyzeLogical(
		query.dag,
		{ ...evidence, context: "transaction" },
		keptNodes([origin])
	)
	if (!analysis.ok) {
		return Result.err(analysis.error)
	}
	const analyzed = analysis.value.of(origin)
	const props = defined(analysis.value.props.get(origin), "the page's origin, kept")
	const subject = orderSubjectOf(analyzed.node, props, [], (k) =>
		contextAdmits("transaction", k.context)
	)
	return Result.mapError(completeGroups(subject, stated.keys), (e) => reportedAt(e, stated.at))
}

/**
 * The one order a page over a heterogeneous union pages by (take/order.ts sharedOrder): one row's key, of the fields
 * every group holds, seeks every group's part, and the order's run tells rows of two groups apart (ir/rel.ts
 * GroupOrders).
 */
const pagedGroupsOrder = (union: NodeOf<"Union">, orders: GroupOrders): CompletedOrder =>
	sharedOrder(orders, union.heading, nodeLabel(union), "a page over a heterogeneous union")

/**
 * The order a page over the checked query's ordered result `root` compares by (pageOrderOf, or pagedGroupsOrder for a
 * heterogeneous union delivered per heading group), with the shape its conservative artifact delivers: what the page
 * compiler pages by, and what the query's optimized lowering reads a window's driver in (program/compile.ts, read
 * "page"; lower/shapes/page/driver.ts). Refused where the stated order does not begin the query's completed order.
 */
export const completedPageOrder = (
	input: Pick<PageCompileInput, "checked" | "names" | "stated">,
	root: NodeOf<"OrderedResult">
): { readonly shape: PageShape; readonly order: CompletedOrder } => {
	const shape = pageShapeOf(conservativeKit<PageFill>(input).delivery, root)
	/** The checker's completion begins with the stated keys (check/checker.ts complete). */
	const statedPrefix = shape.order.keys.slice(0, input.stated.keys.length)
	if (
		!canonicalEquals(
			statedPrefix,
			input.stated.keys.map((k) => ({ column: k.column, dir: k.dir }))
		)
	) {
		return refuse(
			"MalformedDescription",
			"page compiler",
			"a page template whose stated order begins its query's completed order"
		)
	}
	const order =
		shape.kind === "rows"
			? soleOrder(unwrap(pageOrderOf(input.checked, shape.rows, input.stated, queryEvidence)))
			: pagedGroupsOrder(
					shape.plan.union,
					unwrap(pageOrderOf(input.checked, shape.plan.union, input.stated, queryEvidence))
				)
	return { shape, order }
}

/**
 * The page template of a compiled ordered query: every window variant of its optimized artifact.
 *
 * The page compiler.
 *
 * A compiled ordered query becomes the statements of every window, one per anchor kind:
 *
 * - five window variants, first (from the start), after (a key), last (from the end), before (a key) and at (a
 *   position), each one statement of its own parts with no nullable boundary or offset slot. A variant's rows part is
 *   take(k) of the distinct result D in its fetch order after its seek, or after its offset's count of rows (rows.ts):
 *   the declared order for first, after and at, every direction reversed for last and before, whose rows the runtime
 *   reverses back to the presentation order. The limit is a placeholder the runtime fills with the window's size
 *   (seek.ts CountSlot), an anchored variant's boundary values are placeholders it fills from the anchor's key, one
 *   per comparator, each written by its comparator's codec (seek.ts BoundarySlots), and a positioned variant's offset
 *   is a placeholder it fills with the window's position (seek.ts CountSlot); a plain variant's statement holds no
 *   boundary or offset placeholder, by its type (seek.ts VariantFill). Whether rows lie beyond a window is no flag of
 *   it: the adjacent window, anchored at its first or last row's key, answers them, so no statement fetches past the
 *   size and no second statement asks;
 * - a heterogeneous union delivered per heading group (R21) pages each group: every group part takes k in the common
 *   fetch order after the same seek on the common comparators, the discriminant among them, and the runtime merges the
 *   groups on that order and keeps k (union/index.ts mergeHeadingGroups), because the first n of the union lie among
 *   the first n of each group. A positioned window's group part delivers exactly the group's rows of the window, its
 *   first o+k whose tuples are among the union's [o, o+k) (rows.ts positionedGroupRows), so its merge keeps them all.
 *   A bounded union (a take under the order) is refused: its members depend on the merge across groups, which no group
 *   part sees;
 * - attachments are evaluated over the delivered window only: each is a part of the window's statement over the
 *   delivered rows, which the statement holds once (OptimizedDelivery heldRows), a heading group's rows cut by the
 *   merge (rows.ts retainedGroupRows) or, in a positioned window, its rows of the window (rows.ts
 *   positionedGroupRows), so the parent's plan is the plan the window would have alone. A window never
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
		const { shape: conservativeShape, order } = completedPageOrder(input, checkedRoot)
		const comparators = pageComparators(order, conservativeShape.heading)
		/**
		 * A window's anchor binds each comparator's value as a parameter, and no parameter carries bytes or a search
		 * document (scalar/registry.ts storedOnly, searchedOnly), which only a keyless heading's completion appends.
		 */
		const unbound = comparators.find((c) => storedOnly(c.type) || searchedOnly(c.type))
		if (unbound !== undefined) {
			return refuse(
				"UnsupportedOperation",
				at,
				`ordering: a page seeks by ${unbound.field}, of a type no parameter carries; retain a key of the result in find`
			)
		}
		return {
			order,
			comparators,
			heading: conservativeShape.heading,
			artifact: artifactOf(
				{
					plain: () => optimizedKit<SizeFill>(input, facts),
					anchored: () => optimizedKit<AnchoredFill>(input, facts),
					positioned: () => optimizedKit<PositionedFill>(input, facts)
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
