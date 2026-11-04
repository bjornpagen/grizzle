import { appendAll } from "#compiler/core/array.ts"
import { canonicalEquals, catchSignal, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	type ColumnRef,
	describeOp,
	type LiveArgs,
	type OpId,
	type ScalarExpr,
	type TypedLiteral,
	withArgs
} from "#compiler/ir/expr.ts"
import type { PreconditionProof } from "#compiler/ir/proof.ts"
import type { Cell } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import type { CatalogEditor } from "#compiler/lower/shapes/catalog/edit.ts"
import {
	binaryCoercion,
	booleanAnd,
	castOf,
	type NativeFn,
	type NativeOp,
	nativeOp,
	overloadOf
} from "#compiler/scalar/compute/registry.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"

/** A catalog shape that does not hold: the reason the composed lowering is kept. */
export class NoMatch extends Error {
	readonly reason: string

	constructor(reason: string) {
		super()
		this.reason = reason
	}
}

export const noMatch = (reason: string): never => {
	throw new NoMatch(reason)
}

/** What a recognizer found: the shape's value, or the reason the shape does not hold. */
type Match<A> =
	| { readonly kind: "match"; readonly value: A }
	| { readonly kind: "noMatch"; readonly reason: string }

/**
 * Runs a recognizer: a NoMatch it throws is the result's reason. Anything else it throws, a refusal or a defect,
 * propagates, so a failure that is not a shape's absence is never taken for one.
 */
export const attempt = <A>(recognize: () => A): Match<A> => {
	const recognized = catchSignal(NoMatch, recognize)
	return recognized.ok
		? { kind: "match", value: recognized.value }
		: { kind: "noMatch", reason: recognized.error.reason }
}

/** A condition the shape requires; past it, the condition holds, so it narrows what it tests. */
export const demand: (condition: boolean, reason: string) => asserts condition = (
	condition,
	reason
) => {
	if (!condition) {
		noMatch(reason)
	}
}

/** A value the matched composition must hold: an operand, a binding, a column. Absent, the shape does not hold. */
export const required = <T>(value: T | undefined, reason: string): T => value ?? noMatch(reason)

/**
 * The plain result types the Compute catalogue gives (scalar/compute/types.ts), so a type the target states is the
 * type the checker would have stated.
 */
export const plain: {
	readonly [C in "int4" | "int8" | "float8" | "bool" | "numeric"]: ScalarType
} = {
	int4: plainType("int4"),
	int8: plainType("int8"),
	float8: plainType("float8"),
	bool: plainType("bool"),
	numeric: plainType("numeric")
}

/**
 * Scalar expression reading and construction for the catalog rewrites.
 *
 * Every expression a target adds is one PostgreSQL operator, function, cast or conditional, typed and with its
 * non-null proof, exactly as the checker states them (valid DAG): a column reference is non-null by storage, a
 * literal by being one, an operator or a cast by strictness over non-null inputs, a conditional by its ELSE. Copying
 * a composition's expression onto the target's nodes rebases its column references and keeps everything else.
 */

/** The column an expression reads when it is a bare column reference. */
export const columnRef = (e: ScalarExpr): ColumnRef | undefined =>
	e.kind === "column" ? e.column : undefined

export const literalOf = (e: ScalarExpr): TypedLiteral | undefined =>
	e.kind === "literal" ? e.value : undefined

/** An operator node with its operands, and the native function it is when the compute registry has it. */
interface OpView {
	readonly fn: NativeFn | undefined
	readonly op: OpId
	readonly args: ReadonlyArray<ScalarExpr>
}

export const opView = (e: ScalarExpr): OpView | undefined =>
	e.kind === "op" ? { fn: nativeOp(e.op)?.fn, op: e.op, args: e.args } : undefined

/** Whether `e` is the native function `fn`, with its operands. */
const nativeView = (e: ScalarExpr, fn: NativeFn): OpView | undefined => {
	const v = opView(e)
	return v?.fn === fn ? v : undefined
}

