import { rangeOperatorCodes, rangeOperatorMasks } from "#compiler/allen/atoms.ts"
import { type EndpointComparison, endpointMask, pointInMask } from "#compiler/allen/endpoints.ts"
import { allenForm, buildFormula } from "#compiler/allen/lower.ts"
import {
	type AllenMask,
	complementMask,
	converseMask,
	intersectMasks,
	type SpanEndpoint,
	uniteMasks
} from "#compiler/allen/mask.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import type { DefinedOp, ExprSpec, ScalarExpr } from "#compiler/ir/expr.ts"
import { type ScalarType, type SpanCarrier, spanCarrierOf } from "#compiler/ir/scalar.ts"
import { connectiveOps, definedRangeOp, nativeOp } from "#compiler/scalar/compute/registry.ts"

/**
 * What a span operand denotes: a column of a node, a parameter, a literal span, or any other span expression by its
 * own label.
 */
type SpanOperand =
	| { readonly kind: "column"; readonly node: NodeId; readonly name: string }
	| { readonly kind: "param"; readonly param: ParamId }
	| { readonly kind: "literal"; readonly start: bigint; readonly end: bigint }
	| { readonly kind: "expr"; readonly expr: ScalarExpr }

const operandOf = (e: ScalarExpr): SpanOperand => {
	switch (e.kind) {
		case "column":
			return { kind: "column", node: e.column.node, name: e.column.name }
		case "param":
			return { kind: "param", param: e.param }
		case "literal":
			return e.value.kind === "span"
				? { kind: "literal", start: e.value.start, end: e.value.end }
				: { kind: "expr", expr: e }
		case "value":
		case "op":
		case "cast":
		case "domainCast":
		case "cond":
			return { kind: "expr", expr: e }
	}
}

const sameOperand = (x: SpanOperand, y: SpanOperand): boolean => {
	switch (x.kind) {
		case "column":
			return y.kind === "column" && x.node === y.node && x.name === y.name
		case "param":
			return y.kind === "param" && x.param === y.param
		case "literal":
			return y.kind === "literal" && x.start === y.start && x.end === y.end
		case "expr":
			return y.kind === "expr" && x.expr.id === y.expr.id
	}
}

/** A span-valued expression: the expression, what it denotes, and its range carrier. */
export interface Span {
	readonly expr: ScalarExpr
	readonly operand: SpanOperand
	readonly carrier: SpanCarrier
}

/**
 * A predicate over one pair of distinct spans of one carrier: the relations of (a, b) it holds for, and whether it
 * states an endpoint comparison or membership, which an Allen formula's range operators never do.
 */
export interface PairPredicate {
	readonly a: Span
	readonly b: Span
	readonly mask: AllenMask
	readonly endpoint: boolean
}

/** Whether two predicates are over one unordered pair. */
export const samePair = (p: PairPredicate, q: PairPredicate): boolean =>
	(sameOperand(p.a.operand, q.a.operand) && sameOperand(p.b.operand, q.b.operand)) ||
	(sameOperand(p.a.operand, q.b.operand) && sameOperand(p.b.operand, q.a.operand))

/** The predicate over (a, b), or undefined where the two are one span or of two carriers. */
const pairOver = (
	a: Span,
	b: Span,
	mask: AllenMask,
	endpoint: boolean
): PairPredicate | undefined =>
	sameOperand(a.operand, b.operand) || a.carrier !== b.carrier
		? undefined
		: { a, b, mask, endpoint }

/** How a connective joins the masks of its operands over one pair. */
export type PairJoin = "and" | "or"

const joins: { readonly [J in PairJoin]: (x: AllenMask, y: AllenMask) => AllenMask } = {
	and: intersectMasks,
	or: uniteMasks
}

/**
 * Predicates over one pair as the one predicate their conjunction or disjunction is, each joined under its mask over
 * the first one's orientation; undefined unless every part is over the first one's pair.
 */
