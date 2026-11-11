import { Array as Arr, Option, Predicate, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import { type Checker, type Symbol as NativeSymbol, type Type, TypeFlags } from "typescript/sync"
import { type Finding, findingAt } from "#shared/finding.ts"
import { packageOfSymbol } from "#shared/packages.ts"
import type { Semantics } from "#shared/semantic.ts"
import { endsWithWhitespace, startsWithWhitespace, wordsOf } from "#style/css.ts"
import { isNamedBy, type MarkupOption } from "#style/options.ts"
import type { ClassList, StyleRule } from "#style/types.ts"

/** How a class helper reads its arguments: `join` helpers (cn, clsx, twMerge, cx) take class values the way clsx
 * does; `variants` (cva) takes a base and a config of variant classes. */
type HelperKind = "join" | "variants"

/** The class helpers libraries declare, by package and export. */
const LIBRARY_HELPERS: ReadonlyArray<Readonly<{ module: string; name: string; kind: HelperKind }>> =
	[
		{ module: "clsx", name: "clsx", kind: "join" },
		{ module: "tailwind-merge", name: "twMerge", kind: "join" },
		{ module: "class-variance-authority", name: "cva", kind: "variants" },
		{ module: "class-variance-authority", name: "cx", kind: "join" }
	]

/** The name shadcn gives the app's class helper, the module components.json names as its utils. */
const APP_HELPER_NAME = "cn"

/** The classList methods, each with the arguments of a call to it that are classes. */
const CLASS_LIST_METHODS: ReadonlyMap<
	string,
	(classArguments: ReadonlyArray<ts.Expression>) => ReadonlyArray<ts.Expression>
> = new Map([
	["add", (classArguments: ReadonlyArray<ts.Expression>) => classArguments],
	["remove", (classArguments: ReadonlyArray<ts.Expression>) => classArguments],
	["replace", (classArguments: ReadonlyArray<ts.Expression>) => Arr.take(classArguments, 2)],
	["toggle", (classArguments: ReadonlyArray<ts.Expression>) => Arr.take(classArguments, 1)]
])

/** Type members a class value may hold that add no class: clsx skips them. */
const CLASSLESS_TYPES =
	TypeFlags.Undefined | TypeFlags.Null | TypeFlags.Void | TypeFlags.BooleanLiteral

const DYNAMIC_CLASS = {
	message:
		"Interpolation inside a class: Tailwind generates only the classes it reads whole in the source, so this one never exists.",
	suggestion: 'Map each state to a complete class: `wide ? "w-full" : "w-1/2"`.'
} as const

const UNVERIFIABLE_SUGGESTION =
	"Write the classes as literals, a union of literal types, or a lookup in an `as const` table."

const HIDDEN_CLASSES = {
	message:
		"This spread may carry a className no one has checked: the classes enter the element where the linter cannot read them.",
	suggestion:
		"Pass className explicitly, spread a component's own rest props, or spread an object literal."
} as const

type StyleBridge = MarkupOption["styleBridges"][number]

/** What reading a file's classes works with: the checker and its lookups, the style bridges the file owns, the
 * literals the run has read (each once, however many paths reach it), and the file's class lists and findings. */
type Reader = Readonly<{
	checker: Checker
	semantics: Semantics
	classHelper: string
	bridges: ReadonlyArray<StyleBridge>
	visited: Set<string>
	lists: Array<ClassList>
	findings: Array<Finding>
}>

/** True the first time the run reaches `node`, which it records. */
const firstVisit = (reader: Reader, node: ts.Node): boolean => {
	const key = `${node.getSourceFile().fileName}:${node.pos}:${node.end}`
	if (reader.visited.has(key)) {
		return false
	}
	reader.visited.add(key)
	return true
}

/** A name that takes classes: `className`, or a component's `*ClassName` slot. */
const isClassName = (name: string): boolean =>
	name === "className" || Str.endsWith("ClassName")(name)

/** A cva option or clsx-like prop that takes classes. */
const isClassOption = (name: string): boolean => name === "class" || name === "className"

const isWrapper = Predicate.or(
	Predicate.or(ts.isParenthesizedExpression, ts.isAsExpression),
	Predicate.or(ts.isSatisfiesExpression, ts.isNonNullExpression)
)

const unwrapped = (expression: ts.Expression): ts.Expression =>
	isWrapper(expression) ? unwrapped(expression.expression) : expression

const isPlainName = Predicate.or(ts.isIdentifier, ts.isStringLiteral)

const plainNameOf = (name: ts.PropertyName): Option.Option<string> =>
	isPlainName(name) ? Option.some(name.text) : Option.none()

/** The parameter a binding the caller passes in belongs to: the parameter itself, or the one a name is destructured
 * from, however deep. */
const parameterOf = (node: ts.Node): Option.Option<ts.ParameterDeclaration> => {
	if (ts.isParameterDeclaration(node)) {
		return Option.some(node)
	}
	if (
		ts.isBindingElement(node) ||
		ts.isObjectBindingPattern(node) ||
		ts.isArrayBindingPattern(node)
	) {
		return parameterOf(node.parent)
	}
	return Option.none()
}

/** The name a function is declared or bound under. */
const functionNameOf = (node: ts.Node): Option.Option<string> => {
	if (ts.isFunctionDeclaration(node)) {
		return Option.map(Option.fromUndefinedOr(node.name), (name) => name.text)
	}
	if (
		(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
		ts.isVariableDeclaration(node.parent) &&
		ts.isIdentifier(node.parent.name)
	) {
		return Option.some(node.parent.name.text)
	}
	return Option.none()
}

/** A parameter of the app's `cn` itself: the classes its callers pass, read at every call. */
const isHelperParameter = (reader: Reader, node: ts.Node): boolean =>
	Option.exists(
		parameterOf(node),
		(parameter) =>
			Option.contains(functionNameOf(parameter.parent), APP_HELPER_NAME) &&
			parameter.getSourceFile().fileName === reader.classHelper
	)

/** The name a binding takes from what the caller passes: a parameter's own name, or the property a name is
 * destructured from. */
const bindingNameOf = (node: ts.Node): Option.Option<string> => {
	if (
		ts.isBindingElement(node) &&
		node.propertyName !== undefined &&
		ts.isIdentifier(node.propertyName)
	) {
		return Option.some(node.propertyName.text)
	}
	if (!ts.isParameterDeclaration(node) && !ts.isBindingElement(node)) {
		return Option.none()
	}
	return Option.flatMap(Option.fromUndefinedOr(node.name), (name) =>
		ts.isIdentifier(name) ? Option.some(name.text) : Option.none()
	)
}

/** A component's className-like parameter, or a parameter of `cn` itself. */
const isForwardedBinding = (reader: Reader, declaration: ts.Node): boolean =>
	isHelperParameter(reader, declaration) ||
	(Option.exists(bindingNameOf(declaration), isClassName) &&
		Option.isSome(parameterOf(declaration)))

/** The default a forwarded binding takes when the caller passes nothing: written here, so read here. */
const defaultOf = (declaration: ts.Node): Option.Option<ts.Expression> =>
	ts.isParameterDeclaration(declaration) || ts.isBindingElement(declaration)
		? Option.fromUndefinedOr(declaration.initializer)
		: Option.none()

/** The classes of a piece of literal text that starts `offset` characters into `node`. */
const tokensAt = (node: ts.Node, text: string, offset: number): ClassList => {
	const sourceFile = node.getSourceFile()
	const start = node.getStart(sourceFile) + offset
	return Arr.map(wordsOf(text), ({ word, offset: at }) => {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(start + at)
		return { text: word, file: sourceFile.fileName, line: line + 1, column: character + 1 }
	})
}

const report = (
	reader: Reader,
	rule: Extract<StyleRule, "class-extraction" | "no-dynamic-class" | "no-unverifiable-class">,
	node: ts.Node,
	said: Readonly<{ message: string; suggestion: string }>
): void => {
	reader.findings.push(
		findingAt({ sourceFile: node.getSourceFile(), rule, report: { node, ...said } })
	)
}

/** The one declaration a name resolves to, through import aliases. */
const declarationOf = (reader: Reader, node: ts.Node): Option.Option<ts.Node> => {
	const symbol =
		ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
			? reader.checker.getShorthandAssignmentValueSymbol(node.parent)
			: reader.semantics.symbolAt(node)
	if (symbol === undefined) {
		return Option.none()
	}
	const declarations = reader.semantics.declarationsOf(reader.semantics.aliasTarget(symbol))
	return declarations.length === 1 ? Arr.head(declarations) : Option.none()
}

/** The module an ambient declaration (`declare module "clsx" { ... }`) declares. */
const ambientModuleOf = (node: ts.Node): Option.Option<string> => {
	if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
		return Option.some(node.name.text)
	}
	return ts.isSourceFile(node) ? Option.none() : ambientModuleOf(node.parent)
}

/** The package that declares a symbol: from its declaration file under node_modules, or from the ambient module
 * declaration it sits in. */
const moduleOf = (reader: Reader, symbol: NativeSymbol): Option.Option<string> =>
	Option.orElse(Option.fromUndefinedOr(packageOfSymbol(symbol)), () =>
		Option.flatMap(Arr.head(reader.semantics.declarationsOf(symbol)), ambientModuleOf)
	)

/** A value a library declares, such as next/font's `variable`: that library generates its classes. */
const isLibraryValue = (reader: Reader, node: ts.Node): boolean => {
	const symbol = reader.semantics.symbolAt(node)
	return (
		symbol !== undefined && Option.isSome(moduleOf(reader, reader.semantics.aliasTarget(symbol)))
	)
}

const helperOf = (reader: Reader, call: ts.CallExpression): Option.Option<HelperKind> => {
	const symbol = reader.semantics.symbolAt(call.expression)
	if (symbol === undefined) {
		return Option.none()
	}
	const target = reader.semantics.aliasTarget(symbol)
	const library = Arr.findFirst(
		LIBRARY_HELPERS,
		(helper) =>
			helper.name === target.name && Option.contains(moduleOf(reader, target), helper.module)
	)
	if (Option.isSome(library)) {
		return Option.some(library.value.kind)
	}
	if (target.name !== APP_HELPER_NAME) {
		return Option.none()
	}
	return Arr.some(
		reader.semantics.declarationsOf(target),
		(declaration) => declaration.getSourceFile().fileName === reader.classHelper
	)
		? Option.some("join")
		: Option.none()
}

/** The value a name holds when its one declaration gives it: a constant's or an object property's initializer. */
const initializerOf = (reader: Reader, node: ts.Expression): Option.Option<ts.Expression> =>
	Option.flatMap(declarationOf(reader, node), (declaration) => {
		if (
			ts.isVariableDeclaration(declaration) &&
			(declaration.parent.flags & ts.NodeFlags.Const) !== 0
		) {
			return Option.fromUndefinedOr(declaration.initializer)
		}
		return ts.isPropertyAssignment(declaration)
			? Option.some(declaration.initializer)
			: Option.none()
	})

/** `buttonVariants(…)` where `const buttonVariants = cva(…)`: its classes are read at the cva call. */
const isVariantsCall = (reader: Reader, call: ts.CallExpression): boolean =>
	Option.exists(initializerOf(reader, call.expression), (initializer) => {
		const value = unwrapped(initializer)
		return ts.isCallExpression(value) && Option.contains(helperOf(reader, value), "variants")
	})

/** A component's own className-like parameter, a className-like member of one, or a parameter of `cn` itself:
 * read where the caller writes it. */
const isForwardedClass = (reader: Reader, expression: ts.Expression): boolean => {
	if (!ts.isPropertyAccessExpression(expression)) {
		return Option.exists(declarationOf(reader, expression), (declaration) =>
			isForwardedBinding(reader, declaration)
		)
	}
	return (
		isClassName(expression.name.text) &&
		Option.exists(declarationOf(reader, expression.expression), (declaration) =>
			Option.isSome(parameterOf(declaration))
		)
	)
}

/** A component's rest props, `...props` of its parameter: they stay inside the JSX the linter reads. */
const isRestOfParameter = (reader: Reader, expression: ts.Expression): boolean =>
	Option.exists(
		declarationOf(reader, expression),
		(declaration) =>
			ts.isBindingElement(declaration) &&
			declaration.dotDotDotToken !== undefined &&
			Option.isSome(parameterOf(declaration))
	)

/** An expression read through its type: each string literal member is a class list, and any member that is not
 * a literal or a classless value makes the expression unverifiable. */
const fromType = (reader: Reader, expression: ts.Expression): void => {
	const type = reader.semantics.typeAt(expression)
	if (type === undefined) {
		report(reader, "no-unverifiable-class", expression, {
			message: "A class expression the checker gives no type holds classes no one can check.",
			suggestion: UNVERIFIABLE_SUGGESTION
		})
		return
	}
	const members: ReadonlyArray<Type> = type.isUnionType() ? type.getTypes() : [type]
	const classed = Arr.filter(members, (member) => (member.flags & CLASSLESS_TYPES) === 0)
	const literals = Arr.filterMap(classed, (member) =>
		member.isStringLiteralType() ? Result.succeed(member.value) : Result.failVoid
	)
	if (literals.length < classed.length) {
		report(reader, "no-unverifiable-class", expression, {
			message: `A class expression of type '${reader.checker.typeToString(type)}' holds classes no one can check.`,
			suggestion: UNVERIFIABLE_SUGGESTION
		})
		return
	}
	for (const literal of literals) {
		reader.lists.push(tokensAt(expression, literal, 0))
	}
}

/** Whether the interpolation after `before` and ahead of `after` stands as whole classes: whitespace or the
 * template's ends on both sides. */
const standsAlone = (
	input: Readonly<{ before: string; after: string; first: boolean; last: boolean }>
): boolean => {
	if (!endsWithWhitespace(input.before) && !(input.first && input.before === "")) {
		return false
	}
	if (startsWithWhitespace(input.after)) {
		return true
	}
	return input.last && input.after === ""
}

const pieceText = (pieces: ReadonlyArray<ts.TemplateLiteralLikeNode>, index: number): string =>
	Option.match(Arr.get(pieces, index), {
		onNone: () => "",
		onSome: (piece) => piece.text
	})

/** A template's literal text is one class list, less the partial classes glued to an interpolation; an
 * interpolation that stands alone is read as classes, one glued inside a class is `no-dynamic-class`. */
const fromTemplate = (reader: Reader, template: ts.TemplateExpression): void => {
	const pieces: ReadonlyArray<ts.TemplateLiteralLikeNode> = [
		template.head,
		...Arr.map(template.templateSpans, (span) => span.literal)
	]
	const spans = template.templateSpans
	const alone = Arr.makeBy(spans.length, (index) =>
		standsAlone({
			before: pieceText(pieces, index),
			after: pieceText(pieces, index + 1),
			first: index === 0,
			last: index === spans.length - 1
		})
	)
	const tokens = Arr.flatMap(pieces, (piece, index) => {
		const words = tokensAt(piece, piece.text, 1)
		const gluedBefore = index > 0 && !Option.contains(Arr.get(alone, index - 1), true)
		const gluedAfter = index < spans.length && !Option.contains(Arr.get(alone, index), true)
		const kept = gluedBefore && !startsWithWhitespace(piece.text) ? Arr.drop(words, 1) : words
		return gluedAfter && !endsWithWhitespace(piece.text) ? Arr.dropRight(kept, 1) : kept
	})
	reader.lists.push(tokens)
	Arr.forEach(spans, (span, index) => {
		if (Option.contains(Arr.get(alone, index), true)) {
			classesOf(reader, span.expression)
		} else {
			report(reader, "no-dynamic-class", span.expression, DYNAMIC_CLASS)
		}
	})
}

const objectLiteralOf = (
	reader: Reader,
	expression: ts.Expression
): Option.Option<ts.ObjectLiteralExpression> => {
	const value = unwrapped(expression)
	if (ts.isObjectLiteralExpression(value)) {
		return Option.some(value)
	}
	return Option.flatMap(initializerOf(reader, value), (initializer) =>
		objectLiteralOf(reader, initializer)
	)
}

/** One member of a class configuration: its name, when it has a plain one, and its value. */
type Member = Readonly<{ name: Option.Option<string>; value: ts.Expression }>

/** The members of an object literal, its spreads of other literal objects expanded in place; an expression that is
 * no literal object, even through its constant, is read through its type. A method or accessor hides its value. */
const membersOf = (reader: Reader, expression: ts.Expression): ReadonlyArray<Member> =>
	Option.match(objectLiteralOf(reader, expression), {
		onNone: () => {
			fromType(reader, expression)
			return []
		},
		onSome: (object) => Arr.flatMap(object.properties, (property) => memberOf(reader, property))
	})

const memberOf = (reader: Reader, property: ts.ObjectLiteralElementLike): ReadonlyArray<Member> => {
	if (ts.isPropertyAssignment(property)) {
		return [{ name: plainNameOf(property.name), value: property.initializer }]
	}
	if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)) {
		return [{ name: Option.some(property.name.text), value: property.name }]
	}
	if (ts.isSpreadAssignment(property)) {
		return membersOf(reader, property.expression)
	}
	report(reader, "class-extraction", property, {
		message: "A method or accessor in a class configuration hides the classes it holds.",
		suggestion: "Write the configuration's values as properties."
	})
	return []
}

