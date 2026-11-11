import { Array as Arr, Option, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import {
	type Checker,
	type Symbol as NativeSymbol,
	SymbolFlags,
	type Type,
	TypeFlags
} from "typescript/sync"
import { isDefaultLibraryPath } from "#lint/paths.ts"
import type { RuleContext, Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"

/** The default library's keyed collections: their writes are methods (set, add, delete, clear), which no property
 * shows. A WeakMap or WeakSet is none of them: keyed by object identity, it is a handle registry whose entries die with
 * their keys, so no run sees another's. */
const KEYED_COLLECTIONS: ReadonlyArray<string> = ["Map", "Set"]

/** The codecs that hold no state between calls: a TextEncoder, and a TextDecoder outside streaming. */
const STATELESS_CODECS: ReadonlyArray<string> = ["TextEncoder", "TextDecoder"]

/** A RegExp's one writable property, lastIndex, is its cursor under the g and y flags; a literal without them never
 * reads it. */
const CURSOR_FLAGS: ReadonlyArray<string> = ["g", "y"]

/** The objects a write reaches the process through. */
const GLOBAL_OBJECTS: ReadonlyArray<string> = ["globalThis", "global"]

/** The reflective APIs that write a property by name. */
const REFLECTIVE_WRITERS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["Object", ["assign", "defineProperty", "defineProperties"]],
	["Reflect", ["set", "defineProperty"]]
])

const SUGGESTION =
	"Pass the value in, make it a readonly constant, or hold state that outlives one run in a Ref inside a Layer of the runtime."

const isAmbient = (statement: ts.VariableStatement): boolean =>
	Arr.some(statement.modifiers ?? [], (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)

const bindingKindOf = (statement: ts.VariableStatement): "let" | "var" | "const" => {
	const flags = statement.declarationList.flags
	if ((flags & ts.NodeFlags.Let) !== 0) {
		return "let"
	}
	return (flags & ts.NodeFlags.BlockScoped) === 0 ? "var" : "const"
}

/** The globals a file declares itself, in `declare global { var name: … }`: the process anchor's module. */
const declaredGlobalsOf = (sourceFile: ts.SourceFile): ReadonlyArray<string> =>
	Arr.flatMap(sourceFile.statements, (statement) => {
		if (
			!ts.isModuleDeclaration(statement) ||
			!ts.isIdentifier(statement.name) ||
			statement.name.text !== "global" ||
			statement.body === undefined ||
			!ts.isModuleBlock(statement.body)
		) {
			return []
		}
		return Arr.flatMap(statement.body.statements, (inner) =>
			ts.isVariableStatement(inner)
				? Arr.filterMap(inner.declarationList.declarations, (declaration) =>
						ts.isIdentifier(declaration.name)
							? Result.succeed(declaration.name.text)
							: Result.failVoid
					)
				: []
		)
	})

/** `globalThis.name` or `globalThis["name"]`: the property a write to the global object names. */
const globalPropertyOf = (target: ts.Expression): Option.Option<string> => {
	if (
		(!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) ||
		!ts.isIdentifier(target.expression) ||
		!Arr.contains(GLOBAL_OBJECTS, target.expression.text)
	) {
		return Option.none()
	}
	if (ts.isPropertyAccessExpression(target)) {
		return Option.some(target.name.text)
	}
	const argument = target.argumentExpression
	return Option.some(ts.isStringLiteral(argument) ? argument.text : "[computed]")
}

const isAssignmentOperator = (kind: ts.SyntaxKind): boolean =>
	kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment

/** The expression a statement writes: an assignment's left side, an increment's operand, a delete's target. */
const writtenTargetOf = (node: ts.Node): ts.Expression | undefined => {
	if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
		return node.left
	}
	if (
		(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
		(node.operator === ts.SyntaxKind.PlusPlusToken ||
			node.operator === ts.SyntaxKind.MinusMinusToken)
	) {
		return node.operand
	}
	return ts.isDeleteExpression(node) ? node.expression : undefined
}

/** `Object.assign(globalThis, …)`, `Object.defineProperty(globalThis, …)`, `Reflect.set(globalThis, …)`: a write
 * whose property names no declaration can be checked against. */
const isReflectiveGlobalWrite = (node: ts.Node): node is ts.CallExpression => {
	if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
		return false
	}
	const callee = node.expression
	const methods = ts.isIdentifier(callee.expression)
		? REFLECTIVE_WRITERS.get(callee.expression.text)
		: undefined
	const reflective = methods !== undefined && Arr.contains(methods, callee.name.text)
	const [first] = node.arguments
	return (
		reflective &&
		first !== undefined &&
		ts.isIdentifier(first) &&
		Arr.contains(GLOBAL_OBJECTS, first.text)
	)
}

/** A third-party package's type: declared under node_modules, outside the default library. Its declared writability
 * is that library's vocabulary, not this repository's state: Drizzle declares its table columns writable and Effect its
 * type brands. An intersection is the library's when any of its parts is. */
const isLibraryVocabulary = (type: Type): boolean =>
	Arr.some(type.isIntersectionType() ? type.getTypes() : [type], (part) => {
		const file = part.getSymbol()?.declarations[0]?.path
		return file !== undefined && Str.includes("/node_modules/")(file) && !isDefaultLibraryPath(file)
	})

/** A writable property that holds data: not a method, and not named by a symbol, which is a type-level brand
 * (Effect's `[TypeId]`, `[Unify.typeSymbol]`). */
const isWritableData = (checker: Checker, property: NativeSymbol): boolean =>
	(property.flags & SymbolFlags.Method) === 0 &&
	!Str.startsWith("__@")(property.escapedName) &&
	!checker.isReadonlySymbol(property)

