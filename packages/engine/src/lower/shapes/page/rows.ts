import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import {
	type ColumnMap,
	headingTargets,
	type LowerContext
} from "#compiler/lower/conservative/context.ts"

import {
	comparatorColumn,
	type PageComparator,
	type PageDirection,
	type PageSlots,
	reversedOrder,
	type Seek,
	seekPredicate
} from "#compiler/lower/shapes/page/seek.ts"
import type { Expr, OrderItem, Select, SelectBody, SelectCore } from "#compiler/sql/ast.ts"
import { core, countStar, exists, lit, lt, select, target, types } from "#compiler/sql/build.ts"
import type { NameOrigin } from "#compiler/sql/naming.ts"

interface PagedRowsSpec {
	/** The distinct rows D, already deduplicated unless their uniqueness is proved. */
	readonly rel: Select
	readonly heading: Heading
	readonly origin: NameOrigin
	/** Undefined for an anchorless request. */
	readonly seek: Seek | undefined
	readonly direction: PageDirection
	/** The ORDER BY of D in the declared order, over its columns as read. */
	readonly order: (map: ColumnMap) => ReadonlyArray<OrderItem>
	readonly limit: Expr
	readonly slots: PageSlots
}

/**
 * SELECT <heading> FROM (D) AS r(...) [WHERE seek] ORDER BY <order, reversed when backward> LIMIT <size + 1>.
 *
 * The statement shapes of a keyset page.
 *
 * A page is take(k + 1) over the completed order plus the seek predicate: the distinct result D read as a
 * derived table, the seek on its delivered columns, ORDER BY the completed order (every direction reversed for a
 * backward variant), and LIMIT the requested size plus one, whose extra row is the lookahead that proves the flag in the
 * fetching direction. The seek and the bound apply to the final distinct result, never to an earlier
 * stage: D is deduplicated before the limit unless its uniqueness is proved, so no hidden source key manufactures
 * distinct answers (R17). PostgreSQL pulls a plain derived table up into the
 * statement, so over a retained key the seek reaches the base scan as an index condition and no Unique node appears.
 *
 * A probe is the bounded existence test of the opposite flag: EXISTS (SELECT 1 FROM D WHERE seek),
 * which is duplicate-insensitive, so D needs no deduplication of its own under it.
 *
 * A page's attachment statement computes the rows the page delivers again, in the same snapshot: take(k) where the
 * rows statement takes k + 1, so the lookahead row gets no children. Over a heterogeneous union each group's
 * statement takes k + 1 and the runtime keeps the first k of their merge, so the group rows an attachment reads are
 * the group's first k whose place in the merge is within k (retainedGroupRows): fewer than k tuples of every group's
 * first k precede them in the fetch order. The first k of the union lie among the first k of each group, so a kept
 * tuple's predecessors are all counted, and an unkept one has at least k.
 */
export const pagedRows = (cx: LowerContext, spec: PagedRowsSpec): Select => {
	const source = cx.wrap(spec.rel, spec.heading, spec.origin)
	const where =
		spec.seek === undefined ? undefined : seekPredicate(spec.slots.seekKeys(source.map), spec.seek)
	const declared = spec.order(source.map)
	const orderBy = spec.direction === "backward" ? reversedOrder(declared) : declared
	return {
		...select(core(headingTargets(spec.heading, source.map), [source.item], where)),
		orderBy,
		limit: spec.limit
	}
}

interface ProbeSpec {
	readonly rel: Select
	readonly heading: Heading
	readonly origin: NameOrigin
	readonly seek: Seek
	readonly slots: PageSlots
}

/** EXISTS (SELECT 1 FROM (D) AS r(...) [WHERE seek]). */
export const probeTest = (cx: LowerContext, spec: ProbeSpec): Expr => {
	const source = cx.wrap(spec.rel, spec.heading, spec.origin)
	const where = seekPredicate(spec.slots.seekKeys(source.map), spec.seek)
	return exists(select(core([target(lit.int(1, types.integer))], [source.item], where)))
}

interface PagedGroup {
	readonly rows: () => Select
	readonly heading: Heading
}

interface RetainedGroupSpec {
	/**
	 * Every heading group's paged rows, each lowered by pagedRows bounded by the page size at every call, so no name is
	 * defined twice in the statement, and its heading.
	 */
	readonly groups: NonEmptyReadonlyArray<PagedGroup>
	/** The group whose kept rows these are. */
	readonly own: PagedGroup
	readonly origin: NameOrigin
	readonly comparators: ReadonlyArray<PageComparator>
	readonly direction: PageDirection
	readonly size: Expr
	readonly at: string
}

/**
 * The rows of one heading group that a page of the union keeps (see the header):
 *
 *   SELECT <heading> FROM (<the group's first k>) AS r1(...)
 *   WHERE (SELECT count(*) FROM (<each group's first k, its comparators> UNION ALL ...) AS r2(...)
 *          WHERE <r2 precedes r1 in the fetch order>) < k
 */
export const retainedGroupRows = (cx: LowerContext, spec: RetainedGroupSpec): Select => {
	const kept = cx.wrap(spec.own.rows(), spec.own.heading, spec.origin)
	const [first, ...rest] = mapNonEmpty(spec.groups, (g): SelectCore => {
		const source = cx.wrap(g.rows(), g.heading, spec.origin)
		return core(
			spec.comparators.map((c) => target(comparatorColumn(source.map, c))),
			[source.item],
			undefined
		)
	})
	const union = rest.reduce<SelectBody>(
		(left, right) => ({ kind: "setOp", op: "UNION ALL", left, right }),
		first
	)
	const comparatorHeading: Heading = spec.comparators.map((c) => ({ name: c.field, type: c.type }))
	const all = cx.wrap(select(union), comparatorHeading, spec.origin)
	/** Strictly before in the fetch order: before in the declared order for a forward page, after it for a backward one. */
	const precedes = seekPredicate(
		spec.comparators.map((c) => ({
			direction: c.direction,
			column: comparatorColumn(all.map, c),
			boundary: comparatorColumn(kept.map, c)
		})),
		{ side: spec.direction === "forward" ? "precedes" : "follows", inclusive: false }
	)
	const predecessors: Expr = {
		kind: "subquery",
		query: select(core([target(countStar())], [all.item], precedes))
	}
	return select(
		core(headingTargets(spec.own.heading, kept.map), [kept.item], lt(predecessors, spec.size))
	)
}
