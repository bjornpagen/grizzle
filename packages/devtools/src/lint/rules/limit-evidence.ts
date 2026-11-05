import { Array as Arr, Option, Predicate, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import { type Symbol as NativeSymbol, SymbolFlags, type Type, TypeFlags } from "typescript/sync"
import type { BoundPosition, Category, SuperlintOptions } from "#lint/options.ts"
import { isAtAny, isDefaultLibraryPath, isPackageModule, isRepositoryModule } from "#lint/paths.ts"
import type { RuleContext, Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"

/**
 * The expression a property assignment gives its property: a full assignment's initializer, or a shorthand's own
 * identifier, the one name a shorthand property can carry.
 */
const propertyValue = (
	node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment
): Option.Option<ts.Expression> =>
	ts.isPropertyAssignment(node)
		? Option.some(node.initializer)
		: ts.isIdentifier(node.name)
			? Option.some(node.name)
			: Option.none()

type LimitOptions = SuperlintOptions["limitEvidence"]

type LimitScope = LimitOptions["scopes"][number]

/** The categories, in the order a name that says several of them is read: `maxRetries` is a retry count. */
const CATEGORIES: ReadonlyArray<Category> = ["time", "concurrency", "retry", "size", "length"]

/** The properties that read a data length, the language's own: an array's or a string's length, a collection's size,
 * a buffer's byteLength. */
const LENGTH_READS: ReadonlyArray<string> = ["length", "size", "byteLength"]

/** The default library's functions whose value is one of their arguments': Math.min and Math.max choose one, Number
 * and BigInt convert one. */
const EXTREMA: ReadonlyArray<string> = ["min", "max"]

const CONVERSIONS: ReadonlyArray<string> = ["Number", "BigInt"]

/** The clocks a library reads the current time off, whose differences are times. */
const CLOCKS: ReadonlyArray<string> = ["Date", "performance"]

const PHRASES: Readonly<Record<BoundPosition, string>> = {
	comparison: "a comparison",
	loop: "a loop",
	extremum: "Math.min or Math.max",
	length: "a length or a count",
	time: "a time",
	concurrency: "a concurrency",
	retry: "a retry policy",
	size: "a resource's size"
}

/** How a bare number is written: in decimal; in hexadecimal, octal or binary (every literal of it), as a code unit
 * or a bit pattern is; or as a duration's text, `"5 seconds"`. */
type Notation = "decimal" | "spelled" | "duration"

/** A bare number: a literal, a number constant, or arithmetic of only those. It is reported at `node` as `text`, with
 * its value where it has one and its notation. */
type Bare = Readonly<{
	node: ts.Node
	text: string
	value: Option.Option<number>
	notation: Notation
}>

/** How a bare number enters a value that also reads data: added to it, as an alternative to it, as a parameter's
 * default, as a variable's initial value, as an argument of Math.min or Math.max, by any arithmetic on a Limit's
 * value, which derives a bound outside `derived`, or as an argument a function of the scope carries into the value it
 * returns. A bare number that scales, shifts, masks or reduces other data is a unit conversion or byte arithmetic. */
type Role = "offset" | "fallback" | "default" | "initial" | "clamp" | "derivation" | "argument"

type Term = Readonly<{ bare: Bare; role: Role }>

/** What an expression is: a bare number, or a value that reads data (a parameter, a property, a call's result, a
 * Limit's value), with the bare numbers that enter it and whether it is exactly a Limit's value. */
type Shape =
	| Readonly<{ kind: "bare"; bare: Bare }>
	| Readonly<{ kind: "data"; terms: ReadonlyArray<Term>; limit: boolean }>

/** What the other operands of a comparison, or the other arguments of Math.min or Math.max, are: a data length,
 * against which an offset or a counter's start is index arithmetic; a count (a data length or a value whose name says
 * a category), against which a literal written in hexadecimal is a count too; and a bare number, against which a
 * counter's initial value is its bound. */
type Against = Readonly<{ length: boolean; count: boolean; bare: boolean }>

/** Where a value sits: a value that sets a resource (an argument, a property, an assignment), or an operand compared
 * with others, for which 2 may be the integer identity, as in `n < 2` (n <= 1) or `n >= 2` (n > 1). */
type Placement =
	| Readonly<{ kind: "value"; position: BoundPosition }>
	| Readonly<{
			kind: "operand"
			position: BoundPosition
			integerIdentity: boolean
			against: Against
	  }>

type Invocation = ts.CallExpression | ts.NewExpression

/** A value in a bound position, with the call it is an argument of or lies in, whose input builder (a test's
 * generator) makes it the test's input. */
type Bound = Readonly<{
	value: ts.Expression
	placement: Placement
	call: Option.Option<Invocation>
}>

/** A function of the repository with its body: its parameters are what its callers pass. */
type Callee = Readonly<{ declaration: ts.FunctionLikeDeclaration; body: ts.Node }>

/** What a callee's parameter is read as: its index, and the properties read off it, outermost first. */
type Slot = Readonly<{ index: number; path: ReadonlyArray<string> }>

/** A bound position a callee's parameter reaches. */
type Reach = Readonly<{ slot: Slot; placement: Placement }>

/** An object literal a value is, through constants and Object.freeze, and whether a parameter's default holds it. */
type Holder = Readonly<{ literal: ts.ObjectLiteralExpression; defaulted: boolean }>

/** How a declaration holds the value a read reaches through it: as its value, as a variable's initial value, or as
 * a parameter's default. */
type Holding = "held" | "initial" | "default"

const DATA: Shape = { kind: "data", terms: [], limit: false }

const ARITHMETIC: ReadonlyMap<ts.SyntaxKind, (a: number, b: number) => number> = new Map<
	ts.SyntaxKind,
	(a: number, b: number) => number
>([
	[ts.SyntaxKind.PlusToken, (a, b) => a + b],
	[ts.SyntaxKind.MinusToken, (a, b) => a - b],
	[ts.SyntaxKind.AsteriskToken, (a, b) => a * b],
	[ts.SyntaxKind.SlashToken, (a, b) => a / b],
	[ts.SyntaxKind.PercentToken, (a, b) => a % b],
	[ts.SyntaxKind.AsteriskAsteriskToken, (a, b) => a ** b],
	[ts.SyntaxKind.LessThanLessThanToken, (a, b) => a << b],
	[ts.SyntaxKind.GreaterThanGreaterThanToken, (a, b) => a >> b],
	[ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, (a, b) => a >>> b],
	[ts.SyntaxKind.AmpersandToken, (a, b) => a & b],
	[ts.SyntaxKind.BarToken, (a, b) => a | b],
	[ts.SyntaxKind.CaretToken, (a, b) => a ^ b]
])

const UNARY: ReadonlyMap<ts.SyntaxKind, (a: number) => number> = new Map<
	ts.SyntaxKind,
	(a: number) => number
>([
	[ts.SyntaxKind.MinusToken, (a) => -a],
	[ts.SyntaxKind.PlusToken, (a) => a],
	[ts.SyntaxKind.TildeToken, (a) => ~a]
])

const STEPS: ReadonlyArray<ts.SyntaxKind> = [
	ts.SyntaxKind.PlusPlusToken,
	ts.SyntaxKind.MinusMinusToken
]

const ADDITIVE: ReadonlyArray<ts.SyntaxKind> = [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken]

const ALTERNATIVES: ReadonlyArray<ts.SyntaxKind> = [
	ts.SyntaxKind.QuestionQuestionToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.AmpersandAmpersandToken
]

const RELATIONAL: ReadonlyArray<ts.SyntaxKind> = [
	ts.SyntaxKind.LessThanToken,
	ts.SyntaxKind.LessThanEqualsToken,
	ts.SyntaxKind.GreaterThanToken,
	ts.SyntaxKind.GreaterThanEqualsToken
]

/** The assignments that set their target to a value: plainly, by adding or subtracting it, by scaling by it, or as a
 * fallback for it. */
const ASSIGNMENTS: ReadonlyArray<ts.SyntaxKind> = [
	ts.SyntaxKind.EqualsToken,
	ts.SyntaxKind.PlusEqualsToken,
	ts.SyntaxKind.MinusEqualsToken,
	ts.SyntaxKind.AsteriskEqualsToken,
	ts.SyntaxKind.QuestionQuestionEqualsToken,
	ts.SyntaxKind.BarBarEqualsToken
]

const isUpper = (character: string): boolean => character >= "A" && character <= "Z"

const isLowerOrDigit = (character: string): boolean =>
	(character >= "a" && character <= "z") || (character >= "0" && character <= "9")

/** The words of a name, lower case: `idleTimeoutMs` is idle, timeout and ms; `PAGE_MAX_SIZE` is page, max and size;
 * `HTTPServer` is http and server. */
const wordsOf = (name: string): ReadonlyArray<string> => {
	const characters = Str.split("")(name)
	const words: Array<string> = []
	let word = ""
	for (const [index, character] of characters.entries()) {
		const previous = characters[index - 1] ?? ""
		const next = characters[index + 1] ?? ""
		const opens =
			isUpper(character) &&
			(isLowerOrDigit(previous) || (isUpper(previous) && isLowerOrDigit(next)))
		if (character === "_" || character === "$" || opens) {
			if (Str.isNonEmpty(word)) {
				words.push(Str.toLowerCase(word))
			}
			word = character === "_" || character === "$" ? "" : character
		} else {
			word += character
		}
	}
	if (Str.isNonEmpty(word)) {
		words.push(Str.toLowerCase(word))
	}
	return words
}

const hasWordIn = (name: string, words: ReadonlyArray<string>): boolean =>
	Arr.some(wordsOf(name), (word) => Arr.contains(words, word))

/** The units a duration's text names, Effect's Duration.Unit: `"5 seconds"`, `"100 millis"`. */
const DURATION_UNITS: ReadonlyArray<string> = [
	"nano",
	"nanos",
	"micro",
	"micros",
	"milli",
	"millis",
	"second",
	"seconds",
	"minute",
	"minutes",
	"hour",
	"hours",
	"day",
	"days",
	"week",
	"weeks"
]

/** A duration written as text, `"5 seconds"`: a number, a space, a unit; `"100 rows"` is no duration. */
const durationValueOf = (text: string): Option.Option<number> => {
	const parts = Str.split(" ")(text)
	const [amount, unit] = parts
	if (
		parts.length !== 2 ||
		unit === undefined ||
		!Str.isNonEmpty(amount) ||
		!Arr.contains(DURATION_UNITS, unit)
	) {
		return Option.none()
	}
	const value = Number(amount)
	return Number.isFinite(value) ? Option.some(value) : Option.none()
}

const textOf = (node: ts.Node): string => node.getText(node.getSourceFile())

const literalValueOf = (literal: ts.NumericLiteral | ts.BigIntLiteral): Option.Option<number> => {
	const value = Number(
		ts.isBigIntLiteral(literal) && Str.endsWith("n")(literal.text)
			? Str.slice(0, -1)(literal.text)
			: literal.text
	)
	return Number.isNaN(value) ? Option.none() : Option.some(value)
}

const isConstList = (node: ts.Node): boolean =>
	ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0

const isAmbient = (statement: ts.VariableStatement): boolean =>
	Arr.some(statement.modifiers ?? [], (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)

const isExported = (statement: ts.VariableStatement): boolean =>
	Arr.some(statement.modifiers ?? [], (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)

const isReadonly = (declaration: ts.PropertyDeclaration): boolean =>
	Arr.some(
		declaration.modifiers ?? [],
		(modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword
	)

/** An expression without the parentheses, assertions and `satisfies` around it, which change no value. */
const stripped = (expression: ts.Expression): ts.Expression =>
	ts.isParenthesizedExpression(expression) ||
	ts.isAsExpression(expression) ||
	ts.isSatisfiesExpression(expression) ||
	ts.isNonNullExpression(expression) ||
	ts.isTypeAssertion(expression)
		? stripped(expression.expression)
		: expression

/** The key an element access or a computed name writes as a string. */
const literalKeyOf = (expression: ts.Expression): Option.Option<string> => {
	const key = stripped(expression)
	return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)
		? Option.some(key.text)
		: Option.none()
}

/** Whether a call is `Object.freeze(…)`, as written: the format tag of the constant it is held by documents it. */
const isFreezeCall = (node: ts.Node): boolean =>
	ts.isCallExpression(node) &&
	ts.isPropertyAccessExpression(node.expression) &&
	ts.isIdentifier(node.expression.expression) &&
	node.expression.expression.text === "Object" &&
	node.expression.name.text === "freeze"

/** The constant a const object literal's property belongs to: its variable, through nested objects, `as const`,
 * `satisfies` and Object.freeze. */
const constantOfProperty = (
	property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment
): Option.Option<ts.VariableDeclaration> => {
	const holder = (node: ts.Node): Option.Option<ts.VariableDeclaration> => {
		const { parent } = node
		if (
			ts.isAsExpression(parent) ||
			ts.isSatisfiesExpression(parent) ||
			ts.isParenthesizedExpression(parent) ||
			isFreezeCall(parent)
		) {
			return holder(parent)
		}
		if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
			return holder(parent.parent)
		}
		return ts.isVariableDeclaration(parent) &&
			parent.initializer === node &&
			isConstList(parent.parent)
			? Option.some(parent)
			: Option.none()
	}
	return ts.isObjectLiteralExpression(property.parent) ? holder(property.parent) : Option.none()
}

/** The name a callee is written by: `f` in `f(…)`, `fn` in `Effect.fn(…)`. */
const calledNameOf = (callee: ts.Expression): Option.Option<string> => {
	if (ts.isIdentifier(callee)) {
		return Option.some(callee.text)
	}
	return ts.isPropertyAccessExpression(callee) ? Option.some(callee.name.text) : Option.none()
}

/** Whether an expression spells one of the names. */
const mentionsName = (node: ts.Node, names: ReadonlySet<string>): boolean =>
	(ts.isIdentifier(node) && names.has(node.text)) ||
	node.forEachChild((child) => (mentionsName(child, names) ? true : undefined)) === true

/** The key a destructuring element reads, when it is written. */
const bindingKeyOf = (element: ts.BindingElement): Option.Option<string> => {
	const key = element.propertyName ?? element.name
	return key !== undefined && (ts.isIdentifier(key) || ts.isStringLiteral(key))
		? Option.some(key.text)
		: Option.none()
}

/** Whether an expression is a loop's condition, or a part of one: that loop's bound. */
const isLoopCondition = (node: ts.Node): boolean => {
	const { parent } = node
	if (
		ts.isParenthesizedExpression(parent) ||
		(ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) ||
		(ts.isBinaryExpression(parent) &&
			(parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
				parent.operatorToken.kind === ts.SyntaxKind.BarBarToken))
	) {
		return isLoopCondition(parent)
	}
	return (
		(ts.isForStatement(parent) && parent.condition === node) ||
		((ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === node)
	)
}

/**
 * The numbers that are identities at a placement, never a bound: 0 everywhere; 1 everywhere but in a time a value
 * sets, which carries a unit, so one of it is a choice; -1 where a value is compared or counts from the end; and 2 in
 * `n < 2` and `n >= 2`, which are `n <= 1` and `n > 1` over the integers.
 */
const identitiesAt = (placement: Placement): ReadonlyArray<number> => {
	if (placement.kind === "operand") {
		return placement.integerIdentity ? [0, 1, -1, 2] : [0, 1, -1]
	}
	if (placement.position === "time") {
		return [0]
	}
	return placement.position === "length" ? [0, 1, -1] : [0, 1]
}

/** The symbols a bare number can be held by: a variable (a constant, a parameter, a binding), a property and an enum
 * member. A function, a class or a module holds none, so its declaration is never read. */
const HOLDS_A_NUMBER = SymbolFlags.Variable | SymbolFlags.Property | SymbolFlags.EnumMember

const isNumberLike = (type: Type): boolean =>
	Arr.every(
		type.isUnionType() ? type.getTypes() : [type],
		(member) => (member.flags & (TypeFlags.NumberLike | TypeFlags.BigIntLike)) !== 0
	)

/** Whether a type is a closed set of number literals (`0 | 1 | 2`), whose values are a vocabulary's members, never a
 * count a caller tunes. */
const isClosedNumberType = (type: Type): boolean =>
	Arr.every(type.isUnionType() ? type.getTypes() : [type], (member) => member.isNumberLiteralType())

const isLibraryPath = (path: string): boolean =>
	Str.includes("/node_modules/")(path) || isDefaultLibraryPath(path)

/** The scope a file is in: the first that names it and does not mark it generated. */
const scopeOf = (
	root: string,
	scopes: ReadonlyArray<LimitScope>,
	fileName: string
): Option.Option<LimitScope> =>
	Arr.findFirst(
		scopes,
		(scope) =>
			isAtAny(root, scope.files, fileName) &&
			!Arr.some(scope.generated, (suffix) => Str.endsWith(suffix)(fileName))
	)

/** The time units a name may say, in nanoseconds: a constant whose name says exactly two of them and holds their
 * ratio is a unit conversion (`millisPerSecond`, `daySeconds`), never a bound. */
const TIME_UNITS: ReadonlyMap<string, number> = new Map([
	["nanos", 1],
	["nanoseconds", 1],
	["micros", 1e3],
	["microseconds", 1e3],
	["ms", 1e6],
	["milli", 1e6],
	["millis", 1e6],
	["millisecond", 1e6],
	["milliseconds", 1e6],
	["second", 1e9],
	["seconds", 1e9],
	["minute", 6e10],
	["minutes", 6e10],
	["hour", 3.6e12],
	["hours", 3.6e12],
	["day", 8.64e13],
	["days", 8.64e13],
	["week", 6.048e14],
	["weeks", 6.048e14]
])

/** The words a unit conversion's name joins its two units with. */
const UNIT_JOINERS: ReadonlyArray<string> = ["per", "in"]

/** Whether a constant is a unit conversion: its name's words are two time units (with a joiner or none), and it holds
 * exactly the larger unit in the smaller. */
const isUnitConversion = (name: string, value: Option.Option<number>): boolean => {
	const words = Arr.filter(wordsOf(name), (word) => !Arr.contains(UNIT_JOINERS, word))
	const [first, second] = Arr.filterMap(words, (word): Result.Result<number, void> => {
		const nanos = TIME_UNITS.get(word)
		return nanos === undefined ? Result.failVoid : Result.succeed(nanos)
	})
	return (
		words.length === 2 &&
		first !== undefined &&
		second !== undefined &&
		Option.contains(value, Math.max(first, second) / Math.min(first, second))
	)
}

/**
 * A bound is a Limit or a caller's input, never a bare number. In its scopes' files, a bare number (a literal other
 * than an identity, a number constant that is no Limit's value, or arithmetic of only those) is refused where it
 * bounds something: a comparison's operand, in a loop's condition or outside one; an argument of Math.min or
 * Math.max; and a value that sets a length or a count, a time, a concurrency, a retry policy or a resource's size: an
 * argument by its library parameter's name, a category module's function, or a parameter of the scope's own that
 * accepts a category module's type; a property by its name (every property's in the library, a library's only in the
 * tests, whose own records are data), or by being a duration's text; and a property assigned by its name. A comparison
 * with a value whose name says a category, or with a clock's reading, bounds that category.
 *
 * A number reaches a bound however it is held: a constant, a countdown's initial value, a parameter's default, an
 * object's property (through constants and Object.freeze), an enum member, a class's property, a default export, or an
 * argument, or a property of one, of a function of the same scope (an Effect.fn's too) whose body puts that parameter
 * in a bound position, however deep the calls go; and a call of a function of the same scope is the value its body
 * returns, with every bare number an argument carries into it, through the functions that body calls in turn (never a
 * wrapper's, a generator's or an async function's, nor one whose type is a closed set of number literals). A function
 * outside the scope is the code under test or a dependency, and its arguments and values are the caller's inputs. A
 * bare number added to data, or given as a fallback, a default or a clamp, is refused there too, but one that scales,
 * shifts, masks or reduces data is a unit conversion or byte arithmetic, and one added to an index compared with a
 * data length, or passed as a length, is index arithmetic. A bare number combined with a Limit's value by any
 * arithmetic but as a radix raised to it derives a bound outside `derived`. 0 is an identity everywhere, 1 and -1 everywhere but in a time a value sets, and 2 in `n < 2` and
 * `n >= 2`; a literal written in hexadecimal, octal or binary is a code unit or a bit pattern where it is compared with
 * anything but a count; a parameter typed by a closed set of number literals takes a vocabulary's member.
 *
 * A mint's arguments are a limit's evidence and its derivation, whose compute must read the limits it derives from; a
 * constant documented with the format tag is a format's defining width; and a builder of a scope's inputs (a test's
 * generator, a bench gate) takes them as the test's inputs. Separately, a module-level number constant whose name says
 * it bounds something is a Limit's value or a documented format constant, unless it is a unit conversion (two time
 * units in its name, holding their exact ratio) or every read of it sizes an input builder.
 */
export const limitEvidence: Visit = (context: RuleContext) => {
	const { sourceFile, checker, semantics, root } = context
	const options = context.options.limitEvidence
	const found = scopeOf(root, options.scopes, sourceFile.fileName)
	if (Option.isNone(found)) {
		return () => []
	}
	const scope = found.value
	const { vocabulary, formatTag, limits, modules, wrappers } = options
	const checks = (position: BoundPosition): boolean => Arr.contains(scope.positions, position)
	const checksAModule = Arr.some(modules, (module) => checks(module.category))
	const firstChecked = (categories: ReadonlyArray<Category>): Option.Option<BoundPosition> =>
		Arr.findFirst(CATEGORIES, (category) => checks(category) && Arr.contains(categories, category))
	const hasFormatTag = (declaration: ts.Node): boolean =>
		Arr.some(
			ts.getJSDocTags(declaration),
			(tag) =>
				tag.tagName.text === formatTag &&
				Str.isNonEmpty(Str.trim(ts.getTextOfJSDocComment(tag.comment) ?? ""))
		)
	const isFormatProperty = (
		node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment
	): boolean =>
		hasFormatTag(node) || Option.exists(constantOfProperty(node), (holder) => hasFormatTag(holder))
	const isDeclaredIn = (
		symbol: NativeSymbol | undefined,
		accepts: (path: string) => boolean
	): boolean =>
		symbol !== undefined &&
		Arr.some(symbol.declarations, (declaration) => accepts(declaration.path))
	const modulesOf = (symbol: NativeSymbol | undefined): ReadonlyArray<Category> =>
		Arr.filterMap(modules, (module) =>
			isDeclaredIn(symbol, (path) => isPackageModule(path, module))
				? Result.succeed(module.category)
				: Result.failVoid
		)
	const admitted = (type: Type): ReadonlyArray<Category> =>
		Arr.dedupe([
			...modulesOf(type.getAliasSymbol()),
			...Arr.flatMap(type.isUnionType() ? type.getTypes() : [type], (member) =>
				modulesOf(member.getSymbol())
			)
		])
	const isLimitsModule = (path: string): boolean => isRepositoryModule(path, limits.module)
	const targetOf = (node: ts.Node): NativeSymbol | undefined => {
		const symbol = semantics.symbolAt(node)
		return symbol === undefined ? undefined : semantics.aliasTarget(symbol)
	}
	const valueSymbolOf = (identifier: ts.Identifier): NativeSymbol | undefined => {
		const { parent } = identifier
		if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) {
			const value = checker.getShorthandAssignmentValueSymbol(parent)
			return value === undefined ? undefined : semantics.aliasTarget(value)
		}
		return targetOf(identifier)
	}
	/** The declaration a value is held by, in the repository: a library's declares its values without them. */
	const declarationOf = (symbol: NativeSymbol): Option.Option<ts.Node> =>
		(symbol.flags & HOLDS_A_NUMBER) === 0 ||
		Arr.every(symbol.declarations, (declaration) => isLibraryPath(declaration.path))
			? Option.none()
			: Arr.head(semantics.declarationsOf(symbol))
	const isLibraryMember = (
		call: ts.CallExpression,
		owners: ReadonlyArray<string>,
		names: ReadonlyArray<string>
	): boolean =>
		ts.isPropertyAccessExpression(call.expression) &&
		ts.isIdentifier(call.expression.expression) &&
		Arr.contains(owners, call.expression.expression.text) &&
		Arr.contains(names, call.expression.name.text) &&
		isDeclaredIn(targetOf(call.expression), isLibraryPath)
	const isLibraryFunction = (call: ts.CallExpression, names: ReadonlyArray<string>): boolean =>
		ts.isIdentifier(call.expression) &&
		Arr.contains(names, call.expression.text) &&
		isDeclaredIn(targetOf(call.expression), isLibraryPath)
	const isExtremum = (call: ts.CallExpression): boolean => isLibraryMember(call, ["Math"], EXTREMA)
	const propertyNameOf = (name: ts.PropertyName): Option.Option<string> => {
		if (
			ts.isIdentifier(name) ||
			ts.isStringLiteral(name) ||
			ts.isNoSubstitutionTemplateLiteral(name)
		) {
			return Option.some(name.text)
		}
		if (!ts.isComputedPropertyName(name)) {
			return Option.none()
		}
		const written = literalKeyOf(name.expression)
		if (Option.isSome(written)) {
			return written
		}
		const type = semantics.typeAt(name.expression)
		return type !== undefined && type.isStringLiteralType() && typeof type.value === "string"
			? Option.some(type.value)
			: Option.none()
	}

	const visiting = new Set<ts.Node>()
	const propertyOf = (
		literal: ts.ObjectLiteralExpression,
		name: string
	): Option.Option<ts.Expression> =>
		Arr.findLast(literal.properties, (property): Option.Option<ts.Expression> => {
			if (ts.isPropertyAssignment(property)) {
				return Option.contains(propertyNameOf(property.name), name) && !isFormatProperty(property)
					? Option.some(property.initializer)
					: Option.none()
			}
			return ts.isShorthandPropertyAssignment(property) &&
				ts.isIdentifier(property.name) &&
				property.name.text === name &&
				!isFormatProperty(property)
				? Option.some(property.name)
				: Option.none()
		})
	const objectOfDeclaration = (declaration: ts.Node): Option.Option<Holder> => {
		if (visiting.has(declaration)) {
			return Option.none()
		}
		visiting.add(declaration)
		const holder =
			ts.isVariableDeclaration(declaration) &&
			declaration.initializer !== undefined &&
			isConstList(declaration.parent) &&
			!hasFormatTag(declaration)
				? objectOf(declaration.initializer)
				: ts.isParameterDeclaration(declaration) && declaration.initializer !== undefined
					? Option.map(objectOf(declaration.initializer), (object): Holder => ({
							literal: object.literal,
							defaulted: true
						}))
					: Option.none<Holder>()
		visiting.delete(declaration)
		return holder
	}
	const objectOf = (expression: ts.Expression): Option.Option<Holder> => {
		const value = stripped(expression)
		if (ts.isObjectLiteralExpression(value)) {
			return Option.some({ literal: value, defaulted: false })
		}
		if (ts.isCallExpression(value) && isLibraryMember(value, ["Object"], ["freeze"])) {
			return Option.flatMap(Arr.head(value.arguments), objectOf)
		}
		if (ts.isIdentifier(value)) {
			const symbol = valueSymbolOf(value)
			return symbol === undefined
				? Option.none()
				: Option.flatMap(declarationOf(symbol), objectOfDeclaration)
		}
		if (ts.isPropertyAccessExpression(value)) {
			return Option.flatMap(objectOf(value.expression), (outer) =>
				Option.map(
					Option.flatMap(propertyOf(outer.literal, value.name.text), objectOf),
					(inner): Holder => ({
						literal: inner.literal,
						defaulted: outer.defaulted || inner.defaulted
					})
				)
			)
		}
		return Option.none()
	}
	const destructuredValue = (element: ts.BindingElement): Option.Option<ts.Expression> => {
		const pattern = element.parent
		const key = bindingKeyOf(element)
		if (!ts.isObjectBindingPattern(pattern) || Option.isNone(key)) {
			return Option.none()
		}
		const holder = pattern.parent
		const source =
			ts.isVariableDeclaration(holder) &&
			holder.initializer !== undefined &&
			isConstList(holder.parent)
				? Option.some(holder.initializer)
				: ts.isBindingElement(holder)
					? destructuredValue(holder)
					: Option.none<ts.Expression>()
		return Option.flatMap(source, (value) =>
			Option.flatMap(objectOf(value), (object) => propertyOf(object.literal, key.value))
		)
	}

	const settled = new Map<ts.Node, Shape>()
	const settling = new Set<ts.Node>()
	const shapeOf = (expression: ts.Expression): Shape => {
		const known = settled.get(expression)
		if (known !== undefined) {
			return known
		}
		if (settling.has(expression)) {
			return DATA
		}
		settling.add(expression)
		const shape = expressionShape(expression)
		settling.delete(expression)
		settled.set(expression, shape)
		return shape
	}
	const reanchored = (use: ts.Node, name: string, bare: Bare, text: string): Bare => ({
		node: use,
		text: `${name} (${text})`,
		value: bare.value,
		notation: bare.notation
	})
	const held = (use: ts.Node, name: string, inner: Shape, holding: Holding): Shape => {
		if (inner.kind === "data") {
			return {
				kind: "data",
				terms: Arr.map(inner.terms, (term) => ({
					role: term.role,
					bare: reanchored(use, name, term.bare, term.bare.text)
				})),
				limit: inner.limit
			}
		}
		const { bare } = inner
		if (holding === "held") {
			return { kind: "bare", bare: reanchored(use, name, bare, bare.text) }
		}
		const phrase = holding === "default" ? "defaulting to" : "initially"
		return {
			kind: "data",
			terms: [{ role: holding, bare: reanchored(use, name, bare, `${phrase} ${bare.text}`) }],
			limit: false
		}
	}
	const declarationShape = (use: ts.Node, name: string, declaration: ts.Node): Shape => {
		if (ts.isVariableDeclaration(declaration)) {
			const { initializer } = declaration
			if (initializer === undefined || hasFormatTag(declaration)) {
				return DATA
			}
			const holding = isConstList(declaration.parent) ? "held" : "initial"
			return held(use, name, shapeOf(initializer), holding)
		}
		if (ts.isParameterDeclaration(declaration)) {
			const { initializer } = declaration
			return initializer === undefined ? DATA : held(use, name, shapeOf(initializer), "default")
		}
		if (ts.isBindingElement(declaration)) {
			const { initializer } = declaration
			if (initializer !== undefined) {
				return held(use, name, shapeOf(initializer), "default")
			}
			return Option.match(destructuredValue(declaration), {
				onNone: () => DATA,
				onSome: (value) => held(use, name, shapeOf(value), "held")
			})
		}
		if (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)) {
			const value = propertyValue(declaration)
			return Option.isNone(value) ||
				Option.isNone(constantOfProperty(declaration)) ||
				isFormatProperty(declaration)
				? DATA
				: held(use, name, shapeOf(value.value), "held")
		}
		if (ts.isEnumMember(declaration) || ts.isPropertyDeclaration(declaration)) {
			const { initializer } = declaration
			if (initializer === undefined || hasFormatTag(declaration)) {
				return DATA
			}
			const holding =
				ts.isPropertyDeclaration(declaration) && !isReadonly(declaration) ? "initial" : "held"
			return held(use, name, shapeOf(initializer), holding)
		}
		if (ts.isExportAssignment(declaration)) {
			return hasFormatTag(declaration)
				? DATA
				: held(use, name, shapeOf(declaration.expression), "held")
		}
		return DATA
	}
	const symbolShape = (use: ts.Node, name: string, symbol: NativeSymbol | undefined): Shape => {
		if (symbol === undefined) {
			return DATA
		}
		return Option.match(declarationOf(symbol), {
			onNone: () => DATA,
			onSome: (declaration) => declarationShape(use, name, declaration)
		})
	}
	const memberShape = (
		access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
		name: string
	): Shape => {
		const text = textOf(access)
		const fromObject = Option.flatMap(objectOf(access.expression), (holder) =>
			Option.map(propertyOf(holder.literal, name), (value) =>
				held(access, text, shapeOf(value), holder.defaulted ? "default" : "held")
			)
		)
		return Option.getOrElse(fromObject, () =>
			symbolShape(
				access,
				text,
				targetOf(ts.isPropertyAccessExpression(access) ? access : access.argumentExpression)
			)
		)
	}
	const isLimitRead = (access: ts.PropertyAccessExpression): boolean => {
		if (access.name.text !== "value") {
			return false
		}
		const receiver = semantics.typeAt(access.expression)
		return receiver !== undefined && isDeclaredIn(receiver.getAliasSymbol(), isLimitsModule)
	}
	const isLimitValue = (initializer: ts.Expression): boolean => {
		const value = stripped(initializer)
		return ts.isPropertyAccessExpression(value) && isLimitRead(value)
	}
	const termsOf = (shape: Shape, role: Role): ReadonlyArray<Term> =>
		shape.kind === "bare" ? [{ bare: shape.bare, role }] : shape.terms
	const readsLimit = (shape: Shape): boolean => shape.kind === "data" && shape.limit
	const alternativesOf = (branches: ReadonlyArray<ts.Expression>, role: Role): Shape => {
		const shapes = Arr.map(branches, shapeOf)
		return {
			kind: "data",
			terms: Arr.flatMap(shapes, (shape) => termsOf(shape, role)),
			limit: false
		}
	}
	const binaryShape = (node: ts.BinaryExpression): Shape => {
		const kind = node.operatorToken.kind
		if (kind === ts.SyntaxKind.CommaToken) {
			return shapeOf(node.right)
		}
		if (Arr.contains(ALTERNATIVES, kind)) {
			return alternativesOf([node.left, node.right], "fallback")
		}
		const operate = ARITHMETIC.get(kind)
		if (operate === undefined) {
			return DATA
		}
		const left = shapeOf(node.left)
		const right = shapeOf(node.right)
		if (left.kind === "bare" && right.kind === "bare") {
			return {
				kind: "bare",
				bare: {
					node,
					text: textOf(node),
					value: Option.zipWith(left.bare.value, right.bare.value, operate),
					notation:
						left.bare.notation === "spelled" && right.bare.notation === "spelled"
							? "spelled"
							: "decimal"
				}
			}
		}
		if (kind === ts.SyntaxKind.AsteriskAsteriskToken && readsLimit(right)) {
			return { kind: "data", terms: left.kind === "data" ? left.terms : [], limit: false }
		}
		if (readsLimit(left) || readsLimit(right)) {
			return {
				kind: "data",
				terms: [...termsOf(left, "derivation"), ...termsOf(right, "derivation")],
				limit: false
			}
		}
		if (Arr.contains(ADDITIVE, kind)) {
			return {
				kind: "data",
				terms: [...termsOf(left, "offset"), ...termsOf(right, "offset")],
				limit: false
			}
		}
		return {
			kind: "data",
			terms: [
				...(left.kind === "data" ? left.terms : []),
				...(right.kind === "data" ? right.terms : [])
			],
			limit: false
		}
	}
	const unaryShape = (node: ts.PrefixUnaryExpression): Shape => {
		if (Arr.contains(STEPS, node.operator)) {
			return shapeOf(node.operand)
		}
		const operate = UNARY.get(node.operator)
		if (operate === undefined) {
			return DATA
		}
		const inner = shapeOf(node.operand)
		if (inner.kind === "data") {
			return inner
		}
		return {
			kind: "bare",
			bare: {
				node,
				text: textOf(node),
				value: Option.map(inner.bare.value, operate),
				notation: inner.bare.notation
			}
		}
	}
	const callShape = (call: ts.CallExpression): Shape => {
		if (isExtremum(call)) {
			return alternativesOf(call.arguments, "clamp")
		}
		if (isLibraryFunction(call, CONVERSIONS)) {
			return Option.match(Arr.head(call.arguments), { onNone: () => DATA, onSome: shapeOf })
		}
		return Option.match(returnerOf(call), {
			onNone: () => DATA,
			onSome: (callee) => returnedShape(call, callee)
		})
	}
	/** What a function of the scope returns, its parameters read as data: its one returned value, or each of several
	 * as an alternative to the others. */
	const returnsShape = (callee: Callee): Shape => {
		const returned = returnedOf(callee)
		return Arr.isReadonlyArrayNonEmpty(returned) && returned.length === 1
			? shapeOf(Arr.headNonEmpty(returned))
			: alternativesOf(returned, "fallback")
	}
	/**
	 * The value of a call of a function of the scope: what its body returns, anchored at the call, and every bare number
	 * an argument, or a property of one, carries into it. A bare value reads no parameter, so no argument enters it.
	 */
	const returnedShape = (call: ts.CallExpression, callee: Callee): Shape => {
		const own = held(call, `${textOf(call.expression)}()`, returnsShape(callee), "held")
		if (own.kind === "bare") {
			return own
		}
		const carried = Arr.flatMap(returnSlotsOf(callee), (slot): ReadonlyArray<Term> =>
			Option.match(Arr.get(call.arguments, slot.index), {
				onNone: () => [],
				onSome: (argument) =>
					ts.isSpreadElement(argument) ? [] : termsOf(shapeAtPath(argument, slot.path), "argument")
			})
		)
		return { kind: "data", terms: [...own.terms, ...carried], limit: own.limit }
	}
	const expressionShape = (expression: ts.Expression): Shape => {
		const value = stripped(expression)
		if (ts.isNumericLiteral(value) || ts.isBigIntLiteral(value)) {
			return {
				kind: "bare",
				bare: {
					node: value,
					text: textOf(value),
					value: literalValueOf(value),
					notation: (value.tokenFlags & ts.TokenFlags.WithSpecifier) === 0 ? "decimal" : "spelled"
				}
			}
		}
		if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
			return Option.match(durationValueOf(value.text), {
				onNone: () => DATA,
				onSome: (amount): Shape => ({
					kind: "bare",
					bare: {
						node: value,
						text: textOf(value),
						value: Option.some(amount),
						notation: "duration"
					}
				})
			})
		}
		if (ts.isPrefixUnaryExpression(value)) {
			return unaryShape(value)
		}
		if (ts.isPostfixUnaryExpression(value)) {
			return shapeOf(value.operand)
		}
		if (ts.isIdentifier(value)) {
			return symbolShape(value, value.text, valueSymbolOf(value))
		}
		if (ts.isPropertyAccessExpression(value)) {
			return isLimitRead(value)
				? { kind: "data", terms: [], limit: true }
				: memberShape(value, value.name.text)
		}
		if (ts.isElementAccessExpression(value)) {
			return Option.match(literalKeyOf(value.argumentExpression), {
				onNone: () => DATA,
				onSome: (name) => memberShape(value, name)
			})
		}
		if (ts.isBinaryExpression(value)) {
			return binaryShape(value)
		}
		if (ts.isConditionalExpression(value)) {
			return alternativesOf([value.whenTrue, value.whenFalse], "fallback")
		}
		return ts.isCallExpression(value) ? callShape(value) : DATA
	}

	const isIdentity = (bare: Bare, placement: Placement): boolean =>
		(placement.kind === "operand" && bare.notation === "spelled" && !placement.against.count) ||
		Option.exists(bare.value, (value) => Arr.contains(identitiesAt(placement), value))
	const suggestionOf = (bare: Bare, placement: Placement): string => {
		const hexadecimal =
			placement.kind === "operand" && bare.notation === "decimal" && !placement.against.count
				? " A code unit or a bit pattern is written in hexadecimal."
				: ""
		return `Read the .value of a Limit minted by ${Arr.join(limits.mints, ", ")} (${limits.module}), or take the number from the caller; a format's defining width is a named constant documented with @${formatTag}.${hexadecimal}`
	}
	const reportOf = (bare: Bare, role: Role | "bound", placement: Placement): Report => {
		const where = PHRASES[placement.position]
		const what = {
			bound: `${bare.text} bounds ${where} as a bare number`,
			offset: `${bare.text} offsets ${where} by a bare number`,
			fallback: `${bare.text} is a fallback in ${where}, a bare number`,
			default: `${bare.text} is a parameter's default in ${where}, a bare number`,
			initial: `${bare.text} is a variable's initial value in ${where}, a bare number`,
			clamp: `${bare.text} clamps ${where} as a bare number`,
			derivation: `${bare.text} derives ${where} from a Limit's value outside derived`,
			argument: `${bare.text} reaches ${where} through the value a function returns, a bare number`
		}[role]
		return {
			node: bare.node,
			message: `${what}: a bound is a Limit or a caller's input.`,
			suggestion: suggestionOf(bare, placement)
		}
	}
	/** Whether a term is index arithmetic: an offset of an index compared with a data length, or passed as a length. */
	const isIndexArithmetic = (role: Role, placement: Placement): boolean =>
		role === "offset" &&
		(placement.kind === "operand" ? placement.against.length : placement.position === "length")
	/** Whether a term is a counter's start: a variable's initial value, which bounds nothing but a countdown, whose
	 * variable is compared with a bare number. */
	const isCounterStart = (role: Role, placement: Placement): boolean =>
		role === "initial" && (placement.kind === "value" || !placement.against.bare)
	const reportsOf = (shape: Shape, placement: Placement): ReadonlyArray<Report> => {
		if (shape.kind === "bare") {
			return isIdentity(shape.bare, placement) ? [] : [reportOf(shape.bare, "bound", placement)]
		}
		const termPlacement: Placement =
			placement.kind === "operand"
				? { ...placement, integerIdentity: false, against: { ...placement.against, count: false } }
				: placement
		return Arr.filterMap(shape.terms, (term) =>
			isIdentity(term.bare, termPlacement) ||
			isIndexArithmetic(term.role, placement) ||
			isCounterStart(term.role, placement)
				? Result.failVoid
				: Result.succeed(reportOf(term.bare, term.role, placement))
		)
	}
	const hasCandidate = (shape: Shape): boolean =>
		Arr.some(
			shape.kind === "bare" ? [shape.bare] : Arr.map(shape.terms, (term) => term.bare),
			(bare) => !Option.contains(bare.value, 0)
		)
	const reporting = (expression: ts.Expression): boolean => hasCandidate(shapeOf(expression))
	/** Whether a value is a duration written as text, `"5 seconds"`, which is a time wherever it is set. */
	const isDurationText = (expression: ts.Expression): boolean => {
		const shape = shapeOf(expression)
		return shape.kind === "bare" && shape.bare.notation === "duration"
	}

	const constantInitializerOf = (identifier: ts.Identifier): Option.Option<ts.Expression> => {
		const symbol = valueSymbolOf(identifier)
		return Option.flatMap(
			symbol === undefined ? Option.none() : declarationOf(symbol),
			(declaration) =>
				ts.isVariableDeclaration(declaration) &&
				declaration.initializer !== undefined &&
				isConstList(declaration.parent)
					? Option.some(declaration.initializer)
					: Option.none()
		)
	}
	const readsLength = (node: ts.Node, follow: boolean): boolean => {
		if (ts.isPropertyAccessExpression(node) && Arr.contains(LENGTH_READS, node.name.text)) {
			return true
		}
		if (ts.isIdentifier(node)) {
			return (
				follow &&
				Option.exists(constantInitializerOf(node), (initializer) => readsLength(initializer, false))
			)
		}
		if (ts.isFunctionLikeDeclaration(node)) {
			return false
		}
		return node.forEachChild((child) => (readsLength(child, follow) ? true : undefined)) === true
	}
	/** Whether an expression's value is a data length: one read, or arithmetic on one. */
	const isLength = (expression: ts.Expression, follow: boolean): boolean => {
		const value = stripped(expression)
		if (ts.isPropertyAccessExpression(value)) {
			return Arr.contains(LENGTH_READS, value.name.text)
		}
		if (ts.isIdentifier(value)) {
			return (
				follow &&
				Option.exists(constantInitializerOf(value), (initializer) => isLength(initializer, false))
			)
		}
		if (ts.isBinaryExpression(value) && ARITHMETIC.has(value.operatorToken.kind)) {
			return isLength(value.left, follow) || isLength(value.right, follow)
		}
		return (
			ts.isCallExpression(value) &&
			isExtremum(value) &&
			Arr.some(value.arguments, (argument) => isLength(argument, follow))
		)
	}
	const categoriesOfName = (name: string, library: boolean): ReadonlyArray<Category> =>
		Arr.filter(
			CATEGORIES,
			(category) =>
				(library && Arr.contains(vocabulary[category].parameters, name)) ||
				hasWordIn(name, vocabulary[category].words)
		)
	/** The categories an operand's value is in: by its name's words (through one constant), a clock's reading is a
	 * time, and arithmetic is in its operands' categories. */
	const categoriesOfOperand = (
		expression: ts.Expression,
		follow: boolean
	): ReadonlyArray<Category> => {
		const value = stripped(expression)
		if (ts.isIdentifier(value)) {
			const named = categoriesOfName(value.text, false)
			return Arr.isReadonlyArrayNonEmpty(named) || !follow
				? named
				: Option.match(constantInitializerOf(value), {
						onNone: () => [],
						onSome: (initializer) => categoriesOfOperand(initializer, false)
					})
		}
		if (ts.isPropertyAccessExpression(value)) {
			return categoriesOfName(value.name.text, false)
		}
		if (ts.isCallExpression(value)) {
			return isLibraryMember(value, CLOCKS, ["now"]) ? ["time"] : []
		}
		if (ts.isBinaryExpression(value) && ARITHMETIC.has(value.operatorToken.kind)) {
			return Arr.union(
				categoriesOfOperand(value.left, follow),
				categoriesOfOperand(value.right, follow)
			)
		}
		return ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)
			? categoriesOfOperand(value.operand, follow)
			: []
	}
	const againstOf = (others: ReadonlyArray<ts.Expression>): Against => ({
		length: Arr.some(others, (other) => readsLength(other, true)),
		count: Arr.some(
			others,
			(other) =>
				isLength(other, true) || Arr.isReadonlyArrayNonEmpty(categoriesOfOperand(other, true))
		),
		bare: Arr.some(others, (other) => shapeOf(other).kind === "bare")
	})

	const comparisonBounds = (
		node: ts.BinaryExpression,
		relevant: (expression: ts.Expression) => boolean
	): ReadonlyArray<Bound> => {
		const compared: BoundPosition = isLoopCondition(node) ? "loop" : "comparison"
		const kind = node.operatorToken.kind
		const rightIdentity =
			kind === ts.SyntaxKind.LessThanToken || kind === ts.SyntaxKind.GreaterThanEqualsToken
		const operand = (
			value: ts.Expression,
			other: ts.Expression,
			integerIdentity: boolean
		): ReadonlyArray<Bound> => {
			if (!relevant(value)) {
				return []
			}
			const named = Arr.union(categoriesOfOperand(other, true), categoriesOfOperand(value, true))
			const position = Option.orElse(firstChecked(named), () =>
				checks(compared) ? Option.some(compared) : Option.none()
			)
			return Option.match(position, {
				onNone: (): ReadonlyArray<Bound> => [],
				onSome: (at): ReadonlyArray<Bound> => [
					{
						value,
						placement: {
							kind: "operand",
							position: at,
							integerIdentity,
							against: againstOf([other])
						},
						call: Option.none()
					}
				]
			})
		}
		return [
			...operand(node.left, node.right, !rightIdentity),
			...operand(node.right, node.left, rightIdentity)
		]
	}
	const extremumBounds = (
		call: ts.CallExpression,
		relevant: (expression: ts.Expression) => boolean
	): ReadonlyArray<Bound> => {
		if (!checks("extremum")) {
			return []
		}
		return Arr.flatMap(call.arguments, (argument, index): ReadonlyArray<Bound> =>
			ts.isSpreadElement(argument) || !relevant(argument)
				? []
				: [
						{
							value: argument,
							placement: {
								kind: "operand",
								position: "extremum",
								integerIdentity: false,
								against: againstOf(Arr.filter(call.arguments, (_, at) => at !== index))
							},
							call: Option.none()
						}
					]
		)
	}
	/**
	 * Where an argument sits by its parameter. A library's parameter is in the categories its name says, or its
	 * category module's. A function of this scope says what its parameter is in its body, which its reaches read, so
	 * only a category module's type the parameter accepts puts it in one here. A function of the repository outside the
	 * scope is the code under test or a dependency, whose parameters are the caller's inputs to it.
	 */
	const positionOfParameter = (
		parameter: NativeSymbol,
		callee: NativeSymbol | undefined
	): Option.Option<BoundPosition> => {
		if (isDeclaredIn(callee, isLibraryPath)) {
			return firstChecked(Arr.union(categoriesOfName(parameter.name, true), modulesOf(callee)))
		}
		const local = isDeclaredIn(callee, (path) =>
			Option.contains(scopeOf(root, options.scopes, path), scope)
		)
		return local && checksAModule
			? firstChecked(admitted(checker.getTypeOfSymbol(parameter)))
			: Option.none()
	}
	const argumentBounds = (
		call: Invocation,
		relevant: (expression: ts.Expression) => boolean
	): ReadonlyArray<Bound> => {
		const candidates = Arr.filterMap(call.arguments ?? [], (argument, index) =>
			!ts.isSpreadElement(argument) && relevant(argument)
				? Result.succeed({ argument, index })
				: Result.failVoid
		)
		if (!Arr.isReadonlyArrayNonEmpty(candidates)) {
			return []
		}
		const callee = targetOf(call.expression)
		const signature = checker.getResolvedSignature(call)
		const parameters = signature.getParameters()
		const rest = signature.hasRestParameter ? Arr.last(parameters) : Option.none<NativeSymbol>()
		return Arr.flatMap(candidates, ({ argument, index }): ReadonlyArray<Bound> => {
			const parameter = index < parameters.length ? Arr.get(parameters, index) : rest
			return Option.match(
				Option.flatMap(parameter, (p) => positionOfParameter(p, callee)),
				{
					onNone: (): ReadonlyArray<Bound> => [],
					onSome: (position): ReadonlyArray<Bound> => [
						{ value: argument, placement: { kind: "value", position }, call: Option.some(call) }
					]
				}
			)
		})
	}
	const enclosingCall = (node: ts.Node): Option.Option<Invocation> => {
		const { parent } = node
		if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== node) {
			return Option.some(parent)
		}
		return ts.isObjectLiteralExpression(parent) ||
			ts.isPropertyAssignment(parent) ||
			ts.isShorthandPropertyAssignment(parent) ||
			ts.isArrayLiteralExpression(parent) ||
			ts.isParenthesizedExpression(parent)
			? enclosingCall(parent)
			: Option.none()
	}
	const membersOf = (type: Type): ReadonlyArray<Type> =>
		type.isUnionType() ? type.getTypes() : [type]
	/** The types an object literal's properties are declared by: its contextual type's, and where it is a call's
	 * argument, the constraint of the type parameter a generic signature declares there, which a library's options
	 * often are (`Effect.retry`'s `O extends Options`), whose instantiation is the literal's own type. */
	const ownersOf = (literal: ts.ObjectLiteralExpression): ReadonlyArray<Type> => {
		const contextual = checker.getContextualType(literal)
		const owned = contextual === undefined ? [] : membersOf(contextual)
		const { parent } = literal
		if (
			(!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) ||
			parent.expression === literal
		) {
			return owned
		}
		return Option.match(
			Arr.findFirstIndex(parent.arguments ?? [], (argument) => argument === literal),
			{
				onNone: () => owned,
				onSome: (index) => {
					const signature = checker.getResolvedSignature(parent)
					const declared = checker.getParameterType(signature.getTarget() ?? signature, index)
					const constraint = declared.isTypeParameter()
						? checker.getConstraintOfTypeParameter(declared)
						: undefined
					return constraint === undefined ? owned : [...owned, ...membersOf(constraint)]
				}
			}
		)
	}
	/** The categories a library's property is in by its name (`library` is its name's categories as a library's), and
	 * any property by the category module's type it accepts, read off the object literal's contextual type. */
	const contextualCategories = (
		node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
		name: string
	): ReadonlyArray<Category> => {
		const exact = categoriesOfName(name, true)
		if (!Arr.isReadonlyArrayNonEmpty(exact) || !ts.isObjectLiteralExpression(node.parent)) {
			return []
		}
		const properties = Arr.filterMap(
			ownersOf(node.parent),
			(member): Result.Result<NativeSymbol, void> => {
				const property = member.getProperty(name)
				return property === undefined ? Result.failVoid : Result.succeed(property)
			}
		)
		return Arr.some(properties, (property) => isDeclaredIn(property, isLibraryPath)) ? exact : []
	}
	const propertyBounds = (
		node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
		relevant: (expression: ts.Expression) => boolean
	): ReadonlyArray<Bound> => {
		const given = propertyValue(node)
		if (Option.isNone(given) || !relevant(given.value) || isFormatProperty(node)) {
			return []
		}
		const value = given.value
		const position = Option.orElse(
			Option.flatMap(propertyNameOf(node.name), (name) =>
				Option.orElse(
					scope.words === "every property"
						? firstChecked(categoriesOfName(name, false))
						: Option.none<BoundPosition>(),
					() => firstChecked(contextualCategories(node, name))
				)
			),
			() => (isDurationText(value) ? firstChecked(["time"]) : Option.none())
		)
		return Option.match(position, {
			onNone: (): ReadonlyArray<Bound> => [],
			onSome: (at): ReadonlyArray<Bound> => [
				{ value, placement: { kind: "value", position: at }, call: enclosingCall(node) }
			]
		})
	}
	const assignedNameOf = (target: ts.Expression): Option.Option<string> => {
		if (ts.isPropertyAccessExpression(target)) {
			return Option.some(target.name.text)
		}
		return ts.isElementAccessExpression(target)
			? literalKeyOf(target.argumentExpression)
			: Option.none()
	}
	const assignmentBounds = (
		node: ts.BinaryExpression,
		relevant: (expression: ts.Expression) => boolean
	): ReadonlyArray<Bound> => {
		if (!relevant(node.right)) {
			return []
		}
		if (scope.words !== "every property") {
			return []
		}
		return Option.match(
			Option.flatMap(assignedNameOf(node.left), (name) =>
				firstChecked(categoriesOfName(name, false))
			),
			{
				onNone: (): ReadonlyArray<Bound> => [],
				onSome: (position): ReadonlyArray<Bound> => [
					{ value: node.right, placement: { kind: "value", position }, call: Option.none() }
				]
			}
		)
	}
	const boundsAt = (
		node: ts.Node,
		relevant: (expression: ts.Expression) => boolean
	): ReadonlyArray<Bound> => {
		if (ts.isCallExpression(node) && isExtremum(node)) {
			return extremumBounds(node, relevant)
		}
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			return argumentBounds(node, relevant)
		}
		if (ts.isBinaryExpression(node)) {
			const kind = node.operatorToken.kind
			if (Arr.contains(RELATIONAL, kind)) {
				return comparisonBounds(node, relevant)
			}
			return Arr.contains(ASSIGNMENTS, kind) ? assignmentBounds(node, relevant) : []
		}
		return ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)
			? propertyBounds(node, relevant)
			: []
	}

	const isMint = (callee: NativeSymbol | undefined): boolean =>
		callee !== undefined &&
		Arr.contains(limits.mints, callee.name) &&
		isDeclaredIn(callee, isLimitsModule)
	const isMintCall = (call: Invocation): boolean =>
		Option.exists(calledNameOf(call.expression), (name) => Arr.contains(limits.mints, name)) &&
		isMint(targetOf(call.expression))
	const isWrapper = (call: ts.CallExpression): boolean => {
		const named = calledNameOf(call.expression)
		if (
			!Arr.some(wrappers, (wrapper) =>
				Option.exists(named, (name) => Arr.contains(wrapper.names, name))
			)
		) {
			return false
		}
		const callee = targetOf(call.expression)
		return Arr.some(
			wrappers,
			(wrapper) =>
				callee !== undefined &&
				Arr.contains(wrapper.names, callee.name) &&
				isDeclaredIn(callee, (path) => isPackageModule(path, wrapper))
		)
	}
	/** The function a wrapper's call wraps, `Effect.fn(body)` or `Effect.fn(name)(body, …)`: its first function
	 * argument. */
	const wrappedOf = (initializer: ts.Expression): Option.Option<ts.FunctionLikeDeclaration> => {
		const value = stripped(initializer)
		if (!ts.isCallExpression(value)) {
			return Option.none()
		}
		const wrapping =
			isWrapper(value) || (ts.isCallExpression(value.expression) && isWrapper(value.expression))
		return wrapping
			? Arr.findFirst(
					value.arguments,
					(argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
						ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
				)
			: Option.none()
	}
	/** The repository function a call runs, in this scope: its signature's declaration, or the function a wrapper's
	 * call wraps where the callee is a constant holding one. */
	const calleeOf = (call: Invocation): Option.Option<Callee> => {
		const called = targetOf(call.expression)
		if (
			called !== undefined &&
			Arr.every(called.declarations, (declaration) => isLibraryPath(declaration.path))
		) {
			return Option.none()
		}
		const signed = semantics.signatureDeclarationAt(call)
		const declaration = Option.orElse(
			signed !== undefined && ts.isFunctionLikeDeclaration(signed) && signed.body !== undefined
				? Option.some(signed)
				: Option.none<ts.FunctionLikeDeclaration>(),
			() =>
				Option.flatMap(Option.flatMap(Option.fromUndefinedOr(called), declarationOf), (held) =>
					ts.isVariableDeclaration(held) &&
					held.initializer !== undefined &&
					isConstList(held.parent)
						? wrappedOf(held.initializer)
						: Option.none()
				)
		)
		return Option.flatMap(declaration, inScope)
	}
	/** A function as a callee when its body is the scope's own source; a declaration file's, or another scope's, is the
	 * code under test or a dependency. */
	const inScope = (fn: ts.FunctionLikeDeclaration): Option.Option<Callee> => {
		const file = fn.getSourceFile()
		return fn.body === undefined ||
			file.isDeclarationFile ||
			!Option.contains(scopeOf(root, options.scopes, file.fileName), scope)
			? Option.none()
			: Option.some({ declaration: fn, body: fn.body })
	}
	/**
	 * The function of the scope whose returned value is a call's own: the function the call's signature declares, never
	 * a wrapper's (whose call's value is an Effect, not what the wrapped body returns), a generator or an async function
	 * (whose value is no returned expression); none for a call whose type is a closed set of number literals, a
	 * vocabulary's member.
	 */
	const returnerOf = (call: ts.CallExpression): Option.Option<Callee> => {
		const signed = semantics.signatureDeclarationAt(call)
		const type = semantics.typeAt(call)
		if (
			signed === undefined ||
			!ts.isFunctionLikeDeclaration(signed) ||
			signed.asteriskToken !== undefined ||
			Arr.some(
				signed.modifiers ?? [],
				(modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword
			) ||
			(type !== undefined && isClosedNumberType(type))
		) {
			return Option.none()
		}
		return inScope(signed)
	}
	const returning = new Map<ts.Node, ReadonlyArray<ts.Expression>>()
	/** The values a callee's body returns: an arrow function's expression body, or every return statement's value
	 * outside the functions and classes the body declares. */
	const returnedOf = (callee: Callee): ReadonlyArray<ts.Expression> => {
		const known = returning.get(callee.declaration)
		if (known !== undefined) {
			return known
		}
		const { body } = callee
		const returned: Array<ts.Expression> = []
		const visit = (node: ts.Node): void => {
			if (ts.isReturnStatement(node)) {
				if (node.expression !== undefined) {
					returned.push(node.expression)
				}
				return
			}
			if (ts.isFunctionLikeDeclaration(node) || ts.isClassLikeDeclaration(node)) {
				return
			}
			node.forEachChild(visit)
		}
		if (ts.isBlock(body)) {
			body.forEachChild(visit)
		} else if (ts.isExpression(body)) {
			returned.push(body)
		}
		returning.set(callee.declaration, returned)
		return returned
	}
	const returnSlots = new Map<ts.Node, ReadonlyArray<Slot>>()
	const returnSlotting = new Set<ts.Node>()
	/** The parameters of a callee the values its body returns are read off. */
	const returnSlotsOf = (callee: Callee): ReadonlyArray<Slot> => {
		const known = returnSlots.get(callee.declaration)
		if (known !== undefined) {
			return known
		}
		if (returnSlotting.has(callee.declaration)) {
			return []
		}
		returnSlotting.add(callee.declaration)
		const slots = Arr.flatMap(returnedOf(callee), (value) => slotsOf(callee, value))
		returnSlotting.delete(callee.declaration)
		returnSlots.set(callee.declaration, slots)
		return slots
	}
	const indexOfParameter = (callee: Callee, parameter: ts.Node): Option.Option<number> =>
		parameter.parent === callee.declaration
			? Arr.findFirstIndex(callee.declaration.parameters, (candidate) => candidate === parameter)
			: Option.none()
	const closed = new Map<ts.Node, boolean>()
	/** Whether a binding's type is a closed set of number literals (isClosedNumberType). */
	const isClosedNumber = (name: ts.Identifier): boolean => {
		const known = closed.get(name)
		if (known !== undefined) {
			return known
		}
		const type = semantics.typeAt(name)
		const answer = type !== undefined && isClosedNumberType(type)
		closed.set(name, answer)
		return answer
	}
	const tracing = new Set<ts.Node>()
	const bindingSlots = (
		callee: Callee,
		element: ts.BindingElement,
		path: ReadonlyArray<string>
	): ReadonlyArray<Slot> => {
		const pattern = element.parent
		const key = bindingKeyOf(element)
		if (!ts.isObjectBindingPattern(pattern) || Option.isNone(key)) {
			return []
		}
		const full = [key.value, ...path]
		const holder = pattern.parent
		if (
			element.name !== undefined &&
			ts.isIdentifier(element.name) &&
			isClosedNumber(element.name)
		) {
			return []
		}
		if (ts.isParameterDeclaration(holder)) {
			return Option.match(indexOfParameter(callee, holder), {
				onNone: () => [],
				onSome: (index) => [{ index, path: full }]
			})
		}
		if (ts.isBindingElement(holder)) {
			return bindingSlots(callee, holder, full)
		}
		return ts.isVariableDeclaration(holder) &&
			holder.initializer !== undefined &&
			isConstList(holder.parent)
			? Arr.map(slotsOf(callee, holder.initializer), (slot) => ({
					index: slot.index,
					path: [...slot.path, ...full]
				}))
			: []
	}
	const declarationSlots = (callee: Callee, declaration: ts.Node): ReadonlyArray<Slot> => {
		if (ts.isParameterDeclaration(declaration)) {
			return ts.isIdentifier(declaration.name) && !isClosedNumber(declaration.name)
				? Option.match(indexOfParameter(callee, declaration), {
						onNone: () => [],
						onSome: (index) => [{ index, path: [] }]
					})
				: []
		}
		if (ts.isBindingElement(declaration)) {
			return bindingSlots(callee, declaration, [])
		}
		if (
			!ts.isVariableDeclaration(declaration) ||
			declaration.initializer === undefined ||
			!isConstList(declaration.parent) ||
			tracing.has(declaration)
		) {
			return []
		}
		tracing.add(declaration)
		const slots = slotsOf(callee, declaration.initializer)
		tracing.delete(declaration)
		return slots
	}
	const extended = (slots: ReadonlyArray<Slot>, name: string): ReadonlyArray<Slot> =>
		Arr.map(slots, (slot) => ({ index: slot.index, path: [...slot.path, name] }))
	/** The parameters of a callee an expression's value is read off, through constants, destructuring, property reads,
	 * arithmetic, alternatives, Math.min and Math.max, conversions, and the values functions of the scope return. */
	const slotsOf = (callee: Callee, expression: ts.Expression): ReadonlyArray<Slot> => {
		const value = stripped(expression)
		if (ts.isIdentifier(value)) {
			const symbol = valueSymbolOf(value)
			return symbol === undefined
				? []
				: Option.match(declarationOf(symbol), {
						onNone: () => [],
						onSome: (declaration) => declarationSlots(callee, declaration)
					})
		}
		if (ts.isPropertyAccessExpression(value)) {
			return extended(slotsOf(callee, value.expression), value.name.text)
		}
		if (ts.isElementAccessExpression(value)) {
			return Option.match(literalKeyOf(value.argumentExpression), {
				onNone: () => [],
				onSome: (name) => extended(slotsOf(callee, value.expression), name)
			})
		}
		if (ts.isBinaryExpression(value)) {
			const kind = value.operatorToken.kind
			if (kind === ts.SyntaxKind.CommaToken) {
				return slotsOf(callee, value.right)
			}
			return ARITHMETIC.has(kind) || Arr.contains(ALTERNATIVES, kind)
				? [...slotsOf(callee, value.left), ...slotsOf(callee, value.right)]
				: []
		}
		if (ts.isConditionalExpression(value)) {
			return [...slotsOf(callee, value.whenTrue), ...slotsOf(callee, value.whenFalse)]
		}
		if (ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)) {
			return slotsOf(callee, value.operand)
		}
		if (
			ts.isCallExpression(value) &&
			(isExtremum(value) || isLibraryFunction(value, CONVERSIONS))
		) {
			return Arr.flatMap(value.arguments, (argument) => slotsOf(callee, argument))
		}
		return ts.isCallExpression(value) ? carriedSlots(callee, value) : []
	}
	/** The parameters of `outer` the arguments of a call read, where the function the call runs (returnerOf) carries
	 * them into the value it returns. */
	const carriedSlots = (outer: Callee, call: ts.CallExpression): ReadonlyArray<Slot> =>
		Option.match(returnerOf(call), {
			onNone: () => [],
			onSome: (inner) =>
				Arr.flatMap(returnSlotsOf(inner), (slot) =>
					Option.match(Arr.get(call.arguments, slot.index), {
						onNone: () => [],
						onSome: (argument) =>
							ts.isSpreadElement(argument) ? [] : slotsAtPath(outer, argument, slot.path)
					})
				)
		})
	const slotsAtPath = (
		callee: Callee,
		argument: ts.Expression,
		path: ReadonlyArray<string>
	): ReadonlyArray<Slot> => {
		if (!Arr.isReadonlyArrayNonEmpty(path)) {
			return slotsOf(callee, argument)
		}
		const value = stripped(argument)
		if (ts.isObjectLiteralExpression(value)) {
			return Option.match(propertyOf(value, Arr.headNonEmpty(path)), {
				onNone: () => [],
				onSome: (inner) => slotsAtPath(callee, inner, Arr.tailNonEmpty(path))
			})
		}
		return Arr.map(slotsOf(callee, value), (slot) => ({
			index: slot.index,
			path: [...slot.path, ...path]
		}))
	}
	/** Whether a value carries something an analysis follows into a callee: a value the predicate accepts, or an object
	 * literal (written, or held by a constant) one of whose properties carries one. */
	const carries = (
		expression: ts.Expression,
		accepts: (expression: ts.Expression) => boolean
	): boolean =>
		!ts.isSpreadElement(expression) &&
		(accepts(expression) ||
			Option.exists(objectOf(expression), (holder) =>
				Arr.some(holder.literal.properties, (property) =>
					ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
						? Option.exists(propertyValue(property), (value) => carries(value, accepts))
						: false
				)
			))
	const reaches = new Map<ts.Node, ReadonlyArray<Reach>>()
	const summarizing = new Set<ts.Node>()
	/**
	 * The nodes of a callee's body that may put a parameter in a bound position: every call, comparison, assignment and
	 * property around a name the parameters bind, or a constant of the body computed from one, outside a mint's
	 * evidence. A node no such name lies in reads no parameter, so the body's other nodes are never asked.
	 */
	const sitesOf = (callee: Callee): ReadonlyArray<ts.Node> => {
		const names = new Set<string>()
		const bind = (name: ts.BindingName): void => {
			if (ts.isIdentifier(name)) {
				names.add(name.text)
				return
			}
			name.forEachChild((child) => {
				if (ts.isBindingElement(child) && child.name !== undefined) {
					bind(child.name)
				}
			})
		}
		for (const parameter of callee.declaration.parameters) {
			bind(parameter.name)
		}
		const occurrences: Array<ts.Identifier> = []
		let grown = true
		while (grown) {
			grown = false
			occurrences.length = 0
			const visit = (node: ts.Node): void => {
				if (ts.isIdentifier(node) && names.has(node.text)) {
					occurrences.push(node)
				}
				if (
					ts.isVariableDeclaration(node) &&
					ts.isIdentifier(node.name) &&
					!names.has(node.name.text) &&
					node.initializer !== undefined &&
					mentionsName(node.initializer, names)
				) {
					names.add(node.name.text)
					grown = true
				}
				node.forEachChild(visit)
			}
			visit(callee.body)
		}
		const sites = new Set<ts.Node>()
		for (const occurrence of occurrences) {
			const around: Array<ts.Node> = []
			let inMint = false
			let node: ts.Node = occurrence
			for (;;) {
				if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && isMintCall(node)) {
					inMint = true
				}
				if (
					ts.isCallExpression(node) ||
					ts.isNewExpression(node) ||
					ts.isBinaryExpression(node) ||
					ts.isPropertyAssignment(node) ||
					ts.isShorthandPropertyAssignment(node)
				) {
					around.push(node)
				}
				if (node === callee.body) {
					break
				}
				node = node.parent
			}
			if (!inMint) {
				for (const node of around) {
					sites.add(node)
				}
			}
		}
		return Arr.fromIterable(sites)
	}
	/** The bound positions a callee's parameters reach in its body, through the calls it makes. */
	const reachesOf = (callee: Callee): ReadonlyArray<Reach> => {
		const known = reaches.get(callee.declaration)
		if (known !== undefined) {
			return known
		}
		if (summarizing.has(callee.declaration)) {
			return []
		}
		summarizing.add(callee.declaration)
		const mentions = (expression: ts.Expression): boolean =>
			Arr.isReadonlyArrayNonEmpty(slotsOf(callee, expression))
		const found: Array<Reach> = []
		for (const node of sitesOf(callee)) {
			for (const bound of boundsAt(node, mentions)) {
				if (bound.placement.kind === "value" || !bound.placement.against.bare) {
					for (const slot of slotsOf(callee, bound.value)) {
						found.push({ slot, placement: bound.placement })
					}
				}
			}
			if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
				for (const reach of callReaches(callee, node)) {
					found.push(reach)
				}
			}
		}
		summarizing.delete(callee.declaration)
		reaches.set(callee.declaration, found)
		return found
	}
	const callReaches = (outer: Callee, call: Invocation): ReadonlyArray<Reach> => {
		const args = call.arguments ?? []
		const mentions = (expression: ts.Expression): boolean =>
			Arr.isReadonlyArrayNonEmpty(slotsOf(outer, expression))
		if (!Arr.some(args, (argument) => carries(argument, mentions))) {
			return []
		}
		return Option.match(calleeOf(call), {
			onNone: () => [],
			onSome: (inner) =>
				Arr.flatMap(reachesOf(inner), ({ slot, placement }) =>
					Option.match(Arr.get(args, slot.index), {
						onNone: () => [],
						onSome: (argument) =>
							Arr.map(slotsAtPath(outer, argument, slot.path), (reached) => ({
								slot: reached,
								placement
							}))
					})
				)
		})
	}
	const shapeAtPath = (argument: ts.Expression, path: ReadonlyArray<string>): Shape => {
		if (!Arr.isReadonlyArrayNonEmpty(path)) {
			return shapeOf(argument)
		}
		const head = Arr.headNonEmpty(path)
		const rest = Arr.tailNonEmpty(path)
		const value = stripped(argument)
		if (ts.isObjectLiteralExpression(value)) {
			return Option.match(propertyOf(value, head), {
				onNone: () => DATA,
				onSome: (inner) => shapeAtPath(inner, rest)
			})
		}
		return Option.match(
			Option.flatMap(objectOf(value), (holder) =>
				Option.map(propertyOf(holder.literal, head), (inner) => ({ holder, inner }))
			),
			{
				onNone: () => DATA,
				onSome: ({ holder, inner }) =>
					held(
						argument,
						`${textOf(argument)}.${Arr.join(path, ".")}`,
						shapeAtPath(inner, rest),
						holder.defaulted ? "default" : "held"
					)
			}
		)
	}

	const isInputBuilder = (call: Invocation): boolean => {
		if (!Arr.isReadonlyArrayNonEmpty(scope.inputs)) {
			return false
		}
		const returned = checker.getResolvedSignature(call).getReturnType()
		const named = Arr.filter(
			[returned.getAliasSymbol(), returned.getSymbol()],
			Predicate.isNotUndefined
		)
		return Arr.some(scope.inputs, (input) =>
			Arr.some(
				named,
				(symbol) =>
					symbol.name === input.alias &&
					isDeclaredIn(symbol, (path) => isRepositoryModule(path, input.module))
			)
		)
	}
	const unlessInput = (
		reports: ReadonlyArray<Report>,
		call: Option.Option<Invocation>
	): ReadonlyArray<Report> =>
		Arr.isReadonlyArrayNonEmpty(reports) && Option.exists(call, isInputBuilder) ? [] : reports
	const boundReports = (bounds: ReadonlyArray<Bound>): ReadonlyArray<Report> =>
		Arr.flatMap(bounds, (bound) =>
			unlessInput(reportsOf(shapeOf(bound.value), bound.placement), bound.call)
		)
	const calleeReports = (call: Invocation): ReadonlyArray<Report> => {
		const args = call.arguments ?? []
		if (!Arr.some(args, (argument) => carries(argument, reporting))) {
			return []
		}
		return Option.match(calleeOf(call), {
			onNone: () => [],
			onSome: (callee) =>
				unlessInput(
					Arr.flatMap(reachesOf(callee), ({ slot, placement }) =>
						Option.match(Arr.get(args, slot.index), {
							onNone: () => [],
							onSome: (argument) =>
								ts.isSpreadElement(argument)
									? []
									: reportsOf(shapeAtPath(argument, slot.path), placement)
						})
					),
					Option.some(call)
				)
		})
	}
	/** Whether a function reads one of its parameters: a compute that reads none derives nothing from its limits. */
	const readsParameter = (fn: ts.ArrowFunction | ts.FunctionExpression): boolean => {
		const visit = (node: ts.Node): boolean => {
			if (ts.isIdentifier(node)) {
				const symbol = targetOf(node)
				return (
					symbol !== undefined &&
					Arr.some(semantics.declarationsOf(symbol), (declaration) =>
						Arr.some(
							fn.parameters,
							(parameter) => declaration.pos >= parameter.pos && declaration.end <= parameter.end
						)
					)
				)
			}
			return node.forEachChild((child) => (visit(child) ? true : undefined)) === true
		}
		return visit(fn.body)
	}
	const computeReports = (call: Invocation): ReadonlyArray<Report> => {
		const argument = Option.map(Arr.head(call.arguments ?? []), stripped)
		if (Option.isNone(argument) || !ts.isObjectLiteralExpression(argument.value)) {
			return []
		}
		return Arr.filterMap(argument.value.properties, (property): Result.Result<Report, void> => {
			if (!ts.isPropertyAssignment(property)) {
				return Result.failVoid
			}
			const fn = stripped(property.initializer)
			return (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !readsParameter(fn)
				? Result.succeed({
						node: fn,
						message: `${textOf(property.name)} reads none of the limits it derives from: a derived limit's value is computed from them.`,
						suggestion:
							"Compute the value from the limits it derives from; a number with evidence of its own is minted as that evidence's kind."
					})
				: Result.failVoid
		})
	}

	/** Whether every read of a constant in its module is an argument of an input builder (a test's generator), or a
	 * property of one: it sizes the test's input, never a bound of the test's own. */
	const isReadOnlyAsInput = (name: ts.Identifier): boolean => {
		if (!Arr.isReadonlyArrayNonEmpty(scope.inputs)) {
			return false
		}
		const symbol = targetOf(name)
		if (symbol === undefined) {
			return false
		}
		const reads: Array<ts.Identifier> = []
		const visit = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && node !== name && valueSymbolOf(node)?.id === symbol.id) {
				reads.push(node)
			}
			node.forEachChild(visit)
		}
		visit(sourceFile)
		return (
			Arr.isReadonlyArrayNonEmpty(reads) &&
			Arr.every(reads, (read) => Option.exists(enclosingCall(read), isInputBuilder))
		)
	}
	const constantReports = (statement: ts.VariableStatement): ReadonlyArray<Report> => {
		if (
			!Arr.isReadonlyArrayNonEmpty(scope.constants) ||
			isAmbient(statement) ||
			!isConstList(statement.declarationList)
		) {
			return []
		}
		return Arr.filterMap(statement.declarationList.declarations, (declaration) => {
			const { name, initializer } = declaration
			if (!ts.isIdentifier(name) || initializer === undefined) {
				return Result.failVoid
			}
			const word = Arr.findFirst(wordsOf(name.text), (w) => Arr.contains(scope.constants, w))
			if (Option.isNone(word) || hasFormatTag(declaration)) {
				return Result.failVoid
			}
			const type = semantics.typeAt(name)
			if (type === undefined || !isNumberLike(type) || isLimitValue(initializer)) {
				return Result.failVoid
			}
			const shape = shapeOf(initializer)
			if (
				(shape.kind === "data" && shape.limit && !Arr.isReadonlyArrayNonEmpty(shape.terms)) ||
				(shape.kind === "bare" && isUnitConversion(name.text, shape.bare.value)) ||
				(!isExported(statement) && isReadOnlyAsInput(name))
			) {
				return Result.failVoid
			}
			return Result.succeed({
				node: name,
				message: `${name.text} names a bound (${word.value}) and holds a bare number: a bound is a Limit's value or a caller's input.`,
				suggestion: `Mint it with ${Arr.join(limits.mints, ", ")} (${limits.module}) and read its .value, or take it from the caller; a format's defining width is documented with @${formatTag}.`
			})
		})
	}

	const reported = new Set<ts.Node>()
	const fresh = (reports: ReadonlyArray<Report>): ReadonlyArray<Report> => {
		const kept: Array<Report> = []
		for (const report of reports) {
			if (!reported.has(report.node)) {
				reported.add(report.node)
				kept.push(report)
			}
		}
		return kept
	}
	let mint = { from: -1, to: -1 }
	return (node) => {
		if (node.pos >= mint.from && node.end <= mint.to) {
			return []
		}
		if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && isMintCall(node)) {
			mint = { from: node.pos, to: node.end }
			return fresh(computeReports(node))
		}
		if (ts.isVariableStatement(node) && ts.isSourceFile(node.parent)) {
			return fresh(constantReports(node))
		}
		const bounds = boundReports(boundsAt(node, reporting))
		return ts.isCallExpression(node) || ts.isNewExpression(node)
			? fresh([...bounds, ...calleeReports(node)])
			: fresh(bounds)
	}
}