const valuesNamed = (
	members: ReadonlyArray<Member>,
	names: ReadonlyArray<string>
): ReadonlyArray<ts.Expression> =>
	Arr.filterMap(members, (member) =>
		Option.exists(member.name, (name) => Arr.contains(names, name))
			? Result.succeed(member.value)
			: Result.failVoid
	)

const valuesOf = (members: ReadonlyArray<Member>): ReadonlyArray<ts.Expression> =>
	Arr.map(members, (member) => member.value)

/** cva(base, { variants: { name: { value: classes } }, compoundVariants: [{ class }] }). */
const fromVariants = (reader: Reader, call: ts.CallExpression): void => {
	const [base, config] = call.arguments
	if (base !== undefined) {
		classesOf(reader, base)
	}
	if (config === undefined) {
		return
	}
	const settings = membersOf(reader, config)
	const variants = Arr.flatMap(valuesNamed(settings, ["variants"]), (section) =>
		valuesOf(membersOf(reader, section))
	)
	const compounds = Arr.flatMap(valuesNamed(settings, ["compoundVariants"]), (list) => {
		const entries = unwrapped(list)
		return ts.isArrayLiteralExpression(entries) ? entries.elements : []
	})
	const classes = [
		...Arr.flatMap(variants, (variant) => valuesOf(membersOf(reader, variant))),
		...Arr.flatMap(compounds, (entry) =>
			valuesNamed(membersOf(reader, entry), ["class", "className"])
		)
	]
	for (const value of classes) {
		classesOf(reader, value)
	}
}

