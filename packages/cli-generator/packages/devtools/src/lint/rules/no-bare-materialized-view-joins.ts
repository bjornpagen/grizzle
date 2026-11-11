import { Array as Arr, String as Str } from "effect"
import * as ts from "typescript/ast"
import type { Type } from "typescript/sync"
import type { Visit } from "#lint/types.ts"

const JOIN_METHODS: ReadonlyArray<string> = [
	"innerJoin",
	"leftJoin",
	"rightJoin",
	"fullJoin",
	"crossJoin",
	"innerJoinLateral",
	"leftJoinLateral",
	"crossJoinLateral"
]

/** Whether a type is, or intersects, Drizzle's PgMaterializedView. */
const isMaterializedView = (type: Type): boolean => {
	if (type.isIntersectionType()) {
		return Arr.some(type.getTypes(), isMaterializedView)
	}
	const symbol = type.getSymbol()
	return (
		symbol?.name === "PgMaterializedView" &&
		Arr.some(symbol.declarations, (declaration) =>
			Str.includes("/drizzle-orm/pg-core/view.")(declaration.path)
		)
	)
}

/**
 * A materialized view is joined through a subquery, never bare: Drizzle's native view JOIN rendering drops the
 * relation node when it is nested, which loses the view's dependency provenance before CTE and summary dependency
 * admission.
 */
export const noBareMaterializedViewJoins: Visit =
	({ semantics }) =>
	(node) => {
		if (
			!ts.isCallExpression(node) ||
			!ts.isPropertyAccessExpression(node.expression) ||
			!Arr.contains(JOIN_METHODS, node.expression.name.text)
		) {
			return []
		}
		const [joined] = node.arguments
		const type = joined === undefined ? undefined : semantics.typeAt(joined)
		return joined !== undefined && type !== undefined && isMaterializedView(type)
			? [
					{
						node: joined,
						message:
							"A bare materialized-view join loses its native dependency provenance when nested.",
						suggestion:
							"Join `db.select().from(view).as(getViewName(view))`, so the native FROM relation survives."
					}
				]
			: []
	}