/**
 * The conjuncts of a predicate: its `and` operands, flattened.
 *
 * Pushed last to first, so the first operand is popped first.
 */
export const conjuncts = (root: ScalarExpr): ReadonlyArray<ScalarExpr> => {
	const out: Array<ScalarExpr> = []
	const stack = [root]
	for (let e = stack.pop(); e !== undefined; e = stack.pop()) {
		const v = nativeView(e, "and")
		if (v !== undefined) {
			appendAll(stack, v.args.toReversed())
		} else {
			out.push(e)
		}
	}
	return out
}

/** Every column an expression reads, depth first. */
export const columnsRead = (root: ScalarExpr): ReadonlyArray<ColumnRef> => {
	const out: Array<ColumnRef> = []
	const seen = new Set<ScalarExpr>()
	const stack = [root]
	for (let e = stack.pop(); e !== undefined; e = stack.pop()) {
		if (seen.has(e)) {
			continue
		}
		seen.add(e)
		if (e.kind === "column") {
			out.push(e.column)
		}
		appendAll(stack, e.args)
	}
	return out
}

/**
 * Whether two expressions compute the same value by the same operations: equal structure, equal operators, equal
 * leaves. Two spellings of one term are two expressions, so the comparison is structural.
 */
export const sameExpr = (x: ScalarExpr, y: ScalarExpr): boolean => {
	if (x === y) {
		return true
	}
	if (x.kind !== y.kind || !sameScalarType(x.type, y.type)) {
		return false
	}
	if (x.args.length !== y.args.length) {
		return false
	}
	/** The operand lists have one length, so every operand of x has its counterpart in y. */
	const sameArgs = (): boolean =>
		x.args.every((arg, i) => {
			const other = y.args[i]
			return other !== undefined && sameExpr(arg, other)
		})
	switch (x.kind) {
		case "column":
			return (
				y.kind === "column" && x.column.node === y.column.node && x.column.name === y.column.name
			)
		case "param":
			return y.kind === "param" && x.param === y.param && x.role === y.role
		case "literal":
			return y.kind === "literal" && canonicalEquals(x.value, y.value, everyProperty)
		case "op":
			return y.kind === "op" && x.op === y.op && sameArgs()
		case "cast":
			return y.kind === "cast" && x.cast === y.cast && sameArgs()
		case "value":
		case "domainCast":
		case "cond":
			return sameArgs()
	}
}

/** A reference to the column `name` of `node`'s heading, of type `type`. */
export const colExpr = (
	ed: CatalogEditor,
	node: Cell,
	name: string,
	type: ScalarType
): ScalarExpr =>
	ed.expr({
		kind: "column",
		column: { node: node.id, name },
		args: [],
		type,
		nonNull: "storage"
	})

export const litExpr = (ed: CatalogEditor, value: TypedLiteral, type: ScalarType): ScalarExpr =>
	ed.expr({ kind: "literal", value, args: [], type, nonNull: "literal" })

/**
 * One native operator or connective over `args`, typed `type`: a catalog rewrite builds only operations defined on
 * every value, since it holds no proof of a precondition, so a partial overload is refused.
 */
const opExpr = (
	ed: CatalogEditor,
	op: NativeOp,
	args: ReadonlyArray<ScalarExpr>,
	type: ScalarType
): ScalarExpr => {
	if (op.partial) {
		throw new Refusal(
			unsupported(
				SourceLoc("catalog operator", []),
				`${describeOp(op.id)} needs the proof of its precondition`
			)
		)
	}
	return ed.expr({
		kind: "op",
		op: op.id,
		args,
		type,
		nonNull: "strict",
		volatility: op.volatility
	})
}

/** The two operands of the binary operator `op` at `e`; none for any other expression or arity. */
export const binaryOperands = (
	e: ScalarExpr,
	op: string
): readonly [ScalarExpr, ScalarExpr] | undefined => {
	if (e.kind !== "op" || e.op !== op) {
		return undefined
	}
	const [a, b, ...rest] = e.args
	return a !== undefined && b !== undefined && rest.length === 0 ? [a, b] : undefined
}

