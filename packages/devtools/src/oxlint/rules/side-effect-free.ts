import { Array as Arr, Option, Result, Schema, String as Str } from "effect"
import { withoutLead } from "#oxlint/comments.ts"
import {
	type AnyNode,
	type Comment,
	type Context,
	configured,
	isFileAt,
	type NodeOf
} from "#oxlint/rule.ts"
import { ancestorsOf } from "#oxlint/syntax.ts"

/** A parameter's property a proven function calls: a callback, which its callers pass there. */
const Invoked = Schema.Struct({ parameter: Schema.Int, property: Schema.String })

type Invoked = typeof Invoked.Type

/**
 * A marked function of another module that a marked function may call: its exported name, whether it returns only
 * function literals, so that calling what it returns calls a proven body too (`values` otherwise), and the callbacks it
 * calls, which every call of it passes as function literals this rule proves.
 */
const Proven = Schema.Struct({
	name: Schema.String,
	returns: Schema.Literals(["values", "functions"]),
	invokes: Schema.Array(Invoked)
})

type Proven = typeof Proven.Type

/**
 * A module whose proven functions and constants other modules read: its file from the repository root, the specifiers
 * other files import it by, its proven functions, and its proven constants (module-level consts whose value is a
 * primitive, a frozen literal or a proven call's result). The module's own file checks every claim listed for it, so
 * the list proves nothing its module does not.
 */
const Module = Schema.Struct({
	file: Schema.String,
	specifiers: Schema.Array(Schema.String),
	functions: Schema.Array(Proven),
	constants: Schema.Array(Schema.String)
})

type Module = typeof Module.Type

/** The modules other modules read proven functions and constants of. */
const Options = Schema.Struct({
	modules: Schema.Array(Module)
})

/** The leads that mark a function as having no side effects, as bundlers read them. */
export const MARKS: ReadonlyArray<string> = ["@__NO_SIDE_EFFECTS__", "#__NO_SIDE_EFFECTS__"]

/** Math's functions, every one but `random`, which draws from state it changes. */
export const MATH_FUNCTIONS: ReadonlyArray<string> = [
	"abs",
	"acos",
	"acosh",
	"asin",
	"asinh",
	"atan",
	"atan2",
	"atanh",
	"cbrt",
	"ceil",
	"clz32",
	"cos",
	"cosh",
	"exp",
	"expm1",
	"floor",
	"fround",
	"hypot",
	"imul",
	"log",
	"log10",
	"log1p",
	"log2",
	"max",
	"min",
	"pow",
	"round",
	"sign",
	"sin",
	"sinh",
	"sqrt",
	"tan",
	"tanh",
	"trunc"
]

/**
 * The calls of the language's own objects a proven function may make, by object and property: each computes its
 * result from its arguments and calls none of them. Object.freeze changes its argument, so it is proven only on a
 * literal the call itself builds.
 */
export const BUILTIN_CALLS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["Object", ["freeze", "is"]],
	["Number", ["isFinite", "isInteger", "isNaN", "isSafeInteger"]],
	["Array", ["isArray"]],
	["Math", MATH_FUNCTIONS]
])

/** The language's conversions a proven function may call by name: each answers a primitive of its argument. */
export const CALLABLE_GLOBALS: ReadonlyArray<string> = ["BigInt", "Number", "String"]

/**
 * The globals a proven function may read: the language's constants, the objects of its proven calls and its
 * conversions.
 */
export const PURE_GLOBALS: ReadonlyArray<string> = [
	"undefined",
	"NaN",
	"Infinity",
	...BUILTIN_CALLS.keys(),
	...CALLABLE_GLOBALS
]