/** A clsx object's key is a class list; its value is only the condition. */
const fromProperty = (reader: Reader, property: ts.ObjectLiteralElementLike): void => {
	if (ts.isSpreadAssignment(property)) {
		classesOf(reader, property.expression)
		return
	}
	if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
		return
	}
	const key = property.name
	if (ts.isComputedPropertyName(key)) {
		classesOf(reader, key.expression)
		return
	}
	if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
		reader.lists.push(tokensAt(key, key.text, ts.isStringLiteral(key) ? 1 : 0))
	}
}

/** Whether a value's type may carry classes the linter cannot read: a className-like property, a string index, or
 * a type the checker cannot pin down. */
const mayCarryClasses = (reader: Reader, value: ts.Expression): boolean => {
	const type = reader.semantics.typeAt(value)
	if (type === undefined || (type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
		return true
	}
	return (
		Arr.some(reader.checker.getPropertiesOfType(type), (property) => isClassName(property.name)) ||
		Arr.some(
			reader.checker.getIndexInfosOfType(type),
			(info) => (info.keyType.flags & TypeFlags.String) !== 0
		)
	)
}

/** The class options of a props object: its `class` and `className` read as classes, its spreads followed to the
 * objects they spread; a spread of anything else that may carry classes hides them. */
const fromClassOptions = (reader: Reader, node: ts.Node, value: ts.Expression): void => {
	Option.match(objectLiteralOf(reader, value), {
		onNone: () => {
			if (mayCarryClasses(reader, value)) {
				report(reader, "class-extraction", node, HIDDEN_CLASSES)
			}
		},
		onSome: (object) => {
			for (const property of object.properties) {
				if (ts.isSpreadAssignment(property)) {
					fromClassOptions(reader, property, property.expression)
				} else if (ts.isPropertyAssignment(property)) {
					if (Option.exists(plainNameOf(property.name), isClassOption)) {
						classesOf(reader, property.initializer)
					}
				} else if (
					ts.isShorthandPropertyAssignment(property) &&
					ts.isIdentifier(property.name) &&
					isClassOption(property.name.text)
				) {
					classesOf(reader, property.name)
				}
			}
		}
	})
}

/** A parameter binding of the given name in a binding pattern: unrenamed, and a rest binding or not as asked. */
const bridgeOperandOf = (
	reader: Reader,
	expression: ts.Expression | undefined,
	input: Readonly<{ name: string; rest: boolean }>
): Option.Option<ts.BindingElement> => {
	if (expression === undefined || !ts.isIdentifier(expression) || expression.text !== input.name) {
		return Option.none()
	}
	return Option.filter(
		declarationOf(reader, expression),
		(declaration): declaration is ts.BindingElement =>
			ts.isBindingElement(declaration) &&
			declaration.propertyName === undefined &&
			(declaration.dotDotDotToken !== undefined) === input.rest &&
			Option.isSome(parameterOf(declaration))
	)
}

/** A call to the file's style bridge with its component's base props and rest props, both bound by one parameter:
 * the bridge only forwards checked inputs, so its result carries no unread class. */
const isBridgeCall = (reader: Reader, value: ts.Expression): boolean => {
	if (
		!ts.isCallExpression(value) ||
		!ts.isIdentifier(value.expression) ||
		value.arguments.length !== 2
	) {
		return false
	}
	const callee = value.expression
	const [baseArgument, overlayArgument] = value.arguments
	return Arr.some(reader.bridges, (bridge) => {
		const base = bridgeOperandOf(reader, baseArgument, { name: bridge.base, rest: false })
		const overlay = bridgeOperandOf(reader, overlayArgument, { name: bridge.overlay, rest: true })
		return (
			callee.text === bridge.function &&
			Option.exists(
				declarationOf(reader, callee),
				(declaration) =>
					ts.isFunctionDeclaration(declaration) &&
					declaration.getSourceFile() === value.getSourceFile() &&
					Option.contains(functionNameOf(declaration), bridge.function)
			) &&
			Option.exists(base, (found) => Option.exists(overlay, (rest) => found.parent === rest.parent))
		)
	})
}

/** A JSX spread brings props in wholesale: a component's rest props and the style bridge's result are read where
 * they come from, an object literal's class options are read here, and anything else that may carry classes hides
 * them. */
const fromSpread = (reader: Reader, spread: ts.JsxSpreadAttribute): void => {
	const value = unwrapped(spread.expression)
	if (!isBridgeCall(reader, value) && !isRestOfParameter(reader, value)) {
		fromClassOptions(reader, spread, value)
	}
}

const fromCall = (reader: Reader, call: ts.CallExpression): void => {
	const helper = helperOf(reader, call)
	if (Option.contains(helper, "variants")) {
		fromVariants(reader, call)
		return
	}
	if (Option.isSome(helper)) {
		for (const argument of call.arguments) {
			classesOf(reader, ts.isSpreadElement(argument) ? argument.expression : argument)
		}
		return
	}
	if (!isVariantsCall(reader, call)) {
		fromType(reader, call)
		return
	}
	for (const argument of call.arguments) {
		fromClassOptions(reader, argument, argument)
	}
}

/** `TONES[tone]`: a lookup in a table whose literal object the linter reads is every value of that table; any
 * other lookup is read through its type. */
const fromLookup = (reader: Reader, access: ts.ElementAccessExpression): void => {
	Option.match(objectLiteralOf(reader, access.expression), {
		onNone: () => {
			fromType(reader, access)
		},
		onSome: (table) => {
			for (const value of valuesOf(
				Arr.flatMap(table.properties, (property) => memberOf(reader, property))
			)) {
				classesOf(reader, value)
			}
		}
	})
}

const fromBinary = (reader: Reader, binary: ts.BinaryExpression): void => {
	const operator = binary.operatorToken.kind
	if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
		classesOf(reader, binary.right)
		return
	}
	if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
		classesOf(reader, binary.left)
		classesOf(reader, binary.right)
		return
	}
	fromType(reader, binary)
}

