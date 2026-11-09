import { Refusal } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { concatNonEmpty, isNonEmpty, lastNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { type DeliverySpine, deliverySpine } from "#compiler/ir/dag.ts"
import type { CompletedOrder, Heading, NodeOf, RelNode } from "#compiler/ir/rel.ts"
import {
	type ColumnMap,
	columnIn,
	correlationEqualities,
	distinctSelect,
	type Env,
	emptyEnv,
	headingTargets,
	type LowerContext,
	nodeLabel,
	refuse,
	StatementParams
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { bindLaterally } from "#compiler/lower/conservative/expr/lateral.ts"
import { refineConservative } from "#compiler/lower/conservative/refined.ts"
import { completedOrderItems } from "#compiler/lower/conservative/take/order.ts"
import {
	type ConservativeProgram,
	type ConservativeStatement,
	type DeclaredParamSlot,
	type DeliveredBreach,
	type GroupMerge,
	noColumns,
	type PageParamSlot,
	type ProgramDelivery,
	type StatementPlacement
} from "#compiler/lower/conservative/types.ts"
import { armCore, setOperation } from "#compiler/lower/conservative/union/arms.ts"
import {
	type AttachedTree,
	deliveredHeading,
	type ParentKeyColumn,
	statementOutput,
	type StatementRoots
} from "#compiler/runtime/lower/tree.ts"
import type {
	CountStar,
	Cte,
	Expr,
	FromItem,
	OperandSelect,
	OrderItem,
	EmittedSql,
	Select
} from "#compiler/sql/ast.ts"

import {
	and,
	asc,
	col,
	conjunction,
	countStar,
	cteRef,
	derived,
	distinctCore,
	eq,
	gt,
	keyedSet,
	lit,
	notExists,
	provedSelect,
	select,
	simpleSelect,
	target,
	types,
	windowOf
} from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { type NameOrigin, type NameSupply, renameToPublicHeading } from "#compiler/sql/naming.ts"

/**
 * A statement's query, its outermost output renamed to `names`, the public heading's, and printed under `supply`'s
 * names: the AST the statement keeps and the SQL it runs.
 */
export const printedStatement = (
	query: Select,
	names: ReadonlyArray<string>,
	supply: NameSupply
): { readonly ast: Select; readonly sql: EmittedSql } => {
	const renamed = renameToPublicHeading(bindLaterally(query, supply), names)
	if (!renamed.ok) {
		throw new Refusal(renamed.error)
	}
	const printed = emit(renamed.value, supply.map())
	if (!printed.ok) {
		throw new Refusal(printed.error)
	}
	return { ast: renamed.value, sql: printed.value }
}

const sameOrder = (a: CompletedOrder, b: CompletedOrder): boolean =>
	a.keys.length === b.keys.length &&
	a.keys.every((k, i) => k.column === b.keys[i]?.column && k.dir === b.keys[i].dir)

/**
 * How a plan bounds and orders its heading groups: not at all; in the ordered result's order; by an uncorrelated take,
 * k per group in its completed order, the ordered result's when there is one, being the same; or by a take and then
 * in the ordered result's order, which differs from the take's.
 */
type GroupBound =
	| { readonly kind: "none" }
	| { readonly kind: "order"; readonly order: CompletedOrder }
	| { readonly kind: "take"; readonly take: NodeOf<"Take"> }
	| {
			readonly kind: "takeThenOrder"
			readonly take: NodeOf<"Take">
			readonly order: CompletedOrder
	  }

/**
 * How the runtime merges the heading-group statements of a plan: as they come, in its order, by its take, or by its
 * take then in its order.
 */
const groupMerge = (plan: HeterogeneousPlan): GroupMerge => {
	const b = plan.bound
	switch (b.kind) {
		case "none":
			return { kind: "concat" }
		case "order":
			return { kind: "order", order: b.order }
		case "take":
			return { kind: "take", bound: b.take.bound, take: b.take.order }
		case "takeThenOrder":
			return { kind: "takeThenOrder", bound: b.take.bound, take: b.take.order, order: b.order }
	}
}

/**
 * How the runtime combines the heading-group statements of a heterogeneous union delivered per group.
 *
 * Statement scheduling: the statements a query's result is delivered by.
 *
 * - The root's set is one main statement: its query, read as a derived table, renamed to the public heading in the
 *   outermost SELECT only, with ORDER BY when the root is an ordered result.
 * - A heterogeneous union delivered to the host is one statement per heading group, each with the group's full
 *   heading, pipelined in one snapshot; never a padded single statement. A take over it takes k per group
 *   in the completed common order, and the runtime merges the groups on that order and keeps k; the
 *   program's `merge` says how, the take's order apart from the delivery order. Attachments and filters above the union
 *   apply per group (heterogeneousPlan); any other node over it, which would deliver only the common heading, is
 *   refused.
 * - Each attachment is one more statement, sent in the same flight as its parent's and run in the same snapshot. It
 *   computes its parent's rows again, as a derived table of its own (parentRowsSource), and selects, for every parent
 *   row, the child's facts correlated to it: the parent key columns first, then the child's heading. Attachments nest;
 *   a child's own attachments compute the child statement's rows again the same way, its parent's included.
 *
 * Why the recomputed parent rows are the delivered ones. Each recomputation is the parent's own query, lowered again
 * from the same nodes: every take in it bounds by a completed total order, so it keeps the same facts whatever the
 * plan, and every scalar is immutable or stable, so its values are those of the parent statement in the one snapshot
 * and transaction both run in. Only the delivery ORDER BY is left out, which never changes a set. The parent's rows
 * are read once per row, as the delivered rows were, so a DISTINCT the child statement omits on the facts' word omits
 * nothing the parent repeats. A parent that delivers no row gives the child statement no row, which is its answer.
 *
 * The attachments a statement delivers are those of its rows' spine (dag.ts deliverySpine): the chain of nodes whose
 * rows are their input's rows under the same heading (keptRowsOf, a page and a law's violation query included, and a
 * union of one arm). A valid DAG holds no delivery node off its root's spine, so every attachment a statement's rows
 * reach is on it. A union of several arms whose arms attach is refused: a fact of the union may come from several
 * arms, so which arm's attachments it carries is not determined.
 */
export const headingGroupsDelivery = (plan: HeterogeneousPlan): ProgramDelivery => ({
	kind: "headingGroups",
	discriminant: plan.union.discriminant,
	heading: plan.union.heading,
	merge: groupMerge(plan)
})

/** A heterogeneous union delivered per heading group, with the nodes above it that apply per group. */
export interface HeterogeneousPlan {
	readonly union: NodeOf<"Union">
	/** The nodes between the delivery and the union, outermost first; their rows are the union's. */
	readonly spineNodes: ReadonlyArray<RelNode>
	readonly attachments: ReadonlyArray<NodeOf<"Attach">>
	/** Outermost first. */
	readonly filters: ReadonlyArray<NodeOf<"Filter">>
	readonly bound: GroupBound
}

/** The order each group statement of a plan delivers its rows in: the ordered result's, else the take's, else none. */
export const groupOrder = (plan: HeterogeneousPlan): CompletedOrder | undefined => {
	const b = plan.bound
	switch (b.kind) {
		case "none":
			return undefined
		case "order":
		case "takeThenOrder":
			return b.order
		case "take":
			return b.take.order
	}
}

/** The take that bounds every group of a plan by k, if any. */
export const groupTake = (plan: HeterogeneousPlan): NodeOf<"Take"> | undefined => {
	const b = plan.bound
	switch (b.kind) {
		case "none":
		case "order":
			return undefined
		case "take":
		case "takeThenOrder":
			return b.take
	}
}

interface Spine {
	/** The nodes whose rows are the delivered rows, under the delivered heading's column names. */
	readonly nodes: ReadonlyArray<RelNode>
	readonly attachments: ReadonlyArray<NodeOf<"Attach">>
}

/**
 * The union of several heading groups a spine ends at, whose rows under their heading are the spine's, or undefined
 * where the spine ends elsewhere.
 */
const heterogeneousUnion = (spine: DeliverySpine): NodeOf<"Union"> | undefined => {
	const union = spine.arms?.union
	return union !== undefined && union.groups.length > 1 ? union : undefined
}

/**
 * Delivered rows: the columns their statement puts before them, their heading, and how a later statement computes them
 * again.
 */
export interface ParentRows {
	/** The output columns the statement's role puts before the delivered relation's (types.ts keyColumns). */
	readonly key: Heading
	/** The delivered relation's heading, whose columns an attachment correlates on. */
	readonly heading: Heading
	/**
	 * The statement's rows lowered again inside the statement being lowered, without the delivery ORDER BY: the key
	 * columns, then the delivered relation's (deliveredHeading).
	 */
	readonly recompute: () => OperandSelect
}

/** The parent columns a child reads itself: its outer references to a node of the delivered rows' spine. */
export const parentColumnsRead = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>
): ReadonlySet<string> => {
	const spineNodes = new Set(spine.map((n) => n.id))
	return new Set(
		[...cx.freeRefs(attach.child)].flatMap(([ref, columns]) =>
			spineNodes.has(ref) ? [...columns] : []
		)
	)
}

/**
 * The parent columns a child reads, an attachment statement's parent key: its correlation, and those it reads itself,
 * in the delivered heading's order, each at its position there. Each is a column of the delivered heading: every node
 * of the spine keeps the rows, and so the columns, of the node it reads (rel.ts keptRowsOf; a union of one arm has its
 * arm's), so the parent the correlation names and every spine node the child reads have the delivered heading's
 * columns (valid DAG).
 */
export const parentColumnsOf = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>,
	delivered: Heading
): ReadonlyArray<ParentKeyColumn> => {
	const needed = new Set([
		...attach.correlation.map((c) => c.parent),
		...parentColumnsRead(cx, attach, spine)
	])
	return delivered.flatMap((c, at) =>
		needed.has(c.name) ? [{ name: c.name, type: c.type, at }] : []
	)
}

