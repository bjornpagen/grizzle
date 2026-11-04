import { appendNonEmpty, isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { PageFill } from "#compiler/ir/products.ts"
import type { CompletedOrder, Heading, OrderKey } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	type ColumnMap,
	columnIn,
	columnType,
	type StatementParams
} from "#compiler/lower/conservative/context.ts"
import type { PageParamSlot } from "#compiler/lower/conservative/types.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import type { Expr, OrderItem, TypeRef } from "#compiler/sql/ast.ts"
import { and, asc, binary, desc, eq, lit, or, row, slotParam, types } from "#compiler/sql/build.ts"

/**
 * The four request shapes: { first }, { first, after }, { last }, { last, before }. Each is its own
 * compiled variant, so no variant has a nullable cursor slot.
 */
const pageVariants = ["first", "after", "last", "before"] as const
export type PageVariant = (typeof pageVariants)[number]

/** The order a variant fetches in: the declared order for first and after, every direction reversed for last and before. */
export type PageDirection = "forward" | "backward"

export const variantDirection = (variant: PageVariant): PageDirection =>
	variant === "first" || variant === "after" ? "forward" : "backward"

/**
 * The bounded existence probes of the opposite flag: whether D holds a tuple at or before, or at or after, the request's
 * anchor. The anchor alone decides the flag, so the probe needs no delivered row:
 *
 * Write A for the anchor, < for the declared order, which is total on D's comparison tuples, and E for the page's first
 * edge, the least t of D with A < t. For an after request, hasPreviousPage is "some t of D has t < E". If t < E, then
 * not A < t, since E is the least tuple of D after A; so t <= A, the order being total. If t <= A, then t < E, since
 * A < E. So "some t of D has t < E" is exactly "some t of D has t <= A", the atOrBefore probe on the anchor. An empty
 * page has no E, and every t of D has t <= A, so its flag is the same probe. A before request is the mirror image:
 * hasNextPage is the atOrAfter probe on the anchor. The anchor need not be a tuple of D.
 */
export const probeKinds = ["atOrBefore", "atOrAfter"] as const
export type ProbeKind = (typeof probeKinds)[number]

/**
 * Which side of the boundary a predicate selects, and whether the boundary tuple itself qualifies.
 *
 * The seek of a keyset page.
 *
 * A cursor names a strict boundary in the completed total order (k1, ..., km) with directions d1, ..., dm. "After c" is
 * lexicographically later in the declared order:
 *
 *   (k1 follows c1) OR (k1 = c1 AND k2 follows c2) OR ... OR (k1 = c1 AND ... AND k(m-1) = c(m-1) AND km follows cm)
 *
 * where follows is native > for an ascending key and native < for a descending one; "before c" reverses every
 * inequality. Every comparison is between non-null values, so the predicate is a plain
 * Boolean with no NULL branch.
 *
 * When every key has the same direction, the predicate is the equivalent native row comparison, `(k1, ..., km) >
 * (c1, ..., cm)` for ascending keys and `<` for descending ones: PostgreSQL turns a row comparison into an index
 * condition, while it applies the OR expansion as a filter over the index prefix, discarding every entry before the
 * boundary. A single key is the plain comparison. Mixed directions keep the
 * expansion: a row comparison compares every member with one operator, so it cannot express them, and no
 * arithmetic negation fakes a reversed key.
 *
 * The inclusive forms "at or after c" and "at or before c" serve the flags of an empty page: the strict
 * predicate or the whole tuple equal, as one native row comparison `>=` / `<=` when the directions agree. The
 * zero-column relation orders by the empty comparison tuple: nothing is strictly after or before it, and
 * it is at or after itself.
 *
 * Each boundary value is one placeholder, cast to its comparator's base type: a comparison parameter casts to the base
 * type, so the indexed column is never cast, and a contract field
 * compares as its base. The values are the cursor's canonical parameter-codec texts, bound byte for byte as captured.
 */
export interface Seek {
	readonly side: "follows" | "precedes"
	readonly inclusive: boolean
}

/** The seek of a variant: none for an anchorless request. */
export const variantSeek = (variant: PageVariant): Seek | undefined => {
	switch (variant) {
		case "first":
		case "last":
			return undefined
		case "after":
			return { side: "follows", inclusive: false }
		case "before":
			return { side: "precedes", inclusive: false }
	}
}

export const probeSeek = (kind: ProbeKind): Seek => {
	switch (kind) {
		case "atOrBefore":
			return { side: "precedes", inclusive: true }
		case "atOrAfter":
			return { side: "follows", inclusive: true }
	}
}

/**
 * One position of the completed order as a cursor compares it: a field of the delivered heading, its direction, and
 * its type (the shape codec/cursor's CursorComparator reads).
 */
export interface PageComparator {
	readonly field: string
	readonly direction: "asc" | "desc"
	readonly type: ScalarType
}

/**
 * The comparators of a completed order over a delivered heading: exactly its keys, in order. The completion made the
 * order total on the result (logical/order.ts), so these keys identify a tuple and are the whole cursor
 * tuple; ORDER BY columns a lowering appends where the physical facts do not prove the keys total never break a tie
 * among them.
 */
export const pageComparators = (
	order: CompletedOrder,
	heading: Heading
): ReadonlyArray<PageComparator> =>
	order.keys.map((k: OrderKey) => ({
		field: k.column,
		direction: k.dir,
		type: columnType(heading, k.column)
	}))