/** The syntax a proven function never holds, by node type, each with what it does that no proof covers. */
export const FORBIDDEN: ReadonlyMap<string, string> = new Map([
	["ThisExpression", "reads `this`, which its caller binds"],
	["Super", "reads `super`, which its class binds"],
	["AwaitExpression", "awaits, which runs whatever the awaited value schedules"],
	["YieldExpression", "yields, which hands control to its caller's code"],
	["ThrowStatement", "throws, which its caller observes and a dropped call does not"],
	["TaggedTemplateExpression", "calls a template tag"],
	["ImportExpression", "imports a module, which runs it"],
	["NewExpression", "constructs with `new`, which runs a constructor"],
	["ClassDeclaration", "declares a class, whose static blocks and fields run code"],
	["ClassExpression", "declares a class, whose static blocks and fields run code"],
	["MetaProperty", "reads `import.meta` or `new.target`"],
	["DebuggerStatement", "holds a debugger statement"],
	["WithStatement", "holds a with statement"]
])

/** The keys under which a node holds types alone, which run nothing. */
const TYPE_KEYS: ReadonlyArray<string> = [
	"typeAnnotation",
	"typeArguments",
	"typeParameters",
	"returnType"
]

/** The TypeScript nodes that hold values, among the TS nodes, every other of which is a type. */
const VALUE_TS_NODES: ReadonlyArray<string> = [
	"TSAsExpression",
	"TSSatisfiesExpression",
	"TSNonNullExpression",
	"TSInstantiationExpression",
	"TSParameterProperty",
	"TSEnumDeclaration",
	"TSEnumBody",
	"TSEnumMember",
	"TSModuleDeclaration",
	"TSModuleBlock",
	"TSExportAssignment"
]

/**
 * A function the rule proves: an arrow, or a function declaration or expression, whose node type is one with the
 * bodiless declarations TypeScript adds, which isFunction leaves out.
 */
type FunctionNode =
	| NodeOf<"ArrowFunctionExpression">
	| Extract<
			AnyNode,
			{
				type:
					| "FunctionDeclaration"
					| "FunctionExpression"
					| "TSDeclareFunction"
					| "TSEmptyBodyFunctionExpression"
			}
	  >

type Scope = ReturnType<Context["sourceCode"]["getScope"]>

type Variable = Scope["variables"][number]

/** A marked function of this file: its node, whether it returns function literals alone, and its binding's name. */
type Marked = Readonly<{
	node: FunctionNode
	returnsFunctions: boolean
	variable: Option.Option<Variable>
}>

const isFunction = (node: AnyNode): node is FunctionNode =>
	node.type === "ArrowFunctionExpression" ||
	node.type === "FunctionExpression" ||
	node.type === "FunctionDeclaration"

/** A value as an AST node: an object carrying its type. */
const isNode = (value: unknown): value is AnyNode =>
	typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"

const isTypeNode = (node: AnyNode): boolean =>
	Str.startsWith("TS")(node.type) && !Arr.contains(VALUE_TS_NODES, node.type)

/** The nodes `node` holds that run, in source order: every child but the types it holds. */
const childrenOf = (context: Context, node: AnyNode): ReadonlyArray<AnyNode> => {
	const keys: ReadonlyArray<string> = context.sourceCode.visitorKeys[node.type] ?? []
	const children: Array<AnyNode> = []
	for (const key of keys) {
		const value: unknown = Arr.contains(TYPE_KEYS, key) ? undefined : Reflect.get(node, key)
		for (const child of Arr.isArray(value) ? value : [value]) {
			if (isNode(child)) {
				children.push(child)
			}
		}
	}
	return children
}

/**
 * Every node under `root` that runs, nested functions' included, stopping at a node `stop` takes: the TS types never,
 * and whatever else the caller stops at.
 */
const nodesUnder = (
	context: Context,
	root: AnyNode,
	stop: (node: AnyNode) => boolean
): ReadonlyArray<AnyNode> => {
	const found: Array<AnyNode> = []
	const pending: Array<AnyNode> = [...childrenOf(context, root)]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (!isTypeNode(next) && !stop(next)) {
			found.push(next)
			for (const child of childrenOf(context, next)) {
				pending.push(child)
			}
		}
	}
	return found
}

/** Whether an identifier stands in a type within `root`: a type reference or a typeof query. */
const isTypePosition = (identifier: AnyNode, root: AnyNode): boolean =>
	Arr.some(
		Arr.takeWhile(ancestorsOf(identifier), (ancestor) => ancestor !== root),
		isTypeNode
	)