const fromName = (reader: Reader, name: ts.Expression): void => {
	if (isForwardedClass(reader, name)) {
		const fallback = Option.flatMap(declarationOf(reader, name), defaultOf)
		if (Option.isSome(fallback)) {
			classesOf(reader, fallback.value)
		}
		return
	}
	if (isLibraryValue(reader, name)) {
		return
	}
	Option.match(initializerOf(reader, name), {
		onNone: () => {
			fromType(reader, name)
		},
		onSome: (initializer) => {
			classesOf(reader, initializer)
		}
	})
}

/** Reads one class expression down to its literals; a node already read in this run is skipped. */
const classesOf = (reader: Reader, node: ts.Expression): void => {
	const expression = unwrapped(node)
	if (!firstVisit(reader, expression)) {
		return
	}
	if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
		reader.lists.push(tokensAt(expression, expression.text, 1))
		return
	}
	if (ts.isConditionalExpression(expression)) {
		classesOf(reader, expression.whenTrue)
		classesOf(reader, expression.whenFalse)
		return
	}
	if (ts.isArrayLiteralExpression(expression)) {
		for (const element of expression.elements) {
			classesOf(reader, ts.isSpreadElement(element) ? element.expression : element)
		}
		return
	}
	if (ts.isObjectLiteralExpression(expression)) {
		for (const property of expression.properties) {
			fromProperty(reader, property)
		}
		return
	}
	readComposite(reader, expression)
}