export const joinedPairs = (
	parts: ReadonlyArray<PairPredicate | undefined>,
	join: PairJoin
): PairPredicate | undefined => {
	const [first, ...rest] = parts
	if (first === undefined) {
		return undefined
	}
	let mask = first.mask
	let endpoint = first.endpoint
	for (const part of rest) {
		if (part === undefined || !samePair(first, part)) {
			return undefined
		}
		mask = joins[join](
			mask,
			sameOperand(first.a.operand, part.a.operand) ? part.mask : converseMask(part.mask)
		)
		endpoint = endpoint || part.endpoint
	}
	return { a: first.a, b: first.b, mask, endpoint }
}

/** The Compute catalogue's comparisons, by their native function. */
const endpointComparisons: ReadonlyMap<string, EndpointComparison> = new Map(
	(["eq", "ne", "lt", "le", "gt", "ge"] as const).map((c) => [c, c])
)

/**
 * The Allen reading of expressions: each predicate read once, its reading kept for the life of the reading, keyed by the
 * expression itself (traversal state of one reader, as a walk's seen-set is).
 */
export class AllenReading {
	readonly #pairs = new Map<ScalarExpr, PairPredicate | undefined>()

	#span(e: ScalarExpr): Span | undefined {
		const carrier = spanCarrierOf(e.type)
		return carrier === undefined ? undefined : { expr: e, operand: operandOf(e), carrier }
	}

	/** The span and endpoint `Compute.lower(s)` or `Compute.upper(s)` reads, or undefined for any other expression. */
	#endpoint(e: ScalarExpr): { readonly span: Span; readonly endpoint: SpanEndpoint } | undefined {
		if (e.kind !== "op" || typeof e.op === "string") {
			return undefined
		}
		const endpoint: SpanEndpoint | undefined =
			e.op.code === "lower(anyrange)"
				? "lower"
				: e.op.code === "upper(anyrange)"
					? "upper"
					: undefined
		const [arg] = e.args
		if (endpoint === undefined || arg === undefined) {
			return undefined
		}
		const span = this.#span(arg)
		return span === undefined ? undefined : { span, endpoint }
	}

	/**
	 * A predicate that compares endpoints of two spans, tests one span's endpoint as a point of another, or is a range
	 * operator of an Allen formula between two spans; undefined for any other expression.
	 */
	leaf(e: ScalarExpr): PairPredicate | undefined {
		if (e.kind !== "op") {
			return undefined
		}
		const [l, r] = e.args
		if (l === undefined || r === undefined) {
			return undefined
		}
		if (typeof e.op !== "string") {
			if (e.op.code === "range_contains_elem") {
				const span = this.#span(l)
				const point = this.#endpoint(r)
				return span === undefined || point === undefined
					? undefined
					: pairOver(point.span, span, pointInMask(point.endpoint), true)
			}
			const holds = rangeOperatorMasks.get(e.op.code)
			const a = this.#span(l)
			const b = this.#span(r)
			return holds === undefined || a === undefined || b === undefined
				? undefined
				: pairOver(a, b, holds, false)
		}
		const fn = nativeOp(e.op)?.fn
		const comparison = fn === undefined ? undefined : endpointComparisons.get(fn)
		if (comparison === undefined) {
			return undefined
		}
		const x = this.#endpoint(l)
		const y = this.#endpoint(r)
		return x === undefined || y === undefined
			? undefined
			: pairOver(x.span, y.span, endpointMask(x.endpoint, comparison, y.endpoint), true)
	}

	/**
	 * What predicate `e` is over one pair: a leaf, or a negation, conjunction or disjunction of predicates over one
	 * pair; undefined for any other expression.
	 */
	pair(e: ScalarExpr): PairPredicate | undefined {
		if (this.#pairs.has(e)) {
			return this.#pairs.get(e)
		}
		const out = this.#pairOf(e)
		this.#pairs.set(e, out)
		return out
	}

	#pairOf(e: ScalarExpr): PairPredicate | undefined {
		if (e.kind !== "op") {
			return undefined
		}
		const fn = nativeOp(e.op)?.fn
		if (fn === "not") {
			const [arg] = e.args
			const inner = arg === undefined ? undefined : this.pair(arg)
			return inner === undefined ? undefined : { ...inner, mask: complementMask(inner.mask) }
		}
		if (fn === "and" || fn === "or") {
			return joinedPairs(
				e.args.map((a) => this.pair(a)),
				fn
			)
		}
		return this.leaf(e)
	}
}