/** Whether `scope` lies within the function `root`: the function's own scope, or one nested in it. */
const isWithin = (scope: Scope, root: FunctionNode): boolean => {
	for (let current: Scope | null = scope; current !== null; current = current.upper) {
		if (current.block === root) {
			return true
		}
	}
	return false
}

/** A global the environment declares, which no file of the program does: the language's and the runtime's own. */
const isGlobal = (variable: Variable): boolean =>
	variable.scope.type === "global" && !Arr.isArrayNonEmpty(variable.defs)

/** The variable an identifier names where it stands: the nearest scope's of its name; none for a global. */
const resolve = (context: Context, identifier: NodeOf<"Identifier">): Option.Option<Variable> => {
	for (
		let scope: Scope | null = context.sourceCode.getScope(identifier);
		scope !== null;
		scope = scope.upper
	) {
		const found = scope.set.get(identifier.name)
		if (found !== undefined) {
			return isGlobal(found) ? Option.none() : Option.some(found)
		}
	}
	return Option.none()
}

/** The one function a declaration declares: a function declaration, or a declaration of one binding to one. */
const declaredFunction = (node: AnyNode | null): Option.Option<FunctionNode> => {
	if (node?.type === "FunctionDeclaration") {
		return Option.some(node)
	}
	if (node?.type !== "VariableDeclaration" || node.declarations.length !== 1) {
		return Option.none()
	}
	const init = node.declarations[0]?.init
	return init !== null && init !== undefined && isFunction(init) ? Option.some(init) : Option.none()
}

/**
 * The function a mark marks: the first token after the comment opens it, or opens the declaration of it, an
 * exported one included. None for a mark on anything else.
 */
const markedFunctionAt = (context: Context, comment: Comment): Option.Option<FunctionNode> => {
	const next = context.sourceCode.getTokenAfter(comment)
	const node = next === null ? null : context.sourceCode.getNodeByRangeIndex(next.start)
	if (next === null || node === null) {
		return Option.none()
	}
	const starting = Arr.takeWhile([node, ...ancestorsOf(node)], (each) => each.start === next.start)
	return Arr.findFirst(starting, (each): Option.Option<FunctionNode> => {
		if (isFunction(each)) {
			return Option.some(each)
		}
		return declaredFunction(each.type === "ExportNamedDeclaration" ? each.declaration : each)
	})
}

/** A marked function's binding: a function declaration's own, or the const declarator it initializes. */
const bindingOf = (context: Context, node: FunctionNode): Option.Option<Variable> => {
	const named = node.type === "FunctionDeclaration" ? node : node.parent
	const constant =
		named.type === "FunctionDeclaration" ||
		(named.type === "VariableDeclarator" &&
			named.parent.type === "VariableDeclaration" &&
			named.parent.kind === "const")
	return constant ? Arr.head(context.sourceCode.getDeclaredVariables(named)) : Option.none()
}

/** Whether every value a function returns is a function literal, so calling what it returns calls a proven body. */
const returnsFunctions = (context: Context, node: FunctionNode): boolean => {
	const body = node.body
	if (body === null) {
		return false
	}
	if (body.type !== "BlockStatement") {
		return isFunction(body)
	}
	const returns = Arr.filter(
		nodesUnder(context, body, isFunction),
		(each): each is NodeOf<"ReturnStatement"> => each.type === "ReturnStatement"
	)
	return (
		Arr.isArrayNonEmpty(returns) &&
		Arr.every(returns, (each) => each.argument !== null && isFunction(each.argument))
	)
}

/** The members a pattern assigns: each property or element target, at any depth, of an assignment's left side. */
const memberTargets = (context: Context, pattern: AnyNode): ReadonlyArray<AnyNode> => {
	if (pattern.type === "MemberExpression") {
		return [pattern]
	}
	if (pattern.type === "ArrayPattern" || pattern.type === "ObjectPattern") {
		return Arr.flatMap(childrenOf(context, pattern), (part) =>
			memberTargets(context, part.type === "Property" ? part.value : part)
		)
	}
	if (pattern.type === "AssignmentPattern") {
		return memberTargets(context, pattern.left)
	}
	return pattern.type === "RestElement" ? memberTargets(context, pattern.argument) : []
}