/** `f` over both operand orders of the commutative binary operator `op` at `e`, the first that matches. */
export const eitherOrder = <A>(
	e: ScalarExpr,
	op: string,
	f: (x: ScalarExpr, y: ScalarExpr) => A | undefined
): A | undefined => {
	const operands = binaryOperands(e, op)
	if (operands === undefined) {
		return undefined
	}
	const [x, y] = operands
	return f(x, y) ?? f(y, x)
}

/** The native comparison `fn` over two operands of one carrier. */
export const compareExpr = (
	ed: CatalogEditor,
	fn: "eq" | "ne" | "lt" | "le" | "gt" | "ge",
	left: ScalarExpr,
	right: ScalarExpr
): ScalarExpr => {
	const carrier = baseOf(left.type).carrier
	const op = overloadOf(fn, [carrier, carrier])
	if (op === undefined) {
		return noMatch(`a native ${fn} over ${carrier}`)
	}
	return opExpr(ed, op, [left, right], plain.bool)
}

export const andExpr = (ed: CatalogEditor, args: ReadonlyArray<ScalarExpr>): ScalarExpr => {
	const [only] = args
	return args.length === 1 && only !== undefined ? only : opExpr(ed, booleanAnd, args, plain.bool)
}

/**
 * A cast a catalog rewrite builds: within a carrier the binary coercion, which changes a typmod, a refinement or an
 * exact bound immutably; between two carriers the registered cast, as volatile as it is, defined on every value or
 * partial with the proof the rewrite states for it (`proof`). A partial cast without one is no match: the rewrite
 * cannot keep the program total without its proof.
 */
export const castExpr = (
	ed: CatalogEditor,
	arg: ScalarExpr,
	type: ScalarType,
	proof: PreconditionProof | undefined
): ScalarExpr => {
	const from = baseOf(arg.type).carrier
	const to = baseOf(type).carrier
	if (from === to || (from === "numeric" && to === "exactInteger")) {
		return ed.expr({
			kind: "cast",
			cast: binaryCoercion,
			args: [arg],
			type,
			nonNull: "strict",
			volatility: "immutable"
		})
	}
	const native = castOf(from, to)
	if (native === undefined) {
		throw new Refusal(
			unsupported(SourceLoc("catalog cast", []), `a native cast from ${from} to ${to}`)
		)
	}
	if (!native.partial) {
		return ed.expr({
			kind: "cast",
			cast: native.id,
			args: [arg],
			type,
			nonNull: "strict",
			volatility: native.volatility
		})
	}
	return ed.expr({
		kind: "cast",
		cast: native.id,
		args: [arg],
		type,
		nonNull: "strict",
		volatility: native.volatility,
		proof: proof ?? noMatch(`the proof of a cast from ${from} to ${to}`)
	})
}

export const condExpr = (
	ed: CatalogEditor,
	pred: ScalarExpr,
	then: ScalarExpr,
	otherwise: ScalarExpr,
	type: ScalarType
): ScalarExpr => ed.expr({ kind: "cond", args: [pred, then, otherwise], type, nonNull: "cond" })

/**
 * A copy of an expression whose column references are mapped onto the target's nodes. A reference the map does not
 * cover means the composition reads something the target cannot provide: no match.
 */
export const rebase = (
	ed: CatalogEditor,
	e: ScalarExpr,
	map: (ref: ColumnRef) => ColumnRef | undefined
): ScalarExpr => {
	if (e.kind === "column") {
		const to = required(
			map(e.column),
			`a column ${e.column.node}.${e.column.name} the target carries`
		)
		return ed.expr({ ...e, column: to })
	}
	if (e.args.length === 0) {
		return e
	}
	return ed.expr(withArgs<LiveArgs, LiveArgs>(e, (a) => rebase(ed, a, map)))
}
