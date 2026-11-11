import { problem } from "#oxlint/rule.ts"
import { isIdentifierIn } from "#oxlint/syntax.ts"

const ERROR_CONSTRUCTORS: ReadonlyArray<string> = [
	"Error",
	"TypeError",
	"RangeError",
	"EvalError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"AggregateError",
	"SuppressedError"
]

const MESSAGE =
	"Constructing a built-in Error is banned in Effect-free code. An expected failure is a typed value the caller matches (a Result or a variant); a broken internal invariant goes through the project's one invariant door."

/**
 * Every construction of a built-in Error, with `new` or without. It is enabled only on Effect-free code: where Effect
 * runs, its globalErrorInEffectFailure, globalErrorInEffectCatch and extendsNativeError diagnostics own the ban.
 */
export const noNewError = problem((context) => ({
	NewExpression: (node) => {
		if (isIdentifierIn(node.callee, ERROR_CONSTRUCTORS)) {
			context.report({ node, message: MESSAGE })
		}
	},
	CallExpression: (node) => {
		if (isIdentifierIn(node.callee, ERROR_CONSTRUCTORS)) {
			context.report({ node, message: MESSAGE })
		}
	}
}))
