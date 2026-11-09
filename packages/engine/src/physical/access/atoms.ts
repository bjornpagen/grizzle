import type { NodeId } from "#compiler/core/ids.ts"
import type { RangeOpCode, ScalarExpr } from "#compiler/ir/expr.ts"
import { baseOf, isSpanCarrier } from "#compiler/ir/scalar.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

export type Atom =
	| { readonly kind: "eq"; readonly column: string; readonly with: "fixed" | "literal" }
	| { readonly kind: "range"; readonly column: string; readonly bound: "lower" | "upper" }
	| { readonly kind: "span"; readonly column: string }
	| { readonly kind: "pairEq"; readonly a: string; readonly b: string }
	| { readonly kind: "pairRange"; readonly column: string; readonly other: string }
	| { readonly kind: "pairSpan"; readonly column: string; readonly other: string }

type Operand =
	| { readonly kind: "column"; readonly name: string; readonly span: boolean }
	| { readonly kind: "fixed" }
	| { readonly kind: "literal" }
	| { readonly kind: "computed" }

/** The identity of an atom: its kind and fields joined by NUL, which no column name holds. */
export const atomKey = (a: Atom): string => {
	switch (a.kind) {
		case "eq":
			return `eq\u0000${a.column}\u0000${a.with}`
		case "range":
			return `range\u0000${a.column}\u0000${a.bound}`
		case "span":
			return `span\u0000${a.column}`
		case "pairEq":
			return `pairEq\u0000${a.a}\u0000${a.b}`
		case "pairRange":
			return `pairRange\u0000${a.column}\u0000${a.other}`
		case "pairSpan":
			return `pairSpan\u0000${a.column}\u0000${a.other}`
	}
}

/** The range operators of the Allen atoms but equality, by their implementing function. Every one is a member of GiST's
 * range_ops operator class, as is pointIn's. */
const spanOperatorCodes: ReadonlySet<RangeOpCode> = new Set([
	"range_overlaps",
	"range_contains",
	"range_contained_by",
	"range_before",
	"range_after",
	"range_overleft",
	"range_overright",
	"range_adjacent"
])

const isSpanType = (e: ScalarExpr): boolean => {
	const c = baseOf(e.type).carrier
	return isSpanCarrier(c)
}

/** What the expression `e` is relative to the local node, which its column references name by its label. A cast of a parameter, or an operation over parameters and outer values,
 * is fixed; an expression reading a local column through anything but a plain reference is computed, which is not what
 * an index key holds. */
export const operandOf = (local: NodeId, e: ScalarExpr): Operand => {
	switch (e.kind) {
		case "column":
			return e.column.node === local
				? { kind: "column", name: e.column.name, span: isSpanType(e) }
				: { kind: "fixed" }
		case "param":
			return { kind: "fixed" }
		case "literal":
			return { kind: "literal" }
		case "value":
			return { kind: "computed" }
		case "op":
		case "cast":
		case "domainCast":
		case "cond":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			if (e.deps.nodes.includes(local)) {
				return { kind: "computed" }
			}
			return e.deps.params.length === 0 && e.deps.nodes.length === 0
				? { kind: "literal" }
				: { kind: "fixed" }
	}
}

const flip = { lt: "gt", le: "ge", gt: "lt", ge: "le" } as const

const comparisonAtoms = (
	fn: "eq" | "lt" | "le" | "gt" | "ge",
	l: Operand,
	r: Operand
): ReadonlyArray<Atom> => {
	if (l.kind !== "column" && r.kind === "column") {
		return comparisonAtoms(fn === "eq" ? "eq" : flip[fn], r, l)
	}
	if (l.kind !== "column") {
		return []
	}
	if (r.kind === "column") {
		if (r.name === l.name) {
			return []
		}
		if (fn === "eq") {
			return [{ kind: "pairEq", a: l.name, b: r.name }]
		}
		if (l.span || r.span) {
			return []
		}
		return [
			{ kind: "pairRange", column: l.name, other: r.name },
			{ kind: "pairRange", column: r.name, other: l.name }
		]
	}
	if (r.kind === "computed") {
		return []
	}
	if (fn === "eq") {
		const eq: Atom = {
			kind: "eq",
			column: l.name,
			with: r.kind === "literal" ? "literal" : "fixed"
		}
		return l.span && r.kind === "fixed" ? [eq, { kind: "span", column: l.name }] : [eq]
	}
	if (r.kind === "literal" || l.span) {
		return []
	}
	return [{ kind: "range", column: l.name, bound: fn === "lt" || fn === "le" ? "upper" : "lower" }]
}

const spanAtoms = (span: Operand, other: Operand): ReadonlyArray<Atom> => {
	if (span.kind !== "column" || !span.span) {
		return []
	}
	if (other.kind === "fixed") {
		return [{ kind: "span", column: span.name }]
	}
	if (other.kind === "column" && other.name !== span.name) {
		return [{ kind: "pairSpan", column: span.name, other: other.name }]
	}
	return []
}