/** An expression its type assertions wrap, unwrapped: `x as T`, `x satisfies T` and `x!` hold x's value. */
const unwrapped = (node: AnyNode): AnyNode =>
	node.type === "TSAsExpression" ||
	node.type === "TSSatisfiesExpression" ||
	node.type === "TSNonNullExpression"
		? unwrapped(node.expression)
		: node

/** A conversion of the language's own called by name (CALLABLE_GLOBALS), a global no file declares. */
const isConversionCall = (context: Context, node: AnyNode): boolean =>
	node.type === "CallExpression" &&
	node.callee.type === "Identifier" &&
	Arr.contains(CALLABLE_GLOBALS, node.callee.name) &&
	Option.isNone(resolve(context, node.callee))

/** A call of one of Math's functions (MATH_FUNCTIONS), Math a global no file declares. */
const isMathCall = (context: Context, node: AnyNode): boolean =>
	node.type === "CallExpression" &&
	node.callee.type === "MemberExpression" &&
	!node.callee.computed &&
	node.callee.object.type === "Identifier" &&
	node.callee.object.name === "Math" &&
	Option.isNone(resolve(context, node.callee.object)) &&
	node.callee.property.type === "Identifier" &&
	Arr.contains(MATH_FUNCTIONS, node.callee.property.name)

/**
 * An expression whose value is a primitive by its syntax alone: a literal (not null, not a regular expression), a
 * template literal, a unary operation other than `void` and `delete`, any binary operation, an increment, a
 * conversion's call or a Math function's. Its `toString` is the primitive's own, which calls no code of a value.
 */
const isPrimitiveExpression = (context: Context, node: AnyNode): boolean => {
	const value = unwrapped(node)
	if (value.type === "Literal") {
		return value.value !== null && typeof value.value !== "object"
	}
	if (value.type === "UnaryExpression") {
		return value.operator !== "void" && value.operator !== "delete"
	}
	return (
		value.type === "TemplateLiteral" ||
		value.type === "BinaryExpression" ||
		value.type === "UpdateExpression" ||
		isConversionCall(context, value) ||
		isMathCall(context, value)
	)
}

/** Whether a call is `x.toString()` or `x.toString(radix)` on a primitive by its syntax (isPrimitiveExpression). */
const isPrimitiveToString = (context: Context, call: NodeOf<"CallExpression">): boolean =>
	call.callee.type === "MemberExpression" &&
	!call.callee.computed &&
	call.callee.property.type === "Identifier" &&
	call.callee.property.name === "toString" &&
	call.arguments.length <= 1 &&
	isPrimitiveExpression(context, call.callee.object) &&
	Arr.every(call.arguments, (argument) => isPrimitiveExpression(context, argument))

/** What a call site's argument holds where its callee calls a callback: the object literal's one property there. */
const callbackAt = (
	argument: AnyNode | undefined,
	property: string
): Result.Result<AnyNode, string> => {
	if (argument?.type !== "ObjectExpression") {
		return Result.fail("as no object literal this rule can read")
	}
	const held = Arr.filter(
		argument.properties,
		(each) =>
			each.type === "SpreadElement" ||
			(!each.computed && each.key.type === "Identifier" && each.key.name === property)
	)
	const [only] = held
	return held.length === 1 && only !== undefined && only.type !== "SpreadElement"
		? Result.succeed(only.value)
		: Result.fail("beside a spread, or more than once")
}

