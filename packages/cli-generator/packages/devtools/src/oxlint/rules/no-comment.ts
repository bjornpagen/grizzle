import { Array as Arr, Option, String as Str } from "effect"
import { isSuppression, withoutLead } from "#oxlint/comments.ts"
import type { AnyNode, Comment, Context, CreateRule, NodeOf } from "#oxlint/rule.ts"
import { ancestorsOf } from "#oxlint/syntax.ts"

/** A stretch of the file's text. */
type Span = Readonly<{ start: number; end: number }>

/** The leads of the comments a tool reads: legal notices, bundler annotations, formatter ignores and the JSX pragma.
 * A directive counts only where it begins the comment. */
const KEPT_LEADS: ReadonlyArray<string> = [
	"@license",
	"@preserve",
	"#__PURE__",
	"@__PURE__",
	"#__NO_SIDE_EFFECTS__",
	"@__NO_SIDE_EFFECTS__",
	"oxfmt-ignore",
	"prettier-ignore",
	"@jsxImportSource"
]

/** The bundlers whose magic comments (`webpackChunkName: "x"`) steer a dynamic import. */
const MAGIC_PREFIXES: ReadonlyArray<string> = ["webpack", "turbopack"]

const isUpper = (character: string): boolean => character >= "A" && character <= "Z"

const isWordCharacter = (character: string): boolean =>
	isUpper(character) ||
	(character >= "a" && character <= "z") ||
	(character >= "0" && character <= "9") ||
	character === "_"

/** `webpackChunkName:` or `turbopackOptional :`: a bundler prefix, a capitalised word, then a colon. */
const isMagicComment = (lead: string): boolean =>
	Arr.some(MAGIC_PREFIXES, (prefix) => {
		if (!Str.startsWith(prefix)(lead)) {
			return false
		}
		const rest = Str.split("")(Str.slice(prefix.length)(lead))
		if (!Option.exists(Arr.head(rest), isUpper)) {
			return false
		}
		const afterWord = Arr.dropWhile(rest, isWordCharacter)
		const afterSpace = Arr.dropWhile(afterWord, (character) => character === " ")
		return Option.contains(Arr.head(afterSpace), ":")
	})

/** A comment a tool reads: a legal notice, a triple-slash directive, a bundler annotation or magic comment, a
 * formatter ignore, the JSX pragma, or a directive another rule owns (suppressions, TypeScript's `@ts-` comments). */
const isToolComment = (comment: Comment): boolean => {
	const lead = withoutLead(comment.value)
	if (comment.type === "Block" && Str.startsWith("!")(comment.value)) {
		return true
	}
	if (
		comment.type === "Line" &&
		Str.startsWith("/")(comment.value) &&
		Str.startsWith("<")(Str.trimStart(Str.slice(1)(comment.value)))
	) {
		return true
	}
	return (
		Arr.some(KEPT_LEADS, (kept) => Str.startsWith(kept)(lead)) ||
		isMagicComment(lead) ||
		Str.startsWith("@ts-")(lead) ||
		isSuppression(comment)
	)
}

const isJsDocBlock = (comment: Comment): boolean =>
	comment.type === "Block" && Str.startsWith("*")(comment.value)

/** The declarations JSDoc documents, as TypeScript attaches a `/**` block to the node it precedes. */
const DECLARATIONS: ReadonlyArray<string> = [
	"VariableDeclaration",
	"VariableDeclarator",
	"FunctionDeclaration",
	"TSDeclareFunction",
	"ClassDeclaration",
	"TSInterfaceDeclaration",
	"TSTypeAliasDeclaration",
	"TSEnumDeclaration",
	"TSEnumMember",
	"TSModuleDeclaration",
	"TSGlobalDeclaration",
	"ImportDeclaration",
	"TSImportEqualsDeclaration",
	"ExportNamedDeclaration",
	"ExportDefaultDeclaration",
	"ExportAllDeclaration",
	"TSExportAssignment",
	"TSNamespaceExportDeclaration",
	"Property",
	"PropertyDefinition",
	"TSAbstractPropertyDefinition",
	"AccessorProperty",
	"TSAbstractAccessorProperty",
	"TSPropertySignature",
	"MethodDefinition",
	"TSAbstractMethodDefinition",
	"TSMethodSignature",
	"StaticBlock",
	"TSParameterProperty",
	"TSTypeParameter",
	"TSIndexSignature",
	"TSCallSignatureDeclaration",
	"TSConstructSignatureDeclaration"
]

/** A parameter of its function, or an element of an array binding pattern: declarations without a type of their own. */
const isBindingPosition = (node: AnyNode): boolean => {
	const parent = node.parent
	if (parent === null) {
		return false
	}
	if (parent.type === "ArrayPattern") {
		return true
	}
	if (!("params" in parent)) {
		return false
	}
	const parameters: ReadonlyArray<AnyNode> = parent.params
	return Arr.some(parameters, (parameter) => parameter === node)
}

const isDeclaration = (node: AnyNode): boolean =>
	Arr.contains(DECLARATIONS, node.type) || isBindingPosition(node)

