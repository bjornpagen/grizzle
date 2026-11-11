import { Array as Arr } from "effect"
import type { CreateRule, Expression, NodeOf } from "#oxlint/rule.ts"

const MESSAGE =
	"An Option is bridged to a sentinel: None became a number that stands for absence, which every reader must remember to test for. Keep it an Option to its consumer (Option.match, Option.map, Option.exists, Option.isSome), or make the absent case a variant of its own. T | undefined through Option.getOrUndefined is fine where the consumer represents absence that way."

/** `-1`, `NaN` or `Number.NaN`: a number standing in for "none". */
const isNumericSentinel = (node: Expression): boolean => {
	if (node.type === "Identifier") {
		return node.name === "NaN"
	}
	if (node.type === "UnaryExpression") {
		return node.operator === "-" && node.argument.type === "Literal" && node.argument.value === 1
	}
	return (
		node.type === "MemberExpression" &&
		!node.computed &&
		node.object.type === "Identifier" &&
		node.object.name === "Number" &&
		node.property.type === "Identifier" &&
		node.property.name === "NaN"
	)
}

/** Whether one import specifier binds Effect's Option module: the barrel's `Option` under any alias, or a namespace
 * import of `effect/Option`. */
const bindsOption = (
	source: string,
	specifier: NodeOf<"ImportDeclaration">["specifiers"][number]
): boolean =>
	(source === "effect" &&
		specifier.type === "ImportSpecifier" &&
		specifier.imported.type === "Identifier" &&
		specifier.imported.name === "Option") ||
	(source === "effect/Option" && specifier.type === "ImportNamespaceSpecifier")

/** What a thunk evaluates to: an arrow's expression body, or the one return of an arrow's or a function
 * expression's block that only returns. */
const thunkResults = (node: Expression): ReadonlyArray<Expression> => {
	if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") {
		return []
	}
	const body = node.body
	if (body === null) {
		return []
	}
	if (body.type !== "BlockStatement") {
		return [body]
	}
	const [statement, ...rest] = body.body
	return statement !== undefined &&
		rest.length === 0 &&
		statement.type === "ReturnStatement" &&
		statement.argument !== null
		? [statement.argument]
		: []
}

/**
 * The bridge from an Option to a sentinel: `getOrElse` whose thunk returns `-1` or `NaN`, an Option allocated only to
 * turn back into a number that stands for absence. The rule follows the file's own binding of Effect's Option (the
 * barrel's `Option` under any alias, or a namespace import of `effect/Option`), so an unrelated `Option` is not read as
 * Effect's. `""` and `0` stay legal defaults, and `getOrUndefined`, `getOrNull` and a `getOrElse` to `undefined` or
 * `null` stay legal: `T | undefined` is a representation of absence, not a sentinel.
 */
export const noOptionBridge: CreateRule = {
	meta: { type: "problem" },
	create: (context) => {
		const optionNames = new Set<string>()
		const isGetOrElse = (node: Expression): boolean =>
			node.type === "MemberExpression" &&
			!node.computed &&
			node.object.type === "Identifier" &&
			optionNames.has(node.object.name) &&
			node.property.type === "Identifier" &&
			node.property.name === "getOrElse"
		return {
			ImportDeclaration: (node) => {
				for (const specifier of node.specifiers) {
					if (bindsOption(node.source.value, specifier)) {
						optionNames.add(specifier.local.name)
					}
				}
			},
			CallExpression: (node) => {
				const returnsSentinel = Arr.some(
					node.arguments,
					(argument) =>
						argument.type !== "SpreadElement" && Arr.some(thunkResults(argument), isNumericSentinel)
				)
				if (isGetOrElse(node.callee) && returnsSentinel) {
					context.report({ node, message: MESSAGE })
				}
			}
		}
	}
}