const flagsOf = (literal: ts.RegularExpressionLiteral): string =>
	Option.match(Str.lastIndexOf("/")(literal.text), {
		onNone: () => "",
		onSome: (index) => Str.slice(index + 1)(literal.text)
	})

const isRegExpLiteralWithoutCursor = (declaration: ts.VariableDeclaration): boolean => {
	const literal = declaration.initializer
	return (
		literal !== undefined &&
		ts.isRegularExpressionLiteral(literal) &&
		!Arr.some(CURSOR_FLAGS, (flag) => Str.includes(flag)(flagsOf(literal)))
	)
}

/** What a library type lets a write change in place: only an instance the module builds itself with `new`, whose
 * class owns its state (`new Pool()`). */
const constructedInstanceOf = (
	declaration: ts.VariableDeclaration,
	type: Type
): Option.Option<string> => {
	const initializer = declaration.initializer
	if (initializer === undefined || !ts.isNewExpression(initializer)) {
		return Option.none()
	}
	const name = type.getSymbol()?.name
	if (name !== undefined && Arr.contains(STATELESS_CODECS, name)) {
		return Option.none()
	}
	return Option.some(`an instance of ${name ?? "a library class"}, whose class owns its state`)
}

/** What one of this repository's or the default library's object types lets a write change in place: a keyed
 * collection, a tuple or array, a writable index signature (a record) or a writable property named by a string (an
 * object or class instance). */
const writableShapeOf = (
	checker: Checker,
	declaration: ts.VariableDeclaration,
	type: Type
): Option.Option<string> => {
	const name = type.getSymbol()?.name
	if (name !== undefined && Arr.contains(KEYED_COLLECTIONS, name)) {
		return Option.some(`a mutable ${name}`)
	}
	if (name === "RegExp" && isRegExpLiteralWithoutCursor(declaration)) {
		return Option.none()
	}
	if (type.isTupleType()) {
		return type.getTarget().readonly ? Option.none() : Option.some("a mutable tuple")
	}
	if (Arr.some(checker.getIndexInfosOfType(type), (info) => !info.isReadonly)) {
		return Option.some(
			checker.isArrayType(type) ? "a mutable array" : "a record with a writable index signature"
		)
	}
	return Option.map(
		Arr.findFirst(checker.getPropertiesOfType(type), (property) =>
			isWritableData(checker, property)
		),
		(property) => `a value whose property '${property.name}' is writable`
	)
}

/** What a declared type lets a write change in place, judged per union member. */
const mutabilityOf = (
	checker: Checker,
	declaration: ts.VariableDeclaration,
	type: Type
): Option.Option<string> =>
	Arr.findFirst(type.isUnionType() ? type.getTypes() : [type], (member) => {
		if ((member.flags & (TypeFlags.Object | TypeFlags.Intersection)) === 0) {
			return Option.none()
		}
		return isLibraryVocabulary(member)
			? constructedInstanceOf(declaration, member)
			: writableShapeOf(checker, declaration, member)
	})

/** What a module-level declaration holds that every run shares: a reassignable binding, or a constant whose type a
 * write can change in place. */
const sharedStateOf = (
	context: RuleContext,
	kind: "let" | "var" | "const",
	declaration: ts.VariableDeclaration
): Option.Option<string> => {
	if (kind !== "const") {
		return Option.some(`Module-level '${kind}' is state shared by every run in the process.`)
	}
	const type = context.semantics.typeAt(declaration.name)
	const held =
		type === undefined ? Option.none<string>() : mutabilityOf(context.checker, declaration, type)
	return Option.map(
		held,
		(description) =>
			`Module-level constant holds ${description}, shared by every run in the process.`
	)
}

/** The module-level bindings of a variable statement that hold shared state, ambient declarations aside. */
const moduleBindingsOf = (context: RuleContext, node: ts.Node): ReadonlyArray<Report> => {
	if (!ts.isVariableStatement(node) || !ts.isSourceFile(node.parent) || isAmbient(node)) {
		return []
	}
	const kind = bindingKindOf(node)
	return Arr.filterMap(node.declarationList.declarations, (declaration) =>
		Option.match(sharedStateOf(context, kind, declaration), {
			onNone: () => Result.failVoid,
			onSome: (message) =>
				Result.succeed({ node: declaration.name, message, suggestion: SUGGESTION })
		})
	)
}

/** A write to the global object: to a property this module does not declare in `declare global`, or by
 * reflection. */
const globalWritesOf = (
	declaredGlobals: ReadonlyArray<string>,
	node: ts.Node
): ReadonlyArray<Report> => {
	const target = writtenTargetOf(node)
	const property = target === undefined ? Option.none<string>() : globalPropertyOf(target)
	if (Option.isSome(property) && !Arr.contains(declaredGlobals, property.value)) {
		return [
			{
				node,
				message: `Write to the global object's '${property.value}', which this module does not declare in \`declare global\`.`,
				suggestion: SUGGESTION
			}
		]
	}
	if (isReflectiveGlobalWrite(node)) {
		return [
			{
				node,
				message: "Reflective write to the global object; its property cannot be checked.",
				suggestion: SUGGESTION
			}
		]
	}
	return []
}

/**
 * A module holds no state that every request of the process shares. It refuses a module-level `let` or `var`, a
 * module-level constant whose type (by the checker) a write can change in place, and a write to the global object
 * unless the same file declares that global in `declare global`, as a process anchor's module does. A type is judged
 * one level deep: `Readonly<{ items: Array<string> }>` is a value, its array is the reader's to leave alone.
 */
export const noModuleState: Visit = (context) => {
	const declaredGlobals = declaredGlobalsOf(context.sourceFile)
	return (node) => [...moduleBindingsOf(context, node), ...globalWritesOf(declaredGlobals, node)]
}
