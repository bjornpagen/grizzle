import { Array as Arr, String as Str } from "effect"
import { type AnyNode, type Expression, problem } from "#oxlint/rule.ts"
import { ancestorsOf } from "#oxlint/syntax.ts"

/** `null`, `undefined`, `""`, `[]` and `{}`: the values a switch default falls back to. */
const isFallbackValue = (node: Expression): boolean => {
	if (node.type === "Literal") {
		return node.raw === "null" || (typeof node.value === "string" && Str.isEmpty(node.value))
	}
	if (node.type === "Identifier") {
		return node.name === "undefined"
	}
	if (node.type === "ArrayExpression") {
		return node.elements.length === 0
	}
	return node.type === "ObjectExpression" && node.properties.length === 0
}

const isDefaultClause = (node: AnyNode): boolean => node.type === "SwitchCase" && node.test === null

/** A fallback value returned anywhere inside a switch's default clause. */
export const noSwitchDefaultBailout = problem((context) => ({
	ReturnStatement: (node) => {
		if (
			node.argument !== null &&
			isFallbackValue(node.argument) &&
			Arr.some(ancestorsOf(node), isDefaultClause)
		) {
			context.report({
				node,
				message:
					"A switch default cannot silently fall back. Make the switch exhaustive over the closed union with no default: return a value under a declared return type, or use a handler record keyed by the union."
			})
		}
	}
}))