/**
 * The parent's rows recomputed as a derived table of the statement being lowered, with one fresh column per output
 * position, and each parent column's expression over it. This replaces the delivered parent keys an attachment once
 * took as a parameter, so the attachment needs no earlier statement's rows.
 */
export const parentRowsSource = (
	cx: LowerContext,
	rows: ParentRows,
	origin: NameOrigin
): { readonly item: FromItem; readonly column: (name: string) => Expr } => {
	const query = rows.recompute()
	const alias = cx.relationAlias(origin)
	const key = cx.supply.columns(rows.key.map(() => origin))
	const delivered = deliveredHeading(rows.heading).map((c): readonly [string, string] => [
		c.name,
		cx.supply.column(origin)
	])
	const item: FromItem = derived(query, alias, [...key, ...delivered.map(([, c]) => c)], false)
	const map: ColumnMap = new Map(delivered.map(([name, c]) => [name, col(alias, c)]))
	return {
		item,
		/** A parent key column, which parentColumnsOf read from the delivered heading. */
		column: (name) => columnIn(map, name)
	}
}

/**
 * The statement `query` of an attachment that delivers its child as a bare child or an option, in a read-back, which
 * checks that type itself (types.ts ReadBackLowering); any other statement as it is. Its output columns are the parent
 * key `parentKey`, then the child's of heading `child`, and `rows` are the parent's rows.
 *
 *   WITH "rv"("c7", "c8", "c9") AS MATERIALIZED (
 *     SELECT "r5"."c4", "r5"."c6", count(*) OVER (PARTITION BY "r5"."c4") FROM (<the statement>) AS "r5"("c4", "c6")
 *   ), "rw"(...) AS (
 *     SELECT 5, '21Z01', 'one', <DETAIL> FROM "rv" WHERE "rv"."c9" > 1
 *     UNION ALL SELECT 5, '21Z01', 'one', <DETAIL> FROM (<the parent's rows>) AS "r10"("c11", "c12")
 *       WHERE NOT EXISTS (SELECT 1 FROM "rv" WHERE "rv"."c7" = "r10"."c12")
 *     ORDER BY ... LIMIT 1
 *   )
 *   SELECT "rv"."c7", "rv"."c8" FROM "rv" WHERE NOT EXISTS (SELECT 1 FROM "rw" WHERE "s"."__refuse"(...))
 *
 * Each parent key's children are counted as the host groups the rows: the statement's rows after its DISTINCT, by the
 * parent key's native equality, which is the host's stitch identity, since every value has one form on the host and
 * no reading grizzle emits sees a display scale (packages/grizzle/src/adapter/reader/execution.ts stitches by each
 * carrier's cell text). More than one breaks either type; a bare child also needs one at every parent key
 * of the parent's rows, computed again, since a parent without a child has no row here. A bare child and an option
 * have no order, so the statement has no ORDER BY to keep.
 */