/** Whether B holds A's lower or upper endpoint under every relation of `mask`. */
const holds = (mask: AllenMask): boolean =>
	(mask & ~pointInMask("lower")) === 0 || (mask & ~pointInMask("upper")) === 0

/**
 * The span of the pair that holds a point the other span gives, where the mask says so: B holds A's lower or upper
 * endpoint under every relation of the mask, or A holds one of B's. Undefined where neither does.
 */
export const pointHolder = (
	p: PairPredicate
): { readonly span: Span; readonly by: Span } | undefined => {
	if (holds(p.mask)) {
		return { span: p.b, by: p.a }
	}
	if (holds(converseMask(p.mask))) {
		return { span: p.a, by: p.b }
	}
	return undefined
}

/**
 * The Allen reading of the IR's span predicates, and the IR's one spelling of an Allen mask.
 *
 * For two nonempty half-open spans the thirteen basic relations fix the order of all four endpoints, so a comparison of
 * an endpoint of A with an endpoint of B (eq, ne, lt, le, gt, ge) and the membership of an endpoint of A in B
 * (r.pointIn(Compute.lower(a), b)) each hold for exactly a mask of relations (allen/endpoints.ts), as does each range
 * operator of an Allen formula between A and B (allen/atoms.ts). Over one pair a conjunction is the intersection of its
 * parts' masks, a disjunction their union and a negation the complement, and a part that states the pair B first
 * joins under its mask's converse. A predicate over one pair of spans is its mask, whichever way it was written: the
 * optimizer writes it as the mask's table formula (lower/optimize/simplify/allen.ts), and the physical analysis reads
 * from the mask whether one span holds a point of the other (analysis/physical/rules.ts).
 *
 * The reading rests on the span types' invariant: every value of a span type is a nonempty bounded half-open range
 * (ir/scalar.ts SpanType), and no grizzle expression is NULL (each carries its non-null proof), so on every row a
 * predicate and its mask's formula agree. lower() of an empty range is NULL where a range operator answers it, and an
 * unbounded endpoint is NULL; neither is a grizzle value.
 *
 * A pair's two spans are distinct operands of one carrier: two references to one column of one node, to one parameter
 * or to one literal span are one operand, and any other span expression is itself. A predicate over one span
 * (lower(a) < upper(a)) is over no pair.
 *
 * It lives with the checker, which spells r.allen through allenExpr first; the physical analysis and the optimizer,
 * the layers above it, read the spelling back.
 *
 * The IR's spelling of a mask of (a, b) as a predicate of type `bool`, each entry made by `emit`: the false literal
 * for the empty mask, the true literal for the full one, and otherwise its table formula, each literal one range
 * operator node negated by NOT, joined by the connectives `and` and `or`. The checker's r.allen and the optimizer's
 * normal form both spell masks so.
 */
export const allenExpr = (
	mask: AllenMask,
	a: ScalarExpr,
	b: ScalarExpr,
	carrier: SpanCarrier,
	bool: ScalarType,
	emit: (spec: ExprSpec) => ScalarExpr
): ScalarExpr => {
	const form = allenForm(mask)
	switch (form.kind) {
		case "never":
		case "always":
			return emit({
				kind: "literal",
				value: { kind: "bool", value: form.kind === "always" },
				args: [],
				type: bool,
				nonNull: "literal"
			})
		case "formula": {
			const node = (op: DefinedOp, args: ReadonlyArray<ScalarExpr>): ScalarExpr =>
				emit({
					kind: "op",
					op,
					args,
					type: bool,
					nonNull: "strict",
					volatility: "immutable"
				})
			return buildFormula(form.formula, a, b, {
				literal: (op, negated, first, second) => {
					const positive = node(definedRangeOp(rangeOperatorCodes[op], carrier), [first, second])
					return negated ? node(connectiveOps.not, [positive]) : positive
				},
				and: (parts) => node(connectiveOps.and, parts),
				or: (parts) => node(connectiveOps.or, parts)
			})
		}
	}
}
