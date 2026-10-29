import { type AnyNode, problem } from "#oxlint/rule.ts"
import { bindingOf, parametersOf } from "#oxlint/syntax.ts"

/**
 * oxlint's typings declare a binding's `optional` as never true, while the parser sets it on an optional parameter;
 * the flag is read as the value it is at run time.
 */
const isSet = (flag: unknown): boolean => flag === true

const isOptionalParameter = (parameter: AnyNode): boolean => {
	const binding = bindingOf(parameter)
	if (
		binding.type === "Identifier" ||
		binding.type === "ObjectPattern" ||
		binding.type === "ArrayPattern"
	) {
		return isSet(binding.optional)
	}
	return false
}

/** Optional parameters, in every function, method, signature and function type. */
export const noOptionalParameter = problem((context) => ({
	"*": (node) => {
		for (const parameter of parametersOf(node)) {
			if (isOptionalParameter(parameter)) {
				context.report({
					node: parameter,
					message:
						"An optional parameter is a fallback. Make it required; where absence is a real case, the caller passes the variant that says so."
				})
			}
		}
	}
}))
