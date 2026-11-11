import { Array as Arr, Option, Predicate, String as Str } from "effect"
import * as ts from "typescript/ast"
import type { Type } from "typescript/sync"
import type { Semantics } from "#shared/semantic.ts"

/** The file a node of the program belongs to, by the name the compiler gives it. */
export const fileOf = (node: ts.Node): string => node.getSourceFile().fileName

/** The text of a name written as an identifier or a string literal. */
export const literalTextOf = (node: ts.Node): Option.Option<string> =>
	ts.isStringLiteralLikeNode(node) || ts.isIdentifier(node) ? Option.some(node.text) : Option.none()

/** A function declaration, a method or a method signature: a callable declared directly, under a name of its own. */
const isNamedSignature = Predicate.or(
	ts.isFunctionDeclaration,
	Predicate.or(ts.isMethodDeclaration, ts.isMethodSignatureDeclaration)
)

/** The own name of a declared function, method or method signature. */
export const declaredNameOf = (declaration: ts.Node): Option.Option<string> =>
	isNamedSignature(declaration)
		? Option.flatMap(Option.fromUndefinedOr(declaration.name), literalTextOf)
		: Option.none()

/** The signature a call or tagged template resolves to: its declaration, the declaration's file and own name. */
export type Resolution = Readonly<{
	declaration: ts.Node
	file: string
	name: Option.Option<string>
}>

/** The signature the checker resolves a call or tagged template to, if it resolves to a declaration. */
export const resolutionAt = (semantics: Semantics, node: ts.Node): Option.Option<Resolution> =>
	Option.map(Option.fromUndefinedOr(semantics.signatureDeclarationAt(node)), (declaration) => ({
		declaration,
		file: fileOf(declaration),
		name: declaredNameOf(declaration)
	}))

/** Whether a call or tagged template resolves to the function Drizzle declares under `name`; the declaration decides,
 * so renamed and namespace imports count. */
export const isDrizzleFunction = (semantics: Semantics, node: ts.Node, name: string): boolean => {
	const declaration = semantics.signatureDeclarationAt(node)
	return (
		declaration !== undefined &&
		ts.isFunctionDeclaration(declaration) &&
		Str.includes("/drizzle-orm/")(fileOf(declaration)) &&
		Option.contains(declaredNameOf(declaration), name)
	)
}

/** A Drizzle `sql` tagged template. */
export const isDrizzleSqlTemplate = (
	semantics: Semantics,
	node: ts.Node
): node is ts.TaggedTemplateExpression =>
	ts.isTaggedTemplateExpression(node) && isDrizzleFunction(semantics, node, "sql")

/** Whether a declaration file belongs to Drizzle or to node-postgres. */
const isDatabasePackageFile = (file: string): boolean =>
	Str.includes("/drizzle-orm/")(file) ||
	Str.includes("/@types/pg/")(file) ||
	Str.includes("/pg/")(file)

/**
 * A call whose callee is declared only as functions or methods outside Drizzle and node-postgres: such a callee owns
 * every signature it can resolve to, so its call is no database call and needs no signature resolved. A value binding
 * may carry a foreign callable, so a call through one is never unrelated.
 */
export const isUnrelatedCall = (semantics: Semantics, node: ts.CallExpression): boolean => {
	const symbol = semantics.symbolAt(node.expression)
	if (symbol === undefined) {
		return false
	}
	const declarations = semantics.declarationsOf(semantics.aliasTarget(symbol))
	return (
		Arr.isReadonlyArrayNonEmpty(declarations) &&
		Arr.every(
			declarations,
			(declaration) => isNamedSignature(declaration) && !isDatabasePackageFile(fileOf(declaration))
		)
	)
}

/** Whether a type is, or has a union member that is, Drizzle's `SQL`. */
export const isRawSqlType = (type: Type): boolean => {
	if (type.isUnionType()) {
		return Arr.some(type.getTypes(), isRawSqlType)
	}
	const symbol = type.getSymbol()
	return (
		symbol?.name === "SQL" &&
		Arr.some(symbol.declarations, (declaration) =>
			Str.includes("/drizzle-orm/sql/")(declaration.path)
		)
	)
}

/** The nearest node at or above `node`, below the source file, that `matches`. */
const ancestorOf = <T extends ts.Node>(
	node: ts.Node,
	matches: (candidate: ts.Node) => candidate is T
): Option.Option<T> => {
	let current = node
	while (!ts.isSourceFile(current)) {
		if (matches(current)) {
			return Option.some(current)
		}
		current = current.parent
	}
	return Option.none()
}

const isTopLevelDeclaration = (node: ts.Node): node is ts.VariableDeclaration =>
	ts.isVariableDeclaration(node) &&
	ts.isVariableDeclarationList(node.parent) &&
	ts.isVariableStatement(node.parent.parent) &&
	ts.isSourceFile(node.parent.parent.parent)

/** The name of the top-level variable whose initializer holds `node`. */
export const topLevelNameOf = (node: ts.Node): Option.Option<string> =>
	Option.flatMap(ancestorOf(node, isTopLevelDeclaration), (declaration) =>
		ts.isIdentifier(declaration.name) ? Option.some(declaration.name.text) : Option.none()
	)

/** Whether a node sits inside a function or other signature, below its file's top level. */
export const isEnclosedByFunction = (node: ts.Node): boolean =>
	Option.isSome(
		ancestorOf(node.parent, Predicate.or(ts.isSignatureDeclaration, ts.isJSDocSignature))
	)

/** The expression beneath parentheses, assertions and non-null marks. */
export const unwrapped = (expression: ts.Expression): ts.Expression =>
	ts.isParenthesizedExpression(expression) ||
	ts.isAsExpression(expression) ||
	ts.isSatisfiesExpression(expression) ||
	ts.isTypeAssertion(expression) ||
	ts.isNonNullExpression(expression)
		? unwrapped(expression.expression)
		: expression

/** A template's interpolations, each with the literal text written right before it. */
export const interpolationsOf = (
	template: ts.TemplateExpression
): ReadonlyArray<Readonly<{ span: ts.TemplateSpan; before: string }>> =>
	Arr.map(template.templateSpans, (span, index) => ({
		span,
		before: Option.match(Arr.get(template.templateSpans, index - 1), {
			onNone: () => template.head.text,
			onSome: (previous) => previous.literal.text
		})
	}))
