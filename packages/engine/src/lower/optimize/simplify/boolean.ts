import { Refusal } from "#compiler/core/canonical.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	type ColumnRef,
	describeOp,
	type TypedLiteral,
	OpId,
	type ScalarExpr
} from "#compiler/ir/expr.ts"
import { type DagEditor, total } from "#compiler/lower/optimize/demand/editor.ts"
import { compareValues, literalValue } from "#compiler/scalar/compute/evaluate.ts"
import { type NativeFn, nativeOp } from "#compiler/scalar/compute/registry.ts"

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

/** The native functions folding decides on constant operands. */
type Comparison = Extract<NativeFn, "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "between" | "in">

/** The truth value of a comparison of constant operands, or undefined. */
const compare = (expr: ScalarExpr, fn: Comparison, column: ColumnValue): boolean | undefined => {
	const values = expr.args.map((a) => literalOf(a, column))
	const literals = values.filter((v): v is TypedLiteral => v !== undefined)
	if (literals.length !== values.length) {
		return undefined
	}
	const [first] = expr.args
	if (first === undefined) {
		throw refusal(
			SourceLoc(`boolean folding at expression ${expr.id}`, []),
			`an operand of the comparison ${fn}`
		)
	}
	const type = first.type
	const vals = literals.map(literalValue)
	const cmp = (i: number, j: number) => {
		const a = vals[i]
		const b = vals[j]
		return a === undefined || b === undefined ? undefined : compareValues(a, b, type)
	}
	switch (fn) {
		case "eq":
		case "ne":
		case "lt":
		case "le":
		case "gt":
		case "ge": {
			const c = cmp(0, 1)
			if (c === undefined) {
				return undefined
			}
			return fn === "eq"
				? c === 0
				: fn === "ne"
					? c !== 0
					: fn === "lt"
						? c < 0
						: fn === "le"
							? c <= 0
							: fn === "gt"
								? c > 0
								: c >= 0
		}
		case "between": {
			const lo = cmp(0, 1)
			const hi = cmp(0, 2)
			if (lo === undefined || hi === undefined) {
				return undefined
			}
			return lo >= 0 && hi <= 0
		}
		case "in":
			return memberOf(vals.length, cmp)
	}
}

/**
 * Whether the first of `count` values equals one of the others under `cmp`, deciding in list order: undefined at the
 * first comparison that cannot be decided before an equal one.
 */
const memberOf = (
	count: number,
	cmp: (i: number, j: number) => number | undefined
): boolean | undefined => {
	for (let i = 1; i < count; i++) {
		const c = cmp(0, i)
		if (c === undefined) {
			return undefined
		}
		if (c === 0) {
			return true
		}
	}
	return false
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
 *   whose value the caller fixes (a closed relation's declared fact), compared under PostgreSQL's own total orders
 *   (compute/evaluate.ts compareValues: NaN above every number and equal to itself, -0 equal to 0, numeric scale
 *   ignored, text in code-point order under C.UTF-8, enums in roster order).
 *
 * Anything else, a parameter, an arithmetic operator, a cast, a conditional, is left to PostgreSQL. A connective whose
 * value an operand decides drops the other operands only when they are total, so folding never removes an evaluation
 * that could raise.
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
			if (decided !== undefined && total(parts.toSpliced(decided, 1).map((p) => p.arg))) {
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
		case "scale":
		case "minScale":
		case "trimScale":
		case "lower":
		case "upper":
		case "charLength":
		case "cosineDistance":
		case "cast":
			return { kind: "expr", expr }
	}
}

/** The folded form as an expression: a decided value becomes a boolean literal of the expression's type. */
export const foldedExpr = (editor: DagEditor, e: ScalarExpr, folded: Folded): ScalarExpr =>
	folded.kind === "expr" ? folded.expr : boolLiteral(editor, e, folded.value)

/** The conjuncts of a predicate: the operands of a top-level `and`, or the predicate itself. */
export const conjuncts = (e: ScalarExpr): ReadonlyArray<ScalarExpr> =>
	e.kind === "op" && nativeOp(e.op)?.fn === "and" ? e.args.flatMap((a) => conjuncts(a)) : [e]

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
		op: OpId("and"),
		args: parts,
		type: like.type,
		nonNull: "strict",
		volatility: "immutable",
		failure: "total"
	})
}
