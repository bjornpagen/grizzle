import { isAtAny } from "#lint/paths.ts"
import { isDrizzleSqlTemplate } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"

/**
 * A Drizzle `sql` template is written only in a typed SQL leaf, one of the owners the options name: readers and
 * schemas compose native builders, and a missing operator becomes a typed function of a leaf.
 */
export const sqlLeafOwnersOnly: Visit = ({ sourceFile, semantics, options }) => {
	if (isAtAny(options.sqlLeafOwnersOnly.owners, sourceFile.fileName)) {
		return () => []
	}
	return (node) =>
		isDrizzleSqlTemplate(semantics, node)
			? [
					{
						node,
						message:
							"A Drizzle `sql` template is written only in a typed SQL leaf; readers and schemas compose native builders.",
						suggestion:
							"Move the missing operator into a typed function of a SQL leaf (superlint option sqlLeafOwnersOnly.owners)."
					}
				]
			: []
}
