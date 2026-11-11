import { Array as Arr, Option, String as Str } from "effect"
import type { AnyNode, Context, NodeOf } from "#oxlint/rule.ts"

type Scope = ReturnType<Context["sourceCode"]["getScope"]>
type Variable = Scope["variables"][number]
type Definition = Variable["defs"][number]

/** A node with TypeScript's annotations, parentheses and optional chaining looked through. */
const bare = (node: AnyNode): AnyNode =>
	node.type === "TSAsExpression" ||
	node.type === "TSSatisfiesExpression" ||
	node.type === "TSTypeAssertion" ||
	node.type === "TSNonNullExpression" ||
	node.type === "ChainExpression" ||
	node.type === "ParenthesizedExpression"
		? bare(node.expression)
		: node

const variableIn = (scope: Scope | null, name: string): Option.Option<Variable> =>
	scope === null
		? Option.none()
		: Option.orElse(Option.fromUndefinedOr(scope.set.get(name)), () =>
				variableIn(scope.upper, name)
			)

const definitionOf = (
	context: Context,
	identifier: NodeOf<"Identifier">
): Option.Option<Definition> =>
	Option.flatMap(variableIn(context.sourceCode.getScope(identifier), identifier.name), (variable) =>
		Arr.head(variable.defs)
	)

const EFFECT_MODULE = "effect/"

const importedName = (specifier: AnyNode, local: string): string => {
	if (specifier.type === "ImportSpecifier") {
		return specifier.imported.type === "Literal"
			? specifier.imported.value
			: specifier.imported.name
	}
	if (
		specifier.type === "ImportNamespaceSpecifier" &&
		specifier.parent.type === "ImportDeclaration" &&
		Str.startsWith(EFFECT_MODULE)(specifier.parent.source.value)
	) {
		return Arr.lastNonEmpty(Str.split(specifier.parent.source.value, "/"))
	}
	return local
}

/**
 * The name an identifier is known by: a named import's imported name (`Arr` under `import { Array as Arr } from
 * "effect"` is `Array`), an Effect module's name for a namespace import of `effect/<Module>`, and its own name for any
 * other binding or a global.
 */
const knownName = (context: Context, identifier: NodeOf<"Identifier">): string =>
	Option.match(definitionOf(context, identifier), {
		onNone: () => identifier.name,
		onSome: (definition) => importedName(definition.node, identifier.name)
	})

const constantInitOf = (definition: Definition): Option.Option<AnyNode> =>
	definition.node.type === "VariableDeclarator" &&
	definition.node.id.type === "Identifier" &&
	definition.node.parent.type === "VariableDeclaration" &&
	definition.node.parent.kind === "const"
		? Option.fromNullOr(definition.node.init)
		: Option.none()

/** What a node stands for: the initializer of the `const` an identifier names, looked through once, else the node. */
export const valueOf = (context: Context, node: AnyNode): AnyNode => {
	const plain = bare(node)
	return plain.type === "Identifier"
		? Option.match(Option.flatMap(definitionOf(context, plain), constantInitOf), {
				onNone: () => plain,
				onSome: bare
			})
		: plain
}

/**
 * The dotted path a node spells (`Effect.sleep`, `it.effect.each`), its root under the name it is known by. None for a
 * computed member, a private field or any other expression.
 */
export const pathOf = (context: Context, node: AnyNode): Option.Option<ReadonlyArray<string>> => {
	const plain = bare(node)
	if (plain.type === "Identifier") {
		return Option.some([knownName(context, plain)])
	}
	if (
		plain.type === "MemberExpression" &&
		!plain.computed &&
		plain.property.type === "Identifier"
	) {
		return Option.map(pathOf(context, plain.object), Arr.append(plain.property.name))
	}
	return Option.none()
}

/** Whether a node spells one of `names`, each a dotted path. */
export const isNamed = (context: Context, node: AnyNode, names: ReadonlyArray<string>): boolean =>
	Option.exists(pathOf(context, node), (path) => Arr.contains(names, Arr.join(path, ".")))

/** A call to one of `names`. */
export const isCallTo = (context: Context, node: AnyNode, names: ReadonlyArray<string>): boolean =>
	node.type === "CallExpression" && isNamed(context, node.callee, names)

/** The name of a property: its identifier or its string key, none for a computed key or a spread. */
export const keyOf = (property: AnyNode): Option.Option<string> => {
	if (property.type !== "Property" || property.computed) {
		return Option.none()
	}
	if (property.key.type === "Identifier") {
		return Option.some(property.key.name)
	}
	return property.key.type === "Literal" && typeof property.key.value === "string"
		? Option.some(property.key.value)
		: Option.none()
}

type ObjectProperty = Extract<
	NodeOf<"ObjectExpression">["properties"][number],
	{ type: "Property" }
>

/** The properties of an object literal named `key`. */
export const propertiesNamed = (object: AnyNode, key: string): ReadonlyArray<ObjectProperty> =>
	object.type === "ObjectExpression"
		? Arr.filter(
				object.properties,
				(property): property is ObjectProperty =>
					property.type === "Property" && Option.contains(keyOf(property), key)
			)
		: []