/** The atoms of the predicate `e` over the local node.
 *
 * What one scalar predicate says about the columns of the node it filters, for access-path extraction.
 *
 * A predicate is classified against a local node, the node whose heading its column references read. An operand is a
 * local column, a fixed value (a parameter, a column of an outer node, or any expression over those, all known before
 * the local rows are read), a literal (an expression over literals only), or something computed from local columns,
 * which no index serves. An endpoint of a span compared with another span's, or tested inside another span, is no such
 * computation: extraction reads a query's filters in their Allen normal form (`allenNormalDag`), which states it as range operators on the two spans. The atoms are:
 *
 * - eq: a local column equal to a fixed value or a literal;
 * - range: a local column bounded below or above by a fixed value (lt, le, gt, ge, between);
 * - span: a span column under a range operator against a fixed value (every Allen mask's formula carries an unnegated
 *   atom the GiST range_ops class serves), and `span @> point` (pointIn);
 * - pairEq, pairRange, pairSpan: the same relations between two local columns, which inside a match region are join
 *   conditions between occurrences.
 *
 * A conjunction is the union of its conjuncts' atoms. A disjunction keeps only what holds in every disjunct: an
 * equality, span or pair atom present in all of them, so an Allen formula's disjuncts, each with its own unnegated range
 * operator on one span pair, still yield the span atom. A negation yields nothing: its atom is rechecked on the rows the
 * index finds, never driven by it. An IN list over fixed values is an equality; over literals, a literal equality. Ordering comparisons of spans order
 * ranges as values, which no access path serves; span equality is the Allen `equals` mask, a range_ops operator too. A
 * literal-only bound selects no key column under the fixed policy. No other operation is a sargable predicate:
 * arithmetic, the text and numeric functions, a cast, a negation and an inequality give no atom. */
export const predicateAtoms = (local: NodeId, e: ScalarExpr): ReadonlyArray<Atom> => {
	if (e.kind !== "op") {
		return []
	}
	const operand = (i: number): Operand => {
		const arg = e.args[i]
		return arg === undefined ? { kind: "computed" } : operandOf(local, arg)
	}
	const code = typeof e.op === "string" ? undefined : e.op.code
	if (code === "range_contains_elem") {
		return spanAtoms(operand(0), operand(1))
	}
	if (code !== undefined && spanOperatorCodes.has(code)) {
		const l = operand(0)
		const r = operand(1)
		return [...spanAtoms(l, r), ...spanAtoms(r, l)]
	}
	const native = nativeOp(e.op)
	if (native === undefined) {
		return []
	}
	switch (native.fn) {
		case "and":
			return dedupe(e.args.flatMap((a) => predicateAtoms(local, a)))
		case "or": {
			const sets = e.args.map((a) => predicateAtoms(local, a))
			const [first, ...rest] = sets
			if (first === undefined) {
				return []
			}
			return dedupe(
				first.filter(
					(a) =>
						a.kind !== "range" &&
						a.kind !== "pairRange" &&
						rest.every((s) => s.some((b) => atomKey(b) === atomKey(a)))
				)
			)
		}
		case "eq":
		case "lt":
		case "le":
		case "gt":
		case "ge":
			return comparisonAtoms(native.fn, operand(0), operand(1))
		case "between": {
			const x = operand(0)
			return x.kind === "column"
				? [...comparisonAtoms("ge", x, operand(1)), ...comparisonAtoms("le", x, operand(2))]
				: []
		}
		case "in": {
			const x = operand(0)
			if (x.kind !== "column") {
				return []
			}
			const values = [...e.args.keys()].slice(1).map((i) => operand(i))
			if (values.length === 0 || values.some((v) => v.kind === "column" || v.kind === "computed")) {
				return []
			}
			return [
				{
					kind: "eq",
					column: x.name,
					with: values.every((v) => v.kind === "literal") ? "literal" : "fixed"
				}
			]
		}
		case "add":
		case "sub":
		case "mul":
		case "div":
		case "mod":
		case "neg":
		case "quot":
		case "rem":
		case "abs":
		case "sign":
		case "round":
		case "trunc":
		case "ceil":
		case "floor":
		case "gcd":
		case "lcm":
		case "power":
		case "sqrt":
		case "least":
		case "greatest":
		case "widthBucket":
		case "minScale":
		case "lower":
		case "upper":
		case "charLength":
		case "octetLength":
		case "concat":
		case "startsWith":
		case "endsWith":
		case "right":
		case "matches":
		case "translate":
		case "collapse":
		case "regexpReplace":
		case "btrim":
		case "parseDouble":
		case "parseDecimal":
		case "sha256":
		case "cosineDistance":
		case "union":
		case "intersection":
		case "difference":
		case "complement":
		case "cardinality":
		case "subset":
		case "disjoint":
		case "adjoin":
		case "ne":
		case "not":
		case "cast":
			return []
	}
}

const dedupe = (atoms: ReadonlyArray<Atom>): ReadonlyArray<Atom> => {
	const seen = new Map<string, Atom>()
	for (const a of atoms) {
		if (!seen.has(atomKey(a))) {
			seen.set(atomKey(a), a)
		}
	}
	return [...seen.values()]
}
