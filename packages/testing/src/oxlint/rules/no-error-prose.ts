import { Array as Arr, Option, String as Str } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import {
	assertionOf,
	EQUALITIES,
	isCallTo,
	isLiteralOf,
	isNamed,
	propertiesNamed,
	valueOf
} from "#oxlint/syntax.ts"

/** The names an error goes by, whole or as a suffix. */
const ERROR_NAMES: ReadonlyArray<string> = [
	"cause",
	"defect",
	"e",
	"err",
	"error",
	"exception",
	"failure"
]
const ERROR_SUFFIXES: ReadonlyArray<string> = ["Cause", "Defect", "Error", "Exception", "Failure"]

const isErrorName = (name: string): boolean =>
	Arr.contains(ERROR_NAMES, name) ||
	Arr.some(ERROR_SUFFIXES, (suffix) => Str.endsWith(suffix)(name))

/** A value named as an error: a binding or a field called `error`, `cause`, `failure` or `…Error`. */
const isErrorLike = (node: AnyNode): boolean => {
	if (node.type === "Identifier") {
		return isErrorName(node.name)
	}
	return node.type === "MemberExpression" && !node.computed && isErrorName(node.property.name)
}

/** The calls that render any value as text. */
const RENDERINGS: ReadonlyArray<string> = [
	"Formatter.format",
	"Inspectable.toStringUnknown",
	"String"
]

/**
 * Text written for a person about a failure: an error's `.message`, a pretty-printed Cause, or an error rendered by
 * `String`, `toString`, `Formatter.format` or `Inspectable.toStringUnknown`.
 */
export const isErrorText = (context: Context, node: AnyNode): boolean => {
	const value = valueOf(context, node)
	if (value.type === "MemberExpression") {
		return !value.computed && value.property.name === "message"
	}
	if (value.type !== "CallExpression") {
		return false
	}
	if (isNamed(context, value.callee, ["Cause.pretty", "Cause.prettyErrors"])) {
		return true
	}
	const callee = valueOf(context, value.callee)
	if (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.property.name === "toString"
	) {
		return isErrorLike(valueOf(context, callee.object))
	}
	return (
		isCallTo(context, value, RENDERINGS) &&
		Option.exists(Arr.head(value.arguments), (rendered) => isErrorLike(valueOf(context, rendered)))
	)
}

const isRegex = (node: AnyNode): boolean => node.type === "Literal" && "regex" in node

const isWrittenText = (node: AnyNode): boolean =>
	isLiteralOf(node, ["string"]) || isRegex(node) || node.type === "TemplateLiteral"

const holdsMessage = (node: AnyNode): boolean =>
	Arr.isReadonlyArrayNonEmpty(propertiesNamed(node, "message"))

/** A check of one family of assertions, handed the value under test and the matcher's first argument. */
type Check = (context: Context, actual: AnyNode, expected: AnyNode) => boolean

/**
 * Each assertion family and how it reads error text. An equality between two error texts is a differential, which
 * stays legal: only one compared against something else is prose.
 */
const CHECKS: ReadonlyArray<readonly [ReadonlyArray<string>, Check]> = [
	[
		EQUALITIES,
		(context, actual, expected) => isErrorText(context, actual) !== isErrorText(context, expected)
	],
	[
		["assertInclude", "assertMatch", "doesNotMatch", "match", "toContain", "toMatch"],
		(context, actual) => isErrorText(context, actual)
	],
	[
		["toThrow", "toThrowError"],
		(context, _actual, expected) => {
			const matcher = valueOf(context, expected)
			return isWrittenText(matcher) || holdsMessage(matcher)
		}
	],
	[
		["rejects", "throws", "throwsAsync"],
		(context, _actual, expected) => {
			const matcher = valueOf(context, expected)
			return isRegex(matcher) || holdsMessage(matcher)
		}
	],
	[
		["toHaveProperty"],
		(context, _actual, expected) => {
			const property = valueOf(context, expected)
			return property.type === "Literal" && property.value === "message"
		}
	]
]

/**
 * Assertions about the text of an error: comparing or matching an error's message, its rendering or a pretty-printed
 * Cause, a thrown-error matcher given written text or a `message`, and `toHaveProperty("message", …)`. The text is
 * prose for a person; the contract is the typed failure.
 */
export const noErrorProse = refusal(
	"errorProse",
	"This asserts an error's text, which is prose for a person and changes for innocuous reasons. Assert the typed failure instead: its _tag and its fields.",
	(context, refuse) => ({
		CallExpression: (node) => {
			const prose = Option.exists(assertionOf(context, node), ({ name, subjects }) => {
				const [actual, expected] = subjects
				return (
					actual !== undefined &&
					expected !== undefined &&
					Arr.some(
						CHECKS,
						([names, check]) => Arr.contains(names, name) && check(context, actual, expected)
					)
				)
			})
			if (prose) {
				refuse(node)
			}
		}
	})
)
