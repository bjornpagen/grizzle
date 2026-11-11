import { Array as Arr, Result } from "effect"
import * as ts from "typescript/ast"
import { ElementFlags, type Symbol as NativeSymbol, type Type } from "typescript/sync"
import { isDefaultLibraryPath } from "#lint/paths.ts"
import type { RuleContext, Visit } from "#lint/types.ts"

const MESSAGE =
	"A spread argument puts every element of a variable-length list on the call stack; V8 refuses about 120,000 of them at Node's default stack."

const SUGGESTION =
	"Pass the list as one value (an array parameter), append it with a for-of loop or Arr.appendAll, or fold it (Arr.reduce, Arr.max)."

/** A type whose length is written in source: a tuple without a rest or variadic element, or a union of such tuples. */
const isFixedLength = (type: Type): boolean =>
	Arr.every(
		type.isUnionType() ? type.getTypes() : [type],
		(member) =>
			member.isTupleType() &&
			Arr.every(member.getTarget().elementFlags, (flag) => (flag & ElementFlags.Variable) === 0)
	)

/** An array literal without a spread element: its length is written in source. */
const isSpreadFreeLiteral = (list: ts.Expression): boolean =>
	ts.isArrayLiteralExpression(list) &&
	Arr.every(list.elements, (element) => !ts.isSpreadElement(element))

/** A symbol declared only in TypeScript's default library: a builtin, not this repository's or a package's. */
const isDefaultLibrarySymbol = (symbol: NativeSymbol | undefined): boolean =>
	symbol !== undefined &&
	Arr.isReadonlyArrayNonEmpty(symbol.declarations) &&
	Arr.every(symbol.declarations, (declaration) => isDefaultLibraryPath(declaration.path))

/**
 * The position of the list whose elements become the call's arguments, for the builtin forms that take one without
 * spread syntax: Reflect.apply's third argument and Reflect.construct's second, and the second argument of
 * Function.prototype.apply (`f.apply(t, xs)`, `Function.prototype.call.apply(f, xs)`); none for any other call.
 */
const applyListIndex = (
	context: RuleContext,
	call: ts.CallExpression
): Result.Result<number, void> => {
	const callee = call.expression
	if (!ts.isPropertyAccessExpression(callee)) {
		return Result.failVoid
	}
	const method = callee.name.text
	if (
		(method !== "apply" && method !== "construct") ||
		!isDefaultLibrarySymbol(context.semantics.symbolAt(callee))
	) {
		return Result.failVoid
	}
	const owner = context.semantics.symbolAt(callee.expression)
	if (owner?.name === "Reflect" && isDefaultLibrarySymbol(owner)) {
		return Result.succeed(method === "apply" ? 2 : 1)
	}
	return method === "apply" ? Result.succeed(1) : Result.failVoid
}

/** The arguments whose elements become a call's arguments: each spread's operand, and apply's or construct's list. */
const argumentLists = (
	context: RuleContext,
	node: ts.CallExpression | ts.NewExpression
): ReadonlyArray<ts.Expression> => {
	const written = node.arguments ?? []
	const spread = Arr.filterMap(written, (argument) =>
		ts.isSpreadElement(argument) ? Result.succeed(argument.expression) : Result.failVoid
	)
	if (!ts.isCallExpression(node)) {
		return spread
	}
	const index = applyListIndex(context, node)
	const list = Result.isSuccess(index) ? written[index.success] : undefined
	return list === undefined || ts.isSpreadElement(list) ? spread : Arr.append(spread, list)
}

/**
 * No call takes a variable-length list as its arguments. A spread argument, or the list of Function.prototype.apply,
 * Reflect.apply or Reflect.construct, puts every element on the call stack, and V8 refuses about 120,000 of them at
 * Node's default stack. A tuple without a rest element, or an array literal without a spread, has a length written in
 * source and passes; a type the checker does not give is refused.
 */
export const noSpreadArgument: Visit = (context) => (node) =>
	ts.isCallExpression(node) || ts.isNewExpression(node)
		? Arr.filterMap(argumentLists(context, node), (list) => {
				const type = context.semantics.typeAt(list)
				return isSpreadFreeLiteral(list) || (type !== undefined && isFixedLength(type))
					? Result.failVoid
					: Result.succeed({ node: list, message: MESSAGE, suggestion: SUGGESTION })
			})
		: []