/**
 * The page placeholders of one statement, allocated into that statement's parameter list after its own parameters, in
 * first-use order, each used as often as the predicate needs (one placeholder per boundary value). It holds the
 * statement's placeholders (its delivery's params once the statement began), so every placeholder it allocates is that
 * statement's. Each placeholder is a page fill its statement's parameters record: limit, size, or a comparator's
 * boundary.
 */
export class PageSlots {
	readonly #params: StatementParams<PageParamSlot>
	readonly #typeRef: (t: ScalarType) => TypeRef
	readonly #comparators: ReadonlyArray<PageComparator>
	#boundaries:
		| ReadonlyArray<{ readonly comparator: PageComparator; readonly boundary: Expr }>
		| undefined
	#limit: Expr | undefined
	#size: Expr | undefined

	constructor(
		params: StatementParams<PageParamSlot>,
		typeRef: (t: ScalarType) => TypeRef,
		comparators: ReadonlyArray<PageComparator>
	) {
		this.#params = params
		this.#typeRef = typeRef
		this.#comparators = comparators
	}

	/** The limit placeholder, `$n::integer`. */
	limit(): Expr {
		this.#limit ??= this.#fill({ kind: "limit" }, plainType("int4"), types.integer)
		return this.#limit
	}

	/** The size placeholder, `$n::integer`: the most rows the page delivers. */
	size(): Expr {
		this.#size ??= this.#fill({ kind: "size" }, plainType("int4"), types.integer)
		return this.#size
	}

	/** A new placeholder the page request fills with `fill`, cast to `sqlType`. */
	#fill(fill: PageFill, type: ScalarType, sqlType: TypeRef): Expr {
		const slot = this.#params.own((number): PageParamSlot => ({
			kind: "page",
			placeholder: "value",
			number,
			fill,
			type,
			sqlType
		}))
		return slotParam(slot, sqlType)
	}

	/**
	 * The seek keys over the delivered columns `map`: each comparator's column against its boundary value, one
	 * placeholder cast to the comparator's base type. The first seek allocates the placeholders, in comparator order,
	 * and every later seek of the statement reads the same ones.
	 */
	seekKeys(map: ColumnMap): ReadonlyArray<SeekKey> {
		this.#boundaries ??= this.#comparators.map((comparator, position) => ({
			comparator,
			boundary: this.#fill(
				{ kind: "boundary", position, field: comparator.field },
				comparator.type,
				this.#typeRef(comparator.type)
			)
		}))
		return this.#boundaries.map(({ comparator, boundary }) => ({
			direction: comparator.direction,
			column: comparatorColumn(map, comparator),
			boundary
		}))
	}
}

/**
 * One position of a seek: its direction, the delivered column it reads, and the boundary value it compares that
 * column against.
 */
export interface SeekKey {
	readonly direction: "asc" | "desc"
	readonly column: Expr
	readonly boundary: Expr
}

/** The delivered column of `map` a comparator reads. */
export const comparatorColumn = (map: ColumnMap, comparator: PageComparator): Expr =>
	columnIn(map, comparator.field)

/** Whether a seek on these keys is one native row comparison: every key in one direction. */
const isRowSeek = (keys: ReadonlyArray<{ readonly direction: "asc" | "desc" }>): boolean =>
	keys.length > 0 && keys.every((k) => k.direction === keys[0]?.direction)

/** The operator by which a key on `side` of its boundary value compares, strictly or inclusively. */
const operator = (direction: "asc" | "desc", seek: Seek): ">" | "<" | ">=" | "<=" => {
	const greater = (direction === "asc") === (seek.side === "follows")
	return greater ? (seek.inclusive ? ">=" : ">") : seek.inclusive ? "<=" : "<"
}

/**
 * The seek predicate of `keys` against their boundary values; undefined when every tuple qualifies (the inclusive seek
 * of the empty comparison tuple).
 */
export const seekPredicate = (keys: ReadonlyArray<SeekKey>, seek: Seek): Expr | undefined => {
	if (!isNonEmpty(keys)) {
		return seek.inclusive ? undefined : lit.bool(false)
	}
	const [first] = keys
	if (isRowSeek(keys)) {
		const op = operator(first.direction, seek)
		if (keys.length === 1) {
			return binary(op, first.column, first.boundary)
		}
		return binary(
			op,
			row(mapNonEmpty(keys, (k) => k.column)),
			row(mapNonEmpty(keys, (k) => k.boundary))
		)
	}
	const equal = (k: SeekKey): Expr => eq(k.column, k.boundary)
	const terms = mapNonEmpty(keys, (k, j) =>
		and(
			appendNonEmpty(
				keys.slice(0, j).map(equal),
				binary(operator(k.direction, { side: seek.side, inclusive: false }), k.column, k.boundary)
			)
		)
	)
	return or(seek.inclusive ? appendNonEmpty(terms, and(mapNonEmpty(keys, equal))) : terms)
}

/** ORDER BY items with every direction reversed: last and before reverse every sort direction. */
export const reversedOrder = (items: ReadonlyArray<OrderItem>): ReadonlyArray<OrderItem> =>
	items.map((item) => (item.direction === "DESC" ? asc(item.expr) : desc(item.expr)))

/**
 * A completed order with every direction reversed: the fetch order of a backward variant, which a heading-group merge
 * reads.
 */
export const reversedCompletedOrder = (order: CompletedOrder): CompletedOrder => ({
	keys: order.keys.map((k) => ({ column: k.column, dir: k.dir === "asc" ? "desc" : "asc" }))
})
