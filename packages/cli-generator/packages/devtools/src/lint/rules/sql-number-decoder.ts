import { Array as Arr } from "effect"
import * as ts from "typescript/ast"
import { type Type, TypeFlags } from "typescript/sync"
import { isDrizzleSqlTemplate } from "#lint/sql.ts"
import type { Visit } from "#lint/types.ts"

const containsNumber = (type: Type): boolean =>
	type.isUnionType()
		? Arr.some(type.getTypes(), containsNumber)
		: (type.flags & TypeFlags.NumberLike) !== 0

/** Whether a template's value is decoded by a real `.mapWith(decoder)` call, parentheses aside: a property read or
 * a type claim is no decoder. */
const hasDecoder = (node: ts.TaggedTemplateExpression): boolean => {
	let current: ts.Node = node
	while (ts.isParenthesizedExpression(current.parent)) {
		current = current.parent
	}
	const access = current.parent
	return (
		ts.isPropertyAccessExpression(access) &&
		access.name.text === "mapWith" &&
		ts.isCallExpression(access.parent) &&
		access.parent.expression === access &&
		Arr.isReadonlyArrayNonEmpty(access.parent.arguments)
	)
}

/**
 * `sql<number>` is a claim, not a pg decoder: pg returns int8 and numeric as strings, so a template typed with a
 * number keeps its raw rows unknown and admits them with the owning schema, or decodes through `.mapWith(…)`.
 */
export const sqlNumberDecoder: Visit =
	({ checker, semantics }) =>
	(node) => {
		if (
			!ts.isTaggedTemplateExpression(node) ||
			node.typeArguments === undefined ||
			!Arr.some(node.typeArguments, (argument) =>
				containsNumber(checker.getTypeFromTypeNode(argument))
			) ||
			hasDecoder(node) ||
			!isDrizzleSqlTemplate(semantics, node)
		) {
			return []
		}
		return [
			{
				node,
				message: "`sql<number>` is not a pg decoder: pg returns int8 and numeric as strings.",
				suggestion:
					"Keep raw rows unknown and admit them with the owning schema, or decode with `.mapWith(…)` in a typed query builder."
			}
		]
	}
