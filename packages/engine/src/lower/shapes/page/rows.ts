import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Heading } from "#compiler/ir/rel.ts"
import {
	type ColumnMap,
	headingTargets,
	type LowerContext
} from "#compiler/lower/conservative/context.ts"

import { completedOrderItems } from "#compiler/lower/conservative/take/order.ts"
import {
	comparatorColumn,
	edgeStart,
	type PageComparator,
	type PageDirection,
	reversedOrder,
	seekPredicate,
	type WindowStart
} from "#compiler/lower/shapes/page/seek.ts"
import type { Expr, FromItem, OperandSelect, OrderItem, Select } from "#compiler/sql/ast.ts"
import {
	binary,
	conjunction,
	countStar,
	exists,
	keyedSet,
	lit,
	lt,
	orderedLimit,
	provedCore,
	select,
	simpleSelect,
	target,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import type { NameOrigin } from "#compiler/sql/naming.ts"

interface PagedRowsSpec {
	/** The distinct rows D, already deduplicated unless their uniqueness is proved. */
	readonly rel: OperandSelect
	readonly heading: Heading
	readonly origin: NameOrigin
	/** Where the window's rows begin: the order's first row, strictly past an anchor, or past an offset. */
	readonly start: WindowStart
	readonly direction: PageDirection
	/** The ORDER BY of D in the declared order, over its columns as read. */
	readonly order: (map: ColumnMap) => ReadonlyArray<OrderItem>
	readonly limit: Expr
}

/**
 * SELECT <heading> FROM (D) AS r(...) [WHERE seek] ORDER BY <order, reversed when backward> LIMIT <size>
 * [OFFSET <offset>].
 *
 * The statement shape of a window.
 *
 * A keyset window is take(k) over the completed order plus the seek predicate: the distinct result D read as a derived
 * table, the seek on its delivered columns, ORDER BY the completed order (every direction reversed for a backward
 * variant), and LIMIT the window's size. Whether rows lie beyond it is the adjacent window's to answer, so no row is
 * fetched past the size. The seek and the bound apply to the final distinct result, never to an earlier stage: D is
 * deduplicated before the limit unless its uniqueness is proved, so no hidden source key manufactures distinct answers
 * (R17). PostgreSQL pulls a plain derived table up into the statement, so over a retained key the seek reaches the base
 * scan as an index condition and no Unique node appears.
 *
 * A positioned window is PostgreSQL's own OFFSET over the same order: no seek, and OFFSET the window's position, the
 * count of D's rows before it, which the completed order, total over D, makes exact for the statement's snapshot. Its
 * executor reads and discards those rows, through the same index scan a keyset window's order reads, so its cost grows
 * with its position, where a keyset window's does not.
 *
 * A window's attachment part reads the rows the window delivers: take(k), as its rows part. Over a heterogeneous union
 * each group's part takes k and the runtime keeps the first k of their merge, so the group rows an attachment reads are
 * the group's first k whose place in the merge is within k (retainedGroupRows): fewer than k tuples of every group's
 * first k precede them in the fetch order. The first k of the union lie among the first k of each group, so a kept
 * tuple's predecessors are all counted, and an unkept one has at least k.
 */
export const pagedRows = (cx: LowerContext, spec: PagedRowsSpec): Select => {
	const source = cx.wrap(spec.rel, spec.heading, spec.origin)
	const start = spec.start
	const where =
		start.kind === "seek"
			? seekPredicate(start.anchor.boundaries.seekKeys(source.map), start.anchor.seek, cx.names)
			: undefined
	const declared = spec.order(source.map)
	const orderBy = spec.direction === "backward" ? reversedOrder(declared) : declared
	return {
		...select(
			keyedSet(headingTargets(spec.heading, source.map), [source.item], where, "a page's rows")
		),
		orderBy,
		limit: orderedLimit("page seek", orderBy, spec.limit),
		offset: start.kind === "offset" ? start.offset.value() : undefined
	}
}

interface DrivenRowsSpec {
	/**
	 * S (driver.ts DriverValues): the rows of the prefix's columns the call reads, as a FROM item and its columns by the
	 * driver's names; the unit row where the call's points fix the whole prefix.
	 */
	readonly values: { readonly item: FromItem; readonly map: ColumnMap }
	/** One part's driver rows at S's row `values`, the prefix and the interval its filter, its columns named as D's. */
	readonly driver: (values: ColumnMap) => OperandSelect
	readonly driverHeading: Heading
	/** D's heading, which the window delivers. */
	readonly heading: Heading
	readonly origin: NameOrigin
	readonly start: WindowStart
	readonly direction: PageDirection
	/** The ORDER BY in the declared order, over a map holding the order's columns: the driver rows' or D's. */
	readonly order: (map: ColumnMap, heading: Heading) => ReadonlyArray<OrderItem>
	/** The window's size, allocated after the rows' own placeholders and before the seek's or the offset's. */
	readonly limit: () => Expr
	/** D read at each driver row's key, its key columns read through `keys`, the driver row's (semi-join readPerDrivingRow). */
	readonly rows: (keys: ColumnMap) => { readonly item: FromItem; readonly map: ColumnMap }
}

/**
 * SELECT <D's heading> FROM (SELECT <the driver's columns> FROM <S> AS s, LATERAL (<one part: pagedRows over the
 * driver's rows at s>) AS w ORDER BY <the order> LIMIT <size> [OFFSET <offset>]) AS m, LATERAL (<D at m's key>) AS d
 * ORDER BY <the order over d, reversed when backward>.
 *
 * A driven window (lower/shapes/page/driver.ts): for each row of S, the take of its driver alone at that row's prefix,
 * at most the window's size of its rows from the window's start (from the order's first row, o + k of them, past an
 * offset o), each seek and the order reading the driver's columns, which an index on the prefix's columns then the order
 * reads in order, the interval bounding its scan; then the parts' driver rows merged in the order and cut at the
 * window's size, past the offset; then D read once per kept row at its key, a LATERAL PostgreSQL never pulls up, whose
 * region's chain leads with the driver's whole key, so no row the offset skips is read past its driver's index entry.
 * Each driver row meets exactly one row of D, and the parts are disjoint
 * (driver.ts, the rule and its proof), so the window's rows are D's first `size` from its start: the first k of a
 * disjoint union lie among each part's first k. No row of D beyond the parts' takes is read, whatever the statistics
 * state; where the call's points fix the whole prefix, S is one row and the window one part.
 */
export const drivenRows = (cx: LowerContext, spec: DrivenRowsSpec): Select => {
	const rel = spec.driver(spec.values.map)
	const limit = spec.limit()
	const start = spec.start
	/** The window's offset, which each part reads past from the order's first row and the merge skips. */
	const skipped = start.kind === "offset" ? start.offset.value() : undefined
	const part = pagedRows(cx, {
		rel,
		heading: spec.driverHeading,
		origin: spec.origin,
		start: start.kind === "offset" ? edgeStart : start,
		direction: spec.direction,
		order: (map) => spec.order(map, spec.driverHeading),
		limit: skipped === undefined ? limit : binary("+", skipped, limit)
	})
	const w = cx.wrapAs(part, spec.driverHeading, spec.origin, true)
	const parts = spec.order(w.map, spec.driverHeading)
	const merged: Select = {
		...select(
			keyedSet(
				headingTargets(spec.driverHeading, w.map),
				[spec.values.item, w.item],
				undefined,
				"a driven window's merged parts"
			)
		),
		orderBy: spec.direction === "backward" ? reversedOrder(parts) : parts,
		limit,
		offset: skipped
	}
	const m = cx.wrap(merged, spec.driverHeading, spec.origin)
	const d = spec.rows(m.map)
	const declared = spec.order(d.map, spec.heading)
	return {
		...select(
			keyedSet(
				headingTargets(spec.heading, d.map),
				[m.item, d.item],
				undefined,
				"a driven window's rows"
			)
		),
		orderBy: spec.direction === "backward" ? reversedOrder(declared) : declared
	}
}

interface PagedGroup {
	readonly rows: () => Select
	readonly heading: Heading
}

interface RetainedGroupSpec {
	/**
	 * Every heading group's paged rows, each lowered by pagedRows bounded by the window's size at every call, so no name is
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
 * The rows of one heading group that a window of the union keeps (see the header):
 *
 *   SELECT <heading> FROM (<the group's first k>) AS r1(...)
 *   WHERE (SELECT count(*) FROM (<each group's first k, its comparators> UNION ALL ...) AS r2(...)
 *          WHERE <r2 precedes r1 in the fetch order>) < k
 */
export const retainedGroupRows = (cx: LowerContext, spec: RetainedGroupSpec): Select => {
	const kept = cx.wrap(spec.own.rows(), spec.own.heading, spec.origin)
	/**
	 * Each group's first k read through its comparators, which its completed order makes a key of its rows, and the
	 * discriminant among them tells the groups apart: set arms pairwise disjoint, which the count below counts.
	 */
	const union = unionAll(
		"disjoint",
		mapNonEmpty(spec.groups, (g) => {
			const source = cx.wrap(g.rows(), g.heading, spec.origin)
			return keyedSet(
				spec.comparators.map((c) => target(comparatorColumn(source.map, c))),
				[source.item],
				undefined,
				"a page group's first rows"
			)
		})
	)
	const comparatorHeading: Heading = spec.comparators.map((c) => ({ name: c.field, type: c.type }))
	const all = cx.wrap(select(union), comparatorHeading, spec.origin)
	/** Strictly before in the fetch order: before in the declared order for a forward page, after it for a backward one. */
	const precedes = seekPredicate(
		spec.comparators.map((c) => ({
			direction: c.direction,
			type: c.type,
			column: comparatorColumn(all.map, c),
			boundary: comparatorColumn(kept.map, c)
		})),
		{ side: spec.direction === "forward" ? "precedes" : "follows" },
		cx.names
	)
	const predecessors: Expr = {
		kind: "subquery",
		query: select(provedCore("oneRow", [target(countStar())], [all.item], precedes))
	}
	return select(
		provedCore(
			"keyed",
			headingTargets(spec.own.heading, kept.map),
			[kept.item],
			lt(predecessors, spec.size)
		)
	)
}

interface PositionedGroupSpec {
	/**
	 * Every heading group's first rows, each lowered by pagedRows from the order's first row and bounded by the
	 * window's reach, its offset plus its size, at every call, so no name is defined twice in the statement, and its
	 * heading.
	 */
	readonly groups: NonEmptyReadonlyArray<PagedGroup>
	/** The group whose rows of the window these are. */
	readonly own: PagedGroup
	readonly origin: NameOrigin
	readonly comparators: ReadonlyArray<PageComparator>
	readonly offset: Expr
	readonly size: Expr
}

/**
 * The rows of one heading group that a positioned window of the union holds, its rows part's and its attachments'
 * alike:
 *
 *   SELECT <heading> FROM (<the group's first o+k>) AS r1(...)
 *   WHERE EXISTS (SELECT 1 FROM (SELECT <comparators> FROM (<each group's first o+k, its comparators> UNION ALL ...)
 *                                AS r2(...) ORDER BY <the order> LIMIT k OFFSET o) AS w(...)
 *                 WHERE w.c1 = r1.c1 AND ...)
 *
 * The first n tuples of the union lie among the first n of each group, so the window's tuples, the union's [o, o+k),
 * are the [o, o+k) of the union of each group's first o+k comparator tuples, ordered by the completed order, which those
 * tuples are a key of and the discriminant among them tells the groups apart: the subquery `w`, PostgreSQL's own OFFSET
 * over that union. A group's rows of the window are its first o+k rows whose tuple `w` holds, compared at each
 * comparator's own equality (lower/conservative/context.ts equal), the equality its order ties by. Each group's part
 * delivers exactly its rows of the window, so a positioned window's groups, merged on the order, are the window, which
 * the runtime's merge and cut keep whole (union/index.ts mergeHeadingGroups). Its cost grows with its position, each
 * group's first o+k read and the union's sorted, as a positioned window's OFFSET does over one relation.
 */
export const positionedGroupRows = (cx: LowerContext, spec: PositionedGroupSpec): Select => {
	const kept = cx.wrap(spec.own.rows(), spec.own.heading, spec.origin)
	const union = unionAll(
		"disjoint",
		mapNonEmpty(spec.groups, (g) => {
			const source = cx.wrap(g.rows(), g.heading, spec.origin)
			return keyedSet(
				spec.comparators.map((c) => target(comparatorColumn(source.map, c))),
				[source.item],
				undefined,
				"a page group's first rows"
			)
		})
	)
	const comparatorHeading: Heading = spec.comparators.map((c) => ({ name: c.field, type: c.type }))
	const all = cx.wrap(select(union), comparatorHeading, spec.origin)
	const order = { keys: spec.comparators.map((c) => ({ column: c.field, dir: c.direction })) }
	const windowTuples: Select = {
		...select(
			provedCore(
				"keyed",
				spec.comparators.map((c) => target(comparatorColumn(all.map, c))),
				[all.item],
				undefined
			)
		),
		orderBy: completedOrderItems(order, comparatorHeading, all.map),
		limit: spec.size,
		offset: spec.offset
	}
	const w = cx.wrap(windowTuples, comparatorHeading, spec.origin)
	const held = exists(
		simpleSelect(
			[target(lit.int(1, types.integer))],
			[w.item],
			conjunction(
				spec.comparators.map((c) =>
					cx.equal(c.type, comparatorColumn(w.map, c), comparatorColumn(kept.map, c))
				)
			)
		)
	)
	return select(provedCore("keyed", headingTargets(spec.own.heading, kept.map), [kept.item], held))
}
