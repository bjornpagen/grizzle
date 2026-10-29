import { Array as Arr } from "effect"
import * as ts from "typescript/ast"

const writtenTypeHas = (
	typeNode: ts.TypeNode,
	matches: (node: ts.TypeNode) => boolean
): boolean => {
	if (ts.isParenthesizedTypeNode(typeNode)) {
		return writtenTypeHas(typeNode.type, matches)
	}
	if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
		return Arr.some(typeNode.types, (member) => writtenTypeHas(member, matches))
	}
	return matches(typeNode)
}

/**
 * Whether a written type carries null, read off the type node's `null` keyword through parentheses, unions and
 * intersections. Never off typeToString: matching its text false-positives on the literal "null" and on names that
 * merely contain the word.
 */
export const writtenTypeHasNull = (typeNode: ts.TypeNode): boolean =>
	writtenTypeHas(
		typeNode,
		(node) =>
			node.kind === ts.SyntaxKind.NullKeyword ||
			(ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword)
	)

/** Whether a written type carries undefined, read off the type node as writtenTypeHasNull reads null. */
export const writtenTypeHasUndefined = (typeNode: ts.TypeNode): boolean =>
	writtenTypeHas(
		typeNode,
		(node) =>
			node.kind === ts.SyntaxKind.UndefinedKeyword ||
			(ts.isTypeReferenceNode(node) &&
				ts.isIdentifier(node.typeName) &&
				node.typeName.text === "undefined")
	)
