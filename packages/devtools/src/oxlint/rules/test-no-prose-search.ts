import { Schema } from "effect"
import { type AnyNode, configured, type NodeOf } from "#oxlint/rule.ts"
import {
	argumentsOf,
	isIdentifierIn,
	isMember,
	isMemberOf,
	isRegexLiteral,
	isStringLiteral,
	readsField
} from "#oxlint/syntax.ts"

/** The project's prose fields beyond an error's message (a reason's sentence), its text helpers that match a text
 * against written text, and the helpers among them that search a text for a part it holds. */
const Options = Schema.Struct({
	fields: Schema.Array(Schema.String),
	textHelpers: Schema.Array(Schema.String),
	searchHelpers: Schema.Array(Schema.String)
})

/** The prose every error carries. */
const ERROR_MESSAGE = "message"

const isWrittenText = (node: AnyNode): boolean =>
	isStringLiteral(node, () => true) ||
	isRegexLiteral(node) ||
	node.type === "TemplateLiteral" ||
	node.type === "TaggedTemplateExpression"

const isJsonText = (node: AnyNode): boolean =>
	node.type === "CallExpression" && isMember(node.callee, "JSON", "stringify")

const MESSAGE =
	"Do not search prose or a JSON text for written text. Assert the typed failure (its _tag, its reason's tag and structured fields), or compare the values themselves."

/**
 * What the testing library's no-error-prose and no-serialized-comparison cannot know: the project's text helpers and
 * its prose fields. A text helper never matches an error's message or a prose field, whose wording is for a person; a
 * search helper never looks for a part in a value's JSON text, whose key order and lossy rendering decide the
 * verdict (a JSON text checked to lack a part, a secret say, stays legal); and a prose field is never matched or
 * compared against written text. An error's message in an assertion is the library's.
 */
export const testNoProseSearch = configured(Options, (context, options) => {
	const searched = [ERROR_MESSAGE, ...options.fields]
	const isProseSearch = (node: NodeOf<"CallExpression">): boolean => {
		const [subject, written] = argumentsOf(node, 2)
		if (subject === undefined) {
			return false
		}
		if (isIdentifierIn(node.callee, options.textHelpers)) {
			return (
				readsField(subject, searched) ||
				(isIdentifierIn(node.callee, options.searchHelpers) && isJsonText(subject))
			)
		}
		return (
			written !== undefined &&
			isMemberOf(node.callee, "assert", ["match", "doesNotMatch", "equal", "notEqual"]) &&
			readsField(subject, options.fields) &&
			isWrittenText(written)
		)
	}
	return {
		CallExpression: (node) => {
			if (isProseSearch(node)) {
				context.report({ node, message: MESSAGE })
			}
		}
	}
})