/** A literal of one of the given `typeof` kinds. */
export const isLiteralOf = (node: AnyNode, kinds: ReadonlyArray<string>): boolean =>
	node.type === "Literal" && Arr.contains(kinds, typeof node.value)

/** The suites and tests a file declares: Vitest's and @effect/vitest's `describe`, `it` and `test`, with any modifier. */
const TEST_ROOTS: ReadonlyArray<string> = ["describe", "it", "test"]

/** The path a node spells when it names a suite or test function (`it.effect`, `describe.concurrent`), else none. */
export const testPathOf = (context: Context, node: AnyNode): Option.Option<ReadonlyArray<string>> =>
	Option.filter(pathOf(context, node), (path) =>
		Option.exists(Arr.head(path), (root) => Arr.contains(TEST_ROOTS, root))
	)

/** An assertion: the function or matcher that asserts, and what it is handed, the value under test first. */
export type Assertion = Readonly<{ name: string; subjects: ReadonlyArray<AnyNode> }>

const EXPECT_MODIFIERS: ReadonlyArray<string> = ["not", "resolves", "rejects"]

const actualOf = (context: Context, receiver: AnyNode): Option.Option<AnyNode> => {
	if (
		receiver.type === "MemberExpression" &&
		!receiver.computed &&
		Arr.contains(EXPECT_MODIFIERS, receiver.property.name)
	) {
		return actualOf(context, receiver.object)
	}
	return receiver.type === "CallExpression" &&
		isNamed(context, receiver.callee, ["expect", "expect.soft"])
		? Arr.head(receiver.arguments)
		: Option.none()
}

/** The message an `expect(actual, message)` chain carries, through `not`, `resolves` and `rejects`. */
export const expectMessageOf = (context: Context, call: AnyNode): Option.Option<AnyNode> => {
	if (call.type !== "CallExpression") {
		return Option.none()
	}
	let receiver = bare(call.callee)
	while (receiver.type === "MemberExpression") {
		receiver = bare(receiver.object)
	}
	return receiver.type === "CallExpression" &&
		isNamed(context, receiver.callee, ["expect", "expect.soft"])
		? Arr.get(receiver.arguments, 1)
		: Option.none()
}

/**
 * The assertion a call makes: a bare assertion function (`deepStrictEqual(actual, expected)`, `assertTrue(value)`),
 * a method of node's `assert`, or an `expect(actual)` matcher through `not`, `resolves` and `rejects`. None for any
 * other call.
 */
export const assertionOf = (context: Context, call: AnyNode): Option.Option<Assertion> => {
	if (call.type !== "CallExpression") {
		return Option.none()
	}
	const callee = bare(call.callee)
	if (callee.type === "Identifier") {
		return Option.some({ name: knownName(context, callee), subjects: call.arguments })
	}
	if (
		callee.type !== "MemberExpression" ||
		callee.computed ||
		callee.property.type !== "Identifier"
	) {
		return Option.none()
	}
	const name = callee.property.name
	return isNamed(context, callee.object, ["assert"])
		? Option.some({ name, subjects: call.arguments })
		: Option.map(actualOf(context, callee.object), (actual) => ({
				name,
				subjects: Arr.prepend(call.arguments, actual)
			}))
}

/** The equality assertions whose sides must agree item by item, in order. */
export const ORDERED_EQUALITIES: ReadonlyArray<string> = [
	"assertEquals",
	"deepEqual",
	"deepStrictEqual",
	"notDeepEqual",
	"notDeepStrictEqual",
	"toEqual",
	"toStrictEqual"
]

/** Every equality assertion: the ordered ones and those that compare by identity or `==`. */
export const EQUALITIES: ReadonlyArray<string> = [
	...ORDERED_EQUALITIES,
	"equal",
	"notEqual",
	"notStrictEqual",
	"strictEqual",
	"toBe"
]

/** The value under test and the expected value of an equality assertion named in `names`, none for any other call. */
export const sidesOf = (
	context: Context,
	call: AnyNode,
	names: ReadonlyArray<string>
): Option.Option<readonly [AnyNode, AnyNode]> =>
	Option.flatMap(
		Option.filter(assertionOf(context, call), (assertion) => Arr.contains(names, assertion.name)),
		(assertion) => Option.all([Arr.get(assertion.subjects, 0), Arr.get(assertion.subjects, 1)])
	)

/** The function a node sits in, none at the top of the program. */
export const enclosingFunctionOf = (node: AnyNode): Option.Option<AnyNode> => {
	const parent = node.parent
	if (parent === null) {
		return Option.none()
	}
	return parent.type === "FunctionExpression" ||
		parent.type === "ArrowFunctionExpression" ||
		parent.type === "FunctionDeclaration"
		? Option.some(parent)
		: enclosingFunctionOf(parent)
}
