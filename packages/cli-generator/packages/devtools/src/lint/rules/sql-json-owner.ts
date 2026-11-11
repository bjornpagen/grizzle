import { Array as Arr } from "effect"
import * as ts from "typescript/ast"
import { isAtAny } from "#lint/paths.ts"
import { authoredSql, hasJsonOperator } from "#lint/sql-text.ts"
import { isDrizzleSqlTemplate } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"

/** The JSON operators (`->`, `->>`, `#>`, `#>>`) and the jsonb expansion functions render in exactly one kind of file:
 * the JSON leaves the options name, which hold their typed functions. */
export const sqlJsonOwner: Visit = ({ sourceFile, semantics, options }) => {
	const { owners } = options.sqlJsonOwner
	if (isAtAny(owners, sourceFile.fileName)) {
		return () => []
	}
	return (node) =>
		ts.isTaggedTemplateExpression(node) &&
		hasJsonOperator(authoredSql(node.template)) &&
		isDrizzleSqlTemplate(semantics, node)
			? [
					{
						node,
						message: "A JSON operator or expansion renders only in a JSON leaf.",
						suggestion: `Call a typed JSON function of a JSON leaf (superlint option sqlJsonOwner.owners: ${Arr.join(owners, ", ")}).`
					}
				]
			: []
}
