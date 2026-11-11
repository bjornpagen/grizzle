import { appendNonEmpty, isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { type Direction, opposite } from "#compiler/core/order.ts"
import { type OperatorNames, operatorSchemaOf, typedCompare } from "#compiler/ir/compare.ts"
import type { PageFill, SizeFill } from "#compiler/ir/products.ts"
import type { CompletedOrder, Heading, OrderKey } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	type ColumnMap,
	columnIn,
	type StatementParams
} from "#compiler/lower/conservative/context.ts"
import type { PageParamSlot } from "#compiler/lower/conservative/types.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type { Expr, OrderItem, TypeRef } from "#compiler/sql/ast.ts"
import { and, asc, binary, desc, lit, or, row, slotParam, types } from "#compiler/sql/build.ts"

/**
 * The four window templates, one per anchor kind: first (start), after (after a key), last (end), before (before a
 * key). Each is its own compiled variant, so no variant has a nullable boundary slot.
 */
const pageVariants = ["first", "after", "last", "before"] as const
export type PageVariant = (typeof pageVariants)[number]

/** The windows of no anchor, whose statements seek nothing. */
export type PlainVariant = Extract<PageVariant, "first" | "last">

/** The windows anchored at a key, whose statements seek past it. */
export type AnchoredVariant = Exclude<PageVariant, PlainVariant>

/**
 * The page fills a variant's statements hold: a plain window's are its size alone, so no binding of one reads a
 * boundary; an anchored window's are its size and its comparators' boundaries.
 */
export interface VariantFill {
	readonly first: SizeFill
	readonly after: PageFill
	readonly last: SizeFill
	readonly before: PageFill
}

/** The order a variant fetches in: the declared order for first and after, every direction reversed for last and before. */
export type PageDirection = "forward" | "backward"

export const variantDirection = (variant: PageVariant): PageDirection =>
	variant === "first" || variant === "after" ? "forward" : "backward"

/**
 * Which side of the boundary a predicate selects; the boundary tuple itself never qualifies.
 *
 * The seek of a keyset window.
 *
 * An anchor's key names a strict boundary in the completed total order (k1, ..., km) with directions d1, ..., dm.
 * "After c" is lexicographically later in the declared order:
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
 * Every comparison is at the operator its key's type resolves (ir/compare.ts typedCompare): over a vector the
 * extension's qualified operator, since a role's search_path never holds the extension schema. A row comparison
 * resolves each member's operator by name, so a tuple that holds a key of a qualified operator keeps the expansion.
 *
 * The zero-column relation orders by the empty comparison tuple: nothing is strictly after or before it.
 *
 * Each boundary value is one placeholder, cast to its comparator's base type: a comparison parameter casts to the base
 * type, so the indexed column is never cast, and a contract field compares as its base. The values are the anchor key's
 * values as their comparators' codecs write them (adapter/page/window.ts).
 */
export interface Seek {
	readonly side: "follows" | "precedes"
}

/** The seek of an anchored window: strictly past its anchor in its fetch direction. */
export const anchoredSeek = (variant: AnchoredVariant): Seek => {
	switch (variant) {
		case "after":
			return { side: "follows" }
		case "before":
			return { side: "precedes" }
	}
}

/**
 * One position of the completed order as a window's anchor compares it: a field of the delivered heading, its
 * direction, and its type, whose codec writes the anchor key's value at that position.
 */
export interface PageComparator {
	readonly field: string
	readonly direction: Direction
	readonly type: ScalarType
}

/**
 * The comparators of a completed order over a delivered heading: exactly its keys, in order. The completion made the
 * order total on the result (logical/order.ts), so these keys identify a tuple and are a row's whole key; ORDER BY
 * columns a lowering appends where the physical facts do not prove the keys total never break a tie among them.
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

/** A new placeholder of `params` the window fills with `fill`, cast to `sqlType`. */
const pageParam = <F extends PageFill>(
	params: StatementParams<PageParamSlot<F>>,
	fill: F,
	sqlType: TypeRef
): Expr =>
	slotParam(
		params.own((number): PageParamSlot<F> => ({
			kind: "page",
			placeholder: "value",
			number,
			fill
		})),
		sqlType
	)

/**
 * The size placeholder of one statement, allocated into that statement's parameter list (its delivery's params once the
 * statement began) by `allocate` at its first use, after the statement's own parameters, and read by every later one:
 * every window's statement holds it, a plain window's alone.
 */
class SizeSlots {
	readonly #allocate: (fill: SizeFill) => Expr
	#size: Expr | undefined

	constructor(allocate: (fill: SizeFill) => Expr) {
		this.#allocate = allocate
	}

	/**
	 * The size placeholder, `$n::bigint`: the most rows the window delivers, its rows statement's LIMIT and its
	 * attachments' bound alike. A window's size is any safe integer of at least 1, a bigint value, which LIMIT takes.
	 */
	size(): Expr {
		this.#size ??= this.#allocate({ kind: "size" })
		return this.#size
	}
}

/**
 * The boundary placeholders of an anchored window's statement, one per comparator, each cast to its
 * comparator's base type: the first seek allocates them into the statement's parameter list, in comparator order, and
 * every later seek of the statement reads the same ones.
 */