/** The class expressions built from others: templates, operators, calls and names. */
const readComposite = (reader: Reader, expression: ts.Expression): void => {
	if (ts.isTemplateExpression(expression)) {
		fromTemplate(reader, expression)
		return
	}
	if (ts.isBinaryExpression(expression)) {
		fromBinary(reader, expression)
		return
	}
	if (ts.isCallExpression(expression)) {
		fromCall(reader, expression)
		return
	}
	if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
		fromName(reader, expression)
		return
	}
	if (ts.isElementAccessExpression(expression)) {
		fromLookup(reader, expression)
		return
	}
	fromType(reader, expression)
}

const fromAttribute = (reader: Reader, attribute: ts.JsxAttribute): void => {
	const initializer = attribute.initializer
	if (initializer !== undefined && ts.isStringLiteral(initializer)) {
		classesOf(reader, initializer)
		return
	}
	if (
		initializer !== undefined &&
		ts.isJsxExpression(initializer) &&
		initializer.expression !== undefined
	) {
		classesOf(reader, initializer.expression)
	}
}

/** `element.classList.add(…)` and its kin, and `element.setAttribute("class", …)`: the arguments that are classes. */
const domClassArgumentsOf = (call: ts.CallExpression): ReadonlyArray<ts.Expression> => {
	const callee = call.expression
	if (!ts.isPropertyAccessExpression(callee)) {
		return []
	}
	const method = callee.name.text
	const owner = callee.expression
	const classesAmong = CLASS_LIST_METHODS.get(method)
	if (
		classesAmong !== undefined &&
		ts.isPropertyAccessExpression(owner) &&
		owner.name.text === "classList"
	) {
		return classesAmong(call.arguments)
	}
	const [name, value] = call.arguments
	return method === "setAttribute" &&
		name !== undefined &&
		ts.isStringLiteralLikeNode(name) &&
		name.text === "class" &&
		value !== undefined
		? [value]
		: []
}

