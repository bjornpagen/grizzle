import { Refusal } from "#compiler/core/canonical.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	type ColumnRef,
	describeOp,
	type TypedLiteral,
	type ScalarExpr
} from "#compiler/ir/expr.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import type { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import { type ComparisonFn, comparisonHolds } from "#compiler/scalar/compute/evaluate.ts"
import { hostOfLiteral } from "#compiler/scalar/compute/literal.ts"
import { connectiveOps, nativeOp } from "#compiler/scalar/compute/registry.ts"
import type { HostValue } from "#compiler/scalar/values/identity.ts"

type Folded =
	| { readonly kind: "value"; readonly value: boolean }
	| { readonly kind: "expr"; readonly expr: ScalarExpr }

/** An operator without the operand its arity needs, which validation leaves to the operator's builder. */
const refusal = (loc: SourceLoc, capability: string): Refusal =>
	new Refusal(malformedDescription(loc, capability))

/** The position of the first operand that folded to `decider`, the value that decides its connective, if one did. */
const decidingPart = (
	parts: ReadonlyArray<{ readonly folded: Folded }>,
	decider: boolean
): number | undefined => {
	for (const [i, p] of parts.entries()) {
		if (p.folded.kind === "value" && p.folded.value === decider) {
			return i
		}
	}
	return undefined
}

/** The value a column reference has, when the caller fixes it. */
type ColumnValue = (ref: ColumnRef) => TypedLiteral | undefined

export const noColumns: ColumnValue = () => undefined

const literalOf = (e: ScalarExpr, column: ColumnValue): TypedLiteral | undefined => {
	if (e.kind === "literal") {
		return e.value
	}
	if (e.kind === "column") {
		return column(e.column)
	}
	return undefined
}

/**
 * The truth value of a comparison of constant operands, the evaluator's (scalar/compute/evaluate.ts comparisonHolds)
 * over each operand's host value at its type, or undefined where an operand is no constant.
 */
const compare = (expr: ScalarExpr, fn: ComparisonFn, column: ColumnValue): boolean | undefined => {
	const [first] = expr.args
	if (first === undefined) {
		throw refusal(
			SourceLoc(`boolean folding at expression ${expr.id}`, []),
			`an operand of the comparison ${fn}`
		)
	}
	const values: Array<HostValue> = []
	for (const a of expr.args) {
		const literal = literalOf(a, column)
		if (literal === undefined) {
			return undefined
		}
		values.push(hostOfLiteral(baseOf(a.type).carrier, literal))
	}
	return comparisonHolds(fn, values, first.type)
}

const boolLiteral = (editor: DagEditor, like: ScalarExpr, value: boolean): ScalarExpr =>
	editor.expr({
		kind: "literal",
		value: { kind: "bool", value },
		args: [],
		type: like.type,
		nonNull: "literal"
	})

/**
 * The folded form of a boolean expression: its truth value when the fragment decides it, otherwise the expression
 * with every decided sub-term folded (the expression itself when nothing folds).
 *
 * The boolean fragment the compiler decides on the host.
 *
 * "Fold supported immutable expressions, simplify boolean predicates, and eliminate impossible arms." PostgreSQL's
 * arithmetic, overflow, division, rounding and result types are authoritative, and the host never substitutes its own
 * arithmetic for a SQL expression, so the supported fragment is exactly the part whose answer is a
 * comparison or a truth value and never a computed number:
 *
 * - the boolean literals and the connectives `and`, `or` and `not`;
 * - the comparisons `=`, `<>`, `<`, `<=`, `>`, `>=`, BETWEEN and IN between operands that are literals, or columns
 *   whose value the caller fixes (a closed relation's declared fact), evaluated as the host evaluates every comparison
 *   (compute/evaluate.ts comparisonHolds), under PostgreSQL's own total orders (scalar/values/identity.ts
 *   compareValues: NaN above every number and equal to itself, -0 equal to 0, numeric scale ignored, text in code-point
 *   order under C.UTF-8, closed ids in roster order, vectors as vector_cmp).
 *
 * Anything else, a parameter, an arithmetic operator, a cast, a conditional, is left to PostgreSQL. A connective whose
 * value an operand decides drops the other operands, which raise nothing: every expression is total.
 *
 * Only a comparison of constants, or a connective, is decided here.
 */
