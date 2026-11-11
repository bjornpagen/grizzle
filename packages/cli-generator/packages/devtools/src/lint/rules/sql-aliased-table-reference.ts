import { Array as Arr, Result } from "effect"
import * as ts from "typescript/ast"
import { closesWithWord } from "#lint/sql-text.ts"
import { interpolationsOf, isDrizzleFunction, isDrizzleSqlTemplate, unwrapped } from "#lint/sql.ts"
import type { RuleContext, Visit } from "#lint/types.ts"

/**
 * Whether an expression holds a Drizzle table alias. An alias proxy erases its origin from the table's public type,
 * so the authored value declarations are followed instead: a direct `alias(…)` call, either branch of a conditional,
 * and copied or imported bindings and object properties keep the constructor's provenance. A cyclic binding ends the
 * walk. This follows source declarations, not values through arbitrary functions.
 */
const comesFromTableAlias = (
	context: RuleContext,
	expression: ts.Expression,
	seen: Set<ts.Node>
): boolean => {
	const { checker, semantics } = context
	const inner = unwrapped(expression)
	if (seen.has(inner)) {
		return false
	}
	seen.add(inner)
	if (ts.isCallExpression(inner)) {
		return isDrizzleFunction(semantics, inner, "alias")
	}
	if (ts.isConditionalExpression(inner)) {
		return (
			comesFromTableAlias(context, inner.whenTrue, seen) ||
			comesFromTableAlias(context, inner.whenFalse, seen)
		)
	}
	const symbol = semantics.symbolAt(inner)
	if (symbol === undefined) {
		return false
	}
	return Arr.some(semantics.declarationsOf(semantics.aliasTarget(symbol)), (declaration) => {
		if (
			(ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
			declaration.initializer !== undefined
		) {
			return comesFromTableAlias(context, declaration.initializer, seen)
		}
		if (!ts.isShorthandPropertyAssignment(declaration)) {
			return false
		}
		const value = checker.getShorthandAssignmentValueSymbol(declaration)
		return (
			value !== undefined &&
			Arr.some(
				semantics.declarationsOf(value),
				(binding) =>
					ts.isVariableDeclaration(binding) &&
					binding.initializer !== undefined &&
					comesFromTableAlias(context, binding.initializer, seen)
			)
		)
	})
}

const AS: ReadonlyArray<string> = ["as"]

/**
 * A Drizzle table alias interpolated into a `sql` template renders only its alias name, not the relation it aliases,
 * unless it follows `as` (`${base} as ${alias}`, which declares it).
 */
export const sqlAliasedTableReference: Visit = (context) => (node) => {
	if (
		!ts.isTaggedTemplateExpression(node) ||
		!ts.isTemplateExpression(node.template) ||
		!isDrizzleSqlTemplate(context.semantics, node)
	) {
		return []
	}
	return Arr.filterMap(interpolationsOf(node.template), ({ span, before }) =>
		!closesWithWord(before, AS) && comesFromTableAlias(context, span.expression, new Set())
			? Result.succeed({
					node: span.expression,
					message: "A Drizzle alias interpolates only its alias name, not the relation it aliases.",
					suggestion:
						"Use QueryBuilder.from/join(alias), a template that interpolates the base relation, the word as, then the alias, or the alias's typed columns."
				})
			: Result.failVoid
	)
}