/** The class expression a node writes, when it writes one outside JSX: a `className` property of an object, or an
 * assignment to an element's `className`. */
const writtenClassesOf = (node: ts.Node): Option.Option<ts.Expression> => {
	if (ts.isPropertyAssignment(node) && Option.exists(plainNameOf(node.name), isClassName)) {
		return Option.some(node.initializer)
	}
	if (
		ts.isShorthandPropertyAssignment(node) &&
		ts.isIdentifier(node.name) &&
		isClassName(node.name.text)
	) {
		return Option.some(node.name)
	}
	if (
		ts.isBinaryExpression(node) &&
		node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
		ts.isPropertyAccessExpression(node.left) &&
		node.left.name.text === "className"
	) {
		return Option.some(node.right)
	}
	return Option.none()
}

/** The static class lists and the findings for class expressions that hold classes no one can read. */
type FileClasses = Readonly<{
	lists: ReadonlyArray<ClassList>
	findings: ReadonlyArray<Finding>
}>

/**
 * Finds every class string in a file: JSX `className` and `*ClassName` attributes, `className` properties of
 * objects and assignments to an element's `className`, `classList` and `setAttribute("class")` calls, and every
 * call the checker resolves to a class helper, anywhere in the file. A class expression is read down to its
 * literals: branches of conditionals and logical operators, a template's literal text, clsx-style objects and
 * arrays, cva's base, variant values and compound classes, the class options of a call to a cva-made function, and
 * names followed to the constants that declare them. What cannot be read statically is a finding: an interpolation
 * inside a class (`no-dynamic-class`), an expression typed as a plain `string` (`no-unverifiable-class`), or a JSX
 * spread that may carry a className from where the linter cannot see it (`class-extraction`); a union of literal
 * types is read literal by literal. A component's own `className` parameter is read where its caller writes it (and
 * its default where it is declared), a call to a cva-made function where cva is called, a call to the file's style
 * bridge where its component's props come from, and a class a library hands over (next/font's `variable`) is that
 * library's to generate. One extractor serves a whole run, so a literal
 * reached from several files is read once.
 */
