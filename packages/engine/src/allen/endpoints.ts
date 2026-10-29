import {
	type AllenMask,
	allenMaskWhere,
	allenPlaces,
	intersectMasks,
	placeOrder,
	type SpanEndpoint
} from "#compiler/allen/mask.ts"

/** The comparisons of two endpoints, by the Compute catalogue's names. */
export type EndpointComparison = "eq" | "ne" | "lt" | "le" | "gt" | "ge"

const comparisons: { readonly [C in EndpointComparison]: (order: number) => boolean } = {
	eq: (order) => order === 0,
	ne: (order) => order !== 0,
	lt: (order) => order < 0,
	le: (order) => order <= 0,
	gt: (order) => order > 0,
	ge: (order) => order >= 0
}

/**
 * The relations of (A, B) under which `x(A) cmp y(B)` holds: each relation places A's x among B's endpoints, which
 * orders it against B's y.
 */
const comparisonMask = (x: SpanEndpoint, cmp: EndpointComparison, y: SpanEndpoint): AllenMask =>
	allenMaskWhere((relation) => comparisons[cmp](placeOrder(allenPlaces[relation][x], y)))

type ComparisonMasks = {
	readonly [C in EndpointComparison]: { readonly [E in SpanEndpoint]: AllenMask }
}

const comparisonMasksOf = (x: SpanEndpoint): ComparisonMasks => {
	const against = (cmp: EndpointComparison) => ({
		lower: comparisonMask(x, cmp, "lower"),
		upper: comparisonMask(x, cmp, "upper")
	})
	return {
		eq: against("eq"),
		ne: against("ne"),
		lt: against("lt"),
		le: against("le"),
		gt: against("gt"),
		ge: against("ge")
	}
}

/** Every endpoint comparison's mask, by A's endpoint, the comparison and B's endpoint. */
const endpointMasks: { readonly [E in SpanEndpoint]: ComparisonMasks } = {
	lower: comparisonMasksOf("lower"),
	upper: comparisonMasksOf("upper")
}

/**
 * The relations of (A, B) under which `x(A) cmp y(B)` holds: an endpoint predicate as an Allen mask.
 *
 * For two nonempty half-open spans A = [a0, a1) and B = [b0, b1), the basic relation fixes the order of all four
 * endpoints (allenPlaces), so every comparison of an endpoint of A with an endpoint of B, and every membership of an
 * endpoint of A in B, holds for exactly a set of relations: a mask. A conjunction of such predicates over one ordered
 * pair is the intersection of their masks, a disjunction the union, a negation the complement, and swapping the
 * operands is the converse. Each mask is read off the relations' places, the one definition the range operators' masks
 * and so the offline table derive from too; none restates a relation.
 *
 * The masks hold only where neither span is empty or unbounded: lower() of an empty range is NULL where a range
 * operator answers it, and an unbounded endpoint is NULL. A grizzle span is neither, and no grizzle expression is NULL.
 */
export const endpointMask = (
	x: SpanEndpoint,
	cmp: EndpointComparison,
	y: SpanEndpoint
): AllenMask => endpointMasks[x][cmp][y]

/**
 * The relations of (A, B) under which B holds A's endpoint x as a point, `B @> x(A)` (r.pointIn(x(A), B)): b0 <= x(A)
 * and x(A) < b1, B being half-open.
 */
const pointInMasks: { readonly [E in SpanEndpoint]: AllenMask } = {
	lower: intersectMasks(endpointMask("lower", "ge", "lower"), endpointMask("lower", "lt", "upper")),
	upper: intersectMasks(endpointMask("upper", "ge", "lower"), endpointMask("upper", "lt", "upper"))
}

export const pointInMask = (x: SpanEndpoint): AllenMask => pointInMasks[x]
