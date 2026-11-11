import { Array as Arr, Option } from "effect"
import type { AnyNode, Expression, TypeNode } from "#oxlint/rule.ts"

/** A node's ancestors, from its parent up to the program. */
export const ancestorsOf = (node: AnyNode): ReadonlyArray<AnyNode> => {
	const found: Array<AnyNode> = []
	let current = node.parent
	while (current !== null) {
		found.push(current)
		current = current.parent
	}
	return found
}

/** `object.property`, spelled with a dot. */
export const isMember = (node: AnyNode, object: string, property: string): boolean =>
	node.type === "MemberExpression" &&
	!node.computed &&
	node.object.type === "Identifier" &&
	node.object.name === object &&
	node.property.type === "Identifier" &&
	node.property.name === property

/** `object.<one of properties>`, spelled with a dot. */
export const isMemberOf = (
	node: AnyNode,
	object: string,
	properties: ReadonlyArray<string>
): boolean => Arr.some(properties, (property) => isMember(node, object, property))

export const isIdentifierIn = (node: AnyNode, names: ReadonlyArray<string>): boolean =>
	node.type === "Identifier" && Arr.contains(names, node.name)

export const isStringLiteral = (node: AnyNode, accepts: (value: string) => boolean): boolean =>
	node.type === "Literal" && typeof node.value === "string" && accepts(node.value)

export const isRegexLiteral = (node: AnyNode): boolean => node.type === "Literal" && "regex" in node

/** The type arguments a call or a type reference spells, none when it spells none. */
const typeArgumentsOf = (node: AnyNode): ReadonlyArray<TypeNode> => {
	if (node.type !== "CallExpression" && node.type !== "TSTypeReference") {
		return []
	}
	const instantiation = node.typeArguments
	if (instantiation === null || instantiation === undefined) {
		return []
	}
	return instantiation.params
}

/** Exactly one type argument, which `accepts` takes. */
export const hasSoleTypeArgument = (
	node: AnyNode,
	accepts: (type: TypeNode) => boolean
): boolean => {
	const types = typeArgumentsOf(node)
	return types.length === 1 && Arr.every(types, accepts)
}

/** `Effect.withSpan`, `observed`: a dotted or bare callee name, none for any other callee shape. */
export const calleeNameOf = (callee: Expression): Option.Option<string> => {
	if (callee.type === "Identifier") {
		return Option.some(callee.name)
	}
	if (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.object.type === "Identifier" &&
		callee.property.type === "Identifier"
	) {
		return Option.some(`${callee.object.name}.${callee.property.name}`)
	}
	return Option.none()
}

/**
 * The parameters of a function, a method, a signature or a function type, none for any other node. A parameter
 * property is its own parameter's position.
 */
export const parametersOf = (node: AnyNode): ReadonlyArray<AnyNode> => {
	if (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression" ||
		node.type === "TSDeclareFunction" ||
		node.type === "TSEmptyBodyFunctionExpression"
	) {
		return node.params
	}
	if (
		node.type === "TSFunctionType" ||
		node.type === "TSConstructorType" ||
		node.type === "TSMethodSignature" ||
		node.type === "TSCallSignatureDeclaration" ||
		node.type === "TSConstructSignatureDeclaration"
	) {
		return node.params
	}
	return []
}

/** The binding a parameter declares: a parameter property's parameter, else the parameter. */
export const bindingOf = (parameter: AnyNode): AnyNode =>
	parameter.type === "TSParameterProperty" ? parameter.parameter : parameter
