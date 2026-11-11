import { Array as Arr, Result } from "effect"
import * as ts from "typescript/ast"
import { opensWithArrayCast } from "#lint/sql-text.ts"
import { interpolationsOf, isDrizzleSqlTemplate } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"

/**
 * Drizzle interpolates a JavaScript array as SQL tuple syntax, so an array or tuple written before an array cast
 * (`${ids}::uuid[]`) renders as a list of parameters, never as one PostgreSQL array.
 */
export const sqlArrayParameter: Visit =
	({ checker, semantics }) =>
	(node) => {
		if (!ts.isTaggedTemplateExpression(node) || !ts.isTemplateExpression(node.template)) {
			return []
		}
		const casts = Arr.filter(interpolationsOf(node.template), ({ span }) =>
			opensWithArrayCast(span.literal.text)
		)
		if (!Arr.isReadonlyArrayNonEmpty(casts) || !isDrizzleSqlTemplate(semantics, node)) {
			return []
		}
		return Arr.filterMap(casts, ({ span }) => {
			const type = semantics.typeAt(span.expression)
			return type !== undefined && (checker.isArrayType(type) || checker.isTupleType(type))
				? Result.succeed({
						node: span.expression,
						message:
							"Drizzle interpolates a JavaScript array as SQL tuple syntax, not as the PostgreSQL array its cast expects.",
						suggestion: "Bind the array explicitly with `sql.param(array)` before its array cast."
					})
				: Result.failVoid
		})
	}