export const checkedAttachment = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	query: Select,
	parentKey: Heading,
	child: Heading,
	rows: ParentRows
): Select => {
	const readBack = cx.options.subject
	if (readBack.kind !== "readBack" || attach.delivered === "array") {
		return query
	}
	const delivered = attach.delivered
	const origin = { kind: "node", node: attach.id } as const
	const inner = cx.relationAlias(origin)
	const rv = cx.relationAlias(origin)
	const column = (c: Heading[number]) => ({
		...c,
		inner: cx.supply.column(origin),
		kept: cx.supply.column(origin)
	})
	const keys = parentKey.map(column)
	const columns = [...keys, ...deliveredHeading(child).map(column)]
	const count = cx.supply.column(origin)
	const children: CountStar = {
		...countStar(),
		over: windowOf(
			keys.map((c) => col(inner, c.inner)),
			[]
		)
	}
	const kept: Cte = {
		name: rv,
		columns: [...columns.map((c) => c.kept), count],
		materialized: "MATERIALIZED",
		query: simpleSelect(
			[...columns.map((c) => target(col(inner, c.inner))), target(children)],
			[
				derived(
					query,
					inner,
					columns.map((c) => c.inner),
					false
				)
			],
			undefined
		)
	}
	const many: DeliveredBreach = {
		from: cteRef(rv),
		when: gt(col(rv, count), lit.int(1, types.integer)),
		delivered,
		key: keys.map((c) => ({ field: c.name, expr: col(rv, c.kept), type: c.type }))
	}
	const none = (): DeliveredBreach => {
		const parent = parentRowsSource(cx, rows, origin)
		const matches = keys.map((c) => eq(col(rv, c.kept), parent.column(c.name)))
		return {
			from: parent.item,
			when: notExists(
				simpleSelect([target(lit.int(1, types.integer))], [cteRef(rv)], conjunction(matches))
			),
			delivered,
			key: keys.map((c) => ({ field: c.name, expr: parent.column(c.name), type: c.type }))
		}
	}
	const raised = readBack.breach(cx.supply, delivered === "one" ? [many, none()] : [many])
	return {
		...provedSelect(
			"keyed",
			columns.map((c) => target(col(rv, c.kept))),
			[cteRef(rv)],
			raised.guard
		),
		with: { ctes: [kept, raised.cte], recursive: false }
	}
}