/**
 * Every function marked `@__NO_SIDE_EFFECTS__` is syntactically pure, so a bundler that drops a call whose value is
 * unused drops nothing the call does. Over the function's whole body, nested functions included:
 *
 * - it reads only its own parameters and locals, the marked functions of its module, the proven functions the options
 *   list of other modules, the proven constants (a module-level const whose value is a primitive literal, a template
 *   literal, a frozen literal or a proven call's result, or one the options list of another module), and the
 *   language's constants, the objects of its proven calls and its conversions (PURE_GLOBALS);
 * - it assigns only its own locals: no property, no outer variable, no `delete`;
 * - it calls only a function literal it declares (a const or a function declaration), a marked or listed proven
 *   function, what one that returns function literals alone returns, a proven call of the language's own
 *   (BUILTIN_CALLS: Math's functions, Object.freeze on a literal alone), a conversion (CALLABLE_GLOBALS), `toString` on
 *   a primitive by its syntax, or, for a marked function, a property of its own parameter, a callback;
 * - it holds no `this`, `super`, `await`, `yield`, `throw`, `new`, class, tagged template or dynamic import
 *   (FORBIDDEN).
 *
 * A marked function that calls a callback is proven only with its callers: every call of it, in any file, passes there
 * an object literal whose property is a function literal this rule proves too, calling no callback of its own, or a
 * proven function that calls none. What runs implicitly when it reads a value, a getter, an iterator or a conversion of
 * a parameter's value, is that value's own.
 *
 * A mark on anything but a function declaration, a const declaration of one function or a function expression is
 * reported, since a mark the rule cannot check is never a pass. The module a listed proof names checks it there: its
 * function is marked, returns function literals alone where the proof says so, and calls no callback the proof omits;
 * its constant is a proven one.
 */
