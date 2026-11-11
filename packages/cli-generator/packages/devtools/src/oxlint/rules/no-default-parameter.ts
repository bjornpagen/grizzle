import { problem } from "#oxlint/rule.ts"
import { bindingOf, parametersOf } from "#oxlint/syntax.ts"

/** A parameter's own default, `(a = 1)`, in every function, method and signature; a destructured default is none. */
export const noDefaultParameter = problem((context) => ({
	"*": (node) => {
		for (const parameter of parametersOf(node)) {
			if (bindingOf(parameter).type === "AssignmentPattern") {
				context.report({
					node: parameter,
					message:
						"A default parameter is a fallback. Make the argument required, or model the absence as a variant the caller chooses."
				})
			}
		}
	}
}))
