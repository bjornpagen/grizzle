import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { isErrorText } from "#oxlint/rules/no-error-prose.ts"
import { EQUALITIES, isCallTo, sidesOf, valueOf } from "#oxlint/syntax.ts"

/** The calls that serialize a value to text. */
const SERIALIZATIONS: ReadonlyArray<string> = [
	"Formatter.format",
	"Formatter.formatJson",
	"Inspectable.toStringUnknown",
	"JSON.stringify",
	"String"
]

const isToString = (node: AnyNode): boolean =>
	node.type === "CallExpression" &&
	Arr.isReadonlyArrayEmpty(node.arguments) &&
	node.callee.type === "MemberExpression" &&
	!node.callee.computed &&
	node.callee.property.name === "toString"

/** A value serialized to text. An error's text is no-error-prose's, which names the typed failure instead. */
const isSerialized = (context: Context, node: AnyNode): boolean => {
	const value = valueOf(context, node)
	return (
		(isCallTo(context, value, SERIALIZATIONS) || isToString(value)) && !isErrorText(context, value)
	)
}

/** A template literal that renders values into the text it compares. */
const isRendered = (context: Context, node: AnyNode): boolean => {
	const value = valueOf(context, node)
	return value.type === "TemplateLiteral" && Arr.isReadonlyArrayNonEmpty(value.expressions)
}

/** The operators that compare two values for equality. */
const EQUALITY_OPERATORS: ReadonlyArray<string> = ["===", "!==", "==", "!="]

/**
 * A comparison of values through their text: an equality assertion with a serialization on either side, or the value
 * under test rendered into a template literal, and an equality operator with a serialization on either side. On an
 * assertion's expected side a template literal builds the expected text of an answer that is text, which stays legal.
 */
export const noSerializedComparison = refusal(
	"serialized",
	"This compares values through their text, where key order, formatting and lossy rendering decide the verdict. Compare the values themselves with agree(…) under a named equivalence such as exact.",
	(context, refuse) => ({
		CallExpression: (node) => {
			const serialized = Option.exists(
				sidesOf(context, node, EQUALITIES),
				([actual, expected]) =>
					isSerialized(context, actual) ||
					isSerialized(context, expected) ||
					isRendered(context, actual)
			)
			if (serialized) {
				refuse(node)
			}
		},
		BinaryExpression: (node) => {
			if (
				Arr.contains(EQUALITY_OPERATORS, node.operator) &&
				(isSerialized(context, node.left) || isSerialized(context, node.right))
			) {
				refuse(node)
			}
		}
	})
)