/** The parent rows of a rows statement delivering a relation of heading `heading`, recomputed by `recompute`. */
export const statementRows = (heading: Heading, recompute: () => OperandSelect): ParentRows => ({
	key: noColumns,
	heading,
	recompute
})

/** One heading group of a heterogeneous union. */
type HeadingGroup = NodeOf<"Union">["groups"][number]

/** The parent rows of an attachment statement: its child's columns after the parent key columns. */
export const attachmentRows = (
	parentKey: Heading,
	child: Heading,
	recompute: () => Select
): ParentRows => ({ key: parentKey, heading: child, recompute })

/**
 * Where a program's statements go, in flight order: `place` builds the next statement at the position it takes, which
 * a refusal of its lowering names.
 */
export type Place = <S>(build: (position: number) => S) => S

/** The positions of a program's statements, the first at 0. */
export const positions = (): Place => {
	let next = 0
	return (build) => build(next++)
}

/**
 * One attachment statement's rows, unordered for a recomputation and in its delivery order for its own statement: the
 * parent key columns, then the child's.
 */
interface AttachmentQuery {
	readonly rows: Select
	readonly delivered: Select
	readonly parentKey: ReadonlyArray<ParentKeyColumn>
}

/**
 * The statements of one delivery over `cx`: each begun with placeholders of its own, a declared parameter's or one of
 * `Own` its caller allocates (a page's fills), which the statement it emits holds.
 */
export class Delivery<Own extends PageParamSlot = never> {
	readonly cx: LowerContext
	#params: StatementParams<Own>

