import { Array as Arr, Option, Schema, String as Str } from "effect"
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

/**
 * A marked function of another module that a marked function may call: its exported name, and whether it returns only
 * function literals, so that calling what it returns calls a proven body too (`values` otherwise).
 */
const Proven = Schema.Struct({
	name: Schema.String,
	returns: Schema.Literals(["values", "functions"])
})

type Proven = typeof Proven.Type

/**
 * The modules whose marked functions other modules' marked functions call: each module's file from the repository
 * root, the specifiers other files import it by, and the functions it proves. The module's own file checks every claim
 * listed for it, so the list proves nothing its module does not.
 */
const Options = Schema.Struct({
	modules: Schema.Array(
		Schema.Struct({
			file: Schema.String,
			specifiers: Schema.Array(Schema.String),
			functions: Schema.Array(Proven)
		})
	)
})

/** The leads that mark a function as having no side effects, as bundlers read them. */
export const MARKS: ReadonlyArray<string> = ["@__NO_SIDE_EFFECTS__", "#__NO_SIDE_EFFECTS__"]

/**
 * The calls of the language's own objects a proven function may make, by object and property: each computes its
 * result from its arguments and calls none of them. Object.freeze changes its argument, so it is proven only on a
 * literal the call itself builds.
 */
export const BUILTIN_CALLS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["Object", ["freeze", "is"]],
	["Number", ["isFinite", "isInteger", "isNaN", "isSafeInteger"]],
	["Array", ["isArray"]]
])

/** The globals a proven function may read: the language's constants, and the objects of its proven calls. */
export const PURE_GLOBALS: ReadonlyArray<string> = [
	"undefined",
	"NaN",
	"Infinity",
	...BUILTIN_CALLS.keys()
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

/**
 * Every function marked `@__NO_SIDE_EFFECTS__` is syntactically pure, so a bundler that drops a call whose value is
 * unused drops nothing the call does. Over the function's whole body, nested functions included:
 *
 * - it reads only its own parameters and locals, the marked functions of its module, the proven functions the options
 *   list of other modules, and the language's constants and the objects of its proven calls (PURE_GLOBALS);
 * - it assigns only its own locals: no property, no outer variable, no `delete`;
 * - it calls only a function literal it declares (a const or a function declaration), a marked or listed proven
 *   function, what one that returns function literals alone returns, or a proven call of the language's own
 *   (BUILTIN_CALLS; Object.freeze on a literal alone): never a parameter, a method of a value, or a global;
 * - it holds no `this`, `super`, `await`, `yield`, `throw`, `new`, class, tagged template or dynamic import
 *   (FORBIDDEN).
 *
 * What runs implicitly when it reads a value, a getter, an iterator or a conversion of a parameter's value, is that
 * value's own. A mark on anything but a function declaration, a const declaration of one function or a function
 * expression is reported, since a mark the rule cannot check is never a pass. The module a listed proof names checks
 * it there: its function is marked, and returns function literals alone where the proof says so.
 */
export const sideEffectFree = configured(Options, (context, options) => {
	const reportAt = (node: AnyNode | Comment, message: string): void => {
		context.report({ node, message })
	}
	const importedProof = (variable: Variable): Option.Option<Proven> =>
		Arr.findFirst(variable.defs, (def): Option.Option<Proven> => {
			if (
				def.type !== "ImportBinding" ||
				def.parent?.type !== "ImportDeclaration" ||
				def.node.type !== "ImportSpecifier"
			) {
				return Option.none()
			}
			const specifier = def.parent.source.value
			const imported = def.node.imported
			const name = imported.type === "Identifier" ? imported.name : imported.value
			return Arr.findFirst(options.modules, (module) =>
				Arr.contains(module.specifiers, specifier)
					? Arr.findFirst(module.functions, (each) => each.name === name)
					: Option.none()
			)
		})
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
			const markedOf = (variable: Variable): Option.Option<Marked> =>
				Arr.findFirst(marked, (each) => Option.exists(each.variable, (own) => own === variable))
			const isProven = (variable: Variable): boolean =>
				Option.isSome(markedOf(variable)) || Option.isSome(importedProof(variable))
			const returnsFunctionsOf = (variable: Variable): boolean =>
				Option.exists(markedOf(variable), (each) => each.returnsFunctions) ||
				Option.exists(importedProof(variable), (proven) => proven.returns === "functions")
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
			const proveCall = (root: FunctionNode, call: NodeOf<"CallExpression">): void => {
				const callee = call.callee
				if (isFunction(callee) || callee.type === "Super") {
					return
				}
				if (callee.type === "Identifier") {
					const variable = resolve(context, callee)
					if (Option.isNone(variable)) {
						reportAt(callee, `Calls the global ${callee.name}, which no proof covers.`)
					} else if (
						isWithin(variable.value.scope, root) &&
						!isLocalFunction(root, variable.value)
					) {
						reportAt(
							callee,
							`Calls ${callee.name}, a value it cannot prove: it calls only a function literal it declares as a const or a function.`
						)
					}
					return
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
					return
				}
				const builtin =
					callee.type === "MemberExpression" &&
					!callee.computed &&
					callee.object.type === "Identifier" &&
					callee.property.type === "Identifier" &&
					Option.isNone(resolve(context, callee.object)) &&
					Arr.contains(BUILTIN_CALLS.get(callee.object.name) ?? [], callee.property.name)
				if (!builtin) {
					reportAt(callee, "Calls a method of a value it cannot prove.")
				} else if (
					callee.object.type === "Identifier" &&
					callee.object.name === "Object" &&
					callee.property.type === "Identifier" &&
					callee.property.name === "freeze" &&
					call.arguments[0]?.type !== "ObjectExpression" &&
					call.arguments[0]?.type !== "ArrayExpression"
				) {
					reportAt(
						callee,
						"Freezes a value it may not own: it freezes only a literal the call builds."
					)
				}
			}
			const prove = (root: FunctionNode): void => {
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
					} else if (!isProven(reference.resolved)) {
						reportAt(
							identifier,
							`Reads ${identifier.name}, declared outside it and proven by nothing: it reads only its parameters, its locals and marked or listed proven functions.`
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
						proveCall(root, node)
					}
				}
			}
			for (const each of marked) {
				prove(each.node)
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
					} else if (listed.returns === "functions" && !found.value.returnsFunctions) {
						reportAt(
							found.value.node,
							`The options prove ${listed.name} returns function literals alone, and it returns another value.`
						)
					}
				}
			}
		}
	}
})
