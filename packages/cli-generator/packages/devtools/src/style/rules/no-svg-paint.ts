import { Array as Arr, Option, String as Str } from "effect"
import * as ts from "typescript/ast"
import type { Report } from "#shared/finding.ts"
import type { Semantics } from "#shared/semantic.ts"
import { hasLiteralColor } from "#style/css.ts"

/** SVG paint attributes, in JSX and native spelling. */
const PAINT_ATTRIBUTES: ReadonlyArray<string> = ["fill", "stroke", "stopColor", "stop-color"]

/** Paint keywords that name no palette color, so they carry no second home for one. */
const PAINT_KEYWORDS: ReadonlyArray<string> = ["none", "currentColor", "transparent", "inherit"]

type Paint = Readonly<{ node: ts.Node; text: string }>

/** The variable a name refers to, when its one declaration gives it a value. */
const definitionOf = (semantics: Semantics, name: ts.Identifier): Option.Option<ts.Expression> => {
	const symbol = semantics.symbolAt(name)
	if (symbol === undefined) {
		return Option.none()
	}
	const declarations = semantics.declarationsOf(semantics.aliasTarget(symbol))
	return Option.flatMap(
		declarations.length === 1 ? Arr.head(declarations) : Option.none(),
		(declaration) =>
			ts.isVariableDeclaration(declaration)
				? Option.fromUndefinedOr(declaration.initializer)
				: Option.none()
	)
}

/** Every literal paint an attribute value can produce, through the variables it names. */
const paintsOf = (
	semantics: Semantics,
	node: ts.Expression,
	seen: ReadonlySet<ts.Node>
): ReadonlyArray<Paint> => {
	if (ts.isStringLiteralLikeNode(node)) {
		return [{ node, text: node.text }]
	}
	if (ts.isTemplateExpression(node)) {
		return [{ node, text: node.head.text }]
	}
	if (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isSatisfiesExpression(node)
	) {
		return paintsOf(semantics, node.expression, seen)
	}
	if (ts.isConditionalExpression(node)) {
		return [
			...paintsOf(semantics, node.whenTrue, seen),
			...paintsOf(semantics, node.whenFalse, seen)
		]
	}
	if (ts.isBinaryExpression(node)) {
		return [...paintsOf(semantics, node.left, seen), ...paintsOf(semantics, node.right, seen)]
	}
	if (!ts.isIdentifier(node)) {
		return []
	}
	return Option.match(
		Option.filter(definitionOf(semantics, node), (definition) => !seen.has(definition)),
		{
			onNone: () => [],
			onSome: (definition) => paintsOf(semantics, definition, new Set([...seen, definition]))
		}
	)
}

/** A paint that names a color: a literal color, a variable, or anything but a keyword or a paint server
 * reference (a gradient, pattern or mask by id, which is structure). */
const isColorPaint = (text: string): boolean =>
	hasLiteralColor(text) ||
	Str.includes("var(")(text) ||
	!(Arr.contains(PAINT_KEYWORDS, text) || Str.startsWith("url(")(text))

const attributeNameOf = (attribute: ts.JsxAttribute): Option.Option<string> =>
	ts.isIdentifier(attribute.name) ? Option.some(attribute.name.text) : Option.none()

const attributeValueOf = (attribute: ts.JsxAttribute): Option.Option<ts.Expression> => {
	const initializer = attribute.initializer
	if (initializer === undefined) {
		return Option.none()
	}
	return ts.isJsxExpression(initializer)
		? Option.fromUndefinedOr(initializer.expression)
		: Option.some(initializer)
}

/** Palette colors belong to `fill-*`, `stroke-*` and `text-*` classes; paint attributes only name structure. */
export const noSvgPaint = (
	input: Readonly<{ sourceFile: ts.SourceFile; semantics: Semantics }>
): ReadonlyArray<Report> => {
	if (!Str.endsWith(".tsx")(input.sourceFile.fileName)) {
		return []
	}
	const reports: Array<Report> = []
	const walk = (node: ts.Node): void => {
		const name = ts.isJsxAttribute(node) ? attributeNameOf(node) : Option.none()
		if (
			ts.isJsxAttribute(node) &&
			Option.exists(name, (found) => Arr.contains(PAINT_ATTRIBUTES, found))
		) {
			const paints = Option.match(attributeValueOf(node), {
				onNone: (): ReadonlyArray<Paint> => [],
				onSome: (value) => paintsOf(input.semantics, value, new Set<ts.Node>())
			})
			for (const paint of Arr.filter(paints, (found) => isColorPaint(found.text))) {
				reports.push({
					node: paint.node,
					message: `SVG ${Option.getOrElse(name, () => "paint")}="${paint.text}" is a second home for a palette color.`,
					suggestion: "Use a fill-*, stroke-* or text-* class, with currentColor on the attribute."
				})
			}
		}
		node.forEachChild(walk)
	}
	walk(input.sourceFile)
	return reports
}