export const classExtractor = (
	input: Readonly<{ checker: Checker; classHelper: string; bridges: ReadonlyArray<StyleBridge> }>
) => {
	const visited = new Set<string>()
	return (file: Readonly<{ sourceFile: ts.SourceFile; semantics: Semantics }>): FileClasses => {
		const reader: Reader = {
			checker: input.checker,
			semantics: file.semantics,
			classHelper: input.classHelper,
			bridges: Arr.filter(input.bridges, (bridge) =>
				isNamedBy(bridge.path)(file.sourceFile.fileName)
			),
			visited,
			lists: [],
			findings: []
		}
		const walk = (node: ts.Node): void => {
			if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && isClassName(node.name.text)) {
				fromAttribute(reader, node)
			}
			if (ts.isJsxSpreadAttribute(node)) {
				fromSpread(reader, node)
			}
			if (ts.isCallExpression(node) && Option.isSome(helperOf(reader, node))) {
				classesOf(reader, node)
			}
			if (ts.isCallExpression(node)) {
				for (const argument of domClassArgumentsOf(node)) {
					classesOf(reader, argument)
				}
			}
			const written = writtenClassesOf(node)
			if (Option.isSome(written)) {
				classesOf(reader, written.value)
			}
			node.forEachChild(walk)
		}
		walk(file.sourceFile)
		return { lists: reader.lists, findings: reader.findings }
	}
}