export const foldBoolean = (editor: DagEditor, expr: ScalarExpr, column: ColumnValue): Folded => {
	if (expr.kind === "literal" && expr.value.kind === "bool") {
		return { kind: "value", value: expr.value.value }
	}
	if (expr.kind !== "op") {
		return { kind: "expr", expr }
	}
	const op = nativeOp(expr.op)
	if (op === undefined) {
		return { kind: "expr", expr }
	}
	switch (op.fn) {
		case "and":
		case "or": {
			const decider = op.fn === "or"
			const parts = expr.args.map((a) => ({ arg: a, folded: foldBoolean(editor, a, column) }))
			const decided = decidingPart(parts, decider)
			if (decided !== undefined) {
				return { kind: "value", value: decider }
			}
			const kept = parts.flatMap((p) =>
				p.folded.kind === "value" ? (p.folded.value === decider ? [p.arg] : []) : [p.folded.expr]
			)
			if (kept.length === 0) {
				return { kind: "value", value: !decider }
			}
			const [only] = kept
			if (kept.length === 1 && only !== undefined) {
				return { kind: "expr", expr: only }
			}
			if (kept.length === expr.args.length && kept.every((k, i) => k === expr.args[i])) {
				return { kind: "expr", expr }
			}
			return { kind: "expr", expr: editor.expr({ ...expr, args: kept }) }
		}
		case "not": {
			const [operand] = expr.args
			if (operand === undefined) {
				throw refusal(
					SourceLoc(`boolean folding at expression ${expr.id}`, []),
					`an operand of ${describeOp(expr.op)}`
				)
			}
			const inner = foldBoolean(editor, operand, column)
			if (inner.kind === "value") {
				return { kind: "value", value: !inner.value }
			}
			if (inner.expr === operand) {
				return { kind: "expr", expr }
			}
			return { kind: "expr", expr: editor.expr({ ...expr, args: [inner.expr] }) }
		}
		case "eq":
		case "ne":
		case "lt":
		case "le":
		case "gt":
		case "ge":
		case "between":
		case "in": {
			const v = compare(expr, op.fn, column)
			return v === undefined ? { kind: "expr", expr } : { kind: "value", value: v }
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
		case "utf16Length":
		case "regexpCount":
		case "concat":
		case "startsWith":
		case "endsWith":
		case "right":
		case "matches":
		case "translate":
		case "lowerAscii":
		case "collapse":
		case "replace":
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
		case "cast":
			return { kind: "expr", expr }
	}
}

/** The folded form as an expression: a decided value becomes a boolean literal of the expression's type. */
export const foldedExpr = (editor: DagEditor, e: ScalarExpr, folded: Folded): ScalarExpr =>
	folded.kind === "expr" ? folded.expr : boolLiteral(editor, e, folded.value)

/**
 * Whether folding changes `expr`: foldBoolean returns a value or another expression exactly when `expr` is a boolean
 * literal, a comparison it decides, a conjunction or disjunction of no operand, or a connective over an operand folding
 * changes. What foldBoolean returns folding leaves unchanged.
 */
export const folds = (expr: ScalarExpr, column: ColumnValue): boolean => {
	if (expr.kind === "literal") {
		return expr.value.kind === "bool"
	}
	if (expr.kind !== "op") {
		return false
	}
	const op = nativeOp(expr.op)
	if (op === undefined) {
		return false
	}
	switch (op.fn) {
		case "and":
		case "or":
			return expr.args.length === 0 || expr.args.some((a) => folds(a, column))
		case "not":
			return expr.args.some((a) => folds(a, column))
		case "eq":
		case "ne":
		case "lt":
		case "le":
		case "gt":
		case "ge":
		case "between":
		case "in":
			return compare(expr, op.fn, column) !== undefined
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
		case "utf16Length":
		case "regexpCount":
		case "concat":
		case "startsWith":
		case "endsWith":
		case "right":
		case "matches":
		case "translate":
		case "lowerAscii":
		case "collapse":
		case "replace":
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
		case "cast":
			return false
	}
}

/** The conjunction of `parts`, typed like `like`: the single part, or one `and` over all of them. */
export const conjunction = (
	editor: DagEditor,
	parts: ReadonlyArray<ScalarExpr>,
	like: ScalarExpr
): ScalarExpr => {
	const [only] = parts
	if (parts.length === 1 && only !== undefined) {
		return only
	}
	return editor.expr({
		kind: "op",
		op: connectiveOps.and,
		args: parts,
		type: like.type,
		nonNull: "strict",
		volatility: "immutable"
	})
}
