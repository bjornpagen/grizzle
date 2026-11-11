import { Array as Arr, String as Str } from "effect"
import * as ts from "typescript/ast"
import { isAtAny } from "#lint/paths.ts"
import { authoredSql } from "#lint/sql-text.ts"
import { isDrizzleSqlTemplate } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"

/** A `::` cast renders in exactly one kind of file: the cast leaves the options name, which hold the PostgreSQL type
 * registry and its typed cast functions. */
export const sqlCastOwner: Visit = ({ sourceFile, semantics, options }) => {
	const { owners } = options.sqlCastOwner
	if (isAtAny(owners, sourceFile.fileName)) {
		return () => []
	}
	return (node) =>
		ts.isTaggedTemplateExpression(node) &&
		Str.includes("::")(authoredSql(node.template)) &&
		isDrizzleSqlTemplate(semantics, node)
			? [
					{
						node,
						message: "A `::` cast renders only in a cast leaf.",
						suggestion: `Call a typed cast function of a cast leaf (superlint option sqlCastOwner.owners: ${Arr.join(owners, ", ")}).`
					}
				]
			: []
}