/** Whether a `/**` block documents a declaration: the first token after it begins one. */
const documentsDeclaration = (context: Context, comment: Comment): boolean => {
	const next = context.sourceCode.getTokenAfter(comment)
	if (next === null) {
		return false
	}
	const node = context.sourceCode.getNodeByRangeIndex(next.start)
	if (node === null) {
		return false
	}
	const starting = Arr.takeWhile([node, ...ancestorsOf(node)], (each) => each.start === next.start)
	return Arr.some(starting, isDeclaration)
}

/** JSX text renders unless it is only whitespace with a line break, which JSX drops. */
const isRenderedText = (child: AnyNode | undefined): boolean =>
	child?.type === "JSXText" &&
	!(Str.isEmpty(Str.trim(child.value)) && Str.includes("\n")(child.value))

/** The JSX expression container a comment sits in when the container holds nothing but comments. */
const emptyContainerOf = (
	context: Context,
	comment: Comment
): Option.Option<NodeOf<"JSXExpressionContainer">> => {
	const node = context.sourceCode.getNodeByRangeIndex(comment.start)
	if (node === null) {
		return Option.none()
	}
	const container = node.type === "JSXEmptyExpression" ? node.parent : node
	return container.type === "JSXExpressionContainer" &&
		container.expression.type === "JSXEmptyExpression"
		? Option.some(container)
		: Option.none()
}

/** Whether rendered JSX text sits right before or after a child of a JSX element or fragment. */
const isBesideText = (container: NodeOf<"JSXExpressionContainer">): boolean => {
	const parent = container.parent
	if (parent.type !== "JSXElement" && parent.type !== "JSXFragment") {
		return false
	}
	return Option.match(
		Arr.findFirstIndex(parent.children, (child) => child === container),
		{
			onNone: () => false,
			onSome: (index) =>
				isRenderedText(parent.children[index - 1]) || isRenderedText(parent.children[index + 1])
		}
	)
}

const isBlank = (text: string): boolean => Str.isEmpty(Str.trim(text))

const lineStartOf = (text: string, position: number): number =>
	Option.match(Str.lastIndexOf("\n")(Str.slice(0, position)(text)), {
		onNone: () => 0,
		onSome: (offset) => offset + 1
	})

const lineEndOf = (text: string, position: number): number =>
	Option.match(Str.indexOf("\n")(Str.slice(position)(text)), {
		onNone: () => text.length,
		onSome: (offset) => position + offset
	})

/** What deleting a span takes with it: its whole line when nothing else is on it, the spaces before it when it
 * trails code, the spaces after it when code follows, and one space between code on both sides. */
const removalOf = (text: string, span: Span): Span => {
	const lineStart = lineStartOf(text, span.start)
	const lineEnd = lineEndOf(text, span.end)
	const before = Str.slice(lineStart, span.start)(text)
	const after = Str.slice(span.end, lineEnd)(text)
	if (isBlank(before) && isBlank(after)) {
		return { start: lineStart, end: Math.min(lineEnd + 1, text.length) }
	}
	if (isBlank(after)) {
		return { start: lineStart + Str.trimEnd(before).length, end: span.end }
	}
	if (isBlank(before)) {
		return { start: span.start, end: span.end + (after.length - Str.trimStart(after).length) }
	}
	const spaced = Str.endsWith(" ")(before) && Str.startsWith(" ")(after)
	return { start: span.start, end: spaced ? span.end + 1 : span.end }
}

export const STRIP_MESSAGE =
	"Comments are stripped: names and types carry the meaning, and JSDoc on a declaration documents it. Delete this comment (oxlint --fix deletes it)."

export const DETACHED_MESSAGE =
	"This /** block documents no declaration, so nothing reads it as JSDoc. Move it onto the declaration it documents, or delete it."

export const BESIDE_TEXT_MESSAGE =
	"This comment-only JSX expression sits beside JSX text, so deleting it changes the rendered text. Delete it by hand and set the text around it as it should render."

/**
 * Every comment but JSDoc on a declaration and the comments a tool reads. A comment it can delete safely it deletes,
 * with the text its deletion takes: its line when it stands alone, the spaces beside it otherwise; a JSX expression
 * that holds only comments goes whole. A `/**` block that documents no declaration, and a comment-only JSX expression
 * beside rendered text, it reports without a fix: deleting the first loses documentation meant for a declaration, and
 * deleting the second changes the rendered text. A shebang is no comment.
 */
export const noComment: CreateRule = {
	meta: { type: "suggestion", fixable: "code" },
	create: (context) => ({
		Program: () => {
			const { text } = context.sourceCode
			const strip = (comment: Comment, span: Span): void => {
				const removal = removalOf(text, span)
				context.report({
					node: comment,
					message: STRIP_MESSAGE,
					fix: (fixer) => fixer.removeRange([removal.start, removal.end])
				})
			}
			for (const comment of context.sourceCode.getAllComments()) {
				if (comment.type === "Shebang" || isToolComment(comment)) {
					continue
				}
				if (isJsDocBlock(comment)) {
					if (!documentsDeclaration(context, comment)) {
						context.report({ node: comment, message: DETACHED_MESSAGE })
					}
					continue
				}
				const container = emptyContainerOf(context, comment)
				if (Option.isNone(container)) {
					strip(comment, comment)
				} else if (isBesideText(container.value)) {
					context.report({ node: comment, message: BESIDE_TEXT_MESSAGE })
				} else {
					strip(comment, container.value)
				}
			}
		}
	})
}