	constructor(cx: LowerContext) {
		this.cx = cx
		this.#params = new StatementParams<Own>()
		cx.beginStatement(this.#params)
	}

	/** The placeholders of the statement being lowered. */
	get params(): StatementParams<Own> {
		return this.#params
	}

	/** The next statement, with fresh names and placeholders; names and placeholders never cross statements. */
	beginStatement(): void {
		this.#params = new StatementParams<Own>()
		this.cx.beginStatement(this.#params)
	}

	/** The delivered rows from `start` (dag.ts deliverySpine) and the attachments on them. */
	spine(start: RelNode): Spine {
		const s = deliverySpine(start)
		this.refuseArmAttachments(s)
		return { nodes: s.nodes, attachments: s.attachments.map((a) => a.attach) }
	}

	/** Refuses an attachment on an arm of the union of several arms a spine ends at, an arm's own union first. */
	refuseArmAttachments(s: DeliverySpine): void {
		if (s.arms === undefined) {
			return
		}
		const { union, spines } = s.arms
		for (const arm of spines) {
			this.refuseArmAttachments(arm)
			if (arm.attachments.length > 0) {
				refuse(
					"UnsupportedOperation",
					nodeLabel(union),
					`attachments on the arm ${arm.nodes[0].id} of a union of several arms, whose facts may come from several arms`
				)
			}
		}
	}

	/**
	 * One statement delivering a relation of heading `rows` after the columns its role puts first, printed by sql/emit
	 * after renaming the outermost output to the output's names (statementOutput). A zero-column relation delivers its
	 * private unit column.
	 */
	statement(
		query: Select,
		rows: Heading,
		statement: StatementPlacement
	): ConservativeStatement<DeclaredParamSlot | Own> {
		const output = statementOutput(statement.role, rows, [])
		return {
			...statement,
			...printedStatement(
				refineConservative(this.cx, query, output.heading, rows.length === 0),
				output.names,
				this.cx.supply
			),
			params: [...this.#params.slots],
			heading: rows
		}
	}

	/** SELECT <columns> FROM (<rel>) AS r(...) [ORDER BY ...]: a relation delivered as the statement's rows. */
	delivered(
		rel: OperandSelect,
		heading: Heading,
		origin: RelNode,
		order: CompletedOrder | undefined
	): Select {
		const source = this.cx.wrap(rel, heading, { kind: "node", node: origin.id })
		const orderBy: ReadonlyArray<OrderItem> =
			order === undefined || heading.length === 0
				? []
				: completedOrderItems(order, heading, source.map)
		return {
			...select(
				keyedSet(headingTargets(heading, source.map), [source.item], undefined, "a delivery")
			),
			orderBy
		}
	}

	program(root: RelNode): ConservativeProgram<DeclaredParamSlot | Own> {
		const plan = this.heterogeneousPlan(root)
		if (plan !== undefined) {
			return { roots: this.groups(plan), delivery: headingGroupsDelivery(plan) }
		}
		const order = root.kind === "OrderedResult" ? root.order : undefined
		const rows = root.kind === "OrderedResult" ? root.input : root
		this.beginStatement()
		const rel = (): OperandSelect => this.cx.lower(rows, emptyEnv)
		const query = this.delivered(rel(), rows.heading, rows, order)
		const statement = this.statement(query, rows.heading, {
			role: { kind: "main" },
			dependsOn: []
		})
		const attachments = this.attachments(this.spine(rows), statementRows(rows.heading, rel))
		return { roots: [{ statement, attachments }], delivery: { kind: "rows" } }
	}

	/**
	 * The heterogeneous union a delivered relation's rows come from, through the nodes that keep its rows' headings,
	 * or undefined when its rows do not come from one. Delivered to the host, each heading group is one statement,
	 * so the rows above the union must be computable per group:
	 *
	 * - an attachment, which never changes its parent's rows, runs against every group statement, reading the common
	 *   columns it correlates on;
	 * - a filter, whose predicate reads the common columns, applies to every group;
	 * - an uncorrelated take bounds every group by k in its completed order, and the runtime merges the groups on that
	 *   order and keeps k; a filter above the take would apply after the overall bound, which no group
	 *   can see, so it is refused;
	 * - an ordered result orders each group's rows and the merged delivery.
	 *
	 * Any other node between the delivery and the union (a semi-join, anti-join, intersection or difference over it, a
	 * correlated take, a second take or order) would deliver only the common heading, dropping each group's own columns,
	 * so it is refused.
	 *
	 * The spine's nodes above the union, outermost first.
	 */
	heterogeneousPlan(root: RelNode): HeterogeneousPlan | undefined {
		const spine = deliverySpine(root)
		const union = heterogeneousUnion(spine)
		if (union === undefined) {
			return undefined
		}
		const spineNodes: Array<RelNode> = []
		const attachments: Array<NodeOf<"Attach">> = []
		const filters: Array<NodeOf<"Filter">> = []
		let bound: GroupBound = { kind: "none" }
		/** Whether `node` applies per group, recording it. */
		const below = (node: RelNode): boolean => {
			switch (node.kind) {
				case "Attach":
					attachments.push(node)
					return true
				case "Filter":
					filters.push(node)
					return true
				case "OrderedResult":
					if (bound.kind !== "none" || filters.length > 0) {
						return false
					}
					bound = { kind: "order", order: node.order }
					return true
				case "Take":
					if (
						node.correlation.length > 0 ||
						filters.length > 0 ||
						bound.kind === "take" ||
						bound.kind === "takeThenOrder"
					) {
						return false
					}
					bound =
						bound.kind === "none" || sameOrder(bound.order, node.order)
							? { kind: "take", take: node }
							: { kind: "takeThenOrder", take: node, order: bound.order }
					return true
				case "Base":
				case "Closed":
				case "Context":
				case "InputSet":
				case "Delta":
				case "MatchRegion":
				case "ProjectSet":
				case "SemiJoin":
				case "AntiJoin":
				case "Union":
				case "Intersect":
				case "Difference":
				case "Group":
				case "Produce":
				case "Recursive":
				case "SelfRef":
				case "ApproximateNearest":
				case "Forbid":
				case "Window":
				case "OrderedSetAggregate":
					return false
			}
		}
		for (const node of spine.nodes.slice(0, -1)) {
			if (!below(node)) {
				refuse(
					"UnsupportedOperation",
					nodeLabel(node),
					`delivering the heterogeneous union ${union.id} through ${node.kind}: each heading group is one statement, and only attachments, filters below one uncorrelated take, and one ordered result above them apply per group`
				)
			}
			spineNodes.push(node)
		}
		return { union, spineNodes, attachments, filters, bound }
	}

	/** One statement per heading group, each with its attachments' statements (groupStatement, groupAttachments). */
	groups(plan: HeterogeneousPlan): StatementRoots<ConservativeStatement<DeclaredParamSlot | Own>> {
		return mapNonEmpty(plan.union.groups, (group, gi) => {
			const built = this.groupStatement(plan, gi, group)
			return {
				statement: built.statement,
				attachments: this.groupAttachments(plan, group, statementRows(group.heading, built.rel))
			}
		})
	}

	/**
	 * The statement of heading group `gi`, in a statement of its own: the group's arms, filtered by the plan's filters,
	 * bounded by k in the take's completed order, and delivered in the plan's order, or the take's when it has none; and
	 * the group's rows, which its attachments compute again.
	 */
	groupStatement(
		plan: HeterogeneousPlan,
		gi: number,
		group: HeadingGroup
	): {
		readonly statement: ConservativeStatement<DeclaredParamSlot | Own>
		readonly rel: () => Select
	} {
		const { union } = plan
		const take = groupTake(plan)
		const scopeNodes = [...plan.spineNodes, union]
		this.beginStatement()
		/** The group's rows, lowered in the statement being lowered: its own, or an attachment's recomputing them. */
		const rel = (): Select => {
			let rows = setOperation(
				"UNION",
				mapNonEmpty(group.arms, (arm) => armCore(this.cx, arm, group.heading, emptyEnv))
			)
			const filters = plan.filters
			if (isNonEmpty(filters)) {
				const innermost = lastNonEmpty(filters)
				const input = this.cx.wrap(rows, group.heading, { kind: "node", node: innermost.id })
				const scope: Env = new Map<NodeId, ColumnMap>(scopeNodes.map((n) => [n.id, input.map]))
				rows = distinctSelect(
					headingTargets(group.heading, input.map),
					[input.item],
					[and(mapNonEmpty(filters, (f) => lowerExpr(this.cx, f.pred, scope)))]
				)
			}
			if (take !== undefined) {
				const bounded = this.cx.wrap(rows, group.heading, { kind: "node", node: take.id })
				rows = {
					...select(
						distinctCore(headingTargets(group.heading, bounded.map), [bounded.item], undefined)
					),
					orderBy: completedOrderItems(take.order, group.heading, bounded.map),
					limit: this.cx.boundExpr(take.bound)
				}
			}
			return rows
		}
		const query = this.delivered(rel(), group.heading, union, groupOrder(plan))
		const statement = this.statement(query, group.heading, {
			role: { kind: "headingGroup", group: gi },
			dependsOn: []
		})
		return { statement, rel }
	}

	/**
	 * The attachments of a placed heading group's statement: those above the union, then those of the group's single
	 * arm.
	 */
	groupAttachments(
		plan: HeterogeneousPlan,
		group: HeadingGroup,
		rows: ParentRows
	): ReadonlyArray<AttachedTree<ConservativeStatement<DeclaredParamSlot | Own>>> {
		const at = nodeLabel(plan.union)
		const above = this.attachments(
			{ nodes: [...plan.spineNodes, plan.union], attachments: plan.attachments },
			rows
		)
		const [only, ...others] = group.arms
		if (others.length === 0) {
			return [...above, ...this.attachments(this.spine(only), rows)]
		}
		for (const arm of group.arms) {
			if (this.spine(arm).attachments.length > 0) {
				refuse(
					"UnsupportedOperation",
					at,
					`attachments on the arm ${arm.id} of a heading group of several arms`
				)
			}
		}
		return above
	}

	attachments(
		spine: Spine,
		rows: ParentRows
	): ReadonlyArray<AttachedTree<ConservativeStatement<DeclaredParamSlot | Own>>> {
		return spine.attachments.map((attach) => this.attachment(attach, spine, rows))
	}

	/**
	 * One attachment statement delivers one heading, so an attachment whose child's spine ends at a union of several
	 * heading groups is refused, whichever delivery lowers it.
	 */
	oneHeadingAttached(attach: NodeOf<"Attach">): void {
		const heterogeneous = heterogeneousUnion(deliverySpine(attach.child))
		if (heterogeneous !== undefined) {
			refuse(
				"UnsupportedOperation",
				nodeLabel(attach),
				`an attached heterogeneous union ${heterogeneous.id} delivered per heading group; one attachment statement delivers one heading`
			)
		}
	}

	/**
	 * The children of one attachment, for every parent row, as a statement of its own.
	 *
	 * The child's own attachments read this statement's rows, the child columns after the parent key, computing
	 * them again in their own statements.
	 */
	attachment(
		attach: NodeOf<"Attach">,
		spine: Spine,
		rows: ParentRows
	): AttachedTree<ConservativeStatement<DeclaredParamSlot | Own>> {
		const cx = this.cx
		const child = attach.child
		this.oneHeadingAttached(attach)
		this.beginStatement()
		const built = this.attachmentQuery(attach, spine, rows)
		const query = checkedAttachment(
			cx,
			attach,
			built.delivered,
			built.parentKey,
			child.heading,
			rows
		)
		const statement = this.statement(query, child.heading, {
			role: { kind: "attachment", parentKey: built.parentKey },
			dependsOn: []
		})
		const attachments = this.attachments(
			this.spine(attach.child),
			attachmentRows(
				built.parentKey,
				child.heading,
				() => this.attachmentQuery(attach, spine, rows).rows
			)
		)
		return { statement, attach, attachments }
	}

	/**
	 * The query of one attachment statement in the statement being lowered: for every row of its parent, computed
	 * again here (parentRowsSource), the child's facts correlated to it, the parent key columns first.
	 */
	attachmentQuery(attach: NodeOf<"Attach">, spine: Spine, rows: ParentRows): AttachmentQuery {
		const cx = this.cx
		const child = attach.child
		const parentKey = parentColumnsOf(cx, attach, spine.nodes, rows.heading)
		const parent = parentRowsSource(cx, rows, { kind: "node", node: attach.id })
		const parentExprs = parentKey.map((c) => ({ name: c.name, expr: parent.column(c.name) }))
		const parentMap = new Map<string, Expr>(parentExprs.map((p) => [p.name, p.expr]))
		const env: Env = new Map<NodeId, ColumnMap>(spine.nodes.map((n) => [n.id, parentMap]))
		const source = cx.sourceAs(attach.child, env, true)
		const where = correlationEqualities(cx, attach, child.heading, source.map, parentMap)
		const parentTargets = parentExprs.map((p) => target(p.expr))
		const childTargets = headingTargets(child.heading, source.map)
		const orderBy: ReadonlyArray<OrderItem> =
			attach.order === undefined
				? []
				: [
						...parentExprs.map((p) => asc(p.expr)),
						...completedOrderItems(attach.order, child.heading, source.map)
					]
		const body = distinctCore(
			concatNonEmpty(parentTargets, childTargets),
			[parent.item, source.item],
			conjunction(where)
		)
		return {
			rows: select(body),
			delivered: { ...select(body), orderBy },
			parentKey
		}
	}
}