class BoundarySlots {
	readonly #params: StatementParams<PageParamSlot>
	readonly #typeRef: (t: ScalarType) => TypeRef
	readonly #comparators: ReadonlyArray<PageComparator>
	#boundaries:
		| ReadonlyArray<{ readonly comparator: PageComparator; readonly boundary: Expr }>
		| undefined

	constructor(
		params: StatementParams<PageParamSlot>,
		typeRef: (t: ScalarType) => TypeRef,
		comparators: ReadonlyArray<PageComparator>
	) {
		this.#params = params
		this.#typeRef = typeRef
		this.#comparators = comparators
	}

	/** The seek keys over the delivered columns `map`: each comparator's column against its boundary value. */
	seekKeys(map: ColumnMap): ReadonlyArray<SeekKey> {
		this.#boundaries ??= this.#comparators.map((comparator, position) => ({
			comparator,
			boundary: pageParam(
				this.#params,
				{ kind: "boundary", position, field: comparator.field },
				this.#typeRef(comparator.type)
			)
		}))
		return this.#boundaries.map(({ comparator, boundary }) => ({
			direction: comparator.direction,
			type: comparator.type,
			column: comparatorColumn(map, comparator),
			boundary
		}))
	}
}

/** An anchored statement's seek and the boundary placeholders it compares against. */
export interface Anchor {
	readonly seek: Seek
	readonly boundaries: BoundarySlots
}

/** A window statement's page placeholders: its size, and, for an anchored window, its anchor. */
export interface RequestSlots {
	readonly sizes: SizeSlots
	readonly anchor: Anchor | undefined
}

/** A plain window's statement's page placeholders over its parameter list `params`: its size alone. */
export const plainSlots = (params: StatementParams<PageParamSlot<SizeFill>>): RequestSlots => ({
	sizes: new SizeSlots((fill) => pageParam(params, fill, types.bigint)),
	anchor: undefined
})

/**
 * An anchored window's statement's page placeholders over its parameter list `params`: its size, and its seek `seek`
 * against one boundary per comparator, typed by `typeRef`.
 */
export const anchoredSlots = (
	params: StatementParams<PageParamSlot>,
	typeRef: (t: ScalarType) => TypeRef,
	comparators: ReadonlyArray<PageComparator>,
	seek: Seek
): RequestSlots & { readonly anchor: Anchor } => ({
	sizes: new SizeSlots((fill) => pageParam(params, fill, types.bigint)),
	anchor: { seek, boundaries: new BoundarySlots(params, typeRef, comparators) }
})

/**
 * One position of a seek: its direction, its comparator's type, the delivered column it reads, and the boundary value
 * it compares that column against.
 */
export interface SeekKey {
	readonly direction: Direction
	readonly type: ScalarType
	readonly column: Expr
	readonly boundary: Expr
}

/** The delivered column of `map` a comparator reads. */
export const comparatorColumn = (map: ColumnMap, comparator: PageComparator): Expr =>
	columnIn(map, comparator.field)

/** Whether a seek on these keys is one native row comparison: every key in one direction, and every key's operators
 * builtin, which a row comparison resolves by name. */
const isRowSeek = (keys: ReadonlyArray<SeekKey>, names: OperatorNames): boolean =>
	keys.every(
		(k) => k.direction === keys[0]?.direction && operatorSchemaOf(names, k.type) === undefined
	)

/** The operator by which a key strictly on `side` of its boundary value compares. */
const operator = (direction: Direction, seek: Seek): ">" | "<" =>
	(direction === "asc") === (seek.side === "follows") ? ">" : "<"

/**
 * The seek predicate of `keys` against their boundary values: false over the empty comparison tuple, which no tuple
 * strictly follows or precedes.
 */
export const seekPredicate = (
	keys: ReadonlyArray<SeekKey>,
	seek: Seek,
	names: OperatorNames
): Expr => {
	if (!isNonEmpty(keys)) {
		return lit.bool(false)
	}
	const [first] = keys
	const compare = (op: ">" | "<" | "=", k: SeekKey): Expr =>
		typedCompare(op, k.type, k.column, k.boundary, names)
	if (keys.length === 1) {
		return compare(operator(first.direction, seek), first)
	}
	if (isRowSeek(keys, names)) {
		return binary(
			operator(first.direction, seek),
			row(mapNonEmpty(keys, (k) => k.column)),
			row(mapNonEmpty(keys, (k) => k.boundary))
		)
	}
	const equal = (k: SeekKey): Expr => compare("=", k)
	return or(
		mapNonEmpty(keys, (k, j) =>
			and(appendNonEmpty(keys.slice(0, j).map(equal), compare(operator(k.direction, seek), k)))
		)
	)
}

/** ORDER BY items with every direction reversed: last and before reverse every sort direction. */
export const reversedOrder = (items: ReadonlyArray<OrderItem>): ReadonlyArray<OrderItem> =>
	items.map((item) => (item.direction === "DESC" ? asc(item.expr) : desc(item.expr)))

/**
 * A completed order with every direction reversed: the fetch order of a backward variant, which a heading-group merge
 * reads.
 */
export const reversedCompletedOrder = (order: CompletedOrder): CompletedOrder => ({
	keys: order.keys.map((k) => ({ column: k.column, dir: opposite(k.dir) }))
})
