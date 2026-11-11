import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { enclosingFunctionOf, isNamed, testPathOf, valueOf } from "#oxlint/syntax.ts"

/** The modifiers that run one test or suite per row of a table. */
const TABLES: ReadonlyArray<string> = ["each", "for"]

const isTablePath = (path: ReadonlyArray<string>): boolean =>
	Option.exists(Arr.last(path), (last) => Arr.contains(TABLES, last))

/** Rows written out: an array literal, or a `const` that holds one. */
const isRows = (context: Context, node: AnyNode): boolean =>
	valueOf(context, node).type === "ArrayExpression"

/** A function handed to a suite or test as its body. */
const isTestCallback = (context: Context, fn: AnyNode): boolean => {
	const call = fn.parent
	return (
		call?.type === "CallExpression" &&
		Arr.some(call.arguments, (argument) => argument === fn) &&
		Option.exists(testPathOf(context, call.callee), (path) => !isTablePath(path))
	)
}

/** The body of a suite or a test: its callback, or the generator of an `Effect.gen` that callback runs. */
const isTestBody = (context: Context, fn: AnyNode): boolean => {
	if (isTestCallback(context, fn)) {
		return true
	}
	const call = fn.parent
	return (
		call?.type === "CallExpression" &&
		isNamed(context, call.callee, ["Effect.gen"]) &&
		Option.exists(enclosingFunctionOf(call), (outer) => isTestCallback(context, outer))
	)
}

/**
 * Example tables: a suite or test run per row of written-out rows (`it.each([...])`, `it.effect.each`, `describe.each`,
 * `test.for`, and their tagged-template tables), and a `for…of` over written-out rows in a suite's or a test's body.
 * Fixed inputs paired with expected outputs check only the rows someone thought of.
 */
export const noExampleTable = refusal(
	"exampleTable",
	"This is an example table: fixed inputs paired with expected outputs check only the rows someone thought of. State the property over the whole finite space with exhaust over element([...]), or over generated inputs with explore.",
	(context, refuse) => ({
		CallExpression: (node) => {
			if (
				Option.exists(testPathOf(context, node.callee), isTablePath) &&
				Option.exists(Arr.head(node.arguments), (rows) => isRows(context, rows))
			) {
				refuse(node)
			}
		},
		TaggedTemplateExpression: (node) => {
			if (Option.exists(testPathOf(context, node.tag), isTablePath)) {
				refuse(node)
			}
		},
		ForOfStatement: (node) => {
			if (
				isRows(context, node.right) &&
				Option.exists(enclosingFunctionOf(node), (fn) => isTestBody(context, fn))
			) {
				refuse(node)
			}
		}
	})
)