export const sideEffectFree = configured(Options, (context, options) => {
	const reportAt = (node: AnyNode | Comment, message: string): void => {
		context.report({ node, message })
	}
	/** The import a variable binds: the specifier and the name it imports, none for any other variable. */
	const importOf = (
		variable: Variable
	): Option.Option<Readonly<{ specifier: string; name: string }>> =>
		Arr.findFirst(variable.defs, (def) => {
			if (
				def.type !== "ImportBinding" ||
				def.parent?.type !== "ImportDeclaration" ||
				def.node.type !== "ImportSpecifier"
			) {
				return Option.none()
			}
			const imported = def.node.imported
			return Option.some({
				specifier: def.parent.source.value,
				name: imported.type === "Identifier" ? imported.name : imported.value
			})
		})
	const listedModulesOf = (specifier: string): ReadonlyArray<Module> =>
		Arr.filter(options.modules, (module) => Arr.contains(module.specifiers, specifier))
	const importedProof = (variable: Variable): Option.Option<Proven> =>
		Option.flatMap(importOf(variable), ({ specifier, name }) =>
			Arr.findFirst(listedModulesOf(specifier), (module) =>
				Arr.findFirst(module.functions, (each) => each.name === name)
			)
		)
	const isImportedConstant = (variable: Variable): boolean =>
		Option.exists(importOf(variable), ({ specifier, name }) =>
			Arr.some(listedModulesOf(specifier), (module) => Arr.contains(module.constants, name))
		)
	return {
		Program: (program) => {
			const marked: Array<Marked> = []
			for (const comment of context.sourceCode.getAllComments()) {
				if (!Arr.some(MARKS, (mark) => Str.startsWith(mark)(withoutLead(comment.value)))) {
					continue
				}
				const node = markedFunctionAt(context, comment)
				if (Option.isNone(node)) {
					reportAt(
						comment,
						"A @__NO_SIDE_EFFECTS__ mark on no function this rule checks: mark a function declaration, a const declaration of one function, or a function expression."
					)
				} else {
					marked.push({
						node: node.value,
						returnsFunctions: returnsFunctions(context, node.value),
						variable: bindingOf(context, node.value)
					})
				}
			}
			const invoked = new Map<FunctionNode, ReadonlyArray<Invoked>>()
			const markedOf = (variable: Variable): Option.Option<Marked> =>
				Arr.findFirst(marked, (each) => Option.exists(each.variable, (own) => own === variable))
			const isProven = (variable: Variable): boolean =>
				Option.isSome(markedOf(variable)) || Option.isSome(importedProof(variable))
			const returnsFunctionsOf = (variable: Variable): boolean =>
				Option.exists(markedOf(variable), (each) => each.returnsFunctions) ||
				Option.exists(importedProof(variable), (proven) => proven.returns === "functions")
			const invokesOf = (variable: Variable): ReadonlyArray<Invoked> =>
				Option.match(markedOf(variable), {
					onSome: (each) => invoked.get(each.node) ?? [],
					onNone: () =>
						Option.match(importedProof(variable), {
							onNone: () => [],
							onSome: (proven) => proven.invokes
						})
				})
			/** A value a proven constant may be initialized with. */
			const isProvenInitializer = (init: AnyNode): boolean => {
				const value = unwrapped(init)
				if (
					value.type === "Literal" ||
					value.type === "TemplateLiteral" ||
					(value.type === "UnaryExpression" && unwrapped(value.argument).type === "Literal")
				) {
					return value.type !== "Literal" || value.value === null || typeof value.value !== "object"
				}
				if (value.type !== "CallExpression") {
					return false
				}
				const callee = value.callee
				if (callee.type === "Identifier") {
					return Option.exists(resolve(context, callee), isProven)
				}
				return (
					callee.type === "MemberExpression" &&
					!callee.computed &&
					callee.object.type === "Identifier" &&
					callee.object.name === "Object" &&
					Option.isNone(resolve(context, callee.object)) &&
					callee.property.type === "Identifier" &&
					callee.property.name === "freeze" &&
					(value.arguments[0]?.type === "ObjectExpression" ||
						value.arguments[0]?.type === "ArrayExpression")
				)
			}
			/** A module-level const of this file whose value is proven (isProvenInitializer). */
			const isProvenConstant = (variable: Variable): boolean =>
				variable.scope.type === "module" &&
				variable.defs.length === 1 &&
				Arr.every(
					variable.defs,
					(def) =>
						def.type === "Variable" &&
						def.node.type === "VariableDeclarator" &&
						def.node.id.type === "Identifier" &&
						def.parent?.type === "VariableDeclaration" &&
						def.parent.kind === "const" &&
						def.node.init !== null &&
						isProvenInitializer(def.node.init)
				)
			const isLocalFunction = (root: FunctionNode, variable: Variable): boolean =>
				isWithin(variable.scope, root) &&
				Arr.every(
					variable.defs,
					(def) =>
						def.type === "FunctionName" ||
						(def.type === "Variable" &&
							def.node.type === "VariableDeclarator" &&
							def.parent?.type === "VariableDeclaration" &&
							def.parent.kind === "const" &&
							def.node.init !== null &&
							isFunction(def.node.init))
				)
			const parameterIndex = (root: FunctionNode, variable: Variable): Option.Option<number> =>
				Arr.findFirstIndex(
					root.params,
					(parameter) =>
						parameter.type === "Identifier" &&
						Arr.some(variable.identifiers, (identifier) => identifier === parameter)
				)
			/** The callback a call of `root` names, where `root` is marked and the callee is its own parameter's property. */
			const proveCall = (
				root: FunctionNode,
				call: NodeOf<"CallExpression">,
				mayInvoke: boolean
			): Option.Option<Invoked> => {
				const callee = call.callee
				if (isFunction(callee) || callee.type === "Super") {
					return Option.none()
				}
				if (callee.type === "Identifier") {
					const variable = resolve(context, callee)
					if (Option.isNone(variable)) {
						if (!Arr.contains(CALLABLE_GLOBALS, callee.name)) {
							reportAt(callee, `Calls the global ${callee.name}, which no proof covers.`)
						}
					} else if (
						isWithin(variable.value.scope, root) &&
						!isLocalFunction(root, variable.value)
					) {
						reportAt(
							callee,
							`Calls ${callee.name}, a value it cannot prove: it calls only a function literal it declares as a const or a function.`
						)
					}
					return Option.none()
				}
				if (callee.type === "CallExpression") {
					const inner = callee.callee
					const factory =
						inner.type === "Identifier" &&
						Option.exists(resolve(context, inner), returnsFunctionsOf)
					if (!factory) {
						reportAt(
							callee,
							"Calls what a call returns, proven only where the callee is a marked or listed function that returns function literals alone."
						)
					}
					return Option.none()
				}
				if (isPrimitiveToString(context, call)) {
					return Option.none()
				}
				if (
					callee.type === "MemberExpression" &&
					!callee.computed &&
					callee.object.type === "Identifier" &&
					callee.property.type === "Identifier"
				) {
					const object = callee.object
					const property = callee.property.name
					const variable = resolve(context, object)
					if (Option.isNone(variable)) {
						if (!Arr.contains(BUILTIN_CALLS.get(object.name) ?? [], property)) {
							reportAt(callee, `Calls ${object.name}.${property}, which no proof covers.`)
						} else if (
							object.name === "Object" &&
							property === "freeze" &&
							call.arguments[0]?.type !== "ObjectExpression" &&
							call.arguments[0]?.type !== "ArrayExpression"
						) {
							reportAt(
								callee,
								"Freezes a value it may not own: it freezes only a literal the call builds."
							)
						}
						return Option.none()
					}
					const parameter = parameterIndex(root, variable.value)
					if (mayInvoke && Option.isSome(parameter)) {
						return Option.some({ parameter: parameter.value, property })
					}
				}
				reportAt(callee, "Calls a method of a value it cannot prove.")
				return Option.none()
			}
			const prove = (root: FunctionNode, mayInvoke: boolean): ReadonlyArray<Invoked> => {
				const calls: Array<Invoked> = []
				for (const reference of context.sourceCode.getScope(root).through) {
					const identifier = reference.identifier
					if (isTypePosition(identifier, root)) {
						continue
					}
					if (reference.isWrite()) {
						reportAt(identifier, `Assigns ${identifier.name}, which it does not declare.`)
					} else if (reference.resolved === null || isGlobal(reference.resolved)) {
						if (!Arr.contains(PURE_GLOBALS, identifier.name)) {
							reportAt(identifier, `Reads the global ${identifier.name}, which no proof covers.`)
						}
					} else if (
						!isProven(reference.resolved) &&
						!isProvenConstant(reference.resolved) &&
						!isImportedConstant(reference.resolved)
					) {
						reportAt(
							identifier,
							`Reads ${identifier.name}, declared outside it and proven by nothing: it reads only its parameters, its locals, proven functions and proven constants.`
						)
					}
				}
				for (const node of nodesUnder(context, root, () => false)) {
					const forbidden = FORBIDDEN.get(node.type)
					if (forbidden !== undefined) {
						reportAt(node, `It ${forbidden}.`)
					} else if (node.type === "AssignmentExpression") {
						for (const target of memberTargets(context, node.left)) {
							reportAt(target, "Assigns a property of a value it may not own.")
						}
					} else if (
						(node.type === "ForOfStatement" || node.type === "ForInStatement") &&
						node.left.type !== "VariableDeclaration"
					) {
						for (const target of memberTargets(context, node.left)) {
							reportAt(target, "Assigns a property of a value it may not own.")
						}
					} else if (
						node.type === "UpdateExpression" &&
						node.argument.type === "MemberExpression"
					) {
						reportAt(node.argument, "Changes a property of a value it may not own.")
					} else if (node.type === "UnaryExpression" && node.operator === "delete") {
						reportAt(node, "Deletes a property of a value it may not own.")
					} else if (node.type === "CallExpression") {
						const call = proveCall(root, node, mayInvoke)
						if (Option.isSome(call)) {
							calls.push(call.value)
						}
					}
				}
				return calls
			}
			for (const each of marked) {
				invoked.set(each.node, prove(each.node, true))
			}
			const insideMarked = (node: AnyNode): boolean =>
				Arr.some(ancestorsOf(node), (ancestor) =>
					Arr.some(marked, (each) => each.node === ancestor)
				)
			for (const call of nodesUnder(context, program, () => false)) {
				if (call.type !== "CallExpression" || call.callee.type !== "Identifier") {
					continue
				}
				const callee = call.callee
				const invokes = Option.match(resolve(context, callee), {
					onNone: (): ReadonlyArray<Invoked> => [],
					onSome: invokesOf
				})
				for (const each of invokes) {
					const where = `${callee.name}'s argument ${each.parameter + 1}'s ${each.property}, a callback it calls`
					const held = callbackAt(call.arguments[each.parameter], each.property)
					if (Result.isFailure(held)) {
						reportAt(call, `Passes ${where}, ${held.failure}.`)
						continue
					}
					const value = held.success
					if (isFunction(value)) {
						if (!insideMarked(call)) {
							prove(value, false)
						}
					} else if (
						value.type !== "Identifier" ||
						!Option.exists(
							resolve(context, value),
							(variable) => isProven(variable) && !Arr.isReadonlyArrayNonEmpty(invokesOf(variable))
						)
					) {
						reportAt(
							value,
							`Passes ${where}, as a value no proof covers: a function literal, or a proven function that calls no callback.`
						)
					}
				}
			}
			const listedHere: ReadonlyArray<Proven> = Arr.flatMap(
				Arr.filter(options.modules, (module: Module) => isFileAt(context.filename, module.file)),
				(module: Module) => module.functions
			)
			const exportedNames = Arr.flatMap(program.body, (statement) =>
				statement.type === "ExportNamedDeclaration" && statement.declaration === null
					? Arr.filterMap(statement.specifiers, (specifier) =>
							specifier.local.type === "Identifier"
								? Result.succeed(specifier.local.name)
								: Result.failVoid
						)
					: []
			)
			for (const each of marked) {
				const calls = invoked.get(each.node) ?? []
				const exported =
					Arr.some(
						ancestorsOf(each.node),
						(ancestor) => ancestor.type === "ExportNamedDeclaration"
					) ||
					Option.exists(each.variable, (variable) => Arr.contains(exportedNames, variable.name))
				const listed = Option.exists(each.variable, (variable) =>
					Arr.some(listedHere, (proven) => proven.name === variable.name)
				)
				const [first] = calls
				if (exported && !listed && first !== undefined) {
					reportAt(
						each.node,
						`It calls its argument ${first.parameter + 1}'s ${first.property}, a callback, and is exported: the options list it, so every caller in another module is held to pass a proven callback there.`
					)
				}
			}
			for (const module of options.modules) {
				if (!isFileAt(context.filename, module.file)) {
					continue
				}
				for (const listed of module.functions) {
					const found = Arr.findFirst(marked, (each) =>
						Option.exists(each.variable, (variable) => variable.name === listed.name)
					)
					if (Option.isNone(found)) {
						reportAt(
							program,
							`The options prove ${listed.name} of this module, which marks no function ${listed.name}.`
						)
						continue
					}
					if (listed.returns === "functions" && !found.value.returnsFunctions) {
						reportAt(
							found.value.node,
							`The options prove ${listed.name} returns function literals alone, and it returns another value.`
						)
					}
					for (const call of invoked.get(found.value.node) ?? []) {
						if (
							!Arr.some(
								listed.invokes,
								(each) => each.parameter === call.parameter && each.property === call.property
							)
						) {
							reportAt(
								found.value.node,
								`${listed.name} calls its argument ${call.parameter + 1}'s ${call.property}, which the options omit, so no caller in another module is held to pass a proven callback there.`
							)
						}
					}
				}
				for (const name of module.constants) {
					const scope = context.sourceCode.getScope(program)
					const declared = Arr.findFirst(
						[...scope.variables, ...Arr.flatMap(scope.childScopes, (child) => child.variables)],
						(variable) => variable.name === name
					)
					if (!Option.exists(declared, isProvenConstant)) {
						reportAt(
							program,
							`The options prove the constant ${name} of this module, which declares no proven constant ${name}: a module-level const of a primitive, a frozen literal or a proven call's result.`
						)
					}
				}
			}
		}
	}
})
