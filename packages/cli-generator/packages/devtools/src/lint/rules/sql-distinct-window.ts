import { Array as Arr, Option, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import { authoredSql, hasWindowExpression } from "#lint/sql-text.ts"
import { isDrizzleSqlTemplate, isUnrelatedCall, resolutionAt } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"

/** The distinct selections, with the position of their field object among the arguments. */
const DISTINCT_FIELDS: ReadonlyMap<string, number> = new Map([
	["selectDistinct", 0],
	["selectDistinctOn", 1]
])

const fieldExpressionOf = (property: ts.ObjectLiteralElementLike): Option.Option<ts.Expression> => {
	if (ts.isPropertyAssignment(property)) {
		return Option.some(property.initializer)
	}
	return ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)
		? Option.some(property.name)
		: Option.none()
}

/**
 * A distinct Drizzle selection selects no window value: a row number or other window computed in the DISTINCT list
 * becomes part of the distinct key, so the rows it numbers are never deduplicated. Deduplicate first, then number.
 */
export const sqlDistinctWindow: Visit =
	({ semantics }) =>
	(node) => {
		if (!ts.isCallExpression(node) || isUnrelatedCall(semantics, node)) {
			return []
		}
		const position = Option.flatMap(resolutionAt(semantics, node), (resolution) =>
			Str.includes("/drizzle-orm/")(resolution.file)
				? Option.flatMap(resolution.name, (name) =>
						Option.fromUndefinedOr(DISTINCT_FIELDS.get(name))
					)
				: Option.none()
		)
		const fields = Option.flatMap(position, (index) =>
			Option.fromUndefinedOr(node.arguments[index])
		)
		if (Option.isNone(fields) || !ts.isObjectLiteralExpression(fields.value)) {
			return []
		}
		return Arr.filterMap(fields.value.properties, (property) =>
			Option.match(fieldExpressionOf(property), {
				onNone: () => Result.failVoid,
				onSome: (expression) =>
					ts.isTaggedTemplateExpression(expression) &&
					isDrizzleSqlTemplate(semantics, expression) &&
					hasWindowExpression(authoredSql(expression.template))
						? Result.succeed({
								node: expression,
								message:
									"A window value in a DISTINCT selection becomes part of the distinct key, so the rows it numbers are never deduplicated.",
								suggestion: "Deduplicate the relation first, then number its rows."
							})
						: Result.failVoid
			})
		)
	}
