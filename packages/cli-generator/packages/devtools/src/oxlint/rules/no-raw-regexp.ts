import { problem } from "#oxlint/rule.ts"
import { isIdentifierIn, isRegexLiteral } from "#oxlint/syntax.ts"

const MESSAGE =
	"Raw regular expressions are banned. Compile a pattern with arkregex `regex()`, which types its captures, or read the text with a scanner or a typed decoder."

/** Regular expression literals, and RegExp built with `new` or without. */
export const noRawRegexp = problem((context) => ({
	Literal: (node) => {
		if (isRegexLiteral(node)) {
			context.report({ node, message: MESSAGE })
		}
	},
	NewExpression: (node) => {
		if (isIdentifierIn(node.callee, ["RegExp"])) {
			context.report({ node, message: MESSAGE })
		}
	},
	CallExpression: (node) => {
		if (isIdentifierIn(node.callee, ["RegExp"])) {
			context.report({ node, message: MESSAGE })
		}
	}
}))
